// src/ui/sidebar.ts
import type { Store } from '../core/store'
import type { Shell } from './shell'
import type { Team } from '../core/types'
import { t, type Locale } from '../core/i18n'
import { el } from './dom'
import { showModal, type ModalButton, type ModalHandle } from './modal'
import { attachEmojiPicker } from './emoji-picker'

export interface SidebarActions {
  selectTeam(id: string): void
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

export function mountSidebar(shell: Shell, store: Store, actions: SidebarActions): void {
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
    '+'
  )

  shell.sidebar.innerHTML = ''
  shell.sidebar.append(listEl, addBtn)

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
      if (d.nav.activeTeamId === teamId) {
        d.nav.activeTeamId = d.teams[0]?.id ?? null
      }
      for (const pane of d.nav.panes) {
        const current = pane.index >= 0 ? pane.history[pane.index] : undefined
        pane.history = pane.history.filter((loc) => loc.teamId !== teamId)
        if (!current || current.teamId === teamId) {
          // Current entry belonged to the deleted team (or there was none):
          // fall back to the last remaining entry, or -1 when empty.
          pane.index = pane.history.length - 1
        } else {
          // Current entry survives the filter (same object reference), but
          // entries deleted from earlier in the history may have shifted
          // its position — re-locate it instead of reusing the old index.
          pane.index = pane.history.indexOf(current)
        }
      }
    })
  }

  function render(): void {
    listEl.innerHTML = ''
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
      const hotkeyEl = index < 9 ? el('span', { class: 'tt-team-hotkey' }, `Alt+${index + 1}`) : null
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
      item.append(numEl, emojiEl, nameEl, ...(hotkeyEl ? [hotkeyEl] : []), editBtn)

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
    const emojiInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-team-emoji', maxlength: '4' })
    const errorEl = el('div', { class: 'tt-field-error' })
    const body = el(
      'div',
      { class: 'tt-team-form' },
      el('label', { class: 'tt-field' }, t(locale(), 'team_name_label'), nameInput),
      el('label', { class: 'tt-field' }, t(locale(), 'team_emoji_label'), emojiInput),
      errorEl
    )
    const picker = attachEmojiPicker(emojiInput, locale())

    let handle: ModalHandle
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
        const emoji = emojiInput.value.trim() || '🙂'
        store.update((d) => {
          const team = emptyTeam(crypto.randomUUID(), name, emoji)
          d.teams.push(team)
          if (d.nav.activeTeamId === null) d.nav.activeTeamId = team.id
        })
        picker.dispose()
        handle.close()
      },
    }
    handle = showModal({ title: t(locale(), 'team_add_title'), body, buttons: [cancelBtn, okBtn] })
    nameInput.focus()
  }

  function openEditModal(team: Team): void {
    const nameInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-team-name' })
    nameInput.value = team.name
    const emojiInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-team-emoji', maxlength: '4' })
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

    let handle: ModalHandle
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
    handle = showModal({ title: t(locale(), 'team_edit_title'), body, buttons: [cancelBtn, deleteBtn, saveBtn] })
    nameInput.focus()
  }

  function openDeleteConfirm(team: Team): void {
    const message = t(locale(), 'team_delete_confirm', { name: team.name })
    const body = el('p', { class: 'tt-modal-message' }, message)
    let handle: ModalHandle
    const cancelBtn: ModalButton = { label: t(locale(), 'cancel'), onClick: () => handle.close() }
    const confirmBtn: ModalButton = {
      label: t(locale(), 'team_delete_btn'),
      primary: true,
      onClick: () => {
        deleteTeam(team.id)
        handle.close()
      },
    }
    handle = showModal({ title: t(locale(), 'team_delete_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  render()
  store.subscribe(render)
  document.addEventListener(NAV_CHANGED_EVENT, render)
  document.addEventListener(ADD_TEAM_REQUEST_EVENT, () => openAddModal())
}
