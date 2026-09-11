import { placePopover } from '../src/core/popover-place'

const VIEWPORT = { width: 1000, height: 800 }

test('sits just below the anchor, left-aligned, when there is room', () => {
  const anchor = { left: 100, right: 260, top: 200, bottom: 224 }
  const pos = placePopover(anchor, { width: 240, height: 300 }, VIEWPORT)
  expect(pos).toEqual({ left: 100, top: 228 }) // bottom + 4
})

test('flips above the anchor when it would overflow the bottom edge', () => {
  const anchor = { left: 100, right: 260, top: 600, bottom: 624 }
  const pos = placePopover(anchor, { width: 240, height: 300 }, VIEWPORT)
  expect(pos.top).toBe(600 - 4 - 300) // anchor.top - gap - height
})

test('when it fits neither below nor fully above, clamps to the top margin', () => {
  const anchor = { left: 100, right: 260, top: 120, bottom: 700 }
  const pos = placePopover(anchor, { width: 240, height: 400 }, { width: 1000, height: 760 })
  expect(pos.top).toBe(8) // margin — prefer showing the popover's own top
})

test('shifts left so it does not overflow the right edge', () => {
  const anchor = { left: 900, right: 960, top: 200, bottom: 224 }
  const pos = placePopover(anchor, { width: 240, height: 200 }, VIEWPORT)
  expect(pos.left).toBe(1000 - 8 - 240) // viewport.width - margin - width
})

test('floors left at the margin when the popover is wider than the viewport', () => {
  const anchor = { left: 10, right: 40, top: 200, bottom: 224 }
  const pos = placePopover(anchor, { width: 1200, height: 200 }, VIEWPORT)
  expect(pos.left).toBe(8)
})
