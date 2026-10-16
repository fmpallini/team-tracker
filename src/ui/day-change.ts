// src/ui/day-change.ts — "the calendar day moved while this view sat idle".
// A window left open overnight fires no store change, so anything drawn
// against today (overdue colours, Today markers, due badges) kept showing
// yesterday until the next edit. The moment the user comes back to the window
// (tab made visible again, or the window refocused) is when that matters.
// Shared by every view that draws against today, so the next one does not
// grow its own copy.
import { todayIso } from '../core/i18n'

/** Calls `onNewDay` when the user returns to the window on a different calendar day than the last check. Returns the unbind function. */
export function watchDayChange(onNewDay: () => void): () => void {
  let day = todayIso()
  const onReturn = (): void => {
    if (document.visibilityState === 'hidden') return
    const now = todayIso()
    if (now === day) return
    day = now
    onNewDay()
  }
  document.addEventListener('visibilitychange', onReturn)
  window.addEventListener('focus', onReturn)
  return () => {
    document.removeEventListener('visibilitychange', onReturn)
    window.removeEventListener('focus', onReturn)
  }
}
