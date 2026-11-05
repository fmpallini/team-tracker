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
  // Browsers flag a form field with neither id nor name (autofill and devtools issues). Most fields here are
  // identified by their class alone, so that stands in unless the caller named the field.
  if ((tag === 'input' || tag === 'select' || tag === 'textarea') && !node.hasAttribute('name') && !node.id) {
    const own = node.classList.length > 1 ? Array.from(node.classList).find((c) => c !== 'tt-input') : node.classList[0]
    node.setAttribute('name', own ?? `tt-${tag}-${node.getAttribute('type') ?? 'field'}`)
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

export interface SavedFocus {
  /** Puts focus (and an editor's caret) back; false if there was nothing to go back to. */
  restore(): boolean
}

/**
 * Remembers what holds focus now, for a surface that takes it and should hand
 * it back: a modal, the search box, the other pane. A contenteditable's Range
 * travels with it, since focusing one puts the caret at its start.
 */
export function saveFocus(): SavedFocus {
  const target = document.activeElement
  if (!(target instanceof HTMLElement) || target === document.body) return { restore: () => false }
  const sel = window.getSelection()
  const range = target.matches('[contenteditable="true"]') && sel && sel.rangeCount > 0 && target.contains(sel.anchorNode)
    ? sel.getRangeAt(0).cloneRange()
    : null
  return {
    restore(): boolean {
      if (!target.isConnected) return false
      target.focus({ preventScroll: true })
      if (range && target.contains(range.startContainer)) {
        const live = window.getSelection()
        live?.removeAllRanges()
        live?.addRange(range)
      }
      return true
    },
  }
}

/** The id of the row after `id` in `root`, else the one before it: where focus goes when `id` is deleted. */
export function neighbourRowId(root: HTMLElement, rowSelector: string, id: string): string | null {
  const rows = Array.from(root.querySelectorAll<HTMLElement>(`${rowSelector}[data-item-id]`))
  const at = rows.findIndex((r) => r.dataset.itemId === id)
  if (at === -1) return null
  return (rows[at + 1] ?? rows[at - 1])?.dataset.itemId ?? null
}

/**
 * Runs a list's full rebuild without losing the user's place. Every row is
 * replaced, so focus on one (or on a control inside one) would otherwise fall
 * to <body> and the next arrow would restart from the top. Afterwards focus
 * is on the same row by `data-item-id`, or on its neighbour when the rebuild
 * took the row away. A select or text field keeps it, so the next field stays
 * one Tab off; anything else hands it to the row, where the arrows work. A
 * rebuild that placed focus itself wins.
 */
export function keepRowFocus(root: HTMLElement, rowSelector: string, rebuild: () => void): void {
  const active = document.activeElement
  const row = active instanceof HTMLElement && root.contains(active) ? active.closest<HTMLElement>(rowSelector) : null
  const id = row?.dataset.itemId
  if (id === undefined) { rebuild(); return }
  const neighbour = neighbourRowId(root, rowSelector, id)
  const isField = active instanceof HTMLSelectElement || (active instanceof HTMLInputElement && active.type === 'text')
  const fieldSelector = isField && active.classList[0] ? `${active.tagName}.${active.classList[0]}` : null
  rebuild()
  if (document.activeElement !== document.body) return
  const rowFor = (rowId: string | null): HTMLElement | null =>
    rowId === null ? null : root.querySelector<HTMLElement>(`${rowSelector}[data-item-id="${rowId}"]`)
  const same = rowFor(id)
  const field = fieldSelector ? same?.querySelector<HTMLElement>(fieldSelector) : null
  ;(field ?? same ?? rowFor(neighbour))?.focus()
  if (field instanceof HTMLInputElement) field.select()
}

export interface RovingRows {
  /** Re-applies the tab order after a rebuild. */
  refresh(): void
  /** Puts the stop on this row (`data-item-id`) from outside, as the sidebar does for the active team. */
  setActive(id: string | null): void
}

const ROW_CONTROLS = 'input, select, button, a[href]'

/**
 * One Tab stop for a whole list (roving tabindex): the arrows walk the rows, so
 * Tab can go past them. Only the current row, and the fields inside it, stay in
 * the tab order; the others are still focusable by click or by the arrows,
 * which moves the stop. A control a row took out of the tab order itself
 * (`tabindex="-1"`) stays out, on every row. The caller refreshes after a rebuild.
 */
export function rovingRows(root: HTMLElement, rowSelector: string): RovingRows {
  let activeId: string | null = null
  let stop: HTMLElement | null = null

  function demote(row: HTMLElement): void {
    row.tabIndex = -1
    for (const control of row.querySelectorAll<HTMLElement>(ROW_CONTROLS)) {
      if (control.tabIndex < 0) continue
      control.tabIndex = -1
      control.dataset.rovingField = ''
    }
  }
  function promote(row: HTMLElement): void {
    row.tabIndex = 0
    for (const control of row.querySelectorAll<HTMLElement>('[data-roving-field]')) {
      control.removeAttribute('tabindex')
      delete control.dataset.rovingField
    }
  }
  function refresh(): void {
    const rows = Array.from(root.querySelectorAll<HTMLElement>(rowSelector))
    stop = rows.find((r) => r.dataset.itemId === activeId) ?? rows[0] ?? null
    for (const row of rows) {
      if (row === stop) promote(row)
      else demote(row)
    }
  }
  root.addEventListener('focusin', (e) => {
    const row = (e.target as Element).closest<HTMLElement>(rowSelector)
    if (!row || row === stop) return
    if (stop?.isConnected) demote(stop)
    promote(row)
    stop = row
    activeId = row.dataset.itemId ?? null
  })
  return {
    refresh,
    setActive(id) {
      activeId = id
      refresh()
    },
  }
}

/** Strips `classes` from every `selector` match under `root` — the drag-over / drop-position highlight reset every drag-and-drop list does between events. */
export function clearClasses(root: ParentNode, selector: string, ...classes: string[]): void {
  root.querySelectorAll(selector).forEach((n) => n.classList.remove(...classes))
}

/** Appends a `<div class="{cls} tt-field-error">` note to `row` unless one is already there (idempotent). It clears when the row is next rebuilt, or via `clearRowError`. */
export function showRowError(row: HTMLElement, cls: string, message: string): void {
  if (row.querySelector(`.${cls}`)) return
  row.appendChild(el('div', { class: `${cls} tt-field-error` }, message))
}

export function clearRowError(row: HTMLElement, cls: string): void {
  row.querySelector(`.${cls}`)?.remove()
}

/**
 * Wires the "dismiss on outside click or Escape" lifecycle shared by every
 * floating overlay in this app (context menus, popovers, the @-mention
 * dropdown): a capture-phase `mousedown` closes when `shouldClose(target)`
 * is true, and a capture-phase `keydown` closes on Escape (stopping the
 * event so a modal this overlay floats above doesn't also close).
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
    if (e.key !== 'Escape') return
    // Consume it: this Escape was for the floating overlay, not for anything
    // underneath it. A modal that this popover floats above (e.g. a date
    // picker or context menu opened from inside the action-item card modal)
    // has its own document-level Escape-to-close listener, and without this
    // the same keypress would close that modal too.
    e.stopPropagation()
    e.preventDefault()
    onDismiss()
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

/**
 * Vertical mouse-wheel travel scrolls `scroller` sideways — but only when it
 * has a horizontal scrollbar and nothing vertical to scroll, so a wheel never
 * loses its normal job. A plain wheel can't otherwise reach a horizontal-only
 * overflow at all (nothing consumes a vertical delta). Same gesture
 * modules/action-items.ts gives the kanban board. Skips events that already
 * carry a horizontal delta (trackpads, shift+wheel) and Ctrl+wheel (the font
 * size gesture), and lets the wheel through once the scroller is at the end it
 * is heading for. Returns the unbind function.
 */
export function wheelScrollsHorizontally(scroller: HTMLElement, yieldsTo?: (target: HTMLElement) => boolean): () => void {
  const onWheel = (e: WheelEvent): void => {
    if (e.deltaY === 0 || e.deltaX !== 0 || e.ctrlKey) return
    if (scroller.scrollWidth <= scroller.clientWidth) return
    if (scroller.scrollHeight > scroller.clientHeight) return
    if (yieldsTo?.(e.target as HTMLElement)) return
    // Already at the end it is heading for: let the wheel do its normal job (e.g.
    // scroll the page behind) rather than trapping it over a spent scroller.
    const atStart = scroller.scrollLeft <= 0
    const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1
    if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return
    e.preventDefault()
    scroller.scrollLeft += e.deltaY
  }
  scroller.addEventListener('wheel', onWheel, { passive: false })
  return () => scroller.removeEventListener('wheel', onWheel)
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
 * that decides *when* to call `arm` differs between them: each module passes
 * its own input types to followup-list.ts's `focusedCaretElement`) —
 * sharing it here is what keeps a future fix to the defer/blur mechanics from
 * having to land in both places.
 */
export function createDeferredRebuild(rebuild: () => void): DeferredRebuild {
  let deferredEl: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  // A Tab out is mid-flight here: rebuilding now would destroy the element
  // focus is on its way to and drop it on <body>. Let it land first.
  function onBlur(e: Event): void {
    const field = e.target as HTMLElement
    const next = (e as FocusEvent).relatedTarget as Element | null
    deferredEl = null
    // Into the field's own popup (a date's calendar): the rebuild would tear
    // that popup down. Focus returns to the field when it closes, so wait for
    // the blur after that.
    if (next?.closest('[data-field-popup]')) {
      field.addEventListener('focus', () => armField(field), { once: true })
      return
    }
    if (!next) { rebuild(); return }
    timer = setTimeout(() => { timer = null; rebuild() }, 0)
  }
  function armField(active: HTMLElement): void {
    if (deferredEl === active) return
    deferredEl?.removeEventListener('blur', onBlur)
    deferredEl = active
    active.addEventListener('blur', onBlur, { once: true })
  }
  return {
    arm: armField,
    dispose(): void {
      deferredEl?.removeEventListener('blur', onBlur)
      deferredEl = null
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}

/**
 * Copies `text` to the clipboard as plain text: the async Clipboard API where
 * present, else — or when it rejects (no permission, or file:// with no API at
 * all) — the classic hidden-textarea + `execCommand('copy')`.
 */
export function copyText(text: string): void {
  const viaTextarea = (): void => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy', false, undefined)
    document.body.removeChild(ta)
  }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(viaTextarea)
  else viaTextarea()
}
