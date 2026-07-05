# Team Tracker — Design / Especificação

**Data:** 2026-07-02
**Status:** Aprovado em brainstorming; aguardando revisão final do spec
**Nome:** Team Tracker (aprovado)

## 1. Visão geral

Sistema web local-first para um gestor acompanhar múltiplos times: pessoas (stakeholders e membros com hierarquia), action items, milestones, riscos e notas datadas/por pessoa. Tudo persiste em **um único arquivo criptografado** controlado pelo usuário. O app é distribuído como **um único arquivo HTML** transportável (funciona via `file://`) e também hospedado (GitHub Pages) como PWA instalável.

**Público:** o próprio autor (gestor), Chrome desktop no Windows como plataforma principal.

**Princípios:**
- Zero dependências em runtime; recursos nativos do browser sempre que possível.
- Nenhum dado do usuário persistido no browser (exceção única: handle do arquivo no IndexedDB para reabertura rápida — atalho, não dado).
- Responsabilidade de backup do arquivo de dados é do usuário.

## 2. Arquitetura

**Padrão:** store central + componentes-função. Sem framework, sem virtual DOM.

- Documento decriptado vive em memória como objeto único (`Document`).
- Mutações passam por funções `actions` que: alteram o estado, marcam `dirty`, disparam re-render dos painéis afetados.
- Cada módulo é uma função TS `render(container, state, actions)` que constrói DOM diretamente.
- Fonte modular em TypeScript; build gera artefato único.

### Estrutura do repositório

```
vcup4/
├─ src/
│  ├─ core/        # store, crypto, persistence, markdown, i18n, search, schema/migrations
│  ├─ modules/     # um arquivo por módulo (daily-notes, person-notes, stakeholders,
│  │               #   members, action-items, milestones, risks)
│  ├─ ui/          # editor, calendário, layout/painéis, busca, modais, sidebar
│  └─ main.ts
├─ styles.css
├─ index.html      # template
├─ scripts/build.mjs
├─ test/           # Vitest — core puro
└─ dist/
   ├─ app.html     # arquivo único transportável
   └─ pwa/         # app + manifest.json + service worker (variante hospedada)
```

## 3. Arquivo, criptografia e persistência

### Formato do arquivo (`.tmv`)

```
[magic bytes][versão do formato][salt 16B][IV 12B][ciphertext AES-GCM]
```

- **Cifra:** AES-GCM 256 (WebCrypto). IV novo a cada save.
- **Derivação de chave:** PBKDF2-SHA256, 600.000 iterações, salt aleatório de 16 bytes.
- **Conteúdo:** JSON do `Document` completo (dados + preferências + estado de navegação).
- GCM autentica: senha errada e arquivo corrompido são distinguíveis de forma confiável e reportados com mensagens distintas.

### Abertura

Tela inicial oferece:
1. **Reabrir último** — handle persistido no IndexedDB; Chrome pede 1 clique de permissão.
2. **Abrir arquivo…** — `showOpenFilePicker`.
3. **Criar novo…** — `showSaveFilePicker` + definição de senha (2×).

Senha pedida ao abrir. Só o handle fica no IndexedDB; nenhum dado ou senha.

### Save

- **Auto-save:** a cada N minutos (preferência, default 5).
- **Save em eventos:** trocar módulo/dia/time, `beforeunload`.
- **Manual:** Ctrl+S.
- **Indicador:** header mostra estado (salvo ✓ / dirty ●); ● também no título da aba.
- Escrita completa do arquivo via handle (conteúdo novo integral por save).

### Trocar senha

Em preferências: senha atual + nova (2×). Re-deriva chave com salt novo; save imediato com a nova chave.

### Concorrência

- **Mesmo browser, 2ª aba:** Web Locks API sobre identificador do arquivo. Segunda aba abre somente-leitura com opção "assumir controle" (a primeira vira somente-leitura via BroadcastChannel).
- **Browsers diferentes / outra máquina / ferramenta de sync:** guardar `lastModified` na abertura e re-checar **antes de cada save**. Se o arquivo mudou no disco: bloquear o save e oferecer "Recarregar (descarta alterações locais)" ou "Sobrescrever".

### Fallback sem File System Access API

Abrir via `<input type=file>`, salvar via download do arquivo. Sem auto-save silencioso; indicador orienta download manual. Chrome desktop é o caminho principal.

### Versionamento de schema

`schemaVersion` no JSON. Na abertura, migrações rodam sequencialmente até a versão do app. Arquivo com schema mais novo que o app: recusa abrir com mensagem clara (evita corrupção silenciosa).

## 4. Modelo de dados

```
Document
├─ schemaVersion: number
├─ prefs { theme: light|dark|system, locale: pt-BR|en-US,
│          font: system|serif|mono, fontSize: S|M|L, autoSaveMin: number }
├─ templates[] ─ id, name, scope (personal|daily|any), body (md com placeholders)
├─ nav { activeTeamId, panes[2]: { moduleRef, history[] }, split: bool }
└─ teams[] (ordenados por posição)
   ├─ id (uuid), name, emoji
   ├─ stakeholders[]  ─ id, name, role, parentId|null, order, notes (md)
   ├─ members[]       ─ id, name, role, parentId|null, order, notes (md)
   ├─ actionItems[]   ─ id, text, done, dueDate|null, assignee (texto livre), order
   ├─ milestones[]    ─ id, date (yyyy-mm-dd), title, done
   ├─ risks[]         ─ id, title, chance (1-3), impact (1-3),
   │                    plan (mitigate|transfer|eliminate|accept),
   │                    followup (md), order
   └─ dailyNotes{}    ─ "yyyy-mm-dd" → conteúdo (md)
```

**Decisões:**
- IDs: `crypto.randomUUID()`.
- **Hierarquia** (stakeholders e membros): `parentId` (null = raiz; múltiplas raízes permitidas) + `order` entre irmãos. Drag-and-drop altera `parentId`/`order`. Excluir pessoa com filhos → filhos sobem para o pai da excluída.
- **Exposição** do risco = chance × impacto, sempre calculada, nunca persistida.
- **Assignee** de action item: texto livre; autocomplete sugere stakeholders/membros do time, mas aceita qualquer nome (externos).
- **Notas** persistem como markdown puro. Nota diária esvaziada → chave removida do mapa (dia perde destaque no calendário).
- Datas internas sempre `yyyy-mm-dd`; exibição segue locale.

## 5. Layout e navegação

```
┌──────┬──────────────────────────────────────────┐
│ [🔍 busca]  [salvo ✓]  [prefs ⚙] [fullscreen ⛶] │  header
├──────┼────────────────────┬─────────────────────┤
│ 1 🚀 │ ◀ ▶ [Notas: hoje ▾]│ ◀ ▶ [Checklist ▾]   │  barra do painel
│ 2 🔧 │                    │                     │
│ 3 📊 │   painel A         │   painel B          │
│  +   │                    │   (split opcional)  │
└──────┴────────────────────┴─────────────────────┘
```

- **Sidebar:** times numerados pela posição, emoji + nome. **Alt+1..9** troca time. Drag para reordenar. Botão + cria; editar/renomear/excluir via ícone de lápis ou menu de contexto.
- **Painéis:** 1 ou 2 (split 50/50 com divisor arrastável). Cada painel tem seletor de módulo (dropdown + paleta Ctrl+K) e histórico próprio ◀ ▶ (Alt+←/→ no painel focado).
- **Módulos:** Notas do dia, Notas de pessoa, Stakeholders, Membros, Action items, Milestones, Riscos.
- **Regra de duplicidade:** mesmo módulo em ambos painéis apenas para: notas diárias (dias diferentes) e notas de pessoa (pessoas diferentes). Demais: instância única — tentar abrir de novo foca o painel que já o exibe.
- **Histórico vs duplicidade:** entrada de histórico cujo destino violaria a regra é **pulada** (segue na mesma direção); sem entrada válida → no-op + toast discreto. Histórico do painel guarda time+módulo; navegação que troca time também revalida.
- **Chip `@` clicado** com alvo já aberto no outro painel → foca o outro painel.
- `nav` persiste no arquivo — reabrir retorna ao estado anterior.

### Calendário (notas diárias)

Mini-calendário mensal: hoje com anel de destaque; dias com nota com fundo colorido; dias com **milestone** ganham 🚩 (tooltip com título). Navegação ‹ mês ›.

### Módulos — detalhes específicos

- **Stakeholders / Membros:** árvore com drag-and-drop (nativo HTML5 DnD); nome + cargo; clique em pessoa abre notas dela.
- **Action items:** checklist ordenável; texto, done, due date, assignee. Due date vencida e item aberto → destaque.
- **Milestones:** lista por data + **linha do tempo** horizontal com espaçamento proporcional à distância entre datas (SVG simples); marcos passados/concluídos visualmente distintos.
- **Riscos:** tabela ordenável por exposição; chance/impacto como seletores 1-3; exposição com cor (1-2 verde, 3-4 amarelo, 6+ vermelho); plano (mitigar/transferir/eliminar/aceitar); follow-up com editor rico.

## 6. Editor de notas (WYSIWYG)

- `contenteditable` com camada própria de comandos; serializa para markdown ao salvar, md → DOM ao carregar.
- **Formatos (somente estes):** bold, itálico, sublinhado (`<u>` no md), riscado, bullets, lista numerada, H1–H3.
- **Atalhos:** Ctrl+B/I/U; Ctrl+Shift+X riscado; Ctrl+Shift+8 bullets; Ctrl+Shift+7 numerada; Ctrl+1/2/3 headers; Ctrl+0 parágrafo.
- **Auto-formatação:** `**x**`, `*x*`, `~~x~~`, `# `/`## `/`### `, `- `, `1. `.
- **Colar:** sempre texto puro (strip HTML).
- **Help:** botão `?` abre modal com atalhos e sintaxe (bilíngue).
- **Referências `@`:** dropdown de autocomplete (pessoas do time + data via digitação no formato do locale ou mini-calendário). Persistem como `@[label](person:id)` / `@[dd/mm/aaaa](day:yyyy-mm-dd)`. Renderizam como chip clicável → carrega alvo no painel atual (entra no histórico).
- **Usado em:** notas diárias, notas de pessoa, follow-up de risco.

### Templates de notas

- **Inserção:** digitar `/` no início de linha vazia (ou botão 📋 na barra do editor) abre dropdown filtrado por escopo do contexto atual (nota pessoal / nota diária / qualquer). ↑↓ + Enter insere o markdown do template na posição do cursor.
- **Placeholders** resolvidos na inserção: `{data}` (dia da nota ou hoje, formato do locale), `{hora}`, `{pessoa}` (nome, em notas pessoais), `{time}` (nome do time).
- **Armazenamento:** `Document.templates[]` — vivem no arquivo do usuário. Na criação de arquivo novo, seed com os 5 built-ins no idioma ativo: **1:1**, **Feedback (SBI)**, **Reunião**, **Decisão (mini-ADR)**, **Status semanal**.
- **Customização:** seção "Templates" nas preferências — criar, editar (nome, escopo, corpo md), duplicar, excluir, reordenar. Built-ins são templates comuns após o seed: editáveis/excluíveis livremente; botão "restaurar padrões" re-insere os built-ins faltantes.

## 7. Busca

- Campo no header; atalho Ctrl+F (ou `/` fora de campos de texto).
- Escopo: time atual (notas diárias, notas de pessoas, action items, milestones, riscos) + toggle "todos os times".
- Case- e acento-insensitive; múltiplos termos = AND.
- Dropdown de resultados: ícone do módulo, título (dia/pessoa/item), trecho ±2-3 linhas com termo destacado. ↑↓ + Enter ou clique abre no painel focado (respeita duplicidade — foca painel existente se aberto).
- Busca em memória; sem índice persistido.

## 8. Preferências, temas, i18n

- **Tema:** claro / escuro / sistema (CSS custom properties).
- **Idioma:** pt-BR / en-US. Dicionários TS tipados (paridade de chaves garantida pelo compilador). Datas no locale ativo; interno `yyyy-mm-dd`.
- **Fonte:** system-ui / serif / monospace (pilhas do sistema) + tamanho S/M/L.
- **Auto-save:** intervalo em minutos.
- Preferências vivem **no arquivo**. Tela inicial (pré-abertura) usa defaults do sistema/browser.
- Modal ⚙: preferências + templates + trocar senha + about.

## 9. Versões visíveis

- Título da aba: `Team Tracker v1.0.0 — arquivo.tmv ●`.
- About/help: versão do app (injetada do `package.json` no build), `schemaVersion` do arquivo aberto, schema suportado pelo app.

## 10. Build, deploy, PWA

- **Toolchain (dev-only):** esbuild + script Node (`scripts/build.mjs`) que inlina JS+CSS no template → `dist/app.html`. Vitest para testes. Zero deps de runtime.
- **Variante hospedada:** `dist/pwa/` com `manifest.json` + service worker cache-first do shell → GitHub Pages → PWA instalável.
- **Variante file://:** `app.html` puro; sem SW. Fullscreen via botão ⛶ (Fullscreen API). Help inclui receita `chrome --app=file:///caminho/app.html` para janela sem UI do browser.

## 11. Testes

Vitest sobre o core puro:
- Crypto round-trip (senha certa/errada/arquivo corrompido).
- Markdown ↔ DOM (todos os formatos + chips `@`).
- Migrações de schema.
- Busca (acentos, AND, escopo).
- Regra de duplicidade e navegação de histórico (casos de conflito).
- Hierarquia (mover, excluir com filhos).

UI: teste manual nesta fase.

## 12. Tratamento de erros

- Senha errada vs arquivo corrompido: mensagens distintas (GCM).
- Save falhou (permissão revogada, disco): toast persistente + manter dirty; oferecer "salvar como…".
- Arquivo mudou no disco: fluxo de conflito (seção 3).
- Schema mais novo que o app: recusa abrir, orienta atualizar o app.
- Erro inesperado: estado em memória nunca é descartado sem confirmação; oferecer download de emergência do arquivo cifrado atual.

## 13. Fora de escopo (v1)

- Multi-usuário / colaboração / sync.
- Mobile / browsers não-Chromium como alvo primário.
- Anexos, imagens em notas.
- Undo/redo global (undo nativo do contenteditable nos editores permanece).
- Export (md/PDF) — candidato a v2.
