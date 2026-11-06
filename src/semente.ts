import type { DatabaseSync } from "node:sqlite";
import { Agenda } from "./agenda.ts";
import { hashSenha } from "./seguranca.ts";

export const SEMANA = { de: "2030-01-07T00:00", ate: "2030-01-13T00:00" };
const DIAS = ["2030-01-07", "2030-01-08", "2030-01-09", "2030-01-10", "2030-01-11", "2030-01-12"];
const CLIENTES = ["Marina Lopes", "Paulo Reis", "Júlia Prado", "André Nunes", "Carla Dias", "Rafael Melo", "Bia Torres", "Otávio Luz", "Sônia Paes", "Igor Sá", "Lara Vaz", "Davi Rocha"];

type Tenant = {
  slug: string;
  nome: string;
  profissionais: string[];
  servicos: [string, number, number][];
  equipe: [string, string, string, number?][];
};

const TENANTS: Tenant[] = [
  {
    slug: "clinica-vida",
    nome: "Clínica Vida",
    profissionais: ["Dra. Helena", "Dr. Marcos", "Dra. Sofia"],
    servicos: [["Consulta", 30, 180], ["Retorno", 30, 90], ["Avaliação completa", 60, 320]],
    equipe: [["dona@vida.demo", "Helena Costa", "dono"], ["recepcao@vida.demo", "Tati Lima", "atendente"], ["marcos@vida.demo", "Marcos Braga", "profissional", 1]],
  },
  {
    slug: "studio-forma",
    nome: "Studio Forma",
    profissionais: ["Lia", "Caio"],
    servicos: [["Pilates", 60, 95], ["Avaliação postural", 30, 120]],
    equipe: [["dono@forma.demo", "Lia Moura", "dono"]],
  },
];

export function semear(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM tenants LIMIT 1").get()) return;
  const agenda = new Agenda(db);
  const senha = hashSenha("demo1234");
  let sorteio = 7;
  const proximo = (limite: number) => Math.floor((sorteio = (sorteio * 1103515245 + 12345) % 2147483648) / 65536) % limite;

  for (const t of TENANTS) {
    const tenant = Number(db.prepare("INSERT INTO tenants (slug, nome) VALUES (?, ?)").run(t.slug, t.nome).lastInsertRowid);
    const profissionais = t.profissionais.map((nome) => Number(db.prepare("INSERT INTO profissionais (tenant_id, nome) VALUES (?, ?)").run(tenant, nome).lastInsertRowid));
    const servicos = t.servicos.map(([nome, minutos, preco]) => Number(db.prepare("INSERT INTO servicos (tenant_id, nome, minutos, preco) VALUES (?, ?, ?, ?)").run(tenant, nome, minutos, preco).lastInsertRowid));
    for (const [email, nome, papel, indice] of t.equipe) {
      db.prepare("INSERT INTO usuarios (tenant_id, email, senha, nome, papel, profissional_id) VALUES (?, ?, ?, ?, ?, ?)").run(tenant, email, senha, nome, papel, indice === undefined ? null : profissionais[indice]);
    }
    for (const p of profissionais) {
      for (let dia = 1; dia <= 5; dia++) {
        db.prepare("INSERT INTO expedientes (tenant_id, profissional_id, dia_semana, inicio, fim) VALUES (?, ?, ?, '08:00', '12:00')").run(tenant, p, dia);
        db.prepare("INSERT INTO expedientes (tenant_id, profissional_id, dia_semana, inicio, fim) VALUES (?, ?, ?, '13:30', '18:00')").run(tenant, p, dia);
      }
      db.prepare("INSERT INTO expedientes (tenant_id, profissional_id, dia_semana, inicio, fim) VALUES (?, ?, 6, '08:00', '12:00')").run(tenant, p);
    }
    db.prepare("INSERT INTO bloqueios (tenant_id, profissional_id, inicio, fim, motivo) VALUES (?, ?, '2030-01-09T13:30', '2030-01-09T18:00', 'Congresso')").run(tenant, profissionais[0]);

    for (const dia of DIAS) {
      for (const p of profissionais) {
        for (let i = 0; i < 6; i++) {
          const s = servicos[proximo(servicos.length)];
          const livres = agenda.horariosLivres(tenant, p, s, dia);
          if (!livres.length) continue;
          agenda.reservar(tenant, { profissional: p, servico: s, cliente: CLIENTES[proximo(CLIENTES.length)], inicio: livres[proximo(livres.length)], origem: proximo(3) ? "online" : "balcao" }, "semente");
        }
      }
    }
    const feitas = agenda.listar(tenant, SEMANA.de, SEMANA.ate) as { id: number }[];
    feitas.filter((_, i) => i % 11 === 5).forEach((r) => agenda.cancelar(tenant, r.id, "Recepção"));
    agenda.entrarNaFila(tenant, { profissional: profissionais[0], servico: servicos[0], cliente: "Nina Ferraz", dia: DIAS[1] }, "semente");
    agenda.entrarNaFila(tenant, { profissional: profissionais[1], servico: servicos[0], cliente: "Hugo Pires", dia: DIAS[2] }, "semente");
  }
}
