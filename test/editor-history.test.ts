import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createEditHistory, structureKey, registerEditHistory, unregisterEditHistory, recordEdit } from '../src/ui/editor-history'

let root: HTMLElement
let applied = 0

beforeEach(() => {
  root = document.createElement('div')
  root.contentEditable = 'true'
  document.body.appendChild(root)
  applied = 0
})
afterEach(() => root.remove())

const html = (s: string): void => { root.innerHTML = s }
const make = () => createEditHistory(root, () => { applied++ })

describe('structureKey', () => {
  test('ignores attributes, pictures and highlight spans inside a code block', () => {
    html('<div class="a">x</div><pre><span class="hl">const</span> a</pre><div><img src="p"></div>')
    const k = structureKey(root)
    html('<div>x</div><pre>const a</pre><div></div>')
    expect(structureKey(root)).toBe(k)
  })

  test('tells apart a different element or different text', () => {
    html('<div>x</div>')
    const k = structureKey(root)
    html('<h1>x</h1>')
    expect(structureKey(root)).not.toBe(k)
    html('<div>y</div>')
    expect(structureKey(root)).not.toBe(k)
  })
})

describe('edit history', () => {
  test('undo puts the very same nodes back, redo replays the edit', () => {
    html('<div>- </div>')
    const div = root.firstElementChild!
    const h = make()
    h.record(() => {
      const ul = document.createElement('ul')
      ul.innerHTML = '<li><br></li>'
      div.replaceWith(ul)
    })
    expect(root.innerHTML).toBe('<ul><li><br></li></ul>')

    expect(h.undo()).toBe(true)
    expect(root.innerHTML).toBe('<div>- </div>')
    expect(root.firstElementChild).toBe(div) // identity, so the browser's own stack stays valid

    expect(h.redo()).toBe(true)
    expect(root.innerHTML).toBe('<ul><li><br></li></ul>')
    expect(applied).toBe(2)
  })

  test('reverses text and attribute changes, and a split text node', () => {
    html('<div id="a">hello **bold**</div>')
    const div = root.firstElementChild as HTMLElement
    const h = make()
    h.record(() => {
      const text = div.firstChild as Text
      const tail = text.splitText(6)
      tail.nodeValue = ''
      const strong = document.createElement('strong')
      strong.textContent = 'bold'
      div.append(strong)
      div.setAttribute('id', 'b')
    })
    expect(root.innerHTML).toBe('<div id="b">hello <strong>bold</strong></div>')

    h.undo()
    expect(root.innerHTML).toBe('<div id="a">hello **bold**</div>')
    h.redo()
    expect(root.innerHTML).toBe('<div id="b">hello <strong>bold</strong></div>')
  })

  test('undo and redo each take the edits one at a time, newest first', () => {
    html('<div>a</div>')
    const h = make()
    h.record(() => { root.firstElementChild!.after(document.createElement('hr')) })
    h.record(() => { root.append(document.createElement('ul')) })
    expect(root.innerHTML).toBe('<div>a</div><hr><ul></ul>')
    h.undo()
    expect(root.innerHTML).toBe('<div>a</div><hr>')
    h.undo()
    expect(root.innerHTML).toBe('<div>a</div>')
    expect(h.undo()).toBe(false)
    h.redo()
    h.redo()
    expect(root.innerHTML).toBe('<div>a</div><hr><ul></ul>')
    expect(h.redo()).toBe(false)
  })

  test('leaves the undo to the browser once the document moved on since the edit', () => {
    html('<div>a</div>')
    const h = make()
    h.record(() => { root.append(document.createElement('hr')) })
    root.firstElementChild!.textContent = 'a typed after' // a browser-made edit
    expect(h.undo()).toBe(false)
    expect(root.innerHTML).toBe('<div>a typed after</div><hr>')
    // ...and takes over again when the browser's undo brought the document back to where the edit left it.
    root.firstElementChild!.textContent = 'a'
    expect(h.undo()).toBe(true)
    expect(root.innerHTML).toBe('<div>a</div>')
  })

  test('a redo is refused when the document is not in the state the edit started from', () => {
    html('<div>a</div>')
    const h = make()
    h.record(() => { root.append(document.createElement('hr')) })
    h.undo()
    root.firstElementChild!.textContent = 'changed'
    expect(h.redo()).toBe(false)
  })

  test('a new edit, a browser edit (dropRedo) or clear() forgets what could be redone', () => {
    html('<div>a</div>')
    const h = make()
    h.record(() => { root.append(document.createElement('hr')) })
    h.undo()
    h.record(() => { root.append(document.createElement('ul')) })
    expect(h.redo()).toBe(false)

    h.undo()
    h.dropRedo()
    expect(h.redo()).toBe(false)

    h.record(() => { root.append(document.createElement('ol')) })
    h.clear()
    expect(h.undo()).toBe(false)
  })

  test('an edit that changed nothing is not remembered', () => {
    html('<div>a</div>')
    const h = make()
    h.record(() => { /* nothing */ })
    h.record(() => { root.firstElementChild!.setAttribute('class', 'x') })
    expect(h.undo()).toBe(false)
  })

  test('record returns the callback result and nests as one edit', () => {
    html('<div>a</div>')
    const h = make()
    const out = h.record(() => {
      h.record(() => { root.append(document.createElement('hr')) })
      root.append(document.createElement('ul'))
      return 7
    })
    expect(out).toBe(7)
    h.undo()
    expect(root.innerHTML).toBe('<div>a</div>')
  })

  test('keeps an edit that threw halfway so it can still be reversed', () => {
    html('<div>a</div>')
    const h = make()
    expect(() => h.record(() => { root.append(document.createElement('hr')); throw new Error('boom') })).toThrow('boom')
    expect(h.undo()).toBe(true)
    expect(root.innerHTML).toBe('<div>a</div>')
  })

  test('puts the caret back where it was before / after the edit', () => {
    html('<div>hello</div>')
    const text = root.firstElementChild!.firstChild!
    const place = (offset: number): void => {
      const r = document.createRange()
      r.setStart(text, offset)
      r.collapse(true)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(r)
    }
    place(5)
    const h = make()
    h.record(() => { (text as Text).nodeValue = 'hi'; place(2) })
    place(0)
    h.undo()
    expect(window.getSelection()!.getRangeAt(0).startOffset).toBe(5)
    h.redo()
    expect(window.getSelection()!.getRangeAt(0).startOffset).toBe(2)
  })
})

describe('recordEdit registry', () => {
  test('runs the callback plainly for an element no editor registered', () => {
    expect(recordEdit(root, () => 3)).toBe(3)
  })

  test('records on the registered history and stops after unregistering', () => {
    html('<div>a</div>')
    const h = make()
    registerEditHistory(root, h)
    recordEdit(root, () => { root.append(document.createElement('hr')) })
    expect(h.undo()).toBe(true)
    unregisterEditHistory(root)
    recordEdit(root, () => { root.append(document.createElement('hr')) })
    expect(h.undo()).toBe(false)
  })
})
