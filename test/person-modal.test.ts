import { openPersonModal } from '../src/ui/person-modal'

afterEach(() => {
  document.body.innerHTML = ''
})

function fields() {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-buttons button'))
  return {
    name: document.querySelector<HTMLInputElement>('input[name="tt-person-name"]')!,
    role: document.querySelector<HTMLInputElement>('input[name="tt-person-role"]')!,
    error: document.querySelector<HTMLElement>('.tt-field-error')!,
    ok: buttons.find((b) => b.textContent === 'Save')!,
    cancel: buttons.find((b) => b.textContent === 'Cancel')!,
  }
}

describe('openPersonModal', () => {
  test('prefills the name and role inputs from the initial values', () => {
    openPersonModal('en-US', { title: 'Edit person', initialName: 'Ada', initialRole: 'Lead', onSubmit: () => {} })
    const f = fields()
    expect(f.name.value).toBe('Ada')
    expect(f.role.value).toBe('Lead')
  })

  test('submits the trimmed name and role, then closes', () => {
    let got: [string, string] | null = null
    openPersonModal('en-US', { title: 'x', initialName: '', initialRole: '', onSubmit: (n, r) => { got = [n, r] } })
    const f = fields()
    f.name.value = '  Grace  '
    f.role.value = '  Engineer  '
    f.ok.click()
    expect(got).toEqual(['Grace', 'Engineer'])
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('blocks an empty name: shows the required error, keeps the modal open, does not call onSubmit', () => {
    const onSubmit = vi.fn()
    openPersonModal('en-US', { title: 'x', initialName: '', initialRole: '', onSubmit })
    const f = fields()
    f.name.value = '   '
    f.ok.click()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(f.error.textContent).toBe('Name is required')
    expect(document.querySelector('.tt-modal-overlay')).not.toBeNull()
  })

  test('Cancel closes the modal without calling onSubmit', () => {
    const onSubmit = vi.fn()
    openPersonModal('en-US', { title: 'x', initialName: 'A', initialRole: '', onSubmit })
    fields().cancel.click()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  describe('1:1 cadence fields', () => {
    const cadenceFields = () => ({
      every: document.querySelector<HTMLSelectElement>('select.tt-person-cadence-select')!,
      days: document.querySelector<HTMLInputElement>('input.tt-person-cadence-days-input')!,
      daysWrap: document.querySelector<HTMLElement>('.tt-person-cadence-days')!,
      last: document.querySelector<HTMLInputElement>('.tt-date-picker-input')!,
    })
    const open = (oneOnOne: { everyDays: number | null | undefined; last: string | undefined; defaultDays: number | null }, onSubmit = vi.fn()) => {
      openPersonModal('en-US', { title: 'Edit', initialName: 'Ada', initialRole: '', oneOnOne, onSubmit })
      return onSubmit
    }

    test('edit dialog shows cadence fields and submits Default as undefined', () => {
      const onSubmit = open({ everyDays: undefined, last: '2026-03-10', defaultDays: 14 })
      const f = cadenceFields()
      expect(Array.from(f.every.options).map((o) => o.textContent)).toEqual(['Default (14 days)', 'None', 'Custom'])
      expect(f.every.value).toBe('default')
      expect(f.daysWrap.hidden).toBe(true)
      expect(f.last.value).not.toBe('')
      fields().ok.click()
      expect(onSubmit).toHaveBeenCalledWith('Ada', '', { everyDays: undefined, last: '2026-03-10' })
    })

    test('the Default option reads "none" without a default and singular for one day', () => {
      open({ everyDays: undefined, last: undefined, defaultDays: null })
      expect(cadenceFields().every.options[0]!.textContent).toBe('Default (none)')
      document.body.innerHTML = ''
      open({ everyDays: undefined, last: undefined, defaultDays: 1 })
      expect(cadenceFields().every.options[0]!.textContent).toBe('Default (1 day)')
    })

    test('Custom reveals the days input; None submits null', () => {
      const onSubmit = open({ everyDays: undefined, last: undefined, defaultDays: 14 })
      const f = cadenceFields()
      f.every.value = 'custom'
      f.every.dispatchEvent(new Event('change'))
      expect(f.daysWrap.hidden).toBe(false)
      f.days.value = '9999'
      fields().ok.click()
      // Clamped into 1..365.
      expect(onSubmit.mock.calls[0]![2]).toEqual({ everyDays: 365, last: undefined })

      document.body.innerHTML = ''
      const onSubmit2 = open({ everyDays: 7, last: undefined, defaultDays: 14 })
      const g = cadenceFields()
      expect(g.every.value).toBe('custom')
      expect(g.days.value).toBe('7')
      expect(g.daysWrap.hidden).toBe(false)
      g.every.value = 'none'
      g.every.dispatchEvent(new Event('change'))
      expect(g.daysWrap.hidden).toBe(true)
      fields().ok.click()
      expect(onSubmit2.mock.calls[0]![2]).toEqual({ everyDays: null, last: undefined })
    })

    test('an existing None shows as None', () => {
      open({ everyDays: null, last: undefined, defaultDays: 14 })
      expect(cadenceFields().every.value).toBe('none')
    })

    test('clearing Last 1:1 submits undefined', () => {
      const onSubmit = open({ everyDays: undefined, last: '2026-03-10', defaultDays: 14 })
      const f = cadenceFields()
      f.last.value = ''
      f.last.dispatchEvent(new Event('blur'))
      fields().ok.click()
      expect(onSubmit.mock.calls[0]![2]).toEqual({ everyDays: undefined, last: undefined })
    })

    test('add dialog has no cadence fields', () => {
      const onSubmit = vi.fn()
      openPersonModal('en-US', { title: 'New', initialName: 'Ada', initialRole: '', onSubmit })
      expect(document.querySelector('.tt-person-cadence-select')).toBeNull()
      expect(document.querySelector('.tt-date-picker')).toBeNull()
      fields().ok.click()
      expect(onSubmit.mock.calls[0]).toEqual(['Ada', ''])
    })

    test('Cancel discards the cadence edits', () => {
      const onSubmit = open({ everyDays: undefined, last: undefined, defaultDays: 14 })
      const f = cadenceFields()
      f.every.value = 'none'
      f.every.dispatchEvent(new Event('change'))
      fields().cancel.click()
      expect(onSubmit).not.toHaveBeenCalled()
    })
  })
})
