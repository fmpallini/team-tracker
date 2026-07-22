// src/ui/panes.ts — central navigation hub; every module open goes through here.
import type { Store } from '../core/store'
import type { Shell } from './shell'
import type { Loc, ModuleRef, PaneState, Team } from '../core/types'
import { currentLoc, lastLocForTeam, locsConflict, navigateHistory, openLoc } from '../core/nav'
import { t, todayIso, formatDate, type Locale, type MsgKey } from '../core/i18n'
import { teamRefCandidates, KIND_ICON } from '../core/search'
import { el } from './dom'
import { toast } from './modal'
import { notifyNavChanged, ADD_TEAM_REQUEST_EVENT } from './sidebar'
import { clearSearchHighlight } from './search-highlight'

export type ModuleRenderer = (container: HTMLElement, loc: Loc, ctx: ModuleCtx) => void

export interface ModuleCtx {
  store: Store
  pm: PaneManager
  paneIdx: 0 | 1
  locale: Locale
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
  const items: ModuleItem[] = [{ label: `${KIND_ICON.daily} ${t(locale, 'module_daily')}`, ref: { kind: 'daily', date: todayIso() } }]
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

function titleFor(store: Store, loc: Loc, locale: Locale): string {
  switch (loc.ref.kind) {
    case 'daily':
      return `${t(locale, 'module_daily')} · ${formatDate(loc.ref.date, locale)}`
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
 * Applies one history step (back/forward) to pane `idx`, skipping over any
 * entry that would conflict with the other pane's current Loc (same rule
 * `navigateHistory` itself enforces). Returns whether the nav state changed.
 * Exported (rather than a `PaneManager` method, to keep that interface
 * exactly matching the task contract) so main.ts's global Alt+ArrowLeft/Right
 * hotkey can drive the focused pane's history without reaching into
 * `createPaneManager`'s internals.
 */
export function stepPaneHistory(store: Store, idx: 0 | 1, dir: -1 | 1): boolean {
  const nav = store.doc.nav
  const other = currentLoc(nav.panes[otherPaneIdx(idx)])
  const result = navigateHistory(nav.panes[idx], dir, other)
  if (!result) return false
  store.updateNav((d) => {
    d.nav.panes[idx] = result
    d.nav.focusedPane = idx
  })
  notifyNavChanged()
  return true
}

/** Convenience wrapper: steps the currently focused pane's history and re-renders. */
export function navigateFocusedHistory(pm: PaneManager, store: Store, dir: -1 | 1): void {
  if (stepPaneHistory(store, store.doc.nav.focusedPane, dir)) {
    pm.renderAll()
  }
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
  notifyNavChanged()

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
  pm.openBothPanes(pane0Last ?? todayLoc(), pane1Last ?? { teamId, ref: { kind: 'members' } }, rememberedSplit ? 1 : 0)
}

export function createPaneManager(shell: Shell, store: Store, _locale: Locale): PaneManager {
  const modules = new Map<ModuleRef['kind'], ModuleRenderer>()
  const menuOpen: [boolean, boolean] = [false, false]
  const personSubOpen: [boolean, boolean] = [false, false]
  let splitPct = 50
  // Transient, in-memory only (see PaneManager.setSplitSpaceConstrained) —
  // not part of Doc, so it never persists and never marks the file dirty.
  let spaceHideSplit = false

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
    el('div', { class: 'tt-pane', 'data-pane-idx': '0', onclick: () => setFocusedPane(0) }, barEls[0], bodyEls[0]),
    el('div', { class: 'tt-pane', 'data-pane-idx': '1', onclick: () => setFocusedPane(1) }, barEls[1], bodyEls[1]),
  ]

  const dividerEl = el('div', { class: 'tt-pane-divider' })
  dividerEl.addEventListener('mousedown', (downEvt) => {
    downEvt.preventDefault()
    function onMove(ev: MouseEvent): void {
      const rect = gridEl.getBoundingClientRect()
      const raw = rect.width > 0 ? ((ev.clientX - rect.left) / rect.width) * 100 : splitPct
      splitPct = Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, raw))
      gridEl.style.gridTemplateColumns = `${splitPct}fr 6px ${100 - splitPct}fr`
    }
    function onUp(): void {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
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
  const noTeamsEl = el('div', { class: 'tt-no-teams' }, el('div', { class: 'tt-pane-cta' }, noTeamsTitleEl, noTeamsBtn))

  shell.panesRoot.innerHTML = ''
  shell.panesRoot.append(gridEl, noTeamsEl)

  // Closes any open module dropdown when clicking outside of it.
  document.addEventListener('click', (e) => {
    if (!menuOpen[0] && !menuOpen[1]) return
    const target = e.target as HTMLElement
    if (target.closest('.tt-pane-modules-btn') || target.closest('.tt-pane-menu')) return
    menuOpen[0] = false
    menuOpen[1] = false
    personSubOpen[0] = false
    personSubOpen[1] = false
    renderBar(0)
    renderBar(1)
  })

  function setFocusedPane(idx: 0 | 1): void {
    if (store.doc.nav.focusedPane === idx) return
    store.updateNav((d) => {
      d.nav.focusedPane = idx
    })
    notifyNavChanged()
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
    if (!stepPaneHistory(store, idx, dir)) return
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
      notifyNavChanged()
      toast(t(localeNow(), 'toast_focus_other'))
      renderAll()
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
    notifyNavChanged()
    renderAll()
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
    notifyNavChanged()
    renderAll()
  }

  function openInFocused(target: Loc): void {
    openInPane(store.doc.nav.focusedPane, target)
  }

  // Set by toggleSplit when un-splitting pulls pane 1's content into pane 0
  // (see below) — holds pane 0's pre-pull PaneState so a later re-split can
  // put it back on the left instead of leaving pane 0 and pane 1 showing an
  // identical duplicate. `store.updateNav` mutates `doc` in place rather than
  // cloning (see store.ts), so `d.nav.panes[0] = d.nav.panes[1]` makes both
  // slots the exact same object reference — meaning `pane0 === pane1` is a
  // cheap, reliable "nothing navigated away since the pull" check: any real
  // navigation (openInPane, stepPaneHistory, a team switch) always replaces
  // pane 0 with a freshly constructed object, breaking the aliasing. Never
  // persisted, like `spaceHideSplit` — losing it on reload is fine, it's a
  // same-session UX nicety, not app state.
  let unsplitStash: PaneState | null = null

  /**
   * Toggles against the *effective* (visible) split state, not the raw
   * persisted `nav.split` — when the responsive layout (responsive.ts) has
   * force-hidden the split view because the window is narrow, clicking this
   * button means "show it anyway" and must also clear that transient
   * override, or the click would appear to do nothing. See
   * PaneManager.setSplitSpaceConstrained.
   */
  function toggleSplit(): void {
    const wasVisible = effectiveSplit()
    store.updateNav((d) => {
      d.nav.split = !wasVisible
      // Un-splitting hides pane 1 (layout() never hides pane 0) — leaving
      // focus stuck there would silently misdirect every focused-pane action
      // (Ctrl+K palette picks, Alt+arrow history, team hotkeys) at a pane the
      // user can no longer see. If pane 1 was the focused (visible-to-the-
      // user) pane, pull its content into pane 0 first so closing split
      // keeps what the user was looking at instead of reverting to pane 0's
      // stale content — stashing pane 0's own content first so re-splitting
      // can restore it instead of leaving both panes showing pane 1's old
      // content twice.
      if (!d.nav.split) {
        if (d.nav.focusedPane === 1) {
          unsplitStash = d.nav.panes[0]
          d.nav.panes[0] = d.nav.panes[1]
        } else {
          unsplitStash = null
        }
        d.nav.focusedPane = 0
      } else if (unsplitStash && d.nav.panes[0] === d.nav.panes[1]) {
        d.nav.panes[0] = unsplitStash
        unsplitStash = null
      }
      // Remembers this choice per team so switching back to it later (see
      // main.ts's selectTeam) restores split/single view as last left it.
      if (d.nav.activeTeamId) d.nav.teamSplit[d.nav.activeTeamId] = d.nav.split
    })
    if (wasVisible === false) spaceHideSplit = false
    notifyNavChanged()
    renderAll()
  }

  function setSplitSpaceConstrained(hidden: boolean): void {
    if (spaceHideSplit === hidden) return
    spaceHideSplit = hidden
    layout()
  }

  function toggleMenu(idx: 0 | 1): void {
    menuOpen[idx] = !menuOpen[idx]
    if (!menuOpen[idx]) personSubOpen[idx] = false
    renderBar(idx)
  }

  function buildMenu(idx: 0 | 1, teamId: string): HTMLElement {
    const lc = localeNow()
    const team = store.doc.teams.find((tm) => tm.id === teamId) ?? null

    function pick(ref: ModuleRef): void {
      menuOpen[idx] = false
      personSubOpen[idx] = false
      openInPane(idx, { teamId, ref })
    }

    const dailyBtn = el(
      'button',
      { class: 'tt-pane-menu-item', type: 'button', onclick: () => pick({ kind: 'daily', date: todayIso() }) },
      t(lc, 'module_daily')
    )

    const personToggle = el(
      'button',
      {
        class: 'tt-pane-menu-item tt-pane-menu-parent',
        type: 'button',
        onclick: () => {
          personSubOpen[idx] = !personSubOpen[idx]
          renderBar(idx)
        },
      },
      `${t(lc, 'module_person')} ${personSubOpen[idx] ? '▾' : '▸'}`
    )

    const subItems: HTMLElement[] = []
    if (personSubOpen[idx] && team) {
      for (const group of ['stakeholders', 'members'] as const) {
        const people = team[group]
        if (people.length === 0) continue
        subItems.push(
          el('div', { class: 'tt-pane-menu-subheader' }, t(lc, group === 'stakeholders' ? 'module_stakeholders' : 'module_members'))
        )
        for (const person of people) {
          subItems.push(
            el(
              'button',
              {
                class: 'tt-pane-menu-item tt-pane-menu-subitem',
                type: 'button',
                onclick: () => pick({ kind: 'person', personId: person.id, group }),
              },
              person.name
            )
          )
        }
      }
    }
    const personGroup = el('div', { class: 'tt-pane-menu-group' }, personToggle, ...subItems)

    const fixedBtns = FIXED_MODULE_KEYS.map(({ kind, key }) =>
      el('button', { class: 'tt-pane-menu-item', type: 'button', onclick: () => pick({ kind }) }, t(lc, key))
    )

    return el('div', { class: 'tt-pane-menu' }, dailyBtn, personGroup, ...fixedBtns)
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
    const titleEl = el('span', { class: 'tt-pane-title' }, cur ? titleFor(store, cur, lc) : t(lc, 'pane_empty'))

    const teamId = nav.activeTeamId
    const modulesBtn = el(
      'button',
      {
        class: 'tt-btn tt-pane-modules-btn',
        type: 'button',
        title: t(lc, teamId ? 'pane_modules_title' : 'pane_no_team'),
        disabled: teamId === null,
        onclick: () => toggleMenu(idx),
      },
      '▾'
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

    const left = el('div', { class: 'tt-pane-bar-left' }, backBtn, fwdBtn, titleEl)
    const right = el('div', { class: 'tt-pane-bar-right' }, modulesBtn, printBtn, splitBtn)
    barEl.append(left, right)

    if (menuOpen[idx] && teamId !== null) {
      barEl.appendChild(buildMenu(idx, teamId))
    }
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
    const ctx: ModuleCtx = { store, pm, paneIdx: idx, locale: lc }
    renderer(container, loc, ctx)
  }

  function renderAll(): void {
    layout()
    renderBar(0)
    renderBody(0)
    renderBar(1)
    renderBody(1)
  }

  const pm: PaneManager = {
    openInPane,
    openBothPanes,
    openInFocused,
    toggleSplit,
    renderAll,
    registerModule(kind, render) {
      modules.set(kind, render)
    },
    setSplitSpaceConstrained,
  }

  renderAll()
  return pm
}
