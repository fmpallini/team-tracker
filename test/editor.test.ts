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

  test('typing @ inside a fenced code block does NOT fire onAtTrigger', () => {
    const hooks = makeHooks()
    const editor = createEditor(hooks, 'en-US')
    document.body.appendChild(editor.root)

    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = '<pre>hi @</pre>'
    const textNode = editorEl.querySelector('pre')!.firstChild!
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(hooks.atRanges.length).toBe(0)
    editor.destroy()
  })

  test('the @ toolbar button with the caret in a fenced code block inserts nothing', () => {
    const hooks = makeHooks()
    const editor = createEditor(hooks, 'en-US')
    document.body.appendChild(editor.root)

    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = '<pre>code</pre>'
    const textNode = editorEl.querySelector('pre')!.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, textNode.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    const atBtn = Array.from(editor.root.querySelectorAll<HTMLButtonElement>('.tt-editor-toolbar button'))
      .find((b) => b.title === t('en-US', 'editor_insert_ref_title'))!
    atBtn.click()

    expect(editorEl.querySelector('pre')!.textContent).toBe('code')
    expect(hooks.atRanges.length).toBe(0)
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

// Locks the full Ctrl/Ctrl+Shift shortcut set — every combo, its action, and
// its behaviour with the caret inside a fenced code block — before the
// dispatch ladder is refactored into a declarative table. Each row asserts
// the exact execCommand / DOM effect the current hand-written `if` chain
// produces, so the table version has to reproduce it byte for byte.
describe('keyboard shortcuts — full combo matrix', () => {
  function mount() {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    return { editor, editorEl, exec }
  }
  function caretIn(node: Node, offset: number): void {
    const r = document.createRange()
    r.setStart(node, offset); r.collapse(true)
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r)
  }

  test.each([
    ['Ctrl+2', { key: '2', code: 'Digit2', ctrlKey: true }, 'formatBlock', '<h2>'],
    ['Ctrl+3', { key: '3', code: 'Digit3', ctrlKey: true }, 'formatBlock', '<h3>'],
    ['Ctrl+0', { key: '0', code: 'Digit0', ctrlKey: true }, 'formatBlock', '<div>'],
    ['Ctrl+Shift+7', { key: '&', code: 'Digit7', ctrlKey: true, shiftKey: true }, 'insertOrderedList', undefined],
  ])('%s -> execCommand', (_label, init, cmd, arg) => {
    const { editor, editorEl, exec } = mount()
    editor.setMd('a line')
    const e = dispatchKey(editorEl, init)
    expect(e.defaultPrevented).toBe(true)
    expect(exec).toHaveBeenCalledWith(cmd, false, arg)
    editor.destroy()
  })

  test.each([
    ['Ctrl+Shift+Q (blockquote fallback)', { key: 'Q', code: 'KeyQ', ctrlKey: true, shiftKey: true }],
    ['Ctrl+Shift+9 via e.key "9"', { key: '9', code: 'Digit9', ctrlKey: true, shiftKey: true }],
  ])('%s runs formatBlock <blockquote>', (_label, init) => {
    const { editor, editorEl, exec } = mount()
    editor.setMd('a line')
    const e = dispatchKey(editorEl, init)
    expect(e.defaultPrevented).toBe(true)
    expect(exec).toHaveBeenCalledWith('formatBlock', false, '<blockquote>')
    editor.destroy()
  })

  test('Ctrl+E without Shift is not a shortcut — not consumed, no execCommand', () => {
    const { editor, editorEl, exec } = mount()
    editor.setMd('a line')
    const e = dispatchKey(editorEl, { key: 'e', code: 'KeyE', ctrlKey: true })
    expect(e.defaultPrevented).toBe(false)
    expect(exec).not.toHaveBeenCalled()
    editor.destroy()
  })

  test('an unbound Ctrl+Shift chord (Ctrl+Shift+B) is left alone outside a code block', () => {
    const { editor, editorEl } = mount()
    editor.setMd('a line')
    const e = dispatchKey(editorEl, { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true })
    expect(e.defaultPrevented).toBe(false)
    editor.destroy()
  })

  // Inside a <pre>: every formatting chord is swallowed (defaultPrevented) but
  // does nothing — except the code-block chord itself, which still fires to
  // leave the block (covered in 'code block editing').
  test.each([
    ['Ctrl+B', { key: 'b', code: 'KeyB', ctrlKey: true }, 'bold'],
    ['Ctrl+I', { key: 'i', code: 'KeyI', ctrlKey: true }, 'italic'],
    ['Ctrl+U', { key: 'u', code: 'KeyU', ctrlKey: true }, 'underline'],
    ['Ctrl+Shift+X', { key: 'X', code: 'KeyX', ctrlKey: true, shiftKey: true }, 'strikeThrough'],
    ['Ctrl+Shift+5', { key: '%', code: 'Digit5', ctrlKey: true, shiftKey: true }, 'strikeThrough'],
    ['Ctrl+Shift+8', { key: '*', code: 'Digit8', ctrlKey: true, shiftKey: true }, 'insertUnorderedList'],
    ['Ctrl+Shift+7', { key: '&', code: 'Digit7', ctrlKey: true, shiftKey: true }, 'insertOrderedList'],
    ['Ctrl+Shift+9', { key: '(', code: 'Digit9', ctrlKey: true, shiftKey: true }, 'formatBlock'],
    ['Ctrl+Shift+Q', { key: 'Q', code: 'KeyQ', ctrlKey: true, shiftKey: true }, 'formatBlock'],
  ])('%s inside a <pre> is swallowed and inert', (_label, init, forbiddenCmd) => {
    const { editor, editorEl, exec } = mount()
    editorEl.innerHTML = '<pre>code</pre>'
    caretIn(editorEl.querySelector('pre')!.firstChild as Text, 2)
    const e = dispatchKey(editorEl, init)
    expect(e.defaultPrevented).toBe(true)
    expect(exec.mock.calls.some(c => c[0] === forbiddenCmd)).toBe(false)
    editor.destroy()
  })

  test('Ctrl+1/2/3/0 inside a <pre> are swallowed and apply no heading', () => {
    const { editor, editorEl, exec } = mount()
    editorEl.innerHTML = '<pre>code</pre>'
    caretIn(editorEl.querySelector('pre')!.firstChild as Text, 2)
    for (const code of ['Digit1', 'Digit2', 'Digit3', 'Digit0']) {
      const e = dispatchKey(editorEl, { key: code.slice(-1), code, ctrlKey: true })
      expect(e.defaultPrevented).toBe(true)
    }
    expect(exec.mock.calls.some(c => c[0] === 'formatBlock')).toBe(false)
    editor.destroy()
  })

  test('Ctrl+K inside a <pre> is swallowed and opens no link modal', async () => {
    const { editor, editorEl } = mount()
    editorEl.innerHTML = '<pre>code</pre>'
    caretIn(editorEl.querySelector('pre')!.firstChild as Text, 2)
    const e = dispatchKey(editorEl, { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(e.defaultPrevented).toBe(true)
    await Promise.resolve()
    expect(document.querySelector('.tt-modal-dialog')).toBeNull()
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

describe('headings do not apply to list items', () => {
  function caretInto(node: Node): void {
    const range = document.createRange()
    range.selectNodeContents(node)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  test.each([
    ['a nested', '- parent\n  - child', 1],
    ['a top-level', '- only', 0],
  ])('Ctrl+1 on %s list item is a no-op — no formatBlock, structure intact', (_label, md, liIndex) => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd(md)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    caretInto(editorEl.querySelectorAll('li')[liIndex]!)

    dispatchKey(editorEl, { key: '1', code: 'Digit1', ctrlKey: true })

    expect(execSpy).not.toHaveBeenCalledWith('formatBlock', false, '<h1>')
    expect(editor.getMd()).toBe(md)
    editor.destroy()
  })

  test('the H1 toolbar button on a list item is a no-op too', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('- parent\n  - child')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    caretInto(editorEl.querySelectorAll('li')[1]!)

    const btn = Array.from(editor.root.querySelectorAll('.tt-editor-toolbar button')).find(
      (b) => b.getAttribute('title') === t('en-US', 'editor_h1_title')
    ) as HTMLButtonElement
    btn.click()

    expect(execSpy).not.toHaveBeenCalledWith('formatBlock', false, '<h1>')
    expect(editor.getMd()).toBe('- parent\n  - child')
    editor.destroy()
  })

  test('typing "# " inside a list item leaves the literal text, no heading', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<ul><li># </li></ul>'
    const li = editorEl.querySelector('li')!
    caretInto(li)
    // place caret at end of the "# " text
    const tn = li.firstChild as Text
    const r = document.createRange(); r.setStart(tn, tn.textContent!.length); r.collapse(true)
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editorEl.querySelector('h1')).toBeNull()
    expect(editorEl.querySelector('li')!.textContent).toBe('# ')
    editor.destroy()
  })

  test('Ctrl+1 on a plain (non-list) line still applies a heading', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('just text')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    caretInto(editorEl.firstChild!)

    dispatchKey(editorEl, { key: '1', code: 'Digit1', ctrlKey: true })

    expect(execSpy).toHaveBeenCalledWith('formatBlock', false, '<h1>')
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

  const linkInput = (name: 'tt-link-text' | 'tt-link-url'): HTMLInputElement =>
    document.querySelector(`.tt-modal-dialog input[name="${name}"]`) as HTMLInputElement
  const linkModalButton = (key: 'ok' | 'cancel'): HTMLButtonElement =>
    Array.from(document.querySelectorAll('.tt-modal-dialog button')).find(b => b.textContent === t('en-US', key)) as HTMLButtonElement

  // Drive the two-field link modal. `text: undefined` leaves the text field
  // at whatever it was pre-filled with; `text: ''` clears it.
  async function answerLink(res: { text?: string; url: string } | null): Promise<void> {
    // one microtask for the modal to mount
    await Promise.resolve()
    if (res === null) { linkModalButton('cancel').click(); return }
    if (res.text !== undefined) linkInput('tt-link-text').value = res.text
    linkInput('tt-link-url').value = res.url
    linkModalButton('ok').click()
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
    await Promise.resolve()
    // The selected text pre-fills the text field.
    expect(linkInput('tt-link-text').value).toBe('docs')
    await answerLink({ url: 'https://example.com' })

    const inserted = execSpy.mock.calls.find(c => c[0] === 'insertText')![2]
    expect(inserted).toBe('[docs](https://example.com)')
    editor.destroy()
  })

  test('🔗 button collapses whitespace in a multi-line selection so the link text stays a single line', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('x')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const div = editorEl.querySelector('div')!
    div.textContent = 'a\nb'
    const textNode = div.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 0); range.setEnd(textNode, 3) // "a\nb"
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)

    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLink({ url: 'https://example.com' })

    const inserted = execSpy.mock.calls.find(c => c[0] === 'insertText')![2]
    expect(inserted).toBe('[a b](https://example.com)')
    editor.destroy()
  })

  test('🔗 button with no selection and no text entered uses the URL as the link text', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('x')
    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await Promise.resolve()
    // Both fields start empty when nothing is selected.
    expect(linkInput('tt-link-text').value).toBe('')
    expect(linkInput('tt-link-url').value).toBe('')
    await answerLink({ url: 'https://example.com' })
    const inserted = execSpy.mock.calls.find(c => c[0] === 'insertText')![2]
    expect(inserted).toBe('[https://example.com](https://example.com)')
    editor.destroy()
  })

  test('🔗 button with no selection: both fields filled in insert [text](url)', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('x')
    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLink({ text: 'the site', url: 'https://example.com' })
    const inserted = execSpy.mock.calls.find(c => c[0] === 'insertText')![2]
    expect(inserted).toBe('[the site](https://example.com)')
    editor.destroy()
  })

  test('🔗 button: a scheme-less address gets https:// prepended before validation', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('x')
    for (const [typed, expected] of [
      ['google.com', 'https://google.com'],
      ['www.google.com', 'https://www.google.com'],
    ] as const) {
      execSpy.mockClear()
      toolbarButton(editor, t('en-US', 'editor_link_title')).click()
      await answerLink({ text: 'g', url: typed })
      const inserted = execSpy.mock.calls.find(c => c[0] === 'insertText')![2]
      expect(inserted).toBe(`[g](${expected})`)
    }
    editor.destroy()
  })

  test('🔗 button: an explicit scheme is left untouched (mailto:, and javascript: still rejected)', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('x')

    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLink({ text: 'mail', url: 'mailto:a@b.com' })
    expect(execSpy.mock.calls.find(c => c[0] === 'insertText')![2]).toBe('[mail](mailto:a@b.com)')

    execSpy.mockClear()
    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLink({ url: 'javascript:alert(1)' })
    expect(execSpy.mock.calls.some(c => c[0] === 'insertText')).toBe(false)
    expect(document.querySelector('.tt-modal-dialog .tt-field-error')!.textContent)
      .toBe(t('en-US', 'editor_link_invalid_url'))
    linkModalButton('cancel').click()
    editor.destroy()
  })

  test('🔗 button: cancelling the prompt inserts nothing', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('x')
    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLink(null)
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
    await answerLink({ url: 'https://example.com' })

    // Landed in place, replacing "docs" — NOT appended to the end.
    expect(editor.getMd()).toBe('see [docs](https://example.com) here')
  })

  test('🔗 button: a javascript: URL is rejected in-place — modal stays open with an error, nothing inserted', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('x')
    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLink({ url: 'javascript:alert(1)' })

    expect(execSpy.mock.calls.some(c => c[0] === 'insertText')).toBe(false)
    // Modal still open, input intact, error shown.
    expect(document.querySelector('.tt-modal-overlay')).not.toBeNull()
    expect(linkInput('tt-link-url').value).toBe('javascript:alert(1)')
    expect(document.querySelector('.tt-modal-dialog .tt-field-error')!.textContent)
      .toBe(t('en-US', 'editor_link_invalid_url'))
    editor.destroy()
  })

  test('🔗 button: correcting a rejected URL then confirming inserts the link', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('x')
    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLink({ text: 'site', url: 'not a url' })
    expect(execSpy.mock.calls.some(c => c[0] === 'insertText')).toBe(false)
    // Fix it and confirm again — same still-open modal.
    await answerLink({ url: 'https://example.com' })
    const inserted = execSpy.mock.calls.find(c => c[0] === 'insertText')![2]
    expect(inserted).toBe('[site](https://example.com)')
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
    editor.destroy()
  })

  test('🔗 button: caret inside an existing link opens the modal pre-filled to edit it', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('see [the docs](https://example.com/x)')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const a = editorEl.querySelector('a[href]') as HTMLAnchorElement
    const caret = document.createRange()
    caret.setStart(a.firstChild!, 3); caret.collapse(true)
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(caret)

    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await Promise.resolve()
    expect(document.querySelector('.tt-modal-title')!.textContent).toBe(t('en-US', 'editor_link_edit_title'))
    expect(linkInput('tt-link-text').value).toBe('the docs')
    expect(linkInput('tt-link-url').value).toBe('https://example.com/x')

    await answerLink({ url: 'https://example.com/y' })
    // The whole <a> node was swapped, text kept — no nested [[…](…)](…).
    expect(editor.getMd()).toBe('see [the docs](https://example.com/y)')
    expect(editorEl.querySelectorAll('a[href]')).toHaveLength(1)
    editor.destroy()
  })

  test('🔗 button: "Remove link" in edit mode unwraps the <a>, keeping its text', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('see [the docs](https://example.com/x) now')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const a = editorEl.querySelector('a[href]') as HTMLAnchorElement
    const caret = document.createRange()
    caret.setStart(a.firstChild!, 3); caret.collapse(true)
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(caret)

    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await Promise.resolve()
    const removeBtn = Array.from(document.querySelectorAll('.tt-modal-dialog button'))
      .find(b => b.textContent === t('en-US', 'editor_link_remove')) as HTMLButtonElement
    expect(removeBtn).toBeTruthy()
    removeBtn.click()
    await Promise.resolve() // let insertLink's post-await continuation run
    await Promise.resolve()

    expect(editorEl.querySelector('a[href]')).toBeNull()
    expect(editor.getMd()).toBe('see the docs now')
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
    editor.destroy()
  })

  test('🔗 button: no "Remove link" button when inserting a new link', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('plain text')

    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await Promise.resolve()
    const removeBtn = Array.from(document.querySelectorAll('.tt-modal-dialog button'))
      .find(b => b.textContent === t('en-US', 'editor_link_remove'))
    expect(removeBtn).toBeUndefined()
    editor.destroy()
  })

  test('🔗 button: editing an existing link can change its text', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('see [the docs](https://example.com/x)')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const a = editorEl.querySelector('a[href]') as HTMLAnchorElement
    const caret = document.createRange()
    caret.setStart(a.firstChild!, 3); caret.collapse(true)
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(caret)

    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLink({ text: 'the manual', url: 'https://example.com/x' })
    expect(editor.getMd()).toBe('see [the manual](https://example.com/x)')
    editor.destroy()
  })

  test('🔗 button: re-editing a link built by typed markdown does not double-wrap it', async () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editor.setMd('')
    // build the link the way the user did — by typing the markdown pattern
    const div = editorEl.querySelector('div')!
    div.textContent = 'go [site](https://example.com)'
    const r = document.createRange(); r.selectNodeContents(div); r.collapse(false)
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r)
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))
    const a = editorEl.querySelector('a[href]') as HTMLAnchorElement
    expect(a).not.toBeNull()

    // caret inside it, Ctrl+K, change only the URL
    const caret = document.createRange()
    caret.setStart(a.firstChild!, 2); caret.collapse(true)
    s.removeAllRanges(); s.addRange(caret)
    toolbarButton(editor, t('en-US', 'editor_link_title')).click()
    await answerLink({ url: 'https://example.com/next' })

    expect(editor.getMd()).toBe('go [site](https://example.com/next)')
    expect(editorEl.querySelectorAll('a[href]')).toHaveLength(1)
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
    expect(openSpy).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer')

    editor.destroy()
    // listeners are gone: a re-dispatched ctrl+click does nothing more
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect(openSpy).toHaveBeenCalledTimes(1)
  })

  test('middle-click on an external link opens it in a new tab', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('see [the docs](https://example.com/x)')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const a = editorEl.querySelector('a[href]') as HTMLAnchorElement
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)

    a.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(openSpy).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer')

    editor.destroy()
    // listeners are gone: a re-dispatched middle-click does nothing more
    a.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(openSpy).toHaveBeenCalledTimes(1)
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
      t('en-US', 'editor_ul_title'),
      t('en-US', 'editor_ol_title'),
      t('en-US', 'editor_h1_title'),
      t('en-US', 'editor_h2_title'),
      t('en-US', 'editor_h3_title'),
      t('en-US', 'editor_paragraph_title'),
      t('en-US', 'editor_quote_title'),
      t('en-US', 'editor_codeblock_title'),
      t('en-US', 'editor_hr_title'),
      t('en-US', 'editor_link_title'),
      t('en-US', 'editor_clear_format_title'),
      t('en-US', 'editor_templates_title'),
      t('en-US', 'editor_insert_ref_title'),
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

describe('blockquote editing', () => {
  function mount(): { editor: Editor; editorEl: HTMLElement } {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    return { editor, editorEl }
  }
  function caretIn(node: Node, offset: number): void {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  test('typing "> " at the start of a top-level line turns it into a blockquote', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<div>> </div>'
    const textNode = editorEl.firstChild!.firstChild as Text
    caretIn(textNode, textNode.textContent!.length)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    const bq = editorEl.querySelector('blockquote')!
    expect(bq).not.toBeNull()
    expect(bq.textContent).toBe('') // "> " prefix consumed, empty line ready for typing
    expect(bq.innerHTML).toBe('<br>')
    editor.destroy()
  })

  // Regression: "> " autoformat used to strip the prefix and then call
  // execCommand('formatBlock', '<blockquote>') against a collapsed caret in
  // the now-empty <div>. Chromium's formatBlock skips an empty block and
  // wraps the NEXT one instead — so the following line got pulled into the
  // quote and a stray empty <div> was left where the caret was.
  test('typing "> " does not swallow the following line into the blockquote', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<div>> </div><div>next line</div><div>third line</div>'
    const textNode = editorEl.firstChild!.firstChild as Text
    caretIn(textNode, textNode.textContent!.length)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    const bq = editorEl.querySelector('blockquote')!
    expect(bq.textContent).toBe('')
    expect(bq.nextElementSibling!.textContent).toBe('next line')
    expect(bq.nextElementSibling!.nextElementSibling!.textContent).toBe('third line')
    expect(editorEl.querySelectorAll('div')).toHaveLength(2) // no stray empty <div>
    editor.destroy()
  })

  test('typing "> " inside a list item is left as literal text (a nested quote cannot round-trip)', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<ul><li>> </li></ul>'
    const li = editorEl.querySelector('li')!
    caretIn(li.firstChild as Text, (li.firstChild as Text).textContent!.length)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editorEl.querySelector('blockquote')).toBeNull()
    expect(li.textContent).toBe('> ')
    editor.destroy()
  })

  test.each([
    ['# ', 'h1'],
    ['- ', 'ul'],
    ['--- ', 'hr'],
  ])('typing %o inside a blockquote is a no-op (block formatting cannot round-trip through "> ")', (prefix, tag) => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = `<blockquote>${prefix}</blockquote>`
    const bq = editorEl.querySelector('blockquote')!
    caretIn(bq.firstChild as Text, (bq.firstChild as Text).textContent!.length)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editorEl.querySelector(tag)).toBeNull()
    expect(editorEl.querySelector('blockquote')!.textContent).toBe(prefix)
    editor.destroy()
  })

  test('plain Enter inside a blockquote inserts a line break, not a paragraph split', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<blockquote>alpha</blockquote>'
    const textNode = editorEl.querySelector('blockquote')!.firstChild as Text
    caretIn(textNode, textNode.textContent!.length)

    const e = dispatchKey(editorEl, { key: 'Enter' })

    expect(e.defaultPrevented).toBe(true)
    expect(execSpy).toHaveBeenCalledWith('insertLineBreak', false, undefined)
    expect(execSpy).not.toHaveBeenCalledWith('insertParagraph', expect.anything(), expect.anything())
    expect(editorEl.querySelectorAll('blockquote')).toHaveLength(1)
    editor.destroy()
  })

  test('Enter on an empty final line leaves the blockquote for a fresh paragraph', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<blockquote>alpha<br><br></blockquote>'
    const bq = editorEl.querySelector('blockquote')!
    caretIn(bq, 2) // after "alpha" and the first <br>, on the empty last line

    const e = dispatchKey(editorEl, { key: 'Enter' })

    expect(e.defaultPrevented).toBe(true)
    const quote = editorEl.querySelector('blockquote')!
    expect(quote.textContent).toBe('alpha')
    const after = quote.nextElementSibling as HTMLElement
    expect(after.tagName).toBe('DIV')
    expect(window.getSelection()!.getRangeAt(0).startContainer === after || after.contains(window.getSelection()!.getRangeAt(0).startContainer)).toBe(true)
    expect(editor.getMd()).toBe('> alpha\n')
    editor.destroy()
  })

  test('Enter on an otherwise-empty blockquote replaces it with a paragraph', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<blockquote><br></blockquote>'
    const bq = editorEl.querySelector('blockquote')!
    caretIn(bq, 0)

    dispatchKey(editorEl, { key: 'Enter' })

    expect(editorEl.querySelector('blockquote')).toBeNull()
    expect(editorEl.firstElementChild!.tagName).toBe('DIV')
    editor.destroy()
  })

  // Regression: exit-Enter on a blockquote whose last line carried inline
  // formatting used to delete the whole quote. `insertLineBreak` at the end
  // of a bold run leaves the trailing <br> INSIDE the <strong>, so its
  // parentNode is the <strong>, not the blockquote — exitFlatBlock's old
  // `opener.parentNode === block` guard failed and the cut fell back to
  // deleting from the block's start.
  test('Enter to leave a blockquote whose last line is bold keeps the quote content', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    // DOM as it stands after one insertLineBreak past "bold": <br> nested in <strong>
    editorEl.innerHTML = '<blockquote>a<br>b<br><strong>bold<br></strong></blockquote>'
    const strong = editorEl.querySelector('strong')!
    caretIn(strong, 2) // after "bold" text and the nested <br>, on the empty last line

    const e = dispatchKey(editorEl, { key: 'Enter' })

    expect(e.defaultPrevented).toBe(true)
    const quote = editorEl.querySelector('blockquote')!
    expect(quote).not.toBeNull()
    expect(quote.textContent).toBe('abbold') // nothing wiped
    expect(quote.querySelector('strong')!.textContent).toBe('bold')
    const after = quote.nextElementSibling as HTMLElement
    expect(after.tagName).toBe('DIV')
    expect(editor.getMd()).toBe('> a\n> b\n> **bold**\n')
    editor.destroy()
  })

  test('Ctrl+Shift+9 with the caret already in a blockquote unwraps it', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<blockquote>quoted</blockquote>'
    const range = document.createRange()
    range.selectNodeContents(editorEl.querySelector('blockquote')!)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    const e = dispatchKey(editorEl, { key: '(', code: 'Digit9', ctrlKey: true, shiftKey: true })

    expect(e.defaultPrevented).toBe(true)
    expect(editorEl.querySelector('blockquote')).toBeNull()
    expect(editor.getMd()).toBe('quoted')
    editor.destroy()
  })

  test('Ctrl+1 with the caret in a blockquote does not apply a heading', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<blockquote>quoted</blockquote>'
    const textNode = editorEl.querySelector('blockquote')!.firstChild as Text
    caretIn(textNode, 3)

    dispatchKey(editorEl, { key: '1', code: 'Digit1', ctrlKey: true })

    expect(execSpy).not.toHaveBeenCalledWith('formatBlock', false, '<h1>')
    editor.destroy()
  })

  test('Ctrl+Shift+8 with the caret in a blockquote does not start a list', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<blockquote>quoted</blockquote>'
    const textNode = editorEl.querySelector('blockquote')!.firstChild as Text
    caretIn(textNode, 3)

    dispatchKey(editorEl, { key: '*', code: 'Digit8', ctrlKey: true, shiftKey: true })

    expect(execSpy).not.toHaveBeenCalledWith('insertUnorderedList', false, undefined)
    editor.destroy()
  })

  test('the — toolbar button with the caret in a blockquote inserts no rule', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<blockquote>quoted</blockquote>'
    const textNode = editorEl.querySelector('blockquote')!.firstChild as Text
    caretIn(textNode, 3)

    const hrBtn = Array.from(editor.root.querySelectorAll('.tt-editor-toolbar button')).find(
      (b) => b.getAttribute('title') === t('en-US', 'editor_hr_title')
    ) as HTMLButtonElement
    hrBtn.click()

    expect(editorEl.querySelector('hr')).toBeNull()
    editor.destroy()
  })

  test('Ctrl+Shift+Q is an alternate blockquote chord (for drivers that eat Ctrl+Shift+9)', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('a line')

    const e = dispatchKey(editorEl, { key: 'Q', code: 'KeyQ', ctrlKey: true, shiftKey: true })

    expect(e.defaultPrevented).toBe(true)
    expect(execSpy).toHaveBeenCalledWith('formatBlock', false, '<blockquote>')
    editor.destroy()
  })

  test('Ctrl+Shift+Q with the caret already in a blockquote unwraps it too', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<blockquote>quoted</blockquote>'
    const range = document.createRange()
    range.selectNodeContents(editorEl.querySelector('blockquote')!)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    dispatchKey(editorEl, { key: 'Q', code: 'KeyQ', ctrlKey: true, shiftKey: true })

    expect(editorEl.querySelector('blockquote')).toBeNull()
    editor.destroy()
  })
})

describe('code block editing', () => {
  function mount(): { editor: Editor; editorEl: HTMLElement } {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    return { editor, editorEl }
  }
  function caretIn(node: Node, offset: number): void {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  test('typing "``` " at the start of a top-level line turns it into a <pre>', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<div>``` </div>'
    const textNode = editorEl.firstChild!.firstChild as Text
    caretIn(textNode, textNode.textContent!.length)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editorEl.querySelector('pre')).not.toBeNull()
    expect(editorEl.querySelector('div')).toBeNull()
    editor.destroy()
  })

  test('typing "```" then Enter also opens a code block (GitHub/Slack gesture)', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<div>```</div>'
    const textNode = editorEl.firstChild!.firstChild as Text
    caretIn(textNode, textNode.textContent!.length)

    const e = dispatchKey(editorEl, { key: 'Enter' })

    expect(e.defaultPrevented).toBe(true)
    expect(editorEl.querySelector('pre')).not.toBeNull()
    expect(editorEl.querySelector('div')).toBeNull()
    editor.destroy()
  })

  test('the ❝ quote button title lists Ctrl+Shift+Q as the alternate chord', () => {
    for (const loc of ['en-US', 'pt-BR'] as const) {
      expect(t(loc, 'editor_quote_title')).toMatch(/Ctrl\+Shift\+Q/)
    }
  })

  test('typing "``` " inside a blockquote is left as literal text', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<blockquote>``` </blockquote>'
    const bq = editorEl.querySelector('blockquote')!
    caretIn(bq.firstChild as Text, (bq.firstChild as Text).textContent!.length)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editorEl.querySelector('pre')).toBeNull()
    expect(editorEl.querySelector('blockquote')!.textContent).toBe('``` ')
    editor.destroy()
  })

  test.each([
    ['# ', 'h1'],
    ['- ', 'ul'],
    ['--- ', 'hr'],
    ['> ', 'blockquote'],
  ])('typing %o inside a <pre> is a no-op (a code block is literal text)', (prefix, tag) => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = `<pre>${prefix}</pre>`
    const pre = editorEl.querySelector('pre')!
    caretIn(pre.firstChild as Text, (pre.firstChild as Text).textContent!.length)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editorEl.querySelector(tag)).toBeNull()
    expect(editorEl.querySelector('pre')!.textContent).toBe(prefix)
    editor.destroy()
  })

  test('typed `x` inside a <pre> stays literal — no <code> wrap', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<pre>run `x`</pre>'
    const textNode = editorEl.querySelector('pre')!.firstChild as Text
    caretIn(textNode, textNode.textContent!.length)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editorEl.querySelector('code')).toBeNull()
    editor.destroy()
  })

  test('plain Enter inside a <pre> inserts a line break, not a paragraph split', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<pre>alpha</pre>'
    const textNode = editorEl.querySelector('pre')!.firstChild as Text
    caretIn(textNode, textNode.textContent!.length)

    const e = dispatchKey(editorEl, { key: 'Enter' })

    expect(e.defaultPrevented).toBe(true)
    expect(execSpy).toHaveBeenCalledWith('insertLineBreak', false, undefined)
    expect(execSpy).not.toHaveBeenCalledWith('insertParagraph', expect.anything(), expect.anything())
    expect(editorEl.querySelectorAll('pre')).toHaveLength(1)
    editor.destroy()
  })

  test('Enter on an empty final line leaves the <pre> for a fresh paragraph', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<pre>code<br><br></pre>'
    const pre = editorEl.querySelector('pre')!
    caretIn(pre, 2) // after "code" and the first <br>, on the empty last line

    const e = dispatchKey(editorEl, { key: 'Enter' })

    expect(e.defaultPrevented).toBe(true)
    const block = editorEl.querySelector('pre')!
    expect(block.textContent).toBe('code')
    expect((block.nextElementSibling as HTMLElement).tagName).toBe('DIV')
    expect(editor.getMd()).toBe('```\ncode\n```\n')
    editor.destroy()
  })

  test('Enter on an otherwise-empty <pre> replaces it with a paragraph', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<pre><br></pre>'
    caretIn(editorEl.querySelector('pre')!, 0)

    dispatchKey(editorEl, { key: 'Enter' })

    expect(editorEl.querySelector('pre')).toBeNull()
    expect(editorEl.firstElementChild!.tagName).toBe('DIV')
    editor.destroy()
  })

  test('Ctrl+Shift+E with the caret already in a <pre> unwraps it', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<pre>quoted</pre>'
    const range = document.createRange()
    range.selectNodeContents(editorEl.querySelector('pre')!)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    const e = dispatchKey(editorEl, { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true })

    expect(e.defaultPrevented).toBe(true)
    expect(editorEl.querySelector('pre')).toBeNull()
    expect(editor.getMd()).toBe('quoted')
    editor.destroy()
  })

  test('Ctrl+Shift+E on an empty line creates a <pre>', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<div><br></div>'
    caretIn(editorEl.querySelector('div')!, 0)

    dispatchKey(editorEl, { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true })

    expect(editorEl.querySelector('pre')).not.toBeNull()
    editor.destroy()
  })

  test('Ctrl+Shift+E on a non-empty line runs formatBlock <pre>', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('a line')

    const e = dispatchKey(editorEl, { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true })

    expect(e.defaultPrevented).toBe(true)
    expect(execSpy).toHaveBeenCalledWith('formatBlock', false, '<pre>')
    editor.destroy()
  })

  test('Ctrl+Shift+6 is the digit-row backup for the code-block chord', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('a line')

    const e = dispatchKey(editorEl, { key: '6', code: 'Digit6', ctrlKey: true, shiftKey: true })

    expect(e.defaultPrevented).toBe(true)
    expect(execSpy).toHaveBeenCalledWith('formatBlock', false, '<pre>')
    editor.destroy()
  })

  test('Ctrl+Shift+6 with the caret already in a <pre> unwraps it', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<pre>quoted</pre>'
    const range = document.createRange()
    range.selectNodeContents(editorEl.querySelector('pre')!)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    const e = dispatchKey(editorEl, { key: '6', code: 'Digit6', ctrlKey: true, shiftKey: true })

    expect(e.defaultPrevented).toBe(true)
    expect(editorEl.querySelector('pre')).toBeNull()
    editor.destroy()
  })

  test('Ctrl+Shift+E with the caret in a blockquote makes no code block', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<blockquote>quoted line</blockquote>'
    const textNode = editorEl.querySelector('blockquote')!.firstChild as Text
    caretIn(textNode, 3)

    const e = dispatchKey(editorEl, { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true })

    expect(e.defaultPrevented).toBe(true) // chord still swallowed, like the other blocked block chords
    expect(execSpy).not.toHaveBeenCalledWith('formatBlock', false, '<pre>')
    expect(editorEl.querySelector('pre')).toBeNull()
    expect(editorEl.querySelector('blockquote')!.textContent).toBe('quoted line')
    editor.destroy()
  })

  test('the { } toolbar button with the caret in a blockquote makes no code block', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<blockquote>quoted line</blockquote>'
    const textNode = editorEl.querySelector('blockquote')!.firstChild as Text
    caretIn(textNode, 3)

    const btn = Array.from(editor.root.querySelectorAll('.tt-editor-toolbar button')).find(
      (b) => b.getAttribute('title') === t('en-US', 'editor_codeblock_title')
    ) as HTMLButtonElement
    btn.click()

    expect(execSpy).not.toHaveBeenCalledWith('formatBlock', false, '<pre>')
    expect(editorEl.querySelector('pre')).toBeNull()
    expect(editorEl.querySelector('blockquote')!.textContent).toBe('quoted line')
    editor.destroy()
  })

  test('Ctrl+Shift+E with the caret in a <pre> nested in a blockquote still unwraps it (old-bug cleanup)', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<blockquote><pre>trapped</pre></blockquote>'
    const range = document.createRange()
    range.selectNodeContents(editorEl.querySelector('pre')!)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    const e = dispatchKey(editorEl, { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true })

    expect(e.defaultPrevented).toBe(true)
    expect(editorEl.querySelector('pre')).toBeNull()
    editor.destroy()
  })

  test('Ctrl+B with the caret in a <pre> applies no bold', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<pre>plain</pre>'
    const textNode = editorEl.querySelector('pre')!.firstChild as Text
    caretIn(textNode, 3)

    const e = dispatchKey(editorEl, { key: 'b', code: 'KeyB', ctrlKey: true })

    expect(e.defaultPrevented).toBe(true)
    expect(execSpy).not.toHaveBeenCalledWith('bold', false, undefined)
    editor.destroy()
  })

  test('Ctrl+1 with the caret in a <pre> applies no heading', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<pre>plain</pre>'
    const textNode = editorEl.querySelector('pre')!.firstChild as Text
    caretIn(textNode, 3)

    dispatchKey(editorEl, { key: '1', code: 'Digit1', ctrlKey: true })

    expect(execSpy).not.toHaveBeenCalledWith('formatBlock', false, '<h1>')
    editor.destroy()
  })

  test('the { } toolbar button runs formatBlock <pre> on a plain line', () => {
    const { editor } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editor.setMd('a line')

    const btn = Array.from(editor.root.querySelectorAll('.tt-editor-toolbar button')).find(
      (b) => b.getAttribute('title') === t('en-US', 'editor_codeblock_title')
    ) as HTMLButtonElement
    btn.click()

    expect(execSpy).toHaveBeenCalledWith('formatBlock', false, '<pre>')
    editor.destroy()
  })

  test('the { } button normalizes a <div>-built multi-line <pre> to <br>-separated literal lines', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<pre><div>l1</div><div>l2</div></pre>'
    const btn = Array.from(editor.root.querySelectorAll('.tt-editor-toolbar button')).find(
      (b) => b.getAttribute('title') === t('en-US', 'editor_codeblock_title')
    ) as HTMLButtonElement
    btn.click()
    expect(editorEl.querySelector('pre')!.innerHTML).toBe('l1<br>l2')
    expect(editor.getMd()).toBe('```\nl1\nl2\n```')
    editor.destroy()
  })

  test('paste inside a <pre> inserts plain text only, never markdown/HTML', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<pre>x</pre>'
    caretIn(editorEl.querySelector('pre')!.firstChild as Text, 1)

    const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(e, 'clipboardData', {
      value: {
        getData: (type: string) =>
          type === 'text/html' ? '<strong>**bold**</strong>' : '**bold**',
      },
    })
    editorEl.dispatchEvent(e)

    expect(execSpy).toHaveBeenCalledWith('insertText', false, '**bold**')
    expect(execSpy).not.toHaveBeenCalledWith('insertHTML', expect.anything(), expect.anything())
    editor.destroy()
  })

  test('paste over a selection that spans from a normal line into a <pre> is plain text too', () => {
    const { editor, editorEl } = mount()
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<div>intro</div><pre>code</pre>'
    const range = document.createRange()
    range.setStart(editorEl.querySelector('div')!.firstChild as Text, 2)
    range.setEnd(editorEl.querySelector('pre')!.firstChild as Text, 2)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(e, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/html' ? '<b>x</b>' : 'x') },
    })
    editorEl.dispatchEvent(e)

    expect(execSpy).toHaveBeenCalledWith('insertText', false, 'x')
    expect(execSpy).not.toHaveBeenCalledWith('insertHTML', expect.anything(), expect.anything())
    editor.destroy()
  })

  test('typing `x` on a normal line does NOT auto-format — no inline code syntax', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<div>run `x`</div>'
    const textNode = editorEl.firstChild!.firstChild as Text
    caretIn(textNode, textNode.textContent!.length)

    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editorEl.querySelector('code')).toBeNull()
    expect(editorEl.textContent).toBe('run `x`')
    editor.destroy()
  })
})

describe('code block syntax highlighting', () => {
  function mount(): { editor: Editor; editorEl: HTMLElement } {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    return { editor, editorEl }
  }
  function caretIn(node: Node, offset: number): void {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }
  function caretCharOffset(pre: HTMLElement): number {
    const r = window.getSelection()!.getRangeAt(0)
    const probe = document.createRange()
    probe.selectNodeContents(pre)
    probe.setEnd(r.startContainer, r.startOffset)
    return probe.toString().length
  }

  test('setMd colours a loaded code block with token spans', () => {
    const { editor, editorEl } = mount()
    editor.setMd('```\nconst x = 10\n```')
    const pre = editorEl.querySelector('pre')!
    expect(pre.querySelector('.hl-kw')!.textContent).toBe('const')
    expect(pre.querySelector('.hl-num')!.textContent).toBe('10')
    editor.destroy()
  })

  test('placing the caret in the block strips the spans and preserves the caret offset', () => {
    const { editor, editorEl } = mount()
    editor.setMd('```\nconst x = 10\n```')
    const pre = editorEl.querySelector('pre')!
    caretIn(pre.querySelector('.hl-kw')!.firstChild!, 5) // just after "const"

    expect(pre.querySelector('.hl-kw')).toBeNull()
    expect(pre.textContent).toBe('const x = 10')
    expect(caretCharOffset(pre)).toBe(5)
    editor.destroy()
  })

  test('moving the caret out of the block re-applies highlighting', () => {
    const { editor, editorEl } = mount()
    editor.setMd('```\nreturn 1\n```\nprose')
    const pre = editorEl.querySelector('pre')!
    caretIn(pre.querySelector('.hl-kw')!.firstChild!, 0)
    expect(pre.querySelector('.hl-kw')).toBeNull()

    const prose = editorEl.querySelector('div')!
    caretIn(prose.firstChild ?? prose, 0)
    expect(pre.querySelector('.hl-kw')!.textContent).toBe('return')
    editor.destroy()
  })

  test('a loaded code block has browser spellcheck / autocorrect turned off', () => {
    const { editor, editorEl } = mount()
    editor.setMd('```\nteh recieve\n```')
    const pre = editorEl.querySelector('pre')!
    expect(pre.getAttribute('spellcheck')).toBe('false')
    expect(pre.getAttribute('autocorrect')).toBe('off')
    expect(pre.getAttribute('autocapitalize')).toBe('off')
    editor.destroy()
  })

  test('a code block created by the ``` autoformat also gets spellcheck off', () => {
    const { editor, editorEl } = mount()
    vi.spyOn(document, 'execCommand').mockReturnValue(true)
    editorEl.innerHTML = '<div>``` </div>'
    const textNode = editorEl.firstChild!.firstChild as Text
    caretIn(textNode, textNode.textContent!.length)
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editorEl.querySelector('pre')!.getAttribute('spellcheck')).toBe('false')
    editor.destroy()
  })

  test('blurring the editor re-highlights a block that had the caret (selectionchange may not fire on blur)', () => {
    const { editor, editorEl } = mount()
    editor.setMd('```\nreturn 1\n```')
    const pre = editorEl.querySelector('pre')!
    caretIn(pre.querySelector('.hl-kw')!.firstChild!, 0)
    expect(pre.querySelector('.hl-kw')).toBeNull()

    editorEl.dispatchEvent(new Event('blur'))
    expect(pre.querySelector('.hl-kw')!.textContent).toBe('return')
    editor.destroy()
  })

  test('an edit made while the caret is in the block still round-trips through getMd', () => {
    const { editor, editorEl } = mount()
    editor.setMd('```\nconst x = 1\n```')
    const pre = editorEl.querySelector('pre')!
    caretIn(pre.querySelector('.hl-kw')!.firstChild!, 5)

    pre.firstChild!.textContent = 'const x = 1 + 2' // simulate typing into the now-plain text node
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    expect(editor.getMd()).toBe('```\nconst x = 1 + 2\n```')
    editor.destroy()
  })
})

describe('code block collapse + copy', () => {
  function mount(): { editor: Editor; editorEl: HTMLElement } {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    return { editor, editorEl: editor.root.querySelector('.editor') as HTMLElement }
  }
  const longFence = '```\n' + Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n```'
  const shortFence = '```\na\nb\nc\n```'

  test('setMd auto-collapses a code block over 8 lines and tags it', () => {
    const { editor, editorEl } = mount()
    editor.setMd(longFence)
    const pre = editorEl.querySelector('pre')!
    expect(pre.hasAttribute('data-collapsed')).toBe(true)
    expect(pre.dataset.lines).toBe('12')
    expect(pre.dataset.moreLabel).toBe('+9 more lines')
    editor.destroy()
  })

  test('setMd leaves a short code block expanded', () => {
    const { editor, editorEl } = mount()
    editor.setMd(shortFence)
    const pre = editorEl.querySelector('pre')!
    expect(pre.hasAttribute('data-collapsed')).toBe(false)
    expect(pre.dataset.lines).toBe('3')
    editor.destroy()
  })

  test('collapse is view-only — getMd is byte-identical', () => {
    const { editor } = mount()
    editor.setMd(longFence)
    expect(editor.getMd()).toBe(longFence)
    editor.destroy()
  })

  test('clicking a collapsed block expands it', () => {
    const { editor, editorEl } = mount()
    editor.setMd(longFence)
    const pre = editorEl.querySelector('pre')!
    pre.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pre.hasAttribute('data-collapsed')).toBe(false)
    editor.destroy()
  })

  test('the hover copy button writes the raw block text to the clipboard', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const orig = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      const { editor, editorEl } = mount()
      editor.setMd(shortFence)
      const pre = editorEl.querySelector('pre')!
      pre.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      const controls = editor.root.querySelector('.tt-cb-controls') as HTMLElement
      expect(controls.hidden).toBe(false)
      const copyBtn = controls.querySelectorAll('button')[0] as HTMLButtonElement
      copyBtn.click()
      expect(writeText).toHaveBeenCalledWith('a\nb\nc')
      editor.destroy()
    } finally {
      if (orig) Object.defineProperty(navigator, 'clipboard', orig)
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard
    }
  })

  test('the copy button and line count read a <br>-edited block the same way htmlToMd serialises it', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const orig = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      const { editor, editorEl } = mount()
      // the shape Enter-inside-a-block produces: <br> line breaks, not \n
      editorEl.innerHTML = '<pre>one<br>two<br>three</pre>'
      const pre = editorEl.querySelector('pre')!
      pre.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      ;(editor.root.querySelector('.tt-cb-controls button') as HTMLButtonElement).click()
      expect(writeText).toHaveBeenCalledWith('one\ntwo\nthree')
      expect(editor.getMd()).toBe('```\none\ntwo\nthree\n```')
      editor.destroy()
    } finally {
      if (orig) Object.defineProperty(navigator, 'clipboard', orig)
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard
    }
  })

  test('the collapse threshold counts a transient <div>-wrapped block by real lines (not folded to one)', () => {
    const { editor, editorEl } = mount()
    // Chromium formatBlock on a multi-line selection can leave this shape
    // briefly; the count must still see 10 lines, not 1.
    editorEl.innerHTML = '<pre>' + Array.from({ length: 10 }, (_, i) => `<div>l${i}</div>`).join('') + '</pre>'
    editor.setMd(editor.getMd()) // re-render through the normal path
    const pre = editorEl.querySelector('pre')!
    expect(pre.dataset.lines).toBe('10')
    editor.destroy()
  })

  test('the hover toggle button collapses and re-expands the block', () => {
    const { editor, editorEl } = mount()
    editor.setMd(shortFence)
    const pre = editorEl.querySelector('pre')!
    pre.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    const toggleBtn = (editor.root.querySelector('.tt-cb-controls') as HTMLElement)
      .querySelectorAll('button')[1] as HTMLButtonElement

    toggleBtn.click()
    expect(pre.hasAttribute('data-collapsed')).toBe(true)
    toggleBtn.click()
    expect(pre.hasAttribute('data-collapsed')).toBe(false)
    editor.destroy()
  })

  test('a mid-session paste decorates only the new block, not one the user expanded', () => {
    vi.spyOn(document, 'execCommand').mockImplementation((cmd, _s, val) => {
      if (cmd === 'insertHTML' && typeof val === 'string') {
        const editorEl = document.querySelector('.editor') as HTMLElement
        editorEl.insertAdjacentHTML('beforeend', val)
      }
      return true
    })
    const { editor, editorEl } = mount()
    editor.setMd(longFence)
    const first = editorEl.querySelector('pre')!
    first.removeAttribute('data-collapsed') // user expanded it

    const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(e, 'clipboardData', {
      value: { getData: (tp: string) => (tp === 'text/html' ? `<pre>${Array.from({ length: 10 }, (_, i) => `x${i}`).join('\n')}</pre>` : '') },
    })
    editorEl.dispatchEvent(e)

    const pres = editorEl.querySelectorAll('pre')
    expect(first.hasAttribute('data-collapsed')).toBe(false) // untouched
    expect(pres[pres.length - 1]!.hasAttribute('data-collapsed')).toBe(true) // new one collapsed
    editor.destroy()
  })
})

describe('inline auto-format caret exit', () => {
  function mountAt(hooksLoc: 'en-US' | 'pt-BR', html: string, caretOffsetFromEnd = 0): { editor: Editor; editorEl: HTMLElement } {
    const editor = createEditor(makeHooks(), hooksLoc)
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editorEl.innerHTML = html
    const tn = editorEl.firstChild!.firstChild as Text
    const at = tn.textContent!.length - caretOffsetFromEnd
    const r = document.createRange(); r.setStart(tn, at); r.collapse(true)
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r)
    return { editor, editorEl }
  }

  test.each([
    ['**x**', 'strong'],
    ['*x*', 'em'],
    ['~~x~~', 's'],
  ])('typing %s at end of line parks the caret OUTSIDE the new <%s>, in a trailing gap', (typed, tag) => {
    const { editor, editorEl } = mountAt('en-US', `<div>a ${typed}</div>`)
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    const mark = editorEl.querySelector(tag)!
    expect(mark).not.toBeNull()
    // a trailing text node (the caret's home) now follows the mark
    expect(mark.nextSibling?.nodeType).toBe(Node.TEXT_NODE)
    const sel = window.getSelection()!
    expect(sel.anchorNode).toBe(mark.nextSibling)
    // and it round-trips: the gap is a plain trailing space, nothing more
    expect(editor.getMd()).toBe(`a ${typed} `)
    editor.destroy()
  })

  test('typing **b** with text still after the caret adds no gap (would be a spurious space)', () => {
    const { editor, editorEl } = mountAt('en-US', '<div>a **b** tail</div>', 5) // caret right after the closing **
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))

    const strong = editorEl.querySelector('strong')!
    expect(strong.textContent).toBe('b')
    expect(editor.getMd()).toBe('a **b** tail')
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

  test('a scheme-less destination gets https:// prepended, same as the link dialog', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editor.setMd('')
    typeInto(editorEl, 'see [docs](example.com)')
    const a = editorEl.querySelector('a[href]') as HTMLAnchorElement
    expect(a).not.toBeNull()
    expect(a.getAttribute('href')).toBe('https://example.com')
    expect(a.textContent).toBe('docs')
    expect(editor.getMd()).toBe('see [docs](https://example.com)')
    editor.destroy()
  })

  test('a www. destination converts too', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    editor.setMd('')
    typeInto(editorEl, '[home](www.example.com)')
    expect((editorEl.querySelector('a[href]') as HTMLAnchorElement).getAttribute('href')).toBe('https://www.example.com')
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
  test('detects a "> " blockquote prefix, plain and NBSP variant', () => {
    const nbsp = String.fromCharCode(0xa0)
    expect(detectBlockPrefix('> ')).toEqual({ type: 'blockquote', prefixLen: 2 })
    expect(detectBlockPrefix('>' + nbsp)).toEqual({ type: 'blockquote', prefixLen: 2 })
    expect(detectBlockPrefix('> quoted')).toBeNull()
  })
  test('detects a "``` " code-block prefix, plain and NBSP variant', () => {
    const nbsp = String.fromCharCode(0xa0)
    expect(detectBlockPrefix('``` ')).toEqual({ type: 'codeblock', prefixLen: 4 })
    expect(detectBlockPrefix('```' + nbsp)).toEqual({ type: 'codeblock', prefixLen: 4 })
    expect(detectBlockPrefix('```js')).toBeNull()
    expect(detectBlockPrefix('``')).toBeNull()
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
