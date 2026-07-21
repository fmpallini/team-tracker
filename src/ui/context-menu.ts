// src/ui/context-menu.ts — a minimal right-click menu: a fixed-position
// overlay anchored at the click point, closed by Escape or an outside click.
// Mirrors the open/close lifecycle of ui/atref.ts's @ dropdown but with no
// keyboard navigation — every current use (card actions) is mouse-driven.
import { el, bindOutsideDismiss } from './dom'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

// Module-level so opening a new menu always closes any menu already open —
// callers never need to track/close their own previous instance.
let closeCurrent: (() => void) | null = null

export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  closeCurrent?.()

  function close(): void {
    menu.remove()
    unbind()
    closeCurrent = null
  }

  const menu = el(
    'div',
    { class: 'tt-context-menu', style: `left:${x}px; top:${y}px` },
    ...items.map((item) =>
      el(
        'button',
        {
          class: 'tt-context-menu-item' + (item.danger ? ' danger' : ''),
          type: 'button',
          onclick: () => { close(); item.onClick() },
        },
        item.label
      )
    )
  )
  document.body.appendChild(menu)
  const unbind = bindOutsideDismiss((target) => !menu.contains(target), close)
  closeCurrent = close
}
