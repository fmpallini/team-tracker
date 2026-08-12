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

/** Enter confirms a row's text/date field the same way Tab/click-away already does: blur it, which commits via the field's own `onchange` handler. */
export function blurOnEnter(e: Event): void {
  if ((e as KeyboardEvent).key === 'Enter') (e.target as HTMLElement).blur()
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

/**
 * Clamps an already-positioned (`left`/`top` already set, appended to
 * `document.body`) floating overlay so it never renders partly or fully off
 * the right/bottom edge of the viewport — any dropdown/menu anchored to a
 * button or caret near that edge would otherwise do exactly that. Pulled out
 * of ui/context-menu.ts, the first place this was fixed, after the same
 * missing-clamp bug turned up independently in three more anchored overlays
 * (the copy-options menu, the @-mention/template-picker dropdowns, the team
 * switcher) — centralizing it here is what keeps the next one from missing
 * it too. Not used by ui/backlinks-panel.ts's popover, which instead flips
 * above its anchor when clipped at the bottom (appropriate there since its
 * anchor chip can sit anywhere in a scrolled pane, not just near the top).
 */
export function clampToViewport(el: HTMLElement, margin = 8): void {
  const rect = el.getBoundingClientRect()
  if (rect.right > window.innerWidth - margin) {
    el.style.left = `${Math.max(margin, window.innerWidth - margin - rect.width)}px`
  }
  if (rect.bottom > window.innerHeight - margin) {
    el.style.top = `${Math.max(margin, window.innerHeight - margin - rect.height)}px`
  }
}

export interface DeferredRebuild {
  /** Arms `rebuild` to run once, on `active`'s next blur, replacing any previously-armed element. No-op if `active` is already the armed element. */
  arm(active: HTMLElement): void
  /** Cancels an armed deferral without running `rebuild` — call from the owning module's own teardown so a torn-down module can't rebuild itself on a later blur. Idempotent. */
  dispose(): void
}

/**
 * Skips a full rebuild while a caret-sensitive field (`active`) holds focus,
 * running `rebuild` once instead on that field's next blur — nothing is
 * lost, since blur is exactly when the field's own edit (if any) commits and
 * would have triggered a rebuild anyway. Only ever one deferral armed at a
 * time: arming a second element while the first is still focused replaces
 * it rather than stacking a second listener, which would otherwise fire N
 * full rebuilds on a single blur after N skipped mutations.
 *
 * Extracted out of src/modules/milestones.ts and risks.ts, which each carried
 * this identical ~15-line block (only the caret-sensitive-element predicate
 * that decides *when* to call `arm` differs between them, and stays in each
 * module as `focusedCaretInput`/`focusedCaretElement`) — sharing it here is
 * what keeps a future fix to the defer/blur mechanics from having to land in
 * both places.
 */
export function createDeferredRebuild(rebuild: () => void): DeferredRebuild {
  let deferredEl: HTMLElement | null = null
  function onBlur(): void {
    deferredEl = null
    rebuild()
  }
  return {
    arm(active: HTMLElement): void {
      if (deferredEl === active) return
      deferredEl?.removeEventListener('blur', onBlur)
      deferredEl = active
      active.addEventListener('blur', onBlur, { once: true })
    },
    dispose(): void {
      deferredEl?.removeEventListener('blur', onBlur)
      deferredEl = null
    },
  }
}
