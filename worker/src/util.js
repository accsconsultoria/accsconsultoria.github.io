const encoder = new TextEncoder();

export const now = () => Math.floor(Date.now() / 1000);

export const toHex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (text) =>
  toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

export const hmacSha256Hex = async (secret, message) => {
  const chave = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return toHex(await crypto.subtle.sign("HMAC", chave, encoder.encode(message)));
};

/* Comparação em tempo constante (assinaturas e tokens). */
export const timingSafeEqual = (a, b) => {
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  if (x.length !== y.length) return false;
  let diferenca = 0;
  for (let i = 0; i < x.length; i++) diferenca |= x[i] ^ y[i];
  return diferenca === 0;
};

/* Token aleatório de 256 bits em base64url. */
export const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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

export const log = (evento, dados = {}) => console.log(JSON.stringify({ evento, ...dados }));
