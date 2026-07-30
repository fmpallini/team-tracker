# Filterable Due Dates Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user open the due-dates panel from the command palette, filter it to a single team by clicking that team's due-count badge (sidebar list, header team switcher, or header pill), and see a global due-items summary even when the sidebar is collapsed — without ever changing the active team as a side effect of opening the panel.

**Architecture:** Extract the due-dates modal into a standalone, `Store`/`PaneManager`-free renderer (`src/ui/due-panel.ts`) that takes pre-computed `DueBuckets` plus an optional team filter and an `onOpenItem` callback. `sidebar.ts` keeps owning the today-keyed `dueBuckets()` cache and calls into this renderer from four places (global button, sidebar list badge, header-switcher badge, header pill). `palette.ts` gets one synthetic non-navigational row wired to the same renderer via a new `SidebarHandle.openDuePanel()` method.

**Tech Stack:** TypeScript, esbuild, vitest + jsdom. Zero runtime dependencies (dev-only: esbuild/typescript/vitest/jsdom).

## Global Constraints

- Zero runtime dependencies — no new packages of any kind (per `CLAUDE.md`).
- Every touched `src` module keeps a matching `test/*.test.ts` — add cases there, don't create parallel test files for existing modules.
- No new i18n keys: the filtered modal's title reuses the existing `due_panel_title` string with a `·`-separator (the same convention `panes.ts`'s `titleFor` already uses), and the palette row reuses `due_panel_title` with a `⏰ ` prefix. Both locales (`pt-BR`, `en-US`) already have this key.
- `npm run typecheck` (strict) and `npm run lint` must stay clean after every task.
- Spec: `docs/superpowers/specs/2026-07-28-due-dates-filter-design.md` — refer back to it if anything here seems ambiguous.

---

### Task 1: `src/ui/due-panel.ts` — standalone due-list renderer

**Files:**
- Create: `src/ui/due-panel.ts`
- Test: `test/due-panel.test.ts`

**Interfaces:**
- Consumes: `DueBuckets`, `DueItem` (`src/core/due.ts`), `Loc` (`src/core/types.ts`), `t`/`todayIso`/`formatDate`/`Locale` (`src/core/i18n.ts`), `diffDays` (`src/core/date.ts`), `KIND_ICON` (`src/core/search.ts`), `REF_KINDS` (`src/core/refs.ts`), `el` (`src/ui/dom.ts`), `showModal`/`ModalButton`/`ModalHandle` (`src/ui/modal.ts`).
- Produces (for later tasks): `filterBucketsByTeam(buckets: DueBuckets, teamId: string | undefined): DueBuckets` and `openDuePanel(opts: DuePanelOpts): void` where
  ```ts
  export interface DuePanelOpts {
    locale: Locale
    buckets: DueBuckets
    teamId?: string
    teamName?: string
    onOpenItem(loc: Loc): void
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/due-panel.test.ts`:

```ts
import { openDuePanel, filterBucketsByTeam } from '../src/ui/due-panel'
import type { DueItem, DueBuckets } from '../src/core/due'
import type { Loc } from '../src/core/types'

function makeItem(overrides: Partial<DueItem> = {}): DueItem {
  return {
    loc: { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } },
    title: 'Task A',
    teamName: 'Alpha',
    date: '2000-01-01',
    kind: 'action',
    ...overrides,
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('filterBucketsByTeam', () => {
  test('returns the same buckets when teamId is undefined', () => {
    const buckets: DueBuckets = { overdue: [makeItem()], dueSoon: [] }
    expect(filterBucketsByTeam(buckets, undefined)).toEqual(buckets)
  })

  test('filters overdue and dueSoon down to the given team', () => {
    const t1 = makeItem({ loc: { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } } })
    const t2 = makeItem({ loc: { teamId: 'T2', ref: { kind: 'actions', itemId: 'a2' } }, teamName: 'Beta' })
    const buckets: DueBuckets = { overdue: [t1, t2], dueSoon: [t2] }
    expect(filterBucketsByTeam(buckets, 'T1')).toEqual({ overdue: [t1], dueSoon: [] })
  })

  test('a team with no matching items yields empty arrays, not a crash', () => {
    const buckets: DueBuckets = { overdue: [makeItem()], dueSoon: [] }
    expect(filterBucketsByTeam(buckets, 'nonexistent')).toEqual({ overdue: [], dueSoon: [] })
  })
})

describe('openDuePanel', () => {
  test('shows the empty state when both buckets are empty', () => {
    openDuePanel({ locale: 'en-US', buckets: { overdue: [], dueSoon: [] }, onOpenItem: () => {} })
    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Nothing overdue or due soon.')
  })

  test('renders overdue/due-soon sections and titles the modal "Due" when unfiltered', () => {
    const overdueItem = makeItem({ title: 'Overdue task' })
    const soonItem = makeItem({ title: 'Soon task', date: '2999-01-01' })
    openDuePanel({ locale: 'en-US', buckets: { overdue: [overdueItem], dueSoon: [soonItem] }, onOpenItem: () => {} })
    expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Due')
    const headings = Array.from(document.querySelectorAll('.tt-due-section-heading')).map((n) => n.textContent)
    expect(headings).toEqual(['Overdue', 'Due soon'])
  })

  test('titles the modal with the team name when filtered', () => {
    openDuePanel({ locale: 'en-US', buckets: { overdue: [makeItem()], dueSoon: [] }, teamId: 'T1', teamName: 'Alpha', onOpenItem: () => {} })
    expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Due · Alpha')
  })

  test('clicking a row calls onOpenItem with its loc and closes the modal', () => {
    const loc: Loc = { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } }
    const onOpenItem = vi.fn()
    openDuePanel({ locale: 'en-US', buckets: { overdue: [makeItem({ loc })], dueSoon: [] }, onOpenItem })
    ;(document.querySelector('.tt-due-row') as HTMLElement).click()
    expect(onOpenItem).toHaveBeenCalledWith(loc)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/due-panel.test.ts`
Expected: FAIL — `Cannot find module '../src/ui/due-panel'`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/due-panel.ts`:

```ts
// src/ui/due-panel.ts — standalone renderer for the overdue/due-soon list
// modal. Takes pre-computed DueBuckets (sidebar.ts owns the today-keyed
// cache) and an onOpenItem callback instead of touching Store/PaneManager
// directly, so every caller (sidebar's global button, per-team badges, the
// header pill, the command palette) can reuse the exact same modal.
import type { DueBuckets, DueItem } from '../core/due'
import type { Loc } from '../core/types'
import { t, todayIso, formatDate, type Locale } from '../core/i18n'
import { diffDays } from '../core/date'
import { KIND_ICON } from '../core/search'
import { REF_KINDS } from '../core/refs'
import { el } from './dom'
import { showModal, type ModalButton, type ModalHandle } from './modal'

export interface DuePanelOpts {
  locale: Locale
  buckets: DueBuckets
  /** Omit to show every team; set to scope the panel to one team. */
  teamId?: string
  /** Required when teamId is set — used in the modal title. */
  teamName?: string
  onOpenItem(loc: Loc): void
}

/** Pure, exported for unit testing without touching the DOM. */
export function filterBucketsByTeam(buckets: DueBuckets, teamId: string | undefined): DueBuckets {
  if (teamId === undefined) return buckets
  return {
    overdue: buckets.overdue.filter((it) => it.loc.teamId === teamId),
    dueSoon: buckets.dueSoon.filter((it) => it.loc.teamId === teamId),
  }
}

function relLabel(locale: Locale, dateIso: string): string {
  const today = todayIso()
  if (dateIso < today) return t(locale, 'due_overdue_by', { days: String(diffDays(today, dateIso)) })
  return t(locale, 'due_in_days', { days: String(diffDays(dateIso, today)) })
}

function renderDueRow(locale: Locale, item: DueItem, onOpenItem: (loc: Loc) => void, closeModal: () => void): HTMLElement {
  const icon = KIND_ICON[REF_KINDS[item.kind].moduleKind]
  return el(
    'div',
    {
      class: 'tt-due-row',
      onclick: () => {
        closeModal()
        onOpenItem(item.loc)
      },
    },
    el('span', { class: 'tt-due-row-icon' }, icon),
    el('span', { class: 'tt-due-row-title' }, item.title),
    el('span', { class: 'tt-due-row-team' }, item.teamName),
    el('span', { class: 'tt-due-row-date' }, `${formatDate(item.date, locale)} · ${relLabel(locale, item.date)}`)
  )
}

export function openDuePanel(opts: DuePanelOpts): void {
  const { locale, teamId, teamName, onOpenItem } = opts
  const buckets = filterBucketsByTeam(opts.buckets, teamId)
  let handle: ModalHandle | null = null
  const closeModal = (): void => { handle?.close() }
  const sections: HTMLElement[] = []
  if (buckets.overdue.length + buckets.dueSoon.length === 0) {
    sections.push(el('p', { class: 'tt-modal-message' }, t(locale, 'due_empty')))
  } else {
    if (buckets.overdue.length > 0) {
      sections.push(el('div', { class: 'tt-due-section-heading' }, t(locale, 'due_section_overdue')))
      sections.push(...buckets.overdue.map((it) => renderDueRow(locale, it, onOpenItem, closeModal)))
    }
    if (buckets.dueSoon.length > 0) {
      sections.push(el('div', { class: 'tt-due-section-heading' }, t(locale, 'due_section_due_soon')))
      sections.push(...buckets.dueSoon.map((it) => renderDueRow(locale, it, onOpenItem, closeModal)))
    }
  }
  const body = el('div', { class: 'tt-due-list' }, ...sections)
  const title = teamId !== undefined ? `${t(locale, 'due_panel_title')} · ${teamName}` : t(locale, 'due_panel_title')
  const closeBtn: ModalButton = { label: t(locale, 'ok'), primary: true, onClick: closeModal }
  handle = showModal({ title, body, buttons: [closeBtn] })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/due-panel.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/due-panel.ts test/due-panel.test.ts
git commit -m "feat: add standalone due-dates panel renderer"
```

---

### Task 2: Wire `sidebar.ts`'s global ⏰ button through `due-panel.ts`

Pure refactor — no new user-visible behavior. Removes the inline modal-building code now duplicated in Task 1's module, and introduces two small helpers (`teamDueCountsMap`, `onOpenItem`) that Tasks 3–5 will reuse instead of each duplicating the per-team-count loop.

**Files:**
- Modify: `src/ui/sidebar.ts`

**Interfaces:**
- Consumes: `openDuePanel`, `DuePanelOpts` (Task 1's `src/ui/due-panel.ts`).
- Produces (for Tasks 3–5): `teamDueCountsMap(buckets: DueBuckets): Map<string, number>` and `onOpenItem(loc: Loc): void`, both private closures inside `mountSidebar`.

- [ ] **Step 1: Update imports**

In `src/ui/sidebar.ts`, replace the import block (current lines 1–17):

```ts
// src/ui/sidebar.ts
import type { Store } from '../core/store'
import type { Shell } from './shell'
import type { PaneManager } from './panes'
import { invalidateUnsplitStash } from './panes'
import type { Loc, Team } from '../core/types'
import { lastLocForTeam } from '../core/nav'
import { t, todayIso, formatDate, type Locale } from '../core/i18n'
import { collectDueItems, type DueBuckets, type DueItem } from '../core/due'
import { diffDays } from '../core/date'
import { createEmptyTeam } from '../core/document'
import { KIND_ICON } from '../core/search'
import { REF_KINDS } from '../core/refs'
import { el, bindOutsideDismiss } from './dom'
import { showModal, confirmDelete, type ModalButton, type ModalHandle } from './modal'
import { attachEmojiPicker } from './emoji-picker'
import { paintSelection, clampMove, selectableRowProps } from './select-list'
```

with:

```ts
// src/ui/sidebar.ts
import type { Store } from '../core/store'
import type { Shell } from './shell'
import type { PaneManager } from './panes'
import { invalidateUnsplitStash } from './panes'
import type { Loc, Team } from '../core/types'
import { lastLocForTeam } from '../core/nav'
import { t, todayIso, type Locale } from '../core/i18n'
import { collectDueItems, type DueBuckets } from '../core/due'
import { createEmptyTeam } from '../core/document'
import { el, bindOutsideDismiss } from './dom'
import { showModal, confirmDelete, type ModalButton, type ModalHandle } from './modal'
import { attachEmojiPicker } from './emoji-picker'
import { paintSelection, clampMove, selectableRowProps } from './select-list'
import { openDuePanel } from './due-panel'
```

- [ ] **Step 2: Replace the two inline `teamDueCounts` loops with a shared helper**

In `openTeamSwitcher()`, replace:

```ts
    switcherTeams = store.doc.teams
    const buckets = dueBuckets()
    const teamDueCounts = new Map<string, number>()
    for (const it of [...buckets.overdue, ...buckets.dueSoon]) {
      teamDueCounts.set(it.loc.teamId, (teamDueCounts.get(it.loc.teamId) ?? 0) + 1)
    }
```

with:

```ts
    switcherTeams = store.doc.teams
    const buckets = dueBuckets()
    const teamDueCounts = teamDueCountsMap(buckets)
```

In `render()`, replace:

```ts
    const buckets = dueBuckets()
    renderDueBadge(buckets)
    const teamDueCounts = new Map<string, number>()
    for (const it of [...buckets.overdue, ...buckets.dueSoon]) {
      teamDueCounts.set(it.loc.teamId, (teamDueCounts.get(it.loc.teamId) ?? 0) + 1)
    }
```

with:

```ts
    const buckets = dueBuckets()
    renderDueBadge(buckets)
    const teamDueCounts = teamDueCountsMap(buckets)
```

- [ ] **Step 3: Add the two shared helpers, and remove the now-superseded inline modal code**

Immediately after the `dueBuckets()` function (right before `function relLabel(dateIso: string): string {`), insert:

```ts
  function teamDueCountsMap(buckets: DueBuckets): Map<string, number> {
    const counts = new Map<string, number>()
    for (const it of [...buckets.overdue, ...buckets.dueSoon]) {
      counts.set(it.loc.teamId, (counts.get(it.loc.teamId) ?? 0) + 1)
    }
    return counts
  }

  function onOpenItem(loc: Loc): void {
    if (loc.teamId !== store.doc.nav.activeTeamId) actions.selectTeam(loc.teamId)
    pm.openInFocused(loc)
  }
```

Then delete the three functions `relLabel`, `renderDueRow`, and `openDueModal` entirely (they're superseded by Task 1's `due-panel.ts`) — i.e. remove this whole block:

```ts
  function relLabel(dateIso: string): string {
    const today = todayIso()
    if (dateIso < today) return t(locale(), 'due_overdue_by', { days: String(diffDays(today, dateIso)) })
    return t(locale(), 'due_in_days', { days: String(diffDays(dateIso, today)) })
  }

  function renderDueRow(item: DueItem, closeModal: () => void): HTMLElement {
    const icon = KIND_ICON[REF_KINDS[item.kind].moduleKind]
    return el(
      'div',
      {
        class: 'tt-due-row',
        onclick: () => {
          closeModal()
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
    const buckets = dueBuckets()
    let handle: ModalHandle | null = null
    const closeModal = (): void => { handle?.close() }
    const sections: HTMLElement[] = []
    if (buckets.overdue.length + buckets.dueSoon.length === 0) {
      sections.push(el('p', { class: 'tt-modal-message' }, t(locale(), 'due_empty')))
    } else {
      if (buckets.overdue.length > 0) {
        sections.push(el('div', { class: 'tt-due-section-heading' }, t(locale(), 'due_section_overdue')))
        sections.push(...buckets.overdue.map((it) => renderDueRow(it, closeModal)))
      }
      if (buckets.dueSoon.length > 0) {
        sections.push(el('div', { class: 'tt-due-section-heading' }, t(locale(), 'due_section_due_soon')))
        sections.push(...buckets.dueSoon.map((it) => renderDueRow(it, closeModal)))
      }
    }
    const body = el('div', { class: 'tt-due-list' }, ...sections)
    const closeBtn: ModalButton = { label: t(locale(), 'ok'), primary: true, onClick: closeModal }
    handle = showModal({ title: t(locale(), 'due_panel_title'), body, buttons: [closeBtn] })
  }
```

- [ ] **Step 4: Rewire the global ⏰ button**

Replace:

```ts
  const dueBadgeEl = el('span', { class: 'tt-due-badge' })
  const dueBtn = el(
    'button',
    { class: 'tt-btn tt-due-btn', type: 'button', title: t(locale(), 'due_badge_title'), onclick: () => openDueModal() },
    '⏰', dueBadgeEl
  )
```

with:

```ts
  const dueBadgeEl = el('span', { class: 'tt-due-badge' })
  const dueBtn = el(
    'button',
    {
      class: 'tt-btn tt-due-btn', type: 'button', title: t(locale(), 'due_badge_title'),
      onclick: () => openDuePanel({ locale: locale(), buckets: dueBuckets(), onOpenItem }),
    },
    '⏰', dueBadgeEl
  )
```

- [ ] **Step 5: Run the full existing sidebar test suite (regression guard)**

Run: `npx vitest run test/sidebar.test.ts`
Expected: PASS, unchanged — this task must not alter any observable behavior. In particular the `describe('due list modal', ...)` block still passes with zero test edits.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors (confirms every removed import is actually unused now, and no dangling references to the deleted functions remain).

- [ ] **Step 7: Commit**

```bash
git add src/ui/sidebar.ts
git commit -m "refactor: route sidebar's global due modal through due-panel.ts"
```

---

### Task 3: Sidebar team-list due badge becomes clickable (team-filtered panel)

**Files:**
- Modify: `src/ui/sidebar.ts`
- Modify: `styles.css`
- Test: `test/sidebar.test.ts`

**Interfaces:**
- Consumes: `openDuePanel` (Task 1), `dueBuckets()`/`onOpenItem`/`teamDueCountsMap` (Task 2, already in scope inside `mountSidebar`).

- [ ] **Step 1: Write the failing tests**

In `test/sidebar.test.ts`, add a new `describe` block (anywhere after the existing `describe('due list modal', ...)` block, before `describe('sidebar collapse', ...)`):

```ts
describe('per-team due badge (sidebar list)', () => {
  test('clicking it opens a panel scoped to just that team, without selecting the team', () => {
    const { store, selectTeam } = setup()
    addTeam(store, 'Alpha')
    addTeam(store, 'Beta')
    addActionItem(store, 'Alpha', { id: 'a1', dueDate: '2000-01-01' })
    store.updateNav((d) => { d.nav.activeTeamId = 'Beta' })

    const badge = items()[0]!.querySelector('.tt-team-due-badge') as HTMLElement
    badge.click()

    expect(selectTeam).not.toHaveBeenCalled()
    expect(document.querySelectorAll('.tt-due-row')).toHaveLength(1)
    expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Due · Alpha')
  })

  test('clicking a due row inside the filtered panel still jumps to it (switches team + opens the item)', () => {
    const { store, pm, selectTeam } = setup()
    addTeam(store, 'Alpha')
    addTeam(store, 'Beta')
    addActionItem(store, 'Alpha', { id: 'a1', dueDate: '2000-01-01' })
    store.updateNav((d) => { d.nav.activeTeamId = 'Beta' })

    ;(items()[0]!.querySelector('.tt-team-due-badge') as HTMLElement).click()
    ;(document.querySelector('.tt-due-row') as HTMLElement).click()

    expect(selectTeam).toHaveBeenCalledWith('Alpha')
    expect(pm.openInFocused).toHaveBeenCalledWith({ teamId: 'Alpha', ref: { kind: 'actions', itemId: 'a1' } })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sidebar.test.ts`
Expected: FAIL — the two new tests fail (`selectTeam` gets called / no modal appears), since the badge has no click handler yet.

- [ ] **Step 3: Make the badge clickable**

In `render()`, replace:

```ts
      const dueCount = teamDueCounts.get(team.id) ?? 0
      const teamDueBadgeEl = dueCount > 0 ? el('span', { class: 'tt-team-due-badge' }, String(dueCount)) : null
```

with:

```ts
      const dueCount = teamDueCounts.get(team.id) ?? 0
      const teamDueBadgeEl = dueCount > 0
        ? el(
            'span',
            {
              class: 'tt-team-due-badge',
              onclick: (e: Event) => {
                e.stopPropagation()
                openDuePanel({ locale: locale(), buckets: dueBuckets(), teamId: team.id, teamName: team.name, onOpenItem })
              },
            },
            String(dueCount)
          )
        : null
```

- [ ] **Step 4: Add a pointer cursor to the now-clickable badge**

In `styles.css`, replace:

```css
.tt-team-due-badge { font-family: var(--font-data); font-size: .65rem; font-weight: 700; border-radius: 999px; padding: 0 .4rem; background: var(--danger); color: #fff; flex: none; }
```

with:

```css
.tt-team-due-badge { font-family: var(--font-data); font-size: .65rem; font-weight: 700; border-radius: 999px; padding: 0 .4rem; background: var(--danger); color: #fff; flex: none; cursor: pointer; }
.tt-team-due-badge:empty { display: none; }
```

(The `:empty` rule is needed by Task 5, which reuses this same class inside a persistent element that toggles between empty and non-empty rather than being added/removed from the DOM — harmless here since this call site is never rendered empty.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/sidebar.test.ts`
Expected: PASS, including the two new tests.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`

- [ ] **Step 7: Commit**

```bash
git add src/ui/sidebar.ts styles.css test/sidebar.test.ts
git commit -m "feat: clicking a team's sidebar due badge opens a team-filtered panel"
```

---

### Task 4: Header team-switcher due badge becomes clickable

**Files:**
- Modify: `src/ui/sidebar.ts`
- Test: `test/sidebar.test.ts`

**Interfaces:**
- Consumes: same as Task 3, plus the existing `closeTeamSwitcher()` closure.

- [ ] **Step 1: Write the failing test**

Add to `test/sidebar.test.ts`, after the block added in Task 3:

```ts
describe('team switcher dropdown due badge', () => {
  function toggleBtn(): HTMLButtonElement {
    return document.querySelector('.tt-sidebar-toggle') as HTMLButtonElement
  }
  function openSwitcher(): void {
    toggleBtn().click() // collapse the sidebar so the header pill appears
    ;(document.querySelector('.tt-header-team-indicator') as HTMLElement).click()
  }

  test('clicking a team\'s badge opens its filtered panel, closes the dropdown, and does not switch teams', () => {
    const { store, selectTeam } = setup()
    addTeam(store, 'Alpha')
    addTeam(store, 'Beta')
    addActionItem(store, 'Alpha', { id: 'a1', dueDate: '2000-01-01' })
    store.updateNav((d) => { d.nav.activeTeamId = 'Beta' })

    openSwitcher()
    const badge = document.querySelector('.tt-team-switcher-item .tt-team-due-badge') as HTMLElement
    badge.click()

    expect(selectTeam).not.toHaveBeenCalled()
    expect(document.querySelector('.tt-team-switcher-dropdown')).toBeNull()
    expect(document.querySelectorAll('.tt-due-row')).toHaveLength(1)
    expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Due · Alpha')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sidebar.test.ts`
Expected: FAIL — clicking the badge currently just runs the row's `onCommit` (switches team), no modal appears.

- [ ] **Step 3: Make the switcher badge clickable**

In `openTeamSwitcher()`, replace:

```ts
        el('span', { class: 'tt-team-name' }, team.name),
        ...(dueCount > 0 ? [el('span', { class: 'tt-team-due-badge' }, String(dueCount))] : [])
      )
```

with:

```ts
        el('span', { class: 'tt-team-name' }, team.name),
        ...(dueCount > 0
          ? [
              el(
                'span',
                {
                  class: 'tt-team-due-badge',
                  onclick: (e: Event) => {
                    e.stopPropagation()
                    closeTeamSwitcher()
                    openDuePanel({ locale: locale(), buckets: dueBuckets(), teamId: team.id, teamName: team.name, onOpenItem })
                  },
                },
                String(dueCount)
              ),
            ]
          : [])
      )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sidebar.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`

- [ ] **Step 6: Commit**

```bash
git add src/ui/sidebar.ts test/sidebar.test.ts
git commit -m "feat: clicking a team's switcher-dropdown due badge opens a team-filtered panel"
```

---

### Task 5: Header pill — active team's own due badge + global "other teams" summary

**Files:**
- Modify: `src/ui/sidebar.ts`
- Modify: `styles.css`
- Test: `test/sidebar.test.ts`

**Interfaces:**
- Consumes: `teamDueCountsMap`, `onOpenItem`, `dueBuckets` (Task 2), `openDuePanel` (Task 1).
- Produces: no new public interface — purely additive DOM/behavior inside `mountSidebar`.

- [ ] **Step 1: Write the failing tests**

Add to `test/sidebar.test.ts`, inside (at the end of) the existing `describe('header team indicator (shown only while the sidebar is collapsed)', ...)` block, right before its closing `})`:

```ts
  describe('due counters', () => {
    function summary(): HTMLElement {
      return document.querySelector('.tt-header-due-summary') as HTMLElement
    }

    test('shows the active team\'s own due count inside the pill', () => {
      const { store } = setup()
      addTeam(store, 'Alpha')
      addActionItem(store, 'Alpha', { id: 'a1', dueDate: '2000-01-01' })
      store.updateNav((d) => { d.nav.activeTeamId = 'Alpha' })
      toggleBtn().click()

      expect(indicator().querySelector('.tt-team-due-badge')?.textContent).toBe('1')
    })

    test('the global summary is hidden when only the active team has due items', () => {
      const { store } = setup()
      addTeam(store, 'Alpha')
      addActionItem(store, 'Alpha', { id: 'a1', dueDate: '2000-01-01' })
      store.updateNav((d) => { d.nav.activeTeamId = 'Alpha' })
      toggleBtn().click()

      expect(summary().classList.contains('visible')).toBe(false)
    })

    test('the global summary shows the total from OTHER teams and opens the unfiltered panel', () => {
      const { store, selectTeam } = setup()
      addTeam(store, 'Alpha')
      addTeam(store, 'Beta')
      addActionItem(store, 'Beta', { id: 'b1', dueDate: '2000-01-01' })
      store.updateNav((d) => { d.nav.activeTeamId = 'Alpha' })
      toggleBtn().click()

      expect(summary().classList.contains('visible')).toBe(true)
      expect(summary().textContent).toContain('1')

      summary().click()
      expect(selectTeam).not.toHaveBeenCalled()
      expect(document.querySelectorAll('.tt-due-row')).toHaveLength(1)
      expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Due')
    })

    test('clicking the pill\'s own due badge opens the filtered panel for the active team, not the switcher', () => {
      const { store } = setup()
      addTeam(store, 'Alpha')
      addActionItem(store, 'Alpha', { id: 'a1', dueDate: '2000-01-01' })
      store.updateNav((d) => { d.nav.activeTeamId = 'Alpha' })
      toggleBtn().click()

      ;(indicator().querySelector('.tt-team-due-badge') as HTMLElement).click()

      expect(document.querySelector('.tt-team-switcher-dropdown')).toBeNull()
      expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Due · Alpha')
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sidebar.test.ts`
Expected: FAIL — `.tt-header-due-summary` doesn't exist yet, and the pill has no `.tt-team-due-badge` child.

- [ ] **Step 3: Extend the header pill construction**

Replace:

```ts
  const headerTeamIndicatorLabel = el('span', { class: 'tt-header-team-indicator-label' })
  const headerTeamIndicatorCaret = el('span', { class: 'tt-header-team-indicator-caret', 'aria-hidden': 'true' })
  headerTeamIndicatorCaret.innerHTML =
    '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>'
  const headerTeamIndicator = el(
    'button',
    { class: 'tt-header-team-indicator', type: 'button', onclick: () => toggleTeamSwitcher() },
    headerTeamIndicatorLabel,
    headerTeamIndicatorCaret
  )
```

with:

```ts
  const headerTeamIndicatorLabel = el('span', { class: 'tt-header-team-indicator-label' })
  const headerTeamIndicatorDueBadge = el('span', {
    class: 'tt-team-due-badge',
    onclick: (e: Event) => {
      e.stopPropagation()
      const team = store.doc.teams.find((tm) => tm.id === store.doc.nav.activeTeamId)
      if (!team) return
      openDuePanel({ locale: locale(), buckets: dueBuckets(), teamId: team.id, teamName: team.name, onOpenItem })
    },
  })
  const headerTeamIndicatorCaret = el('span', { class: 'tt-header-team-indicator-caret', 'aria-hidden': 'true' })
  headerTeamIndicatorCaret.innerHTML =
    '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>'
  const headerTeamIndicator = el(
    'button',
    { class: 'tt-header-team-indicator', type: 'button', onclick: () => toggleTeamSwitcher() },
    headerTeamIndicatorLabel,
    headerTeamIndicatorDueBadge,
    headerTeamIndicatorCaret
  )
  const headerDueSummaryIcon = el('span', { class: 'tt-header-due-summary-icon', 'aria-hidden': 'true' }, '⏰')
  const headerDueSummaryCount = el('span', { class: 'tt-header-due-summary-count' })
  const headerDueSummary = el(
    'button',
    {
      class: 'tt-header-due-summary', type: 'button',
      onclick: () => openDuePanel({ locale: locale(), buckets: dueBuckets(), onOpenItem }),
    },
    headerDueSummaryIcon,
    headerDueSummaryCount
  )
  const headerTeamIndicatorGroup = el('div', { class: 'tt-header-team-indicator-group' }, headerDueSummary, headerTeamIndicator)
```

- [ ] **Step 4: Compute and apply both counts in `renderHeaderTeamIndicator()`**

Replace:

```ts
  function renderHeaderTeamIndicator(): void {
    const collapsed = effectivelyCollapsed()
    const team = store.doc.teams.find((tm) => tm.id === store.doc.nav.activeTeamId)
    headerTeamIndicator.classList.toggle('visible', collapsed && !!team)
    headerTeamIndicator.title = t(locale(), 'team_switch_title')
    if (team) headerTeamIndicatorLabel.textContent = team.emoji ? `${team.emoji} ${team.name}` : team.name
    // The pill only exists while the sidebar is hidden — if a resize or the
    // manual toggle just brought the sidebar back, a switcher left open
    // would float over nothing, anchored to a button that's no longer shown.
    if (!collapsed) closeTeamSwitcher()
  }
```

with:

```ts
  function renderHeaderTeamIndicator(): void {
    const collapsed = effectivelyCollapsed()
    const team = store.doc.teams.find((tm) => tm.id === store.doc.nav.activeTeamId)
    headerTeamIndicator.classList.toggle('visible', collapsed && !!team)
    headerTeamIndicator.title = t(locale(), 'team_switch_title')
    if (team) headerTeamIndicatorLabel.textContent = team.emoji ? `${team.emoji} ${team.name}` : team.name

    const teamDueCounts = teamDueCountsMap(dueBuckets())
    const ownCount = team ? teamDueCounts.get(team.id) ?? 0 : 0
    headerTeamIndicatorDueBadge.textContent = ownCount > 0 ? String(ownCount) : ''

    let otherCount = 0
    for (const [tid, count] of teamDueCounts) {
      if (tid !== team?.id) otherCount += count
    }
    headerDueSummaryCount.textContent = String(otherCount)
    headerDueSummary.classList.toggle('visible', collapsed && otherCount > 0)

    // The pill only exists while the sidebar is hidden — if a resize or the
    // manual toggle just brought the sidebar back, a switcher left open
    // would float over nothing, anchored to a button that's no longer shown.
    if (!collapsed) closeTeamSwitcher()
  }
```

- [ ] **Step 5: Mount the group instead of the bare pill**

Replace:

```ts
  shell.headerCenter.appendChild(headerTeamIndicator)
```

with:

```ts
  shell.headerCenter.appendChild(headerTeamIndicatorGroup)
```

- [ ] **Step 6: Add CSS for the group wrapper and the summary element**

In `styles.css`, replace the compact-hide selector list:

```css
.tt-header.tt-header-compact .tt-sidebar-toggle,
.tt-header.tt-header-compact .tt-app-name,
.tt-header.tt-header-compact .tt-search-wrap,
.tt-header.tt-header-compact .tt-header-team-indicator,
.tt-header.tt-header-compact .tt-save-pill,
.tt-header.tt-header-compact .tt-btn-fullscreen,
.tt-header.tt-header-compact .tt-btn-help {
  display: none;
}
```

with (only the one line changes — `.tt-header-team-indicator` → `.tt-header-team-indicator-group`, so both the pill and the new summary hide together):

```css
.tt-header.tt-header-compact .tt-sidebar-toggle,
.tt-header.tt-header-compact .tt-app-name,
.tt-header.tt-header-compact .tt-search-wrap,
.tt-header.tt-header-compact .tt-header-team-indicator-group,
.tt-header.tt-header-compact .tt-save-pill,
.tt-header.tt-header-compact .tt-btn-fullscreen,
.tt-header.tt-header-compact .tt-btn-help {
  display: none;
}
```

Then, right after the `.tt-header-team-indicator-caret` rules (after the line `.tt-header-team-indicator:hover .tt-header-team-indicator-caret,\n.tt-header-team-indicator:focus-visible .tt-header-team-indicator-caret { opacity: 1; }`), add:

```css
.tt-header-team-indicator-group { display: inline-flex; align-items: center; gap: .4rem; min-width: 0; }

.tt-header-due-summary {
  display: none; align-items: center; gap: .3rem;
  background: none; border: none; padding: 0; cursor: pointer;
  font-family: var(--font-data); font-size: .8rem; font-weight: 700; color: var(--fg); flex: none;
}
.tt-header-due-summary.visible { display: inline-flex; }
.tt-header-due-summary:hover, .tt-header-due-summary:focus-visible { color: var(--accent); }
.tt-header-due-summary-icon { display: inline-flex; }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/sidebar.test.ts`
Expected: PASS, including all 4 new tests and the 4 pre-existing "header team indicator" tests (their `indicator().textContent` assertions like `'🚀 Team One'` stay correct because the due badge is empty — hence contributes `''` — whenever there are no due items).

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`

- [ ] **Step 9: Commit**

```bash
git add src/ui/sidebar.ts styles.css test/sidebar.test.ts
git commit -m "feat: show due-item counters on the collapsed header's team pill"
```

---

### Task 6: Command palette "Due Dates" entry

**Files:**
- Modify: `src/ui/sidebar.ts` (expose `SidebarHandle.openDuePanel()`)
- Modify: `src/ui/palette.ts`
- Modify: `src/main.ts`
- Test: `test/palette.test.ts`

**Interfaces:**
- Consumes: `openDuePanel` (Task 1), `dueBuckets`/`onOpenItem` (Task 2).
- Produces: `SidebarHandle.openDuePanel(): void`; `createPalette(store: Store, pm: PaneManager, onOpenDue?: () => void): Palette` (third param optional, backward compatible with the existing 2-arg call in `test/palette.test.ts`); `filterModuleItems<T extends { label: string }>(items: T[], query: string): T[]` (generalized from `ModuleItem[]`, behavior unchanged).

- [ ] **Step 1: Write the failing tests**

In `test/palette.test.ts`, change `setup()` to accept an optional callback and pass it through:

```ts
function setup(onOpenDue?: () => void): { store: Store; pm: PaneManager; palette: Palette } {
  document.body.innerHTML = ''
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  doc.teams.push({
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 's1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
  })
  doc.nav.activeTeamId = 'T1'
  const store = createStore(doc)
  const shell = createShell('en-US')
  const pm = createPaneManager(shell, store, 'en-US')
  const palette = createPalette(store, pm, onOpenDue)
  return { store, pm, palette }
}
```

Then add, after the existing two `test(...)` blocks:

```ts
test('shows a "Due" entry first when onOpenDue is provided, and invokes it instead of navigating', () => {
  const onOpenDue = vi.fn()
  const { palette } = setup(onOpenDue)
  palette.open()

  const rows = document.querySelectorAll('.tt-palette-item')
  expect(rows[0]!.textContent).toContain('Due')

  rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  expect(onOpenDue).toHaveBeenCalledTimes(1)
  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
})

test('typing a query that does not match "due" filters the Due entry out', () => {
  const { palette } = setup(() => {})
  palette.open()

  const input = document.querySelector('.tt-palette-input') as HTMLInputElement
  input.value = 'stakeholders'
  input.dispatchEvent(new Event('input'))

  const labels = Array.from(document.querySelectorAll('.tt-palette-item')).map((r) => r.textContent)
  expect(labels.some((l) => l?.includes('Due'))).toBe(false)
})

test('without onOpenDue, no Due entry appears', () => {
  const { palette } = setup()
  palette.open()

  const labels = Array.from(document.querySelectorAll('.tt-palette-item')).map((r) => r.textContent)
  expect(labels.some((l) => l?.includes('Due'))).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/palette.test.ts`
Expected: FAIL — `createPalette` doesn't accept a third argument yet (TS error) and no "Due" row exists.

- [ ] **Step 3: Add `openDuePanel()` to `SidebarHandle`**

In `src/ui/sidebar.ts`, replace the `SidebarHandle` interface:

```ts
export interface SidebarHandle {
  /**
   * Driven by the responsive-layout ResizeObserver (src/ui/responsive.ts):
   * forces the sidebar hidden when the window is too narrow, independent of
   * (and without persisting over) the user's own manual collapse preference
   * (`nav.sidebarCollapsed`). Purely transient — never written to the doc,
   * so a resize alone never marks the file dirty.
   */
  setSpaceConstrained(hidden: boolean): void
}
```

with:

```ts
export interface SidebarHandle {
  /**
   * Driven by the responsive-layout ResizeObserver (src/ui/responsive.ts):
   * forces the sidebar hidden when the window is too narrow, independent of
   * (and without persisting over) the user's own manual collapse preference
   * (`nav.sidebarCollapsed`). Purely transient — never written to the doc,
   * so a resize alone never marks the file dirty.
   */
  setSpaceConstrained(hidden: boolean): void
  /** Opens the global (all-teams) due-dates panel — used by the Ctrl+K palette's "Due" entry (src/ui/palette.ts). */
  openDuePanel(): void
}
```

Then replace the return statement at the end of `mountSidebar`:

```ts
  return { setSpaceConstrained }
```

with:

```ts
  return {
    setSpaceConstrained,
    openDuePanel: () => openDuePanel({ locale: locale(), buckets: dueBuckets(), onOpenItem }),
  }
```

- [ ] **Step 4: Rewrite `src/ui/palette.ts`**

Replace the entire file with:

```ts
// src/ui/palette.ts — Ctrl+K command palette: same module items as the pane
// dropdown (src/ui/panes.ts), filtered by a normalized substring match, plus
// one synthetic "Due" entry (src/ui/due-panel.ts) that isn't part of the
// pane module list.
import type { Store } from '../core/store'
import type { Locale } from '../core/i18n'
import { t } from '../core/i18n'
import { normalize } from '../core/search'
import { el } from './dom'
import { paintSelection, clampMove, selectableRowProps } from './select-list'
import { buildModuleItems, type PaneManager } from './panes'

export interface Palette {
  open(): void
}

interface PaletteRow {
  label: string
  commit(): void
}

/** Pure and exported so it can be unit-tested without touching the DOM. */
export function filterModuleItems<T extends { label: string }>(items: T[], query: string): T[] {
  const q = normalize(query.trim())
  if (!q) return items
  return items.filter((item) => normalize(item.label).includes(q))
}

export function createPalette(store: Store, pm: PaneManager, onOpenDue?: () => void): Palette {
  let overlay: HTMLElement | null = null
  let listEl: HTMLElement | null = null
  let allRows: PaletteRow[] = []
  let filtered: PaletteRow[] = []
  let selected = 0

  function locale(): Locale {
    return store.doc.prefs.locale
  }

  function close(): void {
    if (!overlay) return
    overlay.remove()
    overlay = null
    listEl = null
    document.removeEventListener('keydown', onKeydown, true)
  }

  function commit(row: PaletteRow | undefined): void {
    if (!row) return
    close()
    row.commit()
  }

  // Hover/arrow selection repaints in place via paintSelection — see
  // src/ui/select-list.ts for the rebuild-on-hover Chrome loop this avoids.
  function renderList(): void {
    if (!listEl) return
    listEl.innerHTML = ''
    filtered.forEach((row, i) => {
      const rowEl = el(
        'div',
        selectableRowProps({
          class: 'tt-palette-item',
          selected: i === selected,
          onCommit: () => commit(row),
          onHover: () => { selected = i; paintSelection(listEl, '.tt-palette-item', selected) },
        }),
        row.label
      )
      listEl!.appendChild(rowEl)
    })
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      selected = clampMove(selected, e.key === 'ArrowDown' ? 1 : -1, filtered.length)
      paintSelection(listEl, '.tt-palette-item', selected)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(filtered[selected])
    }
  }

  function open(): void {
    if (overlay) return
    const teamId = store.doc.nav.activeTeamId
    const team = teamId ? store.doc.teams.find((tm) => tm.id === teamId) ?? null : null
    const moduleRows: PaletteRow[] = buildModuleItems(team, locale()).map((item) => ({
      label: item.label,
      commit: () => {
        const activeTeamId = store.doc.nav.activeTeamId
        if (activeTeamId === null) return
        pm.openInFocused({ teamId: activeTeamId, ref: item.ref })
      },
    }))
    const dueRow: PaletteRow[] = onOpenDue
      ? [{ label: `⏰ ${t(locale(), 'due_panel_title')}`, commit: onOpenDue }]
      : []
    allRows = [...dueRow, ...moduleRows]
    filtered = allRows
    selected = 0

    const input = el('input', {
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

    input.addEventListener('input', () => {
      filtered = filterModuleItems(allRows, input.value)
      selected = 0
      renderList()
    })
    document.addEventListener('keydown', onKeydown, true)
    renderList()
    input.focus()
  }

  return { open }
}
```

- [ ] **Step 5: Wire it up in `main.ts`**

Replace:

```ts
  const palette = createPalette(store, pm)
```

with:

```ts
  // sidebarHandle isn't declared until mountSidebar() runs later in this
  // function — safe to reference here because this arrow function only ever
  // executes later (Ctrl+K or the app-name click), by which point
  // mountSidebar() has already returned it.
  const palette = createPalette(store, pm, () => sidebarHandle.openDuePanel())
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/palette.test.ts test/panes.test.ts test/sidebar.test.ts`
Expected: PASS — includes the 3 new palette tests, the pre-existing `filterModuleItems` test in `panes.test.ts` (unaffected by the generic signature — `T` infers as `ModuleItem`), and the full `sidebar.test.ts` suite.

- [ ] **Step 7: Typecheck, lint, and full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: no errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/ui/sidebar.ts src/ui/palette.ts src/main.ts test/palette.test.ts
git commit -m "feat: add a Due Dates entry to the Ctrl+K command palette"
```

---

## Post-plan verification

After Task 6, run the full project gate once more to confirm nothing drifted across tasks:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

All four must succeed before considering this feature done.
