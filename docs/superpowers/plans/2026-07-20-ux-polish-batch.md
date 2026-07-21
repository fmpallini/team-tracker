# UX Polish Batch (5 features) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five independent, small UX improvements: (1) show the open filename in the header, (2) right-click Duplicate/Copy-to-team/Move-to-team on action item / risk / milestone cards, (3) inline exact save timestamp in the header, (4) a Settings tab to cross-apply action-item tag names across all teams, (5) safe same-line Tab-indent in free-text editors.

**Architecture:** Each feature is additive and touches its own slice of the existing module/UI split (`src/core` headless logic, `src/ui` shell/shared widgets, `src/modules` per-pane renderers). Two small new shared primitives get built first because three of the features reuse them: `src/ui/context-menu.ts` (generic right-click menu) and `src/ui/team-picker-modal.ts` (pick-a-team dialog), plus pure data helpers in `src/core/card-transfer.ts` and a `stripAllRefs` addition to `src/core/refs.ts`. No `Doc`/`Team` schema changes and no `SCHEMA_VERSION` bump — every feature reuses existing persisted fields (`Team.actionTagNames`, `ActionItem.notes`, `Milestone.followup`, `Risk.followup`).

**Tech Stack:** TypeScript, esbuild, vitest + jsdom, zero runtime dependencies (per CLAUDE.md — do not add any).

## Global Constraints

- Zero runtime dependencies — everything below uses only what's already in `package.json` devDependencies.
- All user-visible strings go through `t(locale, key)` (`src/core/i18n.ts`); every new key added to **both** `pt` and `en` dicts in the same task (the `en` dict is typed `Record<MsgKey, string>`, so a missing key is a `tsc` error, not just a runtime gap).
- Every touched `src` module keeps a matching `test/*.test.ts` — extend existing files where one exists, create a new one where noted.
- No new git worktree / feature branch — work happens directly on `dev` per CLAUDE.md.
- Run `npm run typecheck` and `npm test` before each commit; run `npm run lint` before the final commit of the batch.

---

## File Structure

**New files:**
- `src/core/card-transfer.ts` — pure duplicate/copy/move helpers for action items, milestones, risks. Test: `test/card-transfer.test.ts`.
- `src/ui/context-menu.ts` — generic fixed-position right-click menu (singleton, Escape/outside-click closes). Test: `test/context-menu.test.ts`.
- `src/ui/team-picker-modal.ts` — single-team-picker dialog used by the copy/move actions. Test: `test/team-picker-modal.test.ts`.
- `test/shell.test.ts` — new (shell.ts currently has no dedicated test file; it's exercised indirectly by other suites, but the two behaviors added here deserve direct coverage).

**Modified files:**
- `src/core/refs.ts` — add `stripAllRefs`.
- `src/core/i18n.ts` — add keys for context menu / team picker / tags tab (no keys needed for features 1, 3, 5).
- `src/core/markdown.ts` — `mdToHtml` preserves a line's leading-space run visually (needed for feature 5's same-line indent to survive reload).
- `src/ui/editor.ts` — Tab/Shift+Tab same-line indent/outdent.
- `src/ui/shell.ts` — header filename display + inline save timestamp.
- `src/ui/prefs.ts` — new "Tags" settings tab.
- `src/modules/action-items.ts`, `src/modules/risks.ts`, `src/modules/milestones.ts` — wire the right-click context menu onto cards/rows.
- `styles.css` — small additive rules for the new filename span, context menu, and save-indicator wrapping.
- `test/action-items.test.ts`, `test/risks.test.ts`, `test/milestones.test.ts`, `test/prefs.test.ts`, `test/editor.test.ts`, `test/markdown.test.ts`, `test/refs.test.ts` — extended, not replaced.

---

### Task 1: `stripAllRefs` — flatten `@[label](kind:id)` mentions to plain text

**Files:**
- Modify: `src/core/refs.ts`
- Test: `test/refs.test.ts`

**Interfaces:**
- Consumes: `refPattern()` (already exported, no-arg form matches every `RefKind`).
- Produces: `export function stripAllRefs(text: string): string` — used by Task 2's transfer helpers.

- [ ] **Step 1: Write the failing test**

Append to `test/refs.test.ts`:

```ts
import { stripAllRefs } from '../src/core/refs'

describe('stripAllRefs', () => {
  test('flattens every ref kind to its plain label', () => {
    const text = 'ping @[Ana](person:p1) about @[Fix bug](action:a1) before @[Ship](milestone:m1) and @[Vendor](risk:r1)'
    expect(stripAllRefs(text)).toBe('ping Ana about Fix bug before Ship and Vendor')
  })

  test('leaves day refs and plain text untouched aside from person/action/milestone/risk', () => {
    const text = 'see you @[02/07/2026](day:2026-07-02), no other refs here'
    expect(stripAllRefs(text)).toBe('see you 02/07/2026, no other refs here')
  })

  test('no-ops on text with no refs', () => {
    expect(stripAllRefs('plain text, nothing to strip')).toBe('plain text, nothing to strip')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/refs.test.ts`
Expected: FAIL — `stripAllRefs` is not exported from `../src/core/refs`.

- [ ] **Step 3: Implement**

In `src/core/refs.ts`, add after `export function unlinkRefsInTeam(...)`:

```ts
/**
 * Unconditionally flattens every @[label](kind:id) mention in `text` to its
 * plain label — unlike unlinkRefsInText/unlinkRefsInTeam, which only rewrite
 * mentions pointing at specific deleted ids. Used when a card's free-text
 * field moves to a *different* team (Task 2's card-transfer.ts): the ids it
 * mentions belong to the source team and are meaningless (or collide) in the
 * destination, so every mention — not just dangling ones — must lose its
 * link and become ordinary prose.
 */
export function stripAllRefs(text: string): string {
  return text.replace(refPattern(), (_, label: string) => label)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/refs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/refs.ts test/refs.test.ts
git commit -m "feat: add stripAllRefs for cross-team card transfer"
```

---

### Task 2: `card-transfer.ts` — duplicate/copy/move for action items, milestones, risks

**Files:**
- Create: `src/core/card-transfer.ts`
- Test: `test/card-transfer.test.ts`

**Interfaces:**
- Consumes: `stripAllRefs` (Task 1), `Team` type (`src/core/types.ts`).
- Produces (used by Tasks 6-8):
  - `duplicateActionItem(team: Team, itemId: string): void`
  - `duplicateMilestone(team: Team, itemId: string): void`
  - `duplicateRisk(team: Team, itemId: string): void`
  - `transferActionItem(teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'): void`
  - `transferMilestone(teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'): void`
  - `transferRisk(teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'): void`

- [ ] **Step 1: Write the failing test**

Create `test/card-transfer.test.ts`:

```ts
import {
  duplicateActionItem, duplicateMilestone, duplicateRisk,
  transferActionItem, transferMilestone, transferRisk,
} from '../src/core/card-transfer'
import type { Team } from '../src/core/types'

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 't1', name: 'Team 1', emoji: '🚀',
    stakeholders: [], members: [],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}

describe('duplicateActionItem', () => {
  test('appends a copy with a new id and order at the end', () => {
    const tm = team({ actionItems: [
      { id: 'a1', summary: 'Do thing', notes: 'ping @[Ana](person:p1)', status: 'todo', dueDate: null, assignee: 'Bob', color: 'ledger', order: 0 },
    ] })
    duplicateActionItem(tm, 'a1')
    expect(tm.actionItems).toHaveLength(2)
    const copy = tm.actionItems[1]!
    expect(copy.id).not.toBe('a1')
    expect(copy.summary).toBe('Do thing')
    expect(copy.assignee).toBe('Bob')
    expect(copy.notes).toBe('ping @[Ana](person:p1)') // same-team duplicate: refs stay live
    expect(copy.order).toBe(1)
  })

  test('no-ops when the id is not found', () => {
    const tm = team()
    duplicateActionItem(tm, 'missing')
    expect(tm.actionItems).toHaveLength(0)
  })
})

describe('duplicateMilestone', () => {
  test('appends a copy with a new id', () => {
    const tm = team({ milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship', done: false, followup: 'blocked by @[Fix](action:a1)' }] })
    duplicateMilestone(tm, 'm1')
    expect(tm.milestones).toHaveLength(2)
    expect(tm.milestones[1]!.id).not.toBe('m1')
    expect(tm.milestones[1]!.title).toBe('Ship')
    expect(tm.milestones[1]!.followup).toBe('blocked by @[Fix](action:a1)')
  })
})

describe('duplicateRisk', () => {
  test('appends a copy with a new id and order at the end', () => {
    const tm = team({ risks: [{ id: 'r1', title: 'Vendor delay', chance: 2, impact: 2, plan: 'mitigate', followup: '', order: 0, closed: false }] })
    duplicateRisk(tm, 'r1')
    expect(tm.risks).toHaveLength(2)
    expect(tm.risks[1]!.id).not.toBe('r1')
    expect(tm.risks[1]!.order).toBe(1)
  })
})

describe('transferActionItem', () => {
  function twoTeams(): [Team, Team] {
    return [
      team({ id: 'from', actionItems: [{ id: 'a1', summary: 'Do thing', notes: 'ping @[Ana](person:p1)', status: 'todo', dueDate: null, assignee: 'Bob', color: 'ledger', order: 0 }] }),
      team({ id: 'to' }),
    ]
  }

  test('copy: appends a stripped-refs copy to the target team, leaves source untouched', () => {
    const [from, to] = twoTeams()
    transferActionItem([from, to], 'a1', 'from', 'to', 'copy')
    expect(from.actionItems).toHaveLength(1) // untouched
    expect(to.actionItems).toHaveLength(1)
    const copy = to.actionItems[0]!
    expect(copy.id).not.toBe('a1')
    expect(copy.notes).toBe('ping Ana') // ref flattened to plain text
    expect(copy.assignee).toBe('Bob') // already plain text, untouched
    expect(copy.order).toBe(0)
  })

  test('move: appends to target and removes from source', () => {
    const [from, to] = twoTeams()
    transferActionItem([from, to], 'a1', 'from', 'to', 'move')
    expect(from.actionItems).toHaveLength(0)
    expect(to.actionItems).toHaveLength(1)
  })

  test('no-ops when the item id is not found', () => {
    const [from, to] = twoTeams()
    transferActionItem([from, to], 'missing', 'from', 'to', 'copy')
    expect(to.actionItems).toHaveLength(0)
  })
})

describe('transferMilestone', () => {
  test('copy strips refs from followup', () => {
    const from = team({ id: 'from', milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship', done: false, followup: 'blocked by @[Fix](action:a1)' }] })
    const to = team({ id: 'to' })
    transferMilestone([from, to], 'm1', 'from', 'to', 'copy')
    expect(to.milestones[0]!.followup).toBe('blocked by Fix')
    expect(from.milestones).toHaveLength(1)
  })

  test('move removes from source', () => {
    const from = team({ id: 'from', milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship', done: false, followup: '' }] })
    const to = team({ id: 'to' })
    transferMilestone([from, to], 'm1', 'from', 'to', 'move')
    expect(from.milestones).toHaveLength(0)
    expect(to.milestones).toHaveLength(1)
  })
})

describe('transferRisk', () => {
  test('copy strips refs from followup and resets order', () => {
    const from = team({ id: 'from', risks: [{ id: 'r1', title: 'Vendor delay', chance: 2, impact: 2, plan: 'mitigate', followup: 'see @[Ana](person:p1)', order: 3, closed: false }] })
    const to = team({ id: 'to', risks: [{ id: 'r0', title: 'Existing', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }] })
    transferRisk([from, to], 'r1', 'from', 'to', 'copy')
    expect(to.risks).toHaveLength(2)
    const copy = to.risks[1]!
    expect(copy.followup).toBe('see Ana')
    expect(copy.order).toBe(1)
    expect(from.risks).toHaveLength(1)
  })

  test('move removes from source', () => {
    const from = team({ id: 'from', risks: [{ id: 'r1', title: 'Vendor delay', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }] })
    const to = team({ id: 'to' })
    transferRisk([from, to], 'r1', 'from', 'to', 'move')
    expect(from.risks).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/card-transfer.test.ts`
Expected: FAIL — cannot find module `../src/core/card-transfer`.

- [ ] **Step 3: Implement**

Create `src/core/card-transfer.ts`:

```ts
// src/core/card-transfer.ts — pure duplicate/copy/move helpers for action
// items, milestones and risks, backing the cards' right-click context menu
// (src/modules/action-items.ts, risks.ts, milestones.ts). Same-team
// duplicate keeps @ref mentions live (they still resolve); cross-team
// transfer strips them to plain text via stripAllRefs, since a mention's id
// only means something inside the team it was written in.
import type { Team } from './types'
import { stripAllRefs } from './refs'

export function duplicateActionItem(team: Team, itemId: string): void {
  const src = team.actionItems.find((i) => i.id === itemId)
  if (!src) return
  team.actionItems.push({ ...src, id: crypto.randomUUID(), order: team.actionItems.length })
}

export function duplicateMilestone(team: Team, itemId: string): void {
  const src = team.milestones.find((i) => i.id === itemId)
  if (!src) return
  team.milestones.push({ ...src, id: crypto.randomUUID() })
}

export function duplicateRisk(team: Team, itemId: string): void {
  const src = team.risks.find((i) => i.id === itemId)
  if (!src) return
  team.risks.push({ ...src, id: crypto.randomUUID(), order: team.risks.length })
}

export function transferActionItem(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'
): void {
  const from = teams.find((t) => t.id === fromTeamId)
  const to = teams.find((t) => t.id === toTeamId)
  if (!from || !to) return
  const src = from.actionItems.find((i) => i.id === itemId)
  if (!src) return
  to.actionItems.push({ ...src, id: crypto.randomUUID(), order: to.actionItems.length, notes: stripAllRefs(src.notes) })
  if (mode === 'move') from.actionItems = from.actionItems.filter((i) => i.id !== itemId)
}

export function transferMilestone(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'
): void {
  const from = teams.find((t) => t.id === fromTeamId)
  const to = teams.find((t) => t.id === toTeamId)
  if (!from || !to) return
  const src = from.milestones.find((i) => i.id === itemId)
  if (!src) return
  to.milestones.push({ ...src, id: crypto.randomUUID(), followup: stripAllRefs(src.followup) })
  if (mode === 'move') from.milestones = from.milestones.filter((i) => i.id !== itemId)
}

export function transferRisk(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'
): void {
  const from = teams.find((t) => t.id === fromTeamId)
  const to = teams.find((t) => t.id === toTeamId)
  if (!from || !to) return
  const src = from.risks.find((i) => i.id === itemId)
  if (!src) return
  to.risks.push({ ...src, id: crypto.randomUUID(), order: to.risks.length, followup: stripAllRefs(src.followup) })
  if (mode === 'move') from.risks = from.risks.filter((i) => i.id !== itemId)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/card-transfer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/card-transfer.ts test/card-transfer.test.ts
git commit -m "feat: add duplicate/copy/move helpers for cards"
```

---

### Task 3: `context-menu.ts` — generic right-click menu

**Files:**
- Create: `src/ui/context-menu.ts`
- Test: `test/context-menu.test.ts`
- Modify: `styles.css`

**Interfaces:**
- Consumes: `el` (`src/ui/dom.ts`).
- Produces (used by Tasks 6-8): `export interface ContextMenuItem { label: string; onClick: () => void; danger?: boolean }`, `export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void`.

- [ ] **Step 1: Write the failing test**

Create `test/context-menu.test.ts`:

```ts
import { showContextMenu } from '../src/ui/context-menu'

afterEach(() => {
  document.body.innerHTML = ''
})

function items(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-context-menu-item'))
}

test('renders one button per item, positioned at (x, y)', () => {
  showContextMenu(50, 80, [{ label: 'Duplicate', onClick: () => {} }, { label: 'Delete', onClick: () => {}, danger: true }])
  const menu = document.querySelector<HTMLElement>('.tt-context-menu')!
  expect(menu.style.left).toBe('50px')
  expect(menu.style.top).toBe('80px')
  expect(items().map((b) => b.textContent)).toEqual(['Duplicate', 'Delete'])
  expect(items()[1]!.classList.contains('danger')).toBe(true)
})

test('clicking an item calls onClick and closes the menu', () => {
  const onClick = vi.fn()
  showContextMenu(0, 0, [{ label: 'Duplicate', onClick }])
  items()[0]!.click()
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(document.querySelector('.tt-context-menu')).toBeNull()
})

test('clicking outside the menu closes it without calling onClick', () => {
  const onClick = vi.fn()
  showContextMenu(0, 0, [{ label: 'Duplicate', onClick }])
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  expect(onClick).not.toHaveBeenCalled()
  expect(document.querySelector('.tt-context-menu')).toBeNull()
})

test('Escape closes the menu', () => {
  showContextMenu(0, 0, [{ label: 'Duplicate', onClick: () => {} }])
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('.tt-context-menu')).toBeNull()
})

test('opening a second menu closes the first', () => {
  showContextMenu(0, 0, [{ label: 'First', onClick: () => {} }])
  showContextMenu(10, 10, [{ label: 'Second', onClick: () => {} }])
  expect(document.querySelectorAll('.tt-context-menu')).toHaveLength(1)
  expect(items().map((b) => b.textContent)).toEqual(['Second'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/context-menu.test.ts`
Expected: FAIL — cannot find module `../src/ui/context-menu`.

- [ ] **Step 3: Implement**

Create `src/ui/context-menu.ts`:

```ts
// src/ui/context-menu.ts — a minimal right-click menu: a fixed-position
// overlay anchored at the click point, closed by Escape or an outside click.
// Mirrors the open/close lifecycle of ui/atref.ts's @ dropdown but with no
// keyboard navigation — every current use (card actions) is mouse-driven.
import { el } from './dom'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

// Module-level so opening a new menu always closes any menu already open —
// callers never need to track/close their own previous instance.
let closeCurrent: (() => void) | null = null

export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  closeCurrent?.()

  function close(): void {
    menu.remove()
    document.removeEventListener('mousedown', onDocMousedown, true)
    document.removeEventListener('keydown', onKeydown, true)
    closeCurrent = null
  }

  function onDocMousedown(e: MouseEvent): void {
    if (!menu.contains(e.target as Node)) close()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close()
  }

  const menu = el(
    'div',
    { class: 'tt-context-menu', style: `left:${x}px; top:${y}px` },
    ...items.map((item) =>
      el(
        'button',
        {
          class: 'tt-context-menu-item' + (item.danger ? ' danger' : ''),
          type: 'button',
          onclick: () => { close(); item.onClick() },
        },
        item.label
      )
    )
  )
  document.body.appendChild(menu)
  document.addEventListener('mousedown', onDocMousedown, true)
  document.addEventListener('keydown', onKeydown, true)
  closeCurrent = close
}
```

Add to `styles.css`, right after the `.tt-templates-empty:hover { background: none; }` line (end of the "@ reference autocomplete" block, ~line 401):

```css

/* Right-click card context menu (action items / risks / milestones) */
.tt-context-menu {
  position: fixed; z-index: 1300; background: var(--bg); color: var(--fg);
  border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, .25);
  min-width: 170px; padding: .25rem; display: flex; flex-direction: column;
}
.tt-context-menu-item {
  display: block; width: 100%; text-align: left; padding: .4rem .6rem; border-radius: 4px;
  cursor: pointer; font-size: .9rem; background: none; border: none; color: inherit; font-family: inherit;
}
.tt-context-menu-item:hover { background: rgba(var(--accent-rgb), .12); }
.tt-context-menu-item.danger { color: var(--danger); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/context-menu.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/context-menu.ts test/context-menu.test.ts styles.css
git commit -m "feat: add generic right-click context menu"
```

---

### Task 4: `team-picker-modal.ts` — pick a destination team

**Files:**
- Create: `src/ui/team-picker-modal.ts`
- Test: `test/team-picker-modal.test.ts`

**Interfaces:**
- Consumes: `showModal`, `type ModalButton` (`src/ui/modal.ts`), `el` (`src/ui/dom.ts`), `Team` type.
- Produces (used by Tasks 6-8): `export function openTeamPickerModal(opts: { title: string; confirmLabel: string; cancelLabel: string; teams: Team[]; onConfirm: (targetTeamId: string) => void }): void`.

- [ ] **Step 1: Write the failing test**

Create `test/team-picker-modal.test.ts`:

```ts
import { openTeamPickerModal } from '../src/ui/team-picker-modal'
import type { Team } from '../src/core/types'

afterEach(() => {
  document.body.innerHTML = ''
})

function team(id: string, name: string, emoji = '🚀'): Team {
  return { id, name, emoji, stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} }
}

function modalButton(label: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === label)!
}

test('renders one option per team with emoji + name', () => {
  openTeamPickerModal({
    title: 'Copy to which team?', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
    teams: [team('a', 'Alpha', '🚀'), team('b', 'Beta', '🔥')],
    onConfirm: () => {},
  })
  const options = Array.from(document.querySelectorAll<HTMLOptionElement>('select option'))
  expect(options.map((o) => o.textContent)).toEqual(['🚀 Alpha', '🔥 Beta'])
  expect(options.map((o) => o.value)).toEqual(['a', 'b'])
})

test('confirm calls onConfirm with the selected team id, then closes', () => {
  const onConfirm = vi.fn()
  openTeamPickerModal({
    title: 'Copy to which team?', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
    teams: [team('a', 'Alpha'), team('b', 'Beta')],
    onConfirm,
  })
  const select = document.querySelector('select') as HTMLSelectElement
  select.value = 'b'
  modalButton('Confirm').click()
  expect(onConfirm).toHaveBeenCalledWith('b')
  expect(document.querySelector('.tt-modal-overlay')).toBeNull()
})

test('cancel does not call onConfirm', () => {
  const onConfirm = vi.fn()
  openTeamPickerModal({
    title: 'Copy to which team?', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
    teams: [team('a', 'Alpha')],
    onConfirm,
  })
  modalButton('Cancel').click()
  expect(onConfirm).not.toHaveBeenCalled()
  expect(document.querySelector('.tt-modal-overlay')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/team-picker-modal.test.ts`
Expected: FAIL — cannot find module `../src/ui/team-picker-modal`.

- [ ] **Step 3: Implement**

Create `src/ui/team-picker-modal.ts`:

```ts
// src/ui/team-picker-modal.ts — single-team picker used by the card
// copy/move-to-team context menu actions (action items, milestones, risks)
// to choose the destination team. Locale-agnostic: callers pass already-
// translated labels, same convention as ui/modal.ts's ModalButton.
import type { Team } from '../core/types'
import { showModal, type ModalButton } from './modal'
import { el } from './dom'

export function openTeamPickerModal(opts: {
  title: string
  confirmLabel: string
  cancelLabel: string
  teams: Team[]
  onConfirm: (targetTeamId: string) => void
}): void {
  const select = el('select', { class: 'tt-input' }) as HTMLSelectElement
  for (const team of opts.teams) {
    select.appendChild(el('option', { value: team.id }, `${team.emoji} ${team.name}`))
  }
  const body = el('div', { class: 'tt-prefs-field' }, select)

  const cancelBtn: ModalButton = { label: opts.cancelLabel, onClick: () => handle.close() }
  const confirmBtn: ModalButton = {
    label: opts.confirmLabel,
    primary: true,
    onClick: () => {
      const targetId = select.value
      handle.close()
      if (targetId) opts.onConfirm(targetId)
    },
  }
  const handle = showModal({ title: opts.title, body, buttons: [cancelBtn, confirmBtn] })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/team-picker-modal.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/team-picker-modal.ts test/team-picker-modal.test.ts
git commit -m "feat: add team picker modal"
```

---

### Task 5: i18n keys for context menu + team picker

**Files:**
- Modify: `src/core/i18n.ts`

**Interfaces:**
- Produces (used by Tasks 6-8): `MsgKey` gains `context_menu_duplicate`, `context_menu_copy_to_team`, `context_menu_move_to_team`, `team_picker_copy_title`, `team_picker_move_title`, `team_picker_confirm_btn`.

- [ ] **Step 1: Add keys to both dicts**

In `src/core/i18n.ts`, insert right before the `pt` object's closing `} as const` (immediately after the `editor_clear_format_title: 'Limpar formatação',` line):

```ts
  context_menu_duplicate: 'Duplicar',
  context_menu_copy_to_team: 'Copiar para time…',
  context_menu_move_to_team: 'Mover para time…',
  team_picker_copy_title: 'Copiar para qual time?',
  team_picker_move_title: 'Mover para qual time?',
  team_picker_confirm_btn: 'Confirmar',
```

Insert the mirrored English block right before the `en` object's closing `}` (immediately after the `editor_clear_format_title: 'Clear formatting',` line):

```ts
  context_menu_duplicate: 'Duplicate',
  context_menu_copy_to_team: 'Copy to team…',
  context_menu_move_to_team: 'Move to team…',
  team_picker_copy_title: 'Copy to which team?',
  team_picker_move_title: 'Move to which team?',
  team_picker_confirm_btn: 'Confirm',
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (if `en` is missing a key `tsc` reports it against `Record<MsgKey, string>`).

- [ ] **Step 3: Commit**

```bash
git add src/core/i18n.ts
git commit -m "feat: add i18n keys for card context menu and team picker"
```

---

### Task 6: wire the context menu onto action item cards

**Files:**
- Modify: `src/modules/action-items.ts`
- Test: `test/action-items.test.ts`

**Interfaces:**
- Consumes: `showContextMenu`, `type ContextMenuItem` (Task 3), `openTeamPickerModal` (Task 4), `duplicateActionItem`, `transferActionItem` (Task 2), i18n keys from Task 5.

- [ ] **Step 1: Write the failing tests**

Add near the top of `test/action-items.test.ts`, after the existing `cards()` helper:

```ts
function rightClick(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
}

function contextMenuItem(text: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-context-menu-item')).find((b) => b.textContent === text)!
}
```

Add a new top-level `describe` block (e.g. after the `describe('pure helpers', ...)` block):

```ts
describe('card context menu', () => {
  test('right-click shows only Duplicate when there is just one team', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a1', order: 0 })] })
    const { container, store, pm } = setup(team)
    render(container, { teamId: team.id, ref: { kind: 'actions' } }, store, pm)

    rightClick(cards(container)[0]!)

    const labels = Array.from(document.querySelectorAll('.tt-context-menu-item')).map((b) => b.textContent)
    expect(labels).toEqual(['Duplicate'])
    document.body.innerHTML = document.body.innerHTML // no-op, keeps afterEach cleanup simple
  })

  test('Duplicate appends a copy to the same team', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a1', order: 0 })] })
    const { container, store, pm } = setup(team)
    render(container, { teamId: team.id, ref: { kind: 'actions' } }, store, pm)

    rightClick(cards(container)[0]!)
    contextMenuItem('Duplicate').click()

    expect(store.doc.teams[0]!.actionItems).toHaveLength(2)
  })

  test('Copy to team… copies into the target team with refs stripped and does not affect the source', () => {
    const from = makeTeam({ id: 'from', actionItems: [item({ id: 'a1', order: 0, notes: 'ping @[Ana](person:p1)' })] })
    const to = makeTeam({ id: 'to', name: 'Team 2' })
    const doc = createEmptyDocument('en-US')
    doc.teams.push(from, to)
    doc.nav.activeTeamId = from.id
    const store = createStore(doc)
    const pm = fakePM()
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(container, { teamId: from.id, ref: { kind: 'actions' } }, store, pm)

    rightClick(cards(container)[0]!)
    contextMenuItem('Copy to team…').click()
    const select = document.querySelector('select') as HTMLSelectElement
    select.value = 'to'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Confirm')!.click()

    expect(store.doc.teams.find((t) => t.id === 'from')!.actionItems).toHaveLength(1)
    const copied = store.doc.teams.find((t) => t.id === 'to')!.actionItems
    expect(copied).toHaveLength(1)
    expect(copied[0]!.notes).toBe('ping Ana')
  })

  test('Move to team… removes the card from the source team', () => {
    const from = makeTeam({ id: 'from', actionItems: [item({ id: 'a1', order: 0 })] })
    const to = makeTeam({ id: 'to', name: 'Team 2' })
    const doc = createEmptyDocument('en-US')
    doc.teams.push(from, to)
    doc.nav.activeTeamId = from.id
    const store = createStore(doc)
    const pm = fakePM()
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(container, { teamId: from.id, ref: { kind: 'actions' } }, store, pm)

    rightClick(cards(container)[0]!)
    contextMenuItem('Move to team…').click()
    const select = document.querySelector('select') as HTMLSelectElement
    select.value = 'to'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Confirm')!.click()

    expect(store.doc.teams.find((t) => t.id === 'from')!.actionItems).toHaveLength(0)
    expect(store.doc.teams.find((t) => t.id === 'to')!.actionItems).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/action-items.test.ts`
Expected: FAIL — right-click produces no `.tt-context-menu-item` elements yet.

- [ ] **Step 3: Implement**

In `src/modules/action-items.ts`, update the imports (top of file):

```ts
import type { ActionItem, Loc, Team } from '../core/types'
import { t, todayIso, formatDate, type MsgKey } from '../core/i18n'
import { teamRefCandidates } from '../core/search'
import { unlinkRefsInTeam } from '../core/refs'
import { isOverdue } from '../core/due'
import { nowHHMM } from '../core/date'
import { SUGGESTED_TAG_NAME_KEYS } from '../core/document'
import { duplicateActionItem, transferActionItem } from '../core/card-transfer'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { showContextMenu, type ContextMenuItem } from '../ui/context-menu'
import { openTeamPickerModal } from '../ui/team-picker-modal'
import { el } from '../ui/dom'
```

(only the `duplicateActionItem`/`transferActionItem`, `showContextMenu`/`ContextMenuItem`, and `openTeamPickerModal` import lines are new — the rest is the existing block, reproduced so the diff is unambiguous.)

Add two new functions right before `function renderCard(...)` (which currently starts the file's card-rendering section):

```ts
  function openCardContextMenu(itemId: string, x: number, y: number): void {
    const otherTeams = ctx.store.doc.teams.filter((tm) => tm.id !== teamId)
    const menuItems: ContextMenuItem[] = [
      {
        label: t(lc, 'context_menu_duplicate'),
        onClick: () => {
          ctx.store.update((d) => {
            const tm = d.teams.find((t2) => t2.id === teamId)
            if (tm) duplicateActionItem(tm, itemId)
          })
        },
      },
    ]
    if (otherTeams.length > 0) {
      menuItems.push({
        label: t(lc, 'context_menu_copy_to_team'),
        onClick: () => openTransferModal(itemId, 'copy', otherTeams),
      })
      menuItems.push({
        label: t(lc, 'context_menu_move_to_team'),
        onClick: () => openTransferModal(itemId, 'move', otherTeams),
      })
    }
    showContextMenu(x, y, menuItems)
  }

  function openTransferModal(itemId: string, mode: 'copy' | 'move', otherTeams: Team[]): void {
    openTeamPickerModal({
      title: t(lc, mode === 'copy' ? 'team_picker_copy_title' : 'team_picker_move_title'),
      confirmLabel: t(lc, 'team_picker_confirm_btn'),
      cancelLabel: t(lc, 'cancel'),
      teams: otherTeams,
      onConfirm: (targetTeamId) => {
        ctx.store.update((d) => {
          transferActionItem(d.teams, itemId, teamId, targetTeamId, mode)
        })
      },
    })
  }

```

Inside `renderCard`, right after `card.addEventListener('dblclick', () => openEditModal(item))`, add:

```ts
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      openCardContextMenu(item.id, (e as MouseEvent).clientX, (e as MouseEvent).clientY)
    })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/action-items.ts test/action-items.test.ts
git commit -m "feat: right-click Duplicate/Copy/Move on action item cards"
```

---

### Task 7: wire the context menu onto risk rows

**Files:**
- Modify: `src/modules/risks.ts`
- Test: `test/risks.test.ts`

**Interfaces:**
- Consumes: same Task 3/4/2/5 exports as Task 6, applied to `Risk`/`transferRisk`/`duplicateRisk`.

- [ ] **Step 1: Write the failing tests**

Add to `test/risks.test.ts`, after its existing helpers:

```ts
function rightClick(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
}

function contextMenuItem(text: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-context-menu-item')).find((b) => b.textContent === text)!
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tt-risk-row'))
}

describe('row context menu', () => {
  test('Duplicate appends a copy to the same team', () => {
    const team = makeTeam({ risks: [risk({ id: 'r1', order: 0 })] })
    const { container, store, pm } = setup(team)
    render(container, { teamId: team.id, ref: { kind: 'risks' } }, store, pm)

    rightClick(rows(container)[0]!)
    contextMenuItem('Duplicate').click()

    expect(store.doc.teams[0]!.risks).toHaveLength(2)
  })

  test('Move to team… removes the row from the source team', () => {
    const from = makeTeam({ id: 'from', risks: [risk({ id: 'r1', order: 0 })] })
    const to = makeTeam({ id: 'to', name: 'Team 2' })
    const doc = createEmptyDocument('en-US')
    doc.teams.push(from, to)
    doc.nav.activeTeamId = from.id
    const store = createStore(doc)
    const pm = fakePM()
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(container, { teamId: from.id, ref: { kind: 'risks' } }, store, pm)

    rightClick(rows(container)[0]!)
    contextMenuItem('Move to team…').click()
    const select = document.querySelector('select') as HTMLSelectElement
    select.value = 'to'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Confirm')!.click()

    expect(store.doc.teams.find((t) => t.id === 'from')!.risks).toHaveLength(0)
    expect(store.doc.teams.find((t) => t.id === 'to')!.risks).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/risks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/modules/risks.ts`, update the import block:

```ts
import type { Risk, RiskPlan, Loc, Team } from '../core/types'
import { t, todayIso, type MsgKey } from '../core/i18n'
import { teamRefCandidates } from '../core/search'
import { unlinkRefsInTeam } from '../core/refs'
import { duplicateRisk, transferRisk } from '../core/card-transfer'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { showContextMenu, type ContextMenuItem } from '../ui/context-menu'
import { openTeamPickerModal } from '../ui/team-picker-modal'
import { computeFlatDropPosition } from './action-items'
import { nowHHMM } from '../core/date'
import { el } from '../ui/dom'
```

Add these two functions right before `function renderRow(r: Risk): HTMLElement {`:

```ts
  function openRowContextMenu(itemId: string, x: number, y: number): void {
    const otherTeams = ctx.store.doc.teams.filter((tm) => tm.id !== teamId)
    const menuItems: ContextMenuItem[] = [
      {
        label: t(lc, 'context_menu_duplicate'),
        onClick: () => {
          ctx.store.update((d) => {
            const tm = d.teams.find((t2) => t2.id === teamId)
            if (tm) duplicateRisk(tm, itemId)
          })
        },
      },
    ]
    if (otherTeams.length > 0) {
      menuItems.push({ label: t(lc, 'context_menu_copy_to_team'), onClick: () => openTransferModal(itemId, 'copy', otherTeams) })
      menuItems.push({ label: t(lc, 'context_menu_move_to_team'), onClick: () => openTransferModal(itemId, 'move', otherTeams) })
    }
    showContextMenu(x, y, menuItems)
  }

  function openTransferModal(itemId: string, mode: 'copy' | 'move', otherTeams: Team[]): void {
    openTeamPickerModal({
      title: t(lc, mode === 'copy' ? 'team_picker_copy_title' : 'team_picker_move_title'),
      confirmLabel: t(lc, 'team_picker_confirm_btn'),
      cancelLabel: t(lc, 'cancel'),
      teams: otherTeams,
      onConfirm: (targetTeamId) => {
        ctx.store.update((d) => {
          transferRisk(d.teams, itemId, teamId, targetTeamId, mode)
        })
      },
    })
  }

```

Inside `renderRow`, right after the `if (expanded) row.classList.add('tt-risk-row-expanded')` line and before the `if (sortMode === 'none') {` drag-reorder block, add:

```ts
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      openRowContextMenu(r.id, (e as MouseEvent).clientX, (e as MouseEvent).clientY)
    })

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/risks.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/risks.ts test/risks.test.ts
git commit -m "feat: right-click Duplicate/Copy/Move on risk rows"
```

---

### Task 8: wire the context menu onto milestone rows

**Files:**
- Modify: `src/modules/milestones.ts`
- Test: `test/milestones.test.ts`

**Interfaces:**
- Consumes: same Task 3/4/2/5 exports as Task 6, applied to `Milestone`/`transferMilestone`/`duplicateMilestone`.

- [ ] **Step 1: Write the failing tests**

Add to `test/milestones.test.ts`, after its existing helpers:

```ts
function rightClick(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
}

function contextMenuItem(text: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-context-menu-item')).find((b) => b.textContent === text)!
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tt-milestone-row'))
}

describe('row context menu', () => {
  test('Duplicate appends a copy to the same team', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'm1' })] })
    const { container, store, pm } = setup(team)
    render(container, { teamId: team.id, ref: { kind: 'milestones' } }, store, pm)

    rightClick(rows(container)[0]!)
    contextMenuItem('Duplicate').click()

    expect(store.doc.teams[0]!.milestones).toHaveLength(2)
  })

  test('Copy to team… copies into the target team with refs stripped, source untouched', () => {
    const from = makeTeam({ id: 'from', milestones: [milestone({ id: 'm1', followup: 'blocked by @[Fix](action:a1)' })] })
    const to = makeTeam({ id: 'to', name: 'Team 2' })
    const doc = createEmptyDocument('en-US')
    doc.teams.push(from, to)
    doc.nav.activeTeamId = from.id
    const store = createStore(doc)
    const pm = fakePM()
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(container, { teamId: from.id, ref: { kind: 'milestones' } }, store, pm)

    rightClick(rows(container)[0]!)
    contextMenuItem('Copy to team…').click()
    const select = document.querySelector('select') as HTMLSelectElement
    select.value = 'to'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Confirm')!.click()

    expect(store.doc.teams.find((t) => t.id === 'from')!.milestones).toHaveLength(1)
    const copied = store.doc.teams.find((t) => t.id === 'to')!.milestones
    expect(copied).toHaveLength(1)
    expect(copied[0]!.followup).toBe('blocked by Fix')
  })
})
```

`render` in `test/milestones.test.ts` needs a `ModuleCtx` wrapper the same way `test/action-items.test.ts` has one — check whether it already exists in the file (it likely calls `renderMilestones` directly); if there's no `render()` helper yet, add:

```ts
function render(container: HTMLElement, loc: Loc, store: Store, pm: PaneManager, paneIdx: 0 | 1 = 0): void {
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US' }
  renderMilestones(container, loc, ctx)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/milestones.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/modules/milestones.ts`, update the import block:

```ts
import type { Milestone, Loc, Team } from '../core/types'
import { t, todayIso, formatDate } from '../core/i18n'
import { teamRefCandidates } from '../core/search'
import { unlinkRefsInTeam } from '../core/refs'
import { duplicateMilestone, transferMilestone } from '../core/card-transfer'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { showContextMenu, type ContextMenuItem } from '../ui/context-menu'
import { openTeamPickerModal } from '../ui/team-picker-modal'
import { nowHHMM } from '../core/date'
import { el } from '../ui/dom'
```

Add these two functions right before `function renderRow(m: Milestone): HTMLElement {`:

```ts
  function openRowContextMenu(itemId: string, x: number, y: number): void {
    const otherTeams = ctx.store.doc.teams.filter((tm) => tm.id !== teamId)
    const menuItems: ContextMenuItem[] = [
      {
        label: t(lc, 'context_menu_duplicate'),
        onClick: () => {
          ctx.store.update((d) => {
            const tm = d.teams.find((t2) => t2.id === teamId)
            if (tm) duplicateMilestone(tm, itemId)
          })
        },
      },
    ]
    if (otherTeams.length > 0) {
      menuItems.push({ label: t(lc, 'context_menu_copy_to_team'), onClick: () => openTransferModal(itemId, 'copy', otherTeams) })
      menuItems.push({ label: t(lc, 'context_menu_move_to_team'), onClick: () => openTransferModal(itemId, 'move', otherTeams) })
    }
    showContextMenu(x, y, menuItems)
  }

  function openTransferModal(itemId: string, mode: 'copy' | 'move', otherTeams: Team[]): void {
    openTeamPickerModal({
      title: t(lc, mode === 'copy' ? 'team_picker_copy_title' : 'team_picker_move_title'),
      confirmLabel: t(lc, 'team_picker_confirm_btn'),
      cancelLabel: t(lc, 'cancel'),
      teams: otherTeams,
      onConfirm: (targetTeamId) => {
        ctx.store.update((d) => {
          transferMilestone(d.teams, itemId, teamId, targetTeamId, mode)
        })
      },
    })
  }

```

Inside `renderRow`, right after `if (m.done) row.classList.add('tt-milestone-done-row')` and before `return row`, add:

```ts
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      openRowContextMenu(m.id, (e as MouseEvent).clientX, (e as MouseEvent).clientY)
    })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/milestones.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/milestones.ts test/milestones.test.ts
git commit -m "feat: right-click Duplicate/Copy/Move on milestone rows"
```

---

### Task 9: Settings → Tags tab — cross-apply action-item tag names across teams

**Files:**
- Modify: `src/ui/prefs.ts`
- Modify: `src/core/i18n.ts`
- Test: `test/prefs.test.ts`

**Interfaces:**
- Consumes: `store.doc.teams[].actionTagNames` (existing field, `src/core/types.ts`), `showModal`/`toast` (`src/ui/modal.ts`).

- [ ] **Step 1: Add i18n keys**

In `src/core/i18n.ts`, add to the `pt` object (right before the `context_menu_duplicate` block added in Task 5, or anywhere inside the object — order doesn't matter to `t()`):

```ts
  prefs_tab_tags: 'Tags',
  tags_cross_apply_heading: 'Aplicar tags entre times',
  tags_cross_apply_hint: 'As tags de ação (as 6 cores) podem ter nomes diferentes em cada time. Use isto para copiar os nomes de um time para todos os outros — ou deixe cada time com os seus próprios.',
  tags_cross_apply_source_label: 'Time de origem',
  tags_cross_apply_btn: 'Aplicar a todos os times',
  tags_cross_apply_confirm_title: 'Confirmar aplicação',
  tags_cross_apply_confirm_body: 'Isso substituirá os nomes de tags de TODOS os outros times pelos do time "{source}". Continuar?',
  tags_cross_apply_success_toast: 'Tags aplicadas a todos os times.',
  tags_cross_apply_need_two_teams: 'Crie pelo menos dois times para usar isso.',
```

And to the `en` object, in the same relative position:

```ts
  prefs_tab_tags: 'Tags',
  tags_cross_apply_heading: 'Apply tags across teams',
  tags_cross_apply_hint: 'Action-item tags (the 6 colors) can have different names per team. Use this to copy one team\'s names to every other team — or leave each team with its own.',
  tags_cross_apply_source_label: 'Source team',
  tags_cross_apply_btn: 'Apply to all teams',
  tags_cross_apply_confirm_title: 'Confirm apply',
  tags_cross_apply_confirm_body: 'This will overwrite the tag names of ALL other teams with those from "{source}". Continue?',
  tags_cross_apply_success_toast: 'Tags applied to all teams.',
  tags_cross_apply_need_two_teams: 'Create at least two teams to use this.',
```

- [ ] **Step 2: Write the failing tests**

Add to `test/prefs.test.ts` (needs `Team` already imported at the top, which it is):

```ts
function openTab(label: string): void {
  Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-prefs-tab-btn')).find((b) => b.textContent === label)!.click()
}

function team(id: string, name: string, actionTagNames: Team['actionTagNames'] = {}): Team {
  return { id, name, emoji: '🚀', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {}, actionTagNames }
}

describe('Tags tab', () => {
  test('shows a hint instead of the form when there are fewer than 2 teams', () => {
    const { store, shell, appCtl } = setup()
    store.update((d) => { d.teams.push(team('t1', 'Solo')) })
    openPrefs(store, shell, 'en-US', appCtl)
    openTab('Tags')
    expect(document.querySelector('.tt-prefs-content')!.textContent).toContain('Create at least two teams to use this.')
  })

  test('applying copies the source team\'s actionTagNames onto every other team, leaves the source untouched', () => {
    const { store, shell, appCtl } = setup()
    store.update((d) => {
      d.teams.push(team('t1', 'Alpha', { rust: 'Urgent' }))
      d.teams.push(team('t2', 'Beta', { rust: 'Old name' }))
      d.teams.push(team('t3', 'Gamma'))
    })
    openPrefs(store, shell, 'en-US', appCtl)
    openTab('Tags')

    const select = document.querySelector('select') as HTMLSelectElement
    select.value = 't1'
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Apply to all teams')!.click()
    // confirm modal
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Apply to all teams')!.click()

    expect(store.doc.teams.find((t) => t.id === 't1')!.actionTagNames).toEqual({ rust: 'Urgent' })
    expect(store.doc.teams.find((t) => t.id === 't2')!.actionTagNames).toEqual({ rust: 'Urgent' })
    expect(store.doc.teams.find((t) => t.id === 't3')!.actionTagNames).toEqual({ rust: 'Urgent' })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/prefs.test.ts`
Expected: FAIL — no "Tags" tab button exists yet.

- [ ] **Step 4: Implement**

In `src/ui/prefs.ts`, extend `TabId` and `TABS`:

```ts
type TabId = 'general' | 'templates' | 'tags' | 'security' | 'data' | 'about'

const TABS: readonly { id: TabId; key: MsgKey }[] = [
  { id: 'general', key: 'prefs_tab_general' },
  { id: 'templates', key: 'prefs_tab_templates' },
  { id: 'tags', key: 'prefs_tab_tags' },
  { id: 'security', key: 'prefs_tab_security' },
  { id: 'data', key: 'prefs_tab_data' },
  { id: 'about', key: 'prefs_tab_about' },
]
```

Add a new tab-render function, right before `// --- Tab 3: Segurança ---` (renumber that comment and the ones after it to Tab 4/5/6 if you want to keep the numbering tidy — not required for correctness):

```ts
  // --- Tab: Tags (cross-apply across teams) --------------------------------
  function renderTags(container: HTMLElement): void {
    container.innerHTML = ''
    const teams = store.doc.teams

    if (teams.length < 2) {
      container.append(el('p', { class: 'tt-data-hint' }, t(locale, 'tags_cross_apply_need_two_teams')))
      return
    }

    const sourceSelect = el('select', { class: 'tt-input' }) as HTMLSelectElement
    for (const team of teams) {
      sourceSelect.appendChild(el('option', { value: team.id }, `${team.emoji} ${team.name}`))
    }

    function applyClick(): void {
      const source = store.doc.teams.find((tm) => tm.id === sourceSelect.value)
      if (!source) return
      const body = el('p', { class: 'tt-modal-message' }, t(locale, 'tags_cross_apply_confirm_body', { source: source.name }))
      const cancelBtn: ModalButton = { label: t(locale, 'cancel'), onClick: () => inner.close() }
      const confirmBtn: ModalButton = {
        label: t(locale, 'tags_cross_apply_btn'),
        primary: true,
        onClick: () => {
          const sourceId = source.id
          store.update((d) => {
            const src = d.teams.find((tm) => tm.id === sourceId)
            if (!src) return
            const tags = { ...src.actionTagNames }
            for (const tm of d.teams) {
              if (tm.id === sourceId) continue
              tm.actionTagNames = { ...tags }
            }
          })
          inner.close()
          toast(t(locale, 'tags_cross_apply_success_toast'))
        },
      }
      const inner: ModalHandle = showModal({ title: t(locale, 'tags_cross_apply_confirm_title'), body, buttons: [cancelBtn, confirmBtn] })
    }

    const applyBtn = el(
      'button',
      { class: 'tt-btn tt-btn-primary', type: 'button', onclick: () => applyClick() },
      t(locale, 'tags_cross_apply_btn')
    )

    container.append(
      el(
        'div',
        { class: 'tt-prefs-field' },
        el('div', { class: 'tt-prefs-field-label' }, t(locale, 'tags_cross_apply_heading')),
        el('p', { class: 'tt-data-hint' }, t(locale, 'tags_cross_apply_hint')),
        el('label', { class: 'tt-field' }, t(locale, 'tags_cross_apply_source_label'), sourceSelect),
        applyBtn
      )
    )
  }

```

Add the new case in `renderActiveTab`'s switch:

```ts
      case 'tags':
        renderTags(contentEl)
        return
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/prefs.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/ui/prefs.ts src/core/i18n.ts test/prefs.test.ts
git commit -m "feat: add Settings > Tags tab to cross-apply tag names across teams"
```

---

### Task 10: header filename display + inline exact save timestamp

**Files:**
- Modify: `src/ui/shell.ts`
- Modify: `styles.css`
- Create: `test/shell.test.ts`

**Interfaces:**
- Consumes: `nowHHMM` (`src/core/date.ts`, already exists — no change needed there).
- No change to `Shell`'s public method signatures (`setTitle`, `setSaveState` keep their existing signatures) — every existing call site in `src/main.ts` and `src/core/save-controller.ts` needs no changes.

- [ ] **Step 1: Write the failing tests**

Create `test/shell.test.ts`:

```ts
import { createShell, type Shell } from '../src/ui/shell'

function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function setup(): Shell {
  stubMatchMedia()
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  return shell
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('header filename', () => {
  test('setTitle shows the filename in the header', () => {
    const shell = setup()
    shell.setTitle('team-tracker.tmv', false)
    expect(shell.root.querySelector('.tt-header-filename')!.textContent).toBe('team-tracker.tmv')
  })

  test('setTitle(null, ...) clears the header filename', () => {
    const shell = setup()
    shell.setTitle('team-tracker.tmv', false)
    shell.setTitle(null, false)
    expect(shell.root.querySelector('.tt-header-filename')!.textContent).toBe('')
  })
})

describe('save indicator timestamp', () => {
  test('setSaveState("saved") shows the icon plus HH:MM', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 14, 32))
    const shell = setup()
    shell.setSaveState('saved')
    expect(shell.root.querySelector('.tt-save-indicator')!.textContent).toBe('✓ 14:32')
  })

  test('other states show the icon only, no timestamp', () => {
    const shell = setup()
    shell.setSaveState('dirty')
    expect(shell.root.querySelector('.tt-save-indicator')!.textContent).toBe('●')
    shell.setSaveState('saving')
    expect(shell.root.querySelector('.tt-save-indicator')!.textContent).toBe('…')
    shell.setSaveState('error')
    expect(shell.root.querySelector('.tt-save-indicator')!.textContent).toBe('⚠')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/shell.test.ts`
Expected: FAIL — `.tt-header-filename` doesn't exist yet, and `setSaveState('saved')` renders `'✓'` not `'✓ 14:32'`.

- [ ] **Step 3: Implement**

In `src/ui/shell.ts`, add the import:

```ts
import type { Prefs } from '../core/types'
import { t, type Locale, type MsgKey } from '../core/i18n'
import { el } from './dom'
import { nowHHMM } from '../core/date'
```

Right after `headerLeft.appendChild(appNameBtn)`, add:

```ts
  const fileNameEl = el('span', { class: 'tt-header-filename' })
  headerLeft.appendChild(fileNameEl)
```

Change `let currentState: SaveState = 'saved'` to also track the last save time:

```ts
  let currentState: SaveState = 'saved'
  let fallbackHint = false
  let lastSavedAt: string | null = null
```

Replace the body of `setSaveState`:

```ts
  function setSaveState(state: SaveState): void {
    currentState = state
    const { icon, key } = SAVE_STATE_INFO[state]
    if (state === 'saved') lastSavedAt = nowHHMM()
    saveIndicator.textContent = state === 'saved' && lastSavedAt ? `${icon} ${lastSavedAt}` : icon
    let title = t(currentLocale, key)
    if (state === 'dirty' && fallbackHint) {
      title += ` — ${t(currentLocale, 'save_fallback_hint')}`
    }
    saveIndicator.title = title
    saveIndicator.dataset.state = state
  }
```

Replace the body of `setTitle`:

```ts
  function setTitle(fileName: string | null, dirty: boolean): void {
    document.title =
      `Team Tracker v${__APP_VERSION__}` + (fileName ? ` — ${fileName}` : '') + (dirty ? ' ●' : '')
    fileNameEl.textContent = fileName ?? ''
    fileNameEl.title = fileName ?? ''
  }
```

In `styles.css`, right after the line `.tt-header-left, .tt-header-right { display: flex; align-items: center; gap: .75rem; }` (~line 126), add:

```css
.tt-header-filename { color: var(--muted); font-size: .85rem; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

Change the existing `.tt-save-indicator` rule (~line 154) to add `white-space: nowrap;` so the icon+time never wraps:

```css
.tt-save-indicator { font-family: var(--font-data); color: var(--muted); min-width: 1.2em; text-align: center; white-space: nowrap; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/shell.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite (regression check)**

Run: `npm test`
Expected: all suites PASS — `test/prefs.test.ts`, `test/panes.test.ts`, `test/sidebar.test.ts`, `test/save-controller.test.ts`, `test/search-ui.test.ts`, `test/help.test.ts`, `test/palette.test.ts` all construct a `Shell` and must keep passing unmodified.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/ui/shell.ts styles.css test/shell.test.ts
git commit -m "feat: show open filename in header, exact save timestamp inline"
```

---

### Task 11: safe same-line Tab-indent in free-text editors

**Files:**
- Modify: `src/core/markdown.ts`
- Modify: `src/ui/editor.ts`
- Test: `test/markdown.test.ts`
- Test: `test/editor.test.ts`

**Interfaces:**
- Produces: `export function leadingIndentLen(text: string): number` (`src/ui/editor.ts`) — counts leading `' '`/`' '` chars, capped at 4.
- `mdToHtml` and `htmlToMd` keep their existing exported signatures; only their internal rendering changes.

Design note (from investigation, do not deviate): the app's markdown format only serializes **flat** lists — `htmlToMd` walks `:scope > li` directly and `inlineMd` has no case for a nested `<ul>`/`<ol>`, so a nested list would silently flatten/lose structure on the next save. Real nested sub-bullets are explicitly out of scope for this task (confirmed with the user) — Tab only pushes text right on the *same* line, in or out of a bullet, and never nests a new list level. Because the editor's `.editor` CSS has no `white-space: pre-wrap`, plain leading spaces collapse visually on any re-render (e.g. switching panes and back) unless `mdToHtml` re-expands them — that's why this task touches `markdown.ts`, not just `editor.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `test/markdown.test.ts`:

```ts
test('leading indent renders as non-breaking spaces and round-trips as plain spaces', () => {
  const md = '    indented line'
  const html = mdToHtml(md)
  expect(html).toBe('<div>    indented line</div>')
  expect(roundTrip(md)).toBe(md)
})

test('leading indent inside a list item round-trips', () => {
  const md = '-     indented bullet text'
  expect(roundTrip(md)).toBe(md)
})

test('leading indent inside a header round-trips', () => {
  const md = '#   indented heading'
  expect(roundTrip(md)).toBe(md)
})
```

Add to `test/editor.test.ts`, a new top-level `describe`:

```ts
describe('Tab indent', () => {
  test('leadingIndentLen counts leading space/nbsp chars, capped at 4', () => {
    expect(leadingIndentLen('')).toBe(0)
    expect(leadingIndentLen('abc')).toBe(0)
    expect(leadingIndentLen(' abc')).toBe(1)
    expect(leadingIndentLen('    abc')).toBe(4)
    expect(leadingIndentLen('      abc')).toBe(4)
    expect(leadingIndentLen('  abc')).toBe(2)
    expect(leadingIndentLen('    abc')).toBe(4)
  })

  test('Tab inserts a 4-char non-breaking indent at the caret', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    dispatchKey(editorEl, { key: 'Tab' })

    expect(execSpy).toHaveBeenCalledWith('insertText', false, '    ')
    editor.destroy()
  })

  test('Shift+Tab removes up to 4 leading indent chars from the current line', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('    hello')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const block = editorEl.firstElementChild as HTMLElement
    const textNode = block.firstChild!
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('hello')
    editor.destroy()
  })

  test('Shift+Tab on a line with no leading indent is a no-op', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('hello')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const block = editorEl.firstElementChild as HTMLElement
    const textNode = block.firstChild!
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('hello')
    editor.destroy()
  })
})
```

`dispatchKey` and `makeHooks` already exist in `test/editor.test.ts` (used by the "keyboard shortcuts" describe block) — this new `describe` can sit right after that block and reuse them. Update the file's top import line to also pull in `leadingIndentLen`:

```ts
import { createEditor, detectInlinePattern, detectBlockPrefix, leadingIndentLen, type Editor, type EditorHooks } from '../src/ui/editor'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/markdown.test.ts test/editor.test.ts`
Expected: FAIL — `leadingIndentLen` not exported, `mdToHtml` doesn't preserve indent, Tab has no handler.

- [ ] **Step 3: Implement — `src/core/markdown.ts`**

Add a helper right above `export function mdToHtml`:

```ts
/**
 * A line's leading run of plain spaces (Tab-inserted indent — see
 * ui/editor.ts) is rendered as non-breaking spaces so it survives the
 * editor's default `white-space: normal` instead of collapsing to one space
 * on re-render. htmlToMd's inlineMd normalizes ' ' straight back to
 * plain spaces on the way out (existing behavior), so storage always stays
 * plain-space text — human-readable, and stable across repeated round trips.
 */
function preserveIndent(s: string): string {
  const m = /^( +)/.exec(s)
  if (!m) return s
  return ' '.repeat(m[1]!.length) + s.slice(m[1]!.length)
}
```

Update `mdToHtml` to apply it at all four line-content sites:

```ts
export function mdToHtml(md: string, resolveLabel?: LabelResolver): string {
  const lines = md.split('\n'); const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  for (const line of lines) {
    const h = /^(#{1,3}) (.*)$/.exec(line)
    const ul = /^- (.*)$/.exec(line)
    const ol = /^(\d+)\. (.*)$/.exec(line)
    if (h) { closeList(); out.push(`<h${h[1]!.length}>${blockInline(preserveIndent(h[2]!), resolveLabel)}</h${h[1]!.length}>`) }
    else if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul' } out.push(`<li>${blockInline(preserveIndent(ul[1]!), resolveLabel)}</li>`) }
    else if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol' } out.push(`<li value="${ol[1]}">${blockInline(preserveIndent(ol[2]!), resolveLabel)}</li>`) }
    else { closeList(); out.push(`<div>${line ? blockInline(preserveIndent(line), resolveLabel) : '<br>'}</div>`) }
  }
  closeList(); return out.join('')
}
```

- [ ] **Step 4: Implement — `src/ui/editor.ts`**

Add the pure helper near the top, next to the other "pure, unit-testable" helpers (right after `detectBlockPrefix`'s section, or anywhere in that block — placement doesn't affect behavior):

```ts
/** Leading run of indent chars (space or the non-breaking space Tab inserts), capped at 4 — how much Shift+Tab removes in one press. */
export function leadingIndentLen(text: string): number {
  let n = 0
  while (n < text.length && n < 4 && (text[n] === ' ' || text[n] === ' ')) n++
  return n
}
```

Add the indent constant near the top of the file (below `const CHANGE_DEBOUNCE_MS = 300`):

```ts
const TAB_INDENT = '    '
```

Update `onKeydown` — insert the Tab branch as the *first* check (Tab carries no ctrl/meta, so it would otherwise hit the existing early return):

```ts
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      if (e.shiftKey) {
        const ctx = currentBlockAndOffset()
        if (ctx) {
          const n = leadingIndentLen(ctx.text)
          if (n > 0) {
            const range = rangeForTextOffsets(ctx.block, 0, n)
            range.deleteContents()
            const sel = window.getSelection()
            if (sel) {
              sel.removeAllRanges()
              const r = document.createRange()
              r.setStart(ctx.block, 0)
              r.collapse(true)
              sel.addRange(r)
            }
            scheduleChange()
          }
        }
      } else {
        exec('insertText', TAB_INDENT)
      }
      return
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    const key = e.key.toLowerCase()

    if (!e.shiftKey) {
      if (key === 'b') { e.preventDefault(); exec('bold'); return }
      if (key === 'i') { e.preventDefault(); exec('italic'); return }
      if (key === 'u') { e.preventDefault(); exec('underline'); return }
      if (e.code === 'Digit1') { e.preventDefault(); exec('formatBlock', '<h1>'); return }
      if (e.code === 'Digit2') { e.preventDefault(); exec('formatBlock', '<h2>'); return }
      if (e.code === 'Digit3') { e.preventDefault(); exec('formatBlock', '<h3>'); return }
      if (e.code === 'Digit0') { e.preventDefault(); exec('formatBlock', '<div>'); return }
      return
    }

    if (key === 'x') { e.preventDefault(); exec('strikeThrough'); return }
    if (e.code === 'Digit8') { e.preventDefault(); exec('insertUnorderedList'); return }
    if (e.code === 'Digit7') { e.preventDefault(); exec('insertOrderedList'); return }
  }
```

(only the new `if (e.key === 'Tab' ...)` block at the top is new — the rest of the function is reproduced unchanged so the diff is unambiguous.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/markdown.test.ts test/editor.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full suite (regression check)**

Run: `npm test`
Expected: all suites PASS, including every other `setMd`/`getMd` round-trip case in `test/editor.test.ts` and `test/markdown.test.ts` — `preserveIndent` is a no-op for any line with no leading space, so unrelated content is untouched.

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/core/markdown.ts src/ui/editor.ts test/markdown.test.ts test/editor.test.ts
git commit -m "feat: Tab/Shift+Tab same-line indent in free-text editors"
```

---

## Final Verification

- [ ] Run `npm run build` — confirms both `dist/app.html` and `dist/pwa/` still bundle cleanly with no new runtime dependency.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint` one more time, all green.
- [ ] Manually smoke-test in a browser (`npm run build` then open `dist/app.html`, or run the app's existing dev flow): open a file, confirm the filename shows in the header and the save indicator shows `✓ HH:MM` after a save; right-click an action item card / risk row / milestone row and exercise Duplicate/Copy/Move; open Settings → Tags with 2+ teams and cross-apply; press Tab/Shift+Tab inside a daily note under a bullet.
