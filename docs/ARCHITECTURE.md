# Architecture

How the codebase is laid out. For how to build it and how to add a new
tracked entity, see [CONTRIBUTING.md](../CONTRIBUTING.md).

Team Tracker is a single-file web app with no runtime dependencies and no
backend: the browser holds the live copy of the open document, and one `.tmv`
file the user opens and keeps is a snapshot of it. The source is plain TypeScript compiled to one inlined HTML file
by `esbuild` — no framework, no virtual DOM, no templating engine.

## Layout

- **`src/core/`** — headless logic, no DOM construction. Document shape and
  schema migrations (`document.ts`, `types.ts`), the `.tmv` encryption format
  (`crypto.ts`), the mutable document store (`store.ts`), the File System
  Access API wrapper (`fs.ts`), the browser live store (`doc-records.ts`,
  `live-db.ts`, `live-store.ts`, `live-persist.ts`, `live-open.ts`), the file
  snapshot controller (`file-snapshot.ts`, `snapshot.ts`, `close-document.ts`),
  and the fast-switch model (`switcher.ts`, `module-items.ts`).
- **`src/modules/`** — one file per feature pane: daily notes, general notes,
  people trees (stakeholders/members), person notes, tasks (`action-items.ts`), milestones,
  risks. Each module exports a single render function with the signature
  `(container: HTMLElement, loc: Loc, ctx: ModuleCtx) => void` and is wired up
  in `src/main.ts` via `pm.registerModule(kind, renderFn)`.
- **`src/ui/`** — shell, sidebar, pane manager (split view + per-pane
  history), fast switch, search, modals, preferences. `ui/dom.ts`'s `el()`
  helper is the one DOM-building primitive used everywhere — no templating
  engine, no virtual DOM.
- **`src/main.ts`** — wires everything together: start screen →
  `onDocumentOpened` builds the shell/panes/file-snapshot around the store that
  `ui/open-document.ts` reconciled with the browser copy, registers
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

## Saving: the browser copy and the file

IndexedDB is the live store of an open document, and the `.tmv` file is a
periodic snapshot of it. After every mutation the persister
(`src/core/live-persist.ts`) re-splits the document into path-addressed records
(`doc-records.ts`), compares each record's JSON with what it last wrote, and
commits only the differences, plus the bytes of images not yet stored, in one
transaction. For a password-protected file every record and image is sealed with
the file's own AES-GCM key; keys are random, so nothing readable (titles, names,
dates) is left in the browser's storage.

The file is written, in full, at three moments: at open when the browser copy is
ahead of it, at Lock/Close, and on a 1–24 hour timer (`file-snapshot.ts`). Each
write carries a fresh `writeId`; the browser copy remembers which writes it has seen,
so at the next open `live-open.ts` can tell an identical file, a file that is behind,
an older restored copy and a file that came from elsewhere apart without ever
comparing timestamps. Only the tab holding the cross-tab write lock touches the
browser copy; a tab that takes the lock over reloads from it rather than from the
file. A file write that fails never touches the browser copy: the user is offered
re-grant, a download, a retry, or "close anyway".
