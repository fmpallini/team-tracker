# Team Tracker — @ references for risks/action items/milestones + palette parity (design)

Date: 2026-07-18. Approved by user on this date (text-only brainstorming, no visual companion — logic/interaction features, not layout ones).

## Goal

Today `@` mentions in free-text notes (any editor: daily notes, person notes, action items, milestones, risks) can only reference a person or a day. Three gaps to close, bundled into one spec because they all read from the same team data and share one new helper:

1. **Extend `@` mentions** to also reference action items, milestones, and risks — clickable, and they navigate to the specific item (like search does), not just the board.
2. **Always suggest `@today`** (and the other two relative-day words) even before the user types anything after `@`, so the capability is discoverable.
3. **Command palette (Ctrl+K) parity** — let it jump straight to a named risk/milestone/action item, not just to a whole board. Currently only people get per-item entries there.

Plus one unrelated small bugfix bundled in because it's in the same file the palette work touches:

4. **Palette click-to-select is broken** — clicking a row does nothing; only arrow keys + Enter work. Root cause: `onmouseenter` calls `renderList()`, which rebuilds every row from scratch, so a stationary pointer's `mousedown`/`mouseup` land on two different (rebuilt) DOM nodes and the browser never synthesizes a `click`. This exact bug was already found and fixed twice in this codebase (`src/ui/atref.ts`, `src/ui/template-picker.ts`) but `src/ui/palette.ts` was written without the fix.

## Decisions (from brainstorming)

1. **Autocomplete grouping**: results grouped by type with headers (People / Risks / Action Items / Milestones), not a flat ranked or fixed-order list.
2. **Item status**: no filtering — done milestones, cancelled action items, closed risks are still referenceable, matching how `core/search.ts` has no status filter either.
3. **Result cap**: 5 per group, ~20 total, to keep the dropdown compact even on an empty query (unlike people today, which is uncapped).
4. **`@today` discoverability**: typing bare `@` immediately shows all three relative-day words (today/yesterday/tomorrow), not just "today" — they already behave identically once a letter is typed, so pinning only one would be inconsistent.
5. **Chip styling**: each ref chip gets a small icon prefix per type, reusing the exact emoji already used for this purpose in `search-ui.ts`'s `KIND_ICON` (📅 🧑 ✅ 🚩 ⚠️), relocated somewhere both files import instead of duplicated.
6. **Data plumbing**: one bundled `teamRefCandidates(team)` helper (approach B) rather than four parallel getter callbacks per module call site — modeled on `search.ts`'s existing `collectCandidates`, so title/summary field extraction lives in exactly one place instead of five.
7. **Dangling-reference click behavior**: person keeps its existing "not found" toast (id no longer exists in stakeholders/members). The three new types match search's existing graceful behavior instead — open the board unconditionally via `pm.openInPane`, best-effort scroll to `[data-item-id="..."]` if the card still exists, silent no-op otherwise. No toast for these three, since "board opens, nothing highlighted" is already how search treats a stale scroll target.
8. **Palette**: flat list, substring filter, no cap — unchanged from how it already handles the (uncapped) person list. New per-item entries get the same icon prefix as the chips, appended after each type's existing whole-board entry.

## Data layer

### `teamRefCandidates` (new, exported from `core/search.ts` alongside `KIND_ICON`)

```ts
export interface RefCandidate { id: string; title: string }
export interface TeamRefCandidates {
  people: AtPerson[]  // reuses ui/atref.ts's existing shape: { id, name, group }
  actionItems: RefCandidate[]
  milestones: RefCandidate[]
  risks: RefCandidate[]
}
export function teamRefCandidates(team: Team): TeamRefCandidates
```

Extraction mirrors `collectCandidates` exactly: action item title = `summary`, milestone/risk title = `title`. `search.ts`'s existing `collectCandidates` is left as-is (it needs the note bodies too, for full-text search) — this is a separate, smaller helper for "id + title only," which is all the picker and palette need.

### `KIND_ICON` relocation

Moves from `search-ui.ts` to `core/search.ts` (both files already import from there), unchanged content:

```ts
export const KIND_ICON: Record<SearchResult['moduleKind'], string> = { daily: '📅', person: '🧑', stakeholders: '👥', members: '👥', actions: '✅', milestones: '🚩', risks: '⚠️' }
```

`search-ui.ts` switches to importing it. `atref.ts` and `panes.ts` import it too.

## Feature 1 — Extended `@` mentions

### Storage format (`core/markdown.ts`)

`@[Label](kind:id)` regex extended from `person:[^)\s]+|day:\d{4}-\d{2}-\d{2}` to also accept `action:[^)\s]+|milestone:[^)\s]+|risk:[^)\s]+`. `RefInfo['target']` union and `parseRef` gain the three new `{ kind: 'action' | 'milestone' | 'risk'; id: string }` variants.

### `AtItem` union (`ui/atref.ts`)

```ts
export type AtItem =
  | { kind: 'person'; id: string; name: string }
  | { kind: 'day'; date: string }
  | { kind: 'action' | 'milestone' | 'risk'; id: string; title: string }
```

### `filterAtItems`

Signature changes from `(people, typed, locale)` to `(candidates: TeamRefCandidates, typed, locale)`. Returns items already ordered group-by-group (people, day, actions, milestones, risks), each group capped at 5 via substring match (`normalize(title).includes(q)`, same as people today). Relative-day words: the `trimmed !== ''` guard is dropped so they're included even on an empty query (decision 4); the complete-date-parse branch (`parseLocaleDate`) is untouched.

### Dropdown rendering

`renderList()` inserts a `tt-atref-group-header` row (using existing i18n module-name keys: `module_actions`, `module_milestones`, `module_risks`, plus a new `atref_group_people`/`atref_group_dates`) whenever the group of the current item differs from the previous one. Keyboard nav (`ArrowUp`/`ArrowDown`) skips header rows — they're not selectable, `items` stays the flat selectable list, headers are computed at render time from item boundaries.

### `commit()`

Label for the three new kinds = the candidate's `title` (same `safeLabel` bracket-stripping as today). `chip.dataset.ref` = `` `${kind}:${id}` ``. Icon prefix: chip content becomes `${KIND_ICON[iconKindFor(item.kind)]} ${safeLabel}` — a small mapping from `AtItem['kind']` to `SearchResult['moduleKind']` (`action`→`actions`, `milestone`→`milestones`, `risk`→`risks`, `person`→`person`, `day`→`daily`) since the two kind-string vocabularies differ slightly (`markdown.ts`'s ref prefixes are singular, `ModuleRef['kind']` is plural for these three).

### `makeRefClickHandler`

New branches for `action`/`milestone`/`risk`: `pm.openInPane(paneIdx, { teamId, ref: { kind: 'actions'|'milestones'|'risks', itemId: target.id } })`, then (mirroring `search-ui.ts`'s `commit()`) a `requestAnimationFrame` best-effort `paneEl.querySelector('[data-item-id="..."]')?.scrollIntoView({ block: 'center' })` — no highlight (no search terms to highlight), no toast if missing.

### Call sites (5 modules: action-items, risks, milestones, daily-notes, person-notes)

Each changes `getPeople` to `getRefCandidates: () => teamRefCandidates(findTeam())` (or equivalent team lookup already present in each file).

## Feature 2 — Command palette per-item entries

### `buildModuleItems` (`ui/panes.ts`)

After each `FIXED_MODULE_KEYS` whole-board entry, push one `ModuleItem` per item using `teamRefCandidates(team)`:

```ts
for (const it of candidates.actionItems) items.push({ label: `${KIND_ICON.actions} ${it.title}`, ref: { kind: 'actions', itemId: it.id } })
for (const m of candidates.milestones) items.push({ label: `${KIND_ICON.milestones} ${m.title}`, ref: { kind: 'milestones', itemId: m.id } })
for (const r of candidates.risks) items.push({ label: `${KIND_ICON.risks} ${r.title}`, ref: { kind: 'risks', itemId: r.id } })
```

`filterModuleItems` and `commit()` need no changes — they already operate generically on `ModuleItem[]` and `pm.openInFocused(loc)` already handles any `ModuleRef`, including `itemId`-bearing ones (same path search already uses).

## Feature 3 — Palette click-to-select fix (`ui/palette.ts`)

Mirrors `template-picker.ts`'s fix exactly:

```ts
onmousedown: (e: Event) => e.preventDefault(),
onclick: () => commit(item),
onmouseenter: () => { selected = i; updateSelectedClass() },  // was: renderList()
```

Plus a new `updateSelectedClass()` (identical to `atref.ts`'s), toggling `.selected` on existing children instead of rebuilding. `ArrowUp`/`ArrowDown` keep calling full `renderList()` — they don't race a pointer, no bug there.

## i18n

New keys (both `pt-BR` and `en-US`): `atref_group_people`, `atref_group_dates` (the two group headers with no existing module-name key to reuse — `actions`/`milestones`/`risks` groups reuse `module_actions`/`module_milestones`/`module_risks`).

## Testing

- `test/search.test.ts` (or a new `test/ref-candidates.test.ts`): `teamRefCandidates` extraction correctness (id/title per type), and `KIND_ICON` import still resolves from its new home.
- `test/atref.test.ts`: `filterAtItems` — grouping order, 5-per-group cap, bare-`@` shows all three relative days, substring match on action/milestone/risk titles, done/cancelled/closed items still included.
- `test/markdown.test.ts`: `parseRef` accepts `action:`/`milestone:`/`risk:` prefixes; round-trip through `mdToHtml`/`htmlToMd` preserves the new ref types.
- `test/action-items.test.ts` / `test/risks.test.ts` / `test/milestones.test.ts`: `makeRefClickHandler` opens the board + scrolls to the item when present, no-ops silently (no toast, no throw) when the id no longer exists.
- `test/panes.test.ts`: `buildModuleItems` includes one entry per action item/milestone/risk with the right label/ref.
- `test/palette.test.ts`: clicking a row (not just Enter) commits it — regression test for the mouseenter/rebuild race; `updateSelectedClass` updates highlight without touching row identity (a captured node reference stays the same DOM node across a hover).

## Out of scope

- No live-updating labels — a chip's label is frozen text at insert time (matches existing person/day behavior), not a live lookup. Renaming an item doesn't update chips that already reference it.
- No cascade/cleanup on delete — a chip referencing a deleted item just becomes a dead link (graceful per decision 7), nothing scans/rewrites existing note text on delete.
- No cross-team references — candidates are always scoped to the note's own team, matching how person refs already work.
- No change to `core/search.ts`'s own full-text search or its `RESULT_LIMIT` — this is a separate, smaller "id + title" picker, not a replacement for full-text search.
- No fuzzy/ranked matching — substring match only, same as people today.
