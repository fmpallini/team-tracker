// src/ui/drag-autoscroll.ts — scrolls the nearest scroller while a native drag hovers its edge.
//
// A native HTML5 drag sends no `wheel` events, and the browser's own drag auto-scroll is a thin,
// slow hot zone that gives up on nested scrollers (a kanban column inside a board inside a pane).
// So a card, risk row or person dragged toward an edge needs this: each axis scrolls the nearest
// ancestor of the pointer that can still move that way, faster the closer the pointer is to the edge.
//
// `dragover` fires continuously while the pointer is over the root, even held still, so the loop
// needs no pointer-move bookkeeping: it runs while dragovers keep arriving and stops once they
// don't (drop, dragend, pointer left the root). Opt-in per module root, not document-wide.

const EDGE_PX = 48 // hot zone depth, capped at a quarter of the scroller so a small one still has a middle
const MAX_STEP_PX = 20 // per frame, at the very edge
const IDLE_MS = 150 // no dragover for this long ends the drag as far as scrolling is concerned

type Axis = 'x' | 'y'

/** How far to scroll `scroller` on `axis` for a pointer at `pointer`, signed; 0 outside the zone or at the end. */
function stepFor(scroller: HTMLElement, axis: Axis, pointer: number): number {
  const rect = scroller.getBoundingClientRect()
  const start = axis === 'x' ? rect.left : rect.top
  const size = axis === 'x' ? rect.width : rect.height
  const pos = axis === 'x' ? scroller.scrollLeft : scroller.scrollTop
  const room = (axis === 'x' ? scroller.scrollWidth - scroller.clientWidth : scroller.scrollHeight - scroller.clientHeight)
  const zone = Math.min(EDGE_PX, size / 4)
  const fromStart = pointer - start
  const fromEnd = start + size - pointer
  const ramp = (depth: number): number => MAX_STEP_PX * Math.min(1, (zone - Math.max(0, depth)) / zone) ** 2
  if (fromStart < zone && pos > 0) return -Math.max(1, ramp(fromStart))
  if (fromEnd < zone && pos < room - 1) return Math.max(1, ramp(fromEnd))
  return 0
}

/** The nearest ancestor of `from` (below <body>) that scrolls on `axis` and still has a step to take there. */
function scrollerAt(from: HTMLElement | null, axis: Axis, pointer: number): { el: HTMLElement; step: number } | null {
  for (let node = from; node && node !== document.body; node = node.parentElement) {
    const overflow = getComputedStyle(node)[axis === 'x' ? 'overflowX' : 'overflowY']
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    if (axis === 'x' ? node.scrollWidth <= node.clientWidth : node.scrollHeight <= node.clientHeight) continue
    const step = stepFor(node, axis, pointer)
    if (step !== 0) return { el: node, step }
  }
  return null
}

/** Auto-scrolls while a drag hovers an edge of anything inside `root`. Returns the unbind function. */
export function dragAutoscroll(root: HTMLElement): () => void {
  let target: HTMLElement | null = null
  let x = 0
  let y = 0
  let lastOver = 0
  let frame = 0

  const stop = (): void => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    target = null
    document.removeEventListener('drop', stop, true)
    document.removeEventListener('dragend', stop, true)
  }
  const tick = (): void => {
    if (performance.now() - lastOver > IDLE_MS) return stop()
    const h = scrollerAt(target, 'x', x)
    const v = scrollerAt(target, 'y', y)
    if (h) h.el.scrollLeft += h.step
    if (v) v.el.scrollTop += v.step
    frame = requestAnimationFrame(tick)
  }
  const onDragOver = (e: DragEvent): void => {
    target = e.target as HTMLElement
    x = e.clientX
    y = e.clientY
    lastOver = performance.now()
    if (frame) return
    document.addEventListener('drop', stop, true)
    document.addEventListener('dragend', stop, true)
    frame = requestAnimationFrame(tick)
  }

  root.addEventListener('dragover', onDragOver)
  return () => {
    root.removeEventListener('dragover', onDragOver)
    stop()
  }
}
