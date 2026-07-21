declare global { const __APP_VERSION__: string; const __PWA__: boolean; const __PAGES_URL__: string; const __REPO__: string }

import type { Locale } from './core/i18n'
import type { Doc, Loc } from './core/types'
import type { FileSession } from './core/fs'
import { createStore, type Store } from './core/store'
import { lastLocForTeam } from './core/nav'
import { createShell, type Shell } from './ui/shell'
import { showStartScreen } from './ui/start'
import { mountSidebar, notifyNavChanged } from './ui/sidebar'
import { hotkeyAllowed, comboHotkeyAllowed } from './ui/hotkeys'
import { createPaneManager, navigateFocusedHistory, teamHasHistory, openTeamDefaultLayout, type PaneManager } from './ui/panes'
import { setupResponsiveLayout } from './ui/responsive'
import { createPalette } from './ui/palette'
import { mountSearch } from './ui/search-ui'
import { t, todayIso } from './core/i18n'
import { renderDailyNotes } from './modules/daily-notes'
import { renderPeopleTree } from './modules/people-tree'
import { renderPersonNotes } from './modules/person-notes'
import { renderActionItems } from './modules/action-items'
import { renderMilestones } from './modules/milestones'
import { renderRisks } from './modules/risks'
import { openPrefs, onLocaleChanged, type PrefsAppCtl } from './ui/prefs'
import { encryptDocument, decryptDocument, resetSessionKey } from './core/crypto'
import { writeFile, forceWrite, readCurrent, downloadFallback } from './core/fs'
import { toast } from './ui/modal'
import { el } from './ui/dom'
import { createSaveController, type SaveController } from './core/save-controller'
import { showConflictModal } from './ui/conflict'
import { showGlobalHelp } from './ui/help'
import { clearSearchHighlight } from './ui/search-highlight'
import { initInstallCapture, promoHeaderButton, refreshPromoHeaderButton } from './ui/promo'
import { shouldCheck, checkForUpdate, LAST_CHECK_STORAGE_KEY } from './core/update-check'
import { waitForActivation } from './core/sw-ready'
import { showUpdateNotice } from './ui/update-notice'

// beforeinstallprompt fires before the UI mounts — capture must be
// registered at startup or the native install prompt is lost (see
// src/ui/promo.ts). PWA build only; the file:// build has nothing to install.
if (__PWA__) initInstallCapture()

// App controller state lives in this module-level closure only — never on
// window/globals — so the in-memory password never leaves this scope.
interface AppController {
  store: Store
  session: FileSession
  password: string
  shell: Shell
  pm: PaneManager
  saveCtl: SaveController
  /**
   * Task 25 re-review item #4c: tears down the document/window listeners
   * `onDocumentOpened` registers (Ctrl+S keydown, visibilitychange,
   * beforeunload) plus the save controller's own interval/mutation-guard
   * teardown. Nothing calls this today — the app has a single-document
   * lifecycle for its whole lifetime — but future callers (hot-reload, a
   * "close file" action, tests that open more than one document) now have a
   * real, complete teardown path instead of having to rediscover and unwind
   * each listener by hand.
   */
  dispose(): void
}

let app: AppController | null = null

function detectBrowserLocale(): Locale {
  return navigator.language.startsWith('pt') ? 'pt-BR' : 'en-US'
}

type TakeoverMessage = { type: 'takeover' }

/**
 * Task 25: single-writer coordination across tabs of the same browser
 * editing the same file, via the Web Locks API (feature-detected — absent in
 * jsdom, so tests simply never enter this branch and the app stays fully
 * read-write) plus a `BroadcastChannel` for the "take control" handshake.
 *
 * On open, each tab tries to acquire `navigator.locks.request('tmv:' + name,
 * { ifAvailable: true }, ...)`. The tab that gets it holds the lock open (via
 * a Promise that only resolves once explicitly released) and has full
 * read/write access; every other tab enters read-only (`store.setReadOnly`
 * blocks `store.update()`) and shows a banner with a "Take control" button.
 * Clicking it broadcasts a `takeover` message; the holder saves (if dirty),
 * flips itself read-only, and releases the lock; the requester's blocking
 * `navigator.locks.request()` (queued since its own first attempt) is then
 * granted, and it exits read-only.
 */
function setupTabLock(session: FileSession, store: Store, shell: Shell, saveCtl: SaveController): () => void {
  const supportsLocks = typeof navigator !== 'undefined' && !!navigator.locks
  const supportsBroadcast = typeof BroadcastChannel !== 'undefined'
  if (!supportsLocks && !supportsBroadcast) return () => {}

  const channelName = 'tmv:' + session.name
  const bc = supportsBroadcast ? new BroadcastChannel(channelName) : null
  let releaseLock: (() => void) | null = null

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

  function enterReadOnly(): void {
    store.setReadOnly(true)
    if (!banner.isConnected) shell.root.prepend(banner)
  }

  function exitReadOnly(): void {
    store.setReadOnly(false)
    banner.remove()
  }

  function requestLock(waitForRelease: boolean): void {
    if (!supportsLocks) return
    const opts = waitForRelease ? {} : { ifAvailable: true }
    navigator.locks
      .request(channelName, opts, (lock) => {
        if (!lock) {
          enterReadOnly()
          return undefined
        }
        exitReadOnly()
        return new Promise<void>((resolve) => {
          releaseLock = () => {
            releaseLock = null
            resolve()
          }
        })
      })
      .catch((e) => console.error(e))
  }

  function requestTakeover(): void {
    bc?.postMessage({ type: 'takeover' } satisfies TakeoverMessage)
    requestLock(true)
  }

  store.onBlockedUpdate(() => {
    toast(t(store.doc.prefs.locale, 'readonly_blocked_toast'))
  })

  // Task 25 re-review item #4a: without this, the tab is fully writable from
  // the moment the document opens until `navigator.locks.request()`'s
  // callback resolves — an async round trip. A second tab racing to open the
  // same file in that window could both believe they hold write access. Once
  // we know we're actually going to contend for the lock, assume read-only
  // immediately and only open up once the lock is confirmed ours (see
  // `exitReadOnly()` below); if it turns out we're the only tab, this
  // resolves within a tick or two and nothing is ever visible. `silent: true`
  // is required here — plain `setReadOnly(true)` would arm the one-shot
  // `onBlockedUpdate` toast, and a normal single-tab open must never flash it
  // just because this provisional window happened to overlap a keystroke.
  if (supportsLocks) {
    store.setReadOnly(true, { silent: true })
  }

  if (bc) {
    bc.onmessage = (ev: MessageEvent<TakeoverMessage>) => {
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
  }

  requestLock(false)

  // Lets a "close file" action give up write access cleanly — without this,
  // the lock's holding Promise (see requestLock's callback above) never
  // resolves on its own, and reopening the same filename in this same tab
  // would queue forever behind a lock this very tab still holds.
  return function releaseTabLock(): void {
    releaseLock?.()
    bc?.close()
  }
}

function onDocumentOpened(session: FileSession, doc: Doc, password: string): void {
  const shell = createShell(doc.prefs.locale)
  shell.applyPrefs(doc.prefs)
  const promoBtn = promoHeaderButton(doc.prefs.locale)
  if (promoBtn) shell.headerRight.prepend(promoBtn)
  shell.setTitle(session.name, false)
  // Task 25 re-review item #4b: fallback mode (no FS handle) never
  // auto-saves — the user has to notice "Unsaved" and press Ctrl+S. Set once
  // here from whether this session ever got a handle; real fallback mode
  // (browser lacks the File System Access API) can't gain one later, so a
  // one-time flag at open time is accurate for the document's whole lifetime.
  shell.setFallbackHint(!session.handle)

  // Task 25 re-review item #4c: every document/window listener this function
  // registers gets its remover collected here so `dispose()` (assigned to
  // `app.dispose` below) can fully tear the document down. See the
  // `AppController.dispose` doc comment for why this matters even though
  // nothing calls it yet.
  const disposers: Array<() => void> = []
  function dispose(): void {
    for (const d of disposers.splice(0)) {
      try {
        d()
      } catch (e) {
        console.error(e)
      }
    }
  }

  const container = document.getElementById('app')
  if (container) {
    container.innerHTML = ''
    container.appendChild(shell.root)
  } else {
    document.body.appendChild(shell.root)
  }

  const store = createStore(doc)
  const pm = createPaneManager(shell, store, doc.prefs.locale)
  pm.registerModule('daily', renderDailyNotes)
  pm.registerModule('stakeholders', renderPeopleTree('stakeholders'))
  pm.registerModule('members', renderPeopleTree('members'))
  pm.registerModule('person', renderPersonNotes)
  pm.registerModule('actions', renderActionItems)
  pm.registerModule('milestones', renderMilestones)
  pm.registerModule('risks', renderRisks)
  // createPaneManager() renders once at construction time (for the initial
  // layout/CTA), before any registerModule() call above has run — a pane
  // whose saved nav state (e.g. reopening a file) already points at a real
  // module would render "Módulo em construção…" from that first pass and
  // never get another renderAll() to correct it. Re-render now that every
  // module is registered.
  pm.renderAll()
  const palette = createPalette(store, pm)
  shell.onAppNameClick(() => palette.open())
  disposers.push(mountSearch(shell, store, pm, selectTeam))

  // Task 25 fix #5: guards against a second conflict modal stacking on top of
  // the first — e.g. a trailing save round (fix #1) or the auto-save
  // interval hitting the same unresolved `ExternalChangeError` again while
  // the user hasn't chosen Reload/Overwrite yet. Reset once the modal's
  // chosen action (successfully or not) settles.
  let conflictOpen = false

  // Task 25: save orchestration. `getPassword`/`onExternalChange` read live
  // state (never the closed-over `password`/`doc` params) so they stay
  // correct across password changes and re-renders.
  const saveCtl = createSaveController({
    store,
    session,
    getPassword: () => (app ? app.password : password),
    shell,
    locale: () => store.doc.prefs.locale,
    isConflictOpen: () => conflictOpen,
    onExternalChange: () => {
      if (conflictOpen) return
      conflictOpen = true
      showConflictModal({
        locale: store.doc.prefs.locale,
        onReload: async () => {
          try {
            const bytes = await readCurrent(session)
            const reloaded = await decryptDocument(bytes, app ? app.password : password)
            store.replaceDoc(reloaded)
            pm.renderAll()
            notifyNavChanged()
            shell.setSaveState('saved')
            shell.setTitle(session.name, false)
          } catch (e) {
            console.error(e)
            toast(t(store.doc.prefs.locale, 'conflict_reload_failed'), { sticky: true })
          } finally {
            conflictOpen = false
          }
        },
        onOverwrite: async () => {
          try {
            const bytes = await encryptDocument(store.doc, app ? app.password : password)
            await forceWrite(session, bytes)
            store.markSaved()
            shell.setSaveState('saved')
            shell.setTitle(session.name, false)
          } catch (e) {
            console.error(e)
            shell.setSaveState('error')
            toast(t(store.doc.prefs.locale, 'save_error_toast'), { sticky: true })
          } finally {
            conflictOpen = false
          }
        },
      })
    },
  })
  disposers.push(() => saveCtl.dispose())
  app = { store, session, password, shell, pm, saveCtl, dispose }
  saveCtl.scheduleFrom(store.doc.prefs)

  // Task 25 fix #6: `onDirty` was never wired up — the save indicator and
  // title only ever reflected `doSave()`'s own 'saving'/'saved'/'error'
  // transitions, so an edit that landed while idle (state stuck on 'saved'
  // from the last write) left the UI silently lying about unsaved changes
  // until the next save cycle touched the indicator. This keeps both in sync
  // with `store.dirty` directly, independent of the save cycle.
  store.onDirty((dirty) => {
    shell.setSaveState(dirty ? 'dirty' : 'saved')
    shell.setTitle(session.name, dirty)
  })

  // Re-arm the auto-save timer whenever `prefs.autoSaveMin` changes. Nav-only
  // changes (`updateNav`) don't notify `subscribe()`, and prefs are only ever
  // touched via `store.update` (see ui/prefs.ts), so this is a simple,
  // single-point hook that doesn't need to widen ui/prefs.ts's contract.
  let lastAutoSaveMin = store.doc.prefs.autoSaveMin
  store.subscribe(() => {
    if (store.doc.prefs.autoSaveMin !== lastAutoSaveMin) {
      lastAutoSaveMin = store.doc.prefs.autoSaveMin
      saveCtl.scheduleFrom(store.doc.prefs)
    }
  })

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden' && store.dirty) void saveCtl.saveNow()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  disposers.push(() => document.removeEventListener('visibilitychange', onVisibilityChange))

  // A confirmed-reliable save can't be awaited here — browsers don't allow
  // async work to block unload — so this leans on Chrome's native "leave
  // site?" prompt as the safety net for dirty state. But `saveNow()` is
  // still started here (fire-and-forget), not left to `visibilitychange`
  // alone: `visibilitychange` → 'hidden' only fires *after* the user
  // answers this dialog, whereas kicking the save off right here overlaps
  // it with however long the dialog stays open — real time the encrypt
  // (600k-iteration PBKDF2 on every save, see crypto.ts) needs to finish
  // before the page can be torn down.
  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (store.dirty) {
      void saveCtl.saveNow()
      e.preventDefault()
      e.returnValue = ''
    }
  }
  window.addEventListener('beforeunload', onBeforeUnload)
  disposers.push(() => window.removeEventListener('beforeunload', onBeforeUnload))

  const releaseTabLock = setupTabLock(session, store, shell, saveCtl)
  disposers.push(releaseTabLock)

  // Task 24: preferences modal wiring. `changePassword` re-encrypts the
  // current in-memory document under the new password and persists it via
  // the same writeFile/downloadFallback split used by the create flow in
  // src/ui/start.ts. It isn't a regular dirty-driven save, so it doesn't go
  // through `saveCtl.saveNow()` — but (Task 25 fix #3) it does run inside
  // `saveCtl.runExclusive()` so it can't interleave with one, and mirrors
  // its post-write bookkeeping — `markSaved()` so the just-written state
  // isn't re-saved as if still dirty, plus the save indicator/title — since
  // the disk file is now fully in sync with `store.doc` under the new key.
  // `currentPassword` and `fileSchemaVersion` read live from `app`/`store`
  // (not the closed-over `password`/`doc` params) so they stay correct after
  // a password change.
  const prefsAppCtl: PrefsAppCtl = {
    // Task 25 fix #3: previously bypassed `saveCtl` entirely, so it could run
    // concurrently with an auto/nav-triggered save — two writers racing the
    // same file handle — and, worse, could lose the race after `app.password`
    // was already updated: the file on disk would stay encrypted under the
    // *old* password while the UI (and every subsequent save) believed the
    // new one was in effect. `runExclusive` waits out any in-flight save
    // (plus its trailing rounds) first, then holds the same lock while this
    // reads `store.doc` and writes, so no other save can interleave. The doc
    // read and the write both happen inside `fn` so they see a single,
    // consistent snapshot; `app.password`/`markSaved()` only flip after the
    // write actually lands.
    //
    // Task 25 re-review item #2: `runExclusive` alone kept this from
    // interleaving with a save, but it never checked `store.readOnly` — a
    // read-only tab (lost the cross-tab lock) could still successfully
    // rewrite the file under a new password, the one write path every other
    // trigger (`saveNow`/`doSave`) explicitly guards against. The check has
    // to run *inside* `runExclusive`'s `fn`, not before calling it: the tab
    // could still be read-write when `changePassword` is invoked but lose the
    // lock while waiting out an in-flight save, and `fn` is exactly the
    // window that needs to stay guarded once it actually starts writing.
    async changePassword(newPw: string): Promise<void> {
      await saveCtl.runExclusive(async () => {
        if (store.readOnly) throw new Error('read-only')
        const bytes = await encryptDocument(store.doc, newPw)
        if (session.handle) {
          await writeFile(session, bytes)
        } else {
          downloadFallback(session.name, bytes)
          toast(t(store.doc.prefs.locale, 'fallback_notice'), { sticky: true })
        }
        if (app) app.password = newPw
        store.markSaved()
        shell.setSaveState('saved')
        shell.setTitle(session.name, false)
      })
    },
    currentPassword(): string {
      return app ? app.password : password
    },
    // Task 25 re-review item #2 (UX bonus): lets the Security tab disable its
    // submit button and show an explanatory hint instead of only surfacing
    // the rejection after the fact via the generic failure toast.
    isReadOnly(): boolean {
      return store.readOnly
    },
    fileName: session.name,
    fileSchemaVersion: doc.schemaVersion,
  }
  shell.onSettings(() => {
    openPrefs(store, shell, store.doc.prefs.locale, prefsAppCtl)
  })
  shell.onHelp(() => {
    showGlobalHelp(store.doc.prefs.locale)
  })
  store.onMutate(() => clearSearchHighlight())
  disposers.push(
    onLocaleChanged(() => {
      pm.renderAll()
      // Header chrome outside the shell's own applyPrefs re-stamp list.
      if (promoBtn) refreshPromoHeaderButton(promoBtn, store.doc.prefs.locale)
    })
  )

  // Saves (if dirty) and fully tears this document down, releasing the
  // cross-tab write lock, then returns to the start screen — the 🔒 header
  // button and Ctrl+Alt+L. `closing` guards against a double-invocation
  // (e.g. a fast repeat keypress) tearing the same document down twice.
  let closing = false
  function closeFile(): void {
    if (closing || store.readOnly) return
    closing = true
    ;(async () => {
      if (store.dirty) await saveCtl.saveNow({ explicit: true })
      await saveCtl.flush()
      dispose()
      app = null
      // crypto.ts's session key cache is keyed by password alone, with no
      // notion of *which* document it belongs to — must not survive past
      // this document's lifetime, or opening/creating a different file
      // under the same password would silently inherit this one's salt.
      resetSessionKey()
      showStartScreen(store.doc.prefs.locale, onDocumentOpened)
    })().catch((e) => {
      console.error(e)
      closing = false
    })
  }
  shell.onCloseFile(closeFile)

  // Switching teams restores that team's own last session: whether it was
  // last viewed split or single, and — per pane — whichever module it was
  // last showing for this team (from that pane's own history), not a blanket
  // reset to today's daily notes. A team with no recorded session yet (first
  // visit) still gets the default split layout (daily + members).
  function selectTeam(id: string): void {
    if (!teamHasHistory(store, id)) {
      store.updateNav((d) => {
        d.nav.activeTeamId = id
      })
      notifyNavChanged()
      openTeamDefaultLayout(pm, store, id)
      return
    }

    const rememberedSplit = store.doc.nav.teamSplit[id] ?? false
    store.updateNav((d) => {
      d.nav.activeTeamId = id
      d.nav.split = rememberedSplit
    })
    notifyNavChanged()

    // Both panes always get resynced to the new team, regardless of whether
    // it's remembered split or single — `rememberedSplit` only controls
    // *visibility* (d.nav.split, above). Leaving pane 1 unsynced whenever a
    // team's remembered layout is single would let it keep the *previous*
    // team's Loc; that stale state then resurfaces (mixing two teams across
    // visible panes) the moment split is toggled back on. `force: true`
    // bypasses openInPane's same-module dedup guard, which exists for live
    // user actions, not this automated per-pane restore — without it, the
    // write for whichever pane runs second is silently dropped whenever the
    // two remembered Locs happen to share a module kind.
    const todayLoc = (): Loc => ({ teamId: id, ref: { kind: 'daily', date: todayIso() } })
    const pane0Last = lastLocForTeam(store.doc.nav.panes[0], id)
    const pane1Last = lastLocForTeam(store.doc.nav.panes[1], id)
    pm.openBothPanes(pane0Last ?? todayLoc(), pane1Last ?? { teamId: id, ref: { kind: 'members' } }, 1)
  }

  const sidebarHandle = mountSidebar(shell, store, pm, { selectTeam, renderPanes: () => pm.renderAll() })
  disposers.push(
    setupResponsiveLayout(shell.root, {
      setSplitSpaceHidden: (hidden) => pm.setSplitSpaceConstrained(hidden),
      setSidebarSpaceHidden: (hidden) => sidebarHandle.setSpaceConstrained(hidden),
    })
  )

  const onKeyDown = (e: KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      // Always claim Ctrl+S — even while focus is inside an editor field —
      // so the browser's own "save page" dialog never appears.
      e.preventDefault()
      void saveCtl.saveNow({ explicit: true })
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      if (!comboHotkeyAllowed(e)) return
      e.preventDefault()
      palette.open()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l') {
      // Plain Ctrl+L is reserved by browser chrome (focus address bar) in
      // most tabs, outside the page's reach, and Ctrl+Shift+L is a common
      // password-manager autofill binding (e.g. Bitwarden) — Ctrl+Alt+L is
      // free of both, so this actually fires reliably.
      if (!comboHotkeyAllowed(e)) return
      e.preventDefault()
      closeFile()
      return
    }
    if (!e.altKey) return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (!hotkeyAllowed(e)) return
      e.preventDefault()
      navigateFocusedHistory(pm, store, e.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    if (!hotkeyAllowed(e)) return
    const n = Number(e.key)
    if (!Number.isInteger(n) || n < 1 || n > 9) return
    const team = store.doc.teams[n - 1]
    if (!team) return
    e.preventDefault()
    selectTeam(team.id)
  }
  document.addEventListener('keydown', onKeyDown)
  disposers.push(() => document.removeEventListener('keydown', onKeyDown))
}

/**
 * The update banner's PWA reload action. Must guarantee no silent data loss:
 * `saveCtl.flush()` alone only waits out an *already in-flight* save, and
 * `saveNow()` resolves normally even when the write itself fails (errors
 * surface via save-controller.ts's own toast, not a rejection here). So this
 * explicitly saves, waits for that save (and any trailing round) to settle,
 * then checks `store.dirty` as the one signal that survives regardless of
 * *why* the save didn't land (write error, external-change conflict, or a
 * read-only tab that never attempts one in the first place) — if still
 * dirty, abort the reload and leave whatever error UI save-controller.ts
 * already raised as the user's recovery path.
 */
async function reloadForUpdate(): Promise<void> {
  const current = app
  if (current) {
    await current.saveCtl.saveNow({ explicit: true })
    await current.saveCtl.flush()
    if (current.store.dirty) return
  }
  location.reload()
}

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
const SW_READY_TIMEOUT_MS = 15000

let dismissedUpdateVersion: string | null = null

/**
 * Forces the PWA build's service worker to check for and install a new
 * version right now, independent of whatever the boot-time `register()` call
 * below is doing on its own schedule, and waits until it's actually ready
 * (or gives up after SW_READY_TIMEOUT_MS) before returning. This exists so
 * `reloadForUpdate`'s `location.reload()` is guaranteed to be served by the
 * new worker's new cache rather than racing an install still in progress —
 * see docs/superpowers/specs/2026-07-21-update-check-design.md.
 *
 * No-ops for the standalone build (no service worker exists there) and in
 * jsdom (`serviceWorker` is absent from `navigator`, same guard Task 26 uses
 * below for `register()`).
 */
async function ensureServiceWorkerReady(): Promise<void> {
  if (!__PWA__ || !('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.getRegistration().catch(() => null)
  if (!registration) return
  try {
    await registration.update()
  } catch (e) {
    console.error(e)
    return
  }
  const sw = registration.installing ?? registration.waiting
  if (!sw) return
  await waitForActivation(sw, SW_READY_TIMEOUT_MS)
}

async function runUpdateCheck(): Promise<void> {
  if (!shouldCheck(localStorage.getItem(LAST_CHECK_STORAGE_KEY), Date.now())) return
  const result = await checkForUpdate(fetch, __APP_VERSION__, __REPO__)
  if (result.status === 'error') return
  localStorage.setItem(LAST_CHECK_STORAGE_KEY, new Date().toISOString())
  if (result.status !== 'newer' || result.version === dismissedUpdateVersion) return
  await ensureServiceWorkerReady()
  const locale = app?.store.doc.prefs.locale ?? detectBrowserLocale()
  const banner = showUpdateNotice(locale, result.version, reloadForUpdate, (v) => {
    dismissedUpdateVersion = v
  })
  document.body.appendChild(banner)
}

showStartScreen(detectBrowserLocale(), onDocumentOpened)

void runUpdateCheck()
setInterval(() => void runUpdateCheck(), UPDATE_CHECK_INTERVAL_MS)

// Task 26: only the PWA build variant (`__PWA__` true) registers a service
// worker, and only when actually served over http(s) — file:// (the
// single-file `dist/app.html` variant) and the jsdom test environment both
// have no `sw.js` alongside them, so this branch must never run there.
if (__PWA__ && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((e: unknown) => console.error(e))
}

export {}
