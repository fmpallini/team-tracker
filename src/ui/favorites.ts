// src/ui/favorites.ts — the favorites panel: a dropdown hung under the header
// (opened by the header ★ button or Ctrl+Alt+F) listing every starred pane
// location, with arrow/Enter/1–9 keyboard navigation. Modeled on palette.ts
// (capture-phase keydown, same blocking/modeless-modal guards, select-list.ts
// row mechanics so hover never rebuilds the rows). Positioned `fixed` from the
// header's bottom edge — not from the ★ button — so the hotkey still works when
// the compact header hides that button. All sizes are rem (styles.css) so the
// panel follows the text-size setting.
import type { Store } from '../core/store'
import type { Favorite } from '../core/types'
import { findTeam } from '../core/document'
import { isFavoriteOrphaned, liveFavorites, toggleFavorite } from '../core/favorites'
import { KIND_ICON } from '../core/search'
import type { Locale } from '../core/i18n'
import { t } from '../core/i18n'
import { el } from './dom'
import { paintSelection, clampMove, selectableRowProps } from './select-list'
import { blockedByBlockingModal, matchDigit } from './hotkeys'
import { dismissModelessModals } from './modal'
import { titleFor, type PaneManager } from './panes'

export interface FavoritesDeps {
  /** Switches the active team (main.ts's selectTeam). */
  selectTeam(id: string): void
  /** Viewport y of the header's bottom edge — the panel hangs under it. */
  headerBottom(): number
}

export interface FavoritesPanel {
  toggle(): void
  open(): void
  close(): void
  isOpen(): boolean
  /** Releases the document listeners (also closes). */
  dispose(): void
}

export function createFavoritesPanel(store: Store, pm: PaneManager, deps: FavoritesDeps): FavoritesPanel {
  let panel: HTMLElement | null = null
  let listEl: HTMLElement | null = null
  let rows: Favorite[] = []
  let selected = 0
  // Where focus was before open(): Escape hands it back (a jump must not — the pane re-renders).
  let prevFocus: Element | null = null

  function locale(): Locale {
    return store.doc.prefs.locale
  }

  function labelFor(fav: Favorite): string {
    const team = findTeam(store.doc, fav.teamId)
    const title = titleFor(store, fav, locale())
    return `${team?.emoji ?? ''} ${team?.name ?? ''} · ${KIND_ICON[fav.ref.kind]} ${title}`.trim()
  }

  function close(): void {
    if (!panel) return
    panel.remove()
    panel = null
    listEl = null
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('mousedown', onMousedown, true)
    document.removeEventListener('focusin', onFocusin, true)
  }

  function jump(fav: Favorite | undefined): void {
    if (!fav) return
    // The row may predate a deletion (rows render once per open/✕); never jump to a dead favorite.
    if (isFavoriteOrphaned(store.doc, fav)) { renderList(); return }
    // A card modal open in a pane must close first (flushing its notes editor);
    // if its required-name guard vetoes, keep the panel open on the card.
    if (!dismissModelessModals()) return
    close()
    if (fav.teamId !== store.doc.nav.activeTeamId) deps.selectTeam(fav.teamId)
    pm.openInFocused({ teamId: fav.teamId, ref: fav.ref })
  }

  function remove(fav: Favorite): void {
    store.update((d) => { toggleFavorite(d, fav) })
    renderList()
  }

  // Hover/arrow selection repaints in place via paintSelection (select-list.ts);
  // only a structural change (open, ✕) rebuilds the rows.
  function renderList(): void {
    if (!listEl) return
    rows = liveFavorites(store.doc)
    selected = Math.min(selected, Math.max(0, rows.length - 1))
    listEl.innerHTML = ''
    if (rows.length === 0) {
      listEl.appendChild(el('div', { class: 'tt-favorites-empty' }, t(locale(), 'favorites_empty')))
      return
    }
    rows.forEach((fav, i) => {
      const label = labelFor(fav)
      const rowEl = el(
        'div',
        selectableRowProps({
          class: 'tt-favorites-item',
          selected: i === selected,
          onCommit: () => jump(fav),
          onHover: () => { selected = i; paintSelection(listEl, '.tt-favorites-item', selected) },
        }),
        el('span', { class: 'tt-favorites-badge', 'aria-hidden': 'true' }, i < 9 ? String(i + 1) : ''),
        el('span', { class: 'tt-favorites-label', title: label }, label),
        el('button', {
          class: 'tt-favorites-remove',
          type: 'button',
          title: t(locale(), 'pane_fav_remove_title'),
          'aria-label': t(locale(), 'pane_fav_remove_title'),
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: (e: Event) => { e.stopPropagation(); remove(fav) },
        }, '✕')
      )
      listEl!.appendChild(rowEl)
    })
  }

  function onKeydown(e: KeyboardEvent): void {
    // A blocking modal that appears while the panel is open must not have this
    // capturing listener act behind it (same rule as palette.ts).
    if (blockedByBlockingModal()) return
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      const back = prevFocus
      close()
      if (back instanceof HTMLElement && back.isConnected) back.focus()
      return
    }
    // Modified keys belong to the app's own hotkeys (Alt+arrows = panes, Alt+1..9 = teams).
    if (e.ctrlKey || e.altKey || e.metaKey) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation()
      selected = clampMove(selected, e.key === 'ArrowDown' ? 1 : -1, rows.length)
      paintSelection(listEl, '.tt-favorites-item', selected)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation()
      jump(rows[selected])
      return
    }
    if (e.shiftKey) return // Shift+1 types "!", it is not a digit press
    for (let n = 1; n <= 9; n++) {
      if (!matchDigit(e, n)) continue
      e.preventDefault(); e.stopPropagation()
      jump(rows[n - 1])
      return
    }
  }

  // Not the ★ button: its own click toggles, and closing here first would make
  // that click re-open the panel it just closed.
  function onMousedown(e: MouseEvent): void {
    const target = e.target as Element | null
    if (target?.closest('.tt-favorites-panel, .tt-btn-favorites')) return
    close()
  }

  // The panel takes focus on open so its keys never fight a field the user was
  // typing in; focus moving anywhere else (Ctrl+F, `/`, Tab…) dismisses it and
  // leaves that field's keys untouched. Same ★-button exemption as mousedown.
  function onFocusin(e: FocusEvent): void {
    const target = e.target as Element | null
    if (target?.closest('.tt-favorites-panel, .tt-btn-favorites')) return
    close()
  }

  function open(): void {
    if (panel) return
    // Every row re-targets a pane inside some team; with none there is nothing
    // to jump to. Same rule as the palette and the search bar.
    if (store.doc.teams.length === 0) return
    selected = 0
    prevFocus = document.activeElement
    listEl = el('div', { class: 'tt-favorites-list' })
    panel = el(
      'div',
      { class: 'tt-favorites-panel', tabindex: '-1', role: 'dialog', 'aria-label': t(locale(), 'favorites_panel_label') },
      listEl
    )
    panel.style.top = `${deps.headerBottom()}px`
    document.body.appendChild(panel)
    document.addEventListener('keydown', onKeydown, true)
    document.addEventListener('mousedown', onMousedown, true)
    document.addEventListener('focusin', onFocusin, true)
    renderList()
    panel.focus()
  }

  return {
    toggle: () => (panel ? close() : open()),
    open,
    close,
    isOpen: () => panel !== null,
    dispose: close,
  }
}
