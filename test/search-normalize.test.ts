// test/search-normalize.test.ts — equivalence guard for `normalize`.
//
// `normalize` folds Latin-1 accents directly instead of going through
// `String.prototype.normalize('NFD')`, because NFD promotes an accented
// Latin-1 string to V8's two-byte representation and mark-stripping never
// demotes it — which doubled the derived copy the search cache retains (see
// test/search-memory.test.ts). NFD is still the fallback for anything the
// fold cannot handle.
//
// That is a memory optimisation, so it must be invisible: for every input,
// the folded path has to produce exactly what the plain NFD pipeline would.
// These tests compare against that pipeline directly rather than against
// hand-written expectations, so they check the property that matters rather
// than a transcription of it.
import { normalize } from '../src/core/search'

/** What `normalize` is required to be equivalent to — the whole of its old implementation. */
const reference = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

test('every single character up to U+2FFF normalizes exactly as the NFD pipeline does', () => {
  // Covers Latin-1 (folded directly), Latin Extended-A/B and the combining
  // mark blocks (fallback), and the ASCII range (fast path). Beyond this
  // range lies CJK, which no fold or decomposition touches.
  const mismatches: string[] = []
  for (let codePoint = 0; codePoint <= 0x2fff; codePoint++) {
    const char = String.fromCodePoint(codePoint)
    if (normalize(char) !== reference(char)) mismatches.push(`U+${codePoint.toString(16).padStart(4, '0')}`)
  }
  expect(mismatches).toEqual([])
})

test('accented Portuguese text normalizes exactly as the NFD pipeline does', () => {
  const samples = [
    'Reunião de ORÇAMENTO na terça',
    'Ação, análise e relatório — pendência não resolvida',
    'Migração concluída às 14h; avaliação após o café',
    'ÁÉÍÓÚÀÂÊÔÃÕÇÜ áéíóúàâêôãõçü',
  ]
  for (const sample of samples) expect(normalize(sample)).toBe(reference(sample))
})

test('letters with no canonical decomposition are left alone, as the NFD pipeline leaves them', () => {
  // The fold table is built from NFD itself precisely so these stay out of
  // it: stripping their stroke or ligature would silently widen what a
  // search matches.
  for (const char of ['Ø', 'ø', 'Æ', 'æ', 'Ð', 'ð', 'Þ', 'þ', 'ß']) {
    expect(normalize(char)).toBe(reference(char))
  }
  expect(normalize('Ø')).toBe('ø')
  expect(normalize('ß')).toBe('ß')
})

test('input that is already decomposed still loses its combining marks', () => {
  // A base letter plus a separate combining acute — no precomposed character
  // for the fold to match, so this has to reach the NFD fallback.
  const decomposed = 'reunião'
  expect(normalize(decomposed)).toBe('reuniao')
  expect(normalize(decomposed)).toBe(reference(decomposed))
})

test('a precomposed Latin-1 letter carrying a further combining mark folds both', () => {
  // 'é' followed by a combining macron: the fold handles the first, the NFD
  // fallback has to handle what is left.
  const mixed = 'café̄'
  expect(normalize(mixed)).toBe('cafe')
  expect(normalize(mixed)).toBe(reference(mixed))
})

test('accented letters outside Latin-1 normalize through the fallback', () => {
  for (const [input, expected] of [['ā', 'a'], ['ệ', 'e'], ['ŵ', 'w'], ['ǻ', 'a']] as const) {
    expect(normalize(input)).toBe(expected)
    expect(normalize(input)).toBe(reference(input))
  }
})

test('normalizing precomposed Latin-1 text preserves its character count', () => {
  // makeSnippet slices the stripped display text using an index found in the
  // normalized text, which only works while the two stay the same length.
  const sample = 'Reunião de ORÇAMENTO às três'
  expect(normalize(sample)).toHaveLength(sample.length)
})
