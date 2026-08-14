// src/ui/select-list.ts — shared row/selection mechanics for the dropdown
// list widgets (Ctrl+K palette, @ autocomplete, / template picker, header
// search results). Three rules every consumer must keep:
//
// 1. Hover and arrow keys repaint the highlight via paintSelection() on the
//    EXISTING rows — never by rebuilding the row DOM. Replacing the node
//    under a stationary pointer makes real Chrome re-fire mouseenter on the
//    replacement, looping forever — and with mousedown/mouseup landing on
//    two different (rebuilt) elements the browser never synthesizes a click,
//    so picking an item appears to do nothing. (This fix was discovered
//    independently in template-picker, atref, and palette before being
//    centralized here.)
// 2. Rows preventDefault() on mousedown so committing a pick never steals
//    focus from the input/editor that owns the dropdown.
// 3. selectableRowProps' mouseenter ignores a stationary pointer — see its
//    own comment. Every one of these lists is CSS `overflow-y: auto` with a
//    capped `max-height`, so paintSelection's scrollIntoView (arrow-key nav
//    on a list too long to fit) routinely scrolls a *different* row under an
//    unmoved mouse cursor, and real Chrome fires mouseenter for that too —
//    without the check below that synthetic enter would silently steal
//    keyboard selection back to whatever row the scroll happened to land
//    under the pointer.

type RowProps = Record<string, string | ((e: Event) => void)>

/**
 * Toggles the 'selected' class across the current rows. `rowSelector` lets
 * lists with non-selectable separator rows (e.g. atref's group headers)
 * address only the real rows, which is also why callers can't index
 * `listEl.children` directly.
 */
export function paintSelection(listEl: HTMLElement | null, rowSelector: string, selected: number): void {
  if (!listEl) return
  listEl.querySelectorAll<HTMLElement>(rowSelector).forEach((row, i) => {
    const isSelected = i === selected
    row.classList.toggle('selected', isSelected)
    if (isSelected) row.scrollIntoView?.({ block: 'nearest' })
  })
}

/** Arrow-key movement, clamped to the ends of the list. */
export function clampMove(selected: number, delta: number, count: number): number {
  if (count === 0) return 0
  return Math.max(0, Math.min(selected + delta, count - 1))
}

// Tracks the pointer's last real (mousemove-driven) viewport position, so
// selectableRowProps' mouseenter can tell "the cursor actually arrived on
// this row" apart from "this row scrolled to where the cursor already was".
// Module-level and installed once, lazily — a plain (x, y) update on every
// real mousemove is cheap enough to just leave running for the page's
// lifetime, same tradeoff as modal.ts's toastStack singleton.
let lastMouseX = NaN
let lastMouseY = NaN
let mouseTrackerInstalled = false
function ensureMouseTracker(): void {
  if (mouseTrackerInstalled) return
  mouseTrackerInstalled = true
  document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX
    lastMouseY = e.clientY
  })
}

/** The standard interactive attrs for a selectable row — spread into el(). */
export function selectableRowProps(opts: { class: string; selected: boolean; onCommit(): void; onHover(): void }): RowProps {
  ensureMouseTracker()
  return {
    class: opts.class + (opts.selected ? ' selected' : ''),
    onmousedown: (e: Event) => e.preventDefault(),
    onclick: () => opts.onCommit(),
    onmouseenter: (e: Event) => {
      const { clientX, clientY } = e as MouseEvent
      // Same coordinates as the last real mousemove means the pointer never
      // actually moved onto this row — it scrolled underneath it instead
      // (see this file's header comment). NaN-vs-anything is always false,
      // so the very first hover of a session (before any mousemove has ever
      // fired) still goes through normally.
      if (clientX === lastMouseX && clientY === lastMouseY) return
      opts.onHover()
    },
  }
}
