# Team Tracker — Action Items kanban redesign (design)

Date: 2026-07-15. Approved by user on this date (visual mockups reviewed via the brainstorming visual companion — board layout, color palette, edit modal all approved as shown).

## Goal

Replace the flat, checkbox-based action-items list (`src/modules/action-items.ts`) with a 3-column kanban board: **To Do**, **WIP**, and **Done / Cancelled** (one column, two drop zones). Cards are draggable within and across columns/zones, carry a color accent, and open a modal for full editing (summary, notes, due date, assignee, color).

## Decisions (from brainstorming)

1. **Migration**: `done:true` → `status:'done'`, `done:false` → `status:'todo'`. No prompt to reclassify as cancelled — user can drag manually afterward.
2. **Card creation**: "+ card" (To Do / WIP column headers only — Done/Cancelled has no add button, only reachable by drag) opens the edit modal blank. Save inserts the card at the end of that column; Cancel discards, no empty-card litter.
3. **Card editing entry points**: double-click (with a hover tooltip hinting at it) **or** a pencil/edit icon in the card's corner, visible on hover. Both open the same modal.
4. **Trash target**: a floating drop zone that fades in only while a card is being dragged (mirrors the existing root-drop-zone pattern in `src/modules/people-tree.ts`), not a permanently visible per-column icon. Dropping a card there opens the existing delete-confirm modal pattern.
5. **Color palette**: 6 accent options — Slate teal `#3b5a6b`, Brass `#9c6b2e`, Sage `#4a6b45`, Rust `#a1402c`, Plum `#6b4a7a`, Ledger grey `#5c5744` (default for migrated/new cards). Same hues drive both light and dark theme (each gets a dark-mode-tuned pair, same pattern as the existing `--accent`/`--danger`/`--ok` vars in `styles.css`).
6. **Cancelled is not a dead end**: cards drag freely in and out of Cancelled, same as any other zone/column. Only path to permanent removal is the trash (single-card drag-to-trash, or a zone's "clear all").

## Data model (schema v3 → v4)

```ts
export interface ActionItem {
  id: string
  summary: string        // was `text` — the card's title, shown in the major font
  notes: string           // unchanged — rich text, edited only inside the modal now
  status: 'todo' | 'wip' | 'done' | 'cancelled'   // replaces `done: boolean`
  dueDate: string | null  // unchanged
  assignee: string        // unchanged
  color: 'slate' | 'brass' | 'sage' | 'rust' | 'plum' | 'ledger'
  order: number            // dense 0..n-1, scoped *within* its status group (not global)
}
```

**Migration (`MIGRATIONS[3]` in `src/core/document.ts`, bumping `SCHEMA_VERSION` to 4):**

```ts
3: (d) => {
  for (const team of (d.teams as Record<string, unknown>[]) ?? []) {
    for (const a of (team.actionItems as Record<string, unknown>[]) ?? []) {
      a.summary = a.text ?? ''
      delete a.text
      a.status = a.done ? 'done' : 'todo'
      delete a.done
      a.color = a.color ?? 'ledger'
    }
    // renumber order within each status group so it's dense per-group, not
    // the old flat 0..n-1 across all items
    const byStatus = new Map<string, Record<string, unknown>[]>()
    for (const a of (team.actionItems as Record<string, unknown>[]) ?? []) {
      const arr = byStatus.get(a.status as string) ?? []
      arr.push(a)
      byStatus.set(a.status as string, arr)
    }
    for (const arr of byStatus.values()) {
      arr.sort((x, y) => (x.order as number) - (y.order as number))
      arr.forEach((a, i) => { a.order = i })
    }
  }
},
```

## Architecture

**`src/modules/action-items.ts`** is rewritten (not patched) — the flat-list rendering, `openItems`/`doneItems`, `computeFlatDropPosition`, `moveActionItem` helpers, and their `.tt-action-*` CSS/`action_*` i18n keys are replaced, not kept alongside the new code.

### Pure, unit-testable helpers (mirrors the existing file's style)

- `itemsByStatus(items, status)`: filter + sort by `order`.
- `computeDropPosition(offsetY, height)`: same before/after split as today's `computeFlatDropPosition` (unchanged logic, reused for within-zone reordering).
- `moveCard(items, draggedId, status, targetId | null, position)`: sets `dragged.status = status`, then renumbers `order` densely within both the source and destination status groups. `targetId === null` means "drop into an empty column/zone" (append at 0). Mirrors `moveActionItem`/`moveInTree`'s in-place-mutate-inside-`store.update` shape.
- `promoteToDone` / `promoteToCancelled`: thin wrappers used by the two Done/Cancelled sub-zone drop handlers — set `status` accordingly and append to the end of that zone's order, mirroring people-tree.ts's `promoteToRoot`.

### Rendering

- Board container: 3 `.tt-kanban-col` columns. Third column renders two internal zones (`.tt-kanban-zone` for Done, one for Cancelled) separated by a divider, each with its own header (`t(lc,'kanban_done_heading')` / `kanban_cancelled_heading`) and a small trash icon that opens a confirm modal ("Delete N cards?") before bulk-removing that zone's items.
- Card face (`.tt-kanban-card`): `summary` in `--font-display` (matches the app's serif brand/title face), `dueDate`/`assignee` below in `--font-data` (matches existing due-date styling convention), left-border stripe in the card's `color`. `isOverdue` is updated to take `status` instead of `done` (`item.dueDate !== null && item.dueDate < today && item.status !== 'done' && item.status !== 'cancelled'`) — a card only reads as overdue while it's still active (To Do/WIP). When true, the due-date text renders in `--danger` regardless of card color, so it stays legible on any accent. Cancelled cards get `text-decoration: line-through` on the summary and reduced opacity, matching today's done-row treatment.
- Card carries `data-item-id` (unchanged contract — search/@ref navigation and `applySearchHighlight` depend on this attribute existing somewhere in the rendered module).
- Pencil icon (`.tt-kanban-edit-btn`, opacity 0 → 1 on hover, `tabindex="-1"` like today's expand/delete buttons) plus a `dblclick` listener on the card, both call the same `openEditModal(item)`.
- "+ card" button in To Do / WIP column headers only, calls `openEditModal(null, status)` (blank item).

### Drag and drop

- `dragstart` on any card: sets `draggedId`, shows the floating trash zone (`trashEl.classList.add('active')` — same show/hide contract as people-tree's `rootDropEl`).
- `dragover`/`drop` within a column/zone: same before/after split as today, via `computeDropPosition`.
- `dragover`/`drop` on a different column/zone (including Done vs Cancelled, which are visually separate targets): `moveCard(..., newStatus, ...)`.
- `dragend` (fires whether or not a drop succeeded): hides the trash zone, clears any drop-position CSS classes.
- Drop on the trash zone: opens the existing single-item delete-confirm modal pattern (reused from today's `openDeleteConfirm`), keyed by `draggedId`.

### Edit modal

New function `openEditModal(item: ActionItem | null, defaultStatus?: 'todo' | 'wip')` in `action-items.ts` (uses `showModal` from `ui/modal.ts`, same as the rest of the app):

- Fields: summary (`text` input), notes (`createEditor` + `attachAtAutocomplete` + `attachTemplatePicker`, same wiring as today's `renderNotesRow`, but the editor instance now lives for the modal's lifetime — created on open, `.destroy()`'d on close via both Save and Cancel), due date (`type=date`), assignee (`text` input + existing datalist), color (6-swatch row, click to select, same interaction pattern as risk's chance/impact selectors).
- Actions row: **Delete** (left, only shown when editing an existing item — opens the same confirm-modal as the trash-drop path) / **Cancel** / **Save** (right).
- Save on a new item: pushes into `team.actionItems` at the end of `defaultStatus`'s order group. Save on an existing item: patches the found item in place via `ctx.store.update`.

### Search / cross-reference navigation

No change to `src/core/search.ts`'s indexing shape beyond the `item.text` → `item.summary` rename in the indexed `title`/`raw` fields. Clicking a search result or an `@`-reference still calls `applySearchHighlight` against `[data-item-id="…"]` inside the pane — this scrolls to and flashes the matching card wherever it currently sits (any column/zone) but does **not** auto-open the edit modal. If the only matching text is inside `notes` (not visible on the collapsed card face), the card still gets located and scrolled to; no visible term highlight paints on the card itself. This is an accepted, minor degradation from today's behavior (where notes could be inline-expanded) in exchange for the modal-only notes editing this design calls for.

## i18n

New keys (both `pt-BR` and `en-US`) replacing the old `action_*` set: `kanban_col_todo`, `kanban_col_wip`, `kanban_col_done_cancelled`, `kanban_done_heading`, `kanban_cancelled_heading`, `kanban_add_card`, `kanban_edit_title`, `kanban_summary_label`, `kanban_notes_label`, `kanban_due_label`, `kanban_assignee_label`, `kanban_color_label`, `kanban_color_slate` / `_brass` / `_sage` / `_rust` / `_plum` / `_ledger`, `kanban_delete_btn`, `kanban_delete_confirm`, `kanban_delete_title`, `kanban_clear_zone_confirm`, `kanban_clear_zone_title`, `kanban_trash_hint`, `kanban_edit_hint` (hover tooltip), `kanban_empty` (per-column empty state, replaces `action_empty`).

## CSS

New `.tt-kanban-*` rules in `styles.css` replacing `.tt-action-*`, following the existing "Field Ledger" theme variables (`--panel`, `--border`, `--accent-rgb`, etc.) plus 6 new paired light/dark custom properties for the card-accent hues (e.g. `--card-slate`, `--card-brass`, …), declared alongside the existing `:root, [data-theme=light]` / `[data-theme=dark]` blocks.

## Testing

`test/action-items.test.ts` is rewritten to cover the new pure helpers (`itemsByStatus`, `computeDropPosition`, `moveCard`, `promoteToDone`/`promoteToCancelled`) the same way the current file unit-tests `openItems`/`doneItems`/`computeFlatDropPosition`/`moveActionItem`, plus DOM-level tests for: card rendering per column/zone, drag-and-drop status transitions, the floating trash zone's show/hide-on-drag lifecycle, per-zone clear-all with confirm, and the edit modal's create/edit/delete/save flows (mirroring the existing coverage style for `people-tree.test.ts`'s root-drop-zone tests). `test/document.test.ts`'s migration-ladder tests get a new case for the v3→v4 step.

## Out of scope

- No keyboard-only alternative to drag-and-drop reordering (matches the existing precedent in `action-items.ts` and `people-tree.ts` — neither offers one today).
- No WIP column card limit.
- No auto-open of the edit modal from search/@ref navigation (see Search section above).
