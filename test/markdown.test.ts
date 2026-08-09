import { mdToHtml, htmlToMd, htmlToPlainText, parseRef } from '../src/core/markdown'

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
