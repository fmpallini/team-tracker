# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Team Tracker — a zero-runtime-dependency, single-file web app for tracking teams (people/hierarchy, daily and per-person notes, action items, milestones, risks). No server, no backend: all state lives in one password-encrypted `.tmv` file the user opens and saves themselves. The original design spec and implementation plan live in `docs/superpowers/`.

## Commands

```
npm run build       # node scripts/build.mjs → dist/app.html + dist/pwa/
npm test            # vitest run (jsdom environment)
npx vitest run test/store.test.ts   # single test file
npm run test:watch  # vitest watch mode
npm run typecheck   # tsc --noEmit (strict)
```

Zero runtime dependencies is a hard constraint — `esbuild`, `typescript`, `vitest`, `jsdom` are dev-only. Do not add runtime deps.

## Build outputs (scripts/build.mjs)

Two variants are bundled from the same `src/main.ts` entry, differing only in the esbuild defines `__APP_VERSION__` (from package.json version) and `__PWA__`:

- `dist/app.html` — fully self-contained single file (CSS + JS inlined into `index.html` placeholders `/*__CSS__*/` and `/*__JS__*/`). Opened via `file://`; must never reference external files.
- `dist/pwa/` — same app with `__PWA__=true` (registers `sw.js`, only over http(s)), plus manifest/icon and a cache-first service worker whose cache name embeds the app version (`__APP_VERSION__` placeholder in `pwa/sw.js` replaced at build time).

Tests define `__PWA__: false` in `vitest.config.ts`, so the service-worker branch never runs under jsdom.

## Architecture

- **`src/core/`** — headless logic, no DOM construction:
  - `types.ts` / `document.ts` — the `Doc` shape, `SCHEMA_VERSION`, and the `migrate()` ladder (`MIGRATIONS[n]` mutates a version-n doc to n+1; opening a newer-schema file throws `SchemaTooNewError`). Bump the schema and add a migration whenever the persisted shape changes.
  - `crypto.ts` — `.tmv` binary format: `"TMV1"` magic + format version + PBKDF2-SHA256 (600k iterations) → AES-GCM, with a key-check block so wrong password (`WrongPasswordError`) is distinguishable from corruption (`CorruptFileError`). Payload is `JSON.stringify(doc)`, run through `migrate()` on decrypt.
  - `store.ts` — single mutable `Doc` holder. Two mutation channels: `update()` (marks dirty, notifies `subscribe()` — full content re-render) and `updateNav()` (nav-only, bypasses `subscribe()`). `onMutate()` fires on both; `setReadOnly()` gates `update()` only. All prefs/content edits must go through `store.update`.
  - `fs.ts` — File System Access API wrapper (`FileSession`), with a download-fallback path for browsers without the API (`session.handle === null` — no auto-save in that mode). Detects external file modification via `lastModified` and throws `ExternalChangeError`.
  - `save-controller.ts` — save orchestration: auto-save interval from `prefs.autoSaveMin`, `saveNow()` (coalesces in-flight saves into a trailing round), `flush()`, and `runExclusive()` for non-save writers (e.g. password change) so two writers never race the file handle.
- **`src/modules/`** — feature panes (daily notes, people trees, person notes, action items, milestones, risks). Each exports a render function registered with the pane manager in `main.ts` under a module id.
- **`src/ui/`** — shell, sidebar, pane manager (split view + per-pane history), command palette, search, modals, prefs. `dom.ts` `el()` is the DOM-building helper used everywhere.
- **`src/main.ts`** — wires everything: start screen → `onDocumentOpened` builds shell/store/panes/save-controller, registers hotkeys (Ctrl+S save, Ctrl+K palette, Alt+arrows history, Alt+1..9 team switch), and sets up cross-tab single-writer locking (Web Locks API + BroadcastChannel: one read-write tab per file, others read-only with a "take control" handshake). The in-memory password lives only in the module-level `app` closure — never on window/globals.

## Git workflow

- `main` is the release branch — PR-required, full gate (lint/typecheck/test + build on ubuntu+windows, CodeQL). `dev` takes direct commits — no feature branch required, light gate via `.githooks/pre-push` + CI. One-time setup per machine: `git config core.hooksPath .githooks` (see `.githooks/README.md` for the full gate list, including opt-in AI review gates via `ENABLE_AI=1`, dev-only).
- `dev → main` PRs are squash-merged. Squash-merging mints a new commit hash on `main`, which breaks file-level shared ancestry for anything touched on both branches since the last sync — a later edit to the same file on both sides can then hit a spurious add/add merge conflict (git has no common blob to 3-way-merge against) even when the content is fully compatible. Merge `main` back into `dev` (`git merge main`) right after each squash-merge, before starting new work, to keep them reconcilable.

## Conventions

- i18n: two locales, `pt-BR` and `en-US`, via `t(locale, key)` in `core/i18n.ts`. All user-visible strings go through `t()`; add keys for both locales.
- Every `src` module has a matching `test/*.test.ts`; tests run in jsdom and rely on browser APIs being feature-detected (Web Locks, BroadcastChannel, FS Access API absent in jsdom — code must degrade gracefully, which is also what keeps it testable).
- Comments referencing "Task N" trace decisions back to `docs/superpowers/plans/2026-07-02-team-tracker.md`; keep nontrivial concurrency/lifecycle reasoning documented in place the same way.
