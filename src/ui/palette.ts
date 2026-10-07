// src/ui/palette.ts — the fast switch (Ctrl+Shift+K / app-name button): one
// cross-team switcher listing Favorites, Due dates, the current team and — once
// you type — the other teams. The model (matching, dedupe, the 20-row cap)
// lives in core/switcher.ts; this file renders it and handles keys/commit.
// Favorite rows carry a ✕ that unstars them in place.
import type { Store } from '../core/store'
import type { Favorite } from '../core/types'
import type { Locale } from '../core/i18n'
import { t, todayIso } from '../core/i18n'
import { toggleFavorite } from '../core/favorites'
import { buildSwitcher, type SwitcherRow, type SwitcherSection } from '../core/switcher'
import { el } from './dom'
import { paintSelection, clampMove, selectableRowProps } from './select-list'
import type { PaneManager } from './panes'
import { applySearchHighlight, dispatchSearchFocusItem } from './search-highlight'
import { blockedByBlockingModal } from './hotkeys'
import { dismissModelessModals } from './modal'

export interface Palette {
  open(): void
}

export interface PaletteDeps {
  /** Switches the active team (main.ts's selectTeam) — called before a row on another team opens. */
  selectTeam(id: string): void
}

export function createPalette(store: Store, pm: PaneManager, deps: PaletteDeps): Palette {
  let overlay: HTMLElement | null = null
  let listEl: HTMLElement | null = null
  let input: HTMLInputElement | null = null
  let sections: SwitcherSection[] = []
  let rows: SwitcherRow[] = []
  let selected = 0
  // What had focus before the palette opened, so a plain dismiss can hand it back.
  let returnFocus: Element | null = null

  function locale(): Locale {
    return store.doc.prefs.locale
  }

  function rebuild(): void {
    sections = buildSwitcher(store.doc, input?.value ?? '', locale(), todayIso())
    rows = sections.flatMap((s) => s.rows)
  }

  function close(): void {
    if (!overlay) return
    overlay.remove()
    overlay = null
    listEl = null
    input = null
    document.removeEventListener('keydown', onKeydown, true)
  }

  /** Escape / backdrop click: close, then give focus back. A commit does not — the pane re-renders and owns focus. */
  function dismiss(): void {
    const back = returnFocus
    close()
    if (back instanceof HTMLElement && back.isConnected) back.focus()
  }

  function commit(row: SwitcherRow | undefined): void {
    if (!row) return
    // A card modal open over the palette must close first (flushing its
    // notes editor) — every row here re-targets a pane. If its required-name
    // guard vetoes, keep the palette open on the still-open card.
    if (!dismissModelessModals()) return
    close()
    if (row.teamId !== store.doc.nav.activeTeamId) deps.selectTeam(row.teamId)
    pm.openInFocused({ teamId: row.teamId, ref: row.ref })
    // Mirrors search-ui.ts's commit(): expand the item (if collapsible)
    // and scroll/flash it into view, just without term highlighting —
    // the palette has no search query, only a resolved itemId.
    const itemId = 'itemId' in row.ref ? row.ref.itemId : undefined
    if (!itemId) return
    requestAnimationFrame(() => {
      const paneEl = document.querySelectorAll('.tt-pane-body')[store.doc.nav.focusedPane] as HTMLElement | undefined
      if (!paneEl) return
      dispatchSearchFocusItem(paneEl, itemId)
      const anchor = paneEl.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`)
      if (anchor) applySearchHighlight([paneEl], [], anchor)
    })
  }

  function removeFavorite(fav: Favorite): void {
    store.update((d) => { toggleFavorite(d, fav) })
    rebuild()
    selected = Math.min(selected, Math.max(0, rows.length - 1))
    renderList()
  }

  function buildRow(row: SwitcherRow, i: number): HTMLElement {
    const parts: HTMLElement[] = [el('span', { class: 'tt-palette-label', title: row.label }, row.label)]
    if (row.dueLabel) parts.push(el('span', { class: 'tt-palette-due', title: row.dueLabel }, row.dueLabel))
    if (row.teamBadge) parts.push(el('span', { class: 'tt-palette-team', title: row.teamBadge }, row.teamBadge))
    const fav = row.favorite
    if (fav) {
      parts.push(el('button', {
        class: 'tt-palette-remove',
        type: 'button',
        tabindex: '-1', // mouse-only: Tab from the input must not land on it
        title: t(locale(), 'pane_fav_remove_title'),
        'aria-label': t(locale(), 'pane_fav_remove_title'),
        onmousedown: (e: Event) => e.preventDefault(),
        onclick: (e: Event) => { e.stopPropagation(); removeFavorite(fav) },
      }, '✕'))
    }
    return el(
      'div',
      selectableRowProps({
        class: 'tt-palette-item',
        selected: i === selected,
        onCommit: () => commit(row),
        onHover: () => { selected = i; paintSelection(listEl, '.tt-palette-item', selected) },
      }),
      ...parts
    )
  }

  // Hover/arrow selection repaints in place via paintSelection — see
  // src/ui/select-list.ts for the rebuild-on-hover Chrome loop this avoids.
  // Only typing and ✕ (a structural change) rebuild the rows. Headings are not
  // `.tt-palette-item`, so arrows and hover never land on them.
  function renderList(): void {
    if (!listEl) return
    listEl.innerHTML = ''
    if (rows.length === 0) {
      listEl.appendChild(el('div', { class: 'tt-palette-empty' }, t(locale(), 'switcher_empty')))
      return
    }
    let index = 0
    for (const section of sections) {
      const headingId = `tt-palette-heading-${section.id}`
      const count = section.rows.length < section.total
        ? ` · ${t(locale(), 'switcher_count', { shown: String(section.rows.length), total: String(section.total) })}`
        : ''
      const group = el(
        'div',
        { class: 'tt-palette-group', role: 'group', 'aria-labelledby': headingId },
        el('div', { class: 'tt-palette-heading', id: headingId, title: section.heading }, `${section.heading}${count}`)
      )
      for (const row of section.rows) group.appendChild(buildRow(row, index++))
      listEl.appendChild(group)
    }
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
      dismiss()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      selected = clampMove(selected, e.key === 'ArrowDown' ? 1 : -1, rows.length)
      paintSelection(listEl, '.tt-palette-item', selected)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      commit(rows[selected])
    }
  }

  function open(): void {
    if (overlay) return
    // Every row commits into some team, so with no team the palette can only
    // list rows that no-op on Enter. Same rule the search bar applies
    // (src/ui/search-ui.ts syncEnabled) — the header button is disabled to
    // match, and this guard also covers the Ctrl+Shift+K path.
    if (store.doc.teams.length === 0) return
    returnFocus = document.activeElement
    input = el('input', {
      type: 'text',
      class: 'tt-input tt-palette-input',
      placeholder: t(locale(), 'palette_placeholder'),
    })
    listEl = el('div', { class: 'tt-palette-list' })
    const dialog = el('div', { class: 'tt-palette-dialog' }, input, listEl)
    overlay = el('div', { class: 'tt-palette-overlay' }, dialog)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) dismiss()
    })
    document.body.appendChild(overlay)

    selected = 0
    rebuild()
    input.addEventListener('input', () => {
      selected = 0
      rebuild()
      renderList()
    })
    document.addEventListener('keydown', onKeydown, true)
    renderList()
    input.focus()
  }

  return { open }
}
