// src/core/save-controller.ts — Task 25: turns `store.dirty` into actual
// persisted bytes on disk (or a download in fallback mode), with a single
// writer at a time and a graceful path for every failure mode.
import type { Store } from './store'
import type { Prefs } from './types'
import { buildSnapshot, commitSnapshot, type Snapshot } from './snapshot'
import type { LivePersister } from './live-persist'
import { writeFile, downloadFallback, pickCreate, supportsFsApi, ExternalChangeError, type FileSession } from './fs'
import { t, type Locale } from './i18n'
import type { Shell } from '../ui/shell'
import { toast, dismissToast } from '../ui/modal'

/** `toast()` key for the permission-lapse notice, shared between the toast() call that raises it and the dismissToast() calls that clear it once the lapse is fixed through some other path than the toast's own action button (the save-state pill). */
export const SAVE_PERMISSION_TOAST_KEY = 'save-permission'

/** Shared by every "save failed" toast so a retry that fails again replaces it instead of stacking another sticky copy. */
export const SAVE_ERROR_TOAST_KEY = 'save-error'

export interface SaveController {
  /**
   * `opts.explicit` marks a save as user-initiated (Ctrl+S, "Save as…" retry)
   * as opposed to a best-effort automatic trigger (tab hidden, window blurred,
   * auto-save interval). In fallback mode (no FS handle) only explicit saves
   * are allowed to trigger a `downloadFallback()` — see Task 25 fix #7.
   *
   * Background saves (neither flag) keep a minimum gap after the last good write
   * — `BACKGROUND_GAP_FACTOR` times the slowest of the last three — so a file full
   * of pictures is not rewritten at every tab flip or blur. One inside the gap is
   * deferred to a single trailing save at its end. `urgent` (page unload, a tab-lock
   * handover) skips the wait but, unlike `explicit`, still never downloads.
   */
  saveNow(opts?: { explicit?: boolean; urgent?: boolean }): Promise<void>
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
  /**
   * Re-requests write permission on the file handle, then retries the save.
   * This is the save-state pill's click handler while it's in the 'permission'
   * state, and the "Grant access…" toast action — same recovery either way.
   * A no-op, resolving cleanly, if the grant is already fine and nothing is dirty.
   */
  resolveGrants(): Promise<void>
  dispose(): void
}

export interface SaveControllerDeps {
  store: Store
  session: FileSession
  getPassword(): string | null
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
  /** Told which file write just landed (null: the browser store is unavailable), so the browser copy can record the lineage. */
  persister?: LivePersister | null
  /**
   * Commits any debounced editor change into the store. Called at the top of
   * `saveNow()` — the one choke point every trigger funnels through — so a
   * Ctrl+S, a save-pill click or a tab-lock handover within the editors'
   * debounce window of a keystroke saves that keystroke instead of a document
   * that doesn't contain it yet (and instead of no-opping on a store that only
   * looks clean). Wired to the editors by main.ts; optional so headless
   * callers and tests don't need it.
   */
  flushPending?: () => void
  /** Clock for the background-save gap; tests inject a fake one. Defaults to `Date.now`. */
  now?: () => number
}

/** A background save waits this many times the slowest recent save: 20x keeps writes under ~5% of wall time. */
export const BACKGROUND_GAP_FACTOR = 20
/** How many recent successful saves the gap looks at. */
const GAP_WINDOW = 3

export function createSaveController(deps: SaveControllerDeps): SaveController {
  let saving = false
  let queued = false
  let queuedExplicit = false
  let timer: ReturnType<typeof setInterval> | null = null
  const now = deps.now ?? Date.now
  /** Durations of the last few successful writes (encode + write), and when the latest ended. */
  const recentDurations: number[] = []
  let lastSavedAt = Number.NEGATIVE_INFINITY
  let gapTimer: ReturnType<typeof setTimeout> | null = null
  let idleWaiters: Array<() => void> = []

  // Task 25 fix #1: any edit that lands while a save is in flight must not
  // have its dirty flag cleared without being persisted. `doSave()` snapshots
  // `store.doc` once at the top (via `docToBytes`) — an edit landing
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
  // directly, with no dependence on what the caller does afterward. (Task
  // 11: that call-site convention — `notifyNavChanged()`/`onNavChanged()` —
  // has since been fully removed from the codebase, not just worked around;
  // `ui/sidebar.ts` now hooks `store.onMutate()` the same way this file
  // does.)
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
      key: SAVE_ERROR_TOAST_KEY,
      action: { label: t(lc, 'save_as_ellipsis'), onClick: () => void saveAs() },
    })
  }

  // One-shot per "episode": while the grant stays missing, the auto-save
  // interval keeps retrying — without this, each retry would stack another
  // identical sticky toast. Reset back to false once a write succeeds (see the
  // success tail of doSave()), so a *later*, unrelated lapse still gets its own toast.
  let permissionEpisodeToasted = false

  /**
   * Chromium can drop a file handle's write permission mid-session (tab
   * backgrounded a while, user revoked it via site settings, etc.) without
   * the handle itself becoming invalid — `writeFile()`'s `createWritable()`
   * throws `NotAllowedError` in that case. Recovery is re-requesting
   * permission on the *same* handle, not "Save as…": the file the user
   * already has open is still the right file, it just needs re-granting.
   */
  function reportPermissionNeeded(): void {
    deps.shell.setSaveState('permission')
    if (permissionEpisodeToasted) return
    permissionEpisodeToasted = true
    const lc = deps.locale()
    toast(t(lc, 'save_permission_toast'), {
      sticky: true,
      key: SAVE_PERMISSION_TOAST_KEY,
      action: { label: t(lc, 'grant_access_ellipsis'), onClick: () => void resolveGrants() },
    })
  }

  async function resolveGrants(): Promise<void> {
    const handle = deps.session.handle
    if (handle) {
      try {
        let permission = await handle.queryPermission({ mode: 'readwrite' })
        if (permission !== 'granted') {
          // The button click that triggered this satisfies the user-activation
          // requirement Chromium enforces for re-prompting a downgraded grant.
          permission = await handle.requestPermission({ mode: 'readwrite' })
        }
        if (permission !== 'granted') return
      } catch (e) {
        console.error(e)
        return
      }
    }
    if (deps.store.dirty) await saveNow({ explicit: true })
  }

  /**
   * "Salvar como…" recovery for the generic-error toast. Mutates the shared
   * `deps.session` object in place (rather than swapping it out) so the app
   * controller in main.ts — which holds the very same `FileSession` object —
   * transparently adopts the new file handle without a dedicated callback.
   */
  async function saveAs(): Promise<void> {
    if (!supportsFsApi) return
    let newSession: FileSession | null
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
    // download the user must notice and keep. Automatic triggers
    // (visibilitychange, window blur, the — normally-unarmed — interval) must
    // never fire one; only an explicit user action (Ctrl+S, "Save as…" retry) may.
    if (!deps.session.handle && !explicit) return
    deps.shell.setSaveState('saving')
    const startedAt = now()
    // `snapshot.revAtSnapshot` is what this round's bytes contain. An edit landing after it is not
    // in them: the onMutate guard queues a trailing round for it, and only that
    // round may clear `dirty` (see the markSaved() below).
    let snapshot: Snapshot
    try {
      snapshot = await buildSnapshot(deps.store, deps.getPassword())
    } catch (e) {
      console.error(e)
      reportWriteError()
      return
    }
    try {
      if (deps.session.handle) {
        await writeFile(deps.session, snapshot.bytes)
      } else {
        downloadFallback(deps.session.name, snapshot.bytes)
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
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        console.error(e)
        reportPermissionNeeded()
        return
      }
      console.error(e)
      reportWriteError()
      return
    }
    lastSavedAt = now()
    recentDurations.push(lastSavedAt - startedAt)
    if (recentDurations.length > GAP_WINDOW) recentDurations.shift()
    await commitSnapshot(deps.persister ?? null, snapshot.stamp, snapshot.revAtSnapshot)
    // Clearing `dirty` for bytes that predate an edit would leave that edit
    // unmarked if the trailing round queued for it then fails: no pill, no
    // close prompt, no beforeunload warning, and a tab handover would let it go.
    // Same guard as conflict-flow.ts's overwrite().
    if (deps.store.rev === snapshot.revAtSnapshot) deps.store.markSaved()
    permissionEpisodeToasted = false
    dismissToast(SAVE_PERMISSION_TOAST_KEY)
    dismissToast(SAVE_ERROR_TOAST_KEY)
    // Follows `dirty` rather than assuming 'saved': after a mid-save edit the
    // trailing round may never run (fallback mode, read-only) and nothing else refreshes it.
    deps.shell.setSaveState(deps.store.dirty ? 'dirty' : 'saved')
    deps.shell.setTitle(deps.session.name, deps.store.dirty)
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

  function saveNow(opts?: { explicit?: boolean; urgent?: boolean }): Promise<void> {
    // Fix #2: read-only tabs (lost the cross-tab write lock) never write,
    // full stop — this is the single choke point every trigger (visibility,
    // window blur, Ctrl+S, the auto-save interval) funnels through.
    if (deps.store.readOnly) return Promise.resolve()
    // Fix #5: don't even queue an attempt while the conflict modal is open —
    // the auto-save interval firing every few minutes shouldn't pile up
    // trailing saves behind an unresolved conflict.
    if (deps.isConflictOpen?.()) return Promise.resolve()
    try {
      deps.flushPending?.()
    } catch (e) {
      console.error(e)
    }
    const explicit = opts?.explicit ?? false
    // A background save inside the gap is not dropped but deferred: one timer, which asks again
    // when the gap ends (and writes then only if the document is still dirty). Not armed without a
    // file handle, where a background save never writes anyway.
    if (!explicit && !opts?.urgent && !saving && deps.session.handle && deps.store.dirty) {
      const wait = lastSavedAt + BACKGROUND_GAP_FACTOR * Math.max(0, ...recentDurations) - now()
      if (wait > 0) {
        gapTimer ??= setTimeout(() => {
          gapTimer = null
          saveNow().catch((e) => console.error(e))
        }, wait)
        return Promise.resolve()
      }
    }
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
    // `saveNow()` — from the auto-save interval, a blur/visibility save, etc. — can
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
    if (gapTimer !== null) {
      clearTimeout(gapTimer)
      gapTimer = null
    }
    unsubscribeDirtyGuard()
  }

  return { saveNow, scheduleFrom, runExclusive, flush, resolveGrants, dispose }
}
