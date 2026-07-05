# Team Tracker

A zero-runtime-dependency, single-file web app for tracking teams: people and
hierarchy, daily/per-person notes, action items, milestones (with a calendar
view), and risks. It has no server and no backend — everything lives in one
encrypted `.tmv` file that you open, edit, and save yourself, either straight
off disk (`dist/app.html` via `file://`) or through an installable PWA build
(`dist/pwa/`).

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
npm test         # run the test suite (vitest)
npm run typecheck # tsc --noEmit, strict mode
npm run build     # produce dist/app.html and dist/pwa/
```

The codebase has zero runtime dependencies — `esbuild`, `typescript`, and
`vitest` are dev-only tooling.
