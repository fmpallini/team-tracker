# Open Refs in Secondary Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `@ref` chip clicks (person/day/action/milestone/risk) open in the *other* pane instead of the pane hosting the click — as a global per-file preference, or on-demand via Ctrl/Cmd-click or middle-click.

**Architecture:** A new boolean `Prefs.openRefsInSecondaryPane` (schema v7→v8) drives default behavior. The editor's ref-chip click handler is extended to detect Ctrl/Meta-click and middle-click (`auxclick`) and passes a `secondary` flag through `EditorHooks.onRefClick`. `makeRefClickHandler` (src/ui/atref.ts) ORs the pref with that flag and, when true, calls a new `PaneManager.openInSecondaryPane(fromIdx, target)` instead of `openInPane(fromIdx, target)` — which turns split view on if needed and opens the target in `otherPaneIdx(fromIdx)`, reusing the existing `openInPane` machinery for the actual write.

**Tech Stack:** TypeScript, esbuild, Vitest + jsdom. Zero runtime dependencies — everything below is app code + tests only.

## Global Constraints

- Zero runtime dependencies — do not add any package to `dependencies`.
- Every user-visible string goes through `t(locale, key)`; add both `pt-BR` and `en-US` entries for every new i18n key.
- Bump `SCHEMA_VERSION` and add a `MIGRATIONS` step whenever `Doc`'s persisted shape changes (here: `Prefs`).
- All prefs/content edits go through `store.update()`; nav-only changes go through `store.updateNav()`.
- Every `src` module under test has a matching `test/*.test.ts` — new behavior needs new tests, not just manual verification.
- Follow existing code style: no comments explaining *what*, only non-obvious *why*; match surrounding formatting exactly (this codebase keeps multiple short statements per line in places — mirror the file you're editing, don't reformat around it).

---

### Task 1: `Prefs.openRefsInSecondaryPane` + schema migration

**Files:**
- Modify: `src/core/types.ts` (the `Prefs` interface, currently lines 3–11)
- Modify: `src/core/document.ts` (`SCHEMA_VERSION`, `createEmptyDocument`, `MIGRATIONS`)
- Test: `test/document.test.ts`

**Interfaces:**
- Produces: `Prefs.openRefsInSecondaryPane: boolean`, consumed by Task 4 (`atref.ts`) and Task 5 (`prefs.ts`).

- [ ] **Step 1: Write the failing tests**

Update the existing shape assertion in `test/document.test.ts` (around line 6) to include the new field, and add a new migration describe block modeled on the adjacent `v6 → v7` block (lines 130–146):

```ts
test('createEmptyDocument shape', () => {
  const d = createEmptyDocument('pt-BR')
  expect(d.schemaVersion).toBe(SCHEMA_VERSION)
  expect(d.prefs).toEqual({
    theme: 'system', locale: 'pt-BR', font: 'system', fontSize: 'M',
    autoSaveMin: 10, palette: 'ledger', dueSoonDays: 7, openRefsInSecondaryPane: false,
  })
  expect(d.teams).toEqual([])
  expect(d.nav).toEqual({ activeTeamId: null, split: false, focusedPane: 0,
    panes: [{ history: [], index: -1 }, { history: [], index: -1 }], teamSplit: {}, sidebarCollapsed: false })
})
```

```ts
describe('v7 → v8 migration (open refs in secondary pane)', () => {
  it('defaults prefs.openRefsInSecondaryPane to false when missing', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 7
    delete d.prefs.openRefsInSecondaryPane
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.prefs.openRefsInSecondaryPane).toBe(false)
  })
  it('leaves an existing openRefsInSecondaryPane untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 7
    d.prefs.openRefsInSecondaryPane = true
    const doc = migrate(d)
    expect(doc.prefs.openRefsInSecondaryPane).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/document.test.ts`
Expected: FAIL — `createEmptyDocument shape` fails on a missing `openRefsInSecondaryPane` key; the new `v7 → v8` block fails because `SCHEMA_VERSION` is still 7 (`d.schemaVersion` stays `7`, `MIGRATIONS[7]` is undefined so it never runs, and the shape check fails).

- [ ] **Step 3: Implement**

In `src/core/types.ts`, add the field to `Prefs` (after `dueSoonDays`):

```ts
export interface Prefs {
  theme: 'light' | 'dark' | 'system'
  locale: 'pt-BR' | 'en-US'
  font: 'system' | 'serif' | 'mono' | 'classic' | 'rounded'
  fontSize: 'S' | 'M' | 'L'
  autoSaveMin: number
  palette: PaletteId
  dueSoonDays: number
  openRefsInSecondaryPane: boolean
}
```

In `src/core/document.ts`:

```ts
export const SCHEMA_VERSION = 8
```

```ts
export function createEmptyDocument(locale: Locale): Doc {
  return {
    schemaVersion: SCHEMA_VERSION,
    prefs: { theme: 'system', locale, font: 'system', fontSize: 'M', autoSaveMin: 10, palette: 'ledger', dueSoonDays: 7, openRefsInSecondaryPane: false },
    templates: builtinTemplates(locale),
    nav: { activeTeamId: null, split: false, focusedPane: 0,
      panes: [{ history: [], index: -1 }, { history: [], index: -1 }], teamSplit: {}, sidebarCollapsed: false },
    teams: [],
  }
}
```

Add migration step 7 to the `MIGRATIONS` table (after step `6`):

```ts
  7: (d) => {
    const prefs = d.prefs as Record<string, unknown> | undefined
    if (prefs) prefs.openRefsInSecondaryPane = prefs.openRefsInSecondaryPane ?? false
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/document.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: fails here — other files construct `Prefs`/read `Doc` and haven't been touched yet. Confirm the only errors are about `openRefsInSecondaryPane` being unused/missing in places this plan's later tasks touch (`src/ui/prefs.ts`, `src/ui/atref.ts`). If any *other* file errors, stop and investigate before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/document.ts test/document.test.ts
git commit -m "feat: add openRefsInSecondaryPane pref (schema v8)"
```

---

### Task 2: Editor — detect modifier-click / middle-click on ref chips

**Files:**
- Modify: `src/ui/editor.ts` (`EditorHooks` interface, lines 18–25; `onClick`, lines 609–618; listener registration, lines 620–623)
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `EditorHooks.onRefClick(target: RefInfo['target'], opts: { secondary: boolean }): void` — consumed by Task 4 (`makeRefClickHandler` in `src/ui/atref.ts`).

- [ ] **Step 1: Write the failing tests**

Add to the `describe('ref click', ...)` block in `test/editor.test.ts` (after the existing test at line 96), using a hooks factory that records the `opts` argument:

```ts
describe('ref click', () => {
  test('clicking a ref chip calls onRefClick with the parsed target', () => {
    const hooks = makeHooks()
    const editor = createEditor(hooks, 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('ver @[Ana](person:abc-1)')

    const refEl = editor.root.querySelector('a.ref') as HTMLAnchorElement
    expect(refEl).toBeTruthy()
    refEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(hooks.refs).toEqual([{ kind: 'person', id: 'abc-1' }])
    editor.destroy()
  })

  test('plain click passes secondary: false', () => {
    const secondaryFlags: boolean[] = []
    const editor = createEditor({
      onChange() {}, onAtTrigger() {}, onSlashTrigger() {},
      onRefClick(_target, opts) { secondaryFlags.push(opts.secondary) },
    }, 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('ver @[Ana](person:abc-1)')

    const refEl = editor.root.querySelector('a.ref') as HTMLAnchorElement
    refEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(secondaryFlags).toEqual([false])
    editor.destroy()
  })

  test('ctrl-click and meta-click pass secondary: true', () => {
    const secondaryFlags: boolean[] = []
    const editor = createEditor({
      onChange() {}, onAtTrigger() {}, onSlashTrigger() {},
      onRefClick(_target, opts) { secondaryFlags.push(opts.secondary) },
    }, 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('ver @[Ana](person:abc-1)')

    const refEl = editor.root.querySelector('a.ref') as HTMLAnchorElement
    refEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    refEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))

    expect(secondaryFlags).toEqual([true, true])
    editor.destroy()
  })

  test('middle-click (auxclick, button 1) passes secondary: true and is prevented', () => {
    const secondaryFlags: boolean[] = []
    const editor = createEditor({
      onChange() {}, onAtTrigger() {}, onSlashTrigger() {},
      onRefClick(_target, opts) { secondaryFlags.push(opts.secondary) },
    }, 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('ver @[Ana](person:abc-1)')

    const refEl = editor.root.querySelector('a.ref') as HTMLAnchorElement
    const auxEvent = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    const prevented = !refEl.dispatchEvent(auxEvent)

    expect(secondaryFlags).toEqual([true])
    expect(prevented).toBe(true)
    editor.destroy()
  })

  test('middle-mousedown on a ref chip is prevented (suppresses browser autoscroll)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('ver @[Ana](person:abc-1)')

    const refEl = editor.root.querySelector('a.ref') as HTMLAnchorElement
    const downEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 })
    const prevented = !refEl.dispatchEvent(downEvent)

    expect(prevented).toBe(true)
    editor.destroy()
  })

  test('auxclick with a non-middle button does not fire onRefClick', () => {
    const hooks = makeHooks()
    const editor = createEditor(hooks, 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('ver @[Ana](person:abc-1)')

    const refEl = editor.root.querySelector('a.ref') as HTMLAnchorElement
    refEl.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }))

    expect(hooks.refs).toEqual([])
    editor.destroy()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/editor.test.ts`
Expected: FAIL on all 4 new tests — `onRefClick` is currently called with 1 argument (`opts` is `undefined`, so `opts.secondary` throws), and there's no `auxclick`/`mousedown` handling yet.

- [ ] **Step 3: Implement**

In `src/ui/editor.ts`, update the hook signature (line 20):

```ts
export interface EditorHooks {
  onChange(): void
  onRefClick(target: RefInfo['target'], opts: { secondary: boolean }): void
  onAtTrigger(anchor: Range): void
  onSlashTrigger(anchor: Range): void
  resolveRefLabel?: LabelResolver
}
```

Replace the `onClick` function (lines 609–618) with a shared handler plus three listeners:

```ts
  function refElFromEvent(e: MouseEvent): HTMLAnchorElement | null {
    const target = e.target as HTMLElement | null
    return target?.closest?.('a.ref') as HTMLAnchorElement | null
  }

  function handleRefActivate(e: MouseEvent): void {
    const refEl = refElFromEvent(e)
    if (!refEl) return
    e.preventDefault()
    const href = refEl.dataset.ref
    if (!href) return
    const parsed = parseRef(href)
    if (parsed) hooks.onRefClick(parsed, { secondary: e.ctrlKey || e.metaKey || e.button === 1 })
  }

  function onClick(e: MouseEvent): void {
    handleRefActivate(e)
  }

  function onAuxClick(e: MouseEvent): void {
    if (e.button !== 1) return
    handleRefActivate(e)
  }

  // Middle-mousedown on a ref chip would otherwise trigger the browser's
  // autoscroll-pan cursor (the chip has no real `href`, so there's no
  // native middle-click-opens-in-new-tab behavior to preserve).
  function onMouseDownForRef(e: MouseEvent): void {
    if (e.button !== 1) return
    if (refElFromEvent(e)) e.preventDefault()
  }
```

Update the listener registration (lines 620–623):

```ts
  editorEl.addEventListener('input', onInput)
  editorEl.addEventListener('keydown', onKeydown)
  editorEl.addEventListener('paste', onPaste)
  editorEl.addEventListener('click', onClick)
  editorEl.addEventListener('auxclick', onAuxClick)
  editorEl.addEventListener('mousedown', onMouseDownForRef)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/editor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "feat: detect ctrl/meta/middle-click on ref chips"
```

---

### Task 3: `PaneManager.openInSecondaryPane` + update all fake `PaneManager` test doubles

**Files:**
- Modify: `src/ui/panes.ts` (`PaneManager` interface, lines 22–49; `createPaneManager`, add new function near `openInFocused` at line 467)
- Test: `test/panes.test.ts`
- Modify (fake `PaneManager` doubles — add one line to each, see Step 3b): `test/action-items.test.ts`, `test/daily-notes.test.ts`, `test/general-notes.test.ts`, `test/milestones.test.ts`, `test/person-notes.test.ts`, `test/people-tree.test.ts`, `test/risks.test.ts`, `test/search-ui.test.ts`, `test/sidebar.test.ts`

**Interfaces:**
- Consumes: `otherPaneIdx` (private to `panes.ts`, already exists at line 151), `effectiveSplit()`, `openInPane` (both already exist in `createPaneManager`'s closure).
- Produces: `PaneManager.openInSecondaryPane(fromIdx: 0 | 1, target: Loc): void` — consumed by Task 4 (`src/ui/atref.ts`).

- [ ] **Step 1: Write the failing tests**

Add to `test/panes.test.ts` (after the `openBothPanes` test, around line 84):

```ts
describe('openInSecondaryPane', () => {
  test('turns split on when unsplit, and opens the target in the other pane', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
    expect(store.doc.nav.split).toBe(false)

    const target: Loc = { teamId: 'T1', ref: { kind: 'members' } }
    pm.openInSecondaryPane(0, target)

    expect(store.doc.nav.split).toBe(true)
    expect(currentLoc(store.doc.nav.panes[1])).toEqual(target)
    // The pane hosting the click (0) keeps its own content — untouched.
    expect(currentLoc(store.doc.nav.panes[0])).toEqual({ teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
  })

  test('remembers the team as split (teamSplit) when turning split on', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })

    pm.openInSecondaryPane(0, { teamId: 'T1', ref: { kind: 'members' } })

    expect(store.doc.nav.teamSplit['T1']).toBe(true)
  })

  test('leaves split alone when already split', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    store.updateNav((d) => { d.nav.split = true })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
    pm.openInPane(1, { teamId: 'T1', ref: { kind: 'members' } })

    const target: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
    pm.openInSecondaryPane(0, target)

    expect(currentLoc(store.doc.nav.panes[1])).toEqual(target)
  })

  test('clicking from pane 1 opens the target in pane 0', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    store.updateNav((d) => { d.nav.split = true })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
    pm.openInPane(1, { teamId: 'T1', ref: { kind: 'members' } })

    const target: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
    pm.openInSecondaryPane(1, target)

    expect(currentLoc(store.doc.nav.panes[0])).toEqual(target)
    // The pane hosting the click (1) keeps its own content.
    expect(currentLoc(store.doc.nav.panes[1])).toEqual({ teamId: 'T1', ref: { kind: 'members' } })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/panes.test.ts`
Expected: FAIL with `pm.openInSecondaryPane is not a function`.

- [ ] **Step 3a: Implement**

In `src/ui/panes.ts`, add the new method to the `PaneManager` interface (after `openInFocused(loc: Loc): void`, in the block at lines 22–49):

```ts
export interface PaneManager {
  openInPane(paneIdx: 0 | 1, loc: Loc, opts?: { force?: boolean }): void
  openBothPanes(target0: Loc, target1: Loc, focusedPane: 0 | 1): void
  openInFocused(loc: Loc): void
  /**
   * Opens `target` in whichever pane is *not* `fromIdx` — the pane that
   * doesn't host the click that triggered this navigation (an @-ref chip
   * click, per the Task decision to always keep the source pane's content
   * untouched). Turns split view on first if it's currently off, so the
   * target pane exists to open into; leaves it alone if already split.
   */
  openInSecondaryPane(fromIdx: 0 | 1, target: Loc): void
  toggleSplit(): void
  renderAll(): void
  registerModule(kind: ModuleRef['kind'], render: ModuleRenderer): void
  setSplitSpaceConstrained(hidden: boolean): void
}
```

In `createPaneManager`, add the implementation right after `openInFocused` (after line 469, before the `unsplitStash` comment block):

```ts
  function openInFocused(target: Loc): void {
    openInPane(store.doc.nav.focusedPane, target)
  }

  function openInSecondaryPane(fromIdx: 0 | 1, target: Loc): void {
    if (!effectiveSplit()) {
      store.updateNav((d) => {
        d.nav.split = true
        if (d.nav.activeTeamId) d.nav.teamSplit[d.nav.activeTeamId] = true
      })
      spaceHideSplit = false
    }
    openInPane(otherPaneIdx(fromIdx), target)
  }
```

- [ ] **Step 3b: Update the 9 fake `PaneManager` test doubles**

Each of the following files defines a `fakePM()` returning an object literal typed as `PaneManager`; TypeScript will now reject them for missing `openInSecondaryPane`. Add one line, `openInSecondaryPane: () => {},`, immediately after the existing `setSplitSpaceConstrained: () => {},` line in each:

- `test/action-items.test.ts`
- `test/daily-notes.test.ts`
- `test/general-notes.test.ts`
- `test/milestones.test.ts`
- `test/person-notes.test.ts`
- `test/people-tree.test.ts`
- `test/risks.test.ts`
- `test/search-ui.test.ts`
- `test/sidebar.test.ts`

For example, in `test/action-items.test.ts` the block currently reads:

```ts
function fakePM(): PaneManager {
  return {
    openInPane: () => {},
    openBothPanes: () => {},
    openInFocused: () => {},
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
    setSplitSpaceConstrained: () => {},
  }
}
```

becomes:

```ts
function fakePM(): PaneManager {
  return {
    openInPane: () => {},
    openBothPanes: () => {},
    openInFocused: () => {},
    openInSecondaryPane: () => {},
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
    setSplitSpaceConstrained: () => {},
  }
}
```

Apply the same one-line addition (right before `toggleSplit: () => {},` for the files whose member order differs — check each file's actual order and insert after `openInFocused` and before `toggleSplit`) to the other 8 files. Do not reorder or otherwise touch existing lines.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/panes.test.ts test/action-items.test.ts test/daily-notes.test.ts test/general-notes.test.ts test/milestones.test.ts test/person-notes.test.ts test/people-tree.test.ts test/risks.test.ts test/search-ui.test.ts test/sidebar.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors from any of the 9 files above or from `panes.ts`. (`atref.test.ts` will still error — that's Task 4.)

- [ ] **Step 6: Commit**

```bash
git add src/ui/panes.ts test/panes.test.ts test/action-items.test.ts test/daily-notes.test.ts test/general-notes.test.ts test/milestones.test.ts test/person-notes.test.ts test/people-tree.test.ts test/risks.test.ts test/search-ui.test.ts test/sidebar.test.ts
git commit -m "feat: add PaneManager.openInSecondaryPane"
```

---

### Task 4: Route ref clicks to the secondary pane (`src/ui/atref.ts`)

**Files:**
- Modify: `src/ui/atref.ts` (`makeRefClickHandler`, lines 349–387)
- Test: `test/atref.test.ts`

**Interfaces:**
- Consumes: `Prefs.openRefsInSecondaryPane` (Task 1), `EditorHooks.onRefClick`'s `opts: { secondary: boolean }` (Task 2, arrives via `rich-editor.ts` → `editor.ts`'s dispatch — `makeRefClickHandler`'s returned closure now takes the same two params), `PaneManager.openInSecondaryPane(fromIdx, target)` (Task 3).
- Produces: `makeRefClickHandler`'s returned closure signature becomes `(target: RefInfo['target'], opts: { secondary: boolean }) => void` — `src/ui/rich-editor.ts:41` (`onRefClick: makeRefClickHandler(...)`) needs no change since it just forwards the hook.

- [ ] **Step 1: Write the failing tests**

First, update `fakePM()` in `test/atref.test.ts` (lines 349–361) to track which method was called, since the routing tests need to distinguish `openInPane` from `openInSecondaryPane` calls:

```ts
describe('makeRefClickHandler', () => {
  function fakePM(): PaneManager & { calls: { idx: 0 | 1; loc: Loc; secondary?: boolean }[] } {
    const calls: { idx: 0 | 1; loc: Loc; secondary?: boolean }[] = []
    return {
      calls,
      openInPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc }) },
      openBothPanes: () => {},
      openInFocused: () => { throw new Error('onRefClick must navigate the editor\'s own pane via openInPane, not openInFocused') },
      openInSecondaryPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc, secondary: true }) },
      toggleSplit: () => {},
      renderAll: () => {},
      registerModule: () => {},
      setSplitSpaceConstrained: () => {},
    }
  }
```

All existing calls to `handler({ kind: ... })` in that `describe` block (e.g. line 384: `handler({ kind: 'person', id: 'stk-1' })`) must gain the second argument, `{ secondary: false }`, since `secondary` is now a required parameter of the closure. Update every `handler({...})` call site in the `describe('makeRefClickHandler', ...)` block (lines 379–519) and in `describe('makeRefClickHandler - card highlight ...', ...)` (line 553) to pass `{ secondary: false }` as the second argument. For example, line 384 becomes:

```ts
    handler({ kind: 'person', id: 'stk-1' }, { secondary: false })
```

Then add new tests covering the OR-routing logic, right after the existing `describe('makeRefClickHandler', ...)` block's last test (after line 519, before its closing `})`):

```ts
  test('prefs.openRefsInSecondaryPane = true routes a plain click through openInSecondaryPane', () => {
    const store = setupStore()
    store.update((d) => { d.prefs.openRefsInSecondaryPane = true })
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'person', id: 'stk-1' }, { secondary: false })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } }, secondary: true }])
  })

  test('prefs.openRefsInSecondaryPane = false + opts.secondary = true still routes through openInSecondaryPane', () => {
    const store = setupStore()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'person', id: 'stk-1' }, { secondary: true })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } }, secondary: true }])
  })

  test('prefs off + no modifier -> openInPane (unchanged default)', () => {
    const store = setupStore()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'person', id: 'stk-1' }, { secondary: false })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } } }])
  })

  test('day target respects the OR-routing too', () => {
    const store = setupStore()
    store.update((d) => { d.prefs.openRefsInSecondaryPane = true })
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'day', date: '2026-07-02' }, { secondary: false })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-02' } }, secondary: true }])
  })
```

Finally, add a test that the highlight-scroll `requestAnimationFrame` code queries the *target* pane's body when opening secondary. Add this after the existing `'clicking an @-mention action-item chip flashes the target card...'` test (after line 561, still inside `describe('makeRefClickHandler - card highlight ...', ...)`):

```ts
  test('when routed to the secondary pane, the highlight flash targets that pane\'s body, not the click\'s own pane', () => {
    stubMatchMedia()
    Element.prototype.scrollIntoView = () => {}
    const doc = createEmptyDocument('pt-BR')
    doc.teams.push({
      id: 'T1', name: 'Team 1', emoji: '🚀',
      stakeholders: [], members: [],
      actionItems: [{ id: 'a1', summary: 'Fix bug', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
      milestones: [], risks: [], dailyNotes: {},
    })
    doc.nav.activeTeamId = 'T1'
    const store = createStore(doc)
    const shell: Shell = createShell('pt-BR')
    document.body.appendChild(shell.root)
    const pm = createPaneManager(shell, store, 'pt-BR')
    pm.registerModule('actions', renderActionItems)
    pm.registerModule('daily', () => {})

    let raf: FrameRequestCallback | null = null
    window.requestAnimationFrame = ((cb: FrameRequestCallback): number => { raf = cb; return 0 }) as typeof window.requestAnimationFrame

    // Click originates in pane 0 (the daily notes editor); secondary routing
    // must open the action item in pane 1 and flash *that* pane's card.
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')
    handler({ kind: 'action', id: 'a1' }, { secondary: true })

    if (!raf) throw new Error('ref click handler did not schedule a requestAnimationFrame callback')
    ;(raf as FrameRequestCallback)(0)

    const paneBodies = document.querySelectorAll('.tt-pane-body')
    const cardInPane1 = paneBodies[1]!.querySelector('[data-item-id="a1"]')
    expect(cardInPane1).not.toBeNull()
    expect(cardInPane1!.classList.contains('tt-search-target-flash')).toBe(true)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/atref.test.ts`
Expected: FAIL — TS compile errors first (closure called with 1 arg where TS now infers 2 required, `openInSecondaryPane` missing/unused warnings depending on ordering), then once those are fixed by your Step 1 edits, the new routing/highlight tests fail because `makeRefClickHandler` doesn't read `opts.secondary` or `prefs.openRefsInSecondaryPane` yet and always calls `openInPane`.

- [ ] **Step 3: Implement**

Replace `makeRefClickHandler` in `src/ui/atref.ts` (lines 349–387):

```ts
export function makeRefClickHandler(store: Store, pm: PaneManager, paneIdx: 0 | 1, locale: Locale, teamId: string): (target: RefInfo['target'], opts: { secondary: boolean }) => void {
  return (target, opts) => {
    const openSecondary = store.doc.prefs.openRefsInSecondaryPane || opts.secondary
    const open = (loc: Loc): void => {
      if (openSecondary) pm.openInSecondaryPane(paneIdx, loc)
      else pm.openInPane(paneIdx, loc)
    }
    const targetPaneIdx = openSecondary ? (paneIdx === 0 ? 1 : 0) : paneIdx

    if (target.kind === 'day') {
      open({ teamId, ref: { kind: 'daily', date: target.date } })
      return
    }

    if (target.kind === 'action' || target.kind === 'milestone' || target.kind === 'risk') {
      const moduleKind = REF_KINDS[target.kind].moduleKind
      open({ teamId, ref: { kind: moduleKind, itemId: target.id } })
      requestAnimationFrame(() => {
        const paneEl = document.querySelectorAll('.tt-pane-body')[targetPaneIdx] as HTMLElement | undefined
        if (!paneEl) return
        dispatchSearchFocusItem(paneEl, target.id)
        const anchors = Array.from(paneEl.querySelectorAll<HTMLElement>(`[data-item-id="${target.id}"]`))
        applySearchHighlight(anchors.length > 0 ? anchors : [paneEl], [], anchors[0])
      })
      return
    }

    const team = store.doc.teams.find((tm) => tm.id === teamId)
    const group = team?.stakeholders.some((p) => p.id === target.id)
      ? 'stakeholders'
      : team?.members.some((p) => p.id === target.id)
        ? 'members'
        : null
    if (!group) return
    open({ teamId, ref: { kind: 'person', personId: target.id, group } })
  }
}
```

Note this needs a `Loc` type import — check the existing import line at the top of `src/ui/atref.ts`; if `Loc` isn't already imported from `../core/types`, add it to whichever import already pulls types from there (there is currently no `../core/types` import in this file — add `import type { Loc } from '../core/types'` near the other type-only imports at the top).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/atref.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and full test run**

Run: `npm run typecheck && npm test`
Expected: both pass — this is the point where every earlier task's loose end (fake `PaneManager`s, hook signatures) must have converged.

- [ ] **Step 6: Commit**

```bash
git add src/ui/atref.ts test/atref.test.ts
git commit -m "feat: route ref clicks to the secondary pane per pref/modifier"
```

---

### Task 5: Preferences UI toggle

**Files:**
- Modify: `src/ui/prefs.ts` (`renderGeneral`, lines 155–241)
- Modify: `src/core/i18n.ts` (add `prefs_open_refs_secondary_label` for both locales, near `prefs_due_soon_days_label` at lines 305/707)
- Modify: `styles.css` (near `.tt-prefs-field-label`, line 965)
- Test: `test/prefs.test.ts`

**Interfaces:**
- Consumes: `Prefs.openRefsInSecondaryPane` (Task 1).

- [ ] **Step 1: Write the failing test**

Add to `test/prefs.test.ts`, in the General-tab test area (near the existing tests that read/write `store.doc.prefs` fields — search the file for `dueSoonDays` or `autoSaveMin` to find the right neighborhood and follow the same pattern):

```ts
test('the "open refs in secondary pane" checkbox reflects and updates the pref', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)

  const checkbox = document.querySelector('.tt-prefs-open-refs-secondary-checkbox') as HTMLInputElement
  expect(checkbox).not.toBeNull()
  expect(checkbox.checked).toBe(false)

  checkbox.checked = true
  checkbox.dispatchEvent(new Event('change', { bubbles: true }))

  expect(store.doc.prefs.openRefsInSecondaryPane).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/prefs.test.ts`
Expected: FAIL — `.tt-prefs-open-refs-secondary-checkbox` not found.

- [ ] **Step 3: Implement**

In `src/core/i18n.ts`, add the new key next to `prefs_due_soon_days_label` in both locale tables:

pt-BR (near line 305):
```ts
  prefs_due_soon_days_label: 'Avisar sobre prazos nos próximos (dias)',
  prefs_open_refs_secondary_label: 'Abrir referências (@) no painel secundário',
```

en-US (near line 707):
```ts
  prefs_due_soon_days_label: 'Warn about due dates within (days)',
  prefs_open_refs_secondary_label: 'Open references (@) in the secondary pane',
```

In `src/ui/prefs.ts`, inside `renderGeneral` (after the `dueSoonField` block, before `container.append(...)` at line 240):

```ts
    const openRefsSecondaryInput = el('input', {
      type: 'checkbox',
      class: 'tt-prefs-open-refs-secondary-checkbox',
      checked: prefs.openRefsInSecondaryPane,
      onchange: (e: Event) => {
        const checked = (e.target as HTMLInputElement).checked
        store.update((d) => {
          d.prefs.openRefsInSecondaryPane = checked
        })
      },
    })
    const openRefsSecondaryField = el(
      'div',
      { class: 'tt-prefs-field' },
      el('label', { class: 'tt-prefs-checkbox-label' }, openRefsSecondaryInput, t(locale, 'prefs_open_refs_secondary_label'))
    )

    container.append(themeField, paletteField, localeField, fontField, sizeField, autoSaveField, dueSoonField, openRefsSecondaryField)
```

(this replaces the existing `container.append(themeField, paletteField, localeField, fontField, sizeField, autoSaveField, dueSoonField)` line at 240 — add `openRefsSecondaryField` to the end of that same call rather than appending separately)

In `styles.css`, add a rule next to `.tt-prefs-field-label` (line 965):

```css
.tt-prefs-checkbox-label { display: flex; align-items: center; gap: .5rem; font-size: .9rem; color: var(--muted); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/prefs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/prefs.ts src/core/i18n.ts styles.css test/prefs.test.ts
git commit -m "feat: add secondary-pane refs toggle to Preferences > General"
```

---

### Task 6: Help dialog copy

**Files:**
- Modify: `src/core/i18n.ts` (`help_refs_text`, pt-BR line 216 / en-US line 618)
- Test: `test/help.test.ts`

**Interfaces:**
- Consumes: nothing new — pure copy change, no new DOM structure.

- [ ] **Step 1: Write the failing test**

Add to `test/help.test.ts`:

```ts
test('editor help explains ctrl/middle-click for the secondary pane', () => {
  showEditorHelp('en-US')
  const text = document.body.textContent!
  expect(text).toContain('Ctrl')
  expect(text.toLowerCase()).toContain('middle')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/help.test.ts`
Expected: FAIL — current `help_refs_text` doesn't mention Ctrl or middle-click.

- [ ] **Step 3: Implement**

In `src/core/i18n.ts`, update `help_refs_text` in both locales:

pt-BR (line 216):
```ts
  help_refs_text: 'Digite @ para inserir uma referência a uma pessoa, a um dia, ou a um item/marco/risco; clique em uma referência para navegar até ela. Ctrl+clique ou clique com o botão do meio abre a referência no painel secundário (dividindo a tela se necessário) — ou ative isso por padrão em Preferências > Geral.',
```

en-US (line 618):
```ts
  help_refs_text: 'Type @ to insert a reference to a person, a day, or an action/milestone/risk; click a reference to navigate to it. Ctrl-click or middle-click opens the reference in the secondary pane (splitting the view if needed) — or make this the default in Preferences > General.',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/help.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/i18n.ts test/help.test.ts
git commit -m "docs: explain secondary-pane ref-click modifiers in the help dialog"
```

---

### Task 7: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: succeeds, producing `dist/app.html` and `dist/pwa/`.

- [ ] **Step 5: Manual smoke test**

Open `dist/app.html` in a browser, open/create a `.tmv` file with at least one team, a daily note containing an `@person` and an `@action`/`@milestone`/`@risk` mention (insert via the `@` autocomplete). Verify:
1. Plain click on a ref chip still opens it in the same pane (default pref off).
2. Ctrl-click (Cmd-click on macOS) opens it in the other pane, splitting the view if it was single-pane, and the daily note stays visible in its own pane.
3. Middle-click does the same, and does not trigger the browser's autoscroll-pan cursor.
4. Preferences > General > the new checkbox, once enabled, makes plain clicks open in the secondary pane too.
5. Help (❓, or the editor's own help) mentions the Ctrl/middle-click behavior under "References (@)".

---

## Self-Review Notes

- **Spec coverage:** data model (Task 1) ✅, on-demand modifier detection incl. middle-click's `auxclick` quirk and autoscroll suppression (Task 2) ✅, pane-manager routing that never opens into the click's own pane (Task 3) ✅, OR-logic routing + highlight-target fix (Task 4) ✅, prefs UI (Task 5) ✅, help copy (Task 6) ✅, end-to-end verification (Task 7) ✅.
- **Fake `PaneManager` fallout:** all 9 existing test doubles plus `atref.test.ts`'s enumerated and given the exact one-line fix in Task 3/4.
- **Type consistency:** `openInSecondaryPane(fromIdx: 0 | 1, target: Loc): void` is identical across the Task 3 interface addition, Task 3 implementation, Task 4's usage, and every fake. `onRefClick(target: RefInfo['target'], opts: { secondary: boolean }): void` is identical across Task 2's interface change and Task 4's consumption.
