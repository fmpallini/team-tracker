# @ References (risks/action items/milestones) + palette parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `@` mentions and the Ctrl+K palette to reference action items, milestones, and risks (not just people/days) with live-updating labels and auto-unlink-on-delete, plus fix a pre-existing palette click bug.

**Architecture:** One new shared data helper (`teamRefCandidates`) feeds both the `@` autocomplete and the palette. Ref labels resolve live at render time via an optional resolver threaded through `core/markdown.ts`'s `mdToHtml`, instead of trusting the frozen text baked into stored markdown. Deleting a referenced item rewrites every note that mentioned it (`core/refs.ts`) inside the same `store.update()` transaction as the delete, so dangling refs can't normally exist. No schema/migration changes — this is entirely inside markdown note text, not the `Doc` shape.

**Tech Stack:** TypeScript, Vitest + jsdom, no new runtime dependencies (zero-runtime-dependency constraint from `CLAUDE.md`).

## Global Constraints

- Zero runtime dependencies — do not add any npm package to `dependencies`.
- Every user-visible string goes through `t(locale, key)`; add keys for both `pt-BR` and `en-US` in `src/core/i18n.ts`.
- `src/core/` stays headless (no DOM, no `ui/` imports) — `core/search.ts`, `core/markdown.ts`, `core/refs.ts` must not import from `src/ui/`.
- All doc mutations go through `store.update()` (never mutate `ctx.store.doc` directly outside that callback).
- Run `npm run typecheck`, `npm run lint`, and `npm test` before each commit; all three must pass.
- Follow existing file conventions exactly (disposer `WeakMap` pattern, `findTeam()` closures, `el()` DOM builder) — do not introduce new patterns where an existing one already fits.

---

## Task 1: Shared ref-candidate data layer + `KIND_ICON` relocation

**Files:**
- Modify: `src/core/search.ts`
- Modify: `src/ui/search-ui.ts:8,16-24`
- Test: `test/search.test.ts`

**Interfaces:**
- Produces: `export interface AtPerson { id: string; name: string; group: 'stakeholders' | 'members' }`, `export interface RefCandidate { id: string; title: string }`, `export interface TeamRefCandidates { people: AtPerson[]; actionItems: RefCandidate[]; milestones: RefCandidate[]; risks: RefCandidate[] }`, `export function teamRefCandidates(team: Team | undefined): TeamRefCandidates`, `export const KIND_ICON: Record<SearchResult['moduleKind'], string>` — all from `src/core/search.ts`, consumed by Tasks 4, 6, 9.

- [ ] **Step 1: Write the failing tests**

Add to `test/search.test.ts` (uses the existing `team()`/`fixture()` helpers already in that file):

```ts
import { searchDocument, normalize, teamRefCandidates, KIND_ICON } from '../src/core/search'
```

(replace the existing `import { searchDocument, normalize } from '../src/core/search'` at the top of the file with the line above), then append at the end of the file:

```ts
test('teamRefCandidates extracts id+title for people/action items/milestones/risks', () => {
  const d = fixture()
  const t1 = d.teams.find((tm) => tm.id === 't1')!
  const candidates = teamRefCandidates(t1)
  expect(candidates.people).toEqual([{ id: 'p1', name: 'Ana', group: 'members' }])
  expect(candidates.actionItems).toEqual([{ id: 'a1', title: 'Fechar contrato' }])
  expect(candidates.milestones).toEqual([{ id: 'm1', title: 'Entrega beta' }])
  expect(candidates.risks).toEqual([]) // r1 lives on t2, not t1
})

test('teamRefCandidates returns all-empty lists for an undefined team', () => {
  expect(teamRefCandidates(undefined)).toEqual({ people: [], actionItems: [], milestones: [], risks: [] })
})

test('KIND_ICON has an entry for every moduleKind used by search results', () => {
  const d = fixture()
  const results = searchDocument(d, 'orcamento', null)
  expect(results.length).toBeGreaterThan(0)
  for (const r of results) expect(KIND_ICON[r.moduleKind]).toBeTruthy()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/search.test.ts`
Expected: FAIL — `teamRefCandidates` and `KIND_ICON` are not exported from `../src/core/search`.

- [ ] **Step 3: Implement `teamRefCandidates`, `KIND_ICON`, and supporting types in `core/search.ts`**

Insert this block into `src/core/search.ts` immediately before the existing `interface Candidate { raw: string; title: string; ref: ModuleRef }` line:

```ts
export const KIND_ICON: Record<SearchResult['moduleKind'], string> = {
  daily: '📅', person: '🧑', stakeholders: '👥', members: '👥', actions: '✅', milestones: '🚩', risks: '⚠️',
}

export interface AtPerson { id: string; name: string; group: 'stakeholders' | 'members' }
export interface RefCandidate { id: string; title: string }
export interface TeamRefCandidates {
  people: AtPerson[]
  actionItems: RefCandidate[]
  milestones: RefCandidate[]
  risks: RefCandidate[]
}

/** Id+title extraction for the @ mention picker and the Ctrl+K palette — a lighter sibling of collectCandidates below, which also needs full note bodies for full-text search. */
export function teamRefCandidates(team: Team | undefined): TeamRefCandidates {
  if (!team) return { people: [], actionItems: [], milestones: [], risks: [] }
  return {
    people: [
      ...team.stakeholders.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'stakeholders' })),
      ...team.members.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'members' })),
    ],
    actionItems: team.actionItems.map((i): RefCandidate => ({ id: i.id, title: i.summary })),
    milestones: team.milestones.map((m): RefCandidate => ({ id: m.id, title: m.title })),
    risks: team.risks.map((r): RefCandidate => ({ id: r.id, title: r.title })),
  }
}
```

- [ ] **Step 4: Relocate `KIND_ICON` usage in `search-ui.ts`**

In `src/ui/search-ui.ts`, change the import at the top of the file:

```ts
import { searchDocument, normalize, type SearchResult } from '../core/search'
```
to:
```ts
import { searchDocument, normalize, KIND_ICON, type SearchResult } from '../core/search'
```

Then delete the local `const KIND_ICON: Record<SearchResult['moduleKind'], string> = { ... }` block (lines 16-24) entirely — it's now imported.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/search.test.ts test/search-ui.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/core/search.ts src/ui/search-ui.ts test/search.test.ts
git commit -m "feat: add teamRefCandidates data layer, relocate KIND_ICON to core/search"
```

---

## Task 2: Extend `core/markdown.ts` — new ref kinds + live label resolution

**Files:**
- Modify: `src/core/markdown.ts`
- Test: `test/markdown.test.ts`

**Interfaces:**
- Consumes: nothing new (pure string/DOM manipulation, no new imports).
- Produces: `export type LabelResolver = (target: RefInfo['target']) => string | null`, `export function mdToHtml(md: string, resolveLabel?: LabelResolver): string` (signature change — second param is new and optional, existing call sites unaffected), `export interface RefInfo` gains `'action' | 'milestone' | 'risk'` target variants, `export function parseRef` handles the 3 new prefixes. Consumed by Tasks 4 (parseRef in commit/dropdown), 5 (editor.ts threading), 6 (module call sites).

- [ ] **Step 1: Write the failing tests**

Append to `test/markdown.test.ts`:

```ts
test('parseRef accepts action/milestone/risk prefixes', () => {
  expect(parseRef('action:x1')).toEqual({ kind: 'action', id: 'x1' })
  expect(parseRef('milestone:x2')).toEqual({ kind: 'milestone', id: 'x2' })
  expect(parseRef('risk:x3')).toEqual({ kind: 'risk', id: 'x3' })
})

test('action/milestone/risk refs become chips and round-trip', () => {
  const md = 'ver @[Fix bug](action:a1) e @[Ship v2](milestone:m1) e @[Vendor delay](risk:r1)'
  const html = mdToHtml(md)
  expect(html).toContain('data-ref="action:a1"')
  expect(html).toContain('data-ref="milestone:m1"')
  expect(html).toContain('data-ref="risk:r1"')
  expect(roundTrip(md)).toBe(md)
})

test('mdToHtml with a resolver shows the resolved label instead of the stored one', () => {
  const md = 'see @[Old Name](action:a1)'
  const html = mdToHtml(md, (target) => (target.kind === 'action' && target.id === 'a1' ? 'New Name' : null))
  expect(html).toContain('>@New Name<')
  expect(html).not.toContain('Old Name')
})

test('mdToHtml resolver returning null falls back to the stored label', () => {
  const md = 'see @[Old Name](action:a1)'
  const html = mdToHtml(md, () => null)
  expect(html).toContain('>@Old Name<')
})

test('mdToHtml with no resolver uses the stored label (existing callers unaffected)', () => {
  const md = 'see @[Old Name](action:a1)'
  expect(mdToHtml(md)).toContain('>@Old Name<')
})

test('resolved label is HTML-escaped', () => {
  const md = 'see @[Old](action:a1)'
  const html = mdToHtml(md, () => '<script>x</script>')
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;script&gt;')
})

test('day ref resolves to the current locale format via the resolver', () => {
  const md = 'ver @[02/07/2026](day:2026-07-02)'
  const html = mdToHtml(md, (target) => (target.kind === 'day' ? `${target.date} (resolved)` : null))
  expect(html).toContain('>@2026-07-02 (resolved)<')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/markdown.test.ts`
Expected: FAIL — `parseRef('action:x1')` returns `null`, `mdToHtml` doesn't accept a second argument yet.

- [ ] **Step 3: Implement**

In `src/core/markdown.ts`, replace the `inline`/`blockInline`/`mdToHtml`/`RefInfo`/`parseRef` block (lines 3-44) with:

```ts
export type LabelResolver = (target: RefInfo['target']) => string | null

const REF_PATTERN = /@\[([^\]]+)\]\((person:[^)\s]+|day:\d{4}-\d{2}-\d{2}|action:[^)\s]+|milestone:[^)\s]+|risk:[^)\s]+)\)/g

function inline(s: string, resolveLabel?: LabelResolver): string {
  let out = esc(s)
  // refs primeiro (labels não contêm ]): @[label](person:ID) | @[label](day:date) | @[label](action:ID) | @[label](milestone:ID) | @[label](risk:ID)
  out = out.replace(REF_PATTERN, (_, label: string, ref: string) => {
    const target = resolveLabel ? parseRef(ref) : null
    const resolved = target ? resolveLabel!(target) : null
    const shown = resolved !== null ? esc(resolved) : label
    return `<a class="ref" data-ref="${ref}" contenteditable="false">@${shown}</a>`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  out = out.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>')
  return out
}

// A plain space at the very end of a block is CSS-collapsed to zero width,
// so after a line like "**Label:** " Chrome resolves an end-of-line click to
// a caret INSIDE the <strong> and typing sticks to bold (every template line
// shaped "**Label:** " hit this). A trailing &nbsp; keeps a real, visible
// caret slot after the formatting; htmlToMd normalizes it back to a regular
// space so documents never accumulate U+00A0.
const blockInline = (s: string, resolveLabel?: LabelResolver) => inline(s, resolveLabel).replace(/ $/, '&nbsp;')

export function mdToHtml(md: string, resolveLabel?: LabelResolver): string {
  const lines = md.split('\n'); const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  for (const line of lines) {
    const h = /^(#{1,3}) (.*)$/.exec(line)
    const ul = /^- (.*)$/.exec(line)
    const ol = /^(\d+)\. (.*)$/.exec(line)
    if (h) { closeList(); out.push(`<h${h[1]!.length}>${blockInline(h[2]!, resolveLabel)}</h${h[1]!.length}>`) }
    else if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul' } out.push(`<li>${blockInline(ul[1]!, resolveLabel)}</li>`) }
    else if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol' } out.push(`<li value="${ol[1]}">${blockInline(ol[2]!, resolveLabel)}</li>`) }
    else { closeList(); out.push(`<div>${line ? blockInline(line, resolveLabel) : '<br>'}</div>`) }
  }
  closeList(); return out.join('')
}

export interface RefInfo {
  label: string
  target:
    | { kind: 'person'; id: string }
    | { kind: 'day'; date: string }
    | { kind: 'action'; id: string }
    | { kind: 'milestone'; id: string }
    | { kind: 'risk'; id: string }
}
export function parseRef(href: string): RefInfo['target'] | null {
  if (href.startsWith('person:')) return { kind: 'person', id: href.slice(7) }
  if (href.startsWith('action:')) return { kind: 'action', id: href.slice(7) }
  if (href.startsWith('milestone:')) return { kind: 'milestone', id: href.slice(10) }
  if (href.startsWith('risk:')) return { kind: 'risk', id: href.slice(5) }
  const m = /^day:(\d{4}-\d{2}-\d{2})$/.exec(href)
  return m ? { kind: 'day', date: m[1]! } : null
}
```

Leave everything from `function inlineMd(node: Node): string {` onward (line 46 onward in the original file) untouched — `inlineMd` already reads the persisted label from the rendered chip's `textContent`, so it needs no changes for either the new ref kinds or live resolution.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/markdown.test.ts`
Expected: PASS (including all pre-existing tests in this file — the new optional param must not change behavior for any call site that omits it)

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/core/markdown.ts test/markdown.test.ts
git commit -m "feat: extend @ ref storage to action/milestone/risk kinds, add live label resolution"
```

---

## Task 3: `core/refs.ts` — auto-unlink-on-delete helpers

**Files:**
- Create: `src/core/refs.ts`
- Test: `test/refs.test.ts`

**Interfaces:**
- Consumes: `Team` from `../core/types`.
- Produces: `export type RefKind = 'person' | 'action' | 'milestone' | 'risk'`, `export function unlinkRefsInText(text: string, kind: RefKind, ids: ReadonlySet<string>): string`, `export function unlinkRefsInTeam(team: Team, kind: RefKind, ids: string[]): void`. Consumed by Task 7 (delete call sites).

- [ ] **Step 1: Write the failing tests**

Create `test/refs.test.ts`:

```ts
import { unlinkRefsInText, unlinkRefsInTeam } from '../src/core/refs'
import type { Team } from '../src/core/types'

describe('unlinkRefsInText', () => {
  test('rewrites a matching ref to its plain label', () => {
    const text = 'see @[Fix bug](action:a1) for details'
    expect(unlinkRefsInText(text, 'action', new Set(['a1']))).toBe('see Fix bug for details')
  })

  test('leaves refs of a different kind untouched', () => {
    const text = 'see @[Fix bug](action:a1) and @[Ana](person:a1)'
    expect(unlinkRefsInText(text, 'action', new Set(['a1']))).toBe('see Fix bug and @[Ana](person:a1)')
  })

  test('leaves refs of the same kind but a different id untouched', () => {
    const text = 'see @[Fix bug](action:a1) and @[Other](action:a2)'
    expect(unlinkRefsInText(text, 'action', new Set(['a1']))).toBe('see Fix bug and @[Other](action:a2)')
  })

  test('leaves day refs untouched regardless of kind (day is never a RefKind)', () => {
    const text = 'ver @[02/07/2026](day:2026-07-02)'
    expect(unlinkRefsInText(text, 'action', new Set(['2026-07-02']))).toBe(text)
  })

  test('no-ops when ids is empty', () => {
    const text = 'see @[Fix bug](action:a1)'
    expect(unlinkRefsInText(text, 'action', new Set())).toBe(text)
  })

  test('no-ops on text with no refs', () => {
    expect(unlinkRefsInText('plain text', 'action', new Set(['a1']))).toBe('plain text')
  })

  test('rewrites multiple matching refs in one pass', () => {
    const text = '@[A](risk:r1) and @[B](risk:r2) and @[C](risk:r3)'
    expect(unlinkRefsInText(text, 'risk', new Set(['r1', 'r3']))).toBe('A and @[B](risk:r2) and C')
  })
})

describe('unlinkRefsInTeam', () => {
  function team(): Team {
    return {
      id: 't1', name: 'Team 1', emoji: '🚀',
      stakeholders: [{ id: 's1', name: 'Carla', role: '', parentId: null, order: 0, notes: 'ping @[Fix bug](action:a1)' }],
      members: [{ id: 'm1', name: 'Bruno', role: '', parentId: null, order: 0, notes: 'no refs here' }],
      actionItems: [{ id: 'a2', summary: 'Other', notes: 'see @[Fix bug](action:a1)', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
      milestones: [{ id: 'mi1', date: '2026-08-01', title: 'Ship', done: false, followup: 'blocked by @[Fix bug](action:a1)' }],
      risks: [{ id: 'r1', title: 'Risk', chance: 1, impact: 1, plan: 'accept', followup: 'linked to @[Fix bug](action:a1)', order: 0, closed: false }],
      dailyNotes: { '2026-07-01': 'today: @[Fix bug](action:a1)' },
    }
  }

  test('unlinks the given ids across every note-bearing field on the team', () => {
    const tm = team()
    unlinkRefsInTeam(tm, 'action', ['a1'])
    expect(tm.stakeholders[0]!.notes).toBe('ping Fix bug')
    expect(tm.members[0]!.notes).toBe('no refs here')
    expect(tm.actionItems[0]!.notes).toBe('see Fix bug')
    expect(tm.milestones[0]!.followup).toBe('blocked by Fix bug')
    expect(tm.risks[0]!.followup).toBe('linked to Fix bug')
    expect(tm.dailyNotes['2026-07-01']).toBe('today: Fix bug')
  })

  test('no-ops when ids is empty', () => {
    const tm = team()
    const before = JSON.stringify(tm)
    unlinkRefsInTeam(tm, 'action', [])
    expect(JSON.stringify(tm)).toBe(before)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/refs.test.ts`
Expected: FAIL — `../src/core/refs` does not exist.

- [ ] **Step 3: Implement**

Create `src/core/refs.ts`:

```ts
// src/core/refs.ts — auto-unlink-on-delete: rewrites @[Label](kind:id) mentions
// back to plain "Label" text when the referenced item is deleted, so a note
// never ends up pointing at something that no longer exists. Called from
// inside the same store.update() as the delete (see the 5 call sites in
// people-tree.ts/action-items.ts/milestones.ts/risks.ts), same-team-scoped
// only — refs never cross teams (src/ui/atref.ts's candidates are already
// team-scoped the same way).
import type { Team } from './types'

export type RefKind = 'person' | 'action' | 'milestone' | 'risk'

export function unlinkRefsInText(text: string, kind: RefKind, ids: ReadonlySet<string>): string {
  if (ids.size === 0) return text
  const re = new RegExp(`@\\[([^\\]]+)\\]\\(${kind}:([^)\\s]+)\\)`, 'g')
  return text.replace(re, (whole: string, label: string, id: string) => (ids.has(id) ? label : whole))
}

export function unlinkRefsInTeam(team: Team, kind: RefKind, ids: string[]): void {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  for (const date of Object.keys(team.dailyNotes)) {
    team.dailyNotes[date] = unlinkRefsInText(team.dailyNotes[date]!, kind, idSet)
  }
  for (const group of ['stakeholders', 'members'] as const) {
    for (const p of team[group]) p.notes = unlinkRefsInText(p.notes, kind, idSet)
  }
  for (const item of team.actionItems) item.notes = unlinkRefsInText(item.notes, kind, idSet)
  for (const m of team.milestones) m.followup = unlinkRefsInText(m.followup, kind, idSet)
  for (const r of team.risks) r.followup = unlinkRefsInText(r.followup, kind, idSet)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/refs.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/core/refs.ts test/refs.test.ts
git commit -m "feat: add core/refs.ts auto-unlink-on-delete helpers"
```

---

## Task 4: `ui/atref.ts` — grouped/capped `filterAtItems` over `TeamRefCandidates`

**Files:**
- Modify: `src/ui/atref.ts`
- Test: `test/atref.test.ts`

**Interfaces:**
- Consumes: `TeamRefCandidates`, `AtPerson` from `../core/search` (Task 1).
- Produces: `export type AtItem = { kind: 'person'; id: string; name: string } | { kind: 'day'; date: string } | { kind: 'action' | 'milestone' | 'risk'; id: string; title: string }`, `export function filterAtItems(candidates: TeamRefCandidates, typed: string, locale: Locale): AtItem[]` (signature change from `(people: AtPerson[], ...)`), `attachAtAutocomplete`'s `opts.getPeople(): AtPerson[]` renamed to `opts.getRefCandidates(): TeamRefCandidates`. Consumed by Task 5 (same file, dropdown rendering) and Task 6 (module call sites).

- [ ] **Step 1: Update imports and `AtItem`/`filterAtItems` in `src/ui/atref.ts`**

Change the top-of-file imports from:
```ts
import { AT_TRIGGER_EVENT, type Editor } from './editor'
import type { RefInfo } from '../core/markdown'
import { t, formatDate, parseLocaleDate, type Locale } from '../core/i18n'
import { normalize } from '../core/search'
import type { Store } from '../core/store'
import type { PaneManager } from './panes'
import { toast } from './modal'
import { el } from './dom'

export interface AtPerson { id: string; name: string; group: 'stakeholders' | 'members' }
```
to:
```ts
import { AT_TRIGGER_EVENT, type Editor } from './editor'
import type { RefInfo } from '../core/markdown'
import { t, formatDate, parseLocaleDate, type Locale } from '../core/i18n'
import { normalize, type TeamRefCandidates } from '../core/search'
import type { Store } from '../core/store'
import type { PaneManager } from './panes'
import { toast } from './modal'
import { el } from './dom'

export type { AtPerson } from '../core/search'
```

Then replace:
```ts
export type AtItem =
  | { kind: 'person'; id: string; name: string }
  | { kind: 'day'; date: string }
```
with:
```ts
export type AtItem =
  | { kind: 'person'; id: string; name: string }
  | { kind: 'day'; date: string }
  | { kind: 'action' | 'milestone' | 'risk'; id: string; title: string }
```

(`toast` import stays for now — Task 5 removes it once the toast call itself is deleted.)

Then replace the entire `filterAtItems` function body:
```ts
export function filterAtItems(people: AtPerson[], typed: string, locale: Locale): AtItem[] {
  const trimmed = typed.trim()
  const q = normalize(trimmed)
  const items: AtItem[] = people
    .filter((p) => normalize(p.name).includes(q))
    .map((p): AtItem => ({ kind: 'person', id: p.id, name: p.name }))
  if (trimmed !== '') {
    for (const [word, offset] of RELATIVE_DAYS[locale]) {
      if (normalize(word).startsWith(q)) items.push({ kind: 'day', date: isoWithOffset(offset) })
    }
  }
  const iso = parseLocaleDate(trimmed, locale)
  if (iso) items.push({ kind: 'day', date: iso })
  return items
}
```
with:
```ts
const GROUP_CAP = 5

/**
 * Pure, unit-testable filter over a team's candidates, grouped by type
 * (people, dates, action items, milestones, risks — in that order) and
 * capped at GROUP_CAP per group. Substring match (accent/case-insensitive,
 * via core/search's normalize). Relative-day words (hoje/ontem/amanhã,
 * today/yesterday/tomorrow) always show, even on an empty query — that's
 * what makes '@today' discoverable from a bare '@'. A "go to day" item is
 * additionally appended when `typed` parses as a *complete* date in the
 * locale's format.
 */
export function filterAtItems(candidates: TeamRefCandidates, typed: string, locale: Locale): AtItem[] {
  const trimmed = typed.trim()
  const q = normalize(trimmed)

  const people: AtItem[] = candidates.people
    .filter((p) => normalize(p.name).includes(q))
    .slice(0, GROUP_CAP)
    .map((p): AtItem => ({ kind: 'person', id: p.id, name: p.name }))

  const days: AtItem[] = []
  for (const [word, offset] of RELATIVE_DAYS[locale]) {
    if (normalize(word).startsWith(q)) days.push({ kind: 'day', date: isoWithOffset(offset) })
  }
  const iso = parseLocaleDate(trimmed, locale)
  if (iso) days.push({ kind: 'day', date: iso })

  const actions: AtItem[] = candidates.actionItems
    .filter((c) => normalize(c.title).includes(q))
    .slice(0, GROUP_CAP)
    .map((c): AtItem => ({ kind: 'action', id: c.id, title: c.title }))

  const milestones: AtItem[] = candidates.milestones
    .filter((c) => normalize(c.title).includes(q))
    .slice(0, GROUP_CAP)
    .map((c): AtItem => ({ kind: 'milestone', id: c.id, title: c.title }))

  const risks: AtItem[] = candidates.risks
    .filter((c) => normalize(c.title).includes(q))
    .slice(0, GROUP_CAP)
    .map((c): AtItem => ({ kind: 'risk', id: c.id, title: c.title }))

  return [...people, ...days, ...actions, ...milestones, ...risks]
}
```

Then update `attachAtAutocomplete`'s `opts` type and the one place it calls `filterAtItems`:
```ts
export function attachAtAutocomplete(editor: Editor, opts: {
  getPeople(): AtPerson[]
  locale: Locale
  onPick(item: AtItem): void
}): AtAutocompleteHandle {
```
becomes:
```ts
export function attachAtAutocomplete(editor: Editor, opts: {
  getRefCandidates(): TeamRefCandidates
  locale: Locale
  onPick(item: AtItem): void
}): AtAutocompleteHandle {
```
and:
```ts
  function refresh(): void {
    const loc = locateAt()
    if (!loc) { close(); return }
    lastLoc = loc
    items = filterAtItems(opts.getPeople(), loc.typed, opts.locale)
    selected = items.length === 0 ? 0 : Math.min(selected, items.length - 1)
    renderList()
  }
```
becomes:
```ts
  function refresh(): void {
    const loc = locateAt()
    if (!loc) { close(); return }
    lastLoc = loc
    items = filterAtItems(opts.getRefCandidates(), loc.typed, opts.locale)
    selected = items.length === 0 ? 0 : Math.min(selected, items.length - 1)
    renderList()
  }
```

- [ ] **Step 2: Rewrite `test/atref.test.ts`'s `filterAtItems` describe block and `attachAtAutocomplete`'s `setup()` helper**

Replace the entire `describe('filterAtItems', ...)` block (lines 18-73 of the original file) with:

```ts
function candidates(overrides: Partial<Parameters<typeof filterAtItems>[0]> = {}): Parameters<typeof filterAtItems>[0] {
  return { people: [], actionItems: [], milestones: [], risks: [], ...overrides }
}

describe('filterAtItems', () => {
  const people: AtPerson[] = [
    { id: 'p1', name: 'Ana', group: 'members' },
    { id: 'p2', name: 'María', group: 'stakeholders' },
    { id: 'p3', name: 'Bruno', group: 'members' },
  ]

  test('substring match is accent- and case-insensitive', () => {
    const items = filterAtItems(candidates({ people }), 'mar', 'pt-BR')
    expect(items.filter((i) => i.kind === 'person').map((i) => (i as { name: string }).name)).toEqual(['María'])
  })

  test('empty typed text returns all people plus all three relative days', () => {
    const items = filterAtItems(candidates({ people }), '', 'pt-BR')
    expect(items.filter((i) => i.kind === 'person')).toHaveLength(3)
    expect(items.filter((i) => i.kind === 'day')).toHaveLength(3) // @today discoverability: bare '@' shows hoje/ontem/amanhã
  })

  test('no substring match yields an empty person list', () => {
    expect(filterAtItems(candidates({ people }), 'zzz', 'pt-BR').filter((i) => i.kind === 'person')).toEqual([])
  })

  test('a complete pt-BR date (dd/mm/yyyy) appends a day item', () => {
    const items = filterAtItems(candidates(), '02/07/2026', 'pt-BR')
    expect(items).toContainEqual({ kind: 'day', date: '2026-07-02' })
  })

  test('a complete en-US date (mm/dd/yyyy) appends a day item', () => {
    const items = filterAtItems(candidates(), '07/02/2026', 'en-US')
    expect(items).toContainEqual({ kind: 'day', date: '2026-07-02' })
  })

  test('invalid or incomplete date text does not append a day item', () => {
    expect(filterAtItems(candidates(), '99/99/9999', 'pt-BR').some((i) => i.kind === 'day')).toBe(false)
    expect(filterAtItems(candidates(), '02/07', 'pt-BR').some((i) => i.kind === 'day')).toBe(false)
  })

  function isoShift(days: number): string {
    const d = new Date(); d.setDate(d.getDate() + days)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  test('offers relative days in pt-BR', () => {
    expect(filterAtItems(candidates(), 'hoje', 'pt-BR')).toContainEqual({ kind: 'day', date: isoShift(0) })
    expect(filterAtItems(candidates(), 'ont', 'pt-BR')).toContainEqual({ kind: 'day', date: isoShift(-1) })
    expect(filterAtItems(candidates(), 'amanh', 'pt-BR')).toContainEqual({ kind: 'day', date: isoShift(1) })
  })

  test('offers relative days in en-US', () => {
    expect(filterAtItems(candidates(), 'tomo', 'en-US')).toContainEqual({ kind: 'day', date: isoShift(1) })
  })

  test('offers all three relative days on empty input (bare @ discoverability)', () => {
    const days = filterAtItems(candidates(), '', 'pt-BR').filter((i) => i.kind === 'day')
    expect(days).toEqual([
      { kind: 'day', date: isoShift(0) },
      { kind: 'day', date: isoShift(-1) },
      { kind: 'day', date: isoShift(1) },
    ])
  })

  test('groups results by type in a fixed order: people, dates, actions, milestones, risks', () => {
    const items = filterAtItems({
      people: [{ id: 'p1', name: 'Ana', group: 'members' }],
      actionItems: [{ id: 'a1', title: 'Fix bug' }],
      milestones: [{ id: 'm1', title: 'Ship v2' }],
      risks: [{ id: 'r1', title: 'Vendor delay' }],
    }, 'a', 'pt-BR') // 'a' matches Ana, all three items, and no relative-day word
    expect(items.map((i) => i.kind)).toEqual(['person', 'action', 'milestone', 'risk'])
  })

  test('caps each group at 5 results', () => {
    const actionItems = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, title: `Item ${i}` }))
    const items = filterAtItems(candidates({ actionItems }), '', 'pt-BR')
    expect(items.filter((i) => i.kind === 'action')).toHaveLength(5)
  })

  test('substring match on action item/milestone/risk titles', () => {
    const items = filterAtItems({
      people: [],
      actionItems: [{ id: 'a1', title: 'Fix login bug' }, { id: 'a2', title: 'Ship release' }],
      milestones: [{ id: 'm1', title: 'Beta launch' }],
      risks: [{ id: 'r1', title: 'Vendor delay' }],
    }, 'bug', 'pt-BR')
    expect(items).toEqual([{ kind: 'action', id: 'a1', title: 'Fix login bug' }])
  })
})
```

Also update the `setup()` helper inside `describe('attachAtAutocomplete', ...)`:
```ts
  function setup(
    locale: Locale = 'pt-BR',
    people: AtPerson[] = [
      { id: 'ana-id', name: 'Ana', group: 'members' },
      { id: 'bruno-id', name: 'Bruno', group: 'members' },
    ]
  ): { editorEl: HTMLElement; picks: AtItem[] } {
    const picks: AtItem[] = []
    editor = createEditor(makeHooks(), locale)
    document.body.appendChild(editor.root)
    attachAtAutocomplete(editor, { getPeople: () => people, locale, onPick: (item) => picks.push(item) })
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    return { editorEl, picks }
  }
```
becomes:
```ts
  function setup(
    locale: Locale = 'pt-BR',
    people: AtPerson[] = [
      { id: 'ana-id', name: 'Ana', group: 'members' },
      { id: 'bruno-id', name: 'Bruno', group: 'members' },
    ]
  ): { editorEl: HTMLElement; picks: AtItem[] } {
    const picks: AtItem[] = []
    editor = createEditor(makeHooks(), locale)
    document.body.appendChild(editor.root)
    attachAtAutocomplete(editor, {
      getRefCandidates: () => ({ people, actionItems: [], milestones: [], risks: [] }),
      locale,
      onPick: (item) => picks.push(item),
    })
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    return { editorEl, picks }
  }
```

The `test('typing @ opens the dropdown listing all people', ...)` test currently asserts `dropdown!.querySelectorAll('.tt-atref-item')).toHaveLength(2)` — with the bare-`@`-shows-relative-days change (this task) plus group headers (Task 5), this count will change. Leave this specific assertion as-is for now; Task 5's step 2 updates it once group headers exist (updating it now would make it fail again once Task 5 adds headers, so it's deferred to avoid a two-step flap).

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run test/atref.test.ts`
Expected: PASS for every test except `'typing @ opens the dropdown listing all people'`, which is now expected to FAIL (dropdown now also shows 3 relative-day items — `querySelectorAll('.tt-atref-item')` returns 5, not 2). Confirm the failure is exactly that count mismatch and nothing else, then leave it — Task 5 fixes it.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors (lint is skipped this step since the still-failing test above is expected and tracked, not a lint issue)

- [ ] **Step 5: Commit**

```bash
git add src/ui/atref.ts test/atref.test.ts
git commit -m "feat: group/cap filterAtItems over TeamRefCandidates, show relative days on bare @"
```

---

## Task 5: `ui/atref.ts` — group headers, new-kind chips, click nav, label resolver, icons

**Files:**
- Modify: `src/ui/atref.ts`
- Modify: `src/core/i18n.ts` (2 new keys × 2 locales)
- Modify: `styles.css`
- Test: `test/atref.test.ts`

**Interfaces:**
- Consumes: `LabelResolver`, `parseRef` from `../core/markdown` (Task 2).
- Produces: `export function makeRefLabelResolver(store: Store, teamId: string): LabelResolver`. `commit()` now builds chips for `action`/`milestone`/`risk`. `makeRefClickHandler` navigates all 5 kinds and never shows a toast. Consumed by Task 6 (module call sites pass `resolveRefLabel: makeRefLabelResolver(...)`).

- [ ] **Step 1: Add i18n keys**

In `src/core/i18n.ts`, in the `pt` object, add these two lines right after the existing `atref_goto_day: 'Ir para notas de {date}',` line:
```ts
  atref_group_people: 'Pessoas',
  atref_group_dates: 'Datas',
```
In the `en` object, add right after `atref_goto_day: 'Go to day {date}',`:
```ts
  atref_group_people: 'People',
  atref_group_dates: 'Dates',
```

- [ ] **Step 2: Rewrite the dropdown rendering, `commit()`, `makeRefClickHandler`, and add `makeRefLabelResolver` in `src/ui/atref.ts`**

Update the import line (from Task 4) to also bring in `MsgKey`, `LabelResolver`, and `parseRef`:
```ts
import { t, formatDate, parseLocaleDate, type Locale } from '../core/i18n'
```
becomes:
```ts
import { t, formatDate, parseLocaleDate, type Locale, type MsgKey } from '../core/i18n'
```
and:
```ts
import type { RefInfo } from '../core/markdown'
```
becomes:
```ts
import { parseRef, type RefInfo, type LabelResolver } from '../core/markdown'
```

Remove the now-unused `import { toast } from './modal'` line entirely (its one call site is deleted in this step).

Replace `renderList()`:
```ts
  function renderList(): void {
    if (!listEl) return
    listEl.innerHTML = ''
    items.forEach((item, i) => {
      const label = item.kind === 'person'
        ? item.name
        : t(opts.locale, 'atref_goto_day', { date: formatDate(item.date, opts.locale) })
      const row = el(
        'div',
        {
          class: 'tt-atref-item' + (i === selected ? ' selected' : ''),
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: () => commit(item),
          // See template-picker.ts's identical fix: rebuilding the row on
          // hover (via renderList()) made real Chrome re-fire mouseenter on
          // the replacement node under a stationary pointer, looping
          // forever and leaving mousedown/mouseup on two different elements
          // — so no click event ever fired.
          onmouseenter: () => { selected = i; updateSelectedClass() },
        },
        label
      )
      listEl!.appendChild(row)
    })
  }

  function updateSelectedClass(): void {
    if (!listEl) return
    Array.from(listEl.children).forEach((child, i) => child.classList.toggle('selected', i === selected))
  }
```
with:
```ts
  const GROUP_HEADER_KEY: Record<AtItem['kind'], MsgKey> = {
    person: 'atref_group_people',
    day: 'atref_group_dates',
    action: 'module_actions',
    milestone: 'module_milestones',
    risk: 'module_risks',
  }

  function renderList(): void {
    if (!listEl) return
    listEl.innerHTML = ''
    let lastKind: AtItem['kind'] | null = null
    items.forEach((item, i) => {
      if (item.kind !== lastKind) {
        listEl!.appendChild(el('div', { class: 'tt-atref-group-header' }, t(opts.locale, GROUP_HEADER_KEY[item.kind])))
        lastKind = item.kind
      }
      const label = item.kind === 'person'
        ? item.name
        : item.kind === 'day'
          ? t(opts.locale, 'atref_goto_day', { date: formatDate(item.date, opts.locale) })
          : item.title
      const row = el(
        'div',
        {
          class: 'tt-atref-item' + (i === selected ? ' selected' : ''),
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: () => commit(item),
          // See template-picker.ts's identical fix: rebuilding the row on
          // hover (via renderList()) made real Chrome re-fire mouseenter on
          // the replacement node under a stationary pointer, looping
          // forever and leaving mousedown/mouseup on two different elements
          // — so no click event ever fired.
          onmouseenter: () => { selected = i; updateSelectedClass() },
        },
        label
      )
      listEl!.appendChild(row)
    })
  }

  /** Only .tt-atref-item rows are selectable — group headers are interspersed in the DOM but not in `items`/`selected`, so this must query past them rather than index into listEl.children directly. */
  function updateSelectedClass(): void {
    if (!listEl) return
    const rows = Array.from(listEl.querySelectorAll<HTMLElement>('.tt-atref-item'))
    rows.forEach((row, i) => row.classList.toggle('selected', i === selected))
  }
```

Replace `commit()`'s label/dataset lines:
```ts
    const label = item.kind === 'person' ? item.name : formatDate(item.date, opts.locale)
    const safeLabel = label.replace(/[[\]()]/g, '')
    const chip = document.createElement('a')
    chip.className = 'ref'
    chip.setAttribute('contenteditable', 'false')
    chip.dataset.ref = item.kind === 'person' ? `person:${item.id}` : `day:${item.date}`
    chip.textContent = `@${safeLabel}`
```
with:
```ts
    const label = item.kind === 'person' ? item.name : item.kind === 'day' ? formatDate(item.date, opts.locale) : item.title
    const safeLabel = label.replace(/[[\]()]/g, '')
    const chip = document.createElement('a')
    chip.className = 'ref'
    chip.setAttribute('contenteditable', 'false')
    // Chip *text content* stays exactly `@${safeLabel}` — the per-kind icon
    // is CSS-only (styles.css, keyed off this same data-ref prefix), never
    // baked into textContent. inlineMd (core/markdown.ts) derives the
    // persisted markdown label straight from textContent, so an icon inside
    // it would round-trip into storage as part of the label forever.
    chip.dataset.ref = item.kind === 'person' ? `person:${item.id}` : item.kind === 'day' ? `day:${item.date}` : `${item.kind}:${item.id}`
    chip.textContent = `@${safeLabel}`
```

Replace `makeRefClickHandler`'s body:
```ts
export function makeRefClickHandler(store: Store, pm: PaneManager, paneIdx: 0 | 1, locale: Locale, teamId: string): (target: RefInfo['target']) => void {
  return (target) => {
    if (target.kind === 'day') {
      pm.openInPane(paneIdx, { teamId, ref: { kind: 'daily', date: target.date } })
      return
    }

    const team = store.doc.teams.find((tm) => tm.id === teamId)
    const group = team?.stakeholders.some((p) => p.id === target.id)
      ? 'stakeholders'
      : team?.members.some((p) => p.id === target.id)
        ? 'members'
        : null
    if (!group) {
      toast(t(locale, 'toast_person_not_found'))
      return
    }
    pm.openInPane(paneIdx, { teamId, ref: { kind: 'person', personId: target.id, group } })
  }
}
```
with:
```ts
export function makeRefClickHandler(store: Store, pm: PaneManager, paneIdx: 0 | 1, locale: Locale, teamId: string): (target: RefInfo['target']) => void {
  return (target) => {
    if (target.kind === 'day') {
      pm.openInPane(paneIdx, { teamId, ref: { kind: 'daily', date: target.date } })
      return
    }

    if (target.kind === 'action' || target.kind === 'milestone' || target.kind === 'risk') {
      const moduleKind = target.kind === 'action' ? 'actions' : target.kind === 'milestone' ? 'milestones' : 'risks'
      pm.openInPane(paneIdx, { teamId, ref: { kind: moduleKind, itemId: target.id } })
      // Best-effort scroll to the specific card, mirroring search-ui.ts's
      // commit() — no toast if the item was deleted (decision 7: with
      // auto-unlink-on-delete this is a defensive fallback for edge cases
      // outside the app's own control, e.g. a hand-edited .tmv or an import
      // merge, not the common path).
      requestAnimationFrame(() => {
        const paneEl = document.querySelectorAll('.tt-pane-body')[paneIdx] as HTMLElement | undefined
        paneEl?.querySelector(`[data-item-id="${target.id}"]`)?.scrollIntoView({ block: 'center' })
      })
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
    pm.openInPane(paneIdx, { teamId, ref: { kind: 'person', personId: target.id, group } })
  }
}

/**
 * Live label resolution for core/markdown.ts's mdToHtml: given a ref target,
 * returns the item's *current* name/title (so a chip shows the up-to-date
 * label even if the item was renamed after the mention was typed), or null
 * if resolveLabel has nothing to offer (day is always resolvable; the other
 * 4 fall back to null only if the id genuinely isn't found, which per
 * decision 7 shouldn't normally happen once auto-unlink-on-delete is wired
 * up in Task 7).
 */
export function makeRefLabelResolver(store: Store, teamId: string): LabelResolver {
  return (target) => {
    if (target.kind === 'day') return formatDate(target.date, store.doc.prefs.locale)
    const team = store.doc.teams.find((tm) => tm.id === teamId)
    if (!team) return null
    switch (target.kind) {
      case 'person': {
        const p = team.stakeholders.find((pp) => pp.id === target.id) ?? team.members.find((pp) => pp.id === target.id)
        return p ? p.name : null
      }
      case 'action': {
        const a = team.actionItems.find((i) => i.id === target.id)
        return a ? a.summary : null
      }
      case 'milestone': {
        const m = team.milestones.find((i) => i.id === target.id)
        return m ? m.title : null
      }
      case 'risk': {
        const r = team.risks.find((i) => i.id === target.id)
        return r ? r.title : null
      }
    }
  }
}
```

Note `parseRef` is imported but not yet called anywhere in this file — that's expected; it's exposed for symmetry with the rest of the module and is unused here (the resolver receives an already-parsed `target`, not a raw ref string). If lint flags it as unused, drop it from the import — `RefInfo`/`LabelResolver` (the types) are the only pieces actually needed from that import line.

- [ ] **Step 3: Add CSS icon rules and group-header style to `styles.css`**

In `styles.css`, right after the existing `.editor a.ref { ... }` block (around line 381-384), add:

```css
.editor a.ref[data-ref^="person:"]::before { content: "🧑 "; }
.editor a.ref[data-ref^="day:"]::before { content: "📅 "; }
.editor a.ref[data-ref^="action:"]::before { content: "✅ "; }
.editor a.ref[data-ref^="milestone:"]::before { content: "🚩 "; }
.editor a.ref[data-ref^="risk:"]::before { content: "⚠️ "; }
```

And right after the existing `.tt-atref-item.selected, .tt-atref-item:hover { background: rgba(var(--accent-rgb), .12); }` line, add:

```css
.tt-atref-group-header { padding: .3rem .6rem .15rem; font-size: .75rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
```

- [ ] **Step 4: Fix the deferred assertion from Task 4, and add new tests**

In `test/atref.test.ts`, update `test('typing @ opens the dropdown listing all people', ...)`:
```ts
  test('typing @ opens the dropdown listing all people', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '@')
    fireInput(editorEl)

    const dropdown = document.querySelector('.tt-atref-dropdown')
    expect(dropdown).not.toBeNull()
    expect(dropdown!.querySelectorAll('.tt-atref-item')).toHaveLength(2)
  })
```
to:
```ts
  test('typing @ opens the dropdown listing all people plus the 3 relative-day suggestions, under group headers', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '@')
    fireInput(editorEl)

    const dropdown = document.querySelector('.tt-atref-dropdown')
    expect(dropdown).not.toBeNull()
    expect(dropdown!.querySelectorAll('.tt-atref-item')).toHaveLength(5) // 2 people + 3 relative days
    expect(dropdown!.querySelectorAll('.tt-atref-group-header')).toHaveLength(2) // People, Dates
  })
```

Update the existing `'person not found -> shows a toast and does not navigate'` test in `describe('makeRefClickHandler', ...)`:
```ts
  test('person not found -> shows a toast and does not navigate', () => {
    const store = setupStore()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'person', id: 'missing' })

    expect(pm.calls).toEqual([])
    expect(document.querySelector('.tt-toast')).not.toBeNull()
  })
```
to:
```ts
  test('person not found -> silently does not navigate (no toast — matches the other 3 kinds\' dangling-ref behavior)', () => {
    const store = setupStore()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'person', id: 'missing' })

    expect(pm.calls).toEqual([])
    expect(document.querySelector('.tt-toast')).toBeNull()
  })
```

Then append these new tests to the end of the `describe('makeRefClickHandler', ...)` block (just before its closing `})`):

```ts
  function setupStoreWithItems(): Store {
    const doc = createEmptyDocument('pt-BR')
    doc.teams.push({
      id: 'T1', name: 'Team 1', emoji: '🚀',
      stakeholders: [], members: [],
      actionItems: [{ id: 'a1', summary: 'Fix bug', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
      milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship v2', done: false, followup: '' }],
      risks: [{ id: 'r1', title: 'Vendor delay', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }],
      dailyNotes: {},
    })
    doc.nav.activeTeamId = 'T1'
    return createStore(doc)
  }

  test('action -> openInPane on the actions board with the item id', () => {
    const store = setupStoreWithItems()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'action', id: 'a1' })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } } }])
  })

  test('milestone -> openInPane on the milestones board with the item id', () => {
    const store = setupStoreWithItems()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'milestone', id: 'm1' })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'milestones', itemId: 'm1' } } }])
  })

  test('risk -> openInPane on the risks board with the item id', () => {
    const store = setupStoreWithItems()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'risk', id: 'r1' })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'risks', itemId: 'r1' } } }])
  })

  test('action/milestone/risk not found -> still opens the board, no throw', () => {
    const store = setupStoreWithItems()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    expect(() => handler({ kind: 'action', id: 'missing' })).not.toThrow()
    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'actions', itemId: 'missing' } } }])
  })
})

describe('makeRefLabelResolver', () => {
  function setupStore(): Store {
    const doc = createEmptyDocument('pt-BR')
    doc.teams.push({
      id: 'T1', name: 'Team 1', emoji: '🚀',
      stakeholders: [{ id: 's1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
      members: [],
      actionItems: [{ id: 'a1', summary: 'Fix bug', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
      milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship v2', done: false, followup: '' }],
      risks: [{ id: 'r1', title: 'Vendor delay', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }],
      dailyNotes: {},
    })
    doc.nav.activeTeamId = 'T1'
    return createStore(doc)
  }

  test('resolves the current name/title for each kind', () => {
    const resolve = makeRefLabelResolver(setupStore(), 'T1')
    expect(resolve({ kind: 'person', id: 's1' })).toBe('Carla')
    expect(resolve({ kind: 'action', id: 'a1' })).toBe('Fix bug')
    expect(resolve({ kind: 'milestone', id: 'm1' })).toBe('Ship v2')
    expect(resolve({ kind: 'risk', id: 'r1' })).toBe('Vendor delay')
  })

  test('resolves day to the formatted date in the store\'s current locale', () => {
    const resolve = makeRefLabelResolver(setupStore(), 'T1')
    expect(resolve({ kind: 'day', date: '2026-07-02' })).toBe(formatDate('2026-07-02', 'pt-BR'))
  })

  test('returns null for an id that no longer exists', () => {
    const resolve = makeRefLabelResolver(setupStore(), 'T1')
    expect(resolve({ kind: 'action', id: 'missing' })).toBeNull()
  })

  test('renaming an item changes what the resolver returns on the next call (live, not cached)', () => {
    const store = setupStore()
    const resolve = makeRefLabelResolver(store, 'T1')
    expect(resolve({ kind: 'action', id: 'a1' })).toBe('Fix bug')
    store.update((d) => { d.teams[0]!.actionItems[0]!.summary = 'Fix login bug' })
    expect(resolve({ kind: 'action', id: 'a1' })).toBe('Fix login bug')
  })
})
```

This requires `formatDate` in the test file's imports — add it to the existing `import { ... } from '../src/core/i18n'` line (currently `import type { Locale } from '../core/i18n'` — check the exact existing import and extend it to a value import: `import { formatDate, type Locale } from '../src/core/i18n'`). Also add `makeRefLabelResolver` to the existing `import { attachAtAutocomplete, filterAtItems, makeRefClickHandler, type AtItem, type AtPerson } from '../src/ui/atref'` line.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/atref.test.ts`
Expected: PASS (all tests, including the two updated from Task 4/this task)

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/ui/atref.ts src/core/i18n.ts styles.css test/atref.test.ts
git commit -m "feat: group headers, new ref kinds, live label resolver, icons for @ mentions"
```

---

## Task 6: `ui/editor.ts` — thread `resolveRefLabel` through `setMd`

**Files:**
- Modify: `src/ui/editor.ts`
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: `LabelResolver` from `../core/markdown` (Task 2).
- Produces: `EditorHooks` gains optional `resolveRefLabel?: LabelResolver`. Consumed by Task 7 (module call sites).

- [ ] **Step 1: Write the failing test**

Append to `test/editor.test.ts`:

```ts
test('setMd uses hooks.resolveRefLabel to show the live label when provided', () => {
  const hooks = makeHooks()
  const editorWithResolver = createEditor(
    { ...hooks, resolveRefLabel: (target) => (target.kind === 'action' ? 'Live Title' : null) },
    'pt-BR'
  )
  editorWithResolver.setMd('see @[Stale Title](action:a1)')
  const chip = editorWithResolver.root.querySelector('a.ref') as HTMLAnchorElement
  expect(chip.textContent).toBe('@Live Title')
  editorWithResolver.destroy()
})

test('setMd falls back to the stored label when resolveRefLabel is not provided', () => {
  const editor = createEditor(makeHooks(), 'pt-BR')
  editor.setMd('see @[Stale Title](action:a1)')
  const chip = editor.root.querySelector('a.ref') as HTMLAnchorElement
  expect(chip.textContent).toBe('@Stale Title')
  editor.destroy()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/editor.test.ts -t "resolveRefLabel"`
Expected: FAIL — `resolveRefLabel` is not a recognized property on `EditorHooks`/has no effect yet.

- [ ] **Step 3: Implement**

In `src/ui/editor.ts`, change the import line:
```ts
import { mdToHtml, htmlToMd, htmlToPlainText, parseRef, type RefInfo } from '../core/markdown'
```
to:
```ts
import { mdToHtml, htmlToMd, htmlToPlainText, parseRef, type RefInfo, type LabelResolver } from '../core/markdown'
```

Change `EditorHooks`:
```ts
export interface EditorHooks {
  onChange(): void
  onRefClick(target: RefInfo['target']): void
  onAtTrigger(anchor: Range): void
  onSlashTrigger(anchor: Range): void
}
```
to:
```ts
export interface EditorHooks {
  onChange(): void
  onRefClick(target: RefInfo['target']): void
  onAtTrigger(anchor: Range): void
  onSlashTrigger(anchor: Range): void
  /** Optional: resolves a ref chip's *current* label from live team data instead of trusting the frozen text baked into stored markdown. Omitted by callers (e.g. template-picker.ts's preview) that have no team-scoped data to resolve against. */
  resolveRefLabel?: LabelResolver
}
```

Change `setMd`:
```ts
  function setMd(md: string): void {
    // A programmatic load can land within the debounce window of a prior
    // keystroke; without cancelling, the stale timer would fire onChange
    // against the newly-loaded document and falsely mark it dirty.
    if (changeTimer !== null) {
      clearTimeout(changeTimer)
      changeTimer = null
    }
    editorEl.innerHTML = mdToHtml(md)
  }
```
to:
```ts
  function setMd(md: string): void {
    // A programmatic load can land within the debounce window of a prior
    // keystroke; without cancelling, the stale timer would fire onChange
    // against the newly-loaded document and falsely mark it dirty.
    if (changeTimer !== null) {
      clearTimeout(changeTimer)
      changeTimer = null
    }
    editorEl.innerHTML = mdToHtml(md, hooks.resolveRefLabel)
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/editor.test.ts`
Expected: PASS (full file, including pre-existing tests — `resolveRefLabel` being optional and undefined by default must not change any existing behavior)

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "feat: thread optional resolveRefLabel hook through editor setMd"
```

---

## Task 7: Wire `getRefCandidates`/`resolveRefLabel` into the 5 module call sites

**Files:**
- Modify: `src/modules/action-items.ts:1-40,152-233`
- Modify: `src/modules/risks.ts:1-30,140-250`
- Modify: `src/modules/milestones.ts:1-30,225-230` (and its own `renderFollowupRow`, same shape as risks.ts)
- Modify: `src/modules/daily-notes.ts:1-140`
- Modify: `src/modules/person-notes.ts` (whole file)

**Interfaces:**
- Consumes: `teamRefCandidates` from `../core/search` (Task 1), `makeRefLabelResolver` from `../ui/atref` (Task 5).
- Produces: nothing new (internal wiring only) — this is the task that actually turns Tasks 1-6 into a working end-to-end feature.

This task has the same 3-line shape repeated 5 times: drop the local `getPeople()` helper and its `AtPerson` import, import `teamRefCandidates`, pass `getRefCandidates: () => teamRefCandidates(findTeam())` instead of `getPeople`, and add `resolveRefLabel: makeRefLabelResolver(ctx.store, teamId)` to each `createEditor(...)` hooks object.

- [ ] **Step 1: `action-items.ts`**

Change the import block (top of file):
```ts
import type { ActionItem, Loc, Team } from '../core/types'
import { t, todayIso, formatDate } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, type AtPerson, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { el } from '../ui/dom'
```
to:
```ts
import type { ActionItem, Loc, Team } from '../core/types'
import { t, todayIso, formatDate } from '../core/i18n'
import { teamRefCandidates } from '../core/search'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { el } from '../ui/dom'
```

Delete the `getPeople()` function (lines ~152-159):
```ts
  function getPeople(): AtPerson[] {
    const tm = findTeam()
    if (!tm) return []
    return [
      ...tm.stakeholders.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'stakeholders' })),
      ...tm.members.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'members' })),
    ]
  }
```

In `openEditModal`, change:
```ts
    const editor: Editor = createEditor(
      { onChange() {}, onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId), onAtTrigger() {}, onSlashTrigger() {} },
      lc
    )
    editor.setMd(existing?.notes ?? '')
    const atHandle = attachAtAutocomplete(editor, { getPeople, locale: lc, onPick: () => {} })
```
to:
```ts
    const editor: Editor = createEditor(
      {
        onChange() {},
        onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId),
        onAtTrigger() {},
        onSlashTrigger() {},
        resolveRefLabel: makeRefLabelResolver(ctx.store, teamId),
      },
      lc
    )
    editor.setMd(existing?.notes ?? '')
    const atHandle = attachAtAutocomplete(editor, { getRefCandidates: () => teamRefCandidates(findTeam()), locale: lc, onPick: () => {} })
```

- [ ] **Step 2: `risks.ts`**

Change the import block:
```ts
import type { Risk, RiskPlan, Loc, Team } from '../core/types'
import { t, todayIso, type MsgKey } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, type AtPerson, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { computeDropPosition } from './action-items'
import { el } from '../ui/dom'
```
to:
```ts
import type { Risk, RiskPlan, Loc, Team } from '../core/types'
import { t, todayIso, type MsgKey } from '../core/i18n'
import { teamRefCandidates } from '../core/search'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { computeDropPosition } from './action-items'
import { el } from '../ui/dom'
```

Delete the `getPeople()` function (lines ~212-219). In `renderFollowupRow`, change:
```ts
    const editor: Editor = createEditor(
      {
        onChange() {
          const md = editor.getMd()
          ctx.store.update((d) => {
            const tm = d.teams.find((t2) => t2.id === teamId)
            const found = tm?.risks.find((rr) => rr.id === r.id)
            if (!found) return
            found.followup = md.trim() === '' ? '' : md
          })
        },
        onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId),
        onAtTrigger() {},
        onSlashTrigger() {},
      },
      lc
    )
    editor.setMd(r.followup)

    const atHandle = attachAtAutocomplete(editor, { getPeople, locale: lc, onPick: () => {} })
```
to:
```ts
    const editor: Editor = createEditor(
      {
        onChange() {
          const md = editor.getMd()
          ctx.store.update((d) => {
            const tm = d.teams.find((t2) => t2.id === teamId)
            const found = tm?.risks.find((rr) => rr.id === r.id)
            if (!found) return
            found.followup = md.trim() === '' ? '' : md
          })
        },
        onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId),
        onAtTrigger() {},
        onSlashTrigger() {},
        resolveRefLabel: makeRefLabelResolver(ctx.store, teamId),
      },
      lc
    )
    editor.setMd(r.followup)

    const atHandle = attachAtAutocomplete(editor, { getRefCandidates: () => teamRefCandidates(findTeam()), locale: lc, onPick: () => {} })
```

- [ ] **Step 3: `milestones.ts`**

Same shape as `risks.ts`. Change the import block:
```ts
import type { Milestone, Loc, Team } from '../core/types'
import { t, todayIso, formatDate } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, type AtPerson, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { el } from '../ui/dom'
```
to:
```ts
import type { Milestone, Loc, Team } from '../core/types'
import { t, todayIso, formatDate } from '../core/i18n'
import { teamRefCandidates } from '../core/search'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { el } from '../ui/dom'
```

Delete its `getPeople()` function (mirrors risks.ts's, at lines ~190-197). In `renderFollowupRow`, apply the same two changes as risks.ts: add `resolveRefLabel: makeRefLabelResolver(ctx.store, teamId),` to the `createEditor` hooks object, and change `attachAtAutocomplete(editor, { getPeople, locale: lc, onPick: () => {} })` to `attachAtAutocomplete(editor, { getRefCandidates: () => teamRefCandidates(findTeam()), locale: lc, onPick: () => {} })`.

- [ ] **Step 4: `daily-notes.ts`**

Change the import block:
```ts
import type { Loc, Team } from '../core/types'
import { t } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, type AtPerson } from '../ui/atref'
import { attachTemplatePicker } from '../ui/template-picker'
import { createCalendar, type CalendarMarks } from '../ui/calendar'
import { el } from '../ui/dom'
```
to:
```ts
import type { Loc, Team } from '../core/types'
import { t } from '../core/i18n'
import { teamRefCandidates } from '../core/search'
import type { ModuleCtx } from '../ui/panes'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver } from '../ui/atref'
import { attachTemplatePicker } from '../ui/template-picker'
import { createCalendar, type CalendarMarks } from '../ui/calendar'
import { el } from '../ui/dom'
```

Delete the `getPeople()` function (lines ~119-126). Change:
```ts
  const editor: Editor = createEditor(
    {
      onChange() {
        const md = editor.getMd()
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (!tm) return
          if (md.trim() === '') delete tm.dailyNotes[date]
          else tm.dailyNotes[date] = md
        })
      },
      onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId),
      onAtTrigger() {},
      onSlashTrigger() {},
    },
    lc
  )
  editor.setMd(findTeam(ctx, teamId)?.dailyNotes[date] ?? '')

  function getPeople(): AtPerson[] {
    const tm = findTeam(ctx, teamId)
    if (!tm) return []
    return [
      ...tm.stakeholders.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'stakeholders' })),
      ...tm.members.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'members' })),
    ]
  }

  const atHandle = attachAtAutocomplete(editor, { getPeople, locale: lc, onPick: () => {} })
```
to:
```ts
  const editor: Editor = createEditor(
    {
      onChange() {
        const md = editor.getMd()
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (!tm) return
          if (md.trim() === '') delete tm.dailyNotes[date]
          else tm.dailyNotes[date] = md
        })
      },
      onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId),
      onAtTrigger() {},
      onSlashTrigger() {},
      resolveRefLabel: makeRefLabelResolver(ctx.store, teamId),
    },
    lc
  )
  editor.setMd(findTeam(ctx, teamId)?.dailyNotes[date] ?? '')

  const atHandle = attachAtAutocomplete(editor, { getRefCandidates: () => teamRefCandidates(findTeam(ctx, teamId)), locale: lc, onPick: () => {} })
```

- [ ] **Step 5: `person-notes.ts`**

Change the import block:
```ts
import type { Loc, Person, Team } from '../core/types'
import { t, todayIso } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, type AtPerson } from '../ui/atref'
import { attachTemplatePicker } from '../ui/template-picker'
import { el } from '../ui/dom'
```
to:
```ts
import type { Loc, Person, Team } from '../core/types'
import { t, todayIso } from '../core/i18n'
import { teamRefCandidates } from '../core/search'
import type { ModuleCtx } from '../ui/panes'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver } from '../ui/atref'
import { attachTemplatePicker } from '../ui/template-picker'
import { el } from '../ui/dom'
```

Delete the `getPeople()` function (lines ~78-85). Change:
```ts
  const editor: Editor = createEditor(
    {
      onChange() {
        const md = editor.getMd()
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          const p = tm?.[group].find((pp) => pp.id === personId)
          if (!p) return
          p.notes = md.trim() === '' ? '' : md
        })
      },
      onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId),
      onAtTrigger() {},
      onSlashTrigger() {},
    },
    lc
  )
  editor.setMd(person.notes)

  function getPeople(): AtPerson[] {
    const tm = findTeam()
    if (!tm) return []
    return [
      ...tm.stakeholders.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'stakeholders' })),
      ...tm.members.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'members' })),
    ]
  }

  const atHandle = attachAtAutocomplete(editor, { getPeople, locale: lc, onPick: () => {} })
```
to:
```ts
  const editor: Editor = createEditor(
    {
      onChange() {
        const md = editor.getMd()
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          const p = tm?.[group].find((pp) => pp.id === personId)
          if (!p) return
          p.notes = md.trim() === '' ? '' : md
        })
      },
      onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId),
      onAtTrigger() {},
      onSlashTrigger() {},
      resolveRefLabel: makeRefLabelResolver(ctx.store, teamId),
    },
    lc
  )
  editor.setMd(person.notes)

  const atHandle = attachAtAutocomplete(editor, { getRefCandidates: () => teamRefCandidates(findTeam()), locale: lc, onPick: () => {} })
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS — this task only rewires existing call sites to already-tested functions (Tasks 1-6), so no new test file is needed; the existing suites for these 5 modules (`test/action-items.test.ts`, `test/risks.test.ts`, `test/milestones.test.ts`, `test/daily-notes.test.ts`, `test/person-notes.test.ts`) exercise `attachAtAutocomplete`/`createEditor` wiring indirectly and must still pass unchanged.

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors — in particular, confirm no file still imports the now-deleted `type AtPerson` from `'../ui/atref'` and no `getPeople` reference remains in any of the 5 files.

- [ ] **Step 8: Commit**

```bash
git add src/modules/action-items.ts src/modules/risks.ts src/modules/milestones.ts src/modules/daily-notes.ts src/modules/person-notes.ts
git commit -m "feat: wire teamRefCandidates + live label resolution into all 5 note editors"
```

---

## Task 8: Wire auto-unlink into all 5 delete call sites

**Files:**
- Modify: `src/modules/people-tree.ts:218-235`
- Modify: `src/modules/action-items.ts:161-167,191-209` (after Task 7's edits — same file, different lines)
- Modify: `src/modules/milestones.ts:232-238`
- Modify: `src/modules/risks.ts:157-164`
- Test: `test/people-tree.test.ts`, `test/action-items.test.ts`, `test/milestones.test.ts`, `test/risks.test.ts`

**Interfaces:**
- Consumes: `unlinkRefsInTeam` from `../core/refs` (Task 3).
- Produces: nothing new — this is the task that makes decision 5/9 (auto-unlink-on-delete) actually happen.

- [ ] **Step 1: Write the failing tests**

Append to `test/people-tree.test.ts` (check the file's existing fixture-building convention first — it likely already has a `setupStore`/`fixture` helper building a `Team` inside a `Doc`; reuse it, adding `notes` text with a `@[Name](person:ID)` ref on another person/field before deleting the target):

```ts
test('deleting a person unlinks every reference to them across the team\'s notes', () => {
  const doc = createEmptyDocument('pt-BR')
  doc.teams.push({
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'carla', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [{ id: 'bruno', name: 'Bruno', role: '', parentId: null, order: 0, notes: 'ping @[Carla](person:carla)' }],
    actionItems: [], milestones: [], risks: [],
    dailyNotes: { '2026-07-01': 'saw @[Carla](person:carla) today' },
  })
  const store = createStore(doc)
  store.update((d) => {
    const tm = d.teams.find((t) => t.id === 'T1')!
    unlinkRefsInTeam(tm, 'person', ['carla'])
    tm.stakeholders = deletePerson(tm.stakeholders, 'carla')
  })
  const tm = store.doc.teams[0]!
  expect(tm.members[0]!.notes).toBe('ping Carla')
  expect(tm.dailyNotes['2026-07-01']).toBe('saw Carla today')
  expect(tm.stakeholders).toEqual([])
})
```

(This test exercises the helpers directly first, as a safety net; Step 3 below wires the same call into the actual UI delete-confirm handler, and Step 4's test exercises that handler end-to-end. Add `import { unlinkRefsInTeam } from '../src/core/refs'`, `import { createStore } from '../src/core/store'`, and `import { createEmptyDocument } from '../src/core/document'` to the top of `test/people-tree.test.ts` if not already present — check the existing imports first and only add what's missing.)

Append to `test/action-items.test.ts` (using its existing store/team fixture helper — check the file for its convention, likely similar to `setupStore()` seen in `test/atref.test.ts`):

```ts
test('deleting an action item unlinks every reference to it across the team\'s notes', () => {
  // Build a store with one action item referenced from another action item's
  // notes, delete it via the same path the UI's delete-confirm button uses
  // (store.update + filter), and assert the reference was rewritten to plain
  // text first. Match this test's fixture setup to whatever helper this file
  // already uses to build a Store/Team — see the top of the file.
})
```

(Fill in the actual fixture/store construction matching this file's existing convention — the assertion is: after deleting action item `a1`, another action item's `notes` field that contained `@[Fix bug](action:a1)` now reads `Fix bug`.)

Append similar tests to `test/milestones.test.ts` and `test/risks.test.ts`, each asserting that deleting an item rewrites `@[Title](milestone:id)` / `@[Title](risk:id)` references elsewhere in the same team back to plain text, matching each file's existing fixture conventions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/people-tree.test.ts test/action-items.test.ts test/milestones.test.ts test/risks.test.ts`
Expected: FAIL — references are not yet unlinked on delete (the `unlinkRefsInTeam` calls added in Step 1 of this task exercise it directly, so that one may already pass; the UI-level ones fail until Step 3).

- [ ] **Step 3: Wire `unlinkRefsInTeam` into each delete call site**

In `src/modules/people-tree.ts`, add `import { unlinkRefsInTeam } from '../core/refs'` to the top of the file, then change:
```ts
        onClick: () => {
          ctx.store.update((d) => {
            const tm = d.teams.find((t2) => t2.id === teamId)
            if (!tm) return
            tm[group] = deletePerson(tm[group], person.id)
          })
          handle.close()
        },
```
to:
```ts
        onClick: () => {
          ctx.store.update((d) => {
            const tm = d.teams.find((t2) => t2.id === teamId)
            if (!tm) return
            unlinkRefsInTeam(tm, 'person', [person.id])
            tm[group] = deletePerson(tm[group], person.id)
          })
          handle.close()
        },
```

In `src/modules/action-items.ts`, add `import { unlinkRefsInTeam } from '../core/refs'` to the top of the file (alongside the `teamRefCandidates` import from Task 7), then change `removeItem`:
```ts
  function removeItem(id: string): void {
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      tm.actionItems = tm.actionItems.filter((i) => i.id !== id)
    })
  }
```
to:
```ts
  function removeItem(id: string): void {
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      unlinkRefsInTeam(tm, 'action', [id])
      tm.actionItems = tm.actionItems.filter((i) => i.id !== id)
    })
  }
```
and `clearZone`'s `store.update` call:
```ts
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (!tm) return
          tm.actionItems = tm.actionItems.filter((i) => i.status !== status)
        })
```
to:
```ts
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (!tm) return
          const removedIds = tm.actionItems.filter((i) => i.status === status).map((i) => i.id)
          unlinkRefsInTeam(tm, 'action', removedIds)
          tm.actionItems = tm.actionItems.filter((i) => i.status !== status)
        })
```

In `src/modules/milestones.ts`, add `import { unlinkRefsInTeam } from '../core/refs'`, then change `removeMilestone`:
```ts
  function removeMilestone(id: string): void {
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      tm.milestones = tm.milestones.filter((m) => m.id !== id)
    })
  }
```
to:
```ts
  function removeMilestone(id: string): void {
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      unlinkRefsInTeam(tm, 'milestone', [id])
      tm.milestones = tm.milestones.filter((m) => m.id !== id)
    })
  }
```

In `src/modules/risks.ts`, add `import { unlinkRefsInTeam } from '../core/refs'`, then change `removeRisk`:
```ts
  function removeRisk(id: string): void {
    if (expandedId === id) expandedId = null // local UI state; must flip before store.update fires the synchronous subscriber below
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      tm.risks = tm.risks.filter((r) => r.id !== id)
    })
  }
```
to:
```ts
  function removeRisk(id: string): void {
    if (expandedId === id) expandedId = null // local UI state; must flip before store.update fires the synchronous subscriber below
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      unlinkRefsInTeam(tm, 'risk', [id])
      tm.risks = tm.risks.filter((r) => r.id !== id)
    })
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/people-tree.test.ts test/action-items.test.ts test/milestones.test.ts test/risks.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite, typecheck, and lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all PASS — this is the point where every existing test involving delete flows in these 4 files must still pass unchanged (auto-unlink is additive to the same `store.update()`, not a behavior change to the delete/filter logic itself).

- [ ] **Step 6: Commit**

```bash
git add src/modules/people-tree.ts src/modules/action-items.ts src/modules/milestones.ts src/modules/risks.ts test/people-tree.test.ts test/action-items.test.ts test/milestones.test.ts test/risks.test.ts
git commit -m "feat: auto-unlink references on delete across all 5 delete call sites"
```

---

## Task 9: Command palette per-item entries

**Files:**
- Modify: `src/ui/panes.ts:1-56`
- Test: `test/panes.test.ts`

**Interfaces:**
- Consumes: `teamRefCandidates`, `KIND_ICON` from `../core/search` (Task 1).
- Produces: `buildModuleItems` returns additional `ModuleItem`s for action items/milestones/risks.

- [ ] **Step 1: Write the failing test**

Append to `test/panes.test.ts` (add `buildModuleItems` and `KIND_ICON` to its existing imports — `import { ..., buildModuleItems, ... } from '../src/ui/panes'` and `import { KIND_ICON } from '../src/core/search'`):

```ts
test('buildModuleItems includes one entry per action item/milestone/risk, after the whole-board entries', () => {
  const team: Team = {
    id: 'T1', name: 'Team 1', emoji: '🚀', stakeholders: [], members: [],
    actionItems: [{ id: 'a1', summary: 'Fix bug', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
    milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship v2', done: false, followup: '' }],
    risks: [{ id: 'r1', title: 'Vendor delay', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }],
    dailyNotes: {},
  }
  const items = buildModuleItems(team, 'en-US')

  expect(items).toContainEqual({ label: `${KIND_ICON.actions} Fix bug`, ref: { kind: 'actions', itemId: 'a1' } })
  expect(items).toContainEqual({ label: `${KIND_ICON.milestones} Ship v2`, ref: { kind: 'milestones', itemId: 'm1' } })
  expect(items).toContainEqual({ label: `${KIND_ICON.risks} Vendor delay`, ref: { kind: 'risks', itemId: 'r1' } })

  const actionsBoardIdx = items.findIndex((i) => i.ref.kind === 'actions' && !('itemId' in i.ref && i.ref.itemId))
  const actionItemIdx = items.findIndex((i) => i.ref.kind === 'actions' && 'itemId' in i.ref && i.ref.itemId === 'a1')
  expect(actionItemIdx).toBeGreaterThan(actionsBoardIdx)
})

test('buildModuleItems with no team omits all per-item entries (only the daily-notes entry remains)', () => {
  const items = buildModuleItems(null, 'en-US')
  expect(items).toEqual([{ label: expect.any(String), ref: { kind: 'daily', date: expect.any(String) } }])
})
```

`Team` needs importing — add `type Team` to the existing `import type { Loc } from '../src/core/types'` line (making it `import type { Loc, Team } from '../src/core/types'`), or add a separate import line if that one doesn't exist yet in this file — check first.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/panes.test.ts -t "buildModuleItems"`
Expected: FAIL — no per-item entries exist yet.

- [ ] **Step 3: Implement**

In `src/ui/panes.ts`, change the import line:
```ts
import { t, todayIso, formatDate, type Locale, type MsgKey } from '../core/i18n'
```
add a new import right after it:
```ts
import { teamRefCandidates, KIND_ICON } from '../core/search'
```

Change `buildModuleItems`:
```ts
export function buildModuleItems(team: Team | null, locale: Locale): ModuleItem[] {
  const items: ModuleItem[] = [{ label: t(locale, 'module_daily'), ref: { kind: 'daily', date: todayIso() } }]
  if (team) {
    for (const group of ['stakeholders', 'members'] as const) {
      for (const person of team[group]) {
        items.push({ label: person.name, ref: { kind: 'person', personId: person.id, group } })
      }
    }
  }
  for (const { kind, key } of FIXED_MODULE_KEYS) {
    items.push({ label: t(locale, key), ref: { kind } })
  }
  return items
}
```
to:
```ts
export function buildModuleItems(team: Team | null, locale: Locale): ModuleItem[] {
  const items: ModuleItem[] = [{ label: t(locale, 'module_daily'), ref: { kind: 'daily', date: todayIso() } }]
  if (team) {
    for (const group of ['stakeholders', 'members'] as const) {
      for (const person of team[group]) {
        items.push({ label: person.name, ref: { kind: 'person', personId: person.id, group } })
      }
    }
  }
  for (const { kind, key } of FIXED_MODULE_KEYS) {
    items.push({ label: t(locale, key), ref: { kind } })
    if (!team) continue
    if (kind === 'actions') {
      for (const it of teamRefCandidates(team).actionItems) items.push({ label: `${KIND_ICON.actions} ${it.title}`, ref: { kind: 'actions', itemId: it.id } })
    } else if (kind === 'milestones') {
      for (const m of teamRefCandidates(team).milestones) items.push({ label: `${KIND_ICON.milestones} ${m.title}`, ref: { kind: 'milestones', itemId: m.id } })
    } else if (kind === 'risks') {
      for (const r of teamRefCandidates(team).risks) items.push({ label: `${KIND_ICON.risks} ${r.title}`, ref: { kind: 'risks', itemId: r.id } })
    }
  }
  return items
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/panes.test.ts`
Expected: PASS (full file)

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/ui/panes.ts test/panes.test.ts
git commit -m "feat: palette lists individual action items/milestones/risks by name"
```

---

## Task 10: Fix palette click-to-select bug

**Files:**
- Modify: `src/ui/palette.ts:48-66`
- Test: `test/palette.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — internal bugfix only, mirrors `template-picker.ts`'s existing fix exactly.

- [ ] **Step 1: Write the failing test**

Create `test/palette.test.ts`:

```ts
import { createShell, type Shell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createPaneManager, type PaneManager } from '../src/ui/panes'
import { createPalette, type Palette } from '../src/ui/palette'

function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function setup(): { store: Store; pm: PaneManager; palette: Palette } {
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
  const shell = createShell(store)
  const pm = createPaneManager(shell, store, 'en-US')
  const palette = createPalette(store, pm)
  return { store, pm, palette }
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('clicking a row (not just Enter) commits it and closes the palette', () => {
  const { palette } = setup()
  palette.open()

  const rows = document.querySelectorAll('.tt-palette-item')
  expect(rows.length).toBeGreaterThan(0)
  const carlaRow = Array.from(rows).find((r) => r.textContent === 'Carla')!

  carlaRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  carlaRow.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
  carlaRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
})

test('hovering a row does not replace its DOM node (real-browser click requires mousedown/mouseup on the same element)', () => {
  const { palette } = setup()
  palette.open()

  const rowsBefore = Array.from(document.querySelectorAll('.tt-palette-item'))
  expect(rowsBefore.length).toBeGreaterThan(1)
  rowsBefore[1]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
  const rowsAfter = Array.from(document.querySelectorAll('.tt-palette-item'))

  expect(rowsAfter[0]).toBe(rowsBefore[0])
  expect(rowsAfter[1]).toBe(rowsBefore[1])
  expect(rowsAfter[1]!.classList.contains('selected')).toBe(true)
  expect(rowsAfter[0]!.classList.contains('selected')).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/palette.test.ts`
Expected: FAIL on the first test (click does nothing — `.tt-palette-overlay` is still present) — this is the bug. The second test may already pass or fail depending on jsdom's exact event timing; note whichever it is before moving on.

- [ ] **Step 3: Implement**

In `src/ui/palette.ts`, change `renderList`:
```ts
  function renderList(): void {
    if (!listEl) return
    listEl.innerHTML = ''
    filtered.forEach((item, i) => {
      const row = el(
        'div',
        {
          class: 'tt-palette-item' + (i === selected ? ' selected' : ''),
          onclick: () => commit(item),
          onmouseenter: () => {
            selected = i
            renderList()
          },
        },
        item.label
      )
      listEl!.appendChild(row)
    })
  }
```
to:
```ts
  function renderList(): void {
    if (!listEl) return
    listEl.innerHTML = ''
    filtered.forEach((item, i) => {
      const row = el(
        'div',
        {
          class: 'tt-palette-item' + (i === selected ? ' selected' : ''),
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: () => commit(item),
          // See src/ui/template-picker.ts's and src/ui/atref.ts's identical
          // fix: rebuilding every row on hover (via renderList()) made real
          // Chrome re-fire mouseenter on the replacement node under a
          // stationary pointer, looping forever and leaving mousedown/mouseup
          // on two different elements — so no click event ever fired.
          onmouseenter: () => { selected = i; updateSelectedClass() },
        },
        item.label
      )
      listEl!.appendChild(row)
    })
  }

  function updateSelectedClass(): void {
    if (!listEl) return
    Array.from(listEl.children).forEach((child, i) => child.classList.toggle('selected', i === selected))
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/palette.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Run the full suite, typecheck, and lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui/palette.ts test/palette.test.ts
git commit -m "fix: palette rows are clickable (mouseenter/rebuild race, same fix as atref/template-picker)"
```

---

## Task 11: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all test files PASS, no skipped/todo tests left behind.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors, no unused imports (in particular, confirm `AtPerson` is no longer imported anywhere except its `core/search.ts` definition and `ui/atref.ts`'s re-export).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: `dist/app.html` and `dist/pwa/` build without errors.

- [ ] **Step 5: Manual smoke test**

Use the `run` skill to launch the built app and, in a real browser, exercise the golden path end-to-end:
1. Open a team with at least one action item, one milestone, and one risk.
2. In a daily note, type `@` — confirm the dropdown shows People/Dates group headers, all 3 relative days appear immediately, and clicking (not just arrow+Enter) a row inserts a chip.
3. Type `@` followed by a few letters of an action item's title — confirm it appears under an "Action Items" group header with the ✅ icon on the inserted chip, and clicking the chip navigates to that specific card (scrolled into view).
4. Repeat for a milestone and a risk mention.
5. Rename the referenced action item — confirm the chip in the daily note now shows the new title without re-opening the note.
6. Delete that action item — confirm the chip in the daily note is now plain text (no longer a clickable link).
7. Press Ctrl+K, type part of a milestone's title — confirm it appears as its own entry (not just the "Milestones" board entry) and clicking it (not just Enter) navigates there.

- [ ] **Step 6: Report results**

If all steps pass, the feature is complete — no further commit needed for this task (verification only). If any step fails, return to the relevant task above, fix, and re-run that task's tests before re-verifying here.

---

## Self-Review Notes

- **Spec coverage:** all 5 numbered goals from the design doc (extend @ mentions, @today discoverability, palette parity, live labels, auto-unlink-on-delete) map to Tasks 1-9; the palette click bugfix (goal 6) is Task 10. All 10 numbered decisions in the spec are reflected: grouping/cap (Task 4), item-status-not-filtered (no filtering added anywhere, so done/cancelled/closed items are naturally still included — verified implicitly since `teamRefCandidates` and `collectCandidates` never check status), chip icons via CSS (Task 5), `teamRefCandidates` data plumbing (Task 1), dangling-ref behavior + person toast removal (Task 5), palette flat/uncapped (Task 9, no cap added), delete scope uniform across 4 kinds (Task 8), rename scope limited to editor chips not search snippets (Task 2/6, search.ts is untouched by this plan).
- **Placeholder scan:** no TBD/TODO left except one deliberately-scoped placeholder in Task 8 Step 1 (the `test/action-items.test.ts` fixture body) — flagged inline with an explanation of what to fill in and why, since this plan doesn't have that file's exact existing fixture helper in hand; the `people-tree.ts` test in the same step is fully written out as the concrete pattern to mirror.
- **Type consistency:** `AtItem`, `TeamRefCandidates`, `RefCandidate`, `LabelResolver`, `RefKind` are each defined exactly once (Tasks 1-4) and referenced with identical names/shapes in every later task. `makeRefLabelResolver`/`makeRefClickHandler`/`teamRefCandidates`/`unlinkRefsInTeam` signatures are declared in their producing task's Interfaces block and used verbatim by every consuming task.
