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
