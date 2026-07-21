// src/ui/date-picker.ts — replaces native <input type="date"> (Chromium's
// closed-state numeric format follows the browser's own Accept-Language/OS
// setting, never the page's `lang` attribute or the app's locale — confirmed
// empirically, not fixable from web content). The text field is editable —
// typing digits auto-inserts the locale's separators (mask()) and a
// complete, calendar-valid date auto-commits via core/i18n's
// parseLocaleDate(); an incomplete or impossible date (e.g. 02/30) is
// flagged invalid and never reaches getValue()/onChange, so a caller reading
// getValue() to save can never persist garbage. The popover calendar (from
// ui/calendar.ts, already fully locale-driven) is the other way to set a
// value, plus its own Today/Clear date shortcuts.
import { t, formatDate, parseLocaleDate, todayIso, type Locale } from '../core/i18n'
import { createCalendar, type CalendarMarks } from './calendar'
import { el, bindOutsideDismiss } from './dom'

const NO_MARKS: CalendarMarks = { hasNote: () => false, milestones: () => [] }

/** Strips everything but digits, capped at 8 (2+2+4 = DDMMYYYY/MMDDYYYY). */
export function digitsOnly(s: string): string {
  return s.replace(/\D/g, '').slice(0, 8)
}

/** Re-inserts '/' after the 2nd and 4th digit as the user types: "0720" -> "07/20". */
export function maskDateDigits(digits: string): string {
  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
}

export interface DatePickerHandle {
  root: HTMLElement
  getValue(): string
  /** Syncs the displayed value from outside (e.g. external store change) — does not call onChange. */
  setValue(iso: string): void
  destroy(): void
}

export interface DatePickerOptions {
  /** ISO "YYYY-MM-DD", or '' for no date. */
  value: string
  locale: Locale
  /** Shows a "Clear date" button in the popover that commits '' — omit for fields that must always hold a date (e.g. a milestone's date). */
  allowClear?: boolean
  onChange(iso: string): void
}

// Module-level so opening a second picker always closes any popover already
// open — mirrors ui/context-menu.ts's showContextMenu singleton.
let closeCurrentPopover: (() => void) | null = null

export function createDatePicker(opts: DatePickerOptions): DatePickerHandle {
  let value = opts.value

  const input = el('input', {
    type: 'text',
    class: 'tt-date-picker-input tt-input',
    placeholder: t(opts.locale, 'date_picker_placeholder'),
    value: value ? formatDate(value, opts.locale) : '',
  }) as HTMLInputElement

  const root = el('div', { class: 'tt-date-picker' }, input)

  function setInvalid(invalid: boolean): void {
    input.classList.toggle('tt-date-picker-input-invalid', invalid)
    if (invalid) input.setAttribute('aria-invalid', 'true')
    else input.removeAttribute('aria-invalid')
  }

  function commit(iso: string): void {
    value = iso
    input.value = iso ? formatDate(iso, opts.locale) : ''
    setInvalid(false)
    opts.onChange(iso)
  }

  // Auto-masks to locale separators as the user types and, the instant the
  // 8th digit completes a real calendar date, commits immediately — no
  // Enter/blur needed for the success path. An impossible date (wrong digit
  // count doesn't reach here; a real 8-digit string that still fails
  // parseLocaleDate, e.g. 02/30/2026) is flagged invalid and left as typed
  // so the user can see and fix it; `value`/getValue() stay untouched.
  function onInput(): void {
    const digits = digitsOnly(input.value)
    const masked = maskDateDigits(digits)
    if (masked !== input.value) input.value = masked
    if (digits.length < 8) {
      setInvalid(false) // still typing — not a failed attempt yet
      return
    }
    const iso = parseLocaleDate(masked, opts.locale)
    if (iso) commit(iso)
    else setInvalid(true)
  }

  // Runs when the field loses focus with typed text that never resolved to
  // a valid date: an abandoned partial entry, or a complete-but-impossible
  // one. Empty is its own case — clears (if allowed) or reverts to the last
  // committed value, since a field with allowClear unset must always hold
  // a date.
  function onBlur(): void {
    const digits = digitsOnly(input.value)
    if (digits.length === 0) {
      if (opts.allowClear) commit('')
      else {
        input.value = value ? formatDate(value, opts.locale) : ''
        setInvalid(false)
      }
      return
    }
    if (digits.length < 8) setInvalid(true)
    // length === 8 and invalid was already flagged by onInput; nothing new to do.
  }

  let popover: HTMLElement | null = null
  let unbind: (() => void) | null = null

  function closePopover(): void {
    if (!popover) return
    popover.remove()
    unbind?.()
    popover = null
    closeCurrentPopover = null
  }

  function openPopover(): void {
    closeCurrentPopover?.()
    const wrap = el('div', { class: 'tt-date-picker-popover' })
    wrap.appendChild(
      createCalendar({
        selected: value || todayIso(),
        locale: opts.locale,
        marks: NO_MARKS,
        // No input.focus() after picking: the input's own 'focus' listener
        // opens this same popover, so refocusing here would immediately
        // reopen what commit()+closePopover() just closed.
        onPick: (iso) => {
          commit(iso)
          closePopover()
        },
      })
    )
    const actions = el(
      'div',
      { class: 'tt-date-picker-popover-actions' },
      el(
        'button',
        { type: 'button', class: 'tt-btn', onclick: () => { commit(todayIso()); closePopover() } },
        t(opts.locale, 'date_picker_today_btn')
      )
    )
    if (opts.allowClear) {
      actions.appendChild(
        el(
          'button',
          { type: 'button', class: 'tt-btn', onclick: () => { commit(''); closePopover() } },
          t(opts.locale, 'date_picker_clear_btn')
        )
      )
    }
    wrap.appendChild(actions)

    document.body.appendChild(wrap)
    const rect = input.getBoundingClientRect()
    wrap.style.left = `${rect.left}px`
    wrap.style.top = `${rect.bottom + 4}px`
    popover = wrap
    unbind = bindOutsideDismiss((target) => !!popover && !popover.contains(target) && target !== input, closePopover)
    closeCurrentPopover = closePopover
  }

  input.addEventListener('click', openPopover)
  input.addEventListener('focus', openPopover)
  input.addEventListener('input', onInput)
  input.addEventListener('blur', onBlur)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur()
  })

  return {
    root,
    getValue() {
      return value
    },
    setValue(iso: string) {
      value = iso
      input.value = iso ? formatDate(iso, opts.locale) : ''
      setInvalid(false)
    },
    destroy() {
      closePopover()
    },
  }
}
