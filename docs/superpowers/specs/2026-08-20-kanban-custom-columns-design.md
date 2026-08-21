# Kanban custom middle columns — design

## Goal

The action-items kanban board ([action-items.ts](../../../src/modules/action-items.ts))
has a hardcoded three-status shape: fixed `todo` start, a single fixed `wip`
middle, fixed `done`+`cancelled` combined end (two zones, one visual column).
Teams want to define their own workflow stages between Todo and Done —
add/remove/rename/reorder columns, per team, while Todo and Done+Cancelled
stay pinned at the ends.

## Data model + migration

`Team` gains `actionColumns: ActionColumn[]`, per-team (mirrors
`actionTagNames`'s per-team precedent — different teams can want different
workflow stages):

```ts
export interface ActionColumn { id: string; name: string; order: number }
```

`ActionItem.status`'s type widens from the closed union
`'todo' | 'wip' | 'done' | 'cancelled'` to `string`. The three fixed ids
(`'todo'`, `'done'`, `'cancelled'`) stay reserved and never collide with a
custom column's id, which is always a fresh `crypto.randomUUID()`.

`SCHEMA_VERSION` bumps to 13. New migration step:

```ts
13: (d) => {
  const locale = (d.prefs as Record<string, unknown> | undefined)?.locale === 'pt-BR' ? 'pt-BR' : 'en-US'
  for (const team of (d.teams as Record<string, unknown>[]) ?? []) {
    if (!Array.isArray(team.actionColumns)) {
      team.actionColumns = [{ id: 'wip', name: t(locale, 'kanban_wip_default_name'), order: 0 }]
    }
  }
},
```

Locale comes from the raw doc's own `prefs.locale` (present since schema v1),
same lookup `createEmptyTeam` already relies on for `actionTagNames` — no new
dependency on migration call sites passing locale through. **No
`actionItems[].status` values are touched**: existing items already carry the
literal `'wip'`, which now happens to match the seeded column's `id` instead
of a hardcoded case in `STATUSES`. Board contents are pixel-identical
immediately post-migration.

`createEmptyTeam` seeds new teams the same way: `actionColumns: [{ id: 'wip',
name: t(locale, 'kanban_wip_default_name'), order: 0 }]`, replacing today's
hardcoded WIP column with an equivalent, renamable one.

Fixed columns (`'todo'` start, `'done'`/`'cancelled'` combined end) are never
renamed, removed, or reordered — no UI affordance exists for them beyond
today's clear-zone trash button.

## Column management UI

- **Header rename**: click the column name → becomes a text `<input>`,
  commits on blur/Enter (same immediate-commit convention as the card
  modal's fields — no Save button). A pencil-icon hint appears only on
  hover, not at rest, signaling the name is editable without permanently
  cluttering the header.
- **Add column**: one `+ Add column` affordance sits at the right edge of
  the middle-column zone, immediately before the fixed Done+Cancelled
  column — never per-existing-column, so there's exactly one place a new
  column can be created and it's always the new rightmost middle column.
  On click: a new `ActionColumn` is pushed with `order` one past the current
  max, a placeholder default name (`kanban_new_column_default_name`, e.g.
  "New column"), and its rename `<input>` auto-focused immediately —
  mirrors the new-card-focus pattern in `openEditModal`.
- **Delete column**: a small trash-icon button per middle column.
  - Empty column → deletes immediately, no confirmation. Matches the
    existing convention that empty content (a blank card) is silently
    discarded — nothing is lost.
  - Non-empty column → a `showModal()` dialog with a landing-column
    `<select>` (options: Todo, every *other* existing middle column, Done,
    Cancelled — labelled via new plain-name keys `kanban_status_todo` /
    `kanban_status_done` / `kanban_status_cancelled` for the two fixed ends,
    the column's own `name` for middle columns) plus Cancel/Confirm.
    Confirm bulk-reassigns every card in the deleted column to the chosen
    target status, densely renumbers both groups' `order` (same mechanics
    `moveCard` already applies to a single card), then removes the column
    from `actionColumns`.
- **Reorder**: drag the column header (not the body) — same
  `dragstart`/`dragover`/`drop` shape the cards already use, with a drop
  indicator between headers. A new pure helper, `moveColumn(columns,
  draggedId, targetId, position)`, mirrors `moveCard`'s shape: finds the
  dragged column, splices it to the new position, densely renumbers
  `order`. Drag-and-drop only — no keyboard fallback. Column reordering is
  infrequent enough not to warrant one, and the natural keys (Alt+Left/
  Right) are already claimed by pane history navigation
  ([main.ts](../../../src/main.ts)'s hotkey table).

## Rendering + layout

`STATUSES` (today a static `const STATUSES = ['todo', 'wip', 'done',
'cancelled'] as const`) becomes computed per render from the team's own
`actionColumns`, sorted by `order`:

```ts
const middleIds = [...(tm?.actionColumns ?? [])].sort((a, b) => a.order - b.order).map((c) => c.id)
const STATUSES = ['todo', ...middleIds, 'done', 'cancelled']
```

`cols` (today a fixed `Record<ActionItem['status'], {...}>` literal) becomes
a `Map` keyed by status id, rebuilt whenever the column set changes, so
`renderAll`, `findAdjacentCard`, `wireColumnDrop`, drop-zone show/hide, and
the arrow-key grid navigation all keep working unchanged against a dynamic
column list instead of four fixed keys.

Every middle column gets its own `+ Add card` button in its header, same as
Todo's today (currently only `'todo'`/`'wip'` are "addable"; every middle
column now is).

`.tt-kanban-board` moves from a fixed 3-column CSS grid
(`grid-template-columns: 1fr 1fr 1.15fr`) to a flex row:
`display: flex; overflow-x: auto;` with each column
`flex: 1 1 220px; min-width: 220px`. Todo and Done+Cancelled keep roughly
today's proportions (`flex-basis` tuned to match current widths); middle
columns share remaining space equally down to the 220px floor, after which
they stop shrinking and the board scrolls horizontally instead of squeezing
cards unreadably thin.

## Cross-team transfer (copy-to-team / move-to-team)

Only action items need a landing-column choice on transfer — milestones and
risks have no status/column concept and keep today's plain
`openTeamPickerModal` unchanged.

`card-context-menu.ts`'s `showCardContextMenu` gains an optional per-kind
hook, e.g. `getColumnsForTeam?: (team: Team) => { id: string; label: string
}[]`. When present (only `openItemContextMenu`'s `'action'` branch supplies
it), the copy/move menu items open a new combined modal instead of the
plain team picker: one team `<select>` plus one column `<select>`, where
changing the team repopulates the column list from
`getColumnsForTeam(selectedTeam)` (target team's `actionColumns` plus the
three fixed statuses). Confirm calls `transfer(itemId, targetTeamId, mode,
targetStatus)`.

`transferActionItem` ([card-transfer.ts](../../../src/core/card-transfer.ts))
gains a `targetStatus: string` parameter and sets `copy.status =
targetStatus` explicitly, rather than carrying over the source item's
`status` verbatim — today's carry-over is silently wrong the moment the
source status is a custom column id that doesn't exist (or means something
different) on the target team; this is the bug this design closes.
Same-team "Duplicate" needs no picker at all — the copy stays in the
source card's current column, exactly as today.

## Keyboard handling

Both new modals (delete-with-landing-column, combined transfer picker) are
built with `showModal()`, which already provides Escape-to-close,
Tab/Shift+Tab focus trapping, Enter-commits-on-a-text-input, and
initial-focus-on-first-field ([modal.ts](../../../src/ui/modal.ts)) — no new
keyboard-handling code is needed for either. Inline column rename reuses the
same blur/Enter-commit pattern the card modal's `summaryInput` already uses.

## i18n

New keys, both `pt-BR` and `en-US`, in [i18n.ts](../../../src/core/i18n.ts):

- `kanban_add_column` — "+ Add column" button label
- `kanban_rename_column_hint` — hover tooltip on a column name
- `kanban_delete_column_title` / `kanban_delete_column_confirm` — non-empty
  delete modal title/body (with card count, mirrors `kanban_clear_zone_*`)
- `kanban_column_landing_label` — label above the landing-column `<select>`
- `kanban_status_todo` / `kanban_status_done` / `kanban_status_cancelled` —
  plain (no count) names for the two fixed ends, used in landing-column and
  transfer dropdowns
- `kanban_wip_default_name` — "WIP", used by migration 13 and
  `createEmptyTeam`'s seed column
- `kanban_new_column_default_name` — placeholder name for a freshly added
  column before it's renamed
- `kanban_transfer_column_label` — label for the column `<select>` in the
  combined transfer modal

## Testing

- `core/document.test.ts`: migration 13 — a v12 doc's team with `wip` items
  gains `actionColumns: [{ id: 'wip', ... }]`, items untouched, name matches
  the doc's own `prefs.locale`.
- `core/card-transfer.test.ts`: `transferActionItem` sets `copy.status` to
  the passed `targetStatus`, independent of the source item's status.
- `modules/action-items.test.ts`: new `moveColumn` pure-helper unit tests
  (mirrors `moveCard`'s existing test shape — reorder within bounds,
  no-op on missing id, dense renumbering). Render-level jsdom tests for:
  add-column (appends, focuses rename input), inline rename commit,
  delete-empty-column (silent), delete-non-empty-column (opens landing
  modal, reassigns cards, removes column), column drag reorder (simulated
  `dragstart`/`dragover`/`drop`, same style as the existing card DnD tests
  in this file).
- No new e2e coverage planned — the existing Playwright suite doesn't
  target kanban drag-and-drop specifically today, and this design doesn't
  change that surface's fundamentals (still native HTML5 DnD events).
