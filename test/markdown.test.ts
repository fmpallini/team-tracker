import { unlinkRefsInText } from '../src/core/refs'
import { parseImageLine } from '../src/core/image-ref'
import { mdToHtml, htmlToMd, htmlToPlainText, parseRef, safeHref, unwrapBlockContainers, convertWordLists, flattenNestedHeadings, flattenNestedBlockquotes, demoteHeadings, demoteBlockquotes, preLines } from '../src/core/markdown'

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
  // The outer ** pair cannot close around the inner *b*, so it is literal text:
  // it is written escaped, shows exactly as before, and a second save is a no-op.
  const md = '**a*b*c** e *i* fim'
  const saved = roundTrip(md)
  expect(saved).toBe('\\*\\*a*b*c\\*\\* e *i* fim')
  expect(mdToHtml(saved)).toBe(mdToHtml(md))
  expect(roundTrip(saved)).toBe(saved)
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

test('ordered items keep an ascending written number, so a deliberate gap and <ol start=N> both survive', () => {
  expect(roundTrip('5. a\n6. b\n7. c')).toBe('5. a\n6. b\n7. c') // start at 5
  expect(roundTrip('3. a\n5. b')).toBe('3. a\n5. b') // deliberate gap (also covered above)
})

test('ordered items with a non-advancing written number are renumbered "previous + 1"', () => {
  // The shape a paste produces when list levels past the 4-level cap collapse
  // onto one frame, each rendered "1." by renderListMd's per-list counter.
  expect(roundTrip('1. a\n1. b\n1. c')).toBe('1. a\n2. b\n3. c')
})

test('a Google-Docs ordered list deeper than 4 levels flattens to level 4 with sequential numbers', () => {
  // GDoc shape: each deeper <ol> is a sibling of the <li> it belongs under.
  const div = document.createElement('div')
  div.innerHTML =
    '<ol><li><p>one</p></li>' +
    '<ol><li><p>two</p></li>' +
    '<ol><li><p>three</p></li>' +
    '<ol><li><p>four</p></li>' +
    '<ol><li><p>five</p></li>' +
    '<ol><li><p>six</p></li></ol></ol></ol></ol></ol></ol>'
  unwrapBlockContainers(div)
  const md = htmlToMd(div)
  // levels 5 and 6 clamp onto level 4, sharing its <ol>
  expect(md).toBe('1. one\n  1. two\n    1. three\n      1. four\n      1. five\n      1. six')
  // and mdToHtml renumbers that collapsed frame 1,2,3 rather than 1,1,1
  const rebuilt = document.createElement('div')
  rebuilt.innerHTML = mdToHtml(md)
  expect(htmlToMd(rebuilt)).toBe('1. one\n  1. two\n    1. three\n      1. four\n      2. five\n      3. six')
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

  // Google Docs appends a bare <br> at the end of its <b id="docs-internal-guid">
  // wrapper. That <br> is not a block tag, so an "every child is block" test
  // rejected the whole wrapper — it stayed, htmlToMd saw one non-block child,
  // and the entire paste (heading, list, nesting, per-item bold) collapsed to
  // a single run-on line. The <br> is content-free and blocks self-delimit,
  // so it is ignored for the decision and dropped on unwrap.
  test('a trailing <br> among block children does not stop the wrapper unwrapping', () => {
    const div = document.createElement('div')
    div.innerHTML = '<b style="font-weight:normal" id="docs-internal-guid-x"><p>line1</p><p>line2</p><br></b>'
    unwrapBlockContainers(div)
    expect(htmlToMd(div)).toBe('line1\nline2')
  })

  test('a <br> between blocks in the wrapper is dropped, blocks still split', () => {
    const div = document.createElement('div')
    div.innerHTML = '<span><h2>Head</h2><br><p>body</p></span>'
    unwrapBlockContainers(div)
    expect(htmlToMd(div)).toBe('## Head\nbody')
  })

  test('a wrapper whose only children are <br>s is not treated as a block container', () => {
    const div = document.createElement('div')
    div.innerHTML = '<span>text<br><br></span>'
    unwrapBlockContainers(div)
    // left alone: htmlToMd reads it as one inline blob
    expect(div.querySelector('span')).not.toBeNull()
  })

  test('a <ul>/<ol> child of the wrapper is hoisted intact, not with its <li>s buried in the re-wrap', () => {
    const div = document.createElement('div')
    div.innerHTML = '<i><p>intro</p><ul><li>a</li><li>b</li></ul></i>'
    unwrapBlockContainers(div)
    // <p> takes the wrapper's italic per-block; the list keeps its structure
    expect(htmlToMd(div)).toBe('*intro*\n- a\n- b')
  })

  test('a full Google-Docs paste — heading, nested bullet list, per-item bold/italic, link — keeps its structure', () => {
    const div = document.createElement('div')
    div.innerHTML =
      '<b style="font-weight:normal" id="docs-internal-guid-x">' +
      '<h1><span style="font-weight:400">Vamos la</span></h1>' +
      '<ul>' +
      '<li><p role="presentation"><span>Aqui tenho uma lista</span></p></li>' +
      '<ul>' +
      '<li><p role="presentation"><span style="font-weight:700;font-style:italic">Com bullets</span></p></li>' +
      '<li><p role="presentation"><a href="http://www.g1.com.br"><span>G1</span></a></p></li>' +
      '</ul>' +
      '<li><p role="presentation"><span>Teste</span></p></li>' +
      '</ul><br></b>'
    unwrapBlockContainers(div)
    expect(htmlToMd(div)).toBe(
      '# Vamos la\n' +
        '- Aqui tenho uma lista\n' +
        '  - ***Com bullets***\n' +
        '  - [G1](http://www.g1.com.br)\n' +
        '- Teste'
    )
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

  // A heading on a list item never round-trips (renderListMd flattens it), so
  // headings on list items aren't a real feature — but Chromium's formatBlock
  // wraps one *inside the <li>* on Ctrl+1/2/3, and the old "outer heading
  // wins" rule then trapped the item: a second Ctrl+2 kept the stale <h1>, and
  // the ¶ button (a <p>/<div> nested in the <h1>) couldn't dislodge it either.
  // Any heading inside an <li> is now dissolved.
  test('a heading Chromium wrapped inside a list item is dissolved', () => {
    const div = document.createElement('div')
    div.innerHTML = '<ul><li>parent<h1><ul><li>child</li></ul></h1></li></ul>'
    flattenNestedHeadings(div)
    expect(div.innerHTML).toBe('<ul><li>parent<ul><li>child</li></ul></li></ul>')
  })

  test('the ¶ button can escape a nested-list-item heading (<p> nested in the <h1>)', () => {
    const div = document.createElement('div')
    div.innerHTML = '<ul><li>parent<h1><p><ul><li>child</li></ul></p></h1></li></ul>'
    flattenNestedHeadings(div)
    expect(div.querySelectorAll('h1,h2,h3')).toHaveLength(0)
    expect(htmlToMd(div)).toBe('- parent\n  - child')
  })

  test('changing heading level on a list item (Ctrl+1 then Ctrl+2) leaves no heading', () => {
    const div = document.createElement('div')
    div.innerHTML = '<ul><li>parent</li></ul>'
    // Chromium nests the new <h2> *inside* the existing <h1>, all inside the
    // <li>; innerHTML can't express <h1><h2>, so build it via the DOM API.
    const li = div.querySelector('li')!
    const h1 = document.createElement('h1')
    const h2 = document.createElement('h2')
    h2.innerHTML = '<ul><li>child</li></ul>'
    h1.appendChild(h2)
    li.appendChild(h1)
    flattenNestedHeadings(div)
    expect(div.querySelectorAll('h1,h2,h3')).toHaveLength(0)
    expect(htmlToMd(div)).toBe('- parent\n  - child')
  })

  test('a top-level heading wrapping a whole list is still kept (flat-list Ctrl+1)', () => {
    const div = document.createElement('div')
    div.innerHTML = '<h1><ul><li>only item</li></ul></h1>'
    flattenNestedHeadings(div)
    expect(div.innerHTML).toBe('<h1><ul><li>only item</li></ul></h1>')
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

  test('demoteBlockquotes unwraps a blockquote the range touches into a plain <div>', () => {
    const root = mount('<blockquote>quoted line</blockquote>')
    demoteBlockquotes(root, selectAll(root))
    expect(root.querySelector('blockquote')).toBeNull()
    expect(root.innerHTML).toBe('<div>quoted line</div>')
    expect(root.textContent).toBe('quoted line')
    root.remove()
  })

  test('a two-line <br> blockquote demotes to one <div> — break kept, no blank line', () => {
    const root = mount('<blockquote>a<br>b</blockquote>')
    demoteBlockquotes(root, selectAll(root))
    expect(root.querySelector('blockquote')).toBeNull()
    expect(root.children).toHaveLength(1)
    expect(root.children[0]!.tagName).toBe('DIV')
    expect(htmlToMd(root)).toBe('a\nb')
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
    expect(safeHref('https://e.com/a b')).toBeNull()
    expect(safeHref('https://e.com/x' + String.fromCharCode(127))).toBeNull()
  })
})

describe('backticks are plain text (this app has no inline-code syntax)', () => {
  const roundTrip = (md: string) => {
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    return htmlToMd(div)
  }
  test('`text` is left literal — no <code>, and it round-trips unchanged', () => {
    const html = mdToHtml('run `npm test` now')
    expect(html).not.toContain('<code>')
    expect(html).toContain('`npm test`')
    expect(roundTrip('run `npm test` now')).toBe('run `npm test` now')
  })
  test('markdown inside backticks IS now parsed (no freeze)', () => {
    expect(mdToHtml('see `**bold**`')).toContain('<strong>bold</strong>')
  })
  test('a stray <code> from a paste degrades to plain text on the way out', () => {
    const div = document.createElement('div')
    div.innerHTML = '<div>run <code>x</code> now</div>'
    expect(htmlToMd(div)).toBe('run x now')
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
  test('the anchor carries a title with the destination URL (shown on hover)', () => {
    const probe = document.createElement('div')
    probe.innerHTML = mdToHtml('[label](https://example.com/deep/path)')
    expect(probe.querySelector('a')!.getAttribute('title')).toBe('https://example.com/deep/path')
  })
  test('when a link hint is supplied, the title adds it on a second line', () => {
    const probe = document.createElement('div')
    probe.innerHTML = mdToHtml('[label](https://e.com)', undefined, undefined, 'Ctrl+click to open')
    expect(probe.querySelector('a')!.getAttribute('title')).toBe('https://e.com\nCtrl+click to open')
  })
  test('the title shows the URL unescaped (a & is not doubled into &amp;)', () => {
    const probe = document.createElement('div')
    probe.innerHTML = mdToHtml('[x](https://e.com/?a=1&b=2)')
    expect(probe.querySelector('a')!.getAttribute('title')).toBe('https://e.com/?a=1&b=2')
  })
  test('the title attribute does not survive the round trip (regenerated each render)', () => {
    expect(roundTrip('[x](https://e.com)')).toBe('[x](https://e.com)')
  })
  test('formatting inside link text is preserved', () => {
    const html = mdToHtml('[**bold** text](https://e.com)')
    expect(html).toContain('<strong>bold</strong>')
    expect(roundTrip('[**bold** text](https://e.com)')).toBe('[**bold** text](https://e.com)')
  })
  test('disallowed schemes never become a link; the whole [text](target) stays as inert literal text', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '  javascript:alert(1)', 'java\tscript:alert(1)']) {
      const html = mdToHtml(`click [here](${bad}) now`)
      const probe = document.createElement('div'); probe.innerHTML = html
      expect(probe.querySelector('a')).toBeNull()
      expect(probe.querySelector('script')).toBeNull()
      expect(probe.textContent).toBe(`click [here](${bad}) now`)
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
    const saved = 'see [2\\*3](https://e.com/m) *later*' // the * in the link text is literal, so it is written escaped
    expect(roundTrip(md)).toBe(saved)
    expect(roundTrip(saved)).toBe(saved)
    const html = mdToHtml(md)
    const probe = document.createElement('div'); probe.innerHTML = html
    expect(probe.querySelector('a')!.textContent).toBe('2*3')
    expect(probe.querySelector('em')!.textContent).toBe('later')
  })
  test('a ref chip inside link text resolves (not left as a raw placeholder)', () => {
    // The terminal splice order is LINK -> REF precisely so a REF token
    // sitting inside the frozen <a>…</a> is resolved after the link is
    // spliced back. (The HTML parser splits the resulting nested <a> into
    // siblings — an inherent nested-anchor limitation — so assert on the
    // string and the top-level chip, not on DOM nesting.)
    const html = mdToHtml('[see @[Ana](person:abc-1) here](https://e.com)')
    expect(html).toContain('<a href="https://e.com"')
    expect(html).toContain('<a class="ref" data-ref="person:abc-1"')
    expect(html).toContain('@Ana')
    expect(/[\uE000-\uE005]/.test(html)).toBe(false) // no leftover placeholder tokens
    const probe = document.createElement('div'); probe.innerHTML = html
    expect(probe.querySelector('a.ref')!.getAttribute('data-ref')).toBe('person:abc-1')
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

  // Regression for C1: a forged inline()-placeholder token (PUA U+E000–U+E005)
  // smuggled into a link URL used to survive safeHref and get frozen into the
  // <a href="…">, where the terminal REF/LINK splice passes (which now run
  // AFTER the link splice) rescanned it and injected chip/anchor HTML — the
  // literal `"` in that HTML broke out of the href and stripped `rel`. Fixed
  // by stripping U+E000–U+E005 in esc() so the tokens are unforgeable. Each
  // of these asserts: no chip/anchor HTML lands inside an href, `rel` stays
  // intact, and the URL renders as the literal text with the PUA chars
  // removed.
  describe('a forged placeholder token in a link URL cannot break out of the href', () => {
    const hrefOf = (html: string) => {
      const probe = document.createElement('div'); probe.innerHTML = html
      return probe.querySelector('a[href]')!.getAttribute('href')!
    }
    test('forged REF token in the URL', () => {
      const html = mdToHtml('[x](https://e.com/\uE0000\uE001) @[y](person:abc)')
      const href = hrefOf(html)
      expect(href).toBe('https://e.com/0')
      expect(href).not.toContain('<a class="ref"')
      expect(href).not.toContain('<')
      const probe = document.createElement('div'); probe.innerHTML = html
      const link = probe.querySelector('a[href]')!
      expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow')
      // the real ref still renders as its own chip, elsewhere
      expect(html).toContain('<a class="ref" data-ref="person:abc"')
    })
    test('a U+E002/E003 PUA pair in the URL is stripped, not smuggled through', () => {
      const html = mdToHtml('[x](https://e.com/\uE0020\uE003)')
      const href = hrefOf(html)
      expect(href).toBe('https://e.com/0')
      expect(href).not.toContain('<')
      const probe = document.createElement('div'); probe.innerHTML = html
      expect(probe.querySelector('a[href]')!.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    })
    test('forged LINK token in the URL', () => {
      const html = mdToHtml('[x](https://e.com/\uE0040\uE005)')
      const href = hrefOf(html)
      expect(href).toBe('https://e.com/0')
      expect(href).not.toContain('<')
      const probe = document.createElement('div'); probe.innerHTML = html
      expect(probe.querySelectorAll('a[href]').length).toBe(1)
      expect(probe.querySelector('a[href]')!.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    })
    // Mirror direction (what 2250aab was vulnerable to): a forged token in a
    // ref target / @[label] text must not inject an anchor into data-ref="…".
    test('a U+E002/E003 PUA pair in a data-ref target is stripped, not smuggled', () => {
      const html = mdToHtml('@[y](person:abc' + String.fromCharCode(0xE002) + '0' + String.fromCharCode(0xE003) + ')')
      const probe = document.createElement('div'); probe.innerHTML = html
      const chip = probe.querySelector('a.ref')!
      expect(chip.getAttribute('data-ref')).toBe('person:abc0')
      expect(chip.querySelector('*')).toBeNull() // nothing smuggled into the chip
      expect(html).not.toContain('data-ref="person:abc<')
    })
    test('forged LINK token in @[label] text cannot inject an <a href> into the chip', () => {
      const html = mdToHtml('@[lbl\uE0040\uE005](person:abc) [t](https://e.com)')
      const probe = document.createElement('div'); probe.innerHTML = html
      const chip = probe.querySelector('a.ref')!
      expect(chip.getAttribute('data-ref')).toBe('person:abc')
      expect(chip.textContent).toBe('@lbl0')
      expect(chip.querySelector('a[href]')).toBeNull()
    })
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

describe('fenced code block', () => {
  const roundTrip = (md: string) => {
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    return htmlToMd(div)
  }
  test('``` fences render <pre> and round-trip', () => {
    expect(mdToHtml('```\nline one\nline two\n```')).toBe('<pre>line one\nline two</pre>')
    expect(roundTrip('```\nline one\nline two\n```')).toBe('```\nline one\nline two\n```')
  })
  test('content is literal — inner markdown / block prefixes are NOT parsed', () => {
    const html = mdToHtml('```\n# not a heading\n- not a list\n> not a quote\n**not bold**\n```')
    const probe = document.createElement('div'); probe.innerHTML = html
    expect(probe.querySelector('pre')!.textContent).toBe('# not a heading\n- not a list\n> not a quote\n**not bold**')
    expect(html).not.toContain('<h1>')
    expect(html).not.toContain('<li>')
    expect(html).not.toContain('<blockquote>')
    expect(html).not.toContain('<strong>')
  })
  test('< & > in code are escaped, not live markup', () => {
    const html = mdToHtml('```\n<img src=x onerror=y> a & b\n```')
    const probe = document.createElement('div'); probe.innerHTML = html
    expect(probe.querySelector('img')).toBeNull()
    expect(probe.querySelector('pre')!.textContent).toBe('<img src=x onerror=y> a & b')
    expect(roundTrip('```\n<img src=x onerror=y> a & b\n```')).toBe('```\n<img src=x onerror=y> a & b\n```')
  })
  test('an unclosed fence still flushes at end of input', () => {
    expect(mdToHtml('```\nstranded')).toBe('<pre>stranded</pre>')
  })
  test('an empty code block round-trips', () => {
    expect(mdToHtml('```\n```')).toBe('<pre><br></pre>')
    expect(roundTrip('```\n```')).toBe('```\n```')
  })
  test('a fence closes an open list first', () => {
    expect(mdToHtml('- item\n```\ncode\n```')).toBe('<ul><li>item</li></ul><pre>code</pre>')
  })
  test('htmlToMd serializes an edited (<br>-joined) <pre> back to ``` fences', () => {
    const container = document.createElement('div')
    container.innerHTML = '<pre>a<br>b<br>c</pre>'
    expect(htmlToMd(container)).toBe('```\na\nb\nc\n```')
  })
  test('htmlToMd flattens a <div>-lined <pre> (Chromium formatBlock artefact)', () => {
    const container = document.createElement('div')
    container.innerHTML = '<pre><div>a</div><div>b</div></pre>'
    expect(htmlToMd(container)).toBe('```\na\nb\n```')
  })
  test('htmlToPlainText drops the fences, keeps the code lines', () => {
    const div = document.createElement('div'); div.innerHTML = mdToHtml('```\na\nb\n```')
    expect(htmlToPlainText(div)).toBe('a\nb')
  })
  test('idempotent through two cycles', () => {
    const md = '```\nx = 1\ny = 2\n```'
    expect(roundTrip(roundTrip(md))).toBe(md)
  })
  test('a code block holding a ``` line round-trips (the fence grows to stay unambiguous)', () => {
    const div = document.createElement('div'); div.innerHTML = '<pre>a\n```\nb</pre>'
    const md = htmlToMd(div)
    expect(md).toBe('````\na\n```\nb\n````')
    expect(roundTrip(md)).toBe(md)
  })
  test('files already on disk parse as before: a ``` block still closes on any ```-prefixed line', () => {
    expect(mdToHtml('```\na\n```js\nb')).toBe('<pre>a</pre><div>b</div>')
  })
  // A literal "````" text line in a note saved before long fences existed:
  // with no closer of its own length anywhere after it, it is read the old
  // way (closing on any ```-prefixed line) instead of swallowing the rest of
  // the note into a code block.
  test('a 4+-backtick opener with no matching long closer parses as before', () => {
    expect(mdToHtml('````\nx\n```\nmore')).toBe('<pre>x</pre><div>more</div>')
    expect(mdToHtml('``````js\nx\n```\ny')).toBe('<pre>x</pre><div>y</div>')
  })
  test('text on the opening fence line (a language tag) is discarded', () => {
    const div = document.createElement('div'); div.innerHTML = mdToHtml('```js\nconst a = 1\n```')
    expect(div.querySelector('pre')!.textContent).toBe('const a = 1')
    expect(roundTrip('```js\nconst a = 1\n```')).toBe('```\nconst a = 1\n```')
  })

  describe('syntax highlighting', () => {
    test('keywords, strings and numbers in the code get token spans', () => {
      const html = mdToHtml('```\nconst n = 42\ns = "hi"\n```')
      expect(html).toContain('<span class="hl-kw">const</span>')
      expect(html).toContain('<span class="hl-num">42</span>')
      expect(html).toContain('<span class="hl-str">&quot;hi&quot;</span>')
    })
    test('the spans strip back out on the way to markdown', () => {
      expect(roundTrip('```\nfunction f() { return 3 }\n```')).toBe('```\nfunction f() { return 3 }\n```')
    })
    test('preLines reads through the token spans to the literal lines', () => {
      const div = document.createElement('div')
      div.innerHTML = mdToHtml('```\nif (x) return 1\ny = 2\n```')
      expect(preLines(div.querySelector('pre')!)).toEqual(['if (x) return 1', 'y = 2'])
    })
    test('a highlighted block stays literal — no real markup from angle brackets', () => {
      const div = document.createElement('div')
      div.innerHTML = mdToHtml('```\nvector<int> v; a && b\n```')
      expect(div.querySelector('pre')!.querySelector('int')).toBeNull()
      expect(div.querySelector('pre')!.textContent).toBe('vector<int> v; a && b')
    })
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

describe('emphasis markers need to hug their text (plain text with stray * ~ must not turn into formatting)', () => {
  const inner = (md: string) => mdToHtml(md).replace(/^<div>|<\/div>$/g, '')

  test.each([
    ['approximation tildes', 'Estimate ~5 min and ~10 min'],
    ['currency tildes', 'cost ~$5 to ~$10'],
    ['spaced asterisks (multiplication)', '2 * 3 * 4 = 24'],
    ['spaced double asterisks (exponent)', '2 ** 3 ** 4'],
    ['spaced double tildes', 'a ~~ b ~~ c'],
    ['a lone star with a trailing space', '* not a list'],
  ])('%s stay literal text', (_name, md) => {
    const html = inner(md)
    expect(html).not.toMatch(/<(em|strong|s|span)[ >]/)
    expect(html).toBe(md)
    // Saving writes the literal markers escaped; it shows the same and a second save is a no-op.
    const saved = roundTrip(md)
    expect(inner(saved)).toBe(html)
    expect(roundTrip(saved)).toBe(saved)
  })

  test.each([
    ['italic', '*it*', '<em>it</em>'],
    ['bold', '**bo**', '<strong>bo</strong>'],
    ['strike', '~~st~~', '<s>st</s>'],
    ['unlinked-ref marker', '~gone~', '<span class="tt-unlinked-ref">gone</span>'],
    ['multi-word italic', 'a *two words* b', 'a <em>two words</em> b'],
    ['one-character bold', '**x**', '<strong>x</strong>'],
    ['bold ending in punctuation, then a space (template label)', '**Label:** text', '<strong>Label:</strong> text'],
  ])('a well-formed %s still renders', (_name, md, expected) => {
    expect(inner(md)).toContain(expected)
    expect(roundTrip(md)).toBe(md)
  })

  test('markers padded INSIDE are not formatting; the same text padded OUTSIDE is', () => {
    expect(inner('*padded *')).not.toContain('<em>')
    expect(inner('**padded **')).not.toContain('<strong>')
    expect(inner('*padded* ok')).toContain('<em>padded</em>')
  })

  test('a pair of tildes inside a URL-ish path is no longer swallowed', () => {
    const html = inner('see https://example.com/~alice/a and ~bob/b')
    expect(html).not.toContain('tt-unlinked-ref')
    expect(html).toContain('https://example.com/~alice/a and ~bob/b')
  })

  test('the unlink-on-delete marker keeps rendering when the title had edge whitespace', () => {
    const titles = new Map([['a1', '  Fix bug  ']])
    const md = unlinkRefsInText('see @[Fix](action:a1)', 'action', titles)
    expect(md).toBe('see ~Fix bug~')
    expect(inner(md)).toContain('<span class="tt-unlinked-ref">Fix bug</span>')
  })
})

describe('whitespace at the edge of formatted text moves OUTSIDE the markers on the way out (so it re-renders)', () => {
  const toMd = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return htmlToMd(d) }
  const reload = (md: string) => toMd(mdToHtml(md))

  test.each([
    ['bold with a trailing space', '<div><strong>hello </strong>world</div>', '**hello** world'],
    ['bold with a leading space', '<div>hi<strong> there</strong></div>', 'hi **there**'],
    ['italic with both', '<div>a<em> b </em>c</div>', 'a *b* c'],
    ['strike with a trailing space', '<div><s>gone </s>now</div>', '~~gone~~ now'],
    ['unlinked marker with a trailing space', '<div><span class="tt-unlinked-ref">Fix </span>x</div>', '~Fix~ x'],
    ['nested bold+italic with a trailing space', '<div><strong><em>x </em></strong>y</div>', '***x*** y'],
  ])('%s', (_name, html, md) => {
    expect(toMd(html)).toBe(md)
    expect(reload(md)).toBe(md) // and the result is stable after a reload
  })

  test('whitespace-only formatting leaves no empty markers', () => {
    expect(toMd('<div>a<strong> </strong>b</div>')).toBe('a b')
    expect(toMd('<div>a<em></em>b</div>')).toBe('ab')
  })
})

describe('[text](target) that is not a safe link stays literal instead of losing its brackets', () => {
  test.each([
    'see [1](page 2)',
    'f(x) = a[i](y)',
    'docs [here](ftp://server/file)',
  ])('%s', (md) => {
    expect(mdToHtml(md)).not.toContain('<a ')
    // Editing the note never eats the brackets: the saved (escaped) form shows the same text and is stable.
    const saved = roundTrip(md)
    expect(mdToHtml(saved)).toBe(mdToHtml(md))
    expect(roundTrip(saved)).toBe(saved)
  })

  test('a safe link is still a link', () => {
    expect(mdToHtml('[x](https://e.com)')).toContain('<a href="https://e.com"')
    expect(roundTrip('[x](https://e.com)')).toBe('[x](https://e.com)')
  })

  test('a dangerous scheme is still never an anchor; it is shown as inert text', () => {
    const probe = document.createElement('div')
    probe.innerHTML = mdToHtml('click [here](javascript:alert(1)) now')
    expect(probe.querySelector('a')).toBeNull()
    expect(probe.textContent).toBe('click [here](javascript:alert(1)) now')
  })
})

describe('seeded round-trip fuzz (the editor rewrites the WHOLE note on every edit, so a lossy case silently mutates untouched text)', () => {
  let seed = 4242
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
  const pick = (a: string[]): string => a[Math.floor(rnd() * a.length)]!
  const words = ['alpha', 'x', 'a_b', '2', 'foo.bar', '5%', 'R$10', '#tag', '1.5', '(note)', '[ref]', 'a&b', '<tag>', '"q"', 'ünï', '→', '😀', '~3', '10~', '*', '**', '~~', '~', '---', '|', '=', '[1](page 2)', '@']
  const marked = ['**bold**', '*it*', '~~del~~', '~gone~', '<u>und</u>', '***bi***', '**a *b* c**', '[l](https://a.com/x?y=1&z=2)', '@[Ann](person:p1)']
  const line = (): string => {
    const parts = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => (rnd() < 0.3 ? pick(marked) : pick(words)))
    const s = parts.join(' ')
    const r = rnd()
    return r < 0.1 ? '# ' + s : r < 0.25 ? '- ' + s : r < 0.3 ? '> ' + s : s
  }
  const note = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, line).join('\n')

  test('md -> html -> md never drifts on later edits (idempotent after the first pass)', () => {
    const drifting: string[] = []
    for (let i = 0; i < 3000; i++) {
      const once = roundTrip(note())
      if (roundTrip(once) !== once) drifting.push(once)
    }
    expect(drifting.slice(0, 5)).toEqual([])
  })

  test('saving a note never changes what it displays', () => {
    // Literal markers are written escaped, so the markdown text may differ — but
    // the rendered note must be identical before and after a save.
    const lossy: string[] = []
    for (let i = 0; i < 3000; i++) {
      const md = note()
      if (mdToHtml(roundTrip(md)) !== mdToHtml(md)) lossy.push(md)
    }
    expect(lossy.slice(0, 5)).toEqual([])
  })
})

describe('very long single lines cannot freeze the renderer', () => {
  // The link / ref / underline passes were quadratic on "opener, no closer"
  // input: 20k of "@[" took ~0.9s and 100k took tens of seconds on the UI thread.
  test.each([
    ['@[', 100_000],
    ['[', 100_000],
    ['<u>', 100_000],
  ])('%s x %i renders in well under a second', (unit, n) => {
    const line = unit.repeat(n)
    const t0 = performance.now()
    mdToHtml(line)
    expect(performance.now() - t0).toBeLessThan(1000)
  })

  test('an over-long line is shown as plain escaped text and survives a round trip untouched', () => {
    const line = 'a <b> & **not bold** ' + 'x'.repeat(20_000)
    const html = mdToHtml(line)
    expect(html).toContain('&lt;b&gt; &amp; **not bold**')
    expect(html).not.toContain('<strong>')
    // Saved with the literal ** escaped; still over the limit, so it shows the same and stays stable.
    const saved = roundTrip(line)
    expect(saved).toContain('\\*\\*not bold\\*\\*')
    expect(mdToHtml(saved)).toBe(html)
    expect(roundTrip(saved)).toBe(saved)
  })

  test('a line just under the limit still gets full inline formatting', () => {
    const line = '**bold** [l](https://e.com) ' + 'x'.repeat(9_000)
    const html = mdToHtml(line)
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<a href="https://e.com"')
  })

  test('only the over-long line is affected; its neighbours keep their formatting', () => {
    const html = mdToHtml('**a**\n' + 'y'.repeat(20_000) + '\n**b**')
    expect(html).toContain('<strong>a</strong>')
    expect(html).toContain('<strong>b</strong>')
  })
})

describe('htmlToMd: containers holding blocks', () => {
  const md = (html: string): string => {
    const root = document.createElement('div')
    root.innerHTML = html
    return htmlToMd(root)
  }

  test('a div holding blocks keeps each block on its own line (Wikipedia shape)', () => {
    expect(md('<div><h2>History<span>[edit]</span></h2><p>Some <b>text</b></p><figure><img src="x"><figcaption>Caption</figcaption></figure><h4>Sub</h4><p>end</p></div>'))
      .toBe('## History\\[edit\\]\nSome **text**\nCaption\n### Sub\nend')
  })

  test('VS Code line divs inside one pre-styled div stay separate lines', () => {
    expect(md('<div style="white-space: pre;"><div><span>const</span> x = 1</div><div>  return y</div><div><br></div><div>}</div></div>'))
      .toBe('const x = 1\n  return y\n\n}')
  })

  test('a custom-element wrapper holding a style tag still yields its table rows (Google Sheets)', () => {
    expect(md('<google-sheets-html-origin><style>td{}</style><table><tbody><tr><td>Name</td><td>Qty</td></tr><tr><td>Ana</td><td>3</td></tr></tbody></table></google-sheets-html-origin>'))
      .toBe('Name | Qty\nAna | 3')
  })

  test('inline runs between blocks join into one line and br splits them (Slack shape)', () => {
    expect(md('<span>hello <b>world</b></span><br><span>line two</span><br><ul><li>x</li></ul>'))
      .toBe('hello **world**\nline two\n- x')
  })

  test('Outlook WordSection wrapper keeps its paragraphs apart', () => {
    expect(md('<div class="WordSection1"><p>Oi time,</p><div><p><b>From:</b> Ana</p></div><blockquote><p>original</p></blockquote></div>'))
      .toBe('Oi time,\n**From:** Ana\n> original')
  })

  test('head, title, style, script and template content never becomes text', () => {
    expect(md('<title>T</title><style>.a{}</style><div>x</div><script>y</script><template>z</template>')).toBe('x')
  })
})

describe('htmlToMd: list items holding blocks', () => {
  const md = (html: string): string => {
    const root = document.createElement('div')
    root.innerHTML = html
    return htmlToMd(root)
  }

  test('an li with two paragraphs keeps the word boundary as two sibling items', () => {
    expect(md('<ol><li><p>Then</p><p>second para</p></li><li>last</li></ol>')).toBe('1. Then\n2. second para\n3. last')
  })

  test('blocks pasted mid-item become sibling bullets, the nested list still follows', () => {
    expect(md('<ul><li>item t<h2>Title</h2><pre>const a = 1;\nconst b = 2;</pre><div>Use it</div>ext<ul><li>sub</li></ul></li></ul>'))
      .toBe('- item t\n- Title\n- const a = 1;\n- const b = 2;\n- Use it\n- ext\n  - sub')
  })

  test('a plain li is unchanged', () => {
    expect(md('<ul><li>a <b>b</b></li></ul>')).toBe('- a **b**')
  })
})

test('plain-text copy of an li holding two paragraphs keeps them on separate lines', () => {
  const root = document.createElement('div')
  root.innerHTML = '<ul><li><p>Then</p><p>second para</p><ul><li>sub</li></ul></li></ul>'
  expect(htmlToPlainText(root)).toBe('Then\nsecond para\n  sub')
})

describe('literal text survives a save/reopen', () => {
  const nbsp = String.fromCharCode(0xa0)
  const norm = (s: string): string => s.split(nbsp).join(' ').replace(/\s+/g, ' ').trim()
  const LITERALS = [
    'price 2*3*4 = 24', '```js', '1. first step', '- dash item', '> quoted reply', '# not a heading',
    '[link](http://x.y)', '@[Ana](person:p1)', '*important*', '**really**', '~~old~~', '~5 days ~10 people', '---',
    '<u>x</u>', 'a\\*b', 'ends with \\', 'C:\\Users\\me', '  - indented dash', '\\\\server\\share',
  ]
  const build = (position: string, text: string): HTMLElement => {
    const root = document.createElement('div')
    if (position === 'list item') {
      const ul = root.appendChild(document.createElement('ul'))
      ul.appendChild(document.createElement('li')).textContent = text
    } else {
      root.appendChild(document.createElement({ line: 'div', heading: 'h2', quote: 'blockquote' }[position]!)).textContent = text
    }
    return root
  }
  const reopened = (root: HTMLElement): string => {
    const back = document.createElement('div')
    back.innerHTML = mdToHtml(htmlToMd(root))
    return norm(back.textContent ?? '')
  }

  test.each(['line', 'list item', 'heading', 'quote'])('a %s keeps every literal exactly', (position) => {
    for (const text of LITERALS) expect(reopened(build(position, text)), `${position}: ${text}`).toBe(norm(text))
  })

  test('formatting written by the editor still round-trips unchanged', () => {
    for (const md of [
      'a **b** *i* ~~s~~ <u>u</u> [l](https://a.b) @[A](person:p1) ~Old~', '# H', '- a\n  - b', '1. x', '> q', '```\ncode *x*\n```',
    ]) expect(roundTrip(md), md).toBe(md)
  })

  test('a plain line that would parse as a block is escaped at its start', () => {
    const md = (text: string): string => htmlToMd(build('line', text))
    expect(md('# x')).toBe('\\# x')
    expect(md('> x')).toBe('\\> x')
    expect(md('```js')).toBe('\\```js')
    expect(md('---')).toBe('\\---')
    expect(md('- x')).toBe('\\- x')
    expect(md('  - x')).toBe('  \\- x')
    expect(md('1. x')).toBe('1\\. x')
  })

  test('a backslash before a non-markdown character is left alone (Windows paths, regexes in prose)', () => {
    expect(mdToHtml('C:\\Users\\me')).toContain('C:\\Users\\me')
    const pre = document.createElement('div')
    pre.innerHTML = mdToHtml('```\n\\d+\\.\n```')
    expect(pre.querySelector('pre')!.textContent).toBe('\\d+\\.')
  })

  test.each([
    ['bold', '<b>C:\\ </b>rest', '**C:\\\\** rest', (d: HTMLElement) => d.querySelector('strong')],
    ['bold (nbsp, as Chromium writes a typed trailing space)', `<b>C:\\${String.fromCharCode(0xa0)}</b>rest`, '**C:\\\\** rest', (d: HTMLElement) => d.querySelector('strong')],
    ['italic', '<i>C:\\ </i>rest', '*C:\\\\* rest', (d: HTMLElement) => d.querySelector('em')],
    ['strike', '<s>C:\\ </s>rest', '~~C:\\\\~~ rest', (d: HTMLElement) => d.querySelector('s')],
    ['unlinked ref', '<span class="tt-unlinked-ref">C:\\ </span>rest', '~C:\\\\~ rest', (d: HTMLElement) => d.querySelector('.tt-unlinked-ref')],
  ])('a backslash then trailing whitespace inside %s does not swallow the closing marker', (_name, html, expected, marked) => {
    const root = document.createElement('div')
    root.innerHTML = `<div>${html}</div>`
    const md = htmlToMd(root)
    expect(md).toBe(expected)
    const back = document.createElement('div')
    back.innerHTML = mdToHtml(md)
    expect(marked(back)?.textContent).toBe('C:\\') // still formatted, backslash intact
    expect(htmlToMd(back)).toBe(md)
  })

  test('htmlToMd does not run the block-descendant query on inline leaf elements (it runs on every autosave)', () => {
    const root = document.createElement('div')
    root.innerHTML = Array.from({ length: 50 }, (_, i) => `<p>line ${i} <b>bold</b> <i>it</i> <a href="https://x.y">l</a></p>`).join('')
    const spy = vi.spyOn(Element.prototype, 'querySelector')
    htmlToMd(root)
    const blockish = spy.mock.calls.filter(([sel]) => String(sel).includes('blockquote,')).length
    spy.mockRestore()
    expect(blockish).toBe(0)
  })

  test('a text node ending in a backslash does not swallow the bold marker that follows', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div>a\\<strong>b</strong></div>'
    const md = htmlToMd(root)
    expect(md).toBe('a\\\\**b**')
    const back = document.createElement('div')
    back.innerHTML = mdToHtml(md)
    expect(back.querySelector('strong')!.textContent).toBe('b')
    expect(back.textContent).toBe('a\\b')
  })

  test('brackets inside link text do not reopen the link grammar', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div><a href="https://x.y">a[b]</a></div>'
    expect(htmlToMd(root)).toBe('[ab](https://x.y)')
  })

  test('a tilde inside an unlinked-ref label survives', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div><span class="tt-unlinked-ref">a~b</span></div>'
    const md = htmlToMd(root)
    const back = document.createElement('div')
    back.innerHTML = mdToHtml(md)
    expect(back.querySelector('.tt-unlinked-ref')!.textContent).toBe('a~b')
    expect(htmlToMd(back)).toBe(md)
  })

  test('a line over the inline-parse limit shows its text and stays stable across saves', () => {
    const text = 'x*'.repeat(6000)
    const first = htmlToMd(build('line', text))
    const back = document.createElement('div')
    back.innerHTML = mdToHtml(first)
    expect(back.textContent).toBe(text)
    expect(htmlToMd(back)).toBe(first)
  })
})

test('a code block that starts with blank lines keeps every one across saves (the HTML parser drops one leading newline after <pre>)', () => {
  const md = '```\n\n\nx\n```'
  expect(roundTrip(md)).toBe(md)
  expect(roundTrip(roundTrip(md))).toBe(md)
})

describe('convertWordLists (Word list paragraphs are <p style="mso-list:…"> with a glyph span, not <ul>)', () => {
  const bullet = (level: number, text: string): string =>
    `<p class="MsoListParagraph" style="text-indent:-18.0pt;mso-list:l0 level${level} lfo1"><!--[if !supportLists]--><span style="font-family:Symbol"><span style="mso-list:Ignore">·<span style="font:7.0pt 'Times New Roman'">&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><!--[endif]-->${text}<o:p></o:p></p>`
  const numbered = (n: number, text: string): string =>
    `<p class="MsoListParagraph" style="mso-list:l1 level1 lfo2"><![if !supportLists]><span style="mso-list:Ignore">${n}.<span style="font:7.0pt 'Times New Roman'">&nbsp;&nbsp;</span></span><![endif]>${text}</p>`
  const parse = (html: string): HTMLElement => {
    const root = document.createElement('div')
    root.innerHTML = html
    return root
  }

  test('Word bullet paragraphs become a real nested list and lose their glyph', () => {
    const root = parse(`<p class="MsoNormal">Texto <b>negrito</b></p>${bullet(1, 'Item um')}${bullet(2, 'Sub item')}${bullet(1, 'Item dois')}`)
    convertWordLists(root)
    expect(htmlToMd(root)).toBe('Texto **negrito**\n- Item um\n  - Sub item\n- Item dois')
  })

  test('Word numbered paragraphs become an ordered list', () => {
    const root = parse(`${numbered(1, 'Primeiro')}${numbered(2, 'Segundo')}`)
    convertWordLists(root)
    expect(htmlToMd(root)).toBe('1. Primeiro\n2. Segundo')
  })

  test('a numbered run that starts above 1 keeps its first number', () => {
    const root = parse(`${numbered(3, 'Terceiro')}${numbered(4, 'Quarto')}`)
    convertWordLists(root)
    expect(htmlToMd(root)).toBe('3. Terceiro\n4. Quarto')
  })

  test('non-Word HTML is left untouched', () => {
    const html = '<p style="color:red">x</p><ul><li>y</li></ul><span style="mso-list:Ignore">z</span>'
    const root = parse(html)
    convertWordLists(root)
    expect(root.innerHTML).toBe(html)
  })
})

describe('image blocks', () => {
  const ID = 'c'.repeat(32)
  const ref = (alt = 'x') => `![${alt}](img:${ID})`
  const dom = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d }

  test('an image line renders as an atomic block carrying its id and alt', () => {
    const d = dom(mdToHtml(`a\n\n${ref('my "shot"')}\n\nb`, () => 'L'))
    const block = d.querySelector('.tt-img') as HTMLElement
    expect(block.tagName).toBe('DIV')
    expect(block.getAttribute('contenteditable')).toBe('false')
    expect(block.getAttribute('data-img-id')).toBe(ID)
    expect(block.getAttribute('data-alt')).toBe('my "shot"')
    expect(block.querySelector('img')).toBeNull()
  })

  test('md -> html -> md is the identity for a spaced image', () => {
    const md = `a\n\n${ref()}\n\nb`
    expect(htmlToMd(dom(mdToHtml(md, () => 'L')))).toBe(md)
  })

  test('an image block between text blocks gets a blank line above and below', () => {
    const root = dom(`<div>a</div><div class="tt-img" data-img-id="${ID}" data-alt="x"></div><div>b</div>`)
    expect(htmlToMd(root)).toBe(`a\n\n${ref()}\n\nb`)
  })

  test('blank lines already there are not doubled', () => {
    const root = dom(`<div>a</div><div><br></div><div class="tt-img" data-img-id="${ID}" data-alt="x"></div><div><br></div><div>b</div>`)
    expect(htmlToMd(root)).toBe(`a\n\n${ref()}\n\nb`)
  })

  test('an image as the first or last block leaves no stray blank line at the ends', () => {
    expect(htmlToMd(dom(`<div class="tt-img" data-img-id="${ID}" data-alt="x"></div><div>b</div>`))).toBe(`${ref()}\n\nb`)
    expect(htmlToMd(dom(`<div>a</div><div class="tt-img" data-img-id="${ID}" data-alt="x"></div>`))).toBe(`a\n\n${ref()}`)
    expect(htmlToMd(dom(`<div class="tt-img" data-img-id="${ID}" data-alt="x"></div>`))).toBe(ref())
  })

  test('two adjacent images are separated by exactly one blank line', () => {
    const block = `<div class="tt-img" data-img-id="${ID}" data-alt="x"></div>`
    expect(htmlToMd(dom(block + block))).toBe(`${ref()}\n\n${ref()}`)
  })

  test('a hydrated block (with its <img> child) serializes the same as an empty one', () => {
    const root = dom(`<div class="tt-img" data-img-id="${ID}" data-alt="x"><img src="data:image/png;base64,AAAA" alt="x"></div>`)
    expect(htmlToMd(root)).toBe(ref())
  })

  test('a reference inside a sentence stays literal text, never a link or a block', () => {
    const html = mdToHtml(`see ${ref()} here`, () => 'L')
    expect(html).not.toContain('tt-img')
    expect(html).not.toContain('<a ')
    const md = htmlToMd(dom(html))
    expect(parseImageLine(md)).toBeNull()
    expect(htmlToMd(dom(mdToHtml(md, () => 'L')))).toBe(md)
  })

  test('safeHref refuses the img: scheme', () => {
    expect(safeHref(`img:${ID}`)).toBeNull()
  })

  test('an image-looking line inside a code fence stays code and gets no spacing', () => {
    const md = '```\n' + ref() + '\n```'
    const html = mdToHtml(md, () => 'L')
    expect(html).not.toContain('tt-img')
    expect(htmlToMd(dom(html))).toBe(md)
  })
})
