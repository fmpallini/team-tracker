# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

## Project

Team Tracker — zero-runtime-dependency single-file web app tracking teams (people/hierarchy, daily and per-person notes, action items, milestones, risks). No server, no backend: all state lives in one password-encrypted `.tmv` file user opens and saves self. Original design spec + implementation plan in `docs/superpowers/`.

Desktop-only by design: layout fixed desktop shell (sidebar + split panes), UX keyboard-driven (Ctrl+S/Ctrl+K/Alt+…), mobile browsers lack File System Access API save flow depends on. Mobile devices get blocking notice instead of start screen — don't invest in responsive/mobile layouts.

## Commands

```
npm run build       # node scripts/build.mjs → dist/app.html + dist/pwa/
npm test            # vitest run (jsdom environment)
npx vitest run test/store.test.ts   # single test file
npm run test:watch  # vitest watch mode
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint src test
```

Default to Bash tool (Git Bash) for shell commands here — `rtk` token-filtering hook only matches Bash tool, not PowerShell. Use PowerShell tool only for Windows-native tasks Bash can't do (registry access, `icacls`, native exe calls needing `cmd.exe`/pwsh semantics).

Zero runtime dependencies hard constraint — `esbuild`, `typescript`, `vitest`, `jsdom` dev-only. No runtime deps added.

## E2E tests (Playwright, `npm run test:e2e`)

`e2e/*.spec.ts` Playwright specs (not vitest's — excluded from `vitest.config.ts`, not typechecked/linted by `npm run typecheck`/`npm run lint` since `tsconfig.json` only includes `src`/`test`). `npm run test:e2e` builds first, runs against `dist/`. Chromium-only (`playwright.config.ts`'s sole project) — that's this app's userbase.

- `smoke.spec.ts` — loads `dist/app.html` via `file://`, like real double-click. Chromium treats file:// as *insecure* context, so `window.showOpenFilePicker` throws there, OPFS unavailable too — `e2e/opfs-shim.ts`'s `forceFallbackMode` removes pickers before load so app takes real download-fallback path instead, same as any browser without File System Access API.
- `fs-api.spec.ts` / `tab-lock.spec.ts` — served over `http://localhost` instead (`playwright.config.ts`'s `webServer`, backed by zero-dep `e2e/static-server.mjs`), which Chromium treats as *secure* context. `e2e/opfs-shim.ts`'s `installOpfsPickerShim` monkey-patches `showOpenFilePicker`/`showSaveFilePicker` to hand back real Origin Private File System (`navigator.storage.getDirectory()`) handles instead of invoking native OS picker Playwright can't drive — same real `FileSystemFileHandle` interface app uses in production, just sourced from sandboxed storage instead of user click. This makes real create → encrypt → write → close → reopen → decrypt round trip, daily-backup mirror, and (via two `page`s in one `context`, sharing same real Web Locks/`BroadcastChannel`/IndexedDB) cross-tab single-writer handoff all testable headlessly.

## Build outputs (scripts/build.mjs)

Two variants bundled from same `src/main.ts` entry, differing only in esbuild defines `__APP_VERSION__` (from package.json version) and `__PWA__`:

- `dist/app.html` — fully self-contained single file (CSS + JS inlined into `index.html` placeholders `/*__CSS__*/` and `/*__JS__*/`). Opened via `file://`; must never reference external files.
- `dist/pwa/` — same app with `__PWA__=true` (registers `sw.js`, only over http(s)), plus manifest/icon and cache-first service worker whose cache name embeds app version (`__APP_VERSION__` placeholder in `pwa/sw.js` replaced at build time).

Tests define `__PWA__: false` in `vitest.config.ts`, so service-worker branch never runs under jsdom.

## Architecture

- **`src/core/`** — headless logic, no DOM construction:
  - `types.ts` / `document.ts` — `Doc` shape, `SCHEMA_VERSION`, `migrate()` ladder (`MIGRATIONS[n]` mutates version-n doc to n+1; opening newer-schema file throws `SchemaTooNewError`). Bump schema + add migration whenever persisted shape changes.
  - `crypto.ts` — `.tmv` binary format: `"TMV1"` magic + format version + PBKDF2-SHA256 (600k iterations) → AES-GCM, with key-check block so wrong password (`WrongPasswordError`) distinguishable from corruption (`CorruptFileError`). Payload `JSON.stringify(doc)`, run through `migrate()` on decrypt. Alongside encrypted path, `serializePlain`/`parsePlain` handle password-less files: ASCII `TMV-PLAIN\n` header line followed by raw `JSON.stringify(doc)` — fully human-readable, detected by sniffing that header before ever prompting for password.
  - `store.ts` — single mutable `Doc` holder. Two mutation channels: `update(fn, scope?)` (marks dirty, notifies `subscribe()` — full content re-render) and `updateNav()` (nav-only, bypasses `subscribe()`). `onMutate()` fires on both, receives `MutationKind`; `setReadOnly()` gates `update()` only. All prefs/content edits must go through `store.update`. `rev` monotonic mutation counter for cache invalidation — `Doc` mutated in place, so object identity never signals staleness.
  - `scope.ts` — `ChangeScope`/`Section` plus pure `scopeAffects()` predicate letting `store.update()` describe what it changed. Absent scope means "everything changed" — unscoped call sites keep pre-scoping behavior. Never narrow scope not certain of: too narrow shows stale UI, too wide only costs redundant render.
  - `pane-layout.ts` — transient (never-persisted) half of pane layout: un-split stash and history stepping, extracted from `ui/panes.ts` so navigation policy sits apart from DOM rendering.
  - `fs.ts` — File System Access API wrapper (`FileSession`), with download-fallback path for browsers without API (`session.handle === null` — no auto-save in that mode). Detects external file modification via `lastModified`, throws `ExternalChangeError`.
  - `save-controller.ts` — save orchestration: auto-save interval from `prefs.autoSaveMin`, `saveNow()` (coalesces in-flight saves into trailing round), `flush()`, `runExclusive()` for non-save writers (e.g. password change) so two writers never race file handle. `backup-controller.ts` mirrors every successful save (and any password/format change) to second, user-picked file handle (`prefs.dailyBackupEnabled`/`backupHandleId`) — `.bck` sibling for corruption resilience, throttled to interval implied by `prefs.backupFrequency` (`'daily'` → 24h, `'hourly'` → 1h) except immediately after password change.
  - `change-password.ts` — re-encrypts (or plain-serializes, for password ↔ password-less transition) current doc under new password, persists it, wrapped in `save-controller.ts`'s `runExclusive()` so can't interleave with save. Extracted out of `main.ts` (which just wires its deps) specifically so this concurrency-sensitive path unit testable.
  - `tab-lock.ts` — Task 25 cross-tab single-writer coordination (Web Locks API + `BroadcastChannel` "take control" handshake). Also extracted out of `main.ts`, with `navigator.locks`/`BroadcastChannel` passed in as deps so tests can fake them (jsdom has no Web Locks API at all).
  - `idb.ts` — minimal single-connection IndexedDB key/value wrapper (`idbGet`/`idbSet`/`idbDel`), persists file/backup handles across sessions. Every *other* module mocks this out; own tests use `fake-indexeddb` (dev-only) since jsdom has no real `indexedDB`.
- **`src/modules/`** — feature panes (daily notes, people trees, person notes, action items, milestones, risks). Each exports render function registered with pane manager in `main.ts` under module id. Every renderer wrapped in `lifecycle.ts`'s `withDisposal()`, tears down whatever instance previously mounted into container before mounting new one — including instance of *different* module, since `ui/panes.ts` reuses one body element across module switches. Renderer's returned teardown must release everything attached outside `container` (its `store.subscribe` unsubscribe above all); `test/lifecycle.test.ts` counts live subscriptions to catch dropped one.
- **`src/ui/`** — shell, sidebar, pane manager (split view + per-pane history), command palette, search, modals, prefs. `dom.ts` `el()` DOM-building helper used everywhere.
- **`src/main.ts`** — wires everything: start screen → `onDocumentOpened` builds shell/store/panes/save-controller, registers hotkeys (Ctrl+S save, Ctrl+K palette, Alt+arrows history, Alt+1..9 team switch), sets up cross-tab single-writer locking (Web Locks API + BroadcastChannel: one read-write tab per file, others read-only with "take control" handshake). In-memory password lives only in module-level `app` closure — never on window/globals.

## Git workflow

- `main` release branch — PR-required, full gate (lint/typecheck/test + build on ubuntu+windows, CodeQL). `dev` takes direct commits — no feature branch required, light gate via `.githooks/pre-push` + CI. One-time setup per machine: `git config core.hooksPath .githooks` (see `.githooks/README.md` for full gate list, including opt-in AI review gates via `ENABLE_AI=1`, dev-only).
- `dev → main` PRs merged with **merge commit** (`gh pr merge --merge`), never squash. Merge commit's parents include `dev`'s actual tip, so `dev` immediately ancestor of `main` again — no separate "sync dev back" step needed, `dev`'s ahead-count never drifts. (Squash was original convention here, abandoned: mints brand-new commit hash on `main` untethered from `dev`'s commits, so `dev` accumulates permanently-growing "ahead" count no amount of merging `main` back into `dev` resolves — git compares commit ancestry, not diff content. If `main`/`dev` ever visibly diverge again — GitHub showing `dev` N commits ahead with 0 behind — suspect squash-merged PR, check `git rev-list --count origin/main..origin/dev`.)
- No worktrees. All dev work happens directly on `dev` in this single checkout — don't create git worktrees or feature branches for tasks here, even when skill suggests it.

## Changelog

`CHANGELOG.md` source of truth for GitHub release notes — `.github/workflows/release.yml` extracts section matching pushed tag's version, uses via `--notes-file` instead of `--generate-notes` (falls back to auto-generated PR-title notes only if no matching entry exists, so missed update degrades instead of blocking release).

- **When**: add or update `## [X.Y.Z]` entry in same commit/PR that bumps `version` in `package.json` — whether dedicated `chore: bump version` commit or bundled into feature commit. Version in header must match `package.json` exactly (extraction literal string match on `## [<version>]`).
- **Where**: newest entry at top, directly under header block. Format [Keep a Changelog](https://keepachangelog.com/)-flavored: `### Added` / `### Changed` / `### Fixed` subsections; omit any subsection with nothing in it.
- **Audience**: file read by end users on GitHub releases page, not developers reading diff. Describe what changed *for person using app* — symptom fixed or capability added — not implementation. "Copying notes as plain text lost nested-list indentation" not "`htmlToPlainText`'s list renderer now indents 2 spaces per depth level." Skip anything with no user-visible effect (dependency bumps, CI tweaks, internal refactors, test-only changes) — if whole release like that, write one line: `_No user-facing changes — internal cleanup only._` instead of empty subsections.
- **Multi-PR releases**: when `dev → main` release PR bundles several feature commits (this project's convention — see Git workflow above), write one changelog entry per user-facing feature/fix bundled in, not one per commit.
- Don't backfill or rewrite entries for already-tagged releases except to fix factual error — treat published entries as immutable history, same as git tag they describe.

## Conventions

- i18n: two locales, `pt-BR` and `en-US`, via `t(locale, key)` in `core/i18n.ts`. All user-visible strings go through `t()`; add keys for both locales.
- Every `src` module has matching `test/*.test.ts`; tests run in jsdom, rely on browser APIs being feature-detected (Web Locks, BroadcastChannel, FS Access API absent in jsdom — code must degrade gracefully, also what keeps it testable).
- Comments referencing "Task N" trace decisions back to `docs/superpowers/plans/2026-07-02-team-tracker.md`; keep nontrivial concurrency/lifecycle reasoning documented in place same way.