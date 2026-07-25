# Expand + highlight collapsible items from search

Date: 2026-07-25
Modules: `src/ui/search-highlight.ts`, `src/ui/search-ui.ts`,
`src/ui/expandable-followup.ts`, `src/modules/milestones.ts`,
`src/modules/risks.ts`

## Problem

`applySearchHighlight` (via the CSS Custom Highlight API) paints search-term
matches in the module a search result navigates to. This works well for
free-text modules (daily notes, person notes) where the matched text is
always live in the DOM.

Milestones and risks are different: each row has a collapsible follow-up rich
editor (`▸`/`▾` button, `ExpandableRowsController`), and search indexes
`title + "\n" + followup`. Two failures result:

1. If the row is collapsed, the follow-up editor isn't mounted at all — the
   matched text doesn't exist in the DOM to highlight.
2. Even when already expanded, the follow-up row is a DOM **sibling** of the
   title row (`listEl` appends them as separate flat children), not a
   descendant. `search-ui.ts`'s `commit()` scopes highlighting to the single
   `[data-item-id]` anchor (the title row only), so follow-up matches are
   missed regardless of expand state.

Action items keep their current behavior — notes only exist inside the
edit modal (no inline expandable row), and per product decision a search hit
there should just scroll/focus the card, not auto-open the modal.

## Design

### Why not store the target item in `Loc.ref.itemId`

`ModuleRef` already has an optional `itemId` on `actions`/`milestones`/`risks`,
used today only for the anchor lookup. Storing "which item to focus" there
was the first idea, but `nav.ts`'s `sameLoc`/`locsConflict` ignore `itemId`
for these kinds (fall through to `return true`). If the target module is
already the pane's current Loc, `openLoc` returns the *existing* pane object
unchanged — the new `itemId` is discarded before the module ever mounts with
it. Not reliable whenever the user searches while already on that tab.

### Chosen approach: transient CustomEvent

After `pm.openInFocused()` completes (synchronous, so the target module is
already mounted), `search-ui.ts` dispatches a small CustomEvent carrying just
the `itemId` on the pane's body element (`.tt-pane-body`). Modules that have
collapsible rows (`milestones.ts`, `risks.ts`) each register one listener —
scoped to the same `container` they already receive and already tear down
via their existing per-container disposer — that expands the matching row
(if collapsed) and re-renders locally. This mirrors the app's existing
pattern for transient, non-persisted UI signals (`AT_TRIGGER_EVENT`,
`SLASH_TRIGGER_EVENT` in `editor.ts`).

Modules that don't register a listener (`action-items.ts`, and the free-text
modules) simply never see any effect from the dispatch — safe no-op.

### 1. `ExpandableRowsController` — add `expand(id)`

```ts
expand(id: string): void {
  this.expandedIds.add(id)
}
```
Mirrors the existing `collapse(id)`.

### 2. New event: `search-highlight.ts`

```ts
export const SEARCH_FOCUS_ITEM_EVENT = 'tt-search-focus-item'

export function dispatchSearchFocusItem(container: HTMLElement, itemId: string): void {
  container.dispatchEvent(new CustomEvent<string>(SEARCH_FOCUS_ITEM_EVENT, { detail: itemId }))
}
```

### 3. `milestones.ts` / `risks.ts` — listen and expand

In each module's mount (after `container.appendChild(...)`, alongside the
existing `ctx.store.subscribe` wiring):

```ts
function onSearchFocusItem(e: Event): void {
  const itemId = (e as CustomEvent<string>).detail
  if (!milestones().some((m) => m.id === itemId)) return // or risks()
  if (expandable.isExpanded(itemId)) return
  expandable.expand(itemId)
  renderAll()
}
container.addEventListener(SEARCH_FOCUS_ITEM_EVENT, onSearchFocusItem)
```

Added to the existing disposer:
```ts
disposers.set(container, () => {
  unsubscribe()
  expandable.disposeAll()
  container.removeEventListener(SEARCH_FOCUS_ITEM_EVENT, onSearchFocusItem)
})
```

Also: tag the follow-up row with the same `data-item-id` as its title row
(additive — keeps the existing `data-milestone-followup-id` /
`data-risk-followup-id` marker too):

```ts
el('div', { class: 'tt-milestone-followup-row', 'data-milestone-followup-id': m.id, 'data-item-id': m.id }, ...)
```//risks.ts mirrors with `data-risk-followup-id`

This makes `[data-item-id="..."]` resolve to *both* the title row and (once
expanded) its follow-up row, so both are included in the highlight scope.

### 4. `search-highlight.ts` — `applySearchHighlight` takes multiple roots

```ts
export function applySearchHighlight(rootEls: HTMLElement[], terms: string[]): void {
  const ranges = rootEls.flatMap((r) => findMatchRanges(r, terms))
  // ...unchanged from here (CSS.highlights set/delete, scroll first range into view)
}
```
`findMatchRanges` itself is unchanged (still single-root).

### 5. `search-ui.ts` — dispatch, then gather all matching anchors

```ts
pm.openInFocused(result.loc)
closeDropdown()
requestAnimationFrame(() => {
  const paneEl = document.querySelectorAll('.tt-pane-body')[store.doc.nav.focusedPane] as HTMLElement | undefined
  if (!paneEl) return
  const ref = result.loc.ref
  const itemId = 'itemId' in ref ? ref.itemId : undefined
  if (itemId) dispatchSearchFocusItem(paneEl, itemId) // no-op for modules that don't listen
  const anchors = itemId
    ? Array.from(paneEl.querySelectorAll<HTMLElement>(`[data-item-id="${itemId}"]`))
    : []
  applySearchHighlight(anchors.length > 0 ? anchors : [paneEl], terms)
})
```

For action items: no listener exists, so the dispatch is inert; the anchor
lookup still finds the single kanban card element exactly as today, so its
title/assignee text still highlights and scrolls into view ("focus the
card" — matches the product decision to not auto-open the edit modal).

For daily/person notes: `itemId` is never part of those refs, so `anchors`
is empty and the fallback `[paneEl]` preserves today's whole-editor
highlight behavior unchanged.

## Testing

- `test/expandable-followup.test.ts`: `expand(id)` adds to the expanded set
  (mirrors existing `collapse` coverage).
- `test/search-highlight.test.ts`: update existing single-root calls to pass
  a one-element array; add a case with two root elements confirming ranges
  from both are combined.
- `test/milestones.test.ts` / `test/risks.test.ts`: dispatching
  `SEARCH_FOCUS_ITEM_EVENT` with a collapsed item's id expands it (follow-up
  editor appears in the DOM) and re-renders; dispatching with an id that
  isn't in this team's list is a no-op; dispatching with an already-expanded
  id doesn't double-render.
- `test/panes.test.ts` (or a new integration test alongside it, following its
  existing real-`createPaneManager` + registered-module pattern): an
  end-to-end case — register `renderMilestones` and `mountSearch` against a
  real `PaneManager`, search a term that only exists in a milestone's
  followup, click the result, and confirm the row ends up expanded with the
  matched text present in the DOM.

## Out of scope

- Action items stay as they are today (card-level focus only, no modal
  auto-open) — explicit product decision.
- No change to how search indexes/ranks results — only what happens after a
  result is clicked.
- No persistence of "which item was expanded by search" — it's rebuilt fresh
  on every navigation into the module, same as all other in-memory expand
  state today.
