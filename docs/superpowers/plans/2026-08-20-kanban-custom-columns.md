# Kanban Custom Middle Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each team add/remove/rename/reorder its own kanban middle columns (today only a hardcoded "WIP"), while Todo (start) and Done+Cancelled (end) stay fixed.

**Architecture:** `Team` gains a per-team `actionColumns: ActionColumn[]` array (optional field, `undefined`/`[]` behaves as "no middle columns" — same convention as `actionTagNames`). `ActionItem.status` widens from a closed union to `string`, so a card's status is just a column id (fixed `'todo'`/`'done'`/`'cancelled'`, or a custom column's uuid). `action-items.ts`'s board renderer rebuilds its whole column skeleton (headers + bodies) on every `renderAll()`, matching this codebase's existing "full rebuild is simplest and correct" convention (`people-tree.ts`, `milestones.ts`, `risks.ts`) — column rename's live `<input>` reuses `ui/dom.ts`'s `createDeferredRebuild`, the same mechanism `milestones.ts`/`risks.ts` already use to protect an in-progress edit from a foreign rebuild.

**Tech Stack:** TypeScript, esbuild, Vitest + jsdom, no runtime dependencies (per `CLAUDE.md`).

**Spec:** [docs/superpowers/specs/2026-08-20-kanban-custom-columns-design.md](../specs/2026-08-20-kanban-custom-columns-design.md)

## Global Constraints

- Zero runtime dependencies — every change here is `src`/`test` only, no new packages.
- Every user-visible string goes through `t(locale, key)`; add matching `pt-BR` and `en-US` keys together (`src/core/i18n.ts`).
- `SCHEMA_VERSION` bump requires a new `MIGRATIONS[n]` entry in `src/core/document.ts` — never mutate old entries.
- Any store mutation goes through `ctx.store.update(fn, scope?)`, never direct `Doc` mutation outside a `store.update` callback.
- Bash tool (Git Bash), not PowerShell, for shell commands in this repo (per `CLAUDE.md`).
- Run `npm run typecheck` and `npx vitest run <file>` after each task; don't move on with either red.

---

## Task 1: Data model + migration 13

**Files:**
- Modify: `src/core/types.ts:27-52` (add `ActionColumn`, widen `ActionItem.status`, add `Team.actionColumns`)
- Modify: `src/core/document.ts:5, 27-44, 50-128` (bump `SCHEMA_VERSION`, seed `createEmptyTeam`, add migration 13)
- Test: `test/document.test.ts`

**Interfaces:**
- Produces: `export interface ActionColumn { id: string; name: string; order: number }` (types.ts); `Team.actionColumns?: ActionColumn[]`; `ActionItem.status: string`; migration step `13` in `document.ts`'s `MIGRATIONS`.

- [ ] **Step 1: Write the failing migration test**

Add to `test/document.test.ts`, after the existing `v11 → v12` block:

```ts
describe('v12 → v13 migration (per-team custom kanban columns)', () => {
  it('seeds a single WIP actionColumns entry, named from the doc\'s own locale, leaving existing wip items untouched', () => {
    const d = createEmptyDocument('pt-BR') as any
    d.schemaVersion = 12
    d.teams = [{
      id: 't1', name: 'T', emoji: '🙂', dailyNotes: {},
      stakeholders: [], members: [],
      actionItems: [{ id: 'a1', summary: 'x', notes: '', status: 'wip', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
      milestones: [], risks: [],
    }]
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.teams[0]!.actionColumns).toEqual([{ id: 'wip', name: 'Em Andamento', order: 0 }])
    expect(doc.teams[0]!.actionItems[0]!.status).toBe('wip') // untouched — 'wip' already matches the seeded column's id
  })

  it('uses the English default name when the doc\'s locale is en-US', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 12
    d.teams = [{ id: 't1', name: 'T', emoji: '🙂', dailyNotes: {}, stakeholders: [], members: [], actionItems: [], milestones: [], risks: [] }]
    const doc = migrate(d)
    expect(doc.teams[0]!.actionColumns).toEqual([{ id: 'wip', name: 'WIP', order: 0 }])
  })

  it('leaves an existing actionColumns array untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 12
    d.teams = [{
      id: 't1', name: 'T', emoji: '🙂', dailyNotes: {}, stakeholders: [], members: [],
      actionItems: [], milestones: [], risks: [],
      actionColumns: [{ id: 'custom-1', name: 'Review', order: 0 }],
    }]
    const doc = migrate(d)
    expect(doc.teams[0]!.actionColumns).toEqual([{ id: 'custom-1', name: 'Review', order: 0 }])
  })
})

test('createEmptyTeam seeds a single default WIP column', () => {
  const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  expect(team.actionColumns).toEqual([{ id: 'wip', name: 'WIP', order: 0 }])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/document.test.ts`
Expected: FAIL — `doc.teams[0].actionColumns` is `undefined`, `SCHEMA_VERSION` is still 12, and the new `createEmptyTeam` assertion fails.

- [ ] **Step 3: Add the type, bump the schema, seed `createEmptyTeam`, add migration 13**

In `src/core/types.ts`, right after `export type ActionItemColor = ...` (line 27):

```ts
export interface ActionColumn { id: string; name: string; order: number }
```

Change line 30 from:

```ts
  status: 'todo' | 'wip' | 'done' | 'cancelled'
```

to:

```ts
  // Any column id: the fixed 'todo'/'done'/'cancelled', or a custom middle
  // column's id from the owning team's actionColumns.
  status: string
```

In the `Team` interface, add next to `actionTagNames?`:

```ts
  actionTagNames?: Partial<Record<ActionItemColor, string>>
  actionColumns?: ActionColumn[]
```

In `src/core/document.ts`, change line 5:

```ts
export const SCHEMA_VERSION = 13
```

In `createEmptyTeam` (around line 32-44), add the seed column:

```ts
export function createEmptyTeam(id: string, name: string, emoji: string, locale: Locale): Team {
  const actionTagNames: Partial<Record<ActionItemColor, string>> = {}
  for (const [color, key] of Object.entries(SUGGESTED_TAG_NAME_KEYS) as [ActionItemColor, MsgKey][]) {
    actionTagNames[color] = t(locale, key)
  }
  return {
    id, name, emoji,
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: {},
    actionTagNames,
    actionColumns: [{ id: 'wip', name: t(locale, 'kanban_wip_default_name'), order: 0 }],
    generalNotes: '',
  }
}
```

Add migration 13, right after the existing `11:` entry in `MIGRATIONS` (before the closing `}` on line 128):

```ts
  13: (d) => {
    const prefs = d.prefs as Record<string, unknown> | undefined
    const locale: Locale = prefs?.locale === 'pt-BR' ? 'pt-BR' : 'en-US'
    for (const team of (d.teams as Record<string, unknown>[]) ?? []) {
      if (!Array.isArray(team.actionColumns)) {
        team.actionColumns = [{ id: 'wip', name: t(locale, 'kanban_wip_default_name'), order: 0 }]
      }
    }
  },
```

This step depends on the `kanban_wip_default_name` i18n key from Task 3 — implement Task 3 first, or add the key inline now (both `t('pt-BR', ...)` → `'Em Andamento'`, `t('en-US', ...)` → `'WIP'`) and let Task 3 fold it in without re-adding.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/document.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors (the `ActionItem.status` widening to `string` doesn't break `due.ts`/`cleanup.ts`, which only compare against string literals)

```bash
git add src/core/types.ts src/core/document.ts test/document.test.ts
git commit -m "feat: add per-team custom kanban columns to the schema (v13)"
```

---

## Task 2: `transferActionItem` gains a `targetStatus` param

**Files:**
- Modify: `src/core/card-transfer.ts:71-83`
- Test: `test/card-transfer.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1 beyond the widened `ActionItem.status: string`.
- Produces: `transferActionItem(teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move', targetStatus?: string): void` — optional (not required) so it type-checks against `TRANSFER_FNS`'s shared signature in Task 11, where `transferMilestone`/`transferRisk` also carry an unused optional 6th param. When supplied, it replaces the copied item's `status` instead of carrying the source team's column id across (which may not exist, or mean something different, on the target team); when omitted, `status` carries over unchanged — today's behavior, kept as a fallback no real call site actually exercises (Task 11's `openItemContextMenu` always supplies a value for action items).

- [ ] **Step 1: Write the failing test**

Add to `test/card-transfer.test.ts`, inside `describe('transferActionItem', ...)`:

```ts
  test('sets the copy\'s status to the passed targetStatus, independent of the source item\'s status', () => {
    const [from, to] = twoTeams()
    transferActionItem([from, to], 'a1', 'from', 'to', 'copy', 'review-col')
    expect(to.actionItems[0]!.status).toBe('review-col')
    expect(from.actionItems[0]!.status).toBe('todo') // source untouched
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/card-transfer.test.ts -t "targetStatus"`
Expected: FAIL with a TypeScript error (too few arguments) or, if TS is lenient at the call site, a runtime mismatch — `to.actionItems[0].status` is `'todo'` (carried over), not `'review-col'`.

- [ ] **Step 3: Add the parameter**

In `src/core/card-transfer.ts`, change:

```ts
export function transferActionItem(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'
): void {
  transferBetweenTeams(
    teams, itemId, fromTeamId, toTeamId, mode, 'action',
    (t) => t.actionItems, (t, list) => { t.actionItems = list },
    (item) => item.summary,
    (to, copy) => {
      copy.notes = stripAllRefs(copy.notes)
      copy.order = to.actionItems.length - 1
    }
  )
}
```

to:

```ts
export function transferActionItem(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move', targetStatus?: string
): void {
  transferBetweenTeams(
    teams, itemId, fromTeamId, toTeamId, mode, 'action',
    (t) => t.actionItems, (t, list) => { t.actionItems = list },
    (item) => item.summary,
    (to, copy) => {
      copy.notes = stripAllRefs(copy.notes)
      if (targetStatus !== undefined) copy.status = targetStatus
      copy.order = to.actionItems.length - 1
    }
  )
}
```

`targetStatus` is optional (not required) so this function's type matches `TRANSFER_FNS`'s shared `Record` signature in Task 11 — `transferMilestone`/`transferRisk` gain the same unused optional 6th param there, since a `Record<K, FnType>` needs one uniform `FnType` across all three. `transferMilestone`/`transferRisk` are otherwise untouched — they have no status/column concept.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/card-transfer.test.ts`
Expected: PASS (including the pre-existing copy/move tests, which now must pass a `targetStatus` — update the two existing calls `transferActionItem([from, to], 'a1', 'from', 'to', 'copy')` / `'move'` to pass `'todo'` as the 6th argument, since the source item's own status was `'todo'` and these tests don't care about the target column)

Update `test/card-transfer.test.ts`'s existing `transferActionItem` calls (in `'copy: appends...'`, `'move: appends...'`, `'move: unlinks dangling refs...'`, `'no-ops when the item id is not found'`) to append `, 'todo'` as the final argument.

- [ ] **Step 5: Typecheck, run full suite, commit**

Run: `npm run typecheck && npx vitest run test/card-transfer.test.ts`
Expected: PASS

```bash
git add src/core/card-transfer.ts test/card-transfer.test.ts
git commit -m "feat: transferActionItem takes an explicit target column"
```

---

## Task 3: i18n keys

**Files:**
- Modify: `src/core/i18n.ts` (pt dict near line 116-146, en dict near line 587-617)

**Interfaces:**
- Produces new `MsgKey`s: `kanban_add_column`, `kanban_rename_column_hint`, `kanban_delete_column_title`, `kanban_delete_column_confirm`, `kanban_delete_column_btn`, `kanban_column_landing_label`, `kanban_status_todo`, `kanban_status_done`, `kanban_status_cancelled`, `kanban_wip_default_name`, `kanban_new_column_default_name`, `kanban_transfer_column_label`.

- [ ] **Step 1: Add the pt-BR keys**

In `src/core/i18n.ts`'s `pt` dict, right after `kanban_add_card: '+ Cartão',` (line 120):

```ts
  kanban_add_column: '+ Coluna',
  kanban_rename_column_hint: 'Clique para renomear',
  kanban_delete_column_title: 'Excluir coluna',
  kanban_delete_column_confirm: 'Mover todos os {count} cartões desta coluna para outra coluna?',
  kanban_delete_column_btn: 'Excluir coluna',
  kanban_column_landing_label: 'Coluna de destino',
  kanban_status_todo: 'A Fazer',
  kanban_status_done: 'Concluído',
  kanban_status_cancelled: 'Cancelado',
  kanban_wip_default_name: 'Em Andamento',
  kanban_new_column_default_name: 'Nova coluna',
  kanban_transfer_column_label: 'Coluna',
```

- [ ] **Step 2: Add the matching en-US keys**

In the `en` dict, right after `kanban_add_card: '+ Card',` (line 591):

```ts
  kanban_add_column: '+ Column',
  kanban_rename_column_hint: 'Click to rename',
  kanban_delete_column_title: 'Delete column',
  kanban_delete_column_confirm: 'Move all {count} cards in this column to another column?',
  kanban_delete_column_btn: 'Delete column',
  kanban_column_landing_label: 'Landing column',
  kanban_status_todo: 'To Do',
  kanban_status_done: 'Done',
  kanban_status_cancelled: 'Cancelled',
  kanban_wip_default_name: 'WIP',
  kanban_new_column_default_name: 'New column',
  kanban_transfer_column_label: 'Column',
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS — `en`'s `Record<MsgKey, string>` type-checks only if every key `pt` has is also in `en` (and vice versa via `MsgKey = keyof typeof pt`), so a mismatched key here is a compile error, not a runtime surprise.

- [ ] **Step 4: Commit**

```bash
git add src/core/i18n.ts
git commit -m "feat: add i18n keys for kanban custom columns"
```

---

## Task 4: `moveColumn` pure helper

**Files:**
- Modify: `src/modules/action-items.ts` (add near `moveCard`, after line 75)
- Test: `test/action-items.test.ts` (new `describe('moveColumn', ...)` inside the existing `describe('pure helpers', ...)` block)

**Interfaces:**
- Consumes: `ActionColumn` type from `../core/types` (Task 1).
- Produces: `export function moveColumn(columns: ActionColumn[], draggedId: string, targetId: string | null, position: 'before' | 'after'): void` — mutates `columns` in place, densely renumbering `order`. Column reorder UI (Task 8) calls this.

- [ ] **Step 1: Write the failing tests**

Add inside `test/action-items.test.ts`'s `describe('pure helpers', ...)` block, after the `describe('moveCard', ...)` block closes:

```ts
  describe('moveColumn', () => {
    function col(overrides: Partial<ActionColumn>): ActionColumn {
      return { id: 'c1', name: 'Col', order: 0, ...overrides }
    }

    test('reorders within bounds, renumbering densely', () => {
      const columns = [col({ id: 'a', order: 0 }), col({ id: 'b', order: 1 }), col({ id: 'c', order: 2 })]
      moveColumn(columns, 'c', 'a', 'before')
      expect(columns.slice().sort((x, y) => x.order - y.order).map((c) => c.id)).toEqual(['c', 'a', 'b'])
    })

    test('no-op when the dragged id does not exist', () => {
      const columns = [col({ id: 'a', order: 0 })]
      moveColumn(columns, 'ghost', 'a', 'before')
      expect(columns[0]!.order).toBe(0)
    })

    test('no-op when dropped onto itself', () => {
      const columns = [col({ id: 'a', order: 0 }), col({ id: 'b', order: 1 })]
      moveColumn(columns, 'a', 'a', 'before')
      expect(columns.map((c) => c.order)).toEqual([0, 1])
    })

    test('appends at the end when the target id is null or not found', () => {
      const columns = [col({ id: 'a', order: 0 }), col({ id: 'b', order: 1 })]
      moveColumn(columns, 'a', null, 'after')
      expect(columns.slice().sort((x, y) => x.order - y.order).map((c) => c.id)).toEqual(['b', 'a'])
    })
  })
```

Add `ActionColumn` to the test file's type import: `import type { ActionColumn, ActionItem, Loc, Team } from '../src/core/types'`.
Add `moveColumn` to the test file's function import: `import { renderActionItems, itemsByStatus, isOverdue, computeFlatDropPosition, moveCard, moveColumn } from '../src/modules/action-items'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/action-items.test.ts -t "moveColumn"`
Expected: FAIL — `moveColumn` is not exported.

- [ ] **Step 3: Implement `moveColumn`**

In `src/modules/action-items.ts`, add after `moveCard` (after line 75), and add `ActionColumn` to the top-of-file type import (`import type { ActionColumn, ActionItem, ActionItemColor, Loc, Team } from '../core/types'`):

```ts
/**
 * Reorders `columns` (a team's custom middle columns) by moving `draggedId`
 * to before/after `targetId`, densely renumbering `order`. Single flat list
 * (no status-group split like moveCard's), so this is simpler: one splice,
 * one renumber pass.
 */
export function moveColumn(columns: ActionColumn[], draggedId: string, targetId: string | null, position: 'before' | 'after'): void {
  const dragged = columns.find((c) => c.id === draggedId)
  if (!dragged) return
  if (draggedId === targetId) return
  const rest = columns.filter((c) => c.id !== draggedId).sort((a, b) => a.order - b.order)
  const targetIdx = targetId === null ? -1 : rest.findIndex((c) => c.id === targetId)
  const insertAt = targetIdx === -1 ? rest.length : (position === 'before' ? targetIdx : targetIdx + 1)
  rest.splice(insertAt, 0, dragged)
  rest.forEach((c, idx) => { c.order = idx })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts -t "moveColumn"`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/modules/action-items.ts test/action-items.test.ts
git commit -m "feat: add moveColumn pure helper for kanban column reordering"
```

---

## Task 5: Data-driven column skeleton (no add/rename/delete/reorder UI yet)

Replaces the hardcoded `STATUSES`/`cols` with values computed from the
team's `actionColumns`, and rebuilds the whole board (headers + bodies) on
every `renderAll()` instead of building the 3-column skeleton once. This
task proves the data-driven rendering is behaviorally identical to today's
hardcoded WIP column before any new UI is added on top in Tasks 6-8.

**Files:**
- Modify: `src/modules/action-items.ts:505-507` (`cardsInColumn`), `:649-874` (renderer tail — `STATUSES` through the closing `return`)
- Modify: `test/action-items.test.ts:46-54` (`makeTeam` default fixture)

**Interfaces:**
- Consumes: `Team.actionColumns` (Task 1), `moveColumn` (Task 4, unused until Task 8 but imported now).
- Produces: `let STATUSES: string[]`, `let cols: Map<string, { bodyEl: HTMLElement; zoneEl: HTMLElement }>`, `function rebuildBoard(): void`, `function isFixedStatus(status: string): boolean`, `function statusLabel(status: string, tm: Team | undefined): string` — Tasks 6-8 build on these.

- [ ] **Step 1: Update the test fixture so existing WIP-column tests keep passing**

In `test/action-items.test.ts`, change `makeTeam` (lines 46-54) to seed the same default column migration/`createEmptyTeam` now seed for a real team:

```ts
function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'stk-1', name: 'Carla', role: 'Sponsor', parentId: null, order: 0, notes: '' }],
    members: [{ id: 'mem-1', name: 'Bruno', role: 'Dev', parentId: null, order: 0, notes: '' }],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    actionColumns: [{ id: 'wip', name: 'WIP', order: 0 }],
    ...overrides,
  }
}
```

This is the only fixture change needed — every other `test/*.test.ts` file that builds a bare `Team` object either doesn't render the kanban board at all, or only asserts on generic `.tt-kanban-card` presence (not the WIP column specifically), so `actionColumns` defaulting to `undefined` → `[]` there is harmless (board renders with just Todo | Done+Cancelled, matching the "zero middle columns is a valid state" decision).

- [ ] **Step 2: Run the full existing suite to confirm nothing else broke from the fixture change**

Run: `npx vitest run test/action-items.test.ts`
Expected: still PASS at this point (fixture change alone doesn't change `action-items.ts` yet) — this step is a checkpoint, not a new-code step.

- [ ] **Step 3: Replace `cardsInColumn` (lines 505-507) to read the `Map`**

Change:

```ts
  function cardsInColumn(status: ActionItem['status']): HTMLElement[] {
    return Array.from(cols[status].bodyEl.querySelectorAll<HTMLElement>('.tt-kanban-card'))
  }
```

to:

```ts
  function cardsInColumn(status: string): HTMLElement[] {
    return Array.from(cols.get(status)!.bodyEl.querySelectorAll<HTMLElement>('.tt-kanban-card'))
  }
```

- [ ] **Step 4: Replace the renderer tail (lines 649-874) with the data-driven version**

Replace everything from `const STATUSES = ['todo', 'wip', 'done', 'cancelled'] as const` (line 649) through the final `return () => { ... }` (line 874) with:

```ts
  /** The two ends, never renamed/removed/reordered. */
  function isFixedStatus(status: string): boolean {
    return status === 'todo' || status === 'done' || status === 'cancelled'
  }

  function statusLabel(status: string, tm: Team | undefined): string {
    if (status === 'todo') return t(lc, 'kanban_status_todo')
    if (status === 'done') return t(lc, 'kanban_status_done')
    if (status === 'cancelled') return t(lc, 'kanban_status_cancelled')
    return tm?.actionColumns?.find((c) => c.id === status)?.name ?? ''
  }

  /** Column ids in board order: fixed 'todo', the team's custom columns sorted by order, fixed 'done'/'cancelled'. */
  function statusesFor(tm: Team | undefined): string[] {
    const middle = [...(tm?.actionColumns ?? [])].sort((a, b) => a.order - b.order).map((c) => c.id)
    return ['todo', ...middle, 'done', 'cancelled']
  }

  // Reassigned on every rebuildBoard() call (see below) — read by
  // cardsInColumn/findAdjacentCard above, and by showDropZones/hideDropZones
  // and wireColumnDrop below, always as the latest board shape.
  let STATUSES: string[] = ['todo', 'done', 'cancelled']
  let cols = new Map<string, { bodyEl: HTMLElement; zoneEl: HTMLElement }>()

  const doneCountEl = el('span', {})
  const cancelledCountEl = el('span', {})
  const todoTitleEl = el('span', {})
  const doneCancelTitleEl = el('span', {})

  function showDropZones(): void {
    STATUSES.forEach((s) => cols.get(s)!.zoneEl.classList.add('active'))
    kanbanRootEl.classList.add('dragging')
  }
  function hideDropZones(): void {
    STATUSES.forEach((s) => cols.get(s)!.zoneEl.classList.remove('active', 'drag-over'))
    kanbanRootEl.classList.remove('dragging')
  }

  /** Catches a drop onto empty column space (below the last card, or an empty column) — the case moveCard's `targetId === null` append handles. Card-level drop handlers already stopPropagation() so this never double-fires for a drop that landed on a specific card. */
  function wireColumnDrop(bodyEl: HTMLElement, status: string, zoneEl: HTMLElement): void {
    bodyEl.addEventListener('dragover', (e) => {
      if (draggedId === null) return
      e.preventDefault()
      zoneEl.classList.add('drag-over')
    })
    bodyEl.addEventListener('dragleave', (e) => {
      const related = (e as DragEvent).relatedTarget as Node | null
      if (related && bodyEl.contains(related)) return
      zoneEl.classList.remove('drag-over')
    })
    bodyEl.addEventListener('drop', (e) => {
      e.preventDefault()
      trashEl.classList.remove('active', 'drag-over')
      hideDropZones()
      const srcId = draggedId
      draggedId = null
      if (srcId === null) return
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        moveCard(tm.actionItems, srcId, status, null, 'after')
      }, { teamId, sections: ['actions'] })
    })
  }

  /** Rebuilds the whole board (column headers + bodies, drop zones, add/rename/delete affordances) from the team's current actionColumns. Same "full rebuild is simplest and correct" convention as people-tree.ts's tree — called at the top of renderAll(), below, before that function repopulates each column's cards. */
  function rebuildBoard(): void {
    const tm = findTeam()
    STATUSES = statusesFor(tm)
    cols = new Map(STATUSES.map((s) => [s, {
      bodyEl: el('div', { class: 'tt-kanban-col-body' }),
      zoneEl: el('div', { class: 'tt-kanban-dropzone' }),
    }]))

    const todoColEl = el(
      'div', { class: 'tt-kanban-col' },
      el('div', { class: 'tt-kanban-col-head' }, todoTitleEl,
        el('button', { class: 'tt-btn tt-kanban-add-btn', type: 'button', onclick: () => openEditModal(null, 'todo') }, t(lc, 'kanban_add_card'))),
      el('div', { class: 'tt-kanban-col-body-wrap' }, cols.get('todo')!.bodyEl, cols.get('todo')!.zoneEl)
    )

    const middleColEls = STATUSES.filter((s) => !isFixedStatus(s)).map((id) => {
      const name = tm?.actionColumns?.find((c) => c.id === id)?.name ?? ''
      const nameSpan = el('span', { class: 'tt-kanban-col-name' }, name)
      const headEl = el(
        'div', { class: 'tt-kanban-col-head' },
        nameSpan,
        el('button', { class: 'tt-btn tt-kanban-add-btn', type: 'button', onclick: () => openEditModal(null, id) }, t(lc, 'kanban_add_card'))
      )
      return el('div', { class: 'tt-kanban-col' }, headEl,
        el('div', { class: 'tt-kanban-col-body-wrap' }, cols.get(id)!.bodyEl, cols.get(id)!.zoneEl))
    })

    const doneCancelColEl = el(
      'div', { class: 'tt-kanban-col' },
      el('div', { class: 'tt-kanban-col-head' }, doneCancelTitleEl),
      el('div', { class: 'tt-kanban-zone-label' }, doneCountEl,
        el('button', { class: 'tt-btn tt-kanban-zone-trash', type: 'button', title: t(lc, 'kanban_clear_zone_title'), onclick: () => clearZone('done') }, '🗑')),
      el('div', { class: 'tt-kanban-col-body-wrap' }, cols.get('done')!.bodyEl, cols.get('done')!.zoneEl),
      el('div', { class: 'tt-kanban-divider' }),
      el('div', { class: 'tt-kanban-zone-label' }, cancelledCountEl,
        el('button', { class: 'tt-btn tt-kanban-zone-trash', type: 'button', title: t(lc, 'kanban_clear_zone_title'), onclick: () => clearZone('cancelled') }, '🗑')),
      el('div', { class: 'tt-kanban-col-body-wrap' }, cols.get('cancelled')!.bodyEl, cols.get('cancelled')!.zoneEl)
    )

    boardEl.innerHTML = ''
    boardEl.append(todoColEl, ...middleColEls, doneCancelColEl)
    STATUSES.forEach((s) => wireColumnDrop(cols.get(s)!.bodyEl, s, cols.get(s)!.zoneEl))
  }

  const boardEl = el('div', { class: 'tt-kanban-board' })
  const datalistEl = el('datalist', { id: datalistId })

  const trashEl = el('div', { class: 'tt-kanban-trash' }, '🗑 ', t(lc, 'kanban_trash_hint'))
  trashEl.addEventListener('dragover', (e) => {
    if (draggedId === null) return
    e.preventDefault()
    trashEl.classList.add('drag-over')
  })
  trashEl.addEventListener('dragleave', () => {
    trashEl.classList.remove('drag-over')
  })
  trashEl.addEventListener('drop', (e) => {
    e.preventDefault()
    trashEl.classList.remove('active', 'drag-over')
    hideDropZones()
    const srcId = draggedId
    draggedId = null
    if (srcId === null) return
    const found = items().find((i) => i.id === srcId)
    if (found) requestDelete(found)
  })

  function updateDatalist(tm: Team | undefined): void {
    datalistEl.innerHTML = ''
    const names = tm ? [...tm.stakeholders, ...tm.members].map((p) => p.name) : []
    for (const name of Array.from(new Set(names))) {
      datalistEl.appendChild(el('option', { value: name }))
    }
  }

  function renderAll(): void {
    rebuildBoard()
    const tm = findTeam()
    const today = todayIso()
    const tagNames = tm?.actionTagNames ?? {}
    updateDatalist(tm)
    const byStatus: Record<string, ActionItem[]> = {}
    STATUSES.forEach((s) => { byStatus[s] = [] })
    const counts: Record<ActionItemColor, number> = { slate: 0, brass: 0, sage: 0, rust: 0, plum: 0, ledger: 0 }
    for (const it of tm?.actionItems ?? []) {
      const bucket = byStatus[it.status]
      if (!bucket) continue // its column was deleted elsewhere; ignore until reassigned
      bucket.push(it)
      if (it.color !== null && it.status !== 'done' && it.status !== 'cancelled') counts[it.color]++
    }
    renderTagChips(tagNames, counts)
    for (const s of STATUSES) {
      const group = byStatus[s]!.sort((a, b) => a.order - b.order)
      const visible = activeTagFilter === null ? group : group.filter((i) => i.color === activeTagFilter)
      const bodyEl = cols.get(s)!.bodyEl
      bodyEl.innerHTML = ''
      if (visible.length === 0) bodyEl.appendChild(emptyEl())
      else visible.forEach((it) => bodyEl.appendChild(renderCard(it, today, tagNames)))
    }
    doneCountEl.textContent = t(lc, 'kanban_done_heading', { count: String(byStatus.done!.length) })
    cancelledCountEl.textContent = t(lc, 'kanban_cancelled_heading', { count: String(byStatus.cancelled!.length) })
    todoTitleEl.textContent = t(lc, 'kanban_col_todo', { count: String(byStatus.todo!.length) })
    doneCancelTitleEl.textContent = t(lc, 'kanban_col_done_cancelled', {
      count: String(byStatus.done!.length + byStatus.cancelled!.length),
    })
  }
  renderAll()

  const WATCHED: readonly Section[] = ['teams', ...BACKLINK_SECTIONS]
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    if (openBundle) openBundle.richBundle.editor.refreshRefLabels()
    renderAll()
  })

  const filterLabelEl = el('span', { class: 'tt-kanban-filter-label' }, t(lc, 'kanban_filter_label'))
  const editTagsBtn = el(
    'button',
    { class: 'tt-btn tt-kanban-edit-tags-btn', type: 'button', onclick: () => openEditTagsModal() },
    t(lc, 'kanban_edit_tags_btn')
  )
  const toolbarEl = el('div', { class: 'tt-kanban-toolbar' }, filterLabelEl, tagChipsEl, editTagsBtn)

  const kanbanRootEl = el('div', { class: 'tt-kanban' }, toolbarEl, boardEl, trashEl, datalistEl)
  container.appendChild(kanbanRootEl)
  if (ctx.paneIdx === ctx.store.doc.nav.focusedPane) {
    boardEl.querySelector<HTMLElement>('.tt-kanban-card')?.focus()
  }

  const disposeArrowFallback = installArrowFallbackFocus(ctx, boardEl, '.tt-kanban-card', ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'])

  return () => {
    unsubscribe()
    disposeOpenBundle()
    disposeArrowFallback()
  }
})
```

Also update `findAdjacentCard` (line 518, no body change needed — it already reads `STATUSES`/`cardsInColumn` by closure, which now resolve dynamically) and its signature comment if desired; and change `moveCard`/`itemsByStatus`'s `status: ActionItem['status']` params — no change needed, `ActionItem['status']` now resolves to `string` automatically from Task 1.

Add `moveColumn` to this file's already-present type import list (`ActionColumn` — done in Task 4) — no further import changes needed here.

- [ ] **Step 5: Run the full test file, fix fallout, typecheck, commit**

Run: `npx vitest run test/action-items.test.ts && npm run typecheck`
Expected: PASS. If any test fails on element structure (e.g. a test indexing `container.querySelectorAll('.tt-kanban-col')[1]` expecting the WIP column specifically), the column order is unchanged (Todo, WIP, Done+Cancelled) so indices should still match — investigate and fix root cause (not the assertion) if something differs.

```bash
git add src/modules/action-items.ts test/action-items.test.ts
git commit -m "refactor: make kanban board columns data-driven from Team.actionColumns"
```

---

## Task 6: Add column + inline rename

**Files:**
- Modify: `src/modules/action-items.ts` (extends `rebuildBoard`'s middle-column builder from Task 5, adds `addColumn`/`renameColumn`, deferred-rebuild wiring)
- Test: `test/action-items.test.ts`

**Interfaces:**
- Consumes: `createDeferredRebuild` from `../ui/dom` (new import).
- Produces: `+ Add column` button in the DOM (`.tt-kanban-add-column-btn`), inline-editable column name (`.tt-kanban-col-name`/`.tt-kanban-col-rename-input`).

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `test/action-items.test.ts`, after `describe('renderActionItems — edit tags modal (toolbar)', ...)`:

```ts
describe('renderActionItems — custom columns: add + rename', () => {
  function columnHeads(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('.tt-kanban-col-head'))
  }

  test('"+ Add column" appends a new middle column, focused for immediate rename', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Column')

    expect(store.doc.teams[0]!.actionColumns).toHaveLength(2)
    const added = store.doc.teams[0]!.actionColumns![1]!
    expect(added.name).toBe('New column')
    const input = document.querySelector('.tt-kanban-col-rename-input') as HTMLInputElement
    expect(document.activeElement).toBe(input)
  })

  test('a new column always lands at the right end of the middle zone', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, '+ Column')

    const names = Array.from(container.querySelectorAll('.tt-kanban-col-name')).map((n) => n.textContent)
    expect(names).toEqual(['WIP', 'New column'])
  })

  test('clicking a column name switches it to an editable input pre-filled with the current name', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    ;(container.querySelector('.tt-kanban-col-name') as HTMLElement).click()
    const input = document.querySelector('.tt-kanban-col-rename-input') as HTMLInputElement
    expect(input.value).toBe('WIP')
  })

  test('blurring the rename input commits the new name to the store', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    ;(container.querySelector('.tt-kanban-col-name') as HTMLElement).click()
    const input = document.querySelector('.tt-kanban-col-rename-input') as HTMLInputElement
    input.value = 'In Review'
    input.dispatchEvent(new Event('blur'))

    expect(store.doc.teams[0]!.actionColumns![0]!.name).toBe('In Review')
  })

  test('Enter in the rename input blurs it, committing the same way', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    ;(container.querySelector('.tt-kanban-col-name') as HTMLElement).click()
    const input = document.querySelector('.tt-kanban-col-rename-input') as HTMLInputElement
    input.value = 'In Review'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.doc.teams[0]!.actionColumns![0]!.name).toBe('In Review')
  })

  test('committing an empty name reverts to the previous name instead of storing blank', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    ;(container.querySelector('.tt-kanban-col-name') as HTMLElement).click()
    const input = document.querySelector('.tt-kanban-col-rename-input') as HTMLInputElement
    input.value = '   '
    input.dispatchEvent(new Event('blur'))

    expect(store.doc.teams[0]!.actionColumns![0]!.name).toBe('WIP')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/action-items.test.ts -t "add + rename"`
Expected: FAIL — no `.tt-kanban-add-column-btn`/`.tt-kanban-col-name`/`.tt-kanban-col-rename-input` exist yet.

- [ ] **Step 3: Implement add + inline rename**

In `src/modules/action-items.ts`, change the import line to add `createDeferredRebuild`:

```ts
import { el, blurOnEnter, createDeferredRebuild } from '../ui/dom'
```

Add `pendingColumnFocusId` near `draggedId`'s declaration (around line 92):

```ts
  let draggedId: string | null = null
  let pendingColumnFocusId: string | null = null
```

Add `addColumn`/`renameColumn` near `removeItem` (before `requestDelete`, around line 156):

```ts
  function addColumn(): void {
    const newId = crypto.randomUUID()
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      const existing = tm.actionColumns ?? []
      const maxOrder = existing.length === 0 ? -1 : Math.max(...existing.map((c) => c.order))
      tm.actionColumns = [...existing, { id: newId, name: t(lc, 'kanban_new_column_default_name'), order: maxOrder + 1 }]
    }, { teamId, sections: ['actions'] })
    pendingColumnFocusId = newId
  }

  function renameColumn(columnId: string, name: string): void {
    ctx.store.update((d) => {
      const col = d.teams.find((t2) => t2.id === teamId)?.actionColumns?.find((c) => c.id === columnId)
      if (col) col.name = name
    }, { teamId, sections: ['actions'] })
  }
```

Replace `rebuildBoard`'s `middleColEls` construction (from Task 5) with the rename-capable version, and add the `+ Add column` button after it:

```ts
    const middleColEls = STATUSES.filter((s) => !isFixedStatus(s)).map((id) => {
      const name = tm?.actionColumns?.find((c) => c.id === id)?.name ?? ''
      const nameSpan = el('span', { class: 'tt-kanban-col-name', title: t(lc, 'kanban_rename_column_hint') }, name)
      const nameInput = el('input', {
        type: 'text', class: 'tt-input tt-kanban-col-rename-input', value: name, style: 'display:none',
      }) as HTMLInputElement
      function startRename(): void {
        nameSpan.style.display = 'none'
        nameInput.style.display = ''
        nameInput.focus()
        nameInput.select()
      }
      function commitRename(): void {
        nameInput.style.display = 'none'
        nameSpan.style.display = ''
        const value = nameInput.value.trim()
        if (value !== '' && value !== name) renameColumn(id, value)
      }
      nameSpan.addEventListener('click', startRename)
      nameInput.addEventListener('blur', commitRename)
      nameInput.addEventListener('keydown', blurOnEnter)
      const headEl = el(
        'div', { class: 'tt-kanban-col-head' },
        nameSpan, nameInput,
        el('button', { class: 'tt-btn tt-kanban-add-btn', type: 'button', onclick: () => openEditModal(null, id) }, t(lc, 'kanban_add_card'))
      )
      if (pendingColumnFocusId === id) {
        pendingColumnFocusId = null
        queueMicrotask(startRename) // deferred: the column isn't attached to boardEl yet at this point in rebuildBoard
      }
      return el('div', { class: 'tt-kanban-col' }, headEl,
        el('div', { class: 'tt-kanban-col-body-wrap' }, cols.get(id)!.bodyEl, cols.get(id)!.zoneEl))
    })

    const addColumnBtn = el('button', {
      class: 'tt-btn tt-kanban-add-column-btn', type: 'button', title: t(lc, 'kanban_add_column'),
      onclick: () => addColumn(),
    }, t(lc, 'kanban_add_column'))
```

And change the final `boardEl.append(...)` line to insert it between the middle columns and the fixed end column:

```ts
    boardEl.innerHTML = ''
    boardEl.append(todoColEl, ...middleColEls, addColumnBtn, doneCancelColEl)
```

Finally, guard `renderAll()`'s foreign-update rebuild against wiping an in-progress rename — add a `focusedCaretInput` helper (mirrors `milestones.ts`'s) and wire it into the existing `ctx.store.subscribe` callback:

```ts
  function focusedRenameInput(): HTMLElement | null {
    const active = document.activeElement
    if (!(active instanceof HTMLInputElement) || !boardEl.contains(active)) return null
    return active.classList.contains('tt-kanban-col-rename-input') ? active : null
  }

  const deferredRebuild = createDeferredRebuild(renderAll)

  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    if (openBundle) openBundle.richBundle.editor.refreshRefLabels()
    const active = focusedRenameInput()
    if (active) { deferredRebuild.arm(active); return }
    renderAll()
  })
```

(This replaces the plain `const unsubscribe = ctx.store.subscribe(...)` block from Task 5's Step 4.) Also add `deferredRebuild.dispose()` to the returned teardown:

```ts
  return () => {
    unsubscribe()
    disposeOpenBundle()
    disposeArrowFallback()
    deferredRebuild.dispose()
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/modules/action-items.ts test/action-items.test.ts
git commit -m "feat: add-column button and inline column rename on the kanban board"
```

---

## Task 7: Delete column (empty silent, non-empty landing picker)

**Files:**
- Modify: `src/modules/action-items.ts`
- Test: `test/action-items.test.ts`

**Interfaces:**
- Consumes: `statusLabel`, `isFixedStatus`, `STATUSES` (Task 5); `showModal`/`ModalButton`/`ModalHandle` (already imported).
- Produces: `.tt-kanban-col-delete-btn` per middle column; delete modal with `.tt-kanban-column-landing-select`.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('renderActionItems — custom columns: add + rename', ...)` block's sibling, a new block:

```ts
describe('renderActionItems — custom columns: delete', () => {
  function deleteColumnBtn(container: HTMLElement, index = 0): HTMLButtonElement {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('.tt-kanban-col-delete-btn'))[index]!
  }

  test('deletes an empty column immediately, with no confirmation', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    deleteColumnBtn(container).click()

    expect(store.doc.teams[0]!.actionColumns).toHaveLength(0)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('a non-empty column opens a landing-column picker instead of deleting immediately', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', status: 'wip' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    deleteColumnBtn(container).click()

    expect(store.doc.teams[0]!.actionColumns).toHaveLength(1) // not deleted yet
    expect(document.querySelector('.tt-modal-dialog')).not.toBeNull()
    const options = Array.from(document.querySelectorAll<HTMLOptionElement>('.tt-kanban-column-landing-select option')).map((o) => o.textContent)
    expect(options).toEqual(['To Do', 'Done', 'Cancelled']) // every column except the one being deleted
  })

  test('confirming the landing picker moves every card in the deleted column to the chosen target, then removes the column', () => {
    const team = makeTeam({
      actionItems: [item({ id: 'a', status: 'wip', order: 0 }), item({ id: 'b', status: 'wip', order: 1 })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    deleteColumnBtn(container).click()
    const select = document.querySelector('.tt-kanban-column-landing-select') as HTMLSelectElement
    select.value = 'todo'
    clickByTitleOrText(document.body, 'Delete column')

    const items = store.doc.teams[0]!.actionItems
    expect(items.every((i) => i.status === 'todo')).toBe(true)
    expect(new Set(items.map((i) => i.order)).size).toBe(2) // densely renumbered, no collision
    expect(store.doc.teams[0]!.actionColumns).toHaveLength(0)
  })

  test('canceling the landing picker keeps the column and its cards untouched', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', status: 'wip' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    deleteColumnBtn(container).click()
    clickByTitleOrText(document.body, 'Cancel')

    expect(store.doc.teams[0]!.actionColumns).toHaveLength(1)
    expect(store.doc.teams[0]!.actionItems[0]!.status).toBe('wip')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/action-items.test.ts -t "custom columns: delete"`
Expected: FAIL — no `.tt-kanban-col-delete-btn` exists yet.

- [ ] **Step 3: Implement delete-column**

Add `deleteColumn`/`openDeleteColumnModal` near `openEditTagsModal` (before `emptyEl`, around line 493) in `src/modules/action-items.ts`:

```ts
  function deleteColumn(columnId: string): void {
    const count = items().filter((i) => i.status === columnId).length
    if (count === 0) {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (tm?.actionColumns) tm.actionColumns = tm.actionColumns.filter((c) => c.id !== columnId)
      }, { teamId, sections: ['actions'] })
      return
    }
    openDeleteColumnModal(columnId, count)
  }

  function openDeleteColumnModal(columnId: string, count: number): void {
    const tm = findTeam()
    const targets = STATUSES.filter((s) => s !== columnId)
    const select = el('select', { class: 'tt-input tt-kanban-column-landing-select' }) as HTMLSelectElement
    for (const s of targets) select.appendChild(el('option', { value: s }, statusLabel(s, tm)))
    const body = el(
      'div', { class: 'tt-prefs-field' },
      el('p', { class: 'tt-modal-message' }, t(lc, 'kanban_delete_column_confirm', { count: String(count) })),
      el('label', { class: 'tt-field' }, t(lc, 'kanban_column_landing_label'), select)
    )
    const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
    const confirmBtn: ModalButton = {
      label: t(lc, 'kanban_delete_column_btn'),
      danger: true,
      onClick: () => {
        const targetStatus = select.value
        ctx.store.update((d) => {
          const team2 = d.teams.find((t2) => t2.id === teamId)
          if (!team2) return
          const moving = team2.actionItems.filter((i) => i.status === columnId).sort((a, b) => a.order - b.order)
          const destGroup = team2.actionItems.filter((i) => i.status === targetStatus)
          let nextOrder = destGroup.length === 0 ? 0 : Math.max(...destGroup.map((i) => i.order)) + 1
          for (const i of moving) { i.status = targetStatus; i.order = nextOrder++ }
          if (team2.actionColumns) team2.actionColumns = team2.actionColumns.filter((c) => c.id !== columnId)
        }, { teamId, sections: ['actions'] })
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({ title: t(lc, 'kanban_delete_column_title'), body, buttons: [cancelBtn, confirmBtn] })
  }
```

In `rebuildBoard`'s middle-column `headEl` (from Task 6), add the delete button:

```ts
      const headEl = el(
        'div', { class: 'tt-kanban-col-head' },
        nameSpan, nameInput,
        el('button', { class: 'tt-btn tt-kanban-col-delete-btn', type: 'button', title: t(lc, 'kanban_delete_column_title'), onclick: () => deleteColumn(id) }, '🗑'),
        el('button', { class: 'tt-btn tt-kanban-add-btn', type: 'button', onclick: () => openEditModal(null, id) }, t(lc, 'kanban_add_card'))
      )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/modules/action-items.ts test/action-items.test.ts
git commit -m "feat: delete a kanban column, with a landing-column picker when it has cards"
```

---

## Task 8: Column drag-and-drop reorder

**Files:**
- Modify: `src/modules/action-items.ts`
- Test: `test/action-items.test.ts`

**Interfaces:**
- Consumes: `moveColumn` (Task 4).
- Produces: draggable middle-column headers; reorder persists to `Team.actionColumns[].order`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block:

```ts
describe('renderActionItems — custom columns: drag-and-drop reorder', () => {
  function fire(el: HTMLElement, type: string, dataTransfer: Partial<DataTransfer> = {}): void {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent & { dataTransfer: Partial<DataTransfer> }
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    el.dispatchEvent(event)
  }

  test('dragging one middle column header before another persists the new order', () => {
    const team = makeTeam({
      actionColumns: [{ id: 'a', name: 'A', order: 0 }, { id: 'b', name: 'B', order: 1 }, { id: 'c', name: 'C', order: 2 }],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const heads = Array.from(container.querySelectorAll<HTMLElement>('.tt-kanban-col-head'))
    const [todoHead, headA, headB, headC] = heads // eslint-disable-line @typescript-eslint/no-unused-vars

    fire(headC!, 'dragstart', { setData: () => {} })
    fire(headA!, 'dragover')
    fire(headA!, 'drop')

    const ids = store.doc.teams[0]!.actionColumns!.slice().sort((x, y) => x.order - y.order).map((c) => c.id)
    expect(ids).toEqual(['c', 'a', 'b'])
  })

  test('the fixed Todo and Done+Cancelled column headers are not drop targets for a column drag', () => {
    const team = makeTeam({ actionColumns: [{ id: 'a', name: 'A', order: 0 }] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const todoHead = container.querySelector<HTMLElement>('.tt-kanban-col-head')!

    fire(todoHead, 'dragstart', { setData: () => {} })

    expect(todoHead.getAttribute('draggable')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/action-items.test.ts -t "drag-and-drop reorder"`
Expected: FAIL — no drag handlers on column headers yet.

- [ ] **Step 3: Implement column header drag-and-drop**

Add `draggedColumnId` near `draggedId`'s declaration:

```ts
  let draggedId: string | null = null
  let draggedColumnId: string | null = null
  let pendingColumnFocusId: string | null = null
```

Add `wireColumnHeaderDrag` next to `wireColumnDrop` (Task 5):

```ts
  function wireColumnHeaderDrag(headEl: HTMLElement, status: string): void {
    headEl.draggable = true
    headEl.addEventListener('dragstart', (e) => {
      draggedColumnId = status
      ;(e as DragEvent).dataTransfer?.setData('text/plain', status)
    })
    headEl.addEventListener('dragover', (e) => {
      if (draggedColumnId === null || draggedColumnId === status) return
      e.preventDefault()
    })
    headEl.addEventListener('drop', (e) => {
      e.preventDefault()
      const srcId = draggedColumnId
      draggedColumnId = null
      if (srcId === null || srcId === status) return
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm?.actionColumns) return
        moveColumn(tm.actionColumns, srcId, status, 'before')
      }, { teamId, sections: ['actions'] })
    })
  }
```

Call it from `rebuildBoard`'s middle-column builder, right after `headEl` is constructed (Task 7's version), before the `if (pendingColumnFocusId === id)` block:

```ts
      wireColumnHeaderDrag(headEl, id)
```

The fixed Todo/Done+Cancelled headers never call `wireColumnHeaderDrag`, so they're never `draggable` and `draggedColumnId === status` naturally guards against a middle column being dropped onto itself — no extra `isFixedStatus` check needed in the handler bodies since fixed headers simply never become a `dragover`/`drop` target (no listeners attached).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/modules/action-items.ts test/action-items.test.ts
git commit -m "feat: drag-and-drop reorder for kanban middle columns"
```

---

## Task 9: Layout CSS — flexible width + horizontal scroll + affordance styling

**Files:**
- Modify: `styles.css:875-898`

**Interfaces:** none (pure CSS).

- [ ] **Step 1: Replace the board's grid layout with a scrollable flex row**

In `styles.css`, change line 875 from:

```css
.tt-kanban-board { display: grid; grid-template-columns: 1fr 1fr 1.15fr; gap: .75rem; flex: 1; min-height: 0; }
```

to:

```css
.tt-kanban-board { display: flex; gap: .75rem; flex: 1; min-height: 0; overflow-x: auto; }
.tt-kanban-board > .tt-kanban-col { flex: 1 1 220px; min-width: 220px; }
.tt-kanban-board > .tt-kanban-col:last-child { flex: 1.15 1 260px; min-width: 260px; }
```

- [ ] **Step 2: Style the add-column button, rename affordance, and delete button**

Add after the existing `.tt-kanban-add-btn:hover` rule (line 879):

```css
.tt-kanban-add-column-btn {
  flex: none; align-self: flex-start; margin-top: .3rem;
  border: 1px dashed var(--border); background: transparent; color: var(--muted);
  border-radius: 6px; padding: .3rem .6rem; font-size: .82rem; cursor: pointer; white-space: nowrap;
}
.tt-kanban-add-column-btn:hover { color: var(--fg); border-color: var(--accent); }

.tt-kanban-col-name { cursor: pointer; position: relative; padding-right: 1.1rem; }
.tt-kanban-col-name::after {
  content: '✎'; position: absolute; right: 0; top: 0; opacity: 0; font-size: .75rem; transition: opacity .1s ease;
}
.tt-kanban-col-name:hover::after { opacity: .6; }
.tt-kanban-col-rename-input { font: inherit; font-weight: 700; width: 100%; }
.tt-kanban-col-delete-btn { opacity: .5; border: none; background: transparent; cursor: pointer; font-size: .85rem; padding: .1rem .3rem; }
.tt-kanban-col-delete-btn:hover { opacity: 1; }
```

- [ ] **Step 3: Manually verify in the running app**

Run: `npm run build && npx http-server dist -p 8765` (or open `dist/app.html` directly via `file://`)
Expected: open a team's Tasks pane, confirm columns don't collapse below ~220px and the board scrolls horizontally instead once enough middle columns are added; confirm the pencil hint only appears on hover over a column name.

This is a visual check, not an automated test — no new test file for this step.

- [ ] **Step 4: Commit**

```bash
git add styles.css
git commit -m "style: flexible width + horizontal scroll for kanban columns"
```

---

## Task 10: `openTeamColumnPickerModal` (combined team + column picker)

**Files:**
- Modify: `src/ui/team-picker-modal.ts`
- Test: `test/team-picker-modal.test.ts`

**Interfaces:**
- Produces: `export function openTeamColumnPickerModal(opts: { title: string; confirmLabel: string; cancelLabel: string; columnLabel: string; teams: Team[]; getColumns: (team: Team) => { id: string; label: string }[]; onConfirm: (targetTeamId: string, targetStatus: string) => void }): void`

- [ ] **Step 1: Write the failing tests**

Add to `test/team-picker-modal.test.ts`:

```ts
import { openTeamPickerModal, openTeamColumnPickerModal } from '../src/ui/team-picker-modal'

// ... (existing imports/helpers stay)

describe('openTeamColumnPickerModal', () => {
  function columns(t: Team): { id: string; label: string }[] {
    return t.id === 'a' ? [{ id: 'todo', label: 'To Do' }, { id: 'wip', label: 'WIP' }] : [{ id: 'todo', label: 'To Do' }, { id: 'review', label: 'Review' }]
  }

  test('renders a team select and a column select, columns matching the first team by default', () => {
    openTeamColumnPickerModal({
      title: 'Move to which team?', confirmLabel: 'Confirm', cancelLabel: 'Cancel', columnLabel: 'Column',
      teams: [team('a', 'Alpha'), team('b', 'Beta')],
      getColumns: columns,
      onConfirm: () => {},
    })
    const selects = document.querySelectorAll<HTMLSelectElement>('select')
    expect(selects).toHaveLength(2)
    const columnOptions = Array.from(selects[1]!.querySelectorAll('option')).map((o) => o.value)
    expect(columnOptions).toEqual(['todo', 'wip'])
  })

  test('changing the team select repopulates the column select', () => {
    openTeamColumnPickerModal({
      title: 'Move to which team?', confirmLabel: 'Confirm', cancelLabel: 'Cancel', columnLabel: 'Column',
      teams: [team('a', 'Alpha'), team('b', 'Beta')],
      getColumns: columns,
      onConfirm: () => {},
    })
    const [teamSelect, columnSelect] = document.querySelectorAll<HTMLSelectElement>('select')
    teamSelect!.value = 'b'
    teamSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    expect(Array.from(columnSelect!.querySelectorAll('option')).map((o) => o.value)).toEqual(['todo', 'review'])
  })

  test('confirm calls onConfirm with the selected team id and column id, then closes', () => {
    const onConfirm = vi.fn()
    openTeamColumnPickerModal({
      title: 'Move to which team?', confirmLabel: 'Confirm', cancelLabel: 'Cancel', columnLabel: 'Column',
      teams: [team('a', 'Alpha'), team('b', 'Beta')],
      getColumns: columns,
      onConfirm,
    })
    const [teamSelect, columnSelect] = document.querySelectorAll<HTMLSelectElement>('select')
    teamSelect!.value = 'b'
    teamSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    columnSelect!.value = 'review'
    modalButton('Confirm').click()
    expect(onConfirm).toHaveBeenCalledWith('b', 'review')
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/team-picker-modal.test.ts -t "openTeamColumnPickerModal"`
Expected: FAIL — `openTeamColumnPickerModal` doesn't exist.

- [ ] **Step 3: Implement it**

Add to `src/ui/team-picker-modal.ts`, after the existing `openTeamPickerModal`:

```ts
export function openTeamColumnPickerModal(opts: {
  title: string
  confirmLabel: string
  cancelLabel: string
  columnLabel: string
  teams: Team[]
  getColumns: (team: Team) => { id: string; label: string }[]
  onConfirm: (targetTeamId: string, targetStatus: string) => void
}): void {
  const teamSelect = el('select', { class: 'tt-input' }) as HTMLSelectElement
  for (const team of opts.teams) {
    teamSelect.appendChild(el('option', { value: team.id }, team.emoji ? `${team.emoji} ${team.name}` : team.name))
  }
  const columnSelect = el('select', { class: 'tt-input' }) as HTMLSelectElement
  function populateColumns(team: Team): void {
    columnSelect.innerHTML = ''
    for (const c of opts.getColumns(team)) columnSelect.appendChild(el('option', { value: c.id }, c.label))
  }
  populateColumns(opts.teams[0]!)
  teamSelect.addEventListener('change', () => {
    const team = opts.teams.find((t) => t.id === teamSelect.value)
    if (team) populateColumns(team)
  })
  const body = el(
    'div', { class: 'tt-prefs-field' },
    teamSelect,
    el('label', { class: 'tt-field' }, opts.columnLabel, columnSelect)
  )

  const cancelBtn: ModalButton = { label: opts.cancelLabel, onClick: () => handle.close() }
  const confirmBtn: ModalButton = {
    label: opts.confirmLabel,
    primary: true,
    onClick: () => {
      const targetTeamId = teamSelect.value
      const targetStatus = columnSelect.value
      handle.close()
      if (targetTeamId && targetStatus) opts.onConfirm(targetTeamId, targetStatus)
    },
  }
  const handle: ModalHandle = showModal({ title: opts.title, body, buttons: [cancelBtn, confirmBtn] })
}
```

`showModal`'s existing Escape/Tab-trap/Enter/initial-focus handling ([modal.ts](../../../src/ui/modal.ts)) applies automatically — no new keyboard code needed here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/team-picker-modal.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/ui/team-picker-modal.ts test/team-picker-modal.test.ts
git commit -m "feat: add openTeamColumnPickerModal for cross-team card transfer landing column"
```

---

## Task 11: Wire the combined picker into the card context menu (action items only)

**Files:**
- Modify: `src/ui/card-context-menu.ts`
- Test: `test/card-context-menu.test.ts`, `test/action-items.test.ts`

**Interfaces:**
- Consumes: `openTeamColumnPickerModal` (Task 10), `transferActionItem`'s widened signature (Task 2).
- Produces: `showCardContextMenu`'s 8th (optional) param `getColumnsForTeam?: (team: Team) => { id: string; label: string }[]`; `CardContextMenuActions.transfer`'s 4th (optional) param `targetStatus?: string`.

- [ ] **Step 1: Write the failing tests**

Add to `test/card-context-menu.test.ts`:

```ts
test('when getColumnsForTeam is supplied, "Copy to team…" opens the combined team+column picker and transfer receives the chosen column', () => {
  const transfer = vi.fn()
  const teams = [team('T1', 'Alpha'), team('T2', 'Beta')]
  const getColumnsForTeam = () => [{ id: 'todo', label: 'To Do' }, { id: 'review', label: 'Review' }]
  showCardContextMenu(LOCALE, 'T1', teams, 'item-1', 0, 0, { duplicate: vi.fn(), transfer, delete: vi.fn() }, getColumnsForTeam)
  menuItems()[1]!.click() // "Copy to team…"

  const selects = document.querySelectorAll<HTMLSelectElement>('select')
  expect(selects).toHaveLength(2) // team + column, not just team
  selects[0]!.value = 'T2'
  selects[0]!.dispatchEvent(new Event('change', { bubbles: true }))
  selects[1]!.value = 'review'
  modalButton('Confirm').click()

  expect(transfer).toHaveBeenCalledWith('item-1', 'T2', 'copy', 'review')
})

test('without getColumnsForTeam, the plain team-only picker is used (milestones/risks unaffected)', () => {
  const transfer = vi.fn()
  const teams = [team('T1', 'Alpha'), team('T2', 'Beta')]
  showCardContextMenu(LOCALE, 'T1', teams, 'item-1', 0, 0, { duplicate: vi.fn(), transfer, delete: vi.fn() })
  menuItems()[1]!.click()
  expect(document.querySelectorAll('select')).toHaveLength(1)
  modalButton('Confirm').click()
  expect(transfer).toHaveBeenCalledWith('item-1', 'T2', 'copy')
})
```

Add to `test/action-items.test.ts`'s `describe('card context menu', ...)` block:

```ts
  test('"Copy to team…" opens a combined team+column picker whose column list is the target team\'s actionColumns plus the fixed statuses', () => {
    const from = makeTeam({ id: 'from', actionItems: [item({ id: 'a1', order: 0 })] })
    const to = makeTeam({ id: 'to', name: 'Team 2', actionColumns: [{ id: 'review', name: 'Review', order: 0 }] })
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
    const [teamSelect, columnSelect] = document.querySelectorAll<HTMLSelectElement>('select')
    teamSelect!.value = 'to'
    teamSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    expect(Array.from(columnSelect!.querySelectorAll('option')).map((o) => o.value)).toEqual(['todo', 'review', 'done', 'cancelled'])
    columnSelect!.value = 'review'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Confirm')!.click()

    expect(store.doc.teams.find((t) => t.id === 'to')!.actionItems[0]!.status).toBe('review')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/card-context-menu.test.ts test/action-items.test.ts -t "column"`
Expected: FAIL — `showCardContextMenu` doesn't accept a `getColumnsForTeam` param, `transfer` is never called with a 4th argument.

- [ ] **Step 3: Wire it up**

In `src/ui/card-context-menu.ts`, change the imports and `CardContextMenuActions`:

```ts
import { openTeamPickerModal, openTeamColumnPickerModal } from './team-picker-modal'
```

```ts
export interface CardContextMenuActions {
  duplicate(itemId: string): void
  transfer(itemId: string, targetTeamId: string, mode: 'copy' | 'move', targetStatus?: string): void
  delete(itemId: string): void
}
```

Replace `openTransferModal` and `showCardContextMenu`'s signature:

```ts
function openTransferModal(
  locale: Locale, itemId: string, mode: 'copy' | 'move', otherTeams: Team[], actions: CardContextMenuActions,
  getColumnsForTeam?: (team: Team) => { id: string; label: string }[]
): void {
  const title = t(locale, mode === 'copy' ? 'team_picker_copy_title' : 'team_picker_move_title')
  if (getColumnsForTeam) {
    openTeamColumnPickerModal({
      title, confirmLabel: t(locale, 'team_picker_confirm_btn'), cancelLabel: t(locale, 'cancel'),
      columnLabel: t(locale, 'kanban_transfer_column_label'),
      teams: otherTeams, getColumns: getColumnsForTeam,
      onConfirm: (targetTeamId, targetStatus) => actions.transfer(itemId, targetTeamId, mode, targetStatus),
    })
    return
  }
  openTeamPickerModal({
    title, confirmLabel: t(locale, 'team_picker_confirm_btn'), cancelLabel: t(locale, 'cancel'),
    teams: otherTeams,
    onConfirm: (targetTeamId) => actions.transfer(itemId, targetTeamId, mode),
  })
}

export function showCardContextMenu(
  locale: Locale, teamId: string, allTeams: Team[], itemId: string, x: number, y: number, actions: CardContextMenuActions,
  getColumnsForTeam?: (team: Team) => { id: string; label: string }[]
): void {
  const otherTeams = allTeams.filter((tm) => tm.id !== teamId)
  const menuItems: ContextMenuItem[] = [
    { label: t(locale, 'context_menu_duplicate'), onClick: () => actions.duplicate(itemId) },
  ]
  if (otherTeams.length > 0) {
    menuItems.push({ label: t(locale, 'context_menu_copy_to_team'), onClick: () => openTransferModal(locale, itemId, 'copy', otherTeams, actions, getColumnsForTeam) })
    menuItems.push({ label: t(locale, 'context_menu_move_to_team'), onClick: () => openTransferModal(locale, itemId, 'move', otherTeams, actions, getColumnsForTeam) })
  }
  menuItems.push({ label: t(locale, 'context_menu_delete'), danger: true, onClick: () => actions.delete(itemId) })
  showContextMenu(x, y, menuItems)
}
```

Widen `TRANSFER_FNS`'s type and `transferMilestone`/`transferRisk` to accept (and ignore) the optional 6th param, so the `Record` stays uniformly typed. In `src/core/card-transfer.ts`, change:

```ts
export function transferMilestone(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'
): void {
```

to:

```ts
export function transferMilestone(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move', _targetStatus?: string
): void {
```

(same one-line change for `transferRisk`). Then in `src/ui/card-context-menu.ts`:

```ts
const TRANSFER_FNS: Record<CardKind, (teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move', targetStatus?: string) => void> = {
  action: transferActionItem,
  milestone: transferMilestone,
  risk: transferRisk,
}
```

Finally, update `openItemContextMenu` to supply `getColumnsForTeam` for the `'action'` kind only, and pass `targetStatus` through:

```ts
export function openItemContextMenu(ctx: ModuleCtx, kind: CardKind, teamId: string, itemId: string, x: number, y: number, onDelete: () => void): void {
  const getColumnsForTeam = kind === 'action'
    ? (team: Team) => [
        { id: 'todo', label: t(ctx.locale, 'kanban_status_todo') },
        ...[...(team.actionColumns ?? [])].sort((a, b) => a.order - b.order).map((c) => ({ id: c.id, label: c.name })),
        { id: 'done', label: t(ctx.locale, 'kanban_status_done') },
        { id: 'cancelled', label: t(ctx.locale, 'kanban_status_cancelled') },
      ]
    : undefined
  showCardContextMenu(ctx.locale, teamId, ctx.store.doc.teams, itemId, x, y, {
    duplicate: (id) => {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (tm) DUPLICATE_FNS[kind](tm, id)
      })
    },
    transfer: (id, targetTeamId, mode, targetStatus) => {
      ctx.store.update((d) => {
        TRANSFER_FNS[kind](d.teams, id, teamId, targetTeamId, mode, targetStatus)
      })
    },
    delete: () => onDelete(),
  }, getColumnsForTeam)
}
```

Add the `t` import to `card-context-menu.ts` if not already present (it already imports `t, type Locale` from `../core/i18n` — confirm and reuse).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/card-context-menu.test.ts test/action-items.test.ts test/card-transfer.test.ts`
Expected: PASS — including the pre-existing 3-arg `transfer` assertions for milestones/risks, since `getColumnsForTeam` is `undefined` for those kinds and `targetStatus` is never passed.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/ui/card-context-menu.ts src/core/card-transfer.ts test/card-context-menu.test.ts test/action-items.test.ts
git commit -m "feat: cross-team action-item transfer asks for a landing column"
```

---

## Task 12: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS, zero failures across every `test/*.test.ts` file (not just the ones touched above — this catches any fixture ripple this plan's file-structure analysis missed).

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 3: Build both variants**

Run: `npm run build`
Expected: succeeds, produces `dist/app.html` and `dist/pwa/` with no errors.

- [ ] **Step 4: E2E smoke**

Run: `npm run test:e2e`
Expected: PASS — the existing suite doesn't target kanban columns specifically (per the spec's Testing section), so this just confirms the rewritten board doesn't break the file:// smoke path, the FS-API round trip, or tab-lock.

- [ ] **Step 5: Manual migration check**

Open a `.tmv` file saved by the version of this app before this branch (schema ≤ 12) — or, if none is handy, build a quick throwaway one on `main` first. Confirm: the board still shows Todo / WIP / Done+Cancelled exactly as before, the WIP column is now renamable, and a fresh save round-trips (close and reopen) without data loss.

- [ ] **Step 6: Update CHANGELOG.md**

Per `CLAUDE.md`'s changelog convention, add an entry under a new `## [Unreleased]`-style heading (or the next version, per whatever the repo's current in-flight version is) — check `package.json`'s current `version` and `CHANGELOG.md`'s latest entry first to see whether this bundles into an existing unreleased entry or needs a version bump of its own. Describe it user-facing: e.g. under `### Added`, "Kanban board columns between To Do and Done can now be added, renamed, removed, and reordered per team."

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for kanban custom columns"
```
