# Locale-aware template re-seed — design

## Problem

Change language in Prefs, then (same session, no reload) type `/` in a field →
template picker and inserted template text still show the old language.

Cause: `doc.templates` is seeded once, at doc creation, from
`builtinTemplates(locale)` ([templates.ts:62-69](../../../src/core/templates.ts#L62-L69)).
Locale switch never touches it — the picker just reads whatever's stored.

## Fix

In the locale radio handler ([prefs.ts:198-207](../../../src/ui/prefs.ts#L198-L207)):
capture `oldLocale` before flipping it, and in the same `store.update`, swap any
`d.templates` entry whose `name`+`body` still exactly match one of the 5
`SEEDS`' old-locale text ([templates.ts:19-60](../../../src/core/templates.ts#L19-L60))
to that seed's new-locale text (same `id`/`scope`/position). A template the user
edited no longer matches exactly, so it's left alone.

New pure helper in `core/templates.ts`: `reseedBuiltinTemplates(templates,
oldLocale, newLocale): Template[]`.

Does **not** touch template text a user already inserted into a note/card — that's
ordinary document content once inserted, unrelated to `doc.templates`.

## Testing

`test/templates.test.ts`: untouched builtin swaps language; edited template is
skipped. `test/prefs.test.ts`: locale-switch test asserts `doc.templates` updates.
