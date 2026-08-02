# Performance & Lifecycle Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate two document-listener memory leaks, cut redundant DOM rebuilds (sidebar double-render, hidden-pane render, unscoped store notifications, un-throttled divider drag, uncached search), and remove two structural warts (the `unsplitStashInvalidators` WeakMap escape hatch, seven duplicated per-module disposer WeakMaps) — with characterization tests written first so none of it can regress silently.

**Architecture:** The root cause of the redraw storm is that `store.update()` notifies every subscriber with no information about *what* changed. We add an optional `ChangeScope` argument that defaults to `null` ("everything changed"), so every existing call site keeps its current behavior until it is explicitly narrowed. Subscribers gain a pure, unit-tested `scopeAffects()` predicate to decide whether to re-render. Leak fixes add symmetric `dispose()` methods to `PaneManager` and the sidebar handle. Structural cleanups are pure extractions with no behavior change, guarded by the characterization tests from Task 1.

**Tech Stack:** TypeScript (strict), vitest + jsdom, esbuild. Zero runtime dependencies — this is a hard constraint, do not add any.

## Global Constraints

- **Zero runtime dependencies.** `esbuild`, `typescript`, `vitest`, `jsdom` are dev-only. Do not add runtime deps.
- **Use the Bash tool (Git Bash)** for shell commands in this repo — the `rtk` token-filtering hook only matches the Bash tool, not PowerShell.
- **Every `src` module has a matching `test/*.test.ts`.** New source files require new test files.
- **i18n:** all user-visible strings go through `t(locale, key)` in `core/i18n.ts`, with keys added for both `pt-BR` and `en-US`. This refactor should add **zero** new user-visible strings — if a task seems to need one, that is a signal the task drifted.
- **Feature-detect browser APIs.** Web Locks, BroadcastChannel, and the File System Access API are absent in jsdom; code must degrade gracefully.
- **Persisted-shape changes require a `SCHEMA_VERSION` bump plus a migration** in `core/document.ts`. **No task in this plan changes the persisted `Doc` shape.** If you find yourself adding a field to `Doc`, `NavState`, or `Prefs`, stop — the design intends that state to be transient/in-memory.
- **Comments referencing "Task N"** in existing source trace back to `docs/superpowers/plans/2026-07-02-team-tracker.md`. Do not renumber or repurpose them. New comments in this plan's work should reference "perf refactor" rather than a bare task number, to avoid collision.
- **Branch:** work directly on `dev`. No worktrees, no feature branches.
- **Verification gate after every task:** `npm run typecheck && npm run lint && npx vitest run`. All three must pass before committing.
- **Baseline at plan authoring time:** 901 tests / 54 files passing, typecheck clean, lint clean. Test count only ever goes up.

---

## File Structure

**New files:**

| File | Responsibility |
|---|---|
| `src/core/scope.ts` | `Section` / `ChangeScope` types + the pure `scopeAffects()` predicate. No DOM, no store import. |
| `test/scope.test.ts` | Unit tests for `scopeAffects()`. |
| `src/modules/lifecycle.ts` | `withDisposal()` — the single shared per-container disposer WeakMap, replacing seven copies. |
| `test/lifecycle.test.ts` | Unit tests for `withDisposal()`. |
| `src/core/pane-layout.ts` | Transient split/stash state + history stepping, extracted from `ui/panes.ts`. Owns `unsplitStash`; kills the `unsplitStashInvalidators` WeakMap. |
| `test/pane-layout.test.ts` | Unit tests for the layout controller. |
| `test/render-counts.test.ts` | Characterization tests: how many times each surface re-renders per mutation. The regression net for the whole plan. |

**Modified files:**

| File | Change |
|---|---|
| `src/core/store.ts` | `update(fn, scope?)`; `subscribe`/`onMutate` callbacks receive change info; add `rev` counter. |
| `src/ui/panes.ts` | Add `dispose()`; skip hidden pane in `renderAll()`; rAF the divider drag; delegate layout state to `core/pane-layout.ts`. |
| `src/ui/sidebar.ts` | Add `dispose()`; render once per mutation instead of twice. |
| `src/main.ts` | Push `pm.dispose()` and `sidebarHandle.dispose()` onto `disposers`. |
| `src/core/search.ts` | Add `createSearchIndex()` with per-team, per-revision caching. `searchDocument()` kept as-is. |
| `src/ui/search-ui.ts` | Use the cached index instead of calling `searchDocument()` per keystroke. |
| `src/modules/*.ts` (7 files) | Replace per-file disposer WeakMap with `withDisposal()`; narrow `store.update()` calls with scopes. |

---

### Task 1: Characterization tests — lock current render behavior

Nothing is refactored in this task. It builds the net that catches everything else. These tests are written against **current** behavior and must pass on unmodified `HEAD`. Later tasks update the expected numbers deliberately, in the same commit as the change that moves them.

**Files:**
- Create: `test/render-counts.test.ts`

**Interfaces:**
- Consumes: `createStore` from `src/core/store`, `createShell` from `src/ui/shell`, `createPaneManager` from `src/ui/panes`, `mountSidebar` from `src/ui/sidebar`, `createEmptyDocument` from `src/core/document`.
- Produces: nothing importable. This is a leaf test file.

- [ ] **Step 1: Write the characterization test file**

Create `test/render-counts.test.ts`:

```ts
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createShell, type Shell } from '../src/ui/shell'
import { createPaneManager, type PaneManager } from '../src/ui/panes'
import { mountSidebar } from '../src/ui/sidebar'
import { renderActionItems } from '../src/modules/action-items'
import { renderDailyNotes } from '../src/modules/daily-notes'
import { todayIso } from '../src/core/i18n'
import type { Team } from '../src/core/types'

// jsdom does not implement matchMedia; createShell() needs it to watch the
// OS theme preference (same stub as test/panes.test.ts and test/sidebar.test.ts).
function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function emptyTeam(id: string, name: string): Team {
  return {
    id, name, emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: {},
  }
}

function setup(): { store: Store; shell: Shell; pm: PaneManager } {
  document.body.innerHTML = ''
  stubMatchMedia()
  const store = createStore(createEmptyDocument('en-US'))
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const pm = createPaneManager(shell, store, 'en-US')
  pm.registerModule('actions', renderActionItems)
  pm.registerModule('daily', renderDailyNotes)
  return { store, shell, pm }
}

test('CHARACTERIZATION: store.update() notifies subscribers exactly once', () => {
  const store = createStore(createEmptyDocument('en-US'))
  let n = 0
  store.subscribe(() => n++)
  store.update((d) => { d.teams.push(emptyTeam('t1', 'Alpha')) })
  expect(n).toBe(1)
})

test('CHARACTERIZATION: store.updateNav() does not notify subscribe(), does notify onMutate()', () => {
  const store = createStore(createEmptyDocument('en-US'))
  let subs = 0
  let muts = 0
  store.subscribe(() => subs++)
  store.onMutate(() => muts++)
  store.updateNav((d) => { d.nav.split = true })
  expect(subs).toBe(0)
  expect(muts).toBe(1)
})

test('CHARACTERIZATION: sidebar rebuilds its team list on a content update', () => {
  const { store, shell, pm } = setup()
  mountSidebar(shell, store, pm, { selectTeam: () => {}, renderPanes: () => {} })
  store.update((d) => { d.teams.push(emptyTeam('t1', 'Alpha')) })
  const listEl = shell.sidebar.querySelector('.tt-team-list')
  expect(listEl).not.toBeNull()
  expect(listEl!.querySelectorAll('.tt-team-item').length).toBe(1)

  // Marker survives only if the list is NOT rebuilt. It is rebuilt, so it dies.
  const marker = document.createElement('span')
  marker.id = 'sidebar-marker'
  listEl!.appendChild(marker)
  store.update((d) => { d.teams.push(emptyTeam('t2', 'Beta')) })
  expect(document.getElementById('sidebar-marker')).toBeNull()
  expect(listEl!.querySelectorAll('.tt-team-item').length).toBe(2)
})

test('CHARACTERIZATION: a nav-only change still repaints the sidebar active highlight', () => {
  const { store, shell, pm } = setup()
  mountSidebar(shell, store, pm, { selectTeam: () => {}, renderPanes: () => {} })
  store.update((d) => {
    d.teams.push(emptyTeam('t1', 'Alpha'))
    d.teams.push(emptyTeam('t2', 'Beta'))
  })
  store.updateNav((d) => { d.nav.activeTeamId = 't2' })
  const active = shell.sidebar.querySelectorAll('.tt-team-item.active')
  expect(active.length).toBe(1)
  expect(active[0]!.textContent).toContain('Beta')
})

test('CHARACTERIZATION: editing one team does not lose the other pane content', () => {
  const { store, pm } = setup()
  store.update((d) => {
    d.teams.push(emptyTeam('t1', 'Alpha'))
    d.nav.activeTeamId = 't1'
  })
  pm.openBothPanes(
    { teamId: 't1', ref: { kind: 'daily', date: todayIso() } },
    { teamId: 't1', ref: { kind: 'actions' } },
    0
  )
  const bodies = document.querySelectorAll('.tt-pane-body')
  expect(bodies.length).toBe(2)
  expect(bodies[1]!.querySelector('.tt-kanban')).not.toBeNull()

  store.update((d) => {
    const tm = d.teams.find((t) => t.id === 't1')!
    tm.actionItems.push({
      id: 'a1', summary: 'Card', notes: '', status: 'todo',
      dueDate: null, assignee: '', color: 'ledger', order: 0,
    })
  })
  expect(bodies[1]!.querySelectorAll('.tt-kanban-card').length).toBe(1)
})
```

- [ ] **Step 2: Run the new tests against unmodified source**

Run: `npx vitest run test/render-counts.test.ts`
Expected: PASS — all 5 tests. These describe current behavior. If any fails, the assumption behind it is wrong; fix the *test* to match reality, not the source.

- [ ] **Step 3: Run the full suite to confirm nothing else moved**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: PASS, 906 tests (901 baseline + 5 new).

- [ ] **Step 4: Commit**

```bash
git add test/render-counts.test.ts
git commit -m "test: characterize render/notify behavior before perf refactor"
```

---

### Task 2: Fix the `PaneManager` document-listener leak

`src/ui/panes.ts:357` registers a `document` click listener (the module-dropdown outside-click closer) that is never removed. `createPaneManager` runs once per document open, so a close-file → open-file cycle accumulates one listener per cycle, each pinning the closed document's `store`, its whole `Doc`, and the detached shell DOM.

**Files:**
- Modify: `src/ui/panes.ts` (the `PaneManager` interface; the `document.addEventListener('click', …)` at line ~357; the returned `pm` object at line ~774)
- Modify: `src/main.ts` (line ~278, after `createPaneManager`)
- Test: `test/panes.test.ts`

**Interfaces:**
- Produces: `PaneManager.dispose(): void` — removes every document-level listener `createPaneManager` registered. Task 8 and Task 10 both extend this method; keep it as the single teardown point.

- [ ] **Step 1: Write the failing test**

Append to `test/panes.test.ts`:

```ts
test('dispose() removes the document click listener that closes the module menu', () => {
  const { store, pm } = setup()
  addTeam(store, 't1')

  // Open pane 0's module dropdown.
  paneBtn(0, 'tt-pane-modules-btn').click()
  expect(document.querySelector('.tt-pane-menu')).not.toBeNull()

  pm.dispose()

  // With the listener removed, an outside click no longer closes the menu.
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(document.querySelector('.tt-pane-menu')).not.toBeNull()
})

test('before dispose(), an outside click still closes the module menu', () => {
  const { store } = setup()
  addTeam(store, 't1')
  paneBtn(0, 'tt-pane-modules-btn').click()
  expect(document.querySelector('.tt-pane-menu')).not.toBeNull()

  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(document.querySelector('.tt-pane-menu')).toBeNull()
})
```

Note: `setup()` in `test/panes.test.ts` currently returns `{ shell, store, pm }` — the destructuring above works as-is.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/panes.test.ts -t "dispose() removes the document click listener"`
Expected: FAIL — `pm.dispose is not a function`.

- [ ] **Step 3: Implement**

In `src/ui/panes.ts`, add to the `PaneManager` interface (after `setSplitSpaceConstrained`):

```ts
  /**
   * Tears down every document-level listener `createPaneManager` registered.
   * Must be called when the document this pane manager belongs to is closed
   * (main.ts's `closeFile()`), or each close-file → open-file cycle leaks a
   * listener pinning the closed document's store, Doc, and detached DOM.
   */
  dispose(): void
```

Replace the anonymous listener registration (currently `document.addEventListener('click', (e) => { … })`) with a named handler:

```ts
  // Closes any open module dropdown when clicking outside of it.
  const onDocumentClick = (e: MouseEvent): void => {
    if (!menuOpen[0] && !menuOpen[1]) return
    const target = e.target as HTMLElement
    if (target.closest('.tt-pane-modules-btn') || target.closest('.tt-pane-menu')) return
    menuOpen[0] = false
    menuOpen[1] = false
    personSubOpen[0] = false
    personSubOpen[1] = false
    renderBar(0)
    renderBar(1)
  }
  document.addEventListener('click', onDocumentClick)
```

Add to the returned `pm` object:

```ts
    dispose(): void {
      document.removeEventListener('click', onDocumentClick)
    },
```

In `src/main.ts`, immediately after the `pm.renderAll()` call that follows the `registerModule` block:

```ts
  disposers.push(() => pm.dispose())
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/panes.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm run lint && npx vitest run
git add src/ui/panes.ts src/main.ts test/panes.test.ts
git commit -m "fix: tear down pane manager document listener on close-file"
```

---

### Task 3: Fix the sidebar listener leak

`mountSidebar` registers `store.subscribe(…)`, `store.onMutate(…)`, and `document.addEventListener(ADD_TEAM_REQUEST_EVENT, …)` with no teardown, and returns a handle with no `dispose`. `main.ts` never disposes it. Same leak class as Task 2.

**Files:**
- Modify: `src/ui/sidebar.ts` (the `store.subscribe` / `store.onMutate` / `document.addEventListener` block at lines ~635-658, and the returned handle at ~660)
- Modify: `src/main.ts` (line ~527, after `mountSidebar`)
- Test: `test/sidebar.test.ts`

**Interfaces:**
- Consumes: `store.subscribe()` and `store.onMutate()` already return unsubscribe functions — capture them rather than discarding.
- Produces: the object returned by `mountSidebar` gains `dispose(): void`. Its existing members (`setSpaceConstrained`, `openDuePanel`) are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/sidebar.test.ts`:

```ts
test('dispose() stops the sidebar re-rendering and unhooks the add-team event', () => {
  const { store, shell, pm } = setup()
  const handle = mountSidebar(shell, store, pm, { selectTeam: () => {}, renderPanes: () => {} })
  addTeam(store, 'Alpha')
  expect(items().length).toBe(1)

  handle.dispose()

  // Store mutations no longer repaint the sidebar.
  addTeam(store, 'Beta')
  expect(items().length).toBe(1)

  // The document-level add-team request no longer opens the modal.
  document.dispatchEvent(new CustomEvent(ADD_TEAM_REQUEST_EVENT))
  expect(document.querySelector('.tt-modal')).toBeNull()
})

test('before dispose(), the add-team event opens the modal', () => {
  const { store, shell, pm } = setup()
  mountSidebar(shell, store, pm, { selectTeam: () => {}, renderPanes: () => {} })
  document.dispatchEvent(new CustomEvent(ADD_TEAM_REQUEST_EVENT))
  expect(document.querySelector('.tt-modal')).not.toBeNull()
})
```

If the existing `setup()` helper in `test/sidebar.test.ts` already calls `mountSidebar` internally, do **not** call it twice — instead have these two tests build their own store/shell/pm the way `setup()` does and mount once. Read the existing helper before writing.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/sidebar.test.ts -t "dispose() stops the sidebar"`
Expected: FAIL — `handle.dispose is not a function`.

- [ ] **Step 3: Implement**

In `src/ui/sidebar.ts`, replace the registration block with:

```ts
  render()
  const unsubscribeContent = store.subscribe(() => {
    dueCache = null // content changed — due data may have too
    render()
  })
  // (keep the existing long comment block explaining why both channels are
  //  registered — it is load-bearing documentation)
  const unsubscribeMutate = store.onMutate(() => render())
  const onAddTeamRequest = (): void => openAddModal()
  document.addEventListener(ADD_TEAM_REQUEST_EVENT, onAddTeamRequest)

  return {
    setSpaceConstrained,
    openDuePanel: () => openDuePanel({ locale: locale(), buckets: dueBuckets(), onOpenItem }),
    /**
     * Tears down the store subscriptions and the document-level add-team
     * listener. Without this, every close-file → open-file cycle leaked a
     * listener pinning the closed document's store and detached shell DOM.
     */
    dispose(): void {
      unsubscribeContent()
      unsubscribeMutate()
      document.removeEventListener(ADD_TEAM_REQUEST_EVENT, onAddTeamRequest)
    },
  }
```

In `src/main.ts`, right after the `mountSidebar` call:

```ts
  disposers.push(() => sidebarHandle.dispose())
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/sidebar.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm run lint && npx vitest run
git add src/ui/sidebar.ts src/main.ts test/sidebar.test.ts
git commit -m "fix: tear down sidebar listeners on close-file"
```

---

### Task 4: Give `onMutate` a change kind, stop the sidebar double-render

`store.update()` fires `subscribe()` listeners **and then** `onMutate()` listeners. The sidebar is registered on both, so every content edit rebuilds the entire team list twice. The existing comment calls this "a harmless idempotent DOM rebuild"; it is 2× layout+paint on every keystroke-batch.

The fix is to tell `onMutate` listeners *which* channel fired, so the sidebar can render for nav-only changes and let `subscribe()` handle content changes. `save-controller.ts`'s listener ignores the argument and is unaffected.

**Files:**
- Modify: `src/core/store.ts` (the `onMutate` signature, `notifyMutate`, `update`, `updateNav`)
- Modify: `src/ui/sidebar.ts` (the `onMutate` handler)
- Test: `test/store.test.ts`, `test/render-counts.test.ts`

**Interfaces:**
- Produces: `type MutationKind = 'content' | 'nav'`, exported from `src/core/store.ts`.
- Produces: `onMutate(fn: (kind: MutationKind) => void): () => void`. `update()` passes `'content'`; `updateNav()` passes `'nav'`. Existing zero-argument listeners remain type-compatible.

- [ ] **Step 1: Write the failing tests**

Append to `test/store.test.ts`:

```ts
test('onMutate receives the mutation kind', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  const kinds: string[] = []
  s.onMutate((kind) => kinds.push(kind))
  s.update(() => {})
  s.updateNav(() => {})
  expect(kinds).toEqual(['content', 'nav'])
})
```

Append to `test/render-counts.test.ts`:

```ts
test('sidebar renders exactly once per content update', () => {
  const { store, shell, pm } = setup()
  mountSidebar(shell, store, pm, { selectTeam: () => {}, renderPanes: () => {} })
  store.update((d) => { d.teams.push(emptyTeam('t1', 'Alpha')) })

  const listEl = shell.sidebar.querySelector('.tt-team-list')!

  // Count childList RECORDS that removed nodes, not observer callback
  // invocations: MutationObserver batches every mutation in a microtask into a
  // single callback, so counting callbacks would report 1 whether the sidebar
  // rendered once or twice — a test that passes vacuously. Each render() opens
  // with `listEl.innerHTML = ''`, so one clearing record == one render.
  let clears = 0
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList' && r.removedNodes.length > 0) clears++
    }
  })
  observer.observe(listEl, { childList: true })

  store.update((d) => { d.teams.push(emptyTeam('t2', 'Beta')) })
  // MutationObserver delivers asynchronously; flush the microtask queue.
  return Promise.resolve().then(() => {
    observer.takeRecords().forEach((r) => {
      if (r.type === 'childList' && r.removedNodes.length > 0) clears++
    })
    observer.disconnect()
    expect(clears).toBe(1)
    expect(listEl.querySelectorAll('.tt-team-item').length).toBe(2)
  })
})

test('the sidebar still renders exactly once for a nav-only change', () => {
  const { store, shell, pm } = setup()
  mountSidebar(shell, store, pm, { selectTeam: () => {}, renderPanes: () => {} })
  store.update((d) => {
    d.teams.push(emptyTeam('t1', 'Alpha'))
    d.teams.push(emptyTeam('t2', 'Beta'))
  })

  const listEl = shell.sidebar.querySelector('.tt-team-list')!
  let clears = 0
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList' && r.removedNodes.length > 0) clears++
    }
  })
  observer.observe(listEl, { childList: true })

  store.updateNav((d) => { d.nav.activeTeamId = 't2' })
  return Promise.resolve().then(() => {
    observer.takeRecords().forEach((r) => {
      if (r.type === 'childList' && r.removedNodes.length > 0) clears++
    })
    observer.disconnect()
    expect(clears).toBe(1)
    expect(listEl.querySelectorAll('.tt-team-item.active')[0]!.textContent).toContain('Beta')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/store.test.ts test/render-counts.test.ts`
Expected: FAIL — `kinds` is `[undefined, undefined]`; `rebuilds` is `2`.

- [ ] **Step 3: Implement**

In `src/core/store.ts`:

```ts
/** Which mutation channel fired — `update()` is 'content', `updateNav()` is 'nav'. */
export type MutationKind = 'content' | 'nav'
```

Change the interface member:

```ts
  onMutate(fn: (kind: MutationKind) => void): () => void
```

Change the listener set type to `Set<(kind: MutationKind) => void>` and:

```ts
  const notifyMutate = (kind: MutationKind) => {
    for (const fn of Array.from(mutationListeners)) { try { fn(kind) } catch (e) { console.error(e) } }
  }
```

Call `notifyMutate('content')` in `update()` and `notifyMutate('nav')` in `updateNav()`.

In `src/ui/sidebar.ts`, narrow the handler and update its comment:

```ts
  // Nav-only changes (store.updateNav — team switch, Alt+1..9, pane history)
  // don't fire subscribe() above, but do need the active-team highlight to
  // update. Content changes are already fully covered by subscribe(), so this
  // listener filters on kind — registering it unconditionally rebuilt the whole
  // team list twice on every single content edit.
  //
  // Load-bearing detail: store.replaceDoc() (used by the conflict-modal
  // reload path in main.ts's onReload handler) fires subscribe() listeners
  // but NOT onMutate() listeners — so it's the store.subscribe() render
  // above, not this onMutate() one, that keeps the sidebar in sync after a
  // reload. Don't collapse these two registrations into just onMutate().
  const unsubscribeMutate = store.onMutate((kind) => {
    if (kind === 'nav') render()
  })
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/store.test.ts test/render-counts.test.ts test/sidebar.test.ts`
Expected: PASS. The Task 1 characterization test "a nav-only change still repaints the sidebar active highlight" must still pass — it proves the nav path was not broken.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm run lint && npx vitest run
git add src/core/store.ts src/ui/sidebar.ts test/store.test.ts test/render-counts.test.ts
git commit -m "perf: render sidebar once per mutation instead of twice"
```

---

### Task 5: Skip rendering the hidden pane

`renderAll()` renders bar + body for pane 1 unconditionally, even when `layout()` has just set `display: none` on it. Single-pane view is the common case, so roughly half the render work is thrown away.

The subtlety: if pane 1 is skipped while hidden, its DOM is stale when it becomes visible again. Both re-show paths must force a full render — `toggleSplit()` already calls `renderAll()` after flipping `nav.split`, but `setSplitSpaceConstrained()` currently only calls `layout()`.

**Files:**
- Modify: `src/ui/panes.ts` (`renderAll`, `setSplitSpaceConstrained`)
- Test: `test/panes.test.ts`

**Interfaces:**
- No signature changes.

- [ ] **Step 1: Write the failing test**

Append to `test/panes.test.ts`:

```ts
test('renderAll skips the hidden pane, and re-renders it when split turns on', () => {
  const { store, pm } = setup()
  addTeam(store, 't1')
  // Ensure single-pane view.
  if (store.doc.nav.split) pm.toggleSplit()
  expect(store.doc.nav.split).toBe(false)

  const body1 = document.querySelectorAll('.tt-pane-body')[1] as HTMLElement
  const marker = document.createElement('span')
  marker.id = 'hidden-pane-marker'
  body1.appendChild(marker)

  pm.renderAll()
  // Pane 1 is hidden — its body must not have been wiped.
  expect(document.getElementById('hidden-pane-marker')).not.toBeNull()

  pm.toggleSplit()
  // Now visible — it gets a real render, which clears the marker.
  expect(store.doc.nav.split).toBe(true)
  expect(document.getElementById('hidden-pane-marker')).toBeNull()
})

test('un-hiding a space-constrained split re-renders pane 1', () => {
  const { store, pm } = setup()
  addTeam(store, 't1')
  if (!store.doc.nav.split) pm.toggleSplit()
  expect(store.doc.nav.split).toBe(true)

  pm.setSplitSpaceConstrained(true) // narrow window — split force-hidden
  const body1 = document.querySelectorAll('.tt-pane-body')[1] as HTMLElement
  const marker = document.createElement('span')
  marker.id = 'constrained-marker'
  body1.appendChild(marker)

  pm.renderAll() // pane 1 hidden by the space constraint — skipped
  expect(document.getElementById('constrained-marker')).not.toBeNull()

  pm.setSplitSpaceConstrained(false) // window widened — pane 1 visible again
  expect(document.getElementById('constrained-marker')).toBeNull()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/panes.test.ts -t "hidden pane"`
Expected: FAIL — the marker is already gone after the first `renderAll()`, because pane 1 is rendered unconditionally today.

- [ ] **Step 3: Implement**

In `src/ui/panes.ts`:

```ts
  /**
   * Pane 1 is skipped entirely while it isn't visible (unsplit, or split
   * force-hidden by the responsive layout) — layout() has already set
   * `display: none` on it, so rendering into it is pure wasted work, and
   * single-pane is the common case. Every path that makes pane 1 visible
   * again must call renderAll() so its skipped-while-hidden DOM is rebuilt:
   * toggleSplit() already does, and setSplitSpaceConstrained() below was
   * changed to do the same.
   */
  function renderAll(): void {
    layout()
    renderBar(0)
    renderBody(0)
    if (!effectiveSplit()) return
    renderBar(1)
    renderBody(1)
  }
```

```ts
  function setSplitSpaceConstrained(hidden: boolean): void {
    if (spaceHideSplit === hidden) return
    spaceHideSplit = hidden
    // Un-hiding makes pane 1 visible again; it was skipped by renderAll()
    // for as long as it was hidden, so its content needs a real render now.
    if (!hidden) renderAll()
    else layout()
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/panes.test.ts test/responsive.test.ts test/render-counts.test.ts`
Expected: PASS. Watch `test/responsive.test.ts` closely — it drives `setSplitSpaceConstrained`.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm run lint && npx vitest run
git add src/ui/panes.ts test/panes.test.ts
git commit -m "perf: skip rendering the hidden pane"
```

---

### Task 6: Throttle the split-divider drag with requestAnimationFrame

The divider's `mousemove` handler calls `gridEl.getBoundingClientRect()` (a read) and then writes `gridEl.style.gridTemplateColumns` (a write) on **every** mouse event — a forced synchronous layout per event.

**Files:**
- Modify: `src/ui/panes.ts` (the `dividerEl` mousedown handler, lines ~319-333)
- Test: `test/panes.test.ts`

**Interfaces:**
- No signature changes.

- [ ] **Step 1: Write the failing test**

Append to `test/panes.test.ts`:

```ts
test('divider drag coalesces mousemoves into one style write per animation frame', () => {
  const { store, pm } = setup()
  addTeam(store, 't1')
  if (!store.doc.nav.split) pm.toggleSplit()

  const frames: FrameRequestCallback[] = []
  const realRaf = window.requestAnimationFrame
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    frames.push(cb)
    return frames.length
  }) as typeof window.requestAnimationFrame

  try {
    const grid = document.querySelector('.tt-panes-grid') as HTMLElement
    // jsdom has no layout: give the grid a non-zero width so the percentage math runs.
    grid.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 500,
      right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    const divider = document.querySelector('.tt-pane-divider') as HTMLElement
    divider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    const before = grid.style.gridTemplateColumns
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }))

    // Three moves, zero frames run yet: the style must not have been touched.
    expect(grid.style.gridTemplateColumns).toBe(before)
    expect(frames.length).toBe(1) // one frame requested, not three

    frames.forEach((cb) => cb(0))
    // The frame applies the LAST position: 600/1000 = 60%.
    expect(grid.style.gridTemplateColumns).toBe('60fr 6px 40fr')

    document.dispatchEvent(new MouseEvent('mouseup'))
  } finally {
    window.requestAnimationFrame = realRaf
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/panes.test.ts -t "coalesces mousemoves"`
Expected: FAIL — the style is written synchronously on the first mousemove, so `gridTemplateColumns` already changed and `frames.length` is `0`.

- [ ] **Step 3: Implement**

Replace the divider `mousedown` handler in `src/ui/panes.ts`:

```ts
  const dividerEl = el('div', { class: 'tt-pane-divider' })
  dividerEl.addEventListener('mousedown', (downEvt) => {
    downEvt.preventDefault()
    // The raw mousemove stream fires far faster than the screen refreshes, and
    // each event did a getBoundingClientRect() read followed by a style write
    // — a forced synchronous layout per event. Coalesce into one write per
    // animation frame instead: store the latest clientX, and let a single
    // pending frame apply whichever position was most recent.
    let pendingX: number | null = null
    let frame: number | null = null

    function applyPending(): void {
      frame = null
      if (pendingX === null) return
      const rect = gridEl.getBoundingClientRect()
      const raw = rect.width > 0 ? ((pendingX - rect.left) / rect.width) * 100 : splitPct
      pendingX = null
      splitPct = Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, raw))
      gridEl.style.gridTemplateColumns = `${splitPct}fr 6px ${100 - splitPct}fr`
    }

    function onMove(ev: MouseEvent): void {
      pendingX = ev.clientX
      if (frame === null) frame = requestAnimationFrame(applyPending)
    }
    function onUp(): void {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // Flush whatever the last frame hasn't applied yet, so the divider
      // always lands exactly where the pointer was released.
      if (frame !== null) {
        cancelAnimationFrame(frame)
        applyPending()
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/panes.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm run lint && npx vitest run
git add src/ui/panes.ts test/panes.test.ts
git commit -m "perf: coalesce split-divider drag into one write per frame"
```

---

### Task 7: Scoped `store.update()` — the core fix

`store.update()` tells subscribers *that* something changed but never *what*. Every module renderer in both panes plus the sidebar re-renders on every mutation: typing in daily notes rebuilds the kanban board in the other pane, the calendar's 42 day cells, and the sidebar's team list.

The design keeps this **strictly backward compatible**: `scope` is optional and defaults to `null`, meaning "everything changed — re-render". Only call sites that opt in get narrowed. Subscribers use one pure, unit-tested predicate.

**Files:**
- Create: `src/core/scope.ts`
- Create: `test/scope.test.ts`
- Modify: `src/core/store.ts`
- Modify: `src/modules/action-items.ts`, `src/modules/milestones.ts`, `src/modules/risks.ts`, `src/modules/daily-notes.ts`, `src/modules/people-tree.ts`, `src/modules/person-notes.ts`
- Test: `test/store.test.ts`, `test/render-counts.test.ts`

**Interfaces:**
- Produces (`src/core/scope.ts`):
  - `export type Section = 'notes' | 'people' | 'actions' | 'milestones' | 'risks' | 'prefs' | 'templates' | 'teams'`
  - `export interface ChangeScope { teamId?: string; sections?: readonly Section[] }`
  - `export function scopeAffects(scope: ChangeScope | null | undefined, teamId: string, sections: readonly Section[]): boolean`
- Produces (`src/core/store.ts`): `update(fn: (d: Doc) => void, scope?: ChangeScope): void` and `subscribe(fn: (scope: ChangeScope | null) => void): () => void`.

- [ ] **Step 1: Write the failing test for the pure predicate**

Create `test/scope.test.ts`:

```ts
import { scopeAffects } from '../src/core/scope'

test('a null/undefined scope always affects everything', () => {
  expect(scopeAffects(null, 't1', ['actions'])).toBe(true)
  expect(scopeAffects(undefined, 't1', ['actions'])).toBe(true)
})

test('an empty scope object affects everything', () => {
  expect(scopeAffects({}, 't1', ['actions'])).toBe(true)
})

test('a different teamId does not affect this listener', () => {
  expect(scopeAffects({ teamId: 't2' }, 't1', ['actions'])).toBe(false)
})

test('a matching teamId with no sections affects every section', () => {
  expect(scopeAffects({ teamId: 't1' }, 't1', ['actions'])).toBe(true)
  expect(scopeAffects({ teamId: 't1' }, 't1', ['notes'])).toBe(true)
})

test('sections must intersect for the listener to be affected', () => {
  expect(scopeAffects({ teamId: 't1', sections: ['notes'] }, 't1', ['actions'])).toBe(false)
  expect(scopeAffects({ teamId: 't1', sections: ['actions'] }, 't1', ['actions'])).toBe(true)
  expect(scopeAffects({ teamId: 't1', sections: ['notes', 'actions'] }, 't1', ['actions'])).toBe(true)
})

test('a section-only scope (no teamId) applies across teams', () => {
  expect(scopeAffects({ sections: ['prefs'] }, 't1', ['prefs'])).toBe(true)
  expect(scopeAffects({ sections: ['prefs'] }, 't1', ['actions'])).toBe(false)
})

test('a listener watching several sections matches if any one intersects', () => {
  expect(scopeAffects({ sections: ['milestones'] }, 't1', ['actions', 'milestones'])).toBe(true)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/scope.test.ts`
Expected: FAIL — cannot resolve `../src/core/scope`.

- [ ] **Step 3: Implement the predicate**

Create `src/core/scope.ts`:

```ts
// src/core/scope.ts — change scoping for store.update(). Pure: no DOM, no
// store import, so it can be unit-tested and reasoned about on its own.

/**
 * The parts of a Doc a mutation can touch. Deliberately coarse — the point is
 * to stop a daily-note keystroke from rebuilding an unrelated kanban board,
 * not to track individual fields.
 */
export type Section =
  | 'notes'
  | 'people'
  | 'actions'
  | 'milestones'
  | 'risks'
  | 'prefs'
  | 'templates'
  | 'teams'

/**
 * What a `store.update()` call changed. Both fields are optional and absence
 * means "unrestricted": `{}` (or a missing scope entirely) affects every
 * listener, which is what keeps every un-migrated call site behaving exactly
 * as it did before scoping existed.
 */
export interface ChangeScope {
  /** Only this team's data changed. Omitted = could be any/all teams. */
  teamId?: string
  /** Only these sections changed. Omitted = could be any section. */
  sections?: readonly Section[]
}

/**
 * Whether a listener watching `sections` of team `teamId` needs to react to a
 * mutation described by `scope`.
 *
 * Conservative by construction: anything unknown (null scope, absent field)
 * resolves to `true`. A false negative would silently show stale UI; a false
 * positive only costs a redundant render, which is the behavior we already
 * had. When in doubt, do not narrow the call site.
 */
export function scopeAffects(
  scope: ChangeScope | null | undefined,
  teamId: string,
  sections: readonly Section[]
): boolean {
  if (!scope) return true
  if (scope.teamId !== undefined && scope.teamId !== teamId) return false
  if (scope.sections === undefined) return true
  return scope.sections.some((s) => sections.includes(s))
}
```

- [ ] **Step 4: Run to verify the predicate passes**

Run: `npx vitest run test/scope.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing store test**

Append to `test/store.test.ts`:

```ts
import type { ChangeScope } from '../src/core/scope'

test('update() forwards its scope to subscribers, defaulting to null', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  const seen: (ChangeScope | null)[] = []
  s.subscribe((scope) => seen.push(scope))

  s.update(() => {})
  s.update(() => {}, { teamId: 't1', sections: ['actions'] })

  expect(seen).toEqual([null, { teamId: 't1', sections: ['actions'] }])
})

test('replaceDoc notifies subscribers with a null scope (everything changed)', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  const seen: (ChangeScope | null)[] = []
  s.subscribe((scope) => seen.push(scope))
  s.replaceDoc(createEmptyDocument('en-US'))
  expect(seen).toEqual([null])
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/store.test.ts -t "forwards its scope"`
Expected: FAIL — `seen` is `[undefined, undefined]`.

- [ ] **Step 7: Implement the store change**

In `src/core/store.ts`, import the types and update the interface:

```ts
import type { ChangeScope } from './scope'
```

```ts
  /**
   * `scope` describes what changed so subscribers can skip irrelevant
   * re-renders (see core/scope.ts). Omitting it means "everything changed",
   * which is the pre-scoping behavior — every existing call site is therefore
   * unaffected until it deliberately opts in. Never narrow a scope you are
   * not certain about: a too-narrow scope shows stale UI, a too-wide one only
   * costs a redundant render.
   */
  update(fn: (d: Doc) => void, scope?: ChangeScope): void
  subscribe(fn: (scope: ChangeScope | null) => void): () => void
```

Change the subscriber set to `Set<(scope: ChangeScope | null) => void>` and:

```ts
    update(fn: (d: Doc) => void, scope?: ChangeScope): void {
      if (roState.kind !== 'writable') {
        warnBlocked()
        return
      }
      fn(doc)
      setDirty(true)
      const s = scope ?? null
      for (const listener of Array.from(subscribers)) { try { listener(s) } catch (e) { console.error(e) } }
      notifyMutate('content')
    },
```

In `replaceDoc`, pass `null` to each subscriber (the whole document was swapped).

- [ ] **Step 8: Run to verify the store tests pass**

Run: `npx vitest run test/store.test.ts && npx vitest run`
Expected: PASS — the full suite is still green, because no call site passes a scope yet and every subscriber ignores its argument.

- [ ] **Step 9: Commit the backward-compatible groundwork**

```bash
npm run typecheck && npm run lint && npx vitest run
git add src/core/scope.ts test/scope.test.ts src/core/store.ts test/store.test.ts
git commit -m "feat: add optional change scope to store.update()"
```

- [ ] **Step 10: Write the failing cross-pane test**

Append to `test/render-counts.test.ts`:

```ts
test('a scoped notes edit does not rebuild the kanban board in the other pane', () => {
  const { store, pm } = setup()
  store.update((d) => {
    d.teams.push(emptyTeam('t1', 'Alpha'))
    d.nav.activeTeamId = 't1'
  })
  store.update((d) => {
    const tm = d.teams.find((t) => t.id === 't1')!
    tm.actionItems.push({
      id: 'a1', summary: 'Card', notes: '', status: 'todo',
      dueDate: null, assignee: '', color: 'ledger', order: 0,
    })
  })
  pm.openBothPanes(
    { teamId: 't1', ref: { kind: 'daily', date: todayIso() } },
    { teamId: 't1', ref: { kind: 'actions' } },
    0
  )

  const card = document.querySelector('.tt-kanban-card') as HTMLElement
  expect(card).not.toBeNull()

  // A daily-note edit, scoped to 'notes'.
  store.update((d) => {
    const tm = d.teams.find((t) => t.id === 't1')!
    tm.dailyNotes[todayIso()] = 'typed something'
  }, { teamId: 't1', sections: ['notes'] })

  // The very same card element must still be in the DOM — not a rebuilt clone.
  expect(card.isConnected).toBe(true)
})

test('an actions edit still rebuilds the kanban board', () => {
  const { store, pm } = setup()
  store.update((d) => {
    d.teams.push(emptyTeam('t1', 'Alpha'))
    d.nav.activeTeamId = 't1'
  })
  pm.openBothPanes(
    { teamId: 't1', ref: { kind: 'daily', date: todayIso() } },
    { teamId: 't1', ref: { kind: 'actions' } },
    0
  )
  store.update((d) => {
    const tm = d.teams.find((t) => t.id === 't1')!
    tm.actionItems.push({
      id: 'a1', summary: 'Card', notes: '', status: 'todo',
      dueDate: null, assignee: '', color: 'ledger', order: 0,
    })
  }, { teamId: 't1', sections: ['actions'] })
  expect(document.querySelectorAll('.tt-kanban-card').length).toBe(1)
})
```

- [ ] **Step 11: Run to verify the first one fails**

Run: `npx vitest run test/render-counts.test.ts -t "does not rebuild the kanban"`
Expected: FAIL — `card.isConnected` is `false`, because the kanban's unfiltered subscriber rebuilt every card.

- [ ] **Step 12: Narrow the module subscribers**

In `src/modules/action-items.ts`, import and filter:

```ts
import { scopeAffects, type Section } from '../core/scope'
```

```ts
  // The board reflects this team's action items only. Anything else — a daily
  // note keystroke in the other pane, another team's edits — used to rebuild
  // every card here for nothing.
  const WATCHED: readonly Section[] = ['actions', 'teams']
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    renderAll()
  })
```

Apply the identical pattern in the other five module renderers, with these watch lists:

| File | `WATCHED` |
|---|---|
| `src/modules/action-items.ts` | `['actions', 'teams']` |
| `src/modules/milestones.ts` | `['milestones', 'teams']` |
| `src/modules/risks.ts` | `['risks', 'teams']` |
| `src/modules/people-tree.ts` | `['people', 'teams']` |
| `src/modules/person-notes.ts` | `['people', 'notes', 'teams']` |
| `src/modules/daily-notes.ts` | `['notes', 'milestones', 'actions', 'teams']` — the calendar marks show milestone flags and action-item due dates, so it genuinely needs all three |

`'teams'` is in every list because a team rename/delete/reorder can invalidate any pane.

- [ ] **Step 13: Add scopes to the hot mutation call sites**

Only these — leave every other `store.update()` unscoped (safe default):

- `src/modules/daily-notes.ts`, the `onChange` handler: `}, { teamId, sections: ['notes'] })`
- `src/modules/action-items.ts`: `removeItem`, `clearZone`'s `onConfirm`, `openEditModal`'s `save`, `openEditTagsModal`'s save, and both drop handlers → `{ teamId, sections: ['actions'] }`
- `src/modules/milestones.ts`: its create/edit/delete/reorder updates → `{ teamId, sections: ['milestones'] }`
- `src/modules/risks.ts`: its create/edit/delete/reorder updates → `{ teamId, sections: ['risks'] }`
- `src/modules/people-tree.ts`: its create/edit/delete/reorder updates → `{ teamId, sections: ['people'] }`
- `src/modules/person-notes.ts`: its notes `onChange` → `{ teamId, sections: ['people', 'notes'] }`

**Do not scope** `src/ui/prefs.ts`, `src/ui/sidebar.ts`, or `src/core/card-transfer.ts` updates. Prefs drive locale/theme across the whole UI, sidebar updates restructure the team list, and card-transfer moves an item *between* teams — all three legitimately mean "everything changed".

- [ ] **Step 14: Run the full suite**

Run: `npx vitest run`
Expected: PASS. If a module test fails because it expected a re-render that no longer happens, **do not** widen the scope reflexively — first confirm from the test whether the UI genuinely needs that refresh. If it does, widen; if the test was over-specified, update the test and say so in the commit body.

- [ ] **Step 15: Full gate + commit**

```bash
npm run typecheck && npm run lint && npx vitest run
git add src/modules test/render-counts.test.ts
git commit -m "perf: scope module re-renders to the sections they display"
```

---

### Task 8: Cache the search index

`searchDocument()` re-collects every note in every team and re-runs `stripMd` (seven regex passes per line) plus `normalize` (NFD + regex) on **every keystroke** past the 150 ms debounce. It is the largest repeated allocation in the app.

`searchDocument()` itself stays exactly as-is so its existing tests keep passing. The caching lives in a new `createSearchIndex()` that `search-ui.ts` uses instead.

**Files:**
- Modify: `src/core/store.ts` (add a `rev` counter)
- Modify: `src/core/search.ts` (add `createSearchIndex`)
- Modify: `src/ui/search-ui.ts` (use the index)
- Test: `test/search.test.ts`, `test/store.test.ts`

**Interfaces:**
- Produces (`src/core/store.ts`): `readonly rev: number` — increments on every `update()`, `updateNav()`, and `replaceDoc()`.
- Produces (`src/core/search.ts`):
  - `export interface SearchIndex { search(query: string, scopeTeamId: string | null): SearchResult[] }`
  - `export function createSearchIndex(getDoc: () => Doc, getRev: () => number): SearchIndex`

- [ ] **Step 1: Write the failing `rev` test**

Append to `test/store.test.ts`:

```ts
test('rev increments on every mutation channel', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  const start = s.rev
  s.update(() => {})
  expect(s.rev).toBe(start + 1)
  s.updateNav(() => {})
  expect(s.rev).toBe(start + 2)
  s.replaceDoc(createEmptyDocument('en-US'))
  expect(s.rev).toBe(start + 3)
})

test('rev does not increment for a blocked (read-only) update', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  s.setReadOnly(true)
  const start = s.rev
  s.update(() => {})
  expect(s.rev).toBe(start)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/store.test.ts -t "rev increments"`
Expected: FAIL — `s.rev` is `undefined`.

- [ ] **Step 3: Implement `rev`**

In `src/core/store.ts`, add to the interface:

```ts
  /**
   * Monotonic mutation counter. Consumers that cache derived data (e.g.
   * core/search.ts's index) compare it to decide whether their cache is
   * stale — the Doc is mutated in place, so object identity can't tell them.
   */
  readonly rev: number
```

Add `let rev = 0`, a `get rev() { return rev }` accessor, and `rev++` in `update()` (after the read-only guard), `updateNav()`, and `replaceDoc()`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing index test**

Append to `test/search.test.ts`:

```ts
import { createSearchIndex } from '../src/core/search'
import { createEmptyDocument } from '../src/core/document'
import type { Doc, Team } from '../src/core/types'

function teamWithNote(id: string, name: string, note: string): Team {
  return {
    id, name, emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: { '2026-08-01': note },
  }
}

test('the index returns the same results as searchDocument', () => {
  const doc: Doc = createEmptyDocument('en-US')
  doc.teams.push(teamWithNote('t1', 'Alpha', 'deploy the **release** today'))
  let rev = 0
  const index = createSearchIndex(() => doc, () => rev)

  const first = index.search('release', null)
  expect(first.length).toBe(1)
  expect(first[0]!.snippet).toContain('release')
})

test('repeat searches at the same rev reuse the cache', () => {
  const doc: Doc = createEmptyDocument('en-US')
  doc.teams.push(teamWithNote('t1', 'Alpha', 'alpha note'))
  let rev = 0
  const index = createSearchIndex(() => doc, () => rev)

  expect(index.search('alpha', null).length).toBe(1)
  // Mutate the doc WITHOUT bumping rev: a cached index must not see it.
  doc.teams[0]!.dailyNotes['2026-08-01'] = 'beta note'
  expect(index.search('beta', null).length).toBe(0)
})

test('bumping rev invalidates the cache', () => {
  const doc: Doc = createEmptyDocument('en-US')
  doc.teams.push(teamWithNote('t1', 'Alpha', 'alpha note'))
  let rev = 0
  const index = createSearchIndex(() => doc, () => rev)

  expect(index.search('alpha', null).length).toBe(1)
  doc.teams[0]!.dailyNotes['2026-08-01'] = 'beta note'
  rev = 1
  expect(index.search('beta', null).length).toBe(1)
  expect(index.search('alpha', null).length).toBe(0)
})

test('team scoping still applies through the index', () => {
  const doc: Doc = createEmptyDocument('en-US')
  doc.teams.push(teamWithNote('t1', 'Alpha', 'shared word'))
  doc.teams.push(teamWithNote('t2', 'Beta', 'shared word'))
  const index = createSearchIndex(() => doc, () => 0)

  expect(index.search('shared', null).length).toBe(2)
  expect(index.search('shared', 't1').length).toBe(1)
  expect(index.search('shared', 't1')[0]!.teamName).toBe('Alpha')
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/search.test.ts`
Expected: FAIL — `createSearchIndex` is not exported.

- [ ] **Step 7: Implement the index**

Add to `src/core/search.ts` (keep everything already there untouched):

```ts
/** A candidate with its markdown stripped and normalized once, ready to match against. */
interface PreparedCandidate {
  ref: ModuleRef
  title: string
  stripped: string
  normalized: string
}

export interface SearchIndex {
  search(query: string, scopeTeamId: string | null): SearchResult[]
}

/**
 * A `searchDocument` that prepares each team's candidates once per document
 * revision instead of once per keystroke. `stripMd` runs seven regexes per
 * line and `normalize` does an NFD pass plus a regex — repeating both across
 * every note in every team on each of a fast typist's keystrokes was the
 * single largest source of repeated allocation in the app.
 *
 * Keyed by `getRev()` rather than by object identity, because the store
 * mutates the Doc in place: the same `Team` object is both the before and the
 * after of an edit, so identity can never signal staleness.
 */
export function createSearchIndex(getDoc: () => Doc, getRev: () => number): SearchIndex {
  let cachedRev = -1
  let cache = new Map<string, PreparedCandidate[]>()

  function preparedFor(team: Team, doc: Doc): PreparedCandidate[] {
    const rev = getRev()
    if (rev !== cachedRev) {
      cache = new Map()
      cachedRev = rev
    }
    const hit = cache.get(team.id)
    if (hit) return hit
    const prepared = collectCandidates(team, doc).map((c): PreparedCandidate => {
      const stripped = stripMd(c.raw)
      return { ref: c.ref, title: c.title, stripped, normalized: normalize(stripped) }
    })
    cache.set(team.id, prepared)
    return prepared
  }

  return {
    search(query: string, scopeTeamId: string | null): SearchResult[] {
      const trimmedQuery = query.trim()
      if (!trimmedQuery) return []
      const terms = normalize(trimmedQuery).split(/\s+/).filter(Boolean)
      if (terms.length === 0) return []

      const doc = getDoc()
      const teams = scopeTeamId === null ? doc.teams : doc.teams.filter((team) => team.id === scopeTeamId)
      const results: SearchResult[] = []

      for (const team of teams) {
        for (const candidate of preparedFor(team, doc)) {
          if (!allTermsMatch(candidate.normalized, terms)) continue
          results.push({
            loc: { teamId: team.id, ref: candidate.ref },
            moduleKind: candidate.ref.kind,
            title: candidate.title,
            snippet: makeSnippet(candidate.stripped, candidate.normalized, terms),
            teamName: team.name,
          })
          if (results.length >= RESULT_LIMIT) return results
        }
      }
      return results
    },
  }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run test/search.test.ts`
Expected: PASS.

- [ ] **Step 9: Wire it into the search UI**

In `src/ui/search-ui.ts`, import `createSearchIndex`, build one instance inside `mountSearch`:

```ts
  const index = createSearchIndex(() => store.doc, () => store.rev)
```

and replace the `searchDocument(store.doc, …)` call with `index.search(…)`. Leave the `searchDocument` import in place only if something else in the file still uses it; otherwise remove it so lint stays clean.

- [ ] **Step 10: Run the search UI tests**

Run: `npx vitest run test/search-ui.test.ts test/search.test.ts test/search-expand-highlight.test.ts`
Expected: PASS.

- [ ] **Step 11: Full gate + commit**

```bash
npm run typecheck && npm run lint && npx vitest run
git add src/core/store.ts src/core/search.ts src/ui/search-ui.ts test/store.test.ts test/search.test.ts
git commit -m "perf: cache prepared search candidates per document revision"
```

---

### Task 9: Extract pane layout state into `core/pane-layout.ts`

`src/ui/panes.ts` is 789 lines mixing navigation *policy* with DOM rendering. The clearest symptom is `unsplitStashInvalidators` — a module-level `WeakMap<Store, () => void>` whose only purpose is letting the free function `stepPaneHistory` reach into `createPaneManager`'s closure to invalidate the un-split stash.

Extracting the transient layout state into its own controller removes that WeakMap entirely. This is a **pure refactor: no behavior changes.** Task 1's characterization tests plus the existing 34 KB of `test/panes.test.ts` are the safety net.

**Files:**
- Create: `src/core/pane-layout.ts`
- Create: `test/pane-layout.test.ts`
- Modify: `src/ui/panes.ts`
- Modify: `src/main.ts` (the `navigateFocusedHistory` import/call)
- Test: `test/panes.test.ts`

**Interfaces:**
- Produces (`src/core/pane-layout.ts`):
  - `export interface PaneLayout {`
    - `stepHistory(idx: 0 | 1, dir: -1 | 1): boolean`
    - `noteRealNavigation(idx: 0 | 1): void`
    - `invalidateStash(): void`
    - `applyToggleSplit(wasVisible: boolean): void`
  - `}`
  - `export function createPaneLayout(store: Store): PaneLayout`
- The existing exports `stepPaneHistory`, `navigateFocusedHistory`, `teamHasHistory`, `openTeamDefaultLayout`, `restoreTeamLayout`, `invalidateUnsplitStash` stay exported from `src/ui/panes.ts` (tests import them from there) but delegate to the layout controller.

- [ ] **Step 1: Write the failing test**

Create `test/pane-layout.test.ts`:

```ts
import { createPaneLayout } from '../src/core/pane-layout'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { Loc } from '../src/core/types'

function loc(teamId: string, kind: 'daily' | 'members' | 'actions'): Loc {
  if (kind === 'daily') return { teamId, ref: { kind: 'daily', date: '2026-08-01' } }
  return { teamId, ref: { kind } }
}

test('applyToggleSplit(true) pulls pane 1 into pane 0 when pane 1 was focused', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => {
    d.nav.split = true
    d.nav.focusedPane = 1
    d.nav.panes[0] = { history: [loc('t1', 'daily')], index: 0 }
    d.nav.panes[1] = { history: [loc('t1', 'members')], index: 0 }
  })

  layout.applyToggleSplit(true) // was visible → un-split

  expect(store.doc.nav.split).toBe(false)
  expect(store.doc.nav.focusedPane).toBe(0)
  expect(store.doc.nav.panes[0]!.history[0]!.ref.kind).toBe('members')
})

test('re-splitting restores the stashed pane 0 content', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => {
    d.nav.split = true
    d.nav.focusedPane = 1
    d.nav.panes[0] = { history: [loc('t1', 'daily')], index: 0 }
    d.nav.panes[1] = { history: [loc('t1', 'members')], index: 0 }
  })

  layout.applyToggleSplit(true)  // un-split, stash pane 0's daily
  layout.applyToggleSplit(false) // re-split, restore it

  expect(store.doc.nav.split).toBe(true)
  expect(store.doc.nav.panes[0]!.history[0]!.ref.kind).toBe('daily')
})

test('a real navigation into pane 0 invalidates the stash', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => {
    d.nav.split = true
    d.nav.focusedPane = 1
    d.nav.panes[0] = { history: [loc('t1', 'daily')], index: 0 }
    d.nav.panes[1] = { history: [loc('t1', 'members')], index: 0 }
  })

  layout.applyToggleSplit(true)
  layout.noteRealNavigation(0) // user navigated pane 0 while unsplit
  layout.applyToggleSplit(false)

  // Stash was invalidated: pane 0 keeps what it has, not the stale daily.
  expect(store.doc.nav.panes[0]!.history[0]!.ref.kind).toBe('members')
})

test('stepHistory returns false when there is nowhere to go', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => { d.nav.panes[0] = { history: [loc('t1', 'daily')], index: 0 } })
  expect(layout.stepHistory(0, -1)).toBe(false)
})

test('stepHistory walks back and sets the focused pane', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => {
    d.nav.focusedPane = 1
    d.nav.panes[0] = { history: [loc('t1', 'daily'), loc('t1', 'members')], index: 1 }
  })
  expect(layout.stepHistory(0, -1)).toBe(true)
  expect(store.doc.nav.panes[0]!.index).toBe(0)
  expect(store.doc.nav.focusedPane).toBe(0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/pane-layout.test.ts`
Expected: FAIL — cannot resolve `../src/core/pane-layout`.

- [ ] **Step 3: Implement the controller**

Create `src/core/pane-layout.ts`, moving the stash logic verbatim out of `panes.ts`'s `toggleSplit` and `stepPaneHistory`:

```ts
// src/core/pane-layout.ts — the transient (never-persisted) half of pane
// layout state, extracted out of ui/panes.ts so navigation policy lives apart
// from DOM rendering. Nothing here touches the DOM.
import type { Store } from './store'
import type { PaneState } from './types'
import { currentLoc, navigateHistory } from './nav'

function otherPaneIdx(idx: 0 | 1): 0 | 1 {
  return idx === 0 ? 1 : 0
}

export interface PaneLayout {
  /**
   * Applies one history step (back/forward) to pane `idx`, skipping any entry
   * that would conflict with the other pane's current Loc. Returns whether
   * the nav state actually changed.
   */
  stepHistory(idx: 0 | 1, dir: -1 | 1): boolean
  /** Records that a real navigation landed in pane `idx` — invalidates the stash for idx 0. */
  noteRealNavigation(idx: 0 | 1): void
  /** Drops the stash outright (e.g. sidebar.ts's deleteTeam pruning histories directly). */
  invalidateStash(): void
  /**
   * Flips `nav.split` and maintains the un-split stash. `wasVisible` is the
   * *effective* (on-screen) split state before the toggle, which differs from
   * `nav.split` when the responsive layout has force-hidden the split view.
   */
  applyToggleSplit(wasVisible: boolean): void
}

export function createPaneLayout(store: Store): PaneLayout {
  // Holds pane 0's pre-pull PaneState so a later re-split can put it back on
  // the left instead of leaving both panes showing an identical duplicate.
  // Never persisted — losing it on reload is fine, it's a same-session UX
  // nicety, not app state.
  let unsplitStash: PaneState | null = null
  // Explicit rather than relying on object identity (which happens to hold
  // because updateNav mutates in place) — any real navigation while unsplit
  // invalidates the stash.
  let unsplitStashValid = false

  return {
    stepHistory(idx, dir) {
      const nav = store.doc.nav
      const other = currentLoc(nav.panes[otherPaneIdx(idx)])
      const result = navigateHistory(nav.panes[idx], dir, other)
      if (!result) return false
      store.updateNav((d) => {
        d.nav.panes[idx] = result
        d.nav.focusedPane = idx
      })
      if (idx === 0) {
        unsplitStash = null
        unsplitStashValid = false
      }
      return true
    },
    noteRealNavigation(idx) {
      if (idx !== 0) return
      unsplitStash = null
      unsplitStashValid = false
    },
    invalidateStash() {
      unsplitStash = null
      unsplitStashValid = false
    },
    applyToggleSplit(wasVisible) {
      store.updateNav((d) => {
        d.nav.split = !wasVisible
        // Un-splitting hides pane 1 (pane 0 is never hidden) — leaving focus
        // stuck there would silently misdirect every focused-pane action at a
        // pane the user can no longer see. If pane 1 was focused, pull its
        // content into pane 0 so closing split keeps what the user was
        // looking at, stashing pane 0's own content first.
        if (!d.nav.split) {
          if (d.nav.focusedPane === 1) {
            unsplitStash = d.nav.panes[0]
            unsplitStashValid = true
            d.nav.panes[0] = d.nav.panes[1]
          } else {
            unsplitStash = null
            unsplitStashValid = false
          }
          d.nav.focusedPane = 0
        } else if (unsplitStashValid && unsplitStash) {
          d.nav.panes[0] = unsplitStash
          unsplitStash = null
          unsplitStashValid = false
        }
        // Remembers this choice per team so switching back restores it.
        if (d.nav.activeTeamId) d.nav.teamSplit[d.nav.activeTeamId] = d.nav.split
      })
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/pane-layout.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Rewire `panes.ts` onto the controller**

In `src/ui/panes.ts`:

- Delete the `unsplitStashInvalidators` WeakMap and its long doc comment.
- Delete the closure-local `unsplitStash` / `unsplitStashValid` declarations.
- In `createPaneManager`, add `const layout$ = createPaneLayout(store)` (named `layout$` to avoid colliding with the existing `layout()` render function).
- `toggleSplit()` becomes:

```ts
  function toggleSplit(): void {
    const wasVisible = effectiveSplit()
    layout$.applyToggleSplit(wasVisible)
    if (wasVisible === false) spaceHideSplit = false
    renderAll()
  }
```

- Replace the two `unsplitStashValid = false` lines in `openInPane` and `openBothPanes` with `layout$.noteRealNavigation(0)` and `layout$.invalidateStash()` respectively.
- `goHistory(idx, dir)` calls `layout$.stepHistory(idx, dir)`.
- Keep a per-store registry so the module-level free functions still work, but make it hold the whole controller rather than a single callback:

```ts
/**
 * One `PaneLayout` per `PaneManager`, keyed by Store so the module-level free
 * functions below (which main.ts and sidebar.ts call without a PaneManager in
 * hand) can reach the same transient layout state. Replaced — not
 * accumulated — if a store ever gets a second manager, and GC'd with the store.
 */
const layoutsByStore = new WeakMap<Store, PaneLayout>()

export function invalidateUnsplitStash(store: Store): void {
  layoutsByStore.get(store)?.invalidateStash()
}

export function stepPaneHistory(store: Store, idx: 0 | 1, dir: -1 | 1): boolean {
  const owned = layoutsByStore.get(store)
  if (owned) return owned.stepHistory(idx, dir)
  // No PaneManager for this store yet (unit tests drive the free function
  // directly): fall back to a throwaway controller. Its stash starts empty,
  // which is exactly right for a store that has no live layout.
  return createPaneLayout(store).stepHistory(idx, dir)
}
```

Register inside `createPaneManager`: `layoutsByStore.set(store, layout$)`.

- [ ] **Step 6: Run the full pane + nav suites**

Run: `npx vitest run test/panes.test.ts test/pane-layout.test.ts test/nav.test.ts test/sidebar.test.ts test/render-counts.test.ts`
Expected: PASS with no changes to `test/panes.test.ts` — this is a pure refactor. If a pane test fails, the extraction changed behavior; fix the source, not the test.

- [ ] **Step 7: Full gate + commit**

```bash
npm run typecheck && npm run lint && npx vitest run
git add src/core/pane-layout.ts test/pane-layout.test.ts src/ui/panes.ts
git commit -m "refactor: extract transient pane layout state into core/pane-layout"
```

---

### Task 10: Collapse the seven per-module disposer WeakMaps

Seven module files each declare `const disposers = new WeakMap<HTMLElement, () => void>()` plus the same dispose-then-remount preamble, and `daily-notes.ts` carries a 15-line comment explaining the pattern that the other six reference. One shared helper replaces all of it.

Critically, the helper preserves the **self-disposal on re-invocation** semantics: many existing tests call `renderActionItems(container, loc, ctx)` twice on the same container and rely on the first instance tearing itself down. A "return an instance, caller disposes" design would break those; this design does not.

**Files:**
- Create: `src/modules/lifecycle.ts`
- Create: `test/lifecycle.test.ts`
- Modify: `src/modules/action-items.ts`, `daily-notes.ts`, `general-notes.ts`, `milestones.ts`, `people-tree.ts`, `person-notes.ts`, `risks.ts`

**Interfaces:**
- Produces: `export function withDisposal(render: (container: HTMLElement, loc: Loc, ctx: ModuleCtx) => (() => void) | void): ModuleRenderer`
  - The wrapped `render` returns its teardown function (or nothing). `withDisposal` runs the previous teardown for that container before invoking `render` again.

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle.test.ts`:

```ts
import { withDisposal } from '../src/modules/lifecycle'
import type { Loc } from '../src/core/types'
import type { ModuleCtx } from '../src/ui/panes'

const LOC: Loc = { teamId: 't1', ref: { kind: 'general' } }
const CTX = {} as ModuleCtx

test('re-rendering into the same container disposes the previous instance first', () => {
  const events: string[] = []
  const render = withDisposal((container) => {
    events.push(`mount:${container.id}`)
    return () => events.push(`dispose:${container.id}`)
  })

  const a = document.createElement('div')
  a.id = 'a'
  render(a, LOC, CTX)
  render(a, LOC, CTX)

  expect(events).toEqual(['mount:a', 'dispose:a', 'mount:a'])
})

test('separate containers keep independent lifecycles', () => {
  const events: string[] = []
  const render = withDisposal((container) => {
    events.push(`mount:${container.id}`)
    return () => events.push(`dispose:${container.id}`)
  })

  const a = document.createElement('div')
  a.id = 'a'
  const b = document.createElement('div')
  b.id = 'b'
  render(a, LOC, CTX)
  render(b, LOC, CTX)

  expect(events).toEqual(['mount:a', 'mount:b'])
})

test('a render returning nothing is supported and clears any prior teardown', () => {
  const events: string[] = []
  let returnTeardown = true
  const render = withDisposal((container) => {
    events.push('mount')
    if (!returnTeardown) return
    return () => events.push('dispose')
  })

  const a = document.createElement('div')
  render(a, LOC, CTX)   // mounts with a teardown
  returnTeardown = false
  render(a, LOC, CTX)   // disposes the first, mounts with none
  render(a, LOC, CTX)   // nothing to dispose

  expect(events).toEqual(['mount', 'dispose', 'mount', 'mount'])
})

test('a throwing teardown does not prevent the new mount', () => {
  const events: string[] = []
  let first = true
  const render = withDisposal(() => {
    events.push('mount')
    if (first) {
      first = false
      return () => { throw new Error('boom') }
    }
    return () => events.push('dispose')
  })

  const a = document.createElement('div')
  render(a, LOC, CTX)
  render(a, LOC, CTX)

  expect(events).toEqual(['mount', 'mount'])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lifecycle.test.ts`
Expected: FAIL — cannot resolve `../src/modules/lifecycle`.

- [ ] **Step 3: Implement the helper**

Create `src/modules/lifecycle.ts`:

```ts
// src/modules/lifecycle.ts — the per-container mount/dispose bookkeeping every
// module renderer needs, in one place instead of seven copies.
import type { Loc } from '../core/types'
import type { ModuleCtx, ModuleRenderer } from '../ui/panes'

/**
 * Per-container teardown for the instance currently mounted there.
 *
 * Module renderers are invoked repeatedly on the *same* container element:
 * ui/panes.ts's `renderBody` clears the container's DOM children before
 * re-invoking the renderer, but that clear does not reach the document-level
 * listeners and document.body-appended overlays that ui/atref.ts's and
 * ui/template-picker.ts's dropdowns attach when open (they are not
 * descendants of `container`). Without explicit disposal those leak a live
 * document 'mousedown' listener plus an orphaned dropdown element on every
 * re-open of the same pane.
 *
 * A WeakMap (rather than a DOM data-attribute or a property stashed on the
 * element) keeps this bookkeeping off the container itself and lets the
 * container be garbage-collected normally once panes.ts drops it.
 */
const teardowns = new WeakMap<HTMLElement, () => void>()

/**
 * Wraps a module render function so the instance it previously mounted into a
 * given container is torn down before a new one replaces it. The wrapped
 * function returns its teardown (or nothing, if it has none).
 *
 * Self-disposing on re-invocation — rather than handing the caller an instance
 * to dispose — is deliberate: renderers are called directly (by panes.ts and
 * by tests) with no instance bookkeeping at the call site, and that contract
 * predates this helper.
 */
export function withDisposal(
  render: (container: HTMLElement, loc: Loc, ctx: ModuleCtx) => (() => void) | void
): ModuleRenderer {
  return (container: HTMLElement, loc: Loc, ctx: ModuleCtx): void => {
    const previous = teardowns.get(container)
    teardowns.delete(container)
    if (previous) {
      try {
        previous()
      } catch (e) {
        console.error(e)
      }
    }
    const teardown = render(container, loc, ctx)
    if (teardown) teardowns.set(container, teardown)
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lifecycle.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Migrate one module and verify**

Convert `src/modules/daily-notes.ts` first (it has the richest teardown). Delete its local `disposers` WeakMap and the leading dispose lines, and change the export:

```ts
export const renderDailyNotes = withDisposal((container, loc, ctx) => {
  if (loc.ref.kind !== 'daily') return // registered only for 'daily'; defensive
  // …unchanged body…
  container.appendChild(layout)

  return () => {
    unsubscribe()
    bundle.dispose()
  }
})
```

Note the early `return` for the wrong-kind guard now also means "no teardown", which is correct.

Run: `npx vitest run test/daily-notes.test.ts test/panes.test.ts`
Expected: PASS.

- [ ] **Step 6: Migrate the remaining six**

Apply the same conversion to `general-notes.ts`, `people-tree.ts`, `person-notes.ts`, `action-items.ts`, `milestones.ts`, `risks.ts`. Each one: delete the local WeakMap, wrap the body in `withDisposal`, return the teardown that its `disposers.set(container, …)` call used to register.

`person-notes.ts` needs care — it has **two** `disposers.set` sites (one at line ~44 registering an empty teardown for an early-return path, one at ~86). Under `withDisposal`, the early-return path simply returns nothing.

Run after each file: `npx vitest run test/<module>.test.ts`

- [ ] **Step 7: Full gate + commit**

```bash
npm run typecheck && npm run lint && npx vitest run
git add src/modules test/lifecycle.test.ts
git commit -m "refactor: share one module disposal helper across all renderers"
```

---

### Task 11: Final verification and version bump

**Files:**
- Modify: `package.json` (version)
- Modify: `CLAUDE.md` (architecture notes for the new files)

- [ ] **Step 1: Run the whole gate three times**

The pre-existing flakiness noted at plan authoring time (one cold-start run showed 22 failures across 9 files, four subsequent runs were clean) means a single green run is not proof.

```bash
for i in 1 2 3; do npx vitest run 2>&1 | grep -E "Test Files|Tests "; done
```
Expected: three identical clean runs. If any run fails, investigate before proceeding — do not dismiss it as flake without reading the failure.

- [ ] **Step 2: Verify the build still produces both variants**

```bash
npm run build && ls -la dist/app.html dist/pwa/
```
Expected: `dist/app.html` exists and is self-contained; `dist/pwa/` contains the manifest, icon, and `sw.js`.

- [ ] **Step 3: Confirm `dist/app.html` references no external files**

```bash
grep -oE '(src|href)="[^"]*"' dist/app.html | grep -v '^\(src\|href\)="data:' || echo "OK: no external references"
```
Expected: `OK: no external references` (or only `data:` URIs).

- [ ] **Step 4: Update `CLAUDE.md`**

Add to the **Architecture** section's `src/core/` list:

```
  - `scope.ts` — `ChangeScope`/`Section` plus the pure `scopeAffects()` predicate that lets a `store.update()` describe what it changed. An absent scope means "everything changed", so unscoped call sites keep pre-scoping behavior.
  - `pane-layout.ts` — the transient (never-persisted) half of pane layout: the un-split stash and history stepping, extracted from `ui/panes.ts` so navigation policy sits apart from DOM rendering.
```

Add to the `src/modules/` bullet:

```
Each renderer is wrapped in `lifecycle.ts`'s `withDisposal()`, which tears down the instance previously mounted into a container before mounting a new one.
```

Amend the `store.ts` bullet to mention `update(fn, scope?)` and `rev`.

- [ ] **Step 5: Bump the version**

Edit `package.json`, bumping the minor version (`1.7.3` → `1.8.0`). The service worker cache name embeds `__APP_VERSION__`, so PWA clients pick up the new build.

- [ ] **Step 6: Final gate + commit**

```bash
npm run typecheck && npm run lint && npx vitest run && npm run build
git add package.json CLAUDE.md
git commit -m "chore: bump version to 1.8.0 for perf/lifecycle refactor"
```

---

## Self-Review

**Spec coverage** — every item from the evaluation maps to a task:

| Eval item | Task |
|---|---|
| Sidebar + panes listener leaks | 2, 3 |
| Sidebar duplicate render | 4 |
| Skip hidden pane | 5 |
| rAF divider drag | 6 |
| Scoped `update()` | 7 |
| Search index/cache | 8 |
| Nav policy → `core/nav.ts` | 9 |
| Module lifecycle helper | 10 |
| Regression safety net | 1, 11 |

**Deferred deliberately:** keyed reconciliation for card lists (eval item 7). Task 7's scoping removes most of the triggers that made card rebuilds visible; measure before adding ~30 lines of diffing that would need its own correctness tests. Revisit only if kanban rebuild cost is still observable after this plan lands.

**Type consistency check:** `ChangeScope`/`Section`/`scopeAffects` (Task 7) are used consistently in Tasks 7's module edits. `MutationKind` (Task 4) is used in Task 4 only. `PaneLayout`/`createPaneLayout` (Task 9) match between the controller and `panes.ts`'s rewiring. `withDisposal` (Task 10) matches `ModuleRenderer` from `ui/panes.ts`. `store.rev` is introduced in Task 8 Step 3 and consumed in Task 8 Step 9 — note it is **not** available earlier, so no earlier task may reference it.

**Ordering constraints:** Task 4 must precede Task 7 (both touch `store.ts`'s notification path). Task 8's `rev` must land before its own Step 9. Task 9 must precede nothing, but is easier after Task 5/6 have already touched `panes.ts`. Task 10 is independent and could move earlier if convenient.
