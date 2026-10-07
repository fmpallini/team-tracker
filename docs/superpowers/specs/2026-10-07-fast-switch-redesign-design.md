# Fast switch redesign — design

Date: 2026-10-07

## Goal

Make the fast switch (Ctrl+Shift+K, or the app-name button) the single place to jump anywhere: favorites, due items, the current team, and every other team. The separate favorites dropdown, header button and hotkey go away; their jobs (jumping to a favorite, removing one) move into the fast switch.

## Agreed behavior

- The fast switch lists rows in four sections, in this order:
  1. **Favorites** — every live favorite (`liveFavorites`), across all teams.
  2. **Due dates** — individual overdue and due-soon items (action items and milestones) across all teams, from `collectDueItems`. This replaces the old single "Due" row that opened the due modal.
  3. **Current team** — what the palette lists today for the active team: Daily, General notes, people, the Stakeholders/Members/Tasks/Milestones/Risks lists, and each task, milestone and risk card.
  4. **Other teams** — the same rows for every other team (full content, not just shortcuts).
- With an empty query, sections 1–3 show and section 4 is hidden. Other teams appear only once there is a query.
- The query is normalized (case- and accent-insensitive) and split on whitespace. A row matches when **every** word is a substring of `"<team name> <row title>"`, so "alpha risks" narrows to the Risks rows of a team called Alpha. A query of only whitespace counts as empty.
- A section with no matches (or no rows) shows no heading. When nothing matches at all, a single "No results" line shows and Enter does nothing.
- Enter or click on a row on another team switches to that team first (`selectTeam`), then opens the row in the focused pane via `pm.openInFocused`. Card rows keep the current expand-and-highlight behavior. Rows on the active team skip the team switch.
- Favorite rows have a ✕ button that removes the favorite. It does not commit the row, keeps the palette open, and repaints the list in place.

## Section delimitation

Each section is visibly separated, reusing the look of `tt-due-section-heading` from the due panel:

- A heading row per section: small, uppercase, muted label with the section's icon (⭐ Favorites, ⏰ Due dates, the team emoji + name for Current team, 🗂️ Other teams), plus the row count when the section is truncated (e.g. "Other teams · 4 of 11").
- A thin top border and extra vertical spacing on every heading except the first one, so sections read as separate groups even when scanning quickly.
- Headings are non-interactive (not selectable, skipped by arrows and hover). Each section is a `role="group"` labelled (`aria-labelledby`) by its heading, so screen readers announce section changes. No `listbox`/`option` roles: a Favorites row contains the ✕ button, and an interactive control inside an `option` fails axe's nested-interactive rule.
- Sizes are rem, so headings follow the text-size setting.

## Row limit

At most **20 rows** in total, headings not counted. Allocation:

1. Each section with matches gets `min(matches, 4)` rows.
2. The remaining slots go out in round-robin passes in section order (Favorites, Due, Current team, Other teams): each pass gives one more row to every section that still has unshown matches, until 20 rows are used or nothing is left. With every section full that is one extra row each (5/5/5/5); with only two sections it is 10/10; with one section it is 20.

Rows keep their natural order inside a section. Favorites keep the order they were starred in; due items keep overdue-then-due-soon order (as returned by `collectDueItems`); other teams are in team order. No scoring or ranking.

## Team labeling

Rows in Favorites, Due dates and Other teams carry a right-aligned badge: team emoji + team name, the same look as the due panel's `tt-due-row-team`. Current-team rows have no badge, because the heading for that section already names the team (`<emoji> <team name>`). The Other teams heading is a plain "Other teams" label. Due rows additionally show the relative date label the due panel uses ("2 days overdue", "in 3 days").

Long titles and team names ellipsize; the row's `title` tooltip carries the full text.

## Deduplication

A module-level row in Current team (Daily for today, General notes, a person, or one of the five lists) is dropped when the same location is already in Favorites. The check uses `favoriteKey`, which ignores `itemId`. Card rows (task, milestone, risk with an `itemId`) are never dropped, because a favorite opens the module, not a card.

## Removed

- Header ★ button: `favoritesBtn`, `onFavorites`, `setFavoritesEnabled` in `ui/shell.ts`, and the `syncFavoritesBtn` wiring in `main.ts`.
- `ui/favorites.ts` (the panel) and its CSS (`.tt-favorites-*`, `.tt-btn-favorites`).
- Ctrl+Alt+F: the `favorites` action in `ui/app-hotkeys.ts`, its dispatch in `main.ts`, and the help line.
- The 1–9 jump keys of the old panel. The fast switch is a text field and keeps its arrow/Enter/Esc keys only.
- i18n keys left unused (both locales): `favorites_btn_title`, `favorites_panel_label`, `favorites_empty`, `help_global_favorites`. The pane-bar keys `pane_fav_add_title` and `pane_fav_remove_title` stay.
- The `search-ui.ts` insert-before-the-★ logic, now that the star is gone.

## Kept

- The pane-bar ☆/★ toggle. It is the only way to add a favorite.
- `doc.favorites`, `core/favorites.ts` (`toggleFavorite`, `liveFavorites`, `favoriteKey`, …), Prefs → Data cleanup of dead favorites. **No schema change, no migration.**
- The header's compact breakpoint (840 px) stays as is. It was widened in 2.10.0 partly for the ★; revisiting it is a separate change.

## Architecture

- **New `src/core/switcher.ts`** (pure, no DOM, unit-tested). Builds the section model from the `Doc`, the query and the locale:

  ```ts
  export interface SwitcherRow {
    label: string            // title text, icon included (as buildModuleItems does today)
    teamId: string
    ref: ModuleRef
    teamBadge?: string       // "😀 Alpha" — set for favorites, due and other teams
    dueLabel?: string        // due rows only
    favorite?: Favorite      // favorite rows only: what ✕ removes
  }
  export interface SwitcherSection { id: 'favorites' | 'due' | 'current' | 'others'; heading: string; rows: SwitcherRow[] }
  export function buildSwitcher(doc: Doc, query: string, locale: Locale, today: string): SwitcherSection[]
  ```

  It applies the match, the dedupe, and the 20-row allocation. It returns only non-empty sections.
- **New `src/core/module-items.ts`**: `buildModuleItems(team, locale)` and `titleFor(doc, loc, locale)` move here from `ui/panes.ts`, because `switcher.ts` needs them for every team and `core/` must not import from `ui/`. `titleFor` only reads `store.doc`, so it takes a `Doc` instead of a `Store`. `ui/panes.ts` imports both back for the pane module dropdown and the pane titles; `ui/favorites.ts` (its other caller) is deleted. `panes.test.ts` imports update accordingly.
- **`ui/palette.ts`** keeps overlay, input, keyboard handling, `dismissModelessModals` guard and `select-list.ts` row mechanics. It now renders section headings, badges and the ✕, and takes a new dep for `selectTeam`: `createPalette(store, pm, { selectTeam })`. The `onOpenDue` callback is no longer needed and is removed (the sidebar's `openDuePanel` stays, used by its own buttons).
- Arrow keys skip headings (they are not rows). Selection index counts rows only.
- Rebuild rules: typing rebuilds the list; hover/arrow selection repaints in place (`paintSelection`); the ✕ rebuilds, then keeps the selection near where it was.
- The palette is built from the store at open and on each keystroke. It does not subscribe to the store, same as today.

## Edge cases

- No teams: the palette still does not open (unchanged guard).
- One team: Other teams section never has rows.
- Orphaned favorites (team or person deleted) are not shown (`liveFavorites`).
- A favorite for the active team shows in Favorites and its module-level twin is removed from Current team (see Deduplication).
- Teams with no due dates: Due dates section absent.
- No active team although teams exist (should not happen after open): there is no Current team section, and Other teams shows even with an empty query so the box is never blank.
- Ctrl+Shift+K while a card modal is open: unchanged — `dismissModelessModals` runs before commit.
- Large documents: building rows for all teams on every keystroke is plain array filtering over titles; no body text is scanned, so it stays cheap.

## i18n

New keys (pt-BR and en-US): section headings for Favorites, Due dates and Other teams; updated `palette_placeholder` (it no longer says "module" only; mention that other teams are searched). `help_global_palette` text is reviewed to say it reaches every team.

## Testing

- `test/switcher.test.ts` (new): section order; empty query hides Other teams; match on title and team name; per-section minimum of 4 and leftover distribution; total ≤ 20; dedupe of module rows vs favorites but not card rows; orphaned favorites hidden; due ordering and labels; headings absent for empty sections.
- `test/palette.test.ts`: headings render and are skipped by arrows; team badge present/absent per section; ✕ removes the favorite without committing and without closing; a row on another team calls `selectTeam` before `openInFocused`; card highlight still works.
- Delete `test/favorites-panel.test.ts`. Update `test/shell.test.ts`, `test/app-hotkeys.test.ts`, `test/help.test.ts`, `test/i18n.test.ts` (key parity) for the removals.
- `e2e/favorites.spec.ts`: rework to star a pane with ☆, open the fast switch, find the favorite under Favorites, jump to it across teams, remove it with ✕. Remove header-★ and Ctrl+Alt+F steps. Check other e2e specs that mention the ★ button.

## Docs and release

- Update `README.md` and `docs/ARCHITECTURE.md` where they describe favorites or the palette.
- Bump `package.json` to 2.11.0 and add a `## [2.11.0]` entry to `CHANGELOG.md` (load the `changelog` skill for the rules). The entry must say plainly that the ★ header button and Ctrl+Alt+F are gone and that favorites now live in the fast switch.
- Work happens directly on `dev`; no feature branch or worktree.

## Non-goals

Ranking or fuzzy scoring; per-section configurable caps; searching note bodies from the fast switch (the header search box does that); reordering favorites; changing how favorites are stored or added.
