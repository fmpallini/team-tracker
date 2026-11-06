import { dragAutoscroll } from '../src/ui/drag-autoscroll'

/** A scroller of `w`×`h` showing `sw`×`sh` of content, laid out at the origin. jsdom has no layout, so fake it. */
function scroller(style: string, w: number, h: number, sw: number, sh: number): HTMLElement {
  const node = document.createElement('div')
  node.style.cssText = style
  Object.defineProperties(node, {
    clientWidth: { value: w }, clientHeight: { value: h }, scrollWidth: { value: sw }, scrollHeight: { value: sh },
  })
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0, toJSON() {} })
  return node
}

function dragOver(target: HTMLElement, clientX: number, clientY: number): void {
  const e = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperties(e, { clientX: { value: clientX }, clientY: { value: clientY } })
  target.dispatchEvent(e)
}
const frames = (n: number): void => { vi.advanceTimersByTime(16 * n) }

let dispose: () => void
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  dispose?.()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

test('scrolls right while the pointer holds the right edge, left at the left edge', () => {
  const board = scroller('overflow-x: auto', 400, 300, 1200, 300)
  const card = document.createElement('div')
  board.append(card)
  document.body.append(board)
  dispose = dragAutoscroll(board)

  dragOver(card, 399, 150)
  frames(3)
  expect(board.scrollLeft).toBeGreaterThan(0)

  const right = board.scrollLeft
  dragOver(card, 0, 150)
  frames(3)
  expect(board.scrollLeft).toBeLessThan(right)
})

test('does nothing in the middle of the scroller', () => {
  const board = scroller('overflow-x: auto', 400, 300, 1200, 300)
  document.body.append(board)
  dispose = dragAutoscroll(board)
  dragOver(board, 200, 150)
  frames(5)
  expect(board.scrollLeft).toBe(0)
})

test('keeps scrolling while held still, and stops once dragovers stop', () => {
  const list = scroller('overflow-y: auto', 300, 400, 300, 1200)
  document.body.append(list)
  dispose = dragAutoscroll(list)
  dragOver(list, 150, 399)
  frames(2)
  const early = list.scrollTop
  dragOver(list, 150, 399)
  frames(2)
  expect(list.scrollTop).toBeGreaterThan(early)

  frames(20) // past the idle window with no further dragover
  const rested = list.scrollTop
  frames(5)
  expect(list.scrollTop).toBe(rested)
})

test('a drop ends it at once', () => {
  const list = scroller('overflow-y: auto', 300, 400, 300, 1200)
  document.body.append(list)
  dispose = dragAutoscroll(list)
  dragOver(list, 150, 399)
  frames(1)
  document.dispatchEvent(new Event('drop'))
  const at = list.scrollTop
  frames(5)
  expect(list.scrollTop).toBe(at)
})

test('the nearest scroller wins on each axis: a column scrolls itself, the board scrolls sideways', () => {
  const board = scroller('overflow-x: auto', 400, 500, 1200, 500)
  const column = scroller('overflow-y: auto', 200, 500, 200, 1500)
  const card = document.createElement('div')
  column.append(card)
  board.append(column)
  document.body.append(board)
  dispose = dragAutoscroll(board)

  dragOver(card, 399, 499) // bottom-right corner of both
  frames(3)
  expect(column.scrollTop).toBeGreaterThan(0)
  expect(board.scrollLeft).toBeGreaterThan(0)
})

test('a scroller already at its end is skipped, so the next one out can take over', () => {
  const pane = scroller('overflow-y: auto', 400, 400, 400, 1000)
  const inner = scroller('overflow-y: auto', 400, 400, 400, 600)
  inner.scrollTop = 200 // at the bottom: 200 + 400 = 600
  pane.append(inner)
  document.body.append(pane)
  dispose = dragAutoscroll(pane)

  dragOver(inner, 200, 399)
  frames(3)
  expect(inner.scrollTop).toBe(200)
  expect(pane.scrollTop).toBeGreaterThan(0)
})

test('the unbind removes the listener', () => {
  const list = scroller('overflow-y: auto', 300, 400, 300, 1200)
  document.body.append(list)
  dragAutoscroll(list)()
  dragOver(list, 150, 399)
  frames(3)
  expect(list.scrollTop).toBe(0)
  dispose = () => {}
})
