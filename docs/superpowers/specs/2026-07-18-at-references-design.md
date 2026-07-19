# Team Tracker — @ references for risks/action items/milestones + palette parity (design)

Date: 2026-07-18. Text-only brainstorming, no visual companion — logic/interaction features, not layout ones.

## Goal

Today `@` mentions in free-text notes (any editor: daily notes, person notes, action items, milestones, risks) can only reference a person or a day. Three gaps to close, bundled into one spec because they all read from the same team data and share one new helper:

1. **Extend `@` mentions** to also reference action items, milestones, and risks — clickable, and they navigate to the specific item (like search does), not just the board.
2. **Always suggest `@today`** (and the other two relative-day words) even before the user types anything after `@`, so the capability is discoverable.
3. **Command palette (Ctrl+K) parity** — let it jump straight to a named risk/milestone/action item, not just to a whole board. Currently only people get per-item entries there.
4. **Live labels** — a ref chip shows the referenced item's *current* name, not whatever it was called when the mention was typed. Renaming a person/action item/milestone/risk updates every chip that points to it.
5. **Auto-unlink on delete** — deleting a person/action item/milestone/risk rewrites every note that mentioned it, turning the chip back into plain text (`@[Label](kind:id)` → `Label`). No dead links left behind.

Plus one unrelated small bugfix bundled in because it's in the same file the palette work touches:

6. **Palette click-to-select is broken** — clicking a row does nothing; only arrow keys + Enter work. Root cause: `onmouseenter` calls `renderList()`, which rebuilds every row from scratch, so a stationary pointer's `mousedown`/`mouseup` land on two different (rebuilt) DOM nodes and the browser never synthesizes a `click`. This exact bug was already found and fixed twice in this codebase (`src/ui/atref.ts`, `src/ui/template-picker.ts`) but `src/ui/palette.ts` was written without the fix.

## Decisions (from brainstorming)

1. **Autocomplete grouping**: results grouped by type with headers (People / Risks / Action Items / Milestones), not a flat ranked or fixed-order list.
2. **Item status**: no filtering — done milestones, cancelled action items, closed risks are still referenceable, matching how `core/search.ts` has no status filter either.
3. **Result cap**: 5 per group, ~20 total, to keep the dropdown compact even on an empty query (unlike people today, which is uncapped).
4. **`@today` discoverability**: typing bare `@` immediately shows all three relative-day words (today/yesterday/tomorrow), not just "today" — they already behave identically once a letter is typed, so pinning only one would be inconsistent.
5. **Chip styling**: each ref chip gets a small icon prefix per type, reusing the exact emoji already used for this purpose in `search-ui.ts`'s `KIND_ICON` (📅 🧑 ✅ 🚩 ⚠️), relocated somewhere both files import instead of duplicated.
6. **Data plumbing**: one bundled `teamRefCandidates(team)` helper (approach B) rather than four parallel getter callbacks per module call site — modeled on `search.ts`'s existing `collectCandidates`, so title/summary field extraction lives in exactly one place instead of five.
7. **Dangling-reference click behavior**: with auto-unlink-on-delete (decision 5/9), a chip whose target has been deleted normally can't exist in the stored doc anymore — the delete rewrites it to plain text atomically. `makeRefClickHandler`'s existence check (open the board, best-effort scroll to `[data-item-id="..."]`, silent no-op if missing) stays only as a defensive fallback for edge cases outside the app's own control (hand-edited `.tmv` JSON, team-export/import merges from another file). No toast on any of the 4 non-day kinds — this makes person consistent with the other three instead of the other way around (person's old "not found" toast is removed).
8. **Palette**: flat list, substring filter, no cap — unchanged from how it already handles the (uncapped) person list. New per-item entries get the same icon prefix as the chips, appended after each type's existing whole-board entry.
9. **Delete handling scope**: auto-unlink applies uniformly to person, action item, milestone, and risk deletion (decision 5) — the same mechanism, not a special case per type. `day` is exempt: dates are never deleted.
10. **Rename scope**: live label resolution happens where `mdToHtml` renders a note (the one choke point — `editor.ts`'s `setMd`). Global search (`core/search.ts`) snippets keep showing whatever label text is literally stored — not worth threading live team lookups into every search keystroke for a preview snippet.

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

Label for the three new kinds = the candidate's `title` (same `safeLabel` bracket-stripping as today). `chip.dataset.ref` = `` `${kind}:${id}` ``. Chip *text content* stays exactly `@${safeLabel}` — unchanged from today, no icon inside it.

Icon prefix is **CSS-only**, not DOM text: `styles.css` gets `.ref[data-ref^="action:"]::before { content: "✅ "; }` (and one rule per prefix, reusing the `KIND_ICON` emoji). This matters because `markdown.ts`'s `inlineMd` (the html→markdown direction) derives the persisted label straight from `node.textContent` ([markdown.ts:53-56](src/core/markdown.ts#L53)) — if the icon were baked into the chip's text, it would round-trip into storage as part of the label (`"✅ Fix login bug"` saved forever). Keeping the icon in `::before` means `textContent` — and therefore `getMd()`'s output — never sees it.

### `makeRefClickHandler`

New branches for `action`/`milestone`/`risk`: `pm.openInPane(paneIdx, { teamId, ref: { kind: 'actions'|'milestones'|'risks', itemId: target.id } })`, then (mirroring `search-ui.ts`'s `commit()`) a `requestAnimationFrame` best-effort `paneEl.querySelector('[data-item-id="..."]')?.scrollIntoView({ block: 'center' })` — no highlight (no search terms to highlight), no toast if missing. The existing `person` branch drops its `toast_person_not_found` call for the same reason (decision 7) — it becomes just another `pm.openInPane` + best-effort scroll, no toast, consistent with the other three.

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

## Feature 4 — Live label resolution (rename support)

### `core/markdown.ts`

```ts
export type LabelResolver = (target: RefInfo['target']) => string | null
export function mdToHtml(md: string, resolveLabel?: LabelResolver): string
```

Threaded down through the existing `blockInline`/`inline` private helpers (both gain the same optional param). Inside `inline`'s ref regex replace: `parseRef(ref)` gives the target; if `resolveLabel` is provided and returns non-`null`, that resolved (and `esc()`-escaped) string is used as the chip's displayed label instead of the label captured from the stored markdown. `day` targets resolve too — `resolveLabel` returns `formatDate(target.date, locale)` in the *current* locale, fixing a separate latent staleness (a day chip inserted under `pt-BR` stayed pt-BR-formatted forever even after switching to `en-US`) for free, since it's the same code path.

`resolveLabel` omitted (its one other caller, `template-picker.ts`'s preview) falls back to the stored label exactly as today — template bodies aren't team-scoped, so there's nothing to resolve.

Because `inlineMd` (the reverse direction) reads the persisted label from the rendered chip's `textContent` ([markdown.ts:53-56](src/core/markdown.ts#L53)), this is self-healing with no extra plumbing: any note that gets re-rendered with a live resolver and then re-saved (`getMd()`) captures the then-current label into storage as its new frozen fallback. Notes that are never touched keep whatever stale text is in storage, but since every render still resolves live, *display* is always current regardless of what's stored — storage staleness is invisible to the user, and only ever matters as the fallback for decision 10 (search snippets, and the defensive dangling-ref path in decision 7).

### `EditorHooks` (`ui/editor.ts`)

New optional hook: `resolveRefLabel?: LabelResolver`. `setMd()` becomes `editorEl.innerHTML = mdToHtml(md, hooks.resolveRefLabel)`.

### Resolver factory (new, alongside `makeRefClickHandler` in `ui/atref.ts`)

```ts
export function makeRefLabelResolver(store: Store, teamId: string): LabelResolver
```

One shared implementation (mirrors `makeRefClickHandler`'s existing pattern) instead of duplicating the "look up id in stakeholders/members/actionItems/milestones/risks" switch across the 5 module call sites. Each site adds `resolveRefLabel: makeRefLabelResolver(ctx.store, teamId)` to its `createEditor(...)` hooks.

No re-render plumbing beyond this is needed: per the architecture notes in `CLAUDE.md`, `store.update()` already triggers a full content re-render on every mutation, and every module that embeds a persistent editor (milestones/risks/daily-notes/person-notes) already reconstructs that editor and calls `setMd()` fresh on each such re-render (confirmed in `milestones.ts`'s `renderFollowupRow`, [milestones.ts:200-218](src/modules/milestones.ts#L200)) — renaming an item anywhere already reaches every open note through machinery that exists today, no new listener needed.

## Feature 5 — Auto-unlink on delete

### `core/refs.ts` (new, pure, unit-testable)

```ts
export type RefKind = 'person' | 'action' | 'milestone' | 'risk'
export function unlinkRefsInText(text: string, kind: RefKind, ids: ReadonlySet<string>): string
export function unlinkRefsInTeam(team: Team, kind: RefKind, ids: string[]): void
```

`unlinkRefsInText` does one regex pass rewriting `@[Label](kind:id)` → `Label` for every `id` in `ids` matching `kind`, leaving every other ref (including `day:` refs, which are never in scope here) untouched. `unlinkRefsInTeam` applies it in place across every note-bearing field on the team, mirroring `search.ts`'s `collectCandidates` field list exactly: `dailyNotes` (every date), `stakeholders[].notes`, `members[].notes`, `actionItems[].notes`, `milestones[].followup`, `risks[].followup`. `day` has no delete path (dates aren't deletable), so `RefKind` has no `'day'` variant.

### Call sites — each existing delete, inside its own `store.update()`, ids captured before the filter removes them

- `people-tree.ts` ([people-tree.ts:226-230](src/modules/people-tree.ts#L226)): `unlinkRefsInTeam(tm, 'person', [person.id])`. `deletePerson()` only ever removes the one target id (children are reparented, not deleted — [people-tree.ts:114-125](src/modules/people-tree.ts#L114)), so no cascade to collect.
- `action-items.ts` single delete ([action-items.ts:165](src/modules/action-items.ts#L165)): `unlinkRefsInTeam(tm, 'action', [id])`.
- `action-items.ts` `clearZone` bulk delete ([action-items.ts:203](src/modules/action-items.ts#L203)): collects every removed id first (`tm.actionItems.filter(i => i.status === status).map(i => i.id)`) before filtering, then `unlinkRefsInTeam(tm, 'action', removedIds)` — this is the one multi-id case.
- `milestones.ts` ([milestones.ts:236](src/modules/milestones.ts#L236)): `unlinkRefsInTeam(tm, 'milestone', [id])`.
- `risks.ts` ([risks.ts:162](src/modules/risks.ts#L162)): `unlinkRefsInTeam(tm, 'risk', [id])`.

Same-team-only (decision 3's "no cross-team references" already established this), so each call only needs to scan the one team object already in hand — no doc-wide walk.

## i18n

New keys (both `pt-BR` and `en-US`): `atref_group_people`, `atref_group_dates` (the two group headers with no existing module-name key to reuse — `actions`/`milestones`/`risks` groups reuse `module_actions`/`module_milestones`/`module_risks`).

## Testing

- `test/search.test.ts` (or a new `test/ref-candidates.test.ts`): `teamRefCandidates` extraction correctness (id/title per type), and `KIND_ICON` import still resolves from its new home.
- `test/atref.test.ts`: `filterAtItems` — grouping order, 5-per-group cap, bare-`@` shows all three relative days, substring match on action/milestone/risk titles, done/cancelled/closed items still included.
- `test/markdown.test.ts`: `parseRef` accepts `action:`/`milestone:`/`risk:` prefixes; round-trip through `mdToHtml`/`htmlToMd` preserves the new ref types.
- `test/action-items.test.ts` / `test/risks.test.ts` / `test/milestones.test.ts`: `makeRefClickHandler` opens the board + scrolls to the item when present, no-ops silently (no toast, no throw) when the id no longer exists (the defensive fallback path, decision 7).
- `test/panes.test.ts`: `buildModuleItems` includes one entry per action item/milestone/risk with the right label/ref.
- `test/palette.test.ts`: clicking a row (not just Enter) commits it — regression test for the mouseenter/rebuild race; `updateSelectedClass` updates highlight without touching row identity (a captured node reference stays the same DOM node across a hover).
- `test/markdown.test.ts` (live labels): `mdToHtml(md, resolver)` uses the resolver's return value over the stored label when non-`null`, falls back to stored label when the resolver returns `null` or is omitted; the icon `::before` rule never leaks into `textContent`/`getMd()` output; a `day` ref reformats under a different locale.
- `test/refs.test.ts` (new): `unlinkRefsInText` rewrites only matching `kind`+`id` pairs, leaves other refs (including `day:` and non-matching ids of the same kind) untouched, no-ops on text with no refs; `unlinkRefsInTeam` touches every note-bearing field on the team (dailyNotes/person notes/action item notes/milestone+risk followups).
- `test/people-tree.test.ts` / `test/action-items.test.ts` / `test/milestones.test.ts` / `test/risks.test.ts` (delete paths): deleting an item unlinks every reference to it across the team's notes in the same `store.update()`; `action-items.ts`'s `clearZone` bulk-unlinks every id it removes, not just the first.

## Out of scope

- No cross-team references or unlinking — candidates are always scoped to the note's own team, matching how person refs already work; a delete only ever needs to scan its own team's notes.
- No change to `core/search.ts`'s own full-text search or its `RESULT_LIMIT` — this is a separate, smaller "id + title" picker, not a replacement for full-text search.
- No live-updating search snippets (decision 10) — search keeps showing whatever label text is literally stored, which may lag a live-resolved chip until that note is next re-saved.
- No fuzzy/ranked matching — substring match only, same as people today.
- No undo for auto-unlink — deleting an item and rewriting its references happens atomically in one `store.update()`, same as every other delete in this app (no undo system exists to hook into).
