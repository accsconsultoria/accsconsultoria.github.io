import { carregarCatalogo } from "./catalog.js";
import { enviarEntrega } from "./email.js";
import { ErroConfiguracao, intVar, log, now, origemDownload, sha256Hex, tokenDeEntrega } from "./util.js";

/* Entrega em andamento por outro processo: o webhook deve responder 5xx para o Mercado Pago repetir. */
export class EntregaPendente extends Error {}

const STATUS_PENDENTE = ["pending", "in_process", "authorized"];

/* ---------- Estados do pedido ---------- */

const transicao = (env, orderId, novo, de, extra = "", binds = []) =>
  env.DB.prepare(
    `UPDATE orders SET status = ?, updated_at = ?${extra} WHERE id = ? AND status IN (${de.map(() => "?").join(",")})`
  ).bind(novo, now(), ...binds, orderId, ...de).run();

export const revogarLinks = (env, orderId) =>
  env.DB.prepare("UPDATE download_links SET revoked = 1 WHERE order_id = ?").bind(orderId).run();

const obterPedido = (env, orderId) => env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();

/* Marca o pedido para análise do proprietário (nunca apaga nada). */
const marcarRevisao = (env, orderId, motivo) =>
  env.DB.prepare(
    "UPDATE orders SET review_status = 'needs_review', review_reason = ?, updated_at = ? WHERE id = ?"
  ).bind(motivo, now(), orderId).run();

/* Disputa: registra, sinaliza para análise e suspende NOVAS entregas. Links já enviados não são revogados. */
const suspenderEntrega = (env, orderId, motivo) =>
  env.DB.prepare(
    `UPDATE orders SET delivery_suspended = 1, review_status = 'needs_review', review_reason = ?, updated_at = ?
       WHERE id = ?`
  ).bind(motivo, now(), orderId).run();

const registrarEvento = (env, pedido, pagamento, reembolsadoCents) =>
  env.DB.prepare(
    `INSERT OR IGNORE INTO payment_events
       (payment_id, status, refunded_cents, order_id, amount_cents, detail, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    String(pagamento.id), String(pagamento.status), reembolsadoCents, pedido.id, pedido.amount_cents,
    String(pagamento.status_detail || ""), now()
  ).run();

/* ---------- Entrega ---------- */

/* Só um processo por vez entrega o pedido. A reivindicação expira em 60 s, o que permite recuperar
   uma entrega interrompida (processo encerrado no meio) sem intervenção manual. */
const reivindicarEntrega = async (env, orderId) => {
  const agora = now();
  const r = await env.DB.prepare(
    `UPDATE orders SET delivery_claim = ?, updated_at = ?
       WHERE id = ? AND status = 'paid' AND delivered_at IS NULL AND delivery_suspended = 0
         AND (delivery_claim IS NULL OR delivery_claim < ?)`
  ).bind(agora, agora, orderId, agora - 60).run();
  return r.meta.changes === 1;
};

const liberarReivindicacao = (env, orderId) =>
  env.DB.prepare("UPDATE orders SET delivery_claim = NULL WHERE id = ?").bind(orderId).run();

/* Resultado: "entregue" | "ja_entregue" | "suspensa" | "em_andamento" | "indisponivel".
   Idempotente: o link é determinístico e o e-mail usa chave de idempotência fixa por pedido. */
export const entregar = async (env, orderId) => {
  if (!origemDownload(env)) throw new ErroConfiguracao("DOWNLOAD_ORIGIN ausente ou inválido");

  const atual = await obterPedido(env, orderId);
  if (!atual || atual.status !== "paid") return "indisponivel";
  if (atual.delivered_at) return "ja_entregue";
  if (atual.delivery_suspended) return "suspensa";

  if (!(await reivindicarEntrega(env, orderId))) {
    const depois = await obterPedido(env, orderId);
    if (depois?.delivered_at) return "ja_entregue";
    if (depois?.delivery_suspended) return "suspensa";
    return "em_andamento";
  }

  try {
    const produto = carregarCatalogo(env).get(atual.slug);
    if (!produto) throw new ErroConfiguracao(`Produto ${atual.slug} não está mais no catálogo`);

    const token = await tokenDeEntrega(env, orderId);
    const agora = now();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO download_links (id, order_id, token_hash, expires_at, max_downloads, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), orderId, await sha256Hex(token),
      agora + intVar(env.LINK_TTL_HOURS, 168) * 3600, intVar(env.MAX_DOWNLOADS, 5), agora
    ).run();

    // Disputa aberta entre a reivindicação e o envio: não entrega.
    const recheck = await obterPedido(env, orderId);
    if (recheck.delivery_suspended || recheck.status !== "paid") {
      await liberarReivindicacao(env, orderId);
      return "suspensa";
    }

    await enviarEntrega(env, { pedido: atual, produto, token });
    await env.DB.prepare("UPDATE orders SET delivered_at = ?, updated_at = ? WHERE id = ?").bind(now(), now(), orderId).run();
    log("entrega_concluida", { pedido: orderId });
    return "entregue";
  } catch (erro) {
    await liberarReivindicacao(env, orderId); // permite nova tentativa (webhook repetido ou manutenção)
    throw erro;
  }
};

/* ---------- Pagamentos ---------- */

/* Aplica o estado de um pagamento JÁ consultado no Mercado Pago. Idempotente. */
export const processarPagamento = async (env, pagamento) => {
  const pedido = await obterPedido(env, String(pagamento.external_reference || ""));
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
  const reembolsado = Math.max(0, Math.round(Number(pagamento.transaction_amount_refunded || 0) * 100));
  await registrarEvento(env, pedido, pagamento, reembolsado); // histórico financeiro (nunca apagado)

  const emailPagador = String(pagamento.payer?.email || "").trim().toLowerCase();
  if (emailPagador && emailPagador !== pedido.email) log("email_divergente", { pedido: pedido.id });

  if (status === "approved") {
    if (["created", "pending", "rejected"].includes(pedido.status)) {
      await transicao(env, pedido.id, "paid", ["created", "pending", "rejected"], ", payment_id = ?, paid_at = ?", [paymentId, now()]);
    }
    const atual = await obterPedido(env, pedido.id);

    if (atual.status === "paid") {
      if (atual.payment_id !== paymentId) {
        log("pagamento_duplicado", { pedido: pedido.id, pagamento: paymentId }); // exige reembolso manual
        await marcarRevisao(env, pedido.id, "pagamento_duplicado");
        return "pagamento_duplicado";
      }
      if (reembolsado > 0 && reembolsado < pedido.amount_cents && reembolsado > atual.refunded_cents) {
        // Reembolso parcial: registra e sinaliza para análise; NÃO revoga automaticamente.
        await env.DB.prepare("UPDATE orders SET refunded_cents = ?, updated_at = ? WHERE id = ?").bind(reembolsado, now(), pedido.id).run();
        await marcarRevisao(env, pedido.id, "reembolso_parcial");
        log("reembolso_parcial", { pedido: pedido.id, reembolsado });
      }
      const resultado = await entregar(env, pedido.id);
      if (resultado === "em_andamento") throw new EntregaPendente("entrega em andamento");
      return resultado === "suspensa" ? "entrega_suspensa" : "aprovado";
    }

    // Pagamento aprovado em pedido já encerrado (cancelado/reembolsado): dinheiro sem entrega -> análise manual.
    log("aprovado_em_pedido_encerrado", { pedido: pedido.id, pagamento: paymentId, situacao: atual.status });
    await marcarRevisao(env, pedido.id, "pagamento_aprovado_em_pedido_encerrado");
    return "aprovado_em_pedido_encerrado";
  }

  if (status === "in_mediation") {
    if (pedido.status === "paid") {
      await suspenderEntrega(env, pedido.id, "disputa_em_mediacao");
      log("disputa_registrada", { pedido: pedido.id, motivo: "in_mediation" });
      return "disputa_registrada";
    }
    await transicao(env, pedido.id, "pending", ["created"]);
    return "pendente";
  }

  if (status === "charged_back") {
    if (pedido.status === "paid" && pedido.payment_id === paymentId) {
      await suspenderEntrega(env, pedido.id, "estorno_do_cartao");
      log("disputa_registrada", { pedido: pedido.id, motivo: "charged_back" });
      return "disputa_registrada";
    }
    return "encerrado";
  }

  if (STATUS_PENDENTE.includes(status)) {
    await transicao(env, pedido.id, "pending", ["created"]);
    return "pendente";
  }

  if (status === "rejected") {
    await transicao(env, pedido.id, "rejected", ["created", "pending"]);
    return "rejeitado";
  }

  if (status === "refunded" || status === "cancelled") {
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
