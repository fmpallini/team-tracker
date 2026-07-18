# Due/overdue reminders + named action-item tags — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-app due/overdue surfacing (sidebar badge + a due-items list, covering action items and milestones) and per-team named tags for the 6 existing action-item colors (edit modal + Kanban filter), per `docs/superpowers/specs/2026-07-17-due-reminders-and-tags-design.md`.

**Architecture:** A new pure `src/core/due.ts` computes overdue/due-soon buckets from the `Doc`; `src/ui/sidebar.ts` renders a badge and a `showModal`-based list wired to `PaneManager.openInFocused`. Tags are a per-team `actionTagNames` map on `Team`, edited via a new modal in `src/modules/action-items.ts` and consumed by the existing Kanban card renderer and a new filter-chip row. Both features share one schema bump.

**Tech Stack:** TypeScript, vitest + jsdom, no new runtime dependencies (zero-dependency constraint).

## Global Constraints

- Zero runtime dependencies — no new packages in `dependencies` (dev-only tooling is fine, and this plan adds none).
- Every user-visible string goes through `t(locale, key)` in `src/core/i18n.ts`, with a key added to **both** the `pt` and `en` dictionaries in the same step — a key present in only one locale fails nothing at build time but silently prints `undefined` at runtime, so both must land together.
- Every `src` module touched here already has a matching `test/*.test.ts`; new files get a new test file at the mirrored path.
- Bumping `SCHEMA_VERSION` requires a `MIGRATIONS[n]` step in `src/core/document.ts` for any field whose absence would otherwise crash or misbehave on an old file — see Task 1's rationale for why `actionTagNames` doesn't need one but `prefs.dueSoonDays` does.
- `npm run typecheck` (`tsc --noEmit`, strict) and `npm run lint` (`eslint src test`) must both pass after every task — run them as part of each task's verification, not just at the end.

---

## Task 1: Schema v6 — `prefs.dueSoonDays` + `Team.actionTagNames`

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/document.ts`
- Modify: `test/document.test.ts`

**Interfaces:**
- Produces: `Prefs.dueSoonDays: number` (required, default `3`) — consumed by Task 2's `collectDueItems` and Task 4's Prefs UI.
- Produces: `Team.actionTagNames?: Partial<Record<ActionItem['color'], string>>` (optional) — consumed by Task 5 (write) and Task 6 (read).

**Design note (refinement over the spec):** the spec describes `actionTagNames` as required with a `{}` default filled in by a migration step. Making it **optional** instead (`actionTagNames?: ...`) is behaviorally identical at every read site (`team.actionTagNames?.[color] ?? fallback`, same as `?? {}` would produce) but avoids a required-field ripple through the ~13 existing test files that construct `Team` object literals directly (`action-items.test.ts`, `sidebar.test.ts`, `people-tree.test.ts`, etc. — none of them care about tags). `prefs.dueSoonDays` stays **required** with a real migration step, because `Prefs` is only ever constructed via `createEmptyDocument()` in tests (checked: only `test/document.test.ts` builds a literal `Prefs` object, and that file is already being edited in this task) — no ripple risk there, and Prefs fields are conventionally required elsewhere in this codebase (`autoSaveMin`, `palette`, etc.).

- [ ] **Step 1: Write the failing tests**

Edit `test/document.test.ts`:

1. Update the existing shape assertion (line 6) to include the new field:

```ts
  expect(d.prefs).toEqual({ theme: 'system', locale: 'pt-BR', font: 'system', fontSize: 'M', autoSaveMin: 10, palette: 'ledger', dueSoonDays: 3 })
```

2. Add a new migration test block, after the existing `describe('v4 → v5 migration ...')` block (around line 110):

```ts
describe('v5 → v6 migration (due-soon window)', () => {
  it('defaults dueSoonDays to 3 when missing', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 5
    delete d.prefs.dueSoonDays
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.prefs.dueSoonDays).toBe(3)
  })
  it('leaves an existing dueSoonDays untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 5
    d.prefs.dueSoonDays = 7
    const doc = migrate(d)
    expect(doc.prefs.dueSoonDays).toBe(7)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/document.test.ts`
Expected: FAIL — the shape assertion fails (`dueSoonDays` missing from actual), and the new migration tests fail (`doc.prefs.dueSoonDays` is `undefined`, and `SCHEMA_VERSION` is still `5` so `doc.schemaVersion` won't reach `6`).

- [ ] **Step 3: Implement the schema bump**

In `src/core/types.ts`, add `dueSoonDays` to `Prefs` and `actionTagNames` to `Team`:

```ts
export interface Prefs {
  theme: 'light' | 'dark' | 'system'
  locale: 'pt-BR' | 'en-US'
  font: 'system' | 'serif' | 'mono' | 'classic' | 'rounded'
  fontSize: 'S' | 'M' | 'L'
  autoSaveMin: number
  palette: PaletteId
  dueSoonDays: number
}
```

```ts
export interface Team {
  id: string; name: string; emoji: string
  stakeholders: Person[]; members: Person[]
  actionItems: ActionItem[]; milestones: Milestone[]; risks: Risk[]
  dailyNotes: Record<string, string>
  actionTagNames?: Partial<Record<ActionItem['color'], string>>
}
```

In `src/core/document.ts`:

1. Bump the version constant:

```ts
export const SCHEMA_VERSION = 6
```

2. Add `dueSoonDays: 3` to `createEmptyDocument`'s prefs literal:

```ts
    prefs: { theme: 'system', locale, font: 'system', fontSize: 'M', autoSaveMin: 10, palette: 'ledger', dueSoonDays: 3 },
```

3. Add migration step `5` after the existing `4:` step:

```ts
  5: (d) => {
    const prefs = d.prefs as Record<string, unknown> | undefined
    if (prefs) prefs.dueSoonDays = prefs.dueSoonDays ?? 3
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/document.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones — the untouched-version and reject-newer-schema tests are schema-version-agnostic and keep passing).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both succeed with no errors. (If any other file fails to typecheck because it constructs a `Team` literal and TypeScript complains about `actionTagNames`, that indicates the field was made required by mistake — re-check Step 3 uses `actionTagNames?:`, not `actionTagNames:`.)

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/document.ts test/document.test.ts
git commit -m "feat: bump schema to v6, add prefs.dueSoonDays and Team.actionTagNames

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `src/core/due.ts` — pure due/overdue computation

**Files:**
- Create: `src/core/due.ts`
- Create: `test/due.test.ts`

**Interfaces:**
- Consumes: `Doc` (from Task 1's schema — `doc.prefs.dueSoonDays`, `doc.teams[].actionItems`, `doc.teams[].milestones`), `Loc` (`src/core/types.ts`, unchanged).
- Produces: `collectDueItems(doc: Doc, today: string): DueBuckets`, `interface DueItem { loc: Loc; title: string; teamName: string; date: string; kind: 'action' | 'milestone' }`, `interface DueBuckets { overdue: DueItem[]; dueSoon: DueItem[] }` — consumed by Task 3's sidebar badge/modal.

- [ ] **Step 1: Write the failing tests**

Create `test/due.test.ts`:

```ts
import { collectDueItems } from '../src/core/due'
import { createEmptyDocument } from '../src/core/document'
import type { ActionItem, Doc, Milestone, Team } from '../src/core/types'

function item(overrides: Partial<ActionItem>): ActionItem {
  return { id: 'i1', summary: 'Do thing', status: 'todo', dueDate: null, assignee: '', order: 0, notes: '', color: 'ledger', ...overrides }
}
function milestone(overrides: Partial<Milestone>): Milestone {
  return { id: 'm1', date: '2026-07-01', title: 'M', done: false, followup: '', ...overrides }
}
function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}
function doc(teams: Team[], dueSoonDays = 3): Doc {
  const d = createEmptyDocument('en-US')
  d.prefs.dueSoonDays = dueSoonDays
  d.teams = teams
  return d
}

const TODAY = '2026-07-17'

test('a past-due action item lands in overdue', () => {
  const d = doc([team({ actionItems: [item({ id: 'a', dueDate: '2026-07-16' })] })])
  const { overdue, dueSoon } = collectDueItems(d, TODAY)
  expect(overdue.map((x) => x.loc.ref)).toEqual([{ kind: 'actions', itemId: 'a' }])
  expect(dueSoon).toHaveLength(0)
})

test('an action item due exactly today lands in due-soon, not overdue', () => {
  const d = doc([team({ actionItems: [item({ id: 'a', dueDate: TODAY })] })])
  const { overdue, dueSoon } = collectDueItems(d, TODAY)
  expect(overdue).toHaveLength(0)
  expect(dueSoon.map((x) => x.loc.ref)).toEqual([{ kind: 'actions', itemId: 'a' }])
})

test('the last day of the due-soon window is included; the day after is excluded', () => {
  const d = doc([team({
    actionItems: [
      item({ id: 'in-window', dueDate: '2026-07-20' }),   // today + 3
      item({ id: 'past-window', dueDate: '2026-07-21' }),  // today + 4
    ],
  })], 3)
  const { dueSoon } = collectDueItems(d, TODAY)
  expect(dueSoon.map((x) => x.loc.ref.itemId)).toEqual(['in-window'])
})

test('respects a non-default dueSoonDays', () => {
  const d = doc([team({ actionItems: [item({ id: 'a', dueDate: '2026-07-25' })] })], 10) // today + 8
  const { dueSoon } = collectDueItems(d, TODAY)
  expect(dueSoon.map((x) => x.loc.ref.itemId)).toEqual(['a'])
})

test('done and cancelled action items are excluded even when overdue', () => {
  const d = doc([team({
    actionItems: [
      item({ id: 'done', dueDate: '2000-01-01', status: 'done' }),
      item({ id: 'cancelled', dueDate: '2000-01-01', status: 'cancelled' }),
    ],
  })])
  const { overdue, dueSoon } = collectDueItems(d, TODAY)
  expect(overdue).toHaveLength(0)
  expect(dueSoon).toHaveLength(0)
})

test('action items with no due date are excluded', () => {
  const d = doc([team({ actionItems: [item({ id: 'a', dueDate: null })] })])
  const { overdue, dueSoon } = collectDueItems(d, TODAY)
  expect(overdue).toHaveLength(0)
  expect(dueSoon).toHaveLength(0)
})

test('an overdue, not-done milestone lands in overdue; a done one is excluded', () => {
  const d = doc([team({
    milestones: [
      milestone({ id: 'open', date: '2026-07-01', done: false }),
      milestone({ id: 'closed', date: '2026-07-01', done: true }),
    ],
  })])
  const { overdue } = collectDueItems(d, TODAY)
  expect(overdue.map((x) => x.loc.ref)).toEqual([{ kind: 'milestones', itemId: 'open' }])
})

test('results are sorted ascending by date and carry team name + kind', () => {
  const d = doc([team({
    id: 'T1', name: 'Engineering',
    actionItems: [item({ id: 'later', dueDate: '2000-01-05' }), item({ id: 'earlier', dueDate: '2000-01-01' })],
  })])
  const { overdue } = collectDueItems(d, TODAY)
  expect(overdue.map((x) => x.loc.ref.itemId)).toEqual(['earlier', 'later'])
  expect(overdue[0]!.teamName).toBe('Engineering')
  expect(overdue[0]!.kind).toBe('action')
})

test('collects across multiple teams', () => {
  const d = doc([
    team({ id: 'A', name: 'A', actionItems: [item({ id: 'a', dueDate: '2000-01-01' })] }),
    team({ id: 'B', name: 'B', actionItems: [item({ id: 'b', dueDate: '2000-01-01' })] }),
  ])
  const { overdue } = collectDueItems(d, TODAY)
  expect(overdue.map((x) => x.loc.teamId).sort()).toEqual(['A', 'B'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/due.test.ts`
Expected: FAIL with "Cannot find module '../src/core/due'" (file doesn't exist yet).

- [ ] **Step 3: Implement `src/core/due.ts`**

```ts
// src/core/due.ts — pure computation of overdue/due-soon action items and
// milestones across every team, for the sidebar badge/list (src/ui/sidebar.ts).
// Deliberately independent of src/modules/action-items.ts's own isOverdue
// (same "date < today, not done/cancelled" semantics) — core/ must not
// depend on modules/.
import type { Doc, Loc } from './types'

export interface DueItem {
  loc: Loc
  title: string
  teamName: string
  date: string
  kind: 'action' | 'milestone'
}

export interface DueBuckets {
  overdue: DueItem[]
  dueSoon: DueItem[]
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const dt = new Date(y, m - 1, d + days)
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
}

export function collectDueItems(doc: Doc, today: string): DueBuckets {
  const cutoff = addDaysIso(today, doc.prefs.dueSoonDays)
  const overdue: DueItem[] = []
  const dueSoon: DueItem[] = []

  function classify(entry: DueItem): void {
    if (entry.date < today) overdue.push(entry)
    else if (entry.date <= cutoff) dueSoon.push(entry)
  }

  for (const team of doc.teams) {
    for (const it of team.actionItems) {
      if (it.status === 'done' || it.status === 'cancelled') continue
      if (it.dueDate === null) continue
      classify({
        loc: { teamId: team.id, ref: { kind: 'actions', itemId: it.id } },
        title: it.summary, teamName: team.name, date: it.dueDate, kind: 'action',
      })
    }
    for (const m of team.milestones) {
      if (m.done) continue
      classify({
        loc: { teamId: team.id, ref: { kind: 'milestones', itemId: m.id } },
        title: m.title, teamName: team.name, date: m.date, kind: 'milestone',
      })
    }
  }

  overdue.sort((a, b) => a.date.localeCompare(b.date))
  dueSoon.sort((a, b) => a.date.localeCompare(b.date))
  return { overdue, dueSoon }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/due.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/core/due.ts test/due.test.ts
git commit -m "feat: add core/due.ts — overdue/due-soon computation across teams

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Sidebar due badge + due-items list

**Files:**
- Modify: `src/ui/sidebar.ts`
- Modify: `src/main.ts`
- Modify: `src/core/i18n.ts`
- Modify: `styles.css`
- Modify: `test/sidebar.test.ts`

**Interfaces:**
- Consumes: `collectDueItems`, `DueBuckets`, `DueItem` (Task 2, `src/core/due.ts`); `PaneManager.openInFocused(loc: Loc): void` (`src/ui/panes.ts`, unchanged); `formatDate(iso, locale)` (`src/core/i18n.ts`, unchanged).
- Produces: `mountSidebar(shell: Shell, store: Store, pm: PaneManager, actions: SidebarActions): void` — **signature change** (new `pm` parameter, third positional), consumed by `src/main.ts` and `test/sidebar.test.ts`.

- [ ] **Step 1: Add i18n keys**

In `src/core/i18n.ts`, add to the `pt` object (anywhere near the other `kanban_*`/`team_*` keys, e.g. right after `team_alt_hint`):

```ts
  due_badge_title: 'Itens vencidos ou próximos do prazo',
  due_panel_title: 'Prazos',
  due_section_overdue: 'Vencidos',
  due_section_due_soon: 'Próximos',
  due_empty: 'Nada vencido ou próximo do prazo.',
  due_overdue_by: 'venceu há {days}d',
  due_in_days: 'em {days}d',
```

And the matching keys to the `en` object, same position:

```ts
  due_badge_title: 'Overdue or due-soon items',
  due_panel_title: 'Due',
  due_section_overdue: 'Overdue',
  due_section_due_soon: 'Due soon',
  due_empty: 'Nothing overdue or due soon.',
  due_overdue_by: 'overdue by {days}d',
  due_in_days: 'in {days}d',
```

- [ ] **Step 2: Write the failing tests**

Edit `test/sidebar.test.ts`. First, update the `setup()` helper's `mountSidebar` call to pass a fake `PaneManager` (mirrors the `fakePM()` helper already used in `test/action-items.test.ts`):

```ts
import { mountSidebar, notifyNavChanged, onNavChanged, ADD_TEAM_REQUEST_EVENT } from '../src/ui/sidebar'
import { createShell, type Shell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { todayIso } from '../src/core/i18n'
import type { Loc } from '../src/core/types'
import type { PaneManager } from '../src/ui/panes'

function fakePM(): PaneManager & { openInFocused: ReturnType<typeof vi.fn> } {
  return {
    openInPane: () => {},
    openInFocused: vi.fn(),
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
  }
}
```

Update `setup()` to build and pass `pm`, and return it:

```ts
function setup(): { shell: Shell; store: Store; pm: ReturnType<typeof fakePM>; selectTeam: ReturnType<typeof vi.fn>; renderPanes: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = ''
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  const store = createStore(doc)
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const pm = fakePM()
  const selectTeam = vi.fn((id: string) => {
    store.updateNav((d) => { d.nav.activeTeamId = id })
  })
  const renderPanes = vi.fn()
  mountSidebar(shell, store, pm, { selectTeam, renderPanes })
  return { shell, store, pm, selectTeam, renderPanes }
}
```

Then append these new tests at the end of the file, before the final `afterEach`/closing (or simply at the end of the file — vitest doesn't care about ordering relative to `afterEach`, which applies globally):

```ts
function addActionItem(store: Store, teamId: string, overrides: Partial<{ id: string; dueDate: string | null; status: 'todo' | 'wip' | 'done' | 'cancelled' }>): void {
  store.update((d) => {
    const team = d.teams.find((tm) => tm.id === teamId)!
    team.actionItems.push({
      id: overrides.id ?? 'a1', summary: 'Task', status: overrides.status ?? 'todo',
      dueDate: overrides.dueDate ?? null, assignee: '', order: team.actionItems.length, notes: '', color: 'ledger',
    })
  })
}

describe('due badge', () => {
  test('hidden when there are no due items', () => {
    const { store } = setup()
    addTeam(store, 'Alpha')
    expect(document.querySelector('.tt-due-btn.tt-due-empty')).not.toBeNull()
  })

  test('shows the total overdue+due-soon count and the overdue color when any item is overdue', () => {
    const { store } = setup()
    addTeam(store, 'Alpha')
    addActionItem(store, 'Alpha', { id: 'a1', dueDate: '2000-01-01' })
    const btn = document.querySelector('.tt-due-btn')!
    expect(btn.classList.contains('tt-due-empty')).toBe(false)
    expect(btn.classList.contains('has-overdue')).toBe(true)
    expect(btn.querySelector('.tt-due-badge')!.textContent).toBe('1')
  })

  test('per-team badge appears next to a team row only when that team has due items', () => {
    const { store } = setup()
    addTeam(store, 'Alpha')
    addTeam(store, 'Beta')
    addActionItem(store, 'Alpha', { id: 'a1', dueDate: '2000-01-01' })
    const rows = items()
    expect(rows[0]!.querySelector('.tt-team-due-badge')?.textContent).toBe('1')
    expect(rows[1]!.querySelector('.tt-team-due-badge')).toBeNull()
  })
})

describe('due list modal', () => {
  test('clicking the due button with no due items shows the empty state', () => {
    const { store } = setup()
    addTeam(store, 'Alpha')
    ;(document.querySelector('.tt-due-btn') as HTMLElement).click()
    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Nothing overdue or due soon.')
  })

  test('lists overdue and due-soon items in separate sections, and clicking a row navigates to it', () => {
    const { store, pm, selectTeam } = setup()
    addTeam(store, 'Alpha')
    addActionItem(store, 'Alpha', { id: 'overdue-1', dueDate: '2000-01-01' })
    addActionItem(store, 'Alpha', { id: 'soon-1', dueDate: todayIso() })

    ;(document.querySelector('.tt-due-btn') as HTMLElement).click()
    const headings = Array.from(document.querySelectorAll('.tt-due-section-heading')).map((n) => n.textContent)
    expect(headings).toEqual(['Overdue', 'Due soon'])

    const row = document.querySelector('.tt-due-row') as HTMLElement
    row.click()
    expect(pm.openInFocused).toHaveBeenCalledWith({ teamId: 'Alpha', ref: { kind: 'actions', itemId: 'overdue-1' } })
    expect(document.querySelector('.tt-modal-overlay')).toBeNull() // closed after navigating
  })

  test('clicking a row for a non-active team switches team first', () => {
    const { store, selectTeam } = setup()
    addTeam(store, 'Alpha')
    addTeam(store, 'Beta')
    addActionItem(store, 'Beta', { id: 'b1', dueDate: '2000-01-01' })
    store.updateNav((d) => { d.nav.activeTeamId = 'Alpha' })

    ;(document.querySelector('.tt-due-btn') as HTMLElement).click()
    const row = document.querySelector('.tt-due-row') as HTMLElement
    row.click()
    expect(selectTeam).toHaveBeenCalledWith('Beta')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/sidebar.test.ts`
Expected: FAIL — `mountSidebar` still takes 3 args (the new `pm` positional breaks the call, and existing tests that don't pass `pm` will error), and `.tt-due-btn`/`.tt-due-row` etc. don't exist. TypeScript compilation of the test file will also fail before tests even run, which is expected at this point.

- [ ] **Step 4: Implement the sidebar changes**

In `src/ui/sidebar.ts`, update imports:

```ts
// src/ui/sidebar.ts
import type { Store } from '../core/store'
import type { Shell } from './shell'
import type { PaneManager } from './panes'
import type { Loc, Team } from '../core/types'
import { lastLocForTeam } from '../core/nav'
import { t, todayIso, formatDate, type Locale } from '../core/i18n'
import { collectDueItems, type DueBuckets, type DueItem } from '../core/due'
import { el } from './dom'
import { showModal, type ModalButton, type ModalHandle } from './modal'
import { attachEmojiPicker } from './emoji-picker'
```

Change the `mountSidebar` signature to accept `pm` as the third parameter:

```ts
export function mountSidebar(shell: Shell, store: Store, pm: PaneManager, actions: SidebarActions): void {
```

Inside `mountSidebar`, after the existing `const listEl = el('div', { class: 'tt-team-list' })` and `addBtn` declarations, add the due badge button and helper functions (place this block right before `shell.sidebar.innerHTML = ''`):

```ts
  const dueBadgeEl = el('span', { class: 'tt-due-badge' })
  const dueBtn = el(
    'button',
    { class: 'tt-btn tt-due-btn', type: 'button', title: t(locale(), 'due_badge_title'), onclick: () => openDueModal() },
    '⏰', dueBadgeEl
  )

  function diffDays(later: string, earlier: string): number {
    const [ly, lm, ld] = later.split('-').map(Number) as [number, number, number]
    const [ey, em, ed] = earlier.split('-').map(Number) as [number, number, number]
    const a = Date.UTC(ly, lm - 1, ld)
    const b = Date.UTC(ey, em - 1, ed)
    return Math.round((a - b) / 86400000)
  }

  function relLabel(dateIso: string): string {
    const today = todayIso()
    if (dateIso < today) return t(locale(), 'due_overdue_by', { days: String(diffDays(today, dateIso)) })
    return t(locale(), 'due_in_days', { days: String(diffDays(dateIso, today)) })
  }

  function renderDueRow(item: DueItem, handleRef: { current: ModalHandle | null }): HTMLElement {
    const icon = item.kind === 'action' ? '✅' : '🚩'
    return el(
      'div',
      {
        class: 'tt-due-row',
        onclick: () => {
          handleRef.current?.close()
          if (item.loc.teamId !== store.doc.nav.activeTeamId) actions.selectTeam(item.loc.teamId)
          pm.openInFocused(item.loc)
        },
      },
      el('span', { class: 'tt-due-row-icon' }, icon),
      el('span', { class: 'tt-due-row-title' }, item.title),
      el('span', { class: 'tt-due-row-team' }, item.teamName),
      el('span', { class: 'tt-due-row-date' }, `${formatDate(item.date, locale())} · ${relLabel(item.date)}`)
    )
  }

  function openDueModal(): void {
    const buckets = collectDueItems(store.doc, todayIso())
    const handleRef: { current: ModalHandle | null } = { current: null }
    const sections: HTMLElement[] = []
    if (buckets.overdue.length + buckets.dueSoon.length === 0) {
      sections.push(el('p', { class: 'tt-modal-message' }, t(locale(), 'due_empty')))
    } else {
      if (buckets.overdue.length > 0) {
        sections.push(el('div', { class: 'tt-due-section-heading' }, t(locale(), 'due_section_overdue')))
        sections.push(...buckets.overdue.map((it) => renderDueRow(it, handleRef)))
      }
      if (buckets.dueSoon.length > 0) {
        sections.push(el('div', { class: 'tt-due-section-heading' }, t(locale(), 'due_section_due_soon')))
        sections.push(...buckets.dueSoon.map((it) => renderDueRow(it, handleRef)))
      }
    }
    const body = el('div', { class: 'tt-due-list' }, ...sections)
    const closeBtn: ModalButton = { label: t(locale(), 'ok'), primary: true, onClick: () => handleRef.current?.close() }
    handleRef.current = showModal({ title: t(locale(), 'due_panel_title'), body, buttons: [closeBtn] })
  }

  function renderDueBadge(buckets: DueBuckets): void {
    const total = buckets.overdue.length + buckets.dueSoon.length
    dueBadgeEl.textContent = total > 0 ? String(total) : ''
    dueBtn.classList.toggle('tt-due-empty', total === 0)
    dueBtn.classList.toggle('has-overdue', buckets.overdue.length > 0)
    dueBtn.classList.toggle('has-due-soon', buckets.overdue.length === 0 && buckets.dueSoon.length > 0)
  }
```

Update `shell.sidebar.append(listEl, addBtn)` to include the new button:

```ts
  shell.sidebar.innerHTML = ''
  shell.sidebar.append(dueBtn, listEl, addBtn)
```

Note: `renderDueRow` takes a `handleRef` object (rather than closing over a `let handle`) so that TypeScript's control-flow analysis doesn't complain about a `const` referenced before assignment across the `.map()` call — this is the same "read a mutable box captured by reference" trick, just made explicit instead of relying on the closure-executes-later timing the rest of the codebase's modals use for their single always-post-declared `handle` reference.

In the `render()` function, compute due buckets and per-team counts once per render, and use them both for the badge and the per-team row badges:

```ts
  function render(): void {
    listEl.innerHTML = ''
    const buckets = collectDueItems(store.doc, todayIso())
    renderDueBadge(buckets)
    const teamDueCounts = new Map<string, number>()
    for (const it of [...buckets.overdue, ...buckets.dueSoon]) {
      teamDueCounts.set(it.loc.teamId, (teamDueCounts.get(it.loc.teamId) ?? 0) + 1)
    }
    store.doc.teams.forEach((team, index) => {
      const isActive = store.doc.nav.activeTeamId === team.id
      const item = el('div', {
        class: 'tt-team-item' + (isActive ? ' active' : ''),
        draggable: 'true',
        'data-index': String(index),
        ...(index < 9 ? { title: t(locale(), 'team_alt_hint') } : {}),
      })
      const numEl = el('span', { class: 'tt-team-num' }, String(index + 1))
      const emojiEl = el('span', { class: 'tt-team-emoji' }, team.emoji)
      const nameEl = el('span', { class: 'tt-team-name' }, team.name)
      const hotkeyEl = index < 9 ? el('span', { class: 'tt-team-hotkey' }, `Alt+${index + 1}`) : null
      const dueCount = teamDueCounts.get(team.id) ?? 0
      const teamDueBadgeEl = dueCount > 0 ? el('span', { class: 'tt-team-due-badge' }, String(dueCount)) : null
      const editBtn = el(
        'button',
        {
          class: 'tt-btn tt-team-edit-btn',
          type: 'button',
          title: t(locale(), 'team_edit_title'),
          onclick: (e: Event) => {
            e.stopPropagation()
            openEditModal(team)
          },
        },
        '✎'
      )
      item.append(numEl, emojiEl, nameEl, ...(hotkeyEl ? [hotkeyEl] : []), ...(teamDueBadgeEl ? [teamDueBadgeEl] : []), editBtn)
```

(The rest of the `render()` function — drag/drop wiring, `listEl.appendChild(item)` — is unchanged; only the `item.append(...)` line and the new `dueCount`/`teamDueBadgeEl` locals above it change.)

- [ ] **Step 5: Update the call site in `src/main.ts`**

Change line 486 from:

```ts
  mountSidebar(shell, store, { selectTeam, renderPanes: () => pm.renderAll() })
```

to:

```ts
  mountSidebar(shell, store, pm, { selectTeam, renderPanes: () => pm.renderAll() })
```

(`pm` is already in scope at this point in `main.ts` — it's constructed and has every module registered before `selectTeam`/`mountSidebar` are defined, per the existing `pm.registerModule(...)` calls earlier in the file.)

- [ ] **Step 6: Add CSS**

Append to `styles.css` (near the existing `.tt-team-item`/`.tt-team-hotkey` rules around line 248):

```css
.tt-due-btn { position: relative; margin: 0 .6rem .5rem; width: calc(100% - 1.2rem); display: flex; align-items: center; justify-content: center; gap: .4rem; }
.tt-due-btn.tt-due-empty { display: none; }
.tt-due-badge { font-family: var(--font-data); font-size: .7rem; font-weight: 700; border-radius: 999px; padding: .05rem .45rem; background: var(--muted); color: var(--bg); }
.tt-due-btn.has-overdue .tt-due-badge { background: var(--danger); color: #fff; }
.tt-due-btn.has-due-soon .tt-due-badge { background: var(--brass); color: #fff; }
.tt-team-due-badge { font-family: var(--font-data); font-size: .65rem; font-weight: 700; border-radius: 999px; padding: 0 .4rem; background: var(--danger); color: #fff; flex: none; }

.tt-due-list { display: flex; flex-direction: column; gap: .15rem; max-height: 60vh; overflow-y: auto; }
.tt-due-section-heading { font-weight: 700; margin-top: .6rem; color: var(--muted); font-size: .8rem; text-transform: uppercase; }
.tt-due-section-heading:first-child { margin-top: 0; }
.tt-due-row { display: flex; align-items: center; gap: .5rem; padding: .35rem .4rem; border-radius: 6px; cursor: pointer; }
.tt-due-row:hover { background: rgba(var(--accent-rgb), .1); }
.tt-due-row-title { flex: 1; }
.tt-due-row-team { color: var(--muted); font-size: .85rem; }
.tt-due-row-date { font-family: var(--font-data); font-size: .8rem; color: var(--muted); flex: none; }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/sidebar.test.ts`
Expected: PASS, all tests including the new `describe('due badge', ...)` and `describe('due list modal', ...)` blocks.

Then run the full suite once, since `mountSidebar`'s signature change could affect other test files that call it:

Run: `npx vitest run`
Expected: PASS. (Only `test/sidebar.test.ts` calls `mountSidebar` directly — confirmed via `grep -r mountSidebar test/` finding just that one file — so no other test file needs updating.)

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both succeed.

- [ ] **Step 9: Commit**

```bash
git add src/ui/sidebar.ts src/main.ts src/core/i18n.ts styles.css test/sidebar.test.ts
git commit -m "feat: add sidebar due badge and due-items list modal

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Prefs — `dueSoonDays` field in General tab

**Files:**
- Modify: `src/ui/prefs.ts`
- Modify: `src/core/i18n.ts`
- Modify: `test/prefs.test.ts`

**Interfaces:**
- Consumes: `Prefs.dueSoonDays` (Task 1).
- Produces: nothing new consumed elsewhere — this is a leaf UI field.

- [ ] **Step 1: Add i18n keys**

In `src/core/i18n.ts`, add to `pt`, near `prefs_autosave_label`:

```ts
  prefs_due_soon_days_label: 'Avisar sobre prazos nos próximos (dias)',
```

And to `en`, same position:

```ts
  prefs_due_soon_days_label: 'Warn about due dates within (days)',
```

- [ ] **Step 2: Write the failing test**

Add to `test/prefs.test.ts`, right after the existing `'auto-save number input clamps to 1..60 ...'` test:

```ts
test('due-soon-days number input clamps to 1..30 and updates store.prefs', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)

  const input = document.querySelector('.tt-prefs-due-soon-input') as HTMLInputElement
  input.value = '5'
  input.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.dueSoonDays).toBe(5)

  input.value = '999'
  input.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.dueSoonDays).toBe(30)
  expect(input.value).toBe('30')

  input.value = '0'
  input.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.dueSoonDays).toBe(1)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/prefs.test.ts -t "due-soon-days"`
Expected: FAIL — `.tt-prefs-due-soon-input` doesn't exist yet.

- [ ] **Step 4: Implement the Prefs field**

In `src/ui/prefs.ts`, right after the existing `autoSaveField` construction (the block ending at the `prefs_autosave_label` line, around line 208-212), add:

```ts
    const dueSoonInput = el('input', {
      type: 'number',
      class: 'tt-input tt-prefs-due-soon-input',
      min: '1',
      max: '30',
      value: String(prefs.dueSoonDays),
      onchange: (e: Event) => {
        const raw = Number((e.target as HTMLInputElement).value)
        const clamped = Math.min(30, Math.max(1, Number.isFinite(raw) ? Math.round(raw) : prefs.dueSoonDays))
        ;(e.target as HTMLInputElement).value = String(clamped)
        store.update((d) => {
          d.prefs.dueSoonDays = clamped
        })
      },
    })
    const dueSoonField = el(
      'div',
      { class: 'tt-prefs-field' },
      el('label', { class: 'tt-prefs-field-label' }, t(locale, 'prefs_due_soon_days_label'), dueSoonInput)
    )
```

And add `dueSoonField` to the existing `container.append(...)` call:

```ts
    container.append(themeField, paletteField, localeField, fontField, sizeField, autoSaveField, dueSoonField)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/prefs.test.ts`
Expected: PASS, full file (the new test plus all pre-existing ones — check none of the other tests assert an exact child count on the General tab container that this new field would break; if one does, update its expected count by one).

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add src/ui/prefs.ts src/core/i18n.ts test/prefs.test.ts
git commit -m "feat: add dueSoonDays field to Prefs General tab

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Named tags — edit-tags modal

**Files:**
- Modify: `src/modules/action-items.ts`
- Modify: `src/core/i18n.ts`
- Modify: `styles.css`
- Modify: `test/action-items.test.ts`

**Interfaces:**
- Consumes: `Team.actionTagNames` (Task 1), `COLORS`, `COLOR_KEYS` (already defined in `src/modules/action-items.ts`).
- Produces: writes `Team.actionTagNames` via `ctx.store.update` — consumed by Task 6's card label and filter chips.

- [ ] **Step 1: Add i18n keys**

In `src/core/i18n.ts`, add to `pt`, near the other `kanban_*` keys:

```ts
  kanban_edit_tags_btn: 'Editar tags',
  kanban_edit_tags_title: 'Editar nomes das tags',
```

And to `en`:

```ts
  kanban_edit_tags_btn: 'Edit tags',
  kanban_edit_tags_title: 'Edit tag names',
```

- [ ] **Step 2: Write the failing tests**

Add to `test/action-items.test.ts`, as a new `describe` block after `describe('renderActionItems — zone clear-all', ...)`:

```ts
describe('renderActionItems — edit tags modal', () => {
  // Finds the text input in the edit-tags row whose swatch carries `color-${color}`
  // — avoids the `:has()` CSS selector, whose jsdom/nwsapi support is version-
  // dependent, in favor of a plain DOM walk.
  function tagRowInput(color: string): HTMLInputElement {
    const row = Array.from(document.querySelectorAll('.tt-edit-tags-row')).find((r) => r.querySelector(`.color-${color}`))
    if (!row) throw new Error(`no edit-tags row for color "${color}"`)
    return row.querySelector('input') as HTMLInputElement
  }

  test('"Edit tags" opens a modal with one row per color, pre-filled from actionTagNames', () => {
    const team = makeTeam({ actionTagNames: { rust: 'Blocked' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Edit tags')
    expect(document.querySelectorAll('.tt-edit-tags-row')).toHaveLength(6)
    expect(tagRowInput('rust').value).toBe('Blocked')
    expect(tagRowInput('slate').value).toBe('')
  })

  test('saving writes trimmed, non-empty names into actionTagNames', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Edit tags')
    tagRowInput('rust').value = '  Blocked  '
    clickByTitleOrText(document.body, 'Save')

    expect(store.doc.teams[0]!.actionTagNames).toEqual({ rust: 'Blocked' })
  })

  test('clearing a name back to empty removes that key instead of storing an empty string', () => {
    const team = makeTeam({ actionTagNames: { rust: 'Blocked', plum: 'Urgent' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Edit tags')
    tagRowInput('rust').value = ''
    clickByTitleOrText(document.body, 'Save')

    expect(store.doc.teams[0]!.actionTagNames).toEqual({ plum: 'Urgent' })
  })

  test('canceling leaves actionTagNames untouched', () => {
    const team = makeTeam({ actionTagNames: { rust: 'Blocked' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Edit tags')
    tagRowInput('rust').value = 'Something else'
    clickByTitleOrText(document.body, 'Cancel')

    expect(store.doc.teams[0]!.actionTagNames).toEqual({ rust: 'Blocked' })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/action-items.test.ts -t "edit tags modal"`
Expected: FAIL — `clickByTitleOrText(container, 'Edit tags')` throws `button "Edit tags" not found` (the button doesn't exist yet).

- [ ] **Step 4: Implement the edit-tags modal**

In `src/modules/action-items.ts`, add a new function `openEditTagsModal` inside `renderActionItems` (place it right after `openEditModal`'s closing brace, before `emptyEl`):

```ts
  function openEditTagsModal(): void {
    const tm = findTeam()
    if (!tm) return
    const inputs = new Map<ActionItem['color'], HTMLInputElement>()
    const rows = COLORS.map((c) => {
      const input = el('input', { type: 'text', class: 'tt-input', value: tm.actionTagNames?.[c] ?? '' }) as HTMLInputElement
      inputs.set(c, input)
      const swatch = el('span', { class: `tt-kanban-tag-chip-swatch color-${c}` })
      return el('div', { class: 'tt-edit-tags-row' }, swatch, el('span', { class: 'tt-edit-tags-row-label' }, t(lc, COLOR_KEYS[c])), input)
    })
    const body = el('div', { class: 'tt-edit-tags-form' }, ...rows)
    const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
    const saveBtn: ModalButton = {
      label: t(lc, 'kanban_save_btn'),
      primary: true,
      onClick: () => {
        ctx.store.update((d) => {
          const target = d.teams.find((t2) => t2.id === teamId)
          if (!target) return
          const nextTags: Partial<Record<ActionItem['color'], string>> = { ...target.actionTagNames }
          for (const c of COLORS) {
            const value = inputs.get(c)!.value.trim()
            if (value === '') delete nextTags[c]
            else nextTags[c] = value
          }
          target.actionTagNames = nextTags
        })
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({ title: t(lc, 'kanban_edit_tags_title'), body, buttons: [cancelBtn, saveBtn] })
  }
```

Then add the toolbar button and row, and wire it into the container. Replace the existing final append line:

```ts
  container.appendChild(el('div', { class: 'tt-kanban' }, boardEl, trashEl, datalistEl))
```

with:

```ts
  const editTagsBtn = el(
    'button',
    { class: 'tt-btn tt-kanban-edit-tags-btn', type: 'button', onclick: () => openEditTagsModal() },
    t(lc, 'kanban_edit_tags_btn')
  )
  const toolbarEl = el('div', { class: 'tt-kanban-toolbar' }, editTagsBtn)

  container.appendChild(el('div', { class: 'tt-kanban' }, toolbarEl, boardEl, trashEl, datalistEl))
```

(Task 6 will add a tag-chip filter row into `toolbarEl` alongside `editTagsBtn` — this task only adds the button.)

- [ ] **Step 5: Add CSS**

Append to `styles.css`, near the existing `.tt-kanban-color-chip` rules (around line 577):

```css
.tt-kanban-toolbar { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin-bottom: .5rem; }
.tt-kanban-edit-tags-btn { margin-left: auto; }
.tt-kanban-tag-chip-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex: none; }
.tt-kanban-tag-chip-swatch.color-slate { background: var(--card-slate); }
.tt-kanban-tag-chip-swatch.color-brass { background: var(--card-brass); }
.tt-kanban-tag-chip-swatch.color-sage { background: var(--card-sage); }
.tt-kanban-tag-chip-swatch.color-rust { background: var(--card-rust); }
.tt-kanban-tag-chip-swatch.color-plum { background: var(--card-plum); }
.tt-kanban-tag-chip-swatch.color-ledger { background: var(--card-ledger); }
.tt-edit-tags-row { display: flex; align-items: center; gap: .6rem; margin-bottom: .5rem; }
.tt-edit-tags-row-label { width: 80px; flex: none; color: var(--muted); }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts`
Expected: PASS, all tests including the new `describe('renderActionItems — edit tags modal', ...)` block.

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both succeed.

- [ ] **Step 8: Commit**

```bash
git add src/modules/action-items.ts src/core/i18n.ts styles.css test/action-items.test.ts
git commit -m "feat: add per-team edit-tags modal for action-item colors

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Tag display on cards + Kanban filter

**Files:**
- Modify: `src/modules/action-items.ts`
- Modify: `styles.css`
- Modify: `test/action-items.test.ts`

**Interfaces:**
- Consumes: `Team.actionTagNames` (Task 1), `toolbarEl`/`editTagsBtn`/`COLORS`/`COLOR_KEYS` (Task 5, same file).
- Produces: nothing consumed by later tasks — this is the last piece of Feature B.

- [ ] **Step 1: Write the failing tests**

Add to `test/action-items.test.ts`, as a new `describe` block after `describe('renderActionItems — edit tags modal', ...)`:

```ts
describe('renderActionItems — tag display and filter', () => {
  test('a card shows its custom tag name when set, or the color name as fallback', () => {
    const team = makeTeam({
      actionTagNames: { rust: 'Blocked' },
      actionItems: [item({ id: 'a', color: 'rust' }), item({ id: 'b', color: 'slate' })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const tags = Array.from(container.querySelectorAll('.tt-kanban-card-tag')).map((n) => n.textContent)
    expect(tags).toEqual(expect.arrayContaining(['Blocked', 'Slate']))
  })

  test('renders one filter chip per color, labeled with the custom name or fallback', () => {
    const team = makeTeam({ actionTagNames: { rust: 'Blocked' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const chips = Array.from(container.querySelectorAll('.tt-kanban-tag-chip')).map((n) => n.textContent?.trim())
    expect(chips).toEqual(expect.arrayContaining(['Blocked', 'Slate', 'Brass', 'Sage', 'Plum', 'Ledger']))
  })

  test('clicking a chip filters cards to that color across all columns; clicking again clears it', () => {
    const team = makeTeam({
      actionItems: [
        item({ id: 'rust-1', color: 'rust', status: 'todo' }),
        item({ id: 'slate-1', color: 'slate', status: 'todo' }),
        item({ id: 'rust-2', color: 'rust', status: 'done' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    // renderTagChips() rebuilds .tt-kanban-tag-chip nodes from scratch on
    // every renderAll() (i.e. after every click), so a chip reference held
    // across a click goes stale (detached node, frozen class list from
    // before the click) — re-query by text instead of reusing one handle.
    function findRustChip(): HTMLButtonElement {
      return Array.from(container.querySelectorAll('.tt-kanban-tag-chip')).find((c) => c.textContent?.includes('Rust'))! as HTMLButtonElement
    }

    findRustChip().click()

    expect(cards(container).map((c) => c.getAttribute('data-item-id')).sort()).toEqual(['rust-1', 'rust-2'])
    expect(findRustChip().classList.contains('selected')).toBe(true)

    findRustChip().click()
    expect(cards(container)).toHaveLength(3)
    expect(findRustChip().classList.contains('selected')).toBe(false)
  })

  test('the Done/Cancelled zone-label counts stay unfiltered while a tag filter is active', () => {
    const team = makeTeam({
      actionItems: [
        item({ id: 'd1', color: 'rust', status: 'done' }),
        item({ id: 'd2', color: 'slate', status: 'done' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const rustChip = Array.from(container.querySelectorAll('.tt-kanban-tag-chip')).find((c) => c.textContent?.includes('Rust'))!
    ;(rustChip as HTMLButtonElement).click()

    expect(container.querySelector('.tt-kanban-zone-label')!.textContent).toContain('Done (2)')
    expect(cards(container)).toHaveLength(1) // only the rust card is drawn
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/action-items.test.ts -t "tag display and filter"`
Expected: FAIL — `.tt-kanban-card-tag` and `.tt-kanban-tag-chip` don't exist yet.

- [ ] **Step 3: Implement tag display and filter**

In `src/modules/action-items.ts`, add `activeTagFilter`, `tagLabel`, `tagChipsEl`, and `renderTagChips` near the top of `renderActionItems`, right after the existing `let draggedId: string | null = null`.

**Ordering matters here**: `renderAll()` (defined further down) is *called* mid-function, at the existing `renderAll()` line that currently sits right before `const unsubscribe = ctx.store.subscribe(...)`. Because Task 5 added `editTagsBtn`/`toolbarEl` *after* that call (right before the final `container.appendChild(...)` line), anything `renderAll()` touches must be declared *before* that call, not alongside `editTagsBtn`/`toolbarEl` — otherwise `renderTagChips()` would reference a `const tagChipsEl` still in its temporal dead zone on the very first render and throw. So `tagChipsEl` and `renderTagChips` go at the top, with `activeTagFilter`/`tagLabel`, not at the bottom:

```ts
  let activeTagFilter: ActionItem['color'] | null = null

  function tagLabel(color: ActionItem['color']): string {
    return findTeam()?.actionTagNames?.[color] ?? t(lc, COLOR_KEYS[color])
  }

  const tagChipsEl = el('div', { class: 'tt-kanban-tag-chips' })
  function renderTagChips(): void {
    tagChipsEl.innerHTML = ''
    for (const c of COLORS) {
      const chip = el(
        'button',
        {
          type: 'button',
          class: 'tt-kanban-tag-chip' + (activeTagFilter === c ? ' selected' : ''),
          onclick: () => {
            activeTagFilter = activeTagFilter === c ? null : c
            renderAll()
          },
        },
        el('span', { class: `tt-kanban-tag-chip-swatch color-${c}` }),
        ` ${tagLabel(c)}`
      )
      tagChipsEl.appendChild(chip)
    }
  }
```

In `renderCard`, add the tag label to `metaChildren` (unconditionally, right before the existing `const metaEl = ...` line):

```ts
    metaChildren.push(el('span', { class: 'tt-kanban-card-tag' }, tagLabel(item.color)))
    const metaEl = el('div', { class: 'tt-kanban-card-meta' }, ...metaChildren)
```

Update `toolbarEl` (added in Task 5, down near the bottom, before the final `container.appendChild(...)` line) to include the chips row — since `toolbarEl`'s own declaration runs *after* the top-of-function `tagChipsEl` declaration above, referencing `tagChipsEl` here is safe:

```ts
  const toolbarEl = el('div', { class: 'tt-kanban-toolbar' }, tagChipsEl, editTagsBtn)
```

Finally, update `renderAll` to call `renderTagChips()` and filter the drawn cards while keeping the zone-label counts unfiltered:

```ts
  function renderAll(): void {
    updateDatalist()
    renderTagChips()
    const filterFn = (i: ActionItem) => activeTagFilter === null || i.color === activeTagFilter
    const allDone = itemsByStatus(items(), 'done')
    const allCancelled = itemsByStatus(items(), 'cancelled')
    const todo = itemsByStatus(items(), 'todo').filter(filterFn)
    const wip = itemsByStatus(items(), 'wip').filter(filterFn)
    const done = allDone.filter(filterFn)
    const cancelled = allCancelled.filter(filterFn)

    todoBodyEl.innerHTML = ''
    if (todo.length === 0) todoBodyEl.appendChild(emptyEl())
    else todo.forEach((it) => todoBodyEl.appendChild(renderCard(it)))

    wipBodyEl.innerHTML = ''
    if (wip.length === 0) wipBodyEl.appendChild(emptyEl())
    else wip.forEach((it) => wipBodyEl.appendChild(renderCard(it)))

    doneBodyEl.innerHTML = ''
    if (done.length === 0) doneBodyEl.appendChild(emptyEl())
    else done.forEach((it) => doneBodyEl.appendChild(renderCard(it)))

    cancelledBodyEl.innerHTML = ''
    if (cancelled.length === 0) cancelledBodyEl.appendChild(emptyEl())
    else cancelled.forEach((it) => cancelledBodyEl.appendChild(renderCard(it)))

    doneCountEl.textContent = t(lc, 'kanban_done_heading', { count: String(allDone.length) })
    cancelledCountEl.textContent = t(lc, 'kanban_cancelled_heading', { count: String(allCancelled.length) })
  }
```

- [ ] **Step 4: Add CSS**

Append to `styles.css`, near the CSS added in Task 5:

```css
.tt-kanban-tag-chips { display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; }
.tt-kanban-tag-chip { display: inline-flex; align-items: center; gap: .3rem; border: 1px solid var(--border); border-radius: 999px; padding: .1rem .55rem; background: var(--panel); cursor: pointer; font-size: .8rem; color: var(--fg); }
.tt-kanban-tag-chip.selected { border-color: var(--fg); font-weight: 700; }
.tt-kanban-card-tag { font-size: .7rem; color: var(--muted); }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts`
Expected: PASS, the entire file (86 previously-passing tests plus the new tag-display/filter and edit-tags-modal tests). Check the pre-existing `'shows an empty placeholder per column with no cards'` and `'done/cancelled zone headers show a count'` tests still pass unmodified — they should, since `activeTagFilter` defaults to `null` (no filtering) on every fresh render.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add src/modules/action-items.ts styles.css test/action-items.test.ts
git commit -m "feat: show tag labels on Kanban cards and add tag filter chips

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Carry `actionTagNames` through team export/import

**Files:**
- Modify: `src/core/team-export.ts`
- Modify: `test/team-export.test.ts`

**Interfaces:**
- Consumes: `Team.actionTagNames` (Task 1).
- Produces: `ExportedTeam.actionTagNames` — no further consumers (this is the last task).

- [ ] **Step 1: Write the failing test**

`test/team-export.test.ts` builds its fixture via a no-arg `sampleTeam(): Team` helper (already defined at the top of the file, returning a team with `id: 't1'`, one action item colored `'slate'`, etc. — it does not take overrides). Add a new `describe` block at the end of the file, after the existing `describe('buildExport', ...)`/`describe('parseImportFile', ...)`/`describe('remapForImport', ...)` blocks:

```ts
describe('actionTagNames pass-through', () => {
  it('buildExport carries actionTagNames through unchanged', () => {
    const team = { ...sampleTeam(), actionTagNames: { rust: 'Blocked' } }
    const file = buildExport([team])
    expect(file.teams[0]!.actionTagNames).toEqual({ rust: 'Blocked' })
  })

  it('remapForImport carries actionTagNames through without remapping (keyed by color, not id)', () => {
    const team = { ...sampleTeam(), actionTagNames: { plum: 'Urgent' } }
    const file = buildExport([team])
    const [imported] = remapForImport(file.teams)
    expect(imported!.actionTagNames).toEqual({ plum: 'Urgent' })
  })

  it('a team with no actionTagNames exports and imports with an empty object', () => {
    const file = buildExport([sampleTeam()])
    expect(file.teams[0]!.actionTagNames).toEqual({})
    const [imported] = remapForImport(file.teams)
    expect(imported!.actionTagNames).toEqual({})
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/team-export.test.ts -t "actionTagNames"`
Expected: FAIL — `file.teams[0]!.actionTagNames` is `undefined` (not carried through yet), so `toEqual({ rust: 'Blocked' })` and `toEqual({})` both fail.

- [ ] **Step 3: Implement the pass-through**

In `src/core/team-export.ts`, add the field to `ExportedTeam`:

```ts
export interface ExportedTeam {
  name: string
  emoji: string
  stakeholders: ExportedPerson[]
  members: ExportedPerson[]
  actionItems: ActionItem[]
  milestones: Milestone[]
  risks: Risk[]
  actionTagNames: Partial<Record<ActionItem['color'], string>>
}
```

In `buildExport`, add the field to the mapped object:

```ts
    teams: teams.map((t) => ({
      name: t.name,
      emoji: t.emoji,
      stakeholders: t.stakeholders.map(stripPerson),
      members: t.members.map(stripPerson),
      actionItems: t.actionItems,
      milestones: t.milestones,
      risks: t.risks,
      actionTagNames: t.actionTagNames ?? {},
    })),
```

In `remapForImport`, add the field to the returned `Team` object:

```ts
export function remapForImport(teams: ExportedTeam[]): Team[] {
  return teams.map((t) => ({
    id: crypto.randomUUID(),
    name: `${t.name} (imported)`,
    emoji: t.emoji,
    stakeholders: remapPersonList(t.stakeholders),
    members: remapPersonList(t.members),
    actionItems: t.actionItems.map((a) => ({ ...a, id: crypto.randomUUID() })),
    milestones: t.milestones.map((m) => ({ ...m, id: crypto.randomUUID() })),
    risks: t.risks.map((r) => ({ ...r, id: crypto.randomUUID() })),
    dailyNotes: {},
    actionTagNames: t.actionTagNames ?? {},
  }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/team-export.test.ts`
Expected: PASS, the full file.

- [ ] **Step 5: Full suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass — this is the last task, so this is the final full-repo verification.

- [ ] **Step 6: Commit**

```bash
git add src/core/team-export.ts test/team-export.test.ts
git commit -m "feat: carry actionTagNames through team export/import

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Post-plan verification

After Task 7, do a final manual pass (per the project's `verify` skill) since this plan touches UI the automated suite can only partially exercise:

1. `npm run build`, open `dist/app.html`, create a team, add an overdue and a due-soon action item, confirm the sidebar badge and per-team badge appear with correct colors, and that clicking a due row navigates correctly and closes the modal.
2. Open the Kanban board, use "Edit tags" to name a color, confirm the card shows the new label, confirm the filter chip filters correctly and the Done/Cancelled counts stay unfiltered.
3. Export the team via Prefs → Data, re-import it, confirm the tag name survived.
