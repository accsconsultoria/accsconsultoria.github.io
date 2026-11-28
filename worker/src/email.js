import { ErroConfiguracao, escHtml, intVar, origemDownload } from "./util.js";

/* Envia os links individuais pelo Resend (https://resend.com).
   - Os links usam DOWNLOAD_ORIGIN (origem neutra, sem a sigla da marca anterior).
   - A chave de idempotência é fixa por pedido: se o envio for repetido após uma falha
     parcial, o provedor não entrega um segundo e-mail. */
export const enviarEntrega = async (env, { pedido, produto, token }) => {
  const origem = origemDownload(env);
  if (!origem) throw new ErroConfiguracao("DOWNLOAD_ORIGIN ausente ou inválido");

  const horas = intVar(env.LINK_TTL_HOURS, 168);
  const maximo = intVar(env.MAX_DOWNLOADS, 5);
  const base = `${origem}/d/${token}`;

  const links = produto.files.map((arquivo, i) => ({
    nome: arquivo.name || `Arquivo ${i + 1}`,
    url: `${base}/${i}`
  }));

  const html = `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#1d2330;line-height:1.55">
<h2 style="margin:0 0 12px">Pagamento confirmado</h2>
<p>Obrigado pela compra de <strong>${escHtml(produto.title)}</strong>. Seus arquivos estão disponíveis nos links abaixo:</p>
<ul>${links.map((l) => `<li><a href="${escHtml(l.url)}">${escHtml(l.nome)}</a></li>`).join("")}</ul>
<p>Os links são individuais e pessoais: não os compartilhe. Eles valem por ${Math.round(horas / 24)} dias e permitem até ${maximo} downloads cada.</p>
<p>Em caso de dúvida, responda este e-mail ou escreva para ${escHtml(env.SUPPORT_EMAIL || "")}.</p>
</body></html>`;

  const texto = [
    "Pagamento confirmado",
    "",
    `Obrigado pela compra de ${produto.title}. Seus arquivos:`,
    ...links.map((l) => `- ${l.nome}: ${l.url}`),
    "",
    `Os links são individuais e pessoais. Valem por ${Math.round(horas / 24)} dias e permitem até ${maximo} downloads cada.`,
    `Dúvidas: ${env.SUPPORT_EMAIL || ""}`
  ].join("\n");

  const resposta = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `entrega-${pedido.id}`
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [pedido.email],
      reply_to: env.SUPPORT_EMAIL,
      subject: `Sua compra: ${produto.title}`,
      html,
      text: texto
    })
  });
  if (!resposta.ok) throw new Error(`Falha no envio de e-mail (HTTP ${resposta.status})`);
};
