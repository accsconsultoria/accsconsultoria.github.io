/* Correções finais: S1 (limites), S2 (origem/Content-Type), S3 (entrega recuperável), S4 (disputas e
   reembolso parcial), S5 (tolerância do timestamp), B1, B3, B4 (logs), B8 (retenção), B10 (ambientes).
   Todos os testes rodam o Worker real no Miniflare; Mercado Pago e Resend são simulados. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import {
  DOWNLOAD, SITE, agora, assinar, cron, emailsPara, eventosDoPedido, iniciar, linksDoPedido, novoMock, novoPedido,
  pagamento, pedidoNoBanco, postJson, req, tokenDoEmail, webhook
} from "./helpers.mjs";

const contarPedidos = async (ctx) => (await ctx.db.prepare("SELECT COUNT(*) AS n FROM orders").first()).n;
const semear = (ctx, o) =>
  ctx.db.prepare(
    `INSERT INTO orders (id, slug, email, amount_cents, status, payment_id, created_at, paid_at, delivered_at, delivery_claim, updated_at)
     VALUES (?, 'livro-teste', ?, 4990, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(o.id, o.email, o.status, o.payment_id ?? null, o.created_at, o.paid_at ?? null, o.delivered_at ?? null, o.delivery_claim ?? null, o.created_at).run();

/* Compra completa e entregue, devolvendo o necessário para cenários posteriores. */
const comprarEEntregar = async (ctx, opcoes = {}) => {
  const pedido = await novoPedido(ctx);
  const pag = pagamento(ctx, pedido.orderId, opcoes);
  assert.equal((await webhook(ctx.mf, pag.id)).status, 200);
  const token = tokenDoEmail(emailsPara(ctx, pedido.email)[0]);
  return { ...pedido, pag, token };
};

/* ===================================================================== S2 */
describe("S2 — validação de origem e Content-Type no checkout", () => {
  let ctx;
  before(async () => { ctx = await iniciar(); });
  after(async () => { await ctx.mf.dispose(); });

  test("sem Origin ou com Origin de outro site: 403, sem CORS e sem criar pedido", async () => {
    const antes = await contarPedidos(ctx);
    const corpo = JSON.stringify({ slug: "livro-teste", email: "a@exemplo.com" });
    const semOrigin = await req(ctx.mf, "/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: corpo });
    assert.equal(semOrigin.status, 403);
    const outra = await req(ctx.mf, "/api/checkout", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://malicioso.test" }, body: corpo });
    assert.equal(outra.status, 403);
    assert.equal(outra.headers.get("access-control-allow-origin"), null);
    const parecida = await req(ctx.mf, "/api/checkout", { method: "POST", headers: { "Content-Type": "application/json", Origin: `${SITE}.malicioso.test` }, body: corpo });
    assert.equal(parecida.status, 403, "origem com o mesmo prefixo não vale");
    assert.equal(await contarPedidos(ctx), antes);
    assert.equal(ctx.mock.preferencias.length, 0, "nada foi enviado ao Mercado Pago");
  });

  test("POST 'simples' cross-site (text/plain ou formulário) é recusado com 415 e não cria pedido", async () => {
    const antes = await contarPedidos(ctx);
    for (const tipo of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
      const r = await req(ctx.mf, "/api/checkout", { method: "POST", headers: { ...(tipo ? { "Content-Type": tipo } : {}), Origin: SITE }, body: JSON.stringify({ slug: "livro-teste", email: "a@exemplo.com" }) });
      assert.equal(r.status, 415, `tipo "${tipo}"`);
    }
    assert.equal(await contarPedidos(ctx), antes);
  });

  test("application/json com charset é aceito e o corpo gigante é recusado", async () => {
    const ok = await req(ctx.mf, "/api/checkout", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", Origin: SITE }, body: JSON.stringify({ slug: "livro-teste", email: "charset@exemplo.com" }) });
    assert.equal(ok.status, 200);
    const antes = await contarPedidos(ctx);
    const gigante = await postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email: "g@exemplo.com", lixo: "x".repeat(6000) });
    assert.ok([400, 413].includes(gigante.status), `corpo grande: ${gigante.status}`);
    assert.equal(await contarPedidos(ctx), antes);
  });

  test("o webhook não exige Origin (quem o chama é o Mercado Pago), mas continua exigindo assinatura", async () => {
    const { orderId } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId);
    assert.equal((await webhook(ctx.mf, p.id)).status, 200);
    assert.equal((await req(ctx.mf, `/webhook/mercadopago?data.id=${p.id}&type=payment`, { method: "POST", body: "{}" })).status, 401);
  });
});

/* ===================================================================== S1 */
describe("S1 — limitação de requisições", () => {
  test("limite por IP: excedido devolve 429 com Retry-After, sem criar pedido; outro IP segue livre", async () => {
    const ctx = await iniciar({ RATE_IP_MAX: "3", RATE_EMAIL_MAX: "1000" });
    try {
      const ip = { "CF-Connecting-IP": "203.0.113.7" };
      for (let i = 1; i <= 3; i++) assert.equal((await postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email: `ip${i}@exemplo.com` }, ip)).status, 200, `tentativa ${i}`);
      const antes = await contarPedidos(ctx);
      const bloqueada = await postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email: "ip4@exemplo.com" }, ip);
      assert.equal(bloqueada.status, 429);
      assert.equal((await bloqueada.json()).erro, "muitas_tentativas");
      assert.ok(Number(bloqueada.headers.get("retry-after")) >= 1);
      assert.equal(await contarPedidos(ctx), antes, "a tentativa bloqueada não cria pedido");
      assert.equal((await postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email: "ip5@exemplo.com" }, { "CF-Connecting-IP": "203.0.113.8" })).status, 200);
    } finally { await ctx.mf.dispose(); }
  });

  test("limite por e-mail: o mesmo e-mail é limitado mesmo trocando de IP", async () => {
    const ctx = await iniciar({ RATE_IP_MAX: "1000", RATE_EMAIL_MAX: "2" });
    try {
      for (let i = 1; i <= 2; i++) assert.equal((await postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email: "mesmo@exemplo.com" }, { "CF-Connecting-IP": `198.51.100.${i}` })).status, 200);
      const r = await postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email: "MESMO@exemplo.com" }, { "CF-Connecting-IP": "198.51.100.99" });
      assert.equal(r.status, 429, "maiúsculas/minúsculas contam como o mesmo e-mail");
      assert.equal((await postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email: "outro@exemplo.com" }, { "CF-Connecting-IP": "198.51.100.99" })).status, 200);
    } finally { await ctx.mf.dispose(); }
  });

  test("concorrência: 15 requisições simultâneas do mesmo IP com limite 5 resultam em exatamente 5 pedidos", async () => {
    const ctx = await iniciar({ RATE_IP_MAX: "5", RATE_EMAIL_MAX: "1000" });
    try {
      const ip = { "CF-Connecting-IP": "192.0.2.50" };
      const respostas = await Promise.all(Array.from({ length: 15 }, (_, i) => postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email: `conc${i}@exemplo.com` }, ip)));
      const status = respostas.map((r) => r.status);
      assert.equal(status.filter((s) => s === 200).length, 5, `status: ${status}`);
      assert.equal(status.filter((s) => s === 429).length, 10);
      assert.equal(await contarPedidos(ctx), 5);
      assert.equal(ctx.mock.preferencias.length, 5, "só 5 chamadas ao Mercado Pago");
    } finally { await ctx.mf.dispose(); }
  });

  test("requisições inválidas não consomem o limite; chaves guardadas são hashes, nunca IP ou e-mail", async () => {
    const ctx = await iniciar({ RATE_IP_MAX: "2", RATE_EMAIL_MAX: "2" });
    try {
      const ip = { "CF-Connecting-IP": "203.0.113.77" };
      for (let i = 0; i < 10; i++) await postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email: "invalido" }, ip);
      assert.equal((await postJson(ctx.mf, "/api/checkout", { slug: "livro-teste", email: "valido@exemplo.com" }, ip)).status, 200);
      const { results } = await ctx.db.prepare("SELECT bucket FROM rate_limits").all();
      assert.ok(results.length >= 2);
      for (const { bucket } of results) {
        assert.ok(!bucket.includes("203.0.113.77") && !bucket.includes("valido@exemplo.com"), `chave em claro: ${bucket}`);
        assert.match(bucket, /^(ip|em):[0-9a-f]{32}:\d+$/);
      }
    } finally { await ctx.mf.dispose(); }
  });

  test("webhook e download não sofrem a limitação do checkout", async () => {
    const ctx = await iniciar({ RATE_IP_MAX: "1", RATE_EMAIL_MAX: "1" });
    try {
      const { orderId, email } = await novoPedido(ctx);
      const p = pagamento(ctx, orderId);
      for (let i = 0; i < 10; i++) assert.equal((await webhook(ctx.mf, p.id)).status, 200);
      const token = tokenDoEmail(emailsPara(ctx, email)[0]);
      assert.equal((await req(ctx.mf, `/d/${token}/0`)).status, 200);
    } finally { await ctx.mf.dispose(); }
  });
});

/* ===================================================================== S5 */
describe("S5 — janela de tolerância da assinatura do webhook", () => {
  let ctx;
  before(async () => { ctx = await iniciar(); });
  after(async () => { await ctx.mf.dispose(); });

  const comTs = async (deslocamentoSegundos, unidade = "s") => {
    const { orderId } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId);
    const base = agora() + deslocamentoSegundos;
    const ts = unidade === "ms" ? String(base * 1000) : String(base);
    return { p, orderId, resposta: await webhook(ctx.mf, p.id, { ts }) };
  };

  test("assinatura válida mas antiga (2 h) ou do futuro (1 h) é recusada — o pedido não muda", async () => {
    const antigo = await comTs(-7200);
    assert.equal(antigo.resposta.status, 401);
    assert.equal((await pedidoNoBanco(ctx, antigo.orderId)).status, "created");
    assert.ok(!ctx.mock.consultas.includes(antigo.p.id), "nem sequer consulta o Mercado Pago");
    assert.equal((await comTs(3600)).resposta.status, 401);
  });

  test("dentro da janela (agora, -5 min, +2 min) é aceita, em segundos ou milissegundos", async () => {
    assert.equal((await comTs(0)).resposta.status, 200);
    assert.equal((await comTs(-300)).resposta.status, 200);
    assert.equal((await comTs(120)).resposta.status, 200);
    assert.equal((await comTs(-60, "ms")).resposta.status, 200);
  });

  test("a janela é configurável: com 30 s, uma notificação de 60 s atrás é recusada", async () => {
    const apertado = await iniciar({ WEBHOOK_TOLERANCE_SECONDS: "30" });
    try {
      const { orderId } = await novoPedido(apertado);
      const p = pagamento(apertado, orderId);
      assert.equal((await webhook(apertado.mf, p.id, { ts: String(agora() - 60) })).status, 401);
      assert.equal((await webhook(apertado.mf, p.id, { ts: String(agora() - 10) })).status, 200);
    } finally { await apertado.mf.dispose(); }
  });

  test("uma notificação capturada e reenviada depois da janela não passa", async () => {
    const { orderId } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId);
    const capturado = assinar(p.id, { ts: String(agora() - 3000) });
    const r = await req(ctx.mf, `/webhook/mercadopago?data.id=${p.id}&type=payment`, { method: "POST", headers: capturado, body: "{}" });
    assert.equal(r.status, 401);
  });
});

/* ===================================================================== S4 */
describe("S4 — disputas, reembolso parcial e histórico financeiro", () => {
  let ctx;
  before(async () => { ctx = await iniciar(); });
  after(async () => { await ctx.mf.dispose(); });

  test("reembolso parcial: registra valor e estado, sinaliza análise e NÃO revoga o acesso", async () => {
    const c = await comprarEEntregar(ctx);
    c.pag.transaction_amount_refunded = 10;
    assert.equal((await webhook(ctx.mf, c.pag.id)).status, 200);
    const pedido = await pedidoNoBanco(ctx, c.orderId);
    assert.equal(pedido.status, "paid", "continua pago");
    assert.equal(pedido.refunded_cents, 1000);
    assert.equal(pedido.review_status, "needs_review");
    assert.equal(pedido.review_reason, "reembolso_parcial");
    assert.equal(pedido.delivery_suspended, 0);
    assert.equal((await req(ctx.mf, `/d/${c.token}/0`)).status, 200, "o link continua funcionando");
    assert.equal((await linksDoPedido(ctx, c.orderId))[0].revoked, 0);
    assert.equal(emailsPara(ctx, c.email).length, 1, "nenhum e-mail novo");
    await webhook(ctx.mf, c.pag.id); // repetição
    assert.equal((await eventosDoPedido(ctx, c.orderId)).filter((e) => e.status === "approved" && e.refunded_cents === 1000).length, 1, "evento registrado uma só vez");

    c.pag.transaction_amount_refunded = 20; // novo reembolso parcial
    await webhook(ctx.mf, c.pag.id);
    assert.equal((await pedidoNoBanco(ctx, c.orderId)).refunded_cents, 2000);
    assert.deepEqual((await eventosDoPedido(ctx, c.orderId)).map((e) => e.refunded_cents).sort((a, b) => a - b), [0, 1000, 2000], "histórico preservado");

    c.pag.status = "refunded"; // reembolso total: aí sim revoga
    c.pag.transaction_amount_refunded = 49.9;
    await webhook(ctx.mf, c.pag.id);
    assert.equal((await pedidoNoBanco(ctx, c.orderId)).status, "refunded");
    assert.equal((await req(ctx.mf, `/d/${c.token}/0`)).status, 410);
  });

  test("disputa (in_mediation) em pedido entregue: suspende novas entregas, mantém os links e aguarda decisão", async () => {
    const c = await comprarEEntregar(ctx);
    c.pag.status = "in_mediation";
    assert.equal((await webhook(ctx.mf, c.pag.id)).status, 200);
    const pedido = await pedidoNoBanco(ctx, c.orderId);
    assert.equal(pedido.status, "paid");
    assert.equal(pedido.delivery_suspended, 1);
    assert.equal(pedido.review_status, "needs_review");
    assert.equal(pedido.review_reason, "disputa_em_mediacao");
    assert.equal((await req(ctx.mf, `/d/${c.token}/0`)).status, 200, "links já enviados não são revogados automaticamente");

    c.pag.status = "approved"; // disputa encerrada a favor da venda: a suspensão NÃO é levantada sozinha
    await webhook(ctx.mf, c.pag.id);
    assert.equal((await pedidoNoBanco(ctx, c.orderId)).delivery_suspended, 1, "decisão fica com o proprietário");
  });

  test("estorno do cartão (charged_back): registra, suspende e sinaliza — sem revogar nem apagar histórico", async () => {
    const c = await comprarEEntregar(ctx);
    const antes = (await eventosDoPedido(ctx, c.orderId)).length;
    c.pag.status = "charged_back";
    assert.equal((await webhook(ctx.mf, c.pag.id)).status, 200);
    const pedido = await pedidoNoBanco(ctx, c.orderId);
    assert.equal(pedido.status, "paid");
    assert.equal(pedido.delivery_suspended, 1);
    assert.equal(pedido.review_reason, "estorno_do_cartao");
    assert.equal((await req(ctx.mf, `/d/${c.token}/0`)).status, 200);
    assert.equal((await eventosDoPedido(ctx, c.orderId)).length, antes + 1, "o evento foi acrescentado ao histórico");
  });

  test("disputa antes da entrega suspende a entrega; a decisão do proprietário (SQL) libera e a manutenção entrega UMA vez", async () => {
    const { orderId, email } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId);
    ctx.mock.emailFalha = true;
    assert.equal((await webhook(ctx.mf, p.id)).status, 500, "pago, mas e-mail fora do ar: entrega pendente");
    ctx.mock.emailFalha = false;
    p.status = "in_mediation";
    await webhook(ctx.mf, p.id);
    assert.equal((await pedidoNoBanco(ctx, orderId)).delivery_suspended, 1);

    p.status = "approved";
    const r = await webhook(ctx.mf, p.id);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).resultado, "entrega_suspensa");
    assert.equal(emailsPara(ctx, email).length, 0, "nenhuma entrega durante a disputa");
    await ctx.db.prepare("UPDATE orders SET paid_at = ? WHERE id = ?").bind(agora() - 3600, orderId).run();
    await cron(ctx);
    assert.equal(emailsPara(ctx, email).length, 0, "a manutenção também respeita a suspensão");

    // decisão posterior do proprietário (runbook do CHECKOUT.md)
    await ctx.db.prepare("UPDATE orders SET delivery_suspended = 0, review_status = 'resolved', review_note = 'liberado após análise' WHERE id = ?").bind(orderId).run();
    await cron(ctx);
    await cron(ctx);
    assert.equal(emailsPara(ctx, email).length, 1, "entregue uma única vez após a liberação");
    const pedido = await pedidoNoBanco(ctx, orderId);
    assert.equal(pedido.review_status, "resolved");
    assert.equal(pedido.review_note, "liberado após análise");
  });

  test("histórico financeiro nunca é apagado: a manutenção preserva eventos e pedidos pagos", async () => {
    const c = await comprarEEntregar(ctx);
    c.pag.status = "refunded";
    await webhook(ctx.mf, c.pag.id);
    const antes = (await ctx.db.prepare("SELECT COUNT(*) AS n FROM payment_events").first()).n;
    const pagos = (await ctx.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE paid_at IS NOT NULL").first()).n;
    await cron(ctx);
    await cron(ctx);
    assert.equal((await ctx.db.prepare("SELECT COUNT(*) AS n FROM payment_events").first()).n, antes);
    assert.equal((await ctx.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE paid_at IS NOT NULL").first()).n, pagos);
  });
});

/* ===================================================================== S3 / B1 */
describe("S3 — entrega interrompida: recuperação sem duplicar", () => {
  let ctx;
  before(async () => { ctx = await iniciar(); });
  after(async () => { await ctx.mf.dispose(); });

  const pagoNaoEntregue = async (extra = {}) => {
    const { orderId, email } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId);
    await ctx.db.prepare("UPDATE orders SET status = 'paid', payment_id = ?, paid_at = ?, delivery_claim = ? WHERE id = ?").bind(p.id, agora() - 3600, extra.claim ?? null, orderId).run();
    return { orderId, email, p };
  };

  test("entrega em andamento por outro processo: o webhook NÃO confirma sucesso (503) e não envia nada", async () => {
    const { orderId, email, p } = await pagoNaoEntregue({ claim: agora() });
    const r = await webhook(ctx.mf, p.id);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).erro, "entrega_pendente");
    assert.equal(emailsPara(ctx, email).length, 0);
    assert.equal((await pedidoNoBanco(ctx, orderId)).delivered_at, null);
  });

  test("reivindicação abandonada (processo morreu): o webhook seguinte recupera e entrega uma vez", async () => {
    const { orderId, email, p } = await pagoNaoEntregue({ claim: agora() - 120 });
    assert.equal((await webhook(ctx.mf, p.id)).status, 200);
    assert.equal(emailsPara(ctx, email).length, 1);
    assert.ok((await pedidoNoBanco(ctx, orderId)).delivered_at);
  });

  test("manutenção recupera entrega interrompida SEM novo webhook (pago, sem e-mail, sem link)", async () => {
    const { orderId, email } = await pagoNaoEntregue({ claim: agora() - 500 });
    await cron(ctx);
    assert.equal(emailsPara(ctx, email).length, 1);
    assert.ok((await pedidoNoBanco(ctx, orderId)).delivered_at);
    await cron(ctx);
    assert.equal(emailsPara(ctx, email).length, 1, "segunda execução não duplica");
  });

  test("processo morreu depois de criar o link e antes do e-mail: reaproveita o link, um só e-mail", async () => {
    const { orderId, email } = await pagoNaoEntregue();
    await cron(ctx);
    const [primeiro] = await linksDoPedido(ctx, orderId);
    await ctx.db.prepare("UPDATE orders SET delivered_at = NULL, delivery_claim = NULL WHERE id = ?").bind(orderId).run();
    ctx.mock.emails.length = 0; // como se o e-mail nunca tivesse saído
    ctx.mock.emailsPorChave.clear();
    await cron(ctx);
    const links = await linksDoPedido(ctx, orderId);
    assert.equal(links.length, 1);
    assert.equal(links[0].token_hash, primeiro.token_hash);
    assert.equal(emailsPara(ctx, email).length, 1);
  });

  test("processo morreu DEPOIS de enviar o e-mail e antes de gravar a entrega: o provedor deduplica pela chave de idempotência", async () => {
    const { orderId, email } = await pagoNaoEntregue();
    await cron(ctx);
    assert.equal(emailsPara(ctx, email).length, 1);
    await ctx.db.prepare("UPDATE orders SET delivered_at = NULL, delivery_claim = NULL WHERE id = ?").bind(orderId).run();
    await cron(ctx);
    assert.equal(emailsPara(ctx, email).length, 1, "nenhum e-mail duplicado");
    const chaves = ctx.mock.chavesEmail.filter((k) => k === `entrega-${orderId}`);
    assert.equal(chaves.length, 2, "o envio foi repetido com a MESMA chave de idempotência");
    assert.ok((await pedidoNoBanco(ctx, orderId)).delivered_at);
  });

  test("e-mail fora do ar na manutenção: nada se perde; ao voltar, entrega uma vez", async () => {
    const { orderId, email } = await pagoNaoEntregue();
    ctx.mock.emailFalha = true;
    await cron(ctx);
    assert.equal(emailsPara(ctx, email).length, 0);
    const preso = await pedidoNoBanco(ctx, orderId);
    assert.equal(preso.delivered_at, null);
    assert.equal(preso.delivery_claim, null, "reivindicação liberada para nova tentativa");
    ctx.mock.emailFalha = false;
    await cron(ctx);
    assert.equal(emailsPara(ctx, email).length, 1);
  });

  test("webhooks simultâneos e a manutenção ao mesmo tempo geram exatamente um e-mail", async () => {
    const { orderId, email } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId);
    await ctx.db.prepare("UPDATE orders SET status = 'paid', payment_id = ?, paid_at = ? WHERE id = ?").bind(p.id, agora() - 3600, orderId).run();
    const respostas = await Promise.all([...Array.from({ length: 5 }, () => webhook(ctx.mf, p.id)), cron(ctx), cron(ctx)]);
    assert.ok(respostas.slice(0, 5).every((r) => [200, 503].includes(r.status)));
    assert.equal(emailsPara(ctx, email).length, 1);
    assert.equal((await linksDoPedido(ctx, orderId)).length, 1);
  });

  test("a manutenção não entrega pedidos não pagos, suspensos ou já entregues", async () => {
    const naoPago = await novoPedido(ctx);
    const suspenso = await pagoNaoEntregue();
    await ctx.db.prepare("UPDATE orders SET delivery_suspended = 1 WHERE id = ?").bind(suspenso.orderId).run();
    await cron(ctx);
    assert.equal(emailsPara(ctx, naoPago.email).length, 0);
    assert.equal(emailsPara(ctx, suspenso.email).length, 0);
  });

  test("B1: aprovação em pedido reembolsado vai para análise e é registrada; nada é entregue", async () => {
    const c = await comprarEEntregar(ctx);
    c.pag.status = "refunded";
    await webhook(ctx.mf, c.pag.id);
    const novo = pagamento(ctx, c.orderId, { id: `tardio${Date.now()}` });
    assert.equal((await webhook(ctx.mf, novo.id)).status, 200);
    const pedido = await pedidoNoBanco(ctx, c.orderId);
    assert.equal(pedido.status, "refunded");
    assert.equal(pedido.review_reason, "pagamento_aprovado_em_pedido_encerrado");
    assert.equal(emailsPara(ctx, c.email).length, 1);
  });

  test("B3: e-mail do pagador diferente do informado não altera o destino da entrega", async () => {
    const { orderId, email } = await novoPedido(ctx);
    const p = pagamento(ctx, orderId, { emailPagador: "outra.pessoa@exemplo.com" });
    assert.equal((await webhook(ctx.mf, p.id)).status, 200);
    assert.equal(emailsPara(ctx, email).length, 1);
    assert.equal(emailsPara(ctx, "outra.pessoa@exemplo.com").length, 0);
  });
});

describe("Reconciliação de pagamentos cujo webhook não chegou", () => {
  let ctx;
  before(async () => { ctx = await iniciar(); });
  after(async () => { await ctx.mf.dispose(); });

  test("pedido sem desfecho há mais de 10 min: a manutenção consulta o Mercado Pago e conclui a entrega", async () => {
    const { orderId, email } = await novoPedido(ctx);
    pagamento(ctx, orderId);
    await ctx.db.prepare("UPDATE orders SET created_at = ? WHERE id = ?").bind(agora() - 1200, orderId).run();
    await cron(ctx);
    assert.ok(ctx.mock.buscas.includes(orderId));
    assert.equal((await pedidoNoBanco(ctx, orderId)).status, "paid");
    assert.equal(emailsPara(ctx, email).length, 1);
  });

  test("não reconcilia pedido recente, antigo demais ou consultado há menos de 1 h", async () => {
    const recente = await novoPedido(ctx);
    const antigo = await novoPedido(ctx);
    await ctx.db.prepare("UPDATE orders SET created_at = ? WHERE id = ?").bind(agora() - 8 * 86400, antigo.orderId).run();
    const visto = await novoPedido(ctx);
    await ctx.db.prepare("UPDATE orders SET created_at = ?, last_reconcile = ? WHERE id = ?").bind(agora() - 1200, agora() - 600, visto.orderId).run();
    await cron(ctx);
    for (const p of [recente, antigo, visto]) assert.ok(!ctx.mock.buscas.includes(p.orderId), p.orderId);
  });

  test("rodar a manutenção de novo não repete a consulta dentro de 1 h", async () => {
    const { orderId } = await novoPedido(ctx);
    await ctx.db.prepare("UPDATE orders SET created_at = ? WHERE id = ?").bind(agora() - 1200, orderId).run();
    await cron(ctx);
    await cron(ctx);
    assert.equal(ctx.mock.buscas.filter((x) => x === orderId).length, 1);
  });

  test("pagamentos rejeitado e depois aprovado do mesmo pedido: conclui como pago", async () => {
    const { orderId, email } = await novoPedido(ctx);
    pagamento(ctx, orderId, { status: "approved" });
    pagamento(ctx, orderId, { status: "rejected" });
    await ctx.db.prepare("UPDATE orders SET created_at = ? WHERE id = ?").bind(agora() - 1200, orderId).run();
    await cron(ctx);
    assert.equal((await pedidoNoBanco(ctx, orderId)).status, "paid");
    assert.equal(emailsPara(ctx, email).length, 1);
  });
});

/* ===================================================================== Marca em URL */
describe("Nenhuma URL com a sigla é apresentada ao comprador (DOWNLOAD_ORIGIN)", () => {
  test("origem inválida ou com a sigla: catálogo vazio, checkout 503 e nada é entregue", async () => {
    for (const origem of ["", "https://arquivos.accs-site.test", "https://accs.exemplo.test", "https://exemplo.test/accs", "https://exemplo.test/caminho", "http://exemplo.test", "ftp://exemplo.test", "nao-e-url"]) {
      const c = await iniciar({ DOWNLOAD_ORIGIN: origem });
      try {
        assert.deepEqual((await (await req(c.mf, "/api/catalogo")).json()).produtos, [], `catálogo com "${origem}"`);
        assert.equal((await postJson(c.mf, "/api/checkout", { slug: "livro-teste", email: "a@exemplo.com" })).status, 503, `checkout com "${origem}"`);
        assert.equal((await (await req(c.mf, "/health")).json()).checkout, false);
        assert.equal(c.mock.preferencias.length, 0, "não cria preferência sem poder entregar");
      } finally { await c.mf.dispose(); }
    }
  });

  test("pagamento aprovado com origem inválida NÃO entrega e responde 5xx (para não perder o pedido)", async () => {
    const c = await iniciar({ DOWNLOAD_ORIGIN: "https://arquivos.accs-site.test" });
    try {
      const { orderId } = await (async () => {
        // o pedido precisa existir: cria com uma origem válida no banco e processa com a inválida
        await c.db.prepare("INSERT INTO orders (id, slug, email, amount_cents, status, created_at, updated_at) VALUES ('ped-x', 'livro-teste', 'x@exemplo.com', 4990, 'created', ?, ?)").bind(agora(), agora()).run();
        return { orderId: "ped-x" };
      })();
      const p = pagamento(c, orderId);
      assert.equal((await webhook(c.mf, p.id)).status, 500);
      assert.equal(c.mock.emails.length, 0);
    } finally { await c.mf.dispose(); }
  });

  test("origens válidas: https neutro e localhost; todas as URLs do e-mail usam só essa origem e nenhuma contém a sigla", async () => {
    for (const origem of ["https://arquivos.exemplo.test", "http://localhost:8787", "https://downloads.editora-exemplo.com.br"]) {
      const c = await iniciar({ DOWNLOAD_ORIGIN: origem, SUPPORT_EMAIL: "consultoria.accs@gmail.com" });
      try {
        assert.equal((await (await req(c.mf, "/health")).json()).checkout, true);
        const { orderId, email } = await novoPedido(c);
        await webhook(c.mf, pagamento(c, orderId).id);
        const [mail] = emailsPara(c, email);
        const urls = [...(mail.html + mail.text).matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
        assert.ok(urls.length >= 4, "links presentes");
        for (const u of urls) {
          assert.ok(u.startsWith(origem + "/d/"), `URL fora da origem de download: ${u}`);
          assert.ok(!/accs/i.test(u), `sigla em URL apresentada ao comprador: ${u}`);
        }
      } finally { await c.mf.dispose(); }
    }
  });
});

/* ===================================================================== B4 */
describe("B4 — tokens e dados pessoais fora dos logs", () => {
  test("uma compra, entrega e download completos não deixam token, e-mail do comprador nem link nos logs reais do Worker", async () => {
    const linhas = [];
    const ctx = await iniciar({}, novoMock(), {
      handleRuntimeStdio(stdout, stderr) {
        for (const s of [stdout, stderr]) s.on("data", (d) => linhas.push(String(d)));
      }
    });
    try {
      const c = await comprarEEntregar(ctx);
      await req(ctx.mf, `/d/${c.token}/0`);
      await req(ctx.mf, `/d/${c.token}/1`);
      await req(ctx.mf, `/d/${c.token}/0`); // 410: limite
      c.pag.status = "refunded";
      await webhook(ctx.mf, c.pag.id);
      await cron(ctx);
      await new Promise((r) => setTimeout(r, 300));
      const logs = linhas.join("\n");
      assert.match(logs, /entrega_concluida/, "sanidade: os logs do Worker foram capturados");
      assert.ok(!logs.includes(c.token), "o token apareceu nos logs");
      assert.ok(!logs.includes(c.email), "o e-mail do comprador apareceu nos logs");
      assert.ok(!/\/d\/[A-Za-z0-9_-]{20,}/.test(logs), "um link de download apareceu nos logs");
      assert.ok(!logs.includes(DOWNLOAD), "a origem de download apareceu nos logs");
    } finally { await ctx.mf.dispose(); }
  });

  test("estático: só util.js chama console.log e nenhum log recebe token, URL da requisição ou e-mail", () => {
    const dir = new URL("../src/", import.meta.url);
    for (const arq of readdirSync(dir)) {
      const fonte = readFileSync(new URL(arq, dir), "utf8");
      if (arq !== "util.js") assert.ok(!/console\.(log|info|warn|error)/.test(fonte), `${arq} chama console diretamente`);
      for (const chamada of fonte.match(/\blog\("[^"]+"[^)]*\)/g) || []) {
        // só as EXPRESSÕES importam: rótulos de texto entre aspas (ex.: alvo: "email") não carregam dados
        const expressoes = chamada.replace(/"[^"]*"/g, '""');
        assert.ok(!/\btoken\b|request\.url|\burl\b|\bemail\b|pedido\.email|\.email\b/.test(expressoes), `log suspeito em ${arq}: ${chamada}`);
      }
    }
  });
});

/* ===================================================================== B8 */
describe("B8 — retenção de dados pessoais", () => {
  test("a manutenção apaga o que nunca foi pedido, expira limites e anonimiza e-mails sem tocar no histórico financeiro", async () => {
    const ctx = await iniciar({ RETENTION_UNPAID_DAYS: "1", RETENTION_PERSONAL_DATA_DAYS: "2" });
    try {
      const dia = 86400; const t = agora();
      await semear(ctx, { id: "nunca-iniciado-antigo", email: "a@exemplo.com", status: "created", created_at: t - 3 * dia });
      await semear(ctx, { id: "iniciado-hoje", email: "b@exemplo.com", status: "created", created_at: t - 60 });
      await semear(ctx, { id: "rejeitado-antigo", email: "c@exemplo.com", status: "rejected", created_at: t - 3 * dia });
      await ctx.db.prepare("INSERT INTO payment_events (payment_id, status, refunded_cents, order_id, amount_cents, received_at) VALUES ('p-rej', 'rejected', 0, 'rejeitado-antigo', 4990, ?)").bind(t - 3 * dia).run();
      await semear(ctx, { id: "pago-antigo", email: "d@exemplo.com", status: "paid", payment_id: "p-1", created_at: t - 5 * dia, paid_at: t - 5 * dia, delivered_at: t - 5 * dia });
      await ctx.db.prepare("INSERT INTO payment_events (payment_id, status, refunded_cents, order_id, amount_cents, received_at) VALUES ('p-1', 'approved', 0, 'pago-antigo', 4990, ?)").bind(t - 5 * dia).run();
      await semear(ctx, { id: "pago-recente", email: "e@exemplo.com", status: "paid", payment_id: "p-2", created_at: t - dia, paid_at: t - dia, delivered_at: t - dia });
      await semear(ctx, { id: "pago-nao-entregue", email: "f@exemplo.com", status: "paid", payment_id: "p-3", created_at: t - 5 * dia, paid_at: t - 5 * dia, delivery_claim: null });
      await ctx.db.prepare("UPDATE orders SET delivery_suspended = 1 WHERE id = 'pago-nao-entregue'").run(); // fora da reentrega
      await ctx.db.prepare("INSERT INTO rate_limits (bucket, count, expires_at) VALUES ('ip:velho:1', 3, ?), ('ip:vivo:9', 1, ?)").bind(t - 10, t + 3600).run();

      const eventosAntes = (await ctx.db.prepare("SELECT COUNT(*) AS n FROM payment_events").first()).n;
      await cron(ctx);
      await cron(ctx); // idempotente

      const ids = (await ctx.db.prepare("SELECT id, email, status, amount_cents, payment_id, paid_at, anonymized_at FROM orders ORDER BY id").all()).results;
      const por = Object.fromEntries(ids.map((o) => [o.id, o]));
      assert.ok(!por["nunca-iniciado-antigo"], "pedido que nunca chegou a existir para o financeiro foi apagado");
      assert.equal(por["iniciado-hoje"].email, "b@exemplo.com", "pedido recente intacto");
      assert.equal(por["rejeitado-antigo"].email, "anonimizado", "e-mail anonimizado");
      assert.equal(por["rejeitado-antigo"].status, "rejected", "mas o pedido permanece (tem histórico de pagamento)");
      assert.equal(por["pago-antigo"].email, "anonimizado");
      assert.equal(por["pago-antigo"].amount_cents, 4990);
      assert.equal(por["pago-antigo"].payment_id, "p-1");
      assert.equal(por["pago-antigo"].status, "paid");
      assert.ok(por["pago-antigo"].paid_at && por["pago-antigo"].anonymized_at);
      assert.equal(por["pago-recente"].email, "e@exemplo.com", "dentro do prazo de retenção");
      assert.equal(por["pago-nao-entregue"].email, "f@exemplo.com", "não anonimiza enquanto a entrega estiver pendente");
      assert.equal((await ctx.db.prepare("SELECT COUNT(*) AS n FROM payment_events").first()).n, eventosAntes, "histórico de pagamentos intacto");
      const limites = (await ctx.db.prepare("SELECT bucket FROM rate_limits").all()).results.map((l) => l.bucket);
      assert.deepEqual(limites, ["ip:vivo:9"], "limites expirados foram removidos");
    } finally { await ctx.mf.dispose(); }
  });

  test("os padrões de retenção estão documentados e configurados (30 dias sem pagamento; 5 anos para dados pessoais)", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    assert.equal((toml.match(/RETENTION_UNPAID_DAYS = "30"/g) || []).length, 2);
    assert.equal((toml.match(/RETENTION_PERSONAL_DATA_DAYS = "1825"/g) || []).length, 2);
    const doc = readFileSync(new URL("../../CHECKOUT.md", import.meta.url), "utf8");
    assert.match(doc, /RETENTION_PERSONAL_DATA_DAYS/);
  });
});

/* ===================================================================== B10 / nomes */
describe("B10 e padronização — ambientes separados e nomes decididos", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const secao = (nome) => {
    const partes = toml.split(/^(?=\[{1,2}[^\]]+\]{1,2}\s*$)/m).filter((s) => s.startsWith(`[${nome}]`) || s.startsWith(`[[${nome}]]`));
    return partes.join("\n");
  };

  test("produção: Worker, D1 e R2 com os nomes decididos e bindings DB e BUCKET", () => {
    assert.match(secao("env.producao"), /name = "accs-checkout"/);
    const d1 = secao("env.producao.d1_databases");
    assert.match(d1, /binding = "DB"/);
    assert.match(d1, /database_name = "accs-checkout-db"/);
    const r2 = secao("env.producao.r2_buckets");
    assert.match(r2, /binding = "BUCKET"/);
    assert.match(r2, /bucket_name = "accs-checkout-files"/);
  });

  test("homologação: recursos próprios, distintos e neutros (sem a sigla), com MP_ENV de teste", () => {
    assert.match(secao("env.homologacao"), /name = "pub-checkout-homolog"/);
    assert.match(secao("env.homologacao.d1_databases"), /database_name = "pub-checkout-db-homolog"/);
    assert.match(secao("env.homologacao.r2_buckets"), /bucket_name = "pub-checkout-files-homolog"/);
    assert.match(secao("env.homologacao.r2_buckets"), /binding = "BUCKET"/);
    assert.match(secao("env.homologacao.vars"), /MP_ENV = "test"/);
    assert.match(secao("env.producao.vars"), /MP_ENV = "prod"/);
    const homolog = secao("env.homologacao") + secao("env.homologacao.d1_databases") + secao("env.homologacao.r2_buckets");
    assert.ok(!/name = "[^"]*accs/i.test(homolog), "nomes de homologação não devem conter a sigla");
  });

  test("o topo do arquivo não define bindings nem variáveis (deploy sem --env não publica nada utilizável)", () => {
    const topo = toml.split(/^\[env\./m)[0].split(/^\[\[?env\./m)[0];
    assert.ok(!/\[\[d1_databases\]\]|\[\[r2_buckets\]\]|\[vars\]/.test(topo.replace(/^#.*$/gm, "")));
  });

  test("registro de requisições desativado, manutenção agendada e checkout desligado por padrão nos dois ambientes", () => {
    assert.equal((toml.match(/^enabled = false/gm) || []).length, 3);
    assert.equal((toml.match(/crons = \["\*\/10 \* \* \* \*"\]/g) || []).length, 2);
    assert.equal((toml.match(/^DOWNLOAD_ORIGIN = ""$/gm) || []).length, 2, "sem origem neutra configurada o checkout fica desativado");
    assert.equal((toml.match(/^CATALOG_JSON = "\[\]"$/gm) || []).length, 2, "nenhum preço embutido");
  });

  test("não restam referências ao binding antigo FILES nem aos nomes antigos de recursos", () => {
    const arquivos = ["../wrangler.toml", "../schema.sql", "../src/index.js", "../src/pedidos.js", "../src/manutencao.js", "../test/helpers.mjs", "../test/e2e-navegador.mjs", "../../CHECKOUT.md"];
    for (const a of arquivos) {
      const texto = readFileSync(new URL(a, import.meta.url), "utf8");
      assert.ok(!/\bFILES\b/.test(texto), `FILES em ${a}`);
      assert.ok(!/publicacoes-privadas|d1 create checkout\b|d1 execute checkout\b|r2 bucket create publicacoes/.test(texto), `nome antigo em ${a}`);
    }
    assert.match(readFileSync(new URL("../src/index.js", import.meta.url), "utf8"), /env\.BUCKET\.get/);
  });

  test("a documentação traz os comandos com os nomes decididos e a separação de segredos por ambiente", () => {
    const doc = readFileSync(new URL("../../CHECKOUT.md", import.meta.url), "utf8");
    for (const trecho of ["accs-checkout-db", "accs-checkout-files", "--env producao", "--env homologacao", "pub-checkout-db-homolog"]) {
      assert.ok(doc.includes(trecho), `CHECKOUT.md sem "${trecho}"`);
    }
  });

  test("segredos nunca são variáveis, e o parcelamento padrão do Mercado Pago é preservado (sem installments no código)", () => {
    assert.ok(!/(MP_ACCESS_TOKEN|MP_WEBHOOK_SECRET|RESEND_API_KEY)\s*=/.test(toml));
    for (const arq of readdirSync(new URL("../src/", import.meta.url))) {
      assert.ok(!/installments/.test(readFileSync(new URL(`../src/${arq}`, import.meta.url), "utf8")), `installments em ${arq}`);
    }
  });
});
