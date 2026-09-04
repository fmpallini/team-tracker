// Language-agnostic heuristic highlighter for fenced code blocks. There is
// no language tag to work from (mdToHtml discards it, htmlToMd emits bare
// fences), so this colours by token *shape* — comments, strings, numbers —
// plus one keyword set shared across the mainstream C-family / scripting
// languages. It never claims a language, so it can never be "wrong for the
// language"; the worst case is a missed or spurious keyword tint.
//
// Output is HTML: the source is escaped exactly as core/markdown.ts's esc()
// does (including stripping the U+E000–U+E005 Private-Use-Area code points
// inline() reserves for its own placeholder tokens), then token runs are
// wrapped in `<span class="hl-…">`. Tokenising happens on the RAW text and
// each slice is escaped as it is emitted, so an HTML entity produced by
// escaping can never collide with the keyword scan.

const KEYWORDS = new Set(
  (
    'if else elif for while do switch case default break continue return yield ' +
    'await async function fn func def lambda class struct enum interface trait impl ' +
    'type const let var val final static public private protected export import from ' +
    'package namespace use using new delete this self super try catch except finally ' +
    'throw raise defer go select match when where and or not in is nil null none ' +
    'true false void print echo'
  ).split(' '),
)

const esc = (s: string): string =>
  s
    .replace(/[\uE000-\uE005]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

// Ordered alternation: block comment, line comment (not the `//` in a
// `://` scheme), `#` comment (only at line start or after whitespace, so a
// CSS `#fff` mid-value is left alone), then string literals (each allows an
// unterminated run to end of line so a half-typed line still colours), then
// a numeric literal (`\b\d[\w.]*` covers `0xFF`, `3.14`, `1e9`).
const TOKEN =
  /(\/\*[\s\S]*?\*\/)|((?<!:)\/\/[^\n]*)|((?<=^|[ \t])#[^\n]*)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\w.]*)/gm

const IDENT = /\b[A-Za-z_][A-Za-z0-9_]*\b/g

function highlightPlain(raw: string): string {
  return esc(raw).replace(IDENT, (w) => (KEYWORDS.has(w) ? `<span class="hl-kw">${w}</span>` : w))
}

/**
 * Renders `src` (the literal text of one fenced code block) as escaped HTML
 * with `hl-com` / `hl-str` / `hl-num` / `hl-kw` token spans. Deterministic
 * and side-effect-free — the editor re-runs it whenever the caret leaves a
 * code block, and `preLines()` strips the spans back out on the way to
 * markdown, so nothing here reaches storage.
 */
export function highlightCode(src: string): string {
  let out = ''
  let last = 0
  for (const m of src.matchAll(TOKEN)) {
    const i = m.index
    const full = m[0]
    out += highlightPlain(src.slice(last, i))
    const cls =
      m[1] !== undefined || m[2] !== undefined || m[3] !== undefined
        ? 'hl-com'
        : m[4] !== undefined
          ? 'hl-str'
          : 'hl-num'
    out += `<span class="${cls}">${esc(full)}</span>`
    last = i + full.length
  }
  return out + highlightPlain(src.slice(last))
}
