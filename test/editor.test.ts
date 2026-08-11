import { createEditor, flushAllEditors, detectInlinePattern, detectBlockPrefix, leadingIndentLen, type Editor, type EditorHooks } from '../src/ui/editor'
import type { RefInfo } from '../src/core/markdown'
import { t } from '../src/core/i18n'

function makeHooks(): EditorHooks & { changes: number; refs: RefInfo['target'][]; atRanges: Range[]; slashRanges: Range[] } {
  return {
    changes: 0,
    refs: [],
    atRanges: [],
    slashRanges: [],
    onChange() { this.changes++ },
    onRefClick(target) { this.refs.push(target) },
    onAtTrigger(range) { this.atRanges.push(range) },
    onSlashTrigger(range) { this.slashRanges.push(range) },
  }
}

function dispatchKey(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(e)
  return e
}

// jsdom does not implement document.execCommand at all (not even as a no-op),
// so vi.spyOn(document, 'execCommand') would fail with "does not exist" —
// install a stub once so shortcut/paste tests can spy on and assert calls.
beforeAll(() => {
  if (!('execCommand' in document)) {
    ;(document as unknown as { execCommand: (...args: unknown[]) => boolean }).execCommand = () => false
  }
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('setMd/getMd round-trip', () => {
  let editor: Editor

  afterEach(() => editor?.destroy())

  test.each([
    ['plain text', 'hello world'],
    ['bold', 'a **b** fim'],
    ['italic', 'a *i* fim'],
    ['underline', 'a <u>u</u> fim'],
    ['strike', 'a ~~s~~ fim'],
    ['headers', '# T1\n## T2\n### T3'],
    ['lists', '- um\n- dois'],
    ['ordered list', '1. a\n2. b'],
    ['refs', 'ver @[Ana](person:abc-1) e @[02/07/2026](day:2026-07-02)'],
  ])('%s', (_name, md) => {
    editor = createEditor(makeHooks(), 'en-US')
    editor.setMd(md)
    expect(editor.getMd()).toBe(md)
  })
})

describe('paste', () => {
  // jsdom has no ClipboardEvent constructor; a plain Event with a
  // clipboardData property is enough since the handler only reads that.
  function dispatchPaste(editor: Editor, data: Record<string, string>): { preventDefault: ReturnType<typeof vi.spyOn> } {
    const clipboardData = { getData: (fmt: string) => data[fmt] ?? '' } as unknown as DataTransfer
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: clipboardData })
    const preventDefault = vi.spyOn(event, 'preventDefault')
    editor.root.querySelector('.editor')!.dispatchEvent(event)
    return { preventDefault }
  }

  test('falls back to plain text when the clipboard has no HTML', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    const { preventDefault } = dispatchPaste(editor, { 'text/plain': 'plain text' })

    expect(preventDefault).toHaveBeenCalled()
    expect(execSpy).toHaveBeenCalledWith('insertText', false, 'plain text')
    editor.destroy()
  })

  test('preserves list structure from HTML clipboard data instead of flattening it to plain text', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    dispatchPaste(editor, {
      'text/plain': 'um\ndois',
      'text/html': '<ul><li>um</li><li>dois</li></ul>',
    })

    expect(execSpy).toHaveBeenCalledWith('insertHTML', false, expect.stringContaining('<li>'))
    const inserted = execSpy.mock.calls.find((c) => c[0] === 'insertHTML')![2] as string
    expect(inserted).toContain('<ul>')
    editor.destroy()
  })

  test('preserves nested list indentation from HTML clipboard data', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    dispatchPaste(editor, {
      'text/html': '<ul><li>um<ul><li>dois</li></ul></li></ul>',
    })

    const inserted = execSpy.mock.calls.find((c) => c[0] === 'insertHTML')![2] as string
    // The pasted HTML is round-tripped through the same md<->html conversion
    // as setMd/getMd, so a nested list survives as a nested <ul>, not a
    // second top-level bullet at the same depth as its parent.
    expect(inserted).toMatch(/<li>um<ul><li>dois<\/li><\/ul><\/li>/)
    editor.destroy()
  })

  test('preserves inline formatting from HTML clipboard data', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    dispatchPaste(editor, { 'text/html': '<b>rich</b> text' })

    const inserted = execSpy.mock.calls.find((c) => c[0] === 'insertHTML')![2] as string
    expect(inserted).toContain('<strong>rich</strong>')
    editor.destroy()
  })
})

describe('ref click', () => {
  test('clicking a ref chip calls onRefClick with the parsed target', () => {
    const hooks = makeHooks()
    const editor = createEditor(hooks, 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('ver @[Ana](person:abc-1)')

    const refEl = editor.root.querySelector('a.ref') as HTMLAnchorElement
    expect(refEl).toBeTruthy()
    refEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(hooks.refs).toEqual([{ kind: 'person', id: 'abc-1' }])
    editor.destroy()
  })

  test('plain click passes secondary: false', () => {
    const secondaryFlags: boolean[] = []
    const editor = createEditor({
      onChange() {}, onAtTrigger() {}, onSlashTrigger() {},
      onRefClick(_target, opts) { secondaryFlags.push(opts.secondary) },
    }, 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('ver @[Ana](person:abc-1)')

    const refEl = editor.root.querySelector('a.ref') as HTMLAnchorElement
    refEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(secondaryFlags).toEqual([false])
    editor.destroy()
  })

  test('ctrl-click and meta-click pass secondary: true', () => {
    const secondaryFlags: boolean[] = []
    const editor = createEditor({
      onChange() {}, onAtTrigger() {}, onSlashTrigger() {},
      onRefClick(_target, opts) { secondaryFlags.push(opts.secondary) },
    }, 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('ver @[Ana](person:abc-1)')

    const refEl = editor.root.querySelector('a.ref') as HTMLAnchorElement
    refEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    refEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))

    expect(secondaryFlags).toEqual([true, true])
    editor.destroy()
  })

  test('middle-click (auxclick, button 1) passes secondary: true and is prevented', () => {
    const secondaryFlags: boolean[] = []
    const editor = createEditor({
      onChange() {}, onAtTrigger() {}, onSlashTrigger() {},
      onRefClick(_target, opts) { secondaryFlags.push(opts.secondary) },
    }, 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('ver @[Ana](person:abc-1)')

    const refEl = editor.root.querySelector('a.ref') as HTMLAnchorElement
    const auxEvent = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    const prevented = !refEl.dispatchEvent(auxEvent)

    expect(secondaryFlags).toEqual([true])
    expect(prevented).toBe(true)
    editor.destroy()
  })

  test('middle-mousedown on a ref chip is prevented (suppresses browser autoscroll)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('ver @[Ana](person:abc-1)')

    const refEl = editor.root.querySelector('a.ref') as HTMLAnchorElement
    const downEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 })
    const prevented = !refEl.dispatchEvent(downEvent)

    expect(prevented).toBe(true)
    editor.destroy()
  })

  test('auxclick with a non-middle button does not fire onRefClick', () => {
    const hooks = makeHooks()
    const editor = createEditor(hooks, 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('ver @[Ana](person:abc-1)')

    const refEl = editor.root.querySelector('a.ref') as HTMLAnchorElement
    refEl.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }))

    expect(hooks.refs).toEqual([])
    editor.destroy()
  })
})

describe('@ trigger', () => {
  test('typing @ fires onAtTrigger with the current range', () => {
    const hooks = makeHooks()
    const editor = createEditor(hooks, 'en-US')
    document.body.appendChild(editor.root)

    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = '<div>hi @</div>'
    const textNode = editorEl.firstChild!.firstChild!
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(hooks.atRanges.length).toBe(1)
    editor.destroy()
  })

  // Regression: contenteditable's native "select all + delete" can leave
  // editorEl with zero element children — no wrapping <div>/<p> at all,
  // unlike a freshly loaded note (setMd always leaves at least one block,
  // even for an empty string — see core/markdown.ts's mdToHtml). Typing "@"
  // right into that bare state lands the character as a direct text-node
  // child of editorEl, which the block-walk in currentBlockAndOffset()
  // can't resolve to a block, so the trigger silently didn't fire — until
  // the user pressed Enter first, which creates a real block as a side effect.
  test('typing @ into an editor emptied by select-all+delete (no wrapping block left) still fires onAtTrigger', () => {
    const hooks = makeHooks()
    const editor = createEditor(hooks, 'en-US')
    document.body.appendChild(editor.root)

    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = '' // simulates the post-"select all + Backspace" state
    editorEl.appendChild(document.createTextNode('@')) // simulates the browser's default action for the keystroke
    const textNode = editorEl.firstChild!
    const range = document.createRange()
    range.setStart(textNode, 1)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(hooks.atRanges.length).toBe(1)
    editor.destroy()
  })
})

describe('/ trigger', () => {
  // Same root cause as the @ regression above, for the slash-template trigger.
  test('typing / into an editor emptied by select-all+delete (no wrapping block left) still fires onSlashTrigger', () => {
    const hooks = makeHooks()
    const editor = createEditor(hooks, 'en-US')
    document.body.appendChild(editor.root)

    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = ''
    editorEl.appendChild(document.createTextNode('/'))
    const textNode = editorEl.firstChild!
    const range = document.createRange()
    range.setStart(textNode, 1)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(hooks.slashRanges.length).toBe(1)
    editor.destroy()
  })
})

describe('keyboard shortcuts', () => {
  test.each([
    [{ key: 'b', ctrlKey: true }, 'bold'],
    [{ key: 'i', ctrlKey: true }, 'italic'],
    [{ key: 'u', ctrlKey: true }, 'underline'],
    [{ key: 'X', ctrlKey: true, shiftKey: true }, 'strikeThrough'],
  ])('%o -> execCommand(%s)', (init, cmd) => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    const e = dispatchKey(editorEl, init)
    expect(execSpy).toHaveBeenCalledWith(cmd, false, undefined)
    expect(e.defaultPrevented).toBe(true)
    editor.destroy()
  })

  test('Ctrl+1 formats block as h1', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    dispatchKey(editorEl, { key: '1', ctrlKey: true, code: 'Digit1' })
    expect(execSpy).toHaveBeenCalledWith('formatBlock', false, '<h1>')
    editor.destroy()
  })

  test('Ctrl+Shift+8 inserts unordered list', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    dispatchKey(editorEl, { key: '*', ctrlKey: true, shiftKey: true, code: 'Digit8' })
    expect(execSpy).toHaveBeenCalledWith('insertUnorderedList', false, undefined)
    editor.destroy()
  })
})

describe('Tab indent', () => {
  test('leadingIndentLen counts leading space/nbsp chars, capped at 4', () => {
    expect(leadingIndentLen('')).toBe(0)
    expect(leadingIndentLen('abc')).toBe(0)
    expect(leadingIndentLen(' abc')).toBe(1)
    expect(leadingIndentLen('    abc')).toBe(4)
    expect(leadingIndentLen('      abc')).toBe(4)
    expect(leadingIndentLen('\u00a0\u00a0abc')).toBe(2)
    expect(leadingIndentLen(' \u00a0 \u00a0abc')).toBe(4)
  })

  test('Tab inserts a 4-char non-breaking indent at the caret', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    dispatchKey(editorEl, { key: 'Tab' })

    expect(execSpy).toHaveBeenCalledWith('insertText', false, '\u00a0\u00a0\u00a0\u00a0')
    editor.destroy()
  })

  test('Shift+Tab removes up to 4 leading indent chars from the current line', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('    hello')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const block = editorEl.firstElementChild as HTMLElement
    const textNode = block.firstChild!
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('hello')
    editor.destroy()
  })

  test('Shift+Tab on a line with no leading indent is a no-op', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('hello')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const block = editorEl.firstElementChild as HTMLElement
    const textNode = block.firstChild!
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('hello')
    editor.destroy()
  })

  test('Shift+Tab keeps the caret near its position, not jumped to line start', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('    hello world')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const block = editorEl.firstElementChild as HTMLElement
    const textNode = block.firstChild!
    // Caret right after "hello" (4 indent chars + "hello".length = 9).
    const range = document.createRange()
    range.setStart(textNode, 9)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('hello world')
    const newRange = window.getSelection()!.getRangeAt(0)
    const pre = document.createRange()
    pre.selectNodeContents(block)
    pre.setEnd(newRange.startContainer, newRange.startOffset)
    // 4 indent chars removed from an offset-9 caret -> offset 5, right after "hello".
    expect(pre.toString().length).toBe(5)
    editor.destroy()
  })
})

describe('list nesting via Tab/Shift+Tab', () => {
  function collapseInto(li: Element): void {
    const range = document.createRange()
    range.selectNodeContents(li)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  test('Tab nests a list item under its previous sibling', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('- a\n- b')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    collapseInto(editorEl.querySelectorAll('li')[1]!)

    dispatchKey(editorEl, { key: 'Tab' })

    expect(editor.getMd()).toBe('- a\n  - b')
    editor.destroy()
  })

  test('Tab on the first item of a list is a no-op (nothing to nest under)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const md = '- a\n- b'
    editor.setMd(md)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    collapseInto(editorEl.querySelectorAll('li')[0]!)

    dispatchKey(editorEl, { key: 'Tab' })

    expect(editor.getMd()).toBe(md)
    editor.destroy()
  })

  test('Tab at max nesting depth (4 levels) is a no-op', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const md = '- a\n  - b\n    - c\n      - d\n      - e'
    editor.setMd(md)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const items = editorEl.querySelectorAll('li')
    collapseInto(items[items.length - 1]!) // "e", already at depth 3 alongside "d"

    dispatchKey(editorEl, { key: 'Tab' })

    expect(editor.getMd()).toBe(md)
    editor.destroy()
  })

  test('Shift+Tab promotes a nested item out one level, carrying its trailing siblings as its own children', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('- a\n  - b\n  - c\n- d')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    collapseInto(editorEl.querySelectorAll('li')[1]!) // "b"

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('- a\n- b\n  - c\n- d')
    editor.destroy()
  })

  test('Shift+Tab on a top-level list item is a no-op', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const md = '- a\n- b'
    editor.setMd(md)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    collapseInto(editorEl.querySelectorAll('li')[0]!)

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe(md)
    editor.destroy()
  })

  function selectAcross(startLi: Element, endLi: Element): void {
    const range = document.createRange()
    range.setStart(startLi.firstChild!, 0)
    range.setEnd(endLi.firstChild!, endLi.firstChild!.textContent!.length)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  test('Tab with multiple sibling list items selected nests the whole batch together', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('- a\n- b\n- c')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const [, liB, liC] = Array.from(editorEl.querySelectorAll('li'))
    selectAcross(liB!, liC!)

    dispatchKey(editorEl, { key: 'Tab' })

    expect(editor.getMd()).toBe('- a\n  - b\n  - c')
    editor.destroy()
  })

  test('Shift+Tab with multiple sibling nested items selected promotes the whole batch together', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('- a\n  - b\n  - c\n- d')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const items = editorEl.querySelectorAll('li')
    selectAcross(items[1]!, items[2]!) // "b", "c"

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('- a\n- b\n- c\n- d')
    editor.destroy()
  })

  test('Tab keeps the caret in the item just nested, not jumped elsewhere', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('- a\n- bb')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const liB = editorEl.querySelectorAll('li')[1]!
    const range = document.createRange()
    range.setStart(liB.firstChild!, 1) // caret between "b" and "b"
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    dispatchKey(editorEl, { key: 'Tab' })

    expect(editor.getMd()).toBe('- a\n  - bb')
    const newRange = window.getSelection()!.getRangeAt(0)
    expect(closestLiOf(newRange.startContainer)?.textContent).toBe('bb')
    const pre = document.createRange()
    pre.selectNodeContents(closestLiOf(newRange.startContainer)!)
    pre.setEnd(newRange.startContainer, newRange.startOffset)
    expect(pre.toString().length).toBe(1)
    editor.destroy()
  })

  test('Shift+Tab keeps the caret in the item just promoted, not jumped to the line above (regression)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('- a\n  - bb')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const liB = editorEl.querySelectorAll('li')[1]!
    const range = document.createRange()
    range.setStart(liB.firstChild!, 1) // caret between "b" and "b"
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('- a\n- bb')
    const newRange = window.getSelection()!.getRangeAt(0)
    expect(closestLiOf(newRange.startContainer)?.textContent).toBe('bb')
    const pre = document.createRange()
    pre.selectNodeContents(closestLiOf(newRange.startContainer)!)
    pre.setEnd(newRange.startContainer, newRange.startOffset)
    expect(pre.toString().length).toBe(1)
    editor.destroy()
  })

  test('Shift+Tab at deeper nesting (3rd level) also keeps the caret in place (regression)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('- a\n  - b\n    - cc')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const liC = editorEl.querySelectorAll('li')[2]!
    const range = document.createRange()
    range.setStart(liC.firstChild!, 1) // caret between "c" and "c"
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('- a\n  - b\n  - cc')
    const newRange = window.getSelection()!.getRangeAt(0)
    expect(closestLiOf(newRange.startContainer)?.textContent).toBe('cc')
    const pre = document.createRange()
    pre.selectNodeContents(closestLiOf(newRange.startContainer)!)
    pre.setEnd(newRange.startContainer, newRange.startOffset)
    expect(pre.toString().length).toBe(1)
    editor.destroy()
  })
})

function closestLiOf(node: Node): HTMLElement | null {
  let n: Node | null = node
  while (n) {
    if (n instanceof HTMLElement && n.tagName === 'LI') return n
    n = n.parentElement
  }
  return null
}

describe('toolbar', () => {
  test('help button opens the help modal', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const helpBtn = Array.from(editor.root.querySelectorAll('button')).find((b) => b.textContent === '?')!
    helpBtn.click()
    expect(document.querySelector('.tt-modal-overlay')).not.toBeNull()
    editor.destroy()
  })

  test('has paragraph and clear-formatting buttons', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const buttons = Array.from(editor.root.querySelectorAll('button'))
    expect(buttons.find((b) => b.title === t('en-US', 'editor_paragraph_title'))).not.toBeUndefined()
    expect(buttons.find((b) => b.title === t('en-US', 'editor_clear_format_title'))).not.toBeUndefined()
    editor.destroy()
  })

  function toolbarButton(editor: Editor, title: string): HTMLButtonElement {
    return Array.from(editor.root.querySelectorAll('button')).find((b) => b.title === title) as HTMLButtonElement
  }

  function openCopyMenu(editor: Editor): void {
    toolbarButton(editor, t('en-US', 'editor_copy_options_title')).click()
  }

  function pickCopyOption(label: string): void {
    const item = Array.from(document.querySelectorAll('.tt-atref-item')).find((el) => el.textContent === label) as HTMLElement
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }

  test('copy button opens a menu with plain/formatted/markdown options, closed on Escape', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)

    openCopyMenu(editor)

    const labels = Array.from(document.querySelectorAll('.tt-atref-item')).map((el) => el.textContent)
    expect(labels).toEqual([
      t('en-US', 'editor_copy_option_plain'),
      t('en-US', 'editor_copy_option_formatted'),
      t('en-US', 'editor_copy_option_markdown'),
    ])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    editor.destroy()
  })

  test('copy button opens a menu closed by an outside click', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)

    openCopyMenu(editor)
    expect(document.querySelector('.tt-atref-dropdown')).not.toBeNull()

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    editor.destroy()
  })

  test('copy menu supports Up/Down + Enter keyboard navigation', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('**bold** text')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    openCopyMenu(editor)
    const items = () => Array.from(document.querySelectorAll('.tt-atref-item'))
    expect(items()[0]!.classList.contains('selected')).toBe(true) // opens with the first option selected

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(items()[0]!.classList.contains('selected')).toBe(false)
    expect(items()[1]!.classList.contains('selected')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(items()[2]!.classList.contains('selected')).toBe(true) // third option = "Copy as markdown"

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(writeText).toHaveBeenCalledWith('**bold** text')
    expect(document.querySelector('.tt-atref-dropdown')).toBeNull() // menu closes after commit

    editor.destroy()
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  test('copy menu clamps to the viewport when the toolbar button sits near the right/bottom edge', () => {
    const originalGetRect = Element.prototype.getBoundingClientRect
    const originalInnerWidth = window.innerWidth
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
    Element.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      const base = { x: 0, y: 0, toJSON: () => ({}) }
      if (this.classList.contains('tt-atref-dropdown')) {
        return { ...base, left: 780, right: 980, top: 580, bottom: 780, width: 200, height: 200 } as DOMRect
      }
      return originalGetRect.call(this)
    }

    try {
      const editor = createEditor(makeHooks(), 'en-US')
      document.body.appendChild(editor.root)

      openCopyMenu(editor)
      const menu = document.querySelector<HTMLElement>('.tt-atref-dropdown')!
      expect(parseFloat(menu.style.left)).toBeLessThanOrEqual(800 - 8 - 200)
      expect(parseFloat(menu.style.top)).toBeLessThanOrEqual(600 - 8 - 200)

      editor.destroy()
    } finally {
      Element.prototype.getBoundingClientRect = originalGetRect
      Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
      Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true })
    }
  })

  test('"Copy formatted" falls back to selection + execCommand when the async Clipboard API is unavailable (e.g. jsdom, older browsers)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('**bold** text')
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    openCopyMenu(editor)
    pickCopyOption(t('en-US', 'editor_copy_option_formatted'))

    expect(execSpy).toHaveBeenCalledWith('copy', false, undefined)
    const sel = window.getSelection()!
    expect(sel.rangeCount).toBe(0) // selection cleared after copying, so it doesn't visually linger
    expect(document.querySelector('.tt-atref-dropdown')).toBeNull() // menu closes after picking
    editor.destroy()
  })

  test('"Copy formatted" writes plain HTML via the async Clipboard API when available, with no background styling anywhere in it', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('**bold** text')

    const write = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { write } })
    class FakeClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    }
    ;(globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem
    // jsdom's bundled Blob has no .text() to read content back out of — spy
    // on the Blob constructor instead to capture the raw string it was built
    // from, which is all this test needs to verify.
    const blobParts: string[] = []
    const RealBlob = Blob
    class SpyBlob extends RealBlob {
      constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
        super(parts, opts)
        blobParts.push(String(parts[0]))
      }
    }
    vi.stubGlobal('Blob', SpyBlob)

    openCopyMenu(editor)
    pickCopyOption(t('en-US', 'editor_copy_option_formatted'))
    await Promise.resolve() // let the write() promise settle

    expect(write).toHaveBeenCalledOnce()
    const html = blobParts[0]!
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toMatch(/background/i)

    editor.destroy()
    Reflect.deleteProperty(navigator, 'clipboard')
    Reflect.deleteProperty(globalThis as object, 'ClipboardItem')
    vi.unstubAllGlobals()
  })

  test('"Copy plain text" copies textContent via the Clipboard API when available', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('**bold** text')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    openCopyMenu(editor)
    pickCopyOption(t('en-US', 'editor_copy_option_plain'))

    expect(writeText).toHaveBeenCalledWith('bold text')
    editor.destroy()
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  test('"Copy plain text" falls back to a hidden textarea + execCommand when the Clipboard API is unavailable', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('plain content')
    Reflect.deleteProperty(navigator, 'clipboard')
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    openCopyMenu(editor)
    pickCopyOption(t('en-US', 'editor_copy_option_plain'))

    expect(execSpy).toHaveBeenCalledWith('copy', false, undefined)
    editor.destroy()
  })

  test('"Copy as markdown" copies the raw markdown source via the Clipboard API when available', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('**bold** text')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    openCopyMenu(editor)
    pickCopyOption(t('en-US', 'editor_copy_option_markdown'))

    expect(writeText).toHaveBeenCalledWith('**bold** text')
    editor.destroy()
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  test('@ button inserts "@" at the caret via execCommand, same path real typing takes', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('hello')
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    toolbarButton(editor, t('en-US', 'editor_insert_ref_title')).click()

    expect(execSpy).toHaveBeenCalledWith('insertText', false, '@')
    editor.destroy()
  })

})

describe('block-prefix auto-format on typing', () => {
  function setBlockText(editorEl: HTMLElement, text: string): void {
    editorEl.innerHTML = `<div>${text}</div>`
    const textNode = editorEl.firstChild!.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  test('typing "# " auto-converts the block to h1 (control case)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    setBlockText(editorEl, '# ')
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(execSpy).toHaveBeenCalledWith('formatBlock', false, '<h1>')
    editor.destroy()
  })

  test('typing "- " auto-converts the block to an unordered list (built directly, not via the unreliable execCommand path)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    setBlockText(editorEl, '- ')
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    const ul = editorEl.querySelector('ul')
    expect(ul).not.toBeNull()
    expect(ul!.parentElement).toBe(editorEl)
    expect(ul!.querySelectorAll('li')).toHaveLength(1)
    const sel = window.getSelection()!
    expect(sel.rangeCount).toBe(1)
    expect(sel.getRangeAt(0).collapsed).toBe(true)
    expect(ul!.querySelector('li')!.contains(sel.anchorNode)).toBe(true)
    editor.destroy()
  })

  test('typing "--- " auto-converts the block to a horizontal rule, with an empty block after it for the caret', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    setBlockText(editorEl, '--- ')
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    const hr = editorEl.querySelector('hr')
    expect(hr).not.toBeNull()
    expect(hr!.parentElement).toBe(editorEl)
    const next = hr!.nextElementSibling as HTMLElement
    expect(next).not.toBeNull()
    expect(next.tagName).toBe('DIV')
    const sel = window.getSelection()!
    expect(sel.rangeCount).toBe(1)
    expect(sel.getRangeAt(0).collapsed).toBe(true)
    expect(next.contains(sel.anchorNode)).toBe(true)
    editor.destroy()
  })

  test('editor.getMd() serializes the inserted rule back to "---"', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    setBlockText(editorEl, '--- ')
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editor.getMd()).toBe('---\n')
    editor.destroy()
  })

  test('typing "--- " inside a list item is not intercepted (converting would produce unrepresentable markup) and the typed text is preserved', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = '<ul><li>--- </li></ul>'
    const li = editorEl.querySelector('li')!
    const textNode = li.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editorEl.querySelector('hr')).toBeNull()
    expect(li.textContent).toBe('--- ')
    editor.destroy()
  })

  test('typing "1. " auto-converts the block to an ordered list (built directly, not via the unreliable execCommand path)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    setBlockText(editorEl, '1. ')
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    const ol = editorEl.querySelector('ol')
    expect(ol).not.toBeNull()
    expect(ol!.parentElement).toBe(editorEl)
    expect(ol!.querySelectorAll('li')).toHaveLength(1)
    editor.destroy()
  })

  test('pressing Enter on a block containing only "---" converts it to an hr (no trailing space needed)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    setBlockText(editorEl, '---')
    const e = dispatchKey(editorEl, { key: 'Enter' })

    expect(e.defaultPrevented).toBe(true)
    const hr = editorEl.querySelector('hr')
    expect(hr).not.toBeNull()
    const next = hr!.nextElementSibling as HTMLElement
    expect(next.tagName).toBe('DIV')
    const sel = window.getSelection()!
    expect(next.contains(sel.anchorNode)).toBe(true)
    editor.destroy()
  })

  test('Enter on a block that is not exactly "---" behaves normally (not intercepted)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    setBlockText(editorEl, 'some text --')
    const e = dispatchKey(editorEl, { key: 'Enter' })

    expect(e.defaultPrevented).toBe(false)
    expect(editorEl.querySelector('hr')).toBeNull()
    editor.destroy()
  })

  test('Enter on "---" inside a list item is not intercepted (converting would produce unrepresentable markup)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = '<ul><li>---</li></ul>'
    const li = editorEl.querySelector('li')!
    const textNode = li.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    const e = dispatchKey(editorEl, { key: 'Enter' })

    expect(e.defaultPrevented).toBe(false)
    expect(editorEl.querySelector('hr')).toBeNull()
    editor.destroy()
  })
})

describe('inline auto-format guards', () => {
  test('skips auto-format when the matched span contains an embedded element (e.g. ref chip)', () => {
    const hooks = makeHooks()
    const editor = createEditor(hooks, 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    // textContent of the block reads as closed bold ("**@Ana**"), but the
    // span contains a ref chip <a> inserted by autocomplete, not plain text.
    editorEl.innerHTML =
      '<div>**<a class="ref" data-ref="person:abc-1" contenteditable="false">@Ana</a>**</div>'
    const block = editorEl.firstChild as HTMLElement
    const trailingText = block.lastChild as Text
    const range = document.createRange()
    range.setStart(trailingText, trailingText.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editorEl.querySelector('a.ref')).not.toBeNull()
    expect(editorEl.querySelector('strong')).toBeNull()
    editor.destroy()
  })

  test('setMd cancels a pending onChange debounce so a stale keystroke cannot fire against the new document', () => {
    vi.useFakeTimers()
    try {
      const hooks = makeHooks()
      const editor = createEditor(hooks, 'en-US')
      document.body.appendChild(editor.root)
      const editorEl = editor.root.querySelector('.editor') as HTMLElement

      editorEl.innerHTML = '<div>hi</div>'
      editorEl.dispatchEvent(new Event('input', { bubbles: true }))

      editor.setMd('new content')
      vi.advanceTimersByTime(400) // > CHANGE_DEBOUNCE_MS (300)

      expect(hooks.changes).toBe(0)
      editor.destroy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('detectInlinePattern', () => {
  test('detects closed bold at caret', () => {
    expect(detectInlinePattern('a **b** ', 7)).toEqual({ start: 2, end: 7, marker: '**', content: 'b' })
  })
  test('detects closed italic at caret', () => {
    expect(detectInlinePattern('a *b* ', 5)).toEqual({ start: 2, end: 5, marker: '*', content: 'b' })
  })
  test('detects closed strike at caret', () => {
    expect(detectInlinePattern('a ~~b~~ ', 7)).toEqual({ start: 2, end: 7, marker: '~~', content: 'b' })
  })
  test('returns null when unclosed', () => {
    expect(detectInlinePattern('a **b', 5)).toBeNull()
  })
  test('prefers ** over * for bold', () => {
    expect(detectInlinePattern('**b**', 5)?.marker).toBe('**')
  })
})

describe('detectBlockPrefix', () => {
  test('detects heading prefixes', () => {
    expect(detectBlockPrefix('# ')).toEqual({ type: 'h1', prefixLen: 2 })
    expect(detectBlockPrefix('## ')).toEqual({ type: 'h2', prefixLen: 3 })
    expect(detectBlockPrefix('### ')).toEqual({ type: 'h3', prefixLen: 4 })
  })
  test('detects list prefixes', () => {
    expect(detectBlockPrefix('- ')).toEqual({ type: 'ul', prefixLen: 2 })
    expect(detectBlockPrefix('1. ')).toEqual({ type: 'ol', prefixLen: 3 })
    expect(detectBlockPrefix('12. ')).toEqual({ type: 'ol', prefixLen: 4 })
  })
  test('detects --- (3+ dashes) with a trailing space as hr', () => {
    expect(detectBlockPrefix('--- ')).toEqual({ type: 'hr', prefixLen: 4 })
    expect(detectBlockPrefix('---- ')).toEqual({ type: 'hr', prefixLen: 5 })
    expect(detectBlockPrefix('----------- ')).toEqual({ type: 'hr', prefixLen: 12 })
  })
  test('does not detect hr with fewer than 3 dashes', () => {
    expect(detectBlockPrefix('-- ')).toBeNull()
    expect(detectBlockPrefix('- ')).toEqual({ type: 'ul', prefixLen: 2 }) // still a list bullet, unaffected
  })
  test('does not match mid-block text', () => {
    expect(detectBlockPrefix('# hello')).toBeNull()
    expect(detectBlockPrefix('hello')).toBeNull()
  })
  test('matches when the trailing space is a non-breaking space (\\u00A0) — real Chrome inserts nbsp instead of a regular space for whitespace at the edge of a text node, which is exactly the position typing "- " at the start of an empty line lands in', () => {
    const nbsp = ' '
    expect(detectBlockPrefix('-' + nbsp)).toEqual({ type: 'ul', prefixLen: 2 })
    expect(detectBlockPrefix('1.' + nbsp)).toEqual({ type: 'ol', prefixLen: 3 })
    expect(detectBlockPrefix('#' + nbsp)).toEqual({ type: 'h1', prefixLen: 2 })
  })
  test('detects hr prefix with trailing NBSP too', () => {
    const nbsp = ' '
    expect(detectBlockPrefix('---' + nbsp)).toEqual({ type: 'hr', prefixLen: 4 })
  })
})

describe('resolveRefLabel hook', () => {
  test('setMd uses hooks.resolveRefLabel to show the live label when provided', () => {
    const hooks = makeHooks()
    const editorWithResolver = createEditor(
      { ...hooks, resolveRefLabel: (target) => (target.kind === 'action' ? 'Live Title' : null) },
      'pt-BR'
    )
    editorWithResolver.setMd('see @[Stale Title](action:a1)')
    const chip = editorWithResolver.root.querySelector('a.ref') as HTMLAnchorElement
    expect(chip.textContent).toBe('@Live Title')
    editorWithResolver.destroy()
  })

  test('setMd falls back to the stored label when resolveRefLabel is not provided', () => {
    const editor = createEditor(makeHooks(), 'pt-BR')
    editor.setMd('see @[Stale Title](action:a1)')
    const chip = editor.root.querySelector('a.ref') as HTMLAnchorElement
    expect(chip.textContent).toBe('@Stale Title')
    editor.destroy()
  })
})

// flushAllEditors() backs main.ts's save-then-teardown paths (close-file,
// tab-hide, beforeunload). Those save the document from outside the editing
// flow, so without it a save firing within CHANGE_DEBOUNCE_MS of a keystroke
// persists a document that doesn't contain it yet — and on close-file that is
// the last write the document ever gets.
describe('flushAllEditors', () => {
  test('commits a pending change on every live editor', () => {
    vi.useFakeTimers()
    try {
      const hooksA = makeHooks()
      const hooksB = makeHooks()
      const a = createEditor(hooksA, 'en-US')
      const b = createEditor(hooksB, 'en-US')

      a.root.querySelector('.editor')!.dispatchEvent(new Event('input', { bubbles: true }))
      b.root.querySelector('.editor')!.dispatchEvent(new Event('input', { bubbles: true }))
      expect(hooksA.changes).toBe(0) // still inside the debounce

      flushAllEditors()
      expect(hooksA.changes).toBe(1)
      expect(hooksB.changes).toBe(1)

      // The timer was consumed, not left to fire a second time.
      vi.advanceTimersByTime(1000)
      expect(hooksA.changes).toBe(1)
      expect(hooksB.changes).toBe(1)

      a.destroy()
      b.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a destroyed editor is no longer flushed', () => {
    vi.useFakeTimers()
    try {
      const hooks = makeHooks()
      const ed = createEditor(hooks, 'en-US')
      ed.root.querySelector('.editor')!.dispatchEvent(new Event('input', { bubbles: true }))

      ed.destroy() // flushes once on the way out
      expect(hooks.changes).toBe(1)

      flushAllEditors()
      expect(hooks.changes).toBe(1) // not flushed again
    } finally {
      vi.useRealTimers()
    }
  })

  test('flushing with nothing pending is a no-op', () => {
    const hooks = makeHooks()
    const ed = createEditor(hooks, 'en-US')
    flushAllEditors()
    expect(hooks.changes).toBe(0)
    ed.destroy()
  })
})
