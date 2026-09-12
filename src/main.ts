declare global { const __APP_VERSION__: string; const __PWA__: boolean; const __PAGES_URL__: string; const __REPO__: string }

import type { Locale } from './core/i18n'
import type { Doc } from './core/types'
import type { FileSession } from './core/fs'
import { createStore, type Store } from './core/store'
import { createShell, type Shell } from './ui/shell'
import { showStartScreen } from './ui/start'
import { mountSidebar } from './ui/sidebar'
import { resolveAppHotkey } from './ui/app-hotkeys'
import { createPaneManager, navigateFocusedHistory, jumpFocusedHistoryToLatest, openPaneModuleByIndex, setFocusedPane, swapPaneSides, teamHasHistory, openTeamDefaultLayout, restoreTeamLayout, type PaneManager } from './ui/panes'
import { setupResponsiveLayout } from './ui/responsive'
import { createPalette } from './ui/palette'
import { mountSearch } from './ui/search-ui'
import { t, todayIso } from './core/i18n'
import { currentLoc } from './core/nav'
import { addDaysIso } from './core/date'
import { findTeam, nearestDatedNote } from './core/document'
import { stepFontSize } from './core/font-size'
import { renderDailyNotes, setDailyCalendarSpaceConstrained } from './modules/daily-notes'
import { renderGeneralNotes } from './modules/general-notes'
import { renderPeopleTree } from './modules/people-tree'
import { renderPersonNotes } from './modules/person-notes'
import { renderActionItems } from './modules/action-items'
import { renderMilestones } from './modules/milestones'
import { renderRisks } from './modules/risks'
import { openPrefs, onLocaleChanged, type PrefsAppCtl } from './ui/prefs'
import { encryptDocument, decryptDocument, serializePlain, parsePlain, resetSessionKey } from './core/crypto'
import { forceWrite, readCurrent, sameEntry } from './core/fs'
import { toast, showErrorModal, dismissModelessModals } from './ui/modal'
import { updateAppBadge } from './core/app-badge'
import { createSaveController, type SaveController } from './core/save-controller'
import { createBackupController, backupHealthPillState } from './core/backup-controller'
import { createChangePassword } from './core/change-password'
import { createTabLock } from './core/tab-lock'
import { installBlurSave } from './core/blur-save'
import { showConflictModal } from './ui/conflict'
import { closeAnyContextMenu } from './ui/context-menu'
import { closeAnyBacklinksPanel } from './ui/backlinks-panel'
import { showGlobalHelp } from './ui/help'
import { clearSearchHighlight } from './ui/search-highlight'
import { flushAllEditors } from './ui/editor'
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
function openDocument(session: FileSession, doc: Doc, password: string | null, migratedFrom: Uint8Array | null): void {
  onDocumentOpened(session, doc, password, migratedFrom).catch((e: unknown) => {
    console.error(e)
    // Previously silent (console.error only) — a throw here left the user
    // staring at whatever partially rendered before it, with no feedback at
    // all. This doesn't change the happy path, only what happens on a
    // failure that used to be invisible.
    showErrorModal(doc.prefs.locale, t(doc.prefs.locale, 'err_unexpected'))
  })
}

/**
 * Shared by `closeFile` and `onDocumentOpened`'s already-open-elsewhere swap:
 * saves (if dirty and writable), waits out the save controller, tears down
 * this document's listeners, and resets the password-derived session key so
 * it can't leak into whichever document opens next. Does not touch `app` or
 * navigate — callers own both.
 */
async function teardownApp(a: Pick<AppController, 'store' | 'saveCtl' | 'dispose'>): Promise<void> {
  // BEFORE the dirty check, not after: a debounced editor change still in
  // flight hasn't reached the store yet, so both `store.dirty` and whatever
  // `saveNow()` serializes would miss it. `a.dispose()` below flushes it
  // eventually — but only after the save has already run, i.e. into a document
  // nobody writes again.
  flushAllEditors()
  if (a.store.dirty && !a.store.readOnly) await a.saveCtl.saveNow({ explicit: true })
  await a.saveCtl.flush()
  a.dispose()
  // Both are module-level singletons (one popover open at a time, app-wide —
  // see their own files) rather than anything a.dispose()'s per-document
  // teardown owns. Left open across a file close, either would keep this
  // document's store/pm reachable via its onClick/onNavigate closures, pinned
  // by two capturing `document` listeners that would otherwise only get torn
  // down the next time that same popover type happens to open again —
  // possibly in a much later, unrelated document, or never.
  closeAnyContextMenu()
  closeAnyBacklinksPanel()
  resetSessionKey()
}

function detectBrowserLocale(): Locale {
  return navigator.language.startsWith('pt') ? 'pt-BR' : 'en-US'
}

async function onDocumentOpened(session: FileSession, doc: Doc, password: string | null, migratedFrom: Uint8Array | null): Promise<void> {
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

  // Releases the shell's OS-theme matchMedia listener. That listener lives on
  // an object outliving the document, so leaving it attached kept this whole
  // shell (and its DOM) reachable for the life of the tab — see Shell.dispose.
  disposers.push(() => shell.dispose())

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
  // executes later (Ctrl+Shift+K or the app-name click), by which point
  // mountSidebar() has already returned it.
  const palette = createPalette(store, pm, () => sidebarHandle.openDuePanel())
  shell.onAppNameClick(() => palette.open())
  // Same empty-document rule as the search bar (src/ui/search-ui.ts): driven by
  // onMutate so creating the first team and deleting the last one both reach it.
  const syncAppName = (): void => shell.setAppNameEnabled(store.doc.teams.length > 0)
  syncAppName()
  disposers.push(store.onMutate(syncAppName))
  disposers.push(mountSearch(shell, store, pm, selectTeam, pm.searchIndex))

  // Task 25 fix #5: guards against a second conflict modal stacking on top of
  // the first — e.g. a trailing save round (fix #1) or the auto-save
  // interval hitting the same unresolved `ExternalChangeError` again while
  // the user hasn't chosen Reload/Overwrite yet. Reset once the modal's
  // chosen action (successfully or not) settles.
  let conflictOpen = false

  const backupCtl = createBackupController({ store })

  // A migration just ran on open (see start.ts's peekPlainSchemaVersion/
  // peekEncryptedSchemaVersion) — snapshot the original, unmigrated bytes to
  // the backup mirror once, before any edit/autosave can overwrite it with
  // post-migration state. Fire-and-forget: writeBackupNow never throws, and
  // nothing downstream depends on this completing before the shell renders.
  if (migratedFrom) {
    void backupCtl.writeBackupNow(migratedFrom)
  }

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
    // prefsAppCtl is assigned later in this same function scope (below) —
    // safe because this closure only runs on a save failure well after
    // setup completes, never during the temporal dead zone.
    onOpenBackupPrefs: () => openPrefs(store, shell, store.doc.prefs.locale, prefsAppCtl, 'backup'),
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
            if (e instanceof DOMException && e.name === 'NotAllowedError') {
              // Same lapsed-permission case save-controller.ts's doSave()
              // handles for a normal save — reached here instead because the
              // write that hit it was this "Overwrite" retry. Reuses the same
              // recovery, resolveGrants(): if the file is still externally
              // different once permission's fixed, the retried (non-forced)
              // save surfaces the conflict modal again rather than silently
              // forcing this "Overwrite" choice through a permission
              // side-channel — the user re-confirms instead of it happening
              // unattended.
              shell.setSaveState('permission')
              toast(t(store.doc.prefs.locale, 'save_permission_toast'), {
                sticky: true,
                action: { label: t(store.doc.prefs.locale, 'grant_access_ellipsis'), onClick: () => void saveCtl.resolveGrants() },
              })
            } else {
              shell.setSaveState('error')
              toast(t(store.doc.prefs.locale, 'save_error_toast'), { sticky: true })
            }
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
  disposers.push(
    store.onDirty((dirty) => {
      shell.setSaveState(dirty ? 'dirty' : 'saved')
      shell.setTitle(session.name, dirty)
    })
  )

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
    if (document.visibilityState !== 'hidden') return
    // Commit an in-flight debounced editor change before testing `dirty` —
    // hiding the tab within CHANGE_DEBOUNCE_MS of a keystroke would otherwise
    // save a document that doesn't have it yet. Unlike teardownApp's flush,
    // this one must not tear the panes down (the tab is still alive and the
    // user is coming back to it), so it goes through the editors directly.
    flushAllEditors()
    if (store.dirty) void saveCtl.saveNow()
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
    // Same reason as onVisibilityChange above: without this, closing the tab
    // within CHANGE_DEBOUNCE_MS of a keystroke both skips the "leave site?"
    // prompt (store.dirty is still false) and saves a document missing it.
    flushAllEditors()
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

  async function retryBackupWrite(): Promise<void> {
    try {
      const currentPw = app ? app.password : password
      const bytes = currentPw === null ? serializePlain(store.doc) : await encryptDocument(store.doc, currentPw)
      await backupCtl.writeBackupNow(bytes)
    } catch (e) {
      console.error(e)
    }
    // Whether the retry succeeded or not, currentHealth() now reflects the
    // truth — the pill otherwise keeps showing the pre-retry state until the
    // next full save cycle, which a password change (this button's usual
    // trigger) just pushed off by calling markSaved().
    shell.setSaveState(backupHealthPillState(await backupCtl.currentHealth()))
  }

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
    backupStatus: () => backupCtl.getStatus(),
    backupHealth: () => backupCtl.currentHealth(),
    // Routed through resolveGrants() rather than calling backupCtl directly:
    // resolveGrants() is what the save-pill's own "Grant access…" click uses,
    // and it's the one place that also rewrites the backup file, recomputes
    // health, refreshes the pill, and dismisses the now-stale permission
    // toast — a bare backupCtl.regrantPermission() call would fix the grant
    // but leave the pill/toast showing the lapse until the next save cycle.
    regrantBackupPermission: () => saveCtl.resolveGrants(),
    retryBackupWrite,
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
  shell.onSaveRequest(() => void saveCtl.saveNow({ explicit: true }))
  shell.onGrantRequest(() => void saveCtl.resolveGrants())
  shell.onBackupRetryRequest(() => void retryBackupWrite())

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
      setCalendarSpaceHidden: (hidden) => setDailyCalendarSpaceConstrained(hidden),
    })
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
    const action = resolveAppHotkey(e, {
      teamCount: store.doc.teams.length,
      focusedPaneShowsDailyNote: !!focusedLoc && focusedLoc.ref.kind === 'daily',
    })
    if (!action) return
    e.preventDefault()
    switch (action.type) {
      case 'save':
        void saveCtl.saveNow({ explicit: true })
        return
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

  // Ctrl+mouse-wheel steps the text-size preference through its five stops,
  // standing in for the browser's own page zoom — but only while
  // `prefs.ctrlWheelFontSize` is on (prefs → General). Off, the event is left
  // untouched and the browser zooms as usual. Capture phase + passive:false so
  // preventDefault lands before any module's own wheel handler (daily-notes'
  // edge-scroll) sees a Ctrl+wheel. Travel is accumulated to a threshold so a
  // trackpad pinch — which arrives as a burst of small ctrlKey wheel events —
  // doesn't rip through all five sizes in one gesture.
  const SIZE_LABEL_KEY = { XS: 'prefs_size_xs', S: 'prefs_size_s', M: 'prefs_size_m', L: 'prefs_size_l', XL: 'prefs_size_xl' } as const
  const WHEEL_STEP_PX = 40
  let wheelAccum = 0
  let wheelDir: -1 | 1 = 1
  let wheelAt = 0
  const onCtrlWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey) return
    if (!store.doc.prefs.ctrlWheelFontSize) return // hand the gesture back to the browser
    e.preventDefault()
    e.stopPropagation()
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY
    if (px === 0) return
    const dir: -1 | 1 = px < 0 ? 1 : -1 // wheel up / pinch open = larger
    const now = Date.now()
    if (dir !== wheelDir || now - wheelAt > 400) wheelAccum = 0
    wheelDir = dir
    wheelAt = now
    wheelAccum += Math.abs(px)
    if (wheelAccum < WHEEL_STEP_PX) return
    wheelAccum = 0
    const next = stepFontSize(store.doc.prefs.fontSize, dir)
    if (next === store.doc.prefs.fontSize) return // already at the smallest/largest
    store.update((d) => { d.prefs.fontSize = next }, { sections: ['prefs'] })
    shell.applyPrefs(store.doc.prefs)
    const lc = store.doc.prefs.locale
    toast(t(lc, 'size_toast', { size: t(lc, SIZE_LABEL_KEY[next]) }), { key: 'font-size' })
  }
  document.addEventListener('wheel', onCtrlWheel, { capture: true, passive: false })
  disposers.push(() => document.removeEventListener('wheel', onCtrlWheel, { capture: true }))
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

// The badge only means anything while a team file is open (it mirrors that
// file's own overdue+due-soon total, set by sidebar.ts on each render) — an
// app launch with no file open yet must never show a stale count left over
// from whatever was open in a previous session.
if (__PWA__) updateAppBadge(0)
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
