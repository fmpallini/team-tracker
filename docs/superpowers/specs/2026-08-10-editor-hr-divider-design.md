# `---` horizontal-rule autoformat — design

## Goal

In any rich-text field (all share `src/core/markdown.ts` + `src/ui/editor.ts`),
typing `---` (3 or more dashes, alone on a line) followed by Space or Enter
inserts a visible horizontal divider, same as other markdown tools. Documented in
the help modal; no toolbar button needed.

## Storage format

A block consisting of exactly `---` (bare, on its own markdown line) round-trips
to/from an `<hr>` element. This is CommonMark-compatible (thematic break), scoped
here to the `-` spelling only — `***`/`___` are out of scope, matching what was
asked for.

## `src/core/markdown.ts` changes

- `mdToHtml`: in the per-line loop ([markdown.ts:84-93](../../../src/core/markdown.ts#L84-L93)),
  add a branch before the default `<div>` fallback: a line matching `/^-{3,}$/`
  closes any open list (`closeList()`, same as headings) and pushes `<hr>`.
- `htmlToMd`: in `walk()` ([markdown.ts:292-306](../../../src/core/markdown.ts#L292-L306)),
  add `tag === 'hr'` → push `'---'`. (Today it falls through to `inlineMd(node)`,
  which returns `''` for a childless element — the rule would silently vanish on
  save without this.)

## `src/ui/editor.ts` changes

### Space trigger (reuses the existing autoformat path)

- `BlockPrefixMatch['type']` gains `'hr'`; `detectBlockPrefix`
  ([editor.ts:97-107](../../../src/ui/editor.ts#L97-L107)) gains a branch:
  `/^-{3,}[  ]$/.test(text)` (same NBSP-tolerant trailing-space class the existing
  patterns use) → `{ type: 'hr', prefixLen: text.length }`.
- `handleAutoFormat` ([editor.ts:426-449](../../../src/ui/editor.ts#L426-L449)):
  the `blockMatch.type === 'hr'` case is handled like `'ul'/'ol'` — whole-block
  conversion, not a prefix-strip-then-formatBlock — because `<hr>` is a void
  element `execCommand('formatBlock', …)` can't target. New helper
  `convertBlockToHr(block)`, alongside `convertBlockToList`
  ([editor.ts:396-408](../../../src/ui/editor.ts#L396-L408)): replaces `block`
  with `<hr>` followed by a fresh empty `<div><br></div>`, and moves the caret
  into that new div (an `<hr>` can't hold a caret, unlike the list case which
  parks the caret inside the new `<li>`).

### Enter trigger (new — no existing hook covers this)

There's currently no Enter-key interception in `editor.ts`'s `onKeydown`
([editor.ts:741-789](../../../src/ui/editor.ts#L741-L789)); Enter is handled
entirely by native contenteditable `insertParagraph`, after which `onInput` re-fires
`handleAutoFormat` against the *new* (now-current, empty) block — too late to see
the block that just got split off.

Add an Enter branch in `onKeydown`: if the key is `Enter` (no modifiers) and
`currentBlockAndOffset()` gives a block whose full text matches `/^-{3,}$/` (no
trailing space this time — Enter itself is the trigger) with the caret at the end,
`preventDefault()` and call the same `convertBlockToHr(block)`, then
`scheduleChange()` directly (no native `input` event will fire since the default
action was suppressed — mirrors how `template-picker.ts` manually dispatches
`input` after its own DOM surgery, [template-picker.ts:249](../../../src/ui/template-picker.ts#L249)).

Guard both paths the same way the `ul`/`ol` branch already does — only convert
when `block.parentElement === editorEl` (top-level block), so `---` typed inside a
list item is left as literal text rather than trying to splice an `<hr>` into list
markup, which `htmlToMd` can't represent.

## Styling

`.editor hr { border: none; border-top: 1px solid var(--border); margin: .75em 0; }`
in `styles.css` — `--border` is already themed per palette/light/dark
([styles.css](../../../styles.css)'s per-palette blocks), so no new tokens needed.

## Help + i18n

Add a line to the editor shortcuts help section
([src/ui/help.ts](../../../src/ui/help.ts), same spot as the `/` templates line at
[help.ts:61-62](../../../src/ui/help.ts#L61-L62)): "Type `---` then Space or Enter
to insert a horizontal divider." New `t()` keys in both `pt-BR` and `en-US`
blocks of `src/core/i18n.ts`.

## Testing

- `test/markdown.test.ts`: `mdToHtml('---')` → `<hr>`; round-trip through
  `htmlToMd` on an `<hr>` node → `'---'`; a `---` line inside/after list content
  doesn't get swallowed by list-closing logic incorrectly.
- `test/editor.test.ts` (or wherever `detectBlockPrefix`/`handleAutoFormat` are
  unit-tested): `detectBlockPrefix('--- ')` → `{ type: 'hr', … }`; 3, 4, and 5+
  dashes all match; `'-- '` (2 dashes) does not.
- An editor-level test (jsdom, dispatching a real `keydown` Enter) for the
  Enter-trigger path converting a `---`-only block into `<hr>` + empty div with
  caret moved.

## Out of scope

- `***`/`___` spellings.
- A toolbar button or `/` template-picker entry for inserting a divider manually.
- Converting `---` typed *inside* a list item.
