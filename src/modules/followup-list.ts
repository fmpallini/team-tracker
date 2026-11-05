// src/modules/followup-list.ts — the row behaviour risks.ts and milestones.ts
// share: a list of titled rows, each with an expandable rich follow-up
// editor. Both modules used to carry identical copies of every function here,
// so fixes (the focus-out race, the date-picker exemption) had to land twice.
// Only what is genuinely identical lives here; each module still owns its row
// markup, sort order, search-jump handling and subscribe policy.
//
// Everything is keyed off `prefix`, which both modules already use
// consistently in their markup: rows are `.tt-{prefix}-row[data-{prefix}-id]`,
// the title field `.tt-{prefix}-title-input`, the follow-up row
// `.tt-{prefix}-followup-row[data-{prefix}-followup-id]`; the @mention kind is
// `{prefix}` and the team collection (and scope section) `{prefix}s`.
import type { Milestone, Risk } from '../core/types'
import type { ModuleCtx } from '../ui/panes'
import type { ExpandableRowsController } from '../ui/expandable-followup'
import { t, type MsgKey } from '../core/i18n'
import { patchTeamItem } from '../core/team-items'
import { createModuleEditor } from '../ui/rich-editor'
import { createModuleBacklinksChip } from '../ui/backlinks-panel'
import { el, showRowError, clearRowError } from '../ui/dom'
import { isMoveChord, isPlainKey } from '../ui/hotkeys'
import { icon } from '../ui/icons'

export type FollowupPrefix = 'risk' | 'milestone'

export interface BlankTitleGuardOptions<T> {
  /** Focus targets outside the list that still count as "not done with this row" (the add button, a date popover). */
  keepsRowOpen(active: Element): boolean
  /** An untitled row with nothing worth keeping, dropped silently; anything else is kept and flagged. */
  isDiscardable(item: T): boolean
  discard(id: string): void
}

export interface FollowupRowsConfig<T> {
  ctx: ModuleCtx
  teamId: string
  prefix: FollowupPrefix
  listEl: HTMLElement
  expandable: ExpandableRowsController
  /** Shown under a row whose required title is blank. */
  nameRequired: string
  /** The live item, re-read on every call (never a render-time snapshot). */
  find(id: string): T | undefined
  /** The owning module's full rebuild. */
  renderAll(): void
}

export interface FollowupRows<T> {
  rowFor(id: string): HTMLElement | null
  showNameError(row: HTMLElement): void
  clearNameError(row: HTMLElement): void
  requireTitle(id: string): boolean
  toggleExpand(id: string): void
  followupEditorRow(item: T): HTMLElement
  isCommittingOwnFollowup(): boolean
  commitTitle(id: string, value: string): void
  isCommittingOwnTitle(): boolean
  backlinksSlot(id: string): HTMLElement
  refreshBacklinkChips(): void
  wireRowKeys(row: HTMLElement, id: string, openMenu: (x: number, y: number) => void, moveBy?: (id: string, dir: -1 | 1) => void): void
  commitFieldOnEnter(id: string): (e: Event) => void
  wireDblclickToggle(row: HTMLElement, id: string): void
  installBlankTitleGuard(row: HTMLElement, id: string, opts: BlankTitleGuardOptions<T>): void
  paintExpandAllBtn(btn: HTMLElement, ids: string[], collapseKey: MsgKey, expandKey: MsgKey): void
}

export function createFollowupRows<T extends Risk | Milestone>(cfg: FollowupRowsConfig<T>): FollowupRows<T> {
  const { ctx, teamId, prefix, listEl, expandable } = cfg
  const rowClass = `tt-${prefix}-row`
  const idAttr = `data-${prefix}-id`
  const errorClass = `tt-${prefix}-name-error`
  const collection = prefix === 'risk' ? ('risks' as const) : ('milestones' as const)
  // True only while one of these rows' own follow-up editors is committing. A
  // follow-up's text appears nowhere in the row list, so the owning module's
  // subscriber skips its full rebuild for it, and with it the rebuild-on-blur
  // that detached the next follow-up editor being clicked into.
  let committingOwnFollowup = false
  // Same for a title, which the row's own input already shows. Worse than
  // wasteful to rebuild for: a Tab out commits it with focus in mid-air, and
  // the rebuild would destroy the next field before focus reaches it.
  let committingOwnTitle = false

  function rowFor(id: string): HTMLElement | null {
    return listEl.querySelector<HTMLElement>(`.${rowClass}[${idAttr}="${id}"]`)
  }
  function showNameError(row: HTMLElement): void { showRowError(row, errorClass, cfg.nameRequired) }
  function clearNameError(row: HTMLElement): void { clearRowError(row, errorClass) }

  /** A follow-up is written under a title, as an action item's notes can't be saved without a name: a nameless row refuses, flags itself and puts the caret in the title. */
  function requireTitle(id: string): boolean {
    const cur = cfg.find(id)
    if (!cur || cur.title.trim() !== '') return true
    const row = rowFor(id)
    if (row) {
      showNameError(row)
      row.querySelector<HTMLInputElement>(`.tt-${prefix}-title-input`)?.focus()
    }
    return false
  }

  /** Writes a row's title. Unscoped beyond the team: it is the label @mentions of the item resolve through live, see the note at people-tree.ts's rename site. */
  function commitTitle(id: string, value: string): void {
    committingOwnTitle = true
    try {
      patchTeamItem(ctx.store, teamId, collection, id, (found) => { found.title = value }, { teamId })
    } finally {
      committingOwnTitle = false
    }
    const row = rowFor(id)
    if (row && value.trim() !== '') clearNameError(row)
  }

  // Keyboard-driven (Enter on a focused row): land focus somewhere sane after
  // the rebuild, on the follow-up editor when expanding (so typing can start)
  // or back on the row when collapsing (so the arrows continue).
  function toggleExpand(id: string): void {
    const wasExpanded = expandable.isExpanded(id)
    if (!wasExpanded && !requireTitle(id)) return
    expandable.toggle(id)
    cfg.renderAll()
    if (wasExpanded) rowFor(id)?.focus()
    else listEl.querySelector<HTMLElement>(`[data-${prefix}-followup-id="${id}"] .editor`)?.focus()
  }

  /** The row's full rich editor, scoped to 'any' templates since a follow-up isn't tied to a person or a day. Registers with `expandable` so the module's disposeAll() tears it down. */
  function followupEditorRow(item: T): HTMLElement {
    const bundle = createModuleEditor(ctx, teamId, {
      initialMd: item.followup,
      templateScopes: ['any'],
      onEscape: () => rowFor(item.id)?.focus(),
      onChange: (md) => {
        committingOwnFollowup = true
        try {
          patchTeamItem(ctx.store, teamId, collection, item.id, (found) => { found.followup = md }, { teamId, sections: [collection] })
        } finally {
          committingOwnFollowup = false
        }
      },
    })
    expandable.register(item.id, bundle)
    return el('div', { class: `tt-${prefix}-followup-row`, [`data-${prefix}-followup-id`]: item.id, 'data-item-id': item.id }, bundle.editor.root)
  }

  // A fixed-width slot even when there's no chip: el() skips null children,
  // which would collapse the column on chip-less rows and misalign them.
  function backlinksSlot(id: string): HTMLElement {
    return createModuleBacklinksChip(ctx, teamId, prefix, id) ?? el('span', { class: 'tt-backlinks-chip-slot' })
  }

  /** Re-queries each row's backlinks and swaps its chip in place: for a change confined to sibling sections, which can only reach these rows through their chips. */
  function refreshBacklinkChips(): void {
    for (const row of listEl.querySelectorAll<HTMLElement>(`.${rowClass}`)) {
      const id = row.getAttribute(idAttr)
      if (id === null) continue
      const existing = row.querySelector('.tt-backlinks-chip, .tt-backlinks-chip-slot')
      if (!existing) continue
      existing.replaceWith(backlinksSlot(id))
    }
  }

  // Guarded on `e.target === row` throughout, so Enter inside the title input
  // still means "commit and blur" (blurOnEnter), Space inside a select still
  // opens it, and arrows inside a select still change its value. Only a
  // keypress on the row itself counts.
  function wireRowKeys(row: HTMLElement, id: string, openMenu: (x: number, y: number) => void, moveBy?: (id: string, dir: -1 | 1) => void): void {
    row.addEventListener('keydown', (ev) => {
      if (ev.target !== row) return
      if (moveBy && isMoveChord(ev) && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
        ev.preventDefault()
        moveBy(id, ev.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (!isPlainKey(ev)) return
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        const rows = Array.from(listEl.querySelectorAll<HTMLElement>(`.${rowClass}`))
        const next = rows[rows.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1)]
        if (!next) return
        ev.preventDefault()
        next.focus()
        return
      }
      if (ev.key === 'Enter') {
        ev.preventDefault()
        toggleExpand(id)
        return
      }
      if (ev.key !== ' ') return
      // Keyboard equivalent of the right-click menu.
      ev.preventDefault()
      const rect = row.getBoundingClientRect()
      openMenu(rect.left + 16, rect.bottom)
    })
  }

  /**
   * Enter in a row's text field: commits the way Tab or a click away does, by
   * blurring, then lands on the row (rebuilt by the commit, so found by id) for
   * the arrows and row keys to carry on from.
   */
  function commitFieldOnEnter(id: string): (e: Event) => void {
    return (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return
      ;(e.target as HTMLElement).blur()
      rowFor(id)?.focus()
    }
  }

  // Double-click any dead space on the row toggles the follow-up, a bigger
  // target than the caret. Skipped on the row's own controls (a field edit, a
  // word-select in the title, a button press).
  function wireDblclickToggle(row: HTMLElement, id: string): void {
    row.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('input, select, button, a')) return
      if (!expandable.isExpanded(id) && !requireTitle(id)) return
      expandable.toggle(id)
      cfg.renderAll()
    })
  }

  /**
   * Blank-name guard, the inline-row stand-in for action-items.ts's modal-close
   * behaviour: once focus has genuinely left the list with the title still
   * blank, a discardable draft is dropped silently and a row with real content
   * is kept with its missing name flagged.
   */
  function installBlankTitleGuard(row: HTMLElement, id: string, opts: BlankTitleGuardOptions<T>): void {
    row.addEventListener('focusout', () => {
      // Deferred a tick on purpose: clicking the row's own caret / close /
      // delete button, or any edit that re-renders the row, all resettle focus
      // within the tick, and a tabindex="-1" button doesn't reliably hold
      // focus. Judging synchronously (or off relatedTarget, which is null on
      // those in headless Chromium) would fire the guard on them.
      setTimeout(() => {
        // An edit inside the list defers a rebuild that flushes the instant
        // focus leaves, so this row may already have been replaced by a fresh
        // one that never had focus. Judge the live row by id; only a torn-down
        // module (listEl detached) or a vanished item ends the check.
        if (!listEl.isConnected) return
        const liveRow = row.isConnected ? row : rowFor(id)
        if (!liveRow) return
        const active = document.activeElement
        // Focus went nowhere real: a stray blur, not a deliberate move away.
        if (!active || active === document.body) return
        // Still inside the list (another row, the follow-up editor that just
        // opened) or on something the module counts as part of it.
        if (listEl.contains(active) || opts.keepsRowOpen(active)) return
        const cur = cfg.find(id)
        if (!cur) return
        if (cur.title.trim() !== '') { clearNameError(liveRow); return }
        if (opts.isDiscardable(cur)) opts.discard(id)
        else showNameError(liveRow)
      }, 0)
    })
  }

  /** "Expand all" unless every listed row is already expanded, then "Collapse all". */
  function paintExpandAllBtn(btn: HTMLElement, ids: string[], collapseKey: MsgKey, expandKey: MsgKey): void {
    const all = expandable.isAllExpanded(ids)
    btn.replaceChildren(icon(all ? 'chevUp' : 'chevDown', 12), t(ctx.locale, all ? collapseKey : expandKey))
  }

  return {
    rowFor, showNameError, clearNameError, requireTitle, toggleExpand,
    followupEditorRow, isCommittingOwnFollowup: () => committingOwnFollowup,
    commitTitle, isCommittingOwnTitle: () => committingOwnTitle,
    backlinksSlot, refreshBacklinkChips, wireRowKeys, commitFieldOnEnter, wireDblclickToggle,
    installBlankTitleGuard, paintExpandAllBtn,
  }
}

/**
 * The caret-sensitive element in `container` that currently holds focus, if
 * any: an <input> of one of `inputTypes`, or an expanded follow-up's
 * contenteditable `.editor`. A foreign store change defers its rebuild to this
 * element's blur instead of wiping an in-progress edit. Checkboxes and selects
 * have no caret to preserve, so they never count.
 */
export function focusedCaretElement(container: HTMLElement, inputTypes: readonly string[]): HTMLElement | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !container.contains(active)) return null
  if (active instanceof HTMLInputElement && inputTypes.includes(active.type)) return active
  if (active.classList.contains('editor') && active.isContentEditable) return active
  return null
}
