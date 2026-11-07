// src/ui/fit-text.ts — shrink-to-fit for line-clamped text. CSS can clamp a
// name to N lines with an ellipsis but cannot pick a smaller font first, so the
// clamped element is measured here: while its content is taller than its box,
// step the font down, and leave the ellipsis for what still overflows at the
// floor. Idempotent (every call starts again from the stylesheet's size), so a
// ResizeObserver can call it freely.

/** Font-size multipliers tried in order after the stylesheet's own size; the smallest also gets a third line before the ellipsis. */
const STEPS: readonly { scale: number; lines?: number }[] = [{ scale: 0.92 }, { scale: 0.85 }, { scale: 0.78, lines: 3 }]
/** The stylesheet sets both spellings of the clamp, so an override must too. */
const CLAMP_PROPS = ['-webkit-line-clamp', 'line-clamp']
/** Never go below this many px, whatever the user's text-size preference. */
const MIN_PX = 10

function overflows(node: HTMLElement): boolean {
  return node.scrollHeight > node.clientHeight + 1
}

/** Fits every `selector` match under `root`. A hidden or detached node measures 0 and keeps its normal size. */
export function fitText(root: ParentNode, selector: string): void {
  for (const node of root.querySelectorAll<HTMLElement>(selector)) {
    node.style.fontSize = ''
    for (const prop of CLAMP_PROPS) node.style.removeProperty(prop)
    if (!overflows(node)) continue
    const base = parseFloat(getComputedStyle(node).fontSize)
    for (const { scale, lines } of STEPS) {
      if (base * scale < MIN_PX) break
      node.style.fontSize = `${scale}em`
      if (lines) for (const prop of CLAMP_PROPS) node.style.setProperty(prop, String(lines))
      if (!overflows(node)) break
    }
  }
}

/** Sets `full` as the node's text, or `short` when the full text is clipped horizontally (it must be `min-width: 0; overflow: hidden`). */
export function abbreviateWhenClipped(node: HTMLElement, full: string, short: string): void {
  node.textContent = full
  if (node.scrollWidth > node.clientWidth + 1) node.textContent = short
}
