import { buscarPagamentos } from "./mp.js";
import { EntregaPendente, entregar, processarPagamento } from "./pedidos.js";
import { intVar, log, now } from "./util.js";

/* Rotina agendada (cron). Cada etapa é isolada: a falha de uma não impede as demais.
   1) Reentrega: pedidos pagos cuja entrega foi interrompida (processo encerrado, e-mail fora do ar).
   2) Reconciliação: pedidos sem desfecho cujo webhook não chegou (consulta o Mercado Pago).
   3) Retenção: expira limites de requisição, apaga pedidos nunca iniciados e anonimiza dados pessoais.
   O histórico financeiro (payment_events e valores/datas dos pedidos) NUNCA é apagado. */

const LOTE = 20;
const ORDEM_STATUS = { rejected: 0, cancelled: 0, pending: 1, in_process: 1, authorized: 1, in_mediation: 2, approved: 3, refunded: 4, charged_back: 5 };

const etapa = async (nome, resumo, fn) => {
  try {
    await fn();
  } catch (erro) {
    log("manutencao_falhou", { etapa: nome, erro: String(erro.message) });
    resumo.falhas.push(nome);
  }
};

const reentregas = async (env, resumo) => {
  const { results } = await env.DB.prepare(
    `SELECT id FROM orders
       WHERE status = 'paid' AND delivered_at IS NULL AND delivery_suspended = 0 AND paid_at < ?
       ORDER BY paid_at LIMIT ${LOTE}`
  ).bind(now() - 120).all();
  for (const { id } of results) {
    try {
      if ((await entregar(env, id)) === "entregue") resumo.reentregas += 1;
    } catch (erro) {
      log("reentrega_falhou", { pedido: id, erro: String(erro.message) });
    }
  }
};

const reconciliar = async (env, resumo) => {
  const agora = now();
  const { results } = await env.DB.prepare(
    `SELECT id FROM orders
       WHERE status IN ('created', 'pending') AND created_at < ? AND created_at > ?
         AND (last_reconcile IS NULL OR last_reconcile < ?)
       ORDER BY created_at LIMIT ${LOTE}`
  ).bind(agora - 600, agora - 7 * 86400, agora - 3600).all();

  for (const { id } of results) {
    await env.DB.prepare("UPDATE orders SET last_reconcile = ? WHERE id = ?").bind(agora, id).run();
    try {
      const pagamentos = (await buscarPagamentos(env, id)).sort(
        (a, b) => (ORDEM_STATUS[a.status] ?? 1) - (ORDEM_STATUS[b.status] ?? 1)
      );
      for (const pagamento of pagamentos) {
        try {
          await processarPagamento(env, pagamento);
        } catch (erro) {
          if (!(erro instanceof EntregaPendente)) throw erro;
        }
      }
      resumo.reconciliados += 1;
    } catch (erro) {
      log("reconciliacao_falhou", { pedido: id, erro: String(erro.message) });
    }
  }
};

const retencao = async (env, resumo) => {
  const agora = now();
  const naoPagoAte = agora - intVar(env.RETENTION_UNPAID_DAYS, 30) * 86400;
  const dadosPessoaisAte = agora - intVar(env.RETENTION_PERSONAL_DATA_DAYS, 1825) * 86400;

  await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(agora).run();

  // Pedidos que nunca chegaram a ter pagamento: não são histórico financeiro e saem por inteiro.
  const apagados = await env.DB.prepare(
    `DELETE FROM orders
       WHERE status = 'created' AND paid_at IS NULL AND payment_id IS NULL AND created_at < ?
         AND NOT EXISTS (SELECT 1 FROM payment_events e WHERE e.order_id = orders.id)`
  ).bind(naoPagoAte).run();
  resumo.apagados = apagados.meta.changes;

  // Dados pessoais (e-mail): anonimizados, mantendo valores, datas, status e histórico de pagamentos.
  const anonimizados = await env.DB.prepare(
    `UPDATE orders SET email = 'anonimizado', anonymized_at = ?, updated_at = ?
       WHERE anonymized_at IS NULL
         AND ( (paid_at IS NULL AND created_at < ?)
            OR (paid_at IS NOT NULL AND delivered_at IS NOT NULL AND paid_at < ?) )`
  ).bind(agora, agora, naoPagoAte, dadosPessoaisAte).run();
  resumo.anonimizados = anonimizados.meta.changes;
};

export const manutencao = async (env) => {
  const resumo = { reentregas: 0, reconciliados: 0, apagados: 0, anonimizados: 0, falhas: [] };
  await etapa("reentrega", resumo, () => reentregas(env, resumo));
  await etapa("reconciliacao", resumo, () => reconciliar(env, resumo));
  await etapa("retencao", resumo, () => retencao(env, resumo));
  log("manutencao_concluida", resumo);
  return resumo;
};
