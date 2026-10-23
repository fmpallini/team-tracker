declare global { const __APP_VERSION__: string; const __PWA__: boolean; const __PAGES_URL__: string; const __REPO__: string }

import { followLiveCopy } from './core/live-follow'
import type { Locale } from './core/i18n'
import type { FileSession } from './core/fs'
import type { Store } from './core/store'
import type { LivePersister } from './core/live-persist'
import { sharedLiveDb } from './core/live-db'
import { holdDocument, pruneStaleCopies } from './core/browser-copies'
import { reconcileOpen, type OpenedDocument } from './ui/open-document'
import { createShell, type Shell } from './ui/shell'
import { showStartScreen } from './ui/start'
import { OPEN_DATA_PREFS_EVENT } from './ui/image-host'
import { mountSidebar } from './ui/sidebar'
import { resolveAppHotkey, isBrowserSaveChord } from './ui/app-hotkeys'
import { createPaneManager, navigateFocusedHistory, jumpFocusedHistoryToLatest, installMouseHistoryButtons, openPaneModuleByIndex, setFocusedPane, swapPaneSides, teamHasHistory, openTeamDefaultLayout, restoreTeamLayout, type PaneManager } from './ui/panes'
import { setupResponsiveLayout, wcoReservedWidth } from './ui/responsive'
import { createPalette } from './ui/palette'
import { mountSearch } from './ui/search-ui'
import { setReadOnlyLock } from './ui/readonly-lock'
import { t, todayIso } from './core/i18n'
import { currentLoc } from './core/nav'
import { addDaysIso } from './core/date'
import { findTeam, nearestDatedNote } from './core/document'
import { renderDailyNotes, setDailyCalendarSpaceConstrained } from './modules/daily-notes'
import { renderGeneralNotes } from './modules/general-notes'
import { renderPeopleTree } from './modules/people-tree'
import { renderPersonNotes } from './modules/person-notes'
import { renderActionItems } from './modules/action-items'
import { renderMilestones } from './modules/milestones'
import { renderRisks } from './modules/risks'
import { openPrefs, onLocaleChanged, type PrefsAppCtl } from './ui/prefs'
import { resetSessionKey } from './core/crypto'
import { decodeForReload, type ReloadedDocument } from './core/reload-document'
import { readCurrent, sameEntry } from './core/fs'
import { installCtrlWheelFontSize } from './ui/ctrl-wheel-font'
import { toast, showErrorModal, dismissModelessModals, dismissToast, promptPassword } from './ui/modal'
import { UNDO_TOAST_KEY } from './ui/undo-toast'
import { updateAppBadge } from './core/app-badge'
import { requestPersistentStorage, ensurePersistentStorage } from './core/storage-persist'
import { createFileSnapshot, type FileSnapshot } from './core/file-snapshot'
import { closeDocument, createBeforeUnloadHandler, downloadCopy, browserCopyAtRisk, retryWrites } from './core/close-document'
import { showWriteFailedDialog } from './ui/write-failed'
import { watchFileHealth, watchStoreHealth } from './ui/file-health-toasts'
import { createChangePassword } from './core/change-password'
import { createTabLock } from './core/tab-lock'
import { resolveFileLockKey } from './core/file-identity'
import { createConflictFlow } from './core/conflict-flow'
import { reopenFork } from './core/fork-reopen'
import { closeAnyContextMenu } from './ui/context-menu'
import { closeAnyBacklinksPanel } from './ui/backlinks-panel'
import { showGlobalHelp } from './ui/help'
import { clearSearchHighlight } from './ui/search-highlight'
import { flushAllEditors, setEditorsReadOnly } from './ui/editor'
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
  /** Writes the `.tmv` file at open, close and on the timer, and reports whether it can. */
  snapshot: FileSnapshot
  /** Keeps the browser copy of the document current; null when the browser could not open its storage. */
  persister: LivePersister | null
  /** Whether the external-change conflict modal is up — teardown leaves it to resolve an unsaved close rather than stacking a discard prompt over it. */
  isConflictOpen(): boolean
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
function openDocument(opened: OpenedDocument): void {
  const { doc } = opened
  onDocumentOpened(opened).catch((e: unknown) => {
    console.error(e)
    // Previously silent (console.error only) — a throw here left the user
    // staring at whatever partially rendered before it, with no feedback at
    // all. This doesn't change the happy path, only what happens on a
    // failure that used to be invisible.
    showErrorModal(doc.prefs.locale, t(doc.prefs.locale, 'err_unexpected'))
  })
}

/**
 * Everything a document holds that outlives its store, released when it goes away: its listeners and timers, the two
 * module-level popovers, the password-derived session key (so it cannot leak into whichever document opens next), and a
 * still-showing undo toast whose restore closure captured a team from THIS document.
 */
function releaseDocument(dispose: () => void): void {
  dispose()
  // Both are module-level singletons (one popover open at a time, app-wide), not anything dispose() owns. Left open
  // across a file close, either would keep this document's store/pm reachable via its onClick/onNavigate closures,
  // pinned by two capturing `document` listeners.
  closeAnyContextMenu()
  closeAnyBacklinksPanel()
  resetSessionKey()
  dismissToast(UNDO_TOAST_KEY)
}

/**
 * Lock/Close (core/close-document.ts): writes the file, or shows why it cannot and what can be done, and releases the
 * document unless the user stays. Shared by the lock button, Ctrl+Alt+L and the swap to another file. Resolves whether
 * the document is gone.
 */
async function closeAppDocument(a: Pick<AppController, 'store' | 'snapshot' | 'persister' | 'session' | 'dispose' | 'isConflictOpen'> & { getPassword(): string | null }): Promise<boolean> {
  const result = await closeDocument({
    store: a.store, persister: a.persister, snapshot: a.snapshot, session: a.session,
    getPassword: () => a.getPassword(),
    flushEditors: flushAllEditors,
    ask: (o) => showWriteFailedDialog({ ...o, locale: a.store.doc.prefs.locale }),
    isConflictOpen: () => a.isConflictOpen(),
    teardown: () => releaseDocument(() => a.dispose()),
  })
  return result === 'closed'
}

function detectBrowserLocale(): Locale {
  return navigator.language.startsWith('pt') ? 'pt-BR' : 'en-US'
}

/** Resolves whether the document was mounted: false when the file is already open, or the open one could not be closed. */
async function onDocumentOpened(opened: OpenedDocument): Promise<boolean> {
  const { session, doc, password, store, handle, needsFileWrite } = opened
  const persister = handle?.persister ?? null
  // A second file can be opened while one is already open — e.g. the File
  // Handling API launch consumer (src/ui/start.ts) fires again on a fresh
  // `.tmv` double-click while `focus-existing` (pwa/manifest.json) reuses this
  // same window/tab instead of opening a new one. Without this, `app` would
  // just be overwritten below: the previous session's file timer,
  // its beforeunload/visibilitychange listeners, and its
  // cross-tab write lock would all keep running orphaned, and any of its
  // unwritten edits would never reach the file before the swap.
  if (app) {
    const prev = app
    // Re-launching the file that's already open (e.g. double-clicking the
    // same .tmv again while it's the focused window) must not blow away
    // in-memory state with whatever's on disk.
    if (await sameEntry(prev.session, session)) {
      toast(t(prev.store.doc.prefs.locale, 'already_open_toast'))
      return false
    }
    // A file that can't be written keeps the previous document open and
    // abandons this open, unless the user explicitly closes it anyway.
    if (!(await closeAppDocument({ ...prev, getPassword: () => prev.password }))) return false
    app = null
  }

  const shell = createShell(doc.prefs.locale)
  shell.applyPrefs(doc.prefs)
  const promoBtn = promoHeaderButton(doc.prefs.locale)
  if (promoBtn) shell.headerRight.prepend(promoBtn)
  shell.setTitle(session.name)

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

  // Releases the shell's OS-theme matchMedia listener. That listener lives on
  // an object outliving the document, so leaving it attached kept this whole
  // shell (and its DOM) reachable for the life of the tab — see Shell.dispose.
  disposers.push(() => shell.dispose())

  // Live read — never the closed-over `password` parameter alone: a password
  // change updates `app.password`, and the parameter goes stale after it.
  const currentPassword = (): string | null => (app ? app.password : password)
  const pm = createPaneManager(shell, store)
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
  // `selectTeam` is a hoisted function declaration (below), safe to pass here.
  const palette = createPalette(store, pm, { selectTeam })
  shell.onAppNameClick(() => palette.open())
  // Same empty-document rule as the search bar (src/ui/search-ui.ts): driven by
  // onMutate so creating the first team and deleting the last one both reach it.
  const syncAppName = (): void => shell.setAppNameEnabled(store.doc.teams.length > 0)
  syncAppName()
  disposers.push(store.onMutate(syncAppName))

  disposers.push(mountSearch(shell, store, pm, selectTeam, pm.searchIndex))

  // The conflict modal's "Reload": read what is on disk now, then (conflict-flow.ts, once it has checked it is
  // the same document) swap it in.
  async function readFromDisk(): Promise<ReloadedDocument> {
    const bytes = await readCurrent(session)
    // The file may no longer be under the password this tab opened it with
    // (changed, added or removed in another tab) — see core/reload-document.ts.
    return decodeForReload(bytes, currentPassword(), async (wasWrong) => {
      const lc = store.doc.prefs.locale
      if (wasWrong) toast(t(lc, 'err_wrong_password'))
      const result = await promptPassword(lc, { title: t(lc, 'reload_password_title') })
      return result === null ? null : (result as { password: string }).password
    })
  }

  function applyReloaded(reloaded: ReloadedDocument): void {
    if (app && app.store === store) app.password = reloaded.password
    store.replaceDoc(reloaded.doc, reloaded.images)
    // The reloaded document may carry different look-and-feel prefs (theme,
    // palette, font, locale) than the one it replaces.
    shell.applyPrefs(reloaded.doc.prefs)
    pm.renderAll()
  }

  // A tab taking the write lock over from another: the previous holder flushed its edits to the browser copy on the
  // way out, so that copy — not the file, which may be hours older — is what this tab must continue from.
  async function reloadFromLive(): Promise<void> {
    if (!handle || !persister) return
    // The previous holder may have changed the password meanwhile: follow the key the copy is under now.
    const followed = await followLiveCopy({
      live: handle.live,
      currentPassword: currentPassword(),
      askPassword: async (wasWrong) => {
        const lc = store.doc.prefs.locale
        if (wasWrong) toast(t(lc, 'err_wrong_password'))
        const result = await promptPassword(lc, { title: t(lc, 'reload_password_title') })
        return result === null ? null : (result as { password: string }).password
      },
    })
    // Reseed first: the persister's cache is from before the other tab's writes, and diffing the reloaded
    // document against it would rewrite every record the other tab changed.
    await persister.reseed({ records: followed.stored.records, blobIds: followed.stored.blobs.keys() })
    if (app && app.store === store) app.password = followed.password
    store.replaceDoc(followed.doc, followed.images)
    if (followed.unwritten) store.markDirty()
    shell.applyPrefs(followed.doc.prefs)
    pm.renderAll()
  }

  // The external-change conflict modal and its Reload / Overwrite / Fork choices
  // (see core/conflict-flow.ts). `snapshot` is assigned just below — safe because
  // `resolveGrants` only runs from the permission toast, long after setup.
  const conflictFlow = createConflictFlow({
    store, session, shell,
    getPassword: currentPassword,
    readFromDisk,
    applyReloaded,
    resolveGrants: async () => { await snapshot.resolveGrants() },
    persister,
    snapshot: { fileWritten: () => snapshot.fileWritten(), fileReloaded: () => snapshot.fileReloaded(), fileWriteFailed: (r) => snapshot.fileWriteFailed(r) },
    // The fork is a new document with a browser copy of its own; the original's copy (docId unchanged) goes once
    // the fork is up, because its edits now live in the fork and the original file belongs to the other writer.
    reopen: (forkSession, forkDoc, forkPassword, forkImages, stamp) => {
      void reopenFork({
        reconcile: async () => reconcileOpen({
          locale: forkDoc.prefs.locale, db: await sharedLiveDb(), session: forkSession, password: forkPassword,
          opened: { doc: forkDoc, preSchemaVersion: forkDoc.schemaVersion, images: forkImages, stamp },
        }),
        mount: (forked) => onDocumentOpened(forked),
        removeOriginalCopy: async () => { await handle?.live.remove() },
      }).catch((e: unknown) => {
        console.error(e)
        showErrorModal(forkDoc.prefs.locale, t(forkDoc.prefs.locale, 'err_unexpected'))
      })
    },
  })

  // The file as a periodic snapshot: written at open (when the browser copy is ahead), at Lock/Close and on the
  // timer. `getPassword`/`onExternalChange` read live state (never the closed-over `password`/`doc` params) so they
  // stay correct across password changes and re-renders.
  const snapshot = createFileSnapshot({
    store,
    session,
    getPassword: currentPassword,
    persister,
    isConflictOpen: conflictFlow.isOpen,
    onExternalChange: conflictFlow.onExternalChange,
    // A debounced editor change must be in the store before the document is serialized.
    flushPending: flushAllEditors,
  })
  disposers.push(() => snapshot.dispose())
  app = { store, session, password, shell, pm, snapshot, persister, isConflictOpen: conflictFlow.isOpen, dispose }
  snapshot.scheduleFrom(store.doc.prefs)
  if (persister) disposers.push(() => persister.dispose())

  // The save pill shows whether the file can be written when it needs to be (the browser copy is what keeps the work
  // safe), and nothing about "unsaved": every time it mentions is in its hover.
  const paintPill = (): void => shell.setFileHealth(snapshot.health(), {
    nextWriteAt: snapshot.nextWriteAt(),
    storeError: persister?.lastError != null,
    readOnly: store.readOnly,
  })
  disposers.push(snapshot.subscribe(paintPill))
  if (persister) disposers.push(persister.onErrorChange(paintPill))
  disposers.push(store.onReadOnlyChange(paintPill))
  // Asked once per opened document, in every build: the live copy lives in this origin's storage. The answer is shown in Preferences.
  void ensurePersistentStorage()
  disposers.push(watchFileHealth(snapshot, () => store.doc.prefs.locale))
  if (persister) disposers.push(watchStoreHealth(persister, () => store.doc.prefs.locale))
  // A document opened from the browser's copy starts ahead of its file: write it as soon as this tab may write
  // (the tab lock decides that a moment after opening; a read-only tab never writes the file).
  let openWriteOwed = needsFileWrite
  const writeOpenIfOwed = (): void => {
    if (!openWriteOwed || store.readOnly) return
    openWriteOwed = false
    void snapshot.writeNow('open')
  }
  disposers.push(store.onReadOnlyChange(writeOpenIfOwed))
  writeOpenIfOwed()

  // The browser copy is the live store, so leaving the page must not strand an edit still in the debounce.
  // Hidden covers tab switches and mobile-style backgrounding; pagehide covers the close itself.
  const flushBrowserCopy = (): void => {
    flushAllEditors()
    void persister?.flush()
  }
  const onVisibility = (): void => { if (document.visibilityState === 'hidden') flushBrowserCopy() }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', flushBrowserCopy)
  disposers.push(() => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', flushBrowserCopy)
  })

  // Re-arm the auto-save timer whenever `prefs.autoSaveMin` changes.
  // Nav-only changes (`updateNav`) don't notify `subscribe()`, and prefs are
  // only ever touched via `store.update`, so this is a simple, single-point
  // hook that doesn't need to widen ui/prefs.ts's contract.
  let lastAutoSaveMin = store.doc.prefs.autoSaveMin
  disposers.push(
    store.subscribe(() => {
      if (store.doc.prefs.autoSaveMin !== lastAutoSaveMin) {
        lastAutoSaveMin = store.doc.prefs.autoSaveMin
        snapshot.scheduleFrom(store.doc.prefs)
        paintPill() // the next-write time in its hover
      }
    })
  )

  // Closing the window cannot wait for an asynchronous file write: see createBeforeUnloadHandler.
  const onBeforeUnload = createBeforeUnloadHandler({ flushEditors: flushAllEditors, store, persister, snapshot })
  window.addEventListener('beforeunload', onBeforeUnload)
  disposers.push(() => window.removeEventListener('beforeunload', onBeforeUnload))

  const releaseTabLock = createTabLock({
    session, store, shell, locks: navigator.locks,
    flushLive: async () => {
      // A keystroke still inside the editors' debounce is not in the store yet, so not in the browser copy either.
      flushAllEditors()
      // No browser storage: the file is all there is to hand over through.
      if (!persister) {
        const r = await snapshot.writeNow('close')
        if (!r.ok && r.reason !== 'nohandle' && r.reason !== 'readonly') throw new Error(`file write failed: ${r.reason}`)
        return
      }
      await persister.flush()
      if (persister.lastError) throw persister.lastError instanceof Error ? persister.lastError : new Error('the browser could not store the latest changes')
    },
    // Per file, not per file name — see core/file-identity.ts.
    lockKey: resolveFileLockKey(session, navigator.locks),
    onReadOnlyChange: (readOnly) => {
      setEditorsReadOnly(readOnly)
      setReadOnlyLock(readOnly, () => store.doc.prefs.locale)
    },
    // The tab that held the lock flushed its edits to the browser copy on its way out.
    refreshBeforeWritable: reloadFromLive,
  })
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
    persister,
    onBrowserCopyRekeyFailed: () => toast(t(store.doc.prefs.locale, 'live_rekey_failed_toast'), { sticky: true }),
    snapshot,
    runExclusive: (fn) => snapshot.runExclusive(fn),
    getPassword: currentPassword,
    setPassword: (newPw) => {
      if (app) app.password = newPw
    },
  })

  // Other tabs must not delete this document's browser copy (core/browser-copies.ts); the prune of long-unused clean
  // copies of other documents runs once the storage is known to work.
  disposers.push(holdDocument(store.doc.docId, navigator.locks))
  void sharedLiveDb()
    .then(async (liveDb) => {
      if (liveDb) await pruneStaleCopies(liveDb, store.doc.docId, navigator.locks, Date.now())
    })
    .catch((e: unknown) => console.error(e))

  const prefsAppCtl: PrefsAppCtl = {
    changePassword,
    currentPassword,
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
  // The image-limit toast's "Show usage" action (ui/image-host.ts) asks for the Data tab, where the usage line lives.
  const openDataPrefs = (): void => openPrefs(store, shell, store.doc.prefs.locale, prefsAppCtl, 'data')
  document.addEventListener(OPEN_DATA_PREFS_EVENT, openDataPrefs)
  disposers.push(() => document.removeEventListener(OPEN_DATA_PREFS_EVENT, openDataPrefs))
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
  // Deliberately NOT gated on `store.readOnly`: a tab that lost (or never got)
  // the cross-tab write lock must still be able to close — teardownApp() and
  // saveNow() both refuse to write while read-only, so it closes unsaved.
  // A writable document whose final save fails stays open (teardownOrConfirm)
  // unless the user explicitly chooses to discard.
  let closing = false
  function closeFile(): void {
    if (closing) return
    closing = true
    ;(async () => {
      if (!(await closeAppDocument({ store, snapshot, persister, session, dispose, isConflictOpen: conflictFlow.isOpen, getPassword: currentPassword }))) {
        closing = false
        return
      }
      app = null
      // No file open once we're back at the start screen — same reasoning as
      // the launch-time clear above.
      if (__PWA__) updateAppBadge(0)
      showStartScreen(store.doc.prefs.locale, openDocument, { skipAutoLoad: true })
    })().catch((e) => {
      console.error(e)
      closing = false
    })
  }
  shell.onCloseFile(closeFile)
  // The pill's click: re-grant a lapsed permission; export where no file can be written silently; the failure dialog
  // after a failed write (the same one Lock/Close shows, without the way to close).
  shell.onPillAction((action) => {
    if (action === 'regrant') void snapshot.resolveGrants()
    else if (action === 'export') void snapshot.writeNow('export')
    else {
      void showWriteFailedDialog({
        locale: store.doc.prefs.locale, reason: 'error', canRegrant: false, allowCloseAnyway: false,
        copyFailed: !persister || persister.lastError != null,
        onRegrant: () => snapshot.resolveGrants(),
        onDownload: () => { void downloadCopy(store, session, currentPassword) },
        onRetry: () => retryWrites({ persister, snapshot, session }),
      })
    }
  })

  // Switching teams restores that team's own last session: whether it was
  // last viewed split or single, and — per pane — whichever module it was
  // last showing for this team (from that pane's own history), not a blanket
  // reset to today's daily notes. A team with no recorded session yet (first
  // visit) still gets the default split layout (daily + members).
  function selectTeam(id: string): void {
    // A modeless card modal open in some pane must close (flushing its notes
    // editor) before the team switch tears that pane's renderer down; if its
    // required-name guard refuses, abort the switch and leave the user on it.
    // Skipped when re-selecting the current team (no teardown happens).
    if (id !== store.doc.nav.activeTeamId && !dismissModelessModals()) return
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
      setHeaderTeamSpaceHidden: (hidden) => shell.setHeaderTeamSpaceHidden(hidden),
      setCalendarSpaceHidden: (hidden) => setDailyCalendarSpaceConstrained(hidden),
    }, { reservedWidth: wcoReservedWidth })
  )

  // Every hotkey below that re-targets a pane, moves pane focus, or tears the
  // layout down first closes an open modeless card modal — its onClose flushes
  // the notes editor, so nothing typed is lost. If the card can't close yet
  // (content entered but no name) the hotkey becomes a no-op and focus returns
  // to the name field, exactly as Escape behaves. See ui/modal.ts.
  const navPastModelessCard = (): boolean => dismissModelessModals()

  // Routing table lives in ui/app-hotkeys.ts (pure, unit-tested); this half
  // is the effects. `resolveAppHotkey` returning an action always means
  // "consume the event", so preventDefault() fires unconditionally on a hit.
  // `navPastModelessCard()` — an effect, not a routing input — runs after
  // preventDefault on exactly the branches that ran it inline before.
  const onKeyDown = (e: KeyboardEvent): void => {
    const focusedLoc = currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])
    // There is no manual save, but the browser's own "save page" dialog must still never appear.
    if (isBrowserSaveChord(e)) {
      e.preventDefault()
      return
    }
    const action = resolveAppHotkey(e, {
      teamCount: store.doc.teams.length,
      focusedPaneShowsDailyNote: !!focusedLoc && focusedLoc.ref.kind === 'daily',
    })
    if (!action) return
    e.preventDefault()
    switch (action.type) {
      case 'palette':
        palette.open()
        return
      case 'closeFile':
        if (navPastModelessCard()) closeFile()
        return
      case 'paneModule':
        if (navPastModelessCard()) openPaneModuleByIndex(pm, store, action.index)
        return
      case 'historyStep':
        if (navPastModelessCard()) navigateFocusedHistory(pm, store, action.dir)
        return
      case 'historyLatest':
        if (navPastModelessCard()) jumpFocusedHistoryToLatest(pm, store)
        return
      case 'dayNav': {
        const idx = store.doc.nav.focusedPane
        const loc = currentLoc(store.doc.nav.panes[idx])
        if (!loc || loc.ref.kind !== 'daily') return
        let date: string
        // Only the content jump (skips over empty days) flashes the header —
        // where you land isn't obvious. A plain ±1 step or "today" doesn't.
        let flashTitle = false
        if (action.to === 'today') {
          date = todayIso()
        } else if (action.to === 'prev' || action.to === 'next') {
          date = addDaysIso(loc.ref.date, action.to === 'prev' ? -1 : 1)
        } else {
          // 'prevWithContent' / 'nextWithContent': skip empty days entirely.
          // No dated note in that direction → stay put, don't open a blank day.
          const team = findTeam(store.doc, loc.teamId)
          const target = team
            ? nearestDatedNote(team.dailyNotes, loc.ref.date, action.to === 'prevWithContent' ? -1 : 1)
            : null
          if (!target) return
          date = target
          flashTitle = true
        }
        pm.openInPane(idx, { teamId: loc.teamId, ref: { kind: 'daily', date } }, { flashTitle })
        return
      }
      case 'selectPane':
        if (navPastModelessCard() && setFocusedPane(store, action.index)) pm.renderAll()
        return
      case 'toggleSplit':
        if (navPastModelessCard()) pm.toggleSplit()
        return
      case 'swapPanes':
        if (navPastModelessCard() && swapPaneSides(store)) pm.renderAll()
        return
      case 'selectTeam': {
        const team = store.doc.teams[action.index]
        if (team) selectTeam(team.id)
        return
      }
    }
  }
  document.addEventListener('keydown', onKeyDown)
  disposers.push(() => document.removeEventListener('keydown', onKeyDown))
  disposers.push(installMouseHistoryButtons(pm, store, navPastModelessCard))

  disposers.push(installCtrlWheelFontSize(store, shell))
  return true
}

/**
 * The update banner's PWA reload action. Must guarantee no silent data loss:
 * it writes the file as Lock/Close would (the browser copy keeps the edits
 * either way), and a write that fails — which `writeNow()` reports in its
 * result and through the health toasts, not as a rejection — aborts the
 * reload and leaves that error UI as the user's recovery path.
 */
async function reloadForUpdate(): Promise<void> {
  const current = app
  if (current) {
    flushAllEditors()
    const written = await current.snapshot.writeNow('close')
    await current.snapshot.flush()
    await current.persister?.flush()
    // A write that failed leaves whatever error UI the snapshot raised as the user's way out; the page stays. So does a
    // reload that would drop edits only this tab's memory holds (no file to write and no working browser copy): the
    // store-failure toast and pill are that case's way out.
    if (!written.ok && written.reason !== 'readonly' && written.reason !== 'nohandle') return
    if (browserCopyAtRisk(current.store, current.persister)) return
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

// The badge only means anything while a team file is open (it mirrors that
// file's own overdue+due-soon total, set by sidebar.ts on each render) — an
// app launch with no file open yet must never show a stale count left over
// from whatever was open in a previous session.
if (__PWA__) {
  updateAppBadge(0)
  requestPersistentStorage()
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
