const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const brl = (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const DIAS = ["2030-01-07", "2030-01-08", "2030-01-09", "2030-01-10", "2030-01-11", "2030-01-12"];
const NOMES = ["Seg 7", "Ter 8", "Qua 9", "Qui 10", "Sex 11", "Sáb 12"];
const CONTAS = [
  ["clinica-vida", "dona@vida.demo", "Clínica Vida · dona"],
  ["clinica-vida", "recepcao@vida.demo", "Clínica Vida · recepção"],
  ["clinica-vida", "marcos@vida.demo", "Clínica Vida · profissional"],
  ["studio-forma", "dono@forma.demo", "Studio Forma · dono"],
];
const INICIO = 8 * 60, ESCALA = 1; // 1px por minuto, das 8h às 18h

let sessao;
const api = async (url, opcoes = {}) => {
  const r = await fetch(url, { ...opcoes, headers: { "content-type": "application/json", authorization: `Bearer ${sessao?.token}`, ...opcoes.headers } });
  const corpo = await r.json();
  if (!r.ok) throw new Error(corpo.erro);
  return corpo;
};

$("#contas").innerHTML = CONTAS.map(([e, m, r], i) => `<button type="button" class="conta" data-i="${i}">${r}<br><small class="nevoa">${m}</small></button>`).join("");
$("#contas").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-i]");
  if (!b) return;
  const [empresa, email] = CONTAS[b.dataset.i];
  try {
    sessao = await api("/api/login", { method: "POST", body: JSON.stringify({ empresa, email, senha: "demo1234" }) });
    abrir();
  } catch (e) { $("#erro").textContent = e.message; }
});
$("#sair").addEventListener("click", () => location.reload());

async function abrir() {
  $("#entrada").hidden = true;
  $("#app").hidden = false;
  $("#empresa").textContent = sessao.empresa;
  $("#papel").textContent = sessao.papel;
  $("#usuario").textContent = sessao.nome;
  const gestor = sessao.papel === "dono";
  $("#kpis").hidden = !gestor;
  $("#caixaAuditoria").hidden = !gestor;
  $("#reservar").hidden = sessao.papel === "profissional";
  const c = await api("/api/catalogo");
  sessao.catalogo = c;
  $("#fProf").innerHTML = c.profissionais.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join("");
  $("#fServ").innerHTML = c.servicos.map((s) => `<option value="${s.id}">${esc(s.nome)} · ${s.minutos} min</option>`).join("");
  $("#fDia").innerHTML = DIAS.map((d, i) => `<option value="${d}">${NOMES[i]}</option>`).join("");
  $("#fCliente").value = "Nova Cliente";
  await atualizar();
}

async function atualizar() {
  const gestor = sessao.papel === "dono";
  const [reservas, fila, m, log] = await Promise.all([api("/api/agenda"), api("/api/fila"), gestor ? api("/api/metricas") : null, gestor ? api("/api/auditoria") : null]);
  if (m) $("#kpis").innerHTML = [
    ["Reservas na semana", m.reservas, "confirmadas"],
    ["Receita prevista", brl(m.receita), "serviços confirmados"],
    ["Ocupação", `${Math.round(m.ocupacao * 100)}%`, "do tempo de expediente"],
    ["Cancelamento", `${Math.round(m.cancelamento * 100)}%`, "das reservas da semana"],
  ].map(([r, v, n]) => `<div class="cartao kpi"><div class="rotulo">${r}</div><div class="valor">${v}</div><div class="nota">${n}</div></div>`).join("");

  const ordem = sessao.catalogo.profissionais.map((p) => p.id);
  const minutos = (t) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));
  let html = `<div></div>${NOMES.map((n) => `<div class="dia">${n}</div>`).join("")}`;
  html += `<div class="horas">${[8, 10, 12, 14, 16, 18].map((h) => `<span style="top:${(h * 60 - INICIO) * ESCALA}px">${h}h</span>`).join("")}</div>`;
  for (const dia of DIAS) {
    const doDia = reservas.filter((r) => r.inicio.startsWith(dia));
    const largura = 100 / Math.max(1, ordem.length);
    html += `<div class="coluna">${doDia.map((r) => {
      const i = ordem.indexOf(r.profissional_id);
      const topo = (minutos(r.inicio) - INICIO) * ESCALA, altura = (minutos(r.fim) - minutos(r.inicio)) * ESCALA - 2;
      return `<div class="bloco p${i}" data-id="${r.id}" title="${esc(r.cliente)} · ${esc(r.servico)} · ${esc(r.profissional)}" style="top:${topo}px;height:${altura}px;left:${i * largura}%;width:calc(${largura}% - 2px)">${esc(r.cliente.split(" ")[0])}<small>${r.inicio.slice(11)}</small></div>`;
    }).join("")}</div>`;
  }
  $("#semana").innerHTML = html;
  $("#fila").innerHTML = fila.length ? fila.map((f) => `<div class="lista-item"><span>${esc(f.cliente)}<br><small class="nevoa">${esc(f.servico)} · ${esc(f.profissional)}</small></span><span class="selo alerta">${f.dia.slice(8)}/01</span></div>`).join("") : `<p class="nevoa">Ninguém aguardando.</p>`;
  if (log) $("#auditoria").innerHTML = log.slice(0, 6).map((a) => `<div class="lista-item"><span>${esc(a.detalhe)}<br><small class="nevoa">${esc(a.ator)}</small></span><span class="selo">${esc(a.acao.replace("_", " "))}</span></div>`).join("");
  await livres();
}

async function livres() {
  if (sessao.papel === "profissional") return;
  const q = new URLSearchParams({ profissional: $("#fProf").value, servico: $("#fServ").value, dia: $("#fDia").value });
  const lista = await api(`/api/livres?${q}`);
  $("#livres").innerHTML = lista.map((h) => `<button class="fantasma" data-h="${h}">${h.slice(11)}</button>`).join("") || `<span class="nevoa">Sem horários livres.</span>`;
}
["#fProf", "#fServ", "#fDia"].forEach((s) => $(s).addEventListener("change", livres));
$("#livres").addEventListener("click", async (ev) => {
  const h = ev.target.dataset.h;
  if (!h) return;
  await api("/api/reservas", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ profissional: Number($("#fProf").value), servico: Number($("#fServ").value), cliente: $("#fCliente").value, inicio: h }) });
  atualizar();
});
$("#semana").addEventListener("click", async (ev) => {
  const b = ev.target.closest(".bloco");
  if (b && sessao.papel !== "profissional") { await api(`/api/reservas/${b.dataset.id}`, { method: "DELETE" }); atualizar(); }
});
