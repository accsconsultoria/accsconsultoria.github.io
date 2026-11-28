import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { Miniflare } from "miniflare";

const SEGREDO = "segredo-do-webhook-de-teste";
const TOKEN_MP = "TEST-token-de-teste";
const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const PDF = new TextEncoder().encode("%PDF-1.4 conteudo de teste do volume");

const CATALOGO = [
  { slug: "livro-teste", title: "Livro de Teste", priceCents: 4990, files: [{ key: "livro-teste/vol1.pdf", name: "Volume 1" }, { key: "livro-teste/vol2.pdf", name: "Volume 2" }] },
  { slug: "sem-arquivo", title: "Sem arquivo", priceCents: 1000, files: [] },
  { slug: "sem-preco", title: "Sem preço", priceCents: 0, files: [{ key: "x.pdf", name: "x" }] }
];

/* ---------- Mercado Pago e Resend simulados ---------- */
const novoMock = () => ({ preferencias: [], pagamentos: new Map(), emails: [], consultas: [], emailFalha: false, seq: 0 });
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
  if (url.host === "api.mercadopago.com" && url.pathname.startsWith("/v1/payments/")) {
    assert.equal(auth, `Bearer ${TOKEN_MP}`);
    const id = url.pathname.split("/").pop();
    mock.consultas.push(id);
    const p = mock.pagamentos.get(id);
    return p ? Response.json(p) : new Response("{}", { status: 404 });
  }
  if (url.host === "api.resend.com" && url.pathname === "/emails") {
    const corpo = await request.json();
    if (mock.emailFalha) return new Response("erro", { status: 500 });
    mock.emails.push(corpo);
    return Response.json({ id: "email-ok" });
  }
  return new Response(`host não simulado: ${url.host}`, { status: 599 });
};

const iniciar = async (extra = {}, mock = novoMock()) => {
  const mf = new Miniflare({
    modules: true,
    scriptPath: new URL("../src/index.js", import.meta.url).pathname,
    modulesRoot: new URL("../src", import.meta.url).pathname,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2025-06-01",
    d1Databases: { DB: "test-db" },
    r2Buckets: { FILES: "test-files" },
    bindings: {
      MP_ACCESS_TOKEN: TOKEN_MP, MP_WEBHOOK_SECRET: SEGREDO, RESEND_API_KEY: "re_teste",
      SITE_ORIGIN: "https://site.test", WORKER_ORIGIN: "https://worker.test",
      ENABLE_PIX: "true", MP_ENV: "test", LINK_TTL_HOURS: "168", MAX_DOWNLOADS: "2",
      EMAIL_FROM: "Publicações <pedidos@site.test>", SUPPORT_EMAIL: "suporte@site.test",
      CATALOG_JSON: JSON.stringify(CATALOGO), ...extra
    },
    outboundService: criarSaida(mock)
  });
  await mf.ready;
  const db = await mf.getD1Database("DB");
  for (const stmt of SCHEMA.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
  const r2 = await mf.getR2Bucket("FILES");
  await r2.put("livro-teste/vol1.pdf", PDF);
  await r2.put("livro-teste/vol2.pdf", PDF);
  return { mf, db, r2, mock };
};

const req = (mf, caminho, init = {}) => mf.dispatchFetch(`https://worker.test${caminho}`, init);
const postJson = (mf, caminho, corpo, cabecalhos = {}) =>
  req(mf, caminho, { method: "POST", headers: { "Content-Type": "application/json", ...cabecalhos }, body: JSON.stringify(corpo) });

const assinar = (dataId, { ts = String(Date.now()), requestId = "req-1", segredo = SEGREDO } = {}) => {
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const v1 = createHmac("sha256", segredo).update(`id:${id};request-id:${requestId};ts:${ts};`).digest("hex");
  return { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId };
};

const webhook = (mf, paymentId, opcoes = {}) =>
  req(mf, `/webhook/mercadopago?data.id=${paymentId}&type=payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...assinar(opcoes.assinarComo ?? paymentId, opcoes) },
    body: JSON.stringify({ action: "payment.updated", data: { id: paymentId } })
  });

let contador = 0;
const novoPedido = async (ctx, slug = "livro-teste") => {
  const email = `cliente${++contador}@exemplo.com`;
  const r = await postJson(ctx.mf, "/api/checkout", { slug, email });
  assert.equal(r.status, 200, await r.clone().text());
  const pref = ctx.mock.preferencias.at(-1).corpo;
  return { email, orderId: pref.external_reference, resposta: await r.json(), pref };
};
const pagamento = (ctx, orderId, { id = `pay${++contador}`, status = "approved", valor = 49.9, moeda = "BRL" } = {}) => {
  const p = { id, status, status_detail: "teste", transaction_amount: valor, currency_id: moeda, external_reference: orderId };
  ctx.mock.pagamentos.set(String(id), p);
  return p;
};
const pedidoNoBanco = (ctx, id) => ctx.db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
const emailsPara = (ctx, email) => ctx.mock.emails.filter((e) => e.to.includes(email));
const tokenDoEmail = (email) => email.text.match(/\/d\/([\w-]+)\/0/)[1];

describe("checkout e entrega — Mercado Pago Checkout Pro", () => {
  let ctx;
  before(async () => { ctx = await iniciar(); });
  after(async () => { await ctx.mf.dispose(); });

  /* ===== Catálogo e criação do checkout ===== */
  test("catálogo público lista só produtos com preço e arquivo e não expõe chaves de arquivo", async () => {
    const r = await req(ctx.mf, "/api/catalogo");
    const dados = await r.json();
    assert.deepEqual(dados.produtos.map((p) => p.slug), ["livro-teste"]);
    assert.equal(dados.produtos[0].priceCents, 4990);
    assert.match(dados.produtos[0].price, /49,90/);
    assert.ok(!JSON.stringify(dados).includes("vol1.pdf"), "chave de arquivo vazou no catálogo");
  });

  test("checkout usa o preço do servidor e ignora qualquer preço enviado pelo cliente", async () => {
    const email = `adulterador${++contador}@exemplo.com`;
    const r = await postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email, price: 1, priceCents: 1, unit_price: 0.01, amount: 1 });
    assert.equal(r.status, 200);
    const { corpo, cabecalhos } = ctx.mock.preferencias.at(-1);
    assert.equal(corpo.items[0].unit_price, 49.9);
    assert.equal(corpo.items[0].currency_id, "BRL");
    assert.equal(corpo.items[0].quantity, 1);
    assert.equal(corpo.payer.email, email);
    assert.equal(corpo.notification_url, "https://worker.test/webhook/mercadopago");
    assert.equal(corpo.back_urls.success, "https://site.test/pedido/?status=success");
    assert.equal(cabecalhos["x-idempotency-key"], corpo.external_reference);
    const pedido = await pedidoNoBanco(ctx, corpo.external_reference);
    assert.equal(pedido.amount_cents, 4990);
    assert.equal(pedido.status, "created");
    assert.equal((await r.json()).url.startsWith("https://sandbox.mp.test/"), true, "em MP_ENV=test usa o endereço de homologação");
  });

  test("somente cartão de crédito e Pix: demais meios excluídos; Pix pode ser desligado", async () => {
    await novoPedido(ctx);
    const excl = ctx.mock.preferencias.at(-1).corpo.payment_methods.excluded_payment_types.map((t) => t.id);
    for (const tipo of ["ticket", "atm", "debit_card", "prepaid_card"]) assert.ok(excl.includes(tipo), tipo);
    assert.ok(!excl.includes("credit_card") && !excl.includes("bank_transfer"), "cartão e Pix não podem ser excluídos");

    const semPix = await iniciar({ ENABLE_PIX: "false" });
    await semPix.mf.dispatchFetch("https://worker.test/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "livro-teste", email: "a@exemplo.com" }) });
    const exclSemPix = semPix.mock.preferencias.at(-1).corpo.payment_methods.excluded_payment_types.map((t) => t.id);
    assert.ok(exclSemPix.includes("bank_transfer"), "Pix deve ser excluído quando ENABLE_PIX=false");
    assert.ok(!exclSemPix.includes("credit_card"));
    await semPix.mf.dispose();
  });

  test("checkout recusa e-mail inválido, produto desconhecido, sem arquivo ou sem preço", async () => {
    assert.equal((await postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email: "nao-e-email" })).status, 400);
    assert.equal((await postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email: "" })).status, 400);
    for (const slug of ["nao-existe", "sem-arquivo", "sem-preco", ""]) {
      assert.equal((await postJson(ctx.mf, "/api/checkout", { slug, email: "ok@exemplo.com" })).status, 404, slug);
    }
    assert.equal((await req(ctx.mf, "/api/checkout", { method: "POST", body: "isto não é json" })).status, 400);
  });

  test("CORS só libera a origem do site", async () => {
    const ok = await req(ctx.mf, "/api/checkout", { method: "OPTIONS", headers: { Origin: "https://site.test" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://site.test");
    const negado = await req(ctx.mf, "/api/checkout", { method: "OPTIONS", headers: { Origin: "https://malicioso.test" } });
    assert.equal(negado.headers.get("access-control-allow-origin"), null);
  });

  /* ===== Webhook: assinatura ===== */
  test("webhook rejeita assinatura ausente, errada, de outro segredo ou de outro pagamento — sem consultar nem entregar", async () => {
    const { orderId, email } = await novoPedido(ctx);
    pagamento(ctx, orderId, { id: "pagforjado" });
    const antes = ctx.mock.consultas.length;
    const semAssinatura = await req(ctx.mf, "/webhook/mercadopago?data.id=pagforjado&type=payment", { method: "POST", body: "{}" });
    assert.equal(semAssinatura.status, 401);
    assert.equal((await webhook(ctx.mf, "pagforjado", { segredo: "outro-segredo" })).status, 401);
    assert.equal((await webhook(ctx.mf, "pagforjado", { assinarComo: "outropagamento" })).status, 401);
    const adulterada = await req(ctx.mf, "/webhook/mercadopago?data.id=pagforjado&type=payment", { method: "POST", headers: { "x-signature": "ts=1,v1=abc", "x-request-id": "r" }, body: "{}" });
    assert.equal(adulterada.status, 401);
    assert.equal(ctx.mock.consultas.length, antes, "não deve consultar o Mercado Pago sem assinatura válida");
    assert.equal(emailsPara(ctx, email).length, 0);
    assert.equal((await pedidoNoBanco(ctx, orderId)).status, "created");
  });

  /* ===== Webhook: aprovação, idempotência e entrega ===== */
  test("pagamento aprovado: consulta o Mercado Pago, marca como pago e envia UM e-mail com links individuais", async () => {
    const { orderId, email } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId);
    const r = await webhook(ctx.mf, p.id);
    assert.equal(r.status, 200);
    assert.ok(ctx.mock.consultas.includes(p.id), "o pagamento deve ser consultado diretamente no Mercado Pago");
    const pedido = await pedidoNoBanco(ctx, orderId);
    assert.equal(pedido.status, "paid");
    assert.equal(pedido.payment_id, p.id);
    assert.ok(pedido.delivered_at);
    const enviados = emailsPara(ctx, email);
    assert.equal(enviados.length, 1);
    assert.match(enviados[0].subject, /Livro de Teste/);
    assert.match(enviados[0].text, /https:\/\/worker\.test\/d\/[\w-]{40,}\/0/);
    assert.match(enviados[0].text, /https:\/\/worker\.test\/d\/[\w-]{40,}\/1/);
    assert.equal(enviados[0].reply_to, "suporte@site.test");
  });

  test("idempotência: o mesmo webhook repetido e simultâneo gera exatamente uma entrega", async () => {
    const { orderId, email } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId);
    await webhook(ctx.mf, p.id);
    await webhook(ctx.mf, p.id);
    await webhook(ctx.mf, p.id);
    const novo = await novoPedido(ctx);
    const p2 = pagamento(ctx, novo.orderId);
    const respostas = await Promise.all(Array.from({ length: 6 }, () => webhook(ctx.mf, p2.id)));
    assert.ok(respostas.every((r) => r.status === 200));
    assert.equal(emailsPara(ctx, email).length, 1, "repetição sequencial");
    assert.equal(emailsPara(ctx, novo.email).length, 1, "webhooks simultâneos");
    const { n } = await ctx.db.prepare("SELECT COUNT(*) AS n FROM download_links WHERE order_id = ?").bind(novo.orderId).first();
    assert.equal(n, 1);
  });

  test("só entrega pagamento efetivamente aprovado: pendente, em análise e rejeitado não liberam nada", async () => {
    for (const status of ["pending", "in_process", "authorized", "rejected"]) {
      const { orderId, email } = await novoPedido(ctx);
      const p = pagamento(ctx, orderId, { status });
      assert.equal((await webhook(ctx.mf, p.id)).status, 200);
      assert.equal(emailsPara(ctx, email).length, 0, status);
      assert.notEqual((await pedidoNoBanco(ctx, orderId)).status, "paid", status);
    }
  });

  test("pendente e depois aprovado entrega; rejeitado e nova tentativa aprovada também entrega", async () => {
    const a = await novoPedido(ctx);
    const pa = pagamento(ctx, a.orderId, { id: `p${++contador}`, status: "pending" });
    await webhook(ctx.mf, pa.id);
    assert.equal((await pedidoNoBanco(ctx, a.orderId)).status, "pending");
    pa.status = "approved";
    await webhook(ctx.mf, pa.id);
    assert.equal(emailsPara(ctx, a.email).length, 1);

    const b = await novoPedido(ctx);
    const rej = pagamento(ctx, b.orderId, { status: "rejected" });
    await webhook(ctx.mf, rej.id);
    const ok = pagamento(ctx, b.orderId, { status: "approved" });
    await webhook(ctx.mf, ok.id);
    assert.equal(emailsPara(ctx, b.email).length, 1);
    assert.equal((await pedidoNoBanco(ctx, b.orderId)).status, "paid");
  });

  test("valor ou moeda divergentes do pedido nunca liberam o produto", async () => {
    const a = await novoPedido(ctx);
    const barato = pagamento(ctx, a.orderId, { valor: 1 });
    assert.equal((await webhook(ctx.mf, barato.id)).status, 200);
    const b = await novoPedido(ctx);
    const dolar = pagamento(ctx, b.orderId, { moeda: "USD" });
    await webhook(ctx.mf, dolar.id);
    assert.equal(emailsPara(ctx, a.email).length + emailsPara(ctx, b.email).length, 0);
    assert.equal((await pedidoNoBanco(ctx, a.orderId)).status, "created");
    assert.equal((await pedidoNoBanco(ctx, b.orderId)).status, "created");
  });

  test("pagamento de pedido desconhecido ou inexistente no Mercado Pago é ignorado sem erro", async () => {
    const desconhecido = pagamento(ctx, "pedido-que-nao-existe");
    assert.equal((await webhook(ctx.mf, desconhecido.id)).status, 200);
    assert.equal((await webhook(ctx.mf, "pagamentoinexistente")).status, 200);
  });

  test("segundo pagamento aprovado para o mesmo pedido não gera segunda entrega", async () => {
    const { orderId, email } = await novoPedido(ctx);
    const p1 = pagamento(ctx, orderId);
    const p2 = pagamento(ctx, orderId);
    await webhook(ctx.mf, p1.id);
    await webhook(ctx.mf, p2.id);
    assert.equal(emailsPara(ctx, email).length, 1);
    assert.equal((await pedidoNoBanco(ctx, orderId)).payment_id, p1.id);
  });

  test("falha no envio do e-mail: webhook responde 5xx (para o Mercado Pago repetir) e a reentrega funciona, revogando o link anterior", async () => {
    const { orderId, email } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId);
    ctx.mock.emailFalha = true;
    assert.equal((await webhook(ctx.mf, p.id)).status, 500);
    ctx.mock.emailFalha = false;
    const falhou = await pedidoNoBanco(ctx, orderId);
    assert.equal(falhou.status, "paid");
    assert.equal(falhou.delivered_at, null);
    assert.equal((await webhook(ctx.mf, p.id)).status, 200);
    assert.equal(emailsPara(ctx, email).length, 1);
    const { ativos } = await ctx.db.prepare("SELECT COUNT(*) AS ativos FROM download_links WHERE order_id = ? AND revoked = 0").bind(orderId).first();
    assert.equal(ativos, 1, "apenas o link da entrega bem-sucedida permanece ativo");
    assert.ok((await pedidoNoBanco(ctx, orderId)).delivered_at);
  });

  /* ===== Download protegido ===== */
  test("link de download entrega o PDF com cabeçalhos de proteção e respeita o limite de downloads", async () => {
    const { orderId, email } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId);
    await webhook(ctx.mf, p.id);
    const token = tokenDoEmail(emailsPara(ctx, email)[0]);
    const r1 = await req(ctx.mf, `/d/${token}/0`);
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get("content-type"), "application/pdf");
    assert.match(r1.headers.get("content-disposition"), /attachment; filename="Volume 1\.pdf"/);
    assert.equal(r1.headers.get("cache-control"), "private, no-store");
    assert.match(r1.headers.get("x-robots-tag"), /noindex/);
    assert.deepEqual(new Uint8Array(await r1.arrayBuffer()), PDF);
    assert.equal((await req(ctx.mf, `/d/${token}/1`)).status, 200, "segundo arquivo da coleção");
    assert.equal((await req(ctx.mf, `/d/${token}/0`)).status, 410, "limite de 2 downloads atingido");
  });

  test("link inválido, adulterado, expirado ou de arquivo inexistente não entrega nada", async () => {
    const { orderId, email } = await novoPedido(ctx);
    await webhook(ctx.mf, pagamento(ctx, orderId).id);
    const token = tokenDoEmail(emailsPara(ctx, email)[0]);
    assert.equal((await req(ctx.mf, `/d/${"x".repeat(43)}/0`)).status, 404, "token inventado");
    assert.equal((await req(ctx.mf, `/d/${token.slice(0, -1)}A/0`)).status, 404, "token adulterado");
    assert.equal((await req(ctx.mf, `/d/${token}/9`)).status, 404, "índice de arquivo inexistente");
    await ctx.db.prepare("UPDATE download_links SET expires_at = ? WHERE order_id = ?").bind(1, orderId).run();
    assert.equal((await req(ctx.mf, `/d/${token}/0`)).status, 410, "link expirado");
  });

  test("arquivo ausente no armazenamento privado responde 503 sem consumir o download", async () => {
    const { orderId, email } = await novoPedido(ctx);
    await webhook(ctx.mf, pagamento(ctx, orderId).id);
    const token = tokenDoEmail(emailsPara(ctx, email)[0]);
    await ctx.r2.delete("livro-teste/vol1.pdf");
    assert.equal((await req(ctx.mf, `/d/${token}/0`)).status, 503);
    const { downloads } = await ctx.db.prepare("SELECT downloads FROM download_links WHERE order_id = ?").bind(orderId).first();
    assert.equal(downloads, 0);
    await ctx.r2.put("livro-teste/vol1.pdf", PDF);
  });

  /* ===== Reembolso, cancelamento e estorno ===== */
  test("reembolso e estorno revogam o acesso imediatamente", async () => {
    for (const status of ["refunded", "charged_back"]) {
      const { orderId, email } = await novoPedido(ctx);
      const p = pagamento(ctx, orderId);
      await webhook(ctx.mf, p.id);
      const token = tokenDoEmail(emailsPara(ctx, email)[0]);
      assert.equal((await req(ctx.mf, `/d/${token}/0`)).status, 200, "antes do reembolso");
      p.status = status;
      assert.equal((await webhook(ctx.mf, p.id)).status, 200);
      assert.equal((await pedidoNoBanco(ctx, orderId)).status, status);
      assert.equal((await req(ctx.mf, `/d/${token}/1`)).status, 410, `depois de ${status}`);
      await webhook(ctx.mf, p.id); // repetição não reabre o acesso
      assert.equal((await req(ctx.mf, `/d/${token}/1`)).status, 410);
    }
  });

  test("cancelamento antes do pagamento encerra o pedido e uma aprovação tardia não reativa", async () => {
    const { orderId, email } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId, { status: "cancelled" });
    await webhook(ctx.mf, p.id);
    assert.equal((await pedidoNoBanco(ctx, orderId)).status, "cancelled");
    p.status = "approved";
    await webhook(ctx.mf, p.id);
    assert.equal(emailsPara(ctx, email).length, 0);
    assert.equal((await pedidoNoBanco(ctx, orderId)).status, "cancelled");
  });

  test("pedido pago e depois cancelado revoga o acesso", async () => {
    const { orderId, email } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId);
    await webhook(ctx.mf, p.id);
    const token = tokenDoEmail(emailsPara(ctx, email)[0]);
    p.status = "cancelled";
    await webhook(ctx.mf, p.id);
    assert.equal((await req(ctx.mf, `/d/${token}/0`)).status, 410);
  });

  /* ===== Garantias estáticas ===== */
  test("o esquema do banco não tem nenhum campo de cartão", () => {
    const colunas = SCHEMA.replace(/^--.*$/gm, "").toLowerCase();
    for (const proibido of ["card", "cartao", "cartão", "cvv", "cvc", "pan ", "number", "expiration", "holder"]) {
      assert.ok(!colunas.includes(proibido), `campo suspeito no esquema: ${proibido}`);
    }
  });

  test("nenhum segredo ou token real aparece nos arquivos do Worker", () => {
    const arquivos = ["../wrangler.toml", "../catalog.example.json", "../src/index.js", "../src/mp.js", "../src/email.js", "../src/util.js", "../src/catalog.js", "../package.json"];
    for (const a of arquivos) {
      const texto = readFileSync(new URL(a, import.meta.url), "utf8");
      assert.ok(!/APP_USR-[\w-]{10,}|TEST-[0-9a-f]{8,}-|re_[A-Za-z0-9]{20,}/.test(texto), `possível segredo em ${a}`);
    }
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    assert.ok(/MP_ACCESS_TOKEN/.test(toml) && /secret put/.test(toml), "wrangler.toml deve apenas documentar os segredos");
    assert.ok(!/MP_ACCESS_TOKEN\s*=|MP_WEBHOOK_SECRET\s*=|RESEND_API_KEY\s*=/.test(toml), "segredos não podem ser variáveis");
  });
});
