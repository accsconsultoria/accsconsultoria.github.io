/* Catálogo de venda. Preços e arquivos vêm EXCLUSIVAMENTE da variável CATALOG_JSON
   (configurada pelo proprietário). Nada é vendável sem preço e arquivo cadastrados.
   O cliente nunca envia preço: só o identificador (slug) do produto. */

export const carregarCatalogo = (env) => {
  let itens;
  try {
    itens = JSON.parse(env.CATALOG_JSON || "[]");
  } catch {
    return new Map();
  }
  if (!Array.isArray(itens)) return new Map();
  const mapa = new Map();
  for (const item of itens) {
    const slug = String(item?.slug || "").trim();
    const title = String(item?.title || "").trim();
    const priceCents = Number(item?.priceCents);
    const files = Array.isArray(item?.files)
      ? item.files
          .map((f) => ({ key: String(f?.key || "").trim(), name: String(f?.name || "").trim() }))
          .filter((f) => f.key)
      : [];
    const vendavel = slug && title && Number.isInteger(priceCents) && priceCents >= 100 && files.length > 0;
    if (vendavel) mapa.set(slug, { slug, title, priceCents, files });
  }
  return mapa;
};
