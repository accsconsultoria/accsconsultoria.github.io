import { now, sha256Hex } from "./util.js";

/* Limitação de requisições por janela fixa, em D1, com contagem atômica
   (INSERT ... ON CONFLICT ... RETURNING). As chaves são hashes (IP e e-mail nunca são gravados
   em claro) e as linhas expiram sozinhas; a manutenção as apaga. */

export const chaveHash = async (prefixo, valor) => `${prefixo}:${(await sha256Hex(String(valor))).slice(0, 32)}`;

export const consumir = async (env, chave, limite, janelaSegundos) => {
  const agora = now();
  const indice = Math.floor(agora / janelaSegundos);
  const fim = (indice + 1) * janelaSegundos;
  const linha = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1
       RETURNING count`
  ).bind(`${chave}:${indice}`, fim + 60).first();
  return { permitido: linha.count <= limite, tentativas: linha.count, reiniciaEm: Math.max(1, fim - agora) };
};
