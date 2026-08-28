// src/ui/person-modal.ts — the shared "name + role" add/edit form, factored
// out of src/modules/people-tree.ts so src/modules/person-notes.ts's header
// edit button can open the exact same dialog. Pure UI: it collects a trimmed
// name (required) and role, then hands them to `onSubmit` — persisting them,
// and picking the store.update scope, is the caller's job.
import { t, type Locale } from '../core/i18n'
import { showModal, type ModalButton, type ModalHandle } from './modal'
import { el } from './dom'

export function openPersonModal(lc: Locale, opts: {
  title: string
  initialName: string
  initialRole: string
  onSubmit: (name: string, role: string) => void
}): void {
  const nameInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-person-name' })
  nameInput.value = opts.initialName
  const roleInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-person-role' })
  roleInput.value = opts.initialRole
  const errorEl = el('div', { class: 'tt-field-error' })
  const body = el(
    'div',
    { class: 'tt-person-form' },
    el('label', { class: 'tt-field' }, t(lc, 'person_name_label'), nameInput),
    el('label', { class: 'tt-field' }, t(lc, 'person_role_label'), roleInput),
    errorEl
  )
  const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
  const okBtn: ModalButton = {
    label: t(lc, 'ok'),
    primary: true,
    onClick: () => {
      const name = nameInput.value.trim()
      if (!name) {
        errorEl.textContent = t(lc, 'person_name_required')
        return
      }
      opts.onSubmit(name, roleInput.value.trim())
      handle.close()
    },
  }
  const handle: ModalHandle = showModal({ title: opts.title, body, buttons: [cancelBtn, okBtn] })
  nameInput.focus()
}
