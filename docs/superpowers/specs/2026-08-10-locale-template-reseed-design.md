# Locale-aware template re-seed — design

## Problem

`doc.templates` is seeded once, at document creation, from `builtinTemplates(locale)`
([src/core/templates.ts:62-69](../../../src/core/templates.ts#L62-L69)) — the five
built-in templates' `name`/`body` strings are baked into the persisted document in
whatever locale was active at creation time. Switching the app language later
(Prefs > General > Language) does not touch these strings.

This is *not* the general "stale locale after switching" problem — `main.ts`'s
`onLocaleChanged` handler already calls `pm.renderAll()`
([src/main.ts:382-388](../../../src/main.ts#L382-L388)), which fully remounts both
visible pane bodies and refreshes every `t()`-derived string and `getTemplateCtx()`
closure. The one gap is content that was never derived from `t()` in the first
place: the builtin templates' own text, which the user sees via the `/` template
picker ([src/ui/template-picker.ts](../../../src/ui/template-picker.ts)) and the
Prefs > Templates tab ([src/ui/prefs.ts](../../../src/ui/prefs.ts)).

## Goal

When the user switches the app language, any of the five builtin templates that
are still byte-identical to their old-locale seed (i.e. never edited) flip to the
new locale's wording. Templates the user has renamed or re-bodied are left alone —
matching a template on exact content, not on identity, is what keeps this safe:
there is no `isDefault`/origin field on `Template` today
([src/core/types.ts:53-56](../../../src/core/types.ts#L53-L56)) and adding one
would require a schema migration, which is out of scope.

## Design

In the locale radio handler
([src/ui/prefs.ts:198-207](../../../src/ui/prefs.ts#L198-L207)):

1. Before the `store.update` call, read `oldLocale = store.doc.prefs.locale`
   (still the pre-switch value) and `newLocale` (already computed from the radio
   value).
2. Inside the same `store.update` callback that sets `d.prefs.locale = newLocale`,
   also walk `d.templates`. For each of the 5 `SEEDS` entries
   ([src/core/templates.ts:19-60](../../../src/core/templates.ts#L19-L60)), find
   any `d.templates[i]` whose `name === seed.name[oldLocale] && body ===
   seed.body[oldLocale]`, and overwrite just that entry's `name`/`body` with
   `seed.name[newLocale]`/`seed.body[newLocale]`. Keep `id`, `scope`, and array
   position unchanged.
3. One `store.update` call, one mutation — no new scope needed beyond whatever
   the locale change already uses (full re-render already happens via
   `notifyLocaleChanged()` right after).

This is a pure function extractable for unit testing:
`reseedBuiltinTemplates(templates: Template[], oldLocale: Locale, newLocale:
Locale): Template[]` in `src/core/templates.ts`, called from the prefs.ts handler.
Keeping it in `core/templates.ts` (alongside `SEEDS`/`builtinTemplates`) keeps the
seed data and the re-seed logic co-located.

### Edge cases

- A template whose name matches a seed's name but whose body was hand-edited (or
  vice versa) does **not** match — both fields must be exactly equal to the old
  seed. Partial edits are treated as "user content," never touched.
- A template that happens to collide by coincidence with a seed's exact old-locale
  text but was actually authored by the user (not one of the five builtins) is
  indistinguishable from a real builtin under this heuristic, and would get
  "re-seeded" too. Accepted: the resulting text is still one of the five known
  builtin bodies, in the new locale, which is a reasonable outcome even in this
  edge case, and there's no `id`/origin marker to do better without a migration.
- Deleted builtins (user removed one via the Templates tab) are simply absent from
  `d.templates` — nothing to match, nothing re-seeded. Matches existing "Restore
  defaults" behavior, which also only re-adds by name-presence.
- Switching locale back and forth repeatedly is idempotent: after a swap, the
  entry's `name`/`body` matches the *new* locale's seed, so a further switch
  matches it against that locale's seed on the next change, same as any other.

## Testing

- `test/templates.test.ts` (new or extended): unit tests for
  `reseedBuiltinTemplates` — untouched builtin swaps language; edited-body
  template is skipped; edited-name-only template is skipped; user-authored
  template with unrelated content is skipped; round-trip (pt→en→pt) restores
  original text.
- `test/prefs.test.ts` (if one exists) or an integration-level check that the
  locale radio handler wires the call correctly.

## Out of scope

- Retranslating arbitrary user-authored templates (no seed to compare against).
- Adding an `isDefault` field or any schema/migration change.
- Retranslating already-*inserted* template content sitting in notes/action items
  (that's ordinary document content once inserted, same as any other text).
