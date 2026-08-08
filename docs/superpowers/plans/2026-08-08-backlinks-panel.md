# Backlinks Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a small "↩ N" count badge/chip on every person/day/action/milestone/risk that has incoming `@[label](kind:id)` mentions, and let clicking it open a popover listing each mention (grouped by source kind) that navigates there on click.

**Architecture:** A pure `collectBacklinks(team, doc, kind, targetId)` in `core/search.ts` scans the same 6 free-text fields `collectCandidates` already enumerates for search, matching `refPattern(kind)` against each field's *raw* text (not the markdown-stripped copy search uses — stripping already collapses a mention down to its label, destroying the id being matched). No cache: called inline during each module's own render, same as `core/due.ts`'s uncached overdue/due-soon computation. A new `ui/backlinks-panel.ts` renders the chip and, on click, a popover mirroring `ui/context-menu.ts`'s lifecycle (fixed-position, singleton, outside-click/Escape dismiss) with `ui/atref.ts`'s `@` dropdown's grouped-header styling. Row clicks reuse a `navigateToLoc` helper factored out of `ui/atref.ts`'s `makeRefClickHandler`, so backlink navigation and forward-`@ref`-click navigation share one implementation of the secondary-pane pref/modifier routing and item-highlight behavior.

**Tech Stack:** TypeScript, vitest + jsdom, esbuild (via `scripts/build.mjs`) — no new runtime dependencies (zero-dep constraint, see root `CLAUDE.md`).

## Global Constraints

- Zero runtime dependencies — everything below uses only the existing `el()`/`bindOutsideDismiss` DOM helpers and framework-free TypeScript.
- Every `src` module needs a matching `test/*.test.ts`; tests run under vitest+jsdom (`npm test`, or `npx vitest run test/<file>.test.ts` for one file).
- All user-visible strings go through `t(locale, key)` in `core/i18n.ts`; add keys for both `pt-BR` and `en-US` in the same step — `MsgKey = keyof typeof pt` and `dicts: Record<Locale, Record<MsgKey, string>>` make `npm run typecheck` fail if a key is added to only one dict.
- Follow existing patterns exactly: `el()` for DOM construction (`src/ui/dom.ts`), `store.subscribe`/`scopeAffects` for re-render gating, `withDisposal` for module renderers.
- Run `npm run typecheck` and `npm run lint` after each task, not just at the end — every task below assumes a clean baseline going in.

---

### Task 1: `collectBacklinks` in `core/search.ts`

**Files:**
- Modify: `src/core/search.ts:1-4` (imports), and insert new code after `collectCandidates` (currently ends at `src/core/search.ts:109`)
- Test: `test/search.test.ts`

**Interfaces:**
- Consumes: `collectCandidates(team: Team, doc: Doc): Candidate[]` (already defined in this file, not exported — stays unexported, called directly), `refPattern(kind?: RefKind): RegExp` and `type RefKind` from `../core/refs`, `stripMd` (already defined in this file), `SNIPPET_RADIUS` (already defined in this file, currently `80`), `type Section` (already imported in this file from `./scope`).
- Produces (for later tasks): `export const BACKLINK_SECTIONS: readonly Section[]`, `export type BacklinkSourceKind = 'daily' | 'general' | 'person' | 'actions' | 'milestones' | 'risks'`, `export interface Backlink { loc: { teamId: string; ref: ModuleRef }; moduleKind: BacklinkSourceKind; title: string; snippet: string }`, `export function collectBacklinks(team: Team, doc: Doc, kind: RefKind, targetId: string): Backlink[]`.

- [ ] **Step 1: Write the failing test**

Append to `test/search.test.ts` (after the final `})` that closes the last `describe` block):

```ts
import { collectBacklinks } from '../src/core/search'

function backlinksFixture(): Doc {
  const d = createEmptyDocument('en-US')
  const t1 = team('t1', 'Alpha')
  t1.dailyNotes['2026-08-04'] = 'Started @[Migrate billing job](action:a1), needs review'
  t1.generalNotes = 'Vendor call notes, unrelated to @[Migrate billing job](action:a1) too'
  t1.members.push({ id: 'p1', name: 'Ana', role: 'Dev', parentId: null, order: 0, notes: 'Flagged @[Migrate billing job](action:a1) as blocking her sprint' })
  t1.actionItems.push({ id: 'a1', summary: 'Migrate billing job', status: 'todo', color: 'ledger', dueDate: null, assignee: '', order: 0, notes: '' })
  t1.milestones.push({ id: 'm1', date: '2026-08-01', title: 'Beta', done: false, followup: 'Depends on @[Migrate billing job](action:a1) landing before Q3' })
  t1.risks.push({ id: 'r1', title: 'Queue backlog', chance: 2, impact: 2, plan: 'mitigate', followup: 'no mention here', order: 0, closed: false })
  d.teams.push(t1)
  return d
}

describe('collectBacklinks', () => {
  test('finds mentions across all 4 non-general note fields plus general notes', () => {
    const doc = backlinksFixture()
    const team = doc.teams[0]!
    const results = collectBacklinks(team, doc, 'action', 'a1')
    expect(results).toHaveLength(4)
    expect(results.map((r) => r.moduleKind).sort()).toEqual(['daily', 'general', 'milestones', 'person'])
  })

  test('a field with two mentions of the same target yields two entries', () => {
    const doc = backlinksFixture()
    const team = doc.teams[0]!
    team.dailyNotes['2026-08-04'] += ' — see also @[Migrate billing job](action:a1) again'
    const results = collectBacklinks(team, doc, 'action', 'a1')
    expect(results.filter((r) => r.moduleKind === 'daily')).toHaveLength(2)
  })

  test('no matches returns an empty array', () => {
    const doc = backlinksFixture()
    const team = doc.teams[0]!
    expect(collectBacklinks(team, doc, 'risk', 'r1')).toEqual([])
  })

  test('snippet is markdown-stripped and the matched mention reads as its label', () => {
    const doc = backlinksFixture()
    const team = doc.teams[0]!
    const [hit] = collectBacklinks(team, doc, 'action', 'a1').filter((r) => r.moduleKind === 'person')
    expect(hit!.snippet).toContain('Migrate billing job')
    expect(hit!.snippet).not.toContain('@[')
    expect(hit!.title).toBe('Ana')
    expect(hit!.loc).toEqual({ teamId: 't1', ref: { kind: 'person', personId: 'p1', group: 'members' } })
  })

  test('day-kind target keys by ISO date string, not an item id', () => {
    const doc = backlinksFixture()
    const team = doc.teams[0]!
    team.risks[0]!.followup = 'Follow up on @[Aug 4](day:2026-08-04)'
    const results = collectBacklinks(team, doc, 'day', '2026-08-04')
    expect(results).toHaveLength(1)
    expect(results[0]!.moduleKind).toBe('risks')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search.test.ts -t collectBacklinks`
Expected: FAIL — `collectBacklinks` is not exported from `../src/core/search`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/search.ts`, change the import line at the top (line 1) from:

```ts
import type { Doc, ModuleRef, Team } from './types'
```

to add a new import right after the existing 3 imports (after line 3, `import { formatDate, t } from './i18n'`):

```ts
import { refPattern, type RefKind } from './refs'
```

Then insert the following block immediately after the closing `}` of `collectCandidates` (right after `src/core/search.ts:109`, before `/** A candidate with its markdown stripped and normalized once, ready to match against. */`):

```ts
/**
 * Sections whose mutations can add/remove a backlink match or change a
 * backlink's displayed title/snippet — the fields collectCandidates scans,
 * minus 'teams'/'prefs' (a rename or locale change going stale here is the
 * same acceptable class of staleness createSearchIndex already accepts for
 * its own cache). Modules that render a backlinks chip/badge widen their own
 * store.subscribe WATCHED list with this (see Tasks 5-9).
 */
export const BACKLINK_SECTIONS: readonly Section[] = ['notes', 'people', 'actions', 'milestones', 'risks']

/**
 * Source kinds collectCandidates ever produces for its `ref` field — a
 * narrower subset of ModuleRef['kind'] than KIND_ICON's domain (excludes
 * 'stakeholders'/'members', which are whole-list pane views, never a single
 * free-text field a mention can live in).
 */
export type BacklinkSourceKind = 'daily' | 'general' | 'person' | 'actions' | 'milestones' | 'risks'

export interface Backlink {
  /** Where the mention lives — the free-text field's own location, not the target's. */
  loc: { teamId: string; ref: ModuleRef }
  moduleKind: BacklinkSourceKind
  /** The source item's display title (e.g. the mentioning person's name, or the mentioning daily note's formatted date). */
  title: string
  /** Plain-text excerpt around the mention, markdown-stripped. */
  snippet: string
}

/** Same trim shape as makeSnippet above, but anchored at a known raw-text match span instead of a search term. */
function backlinkSnippet(raw: string, matchIndex: number, matchLen: number): string {
  const start = Math.max(0, matchIndex - SNIPPET_RADIUS)
  const end = Math.min(raw.length, matchIndex + matchLen + SNIPPET_RADIUS)
  let out = stripMd(raw.slice(start, end)).trim()
  if (start > 0) out = `…${out}`
  if (end < raw.length) out = `${out}…`
  return out
}

/**
 * Every mention of `kind:targetId` across `team`'s free-text fields (the
 * same 6-field enumeration collectCandidates uses for search), one Backlink
 * per mention — a field mentioning the same target twice yields two
 * entries. Matches against each candidate's *raw* text: stripMd would
 * already have collapsed `@[label](kind:id)` down to `label`, destroying
 * the id being matched. The returned snippet is stripped afterward, from a
 * raw-text window around the match — day-kind targets key by the ISO date
 * string (refPattern's day target format), not an item id.
 */
export function collectBacklinks(team: Team, doc: Doc, kind: RefKind, targetId: string): Backlink[] {
  const re = refPattern(kind)
  const prefixLen = kind.length + 1
  const out: Backlink[] = []
  for (const candidate of collectCandidates(team, doc)) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(candidate.raw))) {
      if (m[2]!.slice(prefixLen) !== targetId) continue
      out.push({
        loc: { teamId: team.id, ref: candidate.ref },
        // collectCandidates never emits 'stakeholders'/'members' as a ref
        // kind — see BacklinkSourceKind's own doc comment.
        moduleKind: candidate.ref.kind as BacklinkSourceKind,
        title: candidate.title,
        snippet: backlinkSnippet(candidate.raw, m.index, m[0].length),
      })
    }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/search.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones — confirms nothing else broke).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/search.ts test/search.test.ts
git commit -m "feat(search): add collectBacklinks — reverse @-ref lookup"
```

---

### Task 2: Factor `navigateToLoc` out of `makeRefClickHandler`

**Files:**
- Modify: `src/ui/atref.ts:354-399`
- Test: `test/atref.test.ts`

**Interfaces:**
- Consumes: `Store`, `PaneManager`, `Loc` (all already imported in this file), `dispatchSearchFocusItem`/`applySearchHighlight` (already imported in this file from `./search-highlight`).
- Produces (for Tasks 5-9): `export function navigateToLoc(store: Store, pm: PaneManager, paneIdx: 0 | 1, loc: Loc, opts: { secondary: boolean }): void`.
- `makeRefClickHandler`'s own exported signature is unchanged: `makeRefClickHandler(store: Store, pm: PaneManager, paneIdx: 0 | 1, locale: Locale, teamId: string): (target: RefInfo['target'], opts: { secondary: boolean }) => void`. This task only changes its internals, so every existing test in `test/atref.test.ts` for `makeRefClickHandler` must keep passing unmodified.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block to `test/atref.test.ts`, right after the closing `})` of the `describe('makeRefClickHandler - card highlight ...)` block (after line 641) and before `describe('makeRefLabelResolver', ...)`:

```ts
describe('navigateToLoc', () => {
  function fakePM(): PaneManager & { calls: { idx: 0 | 1; loc: Loc; secondary?: boolean }[] } {
    const calls: { idx: 0 | 1; loc: Loc; secondary?: boolean }[] = []
    return {
      calls,
      openInPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc }) },
      openBothPanes: () => {},
      openInFocused: () => { throw new Error('navigateToLoc must use openInPane, not openInFocused') },
      openInSecondaryPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc, secondary: true }); return idx === 0 ? 1 : 0 },
      toggleSplit: () => {},
      renderAll: () => {},
      registerModule: () => {},
      setSplitSpaceConstrained: () => {},
      dispose: () => {},
    }
  }

  function setupStore(): Store {
    const doc = createEmptyDocument('pt-BR')
    doc.teams.push({ id: 'T1', name: 'Team 1', emoji: '🚀', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} })
    return createStore(doc)
  }

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('plain navigation -> openInPane on the same pane', () => {
    const store = setupStore()
    const pm = fakePM()
    navigateToLoc(store, pm, 0, { teamId: 'T1', ref: { kind: 'person', personId: 'p1', group: 'members' } }, { secondary: false })
    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'p1', group: 'members' } } }])
  })

  test('opts.secondary -> openInSecondaryPane', () => {
    const store = setupStore()
    const pm = fakePM()
    navigateToLoc(store, pm, 0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-08-04' } }, { secondary: true })
    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'daily', date: '2026-08-04' } }, secondary: true }])
  })

  test('prefs.openRefsInSecondaryPane routes even without the modifier', () => {
    const store = setupStore()
    store.update((d) => { d.prefs.openRefsInSecondaryPane = true })
    const pm = fakePM()
    navigateToLoc(store, pm, 0, { teamId: 'T1', ref: { kind: 'general' } }, { secondary: false })
    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'general' } }, secondary: true }])
  })

  test('actions/milestones/risks target -> schedules highlight; day/person/general do not', () => {
    const store = setupStore()
    const pm = fakePM()
    let raf: FrameRequestCallback | null = null
    const originalRAF = window.requestAnimationFrame
    window.requestAnimationFrame = ((cb: FrameRequestCallback): number => { raf = cb; return 0 }) as typeof window.requestAnimationFrame

    navigateToLoc(store, pm, 0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-08-04' } }, { secondary: false })
    expect(raf).toBeNull()

    navigateToLoc(store, pm, 0, { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } }, { secondary: false })
    expect(raf).not.toBeNull()

    window.requestAnimationFrame = originalRAF
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/atref.test.ts -t navigateToLoc`
Expected: FAIL — `navigateToLoc` is not exported from `../src/ui/atref`. (Add `navigateToLoc` to the existing import line at the top of `test/atref.test.ts`: `import { attachAtAutocomplete, filterAtItems, makeRefClickHandler, makeRefLabelResolver, navigateToLoc, type AtItem } from '../src/ui/atref'`.)

- [ ] **Step 3: Write minimal implementation**

Replace `src/ui/atref.ts:354-399` (the full current `makeRefClickHandler` function, including its doc comment) with:

```ts
/**
 * Navigates to `loc` from pane `paneIdx`, honoring the secondary-pane
 * pref/modifier — `store.doc.prefs.openRefsInSecondaryPane` or
 * `opts.secondary` (Ctrl/Meta/middle-click) routes through
 * `pm.openInSecondaryPane` instead of `pm.openInPane`, splitting the view if
 * needed — and, for an actions/milestones/risks `loc`, scrolling to and
 * flash-highlighting the specific card afterward (same dispatch-then-
 * highlight sequence as search-ui.ts's commit()). Shared by
 * makeRefClickHandler below (forward @ref clicks) and
 * src/ui/backlinks-panel.ts (backlink row clicks), so both share one
 * implementation of "open this Loc, honoring the pref/modifier."
 */
export function navigateToLoc(store: Store, pm: PaneManager, paneIdx: 0 | 1, loc: Loc, opts: { secondary: boolean }): void {
  const openSecondary = store.doc.prefs.openRefsInSecondaryPane || opts.secondary
  let landedIdx: 0 | 1
  if (openSecondary) {
    landedIdx = pm.openInSecondaryPane(paneIdx, loc)
  } else {
    pm.openInPane(paneIdx, loc)
    landedIdx = paneIdx
  }

  const { ref } = loc
  if (ref.kind !== 'actions' && ref.kind !== 'milestones' && ref.kind !== 'risks') return
  const itemId = ref.itemId
  if (!itemId) return
  requestAnimationFrame(() => {
    const paneEl = document.querySelectorAll('.tt-pane-body')[landedIdx] as HTMLElement | undefined
    if (!paneEl) return
    dispatchSearchFocusItem(paneEl, itemId)
    const anchors = Array.from(paneEl.querySelectorAll<HTMLElement>(`[data-item-id="${itemId}"]`))
    applySearchHighlight(anchors.length > 0 ? anchors : [paneEl], [], anchors[0])
  })
}

/**
 * App-level `EditorHooks.onRefClick` handler shared by every module renderer
 * that mounts an editor (Tasks 18/19): navigates to the referenced person
 * (searched in the owning team's stakeholders/members) or day, in the pane
 * that hosts the editor the click came from (`paneIdx`, taken from that
 * module's `ModuleCtx` at mount time) — *not* whatever pane currently holds
 * focus. This matters because the click bubbles from the `<a class="ref">`
 * chip up through the editor's `onRefClick` hook before it reaches the outer
 * `.tt-pane` div's own click handler (the one that calls `setFocusedPane`),
 * so `store.doc.nav.focusedPane` can still be the *other*, previously
 * focused pane at the moment this handler runs. Using the editor's own
 * `paneIdx` keeps "chip navigates within the same pane" correct regardless
 * of which pane had focus before the click. Duplicate-open handling (focus
 * the other pane instead) is inherited for free from `PaneManager.openInPane`
 * -> `openLoc`. Pref/modifier routing and item-highlight are `navigateToLoc`'s.
 */
export function makeRefClickHandler(store: Store, pm: PaneManager, paneIdx: 0 | 1, locale: Locale, teamId: string): (target: RefInfo['target'], opts: { secondary: boolean }) => void {
  return (target, opts) => {
    if (target.kind === 'day') {
      navigateToLoc(store, pm, paneIdx, { teamId, ref: { kind: 'daily', date: target.date } }, opts)
      return
    }

    if (target.kind === 'action' || target.kind === 'milestone' || target.kind === 'risk') {
      const moduleKind = REF_KINDS[target.kind].moduleKind
      navigateToLoc(store, pm, paneIdx, { teamId, ref: { kind: moduleKind, itemId: target.id } }, opts)
      return
    }

    const team = store.doc.teams.find((tm) => tm.id === teamId)
    const group = team?.stakeholders.some((p) => p.id === target.id)
      ? 'stakeholders'
      : team?.members.some((p) => p.id === target.id)
        ? 'members'
        : null
    // No toast on a dangling person ref either — same reasoning as above,
    // and consistent with the other 3 kinds instead of the other way around.
    if (!group) return
    navigateToLoc(store, pm, paneIdx, { teamId, ref: { kind: 'person', personId: target.id, group } }, opts)
  }
}
```

- [ ] **Step 4: Run tests to verify everything passes**

Run: `npx vitest run test/atref.test.ts`
Expected: PASS — every pre-existing `makeRefClickHandler` test plus the new `navigateToLoc` tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/atref.ts test/atref.test.ts
git commit -m "refactor(atref): factor navigateToLoc out of makeRefClickHandler"
```

---

### Task 3: i18n keys

**Files:**
- Modify: `src/core/i18n.ts` (insert in both the `pt` dict and the `en` dict)

**Interfaces:**
- Produces: two new `MsgKey`s — `backlinks_badge_title`, `backlinks_panel_empty`.

- [ ] **Step 1: Add the `pt-BR` entries**

In `src/core/i18n.ts`, right after the line `atref_goto_day: 'Ir para notas de {date}',` (line 212), insert:

```ts
  backlinks_badge_title: '{count} referências',
  backlinks_panel_empty: 'Nenhuma referência',
```

- [ ] **Step 2: Add the `en-US` entries**

Right after the line `atref_goto_day: 'Go to day {date}',` (line 657, in the `en` dict), insert:

```ts
  backlinks_badge_title: '{count} references',
  backlinks_panel_empty: 'No references',
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors (confirms both dicts stayed in sync — a key present in only one would fail `Record<Locale, Record<MsgKey, string>>`).

- [ ] **Step 4: Commit**

```bash
git add src/core/i18n.ts
git commit -m "feat(i18n): add backlinks badge/panel copy"
```

---

### Task 4: `ui/backlinks-panel.ts` (chip + popover)

**Files:**
- Create: `src/ui/backlinks-panel.ts`
- Modify: `styles.css` (new rules)
- Test: `test/backlinks-panel.test.ts`

**Interfaces:**
- Consumes: `Backlink`, `BacklinkSourceKind`, `KIND_ICON` (from `../core/search`, Task 1 + pre-existing), `Loc` (from `../core/types`), `t`, `type Locale`, `type MsgKey` (from `../core/i18n`), `el`, `bindOutsideDismiss` (from `./dom`).
- Produces (for Tasks 5-9): `export function createBacklinksChip(backlinks: Backlink[], locale: Locale, onNavigate: (loc: Loc, opts: { secondary: boolean }) => void): HTMLElement | null` — returns `null` when `backlinks.length === 0` (callers skip appending it).

- [ ] **Step 1: Write the failing test**

Create `test/backlinks-panel.test.ts`:

```ts
import { createBacklinksChip } from '../src/ui/backlinks-panel'
import type { Backlink } from '../src/core/search'
import type { Loc } from '../src/core/types'

afterEach(() => {
  document.body.innerHTML = ''
})

function bl(overrides: Partial<Backlink> = {}): Backlink {
  return {
    loc: { teamId: 'T1', ref: { kind: 'person', personId: 'p1', group: 'members' } },
    moduleKind: 'person',
    title: 'Ana',
    snippet: 'flagged @[Ship it](action:a1) as blocking',
    ...overrides,
  }
}

test('empty backlinks -> null, nothing rendered', () => {
  expect(createBacklinksChip([], 'en-US', () => {})).toBeNull()
})

test('non-empty backlinks -> a pill showing the count', () => {
  const chip = createBacklinksChip([bl(), bl({ moduleKind: 'risks', title: 'Queue backlog' })], 'en-US', () => {})
  expect(chip).not.toBeNull()
  expect(chip!.textContent).toBe('↩ 2')
  expect(chip!.className).toBe('tt-backlinks-chip')
})

test('clicking the chip opens a panel with one row per backlink, grouped by kind with a header', () => {
  document.body.appendChild(document.createElement('div')) // ensure body has layout context
  const chip = createBacklinksChip([bl(), bl({ moduleKind: 'risks', title: 'Queue backlog', snippet: 'no mention' })], 'en-US', () => {})!
  document.body.appendChild(chip)
  chip.click()
  const panel = document.querySelector('.tt-backlinks-panel')
  expect(panel).not.toBeNull()
  expect(panel!.querySelectorAll('.tt-backlinks-group-header')).toHaveLength(2)
  expect(panel!.querySelectorAll('.tt-backlinks-row')).toHaveLength(2)
  expect(panel!.textContent).toContain('Ana')
  expect(panel!.textContent).toContain('Queue backlog')
})

test('clicking a row navigates with the row\'s loc and secondary computed from the click', () => {
  const calls: { loc: Loc; opts: { secondary: boolean } }[] = []
  const chip = createBacklinksChip([bl()], 'en-US', (loc, opts) => calls.push({ loc, opts }))!
  document.body.appendChild(chip)
  chip.click()
  const row = document.querySelector<HTMLElement>('.tt-backlinks-row')!
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  expect(calls).toEqual([{ loc: bl().loc, opts: { secondary: true } }])
  // clicking a row also closes the panel
  expect(document.querySelector('.tt-backlinks-panel')).toBeNull()
})

test('outside click and Escape both close the panel', () => {
  const chip = createBacklinksChip([bl()], 'en-US', () => {})!
  document.body.appendChild(chip)
  chip.click()
  expect(document.querySelector('.tt-backlinks-panel')).not.toBeNull()
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  expect(document.querySelector('.tt-backlinks-panel')).toBeNull()

  chip.click()
  expect(document.querySelector('.tt-backlinks-panel')).not.toBeNull()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('.tt-backlinks-panel')).toBeNull()
})

test('opening a second chip\'s panel closes the first', () => {
  const chipA = createBacklinksChip([bl()], 'en-US', () => {})!
  const chipB = createBacklinksChip([bl({ moduleKind: 'risks' })], 'en-US', () => {})!
  document.body.append(chipA, chipB)
  chipA.click()
  chipB.click()
  expect(document.querySelectorAll('.tt-backlinks-panel')).toHaveLength(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/backlinks-panel.test.ts`
Expected: FAIL — `../src/ui/backlinks-panel` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/backlinks-panel.ts`:

```ts
// src/ui/backlinks-panel.ts — count chip + popover for @-ref backlinks:
// given the Backlink[] core/search.ts's collectBacklinks computes for one
// person/day/action/milestone/risk, createBacklinksChip renders a small
// "↩ N" pill (null when there are none) that opens a grouped-by-source-kind
// list on click. Popover lifecycle mirrors ui/context-menu.ts (fixed-
// position overlay, module-level singleton close, outside-click/Escape
// dismiss via bindOutsideDismiss); group-header styling mirrors
// ui/atref.ts's @ dropdown, the app's other grouped popover.
import type { Backlink, BacklinkSourceKind } from '../core/search'
import { KIND_ICON } from '../core/search'
import type { Loc } from '../core/types'
import { t, type Locale, type MsgKey } from '../core/i18n'
import { el, bindOutsideDismiss } from './dom'

const GROUP_HEADER_KEY: Record<BacklinkSourceKind, MsgKey> = {
  daily: 'module_daily',
  general: 'module_general_notes',
  person: 'atref_group_people',
  actions: 'module_actions',
  milestones: 'module_milestones',
  risks: 'module_risks',
}

// Module-level so opening a new panel always closes any panel already open —
// callers never need to track/close their own previous instance.
let closeCurrent: (() => void) | null = null

function showBacklinksPanel(anchor: HTMLElement, backlinks: Backlink[], locale: Locale, onNavigate: (loc: Loc, opts: { secondary: boolean }) => void): void {
  closeCurrent?.()

  function close(): void {
    panel.remove()
    unbind()
    closeCurrent = null
  }

  function activate(loc: Loc, e: MouseEvent): void {
    close()
    onNavigate(loc, { secondary: e.ctrlKey || e.metaKey || e.button === 1 })
  }

  const rows: HTMLElement[] = []
  let lastKind: BacklinkSourceKind | null = null
  for (const bl of backlinks) {
    if (bl.moduleKind !== lastKind) {
      rows.push(el('div', { class: 'tt-backlinks-group-header' }, `${KIND_ICON[bl.moduleKind]} ${t(locale, GROUP_HEADER_KEY[bl.moduleKind])}`))
      lastKind = bl.moduleKind
    }
    rows.push(
      el(
        'div',
        {
          class: 'tt-backlinks-row',
          onclick: (e: Event) => activate(bl.loc, e as MouseEvent),
          onauxclick: (e: Event) => { if ((e as MouseEvent).button === 1) activate(bl.loc, e as MouseEvent) },
          onmousedown: (e: Event) => { if ((e as MouseEvent).button === 1) e.preventDefault() },
        },
        el('div', { class: 'tt-backlinks-row-title' }, bl.title),
        el('div', { class: 'tt-backlinks-row-snippet' }, bl.snippet)
      )
    )
  }
  if (rows.length === 0) rows.push(el('div', { class: 'tt-backlinks-empty' }, t(locale, 'backlinks_panel_empty')))

  const panel = el('div', { class: 'tt-backlinks-panel' }, ...rows)
  const rect = anchor.getBoundingClientRect()
  panel.style.left = `${rect.left}px`
  panel.style.top = `${rect.bottom}px`
  document.body.appendChild(panel)
  const unbind = bindOutsideDismiss((target) => !panel.contains(target), close)
  closeCurrent = close
}

/**
 * A small "↩ N" pill, or null when `backlinks` is empty — callers skip
 * appending it in that case (the app's zero-count convention, matching how
 * the due-badge and search elsewhere render nothing rather than a zero).
 * Clicking it opens the grouped backlinks popover anchored to the pill.
 */
export function createBacklinksChip(backlinks: Backlink[], locale: Locale, onNavigate: (loc: Loc, opts: { secondary: boolean }) => void): HTMLElement | null {
  if (backlinks.length === 0) return null
  const chip = el(
    'span',
    { class: 'tt-backlinks-chip', title: t(locale, 'backlinks_badge_title', { count: String(backlinks.length) }) },
    `↩ ${backlinks.length}`
  )
  chip.addEventListener('click', (e) => {
    e.stopPropagation()
    showBacklinksPanel(chip, backlinks, locale, onNavigate)
  })
  return chip
}
```

- [ ] **Step 4: Add CSS**

In `styles.css`, insert a new block right after the `.tt-context-menu-item.danger { color: var(--danger); }` line (line 626), before the `/* Emoji picker popup ... */` comment:

```css
/* Backlinks badge/chip + popover (references pointing at a person/day/action/milestone/risk) */
.tt-backlinks-chip {
  display: inline-flex; align-items: center; font-size: .7rem; padding: .05rem .4rem; border-radius: 999px;
  border: 1px solid rgba(var(--accent-rgb), .4); background: rgba(var(--accent-rgb), .12); color: var(--fg);
  cursor: pointer; flex: none; line-height: 1.4;
}
.tt-backlinks-chip:hover { background: rgba(var(--accent-rgb), .22); }
.tt-backlinks-panel {
  position: fixed; z-index: 1300; background: var(--bg); color: var(--fg);
  border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, .25);
  min-width: 240px; max-width: 360px; max-height: 320px; overflow-y: auto; padding: .25rem;
}
.tt-backlinks-group-header { padding: .3rem .6rem .15rem; font-size: .8rem; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: .03em; }
.tt-backlinks-row { padding: .35rem .6rem; border-radius: 4px; cursor: pointer; }
.tt-backlinks-row:hover { background: rgba(var(--accent-rgb), .12); }
.tt-backlinks-row-title { font-size: .85rem; font-weight: 600; }
.tt-backlinks-row-snippet { font-size: .8rem; color: var(--muted); margin-top: .1rem; }
.tt-backlinks-empty { padding: .4rem .6rem; color: var(--muted); font-size: .85rem; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/backlinks-panel.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/ui/backlinks-panel.ts styles.css test/backlinks-panel.test.ts
git commit -m "feat(ui): add backlinks chip + popover component"
```

---

### Task 5: Wire into `daily-notes.ts`

**Files:**
- Modify: `src/modules/daily-notes.ts`
- Test: `test/daily-notes.test.ts`

**Interfaces:**
- Consumes: `collectBacklinks` + `BACKLINK_SECTIONS` (from `../core/search`, Task 1), `createBacklinksChip` (from `../ui/backlinks-panel`, Task 4), `navigateToLoc` (from `../ui/atref`, Task 2).

- [ ] **Step 1: Write the failing test**

Add to `test/daily-notes.test.ts` (after the existing tests, inside or alongside the top-level `describe`/`test` blocks — follow the file's existing flat `test(...)` style):

```ts
test('a backlink chip renders when another field mentions this day, and is absent otherwise', () => {
  const team = makeTeam()
  team.risks.push({ id: 'r1', title: 'Backlog', chance: 1, impact: 1, plan: 'accept', followup: 'See @[Aug 4](day:2026-08-04)', order: 0, closed: false })
  const { container, store, pm, loc } = setup(team, '2026-08-04')
  render(container, loc, store, pm)
  expect(container.querySelector('.tt-backlinks-chip')?.textContent).toBe('↩ 1')

  document.body.innerHTML = ''
  const { container: c2, store: s2, pm: pm2, loc: loc2 } = setup(makeTeam(), '2026-08-04')
  render(c2, loc2, s2, pm2)
  expect(c2.querySelector('.tt-backlinks-chip')).toBeNull()
})

test('clicking the chip and then a backlink row navigates via the pane manager', () => {
  const team = makeTeam()
  team.risks.push({ id: 'r1', title: 'Backlog', chance: 1, impact: 1, plan: 'accept', followup: 'See @[Aug 4](day:2026-08-04)', order: 0, closed: false })
  const { container, store, pm, loc } = setup(team, '2026-08-04')
  render(container, loc, store, pm)
  container.querySelector<HTMLElement>('.tt-backlinks-chip')!.click()
  document.querySelector<HTMLElement>('.tt-backlinks-row')!.click()
  expect(pm.calls).toContainEqual({ idx: 0, loc: { teamId: 'T1', ref: { kind: 'risks', itemId: 'r1' } } })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daily-notes.test.ts -t "backlink"`
Expected: FAIL — no `.tt-backlinks-chip` rendered yet.

- [ ] **Step 3: Write minimal implementation**

In `src/modules/daily-notes.ts`, add to the import block (after the existing `import { el } from '../ui/dom'` line):

```ts
import { collectBacklinks, BACKLINK_SECTIONS } from '../core/search'
import { createBacklinksChip } from '../ui/backlinks-panel'
import { navigateToLoc } from '../ui/atref'
```

Change the `WATCHED` line (`const WATCHED: readonly Section[] = ['notes', 'milestones', 'actions', 'teams']`) to:

```ts
  const WATCHED: readonly Section[] = ['teams', ...BACKLINK_SECTIONS]
```

Replace the line `calendarCol.append(toggleBtn, calendarSlot)` with a badge slot built and rebuilt alongside the toggle button:

```ts
  const badgeSlot = el('div', { class: 'tt-daily-badge-slot' })
  function rebuildBadge(): void {
    badgeSlot.innerHTML = ''
    const team = findTeam(ctx, teamId)
    const backlinks = team ? collectBacklinks(team, ctx.store.doc, 'day', date) : []
    const chip = createBacklinksChip(backlinks, lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
    if (chip) badgeSlot.appendChild(chip)
  }
  rebuildBadge()
  calendarCol.append(toggleBtn, badgeSlot, calendarSlot)
```

Then change the store-subscribe callback:

```ts
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    rebuildCalendar()
  })
```

to:

```ts
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    rebuildCalendar()
    rebuildBadge()
  })
```

In `styles.css`, add right after the `.tt-daily-calendar-toggle { align-self: flex-start; margin: .4rem; }` line:

```css
.tt-daily-badge-slot { align-self: flex-start; margin: 0 .4rem .4rem; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/daily-notes.test.ts`
Expected: PASS (all tests, including pre-existing ones).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/daily-notes.ts styles.css test/daily-notes.test.ts
git commit -m "feat(daily-notes): show backlinks chip next to the calendar toggle"
```

---

### Task 6: Wire into `person-notes.ts`

**Files:**
- Modify: `src/modules/person-notes.ts`
- Test: `test/person-notes.test.ts`

**Interfaces:**
- Consumes: same 3 as Task 5, plus `BACKLINK_SECTIONS`.

- [ ] **Step 1: Write the failing test**

Add to `test/person-notes.test.ts`:

```ts
test('a backlink chip renders in the header when another field mentions this person', () => {
  const team = makeTeam()
  team.actionItems.push({ id: 'a1', summary: 'Ship it', status: 'todo', color: 'ledger', dueDate: null, assignee: '', order: 0, notes: 'Blocked on @[Carla](person:stk-1)' })
  const { container, store, pm } = setup(team)
  const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } }
  render(container, loc, store, pm)
  expect(container.querySelector('.tt-backlinks-chip')?.textContent).toBe('↩ 1')
})

test('no chip when nothing mentions this person', () => {
  const { container, store, pm } = setup(makeTeam())
  const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } }
  render(container, loc, store, pm)
  expect(container.querySelector('.tt-backlinks-chip')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/person-notes.test.ts -t "backlink"`
Expected: FAIL — no `.tt-backlinks-chip` rendered, and `.tt-person-header` currently holds only a plain text string.

- [ ] **Step 3: Write minimal implementation**

In `src/modules/person-notes.ts`, add to the imports (after `import { el } from '../ui/dom'`):

```ts
import { collectBacklinks, BACKLINK_SECTIONS } from '../core/search'
import { createBacklinksChip } from '../ui/backlinks-panel'
import { navigateToLoc } from '../ui/atref'
```

Replace:

```ts
  const headerEl = el('div', { class: 'tt-person-header' }, personLabel(person))
```

with:

```ts
  const initialBacklinks = collectBacklinks(findTeam()!, ctx.store.doc, 'person', personId)
  const headerLabelEl = el('span', {}, personLabel(person))
  const headerBadgeSlot = el('div', {})
  const initialChip = createBacklinksChip(initialBacklinks, lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
  if (initialChip) headerBadgeSlot.appendChild(initialChip)
  const headerEl = el('div', { class: 'tt-person-header' }, headerLabelEl, headerBadgeSlot)
```

(`findTeam()!` is safe here: this code runs after the existing `if (!person) { showNotFound(); return }` guard a few lines above, which already established `findTeam()` returns a team containing `person`.)

Now make the badge rebuild live. Find the existing `store.subscribe` block:

```ts
  const WATCHED: readonly Section[] = ['people', 'notes', 'teams']
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    if (torn) return
    if (findPerson()) return
    torn = true
    unsubscribe()
    bundle.dispose()
    showNotFound()
  })
```

Replace it with:

```ts
  const WATCHED: readonly Section[] = ['teams', ...BACKLINK_SECTIONS]
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    if (torn) return
    const currentPerson = findPerson()
    if (!currentPerson) {
      torn = true
      unsubscribe()
      bundle.dispose()
      showNotFound()
      return
    }
    headerBadgeSlot.innerHTML = ''
    const chip = createBacklinksChip(collectBacklinks(findTeam()!, ctx.store.doc, 'person', personId), lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
    if (chip) headerBadgeSlot.appendChild(chip)
  })
```

In `styles.css`, change the `.tt-person-header` rule (currently just padding/font/background/border) to add flex layout:

```css
.tt-person-header {
  flex: none; padding: .5rem .75rem; font-weight: 700; font-family: var(--font-display); font-size: 1.05rem;
  background: var(--panel); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: .5rem;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/person-notes.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/person-notes.ts styles.css test/person-notes.test.ts
git commit -m "feat(person-notes): show backlinks chip in the header"
```

---

### Task 7: Wire into `action-items.ts`

**Files:**
- Modify: `src/modules/action-items.ts`
- Test: `test/action-items.test.ts`

**Interfaces:**
- Consumes: same 3 as Task 5, plus `BACKLINK_SECTIONS`.

- [ ] **Step 1: Write the failing test**

Add to `test/action-items.test.ts`:

```ts
test('a backlink chip renders in the card meta row when another field mentions this action item', () => {
  const team = makeTeam()
  team.actionItems.push(item({ id: 'a1', summary: 'Ship it' }))
  team.milestones.push({ id: 'm1', date: '2026-08-01', title: 'Beta', done: false, followup: 'Depends on @[Ship it](action:a1)' })
  const { container, store, pm, loc } = setup(team)
  render(container, loc, store, pm)
  const chip = container.querySelector('[data-item-id="a1"] .tt-backlinks-chip')
  expect(chip?.textContent).toBe('↩ 1')
})

test('no chip when nothing mentions this action item', () => {
  const team = makeTeam()
  team.actionItems.push(item({ id: 'a1', summary: 'Ship it' }))
  const { container, store, pm, loc } = setup(team)
  render(container, loc, store, pm)
  expect(container.querySelector('[data-item-id="a1"] .tt-backlinks-chip')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/action-items.test.ts -t "backlink"`
Expected: FAIL — no `.tt-backlinks-chip` rendered.

- [ ] **Step 3: Write minimal implementation**

In `src/modules/action-items.ts`, add to the imports (after `import { el } from '../ui/dom'`):

```ts
import { collectBacklinks, BACKLINK_SECTIONS } from '../core/search'
import { createBacklinksChip } from '../ui/backlinks-panel'
import { navigateToLoc } from '../ui/atref'
```

In `renderCard` (`src/modules/action-items.ts:375-391`), after the line `if (customName) metaChildren.push(el('span', { class: 'tt-kanban-card-tag' }, customName))` and before `const metaEl = el('div', { class: 'tt-kanban-card-meta' }, ...metaChildren)`, insert:

```ts
    const team = findTeam()
    const backlinks = team ? collectBacklinks(team, ctx.store.doc, 'action', item.id) : []
    const chip = createBacklinksChip(backlinks, lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
    if (chip) metaChildren.push(chip)
```

Change the `WATCHED` line (`const WATCHED: readonly Section[] = ['actions', 'teams', 'people']`, around line 621) to:

```ts
  const WATCHED: readonly Section[] = ['teams', ...BACKLINK_SECTIONS]
```

In `styles.css`, add right after the `.tt-kanban-card-tag { ... }` color-variant block (after line 848, the last `.tt-kanban-card.color-ledger .tt-kanban-card-tag` rule):

```css
.tt-kanban-card-meta .tt-backlinks-chip { margin-left: auto; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/action-items.ts styles.css test/action-items.test.ts
git commit -m "feat(action-items): show backlinks chip on the card meta row"
```

---

### Task 8: Wire into `milestones.ts`

**Files:**
- Modify: `src/modules/milestones.ts`
- Test: `test/milestones.test.ts`

**Interfaces:**
- Consumes: same 3 as Task 5, plus `BACKLINK_SECTIONS`.

- [ ] **Step 1: Write the failing test**

Add to `test/milestones.test.ts`:

```ts
test('a backlink chip renders before the expand button when another field mentions this milestone', () => {
  const team = makeTeam()
  team.milestones.push(milestone({ id: 'm1', title: 'Beta' }))
  team.risks.push({ id: 'r1', title: 'Backlog', chance: 1, impact: 1, plan: 'accept', followup: 'Blocks @[Beta](milestone:m1)', order: 0, closed: false })
  const { container, store, pm, loc } = setup(team)
  render(container, loc, store, pm)
  const chip = container.querySelector('[data-milestone-id="m1"] .tt-backlinks-chip')
  expect(chip?.textContent).toBe('↩ 1')
})

test('no chip when nothing mentions this milestone', () => {
  const team = makeTeam()
  team.milestones.push(milestone({ id: 'm1', title: 'Beta' }))
  const { container, store, pm, loc } = setup(team)
  render(container, loc, store, pm)
  expect(container.querySelector('[data-milestone-id="m1"] .tt-backlinks-chip')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/milestones.test.ts -t "backlink"`
Expected: FAIL — no `.tt-backlinks-chip` rendered.

- [ ] **Step 3: Write minimal implementation**

In `src/modules/milestones.ts`, add to the imports (after `import { el, blurOnEnter } from '../ui/dom'`):

```ts
import { collectBacklinks, BACKLINK_SECTIONS } from '../core/search'
import { createBacklinksChip } from '../ui/backlinks-panel'
import { navigateToLoc } from '../ui/atref'
```

In `renderRow` (`src/modules/milestones.ts:366-434`), right before the `const expandBtn = el(...)` block (line 412), insert:

```ts
    const team = findTeam()
    const backlinks = team ? collectBacklinks(team, ctx.store.doc, 'milestone', m.id) : []
    const backlinksChip = createBacklinksChip(backlinks, lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
```

Then change the `row` construction (line 424-434) from:

```ts
    const row = el(
      'div',
      {
        class: 'tt-milestone-row',
        tabindex: '0',
        'data-milestone-id': m.id,
        'data-item-id': m.id,
        title: `${t(lc, 'milestone_row_context_hint')} · ${t(lc, 'risk_row_menu_hint')}`,
      },
      datePicker.root, titleInput, doneCheckbox, expandBtn, deleteBtn
    )
```

to:

```ts
    const row = el(
      'div',
      {
        class: 'tt-milestone-row',
        tabindex: '0',
        'data-milestone-id': m.id,
        'data-item-id': m.id,
        title: `${t(lc, 'milestone_row_context_hint')} · ${t(lc, 'risk_row_menu_hint')}`,
      },
      datePicker.root, titleInput, doneCheckbox, backlinksChip, expandBtn, deleteBtn
    )
```

(`el()` already skips `null` children — see `src/ui/dom.ts:29` — so passing `backlinksChip` directly, `null` or not, is safe.)

Change the `WATCHED` line (`const WATCHED: readonly Section[] = ['milestones', 'teams']`, around line 553) to:

```ts
  const WATCHED: readonly Section[] = ['teams', ...BACKLINK_SECTIONS]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/milestones.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/milestones.ts test/milestones.test.ts
git commit -m "feat(milestones): show backlinks chip before the expand button"
```

---

### Task 9: Wire into `risks.ts`

**Files:**
- Modify: `src/modules/risks.ts`
- Test: `test/risks.test.ts`

**Interfaces:**
- Consumes: same 3 as Task 5, plus `BACKLINK_SECTIONS`.

- [ ] **Step 1: Write the failing test**

Add to `test/risks.test.ts`:

```ts
test('a backlink chip renders before the expand button when another field mentions this risk', () => {
  const team = makeTeam()
  team.risks.push(risk({ id: 'r1', title: 'Backlog' }))
  team.milestones.push({ id: 'm1', date: '2026-08-01', title: 'Beta', done: false, followup: 'Watch @[Backlog](risk:r1)' })
  const { container, store, pm, loc } = setup(team)
  render(container, loc, store, pm)
  const chip = container.querySelector('[data-risk-id="r1"] .tt-backlinks-chip')
  expect(chip?.textContent).toBe('↩ 1')
})

test('no chip when nothing mentions this risk', () => {
  const team = makeTeam()
  team.risks.push(risk({ id: 'r1', title: 'Backlog' }))
  const { container, store, pm, loc } = setup(team)
  render(container, loc, store, pm)
  expect(container.querySelector('[data-risk-id="r1"] .tt-backlinks-chip')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/risks.test.ts -t "backlink"`
Expected: FAIL — no `.tt-backlinks-chip` rendered.

- [ ] **Step 3: Write minimal implementation**

In `src/modules/risks.ts`, add to the imports (after `import { el, blurOnEnter } from '../ui/dom'`):

```ts
import { collectBacklinks, BACKLINK_SECTIONS } from '../core/search'
import { createBacklinksChip } from '../ui/backlinks-panel'
import { navigateToLoc } from '../ui/atref'
```

Right before the `const expanded = expandable.isExpanded(r.id)` line (`src/modules/risks.ts:295`), insert:

```ts
    const team = findTeam()
    const backlinks = team ? collectBacklinks(team, ctx.store.doc, 'risk', r.id) : []
    const backlinksChip = createBacklinksChip(backlinks, lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
```

Then change the `row` construction (`src/modules/risks.ts:324-341`) from:

```ts
      titleInput,
      metaLabel('chance', 'risk_col_chance'), chanceSelect,
      metaLabel('impact', 'risk_col_impact'), impactSelect,
      exposureCell,
      metaLabel('plan', 'risk_col_plan'), planSelect,
      lineBreak,
      expandBtn, closeBtn, deleteBtn
    )
```

to:

```ts
      titleInput,
      metaLabel('chance', 'risk_col_chance'), chanceSelect,
      metaLabel('impact', 'risk_col_impact'), impactSelect,
      exposureCell,
      metaLabel('plan', 'risk_col_plan'), planSelect,
      lineBreak,
      backlinksChip, expandBtn, closeBtn, deleteBtn
    )
```

Change the `WATCHED` line (`const WATCHED: readonly Section[] = ['risks', 'teams']`, around line 561) to:

```ts
  const WATCHED: readonly Section[] = ['teams', ...BACKLINK_SECTIONS]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/risks.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Full suite + build**

Run: `npm test && npm run build`
Expected: full test suite passes; both `dist/app.html` and `dist/pwa/` build without errors — confirms nothing in the other 8 tasks regressed.

- [ ] **Step 7: Commit**

```bash
git add src/modules/risks.ts test/risks.test.ts
git commit -m "feat(risks): show backlinks chip before the expand button"
```

---

## Self-Review Notes

- **Spec coverage:** note-header placement (Tasks 5-6), board chip placement incl. the milestones/risks icon-cluster adaptation (Tasks 8-9) and action-items meta-row placement (Task 7), zero-count hiding (`createBacklinksChip` returns `null`, Task 4), click navigation reusing `makeRefClickHandler`'s routing (Task 2's `navigateToLoc` extraction, consumed by Tasks 5-9), `general` notes excluded as a target but included as a source (Task 1's `collectCandidates` reuse covers it; `BacklinkSourceKind`/`GROUP_HEADER_KEY` both include `general`), i18n keys (Task 3) — all covered.
- **Cross-module correctness not spelled out in the spec, added during planning:** each of the 5 render sites' `store.subscribe` `WATCHED` section list was originally narrower than the sections that can actually add/remove a mention pointing at that item (e.g. `milestones.ts` only watched `['milestones', 'teams']`, so a person-note edit adding a milestone mention wouldn't have refreshed that milestone's chip). Tasks 5-9 each widen `WATCHED` to `['teams', ...BACKLINK_SECTIONS]`, which is a superset of every module's pre-existing list — verified against each file's actual current `WATCHED` line before writing the plan.
- **Type consistency:** `Backlink`/`BacklinkSourceKind`/`BACKLINK_SECTIONS` (Task 1) are consumed identically by name in Tasks 4-9; `navigateToLoc`'s signature (Task 2) matches every call site in Tasks 5-9 (`store, pm, paneIdx, loc, opts`); `createBacklinksChip`'s signature (Task 4) matches every call site.
