// src/ui/search-ui.ts — global search: input mounted in the shell header,
// results dropdown below it. Scoped to the active team by default; a
// checkbox in the dropdown widens the scope to every team.
import type { Shell } from './shell'
import type { Store } from '../core/store'
import type { PaneManager } from './panes'
import { t, type Locale } from '../core/i18n'
import { normalize, KIND_ICON, type SearchResult, type SearchIndex } from '../core/search'
import { el } from './dom'
import { hotkeyAllowed, blockedByModal, matchKey } from './hotkeys'
import { applySearchHighlight, dispatchSearchFocusItem } from './search-highlight'
import { paintSelection } from './select-list'
import { onLocaleChanged } from './prefs'

const DEBOUNCE_MS = 300

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

/**
 * Returns a dispose function that removes the document-level listeners and
 * the header DOM — registered with main.ts's per-document disposers so a
 * close-file → reopen cycle doesn't accumulate listeners (each pinning its
 * closed document's store and DOM).
 *
 * `index` is owned by the caller (main.ts passes `pm.searchIndex`, the same
 * instance ui/panes.ts already builds and keeps invalidated for the
 * backlinks chips) rather than built here — a second independent
 * `SearchIndex` would duplicate every team's cached candidates/backlinks and
 * its own store.subscribe just to stay in sync with the one panes.ts already
 * maintains.
 */
export function mountSearch(
  shell: Shell,
  store: Store,
  pm: PaneManager,
  switchTeam: (teamId: string) => void,
  index: SearchIndex
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
    autocomplete: 'off',
  }) as HTMLInputElement

  const checkbox = el('input', { type: 'checkbox' }) as HTMLInputElement
  const checkboxLabelText = el('span', {}, t(localeNow(), 'search_all_teams'))
  const checkboxLabel = el('label', { class: 'tt-search-all-teams' }, checkbox, ' ', checkboxLabelText)

  const clearBtn = el(
    'button',
    {
      type: 'button',
      class: 'tt-search-clear-btn',
      title: t(localeNow(), 'search_clear_title'),
      onclick: () => {
        input.value = ''
        updateClearBtn()
        results = []
        closeDropdown()
        input.focus()
      },
    },
    '×'
  )
  function updateClearBtn(): void {
    clearBtn.classList.toggle('visible', input.value.length > 0)
  }
  updateClearBtn()

  // Header-adjacent text captured at mount time would otherwise stay stale
  // after a locale switch (see prefs.ts's LOCALE_CHANGED_EVENT comment) —
  // refresh it live instead of waiting for the next remount.
  const unsubscribeLocale = onLocaleChanged(() => {
    const lc = localeNow()
    input.placeholder = t(lc, 'search_placeholder')
    checkboxLabelText.textContent = t(lc, 'search_all_teams')
    clearBtn.title = t(lc, 'search_clear_title')
    if (open) renderList()
  })
  // Nothing to search until a team exists, and an input that can't return a
  // result shouldn't invite typing — the first-run screen showed a live
  // search box above an empty canvas. Driven by onMutate rather than
  // subscribe() so creating the first team (a content mutation) and any
  // later team delete both reach it.
  function syncEnabled(): void {
    const empty = store.doc.teams.length === 0
    input.disabled = empty
    wrap.classList.toggle('tt-search-disabled', empty)
  }

  const listEl = el('div', { class: 'tt-search-list' })
  const dropdown = el('div', { class: 'tt-search-dropdown' }, checkboxLabel, listEl)
  const inputBox = el('div', { class: 'tt-search-input-box' }, input, clearBtn)
  const wrap = el('div', { class: 'tt-search-wrap' }, inputBox, dropdown)
  shell.headerLeft.appendChild(wrap)
  syncEnabled()
  const unsubscribeMutate = store.onMutate(() => syncEnabled())

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
    results = index.search(q, scope)
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
      const itemId = 'itemId' in ref ? ref.itemId : undefined
      // No-op for modules that don't listen (action-items, daily/person notes).
      // For milestones/risks, this expands the matching row (if collapsed)
      // before the anchor lookup below, so its follow-up text is in the DOM
      // to highlight.
      if (itemId) dispatchSearchFocusItem(paneEl, itemId)
      const anchors = itemId
        ? Array.from(paneEl.querySelectorAll<HTMLElement>(`[data-item-id="${itemId}"]`))
        : []
      // anchors[0], not a range-derived position, is the scroll target: we
      // already know exactly which element this result belongs to, and that
      // must win even if none of its *currently visible* text matches (e.g.
      // an action item's notes field, which only exists in its edit modal).
      applySearchHighlight(anchors.length > 0 ? anchors : [paneEl], terms, anchors[0])
    })
  }

  checkbox.addEventListener('change', () => {
    allTeams = checkbox.checked
    runSearch()
  })

  input.addEventListener('input', () => {
    updateClearBtn()
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
    // Both Ctrl+F combos steal focus into the search box — must not do that
    // out from under an open modal (a password prompt, preferences, ...).
    // Unlike hotkeyAllowed, these deliberately still fire while typing
    // elsewhere (e.g. in the rich-text editor) — that's the whole point of
    // the shortcut — so only the modal check applies, not the field one.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && matchKey(e, 'f')) {
      if (blockedByModal()) return
      e.preventDefault()
      checkbox.checked = true
      allTeams = true
      input.focus()
      input.select()
      runSearch()
      return
    }
    if ((e.ctrlKey || e.metaKey) && matchKey(e, 'f')) {
      if (blockedByModal()) return
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
    unsubscribeMutate()
    document.removeEventListener('keydown', onDocKeydown)
    document.removeEventListener('mousedown', onDocMousedown)
    wrap.remove()
  }
}
