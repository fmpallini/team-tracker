# Nested (multi-level) lists + natural Tab/Shift+Tab indentation

Date: 2026-07-21
Modules: `src/core/markdown.ts`, `src/ui/editor.ts`

## Problem

Two related issues in the WYSIWYG editor's Tab/Shift+Tab handling
(`src/ui/editor.ts`, added in the 2026-07-20 UX-polish batch as a
deliberately scoped "safe same-line indent"):

1. **Shift+Tab caret jump.** After stripping leading indent, the caret is
   hardcoded to the start of the block (`onKeydown`'s Shift+Tab branch sets
   `r.setStart(ctx.block, 0)` unconditionally) instead of staying near where
   it was. Pressing Shift+Tab anywhere but the very start of a line yanks the
   caret to the beginning, which reads as "Shift+Tab only works at the
   beginning."
2. **No real nested lists.** `core/markdown.ts`'s `mdToHtml`/`htmlToMd` only
   ever handle one flat list — `htmlToMd` walks `:scope > li` directly and
   has no case for a nested `<ul>/<ol>` inside an `<li>`, so today's Tab
   inside a bullet just inserts/removes literal non-breaking-space characters
   in the item's text (a visual-only hack). There's no way to actually nest
   a sub-bullet under a bullet, which is the behavior users expect from Tab
   in a bulleted/numbered list in any real text editor.

This was an explicit, documented scope cut at the time ("Real nested
sub-bullets are explicitly out of scope for this task"). This spec reopens
it.

## Design

### 1. Shift+Tab caret-jump fix (paragraphs/headings)

In `onKeydown`'s Shift+Tab branch, after deleting the `n`-char leading
indent, place the caret at text offset `caretOffset - n` (clamped to `>= 0`)
within the block instead of hardcoding offset `0`. Use the existing
`rangeForTextOffsets` helper to build the collapsed range. This is the only
change to the non-list (div/h1-h3) Tab/Shift+Tab path — everything else
about "same-line indent" behavior there is unchanged.

### 2. Markdown storage format: indentation-based nesting

List lines gain an optional leading-space run *before* the marker, denoting
depth:

```
- top level
  - depth 1 (2 spaces)
    - depth 2 (4 spaces)
      - depth 3 (6 spaces)
1. top level
  1. depth 1
```

- 2 spaces per depth level, depths 0–3 (4 levels total — matches the
  existing 4-char same-line-indent cap in `src/ui/editor.ts`, reused here
  for consistency rather than picking a new number).
- This leading run is distinct from the *existing* same-line indent feature,
  which operates on spaces *after* the marker (inside the item's own text,
  e.g. `-     indented bullet text`). The two are visually adjacent in a
  line like `  -     text` but parsed independently: first strip/measure the
  pre-marker depth run, then hand the remainder (`- ...`) to the existing
  per-line logic unchanged.
- A hand-edited line whose indent jumps more than one level past its actual
  parent context (e.g. depth 0 directly to depth 3, no depth-1/2 lines in
  between) is clamped to one level deeper than its parent on load. This
  guarantees `mdToHtml` never builds an orphaned list structure from
  malformed input; it never happens from normal in-app use since Tab only
  ever moves one level at a time.

### 3. `mdToHtml` (load): build real nested lists

Replace the single `list: 'ul' | 'ol' | null` tracker with a small
depth-aware stack (one entry per currently-open `<ul>/<ol>`, tracking its
depth and type). For each list line:

- Pop levels deeper than the line's depth (closing their tags).
- If the top-of-stack depth/type doesn't match, open a new nested list — as
  a child of the *previous* item at the shallower depth if nesting deeper,
  or as a fresh list at that depth otherwise.
- Append the `<li>`.

Non-list lines (heading, plain div, blank) close every open level, same as
today's single-level `closeList()`.

### 4. `htmlToMd` (save): serialize nested lists recursively

Rewrite the `ul`/`ol` branch of `htmlToMd`'s `walk()` to recurse: for each
top-level list, walk its `<li>` children; each `<li>`'s own text (everything
except a nested `<ul>/<ol>` child, if present) renders via the existing
`blockToMd` machinery, prefixed with `'  '.repeat(depth) + '- '` (or
`'N. '` for ordered, tracking its own per-level counter — same
`value`-attribute-driven numbering the flat version already does, just
scoped per nested list instead of once globally). If the `<li>` has a nested
`<ul>/<ol>` child, recurse into it at `depth + 1` immediately after emitting
the item's own line.

### 5. Editor Tab/Shift+Tab inside a list item: nest / promote

Inside a list item, Tab and Shift+Tab stop meaning "insert/remove a
same-line nbsp indent" (today's behavior) and instead restructure the DOM,
matching standard word-processor behavior:

- **Tab**: nests the current item under its previous sibling item, as that
  sibling's nested sub-list (reusing one if it already has one, else
  creating a new `<ul>`/`<ol>` matching the current list's type). No-op if
  the item is the first in its list (nothing to nest under), or already at
  depth 3 (4 levels reached).
- **Shift+Tab**: promotes the item out one level, splicing it into the
  parent list immediately after the item it was nested under. Any items
  that were *after* it in the same nested list move with it, becoming its
  own new children (preserves relative order/hierarchy — the standard
  "outdent carries its followers" behavior). No-op at depth 0 (top level) —
  matches today's no-op-when-nothing-to-remove behavior; leaving the list
  entirely still works via the existing native "Backspace at an empty item"
  behavior or the bullet/number toolbar toggle, unchanged.
- **Multi-item selection**: if the selection spans multiple sibling list
  items, Tab/Shift+Tab applies to the whole batch — they nest/promote
  together, preserving their relative order, same as a single item.
- Enter still creates a same-depth sibling — this is native contenteditable
  behavior on a real nested `<li>` and needs no new code.
- Outside list items (plain paragraphs/headings), Tab/Shift+Tab are
  unaffected beyond the section-1 caret fix.

No CSS changes needed — `.editor ul, .editor ol { padding-left: 1.5em }` is
a descendant selector, so it already applies to nested lists and the visual
indent cascades automatically.

### Trade-off (confirmed)

Tab inside a list item can no longer insert a literal same-line tab stop
into the item's text — Tab there always means "nest" now. This matches
Word/Google Docs and is what "natural text editor" behavior implies, but is
a real behavior change from what the 2026-07-20 batch shipped for list
items specifically. (Non-list blocks keep the same-line-indent behavior
unchanged.)

## Testing

`test/markdown.test.ts`:
- Nested round-trip: 2/3/4-level-deep `ul`, `ol`, and mixed `ul`/`ol`
  nesting, through `mdToHtml` → `htmlToMd`.
- Ordered-list numbering restarts correctly per nested list (each nested
  `ol` counts independently, same as today's single-level numbering logic
  but scoped per level).
- Existing flat-list tests continue to pass unchanged.
- Malformed over-indented input clamps to parent-depth + 1 instead of
  producing an orphaned structure.

`test/editor.test.ts`:
- Shift+Tab on a plain paragraph/heading with the caret mid-line: caret
  ends up at `caretOffset - n`, not at block start (regression test for the
  bug this spec fixes).
- Tab on a list item nests it under its previous sibling (resulting DOM has
  a nested `<ul>/<ol>` under that sibling containing the moved item).
- Tab no-ops on the first item of a list and at depth 3 (max depth).
- Shift+Tab promotes a nested item out one level, and its trailing siblings
  move with it as its new children.
- Shift+Tab no-ops at depth 0.
- Multi-item selection: Tab/Shift+Tab nests/promotes the whole selected
  batch together.

## Out of scope

- No new i18n strings — Tab/Shift+Tab aren't surfaced as toolbar
  labels/help text beyond what already exists.
- No change to indent depth/spacing for non-list same-line text indent
  (paragraphs/headings) beyond the caret-jump fix.
- No "promote past top level converts to plain paragraph" behavior —
  Shift+Tab at depth 0 stays a no-op (confirmed).
- No change to how `- `/`1. ` markers are auto-detected when typed
  (`detectBlockPrefix`) — that continues to only recognize an unindented
  marker at the very start of a block; typing an indented marker directly
  does not auto-convert to a nested list (indentation only comes from Tab
  or from a loaded `.tmv` file already containing indented markdown).
