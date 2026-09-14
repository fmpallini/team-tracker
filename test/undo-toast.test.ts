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

  it('shows nothing at all when there is no offer because the tab is read-only', () => {
    // deleteWithUndo returns null for two unrelated reasons: the store.update
    // was blocked (read-only tab, nothing was actually deleted) or mutate
    // found nothing to delete. Only the second case is a real deletion worth
    // announcing — a read-only tab must not tell the user something was
    // deleted when it silently wasn't.
    const store = createStore(createEmptyDocument('en-US'))
    store.setReadOnly(true)
    offerUndoToast(store, 'en-US', 'Risk "Vendor slip" deleted', null)
    expect(toasts()).toHaveLength(0)
  })

  it('shows nothing when the offer exists but is already unavailable', () => {
    // Guards the invariant locally: a caller between deleteWithUndo() and
    // offerUndoToast() (e.g. sidebar.ts's resyncPanesAfterNavRewrite) could
    // in principle trigger another mutation first, which would make the
    // offer's button a dead click. Falls through to the plain-toast path,
    // same as a null offer.
    const store = createStore(createEmptyDocument('en-US'))
    offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer({ isAvailable: () => false }))
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

  it('tells the user when a click on Undo is refused', () => {
    // The one path onMutate cannot proactively dismiss: replaceDoc() (the
    // conflict modal's "Reload") bumps rev without firing onMutate, so the
    // toast is still showing when offer.undo() itself refuses. Silently
    // doing nothing would leave the user thinking the restore worked.
    const store = createStore(createEmptyDocument('en-US'))
    offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer({ undo: () => false }))
    actionButton()!.click()
    expect(toasts().some((n) => n.textContent === 'Undo no longer available')).toBe(true)
    expect(toasts().some((n) => n.textContent === 'Restored')).toBe(false)
  })

  it('releases its reference to the offer once the toast is no longer being watched', () => {
    // Fix 5: modal.ts's own dismiss timer is never cleared, so the toast
    // node (and anything an action button's onclick closure holds) stays
    // reachable for the full ten seconds regardless of how the toast is
    // dismissed. offerUndoToast can't cancel that timer, but it must at
    // least drop its own reference to `offer` (and, transitively, whatever
    // deleteWithUndo's restore closure captured) as soon as it stops
    // watching — so a mutation-triggered dismiss releases the offer even
    // though the DOM node itself lingers.
    const store = createStore(createEmptyDocument('en-US'))
    const undo = vi.fn(() => true)
    offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer({ undo }))
    // Grab the button before it's removed — a detached DOM node stays fully
    // functional (event listeners included), exactly like modal.ts's own
    // pending setTimeout(dismiss) keeping `node` reachable for the rest of
    // its ten seconds regardless of an earlier dismiss.
    const btn = actionButton()!
    store.update((d) => { d.prefs.dueSoonDays = 3 }) // triggers the mutation-watcher dismiss path
    btn.click()
    expect(undo).not.toHaveBeenCalled()
  })

  it('renders in pt-BR', () => {
    const store = createStore(createEmptyDocument('pt-BR'))
    offerUndoToast(store, 'pt-BR', 'Risco excluído', fakeOffer())
    expect(actionButton()?.textContent).toBe('Desfazer')
  })

  it('releases the store watcher when the toast expires naturally', () => {
    vi.useFakeTimers()
    try {
      const store = createStore(createEmptyDocument('en-US'))
      let mutationListenerCalls = 0
      const origOnMutate = store.onMutate.bind(store)
      vi.spyOn(store, 'onMutate').mockImplementation((fn) => {
        const wrappedFn = (kind: any) => {
          mutationListenerCalls++
          fn(kind)
        }
        return origOnMutate(wrappedFn)
      })

      offerUndoToast(store, 'en-US', 'Risk deleted', fakeOffer())

      // Advance time by the full toast duration to let it expire and clean up
      vi.advanceTimersByTime(10_000)

      // Reset call count (the watcher was called once during offerUndoToast setup)
      mutationListenerCalls = 0

      // After expiry, mutate the store and verify the watcher was NOT called
      store.update((d) => { d.prefs.dueSoonDays = 5 })
      expect(mutationListenerCalls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
