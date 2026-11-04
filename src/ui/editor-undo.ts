// src/ui/editor-undo.ts — the editor's own undo/redo stack and step policy
// (docs/superpowers/specs/2026-11-03-editor-undo-snapshots-design.md). The
// browser's native history is never used: the editor intercepts the keys and
// `historyUndo`/`historyRedo` (and takes back a native step that
// execCommand('undo') ran with no beforeinput), and calls undo()/redo() here.
//
// Only the state *before* a step is stored. An action site calls checkpoint()
// before its first change; that stores a *pending* snapshot, which becomes an
// undo entry only once a MutationObserver sees the document change (an edit
// that changes nothing leaves no entry and keeps redo). A step is "open" for
// the rest of the current task, so several checkpoints of one user action make
// one step. Typing is a run: it opens on the first insert/delete input and
// closes on an input-kind change, Enter, a caret jump or 1 s idle. A caret jump
// is a `selectionchange` that finds the caret somewhere other than where the
// last input left it (noteInput): `selectionchange` is async and coalesced, so
// the typing's own event can arrive after the user already moved the caret,
// and an input that moves no caret (Delete at the end) fires none at all.

import { takeSnapshot, sameBlocks, restoreSnapshot, applyView, type Snapshot } from './editor-snapshot'

export interface UndoDeps {
  root: HTMLElement
  /**
   * Post-restore passes on the replaced top-level blocks (decoration, pictures, chip labels). `removed` are
   * the live blocks they took the place of, for view state a snapshot does not hold (a collapsed code block).
   */
  afterRestore(replaced: HTMLElement[], removed: HTMLElement[]): void
  /** The editor's scheduleChange: the store must receive the restored markdown. */
  onChange(): void
  isReadOnly(): boolean
}

export interface UndoStack {
  /** Stores a pending before-snapshot; no-op while a step is open. */
  checkpoint(): void
  /** True whenever the editor handled the request (even with nothing to undo), false only when read-only. */
  undo(): boolean
  redo(): boolean
  /** Ctrl/Cmd+Z, +Shift+Z, Ctrl/Cmd+Y. preventDefaults and returns true when handled. */
  handleKeydown(e: KeyboardEvent): boolean
  /** Opens/closes typing runs and steps from the input type. Call before the browser mutates. */
  handleBeforeInput(e: InputEvent): void
  /** The editor's `input`, after its own handling: records the caret the edit left. */
  noteInput(): void
  /** A `selectionchange` on the document: closes the run when the caret is not where the last input left it. */
  noteSelectionChange(): void
  closeRun(): void
  /**
   * compositionstart/compositionend of the editor. While composing the run never closes by idle or
   * caret movement, so one IME composition is one step.
   */
  setComposing(composing: boolean): void
  /** Empties both stacks (setMd); the stack keeps working. */
  clear(): void
  /** Empties both stacks and stops the observer. */
  destroy(): void
}

const MAX_ENTRIES = 100
const IDLE_MS = 1000

type RunKind = 'insert' | 'delete'

interface Caret { an: Node | null; ao: number; fn: Node | null; fo: number }

function readCaret(root: HTMLElement): Caret | null {
  const sel = root.ownerDocument.getSelection()
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) return null
  return { an: sel.anchorNode, ao: sel.anchorOffset, fn: sel.focusNode, fo: sel.focusOffset }
}

function sameCaret(a: Caret | null, b: Caret | null): boolean {
  if (!a || !b) return a === b
  return a.an === b.an && a.ao === b.ao && a.fn === b.fn && a.fo === b.fo
}

/** The key's logical letter: the produced Latin letter, else (Cyrillic etc.) the physical key. */
function keyLetter(e: KeyboardEvent): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  const m = /^Key([A-Z])$/.exec(e.code)
  return m ? m[1]!.toLowerCase() : null
}

function push(stack: Snapshot[], s: Snapshot): void {
  stack.push(s)
  if (stack.length > MAX_ENTRIES) stack.shift()
}

export function createUndoStack(deps: UndoDeps): UndoStack {
  const { root } = deps
  const undoStack: Snapshot[] = []
  const redoStack: Snapshot[] = []
  let pending: Snapshot | null = null
  let stepOpen = false
  let run: { kind: RunKind } | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let composing = false
  let lastCaret: Caret | null = null

  /** Pending becomes an entry only if the document really changed (net of presentation-only DOM work). */
  function commit(): void {
    if (!pending) return
    if (sameBlocks(pending, takeSnapshot(root))) return
    push(undoStack, pending)
    redoStack.length = 0
    pending = null
  }

  const observer = new MutationObserver((records) => { if (records.length > 0) commit() })
  observer.observe(root, { childList: true, characterData: true, subtree: true })

  /** The observer callback is async; synchronous callers flush what it has not delivered yet. */
  function drain(): void {
    if (observer.takeRecords().length > 0) commit()
  }

  /** Drops mutation records not yet delivered (our own restore work is not an edit). */
  function discardRecords(): void {
    observer.takeRecords()
  }

  function stopIdle(): void {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
  }

  function closeRun(): void {
    drain()
    if (!run) return
    run = null
    stopIdle()
    pending = null
  }

  function checkpoint(): void {
    drain()
    if (stepOpen) return
    closeRun()
    const mine = takeSnapshot(root)
    pending = mine
    stepOpen = true
    queueMicrotask(() => { stepOpen = false })
    // An edit that changes nothing must not leave a pending snapshot that a later,
    // unrelated DOM change (a chip relabel) would turn into an entry. A macrotask
    // runs after the browser's default action for the beforeinput that opened it.
    setTimeout(() => {
      drain()
      if (pending === mine && !run) pending = null
    }, 0)
  }

  function restoreFrom(from: Snapshot[], to: Snapshot[]): boolean {
    if (deps.isReadOnly()) return false
    drain()
    closeRun()
    pending = null
    stepOpen = false
    const live = takeSnapshot(root)
    // An entry equal to the live document is a no-op: drop it so it costs no key press.
    let target = from.pop()
    while (target && sameBlocks(target, live)) target = from.pop()
    if (!target) return true
    push(to, live)
    const removed: HTMLElement[] = []
    const replaced = restoreSnapshot(root, target, removed)
    deps.afterRestore(replaced, removed)
    // The passes can change heights (a code block's lines, a chip's label) and re-home the caret: the
    // user's place is applied again once they are done.
    applyView(root, target)
    discardRecords()
    deps.onChange()
    discardRecords()
    return true
  }

  function handleBeforeInput(e: InputEvent): void {
    if (deps.isReadOnly()) return
    const type = e.inputType
    if (type === 'historyUndo' || type === 'historyRedo') return
    if (type === 'insertParagraph' || type === 'insertLineBreak') {
      // Enter is its own step: end any run, then open a one-shot step.
      closeRun()
      checkpoint()
      return
    }
    const kind: RunKind | null =
      type === 'insertText' || type.includes('Composition') ? 'insert'
        : type.startsWith('deleteContent') ? 'delete'
          : null
    if (kind === null) { checkpoint(); return }
    drain()
    // An explicit checkpoint of this very action (paste, cut, a command) already covers it.
    if (stepOpen) return
    if (run && run.kind !== kind) closeRun()
    if (!run) {
      pending = takeSnapshot(root)
      run = { kind }
    }
    armIdle()
  }

  function armIdle(): void {
    stopIdle()
    if (!composing) idleTimer = setTimeout(closeRun, IDLE_MS)
  }

  function setComposing(value: boolean): void {
    composing = value
    if (value) stopIdle()
    else if (run) armIdle()
  }

  function noteInput(): void {
    lastCaret = readCaret(root)
  }

  function noteSelectionChange(): void {
    const now = readCaret(root)
    // The caret where the typing itself (or the composition) put it keeps the run open.
    if (run && !composing && !sameCaret(now, lastCaret)) closeRun()
    lastCaret = now
  }

  function handleKeydown(e: KeyboardEvent): boolean {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return false
    const letter = keyLetter(e)
    let redo: boolean
    if (letter === 'z') redo = e.shiftKey
    else if (letter === 'y' && !e.shiftKey) redo = true
    else return false
    if (deps.isReadOnly()) return false
    e.preventDefault()
    if (redo) api.redo()
    else api.undo()
    return true
  }

  function clear(): void {
    discardRecords()
    undoStack.length = 0
    redoStack.length = 0
    pending = null
    run = null
    stepOpen = false
    composing = false
    lastCaret = null
    stopIdle()
  }

  const api: UndoStack = {
    checkpoint,
    undo: () => restoreFrom(undoStack, redoStack),
    redo: () => restoreFrom(redoStack, undoStack),
    handleKeydown,
    handleBeforeInput,
    noteInput,
    noteSelectionChange,
    closeRun,
    setComposing,
    clear,
    destroy() {
      observer.disconnect()
      clear()
    },
  }
  return api
}

// Mention pickers and the template picker live in their own files but edit the
// same document; they reach the stack of the editor they were opened on here.
const registry = new WeakMap<HTMLElement, UndoStack>()

export function registerUndo(root: HTMLElement, u: UndoStack): void { registry.set(root, u) }
export function unregisterUndo(root: HTMLElement): void { registry.delete(root) }

/** Runs `fn` as an undoable edit of `root`'s editor, or plainly when `root` is not one. */
export function recordEdit<T>(root: HTMLElement, fn: () => T): T {
  registry.get(root)?.checkpoint()
  return fn()
}
