# Favorites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user star a pane's current location (☆/★ in the pane bar) and jump back to it from a header ★ dropdown or the global Ctrl+Alt+F hotkey; Prefs → Data cleanup also purges dead favorites.

**Architecture:** A new top-level `Doc.favorites: Favorite[]` (schema 14 → 15) holds `{ teamId, ref }` entries; pure helpers live in `src/core/favorites.ts`. The pane bar renders the star, a new `src/ui/favorites.ts` panel (modeled on `palette.ts`, reusing `select-list.ts`) renders and drives the list, `shell.ts` gets the header button, `app-hotkeys.ts` routes Ctrl+Alt+F, and `main.ts` wires them. `core/cleanup.ts` gains a favorites count and removal.

**Tech Stack:** TypeScript, zero runtime dependencies, esbuild, vitest + jsdom (unit), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-10-06-favorites-design.md`

## Global Constraints

- Zero runtime dependencies: no new runtime packages; dev-only tools only.
- Desktop-only: no responsive/mobile work.
- i18n: every user-visible string goes through `t(locale, key)`; every new key is added to **both** `pt-BR` (the `pt` object) and `en-US` (the `en` object) in `src/core/i18n.ts` (`en: Record<MsgKey, string>` fails typecheck on a missing key).
- Persisted shape change: bump `SCHEMA_VERSION` to 15 and add `MIGRATIONS[14]`.
- All edits to doc content go through `store.update` (never mutate `store.doc` directly). Favorites toggles are **unscoped** (no `ChangeScope`).
- Every new `src` module has a matching `test/*.test.ts`; code must feature-detect browser APIs so it runs in jsdom.
- Large-font hardening: all dimensions in `rem`; one-line rows with `white-space: nowrap` + ellipsis + full text in `title`; panel width `min(30rem, 92vw)`; never `px` for sizes that must follow `html[data-size]`.
- Hotkey: **Ctrl+Alt+F** (also Cmd on macOS via `metaKey`), no Shift; gated by `comboHotkeyAllowed`.
- Work directly on `dev` (no branches, no worktrees). Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- A `package.json` version bump needs a matching non-empty `## [X.Y.Z]` in `CHANGELOG.md` (CI `changelog-gate`).
- Verification commands: `npm run typecheck`, `npm run lint`, `npm test` (vitest), `npm run test:e2e` (builds first).

## Review Focus

1. **Person favorite whose person is renamed or deleted:** renamed → the panel shows the new name (label is computed live from the store); deleted → the row disappears from the panel and the pane star is not lit; the entry stays in the doc until cleanup. (Task 1 + Task 5 tests.)
2. **Daily favorite on a date with no note:** jumping opens that empty day (it must not throw or be skipped). (Task 5 test.)
3. **Two panes showing different locations, one starred:** each bar's star reflects the store independently and repaints when the favorites change from elsewhere (panel ✕, cleanup). (Task 4 tests.)
4. **Many favorites (more than 9) and a very long list at XL:** rows past 9 have no badge but still work with ↑/↓/Enter; the list scrolls inside the viewport. (Task 5 + e2e.)
5. **A blocking modal or a modeless card modal is open when Ctrl+Alt+F or a favorite row is used:** blocked by a blocking modal; a modeless card is dismissed first via `dismissModelessModals()`. (Task 3 + Task 5 tests.)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/types.ts` (modify) | `Favorite` type, `Doc.favorites` |
| `src/core/document.ts` (modify) | `SCHEMA_VERSION = 15`, `MIGRATIONS[14]`, `createEmptyDocument`, `validateDoc` |
| `src/core/favorites.ts` (create) | Pure helpers: `normalizeRef`, `favoriteKey`, `isFavorite`, `toggleFavorite`, `isFavoriteOrphaned`, `liveFavorites` |
| `src/core/cleanup.ts` (modify) | Count/remove dead favorites |
| `src/ui/prefs.ts` (modify) | Include favorites in the cleanup confirm and the "nothing to clean" check |
| `src/ui/app-hotkeys.ts` (modify) | `{ type: 'favorites' }` for Ctrl+Alt+F |
| `src/ui/help.ts` (modify) | Hotkey row in the global help |
| `src/ui/panes.ts` (modify) | Export `titleFor`; pane star button; keep star in sync |
| `src/ui/favorites.ts` (create) | The favorites panel (open/close/keyboard/jump/remove) |
| `src/ui/shell.ts` (modify) | Header ★ button: `onFavorites`, `setFavoritesEnabled` |
| `src/main.ts` (modify) | Create the panel, wire button + hotkey + disposal |
| `styles.css` (modify) | Pane star, panel, header button, compact hiding |
| `src/core/i18n.ts` (modify) | New keys (both locales) + reworded cleanup texts |
| `test/favorites.test.ts` (create) | Core helper tests |
| `test/favorites-panel.test.ts` (create) | Panel tests |
| `test/document.test.ts`, `test/cleanup.test.ts`, `test/prefs.test.ts`, `test/app-hotkeys.test.ts`, `test/panes.test.ts`, `test/shell.test.ts` (modify) | New cases + updated expectations |
| `e2e/favorites.spec.ts` (create) | End-to-end + large-font + header-collision checks |
| `package.json`, `package-lock.json`, `CHANGELOG.md` (modify) | Version 2.10.0 + entry |

Spec deltas decided while planning (the spec gets a one-line fix in Task 7): the shared predicate is named `isFavoriteOrphaned` (rule 1 only; cleanup adds rule 2 itself), and `resolveFavorites` became `liveFavorites(doc): Favorite[]` — label building lives in the UI because `titleFor` is a UI helper.

---

### Task 1: Data model, migration, validation and pure helpers

**Files:**
- Modify: `src/core/types.ts` (add `Favorite`, `Doc.favorites`)
- Modify: `src/core/document.ts:5` (`SCHEMA_VERSION`), `:9-18` (`createEmptyDocument`), `:165-172` (add `MIGRATIONS[14]`), `:293-326` (`validateDoc`)
- Create: `src/core/favorites.ts`
- Test: `test/favorites.test.ts` (create), `test/document.test.ts` (modify)

**Interfaces:**
- Consumes: `findTeam(doc, teamId)` from `src/core/document.ts`; `Loc`, `ModuleRef` from `types.ts`.
- Produces (all in `src/core/favorites.ts`):
  - `normalizeRef(ref: ModuleRef): ModuleRef` — strips `itemId`.
  - `favoriteKey(loc: Loc): string` — `` `${teamId}|${kind}|${personId|date|''}` ``.
  - `isFavorite(doc: Doc, loc: Loc): boolean`
  - `toggleFavorite(doc: Doc, loc: Loc): boolean` — mutates `doc.favorites`, returns `true` if now a favorite.
  - `isFavoriteOrphaned(doc: Doc, fav: Favorite): boolean` — team missing, or person favorite whose person is missing from `team[ref.group]`.
  - `liveFavorites(doc: Doc): Favorite[]` — non-orphaned entries, in stored order.
  - `Favorite = { teamId: string; ref: ModuleRef }` and `Doc.favorites: Favorite[]` in `types.ts`.

- [ ] **Step 1: Write the failing helper tests**

Create `test/favorites.test.ts`:

```ts
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { favoriteKey, normalizeRef, isFavorite, toggleFavorite, isFavoriteOrphaned, liveFavorites } from '../src/core/favorites'
import type { Doc, Loc } from '../src/core/types'

function docWithTeam(): Doc {
  const d = createEmptyDocument('en-US')
  const team = createEmptyTeam('T1', 'Alpha', '🚀', 'en-US')
  team.members.push({ id: 'p1', name: 'Ann', role: '', parentId: null, order: 0, notes: '' })
  team.stakeholders.push({ id: 's1', name: 'Bo', role: '', parentId: null, order: 0, notes: '' })
  d.teams.push(team)
  return d
}

const risks: Loc = { teamId: 'T1', ref: { kind: 'risks' } }
const ann: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'p1', group: 'members' } }
const day: Loc = { teamId: 'T1', ref: { kind: 'daily', date: '2026-10-06' } }

describe('normalizeRef', () => {
  test('strips itemId from actions, milestones and risks', () => {
    expect(normalizeRef({ kind: 'actions', itemId: 'a1' })).toEqual({ kind: 'actions' })
    expect(normalizeRef({ kind: 'milestones', itemId: 'm1' })).toEqual({ kind: 'milestones' })
    expect(normalizeRef({ kind: 'risks', itemId: 'r1' })).toEqual({ kind: 'risks' })
  })
  test('keeps the person and the daily date', () => {
    expect(normalizeRef(ann.ref)).toEqual(ann.ref)
    expect(normalizeRef(day.ref)).toEqual(day.ref)
  })
})

describe('favoriteKey', () => {
  test('ignores itemId', () => {
    expect(favoriteKey({ teamId: 'T1', ref: { kind: 'risks', itemId: 'r9' } })).toBe(favoriteKey(risks))
  })
  test('distinguishes team, kind, person and date', () => {
    const keys = new Set([
      favoriteKey(risks),
      favoriteKey({ teamId: 'T2', ref: { kind: 'risks' } }),
      favoriteKey({ teamId: 'T1', ref: { kind: 'actions' } }),
      favoriteKey(ann),
      favoriteKey({ teamId: 'T1', ref: { kind: 'person', personId: 'p2', group: 'members' } }),
      favoriteKey(day),
      favoriteKey({ teamId: 'T1', ref: { kind: 'daily', date: '2026-10-07' } }),
    ])
    expect(keys.size).toBe(7)
  })
})

describe('toggleFavorite / isFavorite', () => {
  test('adds, reports true, then removes and reports false', () => {
    const d = docWithTeam()
    expect(isFavorite(d, risks)).toBe(false)
    expect(toggleFavorite(d, risks)).toBe(true)
    expect(isFavorite(d, risks)).toBe(true)
    expect(toggleFavorite(d, risks)).toBe(false)
    expect(d.favorites).toEqual([])
  })
  test('stores the normalized ref and treats an itemId variant as the same favorite', () => {
    const d = docWithTeam()
    toggleFavorite(d, { teamId: 'T1', ref: { kind: 'risks', itemId: 'r1' } })
    expect(d.favorites).toEqual([{ teamId: 'T1', ref: { kind: 'risks' } }])
    expect(isFavorite(d, risks)).toBe(true)
  })
  test('keeps insertion order', () => {
    const d = docWithTeam()
    toggleFavorite(d, day)
    toggleFavorite(d, risks)
    expect(d.favorites.map((f) => f.ref.kind)).toEqual(['daily', 'risks'])
  })
})

describe('isFavoriteOrphaned / liveFavorites', () => {
  test('a favorite of a missing team is orphaned', () => {
    const d = docWithTeam()
    expect(isFavoriteOrphaned(d, { teamId: 'GONE', ref: { kind: 'risks' } })).toBe(true)
  })
  test('a person favorite is orphaned when the person is gone, alive while present', () => {
    const d = docWithTeam()
    expect(isFavoriteOrphaned(d, ann)).toBe(false)
    d.teams[0]!.members = []
    expect(isFavoriteOrphaned(d, ann)).toBe(true)
  })
  test('daily and module favorites of an existing team are never orphaned', () => {
    const d = docWithTeam()
    expect(isFavoriteOrphaned(d, day)).toBe(false)
    expect(isFavoriteOrphaned(d, risks)).toBe(false)
  })
  test('liveFavorites drops orphans, keeps order', () => {
    const d = docWithTeam()
    d.favorites = [day, { teamId: 'GONE', ref: { kind: 'risks' } }, ann]
    expect(liveFavorites(d)).toEqual([day, ann])
  })
})
```

- [ ] **Step 2: Write the failing document tests**

In `test/document.test.ts`, add `favorites: []` expectation to the `createEmptyDocument shape` test (after `expect(d.teams).toEqual([])`):

```ts
  expect(d.favorites).toEqual([])
```

Add after the `v13 → v14 migration` describe block:

```ts
describe('v14 → v15 migration (favorites)', () => {
  it('adds an empty favorites list to a v14 document', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 14
    delete d.favorites
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.favorites).toEqual([])
  })

  it('keeps an existing favorites array untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 14
    d.favorites = [{ teamId: 'T1', ref: { kind: 'risks' } }]
    expect(migrate(d).favorites).toEqual([{ teamId: 'T1', ref: { kind: 'risks' } }])
  })
})
```

Inside the `describe('validateDoc', …)` block, after the `rejects a doc with no nav object` test, add:

```ts
  it('rejects a doc whose favorites is not an array', () => {
    const d = goodDoc()
    d.favorites = 'nope'
    expect(validateDoc(d)).toBe('favorites')
  })

  it('names the favorite when an entry has no team id or no ref', () => {
    const d = goodDoc()
    d.favorites = [{ teamId: '', ref: { kind: 'risks' } }]
    expect(validateDoc(d)).toBe('favorites[0].teamId')
    d.favorites = [{ teamId: 't1', ref: null }]
    expect(validateDoc(d)).toBe('favorites[0].ref')
    d.favorites = [{ teamId: 't1', ref: { kind: 5 } }]
    expect(validateDoc(d)).toBe('favorites[0].ref.kind')
  })

  it('accepts well-formed favorites', () => {
    const d = goodDoc()
    d.favorites = [{ teamId: 't1', ref: { kind: 'daily', date: '2026-09-13' } }]
    expect(validateDoc(d)).toBeNull()
  })
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/favorites.test.ts test/document.test.ts`
Expected: FAIL — `../src/core/favorites` not found; `d.favorites` undefined; migration test fails.

- [ ] **Step 4: Implement types, schema and helpers**

`src/core/types.ts` — add above `export interface Doc`:

```ts
/** A starred pane location (see core/favorites.ts). `ref` never carries an `itemId`: a favorite opens the module, not one card. */
export interface Favorite { teamId: string; ref: ModuleRef }
```

and change `Doc` to:

```ts
export interface Doc {
  schemaVersion: number; prefs: Prefs; templates: Template[]
  nav: NavState; teams: Team[]
  /** Global across teams, in the order they were starred. Schema 15. */
  favorites: Favorite[]
}
```

`src/core/document.ts`:
- Line 5: `export const SCHEMA_VERSION = 15`
- In `createEmptyDocument`, add `favorites: [],` after `teams: [],`.
- After the `13:` entry in `MIGRATIONS` add:

```ts
  14: (d) => {
    d.favorites = Array.isArray(d.favorites) ? d.favorites : []
  },
```

- In `validateDoc`, after the `templatesBad` check and before `if (!Array.isArray(raw.teams))`, add:

```ts
  // Required since schema 15 (MIGRATIONS[14] always creates it, and validateDoc
  // only ever sees a migrated doc). `ref` is checked structurally (a plain
  // object with a string `kind`); whether it still points at something real is
  // deliberately not checked — dead favorites are inert (core/favorites.ts).
  if (!Array.isArray(raw.favorites)) return 'favorites'
  for (let i = 0; i < raw.favorites.length; i++) {
    const fav: unknown = raw.favorites[i]
    const at = `favorites[${i}]`
    if (!isPlainObject(fav)) return at
    if (!fieldOk(fav.teamId, 'id')) return `${at}.teamId`
    if (!isPlainObject(fav.ref)) return `${at}.ref`
    if (!fieldOk(fav.ref.kind, 'string')) return `${at}.ref.kind`
  }
```

Create `src/core/favorites.ts`:

```ts
// src/core/favorites.ts — pure helpers for Doc.favorites (the pane-bar star and
// the header favorites panel). A favorite is a team + module location; the
// `itemId` of an actions/milestones/risks ref is dropped, so one opens the
// module, not a card. No DOM, no store: callers wrap mutations in store.update.
import type { Doc, Favorite, Loc, ModuleRef } from './types'
import { findTeam } from './document'

/** The ref a favorite stores: `itemId` removed, everything else kept. */
export function normalizeRef(ref: ModuleRef): ModuleRef {
  switch (ref.kind) {
    case 'daily': return { kind: 'daily', date: ref.date }
    case 'person': return { kind: 'person', personId: ref.personId, group: ref.group }
    case 'general': return { kind: 'general' }
    case 'stakeholders': return { kind: 'stakeholders' }
    case 'members': return { kind: 'members' }
    case 'actions': return { kind: 'actions' }
    case 'milestones': return { kind: 'milestones' }
    case 'risks': return { kind: 'risks' }
  }
}

/** The single place that decides whether two locations are "the same favorite". */
export function favoriteKey(loc: Loc): string {
  const r = loc.ref
  const detail = r.kind === 'daily' ? r.date : r.kind === 'person' ? r.personId : ''
  return `${loc.teamId}|${r.kind}|${detail}`
}

export function isFavorite(doc: Doc, loc: Loc): boolean {
  const key = favoriteKey(loc)
  return doc.favorites.some((f) => favoriteKey(f) === key)
}

/** Adds the location if absent, removes it if present. Returns whether it is now a favorite. Mutates `doc` — call inside `store.update`. */
export function toggleFavorite(doc: Doc, loc: Loc): boolean {
  const key = favoriteKey(loc)
  const at = doc.favorites.findIndex((f) => favoriteKey(f) === key)
  if (at !== -1) {
    doc.favorites.splice(at, 1)
    return false
  }
  doc.favorites.push({ teamId: loc.teamId, ref: normalizeRef(loc.ref) })
  return true
}

/**
 * Whether a favorite points at something that no longer exists: its team is
 * gone, or it is a person favorite whose person is gone. Ids are never
 * reused, so such an entry is inert; it is hidden from the panel (liveFavorites)
 * and removed for good by the Prefs → Data cleanup (core/cleanup.ts).
 */
export function isFavoriteOrphaned(doc: Doc, fav: Favorite): boolean {
  const team = findTeam(doc, fav.teamId)
  if (!team) return true
  const r = fav.ref
  if (r.kind === 'person') return !team[r.group].some((p) => p.id === r.personId)
  return false
}

export function liveFavorites(doc: Doc): Favorite[] {
  return doc.favorites.filter((f) => !isFavoriteOrphaned(doc, f))
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/favorites.test.ts test/document.test.ts && npm run typecheck`
Expected: tests PASS. Typecheck may report `Doc` literals missing `favorites` elsewhere (tests/helpers that hand-build a `Doc`): add `favorites: []` to each reported literal and re-run until clean. Then run `npm test` — expected all PASS (crypto/round-trip tests use `SCHEMA_VERSION` symbolically).

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/document.ts src/core/favorites.ts test/favorites.test.ts test/document.test.ts
# plus any test/helper files touched by the typecheck fix-ups
git commit -m "feat(favorites): data model, schema 15 migration and pure helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Data cleanup purges dead favorites

**Files:**
- Modify: `src/core/cleanup.ts`
- Modify: `src/ui/prefs.ts:1148-1176` (`doCleanup`)
- Modify: `src/core/i18n.ts` (lines 528, 532, 535 in `pt`; 1096, 1100, 1103 in `en`)
- Test: `test/cleanup.test.ts`, `test/prefs.test.ts`

**Interfaces:**
- Consumes: `isFavoriteOrphaned(doc, fav): boolean` and `Favorite` (Task 1); existing `isOlderThan(date, days, today)` in `cleanup.ts`.
- Produces: `CleanupCounts` gains `favorites: number`; `countCleanupTargets` and `applyCleanup` handle favorites. New i18n param `{favorites}` in `data_cleanup_confirm_body`.

A favorite is **dead** for cleanup when `isFavoriteOrphaned(doc, fav)` is true, or it is a `daily` favorite whose date is older than the cutoff (`isOlderThan(date, days, today)`, i.e. strictly more than `days` days before `today`).

- [ ] **Step 1: Write the failing cleanup tests**

In `test/cleanup.test.ts`: change the two existing `countCleanupTargets(...).toEqual({ actions: …, dailyNotes: 0 })` expectations (lines 38 and 91) to include `favorites: 0` (e.g. `{ actions: 2, milestones: 0, risks: 0, dailyNotes: 0, favorites: 0 }`). Add `Favorite` to the type import (`import type { ActionItem, Doc, Favorite, Milestone, Risk, Team } from '../src/core/types'`). Append:

```ts
describe('dead favorites', () => {
  const OLD_DAY = '2026-05-01' // 86 days before TODAY
  const KEPT_DAY = '2026-07-10' // 16 days before TODAY
  const fav = (teamId: string, ref: Favorite['ref']): Favorite => ({ teamId, ref })

  function favDoc(): Doc {
    const d = doc([team({ id: 'T1', members: [{ id: 'p1', name: 'Ann', role: '', parentId: null, order: 0, notes: '' }] })])
    d.favorites = [
      fav('T1', { kind: 'risks' }),                                   // live
      fav('T1', { kind: 'person', personId: 'p1', group: 'members' }), // live
      fav('T1', { kind: 'daily', date: KEPT_DAY }),                   // live: inside the cutoff
      fav('T1', { kind: 'daily', date: OLD_DAY }),                    // dead: rule 2 (older than cutoff)
      fav('T1', { kind: 'person', personId: 'gone', group: 'members' }), // dead: rule 1 (person gone)
      fav('GONE', { kind: 'actions' }),                               // dead: rule 1 (team gone)
    ]
    return d
  }

  test('counts dead favorites: deleted team, deleted person, daily older than the cutoff', () => {
    expect(countCleanupTargets(favDoc(), 30, TODAY).favorites).toBe(3)
  })

  test('removes only the dead ones and keeps order', () => {
    const d = favDoc()
    applyCleanup(d, 30, TODAY)
    expect(d.favorites.map((f) => f.ref.kind)).toEqual(['risks', 'person', 'daily'])
    expect((d.favorites[2]!.ref as { date: string }).date).toBe(KEPT_DAY)
  })

  test('a daily favorite exactly at the cutoff is kept (strictly older than `days` is dead)', () => {
    const d = doc([team()])
    d.favorites = [fav('T1', { kind: 'daily', date: '2026-06-26' })] // exactly 30 days before TODAY
    expect(countCleanupTargets(d, 30, TODAY).favorites).toBe(0)
  })

  test('non-daily favorites of live teams are kept regardless of age', () => {
    const d = doc([team()])
    d.favorites = [fav('T1', { kind: 'milestones' }), fav('T1', { kind: 'general' })]
    applyCleanup(d, 1, TODAY)
    expect(d.favorites).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Write the failing prefs tests**

In `test/prefs.test.ts`:
- In the test `cleanup: counts done/cancelled actions, …` replace the expected message with:

```ts
        '2 tasks, 1 milestones, 1 risks, 1 daily notes and 0 broken favorites across all teams will be permanently deleted.'
```

- Add a new test directly after `cleanup: shows "nothing to clean up" …` (same `vi.useFakeTimers()` / `setup()` / `openPrefs` / `clickTab('Data')` / `clickByText('Clean up data')` pattern):

```ts
  test('cleanup: a document whose only garbage is a dead favorite still gets a confirm and is purged', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20))
    try {
      const { store, shell, appCtl } = setup()
      store.update((d) => {
        d.teams.push(sampleTeam())
        d.favorites.push({ teamId: 'deleted-team', ref: { kind: 'risks' } })
      })
      openPrefs(store, shell, 'en-US', appCtl)
      clickTab('Data')

      clickByText('Clean up data')

      const titles = document.querySelectorAll('.tt-modal-title')
      expect(titles[titles.length - 1]?.textContent).toBe('Confirm cleanup')
      const messages = document.querySelectorAll('.tt-modal-message')
      expect(messages[messages.length - 1]?.textContent).toContain('1 broken favorites')

      clickByText('Clean up data')
      expect(store.doc.favorites).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/cleanup.test.ts test/prefs.test.ts -t "cleanup|favorites"`
Expected: FAIL (`favorites` missing from counts; message text differs; "nothing to clean up" shown).

- [ ] **Step 4: Implement cleanup logic**

In `src/core/cleanup.ts`:
- Update the header comment's list to mention "favorites that no longer point anywhere".
- Add imports: `import type { Doc, Favorite } from './types'` (replace the existing `Doc` import) and `import { isFavoriteOrphaned } from './favorites'`.
- `CleanupCounts`: add `favorites: number`.
- Add below `isOlderThan`:

```ts
/** A favorite cleanup removes: its team/person is gone, or it is a daily-note favorite older than the cutoff (that day's note is being purged too). */
function isDeadFavorite(doc: Doc, fav: Favorite, days: number, today: string): boolean {
  if (isFavoriteOrphaned(doc, fav)) return true
  return fav.ref.kind === 'daily' && isOlderThan(fav.ref.date, days, today)
}
```

- `countCleanupTargets`: initial counts `{ actions: 0, milestones: 0, risks: 0, dailyNotes: 0, favorites: 0 }`, and before `return counts`:

```ts
  counts.favorites = doc.favorites.filter((f) => isDeadFavorite(doc, f, days, today)).length
```

- `applyCleanup`: after the `for (const team of doc.teams)` loop (cleanup never deletes teams or people, so order does not matter):

```ts
  doc.favorites = doc.favorites.filter((f) => !isDeadFavorite(doc, f, days, today))
```

- [ ] **Step 5: Implement the prefs wiring and i18n**

`src/ui/prefs.ts` in `doCleanup`:
- Change the nothing-to-clean condition to include favorites:

```ts
      if (counts.actions === 0 && counts.milestones === 0 && counts.risks === 0 && counts.dailyNotes === 0 && counts.favorites === 0) {
```

- Add `favorites: String(counts.favorites),` to the `data_cleanup_confirm_body` params object.

`src/core/i18n.ts`:
- pt line 528 `data_cleanup_hint`: `'Remove tarefas concluídas/canceladas e riscos encerrados, além de marcos concluídos e notas diárias com data anterior ao número de dias escolhido, e favoritos que apontam para um time ou pessoa excluídos ou para um dia anterior a esse prazo — em todos os times deste arquivo. Esta ação não pode ser desfeita.'`
- pt line 532 `data_cleanup_confirm_body`: `'{actions} tarefas, {milestones} marcos, {risks} riscos, {dailyNotes} notas diárias e {favorites} favoritos inválidos em todos os times serão excluídos permanentemente.'`
- pt line 535 `data_cleanup_nothing_body`: `'Nenhum item concluído/cancelado, risco encerrado, marco concluído antigo, nota diária antiga ou favorito inválido foi encontrado.'`
- en line 1096 `data_cleanup_hint`: `'Removes done/cancelled tasks and closed risks, plus completed milestones and daily notes dated older than the chosen number of days, and favorites that point to a deleted team or person or to a day older than that — across every team in this file. This cannot be undone.'`
- en line 1100 `data_cleanup_confirm_body`: `'{actions} tasks, {milestones} milestones, {risks} risks, {dailyNotes} daily notes and {favorites} broken favorites across all teams will be permanently deleted.'`
- en line 1103 `data_cleanup_nothing_body`: `'No done/cancelled tasks, closed risks, old completed milestones, old daily notes, or broken favorites were found.'`

(Line numbers are from before Task 1; locate by key name if they shifted.)

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/cleanup.test.ts test/prefs.test.ts test/i18n.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/cleanup.ts src/ui/prefs.ts src/core/i18n.ts test/cleanup.test.ts test/prefs.test.ts
git commit -m "feat(cleanup): data cleanup also purges dead favorites

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Ctrl+Alt+F hotkey routing and help entry

**Files:**
- Modify: `src/ui/app-hotkeys.ts` (action union + one branch)
- Modify: `src/ui/help.ts:38-42` (`GLOBAL_ROWS`)
- Modify: `src/core/i18n.ts` (key `help_global_favorites`, both locales)
- Test: `test/app-hotkeys.test.ts`

**Interfaces:**
- Consumes: `matchKey`, `comboHotkeyAllowed` (already imported in `app-hotkeys.ts`).
- Produces: `AppHotkeyAction` gains `{ type: 'favorites' }`, returned for Ctrl/Cmd+Alt+F without Shift when `comboHotkeyAllowed(e)`; `main.ts` (Task 6) handles it.

- [ ] **Step 1: Write the failing tests**

In `test/app-hotkeys.test.ts`, add inside/after the `global Ctrl chords` describe:

```ts
describe('Ctrl+Alt+F → favorites', () => {
  test('Ctrl+Alt+F and Cmd+Alt+F → favorites', () => {
    expect(resolve({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true })).toEqual({ type: 'favorites' })
    expect(resolve({ key: 'f', code: 'KeyF', metaKey: true, altKey: true })).toEqual({ type: 'favorites' })
  })

  test('Ctrl+Shift+F (search all teams), plain Ctrl+F and Alt+F are not claimed', () => {
    expect(resolve({ key: 'f', code: 'KeyF', ctrlKey: true, shiftKey: true })).toBeNull()
    expect(resolve({ key: 'f', code: 'KeyF', ctrlKey: true })).toBeNull()
    expect(resolve({ key: 'f', code: 'KeyF', altKey: true })).toBeNull()
  })

  test('Ctrl+Alt+Shift+F is not claimed', () => {
    expect(resolve({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true, shiftKey: true })).toBeNull()
  })

  test('matches by physical key on a layout where e.key is not "f"', () => {
    expect(resolve({ key: 'ƒ', code: 'KeyF', ctrlKey: true, altKey: true })).toEqual({ type: 'favorites' })
  })

  test('is blocked by a blocking modal but not by a modeless card modal', () => {
    document.body.innerHTML = '<div class="tt-modal-overlay"></div>'
    expect(resolve({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true })).toBeNull()
    document.body.innerHTML = '<div class="tt-modal-overlay tt-modal-modeless"></div>'
    expect(resolve({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true })).toEqual({ type: 'favorites' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/app-hotkeys.test.ts`
Expected: FAIL — `resolve(...)` returns `null` for Ctrl+Alt+F.

- [ ] **Step 3: Implement**

In `src/ui/app-hotkeys.ts` add to the `AppHotkeyAction` union (after `closeFile`):

```ts
  /** Ctrl/Cmd+Alt+F → toggle the favorites panel (src/ui/favorites.ts). */
  | { type: 'favorites' }
```

and, directly after the `closeFile` branch (the `Ctrl+Alt+L` block):

```ts
  // Ctrl+Alt+F: favorites panel. Not Alt+F (opens the browser menu on Windows
  // Chrome) and not Ctrl+Shift+F (search across all teams).
  if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && matchKey(e, 'f')) {
    return comboHotkeyAllowed(e) ? { type: 'favorites' } : null
  }
```

`src/ui/help.ts`: in `GLOBAL_ROWS` after the `Ctrl+Alt+L / 🔒` row add `['Ctrl+Alt+F', 'help_global_favorites'],`.

`src/core/i18n.ts`: next to `help_global_close_file` add — pt: `help_global_favorites: 'Abrir favoritos',` — en: `help_global_favorites: 'Open favorites',`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/app-hotkeys.test.ts test/help.test.ts test/i18n.test.ts && npm run typecheck`
Expected: PASS. (`main.ts`'s `switch` has no default, so typecheck passes before Task 6; if it reports a non-exhaustive switch, add a temporary `case 'favorites': return` and replace it in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add src/ui/app-hotkeys.ts src/ui/help.ts src/core/i18n.ts test/app-hotkeys.test.ts
git commit -m "feat(favorites): Ctrl+Alt+F hotkey routing and help entry

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Pane-bar star button

**Files:**
- Modify: `src/ui/panes.ts` (export `titleFor` at `:148`; star button in `renderBar` near `:1130-1159`; sync in the `store.subscribe` at `:500-509`)
- Modify: `src/core/i18n.ts` (keys `pane_fav_add_title`, `pane_fav_remove_title`, both locales)
- Modify: `styles.css` (after `.tt-pane-bar-left, .tt-pane-bar-right` rule at `:707`)
- Test: `test/panes.test.ts`

**Interfaces:**
- Consumes: `isFavorite(doc, loc)`, `toggleFavorite(doc, loc)` (Task 1).
- Produces: `export function titleFor(store: Store, loc: Loc, locale: Locale): string` (now exported; Task 5 uses it); button `.tt-btn.tt-pane-fav-btn` with `aria-pressed` `"true"|"false"`, glyph `★`/`☆`, in each pane bar left of `.tt-pane-print-btn`.

- [ ] **Step 1: Write the failing tests**

In `test/panes.test.ts` (it already has `setup()`, `addTeam()`, `paneBtn(idx, cls)`; check how other tests open a module in a pane, e.g. `pm.openInPane(0, { teamId: 't1', ref: { kind: 'risks' } })` after `addTeam(store, 't1')` and `store.update((d) => { d.nav.activeTeamId = 't1' })`, and mirror it). Add:

```ts
describe('pane favorite star', () => {
  function openRisks(store: Store, pm: PaneManager): void {
    addTeam(store, 't1')
    store.update((d) => { d.nav.activeTeamId = 't1' })
    pm.openInPane(0, { teamId: 't1', ref: { kind: 'risks' } })
  }

  test('is disabled on an empty pane', () => {
    const { store } = setup()
    addTeam(store, 't1')
    expect(paneBtn(0, 'tt-pane-fav-btn').disabled).toBe(true)
  })

  test('click stars the pane: ★, aria-pressed, stored in doc.favorites; click again unstars', () => {
    const { store, pm } = setup()
    openRisks(store, pm)
    const btn = (): HTMLButtonElement => paneBtn(0, 'tt-pane-fav-btn')
    expect(btn().textContent).toBe('☆')
    expect(btn().getAttribute('aria-pressed')).toBe('false')

    btn().click()
    expect(store.doc.favorites).toEqual([{ teamId: 't1', ref: { kind: 'risks' } }])
    expect(btn().textContent).toBe('★')
    expect(btn().getAttribute('aria-pressed')).toBe('true')
    expect(store.dirty).toBe(true)

    btn().click()
    expect(store.doc.favorites).toEqual([])
    expect(btn().textContent).toBe('☆')
  })

  test('the star follows the live store: removing the favorite elsewhere repaints it', () => {
    const { store, pm } = setup()
    openRisks(store, pm)
    paneBtn(0, 'tt-pane-fav-btn').click()
    expect(paneBtn(0, 'tt-pane-fav-btn').textContent).toBe('★')

    store.update((d) => { d.favorites = [] })
    expect(paneBtn(0, 'tt-pane-fav-btn').textContent).toBe('☆')
  })

  test('each pane bar reflects its own location: starring pane 1's location leaves pane 0 unlit', () => {
    const { store, pm } = setup()
    addTeam(store, 't1')
    store.update((d) => { d.nav.activeTeamId = 't1' })
    pm.openInPane(0, { teamId: 't1', ref: { kind: 'risks' } })
    pm.toggleSplit()
    pm.openInPane(1, { teamId: 't1', ref: { kind: 'actions' } })
    store.update((d) => { d.favorites.push({ teamId: 't1', ref: { kind: 'actions' } }) })
    expect(paneBtn(1, 'tt-pane-fav-btn').textContent).toBe('★')
    expect(paneBtn(0, 'tt-pane-fav-btn').textContent).toBe('☆')
  })

  test('a favorite of a deleted team does not light any star', () => {
    const { store, pm } = setup()
    openRisks(store, pm)
    store.update((d) => { d.favorites.push({ teamId: 'gone', ref: { kind: 'risks' } }) })
    expect(paneBtn(0, 'tt-pane-fav-btn').textContent).toBe('☆')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/panes.test.ts -t "pane favorite star"`
Expected: FAIL — `.tt-pane-fav-btn not found`.

- [ ] **Step 3: Implement**

`src/core/i18n.ts` (both locales, next to `pane_print_title`): pt `pane_fav_add_title: 'Adicionar aos favoritos', pane_fav_remove_title: 'Remover dos favoritos',`; en `pane_fav_add_title: 'Add to favorites', pane_fav_remove_title: 'Remove from favorites',`.

`src/ui/panes.ts`:
- Import: `import { isFavorite, toggleFavorite } from '../core/favorites'`.
- Change `function titleFor(` to `export function titleFor(`.
- In `renderBar`, before `const printBtn`, add:

```ts
    const isFav = cur !== null && isFavorite(store.doc, cur)
    const favBtn = el(
      'button',
      {
        class: 'tt-btn tt-pane-fav-btn',
        type: 'button',
        title: t(lc, isFav ? 'pane_fav_remove_title' : 'pane_fav_add_title'),
        'aria-pressed': String(isFav),
        disabled: cur === null,
        // Unscoped on purpose (core/scope.ts): a toggle is rare, and a wrong narrow scope would leave a star stale.
        onclick: () => { if (cur) store.update((d) => { toggleFavorite(d, cur) }) },
      },
      isFav ? '★' : '☆'
    )
```

- Change `const right = ... printBtn, splitBtn)` to `el('div', { class: 'tt-pane-bar-right' }, favBtn, printBtn, splitBtn)`.
- In the existing `store.subscribe((scope) => {...})` loop (the one that refreshes titles), extend the per-pane check so a star that no longer matches the store also repaints the bar — replace the `painted` block with:

```ts
      const painted = barEls[idx].querySelector('.tt-pane-title-text')?.textContent
      const paintedStar = barEls[idx].querySelector('.tt-pane-fav-btn')?.getAttribute('aria-pressed')
      if (
        (painted != null && painted !== titleFor(store, cur, localeNow())) ||
        (paintedStar != null && paintedStar !== String(isFavorite(store.doc, cur)))
      ) renderBar(idx)
```

(Update the comment above that subscription: it "also refreshes the bars' titles *and favorite stars*".)

`styles.css`, after the `.tt-pane-bar-left, .tt-pane-bar-right` rule:

```css
/* Favorite star: same square-ish icon button as print/split; filled state tinted with the accent. */
.tt-pane-fav-btn { flex: none; }
.tt-pane-fav-btn[aria-pressed='true'] { color: var(--accent); border-color: var(--accent); }
.tt-pane-fav-btn:disabled { opacity: .5; cursor: not-allowed; }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/panes.test.ts test/lifecycle.test.ts test/i18n.test.ts && npm run typecheck`
Expected: PASS (`lifecycle.test.ts` proves no extra store subscription was added).

- [ ] **Step 5: Commit**

```bash
git add src/ui/panes.ts src/core/i18n.ts styles.css test/panes.test.ts
git commit -m "feat(favorites): star toggle in each pane bar

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Favorites panel

**Files:**
- Create: `src/ui/favorites.ts`
- Modify: `src/core/i18n.ts` (keys `favorites_btn_title`, `favorites_panel_label`, `favorites_empty`, both locales)
- Modify: `styles.css` (new "Favorites panel" block after the command-palette block, ~`:771`)
- Test: `test/favorites-panel.test.ts` (create)

**Interfaces:**
- Consumes: `liveFavorites`, `toggleFavorite` (Task 1); `titleFor` (exported in Task 4) and `PaneManager.openInFocused(loc)` from `panes.ts`; `paintSelection`, `clampMove`, `selectableRowProps` from `select-list.ts`; `blockedByBlockingModal`, `matchDigit` from `hotkeys.ts`; `dismissModelessModals` from `modal.ts`; `KIND_ICON` from `core/search.ts`.
- Produces:

```ts
export interface FavoritesDeps {
  /** Switches the active team (main.ts's selectTeam). */
  selectTeam(id: string): void
  /** Viewport y of the header's bottom edge — the panel hangs under it. */
  headerBottom(): number
}
export interface FavoritesPanel {
  toggle(): void
  open(): void
  close(): void
  isOpen(): boolean
  /** Releases the document listeners (also closes). */
  dispose(): void
}
export function createFavoritesPanel(store: Store, pm: PaneManager, deps: FavoritesDeps): FavoritesPanel
```

DOM contract used by tests/CSS/e2e: root `div.tt-favorites-panel[role=dialog]`; list `div.tt-favorites-list`; rows `div.tt-favorites-item` (class `selected` on the highlighted row) containing `span.tt-favorites-badge`, `span.tt-favorites-label` (with `title` = full text), `button.tt-favorites-remove`; empty hint `div.tt-favorites-empty`.

Behavior: `open()` is a no-op with zero teams; opens with row 0 selected; ↑/↓ move (clamped), Enter jumps, Esc closes, digits 1–9 jump to that row (via `matchDigit`, ignored when Ctrl/Alt/Meta held), all keys swallowed with `preventDefault()`/`stopPropagation()` only when handled; a `blockedByBlockingModal()` bails out; mousedown outside the panel (and outside `.tt-btn-favorites`) closes; ✕ removes via `store.update` and re-renders without closing, clamping the selection. Jump = `dismissModelessModals()` (abort if it vetoes) → `close()` → `deps.selectTeam(teamId)` if `teamId !== nav.activeTeamId` → `pm.openInFocused({ teamId, ref })`. Label = `${team.emoji} ${team.name} · ${KIND_ICON[kind]} ${titleFor(store, loc, locale)}`.

- [ ] **Step 1: Write the failing tests**

Create `test/favorites-panel.test.ts`:

```ts
import { createShell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createPaneManager, type PaneManager } from '../src/ui/panes'
import { createFavoritesPanel, type FavoritesPanel } from '../src/ui/favorites'
import { currentLoc } from '../src/core/nav'

function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function setup(): { store: Store; pm: PaneManager; panel: FavoritesPanel; selectTeam: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = ''
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  const person = { id: 'p1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }
  doc.teams.push(
    { id: 'T1', name: 'Alpha', emoji: '🚀', stakeholders: [person], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} },
    { id: 'T2', name: 'Beta', emoji: '🧪', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} },
  )
  doc.nav.activeTeamId = 'T1'
  doc.favorites = [
    { teamId: 'T1', ref: { kind: 'risks' } },
    { teamId: 'T2', ref: { kind: 'actions' } },
    { teamId: 'T1', ref: { kind: 'person', personId: 'p1', group: 'stakeholders' } },
    { teamId: 'T1', ref: { kind: 'daily', date: '2026-10-06' } },
  ]
  const store = createStore(doc)
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const pm = createPaneManager(shell, store, 'en-US')
  const selectTeam = vi.fn((id: string) => { store.updateNav((d) => { d.nav.activeTeamId = id }) })
  const panel = createFavoritesPanel(store, pm, { selectTeam, headerBottom: () => 48 })
  return { store, pm, panel, selectTeam }
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.tt-favorites-item'))
const press = (key: string, init: KeyboardEventInit = {}): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

afterEach(() => { document.body.innerHTML = '' })

test('open lists live favorites in order, labelled team · module, with number badges and the first row selected', () => {
  const { panel } = setup()
  panel.open()
  const labels = rows().map((r) => r.querySelector('.tt-favorites-label')!.textContent)
  expect(labels[0]).toContain('Alpha')
  expect(labels[0]).toContain('Risks')
  expect(labels[1]).toContain('Beta')
  expect(labels[2]).toContain('Carla')
  expect(labels[3]).toContain('2026')
  expect(rows().map((r) => r.querySelector('.tt-favorites-badge')!.textContent)).toEqual(['1', '2', '3', '4'])
  expect(rows()[0]!.classList.contains('selected')).toBe(true)
  expect(rows()[0]!.querySelector('.tt-favorites-label')!.getAttribute('title')).toBe(labels[0])
})

test('open is a no-op with no teams; toggle opens then closes', () => {
  const { store, panel } = setup()
  panel.toggle()
  expect(panel.isOpen()).toBe(true)
  panel.toggle()
  expect(panel.isOpen()).toBe(false)
  expect(document.querySelector('.tt-favorites-panel')).toBeNull()

  store.update((d) => { d.teams = [] })
  panel.open()
  expect(panel.isOpen()).toBe(false)
})

test('shows an empty hint when there are no live favorites', () => {
  const { store, panel } = setup()
  store.update((d) => { d.favorites = [{ teamId: 'GONE', ref: { kind: 'risks' } }] })
  panel.open()
  expect(rows()).toHaveLength(0)
  expect(document.querySelector('.tt-favorites-empty')).not.toBeNull()
})

test('a favorite of a deleted person is hidden', () => {
  const { store, panel } = setup()
  store.update((d) => { d.teams[0]!.stakeholders = [] })
  panel.open()
  expect(rows()).toHaveLength(3)
})

test('arrow keys move the selection (clamped); Escape closes', () => {
  const { panel } = setup()
  panel.open()
  press('ArrowDown'); press('ArrowDown')
  expect(rows()[2]!.classList.contains('selected')).toBe(true)
  press('ArrowDown'); press('ArrowDown'); press('ArrowDown')
  expect(rows()[3]!.classList.contains('selected')).toBe(true)
  press('ArrowUp')
  expect(rows()[2]!.classList.contains('selected')).toBe(true)
  press('Escape')
  expect(panel.isOpen()).toBe(false)
})

test('Enter on a same-team favorite opens it in the focused pane without switching team', () => {
  const { store, panel, selectTeam } = setup()
  panel.open()
  press('Enter') // row 0: T1 · risks
  expect(panel.isOpen()).toBe(false)
  expect(selectTeam).not.toHaveBeenCalled()
  expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toEqual({ teamId: 'T1', ref: { kind: 'risks' } })
})

test('a cross-team favorite switches team first, then opens in the focused pane', () => {
  const { store, panel, selectTeam } = setup()
  panel.open()
  press('2', { code: 'Digit2' })
  expect(selectTeam).toHaveBeenCalledWith('T2')
  expect(store.doc.nav.activeTeamId).toBe('T2')
  expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toEqual({ teamId: 'T2', ref: { kind: 'actions' } })
})

test('a daily favorite on a date with no note opens that empty day', () => {
  const { store, panel } = setup()
  panel.open()
  press('4', { code: 'Digit4' })
  expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toEqual({ teamId: 'T1', ref: { kind: 'daily', date: '2026-10-06' } })
})

test('digit past the last row does nothing; Ctrl/Alt+digit is left alone', () => {
  const { panel, selectTeam } = setup()
  panel.open()
  press('9', { code: 'Digit9' })
  expect(panel.isOpen()).toBe(true)
  press('2', { code: 'Digit2', altKey: true })
  expect(panel.isOpen()).toBe(true)
  expect(selectTeam).not.toHaveBeenCalled()
})

test('clicking a row jumps; hovering does not replace the row node', () => {
  const { panel, store } = setup()
  panel.open()
  const before = rows()
  before[1]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: 5, clientY: 5 }))
  expect(rows()[1]).toBe(before[1])
  before[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  expect(panel.isOpen()).toBe(false)
  expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])?.ref.kind).toBe('risks')
})

test('✕ removes the favorite, keeps the panel open and clamps the selection', () => {
  const { panel, store } = setup()
  panel.open()
  press('ArrowDown'); press('ArrowDown'); press('ArrowDown') // last row
  rows()[3]!.querySelector<HTMLButtonElement>('.tt-favorites-remove')!.click()
  expect(panel.isOpen()).toBe(true)
  expect(store.doc.favorites).toHaveLength(3)
  expect(rows()).toHaveLength(3)
  expect(rows()[2]!.classList.contains('selected')).toBe(true)
})

test('mousedown outside closes; mousedown on the header ★ button does not (its click toggles)', () => {
  const { panel } = setup()
  panel.open()
  const btn = document.createElement('button')
  btn.className = 'tt-btn-favorites'
  document.body.appendChild(btn)
  btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  expect(panel.isOpen()).toBe(true)
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  expect(panel.isOpen()).toBe(false)
})

test('keys do nothing behind a blocking modal', () => {
  const { panel } = setup()
  panel.open()
  const modal = document.createElement('div')
  modal.className = 'tt-modal-overlay'
  document.body.appendChild(modal)
  press('Escape')
  expect(panel.isOpen()).toBe(true)
})

test('close and dispose release the document listeners', () => {
  const { panel } = setup()
  const add = vi.spyOn(document, 'addEventListener')
  const remove = vi.spyOn(document, 'removeEventListener')
  panel.open()
  panel.close()
  const added = add.mock.calls.filter(([type]) => type === 'keydown' || type === 'mousedown').length
  const removed = remove.mock.calls.filter(([type]) => type === 'keydown' || type === 'mousedown').length
  expect(removed).toBe(added)
  panel.open()
  panel.dispose()
  expect(panel.isOpen()).toBe(false)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/favorites-panel.test.ts`
Expected: FAIL — cannot resolve `../src/ui/favorites`.

- [ ] **Step 3: Add i18n keys**

`src/core/i18n.ts`, both locales (next to the `pane_fav_*` keys):
- pt: `favorites_btn_title: 'Favoritos (Ctrl+Alt+F)', favorites_panel_label: 'Favoritos', favorites_empty: 'Nenhum favorito ainda. Clique na ☆ da barra de um painel para adicionar.',`
- en: `favorites_btn_title: 'Favorites (Ctrl+Alt+F)', favorites_panel_label: 'Favorites', favorites_empty: 'No favorites yet. Click the ☆ in a pane bar to add one.',`

- [ ] **Step 4: Implement the panel**

Create `src/ui/favorites.ts`:

```ts
// src/ui/favorites.ts — the favorites panel: a dropdown hung under the header
// (opened by the header ★ button or Ctrl+Alt+F) listing every starred pane
// location, with arrow/Enter/1–9 keyboard navigation. Modeled on palette.ts
// (capture-phase keydown, same blocking/modeless-modal guards, select-list.ts
// row mechanics so hover never rebuilds the rows). Positioned `fixed` from the
// header's bottom edge — not from the ★ button — so the hotkey still works when
// the compact header hides that button. All sizes are rem (styles.css) so the
// panel follows the text-size setting.
import type { Store } from '../core/store'
import type { Favorite } from '../core/types'
import { findTeam } from '../core/document'
import { liveFavorites, toggleFavorite } from '../core/favorites'
import { KIND_ICON } from '../core/search'
import { t } from '../core/i18n'
import { el } from './dom'
import { paintSelection, clampMove, selectableRowProps } from './select-list'
import { blockedByBlockingModal, matchDigit } from './hotkeys'
import { dismissModelessModals } from './modal'
import { titleFor, type PaneManager } from './panes'

export interface FavoritesDeps {
  /** Switches the active team (main.ts's selectTeam). */
  selectTeam(id: string): void
  /** Viewport y of the header's bottom edge — the panel hangs under it. */
  headerBottom(): number
}

export interface FavoritesPanel {
  toggle(): void
  open(): void
  close(): void
  isOpen(): boolean
  /** Releases the document listeners (also closes). */
  dispose(): void
}

export function createFavoritesPanel(store: Store, pm: PaneManager, deps: FavoritesDeps): FavoritesPanel {
  let panel: HTMLElement | null = null
  let listEl: HTMLElement | null = null
  let rows: Favorite[] = []
  let selected = 0

  function locale() {
    return store.doc.prefs.locale
  }

  function labelFor(fav: Favorite): string {
    const team = findTeam(store.doc, fav.teamId)
    const title = titleFor(store, fav, locale())
    return `${team?.emoji ?? ''} ${team?.name ?? ''} · ${KIND_ICON[fav.ref.kind]} ${title}`.trim()
  }

  function close(): void {
    if (!panel) return
    panel.remove()
    panel = null
    listEl = null
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('mousedown', onMousedown, true)
  }

  function jump(fav: Favorite | undefined): void {
    if (!fav) return
    // A card modal open in a pane must close first (flushing its notes editor);
    // if its required-name guard vetoes, keep the panel open on the card.
    if (!dismissModelessModals()) return
    close()
    if (fav.teamId !== store.doc.nav.activeTeamId) deps.selectTeam(fav.teamId)
    pm.openInFocused({ teamId: fav.teamId, ref: fav.ref })
  }

  function remove(fav: Favorite): void {
    store.update((d) => { toggleFavorite(d, fav) })
    renderList()
  }

  // Hover/arrow selection repaints in place via paintSelection (select-list.ts);
  // only a structural change (open, ✕) rebuilds the rows.
  function renderList(): void {
    if (!listEl) return
    rows = liveFavorites(store.doc)
    selected = Math.min(selected, Math.max(0, rows.length - 1))
    listEl.innerHTML = ''
    if (rows.length === 0) {
      listEl.appendChild(el('div', { class: 'tt-favorites-empty' }, t(locale(), 'favorites_empty')))
      return
    }
    rows.forEach((fav, i) => {
      const label = labelFor(fav)
      const rowEl = el(
        'div',
        selectableRowProps({
          class: 'tt-favorites-item',
          selected: i === selected,
          onCommit: () => jump(fav),
          onHover: () => { selected = i; paintSelection(listEl, '.tt-favorites-item', selected) },
        }),
        el('span', { class: 'tt-favorites-badge', 'aria-hidden': 'true' }, i < 9 ? String(i + 1) : ''),
        el('span', { class: 'tt-favorites-label', title: label }, label),
        el('button', {
          class: 'tt-favorites-remove',
          type: 'button',
          title: t(locale(), 'pane_fav_remove_title'),
          'aria-label': t(locale(), 'pane_fav_remove_title'),
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: (e: Event) => { e.stopPropagation(); remove(fav) },
        }, '✕')
      )
      listEl!.appendChild(rowEl)
    })
  }

  function onKeydown(e: KeyboardEvent): void {
    // A blocking modal that appears while the panel is open must not have this
    // capturing listener act behind it (same rule as palette.ts).
    if (blockedByBlockingModal()) return
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      close()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation()
      selected = clampMove(selected, e.key === 'ArrowDown' ? 1 : -1, rows.length)
      paintSelection(listEl, '.tt-favorites-item', selected)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation()
      jump(rows[selected])
      return
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return // Alt+1..9 is the team switch, not ours
    for (let n = 1; n <= 9; n++) {
      if (!matchDigit(e, n)) continue
      e.preventDefault(); e.stopPropagation()
      jump(rows[n - 1])
      return
    }
  }

  // Not the ★ button: its own click toggles, and closing here first would make
  // that click re-open the panel it just closed.
  function onMousedown(e: MouseEvent): void {
    const target = e.target as Element | null
    if (target?.closest('.tt-favorites-panel, .tt-btn-favorites')) return
    close()
  }

  function open(): void {
    if (panel) return
    // Every row re-targets a pane inside some team; with none there is nothing
    // to jump to. Same rule as the palette and the search bar.
    if (store.doc.teams.length === 0) return
    selected = 0
    listEl = el('div', { class: 'tt-favorites-list' })
    panel = el(
      'div',
      { class: 'tt-favorites-panel', role: 'dialog', 'aria-label': t(locale(), 'favorites_panel_label') },
      listEl
    )
    panel.style.top = `${deps.headerBottom()}px`
    document.body.appendChild(panel)
    document.addEventListener('keydown', onKeydown, true)
    document.addEventListener('mousedown', onMousedown, true)
    renderList()
  }

  return {
    toggle: () => (panel ? close() : open()),
    open,
    close,
    isOpen: () => panel !== null,
    dispose: close,
  }
}
```

Fix typing: give `locale()` an explicit return type (`import type { Locale } from '../core/i18n'`, `function locale(): Locale`) — the repo's lint rules expect explicit return types on helpers like palette.ts's.

- [ ] **Step 5: Add the panel CSS**

`styles.css`, after the `.tt-palette-item.selected, .tt-palette-item:hover` rule:

```css
/* Favorites panel (src/ui/favorites.ts): hangs under the header, right-aligned.
   Everything in rem so it follows html[data-size]; rows are one line with an
   ellipsis (full text on the label's title) so XL never wraps or reflows them;
   badge and ✕ are fixed-size flex items that never shrink. */
.tt-favorites-panel {
  position: fixed; right: .75rem; z-index: 1200;
  width: min(30rem, 92vw); max-height: 70vh; display: flex; flex-direction: column;
  background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, .35); overflow: hidden;
}
.tt-favorites-list { overflow-y: auto; padding: .25rem; }
.tt-favorites-item { display: flex; align-items: center; gap: .5rem; padding: .5rem .6rem; border-radius: 4px; cursor: pointer; }
.tt-favorites-item.selected, .tt-favorites-item:hover { background: rgba(var(--accent-rgb), .12); }
.tt-favorites-badge { flex: none; width: 1.25rem; text-align: center; opacity: .65; font-variant-numeric: tabular-nums; }
.tt-favorites-label { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tt-favorites-remove {
  flex: none; width: 1.5rem; height: 1.5rem; padding: 0; line-height: 1;
  background: transparent; color: var(--fg); border: none; border-radius: 4px; cursor: pointer; opacity: .6;
}
.tt-favorites-remove:hover { opacity: 1; color: var(--accent); }
.tt-favorites-empty { padding: .75rem; opacity: .75; }
```

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `npx vitest run test/favorites-panel.test.ts test/i18n.test.ts && npm run typecheck && npm run lint`
Expected: PASS. Fix lint complaints (explicit return types, unused imports) before committing.

- [ ] **Step 7: Commit**

```bash
git add src/ui/favorites.ts src/core/i18n.ts styles.css test/favorites-panel.test.ts
git commit -m "feat(favorites): favorites panel with keyboard navigation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Header button and `main.ts` wiring

**Files:**
- Modify: `src/ui/shell.ts` (interface at `:17-111`; button near `:253-260`; `applyPrefs` locale refresh `:379-386`; returned object `:455`)
- Modify: `styles.css` (compact-hide selector list at `:297-303`)
- Modify: `src/main.ts` (import; create panel after the palette at `:270-276`; hotkey `case`; disposal)
- Test: `test/shell.test.ts`, `test/lifecycle.test.ts` (read-only check), plus `npm test`

**Interfaces:**
- Consumes: `createFavoritesPanel(store, pm, deps): FavoritesPanel` (Task 5); `AppHotkeyAction` `{ type: 'favorites' }` (Task 3); `selectTeam` (main.ts hoisted function); i18n `favorites_btn_title` (Task 5).
- Produces on `Shell`: `onFavorites(cb: () => void): void` and `setFavoritesEnabled(enabled: boolean): void`; header button `button.tt-btn.tt-btn-favorites` (glyph `★`) placed between the save pill and the fullscreen button; hidden by the compact header.

- [ ] **Step 1: Write the failing shell tests**

In `test/shell.test.ts` add (reusing `setup()`):

```ts
describe('favorites button', () => {
  test('is in the header between the save pill and fullscreen, titled with the hotkey', () => {
    const shell = setup()
    const btn = shell.root.querySelector<HTMLButtonElement>('.tt-btn-favorites')!
    expect(btn).not.toBeNull()
    expect(btn.textContent).toBe('★')
    expect(btn.title).toBe(t('en-US', 'favorites_btn_title'))
    const kids = Array.from(shell.headerRight.children)
    expect(kids.indexOf(btn)).toBeGreaterThan(kids.findIndex((c) => c.classList.contains('tt-save-pill-wrap')))
    expect(kids.indexOf(btn)).toBeLessThan(kids.findIndex((c) => c.classList.contains('tt-btn-fullscreen')))
  })

  test('click calls the registered handler', () => {
    const shell = setup()
    const cb = vi.fn()
    shell.onFavorites(cb)
    shell.root.querySelector<HTMLButtonElement>('.tt-btn-favorites')!.click()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  test('setFavoritesEnabled toggles disabled', () => {
    const shell = setup()
    const btn = shell.root.querySelector<HTMLButtonElement>('.tt-btn-favorites')!
    shell.setFavoritesEnabled(false)
    expect(btn.disabled).toBe(true)
    shell.setFavoritesEnabled(true)
    expect(btn.disabled).toBe(false)
  })

  test('title follows a locale change', () => {
    const shell = setup()
    shell.applyPrefs({ ...createEmptyDocument('pt-BR').prefs })
    expect(shell.root.querySelector<HTMLButtonElement>('.tt-btn-favorites')!.title).toBe(t('pt-BR', 'favorites_btn_title'))
  })
})
```

(Add `import { createEmptyDocument } from '../src/core/document'` to `test/shell.test.ts` if absent.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/shell.test.ts -t "favorites button"`
Expected: FAIL — button not found / `onFavorites` is not a function.

- [ ] **Step 3: Implement the shell button**

`src/ui/shell.ts`:
- In `interface Shell`, after `onHelp(...)`, add:

```ts
  /** Registers the click handler for the header ★ button (toggles the favorites panel — same action as Ctrl+Alt+F). */
  onFavorites(cb: () => void): void
  /** Enables/disables the ★ button. Mirrors the palette/search rule: with no team there is nothing a favorite could open. */
  setFavoritesEnabled(enabled: boolean): void
```

- After the `helpBtn` definition add:

```ts
  let favoritesHandler: (() => void) | null = null
  const favoritesBtn = el(
    'button',
    { class: 'tt-btn tt-btn-favorites', type: 'button', title: t(locale, 'favorites_btn_title'), onclick: () => favoritesHandler?.() },
    '★'
  )
```

- Change `headerRight.append(savePillWrap, fullscreenBtn, helpBtn, closeFileBtn, settingsBtn)` to `headerRight.append(savePillWrap, favoritesBtn, fullscreenBtn, helpBtn, closeFileBtn, settingsBtn)`.
- In `applyPrefs`'s `if (localeChanged)` block add `favoritesBtn.title = t(currentLocale, 'favorites_btn_title')`.
- Add functions next to `onHelp`:

```ts
  function onFavorites(cb: () => void): void {
    favoritesHandler = cb
  }

  function setFavoritesEnabled(enabled: boolean): void {
    favoritesBtn.disabled = !enabled
  }
```

- Add `onFavorites, setFavoritesEnabled` to the returned object.

`styles.css`: add `.tt-header.tt-header-compact .tt-btn-favorites,` to the compact-hide selector list (before `.tt-header.tt-header-compact .tt-btn-fullscreen,`), and update the comment above it to say the favorites button also has a keyboard equivalent (Ctrl+Alt+F). Also add after the `.tt-btn:hover` rule:

```css
.tt-btn-favorites:disabled { opacity: .5; cursor: not-allowed; }
```

- [ ] **Step 4: Wire `main.ts`**

- Add import: `import { createFavoritesPanel } from './ui/favorites'`.
- After `disposers.push(store.onMutate(syncAppName))` (≈line 276) add:

```ts
  // Favorites: the header ★ and Ctrl+Alt+F drive one panel. `selectTeam` is a
  // hoisted function declaration (below), safe to pass here. The panel is
  // positioned from the header's bottom edge, not the ★ button, so the hotkey
  // still works when the compact header hides the button.
  const favorites = createFavoritesPanel(store, pm, {
    selectTeam,
    headerBottom: () => shell.root.querySelector('.tt-header')?.getBoundingClientRect().bottom ?? 0,
  })
  shell.onFavorites(() => favorites.toggle())
  const syncFavoritesBtn = (): void => shell.setFavoritesEnabled(store.doc.teams.length > 0)
  syncFavoritesBtn()
  disposers.push(store.onMutate(syncFavoritesBtn))
  disposers.push(() => favorites.dispose())
```

- In the `onKeyDown` `switch`, after `case 'closeFile': … return` add:

```ts
      case 'favorites':
        favorites.toggle()
        return
```

(Remove any temporary placeholder `case 'favorites'` added in Task 3.)

- [ ] **Step 5: Run the suite**

Run: `npx vitest run test/shell.test.ts test/lifecycle.test.ts test/favorites-panel.test.ts && npm run typecheck && npm run lint && npm test`
Expected: all PASS. If any other test builds a fake `Shell` object, typecheck names it; add `onFavorites: () => {}, setFavoritesEnabled: () => {}` stubs there.

- [ ] **Step 6: Manual smoke (real app)**

Run: `npm run build` then open `dist/app.html` (via the `run` skill or a browser). Create a team, star two panes, press Ctrl+Alt+F: panel opens under the header; ↑/↓/Enter/1/2/Esc behave; header ★ opens/closes it; ✕ removes a row; narrow the window until the header goes compact: ★ hides, Ctrl+Alt+F still opens the panel. Record what was checked in the commit body only if something unexpected was fixed.

- [ ] **Step 7: Commit**

```bash
git add src/ui/shell.ts src/main.ts styles.css test/shell.test.ts
git commit -m "feat(favorites): header button and Ctrl+Alt+F wiring

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: E2E coverage, large-font checks, spec fix-up, version bump and changelog

**Files:**
- Create: `e2e/favorites.spec.ts`
- Modify: `docs/superpowers/specs/2026-10-06-favorites-design.md` (naming deltas)
- Modify: `package.json` (`"version": "2.10.0"`), `package-lock.json` (root `version` fields, via `npm version`), `CHANGELOG.md`
- Possibly modify: `src/ui/responsive.ts` (`HEADER_COMPACT_BELOW_PX`, only if Step 3 shows a collision)

**Interfaces:**
- Consumes: `buildDoc`, `openDoc`, `TEAM_ID` from `e2e/layout-fixtures.ts`; the DOM contract from Task 5 and Task 6.
- Produces: nothing downstream.

- [ ] **Step 1: Write the e2e spec**

Create `e2e/favorites.spec.ts`:

```ts
// e2e/favorites.spec.ts — favorites end to end, plus the large-font and
// header-collision guards the unit tests can't give (jsdom has no layout).
import { test, expect, type Page } from '@playwright/test'
import { createEmptyTeam } from '../src/core/document'
import { buildDoc, openDoc, TEAM_ID } from './layout-fixtures'

const paneTitle = (page: Page, idx: 0 | 1 = 0): ReturnType<Page['locator']> =>
  page.locator('.tt-pane-title-text').nth(idx)

test('star a pane, switch team, jump back via the hotkey, then via the header button', async ({ page }) => {
  const doc = buildDoc('M', { kind: 'general' })
  doc.teams.push(createEmptyTeam('team-1', 'Second team', '🧪', 'en-US'))
  await openDoc(page, doc)

  await page.locator('.tt-pane-fav-btn').first().click()
  await expect(page.locator('.tt-pane-fav-btn').first()).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('Alt+2') // switch to the second team
  await expect(paneTitle(page)).not.toContainText('General notes')

  await page.keyboard.press('Control+Alt+F')
  await expect(page.locator('.tt-favorites-panel')).toBeVisible()
  await expect(page.locator('.tt-favorites-item')).toHaveCount(1)
  await page.keyboard.press('1')
  await expect(page.locator('.tt-favorites-panel')).toHaveCount(0)
  await expect(paneTitle(page)).toContainText('General notes')

  await page.keyboard.press('Alt+2')
  await page.locator('.tt-btn-favorites').click()
  await expect(page.locator('.tt-favorites-panel')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(paneTitle(page)).toContainText('General notes')

  await page.keyboard.press('Control+Alt+F')
  await expect(page.locator('.tt-favorites-panel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.tt-favorites-panel')).toHaveCount(0)
})

for (const size of ['XS', 'XL'] as const) {
  test(`favorites panel rows stay on one line and inside the viewport (${size}, 30+ long entries)`, async ({ page }) => {
    const doc = buildDoc(size, { kind: 'general' }, { stakeholderRoots: 4 })
    for (let i = 0; i < 4; i++) {
      doc.favorites.push({ teamId: TEAM_ID, ref: { kind: 'person', personId: `s${i}`, group: 'stakeholders' } })
    }
    for (const kind of ['general', 'stakeholders', 'members', 'actions', 'milestones', 'risks'] as const) {
      doc.favorites.push({ teamId: TEAM_ID, ref: { kind } })
    }
    for (let i = 0; i < 24; i++) {
      doc.favorites.push({ teamId: TEAM_ID, ref: { kind: 'daily', date: `2026-09-${String(1 + i).padStart(2, '0')}` } })
    }
    await openDoc(page, doc)
    await page.keyboard.press('Control+Alt+F')
    await expect(page.locator('.tt-favorites-panel')).toBeVisible()
    expect(await page.locator('.tt-favorites-item').count()).toBe(34)

    const r = await page.evaluate(() => {
      const panel = document.querySelector('.tt-favorites-panel')!.getBoundingClientRect()
      const list = document.querySelector('.tt-favorites-list')!
      const labels = [...document.querySelectorAll<HTMLElement>('.tt-favorites-label')]
      const rowHeights = [...document.querySelectorAll<HTMLElement>('.tt-favorites-item')].map((e) => Math.round(e.getBoundingClientRect().height))
      return {
        tall: labels.filter((e) => e.getBoundingClientRect().height >= 2 * parseFloat(getComputedStyle(e).fontSize)).length,
        inViewport: panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0 && panel.bottom <= innerHeight,
        listScrolls: list.scrollHeight > list.clientHeight,
        distinctRowHeights: new Set(rowHeights).size,
      }
    })
    expect(r.tall).toBe(0)
    expect(r.inViewport).toBe(true)
    expect(r.listScrolls).toBe(true)
    expect(r.distinctRowHeights).toBe(1)

    // Rows past 9 have no badge but still work from the keyboard.
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.locator('.tt-favorites-panel')).toHaveCount(0)
  })
}

for (const size of ['M', 'XL'] as const) {
  test(`header ★ never overlaps the search box or the save pill across window widths (${size})`, async ({ page }) => {
    await openDoc(page, buildDoc(size, { kind: 'general' }), { width: 1440, height: 900 })
    for (const width of [640, 760, 820, 900, 1000, 1100, 1200, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const r = await page.evaluate(() => {
        const rect = (sel: string): DOMRect | null => {
          const e = document.querySelector<HTMLElement>(sel)
          return e && e.offsetParent !== null ? e.getBoundingClientRect() : null
        }
        const hit = (a: DOMRect | null, b: DOMRect | null): boolean =>
          !!a && !!b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom && b.top < a.bottom
        const star = rect('.tt-btn-favorites')
        return {
          starVisible: star !== null,
          overSearch: hit(star, rect('.tt-search-input')),
          overPill: hit(star, rect('.tt-save-pill-wrap')),
          overNeighbour: hit(star, rect('.tt-btn-fullscreen')),
          pageOverflowsX: document.documentElement.scrollWidth > innerWidth,
        }
      })
      expect(r, `width ${width}`).toMatchObject({ overSearch: false, overPill: false, overNeighbour: false, pageOverflowsX: false })
    }
  })
}
```

- [ ] **Step 2: Run the e2e spec**

Run: `npx playwright test e2e/favorites.spec.ts` (build first with `npm run build`, or use `npm run test:e2e -- e2e/favorites.spec.ts`)
Expected: PASS. If the header-collision test fails at some width, the new ★ button (≈2rem + `.75rem` gap) pushed the right cluster into the search box: raise `HEADER_COMPACT_BELOW_PX` in `src/ui/responsive.ts:37` just enough that the compact form kicks in before the collision (the threshold already scales by text size), update the `.tt-header-center` budget comment near `styles.css:195` ("≈ 34rem of save pill and buttons") to the new figure, add/adjust the matching assertion in `test/responsive.test.ts` if it pins 820, and re-run. If the e2e fails on a Playwright/Chromium crash (see the pinned-Chromium note in memory), rerun once before investigating.

- [ ] **Step 3: Fix the spec's naming**

In `docs/superpowers/specs/2026-10-06-favorites-design.md`:
- Core API section: replace the `resolveFavorites` bullet with ``- `liveFavorites(doc): Favorite[]` — drops entries whose team, or person (for person refs), no longer exists; the panel builds labels itself (`titleFor` is a UI helper).`` and add ``- `isFavoriteOrphaned(doc, fav): boolean`` as the shared predicate.
- Stale entries / cleanup sections: replace every `resolveFavorites` with `liveFavorites` and `isFavoriteDead(doc, fav)` with `isFavoriteOrphaned(doc, fav)` (cleanup's own `isDeadFavorite` adds the daily-older-than-cutoff rule on top).
- Testing section: replace `resolveFavorites` with `liveFavorites`.

- [ ] **Step 4: Bump the version and write the changelog**

Invoke the `changelog` skill and follow its rules, then run `npm version 2.10.0 --no-git-tag-version` (updates `package.json` and `package-lock.json`). Add above `## [2.9.5]` in `CHANGELOG.md`, dated with the release date:

```markdown
## [2.10.0] - 2026-10-06

### Added
- Favorites: every pane now has a ☆ next to the print and split buttons. Click it to star that spot — a team's Daily notes for a given day, a person's notes, the member or stakeholder lists, Tasks, Milestones, Risks or General notes — and click again to remove it.
- A ★ button in the header opens your favorites from any team. Pick one to jump to that team and open it in the pane you're working in. Press Ctrl+Alt+F to open the same list from the keyboard, move with ↑/↓ and Enter, or press 1–9 to jump straight to an entry. The list follows the text-size setting, and long names are cut short with "…" instead of wrapping.

### Changed
- Clean up data (Preferences → Data) now also removes favorites that no longer lead anywhere: ones for a deleted team or person, and Daily notes favorites for days older than the number of days you choose. The confirmation shows how many.
```

(Adjust wording if the `changelog` skill's rules say otherwise; keep a non-empty `## [2.10.0]` heading — CI's `changelog-gate` requires it.)

- [ ] **Step 5: Full verification**

Run, in order, and read each result:
`npm run typecheck && npm run lint && npm test && npm run test:e2e`
Expected: all PASS. If any e2e unrelated to favorites fails, rerun once; if it persists, check it against `git stash`-free baseline (`git log -1`) before blaming this work.

- [ ] **Step 6: Commit**

```bash
git add e2e/favorites.spec.ts docs/superpowers/specs/2026-10-06-favorites-design.md package.json package-lock.json CHANGELOG.md
# plus src/ui/responsive.ts, styles.css and test/responsive.test.ts only if Step 2 required a threshold change
git commit -m "feat(favorites): e2e coverage, v2.10.0 and changelog

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review (done against the spec)

- **Spec coverage:** pane star (Task 4); header ★ + panel + keyboard 1–9/↑/↓/Enter/Esc + focused-pane jump + ✕ + empty hint + compact hiding (Tasks 5–6); Ctrl+Alt+F + help entry (Task 3); data model, schema 15, migration, validation, stale filtering (Task 1); cleanup purge incl. confirm message, "nothing to clean" rule and i18n rewording (Task 2); large-font hardening in CSS + e2e at XS/XL and header-collision sweep (Tasks 5, 7); unscoped toggle (Task 4); version + changelog (Task 7). Team export/import intentionally untouched (spec: not carried).
- **Placeholders:** none; the two conditional edits (typecheck fix-ups for hand-built `Doc` literals in Task 1, threshold bump in Task 7) are tied to a concrete failing check with exact files.
- **Type consistency:** `Favorite`, `favoriteKey`, `normalizeRef`, `isFavorite`, `toggleFavorite`, `isFavoriteOrphaned`, `liveFavorites` (Task 1) are used with the same names in Tasks 2, 4, 5; `titleFor` export (Task 4) is consumed in Task 5; `FavoritesPanel`/`FavoritesDeps` (Task 5) match their use in Task 6; `AppHotkeyAction` `{ type: 'favorites' }` (Task 3) matches the `main.ts` case; DOM classes `tt-pane-fav-btn`, `tt-btn-favorites`, `tt-favorites-*` are identical across CSS, tests and e2e.
- **Known behavior to be aware of:** `openInFocused` goes through `openInPane`'s existing cross-pane duplicate guard, so if the *other* pane already shows the favorite's exact module, that pane is focused instead of loading a duplicate — consistent with every other navigation in the app.
