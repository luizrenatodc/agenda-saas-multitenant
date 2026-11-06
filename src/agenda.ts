import type { DatabaseSync } from "node:sqlite";

export class ErroNegocio extends Error {
  status: number;
  constructor(status: number, mensagem: string) {
    super(mensagem);
    this.status = status;
  }
}

const paraMinutos = (hora: string) => Number(hora.slice(0, 2)) * 60 + Number(hora.slice(3, 5));
const paraHora = (minutos: number) => `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;
const diaDaSemana = (dia: string) => new Date(`${dia}T00:00:00Z`).getUTCDay();

type Reserva = { id: number; profissional_id: number; servico_id: number; cliente: string; inicio: string; fim: string; status: string };
type PedidoReserva = { profissional: number; servico: number; cliente: string; inicio: string; chave?: string; origem?: string };

/** Toda consulta recebe o tenant, então um cliente nunca alcança dados de outro. */
export class Agenda {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #servico(tenant: number, id: number) {
    const s = this.#db.prepare("SELECT * FROM servicos WHERE id = ? AND tenant_id = ?").get(id, tenant) as { id: number; minutos: number; preco: number; nome: string } | undefined;
    if (!s) throw new ErroNegocio(404, "Serviço não encontrado");
    return s;
  }

  #profissional(tenant: number, id: number) {
    const p = this.#db.prepare("SELECT * FROM profissionais WHERE id = ? AND tenant_id = ?").get(id, tenant) as { id: number; nome: string } | undefined;
    if (!p) throw new ErroNegocio(404, "Profissional não encontrado");
    return p;
  }

  #dentroDoExpediente(tenant: number, profissional: number, inicio: string, fim: string): boolean {
    const dia = inicio.slice(0, 10);
    return (this.#db.prepare("SELECT inicio, fim FROM expedientes WHERE tenant_id = ? AND profissional_id = ? AND dia_semana = ?").all(tenant, profissional, diaDaSemana(dia)) as { inicio: string; fim: string }[])
      .some((e) => e.inicio <= inicio.slice(11) && fim.slice(11) <= e.fim);
  }

  #ocupado(tenant: number, profissional: number, inicio: string, fim: string): boolean {
    const reserva = this.#db.prepare("SELECT 1 FROM reservas WHERE tenant_id = ? AND profissional_id = ? AND status = 'confirmada' AND inicio < ? AND fim > ? LIMIT 1").get(tenant, profissional, fim, inicio);
    const bloqueio = this.#db.prepare("SELECT 1 FROM bloqueios WHERE tenant_id = ? AND profissional_id = ? AND inicio < ? AND fim > ? LIMIT 1").get(tenant, profissional, fim, inicio);
    return Boolean(reserva || bloqueio);
  }

  horariosLivres(tenant: number, profissional: number, servico: number, dia: string, passo = 30): string[] {
    this.#profissional(tenant, profissional);
    const { minutos } = this.#servico(tenant, servico);
    const turnos = this.#db.prepare("SELECT inicio, fim FROM expedientes WHERE tenant_id = ? AND profissional_id = ? AND dia_semana = ? ORDER BY inicio").all(tenant, profissional, diaDaSemana(dia)) as { inicio: string; fim: string }[];
    const livres: string[] = [];
    for (const turno of turnos) {
      for (let m = paraMinutos(turno.inicio); m + minutos <= paraMinutos(turno.fim); m += passo) {
        const inicio = `${dia}T${paraHora(m)}`;
        if (!this.#ocupado(tenant, profissional, inicio, `${dia}T${paraHora(m + minutos)}`)) livres.push(inicio);
      }
    }
    return livres;
  }

  #transacao<T>(acao: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const resultado = acao();
      this.#db.exec("COMMIT");
      return resultado;
    } catch (erro) {
      this.#db.exec("ROLLBACK");
      throw erro;
    }
  }

  #inserir(tenant: number, p: PedidoReserva, ator: string): Reserva {
    if (p.chave) {
      const repetida = this.#db.prepare("SELECT * FROM reservas WHERE tenant_id = ? AND chave = ?").get(tenant, p.chave) as Reserva | undefined;
      if (repetida) return repetida;
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.inicio)) throw new ErroNegocio(400, "Início inválido");
    if (!p.cliente?.trim()) throw new ErroNegocio(400, "Informe o cliente");
    this.#profissional(tenant, p.profissional);
    const servico = this.#servico(tenant, p.servico);
    const fim = `${p.inicio.slice(0, 11)}${paraHora(paraMinutos(p.inicio.slice(11)) + servico.minutos)}`;
    if (!this.#dentroDoExpediente(tenant, p.profissional, p.inicio, fim)) throw new ErroNegocio(422, "Fora do expediente");
    if (this.#ocupado(tenant, p.profissional, p.inicio, fim)) throw new ErroNegocio(409, "Horário indisponível");
    const { lastInsertRowid } = this.#db
      .prepare("INSERT INTO reservas (tenant_id, profissional_id, servico_id, cliente, inicio, fim, chave, origem) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(tenant, p.profissional, p.servico, p.cliente.trim(), p.inicio, fim, p.chave ?? null, p.origem ?? "balcao");
    this.#auditar(tenant, ator, "reserva_criada", `${p.cliente.trim()} em ${p.inicio}`);
    return this.#db.prepare("SELECT * FROM reservas WHERE id = ?").get(lastInsertRowid) as Reserva;
  }

  /** Verificação e escrita ficam na mesma transação, então duas reservas não ocupam o mesmo horário. */
  reservar(tenant: number, pedido: PedidoReserva, ator: string): Reserva {
    return this.#transacao(() => this.#inserir(tenant, pedido, ator));
  }

  /** Ao cancelar, o primeiro da fila de espera que couber no horário recebe a vaga. */
  cancelar(tenant: number, id: number, ator: string): { cancelada: Reserva; promovida?: Reserva } {
    return this.#transacao(() => {
      const r = this.#db.prepare("SELECT * FROM reservas WHERE id = ? AND tenant_id = ?").get(id, tenant) as Reserva | undefined;
      if (!r) throw new ErroNegocio(404, "Reserva não encontrada");
      if (r.status !== "confirmada") throw new ErroNegocio(409, "Reserva já encerrada");
      this.#db.prepare("UPDATE reservas SET status = 'cancelada' WHERE id = ?").run(id);
      this.#auditar(tenant, ator, "reserva_cancelada", `${r.cliente} em ${r.inicio}`);

      const fila = this.#db.prepare("SELECT * FROM espera WHERE tenant_id = ? AND profissional_id = ? AND dia = ? AND status = 'aguardando' ORDER BY id").all(tenant, r.profissional_id, r.inicio.slice(0, 10)) as { id: number; servico_id: number; cliente: string }[];
      for (const item of fila) {
        try {
          const promovida = this.#inserir(tenant, { profissional: r.profissional_id, servico: item.servico_id, cliente: item.cliente, inicio: r.inicio, origem: "fila" }, "sistema");
          this.#db.prepare("UPDATE espera SET status = 'atendida', reserva_id = ? WHERE id = ?").run(promovida.id, item.id);
          this.#auditar(tenant, "sistema", "fila_promovida", `${item.cliente} em ${r.inicio}`);
          return { cancelada: { ...r, status: "cancelada" }, promovida };
        } catch (erro) {
          if (!(erro instanceof ErroNegocio)) throw erro;
        }
      }
      return { cancelada: { ...r, status: "cancelada" } };
    });
  }

  entrarNaFila(tenant: number, p: { profissional: number; servico: number; cliente: string; dia: string }, ator: string) {
    this.#profissional(tenant, p.profissional);
    this.#servico(tenant, p.servico);
    const { lastInsertRowid } = this.#db.prepare("INSERT INTO espera (tenant_id, profissional_id, servico_id, cliente, dia) VALUES (?, ?, ?, ?, ?)").run(tenant, p.profissional, p.servico, p.cliente, p.dia);
    this.#auditar(tenant, ator, "fila_entrada", `${p.cliente} em ${p.dia}`);
    return { id: Number(lastInsertRowid) };
  }

  listar(tenant: number, de: string, ate: string, profissional?: number) {
    const filtro = profissional ? "AND r.profissional_id = ?" : "";
    const valores = profissional ? [tenant, de, ate, profissional] : [tenant, de, ate];
    return this.#db
      .prepare(`SELECT r.*, s.nome AS servico, p.nome AS profissional FROM reservas r JOIN servicos s ON s.id = r.servico_id JOIN profissionais p ON p.id = r.profissional_id
                WHERE r.tenant_id = ? AND r.inicio >= ? AND r.inicio < ? AND r.status <> 'cancelada' ${filtro} ORDER BY r.inicio`)
      .all(...valores);
  }

  fila(tenant: number) {
    return this.#db.prepare("SELECT e.*, s.nome AS servico, p.nome AS profissional FROM espera e JOIN servicos s ON s.id = e.servico_id JOIN profissionais p ON p.id = e.profissional_id WHERE e.tenant_id = ? AND e.status = 'aguardando' ORDER BY e.id").all(tenant);
  }

  auditoria(tenant: number, limite = 12) {
    return this.#db.prepare("SELECT ator, acao, detalhe FROM auditoria WHERE tenant_id = ? ORDER BY id DESC LIMIT ?").all(tenant, limite);
  }

  catalogo(tenant: number) {
    return {
      profissionais: this.#db.prepare("SELECT id, nome FROM profissionais WHERE tenant_id = ? ORDER BY id").all(tenant),
      servicos: this.#db.prepare("SELECT id, nome, minutos, preco FROM servicos WHERE tenant_id = ? ORDER BY id").all(tenant),
    };
  }

  /** Ocupação compara minutos reservados com minutos de expediente no período. */
  metricas(tenant: number, de: string, ate: string) {
    const reservas = this.#db
      .prepare("SELECT r.status, r.profissional_id, r.inicio, r.fim, s.preco FROM reservas r JOIN servicos s ON s.id = r.servico_id WHERE r.tenant_id = ? AND r.inicio >= ? AND r.inicio < ?")
      .all(tenant, de, ate) as { status: string; profissional_id: number; inicio: string; fim: string; preco: number }[];
    const expedientes = this.#db.prepare("SELECT inicio, fim, dia_semana FROM expedientes WHERE tenant_id = ?").all(tenant) as { inicio: string; fim: string; dia_semana: number }[];
    let disponivel = 0;
    for (let d = new Date(`${de.slice(0, 10)}T00:00:00Z`); d.toISOString().slice(0, 10) < ate.slice(0, 10); d.setUTCDate(d.getUTCDate() + 1)) {
      for (const e of expedientes) if (e.dia_semana === d.getUTCDay()) disponivel += paraMinutos(e.fim) - paraMinutos(e.inicio);
    }
    const confirmadas = reservas.filter((r) => r.status === "confirmada");
    const ocupado = confirmadas.reduce((s, r) => s + paraMinutos(r.fim.slice(11)) - paraMinutos(r.inicio.slice(11)), 0);
    return {
      reservas: confirmadas.length,
      receita: confirmadas.reduce((s, r) => s + r.preco, 0),
      ocupacao: disponivel ? ocupado / disponivel : 0,
      cancelamento: reservas.length ? reservas.filter((r) => r.status === "cancelada").length / reservas.length : 0,
    };
  }

  #auditar(tenant: number, ator: string, acao: string, detalhe: string) {
    this.#db.prepare("INSERT INTO auditoria (tenant_id, ator, acao, detalhe) VALUES (?, ?, ?, ?)").run(tenant, ator, acao, detalhe);
  }
}
