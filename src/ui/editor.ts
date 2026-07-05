// src/ui/editor.ts — WYSIWYG contenteditable editor: markdown-backed rich
// text with keyboard shortcuts, auto-format-as-you-type, plain-text paste,
// @ref chip clicks, and @/  triggers for Tasks 16/17.
import type { Locale } from '../core/i18n'
import { t } from '../core/i18n'
import { el } from './dom'
import { mdToHtml, htmlToMd, parseRef, type RefInfo } from '../core/markdown'
import { showEditorHelp } from './help'

export interface Editor {
  root: HTMLElement
  getMd(): string
  setMd(md: string): void
  focus(): void
  destroy(): void
}

export interface EditorHooks {
  onChange(): void
  onRefClick(target: RefInfo['target']): void
  onAtTrigger(anchor: Range): void
  onSlashTrigger(anchor: Range): void
}

/**
 * Dispatched on the editor's contenteditable element (`.editor`) whenever
 * `hooks.onAtTrigger` fires, carrying the same Range as `event.detail`. This
 * lets modules that only hold the `Editor` handle (not the `EditorHooks`
 * object passed at construction time, e.g. src/ui/atref.ts) plug into the
 * `@` trigger without the caller having to wire it through manually.
 */
export const AT_TRIGGER_EVENT = 'tt-at-trigger'

/**
 * Dispatched on `.editor` whenever `hooks.onSlashTrigger` fires (typing `/`
 * on an empty line) *and* when the 📋 toolbar button is clicked, carrying a
 * collapsed Range at the insertion point as `event.detail`. Mirrors
 * AT_TRIGGER_EVENT so src/ui/template-picker.ts can plug into both trigger
 * sources through one decoupled entry point.
 */
export const SLASH_TRIGGER_EVENT = 'tt-slash-trigger'

const CHANGE_DEBOUNCE_MS = 300

// --- pure, unit-testable auto-format detection -----------------------------

export interface InlineMatch {
  start: number
  end: number
  marker: '**' | '*' | '~~'
  content: string
}

/**
 * Looks for a *closed* inline markdown span ending exactly at `caretOffset`
 * in `text` (the current block's plain text). Checked longest-marker-first
 * so `**bold**` doesn't get misread as a `*` pair.
 */
export function detectInlinePattern(text: string, caretOffset: number): InlineMatch | null {
  const before = text.slice(0, caretOffset)

  let m = /\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/.exec(before)
  if (m) return { start: m.index, end: caretOffset, marker: '**', content: m[1]! }

  m = /~~([^~\s](?:[^~]*[^~\s])?)~~$/.exec(before)
  if (m) return { start: m.index, end: caretOffset, marker: '~~', content: m[1]! }

  m = /(?:^|[^*])(\*([^*\s](?:[^*]*[^*\s])?)\*)$/.exec(before)
  if (m) {
    const whole = m[1]!
    const start = m.index + (m[0]!.length - whole.length)
    return { start, end: caretOffset, marker: '*', content: m[2]! }
  }

  return null
}

export interface BlockPrefixMatch {
  type: 'h1' | 'h2' | 'h3' | 'ul' | 'ol'
  prefixLen: number
}

/** Detects a markdown block-prefix (`# `, `- `, `1. `, ...) that makes up the ENTIRE current block text. */
export function detectBlockPrefix(text: string): BlockPrefixMatch | null {
  let m = /^(#{1,3}) $/.exec(text)
  if (m) return { type: (`h${m[1]!.length}` as 'h1' | 'h2' | 'h3'), prefixLen: m[0]!.length }

  if (/^- $/.test(text)) return { type: 'ul', prefixLen: 2 }

  m = /^\d+\. $/.exec(text)
  if (m) return { type: 'ol', prefixLen: m[0]!.length }

  return null
}

export function createEditor(hooks: EditorHooks, locale: Locale): Editor {
  const editorEl = el('div', { class: 'editor', contenteditable: 'true' })

  let changeTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleChange(): void {
    if (changeTimer !== null) clearTimeout(changeTimer)
    changeTimer = setTimeout(() => {
      changeTimer = null
      hooks.onChange()
    }, CHANGE_DEBOUNCE_MS)
  }

  function exec(cmd: string, value?: string): void {
    document.execCommand(cmd, false, value)
    scheduleChange()
  }

  // --- caret/block helpers --------------------------------------------------

  interface BlockCtx { block: HTMLElement; text: string; caretOffset: number }

  function currentBlockAndOffset(): BlockCtx | null {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    if (!editorEl.contains(range.startContainer)) return null

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

  /** Builds a Range spanning text offsets [start, end) within `block`'s text content. */
  function rangeForTextOffsets(block: HTMLElement, start: number, end: number): Range {
    const range = document.createRange()
    let remainingStart = start
    let remainingEnd = end
    let startSet = false
    let endSet = false
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const len = node.textContent?.length ?? 0
      if (!startSet && remainingStart <= len) {
        range.setStart(node, remainingStart)
        startSet = true
      }
      if (!endSet && remainingEnd <= len) {
        range.setEnd(node, remainingEnd)
        endSet = true
        break
      }
      remainingStart -= len
      remainingEnd -= len
    }
    if (!startSet) range.setStart(block, block.childNodes.length)
    if (!endSet) range.setEnd(block, block.childNodes.length)
    return range
  }

  function setCaretAfter(node: Node): void {
    const sel = window.getSelection()
    if (!sel) return
    const r = document.createRange()
    r.setStartAfter(node)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  }

  function applyBlockFormat(type: BlockPrefixMatch['type']): void {
    editorEl.focus()
    if (type === 'ul') document.execCommand('insertUnorderedList')
    else if (type === 'ol') document.execCommand('insertOrderedList')
    else document.execCommand('formatBlock', false, `<${type}>`)
  }

  function replaceInlineMatch(block: HTMLElement, match: InlineMatch): void {
    const range = rangeForTextOffsets(block, match.start, match.end)
    // If the matched span crosses an element boundary (e.g. a ref chip or
    // nested formatting inserted by autocomplete), rebuilding it from plain
    // textContent would silently destroy those elements. Bail out and leave
    // the raw markdown characters as typed; only text-only spans get
    // auto-formatted.
    if (range.cloneContents().querySelector('*')) return
    range.deleteContents()
    const tag = match.marker === '**' ? 'strong' : match.marker === '~~' ? 's' : 'em'
    const node = document.createElement(tag)
    node.textContent = match.content
    range.insertNode(node)
    setCaretAfter(node)
  }

  function handleAutoFormat(): void {
    const ctx = currentBlockAndOffset()
    if (!ctx) return
    const { block, text, caretOffset } = ctx

    if (caretOffset === text.length) {
      const blockMatch = detectBlockPrefix(text)
      if (blockMatch) {
        const range = rangeForTextOffsets(block, 0, blockMatch.prefixLen)
        range.deleteContents()
        applyBlockFormat(blockMatch.type)
        return
      }
    }

    const inlineMatch = detectInlinePattern(text, caretOffset)
    if (inlineMatch) replaceInlineMatch(block, inlineMatch)
  }

  function checkTriggers(): void {
    const ctx = currentBlockAndOffset()
    if (!ctx) return
    const { text, caretOffset } = ctx
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return

    if (caretOffset > 0 && text[caretOffset - 1] === '@') {
      const range = sel.getRangeAt(0).cloneRange()
      hooks.onAtTrigger(range)
      editorEl.dispatchEvent(new CustomEvent(AT_TRIGGER_EVENT, { detail: range, bubbles: true }))
    } else if (text === '/' && caretOffset === 1) {
      const range = sel.getRangeAt(0).cloneRange()
      hooks.onSlashTrigger(range)
      editorEl.dispatchEvent(new CustomEvent(SLASH_TRIGGER_EVENT, { detail: range, bubbles: true }))
    }
  }

  /**
   * 📋 toolbar action: opens the template picker at the current caret (or at
   * the end of the document if the editor has no live selection yet, e.g.
   * right after mount) rather than only on a typed "/" — same
   * SLASH_TRIGGER_EVENT entry point src/ui/template-picker.ts already
   * listens on for the keyboard trigger.
   */
  function openTemplatePicker(): void {
    const sel = window.getSelection()
    const live = sel && sel.rangeCount > 0 && sel.isCollapsed ? sel.getRangeAt(0) : null
    let range: Range
    // `live.startContainer === editorEl` (rather than a descendant block)
    // happens whenever focus() just moved onto the editor with no prior
    // selection inside it — including every toolbar-button click, since the
    // toolbar wrapper calls editorEl.focus() right before this action runs,
    // which some engines resolve to a collapsed selection anchored on
    // editorEl itself. That container can never be resolved to a block by
    // template-picker's (or the editor's own) block-walk, so treat it the
    // same as "no usable selection" and fall back to the end of the last
    // block instead of the end of editorEl itself.
    if (live && editorEl.contains(live.startContainer) && live.startContainer !== editorEl) {
      range = live.cloneRange()
    } else {
      range = document.createRange()
      const lastBlock = editorEl.lastElementChild
      range.selectNodeContents(lastBlock ?? editorEl)
      range.collapse(false)
      if (sel) { sel.removeAllRanges(); sel.addRange(range) }
    }
    editorEl.dispatchEvent(new CustomEvent(SLASH_TRIGGER_EVENT, { detail: range, bubbles: true }))
  }

  // --- event handlers --------------------------------------------------------

  function onInput(): void {
    handleAutoFormat()
    checkTriggers()
    scheduleChange()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    const key = e.key.toLowerCase()

    if (!e.shiftKey) {
      if (key === 'b') { e.preventDefault(); exec('bold'); return }
      if (key === 'i') { e.preventDefault(); exec('italic'); return }
      if (key === 'u') { e.preventDefault(); exec('underline'); return }
      if (e.code === 'Digit1') { e.preventDefault(); exec('formatBlock', '<h1>'); return }
      if (e.code === 'Digit2') { e.preventDefault(); exec('formatBlock', '<h2>'); return }
      if (e.code === 'Digit3') { e.preventDefault(); exec('formatBlock', '<h3>'); return }
      if (e.code === 'Digit0') { e.preventDefault(); exec('formatBlock', '<div>'); return }
      return
    }

    if (key === 'x') { e.preventDefault(); exec('strikeThrough'); return }
    if (e.code === 'Digit8') { e.preventDefault(); exec('insertUnorderedList'); return }
    if (e.code === 'Digit7') { e.preventDefault(); exec('insertOrderedList'); return }
  }

  function onPaste(e: ClipboardEvent): void {
    e.preventDefault()
    const text = e.clipboardData?.getData('text/plain') ?? ''
    document.execCommand('insertText', false, text)
    scheduleChange()
  }

  function onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null
    const refEl = target?.closest?.('a.ref') as HTMLAnchorElement | null
    if (!refEl) return
    e.preventDefault()
    const href = refEl.dataset.ref
    if (!href) return
    const parsed = parseRef(href)
    if (parsed) hooks.onRefClick(parsed)
  }

  editorEl.addEventListener('input', onInput)
  editorEl.addEventListener('keydown', onKeydown)
  editorEl.addEventListener('paste', onPaste)
  editorEl.addEventListener('click', onClick)

  // --- toolbar -----------------------------------------------------------

  function toolbarButton(glyph: string, title: string, action: () => void, extraClass?: string): HTMLButtonElement {
    return el(
      'button',
      {
        class: extraClass ? `tt-btn tt-editor-btn ${extraClass}` : 'tt-btn tt-editor-btn',
        type: 'button',
        title,
        onmousedown: (e: Event) => e.preventDefault(),
        onclick: () => {
          editorEl.focus()
          action()
        },
      },
      glyph
    )
  }

  const toolbar = el(
    'div',
    { class: 'tt-editor-toolbar' },
    toolbarButton('B', t(locale, 'editor_bold_title'), () => exec('bold'), 'tt-editor-btn-bold'),
    toolbarButton('I', t(locale, 'editor_italic_title'), () => exec('italic'), 'tt-editor-btn-italic'),
    toolbarButton('U', t(locale, 'editor_underline_title'), () => exec('underline'), 'tt-editor-btn-underline'),
    toolbarButton('S', t(locale, 'editor_strike_title'), () => exec('strikeThrough'), 'tt-editor-btn-strike'),
    toolbarButton('•', t(locale, 'editor_ul_title'), () => exec('insertUnorderedList')),
    toolbarButton('1.', t(locale, 'editor_ol_title'), () => exec('insertOrderedList')),
    toolbarButton('H1', t(locale, 'editor_h1_title'), () => exec('formatBlock', '<h1>')),
    toolbarButton('H2', t(locale, 'editor_h2_title'), () => exec('formatBlock', '<h2>')),
    toolbarButton('H3', t(locale, 'editor_h3_title'), () => exec('formatBlock', '<h3>')),
    toolbarButton('📋', t(locale, 'editor_templates_title'), () => openTemplatePicker()),
    el('span', { class: 'tt-editor-toolbar-spacer' }),
    toolbarButton('?', t(locale, 'editor_help_title'), () => showEditorHelp(locale))
  )

  const root = el('div', { class: 'tt-editor' }, toolbar, editorEl)

  function getMd(): string {
    return htmlToMd(editorEl)
  }

  function setMd(md: string): void {
    // A programmatic load can land within the debounce window of a prior
    // keystroke; without cancelling, the stale timer would fire onChange
    // against the newly-loaded document and falsely mark it dirty.
    if (changeTimer !== null) {
      clearTimeout(changeTimer)
      changeTimer = null
    }
    editorEl.innerHTML = mdToHtml(md)
  }

  function focus(): void {
    editorEl.focus()
  }

  function destroy(): void {
    if (changeTimer !== null) {
      clearTimeout(changeTimer)
      changeTimer = null
    }
    editorEl.removeEventListener('input', onInput)
    editorEl.removeEventListener('keydown', onKeydown)
    editorEl.removeEventListener('paste', onPaste)
    editorEl.removeEventListener('click', onClick)
  }

  return { root, getMd, setMd, focus, destroy }
}
