import { installCtrlWheelFontSize } from '../src/ui/ctrl-wheel-font'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { t } from '../src/core/i18n'

function wheel(deltaY: number, ctrlKey = true): WheelEvent {
  const e = new WheelEvent('wheel', { deltaY, ctrlKey, bubbles: true, cancelable: true })
  document.body.dispatchEvent(e)
  return e
}
const toastText = (): string | null => document.querySelector('.tt-toast')?.textContent ?? null

let store: Store
let dispose: () => void
const applyPrefs = vi.fn()

beforeEach(() => {
  store = createStore(createEmptyDocument('en-US')) // fontSize 'M', ctrlWheelFontSize true
  applyPrefs.mockReset()
  dispose = installCtrlWheelFontSize(store, { applyPrefs })
})
afterEach(() => {
  dispose()
  document.body.innerHTML = ''
})

test('one notch up grows the text one size, applies it and says so', () => {
  const e = wheel(-100)
  expect(e.defaultPrevented).toBe(true)
  expect(store.doc.prefs.fontSize).toBe('L')
  expect(applyPrefs).toHaveBeenCalledWith(store.doc.prefs)
  expect(toastText()).toBe(t('en-US', 'size_toast', { size: t('en-US', 'prefs_size_l') }))
})

test('small pinch deltas accumulate to one step instead of one step each', () => {
  wheel(-10); wheel(-10); wheel(-10)
  expect(store.doc.prefs.fontSize).toBe('M')
  wheel(-10)
  expect(store.doc.prefs.fontSize).toBe('L')
})

test('reversing direction restarts the accumulation', () => {
  wheel(-30)
  wheel(30)
  expect(store.doc.prefs.fontSize).toBe('M')
})

test('with the preference off the browser keeps the gesture', () => {
  store.update((d) => { d.prefs.ctrlWheelFontSize = false })
  const e = wheel(-100)
  expect(e.defaultPrevented).toBe(false)
  expect(store.doc.prefs.fontSize).toBe('M')
})

test('a wheel without Ctrl is untouched', () => {
  expect(wheel(-100, false).defaultPrevented).toBe(false)
})

test('at the largest size, further zoom-in changes nothing and toasts nothing', () => {
  store.update((d) => { d.prefs.fontSize = 'XL' })
  wheel(-100)
  expect(store.doc.prefs.fontSize).toBe('XL')
  expect(toastText()).toBeNull()
})

test('a read-only tab neither applies nor announces a size it could not save', () => {
  store.setReadOnly(true)
  wheel(-100)
  expect(store.doc.prefs.fontSize).toBe('M')
  expect(applyPrefs).not.toHaveBeenCalled()
  expect(toastText()).toBeNull()
})

test('the returned function stops listening', () => {
  dispose()
  expect(wheel(-100).defaultPrevented).toBe(false)
})
