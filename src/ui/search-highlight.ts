// src/ui/search-highlight.ts — paints search-term matches in the module a
// search result navigated to, via the CSS Custom Highlight API (no DOM
// mutation, unlike search-ui.ts's <mark>-based snippet highlighter — this
// walks the *live*, already-rendered module DOM, which callers must not
// have their own rendering logic mutate mid-match).
import { normalize } from '../core/search'

const HIGHLIGHT_NAME = 'tt-search'

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
 * Paints `terms`' matches under `rootEl` via `CSS.highlights` (no-op where
 * unsupported — e.g. jsdom, or a browser without the Custom Highlight API)
 * and scrolls the first match into view. Safe to call unconditionally.
 */
export function applySearchHighlight(rootEl: HTMLElement, terms: string[]): void {
  const ranges = findMatchRanges(rootEl, terms)
  if (typeof CSS !== 'undefined' && 'highlights' in CSS && CSS.highlights) {
    if (ranges.length === 0) {
      CSS.highlights.delete(HIGHLIGHT_NAME)
    } else {
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges))
    }
  }
  const first = ranges[0]
  if (first) {
    const el = first.startContainer instanceof Element ? first.startContainer : first.startContainer.parentElement
    el?.scrollIntoView({ block: 'center' })
  }
}

/** Clears any highlight painted by `applySearchHighlight`. Safe to call even if nothing was ever highlighted. */
export function clearSearchHighlight(): void {
  if (typeof CSS !== 'undefined' && 'highlights' in CSS && CSS.highlights) {
    CSS.highlights.delete(HIGHLIGHT_NAME)
  }
}
