# Editor: Inline Code, Blockquote, External Links, HR Button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline code (`` `code` ``), blockquote (`> text`), external links (`[text](url)`, always new-tab), and a discoverable HR toolbar button to the shared rich-text editor; move the command palette off `Ctrl+K` so `Ctrl+K` can insert a link.

**Architecture:** `src/core/markdown.ts` gains three round-trip-safe markdown constructs. The dangerous ones (code, link) are extracted to Private-Use-Area placeholder tokens at the *start* of `inline()` and spliced back as raw HTML at the *end*, after every other regex pass — the exact mechanism the existing `@`-ref chips use, for the exact same reason (later passes must never see the raw attribute markup). A new `safeHref()` scheme allowlist gates every link. `src/ui/editor.ts` gets four toolbar buttons and three keyboard shortcuts. `src/main.ts` moves the palette to `Ctrl+Shift+K`. `styles.css`, `help.ts`, and `i18n.ts` document it.

**Tech Stack:** TypeScript (strict), Vitest + jsdom (no real `execCommand` / no contenteditable layout — DOM-manipulation code is directly testable; `execCommand`-based code is asserted via a spy, matching the existing list-command tests), zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-29-editor-code-quote-link-hr-design.md`

## Global Constraints

- **Zero runtime dependencies.** `esbuild`/`typescript`/`vitest`/`jsdom`/`@playwright/test` are dev-only. Add none.
- **Every `src` module has a matching `test/*.test.ts`.** New helpers go in existing test files (`test/markdown.test.ts`, `test/editor.test.ts`, `test/help.test.ts`).
- **i18n: every user-visible string via `t(locale, key)`, keys added to BOTH `pt-BR` and `en-US`.** `MsgKey = keyof typeof pt` and `const en: Record<MsgKey, string>` — a key added to `pt` but not `en` fails `npm run typecheck`. That is the parity guard.
- **Markdown is the persisted format** (inside the `.tmv` file's JSON). Round-trip (`md → html → md`) must be byte-stable and idempotent through repeat cycles. No `SCHEMA_VERSION` bump — markdown is just a string field; older builds render new syntax as literal text, which is acceptable degradation.
- **Desktop Chromium only.** No mobile/responsive work.
- **Commits go directly to `dev`** (no feature branch). Conventional Commits. End commit messages with:
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
- **Run from Git Bash / Bash tool** so the `rtk` hook applies. Commands: `npx vitest run <file>`, `npm run typecheck`, `npm run lint`, `npm run build`.
- **Blockquote is flat** — no nesting (mirrors H1–H3). **Inline code content is literal** — no nested markdown. **Links: `http:`/`https:`/`mailto:` only**, everything else drops to plain text; every rendered link carries `target="_blank" rel="noopener noreferrer nofollow"`.

---

## File Structure

| File | Responsibility for this feature |
|---|---|
| `src/core/markdown.ts` | New `safeHref()`; `inline()` placeholder ordering for code + link; `mdToHtml` blockquote accumulation; `inlineMd`/`htmlToMd`/`htmlToPlainText` reverse handlers; `flattenNestedBlockquotes()`; `BLOCK_TAGS` += `blockquote`. |
| `test/markdown.test.ts` | Round-trip + idempotency + security tests for all three constructs and `safeHref`. |
| `src/ui/editor.ts` | 4 toolbar buttons (`<>` `❝` `—` `🔗`); handlers `toggleInlineCode` / `toggleBlockquote` / `insertHr` / `insertLink` + `promptLinkUrl`; keyboard `Ctrl+E` / `Ctrl+Shift+9` / `Ctrl+K`; typed `[text](url)` autoformat; `clearFormatting` also demotes blockquote. |
| `test/editor.test.ts` | Button presence + **locked toolbar order**; handler behaviour; shortcut mapping; paste sanitisation; autoformat. |
| `src/main.ts` | Palette trigger `Ctrl+K` → `Ctrl+Shift+K`. |
| `src/ui/help.ts` | `SHORTCUT_ROWS` += code/quote/link; `MD_ROWS` += code/quote/link; `GLOBAL_ROWS` palette row → `Ctrl+Shift+K`. |
| `test/help.test.ts` | New rows render; palette row shows new chord. |
| `src/core/i18n.ts` | 11 new keys ×2 locales; `editor_strike_title` updated ×2. |
| `styles.css` | `.editor code`, `.editor blockquote`, `.editor a[href]`. |
| `CHANGELOG.md`, `package.json` | Version bump + matching `## [X.Y.Z]` section. |

---

## Task 1: `safeHref()` URL scheme allowlist

**Files:**
- Modify: `src/core/markdown.ts` (add near the top, after the `esc` const on line 3)
- Test: `test/markdown.test.ts`

**Interfaces:**
- Produces: `export function safeHref(raw: string): string | null` — returns the trimmed URL unchanged when its scheme is `http:`, `https:`, or `mailto:` and it contains no control/whitespace characters; returns `null` otherwise (no scheme, disallowed scheme, embedded control char).

- [ ] **Step 1: Write the failing test**

Add to `test/markdown.test.ts`:

```ts
import { mdToHtml, htmlToMd, htmlToPlainText, parseRef, safeHref, unwrapBlockContainers, flattenNestedHeadings, flattenNestedBlockquotes, demoteHeadings } from '../src/core/markdown'

describe('safeHref', () => {
  test('accepts http/https/mailto unchanged', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeHref('http://example.com')).toBe('http://example.com')
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com')
    expect(safeHref('  https://example.com  ')).toBe('https://example.com')
  })
  test('rejects javascript/data/vbscript and scheme-relative/relative', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('JavaScript:alert(1)')).toBeNull()
    expect(safeHref('data:text/html,x')).toBeNull()
    expect(safeHref('vbscript:msgbox')).toBeNull()
    expect(safeHref('/relative/path')).toBeNull()
    expect(safeHref('#frag')).toBeNull()
    expect(safeHref('example.com')).toBeNull()
  })
  test('rejects a scheme smuggled past a control character', () => {
    expect(safeHref('java\tscript:alert(1)')).toBeNull()
    expect(safeHref('java\nscript:alert(1)')).toBeNull()
    expect(safeHref('  java script:alert(1)')).toBeNull()
  })
})
```

Note: this step also adds `safeHref` and `flattenNestedBlockquotes` to the import line — `flattenNestedBlockquotes` lands in Task 4; if you run only this file before Task 4, temporarily drop it from the import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/markdown.test.ts -t safeHref`
Expected: FAIL — `safeHref is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/markdown.ts`, immediately after `const esc = ...` (line 3):

```ts
const ALLOWED_SCHEMES = ['http:', 'https:', 'mailto:']

/**
 * Returns `raw` (trimmed) when it is a safe external URL to put in an
 * `href`, else `null`. Safe = an explicit `http:` / `https:` / `mailto:`
 * scheme and no ASCII control or whitespace character anywhere (the latter
 * blocks `java\tscript:` / `java\nscript:` smuggling, which browsers
 * tolerate in an href). Relative, scheme-relative and fragment-only URLs
 * are rejected: this app has no server, so an in-doc relative link is
 * always a mistake, and rejecting them keeps the allowlist total.
 */
export function safeHref(raw: string): string | null {
  const url = raw.trim()
  if (!url || /[\u0000-\u0020\u007f]/.test(url)) return null
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(url)
  if (!m) return null
  return ALLOWED_SCHEMES.includes(m[1]!.toLowerCase()) ? url : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/markdown.test.ts -t safeHref`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/markdown.ts test/markdown.test.ts
git commit -m "$(printf 'feat(markdown): add safeHref URL scheme allowlist\n\nhttp/https/mailto only; rejects javascript:/data:/relative and any\nscheme smuggled past a control char. Foundation for external links.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 2: Inline code `` `code` `` round-trip

**Files:**
- Modify: `src/core/markdown.ts` — `inline()` (lines 22–67); `inlineMd()` (lines 181–224, add `<code>` case); `htmlToPlainText`'s `walk` (lines 528–544) and `htmlToMd`'s `walk` are unaffected (code is inline, handled inside `inlineMd`/`inlineText`); `inlineText()` (lines 489–494, add `<code>` passthrough — it already recurses children, so `<code>x</code>` → `x` for free; no change needed, but verify with a test).
- Test: `test/markdown.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces: `` `x` `` in markdown ⇔ `<code>x</code>` in HTML. Content is literal — no ref/bold/italic/strike/underline parsing inside. New module-level constants `CODE_OPEN` (U+E002) and `CODE_CLOSE` (U+E003) - PUA, same rationale as the existing `REF_OPEN`/`REF_CLOSE` (U+E000/U+E001).

- [ ] **Step 1: Write the failing test**

Add to `test/markdown.test.ts`:

```ts
describe('inline code', () => {
  const roundTrip = (md: string) => {
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    return htmlToMd(div)
  }
  test('renders <code> and round-trips', () => {
    expect(mdToHtml('run `npm test` now')).toContain('<code>npm test</code>')
    expect(roundTrip('run `npm test` now')).toBe('run `npm test` now')
  })
  test('content is literal — inner markdown is NOT parsed', () => {
    const html = mdToHtml('see `**not bold** and *not italic*`')
    expect(html).toContain('<code>**not bold** and *not italic*</code>')
    expect(html).not.toContain('<strong>')
    expect(html).not.toContain('<em>')
    expect(roundTrip('see `**not bold** and *not italic*`')).toBe('see `**not bold** and *not italic*`')
  })
  test('code adjacent to a ref chip — both survive', () => {
    const md = '`cfg` @[Ana](person:abc-1) `end`'
    const html = mdToHtml(md)
    expect(html).toContain('<code>cfg</code>')
    expect(html).toContain('<code>end</code>')
    expect(html).toContain('data-ref="person:abc-1"')
    expect(roundTrip(md)).toBe(md)
  })
  test('html inside a code span is escaped, not live', () => {
    const html = mdToHtml('danger `<img src=x onerror=y>` here')
    const probe = document.createElement('div'); probe.innerHTML = html
    expect(probe.querySelector('img')).toBeNull()
    expect(probe.querySelector('code')!.textContent).toBe('<img src=x onerror=y>')
  })
  test('idempotent through two md->html->md cycles', () => {
    const md = 'a `b` c'
    expect(roundTrip(roundTrip(md))).toBe(md)
  })
  test('inlineText / htmlToPlainText unwraps code to bare text', () => {
    const div = document.createElement('div'); div.innerHTML = mdToHtml('run `x` now')
    expect(htmlToPlainText(div)).toBe('run x now')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/markdown.test.ts -t "inline code"`
Expected: FAIL — `<code>` not produced; content gets bold-parsed.

- [ ] **Step 3: Write minimal implementation**

In `src/core/markdown.ts`:

**(a)** After the `REF_PLACEHOLDER` const (line 20), add:

```ts
// Same PUA rationale as REF_OPEN/REF_CLOSE above: code points no
// markdown/HTML pass below matches and esc() never emits. Code spans are
// extracted FIRST (before refs) so their contents are frozen against every
// later pass — that literalness is the whole point of an inline code span.
const CODE_OPEN = '\uE002'
const CODE_CLOSE = '\uE003'
const CODE_PLACEHOLDER = new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g')
```

**(b)** In `inline()`, immediately after `let out = esc(s)` (line 23) and BEFORE the `const refChips` line:

```ts
  // Code spans first: their content must survive every pass below untouched.
  const codeSpans: string[] = []
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`)
    return `${CODE_OPEN}${codeSpans.length - 1}${CODE_CLOSE}`
  })
```

**(c)** In `inline()`, just before `return out` (line 66), after the existing `REF_PLACEHOLDER` splice line:

```ts
  out = out.replace(CODE_PLACEHOLDER, (m, i: string) => codeSpans[Number(i)] ?? m)
```

**(d)** In `inlineMd()` (line 181+), add BEFORE the generic tag-based formatting block — a good spot is right after the `if (tag === 'br') return ''` line (line 193):

```ts
  // Literal content, no child recursion — mirrors inline()'s freeze.
  if (tag === 'code') return '`' + (node.textContent ?? '').replace(/ /g, ' ') + '`'
```

`inlineText()` needs no change: it already recurses `node.childNodes`, so `<code>x</code>` → `x`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/markdown.test.ts -t "inline code"`
Expected: PASS (6 tests).
Then: `npx vitest run test/markdown.test.ts` — Expected: all existing tests still PASS (check the "inline formats round-trip" and ref tests especially).

- [ ] **Step 5: Commit**

```bash
git add src/core/markdown.ts test/markdown.test.ts
git commit -m "$(printf 'feat(markdown): inline code spans (backtick), content literal\n\nExtracted to a PUA placeholder at the start of inline() and spliced back\nlast, so no bold/italic/strike/ref pass ever touches the contents.\nRound-trips and is idempotent.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 3: External links `[text](url)` round-trip + security

**Files:**
- Modify: `src/core/markdown.ts` — `inline()` (link extraction pass + splice); `inlineMd()` (`<a>` without `data-ref`). `htmlToPlainText` needs no change (a link nested in a block is flattened to text by `inlineText`; assert it).
- Test: `test/markdown.test.ts`

**Interfaces:**
- Consumes: `safeHref` (Task 1); `CODE_*` placeholder pattern precedent (Task 2).
- Produces: `[text](url)` in markdown ⇔ `<a href="url" target="_blank" rel="noopener noreferrer nofollow">text</a>` when `safeHref(url)` is non-null; otherwise the link degrades to its bare `text`. Link *text* still takes inline formatting (`[**x**](u)` → bold inside the anchor). New constants `LINK_OPEN` (U+E004) and `LINK_CLOSE` (U+E005).

- [ ] **Step 1: Write the failing test**

Add to `test/markdown.test.ts`:

```ts
describe('external links', () => {
  const roundTrip = (md: string) => {
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    return htmlToMd(div)
  }
  test('renders a new-tab anchor and round-trips', () => {
    const html = mdToHtml('see [the docs](https://example.com/x)')
    const probe = document.createElement('div'); probe.innerHTML = html
    const a = probe.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://example.com/x')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(a.textContent).toBe('the docs')
    expect(roundTrip('see [the docs](https://example.com/x)')).toBe('see [the docs](https://example.com/x)')
  })
  test('formatting inside link text is preserved', () => {
    const html = mdToHtml('[**bold** text](https://e.com)')
    expect(html).toContain('<strong>bold</strong>')
    expect(roundTrip('[**bold** text](https://e.com)')).toBe('[**bold** text](https://e.com)')
  })
  test('disallowed schemes drop the link, keep the visible text', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '  javascript:alert(1)', 'java\tscript:alert(1)']) {
      const html = mdToHtml(`click [here](${bad}) now`)
      const probe = document.createElement('div'); probe.innerHTML = html
      expect(probe.querySelector('a')).toBeNull()
      expect(probe.textContent).toContain('click here now')
    }
  })
  test('a url with markdown-special chars cannot break out of the href attribute', () => {
    const md = '[x](https://e.com/~a~~b"onmouseover="1)'
    const html = mdToHtml(md)
    const probe = document.createElement('div'); probe.innerHTML = html
    expect(probe.querySelector('[onmouseover]')).toBeNull()
    expect(probe.querySelectorAll('a').length).toBeLessThanOrEqual(1)
  })
  test('link text cannot contain a closing bracket (documented boundary)', () => {
    // [a]b](url) — [^\]]+ stops at the first ], so this stays literal.
    expect(mdToHtml('[a]b](https://e.com)')).not.toContain('<a ')
  })
  test('htmlToMd re-validates href on the way out (defence in depth)', () => {
    const div = document.createElement('div')
    div.innerHTML = '<div><a href="javascript:alert(1)">x</a></div>'
    expect(htmlToMd(div)).toBe('x')
  })
  test('htmlToPlainText drops the URL, keeps the text', () => {
    const div = document.createElement('div'); div.innerHTML = mdToHtml('see [docs](https://e.com) here')
    expect(htmlToPlainText(div)).toBe('see docs here')
  })
  test('idempotent through two cycles', () => {
    const md = 'a [b](https://e.com) c'
    expect(roundTrip(roundTrip(md))).toBe(md)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/markdown.test.ts -t "external links"`
Expected: FAIL — no `<a>` produced.

- [ ] **Step 3: Write minimal implementation**

In `src/core/markdown.ts`:

**(a)** After the `CODE_PLACEHOLDER` const (Task 2), add:

```ts
const LINK_OPEN = '\uE004'
const LINK_CLOSE = '\uE005'
const LINK_PLACEHOLDER = new RegExp(`${LINK_OPEN}(\\d+)${LINK_CLOSE}`, 'g')
```

**(b)** In `inline()`, add the link pass immediately AFTER the ref `out.replace(REF_PATTERN, …)` block (after line 50) and BEFORE the `out = out.replace(/\*\*…/` bold pass (line 51):

```ts
  // Links: freeze only the opening <a …> tag (it carries quotes/attrs the
  // passes below would corrupt). The closing </a> is inert to every pass
  // below (no *, ~, or escaped <u>), so it stays literal — which leaves the
  // link TEXT in the string to be formatted by those same passes.
  const linkTags: string[] = []
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, rawUrl: string) => {
    const href = safeHref(rawUrl)
    if (!href) return text
    linkTags.push(`<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">`)
    return `${LINK_OPEN}${linkTags.length - 1}${LINK_CLOSE}${text}</a>`
  })
```

**(c)** In `inline()`, add the splice just after the `CODE_PLACEHOLDER` splice from Task 2 (before `return out`):

```ts
  out = out.replace(LINK_PLACEHOLDER, (m, i: string) => linkTags[Number(i)] ?? m)
```

**(d)** In `inlineMd()`, add right after the existing `if (tag === 'a' && node.dataset.ref) { … }` block (ends line 192):

```ts
  if (tag === 'a' && !node.dataset.ref) {
    const href = safeHref(node.getAttribute('href') ?? '')
    const text = kids().replace(/[[\]]/g, '')
    return href ? `[${text}](${href})` : text
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/markdown.test.ts -t "external links"`
Expected: PASS (8 tests).
Then: `npx vitest run test/markdown.test.ts` — all existing PASS. Watch the `escapes html` and ref-injection tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/markdown.ts test/markdown.test.ts
git commit -m "$(printf 'feat(markdown): external links [text](url), always target=_blank\n\nsafeHref gates the scheme; the opening <a> tag is placeholder-frozen so\nlater inline passes cannot break out of the href attribute; link text is\nleft inline so it still gets bold/italic. htmlToMd re-validates on export.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 4: Blockquote `> text` round-trip + `flattenNestedBlockquotes`

**Files:**
- Modify: `src/core/markdown.ts` — `mdToHtml()` block loop (lines 118–129); `htmlToMd()` `walk` (add `blockquote` branch, near line 561); `htmlToPlainText()` `walk` (add `blockquote` branch, near line 541); `BLOCK_TAGS` (line 321); add `flattenNestedBlockquotes()` near `flattenNestedHeadings()` (line 396).
- Test: `test/markdown.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces: `> text` line(s) in markdown ⇔ a single flat `<blockquote>` (consecutive `>` lines merge, joined by `<br>`; a bare `>` line is a blank line inside). `export function flattenNestedBlockquotes(root: HTMLElement): void` — unwraps any `<blockquote>` nested inside another (idempotent; bounded loop), consumed by Task 7.

- [ ] **Step 1: Write the failing test**

Add to `test/markdown.test.ts`:

```ts
describe('blockquote', () => {
  const roundTrip = (md: string) => {
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    return htmlToMd(div)
  }
  test('single line renders <blockquote> and round-trips', () => {
    expect(mdToHtml('> a quote')).toBe('<blockquote>a quote</blockquote>')
    expect(roundTrip('> a quote')).toBe('> a quote')
  })
  test('consecutive > lines merge into one blockquote, <br>-joined', () => {
    expect(mdToHtml('> line one\n> line two')).toBe('<blockquote>line one<br>line two</blockquote>')
    expect(roundTrip('> line one\n> line two')).toBe('> line one\n> line two')
  })
  test('a bare > line is a blank line inside the quote', () => {
    expect(roundTrip('> a\n>\n> b')).toBe('> a\n>\n> b')
    expect(mdToHtml('> a\n>\n> b')).toBe('<blockquote>a<br><br>b</blockquote>')
  })
  test('blockquote closes an open list first', () => {
    expect(mdToHtml('- item\n> quote')).toBe('<ul><li>item</li></ul><blockquote>quote</blockquote>')
  })
  test('quote directly before and after a heading', () => {
    expect(roundTrip('> q\n# H\n> q2')).toBe('> q\n# H\n> q2')
  })
  test('inline formatting and refs work inside a quote', () => {
    const html = mdToHtml('> see **bold** and @[Ana](person:x)')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('data-ref="person:x"')
    expect(roundTrip('> see **bold** and @[Ana](person:x)')).toBe('> see **bold** and @[Ana](person:x)')
  })
  test('htmlToPlainText prefixes quote lines with "> "', () => {
    const div = document.createElement('div'); div.innerHTML = mdToHtml('> a\n> b')
    expect(htmlToPlainText(div)).toBe('> a\n> b')
  })
  test('idempotent through two cycles', () => {
    const md = '> a\n> b'
    expect(roundTrip(roundTrip(md))).toBe(md)
  })
})

describe('flattenNestedBlockquotes', () => {
  test('unwraps a blockquote nested inside another', () => {
    const root = document.createElement('div')
    root.innerHTML = '<blockquote>outer<blockquote>inner</blockquote></blockquote>'
    flattenNestedBlockquotes(root)
    expect(root.querySelectorAll('blockquote').length).toBe(1)
    expect(root.querySelector('blockquote')!.textContent).toBe('outerinner')
  })
  test('leaves a single well-formed blockquote untouched', () => {
    const root = document.createElement('div')
    root.innerHTML = '<blockquote>just one</blockquote>'
    flattenNestedBlockquotes(root)
    expect(root.innerHTML).toBe('<blockquote>just one</blockquote>')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/markdown.test.ts -t "blockquote"`
Expected: FAIL — `> a quote` renders as a `<div>`; `flattenNestedBlockquotes` undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/core/markdown.ts`:

**(a)** `mdToHtml()` — replace the `for (const line of lines) { … }` loop plus the trailing `closeList(); return out.join('')` (lines 118–129) with:

```ts
  let bqBuf: string[] | null = null
  const flushBq = () => {
    if (bqBuf === null) return
    const inner = bqBuf
      .map(l => blockInline(preserveIndent(l), resolveLabel, refTitle) || '<br>')
      .join('<br>')
    out.push(`<blockquote>${inner}</blockquote>`)
    bqBuf = null
  }
  for (const line of lines) {
    const bq = /^> ?(.*)$/.exec(line)
    if (bq) { closeList(); (bqBuf ??= []).push(bq[1]!); continue }
    flushBq()
    const h = /^(#{1,3}) (.*)$/.exec(line)
    const ul = /^( *)- (.*)$/.exec(line)
    const ol = /^( *)(\d+)\. (.*)$/.exec(line)
    const hr = /^-{3,}$/.test(line)
    if (h) { closeList(); out.push(`<h${h[1]!.length}>${blockInline(preserveIndent(h[2]!), resolveLabel, refTitle)}</h${h[1]!.length}>`) }
    else if (ul) addListItem(Math.floor(ul[1]!.length / 2), 'ul', blockInline(preserveIndent(ul[2]!), resolveLabel, refTitle), '')
    else if (ol) addListItem(Math.floor(ol[1]!.length / 2), 'ol', blockInline(preserveIndent(ol[3]!), resolveLabel, refTitle), ` value="${ol[2]}"`)
    else if (hr) { closeList(); out.push('<hr>') }
    else { closeList(); out.push(`<div>${line ? blockInline(preserveIndent(line), resolveLabel, refTitle) : '<br>'}</div>`) }
  }
  flushBq(); closeList(); return out.join('')
```

**(b)** `BLOCK_TAGS` (line 321) — add `'blockquote'`:

```ts
export const BLOCK_TAGS = new Set(['div', 'p', 'ul', 'ol', 'h1', 'h2', 'h3', 'hr', 'table', 'blockquote'])
```

**(c)** `htmlToMd()` `walk` — add before the `else if (tag === 'div' || tag === 'p')` line (line 563):

```ts
    else if (tag === 'blockquote') { for (const l of blockToMd(node).split('\n')) out.push(l ? `> ${l}` : '>') }
```

**(d)** `htmlToPlainText()` `walk` — add before the `else if (/^h[1-3]$/.test(tag) …)` line (line 541):

```ts
    else if (tag === 'blockquote') { for (const l of blockToText(node).split('\n')) out.push(l ? `> ${l}` : '>') }
```

**(e)** After `flattenNestedHeadings()` (ends line 407), add:

```ts
/**
 * The editor's ❝ button / Ctrl+Shift+9 route through
 * `execCommand('formatBlock', '<blockquote>')`, which — like the heading
 * case `flattenNestedHeadings` fixes — can NEST a fresh <blockquote> inside
 * an existing one on a repeat press or a multi-line selection. This app's
 * blockquote is flat (no nesting), so any blockquote inside another is
 * unwrapped; repeated presses collapse to one. Idempotent.
 */
export function flattenNestedBlockquotes(root: HTMLElement): void {
  for (let pass = 0; pass < 100; pass++) {
    const nested = Array.from(root.querySelectorAll<HTMLElement>('blockquote')).find(
      (b) => b.parentElement?.closest('blockquote')
    )
    if (!nested) return
    nested.replaceWith(...nested.childNodes)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/markdown.test.ts -t "blockquote"` — PASS (10 tests).
Then: `npx vitest run test/markdown.test.ts` — all existing PASS (the `headers and lists`, `hr`, and `unwrapBlockContainers` tests especially).

- [ ] **Step 5: Commit**

```bash
git add src/core/markdown.ts test/markdown.test.ts
git commit -m "$(printf 'feat(markdown): flat blockquote (> text), round-trip + nesting guard\n\nConsecutive > lines merge into one <blockquote>; bare > is a blank inner\nline. flattenNestedBlockquotes() mirrors flattenNestedHeadings for the\neditor formatBlock path. BLOCK_TAGS gains blockquote.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 5: i18n keys (both locales)

**Files:**
- Modify: `src/core/i18n.ts` — the `pt` object (keys around lines 244–316, 494) and the `en` object (from line 513).
- Test: `test/i18n.test.ts`

**Interfaces:**
- Produces these `MsgKey`s (both locales): `editor_code_title`, `editor_quote_title`, `editor_hr_title`, `editor_link_title`, `editor_link_prompt`, `help_shortcut_code`, `help_shortcut_quote`, `help_shortcut_link`, `help_md_code`, `help_md_quote`, `help_md_link`. Also updates `editor_strike_title` in both locales.

- [ ] **Step 1: Write the failing test**

Add to `test/i18n.test.ts`:

```ts
test('editor code/quote/hr/link keys exist in both locales', () => {
  for (const loc of ['pt-BR', 'en-US'] as const) {
    for (const k of ['editor_code_title', 'editor_quote_title', 'editor_hr_title', 'editor_link_title', 'editor_link_prompt', 'help_shortcut_code', 'help_shortcut_quote', 'help_shortcut_link', 'help_md_code', 'help_md_quote', 'help_md_link'] as const) {
      expect(t(loc, k).length).toBeGreaterThan(0)
    }
  }
})
test('strike title now names both chords', () => {
  expect(t('en-US', 'editor_strike_title')).toContain('Ctrl+Shift+X')
  expect(t('en-US', 'editor_strike_title')).toContain('Ctrl+Shift+5')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/i18n.test.ts`
Expected: FAIL — keys missing / strike title lacks `Ctrl+Shift+X`. (Also `npm run typecheck` fails once you add to `pt` — that is expected until `en` matches.)

- [ ] **Step 3: Write minimal implementation**

In `src/core/i18n.ts`, add to the **`pt` object** near `editor_help_title` (line 255):

```ts
  editor_code_title: 'Código embutido (Ctrl+E)',
  editor_quote_title: 'Citação (Ctrl+Shift+9)',
  editor_hr_title: 'Linha divisória',
  editor_link_title: 'Inserir link (Ctrl+K)',
  editor_link_prompt: 'Endereço do link (URL):',
```

near `help_shortcut_paragraph` (line 264):

```ts
  help_shortcut_code: 'Código embutido',
  help_shortcut_quote: 'Citação',
  help_shortcut_link: 'Link',
```

near `help_md_hr` (line 272):

```ts
  help_md_code: 'Código embutido',
  help_md_quote: 'Citação',
  help_md_link: 'Link (abre em nova aba)',
```

and **change** `editor_strike_title` (line 248) to:

```ts
  editor_strike_title: 'Tachado (Ctrl+Shift+X ou Ctrl+Shift+5)',
```

Then mirror all of that in the **`en` object**: near `editor_help_title` (~line 749):

```ts
  editor_code_title: 'Inline code (Ctrl+E)',
  editor_quote_title: 'Blockquote (Ctrl+Shift+9)',
  editor_hr_title: 'Horizontal rule',
  editor_link_title: 'Insert link (Ctrl+K)',
  editor_link_prompt: 'Link address (URL):',
```

near `help_shortcut_paragraph`:

```ts
  help_shortcut_code: 'Inline code',
  help_shortcut_quote: 'Blockquote',
  help_shortcut_link: 'Link',
```

near `help_md_hr`:

```ts
  help_md_code: 'Inline code',
  help_md_quote: 'Blockquote',
  help_md_link: 'Link (opens in a new tab)',
```

and **change** `editor_strike_title` (~line 742) to:

```ts
  editor_strike_title: 'Strikethrough (Ctrl+Shift+X or Ctrl+Shift+5)',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/i18n.test.ts` — PASS.
Run: `npm run typecheck` — PASS (parity restored).

- [ ] **Step 5: Commit**

```bash
git add src/core/i18n.ts test/i18n.test.ts
git commit -m "$(printf 'feat(i18n): keys for inline code, blockquote, link, HR button\n\nBoth locales. editor_strike_title now names Ctrl+Shift+X and Ctrl+Shift+5.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 6: Editor `<>` inline-code button + `toggleInlineCode`

**Files:**
- Modify: `src/ui/editor.ts` — add `toggleInlineCode()` near the other format helpers (after `clearFormatting`, ~line 454); add the toolbar button in the `toolbar` array (lines 1083–1102).
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: `<code>` ⇔ `` `x` `` from Task 2; existing `setCaretAfter`, `scheduleChange`, `currentBlockAndOffset`.
- Produces: `toggleInlineCode()` — wraps a non-collapsed selection in `<code>`; if the selection sits fully inside an existing `<code>`, unwraps it; bails if the selection crosses an element boundary. Toolbar button glyph `<>`, `title: t(locale, 'editor_code_title')`, placed immediately after the `S` (strike) button.

- [ ] **Step 1: Write the failing test**

Add to `test/editor.test.ts` inside `describe('toolbar', …)`:

```ts
test('<> button wraps the selection in <code> and getMd emits backticks', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  editor.setMd('foo bar baz')
  const editorEl = editor.root.querySelector('.editor') as HTMLElement
  const textNode = editorEl.querySelector('div')!.firstChild as Text
  const range = document.createRange()
  range.setStart(textNode, 4); range.setEnd(textNode, 7) // "bar"
  const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

  toolbarButton(editor, t('en-US', 'editor_code_title')).click()

  expect(editorEl.querySelector('code')?.textContent).toBe('bar')
  expect(editor.getMd()).toBe('foo `bar` baz')
  editor.destroy()
})

test('<> button on a selection already inside <code> unwraps it', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  editor.setMd('foo `bar` baz')
  const editorEl = editor.root.querySelector('.editor') as HTMLElement
  const codeText = editorEl.querySelector('code')!.firstChild as Text
  const range = document.createRange()
  range.selectNodeContents(codeText)
  const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

  toolbarButton(editor, t('en-US', 'editor_code_title')).click()

  expect(editorEl.querySelector('code')).toBeNull()
  expect(editor.getMd()).toBe('foo bar baz')
  editor.destroy()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/editor.test.ts -t "<> button"`
Expected: FAIL — `toolbarButton(...)` is `undefined` (no such button).

- [ ] **Step 3: Write minimal implementation**

In `src/ui/editor.ts`, after `clearFormatting()` (line 454):

```ts
  /**
   * The `<>` button / Ctrl+E. Wraps a non-empty selection in <code>, or
   * unwraps it if it already sits fully inside one. Bails on a selection
   * that crosses an element boundary (a ref chip, existing formatting) —
   * same "text-only spans only" rule replaceInlineMatch uses.
   */
  function toggleInlineCode(): void {
    editorEl.focus()
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    if (!editorEl.contains(range.commonAncestorContainer)) return

    const container = range.commonAncestorContainer
    const existing = (container instanceof HTMLElement ? container : container.parentElement)?.closest('code')
    if (existing && editorEl.contains(existing)) {
      const parent = existing.parentNode!
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing)
      parent.removeChild(existing)
      scheduleChange()
      return
    }
    if (range.cloneContents().querySelector('*')) return
    const code = document.createElement('code')
    code.textContent = range.toString()
    range.deleteContents()
    range.insertNode(code)
    setCaretAfter(code)
    scheduleChange()
  }
```

In the `toolbar` array, insert right after the `S` strike button (line 1089):

```ts
    toolbarButton('<>', t(locale, 'editor_code_title'), () => toggleInlineCode()),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/editor.test.ts -t "<> button"` — PASS.
Run: `npx vitest run test/editor.test.ts` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "$(printf 'feat(editor): <> toolbar button for inline code (wrap/unwrap)\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 7: Editor `❝` blockquote button + `toggleBlockquote`

**Files:**
- Modify: `src/ui/editor.ts` — import `flattenNestedBlockquotes` from `../core/markdown` (line 7 import list); add `toggleBlockquote()` near `formatBlockTag` (~line 436); add the toolbar button after `¶` (line 1095).
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: `flattenNestedBlockquotes` (Task 4).
- Produces: `toggleBlockquote()` — `execCommand('formatBlock', '<blockquote>')` then `flattenNestedBlockquotes(editorEl)` then `scheduleChange()`. Toolbar button glyph `❝`, `title: t(locale, 'editor_quote_title')`, placed immediately after the `¶` paragraph button.

- [ ] **Step 1: Write the failing test**

Add to `test/editor.test.ts` inside `describe('toolbar', …)`:

```ts
test('❝ button runs formatBlock <blockquote> then flattens nesting', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
  editor.setMd('a line')
  toolbarButton(editor, t('en-US', 'editor_quote_title')).click()
  expect(execSpy).toHaveBeenCalledWith('formatBlock', false, '<blockquote>')
  editor.destroy()
})

test('❝ button collapses a nested blockquote to one level', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  vi.spyOn(document, 'execCommand').mockReturnValue(true)
  const editorEl = editor.root.querySelector('.editor') as HTMLElement
  editorEl.innerHTML = '<blockquote>outer<blockquote>inner</blockquote></blockquote>'
  toolbarButton(editor, t('en-US', 'editor_quote_title')).click()
  expect(editorEl.querySelectorAll('blockquote').length).toBe(1)
  editor.destroy()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/editor.test.ts -t "❝ button"`
Expected: FAIL — button not found.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/editor.ts`:

- line 7 — add `flattenNestedBlockquotes` to the `../core/markdown` import:

```ts
import { mdToHtml, htmlToMd, htmlToPlainText, parseRef, unwrapBlockContainers, flattenNestedHeadings, flattenNestedBlockquotes, demoteHeadings, BLOCK_TAGS, MAX_LIST_DEPTH, type RefInfo, type LabelResolver } from '../core/markdown'
```

- after `formatBlockTag()` (~line 436):

```ts
  /**
   * The ❝ button / Ctrl+Shift+9. Chromium's formatBlock can nest a fresh
   * <blockquote> inside an existing one on a repeat press or multi-line
   * selection; this app's blockquote is flat, so flattenNestedBlockquotes
   * collapses that right after — same pattern as formatBlockTag + headings.
   */
  function toggleBlockquote(): void {
    editorEl.focus()
    document.execCommand('formatBlock', false, '<blockquote>')
    flattenNestedBlockquotes(editorEl)
    scheduleChange()
  }
```

- in the `toolbar` array, right after the `¶` button (line 1095):

```ts
    toolbarButton('❝', t(locale, 'editor_quote_title'), () => toggleBlockquote()),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/editor.test.ts -t "❝ button"` — PASS.
Run: `npx vitest run test/editor.test.ts` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "$(printf 'feat(editor): ❝ toolbar button for blockquote, with nesting guard\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 8: Editor `—` HR button + `insertHr`

**Files:**
- Modify: `src/ui/editor.ts` — add `insertHr()` near `convertBlockToHr` (~line 496); add the toolbar button after `❝`.
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: existing `currentBlockAndOffset`, `convertBlockToHr`, `scheduleChange`.
- Produces: `insertHr()` — inserts `<hr>` + an empty `<div>` **after** the current top-level block (or after the last block if the caret isn't resolvable), and drops the caret into the new empty div. Deliberately does NOT split a block mid-line (simpler than the spec's "split at caret"; the common use is clicking at end of a line, and the typed `---` autoformat already covers the replace-this-line case). Toolbar button glyph `—` (U+2014), `title: t(locale, 'editor_hr_title')`, after the `❝` button.

- [ ] **Step 1: Write the failing test**

Add to `test/editor.test.ts` inside `describe('toolbar', …)`:

```ts
test('— button inserts an <hr> after the current block and round-trips', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  editor.setMd('first line\nsecond line')
  const editorEl = editor.root.querySelector('.editor') as HTMLElement
  const firstDiv = editorEl.querySelector('div')!
  const range = document.createRange()
  range.selectNodeContents(firstDiv); range.collapse(false)
  const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

  toolbarButton(editor, t('en-US', 'editor_hr_title')).click()

  expect(editorEl.querySelector('hr')).not.toBeNull()
  expect(editor.getMd()).toBe('first line\n---\nsecond line')
  editor.destroy()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/editor.test.ts -t "— button"`
Expected: FAIL — button not found.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/editor.ts`, after `convertBlockToHr()` (~line 496):

```ts
  /**
   * The — toolbar button. Inserts an <hr> plus a fresh empty block right
   * after the caret's current top-level block (or after the last block if
   * the caret isn't inside one), and moves the caret into that new block.
   * Does not split a block mid-line — the typed "---" autoformat already
   * handles "turn THIS line into a rule", and end-of-line is where the
   * button is actually used.
   */
  function insertHr(): void {
    editorEl.focus()
    const ctx = currentBlockAndOffset()
    const ref = ctx && ctx.block.parentElement === editorEl ? ctx.block : editorEl.lastElementChild
    const hr = document.createElement('hr')
    const next = document.createElement('div')
    next.appendChild(document.createElement('br'))
    if (ref) ref.after(hr, next)
    else editorEl.append(hr, next)
    const r = document.createRange()
    r.selectNodeContents(next)
    r.collapse(true)
    const sel = window.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(r) }
    scheduleChange()
  }
```

In the `toolbar` array, right after the `❝` button:

```ts
    toolbarButton('—', t(locale, 'editor_hr_title'), () => insertHr()),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/editor.test.ts -t "— button"` — PASS.
Run: `npx vitest run test/editor.test.ts` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "$(printf 'feat(editor): — toolbar button inserts a horizontal rule\n\nInserts <hr> + empty block after the current block. Complements the\nexisting typed --- autoformat with a discoverable control.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 9: Editor `🔗` link button + `promptLinkUrl` + `insertLink`

**Files:**
- Modify: `src/ui/editor.ts` — import `showModal` from `./modal` and `safeHref` from `../core/markdown`; add `promptLinkUrl()` and `insertLink()` near the copy helpers (~line 655); add the toolbar button after the `@` button (line 1098).
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: `showModal` (`src/ui/modal.ts` — `{ title, body, buttons: [{label, primary?, onClick}] }` → `{ close }`); `safeHref` (Task 1); `[text](url)` ⇔ `<a>` from Task 3; existing `caretOrEndRange`, `exec`.
- Produces:
  - `promptLinkUrl(): Promise<string | null>` — opens a modal with a single URL `<input>` and OK / Cancel; resolves the entered string on OK (Enter in the field also confirms), `null` on Cancel/Escape.
  - `insertLink()` — `await`s `promptLinkUrl()`; on a non-null, non-empty result whose `safeHref(...)` is non-null, inserts markdown `[text](url)` at the caret via `exec('insertText', …)` where `text` is the current selection's text or, if empty, the URL itself. A rejected/blank URL is a no-op.
  - Toolbar button glyph `🔗`, `title: t(locale, 'editor_link_title')`, placed immediately after the `@` button.

- [ ] **Step 1: Write the failing test**

Add to `test/editor.test.ts` inside `describe('toolbar', …)`:

```ts
async function answerLinkPrompt(url: string | null): Promise<void> {
  // one microtask for the modal to mount
  await Promise.resolve()
  const dialog = document.querySelector('.tt-modal-dialog') as HTMLElement
  if (url === null) {
    const cancel = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === t('en-US', 'cancel'))!
    cancel.click()
  } else {
    ;(dialog.querySelector('input') as HTMLInputElement).value = url
    const ok = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === t('en-US', 'ok'))!
    ok.click()
  }
}

test('🔗 button wraps the selection as a markdown link', async () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
  editor.setMd('see docs here')
  const editorEl = editor.root.querySelector('.editor') as HTMLElement
  const textNode = editorEl.querySelector('div')!.firstChild as Text
  const range = document.createRange()
  range.setStart(textNode, 4); range.setEnd(textNode, 8) // "docs"
  const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

  toolbarButton(editor, t('en-US', 'editor_link_title')).click()
  await answerLinkPrompt('https://example.com')

  const inserted = execSpy.mock.calls.find(c => c[0] === 'insertText')![2]
  expect(inserted).toBe('[docs](https://example.com)')
  editor.destroy()
})

test('🔗 button with no selection uses the URL as the link text', async () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
  editor.setMd('x')
  toolbarButton(editor, t('en-US', 'editor_link_title')).click()
  await answerLinkPrompt('https://example.com')
  const inserted = execSpy.mock.calls.find(c => c[0] === 'insertText')![2]
  expect(inserted).toBe('[https://example.com](https://example.com)')
  editor.destroy()
})

test('🔗 button: cancelling the prompt inserts nothing', async () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
  editor.setMd('x')
  toolbarButton(editor, t('en-US', 'editor_link_title')).click()
  await answerLinkPrompt(null)
  expect(execSpy.mock.calls.some(c => c[0] === 'insertText')).toBe(false)
  editor.destroy()
})

test('🔗 button: a javascript: URL is rejected, nothing inserted', async () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
  editor.setMd('x')
  toolbarButton(editor, t('en-US', 'editor_link_title')).click()
  await answerLinkPrompt('javascript:alert(1)')
  expect(execSpy.mock.calls.some(c => c[0] === 'insertText')).toBe(false)
  editor.destroy()
})
```

If `t('en-US', 'cancel')` / `t('en-US', 'ok')` are not the exact existing keys, grep `src/core/i18n.ts` for the confirm/cancel button labels (`confirmDelete` in `modal.ts` shows which keys) and use those.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/editor.test.ts -t "🔗 button"`
Expected: FAIL — button not found.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/editor.ts`:

- add imports:

```ts
import { showModal } from './modal'
```

and add `safeHref` to the `../core/markdown` import list (already being edited in Task 7).

- near the copy helpers (~line 655), add:

```ts
  /**
   * Opens a one-field modal asking for a URL. Resolves the raw string on
   * OK (or Enter in the field), null on Cancel/Escape. Kept as a plain
   * promise-returning helper (not wired through EditorHooks) so tests drive
   * it through the real modal DOM, same as showEditorHelp.
   */
  function promptLinkUrl(): Promise<string | null> {
    return new Promise((resolve) => {
      let done = false
      const finish = (v: string | null) => { if (done) return; done = true; handle.close(); resolve(v) }
      const input = el('input', {
        type: 'url',
        class: 'tt-input',
        placeholder: 'https://',
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value) } },
      }) as HTMLInputElement
      const handle = showModal({
        title: t(locale, 'editor_link_title'),
        body: el('label', { class: 'tt-modal-field' }, t(locale, 'editor_link_prompt'), input),
        buttons: [
          { label: t(locale, 'cancel'), onClick: () => finish(null) },
          { label: t(locale, 'ok'), primary: true, onClick: () => finish(input.value) },
        ],
      })
      input.focus()
    })
  }

  /** The 🔗 button / Ctrl+K. Prompts for a URL and inserts `[text](url)`
   * markdown at the caret — `text` is the current selection, or the URL
   * itself when nothing is selected. A blank or disallowed-scheme URL is a
   * no-op. Inserted via exec('insertText', …) so the normal input->change
   * ->autoformat path turns it into a live link. */
  async function insertLink(): Promise<void> {
    const sel = window.getSelection()
    const selected = sel && !sel.isCollapsed ? sel.toString() : ''
    const raw = await promptLinkUrl()
    if (raw === null) return
    const url = raw.trim()
    if (!url || !safeHref(url)) return
    caretOrEndRange()
    exec('insertText', `[${selected || url}](${url})`)
  }
```

Note: capture `selected` **before** `await` — the modal steals focus and collapses the selection.

- in the `toolbar` array, right after the `@` button (line 1098):

```ts
    toolbarButton('🔗', t(locale, 'editor_link_title'), () => { void insertLink() }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/editor.test.ts -t "🔗 button"` — PASS (4 tests).
Run: `npx vitest run test/editor.test.ts` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "$(printf 'feat(editor): 🔗 toolbar button — prompt for URL, insert [text](url)\n\nURL runs through safeHref; selection becomes the link text, else the URL\ndoubles as text; blank/disallowed URL is a no-op.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 10: Lock the toolbar button order

**Files:**
- Test: `test/editor.test.ts` (test only)

**Interfaces:**
- Consumes: the finished toolbar from Tasks 6–9.
- Produces: a regression test asserting the exact ordered list of toolbar button `title`s, so any later accidental reshuffle fails loudly.

- [ ] **Step 1: Write the failing test (expected to pass once order is right)**

Add to `test/editor.test.ts` inside `describe('toolbar', …)`:

```ts
test('toolbar button order is locked', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  const titles = Array.from(editor.root.querySelectorAll<HTMLButtonElement>('.tt-editor-toolbar button')).map(b => b.title)
  expect(titles).toEqual([
    t('en-US', 'editor_bold_title'),
    t('en-US', 'editor_italic_title'),
    t('en-US', 'editor_underline_title'),
    t('en-US', 'editor_strike_title'),
    t('en-US', 'editor_code_title'),
    t('en-US', 'editor_ul_title'),
    t('en-US', 'editor_ol_title'),
    t('en-US', 'editor_h1_title'),
    t('en-US', 'editor_h2_title'),
    t('en-US', 'editor_h3_title'),
    t('en-US', 'editor_paragraph_title'),
    t('en-US', 'editor_quote_title'),
    t('en-US', 'editor_hr_title'),
    t('en-US', 'editor_clear_format_title'),
    t('en-US', 'editor_templates_title'),
    t('en-US', 'editor_insert_ref_title'),
    t('en-US', 'editor_link_title'),
    t('en-US', 'editor_copy_options_title'),
    t('en-US', 'editor_help_title'),
  ])
  editor.destroy()
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/editor.test.ts -t "toolbar button order"`
Expected: PASS if Tasks 6–9 placed buttons as specified. If it FAILS, the assertion is the source of truth for this plan — move the `toolbarButton(...)` lines in `src/ui/editor.ts` to match, re-run.

- [ ] **Step 3: (no implementation — reconcile only)**

- [ ] **Step 4: Full file green**

Run: `npx vitest run test/editor.test.ts` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add test/editor.test.ts src/ui/editor.ts
git commit -m "$(printf 'test(editor): lock toolbar button order against accidental reshuffles\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 11: Editor keyboard — `Ctrl+E` (code) and `Ctrl+Shift+9` (blockquote)

**Files:**
- Modify: `src/ui/editor.ts` — `onKeydown` (lines 873–935).
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: `toggleInlineCode` (Task 6), `toggleBlockquote` (Task 7), existing `matchKey`.
- Produces: `Ctrl+E` (no Shift) → `toggleInlineCode()`; `Ctrl+Shift+9` (matched by `e.code === 'Digit9'`, alongside the existing `Digit5/7/8` block) → `toggleBlockquote()`. Both `preventDefault()`.

- [ ] **Step 1: Write the failing test**

Add to `test/editor.test.ts` inside `describe('keyboard shortcuts', …)`:

```ts
test('Ctrl+E toggles inline code on the selection', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  editor.setMd('foo bar')
  const editorEl = editor.root.querySelector('.editor') as HTMLElement
  const textNode = editorEl.querySelector('div')!.firstChild as Text
  const range = document.createRange()
  range.setStart(textNode, 4); range.setEnd(textNode, 7)
  const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

  const e = dispatchKey(editorEl, { key: 'e', code: 'KeyE', ctrlKey: true })
  expect(e.defaultPrevented).toBe(true)
  expect(editorEl.querySelector('code')?.textContent).toBe('bar')
  editor.destroy()
})

test('Ctrl+Shift+9 runs formatBlock <blockquote>', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
  const editorEl = editor.root.querySelector('.editor') as HTMLElement
  editor.setMd('a line')
  const e = dispatchKey(editorEl, { key: '(', code: 'Digit9', ctrlKey: true, shiftKey: true })
  expect(e.defaultPrevented).toBe(true)
  expect(execSpy).toHaveBeenCalledWith('formatBlock', false, '<blockquote>')
  editor.destroy()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/editor.test.ts -t "Ctrl+E"` and `-t "Ctrl+Shift+9"`
Expected: FAIL — no handler.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/editor.ts` `onKeydown`:

- in the **non-shift** branch (`if (!e.shiftKey) { … }`, lines 915–924), add before the `return`:

```ts
      if (matchKey(e, 'e')) { e.preventDefault(); toggleInlineCode(); return }
```

- in the **shift** branch (after `if (e.code === 'Digit7') …`, line 934), add:

```ts
    if (e.code === 'Digit9') { e.preventDefault(); toggleBlockquote(); return }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/editor.test.ts -t "Ctrl+E"` and `-t "Ctrl+Shift+9"` — PASS.
Run: `npx vitest run test/editor.test.ts` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "$(printf 'feat(editor): Ctrl+E inline code, Ctrl+Shift+9 blockquote\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 12: `Ctrl+K` inserts a link; command palette moves to `Ctrl+Shift+K`

**Files:**
- Modify: `src/ui/editor.ts` — `onKeydown` non-shift branch; `src/main.ts` — the palette-trigger block (lines 481–486).
- Test: `test/editor.test.ts` (editor side). `main.ts` is wiring-only (no unit test per CLAUDE.md) — verified by `npm run build` + the help-modal test in Task 15 + a manual smoke note in the PR.

**Interfaces:**
- Consumes: `insertLink` (Task 9), `matchKey`.
- Produces: inside a focused editor, `Ctrl+K` (no Shift) → `preventDefault()` + `void insertLink()`. In `src/main.ts`, the palette opens on `Ctrl+Shift+K` instead of `Ctrl+K`; plain `Ctrl+K` no longer opens the palette anywhere. Because the palette now requires Shift, there is no cross-handler collision and no `defaultPrevented` guard is needed.

- [ ] **Step 1: Write the failing test**

Add to `test/editor.test.ts` inside `describe('keyboard shortcuts', …)`:

```ts
test('Ctrl+K in the editor opens the link prompt and is consumed', async () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  vi.spyOn(document, 'execCommand').mockReturnValue(true)
  const editorEl = editor.root.querySelector('.editor') as HTMLElement
  editor.setMd('x')

  const e = dispatchKey(editorEl, { key: 'k', code: 'KeyK', ctrlKey: true })
  expect(e.defaultPrevented).toBe(true)
  await Promise.resolve()
  expect(document.querySelector('.tt-modal-dialog')).not.toBeNull()

  // clean up the open modal
  const cancel = Array.from(document.querySelectorAll('.tt-modal-dialog button')).find(b => b.textContent === t('en-US', 'cancel')) as HTMLButtonElement
  cancel.click()
  editor.destroy()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/editor.test.ts -t "Ctrl+K in the editor"`
Expected: FAIL — no handler, `defaultPrevented` false.

- [ ] **Step 3: Write minimal implementation**

- `src/ui/editor.ts` `onKeydown`, non-shift branch (with the `matchKey(e, 'e')` line from Task 11):

```ts
      if (matchKey(e, 'k')) { e.preventDefault(); void insertLink(); return }
```

- `src/main.ts`, replace the palette block (lines 481–486):

```ts
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && matchKey(e, 'k')) {
      if (!comboHotkeyAllowed(e)) return
      e.preventDefault()
      palette.open()
      return
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/editor.test.ts -t "Ctrl+K in the editor"` — PASS.
Run: `npx vitest run test/editor.test.ts` — all PASS.
Run: `npm run build` — succeeds (catches any `main.ts` type error).

- [ ] **Step 5: Commit**

```bash
git add src/ui/editor.ts src/main.ts test/editor.test.ts
git commit -m "$(printf 'feat: Ctrl+K inserts a link in the editor; palette moves to Ctrl+Shift+K\n\nThe near-universal Ctrl+K link shortcut takes precedence inside a note;\nthe command palette is now Ctrl+Shift+K everywhere. No collision since\nthe palette trigger now requires Shift.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 13: Typed `[text](url)` autoformat in the editor

**Files:**
- Modify: `src/ui/editor.ts` — `detectInlinePattern()` (lines 76–93) OR a dedicated check in `handleAutoFormat()` (lines 514–549). Use a dedicated branch in `handleAutoFormat` (the `InlineMatch` shape is marker-based and doesn't fit links).
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: `[text](url)` ⇔ `<a>` from Task 3; `safeHref`; existing `currentBlockAndOffset`, `rangeForTextOffsets`, `mdToHtml`, `setCaretAfter`, `scheduleChange`.
- Produces: on `input`, if the current block's text immediately before the caret ends with a complete `[text](url)` whose `safeHref(url)` is non-null and the matched span is text-only, replace it with the rendered `<a>` (built via `mdToHtml` so `target`/`rel` and any inner formatting come out identical to a loaded document). A rejected scheme leaves the literal characters.

- [ ] **Step 1: Write the failing test**

Add to `test/editor.test.ts` (new `describe` or inside an existing autoformat block):

```ts
describe('typed link autoformat', () => {
  function typeInto(editorEl: HTMLElement, text: string) {
    const div = editorEl.querySelector('div')!
    div.textContent = text
    const r = document.createRange()
    r.selectNodeContents(div); r.collapse(false)
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(r)
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))
  }

  test('a completed [text](https://…) becomes a live anchor', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editor.setMd('')
    typeInto(editorEl, 'see [docs](https://example.com)')
    const a = editorEl.querySelector('a[href]') as HTMLAnchorElement
    expect(a).not.toBeNull()
    expect(a.getAttribute('href')).toBe('https://example.com')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.textContent).toBe('docs')
    expect(editor.getMd()).toBe('see [docs](https://example.com)')
    editor.destroy()
  })

  test('a javascript: URL is left as literal text', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editor.setMd('')
    typeInto(editorEl, 'x [bad](javascript:alert(1))')
    expect(editorEl.querySelector('a[href]')).toBeNull()
    editor.destroy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/editor.test.ts -t "typed link autoformat"`
Expected: FAIL — text stays literal.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/editor.ts` `handleAutoFormat()`, add before the final `const inlineMatch = detectInlinePattern(...)` line (line 547):

```ts
    // Typed link: [text](url) completed right at the caret. Built through
    // mdToHtml so target/rel and any inner formatting match a loaded doc
    // exactly. Text-only spans only (bail if the range holds elements).
    const linkM = /\[([^\]]+)\]\(([^)]+)\)$/.exec(text.slice(0, caretOffset))
    if (linkM && safeHref(linkM[2]!)) {
      const start = caretOffset - linkM[0]!.length
      const range = rangeForTextOffsets(block, start, caretOffset)
      if (!range.cloneContents().querySelector('*')) {
        range.deleteContents()
        const tmp = document.createElement('div')
        tmp.innerHTML = mdToHtml(linkM[0]!, hooks.resolveRefLabel, t(locale, 'editor_ref_hint'))
        // mdToHtml wraps a bare line in <div>…</div>; lift its children.
        const frag = document.createDocumentFragment()
        const wrapper = tmp.firstElementChild ?? tmp
        while (wrapper.firstChild) frag.appendChild(wrapper.firstChild)
        const lastNode = frag.lastChild
        range.insertNode(frag)
        if (lastNode) setCaretAfter(lastNode)
        scheduleChange()
        return
      }
    }
```

Add `safeHref` to the `../core/markdown` import if not already present from Task 9.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/editor.test.ts -t "typed link autoformat"` — PASS.
Run: `npx vitest run test/editor.test.ts` — all PASS (watch the existing `detectInlinePattern` / autoformat tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "$(printf 'feat(editor): typed [text](url) auto-converts to a live link\n\nBuilt via mdToHtml so target/rel match a loaded doc; disallowed schemes\nstay literal.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 14: `clearFormatting` (🧹) also demotes a blockquote

**Files:**
- Modify: `src/core/markdown.ts` — `demoteHeadings()` (lines 429–436) → generalise to also unwrap `<blockquote>`, OR add a sibling `demoteBlockquotes()`. Add a sibling (keeps each function single-purpose and the existing `demoteHeadings` tests untouched).
- Modify: `src/ui/editor.ts` — `clearFormatting()` (lines 446–454) calls the new helper too.
- Test: `test/markdown.test.ts` + `test/editor.test.ts`

**Interfaces:**
- Consumes: `rangeHitsNode` (private in markdown.ts — the new helper lives in the same file so it can use it).
- Produces: `export function demoteBlockquotes(root: HTMLElement, range: Range): void` — replaces every `<blockquote>` the range intersects with its own child nodes (unwrap). `clearFormatting()` calls it after `demoteHeadings(...)`.

- [ ] **Step 1: Write the failing test**

Add to `test/markdown.test.ts`:

```ts
test('demoteBlockquotes unwraps a blockquote the range touches', () => {
  const root = document.createElement('div')
  root.innerHTML = '<blockquote>quoted line</blockquote>'
  const range = document.createRange()
  range.selectNodeContents(root.querySelector('blockquote')!)
  demoteBlockquotes(root, range)
  expect(root.querySelector('blockquote')).toBeNull()
  expect(root.textContent).toBe('quoted line')
})
```

Add `demoteBlockquotes` to the import line in `test/markdown.test.ts`.

Add to `test/editor.test.ts` inside `describe('toolbar', …)`:

```ts
test('🧹 clear-formatting also drops blockquote styling', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  vi.spyOn(document, 'execCommand').mockReturnValue(true)
  const editorEl = editor.root.querySelector('.editor') as HTMLElement
  editorEl.innerHTML = '<blockquote>quoted</blockquote>'
  const range = document.createRange()
  range.selectNodeContents(editorEl.querySelector('blockquote')!)
  const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

  toolbarButton(editor, t('en-US', 'editor_clear_format_title')).click()

  expect(editorEl.querySelector('blockquote')).toBeNull()
  editor.destroy()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/markdown.test.ts -t "demoteBlockquotes"` — FAIL (undefined).
Run: `npx vitest run test/editor.test.ts -t "clear-formatting also drops blockquote"` — FAIL.

- [ ] **Step 3: Write minimal implementation**

In `src/core/markdown.ts`, after `demoteHeadings()` (line 436):

```ts
/**
 * Companion to demoteHeadings for the editor's 🧹 button: "clear
 * formatting" also drops blockquote styling (Google Docs / Word both do).
 * Unwraps every <blockquote> the selection touches into its own children.
 * List nesting is still left alone, same as demoteHeadings.
 */
export function demoteBlockquotes(root: HTMLElement, range: Range): void {
  for (const b of Array.from(root.querySelectorAll<HTMLElement>('blockquote'))) {
    if (!rangeHitsNode(range, b)) continue
    b.replaceWith(...b.childNodes)
  }
}
```

In `src/ui/editor.ts`:

- add `demoteBlockquotes` to the `../core/markdown` import.
- in `clearFormatting()`, after the `if (range) demoteHeadings(editorEl, range)` line:

```ts
    if (range) demoteBlockquotes(editorEl, range)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/markdown.test.ts -t "demoteBlockquotes"` — PASS.
Run: `npx vitest run test/editor.test.ts -t "clear-formatting also drops blockquote"` — PASS.
Run: `npx vitest run test/markdown.test.ts test/editor.test.ts` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/markdown.ts src/ui/editor.ts test/markdown.test.ts test/editor.test.ts
git commit -m "$(printf 'feat(editor): clear-formatting also removes blockquote styling\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 15: Help modal rows

**Files:**
- Modify: `src/ui/help.ts` — `SHORTCUT_ROWS` (lines 9–18), `MD_ROWS` (lines 20–28), `GLOBAL_ROWS` (line ~32).
- Test: `test/help.test.ts`

**Interfaces:**
- Consumes: the i18n keys from Task 5.
- Produces: shortcut rows for code/quote/link; markdown-syntax rows for code/quote/link; the palette global row now shows `Ctrl+Shift+K`.

- [ ] **Step 1: Write the failing test**

Look at `test/help.test.ts` for the existing assertion style, then add:

```ts
test('editor help lists the new formatting shortcuts and syntax', () => {
  const modal = /* however the existing tests open it, e.g. */ showEditorHelp('en-US')
  const text = document.querySelector('.tt-modal-dialog')!.textContent!
  expect(text).toContain('Ctrl+E')
  expect(text).toContain('Ctrl+Shift+9')
  expect(text).toContain('`code`') // or the exact MD_ROWS spelling you choose
  expect(text).toContain('> ')
  expect(text).toContain('[text](url)')
  ;(modal as { close: () => void }).close?.()
})

test('global help shows the palette on Ctrl+Shift+K', () => {
  const modal = showGlobalHelp('en-US') // use the real export name from help.ts
  const text = document.querySelector('.tt-modal-dialog')!.textContent!
  expect(text).toContain('Ctrl+Shift+K')
  ;(modal as { close: () => void }).close?.()
})
```

Adjust to the real function names / open helpers used by the existing `test/help.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/help.test.ts`
Expected: FAIL — strings absent.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/help.ts`:

- `SHORTCUT_ROWS` — add after the underline row:

```ts
  ['Ctrl+E', 'help_shortcut_code'],
```

and after the ol row:

```ts
  ['Ctrl+Shift+9', 'help_shortcut_quote'],
  ['Ctrl+K', 'help_shortcut_link'],
```

- `MD_ROWS` — add:

```ts
  ['`código`', 'help_md_code'],
  ['> texto', 'help_md_quote'],
  ['[texto](url)', 'help_md_link'],
```

(match the `texto`/`código` wording already used in the surrounding `MD_ROWS` entries for consistency.)

- `GLOBAL_ROWS` — change the palette entry from `['Ctrl+K', 'help_global_palette']` to:

```ts
  ['Ctrl+Shift+K', 'help_global_palette'],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/help.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/help.ts test/help.test.ts
git commit -m "$(printf 'docs(help): document inline code, blockquote, link; palette is Ctrl+Shift+K\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 16: CSS for `<code>`, `<blockquote>`, `<a href>`

**Files:**
- Modify: `styles.css` — near the existing `.editor` rules (lines 666–706).
- Test: none (visual). Verified by `npm run build` succeeding and a manual check.

**Interfaces:**
- Consumes: existing CSS custom properties (`--muted`, `--border`, and whatever the sheet uses for accent/link colour — grep `--` near the top of `styles.css`).
- Produces: readable code spans, an indented quote bar, and visually distinct links inside `.editor`.

- [ ] **Step 1: Add the rules**

In `styles.css`, after the `.editor hr { … }` line (line 697):

```css
.editor code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: .92em; background: rgba(128, 128, 128, .14); padding: .1em .35em; border-radius: 4px; }
.editor blockquote { margin: .5em 0; padding: .15em 0 .15em .9em; border-left: 3px solid var(--muted); color: var(--muted); }
.editor a[href] { color: var(--link, #2563eb); text-decoration: underline; cursor: pointer; }
```

If the sheet already defines a link/accent variable, use it in place of `var(--link, #2563eb)` and drop the fallback.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: succeeds; `dist/app.html` contains `.editor blockquote` (grep it).

- [ ] **Step 3: Manual check (note in PR, not a blocker for the commit)**

Open `dist/app.html`, type `` `code` ``, `> quote`, and `[x](https://example.com)` in a daily note; confirm each renders distinctly and the link opens a new tab.

- [ ] **Step 4: Commit**

```bash
git add styles.css
git commit -m "$(printf 'style(editor): code span, blockquote bar, link styling\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 17: Changelog + version bump

**Files:**
- Modify: `package.json` (`version`), `CHANGELOG.md`.
- Test: `npm test` (full suite), `npm run typecheck`, `npm run lint`, `npm run build`.

**Interfaces:** none.

- [ ] **Step 1: Full gate**

Run, all must pass:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

- [ ] **Step 2: Bump version**

In `package.json`, bump `version` (current `2.6.2` → `2.7.0` — new user-facing features, minor bump).

- [ ] **Step 3: Changelog entry**

In `CHANGELOG.md`, add directly under the header block:

```markdown
## [2.7.0]

### Added
- Rich-text notes now support inline code (`` `code` ``), blockquotes (`> text`), and external links (`[text](url)`), each with a toolbar button. Links always open in a new tab.
- A toolbar button for inserting a horizontal divider line (previously only possible by typing `---`).
- Keyboard shortcuts: Ctrl+E for inline code, Ctrl+Shift+9 for blockquote, Ctrl+K to insert a link.

### Changed
- The command palette shortcut moved from Ctrl+K to Ctrl+Shift+K, so Ctrl+K can insert a link while editing a note.
- Strikethrough now also responds to Ctrl+Shift+X (in addition to Ctrl+Shift+5).
```

(The Ctrl+Shift+X line reflects a change already committed earlier in this cycle — keep it, it shipped in this release span.)

- [ ] **Step 4: Verify changelog gate locally**

Confirm the header string matches exactly: `## [2.7.0]` and `"version": "2.7.0"`.

- [ ] **Step 5: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "$(printf 'chore: bump version to 2.7.0, add CHANGELOG entry\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 18 (optional): e2e — link renders as a real new-tab anchor

**Files:**
- Modify: `e2e/smoke.spec.ts` (or add `e2e/rich-editor.spec.ts`).
- Test: `npm run test:e2e`

**Interfaces:** none.

- [ ] **Step 1: Add the spec**

Following `e2e/smoke.spec.ts`'s existing pattern (loads `dist/app.html` over `file://`, `forceFallbackMode`), add a test that: opens a document, focuses a daily note, types `[docs](https://example.com)`, and asserts the rendered `a[href="https://example.com"]` has `target="_blank"` and `rel` containing `noopener`.

- [ ] **Step 2: Run**

Run: `npm run test:e2e`
Expected: PASS (Chromium).

- [ ] **Step 3: Commit**

```bash
git add e2e/
git commit -m "$(printf 'test(e2e): typed link renders as a new-tab anchor\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §2 inline code (mdToHtml + inline order) | 2 |
| §2 inline code (htmlToMd/inlineMd/plain) | 2 |
| §2 blockquote (all directions + BLOCK_TAGS) | 4 |
| §2 links (mdToHtml + inline order) | 3 |
| §2 links (htmlToMd/inlineMd + re-validate) | 3 |
| §2.4 plain-text vs markdown copy | 2 (code), 3 (link), 4 (quote) |
| §3.1 toolbar order | 6–9 place, 10 locks |
| §3.2 `<>` / `❝` / `—` / `🔗` behaviours | 6 / 7 / 8 / 9 |
| §3.3 typed `[text](url)` autoformat | 13 |
| §4 Ctrl+E / Ctrl+Shift+9 / Ctrl+K | 11 / 11 / 12 |
| §4 palette → Ctrl+Shift+K (global) | 12 |
| §4 strike Ctrl+Shift+X + 5 | already committed this cycle (`6ccf5d3`); changelog line in 17 |
| §5 safeHref allowlist + control-char guard | 1 |
| §5 applied on render + export + button + autoformat | 3 (render/export), 9 (button), 13 (autoformat) |
| §6 i18n keys + updated strings | 5 |
| §6 help.ts rows | 15 |
| §7 CSS | 16 |
| §8 tests | folded into each task |
| §9 out of scope | nothing to implement |
| §10 changelog | 17 |
| flattenNestedBlockquotes | 4 (defined), 7 (used) |
| clearFormatting demotes blockquote | 14 |

No gaps.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Every code step has literal code. Tasks 15 and 18 say "match the existing test's open helper / follow the existing spec pattern" — acceptable because the existing file is the concrete reference and its exact helper names can't be known without reading it at execution time; the executor reads that file as step 1.

**Type consistency:**
- `safeHref(raw: string): string | null` — defined Task 1, consumed Tasks 3, 9, 13 with that signature.
- `flattenNestedBlockquotes(root: HTMLElement): void` — defined Task 4, consumed Task 7.
- `demoteBlockquotes(root: HTMLElement, range: Range): void` — defined Task 14, consumed same task in `editor.ts`.
- `toggleInlineCode()` / `toggleBlockquote()` / `insertHr()` / `insertLink(): Promise<void>` / `promptLinkUrl(): Promise<string | null>` — all defined in `editor.ts` Tasks 6–9, consumed by `onKeydown` Tasks 11–12.
- PUA constants `CODE_OPEN/CLOSE` (Task 2), `LINK_OPEN/CLOSE` (Task 3) — distinct code points (U+E002/3, U+E004/5), distinct from existing U+E000/1.
- Toolbar `title`s in the Task 10 lock list match the i18n keys added in Task 5 and the button definitions in Tasks 6–9.

Consistent.
