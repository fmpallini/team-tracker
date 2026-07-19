// src/ui/search-ui.ts — global search: input mounted in the shell header,
// results dropdown below it. Scoped to the active team by default; a
// checkbox in the dropdown widens the scope to every team.
import type { Shell } from './shell'
import type { Store } from '../core/store'
import type { PaneManager } from './panes'
import { t, type Locale } from '../core/i18n'
import { searchDocument, normalize, KIND_ICON, type SearchResult } from '../core/search'
import { el } from './dom'
import { hotkeyAllowed } from './hotkeys'
import { applySearchHighlight } from './search-highlight'
import { paintSelection } from './select-list'
import { onLocaleChanged } from './prefs'

const DEBOUNCE_MS = 150

/**
 * Builds the highlighted snippet DOM. `snippet` and `normalize(snippet)` are
 * index-aligned (see core/search.ts's `normalize` doc comment: it preserves
 * character count for the accented Latin text this app handles), so term
 * positions found in the normalized snippet slice directly into the original
 * display text. Built entirely from text nodes and `<mark>` elements (no
 * innerHTML) since snippet content comes from user-authored notes.
 */
function appendHighlightedSnippet(container: HTMLElement, snippet: string, terms: string[]): void {
  const normalized = normalize(snippet)
  const ranges: [number, number][] = []
  for (const term of terms) {
    if (!term) continue
    let from = 0
    for (;;) {
      const idx = normalized.indexOf(term, from)
      if (idx < 0) break
      ranges.push([idx, idx + term.length])
      from = idx + term.length
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1])
    } else {
      merged.push(range)
    }
  }
  let pos = 0
  for (const [start, end] of merged) {
    if (start > pos) container.appendChild(document.createTextNode(snippet.slice(pos, start)))
    container.appendChild(el('mark', {}, snippet.slice(start, end)))
    pos = end
  }
  if (pos < snippet.length) container.appendChild(document.createTextNode(snippet.slice(pos)))
}

/** Returns a dispose function that removes the document-level listeners and the header DOM — registered with main.ts's per-document disposers so a close-file → reopen cycle doesn't accumulate listeners (each pinning its closed document's store and DOM). */
export function mountSearch(
  shell: Shell,
  store: Store,
  pm: PaneManager,
  switchTeam: (teamId: string) => void
): () => void {
  let allTeams = false
  let results: SearchResult[] = []
  let selected = 0
  let open = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  function localeNow(): Locale {
    return store.doc.prefs.locale
  }

  const input = el('input', {
    type: 'text',
    class: 'tt-input tt-search-input',
    placeholder: t(localeNow(), 'search_placeholder'),
  }) as HTMLInputElement

  const checkbox = el('input', { type: 'checkbox' }) as HTMLInputElement
  const checkboxLabelText = el('span', {}, t(localeNow(), 'search_all_teams'))
  const checkboxLabel = el('label', { class: 'tt-search-all-teams' }, checkbox, ' ', checkboxLabelText)

  // Header-adjacent text captured at mount time would otherwise stay stale
  // after a locale switch (see prefs.ts's LOCALE_CHANGED_EVENT comment) —
  // refresh it live instead of waiting for the next remount.
  const unsubscribeLocale = onLocaleChanged(() => {
    const lc = localeNow()
    input.placeholder = t(lc, 'search_placeholder')
    checkboxLabelText.textContent = t(lc, 'search_all_teams')
    if (open) renderList()
  })
  const listEl = el('div', { class: 'tt-search-list' })
  const dropdown = el('div', { class: 'tt-search-dropdown' }, checkboxLabel, listEl)
  const wrap = el('div', { class: 'tt-search-wrap' }, input, dropdown)
  shell.headerLeft.appendChild(wrap)

  function currentTerms(): string[] {
    return normalize(input.value.trim()).split(/\s+/).filter(Boolean)
  }

  function closeDropdown(): void {
    open = false
    dropdown.classList.remove('open')
  }

  function openDropdown(): void {
    open = true
    dropdown.classList.add('open')
  }

  function renderList(): void {
    listEl.innerHTML = ''
    const terms = currentTerms()
    if (results.length === 0) {
      listEl.appendChild(el('div', { class: 'tt-search-empty' }, t(localeNow(), 'search_no_results')))
      return
    }
    results.forEach((result, i) => {
      const mainChildren: (Node | string)[] = [el('span', { class: 'tt-search-icon' }, KIND_ICON[result.moduleKind])]
      if (allTeams) mainChildren.push(el('span', { class: 'tt-search-team' }, result.teamName))
      mainChildren.push(el('span', { class: 'tt-search-title' }, result.title))
      const main = el('div', { class: 'tt-search-row-main' }, ...mainChildren)
      const snippetEl = el('div', { class: 'tt-search-snippet' })
      appendHighlightedSnippet(snippetEl, result.snippet, terms)
      const row = el(
        'div',
        {
          class: 'tt-search-row' + (i === selected ? ' selected' : ''),
          onmousedown: (e: Event) => { e.preventDefault(); commit(result) },
          onmouseenter: () => {
            selected = i
            paintSelection(listEl, '.tt-search-row', selected)
          },
        },
        main,
        snippetEl
      )
      listEl.appendChild(row)
    })
  }

  function runSearch(): void {
    debounceTimer = null
    const q = input.value
    if (!q.trim()) {
      results = []
      closeDropdown()
      return
    }
    const scope = allTeams ? null : store.doc.nav.activeTeamId
    results = searchDocument(store.doc, q, scope)
    selected = 0
    renderList()
    openDropdown()
  }

  function commit(result: SearchResult | undefined): void {
    if (!result) return
    const terms = currentTerms()
    // A result from a team other than the one currently browsed must switch
    // teams first — this app only ever shows one team at a time, and
    // switching teams restores *both* panes' last-used modules for it (see
    // main.ts's selectTeam), not just whichever pane happens to be focused.
    // Opening the searched Loc below then lands on the specific result
    // within that already-consistent team switch, rather than leaving one
    // pane on the old team's content while the other jumps to the new one.
    if (result.loc.teamId !== store.doc.nav.activeTeamId) {
      switchTeam(result.loc.teamId)
    }
    pm.openInFocused(result.loc)
    closeDropdown()
    requestAnimationFrame(() => {
      const paneEl = document.querySelectorAll('.tt-pane-body')[store.doc.nav.focusedPane] as HTMLElement | undefined
      if (!paneEl) return
      const ref = result.loc.ref
      const anchor = 'itemId' in ref && ref.itemId ? paneEl.querySelector(`[data-item-id="${ref.itemId}"]`) : null
      applySearchHighlight((anchor as HTMLElement) ?? paneEl, terms)
    })
  }

  checkbox.addEventListener('change', () => {
    allTeams = checkbox.checked
    runSearch()
  })

  input.addEventListener('input', () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(runSearch, DEBOUNCE_MS)
  })

  // Resuming focus on a query left over from before (e.g. after clicking
  // away, or the results are simply stale after editing elsewhere) should
  // refresh the matches immediately rather than showing a stale or closed
  // dropdown. Escape's own re-focus below (closing the dropdown but keeping
  // focus for a quick re-edit) is explicitly exempted via this flag —
  // otherwise it would immediately reopen what Escape just closed.
  let suppressFocusReopen = false
  input.addEventListener('focus', () => {
    if (suppressFocusReopen) { suppressFocusReopen = false; return }
    if (input.value.trim() !== '') runSearch()
  })

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (open) {
        closeDropdown()
        suppressFocusReopen = true
        input.focus()
      } else {
        input.blur()
      }
      return
    }
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      // Wraparound (unlike the clamped dropdowns) — kept from the original behavior.
      selected = (selected + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length
      paintSelection(listEl, '.tt-search-row', selected)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(results[selected])
    }
  })

  const onDocKeydown = (e: KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      input.focus()
      input.select()
      return
    }
    if (e.key === '/' && hotkeyAllowed(e)) {
      e.preventDefault()
      input.focus()
    }
  }
  document.addEventListener('keydown', onDocKeydown)

  const onDocMousedown = (e: MouseEvent): void => {
    if (!open) return
    if (wrap.contains(e.target as Node)) return
    closeDropdown()
  }
  document.addEventListener('mousedown', onDocMousedown)

  return function disposeSearch(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    unsubscribeLocale()
    document.removeEventListener('keydown', onDocKeydown)
    document.removeEventListener('mousedown', onDocMousedown)
    wrap.remove()
  }
}
