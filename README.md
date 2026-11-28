# Catálogo de publicações para concursos públicos

Site estático publicado pelo GitHub Pages. O endereço técnico do site é o nome do repositório.

## Estrutura

- `index.html`: página inicial (apresentação editorial, publicações recentes e informações sobre as publicações).
- `catalogo/index.html`: catálogo com busca, áreas profissionais e ordenação; páginas individuais em `catalogo/#/produto/<slug>` e prévias em `catalogo/#/previa/<slug>`.
- `assets/editorial.css` e `assets/editorial.js`: identidade visual e funções compartilhadas pelas duas páginas.
- `data/publicacoes.json`: cadastro central das publicações. A última publicação do arquivo aparece como o lançamento mais recente.
- `assets/capas/`: capas das publicações (JPG, 1200 × 1600 px, proporção 3:4, até 300 KB).
- `previews/`: PDFs de prévia autorizados. Nunca coloque aqui o material completo: tudo o que está no repositório fica público.
- `produtos/<slug>/`: páginas de compartilhamento, com título, descrição e capa de cada publicação.
- `legado/` e `campanhas/`: arquivos antigos, fora da navegação do site.

## Cadastrar uma publicação

1. Coloque a capa em `assets/capas/` e, se houver, a prévia autorizada em `previews/`.
2. Acrescente um objeto ao array `publicacoes` em `data/publicacoes.json`, com os campos descritos no próprio arquivo. As áreas disponíveis são `saude`, `administracao-publica`, `direito` e `outras`.
3. Rode `python3 tools/gerar_paginas_produto.py` para atualizar as páginas de compartilhamento.

## Contato exibido no site

O e-mail e o número de WhatsApp ficam em `assets/editorial.js` (`CONFIG`) e nos rodapés de `index.html` e `catalogo/index.html`.

## Visualizador de prévia

Usa PDF.js 3.11.174, carregado do cdnjs somente quando uma prévia é aberta. Se a biblioteca não carregar, a página oferece o botão "Abrir em nova aba".
