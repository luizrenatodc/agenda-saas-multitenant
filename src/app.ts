import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { extname, join, normalize } from "node:path";
import { Agenda, ErroNegocio } from "./agenda.ts";
import { SEMANA } from "./semente.ts";
import { conferirSenha, criarToken, Limitador, lerToken, pode, type Papel, type Permissao } from "./seguranca.ts";

const PUBLICO = join(import.meta.dirname, "..", "public");
const TIPOS: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

type Sessao = { usuario: number; tenant: number; papel: Papel; nome: string; profissional: number | null };
type Usuario = { id: number; tenant_id: number; senha: string; nome: string; papel: Papel; profissional_id: number | null };

export function criarApp(db: DatabaseSync, segredo: string, maxLogins = 8): Server {
  const agenda = new Agenda(db);
  const limitador = new Limitador(maxLogins, 60_000);

  const json = (res: ServerResponse, status: number, corpo: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(corpo));

  async function ler(req: IncomingMessage) {
    let texto = "";
    for await (const parte of req) texto += parte;
    return (texto ? JSON.parse(texto) : {}) as Record<string, any>;
  }

  function exigir(req: IncomingMessage, permissao: Permissao): Sessao {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const sessao = lerToken<Sessao>(token, segredo);
    if (!sessao) throw new ErroNegocio(401, "Sessão inválida");
    if (!pode(sessao.papel, permissao)) throw new ErroNegocio(403, "Sem permissão");
    return sessao;
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const rota = `${req.method} ${url.pathname}`;
    try {
      if (rota === "POST /api/login") {
        const { empresa, email, senha } = await ler(req);
        if (!limitador.permitir(`${req.socket.remoteAddress}:${email}`)) throw new ErroNegocio(429, "Muitas tentativas, aguarde um minuto");
        const tenant = db.prepare("SELECT id, nome FROM tenants WHERE slug = ?").get(String(empresa)) as { id: number; nome: string } | undefined;
        const u = tenant && (db.prepare("SELECT * FROM usuarios WHERE tenant_id = ? AND email = ?").get(tenant.id, String(email)) as Usuario | undefined);
        if (!u || !conferirSenha(String(senha), u.senha)) throw new ErroNegocio(401, "Credenciais inválidas");
        const token = criarToken({ usuario: u.id, tenant: u.tenant_id, papel: u.papel, nome: u.nome, profissional: u.profissional_id }, segredo);
        return json(res, 200, { token, nome: u.nome, papel: u.papel, empresa: tenant!.nome, semana: SEMANA });
      }

      if (url.pathname.startsWith("/api/")) {
        if (rota === "GET /api/catalogo") return json(res, 200, agenda.catalogo(exigir(req, "ver").tenant));
        if (rota === "GET /api/agenda") {
          const s = exigir(req, "ver");
          const proprio = s.papel === "profissional" ? (s.profissional ?? -1) : undefined;
          return json(res, 200, agenda.listar(s.tenant, url.searchParams.get("de") ?? SEMANA.de, url.searchParams.get("ate") ?? SEMANA.ate, proprio));
        }
        if (rota === "GET /api/livres") {
          const s = exigir(req, "ver");
          const q = url.searchParams;
          return json(res, 200, agenda.horariosLivres(s.tenant, Number(q.get("profissional")), Number(q.get("servico")), q.get("dia") ?? ""));
        }
        if (rota === "POST /api/reservas") {
          const s = exigir(req, "reservar");
          const corpo = await ler(req);
          return json(res, 201, agenda.reservar(s.tenant, { ...corpo, chave: req.headers["idempotency-key"] as string | undefined } as never, s.nome));
        }
        const cancelar = url.pathname.match(/^\/api\/reservas\/(\d+)$/);
        if (cancelar && req.method === "DELETE") {
          const s = exigir(req, "cancelar");
          return json(res, 200, agenda.cancelar(s.tenant, Number(cancelar[1]), s.nome));
        }
        if (rota === "POST /api/fila") {
          const s = exigir(req, "reservar");
          return json(res, 201, agenda.entrarNaFila(s.tenant, (await ler(req)) as never, s.nome));
        }
        if (rota === "GET /api/fila") return json(res, 200, agenda.fila(exigir(req, "ver").tenant));
        if (rota === "GET /api/metricas") return json(res, 200, agenda.metricas(exigir(req, "gerir").tenant, SEMANA.de, SEMANA.ate));
        if (rota === "GET /api/auditoria") return json(res, 200, agenda.auditoria(exigir(req, "gerir").tenant));
        throw new ErroNegocio(404, "Rota inexistente");
      }

      const arquivo = normalize(url.pathname === "/" ? "index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
      const conteudo = await readFile(join(PUBLICO, arquivo));
      res.writeHead(200, { "content-type": TIPOS[extname(arquivo)] ?? "text/plain" }).end(conteudo);
    } catch (erro) {
      if (erro instanceof ErroNegocio) return json(res, erro.status, { erro: erro.message });
      if ((erro as NodeJS.ErrnoException).code === "ENOENT") return json(res, 404, { erro: "Arquivo não encontrado" });
      if (erro instanceof SyntaxError) return json(res, 400, { erro: "JSON inválido" });
      console.error(erro);
      json(res, 500, { erro: "Erro interno" });
    }
  });
}
