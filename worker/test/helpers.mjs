import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";

export const SEGREDO = "segredo-do-webhook-de-teste";
export const TOKEN_MP = "TEST-token-de-teste";
export const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
export const PDF = new TextEncoder().encode("%PDF-1.4 conteudo de teste do volume");
export const SITE = "https://site.test";
export const DOWNLOAD = "https://arquivos.exemplo.test";

export const CATALOGO = [
  { slug: "livro-teste", title: "Livro de Teste", priceCents: 4990, files: [{ key: "livro-teste/vol1.pdf", name: "Volume 1" }, { key: "livro-teste/vol2.pdf", name: "Volume 2" }] },
  { slug: "sem-arquivo", title: "Sem arquivo", priceCents: 1000, files: [] },
  { slug: "sem-preco", title: "Sem preço", priceCents: 0, files: [{ key: "x.pdf", name: "x" }] }
];

/* ---------- Mercado Pago e Resend simulados ---------- */
export const novoMock = () => ({
  preferencias: [], pagamentos: new Map(), buscas: [], consultas: [],
  emails: [], chavesEmail: [], emailsPorChave: new Map(), emailFalha: false, seq: 0
});

const criarSaida = (mock) => async (request) => {
  const url = new URL(request.url);
  const auth = request.headers.get("authorization");
  if (url.host === "api.mercadopago.com" && url.pathname === "/checkout/preferences") {
    assert.equal(auth, `Bearer ${TOKEN_MP}`);
    const corpo = await request.json();
    const n = ++mock.seq;
    mock.preferencias.push({ corpo, cabecalhos: Object.fromEntries(request.headers) });
    return Response.json({ id: `pref-${n}`, init_point: `https://mp.test/pagar/${n}`, sandbox_init_point: `https://sandbox.mp.test/pagar/${n}` });
  }
  if (url.host === "api.mercadopago.com" && url.pathname === "/v1/payments/search") {
    assert.equal(auth, `Bearer ${TOKEN_MP}`);
    const ref = url.searchParams.get("external_reference");
    mock.buscas.push(ref);
    return Response.json({ results: [...mock.pagamentos.values()].filter((p) => p.external_reference === ref) });
  }
  if (url.host === "api.mercadopago.com" && url.pathname.startsWith("/v1/payments/")) {
    assert.equal(auth, `Bearer ${TOKEN_MP}`);
    const id = url.pathname.split("/").pop();
    mock.consultas.push(id);
    const p = mock.pagamentos.get(id);
    return p ? Response.json(p) : new Response("{}", { status: 404 });
  }
  if (url.host === "api.resend.com" && url.pathname === "/emails") {
    const corpo = await request.json();
    const chave = request.headers.get("idempotency-key");
    mock.chavesEmail.push(chave);
    if (mock.emailFalha) return new Response("erro", { status: 500 });
    if (chave && mock.emailsPorChave.has(chave)) return Response.json({ id: "email-ok", repetido: true }); // como o Resend: não reenvia
    mock.emailsPorChave.set(chave, corpo);
    mock.emails.push(corpo);
    return Response.json({ id: "email-ok" });
  }
  return new Response(`host não simulado: ${url.host}`, { status: 599 });
};

export const iniciar = async (extra = {}, mock = novoMock(), opcoesMf = {}) => {
  const mf = new Miniflare({
    ...opcoesMf,
    modules: true,
    scriptPath: new URL("../src/index.js", import.meta.url).pathname,
    modulesRoot: new URL("../src", import.meta.url).pathname,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2025-06-01",
    d1Databases: { DB: "test-db" },
    r2Buckets: { BUCKET: "test-bucket" },
    bindings: {
      MP_ACCESS_TOKEN: TOKEN_MP, MP_WEBHOOK_SECRET: SEGREDO, RESEND_API_KEY: "re_teste",
      SITE_ORIGIN: SITE, WORKER_ORIGIN: "https://worker.test", DOWNLOAD_ORIGIN: DOWNLOAD,
      ENABLE_PIX: "true", MP_ENV: "test", LINK_TTL_HOURS: "168", MAX_DOWNLOADS: "2",
      EMAIL_FROM: "Publicações <pedidos@site.test>", SUPPORT_EMAIL: "suporte@site.test",
      RATE_IP_MAX: "1000", RATE_EMAIL_MAX: "1000",
      CATALOG_JSON: JSON.stringify(CATALOGO), ...extra
    },
    outboundService: criarSaida(mock)
  });
  await mf.ready;
  const db = await mf.getD1Database("DB");
  for (const stmt of SCHEMA.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
  const r2 = await mf.getR2Bucket("BUCKET");
  await r2.put("livro-teste/vol1.pdf", PDF);
  await r2.put("livro-teste/vol2.pdf", PDF);
  return { mf, db, r2, mock };
};

export const req = (mf, caminho, init = {}) => mf.dispatchFetch(`https://worker.test${caminho}`, init);

/* POST do checkout como o navegador do site faz (Origin do site e JSON). */
export const postJson = (mf, caminho, corpo, cabecalhos = {}) =>
  req(mf, caminho, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SITE, ...cabecalhos },
    body: JSON.stringify(corpo)
  });

export const assinar = (dataId, { ts = String(Math.floor(Date.now() / 1000)), requestId = "req-1", segredo = SEGREDO } = {}) => {
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const v1 = createHmac("sha256", segredo).update(`id:${id};request-id:${requestId};ts:${ts};`).digest("hex");
  return { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId };
};

export const webhook = (mf, paymentId, opcoes = {}) =>
  req(mf, `/webhook/mercadopago?data.id=${paymentId}&type=payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...assinar(opcoes.assinarComo ?? paymentId, opcoes) },
    body: JSON.stringify({ action: "payment.updated", data: { id: paymentId } })
  });

let contador = 0;
export const proximo = () => ++contador;

export const novoPedido = async (ctx, slug = "livro-teste", cabecalhos = {}) => {
  const email = `cliente${++contador}@exemplo.com`;
  const r = await postJson(ctx.mf, "/api/checkout", { slug, email }, cabecalhos);
  assert.equal(r.status, 200, await r.clone().text());
  const pref = ctx.mock.preferencias.at(-1).corpo;
  return { email, orderId: pref.external_reference, resposta: await r.json(), pref };
};

export const pagamento = (ctx, orderId, { id = `pay${++contador}`, status = "approved", valor = 49.9, moeda = "BRL", reembolsado = 0, emailPagador } = {}) => {
  const p = {
    id, status, status_detail: "teste", transaction_amount: valor, transaction_amount_refunded: reembolsado,
    currency_id: moeda, external_reference: orderId, ...(emailPagador ? { payer: { email: emailPagador } } : {})
  };
  ctx.mock.pagamentos.set(String(id), p);
  return p;
};

export const pedidoNoBanco = (ctx, id) => ctx.db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
export const emailsPara = (ctx, email) => ctx.mock.emails.filter((e) => e.to.includes(email));
export const tokenDoEmail = (email) => email.text.match(/\/d\/([\w-]{43})\/0/)[1];
export const linksDoPedido = (ctx, id) => ctx.db.prepare("SELECT * FROM download_links WHERE order_id = ?").bind(id).all().then((r) => r.results);
export const eventosDoPedido = (ctx, id) => ctx.db.prepare("SELECT * FROM payment_events WHERE order_id = ? ORDER BY received_at").bind(id).all().then((r) => r.results);

/* Executa a rotina agendada (cron) do Worker. */
export const cron = async (ctx) => {
  const worker = await ctx.mf.getWorker();
  return worker.scheduled({ cron: "*/10 * * * *" });
};

export const agora = () => Math.floor(Date.now() / 1000);
