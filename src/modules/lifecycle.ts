// src/modules/lifecycle.ts — the per-container mount/dispose bookkeeping every
// module renderer needs, in one place instead of seven copies.
import type { Loc } from '../core/types'
import type { ModuleCtx, ModuleRenderer } from '../ui/panes'

/**
 * Per-container teardown for the instance currently mounted there.
 *
 * Module renderers are invoked repeatedly on the *same* container element:
 * ui/panes.ts's `renderBody` clears the container's DOM children before
 * re-invoking the renderer, but that clear does not reach the document-level
 * listeners and document.body-appended overlays that ui/atref.ts's and
 * ui/template-picker.ts's dropdowns attach when open (they are not
 * descendants of `container`). Without explicit disposal those leak a live
 * document 'mousedown' listener plus an orphaned dropdown element on every
 * re-open of the same pane.
 *
 * A WeakMap (rather than a DOM data-attribute or a property stashed on the
 * element) keeps this bookkeeping off the container itself and lets the
 * container be garbage-collected normally once panes.ts drops it.
 *
 * ONE map shared by every module, not one per module — and that is a
 * deliberate behavior change, not merely deduplication. ui/panes.ts reuses the
 * same body element across module switches, so a daily-notes -> risks switch
 * mounts the second module into the container the first is still registered
 * against. With per-module maps each renderer could only see its own entry and
 * the outgoing module's instance leaked; with one map the outgoing instance is
 * disposed. This is safe because each teardown closes only over its own
 * instance state (its `unsubscribe`, its own editor bundle, its own listener
 * refs) and never over anything the incoming module needs. Pinned by
 * test/lifecycle.test.ts's "switching modules within one container disposes the
 * outgoing module" test.
 */
const teardowns = new WeakMap<HTMLElement, () => void>()

/**
 * Wraps a module render function so the instance it previously mounted into a
 * given container is torn down before a new one replaces it. The wrapped
 * function returns its teardown (or nothing, if it has none).
 *
 * Self-disposing on re-invocation — rather than handing the caller an instance
 * to dispose — is deliberate: renderers are called directly (by panes.ts and
 * by tests) with no instance bookkeeping at the call site, and that contract
 * predates this helper.
 */
export function withDisposal(
  render: (container: HTMLElement, loc: Loc, ctx: ModuleCtx) => (() => void) | void
): ModuleRenderer {
  return (container: HTMLElement, loc: Loc, ctx: ModuleCtx): void => {
    const previous = teardowns.get(container)
    teardowns.delete(container)
    if (previous) {
      try {
        previous()
      } catch (e) {
        console.error(e)
      }
    }
    const teardown = render(container, loc, ctx)
    if (teardown) teardowns.set(container, teardown)
  }
}
