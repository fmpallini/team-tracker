// src/ui/panes.ts — central navigation hub; every module open goes through here.
import type { Store } from '../core/store'
import type { Shell } from './shell'
import type { Loc, ModuleRef, Team } from '../core/types'
import { currentLoc, lastLocForTeam, locsConflict, navigateHistory, openLoc } from '../core/nav'
import { createPaneLayout, type PaneLayout } from '../core/pane-layout'
import { t, todayIso, formatDateWithWeekday, type Locale, type MsgKey } from '../core/i18n'
import { teamRefCandidates, KIND_ICON, createSearchIndex, type SearchIndex } from '../core/search'
import { el } from './dom'
import { paintSelection, clampMove, selectableRowProps } from './select-list'
import { toast } from './modal'
import { blockedByModal } from './hotkeys'
import { ADD_TEAM_REQUEST_EVENT } from './sidebar'
import { clearSearchHighlight } from './search-highlight'
// Runtime dependency in one direction only: modules/lifecycle.ts imports
// ModuleCtx/ModuleRenderer from here as *types*, which are erased at build.
import { disposeContainer } from '../modules/lifecycle'

export type ModuleRenderer = (container: HTMLElement, loc: Loc, ctx: ModuleCtx) => void

export interface ModuleCtx {
  store: Store
  pm: PaneManager
  paneIdx: 0 | 1
  locale: Locale
  /** One instance per document, shared by every module's backlinks-chip lookups — see createPaneManager's own construction of it below. */
  searchIndex: SearchIndex
}

export interface PaneManager {
  openInPane(paneIdx: 0 | 1, loc: Loc, opts?: { force?: boolean }): void
  /**
   * Writes both panes' targets in one store update and renders once —
   * for programmatic full-layout writes (team switch, first-visit default
   * layout) where both panes are being resynced together. Two sequential
   * `openInPane(..., { force: true })` calls reach the same end state but
   * render each pane twice (once per call's own renderAll()), including once
   * for the hidden pane while unsplit with content about to be overwritten
   * by the second call anyway. `force` semantics apply to both (no
   * cross-pane duplicate-module check, no hidden-pane staleness cleanup) —
   * appropriate here since both panes are being freshly set, not read then
   * compared against each other.
   */
  openBothPanes(target0: Loc, target1: Loc, focusedPane: 0 | 1): void
  openInFocused(loc: Loc): void
  /**
   * Opens `target` in whichever pane is *not* `fromIdx` — the pane that
   * doesn't host the click that triggered this navigation (an @-ref chip
   * click, per the Task decision to always keep the source pane's content
   * untouched) — turning split view on first if it's currently off. If
   * `target` conflicts with `fromIdx`'s own current Loc (the chip's target
   * module is already the one open in the pane hosting the click), there is
   * no useful secondary-pane outcome: navigates `fromIdx` itself instead,
   * without touching split state. Returns the pane index the target
   * actually landed in.
   */
  openInSecondaryPane(fromIdx: 0 | 1, target: Loc): 0 | 1
  toggleSplit(): void
  renderAll(): void
  registerModule(kind: ModuleRef['kind'], render: ModuleRenderer): void
  /**
   * Driven by the responsive-layout ResizeObserver (src/ui/responsive.ts):
   * forces single-pane view when the window is too narrow, independent of
   * (and without persisting over) `nav.split`/`nav.teamSplit`. Purely
   * transient — never written to the doc, so a resize alone never marks the
   * file dirty.
   */
  setSplitSpaceConstrained(hidden: boolean): void
  /**
   * Tears down every document-level listener `createPaneManager` registered.
   * Must be called when the document this pane manager belongs to is closed
   * (main.ts's `closeFile()`), or each close-file → open-file cycle leaks a
   * listener pinning the closed document's store, Doc, and detached DOM.
   */
  dispose(): void
}

/** Same item list feeds both the pane module dropdown and the Ctrl+K palette. */
export interface ModuleItem {
  label: string
  ref: ModuleRef
}

const FIXED_MODULE_KEYS: { kind: 'stakeholders' | 'members' | 'actions' | 'milestones' | 'risks'; key: MsgKey }[] = [
  { kind: 'stakeholders', key: 'module_stakeholders' },
  { kind: 'members', key: 'module_members' },
  { kind: 'actions', key: 'module_actions' },
  { kind: 'milestones', key: 'module_milestones' },
  { kind: 'risks', key: 'module_risks' },
]

export function buildModuleItems(team: Team | null, locale: Locale): ModuleItem[] {
  const items: ModuleItem[] = [
    { label: `${KIND_ICON.daily} ${t(locale, 'module_daily')}`, ref: { kind: 'daily', date: todayIso() } },
    { label: `${KIND_ICON.general} ${t(locale, 'module_general_notes')}`, ref: { kind: 'general' } },
  ]
  if (team) {
    for (const group of ['stakeholders', 'members'] as const) {
      for (const person of team[group]) {
        items.push({ label: `${KIND_ICON.person} ${person.name}`, ref: { kind: 'person', personId: person.id, group } })
      }
    }
  }
  const cands = team ? teamRefCandidates(team) : null
  for (const { kind, key } of FIXED_MODULE_KEYS) {
    items.push({ label: `${KIND_ICON[kind]} ${t(locale, key)}`, ref: { kind } })
    if (!cands || kind === 'stakeholders' || kind === 'members') continue
    const list = { actions: cands.actionItems, milestones: cands.milestones, risks: cands.risks }[kind]
    for (const c of list) items.push({ label: `${KIND_ICON[kind]} ${c.title}`, ref: { kind, itemId: c.id } })
  }
  return items
}

type PaneMenuRow = {
  kind: 'daily' | 'general' | 'stakeholders' | 'members' | 'actions' | 'milestones' | 'risks'
  ref: ModuleRef
  labelKey: MsgKey
}

/** The pane bar's module menu: whole-board entries only, no people, no per-item cards — see buildModuleItems for the fuller Ctrl+K equivalent. */
function paneMenuItems(): PaneMenuRow[] {
  return [
    { kind: 'daily', ref: { kind: 'daily', date: todayIso() }, labelKey: 'module_daily' },
    { kind: 'general', ref: { kind: 'general' }, labelKey: 'module_general_notes' },
    ...FIXED_MODULE_KEYS.map(({ kind, key }): PaneMenuRow => ({ kind, ref: { kind }, labelKey: key })),
  ]
}

function titleFor(store: Store, loc: Loc, locale: Locale): string {
  switch (loc.ref.kind) {
    case 'daily':
      return `${t(locale, 'module_daily')} · ${formatDateWithWeekday(loc.ref.date, locale)}`
    case 'general':
      return t(locale, 'module_general_notes')
    case 'person': {
      // `loc.ref` is narrowed to the 'person' variant here by the switch, but
      // that narrowing does not survive into the .find() callback below (TS
      // can't prove the property access is stable across a closure) — so we
      // capture the narrowed ref in a local const first.
      const ref = loc.ref
      const team = store.doc.teams.find((tm) => tm.id === loc.teamId)
      const person = team?.[ref.group].find((p) => p.id === ref.personId)
      return person ? person.name : t(locale, 'module_person')
    }
    case 'stakeholders':
      return t(locale, 'module_stakeholders')
    case 'members':
      return t(locale, 'module_members')
    case 'actions':
      return t(locale, 'module_actions')
    case 'milestones':
      return t(locale, 'module_milestones')
    case 'risks':
      return t(locale, 'module_risks')
  }
}

const SPLIT_MIN_PCT = 20
const SPLIT_MAX_PCT = 80

/**
 * Print-window overrides layered on top of a clone of the app's own <style>
 * tag (see printPane below) — the app stylesheet alone gets us real borders/
 * colors for whatever module is on screen (table-like rows, badges, etc.),
 * this trims it down to something printable: white page, interactive chrome
 * (buttons, dropdown carets, input/select borders) stripped since a printed
 * page can't be clicked, current values kept as plain text.
 */
const PRINT_CSS = `
  body { background: #fff; color: #000; padding: 1rem; }
  .tt-print-header { font-size: .7rem; color: #666; margin-bottom: .75rem; padding-bottom: .35rem; border-bottom: 1px solid #999; }
  .tt-print-content { border: 1px solid #999; border-radius: 3px; padding: 1rem; }
  .tt-print-content button, .tt-print-content .tt-btn { display: none !important; }
  /* Daily notes' calendar picker is a navigation aid, not content — always
     hidden on the printed page (whether or not it was expanded/collapsed on
     screen), so the note itself gets the full page width. */
  .tt-print-content .tt-daily-calendar-col { display: none !important; }
  .tt-print-content input, .tt-print-content select, .tt-print-content textarea {
    border: none !important; background: none !important; color: #000 !important;
    padding: 0 !important; pointer-events: none; appearance: none; -webkit-appearance: none;
  }
  /* A printed page can't scroll: the module's scroll containers must flow to
     their full height/width or Chrome paints frozen scrollbars in the A4
     preview and clips the rest (seen on the milestones pane, whose timeline
     SVG carries a fixed pixel width computed from the on-screen pane). The
     SVG has a viewBox, so max-width scales it proportionally into the page. */
  .tt-print-content .tt-milestones { height: auto !important; overflow: visible !important; }
  .tt-print-content .tt-milestone-timeline { overflow: visible !important; }
  .tt-print-content .tt-milestone-svg { max-width: 100%; height: auto; }
  .tt-print-content .editor { max-height: none !important; overflow: visible !important; }
`

function otherPaneIdx(idx: 0 | 1): 0 | 1 {
  return idx === 0 ? 1 : 0
}

/**
 * One `PaneLayout` per `PaneManager`, keyed by Store so the module-level free
 * functions below (which main.ts and sidebar.ts call without a PaneManager in
 * hand) can reach the same transient layout state. Replaced — not
 * accumulated — if a store ever gets a second manager, and GC'd with the store.
 */
const layoutsByStore = new WeakMap<Store, PaneLayout>()

/**
 * Invalidates `store`'s stashed pane-0 content (see `layoutsByStore` above)
 * from outside `createPaneManager`'s closure — e.g. sidebar.ts's
 * `deleteTeam`, which prunes `d.nav.panes[*].history` directly rather than
 * through `openInPane`/`stepPaneHistory`, so it would otherwise leave a stash
 * referencing the deleted team's history restorable by a later re-split.
 * No-op if `store` has no registered `PaneManager` yet.
 */
export function invalidateUnsplitStash(store: Store): void {
  layoutsByStore.get(store)?.invalidateStash()
}

/**
 * Applies one history step (back/forward) to pane `idx`, skipping over any
 * entry that would conflict with the other pane's current Loc (same rule
 * `navigateHistory` itself enforces). Returns whether the nav state changed.
 * Exported (rather than a `PaneManager` method, to keep that interface
 * exactly matching the task contract) so main.ts's global Alt+ArrowLeft/Right
 * hotkey can drive the focused pane's history without reaching into
 * `createPaneManager`'s internals.
 */
export function stepPaneHistory(store: Store, idx: 0 | 1, dir: -1 | 1): boolean {
  const owned = layoutsByStore.get(store)
  if (owned) return owned.stepHistory(idx, dir)
  // No PaneManager for this store yet (unit tests drive the free function
  // directly): fall back to a throwaway controller. Its stash starts empty,
  // which is exactly right for a store that has no live layout.
  return createPaneLayout(store).stepHistory(idx, dir)
}

/** Convenience wrapper: steps the currently focused pane's history and re-renders. */
export function navigateFocusedHistory(pm: PaneManager, store: Store, dir: -1 | 1): void {
  if (stepPaneHistory(store, store.doc.nav.focusedPane, dir)) {
    pm.renderAll()
  }
}

/**
 * Jumps pane `idx` straight to the newest entry its history can reach — see
 * `PaneLayout.jumpToLatest`. Free function for the same reason as
 * `stepPaneHistory` above: main.ts's global Alt+Shift+ArrowUp hotkey drives
 * it without reaching into `createPaneManager`'s internals.
 */
export function jumpPaneHistoryToLatest(store: Store, idx: 0 | 1): boolean {
  const owned = layoutsByStore.get(store)
  if (owned) return owned.jumpToLatest(idx)
  return createPaneLayout(store).jumpToLatest(idx)
}

/** Convenience wrapper: jumps the currently focused pane's history to its newest entry and re-renders. */
export function jumpFocusedHistoryToLatest(pm: PaneManager, store: Store): void {
  if (jumpPaneHistoryToLatest(store, store.doc.nav.focusedPane)) {
    pm.renderAll()
  }
}

/**
 * Focuses pane `idx` directly — main.ts's global Alt+ArrowLeft (pane 0) /
 * Alt+ArrowRight (pane 1) hotkey. A free function rather than a
 * `PaneManager` method for the same reason as `stepPaneHistory` above: keeps
 * the interface matching the task contract instead of every module test's
 * `fakePM()` needing a new no-op. Returns whether focus actually changed.
 */
export function setFocusedPane(store: Store, idx: 0 | 1): boolean {
  if (store.doc.nav.focusedPane === idx) return false
  store.updateNav((d) => {
    d.nav.focusedPane = idx
  })
  return true
}

/**
 * Swaps panes 0 and 1's contents (and focus along with whichever one was
 * focused) — main.ts's global Alt+ArrowDown hotkey. No-op while unsplit,
 * since there is only one visible side to swap. Invalidates the unsplit
 * stash (core/pane-layout.ts) since it assumes pane 0 is the one that
 * survives un-splitting, an assumption a swap can invalidate.
 */
export function swapPaneSides(store: Store): boolean {
  if (!store.doc.nav.split) return false
  store.updateNav((d) => {
    const tmp = d.nav.panes[0]
    d.nav.panes[0] = d.nav.panes[1]
    d.nav.panes[1] = tmp
    d.nav.focusedPane = d.nav.focusedPane === 0 ? 1 : 0
  })
  invalidateUnsplitStash(store)
  return true
}

/**
 * Falls back to focusing the first selectable row/card matching `selector`
 * (within `container`) on a plain (no-modifier) arrow keypress, for when
 * nothing at all is focused — e.g. the user clicked into a pane's empty
 * background, landing focus on document.body. Document-level because at that
 * point no element-scoped listener would ever see the keydown. Scoped to the
 * pane `ctx` belongs to (so a background listener in an unfocused pane never
 * fires) and to whichever arrow `keys` the caller cares about (2 for a 1D
 * list, 4 for a 2D grid — see action-items.ts's kanban board), and never
 * competes with main.ts's Alt+Arrow pane-layout hotkeys since it ignores any
 * modified keypress. Shared by risks.ts/milestones.ts/action-items.ts, each
 * of which also does the identical thing at mount time (see their own
 * `container.querySelector(selector)?.focus()` call). Returns a disposer.
 */
export function installArrowFallbackFocus(ctx: ModuleCtx, container: HTMLElement, selector: string, keys: readonly string[]): () => void {
  function onKeydown(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (!keys.includes(e.key)) return
    if (document.activeElement !== document.body) return
    if (ctx.paneIdx !== ctx.store.doc.nav.focusedPane) return
    if (blockedByModal()) return
    const first = container.querySelector<HTMLElement>(selector)
    if (!first) return
    e.preventDefault()
    first.focus()
  }
  document.addEventListener('keydown', onKeydown)
  return () => document.removeEventListener('keydown', onKeydown)
}

/**
 * F1..F7 global hotkey handler (main.ts): jumps the focused pane straight to
 * one of the 7 fixed pane-menu rows (see paneMenuItems) by its position,
 * matching the "F<n>" hint each row shows in the pane's module dropdown.
 * No-op with no active team or an out-of-range index (index is `e.key`'s
 * digit minus one, so always 0-6 in practice, but stay defensive since a
 * caller could pass anything).
 */
export function openPaneModuleByIndex(pm: PaneManager, store: Store, index: number): void {
  const teamId = store.doc.nav.activeTeamId
  const row = paneMenuItems()[index]
  if (!teamId || !row) return
  pm.openInFocused({ teamId, ref: row.ref })
}

export function teamHasHistory(store: Store, teamId: string): boolean {
  return store.doc.nav.panes.some((p) => p.history.some((loc) => loc.teamId === teamId))
}

/** Task 5.6: first-ever open of a team lands in a split view — daily today on the left, members on the right — instead of the last-used single-pane layout. */
export function openTeamDefaultLayout(pm: PaneManager, store: Store, teamId: string): void {
  store.updateNav((d) => { d.nav.split = true; d.nav.focusedPane = 0; d.nav.teamSplit[teamId] = true })
  pm.openBothPanes({ teamId, ref: { kind: 'daily', date: todayIso() } }, { teamId, ref: { kind: 'members' } }, 0)
}

/**
 * Returning to a team that already has history: restores whether it was last
 * viewed split or single, and — per pane — whichever module it was last
 * showing for this team (from that pane's own history), not a blanket reset
 * to today's daily notes.
 *
 * `focusedPane` is derived from `rememberedSplit`, never hardcoded — pane 1
 * is only ever visible while split, so focusing it while restoring a
 * single-pane layout would silently point every focused-pane action
 * (Ctrl+K palette picks, the due-date reminder list, Alt+arrow history) at a
 * pane the user can't see, making it look like selecting an item did
 * nothing. Same invariant `toggleSplit` enforces when un-splitting.
 */
export function restoreTeamLayout(pm: PaneManager, store: Store, teamId: string): void {
  const rememberedSplit = store.doc.nav.teamSplit[teamId] ?? false
  store.updateNav((d) => {
    d.nav.activeTeamId = teamId
    d.nav.split = rememberedSplit
  })

  // Both panes always get resynced to the new team, regardless of whether
  // it's remembered split or single — `rememberedSplit` only controls
  // *visibility* (d.nav.split, above). Leaving pane 1 unsynced whenever a
  // team's remembered layout is single would let it keep the *previous*
  // team's Loc; that stale state then resurfaces (mixing two teams across
  // visible panes) the moment split is toggled back on. `force: true`
  // (via openBothPanes) bypasses openInPane's same-module dedup guard, which
  // exists for live user actions, not this automated per-pane restore —
  // without it, the write for whichever pane runs second is silently
  // dropped whenever the two remembered Locs happen to share a module kind.
  const todayLoc = (): Loc => ({ teamId, ref: { kind: 'daily', date: todayIso() } })
  const pane0Last = lastLocForTeam(store.doc.nav.panes[0], teamId)
  const pane1Last = lastLocForTeam(store.doc.nav.panes[1], teamId)
  const target0 = pane0Last ?? todayLoc()
  let target1 = pane1Last ?? { teamId, ref: { kind: 'members' } }
  // Each pane's remembered Loc for this team is picked from its own
  // independent history and can coincidentally land on the same module kind
  // even though the two panes never conflicted live (e.g. pane 0 had since
  // moved on to a different team by the time pane 1 picked up that same kind
  // for this one). openBothPanes intentionally skips the duplicate guard
  // (see its own doc comment) — resolve the clash here, or it lands on
  // screen (immediately if remembered split, or the next time split is
  // toggled on otherwise) as the same module open in both panes at once.
  if (locsConflict(target1, target0)) {
    const fallback: Loc = { teamId, ref: { kind: 'members' } }
    target1 = locsConflict(fallback, target0) ? { teamId, ref: { kind: 'stakeholders' } } : fallback
  }
  pm.openBothPanes(target0, target1, rememberedSplit ? 1 : 0)
}

export function createPaneManager(shell: Shell, store: Store, _locale: Locale): PaneManager & { searchIndex: SearchIndex } {
  const modules = new Map<ModuleRef['kind'], ModuleRenderer>()
  const menuOpen: [boolean, boolean] = [false, false]
  const menuSelected: [number, number] = [0, 0]
  const menuListEls: [HTMLElement | null, HTMLElement | null] = [null, null]
  let splitPct = 50
  // Transient, in-memory only (see PaneManager.setSplitSpaceConstrained) —
  // not part of Doc, so it never persists and never marks the file dirty.
  let spaceHideSplit = false
  // `layout$` (not `layout`, which is this closure's own render function
  // below) owns the transient un-split-stash / history-stepping policy —
  // see src/core/pane-layout.ts.
  const layout$ = createPaneLayout(store)
  layoutsByStore.set(store, layout$)

  // One SearchIndex per document, shared by every module's backlinks-chip
  // lookups instead of each one re-walking the team's free-text fields from
  // scratch on every render. Wired to store.subscribe() so a scoped
  // store.update() drops only the affected team's cache entry rather than
  // clearing every team's — a document-level listener in the same category
  // dispose() below already tears down for other concerns.
  const searchIndex = createSearchIndex(() => store.doc, () => store.rev)
  const unsubscribeSearchIndex = store.subscribe((scope) => searchIndex.invalidate(scope))

  function effectiveSplit(): boolean {
    return store.doc.nav.split && !spaceHideSplit
  }

  function localeNow(): Locale {
    return store.doc.prefs.locale
  }

  // --- persistent DOM skeleton (built once; content mutated in place) ---
  const barEls: [HTMLElement, HTMLElement] = [el('div', { class: 'tt-pane-bar' }), el('div', { class: 'tt-pane-bar' })]
  const bodyEls: [HTMLElement, HTMLElement] = [el('div', { class: 'tt-pane-body' }), el('div', { class: 'tt-pane-body' })]
  const paneEls: [HTMLElement, HTMLElement] = [
    el('div', { class: 'tt-pane', 'data-pane-idx': '0' }, barEls[0], bodyEls[0]),
    el('div', { class: 'tt-pane', 'data-pane-idx': '1' }, barEls[1], bodyEls[1]),
  ]
  // Capture phase, not bubble: nested handlers (split button, module menu
  // items, ref chips, ...) can themselves change nav.focusedPane and
  // re-render synchronously (e.g. openInPane's focusOther branch). A
  // bubble-phase listener here would run *after* those, silently
  // overwriting whatever they just set back to "whichever pane this click
  // started in" — capture runs top-down before the click ever reaches its
  // target, so this always lands first.
  paneEls[0].addEventListener('click', () => setFocusedPane(0), true)
  paneEls[1].addEventListener('click', () => setFocusedPane(1), true)

  // Set only while a drag is in flight, so dispose() (see PaneManager.dispose
  // below) can tear down a drag's document-level listeners and pending frame
  // if it runs mid-drag. Without this, the self-removing mousemove/mouseup
  // listeners added below would survive dispose() until the next mouseup
  // anywhere on the page — the same class of leak Tasks 2 and 3 fixed for
  // this object's other listeners.
  let dragCleanup: (() => void) | null = null

  const dividerEl = el('div', { class: 'tt-pane-divider' })
  dividerEl.addEventListener('mousedown', (downEvt) => {
    downEvt.preventDefault()
    // The raw mousemove stream fires far faster than the screen refreshes, and
    // each event did a getBoundingClientRect() read followed by a style write
    // — a forced synchronous layout per event. Coalesce into one write per
    // animation frame instead: store the latest clientX, and let a single
    // pending frame apply whichever position was most recent.
    let pendingX: number | null = null
    let frame: number | null = null

    function applyPending(): void {
      frame = null
      if (pendingX === null) return
      const rect = gridEl.getBoundingClientRect()
      const raw = rect.width > 0 ? ((pendingX - rect.left) / rect.width) * 100 : splitPct
      pendingX = null
      splitPct = Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, raw))
      gridEl.style.gridTemplateColumns = `${splitPct}fr 6px ${100 - splitPct}fr`
    }

    function onMove(ev: MouseEvent): void {
      pendingX = ev.clientX
      if (frame === null) frame = requestAnimationFrame(applyPending)
    }
    function unbind(): void {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    function onUp(): void {
      unbind()
      dragCleanup = null
      // Flush whatever the last frame hasn't applied yet, so the divider
      // always lands exactly where the pointer was released.
      if (frame !== null) {
        cancelAnimationFrame(frame)
        applyPending()
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    // Only the unbinding is shared with onUp: a normal mouseup flushes the
    // pending frame (the divider lands where the pointer was released), while
    // dispose() mid-drag deliberately drops it — the pane grid is going away.
    dragCleanup = () => {
      unbind()
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
    }
  })

  const gridEl = el('div', { class: 'tt-panes-grid' }, paneEls[0], dividerEl, paneEls[1])

  // No teams yet: the pane shell (bars, borders, split divider) has nothing
  // meaningful to show and just adds visual noise around the CTA — hidden in
  // layout() in favor of this single, screen-centered call to action. Text
  // nodes are re-synced (not rebuilt) in layout() so a locale change picks
  // up the new strings without needing its own wiring here.
  const noTeamsTitleEl = el('p', {})
  const noTeamsBtn = el(
    'button',
    {
      class: 'tt-btn tt-btn-primary',
      type: 'button',
      onclick: () => document.dispatchEvent(new CustomEvent(ADD_TEAM_REQUEST_EVENT)),
    }
  )
  // Below the button, not above it: the button stays the single primary
  // action, and the hint answers the question the empty screen otherwise
  // leaves hanging — what is a team, and what am I about to get?
  const noTeamsHintEl = el('p', { class: 'tt-no-teams-hint' })
  const noTeamsEl = el('div', { class: 'tt-no-teams' }, el('div', { class: 'tt-pane-cta' }, noTeamsTitleEl, noTeamsBtn, noTeamsHintEl))

  shell.panesRoot.innerHTML = ''
  shell.panesRoot.append(gridEl, noTeamsEl)

  // Closes any open module dropdown when clicking outside of it.
  const onDocumentClick = (e: MouseEvent): void => {
    if (!menuOpen[0] && !menuOpen[1]) return
    const target = e.target as HTMLElement
    if (target.closest('.tt-pane-modules-btn') || target.closest('.tt-pane-menu')) return
    closeMenu(0)
    closeMenu(1)
    renderBar(0)
    renderBar(1)
  }
  document.addEventListener('click', onDocumentClick)

  function setFocusedPane(idx: 0 | 1): void {
    if (store.doc.nav.focusedPane === idx) return
    store.updateNav((d) => {
      d.nav.focusedPane = idx
    })
    layout()
  }

  function layout(): void {
    const nav = store.doc.nav
    const lc = localeNow()
    const hasTeams = store.doc.teams.length > 0
    gridEl.style.display = hasTeams ? '' : 'none'
    noTeamsEl.style.display = hasTeams ? 'none' : ''
    if (!hasTeams) {
      noTeamsTitleEl.textContent = t(lc, 'empty_no_teams_title')
      noTeamsBtn.textContent = t(lc, 'empty_no_teams_btn')
      noTeamsHintEl.textContent = t(lc, 'empty_no_teams_hint')
    }
    const split = effectiveSplit()
    gridEl.dataset.split = String(split)
    paneEls[1].style.display = split ? '' : 'none'
    dividerEl.style.display = split ? '' : 'none'
    // fr, not %: the two flexible columns plus the fixed 6px divider must
    // share exactly 100% of the grid's width. Percent columns don't account
    // for a sibling fixed-width column at all — splitPct% + 6px + (100 -
    // splitPct)% always summed to 100% *plus* 6px, overflowing the container
    // by the divider's width and forcing a horizontal scrollbar. fr columns
    // share whatever space is left *after* fixed-width columns are
    // subtracted, so the total is always exactly 100%.
    gridEl.style.gridTemplateColumns = split ? `${splitPct}fr 6px ${100 - splitPct}fr` : '1fr'
    paneEls[0].classList.toggle('focused', nav.focusedPane === 0)
    paneEls[1].classList.toggle('focused', nav.focusedPane === 1)
  }

  function goHistory(idx: 0 | 1, dir: -1 | 1): void {
    if (!layout$.stepHistory(idx, dir)) return
    renderAll()
  }

  function openInPane(idx: 0 | 1, target: Loc, opts?: { force?: boolean }): void {
    clearSearchHighlight()
    const nav = store.doc.nav
    const otherIdx = otherPaneIdx(idx)
    // The "same module open in both panes" conflict only makes sense while
    // both panes are actually visible. Unsplit, the other pane is hidden but
    // still holds a stashed current Loc — without this, opening a module
    // here that happens to match that stashed Loc would silently refuse
    // (focusOther) and hand focus to a pane the user can't even see.
    //
    // `force` skips this guard entirely. It's for programmatic per-pane
    // resyncs (team switch, first-visit default layout) that restore each
    // pane's own independently-remembered Loc for the newly active team —
    // not a live user action picking a module. Applying the duplicate-guard
    // there would silently drop one pane's write whenever the two remembered
    // Locs happen to share a kind, leaving that pane stuck on the previous
    // team while the other one switches — exactly the "mixed teams across
    // panes" bug this is guarding against.
    const other = nav.split && !opts?.force ? currentLoc(nav.panes[otherIdx]) : null
    const result = openLoc(nav.panes[idx], target, other)
    if (result.type === 'focusOther') {
      store.updateNav((d) => {
        d.nav.focusedPane = otherIdx
      })
      toast(t(localeNow(), 'toast_focus_other'))
      // Neither pane's Loc changed here — only which one is focused — so
      // there is nothing for either body to pick up; remounting either would
      // only destroy in-pane state (an expanded follow-up row, a caret, ...)
      // for no visible benefit. renderAll([]) still refreshes both bars
      // (focus highlighting, back/forward state).
      renderAll([])
      return
    }
    // Pane 1 (not "whichever pane isn't idx") is the one CSS actually hides
    // while unsplit — layout() never hides pane 0. So only a write that just
    // landed on the *visible* pane (idx 0) can leave the hidden pane 1
    // showing a stale duplicate; a write into pane 1 itself doesn't touch
    // what's on screen and needs no cleanup.
    if (!nav.split && idx === 0) {
      const hiddenPane = nav.panes[1]
      const hiddenCur = currentLoc(hiddenPane)
      if (hiddenCur && locsConflict(target, hiddenCur)) {
        const stepped = navigateHistory(hiddenPane, -1, null)
        store.updateNav((d) => {
          d.nav.panes[1] = stepped ?? { history: hiddenPane.history, index: -1 }
        })
      }
    }
    store.updateNav((d) => {
      d.nav.panes[idx] = result.pane
      d.nav.focusedPane = idx
    })
    // Real navigation into pane 0 — see core/pane-layout.ts.
    if (idx === 0) layout$.noteRealNavigation(0)
    // Only `idx` actually navigated — the other pane's Loc, and so its
    // mounted module instance, is untouched. Remounting it too (the old
    // unconditional renderAll()) tore down and rebuilt that instance from
    // scratch on every navigation anywhere, silently collapsing an expanded
    // milestone/risk follow-up row, dropping an in-progress edit's caret,
    // etc. in whichever pane the user *wasn't* navigating — e.g. clicking an
    // @mention chip inside an expanded risk row to open its target in the
    // other pane used to collapse that very row out from under the click.
    renderAll([idx])
  }

  function openBothPanes(target0: Loc, target1: Loc, focusedPane: 0 | 1): void {
    clearSearchHighlight()
    // otherCurrent=null means locsConflict() is never true (see its own
    // `if (b === null) return false` guard), so 'focusOther' is unreachable
    // here — matches openInPane's own `force: true` semantics.
    const result0 = openLoc(store.doc.nav.panes[0], target0, null)
    const result1 = openLoc(store.doc.nav.panes[1], target1, null)
    if (result0.type !== 'opened' || result1.type !== 'opened') return
    store.updateNav((d) => {
      d.nav.panes[0] = result0.pane
      d.nav.panes[1] = result1.pane
      d.nav.focusedPane = focusedPane
    })
    // Always a real (programmatic) navigation into pane 0 — see
    // core/pane-layout.ts.
    layout$.invalidateStash()
    renderAll()
  }

  function openInFocused(target: Loc): void {
    openInPane(store.doc.nav.focusedPane, target)
  }

  function openInSecondaryPane(fromIdx: 0 | 1, target: Loc): 0 | 1 {
    const sourceLoc = currentLoc(store.doc.nav.panes[fromIdx])
    if (sourceLoc && locsConflict(target, sourceLoc)) {
      openInPane(fromIdx, target)
      return fromIdx
    }
    if (!effectiveSplit()) {
      store.updateNav((d) => {
        d.nav.split = true
        if (d.nav.activeTeamId) d.nav.teamSplit[d.nav.activeTeamId] = true
      })
      spaceHideSplit = false
    }
    const toIdx = otherPaneIdx(fromIdx)
    openInPane(toIdx, target)
    return toIdx
  }

  /**
   * Toggles against the *effective* (visible) split state, not the raw
   * persisted `nav.split` — when the responsive layout (responsive.ts) has
   * force-hidden the split view because the window is narrow, clicking this
   * button means "show it anyway" and must also clear that transient
   * override, or the click would appear to do nothing. See
   * PaneManager.setSplitSpaceConstrained. The un-split stash (pulling pane
   * 1's content into pane 0, and restoring it on re-split) lives in
   * core/pane-layout.ts — see `layout$.applyToggleSplit`.
   */
  function toggleSplit(): void {
    const wasVisible = effectiveSplit()
    layout$.applyToggleSplit(wasVisible)
    if (wasVisible === false) spaceHideSplit = false
    renderAll()
  }

  function setSplitSpaceConstrained(hidden: boolean): void {
    if (spaceHideSplit === hidden) return
    spaceHideSplit = hidden
    // Un-hiding makes pane 1 visible again; it was skipped by renderAll()
    // for as long as it was hidden, so its content needs a real render now.
    if (!hidden) renderAll()
    else layout()
  }

  function openMenu(idx: 0 | 1): void {
    const other = otherPaneIdx(idx)
    if (menuOpen[other]) {
      closeMenu(other)
      renderBar(other)
    }
    const cur = currentLoc(store.doc.nav.panes[idx])
    const rows = paneMenuItems()
    const foundIdx = cur ? rows.findIndex((r) => r.kind === cur.ref.kind) : -1
    menuSelected[idx] = foundIdx === -1 ? 0 : foundIdx
    menuOpen[idx] = true
    document.addEventListener('keydown', idx === 0 ? onMenuKeydown0 : onMenuKeydown1, true)
  }

  function closeMenu(idx: 0 | 1): void {
    if (!menuOpen[idx]) return
    menuOpen[idx] = false
    // Detach directly (mirrors sidebar.ts's closeTeamSwitcher's switcherEl.remove())
    // rather than relying on a follow-up renderBar() to wipe it via innerHTML —
    // dispose() below calls closeMenu() with no renderBar() afterward, so the
    // menu must be self-removing or it would linger in the torn-down bar.
    menuListEls[idx]?.remove()
    menuListEls[idx] = null
    document.removeEventListener('keydown', idx === 0 ? onMenuKeydown0 : onMenuKeydown1, true)
  }

  function toggleMenu(idx: 0 | 1): void {
    if (menuOpen[idx]) closeMenu(idx)
    else openMenu(idx)
    renderBar(idx)
  }

  function makeMenuKeydownHandler(idx: 0 | 1): (e: KeyboardEvent) => void {
    return (e: KeyboardEvent): void => {
      // This dropdown can still be open (and this capturing listener still
      // attached) if a modal opens on top of it without the two ever having
      // a chance to interact — e.g. an async save-conflict error modal
      // popping up while the menu is open. Without this guard, Enter here
      // would navigate the pane behind the modal instead of being consumed
      // by the modal's own keydown handling.
      if (blockedByModal()) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const count = paneMenuItems().length
        menuSelected[idx] = clampMove(menuSelected[idx], e.key === 'ArrowDown' ? 1 : -1, count)
        paintSelection(menuListEls[idx], '.tt-pane-menu-item', menuSelected[idx])
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const teamId = store.doc.nav.activeTeamId
        const row = paneMenuItems()[menuSelected[idx]]
        if (!teamId || !row) return
        closeMenu(idx)
        openInPane(idx, { teamId, ref: row.ref })
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMenu(idx)
        renderBar(idx)
      }
    }
  }
  const onMenuKeydown0 = makeMenuKeydownHandler(0)
  const onMenuKeydown1 = makeMenuKeydownHandler(1)

  function buildMenu(idx: 0 | 1, teamId: string): HTMLElement {
    const lc = localeNow()

    function pick(ref: ModuleRef): void {
      closeMenu(idx)
      openInPane(idx, { teamId, ref })
    }

    const itemBtns = paneMenuItems().map((row, i) =>
      el(
        'button',
        {
          type: 'button',
          ...selectableRowProps({
            class: 'tt-pane-menu-item',
            selected: i === menuSelected[idx],
            onCommit: () => pick(row.ref),
            onHover: () => {
              menuSelected[idx] = i
              paintSelection(menuListEls[idx], '.tt-pane-menu-item', menuSelected[idx])
            },
          }),
        },
        el('span', { class: 'tt-pane-menu-label' }, `${KIND_ICON[row.kind]} ${t(lc, row.labelKey)}`),
        el('span', { class: 'tt-pane-menu-hotkey' }, `F${i + 1}`)
      )
    )

    const listEl = el('div', { class: 'tt-pane-menu' }, ...itemBtns)
    menuListEls[idx] = listEl
    return listEl
  }

  /** Opens a print-only window with a clone of the pane's current module content — whatever it is (note editor, risks table, people tree, ...) — plus a clone of the app's own stylesheet (see PRINT_CSS) and a small discreet header identifying the team/module/detail being printed. Content is inserted via appendChild(cloneNode), never through document.write, matching src/ui/editor.ts's prior print implementation this replaces. */
  function printPane(idx: 0 | 1): void {
    const lc = localeNow()
    const cur = currentLoc(store.doc.nav.panes[idx])
    if (!cur) return
    const team = store.doc.teams.find((tm) => tm.id === cur.teamId)

    const w = window.open('', '_blank')
    if (!w) return
    w.document.write('<!doctype html><html><head><title>Team Tracker</title></head><body></body></html>')
    w.document.close()

    const appStyle = document.querySelector('style')
    if (appStyle) w.document.head.appendChild(appStyle.cloneNode(true))
    const printStyle = w.document.createElement('style')
    printStyle.textContent = PRINT_CSS
    w.document.head.appendChild(printStyle)

    const header = w.document.createElement('div')
    header.className = 'tt-print-header'
    header.textContent = [t(lc, 'app_name'), team?.name, titleFor(store, cur, lc)].filter(Boolean).join(' · ')

    const content = w.document.createElement('div')
    content.className = 'tt-print-content'
    content.appendChild(bodyEls[idx].cloneNode(true))

    w.document.body.append(header, content)
    w.focus()
    w.print()
  }

  function renderBar(idx: 0 | 1): void {
    const barEl = barEls[idx]
    barEl.innerHTML = ''
    const lc = localeNow()
    const nav = store.doc.nav
    const pane = nav.panes[idx]
    const other = currentLoc(nav.panes[otherPaneIdx(idx)])
    const cur = currentLoc(pane)
    const canBack = navigateHistory(pane, -1, other) !== null
    const canFwd = navigateHistory(pane, 1, other) !== null

    const backBtn = el(
      'button',
      {
        class: 'tt-btn tt-pane-nav-btn tt-pane-back-btn',
        type: 'button',
        title: t(lc, 'pane_back_title'),
        disabled: !canBack,
        onclick: () => goHistory(idx, -1),
      },
      '◀'
    )
    const fwdBtn = el(
      'button',
      {
        class: 'tt-btn tt-pane-nav-btn tt-pane-fwd-btn',
        type: 'button',
        title: t(lc, 'pane_forward_title'),
        disabled: !canFwd,
        onclick: () => goHistory(idx, 1),
      },
      '▶'
    )
    const teamId = nav.activeTeamId
    const modulesBtn = el(
      'button',
      {
        class: 'tt-pane-title-trigger tt-pane-modules-btn',
        type: 'button',
        title: t(lc, teamId ? 'pane_modules_title' : 'pane_no_team'),
        disabled: teamId === null,
        onclick: () => toggleMenu(idx),
      },
      el('span', { class: 'tt-pane-title-text' }, cur ? titleFor(store, cur, lc) : t(lc, 'pane_empty')),
      el('span', { class: 'tt-pane-title-chev' }, '▾')
    )
    const printBtn = el(
      'button',
      {
        class: 'tt-btn tt-pane-print-btn',
        type: 'button',
        title: t(lc, 'pane_print_title'),
        disabled: cur === null,
        onclick: () => printPane(idx),
      },
      '🖨️'
    )
    const splitBtn = el(
      'button',
      {
        class: 'tt-btn tt-pane-split-btn',
        type: 'button',
        title: t(lc, effectiveSplit() ? 'pane_unsplit_title' : 'pane_split_title'),
        onclick: () => toggleSplit(),
      },
      '⧉'
    )

    const moduleTriggerWrap = el(
      'div',
      { class: 'tt-pane-title-trigger-wrap' },
      modulesBtn,
      ...(menuOpen[idx] && teamId !== null ? [buildMenu(idx, teamId)] : [])
    )
    const left = el('div', { class: 'tt-pane-bar-left' }, backBtn, fwdBtn, moduleTriggerWrap)
    const right = el('div', { class: 'tt-pane-bar-right' }, printBtn, splitBtn)
    barEl.append(left, right)
  }

  function renderBody(idx: 0 | 1): void {
    const container = bodyEls[idx]
    container.innerHTML = ''
    const lc = localeNow()
    const loc = currentLoc(store.doc.nav.panes[idx])
    if (!loc) {
      container.appendChild(el('div', { class: 'tt-pane-empty' }, t(lc, 'pane_empty')))
      return
    }
    const renderer = modules.get(loc.ref.kind)
    if (!renderer) {
      container.appendChild(el('div', { class: 'tt-pane-placeholder' }, t(lc, 'module_placeholder')))
      return
    }
    const ctx: ModuleCtx = { store, pm, paneIdx: idx, locale: lc, searchIndex }
    renderer(container, loc, ctx)
  }

  /**
   * Pane 1 is skipped entirely while it isn't visible (unsplit, or split
   * force-hidden by the responsive layout) — layout() has already set
   * `display: none` on it, so rendering into it is pure wasted work, and
   * single-pane is the common case. Every path that makes pane 1 visible
   * again must call renderAll() so its skipped-while-hidden DOM is rebuilt:
   * toggleSplit() already does, and setSplitSpaceConstrained() below was
   * changed to do the same.
   *
   * Skipping the render is only half the saving: the module instance already
   * mounted in pane 1 keeps its own store.subscribe() alive and would go on
   * re-rendering into a `display: none` container on every mutation — and a
   * module's own renderAll() (rebuilding every rich-editor bundle) is the
   * expensive part, not this function. So the hidden pane's instance is
   * disposed outright; the rebuild-on-becoming-visible above is what makes
   * that safe.
   *
   * `bodies` (default both) lets a caller that knows exactly which pane(s)
   * just navigated skip remounting the other one — see openInPane's own
   * calls below. renderBody() unconditionally tears down and rebuilds the
   * module instance in that container (withDisposal), which loses any
   * transient in-pane state the module itself owns (an expanded follow-up
   * row in milestones/risks, an in-progress caret, ...); a pane whose Loc
   * didn't change has no reason to pay that cost; its content is already
   * kept live by its own store.subscribe(). renderBar() stays unconditional
   * either way — cheap, stateless, and both panes' focus highlighting/
   * back-forward state can change on every navigation regardless of which
   * pane's body actually needs remounting.
   */
  function renderAll(bodies: readonly (0 | 1)[] = [0, 1]): void {
    layout()
    renderBar(0)
    if (bodies.includes(0)) renderBody(0)
    if (!effectiveSplit()) {
      disposeContainer(bodyEls[1])
      return
    }
    renderBar(1)
    if (bodies.includes(1)) renderBody(1)
  }

  // Exposes searchIndex beyond the PaneManager interface (which module tests'
  // fakePM()s implement without it) so main.ts can hand this same instance to
  // mountSearch instead of it building a second, independent one — see
  // ui/search-ui.ts's mountSearch doc comment.
  const pm = {
    openInPane,
    openBothPanes,
    openInFocused,
    openInSecondaryPane,
    toggleSplit,
    renderAll,
    registerModule(kind, render) {
      modules.set(kind, render)
    },
    setSplitSpaceConstrained,
    dispose(): void {
      closeMenu(0)
      closeMenu(1)
      document.removeEventListener('click', onDocumentClick)
      unsubscribeSearchIndex()
      // Tear down an in-flight divider drag, if any — see dragCleanup above.
      dragCleanup?.()
      dragCleanup = null
      // The mounted modules' own teardowns. Their store subscriptions die with
      // the document anyway, but ui/atref.ts's and ui/template-picker.ts's
      // dropdowns append to document.body and hold a capturing document
      // 'mousedown' listener while open — closing the file with one open would
      // otherwise strand the overlay on top of the start screen, which only
      // clears #app.
      disposeContainer(bodyEls[0])
      disposeContainer(bodyEls[1])
    },
    searchIndex,
  } satisfies PaneManager & { searchIndex: SearchIndex }

  renderAll()
  return pm
}
