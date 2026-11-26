// src/ui/ctrl-wheel-font.ts — Ctrl+mouse-wheel steps the text size through its
// five stops, standing in for the browser's own page zoom. Two installers share
// one gesture:
//  - installCtrlWheelFontSize: an open document, stepping `prefs.fontSize`, and
//    only while `prefs.ctrlWheelFontSize` is on (prefs → General). Off, the
//    event is left untouched and the browser zooms as usual.
//  - installStartCtrlWheelSize: the start screen, where no document (so no
//    preference) exists. It always takes the gesture, so a user can't zoom the
//    browser before the file opens and carry that page zoom into the app (the
//    browser remembers it per site); the size lives only on <html data-size>
//    and the opened document's own preference replaces it (shell.applyPrefs).
// Capture phase + passive:false so preventDefault lands before any module's own
// wheel handler (daily-notes' edge-scroll) sees a Ctrl+wheel. Travel is
// accumulated to a threshold so a trackpad pinch (a burst of small ctrlKey
// wheel events) doesn't rip through all five sizes in one gesture.
import type { Store } from '../core/store'
import type { Prefs } from '../core/types'
import type { Shell } from './shell'
import { stepFontSize } from '../core/font-size'
import { t, type Locale } from '../core/i18n'
import { toast } from './modal'

type FontSize = Prefs['fontSize']

const SIZE_LABEL_KEY = { XS: 'prefs_size_xs', S: 'prefs_size_s', M: 'prefs_size_m', L: 'prefs_size_l', XL: 'prefs_size_xl' } as const
const WHEEL_STEP_PX = 40
/** A pause longer than this starts a fresh gesture. */
const GESTURE_GAP_MS = 400

interface SizeTarget {
  /** The size to step from, or null to hand the gesture back to the browser. */
  current(): FontSize | null
  /** Apply `next`; false when it did not take (nothing is announced then). */
  set(next: FontSize): boolean
  locale(): Locale
}

function installGesture(target: SizeTarget): () => void {
  let accum = 0
  let lastDir: -1 | 1 = 1
  let lastAt = 0
  const onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey) return
    const current = target.current()
    if (current === null) return
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
    const next = stepFontSize(current, dir)
    if (next === current) return // already at the smallest/largest
    if (!target.set(next)) return
    const lc = target.locale()
    toast(t(lc, 'size_toast', { size: t(lc, SIZE_LABEL_KEY[next]) }), { key: 'font-size' })
  }
  document.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => document.removeEventListener('wheel', onWheel, { capture: true })
}

export function installCtrlWheelFontSize(store: Store, shell: Pick<Shell, 'applyPrefs'>): () => void {
  return installGesture({
    current: () => (store.doc.prefs.ctrlWheelFontSize ? store.doc.prefs.fontSize : null),
    set: (next) => {
      store.update((d) => { d.prefs.fontSize = next }, { sections: ['prefs'] })
      // A read-only tab's update is blocked (the store raises its own notice);
      // applying or announcing a size that never took would be a lie.
      if (store.doc.prefs.fontSize !== next) return false
      shell.applyPrefs(store.doc.prefs)
      return true
    },
    locale: () => store.doc.prefs.locale,
  })
}

/**
 * The start screen's gesture, live while `root` is in the page. showStartScreen
 * has no teardown (the shell simply replaces it), so the listener retires itself
 * on the first Ctrl+wheel after `root` is gone, handing that event on to the
 * document's own listener; the caller also disposes it before showing a new
 * start screen. Before any document has set one, <html> has no data-size (the
 * browser's 16px default), stepped from as M.
 */
export function installStartCtrlWheelSize(root: Element, locale: Locale): () => void {
  const html = document.documentElement
  const dispose = installGesture({
    current: () => {
      if (!root.isConnected) {
        dispose()
        return null
      }
      return (html.dataset.size as FontSize | undefined) ?? 'M'
    },
    set: (next) => {
      html.dataset.size = next
      return true
    },
    locale: () => locale,
  })
  return dispose
}
