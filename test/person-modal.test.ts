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
    ok: buttons.find((b) => b.textContent === 'OK')!,
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
})
