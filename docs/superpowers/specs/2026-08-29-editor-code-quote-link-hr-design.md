# Rich-Text Editor: Inline Code, Blockquote, External Links, HR Button — Design

**Date:** 2026-08-29
**Status:** Approved in brainstorming
**Scope:** `src/core/markdown.ts`, `src/ui/editor.ts`, `src/ui/help.ts`, `src/core/i18n.ts`, `src/main.ts`, `styles.css`, tests

## 1. Overview

The WYSIWYG editor shared by every free-text note field (daily notes, person
notes, task notes, milestone/risk follow-ups) is a markdown-backed contenteditable
with no font/colour controls. It currently supports bold, italic, underline,
strikethrough, H1–H3, paragraph, ordered/unordered lists (nested), horizontal
rule (typed `---` only), `@` refs, and `/` templates.

This adds four CommonMark-core formatting capabilities that are conspicuously
missing for a markdown editor:

1. **Inline code** — `` `code` ``
2. **Blockquote** — `> text`
3. **External links** — `[text](url)`, always opening in a new tab
4. **HR toolbar button** — a discoverable control for the divider that today
   only has a typed trigger

It also makes one global keybinding change (see §6): the command palette moves
from `Ctrl+K` to `Ctrl+Shift+K` so `Ctrl+K` can be the universal "insert link"
shortcut.

## 2. Markdown dialect additions (`core/markdown.ts`)

| Feature | Stored syntax | Rendered HTML | Notes |
|---|---|---|---|
| Inline code | `` `code` `` | `<code>` | Content is **literal** — no ref/bold/italic/strike/underline parsing inside. Single-backtick pairs only; a literal backtick inside code is out of scope. |
| Blockquote | `> text` (one per line) | `<blockquote>` | **Flat, no nesting** (like H1–H3). Consecutive `>` lines merge into one `<blockquote>`, inner lines `<br>`-joined. A bare `>` line is a blank line inside the quote. |
| Link | `[text](url)` | `<a href="url" target="_blank" rel="noopener noreferrer nofollow">text</a>` | `text` still takes inline formatting. `url` runs through `safeHref` (§7). |

### 2.1 `inline()` pass order — corruption safety

`inline()` re-scans the whole working string across sequential regex passes. Any
new marker that emits raw HTML (quotes, attributes) must be neither corrupted by
nor able to corrupt a later pass. The established fix is the ref-chip mechanism:
extract the match to a Private-Use-Area placeholder token (`…`),
splice the real markup back **last**, after every other substitution.

**Current order:** `esc` → refs→placeholder → `**` → `*` → `~~` → `~` → `<u>` →
splice refs.

**New order:**

1. `esc(s)`
2. **code spans → placeholder** (first). Inner text stays `esc()`-d; no later
   pass ever sees it.
3. refs → placeholder (unchanged)
4. **links → placeholder.** Link *text* (`$1`) is recursively run through the
   inline formatting passes before the `<a>` is assembled; the assembled `<a>`
   markup is frozen in a placeholder.
5. `**` → `*` → `~~` → `~` → `<u>` (unchanged)
6. splice **code, ref, and link** placeholders (all last)

### 2.2 `mdToHtml` block parsing

Add a blockquote branch to the per-line block loop, before the `div` fallback:
`^> ?(.*)$`. Accumulate consecutive matching lines, flush as a single
`<blockquote>` whose inner lines are `blockInline`-rendered and `<br>`-joined.
Like the `hr`/heading branches, it closes any open list first.

### 2.3 `htmlToMd` / `inlineMd`

- `<code>` → `` `text` `` using raw `textContent` (no child recursion).
- `<a>` **without** `data-ref` → `[text](href)`, with `href` re-validated through
  `safeHref` (defense in depth on the paste/export path). `<a data-ref>` chip
  handling is unchanged.
- `<blockquote>` handled in both the `htmlToMd` and `htmlToPlainText` top-level
  walkers.
- `BLOCK_TAGS` gains `blockquote`.

### 2.4 Plain-text vs markdown copy

- **Markdown copy** (`htmlToMd`): `[text](url)`, `` `code` ``, `> quote`.
- **Plain copy** (`htmlToPlainText`): `code` unwrapped to bare text; blockquote
  lines `> `-prefixed; link rendered as **visible text only, URL dropped** —
  consistent with `copyPlain`'s contract ("the readable text a screen would
  show").

## 3. Editor UI (`ui/editor.ts`)

### 3.1 Toolbar order

Four new buttons, minimal reshuffle of the existing sequence:

```
B  I  U  S  <>          inline marks   (<> = inline code, NEW)
•  1.  H1 H2 H3  ¶
❝  —                    block marks    (❝ = blockquote, — = HR, both NEW)
🧹  📋  @  🔗            tools          (🔗 = link, NEW)
[spacer]  🗐  ?          right cluster  (unchanged)
```

(The `🗐 ?` right cluster and its spacer position were finalised earlier in the
same work session — `🗐` moved to sit next to `?`.)

### 3.2 Button behaviours

- **`<>` inline code** — DOM-wrap the current selection in `<code>` (toggle off
  if the selection is already fully inside one), analogous to how
  `replaceInlineMatch` builds a `<strong>` for `**`.
- **`❝` blockquote** — `document.execCommand('formatBlock', '<blockquote>')`,
  followed by a new `flattenNestedBlockquotes(editorEl)` guard that unwraps a
  `<blockquote>` nested inside another (mirrors `flattenNestedHeadings`).
  `clearFormatting` (`🧹`) also demotes a blockquote the selection touches
  (extend `demoteHeadings` or add a sibling helper).
- **`—` HR** — insert `<hr>` at the caret. Reuse `convertBlockToHr` when the
  current block is empty; otherwise split the block at the caret and insert the
  `<hr>` between the halves. No keyboard shortcut — the typed `---`+Enter/Space
  autoformat remains the keyboard path.
- **`🔗` link** — prompt for a URL via the existing `ui/modal.ts`. If the
  selection is non-empty, its text becomes the link text; if empty, the URL
  doubles as the visible text. Cancelling the prompt is a no-op. The href is
  run through `safeHref` before the link is created.

### 3.3 Typed `[text](url)` autoformat

Extend the inline autoformat path (`handleAutoFormat` / `detectInlinePattern`
family) so that a completed `[text](url)` typed literally converts to a live
link, on the closing `)`, the same way `**x**` converts to bold. Only text-only
spans convert (bail if the span crosses an element boundary, matching
`replaceInlineMatch`). The href runs through `safeHref`; a rejected scheme
leaves the literal characters untouched.

## 4. Keyboard shortcuts

| Chord | Action | Where | Convention |
|---|---|---|---|
| `Ctrl+E` | inline code | editor `onKeydown` | Discord, GitHub |
| `Ctrl+Shift+9` | blockquote | editor `onKeydown` (`e.code === 'Digit9'`) | Slack; groups with existing `Ctrl+Shift+7`/`8` |
| `Ctrl+K` | insert link | editor `onKeydown` (`matchKey(e,'k')`) | universal |
| `Ctrl+Shift+K` | command palette | `main.ts` — **global**, replaces `Ctrl+K` | — |
| `Ctrl+Shift+X` **and** `Ctrl+Shift+5` | strikethrough | editor `onKeydown` | X is the cross-app norm; 5 is the fallback for drivers that swallow the X chord |
| _(none)_ | HR | — | `—` button + `---` autoformat only |

`Ctrl+K` conflict resolution: the editor's `onKeydown` (bound on `editorEl`,
runs before the document-level `main.ts` handler) calls `e.preventDefault()` for
`Ctrl+K`; `main.ts`'s palette handler gains an early
`if (e.defaultPrevented) return`. `main.ts`'s palette trigger becomes
`e.shiftKey && matchKey(e, 'k')`. Outside a focused editor, `Ctrl+K` is unbound.

## 5. Security — `safeHref(url)`

A new pure helper in `core/markdown.ts`:

- Trim. Reject if the value contains any control character or internal
  whitespace (blocks `java\tscript:` and friends).
- Allow **only** schemes `http:`, `https:`, `mailto:` (case-insensitive).
- Everything else — `javascript:`, `data:`, `vbscript:`, relative paths,
  fragment-only — is rejected: the link is dropped and only the visible text is
  emitted.
- On success the link is always emitted with
  `target="_blank" rel="noopener noreferrer nofollow"`.
- Applied on **both** `mdToHtml` (render) and `inlineMd` (paste/export), and by
  the `🔗` button and the typed-autoformat path.

The paste pipeline already parses untrusted clipboard HTML in an inert
`DOMParser` document; a pasted `<a href="javascript:…">` therefore reaches
`inlineMd` as an ordinary node and is neutralised there.

## 6. i18n + help modal

**New keys (both `pt-BR` and `en-US`):** `editor_code_title`,
`editor_quote_title`, `editor_hr_title`, `editor_link_title`,
`editor_link_prompt`, `help_shortcut_code`, `help_shortcut_quote`,
`help_shortcut_link`, `help_md_code`, `help_md_quote`, `help_md_link`.

**Updated keys:** `editor_strike_title` and `help_shortcut_strike` →
"Ctrl+Shift+X / Ctrl+Shift+5"; the global-shortcuts palette row → `Ctrl+Shift+K`.

**`help.ts`:**
- `SHORTCUT_ROWS` gains code (`Ctrl+E`), blockquote (`Ctrl+Shift+9`), link
  (`Ctrl+K`).
- `MD_ROWS` gains `` `code` ``, `> quote`, `[text](url)`.
- `GLOBAL_ROWS` palette entry changes from `Ctrl+K` to `Ctrl+Shift+K`.

## 7. CSS (`styles.css`)

- `.editor code` — monospace stack, subtle tint background, small padding,
  border-radius. (An explicit background here is safe: `copyFormatted`'s
  ambient-background concern is about *ancestor* backgrounds walked by the
  browser's copy serializer, not explicit ones on the copied nodes.)
- `.editor blockquote` — left border, left padding, muted text colour, vertical
  margin.
- `.editor a[href]` (distinct from `.editor a.ref`) — link colour, underline,
  pointer cursor.

## 8. Testing

### `test/markdown.test.ts`

- Round-trip + idempotency (`md → html → md → html` stable) for: `` a `code` b ``,
  `> quoted`, `> l1\n> l2`, `[x](https://e.com)`, `[**x**](https://e.com)`.
- `` `**literal**` `` renders `<code>**literal**</code>` and round-trips
  unchanged (inner markdown suppressed).
- Code span adjacent to a ref chip — both survive.
- Blockquote closes an open list; bare `>` line; blockquote immediately before/
  after a heading.
- Scheme allowlist: `[x](javascript:alert(1))`, `[x](data:…)`,
  `[x](vbscript:…)`, `[x](  javascript:…)` (leading ws), `[x](java\tscript:…)`
  → no `<a>`, visible text `x` retained, no round-trip to a link.
- Every accepted link carries `target="_blank"` and the `rel` triplet.
- An href containing `"`, `>`, `~`, or `~~` cannot break out of the attribute
  (mirror the existing ref tilde-chain regression test — build HTML, probe for
  injected attributes / extra `<a>` tags).
- Link text/url regex boundaries: `text` is `[^\]]+`, `url` is `[^)]+`; nested
  parentheses in a URL are unsupported — assert the documented behaviour.
- `htmlToPlainText`: `<code>` unwrapped, `<blockquote>` lines `> `-prefixed,
  `<a href>` → visible text only.

### `test/editor.test.ts`

- Toolbar has code / blockquote / HR / link buttons (looked up by `title`).
- **Toolbar order assertion** — the full ordered list of button `title`s, so an
  accidental reshuffle fails loudly.
- `Ctrl+E` wraps the selection in `<code>`.
- `Ctrl+Shift+9` applies `formatBlock('<blockquote>')`.
- `Ctrl+K` inside the editor opens the link prompt **and** does not open the
  command palette (`e.defaultPrevented === true`, no `.tt-palette-overlay`).
- Link button with a selection wraps it; with no selection inserts a link;
  cancelling the prompt is a no-op.
- Paste `<a href="javascript:…">x</a>` → no live link, no `javascript:` anywhere
  in the inserted HTML, text `x` preserved.
- Paste `<a href="https://e.com">x</a>` → `[x](https://e.com)`, round-trips.
- HR button on a non-empty block splits it and inserts `<hr>`.
- `🧹` clear-formatting demotes a blockquote the selection touches.
- Existing `Ctrl+Shift+5` / `%` strike cases plus the new `Ctrl+Shift+X` case
  all map to `strikeThrough`.

### `test/help.test.ts`

- New `SHORTCUT_ROWS` / `MD_ROWS` entries render.
- The palette global-shortcut row shows `Ctrl+Shift+K`.

### e2e (optional, flag in plan)

- A rendered link in `dist/` carries `target="_blank"`.

## 9. Out of scope (YAGNI)

Fenced / multi-line code blocks · nested blockquotes · autolinking bare URLs ·
paste-URL-over-selection · link `title` attribute · relative / fragment links ·
literal backticks inside inline code (variable-length fences) · highlight /
superscript / subscript / tables.

## 10. Changelog

`package.json` version bump + a matching `## [X.Y.Z]` block in `CHANGELOG.md`
(`### Added` — inline code, blockquote, links, HR button; `### Changed` — command
palette shortcut is now `Ctrl+Shift+K`, strikethrough also responds to
`Ctrl+Shift+X`). User-facing wording, per the repo changelog rules.
