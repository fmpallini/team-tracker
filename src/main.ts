declare global { const __APP_VERSION__: string; const __PWA__: boolean; const __PAGES_URL__: string; const __REPO__: string }

import type { Locale } from './core/i18n'
import type { Doc } from './core/types'
import type { FileSession } from './core/fs'
import { createStore, type Store } from './core/store'
import { createShell, type Shell } from './ui/shell'
import { showStartScreen } from './ui/start'
import { mountSidebar } from './ui/sidebar'
import { hotkeyAllowed, comboHotkeyAllowed } from './ui/hotkeys'
import { createPaneManager, navigateFocusedHistory, teamHasHistory, openTeamDefaultLayout, restoreTeamLayout, type PaneManager } from './ui/panes'
import { setupResponsiveLayout } from './ui/responsive'
import { createPalette } from './ui/palette'
import { mountSearch } from './ui/search-ui'
import { t } from './core/i18n'
import { renderDailyNotes } from './modules/daily-notes'
import { renderGeneralNotes } from './modules/general-notes'
import { renderPeopleTree } from './modules/people-tree'
import { renderPersonNotes } from './modules/person-notes'
import { renderActionItems } from './modules/action-items'
import { renderMilestones } from './modules/milestones'
import { renderRisks } from './modules/risks'
import { openPrefs, onLocaleChanged, type PrefsAppCtl } from './ui/prefs'
import { encryptDocument, decryptDocument, serializePlain, parsePlain, resetSessionKey } from './core/crypto'
import { forceWrite, readCurrent, sameEntry } from './core/fs'
import { toast } from './ui/modal'
import { createSaveController, type SaveController } from './core/save-controller'
import { createBackupController } from './core/backup-controller'
import { createChangePassword } from './core/change-password'
import { createTabLock } from './core/tab-lock'
import { installBlurSave } from './core/blur-save'
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
  password: string | null
  shell: Shell
  pm: PaneManager
  saveCtl: SaveController
  /**
   * Task 25 re-review item #4c: tears down the document/window listeners
   * `onDocumentOpened` registers (Ctrl+S keydown, visibilitychange,
   * beforeunload) plus the save controller's own interval/mutation-guard
   * teardown. Invoked by `closeFile()` below (the 🔒 header button /
   * Ctrl+Alt+L) before returning to the start screen — every listener this
   * function tears down must actually be pushed onto `disposers` (see the two
   * registrations fixed alongside this comment) or it leaks across a
   * close-file → open-another-file cycle in the same tab.
   */
  dispose(): void
}

let app: AppController | null = null

// showStartScreen's onOpen callback is typed `=> void` — this adapts
// onDocumentOpened's Promise<void> to that shape without leaving its
// rejection unhandled.
function openDocument(session: FileSession, doc: Doc, password: string | null): void {
  onDocumentOpened(session, doc, password).catch((e: unknown) => console.error(e))
}

/**
 * Shared by `closeFile` and `onDocumentOpened`'s already-open-elsewhere swap:
 * saves (if dirty and writable), waits out the save controller, tears down
 * this document's listeners, and resets the password-derived session key so
 * it can't leak into whichever document opens next. Does not touch `app` or
 * navigate — callers own both.
 */
async function teardownApp(a: Pick<AppController, 'store' | 'saveCtl' | 'dispose'>): Promise<void> {
  if (a.store.dirty && !a.store.readOnly) await a.saveCtl.saveNow({ explicit: true })
  await a.saveCtl.flush()
  a.dispose()
  resetSessionKey()
}

function detectBrowserLocale(): Locale {
  return navigator.language.startsWith('pt') ? 'pt-BR' : 'en-US'
}

async function onDocumentOpened(session: FileSession, doc: Doc, password: string | null): Promise<void> {
  // A second file can be opened while one is already open — e.g. the File
  // Handling API launch consumer (src/ui/start.ts) fires again on a fresh
  // `.tmv` double-click while `focus-existing` (pwa/manifest.json) reuses this
  // same window/tab instead of opening a new one. Without this, `app` would
  // just be overwritten below: the previous session's save-controller
  // interval, its Ctrl+S/beforeunload/visibilitychange listeners, and its
  // cross-tab write lock would all keep running orphaned, and any of its
  // unsaved edits would never be saved before the swap.
  if (app) {
    const prev = app
    // Re-launching the file that's already open (e.g. double-clicking the
    // same .tmv again while it's the focused window) must not blow away
    // in-memory state with whatever's on disk.
    if (await sameEntry(prev.session, session)) {
      toast(t(prev.store.doc.prefs.locale, 'already_open_toast'))
      return
    }
    await teardownApp(prev)
    app = null
  }

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
  // `AppController.dispose` doc comment for why this matters.
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
  pm.registerModule('general', renderGeneralNotes)
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
  disposers.push(() => pm.dispose())
  // sidebarHandle isn't declared until mountSidebar() runs later in this
  // function — safe to reference here because this arrow function only ever
  // executes later (Ctrl+K or the app-name click), by which point
  // mountSidebar() has already returned it.
  const palette = createPalette(store, pm, () => sidebarHandle.openDuePanel())
  shell.onAppNameClick(() => palette.open())
  // Same empty-document rule as the search bar (src/ui/search-ui.ts): driven by
  // onMutate so creating the first team and deleting the last one both reach it.
  const syncAppName = (): void => shell.setAppNameEnabled(store.doc.teams.length > 0)
  syncAppName()
  disposers.push(store.onMutate(syncAppName))
  disposers.push(mountSearch(shell, store, pm, selectTeam))

  // Task 25 fix #5: guards against a second conflict modal stacking on top of
  // the first — e.g. a trailing save round (fix #1) or the auto-save
  // interval hitting the same unresolved `ExternalChangeError` again while
  // the user hasn't chosen Reload/Overwrite yet. Reset once the modal's
  // chosen action (successfully or not) settles.
  let conflictOpen = false

  const backupCtl = createBackupController({ store })

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
    backupCtl,
    onExternalChange: () => {
      if (conflictOpen) return
      conflictOpen = true
      showConflictModal({
        locale: store.doc.prefs.locale,
        onReload: async () => {
          try {
            const bytes = await readCurrent(session)
            const currentPw = app ? app.password : password
            const reloaded = currentPw === null ? parsePlain(bytes) : await decryptDocument(bytes, currentPw)
            if (!reloaded) throw new Error('expected a plain file, got something else on reload')
            store.replaceDoc(reloaded)
            pm.renderAll()
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
            const currentPw = app ? app.password : password
            const bytes = currentPw === null ? serializePlain(store.doc) : await encryptDocument(store.doc, currentPw)
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
  disposers.push(
    store.subscribe(() => {
      if (store.doc.prefs.autoSaveMin !== lastAutoSaveMin) {
        lastAutoSaveMin = store.doc.prefs.autoSaveMin
        saveCtl.scheduleFrom(store.doc.prefs)
      }
    })
  )

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden' && store.dirty) void saveCtl.saveNow()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  disposers.push(() => document.removeEventListener('visibilitychange', onVisibilityChange))

  // The handler above only sees tab switches — minimize and OS-level app
  // switches keep the page 'visible'. See src/core/blur-save.ts.
  disposers.push(installBlurSave({ save: () => void saveCtl.saveNow(), hasFocus: () => document.hasFocus() }))

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

  const releaseTabLock = createTabLock({ session, store, shell, saveCtl, locks: navigator.locks })
  disposers.push(releaseTabLock)

  // Task 24: preferences modal wiring. `changePassword` itself lives in
  // core/change-password.ts (extracted so its concurrency-sensitive logic —
  // Task 25 fix #3, re-review item #2 — is unit testable outside this
  // monolithic entrypoint); this just wires main.ts's own state into it.
  // `currentPassword` and `fileSchemaVersion` read live from `app`/`store`
  // (not the closed-over `password`/`doc` params) so they stay correct after
  // a password change.
  const changePassword = createChangePassword({
    store,
    session,
    shell,
    backupCtl,
    runExclusive: (fn) => saveCtl.runExclusive(fn),
    setPassword: (newPw) => {
      if (app) app.password = newPw
    },
  })
  const prefsAppCtl: PrefsAppCtl = {
    changePassword,
    currentPassword(): string | null {
      return app ? app.password : password
    },
    // Task 25 re-review item #2 (UX bonus): lets the Security tab disable its
    // submit button and show an explanatory hint instead of only surfacing
    // the rejection after the fact via the generic failure toast.
    isReadOnly(): boolean {
      return store.readOnly
    },
    hasFileHandle(): boolean {
      return session.handle !== null
    },
    fileHandle(): FileSystemFileHandle | null {
      return session.handle
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
  disposers.push(store.onMutate(() => clearSearchHighlight()))
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
      await teardownApp({ store, saveCtl, dispose })
      app = null
      showStartScreen(store.doc.prefs.locale, openDocument)
    })().catch((e) => {
      console.error(e)
      closing = false
    })
  }
  shell.onCloseFile(closeFile)
  shell.onSaveRequest(() => void saveCtl.saveNow({ explicit: true }))

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
      openTeamDefaultLayout(pm, store, id)
      return
    }
    restoreTeamLayout(pm, store, id)
  }

  const sidebarHandle = mountSidebar(shell, store, pm, { selectTeam, renderPanes: () => pm.renderAll() })
  disposers.push(() => sidebarHandle.dispose())
  disposers.push(
    setupResponsiveLayout(shell.root, {
      setSplitSpaceHidden: (hidden) => pm.setSplitSpaceConstrained(hidden),
      setSidebarSpaceHidden: (hidden) => sidebarHandle.setSpaceConstrained(hidden),
      setHeaderCompactSpaceHidden: (hidden) => shell.setHeaderCompactSpaceHidden(hidden),
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

showStartScreen(detectBrowserLocale(), openDocument)

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
