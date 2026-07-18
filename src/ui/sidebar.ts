// src/ui/sidebar.ts
import type { Store } from '../core/store'
import type { Shell } from './shell'
import type { PaneManager } from './panes'
import type { Loc, Team } from '../core/types'
import { lastLocForTeam } from '../core/nav'
import { t, todayIso, formatDate, type Locale } from '../core/i18n'
import { collectDueItems, type DueBuckets, type DueItem } from '../core/due'
import { el } from './dom'
import { showModal, type ModalButton, type ModalHandle } from './modal'
import { attachEmojiPicker } from './emoji-picker'

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
 * `Store.updateNav()` intentionally does not notify `store.subscribe()`
 * listeners (see store.ts) — nav-only changes are meant to be cheap and not
 * trigger a full content re-render. The sidebar's active-team highlight is
 * nav state though, so `selectTeam()` (in main.ts) dispatches this DOM event
 * after every `updateNav()` call, and the sidebar listens for it. This keeps
 * the highlight in sync for both sidebar clicks and the global Alt+1..9
 * hotkey without coupling main.ts to sidebar internals or widening the
 * Store contract.
 */
const NAV_CHANGED_EVENT = 'tt-nav-changed'

export function notifyNavChanged(): void {
  document.dispatchEvent(new CustomEvent(NAV_CHANGED_EVENT))
}

/**
 * Task 25: lets main.ts trigger a save on module/team navigation without
 * reaching into PaneManager internals — every nav change already calls
 * `notifyNavChanged()` above, so this is just a public subscribe point for
 * that same event (mirrors `onLocaleChanged` in ui/prefs.ts).
 *
 * Returns an unsubscribe function (Task 25 re-review item #4c) so callers
 * that need a full teardown path — main.ts's dispose, going forward — can
 * remove the listener instead of leaking it for the lifetime of the
 * document. Existing callers that ignore the return value are unaffected.
 */
export function onNavChanged(cb: () => void): () => void {
  document.addEventListener(NAV_CHANGED_EVENT, cb)
  return () => {
    document.removeEventListener(NAV_CHANGED_EVENT, cb)
  }
}

/**
 * Task 3: the empty-pane CTA (panes.ts, rendered when `store.doc.teams` is
 * empty) has no reach into sidebar internals like `openAddModal`, so it
 * dispatches this document-level event instead — mirrors `NAV_CHANGED_EVENT`
 * above. Exported so panes.ts can reference the same string without either
 * module reaching into the other's implementation.
 */
export const ADD_TEAM_REQUEST_EVENT = 'tt-add-team-request'

function emptyTeam(id: string, name: string, emoji: string): Team {
  return {
    id, name, emoji,
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: {},
  }
}

export function mountSidebar(shell: Shell, store: Store, pm: PaneManager, actions: SidebarActions): void {
  let dragSrcIndex: number | null = null

  function locale(): Locale {
    return store.doc.prefs.locale
  }

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
    { class: 'tt-btn tt-due-btn', type: 'button', title: t(locale(), 'due_badge_title'), onclick: () => openDueModal() },
    '⏰', dueBadgeEl
  )

  function diffDays(later: string, earlier: string): number {
    const [ly, lm, ld] = later.split('-').map(Number) as [number, number, number]
    const [ey, em, ed] = earlier.split('-').map(Number) as [number, number, number]
    const a = Date.UTC(ly, lm - 1, ld)
    const b = Date.UTC(ey, em - 1, ed)
    return Math.round((a - b) / 86400000)
  }

  function relLabel(dateIso: string): string {
    const today = todayIso()
    if (dateIso < today) return t(locale(), 'due_overdue_by', { days: String(diffDays(today, dateIso)) })
    return t(locale(), 'due_in_days', { days: String(diffDays(dateIso, today)) })
  }

  function renderDueRow(item: DueItem, handleRef: { current: ModalHandle | null }): HTMLElement {
    const icon = item.kind === 'action' ? '✅' : '🚩'
    return el(
      'div',
      {
        class: 'tt-due-row',
        onclick: () => {
          handleRef.current?.close()
          if (item.loc.teamId !== store.doc.nav.activeTeamId) actions.selectTeam(item.loc.teamId)
          pm.openInFocused(item.loc)
        },
      },
      el('span', { class: 'tt-due-row-icon' }, icon),
      el('span', { class: 'tt-due-row-title' }, item.title),
      el('span', { class: 'tt-due-row-team' }, item.teamName),
      el('span', { class: 'tt-due-row-date' }, `${formatDate(item.date, locale())} · ${relLabel(item.date)}`)
    )
  }

  function openDueModal(): void {
    const buckets = collectDueItems(store.doc, todayIso())
    const handleRef: { current: ModalHandle | null } = { current: null }
    const sections: HTMLElement[] = []
    if (buckets.overdue.length + buckets.dueSoon.length === 0) {
      sections.push(el('p', { class: 'tt-modal-message' }, t(locale(), 'due_empty')))
    } else {
      if (buckets.overdue.length > 0) {
        sections.push(el('div', { class: 'tt-due-section-heading' }, t(locale(), 'due_section_overdue')))
        sections.push(...buckets.overdue.map((it) => renderDueRow(it, handleRef)))
      }
      if (buckets.dueSoon.length > 0) {
        sections.push(el('div', { class: 'tt-due-section-heading' }, t(locale(), 'due_section_due_soon')))
        sections.push(...buckets.dueSoon.map((it) => renderDueRow(it, handleRef)))
      }
    }
    const body = el('div', { class: 'tt-due-list' }, ...sections)
    const closeBtn: ModalButton = { label: t(locale(), 'ok'), primary: true, onClick: () => handleRef.current?.close() }
    handleRef.current = showModal({ title: t(locale(), 'due_panel_title'), body, buttons: [closeBtn] })
  }

  function renderDueBadge(buckets: DueBuckets): void {
    const total = buckets.overdue.length + buckets.dueSoon.length
    dueBadgeEl.textContent = total > 0 ? String(total) : ''
    dueBtn.classList.toggle('tt-due-empty', total === 0)
    dueBtn.classList.toggle('has-overdue', buckets.overdue.length > 0)
    dueBtn.classList.toggle('has-due-soon', buckets.overdue.length === 0 && buckets.dueSoon.length > 0)
  }

  shell.sidebar.innerHTML = ''
  shell.sidebar.append(dueBtn, listEl, addBtn)

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
    actions.renderPanes()
    // Deleting a team is destructive and doesn't wait for the auto-save
    // timer or a later nav change — reuse the nav-changed event's existing
    // save hook (main.ts's onNavChanged listener) to persist it right away.
    notifyNavChanged()
  }

  function render(): void {
    listEl.innerHTML = ''
    const buckets = collectDueItems(store.doc, todayIso())
    renderDueBadge(buckets)
    const teamDueCounts = new Map<string, number>()
    for (const it of [...buckets.overdue, ...buckets.dueSoon]) {
      teamDueCounts.set(it.loc.teamId, (teamDueCounts.get(it.loc.teamId) ?? 0) + 1)
    }
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
      const teamDueBadgeEl = dueCount > 0 ? el('span', { class: 'tt-team-due-badge' }, String(dueCount)) : null
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

  function openAddModal(): void {
    const nameInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-team-name' })
    // No maxlength: it counts UTF-16 code units, which both lets two simple
    // emojis through and blocks single ZWJ emojis — attachEmojiPicker
    // enforces "exactly one grapheme" on input instead.
    const emojiInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-team-emoji' })
    const errorEl = el('div', { class: 'tt-field-error' })
    const body = el(
      'div',
      { class: 'tt-team-form' },
      el('label', { class: 'tt-field' }, t(locale(), 'team_name_label'), nameInput),
      el('label', { class: 'tt-field' }, t(locale(), 'team_emoji_label'), emojiInput),
      errorEl
    )
    const picker = attachEmojiPicker(emojiInput, locale())

    const cancelBtn: ModalButton = { label: t(locale(), 'cancel'), onClick: () => { picker.dispose(); handle.close() } }
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
        if (!emoji) {
          errorEl.textContent = t(locale(), 'team_emoji_required')
          return
        }
        const newTeamId = crypto.randomUUID()
        store.update((d) => {
          d.teams.push(emptyTeam(newTeamId, name, emoji))
        })
        picker.dispose()
        handle.close()
        actions.selectTeam(newTeamId)
      },
    }
    const handle: ModalHandle = showModal({ title: t(locale(), 'team_add_title'), body, buttons: [cancelBtn, okBtn] })
    nameInput.focus()
  }

  function openEditModal(team: Team): void {
    const nameInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-team-name' })
    nameInput.value = team.name
    // No maxlength: it counts UTF-16 code units, which both lets two simple
    // emojis through and blocks single ZWJ emojis — attachEmojiPicker
    // enforces "exactly one grapheme" on input instead.
    const emojiInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-team-emoji' })
    emojiInput.value = team.emoji
    const errorEl = el('div', { class: 'tt-field-error' })
    const body = el(
      'div',
      { class: 'tt-team-form' },
      el('label', { class: 'tt-field' }, t(locale(), 'team_name_label'), nameInput),
      el('label', { class: 'tt-field' }, t(locale(), 'team_emoji_label'), emojiInput),
      errorEl
    )
    const picker = attachEmojiPicker(emojiInput, locale())

    const cancelBtn: ModalButton = { label: t(locale(), 'cancel'), onClick: () => { picker.dispose(); handle.close() } }
    const deleteBtn: ModalButton = {
      label: t(locale(), 'team_delete_btn'),
      onClick: () => {
        picker.dispose()
        handle.close()
        openDeleteConfirm(team)
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
        picker.dispose()
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({ title: t(locale(), 'team_edit_title'), body, buttons: [cancelBtn, deleteBtn, saveBtn] })
    nameInput.focus()
  }

  function openDeleteConfirm(team: Team): void {
    const message = t(locale(), 'team_delete_confirm', { name: team.name })
    const body = el('p', { class: 'tt-modal-message' }, message)
    const cancelBtn: ModalButton = { label: t(locale(), 'cancel'), onClick: () => handle.close() }
    const confirmBtn: ModalButton = {
      label: t(locale(), 'team_delete_btn'),
      primary: true,
      onClick: () => {
        deleteTeam(team.id)
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({ title: t(locale(), 'team_delete_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  render()
  store.subscribe(render)
  document.addEventListener(NAV_CHANGED_EVENT, render)
  document.addEventListener(ADD_TEAM_REQUEST_EVENT, () => openAddModal())
}
