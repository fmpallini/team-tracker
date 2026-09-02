# Contributing

For a map of the codebase, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Build

```
npm install
npm run build
```

This produces:

- `dist/app.html` — a single self-contained HTML file with no external
  references. Copy it anywhere and open it directly.
- `dist/pwa/` — the same app plus `manifest.json`, `sw.js`, and `icon.svg`,
  meant to be served over http(s) so it can be installed as a PWA.

## Development

```
npm test              # run the test suite (vitest)
npx vitest run test/store.test.ts   # run a single test file
npm run test:watch    # vitest watch mode
npm run typecheck     # tsc --noEmit, strict mode
npm run lint          # eslint src test
npm run test:e2e      # build, then run the Playwright suite against dist/
npm run build         # produce dist/app.html and dist/pwa/
```

The codebase has zero runtime dependencies — `esbuild`, `typescript`,
`vitest`, `jsdom`, and `@playwright/test` are dev-only tooling. Adding a
runtime dependency is a hard no.

## Adding a new module/pane

Because every pane is just a render function registered by string key, adding
a new tracked entity (say, a "decisions log", kind `decisions`) is mostly
additive. The one thing that's easy to half-do is wiring it into global search
and the `Ctrl+Shift+K` fast switch (a.k.a. the command palette, `palette.ts`) —
both are covered explicitly below, since they don't come for free just from
registering the module.

1. **Shape and schema.** Add its shape to `Team` (or `Doc`) in
   `src/core/types.ts`, add a `ModuleRef` variant (`{ kind: 'decisions';
   itemId?: string }` — the `itemId?` is only needed if items are individually
   addressable, the way action items/milestones/risks are for deep-linking
   from search and `@`-mentions). Bump `SCHEMA_VERSION` in
   `src/core/document.ts` and add a step to the `MIGRATIONS` ladder there if
   existing `.tmv` files need the field backfilled on open.

2. **The renderer.** Write `src/modules/<name>.ts` exporting a function
   matching `ModuleRenderer` — `(container: HTMLElement, loc: Loc, ctx:
   ModuleCtx) => void`. `ctx` gives you `store`, `pm` (for opening other
   locs), `paneIdx`, `locale`, and `searchIndex` (for backlink-chip lookups —
   see `src/modules/milestones.ts` for an example consumer). Read the team via
   `ctx.store.doc.teams.find(...)`, build DOM with `src/ui/dom.ts`'s `el()`
   helper, mutate through `ctx.store.update((d) => { ... })`, and re-render on
   every store change via `ctx.store.subscribe(renderAll)`. Conventions worth
   matching rather than reinventing — look at `src/modules/action-items.ts`
   (no live inputs → full rebuild on every change) or
   `src/modules/milestones.ts` (has inline-editable fields → skips rebuild
   while one is focused, so an in-progress edit's caret survives a foreign
   store change):
   - `store.update()` is for content (marks the doc dirty, fires
     `subscribe()`); `store.updateNav()` is for navigation-only state (pane
     focus, split %) and deliberately bypasses `subscribe()` so switching
     panes doesn't blow away an in-progress edit elsewhere. Don't mix them up.
   - **Wrap your exported renderer with `withDisposal()` from
     `src/modules/lifecycle.ts`** — every existing module does (e.g.
     `export const renderDecisions = withDisposal((container, loc, ctx) =>
     { ... })`). `panes.ts` reuses one body element across module switches and
     only clears `container`'s own DOM children between renders, so anything
     your renderer attaches *outside* `container` — a document-level
     listener, an overlay appended to `document.body` (see `src/ui/atref.ts`'s
     `@`-mention dropdown) — would otherwise leak on every re-open or module
     switch. To fix that, have your render function `return` a teardown
     callback (`() => void`) when it attached anything external;
     `withDisposal()` stores that callback in a shared `WeakMap` and calls it
     automatically the next time that container is mounted into, so you don't
     hand-roll any bookkeeping yourself.

3. **Register it.** In `src/main.ts`, alongside the other
   `pm.registerModule(...)` calls: `pm.registerModule('decisions',
   renderDecisions)`. Do this before the post-registration `pm.renderAll()`
   call a few lines down, or a pane whose saved nav state already points at
   the new kind renders "Módulo em construção…" and never gets a second pass.
   Also add a `case 'decisions':` to `titleFor()`'s switch in
   `src/ui/panes.ts` (the pane header title) — it has an explicit `string`
   return type, so TypeScript will refuse to compile a non-exhaustive switch
   and point you straight back here if you forget.

4. **Pane switcher + fast switch (one list, both surfaces).** Add it to
   `FIXED_MODULE_KEYS` in `src/ui/panes.ts` (its `kind` field is a closed
   union — widen that type alongside the new array entry, TypeScript will
   flag the mismatch either way). `buildModuleItems()` in that same file
   turns that list into the `ModuleItem[]` array shown in the pane's own "＋"
   module dropdown — **and `src/ui/palette.ts`'s `Ctrl+Shift+K` fast switch
   calls this exact same function.** There's no separate fast-switch item list
   to maintain; wiring the pane switcher wires the fast switch too.
   If individual items (not just the module as a whole) should get their own
   fast-switch entries — the way each action item/milestone/risk shows up as
   its own line — extend `buildModuleItems()`'s per-kind branch the way `actions`/
   `milestones`/`risks` do, sourcing the list from `teamRefCandidates()` (step
   6 below — you'll likely want that list anyway).

5. **Global search.** The header search bar (`Ctrl+F` / `/`,
   `src/ui/search-ui.ts`) is backed by `searchDocument()` in
   `src/core/search.ts`, which works over a flat candidate list built by that
   file's `collectCandidates()`. Add a loop over your module's items there:
   ```ts
   for (const d of team.decisions) {
     out.push({ raw: `${d.title}\n${d.rationale}`, title: d.title, ref: { kind: 'decisions', itemId: d.id } })
   }
   ```
   `raw` is whatever free text should be searchable — `searchDocument()`
   strips markdown syntax from it and does a normalized (accent/case
   insensitive), term-by-term substring match; if there's no free-text field,
   `raw` can just equal `title`. Then add an icon to `KIND_ICON` (same file)
   so results render with a matching glyph — that's the only other piece;
   snippet highlighting and the results dropdown are already generic over
   `ref.kind`.

6. **i18n.** Add `pt-BR`/`en-US` strings to `src/core/i18n.ts` — every
   user-visible string goes through `t(locale, key)`, in both locale blocks.

7. **Optional: `@`-mentions.** If notes should be able to `@`-link to one of
   your items, add an entry to the `REF_KINDS` registry in `src/core/refs.ts`
   (drives the mention regex, auto-unlink-on-delete via `unlinkRefsInTeam` —
   call it from your delete path — and the `@`-picker's group header/icon),
   and add the item list to `teamRefCandidates()` in `src/core/search.ts` —
   the same function step 4 mentioned, and what the `@` picker and fast switch
   both actually filter over.

8. **Tests.** Add `test/<name>.test.ts`. Pure logic gets plain unit tests; the
   renderer gets exercised against a real `createStore(createEmptyDocument(locale))`
   + jsdom the way `test/action-items.test.ts` does — mount, assert on
   `container.querySelector(...)`, dispatch DOM events, assert on the mutated
   `store.doc`.

Beyond the explicit wiring above (steps 3–4: `registerModule`, `titleFor`,
`FIXED_MODULE_KEYS`), no other module needs to know the new one exists — the
pane manager's rendering, history, and print machinery all work off the
registered module list and the `Loc` union generically. The two places that
genuinely don't come for free just from that wiring are global search
(`collectCandidates`/`KIND_ICON`) and, if wanted, `@`-mentions (`REF_KINDS`).
