import { createUndoStack, registerUndo, unregisterUndo, recordEdit, type UndoStack, type UndoDeps } from '../src/ui/editor-undo'

interface Harness {
  root: HTMLElement
  u: UndoStack
  deps: { afterRestore: ReturnType<typeof vi.fn>; onChange: ReturnType<typeof vi.fn>; readOnly: boolean }
}

const made: Harness[] = []

function setup(html = '<div>a</div><div>b</div><div>c</div>'): Harness {
  const root = document.createElement('div')
  root.setAttribute('contenteditable', 'true')
  root.innerHTML = html
  document.body.appendChild(root)
  const deps = { afterRestore: vi.fn(), onChange: vi.fn(), readOnly: false }
  const d: UndoDeps = {
    root,
    afterRestore: (r) => deps.afterRestore(r),
    onChange: () => deps.onChange(),
    isReadOnly: () => deps.readOnly,
  }
  const h: Harness = { root, u: createUndoStack(d), deps }
  made.push(h)
  return h
}

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }
const text = (root: HTMLElement): string => Array.from(root.children).map((c) => c.textContent).join('|')
const block = (root: HTMLElement, i: number): HTMLElement => root.children[i] as HTMLElement

/** Stands in for an edit: appends `s` to block `i`'s text. */
function type(root: HTMLElement, i: number, s: string): void {
  block(root, i).firstChild!.textContent += s
}

function input(h: Harness, inputType: string): void {
  h.u.handleBeforeInput(new InputEvent('beforeinput', { inputType, cancelable: true }))
}

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { cancelable: true, ...init })
}

function setCaret(node: Node, offset: number): void {
  const r = document.createRange()
  r.setStart(node, offset)
  r.collapse(true)
  const s = window.getSelection()!
  s.removeAllRanges()
  s.addRange(r)
}

beforeEach(() => { vi.useFakeTimers() })

afterEach(() => {
  for (const h of made.splice(0)) h.u.destroy()
  vi.useRealTimers()
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

describe('checkpoint, undo, redo', () => {
  test('checkpoint then mutate: undo restores, redo replays, both return true', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    expect(h.u.undo()).toBe(true)
    expect(text(h.root)).toBe('a|b|c')
    expect(h.deps.onChange).toHaveBeenCalledTimes(1)
    expect(h.u.redo()).toBe(true)
    expect(text(h.root)).toBe('aX|b|c')
    expect(h.deps.onChange).toHaveBeenCalledTimes(2)
  })

  test('undo in the same task as the edit does not lose the step', () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    expect(h.u.undo()).toBe(true)
    expect(text(h.root)).toBe('a|b|c')
  })

  test('afterRestore receives the replaced blocks only', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 1, 'X')
    await flush()
    h.u.undo()
    expect(h.deps.afterRestore).toHaveBeenCalledTimes(1)
    const replaced = h.deps.afterRestore.mock.calls[0]![0] as HTMLElement[]
    expect(replaced.map((e) => e.textContent)).toEqual(['b'])
  })

  test('our own restore is not recorded as an edit (redo survives)', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    h.u.undo()
    await flush()
    h.u.redo()
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('two checkpoints in one synchronous task make one step', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, '1')
    h.u.checkpoint()
    type(h.root, 1, '2')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('checkpoints in different tasks are different steps', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, '1')
    await flush()
    h.u.checkpoint()
    type(h.root, 1, '2')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a1|b|c')
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('a stale pending expires in a macrotask: a later unrelated change is no entry and keeps redo', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    h.u.undo()
    await flush()
    h.u.checkpoint() // changes nothing
    await flush()
    vi.advanceTimersByTime(0)
    type(h.root, 1, 'Z') // e.g. a chip relabel, no checkpoint
    await flush()
    h.u.undo() // nothing to undo: the 'Z' change is not an entry
    expect(text(h.root)).toBe('a|bZ|c')
    h.u.redo() // still available: the unrelated change did not clear it
    expect(text(h.root)).toBe('aX|b|c')
  })

  test('the expiry still commits a real edit made in that task', async () => {
    const h = setup()
    input(h, 'insertParagraph')
    type(h.root, 0, 'X')
    vi.advanceTimersByTime(0)
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('a checkpoint with no mutation leaves no entry and keeps redo', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    h.u.undo()
    await flush()
    h.u.checkpoint()
    await flush()
    expect(h.u.redo()).toBe(true)
    expect(text(h.root)).toBe('aX|b|c')
  })

  test('a new step clears redo', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    h.u.undo()
    await flush()
    h.u.checkpoint()
    type(h.root, 1, 'Y')
    await flush()
    h.u.redo()
    expect(text(h.root)).toBe('a|bY|c')
  })

  test('undo with an empty stack returns true and leaves the document alone', () => {
    const h = setup()
    const first = block(h.root, 0)
    expect(h.u.undo()).toBe(true)
    expect(h.u.redo()).toBe(true)
    expect(text(h.root)).toBe('a|b|c')
    expect(block(h.root, 0)).toBe(first)
    expect(h.deps.onChange).not.toHaveBeenCalled()
  })

  test('only 100 undos after 101 committed steps', async () => {
    const h = setup('<div>0</div>')
    for (let i = 1; i <= 101; i++) {
      h.u.checkpoint()
      block(h.root, 0).firstChild!.textContent = String(i)
      await flush()
    }
    for (let i = 0; i < 150; i++) h.u.undo()
    expect(text(h.root)).toBe('1')
  })

  test('an entry identical to the live document is skipped', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    h.u.checkpoint()
    // A mutation that nets to nothing is no entry at all; a committed no-op needs
    // identical blocks, so make the second step's before-state equal to the live one.
    type(h.root, 0, 'Y')
    block(h.root, 0).firstChild!.textContent = 'aX'
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('a step committed then reverted by hand is skipped on undo', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    h.u.checkpoint()
    type(h.root, 1, 'Y')
    await flush()
    // Revert the second edit outside the stack: the newest entry now equals live.
    block(h.root, 1).firstChild!.textContent = 'b'
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })
})

describe('typing runs', () => {
  test('three insertText inputs with mutations in between are one step', async () => {
    const h = setup()
    for (const ch of ['x', 'y', 'z']) {
      input(h, 'insertText')
      type(h.root, 0, ch)
      await flush()
    }
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('after 1000 ms idle the next input is a new step', async () => {
    const h = setup()
    input(h, 'insertText')
    type(h.root, 0, 'x')
    await flush()
    vi.advanceTimersByTime(1000)
    input(h, 'insertText')
    type(h.root, 0, 'y')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('ax|b|c')
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('input before 1000 ms keeps the run open (idle restarts on each input)', async () => {
    const h = setup()
    input(h, 'insertText')
    type(h.root, 0, 'x')
    await flush()
    vi.advanceTimersByTime(600)
    input(h, 'insertText')
    type(h.root, 0, 'y')
    await flush()
    vi.advanceTimersByTime(600)
    input(h, 'insertText')
    type(h.root, 0, 'z')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('deleteContentBackward after typing is a new step', async () => {
    const h = setup()
    input(h, 'insertText')
    type(h.root, 0, 'xy')
    await flush()
    input(h, 'deleteContentBackward')
    block(h.root, 0).firstChild!.textContent = 'ax'
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('axy|b|c')
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('consecutive deletes are one step', async () => {
    const h = setup('<div>abc</div>')
    input(h, 'deleteContentBackward')
    block(h.root, 0).firstChild!.textContent = 'ab'
    await flush()
    input(h, 'deleteContentBackward')
    block(h.root, 0).firstChild!.textContent = 'a'
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('abc')
  })

  test('Enter is its own step; typing before and after are separate steps', async () => {
    const h = setup('<div>ab</div>')
    input(h, 'insertText')
    type(h.root, 0, 'c')
    await flush()
    input(h, 'insertParagraph')
    h.root.appendChild(Object.assign(document.createElement('div'), { textContent: '' }))
    await flush()
    input(h, 'insertText')
    block(h.root, 1).textContent = 'd'
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('abc|')
    h.u.undo()
    expect(text(h.root)).toBe('abc')
    h.u.undo()
    expect(text(h.root)).toBe('ab')
  })

  test('an insertCompositionText sequence is one step', async () => {
    const h = setup()
    for (const s of ['n', 'ni', 'ni h']) {
      input(h, 'insertCompositionText')
      block(h.root, 0).firstChild!.textContent = 'a' + s
      await flush()
    }
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('another inputType opens a step when none is open', async () => {
    const h = setup()
    input(h, 'insertFromPaste')
    type(h.root, 0, 'P')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('an explicit checkpoint covers the plain-looking beforeinput inside it', async () => {
    const h = setup()
    h.u.checkpoint()
    input(h, 'insertText')
    type(h.root, 0, 'P')
    input(h, 'insertText')
    type(h.root, 0, 'Q')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('a checkpoint ends the typing run', async () => {
    const h = setup()
    input(h, 'insertText')
    type(h.root, 0, 'x')
    await flush()
    h.u.checkpoint()
    type(h.root, 1, 'Y')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('ax|b|c')
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('history input types do not open a step', async () => {
    const h = setup()
    input(h, 'historyUndo')
    type(h.root, 0, 'x')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('ax|b|c')
  })

  test('the stored selection is the caret before the first keystroke', async () => {
    const h = setup()
    setCaret(block(h.root, 2).firstChild!, 1)
    input(h, 'insertText')
    type(h.root, 0, 'x')
    setCaret(block(h.root, 0).firstChild!, 2)
    await flush()
    setCaret(block(h.root, 1).firstChild!, 0)
    h.u.undo()
    const r = window.getSelection()!.getRangeAt(0)
    expect(r.startContainer).toBe(block(h.root, 2).firstChild)
    expect(r.startOffset).toBe(1)
  })

  test('input while read-only opens nothing', async () => {
    const h = setup()
    h.deps.readOnly = true
    input(h, 'insertText')
    type(h.root, 0, 'x')
    await flush()
    h.deps.readOnly = false
    h.u.undo()
    expect(text(h.root)).toBe('ax|b|c')
  })
})

describe('IME composition', () => {
  test('a composition with long pauses undoes in one step', async () => {
    const h = setup()
    h.u.setComposing(true)
    for (const s of ['n', 'ni', 'ni h']) {
      input(h, 'insertCompositionText')
      block(h.root, 0).firstChild!.textContent = 'a' + s
      await flush()
      vi.advanceTimersByTime(1500)
    }
    input(h, 'deleteCompositionText')
    block(h.root, 0).firstChild!.textContent = 'a'
    input(h, 'insertFromComposition')
    block(h.root, 0).firstChild!.textContent = 'a你'
    await flush()
    vi.advanceTimersByTime(1500)
    h.u.setComposing(false)
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('a selectionchange at another caret during composition does not split the run', async () => {
    const h = setup()
    h.u.setComposing(true)
    input(h, 'insertCompositionText')
    block(h.root, 0).firstChild!.textContent = 'an'
    await flush()
    h.u.noteSelectionChange()
    setCaret(block(h.root, 2).firstChild!, 0)
    h.u.noteSelectionChange()
    input(h, 'insertCompositionText')
    block(h.root, 0).firstChild!.textContent = 'ani'
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('compositionend re-arms the idle close', async () => {
    const h = setup()
    h.u.setComposing(true)
    input(h, 'insertCompositionText')
    block(h.root, 0).firstChild!.textContent = 'an'
    await flush()
    h.u.setComposing(false)
    vi.advanceTimersByTime(1000)
    input(h, 'insertText')
    type(h.root, 0, 'y')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('an|b|c')
  })
})

describe('closing a run', () => {
  async function typedRun(h: Harness): Promise<void> {
    setCaret(block(h.root, 0).firstChild!, 1)
    input(h, 'insertText')
    type(h.root, 0, 'x')
    setCaret(block(h.root, 0).firstChild!, 2)
    h.u.noteInput() // the editor's input handler: where the typing left the caret
    await flush()
    h.u.noteSelectionChange() // the typing's own selectionchange
  }

  test('the selectionchange caused by typing keeps the run open', async () => {
    const h = setup()
    await typedRun(h)
    input(h, 'insertText')
    type(h.root, 0, 'y')
    setCaret(block(h.root, 0).firstChild!, 3)
    h.u.noteInput()
    await flush()
    h.u.noteSelectionChange()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  // selectionchange is async and coalesced: a quick caret jump right after typing can arrive as the one
  // event that also stands for the typing's own caret move.
  test('a caret jump whose selectionchange coalesced with the typing one still closes the run', async () => {
    const h = setup()
    setCaret(block(h.root, 0).firstChild!, 1)
    input(h, 'insertText')
    type(h.root, 0, 'x')
    setCaret(block(h.root, 0).firstChild!, 2)
    h.u.noteInput()
    setCaret(block(h.root, 2).firstChild!, 0)
    await flush()
    h.u.noteSelectionChange()
    input(h, 'insertText')
    type(h.root, 0, 'y')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('ax|b|c')
  })

  test('an input that moves no caret (Delete at the end) does not swallow the next caret jump', async () => {
    const h = setup('<div>ab</div><div>cd</div>')
    const end = (i: number) => setCaret(block(h.root, i).firstChild!, block(h.root, i).firstChild!.textContent!.length)
    end(1)
    input(h, 'deleteContentForward') // nothing after the caret: no change, no input, no selectionchange
    await flush()
    end(0)
    h.u.noteSelectionChange()
    input(h, 'deleteContentBackward')
    block(h.root, 0).firstChild!.textContent = 'a'
    end(0)
    h.u.noteInput()
    await flush()
    h.u.noteSelectionChange()
    end(1)
    h.u.noteSelectionChange()
    input(h, 'deleteContentBackward')
    block(h.root, 1).firstChild!.textContent = 'c'
    end(1)
    h.u.noteInput()
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|cd')
    h.u.undo()
    expect(text(h.root)).toBe('ab|cd')
  })

  test('noteSelectionChange after a caret jump closes the run', async () => {
    const h = setup()
    await typedRun(h)
    setCaret(block(h.root, 2).firstChild!, 0)
    h.u.noteSelectionChange()
    input(h, 'insertText')
    type(h.root, 0, 'y')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('ax|b|c')
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('a repeated selectionchange at the same caret does not close the run', async () => {
    const h = setup()
    await typedRun(h)
    h.u.noteSelectionChange()
    input(h, 'insertText')
    type(h.root, 0, 'y')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('closeRun closes it', async () => {
    const h = setup()
    input(h, 'insertText')
    type(h.root, 0, 'x')
    await flush()
    h.u.closeRun()
    input(h, 'insertText')
    type(h.root, 0, 'y')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('ax|b|c')
  })
})

describe('keys and read-only', () => {
  test('Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y are handled with preventDefault', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    const z = key({ key: 'z', code: 'KeyZ', ctrlKey: true })
    expect(h.u.handleKeydown(z)).toBe(true)
    expect(z.defaultPrevented).toBe(true)
    expect(text(h.root)).toBe('a|b|c')
    const sz = key({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true })
    expect(h.u.handleKeydown(sz)).toBe(true)
    expect(sz.defaultPrevented).toBe(true)
    expect(text(h.root)).toBe('aX|b|c')
    h.u.undo()
    const y = key({ key: 'y', code: 'KeyY', ctrlKey: true })
    expect(h.u.handleKeydown(y)).toBe(true)
    expect(y.defaultPrevented).toBe(true)
    expect(text(h.root)).toBe('aX|b|c')
  })

  test('the produced Latin letter wins over the physical key', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    h.u.undo()
    // QWERTZ: the Y key reports code KeyZ.
    expect(h.u.handleKeydown(key({ key: 'y', code: 'KeyZ', ctrlKey: true }))).toBe(true)
    expect(text(h.root)).toBe('aX|b|c')
    // Dvorak: physical KeyY produces F; Ctrl+F is the browser's Find.
    const f = key({ key: 'f', code: 'KeyY', ctrlKey: true })
    expect(h.u.handleKeydown(f)).toBe(false)
    expect(f.defaultPrevented).toBe(false)
  })

  test('a non-Latin key falls back to the physical key', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    expect(h.u.handleKeydown(key({ key: 'я', code: 'KeyZ', ctrlKey: true }))).toBe(true)
    expect(text(h.root)).toBe('a|b|c')
  })

  test('Cmd+Z works and a layout-shifted key is matched by code', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    expect(h.u.handleKeydown(key({ key: 'я', code: 'KeyZ', metaKey: true }))).toBe(true)
    expect(text(h.root)).toBe('a|b|c')
  })

  test('other keys are not handled', () => {
    const h = setup()
    for (const init of [
      { key: 'z', code: 'KeyZ' },
      { key: 'b', code: 'KeyB', ctrlKey: true },
      { key: 'y', code: 'KeyY', ctrlKey: true, shiftKey: true },
      { key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true },
    ]) {
      const e = key(init)
      expect(h.u.handleKeydown(e)).toBe(false)
      expect(e.defaultPrevented).toBe(false)
    }
  })

  test('read-only: undo/redo return false, keys are not handled, nothing changes', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    h.deps.readOnly = true
    expect(h.u.undo()).toBe(false)
    expect(h.u.redo()).toBe(false)
    const e = key({ key: 'z', code: 'KeyZ', ctrlKey: true })
    expect(h.u.handleKeydown(e)).toBe(false)
    expect(e.defaultPrevented).toBe(false)
    expect(text(h.root)).toBe('aX|b|c')
    expect(h.deps.onChange).not.toHaveBeenCalled()
  })
})

describe('lifecycle and registry', () => {
  test('clear empties both stacks and the stack keeps working', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    h.u.undo()
    await flush()
    h.u.clear()
    h.u.undo()
    h.u.redo()
    expect(text(h.root)).toBe('a|b|c')
    h.u.checkpoint()
    type(h.root, 1, 'Y')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
  })

  test('destroy empties the stacks and stops the observer', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    await flush()
    h.u.destroy()
    h.u.undo()
    expect(text(h.root)).toBe('aX|b|c')
    await flush()
    vi.advanceTimersByTime(5000)
    await flush()
    h.u.checkpoint()
    type(h.root, 1, 'Y')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('aX|bY|c')
  })

  test('clear drops mutation records the observer has not delivered', async () => {
    const h = setup()
    h.u.checkpoint()
    type(h.root, 0, 'X')
    h.u.clear()
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('aX|b|c')
  })

  test('recordEdit runs plainly for an unregistered root', async () => {
    const h = setup()
    expect(recordEdit(h.root, () => 42)).toBe(42)
    type(h.root, 0, 'X')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('aX|b|c')
  })

  test('recordEdit checkpoints for a registered root, and unregister detaches it', async () => {
    const h = setup()
    registerUndo(h.root, h.u)
    const r = recordEdit(h.root, () => { type(h.root, 0, 'X'); return 'done' })
    expect(r).toBe('done')
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|b|c')
    unregisterUndo(h.root)
    recordEdit(h.root, () => type(h.root, 1, 'Y'))
    await flush()
    h.u.undo()
    expect(text(h.root)).toBe('a|bY|c')
  })

  test('two roots with two stacks do not affect each other', async () => {
    const h1 = setup()
    const h2 = setup('<div>p</div><div>q</div>')
    h1.u.checkpoint()
    type(h1.root, 0, 'X')
    h2.u.checkpoint()
    type(h2.root, 1, 'Y')
    await flush()
    h1.u.undo()
    expect(text(h1.root)).toBe('a|b|c')
    expect(text(h2.root)).toBe('p|qY')
    h2.u.undo()
    expect(text(h2.root)).toBe('p|q')
    expect(h1.deps.onChange).toHaveBeenCalledTimes(1)
    expect(h2.deps.onChange).toHaveBeenCalledTimes(1)
  })
})
