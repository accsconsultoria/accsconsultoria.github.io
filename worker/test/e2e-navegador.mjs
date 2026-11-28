/* Teste ponta a ponta: navegador real -> site estático -> Worker (Miniflare) -> Mercado Pago/Resend simulados.
   Uso (na pasta worker/): node test/e2e-navegador.mjs [pasta-de-capturas]
   Requer Playwright instalado globalmente (não faz parte de `npm test`). */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { Miniflare } from "miniflare";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const RAIZ = path.resolve(new URL("../..", import.meta.url).pathname);
const SCHEMA = (await import("node:fs")).readFileSync(path.join(RAIZ, "worker/schema.sql"), "utf8");
const CAPTURAS = process.argv[2] || "/tmp";
mkdirSync(CAPTURAS, { recursive: true });
const SITE = "http://127.0.0.1:8850";
const API = "http://127.0.0.1:8851";
const SEGREDO = "segredo-e2e";
const PDF = new TextEncoder().encode("%PDF-1.4 arquivo privado do e2e");
const SLUG = "especialista-ses-fonoaudiologia"; // produto real do site

const resultados = [];
const ok = (nome, condicao, detalhe = "") => {
  resultados.push(!!condicao);
  console.log(`${condicao ? "PASS" : "FAIL"} ${nome}${detalhe ? " — " + detalhe : ""}`);
};

/* ---------- servidor estático do site ---------- */
const tipos = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png" };
const estatico = createServer((req, res) => {
  let caminho = decodeURIComponent(new URL(req.url, SITE).pathname);
  if (caminho.endsWith("/")) caminho += "index.html";
  const arquivo = path.join(RAIZ, caminho);
  if (!arquivo.startsWith(RAIZ) || !existsSync(arquivo) || !statSync(arquivo).isFile()) { res.writeHead(404); return res.end("404"); }
  res.writeHead(200, { "Content-Type": tipos[path.extname(arquivo)] || "application/octet-stream" });
  createReadStream(arquivo).pipe(res);
}).listen(8850, "127.0.0.1");

/* ---------- Worker real + serviços externos simulados ---------- */
const mock = { preferencias: [], pagamentos: new Map(), emails: [], seq: 0 };
const mf = new Miniflare({
  modules: true,
  scriptPath: path.join(RAIZ, "worker/src/index.js"),
  modulesRoot: path.join(RAIZ, "worker/src"),
  modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
  compatibilityDate: "2025-06-01",
  host: "127.0.0.1", port: 8851,
  d1Databases: { DB: "e2e-db" }, r2Buckets: { FILES: "e2e-files" },
  bindings: {
    MP_ACCESS_TOKEN: "TEST-e2e", MP_WEBHOOK_SECRET: SEGREDO, RESEND_API_KEY: "re_e2e",
    SITE_ORIGIN: SITE, WORKER_ORIGIN: API, ENABLE_PIX: "true", MP_ENV: "prod",
    LINK_TTL_HOURS: "168", MAX_DOWNLOADS: "5", EMAIL_FROM: "Publicações <p@site.test>", SUPPORT_EMAIL: "suporte@site.test",
    CATALOG_JSON: JSON.stringify([{ slug: SLUG, title: "Especialista SES - Fonoaudiologia", priceCents: 4990, files: [{ key: "fono/vol1.pdf", name: "Volume 1" }, { key: "fono/vol2.pdf", name: "Volume 2" }] }])
  },
  outboundService: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/checkout/preferences") {
      const corpo = await request.json(); const n = ++mock.seq; mock.preferencias.push(corpo);
      return Response.json({ id: `pref-${n}`, init_point: `https://mp.test/pagar/${n}` });
    }
    if (url.pathname.startsWith("/v1/payments/")) {
      const p = mock.pagamentos.get(url.pathname.split("/").pop());
      return p ? Response.json(p) : new Response("{}", { status: 404 });
    }
    if (url.pathname === "/emails") { mock.emails.push(await request.json()); return Response.json({ id: "ok" }); }
    return new Response("não simulado", { status: 599 });
  }
});
await mf.ready;
const db = await mf.getD1Database("DB");
for (const s of SCHEMA.replace(/^--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
const r2 = await mf.getR2Bucket("FILES");
await r2.put("fono/vol1.pdf", PDF); await r2.put("fono/vol2.pdf", PDF);

const assinar = (id) => {
  const ts = String(Date.now()); const rid = "e2e-req";
  const v1 = createHmac("sha256", SEGREDO).update(`id:${id};request-id:${rid};ts:${ts};`).digest("hex");
  return { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": rid };
};

const navegador = await chromium.launch();
try {
  /* ===== A. Sem backend configurado: o site fica exatamente como antes ===== */
  {
    const ctx = await navegador.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); const pedidos = [];
    p.on("request", (r) => { if (r.url().startsWith(API)) pedidos.push(r.url()); });
    await p.goto(`${SITE}/catalogo/#/produto/${SLUG}`, { waitUntil: "load" }); await p.waitForTimeout(800);
    ok("A. sem backend: nenhum bloco de compra aparece", (await p.locator("#formCompra").count()) === 0);
    ok("A. sem backend: nenhuma chamada ao Worker", pedidos.length === 0);
    ok("A. sem backend: botão do WhatsApp continua", (await p.locator(".consulta a[href*='wa.me']").count()) === 1);
    await ctx.close();
  }

  /* ===== B/C/D. Com backend: bloco de compra, validação e criação do pedido ===== */
  const ctx = await navegador.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((api) => { window.CHECKOUT_API = api; }, API);
  await ctx.route("https://mp.test/**", (rota) => rota.fulfill({ contentType: "text/html", body: "<h1>Checkout Pro simulado</h1>" }));
  const p = await ctx.newPage(); const errosPagina = []; const chamadas = [];
  p.on("pageerror", (e) => errosPagina.push(e.message));
  p.on("request", (r) => { if (r.url().startsWith(`${API}/api/checkout`)) chamadas.push(r); });
  await p.goto(`${SITE}/catalogo/#/produto/${SLUG}`, { waitUntil: "load" }); await p.waitForSelector("#formCompra", { timeout: 8000 });
  ok("B. com backend: bloco de compra aparece só para produto com preço e arquivo", (await p.locator("#formCompra").count()) === 1);
  ok("B. preço exibido vem do servidor (R$ 49,90)", /49,90/.test(await p.textContent(".compra-valor")), await p.textContent(".compra-valor"));
  ok("B. WhatsApp e demais ações continuam disponíveis", (await p.locator(".consulta a[href*='wa.me']").count()) === 1);
  await p.screenshot({ path: path.join(CAPTURAS, "checkout-produto-desktop.png"), fullPage: true });

  await p.goto(`${SITE}/catalogo/#/produto/farmaceutico-bioquimico`, { waitUntil: "load" }); await p.waitForTimeout(1000);
  ok("B. produto sem preço no backend não mostra compra online", (await p.locator("#formCompra").count()) === 0);

  await p.goto(`${SITE}/catalogo/#/produto/${SLUG}`, { waitUntil: "load" }); await p.waitForSelector("#formCompra");
  await p.fill("#emailCompra", "isso-nao-e-email"); await p.click("#formCompra button");
  await p.waitForTimeout(300);
  ok("C. e-mail inválido é barrado antes de chamar o Worker", (await p.isVisible("#erroCompra")) && chamadas.length === 0);

  await p.fill("#emailCompra", "comprador@exemplo.com");
  await Promise.all([p.waitForURL(/mp\.test\/pagar\//, { timeout: 8000 }), p.click("#formCompra button")]);
  ok("D. e-mail válido leva ao Checkout Pro", /mp\.test\/pagar\/1$/.test(p.url()), p.url());
  const corpoEnviado = JSON.parse(chamadas[0].postData());
  ok("D. o navegador envia só slug e e-mail (nunca preço)", JSON.stringify(Object.keys(corpoEnviado).sort()) === '["email","slug"]', JSON.stringify(corpoEnviado));
  const pref = mock.preferencias.at(-1);
  ok("D. preferência criada com o preço do servidor e pagamento só por cartão/Pix", pref.items[0].unit_price === 49.9 && !pref.payment_methods.excluded_payment_types.some((t) => ["credit_card", "bank_transfer"].includes(t.id)));
  const pedido = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(pref.external_reference).first();
  ok("D. pedido gravado como 'created' no valor de R$ 49,90", pedido.status === "created" && pedido.amount_cents === 4990 && pedido.email === "comprador@exemplo.com");

  /* ===== E. Pagamento aprovado -> webhook -> e-mail -> download ===== */
  mock.pagamentos.set("123456789", { id: "123456789", status: "approved", status_detail: "accredited", transaction_amount: 49.9, currency_id: "BRL", external_reference: pref.external_reference });
  const wh = await fetch(`${API}/webhook/mercadopago?data.id=123456789&type=payment`, { method: "POST", headers: { "Content-Type": "application/json", ...assinar("123456789") }, body: JSON.stringify({ data: { id: "123456789" } }) });
  ok("E. webhook assinado é aceito", wh.status === 200, String(wh.status));
  const email = mock.emails.at(-1);
  ok("E. e-mail enviado ao comprador com links individuais", email && email.to[0] === "comprador@exemplo.com" && /\/d\/[\w-]{40,}\/0/.test(email.text) && /\/d\/[\w-]{40,}\/1/.test(email.text));
  const link0 = email.text.match(/https?:\/\/\S+\/d\/[\w-]+\/0/)[0];
  const baixado = await fetch(link0);
  ok("E. download pelo link do e-mail entrega o PDF protegido", baixado.status === 200 && baixado.headers.get("content-type") === "application/pdf" && baixado.headers.get("cache-control") === "private, no-store" && Buffer.compare(Buffer.from(await baixado.arrayBuffer()), Buffer.from(PDF)) === 0);
  const repetido = await fetch(`${API}/webhook/mercadopago?data.id=123456789&type=payment`, { method: "POST", headers: { ...assinar("123456789") }, body: "{}" });
  ok("E. webhook repetido não envia segundo e-mail", repetido.status === 200 && mock.emails.length === 1);
  const forjado = await fetch(`${API}/webhook/mercadopago?data.id=123456789&type=payment`, { method: "POST", headers: { "x-signature": "ts=1,v1=00", "x-request-id": "x" }, body: "{}" });
  ok("E. webhook com assinatura forjada é recusado", forjado.status === 401);
  ok("E. arquivo privado não existe em URL pública do site", (await fetch(`${SITE}/fono/vol1.pdf`)).status === 404 && (await fetch(`${API}/fono/vol1.pdf`)).status === 404);

  /* ===== F. Reembolso revoga o acesso ===== */
  mock.pagamentos.get("123456789").status = "refunded";
  await fetch(`${API}/webhook/mercadopago?data.id=123456789&type=payment`, { method: "POST", headers: { ...assinar("123456789") }, body: "{}" });
  ok("F. após reembolso o link deixa de funcionar", (await fetch(link0)).status === 410);

  /* ===== G. Falha do Worker não quebra a página ===== */
  const ctx2 = await navegador.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx2.addInitScript(() => { window.CHECKOUT_API = "http://127.0.0.1:9"; });
  const q = await ctx2.newPage(); const errosQ = [];
  q.on("pageerror", (e) => errosQ.push(e.message));
  await q.goto(`${SITE}/catalogo/#/produto/${SLUG}`, { waitUntil: "load" }); await q.waitForTimeout(1200);
  ok("G. backend fora do ar: página normal, sem bloco de compra e sem erros de script", (await q.locator("#formCompra").count()) === 0 && (await q.textContent("h1")).includes("Fonoaudiologia") && errosQ.length === 0);
  await ctx2.close();

  /* ===== H. Falha na criação do checkout mostra mensagem amigável ===== */
  const ctx3 = await navegador.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx3.addInitScript((api) => { window.CHECKOUT_API = api; }, API);
  await ctx3.route(`${API}/api/checkout`, (rota) => rota.fulfill({ status: 502, contentType: "application/json", headers: { "access-control-allow-origin": SITE }, body: JSON.stringify({ erro: "falha_no_checkout" }) }));
  const h = await ctx3.newPage();
  await h.goto(`${SITE}/catalogo/#/produto/${SLUG}`, { waitUntil: "load" }); await h.waitForSelector("#formCompra");
  await h.fill("#emailCompra", "outro@exemplo.com"); await h.click("#formCompra button"); await h.waitForTimeout(600);
  ok("H. erro do Worker: mensagem clara, botão reativado, sem redirecionamento", (await h.isVisible("#erroCompra")) && !(await h.isDisabled("#formCompra button")) && h.url().includes("/catalogo/"));
  await ctx3.close();

  /* ===== I. Celular ===== */
  const cel = await navegador.newContext({ ...devices["iPhone 13"] });
  await cel.addInitScript((api) => { window.CHECKOUT_API = api; }, API);
  const m = await cel.newPage();
  await m.goto(`${SITE}/catalogo/#/produto/${SLUG}`, { waitUntil: "load" }); await m.waitForSelector("#formCompra");
  const excesso = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("I. celular: bloco de compra sem rolagem horizontal", excesso <= 0, `excesso ${excesso}px`);
  await m.locator("#formCompra").scrollIntoViewIfNeeded();
  await m.screenshot({ path: path.join(CAPTURAS, "checkout-produto-celular.png") });
  await cel.close();

  /* ===== J. Página de retorno ===== */
  const r = await ctx.newPage();
  for (const [status, trecho] of [["success", "Pagamento recebido"], ["pending", "em análise"], ["failure", "não concluído"]]) {
    await r.goto(`${SITE}/pedido/?status=${status}`, { waitUntil: "load" });
    ok(`J. página de retorno (${status})`, (await r.textContent("body")).includes(trecho) && (await r.locator('meta[name="robots"]').getAttribute("content")).includes("noindex"));
  }
  ok("sem erros de script no navegador", errosPagina.length === 0, errosPagina.join(" | "));
} finally {
  await navegador.close(); await mf.dispose(); estatico.close();
}
console.log(`\nTOTAL ${resultados.length}: ${resultados.filter(Boolean).length} ok, ${resultados.filter((x) => !x).length} falhas`);
process.exit(resultados.every(Boolean) ? 0 : 1);
