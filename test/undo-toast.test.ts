import { offerUndoToast, UNDO_TOAST_KEY } from '../src/ui/undo-toast'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { UndoOffer } from '../src/core/undo-delete'

function fakeOffer(over: Partial<UndoOffer> = {}): UndoOffer {
  return { isAvailable: () => true, undo: () => true, ...over }
}

function toasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.tt-toast'))
}

function actionButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('.tt-toast-action')
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('offerUndoToast', () => {
  it('shows a plain toast with no action when there is no offer', () => {
    const store = createStore(createEmptyDocument('en-US'))
    offerUndoToast(store, 'en-US', 'Risk deleted', null)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.textContent).toBe('Risk deleted')
    expect(actionButton()).toBeNull()
  })

  it('shows an Undo button when an offer is present', () => {
    const store = createStore(createEmptyDocument('en-US'))
    offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer())
    expect(actionButton()?.textContent).toBe('Undo')
    expect(toasts()[0]!.dataset.toastKey).toBe(UNDO_TOAST_KEY)
  })

  it('calls undo() when the button is clicked and confirms it', () => {
    const store = createStore(createEmptyDocument('en-US'))
    const undo = vi.fn(() => true)
    offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer({ undo }))
    actionButton()!.click()
    expect(undo).toHaveBeenCalledTimes(1)
    expect(toasts().some((n) => n.textContent === 'Restored')).toBe(true)
  })

  it('dismisses the toast as soon as anything else mutates the document', () => {
    const store = createStore(createEmptyDocument('en-US'))
    offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer())
    expect(toasts()).toHaveLength(1)
    store.update((d) => { d.prefs.dueSoonDays = 3 })
    expect(document.querySelector(`.tt-toast[data-toast-key="${UNDO_TOAST_KEY}"]`)).toBeNull()
  })

  it('stops listening after the button is clicked, so the undo itself does not re-fire teardown', () => {
    const store = createStore(createEmptyDocument('en-US'))
    const undo = vi.fn(() => { store.update((d) => { d.prefs.dueSoonDays = 9 }); return true })
    offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer({ undo }))
    actionButton()!.click()
    expect(undo).toHaveBeenCalledTimes(1)
    // The confirmation toast must survive the undo's own store.update().
    expect(toasts().some((n) => n.textContent === 'Restored')).toBe(true)
  })

  it('renders in pt-BR', () => {
    const store = createStore(createEmptyDocument('pt-BR'))
    offerUndoToast(store, 'pt-BR', 'Risco excluído', fakeOffer())
    expect(actionButton()?.textContent).toBe('Desfazer')
  })
})
