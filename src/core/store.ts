import type { Doc } from './types'

export interface Store {
  readonly doc: Doc
  readonly dirty: boolean
  /**
   * True after `setReadOnly(true)` — set by main.ts (Task 25) while this tab
   * has lost the cross-tab write lock. Only `update()` is gated by it (see
   * below); `updateNav()` stays open so a read-only viewer can still browse.
   */
  readonly readOnly: boolean
  update(fn: (d: Doc) => void): void
  updateNav(fn: (d: Doc) => void): void
  subscribe(fn: () => void): () => void
  /**
   * Fires synchronously on EVERY mutation — both `update()` and `updateNav()`
   * — unlike `subscribe()`, which `updateNav()` intentionally bypasses (nav
   * changes shouldn't trigger a full content re-render). Follow-up hardening
   * for save-controller.ts's in-flight-save guard (Task 25 re-review item
   * #1): that guard used to ride on `subscribe()`, which only covered it by
   * call-site convention (every `updateNav()` site happens to also trigger a
   * save through some other path). `onMutate()` makes the guard correct by
   * construction instead. Separate listener set from `subscribe()`; same
   * snapshot-then-try/catch isolation so a throwing listener can't block the
   * others or corrupt the set while iterating.
   */
  onMutate(fn: () => void): () => void
  onDirty(fn: (dirty: boolean) => void): void
  markSaved(): void
  /**
   * Wholesale-replaces the in-memory document (Task 25: used by the conflict
   * modal's "Reload" action after `readCurrent` + `decryptDocument`). Clears
   * `dirty` (the reloaded doc is, by definition, in sync with disk) and
   * notifies `subscribe()` listeners so the whole UI re-renders against the
   * new object.
   */
  replaceDoc(doc: Doc): void
  /**
   * Toggles read-only mode (Task 25: cross-tab lock lost). Turning it off
   * re-arms the one-shot `onBlockedUpdate` warning for the next time it's
   * turned on. `opts.silent` (Task 25 re-review item #4a) marks
   * a `true` transition as provisional — main.ts sets this the instant it's
   * about to ask for the cross-tab write lock, before knowing whether this
   * tab will actually get it, so a single-tab open is never briefly
   * read-only in a way a stray `update()` attempt could notice. A silent
   * transition suppresses `onBlockedUpdate()` for its duration without
   * burning the one-shot warning, so the *real* read-only session (lock
   * genuinely lost/unavailable) still gets its toast the first time an edit
   * is blocked.
   */
  setReadOnly(readOnly: boolean, opts?: { silent?: boolean }): void
  /** Fires at most once per read-only "session" — see `setReadOnly`. */
  onBlockedUpdate(fn: () => void): void
}

export function createStore(initialDoc: Doc): Store {
  let doc = initialDoc
  let dirty = false
  let readOnly = false
  let blockedWarned = false
  let silentReadOnly = false
  const subscribers = new Set<() => void>()
  const mutationListeners = new Set<() => void>()
  const dirtyCallbacks = new Set<(dirty: boolean) => void>()
  const blockedCallbacks = new Set<() => void>()

  const setDirty = (newDirty: boolean) => {
    if (newDirty !== dirty) {
      dirty = newDirty
      for (const fn of Array.from(dirtyCallbacks)) { try { fn(newDirty) } catch (e) { console.error(e) } }
    }
  }

  const notifyMutate = () => {
    for (const fn of Array.from(mutationListeners)) { try { fn() } catch (e) { console.error(e) } }
  }

  const warnBlocked = () => {
    if (blockedWarned || silentReadOnly) return
    blockedWarned = true
    for (const fn of Array.from(blockedCallbacks)) { try { fn() } catch (e) { console.error(e) } }
  }

  return {
    get doc() {
      return doc
    },
    get dirty() {
      return dirty
    },
    get readOnly() {
      return readOnly
    },
    update(fn: (d: Doc) => void): void {
      if (readOnly) {
        warnBlocked()
        return
      }
      fn(doc)
      setDirty(true)
      for (const fn of Array.from(subscribers)) { try { fn() } catch (e) { console.error(e) } }
      notifyMutate()
    },
    updateNav(fn: (d: Doc) => void): void {
      fn(doc)
      setDirty(true)
      notifyMutate()
    },
    subscribe(fn: () => void): () => void {
      subscribers.add(fn)
      return () => {
        subscribers.delete(fn)
      }
    },
    onMutate(fn: () => void): () => void {
      mutationListeners.add(fn)
      return () => {
        mutationListeners.delete(fn)
      }
    },
    onDirty(fn: (dirty: boolean) => void): void {
      dirtyCallbacks.add(fn)
    },
    markSaved(): void {
      setDirty(false)
    },
    replaceDoc(newDoc: Doc): void {
      doc = newDoc
      setDirty(false)
      for (const fn of Array.from(subscribers)) { try { fn() } catch (e) { console.error(e) } }
    },
    setReadOnly(ro: boolean, opts?: { silent?: boolean }): void {
      readOnly = ro
      silentReadOnly = ro ? !!opts?.silent : false
      if (!ro) blockedWarned = false
    },
    onBlockedUpdate(fn: () => void): void {
      blockedCallbacks.add(fn)
    },
  }
}
