import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { criarApp } from "../src/app.ts";
import { abrirBanco } from "../src/banco.ts";
import { semear } from "../src/semente.ts";
import { conferirSenha, criarToken, hashSenha, Limitador, lerToken } from "../src/seguranca.ts";

let servidor: Server;
let base: string;

before(async () => {
  const db = abrirBanco();
  semear(db);
  servidor = criarApp(db, "segredo", 6);
  await new Promise<void>((ok) => servidor.listen(0, ok));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
after(() => servidor.close());

const chamar = (rota: string, token?: string, opcoes: RequestInit = {}) => fetch(base + rota, { ...opcoes, headers: { authorization: `Bearer ${token}`, ...opcoes.headers } });
const entrar = async (empresa: string, email: string, senha = "demo1234") => (await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ empresa, email, senha }) }));
const token = async (empresa: string, email: string) => ((await (await entrar(empresa, email)).json()) as { token: string }).token;

test("exige sessão válida", async () => {
  assert.equal((await chamar("/api/agenda")).status, 401);
  assert.equal((await chamar("/api/agenda", "abc.def.ghi")).status, 401);
});

test("senha errada não entra e login é freado", async () => {
  const respostas = [];
  for (let i = 0; i < 7; i++) respostas.push((await entrar("clinica-vida", "alvo@vida.demo", "x")).status);
  assert.equal(respostas[0], 401);
  assert.equal(respostas[6], 429);
});

test("papéis limitam o que cada usuário faz", async () => {
  const recepcao = await token("clinica-vida", "recepcao@vida.demo");
  const profissional = await token("clinica-vida", "marcos@vida.demo");
  assert.equal((await chamar("/api/metricas", recepcao)).status, 403);
  assert.equal((await chamar("/api/reservas", profissional, { method: "POST", body: "{}" })).status, 403);
});

test("profissional só vê a própria agenda", async () => {
  const lista = (await (await chamar("/api/agenda", await token("clinica-vida", "marcos@vida.demo"))).json()) as { profissional: string }[];
  assert.ok(lista.length > 0);
  assert.ok(lista.every((r) => r.profissional === "Dr. Marcos"));
});

test("uma empresa não lê a agenda da outra", async () => {
  const lista = (await (await chamar("/api/agenda", await token("studio-forma", "dono@forma.demo"))).json()) as { profissional: string }[];
  assert.ok(lista.every((r) => ["Lia", "Caio"].includes(r.profissional)));
});

test("vinte reservas simultâneas no mesmo horário geram uma só", async () => {
  const t = await token("clinica-vida", "dona@vida.demo");
  const q = "profissional=1&servico=1&dia=2030-01-11";
  const [inicio] = (await (await chamar(`/api/livres?${q}`, t)).json()) as string[];
  const corpo = JSON.stringify({ profissional: 1, servico: 1, cliente: "Corrida", inicio });
  const status = await Promise.all(Array.from({ length: 20 }, () => chamar("/api/reservas", t, { method: "POST", body: corpo }).then((r) => r.status)));
  assert.equal(status.filter((s) => s === 201).length, 1);
  assert.equal(status.filter((s) => s === 409).length, 19);
});

test("JSON inválido devolve 400", async () => {
  const t = await token("clinica-vida", "dona@vida.demo");
  assert.equal((await chamar("/api/reservas", t, { method: "POST", body: "{" })).status, 400);
});

test("token expira e não aceita adulteração", () => {
  const t = criarToken({ a: 1 }, "s", 60, 1_000_000);
  assert.equal(lerToken<{ a: number }>(t, "s", 1_000_000)?.a, 1);
  assert.equal(lerToken(t, "s", 1_000_000 + 61_000), undefined);
  assert.equal(lerToken(t, "outro", 1_000_000), undefined);
});

test("hash de senha confere só a senha certa", () => {
  const h = hashSenha("abc");
  assert.ok(conferirSenha("abc", h));
  assert.ok(!conferirSenha("abd", h));
});

test("limitador libera depois da janela", () => {
  const l = new Limitador(1, 1000);
  assert.ok(l.permitir("x", 0));
  assert.ok(!l.permitir("x", 500));
  assert.ok(l.permitir("x", 1500));
});
