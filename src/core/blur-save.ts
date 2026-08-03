// src/core/blur-save.ts — "the user left the window" save trigger.
//
// main.ts's `visibilitychange` handler only covers tab switches: Chrome
// reports `visibilityState === 'hidden'` when another tab of the same window
// takes over, but a *minimized* window — or one backgrounded by an OS-level
// app switch — stays `'visible'`, so neither case reaches that handler and
// both fall through to the auto-save interval alone (up to `autoSaveMin`
// minutes of unsaved edits).
//
// Window `blur` is the only signal that fires for both. It also fires for
// things that aren't "leaving": opening devtools, clicking the address bar,
// focusing another window for a second. Every save is a 600k-iteration PBKDF2
// encrypt (see crypto.ts) plus a disk write, so a raw blur→save would pay
// that price for each of those. Hence the delay: arm a timer on blur, cancel
// it the moment focus comes back, and only save if focus is *still* elsewhere
// when it fires.

/** Long enough that a devtools/address-bar detour costs nothing, short enough that a minimized window isn't left unsaved for the full auto-save interval. */
export const BLUR_SAVE_DELAY_MS = 15_000

export interface BlurSaveDeps {
  /** Runs only if focus is still away when the timer fires. Fire-and-forget — the save controller owns error reporting. */
  save(): void
  /** Injected so tests don't depend on jsdom's focus emulation; production passes `() => document.hasFocus()`. */
  hasFocus(): boolean
  delayMs?: number
}

/**
 * Registers the blur/focus pair on `window`. Returns a disposer that clears
 * any pending timer as well as removing both listeners — a timer surviving
 * teardown would call `save()` on a controller main.ts has already disposed.
 */
export function installBlurSave(deps: BlurSaveDeps): () => void {
  const delayMs = deps.delayMs ?? BLUR_SAVE_DELAY_MS
  let timer: ReturnType<typeof setTimeout> | null = null

  function cancel(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  function onBlur(): void {
    // Repeated blurs without an intervening focus (some browsers fire blur
    // more than once when focus moves across the browser's own chrome) must
    // not restart the countdown — the first one already started it.
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      // Dirty is not checked here: `saveNow()` already no-ops on a clean doc,
      // a read-only tab, or an open conflict modal, and checking at arm time
      // would miss an edit that lands between blur and fire.
      if (!deps.hasFocus()) deps.save()
    }, delayMs)
  }

  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', cancel)
  return () => {
    cancel()
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('focus', cancel)
  }
}
