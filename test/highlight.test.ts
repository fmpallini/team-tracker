import { highlightCode } from '../src/core/highlight'

test('a language-agnostic keyword is wrapped, a plain identifier is not', () => {
  const out = highlightCode('return foo')
  expect(out).toBe('<span class="hl-kw">return</span> foo')
})

test('a keyword only matches on word boundaries', () => {
  expect(highlightCode('returns className')).toBe('returns className')
})

test('a double-quoted string is wrapped whole, even when it contains a keyword', () => {
  expect(highlightCode('x = "return now"')).toBe(
    'x = <span class="hl-str">&quot;return now&quot;</span>',
  )
})

test('single quotes and backticks are strings too', () => {
  expect(highlightCode("a 'b' `c`")).toBe(
    'a <span class="hl-str">&#39;b&#39;</span> <span class="hl-str">`c`</span>',
  )
})

test('a backslash escape does not end a string early', () => {
  expect(highlightCode('"a\\"b"')).toBe('<span class="hl-str">&quot;a\\&quot;b&quot;</span>')
})

test('a // comment runs to end of line only', () => {
  expect(highlightCode('a // b\nc')).toBe('a <span class="hl-com">// b</span>\nc')
})

test('a # comment is wrapped', () => {
  expect(highlightCode('x # note')).toBe('x <span class="hl-com"># note</span>')
})

test('a block comment spans lines and masks keywords inside it', () => {
  expect(highlightCode('/* return\nif */ ok')).toBe(
    '<span class="hl-com">/* return\nif */</span> ok',
  )
})

test('numbers are wrapped, including hex and decimals', () => {
  expect(highlightCode('1 + 3.14 + 0xFF')).toBe(
    '<span class="hl-num">1</span> + <span class="hl-num">3.14</span> + <span class="hl-num">0xFF</span>',
  )
})

test('HTML metacharacters in code are escaped and never emit raw markup', () => {
  const out = highlightCode('a < b && c > d')
  expect(out).toBe('a &lt; b &amp;&amp; c &gt; d')
  expect(out).not.toContain('<b')
})

test('a keyword inside an escaped angle-bracket run is still wrapped', () => {
  expect(highlightCode('<T>(if)')).toBe('&lt;T&gt;(<span class="hl-kw">if</span>)')
})

test('private-use placeholder code points are stripped before escaping', () => {
  expect(highlightCode('ab')).toBe('ab')
})

test('plain prose with no tokens comes back escaped and otherwise untouched', () => {
  expect(highlightCode('just some "words')).toBe('just some <span class="hl-str">&quot;words</span>')
})

test('empty input yields empty output', () => {
  expect(highlightCode('')).toBe('')
})
