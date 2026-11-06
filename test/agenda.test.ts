import assert from "node:assert/strict";
import { test } from "node:test";
import { Agenda, ErroNegocio } from "../src/agenda.ts";
import { abrirBanco } from "../src/banco.ts";

function preparar() {
  const db = abrirBanco();
  for (const slug of ["a", "b"]) db.prepare("INSERT INTO tenants (slug, nome) VALUES (?, ?)").run(slug, slug);
  db.exec(`
    INSERT INTO profissionais (id, tenant_id, nome) VALUES (1, 1, 'Ana'), (2, 2, 'Bia');
    INSERT INTO servicos (id, tenant_id, nome, minutos, preco) VALUES (1, 1, 'Curto', 30, 100), (2, 1, 'Longo', 60, 200), (3, 2, 'Outro', 30, 50);
    INSERT INTO expedientes (tenant_id, profissional_id, dia_semana, inicio, fim) VALUES (1, 1, 1, '08:00', '10:00'), (1, 1, 1, '13:00', '14:00'), (2, 2, 1, '08:00', '10:00');
  `);
  return { db, a: new Agenda(db) };
}
const SEG = "2030-01-07";
const pedido = (inicio: string, servico = 1, cliente = "Cliente") => ({ profissional: 1, servico, cliente, inicio: `${SEG}T${inicio}` });
const falha = (status: number) => (e: unknown) => e instanceof ErroNegocio && e.status === status;

test("lista horários respeitando turnos e duração", () => {
  const { a } = preparar();
  assert.deepEqual(a.horariosLivres(1, 1, 2, SEG).map((h) => h.slice(11)), ["08:00", "08:30", "09:00", "13:00"]);
});

test("recusa sobreposição e aceita horário encostado", () => {
  const { a } = preparar();
  a.reservar(1, pedido("08:00", 2), "t");
  assert.throws(() => a.reservar(1, pedido("08:30")), falha(409));
  assert.equal(a.reservar(1, pedido("09:00"), "t").fim, `${SEG}T09:30`);
});

test("recusa serviço que passa do fim do turno", () => {
  const { a } = preparar();
  assert.throws(() => a.reservar(1, pedido("09:30", 2)), falha(422));
});

test("bloqueio remove horários", () => {
  const { a, db } = preparar();
  db.exec(`INSERT INTO bloqueios (tenant_id, profissional_id, inicio, fim, motivo) VALUES (1, 1, '${SEG}T08:00', '${SEG}T09:00', 'x')`);
  assert.throws(() => a.reservar(1, pedido("08:30")), falha(409));
});

test("isola empresas mesmo com id válido de outra", () => {
  const { a } = preparar();
  assert.throws(() => a.reservar(2, pedido("08:00"), "t"), falha(404));
  const r = a.reservar(1, pedido("08:00"), "t");
  assert.throws(() => a.cancelar(2, r.id, "t"), falha(404));
  assert.equal(a.listar(2, SEG, "2030-01-08").length, 0);
});

test("mesma chave de idempotência devolve a mesma reserva", () => {
  const { a } = preparar();
  const p = { ...pedido("08:00"), chave: "k1" };
  assert.equal(a.reservar(1, p, "t").id, a.reservar(1, p, "t").id);
});

test("cancelar promove o primeiro da fila que couber", () => {
  const { a } = preparar();
  const r = a.reservar(1, pedido("09:30"), "t");
  a.entrarNaFila(1, { profissional: 1, servico: 2, cliente: "Não cabe", dia: SEG }, "t");
  a.entrarNaFila(1, { profissional: 1, servico: 1, cliente: "Cabe", dia: SEG }, "t");
  const { promovida } = a.cancelar(1, r.id, "t");
  assert.equal(promovida?.cliente, "Cabe");
  assert.equal(a.fila(1).length, 1);
});

test("não cancela duas vezes", () => {
  const { a } = preparar();
  const r = a.reservar(1, pedido("08:00"), "t");
  a.cancelar(1, r.id, "t");
  assert.throws(() => a.cancelar(1, r.id, "t"), falha(409));
});

test("erro desfaz a transação inteira", () => {
  const { a } = preparar();
  a.reservar(1, pedido("08:00"), "t");
  assert.throws(() => a.reservar(1, pedido("08:00"), "t"), falha(409));
  assert.equal(a.reservar(1, pedido("08:30"), "t").status, "confirmada");
});

test("métricas calculam ocupação, receita e cancelamento", () => {
  const { a } = preparar();
  a.reservar(1, pedido("08:00", 2), "t");
  a.cancelar(1, a.reservar(1, pedido("09:00"), "t").id, "t");
  const m = a.metricas(1, `${SEG}T00:00`, "2030-01-08T00:00");
  assert.equal(m.receita, 200);
  assert.equal(m.ocupacao, 60 / 180);
  assert.equal(m.cancelamento, 0.5);
});

test("registra auditoria por empresa", () => {
  const { a } = preparar();
  a.reservar(1, pedido("08:00"), "ana");
  assert.equal(a.auditoria(1).length, 1);
  assert.equal(a.auditoria(2).length, 0);
});
