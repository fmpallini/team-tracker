// src/ui/editor.ts — WYSIWYG contenteditable editor: markdown-backed rich
// text with keyboard shortcuts, auto-format-as-you-type, plain-text paste,
// @ref chip clicks, and @/  triggers for Tasks 16/17.
import type { Locale } from '../core/i18n'
import { t } from '../core/i18n'
import { el, clampToViewport } from './dom'
import { mdToHtml, htmlToMd, htmlToPlainText, parseRef, unwrapBlockContainers, flattenNestedHeadings, flattenNestedBlockquotes, demoteHeadings, BLOCK_TAGS, MAX_LIST_DEPTH, type RefInfo, type LabelResolver } from '../core/markdown'
import { showEditorHelp } from './help'
import { paintSelection, clampMove, selectableRowProps } from './select-list'
import { blockedByModal, matchKey } from './hotkeys'

export interface Editor {
  root: HTMLElement
  getMd(): string
  setMd(md: string): void
  /**
   * Patches every `a.ref[data-ref]` chip's visible text in place via
   * `hooks.resolveRefLabel`, without touching anything else in the DOM —
   * unlike setMd(), safe to call while the user is actively typing elsewhere
   * in this same editor. Chips are `contenteditable="false"` leaves, so a
   * live caret/selection can never sit inside one; patching their
   * `textContent` cannot perturb it. No-op if `hooks.resolveRefLabel` was
   * never supplied, or (per-chip) if it returns null for a given ref — same
   * "leave the frozen label alone" fallback setMd's initial parse already
   * uses.
   */
  refreshRefLabels(): void
  focus(): void
  destroy(): void
}

export interface EditorHooks {
  onChange(): void
  onRefClick(target: RefInfo['target'], opts: { secondary: boolean }): void
  onAtTrigger(anchor: Range): void
  onSlashTrigger(anchor: Range): void
  /** Optional: resolves a ref chip's *current* label from live team data instead of trusting the frozen text baked into stored markdown. Omitted by callers (e.g. template-picker.ts's preview) that have no team-scoped data to resolve against. */
  resolveRefLabel?: LabelResolver
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
const TAB_INDENT = '\u00a0\u00a0\u00a0\u00a0'

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
  type: 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'hr'
  prefixLen: number
}

/* eslint-disable no-irregular-whitespace -- the character classes below intentionally contain a literal U+00A0 non-breaking space alongside the regular space; see the doc comment for why. */
/**
 * Detects a markdown block-prefix (`# `, `- `, `1. `, ...) that makes up the
 * ENTIRE current block text. The trailing space is matched as `[  ]`,
 * not a literal space: real Chrome substitutes a non-breaking space for
 * whitespace at the edge of a text node (to stop HTML's normal whitespace
 * collapsing from eating it) — exactly the position a space lands in right
 * after typing "- "/"1. " at the start of an empty line, so the literal-space
 * regex never actually matched real typed input.
 */
export function detectBlockPrefix(text: string): BlockPrefixMatch | null {
  let m = /^(#{1,3})[  ]$/.exec(text)
  if (m) return { type: (`h${m[1]!.length}` as 'h1' | 'h2' | 'h3'), prefixLen: m[0]!.length }

  if (/^-[  ]$/.test(text)) return { type: 'ul', prefixLen: 2 }

  m = /^\d+\.[  ]$/.exec(text)
  if (m) return { type: 'ol', prefixLen: m[0]!.length }

  m = /^(-{3,})[  ]$/.exec(text)
  if (m) return { type: 'hr', prefixLen: m[0]!.length }

  return null
}
/* eslint-enable no-irregular-whitespace */

/** Leading run of indent chars (space or the non-breaking space Tab inserts), capped at 4 — how much Shift+Tab removes in one press. */
export function leadingIndentLen(text: string): number {
  let n = 0
  while (n < text.length && n < 4 && (text[n] === ' ' || text[n] === '\u00a0')) n++
  return n
}

/**
 * Every editor currently alive, so `flushAllEditors()` can reach them.
 * Entries are added at construction and removed by `destroy()`.
 *
 * A registry rather than a walk of the pane tree because editors also live
 * outside it — action-items.ts mounts one inside its card modal — and those
 * hold exactly the same unsaved keystrokes. Module-level state is safe here
 * because membership is tied to construct/destroy, and closing a file destroys
 * every module (and so every editor) it mounted.
 */
const liveEditors = new Set<{ flush(): void }>()

/**
 * Commits every live editor's pending debounced change into the store *now*.
 *
 * For callers about to persist the document from outside the editing flow —
 * saving on tab-hide/unload, or saving right before tearing the document down.
 * Without it, a save firing within CHANGE_DEBOUNCE_MS of a keystroke writes a
 * document that does not yet contain it, and on the teardown paths that
 * document is the last one written.
 *
 * Non-destructive: editors keep working afterwards, so it is safe on paths
 * (tab-hide) where the user comes back to a live session.
 */
export function flushAllEditors(): void {
  for (const ed of Array.from(liveEditors)) {
    try {
      ed.flush()
    } catch (e) {
      console.error(e)
    }
  }
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

  /**
   * Cancels a pending debounced change WITHOUT running it — for `setMd()`,
   * where the pending change belongs to a document that is being replaced (see
   * its own comment). Every other teardown path wants `flushChange()` instead:
   * dropping there loses the user's last keystrokes outright.
   */
  function cancelChange(): void {
    if (changeTimer === null) return
    clearTimeout(changeTimer)
    changeTimer = null
  }

  /**
   * Runs a pending debounced change NOW instead of waiting out the remaining
   * debounce. `destroy()` calls this because teardown is not a reason to
   * discard an edit: ui/panes.ts tears a module down on every pane/module/team
   * switch, so a switch landing inside the CHANGE_DEBOUNCE_MS window after a
   * keystroke used to drop those characters silently — they never reached the
   * store, so they were never saved either.
   *
   * Safe to call after ui/panes.ts's `container.innerHTML = ''`: that detaches
   * `editorEl` but leaves its subtree intact, and `hooks.onChange()` reads the
   * markdown back off `editorEl` itself (see rich-editor.ts), not off the DOM
   * it used to be mounted in.
   */
  function flushChange(): void {
    if (changeTimer === null) return
    clearTimeout(changeTimer)
    changeTimer = null
    hooks.onChange()
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

  function closestLi(node: Node): HTMLElement | null {
    let n: Node | null = node
    while (n && n !== editorEl) {
      if (n instanceof HTMLElement && n.tagName === 'LI') return n
      n = n.parentElement
    }
    return null
  }

  function listItemDepth(li: HTMLElement): number {
    let depth = 0
    let n: HTMLElement | null = li.parentElement
    while (n && n !== editorEl) {
      if (n.tagName === 'LI') depth++
      n = n.parentElement
    }
    return depth
  }

  /** Nests `items` (sibling <li>s, in document order) under the previous
   * sibling of the first one, as that sibling's nested sub-list (reusing one
   * if it already has one). No-op if there's no previous sibling to nest
   * under, or the batch is already at MAX_LIST_DEPTH. Returns whether it
   * actually moved anything (callers use this to decide whether the caret
   * needs restoring afterward — see restoreCaret). */
  function indentListItems(items: HTMLElement[]): boolean {
    const first = items[0]
    if (!first || listItemDepth(first) >= MAX_LIST_DEPTH) return false
    const prev = first.previousElementSibling as HTMLElement | null
    if (!prev || prev.tagName !== 'LI') return false
    const parentList = first.parentElement as HTMLElement
    let sub = prev.querySelector(':scope > ul, :scope > ol') as HTMLElement | null
    if (!sub) {
      sub = document.createElement(parentList.tagName.toLowerCase())
      prev.appendChild(sub)
    }
    items.forEach(li => sub!.appendChild(li))
    scheduleChange()
    return true
  }

  /** The <li> a nested <ul>/<ol> is logically nested under. Usually just
   * `list.parentElement`, but contenteditable editing at depth can leave the
   * sub-list one step off from that: wrapped in a stray <div>/<p> inside the
   * <li> (walk up past non-<li> element wrappers), or as a direct child of
   * the ancestor list, sibling to the <li> it followed (take that previous
   * <li> sibling). Mirrors core/markdown.ts's nestedListsOf() tolerance so
   * Tab/Shift+Tab and htmlToMd agree on what counts as nested. null when the
   * list is genuinely top-level. */
  function listContainerLi(list: HTMLElement): HTMLElement | null {
    let n: HTMLElement | null = list.parentElement
    while (n && n !== editorEl && n.tagName !== 'LI') {
      if (n.tagName === 'UL' || n.tagName === 'OL') {
        let prev = list.previousElementSibling as HTMLElement | null
        while (prev && prev.tagName !== 'LI') prev = prev.previousElementSibling as HTMLElement | null
        return prev
      }
      n = n.parentElement
    }
    return n && n.tagName === 'LI' ? n : null
  }

  /** Promotes `items` (sibling <li>s, in document order) out one level, into
   * the list they're nested under as new siblings right after the item they
   * were nested under. Any items after `items` in the same nested list move
   * with them, becoming children of the last promoted item (preserves
   * hierarchy). No-op at depth 0. Returns whether it actually moved
   * anything (callers use this to decide whether the caret needs restoring
   * afterward — see restoreCaret). */
  function outdentListItems(items: HTMLElement[]): boolean {
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return false
    const list = first.parentElement as HTMLElement
    const parentLi = listContainerLi(list)
    if (!parentLi) return false
    const grandList = parentLi.parentElement as HTMLElement

    const trailing: HTMLElement[] = []
    let sib = last.nextElementSibling
    while (sib) { trailing.push(sib as HTMLElement); sib = sib.nextElementSibling }
    if (trailing.length > 0) {
      let sub = last.querySelector(':scope > ul, :scope > ol') as HTMLElement | null
      if (!sub) {
        sub = document.createElement(list.tagName.toLowerCase())
        last.appendChild(sub)
      }
      trailing.forEach(li => sub!.appendChild(li))
    }

    const insertBefore = parentLi.nextElementSibling
    items.forEach(li => grandList.insertBefore(li, insertBefore))
    if (list.children.length === 0) list.remove()
    scheduleChange()
    return true
  }

  /* Task 4: resolves the list item(s) a Tab/Shift+Tab keypress should act
   * on. A collapsed caret or a selection within a single item resolves to
   * that one item. A selection spanning multiple sibling `<li>`s (same
   * parent `<ul>/<ol>`) resolves to the whole ordered batch. A selection
   * whose start/end land in list items that aren't siblings (mixed-depth
   * selection) falls back to just the item containing the selection's
   * start point. */
  function selectedListItems(): HTMLElement[] {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return []
    const range = sel.getRangeAt(0)
    const startLi = closestLi(range.startContainer)
    if (!startLi) return []
    const endLi = closestLi(range.endContainer)
    if (!endLi || endLi === startLi) return [startLi]
    if (startLi.parentElement !== endLi.parentElement) return [startLi]
    const siblings = Array.from(startLi.parentElement!.children).filter(
      (c): c is HTMLElement => c instanceof HTMLElement && c.tagName === 'LI'
    )
    const startIdx = siblings.indexOf(startLi)
    const endIdx = siblings.indexOf(endLi)
    return siblings.slice(Math.min(startIdx, endIdx), Math.max(startIdx, endIdx) + 1)
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

  /** Collapses the caret to a text offset within `block` (typically an `<li>`
   * just moved by indentListItems/outdentListItems). Moving list nodes via
   * insertBefore/appendChild invalidates the browser's live selection, which
   * Chrome then "recovers" by dropping the caret onto the nearest surviving
   * node — usually the line above the item that was just indented/outdented.
   * Called right after the move so the caret visibly stays put. */
  function restoreCaret(block: HTMLElement, offset: number): void {
    const sel = window.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(rangeForTextOffsets(block, offset, offset))
  }

  function applyBlockFormat(type: BlockPrefixMatch['type']): void {
    editorEl.focus()
    if (type === 'ul') document.execCommand('insertUnorderedList', false, undefined)
    else if (type === 'ol') document.execCommand('insertOrderedList', false, undefined)
    else { document.execCommand('formatBlock', false, `<${type}>`); flattenNestedHeadings(editorEl) }
  }

  /**
   * Ctrl+1/2/3 (and the toolbar H1/H2/H3/¶ buttons) route through here rather
   * than a bare `exec('formatBlock', ...)`: on a multi-line selection or a
   * list block, Chromium's formatBlock *nests* a fresh <hN> inside the block
   * instead of replacing it, and every repeat stacks another wrapper whose
   * relative `2em` size compounds — the heading visibly doubles on each
   * keypress. flattenNestedHeadings() undoes that right after.
   */
  function formatBlockTag(tag: 'h1' | 'h2' | 'h3' | 'div' | 'p'): void {
    editorEl.focus()
    document.execCommand('formatBlock', false, `<${tag}>`)
    flattenNestedHeadings(editorEl)
    scheduleChange()
  }

  /**
   * Normalizes every `<blockquote>` under `root` so it holds only inline
   * content separated by `<br>` — exactly the shape `mdToHtml` emits
   * (`<blockquote>line one<br>line two</blockquote>`). Chromium's
   * `execCommand('formatBlock', '<blockquote>')` on a MULTI-LINE selection
   * instead produces `<blockquote><div>l1</div><div>l2</div></blockquote>`,
   * and `htmlToMd`'s blockquote branch only splits inner lines on `<br>`, so
   * without this those `<div>`s merge into one line (`> l1l2`), losing the
   * breaks. Each child `<div>`/`<p>` is replaced by its own child nodes
   * followed by a `<br>`; a trailing `<br>` is dropped so there's no empty
   * last line. Left untouched when the blockquote already has no block-level
   * child (the common single-line / `<br>`-joined case).
   */
  function normalizeBlockquoteChildren(root: HTMLElement): void {
    root.querySelectorAll('blockquote').forEach((bq) => {
      const kids = Array.from(bq.childNodes)
      const hasBlockChild = kids.some(
        (n) => n instanceof HTMLElement && (n.tagName === 'DIV' || n.tagName === 'P')
      )
      if (!hasBlockChild) return
      const frag = (root.ownerDocument ?? document).createDocumentFragment()
      kids.forEach((n) => {
        if (n instanceof HTMLElement && (n.tagName === 'DIV' || n.tagName === 'P')) {
          while (n.firstChild) frag.appendChild(n.firstChild)
          frag.appendChild((root.ownerDocument ?? document).createElement('br'))
        } else {
          frag.appendChild(n)
        }
      })
      if (frag.lastChild instanceof HTMLElement && frag.lastChild.tagName === 'BR') {
        frag.removeChild(frag.lastChild)
      }
      bq.replaceChildren()
      bq.appendChild(frag)
    })
  }

  /**
   * The ❝ button / Ctrl+Shift+9. Chromium's formatBlock can nest a fresh
   * <blockquote> inside an existing one on a repeat press or multi-line
   * selection; this app's blockquote is flat, so flattenNestedBlockquotes
   * collapses that right after — same pattern as formatBlockTag + headings.
   * normalizeBlockquoteChildren then flattens any inner <div>/<p> lines
   * (also a multi-line-selection artefact) to <br>-separated inline content
   * so htmlToMd keeps the line breaks.
   */
  function toggleBlockquote(): void {
    editorEl.focus()
    document.execCommand('formatBlock', false, '<blockquote>')
    flattenNestedBlockquotes(editorEl)
    normalizeBlockquoteChildren(editorEl)
    scheduleChange()
  }

  /**
   * The 🧹 button. `removeFormat` alone (per spec) only strips inline
   * formatting — bold/italic/underline/strike/colour — and leaves block
   * styling untouched, so a heading would survive the broom. Google Docs and
   * Word both also drop the heading style on "clear formatting", so
   * demoteHeadings() reverts any heading the selection touches to a plain
   * paragraph. List nesting is left as-is (neither product strips it either).
   */
  function clearFormatting(): void {
    // Snapshot the selection before focus()/removeFormat can move or drop it.
    const sel = window.getSelection()
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
    editorEl.focus()
    document.execCommand('removeFormat', false, undefined)
    if (range) demoteHeadings(editorEl, range)
    scheduleChange()
  }

  /**
   * The `<>` button. Wraps a non-empty selection in <code>, or unwraps it if
   * it already sits fully inside one. Bails on a selection that crosses an
   * element boundary (a ref chip, existing inline formatting) — same
   * "text-only spans only" rule replaceInlineMatch uses, since rebuilding a
   * <code> from plain text would silently destroy any element inside it.
   */
  function toggleInlineCode(): void {
    editorEl.focus()
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    if (!editorEl.contains(range.commonAncestorContainer)) return

    const container = range.commonAncestorContainer
    const host = container instanceof HTMLElement ? container : container.parentElement
    const existing = host?.closest('code')
    if (existing && editorEl.contains(existing)) {
      const parent = existing.parentNode!
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing)
      parent.removeChild(existing)
      scheduleChange()
      return
    }
    if (range.cloneContents().querySelector('*')) return
    const code = document.createElement('code')
    code.textContent = range.toString()
    range.deleteContents()
    range.insertNode(code)
    setCaretAfter(code)
    scheduleChange()
  }

  /**
   * Replaces an emptied-out top-level block with a one-item `<ul>`/`<ol>`,
   * built directly rather than via document.execCommand('insertUnorderedList'
   * /'insertOrderedList'). Unlike formatBlock (used for headings, which
   * tolerates this fine), the list insertUnorderedList/insertOrderedList
   * commands are notoriously unreliable across real browser engines when run
   * against a *collapsed selection in an empty block* — exactly the state
   * left right after typing "- " or "1. " and stripping the prefix — and can
   * silently no-op instead of creating the list.
   */
  function convertBlockToList(block: HTMLElement, type: 'ul' | 'ol'): void {
    editorEl.focus()
    const li = document.createElement('li')
    li.appendChild(document.createElement('br'))
    const list = document.createElement(type)
    list.appendChild(li)
    block.replaceWith(list)
    const r = document.createRange()
    r.selectNodeContents(li)
    r.collapse(true)
    const sel = window.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(r) }
  }

  /**
   * Replaces an emptied-out top-level block with `<hr>` followed by a fresh
   * empty block for the caret — unlike convertBlockToList's <li>, an <hr> is
   * a void element and can never hold a caret itself.
   */
  function convertBlockToHr(block: HTMLElement): void {
    editorEl.focus()
    const hr = document.createElement('hr')
    const next = document.createElement('div')
    next.appendChild(document.createElement('br'))
    block.replaceWith(hr, next)
    const r = document.createRange()
    r.selectNodeContents(next)
    r.collapse(true)
    const sel = window.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(r) }
  }

  /**
   * The — toolbar button. Inserts an <hr> right after the caret's current
   * top-level block (or after the last block if the caret isn't inside one),
   * and moves the caret to the block that follows the rule — reusing the
   * next existing block when there is one, or a fresh empty <div> when the
   * rule lands at the end of the document (an <hr> is a void element and
   * can't hold a caret itself). Does not split a block mid-line — the typed
   * "---" autoformat already handles "turn THIS line into a rule", and
   * end-of-line is where the button is actually used.
   *
   * Only synthesizes the trailing empty <div> when nothing follows: an
   * empty block between the rule and real content would serialize back as a
   * stray blank markdown line (`---\n\ntext`).
   */
  function insertHr(): void {
    editorEl.focus()
    const ctx = currentBlockAndOffset()
    const ref = ctx && ctx.block.parentElement === editorEl ? ctx.block : editorEl.lastElementChild
    const hr = document.createElement('hr')
    let caretTarget: HTMLElement
    const following = ref?.nextElementSibling as HTMLElement | null
    if (ref && following) {
      ref.after(hr)
      caretTarget = following
    } else {
      const next = document.createElement('div')
      next.appendChild(document.createElement('br'))
      if (ref) ref.after(hr, next)
      else editorEl.append(hr, next)
      caretTarget = next
    }
    const r = document.createRange()
    r.selectNodeContents(caretTarget)
    r.collapse(true)
    const sel = window.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(r) }
    scheduleChange()
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
        if (blockMatch.type === 'hr') {
          // Unlike ul/ol (which fall through to the generic prefix-strip +
          // applyBlockFormat path below when not top-level, since that path
          // can still produce a valid nested list), '---' inside a list item
          // has no valid representation (htmlToMd only reads a list's direct
          // <li> children) and applyBlockFormat('hr') has no handling for
          // 'hr' at all (execCommand('formatBlock', false, '<hr>') no-ops).
          // So always return here, converting only when top-level, and
          // otherwise leaving the typed "--- " as literal text untouched.
          if (block.parentElement === editorEl) convertBlockToHr(block)
          return
        }
        if ((blockMatch.type === 'ul' || blockMatch.type === 'ol') && block.parentElement === editorEl) {
          convertBlockToList(block, blockMatch.type)
          return
        }
        const range = rangeForTextOffsets(block, 0, blockMatch.prefixLen)
        range.deleteContents()
        const sel = window.getSelection()
        if (sel) { sel.removeAllRanges(); sel.addRange(range) }
        applyBlockFormat(blockMatch.type)
        return
      }
    }

    const inlineMatch = detectInlinePattern(text, caretOffset)
    if (inlineMatch) replaceInlineMatch(block, inlineMatch)
  }

  /**
   * contenteditable's native "select all + delete" (Ctrl+A, Backspace) can
   * leave editorEl with no wrapping block at all — unlike setMd(), which
   * (via core/markdown.ts's mdToHtml) always leaves at least one <div>,
   * even for an empty string. currentBlockAndOffset()'s block-walk needs a
   * real block ancestor of the caret to compute a text offset from; with
   * none, it silently returns null, so handleAutoFormat()/checkTriggers()
   * (bold/italic auto-format, @ and / triggers) all no-op on whatever gets
   * typed right into that bare state — until the user creates a block some
   * other way, e.g. pressing Enter. Re-wrap any content already typed
   * directly into editorEl (a bare text node from this same keystroke, a
   * stray <br>, ...) into a real block before those checks run, restoring
   * the invariant setMd() normally guarantees. Explicitly re-homes the
   * caret afterwards rather than trusting the moved Range/Selection to
   * still track it across the reparent.
   */
  function ensureBlock(): void {
    if (editorEl.children.length > 0) return
    const sel = window.getSelection()
    const liveRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
    const caretNode = liveRange?.startContainer ?? null
    const caretOffset = liveRange?.startOffset ?? 0

    const div = document.createElement('div')
    while (editorEl.firstChild) div.appendChild(editorEl.firstChild)
    if (div.childNodes.length === 0) div.appendChild(document.createElement('br'))
    editorEl.appendChild(div)

    // Re-home the caret explicitly rather than relying on the moved Range
    // to still track it — restores the exact same node/offset, just now
    // reachable through `div`.
    if (sel && caretNode && div.contains(caretNode)) {
      const r = document.createRange()
      r.setStart(caretNode, caretOffset)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
    }
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
   * Resolves a Range at the current caret if one lives inside the editor,
   * else falls back to the end of the last block (or the editor itself if
   * empty) and moves the live selection there. Shared by toolbar actions
   * that need an insertion point when the editor may not have focus yet —
   * every toolbar-button click calls editorEl.focus() right before its
   * action runs, which some engines resolve to a collapsed selection
   * anchored on editorEl itself rather than a descendant block; that
   * container can never be resolved to a block by the caret/block-walk
   * helpers, so it's treated the same as "no usable selection".
   */
  function caretOrEndRange(): Range {
    const sel = window.getSelection()
    const live = sel && sel.rangeCount > 0 && sel.isCollapsed ? sel.getRangeAt(0) : null
    if (live && editorEl.contains(live.startContainer) && live.startContainer !== editorEl) {
      return live.cloneRange()
    }
    const range = document.createRange()
    const lastBlock = editorEl.lastElementChild
    range.selectNodeContents(lastBlock ?? editorEl)
    range.collapse(false)
    if (sel) { sel.removeAllRanges(); sel.addRange(range) }
    return range
  }

  /**
   * 📋 toolbar action: opens the template picker at the current caret (or at
   * the end of the document if the editor has no live selection yet) rather
   * than only on a typed "/" — same SLASH_TRIGGER_EVENT entry point
   * src/ui/template-picker.ts already listens on for the keyboard trigger.
   */
  function openTemplatePicker(): void {
    const range = caretOrEndRange()
    editorEl.dispatchEvent(new CustomEvent(SLASH_TRIGGER_EVENT, { detail: range, bubbles: true }))
  }

  /**
   * @ toolbar action: inserts "@" at the current caret (or at the end of the
   * document if the editor has no live selection yet) via the same
   * execCommand('insertText', ...) path real typing takes, so the native
   * 'input' event this fires drives checkTriggers() to open the @
   * autocomplete exactly as if the user had typed it themselves.
   */
  function insertAtTrigger(): void {
    caretOrEndRange()
    exec('insertText', '@')
  }

  /**
   * Copies the editor's current content to the clipboard as rich (formatted)
   * content. Writes a raw `text/html` string we build ourselves via the
   * async Clipboard API rather than selecting DOM + execCommand('copy') —
   * the browser's own copy serializer computes an "effective" background for
   * the copied fragment by walking up through transparent ancestors to the
   * first opaque paint it finds, which lands on `<body>`'s `background:
   * var(--bg)` even when the immediate wrapper is explicitly transparent.
   * Writing the HTML string directly sidesteps that ambient-style capture
   * entirely — nothing here ever specifies a background.
   */
  function copyFormatted(): void {
    const html = editorEl.innerHTML
    const text = htmlToPlainText(editorEl)
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      navigator.clipboard
        .write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([text], { type: 'text/plain' }),
          }),
        ])
        .catch(() => copyFormattedViaSelection())
      return
    }
    copyFormattedViaSelection()
  }

  /** Fallback for browsers/contexts without the async Clipboard API's write() (or where it's denied at runtime) — selects a detached, background-free clone of the editor's *children* (not editorEl itself, whose `.editor` class carries the ruled-paper background texture) and uses the classic execCommand('copy'). */
  function copyFormattedViaSelection(): void {
    const wrapper = document.createElement('div')
    wrapper.style.position = 'fixed'
    wrapper.style.left = '-9999px'
    wrapper.style.top = '0'
    wrapper.style.background = '#fff'
    editorEl.childNodes.forEach((child) => wrapper.appendChild(child.cloneNode(true)))
    document.body.appendChild(wrapper)
    const range = document.createRange()
    range.selectNodeContents(wrapper)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    document.execCommand('copy', false, undefined)
    sel?.removeAllRanges()
    document.body.removeChild(wrapper)
  }

  /** Fallback for browsers/contexts (e.g. file:// with no Clipboard API) where navigator.clipboard is unavailable — the classic hidden-textarea + execCommand('copy') technique. */
  function copyViaTextarea(text: string): void {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy', false, undefined)
    document.body.removeChild(ta)
  }

  /** Copies the editor's current content to the clipboard as plain text (no markdown syntax, no HTML — just the readable text a screen would show, with line breaks preserved). */
  function copyPlain(): void {
    const text = htmlToPlainText(editorEl)
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => copyViaTextarea(text))
    } else {
      copyViaTextarea(text)
    }
  }

  /** Copies the editor's current content to the clipboard as its raw markdown source (the same text the field is stored as). */
  function copyMarkdown(): void {
    const text = htmlToMd(editorEl)
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => copyViaTextarea(text))
    } else {
      copyViaTextarea(text)
    }
  }

  // --- copy-options menu (🗐 toolbar button) --------------------------------
  // A static 3-item dropdown (plain / formatted / markdown), anchored to the
  // toolbar button rather than the caret — reuses the atref/template-picker
  // dropdown's visual styling (.tt-atref-dropdown/-list/-item) and row
  // mechanics (select-list.ts's paintSelection/clampMove/selectableRowProps),
  // now including their keyboard nav (Up/Down + Enter), and clamped to the
  // viewport on open the same way ui/context-menu.ts and
  // ui/backlinks-panel.ts's popovers are.

  let copyMenuEl: HTMLElement | null = null
  let copyMenuListEl: HTMLElement | null = null
  let copyMenuOptions: [string, () => void][] = []
  let copyMenuSelected = 0

  function closeCopyMenu(): void {
    if (!copyMenuEl) return
    copyMenuEl.remove()
    copyMenuEl = null
    copyMenuListEl = null
    copyMenuOptions = []
    document.removeEventListener('mousedown', onCopyMenuDocMousedown, true)
    document.removeEventListener('keydown', onCopyMenuKeydown, true)
  }

  function onCopyMenuDocMousedown(e: MouseEvent): void {
    if (copyMenuEl?.contains(e.target as Node)) return
    closeCopyMenu()
  }

  function onCopyMenuKeydown(e: KeyboardEvent): void {
    // Same reasoning as panes.ts's pane-module dropdown: an async modal can
    // appear while this menu is still open, and this is a capturing document
    // listener — without this guard Enter here would copy to the clipboard
    // behind the modal.
    if (blockedByModal()) return
    if (e.key === 'Escape') { e.preventDefault(); closeCopyMenu(); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      copyMenuSelected = clampMove(copyMenuSelected, e.key === 'ArrowDown' ? 1 : -1, copyMenuOptions.length)
      paintSelection(copyMenuListEl, '.tt-atref-item', copyMenuSelected)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const option = copyMenuOptions[copyMenuSelected]
      if (option) { option[1](); closeCopyMenu() }
    }
  }

  function openCopyMenu(anchor: HTMLElement): void {
    closeCopyMenu()
    copyMenuOptions = [
      [t(locale, 'editor_copy_option_plain'), copyPlain],
      [t(locale, 'editor_copy_option_formatted'), copyFormatted],
      [t(locale, 'editor_copy_option_markdown'), copyMarkdown],
    ]
    copyMenuSelected = 0
    const listEl = el(
      'div',
      { class: 'tt-atref-list' },
      ...copyMenuOptions.map(([label, action], i) =>
        el(
          'div',
          selectableRowProps({
            class: 'tt-atref-item',
            selected: i === copyMenuSelected,
            onCommit: () => { action(); closeCopyMenu() },
            onHover: () => { copyMenuSelected = i; paintSelection(copyMenuListEl, '.tt-atref-item', copyMenuSelected) },
          }),
          label
        )
      )
    )
    copyMenuListEl = listEl
    copyMenuEl = el('div', { class: 'tt-atref-dropdown' }, listEl)
    document.body.appendChild(copyMenuEl)
    const rect = anchor.getBoundingClientRect()
    copyMenuEl.style.left = `${rect.left}px`
    copyMenuEl.style.top = `${rect.bottom}px`

    // Clamp to the viewport — a toolbar button near the right/bottom edge of
    // a pane (the common case for the right pane in split view) would
    // otherwise open partly or fully off-screen. Same pattern as
    // ui/context-menu.ts/ui/backlinks-panel.ts's popovers.
    clampToViewport(copyMenuEl)

    document.addEventListener('mousedown', onCopyMenuDocMousedown, true)
    document.addEventListener('keydown', onCopyMenuKeydown, true)
  }

  // --- event handlers --------------------------------------------------------

  // The browser's own caret-follow scroll only moves the minimum distance
  // needed to bring the caret flush to the bottom edge — the `.editor`
  // bottom padding gives room to scroll into manually, but typing at the
  // bottom never reaches it on its own, so the caret still hugs the edge.
  // This tops that up: whenever the caret ends up within
  // CARET_SCROLL_MARGIN_PX of the bottom, scroll further so that margin of
  // room stays visible below it as you keep typing.
  const CARET_SCROLL_MARGIN_PX = 56

  /**
   * A collapsed Range's `getBoundingClientRect()` comes back an all-zero
   * rect at exactly the position that matters here — the caret sitting
   * right at the end of a line/block, which is where typing happens — so
   * relying on it alone silently no-ops on every real keystroke. Falls back
   * to the caret's containing block (always has real layout) when that
   * happens.
   */
  function caretRect(): DOMRect | null {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    if (!editorEl.contains(range.startContainer)) return null
    if (typeof range.getBoundingClientRect !== 'function') return null // jsdom has no layout engine
    const rect = range.getBoundingClientRect()
    if (rect.height > 0) return rect
    const ctx = currentBlockAndOffset()
    return ctx ? ctx.block.getBoundingClientRect() : null
  }

  function keepCaretVisible(): void {
    const rect = caretRect()
    if (!rect) return
    const editorRect = editorEl.getBoundingClientRect()
    const overflow = rect.bottom + CARET_SCROLL_MARGIN_PX - editorRect.bottom
    if (overflow > 0) editorEl.scrollTop += overflow
  }

  function onInput(): void {
    ensureBlock()
    handleAutoFormat()
    checkTriggers()
    scheduleChange()
    keepCaretVisible()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const ctx = currentBlockAndOffset()
      if (ctx && ctx.block.parentElement === editorEl && ctx.caretOffset === ctx.text.length && /^-{3,}$/.test(ctx.text)) {
        e.preventDefault()
        convertBlockToHr(ctx.block)
        scheduleChange()
        return
      }
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      const listItems = selectedListItems()
      if (listItems.length > 0) {
        const ctx = currentBlockAndOffset() // collapsed-caret case only; null for multi-item selections
        const moved = e.shiftKey ? outdentListItems(listItems) : indentListItems(listItems)
        if (moved) restoreCaret(ctx ? (ctx.block) : listItems[0]!, ctx ? ctx.caretOffset : 0)
        return
      }
      if (e.shiftKey) {
        const ctx = currentBlockAndOffset()
        if (ctx) {
          const n = leadingIndentLen(ctx.text)
          if (n > 0) {
            const range = rangeForTextOffsets(ctx.block, 0, n)
            range.deleteContents()
            const sel = window.getSelection()
            if (sel) {
              sel.removeAllRanges()
              const newOffset = Math.max(0, ctx.caretOffset - n)
              sel.addRange(rangeForTextOffsets(ctx.block, newOffset, newOffset))
            }
            scheduleChange()
          }
        }
      } else {
        exec('insertText', TAB_INDENT)
      }
      return
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return

    if (!e.shiftKey) {
      if (matchKey(e, 'b')) { e.preventDefault(); exec('bold'); return }
      if (matchKey(e, 'i')) { e.preventDefault(); exec('italic'); return }
      if (matchKey(e, 'u')) { e.preventDefault(); exec('underline'); return }
      if (e.code === 'Digit1') { e.preventDefault(); formatBlockTag('h1'); return }
      if (e.code === 'Digit2') { e.preventDefault(); formatBlockTag('h2'); return }
      if (e.code === 'Digit3') { e.preventDefault(); formatBlockTag('h3'); return }
      if (e.code === 'Digit0') { e.preventDefault(); formatBlockTag('div'); return }
      return
    }

    // Strikethrough takes both Ctrl+Shift+X (the cross-app convention: Google
    // Docs, Slack, Discord, GitHub) and Ctrl+Shift+5. The X chord is the
    // primary, but some Windows browsers / vendor keyboard drivers swallow it
    // before it reaches the page, so its keydown never fires — Digit5 is the
    // fallback that always lands, sits with the Ctrl+Shift+7/8 list shortcuts,
    // and matched physically (e.code) rides over layout differences. Toolbar S
    // button and `~~text~~` markdown are the mouse/typing alternatives.
    if (e.code === 'KeyX' || e.code === 'Digit5') { e.preventDefault(); exec('strikeThrough'); return }
    if (e.code === 'Digit8') { e.preventDefault(); exec('insertUnorderedList'); return }
    if (e.code === 'Digit7') { e.preventDefault(); exec('insertOrderedList'); return }
  }

  /**
   * Converts pasted `text/html` into this editor's markdown dialect via the
   * same htmlToMd() used to read the editor's own DOM — so paste round-trips
   * through the identical block/list/inline rules setMd/getMd already rely
   * on, instead of a bespoke parser. htmlToMd expects block-level children
   * (div/p/ul/ol/h1-3/hr) at the root, which is always true of the editor's
   * own markup but not of arbitrary clipboard HTML — a fragment with no
   * block-level top node (e.g. copying just a bolded word out of another
   * app) is wrapped in one synthetic <div> first so it reads as a single
   * line instead of losing its wrapping context.
   *
   * Parsed via DOMParser rather than an innerHTML-assigned <div>: an
   * innerHTML'd element still belongs to the live document, so a malicious
   * clipboard payload like `<img src=x onerror=...>` starts loading (and can
   * fire its handler) the instant it's parsed, before htmlToMd ever reads it
   * back out. DOMParser's result is a separate, inert document — same
   * script realm (so `instanceof HTMLElement` still holds for its nodes),
   * but never a fully active document, so it doesn't fetch resources or run
   * handlers. Most of the parsed tree's attributes are discarded anyway —
   * htmlToMd/inlineMd only reads a small allow-listed tag set and never
   * copies attributes across, EXCEPT for `<a data-ref>` ref chips, whose
   * data-ref core/markdown.ts's inlineMd re-embeds verbatim into the
   * rebuilt markdown, and mdToHtml's inline() later splices back into a
   * literal `data-ref="${ref}"` attribute. sanitizeRefAttrs() below closes
   * off that one path: without it, a crafted data-ref can break out of that
   * attribute once inline()'s *later* bold/italic/tilde regexes run over
   * the already-substituted markup (confirmed with an actual injection
   * test, not just inspection — see test/editor.test.ts).
   */
  const SAFE_REF_ID = /^[A-Za-z0-9-]+$/

  /**
   * Strips `data-ref` from any parsed `<a>` whose value isn't a genuine,
   * safely-shaped ref (a recognized kind — see core/markdown.ts's parseRef —
   * followed only by the letters/digits/hyphens this app's own ref ids
   * (`crypto.randomUUID()`) and dates ever use). A ref chip copied out of
   * this app's own "Copy formatted" always has an id in exactly that shape,
   * so this never affects a legitimate paste — it only disarms a
   * maliciously crafted data-ref, which falls back to its plain visible
   * text (inlineMd's default case) instead of becoming a ref chip.
   */
  function sanitizeRefAttrs(wrapper: HTMLElement): void {
    wrapper.querySelectorAll<HTMLElement>('a[data-ref]').forEach((a) => {
      const ref = a.dataset.ref ?? ''
      const idPart = ref.slice(ref.indexOf(':') + 1)
      if (!parseRef(ref) || !SAFE_REF_ID.test(idPart)) a.removeAttribute('data-ref')
    })
  }

  function htmlClipboardToMd(html: string): string {
    // Untrusted clipboard HTML parsed here only ever reaches execCommand('insertHTML', ...)
    // below after inline() (markdown.ts) escapes all text and reinserts it via
    // Private-Use-Area placeholders, so attribute/tag breakout isn't possible — see the
    // ref-placeholder-safety tests in test/markdown.test.ts. CodeQL's js/xss sink model
    // can't see that custom sanitization and re-flags this DOMParser->insertHTML shape on
    // every refactor of this function; verified false positive (alerts #1 and #2).
    // codeql[js/xss]
    const wrapper = new DOMParser().parseFromString(html, 'text/html').body
    sanitizeRefAttrs(wrapper)
    // Splits a Google-Docs-style "whole paste wrapped in one non-block
    // container" fragment into real, separately-rendered blocks before the
    // block-child check below — see unwrapBlockContainers' own doc comment.
    unwrapBlockContainers(wrapper)
    const hasBlockChild = Array.from(wrapper.children).some((c) => BLOCK_TAGS.has(c.tagName.toLowerCase()))
    if (!hasBlockChild) {
      const line = wrapper.ownerDocument.createElement('div')
      while (wrapper.firstChild) line.appendChild(wrapper.firstChild)
      wrapper.appendChild(line)
    }
    return htmlToMd(wrapper)
  }

  function onPaste(e: ClipboardEvent): void {
    e.preventDefault()
    const html = e.clipboardData?.getData('text/html')
    const md = html ? htmlClipboardToMd(html) : ''
    if (md.trim()) {
      document.execCommand('insertHTML', false, mdToHtml(md, hooks.resolveRefLabel, t(locale, 'editor_ref_hint')))
      scheduleChange()
      return
    }
    const text = e.clipboardData?.getData('text/plain') ?? ''
    document.execCommand('insertText', false, text)
    scheduleChange()
  }

  function refElFromEvent(e: MouseEvent): HTMLAnchorElement | null {
    const target = e.target as HTMLElement | null
    return target?.closest?.('a.ref') as HTMLAnchorElement | null
  }

  function handleRefActivate(e: MouseEvent): void {
    const refEl = refElFromEvent(e)
    if (!refEl) return
    e.preventDefault()
    const href = refEl.dataset.ref
    if (!href) return
    const parsed = parseRef(href)
    if (parsed) hooks.onRefClick(parsed, { secondary: e.ctrlKey || e.metaKey || e.button === 1 })
  }

  function onClick(e: MouseEvent): void {
    handleRefActivate(e)
  }

  function onAuxClick(e: MouseEvent): void {
    if (e.button !== 1) return
    handleRefActivate(e)
  }

  // Middle-mousedown on a ref chip would otherwise trigger the browser's
  // autoscroll-pan cursor (the chip has no real `href`, so there's no
  // native middle-click-opens-in-new-tab behavior to preserve).
  function onMouseDownForRef(e: MouseEvent): void {
    if (e.button !== 1) return
    if (refElFromEvent(e)) e.preventDefault()
  }

  editorEl.addEventListener('input', onInput)
  editorEl.addEventListener('keydown', onKeydown)
  editorEl.addEventListener('paste', onPaste)
  editorEl.addEventListener('click', onClick)
  editorEl.addEventListener('auxclick', onAuxClick)
  editorEl.addEventListener('mousedown', onMouseDownForRef)

  // --- toolbar -----------------------------------------------------------

  function toolbarButton(glyph: string, title: string, action: (btn: HTMLButtonElement) => void, extraClass?: string): HTMLButtonElement {
    const btn: HTMLButtonElement = el(
      'button',
      {
        class: extraClass ? `tt-btn tt-editor-btn ${extraClass}` : 'tt-btn tt-editor-btn',
        type: 'button',
        title,
        tabindex: '-1',
        onmousedown: (e: Event) => e.preventDefault(),
        onclick: () => {
          // `onmousedown` preventDefault keeps focus (and thus the live
          // selection) in the editor when a real pointer clicks a toolbar
          // button, so the `editorEl.focus()` below is a no-op there. But a
          // synthetic `.click()` (jsdom, and any programmatic caller) skips
          // mousedown, and jsdom's `focus()` COLLAPSES the current selection
          // on the focus transition — which breaks selection-driven actions
          // like `toggleInlineCode`. Snapshot the selection first and restore
          // it after focus when it still points inside the editor.
          const sel = window.getSelection()
          const saved = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
          editorEl.focus()
          if (sel && saved && editorEl.contains(saved.commonAncestorContainer)) {
            sel.removeAllRanges()
            sel.addRange(saved)
          }
          action(btn)
        },
      },
      glyph
    )
    return btn
  }

  const toolbar = el(
    'div',
    { class: 'tt-editor-toolbar' },
    toolbarButton('B', t(locale, 'editor_bold_title'), () => exec('bold'), 'tt-editor-btn-bold'),
    toolbarButton('I', t(locale, 'editor_italic_title'), () => exec('italic'), 'tt-editor-btn-italic'),
    toolbarButton('U', t(locale, 'editor_underline_title'), () => exec('underline'), 'tt-editor-btn-underline'),
    toolbarButton('S', t(locale, 'editor_strike_title'), () => exec('strikeThrough'), 'tt-editor-btn-strike'),
    toolbarButton('<>', t(locale, 'editor_code_title'), () => toggleInlineCode()),
    toolbarButton('•', t(locale, 'editor_ul_title'), () => exec('insertUnorderedList')),
    toolbarButton('1.', t(locale, 'editor_ol_title'), () => exec('insertOrderedList')),
    toolbarButton('H1', t(locale, 'editor_h1_title'), () => formatBlockTag('h1')),
    toolbarButton('H2', t(locale, 'editor_h2_title'), () => formatBlockTag('h2')),
    toolbarButton('H3', t(locale, 'editor_h3_title'), () => formatBlockTag('h3')),
    toolbarButton('¶', t(locale, 'editor_paragraph_title'), () => formatBlockTag('p')),
    toolbarButton('❝', t(locale, 'editor_quote_title'), () => toggleBlockquote()),
    toolbarButton('—', t(locale, 'editor_hr_title'), () => insertHr()),
    toolbarButton('🧹', t(locale, 'editor_clear_format_title'), () => clearFormatting()),
    toolbarButton('📋', t(locale, 'editor_templates_title'), () => openTemplatePicker()),
    toolbarButton('@', t(locale, 'editor_insert_ref_title'), () => insertAtTrigger()),
    el('span', { class: 'tt-editor-toolbar-spacer' }),
    toolbarButton('🗐', t(locale, 'editor_copy_options_title'), (btn) => openCopyMenu(btn)),
    toolbarButton('?', t(locale, 'editor_help_title'), () => showEditorHelp(locale))
  )

  const root = el('div', { class: 'tt-editor' }, toolbar, editorEl)

  function getMd(): string {
    return htmlToMd(editorEl)
  }

  function setMd(md: string): void {
    // A programmatic load can land within the debounce window of a prior
    // keystroke; without cancelling, the stale timer would fire onChange
    // against the newly-loaded document and falsely mark it dirty. Cancel,
    // not flush — unlike destroy(), the pending change here belongs to
    // content that is being replaced outright.
    cancelChange()
    editorEl.innerHTML = mdToHtml(md, hooks.resolveRefLabel, t(locale, 'editor_ref_hint'))
  }

  function refreshRefLabels(): void {
    const resolve = hooks.resolveRefLabel
    if (!resolve) return
    editorEl.querySelectorAll<HTMLAnchorElement>('a.ref[data-ref]').forEach((chip) => {
      const target = parseRef(chip.dataset.ref ?? '')
      if (!target) return
      const resolved = resolve(target)
      if (resolved === null) return
      const label = `@${resolved}`
      if (chip.textContent !== label) chip.textContent = label
    })
  }

  function focus(): void {
    editorEl.focus()
  }

  function destroy(): void {
    liveEditors.delete(registryEntry)
    // Flush, don't drop — see flushChange(). Runs before the listeners come
    // off so ordering matches a normal debounce firing.
    flushChange()
    closeCopyMenu()
    editorEl.removeEventListener('input', onInput)
    editorEl.removeEventListener('keydown', onKeydown)
    editorEl.removeEventListener('paste', onPaste)
    editorEl.removeEventListener('click', onClick)
    editorEl.removeEventListener('auxclick', onAuxClick)
    editorEl.removeEventListener('mousedown', onMouseDownForRef)
  }

  const registryEntry = { flush: flushChange }
  liveEditors.add(registryEntry)

  return { root, getMd, setMd, refreshRefLabels, focus, destroy }
}
