# Filterable due-dates panel + palette entry + header pill counters

Date: 2026-07-28
Modules: `src/ui/due-panel.ts` (new), `src/ui/sidebar.ts`, `src/ui/palette.ts`,
`src/main.ts`, `styles.css`

## Problem

The ⏰ due-dates modal (`sidebar.ts`'s `openDueModal`) always lists overdue +
due-soon items across every team. There's no way to:

1. Open it from the command palette (Ctrl+K) — only the ⏰ sidebar button
   reaches it.
2. Filter it to one team. The sidebar team list and the collapsed-header team
   switcher both already show a per-team due count badge
   (`.tt-team-due-badge`), but the badge is inert — clicking it just clicks
   through to selecting that team, same as clicking the row.
3. See a due-items total when the sidebar is collapsed. The ⏰ button + badge
   live inside `.tt-sidebar-content`, which is hidden outright by
   `.tt-sidebar[data-collapsed="true"]` — the only per-team-name summary left
   in that state is the header's collapsed team pill
   (`headerTeamIndicator`), which shows no due information at all today.

Opening the panel — filtered or not — must never change the active team.
Only clicking an actual due item inside it does (jumping to that item's
team/module), exactly like the existing global modal's row click already
does.

## Design

### New module: `src/ui/due-panel.ts`

Extracts the modal-building logic that lives inline in `sidebar.ts` today
(`openDueModal`, `renderDueRow`, `relLabel`) into a standalone renderer with
no `Store`/`PaneManager` dependency, so every caller (global button, per-team
badges, header pill, palette) can reuse it without sidebar.ts exposing its
internals:

```ts
export interface DuePanelOpts {
  locale: Locale
  buckets: DueBuckets
  teamId?: string       // filter to this team only; omitted = every team
  teamName?: string     // required when teamId is set — used in the title
  onOpenItem(loc: Loc): void
}

/** Pure filter, exported for unit testing without touching the DOM. */
export function filterBucketsByTeam(buckets: DueBuckets, teamId: string | undefined): DueBuckets

export function openDuePanel(opts: DuePanelOpts): void
```

`openDuePanel` calls `filterBucketsByTeam` internally, then renders the same
overdue/due-soon sections and empty state as today. Title is
`t(locale, 'due_panel_title')`, or `${t(locale,'due_panel_title')} · ${teamName}`
when `teamId` is set (same `·` convention `panes.ts`'s `titleFor` already
uses for pane titles). Each row's click calls `opts.onOpenItem(item.loc)`
instead of reaching into `store`/`pm` directly — callers decide what
"opening an item" means (they all do the same thing: switch team if needed,
then `pm.openInFocused`).

`sidebar.ts` keeps owning `dueBuckets()` (the today-keyed cache) — callers
compute buckets once and pass them in; `due-panel.ts` never recomputes or
caches on its own.

### `sidebar.ts` changes

- Global ⏰ button: calls `openDuePanel({ locale: locale(), buckets: dueBuckets(), onOpenItem })` where `onOpenItem` is the existing select-team-then-open logic, unchanged in behavior.
- Team list row's per-team badge (`teamDueBadgeEl`, in `render()`): becomes a `<button>` with `onclick: (e) => { e.stopPropagation(); openDuePanel({ locale: locale(), buckets: dueBuckets(), teamId: team.id, teamName: team.name, onOpenItem }) }`. `stopPropagation` keeps the row's own `click` listener (team select) from also firing.
- Team switcher dropdown row's per-team badge (`openTeamSwitcher()`): same treatment — stops `selectableRowProps`' row-level `onclick` (`pickSwitcherTeam`) from firing, and closes the switcher first (`closeTeamSwitcher()`) before opening the modal, so there's never a dropdown floating behind the panel.
- Header pill (`headerTeamIndicator`, in `renderHeaderTeamIndicator()`):
  - Gets its own due-count badge for the *active* team, inserted after `headerTeamIndicatorLabel` and before the caret, reusing `.tt-team-due-badge` styling. Click: `stopPropagation` + `openDuePanel({ teamId: activeTeamId, ... })`.
  - A new sibling element, `headerDueSummary` (clock icon + count), is appended to `headerCenter` *before* the pill. Shown only when the sum of due items belonging to teams other than the active one is > 0. Click opens the unfiltered (global) panel. Both elements are wrapped in one container, `.tt-header-team-indicator-group`, appended to `headerCenter` — the existing `visible`/compact-hide rules move from `.tt-header-team-indicator` to this group so both elements appear/disappear together exactly when the pill does today.
  - `renderHeaderTeamIndicator()` computes `teamDueCounts` the same way `render()` already does (loop over `dueBuckets()`), reusing the map rather than introducing a second cache.

### `palette.ts` changes

- `createPalette(store: Store, pm: PaneManager, onOpenDue?: () => void): Palette` — new optional third parameter. `main.ts` wires it to open the global panel (via a new `SidebarHandle.openDuePanel()` — see below).
- `filterModuleItems` is generalized from `(items: ModuleItem[], query) => ModuleItem[]` to `<T extends { label: string }>(items: T[], query: string): T[]`. Implementation is unchanged (it only ever touched `.label`), so the existing `test/panes.test.ts` call site and assertions are unaffected.
- Inside `open()`, a local row type unions the real module items with one synthetic entry:
  ```ts
  type PaletteRow = { label: string; commit: () => void }
  ```
  Built as `onOpenDue ? [{ label: '⏰ ' + t(locale,'due_panel_title'), commit: () => { close(); onOpenDue() } }] : []`, concatenated before the `buildModuleItems(...)` results mapped to `{ label, commit: () => commit(item) }`. `filterModuleItems` runs over this combined `PaletteRow[]`. This keeps `ModuleRef`/`ModuleItem` (shared with the pane-switcher dropdown in `panes.ts`) completely untouched — the due entry only exists inside `palette.ts`.

### `main.ts` changes

- `sidebarHandle` (`SidebarHandle`) gains `openDuePanel(): void` — opens the global, unfiltered panel using the same wiring the sidebar's own ⏰ button uses.
- `createPalette(store, pm, () => sidebarHandle.openDuePanel())` replaces today's `createPalette(store, pm)` call. (Palette is currently constructed before `mountSidebar` in `main.ts` — the callback is a closure so construction order doesn't matter, only that `sidebarHandle` exists by the time the user actually opens the palette.)

### `styles.css` changes

- Rename the visibility/compact-hide target from `.tt-header-team-indicator` to a new `.tt-header-team-indicator-group` wrapper (both the pill and the new clock+count summary live inside it); `.tt-header-team-indicator` itself keeps its own pill-specific styling (border, padding, radius).
- New `.tt-header-due-summary` rule: same icon+badge visual language as `.tt-due-btn`'s badge (clock icon, pill-shaped count), sized to sit comfortably left of the team pill with a small gap.
- The due-count badge nested inside the pill reuses the existing `.tt-team-due-badge` class as-is.

## Testing

- `due-panel.test.ts` (new): `filterBucketsByTeam` — filters overdue/dueSoon down to one team, `undefined` teamId is a no-op passthrough, a team with zero matching items yields empty arrays (not a crash).
- `sidebar.test.ts` additions:
  - Clicking a team-list badge opens a panel containing only that team's rows and does **not** call `actions.selectTeam`.
  - Clicking a due row inside a filtered panel for a non-active team still calls `actions.selectTeam` + `pm.openInFocused` (jump behavior unchanged).
  - Header pill: active team's own due badge renders with the right count; the left-side summary is absent when only the active team has due items, and shows the correct total when other teams do too; clicking it opens the unfiltered panel.
  - Team switcher dropdown badge: clicking it opens the filtered panel and does not switch the active team; the switcher dropdown itself closes.
- `palette.test.ts` additions: the "⏰ Due" row appears first and, when clicked, calls the `onOpenDue` callback (not `pm.openInFocused`) and closes the palette; typing a query that doesn't match "due" filters the row out same as any other item.
- `panes.test.ts`: existing `filterModuleItems` test is unaffected by the generic signature (T inferred as `ModuleItem` there) — no changes needed, just confirms the refactor is behavior-preserving.

## Out of scope

- No change to `collectDueItems`/`DueBuckets`/`isOverdue` in `core/due.ts` — filtering by team is a UI-layer concern applied to already-computed buckets.
- No new i18n keys — the palette entry and filtered modal title reuse existing `due_panel_title`/`due_badge_title` strings with the same `·`-separator convention used elsewhere.
- The global due-items total shown by the sidebar's own ⏰ button (visible only when the sidebar is expanded) is unchanged; the header pill's new summary only covers the collapsed-sidebar case where that button is hidden.
