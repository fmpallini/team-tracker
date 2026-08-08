// src/ui/backlinks-panel.ts — count chip + popover for @-ref backlinks:
// given the Backlink[] ModuleCtx.searchIndex.backlinks() computes for one
// person/day/action/milestone/risk, createBacklinksChip renders a small
// "↩ N" pill (null when there are none) that opens a grouped-by-source-kind
// list on click. Popover lifecycle mirrors ui/context-menu.ts (fixed-
// position overlay, module-level singleton close, outside-click/Escape
// dismiss via bindOutsideDismiss); group-header styling mirrors
// ui/atref.ts's @ dropdown, the app's other grouped popover.
import type { Backlink, BacklinkSourceKind } from '../core/search'
import { KIND_ICON } from '../core/search'
import type { Loc } from '../core/types'
import { t, type Locale, type MsgKey } from '../core/i18n'
import { el, bindOutsideDismiss } from './dom'

const GROUP_HEADER_KEY: Record<BacklinkSourceKind, MsgKey> = {
  daily: 'module_daily',
  general: 'module_general_notes',
  person: 'atref_group_people',
  actions: 'module_actions',
  milestones: 'module_milestones',
  risks: 'module_risks',
}

// Module-level so opening a new panel always closes any panel already open —
// callers never need to track/close their own previous instance.
let closeCurrent: (() => void) | null = null

function showBacklinksPanel(anchor: HTMLElement, backlinks: Backlink[], locale: Locale, onNavigate: (loc: Loc, opts: { secondary: boolean }) => void): void {
  closeCurrent?.()

  function close(): void {
    panel.remove()
    unbind()
    closeCurrent = null
  }

  function activate(loc: Loc, e: MouseEvent): void {
    close()
    onNavigate(loc, { secondary: e.ctrlKey || e.metaKey || e.button === 1 })
  }

  const rows: HTMLElement[] = []
  let lastKind: BacklinkSourceKind | null = null
  for (const bl of backlinks) {
    if (bl.moduleKind !== lastKind) {
      rows.push(el('div', { class: 'tt-backlinks-group-header' }, `${KIND_ICON[bl.moduleKind]} ${t(locale, GROUP_HEADER_KEY[bl.moduleKind])}`))
      lastKind = bl.moduleKind
    }
    rows.push(
      el(
        'div',
        {
          class: 'tt-backlinks-row',
          onclick: (e: Event) => activate(bl.loc, e as MouseEvent),
          onauxclick: (e: Event) => { if ((e as MouseEvent).button === 1) activate(bl.loc, e as MouseEvent) },
          onmousedown: (e: Event) => { if ((e as MouseEvent).button === 1) e.preventDefault() },
        },
        el('div', { class: 'tt-backlinks-row-title' }, bl.title),
        el('div', { class: 'tt-backlinks-row-snippet' }, bl.snippet)
      )
    )
  }
  if (rows.length === 0) rows.push(el('div', { class: 'tt-backlinks-empty' }, t(locale, 'backlinks_panel_empty')))

  const panel = el('div', { class: 'tt-backlinks-panel' }, ...rows)
  const rect = anchor.getBoundingClientRect()
  panel.style.left = `${rect.left}px`
  panel.style.top = `${rect.bottom}px`
  document.body.appendChild(panel)

  // Clamp to the viewport — a chip docked near the pane's right/bottom edge
  // (the common case: kanban cards, milestone/risk rows) would otherwise
  // open partly or fully off-screen.
  const VIEWPORT_MARGIN = 8
  const panelRect = panel.getBoundingClientRect()
  if (panelRect.right > window.innerWidth - VIEWPORT_MARGIN) {
    panel.style.left = `${Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - panelRect.width)}px`
  }
  if (panelRect.bottom > window.innerHeight - VIEWPORT_MARGIN) {
    // Flip above the anchor when there's no room below it.
    panel.style.top = `${Math.max(VIEWPORT_MARGIN, rect.top - panelRect.height)}px`
  }

  const unbind = bindOutsideDismiss((target) => !panel.contains(target), close)
  closeCurrent = close
}

/**
 * Closes whatever backlinks panel is currently open, if any — a no-op
 * otherwise. `panel` itself lives only in whichever document is open when
 * it's shown, but this function and `closeCurrent` are module-level and
 * outlive any one document, so main.ts's teardownApp calls this on every
 * file close: an open panel's `onNavigate` closure (passed in by whichever
 * module rendered its chip) captures that document's store/pm, and its two
 * capturing `document` listeners (bindOutsideDismiss) would otherwise pin
 * all of it in memory until the next backlinks chip click anywhere in the
 * app — which might be in a much later, unrelated document, or never.
 */
export function closeAnyBacklinksPanel(): void {
  closeCurrent?.()
}

/**
 * A small "↩ N" pill, or null when `backlinks` is empty — callers skip
 * appending it in that case (the app's zero-count convention, matching how
 * the due-badge and search elsewhere render nothing rather than a zero).
 * Clicking it opens the grouped backlinks popover anchored to the pill.
 */
export function createBacklinksChip(backlinks: Backlink[], locale: Locale, onNavigate: (loc: Loc, opts: { secondary: boolean }) => void): HTMLElement | null {
  if (backlinks.length === 0) return null
  const chip = el(
    'button',
    { class: 'tt-backlinks-chip', type: 'button', tabindex: '-1', title: t(locale, 'backlinks_badge_title', { count: String(backlinks.length) }) },
    `↩ ${backlinks.length}`
  )
  chip.addEventListener('click', (e) => {
    e.stopPropagation()
    showBacklinksPanel(chip, backlinks, locale, onNavigate)
  })
  return chip
}
