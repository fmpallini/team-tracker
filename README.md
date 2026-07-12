# Team Tracker

A zero-runtime-dependency, single-file web app for tracking teams: people and
hierarchy, daily/per-person notes, action items, milestones (with a calendar
view), and risks.

## Why

Most team-tracking tools require an account, a server, and your data leaving
your machine. Team Tracker doesn't:

- 🔌 **100% offline** — works without internet; nothing leaves your machine.
- 🗄️ **A single `.tmv` file** you keep wherever you want — copy it, back it up,
  put it in your own cloud sync, put it on a USB stick. There is no vendor
  storing it for you.
- 🔒 **End-to-end encryption (AES-256)** — even if that file sits in a cloud
  backup, it's only ever decrypted on your device, with your password.

There's no server and no backend. Everything lives in one password-encrypted
`.tmv` file that you open, edit, and save yourself, either straight off disk
(`dist/app.html` via `file://`) or through an installable PWA build
(`dist/pwa/`).

## Why zero runtime dependencies

The app ships as one HTML file with the CSS and JS inlined into it — open it
years from now, on any machine, with any browser, and it still works exactly
as built. That guarantee only holds if nothing at runtime depends on a
third-party library that could have a vulnerability, an abandoned maintainer,
or a breaking major-version bump. `esbuild`, `typescript`, `vitest`, and
`jsdom` are dev-only tooling used to build and test the app — none of their
code ships in `dist/app.html` or `dist/pwa/`. This is a hard project
constraint: no runtime dependency is ever added, however small.

It also means the entire attack surface for supply-chain compromise is
whatever ships in the two build outputs, which you can read end to end — there
is no `node_modules` tree running in the user's browser.

## Architecture

- **`src/core/`** — headless logic, no DOM construction. Document shape and
  schema migrations (`document.ts`, `types.ts`), the `.tmv` encryption format
  (`crypto.ts`), the mutable document store (`store.ts`), the File System
  Access API wrapper (`fs.ts`), and save orchestration (`save-controller.ts`).
- **`src/modules/`** — one file per feature pane: daily notes, people trees
  (stakeholders/members), person notes, action items, milestones, risks. Each
  module exports a single render function with the signature
  `(container: HTMLElement, loc: Loc, ctx: ModuleCtx) => void` and is wired up
  in `src/main.ts` via `pm.registerModule(kind, renderFn)`.
- **`src/ui/`** — shell, sidebar, pane manager (split view + per-pane
  history), command palette, search, modals, preferences. `ui/dom.ts`'s `el()`
  helper is the one DOM-building primitive used everywhere — no templating
  engine, no virtual DOM.
- **`src/main.ts`** — wires everything together: start screen →
  `onDocumentOpened` builds the shell/store/panes/save-controller, registers
  hotkeys, and sets up cross-tab single-writer locking so only one tab can
  write to a given file at a time.

### Adding a new module/pane

Because every pane is just a render function registered by string key, adding
a new tracked entity (say, a "decisions log") is mostly additive:

1. Add its shape to `Doc` in `src/core/types.ts`, bump `SCHEMA_VERSION` in
   `src/core/document.ts`, and add a migration step for existing files.
2. Add a `ModuleRef` variant and a case in `src/core/nav.ts` for its location
   type.
3. Write `src/modules/<name>.ts` exporting a render function matching
   `ModuleRenderer`.
4. Register it in `src/main.ts` with `pm.registerModule('<kind>', renderFn)`,
   and add it to the fixed module list in `src/ui/panes.ts` so it shows up in
   the pane switcher and command palette.
5. Add `pt-BR`/`en-US` strings for it in `src/core/i18n.ts` — every
   user-visible string goes through `t(locale, key)`.
6. Add `test/<name>.test.ts` alongside it.

No other module needs to know the new one exists — the pane manager, sidebar,
palette, and search all work off the registered module list and the `Loc`
union.

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

## Using `dist/app.html` (file://)

Just double-click `dist/app.html`, or open it from your browser's file
picker. No install, no server, no network access required — the whole app
(HTML, CSS, JS) is inlined into that one file.

To open it in its own app-like window (no address bar/tabs) instead of a
regular browser tab, launch Chrome with the `--app` flag:

```
chrome --app=file:///C:/path/to/dist/app.html
```

(On macOS/Linux, drop the drive letter: `--app=file:///path/to/dist/app.html`.)

## Deploying the PWA (`dist/pwa/`)

The PWA build needs to be served over http(s) (service workers refuse to
register under `file://`). The simplest free option is GitHub Pages:

**Option A — `gh-pages` branch:**

```
npm run build
npx gh-pages -d dist/pwa
```

(First run: `npm install -D gh-pages`, or use any tool that pushes a
directory to a branch.) Then in the repo's Settings → Pages, set the source
to the `gh-pages` branch, root.

**Option B — `/docs` folder on `main`:**

```
npm run build
rm -rf docs
cp -r dist/pwa docs
git add docs && git commit -m "chore: publish pwa build to docs/"
git push
```

Then in Settings → Pages, set the source to `main` branch, `/docs` folder.

Either way, once published, visiting the Pages URL in Chrome/Edge shows an
install prompt; installing opens Team Tracker in its own standalone window.

## Data file

Team Tracker never uploads or syncs your data anywhere. All state lives in a
single encrypted `.tmv` file (password-based encryption) that you create,
open, and save through the app's own file dialogs (or the download-fallback
path in browsers without File System Access API support). **You own the
file and are responsible for backing it up** — losing the file, or forgetting
its password, means the data is unrecoverable.

## Development

```
npm test              # run the test suite (vitest)
npx vitest run test/store.test.ts   # run a single test file
npm run test:watch    # vitest watch mode
npm run typecheck     # tsc --noEmit, strict mode
npm run build          # produce dist/app.html and dist/pwa/
```

The codebase has zero runtime dependencies — `esbuild`, `typescript`,
`vitest`, and `jsdom` are dev-only tooling.

## License

AGPL-3.0. See [LICENSE](LICENSE).
