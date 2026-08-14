// src/ui/context-menu.ts — a minimal right-click menu: a fixed-position
// overlay anchored at the click point, closed by Escape or an outside click.
// Mirrors the open/close lifecycle of ui/atref.ts's @ dropdown, including its
// arrow-key/Enter navigation (src/ui/select-list.ts's shared paintSelection/
// clampMove/selectableRowProps) — a real keyboard route to card actions
// (risks/milestones/action-items.ts's row/card Space handler) needs the menu
// to actually take keyboard focus, not just render.
import { el, bindOutsideDismiss, clampToViewport } from './dom'
import { paintSelection, clampMove, selectableRowProps } from './select-list'

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

  // Whatever had focus when the menu opened (typically the row/card whose
  // Space keypress triggered it) gets it back on close — otherwise closing
  // via Escape/outside-click/picking an item leaves focus stranded on
  // document.body, same class of bug the kanban edit modal had.
  const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let selected = 0

  // Paints the CSS highlight only — used for mouse hover, which shouldn't
  // yank keyboard focus out from under a pointer user.
  function paint(): void {
    paintSelection(menu, '.tt-context-menu-item', selected)
  }

  // Paints AND moves real DOM focus onto the selected button — used for
  // keyboard nav. Real focus (not just the CSS class) has to track
  // `selected`, or ArrowDown/Up beyond the first press would silently stop
  // doing anything: risks/milestones/action-items.ts's row/card arrow
  // handlers are guarded on the keydown's target being the row/card itself,
  // and once real focus is here they simply never see the event — but only
  // for as long as focus actually follows the highlight.
  function focusSelected(): void {
    paint()
    buttonEls[selected]?.focus()
  }

  function close(): void {
    menu.remove()
    unbind()
    document.removeEventListener('keydown', onKeydown)
    closeCurrent = null
    origin?.focus()
  }

  const buttonEls: HTMLButtonElement[] = items.map((item, i) =>
    el(
      'button',
      {
        ...selectableRowProps({
          class: 'tt-context-menu-item' + (item.danger ? ' danger' : ''),
          selected: i === selected,
          onCommit: () => { close(); item.onClick() },
          onHover: () => { selected = i; paint() },
        }),
        type: 'button',
      },
      item.label
    )
  )
  const menu = el('div', { class: 'tt-context-menu', style: `left:${x}px; top:${y}px` }, ...buttonEls)
  document.body.appendChild(menu)

  // Clamp to the viewport — a right-click near the right/bottom edge of a
  // pane (the common case for the right pane in split view, or a card near
  // the bottom of a scrolled column) would otherwise open partly or fully
  // off-screen. Same pattern as ui/backlinks-panel.ts's popover.
  clampToViewport(menu)

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      selected = clampMove(selected, e.key === 'ArrowDown' ? 1 : -1, items.length)
      focusSelected()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[selected]
      if (item) { close(); item.onClick() }
    }
  }
  document.addEventListener('keydown', onKeydown)

  const unbind = bindOutsideDismiss((target) => !menu.contains(target), close)
  closeCurrent = close

  // Moves real DOM focus into the menu so arrow keys drive IT, not whatever
  // list the triggering row/card belongs to — those modules' own arrow
  // handlers are guarded on the keydown's target being the row/card itself
  // (see risks.ts/milestones.ts/action-items.ts), so once focus is here they
  // naturally stop firing without this menu needing to know about them.
  buttonEls[0]?.focus()
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
