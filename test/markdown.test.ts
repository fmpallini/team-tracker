import { mdToHtml, htmlToMd, parseRef } from '../src/core/markdown'

const roundTrip = (md: string) => {
  const div = document.createElement('div')
  div.innerHTML = mdToHtml(md)
  return htmlToMd(div)
}

test('inline formats round-trip', () => {
  const md = 'a **b** *i* <u>u</u> ~~s~~ fim'
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
