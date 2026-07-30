# Open refs in secondary pane — design

## Problem

Clicking a `@ref` chip (person/day/action/milestone/risk) in free-text notes
always navigates the pane that hosts the click. Users reading a daily note
while wanting to peek at a linked risk/person lose their place.

## Solution

A global (per-file) preference to always open ref clicks in the *other*
pane (enabling split view if not already split), plus an on-demand override:
holding Ctrl (or Cmd on macOS)/Meta, or middle-clicking, forces secondary-pane
opening regardless of the setting. The modifier never has a "force same-pane"
meaning — it's purely additive (`prefs.openRefsInSecondaryPane || modifierHeld`).
The link is never opened in the pane that hosts the chip.

## Data model

`Prefs.openRefsInSecondaryPane: boolean`, default `false`.

`SCHEMA_VERSION` 7 → 8. Migration step 7 sets
`prefs.openRefsInSecondaryPane = prefs.openRefsInSecondaryPane ?? false`.
`createEmptyDocument` seeds it `false` directly.

## Click detection (`src/ui/editor.ts`)

The existing ref-chip `click` handler only fires for the primary button.
Middle-click dispatches `auxclick`, not `click`, so a second listener is
added for `auxclick` (filtered to `e.button === 1`), sharing the same
ref-resolution logic as `onClick`. A `mousedown` listener additionally calls
`preventDefault()` when `button === 1` over an `a.ref` chip, to suppress the
browser's autoscroll-pan cursor that middle-mousedown otherwise triggers.

`EditorHooks.onRefClick` gains a second parameter:
`onRefClick(target: RefInfo['target'], opts: { secondary: boolean }): void`,
where `secondary = e.ctrlKey || e.metaKey || e.button === 1`.

## Routing (`src/ui/atref.ts`)

`makeRefClickHandler`'s returned closure now takes `(target, opts)`. It
computes `openSecondary = store.doc.prefs.openRefsInSecondaryPane ||
opts.secondary` and, for all 4 branches (day / action·milestone·risk /
person), calls `pm.openInSecondaryPane(paneIdx, loc)` instead of
`pm.openInPane(paneIdx, loc)` when `openSecondary` is true.

The action/milestone/risk branch's post-navigation
`requestAnimationFrame` highlight lookup currently always queries
`.tt-pane-body` at index `paneIdx`. It must instead query whichever pane the
loc actually landed in: `paneIdx` normally, or the *other* pane's index when
`openSecondary` is true.

## Pane manager (`src/ui/panes.ts`)

New `PaneManager` method:

```ts
openInSecondaryPane(fromIdx: 0 | 1, target: Loc): void
```

If `!effectiveSplit()`, turns split on first — same state changes as
`toggleSplit`'s on-branch (`d.nav.split = true`,
`d.nav.teamSplit[activeTeamId] = true` if a team is active, clear the
transient `spaceHideSplit`) — then calls the existing
`openInPane(otherPaneIdx(fromIdx), target)`, which already handles
duplicate-module detection, history, and re-render. No new conflict logic
needed; `openInPane` is reused as-is once the target pane index is chosen.

`fromIdx` is always the pane that hosts the clicked chip (the module's own
`paneIdx`, per the existing `makeRefClickHandler` contract) — not whichever
pane currently has focus.

## Preferences UI (`src/ui/prefs.ts`)

General tab gains a checkbox field (same `tt-prefs-field` pattern as
`autoSaveField`/`dueSoonField`) bound to
`store.doc.prefs.openRefsInSecondaryPane`, labeled via a new i18n key.

## Help dialog (`src/ui/help.ts`)

`help_refs_text` (editor help, "References (@)" section) gains a sentence
covering: Ctrl/middle-click opens a reference in the other pane (splitting
if needed), and this can be made the default in Preferences.

## i18n (`src/core/i18n.ts`)

New keys (`pt-BR` and `en-US`):
- `prefs_open_refs_secondary_label` — checkbox label in Prefs > General.
- Updated `help_refs_text` — appended sentence on modifier-click + pref.

## Testing

- `test/document.test.ts` — migration sets the new pref default; schema
  version bump.
- `test/atref.test.ts` — `makeRefClickHandler` routes to
  `openInSecondaryPane` vs `openInPane` per the OR logic (pref alone,
  modifier alone, both, neither), for at least one id-kind target and the
  day target; highlight lookup targets the correct pane body.
- `test/panes.test.ts` — `openInSecondaryPane` turns on split when unsplit
  (and remembers `teamSplit`), leaves split alone when already split, and
  always targets `otherPaneIdx(fromIdx)`.
- `test/editor.test.ts` — `auxclick` (button 1) and `click` with
  `ctrlKey`/`metaKey` both invoke `onRefClick` with `secondary: true`; plain
  click passes `secondary: false`; `mousedown` with button 1 over a ref chip
  is prevented.

## Out of scope

- No per-ref-kind override of the setting.
- No visual difference in how the ref chip itself renders based on the
  setting or modifier state.
