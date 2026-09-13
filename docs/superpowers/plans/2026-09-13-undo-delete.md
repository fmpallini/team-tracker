# Undo-on-Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After any delete in Team Tracker, a ten-second toast offers one-click restoration of the exact pre-delete document state.

**Architecture:** A headless `deleteWithUndo()` wraps each delete in a single `store.update()`, capturing a deep copy of the affected team (or the detached team object, for team delete) and returning an `UndoOffer` guarded by `store.rev`. A thin `offerUndoToast()` renders that offer as an action button on the existing toast. No undo stack, no hotkey, no persistence.

**Tech Stack:** TypeScript (strict), vitest + jsdom for unit tests, Playwright for e2e, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-13-undo-delete-design.md`

## Global Constraints

- **Zero runtime dependencies.** Never add a package to `dependencies`. `structuredClone` is a platform global — do not reach for a clone library.
- **All user-visible strings go through `t(locale, key)`** in `src/core/i18n.ts`, and every new key must be added to **both** `pt-BR` and `en-US` dictionaries.
- **Every `src` module needs a matching `test/*.test.ts`.**
- Tests run under vitest globals — do **not** import `test`/`it`/`describe`/`expect`/`vi`; they are ambient.
- Run `npm run typecheck` and `npm run lint` before every commit. `tsconfig.json` is strict with `noUncheckedIndexedAccess`, so indexing an array yields `T | undefined` — narrow before use.
- Commit on `dev` directly. No feature branches, no worktrees.
- Do **not** touch `CHANGELOG.md` or `package.json` version. Changelog entries land with the release version bump, not with feature commits.
- End every commit message with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

**On the per-module test steps (Tasks 4-10):** each specifies exactly what to
assert but not literal test code, because every one of those test files
(`action-items.test.ts` is 110KB, `milestones.test.ts` 53KB) already has its
own mount/render/confirm helpers, and a test that ignores them will not run.
Read the target test file first, reuse its existing helpers, and write the
assertions this plan specifies. Tasks 1, 2, 3 and 11 carry complete,
copy-ready test code.

**The assertion that matters in every one of Tasks 4-10** is the same:
deep-equal the affected team (or `d.teams`) against a `structuredClone` taken
before the delete, after clicking Undo. That single comparison is what proves
the `unlinkRefsInTeam` rewrites were reversed — not just the entity removal.
A test that only checks the entity came back will pass against a broken
shallow capture.

---

### Task 1: Toast duration option

**Files:**
- Modify: `src/ui/modal.ts:387-397` (`ToastOptions`), `src/ui/modal.ts:444-446` (the auto-dismiss timer)
- Test: `test/modal.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ToastOptions.duration?: number` — milliseconds before auto-dismiss, default 4000. Ignored when `sticky` is true.

- [ ] **Step 1: Write the failing test**

Append to `test/modal.test.ts`:

```ts
describe('toast duration', () => {
  it('auto-dismisses after 4000ms by default', () => {
    vi.useFakeTimers()
    try {
      toast('default')
      vi.advanceTimersByTime(3999)
      expect(document.querySelectorAll('.tt-toast')).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(document.querySelectorAll('.tt-toast')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors an explicit duration', () => {
    vi.useFakeTimers()
    try {
      toast('slow', { duration: 10_000 })
      vi.advanceTimersByTime(4000)
      expect(document.querySelectorAll('.tt-toast')).toHaveLength(1)
      vi.advanceTimersByTime(6000)
      expect(document.querySelectorAll('.tt-toast')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores duration when sticky', () => {
    vi.useFakeTimers()
    try {
      toast('stays', { sticky: true, duration: 10 })
      vi.advanceTimersByTime(60_000)
      expect(document.querySelectorAll('.tt-toast')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
```

If `toast` is not already imported at the top of `test/modal.test.ts`, add it to the existing import from `../src/ui/modal`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/modal.test.ts`
Expected: the "honors an explicit duration" case FAILS — the toast is gone at 4000ms because `duration` is ignored. The other two pass against current behavior.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/modal.ts`, add the field to `ToastOptions` (after the `key` field):

```ts
  /**
   * Milliseconds on screen before auto-dismiss; defaults to
   * `DEFAULT_TOAST_MS`. Ignored when `sticky`. Undo toasts
   * (src/ui/undo-toast.ts) need noticeably longer than a status message:
   * four seconds is not enough time to register that a delete was a
   * mistake and reach for the button.
   */
  duration?: number
```

Add the constant next to `MAX_TOASTS`:

```ts
const DEFAULT_TOAST_MS = 4000
```

Replace the timer line:

```ts
  if (!opts?.sticky) {
    setTimeout(dismiss, opts?.duration ?? DEFAULT_TOAST_MS)
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/modal.test.ts && npm run typecheck && npm run lint`
Expected: all PASS, lint and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/modal.ts test/modal.test.ts
git commit -m "feat(ui): let a toast set its own on-screen duration

Undo toasts need noticeably longer than the hardcoded four seconds: that
is not enough time to register a delete was a mistake and reach for the
button. Defaults to the existing 4000ms, so no current caller changes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Core `deleteWithUndo`

**Files:**
- Create: `src/core/undo-delete.ts`
- Test: `test/undo-delete.test.ts`

**Interfaces:**
- Consumes: `Store` from `src/core/store.ts`, `Doc` from `src/core/types.ts`, `ChangeScope` from `src/core/scope.ts`.
- Produces:
  - `export interface UndoOffer { isAvailable(): boolean; undo(): boolean }`
  - `export function deleteWithUndo(store: Store, mutate: (d: Doc) => ((d: Doc) => void) | null, scope?: ChangeScope): UndoOffer | null`

  `mutate` runs inside one `store.update()`, performs the delete, and returns a restore closure — or `null` if it deleted nothing. `deleteWithUndo` returns `null` when the store is read-only or `mutate` returned `null`.

- [ ] **Step 1: Write the failing test**

Create `test/undo-delete.test.ts`:

```ts
import { deleteWithUndo } from '../src/core/undo-delete'
import { createStore } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc } from '../src/core/types'

function docWithTeam(): Doc {
  const d = createEmptyDocument('en-US')
  const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  team.risks.push({ id: 'r1', title: 'Slip', chance: 2, impact: 3, plan: 'mitigate', followup: '', order: 0, closed: false })
  team.risks.push({ id: 'r2', title: 'Cost', chance: 1, impact: 1, plan: 'accept', followup: '', order: 1, closed: false })
  d.teams.push(team)
  return d
}

/** Deletes risk r1 from team t1, capturing the whole team. */
function removeR1(d: Doc): ((d: Doc) => void) | null {
  const tm = d.teams.find((t) => t.id === 't1')
  if (!tm) return null
  const before = structuredClone(tm)
  tm.risks = tm.risks.filter((r) => r.id !== 'r1')
  return (d2) => {
    const i = d2.teams.findIndex((t) => t.id === 't1')
    if (i !== -1) d2.teams[i] = before
  }
}

describe('deleteWithUndo', () => {
  it('performs the delete and returns an offer', () => {
    const store = createStore(docWithTeam())
    const offer = deleteWithUndo(store, removeR1, { teamId: 't1' })
    expect(offer).not.toBeNull()
    expect(store.doc.teams[0]!.risks.map((r) => r.id)).toEqual(['r2'])
    expect(offer!.isAvailable()).toBe(true)
  })

  it('undo restores the document exactly', () => {
    const store = createStore(docWithTeam())
    const snapshot = structuredClone(store.doc)
    const offer = deleteWithUndo(store, removeR1, { teamId: 't1' })
    expect(offer!.undo()).toBe(true)
    expect(store.doc.teams).toEqual(snapshot.teams)
  })

  it('restores text the delete rewrote, not just the removed entity', () => {
    const store = createStore(docWithTeam())
    store.doc.teams[0]!.dailyNotes['2026-09-13'] = 'see @[Slip](risk:r1) today'
    const offer = deleteWithUndo(store, (d) => {
      const tm = d.teams.find((t) => t.id === 't1')
      if (!tm) return null
      const before = structuredClone(tm)
      // Stand-in for unlinkRefsInTeam: rewrites text in place on the team.
      tm.dailyNotes['2026-09-13'] = 'see ~Slip~ today'
      tm.risks = tm.risks.filter((r) => r.id !== 'r1')
      return (d2) => {
        const i = d2.teams.findIndex((t) => t.id === 't1')
        if (i !== -1) d2.teams[i] = before
      }
    }, { teamId: 't1' })
    offer!.undo()
    expect(store.doc.teams[0]!.dailyNotes['2026-09-13']).toBe('see @[Slip](risk:r1) today')
  })

  it('refuses to undo once another update has run', () => {
    const store = createStore(docWithTeam())
    const offer = deleteWithUndo(store, removeR1, { teamId: 't1' })
    store.update((d) => { d.teams[0]!.name = 'Renamed' })
    expect(offer!.isAvailable()).toBe(false)
    expect(offer!.undo()).toBe(false)
    expect(store.doc.teams[0]!.risks.map((r) => r.id)).toEqual(['r2'])
    expect(store.doc.teams[0]!.name).toBe('Renamed')
  })

  it('refuses to undo once updateNav has run', () => {
    const store = createStore(docWithTeam())
    const offer = deleteWithUndo(store, removeR1, { teamId: 't1' })
    store.updateNav((d) => { d.nav.sidebarCollapsed = true })
    expect(offer!.undo()).toBe(false)
  })

  it('refuses to undo once the document was replaced', () => {
    const store = createStore(docWithTeam())
    const offer = deleteWithUndo(store, removeR1, { teamId: 't1' })
    store.replaceDoc(docWithTeam())
    expect(offer!.isAvailable()).toBe(false)
    expect(offer!.undo()).toBe(false)
  })

  it('returns null and writes nothing on a read-only store', () => {
    const store = createStore(docWithTeam())
    store.setReadOnly(true)
    expect(deleteWithUndo(store, removeR1, { teamId: 't1' })).toBeNull()
    expect(store.doc.teams[0]!.risks.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('returns null when the mutate callback deleted nothing', () => {
    const store = createStore(docWithTeam())
    expect(deleteWithUndo(store, () => null, { teamId: 't1' })).toBeNull()
  })

  it('refuses to undo while the store is read-only', () => {
    const store = createStore(docWithTeam())
    const offer = deleteWithUndo(store, removeR1, { teamId: 't1' })
    store.setReadOnly(true)
    expect(offer!.isAvailable()).toBe(false)
    expect(offer!.undo()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/undo-delete.test.ts`
Expected: every case FAILS with a module-resolution error — `src/core/undo-delete.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/undo-delete.ts`:

```ts
// src/core/undo-delete.ts — one-level undo for deletions.
//
// Every delete in the app is permanent the moment its confirm dialog is
// accepted; the daily backup mirror can be 24h stale, so it is not an undo.
// This gives each delete a short window in which the exact pre-delete state
// can be put back.
//
// Capture-and-restore rather than a hand-written inverse operation,
// deliberately: a delete does not only remove an entity. Most call sites also
// run `unlinkRefsInTeam()` (see core/refs.ts), which rewrites every
// @[label](kind:id) mention of the deleted item into plain text IN PLACE
// across the whole team — daily notes, generalNotes, person notes, action
// notes and assignee, milestone and risk followups. Person-delete also
// re-parents the deleted node's children and renumbers their siblings'
// `order`. An inverse would have to recompute and reverse all of that;
// restoring a deep copy gets it right by construction.
import type { Doc } from './types'
import type { Store } from './store'
import type { ChangeScope } from './scope'

export interface UndoOffer {
  /** False once anything else has mutated the document, or the tab went read-only. */
  isAvailable(): boolean
  /** Restores the captured state. Returns false (and writes nothing) when unavailable. */
  undo(): boolean
}

/**
 * Runs `mutate` inside a single `store.update(fn, scope)` and returns an
 * offer to undo it.
 *
 * `mutate` captures whatever it needs, performs the delete, and returns a
 * closure that restores the capture — or `null` when it found nothing to
 * delete. Returns `null` when the update was blocked (read-only tab) or
 * `mutate` reported nothing deleted; callers then show a plain toast with no
 * action button.
 *
 * Staleness is guarded by `store.rev`, which is bumped by `update()`,
 * `updateNav()` AND `replaceDoc()` — so one comparison covers every way the
 * document can move on, a conflict-modal reload included. Restoring a capture
 * after some later edit would silently revert that edit; instead the offer
 * simply expires the moment the user does anything else.
 */
export function deleteWithUndo(
  store: Store,
  mutate: (d: Doc) => ((d: Doc) => void) | null,
  scope?: ChangeScope,
): UndoOffer | null {
  const revBefore = store.rev
  let restore: ((d: Doc) => void) | null = null
  store.update((d) => { restore = mutate(d) }, scope)
  // rev is unchanged when update() was blocked by read-only mode — it returns
  // silently rather than throwing, so this is the only way to detect it.
  if (store.rev === revBefore) return null
  const captured = restore as ((d: Doc) => void) | null
  if (!captured) return null
  const revAfter = store.rev

  const available = (): boolean => store.rev === revAfter && !store.readOnly

  return {
    isAvailable: available,
    undo(): boolean {
      if (!available()) return false
      store.update((d) => { captured(d) }, scope)
      return true
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/undo-delete.test.ts && npm run typecheck && npm run lint`
Expected: all PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/undo-delete.ts test/undo-delete.test.ts
git commit -m "feat(core): add deleteWithUndo for one-level delete restoration

Wraps a delete in a single store.update() and returns an offer to restore
the captured pre-delete state, guarded by store.rev so an undo can never
silently revert a later edit.

Capture-and-restore rather than hand-written inverses: most deletes also
rewrite @-mentions in place across the whole team via unlinkRefsInTeam,
and person-delete re-parents children and renumbers siblings. Restoring a
deep copy reverses all of that by construction.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Undo toast wiring

**Files:**
- Create: `src/ui/undo-toast.ts`
- Modify: `src/core/i18n.ts` (two new keys, both locales)
- Test: `test/undo-toast.test.ts`

**Interfaces:**
- Consumes: `UndoOffer`, `deleteWithUndo` from Task 2; `toast`, `dismissToast`, `ToastOptions.duration` from Task 1.
- Produces:
  - `export const UNDO_TOAST_MS = 10_000`
  - `export const UNDO_TOAST_KEY = 'undo-delete'`
  - `export function offerUndoToast(store: Store, locale: Locale, message: string, offer: UndoOffer | null): void`

- [ ] **Step 1: Write the failing test**

Create `test/undo-toast.test.ts`:

```ts
import { offerUndoToast, UNDO_TOAST_KEY } from '../src/ui/undo-toast'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { UndoOffer } from '../src/core/undo-delete'

function fakeOffer(over: Partial<UndoOffer> = {}): UndoOffer {
  return { isAvailable: () => true, undo: () => true, ...over }
}

function toasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.tt-toast'))
}

function actionButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('.tt-toast-action')
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('offerUndoToast', () => {
  it('shows a plain toast with no action when there is no offer', () => {
    const store = createStore(createEmptyDocument('en-US'))
    offerUndoToast(store, 'en-US', 'Risk deleted', null)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.textContent).toBe('Risk deleted')
    expect(actionButton()).toBeNull()
  })

  it('shows an Undo button when an offer is present', () => {
    const store = createStore(createEmptyDocument('en-US'))
    offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer())
    expect(actionButton()?.textContent).toBe('Undo')
    expect(toasts()[0]!.dataset.toastKey).toBe(UNDO_TOAST_KEY)
  })

  it('calls undo() when the button is clicked and confirms it', () => {
    const store = createStore(createEmptyDocument('en-US'))
    const undo = vi.fn(() => true)
    offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer({ undo }))
    actionButton()!.click()
    expect(undo).toHaveBeenCalledTimes(1)
    expect(toasts().some((n) => n.textContent === 'Restored')).toBe(true)
  })

  it('dismisses the toast as soon as anything else mutates the document', () => {
    const store = createStore(createEmptyDocument('en-US'))
    offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer())
    expect(toasts()).toHaveLength(1)
    store.update((d) => { d.prefs.dueSoonDays = 3 })
    expect(document.querySelector(`.tt-toast[data-toast-key="${UNDO_TOAST_KEY}"]`)).toBeNull()
  })

  it('stops listening after the button is clicked, so the undo itself does not re-fire teardown', () => {
    const store = createStore(createEmptyDocument('en-US'))
    const undo = vi.fn(() => { store.update((d) => { d.prefs.dueSoonDays = 9 }); return true })
    offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer({ undo }))
    actionButton()!.click()
    expect(undo).toHaveBeenCalledTimes(1)
    // The confirmation toast must survive the undo's own store.update().
    expect(toasts().some((n) => n.textContent === 'Restored')).toBe(true)
  })

  it('renders in pt-BR', () => {
    const store = createStore(createEmptyDocument('pt-BR'))
    offerUndoToast(store, 'pt-BR', 'Risco excluído', fakeOffer())
    expect(actionButton()?.textContent).toBe('Desfazer')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/undo-toast.test.ts`
Expected: every case FAILS — `src/ui/undo-toast.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Add to **both** dictionaries in `src/core/i18n.ts`. In the `pt-BR` dictionary, next to `risk_delete_btn` (around line 225):

```ts
  undo: 'Desfazer',
  undo_restored: 'Restaurado',
```

In the `en-US` dictionary, next to `risk_delete_btn` (around line 766):

```ts
  undo: 'Undo',
  undo_restored: 'Restored',
```

Create `src/ui/undo-toast.ts`:

```ts
// src/ui/undo-toast.ts — renders an UndoOffer (core/undo-delete.ts) as the
// action button on the toast that follows a delete.
//
// An in-toast button rather than a hotkey, deliberately: Alt+Left/Alt+Right is
// already per-pane navigation history and Ctrl+Z is already the rich editor's
// native undo. A button collides with neither, and it makes the offer's short
// lifetime visible instead of leaving the user to guess whether an undo is
// still available.
import type { Store } from '../core/store'
import type { UndoOffer } from '../core/undo-delete'
import { t, type Locale } from '../core/i18n'
import { toast, dismissToast } from './modal'

/**
 * Ten seconds rather than the 4000ms default: this toast is the only window
 * in which a delete can be taken back, so it has to outlast the moment of
 * realising the delete was a mistake.
 */
export const UNDO_TOAST_MS = 10_000

export const UNDO_TOAST_KEY = 'undo-delete'

/**
 * Shows `message`, adding an Undo button when `offer` is non-null.
 *
 * Also watches the store: the offer expires the instant anything else
 * mutates the document (see `deleteWithUndo`), so the toast is dismissed
 * then rather than left on screen with a button that would refuse to work.
 * `onMutate` covers `update()`/`updateNav()`; `replaceDoc()` does not fire it,
 * which is why `offer.undo()` re-checks `rev` itself as the real backstop.
 */
export function offerUndoToast(
  store: Store,
  locale: Locale,
  message: string,
  offer: UndoOffer | null,
): void {
  if (!offer) {
    toast(message)
    return
  }

  let unsubscribe: (() => void) | null = null
  const stopWatching = (): void => {
    unsubscribe?.()
    unsubscribe = null
  }

  toast(message, {
    key: UNDO_TOAST_KEY,
    duration: UNDO_TOAST_MS,
    action: {
      label: t(locale, 'undo'),
      onClick: () => {
        // Before offer.undo(), which itself calls store.update() and would
        // otherwise trip the watcher below and dismiss the confirmation toast
        // this is about to show.
        stopWatching()
        if (offer.undo()) toast(t(locale, 'undo_restored'))
      },
    },
  })

  unsubscribe = store.onMutate(() => {
    stopWatching()
    dismissToast(UNDO_TOAST_KEY)
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/undo-toast.test.ts test/i18n.test.ts && npm run typecheck && npm run lint`
Expected: all PASS. `test/i18n.test.ts` checks both dictionaries have the same key set — if it fails, a key was added to only one locale.

- [ ] **Step 5: Commit**

```bash
git add src/ui/undo-toast.ts test/undo-toast.test.ts src/core/i18n.ts
git commit -m "feat(ui): render an undo offer as a toast action button

An in-toast button rather than a hotkey: Alt+arrows is already pane
history and Ctrl+Z is already the editor's native undo. The toast is
dismissed as soon as anything else mutates the document, so a button that
would refuse to work never stays on screen.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Undo for risk delete

**Files:**
- Modify: `src/modules/risks.ts:348-362` (`removeRisk`), `src/modules/risks.ts:385-397` (`requestDelete`)
- Modify: `src/core/i18n.ts` (one new key, both locales)
- Test: `test/risks.test.ts`

**Interfaces:**
- Consumes: `deleteWithUndo` (Task 2), `offerUndoToast` (Task 3).
- Produces: `removeRisk(id: string): UndoOffer | null` — was `void`. The silent-delete path for empty-titled risks ignores the return value.

- [ ] **Step 1: Write the failing test**

Append to `test/risks.test.ts`. Match the file's existing setup helpers for mounting the module; the assertion that matters is the round trip:

```ts
describe('risk delete undo', () => {
  it('offers an undo toast that restores the risk and its @-mentions', () => {
    // Mount the risks module for a team with one risk and a daily note
    // mentioning it, following this file's existing render helper.
    const { store, teamId } = mountRisksWithMentionedRisk()

    const before = structuredClone(store.doc.teams.find((t) => t.id === teamId))

    clickDeleteAndConfirm('Slip')

    expect(store.doc.teams.find((t) => t.id === teamId)!.risks).toHaveLength(0)
    const undoBtn = document.querySelector<HTMLButtonElement>('.tt-toast-action')
    expect(undoBtn?.textContent).toBe('Undo')

    undoBtn!.click()

    expect(store.doc.teams.find((t) => t.id === teamId)).toEqual(before)
  })
})
```

Write `mountRisksWithMentionedRisk()` and `clickDeleteAndConfirm()` as local helpers in this describe block, reusing whatever mount/confirm helpers `test/risks.test.ts` already defines. The risk must start with a non-empty title (empty titles take the silent path) and the team must have a daily note containing `@[Slip](risk:<id>)` so the assertion proves the unlink was reversed too.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/risks.test.ts`
Expected: FAILS — no `.tt-toast-action` button exists after a delete.

- [ ] **Step 3: Write minimal implementation**

Add the i18n key to both dictionaries in `src/core/i18n.ts`, next to the `undo` key added in Task 3:

```ts
// pt-BR
  risk_deleted_toast: 'Risco "{title}" excluído',
// en-US
  risk_deleted_toast: 'Risk "{title}" deleted',
```

In `src/modules/risks.ts`, add the imports:

```ts
import { deleteWithUndo, type UndoOffer } from '../core/undo-delete'
import { offerUndoToast } from '../ui/undo-toast'
```

Replace `removeRisk` with:

```ts
  function removeRisk(id: string): UndoOffer | null {
    expandable.collapse(id) // local UI state; must flip before store.update fires the synchronous subscriber below
    return deleteWithUndo(ctx.store, (d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return null
      const removed = tm.risks.find((r) => r.id === id)
      if (!removed) return null
      // Deep, not a shallow copy of tm.risks: unlinkRefsInTeam below rewrites
      // @mentions in place on objects this team's other sections own, so a
      // shallow capture would restore the risk with every mention of it
      // permanently flattened.
      const before = structuredClone(tm)
      unlinkRefsInTeam(tm, 'risk', new Map([[id, removed.title]]))
      tm.risks = tm.risks.filter((r) => r.id !== id)
      return (d2) => {
        const i = d2.teams.findIndex((t2) => t2.id === teamId)
        if (i !== -1) d2.teams[i] = before
      }
      // No `sections`: unlinkRefsInTeam rewrites @mentions across every
      // content-bearing section of this team (notes, people, actions,
      // milestones — see refs.ts), not just 'risks'. Team-only scoping is
      // the narrowest scope that's still correct and won't rot if
      // unlinkRefsInTeam's reach changes later.
    }, { teamId })
  }
```

Replace `requestDelete`'s `onConfirm`:

```ts
      onConfirm: () => {
        const offer = removeRisk(r.id)
        offerUndoToast(ctx.store, lc, t(lc, 'risk_deleted_toast', { title: r.title }), offer)
      },
```

Leave the empty-title silent path (`removeRisk(r.id)` with no toast) as it is — an untitled risk carries nothing worth offering to restore.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/risks.test.ts test/i18n.test.ts && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/risks.ts test/risks.test.ts src/core/i18n.ts
git commit -m "feat(risks): offer undo after deleting a risk

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Undo for milestone delete

**Files:**
- Modify: `src/modules/milestones.ts:260-275` (`removeMilestone`), `src/modules/milestones.ts:277-288` (`requestDelete`)
- Modify: `src/core/i18n.ts`
- Test: `test/milestones.test.ts`

**Interfaces:**
- Consumes: `deleteWithUndo`, `offerUndoToast`.
- Produces: `removeMilestone(id: string): UndoOffer | null` — was `void`.

- [ ] **Step 1: Write the failing test**

Append to `test/milestones.test.ts`, mirroring Task 4's structure with this file's own mount helpers: mount a team with one titled milestone plus a daily note containing `@[Ship](milestone:<id>)`, delete it through the confirm dialog, assert an Undo button appears, click it, and assert the team deep-equals its pre-delete clone.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/milestones.test.ts`
Expected: FAILS — no `.tt-toast-action` button after delete.

- [ ] **Step 3: Write minimal implementation**

i18n, both locales:

```ts
// pt-BR
  milestone_deleted_toast: 'Marco "{title}" excluído',
// en-US
  milestone_deleted_toast: 'Milestone "{title}" deleted',
```

In `src/modules/milestones.ts`, add:

```ts
import { deleteWithUndo, type UndoOffer } from '../core/undo-delete'
import { offerUndoToast } from '../ui/undo-toast'
```

Replace `removeMilestone`:

```ts
  function removeMilestone(id: string): UndoOffer | null {
    expandable.collapse(id) // local UI state; must flip before store.update fires the synchronous subscriber below
    return deleteWithUndo(ctx.store, (d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return null
      const removed = tm.milestones.find((m) => m.id === id)
      if (!removed) return null
      // Deep copy: unlinkRefsInTeam rewrites @mentions in place across the
      // whole team, so a shallow capture of tm.milestones would restore the
      // milestone with every mention of it permanently flattened.
      const before = structuredClone(tm)
      unlinkRefsInTeam(tm, 'milestone', new Map([[id, removed.title]]))
      tm.milestones = tm.milestones.filter((m) => m.id !== id)
      return (d2) => {
        const i = d2.teams.findIndex((t2) => t2.id === teamId)
        if (i !== -1) d2.teams[i] = before
      }
      // No `sections`: unlinkRefsInTeam rewrites @mentions across every
      // content-bearing section of this team (notes, people, actions, risks
      // — see refs.ts), not just 'milestones'.
    }, { teamId })
  }
```

Replace `requestDelete`'s `onConfirm`:

```ts
      onConfirm: () => {
        const offer = removeMilestone(m.id)
        offerUndoToast(ctx.store, lc, t(lc, 'milestone_deleted_toast', { title: m.title }), offer)
      },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/milestones.test.ts test/i18n.test.ts && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/milestones.ts test/milestones.test.ts src/core/i18n.ts
git commit -m "feat(milestones): offer undo after deleting a milestone

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Undo for card delete and column clear

**Files:**
- Modify: `src/modules/action-items.ts:211-225` (`removeItem`), `:252-264` (`requestDelete`), `:266-287` (`clearZone`)
- Modify: `src/core/i18n.ts`
- Test: `test/action-items.test.ts`

**Interfaces:**
- Consumes: `deleteWithUndo`, `offerUndoToast`.
- Produces: `removeItem(id: string): UndoOffer | null` — was `void`.

- [ ] **Step 1: Write the failing test**

Append two cases to `test/action-items.test.ts` using this file's existing mount helpers:

1. Delete a single titled card through its confirm dialog; assert the Undo button appears, click it, assert the team deep-equals its pre-delete clone (seed a daily note with `@[Do it](action:<id>)` so the unlink reversal is covered).
2. Clear a zone holding two cards through its confirm dialog; assert Undo appears, click it, assert both cards are back with their original `status` and `order`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/action-items.test.ts`
Expected: both new cases FAIL — no `.tt-toast-action` button after either delete.

- [ ] **Step 3: Write minimal implementation**

i18n, both locales:

```ts
// pt-BR
  action_deleted_toast: 'Ação "{summary}" excluída',
  actions_deleted_toast: '{count} ações excluídas',
// en-US
  action_deleted_toast: 'Action "{summary}" deleted',
  actions_deleted_toast: '{count} actions deleted',
```

In `src/modules/action-items.ts`, add:

```ts
import { deleteWithUndo, type UndoOffer } from '../core/undo-delete'
import { offerUndoToast } from '../ui/undo-toast'
```

Replace `removeItem`:

```ts
  function removeItem(id: string): UndoOffer | null {
    return deleteWithUndo(ctx.store, (d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return null
      const removed = tm.actionItems.find((i) => i.id === id)
      if (!removed) return null
      // Deep copy: unlinkRefsInTeam rewrites @mentions in place across the
      // whole team, so a shallow capture of tm.actionItems would restore the
      // card with every mention of it permanently flattened.
      const before = structuredClone(tm)
      unlinkRefsInTeam(tm, 'action', new Map([[id, removed.summary]]))
      tm.actionItems = tm.actionItems.filter((i) => i.id !== id)
      return (d2) => {
        const i = d2.teams.findIndex((t2) => t2.id === teamId)
        if (i !== -1) d2.teams[i] = before
      }
      // No `sections`: unlinkRefsInTeam rewrites @mentions across every
      // content-bearing section of this team (notes, people, milestones,
      // risks — see refs.ts), not just 'actions'.
    }, { teamId })
  }
```

Replace `requestDelete`'s `onConfirm`:

```ts
      onConfirm: () => {
        const offer = removeItem(item.id)
        offerUndoToast(ctx.store, lc, t(lc, 'action_deleted_toast', { summary: item.summary }), offer)
      },
```

Replace `clearZone`'s `onConfirm`:

```ts
      onConfirm: () => {
        const offer = deleteWithUndo(ctx.store, (d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (!tm) return null
          const removedTitles = new Map(tm.actionItems.filter((i) => i.status === status).map((i) => [i.id, i.summary]))
          if (removedTitles.size === 0) return null
          // Deep copy — same unlinkRefsInTeam cross-section rationale as
          // removeItem() above.
          const before = structuredClone(tm)
          unlinkRefsInTeam(tm, 'action', removedTitles)
          tm.actionItems = tm.actionItems.filter((i) => i.status !== status)
          return (d2) => {
            const i = d2.teams.findIndex((t2) => t2.id === teamId)
            if (i !== -1) d2.teams[i] = before
          }
        }, { teamId })
        offerUndoToast(ctx.store, lc, t(lc, 'actions_deleted_toast', { count: String(count) }), offer)
      },
```

Leave the empty-summary silent path in `requestDelete` unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts test/i18n.test.ts && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/action-items.ts test/action-items.test.ts src/core/i18n.ts
git commit -m "feat(kanban): offer undo after deleting a card or clearing a column

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Undo for custom column delete

**Files:**
- Modify: `src/modules/action-items.ts:771-781` (`deleteColumn`), `:783-817` (`openDeleteColumnModal`)
- Modify: `src/core/i18n.ts`
- Test: `test/action-items.test.ts`

**Interfaces:**
- Consumes: `deleteWithUndo`, `offerUndoToast` (already imported by Task 6).
- Produces: nothing new.

This site does **not** call `unlinkRefsInTeam` — its cards are migrated to another status rather than deleted, so no mention can dangle. It still needs a deep copy, because the migration rewrites every moved card's `status` and `order` in place.

- [ ] **Step 1: Write the failing test**

Append two cases to `test/action-items.test.ts`:

1. Delete an **empty** custom column (the `count === 0` early-return path); assert Undo appears, click it, assert the column is back with its original `name` and `order`.
2. Delete a custom column holding two cards, choosing a landing column in the dialog; assert Undo appears, click it, assert the column is back **and** both cards have their original `status` and `order` again.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/action-items.test.ts`
Expected: both new cases FAIL — no `.tt-toast-action` button after either path.

- [ ] **Step 3: Write minimal implementation**

i18n, both locales:

```ts
// pt-BR
  column_deleted_toast: 'Coluna "{name}" excluída',
// en-US
  column_deleted_toast: 'Column "{name}" deleted',
```

Replace `deleteColumn`:

```ts
  function deleteColumn(columnId: string): void {
    const count = items().filter((i) => i.status === columnId).length
    if (count === 0) {
      const name = statusLabel(columnId, findTeam())
      const offer = deleteWithUndo(ctx.store, (d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm?.actionColumns) return null
        if (!tm.actionColumns.some((c) => c.id === columnId)) return null
        const before = structuredClone(tm)
        tm.actionColumns = tm.actionColumns.filter((c) => c.id !== columnId)
        return (d2) => {
          const i = d2.teams.findIndex((t2) => t2.id === teamId)
          if (i !== -1) d2.teams[i] = before
        }
      }, { teamId, sections: ['actions'] })
      offerUndoToast(ctx.store, lc, t(lc, 'column_deleted_toast', { name }), offer)
      return
    }
    openDeleteColumnModal(columnId, count)
  }
```

Replace `openDeleteColumnModal`'s `confirmBtn.onClick` body:

```ts
      onClick: () => {
        const targetStatus = select.value
        const name = statusLabel(columnId, findTeam())
        const offer = deleteWithUndo(ctx.store, (d) => {
          const team2 = d.teams.find((t2) => t2.id === teamId)
          if (!team2) return null
          // Deep copy before anything moves: the migration below rewrites
          // `status` and `order` in place on every card it moves, so a shallow
          // capture of actionColumns alone would restore the column but leave
          // its cards stranded in the landing column.
          const before = structuredClone(team2)
          const moving = team2.actionItems.filter((i) => i.status === columnId).sort((a, b) => a.order - b.order)
          const destGroup = team2.actionItems.filter((i) => i.status === targetStatus)
          // Appends past the destination's highest existing order — same
          // nextOrder idiom as openEditModal's new-card insertion above.
          // Doesn't renumber the destination group densely; any pre-existing
          // gaps in its order values are left untouched.
          let nextOrder = destGroup.length === 0 ? 0 : Math.max(...destGroup.map((i) => i.order)) + 1
          for (const i of moving) { i.status = targetStatus; i.order = nextOrder++ }
          if (team2.actionColumns) team2.actionColumns = team2.actionColumns.filter((c) => c.id !== columnId)
          return (d2) => {
            const i = d2.teams.findIndex((t2) => t2.id === teamId)
            if (i !== -1) d2.teams[i] = before
          }
        }, { teamId, sections: ['actions'] })
        offerUndoToast(ctx.store, lc, t(lc, 'column_deleted_toast', { name }), offer)
        handle.close()
      },
```

Note: `statusLabel(columnId, findTeam())` must be read **before** the delete runs, since the column it names is about to be removed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts test/i18n.test.ts && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/action-items.ts test/action-items.test.ts src/core/i18n.ts
git commit -m "feat(kanban): offer undo after deleting a custom column

Restores the column and, when its cards were migrated to a landing
column, their original status and order too.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Undo for person delete

**Files:**
- Modify: `src/modules/people-tree.ts:213-240` (the delete button's `onclick`)
- Modify: `src/core/i18n.ts`
- Test: `test/people-tree.test.ts`

**Interfaces:**
- Consumes: `deleteWithUndo`, `offerUndoToast`.
- Produces: nothing new.

`deletePerson()` (`src/modules/people-tree.ts:116`) re-parents the deleted node's children to its parent and renumbers every sibling's `order` **in place**. That is the strongest case in the codebase for capture-and-restore over an inverse.

- [ ] **Step 1: Write the failing test**

Append to `test/people-tree.test.ts`: build a team whose `members` contain a parent with two children and one following sibling, plus a daily note mentioning the parent as `@[Ann](person:<id>)`. Delete the parent through the confirm dialog, assert Undo appears, click it, and assert the team deep-equals its pre-delete clone — which proves the children's `parentId`, every sibling's `order`, and the unlinked mention all came back.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/people-tree.test.ts`
Expected: FAILS — no `.tt-toast-action` button after delete.

- [ ] **Step 3: Write minimal implementation**

i18n, both locales:

```ts
// pt-BR
  person_deleted_toast: '"{name}" excluído',
// en-US
  person_deleted_toast: '"{name}" deleted',
```

In `src/modules/people-tree.ts`, add:

```ts
import { deleteWithUndo } from '../core/undo-delete'
import { offerUndoToast } from '../ui/undo-toast'
```

Replace the `confirmDelete` call's `onConfirm`:

```ts
              onConfirm: () => {
                const offer = deleteWithUndo(ctx.store, (d) => {
                  const tm = d.teams.find((t2) => t2.id === teamId)
                  if (!tm) return null
                  if (!tm[group].some((p) => p.id === person.id)) return null
                  // Deep copy, for two reasons: unlinkRefsInTeam rewrites
                  // @mentions in place across the whole team, and
                  // deletePerson() re-parents this node's children and
                  // renumbers their siblings' `order` in place. A shallow
                  // capture of tm[group] would share those very objects and
                  // restore none of it.
                  const before = structuredClone(tm)
                  unlinkRefsInTeam(tm, 'person', new Map([[person.id, person.name]]))
                  tm[group] = deletePerson(tm[group], person.id)
                  return (d2) => {
                    const i = d2.teams.findIndex((t2) => t2.id === teamId)
                    if (i !== -1) d2.teams[i] = before
                  }
                  // No `sections`: unlinkRefsInTeam rewrites @mentions across
                  // every content-bearing section of this team (notes,
                  // actions, milestones, risks — see refs.ts), not just
                  // 'people'.
                }, { teamId })
                offerUndoToast(ctx.store, lc, t(lc, 'person_deleted_toast', { name: person.name }), offer)
              },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/people-tree.test.ts test/i18n.test.ts && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/people-tree.ts test/people-tree.test.ts src/core/i18n.ts
git commit -m "feat(people): offer undo after deleting a person

Restores the deleted node's children to their original parent and every
sibling's order, which deletePerson rewrites in place.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Undo for team delete

**Files:**
- Modify: `src/ui/sidebar.ts:405-470` (`deleteTeam`), `src/ui/sidebar.ts:617-627` (the confirm site in `openEditModal`)
- Modify: `src/core/i18n.ts`
- Test: `test/sidebar.test.ts`

**Interfaces:**
- Consumes: `deleteWithUndo`, `offerUndoToast`.
- Produces: `deleteTeam(teamId: string): UndoOffer | null` — was `void`.

This is the one site that needs **no** `structuredClone` of the team. It does not call `unlinkRefsInTeam` — refs never cross teams — so the spliced-out `Team` object is fully detached and holding a reference costs nothing. It does rewrite `nav` heavily (`activeTeamId`, `split`, `teamSplit`, and a two-pass prune of both panes' histories), so `nav` is cloned and restored alongside it.

- [ ] **Step 1: Write the failing test**

Append to `test/sidebar.test.ts`: render the sidebar for a document with two teams, delete the first through its edit modal's Delete button and the confirm dialog, assert Undo appears, click it, and assert both `store.doc.teams` and `store.doc.nav` deep-equal their pre-delete clones.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sidebar.test.ts`
Expected: FAILS — no `.tt-toast-action` button after delete.

- [ ] **Step 3: Write minimal implementation**

i18n, both locales:

```ts
// pt-BR
  team_deleted_toast: 'Time "{name}" excluído',
// en-US
  team_deleted_toast: 'Team "{name}" deleted',
```

In `src/ui/sidebar.ts`, add:

```ts
import { deleteWithUndo, type UndoOffer } from '../core/undo-delete'
import { offerUndoToast } from './undo-toast'
```

Change `deleteTeam`'s signature and wrap its existing body. The body between `const idx = ...` and the end of the pane resync is **unchanged** — only the wrapper and the capture/restore are new:

```ts
  function deleteTeam(teamId: string): UndoOffer | null {
    return deleteWithUndo(store, (d) => {
      const idx = d.teams.findIndex((tm) => tm.id === teamId)
      if (idx === -1) return null
      // No structuredClone of the team: deleteTeam doesn't unlink refs (refs
      // never cross teams — see refs.ts), so the spliced-out Team object is
      // fully detached the moment splice returns and holding a reference to
      // it costs nothing. `nav` is a different matter — everything below
      // rewrites activeTeamId, split, teamSplit and both panes' histories in
      // place — so that does get cloned.
      const removedTeam = d.teams[idx]!
      const navBefore = structuredClone(d.nav)

      /* ...existing body from `d.teams.splice(idx, 1)` through the end of the
         two-pass pane resync, completely unchanged... */

      return (d2) => {
        d2.teams.splice(idx, 0, removedTeam)
        d2.nav = navBefore
      }
    })
  }
```

Note the restore uses `splice(idx, 0, ...)` so the team returns to its original position in the sidebar, not the end.

Replace the confirm site's `onConfirm` in `openEditModal`:

```ts
          onConfirm: () => {
            const offer = deleteTeam(team.id)
            offerUndoToast(store, locale(), t(locale(), 'team_deleted_toast', { name: team.name }), offer)
          },
```

`deleteTeam` is called from nowhere else — confirm with `grep -n "deleteTeam(" src/ui/sidebar.ts` before changing the signature, and update any other caller the same way.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/sidebar.test.ts test/panes.test.ts test/nav.test.ts test/i18n.test.ts && npm run typecheck && npm run lint`
Expected: all PASS. `panes.test.ts` and `nav.test.ts` are included because this task touches pane history and nav.

- [ ] **Step 5: Commit**

```bash
git add src/ui/sidebar.ts test/sidebar.test.ts src/core/i18n.ts
git commit -m "feat(sidebar): offer undo after deleting a team

Restores the team at its original sidebar position along with the nav
state the delete rewrote — active team, split flag, and both panes'
pruned histories.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Undo for data cleanup

**Files:**
- Modify: `src/ui/prefs.ts:1204-1218` (the cleanup `confirmDelete` call)
- Test: `test/prefs.test.ts`

**Interfaces:**
- Consumes: `deleteWithUndo`, `offerUndoToast`.
- Produces: nothing new. Reuses the existing `data_cleanup_success_toast` key — no new i18n.

This is the most destructive action in the app: it purges done/cancelled cards, old done milestones, closed risks and old daily notes across **every** team, and calls `unlinkRefsInTeam` once per team. The capture is therefore the whole `teams` array.

- [ ] **Step 1: Write the failing test**

Append to `test/prefs.test.ts`: open the prefs data-cleanup flow against a document with two teams each holding purgeable content, confirm the cleanup, assert an Undo button appears, click it, and assert `store.doc.teams` deep-equals its pre-cleanup clone.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/prefs.test.ts`
Expected: FAILS — no `.tt-toast-action` button after cleanup.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/prefs.ts`, add:

```ts
import { deleteWithUndo } from '../core/undo-delete'
import { offerUndoToast } from './undo-toast'
```

Replace the cleanup `onConfirm`:

```ts
        onConfirm: () => {
          const offer = deleteWithUndo(store, (d) => {
            // The whole teams array: applyCleanup purges across every team and
            // calls unlinkRefsInTeam per team, rewriting @mentions in place in
            // each one. This is the single most destructive action in the app,
            // which is exactly why it is worth the copy.
            const before = structuredClone(d.teams)
            applyCleanup(d, days, today)
            return (d2) => { d2.teams = before }
          })
          offerUndoToast(store, locale, t(locale, 'data_cleanup_success_toast'), offer)
        },
```

The previous `toast(t(locale, 'data_cleanup_success_toast'))` line is replaced by `offerUndoToast` — delete it rather than leaving both.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/prefs.test.ts test/cleanup.test.ts && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/prefs.ts test/prefs.test.ts
git commit -m "feat(prefs): offer undo after a data cleanup

The most destructive action in the app purges across every team; this
makes it reversible for ten seconds.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: End-to-end round trip

**Files:**
- Create: `e2e/undo-delete.spec.ts`

**Interfaces:**
- Consumes: everything above. Verifies the real wiring in a real browser, which no jsdom test covers.

- [ ] **Step 1: Write the failing test**

Create `e2e/undo-delete.spec.ts`:

```ts
// e2e/undo-delete.spec.ts — proves the undo-on-delete wiring end to end in a
// real browser: the toast, its ten-second action button, and the restore
// actually putting a deleted team back into the sidebar with its content.
import { test, expect } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

test.describe('undo on delete', () => {
  const PASSWORD = 'e2e-undo-password'

  test('deleting a team offers an undo that puts it back', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    await page.getByRole('button', { name: /Create first team/ }).click()
    const createDialog = page.getByRole('dialog')
    await createDialog.locator('input[name="tt-team-name"]').fill('Doomed Team')
    await createDialog.getByRole('button', { name: 'OK' }).click()
    await expect(createDialog).toBeHidden()
    await expect(page.locator('.tt-team-item .tt-team-name')).toHaveText('Doomed Team')

    // Open the team's edit modal, then its Delete, then confirm.
    await page.locator('.tt-team-item').first().dblclick()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.tt-team-item')).toHaveCount(0)

    const undo = page.locator('.tt-toast-action')
    await expect(undo).toHaveText('Undo')
    await undo.click()

    await expect(page.locator('.tt-team-item .tt-team-name')).toHaveText('Doomed Team')
  })
})
```

If the team edit modal is not reached by double-clicking the sidebar row, read `src/ui/sidebar.ts` for the actual trigger and adjust that one line — the rest of the test is independent of it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:e2e -- e2e/undo-delete.spec.ts`
Expected: FAILS at `expect(undo).toHaveText('Undo')`.

Note: `npm run test:e2e` **builds first**. Running `npx playwright test` directly tests a stale `dist/` and will report confusing failures.

- [ ] **Step 3: No implementation needed**

Tasks 1-10 already provide the behavior. If this test fails, the bug is in one of them — fix it there, not here.

- [ ] **Step 4: Run the full suite**

Run: `npm run typecheck && npm run lint && npm test && npm run test:e2e`
Expected: all PASS. This is the full gate; every task above is in the tree by now.

- [ ] **Step 5: Commit**

```bash
git add e2e/undo-delete.spec.ts
git commit -m "test(e2e): cover the undo-on-delete round trip

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification checklist

Before declaring the plan complete:

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm test` — all pass, count increased by the new cases
- [ ] `npm run test:e2e` — all pass
- [ ] Every new i18n key exists in **both** `pt-BR` and `en-US` (`test/i18n.test.ts` enforces this)
- [ ] `CHANGELOG.md` untouched — its entry lands with the next version bump, listing "deleting a team, person, card, column, milestone, risk, or running a data cleanup can now be undone for ten seconds afterwards"
