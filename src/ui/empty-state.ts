// src/ui/empty-state.ts
import { el } from './dom'
import { icon, type IconName } from './icons'

export interface EmptyStateOptions {
  icon: IconName
  text: string
  /** Extra class on the wrapper, so a module keeps its own hook (`tt-risk-empty`). */
  className?: string
  /** The pane's primary add action, offered in place so a first-time user has something to press. */
  action?: { label: string; onClick: () => void }
}

/** A pane with nothing in it yet: a muted icon, one sentence and, when given, the add action. */
export function emptyState(opts: EmptyStateOptions): HTMLElement {
  return el(
    'div',
    { class: opts.className ? `tt-empty-state ${opts.className}` : 'tt-empty-state' },
    el('span', { class: 'tt-empty-state-icon' }, icon(opts.icon, 28)),
    el('p', { class: 'tt-empty-state-text' }, opts.text),
    ...(opts.action
      ? [el('button', { class: 'tt-btn tt-empty-state-action', type: 'button', onclick: opts.action.onClick }, opts.action.label)]
      : [])
  )
}
