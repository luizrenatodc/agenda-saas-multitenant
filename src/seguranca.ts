import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashSenha(senha: string): string {
  const sal = randomBytes(16).toString("hex");
  return `${sal}:${scryptSync(senha, sal, 32).toString("hex")}`;
}

export function conferirSenha(senha: string, guardado: string): boolean {
  const [sal, hash] = guardado.split(":");
  return timingSafeEqual(Buffer.from(hash, "hex"), scryptSync(senha, sal, 32));
}

const b64 = (texto: string) => Buffer.from(texto).toString("base64url");
const assinar = (conteudo: string, segredo: string) => createHmac("sha256", segredo).update(conteudo).digest("base64url");

export function criarToken(dados: Record<string, unknown>, segredo: string, validadeSegundos = 3600, agora = Date.now()): string {
  const conteudo = `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64(JSON.stringify({ ...dados, exp: Math.floor(agora / 1000) + validadeSegundos }))}`;
  return `${conteudo}.${assinar(conteudo, segredo)}`;
}

export function lerToken<T>(token: string, segredo: string, agora = Date.now()): T | undefined {
  const [cabecalho, corpo, assinatura] = token.split(".");
  if (!cabecalho || !corpo || !assinatura) return undefined;
  const esperado = Buffer.from(assinar(`${cabecalho}.${corpo}`, segredo));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) return undefined;
  const dados = JSON.parse(Buffer.from(corpo, "base64url").toString());
  return dados.exp * 1000 > agora ? dados : undefined;
}

/** Janela deslizante em memória, usada para frear tentativas de login. */
export class Limitador {
  #acessos = new Map<string, number[]>();
  #maximo: number;
  #janelaMs: number;

  constructor(maximo: number, janelaMs: number) {
    this.#maximo = maximo;
    this.#janelaMs = janelaMs;
  }

  permitir(chave: string, agora = Date.now()): boolean {
    const recentes = (this.#acessos.get(chave) ?? []).filter((t) => agora - t < this.#janelaMs);
    const ok = recentes.length < this.#maximo;
    if (ok) recentes.push(agora);
    this.#acessos.set(chave, recentes);
    return ok;
  }
}

export type Papel = "dono" | "atendente" | "profissional";
export type Permissao = "ver" | "reservar" | "cancelar" | "gerir";

const PERMISSOES: Record<Papel, Permissao[]> = {
  dono: ["ver", "reservar", "cancelar", "gerir"],
  atendente: ["ver", "reservar", "cancelar"],
  profissional: ["ver"],
};

export const pode = (papel: Papel, permissao: Permissao) => PERMISSOES[papel].includes(permissao);
