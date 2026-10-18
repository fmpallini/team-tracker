// src/ui/search-highlight.ts — paints search-term matches in the module a
// search result navigated to, via the CSS Custom Highlight API (no DOM
// mutation, unlike search-ui.ts's <mark>-based snippet highlighter — this
// walks the *live*, already-rendered module DOM, which callers must not
// have their own rendering logic mutate mid-match).
import { normalizeWithOffsets } from '../core/search'

const HIGHLIGHT_NAME = 'tt-search'
/** Class toggled on a search result's resolved target element (see `applySearchHighlight`'s `scrollTarget`) — an outline the CSS Custom Highlight API can't provide when there's no visible matched text to mark (a kanban card whose only match is in the modal-only `notes` field; a milestone/risk title, which lives in an `<input>` value, not a text node). */
const TARGET_FLASH_CLASS = 'tt-search-target-flash'
/** The element `TARGET_FLASH_CLASS` is currently on, if any — tracked so `clearSearchHighlight` can remove it without needing the element passed back in. */
let flashedEl: HTMLElement | null = null

/** Fired on a pane's `.tt-pane-body` element right after a search result navigates there, carrying the result's `itemId` (if any) as `detail`. Modules with collapsible per-item content (milestones.ts, risks.ts) listen for this to auto-expand the matching row before highlighting runs. Modules that don't listen simply never see any effect — safe no-op. */
export const SEARCH_FOCUS_ITEM_EVENT = 'tt-search-focus-item'

/** Dispatches SEARCH_FOCUS_ITEM_EVENT on `container` with `itemId` as `detail`. */
export function dispatchSearchFocusItem(container: HTMLElement, itemId: string): void {
  container.dispatchEvent(new CustomEvent<string>(SEARCH_FOCUS_ITEM_EVENT, { detail: itemId }))
}

/**
 * Walks text nodes under `rootEl`, finds `normalize()`-matched term
 * positions and returns a `Range` per match. A match index found in a text
 * node's normalized content is mapped back to the node's original text through
 * `normalizeWithOffsets` — a straight copy for the accented Latin text this app
 * mostly holds, a real map for NFD-decomposed accents and Hangul.
 */
export function findMatchRanges(rootEl: HTMLElement, terms: string[]): Range[] {
  const cleanTerms = terms.filter(Boolean)
  if (cleanTerms.length === 0) return []

  const ranges: Range[] = []
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? ''
    const { normalized, offsets } = normalizeWithOffsets(text)
    const at = (i: number): number => Math.min(offsets ? offsets[i]! : i, text.length)
    for (const term of cleanTerms) {
      let from = 0
      for (;;) {
        const idx = normalized.indexOf(term, from)
        if (idx < 0) break
        const range = document.createRange()
        range.setStart(node, at(idx))
        range.setEnd(node, at(idx + term.length))
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
  // Real focus, not just a visual marker: every module's row/card is already
  // a tabindex="0" stop with its own Enter handler (open the card, toggle a
  // follow-up row, ...) and its own :focus-visible ring — landing here via
  // search puts the item in that exact same "selected" state arrow-key nav
  // would, so Enter now does what arrow-selecting it and pressing Enter
  // always did, and the ring is the same ring for free. `preventScroll`
  // keeps the explicit scrollIntoView below as the sole source of truth for
  // *where* it scrolls to (`block: 'center'`) instead of racing the
  // browser's own default "scroll nearest edge into view" from a bare
  // .focus() call. A target that isn't itself focusable (e.g. the
  // free-text-match fallback below, elsewhere inside a notes editor) simply
  // ignores this — .focus() on a non-focusable element is a safe no-op.
  if (target instanceof HTMLElement) target.focus({ preventScroll: true })
  target?.scrollIntoView({ block: 'center' })

  if (flashedEl && flashedEl !== scrollTarget) flashedEl.classList.remove(TARGET_FLASH_CLASS)
  flashedEl = scrollTarget ?? null
  flashedEl?.classList.add(TARGET_FLASH_CLASS)
}

/** Clears any highlight painted by `applySearchHighlight`. Safe to call even if nothing was ever highlighted. */
export function clearSearchHighlight(): void {
  if (typeof CSS !== 'undefined' && 'highlights' in CSS && CSS.highlights) {
    CSS.highlights.delete(HIGHLIGHT_NAME)
  }
  flashedEl?.classList.remove(TARGET_FLASH_CLASS)
  flashedEl = null
}

/**
 * After a navigation lands in pane `paneIdx`, brings the result into view on
 * the next frame (the pane body is being re-rendered in this one): tells the
 * module to reveal `itemId` (milestones/risks expand a collapsed row — see
 * SEARCH_FOCUS_ITEM_EVENT), then focuses, scrolls to and flashes that item's
 * row, painting `terms` inside it — or across the whole pane when the item
 * has no row there (or there is no item, just a search query).
 *
 * The one implementation behind every "open this and show me where" path:
 * search results, due items, the palette (all via ui/reveal-loc.ts) and @ref
 * clicks (ui/atref.ts's navigateToLoc). No-op with neither an item nor terms.
 */
export function focusItemInPane(paneIdx: 0 | 1, itemId: string | undefined, terms: readonly string[] = []): void {
  if (!itemId && terms.length === 0) return
  requestAnimationFrame(() => {
    const paneEl = document.querySelectorAll<HTMLElement>('.tt-pane-body')[paneIdx]
    if (!paneEl) return
    if (itemId) dispatchSearchFocusItem(paneEl, itemId)
    const anchors = itemId ? Array.from(paneEl.querySelectorAll<HTMLElement>(`[data-item-id="${itemId}"]`)) : []
    // anchors[0], not a matched range, is the scroll target: the row is known,
    // and must win even when none of its visible text matches (an action
    // item's notes live only in its edit modal).
    applySearchHighlight(anchors.length > 0 ? anchors : [paneEl], [...terms], anchors[0])
  })
}
