// src/ui/empty-state.ts
import { el } from './dom'
import { icon, type IconName } from './icons'

export interface EmptyStateOptions {
  icon: IconName
  text: string
  /** Extra class on the wrapper, so a module keeps its own hook (`tt-risk-empty`). */
  className?: string
}

/** A pane with nothing in it yet: a muted icon and one sentence. The pane's own toolbar already holds the add button. */
export function emptyState(opts: EmptyStateOptions): HTMLElement {
  return el(
    'div',
    { class: opts.className ? `tt-empty-state ${opts.className}` : 'tt-empty-state' },
    el('span', { class: 'tt-empty-state-icon' }, icon(opts.icon, 28)),
    el('p', { class: 'tt-empty-state-text' }, opts.text)
  )
}
