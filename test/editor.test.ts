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

  test('does not leak "StartFragment"/"EndFragment" from a partial-selection paste (Windows CF_HTML fragment markers)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    dispatchPaste(editor, {
      'text/html': '<div><!--StartFragment-->pasted text<!--EndFragment--></div>',
    })

    const inserted = execSpy.mock.calls.find((c) => c[0] === 'insertHTML')![2] as string
    expect(inserted).not.toContain('StartFragment')
    expect(inserted).not.toContain('EndFragment')
    expect(inserted).toContain('pasted text')
    editor.destroy()
  })

  test('pasting a Google-Docs-shaped multi-paragraph export does not bold everything or mash the paragraphs together', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    dispatchPaste(editor, {
      'text/html': '<b style="font-weight:normal" id="docs-internal-guid-x"><p>line1</p><p>line2</p></b>',
    })

    const inserted = execSpy.mock.calls.find((c) => c[0] === 'insertHTML')![2] as string
    expect(inserted).not.toContain('<strong>')
    expect(inserted).toBe('<div>line1</div><div>line2</div>')
    editor.destroy()
  })

  test('pasting a table renders readable pipe-separated rows instead of mashed text', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    dispatchPaste(editor, {
      'text/html': '<table><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></table>',
    })

    const inserted = execSpy.mock.calls.find((c) => c[0] === 'insertHTML')![2] as string
    expect(inserted).toContain('A1 | B1')
    expect(inserted).toContain('A2 | B2')
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

  test('a legitimate ref chip (this app\'s own uuid-shaped id) survives paste as a real chip', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    dispatchPaste(editor, {
      'text/html': `<a class="ref" data-ref="person:3f2504e0-4f89-11d3-9a0c-0305e82c3301" contenteditable="false">@Ana</a>`,
    })

    const inserted = execSpy.mock.calls.find((c) => c[0] === 'insertHTML')![2] as string
    const probe = document.createElement('div')
    probe.innerHTML = inserted
    expect(probe.querySelector('a.ref')!.getAttribute('data-ref')).toBe('person:3f2504e0-4f89-11d3-9a0c-0305e82c3301')
    editor.destroy()
  })

  // Regression tests for a CodeQL alert flagged on this paste path: clipboard
  // HTML is untrusted, and a malicious <a data-ref="..."> could try to break
  // out of the data-ref="${ref}" attribute mdToHtml (core/markdown.ts's
  // inline()) rebuilds when re-rendering the pasted content.
  //
  // A same-pass quote in data-ref alone can't do it — inline() runs esc()
  // over the whole line before its ref regex captures ref/label, so a bare
  // `"` in data-ref is already `&quot;` by the time it's re-embedded. But
  // inline() runs MORE regexes after that one (bold/italic/strike/the
  // single-tilde unlinked-ref marker), over the *already-substituted*
  // string — and the tilde marker's own template (`class="tt-unlinked-ref"`)
  // contains a literal, unescaped `"`. A data-ref containing `~x~` reaches
  // that regex and DOES break out of the attribute (confirmed empirically
  // before this fix landed — the escaping-order argument alone was not
  // sufficient). sanitizeRefAttrs() (src/ui/editor.ts) closes this off at
  // the paste boundary instead: any data-ref whose id/date portion isn't
  // restricted to [A-Za-z0-9-] — the only characters this app's own ref ids
  // (crypto.randomUUID()) and dates ever contain — gets stripped before it
  // ever reaches the markdown pipeline, so neither attack has anything to
  // work with.
  test('a data-ref with a bare quote is stripped, not left as an inert-but-intact chip', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    dispatchPaste(editor, {
      'text/html': `<a data-ref='person:x"onmouseover="window.__xss=1'>evil</a>`,
    })

    const inserted = execSpy.mock.calls.find((c) => c[0] === 'insertHTML')![2] as string
    const probe = document.createElement('div')
    probe.innerHTML = inserted
    expect(probe.querySelector('[onmouseover]')).toBeNull()
    expect(probe.querySelector('a.ref')).toBeNull() // not a safe ref shape -> not turned into a chip at all
    expect(probe.textContent).toContain('evil') // visible text still survives
    editor.destroy()
  })

  test('a data-ref chained through the single-tilde unlinked-ref marker cannot break attribute quoting', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)

    dispatchPaste(editor, {
      'text/html': `<a data-ref='person:x~y~contenteditable="true"~z~'>evil</a>`,
    })

    const inserted = execSpy.mock.calls.find((c) => c[0] === 'insertHTML')![2] as string
    const probe = document.createElement('div')
    probe.innerHTML = inserted
    expect(probe.querySelector('a.ref')).toBeNull()
    expect(probe.querySelector('[contenteditable="true"]')).toBeNull()
    expect(probe.querySelectorAll('a').length).toBeLessThanOrEqual(1) // no tag-splitting from a broken-out attribute
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
    // Strikethrough takes Ctrl+Shift+X (cross-app convention) and Ctrl+Shift+5
    // (fallback for Windows browsers/drivers that eat the X chord); both
    // matched by physical key (e.code) so the produced e.key across layouts
    // ('%' / '(' / a non-Latin X position) doesn't matter.
    [{ key: 'X', code: 'KeyX', ctrlKey: true, shiftKey: true }, 'strikeThrough'],
    [{ key: '%', code: 'Digit5', ctrlKey: true, shiftKey: true }, 'strikeThrough'],
    [{ key: '5', code: 'Digit5', ctrlKey: true, shiftKey: true }, 'strikeThrough'],
    // Layout-independence: e.key for the physical position isn't the letter
    // (Dvorak/Colemak, or a dead-key/AltGr layout under Ctrl), so the match
    // must fall back to e.code — same as the digit-row shortcuts already do.
    [{ key: 'ñ', code: 'KeyB', ctrlKey: true }, 'bold'],
    [{ key: 'ç', code: 'KeyI', ctrlKey: true }, 'italic'],
    [{ key: 'º', code: 'KeyU', ctrlKey: true }, 'underline'],
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

  test('Ctrl+E toggles inline code on the selection', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('foo bar')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    // Focus before selecting: jsdom's focus() collapses the live selection on
    // the focus transition, and toggleInlineCode()'s first line is
    // editorEl.focus() — in a real browser the editor already holds focus when
    // Ctrl+E fires, so that call is a no-op there.
    editorEl.focus()
    const textNode = editorEl.querySelector('div')!.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 4); range.setEnd(textNode, 7)
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

    const e = dispatchKey(editorEl, { key: 'e', code: 'KeyE', ctrlKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(editorEl.querySelector('code')?.textContent).toBe('bar')
    editor.destroy()
  })

  test('Ctrl+Shift+9 runs formatBlock <blockquote>', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editor.setMd('a line')
    const e = dispatchKey(editorEl, { key: '(', code: 'Digit9', ctrlKey: true, shiftKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(execSpy).toHaveBeenCalledWith('formatBlock', false, '<blockquote>')
    editor.destroy()
  })

  test('Ctrl+K in the editor opens the link prompt and is consumed', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editor.setMd('x')

    const e = dispatchKey(editorEl, { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(e.defaultPrevented).toBe(true)
    await Promise.resolve()
    expect(document.querySelector('.tt-modal-dialog')).not.toBeNull()

    // clean up the open modal
    const cancel = Array.from(document.querySelectorAll('.tt-modal-dialog button')).find(b => b.textContent === t('en-US', 'cancel')) as HTMLButtonElement
    cancel.click()
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

  // Contenteditable editing at depth can leave a sub-list one level off from
  // the direct-<li>-child shape setMd produces: wrapped in a stray <div>
  // inside the <li>, or as a direct child of the ancestor list (sibling to
  // the <li> it followed). htmlToMd's nestedListsOf already tolerates these;
  // Shift+Tab's outdent must too, or it silently no-ops on a visibly nested
  // item.
  test('Shift+Tab promotes a nested item whose sub-list is wrapped in a stray <div>', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = '<ul><li>a<div><ul><li>b</li><li>c</li></ul></div></li></ul>'
    expect(editor.getMd()).toBe('- a\n  - b\n  - c') // precondition
    collapseInto(editorEl.querySelectorAll('li')[1]!) // "b"

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('- a\n- b\n  - c')
    editor.destroy()
  })

  test('Shift+Tab promotes a nested item whose sub-list is a direct child of the parent list', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = '<ul><li>a</li><ul><li>b</li><li>c</li></ul></ul>'
    expect(editor.getMd()).toBe('- a\n  - b\n  - c') // precondition
    collapseInto(editorEl.querySelectorAll('li')[1]!) // "b"

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('- a\n- b\n  - c')
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

  test('copy menu does not act while a modal is open (e.g. an async save-conflict error appearing over it)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('**bold** text')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    openCopyMenu(editor)
    document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tt-modal-overlay' }))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(writeText).not.toHaveBeenCalled()
    expect(document.querySelector('.tt-atref-dropdown')).not.toBeNull() // still open, untouched

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

  test('<> button wraps the selection in <code> and getMd emits backticks', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('foo bar baz')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const textNode = editorEl.querySelector('div')!.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 4); range.setEnd(textNode, 7) // "bar"
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

    toolbarButton(editor, t('en-US', 'editor_code_title')).click()

    expect(editorEl.querySelector('code')?.textContent).toBe('bar')
    expect(editor.getMd()).toBe('foo `bar` baz')
    editor.destroy()
  })

  test('<> button on a selection already inside <code> unwraps it', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('foo `bar` baz')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const codeText = editorEl.querySelector('code')!.firstChild as Text
    const range = document.createRange()
    range.selectNodeContents(codeText)
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

    toolbarButton(editor, t('en-US', 'editor_code_title')).click()

    expect(editorEl.querySelector('code')).toBeNull()
    expect(editor.getMd()).toBe('foo bar baz')
    editor.destroy()
  })

  test('❝ button runs formatBlock <blockquote> then flattens nesting', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('a line')
    toolbarButton(editor, t('en-US', 'editor_quote_title')).click()
    expect(execSpy).toHaveBeenCalledWith('formatBlock', false, '<blockquote>')
    editor.destroy()
  })

  test('❝ button collapses a nested blockquote to one level', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = '<blockquote>outer<blockquote>inner</blockquote></blockquote>'
    toolbarButton(editor, t('en-US', 'editor_quote_title')).click()
    expect(editorEl.querySelectorAll('blockquote').length).toBe(1)
    editor.destroy()
  })

  test('❝ button normalizes a <div>-built multi-line blockquote to <br>-separated lines (getMd keeps the breaks)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = '<blockquote><div>a</div><div>b</div></blockquote>'
    toolbarButton(editor, t('en-US', 'editor_quote_title')).click()
    expect(editor.getMd()).toBe('> a\n> b')
    editor.destroy()
  })

  test('🧹 clear-formatting also drops blockquote styling', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = '<blockquote>quoted</blockquote>'
    const range = document.createRange()
    range.selectNodeContents(editorEl.querySelector('blockquote')!)
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

    toolbarButton(editor, t('en-US', 'editor_clear_format_title')).click()

    expect(editorEl.querySelector('blockquote')).toBeNull()
    editor.destroy()
  })

  test('— button inserts an <hr> after the current block and round-trips', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('first line\nsecond line')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const firstDiv = editorEl.querySelector('div')!
    const range = document.createRange()
    range.selectNodeContents(firstDiv); range.collapse(false)
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

    toolbarButton(editor, t('en-US', 'editor_hr_title')).click()

    expect(editorEl.querySelector('hr')).not.toBeNull()
    expect(editor.getMd()).toBe('first line\n---\nsecond line')
    editor.destroy()
  })

  async function answerLinkPrompt(url: string | null): Promise<void> {
    // one microtask for the modal to mount
    await Promise.resolve()
    const dialog = document.querySelector('.tt-modal-dialog') as HTMLElement
    if (url === null) {
      const cancel = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === t('en-US', 'cancel'))!
      cancel.click()
    } else {
      ;(dialog.querySelector('input') as HTMLInputElement).value = url
      const ok = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === t('en-US', 'ok'))!
      ok.click()
    }
  }

  test('🔗 button wraps the selection as a markdown link', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('see docs here')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const textNode = editorEl.querySelector('div')!.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 4); range.setEnd(textNode, 8) // "docs"
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLinkPrompt('https://example.com')

    const inserted = execSpy.mock.calls.find(c => c[0] === 'insertText')![2]
    expect(inserted).toBe('[docs](https://example.com)')
    editor.destroy()
  })

  test('🔗 button with no selection uses the URL as the link text', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('x')
    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLinkPrompt('https://example.com')
    const inserted = execSpy.mock.calls.find(c => c[0] === 'insertText')![2]
    expect(inserted).toBe('[https://example.com](https://example.com)')
    editor.destroy()
  })

  test('🔗 button: cancelling the prompt inserts nothing', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('x')
    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLinkPrompt(null)
    expect(execSpy.mock.calls.some(c => c[0] === 'insertText')).toBe(false)
    editor.destroy()
  })

  test('🔗 button inserts the link at the saved selection, not appended, after the modal steals focus', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    // jsdom's execCommand is inert; emulate just enough of insertText
    // (replace the current selection with a text node) to observe WHERE the
    // link lands — the spy-arg-only tests can't see the misplacement bug.
    vi.spyOn(document, 'execCommand').mockImplementation((cmd: string, _ui?: boolean, value?: string) => {
      if (cmd === 'insertText' && typeof value === 'string') {
        const s = window.getSelection()
        if (s && s.rangeCount > 0) {
          const r = s.getRangeAt(0)
          r.deleteContents()
          r.insertNode(document.createTextNode(value))
        }
      }
      return true
    })
    editor.setMd('see docs here')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const textNode = editorEl.querySelector('div')!.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 4); range.setEnd(textNode, 8) // "docs"
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLinkPrompt('https://example.com')

    // Landed in place, replacing "docs" — NOT appended to the end.
    expect(editor.getMd()).toBe('see [docs](https://example.com) here')
  })

  test('🔗 button: a javascript: URL is rejected, nothing inserted', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('x')
    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLinkPrompt('javascript:alert(1)')
    expect(execSpy.mock.calls.some(c => c[0] === 'insertText')).toBe(false)
    editor.destroy()
  })

  test('Ctrl+click on an external link opens it in a new tab; a plain click does not', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('see [the docs](https://example.com/x)')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const a = editorEl.querySelector('a[href]') as HTMLAnchorElement
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)

    a.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(openSpy).not.toHaveBeenCalled()

    a.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect(openSpy).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener')
    editor.destroy()
  })

  test('middle-click on an external link opens it in a new tab', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('see [the docs](https://example.com/x)')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const a = editorEl.querySelector('a[href]') as HTMLAnchorElement
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)

    a.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(openSpy).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener')
    editor.destroy()
  })

  test('destroy() closes a still-open link-URL modal', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('x')
    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await Promise.resolve()
    expect(document.querySelector('.tt-modal-overlay')).not.toBeNull()
    editor.destroy()
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('toolbar button order is locked', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const titles = Array.from(editor.root.querySelectorAll<HTMLButtonElement>('.tt-editor-toolbar button')).map(b => b.title)
    expect(titles).toEqual([
      t('en-US', 'editor_bold_title'),
      t('en-US', 'editor_italic_title'),
      t('en-US', 'editor_underline_title'),
      t('en-US', 'editor_strike_title'),
      t('en-US', 'editor_code_title'),
      t('en-US', 'editor_ul_title'),
      t('en-US', 'editor_ol_title'),
      t('en-US', 'editor_h1_title'),
      t('en-US', 'editor_h2_title'),
      t('en-US', 'editor_h3_title'),
      t('en-US', 'editor_paragraph_title'),
      t('en-US', 'editor_quote_title'),
      t('en-US', 'editor_hr_title'),
      t('en-US', 'editor_clear_format_title'),
      t('en-US', 'editor_templates_title'),
      t('en-US', 'editor_insert_ref_title'),
      t('en-US', 'editor_link_title'),
      t('en-US', 'editor_copy_options_title'),
      t('en-US', 'editor_help_title'),
    ])
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

describe('typed link autoformat', () => {
  function typeInto(editorEl: HTMLElement, text: string): void {
    const div = editorEl.querySelector('div')!
    div.textContent = text
    const r = document.createRange()
    r.selectNodeContents(div); r.collapse(false)
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(r)
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))
  }

  test('a completed [text](https://…) becomes a live anchor', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editor.setMd('')
    typeInto(editorEl, 'see [docs](https://example.com)')
    const a = editorEl.querySelector('a[href]') as HTMLAnchorElement
    expect(a).not.toBeNull()
    expect(a.getAttribute('href')).toBe('https://example.com')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(a.textContent).toBe('docs')
    expect(editor.getMd()).toBe('see [docs](https://example.com)')
    editor.destroy()
  })

  test('a javascript: URL is left as literal text', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editor.setMd('')
    typeInto(editorEl, 'x [bad](javascript:alert(1))')
    expect(editorEl.querySelector('a[href]')).toBeNull()
    expect(editorEl.textContent).toBe('x [bad](javascript:alert(1))')
    editor.destroy()
  })

  test('the matched span containing an embedded element is left untouched', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    // "[x](" + <strong>bold</strong> + ")" reads as a closed [text](url) in
    // textContent, but the span holds an element — must not be rebuilt.
    editorEl.innerHTML = '<div>[x](https://ex.com/<strong>b</strong>)</div>'
    const block = editorEl.firstChild as HTMLElement
    const trailing = block.lastChild as Text
    const range = document.createRange()
    range.setStart(trailing, trailing.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges(); sel.addRange(range)
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))
    expect(editorEl.querySelector('a[href]')).toBeNull()
    expect(editorEl.querySelector('strong')).not.toBeNull()
    editor.destroy()
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

describe('refreshRefLabels', () => {
  test('patches an existing chip textContent to the resolver current value, in place', () => {
    let live = 'Old Title'
    const editor = createEditor(
      { ...makeHooks(), resolveRefLabel: (target) => (target.kind === 'action' ? live : null) },
      'pt-BR'
    )
    editor.setMd('see @[Old Title](action:a1)')
    const chip = editor.root.querySelector('a.ref') as HTMLAnchorElement
    expect(chip.textContent).toBe('@Old Title')

    live = 'New Title' // simulates a rename that happened elsewhere in the doc
    editor.refreshRefLabels()

    expect(chip.textContent).toBe('@New Title')
    // The very same DOM node was patched, not swapped for a new one — a live
    // caret elsewhere in the editor was never at risk of being disturbed.
    expect(editor.root.querySelector('a.ref')).toBe(chip)
    editor.destroy()
  })

  test('updates each chip independently by its own data-ref', () => {
    const titles: Record<string, string> = { a1: 'Action A', m1: 'Milestone M' }
    const editor = createEditor(
      {
        ...makeHooks(),
        resolveRefLabel: (target) => (target.kind === 'action' || target.kind === 'milestone' ? titles[target.id]! : null),
      },
      'pt-BR'
    )
    editor.setMd('@[stale](action:a1) and @[stale](milestone:m1)')
    titles.a1 = 'Renamed Action'
    editor.refreshRefLabels()
    const chips = editor.root.querySelectorAll('a.ref')
    expect(chips[0]!.textContent).toBe('@Renamed Action')
    expect(chips[1]!.textContent).toBe('@Milestone M') // untouched — its resolved value hasn't changed
    editor.destroy()
  })

  test('leaves the chip label untouched when the resolver returns null (dangling/unresolvable ref)', () => {
    const editor = createEditor({ ...makeHooks(), resolveRefLabel: () => null }, 'pt-BR')
    editor.setMd('see @[Frozen Label](action:gone)')
    editor.refreshRefLabels()
    const chip = editor.root.querySelector('a.ref') as HTMLAnchorElement
    expect(chip.textContent).toBe('@Frozen Label')
    editor.destroy()
  })

  test('is a no-op (does not throw) when resolveRefLabel was never supplied', () => {
    const editor = createEditor(makeHooks(), 'pt-BR')
    editor.setMd('see @[Stale Title](action:a1)')
    expect(() => editor.refreshRefLabels()).not.toThrow()
    expect(editor.root.querySelector('a.ref')!.textContent).toBe('@Stale Title')
    editor.destroy()
  })

  test('does not disturb a live caret positioned elsewhere in the editor', () => {
    let live = 'Old Title'
    const editor = createEditor(
      { ...makeHooks(), resolveRefLabel: (target) => (target.kind === 'action' ? live : null) },
      'pt-BR'
    )
    editor.setMd('see @[Old Title](action:a1)')
    document.body.appendChild(editor.root)

    const editorEl = editor.root.querySelector('.editor')!
    const lastBlock = editorEl.lastElementChild!
    const range = document.createRange()
    range.selectNodeContents(lastBlock)
    range.collapse(false)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    const before = { node: sel.getRangeAt(0).startContainer, offset: sel.getRangeAt(0).startOffset }

    live = 'New Title'
    editor.refreshRefLabels()

    const after = sel.getRangeAt(0)
    expect(after.startContainer).toBe(before.node)
    expect(after.startOffset).toBe(before.offset)
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
