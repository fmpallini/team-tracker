# Two-Month Calendar: Decoupled Anchor + Top-Only Nav Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the daily-notes two-month calendar from re-centering the displayed month pair every time a date already visible in either grid is picked, and move month-navigation arrows so only the top (previous-month) header has them.

**Architecture:** `src/ui/calendar.ts` already renders two full month blocks (header+weekdays+grid) stacked, sharing one `viewYear`/`viewMonth` state. Two independent changes to that state's contract:

1. Split "which date is highlighted" (`selected`, unchanged) from "which month pair is displayed" (`viewYear`/`viewMonth`, currently always derived from `selected`). A new optional `anchor` opt seeds the latter independently. The caller (`src/modules/daily-notes.ts`) decides, on each mount, whether to reuse the previous anchor or fall back to the newly opened date — reusing it whenever that date's month is already one of the two displayed months. Since `withDisposal` (`src/modules/lifecycle.ts`) tears down and rebuilds `renderDailyNotes`'s entire closure on every pane navigation (see its own doc comment), this "previous anchor" can't live in a local variable — it's tracked in a module-level `WeakMap<Store, Map<0 | 1, string>>`, mirroring `src/ui/panes.ts`'s existing `layoutsByStore` pattern so it never leaks between documents (each file open gets a fresh `Store`).
2. `buildHeader()` in `calendar.ts` gains a `withNav` flag; in two-month mode only the top (previous-month) header gets it, the bottom (current-month) header renders label-only.

**Tech Stack:** TypeScript, vitest (jsdom), no new runtime dependencies.

## Global Constraints

- Zero runtime dependencies — this plan adds no `package.json` dependencies (dev or runtime).
- Every `src/**/*.ts` module keeps a matching `test/*.test.ts` (`CLAUDE.md` convention, now enforced by `.githooks/pre-push`'s "Test coverage sanity" gate for new files) — no new files are created here, only existing modules/tests extended, so this is automatically satisfied.
- Use the Bash tool (Git Bash) for shell commands in this repo, not PowerShell — the `rtk` hook only wires up Bash.
- Run `npm run lint`, `npm run typecheck`, and `npx vitest run` before considering any task done.
- Comments that document nontrivial concurrency/lifecycle reasoning already exist for the `withDisposal` remount behavior this plan relies on (`src/modules/lifecycle.ts`) — don't duplicate that explanation, just reference it.

---

### Task 1: `isWithinTwoMonthWindow` date helper

**Files:**
- Modify: `src/core/date.ts`
- Test: `test/date.test.ts`

**Interfaces:**
- Produces: `export function yearMonthOf(iso: string): { year: number; month: number }` and `export function isWithinTwoMonthWindow(anchorIso: string, candidateIso: string): boolean` — both consumed by Task 4 (`src/modules/daily-notes.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `test/date.test.ts` (after the existing `describe('nowHHMM', ...)` block):

```ts
describe('isWithinTwoMonthWindow', () => {
  test('same month as anchor -> true', () => {
    expect(isWithinTwoMonthWindow('2026-07-01', '2026-07-31')).toBe(true)
  })

  test('exactly one month before anchor -> true', () => {
    expect(isWithinTwoMonthWindow('2026-07-15', '2026-06-01')).toBe(true)
  })

  test('one month after anchor -> false', () => {
    expect(isWithinTwoMonthWindow('2026-07-15', '2026-08-01')).toBe(false)
  })

  test('two months before anchor -> false', () => {
    expect(isWithinTwoMonthWindow('2026-07-15', '2026-05-15')).toBe(false)
  })

  test('handles year rollover: December is "one month before" a January anchor', () => {
    expect(isWithinTwoMonthWindow('2026-01-10', '2025-12-25')).toBe(true)
  })

  test('same year/month, different day -> true regardless of day', () => {
    expect(isWithinTwoMonthWindow('2026-07-01', '2026-07-31')).toBe(true)
  })
})
```

Also update the top-of-file import to include the two new names:

```ts
import { pad2, addDaysIso, diffDays, formatHHMM, nowHHMM, isWithinTwoMonthWindow } from '../src/core/date'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/date.test.ts`
Expected: FAIL — `isWithinTwoMonthWindow is not a function` (or a TS error from the import if run through `npm run typecheck` first).

- [ ] **Step 3: Implement the helper**

Append to `src/core/date.ts` (after `nowHHMM`):

```ts
/** `{ year, month }` (month is 1-12) parsed from an ISO date "YYYY-MM-DD"; ignores the day. */
export function yearMonthOf(iso: string): { year: number; month: number } {
  const [year, month] = iso.split('-').map(Number) as [number, number]
  return { year, month }
}

/**
 * True when `candidateIso`'s month is the same as `anchorIso`'s, or exactly
 * one calendar month before it (handles year rollover: a January anchor's
 * "one month before" is the prior December). Used by the daily-notes
 * two-month calendar (src/modules/daily-notes.ts) to decide whether opening
 * a new date should shift the displayed month pair or leave it as-is because
 * the date is already visible in one of the two currently-shown grids.
 */
export function isWithinTwoMonthWindow(anchorIso: string, candidateIso: string): boolean {
  const a = yearMonthOf(anchorIso)
  const c = yearMonthOf(candidateIso)
  const diffMonths = (c.year - a.year) * 12 + (c.month - a.month)
  return diffMonths === 0 || diffMonths === -1
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/date.test.ts`
Expected: PASS, all tests including the 6 new ones.

- [ ] **Step 5: Lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/date.ts test/date.test.ts
git commit -m "$(cat <<'EOF'
feat(date): add isWithinTwoMonthWindow helper

Pure date-math groundwork for decoupling the daily-notes two-month
calendar's displayed month pair from the currently-selected date.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `calendar.ts` — independent `anchor` opt

**Files:**
- Modify: `src/ui/calendar.ts`
- Test: `test/calendar.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1 (this task doesn't call `isWithinTwoMonthWindow` — that's Task 4's job).
- Produces: `createCalendar(opts)` gains `anchor?: string` — when set, `viewYear`/`viewMonth` initialize from `anchor` instead of `selected`; `selected` keeps its existing sole purpose (which day gets `.tt-calendar-day-selected`). Consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

In `test/calendar.test.ts`, inside the existing `describe('createCalendar showPrevMonth', ...)` block (it already defines a local `monthLabels(root)` helper this reuses), add two tests right after the `'renders a labeled previous-month header/weekdays/grid above the current one'` test:

```ts
  test('defaults the displayed month pair to selected when anchor is omitted', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {}, showPrevMonth: true })
    expect(monthLabels(root)).toEqual(['June 2026', 'July 2026'])
  })

  test('anchor controls the displayed month pair independently of selected', () => {
    const root = createCalendar({
      selected: '2026-06-10', anchor: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {}, showPrevMonth: true,
    })
    expect(monthLabels(root)).toEqual(['June 2026', 'July 2026'])

    const topGrid = root.querySelectorAll('.tt-calendar-grid')[0]!
    const selectedBtn = Array.from(topGrid.querySelectorAll('.tt-calendar-day')).find((b) =>
      b.classList.contains('tt-calendar-day-selected')
    )
    expect(selectedBtn?.firstChild?.textContent).toBe('10')
  })
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `npx vitest run test/calendar.test.ts`
Expected: the `'anchor controls...'` test FAILs — `monthLabels(root)` returns `['May 2026', 'June 2026']` (derived from `selected`, ignoring the unused `anchor` opt) instead of `['June 2026', 'July 2026']`. The `'defaults...'` test already passes (it's today's behavior) — that's fine, it's a regression guard, not new behavior.

- [ ] **Step 3: Implement the opt**

In `src/ui/calendar.ts`, update the opts type and the view initialization:

```ts
export function createCalendar(opts: {
  selected: string
  locale: Locale
  marks: CalendarMarks
  onPick(dateIso: string): void
  /** Also render a non-navigable grid for the month before the displayed one, stacked above it (Task: daily-notes two-month view). */
  showPrevMonth?: boolean
  /** ISO date whose month seeds the displayed pair; defaults to `selected`. Lets a caller keep the same two months on screen across a re-mount even when `selected` moves to a different (but still visible) month — see daily-notes.ts's calendarAnchorByPane. */
  anchor?: string
}): HTMLElement {
  const initial = parseIso(opts.anchor ?? opts.selected)
  let viewYear = initial.y
  let viewMonth = initial.m // 1-12
```

(Only the `anchor` field and the `parseIso(opts.anchor ?? opts.selected)` line change — everything else in the function is untouched by this task.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/calendar.test.ts`
Expected: PASS, full file.

- [ ] **Step 5: Lint + typecheck**

Run: `npm run lint && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/ui/calendar.ts test/calendar.test.ts
git commit -m "$(cat <<'EOF'
feat(calendar): decouple displayed month pair from selected date

createCalendar gains an optional `anchor` opt that seeds the
viewYear/viewMonth pair independently of `selected` (which keeps its
existing sole job: which day gets highlighted). Groundwork for
daily-notes.ts to stop re-centering the two-month view on every pick.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `calendar.ts` — nav arrows only on the top header

**Files:**
- Modify: `src/ui/calendar.ts`
- Test: `test/calendar.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: in two-month mode (`showPrevMonth: true`), only the previous-month (top) header renders `.tt-calendar-nav-btn` elements; the current-month (bottom) header renders its label only. Single-month mode (`showPrevMonth` falsy, `date-picker.ts`'s usage) is unaffected — its one header keeps both arrows.

- [ ] **Step 1: Update the tests**

In `test/calendar.test.ts`'s `describe('createCalendar showPrevMonth', ...)` block:

Delete this test entirely (the button it clicks no longer exists after this task):

```ts
  test('navigating › from the current-month header shifts both labels', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {}, showPrevMonth: true })
    navBtns(root)[3]!.click() // current month's ›

    expect(monthLabels(root)).toEqual(['July 2026', 'August 2026'])
  })
```

Replace the remaining `'navigating › from the previous-month header shifts both labels the same way'` test with:

```ts
  test('nav arrows appear only on the previous-month (top) header', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {}, showPrevMonth: true })
    const headers = root.querySelectorAll('.tt-calendar-header')
    expect(headers).toHaveLength(2)
    expect(headers[0]!.querySelectorAll('.tt-calendar-nav-btn')).toHaveLength(2)
    expect(headers[1]!.querySelectorAll('.tt-calendar-nav-btn')).toHaveLength(0)
  })

  test('navigating › (the only nav arrows, on the top header) shifts both labels', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {}, showPrevMonth: true })
    navBtns(root)[1]!.click() // top header's ›

    expect(monthLabels(root)).toEqual(['July 2026', 'August 2026'])
  })
```

Also update the single-month regression test in `describe('createCalendar month navigation', ...)` — no change needed there; it already targets the lone header's own arrows via `.tt-calendar-nav-btn:last-of-type`, and single-month mode keeps its arrows. Leave that block untouched.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/calendar.test.ts`
Expected: `'nav arrows appear only on the previous-month (top) header'` FAILs — `headers[1]` (current-month/bottom) currently has 2 nav buttons, not 0.

- [ ] **Step 3: Implement**

In `src/ui/calendar.ts`, change `buildHeader` to take a `withNav` flag:

```ts
  function buildHeader(label: string, withNav: boolean): HTMLElement {
    const prevBtn = withNav
      ? el(
          'button',
          { class: 'tt-btn tt-calendar-nav-btn', type: 'button', title: t(opts.locale, 'calendar_prev_month_title'), onclick: goPrevMonth },
          '‹'
        )
      : null
    const nextBtn = withNav
      ? el(
          'button',
          { class: 'tt-btn tt-calendar-nav-btn', type: 'button', title: t(opts.locale, 'calendar_next_month_title'), onclick: goNextMonth },
          '›'
        )
      : null
    return el(
      'div',
      { class: 'tt-calendar-header' },
      prevBtn,
      el('span', { class: 'tt-calendar-month-label' }, label),
      nextBtn
    )
  }
```

And in `render()`, pass `withNav` per header — the bottom (current-month) header loses nav only when `showPrevMonth` is on (single-month mode keeps its one header fully navigable); the top header is always `withNav: true`:

```ts
  function render(): void {
    root.innerHTML = ''

    const header = buildHeader(monthLabel(viewYear, viewMonth), !opts.showPrevMonth)
    const weekdaysRow = buildWeekdaysRow()
    const grid = buildGrid(viewYear, viewMonth)

    if (opts.showPrevMonth) {
      let prevMonth = viewMonth - 1
      let prevYear = viewYear
      if (prevMonth < 1) { prevMonth = 12; prevYear -= 1 }

      const prevHeader = buildHeader(monthLabel(prevYear, prevMonth), true)
      const prevWeekdaysRow = buildWeekdaysRow()
      const prevGrid = buildGrid(prevYear, prevMonth)

      root.append(
        prevHeader, prevWeekdaysRow, prevGrid,
        el('div', { class: 'tt-calendar-divider' }),
        header, weekdaysRow, grid
      )
    } else {
      root.append(header, weekdaysRow, grid)
    }
  }
```

(Only the two `buildHeader(...)` call sites' second argument and the function signature/body change — the rest of `render()` is untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/calendar.test.ts`
Expected: PASS, full file.

- [ ] **Step 5: Manual sanity check in daily-notes.test.ts / panes.test.ts**

Run: `npx vitest run test/daily-notes.test.ts test/panes.test.ts`
Expected: still PASS — those tests click days via grids, not header nav buttons, so this task shouldn't touch them. If either fails, it means a test was relying on the bottom header's arrows existing (grep for `.tt-calendar-nav-btn` in those two files first if so).

- [ ] **Step 6: Lint + typecheck**

Run: `npm run lint && npm run typecheck`

- [ ] **Step 7: Commit**

```bash
git add src/ui/calendar.ts test/calendar.test.ts
git commit -m "$(cat <<'EOF'
feat(calendar): move month-nav arrows onto the top header only

In two-month mode both headers had their own ‹/› pair, both driving
the same shared view state — redundant and mildly confusing about
which one just moved. Only the top (previous-month) header keeps nav
now; the bottom (current-month) header is label-only. Single-month
mode (date-picker.ts) is unaffected.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `daily-notes.ts` — per-pane anchor persistence across remounts

**Files:**
- Modify: `src/modules/daily-notes.ts`
- Test: `test/daily-notes.test.ts`

**Interfaces:**
- Consumes: `isWithinTwoMonthWindow(anchorIso, candidateIso): boolean` from `src/core/date.ts` (Task 1); `createCalendar`'s `anchor?: string` opt (Task 2).
- Produces: nothing new for later tasks — this is the last functional task.

**Context the implementer needs:** `renderDailyNotes` is wrapped in `withDisposal` (`src/modules/lifecycle.ts`), which — on every single call, including every same-pane navigation to a different date — tears down the *previous* mounted instance (running its returned teardown) before invoking the render function fresh. So a plain `let` inside `renderDailyNotes` cannot remember anything across a pick; it's gone the instant the user navigates. State that must survive a remount has to live outside the function, scoped so it doesn't leak between different open documents. `src/ui/panes.ts` already solves the identical problem for a different piece of transient state with `const layoutsByStore = new WeakMap<Store, PaneLayout>()` (see its doc comment) — this task follows the same pattern, keyed by `Store` (fresh per file open, per `main.ts`'s `onDocumentOpened`) and then by pane index.

- [ ] **Step 1: Write the failing tests**

Append to `test/daily-notes.test.ts` (after the existing `describe('renderDailyNotes', ...)` tests, as a new top-level `describe`):

```ts
describe('two-month calendar anchor persistence', () => {
  function monthLabels(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('.tt-calendar-month-label')).map((e) => e.textContent ?? '')
  }

  test('picking a day already visible in the previous-month grid does not recenter the displayed months', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team, '2026-07-15')
    render(container, loc, store, pm, 0)
    expect(monthLabels(container)).toEqual(['June 2026', 'July 2026'])

    // Simulates what src/ui/panes.ts's renderBody does after pm.openInPane:
    // tears down and remounts renderDailyNotes with the newly picked date, on
    // the same store/pane — real production remount semantics (withDisposal
    // runs on every renderDailyNotes call), just without the full PaneManager.
    render(container, { teamId: team.id, ref: { kind: 'daily', date: '2026-06-10' } }, store, pm, 0)

    expect(monthLabels(container)).toEqual(['June 2026', 'July 2026'])
  })

  test('opening a day outside the displayed window recenters the pair around it', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team, '2026-07-15')
    render(container, loc, store, pm, 0)

    render(container, { teamId: team.id, ref: { kind: 'daily', date: '2026-10-05' } }, store, pm, 0)

    expect(monthLabels(container)).toEqual(['September 2026', 'October 2026'])
  })

  test('each pane tracks its own anchor independently', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team, '2026-07-15')
    const container2 = document.createElement('div')
    document.body.appendChild(container2)

    render(container, loc, store, pm, 0)
    render(container2, { teamId: team.id, ref: { kind: 'daily', date: '2026-03-01' } }, store, pm, 1)

    // Pane 0 re-anchors around July, unaffected by pane 1's March anchor.
    render(container, { teamId: team.id, ref: { kind: 'daily', date: '2026-06-20' } }, store, pm, 0)
    expect(monthLabels(container)).toEqual(['June 2026', 'July 2026'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/daily-notes.test.ts`
Expected: the first and third new tests FAIL — today, every remount re-derives the view from `selected` alone, so picking June 10th recenters to `['May 2026', 'June 2026']` instead of staying on `['June 2026', 'July 2026']`. The second test (`'opening a day outside the displayed window recenters...'`) already PASSes today — it's a regression guard for existing behavior, not new behavior.

- [ ] **Step 3: Implement**

In `src/modules/daily-notes.ts`, update the import line to add `isWithinTwoMonthWindow` and a type-only `Store` import:

```ts
import type { Loc, Team } from '../core/types'
import { t, todayIso } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { createRichEditorBundle } from '../ui/rich-editor'
import { createCalendar, type CalendarMarks } from '../ui/calendar'
import { nowHHMM, isWithinTwoMonthWindow } from '../core/date'
import { findTeam as docFindTeam } from '../core/document'
import { scopeAffects, type Section } from '../core/scope'
import type { Store } from '../core/store'
import { el } from '../ui/dom'
import { withDisposal } from './lifecycle'
```

Add module-level state and a resolver function, right after `findTeam` and before `renderDailyNotes`:

```ts
/**
 * Per-store, per-pane "which month pair the two-month calendar is anchored
 * to". `withDisposal` (lifecycle.ts) tears down and rebuilds
 * `renderDailyNotes`'s whole closure on every pane navigation — including a
 * pick on this very calendar — so this can't live in a local variable; it
 * has to survive the remount. Keyed by Store (main.ts's onDocumentOpened
 * creates a fresh one per file open, mirroring panes.ts's layoutsByStore)
 * so it never leaks state from a previously-closed document.
 */
const calendarAnchorByPane = new WeakMap<Store, Map<0 | 1, string>>()

/**
 * Reuses the pane's previous anchor if `date` is already visible under it
 * (see isWithinTwoMonthWindow), so picking a date already shown in either
 * grid doesn't re-center the pair — only the highlighted day moves. Falls
 * back to `date` itself (today's behavior) the first time a pane opens, or
 * whenever the newly-opened date falls outside the currently displayed pair.
 */
function resolveCalendarAnchor(store: Store, paneIdx: 0 | 1, date: string): string {
  let panes = calendarAnchorByPane.get(store)
  if (!panes) {
    panes = new Map()
    calendarAnchorByPane.set(store, panes)
  }
  const prevAnchor = panes.get(paneIdx)
  const anchor = prevAnchor && isWithinTwoMonthWindow(prevAnchor, date) ? prevAnchor : date
  panes.set(paneIdx, anchor)
  return anchor
}
```

In `renderDailyNotes`, compute the anchor once per mount (right after `const lc = ctx.locale`) and pass it into `createCalendar`:

```ts
  const date = loc.ref.date
  const teamId = loc.teamId
  const lc = ctx.locale
  const anchor = resolveCalendarAnchor(ctx.store, ctx.paneIdx, date)
```

```ts
      createCalendar({
        selected: date,
        anchor,
        locale: lc,
        marks: buildMarks(),
        showPrevMonth: true,
        onPick: (pickedDate) => {
          ctx.pm.openInPane(ctx.paneIdx, { teamId, ref: { kind: 'daily', date: pickedDate } })
        },
      })
```

(`anchor` is computed once at the top of `renderDailyNotes` and reused by every `rebuildCalendar()` call within that mount — including the ones triggered later by the `store.subscribe` callback further down, which must keep the same anchor since the date hasn't changed, only marks.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/daily-notes.test.ts`
Expected: PASS, full file (all pre-existing tests plus the 3 new ones).

- [ ] **Step 5: Full regression sweep**

Run: `npx vitest run test/calendar.test.ts test/daily-notes.test.ts test/panes.test.ts test/date-picker.test.ts test/date.test.ts`
Expected: all PASS — `panes.test.ts`'s existing "daily-notes calendar click in each split pane... independently of the other pane" test exercises the real `PaneManager` + real remount and must keep passing unchanged.

- [ ] **Step 6: Lint + typecheck**

Run: `npm run lint && npm run typecheck`

- [ ] **Step 7: Commit**

```bash
git add src/modules/daily-notes.ts test/daily-notes.test.ts
git commit -m "$(cat <<'EOF'
feat(daily-notes): stop recentering the calendar on same-window picks

Picking a date already visible in either grid of the two-month
calendar no longer shifts the displayed month pair — only the
highlighted day moves. The pane's last-shown anchor month is tracked
in a WeakMap<Store, Map<paneIdx, anchor>> (mirroring panes.ts's
layoutsByStore) since withDisposal rebuilds renderDailyNotes's whole
closure on every navigation, including calendar picks themselves.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Full verification sweep

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Full lint + typecheck + test run**

Run: `npm run lint && npm run typecheck && npx vitest run`
Expected: all green, 0 failures.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `built dist/app.html and dist/pwa/index.html (+ manifest, sw.js, icon.svg)` with no errors.

- [ ] **Step 3: Manual smoke check (optional but recommended given this is a UI interaction change)**

Open `dist/app.html` via `file://`, create/open a test doc, open a daily note, and confirm:
- Two month grids stack, top has ‹/› arrows, bottom has a label only.
- Clicking a day in the top grid opens that note and the two visible months stay the same (no jump).
- Clicking the top's › a few times, then clicking Today, recenters back around today.

- [ ] **Step 4: No commit needed**

This task only verifies work already committed in Tasks 1–4.

---

## Self-Review Notes

- **Spec coverage:** Rule 1 (decouple selected/anchor, don't recenter on same-window picks) → Tasks 1, 2, 4. Rule 2 (arrows only on top header) → Task 3. Both explicitly requested by the user; no gaps.
- **Type consistency:** `anchor?: string` (Task 2) is the exact name Task 4 passes as a shorthand property (`anchor,`) into `createCalendar`. `isWithinTwoMonthWindow(anchorIso: string, candidateIso: string): boolean` (Task 1) is called in Task 4 as `isWithinTwoMonthWindow(prevAnchor, date)` — argument order matches (anchor first, candidate second). `resolveCalendarAnchor(store: Store, paneIdx: 0 | 1, date: string): string` — `ctx.store`/`ctx.paneIdx` types from `ModuleCtx` (`src/ui/panes.ts`) match `Store`/`0 | 1` exactly.
- **No placeholders:** every step has literal code, not a description of code.
