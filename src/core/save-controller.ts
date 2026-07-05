// src/core/save-controller.ts — Task 25: turns `store.dirty` into actual
// persisted bytes on disk (or a download in fallback mode), with a single
// writer at a time and a graceful path for every failure mode.
import type { Store } from './store'
import type { Prefs } from './types'
import { encryptDocument } from './crypto'
import { writeFile, downloadFallback, pickCreate, supportsFsApi, ExternalChangeError, type FileSession } from './fs'
import { t, type Locale } from './i18n'
import type { Shell } from '../ui/shell'
import { toast } from '../ui/modal'

export interface SaveController {
  /**
   * `opts.explicit` marks a save as user-initiated (Ctrl+S, "Save as…" retry)
   * as opposed to a best-effort automatic trigger (nav change, tab hidden,
   * auto-save interval). In fallback mode (no FS handle) only explicit saves
   * are allowed to trigger a `downloadFallback()` — see Task 25 fix #7.
   */
  saveNow(opts?: { explicit?: boolean }): Promise<void>
  /** (Re)arms the auto-save interval timer from `prefs.autoSaveMin`. */
  scheduleFrom(prefs: Prefs): void
  /**
   * Serializes `fn` against the save cycle: waits for any in-flight save
   * (including its trailing round) to finish, then runs `fn` with the same
   * "saving" gate held — so a reentrant `saveNow()` during `fn` only queues a
   * trailing round rather than writing in parallel. If a mutation lands
   * during `fn`, a trailing save runs immediately after `fn` settles.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
  /** Resolves once no save is in flight and no trailing round is queued. */
  flush(): Promise<void>
  dispose(): void
}

export interface SaveControllerDeps {
  store: Store
  session: FileSession
  getPassword(): string
  shell: Shell
  locale(): Locale
  /** Opens the conflict modal (ui/conflict.ts) — wired by main.ts. */
  onExternalChange(): void
  /**
   * Task 25 fix #5: lets main.ts report "the conflict modal is already open"
   * so (a) `saveNow()` no-ops instead of scheduling another attempt (e.g. the
   * auto-save interval firing while the user hasn't resolved the conflict
   * yet), and (b) a trailing round that hits another `ExternalChangeError`
   * doesn't stack a second modal on top of the first.
   */
  isConflictOpen?(): boolean
}

export function createSaveController(deps: SaveControllerDeps): SaveController {
  let saving = false
  let queued = false
  let queuedExplicit = false
  let timer: ReturnType<typeof setInterval> | null = null
  let idleWaiters: Array<() => void> = []

  // Task 25 fix #1: any edit that lands while a save is in flight must not
  // have its dirty flag cleared without being persisted. `doSave()` snapshots
  // `store.doc` once at the top (via `encryptDocument`) — an edit landing
  // after that snapshot but before the write resolves would otherwise be
  // silently dropped from the bytes on disk while `markSaved()` still clears
  // `dirty`. Forcing a trailing round (the same mechanism already used for
  // reentrant `saveNow()` calls) guarantees a fresh, post-edit snapshot gets
  // its own write before the controller goes idle.
  //
  // Task 25 re-review item #1: this used to hook `store.subscribe()`, which
  // `store.updateNav()` never fires (by design — nav-only changes don't
  // trigger a content re-render). The guard was only correct in practice
  // because every `updateNav()` call site happens to also call
  // `notifyNavChanged()` → a nav listener that calls `saveNow()` — a
  // call-site convention, not something this file could rely on. `onMutate()`
  // fires synchronously from both `update()` and `updateNav()`, so a mutation
  // via either path during an in-flight save now forces the trailing round
  // directly, with no dependence on what the caller does afterward.
  const unsubscribeDirtyGuard = deps.store.onMutate(() => {
    if (saving) queued = true
  })

  function notifyIdle(): void {
    const waiters = idleWaiters
    idleWaiters = []
    for (const w of waiters) w()
  }

  function waitForIdle(): Promise<void> {
    return new Promise<void>((resolve) => idleWaiters.push(resolve))
  }

  function reportWriteError(): void {
    deps.shell.setSaveState('error')
    const lc = deps.locale()
    toast(t(lc, 'save_error_toast'), {
      sticky: true,
      action: { label: t(lc, 'save_as_ellipsis'), onClick: () => void saveAs() },
    })
  }

  /**
   * "Salvar como…" recovery for the generic-error toast. Mutates the shared
   * `deps.session` object in place (rather than swapping it out) so the app
   * controller in main.ts — which holds the very same `FileSession` object —
   * transparently adopts the new file handle without a dedicated callback.
   */
  async function saveAs(): Promise<void> {
    if (!supportsFsApi) return
    let newSession: FileSession | null = null
    try {
      newSession = await pickCreate(deps.session.name)
    } catch (e) {
      console.error(e)
      return
    }
    if (!newSession) return
    deps.session.handle = newSession.handle
    deps.session.name = newSession.name
    deps.session.lastModified = newSession.lastModified
    await saveNow({ explicit: true })
  }

  /**
   * Always performs a real encrypt+write cycle — the `!dirty` short-circuit
   * lives in `saveNow()`, not here (see below for why). By the time this
   * runs, either the caller already confirmed `dirty`, or it's the trailing
   * round after a reentrant call, which must not skip the check-and-save.
   *
   * Also re-checks `store.readOnly` and the fallback/explicit gate itself
   * (fixes #2 and #7): trailing rounds are kicked off directly by `runSave`,
   * bypassing `saveNow()`'s own gate, so the choke point has to live here
   * too or a lock lost / an automatic trigger mid-chain could still write.
   */
  async function doSave(explicit: boolean): Promise<void> {
    if (deps.store.readOnly) return
    // Fallback mode (no FS handle): a silent "save" is actually a file
    // download the user must notice and keep. Automatic triggers (nav,
    // visibilitychange, the — normally-unarmed — interval) must never fire
    // one; only an explicit user action (Ctrl+S, "Save as…" retry) may.
    if (!deps.session.handle && !explicit) return
    deps.shell.setSaveState('saving')
    let bytes: Uint8Array
    try {
      bytes = await encryptDocument(deps.store.doc, deps.getPassword())
    } catch (e) {
      console.error(e)
      reportWriteError()
      return
    }
    try {
      if (deps.session.handle) {
        await writeFile(deps.session, bytes)
      } else {
        downloadFallback(deps.session.name, bytes)
      }
    } catch (e) {
      if (e instanceof ExternalChangeError) {
        // In-memory doc is never discarded silently: stay dirty, flag the
        // error state, and let the conflict modal (main.ts) decide. Fix #5:
        // if a conflict modal is already open (e.g. this is a trailing round
        // hitting the same external change again), don't ask main.ts to
        // stack a second one.
        deps.shell.setSaveState('error')
        if (!deps.isConflictOpen?.()) {
          deps.onExternalChange()
        }
        return
      }
      console.error(e)
      reportWriteError()
      return
    }
    deps.store.markSaved()
    deps.shell.setSaveState('saved')
    deps.shell.setTitle(deps.session.name, false)
  }

  /**
   * Runs `doSave`, then either chains a trailing round (if a mutation queued
   * one while this round was in flight) or settles the controller back to
   * idle. `saving` stays `true` across that chaining decision — there is no
   * `await` between clearing it and re-arming it for the trailing round — so
   * `flush()`/`runExclusive()` never observe a false "idle" between rounds.
   */
  async function runSave(explicit: boolean): Promise<void> {
    saving = true
    try {
      await doSave(explicit)
    } finally {
      settleAfterSaving()
    }
  }

  function settleAfterSaving(): void {
    saving = false
    if (queued) {
      const nextExplicit = queuedExplicit
      queued = false
      queuedExplicit = false
      void runSave(nextExplicit).catch((e) => console.error(e))
    } else {
      notifyIdle()
    }
  }

  function saveNow(opts?: { explicit?: boolean }): Promise<void> {
    // Fix #2: read-only tabs (lost the cross-tab write lock) never write,
    // full stop — this is the single choke point every trigger (nav,
    // visibility, Ctrl+S, the auto-save interval) funnels through.
    if (deps.store.readOnly) return Promise.resolve()
    // Fix #5: don't even queue an attempt while the conflict modal is open —
    // the auto-save interval firing every few minutes shouldn't pile up
    // trailing saves behind an unresolved conflict.
    if (deps.isConflictOpen?.()) return Promise.resolve()
    const explicit = opts?.explicit ?? false
    if (saving) {
      // Reentrancy guard: never run two writes in parallel. One trailing
      // save is guaranteed once the in-flight one finishes — and that
      // trailing round always does a real save (see `doSave`/`runSave`),
      // since `dirty` alone can't prove nothing changed once this window
      // closes.
      queued = true
      if (explicit) queuedExplicit = true
      return Promise.resolve()
    }
    // Gating here (before `saving` ever flips true) — rather than inside
    // `doSave()` — means two clean/idle `saveNow()` calls in the same tick
    // never race each other into a spurious "reentrant" trailing save: this
    // check-then-return is fully synchronous, with no `await` in between.
    if (!deps.store.dirty) return Promise.resolve()
    return runSave(explicit)
  }

  async function flush(): Promise<void> {
    while (saving) {
      await waitForIdle()
    }
  }

  async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Fix #3: wait out any in-flight save (and its trailing rounds) first,
    // then hold the same `saving` gate across `fn` so a reentrant
    // `saveNow()` — from a nav change, the auto-save interval, etc. — can
    // only queue a trailing round instead of writing in parallel with `fn`.
    //
    // Task 25 re-review item #3: `await flush()` alone isn't a sound mutual
    // exclusion primitive for concurrent callers. `flush()`'s own `while
    // (saving) await waitForIdle()` loop can resolve for two competing
    // callers off the *same* `notifyIdle()` call — both see `saving === false`
    // in their own microtask turn before either has had a chance to flip it
    // back to `true`. Without a second check, the first caller to resume sets
    // `saving = true` and starts `fn`, and the second resumes right behind it
    // and does the same — two `fn` invocations running concurrently, exactly
    // the interleaving this primitive exists to prevent. Re-running the same
    // wait loop immediately before the (still atomic, no-`await`-in-between)
    // check-and-set closes that gap: whichever caller's continuation runs
    // second now observes `saving === true` (set by the first) and waits for
    // it to go idle again before claiming the gate itself. This makes
    // `runExclusive`/`flush` safe for multiple concurrent callers, not just
    // the one call site (`changePassword`) that exists today.
    await flush()
    while (saving) {
      await waitForIdle()
    }
    saving = true
    try {
      return await fn()
    } finally {
      settleAfterSaving()
    }
  }

  function scheduleFrom(prefs: Prefs): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    // Fallback mode (no FS handle) has no silent "overwrite" — every save is
    // a fresh download the user must trigger manually (Ctrl+S), so no
    // background timer is armed; the indicator just stays dirty until then.
    if (!deps.session.handle) return
    const ms = Math.max(1, prefs.autoSaveMin) * 60_000
    timer = setInterval(() => void saveNow(), ms)
  }

  function dispose(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    unsubscribeDirtyGuard()
  }

  return { saveNow, scheduleFrom, runExclusive, flush, dispose }
}
