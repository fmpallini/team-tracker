# Favorites — design

Date: 2026-10-06

## Goal

Let the user star a pane's current location and jump back to it quickly from anywhere, across teams, by mouse (header dropdown) or keyboard (global hotkey).

## Agreed behavior

- Every pane bar has a ☆/★ toggle beside the print (🖨️) and split (⧉) buttons. ☆ = not a favorite, ★ = favorite. Disabled while the pane is empty (same rule as print).
- The header has a ★ button that opens a favorites panel. Choosing an entry switches to that entry's team if needed and loads the entry into the **focused pane** (normal navigation, so it lands in that pane's back/forward history).
- A global hotkey, **Ctrl+Alt+F**, toggles the same panel. Inside it: ↑/↓ move the selection, Enter jumps, Esc closes, 1–9 jump straight to that row (rows show a number badge).
- A favorite points at: team + module kind, plus the person for person notes, or the specific date for daily notes. The `itemId` of actions/milestones/risks is dropped, so those favorites open the module, not a card.
- Favorites are global (all teams in one list), ordered by when they were starred, and live in the `.tmv` document.

## Non-goals (v1)

Reordering, folders, per-team lists, per-favorite hotkeys, type-to-filter (would clash with the 1–9 keys; the list is short).

## Data

```ts
export interface Favorite { teamId: string; ref: ModuleRef }   // ref never carries itemId
export interface Doc { …; favorites: Favorite[] }
```

- `SCHEMA_VERSION` 14 → 15. `MIGRATIONS[14]`: `d.favorites = []` (guard: keep an existing array). Opening a v14 file yields `favorites: []`; opening a newer file still throws `SchemaTooNewError`.
- Identity key: `teamId|kind` + `|personId` (person) or `|date` (daily). One pure function `favoriteKey(loc)` is the only place that decides equality; it also strips `itemId`.
- Document validation on open (the field-type tables in `core/document.ts`) must accept `favorites` and reject malformed entries by name, like the other top-level arrays.
- Team export/import does not carry favorites (they reference team ids that get remapped on import).

### Core API (`src/core/favorites.ts`, pure, unit-tested)

- `favoriteKey(loc: Loc): string`
- `isFavorite(doc, loc): boolean`
- `toggleFavorite(doc, loc): void` — mutates the passed doc; callers wrap it in `store.update`.
- `resolveFavorites(doc, locale): { fav: Favorite; label: string }[]` — drops entries whose team, or person (for person refs), no longer exists, and builds each label.

### Stale entries

Filtered at read time (`resolveFavorites`), not pruned when the team or person is deleted. Ids are never reused, so a dead entry is inert, and this avoids touching every team/person delete path. The ★ state in a pane is computed from the live list, so a stale entry can never light a star. Dead entries are removed for good by the Prefs → Data cleanup (next section).

### Data cleanup also purges dead favorites

The "Limpeza de dados / Data cleanup" action in Prefs → Data (`core/cleanup.ts`, `ui/prefs.ts`) clears dead favorites in the same pass. A favorite is **dead** when either:

1. its team no longer exists, or it is a person favorite whose person no longer exists (same predicate `resolveFavorites` uses to filter; share one `isFavoriteDead(doc, fav)` helper so the two cannot drift), or
2. it is a daily-note favorite whose date is older than the cleanup's day cutoff (`isOlderThan(date, days, today)`), since cleanup is deleting that day's note and the favorite would point at an empty day.

Wiring:
- `CleanupCounts` gains `favorites`; `countCleanupTargets` counts dead favorites and `applyCleanup` removes them (`doc.favorites = doc.favorites.filter(f => !dead(f))`).
- The "nothing to clean" check in `doCleanup` includes `counts.favorites === 0`, so a document whose only garbage is dead favorites still gets a confirm and a purge.
- The confirm message gains a `{favorites}` count, and the heading hint text mentions favorites.
- Like the other targets, this is not undoable; the existing no-undo warning covers it.
- Order inside `applyCleanup` does not matter: cleanup never deletes teams or people, so rule 1 is unaffected by the rest of the pass. Rule 2 does not depend on a note existing, only on its date.

## Mutation and scope

`toggleFavorite` goes through `store.update` (marks dirty so autosave persists it). It changes only `doc.favorites`, which no module renders from. Decision: the call is **unscoped** in v1 — a toggle is rare and a redundant full render is cheap, while a wrong narrow scope would leave a pane star stale (the `scope.ts` contract). A `'favorites'` `Section` is a later optimization, not part of this change.

## UI

### Pane star (`src/ui/panes.ts`, `renderBar`)

New button left of `printBtn` in `tt-pane-bar-right`, class `tt-btn tt-pane-fav-btn`. Reads `isFavorite(store.doc, cur)`, toggles via `store.update`. Tooltip: add / remove favorite (i18n). Both panes re-render from the store, so starring in one updates the other if it shows the same location. Fixed-size icon like the neighbors so the bar does not overflow at large text sizes.

### Favorites panel (`src/ui/favorites.ts`, new)

- Opened from the header ★ (`shell.ts`, `headerRight`, before the save pill; new `onFavorites(cb)` + `setFavoritesEnabled(bool)` on `Shell`, mirroring `onHelp`/`setAppNameEnabled`) and from the hotkey. One component, one open/close state.
- Positioned `position: fixed` under the header's right edge, **not** relative to the ★ button, so the hotkey still works when the compact header hides the button.
- Disabled / no-op with no teams (same rule as the palette and search bar). With teams but no favorites it shows a one-line hint.
- Row: number badge (1–9, none after 9) · `team emoji + team name · module title`. Module title reuses `titleFor` (person shows the name, daily shows the date). A trailing ✕ unfavorites the row without closing the panel.
- Keyboard: same capture-phase `keydown` pattern as `palette.ts`, including the `blockedByBlockingModal()` guard and `dismissModelessModals()` before navigating. Selection painting uses `select-list.ts` (`paintSelection`, `clampMove`, `selectableRowProps`) so hover never rebuilds the list (the Chrome loop documented there).
- Commit: `dismissModelessModals()`, close, switch team if different (existing team-switch path), then `pm.openInPane(focusedPane, loc)`.

### Hotkey (`src/ui/app-hotkeys.ts`, `main.ts`)

`{ type: 'favorites' }` for Ctrl/Cmd+Alt+F, gated by `comboHotkeyAllowed` like `closeFile`, no `shiftKey`. `main.ts` toggles the panel. Documented in the global help modal. Unit case added to the routing table tests.

## Large-font hardening

From the earlier layout fixes (69cc774, dc3487f, 21a9242, 877ef13):

- All dimensions in `rem`; follows `html[data-size]` XS–XL.
- Panel width `min(30rem, 92vw)`, clamped to the viewport; list has its own `max-height` + scroll.
- Rows are one line: `white-space: nowrap`, ellipsis, full text in `title`. Badge and ✕ are fixed-width, non-shrinking flex items.
- The header ★ belongs to the optional set `setHeaderCompactSpaceHidden` hides; re-check the compact threshold at XL (the 21a9242 bug class).

## i18n

New keys in both `pt-BR` and `en-US`: pane star add/remove titles, header button title, panel hint when empty, unfavorite ✕ title, help-modal hotkey line. Existing keys `data_cleanup_hint`, `data_cleanup_confirm_body` (new `{favorites}` placeholder) and `data_cleanup_nothing_body` are reworded in both locales to mention favorites.

## Testing

- Unit: migration 14→15 and unchanged v15 passthrough; `favoriteKey` (itemId stripped, person/date distinct); `toggleFavorite`; `resolveFavorites` stale filtering + labels; document validation of malformed `favorites`; `resolveAppHotkey` Ctrl+Alt+F (allowed / blocked in editors / no match with Shift).
- Cleanup (`test/cleanup.test.ts`): `countCleanupTargets`/`applyCleanup` count and remove favorites for a deleted team, a deleted person, and a daily favorite older than the cutoff; keep a live team/person favorite, a daily favorite exactly at or inside the cutoff, and non-daily favorites regardless of age; a doc whose only target is a dead favorite is not "nothing to clean". `prefs` test: confirm message includes the favorites count.
- jsdom: pane star toggles and re-renders; empty-pane disabled; panel keyboard (↑/↓/Enter/Esc/1–9); ✕ removes; empty hint; disposal releases the keydown listener and store subscription (`test/lifecycle.test.ts`-style).
- E2E (`e2e/`, in the style of `font-size-layout.spec.ts`): star a pane, switch team, open via hotkey and via header button, jump lands in the focused pane; at M and XL with long team/person names, no row wraps, nothing overflows the viewport, ★ does not collide with the search box across window widths.
- Every new `src` module has a matching `test/*.test.ts` (`core/favorites.ts`, `ui/favorites.ts`).

## Release

Feature → `package.json` version bump with a matching non-empty `## [X.Y.Z]` entry in `CHANGELOG.md` (load the `changelog` skill when writing it). Work lands directly on `dev`.
