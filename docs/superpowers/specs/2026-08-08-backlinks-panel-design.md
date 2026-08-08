# Backlinks panel — design

## Problem

`@[label](kind:id)` mentions (`core/refs.ts`) are one-way. Viewing a person,
day, action, milestone, or risk gives no way to see what *points at* it — a
person's notes don't show which risks/actions mention them, a daily note
doesn't show which person notes reference that day. Auto-unlink-on-delete
already proves the app tracks these links structurally; nothing surfaces
them to the user.

## Solution

A small count badge/chip on every referenceable item, showing how many
mentions point at it. Clicking it opens a popover listing each backlink
(grouped by source kind, with a one-line snippet), and clicking a row
navigates there — reusing the exact pane/modifier-key behavior forward
`@ref` clicks already have.

Scope: the 5 existing `RefKind`s (`person`, `day`, `action`, `milestone`,
`risk`). General notes stays source-only — there is no `general` ref kind
and this design doesn't add one, so general notes never shows a badge.

## Data model

No schema change. Backlinks are computed, not stored — same reasoning as
`core/due.ts`'s overdue/due-soon buckets: cheap to recompute at this app's
scale (one person's/team's worth of notes, not a corpus), so there's no
cache to keep coherent with edits.

## Computation (`src/core/search.ts`)

`collectCandidates(team, doc)` already enumerates the exact 6 free-text
fields backlinks need to scan (daily notes, general notes, person notes,
action notes, milestone followup, risk followup) with each field's `raw`
text, display `title`, and owning `ModuleRef`. Add a sibling function next
to it, reusing that enumeration instead of a 4th copy (search's own
candidates, `unlinkRefsInTeam`, and this make three; a `general` entry stays
in the scan since `collectCandidates` already includes it as a source, even
though it can never be a backlink *target*):

```ts
export interface Backlink {
  loc: { teamId: string; ref: ModuleRef } // where the mention lives
  moduleKind: ModuleRef['kind']            // for KIND_ICON + group header
  title: string                            // source item's display title
  snippet: string                          // text around the mention
}

export function collectBacklinks(team: Team, doc: Doc, kind: RefKind, targetId: string): Backlink[]
```

For each candidate, run `refPattern(kind)` (from `core/refs.ts`) over its
*raw* (not `stripMd`'d — stripping already collapses `@[label](ref)` down to
`label`, destroying the very target id being matched) text via `matchAll`,
keep matches whose `kind:target` suffix equals `targetId`, and build one
`Backlink` per match with a small (~60-char radius, reusing the shape of
`search.ts`'s existing `SNIPPET_RADIUS`/snippet-trim logic, extracted into a
shared helper) plain-text snippet around it. `stripMd` still runs on the
snippet text itself after slicing, so mentions inside it render as their
label rather than raw `@[…](…)` syntax.

`day` targets key by ISO date string (matching `refPattern`'s existing `day`
target format), not an item id — `collectBacklinks(team, doc, 'day',
'2026-08-08')`.

No `invalidate`/index wrapper: call sites call `collectBacklinks` directly
during their own render, the same way `sidebar.ts` calls
`collectDueItems(doc, today)` fresh off `store.subscribe`. It naturally
recomputes whenever the hosting module's own store subscription re-renders.

## UI: badge (note modules)

`src/modules/daily-notes.ts` and `src/modules/person-notes.ts` each render a
header (date title / `tt-person-header`). Both gain a small pill —
`↩ {count}` — placed after the existing header content, rendered only when
`count > 0` (hidden at zero, per the note-header mockup already approved).
Clicking it opens the backlinks popover anchored to the badge.

## UI: chip (board modules)

Placement differs by module because their row shapes differ:

- **`src/modules/action-items.ts`**: `renderCard`'s `metaEl`
  (`tt-kanban-card-meta`, currently due date / assignee / color tag) gains
  the chip as a trailing entry, pushed to the row's end (`margin-left:
  auto`) per the approved "footer chip inline with tags" mockup. Rendered
  only when `count > 0`.
- **`src/modules/milestones.ts`** / **`src/modules/risks.ts`**: these rows
  are spreadsheet-style (date/title/checkbox + icon-button cluster), with no
  existing tag/meta row to join. The chip goes in the icon cluster, before
  `expandBtn`, matching that cluster's existing small-button sizing rather
  than the tag-row treatment — same pill visual language as the other two
  placements, adapted to the row it actually has. Rendered only when `count
  > 0`.

All three read `collectBacklinks(team, doc, 'action'|'milestone'|'risk',
item.id)` inline during their existing per-item render — no new
subscription, since these renderers already re-run on every relevant store
change.

## UI: popover panel (`src/ui/backlinks-panel.ts`, new)

Mirrors `src/ui/context-menu.ts`'s structure: fixed-position overlay
anchored at the trigger element, module-level `closeCurrent` singleton (a
second panel opening closes the first), dismissed by Escape or
`bindOutsideDismiss` (`src/ui/dom.ts`).

```ts
export function showBacklinksPanel(
  anchor: HTMLElement,
  backlinks: Backlink[],
  onNavigate: (loc: Loc, opts: { secondary: boolean }) => void
): void
```

Rows grouped by `moduleKind` under a small header using `KIND_ICON`
(`core/search.ts`) — the same icon set search results already use, so the
vocabulary matches. Each row shows the source `title` and `snippet`, and is
itself the click target. A row click reads the same modifier signal
`editor.ts`'s ref-chip click already computes (`ctrlKey || metaKey ||
button === 1`) and calls `onNavigate(loc, { secondary })`.

## Navigation

Callers wire `onNavigate` to the *same* routing `makeRefClickHandler`
(`src/ui/atref.ts`) already does for forward ref clicks — `openSecondary =
store.doc.prefs.openRefsInSecondaryPane || opts.secondary`, then
`pm.openInSecondaryPane` vs `pm.openInPane` — rather than a parallel
implementation. For item-based targets (action/milestone/risk source
locations), the existing post-navigation `requestAnimationFrame`
scroll+highlight step (querying the landed pane, `dispatchSearchFocusItem`,
`applySearchHighlight`) applies identically. Concretely: `atref.ts` exports
this routing as a small reusable function (factored out of
`makeRefClickHandler`'s body, which now calls it too) so both forward-ref
clicks and backlink-row clicks share one implementation instead of two.

## i18n (`src/core/i18n.ts`)

New keys (`pt-BR` and `en-US`):
- `backlinks_badge_title` — badge/chip tooltip, e.g. "3 references" (count
  interpolated).
- `backlinks_panel_empty` — defensive empty state (shouldn't be reachable
  since the badge only renders at `count > 0`, but the panel component
  shouldn't assume it).

## Testing

- `test/search.test.ts` (or a new `test/backlinks.test.ts` alongside it) —
  `collectBacklinks`: matches across all 6 source fields, filters by
  `targetId`, `day`-kind keys by date string, snippet trimming, zero-match
  returns `[]`, a field with multiple mentions of the same target yields
  multiple entries (one per mention, not deduped per source).
- `test/atref.test.ts` — the factored-out routing function used by both
  forward-ref clicks and backlink rows, covering the same pref/modifier
  matrix the existing tests already cover for `makeRefClickHandler`.
- `test/daily-notes.test.ts` / `test/person-notes.test.ts` — badge renders
  at `count > 0` with correct count, absent at 0, click opens panel.
- `test/action-items.test.ts` / `test/milestones.test.ts` /
  `test/risks.test.ts` — chip renders in the right slot per module, same
  zero-count hiding.

## Out of scope

- No reverse index/cache — revisit only if real documents show this is
  measurably slow, matching `due.ts`'s existing no-cache precedent.
- No backlinks for `general` notes (no ref kind targets it).
- No panel styling/positioning polish beyond what `context-menu.ts` already
  provides (viewport-edge clamping etc. inherited as-is, not redesigned
  here).
