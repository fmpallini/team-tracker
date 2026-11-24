// src/ui/row-motion.ts — makes a list's full rebuild read as movement: rows that
// moved slide from where they were to where they are now, and rows that arrived
// in a list that was already showing fade in. dom.ts's keepRowFocus runs every
// list rebuild through here (tasks, milestones, risks, the org chart, the team
// list), so a Ctrl+Arrow reorder, a move to another column, a delete closing its
// gap and an Undo bringing an item back all animate with no per-module code.
//
// FLIP (first, last, invert, play), not the View Transitions API: a view
// transition runs its DOM update a frame *after* the call, and the code around
// these rebuilds (focus restore, Undo offers, the next Ctrl+Arrow of a held key)
// relies on the store and the DOM having changed when the call returns. Here the
// rebuild stays synchronous; only the painting is animated, by a transform that
// never touches layout — the animations do not feed the ResizeObservers.
//
// Rows are matched across the rebuild by `data-item-id` (every rebuilt row has
// a new element). Their positions are viewport rects: what the eye saw before
// and sees after, scroll included.

/** Nothing moves when more rows than this did: a re-sort of a whole board reads better as a cut than as a swarm, and it bounds the cost. */
const MAX_ANIMATED = 60

/**
 * A drag-and-drop is direct manipulation: the user put the item where it lands,
 * so the rebuild its drop causes snaps instead of flying the row back from its
 * old place. Tracked here, document-wide, rather than per module: every list
 * uses native HTML5 drag, and dragend fires after the drop's rebuild.
 */
let dragging = false
let dragWatch = false
function watchDrags(): void {
  if (dragWatch) return
  dragWatch = true
  document.addEventListener('dragstart', () => { dragging = true }, true)
  document.addEventListener('dragend', () => { dragging = false }, true)
}

function motionAllowed(): boolean {
  if (dragging || document.hidden) return false
  if (typeof Element.prototype.animate !== 'function') return false // jsdom
  return !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
}

/** `--dur-base` in ms and `--ease`, read from the stylesheet so the slide keeps the app's one motion pace. */
function motionTiming(): KeyframeAnimationOptions {
  const style = getComputedStyle(document.documentElement)
  const dur = style.getPropertyValue('--dur-base').trim()
  const ms = dur.endsWith('ms') ? parseFloat(dur) : parseFloat(dur) * 1000
  return { duration: Number.isFinite(ms) ? ms : 160, easing: style.getPropertyValue('--ease').trim() || 'ease-out' }
}

function rows(root: HTMLElement, rowSelector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`${rowSelector}[data-item-id]`))
}

function onScreen(r: DOMRect): boolean {
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth
}

/** Runs `rebuild` (which replaces `root`'s rows) and animates the difference. */
export function animateRowMoves(root: HTMLElement, rowSelector: string, rebuild: () => void): void {
  watchDrags()
  if (!motionAllowed() || !root.isConnected) { rebuild(); return }
  const before = new Map<string, DOMRect>()
  for (const row of rows(root, rowSelector)) {
    const r = row.getBoundingClientRect()
    if (onScreen(r)) before.set(row.dataset.itemId!, r)
  }
  rebuild()
  if (before.size === 0) return // nothing was showing (first render, team switch into an empty view)

  const moves: Array<[HTMLElement, number, number]> = []
  const arrivals: HTMLElement[] = []
  let kept = 0
  for (const row of rows(root, rowSelector)) {
    const now = row.getBoundingClientRect()
    if (!onScreen(now)) continue
    const was = before.get(row.dataset.itemId!)
    if (!was) { arrivals.push(row); continue }
    kept++
    const dx = was.left - now.left
    const dy = was.top - now.top
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) moves.push([row, dx, dy])
  }
  // No row survived: a different list took the place of the old one (another team,
  // another filter); fading all of it in would be a page transition, not a move.
  if (kept === 0 || moves.length + arrivals.length > MAX_ANIMATED) return
  const timing = motionTiming()
  for (const [row, dx, dy] of moves) {
    row.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], timing)
  }
  for (const row of arrivals) {
    row.animate([{ opacity: 0 }, { opacity: 1 }], timing)
  }
}
