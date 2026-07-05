// src/ui/palette.ts — Ctrl+K command palette: same module items as the pane
// dropdown (src/ui/panes.ts), filtered by a normalized substring match.
import type { Store } from '../core/store'
import type { Locale } from '../core/i18n'
import { t } from '../core/i18n'
import { normalize } from '../core/search'
import { el } from './dom'
import { buildModuleItems, type ModuleItem, type PaneManager } from './panes'

export interface Palette {
  open(): void
}

/** Pure and exported so it can be unit-tested without touching the DOM. */
export function filterModuleItems(items: ModuleItem[], query: string): ModuleItem[] {
  const q = normalize(query.trim())
  if (!q) return items
  return items.filter((item) => normalize(item.label).includes(q))
}

export function createPalette(store: Store, pm: PaneManager): Palette {
  let overlay: HTMLElement | null = null
  let listEl: HTMLElement | null = null
  let allItems: ModuleItem[] = []
  let filtered: ModuleItem[] = []
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

  function commit(item: ModuleItem | undefined): void {
    if (!item) return
    const teamId = store.doc.nav.activeTeamId
    close()
    if (teamId === null) return
    pm.openInFocused({ teamId, ref: item.ref })
  }

  function renderList(): void {
    if (!listEl) return
    listEl.innerHTML = ''
    filtered.forEach((item, i) => {
      const row = el(
        'div',
        {
          class: 'tt-palette-item' + (i === selected ? ' selected' : ''),
          onclick: () => commit(item),
          onmouseenter: () => {
            selected = i
            renderList()
          },
        },
        item.label
      )
      listEl!.appendChild(row)
    })
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selected = filtered.length === 0 ? 0 : Math.min(selected + 1, filtered.length - 1)
      renderList()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selected = Math.max(selected - 1, 0)
      renderList()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(filtered[selected])
    }
  }

  function open(): void {
    if (overlay) return
    const teamId = store.doc.nav.activeTeamId
    const team = teamId ? store.doc.teams.find((tm) => tm.id === teamId) ?? null : null
    allItems = buildModuleItems(team, locale())
    filtered = allItems
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
      filtered = filterModuleItems(allItems, input.value)
      selected = 0
      renderList()
    })
    document.addEventListener('keydown', onKeydown, true)
    renderList()
    input.focus()
  }

  return { open }
}
