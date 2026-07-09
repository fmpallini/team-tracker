// src/ui/template-picker.ts — `/` template insertion: a caret-anchored
// dropdown (same interaction pattern as src/ui/atref.ts's `@` autocomplete)
// for inserting a quick template's resolved markdown at the trigger point.
// Opens both on the editor's own "/" trigger and on the 📋 toolbar button
// (both dispatch SLASH_TRIGGER_EVENT — see src/ui/editor.ts). Template
// management (create/edit/delete/reorder) is Task 24 — this module only
// inserts.
import { SLASH_TRIGGER_EVENT, type Editor } from './editor'
import { mdToHtml } from '../core/markdown'
import { resolveTemplate, type TemplateCtx } from '../core/templates'
import type { Template } from '../core/types'
import { t, type Locale } from '../core/i18n'
import { el } from './dom'

export interface TemplatePickerHandle {
  /** Closes any open dropdown and removes all document/element listeners this instance attached. Idempotent. */
  dispose(): void
}

export function attachTemplatePicker(editor: Editor, opts: {
  getTemplates(): Template[]
  getCtx(): TemplateCtx
  locale: Locale
}): TemplatePickerHandle {
  const editorEl = editor.root.querySelector<HTMLElement>('.editor')
  if (!editorEl) return { dispose() {} }

  let overlay: HTMLElement | null = null
  let listEl: HTMLElement | null = null
  let anchorRange: Range | null = null
  let items: Template[] = []
  let selected = 0
  // Captured once at open() time (mirrors src/ui/atref.ts's `lastLoc`) rather
  // than re-derived from window.getSelection() at commit time: real browsers
  // can clear/move the selection on a click at an external, non-input
  // element (engine-dependent focus/blur handling around contenteditable),
  // even with the row's mousedown preventDefault() — which made clicking a
  // template silently no-op (commit() bailed on a null blockAndCaret()).
  // Since no typing happens between open() and commit() (any further input
  // closes the picker via onTypingInput), the block/caret captured at open
  // time is still exactly where commit() needs to insert.
  let triggerCtx: BlockCtx | null = null

  // --- caret/block helpers (mirrors src/ui/editor.ts's private helpers;
  // duplicated rather than exported from there to keep this module fully
  // decoupled from the editor's internals, same rationale as src/ui/atref.ts
  // — it only depends on `.editor` being the contenteditable root and on the
  // SLASH_TRIGGER_EVENT contract). ---

  interface BlockCtx { block: HTMLElement; text: string; caretOffset: number }

  function blockAndCaret(): BlockCtx | null {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    if (!editorEl!.contains(range.startContainer)) return null
    let block: HTMLElement | null = null
    let n: Node | null = range.startContainer
    while (n && n !== editorEl) {
      if (n instanceof HTMLElement && (n.parentElement === editorEl || n.tagName === 'LI')) {
        block = n
        break
      }
      n = n.parentElement
    }
    if (!block) return null
    const preRange = document.createRange()
    preRange.selectNodeContents(block)
    preRange.setEnd(range.startContainer, range.startOffset)
    const caretOffset = preRange.toString().length
    return { block, text: block.textContent ?? '', caretOffset }
  }

  function setCaretAfter(node: Node): void {
    const sel = window.getSelection()
    if (!sel) return
    const r = document.createRange()
    // Several built-in templates end with an empty bullet meant for
    // immediate typing (e.g. "- " as the last line). Landing the caret after
    // the whole list would force an extra click/arrow-down before the user
    // could type into it — put it inside the list's last <li> instead.
    if (node instanceof HTMLElement && (node.tagName === 'UL' || node.tagName === 'OL')) {
      const lastLi = node.querySelector(':scope > li:last-child')
      if (lastLi) {
        r.selectNodeContents(lastLi)
        r.collapse(false)
        sel.removeAllRanges()
        sel.addRange(r)
        return
      }
    }
    r.setStartAfter(node)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  }

  // --- dropdown rendering ---------------------------------------------------

  function renderList(): void {
    if (!listEl) return
    listEl.innerHTML = ''
    if (items.length === 0) {
      listEl.appendChild(el('div', { class: 'tt-atref-item tt-templates-empty' }, t(opts.locale, 'template_picker_empty')))
      return
    }
    items.forEach((tpl, i) => {
      const row = el(
        'div',
        {
          class: 'tt-atref-item' + (i === selected ? ' selected' : ''),
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: () => commit(tpl),
          onmouseenter: () => { selected = i; renderList() },
        },
        tpl.name
      )
      listEl!.appendChild(row)
    })
  }

  function positionOverlay(): void {
    if (!overlay || !anchorRange) return
    // jsdom's Range does not implement getBoundingClientRect (real browsers
    // always do) — guard so tests can exercise the rest of the dropdown
    // lifecycle without a layout-capable DOM.
    if (typeof anchorRange.getBoundingClientRect !== 'function') return
    let rect = anchorRange.getBoundingClientRect()
    // A Range positioned at an element-child-index boundary rather than a
    // text-node offset (e.g. the 📋 toolbar button's fallback range in
    // editor.ts's openTemplatePicker, built via selectNodeContents+collapse
    // on a block with no live text selection) can report a degenerate
    // all-zero rect in real browsers instead of the actual caret position —
    // without this fallback the popup lands at the viewport's (0,0) instead
    // of near the cursor. Fall back to the trigger block's own element rect.
    if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0) {
      const container = anchorRange.startContainer
      const blockEl = container instanceof Element ? container : container.parentElement
      if (blockEl && typeof blockEl.getBoundingClientRect === 'function') {
        rect = blockEl.getBoundingClientRect()
      }
    }
    overlay.style.left = `${rect.left}px`
    overlay.style.top = `${rect.bottom}px`
  }

  // --- lifecycle: open on SLASH_TRIGGER_EVENT ------------------------------

  function onDocMousedown(e: MouseEvent): void {
    if (overlay?.contains(e.target as Node)) return
    close()
  }

  function onTypingInput(): void {
    // Any further edit while the picker is open (typing past the trigger,
    // or editing elsewhere) means the user isn't picking from the list —
    // close and leave whatever's on the line as-is.
    close()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selected = items.length ? Math.min(selected + 1, items.length - 1) : 0
      renderList()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selected = Math.max(selected - 1, 0)
      renderList()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(items[selected])
    }
  }

  function commit(tpl: Template | undefined): void {
    if (!tpl) { close(); return }
    const ctx = triggerCtx
    // Close (and detach the typing listeners) before mutating the document:
    // the inserted template's own text may start a fresh line, and if
    // onTypingInput were still attached the synthetic 'input' event dispatched
    // below would immediately close over a stale context.
    close()
    if (!ctx) return

    const html = mdToHtml(resolveTemplate(tpl.body, opts.getCtx()))
    const container = document.createElement('div')
    container.innerHTML = html
    const nodes = Array.from(container.childNodes)
    if (nodes.length === 0) return
    const lastNode = nodes[nodes.length - 1]!

    if (ctx.block.tagName === 'LI') {
      // The trigger landed inside a list item — a bare "/" bullet (keyboard
      // trigger) or a bullet caret via the 📋 button. Template blocks can
      // never nest validly inside a <ul>/<ol>: htmlToMd only reads a list's
      // direct <li> children (see src/core/markdown.ts's htmlToMd), so
      // anything else appended inside the list is silently dropped on the
      // next markdown round-trip. They always land as siblings of the
      // *enclosing top-level list* (walking up past any nested lists to the
      // one whose parent is the editor root), never of the <li> itself.
      const li = ctx.block
      let listNode = li.parentElement as HTMLElement
      while (listNode.parentElement !== editorEl) {
        listNode = listNode.parentElement as HTMLElement
      }
      const isBlankLi = ctx.text === '' || ctx.text === '/'
      if (isBlankLi) {
        // Mirrors the non-LI branch below discarding the "/"-only block
        // wholesale: clear the trigger text, then drop the now-empty <li>
        // (or the whole list, if it was the only item) once the template's
        // blocks are safely inserted after the list.
        li.textContent = ''
        listNode.after(...nodes)
        if (listNode.querySelectorAll(':scope > li').length === 1) listNode.remove()
        else li.remove()
      } else {
        // Caret mid-bullet (📋 button on a non-empty list item): leave the
        // <li> and its content untouched, same as the non-empty-line case
        // below.
        listNode.after(...nodes)
      }
    } else {
      // The trigger line is either the literal "/" the user typed (keyboard
      // trigger) or an empty line (toolbar button on a blank line): both get
      // replaced wholesale by the template's blocks, so headings/lists land as
      // direct children of the editor root — same shape htmlToMd expects from
      // a freshly loaded document (see Editor.setMd) — instead of nesting them
      // inside the trigger line's now-empty <div>, which htmlToMd cannot walk.
      // A toolbar click on a *non-empty* line instead inserts the template
      // right after that line, leaving its content untouched.
      const isBlankTriggerLine = ctx.block.parentElement === editorEl && (ctx.text === '' || ctx.text === '/')
      if (isBlankTriggerLine) ctx.block.replaceWith(...nodes)
      else ctx.block.after(...nodes)
    }

    setCaretAfter(lastNode)
    editorEl!.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function close(): void {
    if (!overlay) return
    overlay.remove()
    overlay = null
    listEl = null
    anchorRange = null
    triggerCtx = null
    editorEl!.removeEventListener('input', onTypingInput)
    editorEl!.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('mousedown', onDocMousedown, true)
  }

  function open(range: Range): void {
    close()
    anchorRange = range
    triggerCtx = blockAndCaret()
    items = opts.getTemplates()
    selected = 0
    listEl = el('div', { class: 'tt-atref-list' })
    overlay = el('div', { class: 'tt-atref-dropdown' }, listEl)
    document.body.appendChild(overlay)
    positionOverlay()
    renderList()
    editorEl!.addEventListener('input', onTypingInput)
    editorEl!.addEventListener('keydown', onKeydown, true)
    document.addEventListener('mousedown', onDocMousedown, true)
  }

  const onSlashTriggerEvent = ((e: Event) => {
    open((e as CustomEvent<Range>).detail)
  }) as EventListener
  editorEl.addEventListener(SLASH_TRIGGER_EVENT, onSlashTriggerEvent)

  return {
    dispose(): void {
      close()
      editorEl!.removeEventListener(SLASH_TRIGGER_EVENT, onSlashTriggerEvent)
    },
  }
}
