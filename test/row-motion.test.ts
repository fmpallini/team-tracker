import { animateRowMoves } from '../src/ui/row-motion'

// jsdom has neither layout nor the Web Animations API: each row's rect comes from
// its data-y, and animate() is recorded instead of run.
type Call = { id: string; frames: Keyframe[] }
let calls: Call[] = []

function rect(y: number): DOMRect {
  return { top: y, bottom: y + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y, toJSON: () => ({}) } as DOMRect
}

function list(ids: string[]): HTMLElement {
  const root = document.createElement('div')
  fill(root, ids)
  document.body.appendChild(root)
  return root
}

/** A full rebuild, as the modules do: brand-new row elements, positioned by order. */
function fill(root: HTMLElement, ids: string[]): void {
  root.innerHTML = ''
  ids.forEach((id, i) => {
    const row = document.createElement('div')
    row.className = 'row'
    row.dataset.itemId = id
    row.dataset.y = String(i * 20)
    root.appendChild(row)
  })
}

beforeEach(() => {
  calls = []
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return rect(Number(this.dataset.y ?? 0))
  }
  ;(Element.prototype as unknown as { animate: unknown }).animate = function (this: HTMLElement, frames: Keyframe[]) {
    calls.push({ id: this.dataset.itemId!, frames })
    return {} as Animation
  }
  document.documentElement.style.setProperty('--dur-base', '.16s')
})

afterEach(() => {
  delete (Element.prototype as unknown as { animate?: unknown }).animate
  document.body.innerHTML = ''
})

test('rows that moved slide from their old place; rows that stayed are left alone', () => {
  const root = list(['a', 'b', 'c'])
  animateRowMoves(root, '.row', () => fill(root, ['b', 'a', 'c'])) // a and b swap
  expect(calls.map((c) => [c.id, c.frames[0]!.transform])).toEqual([
    ['b', 'translate(0px, 20px)'],
    ['a', 'translate(0px, -20px)'],
  ])
})

test('a row that arrives in a list already showing fades in; the rows it pushed slide', () => {
  const root = list(['a', 'c'])
  animateRowMoves(root, '.row', () => fill(root, ['a', 'b', 'c'])) // an Undo brings b back
  expect(calls).toEqual([
    { id: 'c', frames: [{ transform: 'translate(0px, -20px)' }, { transform: 'none' }] },
    { id: 'b', frames: [{ opacity: 0 }, { opacity: 1 }] },
  ])
})

test('a list replaced outright (no row survives: another team) is a cut, not an animation', () => {
  const root = list(['a', 'b'])
  animateRowMoves(root, '.row', () => fill(root, ['x', 'y']))
  expect(calls).toEqual([])
})

test('the rebuild still runs, unanimated, under reduced motion and during a drag', () => {
  const root = list(['a', 'b'])
  const mm = vi.fn(() => ({ matches: true }))
  vi.stubGlobal('matchMedia', mm)
  try {
    animateRowMoves(root, '.row', () => fill(root, ['b', 'a']))
    expect(root.firstElementChild!.getAttribute('data-item-id')).toBe('b')
    expect(calls).toEqual([])
  } finally {
    vi.unstubAllGlobals()
  }

  document.dispatchEvent(new Event('dragstart'))
  animateRowMoves(root, '.row', () => fill(root, ['a', 'b']))
  expect(calls).toEqual([]) // a drop puts the item where the user let go: it snaps
  document.dispatchEvent(new Event('dragend'))
  animateRowMoves(root, '.row', () => fill(root, ['b', 'a']))
  expect(calls).toHaveLength(2)
})

test('without the Web Animations API (jsdom) it is a plain rebuild', () => {
  delete (Element.prototype as unknown as { animate?: unknown }).animate
  const root = list(['a', 'b'])
  animateRowMoves(root, '.row', () => fill(root, ['b', 'a']))
  expect(root.firstElementChild!.getAttribute('data-item-id')).toBe('b')
})
