import { takeSnapshot, sameBlocks, restoreSnapshot, type Snapshot } from '../src/ui/editor-snapshot'

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'editor'
  root.setAttribute('contenteditable', 'true')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

function setRange(sc: Node, so: number, ec: Node = sc, eo: number = so): void {
  const r = document.createRange()
  r.setStart(sc, so)
  r.setEnd(ec, eo)
  const s = window.getSelection()!
  s.removeAllRanges()
  s.addRange(r)
}

/** Pins a settable scrollTop on the element (jsdom has no layout). */
function stubScroll(el: HTMLElement): void {
  let v = 0
  Object.defineProperty(el, 'scrollTop', { get: () => v, set: (n: number) => { v = n }, configurable: true })
}

function snap(blocks: string[], selection: Snapshot['selection'] = null, scrollTop = 0): Snapshot {
  return { blocks, selection, scrollTop }
}

afterEach(() => {
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
  delete (window as unknown as Record<string, unknown>).__x
})

describe('takeSnapshot blocks', () => {
  test('one string per element child, in order', () => {
    const root = mount('<div>a</div><p>b</p><ul><li>c</li></ul>')
    expect(takeSnapshot(root).blocks).toEqual(['<div>a</div>', '<p>b</p>', '<ul><li>c</li></ul>'])
  })

  test('picture block is stored without children and without data-img-loading', () => {
    const root = mount('<div class="tt-img" data-img-loading="1" contenteditable="false"><img src="data:image/png;base64,AAAA"></div>')
    const [b] = takeSnapshot(root).blocks
    expect(b).not.toContain('<img')
    expect(b).not.toContain('data:')
    expect(b).not.toContain('data-img-loading')
    expect(b).toContain('class="tt-img"')
    // the live node is untouched
    expect(root.querySelector('img')).not.toBeNull()
  })

  test('a picture\'s view classes (selected, missing marker) are not stored', () => {
    const root = mount(
      '<div class="tt-img is-selected" data-img-id="a" contenteditable="false"><img src="data:x"></div>'
      + '<div class="tt-img tt-img-missing" data-img-id="b" contenteditable="false">Picture unavailable</div>',
    )
    const blocks = takeSnapshot(root).blocks
    expect(blocks[0]).not.toContain('is-selected')
    expect(blocks[1]).not.toContain('tt-img-missing')
    expect(blocks[1]).not.toContain('unavailable')
    expect(blocks.every((b) => b.includes('class="tt-img"'))).toBe(true)
    // the live nodes keep their classes
    expect(root.children[0]!.classList.contains('is-selected')).toBe(true)
    expect(root.children[1]!.classList.contains('tt-img-missing')).toBe(true)
  })

  test('selecting a picture does not change the stored blocks (sameBlocks ignores it)', () => {
    const root = mount('<div>a</div><div class="tt-img" data-img-id="a" contenteditable="false"></div>')
    const before = takeSnapshot(root)
    root.children[1]!.classList.add('is-selected')
    expect(sameBlocks(before, takeSnapshot(root))).toBe(true)
  })

  test('a snapshot taken with a selected picture restores it unselected', () => {
    const root = mount('<div>a</div><div class="tt-img is-selected" data-img-id="a" contenteditable="false"><img src="data:x"></div>')
    const target = takeSnapshot(root)
    root.children[1]!.remove()
    restoreSnapshot(root, target)
    const pic = root.querySelector('.tt-img')!
    expect(pic.getAttribute('data-img-id')).toBe('a')
    expect(pic.classList.contains('is-selected')).toBe(false)
  })

  test('highlighted <pre> is stored as one plain text node, transient attributes dropped', () => {
    const root = mount(
      '<pre data-collapsed spellcheck="false" autocorrect="off" autocapitalize="off">'
      + '<span class="hl-kw">const</span> x = 1<br>y</pre>',
    )
    expect(takeSnapshot(root).blocks).toEqual(['<pre>const x = 1\ny</pre>'])
    expect(root.querySelector('.hl-kw')).not.toBeNull()
    expect(root.querySelector('pre')!.hasAttribute('data-collapsed')).toBe(true)
  })

  test('a pre block line count and collapse label are view state: not stored, ignored by sameBlocks', () => {
    const root = mount('<pre data-lines="3" data-more-label="+2 lines" data-collapsed>a<br>b<br>c</pre>')
    const a = takeSnapshot(root)
    expect(a.blocks).toEqual(['<pre>a\nb\nc</pre>'])
    const pre = root.querySelector('pre')!
    pre.dataset.lines = '9'
    pre.removeAttribute('data-more-label')
    pre.removeAttribute('data-collapsed')
    expect(sameBlocks(a, takeSnapshot(root))).toBe(true)
  })

  test('empty <pre> is stored as a <br>', () => {
    const root = mount('<pre><br></pre>')
    expect(takeSnapshot(root).blocks).toEqual(['<pre><br></pre>'])
  })

  test('<pre> whose first line is empty survives a restore round trip', () => {
    const root = mount('<pre><br>abc</pre>')
    const snapA = takeSnapshot(root)
    expect(snapA.blocks[0]).toContain('abc')
    const other = mount('<div>zzz</div>')
    restoreSnapshot(other, snapA)
    expect(takeSnapshot(other).blocks).toEqual(snapA.blocks)
    expect(other.querySelector('pre')!.textContent).toBe('\nabc')
  })

  test('on* attributes are dropped', () => {
    const root = mount('<div onclick="x()" title="t"><b onmouseover="y()">a</b></div>')
    const [b] = takeSnapshot(root).blocks
    expect(b).not.toContain('onclick')
    expect(b).not.toContain('onmouseover')
    expect(b).toContain('title="t"')
  })
})

describe('takeSnapshot selection', () => {
  test('caret in a nested <li> maps to its top-level block and text offset', () => {
    const root = mount('<div>x</div><ul><li>one</li><li>two</li></ul>')
    const two = root.querySelectorAll('li')[1]!.firstChild as Text
    setRange(two, 2)
    expect(takeSnapshot(root).selection).toEqual({
      start: { block: 1, offset: 5, path: [1, 0], domOffset: 2 },
      end: { block: 1, offset: 5, path: [1, 0], domOffset: 2 },
    })
  })

  test('collapsed caret after "word " stores offset 5', () => {
    const root = mount('<div>word </div>')
    setRange(root.firstChild!.firstChild!, 5)
    expect(takeSnapshot(root).selection!.start).toEqual({ block: 0, offset: 5, path: [0], domOffset: 5 })
  })

  test('selection from block 0 to block 2', () => {
    const root = mount('<div>aa</div><div>bb</div><div>cc</div>')
    setRange(root.children[0]!.firstChild!, 1, root.children[2]!.firstChild!, 2)
    expect(takeSnapshot(root).selection).toEqual({
      start: { block: 0, offset: 1, path: [0], domOffset: 1 },
      end: { block: 2, offset: 2, path: [0], domOffset: 2 },
    })
  })

  test('<pre> counts a <br> as one newline, same as plain text', () => {
    const live = mount('<pre>aa<br>bb</pre>')
    const bb = live.querySelector('pre')!.lastChild as Text
    setRange(bb, 0)
    expect(takeSnapshot(live).selection!.start.offset).toBe(3)
    setRange(bb, 1)
    expect(takeSnapshot(live).selection!.start.offset).toBe(4)

    const plain = mount('<pre>aa\nbb</pre>')
    setRange(plain.querySelector('pre')!.firstChild!, 3)
    expect(takeSnapshot(plain).selection!.start.offset).toBe(3)
  })

  test('<br> outside a <pre> counts 0, like textContent', () => {
    const root = mount('<div>aa<br>bb</div>')
    setRange(root.firstChild!.lastChild!, 1)
    expect(takeSnapshot(root).selection!.start.offset).toBe(3)
  })

  test('container === root maps to the start of child `offset`, or the end of the last block past it', () => {
    const root = mount('<div>a</div><div>b</div><div>c</div>')
    setRange(root, 1)
    expect(takeSnapshot(root).selection!.start).toEqual({ block: 1, offset: 0 })
    setRange(root, 3)
    expect(takeSnapshot(root).selection!.start).toEqual({ block: 2, offset: 1 })
  })

  test('selection outside the root is null; no selection is null', () => {
    const root = mount('<div>a</div>')
    const out = document.createElement('div')
    out.textContent = 'out'
    document.body.appendChild(out)
    setRange(out.firstChild!, 1)
    expect(takeSnapshot(root).selection).toBeNull()
    window.getSelection()!.removeAllRanges()
    expect(takeSnapshot(root).selection).toBeNull()
  })
})

describe('selection path (exact DOM point)', () => {
  test('caret at the start of the 2nd <li> restores there, not at the end of the 1st', () => {
    const src = mount('<ul><li>one</li><li>two</li></ul>')
    setRange(src.querySelectorAll('li')[1]!.firstChild!, 0)
    const target = takeSnapshot(src)
    expect(target.selection!.start.path).toEqual([1, 0])
    const root = mount('<div>nothing</div>')
    restoreSnapshot(root, target)
    const sel = window.getSelection()!
    expect(sel.anchorNode!.textContent).toBe('two')
    expect(sel.anchorNode!.parentElement).toBe(root.querySelectorAll('li')[1])
    expect(sel.anchorOffset).toBe(0)
  })

  test('caret inside an empty <li><br></li> restores inside it', () => {
    const src = mount('<ul><li>one</li><li><br></li></ul>')
    setRange(src.querySelectorAll('li')[1]!, 0)
    const target = takeSnapshot(src)
    const root = mount('<div>nothing</div>')
    restoreSnapshot(root, target)
    const sel = window.getSelection()!
    expect(sel.anchorNode).toBe(root.querySelectorAll('li')[1])
    expect(sel.anchorOffset).toBe(0)
  })

  test('caret at the start of the 2nd <p> inside a blockquote', () => {
    const src = mount('<blockquote><p>a</p><p>b</p></blockquote>')
    setRange(src.querySelectorAll('p')[1]!.firstChild!, 0)
    const target = takeSnapshot(src)
    const root = mount('<div>nothing</div>')
    restoreSnapshot(root, target)
    const sel = window.getSelection()!
    expect(sel.anchorNode!.parentElement).toBe(root.querySelectorAll('p')[1])
    expect(sel.anchorOffset).toBe(0)
  })

  test('a path that no longer resolves falls back to the text offset', () => {
    const root = mount('<div>x</div>')
    const pos = (extra: object) => ({ block: 0, offset: 2, ...extra })
    for (const extra of [
      { path: [5, 5], domOffset: 1 },          // no such node
      { path: [0], domOffset: 99 },            // offset out of range
      { path: [0], domOffset: 1 },             // resolves but disagrees with the text offset
    ]) {
      expect(() => restoreSnapshot(root, snap(['<div>ab</div>'], { start: pos(extra), end: pos(extra) }))).not.toThrow()
      const sel = window.getSelection()!
      expect(sel.anchorNode!.textContent).toBe('ab')
      expect(sel.anchorOffset).toBe(2)
    }
  })

  test('<pre> and picture blocks keep text-offset addressing (no path)', () => {
    const live = mount('<pre>aa<br>bb</pre>')
    setRange(live.querySelector('pre')!.lastChild!, 1)
    expect(takeSnapshot(live).selection!.start).toEqual({ block: 0, offset: 4 })
    const pic = mount('<div class="tt-img"><img src="data:x"></div>')
    setRange(pic.firstElementChild!, 0)
    expect(takeSnapshot(pic).selection!.start.path).toBeUndefined()
  })
})

describe('sameBlocks', () => {
  test('compares blocks only', () => {
    const a = snap(['<div>a</div>'], null, 0)
    const b = snap(['<div>a</div>'], { start: { block: 0, offset: 1 }, end: { block: 0, offset: 1 } }, 99)
    expect(sameBlocks(a, b)).toBe(true)
    expect(sameBlocks(a, snap(['<div>b</div>']))).toBe(false)
    expect(sameBlocks(a, snap(['<div>a</div>', '<div>a</div>']))).toBe(false)
  })
})

describe('restoreSnapshot', () => {
  test('prefix and suffix nodes keep identity; middle replace returns only the new element', () => {
    const root = mount('<div>a</div><div>b</div><div>c</div>')
    const [a, b, c] = Array.from(root.children)
    const target = snap(['<div>a</div>', '<div>X</div>', '<div>c</div>'])
    const added = restoreSnapshot(root, target)
    expect(root.children[0]).toBe(a)
    expect(root.children[2]).toBe(c)
    expect(root.children[1]).not.toBe(b)
    expect(added).toEqual([root.children[1]])
    expect(added[0]).toBe(root.children[1])
    expect(takeSnapshot(root).blocks).toEqual(target.blocks)
  })

  test('the blocks taken out are handed back through `removed`', () => {
    const root = mount('<div>a</div><pre data-collapsed>b</pre><div>c</div>')
    const pre = root.children[1]
    const removed: HTMLElement[] = []
    restoreSnapshot(root, snap(['<div>a</div>', '<pre>B</pre>', '<div>c</div>']), removed)
    expect(removed).toEqual([pre])
  })

  test('insert in the middle', () => {
    const root = mount('<div>a</div><div>c</div>')
    const [a, c] = Array.from(root.children)
    const added = restoreSnapshot(root, snap(['<div>a</div>', '<div>b</div>', '<div>c</div>']))
    expect(takeSnapshot(root).blocks).toEqual(['<div>a</div>', '<div>b</div>', '<div>c</div>'])
    expect(root.children[0]).toBe(a)
    expect(root.children[2]).toBe(c)
    expect(added).toEqual([root.children[1]])
  })

  test('delete in the middle', () => {
    const root = mount('<div>a</div><div>b</div><div>c</div>')
    const [a, , c] = Array.from(root.children)
    const added = restoreSnapshot(root, snap(['<div>a</div>', '<div>c</div>']))
    expect(Array.from(root.children)).toEqual([a, c])
    expect(added).toEqual([])
  })

  test('append and prepend', () => {
    const abc = ['<div>a</div>', '<div>b</div>', '<div>c</div>']
    const ab = mount('<div>a</div><div>b</div>')
    const [a, b] = Array.from(ab.children)
    const appended = restoreSnapshot(ab, snap(abc))
    expect(ab.children[0]).toBe(a)
    expect(ab.children[1]).toBe(b)
    expect(appended).toEqual([ab.children[2]])
    expect(takeSnapshot(ab).blocks).toEqual(abc)

    const bc = mount('<div>b</div><div>c</div>')
    const [b2, c2] = Array.from(bc.children)
    const prepended = restoreSnapshot(bc, snap(abc))
    expect(bc.children[1]).toBe(b2)
    expect(bc.children[2]).toBe(c2)
    expect(prepended).toEqual([bc.children[0]])
    expect(takeSnapshot(bc).blocks).toEqual(abc)
  })

  test('replace everything', () => {
    const root = mount('<div>a</div><div>b</div>')
    const target = snap(['<p>x</p>', '<p>y</p>', '<p>z</p>'])
    const added = restoreSnapshot(root, target)
    expect(takeSnapshot(root).blocks).toEqual(target.blocks)
    expect(added).toEqual(Array.from(root.children))
  })

  test('restore into an empty root and to an empty document', () => {
    const root = mount('')
    restoreSnapshot(root, snap(['<div>a</div>']))
    expect(root.innerHTML).toBe('<div>a</div>')
    expect(restoreSnapshot(root, snap([]))).toEqual([])
    expect(root.children.length).toBe(0)
  })

  test('restoring the current document is a no-op returning []', () => {
    const root = mount('<div>a</div><ul><li>b</li></ul>')
    const before = Array.from(root.children)
    const html = root.innerHTML
    expect(restoreSnapshot(root, takeSnapshot(root))).toEqual([])
    expect(Array.from(root.children)).toEqual(before)
    expect(root.innerHTML).toBe(html)
  })

  test('caret returns exactly, including after a trailing space', () => {
    const src = mount('<div>x</div><div>word </div>')
    setRange(src.children[1]!.firstChild!, 5)
    const target = takeSnapshot(src)
    const root = mount('<div>x</div><div>other</div>')
    window.getSelection()!.removeAllRanges()
    restoreSnapshot(root, target)
    const sel = window.getSelection()!
    expect(sel.isCollapsed).toBe(true)
    expect(sel.anchorNode!.textContent).toBe('word ')
    expect(sel.anchorOffset).toBe(5)
    expect(takeSnapshot(root).selection).toEqual(target.selection)
  })

  test('caret returns inside a nested <li>', () => {
    const src = mount('<ul><li>one</li><li>two</li></ul>')
    setRange(src.querySelectorAll('li')[1]!.firstChild!, 2)
    const target = takeSnapshot(src)
    const root = mount('<div>nothing</div>')
    restoreSnapshot(root, target)
    const sel = window.getSelection()!
    expect(sel.anchorNode!.textContent).toBe('two')
    expect(sel.anchorOffset).toBe(2)
    expect(takeSnapshot(root).selection).toEqual(target.selection)
  })

  test('a range selection across blocks returns', () => {
    const src = mount('<div>aa</div><div>bb</div><div>cc</div>')
    setRange(src.children[0]!.firstChild!, 1, src.children[2]!.firstChild!, 2)
    const target = takeSnapshot(src)
    const root = mount('<div>q</div>')
    restoreSnapshot(root, target)
    expect(takeSnapshot(root).selection).toEqual(target.selection)
    expect(window.getSelection()!.isCollapsed).toBe(false)
  })

  test('a backward selection comes back backward (anchor at the end, focus at the start)', () => {
    const src = mount('<div>aa</div><div>bb</div><div>cc</div>')
    const sel = window.getSelection()!
    sel.setBaseAndExtent(src.children[2]!.firstChild!, 1, src.children[0]!.firstChild!, 1)
    const target = takeSnapshot(src)
    const root = mount('<div>q</div>')
    restoreSnapshot(root, target)
    const live = window.getSelection()!
    expect(live.anchorNode).toBe(root.children[2]!.firstChild)
    expect(live.anchorOffset).toBe(1)
    expect(live.focusNode).toBe(root.children[0]!.firstChild)
    expect(live.focusOffset).toBe(1)
    expect(takeSnapshot(root).selection).toEqual(target.selection)
  })

  test('a forward selection stays forward', () => {
    const src = mount('<div>aa</div><div>bb</div>')
    setRange(src.children[0]!.firstChild!, 1, src.children[1]!.firstChild!, 1)
    const target = takeSnapshot(src)
    expect(target.selection!.backward).toBeUndefined()
    const root = mount('<div>q</div>')
    restoreSnapshot(root, target)
    expect(window.getSelection()!.anchorNode).toBe(root.children[0]!.firstChild)
  })

  test('<pre> restored from plain text puts the caret at the same offset', () => {
    const root = mount('<div>x</div>')
    restoreSnapshot(root, snap(['<pre>aa\nbb</pre>'], { start: { block: 0, offset: 3 }, end: { block: 0, offset: 3 } }))
    const sel = window.getSelection()!
    expect(sel.anchorNode!.textContent).toBe('aa\nbb')
    expect(sel.anchorOffset).toBe(3)
  })

  test('caret in an empty <pre> and in an empty line', () => {
    const root = mount('<div>x</div>')
    restoreSnapshot(root, snap(['<pre><br></pre>', '<div><br></div>'], { start: { block: 0, offset: 0 }, end: { block: 0, offset: 0 } }))
    expect(window.getSelection()!.anchorNode).toBe(root.querySelector('pre'))
    expect(window.getSelection()!.anchorOffset).toBe(0)
  })

  test('scrollTop is restored', () => {
    const root = mount('<div>a</div>')
    stubScroll(root)
    restoreSnapshot(root, snap(['<div>a</div>', '<div>b</div>'], null, 120))
    expect(root.scrollTop).toBe(120)
  })

  test('takeSnapshot reads scrollTop', () => {
    const root = mount('<div>a</div>')
    stubScroll(root)
    root.scrollTop = 77
    expect(takeSnapshot(root).scrollTop).toBe(77)
  })

  test('out-of-range offset and block index are clamped', () => {
    const root = mount('<div>x</div>')
    restoreSnapshot(root, snap(['<div>ab</div>'], { start: { block: 0, offset: 999 }, end: { block: 5, offset: 999 } }))
    const sel = window.getSelection()!
    expect(sel.anchorNode!.textContent).toBe('ab')
    expect(sel.anchorOffset).toBe(2)
    expect(sel.focusOffset).toBe(2)
  })

  test('null selection leaves the current selection alone', () => {
    const root = mount('<div>a</div><div>keep</div>')
    const keep = root.children[1]!.firstChild!
    setRange(keep, 2)
    restoreSnapshot(root, snap(['<div>a</div>', '<div>keep</div>', '<div>new</div>']))
    expect(window.getSelection()!.anchorNode).toBe(keep)
    expect(window.getSelection()!.anchorOffset).toBe(2)
  })
})

describe('restoreSnapshot parses each block on its own', () => {
  // The HTML parser reshapes some markup a live contenteditable can hold (a <p> holding a block is closed
  // before it). Parsed together, one stored block could become several and shift every later index.
  test('a block the parser would reshape still restores as one block; later blocks keep their index', () => {
    const root = mount('<div>x</div>')
    const added = restoreSnapshot(root, snap(
      ['<p>lead<div>inner</div>tail</p>', '<div>next</div>'],
      { start: { block: 1, offset: 2 }, end: { block: 1, offset: 2 } },
    ))
    expect(added).toHaveLength(2)
    expect(root.children).toHaveLength(2)
    expect(root.children[0]!.textContent).toBe('leadinnertail')
    expect(root.children[1]!.textContent).toBe('next')
    const sel = window.getSelection()!
    expect(sel.anchorNode!.textContent).toBe('next')
    expect(sel.anchorOffset).toBe(2)
  })
})

describe('restoreSnapshot never executes markup', () => {
  test('parses through DOMParser: no script lands, onerror is stripped', () => {
    const root = mount('<div>a</div>')
    const spy = vi.spyOn(DOMParser.prototype, 'parseFromString')
    restoreSnapshot(root, snap([
      '<div><img src=x onerror="window.__x=1"></div>',
      '<div onclick="window.__x=2">hi<script>window.__x=3</script></div>',
    ]))
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
    expect(document.body.querySelector('script')).toBeNull()
    const img = root.querySelector('img')!
    expect(img).not.toBeNull()
    expect(img.hasAttribute('onerror')).toBe(false)
    expect(root.querySelector('[onclick]')).toBeNull()
    expect((window as unknown as Record<string, unknown>).__x).toBeUndefined()
  })
})

describe('a selection anchored on the root itself', () => {
  test('a caret past the last child comes back at the end of the last block', () => {
    const root = mount('<div>ab</div><div>cd</div>')
    const sel = document.getSelection()!
    sel.setBaseAndExtent(root, 2, root, 2)
    const snap = takeSnapshot(root)
    sel.setBaseAndExtent(root.children[0]!.firstChild!, 0, root.children[0]!.firstChild!, 0)
    restoreSnapshot(root, snap)
    expect(sel.anchorNode).toBe(root.children[1]!.firstChild)
    expect(sel.anchorOffset).toBe(2)
  })

  test('a caret before child 1 comes back at the start of that block', () => {
    const root = mount('<div>ab</div><div>cd</div>')
    const sel = document.getSelection()!
    sel.setBaseAndExtent(root, 1, root, 1)
    const snap = takeSnapshot(root)
    sel.setBaseAndExtent(root.children[0]!.firstChild!, 2, root.children[0]!.firstChild!, 2)
    restoreSnapshot(root, snap)
    expect(sel.anchorNode).toBe(root.children[1]!.firstChild)
    expect(sel.anchorOffset).toBe(0)
  })
})
