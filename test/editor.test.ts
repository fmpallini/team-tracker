import { createEditor, detectInlinePattern, detectBlockPrefix, type Editor, type EditorHooks } from '../src/ui/editor'
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
  test('strips rich HTML and inserts only plain text', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    // jsdom has no ClipboardEvent constructor; a plain Event with a
    // clipboardData property is enough since the handler only reads that.
    const clipboardData = {
      getData: (fmt: string) => (fmt === 'text/plain' ? 'plain text' : '<b>rich</b> text'),
    } as unknown as DataTransfer
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: clipboardData })
    const preventDefault = vi.spyOn(event, 'preventDefault')

    editor.root.querySelector('.editor')!.dispatchEvent(event)

    expect(preventDefault).toHaveBeenCalled()
    expect(execSpy).toHaveBeenCalledWith('insertText', false, 'plain text')
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
})

describe('keyboard shortcuts', () => {
  function dispatchKey(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    el.dispatchEvent(e)
    return e
  }

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

  test('copy-formatted button selects the editor content and copies it', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('**bold** text')
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    toolbarButton(editor, t('en-US', 'editor_copy_formatted_title')).click()

    expect(execSpy).toHaveBeenCalledWith('copy', false, undefined)
    const sel = window.getSelection()!
    expect(sel.rangeCount).toBe(0) // selection cleared after copying, so it doesn't visually linger
    editor.destroy()
  })

  test('copy-plain button copies textContent via the Clipboard API when available', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('**bold** text')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    toolbarButton(editor, t('en-US', 'editor_copy_plain_title')).click()

    expect(writeText).toHaveBeenCalledWith('bold text')
    editor.destroy()
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  test('copy-plain button falls back to a hidden textarea + execCommand when the Clipboard API is unavailable', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('plain content')
    Reflect.deleteProperty(navigator, 'clipboard')
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    toolbarButton(editor, t('en-US', 'editor_copy_plain_title')).click()

    expect(execSpy).toHaveBeenCalledWith('copy', false, undefined)
    editor.destroy()
  })

  test('print button opens a print window and appends a clone of the editor content via DOM APIs (not document.write with content)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('printable note')

    const printSpy = vi.fn()
    const bodyAppend = vi.fn()
    const fakeWin = {
      document: { write: vi.fn(), close: vi.fn(), body: { appendChild: bodyAppend } },
      focus: vi.fn(),
      print: printSpy,
    } as unknown as Window
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin)

    toolbarButton(editor, t('en-US', 'editor_print_title')).click()

    expect(openSpy).toHaveBeenCalled()
    expect(bodyAppend).toHaveBeenCalledOnce()
    const appended = bodyAppend.mock.calls[0]![0] as HTMLElement
    expect(appended.textContent).toContain('printable note')
    expect(printSpy).toHaveBeenCalled()
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

  test('typing "- " auto-converts the block to an unordered list', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    setBlockText(editorEl, '- ')
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(execSpy).toHaveBeenCalledWith('insertUnorderedList', false, undefined)
    editor.destroy()
  })

  test('typing "1. " auto-converts the block to an ordered list', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement

    setBlockText(editorEl, '1. ')
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(execSpy).toHaveBeenCalledWith('insertOrderedList', false, undefined)
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
  test('does not match mid-block text', () => {
    expect(detectBlockPrefix('# hello')).toBeNull()
    expect(detectBlockPrefix('hello')).toBeNull()
  })
})
