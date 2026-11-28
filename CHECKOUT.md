# Checkout online (Mercado Pago) e entrega digital

Compra por cartão de crédito e Pix (opcional), com confirmação automática e entrega dos PDFs por e-mail.
O site continua estático no GitHub Pages; o backend é um Cloudflare Worker (pasta `worker/`).

**Enquanto nada abaixo for configurado, o site funciona exatamente como antes**: o botão de compra online só aparece
para produtos que tenham preço e arquivo cadastrados no backend **e** quando o backend tem uma origem de download neutra configurada.

## Nomes dos recursos

| Recurso | Produção | Homologação |
|---|---|---|
| Worker | `accs-checkout` | `pub-checkout-homolog` |
| Banco D1 | `accs-checkout-db` (binding `DB`) | `pub-checkout-db-homolog` (binding `DB`) |
| Bucket R2 | `accs-checkout-files` (binding `BUCKET`) | `pub-checkout-files-homolog` (binding `BUCKET`) |

Os dois ambientes são **totalmente separados** (banco, bucket, segredos e credenciais do Mercado Pago), definidos em
`worker/wrangler.toml` como `[env.producao]` e `[env.homologacao]`. O topo do arquivo não tem bindings de propósito:
um `wrangler deploy` sem `--env` não publica nada utilizável. Use `npm run deploy:homologacao` / `npm run deploy:producao`.

A homologação usa nomes **sem a sigla** para que o endereço `workers.dev` dela possa ser usado nos links de teste.

## Regra: nenhuma URL com "ACCS" é apresentada ao comprador

- Os links de download enviados por e-mail usam `DOWNLOAD_ORIGIN`, uma origem **neutra** (https, sem caminho, sem "accs" em nenhum trecho).
- Se `DOWNLOAD_ORIGIN` estiver vazia ou inválida, o checkout **se desativa sozinho**: o catálogo de compra volta vazio, `/api/checkout` responde 503 e nenhum pagamento é aceito. Assim ninguém paga sem conseguir receber um link neutro.
- O Worker de produção se chama `accs-checkout`, então o endereço padrão dele (`accs-checkout.<subdominio>.workers.dev`) **não** pode ser usado nos links. É preciso um domínio próprio neutro apontando para o Worker (veja as pendências).
- O endereço do webhook (`WORKER_ORIGIN`) é usado só pelo Mercado Pago e pode conter a sigla.
- **Limitação conhecida:** o retorno do pagamento leva o comprador a `https://accsconsultoria.github.io/pedido/`, que é o endereço atual do site e contém a sigla. Eliminar isso exige um domínio neutro para o próprio site.

## Como funciona

1. A pessoa informa o e-mail (duas vezes) na página da publicação e clica em **Comprar agora**.
2. O site envia ao backend apenas o identificador do produto e o e-mail. **O preço nunca vem do navegador**: o backend o lê da sua configuração.
3. O backend valida a origem (só o site) e o `Content-Type`, aplica a limitação de requisições, cria o pedido e a preferência do Checkout Pro e leva a pessoa ao Mercado Pago. Os dados do cartão ficam somente no Mercado Pago, com as condições de parcelamento padrão dele.
4. O Mercado Pago avisa o webhook. O backend valida a assinatura (HMAC e janela de tempo), consulta o pagamento diretamente na API, confere valor e moeda e só então libera o pedido.
5. Um e-mail com links individuais é enviado. Cada link tem validade e limite de downloads; os PDFs ficam em um armazenamento privado (R2) e nunca em URL pública.
6. Se algo for interrompido, uma rotina a cada 10 minutos retoma a entrega e reconcilia pagamentos sem desfecho. Nada é entregue em duplicidade.

## Segurança implementada

| Tema | Como |
|---|---|
| Origem e tipo | `/api/checkout` exige `Origin` igual ao site e `Content-Type: application/json`; corpo limitado a 4 KB. |
| Limitação | Por IP (padrão 10 a cada 10 min) e por e-mail (5 por hora), em D1, com contagem atômica. Respostas 429 com `Retry-After`. Chaves são hashes. |
| Webhook | Assinatura HMAC-SHA256 com comparação em tempo constante; timestamp assinado precisa estar dentro de ±15 min (`WEBHOOK_TOLERANCE_SECONDS`). |
| Pagamento | Consulta direta ao Mercado Pago; confere pedido, valor e moeda; só `approved` libera. |
| Entrega | Trava de entrega única; link determinístico por pedido (recuperável) e chave de idempotência do e-mail por pedido; 503 quando a entrega está em andamento (o Mercado Pago repete). |
| Tokens | 256 bits, derivados por HMAC; só o hash vai ao banco; nunca aparecem em logs (redação automática; registro de requisições desativado). |
| Cartão | Nenhum dado de cartão é recebido ou guardado. |

## Disputas, reembolsos e análise caso a caso

O sistema **registra** tudo e **não decide sozinho** o que depende de análise:

| Situação no Mercado Pago | O que o sistema faz |
|---|---|
| Reembolso **parcial** | Registra o valor (`refunded_cents`), marca `needs_review`. **Não revoga.** |
| Disputa aberta (`in_mediation`) | Marca `needs_review` e **suspende novas entregas**. Links já enviados continuam. |
| Estorno do cartão (`charged_back`) | Marca `needs_review` e suspende novas entregas. **Não revoga automaticamente.** |
| Reembolso **total** ou cancelamento de pedido pago | Revoga os links na hora. |
| Pagamento aprovado em pedido já encerrado, ou segundo pagamento do mesmo pedido | Marca `needs_review` (pode exigir reembolso manual no painel do Mercado Pago). |

O histórico financeiro (`payment_events` e valores dos pedidos) **nunca é apagado** pelo sistema.

### Decisão posterior (executar na pasta `worker/`)

```bash
# 1) Ver o que precisa de análise
npx wrangler d1 execute accs-checkout-db --remote --env producao --command \
  "SELECT id, slug, status, amount_cents, refunded_cents, review_reason, delivery_suspended, paid_at FROM orders WHERE review_status = 'needs_review' ORDER BY updated_at DESC"

# 2) Ver o histórico de pagamentos de um pedido
npx wrangler d1 execute accs-checkout-db --remote --env producao --command \
  "SELECT payment_id, status, refunded_cents, amount_cents, received_at FROM payment_events WHERE order_id = '<ID>' ORDER BY received_at"

# 3a) Liberar (retoma a entrega pendente na próxima rotina de 10 min)
npx wrangler d1 execute accs-checkout-db --remote --env producao --command \
  "UPDATE orders SET delivery_suspended = 0, review_status = 'resolved', review_note = 'liberado após análise' WHERE id = '<ID>'"

# 3b) Manter o acesso e encerrar a análise
npx wrangler d1 execute accs-checkout-db --remote --env producao --command \
  "UPDATE orders SET review_status = 'resolved', review_note = 'mantido após análise' WHERE id = '<ID>'"

# 3c) Revogar o acesso
npx wrangler d1 execute accs-checkout-db --remote --env producao --command \
  "UPDATE download_links SET revoked = 1 WHERE order_id = '<ID>'"
npx wrangler d1 execute accs-checkout-db --remote --env producao --command \
  "UPDATE orders SET review_status = 'resolved', review_note = 'acesso revogado após análise' WHERE id = '<ID>'"

# Entregas pagas e ainda não concluídas
npx wrangler d1 execute accs-checkout-db --remote --env producao --command \
  "SELECT id, paid_at, delivery_suspended FROM orders WHERE status = 'paid' AND delivered_at IS NULL"
```

Para a homologação, troque `accs-checkout-db` por `pub-checkout-db-homolog` e `--env producao` por `--env homologacao`.

## Retenção de dados pessoais (valores iniciais)

| Dado | Regra | Variável |
|---|---|---|
| Pedido que nunca teve pagamento nem tentativa | Apagado após 30 dias | `RETENTION_UNPAID_DAYS` |
| E-mail do comprador (pedidos sem pagamento aprovado) | Anonimizado após 30 dias | `RETENTION_UNPAID_DAYS` |
| E-mail do comprador (pedidos pagos e entregues) | Anonimizado após 1825 dias (5 anos) | `RETENTION_PERSONAL_DATA_DAYS` |
| Limites de requisição (chaves em hash) | Removidos ao expirar (minutos/horas) | — |
| Valores, datas, status e eventos de pagamento | **Mantidos** (histórico financeiro) | — |

Esses prazos são **valores iniciais** e precisam ser validados pelo proprietário e por orientação jurídica/contábil. Cite o tratamento
de e-mail na política de privacidade do site.

## O que depende do proprietário (pendências)

| # | Item | Observação |
|---|------|------------|
| 1 | **Preço de cada publicação** | Em centavos, no `CATALOG_JSON` (mínimo R$ 1,00). Não há preço padrão no código. |
| 2 | **PDFs de entrega** | Enviar ao bucket R2 privado e informar as chaves no `CATALOG_JSON`. |
| 3 | **Conta Cloudflare** | Gratuita. Habilitar Workers, D1 e R2 (o R2 pode pedir um cartão no cadastro, sem cobrança dentro da cota gratuita). |
| 4 | **Domínio neutro para os links** | Um domínio (ou subdomínio) sem "accs" apontando para o Worker de produção, e a rota correspondente. Preencher `DOWNLOAD_ORIGIN`. Sem isso o checkout de produção fica desativado. |
| 5 | **Credenciais do Mercado Pago** | Access Token e assinatura secreta do webhook, **uma de teste e uma de produção**. |
| 6 | **E-mail de envio** | Conta gratuita no Resend e domínio verificado (SPF/DKIM) para o remetente. Sem domínio verificado, o Resend só entrega ao dono da conta. |
| 7 | **Endereço do Worker** | Após o primeiro deploy, copiar para `WORKER_ORIGIN` e para `checkoutApi` em `assets/editorial.js`. |
| 8 | **Decisão sobre o domínio do site** | O retorno do pagamento usa `accsconsultoria.github.io` (veja a limitação acima). |
| 9 | **Validação dos prazos de retenção** | Ver tabela acima. |
| 10 | **Homologação externa e autorização de produção** | Ver "Homologação externa" abaixo. |

## Passo a passo (homologação primeiro)

Requer Node.js 20+. Execute dentro da pasta `worker/`. **Nada disto foi executado**: são os comandos para quando o proprietário autorizar.

```bash
npm install
npx wrangler login

# ----- HOMOLOGAÇÃO -----
npx wrangler d1 create pub-checkout-db-homolog      # copie o database_id para [env.homologacao] do wrangler.toml
npx wrangler d1 execute pub-checkout-db-homolog --remote --env homologacao --file=schema.sql
npx wrangler r2 bucket create pub-checkout-files-homolog
npx wrangler r2 object put pub-checkout-files-homolog/<chave>.pdf --file=./caminho/arquivo.pdf --remote
npm run deploy:homologacao                            # cria o Worker pub-checkout-homolog
npx wrangler secret put MP_ACCESS_TOKEN   --env homologacao   # token de TESTE
npx wrangler secret put MP_WEBHOOK_SECRET --env homologacao
npx wrangler secret put RESEND_API_KEY    --env homologacao

# ----- PRODUÇÃO (somente depois de aprovada a homologação) -----
npx wrangler d1 create accs-checkout-db             # copie o database_id para [env.producao]
npx wrangler d1 execute accs-checkout-db --remote --env producao --file=schema.sql
npx wrangler r2 bucket create accs-checkout-files
npx wrangler r2 object put accs-checkout-files/<chave>.pdf --file=./caminho/arquivo.pdf --remote
npm run deploy:producao                               # cria o Worker accs-checkout
npx wrangler secret put MP_ACCESS_TOKEN   --env producao      # token de PRODUÇÃO
npx wrangler secret put MP_WEBHOOK_SECRET --env producao
npx wrangler secret put RESEND_API_KEY    --env producao
```

Depois, em cada ambiente:

1. No `wrangler.toml`, preencha `WORKER_ORIGIN` (endereço que o deploy mostrou), `DOWNLOAD_ORIGIN` (origem neutra), `EMAIL_FROM` e `CATALOG_JSON`
   (veja `catalog.example.json`; `priceCents = 4990` significa R$ 49,90). Rode o deploy de novo. Para a rota do domínio neutro, adicione `routes` ao ambiente.
2. No painel do Mercado Pago (Suas integrações), cadastre o webhook em `https://SEU-WORKER/webhook/mercadopago`, evento **Pagamentos**,
   e use a assinatura secreta como `MP_WEBHOOK_SECRET` daquele ambiente.
3. Em `assets/editorial.js`, preencha `checkoutApi` com o endereço do Worker e publique o site.

## Homologação externa (ainda não realizada)

Os testes automatizados usam Mercado Pago, Resend e Cloudflare **simulados**. Antes de vender, é preciso validar com serviços reais:

- Mercado Pago (credenciais de teste): criação da preferência e endereço de checkout de teste (`sandbox_init_point` ou `init_point`), cartões de teste, Pix, formato real do `x-signature`, frequência e janela das repetições do webhook, status de disputa e de reembolso parcial.
- Resend: domínio verificado, entrega real e respeito ao cabeçalho `Idempotency-Key`.
- Cloudflare: D1 e R2 remotos, gatilho agendado, rota do domínio neutro, CORS a partir do site publicado e download de PDF grande no celular.
- Fluxo completo no site publicado, com compra de teste, e-mail, download, reembolso e retorno do pagamento.

## Testes

```bash
cd worker && npm install && npm test      # unitários, integração (Miniflare), disputas, concorrência, recuperação, limites, retenção
npm run e2e                               # ponta a ponta com navegador (requer Playwright instalado)
```

Eles não substituem a homologação externa acima.

## Pontos de atenção

- **Abuso do endpoint de checkout:** além da limitação interna, a Cloudflare oferece regras de limite de requisições no painel, que podem ser ativadas como camada extra.
- **Registro de requisições:** o token do link vai no caminho da URL. Não habilite `observability` nem Logpush para este Worker sem mascarar `/d/*`.
- **Segredo do webhook:** ele também é a base dos tokens de download. Trocá-lo invalida a recuperação de entregas ainda pendentes (links já entregues continuam válidos, pois o banco guarda o hash).
- **Fuso e prazos:** links expiram em horas contadas no servidor (UTC).
