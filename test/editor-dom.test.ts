import { blockAndCaret, caretAfterInline, rangeForTextOffsets } from '../src/ui/editor-dom'

function mount(html: string): HTMLElement {
  const ed = document.createElement('div')
  ed.className = 'editor'
  ed.setAttribute('contenteditable', 'true')
  ed.innerHTML = html
  document.body.appendChild(ed)
  return ed
}

function caret(node: Node, offset: number): void {
  const r = document.createRange()
  r.setStart(node, offset)
  r.collapse(true)
  const s = window.getSelection()!
  s.removeAllRanges()
  s.addRange(r)
}

afterEach(() => {
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

describe('blockAndCaret', () => {
  test('resolves the top-level <div> block, its text, and the caret offset', () => {
    const ed = mount('<div>hello world</div>')
    const tn = ed.querySelector('div')!.firstChild as Text
    caret(tn, 5)
    const ctx = blockAndCaret(ed)!
    expect(ctx.block.tagName).toBe('DIV')
    expect(ctx.text).toBe('hello world')
    expect(ctx.caretOffset).toBe(5)
  })

  test('resolves the enclosing <li> (not the <ul>) as the block', () => {
    const ed = mount('<ul><li>first</li><li>second item</li></ul>')
    const li = ed.querySelectorAll('li')[1]!
    caret(li.firstChild as Text, 6)
    const ctx = blockAndCaret(ed)!
    expect(ctx.block.tagName).toBe('LI')
    expect(ctx.text).toBe('second item')
    expect(ctx.caretOffset).toBe(6)
  })

  test('counts caret offset across multiple text/inline nodes', () => {
    const ed = mount('<div>ab<strong>cd</strong>ef</div>')
    const last = ed.querySelector('div')!.lastChild as Text // "ef"
    caret(last, 1)
    const ctx = blockAndCaret(ed)!
    expect(ctx.text).toBe('abcdef')
    expect(ctx.caretOffset).toBe(5) // "ab" + "cd" + "e"
  })

  test('null when the selection is not collapsed', () => {
    const ed = mount('<div>hello</div>')
    const tn = ed.querySelector('div')!.firstChild as Text
    const r = document.createRange()
    r.setStart(tn, 1)
    r.setEnd(tn, 4)
    const s = window.getSelection()!
    s.removeAllRanges()
    s.addRange(r)
    expect(blockAndCaret(ed)).toBeNull()
  })

  test('null when the caret is outside the editor root', () => {
    const ed = mount('<div>hello</div>')
    const outside = document.createElement('p')
    outside.textContent = 'elsewhere'
    document.body.appendChild(outside)
    caret(outside.firstChild as Text, 2)
    expect(blockAndCaret(ed)).toBeNull()
  })

  test('null when there is no selection at all', () => {
    const ed = mount('<div>hello</div>')
    window.getSelection()!.removeAllRanges()
    expect(blockAndCaret(ed)).toBeNull()
  })
})

describe('caretAfterInline', () => {
  const NBSP = '\u00a0'

  test("gap 'none' just parks the caret after the node — no filler", () => {
    const ed = mount('<div>see <a>link</a></div>')
    const a = ed.querySelector('a')!
    caretAfterInline(a, 'none')
    expect(ed.querySelector('div')!.childNodes.length).toBe(2) // "see " + <a>
    const s = window.getSelection()!
    expect(s.isCollapsed).toBe(true)
    expect(s.getRangeAt(0).startContainer).toBe(ed.querySelector('div'))
  })

  test("gap 'always' inserts an NBSP slot and lands the caret in it", () => {
    const ed = mount('<div><a>chip</a></div>')
    const a = ed.querySelector('a')!
    caretAfterInline(a, 'always')
    const div = ed.querySelector('div')!
    expect(div.childNodes.length).toBe(2)
    expect(div.lastChild!.textContent).toBe(NBSP)
    const s = window.getSelection()!
    expect(s.getRangeAt(0).startContainer).toBe(div.lastChild)
    expect(s.getRangeAt(0).startOffset).toBe(1)
  })

  test("gap 'auto' adds the NBSP only when nothing already follows the node", () => {
    const ed = mount('<div><strong>bold</strong></div>')
    caretAfterInline(ed.querySelector('strong')!, 'auto')
    expect(ed.querySelector('div')!.lastChild!.textContent).toBe(NBSP)
  })

  test("gap 'auto' skips the NBSP when real text already follows the node", () => {
    const ed = mount('<div><strong>bold</strong> and more</div>')
    caretAfterInline(ed.querySelector('strong')!, 'auto')
    // no extra node added — still <strong> + the original " and more" text
    expect(ed.querySelector('div')!.childNodes.length).toBe(2)
    expect(ed.querySelector('div')!.textContent).toBe('bold and more')
  })

  test("'auto' is the default", () => {
    const ed = mount('<div><em>x</em></div>')
    caretAfterInline(ed.querySelector('em')!)
    expect(ed.querySelector('div')!.lastChild!.textContent).toBe(NBSP)
  })
})

describe('rangeForTextOffsets', () => {
  test('spans a substring within a single text node', () => {
    const ed = mount('<div>hello world</div>')
    const block = ed.querySelector('div')!
    const r = rangeForTextOffsets(block, 6, 11)
    expect(r.toString()).toBe('world')
  })

  test('spans across inline element boundaries', () => {
    const ed = mount('<div>ab<strong>cd</strong>ef</div>')
    const block = ed.querySelector('div')!
    const r = rangeForTextOffsets(block, 1, 5)
    expect(r.toString()).toBe('bcde')
  })

  test('a collapsed [n, n] range is an insertion point at that offset', () => {
    const ed = mount('<div>hello</div>')
    const block = ed.querySelector('div')!
    const r = rangeForTextOffsets(block, 2, 2)
    expect(r.collapsed).toBe(true)
    r.insertNode(document.createTextNode('X'))
    expect(block.textContent).toBe('heXllo')
  })

  test('offsets past the end clamp to the block edge', () => {
    const ed = mount('<div>hi</div>')
    const block = ed.querySelector('div')!
    const r = rangeForTextOffsets(block, 99, 99)
    expect(r.collapsed).toBe(true)
    expect(r.toString()).toBe('')
  })
})
