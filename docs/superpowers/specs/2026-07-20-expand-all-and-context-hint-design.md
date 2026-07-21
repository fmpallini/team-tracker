# Expand-all/collapse-all follow-ups + right-click discoverability hint

Date: 2026-07-20
Modules: `src/modules/risks.ts`, `src/modules/milestones.ts`

## Problem

Both risks and milestones rows have a per-row expandable follow-up editor
(`▸`/`▾` button). Today only one can be expanded at a time: `expandedId:
string | null` plus a single `expandedBundle` mean expanding a row silently
collapses whichever other row was open. Users reviewing many risks/milestones
want to scan all follow-ups at once without expanding rows one by one.

Separately, both rows support duplicate/copy-to-team/move-to-team via a
right-click context menu (`contextmenu` listener), but nothing in the UI
signals that right-click does anything — it's undiscoverable except by
accident or being told.

## Design

### 1. Multi-expand state

Replace the single-expanded-row state in both modules:

- `expandedId: string | null` → `expandedIds: Set<string>`
- `expandedBundle: ExpandedBundle | null` → `expandedBundles: Map<string,
  ExpandedBundle>`
- `disposeExpandedBundle()` (no args, disposes the one bundle) → two
  functions:
  - `disposeExpandedBundle(id: string)` — disposes and removes one entry
  - `disposeAllExpandedBundles()` — disposes and clears every entry (used on
    full teardown, mirroring today's unconditional dispose before a full
    rebuild)
- `toggleExpand(id)` flips membership of `id` in `expandedIds` (add if
  absent, delete if present) instead of the old ternary-to-null-or-id logic
- `renderFollowupRow(r)` keys its bundle into the map by `r.id` instead of
  overwriting the single `expandedBundle` variable
- `renderAll()` iterates `open` rows and appends `renderFollowupRow(r)` for
  every `r.id` present in `expandedIds` (today: only for the one row where
  `expandedId === r.id`)

Closed rows are unaffected — `renderClosedRow` never renders a follow-up
editor regardless of expand state, so `expandedIds` only ever needs to
contain ids of currently-open (non-closed) rows. If a row is closed while
expanded, its id should be dropped from `expandedIds` (mirroring today's
`if (expandedId === id) expandedId = null` guard in `removeRisk`/equivalent
milestone removal — extend that same guard to `setClosed`).

### 2. Expand-all / collapse-all toolbar button

New function `setAllExpanded(expand: boolean)`:
- `expand = true`: sets `expandedIds` to the set of all currently-open
  (non-closed) row ids
- `expand = false`: clears `expandedIds` entirely (and disposes all bundles)
- Both call `renderAll()` after mutating state

Toolbar button (next to the existing "Add" button, same toolbar row):
- Label reads `risk_expand_all_btn` / `milestone_expand_all_btn` ("Expand
  all") whenever at least one open row's id is *not* in `expandedIds`
- Once every open row's id is in `expandedIds`, label flips to
  `risk_collapse_all_btn` / `milestone_collapse_all_btn` ("Collapse all")
- Clicking calls `setAllExpanded` with the opposite of the current all-expanded
  state
- With zero open rows, the button reads "Expand all" and is a no-op when
  clicked (empty set operations are harmless) — no need to disable/hide it,
  keeps the render logic simple

### 3. Right-click discoverability hint

Add a `title` attribute to each row element (`.tt-risk-row` /
`.tt-milestone-row`, the open-row variant only — closed rows and the
follow-up row itself don't need it) carrying a new hint string:

- New i18n keys (both `pt` and `en` blocks in `core/i18n.ts`):
  - `risk_row_context_hint`
  - `milestone_row_context_hint`
- English text: "Right-click for more actions (duplicate, copy/move to
  team)"
- Portuguese text: "Clique com o botão direito para mais ações (duplicar,
  copiar/mover para outro time)"

This is a pure `title` attribute addition (native browser tooltip on hover),
no new DOM elements, no new CSS — consistent with how icon buttons in the
same rows already use `title` for their own hints.

## Testing

`test/risks.test.ts` and `test/milestones.test.ts`:
- Replace any assertion that assumes expanding row B collapses row A —
  instead assert both can be simultaneously expanded (both follow-up editors
  present in the DOM)
- Add coverage for the expand-all button: clicking with rows collapsed
  expands all open rows and flips the label; clicking again (or with all
  already expanded) collapses all and flips back
- Add coverage that closing an expanded row removes it from the "all
  expanded" set (mixed-state label stays "Expand all")
- Assert the row element carries the new `title` hint text

## Out of scope

- No change to the context menu itself (items/behavior unchanged) — only a
  hover hint is added.
- No change to `action-items.ts` — it uses a modal-based editor (not the
  inline expand-per-row pattern), so this doesn't apply there.
- No persistence of expand state across reloads/renders beyond the existing
  in-memory session lifetime (same as today's single `expandedId`).
