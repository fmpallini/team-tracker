// src/ui/expandable-followup.ts — shared expand/collapse + editor-bundle
// lifecycle bookkeeping for a list of rows where any number can have a rich
// follow-up editor expanded at once (src/modules/milestones.ts and
// src/modules/risks.ts). Rendering the row itself and building its
// RichEditorBundle stays with the caller — this only tracks which ids are
// expanded and disposes their bundles together.
import type { RichEditorBundle } from './rich-editor'

export class ExpandableRowsController {
  private expandedIds = new Set<string>()
  private bundles = new Map<string, RichEditorBundle>()

  isExpanded(id: string): boolean {
    return this.expandedIds.has(id)
  }

  /** Registers `id`'s freshly-built editor bundle so a later dispose call tears it down. Call once per expanded row, right after building its bundle. */
  register(id: string, bundle: RichEditorBundle): void {
    this.bundles.set(id, bundle)
  }

  toggle(id: string): void {
    if (this.expandedIds.has(id)) this.expandedIds.delete(id)
    else this.expandedIds.add(id)
  }

  setAll(ids: string[], expand: boolean): void {
    this.expandedIds = expand ? new Set(ids) : new Set()
  }

  isAllExpanded(ids: string[]): boolean {
    return ids.length > 0 && ids.every((id) => this.expandedIds.has(id))
  }

  /** Adds `id` to the expanded set. Idempotent — expanding an already-expanded id is a no-op. */
  expand(id: string): void {
    this.expandedIds.add(id)
  }

  /** Drops `id` from the expanded set without disposing its bundle — for a row about to be deleted via store.update anyway, where the next render() rebuilds nothing for it. */
  collapse(id: string): void {
    this.expandedIds.delete(id)
  }

  disposeOne(id: string): void {
    this.bundles.get(id)?.dispose()
    this.bundles.delete(id)
  }

  disposeAll(): void {
    for (const id of [...this.bundles.keys()]) this.disposeOne(id)
  }

  /** Patches every currently-expanded row's ref chips in place (Editor.refreshRefLabels) — cheap and caret-safe, so callers can run it unconditionally on every scope-affecting store mutation instead of only on a full renderAll(). */
  refreshAllLabels(): void {
    for (const bundle of this.bundles.values()) bundle.editor.refreshRefLabels()
  }
}
