# Fast Switch Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Ctrl+Shift+K fast switch into one cross-team switcher (Favorites → Due dates → Current team → Other teams), and remove the header ★ favorites button, dropdown panel and Ctrl+Alt+F hotkey.

**Architecture:** A new pure `core/switcher.ts` builds the section model (matching, dedupe, 20-row allocation) from the `Doc`; `core/module-items.ts` receives `buildModuleItems`/`titleFor` so `core/` never imports `ui/`. `ui/palette.ts` only renders that model (headings, team badges, ✕ on favorites) and wires keys/commit. Favorites data (`doc.favorites`, `core/favorites.ts`) and the pane-bar ☆ are untouched, so there is no schema change.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess` — index reads need `!`), vitest + jsdom, Playwright (e2e), esbuild. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-fast-switch-redesign-design.md`

## Global Constraints

- Zero runtime dependencies; dev-only tooling only.
- All user-visible strings go through `t(locale, key)` with keys in **both** `pt-BR` (`const pt`) and `en-US` (`const en`, typed `Record<MsgKey, string>`) in `src/core/i18n.ts`.
- Every `src` module has a matching `test/*.test.ts` (tests run in jsdom).
- Desktop-only app: no responsive/mobile work. The compact-header breakpoint (840 px) stays untouched.
- All sizes in rem (follow the text-size setting). Text for people goes through `t()`; never hard-code English in `src`.
- No schema change: `SCHEMA_VERSION` and `MIGRATIONS` stay as they are.
- Work directly on `dev`. No worktrees, no feature branches (project CLAUDE.md).
- Commit messages are Conventional Commits and end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Files use LF line endings. When editing with scripts, do not let a tool write CRLF.
- Row limit: 20 rows total, minimum `min(matches, 4)` per section, leftovers in round-robin passes in section order.
- `package.json` version bump to `2.11.0` needs a matching non-empty `## [2.11.0]` entry in `CHANGELOG.md` (CI `changelog-gate`); load the `changelog` skill before writing it.

## Review Focus

Failure modes the spec implies but a straight reading of the tasks would not test; each has its test in the owning task.

1. A query of only whitespace (`"   "`) must behave like an empty query: Other teams stays hidden. (Task 2)
2. Case/accent-insensitive matching across teams: typing `JOSE` finds a person named `José` in another team. (Task 2)
3. A team with an empty emoji must not get a badge with a leading space or an empty badge. (Task 2)
4. Clicking ✕ on the **last** favorite (and on the currently selected, last row) must remove the Favorites section cleanly, clamp the selection, keep the palette open and not navigate. (Task 3)
5. A query with zero matches shows the "No results" line, and Enter does nothing (no throw, palette stays open). (Task 3)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/core/module-items.ts` | Create | `ModuleItem`, `FIXED_MODULE_KEYS`, `buildModuleItems`, `titleFor(doc, loc, locale)`, `filterModuleItems` — moved out of `ui/` |
| `src/core/switcher.ts` | Create | Pure fast-switch model: `buildSwitcher`, `allocateRows`, row/section types |
| `src/ui/palette.ts` | Rewrite | Render sections/rows, keyboard, ✕, commit (with `selectTeam`) |
| `src/ui/panes.ts` | Modify | Import moved items; call `titleFor(store.doc, …)` |
| `src/ui/shell.ts`, `src/ui/search-ui.ts`, `src/ui/app-hotkeys.ts`, `src/ui/help.ts`, `src/ui/sidebar.ts`, `src/main.ts` | Modify | Remove ★ button/hotkey/wiring; pass `selectTeam` to palette; drop `openDuePanel` handle member |
| `src/ui/favorites.ts` | Delete | Old dropdown panel |
| `src/core/i18n.ts` | Modify | Add `switcher_*` keys, new placeholder, remove four unused favorites keys |
| `styles.css` | Modify | New palette section/badge/✕ styles; remove `.tt-favorites-*` and `.tt-btn-favorites` |
| `test/module-items.test.ts`, `test/switcher.test.ts` | Create | Unit tests |
| `test/palette.test.ts` | Rewrite | UI tests |
| `test/panes.test.ts`, `test/shell.test.ts`, `test/app-hotkeys.test.ts`, `test/search-ui.test.ts` | Modify | Follow moved/removed code |
| `test/favorites-panel.test.ts` | Delete | Panel is gone |
| `e2e/favorites.spec.ts`, `e2e/scroll-and-overflow.spec.ts` | Modify | New flows |
| `README.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md`, `CHANGELOG.md`, `package.json`, `package-lock.json` | Modify | Docs and 2.11.0 |

---

### Task 1: Move `buildModuleItems`, `titleFor`, `filterModuleItems` into `core/module-items.ts`

Pure refactor: behavior unchanged, tests move with the code.

**Files:**
- Create: `src/core/module-items.ts`
- Create: `test/module-items.test.ts`
- Modify: `src/ui/panes.ts` (remove lines ~98-132 `ModuleItem`/`FIXED_MODULE_KEYS`/`buildModuleItems`, lines ~149-176 `titleFor`; update 4 call sites and imports)
- Modify: `src/ui/palette.ts` (import `filterModuleItems`/`buildModuleItems` from core; remove its own `filterModuleItems`)
- Modify: `src/ui/favorites.ts` (import `titleFor` from core, pass `store.doc`)
- Modify: `test/panes.test.ts` (cut the moved tests, fix imports)

**Interfaces:**
- Produces (used by Task 2 and Task 3):
  - `export interface ModuleItem { label: string; ref: ModuleRef }`
  - `export const FIXED_MODULE_KEYS: { kind: 'stakeholders' | 'members' | 'actions' | 'milestones' | 'risks'; key: MsgKey }[]`
  - `export function buildModuleItems(team: Team | null, locale: Locale): ModuleItem[]`
  - `export function titleFor(doc: Doc, loc: Loc, locale: Locale): string`
  - `export function filterModuleItems<T extends { label: string }>(items: T[], query: string): T[]`

- [ ] **Step 1: Create `src/core/module-items.ts`**

```ts
// src/core/module-items.ts — the "jump to" row list shared by the pane module
// dropdown (ui/panes.ts) and the fast switch (core/switcher.ts), plus the
// title a Loc shows in a pane bar or favorite row. Lives in core/ (not
// ui/panes.ts) so the switcher can build rows for every team without core/
// importing from ui/. No DOM.
import type { Doc, Loc, ModuleRef, Team } from './types'
import { findTeam } from './document'
import { t, todayIso, formatDateWithWeekday, type Locale, type MsgKey } from './i18n'
import { KIND_ICON, normalize, teamRefCandidates } from './search'

/** Same item list feeds both the pane module dropdown and the Ctrl+Shift+K fast switch. */
export interface ModuleItem {
  label: string
  ref: ModuleRef
}

export const FIXED_MODULE_KEYS: { kind: 'stakeholders' | 'members' | 'actions' | 'milestones' | 'risks'; key: MsgKey }[] = [
  { kind: 'stakeholders', key: 'module_stakeholders' },
  { kind: 'members', key: 'module_members' },
  { kind: 'actions', key: 'module_actions' },
  { kind: 'milestones', key: 'module_milestones' },
  { kind: 'risks', key: 'module_risks' },
]

/** Pure and exported so it can be unit-tested without touching the DOM. */
export function filterModuleItems<T extends { label: string }>(items: T[], query: string): T[] {
  const q = normalize(query.trim())
  if (!q) return items
  return items.filter((item) => normalize(item.label).includes(q))
}

export function buildModuleItems(team: Team | null, locale: Locale): ModuleItem[] {
  const items: ModuleItem[] = [
    { label: `${KIND_ICON.daily} ${t(locale, 'module_daily')}`, ref: { kind: 'daily', date: todayIso() } },
    { label: `${KIND_ICON.general} ${t(locale, 'module_general_notes')}`, ref: { kind: 'general' } },
  ]
  if (team) {
    for (const group of ['stakeholders', 'members'] as const) {
      for (const person of team[group]) {
        items.push({ label: `${KIND_ICON.person} ${person.name}`, ref: { kind: 'person', personId: person.id, group } })
      }
    }
  }
  const cands = team ? teamRefCandidates(team) : null
  for (const { kind, key } of FIXED_MODULE_KEYS) {
    items.push({ label: `${KIND_ICON[kind]} ${t(locale, key)}`, ref: { kind } })
    if (!cands || kind === 'stakeholders' || kind === 'members') continue
    const list = { actions: cands.actionItems, milestones: cands.milestones, risks: cands.risks }[kind]
    for (const c of list) items.push({ label: `${KIND_ICON[kind]} ${c.title}`, ref: { kind, itemId: c.id } })
  }
  return items
}

export function titleFor(doc: Doc, loc: Loc, locale: Locale): string {
  switch (loc.ref.kind) {
    case 'daily':
      return `${t(locale, 'module_daily')} · ${formatDateWithWeekday(loc.ref.date, locale)}`
    case 'general':
      return t(locale, 'module_general_notes')
    case 'person': {
      // `loc.ref` is narrowed to the 'person' variant here by the switch, but
      // that narrowing does not survive into the .find() callback below (TS
      // can't prove the property access is stable across a closure) — so we
      // capture the narrowed ref in a local const first.
      const ref = loc.ref
      const team = findTeam(doc, loc.teamId)
      const person = team?.[ref.group].find((p) => p.id === ref.personId)
      return person ? person.name : t(locale, 'module_person')
    }
    case 'stakeholders':
      return t(locale, 'module_stakeholders')
    case 'members':
      return t(locale, 'module_members')
    case 'actions':
      return t(locale, 'module_actions')
    case 'milestones':
      return t(locale, 'module_milestones')
    case 'risks':
      return t(locale, 'module_risks')
  }
}
```

- [ ] **Step 2: Update `src/ui/panes.ts`**

1. Delete the `ModuleItem` interface + its doc comment (the block starting `/** Same item list feeds both the pane module dropdown…`), `FIXED_MODULE_KEYS`, `buildModuleItems`, and `titleFor`.
2. Add `import { FIXED_MODULE_KEYS, titleFor } from '../core/module-items'` (`paneMenuItems()` still uses `FIXED_MODULE_KEYS`).
3. Change the 4 `titleFor(store, …)` call sites to `titleFor(store.doc, …)` (search for `titleFor(` — they are in the title-refresh code, the history label helper, the print header, and the pane bar title).
4. Update the comment above `paneMenuItems` to say `see buildModuleItems (core/module-items.ts)`.
5. Run `npm run typecheck` and `npm run lint`; remove whatever imports they flag as unused (likely `teamRefCandidates`, `formatDateWithWeekday`, `Team`, `docFindTeam` — only if truly unused).

- [ ] **Step 3: Update `src/ui/palette.ts` and `src/ui/favorites.ts`**

In `palette.ts`: delete its local `filterModuleItems`; change the import to `import { buildModuleItems, filterModuleItems } from '../core/module-items'` and `import type { PaneManager } from './panes'`. (Task 3 rewrites this file; this step only keeps it compiling.)

In `favorites.ts`: `import { titleFor } from '../core/module-items'`, `import type { PaneManager } from './panes'`, and call `titleFor(store.doc, fav, locale())`.

- [ ] **Step 4: Move the tests**

In `test/panes.test.ts`: cut the `filterModuleItems matches substrings…` test (around line 1041) and the four `buildModuleItems …` tests (around lines 1170-1225), then change the imports: drop `buildModuleItems`, `type ModuleItem` from the `../src/ui/panes` import and delete `import { filterModuleItems } from '../src/ui/palette'`. Remove any import the cut leaves unused (`KIND_ICON`, `Team`).

Create `test/module-items.test.ts` with the cut tests pasted verbatim (fix their imports to `../src/core/module-items`, `../src/core/search` for `KIND_ICON`, `../src/core/types` for `Team`) plus these new tests:

```ts
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { titleFor } from '../src/core/module-items'
import { t } from '../src/core/i18n'

describe('titleFor', () => {
  function docWithPerson() {
    const doc = createEmptyDocument('en-US')
    const team = createEmptyTeam('t1', 'Alpha', '🅰️', 'en-US')
    team.members.push({ id: 'm1', name: 'Bruno', role: '', parentId: null, order: 0, notes: '' })
    doc.teams.push(team)
    return doc
  }

  test('person: the name, or the generic person title when the person is gone', () => {
    const doc = docWithPerson()
    expect(titleFor(doc, { teamId: 't1', ref: { kind: 'person', personId: 'm1', group: 'members' } }, 'en-US')).toBe('Bruno')
    expect(titleFor(doc, { teamId: 't1', ref: { kind: 'person', personId: 'zzz', group: 'members' } }, 'en-US')).toBe(t('en-US', 'module_person'))
    expect(titleFor(doc, { teamId: 'gone', ref: { kind: 'person', personId: 'm1', group: 'members' } }, 'en-US')).toBe(t('en-US', 'module_person'))
  })

  test('whole-board kinds use their module titles', () => {
    const doc = docWithPerson()
    expect(titleFor(doc, { teamId: 't1', ref: { kind: 'risks' } }, 'en-US')).toBe(t('en-US', 'module_risks'))
    expect(titleFor(doc, { teamId: 't1', ref: { kind: 'general' } }, 'en-US')).toBe(t('en-US', 'module_general_notes'))
  })

  test('daily: module title, a dot, and the weekday date', () => {
    const doc = docWithPerson()
    expect(titleFor(doc, { teamId: 't1', ref: { kind: 'daily', date: '2026-10-07' } }, 'en-US')).toContain(' · ')
  })
})
```

(The daily test only pins the `" · "` separator; the date formatting itself is `formatDateWithWeekday`'s own tested concern.)

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npx vitest run test/module-items.test.ts test/panes.test.ts test/palette.test.ts test/favorites-panel.test.ts`
Expected: all PASS, no type or lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/module-items.ts test/module-items.test.ts src/ui/panes.ts src/ui/palette.ts src/ui/favorites.ts test/panes.test.ts
git commit -m "refactor: move module items and titleFor into core/module-items" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pure switcher model (`core/switcher.ts`) + i18n keys

**Files:**
- Create: `src/core/switcher.ts`
- Create: `test/switcher.test.ts`
- Modify: `src/core/i18n.ts` (add keys to **both** `pt` and `en`; update `palette_placeholder`)

**Interfaces:**
- Consumes (Task 1): `buildModuleItems(team, locale)`, `titleFor(doc, loc, locale)`.
- Consumes (existing): `liveFavorites`, `favoriteKey` (`core/favorites.ts`); `collectDueItems(doc, today)` (`core/due.ts`); `diffDays` (`core/date.ts`); `KIND_ICON`, `normalize` (`core/search.ts`); `findTeam` (`core/document.ts`).
- Produces (used by Task 3):
  ```ts
  export const SWITCHER_MAX_ROWS = 20
  export const SWITCHER_MIN_PER_SECTION = 4
  export interface SwitcherRow {
    label: string            // icon + title, e.g. "⚠️ Vendor delay"
    teamId: string
    ref: ModuleRef
    teamBadge?: string       // "🅱️ Beta" — favorites, due and other-team rows only
    dueLabel?: string        // due rows only, e.g. "overdue by 6d"
    favorite?: Favorite      // favorite rows only — what ✕ removes
  }
  export type SwitcherSectionId = 'favorites' | 'due' | 'current' | 'others'
  export interface SwitcherSection { id: SwitcherSectionId; heading: string; total: number; rows: SwitcherRow[] }
  export function allocateRows(counts: readonly number[], max?: number, min?: number): number[]
  export function buildSwitcher(doc: Doc, query: string, locale: Locale, today: string): SwitcherSection[]
  ```
  `total` is the number of matches before the cap; `rows.length <= total`. Only non-empty sections are returned.
- Produces i18n keys (both locales): `switcher_favorites`, `switcher_due`, `switcher_others`, `switcher_count` (params `{shown}`, `{total}`), `switcher_empty`.

- [ ] **Step 1: Add i18n keys**

In `src/core/i18n.ts`, next to `palette_placeholder` in the `pt` block add:

```ts
  switcher_favorites: 'Favoritos',
  switcher_due: 'Prazos',
  switcher_others: 'Outros times',
  switcher_count: '{shown} de {total}',
  switcher_empty: 'Nenhum resultado',
```
and replace the pt `palette_placeholder` with:
`palette_placeholder: 'Buscar em todos os times: módulo, pessoa, tarefa, marco ou risco… (Ctrl+Shift+K)',`

In the `en` block next to its `palette_placeholder`:

```ts
  switcher_favorites: 'Favorites',
  switcher_due: 'Due dates',
  switcher_others: 'Other teams',
  switcher_count: '{shown} of {total}',
  switcher_empty: 'No results',
```
and `palette_placeholder: 'Search every team: module, person, task, milestone or risk… (Ctrl+Shift+K)',`

(`en` is typed `Record<MsgKey, string>`, so a missing key fails `npm run typecheck`.)

- [ ] **Step 2: Write the failing tests** — `test/switcher.test.ts`

```ts
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { toggleFavorite } from '../src/core/favorites'
import { allocateRows, buildSwitcher, SWITCHER_MAX_ROWS } from '../src/core/switcher'
import type { Doc } from '../src/core/types'

const TODAY = '2026-10-07'

function person(id: string, name: string) {
  return { id, name, role: '', parentId: null, order: 0, notes: '' }
}

/** Alpha (active, 🅰️) with Carla + a risk; Beta (🅱️) with José, Bruno + a risk. */
function twoTeamDoc(): Doc {
  const doc = createEmptyDocument('en-US')
  const a = createEmptyTeam('a', 'Alpha', '🅰️', 'en-US')
  const b = createEmptyTeam('b', 'Beta', '🅱️', 'en-US')
  a.stakeholders.push(person('p-carla', 'Carla'))
  a.risks.push({ id: 'r-a', title: 'Alpha slip', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false })
  b.members.push(person('p-jose', 'José'), person('p-bruno', 'Bruno'))
  b.risks.push({ id: 'r-b', title: 'Vendor delay', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false })
  doc.teams.push(a, b)
  doc.nav.activeTeamId = 'a'
  return doc
}

const ids = (doc: Doc, q = '') => buildSwitcher(doc, q, 'en-US', TODAY).map((s) => s.id)
const rowsOf = (doc: Doc, q: string, id: string) => buildSwitcher(doc, q, 'en-US', TODAY).find((s) => s.id === id)?.rows ?? []

describe('allocateRows', () => {
  test('every section full: minimum 4 each, leftovers round-robin → 5/5/5/5', () => {
    expect(allocateRows([10, 10, 10, 10])).toEqual([5, 5, 5, 5])
  })
  test('leftovers skip sections that ran out', () => {
    expect(allocateRows([30, 0, 2, 30])).toEqual([9, 0, 2, 9])
  })
  test('small sections show everything', () => {
    expect(allocateRows([1, 2, 3])).toEqual([1, 2, 3])
  })
  test('a single section may use all 20', () => {
    expect(allocateRows([50])).toEqual([20])
  })
  test('two big sections split 10/10', () => {
    expect(allocateRows([40, 40])).toEqual([10, 10])
  })
})

describe('buildSwitcher sections', () => {
  test('order is favorites, due, current; others stay hidden on an empty query', () => {
    const doc = twoTeamDoc()
    toggleFavorite(doc, { teamId: 'b', ref: { kind: 'risks' } })
    doc.teams[1]!.actionItems.push({ id: 'a1', summary: 'Pay vendor', notes: '', status: 'todo', dueDate: '2026-10-01', assignee: '', color: null, order: 0 })
    expect(ids(doc)).toEqual(['favorites', 'due', 'current'])
  })

  test('a query reveals Other teams and finds people there', () => {
    const doc = twoTeamDoc()
    expect(ids(doc, 'bruno')).toEqual(['others'])
    const [row] = rowsOf(doc, 'bruno', 'others')
    expect(row!.label).toContain('Bruno')
    expect(row!.teamId).toBe('b')
    expect(row!.teamBadge).toBe('🅱️ Beta')
  })

  test('review focus: whitespace-only query counts as empty', () => {
    const doc = twoTeamDoc()
    expect(ids(doc, '   ')).toEqual(ids(doc, ''))
    expect(ids(doc, '   ')).not.toContain('others')
  })

  test('review focus: matching ignores case and accents across teams', () => {
    const doc = twoTeamDoc()
    const rows = rowsOf(doc, 'JOSE', 'others')
    expect(rows.map((r) => r.label).join()).toContain('José')
  })

  test('a team name plus a word narrows to that team', () => {
    const doc = twoTeamDoc()
    const all = buildSwitcher(doc, 'beta risks', 'en-US', TODAY).flatMap((s) => s.rows)
    expect(all.length).toBeGreaterThan(0)
    expect(all.every((r) => r.teamId === 'b')).toBe(true)
    expect(all.some((r) => r.ref.kind === 'risks' && !('itemId' in r.ref))).toBe(true) // Beta's Risks list row
  })

  test('badges: set on favorites, due and other teams; absent on the current team', () => {
    const doc = twoTeamDoc()
    toggleFavorite(doc, { teamId: 'b', ref: { kind: 'risks' } })
    doc.teams[1]!.actionItems.push({ id: 'a1', summary: 'Pay vendor', notes: '', status: 'todo', dueDate: '2026-10-01', assignee: '', color: null, order: 0 })
    expect(rowsOf(doc, '', 'favorites')[0]!.teamBadge).toBe('🅱️ Beta')
    expect(rowsOf(doc, '', 'due')[0]!.teamBadge).toBe('🅱️ Beta')
    expect(rowsOf(doc, '', 'current').every((r) => r.teamBadge === undefined)).toBe(true)
    expect(rowsOf(doc, 'vendor', 'others')[0]!.teamBadge).toBe('🅱️ Beta')
  })

  test('review focus: a team with no emoji gets a trimmed badge', () => {
    const doc = twoTeamDoc()
    doc.teams[1]!.emoji = ''
    expect(rowsOf(doc, 'bruno', 'others')[0]!.teamBadge).toBe('Beta')
  })

  test('headings: favorites, due, current team (emoji + name) and others', () => {
    const doc = twoTeamDoc()
    toggleFavorite(doc, { teamId: 'b', ref: { kind: 'risks' } })
    doc.teams[1]!.actionItems.push({ id: 'a1', summary: 'Pay vendor', notes: '', status: 'todo', dueDate: '2026-10-01', assignee: '', color: null, order: 0 })
    const s = buildSwitcher(doc, 'a', 'en-US', TODAY)
    const byId = Object.fromEntries(s.map((x) => [x.id, x.heading]))
    expect(byId['favorites']).toContain('Favorites')
    expect(byId['due']).toContain('Due dates')
    expect(byId['current']).toBe('🅰️ Alpha')
    expect(byId['others']).toContain('Other teams')
  })

  test('no active team: no current section, and others show even with an empty query', () => {
    const doc = twoTeamDoc()
    doc.nav.activeTeamId = null
    expect(ids(doc)).toEqual(['others'])
  })
})

describe('buildSwitcher favorites', () => {
  test('a module-level favorite is removed from Current team but its cards stay', () => {
    const doc = twoTeamDoc()
    toggleFavorite(doc, { teamId: 'a', ref: { kind: 'risks' } })
    toggleFavorite(doc, { teamId: 'a', ref: { kind: 'person', personId: 'p-carla', group: 'stakeholders' } })
    const current = rowsOf(doc, '', 'current')
    expect(current.some((r) => r.ref.kind === 'risks' && !('itemId' in r.ref))).toBe(false)
    expect(current.some((r) => r.ref.kind === 'risks' && 'itemId' in r.ref && r.ref.itemId === 'r-a')).toBe(true)
    expect(current.some((r) => r.ref.kind === 'person')).toBe(false)
    expect(rowsOf(doc, '', 'favorites')).toHaveLength(2)
  })

  test('favorite rows carry the favorite so ✕ can remove it', () => {
    const doc = twoTeamDoc()
    toggleFavorite(doc, { teamId: 'b', ref: { kind: 'risks' } })
    expect(rowsOf(doc, '', 'favorites')[0]!.favorite).toEqual({ teamId: 'b', ref: { kind: 'risks' } })
  })

  test('orphaned favorites (team gone) are not listed', () => {
    const doc = twoTeamDoc()
    doc.favorites.push({ teamId: 'gone', ref: { kind: 'risks' } })
    expect(ids(doc)).not.toContain('favorites')
  })
})

describe('buildSwitcher due dates', () => {
  test('overdue first, then due soon, with relative labels', () => {
    const doc = twoTeamDoc()
    doc.teams[1]!.actionItems.push(
      { id: 'soon', summary: 'Soon task', notes: '', status: 'todo', dueDate: '2026-10-09', assignee: '', color: null, order: 0 },
      { id: 'late', summary: 'Late task', notes: '', status: 'todo', dueDate: '2026-10-01', assignee: '', color: null, order: 1 },
      { id: 'done', summary: 'Done task', notes: '', status: 'done', dueDate: '2026-10-01', assignee: '', color: null, order: 2 },
    )
    const rows = rowsOf(doc, '', 'due')
    expect(rows.map((r) => r.label)).toEqual(['✅ Late task', '✅ Soon task'])
    expect(rows.map((r) => r.dueLabel)).toEqual(['overdue by 6d', 'in 2d'])
    expect(rows[0]!.ref).toEqual({ kind: 'actions', itemId: 'late' })
    expect(rows[0]!.teamId).toBe('b')
  })

  test('no due items → no due section', () => {
    expect(ids(twoTeamDoc())).not.toContain('due')
  })
})

describe('buildSwitcher row cap', () => {
  test('never more than 20 rows; total reports the uncapped match count', () => {
    const doc = twoTeamDoc()
    for (let i = 0; i < 30; i++) doc.teams[0]!.members.push(person(`m${i}`, `Person ${i}`))
    const sections = buildSwitcher(doc, 'person', 'en-US', TODAY)
    const rows = sections.flatMap((s) => s.rows)
    expect(rows.length).toBeLessThanOrEqual(SWITCHER_MAX_ROWS)
    const current = sections.find((s) => s.id === 'current')!
    expect(current.total).toBe(30)
    expect(current.rows).toHaveLength(20)
  })

  test('every section with matches keeps at least 4 rows even when one is huge', () => {
    const doc = twoTeamDoc()
    for (let i = 0; i < 30; i++) {
      doc.teams[0]!.members.push(person(`m${i}`, `Person ${i}`))
      doc.teams[1]!.members.push(person(`n${i}`, `Person ${i}`))
    }
    const sections = buildSwitcher(doc, 'person', 'en-US', TODAY)
    const byId = Object.fromEntries(sections.map((s) => [s.id, s.rows.length]))
    expect(byId['current']).toBeGreaterThanOrEqual(4)
    expect(byId['others']).toBeGreaterThanOrEqual(4)
  })
})
```

Note on the daily-twin: `buildModuleItems`'s daily row uses today's date from `todayIso()` (wall clock), not `TODAY`; the tests above never favorite a daily row, so they do not depend on the wall clock.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/switcher.test.ts`
Expected: FAIL — cannot resolve `../src/core/switcher`.

- [ ] **Step 4: Implement `src/core/switcher.ts`**

```ts
// src/core/switcher.ts — pure model of the fast switch (ui/palette.ts): four
// sections (Favorites → Due dates → Current team → Other teams), matching,
// dedupe and the 20-row allocation. No DOM, no store: callers pass the Doc.
// ui/palette.ts only renders what this returns.
import type { Doc, Favorite, ModuleRef } from './types'
import { findTeam } from './document'
import { t, type Locale } from './i18n'
import { diffDays } from './date'
import { collectDueItems } from './due'
import { favoriteKey, liveFavorites } from './favorites'
import { buildModuleItems, titleFor } from './module-items'
import { KIND_ICON, normalize } from './search'

export const SWITCHER_MAX_ROWS = 20
export const SWITCHER_MIN_PER_SECTION = 4

export interface SwitcherRow {
  /** Icon + title, e.g. "⚠️ Vendor delay". */
  label: string
  teamId: string
  ref: ModuleRef
  /** "🅱️ Beta" — favorites, due and other-team rows only (the current team's heading already names it). */
  teamBadge?: string
  /** Due rows only, e.g. "overdue by 6d". */
  dueLabel?: string
  /** Favorite rows only: what the row's ✕ removes. */
  favorite?: Favorite
}

export type SwitcherSectionId = 'favorites' | 'due' | 'current' | 'others'

export interface SwitcherSection {
  id: SwitcherSectionId
  heading: string
  /** Matches before the row cap; `rows.length <= total`. */
  total: number
  rows: SwitcherRow[]
}

/**
 * How many rows each section shows. Every section gets `min(count, min)`; the
 * remaining slots go out in round-robin passes in section order, one row per
 * section per pass, until `max` rows are used or nothing is left to show.
 * (4 sections × the default minimum of 4 is 16, so the minimums always fit.)
 */
export function allocateRows(counts: readonly number[], max = SWITCHER_MAX_ROWS, min = SWITCHER_MIN_PER_SECTION): number[] {
  const shown = counts.map((c) => Math.min(c, min))
  let left = max - shown.reduce((a, b) => a + b, 0)
  while (left > 0) {
    let gave = false
    for (let i = 0; i < counts.length && left > 0; i++) {
      if (shown[i]! < counts[i]!) {
        shown[i] = shown[i]! + 1
        left--
        gave = true
      }
    }
    if (!gave) break
  }
  return shown
}

function queryWords(query: string): string[] {
  return normalize(query.trim()).split(/\s+/).filter(Boolean)
}

/** Every word must appear in "<team name> <row title>", so "alpha risks" narrows to one team's Risks. */
function matches(words: string[], teamName: string, label: string): boolean {
  if (words.length === 0) return true
  const hay = normalize(`${teamName} ${label}`)
  return words.every((w) => hay.includes(w))
}

function hasItemId(ref: ModuleRef): boolean {
  return 'itemId' in ref && ref.itemId !== undefined
}

function badge(team: { emoji: string; name: string }): string {
  return `${team.emoji} ${team.name}`.trim()
}

export function buildSwitcher(doc: Doc, query: string, locale: Locale, today: string): SwitcherSection[] {
  const words = queryWords(query)
  const active = doc.nav.activeTeamId === null ? undefined : findTeam(doc, doc.nav.activeTeamId)

  // 1. Favorites (live ones only; the order they were starred).
  const favRows: SwitcherRow[] = []
  for (const fav of liveFavorites(doc)) {
    const team = findTeam(doc, fav.teamId)
    if (!team) continue
    const label = `${KIND_ICON[fav.ref.kind]} ${titleFor(doc, fav, locale)}`
    if (!matches(words, team.name, label)) continue
    favRows.push({ label, teamId: fav.teamId, ref: fav.ref, teamBadge: badge(team), favorite: fav })
  }
  const favKeys = new Set(favRows.map((r) => favoriteKey(r)))

  // 2. Due dates: overdue first, then due soon (collectDueItems already sorts each bucket).
  const buckets = collectDueItems(doc, today)
  const dueRows: SwitcherRow[] = []
  for (const item of [...buckets.overdue, ...buckets.dueSoon]) {
    const team = findTeam(doc, item.loc.teamId)
    if (!team) continue
    const label = `${KIND_ICON[item.loc.ref.kind]} ${item.title}`
    if (!matches(words, team.name, label)) continue
    const dueLabel = item.date < today
      ? t(locale, 'due_overdue_by', { days: String(diffDays(today, item.date)) })
      : t(locale, 'due_in_days', { days: String(diffDays(item.date, today)) })
    dueRows.push({ label, teamId: item.loc.teamId, ref: item.loc.ref, teamBadge: badge(team), dueLabel })
  }

  // 3. Current team. A module-level row already shown as a favorite is dropped;
  // card rows (with an itemId) never are — a favorite opens the module, not a card.
  const currentRows: SwitcherRow[] = []
  if (active) {
    for (const item of buildModuleItems(active, locale)) {
      if (!hasItemId(item.ref) && favKeys.has(favoriteKey({ teamId: active.id, ref: item.ref }))) continue
      if (!matches(words, active.name, item.label)) continue
      currentRows.push({ label: item.label, teamId: active.id, ref: item.ref })
    }
  }

  // 4. Other teams: only once there is a query (or when no team is active, so the box is never blank).
  const otherRows: SwitcherRow[] = []
  if (words.length > 0 || !active) {
    for (const team of doc.teams) {
      if (team.id === active?.id) continue
      for (const item of buildModuleItems(team, locale)) {
        if (!matches(words, team.name, item.label)) continue
        otherRows.push({ label: item.label, teamId: team.id, ref: item.ref, teamBadge: badge(team) })
      }
    }
  }

  const all: { id: SwitcherSectionId; heading: string; rows: SwitcherRow[] }[] = [
    { id: 'favorites', heading: `⭐ ${t(locale, 'switcher_favorites')}`, rows: favRows },
    { id: 'due', heading: `⏰ ${t(locale, 'switcher_due')}`, rows: dueRows },
    { id: 'current', heading: active ? badge(active) : '', rows: currentRows },
    { id: 'others', heading: `🗂️ ${t(locale, 'switcher_others')}`, rows: otherRows },
  ]
  const shown = allocateRows(all.map((s) => s.rows.length))
  return all
    .map((s, i) => ({ id: s.id, heading: s.heading, total: s.rows.length, rows: s.rows.slice(0, shown[i]) }))
    .filter((s) => s.total > 0)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/switcher.test.ts && npm run typecheck && npm run lint`
Expected: PASS. If `KIND_ICON[item.loc.ref.kind]` fails to typecheck, `KIND_ICON`'s key type (`SearchResult['moduleKind']`) and `ModuleRef['kind']` differ — read `src/core/search.ts` and fix the lookup accordingly rather than casting.

- [ ] **Step 6: Commit**

```bash
git add src/core/switcher.ts test/switcher.test.ts src/core/i18n.ts
git commit -m "feat(core): pure switcher model for the cross-team fast switch" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Render the switcher in `ui/palette.ts`

**Files:**
- Rewrite: `src/ui/palette.ts`
- Rewrite: `test/palette.test.ts`
- Modify: `styles.css` (palette block, lines ~790-796)
- Modify: `src/main.ts` (palette creation, ~line 265-272)
- Modify: `src/ui/sidebar.ts` (remove `openDuePanel` from the handle: interface member at ~line 55-56 with its doc comment, and `openDuePanel: () => openDuePanel(...)` in the returned object at ~line 757; the module-level import and the other call sites stay)

**Interfaces:**
- Consumes (Task 2): `buildSwitcher`, `SwitcherRow`, `SwitcherSection`; i18n keys `switcher_count`, `switcher_empty`, `pane_fav_remove_title`.
- Consumes (existing): `toggleFavorite(doc, loc)` from `core/favorites`; `selectableRowProps`, `paintSelection`, `clampMove` from `ui/select-list`.
- Produces: `createPalette(store: Store, pm: PaneManager, deps: PaletteDeps): Palette` where `PaletteDeps = { selectTeam(id: string): void }`, `Palette = { open(): void }`. (`onOpenDue` parameter and the `filterModuleItems` export are gone.)
- DOM contract used by tests/e2e: overlay `.tt-palette-overlay`, input `.tt-palette-input`, per section `div.tt-palette-group[role=group]` containing `.tt-palette-heading` then rows `.tt-palette-item`; inside a row `.tt-palette-label` (carries `title`), optional `.tt-palette-due`, `.tt-palette-team`, `button.tt-palette-remove`; empty state `.tt-palette-empty`.

- [ ] **Step 1: Write the failing tests** — replace `test/palette.test.ts` entirely

```ts
import { createShell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { createPaneManager, type PaneManager } from '../src/ui/panes'
import { createPalette, type Palette } from '../src/ui/palette'
import { toggleFavorite } from '../src/core/favorites'
import { currentLoc } from '../src/core/nav'

function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

interface Setup { store: Store; pm: PaneManager; palette: Palette; selectTeam: ReturnType<typeof vi.fn>; seen: unknown[] }

function setup(opts: { favorites?: boolean; manyPeople?: number } = {}): Setup {
  document.body.innerHTML = ''
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  doc.teams.push({
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 's1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
  })
  const t2 = createEmptyTeam('T2', 'Team 2', '🧪', 'en-US')
  t2.members.push({ id: 'm1', name: 'Bruno', role: '', parentId: null, order: 0, notes: '' })
  doc.teams.push(t2)
  for (let i = 0; i < (opts.manyPeople ?? 0); i++) {
    doc.teams[0]!.members.push({ id: `x${i}`, name: `Person ${i}`, role: '', parentId: null, order: i, notes: '' })
  }
  doc.nav.activeTeamId = 'T1'
  if (opts.favorites) toggleFavorite(doc, { teamId: 'T2', ref: { kind: 'general' } })
  const store = createStore(doc)
  const shell = createShell('en-US')
  const pm = createPaneManager(shell, store, 'en-US')
  // Records what the focused pane showed when selectTeam ran: the team switch
  // must happen BEFORE the row opens.
  const seen: unknown[] = []
  const selectTeam = vi.fn((id: string) => {
    seen.push([id, currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])])
    store.updateNav((d) => { d.nav.activeTeamId = id })
  })
  const palette = createPalette(store, pm, { selectTeam })
  return { store, pm, palette, selectTeam, seen }
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.tt-palette-item'))
const headings = (): string[] => Array.from(document.querySelectorAll('.tt-palette-heading')).map((h) => h.textContent ?? '')
function type(q: string): void {
  const input = document.querySelector('.tt-palette-input') as HTMLInputElement
  input.value = q
  input.dispatchEvent(new Event('input'))
}
const key = (k: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) }

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  document.body.innerHTML = ''
})

test('clicking a row commits it and closes the palette', () => {
  // The row's onclick wiring (commit() fires, overlay closes) — NOT a regression
  // test for the mouseenter/rebuild race below (jsdom dispatches 'click' directly).
  const { palette } = setup()
  palette.open()
  const carlaRow = rows().find((r) => r.textContent?.includes('Carla'))!
  carlaRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
})

test('hovering a row does not replace its DOM node (real-browser click requires mousedown/mouseup on the same element)', () => {
  const { palette } = setup()
  palette.open()
  const before = rows()
  expect(before.length).toBeGreaterThan(1)
  before[1]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
  const after = rows()
  expect(after[0]).toBe(before[0])
  expect(after[1]).toBe(before[1])
  expect(after[1]!.classList.contains('selected')).toBe(true)
  expect(after[0]!.classList.contains('selected')).toBe(false)
})

test('does not open at all when the document has no team', () => {
  const { store, palette } = setup()
  store.update((d) => { d.teams.length = 0; d.nav.activeTeamId = null })
  palette.open()
  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
})

test('Enter does not navigate while a modal is open (e.g. an async save-conflict error appearing over the palette)', () => {
  const { store, palette } = setup()
  palette.open()
  document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tt-modal-overlay' }))
  key('Enter')
  expect(document.querySelector('.tt-palette-overlay')).not.toBeNull()
  expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toBeNull()
  // Drop the blocking modal and close the palette, or its document keydown listener leaks into later tests.
  document.querySelector('.tt-modal-overlay')!.remove()
  key('Escape')
})

// The palette is deliberately opened over the modeless action-item card modal
// (to switch panes); its own keyboard navigation has to keep working there.
test('keyboard nav still works with a modeless card modal open underneath', () => {
  const { palette } = setup()
  document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tt-modal-overlay tt-modal-modeless' }))
  palette.open()
  key('ArrowDown')
  expect(rows()[1]!.classList.contains('selected')).toBe(true)
  expect(rows()[0]!.classList.contains('selected')).toBe(false)
  key('Escape')
  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
})

test('Escape over a modeless card modal closes the palette and is consumed so the card underneath stays open', () => {
  const { palette } = setup()
  document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tt-modal-overlay tt-modal-modeless' }))
  palette.open()
  const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  document.dispatchEvent(evt)
  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
  expect(evt.defaultPrevented).toBe(true)
})

test('each label carries its full text as a tooltip, since rows ellipsize to one line', () => {
  const { palette } = setup({ favorites: true })
  palette.open()
  const labels = Array.from(document.querySelectorAll<HTMLElement>('.tt-palette-label'))
  expect(labels.length).toBeGreaterThan(0)
  for (const l of labels) expect(l.title).toBe(l.textContent)
})

describe('sections', () => {
  test('headings delimit Favorites and the current team; Other teams stay hidden until you type', () => {
    const { palette } = setup({ favorites: true })
    palette.open()
    const h = headings()
    expect(h).toHaveLength(2)
    expect(h[0]).toContain('Favorites')
    expect(h[1]).toBe('🚀 Team 1')
    expect(rows().some((r) => r.textContent?.includes('Bruno'))).toBe(false)

    type('bruno')
    expect(headings()[0]).toContain('Other teams')
    expect(rows().some((r) => r.textContent?.includes('Bruno'))).toBe(true)
  })

  test('arrow keys skip headings and walk rows across sections', () => {
    const { palette } = setup({ favorites: true })
    palette.open()
    expect(rows()[0]!.querySelector('.tt-palette-remove')).not.toBeNull() // first row is the favorite
    key('ArrowDown')
    expect(rows()[1]!.classList.contains('selected')).toBe(true)
    expect(rows()[1]!.querySelector('.tt-palette-remove')).toBeNull() // first current-team row
  })

  test('team badge on favorite and other-team rows, none on current-team rows', () => {
    const { palette } = setup({ favorites: true })
    palette.open()
    const favRow = rows()[0]!
    expect(favRow.querySelector('.tt-palette-team')!.textContent).toBe('🧪 Team 2')
    const carla = rows().find((r) => r.textContent?.includes('Carla'))!
    expect(carla.querySelector('.tt-palette-team')).toBeNull()
    type('bruno')
    expect(rows()[0]!.querySelector('.tt-palette-team')!.textContent).toBe('🧪 Team 2')
  })

  test('a section that was cut short says how many matches it has', () => {
    const { palette } = setup({ manyPeople: 30 })
    palette.open()
    type('person')
    expect(rows().length).toBeLessThanOrEqual(20)
    expect(headings()[0]).toMatch(/20 of 30/)
  })

  test('typing a team name plus a word narrows to that team', () => {
    const { palette } = setup()
    palette.open()
    type('team 2 general')
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().every((r) => r.querySelector('.tt-palette-team')!.textContent === '🧪 Team 2')).toBe(true)
  })
})

describe('commit', () => {
  test('a row on another team switches team first, then opens there', () => {
    const { palette, store, selectTeam, seen } = setup()
    palette.open()
    type('bruno')
    rows()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(selectTeam).toHaveBeenCalledWith('T2')
    expect(seen).toEqual([['T2', null]]) // nothing was open yet when the team switched
    expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toMatchObject({ teamId: 'T2', ref: { kind: 'person', personId: 'm1' } })
    expect(document.querySelector('.tt-palette-overlay')).toBeNull()
  })

  test('a row on the active team does not call selectTeam', () => {
    const { palette, selectTeam } = setup()
    palette.open()
    rows().find((r) => r.textContent?.includes('Carla'))!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(selectTeam).not.toHaveBeenCalled()
  })

  test('review focus: Enter with zero matches shows "No results" and does nothing', () => {
    const { palette, store, selectTeam } = setup()
    palette.open()
    type('zzzzzz')
    expect(rows()).toHaveLength(0)
    expect(document.querySelector('.tt-palette-empty')!.textContent).toBe('No results')
    key('Enter')
    expect(document.querySelector('.tt-palette-overlay')).not.toBeNull()
    expect(selectTeam).not.toHaveBeenCalled()
    expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toBeNull()
  })
})

describe('removing a favorite with ✕', () => {
  test('removes it from the doc without committing, and keeps the palette open', () => {
    const { palette, store, selectTeam } = setup({ favorites: true })
    palette.open()
    const x = document.querySelector<HTMLButtonElement>('.tt-palette-remove')!
    expect(x.title).toBe('Remove from favorites')
    x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(store.doc.favorites).toEqual([])
    expect(document.querySelector('.tt-palette-overlay')).not.toBeNull()
    expect(selectTeam).not.toHaveBeenCalled()
    expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toBeNull()
  })

  test('review focus: removing the last favorite drops the section and clamps the selection', () => {
    const { palette } = setup({ favorites: true })
    palette.open()
    expect(headings()[0]).toContain('Favorites')
    document.querySelector<HTMLButtonElement>('.tt-palette-remove')!.click()
    expect(headings().some((h) => h.includes('Favorites'))).toBe(false)
    expect(document.querySelector('.tt-palette-remove')).toBeNull()
    expect(rows().filter((r) => r.classList.contains('selected'))).toHaveLength(1)
    key('Enter') // selected row is a normal current-team row; must not throw
  })

  test('review focus: ✕ on the selected last row keeps a valid selection', () => {
    const { palette } = setup({ favorites: true })
    palette.open()
    key('ArrowDown')
    key('ArrowUp') // back on the favorite row, which is also index 0
    document.querySelector<HTMLButtonElement>('.tt-palette-remove')!.click()
    expect(rows().filter((r) => r.classList.contains('selected'))).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/palette.test.ts`
Expected: FAIL (palette still takes `onOpenDue`; no `.tt-palette-heading`/`.tt-palette-label`).

- [ ] **Step 3: Rewrite `src/ui/palette.ts`**

```ts
// src/ui/palette.ts — the fast switch (Ctrl+Shift+K / app-name button): one
// cross-team switcher listing Favorites, Due dates, the current team and — once
// you type — the other teams. The model (matching, dedupe, the 20-row cap)
// lives in core/switcher.ts; this file renders it and handles keys/commit.
// Favorite rows carry a ✕ that unstars them in place.
import type { Store } from '../core/store'
import type { Favorite } from '../core/types'
import type { Locale } from '../core/i18n'
import { t, todayIso } from '../core/i18n'
import { toggleFavorite } from '../core/favorites'
import { buildSwitcher, type SwitcherRow, type SwitcherSection } from '../core/switcher'
import { el } from './dom'
import { paintSelection, clampMove, selectableRowProps } from './select-list'
import type { PaneManager } from './panes'
import { applySearchHighlight, dispatchSearchFocusItem } from './search-highlight'
import { blockedByBlockingModal } from './hotkeys'
import { dismissModelessModals } from './modal'

export interface Palette {
  open(): void
}

export interface PaletteDeps {
  /** Switches the active team (main.ts's selectTeam) — called before a row on another team opens. */
  selectTeam(id: string): void
}

export function createPalette(store: Store, pm: PaneManager, deps: PaletteDeps): Palette {
  let overlay: HTMLElement | null = null
  let listEl: HTMLElement | null = null
  let input: HTMLInputElement | null = null
  let sections: SwitcherSection[] = []
  let rows: SwitcherRow[] = []
  let selected = 0

  function locale(): Locale {
    return store.doc.prefs.locale
  }

  function rebuild(): void {
    sections = buildSwitcher(store.doc, input?.value ?? '', locale(), todayIso())
    rows = sections.flatMap((s) => s.rows)
  }

  function close(): void {
    if (!overlay) return
    overlay.remove()
    overlay = null
    listEl = null
    input = null
    document.removeEventListener('keydown', onKeydown, true)
  }

  function commit(row: SwitcherRow | undefined): void {
    if (!row) return
    // A card modal open over the palette must close first (flushing its
    // notes editor) — every row here re-targets a pane. If its required-name
    // guard vetoes, keep the palette open on the still-open card.
    if (!dismissModelessModals()) return
    close()
    if (row.teamId !== store.doc.nav.activeTeamId) deps.selectTeam(row.teamId)
    pm.openInFocused({ teamId: row.teamId, ref: row.ref })
    // Mirrors search-ui.ts's commit(): expand the item (if collapsible)
    // and scroll/flash it into view, just without term highlighting —
    // the palette has no search query, only a resolved itemId.
    const itemId = 'itemId' in row.ref ? row.ref.itemId : undefined
    if (!itemId) return
    requestAnimationFrame(() => {
      const paneEl = document.querySelectorAll('.tt-pane-body')[store.doc.nav.focusedPane] as HTMLElement | undefined
      if (!paneEl) return
      dispatchSearchFocusItem(paneEl, itemId)
      const anchor = paneEl.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`)
      if (anchor) applySearchHighlight([paneEl], [], anchor)
    })
  }

  function removeFavorite(fav: Favorite): void {
    store.update((d) => { toggleFavorite(d, fav) })
    rebuild()
    selected = Math.min(selected, Math.max(0, rows.length - 1))
    renderList()
  }

  function buildRow(row: SwitcherRow, i: number): HTMLElement {
    const parts: HTMLElement[] = [el('span', { class: 'tt-palette-label', title: row.label }, row.label)]
    if (row.dueLabel) parts.push(el('span', { class: 'tt-palette-due', title: row.dueLabel }, row.dueLabel))
    if (row.teamBadge) parts.push(el('span', { class: 'tt-palette-team', title: row.teamBadge }, row.teamBadge))
    const fav = row.favorite
    if (fav) {
      parts.push(el('button', {
        class: 'tt-palette-remove',
        type: 'button',
        title: t(locale(), 'pane_fav_remove_title'),
        'aria-label': t(locale(), 'pane_fav_remove_title'),
        onmousedown: (e: Event) => e.preventDefault(),
        onclick: (e: Event) => { e.stopPropagation(); removeFavorite(fav) },
      }, '✕'))
    }
    return el(
      'div',
      selectableRowProps({
        class: 'tt-palette-item',
        selected: i === selected,
        onCommit: () => commit(row),
        onHover: () => { selected = i; paintSelection(listEl, '.tt-palette-item', selected) },
      }),
      ...parts
    )
  }

  // Hover/arrow selection repaints in place via paintSelection — see
  // src/ui/select-list.ts for the rebuild-on-hover Chrome loop this avoids.
  // Only typing and ✕ (a structural change) rebuild the rows. Headings are not
  // `.tt-palette-item`, so arrows and hover never land on them.
  function renderList(): void {
    if (!listEl) return
    listEl.innerHTML = ''
    if (rows.length === 0) {
      listEl.appendChild(el('div', { class: 'tt-palette-empty' }, t(locale(), 'switcher_empty')))
      return
    }
    let index = 0
    for (const section of sections) {
      const headingId = `tt-palette-heading-${section.id}`
      const count = section.rows.length < section.total
        ? ` · ${t(locale(), 'switcher_count', { shown: String(section.rows.length), total: String(section.total) })}`
        : ''
      const group = el(
        'div',
        { class: 'tt-palette-group', role: 'group', 'aria-labelledby': headingId },
        el('div', { class: 'tt-palette-heading', id: headingId, title: section.heading }, `${section.heading}${count}`)
      )
      for (const row of section.rows) group.appendChild(buildRow(row, index++))
      listEl.appendChild(group)
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    // A *blocking* modal (e.g. an async save-conflict error) can appear while
    // the palette is already open — this capturing document listener must not
    // act (in particular Enter's navigation) behind it. A *modeless* card
    // modal is different: the palette deliberately opens over it (to switch
    // panes), so its own arrow/Enter/Escape keys have to keep working — and
    // stopPropagation below keeps Escape from also reaching that card's
    // document listener underneath.
    if (blockedByBlockingModal()) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      selected = clampMove(selected, e.key === 'ArrowDown' ? 1 : -1, rows.length)
      paintSelection(listEl, '.tt-palette-item', selected)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      commit(rows[selected])
    }
  }

  function open(): void {
    if (overlay) return
    // Every row commits into some team, so with no team the palette can only
    // list rows that no-op on Enter. Same rule the search bar applies
    // (src/ui/search-ui.ts syncEnabled) — the header button is disabled to
    // match, and this guard also covers the Ctrl+Shift+K path.
    if (store.doc.teams.length === 0) return
    input = el('input', {
      type: 'text',
      class: 'tt-input tt-palette-input',
      placeholder: t(locale(), 'palette_placeholder'),
    })
    listEl = el('div', { class: 'tt-palette-list' })
    const dialog = el('div', { class: 'tt-palette-dialog' }, input, listEl)
    overlay = el('div', { class: 'tt-palette-overlay' }, dialog)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close()
    })
    document.body.appendChild(overlay)

    selected = 0
    rebuild()
    input.addEventListener('input', () => {
      selected = 0
      rebuild()
      renderList()
    })
    document.addEventListener('keydown', onKeydown, true)
    renderList()
    input.focus()
  }

  return { open }
}
```

If `el()` rejects the `id`/`role`/`aria-labelledby` props at the type level, look at `src/ui/dom.ts` for how attributes are typed and follow its pattern (`src/ui/favorites.ts` already passes `role` and `aria-label`).

- [ ] **Step 4: CSS** — in `styles.css`, replace these two existing rules (and the comment above `.tt-palette-item`):

```css
.tt-palette-list { overflow-y: auto; padding: .25rem; }
/* One line per entry whatever the item's title length; the full text is on the
   row's own title tooltip (palette.ts). */
.tt-palette-item { padding: .5rem .6rem; border-radius: 4px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tt-palette-item.selected, .tt-palette-item:hover { background: rgba(var(--accent-rgb), .12); }
```

with:

```css
.tt-palette-list { overflow-y: auto; padding: .25rem; }
/* Sections (core/switcher.ts): each group gets a heading, and every group after
   the first a rule above it, so Favorites / Due dates / team / Other teams read
   as separate lists at a glance. */
.tt-palette-group + .tt-palette-group { margin-top: .35rem; padding-top: .35rem; border-top: 1px solid var(--border); }
.tt-palette-heading {
  padding: .25rem .6rem; font-size: .75rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* One line per entry whatever the title length: the label ellipsizes (full text
   on its title tooltip, palette.ts); due text, team badge and ✕ are fixed items
   that never shrink. min-height keeps rows with and without the ✕ the same height. */
.tt-palette-item { display: flex; align-items: center; gap: .5rem; box-sizing: border-box; min-height: 2.5rem; padding: .5rem .6rem; border-radius: 4px; cursor: pointer; }
.tt-palette-item.selected, .tt-palette-item:hover { background: rgba(var(--accent-rgb), .12); }
.tt-palette-label { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tt-palette-due { flex: none; color: var(--muted); font-size: .85rem; white-space: nowrap; }
.tt-palette-team { flex: none; max-width: 10rem; color: var(--muted); font-size: .85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tt-palette-remove {
  flex: none; width: 1.5rem; height: 1.5rem; padding: 0; line-height: 1;
  background: transparent; color: var(--fg); border: none; border-radius: 4px; cursor: pointer; opacity: .6;
}
.tt-palette-remove:hover { opacity: 1; color: var(--accent); }
.tt-palette-empty { padding: .75rem; opacity: .75; }
```

- [ ] **Step 5: Wire `main.ts` and drop the sidebar handle member**

In `src/main.ts` replace

```ts
  // sidebarHandle isn't declared until mountSidebar() runs later in this
  // function — safe to reference here because this arrow function only ever
  // executes later (Ctrl+Shift+K or the app-name click), by which point
  // mountSidebar() has already returned it.
  const palette = createPalette(store, pm, () => sidebarHandle.openDuePanel())
```

with

```ts
  // `selectTeam` is a hoisted function declaration (below), safe to pass here.
  const palette = createPalette(store, pm, { selectTeam })
```

In `src/ui/sidebar.ts` delete the `openDuePanel(): void` member and its doc comment from the handle interface, and the `openDuePanel: () => openDuePanel({ locale: locale(), buckets: dueBuckets(), onOpenItem }),` line from the returned object. Keep the `import { openDuePanel } from './due-panel'` and every other call site.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run lint && npx vitest run test/palette.test.ts test/sidebar.test.ts test/switcher.test.ts test/module-items.test.ts test/panes.test.ts`
Expected: PASS. Then `npm test` (full suite) — expected PASS (the old favorites panel and its tests are still present until Task 4).

- [ ] **Step 7: Commit**

```bash
git add src/ui/palette.ts test/palette.test.ts styles.css src/main.ts src/ui/sidebar.ts
git commit -m "feat(ui): cross-team fast switch with sections, team badges and favorite ✕" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Remove the header ★, the favorites panel and Ctrl+Alt+F

**Files:**
- Delete: `src/ui/favorites.ts`, `test/favorites-panel.test.ts`
- Modify: `src/ui/shell.ts`, `src/ui/search-ui.ts`, `src/ui/app-hotkeys.ts`, `src/ui/help.ts`, `src/main.ts`, `src/core/i18n.ts`, `src/core/favorites.ts` (header comment only), `styles.css`
- Modify tests: `test/shell.test.ts`, `test/app-hotkeys.test.ts`, `test/search-ui.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Shell` no longer has `onFavorites`/`setFavoritesEnabled`; `AppHotkeyAction` no longer has `{ type: 'favorites' }`; i18n keys `favorites_btn_title`, `favorites_panel_label`, `favorites_empty`, `help_global_favorites` no longer exist. `pane_fav_add_title` and `pane_fav_remove_title` stay (pane bar star and the ✕).

- [ ] **Step 1: Update tests first (they will fail until the code changes)**

`test/app-hotkeys.test.ts` — replace the whole `describe('Ctrl+Alt+F → favorites', …)` block with:

```ts
describe('Ctrl+Alt+F (retired favorites hotkey)', () => {
  test('is no longer claimed', () => {
    expect(resolve({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true })).toBeNull()
    expect(resolve({ key: 'f', code: 'KeyF', metaKey: true, altKey: true })).toBeNull()
  })

  test('Ctrl+Shift+F (search all teams), plain Ctrl+F and Alt+F are not claimed either', () => {
    expect(resolve({ key: 'f', code: 'KeyF', ctrlKey: true, shiftKey: true })).toBeNull()
    expect(resolve({ key: 'f', code: 'KeyF', ctrlKey: true })).toBeNull()
    expect(resolve({ key: 'f', code: 'KeyF', altKey: true })).toBeNull()
  })
})
```

`test/shell.test.ts` — replace `describe('favorites button', …)` with only the right-cluster test, renamed:

```ts
describe('header right cluster', () => {
  test('order: save pill, view/help group, settings then close-file', () => {
    const shell = setup()
    const order = Array.from(shell.headerRight.querySelectorAll('.tt-save-pill-wrap, .tt-btn')).map(
      (e) => ['tt-save-pill-wrap', 'tt-btn-fullscreen', 'tt-btn-help', 'tt-btn-settings', 'tt-btn-close-file'].find((c) => e.classList.contains(c))
    )
    expect(order).toEqual(['tt-save-pill-wrap', 'tt-btn-fullscreen', 'tt-btn-help', 'tt-btn-settings', 'tt-btn-close-file'])
  })

  test('there is no favorites ★ button any more', () => {
    expect(setup().root.querySelector('.tt-btn-favorites')).toBeNull()
  })
})
```
(then remove any import the deletion leaves unused, e.g. `t`, `createEmptyDocument`, `vi`, if no other test in the file uses them).

`test/search-ui.test.ts` — replace the test at ~line 498 with:

```ts
test('the search box mounts in the header left cluster, after the app name', () => {
  const { shell } = mount(buildStore([oneNoteTeam], 'T1'), fakePM())
  const kids = Array.from(shell.headerLeft.children)
  const wrap = kids.findIndex((c) => c.classList.contains('tt-search-wrap'))
  expect(wrap).toBeGreaterThan(kids.findIndex((c) => c.classList.contains('tt-app-name')))
})
```

Delete `test/favorites-panel.test.ts` (`git rm`).

- [ ] **Step 2: Remove the source**

- `git rm src/ui/favorites.ts`.
- `src/ui/shell.ts`: delete the interface members `onFavorites` / `setFavoritesEnabled` and their doc comments (~lines 41-44); delete the `favoritesHandler` / `favoritesBtn` definitions (~272-277) and `headerLeft.appendChild(favoritesBtn)`; replace the comment above the `headerRight.append(` with `// The right cluster is status, then view/help utilities, then settings and the session-ending close-file button last, kept apart from the utilities. (mountSearch() appends the search box to headerLeft.)`; delete `favoritesBtn.title = t(currentLocale, 'favorites_btn_title')` in `applyPrefs` (~line 415), the `onFavorites` and `setFavoritesEnabled` functions (~433-439), and their two names in the returned object (~line 493).
- `src/ui/search-ui.ts` (~lines 144-146): replace the comment + `shell.headerLeft.insertBefore(wrap, shell.headerLeft.querySelector('.tt-btn-favorites'))` with `shell.headerLeft.appendChild(wrap)`.
- `src/ui/app-hotkeys.ts`: delete the `/** Ctrl/Cmd+Alt+F → toggle the favorites panel … */ | { type: 'favorites' }` union member (lines 20-21) and the `Ctrl+Alt+F: favorites panel…` branch (lines 87-91 including its comment).
- `src/ui/help.ts`: delete the `['Ctrl+Alt+F', 'help_global_favorites'],` row.
- `src/main.ts`: delete `import { createFavoritesPanel } from './ui/favorites'`; delete the block from `// Favorites: the header ★ and Ctrl+Alt+F drive one panel…` through `disposers.push(() => favorites.dispose())` (keep the following `disposers.push(mountSearch(…))` line); delete `case 'favorites': favorites.toggle(); return` from the hotkey switch.
- `src/core/i18n.ts`: delete `help_global_favorites`, `favorites_btn_title`, `favorites_panel_label`, `favorites_empty` from **both** `pt` and `en` (keep `pane_fav_add_title`, `pane_fav_remove_title`).
- `src/core/favorites.ts`: change the header comment's `(the pane-bar star and the header favorites panel)` to `(the pane-bar star and the fast switch's Favorites section)`.
- `styles.css`: delete the whole `/* Favorites panel (src/ui/favorites.ts): … */` block through `.tt-favorites-empty { … }`; delete the `.tt-header.tt-header-compact .tt-btn-favorites,` selector line (~309) — keep the selector list valid (the neighbouring lines end in commas); delete `.tt-btn-favorites:disabled { … }` (~370); in the comment near line 303 change `Ctrl+Shift+K/Ctrl+F for the app name/search, Ctrl+Alt+F for the favorites panel` to `Ctrl+Shift+K/Ctrl+F for the app name/search`.

- [ ] **Step 3: Verify nothing references the removed code**

Run: `rg -n "favorites_btn_title|favorites_panel_label|favorites_empty|help_global_favorites|tt-btn-favorites|tt-favorites-|createFavoritesPanel|onFavorites|setFavoritesEnabled|Ctrl\+Alt\+F" src test styles.css`
Expected: only `e2e/` hits (fixed in Task 5) and none under `src`, `test`, `styles.css`. (Use Grep tool if `rg` is unavailable.)

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A src test styles.css
git commit -m "feat!: remove the header favorites button, panel and Ctrl+Alt+F" -m "Favorites now live in the fast switch." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: E2E specs

jsdom has no layout, so the one-line-per-row, viewport and ≤20-row guarantees are checked here.

**Files:**
- Rewrite: `e2e/favorites.spec.ts`
- Modify: `e2e/scroll-and-overflow.spec.ts` (the `fast switch (Ctrl+Shift+K)` test, ~lines 42-58)

**Interfaces:** Consumes the DOM contract from Task 3 and the `buildDoc`/`openDoc`/`TEAM_ID` helpers from `e2e/layout-fixtures.ts`.

- [ ] **Step 1: Rewrite `e2e/favorites.spec.ts`**

```ts
// e2e/favorites.spec.ts — favorites end to end through the fast switch, plus
// the layout guards the unit tests can't give (jsdom has no layout).
import { test, expect, type Page } from '@playwright/test'
import { createEmptyTeam } from '../src/core/document'
import { buildDoc, openDoc, TEAM_ID } from './layout-fixtures'

const paneTitle = (page: Page, idx: 0 | 1 = 0): ReturnType<Page['locator']> =>
  page.locator('.tt-pane-title-text').nth(idx)

test('star a pane, switch team, jump back from the fast switch, then remove the favorite with ✕', async ({ page }) => {
  const doc = buildDoc('M', { kind: 'general' })
  doc.teams.push(createEmptyTeam('team-1', 'Second team', '🧪', 'en-US'))
  await openDoc(page, doc)

  await page.locator('.tt-pane-fav-btn').first().click()
  await expect(page.locator('.tt-pane-fav-btn').first()).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('Alt+2') // switch to the second team
  await expect(paneTitle(page)).not.toContainText('General notes')

  await page.keyboard.press('Control+Shift+K')
  await expect(page.locator('.tt-palette-heading').first()).toContainText(/favorites/i)
  await expect(page.locator('.tt-palette-group').first().locator('.tt-palette-item')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.locator('.tt-palette-overlay')).toHaveCount(0)
  await expect(paneTitle(page)).toContainText('General notes')

  await page.keyboard.press('Control+Shift+K')
  await page.locator('.tt-palette-remove').click()
  await expect(page.locator('.tt-palette-remove')).toHaveCount(0)
  await expect(page.locator('.tt-palette-overlay')).toBeVisible() // ✕ does not close or navigate
  await page.keyboard.press('Escape')
  await expect(page.locator('.tt-pane-fav-btn').first()).toHaveAttribute('aria-pressed', 'false')
})

test('the fast switch reaches another team by typing, and switches to it', async ({ page }) => {
  const doc = buildDoc('M', { kind: 'general' })
  const second = createEmptyTeam('team-1', 'Second team', '🧪', 'en-US')
  second.members.push({ id: 'zed', name: 'Zedekiah', role: '', parentId: null, order: 0, notes: '' })
  doc.teams.push(second)
  await openDoc(page, doc)

  await page.keyboard.press('Control+Shift+K')
  await expect(page.locator('.tt-palette-item').filter({ hasText: 'Zedekiah' })).toHaveCount(0) // hidden until you type
  await page.locator('.tt-palette-input').fill('zedek')
  const row = page.locator('.tt-palette-item').filter({ hasText: 'Zedekiah' })
  await expect(row.locator('.tt-palette-team')).toContainText('Second team')
  await page.keyboard.press('Enter')
  await expect(paneTitle(page)).toContainText('Zedekiah')
})

for (const size of ['XS', 'XL'] as const) {
  test(`fast switch with 34 favorites: at most 20 rows, one line each, inside the viewport (${size})`, async ({ page }) => {
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
    await page.keyboard.press('Control+Shift+K')
    await expect(page.locator('.tt-palette-dialog')).toBeVisible()

    const r = await page.evaluate(() => {
      const dialog = document.querySelector('.tt-palette-dialog')!.getBoundingClientRect()
      const rows = [...document.querySelectorAll<HTMLElement>('.tt-palette-item')]
      const labels = [...document.querySelectorAll<HTMLElement>('.tt-palette-label')]
      return {
        rows: rows.length,
        headings: document.querySelectorAll('.tt-palette-heading').length,
        tall: labels.filter((e) => e.getBoundingClientRect().height >= 2 * parseFloat(getComputedStyle(e).fontSize)).length,
        inViewport: dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight,
        distinctRowHeights: new Set(rows.map((e) => Math.round(e.getBoundingClientRect().height))).size,
      }
    })
    expect(r.rows).toBeLessThanOrEqual(20)
    expect(r.rows).toBeGreaterThanOrEqual(8)
    expect(r.headings).toBeGreaterThanOrEqual(2) // Favorites and the current team, each with a heading
    expect(r.tall).toBe(0)
    expect(r.inViewport).toBe(true)
    expect(r.distinctRowHeights).toBe(1) // rows with and without ✕ are the same height

    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.locator('.tt-palette-overlay')).toHaveCount(0)
  })
}
```

The old third test (header ★ never overlaps the search box/app name/save pill) is deleted: the ★ no longer exists.

- [ ] **Step 2: Update the overflow test in `e2e/scroll-and-overflow.spec.ts`**

Open `e2e/layout-fixtures.ts`, find the long action-item summary the old test relied on to get an ellipsized row, and pick a distinctive word from it. Then replace the `fast switch (Ctrl+Shift+K)` test body after the width assertion with (substitute `LONGWORD`):

```ts
  await page.locator('.tt-palette-input').fill('LONGWORD') // the long summary would otherwise sit past the 20-row cap
  const rows = await dialog.locator('.tt-palette-item').evaluateAll((els) =>
    els.map((e) => {
      const label = e.querySelector<HTMLElement>('.tt-palette-label')!
      return { h: e.getBoundingClientRect().height, clipped: label.scrollWidth > label.clientWidth, tip: label.title, text: label.textContent }
    })
  )
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.length).toBeLessThanOrEqual(20)
  expect(new Set(rows.map((r) => Math.round(r.h))).size).toBe(1) // one line each
  expect(rows.some((r) => r.clipped)).toBe(true) // the long summary is ellipsized…
  for (const r of rows) expect(r.tip).toBe(r.text) // …and each label carries its full text as a tooltip
```
(Also change the `.first()).toBeVisible()` wait above it if it breaks after the row cap — it should not.) If the query yields only the one long row, `new Set(...).size` is trivially 1; that is acceptable here — the multi-row one-line guard lives in `favorites.spec.ts`.

- [ ] **Step 3: Run the affected specs**

Run: `npm run build && npx playwright test e2e/favorites.spec.ts e2e/scroll-and-overflow.spec.ts e2e/smoke.spec.ts e2e/leak.spec.ts e2e/a11y.spec.ts`
Expected: PASS. If the whole run crashes on an IndexedDB file-handle read, that is the known pinned-Chromium problem (see the `playwright-pinned-chromium-153` memory) — report it rather than "fixing" it; the affected-by-this-change specs above should not hit that path.
If `distinctRowHeights` is 2, the ✕ row is taller than a plain row: raise `.tt-palette-item`'s `min-height` in `styles.css` until both are equal (the ✕ is 1.5rem + .5rem×2 padding = 2.5rem).

- [ ] **Step 4: Commit**

```bash
git add e2e/favorites.spec.ts e2e/scroll-and-overflow.spec.ts styles.css
git commit -m "test(e2e): cover the cross-team fast switch and favorite ✕" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs, changelog, version 2.11.0, final gate

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`

- [ ] **Step 1: Load the `changelog` skill** (Skill tool, `changelog`) and follow its rules for the entry below.

- [ ] **Step 2: Bump the version**

Run: `npm version 2.11.0 --no-git-tag-version`
Expected: `package.json` and `package-lock.json` both show `2.11.0` (verify with `git diff --stat`; no git tag, no commit).

- [ ] **Step 3: Add the CHANGELOG entry** — insert above `## [2.10.0]`, adjusting wording only if the changelog skill's rules require it:

```markdown
## [2.11.0] - 2026-10-07

### Changed
- The fast switch (Ctrl+Shift+K, or click the app name) now searches every team, not only the one you're on. Results come in sections: your favorites, items that are overdue or due soon, the current team's modules, people and cards, and — as soon as you type — everything in your other teams. Picking a row from another team switches to that team first.
- Rows from other teams, favorites and due items show the team's emoji and name. Typing a team's name together with a word (for example "alpha risks") narrows the list to that team.
- The list shows at most 20 rows. Each section keeps its own share, and a section that was cut short shows how many matches it has (for example "10 of 31").
- Overdue and due-soon items now appear as rows in the fast switch itself, instead of one "Due" entry that opened the due list.
- Favorites are used from the fast switch: they are its first section, and a ✕ at the end of a favorite's row removes it. The ☆ in each pane's title bar still adds or removes a favorite.

### Removed
- The ★ button in the header and its Ctrl+Alt+F shortcut. Your saved favorites are untouched — open the fast switch to use them.
```

- [ ] **Step 4: Update docs**

- `README.md`: in the lines that describe the fast switch (around lines 14, 37-38, 66), change "…in the current team" wording to say it searches every team and holds your favorites and due items. Keep the screenshot reference; the screenshot itself is stale — do not try to regenerate it, mention it in your report.
- `docs/ARCHITECTURE.md`: in the `src/core/` bullet add `the fast-switch model (`switcher.ts`, `module-items.ts`)`.
- `CLAUDE.md`: in the `src/core/` list add after the `scope.ts` bullet: `- **`switcher.ts` / `module-items.ts`** — pure model of the Ctrl+Shift+K fast switch (Favorites → Due dates → Current team → Other teams; matching, favorite dedupe, 20-row cap via `allocateRows`) and the shared `buildModuleItems`/`titleFor` row builders. `ui/palette.ts` only renders it.` Keep the tone of the surrounding bullets.

- [ ] **Step 5: Full gate**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all PASS. Also run `git grep -n "Ctrl+Alt+F"` — expected: only `CHANGELOG.md` (2.10.0 history and the new 2.11.0 line) and the spec/plan docs.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/ARCHITECTURE.md CLAUDE.md CHANGELOG.md package.json package-lock.json
git commit -m "chore(release): 2.11.0 — cross-team fast switch" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(`dev` takes direct commits; do **not** push or open a `dev → main` PR unless the user asks.)

---

## Self-Review (done)

- **Spec coverage:** sections + order → Task 2/3; empty-query hides others → T2; token matching incl. team name → T2; 20-row cap/round-robin → T2 (`allocateRows`); badges (not on current) → T2/T3; dedupe → T2; ✕ → T3; heading delimitation + count + a11y groups → T3 (+CSS); commit with `selectTeam` → T3; removals (★, panel, hotkey, help, i18n, CSS, search-ui insertBefore, sidebar handle) → T3/T4; kept items untouched; `core/module-items.ts` move → T1; i18n incl. placeholder → T2; tests/e2e → T1-T5; docs/changelog/2.11.0 → T6; no-active-team edge → T2 test; "No results" → T3.
- **Placeholder scan:** none; the one data-dependent step (`LONGWORD` in the overflow e2e) tells the engineer exactly where to read it from.
- **Type consistency:** `SwitcherRow`/`SwitcherSection`/`allocateRows`/`buildSwitcher` names match across Tasks 2–3; `createPalette(store, pm, { selectTeam })` matches in `main.ts`, tests and e2e; `titleFor(doc, loc, locale)` used in Tasks 1–2.
- **Review Focus:** all five lines have tests (whitespace, accents, empty emoji → Task 2; last-favorite ✕, zero-results Enter → Task 3).
