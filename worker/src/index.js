import { carregarCatalogo } from "./catalog.js";
import { chaveHash, consumir } from "./limite.js";
import { manutencao } from "./manutencao.js";
import { consultarPagamento, criarPreferencia, validarAssinatura } from "./mp.js";
import { EntregaPendente, processarPagamento } from "./pedidos.js";
import {
  ErroConfiguracao, brl, corsHeaders, emailValido, intVar, json, log, now, origemDownload, sha256Hex
} from "./util.js";

const MAX_CORPO = 4096;

/* ---------- Utilidades de rota ---------- */

const lerJson = async (request) => {
  const texto = await request.text();
  if (texto.length > MAX_CORPO) return null;
  try { return JSON.parse(texto); } catch { return null; }
};

/* Só vende se for possível entregar com um link neutro: caso contrário o checkout fica desativado. */
const checkoutDisponivel = (env) => Boolean(origemDownload(env));

/* ---------- Rotas ---------- */

const rotaCatalogo = (env, cors) => {
  const produtos = checkoutDisponivel(env)
    ? [...carregarCatalogo(env).values()].map((p) => ({ slug: p.slug, priceCents: p.priceCents, price: brl(p.priceCents) }))
    : [];
  return json({ produtos }, 200, { ...cors, "Cache-Control": "public, max-age=60" });
};

const rotaCheckout = async (request, env) => {
  // 1) Somente o site: requisição de outra origem (ou sem Origin) é recusada, sem cabeçalhos CORS.
  if (request.headers.get("Origin") !== env.SITE_ORIGIN) return json({ erro: "origem_nao_permitida" }, 403);
  const cors = corsHeaders(env, request);

  // 2) Somente JSON declarado (força preflight em navegadores) e corpo pequeno.
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("Content-Type") || "")) {
    return json({ erro: "tipo_de_conteudo_invalido" }, 415, cors);
  }
  if (Number(request.headers.get("Content-Length") || 0) > MAX_CORPO) return json({ erro: "corpo_muito_grande" }, 413, cors);
  if (!checkoutDisponivel(env)) return json({ erro: "checkout_indisponivel" }, 503, cors);

  const corpo = await lerJson(request);
  const slug = String(corpo?.slug || "").trim();
  const email = String(corpo?.email || "").trim().toLowerCase();
  if (!emailValido(email)) return json({ erro: "email_invalido" }, 400, cors);

  const produto = carregarCatalogo(env).get(slug); // preço SEMPRE do servidor; qualquer valor enviado é ignorado
  if (!produto) return json({ erro: "produto_indisponivel" }, 404, cors);

  // 3) Limitação de requisições, só para tentativas que criariam pedido (por IP e por e-mail).
  const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
  const porIp = await consumir(env, await chaveHash("ip", ip), intVar(env.RATE_IP_MAX, 10), intVar(env.RATE_IP_WINDOW_SECONDS, 600));
  const porEmail = porIp.permitido
    ? await consumir(env, await chaveHash("em", email), intVar(env.RATE_EMAIL_MAX, 5), intVar(env.RATE_EMAIL_WINDOW_SECONDS, 3600))
    : porIp;
  if (!porIp.permitido || !porEmail.permitido) {
    const espera = !porIp.permitido ? porIp.reiniciaEm : porEmail.reiniciaEm;
    log("limite_excedido", { alvo: !porIp.permitido ? "ip" : "email" });
    return json({ erro: "muitas_tentativas" }, 429, { ...cors, "Retry-After": String(espera) });
  }

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

  try {
    const pagamento = await consultarPagamento(env, paymentId); // nunca confiar no corpo recebido
    if (!pagamento) return json({ ok: true, ignorado: "pagamento_inexistente" });
    const resultado = await processarPagamento(env, pagamento);
    return json({ ok: true, resultado });
  } catch (erro) {
    if (erro instanceof EntregaPendente) {
      log("entrega_pendente", { pagamento: paymentId });
      return json({ erro: "entrega_pendente" }, 503); // não confirma sucesso: o Mercado Pago repete
    }
    log("webhook_falhou", { pagamento: paymentId, configuracao: erro instanceof ErroConfiguracao, erro: String(erro.message) });
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

  const objeto = await env.BUCKET.get(arquivo.key);
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
      if (url.pathname === "/api/checkout" && request.method === "POST") return await rotaCheckout(request, env);
      if (url.pathname === "/webhook/mercadopago" && request.method === "POST") return await rotaWebhook(request, env, url);
      const m = url.pathname.match(/^\/d\/([A-Za-z0-9_-]{43})(?:\/(\d{1,3}))?$/);
      if (m && request.method === "GET") return await rotaDownload(env, m[1], Number(m[2] || 0));
      if (url.pathname === "/health") return json({ ok: true, checkout: checkoutDisponivel(env) });
      return json({ erro: "nao_encontrado" }, 404, cors);
    } catch (erro) {
      log("erro_interno", { erro: String(erro.message) });
      return json({ erro: "erro_interno" }, 500, cors);
    }
  },

  async scheduled(_evento, env) {
    await manutencao(env);
  }
};
