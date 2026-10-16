# Code Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding from the 2026-10-16 codebase review that re-verification showed to be a real problem, with tests pinning each fix and the behaviour next to it, and record why the rest are left alone.

**Architecture:** Three confirmed bugs are fixed first, each in one place: the dirty flag in the save controller, module teardown in the pane manager, and `<select>` state in print. Smaller correctness fixes follow (toast keys, `replaceDoc` firing `onMutate`, day rollover, Ctrl+wheel, stale mention labels). The duplication work comes last. Every refactor starts with characterization tests that pass before and after, so a refactor can move code but cannot change behaviour.

**Tech Stack:** TypeScript 6, vitest 5 + jsdom, Playwright e2e, zero runtime dependencies.

**Spec:** No separate spec. The verdicts in the evaluation table below come from this plan's own re-verification and act as the spec.

## Global Constraints

- Zero runtime dependencies. Add nothing to `dependencies`.
- All user-visible strings go through `t()` with keys in both `pt-BR` and `en-US`. No task in this plan adds a string.
- Every new `src` module gets a matching `test/*.test.ts`.
- Work directly on `dev`. No worktrees, no feature branches.
- Gate per task: `npm run typecheck && npm run lint && npm test`. Also run `npm run test:e2e` after Tasks 8, 11 and 13, the ones that touch module renderers.
- Commit messages are conventional (`fix:` / `refactor:` / `test:`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No version bump in this plan. A release that ships these fixes needs a short `CHANGELOG.md` entry via the `changelog` skill.

## Finding evaluation (is it really a problem?)

| # | Finding | Verdict | Evidence | Task |
|---|---------|---------|----------|------|
| 1 | Edit during an in-flight save, trailing save fails → `dirty` false | **Confirmed bug (data loss)** | Probe test: `store.dirty` false after the failed trailing write. `conflict-flow.ts:632` already uses the correct rev guard. | 1 |
| 2 | Pane going empty never disposes its module | **Confirmed leak** | Probe: 2 live subscriptions, expected 1. Reachable by deleting the last team. | 2 |
| 3 | Print loses `<select>` values | **Confirmed bug** | Chromium and jsdom: a cloned select reads `1` where the original reads `3`. Printed risks show chance 1, impact 1, Mitigate. | 3 |
| 4 | Kanban due pills and the daily calendar's "today" go stale overnight | **Real** | Same bug class as d907708 (milestones). Neither surface listens for a return to the window. | 6 |
| 5 | Read-only tab: plain inputs still accept typing | **Real. User decision: lock editing** | `store.update` is blocked, so whatever is typed is shown and then lost. Only the rich editors were locked. | 15 |
| 6 | `replaceDoc` skips `onMutate` | **Real** | After a reload (conflict modal or tab takeover) that changes the team count, the search box and app-name button keep the old enabled state, and a stale undo toast lingers. | 5 |
| 7 | Two `setFocusedPane` functions | **Not a bug** | Each is correct for its callers: pane 1 cannot be clicked while hidden, and the hotkey path re-renders. Naming only. | 14 (rename) |
| 8 | General-notes chips and person-notes `{person}` go stale after a rename | **Real (minor)** | General notes never subscribes. Person notes reads `person.name` once at mount. | 8, 9 |
| 9 | Ctrl+wheel in a read-only tab toasts a size it never applied | **Real (minor)** | `store.update` is blocked but the toast and `applyPrefs` run anyway. The code is untested today. | 7 |
| 10 | Risks/milestones row behaviour duplicated (~400 lines) | **Maintenance risk** | Fixes already had to land twice (the "same race as the risk row's guard" comments). Both modules are heavily tested (risks 2306 test lines, milestones 1679). | 13 |
| 11 | "Clone team, restore on undo" hand-written 6× | **Maintenance risk** | Every site has a deep-equal undo test (action-items 2382–2490, risks 1058/2087, people-tree 467, entity-delete 54, milestones 1429). | 11 |
| 12 | Action-items `patch` re-implements `patchTeamItem` | Duplication | Same semantics. | 11 |
| 13 | Rich-editor bundle boilerplate ×6 | Duplication | Template-scope behaviour is untested for actions, risks, milestones and person notes. Characterization tests are added first. | 8 |
| 14 | Pill clickability rule copied in action-items | Duplication / drift risk | Two state lists that must agree. | 10 |
| 15 | Chip lambda ×9, md-normalize ×6, next-order ×4, `moveCard`/`moveColumn`/`moveRisk` | Duplication | The three move functions are **kept separate**: when the drop target is missing, `moveRisk` does nothing while the other two append. They behave differently and each is pinned by tests. | 8, 11, 12 |
| 16 | Conflict-flow toasts have no key | **Real (minor)** | The save controller dismisses `save-permission`/`save-error` by key after a successful save. The unkeyed sticky toasts from Overwrite are never dismissed. | 4 |
| 17 | `layoutsByStore` free functions in panes.ts | **Not fixing** | It is the deliberate API for main.ts hotkeys and their tests. Changing it is churn with no behaviour gain. | — |
| 18 | `main.ts` too long | Partly | Only the untested Ctrl+wheel block moves out (Task 7). The rest is wiring. | 7 |
| 19 | Single `openBundle` slot in the card modal | **Not reachable** | The overlay is a fixed full-viewport scrim (`styles.css:669`) and the arrow fallback is blocked by `blockedByModal()`. A second card modal cannot open. | — |
| 20 | Stale comments, unused `_locale` param | Cosmetic | `todayIso` relocation is **not** done: 17 importers plus test mocks, churn only. | 14 |

## Review Focus

1. An edit landing during the **backup** write (after the primary write, before `markSaved`) must stay dirty. Covered by a test in Task 1.
2. `replaceDoc` while a save is in flight now queues one trailing write of the reloaded doc. It must end clean, without a conflict. Covered by a test in Task 5.
3. Several selects per row with different values must each print their own value, not just the first. Covered by a test in Task 3.
4. Day rollover while the kanban column-rename input is focused must defer, not wipe the rename. Covered by a test in Task 6.
5. The general-notes subscription must not touch the editor on the note's own keystrokes (caret safety). Covered by a test in Task 9.

---

### Task 1: Save controller keeps `dirty` until the bytes containing an edit are written

**Files:**
- Modify: `src/core/save-controller.ts` (`doSave`, ~lines 314–395)
- Test: `test/save-controller.test.ts`

**Interfaces:**
- Consumes: `store.rev` (bumped by `update`, `updateNav` and `replaceDoc`).
- Produces: no API change. `doSave` clears `dirty` only when `store.rev` hasn't moved since its snapshot.

- [ ] **Step 1: Write the failing tests** (append to `test/save-controller.test.ts`)

```ts
describe('an edit that lands while a save is in flight', () => {
  function ctlFor(store: ReturnType<typeof createStore>, shell: Shell, extra: Partial<Parameters<typeof createSaveController>[0]> = {}) {
    return createSaveController({ store, session: makeSession(), getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(), ...extra })
  }

  test('stays dirty when the trailing round that should write it fails', async () => {
    const store = createStore(createEmptyDocument('en-US'))
    store.update((d) => { d.prefs.autoSaveMin = 9 })
    const firstWrite = deferred<void>()
    fsMocks.writeFile
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(async () => { throw new Error('disk full') })
    const ctl = ctlFor(store, makeShell())

    const p = ctl.saveNow()
    await new Promise((r) => setTimeout(r, 0)) // round 1 parked inside writeFile
    store.update((d) => { d.prefs.autoSaveMin = 3 }) // after round 1's snapshot
    firstWrite.resolve()
    await p
    await ctl.flush()

    expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)
    expect(store.dirty).toBe(true)
  })

  test('is cleared once the trailing round lands, and the title shows unsaved in between', async () => {
    const store = createStore(createEmptyDocument('en-US'))
    store.update((d) => { d.prefs.autoSaveMin = 9 })
    const shell = makeShell()
    const setTitleSpy = vi.spyOn(shell, 'setTitle')
    const firstWrite = deferred<void>()
    fsMocks.writeFile.mockImplementationOnce(() => firstWrite.promise)
    const ctl = ctlFor(store, shell)

    const p = ctl.saveNow()
    await new Promise((r) => setTimeout(r, 0))
    store.update((d) => { d.prefs.autoSaveMin = 3 })
    firstWrite.resolve()
    await p
    await ctl.flush()

    expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)
    expect(store.dirty).toBe(false)
    expect(setTitleSpy.mock.calls.map((c) => c[1])).toEqual([true, false])
  })

  test('during the backup mirror write (after the primary write) also stays dirty until it is written', async () => {
    const store = createStore(createEmptyDocument('en-US'))
    store.update((d) => { d.prefs.autoSaveMin = 9 })
    const backupWrite = deferred<void>()
    const backupCtl = {
      maybeWriteBackup: vi.fn().mockImplementationOnce(() => backupWrite.promise).mockResolvedValue(undefined),
      currentHealth: vi.fn(async () => 'ok'),
    } as unknown as BackupController
    fsMocks.writeFile
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => { throw new Error('disk full') })
    const ctl = ctlFor(store, makeShell(), { backupCtl })

    const p = ctl.saveNow()
    await new Promise((r) => setTimeout(r, 0)) // primary written, parked in the backup mirror
    store.update((d) => { d.prefs.autoSaveMin = 3 })
    backupWrite.resolve()
    await p
    await ctl.flush()

    expect(store.dirty).toBe(true)
  })
})
```

Add `import type { BackupController } from '../src/core/backup-controller'` to the file's imports.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/save-controller.test.ts -t "while a save is in flight"`
Expected: FAIL. Test 1 and test 3 report `expected false to be true`. Test 2 reports title calls `[false, false]`.

- [ ] **Step 3: Implement**

In `doSave`, right after `deps.shell.setSaveState('saving')`, add:

```ts
    // What this round's bytes contain. An edit landing after this point is not
    // in them: the onMutate guard queues a trailing round for it, and only that
    // round may clear `dirty` (see the markSaved() below).
    const revAtSnapshot = deps.store.rev
```

Replace the line `deps.store.markSaved()` with:

```ts
    // Clearing `dirty` for bytes that predate an edit would leave that edit
    // unmarked if the trailing round queued for it then fails: no pill, no
    // close prompt, no beforeunload warning, and a tab handover would let it go.
    // Same guard as conflict-flow.ts's overwrite().
    if (deps.store.rev === revAtSnapshot) deps.store.markSaved()
```

Replace the last line of `doSave`, `deps.shell.setTitle(deps.session.name, false)`, with:

```ts
    deps.shell.setTitle(deps.session.name, deps.store.dirty)
```

- [ ] **Step 4: Run the whole save path and its neighbours**

Run: `npx vitest run test/save-controller.test.ts test/tab-lock.test.ts test/conflict-flow.test.ts test/change-password.test.ts test/backup-controller.test.ts`
Expected: PASS. `tab-lock` hands over only when the store is clean, so it now also relies on this.

- [ ] **Step 5: Full gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/core/save-controller.ts test/save-controller.test.ts
git commit -F - <<'EOF'
fix: an edit made during a save stays unsaved until it is actually written

doSave cleared dirty for bytes snapshotted before the edit; if the trailing
round then failed, the edit was on no disk with nothing marking it unsaved.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: A pane that goes empty disposes the module it held

**Files:**
- Modify: `src/ui/panes.ts` (`renderBody`, ~line 1131)
- Test: `test/lifecycle.test.ts`

**Interfaces:**
- Consumes: `disposeContainer(container)` from `src/modules/lifecycle.ts` (idempotent).
- Produces: no API change.

- [ ] **Step 1: Write the failing tests** (append to `test/lifecycle.test.ts`, reusing its `countingStore`, `stubMatchMedia`)

```ts
describe('a pane that stops showing a module disposes the one it held', () => {
  function mountRisks() {
    const { store, liveSubscriptions } = countingStore()
    document.body.innerHTML = ''
    stubMatchMedia()
    const shell = createShell('en-US')
    document.body.appendChild(shell.root)
    const pm = createPaneManager(shell, store, 'en-US')
    pm.registerModule('risks', renderRisks)
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'risks' } })
    expect(liveSubscriptions()).toBe(2) // risks + pm's own index subscription
    return { store, pm, liveSubscriptions }
  }

  test('when its history empties (e.g. the last team was deleted)', () => {
    const { store, pm, liveSubscriptions } = mountRisks()
    store.updateNav((d) => { d.nav.panes[0] = { history: [], index: -1 } })
    pm.renderAll()
    expect(liveSubscriptions()).toBe(1)
  })

  test('when it navigates to a kind with no registered renderer', () => {
    const { pm, liveSubscriptions } = mountRisks()
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'milestones' } }) // not registered here
    expect(liveSubscriptions()).toBe(1)
  })
})
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run test/lifecycle.test.ts -t "stops showing a module"`
Expected: FAIL, `expected 2 to be 1` in both.

- [ ] **Step 3: Implement.** In `renderBody`, insert this as the first statement after `const container = bodyEls[idx]`:

```ts
    // Tear the outgoing module down before its DOM goes, on every path: the
    // renderer's own withDisposal() only runs when there IS a renderer, so an
    // emptied pane (last team deleted) or an unregistered kind used to leave
    // the old instance subscribed to the store and listening on document.
    disposeContainer(container)
```

- [ ] **Step 4: Run neighbours**

Run: `npx vitest run test/lifecycle.test.ts test/panes.test.ts test/sidebar.test.ts test/render-counts.test.ts test/scope-freshness.test.ts`
Expected: PASS. `render-counts` pins how often modules render, and disposing first must not add renders.

- [ ] **Step 5: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/ui/panes.ts test/lifecycle.test.ts
git commit -F - <<'EOF'
fix: an emptied pane tears down the module it was showing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Printing keeps each `<select>`'s chosen value

**Files:**
- Modify: `src/ui/panes.ts` (`printPane`, ~line 998)
- Test: `test/panes.test.ts`

- [ ] **Step 1: Write the failing test** (append to `test/panes.test.ts` next to the other print tests; reuses `setup`, `addTeam`, `paneBtn`)

```ts
test('printing keeps every select at its current choice, not its first option', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.registerModule('risks', (container) => {
    for (const chosen of ['3', '2', '1']) {
      const s = document.createElement('select')
      for (const v of ['1', '2', '3']) s.appendChild(Object.assign(document.createElement('option'), { value: v, textContent: v }))
      s.value = chosen // a property, as the risks module sets it: no `selected` attribute to clone
      container.appendChild(s)
    }
  })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'risks' } })

  const bodyAppend = vi.fn()
  const fakeDoc = {
    write: vi.fn(), close: vi.fn(),
    head: { appendChild: vi.fn() },
    body: { append: bodyAppend },
    createElement: (tag: string) => document.createElement(tag),
  }
  vi.spyOn(window, 'open').mockReturnValue({ document: fakeDoc, focus: vi.fn(), print: vi.fn() } as unknown as Window)

  paneBtn(0, 'tt-pane-print-btn').click()

  const content = bodyAppend.mock.calls[0]![1] as HTMLElement
  expect(Array.from(content.querySelectorAll('select')).map((s) => s.value)).toEqual(['3', '2', '1'])
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run test/panes.test.ts -t "keeps every select"`
Expected: FAIL, received `['1','1','1']`.

- [ ] **Step 3: Implement.** In `printPane`, replace `content.appendChild(bodyEls[idx].cloneNode(true))` with:

```ts
    const clone = bodyEls[idx].cloneNode(true) as HTMLElement
    // cloneNode copies an <input>'s typed value but not a <select>'s current
    // choice: the clone falls back to each select's first option, so every
    // printed risk read chance 1 / impact 1 / "Mitigate". Copy the choice across
    // (same tree, so the two lists line up one to one).
    const liveSelects = bodyEls[idx].querySelectorAll('select')
    clone.querySelectorAll('select').forEach((s, i) => {
      s.selectedIndex = liveSelects[i]?.selectedIndex ?? s.selectedIndex
    })
    content.appendChild(clone)
```

(Checked in Chromium: the copied `selectedIndex` survives adoption into the `window.open` document.)

- [ ] **Step 4: Run** `npx vitest run test/panes.test.ts` → PASS.
- [ ] **Step 5: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/ui/panes.ts test/panes.test.ts
git commit -F - <<'EOF'
fix: printed panes keep each dropdown's chosen value

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Conflict-flow toasts reuse the save controller's keys

**Files:**
- Modify: `src/core/save-controller.ts` (export the two keys), `src/core/conflict-flow.ts` (`overwrite`)
- Test: `test/conflict-flow.test.ts`

**Interfaces:**
- Produces: `export const SAVE_PERMISSION_TOAST_KEY = 'save-permission'` and `export const SAVE_ERROR_TOAST_KEY = 'save-error'` from `src/core/save-controller.ts`.

- [ ] **Step 1: Failing assertions.** In `test/conflict-flow.test.ts`:
  - In `'a lapsed permission shows the permission state and a toast whose action re-requests access'`, after `expect(opts.sticky).toBe(true)`, add `expect(opts.key).toBe('save-permission')`.
  - In `'any other write failure shows the error state and a sticky toast, and stays dirty'`, add:

```ts
    const [, errOpts] = mocks.toast.mock.calls[0]!
    expect(errOpts.key).toBe('save-error')
```

- [ ] **Step 2: Run** `npx vitest run test/conflict-flow.test.ts` → FAIL (`undefined` vs the key).
- [ ] **Step 3: Implement.**
  - In `save-controller.ts`, change `const SAVE_PERMISSION_TOAST_KEY` to `export const SAVE_PERMISSION_TOAST_KEY`. Move `const SAVE_ERROR_TOAST_KEY = 'save-error'` (with its doc comment) up next to it and export it.
  - In `conflict-flow.ts`, add `import { SAVE_PERMISSION_TOAST_KEY, SAVE_ERROR_TOAST_KEY } from './save-controller'`.
  - In `overwrite()`, add `key: SAVE_PERMISSION_TOAST_KEY,` to the permission toast's options. Change the error toast to `toast(t(locale(), 'save_error_toast'), { sticky: true, key: SAVE_ERROR_TOAST_KEY })`.
  - Add a one-line comment above the permission toast: `// Keyed like save-controller.ts's own toast, so the next successful save dismisses it.`
  - (Importing save-controller is safe under this test file's mocks: it touches `dismissToast`, `writeFile` and friends only inside functions, never at module load.)
- [ ] **Step 4: Run** `npx vitest run test/conflict-flow.test.ts test/save-controller.test.ts` → PASS.
- [ ] **Step 5: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/core/save-controller.ts src/core/conflict-flow.ts test/conflict-flow.test.ts
git commit -F - <<'EOF'
fix: conflict-overwrite toasts clear once a later save succeeds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: `replaceDoc` fires `onMutate`

**Files:**
- Modify: `src/core/store.ts`, `src/ui/sidebar.ts` (comment ~805–809), `src/core/CLAUDE.md` (store line)
- Test: `test/store.test.ts`, `test/search-ui.test.ts`, `test/undo-toast.test.ts`, `test/save-controller.test.ts`, `test/sidebar.test.ts` (title only)

**Interfaces:**
- Produces: `store.onMutate` listeners receive `'content'` after `replaceDoc()`, fired after the `subscribe()` listeners, the same order as `update()`.

- [ ] **Step 1: Write the failing tests**

`test/store.test.ts`:

```ts
test('replaceDoc fires onMutate with "content", after subscribers', () => {
  const s = createStore(createEmptyDocument('en-US'))
  const order: string[] = []
  s.subscribe(() => order.push('subscribe'))
  s.onMutate((kind) => order.push(`mutate:${kind}`))
  s.replaceDoc(createEmptyDocument('en-US'))
  expect(order).toEqual(['subscribe', 'mutate:content'])
})
```

`test/search-ui.test.ts` (uses the file's `buildStore`, `mount`, `fakePM`, `oneNoteTeam`):

```ts
test('reloading a document that has teams over one that had none enables the search input', () => {
  const store = buildStore([], null)
  const { input } = mount(store, fakePM())
  expect(input.disabled).toBe(true)

  const reloaded = createEmptyDocument('en-US')
  reloaded.teams.push({ ...oneNoteTeam })
  store.replaceDoc(reloaded)

  expect(input.disabled).toBe(false)
})
```

(Add `import { createEmptyDocument } from '../src/core/document'` if the file lacks it.)

`test/undo-toast.test.ts`:

```ts
  it('a reload (replaceDoc) dismisses the undo toast, whose offer no longer applies', () => {
    const store = createStore(createEmptyDocument('en-US'))
    offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer())
    expect(actionButton()).not.toBeNull()
    store.replaceDoc(createEmptyDocument('en-US'))
    expect(actionButton()).toBeNull()
  })
```

`test/save-controller.test.ts` (Review Focus 2):

```ts
test('a reload (replaceDoc) during an in-flight save queues one trailing save and ends clean', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const firstWrite = deferred<void>()
  fsMocks.writeFile.mockImplementationOnce(() => firstWrite.promise)
  const onExternalChange = vi.fn()
  const ctl = createSaveController({ store, session: makeSession(), getPassword: () => 'pw', shell: makeShell(), locale: () => 'en-US', onExternalChange })

  const p = ctl.saveNow()
  await new Promise((r) => setTimeout(r, 0))
  store.replaceDoc(createEmptyDocument('en-US'))
  firstWrite.resolve()
  await p
  await ctl.flush()

  expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)
  expect(onExternalChange).not.toHaveBeenCalled()
  expect(store.dirty).toBe(false)
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/store.test.ts test/search-ui.test.ts test/undo-toast.test.ts test/save-controller.test.ts`
Expected: the store, search-ui, undo-toast and save-controller additions FAIL (no `mutate:content`; input still disabled; toast still there; 1 write).

- [ ] **Step 3: Implement**
  - In `store.ts`'s `replaceDoc`, after the subscribers loop, add `notifyMutate('content')`.
  - Change the `onMutate` doc comment's first sentence to: `Fires synchronously on EVERY mutation — update() and replaceDoc() as 'content', updateNav() as 'nav' — unlike subscribe(), which updateNav() intentionally bypasses (nav changes shouldn't trigger a full content re-render).`
  - In `sidebar.ts`, replace the paragraph starting `// Load-bearing detail: store.replaceDoc()…` with:

```ts
  // store.replaceDoc() (the conflict-modal reload) reaches both registrations,
  // as 'content' here, which this one ignores. The subscribe() render above is
  // what repaints the team list after a reload.
```

  - In `src/core/CLAUDE.md`, change `` `onMutate()` fires on both `` to `` `onMutate()` fires on all three (`replaceDoc` as 'content') ``.
  - In `test/sidebar.test.ts:145`, rename the test to `'store.replaceDoc (conflict-modal reload path) re-renders the sidebar'`.
  - In `test/undo-toast.test.ts:91`, replace the comment with `// An offer can expire while its toast is still up (any later mutation the toast was not told about). Silently doing nothing on click would leave the user thinking the restore worked.`
- [ ] **Step 4: Run neighbours.** `npx vitest run test/store.test.ts test/search-ui.test.ts test/undo-toast.test.ts test/save-controller.test.ts test/sidebar.test.ts test/sidebar-nav-render.test.ts test/undo-delete.test.ts test/search-nav-cache.test.ts test/search-incremental.test.ts test/tab-lock.test.ts test/conflict-flow.test.ts` → PASS.
- [ ] **Step 5: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/core/store.ts src/ui/sidebar.ts src/core/CLAUDE.md test/store.test.ts test/search-ui.test.ts test/undo-toast.test.ts test/save-controller.test.ts test/sidebar.test.ts
git commit -F - <<'EOF'
fix: reloading a document refreshes everything driven by store mutations

replaceDoc now fires onMutate('content'), so the search box, app-name button
and a pending undo toast follow a reload like any other content change.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: One day-rollover watcher for every view drawn against today

**Files:**
- Create: `src/ui/day-change.ts`, `test/day-change.test.ts`
- Modify: `src/modules/milestones.ts`, `src/ui/sidebar.ts`, `src/modules/action-items.ts`, `src/modules/daily-notes.ts`
- Test: `test/action-items.test.ts`, `test/daily-notes.test.ts` (milestones and sidebar keep their existing rollover tests: `milestones.test.ts:1297`, `sidebar.test.ts:663`)

**Interfaces:**
- Produces: `export function watchDayChange(onNewDay: () => void): () => void`

- [ ] **Step 1: Write the helper's tests** in `test/day-change.test.ts`

```ts
import { watchDayChange } from '../src/ui/day-change'

const visible = (): void => { document.dispatchEvent(new Event('visibilitychange')) }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 14, 23, 0))
})
afterEach(() => { vi.useRealTimers() })

test('fires when the tab becomes visible on a new calendar day', () => {
  const onNewDay = vi.fn()
  const stop = watchDayChange(onNewDay)
  vi.setSystemTime(new Date(2026, 9, 15, 8, 0))
  visible()
  expect(onNewDay).toHaveBeenCalledTimes(1)
  stop()
})

test('fires on window focus too', () => {
  const onNewDay = vi.fn()
  const stop = watchDayChange(onNewDay)
  vi.setSystemTime(new Date(2026, 9, 15, 8, 0))
  window.dispatchEvent(new Event('focus'))
  expect(onNewDay).toHaveBeenCalledTimes(1)
  stop()
})

test('does not fire on a return within the same day', () => {
  const onNewDay = vi.fn()
  const stop = watchDayChange(onNewDay)
  vi.setSystemTime(new Date(2026, 9, 14, 23, 59))
  visible()
  window.dispatchEvent(new Event('focus'))
  expect(onNewDay).not.toHaveBeenCalled()
  stop()
})

test('fires once per new day, not on every return that day', () => {
  const onNewDay = vi.fn()
  const stop = watchDayChange(onNewDay)
  vi.setSystemTime(new Date(2026, 9, 15, 8, 0))
  visible()
  window.dispatchEvent(new Event('focus'))
  expect(onNewDay).toHaveBeenCalledTimes(1)
  stop()
})

test('ignores the event that hides the tab', () => {
  const onNewDay = vi.fn()
  const stop = watchDayChange(onNewDay)
  vi.setSystemTime(new Date(2026, 9, 15, 8, 0))
  const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  visible()
  spy.mockRestore()
  expect(onNewDay).not.toHaveBeenCalled()
  stop()
})

test('the returned function removes both listeners', () => {
  const onNewDay = vi.fn()
  watchDayChange(onNewDay)()
  vi.setSystemTime(new Date(2026, 9, 15, 8, 0))
  visible()
  window.dispatchEvent(new Event('focus'))
  expect(onNewDay).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run** `npx vitest run test/day-change.test.ts` → FAIL (module not found).
- [ ] **Step 3: Create `src/ui/day-change.ts`**

```ts
// src/ui/day-change.ts — "the calendar day moved while this view sat idle".
// A window left open overnight fires no store change, so anything drawn
// against today (overdue colours, Today markers, due badges) kept showing
// yesterday until the next edit. The moment the user comes back to the window
// (tab made visible again, or the window refocused) is when that matters.
// Shared by every view that draws against today, so the next one does not
// grow its own copy.
import { todayIso } from '../core/i18n'

/** Calls `onNewDay` when the user returns to the window on a different calendar day than the last check. Returns the unbind function. */
export function watchDayChange(onNewDay: () => void): () => void {
  let day = todayIso()
  const onReturn = (): void => {
    if (document.visibilityState === 'hidden') return
    const now = todayIso()
    if (now === day) return
    day = now
    onNewDay()
  }
  document.addEventListener('visibilitychange', onReturn)
  window.addEventListener('focus', onReturn)
  return () => {
    document.removeEventListener('visibilitychange', onReturn)
    window.removeEventListener('focus', onReturn)
  }
}
```

- [ ] **Step 4: Run** `npx vitest run test/day-change.test.ts` → PASS.

- [ ] **Step 5: Write the failing module tests**

`test/action-items.test.ts`:

```ts
describe('calendar day rolling over while the board sits idle', () => {
  afterEach(() => { vi.useRealTimers() })

  function idleOvernight() {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 14, 23, 0))
    const ctx = setup(makeTeam({ actionItems: [item({ id: 'a', dueDate: '2026-10-14' })] }))
    render(ctx.container, ctx.loc, ctx.store, ctx.pm)
    const due = (): HTMLElement => ctx.container.querySelector<HTMLElement>('.tt-kanban-card-due')!
    expect(due().classList.contains('overdue')).toBe(false)
    vi.setSystemTime(new Date(2026, 9, 15, 8, 0))
    return { ...ctx, due }
  }

  test('a due pill turns overdue when the window is returned to on the next day', () => {
    const { due } = idleOvernight()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(due().classList.contains('overdue')).toBe(true)
  })

  test('a column rename being typed is left alone until it blurs', () => {
    const { container, due } = idleOvernight()
    ;(container.querySelector('.tt-kanban-col-name') as HTMLElement).click() // opens the rename input
    const input = container.querySelector<HTMLInputElement>('.tt-kanban-col-rename-input')!
    input.value = 'Half-typed'
    window.dispatchEvent(new Event('focus'))
    expect(input.isConnected).toBe(true)
    expect(input.value).toBe('Half-typed')
    // Back to the original name before leaving the field, so the blur commits
    // no rename: whatever rebuild follows comes from the deferred day change.
    input.value = 'WIP'
    input.dispatchEvent(new FocusEvent('blur'))
    expect(due().classList.contains('overdue')).toBe(true)
  })

  test('tearing the board down removes both listeners', () => {
    const { container, store, pm, loc } = idleOvernight()
    const docOff = vi.spyOn(document, 'removeEventListener')
    const winOff = vi.spyOn(window, 'removeEventListener')
    render(container, loc, store, pm)
    expect(docOff.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(true)
    expect(winOff.mock.calls.some(([type]) => type === 'focus')).toBe(true)
    docOff.mockRestore()
    winOff.mockRestore()
  })
})
```

`test/daily-notes.test.ts`:

```ts
describe('calendar day rolling over while the pane sits idle', () => {
  test('the calendar\'s today mark moves to the new day when the window is returned to', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 14, 23, 0))
    const { container, store, pm, loc } = setup(makeTeam(), '2026-10-14')
    render(container, loc, store, pm)
    const today = (): string | undefined => container.querySelector<HTMLElement>('.tt-calendar-day-today')?.dataset.date
    expect(today()).toBe('2026-10-14')

    vi.setSystemTime(new Date(2026, 9, 15, 8, 0))
    window.dispatchEvent(new Event('focus'))

    expect(today()).toBe('2026-10-15')
  })
})
```

- [ ] **Step 6: Run** `npx vitest run test/action-items.test.ts test/daily-notes.test.ts -t "rolling over"` → the overdue, deferred-rename and today-mark tests FAIL.

- [ ] **Step 7: Wire it in**
  - **milestones.ts:** add `import { watchDayChange } from '../ui/day-change'`. Delete `let renderedDay = todayIso()` and its comment, and the `renderedDay = todayIso()` line inside `renderAll()`. Replace the `onReturn` const and both `addEventListener` lines with:

```ts
  // A window left open overnight never fires a store change, so the Today
  // marker and overdue colours kept showing yesterday until the next edit. The
  // rebuild goes through `deferred` so it never steals a field being typed in.
  const stopDayWatch = watchDayChange(() => {
    const active = focusedCaretInput()
    if (active) deferred.arm(active)
    else renderAll()
  })
```

  In the teardown, replace the two `removeEventListener` lines with `stopDayWatch()`.

  - **sidebar.ts:** import `watchDayChange`. Replace the `onReturn` const and its two `addEventListener` lines with `const stopDayWatch = watchDayChange(() => renderNav())`, keeping the comment above it. In `dispose()`, replace the two `removeEventListener` lines for `onReturn` with `stopDayWatch()`.
  - **action-items.ts:** import `watchDayChange`. After `const deferredRebuild = createDeferredRebuild(renderAll)`, add:

```ts
  // Due pills are coloured against today; a board left open overnight gets no
  // store change to redraw them. Deferred like a foreign change while a column
  // rename is being typed.
  const stopDayWatch = watchDayChange(() => {
    const active = focusedRenameInput()
    if (active) deferredRebuild.arm(active)
    else renderAll()
  })
```

  Add `stopDayWatch()` to the teardown.

  - **daily-notes.ts:** import `watchDayChange`. After `rebuildCalendar()` (the call right after its definition), add:

```ts
  // The calendar marks today; a pane left open overnight gets no store change to move it.
  const stopDayWatch = watchDayChange(rebuildCalendar)
```

  Add `stopDayWatch()` to the teardown.

- [ ] **Step 8: Run neighbours.** `npx vitest run test/day-change.test.ts test/milestones.test.ts test/sidebar.test.ts test/sidebar-nav-render.test.ts test/action-items.test.ts test/daily-notes.test.ts test/lifecycle.test.ts` → PASS. The existing milestones and sidebar rollover tests (both `visibilitychange` and `focus`, "same day doesn't rebuild", "teardown removes listeners") are what show the migration preserved behaviour.
- [ ] **Step 9: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/ui/day-change.ts test/day-change.test.ts src/modules/milestones.ts src/ui/sidebar.ts src/modules/action-items.ts src/modules/daily-notes.ts test/action-items.test.ts test/daily-notes.test.ts
git commit -F - <<'EOF'
fix: kanban due pills and the daily calendar follow the day change

One watchDayChange helper now serves the sidebar, milestones, kanban and
daily calendar instead of per-module copies.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Ctrl+wheel font size, extracted and read-only safe

**Files:**
- Create: `src/ui/ctrl-wheel-font.ts`, `test/ctrl-wheel-font.test.ts`
- Modify: `src/main.ts` (remove the block from `// Ctrl+mouse-wheel steps the text-size preference` through `disposers.push(() => document.removeEventListener('wheel', onCtrlWheel, { capture: true }))`, and the now-unused `stepFontSize` import)

**Interfaces:**
- Produces: `export function installCtrlWheelFontSize(store: Store, shell: Pick<Shell, 'applyPrefs'>): () => void`

- [ ] **Step 1: Write the tests** (`test/ctrl-wheel-font.test.ts`). They pin current behaviour plus the read-only fix.

```ts
import { installCtrlWheelFontSize } from '../src/ui/ctrl-wheel-font'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { t } from '../src/core/i18n'

function wheel(deltaY: number, ctrlKey = true): WheelEvent {
  const e = new WheelEvent('wheel', { deltaY, ctrlKey, bubbles: true, cancelable: true })
  document.body.dispatchEvent(e)
  return e
}
const toastText = (): string | null => document.querySelector('.tt-toast')?.textContent ?? null

let store: Store
let dispose: () => void
const applyPrefs = vi.fn()

beforeEach(() => {
  store = createStore(createEmptyDocument('en-US')) // fontSize 'M', ctrlWheelFontSize true
  applyPrefs.mockReset()
  dispose = installCtrlWheelFontSize(store, { applyPrefs })
})
afterEach(() => {
  dispose()
  document.body.innerHTML = ''
})

test('one notch up grows the text one size, applies it and says so', () => {
  const e = wheel(-100)
  expect(e.defaultPrevented).toBe(true)
  expect(store.doc.prefs.fontSize).toBe('L')
  expect(applyPrefs).toHaveBeenCalledWith(store.doc.prefs)
  expect(toastText()).toBe(t('en-US', 'size_toast', { size: t('en-US', 'prefs_size_l') }))
})

test('small pinch deltas accumulate to one step instead of one step each', () => {
  wheel(-10); wheel(-10); wheel(-10)
  expect(store.doc.prefs.fontSize).toBe('M')
  wheel(-10)
  expect(store.doc.prefs.fontSize).toBe('L')
})

test('reversing direction restarts the accumulation', () => {
  wheel(-30)
  wheel(30)
  expect(store.doc.prefs.fontSize).toBe('M')
})

test('with the preference off the browser keeps the gesture', () => {
  store.update((d) => { d.prefs.ctrlWheelFontSize = false })
  const e = wheel(-100)
  expect(e.defaultPrevented).toBe(false)
  expect(store.doc.prefs.fontSize).toBe('M')
})

test('a wheel without Ctrl is untouched', () => {
  expect(wheel(-100, false).defaultPrevented).toBe(false)
})

test('at the largest size, further zoom-in changes nothing and toasts nothing', () => {
  store.update((d) => { d.prefs.fontSize = 'XL' })
  wheel(-100)
  expect(store.doc.prefs.fontSize).toBe('XL')
  expect(toastText()).toBeNull()
})

test('a read-only tab neither applies nor announces a size it could not save', () => {
  store.setReadOnly(true)
  wheel(-100)
  expect(store.doc.prefs.fontSize).toBe('M')
  expect(applyPrefs).not.toHaveBeenCalled()
  expect(toastText()).toBeNull()
})

test('the returned function stops listening', () => {
  dispose()
  expect(wheel(-100).defaultPrevented).toBe(false)
})
```

- [ ] **Step 2: Run** `npx vitest run test/ctrl-wheel-font.test.ts` → FAIL (module missing).
- [ ] **Step 3: Create `src/ui/ctrl-wheel-font.ts`**

```ts
// src/ui/ctrl-wheel-font.ts — Ctrl+mouse-wheel steps the text-size preference
// through its five stops, standing in for the browser's own page zoom, but
// only while `prefs.ctrlWheelFontSize` is on (prefs → General). Off, the event
// is left untouched and the browser zooms as usual. Capture phase +
// passive:false so preventDefault lands before any module's own wheel handler
// (daily-notes' edge-scroll) sees a Ctrl+wheel. Travel is accumulated to a
// threshold so a trackpad pinch (a burst of small ctrlKey wheel events)
// doesn't rip through all five sizes in one gesture. Lived inline in main.ts,
// where it could not be tested.
import type { Store } from '../core/store'
import type { Shell } from './shell'
import { stepFontSize } from '../core/font-size'
import { t } from '../core/i18n'
import { toast } from './modal'

const SIZE_LABEL_KEY = { XS: 'prefs_size_xs', S: 'prefs_size_s', M: 'prefs_size_m', L: 'prefs_size_l', XL: 'prefs_size_xl' } as const
const WHEEL_STEP_PX = 40
/** A pause longer than this starts a fresh gesture. */
const GESTURE_GAP_MS = 400

export function installCtrlWheelFontSize(store: Store, shell: Pick<Shell, 'applyPrefs'>): () => void {
  let accum = 0
  let lastDir: -1 | 1 = 1
  let lastAt = 0
  const onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey) return
    if (!store.doc.prefs.ctrlWheelFontSize) return // hand the gesture back to the browser
    e.preventDefault()
    e.stopPropagation()
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY
    if (px === 0) return
    const dir: -1 | 1 = px < 0 ? 1 : -1 // wheel up / pinch open = larger
    const now = Date.now()
    if (dir !== lastDir || now - lastAt > GESTURE_GAP_MS) accum = 0
    lastDir = dir
    lastAt = now
    accum += Math.abs(px)
    if (accum < WHEEL_STEP_PX) return
    accum = 0
    const next = stepFontSize(store.doc.prefs.fontSize, dir)
    if (next === store.doc.prefs.fontSize) return // already at the smallest/largest
    store.update((d) => { d.prefs.fontSize = next }, { sections: ['prefs'] })
    // A read-only tab's update is blocked (the store raises its own notice);
    // applying or announcing a size that never took would be a lie.
    if (store.doc.prefs.fontSize !== next) return
    shell.applyPrefs(store.doc.prefs)
    const lc = store.doc.prefs.locale
    toast(t(lc, 'size_toast', { size: t(lc, SIZE_LABEL_KEY[next]) }), { key: 'font-size' })
  }
  document.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => document.removeEventListener('wheel', onWheel, { capture: true })
}
```

- [ ] **Step 4: Swap it into main.ts.** Delete the block named in **Files**. In its place:

```ts
  disposers.push(installCtrlWheelFontSize(store, shell))
```

  Add `import { installCtrlWheelFontSize } from './ui/ctrl-wheel-font'` and remove `import { stepFontSize } from './core/font-size'`.
- [ ] **Step 5: Run** `npx vitest run test/ctrl-wheel-font.test.ts test/font-size.test.ts test/shell.test.ts test/prefs.test.ts` → PASS.
- [ ] **Step 6: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/ui/ctrl-wheel-font.ts test/ctrl-wheel-font.test.ts src/main.ts
git commit -F - <<'EOF'
fix: Ctrl+wheel in a read-only tab no longer announces a size it never set

Moved out of main.ts into a tested module.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: `createModuleEditor`, a single way every module mounts a notes editor

**Files:**
- Modify: `src/ui/rich-editor.ts` (add the wrapper; `createRichEditorBundle` stays as is)
- Modify: `src/modules/action-items.ts`, `risks.ts`, `milestones.ts`, `general-notes.ts`, `person-notes.ts`, `daily-notes.ts`
- Test: `test/rich-editor.test.ts`, `test/action-items.test.ts`, `test/risks.test.ts`, `test/milestones.test.ts`, `test/person-notes.test.ts`

**Interfaces:**
- Produces:

```ts
export function createModuleEditor(ctx: ModuleCtx, teamId: string, opts: {
  initialMd: string
  /** Receives the markdown with a whitespace-only body collapsed to ''. */
  onChange(md: string): void
  templateScopes: readonly Template['scope'][]
  /** The template `{date}`; defaults to today. Daily notes pass the note's own day. */
  templateDate?: () => string
  /** The template `{person}`; read live, so a rename is picked up. */
  personName?: () => string | undefined
}): RichEditorBundle
```

- [ ] **Step 1: Characterization tests (they must PASS before any module change).** These pin which templates each module offers today. A shared helper is defined in each file as needed:

```ts
function offeredTemplates(editor: HTMLElement): string[] {
  setBlockText(editor, '/')
  editor.dispatchEvent(new Event('input', { bubbles: true }))
  return Array.from(document.querySelectorAll('.tt-atref-item')).map((n) => n.textContent ?? '')
}
```

`test/action-items.test.ts`:

```ts
test('the card notes editor offers the "any"-scope templates only', () => {
  const { container, store, pm, loc } = setup(makeTeam({ actionItems: [item({ id: 'a', summary: 'Ship' })] }))
  render(container, loc, store, pm)
  cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  const editor = document.querySelector<HTMLElement>('.tt-modal-dialog .editor')!
  expect(offeredTemplates(editor)).toEqual(store.doc.templates.filter((tpl) => tpl.scope === 'any').map((tpl) => tpl.name))
})
```

`test/risks.test.ts`:

```ts
test('an expanded follow-up offers the "any"-scope templates only', () => {
  const { container, store, pm, loc } = setup(makeTeam({ risks: [risk({ id: 'r1', title: 'Vendor' })] }))
  render(container, loc, store, pm)
  container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()
  const editor = container.querySelector<HTMLElement>('.tt-risk-followup-row .editor')!
  expect(offeredTemplates(editor)).toEqual(store.doc.templates.filter((tpl) => tpl.scope === 'any').map((tpl) => tpl.name))
})
```

`test/milestones.test.ts`:

```ts
test('an expanded follow-up offers the "any"-scope templates only', () => {
  const { container, store, pm, loc } = setup(makeTeam({ milestones: [milestone({ id: 'm1', title: 'Beta' })] }))
  render(container, loc, store, pm)
  container.querySelector<HTMLButtonElement>('.tt-milestone-expand-btn')!.click()
  const editor = container.querySelector<HTMLElement>('.tt-milestone-followup-row .editor')!
  expect(offeredTemplates(editor)).toEqual(store.doc.templates.filter((tpl) => tpl.scope === 'any').map((tpl) => tpl.name))
})
```

`test/person-notes.test.ts` (one characterization test and one that should fail now):

```ts
const PERSON_LOC: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }

test('the notes editor offers the "personal" and "any" templates', () => {
  const { container, store, pm } = setup(makeTeam())
  render(container, PERSON_LOC, store, pm)
  expect(offeredTemplates(editorEl(container))).toEqual(store.doc.templates.filter((tpl) => tpl.scope === 'personal' || tpl.scope === 'any').map((tpl) => tpl.name))
})

test('a template\'s {person} uses the person\'s current name after a rename', () => {
  vi.useFakeTimers()
  const { container, store, pm } = setup(makeTeam())
  store.update((d) => { d.templates.push({ id: 'greet', name: 'Greet', scope: 'personal', body: 'Hi {person}' }) })
  render(container, PERSON_LOC, store, pm)
  store.update((d) => { d.teams[0]!.members[0]!.name = 'Bia' }, { teamId: 'T1' })

  offeredTemplates(editorEl(container))
  Array.from(document.querySelectorAll<HTMLElement>('.tt-atref-item')).find((n) => n.textContent === 'Greet')!.click()
  vi.advanceTimersByTime(500)

  expect(store.doc.teams[0]!.members[0]!.notes).toContain('Hi Bia')
  vi.useRealTimers()
})
```

- [ ] **Step 2: Run** `npx vitest run test/action-items.test.ts test/risks.test.ts test/milestones.test.ts test/person-notes.test.ts -t "templates|{person}"`
Expected: the four scope tests PASS (characterization). `{person}` FAILS with "Hi Bruno".

- [ ] **Step 3: Wrapper tests** (append to `test/rich-editor.test.ts`)

```ts
import { createModuleEditor } from '../src/ui/rich-editor'
import { createSearchIndex } from '../src/core/search'
import { formatDate } from '../src/core/i18n'
import type { ModuleCtx } from '../src/ui/panes'
import type { Store } from '../src/core/store'

describe('createModuleEditor', () => {
  function mount(opts: Partial<Parameters<typeof createModuleEditor>[2]> = {}) {
    const doc = createEmptyDocument('en-US')
    doc.teams.push(createEmptyTeam('t1', 'Alpha', '🙂', 'en-US'))
    doc.templates = [
      { id: 'a', name: 'AnyTpl', scope: 'any', body: 'T:{team} P:{person} D:{date}' },
      { id: 'd', name: 'DailyTpl', scope: 'daily', body: 'daily' },
      { id: 'p', name: 'PersonalTpl', scope: 'personal', body: 'personal' },
    ]
    const store: Store = createStore(doc)
    const ctx: ModuleCtx = {
      store, pm: fakePm(), paneIdx: 0, locale: 'en-US',
      searchIndex: createSearchIndex(() => store.doc, () => store.rev),
      saveStatus: { requestSaveNow: () => {}, subscribeSaveState: () => () => {} },
    }
    const onChange = vi.fn()
    const bundle = createModuleEditor(ctx, 't1', { initialMd: '', onChange, templateScopes: ['any'], ...opts })
    document.body.appendChild(bundle.editor.root)
    const editorEl = bundle.editor.root.querySelector('.editor') as HTMLElement
    return { store, bundle, editorEl, onChange }
  }
  const offered = (): string[] => Array.from(document.querySelectorAll('.tt-atref-item')).map((n) => n.textContent ?? '')
  function pick(editorEl: HTMLElement, name: string): void {
    setBlockText(editorEl, '/')
    fireInput(editorEl)
    Array.from(document.querySelectorAll<HTMLElement>('.tt-atref-item')).find((n) => n.textContent === name)!.click()
  }
  afterEach(() => { vi.useRealTimers() })

  test('offers only the requested scopes, in document order', () => {
    const { editorEl, bundle } = mount({ templateScopes: ['personal', 'any'] })
    setBlockText(editorEl, '/')
    fireInput(editorEl)
    expect(offered()).toEqual(['AnyTpl', 'PersonalTpl'])
    bundle.dispose()
  })

  test('fills {team} live and {person}/{date} from the overrides', () => {
    vi.useFakeTimers()
    const { store, editorEl, bundle } = mount({ templateDate: () => '2026-07-24', personName: () => 'Bia' })
    store.update((d) => { d.teams[0]!.name = 'Beta' })
    pick(editorEl, 'AnyTpl')
    vi.advanceTimersByTime(500)
    expect(bundle.editor.getMd()).toContain(`T:Beta P:Bia D:${formatDate('2026-07-24', 'en-US')}`)
    bundle.dispose()
  })

  test('{date} defaults to today', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 14, 10, 0))
    const { editorEl, bundle } = mount()
    pick(editorEl, 'AnyTpl')
    vi.advanceTimersByTime(500)
    expect(bundle.editor.getMd()).toContain(`D:${formatDate('2026-10-14', 'en-US')}`)
    bundle.dispose()
  })

  test('a whitespace-only body reaches onChange as an empty string', () => {
    vi.useFakeTimers()
    const { editorEl, onChange, bundle } = mount()
    setBlockText(editorEl, '   ')
    fireInput(editorEl)
    vi.advanceTimersByTime(500)
    expect(onChange).toHaveBeenLastCalledWith('')
    bundle.dispose()
  })
})
```

- [ ] **Step 4: Run** `npx vitest run test/rich-editor.test.ts` → FAIL (`createModuleEditor` not exported).
- [ ] **Step 5: Implement the wrapper** in `src/ui/rich-editor.ts`:
  - Update imports: `import type { PaneManager, ModuleCtx } from './panes'`, `import { todayIso, type Locale } from '../core/i18n'`, `import { findTeam } from '../core/document'`, `import { nowHHMM } from '../core/date'`.
  - Append:

```ts
/**
 * createRichEditorBundle the way every module renderer wants it: wired from
 * its ModuleCtx, offering `templateScopes`, filling the template context live
 * (team name, person, today or the note's own day), and collapsing a
 * whitespace-only body to '' (how every note field stores "empty").
 */
export function createModuleEditor(ctx: ModuleCtx, teamId: string, opts: {
  initialMd: string
  onChange(md: string): void
  templateScopes: readonly Template['scope'][]
  templateDate?: () => string
  personName?: () => string | undefined
}): RichEditorBundle {
  const team = (): Team | undefined => findTeam(ctx.store.doc, teamId)
  return createRichEditorBundle({
    store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: ctx.locale, teamId,
    initialMd: opts.initialMd,
    onChange: (md) => opts.onChange(md.trim() === '' ? '' : md),
    getTeam: team,
    getTemplates: () => ctx.store.doc.templates.filter((tpl) => opts.templateScopes.includes(tpl.scope)),
    getTemplateCtx: () => ({
      dateIso: opts.templateDate?.() ?? todayIso(),
      time: nowHHMM(ctx.locale),
      teamName: team()?.name,
      ...(opts.personName ? { personName: opts.personName() } : {}),
      locale: ctx.locale,
    }),
  })
}
```

- [ ] **Step 6: Migrate the six call sites**
  - **action-items.ts** (`openEditModal`):

```ts
    const richBundle = createModuleEditor(ctx, teamId, {
      initialMd: existing?.notes ?? '',
      templateScopes: ['any'],
      onChange: (md) => { patch((item) => { item.notes = md }, ['actions']) },
    })
```

  - **risks.ts** (`renderFollowupRow`): replace the `createRichEditorBundle({...})` call with:

```ts
    const bundle = createModuleEditor(ctx, teamId, {
      initialMd: r.followup,
      templateScopes: ['any'],
      onChange: (md) => {
        committingOwnFollowup = true
        try {
          patchTeamItem(ctx.store, teamId, 'risks', r.id, (found) => { found.followup = md }, { teamId, sections: ['risks'] })
        } finally {
          committingOwnFollowup = false
        }
      },
    })
```

  - **milestones.ts** (`renderFollowupRow`): same shape, with `'milestones'` for both the collection and the section, and `m` for `r`.
  - **general-notes.ts:**

```ts
  const bundle = createModuleEditor(ctx, teamId, {
    initialMd: findTeam()?.generalNotes ?? '',
    templateScopes: ['any'],
    onChange: (md) => {
      ctx.store.update((d) => {
        const tm = docFindTeam(d, teamId)
        if (tm) tm.generalNotes = md
      }, { teamId, sections: ['notes'] })
    },
  })
```

  - **person-notes.ts:** `templateScopes: ['personal', 'any']`, `personName: () => findPerson()?.name`, and an `onChange` that sets `p.notes = md` (keep its existing comment and scope).
  - **daily-notes.ts:** `templateScopes: ['daily', 'any']`, `templateDate: () => date`, and an `onChange` with `if (md === '') delete tm.dailyNotes[date]; else tm.dailyNotes[date] = md`.
  - Change each file's import from `createRichEditorBundle` to `createModuleEditor`.
  - Run `npm run lint`. Remove the imports it reports as unused (expected candidates: `nowHHMM` in all six; `todayIso` in general-notes, action-items, milestones; `Team` type in general-notes if `findTeam` goes; `docFindTeam` in risks/milestones if unused).
- [ ] **Step 7: Run** `npx vitest run test/rich-editor.test.ts test/action-items.test.ts test/risks.test.ts test/milestones.test.ts test/general-notes.test.ts test/person-notes.test.ts test/daily-notes.test.ts test/lifecycle.test.ts test/template-picker.test.ts` → PASS. That includes the Step 1 characterization tests and the now-passing `{person}` test.
- [ ] **Step 8: Full gate + e2e and commit**

```bash
npm run typecheck && npm run lint && npm test && npm run test:e2e
git add src/ui/rich-editor.ts src/modules test/rich-editor.test.ts test/action-items.test.ts test/risks.test.ts test/milestones.test.ts test/person-notes.test.ts
git commit -F - <<'EOF'
refactor: one createModuleEditor for every module's notes editor

Also fixes a person-notes template filling {person} with the name the
person had when the page was opened.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 9: General notes keeps its @mention labels live

**Files:**
- Modify: `src/modules/general-notes.ts`
- Test: `test/general-notes.test.ts`, `test/lifecycle.test.ts` (flip the `subscribes` flag)

- [ ] **Step 1: Write the failing tests** (`test/general-notes.test.ts`, inside `describe('renderGeneralNotes'`)

```ts
  test('renaming a milestone mentioned here live-updates its @mention chip in place', () => {
    const team = makeTeam({ generalNotes: 'See @[Old](milestone:m1) soon' })
    team.milestones.push({ id: 'm1', date: '2026-08-04', title: 'Old', done: false, followup: '' })
    const { container, store, pm } = setup(team)
    render(container, { teamId: 'T1', ref: { kind: 'general' } }, store, pm)
    const chip = container.querySelector<HTMLElement>('a.ref[data-ref="milestone:m1"]')!

    store.update((d) => { d.teams[0]!.milestones[0]!.title = 'New' }, { teamId: 'T1' })

    const after = container.querySelector<HTMLElement>('a.ref[data-ref="milestone:m1"]')!
    expect(after).toBe(chip)
    expect(after.textContent).toBe('@New')
  })

  test('its own keystrokes (notes-scoped) leave the editor DOM alone', () => {
    const team = makeTeam({ generalNotes: 'See @[Old](milestone:m1)' })
    team.milestones.push({ id: 'm1', date: '2026-08-04', title: 'Old', done: false, followup: '' })
    const { container, store, pm } = setup(team)
    render(container, { teamId: 'T1', ref: { kind: 'general' } }, store, pm)
    const editor = editorEl(container)
    const spy = vi.spyOn(editor, 'querySelectorAll')

    store.update((d) => { d.teams[0]!.generalNotes = 'typed' }, { teamId: 'T1', sections: ['notes'] })

    expect(spy).not.toHaveBeenCalled()
  })
```

  In `test/lifecycle.test.ts`, change the general-notes row to `subscribes: true` and delete the 3-line comment above it that explains why it doesn't subscribe.

- [ ] **Step 2: Run** `npx vitest run test/general-notes.test.ts test/lifecycle.test.ts` → the rename test FAILS (`@Old`) and the lifecycle general-notes case FAILS (0 subscriptions). The keystroke test passes now and must still pass after Step 3. The spy is a valid probe because `refreshRefLabels` (`src/ui/editor.ts:2306`) walks `editorEl.querySelectorAll('a.ref[data-ref]')` on exactly this `.editor` element.

- [ ] **Step 3: Implement** in `general-notes.ts`:
  - Add `import { scopeAffects, type Section } from '../core/scope'`.
  - After `const editor = bundle.editor`:

```ts
  // Mentions here show their target's *current* name, so patch the chips in
  // place when something they point at is renamed. The content itself is
  // never rebuilt from the store (caret safety; same rule as person-notes.ts).
  // 'notes' is deliberately not watched: this note's own keystrokes can't
  // rename anything.
  const LABEL_SOURCES: readonly Section[] = ['teams', 'people', 'actions', 'milestones', 'risks']
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (scopeAffects(scope, teamId, LABEL_SOURCES)) editor.refreshRefLabels()
  })
```

  - Teardown: `return () => { unsubscribe(); bundle.dispose() }`.
  - In the file header, delete the sentence claiming no live-update need.
- [ ] **Step 4: Run** `npx vitest run test/general-notes.test.ts test/lifecycle.test.ts test/render-counts.test.ts` → PASS.
- [ ] **Step 5: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/modules/general-notes.ts test/general-notes.test.ts test/lifecycle.test.ts
git commit -F - <<'EOF'
fix: general notes shows renamed people and items under their new name

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 10: `SaveStatusInfo.clickable`, so the pill's click rule lives in one place

**Files:**
- Modify: `src/ui/shell.ts` (`SaveStatusInfo`, `computeSaveInfo`, `renderSaveIndicator`), `src/modules/action-items.ts` (mini pill)
- Test: `test/shell.test.ts`, `test/action-items.test.ts`

**Interfaces:**
- Produces: `SaveStatusInfo` gains `clickable: boolean`.

- [ ] **Step 1: Write the failing test** (`test/shell.test.ts`, inside `describe('subscribeSaveState / requestSaveNow'`)

```ts
  test.each([
    ['saved', false], ['dirty', true], ['saving', false], ['error', true], ['permission', true],
    ['backup-error', false], ['backup-permission', true], ['backup-password-mismatch', true],
  ] as const)('state %s: pill clickable=%s, and subscribers are told the same', (state, clickable) => {
    const shell = setup()
    const seen: boolean[] = []
    shell.subscribeSaveState((info) => seen.push(info.clickable))
    shell.setSaveState(state)
    expect(shell.root.querySelector('.tt-save-pill')!.classList.contains('tt-save-pill-clickable')).toBe(clickable)
    expect(seen.at(-1)).toBe(clickable)
  })
```

  In `test/action-items.test.ts`, add `clickable` to every `fake.emit({...})` and to the `cb({ state: 'saved', … })` in `fakeSaveStatus`:
  - `'saved'` → `false`
  - `'dirty'` → `true`
  - `'backup-permission'` → `true`
  - `'backup-password-mismatch'` → `true`
  - `'backup-error'` → `false`

  Then add a test proving the mini pill follows the field rather than its own state list:

```ts
  test('the mini pill\'s clickable look follows info.clickable', () => {
    const { container, store, pm, loc } = setup(makeTeam({ actionItems: [item({ id: 'a' })] }))
    const fake = fakeSaveStatus()
    render(container, loc, store, pm, 0, fake.api)
    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('.tt-kanban-expand-btn')!.click()
    const pill = document.querySelector('.tt-save-pill')!
    fake.emit({ state: 'saved', label: 'x', title: 'x', clickable: true })
    expect(pill.classList.contains('tt-save-pill-clickable')).toBe(true)
  })
```

- [ ] **Step 2: Run** `npx vitest run test/shell.test.ts test/action-items.test.ts` → typecheck-level/test FAIL (`clickable` undefined; new mini-pill test fails).
- [ ] **Step 3: Implement**
  - In `shell.ts`, add to `SaveStatusInfo`: `/** Whether clicking the pill does anything in this state (save, re-grant, or rewrite the backup). */ clickable: boolean`.
  - Next to `SAVE_STATE_KEY`, add:

```ts
const CLICKABLE_STATES: ReadonlySet<SaveState> = new Set<SaveState>(['dirty', 'error', 'permission', 'backup-permission', 'backup-password-mismatch'])
```

  - `computeSaveInfo` returns `clickable: CLICKABLE_STATES.has(currentState)` alongside label and title.
  - In `renderSaveIndicator`, replace the multi-line `const clickable = …` with `const clickable = info.clickable`.
  - In `action-items.ts`, replace the `savePillMini.classList.toggle('tt-save-pill-clickable', …state list…)` with `savePillMini.classList.toggle('tt-save-pill-clickable', info.clickable)`.
- [ ] **Step 4: Run** `npx vitest run test/shell.test.ts test/action-items.test.ts` → PASS.
- [ ] **Step 5: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/ui/shell.ts src/modules/action-items.ts test/shell.test.ts test/action-items.test.ts
git commit -F - <<'EOF'
refactor: the save pill's clickable rule lives in shell.ts only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 11: `deleteInTeamWithUndo`, `nextOrder`, and `patchTeamItem` for the card modal

**Files:**
- Modify: `src/core/undo-delete.ts` (add the helper), `src/core/team-items.ts` (add `nextOrder`)
- Modify: `src/modules/entity-delete.ts`, `src/modules/people-tree.ts`, `src/modules/action-items.ts`, `src/modules/risks.ts`
- Test: `test/undo-delete.test.ts`, `test/team-items.test.ts`. The existing per-site deep-equal undo tests act as characterization.

**Interfaces:**
- Produces:

```ts
export function deleteInTeamWithUndo(store: Store, teamId: string, hasTarget: (team: Team) => boolean, remove: (team: Team) => void, scope: ChangeScope): UndoOffer | null
export function nextOrder(items: readonly { order: number }[]): number
```

- [ ] **Step 1: Check the characterization tests pass before touching code**

Run: `npx vitest run test/action-items.test.ts test/risks.test.ts test/people-tree.test.ts test/entity-delete.test.ts test/milestones.test.ts -t "undo|unlink"` → PASS. These deep-equal restore tests are the safety net for every rewritten delete site.

- [ ] **Step 2: Write the helper tests**

`test/undo-delete.test.ts`:

```ts
import { deleteInTeamWithUndo } from '../src/core/undo-delete'

describe('deleteInTeamWithUndo', () => {
  function storeWithTeam() {
    const doc = createEmptyDocument('en-US')
    const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
    team.risks.push({ id: 'r1', title: 'Vendor', chance: 1, impact: 1, plan: 'mitigate', followup: '', order: 0, closed: false })
    team.dailyNotes['2026-01-01'] = 'see @[Vendor](risk:r1)'
    doc.teams.push(team)
    return createStore(doc)
  }

  test('undo restores the whole team, including edits made outside the deleted collection', () => {
    const store = storeWithTeam()
    const before = structuredClone(store.doc.teams[0])
    const offer = deleteInTeamWithUndo(store, 't1', (tm) => tm.risks.length > 0, (tm) => {
      tm.risks = []
      tm.dailyNotes['2026-01-01'] = 'see ~Vendor~'
    }, { teamId: 't1' })
    expect(store.doc.teams[0]!.dailyNotes['2026-01-01']).toBe('see ~Vendor~')
    expect(offer!.undo()).toBe(true)
    expect(store.doc.teams[0]).toEqual(before)
  })

  test('no target: nothing cloned, nothing removed, no offer', () => {
    const store = storeWithTeam()
    const clone = vi.spyOn(globalThis, 'structuredClone')
    const remove = vi.fn()
    expect(deleteInTeamWithUndo(store, 't1', () => false, remove, { teamId: 't1' })).toBeNull()
    expect(clone).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    clone.mockRestore()
  })

  test('unknown team: no offer', () => {
    const store = storeWithTeam()
    expect(deleteInTeamWithUndo(store, 'nope', () => true, vi.fn(), { teamId: 'nope' })).toBeNull()
  })

  test('the delete and its undo are both written with the given scope', () => {
    const store = storeWithTeam()
    const scopes: unknown[] = []
    store.subscribe((s) => scopes.push(s))
    const offer = deleteInTeamWithUndo(store, 't1', () => true, (tm) => { tm.risks = [] }, { teamId: 't1', sections: ['risks'] })
    offer!.undo()
    expect(scopes).toEqual([{ teamId: 't1', sections: ['risks'] }, { teamId: 't1', sections: ['risks'] }])
  })
})
```

`test/team-items.test.ts`:

```ts
import { nextOrder } from '../src/core/team-items'

describe('nextOrder', () => {
  test('0 for an empty list', () => { expect(nextOrder([])).toBe(0) })
  test('past the highest value, not the count (deletes leave gaps)', () => {
    expect(nextOrder([{ order: 0 }, { order: 5 }])).toBe(6)
  })
})
```

- [ ] **Step 3: Run** `npx vitest run test/undo-delete.test.ts test/team-items.test.ts` → FAIL (exports missing).
- [ ] **Step 4: Implement the helpers**

`src/core/undo-delete.ts`. Add `import type { Team } from './types'` and `import { findTeam } from './document'`, then:

```ts
/**
 * deleteWithUndo for the common shape: a delete confined to one team, whose
 * capture is a deep copy of that whole team (see this file's header for why
 * nothing shallower is safe). `hasTarget` is asked first so a delete that
 * finds nothing never pays for the clone; `remove` then performs the delete on
 * the live team.
 */
export function deleteInTeamWithUndo(
  store: Store,
  teamId: string,
  hasTarget: (team: Team) => boolean,
  remove: (team: Team) => void,
  scope: ChangeScope,
): UndoOffer | null {
  return deleteWithUndo(store, (d) => {
    const team = findTeam(d, teamId)
    if (!team || !hasTarget(team)) return null
    const before = structuredClone(team)
    remove(team)
    return (d2) => {
      const i = d2.teams.findIndex((tm) => tm.id === teamId)
      if (i !== -1) d2.teams[i] = before
    }
  }, scope)
}
```

`src/core/team-items.ts`:

```ts
/** The `order` that sorts after every item in `items`: past the highest existing value, not the count, since deletes never renumber the survivors. */
export function nextOrder(items: readonly { order: number }[]): number {
  return items.reduce((max, i) => Math.max(max, i.order), -1) + 1
}
```

- [ ] **Step 5: Migrate the sites** (each keeps its existing comment about why the deep copy is needed)
  - **entity-delete.ts `remove`:**

```ts
    return deleteInTeamWithUndo(ctx.store, teamId,
      (tm) => listOf(tm).some((e) => e.id === id),
      (tm) => { dropFrom(tm, listOf(tm).find((e) => e.id === id)!) },
      { teamId })
```

  - **people-tree.ts** (delete confirm):

```ts
                const offer = deleteInTeamWithUndo(ctx.store, teamId,
                  (tm) => tm[group].some((p) => p.id === person.id),
                  (tm) => {
                    unlinkRefsInTeam(tm, 'person', new Map([[person.id, person.name]]))
                    tm[group] = deletePerson(tm[group], person.id)
                  },
                  { teamId })
```

  - **action-items.ts `clearZone`:**

```ts
        const offer = deleteInTeamWithUndo(ctx.store, teamId,
          (tm) => tm.actionItems.some((i) => i.status === status),
          (tm) => {
            const removedTitles = new Map(tm.actionItems.filter((i) => i.status === status).map((i) => [i.id, i.summary]))
            unlinkRefsInTeam(tm, 'action', removedTitles)
            tm.actionItems = tm.actionItems.filter((i) => i.status !== status)
          },
          { teamId })
```

  - **action-items.ts `deleteColumn`** (empty column):

```ts
      const offer = deleteInTeamWithUndo(ctx.store, teamId,
        (tm) => !!tm.actionColumns?.some((c) => c.id === columnId),
        (tm) => { tm.actionColumns = tm.actionColumns!.filter((c) => c.id !== columnId) },
        { teamId, sections: ['actions'] })
```

  - **action-items.ts `openDeleteColumnModal`** (landing):

```ts
        const offer = deleteInTeamWithUndo(ctx.store, teamId, () => true, (team2) => {
          const moving = team2.actionItems.filter((i) => i.status === columnId).sort((a, b) => a.order - b.order)
          let order = nextOrder(team2.actionItems.filter((i) => i.status === targetStatus))
          for (const i of moving) { i.status = targetStatus; i.order = order++ }
          if (team2.actionColumns) team2.actionColumns = team2.actionColumns.filter((c) => c.id !== columnId)
        }, { teamId, sections: ['actions'] })
```

  - **risks.ts `removeAllClosedRisks`:**

```ts
    return deleteInTeamWithUndo(ctx.store, teamId,
      (tm) => tm.risks.some((r) => r.closed),
      (tm) => {
        const titles = new Map(tm.risks.filter((r) => r.closed).map((r) => [r.id, r.title]))
        unlinkRefsInTeam(tm, 'risk', titles)
        tm.risks = tm.risks.filter((r) => !r.closed)
      },
      { teamId })
```

  - **nextOrder sites:**
    - action-items `addColumn`: `order: nextOrder(existing)`.
    - New card: `order: nextOrder(group)`.
    - risks `addRisk`: `order: nextOrder(tm.risks)`.
    - Delete the `maxOrder`/`nextOrder` locals these replace.
  - **action-items `patch`** inside `openEditModal`, replace its body with:

```ts
      patchTeamItem(ctx.store, teamId, 'actionItems', itemId, mutate, sections ? { teamId, sections } : { teamId })
```

  - Update imports: `deleteInTeamWithUndo` from `'../core/undo-delete'` (drop `deleteWithUndo` where unused); `nextOrder`/`patchTeamItem` from `'../core/team-items'`. Run `npm run lint` to catch leftovers.
- [ ] **Step 6: Run** `npx vitest run test/undo-delete.test.ts test/team-items.test.ts test/entity-delete.test.ts test/people-tree.test.ts test/action-items.test.ts test/risks.test.ts test/milestones.test.ts test/undo-toast.test.ts` → PASS.
- [ ] **Step 7: Full gate + e2e and commit**

```bash
npm run typecheck && npm run lint && npm test && npm run test:e2e
git add src/core/undo-delete.ts src/core/team-items.ts src/modules test/undo-delete.test.ts test/team-items.test.ts
git commit -F - <<'EOF'
refactor: one helper owns the team snapshot behind every delete undo

Also shares nextOrder and patchTeamItem with the kanban.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 12: `createModuleBacklinksChip`

**Files:**
- Modify: `src/ui/backlinks-panel.ts`, plus the 9 call sites in `action-items.ts`, `daily-notes.ts`, `person-notes.ts`, `risks.ts`, `milestones.ts`
- Test: `test/backlinks-panel.test.ts`

**Interfaces:**
- Produces: `export function createModuleBacklinksChip(ctx: ModuleCtx, teamId: string, kind: RefKind, id: string): HTMLElement | null`

- [ ] **Step 1: Write the failing test** (`test/backlinks-panel.test.ts`)

```ts
import { createModuleBacklinksChip } from '../src/ui/backlinks-panel'
import { createStore } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { createSearchIndex } from '../src/core/search'
import type { ModuleCtx, PaneManager } from '../src/ui/panes'

describe('createModuleBacklinksChip', () => {
  function ctxFor(note: string): ModuleCtx {
    const doc = createEmptyDocument('en-US')
    const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
    team.members.push({ id: 'p1', name: 'Ana', role: '', parentId: null, order: 0, notes: '' })
    team.dailyNotes['2026-01-01'] = note
    doc.teams.push(team)
    const store = createStore(doc)
    return {
      store, pm: {} as PaneManager, paneIdx: 0, locale: 'en-US',
      searchIndex: createSearchIndex(() => store.doc, () => store.rev),
      saveStatus: { requestSaveNow: () => {}, subscribeSaveState: () => () => {} },
    }
  }

  test('counts the target\'s backlinks from the shared index', () => {
    expect(createModuleBacklinksChip(ctxFor('met @[Ana](person:p1)'), 't1', 'person', 'p1')?.textContent).toBe('↩ 1')
  })

  test('null when nothing mentions it', () => {
    expect(createModuleBacklinksChip(ctxFor('nothing'), 't1', 'person', 'p1')).toBeNull()
  })
})
```

- [ ] **Step 2: Run** `npx vitest run test/backlinks-panel.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `backlinks-panel.ts`. Add `import type { ModuleCtx } from './panes'`, `import type { RefKind } from '../core/refs'`, `import { navigateToLoc } from './atref'`, then:

```ts
/** createBacklinksChip for a module renderer: `id`'s backlinks from the shared index, navigating the way every @mention click does. */
export function createModuleBacklinksChip(ctx: ModuleCtx, teamId: string, kind: RefKind, id: string): HTMLElement | null {
  return createBacklinksChip(ctx.searchIndex.backlinks(teamId, kind, id), ctx.locale, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
}
```

- [ ] **Step 4: Replace the 9 sites.** Each `createBacklinksChip(<backlinks>, lc, (loc, opts) => navigateToLoc(...))` becomes `createModuleBacklinksChip(ctx, teamId, <kind>, <id>)`. Kinds:
  - action-items: `'action'`, `item.id` and `id`
  - daily-notes: `'day'`, `date`
  - person-notes: `'person'`, `personId` (both sites; drop the now-unused `initialBacklinks` local)
  - risks: `'risk'`
  - milestones: `'milestone'`

  Drop the `const backlinks = …` locals that only fed the chip. Run `npm run lint` and remove the `createBacklinksChip`/`navigateToLoc` imports it flags.
- [ ] **Step 5: Run** `npx vitest run test/backlinks-panel.test.ts test/action-items.test.ts test/daily-notes.test.ts test/person-notes.test.ts test/risks.test.ts test/milestones.test.ts test/search-backlinks-perf.test.ts` → PASS.
- [ ] **Step 6: Gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/ui/backlinks-panel.ts src/modules test/backlinks-panel.test.ts
git commit -F - <<'EOF'
refactor: modules build backlink chips through one helper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 13: Shared follow-up row behaviour for risks and milestones

**Files:**
- Create: `src/modules/followup-list.ts`, `test/followup-list.test.ts`
- Modify: `src/modules/risks.ts`, `src/modules/milestones.ts`
- Test: also `test/risks.test.ts`, `test/milestones.test.ts` (two characterization tests)

**Interfaces:**
- Consumes: `createModuleEditor` (Task 8), `createModuleBacklinksChip` (Task 12), `patchTeamItem`, `ExpandableRowsController`.
- Produces:

```ts
export type FollowupPrefix = 'risk' | 'milestone'
export interface BlankTitleGuardOptions<T> { keepsRowOpen(active: Element): boolean; isDiscardable(item: T): boolean; discard(id: string): void }
export interface FollowupRows<T> {
  rowFor(id: string): HTMLElement | null
  showNameError(row: HTMLElement): void
  clearNameError(row: HTMLElement): void
  requireTitle(id: string): boolean
  toggleExpand(id: string): void
  followupEditorRow(item: T): HTMLElement
  isCommittingOwnFollowup(): boolean
  backlinksSlot(id: string): HTMLElement
  refreshBacklinkChips(): void
  wireRowKeys(row: HTMLElement, id: string, openMenu: (x: number, y: number) => void): void
  wireDblclickToggle(row: HTMLElement, id: string): void
  installBlankTitleGuard(row: HTMLElement, id: string, opts: BlankTitleGuardOptions<T>): void
  paintExpandAllBtn(btn: HTMLElement, ids: string[], collapseKey: MsgKey, expandKey: MsgKey): void
}
export function createFollowupRows<T extends Risk | Milestone>(cfg: {
  ctx: ModuleCtx; teamId: string; prefix: FollowupPrefix; listEl: HTMLElement
  expandable: ExpandableRowsController; nameRequired: string
  find(id: string): T | undefined; renderAll(): void
}): FollowupRows<T>
export function focusedCaretElement(container: HTMLElement, inputTypes: readonly string[]): HTMLElement | null
```

- [ ] **Step 1: Close the two characterization gaps** (both must PASS on the current code)

`test/risks.test.ts`, inside `describe('blank-name guard mirrors the action-item card'`:

```ts
    test('a double-click on a nameless row flags the name instead of opening the follow-up', () => {
      const { container, store, pm, loc } = setup(makeTeam({ risks: [risk({ id: 'r1', title: '' })] }))
      render(container, loc, store, pm)
      const row = container.querySelector('.tt-risk-row') as HTMLElement
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      expect(container.querySelector('.tt-risk-followup-row')).toBeNull()
      expect(row.querySelector('.tt-risk-name-error')).not.toBeNull()
      expect(document.activeElement).toBe(row.querySelector('.tt-risk-title-input'))
    })
```

`test/milestones.test.ts`, same describe:

```ts
    test('a double-click on a nameless row flags the name instead of opening the follow-up', () => {
      const { container, store, pm, loc } = setup(makeTeam({ milestones: [milestone({ id: 'a', title: '' })] }))
      render(container, loc, store, pm)
      const row = container.querySelector('.tt-milestone-row') as HTMLElement
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      expect(container.querySelector('.tt-milestone-followup-row')).toBeNull()
      expect(row.querySelector('.tt-milestone-name-error')).not.toBeNull()
      expect(document.activeElement).toBe(row.querySelector('.tt-milestone-title-input'))
    })
```

  Run `npx vitest run test/risks.test.ts test/milestones.test.ts` → PASS. Record the passing test count of both files; it must not drop after the refactor.

  Existing coverage this refactor leans on (all in both files unless noted):
  - blank-guard cases: add-button focus, sibling control, stray blur, row rebuilt mid-check, follow-up kept and flagged; date popover in milestones (627)
  - requireTitle via the expand button and expand-all
  - Enter/Space/Arrow keys and initial focus
  - dblclick toggles
  - backlink chip in-place patch (risks 2018/2035, milestones 1360/1377)
  - "moving from one follow-up editor to another after a commit" (committing flag; risks 1158, milestones 794)
  - search-focus expand

- [ ] **Step 2: Write the helper's unit tests** (`test/followup-list.test.ts`). They test the helper standalone, with prefix-derived markup.

```ts
import { createFollowupRows, focusedCaretElement } from '../src/modules/followup-list'
import { ExpandableRowsController } from '../src/ui/expandable-followup'
import { createStore } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { createSearchIndex } from '../src/core/search'
import type { ModuleCtx, PaneManager } from '../src/ui/panes'
import type { Risk } from '../src/core/types'

function risk(id: string, title: string): Risk {
  return { id, title, chance: 1, impact: 1, plan: 'mitigate', followup: '', order: 0, closed: false }
}

function mount(risks: Risk[]) {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  team.risks.push(...risks)
  doc.teams.push(team)
  const store = createStore(doc)
  const ctx: ModuleCtx = {
    store, pm: {} as PaneManager, paneIdx: 0, locale: 'en-US',
    searchIndex: createSearchIndex(() => store.doc, () => store.rev),
    saveStatus: { requestSaveNow: () => {}, subscribeSaveState: () => () => {} },
  }
  const listEl = document.body.appendChild(document.createElement('div'))
  const renderAll = vi.fn()
  const rows = createFollowupRows<Risk>({
    ctx, teamId: 't1', prefix: 'risk', listEl, expandable: new ExpandableRowsController(),
    nameRequired: 'Needs a name', find: (id) => store.doc.teams[0]!.risks.find((r) => r.id === id), renderAll,
  })
  for (const r of risks) {
    const row = document.createElement('div')
    row.className = 'tt-risk-row'
    row.tabIndex = 0
    row.setAttribute('data-risk-id', r.id)
    const title = document.createElement('input')
    title.className = 'tt-risk-title-input'
    row.append(title, rows.backlinksSlot(r.id))
    listEl.appendChild(row)
  }
  return { store, listEl, rows, renderAll }
}

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers() })

test('requireTitle passes a titled row, and flags + focuses an untitled one', () => {
  const { rows, listEl } = mount([risk('a', 'Vendor'), risk('b', '')])
  expect(rows.requireTitle('a')).toBe(true)
  expect(rows.requireTitle('b')).toBe(false)
  const row = rows.rowFor('b')!
  expect(row.querySelector('.tt-risk-name-error')?.textContent).toBe('Needs a name')
  expect(document.activeElement).toBe(row.querySelector('.tt-risk-title-input'))
  expect(listEl.querySelectorAll('.tt-risk-name-error')).toHaveLength(1)
})

test('arrow keys on a row move between rows; Space opens the menu at the row', () => {
  const { rows } = mount([risk('a', 'A'), risk('b', 'B')])
  const openMenu = vi.fn()
  rows.wireRowKeys(rows.rowFor('a')!, 'a', openMenu)
  rows.rowFor('a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(document.activeElement).toBe(rows.rowFor('b'))
  rows.rowFor('a')!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  expect(openMenu).toHaveBeenCalledTimes(1)
})

test('the blank-title guard discards a discardable draft once focus leaves the list', () => {
  vi.useFakeTimers()
  const { rows } = mount([risk('a', '')])
  const discard = vi.fn()
  rows.installBlankTitleGuard(rows.rowFor('a')!, 'a', { keepsRowOpen: () => false, isDiscardable: () => true, discard })
  const outside = document.body.appendChild(document.createElement('button'))
  outside.focus()
  rows.rowFor('a')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  vi.runAllTimers()
  expect(discard).toHaveBeenCalledWith('a')
})

test('the blank-title guard keeps the draft when the module says the focus target belongs to the list', () => {
  vi.useFakeTimers()
  const { rows } = mount([risk('a', '')])
  const discard = vi.fn()
  const addBtn = document.body.appendChild(document.createElement('button'))
  rows.installBlankTitleGuard(rows.rowFor('a')!, 'a', { keepsRowOpen: (el) => el === addBtn, isDiscardable: () => true, discard })
  addBtn.focus()
  rows.rowFor('a')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  vi.runAllTimers()
  expect(discard).not.toHaveBeenCalled()
})

test('refreshBacklinkChips swaps each slot for a chip once the row is mentioned', () => {
  const { rows, store } = mount([risk('a', 'Vendor')])
  expect(rows.rowFor('a')!.querySelector('.tt-backlinks-chip-slot')).not.toBeNull()
  store.update((d) => { d.teams[0]!.dailyNotes['2026-01-01'] = 'see @[Vendor](risk:a)' }, { teamId: 't1', sections: ['notes'] })
  rows.refreshBacklinkChips()
  expect(rows.rowFor('a')!.querySelector('.tt-backlinks-chip')?.textContent).toBe('↩ 1')
})

test('focusedCaretElement: only the listed input types and a contenteditable editor count', () => {
  const container = document.body.appendChild(document.createElement('div'))
  const text = container.appendChild(Object.assign(document.createElement('input'), { type: 'text' }))
  const box = container.appendChild(Object.assign(document.createElement('input'), { type: 'checkbox' }))
  text.focus()
  expect(focusedCaretElement(container, ['text'])).toBe(text)
  box.focus()
  expect(focusedCaretElement(container, ['text'])).toBeNull()
})
```

- [ ] **Step 3: Run** `npx vitest run test/followup-list.test.ts` → FAIL (module missing).
- [ ] **Step 4: Create `src/modules/followup-list.ts`**

```ts
// src/modules/followup-list.ts — the row behaviour risks.ts and milestones.ts
// share: a list of titled rows, each with an expandable rich follow-up
// editor. Both modules used to carry identical copies of every function here,
// so fixes (the focus-out race, the date-picker exemption) had to land twice.
// Only what is genuinely identical lives here; each module still owns its row
// markup, sort order, search-jump handling and subscribe policy.
//
// Everything is keyed off `prefix`, which both modules already use
// consistently in their markup: rows are `.tt-{prefix}-row[data-{prefix}-id]`,
// the title field `.tt-{prefix}-title-input`, the follow-up row
// `.tt-{prefix}-followup-row[data-{prefix}-followup-id]`; the @mention kind is
// `{prefix}` and the team collection (and scope section) `{prefix}s`.
import type { Milestone, Risk } from '../core/types'
import type { ModuleCtx } from '../ui/panes'
import type { ExpandableRowsController } from '../ui/expandable-followup'
import { t, type MsgKey } from '../core/i18n'
import { patchTeamItem } from '../core/team-items'
import { createModuleEditor } from '../ui/rich-editor'
import { createModuleBacklinksChip } from '../ui/backlinks-panel'
import { el, showRowError, clearRowError } from '../ui/dom'
import { icon } from '../ui/icons'

export type FollowupPrefix = 'risk' | 'milestone'

export interface BlankTitleGuardOptions<T> {
  /** Focus targets outside the list that still count as "not done with this row" (the add button, a date popover). */
  keepsRowOpen(active: Element): boolean
  /** An untitled row with nothing worth keeping, dropped silently; anything else is kept and flagged. */
  isDiscardable(item: T): boolean
  discard(id: string): void
}

export interface FollowupRowsConfig<T> {
  ctx: ModuleCtx
  teamId: string
  prefix: FollowupPrefix
  listEl: HTMLElement
  expandable: ExpandableRowsController
  /** Shown under a row whose required title is blank. */
  nameRequired: string
  /** The live item, re-read on every call (never a render-time snapshot). */
  find(id: string): T | undefined
  /** The owning module's full rebuild. */
  renderAll(): void
}

export interface FollowupRows<T> {
  rowFor(id: string): HTMLElement | null
  showNameError(row: HTMLElement): void
  clearNameError(row: HTMLElement): void
  requireTitle(id: string): boolean
  toggleExpand(id: string): void
  followupEditorRow(item: T): HTMLElement
  isCommittingOwnFollowup(): boolean
  backlinksSlot(id: string): HTMLElement
  refreshBacklinkChips(): void
  wireRowKeys(row: HTMLElement, id: string, openMenu: (x: number, y: number) => void): void
  wireDblclickToggle(row: HTMLElement, id: string): void
  installBlankTitleGuard(row: HTMLElement, id: string, opts: BlankTitleGuardOptions<T>): void
  paintExpandAllBtn(btn: HTMLElement, ids: string[], collapseKey: MsgKey, expandKey: MsgKey): void
}

export function createFollowupRows<T extends Risk | Milestone>(cfg: FollowupRowsConfig<T>): FollowupRows<T> {
  const { ctx, teamId, prefix, listEl, expandable } = cfg
  const rowClass = `tt-${prefix}-row`
  const idAttr = `data-${prefix}-id`
  const errorClass = `tt-${prefix}-name-error`
  const collection = prefix === 'risk' ? ('risks' as const) : ('milestones' as const)
  // True only while one of these rows' own follow-up editors is committing. A
  // follow-up's text appears nowhere in the row list, so the owning module's
  // subscriber skips its full rebuild for it, and with it the rebuild-on-blur
  // that detached the next follow-up editor being clicked into.
  let committingOwnFollowup = false

  function rowFor(id: string): HTMLElement | null {
    return listEl.querySelector<HTMLElement>(`.${rowClass}[${idAttr}="${id}"]`)
  }
  function showNameError(row: HTMLElement): void { showRowError(row, errorClass, cfg.nameRequired) }
  function clearNameError(row: HTMLElement): void { clearRowError(row, errorClass) }

  /** A follow-up is written under a title, as an action item's notes can't be saved without a name: a nameless row refuses, flags itself and puts the caret in the title. */
  function requireTitle(id: string): boolean {
    const cur = cfg.find(id)
    if (!cur || cur.title.trim() !== '') return true
    const row = rowFor(id)
    if (row) {
      showNameError(row)
      row.querySelector<HTMLInputElement>(`.tt-${prefix}-title-input`)?.focus()
    }
    return false
  }

  // Keyboard-driven (Enter on a focused row): land focus somewhere sane after
  // the rebuild, on the follow-up editor when expanding (so typing can start)
  // or back on the row when collapsing (so the arrows continue).
  function toggleExpand(id: string): void {
    const wasExpanded = expandable.isExpanded(id)
    if (!wasExpanded && !requireTitle(id)) return
    expandable.toggle(id)
    cfg.renderAll()
    if (wasExpanded) rowFor(id)?.focus()
    else listEl.querySelector<HTMLElement>(`[data-${prefix}-followup-id="${id}"] .editor`)?.focus()
  }

  /** The row's full rich editor, scoped to 'any' templates since a follow-up isn't tied to a person or a day. Registers with `expandable` so the module's disposeAll() tears it down. */
  function followupEditorRow(item: T): HTMLElement {
    const bundle = createModuleEditor(ctx, teamId, {
      initialMd: item.followup,
      templateScopes: ['any'],
      onChange: (md) => {
        committingOwnFollowup = true
        try {
          patchTeamItem(ctx.store, teamId, collection, item.id, (found) => { found.followup = md }, { teamId, sections: [collection] })
        } finally {
          committingOwnFollowup = false
        }
      },
    })
    expandable.register(item.id, bundle)
    return el('div', { class: `tt-${prefix}-followup-row`, [`data-${prefix}-followup-id`]: item.id, 'data-item-id': item.id }, bundle.editor.root)
  }

  // A fixed-width slot even when there's no chip: el() skips null children,
  // which would collapse the column on chip-less rows and misalign them.
  function backlinksSlot(id: string): HTMLElement {
    return createModuleBacklinksChip(ctx, teamId, prefix, id) ?? el('span', { class: 'tt-backlinks-chip-slot' })
  }

  /** Re-queries each row's backlinks and swaps its chip in place: for a change confined to sibling sections, which can only reach these rows through their chips. */
  function refreshBacklinkChips(): void {
    for (const row of listEl.querySelectorAll<HTMLElement>(`.${rowClass}`)) {
      const id = row.getAttribute(idAttr)
      if (id === null) continue
      const existing = row.querySelector('.tt-backlinks-chip, .tt-backlinks-chip-slot')
      if (!existing) continue
      existing.replaceWith(backlinksSlot(id))
    }
  }

  // Guarded on `e.target === row` throughout, so Enter inside the title input
  // still means "commit and blur" (blurOnEnter), Space inside a select still
  // opens it, and arrows inside a select still change its value. Only a
  // keypress on the row itself counts.
  function wireRowKeys(row: HTMLElement, id: string, openMenu: (x: number, y: number) => void): void {
    row.addEventListener('keydown', (ev) => {
      if (ev.target !== row) return
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        const rows = Array.from(listEl.querySelectorAll<HTMLElement>(`.${rowClass}`))
        const next = rows[rows.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1)]
        if (!next) return
        ev.preventDefault()
        next.focus()
        return
      }
      if (ev.key === 'Enter') {
        ev.preventDefault()
        toggleExpand(id)
        return
      }
      if (ev.key !== ' ') return
      // Keyboard equivalent of the right-click menu.
      ev.preventDefault()
      const rect = row.getBoundingClientRect()
      openMenu(rect.left + 16, rect.bottom)
    })
  }

  // Double-click any dead space on the row toggles the follow-up, a bigger
  // target than the caret. Skipped on the row's own controls (a field edit, a
  // word-select in the title, a button press).
  function wireDblclickToggle(row: HTMLElement, id: string): void {
    row.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('input, select, button, a')) return
      if (!expandable.isExpanded(id) && !requireTitle(id)) return
      expandable.toggle(id)
      cfg.renderAll()
    })
  }

  /**
   * Blank-name guard, the inline-row stand-in for action-items.ts's modal-close
   * behaviour: once focus has genuinely left the list with the title still
   * blank, a discardable draft is dropped silently and a row with real content
   * is kept with its missing name flagged.
   */
  function installBlankTitleGuard(row: HTMLElement, id: string, opts: BlankTitleGuardOptions<T>): void {
    row.addEventListener('focusout', () => {
      // Deferred a tick on purpose: clicking the row's own caret / close /
      // delete button, or any edit that re-renders the row, all resettle focus
      // within the tick, and a tabindex="-1" button doesn't reliably hold
      // focus. Judging synchronously (or off relatedTarget, which is null on
      // those in headless Chromium) would fire the guard on them.
      setTimeout(() => {
        // An edit inside the list defers a rebuild that flushes the instant
        // focus leaves, so this row may already have been replaced by a fresh
        // one that never had focus. Judge the live row by id; only a torn-down
        // module (listEl detached) or a vanished item ends the check.
        if (!listEl.isConnected) return
        const liveRow = row.isConnected ? row : rowFor(id)
        if (!liveRow) return
        const active = document.activeElement
        // Focus went nowhere real: a stray blur, not a deliberate move away.
        if (!active || active === document.body) return
        // Still inside the list (another row, the follow-up editor that just
        // opened) or on something the module counts as part of it.
        if (listEl.contains(active) || opts.keepsRowOpen(active)) return
        const cur = cfg.find(id)
        if (!cur) return
        if (cur.title.trim() !== '') { clearNameError(liveRow); return }
        if (opts.isDiscardable(cur)) opts.discard(id)
        else showNameError(liveRow)
      }, 0)
    })
  }

  /** "Expand all" unless every listed row is already expanded, then "Collapse all". */
  function paintExpandAllBtn(btn: HTMLElement, ids: string[], collapseKey: MsgKey, expandKey: MsgKey): void {
    const all = expandable.isAllExpanded(ids)
    btn.replaceChildren(icon(all ? 'chevUp' : 'chevDown', 12), t(ctx.locale, all ? collapseKey : expandKey))
  }

  return {
    rowFor, showNameError, clearNameError, requireTitle, toggleExpand,
    followupEditorRow, isCommittingOwnFollowup: () => committingOwnFollowup,
    backlinksSlot, refreshBacklinkChips, wireRowKeys, wireDblclickToggle,
    installBlankTitleGuard, paintExpandAllBtn,
  }
}

/**
 * The caret-sensitive element in `container` that currently holds focus, if
 * any: an <input> of one of `inputTypes`, or an expanded follow-up's
 * contenteditable `.editor`. A foreign store change defers its rebuild to this
 * element's blur instead of wiping an in-progress edit. Checkboxes and selects
 * have no caret to preserve, so they never count.
 */
export function focusedCaretElement(container: HTMLElement, inputTypes: readonly string[]): HTMLElement | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !container.contains(active)) return null
  if (active instanceof HTMLInputElement && inputTypes.includes(active.type)) return active
  if (active.classList.contains('editor') && active.isContentEditable) return active
  return null
}
```

- [ ] **Step 5: Run** `npx vitest run test/followup-list.test.ts` → PASS.

- [ ] **Step 6: Migrate risks.ts.** The controller is named `followups` (`rows` is already a local in the quadrant layout).
  1. Right after `const listEl = el('div', { class: 'tt-risk-list' })`, add:

```ts
  const followups = createFollowupRows<Risk>({
    ctx, teamId, prefix: 'risk', listEl, expandable,
    nameRequired: t(lc, 'risk_name_required'),
    find: (id) => risks().find((r) => r.id === id),
    renderAll,
  })
```

  (Functions declared earlier only run after mount, so referencing `followups` from them is safe.)

  2. Delete: `showNameError`, `clearNameError`, `let committingOwnFollowup`, `requireTitle`, `toggleExpand`, `renderFollowupRow`, `refreshBacklinkChips`, `updateExpandAllBtn`, `focusedCaretElement` (and the comment blocks directly attached to each).
  3. In `setClosed`, replace the `if (target && target.title.trim() === '') { … return }` block (and its `const target` line) with `if (!followups.requireTitle(id)) return`. Keep the comment above it.
  4. In `renderRow`:
     - `backlinksChip` = `followups.backlinksSlot(r.id)` (drop the `backlinks` local).
     - The expand button's `onclick` → `followups.toggleExpand(r.id)`.
     - Replace the `keydown` listener with `followups.wireRowKeys(row, r.id, (x, y) => openRowContextMenu(r.id, x, y))`.
     - Replace the `focusout` listener with:

```ts
    followups.installBlankTitleGuard(row, r.id, {
      // The add button is part of the list: pressing it would otherwise drop the
      // draft mid-click, collapsing the layout under the cursor.
      keepsRowOpen: (active) => active === addBtn,
      isDiscardable: (cur) => isUntitledRiskDiscardable(cur, newRiskFollowup()),
      discard: removeRiskSilently,
    })
```

     - Replace the open-row `dblclick` listener with `followups.wireDblclickToggle(row, r.id)`.
  5. In `renderAll`, replace `listEl.appendChild(renderFollowupRow(r))` with `listEl.appendChild(followups.followupEditorRow(r))`. Replace `updateExpandAllBtn(open)` with `followups.paintExpandAllBtn(expandAllBtn, open.map((r) => r.id), 'risk_collapse_all_btn', 'risk_expand_all_btn')`.
  6. In the subscriber:
     - `committingOwnFollowup` → `followups.isCommittingOwnFollowup()`
     - `refreshBacklinkChips()` → `followups.refreshBacklinkChips()` (both places)
     - `focusedCaretElement()` → `focusedCaretElement(container, ['text'])`
  7. `toggleExpand` callers elsewhere (closed rows use `expandable.toggle` directly; leave those). `focusRiskFromQuadrant` uses `listEl.querySelector(... .tt-risk-row)`: replace with `followups.rowFor(id)`.
  8. Update the header comment: `same disposer WeakMap, loc.teamId-keyed store.update helpers` → `the same loc.teamId-keyed store.update helpers`, and mention `followup-list.ts` for the shared row behaviour.
  9. Imports: add `import { createFollowupRows, focusedCaretElement } from './followup-list'`, then run `npm run lint` and drop what it flags as unused (expected: `showRowError`, `clearRowError`, `createModuleEditor`, `createModuleBacklinksChip`; `patchTeamItem` stays, because the chance/impact/plan selects still use it).

- [ ] **Step 7: Run** `npx vitest run test/risks.test.ts test/followup-list.test.ts` → PASS with at least the recorded count.

- [ ] **Step 8: Migrate milestones.ts** the same way:
  - `const followups = createFollowupRows<Milestone>({ ctx, teamId, prefix: 'milestone', listEl, expandable, nameRequired: t(lc, 'milestone_name_required'), find: (id) => milestones().find((m) => m.id === id), renderAll })`, right after `const listEl`.
  - Delete the same duplicated functions (including `focusedCaretInput`).
  - The done checkbox's nameless branch calls `followups.showNameError(row)`.
  - Blank guard:

```ts
    followups.installBlankTitleGuard(row, m.id, {
      // The add button is part of the list; and the date picker's calendar lives
      // in <body>, yet pressing a day moves focus onto it. Judged at that instant
      // the draft has no title and was dropped mid-pick, before the click landed.
      keepsRowOpen: (active) => active === addBtn || active.closest('.tt-date-picker-popover') !== null,
      isDiscardable: isBlankMilestoneDraft,
      discard: removeMilestoneSilently,
    })
```

  - `focusedCaretInput()` call sites (subscriber, day watch) → `focusedCaretElement(container, ['text', 'date'])`.
  - `paintExpandAllBtn(expandAllBtn, sorted.map((m) => m.id), 'milestone_collapse_all_btn', 'milestone_expand_all_btn')`.
  - Header comment: drop "a per-container disposer WeakMap".
- [ ] **Step 9: Run** `npx vitest run test/milestones.test.ts test/risks.test.ts test/followup-list.test.ts test/lifecycle.test.ts test/render-counts.test.ts test/search-expand-highlight.test.ts` → PASS with no drop in test counts.
- [ ] **Step 10: Full gate + e2e** (`e2e/hotpath.spec.ts` measures editor highlight passes with 30 expanded risks, so a regression in registering follow-up bundles would show there)

```bash
npm run typecheck && npm run lint && npm test && npm run test:e2e
```

- [ ] **Step 11: Commit**

```bash
git add src/modules/followup-list.ts test/followup-list.test.ts src/modules/risks.ts src/modules/milestones.ts test/risks.test.ts test/milestones.test.ts
git commit -F - <<'EOF'
refactor: risks and milestones share one follow-up row implementation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 14: Cosmetic cleanup

**Files:**
- Modify: `src/ui/panes.ts`, `src/main.ts`, 11 test files calling `createPaneManager`, `src/modules/action-items.ts`, `src/modules/milestones.ts`

- [ ] **Step 1: Make the edits**
  - panes.ts: rename the inner `function setFocusedPane(idx)` (line 592) to `focusPaneOnClick`, and update its only two callers, the capture-phase click listeners at lines 493–494. The exported `setFocusedPane(store, idx)` (line 263) keeps its name.
  - panes.ts: change the signature to `createPaneManager(shell: Shell, store: Store)` (drop `_locale`), then run:

```bash
grep -rl "createPaneManager(" src test | xargs sed -i -E 's/createPaneManager\(shell, store, [^)]*\)/createPaneManager(shell, store)/'
```

  - action-items.ts:
    - Delete the orphan doc comment `/** Items in \`status\`, sorted by \`order\`. */` (line 44).
    - Delete the `statusLabel` wrapper and its "Unused within Task 5" comment.
    - Replace its three calls (lines 788, 810, 822: `statusLabel(columnId, findTeam())`, `statusLabel(s, tm)`, `statusLabel(columnId, findTeam())`) with `actionStatusLabel(lc, columnId, findTeam())`, `actionStatusLabel(lc, s, tm)` and `actionStatusLabel(lc, columnId, findTeam())`.
  - milestones.ts: in `renderTimeline`, change "Truncated to 16 characters" to "Truncated by truncateTitle".
- [ ] **Step 2: Run** `npm run typecheck && npm run lint && npm test` → PASS.
- [ ] **Step 3: Commit**

```bash
git add -A src test
git commit -F - <<'EOF'
refactor: tidy pane-manager signature, stale comments and a wrapper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 15: Read-only tabs lock editing instead of accepting input they can't keep

**Why:** a tab without the cross-tab write lock blocks `store.update()`, but only the rich editors were made non-editable (`setEditorsReadOnly`). Text fields, selects, checkboxes, date pickers, the card modal's colour chips, drag-and-drop and quadrant dragging all still accepted input that was shown on screen and never saved.

**Approach:** one document-level capture-phase guard, armed only while the tab is visibly read-only. It stops the editing gestures before any module listener sees them (`preventDefault` + `stopPropagation` at document capture runs ahead of target listeners) and says why with a keyed toast. Navigation stays live: buttons, @mention chips, pane menus, the sidebar, the search box and the palette. Containers marked `data-readonly-exempt` are skipped: the search box, the palette input, and the password prompt, which must work while still read-only during a takeover reload.

**Files:**
- Create: `src/ui/readonly-lock.ts`, `test/readonly-lock.test.ts`
- Modify:
  - `src/main.ts`: `onReadOnlyChange` also calls `setReadOnlyLock`
  - `src/core/tab-lock.ts`: the blocked toast gets `key: READONLY_TOAST_KEY`
  - `src/ui/search-ui.ts`, `src/ui/palette.ts`, `src/ui/modal.ts` (`promptPassword` form): add `'data-readonly-exempt': ''`
  - `src/modules/risks.ts`: a quadrant drag is a tap while read-only
  - `styles.css`: not-allowed cursor
- Test: also `test/risks.test.ts`, `test/tab-lock.test.ts`

**Interfaces:**
- Produces: `export const READONLY_TOAST_KEY = 'readonly-blocked'` and `export function setReadOnlyLock(readOnly: boolean, locale: () => Locale): void` (idempotent; arming twice installs listeners once).

- [ ] **Step 1: Write the failing tests** (`test/readonly-lock.test.ts`)

```ts
import { setReadOnlyLock, READONLY_TOAST_KEY } from '../src/ui/readonly-lock'
import { t } from '../src/core/i18n'

const lc = (): 'en-US' => 'en-US'
const toasts = (): Element[] => Array.from(document.querySelectorAll(`.tt-toast[data-toast-key="${READONLY_TOAST_KEY}"]`))

function mountControls() {
  const pane = document.body.appendChild(document.createElement('div'))
  pane.innerHTML = `
    <input class="title" type="text">
    <textarea class="area"></textarea>
    <select class="sel"><option value="1">1</option><option value="2">2</option></select>
    <input class="box" type="checkbox">
    <div class="tt-date-picker"><input class="tt-date-picker-input" type="text"></div>
    <div class="tt-kanban-color-row"><button class="tt-kanban-color-chip" type="button"></button></div>
    <div class="card" draggable="true"></div>
    <button class="nav" type="button">nav</button>
    <div data-readonly-exempt><input class="search" type="text"></div>`
  return (sel: string) => pane.querySelector<HTMLElement>(sel)!
}
function fire(target: HTMLElement, ev: Event): Event { target.dispatchEvent(ev); return ev }
const beforeInput = (): InputEvent => new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'x' })

afterEach(() => {
  setReadOnlyLock(false, lc)
  document.body.innerHTML = ''
})

test('read-only: typing into a text field or textarea is refused', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  expect(fire($('.title'), beforeInput()).defaultPrevented).toBe(true)
  expect(fire($('.area'), beforeInput()).defaultPrevented).toBe(true)
})

test('read-only: a select can be neither opened nor changed from the keyboard; Tab still moves on', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  expect(fire($('.sel'), new MouseEvent('mousedown', { bubbles: true, cancelable: true })).defaultPrevented).toBe(true)
  expect(fire($('.sel'), new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })).defaultPrevented).toBe(true)
  expect(fire($('.sel'), new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })).defaultPrevented).toBe(false)
})

test('read-only: a checkbox does not toggle', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  ;($('.box') as HTMLInputElement).click()
  expect(($('.box') as HTMLInputElement).checked).toBe(false)
})

test('read-only: a date picker does not open and a card colour chip does not fire', () => {
  const $ = mountControls()
  const opened = vi.fn()
  const chip = vi.fn()
  $('.tt-date-picker-input').addEventListener('click', opened)
  $('.tt-kanban-color-chip').addEventListener('click', chip)
  setReadOnlyLock(true, lc)
  $('.tt-date-picker-input').click()
  $('.tt-kanban-color-chip').click()
  expect(opened).not.toHaveBeenCalled()
  expect(chip).not.toHaveBeenCalled()
})

test('read-only: nothing can be dragged', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  expect(fire($('.card'), new Event('dragstart', { bubbles: true, cancelable: true })).defaultPrevented).toBe(true)
})

test('read-only: navigation buttons and exempt fields keep working', () => {
  const $ = mountControls()
  const nav = vi.fn()
  $('.nav').addEventListener('click', nav)
  setReadOnlyLock(true, lc)
  $('.nav').click()
  expect(nav).toHaveBeenCalledTimes(1)
  expect(fire($('.search'), beforeInput()).defaultPrevented).toBe(false)
})

test('every refused attempt says why, as one toast that does not stack', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  fire($('.title'), beforeInput())
  fire($('.title'), beforeInput())
  ;($('.box') as HTMLInputElement).click()
  expect(toasts()).toHaveLength(1)
  expect(toasts()[0]!.textContent).toBe(t('en-US', 'readonly_blocked_toast'))
})

test('the root carries data-readonly while locked, for the not-allowed cursor', () => {
  setReadOnlyLock(true, lc)
  expect(document.documentElement.hasAttribute('data-readonly')).toBe(true)
  setReadOnlyLock(false, lc)
  expect(document.documentElement.hasAttribute('data-readonly')).toBe(false)
})

test('unlocking restores every gesture; arming twice then unlocking once leaves nothing behind', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  setReadOnlyLock(true, lc)
  setReadOnlyLock(false, lc)
  expect(fire($('.title'), beforeInput()).defaultPrevented).toBe(false)
  ;($('.box') as HTMLInputElement).click()
  expect(($('.box') as HTMLInputElement).checked).toBe(true)
})
```

`test/risks.test.ts`, inside `describe('drag to set chance/impact'`:

```ts
    test('in a read-only tab a drag does not move the dot or change anything, and still jumps to the row', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', title: 'Vendor', chance: 1, impact: 1 })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      store.setReadOnly(true)
      const { gx0, gy0, cell } = quadrantGeometry(container)
      const dot = container.querySelector('.tt-risk-quadrant-dot')!
      const before = dotTranslate(dot)

      dragQuadrantDot(dot, gx0 + 10, gy0 + 170, gx0 + 2 * cell + cell / 2, gy0 + cell / 2)

      expect(store.doc.teams[0]!.risks[0]!.chance).toBe(1)
      expect(dotTranslate(container.querySelector('.tt-risk-quadrant-dot')!)).toEqual(before)
      expect(document.activeElement).toBe(container.querySelector('[data-risk-id="a"].tt-risk-row'))
    })
```

`test/tab-lock.test.ts`: in the existing test that asserts the blocked-update toast (search for `readonly_blocked_toast` / `'Read-only'`), add an assertion that the toast options carry `key: 'readonly-blocked'`. If that test reads the real DOM, assert `document.querySelector('.tt-toast[data-toast-key="readonly-blocked"]')` is not null.

- [ ] **Step 2: Run** `npx vitest run test/readonly-lock.test.ts test/risks.test.ts test/tab-lock.test.ts` → FAIL (module missing; dot moved; toast unkeyed).

- [ ] **Step 3: Create `src/ui/readonly-lock.ts`**

```ts
// src/ui/readonly-lock.ts — while this tab is read-only (it lost, or never
// got, the cross-tab write lock; see core/tab-lock.ts), store.update() is
// blocked, so anything typed or toggled would show on screen and then be lost.
// The rich editors go non-editable on their own (ui/editor.ts's
// setEditorsReadOnly); this covers every other editing gesture with one
// document-level capture-phase guard: it runs before any module listener, so
// stopping the event there means no module ever sees it. Navigation (buttons,
// @mention chips, menus) is untouched. Containers marked data-readonly-exempt
// (the search box, the palette, the password prompt a takeover reload may
// raise while still read-only) keep working.
import { t, type Locale } from '../core/i18n'
import { toast } from './modal'

export const READONLY_TOAST_KEY = 'readonly-blocked'

/** Click targets that edit without being a form control. */
const EDITING_CLICK_TARGETS = '.tt-date-picker, .tt-kanban-color-row button'

let armed: { locale: () => Locale } | null = null

function refuse(e: Event): void {
  e.preventDefault()
  e.stopPropagation()
  if (armed) toast(t(armed.locale(), 'readonly_blocked_toast'), { key: READONLY_TOAST_KEY })
}

function lockedTarget(e: Event): Element | null {
  const target = e.target
  if (!(target instanceof Element) || target.closest('[data-readonly-exempt]')) return null
  return target
}

function onBeforeInput(e: Event): void {
  const target = lockedTarget(e)
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) refuse(e)
}

function onKeydown(e: KeyboardEvent): void {
  const target = lockedTarget(e)
  if (target instanceof HTMLSelectElement && e.key !== 'Tab' && e.key !== 'Escape') refuse(e)
}

function onMousedown(e: MouseEvent): void {
  const target = lockedTarget(e)
  if (target?.closest('select')) refuse(e)
}

function onClick(e: MouseEvent): void {
  const target = lockedTarget(e)
  if (!target) return
  if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) refuse(e)
  else if (target.closest(EDITING_CLICK_TARGETS)) refuse(e)
}

function onDragstart(e: DragEvent): void {
  if (lockedTarget(e)) refuse(e)
}

/** Arms (or lifts) the guard. Idempotent: arming twice installs the listeners once. */
export function setReadOnlyLock(readOnly: boolean, locale: () => Locale): void {
  document.documentElement.toggleAttribute('data-readonly', readOnly)
  if (readOnly) {
    if (armed) { armed.locale = locale; return }
    armed = { locale }
    document.addEventListener('beforeinput', onBeforeInput, true)
    document.addEventListener('keydown', onKeydown, true)
    document.addEventListener('mousedown', onMousedown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('dragstart', onDragstart, true)
    return
  }
  if (!armed) return
  armed = null
  document.removeEventListener('beforeinput', onBeforeInput, true)
  document.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('mousedown', onMousedown, true)
  document.removeEventListener('click', onClick, true)
  document.removeEventListener('dragstart', onDragstart, true)
}
```

- [ ] **Step 4: Wire it in**
  - `main.ts`: `import { setReadOnlyLock } from './ui/readonly-lock'`. Change the tab-lock dep to:

```ts
    onReadOnlyChange: (readOnly) => {
      setEditorsReadOnly(readOnly)
      setReadOnlyLock(readOnly, () => store.doc.prefs.locale)
    },
```

  (`releaseTabLock` already calls `onReadOnlyChange(false)` on close, so a closed file leaves no lock behind.)
  - `tab-lock.ts`: `import { READONLY_TOAST_KEY } from '../ui/readonly-lock'`, and the blocked toast becomes `toast(t(store.doc.prefs.locale, 'readonly_blocked_toast'), { key: READONLY_TOAST_KEY })`, so it and the guard's toast replace each other instead of stacking.
  - `search-ui.ts`: the `wrap` element gets `'data-readonly-exempt': ''`.
  - `palette.ts`: the palette input gets `'data-readonly-exempt': ''`.
  - `modal.ts` (`promptPassword`): the form gets `'data-readonly-exempt': ''`.
  - `risks.ts` (`wireQuadrantDrag`'s `pointermove`): right after `if (!quadrantDrag || quadrantDrag.id !== id) return`, add:

```ts
      // A read-only tab can't keep a new chance/impact: leave the dot put, so
      // the release is a plain tap (jump to the row) rather than a move that
      // would be thrown away.
      if (ctx.store.readOnly) return
```

  - `styles.css` (next to `.tt-readonly-banner`):

```css
/* Read-only tab (src/ui/readonly-lock.ts): editing controls say so on hover. */
:root[data-readonly] :is(input, select, textarea, .tt-date-picker, .tt-kanban-color-row button):not([data-readonly-exempt], [data-readonly-exempt] *) { cursor: not-allowed; }
```

- [ ] **Step 5: Run neighbours.** `npx vitest run test/readonly-lock.test.ts test/risks.test.ts test/tab-lock.test.ts test/search-ui.test.ts test/palette.test.ts test/modal.test.ts test/editor.test.ts` → PASS.
- [ ] **Step 6: Full gate + e2e and commit**

```bash
npm run typecheck && npm run lint && npm test && npm run test:e2e
git add src/ui/readonly-lock.ts test/readonly-lock.test.ts src/main.ts src/core/tab-lock.ts src/ui/search-ui.ts src/ui/palette.ts src/ui/modal.ts src/modules/risks.ts styles.css test/risks.test.ts test/tab-lock.test.ts
git commit -F - <<'EOF'
fix: a read-only tab locks editing instead of accepting input it can't save

Fields, dropdowns, checkboxes, date pickers, colour tags and drag-and-drop
now refuse input with the read-only notice; navigation stays live.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Not fixed, by decision

- **#17 panes free functions.** Deliberate API; churn only.
- **#19 single card-modal slot.** Unreachable (full-viewport scrim plus `blockedByModal`).
- **Unifying `moveCard`/`moveColumn`/`moveRisk`.** Their missing-target behaviour differs (append vs no-op), and each is pinned by tests.
- **Moving `todayIso` to `core/date.ts`.** 17 importers plus test mocks, cosmetic.
