// src/ui/panes.ts — central navigation hub; every module open goes through here.
import type { Store } from '../core/store'
import type { Shell } from './shell'
import type { Loc, ModuleRef, Team } from '../core/types'
import { currentLoc, navigateHistory, openLoc } from '../core/nav'
import { t, todayIso, formatDate, type Locale, type MsgKey } from '../core/i18n'
import { el } from './dom'
import { toast } from './modal'
import { notifyNavChanged, ADD_TEAM_REQUEST_EVENT } from './sidebar'

export type ModuleRenderer = (container: HTMLElement, loc: Loc, ctx: ModuleCtx) => void

export interface ModuleCtx {
  store: Store
  pm: PaneManager
  paneIdx: 0 | 1
  locale: Locale
}

export interface PaneManager {
  openInPane(paneIdx: 0 | 1, loc: Loc): void
  openInFocused(loc: Loc): void
  toggleSplit(): void
  renderAll(): void
  registerModule(kind: ModuleRef['kind'], render: ModuleRenderer): void
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
  const items: ModuleItem[] = [{ label: t(locale, 'module_daily'), ref: { kind: 'daily', date: todayIso() } }]
  if (team) {
    for (const group of ['stakeholders', 'members'] as const) {
      for (const person of team[group]) {
        items.push({ label: person.name, ref: { kind: 'person', personId: person.id, group } })
      }
    }
  }
  for (const { kind, key } of FIXED_MODULE_KEYS) {
    items.push({ label: t(locale, key), ref: { kind } })
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

export function createPaneManager(shell: Shell, store: Store, _locale: Locale): PaneManager {
  const modules = new Map<ModuleRef['kind'], ModuleRenderer>()
  const menuOpen: [boolean, boolean] = [false, false]
  const personSubOpen: [boolean, boolean] = [false, false]
  let splitPct = 50

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
      gridEl.style.gridTemplateColumns = `${splitPct}% 6px ${100 - splitPct}%`
    }
    function onUp(): void {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })

  const gridEl = el('div', { class: 'tt-panes-grid' }, paneEls[0], dividerEl, paneEls[1])
  shell.panesRoot.innerHTML = ''
  shell.panesRoot.appendChild(gridEl)

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
    gridEl.dataset.split = String(nav.split)
    paneEls[1].style.display = nav.split ? '' : 'none'
    dividerEl.style.display = nav.split ? '' : 'none'
    gridEl.style.gridTemplateColumns = nav.split ? `${splitPct}% 6px ${100 - splitPct}%` : '1fr'
    paneEls[0].classList.toggle('focused', nav.focusedPane === 0)
    paneEls[1].classList.toggle('focused', nav.focusedPane === 1)
  }

  function goHistory(idx: 0 | 1, dir: -1 | 1): void {
    if (!stepPaneHistory(store, idx, dir)) return
    renderAll()
  }

  function openInPane(idx: 0 | 1, target: Loc): void {
    const nav = store.doc.nav
    const other = currentLoc(nav.panes[otherPaneIdx(idx)])
    const result = openLoc(nav.panes[idx], target, other)
    if (result.type === 'focusOther') {
      store.updateNav((d) => {
        d.nav.focusedPane = otherPaneIdx(idx)
      })
      notifyNavChanged()
      toast(t(localeNow(), 'toast_focus_other'))
      renderAll()
      return
    }
    store.updateNav((d) => {
      d.nav.panes[idx] = result.pane
      d.nav.focusedPane = idx
    })
    notifyNavChanged()
    renderAll()
  }

  function openInFocused(target: Loc): void {
    openInPane(store.doc.nav.focusedPane, target)
  }

  function toggleSplit(): void {
    store.updateNav((d) => {
      d.nav.split = !d.nav.split
    })
    notifyNavChanged()
    renderAll()
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
    const splitBtn = el(
      'button',
      {
        class: 'tt-btn tt-pane-split-btn',
        type: 'button',
        title: t(lc, nav.split ? 'pane_unsplit_title' : 'pane_split_title'),
        onclick: () => toggleSplit(),
      },
      '⧉'
    )

    const left = el('div', { class: 'tt-pane-bar-left' }, backBtn, fwdBtn, titleEl)
    const right = el('div', { class: 'tt-pane-bar-right' }, modulesBtn, splitBtn)
    barEl.append(left, right)

    if (menuOpen[idx] && teamId !== null) {
      barEl.appendChild(buildMenu(idx, teamId))
    }
  }

  function renderBody(idx: 0 | 1): void {
    const container = bodyEls[idx]
    container.innerHTML = ''
    const lc = localeNow()
    // Task 3: no teams yet — offer a CTA to create the first one, before the
    // generic "no module open" empty branch below (which would otherwise
    // show first and give the user no path forward).
    if (store.doc.teams.length === 0) {
      container.appendChild(
        el(
          'div',
          { class: 'tt-pane-cta' },
          el('p', {}, t(lc, 'empty_no_teams_title')),
          el(
            'button',
            {
              class: 'tt-btn tt-btn-primary',
              type: 'button',
              onclick: () => document.dispatchEvent(new CustomEvent(ADD_TEAM_REQUEST_EVENT)),
            },
            t(lc, 'empty_no_teams_btn')
          )
        )
      )
      return
    }
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
    openInFocused,
    toggleSplit,
    renderAll,
    registerModule(kind, render) {
      modules.set(kind, render)
    },
  }

  renderAll()
  return pm
}
