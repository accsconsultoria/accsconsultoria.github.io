# accsconsultoria.github.io

Site estático da ACCS CONSULTORIA (GitHub Pages).

## Estrutura

- `index.html`: aplicação (roteamento por hash, catálogo, busca, filtros, paginação, página da publicação e visualizador de prévia).
- `data/publicacoes.json`: cadastro central das publicações.
- `assets/capas/`: capas das publicações.
- `previews/`: PDFs de prévia autorizados. Nunca coloque aqui o material completo: tudo o que está no repositório fica público.
- `legado/institucional-estatico.html`: versão institucional anterior, arquivada e fora da navegação.

## Cadastrar uma publicação

1. Coloque a capa em `assets/capas/` e, se houver, a prévia em `previews/`.
2. Acrescente um objeto ao array `publicacoes` em `data/publicacoes.json`, com os campos descritos no próprio arquivo.
3. Para o botão de compra pelo WhatsApp, cadastre o número oficial em `CONFIGURACAO.whatsapp` no `index.html`, no formato `https://wa.me/55DDDNUMERO`. Enquanto estiver vazio, os botões mostram "Atendimento em breve".

## Visualizador de prévia

Usa PDF.js 3.11.174, carregado do cdnjs somente quando uma prévia é aberta. Se a biblioteca não carregar, a página oferece o botão "Abrir prévia em nova aba".
