import { boolVar, hmacSha256Hex, intVar, now, timingSafeEqual } from "./util.js";

const API = "https://api.mercadopago.com";

/* Tipos de pagamento do Checkout Pro que NÃO serão oferecidos.
   Ficam apenas cartão de crédito e (opcionalmente) Pix (bank_transfer). */
const tiposExcluidos = (env) => {
  const excluidos = ["ticket", "atm", "debit_card", "prepaid_card", "digital_currency", "digital_wallet"];
  if (!boolVar(env.ENABLE_PIX, true)) excluidos.push("bank_transfer");
  return excluidos.map((id) => ({ id }));
};

/* Cria a preferência de pagamento. O valor vem do catálogo do servidor.
   Parcelamento: condições padrão do Mercado Pago (nenhum número de parcelas é imposto). */
export const criarPreferencia = async (env, { pedido, produto }) => {
  const corpo = {
    items: [
      {
        id: produto.slug,
        title: produto.title,
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number((pedido.amount_cents / 100).toFixed(2))
      }
    ],
    payer: { email: pedido.email },
    external_reference: pedido.id,
    notification_url: `${env.WORKER_ORIGIN}/webhook/mercadopago`,
    back_urls: {
      success: `${env.SITE_ORIGIN}/pedido/?status=success`,
      pending: `${env.SITE_ORIGIN}/pedido/?status=pending`,
      failure: `${env.SITE_ORIGIN}/pedido/?status=failure`
    },
    auto_return: "approved",
    binary_mode: false,
    payment_methods: { excluded_payment_types: tiposExcluidos(env) }
  };

  const resposta = await fetch(`${API}/checkout/preferences`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": pedido.id
    },
    body: JSON.stringify(corpo)
  });
  if (!resposta.ok) throw new Error(`Mercado Pago recusou a preferência (HTTP ${resposta.status})`);
  const dados = await resposta.json();
  const url = env.MP_ENV === "test" && dados.sandbox_init_point ? dados.sandbox_init_point : dados.init_point;
  if (!dados.id || !url) throw new Error("Resposta inesperada do Mercado Pago ao criar a preferência");
  return { id: String(dados.id), url };
};

/* Consulta o pagamento diretamente no Mercado Pago: nunca confiar no corpo do webhook. */
export const consultarPagamento = async (env, paymentId) => {
  const resposta = await fetch(`${API}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` }
  });
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`Falha ao consultar o pagamento (HTTP ${resposta.status})`);
  return resposta.json();
};

/* Reconciliação: busca no Mercado Pago os pagamentos de um pedido (external_reference). */
export const buscarPagamentos = async (env, orderId) => {
  const url = `${API}/v1/payments/search?external_reference=${encodeURIComponent(orderId)}&sort=date_created&criteria=asc&limit=20`;
  const resposta = await fetch(url, { headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` } });
  if (!resposta.ok) throw new Error(`Falha na busca de pagamentos (HTTP ${resposta.status})`);
  const dados = await resposta.json();
  return Array.isArray(dados.results) ? dados.results : [];
};

/* Validação da assinatura do webhook (cabeçalho x-signature):
   manifesto = "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" assinado com HMAC-SHA256.
   Além do HMAC, o timestamp assinado precisa estar dentro da janela de tolerância
   (WEBHOOK_TOLERANCE_SECONDS, padrão 900 s), o que impede a reutilização de notificações antigas. */
export const validarAssinatura = async (env, request, url) => {
  const cabecalho = request.headers.get("x-signature") || "";
  const requestId = request.headers.get("x-request-id") || "";
  const partes = Object.fromEntries(
    cabecalho.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
  const { ts, v1 } = partes;
  if (!ts || !v1 || !env.MP_WEBHOOK_SECRET) return false;

  let dataId = url.searchParams.get("data.id") || "";
  if (/^[a-z0-9]+$/i.test(dataId)) dataId = dataId.toLowerCase();

  let manifesto = "";
  if (dataId) manifesto += `id:${dataId};`;
  if (requestId) manifesto += `request-id:${requestId};`;
  manifesto += `ts:${ts};`;

  const esperado = await hmacSha256Hex(env.MP_WEBHOOK_SECRET, manifesto);
  const assinaturaOk = timingSafeEqual(esperado, v1);

  // ts em segundos ou milissegundos
  const bruto = Number(ts);
  const segundos = bruto > 1e11 ? Math.floor(bruto / 1000) : bruto;
  const tolerancia = intVar(env.WEBHOOK_TOLERANCE_SECONDS, 900);
  const recente = Number.isFinite(segundos) && Math.abs(now() - segundos) <= tolerancia;

  return assinaturaOk && recente;
};
