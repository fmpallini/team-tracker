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
 * nothing if there are no matches. Safe to call unconditionally. A
 * milestone/risk title is likewise unreachable by the highlight walk: it's
 * an `<input>` element's `value`, not a text node, so `findMatchRanges`'
 * `TreeWalker` (SHOW_TEXT only) never finds it either — another reason
 * `scrollTarget` must drive the scroll rather than a found range.
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
