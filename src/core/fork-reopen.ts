// src/core/fork-reopen.ts — the last step of a conflict "Fork": the document continues in the fork's file, and the
// original's browser copy (whose lineage the other writer's file broke) goes. Extracted out of main.ts so the order and
// the "only if the fork really took over" condition can be tested.
import type { LivePersister } from './live-persist'

/** What a reconciled fork must offer: the persister to stop if the fork is not mounted. */
type Forked = { handle: { persister: Pick<LivePersister, 'dispose'> } | null }

export interface ForkReopenDeps<T extends Forked> {
  /** Reconciles the fork's file with whatever the browser holds for it. Null: the user backed out. */
  reconcile(): Promise<T | null>
  /** Mounts the fork as the open document, closing the original. Resolves whether it did (the original may refuse to close). */
  mount(forked: T): Promise<boolean>
  removeOriginalCopy(): Promise<void>
}

/**
 * 'mounted': the fork is the open document and the original's copy is removed. 'kept-original': the original stayed
 * open (its file could not be written and the user did not leave it), so its copy is its only safe home and stays; the
 * fork's own persister is stopped, its file and copy being consistent on their own. 'cancelled': nothing happened.
 */
export async function reopenFork<T extends Forked>(deps: ForkReopenDeps<T>): Promise<'mounted' | 'kept-original' | 'cancelled'> {
  const forked = await deps.reconcile()
  if (!forked) return 'cancelled'
  if (!(await deps.mount(forked))) {
    forked.handle?.persister.dispose()
    return 'kept-original'
  }
  await deps.removeOriginalCopy()
  return 'mounted'
}
