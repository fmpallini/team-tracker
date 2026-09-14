# Undo for deletions

Design, 2026-09-13. Closes the "no way back from a delete" gap: today every
destructive action in Team Tracker is permanent the moment its confirm dialog
is accepted, and the only fallback is the daily backup mirror, which can be up
to 24 hours stale.

## Goal

After any delete, the user gets a short window in which one click puts the
document back exactly as it was.

## Scope

Deletions only, one level deep, offered through the toast that already follows
each delete. No undo stack, no persistence across sessions, no new hotkey.

**Non-goals**, deliberately:

- Undoing non-destructive edits (rename, reorder, drag, field changes). Those
  are recoverable by hand and would need a real op-log.
- Text editing. The browser's native `contenteditable` undo already handles
  typing, and `Ctrl+Z` must keep meaning that inside an editor.
- Redo.
- Surviving a reload, a file close, or a conflict resolution.

Restricting to deletes is what keeps this free of the two collisions that make
a general undo hard here: `Alt+Left`/`Alt+Right` is already per-pane navigation
history (persisted in `nav.panes[].history`), and `Ctrl+Z` is already the
editor's. An in-toast button collides with neither.

## The constraint that shapes the design

A delete is not just "remove from an array". Six of the eight sites also call
`unlinkRefsInTeam()` (`src/core/refs.ts:90`) — the five single/bulk item
deletes, plus data cleanup, which calls it once per team — and it rewrites every
`@[label](kind:id)` mention of the deleted item into plain `~Title~` text —
**in place, across the whole team**: every `dailyNotes` body, `generalNotes`,
every person's `notes`, every action item's `notes` and `assignee`, every
milestone's and risk's `followup`.

So capturing the containing array is not enough. A shallow copy shares the
surviving entity objects, whose text fields the unlink pass has already
rewritten; restoring that array would bring the item back with every mention
of it permanently flattened.

The capture unit therefore has to be whatever the delete can reach, captured
deeply enough that the rewritten strings are included.

## Architecture

Two new modules, matching the repo's existing split between headless logic and
DOM.

### `src/core/undo-delete.ts` — headless

```ts
export interface UndoOffer {
  /** False once anything else has mutated the document. */
  isAvailable(): boolean
  /** Restores the captured state. Returns false when no longer available. */
  undo(): boolean
}

export function deleteWithUndo(
  store: Store,
  mutate: (d: Doc) => ((d: Doc) => void) | null,
  scope?: ChangeScope,
): UndoOffer | null
```

`mutate` runs inside a single `store.update(fn, scope)`. It captures whatever
it needs, performs the delete, and returns a closure that restores the capture
— or `null` when it found nothing to delete.

`deleteWithUndo` returns `null` when the update was blocked (read-only tab) or
`mutate` reported nothing deleted; the caller then shows a plain toast with no
action button.

Implementation shape:

```ts
const revBefore = store.rev
let restore: ((d: Doc) => void) | null = null
store.update((d) => { restore = mutate(d) }, scope)
if (store.rev === revBefore || !restore) return null
const revAfter = store.rev
return {
  isAvailable: () => store.rev === revAfter && !store.readOnly,
  undo() {
    if (store.rev !== revAfter || store.readOnly) return false
    store.update((d) => restore(d), scope)
    return true
  },
}
```

### `src/ui/undo-toast.ts` — DOM

```ts
export const UNDO_TOAST_MS = 10_000
export const UNDO_TOAST_KEY = 'undo-delete'

export function offerUndoToast(
  store: Store, locale: Locale, message: string, offer: UndoOffer | null,
): void
```

Shows `message`. When `offer` is non-null it adds an "Undo" action button, and
registers a `store.onMutate` listener that dismisses the toast the moment
anything else changes — so a dead button never sits on screen. The listener is
removed when the button is clicked, when the toast is dismissed, or when the
toast expires.

## The staleness guard

Restoring a capture written after some later edit would silently revert that
edit. `store.rev` is a monotonic counter bumped by `update()`, `updateNav()`
**and** `replaceDoc()` (`src/core/store.ts:125`), so a single rev comparison
covers every way the document can move on, including a conflict-modal reload.

Rule: **undo is available until the user does anything else, or the toast
expires — whichever comes first.**

Two layers, deliberately:

- `store.onMutate` proactively dismisses the toast. Covers `update()` and
  `updateNav()`.
- `undo()` re-checks `rev` before writing. This is the correctness backstop and
  the only thing covering `replaceDoc()`, which notifies `subscribe()` but not
  `onMutate()`.

## What each site captures

| Site | Deletes | Capture | Notes |
|---|---|---|---|
| `modules/risks.ts:390` | one risk | `structuredClone(team)` | unlinks refs team-wide |
| `modules/milestones.ts:281` | one milestone | `structuredClone(team)` | unlinks refs team-wide |
| `modules/action-items.ts:257` | one card | `structuredClone(team)` | unlinks refs team-wide |
| `modules/action-items.ts:269` | every card in a column | `structuredClone(team)` | bulk; unlinks refs |
| `modules/action-items.ts:815` | a custom column | `structuredClone(team)` | migrates its cards to another status rather than deleting them, so it does *not* unlink refs; cloned anyway because the migration rewrites every moved card's `status` and `order` |
| `modules/people-tree.ts:219` | one person | `structuredClone(team)` | children are re-parented, not deleted |
| `ui/sidebar.ts:621` | a whole team | the detached `Team` object, its index, and `structuredClone(d.nav)` | no clone of the team needed |
| `ui/prefs.ts:1214` | old data, every team | `structuredClone(d.teams)` | calls `unlinkRefsInTeam` per team |

Restore reassigns the captured value: `d.teams[i] = captured` for a team-scoped
capture, `d.teams = captured` for the cleanup case.

Team delete is the one case that needs no deep copy. It does not unlink refs —
refs never cross teams — so the removed `Team` object is fully detached the
moment `d.teams.splice(idx, 1)` runs, and holding a reference to it costs
nothing. It does, however, rewrite `nav` extensively (`activeTeamId`, `split`,
`teamSplit`, and a two-pass prune of both panes' histories — see
`sidebar.ts:405`), so `nav` is cloned and restored alongside it.

### Cost

One `structuredClone` of a single team, held for ten seconds. On a team with
five years of daily notes this is a few MB and tens of milliseconds — paid
once, on an explicit user action that has already been through a confirm
dialog, and released when the toast goes. The cleanup case clones every team;
it is the most destructive action in the app and the one most worth making
reversible.

This is the argument for capture-and-restore over hand-written inverse
operations: person-delete's child re-parenting and column-delete's card
migration come back correct for free, where an inverse would have to recompute
exactly which children were promoted and un-promote exactly those.

## Call-site changes

`confirmDelete()` (`src/ui/modal.ts:244`) is untouched — it stays a pure UI
helper. Each site's existing `onConfirm` changes from

```ts
onConfirm: () => { ctx.store.update((d) => { /* delete */ }, scope) }
```

to

```ts
onConfirm: () => {
  const offer = deleteWithUndo(ctx.store, (d) => {
    const tm = d.teams.find((t) => t.id === teamId)
    if (!tm) return null
    const before = structuredClone(tm)
    /* existing delete body, unchanged */
    return (d2) => {
      const i = d2.teams.findIndex((t) => t.id === teamId)
      if (i !== -1) d2.teams[i] = before
    }
  }, scope)
  offerUndoToast(ctx.store, lc, t(lc, 'risk_deleted_toast', { title: r.title }), offer)
}
```

The column-delete site (`action-items.ts:815`) builds its own dialog with
`showModal` rather than `confirmDelete`, but its `onConfirm` body changes the
same way.

## Toast duration

`toast()` currently hardcodes a 4000 ms auto-dismiss (`src/ui/modal.ts:445`).
Four seconds is too short to notice a mistake and react to it. `ToastOptions`
gains an optional `duration?: number` defaulting to the existing 4000, and undo
toasts pass `UNDO_TOAST_MS` (10000). No existing caller changes.

## i18n

New keys, both locales:

- `undo` — the action button label.
- `undo_restored` — confirmation after a successful undo.
- One "<thing> deleted" message per site: `risk_deleted_toast`,
  `milestone_deleted_toast`, `action_deleted_toast`, `actions_deleted_toast`
  (bulk), `column_deleted_toast`, `person_deleted_toast`, `team_deleted_toast`.
  Data cleanup reuses its existing `data_cleanup_success_toast`.

Each message names what went, so the toast reads "Risk 'Vendor slip' deleted"
rather than a bare "Deleted".

## Testing

`test/undo-delete.test.ts` (new), against a real store:

- a delete followed by `undo()` restores the document exactly, deep-equal to a
  pre-delete clone — the assertion that catches the unlink problem
- `undo()` returns false and writes nothing once any other `update()`,
  `updateNav()` or `replaceDoc()` has run
- `deleteWithUndo` returns `null` on a read-only store and writes nothing
- `deleteWithUndo` returns `null` when `mutate` reports nothing deleted
- `isAvailable()` tracks the same conditions as `undo()`

`test/undo-toast.test.ts` (new): the action button appears only with a non-null
offer; clicking it calls `undo()`; a later mutation dismisses the toast.

Per-module tests: one case per delete site asserting the site returns a working
offer and that undo restores both the entity **and** the `@`-mentions of it
that the delete unlinked.

`e2e/`: one round trip — delete a team, click Undo, the team is back in the
sidebar with its content intact. Proves the toast wiring end to end.

## Accepted wart

`store.update()` bumps `rev` and sets `dirty` before `mutate` can report that
it found nothing to delete, so a no-op delete marks the document dirty and
triggers an auto-save of unchanged content. Harmless, and not worth
restructuring `update()` to avoid.
