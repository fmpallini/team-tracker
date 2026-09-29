// src/ui/prefs-fields.ts — the small building blocks the preferences modal
// (ui/prefs.ts) assembles every tab from. They exist so each tab shares one
// type hierarchy (section title > field label > control text > hint) and one
// spacing rhythm instead of each control hand-rolling its own markup; the
// matching CSS lives under "Preferences modal" in styles.css. Pure DOM — no
// i18n, no store — so callers pass already-translated strings and own their
// change handlers.
import { el } from './dom'

/** Rounds `raw` to an integer and clamps it into [min, max]; a non-finite value (empty/garbage input) falls back to `fallback`. */
export function clampInt(raw: number, min: number, max: number, fallback: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(raw) ? Math.round(raw) : fallback))
}

/** A titled group of related fields. Omit `title` for a group that needs spacing but no heading. */
export function prefsSection(title: string | null, ...children: (Node | null)[]): HTMLElement {
  return el('section', { class: 'tt-prefs-section' }, title ? el('h3', { class: 'tt-prefs-section-title' }, title) : null, ...children)
}

/** Secondary explanatory text under a control. */
export function prefsHint(text: string, extraClass = ''): HTMLElement {
  return el('p', { class: extraClass ? `tt-data-hint ${extraClass}` : 'tt-data-hint' }, text)
}

export interface RadioOption {
  value: string
  label: string
  /** CSS font-family applied to the label, so a font option shows itself. */
  preview?: string
  /** CSS font-size (absolute — see prefs.ts) applied to the label, so a size option shows itself. */
  sizePreview?: string
  /** CSS color of a dot rendered before the label. */
  swatch?: string
}

export interface RadioFieldOpts {
  /** Shared `name` of the radio group. */
  name: string
  label: string
  options: readonly RadioOption[]
  current: string
  onChange(value: string): void
  disabled?: boolean
}

/** A labelled row of pill-style radios. */
export function prefsRadioField(opts: RadioFieldOpts): HTMLElement {
  const row = el(
    'div',
    { class: 'tt-prefs-radio-row' },
    ...opts.options.map((opt) => {
      const input = el('input', {
        type: 'radio',
        name: opts.name,
        value: opt.value,
        checked: opt.value === opts.current,
        disabled: opts.disabled ?? false,
        onchange: () => opts.onChange(opt.value),
      })
      // `sizePreview` is an absolute px value on purpose: the modal is
      // already rendered at the *current* preference's root size, so a
      // relative unit would scale every option with it and the five steps
      // would look identical to each other at any setting.
      const text = opt.preview
        ? el('span', { class: 'tt-prefs-radio-preview', style: `font-family:${opt.preview}` }, opt.label)
        : opt.sizePreview
          ? el('span', { class: 'tt-prefs-radio-preview', style: `font-size:${opt.sizePreview}` }, opt.label)
          : opt.label
      const swatch = opt.swatch ? el('span', { class: 'tt-prefs-radio-swatch', style: `background:${opt.swatch}` }) : null
      return el('label', { class: 'tt-prefs-radio' }, input, swatch, text)
    })
  )
  return el('div', { class: 'tt-prefs-field' }, el('div', { class: 'tt-prefs-field-label' }, opts.label), row)
}

export interface CheckboxFieldOpts {
  /** Class on the `<input>` itself — tests and e2e find the control through it. */
  inputClass: string
  label: string
  hint?: string
  checked: boolean
  onChange(checked: boolean): void
}

/** A checkbox with its label to the right and an optional hint underneath. */
export function prefsCheckboxField(opts: CheckboxFieldOpts): HTMLElement {
  const input = el('input', {
    type: 'checkbox',
    class: opts.inputClass,
    checked: opts.checked,
    onchange: (e: Event) => opts.onChange((e.target as HTMLInputElement).checked),
  })
  return el(
    'div',
    { class: 'tt-prefs-field' },
    el('label', { class: 'tt-prefs-checkbox-label' }, input, opts.label),
    opts.hint ? prefsHint(opts.hint) : null
  )
}

export interface NumberFieldOpts {
  /** Class added to the `<input>` (besides `tt-input`) — sets its width and is how tests find it. */
  inputClass: string
  label: string
  hint?: string
  min: number
  max: number
  value: number
  /** Called with the clamped integer; the input itself is rewritten to show the clamped value. */
  onCommit(value: number): void
}

/** A label followed inline by a small clamped integer input, with an optional hint underneath. */
export function prefsNumberField(opts: NumberFieldOpts): HTMLElement {
  const input = el('input', {
    type: 'number',
    class: `tt-input ${opts.inputClass}`,
    min: String(opts.min),
    max: String(opts.max),
    value: String(opts.value),
    onchange: (e: Event) => {
      const target = e.target as HTMLInputElement
      const clamped = clampInt(Number(target.value), opts.min, opts.max, opts.value)
      target.value = String(clamped)
      opts.onCommit(clamped)
    },
  })
  return el(
    'div',
    { class: 'tt-prefs-field' },
    el('label', { class: 'tt-prefs-inline-label' }, opts.label, input),
    opts.hint ? prefsHint(opts.hint) : null
  )
}
