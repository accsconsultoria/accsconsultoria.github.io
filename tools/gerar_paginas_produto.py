"""Gera uma página estática por publicação, com metadados Open Graph próprios.

Robôs de compartilhamento (WhatsApp, Facebook, Telegram etc.) não executam
JavaScript e não enxergam o trecho após o '#'. Por isso cada produto ganha
uma página em produtos/<slug>/index.html, que traz nome, descrição e capa
do produto e redireciona as pessoas para a vitrine.

Uso: python3 tools/gerar_paginas_produto.py   (rodar após editar data/publicacoes.json)
"""
import html
import json
import pathlib
import shutil

RAIZ = pathlib.Path(__file__).resolve().parent.parent
BASE = "https://accsconsultoria.github.io"
DADOS = json.loads((RAIZ / "data/publicacoes.json").read_text(encoding="utf-8"))["publicacoes"]
SAIDA = RAIZ / "produtos"

if SAIDA.exists():
    shutil.rmtree(SAIDA)

for p in DADOS:
    slug = p["slug"]
    nome = html.escape(p["nome"])
    desc = html.escape(p.get("descricaoCurta") or "Material educacional da ACCS CONSULTORIA.")
    url = f"{BASE}/produtos/{slug}/"
    destino = f"../../catalogo/#/produto/{slug}"
    capa = p.get("capa") or ""
    imagem = f"{BASE}/{capa}" if capa and not capa.startswith("http") else ""
    tags_imagem = (
        f'<meta property="og:image" content="{html.escape(imagem)}">\n'
        f'  <meta name="twitter:card" content="summary_large_image">\n'
        f'  <meta name="twitter:image" content="{html.escape(imagem)}">'
        if imagem else '<meta name="twitter:card" content="summary">'
    )
    pagina = f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{nome} — ACCS CONSULTORIA</title>
  <meta name="description" content="{desc}">
  <link rel="canonical" href="{url}">
  <meta name="robots" content="index, follow">
  <meta property="og:type" content="product">
  <meta property="og:site_name" content="ACCS CONSULTORIA">
  <meta property="og:title" content="{nome}">
  <meta property="og:description" content="{desc}">
  <meta property="og:url" content="{url}">
  {tags_imagem}
  <meta http-equiv="refresh" content="0; url={destino}">
  <script>location.replace("{destino}");</script>
</head>
<body>
  <p>Abrindo <a href="{destino}">{nome}</a>…</p>
</body>
</html>
"""
    pasta = SAIDA / slug
    pasta.mkdir(parents=True)
    (pasta / "index.html").write_text(pagina, encoding="utf-8")
    print("gerada:", f"produtos/{slug}/index.html")
