// src/ui/sidebar.ts
import type { Store } from '../core/store'
import type { Shell } from './shell'
import type { PaneManager } from './panes'
import { invalidateUnsplitStash } from './panes'
import type { Loc, Team } from '../core/types'
import { lastLocForTeam } from '../core/nav'
import { t, todayIso, type Locale } from '../core/i18n'
import { collectDueItems, type DueBuckets } from '../core/due'
import { createEmptyTeam } from '../core/document'
import { el, bindOutsideDismiss } from './dom'
import { showModal, confirmDelete, type ModalButton, type ModalHandle } from './modal'
import { attachEmojiPicker } from './emoji-picker'
import { paintSelection, clampMove, selectableRowProps } from './select-list'
import { openDuePanel } from './due-panel'

export interface SidebarActions {
  selectTeam(id: string): void
  /**
   * Re-renders the pane view (main.ts wires this to `pm.renderAll()`).
   * Deleting a team can invalidate what's currently shown — the last team
   * gone means the "no teams" CTA should replace the pane grid entirely —
   * but `store.update()` alone never re-renders panes (that would blow away
   * an in-progress edit's caret on every keystroke elsewhere in the app);
   * `deleteTeam` calls this explicitly right after its nav fixup so the
   * visible pane view actually reflects the new team list.
   */
  renderPanes(): void
}

/**
 * Task 3: the empty-pane CTA (panes.ts, rendered when `store.doc.teams` is
 * empty) has no reach into sidebar internals like `openAddModal`, so it
 * dispatches this document-level event instead. Exported so panes.ts can
 * reference the same string without either module reaching into the other's
 * implementation.
 */
export const ADD_TEAM_REQUEST_EVENT = 'tt-add-team-request'

export interface SidebarHandle {
  /**
   * Driven by the responsive-layout ResizeObserver (src/ui/responsive.ts):
   * forces the sidebar hidden when the window is too narrow, independent of
   * (and without persisting over) the user's own manual collapse preference
   * (`nav.sidebarCollapsed`). Purely transient — never written to the doc,
   * so a resize alone never marks the file dirty.
   */
  setSpaceConstrained(hidden: boolean): void
}

export function mountSidebar(shell: Shell, store: Store, pm: PaneManager, actions: SidebarActions): SidebarHandle {
  let dragSrcIndex: number | null = null
  // Transient, in-memory only (see SidebarHandle.setSpaceConstrained) — not
  // part of Doc, so it never persists and never marks the file dirty.
  let spaceHidden = false

  function locale(): Locale {
    return store.doc.prefs.locale
  }

  function effectivelyCollapsed(): boolean {
    return store.doc.nav.sidebarCollapsed || spaceHidden
  }

  /**
   * Manual click always reflects the user's intent immediately: expanding
   * while the sidebar is only hidden because the window is narrow
   * (spaceHidden) clears that transient override too, so it actually
   * reappears — the next auto-hide only re-fires on a fresh downward width
   * crossing (see responsive.ts). Collapsing always sets the persisted
   * preference, regardless of why it was visible.
   */
  function toggleCollapsed(): void {
    const collapsed = effectivelyCollapsed()
    store.updateNav((d) => {
      d.nav.sidebarCollapsed = !collapsed
    })
    if (collapsed) spaceHidden = false
    renderCollapseState()
  }

  // A small panel glyph (outline + a divider, left cell filled when the
  // sidebar is showing) rather than a directional arrow — the pane bar
  // already uses ◀/▶ for history back/forward, and reusing those here read
  // as "navigate", not "show/hide panel".
  const collapseIcon = el('span', { class: 'tt-sidebar-toggle-icon', 'aria-hidden': 'true' })
  const collapseBtn = el(
    'button',
    { class: 'tt-btn tt-sidebar-toggle', type: 'button', onclick: () => toggleCollapsed() },
    collapseIcon
  )

  // Collapsing the sidebar hides the team list's own emoji+name — the only
  // place that showed which team is active — so the header grows a matching
  // indicator (shell's headerCenter slot) that appears exactly when the
  // sidebar is hidden. Driven from renderCollapseState() since that's the
  // one choke point every path that can change "is the sidebar visible"
  // already runs through (manual toggle, responsive auto-hide, and the
  // generic render() below). It doubles as the team switcher's trigger
  // (openTeamSwitcher() below) — with the sidebar's own team list hidden,
  // this pill is the only way left to change teams without a hotkey.
  const headerTeamIndicatorLabel = el('span', { class: 'tt-header-team-indicator-label' })
  const headerTeamIndicatorCaret = el('span', { class: 'tt-header-team-indicator-caret', 'aria-hidden': 'true' })
  headerTeamIndicatorCaret.innerHTML =
    '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>'
  const headerTeamIndicator = el(
    'button',
    { class: 'tt-header-team-indicator', type: 'button', onclick: () => toggleTeamSwitcher() },
    headerTeamIndicatorLabel,
    headerTeamIndicatorCaret
  )

  function renderHeaderTeamIndicator(): void {
    const collapsed = effectivelyCollapsed()
    const team = store.doc.teams.find((tm) => tm.id === store.doc.nav.activeTeamId)
    headerTeamIndicator.classList.toggle('visible', collapsed && !!team)
    headerTeamIndicator.title = t(locale(), 'team_switch_title')
    if (team) headerTeamIndicatorLabel.textContent = team.emoji ? `${team.emoji} ${team.name}` : team.name
    // The pill only exists while the sidebar is hidden — if a resize or the
    // manual toggle just brought the sidebar back, a switcher left open
    // would float over nothing, anchored to a button that's no longer shown.
    if (!collapsed) closeTeamSwitcher()
  }

  function renderCollapseState(): void {
    const collapsed = effectivelyCollapsed()
    shell.sidebar.dataset.collapsed = String(collapsed)
    collapseIcon.innerHTML = collapsed
      ? '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M6.25 2.5V13.5"/></svg>'
      : '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M6.25 2.5V13.5"/><rect x="1.5" y="2.5" width="4.75" height="11" rx="1" fill="currentColor" opacity=".4" stroke="none"/></svg>'
    collapseBtn.title = t(locale(), collapsed ? 'sidebar_expand_title' : 'sidebar_collapse_title')
    renderHeaderTeamIndicator()
  }

  function setSpaceConstrained(hidden: boolean): void {
    if (spaceHidden === hidden) return
    spaceHidden = hidden
    renderCollapseState()
  }

  // --- header team switcher: a dropdown opened from headerTeamIndicator,
  // letting the collapsed header pick a team the same way the sidebar's own
  // team list would (row layout intentionally mirrors it — num/emoji/name/
  // due-badge — see the shared .tt-team-num/.tt-team-emoji/.tt-team-name/
  // .tt-team-due-badge classes in styles.css). Structurally modeled on
  // showContextMenu() (context-menu.ts): a fixed-position overlay appended to
  // <body>, dismissed via bindOutsideDismiss (outside click or Escape) —
  // plus arrow-key/Enter navigation via select-list.ts, matching every other
  // dropdown list widget in this app (palette, @ autocomplete, template
  // picker).
  let switcherEl: HTMLElement | null = null
  let switcherListEl: HTMLElement | null = null
  let switcherTeams: Team[] = []
  let switcherSelected = 0
  let unbindSwitcherDismiss: (() => void) | null = null

  function onSwitcherKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      switcherSelected = clampMove(switcherSelected, e.key === 'ArrowDown' ? 1 : -1, switcherTeams.length)
      paintSelection(switcherListEl, '.tt-team-switcher-item', switcherSelected)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      pickSwitcherTeam(switcherTeams[switcherSelected])
    }
  }

  function pickSwitcherTeam(team: Team | undefined): void {
    if (!team) return
    closeTeamSwitcher()
    if (team.id !== store.doc.nav.activeTeamId) actions.selectTeam(team.id)
  }

  function closeTeamSwitcher(): void {
    if (!switcherEl) return
    switcherEl.remove()
    switcherEl = null
    switcherListEl = null
    unbindSwitcherDismiss?.()
    unbindSwitcherDismiss = null
    document.removeEventListener('keydown', onSwitcherKeydown, true)
  }

  function openTeamSwitcher(): void {
    if (store.doc.teams.length === 0) return
    switcherTeams = store.doc.teams
    const buckets = dueBuckets()
    const teamDueCounts = teamDueCountsMap(buckets)
    switcherSelected = Math.max(0, switcherTeams.findIndex((tm) => tm.id === store.doc.nav.activeTeamId))
    switcherListEl = el('div', { class: 'tt-team-switcher-list' })
    switcherTeams.forEach((team, index) => {
      const dueCount = teamDueCounts.get(team.id) ?? 0
      const row = el(
        'div',
        {
          ...selectableRowProps({
            class: 'tt-team-switcher-item' + (team.id === store.doc.nav.activeTeamId ? ' active' : ''),
            selected: index === switcherSelected,
            onCommit: () => pickSwitcherTeam(team),
            onHover: () => { switcherSelected = index; paintSelection(switcherListEl, '.tt-team-switcher-item', switcherSelected) },
          }),
          ...(index < 9 ? { title: t(locale(), 'team_alt_hint') } : {}),
        },
        el('span', { class: 'tt-team-num' }, String(index + 1)),
        el('span', { class: 'tt-team-emoji' }, team.emoji),
        el('span', { class: 'tt-team-name' }, team.name),
        ...(dueCount > 0
          ? [
              el(
                'span',
                {
                  class: 'tt-team-due-badge',
                  onclick: (e: Event) => {
                    e.stopPropagation()
                    closeTeamSwitcher()
                    openDuePanel({ locale: locale(), buckets: dueBuckets(), teamId: team.id, teamName: team.name, onOpenItem })
                  },
                },
                String(dueCount)
              ),
            ]
          : [])
      )
      switcherListEl!.appendChild(row)
    })
    switcherEl = el('div', { class: 'tt-team-switcher-dropdown' }, switcherListEl)
    document.body.appendChild(switcherEl)
    const rect = headerTeamIndicator.getBoundingClientRect()
    switcherEl.style.left = `${rect.left}px`
    switcherEl.style.top = `${rect.bottom + 4}px`
    unbindSwitcherDismiss = bindOutsideDismiss(
      (target) => !switcherEl!.contains(target) && !headerTeamIndicator.contains(target),
      closeTeamSwitcher
    )
    document.addEventListener('keydown', onSwitcherKeydown, true)
  }

  function toggleTeamSwitcher(): void {
    if (switcherEl) {
      closeTeamSwitcher()
      return
    }
    openTeamSwitcher()
  }

  const contentEl = el('div', { class: 'tt-sidebar-content' })
  const listEl = el('div', { class: 'tt-team-list' })
  const addBtn = el(
    'button',
    {
      class: 'tt-btn tt-team-add-btn',
      type: 'button',
      title: t(locale(), 'team_add_title'),
      onclick: () => openAddModal(),
    },
    '➕'
  )

  const dueBadgeEl = el('span', { class: 'tt-due-badge' })
  const dueBtn = el(
    'button',
    {
      class: 'tt-btn tt-due-btn', type: 'button', title: t(locale(), 'due_badge_title'),
      onclick: () => openDuePanel({ locale: locale(), buckets: dueBuckets(), onOpenItem }),
    },
    '⏰', dueBadgeEl
  )

  /**
   * Due buckets are recomputed only when content actually changed (cache
   * cleared in the store.subscribe handler below) or the calendar day rolled
   * over — nav-only re-renders (team switch, active-highlight moves) reuse
   * the cached scan instead of re-walking every team's items.
   */
  let dueCache: { today: string; buckets: DueBuckets } | null = null
  function dueBuckets(): DueBuckets {
    const today = todayIso()
    if (!dueCache || dueCache.today !== today) {
      dueCache = { today, buckets: collectDueItems(store.doc, today) }
    }
    return dueCache.buckets
  }

  function teamDueCountsMap(buckets: DueBuckets): Map<string, number> {
    const counts = new Map<string, number>()
    for (const it of [...buckets.overdue, ...buckets.dueSoon]) {
      counts.set(it.loc.teamId, (counts.get(it.loc.teamId) ?? 0) + 1)
    }
    return counts
  }

  function onOpenItem(loc: Loc): void {
    if (loc.teamId !== store.doc.nav.activeTeamId) actions.selectTeam(loc.teamId)
    pm.openInFocused(loc)
  }

  function renderDueBadge(buckets: DueBuckets): void {
    const total = buckets.overdue.length + buckets.dueSoon.length
    dueBadgeEl.textContent = total > 0 ? String(total) : ''
    dueBtn.classList.toggle('tt-due-empty', total === 0)
    dueBtn.classList.toggle('has-overdue', buckets.overdue.length > 0)
    dueBtn.classList.toggle('has-due-soon', buckets.overdue.length === 0 && buckets.dueSoon.length > 0)
  }

  shell.sidebar.innerHTML = ''
  contentEl.append(dueBtn, listEl, addBtn)
  shell.sidebar.append(contentEl)
  // Lives in the header, not the sidebar itself, so collapsing the sidebar
  // frees its full width instead of reserving room for the toggle.
  shell.headerLeft.prepend(collapseBtn)
  shell.headerCenter.appendChild(headerTeamIndicator)
  renderCollapseState()

  function clearDragOverClasses(): void {
    listEl.querySelectorAll('.tt-team-item').forEach((n) => {
      n.classList.remove('drag-over-top', 'drag-over-bottom')
    })
  }

  function reorder(srcIndex: number, dropIndex: number, after: boolean): void {
    const targetIndex = dropIndex + (after ? 1 : 0)
    if (targetIndex === srcIndex || targetIndex === srcIndex + 1) return
    store.update((d) => {
      const moved = d.teams.splice(srcIndex, 1)[0]
      if (!moved) return
      let insertAt = targetIndex
      if (srcIndex < targetIndex) insertAt -= 1
      d.teams.splice(insertAt, 0, moved)
    })
  }

  function deleteTeam(teamId: string): void {
    store.update((d) => {
      const idx = d.teams.findIndex((tm) => tm.id === teamId)
      if (idx === -1) return
      d.teams.splice(idx, 1)
      delete d.nav.teamSplit[teamId]
      // "Next" team: whichever team now sits at the deleted one's old index
      // (i.e. its former next sibling), or the previous one if it was last,
      // or null if the team list is now empty.
      const nextTeamId = d.teams[idx]?.id ?? d.teams[idx - 1]?.id ?? null
      if (d.nav.activeTeamId === teamId) {
        d.nav.activeTeamId = nextTeamId
        if (nextTeamId) d.nav.split = d.nav.teamSplit[nextTeamId] ?? false
      }
      for (const pane of d.nav.panes) {
        const current = pane.index >= 0 ? pane.history[pane.index] : undefined
        pane.history = pane.history.filter((loc) => loc.teamId !== teamId)
        if (current && current.teamId !== teamId) {
          // Current entry survives the filter (same object reference), but
          // entries deleted from earlier in the history may have shifted
          // its position — re-locate it instead of reusing the old index.
          pane.index = pane.history.indexOf(current)
          continue
        }
        // This pane was showing the deleted team (or had nothing open):
        // land it on the newly active team's own most recent Loc in *this*
        // pane's history — i.e. the module it last had open for that team —
        // falling back to today's daily notes if this pane never had that
        // team open before.
        if (!nextTeamId) {
          pane.index = pane.history.length - 1 // no teams left; history is empty
          continue
        }
        const lastForNext = lastLocForTeam(pane, nextTeamId)
        if (lastForNext) {
          pane.index = pane.history.indexOf(lastForNext)
        } else {
          const fallback: Loc = { teamId: nextTeamId, ref: { kind: 'daily', date: todayIso() } }
          pane.history.push(fallback)
          pane.index = pane.history.length - 1
        }
      }
    })
    invalidateUnsplitStash(store) // deleted team's history may be what an unsplit stash is holding onto
    actions.renderPanes()
  }

  function render(): void {
    listEl.innerHTML = ''
    // Static chrome tooltips are re-stamped here so a locale change (a store
    // update like any other) refreshes them through the same render path.
    addBtn.title = t(locale(), 'team_add_title')
    dueBtn.title = t(locale(), 'due_badge_title')
    renderCollapseState()
    const buckets = dueBuckets()
    renderDueBadge(buckets)
    const teamDueCounts = teamDueCountsMap(buckets)
    store.doc.teams.forEach((team, index) => {
      const isActive = store.doc.nav.activeTeamId === team.id
      const item = el('div', {
        class: 'tt-team-item' + (isActive ? ' active' : ''),
        draggable: 'true',
        'data-index': String(index),
        ...(index < 9 ? { title: t(locale(), 'team_alt_hint') } : {}),
      })
      const numEl = el('span', { class: 'tt-team-num' }, String(index + 1))
      const emojiEl = el('span', { class: 'tt-team-emoji' }, team.emoji)
      const nameEl = el('span', { class: 'tt-team-name' }, team.name)
      const dueCount = teamDueCounts.get(team.id) ?? 0
      const teamDueBadgeEl = dueCount > 0
        ? el(
            'span',
            {
              class: 'tt-team-due-badge',
              onclick: (e: Event) => {
                e.stopPropagation()
                openDuePanel({ locale: locale(), buckets: dueBuckets(), teamId: team.id, teamName: team.name, onOpenItem })
              },
            },
            String(dueCount)
          )
        : null
      const editBtn = el(
        'button',
        {
          class: 'tt-btn tt-team-edit-btn',
          type: 'button',
          title: t(locale(), 'team_edit_title'),
          onclick: (e: Event) => {
            e.stopPropagation()
            openEditModal(team)
          },
        },
        '✎'
      )
      item.append(numEl, emojiEl, nameEl, ...(teamDueBadgeEl ? [teamDueBadgeEl] : []), editBtn)

      item.addEventListener('click', () => {
        actions.selectTeam(team.id)
      })

      item.addEventListener('dragstart', (e) => {
        dragSrcIndex = index
        const dt = (e as DragEvent).dataTransfer
        if (dt) {
          dt.setData('text/plain', String(index))
          dt.effectAllowed = 'move'
        }
      })
      item.addEventListener('dragover', (e) => {
        e.preventDefault()
        if (dragSrcIndex === null) return
        clearDragOverClasses()
        const rect = item.getBoundingClientRect()
        const after = (e as DragEvent).clientY - rect.top > rect.height / 2
        item.classList.add(after ? 'drag-over-bottom' : 'drag-over-top')
      })
      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over-top', 'drag-over-bottom')
      })
      item.addEventListener('drop', (e) => {
        e.preventDefault()
        clearDragOverClasses()
        if (dragSrcIndex === null) return
        const rect = item.getBoundingClientRect()
        const after = (e as DragEvent).clientY - rect.top > rect.height / 2
        const srcIndex = dragSrcIndex
        dragSrcIndex = null
        reorder(srcIndex, index, after)
      })
      item.addEventListener('dragend', () => {
        dragSrcIndex = null
        clearDragOverClasses()
      })

      listEl.appendChild(item)
    })
  }

  function buildTeamForm(initial?: { name: string; emoji: string }): {
    nameInput: HTMLInputElement
    emojiInput: HTMLInputElement
    errorEl: HTMLElement
    body: HTMLElement
    picker: ReturnType<typeof attachEmojiPicker>
  } {
    const nameInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-team-name', value: initial?.name ?? '' }) as HTMLInputElement
    // No maxlength: it counts UTF-16 code units, which both lets two simple
    // emojis through and blocks single ZWJ emojis — attachEmojiPicker
    // enforces "exactly one grapheme" on input instead.
    const emojiInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-team-emoji', value: initial?.emoji ?? '' }) as HTMLInputElement
    const errorEl = el('div', { class: 'tt-field-error' })
    const body = el(
      'div',
      { class: 'tt-team-form' },
      el('label', { class: 'tt-field' }, t(locale(), 'team_name_label'), nameInput),
      el('label', { class: 'tt-field' }, t(locale(), 'team_emoji_label'), emojiInput),
      errorEl
    )
    const picker = attachEmojiPicker(emojiInput, locale())
    return { nameInput, emojiInput, errorEl, body, picker }
  }

  function openAddModal(): void {
    const { nameInput, emojiInput, errorEl, body, picker } = buildTeamForm()

    const cancelBtn: ModalButton = { label: t(locale(), 'cancel'), onClick: () => handle.close() }
    const okBtn: ModalButton = {
      label: t(locale(), 'ok'),
      primary: true,
      onClick: () => {
        const name = nameInput.value.trim()
        if (!name) {
          errorEl.textContent = t(locale(), 'team_name_required')
          return
        }
        const emoji = emojiInput.value.trim()
        const newTeamId = crypto.randomUUID()
        store.update((d) => {
          d.teams.push(createEmptyTeam(newTeamId, name, emoji, locale()))
        })
        handle.close()
        actions.selectTeam(newTeamId)
      },
    }
    const handle: ModalHandle = showModal({
      title: t(locale(), 'team_add_title'), body, buttons: [cancelBtn, okBtn],
      onClose: () => picker.dispose(),
    })
    nameInput.focus()
  }

  function openEditModal(team: Team): void {
    const { nameInput, emojiInput, errorEl, body, picker } = buildTeamForm({ name: team.name, emoji: team.emoji })

    const cancelBtn: ModalButton = { label: t(locale(), 'cancel'), onClick: () => handle.close() }
    const deleteBtn: ModalButton = {
      label: t(locale(), 'team_delete_btn'),
      onClick: () => {
        handle.close()
        confirmDelete(locale(), {
          title: t(locale(), 'team_delete_title'),
          message: t(locale(), 'team_delete_confirm', { name: team.name }),
          confirmLabel: t(locale(), 'team_delete_btn'),
          onConfirm: () => deleteTeam(team.id),
        })
      },
    }
    const saveBtn: ModalButton = {
      label: t(locale(), 'ok'),
      primary: true,
      onClick: () => {
        const name = nameInput.value.trim()
        if (!name) {
          errorEl.textContent = t(locale(), 'team_name_required')
          return
        }
        const emoji = emojiInput.value.trim() || team.emoji
        store.update((d) => {
          const target = d.teams.find((tm) => tm.id === team.id)
          if (target) {
            target.name = name
            target.emoji = emoji
          }
        })
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({
      title: t(locale(), 'team_edit_title'), body, buttons: [cancelBtn, deleteBtn, saveBtn],
      onClose: () => picker.dispose(),
    })
    nameInput.focus()
  }

  render()
  store.subscribe(() => {
    dueCache = null // content changed — due data may have too
    render()
  })
  // Nav-only changes (store.updateNav — team switch, Alt+1..9, pane history)
  // don't fire subscribe() above, but do need the active-team highlight to
  // update. onMutate() fires on both update() and updateNav(); re-running
  // render() an extra time on a content change (already covered by
  // subscribe() above) is a harmless idempotent DOM rebuild — cheaper than
  // hand-rolling a second nav-only event channel, and it's exactly the
  // "generalize the mechanism" fix core/save-controller.ts already made for
  // its own dirty-guard (see that file's comment on onMutate()). Content
  // changes must NOT reset dueCache here too, or every pane navigation would
  // force a full due-items rescan for no reason — that stays only in the
  // subscribe() callback above.
  //
  // Load-bearing detail: store.replaceDoc() (used by the conflict-modal
  // reload path in main.ts's onReload handler) fires subscribe() listeners
  // but NOT onMutate() listeners — so it's the store.subscribe() render
  // above, not this onMutate() one, that keeps the sidebar in sync after a
  // reload. Don't collapse these two registrations into just onMutate().
  store.onMutate(() => render())
  document.addEventListener(ADD_TEAM_REQUEST_EVENT, () => openAddModal())

  return { setSpaceConstrained }
}
