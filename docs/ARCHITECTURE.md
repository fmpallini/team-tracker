# Architecture

How the codebase is laid out. For how to build it and how to add a new
tracked entity, see [CONTRIBUTING.md](../CONTRIBUTING.md).

Team Tracker is a single-file web app with no runtime dependencies and no
backend: all state lives in one `.tmv` file the user opens and saves
themselves. The source is plain TypeScript compiled to one inlined HTML file
by `esbuild` — no framework, no virtual DOM, no templating engine.

## Layout

- **`src/core/`** — headless logic, no DOM construction. Document shape and
  schema migrations (`document.ts`, `types.ts`), the `.tmv` encryption format
  (`crypto.ts`), the mutable document store (`store.ts`), the File System
  Access API wrapper (`fs.ts`), and save orchestration (`save-controller.ts`).
- **`src/modules/`** — one file per feature pane: daily notes, general notes,
  people trees (stakeholders/members), person notes, action items, milestones,
  risks. Each module exports a single render function with the signature
  `(container: HTMLElement, loc: Loc, ctx: ModuleCtx) => void` and is wired up
  in `src/main.ts` via `pm.registerModule(kind, renderFn)`.
- **`src/ui/`** — shell, sidebar, pane manager (split view + per-pane
  history), fast switch, search, modals, preferences. `ui/dom.ts`'s `el()`
  helper is the one DOM-building primitive used everywhere — no templating
  engine, no virtual DOM.
- **`src/main.ts`** — wires everything together: start screen →
  `onDocumentOpened` builds the shell/store/panes/save-controller, registers
  hotkeys, and sets up cross-tab single-writer locking so only one tab can
  write to a given file at a time.

## Store and rendering

`src/core/store.ts` holds one mutable `Doc`. It has two mutation channels:

- `store.update(fn, scope?)` — content edits. Marks the doc dirty and notifies
  `subscribe()` listeners (which re-render the affected panes).
- `store.updateNav(fn)` — navigation-only state (pane focus, split %). Bypasses
  `subscribe()` deliberately, so switching panes never blows away an
  in-progress edit elsewhere.

Modules build DOM with `el()`, mutate through `store.update()`, and re-render
on every store change via `store.subscribe(renderAll)`. A `rev` counter on the
store is the cache-invalidation signal — the `Doc` is mutated in place, so
object identity never changes.

## Persistence

The `.tmv` format lives in `src/core/crypto.ts`: a `"TMV1"` magic prefix,
PBKDF2-SHA256 → AES-GCM, with a key-check block so a wrong password is
distinguishable from a corrupt file. Password-less files are a plain-text
variant — a `TMV-PLAIN` header line followed by raw `JSON.stringify(doc)` —
detected by sniffing the header before ever prompting for a password. On
decrypt the payload runs through `migrate()` (`src/core/document.ts`), which
walks the `MIGRATIONS` ladder from the file's `schemaVersion` up to
`SCHEMA_VERSION`.

## Testing

Every `src` module has a matching `test/*.test.ts` (vitest, jsdom). Browser
APIs the app depends on — Web Locks, `BroadcastChannel`, the File System
Access API — are absent under jsdom, so the code feature-detects and degrades
gracefully; that is also what keeps it testable. `e2e/*.spec.ts` are
Playwright specs run separately (`npm run test:e2e`), not part of the vitest
run or `tsc`/`eslint` scope.
