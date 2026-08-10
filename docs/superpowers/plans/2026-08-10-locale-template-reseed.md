# Locale Template Re-seed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user switches the app language mid-session, the 5 builtin templates that are still unedited flip to the new language immediately, so the `/` template picker and Prefs > Templates never show stale-language text.

**Architecture:** A pure function `reseedBuiltinTemplates` in `src/core/templates.ts` compares each stored template's `name`+`body` against the known `SEEDS` in the old locale; exact matches get swapped to the new locale's text. Called from the locale radio handler in `src/ui/prefs.ts`, inside the same `store.update` that flips `d.prefs.locale`.

**Tech Stack:** TypeScript, Vitest, jsdom. No new dependencies.

## Global Constraints

- Zero runtime dependencies — no new packages.
- `doc.templates` mutation must happen inside a single `store.update` call alongside the locale change (one mutation, one re-render).
- Never touch template text already inserted into notes/cards — only `doc.templates` entries themselves.
- Never add a schema field or migration — matching is by exact `name`+`body` content only.
- Match spec at `docs/superpowers/specs/2026-08-10-locale-template-reseed-design.md`.

---

### Task 1: `reseedBuiltinTemplates` in `src/core/templates.ts`

**Files:**
- Modify: `src/core/templates.ts`
- Test: `test/templates.test.ts`

**Interfaces:**
- Consumes: `SEEDS` (existing module-level const, `src/core/templates.ts:19-60`), `Template` type (`src/core/types.ts:53-56`), `Locale` type (`src/core/i18n.ts:4`).
- Produces: `export function reseedBuiltinTemplates(templates: Template[], oldLocale: Locale, newLocale: Locale): Template[]` — Task 2 imports and calls this.

- [ ] **Step 1: Write the failing tests**

Add to `test/templates.test.ts`:

```ts
import { builtinTemplates, resolveTemplate, reseedBuiltinTemplates } from '../src/core/templates'
```

```ts
test('reseedBuiltinTemplates swaps an untouched builtin to the new locale', () => {
  const ts = builtinTemplates('en-US')
  const reseeded = reseedBuiltinTemplates(ts, 'en-US', 'pt-BR')
  const oneOnOne = reseeded.find(t => t.id === ts[0]!.id)!
  expect(oneOnOne.name).toBe('1:1')
  expect(oneOnOne.body).toContain('Como está / energia')
  // id, scope, and array position are preserved
  expect(reseeded.map(t => t.id)).toEqual(ts.map(t => t.id))
  expect(reseeded[0]!.scope).toBe(ts[0]!.scope)
})

test('reseedBuiltinTemplates leaves an edited template untouched', () => {
  const ts = builtinTemplates('en-US')
  const edited = ts.map((t, i) => (i === 0 ? { ...t, body: 'my custom body' } : t))
  const reseeded = reseedBuiltinTemplates(edited, 'en-US', 'pt-BR')
  expect(reseeded[0]!.name).toBe('1:1') // name untouched too — partial edit means "leave the whole entry alone"
  expect(reseeded[0]!.body).toBe('my custom body')
  // the other 4, still exact matches, do get swapped
  expect(reseeded[1]!.name).not.toBe(ts[1]!.name)
})

test('reseedBuiltinTemplates leaves a user-authored template untouched', () => {
  const ts = builtinTemplates('en-US')
  const withCustom = [...ts, { id: 'custom-1', name: 'My own template', scope: 'any' as const, body: 'whatever I want' }]
  const reseeded = reseedBuiltinTemplates(withCustom, 'en-US', 'pt-BR')
  expect(reseeded.find(t => t.id === 'custom-1')).toEqual(withCustom[5])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/templates.test.ts`
Expected: FAIL — `reseedBuiltinTemplates is not a function` (or import error).

- [ ] **Step 3: Implement `reseedBuiltinTemplates`**

In `src/core/templates.ts`, after `builtinTemplates` (after line 69):

```ts
export function reseedBuiltinTemplates(templates: Template[], oldLocale: Locale, newLocale: Locale): Template[] {
  return templates.map((tpl) => {
    const seed = SEEDS.find((s) => s.name[oldLocale] === tpl.name && s.body[oldLocale] === tpl.body)
    if (!seed) return tpl
    return { ...tpl, name: seed.name[newLocale], body: seed.body[newLocale] }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/templates.test.ts`
Expected: PASS, all tests including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/core/templates.ts test/templates.test.ts
git commit -m "feat: add reseedBuiltinTemplates for locale-aware template swap"
```

---

### Task 2: Wire re-seed into the locale radio handler

**Files:**
- Modify: `src/ui/prefs.ts:198-207`
- Test: `test/prefs.test.ts`

**Interfaces:**
- Consumes: `reseedBuiltinTemplates` from Task 1 (`src/core/templates.ts`).
- Produces: nothing new consumed by later tasks — this is the final integration point.

- [ ] **Step 1: Write the failing test**

Add to `test/prefs.test.ts`, right after the existing `'locale radio updates store.prefs...'` test (after line 442):

```ts
test('locale radio re-seeds untouched builtin templates and leaves an edited one alone', () => {
  const { store, shell, appCtl } = setup()
  // setup() creates the doc with 'en-US', so store.doc.templates start out English.
  const beforeIds = store.doc.templates.map(t => t.id)
  store.update((d) => {
    d.templates[1]!.body = 'hand-edited body' // Feedback (SBI) template, left untouched by the switch
  })
  openPrefs(store, shell, 'en-US', appCtl)

  radio('tt-prefs-locale', 'pt-BR').click()

  expect(store.doc.templates.map(t => t.id)).toEqual(beforeIds) // same ids/order
  expect(store.doc.templates[0]!.name).toBe('1:1') // untouched builtin, now Portuguese wording
  expect(store.doc.templates[0]!.body).toContain('Como está / energia')
  expect(store.doc.templates[1]!.body).toBe('hand-edited body') // edited one, skipped
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/prefs.test.ts -t "re-seeds untouched"`
Expected: FAIL — `store.doc.templates[0].body` still contains the English text.

- [ ] **Step 3: Implement the wiring**

In `src/ui/prefs.ts`, add the import (alongside the existing `builtinTemplates` import at line 12):

```ts
import { builtinTemplates, reseedBuiltinTemplates } from '../core/templates'
```

Replace the locale radio handler (lines 198-207):

```ts
const localeField = radioField('tt-prefs-locale', 'prefs_locale_label', LOCALE_OPTIONS, prefs.locale, (value) => {
  const newLocale = value as Locale
  const oldLocale = store.doc.prefs.locale
  store.update((d) => {
    d.prefs.locale = newLocale
    d.templates = reseedBuiltinTemplates(d.templates, oldLocale, newLocale)
  })
  shell.applyPrefs(store.doc.prefs)
  notifyLocaleChanged()
  handle.close()
  openPrefs(store, shell, newLocale, appCtl)
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/prefs.test.ts`
Expected: PASS, all tests including the new one and the pre-existing locale-radio test.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/ui/prefs.ts test/prefs.test.ts
git commit -m "fix: re-seed untouched builtin templates when switching app language"
```
