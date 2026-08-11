// src/ui/context-menu.ts — a minimal right-click menu: a fixed-position
// overlay anchored at the click point, closed by Escape or an outside click.
// Mirrors the open/close lifecycle of ui/atref.ts's @ dropdown but with no
// keyboard navigation — every current use (card actions) is mouse-driven.
import { el, bindOutsideDismiss, clampToViewport } from './dom'

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

  // Clamp to the viewport — a right-click near the right/bottom edge of a
  // pane (the common case for the right pane in split view, or a card near
  // the bottom of a scrolled column) would otherwise open partly or fully
  // off-screen. Same pattern as ui/backlinks-panel.ts's popover.
  clampToViewport(menu)

  const unbind = bindOutsideDismiss((target) => !menu.contains(target), close)
  closeCurrent = close
}

/**
 * Closes whatever menu is currently open, if any — a no-op otherwise. `menu`
 * itself lives only in whichever document is open when it's shown, but this
 * function and `closeCurrent` are module-level and outlive any one document,
 * so main.ts's teardownApp calls this on every file close: an open menu's
 * `items[].onClick` closures capture that document's store/pm, and its two
 * capturing `document` listeners (bindOutsideDismiss) would otherwise pin
 * all of it in memory until the next `showContextMenu()` call anywhere in
 * the app — which might be in a much later, unrelated document, or never.
 */
export function closeAnyContextMenu(): void {
  closeCurrent?.()
}
