// src/ui/dom.ts
type AttrValue = string | number | boolean | ((e: Event) => void)

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, AttrValue>,
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
        continue
      }
      if (key === 'class') {
        node.className = String(value)
        continue
      }
      if (typeof value === 'boolean') {
        if (value) node.setAttribute(key, '')
        continue
      }
      if (value === null) continue
      node.setAttribute(key, String(value))
    }
  }
  for (const child of children) {
    if (child === null) continue
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

/**
 * Wires the "dismiss on outside click or Escape" lifecycle shared by every
 * floating overlay in this app (context menus, popovers, the @-mention
 * dropdown): a capture-phase `mousedown` closes when `shouldClose(target)`
 * is true, and a capture-phase `keydown` closes on Escape unconditionally.
 * Capture phase, not bubble: the overlay may itself remove elements from the
 * DOM on close, and a bubble-phase listener registered after the overlay's
 * own click handlers could otherwise be skipped if closing detaches the
 * event's original target first.
 *
 * Returns an unbind function — callers must call it once, from their own
 * close(), or the listeners leak for the page's lifetime.
 */
export function bindOutsideDismiss(shouldClose: (target: Node) => boolean, onDismiss: () => void): () => void {
  const onMousedown = (e: MouseEvent): void => {
    if (shouldClose(e.target as Node)) onDismiss()
  }
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') onDismiss()
  }
  document.addEventListener('mousedown', onMousedown, true)
  document.addEventListener('keydown', onKeydown, true)
  return () => {
    document.removeEventListener('mousedown', onMousedown, true)
    document.removeEventListener('keydown', onKeydown, true)
  }
}
