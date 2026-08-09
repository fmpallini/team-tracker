# Muted "was a reference" marker on unlink — design

## Problem

`unlinkRefsInTeam`/`unlinkRefsInText` (`core/refs.ts`) rewrite `@[Label](kind:id)`
mentions back to bare `Label` plain text when the referenced item is deleted
(single-item delete in people-tree.ts/action-items.ts/milestones.ts/risks.ts,
cross-team move in card-transfer.ts, and cross-team purge in
core/cleanup.ts). Once rewritten, that text is indistinguishable from any
other prose in the note — there's no visual signal that it used to point at
something, or that the something is now gone.

## Solution

A new single-tilde inline markdown marker, `~Label~`, produced only by the
delete/purge unlink path (not the cross-team move path — see Scope below).
Rendered as muted italic text with no click target:

```css
.tt-unlinked-ref { font-style: italic; color: var(--muted); }
```

No tooltip in v1 — `core/markdown.ts` has no locale/`t()` threading today,
and wiring one in just for one hover string is out of proportion to this
feature. Can be added later as a follow-up if wanted.

## Scope

Only the delete/purge unlink path gets the marker:
- `people-tree.ts`, `action-items.ts` (single delete + `clearZone` bulk
  delete), `milestones.ts`, `risks.ts` — via `unlinkRefsInTeam`.
- `core/cleanup.ts`'s cross-team purge — also via `unlinkRefsInTeam`.

The cross-team move path (`card-transfer.ts`'s `stripAllRefs`, used when a
card moves to another team) is explicitly **not** touched — the target item
still exists, just outside the mention's new team, so nothing was lost.
`stripAllRefs` keeps stripping to bare plain text exactly as it does today.

## Markdown syntax

`~Label~` — single tilde, distinct from the existing `~~strike~~` (double
tilde, untouched). Not a syntax users are expected to type themselves, but
since `mdToHtml`'s inline parser is shared across all rendering, typing bare
`~word~` by hand produces the same muted-italic rendering — the same class
of collision `**bold**`/`~~strike~~`/`*italic*` already accept today.

## Title sanitization (`core/refs.ts`)

Before wrapping, every character `mdToHtml`'s `inline()` parser treats
specially is replaced with `_`, so a title can never reactivate formatting
or spoof another mention once wrapped:

```ts
// Characters mdToHtml's inline() parser treats specially — sanitized so a
// title can never reactivate markdown formatting (or spoof another mention)
// once wrapped as a plain former-reference marker.
const MD_SPECIAL_CHARS = /[*~<>@[\]()]/g

function sanitizeForUnlinkMarker(title: string): string {
  return title.replace(MD_SPECIAL_CHARS, '_')
}
```

Covers: `*` (bold/italic), `~` (strike, and our own marker's own
delimiter), `<`/`>` (the `&lt;u&gt;`→`<u>` underline escape-hatch), and
`@`/`[`/`]`/`(`/`)` (ref-mention syntax — replacing any one of these breaks
the combination `refPattern()` requires, so all five are covered
individually rather than trying to match the exact mention shape).

Block-level markers (`#` heading, `-`/`1.` list markers) are only checked at
the very start of a line (`^` anchors in `render()`'s per-line dispatch).
Since the wrapped output always starts with a literal `~`, a title that
happens to be a former line's *entire* content (e.g. a daily note that was
just `@[Fix bug](action:a1)`) can never spuriously become a heading or list
item after unlink — the leading `~` already blocks that regardless of the
title's own content. No separate handling needed for block-level markers.

## `unlinkWithPattern` (`core/refs.ts`)

```ts
function unlinkWithPattern(text: string, re: RegExp, prefixLen: number, titles: ReadonlyMap<string, string>): string {
  return text.replace(re, (whole: string, _label: string, ref: string) => {
    const title = titles.get(ref.slice(prefixLen))
    return title !== undefined ? `~${sanitizeForUnlinkMarker(title)}~` : whole
  })
}
```

`unlinkRefsInText`/`unlinkRefsInTeam`'s signatures are unchanged (already
take `id → currentTitle` maps from the prior rename-then-delete fix).

## Rendering (`core/markdown.ts`)

New rule in `inline()`, added *after* the existing `~~([^~]+)~~` strike
rule (so real strikethrough is fully consumed first — no bare `~~` pairs
remain, so a following `~([^~]+)~` rule only ever matches genuine
single-tilde spans):

```ts
out = out.replace(/~([^~]+)~/g, '<span class="tt-unlinked-ref">$1</span>')
```

## Round-trip (`core/markdown.ts`'s `inlineMd`)

`inlineMd`'s tag switch currently has no case for `span`, so it falls to
`default: return kids()` — which would silently drop the marker (output
just the bare label) the next time a note containing one is re-rendered and
saved through the rich editor, even without the user touching that part of
the text. Add an explicit case:

```ts
case 'span':
  return node.classList.contains('tt-unlinked-ref') ? `~${kids()}~` : kids()
```

## Search (`core/search.ts`'s `stripMd`)

Add alongside the existing strike-stripping line, so search snippets and
backlink text show the plain label, not tildes:

```ts
l = l.replace(/~([^~]+)~/g, '$1')
```

Placed after the existing `~~([^~]+)~~` line for the same reason as the
render-side ordering above.

No changes needed to `inlineText`/`htmlToPlainText` ("copy without
formatting") — it already drops all tags/markup generically regardless of
tag name, so a `<span class="tt-unlinked-ref">` is stripped to its bare
label the same as `<strong>`/`<em>`/`<s>` already are.

## Known limitation

None remaining for markdown re-injection — the sanitization step closes
the collision gap entirely. The one accepted cosmetic side effect: a title
containing `*`, `~`, `<`, `>`, `@`, `[`, `]`, or `(`/`)` shows as `_` in the
muted marker text (e.g. an action item titled "Fix <script> tag" becomes
`~Fix _script_ tag~`, rendering as *Fix _script_ tag*). Rare in practice for
real titles; accepted as consistent with this parser's existing
lightweight-markdown limitations (no escaping mechanism exists anywhere in
this markdown dialect today).

## Testing

- `test/refs.test.ts` — update existing unlink assertions to expect
  `~Label~` instead of bare `Label`; new case(s) for sanitization (title
  containing `*`, `~`, `@[...]`-shaped text).
- `test/cleanup.test.ts` — update the three regression tests added for the
  purge-unlink fix to expect the tilde-wrapped form.
- `test/markdown.test.ts` — new cases: `~Label~` → muted span on render;
  round-trip (HTML → md) preserves the marker unchanged.
- `test/search.test.ts` — new case confirming a note containing
  `~Label~` produces a snippet with the plain label, no tildes.
- `test/people-tree.test.ts`/action-items/milestones/risks — spot-check one
  existing delete-unlink test per module still passes with the new wrapped
  output (most already assert on the resulting text, just need the
  expectation updated).
