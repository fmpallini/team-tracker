# Expand + Highlight Collapsible Items from Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a search result lands on a milestone/risk whose match lives only in the collapsed follow-up editor, auto-expand that row and highlight the matched text. Also fix a real bug this surfaced: action-item search results with a notes-only match (notes live only in the edit modal) currently scroll/highlight *nothing at all*, because the scroll target is derived from the first painted text match instead of the already-resolved card.

**Architecture:** `search-ui.ts`'s `commit()` dispatches a small transient `CustomEvent` (itemId only) on the target pane's body element right after navigating there. `milestones.ts`/`risks.ts` each add one listener (cleaned up via their existing per-container disposer) that expands the matching row if collapsed. `applySearchHighlight` is generalized to accept multiple highlight-root elements (so it can span a title row + its separate follow-up sibling) and an explicit `scrollTarget` that always wins over "wherever the first text match happened to land" — this is what fixes the action-items bug.

**Tech Stack:** TypeScript, Vitest + jsdom, no new runtime dependencies (zero-runtime-dep constraint from CLAUDE.md).

## Global Constraints

- Zero runtime dependencies — everything here is plain TS/DOM, no new packages.
- Every `src` module has a matching `test/*.test.ts` — new tests go in the existing files for `expandable-followup.ts`, `search-highlight.ts`, `milestones.ts`, `risks.ts`; the two full-stack scenarios get a new `test/search-expand-highlight.test.ts`.
- i18n is not touched by this plan — no new user-visible strings.
- Full spec: `docs/superpowers/specs/2026-07-25-search-expand-highlight-design.md`.

---

### Task 1: `ExpandableRowsController.expand(id)`

**Files:**
- Modify: `src/ui/expandable-followup.ts:36-38`
- Test: `test/expandable-followup.test.ts`

**Interfaces:**
- Produces: `ExpandableRowsController.prototype.expand(id: string): void` — adds `id` to the expanded set (idempotent if already expanded). Mirrors the existing `collapse(id)`. Used by Task 3 and Task 4.

- [ ] **Step 1: Write the failing test**

Add to `test/expandable-followup.test.ts` (after the existing `'collapse drops the id...'` test):

```ts
test('expand adds the id to the expanded set, idempotently', () => {
  const c = new ExpandableRowsController()
  expect(c.isExpanded('x')).toBe(false)
  c.expand('x')
  expect(c.isExpanded('x')).toBe(true)
  c.expand('x') // calling again is a no-op, not an error
  expect(c.isExpanded('x')).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/expandable-followup.test.ts`
Expected: FAIL with `c.expand is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/ui/expandable-followup.ts`, current lines 36-38:

```ts
  /** Drops `id` from the expanded set without disposing its bundle — for a row about to be deleted via store.update anyway, where the next render() rebuilds nothing for it. */
  collapse(id: string): void {
    this.expandedIds.delete(id)
  }
```

Insert a new method directly above `collapse`:

```ts
  /** Adds `id` to the expanded set. Idempotent — expanding an already-expanded id is a no-op. */
  expand(id: string): void {
    this.expandedIds.add(id)
  }

  /** Drops `id` from the expanded set without disposing its bundle — for a row about to be deleted via store.update anyway, where the next render() rebuilds nothing for it. */
  collapse(id: string): void {
    this.expandedIds.delete(id)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/expandable-followup.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/expandable-followup.ts test/expandable-followup.test.ts
git commit -m "feat: add ExpandableRowsController.expand(id)"
```

---

### Task 2: `search-highlight.ts` — multi-root highlighting + explicit scroll target

**Files:**
- Modify: `src/ui/search-highlight.ts` (whole file is 71 lines; `applySearchHighlight` is lines 44-63)
- Test: `test/search-highlight.test.ts`

**Interfaces:**
- Consumes: `findMatchRanges(rootEl: HTMLElement, terms: string[]): Range[]` (unchanged, from this same file).
- Produces:
  - `SEARCH_FOCUS_ITEM_EVENT: string` — event name constant.
  - `dispatchSearchFocusItem(container: HTMLElement, itemId: string): void` — dispatches that event on `container` with `detail: itemId`. Used by Task 5 (dispatch side) and Tasks 3/4 (listener side, via the constant).
  - `applySearchHighlight(rootEls: HTMLElement[], terms: string[], scrollTarget?: HTMLElement): void` — **signature change** from `applySearchHighlight(rootEl: HTMLElement, terms: string[])`. Used by Task 5.

This is the task that fixes the actual reported bug: today `commit()` derives the scroll target from `ranges[0]` (the first painted text match). When a search hit comes from an action item's `notes` field (never rendered on the card), zero ranges are found and nothing scrolls, focuses, or highlights at all. An explicit `scrollTarget`, when given, always wins.

- [ ] **Step 1: Write the failing tests**

Replace the existing `'applySearchHighlight is a safe no-op without CSS.highlights'` test in `test/search-highlight.test.ts` (it currently passes a bare element, which won't compile once the signature changes) and add new coverage. Full new contents of `test/search-highlight.test.ts`:

```ts
import { findMatchRanges, applySearchHighlight, clearSearchHighlight, SEARCH_FOCUS_ITEM_EVENT, dispatchSearchFocusItem } from '../src/ui/search-highlight'

afterEach(() => {
  document.body.innerHTML = ''
})

test('finds accent-insensitive match ranges across text nodes', () => {
  const root = document.createElement('div')
  root.innerHTML = '<p>Orçamento <b>aprovado</b> ontem</p>'
  const ranges = findMatchRanges(root, ['orcamento', 'aprovado'])
  expect(ranges.length).toBe(2)
  expect(ranges[0]!.toString()).toBe('Orçamento')
})

test('findMatchRanges ignores empty terms and terms with no match', () => {
  const root = document.createElement('div')
  root.textContent = 'hello world'
  expect(findMatchRanges(root, ['', 'zzz'])).toEqual([])
})

test('applySearchHighlight is a safe no-op without CSS.highlights', () => {
  const root = document.createElement('div')
  root.textContent = 'nada'
  expect(() => applySearchHighlight([root], ['x'])).not.toThrow()
})

test('combines match ranges from multiple root elements, scrolling to a match found in a later root', () => {
  const rootA = document.createElement('div')
  rootA.textContent = 'nothing relevant here'
  const rootB = document.createElement('div')
  rootB.textContent = 'has target word'
  rootB.scrollIntoView = vi.fn()

  applySearchHighlight([rootA, rootB], ['target'])

  expect(rootB.scrollIntoView).toHaveBeenCalled()
})

test('an explicit scrollTarget wins even when no text ranges match at all (fixes action-item cards with a notes-only match never scrolling into view)', () => {
  const root = document.createElement('div')
  root.textContent = 'nothing on this card matches'
  const card = document.createElement('div')
  card.scrollIntoView = vi.fn()

  applySearchHighlight([root], ['zzz'], card)

  expect(card.scrollIntoView).toHaveBeenCalled()
})

test('an explicit scrollTarget takes precedence over a found text range', () => {
  const root = document.createElement('div')
  root.textContent = 'target word'
  root.scrollIntoView = vi.fn()
  const card = document.createElement('div')
  card.scrollIntoView = vi.fn()

  applySearchHighlight([root], ['target'], card)

  expect(card.scrollIntoView).toHaveBeenCalled()
  expect(root.scrollIntoView).not.toHaveBeenCalled()
})

test('clearSearchHighlight is a safe no-op when nothing was ever highlighted', () => {
  expect(() => clearSearchHighlight()).not.toThrow()
})

test('dispatchSearchFocusItem dispatches the event on the given container with itemId as detail', () => {
  const container = document.createElement('div')
  let received: string | null = null
  container.addEventListener(SEARCH_FOCUS_ITEM_EVENT, (e) => { received = (e as CustomEvent<string>).detail })

  dispatchSearchFocusItem(container, 'm1')

  expect(received).toBe('m1')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search-highlight.test.ts`
Expected: FAIL — `SEARCH_FOCUS_ITEM_EVENT`/`dispatchSearchFocusItem` not exported, and `applySearchHighlight([root], ...)` type errors against the current single-element signature (surfaces as a TS compile failure under vitest).

- [ ] **Step 3: Write minimal implementation**

Replace the full contents of `src/ui/search-highlight.ts`:

```ts
// src/ui/search-highlight.ts — paints search-term matches in the module a
// search result navigated to, via the CSS Custom Highlight API (no DOM
// mutation, unlike search-ui.ts's <mark>-based snippet highlighter — this
// walks the *live*, already-rendered module DOM, which callers must not
// have their own rendering logic mutate mid-match).
import { normalize } from '../core/search'

const HIGHLIGHT_NAME = 'tt-search'

/** Fired on a pane's `.tt-pane-body` element right after a search result navigates there, carrying the result's `itemId` (if any) as `detail`. Modules with collapsible per-item content (milestones.ts, risks.ts) listen for this to auto-expand the matching row before highlighting runs. Modules that don't listen simply never see any effect — safe no-op. */
export const SEARCH_FOCUS_ITEM_EVENT = 'tt-search-focus-item'

/** Dispatches SEARCH_FOCUS_ITEM_EVENT on `container` with `itemId` as `detail`. */
export function dispatchSearchFocusItem(container: HTMLElement, itemId: string): void {
  container.dispatchEvent(new CustomEvent<string>(SEARCH_FOCUS_ITEM_EVENT, { detail: itemId }))
}

/**
 * Walks text nodes under `rootEl`, finds `normalize()`-matched term
 * positions and returns a `Range` per match. `normalize()` preserves
 * character count for the accented Latin text this app handles (same
 * guarantee search-ui.ts's snippet highlighter relies on), so a match index
 * found in a text node's normalized content can be sliced directly from
 * that same node's original text.
 */
export function findMatchRanges(rootEl: HTMLElement, terms: string[]): Range[] {
  const cleanTerms = terms.filter(Boolean)
  if (cleanTerms.length === 0) return []

  const ranges: Range[] = []
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? ''
    const normalized = normalize(text)
    for (const term of cleanTerms) {
      let from = 0
      for (;;) {
        const idx = normalized.indexOf(term, from)
        if (idx < 0) break
        const range = document.createRange()
        range.setStart(node, idx)
        range.setEnd(node, idx + term.length)
        ranges.push(range)
        from = idx + term.length
      }
    }
  }
  return ranges
}

/**
 * Paints `terms`' matches across every root in `rootEls` via `CSS.highlights`
 * (no-op where unsupported — e.g. jsdom, or a browser without the Custom
 * Highlight API) and scrolls a target into view. `scrollTarget`, when given,
 * always wins as the scroll destination over the first painted match —
 * callers pass it when they've already resolved exactly which element a
 * search result belongs to (e.g. a specific milestone row or kanban card),
 * so scrolling there doesn't depend on whether any of that element's
 * *currently visible* text happens to match (it may not — e.g. an action
 * item's notes field only exists inside its edit modal). Without an explicit
 * target, falls back to the first match's containing element, or does
 * nothing if there are no matches. Safe to call unconditionally.
 */
export function applySearchHighlight(rootEls: HTMLElement[], terms: string[], scrollTarget?: HTMLElement): void {
  const ranges = rootEls.flatMap((rootEl) => findMatchRanges(rootEl, terms))
  if (typeof CSS !== 'undefined' && 'highlights' in CSS && CSS.highlights) {
    if (ranges.length === 0) {
      CSS.highlights.delete(HIGHLIGHT_NAME)
    } else {
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges))
    }
  }
  const first = ranges[0]
  const target = scrollTarget ?? (first && (first.startContainer instanceof Element ? first.startContainer : first.startContainer.parentElement))
  target?.scrollIntoView({ block: 'center' })
}

/** Clears any highlight painted by `applySearchHighlight`. Safe to call even if nothing was ever highlighted. */
export function clearSearchHighlight(): void {
  if (typeof CSS !== 'undefined' && 'highlights' in CSS && CSS.highlights) {
    CSS.highlights.delete(HIGHLIGHT_NAME)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/search-highlight.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Run typecheck** (the old single-root call signature would now be a type error anywhere it's still used — confirms nothing else in `src/` needs updating yet since Task 5 hasn't touched `search-ui.ts` yet; this step exists to catch any other unexpected caller)

Run: `npm run typecheck`
Expected: FAIL — `src/ui/search-ui.ts` still calls `applySearchHighlight(anchor ?? paneEl, terms)` with a single element. This is expected; Task 5 fixes it. Confirm the *only* error is in `search-ui.ts`, then proceed.

- [ ] **Step 6: Commit**

```bash
git add src/ui/search-highlight.ts test/search-highlight.test.ts
git commit -m "feat: multi-root search highlighting with an explicit scroll target

Fixes action-item search results with a notes-only match doing nothing
at all: the scroll target was derived from the first painted text
range, which is empty when the match lives only in the notes field
(modal-only, never rendered on the card)."
```

(Leaving `search-ui.ts` red between Task 2 and Task 5 is expected and intentional — Task 5 is next.)

---

### Task 3: `milestones.ts` — expand on search focus

**Files:**
- Modify: `src/modules/milestones.ts:1-24` (imports), `:178-197` (`renderFollowupRow`), `:470-496` (subscribe + container mount + disposer)
- Test: `test/milestones.test.ts`

**Interfaces:**
- Consumes: `ExpandableRowsController.expand(id)` (Task 1), `SEARCH_FOCUS_ITEM_EVENT` (Task 2).
- Produces: no new exports — this is pure internal wiring inside `renderMilestones`.

- [ ] **Step 1: Write the failing tests**

Add to `test/milestones.test.ts`. First, add the import at the top of the file (alongside the existing imports):

```ts
import { SEARCH_FOCUS_ITEM_EVENT } from '../src/ui/search-highlight'
```

Then add these tests (a good spot is right after the existing expand/collapse-button tests, roughly after line 500 — search for the last test using `.tt-milestone-expand-btn` and add after it):

```ts
describe('search-focus-item event', () => {
  test('expands a collapsed milestone and mounts its follow-up editor', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'm1', followup: 'buried text' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    expect(container.querySelector('.tt-milestone-followup-row')).toBeNull()

    container.dispatchEvent(new CustomEvent(SEARCH_FOCUS_ITEM_EVENT, { detail: 'm1' }))

    const editorEl = container.querySelector('.tt-milestone-followup-row .editor') as HTMLElement
    expect(editorEl).not.toBeNull()
    expect(editorEl.textContent).toContain('buried text')
  })

  test('is a no-op for an id that is not one of this team\'s milestones', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'm1' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    container.dispatchEvent(new CustomEvent(SEARCH_FOCUS_ITEM_EVENT, { detail: 'does-not-exist' }))

    expect(container.querySelector('.tt-milestone-followup-row')).toBeNull()
  })

  test('is a no-op (no duplicate row) when the milestone is already expanded', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'm1' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    container.querySelector<HTMLButtonElement>('.tt-milestone-expand-btn')!.click()

    container.dispatchEvent(new CustomEvent(SEARCH_FOCUS_ITEM_EVENT, { detail: 'm1' }))

    expect(container.querySelectorAll('.tt-milestone-followup-row').length).toBe(1)
  })

  test('the follow-up row carries the same data-item-id as its title row', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'm1' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    container.querySelector<HTMLButtonElement>('.tt-milestone-expand-btn')!.click()

    const followupRow = container.querySelector('.tt-milestone-followup-row') as HTMLElement
    expect(followupRow.getAttribute('data-item-id')).toBe('m1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/milestones.test.ts`
Expected: FAIL — the new `describe` block's tests fail (event has no listener yet, `data-item-id` missing on the follow-up row); other existing tests in the file still pass.

- [ ] **Step 3: Write minimal implementation**

In `src/modules/milestones.ts`, add the import (current line 18, alongside `ExpandableRowsController`):

```ts
import { ExpandableRowsController } from '../ui/expandable-followup'
```
becomes:
```ts
import { ExpandableRowsController } from '../ui/expandable-followup'
import { SEARCH_FOCUS_ITEM_EVENT } from '../ui/search-highlight'
```

Current lines 178-197 (`renderFollowupRow`):

```ts
  /** Full rich editor for a milestone's follow-up, via src/ui/rich-editor.ts's createRichEditorBundle (editor + @ref autocomplete + '/' template picker), scoped to 'any' templates. Registers itself with `expandable` so the caller can dispose it later. */
  function renderFollowupRow(m: Milestone): HTMLElement {
    const bundle = createRichEditorBundle({
      store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
      initialMd: m.followup,
      onChange: (md) => {
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          const found = tm?.milestones.find((mm) => mm.id === m.id)
          if (!found) return
          found.followup = md.trim() === '' ? '' : md
        })
      },
      getTeam: () => findTeam(),
      getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
      getTemplateCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), teamName: findTeam()?.name, locale: lc }),
    })
    expandable.register(m.id, bundle)
    return el('div', { class: 'tt-milestone-followup-row', 'data-milestone-followup-id': m.id }, bundle.editor.root)
  }
```

Change only the final `return` line, adding `data-item-id` alongside the existing marker:

```ts
    expandable.register(m.id, bundle)
    return el('div', { class: 'tt-milestone-followup-row', 'data-milestone-followup-id': m.id, 'data-item-id': m.id }, bundle.editor.root)
  }
```

Current lines 470-496 (subscribe, container mount, disposer):

```ts
  const unsubscribe = ctx.store.subscribe(() => {
    const active = focusedCaretInput()
    if (active) {
      active.addEventListener('blur', () => renderAll(), { once: true })
      return
    }
    renderAll()
  })

  container.appendChild(el('div', { class: 'tt-milestones' }, timelineEl, toolbar, listEl))
  renderAll()

  disposers.set(container, () => {
    unsubscribe()
    expandable.disposeAll()
  })
}
```

Replace with:

```ts
  const unsubscribe = ctx.store.subscribe(() => {
    const active = focusedCaretInput()
    if (active) {
      active.addEventListener('blur', () => renderAll(), { once: true })
      return
    }
    renderAll()
  })

  /** Expands the milestone a search result pointed at, if it's currently collapsed, so its follow-up text (what the search actually matched) becomes visible. No-op if the id isn't one of this team's milestones or is already expanded. */
  function onSearchFocusItem(e: Event): void {
    const itemId = (e as CustomEvent<string>).detail
    if (!milestones().some((m) => m.id === itemId)) return
    if (expandable.isExpanded(itemId)) return
    expandable.expand(itemId)
    renderAll()
  }
  container.addEventListener(SEARCH_FOCUS_ITEM_EVENT, onSearchFocusItem)

  container.appendChild(el('div', { class: 'tt-milestones' }, timelineEl, toolbar, listEl))
  renderAll()

  disposers.set(container, () => {
    unsubscribe()
    expandable.disposeAll()
    container.removeEventListener(SEARCH_FOCUS_ITEM_EVENT, onSearchFocusItem)
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/milestones.test.ts`
Expected: PASS (all tests, including the new `describe('search-focus-item event', ...)` block)

- [ ] **Step 5: Commit**

```bash
git add src/modules/milestones.ts test/milestones.test.ts
git commit -m "feat(milestones): auto-expand a row when a search result points at it"
```

---

### Task 4: `risks.ts` — expand on search focus

**Files:**
- Modify: `src/modules/risks.ts:1-22` (imports), `:191-210` (`renderFollowupRow`), `:493-508` (subscribe + container mount + disposer)
- Test: `test/risks.test.ts`

**Interfaces:**
- Consumes: `ExpandableRowsController.expand(id)` (Task 1), `SEARCH_FOCUS_ITEM_EVENT` (Task 2).
- Produces: no new exports — mirrors Task 3, for risks.

This task is the exact mirror of Task 3 for `risks.ts`. Same shape, different field names (`r`/`risks()`/`risk-followup-id`/`risk-expand-btn`).

- [ ] **Step 1: Write the failing tests**

Add to `test/risks.test.ts`. Import at the top:

```ts
import { SEARCH_FOCUS_ITEM_EVENT } from '../src/ui/search-highlight'
```

Tests (place after the existing expand/collapse-button coverage):

```ts
describe('search-focus-item event', () => {
  test('expands a collapsed risk and mounts its follow-up editor', () => {
    const team = makeTeam({ risks: [risk({ id: 'r1', followup: 'buried text' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    expect(container.querySelector('.tt-risk-followup-row')).toBeNull()

    container.dispatchEvent(new CustomEvent(SEARCH_FOCUS_ITEM_EVENT, { detail: 'r1' }))

    const editorEl = container.querySelector('.tt-risk-followup-row .editor') as HTMLElement
    expect(editorEl).not.toBeNull()
    expect(editorEl.textContent).toContain('buried text')
  })

  test('is a no-op for an id that is not one of this team\'s risks', () => {
    const team = makeTeam({ risks: [risk({ id: 'r1' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    container.dispatchEvent(new CustomEvent(SEARCH_FOCUS_ITEM_EVENT, { detail: 'does-not-exist' }))

    expect(container.querySelector('.tt-risk-followup-row')).toBeNull()
  })

  test('is a no-op (no duplicate row) when the risk is already expanded', () => {
    const team = makeTeam({ risks: [risk({ id: 'r1' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()

    container.dispatchEvent(new CustomEvent(SEARCH_FOCUS_ITEM_EVENT, { detail: 'r1' }))

    expect(container.querySelectorAll('.tt-risk-followup-row').length).toBe(1)
  })

  test('the follow-up row carries the same data-item-id as its title row', () => {
    const team = makeTeam({ risks: [risk({ id: 'r1' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()

    const followupRow = container.querySelector('.tt-risk-followup-row') as HTMLElement
    expect(followupRow.getAttribute('data-item-id')).toBe('r1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/risks.test.ts`
Expected: FAIL — the new `describe` block's tests fail; other existing tests still pass.

- [ ] **Step 3: Write minimal implementation**

In `src/modules/risks.ts`, add the import (current line 17, alongside `ExpandableRowsController`):

```ts
import { ExpandableRowsController } from '../ui/expandable-followup'
```
becomes:
```ts
import { ExpandableRowsController } from '../ui/expandable-followup'
import { SEARCH_FOCUS_ITEM_EVENT } from '../ui/search-highlight'
```

Current lines 191-210 (`renderFollowupRow`) — change only the final `return` line:

```ts
    expandable.register(r.id, bundle)
    return el('div', { class: 'tt-risk-followup-row', 'data-risk-followup-id': r.id }, bundle.editor.root)
  }
```
becomes:
```ts
    expandable.register(r.id, bundle)
    return el('div', { class: 'tt-risk-followup-row', 'data-risk-followup-id': r.id, 'data-item-id': r.id }, bundle.editor.root)
  }
```

Current lines 493-508 (subscribe, container mount, disposer):

```ts
  const unsubscribe = ctx.store.subscribe(() => {
    const active = focusedCaretElement()
    if (active) {
      active.addEventListener('blur', () => renderAll(), { once: true })
      return
    }
    renderAll()
  })

  container.appendChild(el('div', { class: 'tt-risks' }, toolbar, headerRow, listEl, closedEl))
  renderAll()

  disposers.set(container, () => {
    unsubscribe()
    expandable.disposeAll()
  })
}
```

Replace with:

```ts
  const unsubscribe = ctx.store.subscribe(() => {
    const active = focusedCaretElement()
    if (active) {
      active.addEventListener('blur', () => renderAll(), { once: true })
      return
    }
    renderAll()
  })

  /** Expands the risk a search result pointed at, if it's currently collapsed, so its follow-up text (what the search actually matched) becomes visible. No-op if the id isn't one of this team's risks or is already expanded. */
  function onSearchFocusItem(e: Event): void {
    const itemId = (e as CustomEvent<string>).detail
    if (!risks().some((r) => r.id === itemId)) return
    if (expandable.isExpanded(itemId)) return
    expandable.expand(itemId)
    renderAll()
  }
  container.addEventListener(SEARCH_FOCUS_ITEM_EVENT, onSearchFocusItem)

  container.appendChild(el('div', { class: 'tt-risks' }, toolbar, headerRow, listEl, closedEl))
  renderAll()

  disposers.set(container, () => {
    unsubscribe()
    expandable.disposeAll()
    container.removeEventListener(SEARCH_FOCUS_ITEM_EVENT, onSearchFocusItem)
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/risks.test.ts`
Expected: PASS (all tests, including the new `describe('search-focus-item event', ...)` block)

- [ ] **Step 5: Commit**

```bash
git add src/modules/risks.ts test/risks.test.ts
git commit -m "feat(risks): auto-expand a row when a search result points at it"
```

---

### Task 5: `search-ui.ts` wiring + milestones end-to-end test

**Files:**
- Modify: `src/ui/search-ui.ts:11` (import), `:196-202` (`commit()`'s rAF callback)
- Test: Create `test/search-expand-highlight.test.ts`

**Interfaces:**
- Consumes: `dispatchSearchFocusItem`, `applySearchHighlight(rootEls, terms, scrollTarget?)` (Task 2); `renderMilestones` (`src/modules/milestones.ts`, unchanged export, now with Task 3's behavior); `mountSearch`, `createPaneManager` (unchanged exports).
- Produces: no new exports — this task closes the loop between search and the module-level expand behavior from Tasks 3/4, and is what actually exercises Task 2's `scrollTarget` fix end-to-end.

This is the task that fixes the reported bug for real (Task 2 only fixed the underlying primitive) — `commit()` now resolves *every* element sharing the result's `data-item-id` (title row + expanded follow-up, once Task 3/4's listener has run) as highlight roots, and always passes the first resolved anchor as the scroll target instead of relying on where a text match happened to land.

- [ ] **Step 1: Write the failing test**

Create `test/search-expand-highlight.test.ts`:

```ts
import { mountSearch } from '../src/ui/search-ui'
import { createShell, type Shell } from '../src/ui/shell'
import { createPaneManager } from '../src/ui/panes'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { renderMilestones } from '../src/modules/milestones'
import type { Team } from '../src/core/types'

// jsdom does not implement matchMedia; createShell() needs it to watch the
// OS theme preference (same stub as test/panes.test.ts and test/search-ui.test.ts).
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

function buildTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team One', emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}

function setup(team: Team): { shell: Shell; store: Store; input: HTMLInputElement } {
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const pm = createPaneManager(shell, store, 'en-US')
  pm.registerModule('milestones', renderMilestones)
  mountSearch(shell, store, pm, () => {})
  const input = shell.headerLeft.querySelector('.tt-search-input') as HTMLInputElement
  return { shell, store, input }
}

/** Runs a search, captures the requestAnimationFrame callback commit() schedules (without letting it fire yet), and clicks the first result. Returns the captured callback so the test can inspect DOM state *before* the highlight/expand pass runs, then invoke it. */
function search(input: HTMLInputElement, query: string): FrameRequestCallback {
  vi.useFakeTimers()
  let raf: FrameRequestCallback | null = null
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number => { raf = cb; return 0 }) as typeof window.requestAnimationFrame

  input.value = query
  input.dispatchEvent(new Event('input', { bubbles: true }))
  vi.advanceTimersByTime(200) // past the 150ms debounce
  vi.useRealTimers()

  const row = document.querySelector('.tt-search-row') as HTMLElement
  if (!row) throw new Error(`no search result for "${query}"`)
  row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

  if (!raf) throw new Error('commit() did not schedule a requestAnimationFrame callback')
  return raf
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('a search result matching only a milestone\'s follow-up text expands that row and scrolls to it', () => {
  const team = buildTeam({ milestones: [{ id: 'm1', date: '2026-01-01', title: 'Kickoff', done: false, followup: 'buried-unique-term' }] })
  const { store, input } = setup(team)

  const raf = search(input, 'buried-unique-term')

  // Before the deferred highlight pass runs, the row is still collapsed —
  // the search-focus-item dispatch (and the resulting expand) happens inside it.
  expect(document.querySelector('.tt-milestone-followup-row')).toBeNull()

  const row = document.querySelector('[data-item-id="m1"]') as HTMLElement
  row.scrollIntoView = vi.fn()

  raf(0)

  const editorEl = document.querySelector('.tt-milestone-followup-row .editor') as HTMLElement
  expect(editorEl).not.toBeNull()
  expect(editorEl.textContent).toContain('buried-unique-term')
  expect(store.doc.nav.focusedPane).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search-expand-highlight.test.ts`
Expected: FAIL — the follow-up row never appears after `raf(0)` runs, because `commit()` doesn't dispatch `SEARCH_FOCUS_ITEM_EVENT` yet.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/search-ui.ts`, current line 11:

```ts
import { applySearchHighlight } from './search-highlight'
```
becomes:
```ts
import { applySearchHighlight, dispatchSearchFocusItem } from './search-highlight'
```

Current lines 196-202 (inside `commit()`):

```ts
    requestAnimationFrame(() => {
      const paneEl = document.querySelectorAll('.tt-pane-body')[store.doc.nav.focusedPane] as HTMLElement | undefined
      if (!paneEl) return
      const ref = result.loc.ref
      const anchor = 'itemId' in ref && ref.itemId ? paneEl.querySelector(`[data-item-id="${ref.itemId}"]`) : null
      applySearchHighlight((anchor as HTMLElement) ?? paneEl, terms)
    })
```

Replace with:

```ts
    requestAnimationFrame(() => {
      const paneEl = document.querySelectorAll('.tt-pane-body')[store.doc.nav.focusedPane] as HTMLElement | undefined
      if (!paneEl) return
      const ref = result.loc.ref
      const itemId = 'itemId' in ref ? ref.itemId : undefined
      // No-op for modules that don't listen (action-items, daily/person notes).
      // For milestones/risks, this expands the matching row (if collapsed)
      // before the anchor lookup below, so its follow-up text is in the DOM
      // to highlight.
      if (itemId) dispatchSearchFocusItem(paneEl, itemId)
      const anchors = itemId
        ? Array.from(paneEl.querySelectorAll<HTMLElement>(`[data-item-id="${itemId}"]`))
        : []
      // anchors[0], not a range-derived position, is the scroll target: we
      // already know exactly which element this result belongs to, and that
      // must win even if none of its *currently visible* text matches (e.g.
      // an action item's notes field, which only exists in its edit modal).
      applySearchHighlight(anchors.length > 0 ? anchors : [paneEl], terms, anchors[0])
    })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/search-expand-highlight.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck** (Task 2 deliberately left `search-ui.ts` red; confirm it's clean now, and nothing else regressed)

Run: `npm run typecheck && npx vitest run`
Expected: both PASS, 0 failures

- [ ] **Step 6: Commit**

```bash
git add src/ui/search-ui.ts test/search-expand-highlight.test.ts
git commit -m "feat(search): expand+highlight collapsed milestone/risk rows on search navigation"
```

---

### Task 6: Action-items regression test (notes-only match now scrolls/focuses the card)

**Files:**
- Test: `test/search-expand-highlight.test.ts` (append)

**Interfaces:**
- Consumes: everything from Task 5 (no production code changes in this task — it's the regression test proving the originally-reported bug is fixed end-to-end).

Note: this task's test needs the `'actions'` module registered, while Task 5's `setup()` helper only registers `'milestones'` — it's a self-contained test with its own local `pm`/`shell`/`store`, not built through `setup()`.

- [ ] **Step 1: Write the test**

Append to `test/search-expand-highlight.test.ts`. First add the extra import at the top of the file:

```ts
import { renderActionItems } from '../src/modules/action-items'
```

Then add:

```ts
test('a search result matching only an action item\'s notes (modal-only field) still scrolls the card into view (regression: previously did nothing — no scroll, no focus, no highlight)', () => {
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  doc.teams.push(buildTeam({
    actionItems: [{
      id: 'a1', summary: 'Ship v2', notes: 'blocked-on-xyz-vendor',
      status: 'todo', dueDate: null, assignee: '', color: 'slate', order: 0,
    }],
  }))
  doc.nav.activeTeamId = 'T1'
  const store = createStore(doc)
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const pm = createPaneManager(shell, store, 'en-US')
  pm.registerModule('actions', renderActionItems)
  mountSearch(shell, store, pm, () => {})
  const input = shell.headerLeft.querySelector('.tt-search-input') as HTMLInputElement

  const raf = search(input, 'blocked-on-xyz-vendor')

  const card = document.querySelector('[data-item-id="a1"]') as HTMLElement
  expect(card).not.toBeNull()
  card.scrollIntoView = vi.fn()

  raf(0)

  expect(card.scrollIntoView).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the test — it should already pass (Task 5's fix covers it), then confirm it actually catches the bug by temporarily reverting Task 5's change**

```bash
npx vitest run test/search-expand-highlight.test.ts
```
Expected: PASS (2 tests total in the file — this one plus Task 5's).

Now prove the test isn't vacuous — confirm it fails against the pre-Task-5 code:

```bash
git stash push -- src/ui/search-ui.ts
npx vitest run test/search-expand-highlight.test.ts
git stash pop
```
Expected: with `search-ui.ts` stashed back to its pre-Task-5 state, this test FAILs (`card.scrollIntoView` never called, since `commit()` still derives the scroll target from `ranges[0]` instead of the resolved anchor). `git stash pop` restores Task 5's code.

- [ ] **Step 3: Run test to confirm it passes again after the stash pop**

Run: `npx vitest run test/search-expand-highlight.test.ts`
Expected: PASS (2 tests total in the file)

- [ ] **Step 4: Run the full suite one more time**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: all PASS, 0 failures

- [ ] **Step 5: Commit**

```bash
git add test/search-expand-highlight.test.ts
git commit -m "test: cover action-items search focus scrolling with a notes-only match

Regression test for the originally reported bug: a search hit whose
match lives only in an action item's notes (modal-only field) used to
scroll/focus/highlight nothing at all, because the scroll target came
from the first painted text match rather than the already-resolved
card."
```

---

## Final Verification

After all 6 tasks:

```bash
npm run typecheck
npm run lint
npx vitest run
```

All three must pass with zero errors/failures. Spec: `docs/superpowers/specs/2026-07-25-search-expand-highlight-design.md`.
