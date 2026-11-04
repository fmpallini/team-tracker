// Undo/redo for the editor's hand-made DOM edits (Task: undo after autoformat).
//
// The editor leans on the browser's native undo stack (execCommand typing,
// insertHTML, delete). That stack only knows edits the browser made itself: an
// edit the editor makes by moving nodes around (autoformat `- ` → list, Tab
// indent, Enter out of a quote, a mention chip, a link swap) is invisible to
// it. Ctrl+Z then either does nothing visible or undoes the typing underneath
// while the converted block stays, and the stack drifts out of step with the DOM.
//
// `record(fn)` runs such an edit under a MutationObserver and keeps the exact
// mutations, node identities included. Ctrl+Z / Ctrl+Shift+Z then take the
// recorded edit back/forward themselves when it is the newest thing in the
// document, and leave everything else to the browser. Node identity is what
// keeps the browser's own stack valid: its older steps still point at the same
// nodes, because an undo here puts the very same nodes back.
//
// Which side owns the next Ctrl+Z is decided by comparing the document's
// structure with the one the newest recorded edit left behind: equal means no
// browser step happened since (or each was undone), so the recorded edit is next.

/** Structural key of the editor: element names and text, ignoring what is only decoration (attributes, highlight spans in a code block, pictures). */
export function structureKey(root: Node): string {
  let out = ''
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) { out += n.nodeValue ?? ''; return }
    if (!(n instanceof Element)) return
    const tag = n.tagName
    if (tag === 'IMG') return
    out += `<${tag}>`
    if (tag === 'PRE') out += n.textContent ?? ''
    else n.childNodes.forEach(walk)
    out += `</${tag}>`
  }
  root.childNodes.forEach(walk)
  return out
}

interface Caret { sc: Node; so: number; ec: Node; eo: number }

interface Entry {
  records: MutationRecord[]
  /** Text and attribute values the edit left behind, for replaying it. */
  textAfter: Map<Node, string>
  attrAfter: Map<Element, Map<string, string | null>>
  keyBefore: string
  keyAfter: string
  caretBefore: Caret | null
  caretAfter: Caret | null
}

const MAX_ENTRIES = 100

const OBSERVE: MutationObserverInit = {
  childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true,
}

export interface EditHistory {
  /** Runs a hand-made DOM edit so Ctrl+Z / Ctrl+Shift+Z can reverse and replay it. Do not call execCommand inside `fn`. */
  record<T>(fn: () => T): T
  /** Reverses the newest recorded edit if it is next in line. True when it did (the caller stops the browser's own undo). */
  undo(): boolean
  /** Replays the edit most recently reversed, if it is next in line. */
  redo(): boolean
  /** Forgets everything — the document was replaced or the editor is gone. */
  clear(): void
  /** A browser-made edit happened: whatever was reversed can no longer be replayed. */
  dropRedo(): void
}

export function createEditHistory(root: HTMLElement, onApplied: () => void): EditHistory {
  const undoStack: Entry[] = []
  let redoStack: Entry[] = []
  let recording = false

  const caretNow = (): Caret | null => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const r = sel.getRangeAt(0)
    return root.contains(r.startContainer) && root.contains(r.endContainer)
      ? { sc: r.startContainer, so: r.startOffset, ec: r.endContainer, eo: r.endOffset }
      : null
  }

  const setCaret = (c: Caret | null): void => {
    const sel = window.getSelection()
    if (!sel || !c || !root.contains(c.sc) || !root.contains(c.ec)) return
    try {
      const r = document.createRange()
      r.setStart(c.sc, Math.min(c.so, nodeLength(c.sc)))
      r.setEnd(c.ec, Math.min(c.eo, nodeLength(c.ec)))
      sel.removeAllRanges()
      sel.addRange(r)
    } catch { /* a stale offset only costs the caret position */ }
  }

  function record<T>(fn: () => T): T {
    if (recording) return fn()
    redoStack = []
    const keyBefore = structureKey(root)
    const caretBefore = caretNow()
    const obs = new MutationObserver(() => { /* records are taken synchronously below */ })
    obs.observe(root, OBSERVE)
    recording = true
    let result: T
    try {
      result = fn()
    } finally {
      recording = false
      const records = obs.takeRecords()
      obs.disconnect()
      if (records.length > 0) push(records, keyBefore, caretBefore)
    }
    return result
  }

  function push(records: MutationRecord[], keyBefore: string, caretBefore: Caret | null): void {
    const textAfter = new Map<Node, string>()
    const attrAfter = new Map<Element, Map<string, string | null>>()
    for (const r of records) {
      if (r.type === 'characterData') textAfter.set(r.target, r.target.nodeValue ?? '')
      else if (r.type === 'attributes' && r.attributeName && r.target instanceof Element) {
        const attrs = attrAfter.get(r.target) ?? new Map<string, string | null>()
        attrs.set(r.attributeName, r.target.getAttribute(r.attributeName))
        attrAfter.set(r.target, attrs)
      }
    }
    const keyAfter = structureKey(root)
    // An edit that changed nothing the user could see has nothing to undo.
    if (keyAfter === keyBefore && records.every((r) => r.type !== 'childList')) return
    undoStack.push({ records, textAfter, attrAfter, keyBefore, keyAfter, caretBefore, caretAfter: caretNow() })
    if (undoStack.length > MAX_ENTRIES) undoStack.shift()
  }

  function undo(): boolean {
    const entry = undoStack[undoStack.length - 1]
    if (!entry || structureKey(root) !== entry.keyAfter) return false
    undoStack.pop()
    for (let i = entry.records.length - 1; i >= 0; i--) invert(entry.records[i]!)
    redoStack.push(entry)
    setCaret(entry.caretBefore)
    onApplied()
    return true
  }

  function redo(): boolean {
    const entry = redoStack[redoStack.length - 1]
    if (!entry || structureKey(root) !== entry.keyBefore) return false
    redoStack.pop()
    for (const r of entry.records) replay(r, entry)
    undoStack.push(entry)
    setCaret(entry.caretAfter)
    onApplied()
    return true
  }

  return {
    record,
    undo,
    redo,
    clear: () => { undoStack.length = 0; redoStack = [] },
    dropRedo: () => { redoStack = [] },
  }
}

const nodeLength = (n: Node): number => (n.nodeType === Node.TEXT_NODE ? (n.nodeValue ?? '').length : n.childNodes.length)

/** Puts back what one mutation changed. Called newest-first, so each record's neighbours are the ones it saw. */
function invert(r: MutationRecord): void {
  if (r.type === 'childList') {
    r.addedNodes.forEach((n) => n.parentNode?.removeChild(n))
    const ref = r.nextSibling && r.nextSibling.parentNode === r.target ? r.nextSibling : null
    r.removedNodes.forEach((n) => r.target.insertBefore(n, ref))
  } else if (r.type === 'characterData') {
    r.target.nodeValue = r.oldValue
  } else if (r.type === 'attributes' && r.attributeName && r.target instanceof Element) {
    if (r.oldValue === null) r.target.removeAttribute(r.attributeName)
    else r.target.setAttribute(r.attributeName, r.oldValue)
  }
}

/** Applies one mutation again, oldest-first (the mirror of `invert`). */
function replay(r: MutationRecord, entry: Entry): void {
  if (r.type === 'childList') {
    r.removedNodes.forEach((n) => n.parentNode?.removeChild(n))
    const ref = r.nextSibling && r.nextSibling.parentNode === r.target ? r.nextSibling : null
    r.addedNodes.forEach((n) => r.target.insertBefore(n, ref))
  } else if (r.type === 'characterData') {
    const v = entry.textAfter.get(r.target)
    if (v !== undefined) r.target.nodeValue = v
  } else if (r.type === 'attributes' && r.attributeName && r.target instanceof Element) {
    const v = entry.attrAfter.get(r.target)?.get(r.attributeName)
    if (v === null) r.target.removeAttribute(r.attributeName)
    else if (v !== undefined) r.target.setAttribute(r.attributeName, v)
  }
}

// Mention pickers and the template picker live in their own files but edit the
// same document; they reach the journal of the editor they were opened on here.
const registry = new WeakMap<HTMLElement, EditHistory>()

export function registerEditHistory(root: HTMLElement, history: EditHistory): void { registry.set(root, history) }
export function unregisterEditHistory(root: HTMLElement): void { registry.delete(root) }

/** Runs `fn` as a recorded edit of `root`'s editor, or plainly when `root` is not one. */
export function recordEdit<T>(root: HTMLElement, fn: () => T): T {
  const h = registry.get(root)
  return h ? h.record(fn) : fn()
}
