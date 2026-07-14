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
