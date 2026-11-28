# Checkout online (Mercado Pago) e entrega digital

Compra por cartão de crédito e Pix (opcional), com confirmação automática e entrega dos PDFs por e-mail.
O site continua estático no GitHub Pages; o backend é um Cloudflare Worker (pasta `worker/`).

**Enquanto nada abaixo for configurado, o site funciona exatamente como antes**: o botão de compra online só aparece
para produtos que tenham preço e arquivo cadastrados no backend.

## Como funciona

1. A pessoa informa o e-mail na página da publicação e clica em **Comprar agora**.
2. O site envia ao backend apenas o identificador do produto e o e-mail. **O preço nunca vem do navegador**: o backend o lê da sua configuração.
3. O backend cria o pedido e a preferência do Checkout Pro e leva a pessoa ao Mercado Pago. Os dados do cartão ficam somente no Mercado Pago.
4. O Mercado Pago avisa o webhook. O backend valida a assinatura, consulta o pagamento diretamente na API do Mercado Pago, confere valor e moeda e só então libera o pedido.
5. Um e-mail com links individuais é enviado. Cada link tem validade e limite de downloads; os PDFs ficam em um armazenamento privado (R2) e nunca em URL pública.
6. Reembolso, estorno ou cancelamento revogam os links na hora.

## O que depende do proprietário (pendências)

| # | Item | Observação |
|---|------|------------|
| 1 | **Preço de cada publicação** | Em centavos, no `CATALOG_JSON` (mínimo R$ 1,00). Não há preço padrão no código. |
| 2 | **PDFs de entrega** | Enviar ao bucket R2 privado e informar as chaves no `CATALOG_JSON`. |
| 3 | **Conta Cloudflare** | Gratuita. Habilitar Workers, D1 e R2 (o R2 pode pedir um cartão no cadastro, sem cobrança dentro da cota gratuita). |
| 4 | **Credenciais do Mercado Pago** | Access Token e a assinatura secreta do webhook. Comece com as de **teste**. |
| 5 | **E-mail de envio** | Conta gratuita no Resend e domínio verificado (SPF/DKIM) para o remetente. Sem domínio verificado, o Resend só entrega ao próprio dono da conta. |
| 6 | **Endereço do Worker** | Após o primeiro deploy, copiar o endereço para `WORKER_ORIGIN` e para `checkoutApi` em `assets/editorial.js`. |
| 7 | **Homologação e autorização de produção** | Validar com credenciais de teste antes de trocar pelas de produção. |

## Passo a passo (homologação)

Requer Node.js 20+. Execute dentro da pasta `worker/`:

```bash
npm install
npx wrangler login

# 1) Banco de dados
npx wrangler d1 create checkout            # copie o database_id para wrangler.toml
npx wrangler d1 execute checkout --remote --file=schema.sql

# 2) Armazenamento privado dos PDFs
npx wrangler r2 bucket create publicacoes-privadas
npx wrangler r2 object put publicacoes-privadas/especialista-ses-fonoaudiologia/volume-01.pdf --file=./caminho/volume-01.pdf --remote

# 3) Segredos (nunca ficam no repositório)
npx wrangler secret put MP_ACCESS_TOKEN      # token de TESTE do Mercado Pago
npx wrangler secret put MP_WEBHOOK_SECRET    # assinatura secreta do webhook
npx wrangler secret put RESEND_API_KEY

# 4) Publicar o Worker
npx wrangler deploy
```

Depois:

1. Em `wrangler.toml`, preencha `WORKER_ORIGIN` (endereço que o deploy mostrou), `EMAIL_FROM` e `CATALOG_JSON`
   (veja `catalog.example.json`; exemplo: `priceCents = 4990` significa R$ 49,90). Rode `npx wrangler deploy` de novo.
2. No painel do Mercado Pago (Suas integrações), cadastre o webhook em `https://SEU-WORKER/webhook/mercadopago`,
   evento **Pagamentos**, e copie a assinatura secreta para o segredo `MP_WEBHOOK_SECRET`.
3. Em `assets/editorial.js`, preencha `checkoutApi` com o endereço do Worker e publique o site.
4. Faça uma compra de teste com os cartões de teste do Mercado Pago e confira o e-mail e o download.
5. Para produção: troque `MP_ENV` para `"prod"`, cadastre as credenciais de produção e repita o teste com um valor baixo.

## Configurações úteis (`wrangler.toml`)

- `ENABLE_PIX`: `"true"` oferece cartão e Pix; `"false"` deixa só cartão.
- `LINK_TTL_HOURS` e `MAX_DOWNLOADS`: validade (padrão 168 h) e limite de downloads de cada link (padrão 5).

## Testes

```bash
cd worker && npm install && npm test
```

Os testes rodam o Worker real no Miniflare (D1 e R2 locais) com o Mercado Pago e o provedor de e-mail simulados.
Eles não substituem a homologação com credenciais reais de teste.

## Pontos de atenção

- **Pagamento duplicado:** se a mesma pessoa pagar duas vezes o mesmo pedido, só a primeira libera os arquivos; a segunda cobrança precisa ser reembolsada manualmente no painel do Mercado Pago (o backend registra o evento `pagamento_duplicado` nos logs).
- **Abuso do endpoint de checkout:** a Cloudflare oferece regras de limite de requisições gratuitas, que podem ser ativadas se houver abuso.
- **Fuso e prazos:** links expiram em horas contadas no servidor (UTC).
