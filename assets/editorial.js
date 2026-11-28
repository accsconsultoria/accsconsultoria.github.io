/* =========================================================
   IDENTIDADE EDITORIAL — funções compartilhadas
   Página inicial e catálogo usam estas funções para ler o
   cadastro (data/publicacoes.json), montar os cartões e os
   links de WhatsApp. Para cadastrar uma nova publicação basta
   editar o JSON; nada aqui precisa mudar.
   ========================================================= */
(function (global) {
  "use strict";

  const CONFIG = {
    whatsapp: "https://wa.me/5561981594773",
    whatsappExibicao: "(61) 98159-4773",
    email: "consultoria.accs@gmail.com",
    local: "Brasília — Distrito Federal, Brasil",
    areas: [
      { id: "saude", nome: "Saúde" },
      { id: "administracao-publica", nome: "Administração Pública" },
      { id: "direito", nome: "Direito" },
      { id: "outras", nome: "Outras áreas" }
    ]
  };

  const MENSAGEM_GERAL =
    "Olá! Tenho interesse nas publicações do catálogo. Gostaria de conhecer os valores e as condições de aquisição.";

  const esc = (texto = "") =>
    String(texto)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const semAcento = (texto = "") =>
    String(texto).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  const areaValida = (id) => (CONFIG.areas.some((a) => a.id === id) ? id : "outras");
  const areaNome = (id) => CONFIG.areas.find((a) => a.id === areaValida(id)).nome;

  const numero = (valor) => {
    const n = Number(valor);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const texto = (valor) => String(valor ?? "").trim();
  const lista = (valor) => (Array.isArray(valor) ? valor.map(texto).filter(Boolean) : []);

  /* raiz: caminho até a raiz do site ("" na página inicial, "../" no catálogo) */
  const prefixar = (raiz, caminho) =>
    caminho && !/^(https?:|\/)/.test(caminho) ? `${raiz}${caminho}` : caminho;

  const normalizar = (item, raiz, ordem) => {
    const previa = texto(item.previa);
    return {
      ordem,
      slug: texto(item.slug),
      nome: texto(item.nome),
      area: areaValida(texto(item.area)),
      tipo: texto(item.tipo),
      concurso: texto(item.concurso),
      cargo: texto(item.cargo),
      banca: texto(item.banca),
      volumes: numero(item.volumes),
      capitulos: numero(item.capitulos),
      questoes: numero(item.questoes),
      paginas: numero(item.paginas),
      figuras: numero(item.figuras),
      autor: texto(item.autor),
      preco: texto(item.preco),
      descricaoCurta: texto(item.descricaoCurta),
      descricaoCompleta: texto(item.descricaoCompleta),
      apresentacao: lista(item.apresentacao),
      conteudo: lista(item.conteudo),
      sumarioTitulo: texto(item.sumarioTitulo),
      sumario: Array.isArray(item.sumario)
        ? item.sumario
            .map((s) => (typeof s === "string" ? { titulo: texto(s), itens: null } : { titulo: texto(s && s.titulo), itens: numero(s && s.itens) }))
            .filter((s) => s.titulo)
        : [],
      formato: texto(item.formato),
      capa: prefixar(raiz, texto(item.capa)),
      previa: /^previews\/[\w.-]+\.pdf$/i.test(previa) ? `${raiz}${previa}` : ""
    };
  };

  /* Lê o cadastro. Retorna as publicações na ordem do arquivo
     (a última cadastrada é considerada o lançamento mais recente). */
  const carregar = async (raiz) => {
    try {
      const resposta = await fetch(`${raiz}data/publicacoes.json`, { cache: "no-cache" });
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      const dados = await resposta.json();
      if (!Array.isArray(dados && dados.publicacoes)) throw new Error("Estrutura inválida");
      const vistos = new Set();
      const publicacoes = dados.publicacoes
        .filter((item) => item && typeof item === "object")
        .map((item, i) => normalizar(item, raiz, i))
        .filter((p) => p.slug && p.nome && !vistos.has(p.slug) && vistos.add(p.slug));
      return { publicacoes, erro: false };
    } catch (erro) {
      console.warn("Não foi possível carregar as publicações:", erro);
      return { publicacoes: [], erro: true };
    }
  };

  const maisRecentes = (publicacoes) => publicacoes.slice().sort((a, b) => b.ordem - a.ordem);

  const formatoCurto = (p) => (/pdf/i.test(p.formato) ? "Digital · PDF" : "Digital");

  const metadados = (p) =>
    [
      p.volumes ? `${p.volumes} volumes` : p.capitulos ? `${p.capitulos} capítulos` : "",
      p.questoes ? `${p.questoes} itens comentados` : "",
      formatoCurto(p)
    ].filter(Boolean);

  const linkWhatsapp = (mensagem = MENSAGEM_GERAL) =>
    `${CONFIG.whatsapp}?text=${encodeURIComponent(mensagem)}`;

  const mensagemPublicacao = (p) =>
    `Olá! Tenho interesse no produto ${p.nome}. Gostaria de conhecer os valores e as condições de aquisição.`;

  const capaHTML = (p, classe = "") =>
    p.capa
      ? `<img src="${esc(p.capa)}" alt="Capa da publicação ${esc(p.nome)}" loading="lazy" ${classe ? `class="${classe}"` : ""}>`
      : `<div class="sem-capa" role="img" aria-label="Capa não cadastrada">Capa em preparação</div>`;

  /* No cartão: concurso na forma curta (antes do travessão) e descrição sem repetir o título */
  const concursoCurto = (p) => p.concurso.split(" — ")[0];
  const descricaoCartao = (p) => {
    const prefixo = `${p.nome}:`;
    if (!p.descricaoCurta.startsWith(prefixo)) return p.descricaoCurta;
    const resto = p.descricaoCurta.slice(prefixo.length).trim();
    return resto.charAt(0).toUpperCase() + resto.slice(1);
  };

  /* linkBase: prefixo da página individual ("catalogo/#/produto/" ou "#/produto/") */
  const cartao = (p, linkBase) => `
    <a class="cartao" data-area="${esc(p.area)}" href="${esc(linkBase)}${encodeURIComponent(p.slug)}">
      <div class="cartao-capa">${capaHTML(p)}</div>
      <div class="cartao-corpo">
        <span class="cartao-area">${esc(areaNome(p.area))}</span>
        <h3 class="cartao-titulo">${esc(p.nome)}</h3>
        ${p.concurso || p.cargo ? `<p class="cartao-concurso">${esc([concursoCurto(p), p.cargo].filter(Boolean).join(" · "))}</p>` : ""}
        ${p.banca ? `<p class="cartao-banca">Banca: ${esc(p.banca)}</p>` : ""}
        ${p.descricaoCurta ? `<p class="cartao-descricao">${esc(descricaoCartao(p))}</p>` : ""}
        <div class="cartao-meta">${metadados(p).map((m) => `<span>${esc(m)}</span>`).join("")}</div>
        <span class="cartao-link">Ver publicação →</span>
      </div>
    </a>`;

  /* Menu do celular e ano do rodapé */
  const iniciarCabecalho = () => {
    const botao = document.getElementById("menuBotao");
    const nav = document.getElementById("navegacao");
    if (botao && nav) {
      botao.addEventListener("click", () => {
        const aberto = nav.classList.toggle("aberta");
        botao.setAttribute("aria-expanded", String(aberto));
      });
      nav.addEventListener("click", (e) => {
        if (e.target.closest("a")) {
          nav.classList.remove("aberta");
          botao.setAttribute("aria-expanded", "false");
        }
      });
    }
    const ano = document.getElementById("anoAtual");
    if (ano) ano.textContent = String(new Date().getFullYear());
    document.querySelectorAll("[data-whatsapp-geral]").forEach((a) => {
      a.href = linkWhatsapp();
    });
  };

  global.Editorial = {
    CONFIG,
    esc,
    semAcento,
    areaNome,
    carregar,
    maisRecentes,
    metadados,
    formatoCurto,
    linkWhatsapp,
    mensagemPublicacao,
    capaHTML,
    cartao,
    iniciarCabecalho
  };
})(window);
