# Code Review Fixes, Part 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the findings from the second review pass (the files the first pass did not cover) that re-verification showed are real and worth the change, pin each fix and the behaviour next to it with tests, and record why the rest are left alone.

**Architecture:** Bug fixes come first, each at the layer that owns the behaviour: read-only gaps in the editor and prefs, two keyboard traps in the `@` and `/` dropdowns, a fence round-trip in the markdown codec, and a missing open-card check on three navigation paths (fixed by giving those paths one shared helper). Small correctness fixes follow. Refactors come last, and only ones that remove real duplication with drift risk; each runs against the existing tests unchanged plus a characterization test where coverage was thin.

**Tech Stack:** TypeScript 6, vitest 5 + jsdom, Playwright e2e, zero runtime dependencies.

**Spec:** No separate spec. The review report (second pass, 2026-10-16) plus the evaluation table below act as the spec. Probe tests used to confirm findings were deleted; each confirmed finding gets a real regression test here.

## Global Constraints

- Zero runtime dependencies. Add nothing to `dependencies`.
- All user-visible strings go through `t()` with keys in both `pt-BR` and `en-US`. **No task adds a string**; reuse `readonly_blocked_toast` where a read-only hint is needed.
- Every new `src` module gets a matching `test/*.test.ts`.
- Work directly on `dev`. No worktrees, no feature branches.
- Gate per task: `npm run typecheck && rtk bypass npm run lint && npm test`. `test/search-backlinks-perf.test.ts` is a known timing flake — re-run it alone before treating a failure as real.
- Also run `npm run test:e2e` after Tasks 1, 4, 5 and 12 (editor, codec and navigation changes).
- Commit messages are conventional (`fix:` / `refactor:` / `test:`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No version bump in this plan. A release shipping these needs a short `CHANGELOG.md` entry via the `changelog` skill.

## Finding evaluation (is it really a problem, and is the change worth it?)

| # | Finding | Verdict | Evidence / reason | Task |
|---|---------|---------|-------------------|------|
| C1 | Read-only tab: editor toolbar buttons, Ctrl+X (and, defensively, keydown/paste) still change the note | **Confirmed. Fix** | Probe after `setEditorsReadOnly(true)`: — turned `a` into `a\n---\n`; 🧹 turned `# Head` into `Head`; `{ }` unwrapped a code block; a `cut` event emptied the note. `store.update` refuses the write, so the change is shown and lost — exactly what the previous plan's Task 15 set out to stop. | 1 |
| C2 | Read-only tab: Prefs Data tab shows success toasts for blocked writes | **Confirmed. Fix** | Probe: tag cross-apply left teams unchanged and toasted "Tags applied to all teams." Import and cleanup have the same shape. The Security tab already disables its controls when read-only — same precedent. | 2 |
| C3 | `@` dropdown with zero matches swallows Enter/Tab/arrows | **Confirmed. Fix (high value)** | Probe: typing `john@acme.com` then Enter — zero items, Enter `defaultPrevented`, dropdown stays. Any email typed in a note hits this. The `/` picker swallows one Enter on an empty list. | 3 |
| C4 | ```` ``` ```` fences break on save/reopen | **Confirmed. Fix** | Probe: a plain line `` ```js `` (typed then Enter — only an all-backtick line converts) reopens as a fence that swallows the rest of the note; a code block holding a `` ``` `` line closes early and gains an extra fence. | 4 |
| C5 | Link tooltip shows `&amp;` for URLs with `&` | **Confirmed. Fix (one line)** | Probe: title `https://e.com/?a=1&amp;b=2`. Href is escaped twice. | 4 |
| L1 | Search result and due-item navigation skip the open-card check | **Real. Fix** | Palette (`palette.ts:72`) and `navigateToLoc` (`atref.ts:321`) call `dismissModelessModals()` first; `search-ui.ts:239` and `sidebar.ts:370` do not. With a card whose required-name guard vetoes, `selectTeam` aborts (`main.ts:562`) but `openInFocused` still opens team B's content under team A. Fixing it through one shared helper also removes the 4× copy of the "focus the item" block (R1). | 5 |
| L2 | Read-only tab: adding a team navigates to a team that was never created | **Real (minor). Fix** | `sidebar.ts:705-718` calls `selectTeam(newTeamId)` after a blocked `store.update`. | 6 |
| L3 | Start screen: auto-open-last can override a file the user launched or picked | **Real (narrow). Fix** | `start.ts:379-408`: both routes call `onOpen`; last to resolve wins, and `main.ts` swaps documents. Fix is a flag. `handleOpenFallbackFile` duplicates `openAndDecrypt` (R9) — folded in. | 7 |
| L4 | Password change reports failure after succeeding when IndexedDB is unavailable | **Real (narrow). Fix at source** | `hasMissingGrant` (`backup-controller.ts:201`) can reject; `currentHealth` propagates it into `change-password.ts:78` after the password was already changed. `checkOrphaned` already swallows the same failure. | 8 |
| L5 | Context menu Enter acts behind a blocking modal | **Real (rare). Fix (one line)** | Every other document-level dropdown guards on a modal (`editor.ts:1484`, `sidebar.ts:221`, `palette.ts`). | 9 |
| R3 | Ref-chip DOM built in two places with drifting attributes | **Fix** | `atref.ts:230` omits the `title` hint that `mdToHtml` and `refreshRefLabels` set: a just-inserted chip has no hover hint until reload. | 10 |
| R8 | Done/cancelled predicate re-implemented 5×; due "overdue by / in N days" label 2×; prefs re-implements `clampInt` | **Fix** | `isActionActive` (`due.ts:22`) exists; a new terminal status would have to be added in five places. | 11 |
| R2/R4 | Clipboard-write fallback 4×; caret-placement boilerplate ~8× and `mdToHtml(md, …4 args)` 4× in `editor.ts` | **Fix (last, low risk)** | One copy of the caret block already had a bug fixed in place (`exitFlatBlock` comment). Editor has ~3600 lines of tests; no behaviour change. | 12 |
| — | IndexedDB writes resolve before commit (`idb.ts:46`) | **Not fixing** | Only reachable on quota abort; the downstream effect (an "orphaned" backup id) already degrades gracefully with its own notice. | — |
| — | Failed backup write doesn't `abort()` the writable | **Not fixing** | Best-effort mirror; no user-visible effect identified. | — |
| — | Edit-team can't clear the emoji | **Not fixing** | `emoji || team.emoji` reads as deliberate; product decision, not a bug. | — |
| — | Search snippets keep `[text](url)`, `> `, fences | **Not fixing** | Cosmetic; URL text being searchable is arguably useful. | — |
| — | Unclosed fence swallows the rest of a note | **Not fixing** | Pinned behaviour (`markdown.test.ts` "an unclosed fence still flushes at end of input"). After Task 4 only a pasted plain-text `` ``` `` line can still produce it. | — |
| R5 | Dropdown machinery (atref / template-picker / editor copy menu) triplicated | **Not now** | Real duplication, but the three differ on purpose (refresh vs close-on-input); the two concrete bugs are fixed in place by Task 3. Revisit if a third bug lands there. | — |
| R6 | Split `prefs.ts` (1342 lines) by tab | **Not now** | Pure churn; tests drive it through `openPrefs` only. | — |
| R7 | Sidebar team-row markup 2×, hand-written SVGs | **Not fixing** | Low drift risk, cosmetic. | — |
| R10 | `backup-controller.ts` / `change-password.ts` import `ui/` | **Not fixing here** | Same pattern in `save-controller`, `conflict-flow`, `tab-lock` (left as-is by the first plan). Changing two of five is inconsistent; do all five together or reword `src/core/CLAUDE.md`. | — |

## Review Focus

1. A link dialog, `@` dropdown or `/` picker left **open when the read-only lock arms** must commit nothing. Tests in Task 1.
2. **Every file already on disk** must parse exactly as before the fence change: a plain ```` ``` ```` opener still closes on any line starting with ```` ``` ````, including ```` ```js ````. Test in Task 4.
3. With the `@` dropdown **showing matches**, Enter/Tab still pick (only the zero-match case lets keys through). Existing test `typing after @ filters the list; Enter inserts the chip` stays green; Task 3 adds the zero-match one.
4. A **vetoed** card close during a search-result click keeps the search dropdown open and does not switch team. Test in Task 5.
5. Auto-open-last **still opens** when nothing else started an open (existing start tests at `start.test.ts:597-650` stay green); Task 7 adds the race tests.

---

### Task 1: Read-only editors take no edit from the toolbar, clipboard or keyboard

**Files:**
- Modify: `src/ui/readonly-lock.ts` (`EDITING_CLICK_TARGETS`, ~line 27)
- Modify: `src/ui/editor.ts` — `onKeydown` (~1637), `onPaste` (~1796), `onCut` (~1862), `insertLink` after its `await` (~1321), toolbar copy/help buttons (~2052-2053)
- Modify: `src/ui/atref.ts` `commit` (~218), `src/ui/template-picker.ts` `commit` (~158)
- Test: `test/editor.test.ts` (`describe('setEditorsReadOnly')`, ~3558), `test/readonly-lock.test.ts`, `test/atref.test.ts`, `test/template-picker.test.ts`

**Interfaces:**
- Produces: CSS class `tt-editor-btn-readonly-safe` on the copy-options and help toolbar buttons. `readonly-lock.ts` refuses clicks on `.tt-editor-toolbar .tt-editor-btn:not(.tt-editor-btn-readonly-safe)` (gets the standard toast).
- Editor-side guard reads the existing module-level `editorsReadOnly`. Dropdowns check their editor element: `editorEl.getAttribute('contenteditable') === 'false'` → close and return.

Why split this way: toolbar clicks go through `readonly-lock`'s capture guard (one place, same toast as every other refused gesture). Clipboard and keyboard events are editor-internal and must keep the *copy* half of a cut, so the editor guards those itself.

- [ ] **Step 1: Write the failing tests**

In `test/readonly-lock.test.ts` (mount a real editor via `createEditor`, `document.body.appendChild(editor.root)`, `setMd('a')`):

```ts
test('read-only: editor formatting buttons are refused; copy and help are not', () => {
  // setReadOnlyLock(true, lc); click the "—" (editor_hr_title) button
  expect(editor.getMd()).toBe('a')
  expect(toasts()).toHaveLength(1)
  // copy (editor_copy_options_title) still opens its menu
  expect(document.querySelector('.tt-atref-dropdown')).not.toBeNull()
})
```

In `test/editor.test.ts` `describe('setEditorsReadOnly')` (reuse the file's `dispatch(editor, 'cut')` shape from the paste describe and `caretIn`/`dispatchKey` helpers):

```ts
test('read-only: cut copies the selection but removes nothing', () => {
  // setMd('cut **me** out'); select all; setEditorsReadOnly(true); dispatch 'cut'
  expect(data['text/html']).toContain('<strong>me</strong>')
  expect(editor.getMd()).toBe('cut **me** out')
})
test('read-only: paste inserts nothing', () => { /* execCommand spy not called; defaultPrevented true */ })
test('read-only: Tab in a list item moves nothing and is left to the browser', () => {
  // setMd('- a\n- b'), caret in 2nd li, setEditorsReadOnly(true), Tab
  expect(e.defaultPrevented).toBe(false)
  expect(editor.getMd()).toBe('- a\n- b')
})
test('read-only: Enter on a "---" line converts nothing', () => { /* getMd unchanged */ })
test('read-only: a link dialog left open when the lock arms inserts nothing on OK', async () => {
  // Ctrl+K opens the modal; setEditorsReadOnly(true); fill url, click OK; await
  expect(editor.getMd()).toBe('a')
})
```

In `test/atref.test.ts` and `test/template-picker.test.ts`: open the dropdown, then set the editor's `contenteditable` to `'false'` (what `setEditorsReadOnly` does), press Enter → no chip / no template inserted, dropdown closed.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/readonly-lock.test.ts test/editor.test.ts test/atref.test.ts test/template-picker.test.ts`
Expected: the new tests FAIL (the hr test sees `a\n---\n`; cut sees `''`).

- [ ] **Step 3: Implement**

- `readonly-lock.ts`: append `.tt-editor-toolbar .tt-editor-btn:not(.tt-editor-btn-readonly-safe)` to `EDITING_CLICK_TARGETS`; extend the header comment's list of covered gestures.
- `editor.ts`: pass `'tt-editor-btn-readonly-safe'` as `extraClass` for the copy and help toolbar buttons. `onCut`: when `editorsReadOnly`, call `writeSelectionToClipboard(e)` and return. `onPaste`: when `editorsReadOnly`, `preventDefault()` and return. `onKeydown`: first line `if (editorsReadOnly) return`. `insertLink`: after `await promptLink(...)`, `if (editorsReadOnly) return`.
- `atref.ts` / `template-picker.ts` `commit`: if the editor element is not editable, `close()` and return before touching the DOM.

- [ ] **Step 4: Run to verify they pass, plus the full gate**

Run: `npx vitest run test/readonly-lock.test.ts test/editor.test.ts test/atref.test.ts test/template-picker.test.ts` → PASS, then the global gate and `npm run test:e2e`.

- [ ] **Step 5: Commit** — `fix: read-only editors refuse toolbar, cut, paste and keyboard edits`

---

### Task 2: Prefs Data tab is honest in a read-only tab

**Files:**
- Modify: `src/ui/prefs.ts` — `buildTagsSection` (~821-872), `renderData` import (~1080-1146) and cleanup (~1171-1206)
- Test: `test/prefs.test.ts` (next to `'export team checkboxes still toggle in a read-only tab …'`, ~1475)

**Interfaces:** none new. Uses `appCtl.isReadOnly()` (already in `PrefsAppCtl`) at render time — same precedent as `renderSecurity` — and `store.readOnly` at click time (the lock can be lost while the modal is open).

- [ ] **Step 1: Write the failing tests**

```ts
test('read-only: Data tab disables import, cleanup and tag cross-apply', () => {
  // setup() with appCtl.isReadOnly = () => true, two teams; openPrefs(..., 'data')
  expect(button('data_import_pick_btn').disabled).toBe(true)
  expect(button('data_cleanup_btn').disabled).toBe(true)
  expect(button('tags_cross_apply_btn').disabled).toBe(true)
  expect(button('data_cleanup_btn').title).toBe(t('en-US', 'readonly_blocked_toast'))
})
test('lock lost while the tab is open: tag cross-apply shows no success toast', () => {
  // open writable, then store.setReadOnly(true), click apply + confirm
  expect(toastTexts()).not.toContain(t('en-US', 'tags_cross_apply_success_toast'))
})
// same "lock lost while open" test for cleanup (doc with a done action) and import (pick a buildExport file)
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/prefs.test.ts` → the new tests FAIL.

- [ ] **Step 3: Implement**

Render time: when `appCtl.isReadOnly()`, the four buttons get `disabled: true` and `title: t(locale, 'readonly_blocked_toast')`. Click time: keep calling `store.update` (it raises the store's own blocked notice) but show each success toast and reset the import checklist only `if (!store.readOnly)` — mirrors `undo-toast.ts:58`.

- [ ] **Step 4: Run** `npx vitest run test/prefs.test.ts` → PASS; global gate.

- [ ] **Step 5: Commit** — `fix: prefs data actions are disabled read-only and never toast a blocked write`

---

### Task 3: The `@` and `/` dropdowns let keys through when they have nothing to pick

**Files:**
- Modify: `src/ui/atref.ts` `onTypingKeydown` (~204-216)
- Modify: `src/ui/template-picker.ts` `onKeydown` (~148-161)
- Test: `test/atref.test.ts` (`describe('attachAtAutocomplete')`, reuse `setup`, `setBlockText`, `fireInput`), `test/template-picker.test.ts`

**Interfaces:** none.

Rule: with `items.length === 0`, Enter and Tab close the dropdown and are **not** `preventDefault`ed; ArrowUp/ArrowDown are left alone (not prevented, dropdown stays — the list may refill as the user keeps typing). Escape is unchanged. With items, nothing changes.

- [ ] **Step 1: Write the failing tests**

```ts
test('an email address (no matches) does not trap Enter: the dropdown closes and Enter reaches the editor', () => {
  // setBlockText('john@'), fireInput; setBlockText('john@acme.com'), fireInput
  expect(document.querySelectorAll('.tt-atref-item')).toHaveLength(0)
  const e = fireKey(editorEl, 'Enter')   // make fireKey return the event
  expect(e.defaultPrevented).toBe(false)
  expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
})
test('with zero matches, arrows are not swallowed', () => { /* ArrowDown not defaultPrevented */ })
```

`test/template-picker.test.ts`, next to `'no templates for the current scope shows an empty-state row'`:

```ts
test('Enter on an empty template list closes it and is not swallowed', () => { /* defaultPrevented false, dropdown null */ })
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/atref.test.ts test/template-picker.test.ts`.

- [ ] **Step 3: Implement** the rule above in both handlers.

- [ ] **Step 4: Run** both files → PASS (existing Enter-picks and Escape tests stay green); global gate.

- [ ] **Step 5: Commit** — `fix: @ and / dropdowns stop trapping Enter when they have no match`

---

### Task 4: Code fences survive save/reopen; link tooltips show the real URL

**Files:**
- Modify: `src/core/markdown.ts` — `mdToHtml` fence handling (~277-289), `htmlToMd` `pre` branch (~874), link `titleAttr` (~164)
- Modify: `src/ui/editor.ts` — Enter handler's fence regex (~1671)
- Test: `test/markdown.test.ts` (fence describe ~1110-1165, link-title tests ~869-880), `test/editor.test.ts` (next to `'typing "```" then Enter also opens a code block'`, ~2357)

**Interfaces:**
- Private helper in `markdown.ts`: `leadingBackticks(line: string): number` — length of the leading run of `` ` ``.
- Fence rule: an opening line with `n = leadingBackticks(line) >= 3` opens a block; while open, a line with `leadingBackticks(line) >= n` closes it (anything after the backticks is ignored, as today). For every file this app has ever written, `n` is 3, so this is exactly today's `/^```/` closer.
- `htmlToMd` writes a fence of `max(3, 1 + longest leadingBackticks among content lines that have ≥ 3)` backticks — so normal code still gets ```` ``` ````, byte-identical to today.

- [ ] **Step 1: Write the failing tests**

```ts
test('a code block holding a ``` line round-trips (fence grows to stay unambiguous)', () => {
  const div = document.createElement('div'); div.innerHTML = '<pre>a\n```\nb</pre>'
  const md = htmlToMd(div)
  expect(md).toBe('````\na\n```\nb\n````')
  expect(roundTrip(md)).toBe(md)
})
test('existing files parse as before: a ``` block still closes on any ```-prefixed line', () => {
  expect(mdToHtml('```\na\n```js\nb')).toBe('<pre>a</pre><div>b</div>')
})
test('a link title shows the URL unescaped', () => {
  const probe = document.createElement('div')
  probe.innerHTML = mdToHtml('[x](https://e.com/?a=1&b=2)')
  expect(probe.querySelector('a')!.getAttribute('title')).toBe('https://e.com/?a=1&b=2')
})
```

`test/editor.test.ts`:

```ts
test('typing "```js" then Enter opens a code block (language tag dropped, as on load)', () => {
  // same shape as the "```" + Enter test, with '<div>```js</div>'
  expect(e.defaultPrevented).toBe(true)
  expect(editorEl.querySelector('pre')).not.toBeNull()
  expect(editorEl.querySelector('div')).toBeNull()
})
test('"```js" + Enter inside a blockquote stays literal', () => { /* no <pre> */ })
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/markdown.test.ts test/editor.test.ts`.

- [ ] **Step 3: Implement**

- Fence rule above in `mdToHtml` (track `preFence: number`) and `htmlToMd`.
- Editor Enter: test the trimmed line against `` /^`{3,}[^`]*$/ `` instead of `` /^`{3,}$/ ``.
- Link title: `href` is already escaped (it comes from `esc(s)`), so build `` ` title="${href}${linkHint ? `\n${esc(linkHint)}` : ''}"` `` instead of `esc()`-ing the joined string.

- [ ] **Step 4: Run** both files → PASS, including every existing fence and link-title test unchanged; global gate; `npm run test:e2e`.

- [ ] **Step 5: Commit** — `fix: code fences round-trip lines starting with backticks; link tooltip URL unescaped`

---

### Task 5: `revealLoc` — one way to open a location from search, the due list and the palette

**Files:**
- Create: `src/ui/reveal-loc.ts`, `test/reveal-loc.test.ts`
- Modify: `src/ui/search-highlight.ts` (add `focusItemInPane`), `src/ui/atref.ts` `navigateToLoc` (~326-336), `src/ui/search-ui.ts` `commit` (~226-269), `src/ui/sidebar.ts` `onOpenItem` (~370-386), `src/ui/palette.ts` `commit` (~67-88)
- Test: `test/search-highlight.test.ts`, `test/search-ui.test.ts`, `test/sidebar.test.ts`, `test/palette.test.ts` (existing tests must stay green unchanged)

**Interfaces:**
- Produces (in `search-highlight.ts`):
  `export function focusItemInPane(paneIdx: 0 | 1, itemId: string | undefined, terms: readonly string[] = []): void` — no-op when there is no `itemId` and no terms. Otherwise, on the next animation frame, find `.tt-pane-body` number `paneIdx`. If there is an `itemId`, dispatch `SEARCH_FOCUS_ITEM_EVENT` on it. Then call `applySearchHighlight` with the `[data-item-id]` anchors (or `[paneEl]` when none), `terms`, and `anchors[0]`. This is the exact union of today's four copies; see the step 3 note for the one place they differ.
- Produces (in `reveal-loc.ts`):
  ```ts
  export interface RevealLocDeps { store: Store; pm: Pick<PaneManager, 'openInFocused'>; selectTeam(teamId: string): void }
  /** Opens `loc` in the focused pane from outside any pane. Returns false, doing nothing, when an open card refuses to close. */
  export function revealLoc(deps: RevealLocDeps, loc: Loc, opts?: { terms?: readonly string[] }): boolean
  ```
  Order: `dismissModelessModals()` (false → return false) → `selectTeam` if `loc.teamId !== activeTeamId` → `pm.openInFocused(loc)` → `focusItemInPane(store.doc.nav.focusedPane, itemId of loc.ref, terms)` → true.
- Callers:
  - `search-ui` commit becomes `if (!revealLoc(...)) return; closeDropdown()`. On a veto the dropdown stays open.
  - `sidebar` `onOpenItem` becomes `revealLoc(...)`.
  - `palette` keeps its own pre-close `dismissModelessModals()` check (so a veto keeps the palette open), then `close()`, then `revealLoc(...)`.
  - `navigateToLoc` keeps its secondary-pane routing and only swaps its rAF block for `focusItemInPane(landedIdx, itemId)`.

- [ ] **Step 1: Write the failing tests**

`test/reveal-loc.test.ts` (stub `requestAnimationFrame` to capture the callback, as `test/atref.test.ts:710` does; `pm.openInFocused` and `selectTeam` are `vi.fn`):

```ts
test('another team: switches team, then opens, in that order')          // mock.invocationCallOrder
test('same team: does not switch')
test('closes an open modeless card first')                                 // showModal({ modeless: true }) gone after
test('a card that refuses to close aborts everything and returns false')   // showModal({ modeless: true, beforeClose: () => false }); no selectTeam, no openInFocused
test('with an itemId, flashes that item in the focused pane on the next frame') // fake .tt-pane-body with [data-item-id]; run raf; class tt-search-target-flash; SEARCH_FOCUS_ITEM_EVENT detail
test('no itemId and no terms: schedules nothing')
```

`test/search-highlight.test.ts`: `focusItemInPane` with terms only highlights the pane body (no event dispatched).

`test/search-ui.test.ts`: `'clicking a result while a card refuses to close keeps the dropdown open and neither switches team nor opens'`.

`test/sidebar.test.ts` (due describe ~740): `'clicking a due row while a card refuses to close does not open the item'`.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/reveal-loc.test.ts test/search-highlight.test.ts test/search-ui.test.ts test/sidebar.test.ts`.

- [ ] **Step 3: Implement** the two functions and switch the four callers.

Note on the one difference between the old copies: the palette skipped `applySearchHighlight` when no anchor existed. The other copies call it with `[paneEl]` and no terms, which only clears a highlight that `openInPane` has already cleared. The difference has no visible effect, so the union is safe.

- [ ] **Step 4: Run** the above plus `test/palette.test.ts test/atref.test.ts test/backlinks-panel.test.ts test/person-notes.test.ts` → PASS; global gate; `npm run test:e2e`.

- [ ] **Step 5: Commit** — `fix: search and due-list navigation respect an open card; one revealLoc helper`

---

### Task 6: Adding a team in a read-only tab does not navigate to a team that doesn't exist

**Files:**
- Modify: `src/ui/sidebar.ts` `openAddModal` OK handler (~705-718)
- Test: `test/sidebar.test.ts` (next to `'+ button opens modal that adds a team'`, ~164)

**Interfaces:** none. After `store.update`, check `docFindTeam(store.doc, newTeamId)`. If the team is absent, `handle.close()` and return without `actions.selectTeam`. This checks the outcome, not `readOnly`, so it covers any refused write.

- [ ] **Step 1: Failing test**

```ts
test('+ modal in a read-only store creates nothing and does not select a ghost team', () => {
  // store.setReadOnly(true); click +, type a name, OK
  expect(selectTeam).not.toHaveBeenCalled()
  expect(store.doc.teams).toHaveLength(0)
  expect(document.querySelector('.tt-modal-overlay')).toBeNull()
})
```

- [ ] **Step 2:** `npx vitest run test/sidebar.test.ts` → FAIL. **Step 3:** implement. **Step 4:** PASS + gate. **Step 5:** commit `fix: sidebar add-team does not select a team a read-only store refused`.

---

### Task 7: Start screen — an explicit open beats auto-open-last; one decrypt path

**Files:**
- Modify: `src/ui/start.ts` — `checkAutoLoad` (~379-401), every open route (`handleOpenViaPicker`, `handleReopenLast`, `handleLaunchFile`, the fallback `fileInput` `onchange`, `handleCreate`), `handleOpenFallbackFile` (~192-216)
- Test: `test/start.test.ts` (existing mocks: `fsMocks.peekLastFile`, `idbMocks.idbGet`, `window.launchQueue` stub at ~89)

**Interfaces:**
- A `let openStarted = false` in `showStartScreen`'s closure. Each route sets it to true synchronously, before its first `await`. `checkAutoLoad` calls `onOpen` only when `autoLoad && !opts?.skipAutoLoad && !openStarted`. The checkbox still shows and reflects the pref.
- `handleOpenFallbackFile(file)` becomes `openAndDecrypt(async () => ({ session, bytes }))`.

- [ ] **Step 1: Characterization tests for the fallback path (pass before the refactor)**

```ts
test('fallback open: a plain file opens with a null password and no prompt')
test('fallback open: a corrupt file shows the corrupt-file error and opens nothing')
```

Run `npx vitest run test/start.test.ts` → PASS (they pin current behaviour).

- [ ] **Step 2: Failing race tests** (make `peekLastFile` return a deferred promise, autoLoad pref true):

```ts
test('a file launched by the OS while auto-open is pending wins: onOpen runs once, with the launched file')
test('clicking Open before auto-open resolves suppresses the auto-open')
```

`npx vitest run test/start.test.ts` → the two race tests FAIL (onOpen called twice / with the auto-open session last).

- [ ] **Step 3: Implement** the flag and the fallback dedupe.

- [ ] **Step 4:** `npx vitest run test/start.test.ts` → all PASS, including the existing auto-load tests (~556-650); global gate.

- [ ] **Step 5: Commit** — `fix: an explicit or launched open is never overridden by auto-open-last`

---

### Task 8: Backup health never rejects

**Files:**
- Modify: `src/core/backup-controller.ts` `hasMissingGrant` (~201-206) and its doc comment
- Test: `test/backup-controller.test.ts` (next to `'checkOrphaned is false when the IDB lookup itself fails'`, ~442), `test/change-password.test.ts`

**Interfaces:** `hasMissingGrant()` keeps its signature. A failed handle lookup or `queryPermission` is logged and reported as `false`, the same contract `checkOrphaned` already has. `currentHealth()` therefore resolves for every input.

- [ ] **Step 1: Failing tests**

```ts
test('hasMissingGrant is false (not a rejection) when the IDB lookup fails')
test('currentHealth resolves when the IDB lookup fails')                 // resolves 'ok' on a fresh controller
```

`test/change-password.test.ts`: with a real `createBackupController` whose `idbGet` rejects, `changePassword('newpw')` resolves and `setPassword` was called with `'newpw'`.

- [ ] **Step 2:** run both files → FAIL. **Step 3:** wrap the body of `hasMissingGrant` in try/catch. **Step 4:** PASS + gate (`test/save-controller.test.ts` must stay green — it already catches). **Step 5:** commit `fix: backup health check never rejects, so a password change can't report a false failure`.

---

### Task 9: Context menu ignores keys behind a blocking modal

**Files:**
- Modify: `src/ui/context-menu.ts` `onKeydown` (~91)
- Test: `test/context-menu.test.ts`

**Interfaces:** first line of `onKeydown`: `if (blockedByBlockingModal()) return` (from `./hotkeys`). Use blocking-only, not `blockedByModal`, so a modeless card modal never disables the menu.

- [ ] **Step 1: Failing test**

```ts
test('Enter does not run a menu item while a blocking modal opened after the menu', () => {
  // showContextMenu(0, 0, [{ label: 'X', onClick }]); showModal({ title, body, buttons: [] })
  // document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  expect(onClick).not.toHaveBeenCalled()
})
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npx vitest run test/context-menu.test.ts test/card-context-menu.test.ts test/panes.test.ts` → PASS + gate. **Step 5:** commit `fix: context menu keys don't act behind a blocking modal`.

---

### Task 10: One ref-chip builder

**Files:**
- Modify: `src/ui/editor-dom.ts` (add `createRefChip`), `src/ui/editor.ts` `refreshRefLabels` relink (~2350-2356), `src/ui/atref.ts` `commit` (~230-239)
- Test: `test/editor-dom.test.ts`, `test/atref.test.ts`

**Interfaces:**
- Produces: `export function createRefChip(ref: string, label: string, title: string): HTMLAnchorElement` — `class="ref"`, `data-ref`, `contenteditable="false"`, `title`, text `@${label}`. `label` must already be bracket-safe (atref keeps its `[[\]()]` strip before calling).
- atref passes `t(opts.locale, 'editor_ref_hint')`.

- [ ] **Step 1: Failing tests**

```ts
// editor-dom.test.ts — ties the DOM builder to the markup mdToHtml renders, so the two can't drift
test('createRefChip matches the chip mdToHtml renders', () => {
  const probe = document.createElement('div')
  probe.innerHTML = mdToHtml('@[Ana](person:p1)', undefined, 'hint')
  const rendered = probe.querySelector('a.ref')!
  expect(createRefChip('person:p1', 'Ana', 'hint').outerHTML).toBe(rendered.outerHTML)
})
// atref.test.ts, in the Enter-inserts-chip test
expect(chip.title).toBe(t('pt-BR', 'editor_ref_hint'))
```

If attribute order differs between the two `outerHTML`s, compare `getAttributeNames().sort()` and each value instead.

- [ ] **Step 2:** FAIL. **Step 3:** implement and switch both callers. **Step 4:** `npx vitest run test/editor-dom.test.ts test/atref.test.ts test/editor.test.ts` → PASS + gate. **Step 5:** commit `refactor: one ref-chip builder; inserted mentions get their hover hint`.

---

### Task 11: Small reuse — `isActionActive`, one due label, `clampInt`

**Files:**
- Modify: `src/core/due.ts` (add `dueRelativeLabel`), `src/core/switcher.ts` (~107-109), `src/ui/due-panel.ts` `relLabel` (~34-38)
- Modify: `src/core/cleanup.ts` (~36, 60, 62), `src/modules/daily-notes.ts` (~108), `src/modules/action-items.ts` (~1308) → `isActionActive`
- Modify: `src/ui/prefs.ts` cleanup days input (~1165-1172) → `clampInt` from `./prefs-fields`
- Test: `test/due.test.ts`; existing `test/cleanup.test.ts`, `test/switcher.test.ts`, `test/due-panel.test.ts`, `test/daily-notes.test.ts`, `test/action-items.test.ts`, `test/prefs.test.ts` must pass unchanged

**Interfaces:**
- Produces: `export function dueRelativeLabel(locale: Locale, date: string, today: string): string` — `due_overdue_by` with `diffDays(today, date)` when `date < today`, else `due_in_days` with `diffDays(date, today)`. `due-panel.ts` passes `todayIso()`.
- `clampInt(Number(v), 1, 3650, 1)` replaces both hand-written clamps; the existing number rules (`'' → 1`, `NaN → 1`, rounding) are unchanged — see `clampInt` in `prefs-fields.ts`.

- [ ] **Step 1: Failing test** — `test/due.test.ts`: `dueRelativeLabel` for yesterday, today (in 0 days), and in 3 days, both locales.
- [ ] **Step 2:** FAIL. **Step 3:** implement and switch every caller listed. **Step 4:** run the listed test files → PASS + gate. **Step 5:** commit `refactor: reuse isActionActive, one due label, clampInt`.

---

### Task 12: `editor.ts` internal dedupe and one clipboard helper

**Files:**
- Modify: `src/ui/dom.ts` (add `copyText`), `src/ui/help.ts` (`copyToClipboard` → `copyText`), `src/ui/editor.ts`
- Test: `test/dom.test.ts`; existing `test/editor.test.ts`, `test/help.test.ts` must pass unchanged

**Interfaces:**
- Produces in `dom.ts`: `export function copyText(text: string): void` — `navigator.clipboard.writeText`, falling back to the hidden-textarea `execCommand('copy')` when the API is missing or the promise rejects. This is today's `copyViaTextarea` + `copyText` from `editor.ts`.
- In `editor.ts` (private):
  - `placeCaretAtStart(node: Node): void` replaces the `createRange / selectNodeContents / collapse(true) / removeAllRanges / addRange` block in `exitFlatBlock`, `convertBlockToBlockquote`, `convertBlockToPre`, `unwrapPre`, `convertBlockToList`, `convertBlockToHr` and `insertHr`.
  - `renderMd(md: string): string` wraps `mdToHtml(md, hooks.resolveRefLabel, t(locale, 'editor_ref_hint'), t(locale, 'editor_link_open_hint'))` at its four call sites.
  - `inlineFragment(md: string): DocumentFragment` returns the children of `renderMd`'s single `<div>` wrapper, used by the two link splice sites.
  - `copyPlain`, `copyMarkdown` and `copyText` call `dom.ts`'s `copyText`.
- Leave `caretOrEndRange` (collapses to the end and returns its range) and template-picker's `setCaretAfter` alone. Their semantics differ.

- [ ] **Step 1: Test for the moved helper** — `test/dom.test.ts`: `copyText` uses `navigator.clipboard.writeText` when present; falls back to a textarea + `execCommand('copy')` when it rejects or is absent (stub both). These pin today's behaviour; they pass once the helper exists.
- [ ] **Step 2: Implement** the helpers and replace the call sites. No behaviour change.
- [ ] **Step 3: Run** `npx vitest run test/dom.test.ts test/editor.test.ts test/help.test.ts test/atref.test.ts test/template-picker.test.ts` → PASS with no edits to existing tests; global gate; `npm run test:e2e`.
- [ ] **Step 4: Commit** — `refactor: dedupe editor caret/render helpers; one copyText`
