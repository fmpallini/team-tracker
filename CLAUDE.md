# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Team Tracker — a zero-runtime-dependency, single-file web app for tracking teams (people/hierarchy, daily and per-person notes, action items, milestones, risks). No server, no backend: all state lives in one password-encrypted `.tmv` file the user opens and saves themselves. The original design spec and implementation plan live in `docs/superpowers/`.

Desktop-only by design: the layout is a fixed desktop shell (sidebar + split panes), the UX is keyboard-driven (Ctrl+S/Ctrl+K/Alt+…), and mobile browsers lack the File System Access API the save flow depends on. Mobile devices get a blocking notice instead of the start screen — do not invest in responsive/mobile layouts.

## Commands

```
npm run build       # node scripts/build.mjs → dist/app.html + dist/pwa/
npm test            # vitest run (jsdom environment)
npx vitest run test/store.test.ts   # single test file
npm run test:watch  # vitest watch mode
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint src test
```

Default to the Bash tool (Git Bash) for shell commands in this repo — the `rtk` token-filtering hook only matches the Bash tool, not PowerShell. Use the PowerShell tool only for Windows-native tasks the Bash tool can't do (registry access, `icacls`, native exe calls that need `cmd.exe`/pwsh semantics).

Zero runtime dependencies is a hard constraint — `esbuild`, `typescript`, `vitest`, `jsdom` are dev-only. Do not add runtime deps.

## E2E tests (Playwright, `npm run test:e2e`)

`e2e/*.spec.ts` are Playwright specs (not vitest's — excluded from `vitest.config.ts`, not typechecked/linted by `npm run typecheck`/`npm run lint` since `tsconfig.json` only includes `src`/`test`). `npm run test:e2e` builds first, then runs against `dist/`. Chromium-only (`playwright.config.ts`'s sole project) — that's this app's userbase.

- `smoke.spec.ts` — loads `dist/app.html` via `file://`, like a real double-click. Chromium treats file:// as an *insecure* context, so `window.showOpenFilePicker` throws there and OPFS isn't available either — `e2e/opfs-shim.ts`'s `forceFallbackMode` removes the pickers before load so the app takes its real download-fallback path instead, same as any browser without the File System Access API.
- `fs-api.spec.ts` / `tab-lock.spec.ts` — served over `http://localhost` instead (`playwright.config.ts`'s `webServer`, backed by the zero-dep `e2e/static-server.mjs`), which Chromium treats as a *secure* context. `e2e/opfs-shim.ts`'s `installOpfsPickerShim` monkey-patches `showOpenFilePicker`/`showSaveFilePicker` to hand back real Origin Private File System (`navigator.storage.getDirectory()`) handles instead of invoking the native OS picker Playwright can't drive — same real `FileSystemFileHandle` interface the app uses in production, just sourced from sandboxed storage instead of a user click. This is what makes the real create → encrypt → write → close → reopen → decrypt round trip, the daily-backup mirror, and (via two `page`s in one `context`, sharing the same real Web Locks/`BroadcastChannel`/IndexedDB) the cross-tab single-writer handoff all testable headlessly.

## Build outputs (scripts/build.mjs)

Two variants are bundled from the same `src/main.ts` entry, differing only in the esbuild defines `__APP_VERSION__` (from package.json version) and `__PWA__`:

- `dist/app.html` — fully self-contained single file (CSS + JS inlined into `index.html` placeholders `/*__CSS__*/` and `/*__JS__*/`). Opened via `file://`; must never reference external files.
- `dist/pwa/` — same app with `__PWA__=true` (registers `sw.js`, only over http(s)), plus manifest/icon and a cache-first service worker whose cache name embeds the app version (`__APP_VERSION__` placeholder in `pwa/sw.js` replaced at build time).

Tests define `__PWA__: false` in `vitest.config.ts`, so the service-worker branch never runs under jsdom.

## Architecture

- **`src/core/`** — headless logic, no DOM construction:
  - `types.ts` / `document.ts` — the `Doc` shape, `SCHEMA_VERSION`, and the `migrate()` ladder (`MIGRATIONS[n]` mutates a version-n doc to n+1; opening a newer-schema file throws `SchemaTooNewError`). Bump the schema and add a migration whenever the persisted shape changes.
  - `crypto.ts` — `.tmv` binary format: `"TMV1"` magic + format version + PBKDF2-SHA256 (600k iterations) → AES-GCM, with a key-check block so wrong password (`WrongPasswordError`) is distinguishable from corruption (`CorruptFileError`). Payload is `JSON.stringify(doc)`, run through `migrate()` on decrypt. Alongside the encrypted path, `serializePlain`/`parsePlain` handle password-less files: an ASCII `TMV-PLAIN\n` header line followed by raw `JSON.stringify(doc)` — fully human-readable, detected by sniffing that header before ever prompting for a password.
  - `store.ts` — single mutable `Doc` holder. Two mutation channels: `update(fn, scope?)` (marks dirty, notifies `subscribe()` — full content re-render) and `updateNav()` (nav-only, bypasses `subscribe()`). `onMutate()` fires on both and receives the `MutationKind`; `setReadOnly()` gates `update()` only. All prefs/content edits must go through `store.update`. `rev` is a monotonic mutation counter for cache invalidation — the `Doc` is mutated in place, so object identity can never signal staleness.
  - `scope.ts` — `ChangeScope`/`Section` plus the pure `scopeAffects()` predicate that lets a `store.update()` describe what it changed. An absent scope means "everything changed", so unscoped call sites keep pre-scoping behavior. Never narrow a scope you aren't certain of: too narrow shows stale UI, too wide only costs a redundant render.
  - `pane-layout.ts` — the transient (never-persisted) half of pane layout: the un-split stash and history stepping, extracted from `ui/panes.ts` so navigation policy sits apart from DOM rendering.
  - `fs.ts` — File System Access API wrapper (`FileSession`), with a download-fallback path for browsers without the API (`session.handle === null` — no auto-save in that mode). Detects external file modification via `lastModified` and throws `ExternalChangeError`.
  - `save-controller.ts` — save orchestration: auto-save interval from `prefs.autoSaveMin`, `saveNow()` (coalesces in-flight saves into a trailing round), `flush()`, and `runExclusive()` for non-save writers (e.g. password change) so two writers never race the file handle. `backup-controller.ts` mirrors every successful save (and any password/format change) to a second, user-picked file handle (`prefs.dailyBackupEnabled`/`backupHandleId`) — a `.bck` sibling for corruption resilience, at most once every 24h except immediately after a password change.
  - `change-password.ts` — re-encrypts (or plain-serializes, for the password ↔ password-less transition) the current doc under a new password and persists it, wrapped in `save-controller.ts`'s `runExclusive()` so it can't interleave with a save. Extracted out of `main.ts` (which just wires its deps) specifically so this concurrency-sensitive path is unit testable.
  - `tab-lock.ts` — Task 25 cross-tab single-writer coordination (Web Locks API + `BroadcastChannel` "take control" handshake). Also extracted out of `main.ts`, with `navigator.locks`/`BroadcastChannel` passed in as deps so tests can fake them (jsdom has no Web Locks API at all).
  - `idb.ts` — minimal single-connection IndexedDB key/value wrapper (`idbGet`/`idbSet`/`idbDel`), used to persist file/backup handles across sessions. Every *other* module mocks this out; its own tests use `fake-indexeddb` (dev-only) since jsdom has no real `indexedDB`.
- **`src/modules/`** — feature panes (daily notes, people trees, person notes, action items, milestones, risks). Each exports a render function registered with the pane manager in `main.ts` under a module id. Every renderer is wrapped in `lifecycle.ts`'s `withDisposal()`, which tears down whatever instance was previously mounted into a container before mounting a new one — including an instance of a *different* module, since `ui/panes.ts` reuses one body element across module switches. A renderer's returned teardown must release everything it attached outside `container` (its `store.subscribe` unsubscribe above all); `test/lifecycle.test.ts` counts live subscriptions to catch a dropped one.
- **`src/ui/`** — shell, sidebar, pane manager (split view + per-pane history), command palette, search, modals, prefs. `dom.ts` `el()` is the DOM-building helper used everywhere.
- **`src/main.ts`** — wires everything: start screen → `onDocumentOpened` builds shell/store/panes/save-controller, registers hotkeys (Ctrl+S save, Ctrl+K palette, Alt+arrows history, Alt+1..9 team switch), and sets up cross-tab single-writer locking (Web Locks API + BroadcastChannel: one read-write tab per file, others read-only with a "take control" handshake). The in-memory password lives only in the module-level `app` closure — never on window/globals.

## Git workflow

- `main` is the release branch — PR-required, full gate (lint/typecheck/test + build on ubuntu+windows, CodeQL). `dev` takes direct commits — no feature branch required, light gate via `.githooks/pre-push` + CI. One-time setup per machine: `git config core.hooksPath .githooks` (see `.githooks/README.md` for the full gate list, including opt-in AI review gates via `ENABLE_AI=1`, dev-only).
- `dev → main` PRs are merged with a **merge commit** (`gh pr merge --merge`), never squash. A merge commit's parents include `dev`'s actual tip, so `dev` is immediately an ancestor of `main` again — no separate "sync dev back" step needed, and `dev`'s ahead-count never drifts. (Squash was the original convention here and was abandoned: it mints a brand-new commit hash on `main` untethered from `dev`'s commits, so `dev` accumulates a permanently-growing "ahead" count that no amount of merging `main` back into `dev` can resolve — git compares commit ancestry, not diff content. If `main`/`dev` ever visibly diverge again — GitHub showing `dev` N commits ahead with 0 behind — suspect a squash-merged PR and check `git rev-list --count origin/main..origin/dev`.)
- No worktrees. All dev work happens directly on `dev` in this single checkout — don't create git worktrees or feature branches for tasks here, even when a skill suggests it.

## Conventions

- i18n: two locales, `pt-BR` and `en-US`, via `t(locale, key)` in `core/i18n.ts`. All user-visible strings go through `t()`; add keys for both locales.
- Every `src` module has a matching `test/*.test.ts`; tests run in jsdom and rely on browser APIs being feature-detected (Web Locks, BroadcastChannel, FS Access API absent in jsdom — code must degrade gracefully, which is also what keeps it testable).
- Comments referencing "Task N" trace decisions back to `docs/superpowers/plans/2026-07-02-team-tracker.md`; keep nontrivial concurrency/lifecycle reasoning documented in place the same way.
