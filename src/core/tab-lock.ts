// src/core/tab-lock.ts — Task 25: single-writer coordination across tabs of
// the same browser editing the same file, via the Web Locks API (feature-
// detected — absent in jsdom, so tests inject a fake `locks` to exercise this
// path) plus a `BroadcastChannel` for the "take control" handshake. Extracted
// out of main.ts so this concurrency-sensitive logic (Task 25 fixes #4/#4a)
// is unit testable instead of only ever running in a real multi-tab browser.
//
// On open, each tab tries to acquire `locks.request('tmv:' + name, {
// ifAvailable: true }, ...)`. The tab that gets it holds the lock open (via a
// Promise that only resolves once explicitly released) and has full
// read/write access; every other tab enters read-only (`store.setReadOnly`
// blocks `store.update()`) and shows a banner with a "Take control" button.
// Clicking it broadcasts a `takeover` message; the holder saves (if dirty),
// flips itself read-only, and releases the lock; the requester's blocking
// `locks.request()` (queued since its own first attempt) is then granted, and
// it exits read-only.
import type { Store } from './store'
import type { Shell } from '../ui/shell'
import type { SaveController } from './save-controller'
import type { FileSession } from './fs'
import { t } from './i18n'
import { el } from '../ui/dom'
import { toast } from '../ui/modal'

type TakeoverMessage = { type: 'takeover' }

export interface TabLockDeps {
  session: FileSession
  store: Store
  shell: Shell
  saveCtl: SaveController
  /**
   * `navigator.locks`, injected so tests can supply a fake `LockManager`.
   * Undefined in jsdom and in browsers without the Web Locks API — the
   * coordination degrades gracefully (see the `!supportsLocks &&
   * !supportsBroadcast` guard below), it doesn't throw.
   */
  locks?: LockManager
  /**
   * `BroadcastChannel` constructor, injected so tests can drive the "take
   * control" handshake without two real tabs. Defaults to the global (Node
   * and jsdom both provide it, unlike `navigator.locks`).
   */
  BroadcastChannelCtor?: typeof BroadcastChannel
  /**
   * Fires on each *visible* read-only transition (banner shown / removed) —
   * never for the provisional silent window a sole tab passes through on
   * open. main.ts turns the editors non-editable with it, since a blocked
   * `store.update()` otherwise leaves typed text on screen that never
   * reaches the document.
   */
  onReadOnlyChange?(readOnly: boolean): void
  /**
   * Awaited while holding a lock this tab had to wait for (it was visibly
   * read-only — e.g. "Take control"), BEFORE the tab becomes writable. The
   * previous holder saved on its way out, so this tab's in-memory document is
   * older than the file; main.ts reloads it here. Without that, the first
   * save hit an external-change conflict whose "Overwrite" erased the other
   * tab's edits. A rejection is logged and the tab goes writable anyway —
   * the conflict modal still guards the next save.
   */
  refreshBeforeWritable?(): Promise<void>
  /**
   * The lock / BroadcastChannel name for this file (core/file-identity.ts's
   * resolveFileLockKey — per file, not per file *name*). A promise because
   * resolving it reads IndexedDB; the tab stays provisionally read-only until
   * it settles and the lock is requested. Omitted = `'tmv:' + session.name`.
   */
  lockKey?: Promise<string>
}

export function createTabLock(deps: TabLockDeps): () => void {
  const { session, store, shell, saveCtl } = deps
  const supportsLocks = !!deps.locks
  const locks = deps.locks
  const BC = deps.BroadcastChannelCtor ?? (typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : undefined)
  const supportsBroadcast = !!BC
  if (!supportsLocks && !supportsBroadcast) return () => {}

  // Both set by start(), once the lock key is known.
  let channelName = 'tmv:' + session.name
  let bc: BroadcastChannel | null = null
  let releaseLock: (() => void) | null = null
  let released = false

  const banner = el(
    'div',
    { class: 'tt-readonly-banner' },
    el('span', { class: 'tt-readonly-banner-text' }, t(store.doc.prefs.locale, 'readonly_banner_text')),
    el(
      'button',
      { class: 'tt-btn tt-readonly-takeover-btn', type: 'button', onclick: () => requestTakeover() },
      t(store.doc.prefs.locale, 'readonly_takeover_btn')
    )
  )

  // Whether the read-only state is currently *shown* (banner up) — distinct
  // from store.readOnly, which is also true during the silent provisional
  // window below.
  let visibleReadOnly = false

  function enterReadOnly(): void {
    store.setReadOnly(true)
    if (!visibleReadOnly) {
      visibleReadOnly = true
      deps.onReadOnlyChange?.(true)
    }
    // Sibling before shell.root, not prepended inside it: .tt-shell is a
    // 2-row CSS grid (header auto, body 1fr) — a 3rd grid child shifts
    // auto-placement so header lands in the 1fr row (stretches full-height)
    // and body collapses into an unaccounted implicit row.
    if (!banner.isConnected) shell.root.parentElement?.insertBefore(banner, shell.root)
  }

  function exitReadOnly(): void {
    store.setReadOnly(false)
    banner.remove()
    if (visibleReadOnly) {
      visibleReadOnly = false
      deps.onReadOnlyChange?.(false)
    }
  }

  function holdUntilReleased(): Promise<void> {
    return new Promise<void>((resolve) => {
      releaseLock = () => {
        releaseLock = null
        resolve()
      }
    })
  }

  function requestLock(waitForRelease: boolean): void {
    if (!locks) return
    const opts = waitForRelease ? {} : { ifAvailable: true }
    locks
      .request(channelName, opts, (lock) => {
        // A read-only tab can close its file while a "Take control" request
        // is still queued. Granted after that, returning undefined hands the
        // lock straight back — holding it would lock every other tab out of
        // the file for as long as this one stays open, on behalf of a
        // document nobody has open any more.
        if (released) return undefined
        if (!lock) {
          enterReadOnly()
          return undefined
        }
        if (!visibleReadOnly || !deps.refreshBeforeWritable) {
          exitReadOnly()
          return holdUntilReleased()
        }
        // Waited for this lock: refresh from disk first (see
        // `refreshBeforeWritable`), still read-only and still holding it.
        return (async () => {
          try {
            await deps.refreshBeforeWritable!()
          } catch (e) {
            console.error(e)
          }
          // Closed mid-refresh: hand the lock straight back, as above.
          if (released) return
          exitReadOnly()
          await holdUntilReleased()
        })()
      })
      .catch((e) => console.error(e))
  }

  function requestTakeover(): void {
    bc?.postMessage({ type: 'takeover' } satisfies TakeoverMessage)
    requestLock(true)
  }

  const unsubscribeBlocked = store.onBlockedUpdate(() => {
    toast(t(store.doc.prefs.locale, 'readonly_blocked_toast'))
  })

  // Task 25 re-review item #4a: without this, the tab is fully writable from
  // the moment the document opens until `locks.request()`'s callback resolves
  // — an async round trip. A second tab racing to open the same file in that
  // window could both believe they hold write access. Once we know we're
  // actually going to contend for the lock, assume read-only immediately and
  // only open up once the lock is confirmed ours (see `exitReadOnly()`
  // below); if it turns out we're the only tab, this resolves within a tick
  // or two and nothing is ever visible. `silent: true` is required here —
  // plain `setReadOnly(true)` would arm the one-shot `onBlockedUpdate` toast,
  // and a normal single-tab open must never flash it just because this
  // provisional window happened to overlap a keystroke.
  if (supportsLocks) {
    store.setReadOnly(true, { silent: true })
  }

  function start(key: string): void {
    channelName = key
    bc = BC ? new BC(channelName) : null
    if (bc) bc.onmessage = onTakeoverMessage
    requestLock(false)
  }

  function onTakeoverMessage(ev: MessageEvent<TakeoverMessage>): void {
    if (ev.data?.type !== 'takeover' || !releaseLock) return
    const release = releaseLock
    ;(async () => {
      // Task 25 fix #4: `saveNow()` can return before the write actually
      // lands — it no-ops synchronously while another save is in flight
      // and just queues a trailing round. Releasing the lock right after
      // `await saveNow()` could hand write access to the requesting tab
      // while that trailing round (or the in-flight save it queued behind)
      // is still on its way to disk. `flush()` blocks until the controller
      // is fully idle — in-flight save and any trailing round both done —
      // before the lock (and read-write access) actually changes hands.
      if (store.dirty) await saveCtl.saveNow()
      await saveCtl.flush()
      enterReadOnly()
      release()
    })().catch((e) => console.error(e))
  }

  if (deps.lockKey) {
    deps.lockKey.then(
      (key) => { if (!released) start(key) },
      (e: unknown) => {
        console.error(e)
        if (!released) start(channelName)
      }
    )
  } else {
    start(channelName)
  }

  // Lets a "close file" action give up write access cleanly — without this,
  // the lock's holding Promise (see requestLock's callback above) never
  // resolves on its own, and reopening the same filename in this same tab
  // would queue forever behind a lock this very tab still holds. A read-only
  // tab closes too, so this also takes down its banner and neutralizes any
  // takeover request still queued (see requestLock's `released` check).
  return function releaseTabLock(): void {
    released = true
    banner.remove()
    if (visibleReadOnly) {
      visibleReadOnly = false
      deps.onReadOnlyChange?.(false)
    }
    releaseLock?.()
    bc?.close()
    unsubscribeBlocked()
  }
}
