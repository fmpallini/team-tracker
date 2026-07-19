// src/ui/select-list.ts — shared row/selection mechanics for the dropdown
// list widgets (Ctrl+K palette, @ autocomplete, / template picker, header
// search results). Two rules every consumer must keep:
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

type RowProps = Record<string, string | ((e: Event) => void)>

/**
 * Toggles the 'selected' class across the current rows. `rowSelector` lets
 * lists with non-selectable separator rows (e.g. atref's group headers)
 * address only the real rows, which is also why callers can't index
 * `listEl.children` directly.
 */
export function paintSelection(listEl: HTMLElement | null, rowSelector: string, selected: number): void {
  if (!listEl) return
  listEl.querySelectorAll<HTMLElement>(rowSelector).forEach((row, i) => row.classList.toggle('selected', i === selected))
}

/** Arrow-key movement, clamped to the ends of the list. */
export function clampMove(selected: number, delta: number, count: number): number {
  if (count === 0) return 0
  return Math.max(0, Math.min(selected + delta, count - 1))
}

/** The standard interactive attrs for a selectable row — spread into el(). */
export function selectableRowProps(opts: { class: string; selected: boolean; onCommit(): void; onHover(): void }): RowProps {
  return {
    class: opts.class + (opts.selected ? ' selected' : ''),
    onmousedown: (e: Event) => e.preventDefault(),
    onclick: () => opts.onCommit(),
    onmouseenter: () => opts.onHover(),
  }
}
