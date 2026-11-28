const encoder = new TextEncoder();

export const now = () => Math.floor(Date.now() / 1000);

/* Erro de configuração do ambiente (variável ausente/inválida). Nunca deve vazar detalhes ao cliente. */
export class ErroConfiguracao extends Error {}

export const toHex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export const sha256Hex = async (text) =>
  toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

const importarHmac = (bytes) =>
  crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

export const hmacSha256Hex = async (secret, message) => {
  const chave = await importarHmac(encoder.encode(secret));
  return toHex(await crypto.subtle.sign("HMAC", chave, encoder.encode(message)));
};

/* Comparação em tempo constante (assinaturas). */
export const timingSafeEqual = (a, b) => {
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  if (x.length !== y.length) return false;
  let diferenca = 0;
  for (let i = 0; i < x.length; i++) diferenca |= x[i] ^ y[i];
  return diferenca === 0;
};

/* Token do link de download de um pedido: determinístico (HMAC-SHA256 de 256 bits, 43 caracteres),
   derivado de MP_WEBHOOK_SECRET com separação de domínio. Por ser recalculável, uma entrega
   interrompida é retomada com o MESMO link e a MESMA chave de idempotência do e-mail, sem duplicar
   e-mails nem invalidar o link já enviado. Só o hash do token é gravado no banco. */
export const tokenDeEntrega = async (env, orderId) => {
  if (!env.MP_WEBHOOK_SECRET) throw new ErroConfiguracao("MP_WEBHOOK_SECRET ausente");
  const mestre = await importarHmac(encoder.encode(env.MP_WEBHOOK_SECRET));
  const derivada = new Uint8Array(await crypto.subtle.sign("HMAC", mestre, encoder.encode("download-link-key:v1")));
  const chave = await importarHmac(derivada);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", chave, encoder.encode(`order:${orderId}`))));
};

export const intVar = (valor, padrao) => {
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) && n > 0 ? n : padrao;
};

export const boolVar = (valor, padrao = false) =>
  valor === undefined || valor === "" ? padrao : String(valor).toLowerCase() === "true";

export const brl = (cents) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export const emailValido = (email) =>
  typeof email === "string" &&
  email.length <= 254 &&
  /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/.test(email);

export const escHtml = (texto) =>
  String(texto)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const json = (dados, status = 200, extra = {}) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra }
  });

export const corsHeaders = (env, request) => {
  const origem = request.headers.get("Origin");
  if (!origem || origem !== env.SITE_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": origem,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
};

/* Origem pública dos links de download. Regras: https (http só em localhost), apenas a origem
   (sem caminho) e SEM a sigla da marca anterior em nenhum trecho. Retorna null se inválida:
   nesse caso o checkout é desativado (falha segura) em vez de enviar links indevidos. */
export const origemDownload = (env) => {
  let url;
  try {
    url = new URL(String(env.DOWNLOAD_ORIGIN || ""));
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (/accs/i.test(url.href)) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
};

/* Tokens de download (43 caracteres base64url) jamais devem aparecer em logs. */
const PADRAO_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g;

export const redigir = (valor) => {
  if (typeof valor === "string") return valor.replace(PADRAO_TOKEN, "[redigido]");
  if (Array.isArray(valor)) return valor.map(redigir);
  if (valor && typeof valor === "object") {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, redigir(v)]));
  }
  return valor;
};

export const log = (evento, dados = {}) => console.log(JSON.stringify({ evento, ...redigir(dados) }));
