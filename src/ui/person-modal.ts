// src/ui/person-modal.ts — the shared "name + role" add/edit form, factored
// out of src/modules/people-tree.ts so src/modules/person-notes.ts's header
// edit button can open the exact same dialog. Pure UI: it collects a trimmed
// name (required) and role, then hands them to `onSubmit` — persisting them,
// and picking the store.update scope, is the caller's job. The edit flow also
// passes `oneOnOne` to add the 1:1 cadence and last-1:1 fields.
import { t, type Locale } from '../core/i18n'
import type { Person, Prefs } from '../core/types'
import { defaultCadenceDays, isCadence, isIsoDate, type PersonGroup } from '../core/cadence'
import { showModal, type ModalButton, type ModalHandle } from './modal'
import { createDatePicker } from './date-picker'
import { clampInt } from './prefs-fields'
import { el } from './dom'

/**
 * What the edit dialog's 1:1 fields hold. `everyDays` undefined = "Default",
 * null = "None", a number = "Custom"; `defaultDays` is what Default means for
 * this person (members follow the preference, stakeholders have none).
 */
export interface OneOnOneFields { everyDays: number | null | undefined; last: string | undefined; defaultDays: number | null }
/** What the dialog hands back: the same two values, ready for `applyCadence`. */
export interface CadenceValues { everyDays: number | null | undefined; last: string | undefined }

/** The dialog's starting 1:1 fields for `person`. A hand-edited value that is not a date or a cadence reads as unset. */
export function personOneOnOne(person: Person, group: PersonGroup, prefs: Prefs): OneOnOneFields {
  const own = person.oneOnOneEveryDays
  return {
    everyDays: own === null || isCadence(own) ? own : undefined,
    last: isIsoDate(person.lastOneOnOne) ? person.lastOneOnOne : undefined,
    defaultDays: defaultCadenceDays(group, prefs),
  }
}

/** Writes the dialog's result onto `person`, deleting a field that went back to Default / no date rather than storing undefined. */
export function applyCadence(person: Person, cadence: CadenceValues | undefined): void {
  if (!cadence) return
  if (cadence.everyDays === undefined) delete person.oneOnOneEveryDays
  else person.oneOnOneEveryDays = cadence.everyDays
  if (cadence.last === undefined || cadence.last === '') delete person.lastOneOnOne
  else person.lastOneOnOne = cadence.last
}

/** Custom cadence when the field is empty or garbage: the value it showed when Custom was picked. */
const FALLBACK_CUSTOM_DAYS = 14

export function openPersonModal(lc: Locale, opts: {
  title: string
  initialName: string
  initialRole: string
  /** Present for the edit dialog only: adds the 1:1 cadence and last-1:1 fields. The add flow omits it. */
  oneOnOne?: OneOnOneFields
  onSubmit: (name: string, role: string, cadence?: CadenceValues) => void
}): void {
  const nameInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-person-name' })
  nameInput.value = opts.initialName
  const roleInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-person-role' })
  roleInput.value = opts.initialRole
  const errorEl = el('div', { class: 'tt-field-error' })

  const oneOnOne = opts.oneOnOne
  let readCadence: (() => CadenceValues) | null = null
  let destroyPicker: (() => void) | null = null
  const cadenceFields: HTMLElement[] = []
  if (oneOnOne) {
    const { everyDays, defaultDays } = oneOnOne
    const defaultLabel = defaultDays === null
      ? t(lc, 'person_cadence_default_none')
      : t(lc, defaultDays === 1 ? 'person_cadence_default_one' : 'person_cadence_default', { n: String(defaultDays) })
    const everySelect = el('select', { class: 'tt-input tt-person-cadence-select' },
      el('option', { value: 'default' }, defaultLabel),
      el('option', { value: 'none' }, t(lc, 'person_cadence_none')),
      el('option', { value: 'custom' }, t(lc, 'person_cadence_custom'))
    )
    everySelect.value = everyDays === undefined ? 'default' : everyDays === null ? 'none' : 'custom'
    const startDays = typeof everyDays === 'number' ? clampInt(everyDays, 1, 365, FALLBACK_CUSTOM_DAYS) : defaultDays ?? FALLBACK_CUSTOM_DAYS
    const daysInput = el('input', { type: 'number', class: 'tt-input tt-person-cadence-days-input', min: '1', max: '365' })
    daysInput.value = String(startDays)
    const daysWrap = el('span', { class: 'tt-person-cadence-days' }, daysInput, t(lc, 'person_cadence_days_unit'))
    const syncDays = (): void => { daysWrap.hidden = everySelect.value !== 'custom' }
    syncDays()
    everySelect.addEventListener('change', syncDays)

    const picker = createDatePicker({ value: oneOnOne.last ?? '', locale: lc, allowClear: true, onChange: () => {} })
    destroyPicker = () => picker.destroy()
    cadenceFields.push(
      el('label', { class: 'tt-field' }, t(lc, 'person_cadence_label'), el('span', { class: 'tt-person-cadence-row' }, everySelect, daysWrap)),
      el('label', { class: 'tt-field' }, t(lc, 'person_last_label'), picker.root)
    )
    readCadence = () => ({
      everyDays: everySelect.value === 'default'
        ? undefined
        : everySelect.value === 'none'
          ? null
          : clampInt(Number(daysInput.value.trim() === '' ? NaN : daysInput.value), 1, 365, startDays),
      last: picker.getValue() || undefined,
    })
  }

  const body = el(
    'div',
    { class: 'tt-person-form' },
    el('label', { class: 'tt-field' }, t(lc, 'person_name_label'), nameInput),
    el('label', { class: 'tt-field' }, t(lc, 'person_role_label'), roleInput),
    ...cadenceFields,
    errorEl
  )
  const cancelBtn: ModalButton = { label: t(lc, 'cancel'), icon: 'close', onClick: () => handle.close() }
  const okBtn: ModalButton = {
    label: t(lc, 'save'),
    primary: true,
    onClick: () => {
      const name = nameInput.value.trim()
      if (!name) {
        errorEl.textContent = t(lc, 'person_name_required')
        return
      }
      if (readCadence) opts.onSubmit(name, roleInput.value.trim(), readCadence())
      else opts.onSubmit(name, roleInput.value.trim())
      handle.close()
    },
  }
  // onClose, not the buttons: Escape and the backdrop close the dialog too, and the picker's popover lives on <body>.
  const handle: ModalHandle = showModal({ title: opts.title, body, buttons: [cancelBtn, okBtn], onClose: () => destroyPicker?.() })
  nameInput.focus()
}
