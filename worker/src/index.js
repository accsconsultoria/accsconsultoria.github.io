import { carregarCatalogo } from "./catalog.js";
import { enviarEntrega } from "./email.js";
import { consultarPagamento, criarPreferencia, validarAssinatura } from "./mp.js";
import { brl, corsHeaders, emailValido, intVar, json, log, now, randomToken, sha256Hex } from "./util.js";

const STATUS_PENDENTE = ["pending", "in_process", "authorized", "in_mediation"];
const MAX_CORPO = 4096;

/* ---------- Pedidos e entrega ---------- */

const revogarLinks = (env, orderId) =>
  env.DB.prepare("UPDATE download_links SET revoked = 1 WHERE order_id = ?").bind(orderId).run();

/* Só um processo por vez entrega o pedido. Cobre webhooks simultâneos e repetidos. */
const reivindicarEntrega = async (env, orderId) => {
  const agora = now();
  const r = await env.DB.prepare(
    `UPDATE orders SET delivery_claim = ?, updated_at = ?
       WHERE id = ? AND status = 'paid' AND delivered_at IS NULL
         AND (delivery_claim IS NULL OR delivery_claim < ?)`
  ).bind(agora, agora, orderId, agora - 60).run();
  return r.meta.changes === 1;
};

const entregar = async (env, pedido) => {
  if (!(await reivindicarEntrega(env, pedido.id))) return false;
  try {
    const produto = carregarCatalogo(env).get(pedido.slug);
    if (!produto) throw new Error(`Produto ${pedido.slug} não está mais no catálogo`);

    await revogarLinks(env, pedido.id); // tentativas anteriores sem e-mail enviado
    const token = randomToken();
    const agora = now();
    await env.DB.prepare(
      `INSERT INTO download_links (id, order_id, token_hash, expires_at, max_downloads, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), pedido.id, await sha256Hex(token),
      agora + intVar(env.LINK_TTL_HOURS, 168) * 3600, intVar(env.MAX_DOWNLOADS, 5), agora
    ).run();

    await enviarEntrega(env, { pedido, produto, token });
    await env.DB.prepare("UPDATE orders SET delivered_at = ?, updated_at = ? WHERE id = ?").bind(now(), now(), pedido.id).run();
    log("entrega_concluida", { pedido: pedido.id });
    return true;
  } catch (erro) {
    // libera para nova tentativa (o Mercado Pago repete o webhook em caso de erro 5xx)
    await env.DB.prepare("UPDATE orders SET delivery_claim = NULL WHERE id = ?").bind(pedido.id).run();
    throw erro;
  }
};

const transicao = (env, orderId, novo, de, extra = "", binds = []) =>
  env.DB.prepare(
    `UPDATE orders SET status = ?, updated_at = ?${extra} WHERE id = ? AND status IN (${de.map(() => "?").join(",")})`
  ).bind(novo, now(), ...binds, orderId, ...de).run();

/* Aplica o estado de um pagamento JÁ consultado no Mercado Pago. Idempotente. */
export const processarPagamento = async (env, pagamento) => {
  const pedido = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(String(pagamento.external_reference || "")).first();
  if (!pedido) {
    log("pedido_desconhecido", { pagamento: pagamento.id });
    return "pedido_desconhecido";
  }

  const centavos = Math.round(Number(pagamento.transaction_amount) * 100);
  if (pagamento.currency_id !== "BRL" || centavos !== pedido.amount_cents) {
    log("valor_divergente", { pedido: pedido.id, pagamento: pagamento.id, recebido: centavos, esperado: pedido.amount_cents });
    return "valor_divergente";
  }

  const paymentId = String(pagamento.id);
  const status = String(pagamento.status);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO payment_events (payment_id, status, detail, received_at) VALUES (?, ?, ?, ?)"
  ).bind(paymentId, status, String(pagamento.status_detail || ""), now()).run();

  if (status === "approved") {
    if (["created", "pending", "rejected"].includes(pedido.status)) {
      const r = await transicao(env, pedido.id, "paid", ["created", "pending", "rejected"], ", payment_id = ?, paid_at = ?", [paymentId, now()]);
      if (r.meta.changes === 1) await entregar(env, pedido);
      return "aprovado";
    }
    if (pedido.status === "paid") {
      if (pedido.payment_id !== paymentId) {
        log("pagamento_duplicado", { pedido: pedido.id, pagamento: paymentId }); // exige reembolso manual
        return "pagamento_duplicado";
      }
      if (!pedido.delivered_at) await entregar(env, pedido);
      return "aprovado";
    }
    return "ignorado";
  }

  if (STATUS_PENDENTE.includes(status)) {
    await transicao(env, pedido.id, "pending", ["created"]);
    return "pendente";
  }
  if (status === "rejected") {
    await transicao(env, pedido.id, "rejected", ["created", "pending"]);
    return "rejeitado";
  }
  if (["cancelled", "refunded", "charged_back"].includes(status)) {
    if (pedido.status === "paid" && pedido.payment_id === paymentId) {
      await transicao(env, pedido.id, status, ["paid"]);
      await revogarLinks(env, pedido.id);
      log("acesso_revogado", { pedido: pedido.id, motivo: status });
      return "revogado";
    }
    if (status === "cancelled") await transicao(env, pedido.id, "cancelled", ["created", "pending"]);
    return "encerrado";
  }
  return "ignorado";
};

/* ---------- Rotas ---------- */

const lerJson = async (request) => {
  const texto = await request.text();
  if (texto.length > MAX_CORPO) return null;
  try { return JSON.parse(texto); } catch { return null; }
};

const rotaCatalogo = (env, cors) => {
  const produtos = [...carregarCatalogo(env).values()].map((p) => ({ slug: p.slug, priceCents: p.priceCents, price: brl(p.priceCents) }));
  return json({ produtos }, 200, { ...cors, "Cache-Control": "public, max-age=60" });
};

const rotaCheckout = async (request, env, cors) => {
  const corpo = await lerJson(request);
  const slug = String(corpo?.slug || "").trim();
  const email = String(corpo?.email || "").trim().toLowerCase();
  if (!emailValido(email)) return json({ erro: "email_invalido" }, 400, cors);

  const produto = carregarCatalogo(env).get(slug); // preço SEMPRE do servidor; qualquer valor enviado é ignorado
  if (!produto) return json({ erro: "produto_indisponivel" }, 404, cors);

  const pedido = { id: crypto.randomUUID(), slug, email, amount_cents: produto.priceCents };
  const agora = now();
  await env.DB.prepare(
    "INSERT INTO orders (id, slug, email, amount_cents, currency, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'BRL', 'created', ?, ?)"
  ).bind(pedido.id, slug, email, pedido.amount_cents, agora, agora).run();

  try {
    const preferencia = await criarPreferencia(env, { pedido, produto });
    await env.DB.prepare("UPDATE orders SET preference_id = ?, updated_at = ? WHERE id = ?").bind(preferencia.id, now(), pedido.id).run();
    return json({ url: preferencia.url }, 200, cors);
  } catch (erro) {
    log("preferencia_falhou", { pedido: pedido.id, erro: String(erro.message) });
    return json({ erro: "falha_no_checkout" }, 502, cors);
  }
};

const rotaWebhook = async (request, env, url) => {
  if (!(await validarAssinatura(env, request, url))) {
    log("assinatura_invalida");
    return json({ erro: "assinatura_invalida" }, 401);
  }
  const tipo = url.searchParams.get("type") || url.searchParams.get("topic");
  if (tipo && tipo !== "payment") return json({ ok: true, ignorado: tipo });

  const paymentId = url.searchParams.get("data.id"); // o mesmo valor coberto pela assinatura
  if (!paymentId) return json({ erro: "sem_pagamento" }, 400);

  const pagamento = await consultarPagamento(env, paymentId); // nunca confiar no corpo recebido
  if (!pagamento) return json({ ok: true, ignorado: "pagamento_inexistente" });

  try {
    const resultado = await processarPagamento(env, pagamento);
    return json({ ok: true, resultado });
  } catch (erro) {
    log("webhook_falhou", { pagamento: paymentId, erro: String(erro.message) });
    return json({ erro: "tente_novamente" }, 500); // o Mercado Pago repete a notificação
  }
};

const nomeSeguro = (texto) => String(texto || "arquivo").replace(/[^\w.\- ]+/g, "").trim().slice(0, 80) || "arquivo";

const rotaDownload = async (env, token, indice) => {
  const gone = () => new Response("Link indisponível ou expirado.", { status: 410, headers: { "Cache-Control": "no-store" } });
  const linha = await env.DB.prepare(
    `SELECT l.id, l.expires_at, l.revoked, o.status, o.slug
       FROM download_links l JOIN orders o ON o.id = l.order_id WHERE l.token_hash = ?`
  ).bind(await sha256Hex(token)).first();
  if (!linha) return new Response("Não encontrado.", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (linha.revoked || linha.status !== "paid" || linha.expires_at <= now()) return gone();

  const arquivo = carregarCatalogo(env).get(linha.slug)?.files[indice];
  if (!arquivo) return new Response("Não encontrado.", { status: 404 });

  const reservado = await env.DB.prepare(
    `UPDATE download_links SET downloads = downloads + 1
       WHERE id = ? AND revoked = 0 AND expires_at > ? AND downloads < max_downloads`
  ).bind(linha.id, now()).run();
  if (reservado.meta.changes !== 1) return gone();

  const objeto = await env.FILES.get(arquivo.key);
  if (!objeto) {
    await env.DB.prepare("UPDATE download_links SET downloads = downloads - 1 WHERE id = ?").bind(linha.id).run();
    log("arquivo_ausente", { chave: arquivo.key });
    return new Response("Arquivo indisponível no momento.", { status: 503 });
  }
  return new Response(objeto.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${nomeSeguro(arquivo.name)}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    }
  });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/api/catalogo" && request.method === "GET") return rotaCatalogo(env, cors);
      if (url.pathname === "/api/checkout" && request.method === "POST") return await rotaCheckout(request, env, cors);
      if (url.pathname === "/webhook/mercadopago" && request.method === "POST") return await rotaWebhook(request, env, url);
      const m = url.pathname.match(/^\/d\/([\w-]{20,})(?:\/(\d{1,3}))?$/);
      if (m && request.method === "GET") return await rotaDownload(env, m[1], Number(m[2] || 0));
      if (url.pathname === "/health") return json({ ok: true });
      return json({ erro: "nao_encontrado" }, 404, cors);
    } catch (erro) {
      log("erro_interno", { erro: String(erro.message) });
      return json({ erro: "erro_interno" }, 500, cors);
    }
  }
};
