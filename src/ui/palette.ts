// src/ui/palette.ts — Ctrl+Shift+K command palette: same module items as the pane
// dropdown (src/ui/panes.ts), filtered by a normalized substring match, plus
// one synthetic "Due" entry (src/ui/due-panel.ts) that isn't part of the
// pane module list.
import type { Store } from '../core/store'
import type { Locale } from '../core/i18n'
import { t } from '../core/i18n'
import { normalize } from '../core/search'
import { el } from './dom'
import { paintSelection, clampMove, selectableRowProps } from './select-list'
import { buildModuleItems, type PaneManager } from './panes'
import { applySearchHighlight, dispatchSearchFocusItem } from './search-highlight'
import { blockedByBlockingModal } from './hotkeys'
import { dismissModelessModals } from './modal'

export interface Palette {
  open(): void
}

interface PaletteRow {
  label: string
  commit(): void
}

/** Pure and exported so it can be unit-tested without touching the DOM. */
export function filterModuleItems<T extends { label: string }>(items: T[], query: string): T[] {
  const q = normalize(query.trim())
  if (!q) return items
  return items.filter((item) => normalize(item.label).includes(q))
}

export function createPalette(store: Store, pm: PaneManager, onOpenDue?: () => void): Palette {
  let overlay: HTMLElement | null = null
  let listEl: HTMLElement | null = null
  let allRows: PaletteRow[] = []
  let filtered: PaletteRow[] = []
  let selected = 0

  function locale(): Locale {
    return store.doc.prefs.locale
  }

  function close(): void {
    if (!overlay) return
    overlay.remove()
    overlay = null
    listEl = null
    document.removeEventListener('keydown', onKeydown, true)
  }

  function commit(row: PaletteRow | undefined): void {
    if (!row) return
    // A card modal open over the palette must close first (flushing its
    // notes editor) — every row here re-targets a pane. If its required-name
    // guard vetoes, keep the palette open on the still-open card.
    if (!dismissModelessModals()) return
    close()
    row.commit()
  }

  // Hover/arrow selection repaints in place via paintSelection — see
  // src/ui/select-list.ts for the rebuild-on-hover Chrome loop this avoids.
  function renderList(): void {
    if (!listEl) return
    listEl.innerHTML = ''
    filtered.forEach((row, i) => {
      const rowEl = el(
        'div',
        selectableRowProps({
          class: 'tt-palette-item',
          selected: i === selected,
          onCommit: () => commit(row),
          onHover: () => { selected = i; paintSelection(listEl, '.tt-palette-item', selected) },
        }),
        row.label
      )
      listEl!.appendChild(rowEl)
    })
  }

  function onKeydown(e: KeyboardEvent): void {
    // A *blocking* modal (e.g. an async save-conflict error) can appear while
    // the palette is already open — this capturing document listener must not
    // act (in particular Enter's navigation) behind it. A *modeless* card
    // modal is different: the palette deliberately opens over it (to switch
    // panes), so its own arrow/Enter/Escape keys have to keep working — and
    // stopPropagation below keeps Escape from also reaching that card's
    // document listener underneath.
    if (blockedByBlockingModal()) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      selected = clampMove(selected, e.key === 'ArrowDown' ? 1 : -1, filtered.length)
      paintSelection(listEl, '.tt-palette-item', selected)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      commit(filtered[selected])
    }
  }

  function open(): void {
    if (overlay) return
    // Every module row commits into the active team, so with no team the
    // palette can only list rows that no-op on Enter. Same rule the search bar
    // applies (src/ui/search-ui.ts syncEnabled) — the header button is disabled
    // to match, and this guard also covers the Ctrl+Shift+K path.
    if (store.doc.teams.length === 0) return
    const teamId = store.doc.nav.activeTeamId
    const team = teamId ? store.doc.teams.find((tm) => tm.id === teamId) ?? null : null
    const moduleRows: PaletteRow[] = buildModuleItems(team, locale()).map((item) => ({
      label: item.label,
      commit: () => {
        const activeTeamId = store.doc.nav.activeTeamId
        if (activeTeamId === null) return
        pm.openInFocused({ teamId: activeTeamId, ref: item.ref })
        // Mirrors search-ui.ts's commit(): expand the item (if collapsible)
        // and scroll/flash it into view, just without term highlighting —
        // the palette has no search query, only a resolved itemId.
        const itemId = 'itemId' in item.ref ? item.ref.itemId : undefined
        if (!itemId) return
        requestAnimationFrame(() => {
          const paneEl = document.querySelectorAll('.tt-pane-body')[store.doc.nav.focusedPane] as HTMLElement | undefined
          if (!paneEl) return
          dispatchSearchFocusItem(paneEl, itemId)
          const anchor = paneEl.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`)
          if (anchor) applySearchHighlight([paneEl], [], anchor)
        })
      },
    }))
    const dueRow: PaletteRow[] = onOpenDue
      ? [{ label: `⏰ ${t(locale(), 'due_panel_title')}`, commit: onOpenDue }]
      : []
    allRows = [...dueRow, ...moduleRows]
    filtered = allRows
    selected = 0

    const input = el('input', {
      type: 'text',
      class: 'tt-input tt-palette-input',
      placeholder: t(locale(), 'palette_placeholder'),
    })
    listEl = el('div', { class: 'tt-palette-list' })
    const dialog = el('div', { class: 'tt-palette-dialog' }, input, listEl)
    overlay = el('div', { class: 'tt-palette-overlay' }, dialog)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close()
    })
    document.body.appendChild(overlay)

    input.addEventListener('input', () => {
      filtered = filterModuleItems(allRows, input.value)
      selected = 0
      renderList()
    })
    document.addEventListener('keydown', onKeydown, true)
    renderList()
    input.focus()
  }

  return { open }
}
