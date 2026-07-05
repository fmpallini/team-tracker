# Team Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App web local-first de acompanhamento de times (pessoas, action items, milestones, riscos, notas), persistido em um único arquivo criptografado, distribuído como um único HTML.

**Architecture:** Store central + componentes-função (sem framework, sem virtual DOM). Core puro em TypeScript (crypto, markdown, busca, navegação, i18n, templates) testado com Vitest; camada de UI renderiza DOM diretamente. Build via esbuild inlina JS+CSS num template HTML → `dist/app.html`; variante PWA em `dist/pwa/`.

**Tech Stack:** TypeScript, esbuild (dev), Vitest + jsdom (dev), WebCrypto, File System Access API, Web Locks, BroadcastChannel. **Zero dependências de runtime.**

**Spec:** `docs/superpowers/specs/2026-07-02-team-tracker-design.md` — leia antes de qualquer task.

## Global Constraints

- Zero dependências de runtime. DevDeps permitidas: `esbuild`, `typescript`, `vitest`, `jsdom`.
- Alvo primário: Chrome desktop / Windows. Fallbacks degradados são aceitáveis em outros browsers.
- Nada de dados do usuário no browser; única exceção: handle do arquivo no IndexedDB.
- Datas internas sempre `yyyy-mm-dd` (string). Exibição segue locale (`pt-BR` → dd/mm/aaaa, `en-US` → mm/dd/yyyy).
- Notas persistem como markdown puro; sublinhado como `<u>…</u>`.
- Idiomas: pt-BR e en-US. Toda string de UI passa por `t()` — nunca hardcode texto visível.
- TS `strict: true`. Sem `any` exceto em fronteiras do DOM claramente comentadas.
- Nome do app: **Team Tracker**. Extensão de arquivo de dados: `.tmv`.
- Commits frequentes, mensagens `feat:`/`fix:`/`test:`/`chore:`.

---

### Task 1: Scaffold + pipeline de build

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `index.html`, `styles.css`, `scripts/build.mjs`, `src/main.ts`, `vitest.config.ts`

**Interfaces:**
- Produces: `npm run build` → `dist/app.html` (JS+CSS inline, single file); `npm test` roda Vitest. Constante global `__APP_VERSION__` (string, do package.json) e `__PWA__` (boolean) via esbuild `define`.

- [ ] **Step 1: Criar arquivos de configuração**

`package.json`:
```json
{
  "name": "team-tracker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node scripts/build.mjs",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "esbuild": "^0.24.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "jsdom": "^25.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vitest/globals"]
  },
  "include": ["src", "test"]
}
```

`.gitignore`:
```
node_modules/
dist/
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { globals: true, environment: 'jsdom' },
  define: { __APP_VERSION__: '"test"', __PWA__: 'false' },
})
```

`index.html` (template; placeholders literais `/*__CSS__*/` e `/*__JS__*/`):
```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team Tracker</title>
<style>/*__CSS__*/</style>
</head>
<body>
<div id="app"></div>
<script>/*__JS__*/</script>
</body>
</html>
```

`styles.css` (baseline; cresce nas tasks de UI):
```css
:root { color-scheme: light dark; }
* { box-sizing: border-box; margin: 0; }
body { font-family: system-ui, sans-serif; height: 100vh; overflow: hidden; }
#app { height: 100%; display: flex; flex-direction: column; }
```

`src/main.ts`:
```ts
declare global { const __APP_VERSION__: string; const __PWA__: boolean }
document.getElementById('app')!.textContent = `Team Tracker v${__APP_VERSION__}`
export {}
```

`scripts/build.mjs`:
```js
import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

async function bundle(pwa) {
  const r = await build({
    entryPoints: ['src/main.ts'],
    bundle: true, format: 'iife', write: false, minify: true,
    define: { __APP_VERSION__: JSON.stringify(pkg.version), __PWA__: String(pwa) },
  })
  return r.outputFiles[0].text
}

const css = readFileSync('styles.css', 'utf8')
const tpl = readFileSync('index.html', 'utf8')
const page = (js) => tpl.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js)

mkdirSync('dist/pwa', { recursive: true })
writeFileSync('dist/app.html', page(await bundle(false)))
writeFileSync('dist/pwa/index.html', page(await bundle(true)))
console.log('built dist/app.html and dist/pwa/index.html')
```

- [ ] **Step 2: Instalar e buildar**

Run: `npm install && npm run build`
Expected: `built dist/app.html and dist/pwa/index.html`; abrir `dist/app.html` no Chrome mostra "Team Tracker v0.1.0".

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold ts + esbuild single-file build"
```

---

### Task 2: Tipos, documento vazio, migrações

**Files:**
- Create: `src/core/types.ts`, `src/core/document.ts`
- Test: `test/document.test.ts`

**Interfaces:**
- Produces (usado por TODAS as tasks seguintes):

```ts
// src/core/types.ts — completo, copiar literalmente
export interface Prefs {
  theme: 'light' | 'dark' | 'system'
  locale: 'pt-BR' | 'en-US'
  font: 'system' | 'serif' | 'mono'
  fontSize: 'S' | 'M' | 'L'
  autoSaveMin: number
}
export interface Person {
  id: string; name: string; role: string
  parentId: string | null; order: number; notes: string
}
export interface ActionItem {
  id: string; text: string; done: boolean
  dueDate: string | null; assignee: string; order: number
}
export interface Milestone { id: string; date: string; title: string; done: boolean }
export type RiskPlan = 'mitigate' | 'transfer' | 'eliminate' | 'accept'
export interface Risk {
  id: string; title: string; chance: 1 | 2 | 3; impact: 1 | 2 | 3
  plan: RiskPlan; followup: string; order: number
}
export interface Team {
  id: string; name: string; emoji: string
  stakeholders: Person[]; members: Person[]
  actionItems: ActionItem[]; milestones: Milestone[]; risks: Risk[]
  dailyNotes: Record<string, string>
}
export interface Template {
  id: string; name: string
  scope: 'personal' | 'daily' | 'any'; body: string
}
export type ModuleRef =
  | { kind: 'daily'; date: string }
  | { kind: 'person'; personId: string; group: 'stakeholders' | 'members' }
  | { kind: 'stakeholders' } | { kind: 'members' }
  | { kind: 'actions' } | { kind: 'milestones' } | { kind: 'risks' }
export interface Loc { teamId: string; ref: ModuleRef }
export interface PaneState { history: Loc[]; index: number } // current = history[index]; index -1 = vazio
export interface NavState {
  activeTeamId: string | null; split: boolean
  panes: [PaneState, PaneState]; focusedPane: 0 | 1
}
export interface Doc {
  schemaVersion: number; prefs: Prefs; templates: Template[]
  nav: NavState; teams: Team[]
}
```

```ts
// src/core/document.ts
export const SCHEMA_VERSION = 1
export function createEmptyDocument(locale: 'pt-BR' | 'en-US'): Doc  // seeds templates built-in (Task 9 injeta; até lá, templates: [])
export class SchemaTooNewError extends Error {}
export function migrate(raw: unknown): Doc  // valida schemaVersion; > SCHEMA_VERSION → throw SchemaTooNewError; < → aplica migrações em cadeia (v1: nenhuma)
```

- [ ] **Step 1: Teste falhando**

`test/document.test.ts`:
```ts
import { createEmptyDocument, migrate, SCHEMA_VERSION, SchemaTooNewError } from '../src/core/document'

test('createEmptyDocument shape', () => {
  const d = createEmptyDocument('pt-BR')
  expect(d.schemaVersion).toBe(SCHEMA_VERSION)
  expect(d.prefs).toEqual({ theme: 'system', locale: 'pt-BR', font: 'system', fontSize: 'M', autoSaveMin: 5 })
  expect(d.teams).toEqual([])
  expect(d.nav).toEqual({ activeTeamId: null, split: false, focusedPane: 0,
    panes: [{ history: [], index: -1 }, { history: [], index: -1 }] })
})

test('migrate accepts current version untouched', () => {
  const d = createEmptyDocument('en-US')
  expect(migrate(JSON.parse(JSON.stringify(d)))).toEqual(d)
})

test('migrate rejects newer schema', () => {
  const d = { ...createEmptyDocument('pt-BR'), schemaVersion: SCHEMA_VERSION + 1 }
  expect(() => migrate(d)).toThrow(SchemaTooNewError)
})
```

- [ ] **Step 2: Rodar e ver falhar** — `npm test` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar**

`src/core/document.ts`:
```ts
import type { Doc } from './types'
export const SCHEMA_VERSION = 1
export class SchemaTooNewError extends Error {}

export function createEmptyDocument(locale: 'pt-BR' | 'en-US'): Doc {
  return {
    schemaVersion: SCHEMA_VERSION,
    prefs: { theme: 'system', locale, font: 'system', fontSize: 'M', autoSaveMin: 5 },
    templates: [],
    nav: { activeTeamId: null, split: false, focusedPane: 0,
      panes: [{ history: [], index: -1 }, { history: [], index: -1 }] },
    teams: [],
  }
}

const MIGRATIONS: Record<number, (d: Record<string, unknown>) => void> = {
  // 1 → 2 entraria aqui como MIGRATIONS[1]
}

export function migrate(raw: unknown): Doc {
  const d = raw as { schemaVersion?: unknown } & Record<string, unknown>
  if (typeof d?.schemaVersion !== 'number') throw new Error('invalid document')
  if (d.schemaVersion > SCHEMA_VERSION) throw new SchemaTooNewError()
  for (let v = d.schemaVersion; v < SCHEMA_VERSION; v++) {
    MIGRATIONS[v]?.(d); d.schemaVersion = v + 1
  }
  return d as unknown as Doc
}
```

- [ ] **Step 4: Rodar testes** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: document types, factory and migrations"`

---

### Task 3: Criptografia do arquivo

**Files:**
- Create: `src/core/crypto.ts`
- Test: `test/crypto.test.ts`

**Interfaces:**
- Consumes: `Doc`, `migrate` (Task 2).
- Produces:
```ts
export class WrongPasswordError extends Error {}
export class CorruptFileError extends Error {}
export async function encryptDocument(doc: Doc, password: string): Promise<Uint8Array>
export async function decryptDocument(bytes: Uint8Array, password: string): Promise<Doc>
```
- Layout binário: `magic "TMV1"(4) | formatVersion(1)=1 | salt(16) | ivKcv(12) | kcv(32) | ivData(12) | ciphertext(N)`. KCV = AES-GCM(16 bytes zero) com a chave derivada — permite distinguir senha errada (KCV falha) de arquivo corrompido (KCV ok, corpo falha / magic inválido). PBKDF2-SHA256 600_000 iterações → AES-GCM 256.

- [ ] **Step 1: Teste falhando**

`test/crypto.test.ts`:
```ts
import { encryptDocument, decryptDocument, WrongPasswordError, CorruptFileError } from '../src/core/crypto'
import { createEmptyDocument } from '../src/core/document'

test('round-trip', async () => {
  const doc = createEmptyDocument('pt-BR')
  const bytes = await encryptDocument(doc, 's3cret')
  expect(await decryptDocument(bytes, 's3cret')).toEqual(doc)
}, 20000)

test('wrong password', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'right')
  await expect(decryptDocument(bytes, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError)
}, 20000)

test('corrupted body', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'pw')
  bytes[bytes.length - 1] ^= 0xff
  await expect(decryptDocument(bytes, 'pw')).rejects.toBeInstanceOf(CorruptFileError)
}, 20000)

test('bad magic', async () => {
  await expect(decryptDocument(new Uint8Array(100), 'pw')).rejects.toBeInstanceOf(CorruptFileError)
})
```

- [ ] **Step 2: Rodar e ver falhar** — `npm test` → FAIL.

- [ ] **Step 3: Implementar**

`src/core/crypto.ts`:
```ts
import type { Doc } from './types'
import { migrate } from './document'

export class WrongPasswordError extends Error {}
export class CorruptFileError extends Error {}

const MAGIC = [0x54, 0x4d, 0x56, 0x31] // "TMV1"
const FORMAT_VERSION = 1
const ITERATIONS = 600_000
const KCV_PLAIN = new Uint8Array(16)

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function encryptDocument(doc: Doc, password: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const ivKcv = crypto.getRandomValues(new Uint8Array(12))
  const ivData = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const kcv = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivKcv }, key, KCV_PLAIN))
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivData }, key,
    new TextEncoder().encode(JSON.stringify(doc))))
  const out = new Uint8Array(4 + 1 + 16 + 12 + 32 + 12 + data.length)
  out.set(MAGIC, 0); out[4] = FORMAT_VERSION
  out.set(salt, 5); out.set(ivKcv, 21); out.set(kcv, 33); out.set(ivData, 65); out.set(data, 77)
  return out
}

export async function decryptDocument(bytes: Uint8Array, password: string): Promise<Doc> {
  if (bytes.length < 78 || MAGIC.some((b, i) => bytes[i] !== b) || bytes[4] !== FORMAT_VERSION)
    throw new CorruptFileError()
  const salt = bytes.slice(5, 21), ivKcv = bytes.slice(21, 33)
  const kcv = bytes.slice(33, 65), ivData = bytes.slice(65, 77), data = bytes.slice(77)
  const key = await deriveKey(password, salt)
  try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivKcv }, key, kcv) }
  catch { throw new WrongPasswordError() }
  let plain: ArrayBuffer
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivData }, key, data) }
  catch { throw new CorruptFileError() }
  try { return migrate(JSON.parse(new TextDecoder().decode(plain))) }
  catch (e) { if (e instanceof Error && e.constructor.name !== 'SyntaxError') throw e; throw new CorruptFileError() }
}
```

- [ ] **Step 4: Rodar testes** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: aes-gcm file encryption with kcv"`

---

### Task 4: Markdown ↔ HTML

**Files:**
- Create: `src/core/markdown.ts`
- Test: `test/markdown.test.ts`

**Interfaces:**
- Produces:
```ts
export function mdToHtml(md: string): string   // HTML seguro p/ contenteditable e preview de busca
export function htmlToMd(root: HTMLElement): string  // serializa DOM do editor de volta p/ md
export interface RefInfo { label: string; target: { kind: 'person'; id: string } | { kind: 'day'; date: string } }
export function parseRef(href: string): RefInfo['target'] | null  // "person:ID" | "day:yyyy-mm-dd"
```
- Suporta SOMENTE: `**b**`, `*i*`, `<u>u</u>`, `~~s~~`, `# ## ###`, `- ` bullets, `1. ` numeradas, parágrafos, e refs `@[label](person:ID)` / `@[label](day:yyyy-mm-dd)` → `<a class="ref" data-ref="person:ID">@label</a>`. Todo texto passa por escape HTML (sem injeção). Linhas: bloco por linha; listas agrupadas em `<ul>/<ol>`.
- `htmlToMd` mapeia: `<strong>/<b>`→`**`, `<em>/<i>`→`*`, `<u>`→`<u></u>`, `<s>/<strike>/<del>`→`~~`, `<h1-3>`→`#`, `<ul><li>`→`- `, `<ol><li>`→`1. `, `<a class="ref" data-ref>`→`@[label](ref)`, `<div>/<p>/<br>`→quebras de linha. Ignora qualquer outra tag mantendo o texto.

- [ ] **Step 1: Teste falhando**

`test/markdown.test.ts`:
```ts
import { mdToHtml, htmlToMd, parseRef } from '../src/core/markdown'

const roundTrip = (md: string) => {
  const div = document.createElement('div')
  div.innerHTML = mdToHtml(md)
  return htmlToMd(div)
}

test('inline formats round-trip', () => {
  const md = 'a **b** *i* <u>u</u> ~~s~~ fim'
  expect(roundTrip(md)).toBe(md)
})

test('headers and lists', () => {
  const md = '# T1\n## T2\n### T3\ntexto\n- um\n- dois\n1. a\n2. b'
  expect(roundTrip(md)).toBe(md)
})

test('escapes html', () => {
  expect(mdToHtml('<script>x</script>')).not.toContain('<script>')
})

test('refs become chips and round-trip', () => {
  const md = 'ver @[Ana](person:abc-1) e @[02/07/2026](day:2026-07-02)'
  const html = mdToHtml(md)
  expect(html).toContain('data-ref="person:abc-1"')
  expect(html).toContain('>@Ana<')
  expect(roundTrip(md)).toBe(md)
})

test('parseRef', () => {
  expect(parseRef('person:abc')).toEqual({ kind: 'person', id: 'abc' })
  expect(parseRef('day:2026-07-02')).toEqual({ kind: 'day', date: '2026-07-02' })
  expect(parseRef('junk')).toBeNull()
})
```

- [ ] **Step 2: Rodar e ver falhar** — `npm test` → FAIL.

- [ ] **Step 3: Implementar**

`src/core/markdown.ts` — implementação por linha:
```ts
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(s: string): string {
  let out = esc(s)
  // refs primeiro (labels não contêm ]): @[label](person:ID) | @[label](day:date)
  out = out.replace(/@\[([^\]]+)\]\((person:[^)\s]+|day:\d{4}-\d{2}-\d{2})\)/g,
    (_, label, ref) => `<a class="ref" data-ref="${ref}" contenteditable="false">@${label}</a>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  out = out.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>')
  return out
}

export function mdToHtml(md: string): string {
  const lines = md.split('\n'); const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  for (const line of lines) {
    const h = /^(#{1,3}) (.*)$/.exec(line)
    const ul = /^- (.*)$/.exec(line)
    const ol = /^\d+\. (.*)$/.exec(line)
    if (h) { closeList(); out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`) }
    else if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul' } out.push(`<li>${inline(ul[1]!)}</li>`) }
    else if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol' } out.push(`<li>${inline(ol[1]!)}</li>`) }
    else { closeList(); out.push(`<div>${line ? inline(line) : '<br>'}</div>`) }
  }
  closeList(); return out.join('')
}

export interface RefInfo { label: string; target: { kind: 'person'; id: string } | { kind: 'day'; date: string } }
export function parseRef(href: string): RefInfo['target'] | null {
  if (href.startsWith('person:')) return { kind: 'person', id: href.slice(7) }
  const m = /^day:(\d{4}-\d{2}-\d{2})$/.exec(href)
  return m ? { kind: 'day', date: m[1]! } : null
}

function inlineMd(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''
  const kids = () => Array.from(node.childNodes).map(inlineMd).join('')
  const tag = node.tagName.toLowerCase()
  if (tag === 'a' && node.dataset.ref) return `@[${(node.textContent ?? '').replace(/^@/, '')}](${node.dataset.ref})`
  switch (tag) {
    case 'strong': case 'b': return `**${kids()}**`
    case 'em': case 'i': return `*${kids()}*`
    case 'u': return `<u>${kids()}</u>`
    case 's': case 'strike': case 'del': return `~~${kids()}~~`
    case 'br': return ''
    default: return kids()
  }
}

export function htmlToMd(root: HTMLElement): string {
  const out: string[] = []
  const walk = (node: Node) => {
    if (!(node instanceof HTMLElement)) {
      const t = node.textContent?.trim(); if (t) out.push(t); return
    }
    const tag = node.tagName.toLowerCase()
    if (/^h[1-3]$/.test(tag)) out.push('#'.repeat(Number(tag[1])) + ' ' + inlineMd(node))
    else if (tag === 'ul') node.querySelectorAll(':scope > li').forEach(li => out.push('- ' + inlineMd(li)))
    else if (tag === 'ol') { let i = 1; node.querySelectorAll(':scope > li').forEach(li => out.push(`${i++}. ` + inlineMd(li))) }
    else if (tag === 'div' || tag === 'p') out.push(inlineMd(node))
    else out.push(inlineMd(node))
  }
  root.childNodes.forEach(walk)
  return out.join('\n')
}
```

- [ ] **Step 4: Rodar testes; ajustar até passar** — `npm test` → PASS. (Round-trip exato é o critério; se um caso falhar, corrigir o serializador, não o teste.)
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: markdown <-> html engine with @refs"`

---

### Task 5: i18n + datas

**Files:**
- Create: `src/core/i18n.ts`
- Test: `test/i18n.test.ts`

**Interfaces:**
- Produces:
```ts
export type Locale = 'pt-BR' | 'en-US'
export type MsgKey = keyof typeof pt  // dicionários tipados; en tem exatamente as mesmas chaves (checado pelo compilador)
export function t(locale: Locale, key: MsgKey, params?: Record<string, string>): string  // "{x}" interpolação
export function formatDate(iso: string, locale: Locale): string      // 2026-07-02 → "02/07/2026" | "07/02/2026"
export function parseLocaleDate(s: string, locale: Locale): string | null  // inverso; valida dia/mês reais
export function todayIso(): string
```
- Dicionários: `const pt = { ... } as const; const en: Record<MsgKey, string> = { ... }`. Chaves criadas sob demanda pelas tasks de UI; nesta task, seed mínimo: `app_name`, `save_saved`, `save_dirty`, `open_file`, `create_file`, `reopen_last`, `password`, `cancel`, `ok`.

- [ ] **Step 1: Teste falhando**

`test/i18n.test.ts`:
```ts
import { t, formatDate, parseLocaleDate } from '../src/core/i18n'

test('t interpolates', () => {
  expect(t('pt-BR', 'app_name')).toBe('Team Tracker')
})
test('formatDate per locale', () => {
  expect(formatDate('2026-07-02', 'pt-BR')).toBe('02/07/2026')
  expect(formatDate('2026-07-02', 'en-US')).toBe('07/02/2026')
})
test('parseLocaleDate valid and invalid', () => {
  expect(parseLocaleDate('02/07/2026', 'pt-BR')).toBe('2026-07-02')
  expect(parseLocaleDate('07/02/2026', 'en-US')).toBe('2026-07-02')
  expect(parseLocaleDate('31/02/2026', 'pt-BR')).toBeNull()
  expect(parseLocaleDate('junk', 'pt-BR')).toBeNull()
})
```

- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** (`todayIso` = data local, não UTC: `new Date()` → `${y}-${pad(m)}-${pad(d)}` com getFullYear/getMonth/getDate; validação em `parseLocaleDate` reconstrói Date e confere y/m/d batem).
- [ ] **Step 4: `npm test` → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: i18n dictionaries and locale dates"`

---

### Task 6: Store

**Files:**
- Create: `src/core/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Store {
  readonly doc: Doc
  readonly dirty: boolean
  update(fn: (d: Doc) => void): void        // muta, marca dirty, notifica
  updateNav(fn: (d: Doc) => void): void     // muta nav, marca dirty, NÃO notifica render (evita loop em navegação)
  subscribe(fn: () => void): () => void
  onDirty(fn: (dirty: boolean) => void): void
  markSaved(): void
}
export function createStore(doc: Doc): Store
```

- [ ] **Step 1: Teste falhando**

`test/store.test.ts`:
```ts
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'

test('update notifies and marks dirty', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  let n = 0; s.subscribe(() => n++)
  const dirtyStates: boolean[] = []; s.onDirty(d => dirtyStates.push(d))
  expect(s.dirty).toBe(false)
  s.update(d => { d.teams.push({ id: 't1', name: 'X', emoji: '🚀', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} }) })
  expect(n).toBe(1); expect(s.dirty).toBe(true); expect(dirtyStates).toEqual([true])
  s.markSaved(); expect(s.dirty).toBe(false); expect(dirtyStates).toEqual([true, false])
})

test('updateNav marks dirty without render', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  let n = 0; s.subscribe(() => n++)
  s.updateNav(d => { d.nav.split = true })
  expect(n).toBe(0); expect(s.dirty).toBe(true)
})

test('unsubscribe works', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  let n = 0; const un = s.subscribe(() => n++); un()
  s.update(() => {}); expect(n).toBe(0)
})
```

- [ ] **Step 2: Rodar e ver falhar.** — [ ] **Step 3: Implementar** (implementação direta com Set de listeners). — [ ] **Step 4: PASS.** — [ ] **Step 5: Commit** `feat: central store`.

---

### Task 7: Navegação — duplicidade + histórico

**Files:**
- Create: `src/core/nav.ts`
- Test: `test/nav.test.ts`

**Interfaces:**
- Consumes: `Loc`, `PaneState`, `NavState`, `ModuleRef` (Task 2).
- Produces:
```ts
export function locsConflict(a: Loc, b: Loc | null): boolean
// regra: kinds diferentes nunca conflitam; daily conflita se mesmo team+date;
// person conflita se mesmo personId; demais kinds conflitam se mesmo teamId.
export function sameLoc(a: Loc, b: Loc | null): boolean
export function currentLoc(p: PaneState): Loc | null
export type OpenResult = { type: 'opened'; pane: PaneState } | { type: 'focusOther' }
export function openLoc(pane: PaneState, target: Loc, otherCurrent: Loc | null): OpenResult
// se target === current do pane: no-op ('opened' com pane igual). Se conflita com o outro: focusOther.
// Senão: trunca history após index, push target, index++. History cap: 50 entradas (drop mais antiga).
export function navigateHistory(pane: PaneState, dir: -1 | 1, otherCurrent: Loc | null): PaneState | null
// anda no history pulando entradas que conflitam com otherCurrent; null se nenhuma válida (no-op).
```

- [ ] **Step 1: Teste falhando**

`test/nav.test.ts`:
```ts
import { locsConflict, openLoc, navigateHistory, currentLoc } from '../src/core/nav'
import type { Loc, PaneState } from '../src/core/types'

const daily = (team: string, date: string): Loc => ({ teamId: team, ref: { kind: 'daily', date } })
const actions = (team: string): Loc => ({ teamId: team, ref: { kind: 'actions' } })
const person = (team: string, id: string): Loc => ({ teamId: team, ref: { kind: 'person', personId: id, group: 'members' } })
const pane = (...locs: Loc[]): PaneState => ({ history: locs, index: locs.length - 1 })

test('conflict rules', () => {
  expect(locsConflict(daily('t1', '2026-07-02'), daily('t1', '2026-07-02'))).toBe(true)
  expect(locsConflict(daily('t1', '2026-07-02'), daily('t1', '2026-07-01'))).toBe(false)
  expect(locsConflict(person('t1', 'p1'), person('t1', 'p2'))).toBe(false)
  expect(locsConflict(person('t1', 'p1'), person('t1', 'p1'))).toBe(true)
  expect(locsConflict(actions('t1'), actions('t1'))).toBe(true)
  expect(locsConflict(actions('t1'), actions('t2'))).toBe(false)
  expect(locsConflict(actions('t1'), null)).toBe(false)
})

test('openLoc pushes and truncates forward', () => {
  let p = pane(actions('t1'))
  const r = openLoc(p, daily('t1', '2026-07-02'), null)
  expect(r.type).toBe('opened')
  p = (r as any).pane
  expect(p.history.length).toBe(2); expect(p.index).toBe(1)
  const back = navigateHistory(p, -1, null)!
  const r2 = openLoc(back, daily('t1', '2026-07-01'), null)
  expect((r2 as any).pane.history.map((l: Loc) => (l.ref as any).date ?? l.ref.kind))
    .toEqual(['actions', '2026-07-01'])
})

test('openLoc conflicting target focuses other pane', () => {
  const r = openLoc(pane(), daily('t1', '2026-07-02'), daily('t1', '2026-07-02'))
  expect(r.type).toBe('focusOther')
})

test('navigateHistory skips conflicting entries', () => {
  const p = pane(daily('t1', '2026-07-01'), actions('t1'), daily('t1', '2026-07-02'))
  // outro painel está mostrando actions t1 → voltar deve pular actions e cair em 01/07
  const back = navigateHistory(p, -1, actions('t1'))!
  expect(currentLoc(back)).toEqual(daily('t1', '2026-07-01'))
})

test('navigateHistory returns null when nothing valid', () => {
  const p = pane(daily('t1', '2026-07-02'))
  expect(navigateHistory(p, -1, null)).toBeNull()
})
```

- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implementar** (funções puras retornando novos objetos; nunca mutar o pane recebido). — [ ] **Step 4: PASS.** — [ ] **Step 5: Commit** `feat: pane navigation with duplicity rule`.

---

### Task 8: Busca

**Files:**
- Create: `src/core/search.ts`
- Test: `test/search.test.ts`

**Interfaces:**
- Consumes: `Doc`, `Loc`, `formatDate`.
- Produces:
```ts
export interface SearchResult { loc: Loc; moduleKind: ModuleRef['kind']; title: string; snippet: string; teamName: string }
export function searchDocument(doc: Doc, query: string, scopeTeamId: string | null): SearchResult[]
// scopeTeamId null = todos os times. Case/acento-insensitive. Termos separados por espaço = AND.
// Fontes: dailyNotes (title = data formatada no locale do doc), person notes (title = nome),
// actionItems (text + assignee), milestones (title), risks (title + followup).
// snippet: ~160 chars centrados no primeiro match, md strip básico (remove ** * ~~ <u> </u> # - "1. " e sintaxe de ref mantendo label).
// Limite: 50 resultados.
export function normalize(s: string): string  // NFD, remove \p{M}, lowercase — exportada p/ highlight na UI
```

- [ ] **Step 1: Teste falhando**

`test/search.test.ts`:
```ts
import { searchDocument, normalize } from '../src/core/search'
import { createEmptyDocument } from '../src/core/document'
import type { Team } from '../src/core/types'

const team = (id: string, name: string): Team => ({ id, name, emoji: '🧭', stakeholders: [], members: [],
  actionItems: [], milestones: [], risks: [], dailyNotes: {} })

function fixture() {
  const d = createEmptyDocument('pt-BR')
  const t1 = team('t1', 'Alpha'), t2 = team('t2', 'Beta')
  t1.dailyNotes['2026-07-01'] = '# Reunião\nDiscussão sobre **orçamento** anual'
  t1.members.push({ id: 'p1', name: 'Ana', role: 'Dev', parentId: null, order: 0, notes: 'Promoção pendente' })
  t2.risks.push({ id: 'r1', title: 'Atraso fornecedor', chance: 2, impact: 3, plan: 'mitigate', followup: 'orcamento extra aprovado', order: 0 })
  d.teams.push(t1, t2)
  return d
}

test('normalize strips accents and case', () => {
  expect(normalize('Reunião ORÇAMENTO')).toBe('reuniao orcamento')
})

test('finds accent-insensitive within team scope', () => {
  const r = searchDocument(fixture(), 'orcamento', 't1')
  expect(r).toHaveLength(1)
  expect(r[0]!.loc.ref).toEqual({ kind: 'daily', date: '2026-07-01' })
  expect(r[0]!.snippet).toContain('orçamento')
  expect(r[0]!.snippet).not.toContain('**')
})

test('all-teams scope and AND terms', () => {
  expect(searchDocument(fixture(), 'orcamento', null)).toHaveLength(2)
  expect(searchDocument(fixture(), 'orcamento extra', null)).toHaveLength(1)
  expect(searchDocument(fixture(), 'orcamento zzz', null)).toHaveLength(0)
})

test('person notes searchable', () => {
  const r = searchDocument(fixture(), 'promocao', 't1')
  expect(r[0]!.loc.ref.kind).toBe('person')
  expect(r[0]!.title).toBe('Ana')
})
```

- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implementar.** — [ ] **Step 4: PASS.** — [ ] **Step 5: Commit** `feat: in-memory search`.

---

### Task 9: Templates core

**Files:**
- Create: `src/core/templates.ts`
- Modify: `src/core/document.ts` (createEmptyDocument passa a semear built-ins)
- Test: `test/templates.test.ts`

**Interfaces:**
- Produces:
```ts
export function builtinTemplates(locale: Locale): Template[]  // 5: 1:1, Feedback SBI, Reunião, Decisão, Status semanal (ids novos a cada chamada)
export interface TemplateCtx { dateIso: string; time: string; personName?: string; teamName?: string; locale: Locale }
export function resolveTemplate(body: string, ctx: TemplateCtx): string
// placeholders: {data} → formatDate(dateIso, locale); {hora} → ctx.time; {pessoa} → personName ?? ''; {time} → teamName ?? ''
```
- Corpos built-in (pt-BR; versão en-US traduz título/labels — mesmo shape):
  - **1:1** (`scope: personal`): `## 1:1 — {data}\n### Como está / energia\n- \n### Tópicos dela(e)\n- \n### Meus tópicos\n- \n### Feedback\n- \n### Ações combinadas\n- `
  - **Feedback (SBI)** (`personal`): `## Feedback — {data}\n**Situação:** \n**Comportamento:** \n**Impacto:** \n**Combinado:** `
  - **Reunião** (`daily`): `## Reunião — {hora}\n**Participantes:** \n### Pauta\n- \n### Decisões\n- \n### Ações (quem → o quê → quando)\n- `
  - **Decisão (mini-ADR)** (`any`): `## Decisão — {data}\n**Contexto:** \n**Opções consideradas:** \n**Decisão:** \n**Consequências / follow-up:** `
  - **Status semanal** (`daily`): `## Status semanal — {data}\n### Highlights\n- \n### Lowlights\n- \n### Riscos novos\n- \n### Próxima semana\n- `

- [ ] **Step 1: Teste falhando**

`test/templates.test.ts`:
```ts
import { builtinTemplates, resolveTemplate } from '../src/core/templates'
import { createEmptyDocument } from '../src/core/document'

test('five builtins with scopes', () => {
  const ts = builtinTemplates('pt-BR')
  expect(ts).toHaveLength(5)
  expect(ts.map(t => t.scope).sort()).toEqual(['any', 'daily', 'daily', 'personal', 'personal'])
  expect(new Set(ts.map(t => t.id)).size).toBe(5)
})

test('resolveTemplate fills placeholders', () => {
  const out = resolveTemplate('## 1:1 — {data} {hora} {pessoa} {time}',
    { dateIso: '2026-07-02', time: '14:30', personName: 'Ana', teamName: 'Alpha', locale: 'pt-BR' })
  expect(out).toBe('## 1:1 — 02/07/2026 14:30 Ana Alpha')
})

test('empty document seeds builtins', () => {
  expect(createEmptyDocument('pt-BR').templates).toHaveLength(5)
})
```

- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implementar** (+ atualizar teste de shape da Task 2 que espera `templates: []` — passa a esperar 5). — [ ] **Step 4: PASS (suite inteira).** — [ ] **Step 5: Commit** `feat: note templates core with builtin seed`.

---

### Task 10: Persistência — File System Access, IndexedDB, conflito

**Files:**
- Create: `src/core/fs.ts`, `src/core/idb.ts`
- Test: `test/fs.test.ts` (lógica de conflito com mocks; camada de browser é fina e verificada manualmente nas tasks de UI)

**Interfaces:**
- Produces:
```ts
// idb.ts — mini helper (sem libs): um object store 'kv'
export function idbSet(key: string, value: unknown): Promise<void>
export function idbGet<T>(key: string): Promise<T | undefined>
export function idbDel(key: string): Promise<void>

// fs.ts
export interface FileSession {
  handle: FileSystemFileHandle | null   // null no modo fallback
  name: string
  lastModified: number                  // atualizado após cada read/write
}
export const supportsFsApi: boolean     // 'showOpenFilePicker' in window
export async function pickOpen(): Promise<{ session: FileSession; bytes: Uint8Array } | null>   // null = cancelado
export async function pickCreate(suggestedName: string): Promise<FileSession | null>
export async function reopenLast(): Promise<{ session: FileSession; bytes: Uint8Array } | null> // via idbGet('lastHandle') + requestPermission
export class ExternalChangeError extends Error {}
export async function writeFile(session: FileSession, bytes: Uint8Array): Promise<void>
// se handle: compara getFile().lastModified com session.lastModified ANTES de gravar;
// diferente → throw ExternalChangeError (UI decide recarregar/sobrescrever).
// grava via createWritable(), atualiza session.lastModified, idbSet('lastHandle', handle).
export async function forceWrite(session: FileSession, bytes: Uint8Array): Promise<void> // sem checagem (usado no "sobrescrever")
export async function readCurrent(session: FileSession): Promise<Uint8Array>             // re-lê o arquivo (usado no "recarregar")
export function downloadFallback(name: string, bytes: Uint8Array): void                  // <a download> blob
```

- [ ] **Step 1: Teste falhando** — mock de `FileSystemFileHandle`:

`test/fs.test.ts`:
```ts
import { writeFile, forceWrite, ExternalChangeError, type FileSession } from '../src/core/fs'

function mockHandle(initialMtime: number) {
  let mtime = initialMtime
  let written: Uint8Array | null = null
  const handle = {
    name: 'x.tmv',
    async getFile() { return { lastModified: mtime, async arrayBuffer() { return (written ?? new Uint8Array()).buffer } } },
    async createWritable() {
      return { async write(b: Uint8Array) { written = b }, async close() { mtime += 1000 } }
    },
  } as unknown as FileSystemFileHandle
  return { handle, bump: () => { mtime += 5000 }, getWritten: () => written }
}

// idb é chamado dentro de writeFile — stub global mínimo p/ jsdom
vi.mock('../src/core/idb', () => ({ idbSet: async () => {}, idbGet: async () => undefined, idbDel: async () => {} }))

test('writeFile ok updates lastModified', async () => {
  const { handle, getWritten } = mockHandle(1000)
  const s: FileSession = { handle, name: 'x.tmv', lastModified: 1000 }
  await writeFile(s, new Uint8Array([1, 2]))
  expect(getWritten()).toEqual(new Uint8Array([1, 2]))
  expect(s.lastModified).toBeGreaterThan(1000)
})

test('writeFile detects external change', async () => {
  const { handle, bump } = mockHandle(1000)
  const s: FileSession = { handle, name: 'x.tmv', lastModified: 1000 }
  bump()
  await expect(writeFile(s, new Uint8Array([1]))).rejects.toBeInstanceOf(ExternalChangeError)
})

test('forceWrite ignores external change', async () => {
  const { handle, bump, getWritten } = mockHandle(1000)
  const s: FileSession = { handle, name: 'x.tmv', lastModified: 1000 }
  bump()
  await forceWrite(s, new Uint8Array([9]))
  expect(getWritten()).toEqual(new Uint8Array([9]))
})
```

- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implementar** (`idb.ts`: `indexedDB.open('team-tracker', 1)`, store `kv`; `fs.ts` conforme interface — após `close()`, re-lê `getFile()` p/ capturar `lastModified` real). — [ ] **Step 4: PASS.** — [ ] **Step 5: Commit** `feat: file persistence with external-change detection`.

---

### Task 11: App shell — layout, tema, header

**Files:**
- Create: `src/ui/dom.ts`, `src/ui/shell.ts`
- Modify: `src/main.ts`, `styles.css`

**Interfaces:**
- Produces:
```ts
// dom.ts
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs?: Record<string, string | number | boolean | ((e: Event) => void)>,
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K]
// attrs: chaves onX viram addEventListener; 'class' vira className; demais setAttribute.

// shell.ts
export interface Shell {
  root: HTMLElement
  headerLeft: HTMLElement; headerRight: HTMLElement   // slots (busca / botões)
  sidebar: HTMLElement
  panesRoot: HTMLElement
  setSaveState(state: 'saved' | 'dirty' | 'saving' | 'error'): void
  applyPrefs(prefs: Prefs): void  // seta data-theme, classes de fonte/tamanho no <html>
  setTitle(fileName: string | null, dirty: boolean): void  // document.title = "Team Tracker v0.1.0 — x.tmv ●"
}
export function createShell(): Shell
```
- CSS: grid `header / (sidebar | panes)`; custom properties para tema:
```css
:root, [data-theme=light] { --bg:#fff; --fg:#1a1a1a; --muted:#666; --accent:#2563eb; --panel:#f5f5f5; --border:#ddd; }
[data-theme=dark] { --bg:#161616; --fg:#e8e8e8; --muted:#999; --accent:#60a5fa; --panel:#222; --border:#3a3a3a; }
html[data-font=serif] body { font-family: Georgia, 'Times New Roman', serif; }
html[data-font=mono] body { font-family: Consolas, 'Cascadia Mono', monospace; }
html[data-size=S] { font-size: 14px; } html[data-size=M] { font-size: 16px; } html[data-size=L] { font-size: 18px; }
```
`theme: 'system'` → escuta `matchMedia('(prefers-color-scheme: dark)')`.
- Header direita: botão ⛶ (`document.documentElement.requestFullscreen()` / `exitFullscreen`), botão ⚙ (placeholder até Task 24), indicador de save.

- [ ] **Step 1: Implementar** conforme interface. `main.ts` monta shell com documento fake em memória (até Task 12).
- [ ] **Step 2: Verificação manual** — `npm run build`, abrir `dist/app.html`: layout com sidebar vazia e área central; alternar tema pelo SO reflete; ⛶ entra/sai de fullscreen; título da aba mostra `Team Tracker v0.1.0`.
- [ ] **Step 3: Commit** — `git commit -am "feat: app shell with theming and fullscreen"`

---

### Task 12: Tela inicial + fluxos de senha

**Files:**
- Create: `src/ui/start.ts`, `src/ui/modal.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `fs.ts`, `crypto.ts`, `document.ts`, `t()`.
- Produces:
```ts
// modal.ts
export function showModal(opts: { title: string; body: HTMLElement; buttons: { label: string; primary?: boolean; onClick: () => void }[] }): { close(): void }
export function promptPassword(locale: Locale, opts: { confirm?: boolean; title: string }): Promise<string | null>
// confirm=true exige 2 campos iguais (mensagem de erro inline se diferem). null = cancelado.
export function toast(msg: string, opts?: { sticky?: boolean }): void

// start.ts
export function showStartScreen(locale: Locale, onOpen: (session: FileSession, doc: Doc, password: string) => void): void
```
- Fluxo: 3 botões (Reabrir último — só se `idbGet('lastHandle')` existe; Abrir arquivo…; Criar novo…). Abrir: pick → promptPassword → `decryptDocument`; `WrongPasswordError` → mensagem "Senha incorreta", repete prompt; `CorruptFileError` → "Arquivo corrompido ou inválido"; `SchemaTooNewError` → "Arquivo criado por versão mais nova — atualize o app". Criar: pickCreate → promptPassword(confirm) → `createEmptyDocument(locale)` → grava imediatamente. Fallback sem FS API: "Abrir" usa `<input type=file>`; aviso de que salvar será via download.
- A senha em memória fica em closure do app controller (nunca em globals/DOM).

- [ ] **Step 1: Implementar.**
- [ ] **Step 2: Verificação manual** — build; criar arquivo novo com senha, fechar aba, reabrir `app.html`: "Reabrir último" aparece, senha errada mostra erro e re-pede, senha certa entra. Abrir o `.tmv` num editor hex: binário começa com `TMV1`, sem JSON legível.
- [ ] **Step 3: Commit** — `feat: start screen with open/create/reopen and password flows`

---

### Task 13: Sidebar de times

**Files:**
- Create: `src/ui/sidebar.ts`
- Modify: `src/main.ts`, `styles.css`

**Interfaces:**
- Consumes: `Store`, `Shell.sidebar`.
- Produces: `export function mountSidebar(shell: Shell, store: Store, actions: { selectTeam(id: string): void }): void`
- Comportamento:
  - Lista `store.doc.teams` na ordem do array; cada item: número (posição+1), emoji, nome. Ativo destacado (`nav.activeTeamId`).
  - Botão **+**: modal com campos nome + emoji (input texto simples p/ emoji) → `store.update` push team (`crypto.randomUUID()`).
  - Ícone lápis (hover): modal editar nome/emoji + botão excluir (confirmação: "Excluir time X e todos os seus dados?"). Excluir time ativo → ativa o primeiro restante; painéis com locs desse time têm history filtrado.
  - Drag-and-drop nativo (`draggable=true`, `dragover` calcula posição) reordena o array.
  - `Alt+1..9` (listener global em `main.ts`): `selectTeam(teams[n-1].id)`.
  - `selectTeam`: `store.updateNav` seta `activeTeamId` e abre módulo default (notas de hoje) no painel focado via `openLoc`; re-render dos painéis.

- [ ] **Step 1: Implementar.**
- [ ] **Step 2: Verificação manual** — criar 3 times, reordenar por drag, Alt+2 troca, renomear, excluir com confirmação. Recarregar arquivo: ordem persiste.
- [ ] **Step 3: Commit** — `feat: team sidebar with reorder and hotkeys`

---

### Task 14: Gerenciador de painéis

**Files:**
- Create: `src/ui/panes.ts`, `src/ui/palette.ts`
- Modify: `src/main.ts`, `styles.css`

**Interfaces:**
- Consumes: `nav.ts` (openLoc/navigateHistory/locsConflict/currentLoc), `Store`.
- Produces:
```ts
// panes.ts — ponto central de navegação; TODAS as aberturas de módulo passam por aqui
export interface PaneManager {
  openInPane(paneIdx: 0 | 1, loc: Loc): void      // aplica openLoc; focusOther → foca outro painel + toast
  openInFocused(loc: Loc): void
  toggleSplit(): void                              // fechar split: painel B some (history preservado no doc)
  renderAll(): void                                // re-render dos painéis visíveis
  registerModule(kind: ModuleRef['kind'], render: ModuleRenderer): void
}
export type ModuleRenderer = (container: HTMLElement, loc: Loc, ctx: ModuleCtx) => void
export interface ModuleCtx { store: Store; pm: PaneManager; paneIdx: 0 | 1; locale: Locale }
export function createPaneManager(shell: Shell, store: Store): PaneManager
```
- Cada painel: barra superior com ◀ ▶ (desabilitados quando `navigateHistory` retorna null), título do módulo atual, botão ▾ (dropdown de módulos), botão split/unsplit. Corpo = container do módulo.
- Dropdown de módulos: Notas do dia (hoje), Notas de pessoa (submenu com pessoas do time), Stakeholders, Membros, Action items, Milestones, Riscos — todos geram `Loc` com `activeTeamId`.
- `palette.ts`: Ctrl+K abre overlay com input + lista filtrada dos mesmos itens (fuzzy: substring normalizado); Enter abre no painel focado; Esc fecha.
- Atalhos: Alt+←/→ = histórico do painel focado; clique num painel muda `focusedPane` (borda de destaque).
- Splitter central arrastável (mousedown + mousemove ajusta `grid-template-columns`; largura % não persiste — split on/off persiste em `nav.split`).
- Renderers ainda não registrados mostram placeholder "módulo em construção" (removido nas tasks 18-23).

- [ ] **Step 1: Implementar.**
- [ ] **Step 2: Verificação manual** — split on/off, trocar módulos pelos dois caminhos (dropdown, Ctrl+K), ◀ ▶ navega e pula conflito (abrir notas de hoje no A, mesmas notas tentadas no B → foca A com toast), Alt+←/→.
- [ ] **Step 3: Commit** — `feat: pane manager with split, palette and history`

---

### Task 15: Editor WYSIWYG

**Files:**
- Create: `src/ui/editor.ts`, `src/ui/help.ts`
- Modify: `styles.css`

**Interfaces:**
- Consumes: `markdown.ts`.
- Produces:
```ts
export interface Editor {
  root: HTMLElement
  getMd(): string
  setMd(md: string): void
  focus(): void
  destroy(): void
}
export interface EditorHooks {
  onChange(): void                                  // debounce 300ms após input
  onRefClick(target: RefInfo['target']): void
  onAtTrigger(anchor: Range): void                  // Task 16 pluga autocomplete
  onSlashTrigger(anchor: Range): void               // Task 17 pluga templates
}
export function createEditor(hooks: EditorHooks, locale: Locale): Editor
```
- Implementação: `div contenteditable=true` classe `editor`. Comandos via `document.execCommand` (Chrome-alvo; deprecado mas estável):
  - Ctrl+B `bold`, Ctrl+I `italic`, Ctrl+U `underline`, Ctrl+Shift+X `strikeThrough`, Ctrl+Shift+8 `insertUnorderedList`, Ctrl+Shift+7 `insertOrderedList`, Ctrl+1/2/3 `formatBlock <h1|h2|h3>`, Ctrl+0 `formatBlock <div>`.
- Auto-format no `input`: examinar texto do bloco atual antes do caret: `**x**`/`*x*`/`~~x~~` fechados → substituir pelo formato (Range surgery + execCommand); `# `/`## `/`### `/`- `/`1. ` no início de bloco → formatBlock/lista e remover o prefixo digitado.
- `paste`: `preventDefault`; `execCommand('insertText', false, e.clipboardData.getData('text/plain'))`.
- Clique em `.ref` → `onRefClick(parseRef(dataset.ref))`.
- Digitar `@` → `onAtTrigger(range)`; `/` em linha vazia → `onSlashTrigger(range)`.
- Barra do editor: botões B I U S̶ • 1. H + botão `?` → `help.ts` modal com tabela de atalhos (bilíngue, inclui sintaxe md, refs `@`, templates `/`, e receita `chrome --app=file:///C:/caminho/app.html` p/ janela sem UI do browser).
- `setMd` usa `mdToHtml`; `getMd` usa `htmlToMd`.

- [ ] **Step 1: Implementar.**
- [ ] **Step 2: Verificação manual** — playground temporário no painel (ou usar Task 18 se preferir inverter ordem): todos os atalhos; digitar `**teste**` vira bold; colar HTML rico de um site entra como texto puro; `?` abre help.
- [ ] **Step 3: Commit** — `feat: wysiwyg editor with shortcuts and autoformat`

---

### Task 16: Referências `@`

**Files:**
- Create: `src/ui/atref.ts`
- Modify: `src/ui/editor.ts` (pluga hook), `src/ui/panes.ts` (navegação por ref)

**Interfaces:**
- Consumes: `Editor`/`EditorHooks`, `parseLocaleDate`, `PaneManager`.
- Produces:
```ts
export function attachAtAutocomplete(editor: Editor, opts: {
  getPeople(): { id: string; name: string; group: 'stakeholders' | 'members' }[]
  locale: Locale
  onPick(item: { kind: 'person'; id: string; name: string } | { kind: 'day'; date: string }): void
}): void
```
- Comportamento: ao `onAtTrigger`, dropdown ancorado no caret. Digitação após `@` filtra pessoas (substring normalizada). Se o texto digitado casa com data parcial/completa no formato do locale (`parseLocaleDate`), item "Ir para notas de dd/mm/aaaa" aparece. ↑↓ Enter/Tab seleciona; Esc cancela (deixa `@` como texto). `onPick` remove o texto `@...` digitado e insere o chip: `<a class="ref" data-ref="person:ID" contenteditable="false">@Nome</a>` (ou `day:...` com label na formatação do locale).
- Navegação: em `panes.ts`, `onRefClick` → `person` → `openInPane(paneIdx, { teamId: activeTeamId, ref: { kind: 'person', personId, group } })` (group descoberto procurando o id nos dois arrays; pessoa excluída → toast "Pessoa não encontrada"); `day` → daily note do time ativo. Respeita duplicidade via `openLoc` normal (alvo já aberto no outro painel → foca lá).

- [ ] **Step 1: Implementar.**
- [ ] **Step 2: Verificação manual** — `@An` sugere Ana; `@02/07/2026` oferece nota do dia; chip clicável navega no mesmo painel; alvo aberto no outro painel → foco muda.
- [ ] **Step 3: Commit** — `feat: @ references with autocomplete and navigation`

---

### Task 17: Templates — UI

**Files:**
- Create: `src/ui/template-picker.ts`
- Modify: `src/ui/editor.ts` (botão 📋 + hook `/`)

**Interfaces:**
- Consumes: `templates.ts` (resolveTemplate), `Store`.
- Produces:
```ts
export function attachTemplatePicker(editor: Editor, opts: {
  getTemplates(): Template[]           // já filtrados por escopo do contexto (personal|daily|any)
  getCtx(): TemplateCtx
  locale: Locale
}): void
```
- `/` em linha vazia (ou botão 📋): dropdown com templates do escopo + `any`. Enter insere `mdToHtml(resolveTemplate(body, ctx))` na posição (remove o `/` digitado). Esc cancela.
- Gestão (criar/editar/excluir/reordenar/restaurar padrões) fica na Task 24 (modal de preferências) — aqui só inserção.

- [ ] **Step 1: Implementar.** — [ ] **Step 2: Verificação manual** — `/` em nota mostra templates, 1:1 insere com data resolvida. — [ ] **Step 3: Commit** — `feat: template insertion via slash and toolbar`

---

### Task 18: Módulo Notas diárias + calendário

**Files:**
- Create: `src/modules/daily-notes.ts`, `src/ui/calendar.ts`
- Modify: `src/main.ts` (registra renderer)

**Interfaces:**
- Consumes: `Editor`, `attachAtAutocomplete`, `attachTemplatePicker`, `Store`, `PaneManager`.
- Produces:
```ts
// calendar.ts
export function createCalendar(opts: {
  selected: string; locale: Locale
  marks: { hasNote(dateIso: string): boolean; milestones(dateIso: string): string[] }  // títulos p/ tooltip
  onPick(dateIso: string): void
}): HTMLElement
// mini-mensal: ‹ › mês, hoje = anel (outline accent), com nota = fundo --accent 20%, milestone = 🚩 canto sup. dir. com title=títulos.

// daily-notes.ts
export function renderDailyNotes(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void
```
- Layout do módulo: calendário à esquerda (colapsável), editor à direita ocupando o resto. Trocar dia pelo calendário = `pm.openInPane(paneIdx, loc com nova date)` (passa pela regra de duplicidade e histórico).
- Persistência: `onChange` do editor → `store.update(d => { team.dailyNotes[date] = md })`; md vazio/whitespace → `delete team.dailyNotes[date]`.
- Escopo de template: `daily`. Ctx: `{ dateIso: date, time: HH:mm agora, teamName }`.

- [ ] **Step 1: Implementar.** — [ ] **Step 2: Verificação manual** — escrever nota hoje, dia ganha cor no calendário; apagar tudo → cor some; abrir ontem+hoje em split; tentar mesmo dia 2× → foca painel existente. — [ ] **Step 3: Commit** — `feat: daily notes module with calendar`

---

### Task 19: Árvores de pessoas + notas pessoais

**Files:**
- Create: `src/modules/people-tree.ts` (stakeholders E membros — mesmo renderer parametrizado), `src/modules/person-notes.ts`
- Modify: `src/main.ts` (registra 3 renderers: stakeholders, members, person)

**Interfaces:**
- Produces:
```ts
export function renderPeopleTree(group: 'stakeholders' | 'members'): ModuleRenderer
export function renderPersonNotes(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void
```
- Árvore: raízes = `parentId === null` ordenadas por `order`; filhos indentados (recursão). Cada nó: nome — cargo, botões hover: editar (modal nome/cargo), excluir (confirmação; filhos sobem: `parentId = pai do excluído`, action items mantêm assignee como texto), + filho, 📝 abre notas da pessoa (via `pm.openInFocused`).
- Drag-and-drop: arrastar nó sobre outro = virar filho (drop no meio) ou irmão antes/depois (drop borda sup/inf — 25%/50%/25% da altura). Proibido soltar sobre descendente de si mesmo (checagem de ciclo). Atualiza `parentId`/`order` via `store.update`.
- Botão "+ pessoa" no topo adiciona raiz.
- `person-notes.ts`: header com nome/cargo + editor (escopo template `personal`, ctx com `personName`). Persiste em `person.notes`.

- [ ] **Step 1: Implementar.** — [ ] **Step 2: Verificação manual** — montar hierarquia 3 níveis por drag, excluir nó do meio (filhos sobem), notas de 2 pessoas em split, mesma pessoa 2× → foca existente. — [ ] **Step 3: Commit** — `feat: people trees with dnd and person notes`

---

### Task 20: Módulo Action items

**Files:**
- Create: `src/modules/action-items.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Produces: `export function renderActionItems(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void`
- Lista ordenada por `order` (drag p/ reordenar); cada linha: checkbox `done`, texto (input inline), due date (`<input type=date>`, vazio = sem data), assignee (input texto com `<datalist>` de stakeholders+membros do time — texto livre aceito). Vencido e aberto (`dueDate < todayIso() && !done`) → classe `.overdue` (texto vermelho + due date bold). Concluídos: riscados, agrupados no fim (toggle "mostrar concluídos"). Botão "+ item"; excluir por botão hover com confirmação apenas se texto não vazio.

- [ ] **Step 1: Implementar.** — [ ] **Step 2: Verificação manual** — criar itens, due ontem fica vermelho, assignee sugere pessoas mas aceita "Fornecedor X", reordenar, concluir. — [ ] **Step 3: Commit** — `feat: action items module`

---

### Task 21: Módulo Milestones + linha do tempo

**Files:**
- Create: `src/modules/milestones.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Produces: `export function renderMilestones(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void`
- Duas áreas:
  1. **Timeline** (topo): SVG horizontal 100% largura, altura ~90px. Milestones ordenados por data; eixo x proporcional ao tempo entre o primeiro e o último (mín. 24px entre vizinhos — se estourar, largura interna cresce e o container faz scroll-x). Cada marco: círculo (preenchido se `done`, cor `--muted` se data < hoje e não done, `--accent` futuro), label título embaixo (truncado 16 chars, `<title>` completo), data formatada em cima. Linha vertical "hoje" tracejada se hoje ∈ [min, max].
  2. **Lista**: linhas data (`<input type=date>`) + título (input) + checkbox done + excluir. Botão "+ milestone" (default: hoje). Ordenação automática por data.

- [ ] **Step 1: Implementar.** — [ ] **Step 2: Verificação manual** — 4 milestones com espaçamentos desiguais → distâncias proporcionais visíveis; marcar done muda visual; 🚩 aparece no calendário de notas diárias (Task 18 consome `milestones()`). — [ ] **Step 3: Commit** — `feat: milestones module with proportional timeline`

---

### Task 22: Módulo Riscos

**Files:**
- Create: `src/modules/risks.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Produces: `export function renderRisks(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void`
- Tabela: colunas Risco (input), Chance (select 1-3), Impacto (select 1-3), Exposição (calculada `chance*impact`, badge colorida: 1-2 `#16a34a`, 3-4 `#ca8a04`, 6-9 `#dc2626`), Plano (select com labels i18n: mitigar/transferir/eliminar/aceitar → valores `mitigate|transfer|eliminate|accept`), Follow-up (botão expande linha com `Editor` completo — escopo template `any`). Header "Exposição" clicável ordena desc/asc (ordenação de exibição; `order` do array preservado p/ ordem manual default). Botão "+ risco"; excluir com confirmação.

- [ ] **Step 1: Implementar.** — [ ] **Step 2: Verificação manual** — criar riscos, exposição recalcula ao mudar chance/impacto, cores corretas, follow-up com editor rico, ordenar por exposição. — [ ] **Step 3: Commit** — `feat: risks module with computed exposure`

---

### Task 23: UI de busca

**Files:**
- Create: `src/ui/search-ui.ts`
- Modify: `src/main.ts` (monta no `shell.headerLeft`)

**Interfaces:**
- Consumes: `searchDocument`, `normalize`, `PaneManager`.
- Produces: `export function mountSearch(shell: Shell, store: Store, pm: PaneManager): void`
- Input no header (placeholder i18n). Foco via Ctrl+F (preventDefault do nativo) ou `/` quando fora de campo editável. Checkbox "todos os times" dentro do dropdown. Digitação (debounce 150ms) → `searchDocument(doc, q, allTeams ? null : activeTeamId)`. Dropdown: cada resultado = ícone por moduleKind (📅 🧑 ✅ 🚩 ⚠️ conforme kind), `teamName` (se busca global), título, snippet com `<mark>` nos termos (matching via `normalize` com mapeamento de índices por comparação char a char normalizado). ↑↓ navega, Enter/clique → `pm.openInFocused(result.loc)`; Esc fecha e devolve foco.

- [ ] **Step 1: Implementar.** — [ ] **Step 2: Verificação manual** — buscar termo com acento errado acha; global encontra em outro time e troca de time ao abrir; Enter abre módulo certo. — [ ] **Step 3: Commit** — `feat: search ui with highlighted results`

---

### Task 24: Preferências, templates admin, senha, about

**Files:**
- Create: `src/ui/prefs.ts`
- Modify: `src/main.ts` (botão ⚙ real)

**Interfaces:**
- Consumes: `Store`, `Shell.applyPrefs`, `builtinTemplates`, `promptPassword`, callback `changePassword(newPw: string): Promise<void>` do app controller (re-cripta e salva).
- Produces: `export function openPrefs(store: Store, shell: Shell, appCtl: { changePassword(pw: string): Promise<void>; fileName: string }): void`
- Modal com abas:
  1. **Geral:** tema (3 radios), idioma (2 radios — re-render total ao mudar), fonte (3 radios), tamanho (S/M/L), auto-save (number 1-60 min). Tudo via `store.update(prefs)` + `shell.applyPrefs` imediato.
  2. **Templates:** lista (nome, escopo) com editar (modal: nome, escopo select, corpo em `<textarea>` monospace — corpo é md cru, placeholders documentados no rodapé do modal), duplicar, excluir (confirmação), reordenar (▲▼), "+ novo", "Restaurar padrões" (re-insere built-ins ausentes por nome).
  3. **Segurança:** trocar senha — senha atual (validada tentando decriptar? não: app controller guarda a senha da sessão; comparar) + nova 2× → `appCtl.changePassword`.
  4. **Sobre:** nome, `__APP_VERSION__`, `SCHEMA_VERSION` suportado, schemaVersion do arquivo, nome do arquivo.

- [ ] **Step 1: Implementar.** — [ ] **Step 2: Verificação manual** — trocar tema/fonte/idioma reflete na hora; criar template custom e usar via `/`; trocar senha, fechar, reabrir com a nova. — [ ] **Step 3: Commit** — `feat: preferences modal with templates admin and password change`

---

### Task 25: Orquestração de save + concorrência

**Files:**
- Create: `src/core/save-controller.ts`, `src/ui/conflict.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `Store`, `fs.ts`, `crypto.ts`, `Shell.setSaveState/setTitle`, `toast`, `showModal`.
- Produces:
```ts
export interface SaveController {
  saveNow(): Promise<void>       // encrypt + writeFile; ExternalChangeError → conflict.ts modal
  scheduleFrom(prefs: Prefs): void  // re-agenda timer quando autoSaveMin muda
  dispose(): void
}
export function createSaveController(deps: {
  store: Store; session: FileSession; getPassword(): string
  shell: Shell; locale: () => Locale
}): SaveController
```
- Gatilhos de save: timer (`autoSaveMin`), toda navegação de módulo/dia/time (hook no PaneManager: save assíncrono se dirty), Ctrl+S global (preventDefault), `visibilitychange → hidden` (best-effort), `beforeunload` (se dirty: `e.preventDefault()` — Chrome mostra prompt nativo; não dá para await de save confiável aqui, o prompt protege).
- Estados no header: saving → saved/error. Erro de gravação (permissão/disco): toast sticky "Falha ao salvar — dados seguem em memória" + botão "Salvar como…" (`pickCreate` novo arquivo) — o estado em memória nunca é descartado.
- `conflict.ts`: modal em `ExternalChangeError`: "Arquivo modificado externamente." Botões: **Recarregar** (readCurrent → decrypt → substitui doc — descarta locais, exige confirmação extra se dirty) | **Sobrescrever** (`forceWrite`).
- **Web Locks + BroadcastChannel** (mesmo browser): na abertura, `navigator.locks.request('tmv:' + fileId, { ifAvailable: true }, ...)` onde `fileId` = nome do arquivo (heurística suficiente). Sem lock → banner "Somente leitura — arquivo aberto em outra aba" + botão "Assumir controle" → posta `takeover` no `BroadcastChannel('tmv:' + fileId)`; a detentora salva, entra em read-only e libera o lock; a nova adquire e sai do read-only. Read-only: `store.update` bloqueado (toast).
- Fallback download (sem FS API): saveNow → `downloadFallback`; auto-save timer desligado, indicador mostra "download manual".

- [ ] **Step 1: Implementar.**
- [ ] **Step 2: Verificação manual** — editar, esperar auto-save (setar 1 min), indicador cicla; Ctrl+S; modificar o arquivo por fora (copiar por cima) → próximo save abre modal de conflito; abrir 2ª aba mesmo arquivo → read-only + takeover funciona; fechar aba com dirty → Chrome pergunta.
- [ ] **Step 3: Commit** — `feat: save orchestration, conflict handling and tab locking`

---

### Task 26: PWA + deploy

**Files:**
- Create: `pwa/manifest.json`, `pwa/sw.js`, `pwa/icon.svg` (ícone simples: quadrado arredondado `--accent` com "TT" branco)
- Modify: `scripts/build.mjs`, `src/main.ts`

**Interfaces:**
- Produces: `dist/pwa/` completo (index.html + manifest + sw + ícone). `src/main.ts`: `if (__PWA__ && 'serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js')`.
- `manifest.json`: name "Team Tracker", display `standalone`, ícone svg (192/512 via `sizes: any`), theme/background colors.
- `sw.js`: cache-first do shell (`index.html`, `manifest.json`, `icon.svg`), cache name com versão (`tt-v${APP_VERSION}` — build injeta via replace), `activate` limpa caches antigos.
- `build.mjs`: copia `pwa/*` p/ `dist/pwa/`, injeta `<link rel=manifest>` e versão no sw.
- README curto na raiz: como buildar, como publicar `dist/pwa/` no GitHub Pages (branch `gh-pages` ou Settings→Pages→/docs), como usar `app.html` via file://.

- [ ] **Step 1: Implementar.**
- [ ] **Step 2: Verificação manual** — `npx serve dist/pwa` (ou `python -m http.server`): Chrome mostra ícone de instalação; instalar abre janela standalone; `dist/app.html` via file:// continua funcionando sem SW.
- [ ] **Step 3: Commit** — `feat: pwa variant with manifest and service worker`
- [ ] **Step 4: Rodar suite completa + build final** — `npm test && npm run build` → tudo verde. Smoke test manual completo: criar arquivo → 2 times → pessoas/hierarquia → action items → milestones (timeline + 🚩 calendário) → riscos → notas com templates, refs, busca → split → trocar senha → fechar/reabrir.

---

## Self-Review (executado na escrita do plano)

- **Cobertura do spec:** arquivo/cripto (T3, T10, T12, T25), modelo de dados (T2), layout/navegação/duplicidade/histórico (T7, T14), calendário com nota+🚩 (T18, T21), editor+atalhos+help+colar-puro (T15), refs `@` (T16), templates+admin (T9, T17, T24), busca+toggle global (T8, T23), i18n/tema/fonte (T5, T11, T24), versões título/about (T11, T24), concorrência Web Locks+lastModified (T10, T25), fallback sem FS API (T10, T12, T25), PWA+file://+fullscreen+`chrome --app` (T11, T15, T26), erros (T12, T25), fora-de-escopo respeitado (sem undo global, sem export, sem anexos).
- **Tipos consistentes:** `Doc` (não `Document` — evita colisão com DOM), `Loc`, `PaneState.history/index`, `ModuleRef` discriminado — verificados entre T2/T7/T14/T16/T23.
- **Placeholders:** nenhum TBD; tasks de UI têm comportamento especificado item a item com verificação manual explícita.
