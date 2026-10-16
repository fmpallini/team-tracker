// src/ui/ctrl-wheel-font.ts — Ctrl+mouse-wheel steps the text-size preference
// through its five stops, standing in for the browser's own page zoom, but
// only while `prefs.ctrlWheelFontSize` is on (prefs → General). Off, the event
// is left untouched and the browser zooms as usual. Capture phase +
// passive:false so preventDefault lands before any module's own wheel handler
// (daily-notes' edge-scroll) sees a Ctrl+wheel. Travel is accumulated to a
// threshold so a trackpad pinch (a burst of small ctrlKey wheel events)
// doesn't rip through all five sizes in one gesture. Lived inline in main.ts,
// where it could not be tested.
import type { Store } from '../core/store'
import type { Shell } from './shell'
import { stepFontSize } from '../core/font-size'
import { t } from '../core/i18n'
import { toast } from './modal'

const SIZE_LABEL_KEY = { XS: 'prefs_size_xs', S: 'prefs_size_s', M: 'prefs_size_m', L: 'prefs_size_l', XL: 'prefs_size_xl' } as const
const WHEEL_STEP_PX = 40
/** A pause longer than this starts a fresh gesture. */
const GESTURE_GAP_MS = 400

export function installCtrlWheelFontSize(store: Store, shell: Pick<Shell, 'applyPrefs'>): () => void {
  let accum = 0
  let lastDir: -1 | 1 = 1
  let lastAt = 0
  const onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey) return
    if (!store.doc.prefs.ctrlWheelFontSize) return // hand the gesture back to the browser
    e.preventDefault()
    e.stopPropagation()
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY
    if (px === 0) return
    const dir: -1 | 1 = px < 0 ? 1 : -1 // wheel up / pinch open = larger
    const now = Date.now()
    if (dir !== lastDir || now - lastAt > GESTURE_GAP_MS) accum = 0
    lastDir = dir
    lastAt = now
    accum += Math.abs(px)
    if (accum < WHEEL_STEP_PX) return
    accum = 0
    const next = stepFontSize(store.doc.prefs.fontSize, dir)
    if (next === store.doc.prefs.fontSize) return // already at the smallest/largest
    store.update((d) => { d.prefs.fontSize = next }, { sections: ['prefs'] })
    // A read-only tab's update is blocked (the store raises its own notice);
    // applying or announcing a size that never took would be a lie.
    if (store.doc.prefs.fontSize !== next) return
    shell.applyPrefs(store.doc.prefs)
    const lc = store.doc.prefs.locale
    toast(t(lc, 'size_toast', { size: t(lc, SIZE_LABEL_KEY[next]) }), { key: 'font-size' })
  }
  document.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => document.removeEventListener('wheel', onWheel, { capture: true })
}
