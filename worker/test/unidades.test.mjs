/* Testes unitários das funções puras de src/util.js (sem Miniflare). */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ErroConfiguracao, boolVar, emailValido, intVar, log, origemDownload, redigir, timingSafeEqual, tokenDeEntrega
} from "../src/util.js";

describe("redigir (logs sem tokens)", () => {
  const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE"; // 43 caracteres

  test("substitui tokens longos em strings, objetos e listas, em qualquer profundidade", () => {
    assert.equal(token.length, 43);
    assert.equal(redigir(`GET /d/${token}/0`), "GET /d/[redigido]/0");
    assert.deepEqual(redigir({ a: { b: [`x ${token} y`] }, n: 5, ok: true }), { a: { b: ["x [redigido] y"] }, n: 5, ok: true });
  });

  test("preserva identificadores curtos úteis (UUID de pedido, id de pagamento)", () => {
    const uuid = "f824fb3b-00bf-4a3b-bbd0-4c57df808a55";
    assert.deepEqual(redigir({ pedido: uuid, pagamento: "123456789012" }), { pedido: uuid, pagamento: "123456789012" });
  });
});

describe("log() aplica a redação de tokens (defesa em profundidade)", () => {
  test("mesmo que um token seja passado por engano a log(), a linha emitida não o contém", () => {
    const token = await_token();
    const linhas = [];
    const original = console.log;
    console.log = (x) => linhas.push(String(x));
    try {
      log("teste", { erro: `falha em /d/${token}/0`, detalhes: { link: `https://x.test/d/${token}/1` }, pedido: "f824fb3b-00bf-4a3b-bbd0-4c57df808a55" });
    } finally {
      console.log = original;
    }
    assert.equal(linhas.length, 1);
    assert.ok(!linhas[0].includes(token), "o token apareceu na linha de log");
    assert.match(linhas[0], /\[redigido\]/);
    assert.match(linhas[0], /f824fb3b-00bf-4a3b-bbd0-4c57df808a55/, "o identificador do pedido continua legível");
  });
});

const await_token = () => "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE";

describe("origemDownload (sem a sigla da marca em URL de comprador)", () => {
  const o = (valor) => origemDownload({ DOWNLOAD_ORIGIN: valor });
  test("aceita origem https neutra e localhost", () => {
    assert.equal(o("https://arquivos.exemplo.test"), "https://arquivos.exemplo.test");
    assert.equal(o("https://arquivos.exemplo.test/"), "https://arquivos.exemplo.test");
    assert.equal(o("http://localhost:8787"), "http://localhost:8787");
    assert.equal(o("http://127.0.0.1:8851"), "http://127.0.0.1:8851");
  });
  test("recusa a sigla em qualquer parte, caminho, http fora do localhost e valores inválidos", () => {
    for (const v of ["https://accs.exemplo.test", "https://x.accsconsultoria.github.io", "https://ACCS-checkout.workers.dev", "https://exemplo.test/accs", "https://exemplo.test/p", "https://exemplo.test/?a=1", "http://exemplo.test", "ftp://exemplo.test", "", undefined, "lixo"]) {
      assert.equal(o(v), null, String(v));
    }
  });
});

describe("tokenDeEntrega (link determinístico e seguro)", () => {
  const env = { MP_WEBHOOK_SECRET: "segredo-a" };
  test("é estável por pedido, tem 43 caracteres base64url e muda com o pedido ou com o segredo", async () => {
    const t1 = await tokenDeEntrega(env, "pedido-1");
    assert.equal(t1, await tokenDeEntrega(env, "pedido-1"));
    assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(t1, await tokenDeEntrega(env, "pedido-2"));
    assert.notEqual(t1, await tokenDeEntrega({ MP_WEBHOOK_SECRET: "segredo-b" }, "pedido-1"));
  });
  test("não revela o segredo nem o identificador do pedido", async () => {
    const t = await tokenDeEntrega(env, "pedido-1");
    assert.ok(!t.includes("segredo") && !t.includes("pedido"));
  });
  test("sem segredo configurado falha com erro de configuração (nunca gera token fraco)", async () => {
    await assert.rejects(() => tokenDeEntrega({}, "pedido-1"), ErroConfiguracao);
  });
  test("não colide em 5.000 pedidos", async () => {
    const vistos = new Set();
    for (let i = 0; i < 5000; i++) vistos.add(await tokenDeEntrega(env, `p-${i}`));
    assert.equal(vistos.size, 5000);
  });
});

describe("utilidades básicas", () => {
  test("timingSafeEqual", () => {
    assert.ok(timingSafeEqual("abc", "abc"));
    assert.ok(!timingSafeEqual("abc", "abd"));
    assert.ok(!timingSafeEqual("abc", "abcd"));
  });
  test("emailValido", () => {
    for (const ok of ["a@b.co", "nome.sobrenome@dominio.com.br"]) assert.ok(emailValido(ok), ok);
    for (const ruim of ["", "a@b", "a b@c.com", "a@b.c", "<x>@y.com", "a@b.com,c@d.com", `${"x".repeat(250)}@b.com`, null, 5]) assert.ok(!emailValido(ruim), String(ruim));
  });
  test("intVar e boolVar", () => {
    assert.equal(intVar("10", 5), 10);
    assert.equal(intVar("0", 5), 5);
    assert.equal(intVar("abc", 5), 5);
    assert.equal(boolVar("true"), true);
    assert.equal(boolVar("false", true), false);
    assert.equal(boolVar(undefined, true), true);
  });
});
