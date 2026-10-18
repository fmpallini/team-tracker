# Paste fidelity, markdown escaping and search alignment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make what the rich editor shows exactly what it stores. Literal text must survive save and reopen unchanged. Paste from real sources (Word, Google Sheets, VS Code, Wikipedia, Outlook, Slack, ChatGPT, Notion) must keep its lines and lists. Big plain-text pastes must not freeze the editor. Search snippets and highlights must line up for decomposed (NFD) and Hangul text.

**Architecture:**
- **Codec (`core/markdown.ts`):**
  - `htmlToMd` gets one container walker that splits any element holding blocks into inline runs and blocks. It replaces today's "a `div` is one line" rule. List items reuse it in a flat mode.
  - The codec gains backslash escapes. `htmlToMd` escapes literal text, and `mdToHtml`'s `inline()` turns escapes back into literal characters through PUA placeholders, the same pattern it already uses for links and refs.
- **Paste path (`ui/editor.ts`):**
  - Word list paragraphs become real lists before conversion.
  - Multi-line plain text is inserted as escaped `<div>` lines in one `insertHTML`.
  - Chromium's inline `style` attributes are stripped after any paste.
- **Search:** one helper returns `normalize()` output with a map back to original indices. The three index-slicing sites use it.

**Tech Stack:** TypeScript, vitest 5 + jsdom, Playwright (Chromium), esbuild. Zero runtime dependencies.

**Spec:** No separate spec. The findings come from the 2026-10-17 stress pass (fuzz + real-browser paste corpus, probes kept in the session scratchpad). The user decided: *escape literal text* (stored format gains backslash escapes) and *plan first*. The findings this plan fixes, all reproduced:

| # | Input | Today |
|---|---|---|
| F1 | Plain-pasted `price 2*3*4`, `` ```js ``, `1. step`, `# x`, `> x`, `[t](http://a.b)` | Look literal; after reopen or module switch they become italic `234`, an empty code block (text lost), a list, a heading, a quote or a link |
| F2 | Multi-block paste into the middle of a `<li>` | Next save mashes every line into one bullet ("Titleconst a = 1;const b = 2;") |
| F3 | VS Code / Wikipedia / Outlook / Google Sheets / Slack HTML | One run-on line, table lost ("NameQtyAna"), triple blank lines |
| F4 | `<li><p>Then</p><p>second</p></li>` (ChatGPT, Docs, Word) | "Thensecond" — word boundary lost |
| F5 | Word list paragraphs (`mso-list`) | "· Item" text lines, not a list |
| F6 | 1,500-line plain paste | 4–9 s UI freeze (Chromium `insertText` is quadratic; an escaped-`<div>` `insertHTML` takes 135 ms) |
| F7 | Paste into a heading or blockquote | Chromium adds `style=` to inserted spans, so the text looks wrong until reopen |
| F8 | Search over NFD text (`ação` decomposed) or Hangul | Snippet misses the match (Hangul gives an empty snippet); the pane highlight lands on the wrong characters or throws `IndexSizeError` |

## Global Constraints

- Zero runtime dependencies. Dev tooling only: `esbuild`, `typescript`, `vitest`, `jsdom`, `@playwright/test`.
- Work directly on `dev`: no worktrees, no feature branches.
- Every `src` module has a matching `test/*.test.ts`. New behaviour is pinned there.
- No user-visible strings are added (no i18n keys needed). If one is added, it goes through `t()` with both `pt-BR` and `en-US`.
- Commits are conventional and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Gate per task: `npm run typecheck && rtk bypass npm run lint && npm test`. Also run `npm run test:e2e` after Tasks 3, 5 and 8.
- Known timing flakes that pass when re-run alone: `test/search-backlinks-perf.test.ts`, `test/search-narrowing.test.ts`, and e2e `leak.spec.ts:738`.
- The escapable set is exactly ``\ * ~ [ ] < > # - . ` ``. A backslash before any other character stays a literal backslash, so Windows paths like `C:\Users` are unaffected.
- Fenced code (`pre`) content is never escaped and never unescaped.

## Review Focus

1. **Old notes whose text has a backslash before an escapable character** (e.g. `C:\*.log`, a regex `\d+\.` outside a fence) now render without that backslash. This is the accepted cost of the user's decision. Pin that `C:\Users\me` and fenced `\d+\.` are unchanged (Task 3).
2. **Editor formatting must still round-trip exactly**: bold, italic, strike, underline, links, refs, `~unlinked~`, lists, headings, quotes, fences. Any change in an existing round-trip test expectation must be a *literal-text* case, never a formatting case (Task 3, existing suites).
3. **Escapes next to markers**: a text node ending in `\` followed by a `**` marker, escaped `[` / `]` inside link text, `~` inside an unlinked-ref label. These must not break the marker pairing (Task 3).
4. **Lines over `INLINE_PARSE_LIMIT` (10,000 chars)** are shown unparsed. They must show unescaped text and stay stable across saves (Task 3).
5. **`getMd` hot path cost**: the container walker runs on every debounced save. Long notes must not regress: e2e `hotpath`, `perf` and `search-edit-cost` must stay green (Tasks 1 and 3 e2e runs).

---

### Task 1: One container walker in `htmlToMd` (F3, F4 groundwork)

**Files:**
- Modify: `src/core/markdown.ts` (`htmlToMd`, new helpers next to `BLOCK_TAGS`)
- Test: `test/markdown.test.ts`

**Interfaces:**
- Produces (module-private, used by Task 2):
  - `walkBlocks(parent: Node, out: string[], flat: boolean): void` pushes one markdown line per output line.
  - `isBlockish(el: Element): boolean` is true for `BLOCK_TAGS`, `h4`–`h6`, `CONTAINER_TAGS`, and any element that has a blockish descendant.
- Produces (module constants): `NON_CONTENT_TAGS = new Set(['head','title','style','script','template','noscript','meta','link'])`. `CONTAINER_TAGS = new Set(['html','body','section','article','header','footer','main','nav','aside','figure','figcaption','details','summary','address','center','dl','dt','dd','fieldset','form'])`.
- `htmlToMd(root)` becomes `walkBlocks(root, out, false)`. Its signature and return value are unchanged.

`walkBlocks` rules (non-flat):
- Consecutive non-blockish child nodes form an **inline run**, flushed through `blockToMdNodes(run)`. A run that is only whitespace emits nothing.
- A blockish child flushes the pending run first, then is handled as follows:
  - `h1`–`h3`: as today.
  - `h4`–`h6`: `### `.
  - `blockquote`, `ul`/`ol`, `pre`, `hr`, `table`: as today.
  - `div`/`p`: a nested `walkBlocks` if it has a blockish child, else `blockToMd` as today.
  - Any other element (container or unknown wrapper): a nested `walkBlocks`.
- `NON_CONTENT_TAGS` elements are skipped wherever they appear, including inside an inline run (today `inlineMd` already drops `script`/`style`).

Flat mode (used by Task 2) emits content only:
- A heading gives its text without `#`.
- A blockquote gives its lines without `> `.
- A `pre` gives each `preLines` line.
- `hr` gives nothing.
- A table gives its rows.
- `ul`/`ol` never reach flat mode, because `liOwnContentNodes` removes them first.

- [ ] **Step 1: Write the failing tests** in `test/markdown.test.ts`, in a new `describe('htmlToMd: containers holding blocks')`. Build a root `div` from each HTML string and assert `htmlToMd(root)`:

```ts
test('a div holding blocks keeps each block on its own line (Wikipedia shape)', () => {
  expect(md('<div><h2>History<span>[edit]</span></h2><p>Some <b>text</b></p><figure><img src="x"><figcaption>Caption</figcaption></figure><h4>Sub</h4><p>end</p></div>'))
    .toBe('## History[edit]\nSome **text**\nCaption\n### Sub\nend')
})
test('VS Code line divs inside one pre-styled div stay separate lines', () => {
  expect(md('<div style="white-space: pre;"><div><span>const</span> x = 1</div><div>  return y</div><div><br></div><div>}</div></div>'))
    .toBe('const x = 1\n  return y\n\n}')
})
test('a custom-element wrapper holding a style tag still yields its table rows (Google Sheets)', () => {
  expect(md('<google-sheets-html-origin><style>td{}</style><table><tbody><tr><td>Name</td><td>Qty</td></tr><tr><td>Ana</td><td>3</td></tr></tbody></table></google-sheets-html-origin>'))
    .toBe('Name | Qty\nAna | 3')
})
test('inline runs between blocks join into one line and br splits them (Slack shape)', () => {
  expect(md('<span>hello <b>world</b></span><br><span>line two</span><br><ul><li>x</li></ul>'))
    .toBe('hello **world**\nline two\n- x')
})
test('Outlook WordSection wrapper keeps its paragraphs apart', () => {
  expect(md('<div class="WordSection1"><p>Oi time,</p><div><p><b>From:</b> Ana</p></div><blockquote><p>original</p></blockquote></div>'))
    .toBe('Oi time,\n**From:** Ana\n> original')
})
test('head, title, style, script and template content never becomes text', () => {
  expect(md('<title>T</title><style>.a{}</style><div>x</div><script>y</script><template>z</template>')).toBe('x')
})
```

`md(html)` is a local helper. It sets a fresh `div`'s `innerHTML` and returns `htmlToMd` of it. Note that the Outlook expectation's `> original` relies on the existing blockquote recursion.

- [ ] **Step 2: Run them and watch them fail.**
  - Run: `npx vitest run test/markdown.test.ts -t "containers holding blocks"`
  - Expected: 6 FAIL. Today's output mashes lines, for example `History[edit]Some **text**…` and `NameQtyAna…`.

- [ ] **Step 3: Implement** `walkBlocks` / `isBlockish` and the constants. Switch `htmlToMd` to `walkBlocks(root, out, false)`. Keep the `blockquote` branch's existing recursion (`htmlToMd(node)` when it has a block child). It now benefits from the walker automatically. `isBlockish` checks an element's descendants with one precomputed selector string, and only for elements that are not themselves block/container tags.

- [ ] **Step 4: Run the new tests plus the whole codec and editor suites.**
  - Run: `npx vitest run test/markdown.test.ts test/editor.test.ts`
  - Expected: all PASS. No existing expectation changes. The editor's own DOM is flat blocks, so its output is identical. If an existing test changes, stop: it means the editor's own shape is affected.

- [ ] **Step 5: Commit.** Message: `fix: paste keeps lines and tables from wrapper-heavy HTML (VS Code, Wikipedia, Outlook, Sheets, Slack)`.

### Task 2: List items holding blocks become sibling items (F2, F4)

**Files:**
- Modify: `src/core/markdown.ts` (`renderListMd`, `renderListText`)
- Test: `test/markdown.test.ts`, `test/editor.test.ts`

**Interfaces:**
- Consumes: `walkBlocks(parent, out, true)` from Task 1.
- Produces: `liLines(li: HTMLElement): string[]`, module-private. It returns the item's own content as one entry per line. It wraps `liOwnContentNodes(li)` in a detached container and calls `walkBlocks(container, lines, true)`, dropping empty lines. With no blockish node and no `<br>`, it returns exactly `[blockToMdNodes(nodes)]`, which is today's output.
- `renderListMd` puts the first line on the item's own marker. Each further line becomes a sibling item at the same depth: `- ` for `ul`, and for `ol` the next number, continuing `i`. Nested lists still follow at `depth + 1` after all of the item's own lines.
- `renderListText` gets the same split for plain-text copy, one line per entry at the item's indent.

- [ ] **Step 1: Write the failing tests.**

```ts
// test/markdown.test.ts — describe('htmlToMd: list items holding blocks')
test('an li with two paragraphs keeps the word boundary as two sibling items', () => {
  expect(md('<ol><li><p>Then</p><p>second para</p></li><li>last</li></ol>')).toBe('1. Then\n2. second para\n3. last')
})
test('blocks pasted mid-item become sibling bullets, the nested list still follows', () => {
  expect(md('<ul><li>item t<h2>Title</h2><pre>const a = 1;\nconst b = 2;</pre><div>Use it</div>ext<ul><li>sub</li></ul></li></ul>'))
    .toBe('- item t\n- Title\n- const a = 1;\n- const b = 2;\n- Use it\n- ext\n  - sub')
})
test('a plain li is unchanged', () => {
  expect(md('<ul><li>a <b>b</b></li></ul>')).toBe('- a **b**')
})
```

In `test/editor.test.ts`, inside `describe('paste')`, add `'pasting multi-block HTML while the caret is in a list item serializes every block as its own item'`. Paste `<h2>Title</h2><p>one</p><p>two</p>` with the caret in `- item`. Simulate the insert by appending the converted fragment into the `<li>`, the shape Chromium produces. Then `editor.getMd()` must contain `'- Title'`, `'- one'`, `'- two'` and must not contain `'Titleone'`.

- [ ] **Step 2: Run and watch them fail.**
  - Run: `npx vitest run test/markdown.test.ts test/editor.test.ts -t "list item"`
  - Expected: FAIL, with mashed text such as `1. Thensecond para`.

- [ ] **Step 3: Implement** `liLines`, and use it in `renderListMd` and `renderListText`.

- [ ] **Step 4: Run the codec and editor suites.**
  - Run: `npx vitest run test/markdown.test.ts test/editor.test.ts`
  - Expected: all PASS, with no existing expectation changed.

- [ ] **Step 5: Commit.** Message: `fix: blocks inside a list item save as sibling items instead of one mashed line`.

### Task 3: Backslash escapes — literal text round-trips exactly (F1)

**Files:**
- Modify: `src/core/markdown.ts` (`esc` strip range, new `ESC_OPEN`/`ESC_CLOSE`, `inline()`, `inlineMd`, the link branch, line emission in `walkBlocks`)
- Modify: `src/core/search.ts` (`stripMd`)
- Test: `test/markdown.test.ts`, new `test/markdown-fuzz.test.ts`, `test/search.test.ts`

**Interfaces:**
- Produces (module-private in `markdown.ts`):
  - `escapeInline(text: string): string` escapes:
    - `*`, `~`, `[` and `]`;
    - `<` only when it starts a `<u>` or `</u>`;
    - `\` when it is followed by an escapable character or ends the text node.
  - `escapeLineStart(line: string): string` adds one backslash where a plain line would otherwise parse as a block:
    - `#{1,3} ` gives `\#…`;
    - `>` gives `\>…`;
    - `` ``` `` gives `` \``` ``;
    - a line of only `-{3,}` gives `\---`;
    - `^( *)- ` gives `$1\- `;
    - `^( *)(\d+)\. ` gives `$1$2\. `.
- `inlineMd` text nodes return `escapeInline(text)`. The link branch strips brackets *including* their escape: `kids().replace(/\\?[[\]]/g, '')`.
- `walkBlocks` passes every plain line it emits (div/p lines, inline runs, table rows, heading continuation lines) through `escapeLineStart`. List-item text, heading text, blockquote text and fence lines are not line-escaped, because they are never block-parsed.
- `inline()`:
  - Right after `esc(s)`, it replaces `/\\(&lt;|&gt;|[\\*~[\]#.`-])/g` with `ESC_OPEN + index + ESC_CLOSE` tokens.
  - Those tokens are restored as the stored (already HTML-escaped) character in the terminal splice, after LINK and REF.
  - `ESC_OPEN = '\uE006'` and `ESC_CLOSE = '\uE007'`. The `esc()` strip range widens to `[\uE000-\uE007]`, and its comment is updated.
  - The over-limit path returns `esc(s).replace(/\\(&lt;|&gt;|[\\*~[\]#.`-])/g, '$1')`.
- `search.ts` `stripMd`:
  - First maps each escape `\c` to a PUA stand-in (`String.fromCharCode(0xF000 + c.charCodeAt(0))`).
  - Then runs today's strips.
  - Then maps the stand-ins back to `c`.
  - Snippets therefore show literal characters, and a query `2*3` finds `2\*3`.

- [ ] **Step 1: Write the failing tests.**

In `test/markdown.test.ts`, add `describe('literal text survives a save/reopen')`. For each `[position, text]`, build the editor shape, then assert `textContent(mdToHtml(htmlToMd(root)))` equals `text`. The positions are a div line, `<ul><li>`, `<h2>` and `<blockquote>`. The texts are:

```ts
const LITERALS = ['price 2*3*4 = 24', '```js', '1. first step', '- dash item', '> quoted reply', '# not a heading',
  '[link](http://x.y)', '@[Ana](person:p1)', '*important*', '**really**', '~~old~~', '~5 days ~10 people', '---',
  '<u>x</u>', 'a\\*b', 'ends with \\', 'C:\\Users\\me', '  - indented dash', '\\\\server\\share']
```

The editor's formatting must still parse. Add `test('formatting written by the editor still round-trips unchanged')` over `['**b** *i* ~~s~~ <u>u</u> [l](https://a.b) @[A](person:p1) ~Old~', '# H', '- a\n  - b', '1. x', '> q', '```\ncode *x*\n```']`. Each must hold `htmlToMd(m2h(md)) === md`.

Compatibility pins:
- `mdToHtml('C:\\Users\\me')` contains `C:\\Users\\me`.
- `mdToHtml('```\n\\d+\\.\n```')` contains `\\d+\\.` inside `<pre>`.

Marker adjacency:
- `<div><b>a\\</b>b</div>` round-trips its text.
- `<a href="https://x.y">a[b]</a>` saves as `[ab](https://x.y)`.
- `<span class="tt-unlinked-ref">a~b</span>` round-trips as one muted span with text `a~b`.

Long line: a 12,000-char line `'x*'.repeat(6000)` in a div must keep its text across two round trips, and the markdown must be stable between the first and second round trip.

New `test/markdown-fuzz.test.ts`, seeded with the LCG from `test/search-fixture.ts`'s `makeRng`:
- `'random literal text in any block position survives save/reopen'`: 1,500 cases from the stress token set (minus PUA characters, CR and U+2028). Compare after nbsp→space.
- `'normalization is idempotent: a second save never changes the markdown again'`: 1,500 random markdown strings. Assert `h2m(h2m(md)) === h2m(md)`.
- `'rendered markup stays within the allowlist'`: no `on*` attributes, `href` only `http(s):`/`mailto:`, and tags within the stress allowlist.

Failure messages carry the seed and the input.

In `test/search.test.ts`:
- `test('an escaped literal is found and shown without its backslash')`: `generalNotes = 'price 2\\*3\\*4'`, then `searchDocument(d, '2*3', 't1')` gives one hit whose snippet contains `2*3*4` and no `\\`.

- [ ] **Step 2: Run and watch them fail.**
  - Run: `npx vitest run test/markdown.test.ts test/markdown-fuzz.test.ts test/search.test.ts`
  - Expected: the literal, fuzz and search tests FAIL. The formatting and compatibility pins should already pass. If a pin fails before any code change, the test is wrong.

- [ ] **Step 3: Implement** the escaping in `markdown.ts` and the `stripMd` stand-ins in `search.ts`.

- [ ] **Step 4: Run the full unit suite.**
  - Run: `npm test`
  - Expected: green apart from the known flakes.
  - Existing expectations may change *only* where the input is literal text that now gains a backslash in the markdown. Update each such expectation and list every changed test name in the commit body.
  - A changed expectation involving formatting markup, a ref or a link is a bug in this task, not a test to update.

- [ ] **Step 5: e2e.**
  - Run: `npm run test:e2e`
  - Expected: 114 passed (or the known `leak.spec.ts:738` flake, which passes alone).

- [ ] **Step 6: Commit.** Message: `feat: escape literal markdown characters so pasted text never changes on reopen`. The body lists the escapable set, the compatibility note, and the changed test expectations.

### Task 4: Word list paragraphs become real lists (F5)

**Files:**
- Modify: `src/core/markdown.ts` (new export next to `unwrapBlockContainers`)
- Modify: `src/ui/editor.ts` (`htmlClipboardToMd`)
- Test: `test/markdown.test.ts`, `test/editor.test.ts`

**Interfaces:**
- Produces: `export function convertWordLists(root: HTMLElement): void`.
  - It finds each run of consecutive sibling elements whose `style` *attribute text* contains `mso-list:`.
  - Level: `/level(\d+)/` (1-based), clamped to `MAX_LIST_DEPTH + 1`.
  - Kind: `ol` when the `span[style*="mso-list:Ignore"]` marker text (trimmed, nbsp removed) matches `/^[0-9a-zA-Z]+[.)]$/`, else `ul`.
  - It removes the marker span and builds nested `ul`/`ol` with one `li` per paragraph, moving the paragraph's remaining child nodes into the `li`. It replaces the run in place.
  - A paragraph without a marker span still becomes an item. Non-Word input is left untouched.
- `htmlClipboardToMd` calls `convertWordLists(wrapper)` before `unwrapBlockContainers(wrapper)`.

- [ ] **Step 1: Write the failing tests.** Use the stress-pass Word fragment (the Word case from the probe's corpus): two bullet paragraphs at `level1`, plus one `level2`.

```ts
test('Word bullet paragraphs become a real nested list and lose their glyph', () => {
  const root = parse(WORD_BULLETS); convertWordLists(root)
  expect(htmlToMd(root)).toBe('Texto **negrito**\n- Item um\n  - Sub item\n- Item dois')
})
test('Word numbered paragraphs become an ordered list', () => { /* markers "1." "2." */ expect(out).toBe('1. Primeiro\n2. Segundo') })
test('non-Word HTML is untouched', () => { const html = '<p style="color:red">x</p><ul><li>y</li></ul>'; /* innerHTML identical after convertWordLists */ })
```

`test/editor.test.ts` paste: `'a Word list paste inserts list markup, not "·" text'`. The `insertHTML` argument contains `<li>` and does not contain `·`.

- [ ] **Step 2: Run and watch them fail.** Run: `npx vitest run test/markdown.test.ts test/editor.test.ts -t "Word"`. Expected: FAIL, because `convertWordLists` is not exported.

- [ ] **Step 3: Implement** `convertWordLists` and the call site.

- [ ] **Step 4: Run.** Run: `npx vitest run test/markdown.test.ts test/editor.test.ts`. Expected: all PASS.

- [ ] **Step 5: Commit.** Message: `fix: Word list paste becomes a real list instead of "·" text lines`.

### Task 5: Multi-line plain-text paste in one insert (F6)

**Files:**
- Modify: `src/ui/editor.ts` (`onPaste` plain branch)
- Test: `test/editor.test.ts`, `e2e/editor.spec.ts`

**Interfaces:**
- Produces: in `onPaste`, when there is no usable HTML, the text contains `\n` after `\r\n`/`\r` normalisation, and the caret is **not** inside an `<li>` (lists keep native `insertText`, which splits into sibling items), the editor:
  - builds `lines.map(l => '<div>' + (escapeHtml(l) || '<br>') + '</div>').join('')`;
  - calls `insertHTML` once;
  - then runs the same `flattenTopLevelBlockWrappers` / `decorateCodeBlocks` / `syncPreHighlight` / `scheduleChange` tail as the HTML branch.
- `escapeHtml` escapes `&`, `<` and `>`. Leading spaces on a line become `\u00a0` so indentation survives, matching `preserveIndent`.
- Single-line text and the in-`pre` path are unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `test/editor.test.ts`, `'multi-line plain text is inserted as one insertHTML of literal lines'`:
    - `{ 'text/plain': 'a\r\n<b>\r\n\r\n  - x' }`
    - Exactly one `execCommand` call, with `'insertHTML'` and `'<div>a</div><div>&lt;b&gt;</div><div><br></div><div>\u00a0\u00a0- x</div>'`.
    - No `insertText` call.
  - `'multi-line plain text inside a list item still uses insertText'`.
  - `e2e/editor.spec.ts`, `'a 1,500-line plain-text paste lands in under 1.5 s and keeps every line literal'`:
    - Use the stress log payload (`path=/api/v1/items_${i}*`).
    - Time from dispatch to the 1,500th `.editor > div` being present.
    - After a module switch away and back, the last line's text still ends with `*`.

- [ ] **Step 2: Run and watch them fail.** Run: `npx vitest run test/editor.test.ts -t "plain text"`. Expected: FAIL, because `insertText` is called.

- [ ] **Step 3: Implement** the branch.

- [ ] **Step 4: Run** `npx vitest run test/editor.test.ts`, then `npm run test:e2e`.
  - Expected: all PASS. The new e2e timing is far below the 4–9 s measured today.

- [ ] **Step 5: Commit.** Message: `perf: multi-line plain-text paste inserts once instead of freezing on large pastes`.

### Task 6: Strip Chromium's inline styles after a paste (F7)

**Files:**
- Modify: `src/ui/editor.ts` (`onPaste`, both insert branches)
- Test: `e2e/editor.spec.ts`. jsdom's stubbed `execCommand` cannot reproduce Chromium's style injection, so a unit test would prove nothing.

**Interfaces:**
- Produces: after any paste insert, `editorEl.querySelectorAll('[style]').forEach((e) => e.removeAttribute('style'))`.
  - This is safe: nothing the editor renders inside `editorEl` carries an inline style. The code-block controls and copy menu live on `root`, outside `editorEl`.
  - Add a comment stating that invariant.

- [ ] **Step 1: Write the failing e2e test.** `'paste into a heading leaves no inline style on the inserted text'`:
  - Use the stress harness's heading setup.
  - Paste `<p>Texto <b>negrito</b> e <i>itálico</i></p>`.
  - `editor.locator('[style]')` has count 0.
- [ ] **Step 2: Run and watch it fail.** Run: `npx playwright test e2e/editor.spec.ts -g "inline style"`. Expected: FAIL (count > 0).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Run: `npx playwright test e2e/editor.spec.ts`. Expected: all PASS.
- [ ] **Step 5: Commit.** Message: `fix: pasting into a heading or quote no longer leaves Chromium inline styles behind`.

### Task 7: Search index alignment for text `normalize()` reshapes (F8)

**Files:**
- Modify: `src/core/search.ts` (new export, `makeSnippet`)
- Modify: `src/ui/search-ui.ts` (snippet highlighter), `src/ui/search-highlight.ts` (`findMatchRanges`)
- Test: `test/search-normalize.test.ts`, `test/search.test.ts`, `test/search-highlight.test.ts`, `test/search-ui.test.ts`

**Interfaces:**
- Produces: `export function normalizeWithOffsets(s: string): { normalized: string; offsets: number[] | null }`.
  - `normalized === normalize(s)` always.
  - `offsets` is null when every index is already aligned. That covers pure ASCII and the Latin-1 fold path, so the hot path stays allocation-free.
  - Otherwise `offsets` has `normalized.length + 1` entries: `offsets[k]` is the index in `s` of the code unit `normalized[k]` came from, and `offsets[normalized.length] === s.length`.
  - It is built per code point (each code point's `normalize` output maps to that code point's start index). If the per-code-point join differs from `normalize(s)` (e.g. Greek final sigma), it returns `offsets: null`, which is today's behaviour.
- Each consumer maps a match `[idx, idx + term.length)` to `[map(idx), map(idx + term.length)]`, where `map = (i) => offsets ? offsets[i]! : i`, and clamps to the text length.

- [ ] **Step 1: Write the failing tests.**
  - `search-normalize.test.ts`:
    - `normalizeWithOffsets('abc').offsets` is `null`.
    - For `'reunião'` (precomposed) it is `null`.
    - For NFD `'ac\u0327a\u0303o x'`, `normalized === 'acao x'`, and `offsets` maps index 5 (`'x'`) to 7.
    - For `'\uD55C x'`, `normalized.endsWith(' x')`, and `offsets` maps the `x` back to 2.
  - `search.test.ts`, `'a match after decomposed text still lands in its snippet'`: 40 × NFD `ação ` then `TARGETWORD`; the snippet contains `TARGETWORD`. Add the same for Hangul ×60.
  - `search-highlight.test.ts`, `'findMatchRanges highlights the right characters in decomposed text and never throws on Hangul'`. The range `toString()` equals `TARGETWORD` for both.
  - `search-ui.test.ts`: the snippet highlight `<mark>` text equals the original matched characters for an NFD snippet.
- [ ] **Step 2: Run and watch them fail.** Run: `npx vitest run test/search-normalize.test.ts test/search.test.ts test/search-highlight.test.ts test/search-ui.test.ts`. Expected: FAIL on the new tests (missing export, wrong snippet, `IndexSizeError` on Hangul).
- [ ] **Step 3: Implement** the helper and the three call sites. Update the three "index-aligned" doc comments to point at `normalizeWithOffsets`.
- [ ] **Step 4: Run** `npm test`. Expected: green (known flakes aside). The search perf and memory tests must not regress, because the fast path returns `null` offsets.
- [ ] **Step 5: Commit.** Message: `fix: search snippets and highlights line up for decomposed and Hangul text`.

### Task 8: Real-browser paste corpus as a permanent regression spec

**Files:**
- Create: `e2e/paste-sources.spec.ts`. Derive it from the scratchpad probe `zz-paste-stress.spec.ts`, trimmed to assertions.

**Interfaces:**
- Consumes: everything above. Reuses `installOpfsPickerShim`, `createEncryptedDoc` and `blockUpdateCheck`.

**What it covers:**
- Clipboard sources: Word, Excel, Outlook, Wikipedia, VS Code, GitHub, Slack, Notion, Google Sheets, ChatGPT, the HTML edge set, image-only, deep nesting, the hostile set, CRLF plain, markdown-looking plain, TSV plain, and the unicode plain set.
- Caret positions: empty line, mid-line, list item, heading, blockquote.

**Assertions for each source × position:**
1. Top-level children are only `DIV,H1,H2,H3,UL,OL,PRE,BLOCKQUOTE,HR`. No other tags beyond inline `LI,BR,STRONG,B,EM,I,U,S,CODE,A,SPAN`.
2. No `style` or `on*` attributes, and every `href` is `http(s):` or `mailto:`.
3. No visible `StartFragment`, `EndFragment`, `mso-`, `<!--`, `[if`, `MsoNormal` or `xmlns`.
4. `editor.innerText`, whitespace-normalized, is identical before and after a module switch away and back.
5. No page errors, no `window.__pwned`, and no request to `evil.example.test`.

Per-source content checks:
- VS Code has ≥ 3 lines.
- Google Sheets text contains `Name | Qty`.
- Word has `li` count 2.
- Markdown-looking plain text keeps `2*3*4` after the switch.

- [ ] **Step 1: Write the spec and prove it catches today's bugs.**
  - Rebuild from the pre-Task-1 sources: `git checkout <task-1-base> -- src && npm run build`.
  - Run the spec there, and record which sources and assertions fail. Expect at least VS Code, Google Sheets, Word, list-item and markdown-looking plain text.
  - Restore the current sources: `git checkout HEAD -- src && npm run build`.
- [ ] **Step 2: Run it on HEAD.** Run: `npx playwright test e2e/paste-sources.spec.ts`. Expected: PASS.
- [ ] **Step 3: Full e2e.** Run: `npm run test:e2e`. Expected: all pass (known flake aside), and runtime grows by under 2 minutes.
- [ ] **Step 4: Commit.** Message: `test: real-browser paste corpus covering common clipboard sources and caret positions`.

---

## Out of scope (seen in the stress pass, judged not worth a change)

- An image-only paste inserts one empty line. It is harmless and easily deleted.
- ChatGPT's code header text ("bashCopy code") lands in the code block. That text is real DOM text in the source.
- A Wikipedia citation `<sup>[1]</sup>` glues to the previous word ("ref1"). There is no superscript in the dialect.
- TSV plain paste: tabs render as single spaces.
- Long-lived editor DOM growth: confirmed to be Chromium's native undo history (4–22 nodes per action, 0 listeners), released on remount. Not an app leak.
