import { mdToHtml, htmlToMd, htmlToPlainText, parseRef, safeHref, unwrapBlockContainers, flattenNestedHeadings, flattenNestedBlockquotes, demoteHeadings, demoteBlockquotes } from '../src/core/markdown'

const roundTrip = (md: string) => {
  const div = document.createElement('div')
  div.innerHTML = mdToHtml(md)
  return htmlToMd(div)
}

test('inline formats round-trip', () => {
  const md = 'a **b** *i* <u>u</u> ~~s~~ fim'
  expect(roundTrip(md)).toBe(md)
})

test('single-tilde unlinked-ref marker renders as a muted span and round-trips', () => {
  const md = 'blocked by ~Fix bug~ now'
  const html = mdToHtml(md)
  expect(html).toContain('<span class="tt-unlinked-ref">Fix bug</span>')
  expect(roundTrip(md)).toBe(md)
})

test('double-tilde strike is unaffected by the new single-tilde marker rule', () => {
  const md = 'a ~~struck~~ and ~marker~ together'
  const html = mdToHtml(md)
  expect(html).toContain('<s>struck</s>')
  expect(html).toContain('<span class="tt-unlinked-ref">marker</span>')
  expect(roundTrip(md)).toBe(md)
})

test('headers and lists', () => {
  const md = '# T1\n## T2\n### T3\ntexto\n- um\n- dois\n1. a\n2. b'
  expect(roundTrip(md)).toBe(md)
})

describe('a ref target containing markdown-syntax characters cannot corrupt the rebuilt <a> tag', () => {
  // Regression test for a CodeQL alert on ui/editor.ts's paste path: a ref
  // target reaching mdToHtml (via a pasted <a data-ref>, or even just plain
  // @[label](kind:ref)-shaped *text* in pasted HTML — mdToHtml can't tell
  // the two apart) used to be able to break out of the rebuilt
  // data-ref="${ref}" attribute. esc() escaping the line before the ref
  // regex captures its groups stops a bare quote in the *original* text,
  // but not one reintroduced by a *later* substitution in the same
  // function — the single-tilde unlinked-ref marker's own template
  // (`class="tt-unlinked-ref"`) contains one. A ref target of
  // `x~y~contenteditable="true"~z~` used to reach exactly that. Fixed by
  // extracting ref chips into placeholder tokens and only splicing in the
  // real <a> markup as the very last step, after every other substitution
  // has already run.
  test('a tilde-chain in the ref target cannot inject a live attribute', () => {
    const md = '@[evil](person:x~y~contenteditable="true"~z~)'
    const html = mdToHtml(md)
    const probe = document.createElement('div')
    probe.innerHTML = html
    expect(probe.querySelector('[contenteditable="true"]')).toBeNull()
    expect(probe.querySelector('a.ref')!.getAttribute('data-ref')).toBe('person:x~y~contenteditable="true"~z~')
  })
  test('a legitimate ref (this app\'s own uuid-shaped id) still renders as a real chip', () => {
    const md = '@[Ana](person:3f2504e0-4f89-11d3-9a0c-0305e82c3301)'
    const html = mdToHtml(md)
    expect(html).toContain('<a class="ref" data-ref="person:3f2504e0-4f89-11d3-9a0c-0305e82c3301"')
  })
  test('ordinary numbers in text are untouched by the placeholder mechanism', () => {
    expect(mdToHtml('step 1 of 2024')).toContain('step 1 of 2024')
  })
})

test('escapes html', () => {
  expect(mdToHtml('<script>x</script>')).not.toContain('<script>')
})

test('refs become chips and round-trip', () => {
  const md = 'ver @[Ana](person:abc-1) e @[02/07/2026](day:2026-07-02)'
  const html = mdToHtml(md)
  expect(html).toContain('data-ref="person:abc-1"')
  expect(html).toContain('>@Ana<')
  expect(roundTrip(md)).toBe(md)
})

test('parseRef', () => {
  expect(parseRef('person:abc')).toEqual({ kind: 'person', id: 'abc' })
  expect(parseRef('day:2026-07-02')).toEqual({ kind: 'day', date: '2026-07-02' })
  expect(parseRef('junk')).toBeNull()
})

test('br inside block becomes newline', () => {
  const div = document.createElement('div')
  div.innerHTML = '<div>line1<br>line2</div>'
  expect(htmlToMd(div)).toBe('line1\nline2')
})

test('br nested inside inline formatting (bolding a multi-line selection) still becomes newline', () => {
  const div = document.createElement('div')
  div.innerHTML = '<div><b>line1<br>line2</b></div>'
  expect(htmlToMd(div)).toBe('**line1**\n**line2**')
  expect(htmlToPlainText(div)).toBe('line1\nline2')
})

describe('nested <br> inside inline formatting — stress cases', () => {
  test('italic, underline and strike all split the same way as bold', () => {
    expect(htmlToMd(elWith('<i>l1<br>l2</i>'))).toBe('*l1*\n*l2*')
    expect(htmlToMd(elWith('<u>l1<br>l2</u>'))).toBe('<u>l1</u>\n<u>l2</u>')
    expect(htmlToMd(elWith('<s>l1<br>l2</s>'))).toBe('~~l1~~\n~~l2~~')
  })

  test('text before/after the formatted run attaches to the first/last line, not lost', () => {
    const div = elWith('pre<b>l1<br>l2</b>post')
    expect(htmlToMd(div)).toBe('pre**l1**\n**l2**post')
    expect(htmlToPlainText(div)).toBe('prel1\nl2post')
  })

  test('doubled <br> inside the wrapper preserves the blank line between formatted lines', () => {
    const div = elWith('<b>a<br><br>b</b>')
    expect(htmlToMd(div)).toBe('**a**\n\n**b**')
    expect(htmlToPlainText(div)).toBe('a\n\nb')
  })

  test('trailing <br> inside the wrapper produces no extra empty line, matching a direct-child trailing br', () => {
    expect(htmlToMd(elWith('<b>a<br></b>'))).toBe('**a**')
    expect(htmlToMd(elWith('a<br>'))).toBe('a')
  })

  test('doubly-nested formatting (bold+italic across lines) round-trips through both marker sets', () => {
    const div = elWith('<b><i>l1<br>l2</i></b>')
    expect(htmlToMd(div)).toBe('***l1***\n***l2***')
    expect(htmlToPlainText(div)).toBe('l1\nl2')
  })

  test('a multi-line bold run inside a list item keeps the item on one bullet with an internal newline', () => {
    const div = document.createElement('div')
    div.innerHTML = '<ul><li><b>l1<br>l2</b></li></ul>'
    expect(htmlToMd(div)).toBe('- **l1**\n**l2**')
    expect(htmlToPlainText(div)).toBe('l1\nl2')
  })

  test('splitting never mutates the live editor DOM the nodes came from', () => {
    const div = elWith('pre<b>l1<br>l2</b>post')
    const before = div.innerHTML
    htmlToMd(div)
    htmlToPlainText(div)
    expect(div.innerHTML).toBe(before)
  })

  test('is idempotent through a save/reload round trip (md -> html -> md stays stable)', () => {
    const div = elWith('pre<b>l1<br>l2</b>post')
    const md = htmlToMd(div)
    const reloaded = document.createElement('div')
    // mdToHtml has no multi-line-bold syntax to re-parse (** doesn't span
    // lines), so the reload renders each markdown line as its own <div> —
    // the round trip is expected to flatten to that, not resurrect the
    // original nested <b>. What matters is it's stable from here on.
    reloaded.innerHTML = mdToHtml(md)
    expect(htmlToMd(reloaded)).toBe(md)
  })
})

function elWith(html: string): HTMLDivElement {
  const div = document.createElement('div')
  div.innerHTML = `<div>${html}</div>`
  return div
}

describe('nested list not a direct <li> child — stress cases', () => {
  // Real contenteditable editing at deep nesting (Chrome restructuring on
  // Enter/Backspace merges inside a multi-level list) can land a sub-list a
  // level or two down inside its <li>, wrapped in a stray <div>, instead of
  // as a direct child. nestedListsOf's old `:scope > ul, :scope > ol` check
  // missed that, so the whole sub-list silently flattened into the parent
  // item's own text with no bullets/numbers/newlines — losing all ordering
  // and hierarchy for that branch.
  test('ol nested inside a wrapper div still renders as a proper indented sub-list', () => {
    const div = document.createElement('div')
    div.innerHTML = '<ol><li><div>A<ol><li>A1</li><li>A2</li></ol></div></li><li>B</li></ol>'
    expect(htmlToMd(div)).toBe('1. A\n  1. A1\n  2. A2\n2. B')
    expect(htmlToPlainText(div)).toBe('A\n  A1\n  A2\nB')
  })

  test('4 levels deep, each wrapped in a div, multiple siblings per level', () => {
    const div = document.createElement('div')
    div.innerHTML =
      '<ol>' +
        '<li><div>A<ol>' +
          '<li><div>A1</div></li>' +
          '<li><div>A2<ol>' +
            '<li><div>A2a</div></li>' +
            '<li><div>A2b<ol>' +
              '<li><div>A2b-i</div></li>' +
              '<li><div>A2b-ii</div></li>' +
            '</ol></div></li>' +
          '</ol></div></li>' +
        '</ol></div></li>' +
        '<li><div>B<ol><li><div>B1</div></li></ol></div></li>' +
      '</ol>'
    expect(htmlToMd(div)).toBe(
      '1. A\n' +
      '  1. A1\n' +
      '  2. A2\n' +
      '    1. A2a\n' +
      '    2. A2b\n' +
      '      1. A2b-i\n' +
      '      2. A2b-ii\n' +
      '2. B\n' +
      '  1. B1'
    )
  })

  // Even further off: the sub-list isn't inside its <li> at all — it sits as
  // a direct child of the ancestor <ol>/<ul>, sibling to the item it should
  // be nested under. renderListMd's `child.tagName !== 'li'` skip dropped it
  // outright, so those items never reached the saved markdown at all.
  test('a sub-list left as a direct child of the parent list still renders (not dropped)', () => {
    const div = document.createElement('div')
    div.innerHTML = '<ol><li>a</li><ol><li>b</li><li>c</li></ol></ol>'
    expect(htmlToMd(div)).toBe('1. a\n  1. b\n  2. c')
    expect(htmlToPlainText(div)).toBe('a\n  b\n  c')
  })
})

test('ordered list numbers preserved', () => {
  const md = '3. a\n5. b'
  expect(roundTrip(md)).toBe(md)
})

test('nested ambiguous asterisks stay stable', () => {
  expect(roundTrip('**a*b*c** e *i* fim')).toBe('**a*b*c** e *i* fim')
})

test('a block-trailing space after inline formatting renders as &nbsp; (a plain trailing space is CSS-collapsed, so Chrome lands the caret inside the <strong> and typing sticks to bold — the template "**Label:** " lines)', () => {
  expect(mdToHtml('**Contexto:** ')).toBe('<div><strong>Contexto:</strong>&nbsp;</div>')
  expect(mdToHtml('- **b** ')).toBe('<ul><li><strong>b</strong>&nbsp;</li></ul>')
  // and it still round-trips back to a regular trailing space
  expect(roundTrip('**Contexto:** ')).toBe('**Contexto:** ')
})

test('non-breaking spaces coming back from the editor normalize to regular spaces in markdown', () => {
  const div = document.createElement('div')
  div.innerHTML = '<div><strong>X:</strong>&nbsp;done</div>'
  expect(htmlToMd(div)).toBe('**X:** done')
})

test('ref chip with problematic chars in label sanitizes on md export', () => {
  const div = document.createElement('div')
  // Create a chip with a label containing chars that would break the regex if unsanitized
  div.innerHTML = '<div><a class="ref" data-ref="person:x">@bad[label](chars)</a></div>'
  const md = htmlToMd(div)
  // The label is sanitized: bad[label](chars) -> badlabelchars
  expect(md).toBe('@[badlabelchars](person:x)')
  // And the round-trip succeeds without regex breakage
  const html = mdToHtml(md)
  expect(html).toContain('data-ref="person:x"')
  expect(html).toContain('>@badlabelchars<')
  expect(roundTrip(md)).toBe(md)
})

test('parseRef accepts action/milestone/risk prefixes', () => {
  expect(parseRef('action:x1')).toEqual({ kind: 'action', id: 'x1' })
  expect(parseRef('milestone:x2')).toEqual({ kind: 'milestone', id: 'x2' })
  expect(parseRef('risk:x3')).toEqual({ kind: 'risk', id: 'x3' })
})

test('action/milestone/risk refs become chips and round-trip', () => {
  const md = 'ver @[Fix bug](action:a1) e @[Ship v2](milestone:m1) e @[Vendor delay](risk:r1)'
  const html = mdToHtml(md)
  expect(html).toContain('data-ref="action:a1"')
  expect(html).toContain('data-ref="milestone:m1"')
  expect(html).toContain('data-ref="risk:r1"')
  expect(roundTrip(md)).toBe(md)
})

test('mdToHtml with a resolver shows the resolved label instead of the stored one', () => {
  const md = 'see @[Old Name](action:a1)'
  const html = mdToHtml(md, (target) => (target.kind === 'action' && target.id === 'a1' ? 'New Name' : null))
  expect(html).toContain('>@New Name<')
  expect(html).not.toContain('Old Name')
})

test('mdToHtml resolver returning null falls back to the stored label', () => {
  const md = 'see @[Old Name](action:a1)'
  const html = mdToHtml(md, () => null)
  expect(html).toContain('>@Old Name<')
})

test('mdToHtml with no resolver uses the stored label (existing callers unaffected)', () => {
  const md = 'see @[Old Name](action:a1)'
  expect(mdToHtml(md)).toContain('>@Old Name<')
})

test('resolved label is HTML-escaped', () => {
  const md = 'see @[Old](action:a1)'
  const html = mdToHtml(md, () => '<script>x</script>')
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;script&gt;')
})

test('day ref resolves to the current locale format via the resolver', () => {
  const md = 'ver @[02/07/2026](day:2026-07-02)'
  const html = mdToHtml(md, (target) => (target.kind === 'day' ? `${target.date} (resolved)` : null))
  expect(html).toContain('>@2026-07-02 (resolved)<')
})

test('leading indent renders as non-breaking spaces and round-trips as plain spaces', () => {
  const md = '    indented line'
  const html = mdToHtml(md)
  expect(html).toBe('<div>\u00a0\u00a0\u00a0\u00a0indented line</div>')
  expect(roundTrip(md)).toBe(md)
})

test('leading indent inside a list item round-trips', () => {
  const md = '-     indented bullet text'
  expect(roundTrip(md)).toBe(md)
})

test('leading indent inside a header round-trips', () => {
  const md = '#   indented heading'
  expect(roundTrip(md)).toBe(md)
})

test('nested unordered list round-trips (2 levels)', () => {
  const md = '- a\n  - a1\n  - a2\n- b'
  expect(roundTrip(md)).toBe(md)
})

test('nested list round-trips 4 levels deep', () => {
  const md = '- a\n  - b\n    - c\n      - d'
  expect(roundTrip(md)).toBe(md)
})

test('nested list produces a real nested <ul> inside the parent <li>', () => {
  const md = '- a\n  - a1'
  expect(mdToHtml(md)).toBe('<ul><li>a<ul><li>a1</li></ul></li></ul>')
})

test('promoting a nested item back to a top-level sibling round-trips', () => {
  const md = '- a\n  - a1\n- b\n  - b1\n  - b2'
  expect(roundTrip(md)).toBe(md)
})

test('ordered list with nested unordered sublist round-trips, numbering restarts per level', () => {
  const md = '1. a\n  - a1\n  - a2\n2. b'
  expect(roundTrip(md)).toBe(md)
})

test('nested ordered list restarts numbering independently per level', () => {
  const md = '1. a\n  1. a-sub\n  2. a-sub2\n2. b'
  expect(roundTrip(md)).toBe(md)
})

test('an indent jump of more than one level clamps to one level deeper than the actual parent', () => {
  const md = '- a\n      - too deep'
  expect(mdToHtml(md)).toBe('<ul><li>a<ul><li>too deep</li></ul></li></ul>')
})

test('an over-indented first list line (no parent yet) clamps to depth 0', () => {
  const md = '        - way too deep'
  expect(mdToHtml(md)).toBe('<ul><li>way too deep</li></ul>')
})

test('nesting depth caps at 4 levels (0-3) even if indentation implies deeper', () => {
  const md = '- a\n  - b\n    - c\n      - d\n        - e'
  const html = mdToHtml(md)
  const div = document.createElement('div')
  div.innerHTML = html
  expect(htmlToMd(div)).toBe('- a\n  - b\n    - c\n      - d\n      - e')
})

test('a nested level that switches marker type mid-level round-trips without dropping the second list', () => {
  const md = '- a\n  - b\n  1. c'
  expect(roundTrip(md)).toBe(md)
})

test('htmlToPlainText keeps every item when a nested level switches marker type mid-level', () => {
  const div = document.createElement('div')
  div.innerHTML = mdToHtml('- a\n  - b\n  1. c')
  expect(htmlToPlainText(div)).toBe('a\n  b\n  c')
})

test('htmlToPlainText keeps nested list item text on its own line', () => {
  const div = document.createElement('div')
  div.innerHTML = mdToHtml('- a\n  - a1\n- b')
  expect(htmlToPlainText(div)).toBe('a\n  a1\nb')
})

test('htmlToPlainText indents 2 spaces per nesting level (mirrors markdown\'s indent convention)', () => {
  const div = document.createElement('div')
  div.innerHTML = mdToHtml('- a\n  - b\n    - c\n      - d')
  expect(htmlToPlainText(div)).toBe('a\n  b\n    c\n      d')
})

test('bare "---" line becomes <hr> and round-trips', () => {
  const md = 'before\n\n---\n\nafter'
  const html = mdToHtml(md)
  expect(html).toContain('<hr>')
  expect(roundTrip(md)).toBe(md)
})

test('"---" round-trips standalone and closes any open list first', () => {
  const md = '- a\n- b\n---\ntext'
  const html = mdToHtml(md)
  expect(html).toBe('<ul><li>a</li><li>b</li></ul><hr><div>text</div>')
  expect(roundTrip(md)).toBe(md)
})

test('a line with only 1-2 dashes is not treated as a rule', () => {
  const md = '--\nnot a rule'
  expect(mdToHtml(md)).not.toContain('<hr>')
})

test('htmlToPlainText renders an <hr> as "---" (copy without formatting keeps the divider visible instead of a blank line)', () => {
  const div = document.createElement('div')
  div.innerHTML = '<div>before</div><hr><div>after</div>'
  expect(htmlToPlainText(div)).toBe('before\n---\nafter')
})

describe('CF_HTML fragment comment markers are skipped, not read as text', () => {
  // Windows' clipboard HTML format wraps a partial selection in
  // <!--StartFragment-->/<!--EndFragment--> comments (alongside a
  // Version/StartHTML/EndHTML header that lives outside the parsed
  // fragment, so it's not exercised here) — a real ui/editor.ts paste
  // parses this straight from the clipboard's text/html. Comment.textContent
  // is the comment's own string, so a naive "not an element => read
  // textContent" walk leaks "StartFragment" into the output as if it were
  // real content.
  test('htmlToMd skips them', () => {
    const div = document.createElement('div')
    div.innerHTML = '<div><!--StartFragment-->kept text<!--EndFragment--></div>'
    expect(htmlToMd(div)).toBe('kept text')
  })
  test('htmlToPlainText skips them', () => {
    const div = document.createElement('div')
    div.innerHTML = '<div><!--StartFragment-->kept text<!--EndFragment--></div>'
    expect(htmlToPlainText(div)).toBe('kept text')
  })
  test('htmlToMd skips a fragment comment sitting directly under the root, between real blocks', () => {
    const div = document.createElement('div')
    div.innerHTML = '<!--StartFragment--><div>a</div><div>b</div><!--EndFragment-->'
    expect(htmlToMd(div)).toBe('a\nb')
  })
})

describe('style-attribute formatting (clipboard HTML from apps that use style= instead of semantic tags)', () => {
  test('a <span style="font-weight:700"> is read as bold even with no <b>/<strong> tag', () => {
    const div = document.createElement('div')
    div.innerHTML = '<p>plain <span style="font-weight:700">bold word</span> plain</p>'
    expect(htmlToMd(div)).toBe('plain **bold word** plain')
  })
  test('a <span style="font-style:italic"> is read as italic', () => {
    const div = document.createElement('div')
    div.innerHTML = '<p>plain <span style="font-style:italic">italic word</span> plain</p>'
    expect(htmlToMd(div)).toBe('plain *italic word* plain')
  })
  test('a <span style="text-decoration:underline"> is read as underline', () => {
    const div = document.createElement('div')
    div.innerHTML = '<p>plain <span style="text-decoration:underline">u word</span> plain</p>'
    expect(htmlToMd(div)).toBe('plain <u>u word</u> plain')
  })
  test('a <span style="text-decoration:line-through"> is read as strike', () => {
    const div = document.createElement('div')
    div.innerHTML = '<p>plain <span style="text-decoration:line-through">s word</span> plain</p>'
    expect(htmlToMd(div)).toBe('plain ~~s word~~ plain')
  })
  // Google Docs' clipboard export wraps its ENTIRE content in
  // <b style="font-weight:normal" id="docs-internal-guid-...">, using <b>
  // purely as a container, not as real bold — an explicit style override
  // must win over the tag's default meaning, or every Docs paste would
  // come out entirely bolded.
  test('an explicit style="font-weight:normal" on a <b>/<strong> suppresses the tag\'s bold', () => {
    const div = document.createElement('div')
    div.innerHTML = '<p><b style="font-weight:normal">not bold</b> plain</p>'
    expect(htmlToMd(div)).toBe('not bold plain')
  })
  test('a real <b>/<strong> with no style override still bolds as before', () => {
    const div = document.createElement('div')
    div.innerHTML = '<p><b>bold</b> plain</p>'
    expect(htmlToMd(div)).toBe('**bold** plain')
  })
})

describe('unwrapBlockContainers (Google-Docs-style whole-paste wrapper)', () => {
  test('splits an all-block-children non-block wrapper into separate top-level blocks', () => {
    const div = document.createElement('div')
    div.innerHTML = '<b style="font-weight:normal" id="docs-internal-guid-x"><p>line1</p><p>line2</p></b>'
    unwrapBlockContainers(div)
    expect(htmlToMd(div)).toBe('line1\nline2')
  })
  test('a wrapper that carries real formatting still applies it per-block after splitting', () => {
    const div = document.createElement('div')
    div.innerHTML = '<i><p>one</p><p>two</p></i>'
    unwrapBlockContainers(div)
    expect(htmlToMd(div)).toBe('*one*\n*two*')
  })
  test('does not touch a <li> nesting a <ul>/<ol> — list nesting already has its own correct handling', () => {
    const div = document.createElement('div')
    div.innerHTML = '<ul><li>um<ul><li>dois</li></ul></li></ul>'
    unwrapBlockContainers(div)
    expect(htmlToMd(div)).toBe('- um\n  - dois')
  })
  test('does not touch a <td> wrapping a <p> — table cells already have their own correct handling', () => {
    const div = document.createElement('div')
    div.innerHTML = '<table><tr><td><p>cell</p></td></tr></table>'
    unwrapBlockContainers(div)
    expect(htmlToMd(div)).toBe('cell')
  })
})

describe('flattenNestedHeadings (undoes Chromium formatBlock nesting that makes a heading "grow" per keypress)', () => {
  // The HTML parser refuses to nest one <h1> inside another, so innerHTML
  // can't reproduce the state execCommand('formatBlock') builds via the DOM
  // API. This mirrors that: wrap `inner` in `depth` genuine <h1> parents.
  const nest = (inner: string, depth: number): HTMLElement => {
    const root = document.createElement('div')
    const frag = document.createElement('div')
    frag.innerHTML = inner
    let cursor: Node = root
    for (let i = 0; i < depth; i++) {
      const h = document.createElement('h1')
      cursor.appendChild(h)
      cursor = h
    }
    while (frag.firstChild) cursor.appendChild(frag.firstChild)
    return root
  }

  test('a heading nested inside a heading collapses to one outer heading', () => {
    const div = nest('hello world here<br>second line text', 2)
    flattenNestedHeadings(div)
    expect(div.innerHTML).toBe('<h1>hello world here<br>second line text</h1>')
  })
  test('repeated nesting (Ctrl+1 pressed several times) flattens back to a single heading', () => {
    const div = nest('text', 4)
    flattenNestedHeadings(div)
    expect(div.innerHTML).toBe('<h1>text</h1>')
  })
  test('repeated Ctrl+1 on a list collapses the stacked headings but keeps one wrapping heading', () => {
    // Chromium wraps <h1> around the whole <ul> and stacks another on each
    // repeat; unwrapping the nested ones leaves a single <h1><ul>…</ul></h1>,
    // which the fixed-rem heading CSS renders at a stable size.
    const div = nest('<ul><li>hello world item</li></ul>', 3)
    flattenNestedHeadings(div)
    expect(div.innerHTML).toBe('<h1><ul><li>hello world item</li></ul></h1>')
  })
  test('a well-formed heading is left untouched', () => {
    const div = document.createElement('div')
    div.innerHTML = '<h2>a real heading</h2><div>body</div>'
    flattenNestedHeadings(div)
    expect(div.innerHTML).toBe('<h2>a real heading</h2><div>body</div>')
  })
})

describe('demoteHeadings ("clear formatting" also drops the heading style, like Docs/Word)', () => {
  const mount = (html: string): HTMLElement => {
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.appendChild(root)
    return root
  }
  const selectAll = (root: HTMLElement): Range => {
    const r = document.createRange()
    r.selectNodeContents(root)
    return r
  }

  test('a heading in the selection becomes a plain <div>, text kept', () => {
    const root = mount('<h1>Title</h1><div>body</div>')
    demoteHeadings(root, selectAll(root))
    expect(root.innerHTML).toBe('<div>Title</div><div>body</div>')
    expect(htmlToMd(root)).toBe('Title\nbody')
    root.remove()
  })

  test('every heading level the range touches is demoted at once', () => {
    const root = mount('<h1>a</h1><h2>b</h2><h3>c</h3>')
    demoteHeadings(root, selectAll(root))
    expect(root.innerHTML).toBe('<div>a</div><div>b</div><div>c</div>')
    root.remove()
  })

  test('a heading outside the range is left alone', () => {
    const root = mount('<h1>keep</h1><div>x</div><h2>clear</h2>')
    const r = document.createRange()
    r.setStart(root.children[1]!, 0) // start at the middle <div>
    r.setEndAfter(root.children[2]!) // through the <h2>
    demoteHeadings(root, r)
    expect(root.innerHTML).toBe('<h1>keep</h1><div>x</div><div>clear</div>')
    root.remove()
  })

  test('list nesting is not touched', () => {
    const root = mount('<ul><li>a<ul><li>b</li></ul></li></ul>')
    demoteHeadings(root, selectAll(root))
    expect(htmlToMd(root)).toBe('- a\n  - b')
    root.remove()
  })
})

describe('demoteBlockquotes ("clear formatting" also drops blockquote styling)', () => {
  const mount = (html: string): HTMLElement => {
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.appendChild(root)
    return root
  }
  const selectAll = (root: HTMLElement): Range => {
    const r = document.createRange()
    r.selectNodeContents(root)
    return r
  }

  test('demoteBlockquotes unwraps a blockquote the range touches', () => {
    const root = mount('<blockquote>quoted line</blockquote>')
    demoteBlockquotes(root, selectAll(root))
    expect(root.querySelector('blockquote')).toBeNull()
    expect(root.textContent).toBe('quoted line')
    root.remove()
  })
})

describe('pasted tables render as readable delimited text (this app has no native table syntax)', () => {
  test('cells join with " | ", one row per line', () => {
    const div = document.createElement('div')
    div.innerHTML = '<table><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></table>'
    expect(htmlToMd(div)).toBe('A1 | B1\nA2 | B2')
  })
  test('a table wrapped in <thead>/<tbody> still renders every row', () => {
    const div = document.createElement('div')
    div.innerHTML = '<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>A1</td><td>B1</td></tr></tbody></table>'
    expect(htmlToMd(div)).toBe('H1 | H2\nA1 | B1')
  })
})

test('script/style tag text does not leak into the output as visible content', () => {
  const div = document.createElement('div')
  div.innerHTML = '<div>before</div><script>alert(1)</script><div>after</div>'
  expect(htmlToMd(div)).not.toContain('alert(1)')
})

describe('htmlToMd / htmlToPlainText do not mutate the source DOM', () => {
  test('single-line block (no <br>) round-trips without touching the source', () => {
    const div = document.createElement('div')
    div.innerHTML = '<div>a <strong>b</strong> c</div><div>second</div>'
    const before = div.innerHTML
    expect(htmlToMd(div)).toBe('a **b** c\nsecond')
    expect(div.innerHTML).toBe(before)
  })

  test('block with a <br> nested inside inline formatting round-trips without touching the source', () => {
    const div = document.createElement('div')
    div.innerHTML = '<div><b>l1<br>l2</b></div>'
    const before = div.innerHTML
    expect(htmlToMd(div)).toBe('**l1**\n**l2**')
    expect(div.innerHTML).toBe(before)
  })

  test('htmlToPlainText leaves the source DOM intact', () => {
    const div = document.createElement('div')
    div.innerHTML = '<div>one</div><div><i>two<br>three</i></div>'
    const before = div.innerHTML
    expect(htmlToPlainText(div)).toBe('one\ntwo\nthree')
    expect(div.innerHTML).toBe(before)
  })
})

describe('safeHref', () => {
  test('accepts http/https/mailto unchanged', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeHref('http://example.com')).toBe('http://example.com')
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com')
    expect(safeHref('  https://example.com  ')).toBe('https://example.com')
  })
  test('rejects javascript/data/vbscript and scheme-relative/relative', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('JavaScript:alert(1)')).toBeNull()
    expect(safeHref('data:text/html,x')).toBeNull()
    expect(safeHref('vbscript:msgbox')).toBeNull()
    expect(safeHref('/relative/path')).toBeNull()
    expect(safeHref('#frag')).toBeNull()
    expect(safeHref('example.com')).toBeNull()
  })
  test('rejects a scheme smuggled past a control character', () => {
    expect(safeHref('java\tscript:alert(1)')).toBeNull()
    expect(safeHref('java\nscript:alert(1)')).toBeNull()
    expect(safeHref('  java script:alert(1)')).toBeNull()
  })
})

describe('inline code', () => {
  const roundTrip = (md: string) => {
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    return htmlToMd(div)
  }
  test('renders <code> and round-trips', () => {
    expect(mdToHtml('run `npm test` now')).toContain('<code>npm test</code>')
    expect(roundTrip('run `npm test` now')).toBe('run `npm test` now')
  })
  test('content is literal — inner markdown is NOT parsed', () => {
    const html = mdToHtml('see `**not bold** and *not italic*`')
    expect(html).toContain('<code>**not bold** and *not italic*</code>')
    expect(html).not.toContain('<strong>')
    expect(html).not.toContain('<em>')
    expect(roundTrip('see `**not bold** and *not italic*`')).toBe('see `**not bold** and *not italic*`')
  })
  test('code adjacent to a ref chip — both survive', () => {
    const md = '`cfg` @[Ana](person:abc-1) `end`'
    const html = mdToHtml(md)
    expect(html).toContain('<code>cfg</code>')
    expect(html).toContain('<code>end</code>')
    expect(html).toContain('data-ref="person:abc-1"')
    expect(roundTrip(md)).toBe(md)
  })
  test('html inside a code span is escaped, not live', () => {
    const html = mdToHtml('danger `<img src=x onerror=y>` here')
    const probe = document.createElement('div'); probe.innerHTML = html
    expect(probe.querySelector('img')).toBeNull()
    expect(probe.querySelector('code')!.textContent).toBe('<img src=x onerror=y>')
  })
  test('idempotent through two md->html->md cycles', () => {
    const md = 'a `b` c'
    expect(roundTrip(roundTrip(md))).toBe(md)
  })
  test('inlineText / htmlToPlainText unwraps code to bare text', () => {
    const div = document.createElement('div'); div.innerHTML = mdToHtml('run `x` now')
    expect(htmlToPlainText(div)).toBe('run x now')
  })
})

describe('external links', () => {
  const roundTrip = (md: string) => {
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    return htmlToMd(div)
  }
  test('renders a new-tab anchor and round-trips', () => {
    const html = mdToHtml('see [the docs](https://example.com/x)')
    const probe = document.createElement('div'); probe.innerHTML = html
    const a = probe.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://example.com/x')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(a.textContent).toBe('the docs')
    expect(roundTrip('see [the docs](https://example.com/x)')).toBe('see [the docs](https://example.com/x)')
  })
  test('formatting inside link text is preserved', () => {
    const html = mdToHtml('[**bold** text](https://e.com)')
    expect(html).toContain('<strong>bold</strong>')
    expect(roundTrip('[**bold** text](https://e.com)')).toBe('[**bold** text](https://e.com)')
  })
  test('disallowed schemes drop the link, keep the visible text', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '  javascript:alert(1)', 'java\tscript:alert(1)']) {
      const html = mdToHtml(`click [here](${bad}) now`)
      const probe = document.createElement('div'); probe.innerHTML = html
      expect(probe.querySelector('a')).toBeNull()
      expect(probe.textContent).toContain('click here now')
    }
  })
  test('a url with markdown-special chars cannot break out of the href attribute', () => {
    const md = '[x](https://e.com/~a~~b"onmouseover="1)'
    const html = mdToHtml(md)
    const probe = document.createElement('div'); probe.innerHTML = html
    expect(probe.querySelector('[onmouseover]')).toBeNull()
    expect(probe.querySelectorAll('a').length).toBeLessThanOrEqual(1)
  })
  test('link text cannot contain a closing bracket (documented boundary)', () => {
    // [a]b](url) — [^\]]+ stops at the first ], so this stays literal.
    expect(mdToHtml('[a]b](https://e.com)')).not.toContain('<a ')
  })
  test('htmlToMd re-validates href on the way out (defence in depth)', () => {
    const div = document.createElement('div')
    div.innerHTML = '<div><a href="javascript:alert(1)">x</a></div>'
    expect(htmlToMd(div)).toBe('x')
  })
  test('htmlToPlainText drops the URL, keeps the text', () => {
    const div = document.createElement('div'); div.innerHTML = mdToHtml('see [docs](https://e.com) here')
    expect(htmlToPlainText(div)).toBe('see docs here')
  })
  test('idempotent through two cycles', () => {
    const md = 'a [b](https://e.com) c'
    expect(roundTrip(roundTrip(md))).toBe(md)
  })

  // The mark passes (bold/italic/…) run on the link text INSIDE the link
  // callback and the whole <a>…</a> is frozen in one placeholder, so a
  // marker inside link text can never pair with one after the link.
  test('**bold** and *em* inside link text still format', () => {
    const html = mdToHtml('[**b** and *i*](https://e.com)')
    const probe = document.createElement('div'); probe.innerHTML = html
    const a = probe.querySelector('a')!
    expect(a.querySelector('strong')!.textContent).toBe('b')
    expect(a.querySelector('em')!.textContent).toBe('i')
  })
  test('a marker after a link no longer straddles the link text — round-trips AND is idempotent', () => {
    const md = 'see [2*3](https://e.com/m) *later*'
    expect(roundTrip(md)).toBe(md)
    expect(roundTrip(roundTrip(md))).toBe(md)
    const html = mdToHtml(md)
    const probe = document.createElement('div'); probe.innerHTML = html
    expect(probe.querySelector('a')!.textContent).toBe('2*3')
    expect(probe.querySelector('em')!.textContent).toBe('later')
  })
  test('a ref chip inside link text resolves (not left as a raw placeholder)', () => {
    // The terminal splice order is LINK -> REF -> CODE precisely so a REF
    // token sitting inside the frozen <a>…</a> is resolved after the link is
    // spliced back. (The HTML parser splits the resulting nested <a> into
    // siblings — an inherent nested-anchor limitation — so assert on the
    // string and the top-level chip, not on DOM nesting.)
    const html = mdToHtml('[see @[Ana](person:abc-1) here](https://e.com)')
    expect(html).toContain('<a href="https://e.com"')
    expect(html).toContain('<a class="ref" data-ref="person:abc-1"')
    expect(html).toContain('@Ana')
    expect(/[-]/.test(html)).toBe(false) // no leftover placeholder tokens
    const probe = document.createElement('div'); probe.innerHTML = html
    expect(probe.querySelector('a.ref')!.getAttribute('data-ref')).toBe('person:abc-1')
  })
  test('a `code` span inside link text renders', () => {
    const html = mdToHtml('[run `npm test`](https://e.com)')
    const probe = document.createElement('div'); probe.innerHTML = html
    const a = probe.querySelector('a[href]')!
    expect(a.querySelector('code')!.textContent).toBe('npm test')
  })
  test('a balanced-paren URL round-trips (href and getMd)', () => {
    const md = '[x](https://en.wikipedia.org/wiki/Foo_(bar))'
    const probe = document.createElement('div'); probe.innerHTML = mdToHtml(md)
    expect(probe.querySelector('a')!.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(roundTrip(md)).toBe(md)
  })
  test('a query-string URL round-trips (href and getMd)', () => {
    const md = '[x](https://e.com/s?a=1&b=2)'
    const probe = document.createElement('div'); probe.innerHTML = mdToHtml(md)
    expect(probe.querySelector('a')!.getAttribute('href')).toBe('https://e.com/s?a=1&b=2')
    expect(roundTrip(md)).toBe(md)
  })
})

describe('blockquote', () => {
  const roundTrip = (md: string) => {
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    return htmlToMd(div)
  }
  test('single line renders <blockquote> and round-trips', () => {
    expect(mdToHtml('> a quote')).toBe('<blockquote>a quote</blockquote>')
    expect(roundTrip('> a quote')).toBe('> a quote')
  })
  test('consecutive > lines merge into one blockquote, <br>-joined', () => {
    expect(mdToHtml('> line one\n> line two')).toBe('<blockquote>line one<br>line two</blockquote>')
    expect(roundTrip('> line one\n> line two')).toBe('> line one\n> line two')
  })
  test('a bare > line is a blank line inside the quote', () => {
    expect(roundTrip('> a\n>\n> b')).toBe('> a\n>\n> b')
    expect(mdToHtml('> a\n>\n> b')).toBe('<blockquote>a<br><br>b</blockquote>')
  })
  test('blockquote closes an open list first', () => {
    expect(mdToHtml('- item\n> quote')).toBe('<ul><li>item</li></ul><blockquote>quote</blockquote>')
  })
  test('quote directly before and after a heading', () => {
    expect(roundTrip('> q\n# H\n> q2')).toBe('> q\n# H\n> q2')
  })
  test('inline formatting and refs work inside a quote', () => {
    const html = mdToHtml('> see **bold** and @[Ana](person:x)')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('data-ref="person:x"')
    expect(roundTrip('> see **bold** and @[Ana](person:x)')).toBe('> see **bold** and @[Ana](person:x)')
  })
  test('htmlToPlainText prefixes quote lines with "> "', () => {
    const div = document.createElement('div'); div.innerHTML = mdToHtml('> a\n> b')
    expect(htmlToPlainText(div)).toBe('> a\n> b')
  })
  test('idempotent through two cycles', () => {
    const md = '> a\n> b'
    expect(roundTrip(roundTrip(md))).toBe(md)
  })

  // A blockquote with block-level children — <blockquote><div>a</div>
  // <div>b</div></blockquote> from Chromium's execCommand, or
  // <blockquote><p>a</p><p>b</p></blockquote> pasted off a web page / email
  // — is now handled directly by htmlToMd's blockquote branch: it recurses
  // through htmlToMd for that shape so each child block keeps its own quoted
  // line, instead of merging them into one run-on line. The editor's
  // toggleBlockquote() still normalizes <div>/<p> children to <br>-separated
  // inline content before getMd() runs, but htmlToMd no longer depends on it.
  test('htmlToMd splits a <div>-built blockquote into one quoted line per child', () => {
    const container = document.createElement('div')
    container.innerHTML = '<blockquote><div>a</div><div>b</div></blockquote>'
    expect(htmlToMd(container)).toBe('> a\n> b')
  })
  test('htmlToMd splits a <p>-built blockquote (web-page / email paste) into one quoted line per child', () => {
    const container = document.createElement('div')
    container.innerHTML = '<blockquote><p>a</p><p>b</p></blockquote>'
    expect(htmlToMd(container)).toBe('> a\n> b')
  })
  test('htmlToPlainText splits a <p>-built blockquote into one "> "-prefixed line per child', () => {
    const container = document.createElement('div')
    container.innerHTML = '<blockquote><p>a</p><p>b</p></blockquote>'
    expect(htmlToPlainText(container)).toBe('> a\n> b')
  })
  test('a blockquote mixing bare text and a <div> child keeps each on its own quoted line', () => {
    const container = document.createElement('div')
    container.innerHTML = '<blockquote>intro<div>a</div><div>b</div></blockquote>'
    expect(htmlToMd(container)).toBe('> intro\n> a\n> b')
  })
  test('the mdToHtml <br>-joined blockquote shape is untouched — round-trips and stays idempotent', () => {
    expect(roundTrip('> a\n>\n> b')).toBe('> a\n>\n> b')
    expect(roundTrip(roundTrip('> a\n>\n> b'))).toBe('> a\n>\n> b')
    const container = document.createElement('div')
    container.innerHTML = '<blockquote>a<br>b</blockquote>'
    expect(htmlToMd(container)).toBe('> a\n> b')
  })
})

describe('flattenNestedBlockquotes', () => {
  test('unwraps a blockquote nested inside another', () => {
    const root = document.createElement('div')
    root.innerHTML = '<blockquote>outer<blockquote>inner</blockquote></blockquote>'
    flattenNestedBlockquotes(root)
    expect(root.querySelectorAll('blockquote').length).toBe(1)
    expect(root.querySelector('blockquote')!.textContent).toBe('outerinner')
  })
  test('leaves a single well-formed blockquote untouched', () => {
    const root = document.createElement('div')
    root.innerHTML = '<blockquote>just one</blockquote>'
    flattenNestedBlockquotes(root)
    expect(root.innerHTML).toBe('<blockquote>just one</blockquote>')
  })
})
