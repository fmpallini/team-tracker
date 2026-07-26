# General Notes Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "General Notes" module — a single free-text markdown blob per team, not tied to any date or person — wired into the pane switcher, Ctrl+K palette, and global search, following the same registration pattern every other module uses.

**Architecture:** One new optional `Team.generalNotes?: string` field, one new renderer module (`src/modules/general-notes.ts`) built from the same `createRichEditorBundle` every other free-text module uses, and small additive edits to the handful of places that enumerate `ModuleRef` kinds (pane switcher/palette list, search index, ref auto-unlink, i18n).

**Tech Stack:** TypeScript, Vitest + jsdom, esbuild (no new dependencies — zero-runtime-dependency constraint applies).

## Global Constraints

- Zero runtime dependencies — do not add any package to `dependencies` (dev-only additions are fine, and none are needed here).
- All user-visible strings go through `t(locale, key)` — add every new string to **both** `pt` and `en` blocks in `src/core/i18n.ts` in the same step (the `en` object is typed `Record<MsgKey, string>`, so a key present in only one locale is a compile error, not a silent gap).
- `store.update()` is for content mutation (marks the doc dirty, fires `subscribe()`); never use `store.updateNav()` for note content.
- `generalNotes` is **optional** (`generalNotes?: string`), not required, and there is **no** `SCHEMA_VERSION` bump and **no** migration step for it — see the spec's "Data model" section for why (matches the existing `Team.actionTagNames?:` precedent). Every read site must default with `?? ''`.
- Follow existing file conventions exactly (see the concrete code in each task below, lifted from the real files in this repo) rather than introducing new patterns.

---

### Task 1: `Team.generalNotes` field + `createEmptyTeam` seeding

**Files:**
- Modify: `src/core/types.ts` (the `Team` interface)
- Modify: `src/core/document.ts` (`createEmptyTeam`)
- Test: `test/document.test.ts`

**Interfaces:**
- Produces: `Team.generalNotes?: string` — read anywhere as `team.generalNotes ?? ''`. `createEmptyTeam(...)` returns a `Team` with `generalNotes: ''` set.

- [ ] **Step 1: Write the failing test**

Add to `test/document.test.ts` (near the existing `findTeam` test at the bottom):

```ts
test('createEmptyTeam seeds generalNotes as an empty string', () => {
  const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  expect(team.generalNotes).toBe('')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/document.test.ts -t "seeds generalNotes"`
Expected: FAIL — `team.generalNotes` is `undefined`, not `''` (the field doesn't exist yet, so this actually fails on the property simply not being set by `createEmptyTeam`).

- [ ] **Step 3: Write minimal implementation**

In `src/core/types.ts`, add the field to the `Team` interface (keep it grouped with the other optional field, `actionTagNames?`):

```ts
export interface Team {
  id: string; name: string; emoji: string
  stakeholders: Person[]; members: Person[]
  actionItems: ActionItem[]; milestones: Milestone[]; risks: Risk[]
  dailyNotes: Record<string, string>
  actionTagNames?: Partial<Record<ActionItem['color'], string>>
  generalNotes?: string
}
```

In `src/core/document.ts`, seed it in `createEmptyTeam`'s return object:

```ts
  return {
    id, name, emoji,
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: {},
    actionTagNames,
    generalNotes: '',
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/document.test.ts`
Expected: PASS (all tests in the file, not just the new one — confirms the new optional field didn't break any existing `Team`/`Doc` equality assertions).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Because the field is optional, none of the ~20 test files with bare `Team` object literals need any change — this is the whole point of making it optional instead of required.)

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/document.ts test/document.test.ts
git commit -m "feat: add optional Team.generalNotes field"
```

---

### Task 2: i18n strings

**Files:**
- Modify: `src/core/i18n.ts`

**Interfaces:**
- Produces: `MsgKey` union gains `'module_general_notes'`, resolvable via `t(locale, 'module_general_notes')` in both locales.

- [ ] **Step 1: Add the key to both locale blocks**

In `src/core/i18n.ts`, in the `pt` object, right after `module_daily` (so the two "no id" free-text modules stay adjacent in the source, mirroring their adjacency in the UI):

```ts
  module_daily: 'Notas do dia',
  module_general_notes: 'Notas gerais',
  module_person: 'Notas de pessoa',
```

In the `en` object, same position:

```ts
  module_daily: 'Daily notes',
  module_general_notes: 'General notes',
  module_person: 'Person notes',
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors — `en`'s `Record<MsgKey, string>` annotation would fail to compile if the key were missing from either block, so a clean typecheck here is the correctness signal (there's no dedicated i18n test file to run).

- [ ] **Step 3: Commit**

```bash
git add src/core/i18n.ts
git commit -m "feat: add module_general_notes i18n strings"
```

---

### Task 3: `ModuleRef` kind + `general-notes.ts` renderer

**Files:**
- Modify: `src/core/types.ts` (`ModuleRef` union)
- Create: `src/modules/general-notes.ts`
- Test: `test/general-notes.test.ts`

**Interfaces:**
- Consumes: `ModuleCtx` (`{ store: Store; pm: PaneManager; paneIdx: 0 | 1; locale: Locale }`) from `src/ui/panes.ts`; `createRichEditorBundle` from `src/ui/rich-editor.ts` (signature: `{ store, pm, paneIdx, locale, teamId, initialMd, onChange(md), getTeam(), getTemplates(), getTemplateCtx() } => { editor: Editor; dispose(): void }`); `findTeam` from `src/core/document.ts`.
- Produces: `ModuleRef` gains `{ kind: 'general' }`. `export function renderGeneralNotes(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void` matching the `ModuleRenderer` type (`src/ui/panes.ts`).

- [ ] **Step 1: Add the `ModuleRef` variant**

In `src/core/types.ts`:

```ts
export type ModuleRef =
  | { kind: 'daily'; date: string }
  | { kind: 'general' }
  | { kind: 'person'; personId: string; group: 'stakeholders' | 'members' }
  | { kind: 'stakeholders' } | { kind: 'members' }
  | { kind: 'actions'; itemId?: string } | { kind: 'milestones'; itemId?: string } | { kind: 'risks'; itemId?: string }
```

- [ ] **Step 2: Run typecheck to see the expected failures**

Run: `npm run typecheck`
Expected: FAIL — `src/ui/panes.ts`'s `titleFor()` switch over `loc.ref.kind` is exhaustive and will now report a missing `case 'general'`. This confirms the union is wired to that switch; Task 4 fixes it. (No other exhaustiveness errors are expected — `REF_KINDS`, `KIND_ICON`, and the `modules` Map in panes.ts are all `Record`/`Map` keyed structures, not exhaustive switches, so they don't error on a new variant by themselves.)

- [ ] **Step 3: Write the failing renderer test**

Create `test/general-notes.test.ts`:

```ts
import { renderGeneralNotes } from '../src/modules/general-notes'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { PaneManager, ModuleCtx } from '../src/ui/panes'
import type { Loc, Team } from '../src/core/types'

function fakePM(): PaneManager & { calls: { idx: 0 | 1; loc: Loc }[] } {
  const calls: { idx: 0 | 1; loc: Loc }[] = []
  return {
    calls,
    openInPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc }) },
    openBothPanes: () => {},
    openInFocused: () => {},
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
    setSplitSpaceConstrained: () => {},
  }
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [], members: [],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    generalNotes: '',
    ...overrides,
  }
}

function setup(team: Team): { container: HTMLElement; store: Store; pm: ReturnType<typeof fakePM> } {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const pm = fakePM()
  const container = document.createElement('div')
  document.body.appendChild(container)
  return { container, store, pm }
}

function render(container: HTMLElement, loc: Loc, store: Store, pm: PaneManager, paneIdx: 0 | 1 = 0): void {
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US' }
  renderGeneralNotes(container, loc, ctx)
}

function editorEl(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('.editor')
  if (!found) throw new Error('.editor not found')
  return found
}

function setBlockText(editor: HTMLElement, text: string): void {
  editor.innerHTML = `<div>${text}</div>`
  const textNode = editor.firstChild!.firstChild as Text | null
  const range = document.createRange()
  if (textNode) range.setStart(textNode, textNode.textContent!.length)
  else range.setStart(editor.firstChild!, 0)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

function fireInput(editor: HTMLElement): void {
  editor.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('renderGeneralNotes', () => {
  test('loads existing generalNotes content into the editor', () => {
    const team = makeTeam({ generalNotes: '## Team scratchpad' })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }
    render(container, loc, store, pm)

    expect(container.querySelector('.editor h2')?.textContent).toBe('Team scratchpad')
  })

  test('renders an empty editor when generalNotes is undefined (older-doc case)', () => {
    const team = makeTeam()
    delete (team as { generalNotes?: string }).generalNotes
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }
    expect(() => render(container, loc, store, pm)).not.toThrow()
    expect(editorEl(container).textContent).toBe('')
  })

  test('onChange persists the edited markdown into team.generalNotes', () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }
    render(container, loc, store, pm)

    setBlockText(editorEl(container), 'New note')
    fireInput(editorEl(container))
    vi.advanceTimersByTime(400)

    expect(store.doc.teams[0]!.generalNotes).toBe('New note')
  })

  test('clearing the notes (whitespace-only) persists an empty string', () => {
    vi.useFakeTimers()
    const team = makeTeam({ generalNotes: 'existing' })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }
    render(container, loc, store, pm)

    setBlockText(editorEl(container), '   ')
    fireInput(editorEl(container))
    vi.advanceTimersByTime(400)

    expect(store.doc.teams[0]!.generalNotes).toBe('')
  })

  test('double render into the same container disposes the previous instance: no duplicate @ dropdowns', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }

    render(container, loc, store, pm)
    setBlockText(editorEl(container), '@')
    fireInput(editorEl(container))
    expect(document.querySelectorAll('.tt-atref-dropdown')).toHaveLength(1)

    container.innerHTML = ''
    render(container, loc, store, pm)
    setBlockText(editorEl(container), '@')
    fireInput(editorEl(container))

    expect(document.querySelectorAll('.tt-atref-dropdown')).toHaveLength(1)
  })

  test('clicking a ref chip navigates via makeRefClickHandler using the pane it was mounted in', () => {
    const team = makeTeam({
      stakeholders: [{ id: 'stk-1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
      generalNotes: '@[Carla](person:stk-1) ',
    })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }
    render(container, loc, store, pm, 1)

    const chip = container.querySelector<HTMLAnchorElement>('a.ref')!
    chip.click()

    expect(pm.calls).toEqual([{ idx: 1, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } } }])
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/general-notes.test.ts`
Expected: FAIL — `../src/modules/general-notes` does not exist yet.

- [ ] **Step 5: Write the renderer implementation**

Create `src/modules/general-notes.ts`:

```ts
// src/modules/general-notes.ts — free-text notes for the team as a whole,
// not tied to any date or person. Simplest of the note-bearing modules:
// unlike src/modules/person-notes.ts, there's no underlying record that can
// be deleted out from under an open pane (a team itself disappearing is
// handled upstream by navigation away, the same as action-items.ts/
// milestones.ts/risks.ts rely on for team deletion), so no "not found"
// placeholder or live-deletion guard is needed here.
import type { Loc, Team } from '../core/types'
import { todayIso } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { createRichEditorBundle } from '../ui/rich-editor'
import { nowHHMM } from '../core/date'
import { findTeam as docFindTeam } from '../core/document'

const disposers = new WeakMap<HTMLElement, () => void>()

export function renderGeneralNotes(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void {
  disposers.get(container)?.()
  disposers.delete(container)

  if (loc.ref.kind !== 'general') return // registered only for 'general'; defensive
  const teamId = loc.teamId
  const lc = ctx.locale

  function findTeam(): Team | undefined {
    return docFindTeam(ctx.store.doc, teamId)
  }

  const bundle = createRichEditorBundle({
    store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
    initialMd: findTeam()?.generalNotes ?? '',
    onChange: (md) => {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        tm.generalNotes = md.trim() === '' ? '' : md
      })
    },
    getTeam: () => findTeam(),
    getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
    getTemplateCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), teamName: findTeam()?.name, locale: lc }),
  })
  const editor = bundle.editor

  container.appendChild(editor.root)

  disposers.set(container, () => {
    bundle.dispose()
  })
}
```

Unlike `person-notes.ts`, this module renders no user-visible label of its own (no header element), so it needs `todayIso` for the template context but not `t()` — don't copy person-notes.ts's `t` import.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/general-notes.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 7: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS — the `case 'general'` gap from Step 2 is still open (fixed in Task 4); if `panes.ts`'s exhaustive switch is the *only* remaining error, that's expected at this point. Confirm by reading the error output: it should mention only `src/ui/panes.ts`'s `titleFor` function.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/modules/general-notes.ts test/general-notes.test.ts
git commit -m "feat: add General Notes renderer module"
```

---

### Task 4: Register module + pane switcher/palette + `titleFor`

**Files:**
- Modify: `src/main.ts`
- Modify: `src/ui/panes.ts`
- Test: `test/panes.test.ts`

**Interfaces:**
- Consumes: `renderGeneralNotes` from `src/modules/general-notes.ts` (Task 3).
- Produces: `buildModuleItems(team, locale)` includes a General Notes entry immediately after the Daily entry; `titleFor` resolves `'general'` locs to the module's display name; the module is openable via the pane "＋" dropdown, Ctrl+K palette, and direct navigation.

- [ ] **Step 1: Update the existing exact-equality test to expect the new entry**

In `test/panes.test.ts`, the test `'buildModuleItems with no team includes the daily-notes entry and all 5 whole-board entries, but no per-item entries'` (around line 637) currently asserts an exact array. Update it to include General Notes right after Daily:

```ts
test('buildModuleItems with no team includes the daily-notes entry, the general-notes entry, and all 5 whole-board entries, but no per-item entries', () => {
  const items = buildModuleItems(null, 'en-US')
  expect(items).toEqual([
    { label: expect.any(String), ref: { kind: 'daily', date: expect.any(String) } },
    { label: `${KIND_ICON.general} General notes`, ref: { kind: 'general' } },
    { label: `${KIND_ICON.stakeholders} Stakeholders`, ref: { kind: 'stakeholders' } },
    { label: `${KIND_ICON.members} Members`, ref: { kind: 'members' } },
    { label: `${KIND_ICON.actions} Action items`, ref: { kind: 'actions' } },
    { label: `${KIND_ICON.milestones} Milestones`, ref: { kind: 'milestones' } },
    { label: `${KIND_ICON.risks} Risks`, ref: { kind: 'risks' } },
  ])
})
```

Also add a new, narrower test asserting the placement rule directly (survives future reordering of other entries):

```ts
test('buildModuleItems places the general-notes entry immediately after daily, before any per-person entries', () => {
  const team: Team = {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'stk-1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
  }
  const items = buildModuleItems(team, 'en-US')
  expect(items[0]!.ref.kind).toBe('daily')
  expect(items[1]!.ref).toEqual({ kind: 'general' })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/panes.test.ts -t "general-notes entry"`
Expected: FAIL — `KIND_ICON.general` is `undefined` (not added yet) and `buildModuleItems` doesn't insert the entry, so `items[1]` is the Stakeholders/Carla entry, not `{ kind: 'general' }`.

- [ ] **Step 3: Add `KIND_ICON.general` (needed by the test above)**

This lands in Task 5 alongside the rest of the search wiring, but the icon constant itself is a one-line addition needed here too — add it now in `src/core/search.ts`:

```ts
export const KIND_ICON: Record<SearchResult['moduleKind'], string> = {
  daily: '📅', general: '🗒️', person: '🧑', stakeholders: '👥', members: '👥', actions: '✅', milestones: '🚩', risks: '⚠️',
}
```

(TypeScript will require this now anyway — `Record<SearchResult['moduleKind'], string>` became non-exhaustive the moment Task 3 added `'general'` to `ModuleRef`.)

- [ ] **Step 4: Update `buildModuleItems` and `titleFor` in `src/ui/panes.ts`**

In `buildModuleItems` (around line 65), insert the General Notes entry right after the Daily entry, before the per-person loop:

```ts
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
```

In `titleFor` (around line 84), add the new case right after `'daily'`:

```ts
    case 'daily':
      return `${t(locale, 'module_daily')} · ${formatDate(loc.ref.date, locale)}`
    case 'general':
      return t(locale, 'module_general_notes')
    case 'person': {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/panes.test.ts`
Expected: PASS (all tests, including the two touched/added above — confirms no other exact-array assertion elsewhere in the file broke).

- [ ] **Step 6: Register the module in `src/main.ts`**

Add the import near the other module imports (after `renderPersonNotes`, before `renderActionItems`, to mirror the "general notes sits between daily and stakeholders/person" ordering used elsewhere):

```ts
import { renderDailyNotes } from './modules/daily-notes'
import { renderGeneralNotes } from './modules/general-notes'
import { renderPeopleTree } from './modules/people-tree'
```

Add the `registerModule` call before `pm.renderAll()`:

```ts
  pm.registerModule('daily', renderDailyNotes)
  pm.registerModule('general', renderGeneralNotes)
  pm.registerModule('stakeholders', renderPeopleTree('stakeholders'))
```

- [ ] **Step 7: Run full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. This is the point where the `case 'general'` exhaustiveness gap from Task 3 Step 2 is fully closed — typecheck should now be entirely clean.

- [ ] **Step 8: Commit**

```bash
git add src/main.ts src/ui/panes.ts src/core/search.ts test/panes.test.ts
git commit -m "feat: wire General Notes into pane switcher, palette, and registration"
```

---

### Task 5: Global search indexing

**Files:**
- Modify: `src/core/search.ts` (`collectCandidates`)
- Test: `test/search.test.ts`

**Interfaces:**
- Consumes: `KIND_ICON.general` (added in Task 4 Step 3), `ModuleRef` kind `'general'` (Task 3).
- Produces: `searchDocument()` returns a hit with `moduleKind: 'general'` and `loc.ref: { kind: 'general' }` for any team whose `generalNotes` matches the query.

- [ ] **Step 1: Write the failing test**

Add to `test/search.test.ts`. First extend the fixture's `t1` with general notes (add this line inside `fixture()`, after the existing `t1.dailyNotes[...]` line):

```ts
  t1.generalNotes = 'Vendor contact: Acme Corp, renewal in março'
```

Then add new tests:

```ts
test('finds text inside a team\'s generalNotes', () => {
  const r = searchDocument(fixture(), 'acme', 't1')
  expect(r[0]!.loc.ref).toEqual({ kind: 'general' })
  expect(r[0]!.moduleKind).toBe('general')
})

test('a team with undefined generalNotes does not throw and never matches', () => {
  const d = fixture()
  const t1 = d.teams.find((tm) => tm.id === 't1')!
  delete (t1 as { generalNotes?: string }).generalNotes
  expect(() => searchDocument(d, 'anything', 't1')).not.toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search.test.ts -t "generalNotes"`
Expected: FAIL — `collectCandidates` has no loop over `generalNotes`, so the first new test finds zero results (`r[0]` is `undefined`) and the second passes vacuously (no throw either way) — the meaningful failure is the first one.

- [ ] **Step 3: Add the `collectCandidates` loop**

In `src/core/search.ts`, inside `collectCandidates` (around line 87), add the loop right after the `dailyNotes` loop and before the stakeholders/members loop — matching the source order established in `buildModuleItems` (daily, then general, then people):

```ts
function collectCandidates(team: Team, doc: Doc): Candidate[] {
  const out: Candidate[] = []
  for (const [date, text] of Object.entries(team.dailyNotes)) {
    out.push({ raw: text, title: formatDate(date, doc.prefs.locale), ref: { kind: 'daily', date } })
  }
  out.push({ raw: team.generalNotes ?? '', title: t(doc.prefs.locale, 'module_general_notes'), ref: { kind: 'general' } })
  for (const group of ['stakeholders', 'members'] as const) {
```

This requires importing `t` from `../core/i18n` in `src/core/search.ts` — check the top of the file first; if `t`/`formatDate` aren't already imported from `./i18n`, add `t` to the existing import line (`formatDate` is already used on the line above, so an import from `./i18n` already exists — extend it rather than adding a second import line).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/search.test.ts`
Expected: PASS (all tests in the file — confirms the new unconditional push doesn't affect the `all-teams scope and AND terms` counts test, since `allTermsMatch` on `'acme'`/`'orcamento'` etc. won't cross-match the unrelated fixture text).

- [ ] **Step 5: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/search.ts test/search.test.ts
git commit -m "feat: index generalNotes in global search"
```

---

### Task 6: Auto-unlink `@`-mentions inside `generalNotes`

**Files:**
- Modify: `src/core/refs.ts` (`unlinkRefsInTeam`)
- Test: `test/refs.test.ts`

**Interfaces:**
- Produces: `unlinkRefsInTeam(team, kind, ids)` also rewrites stale mentions inside `team.generalNotes`, same as it already does for `dailyNotes` and every person's `notes`.

- [ ] **Step 1: Write the failing test**

In `test/refs.test.ts`, extend the `team()` helper inside `describe('unlinkRefsInTeam', ...)` (around line 41) to include a mention in `generalNotes`:

```ts
  function team(): Team {
    return {
      id: 't1', name: 'Team 1', emoji: '🚀',
      stakeholders: [{ id: 's1', name: 'Carla', role: '', parentId: null, order: 0, notes: 'ping @[Fix bug](action:a1)' }],
      members: [{ id: 'm1', name: 'Bruno', role: '', parentId: null, order: 0, notes: 'no refs here' }],
      actionItems: [{ id: 'a2', summary: 'Other', notes: 'see @[Fix bug](action:a1)', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
      milestones: [{ id: 'mi1', date: '2026-08-01', title: 'Ship', done: false, followup: 'blocked by @[Fix bug](action:a1)' }],
      risks: [{ id: 'r1', title: 'Risk', chance: 1, impact: 1, plan: 'accept', followup: 'linked to @[Fix bug](action:a1)', order: 0, closed: false }],
      dailyNotes: { '2026-07-01': 'today: @[Fix bug](action:a1)' },
      generalNotes: 'also see @[Fix bug](action:a1)',
    }
  }
```

Add the assertion to the existing `'unlinks the given ids across every note-bearing field on the team'` test:

```ts
  test('unlinks the given ids across every note-bearing field on the team', () => {
    const tm = team()
    unlinkRefsInTeam(tm, 'action', ['a1'])
    expect(tm.stakeholders[0]!.notes).toBe('ping Fix bug')
    expect(tm.members[0]!.notes).toBe('no refs here')
    expect(tm.actionItems[0]!.notes).toBe('see Fix bug')
    expect(tm.milestones[0]!.followup).toBe('blocked by Fix bug')
    expect(tm.risks[0]!.followup).toBe('linked to Fix bug')
    expect(tm.dailyNotes['2026-07-01']).toBe('today: Fix bug')
    expect(tm.generalNotes).toBe('also see Fix bug')
  })
```

Also add a dedicated test for the undefined case:

```ts
  test('leaves generalNotes as undefined when it was never set (no crash)', () => {
    const tm = team()
    delete (tm as { generalNotes?: string }).generalNotes
    expect(() => unlinkRefsInTeam(tm, 'action', ['a1'])).not.toThrow()
    expect(tm.generalNotes).toBe('')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/refs.test.ts -t "unlinks the given ids"`
Expected: FAIL — `tm.generalNotes` is still `'also see @[Fix bug](action:a1)'`, unchanged.

- [ ] **Step 3: Add the sweep**

In `src/core/refs.ts`, inside `unlinkRefsInTeam` (around line 61), add the line right after the `dailyNotes` loop:

```ts
export function unlinkRefsInTeam(team: Team, kind: IdRefKind, ids: string[]): void {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  const re = refPattern(kind)
  const prefixLen = kind.length + 1
  const unlink = (text: string): string => unlinkWithPattern(text, re, prefixLen, idSet)
  for (const date of Object.keys(team.dailyNotes)) {
    team.dailyNotes[date] = unlink(team.dailyNotes[date]!)
  }
  team.generalNotes = unlink(team.generalNotes ?? '')
  for (const group of ['stakeholders', 'members'] as const) {
    for (const p of team[group]) p.notes = unlink(p.notes)
  }
  for (const item of team.actionItems) item.notes = unlink(item.notes)
  for (const m of team.milestones) m.followup = unlink(m.followup)
  for (const r of team.risks) r.followup = unlink(r.followup)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/refs.test.ts`
Expected: PASS (all tests — including the pre-existing `'no-ops when ids is empty'` test, which relies on `JSON.stringify(tm)` being unchanged; confirm this still holds since the early-return on `ids.length === 0` skips the new line too).

- [ ] **Step 5: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/refs.ts test/refs.test.ts
git commit -m "feat: auto-unlink stale @-mentions inside generalNotes"
```

---

### Task 7: Full verification pass

**Files:** none (verification only)

**Interfaces:** none — this task runs the complete gate the `dev` branch's `.githooks/pre-push` also runs, before considering the feature done.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS, 0 errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS, 0 errors/warnings.

- [ ] **Step 4: Run the build**

Run: `npm run build`
Expected: succeeds, producing `dist/app.html` and `dist/pwa/` with no errors.

- [ ] **Step 5: Manual smoke test**

Run the app (`dist/app.html` opened directly in a browser, or via whatever local flow this project's `run` skill covers), create/open a `.tmv` file, create a team, open it via Ctrl+K palette by typing "general" (or "notas"), confirm:
- The pane opens with an empty rich-text editor.
- Typing persists (reload/reopen the file and confirm content survived — or just check the save indicator flips to "saved" after the debounce).
- Typing `@` opens the mention picker and inserting a mention + clicking the resulting chip navigates to that person/item.
- The header search bar finds text typed into General Notes.
- The pane's "＋" module dropdown lists "General notes" right after "Daily notes".

If any step fails, fix before proceeding — do not commit workarounds.

- [ ] **Step 6: No commit for this task** — it's verification-only. If Step 5 surfaces a bug, fix it under a new commit and re-run Steps 1-4.
