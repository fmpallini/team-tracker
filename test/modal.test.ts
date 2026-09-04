import { showModal, promptPassword, toast, confirmDelete, dismissModelessModals } from '../src/ui/modal'
import { el } from '../src/ui/dom'

function overlays(): NodeListOf<Element> {
  return document.querySelectorAll('.tt-modal-overlay')
}

afterEach(() => {
  // Most tests below never call handle.close() — renderDialog's own
  // document-level keydown listener would otherwise leak into the next
  // test (wiping document.body doesn't remove it), so a later test's own
  // Tab/Enter dispatch could also trigger a stale, detached dialog's trap
  // logic. Escape lets a still-open modal close itself and unregister its
  // own listener before the DOM is wiped — one press per modal now that
  // Escape only closes the topmost, so loop until none remain.
  let guard = 20
  while (overlays().length > 0 && guard-- > 0) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  }
  document.body.innerHTML = ''
})

test('a danger button gets the tt-btn-danger class', () => {
  showModal({ title: 'T', body: el('div', {}), buttons: [{ label: 'Delete', danger: true, onClick: () => {} }] })
  const btn = document.querySelector('.tt-modal-buttons button') as HTMLButtonElement
  expect(btn.classList.contains('tt-btn-danger')).toBe(true)
})

test('a left button gets the tt-btn-left class', () => {
  showModal({ title: 'T', body: el('div', {}), buttons: [{ label: 'Delete', left: true, onClick: () => {} }] })
  const btn = document.querySelector('.tt-modal-buttons button') as HTMLButtonElement
  expect(btn.classList.contains('tt-btn-left')).toBe(true)
})

test('showModal renders title, body and buttons; close removes overlay', () => {
  const body = el('p', {}, 'hello')
  let clicked = false
  const handle = showModal({
    title: 'Title',
    body,
    buttons: [{ label: 'Go', primary: true, onClick: () => { clicked = true } }],
  })
  expect(overlays().length).toBe(1)
  expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Title')
  expect(document.body.contains(body)).toBe(true)
  const btn = document.querySelector('.tt-modal-buttons button') as HTMLButtonElement
  expect(btn.textContent).toBe('Go')
  btn.click()
  expect(clicked).toBe(true)
  handle.close()
  expect(overlays().length).toBe(0)
})

test('Enter in a text input inside the modal triggers the primary button', () => {
  const input = el('input', { type: 'text' }) as HTMLInputElement
  document.body.appendChild(el('div', {})) // unrelated node, sanity noise
  let clicked = false
  showModal({
    title: 'T',
    body: el('div', {}, input),
    buttons: [
      { label: 'Cancel', onClick: () => {} },
      { label: 'OK', primary: true, onClick: () => { clicked = true } },
    ],
  })
  const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  input.dispatchEvent(ev)
  expect(clicked).toBe(true)
  // preventDefault so the same Enter can't also act on whatever the primary
  // action focuses next (e.g. the link modal, which focuses the editor and
  // inserts a link, then had the default Enter split a stray paragraph).
  expect(ev.defaultPrevented).toBe(true)
})

test('Enter does not trigger the primary button when there is none', () => {
  const input = el('input', { type: 'text' }) as HTMLInputElement
  showModal({ title: 'T', body: el('div', {}, input), buttons: [{ label: 'Cancel', onClick: () => {} }] })
  expect(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))).not.toThrow()
})

// Regression: opening this modal from inside another capture-phase Enter
// handler (e.g. the Ctrl+K palette's "Due" row) means this modal's own
// keydown listener can still see that same, still-bubbling Enter event —
// but its e.target is a foreign <input> that was never part of this dialog.
// Without the dialog.contains() check, that foreign input satisfied
// `instanceof HTMLInputElement` and made this modal instantly click its own
// primary button and close itself before ever painting.
test('Enter from an input outside the dialog does not trigger the primary button', () => {
  const foreignInput = el('input', { type: 'text' }) as HTMLInputElement
  document.body.appendChild(foreignInput) // never placed inside the modal's body
  let clicked = false
  showModal({
    title: 'T',
    body: el('div', {}),
    buttons: [{ label: 'OK', primary: true, onClick: () => { clicked = true } }],
  })
  foreignInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  expect(clicked).toBe(false)
  expect(document.querySelector('.tt-modal-overlay')).not.toBeNull()
})

test('showModal focuses the first focusable element on open when no caller focuses one', () => {
  showModal({
    title: 'T',
    body: el('div', {}),
    buttons: [
      { label: 'Cancel', onClick: () => {} },
      { label: 'OK', primary: true, onClick: () => {} },
    ],
  })
  const cancelBtn = document.querySelectorAll('.tt-modal-buttons button')[0]
  expect(document.activeElement).toBe(cancelBtn)
})

test('showModal does not fight a caller that focuses its own field right after opening', () => {
  const input = el('input', { type: 'text' }) as HTMLInputElement
  showModal({ title: 'T', body: el('div', {}, input), buttons: [{ label: 'Cancel', onClick: () => {} }] })
  input.focus() // mirrors callers like people-tree.ts/action-items.ts that focus a field after showModal() returns
  expect(document.activeElement).toBe(input)
})

test('Tab from the last focusable element wraps to the first (focus trap)', () => {
  const input = el('input', { type: 'text' }) as HTMLInputElement
  showModal({
    title: 'T',
    body: el('div', {}, input),
    buttons: [
      { label: 'Cancel', onClick: () => {} },
      { label: 'OK', primary: true, onClick: () => {} },
    ],
  })
  const okBtn = document.querySelectorAll('.tt-modal-buttons button')[1] as HTMLButtonElement
  okBtn.focus()
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  document.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(input)
})

test('Shift+Tab from the first focusable element wraps to the last (focus trap)', () => {
  const input = el('input', { type: 'text' }) as HTMLInputElement
  showModal({
    title: 'T',
    body: el('div', {}, input),
    buttons: [
      { label: 'Cancel', onClick: () => {} },
      { label: 'OK', primary: true, onClick: () => {} },
    ],
  })
  input.focus()
  const okBtn = document.querySelectorAll('.tt-modal-buttons button')[1] as HTMLButtonElement
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
  document.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(okBtn)
})

test('Tab is left alone (no trap) when nothing in the dialog is focusable', () => {
  showModal({ title: 'T', body: el('div', {}), buttons: [] })
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  expect(() => document.dispatchEvent(event)).not.toThrow()
  expect(event.defaultPrevented).toBe(false)
})

test('showModal closes on Escape', () => {
  showModal({ title: 'T', body: el('div'), buttons: [] })
  expect(overlays().length).toBe(1)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(overlays().length).toBe(0)
})

test('Escape closes only the topmost of stacked modals, one press at a time', () => {
  const outerClose = vi.fn()
  const innerClose = vi.fn()
  showModal({ title: 'Outer', body: el('div'), buttons: [], onClose: outerClose })
  showModal({ title: 'Inner', body: el('div'), buttons: [], onClose: innerClose })
  expect(overlays().length).toBe(2)

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(overlays().length).toBe(1)
  expect(innerClose).toHaveBeenCalledOnce()
  expect(outerClose).not.toHaveBeenCalled()
  expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Outer')

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(overlays().length).toBe(0)
  expect(outerClose).toHaveBeenCalledOnce()
})

test('modeless: overlay carries tt-modal-modeless; dismissModelessModals closes it and returns true', () => {
  const onClose = vi.fn()
  showModal({ title: 'Card', body: el('div'), buttons: [], modeless: true, onClose })
  showModal({ title: 'Plain', body: el('div'), buttons: [] })
  expect(document.querySelector('.tt-modal-overlay.tt-modal-modeless')).not.toBeNull()

  const result = dismissModelessModals()
  expect(result).toBe(true)
  expect(onClose).toHaveBeenCalledOnce()
  expect(document.querySelector('.tt-modal-modeless')).toBeNull()
  // the plain modal is untouched
  expect(overlays().length).toBe(1)
  expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Plain')
})

test('dismissModelessModals returns true when there is nothing modeless open', () => {
  showModal({ title: 'Plain', body: el('div'), buttons: [] })
  expect(dismissModelessModals()).toBe(true)
  expect(overlays().length).toBe(1)
})

test('dismissModelessModals returns false and leaves the modal open when its beforeClose vetoes', () => {
  let allowClose = false
  showModal({ title: 'Card', body: el('div'), buttons: [], modeless: true, beforeClose: () => allowClose })

  expect(dismissModelessModals()).toBe(false)
  expect(document.querySelector('.tt-modal-modeless')).not.toBeNull()

  allowClose = true
  expect(dismissModelessModals()).toBe(true)
  expect(document.querySelector('.tt-modal-modeless')).toBeNull()
})

test('a modal ignores an Escape a nested popup already handled (defaultPrevented)', () => {
  showModal({ title: 'T', body: el('div'), buttons: [] })
  // Mimics the @-mention dropdown / emoji picker: a capture-phase listener
  // consumes its own Escape before the modal's document listener sees it.
  const consume = (e: KeyboardEvent): void => { if (e.key === 'Escape') e.preventDefault() }
  document.addEventListener('keydown', consume, true)
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    expect(overlays().length).toBe(1)
  } finally {
    document.removeEventListener('keydown', consume, true)
  }
})

test('onClose fires once when closed via handle.close()', () => {
  const onClose = vi.fn()
  const handle = showModal({ title: 'T', body: el('div'), buttons: [], onClose })
  handle.close()
  expect(onClose).toHaveBeenCalledOnce()
})

test('onClose fires once when closed via Escape', () => {
  const onClose = vi.fn()
  showModal({ title: 'T', body: el('div'), buttons: [], onClose })
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(onClose).toHaveBeenCalledOnce()
})

test('beforeClose returning false vetoes both Escape and handle.close(), and onClose does not fire', () => {
  const onClose = vi.fn()
  let allowClose = false
  const handle = showModal({ title: 'T', body: el('div'), buttons: [], onClose, beforeClose: () => allowClose })

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(overlays().length).toBe(1)
  handle.close()
  expect(overlays().length).toBe(1)
  expect(onClose).not.toHaveBeenCalled()

  allowClose = true
  handle.close()
  expect(overlays().length).toBe(0)
  expect(onClose).toHaveBeenCalledOnce()
})

test('beforeClose returning true allows the close', () => {
  const handle = showModal({ title: 'T', body: el('div'), buttons: [], beforeClose: () => true })
  handle.close()
  expect(overlays().length).toBe(0)
})

test('promptPassword resolves with entered password on OK', async () => {
  const promise = promptPassword('en-US', { title: 'Open' })
  const input = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  input.value = 'secret'
  input.dispatchEvent(new Event('input'))
  const ok = document.querySelectorAll('.tt-modal-buttons button')[1] as HTMLButtonElement
  expect(ok.disabled).toBe(false)
  ok.click()
  await expect(promise).resolves.toEqual({ password: 'secret' })
  expect(overlays().length).toBe(0)
})

test('promptPassword OK is disabled until non-empty', () => {
  void promptPassword('en-US', { title: 'Open' })
  const ok = document.querySelectorAll('.tt-modal-buttons button')[1] as HTMLButtonElement
  expect(ok.disabled).toBe(true)
})

test('promptPassword resolves null on Cancel', async () => {
  const promise = promptPassword('en-US', { title: 'Open' })
  const cancel = document.querySelectorAll('.tt-modal-buttons button')[0] as HTMLButtonElement
  cancel.click()
  await expect(promise).resolves.toBeNull()
})

test('promptPassword confirm mode rejects a password shorter than 4 characters', async () => {
  const promise = promptPassword('en-US', { confirm: true, title: 'Create' })
  const [pw, confirm] = document.querySelectorAll('input') as unknown as HTMLInputElement[]
  pw!.value = 'abc'
  pw!.dispatchEvent(new Event('input'))
  confirm!.value = 'abc'
  confirm!.dispatchEvent(new Event('input'))
  const ok = document.querySelectorAll('.tt-modal-buttons button')[1] as HTMLButtonElement
  ok.click()
  expect(document.querySelector('.tt-field-error')?.textContent).toBe('Password must be at least 4 characters')

  pw!.value = 'abcd'
  pw!.dispatchEvent(new Event('input'))
  confirm!.value = 'abcd'
  confirm!.dispatchEvent(new Event('input'))
  ok.click()
  await expect(promise).resolves.toEqual({ password: 'abcd' })
})

test('promptPassword resolves null on Escape', async () => {
  const promise = promptPassword('en-US', { title: 'Open' })
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await expect(promise).resolves.toBeNull()
})

test('promptPassword confirm mismatch shows inline error and does not resolve', async () => {
  const promise = promptPassword('en-US', { confirm: true, title: 'Create' })
  const [pw, confirm] = document.querySelectorAll('input') as unknown as HTMLInputElement[]
  pw!.value = 'abcd'
  pw!.dispatchEvent(new Event('input'))
  confirm!.value = 'defg'
  confirm!.dispatchEvent(new Event('input'))
  const ok = document.querySelectorAll('.tt-modal-buttons button')[1] as HTMLButtonElement
  expect(ok.disabled).toBe(false)
  ok.click()
  expect(document.querySelector('.tt-field-error')?.textContent).toBe('Passwords do not match')

  confirm!.value = 'abcd'
  confirm!.dispatchEvent(new Event('input'))
  ok.click()
  await expect(promise).resolves.toEqual({ password: 'abcd' })
})

test('promptPassword without allowPlain has no "use without password" button', () => {
  void promptPassword('en-US', { confirm: true, title: 'Create' })
  const labels = Array.from(document.querySelectorAll('.tt-modal-buttons button')).map((b) => b.textContent)
  expect(labels).not.toContain('Create without password')
})

test('promptPassword with allowPlain shows the plain button and hint, resolves {plain:true} on click', async () => {
  const promise = promptPassword('en-US', { confirm: true, allowPlain: true, title: 'Create' })
  expect(document.querySelector('.tt-password-plain-hint')?.textContent).toBe(
    'The file has no password and no encryption: it opens directly, without prompting. In exchange, anyone with access to the file can read its contents — including automated scans by cloud backup services.'
  )
  const plainBtn = Array.from(document.querySelectorAll('.tt-password-plain-row button')).find((b) => b.textContent === 'Create without password') as HTMLButtonElement
  expect(plainBtn).toBeDefined()
  plainBtn.click()
  await expect(promise).resolves.toEqual({ plain: true })
})

test('promptPassword with allowPlain: the plain button is unaffected by password-field validation', () => {
  void promptPassword('en-US', { confirm: true, allowPlain: true, title: 'Create' })
  const plainBtn = Array.from(document.querySelectorAll('.tt-password-plain-row button')).find((b) => b.textContent === 'Create without password') as HTMLButtonElement
  expect(plainBtn.disabled).toBe(false) // unlike OK, which starts disabled until a password is typed
})

test('promptPassword with allowPlain keeps the plain option out of the primary Cancel/OK row', () => {
  void promptPassword('en-US', { confirm: true, allowPlain: true, title: 'Create' })
  const primaryLabels = Array.from(document.querySelectorAll('.tt-modal-buttons button')).map((b) => b.textContent)
  expect(primaryLabels).toEqual(['Cancel', 'OK'])
  // the disclaimer sits with the plain button in its own row, not in the password form
  const row = document.querySelector('.tt-password-plain-row') as HTMLElement
  expect(row).toBeTruthy()
  expect(row.querySelector('.tt-password-plain-hint')).toBeTruthy()
  expect(row.querySelector('button')?.textContent).toBe('Create without password')
  expect(document.querySelector('.tt-password-form .tt-password-plain-hint')).toBeNull()
})

test('promptPassword confirm mode renders a live strength meter under the password field', () => {
  void promptPassword('en-US', { confirm: true, title: 'Create' })
  const pw = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  expect(document.querySelector('.tt-pwmeter')).not.toBeNull()
  pw.value = 'Tr0ub4dor&3xtra!'
  pw.dispatchEvent(new Event('input'))
  expect(document.querySelector('.tt-pwmeter-label')?.textContent).toBe('Strong')
})

test('promptPassword without confirm (open-file mode) has no strength meter', () => {
  void promptPassword('en-US', { title: 'Open' })
  expect(document.querySelector('.tt-pwmeter')).toBeNull()
})

test('confirmDelete shows a title/message/confirm button and calls onConfirm', () => {
  const onConfirm = vi.fn()
  confirmDelete('en-US', {
    title: 'Delete X',
    message: 'Are you sure?',
    confirmLabel: 'Delete',
    variant: 'danger',
    onConfirm,
  })
  const dialog = document.querySelector('.tt-modal-dialog')!
  expect(dialog.querySelector('.tt-modal-title')?.textContent).toBe('Delete X')
  expect(dialog.querySelector('.tt-modal-message')?.textContent).toBe('Are you sure?')
  const confirmBtn = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!
  expect(confirmBtn.className).toContain('tt-btn-danger')
  confirmBtn.click()
  expect(onConfirm).toHaveBeenCalledOnce()
  expect(document.querySelector('.tt-modal-overlay')).toBeNull()
})

test('toast renders message and is removed on click', () => {
  toast('hi')
  const node = document.querySelector('.tt-toast') as HTMLElement
  expect(node.textContent).toBe('hi')
  node.click()
  expect(document.querySelector('.tt-toast')).toBeNull()
})

test('toast auto-dismisses after timeout unless sticky', () => {
  vi.useFakeTimers()
  try {
    toast('bye')
    expect(document.querySelector('.tt-toast')).not.toBeNull()
    vi.advanceTimersByTime(4000)
    expect(document.querySelector('.tt-toast')).toBeNull()

    toast('sticky one', { sticky: true })
    vi.advanceTimersByTime(10000)
    expect(document.querySelector('.tt-toast')).not.toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

// A sticky fallback notice plus one transient message was already enough to
// wall off the lower-right corner of a note editor, and the stack had no
// upper bound at all.
test('the toast stack keeps at most three, dropping the oldest first', () => {
  toast('one', { sticky: true })
  toast('two', { sticky: true })
  toast('three', { sticky: true })
  toast('four', { sticky: true })

  const texts = [...document.querySelectorAll('.tt-toast')].map((n) => n.textContent)
  expect(texts).toEqual(['two', 'three', 'four'])
})
