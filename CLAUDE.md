# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

## Project

Team Tracker — zero-runtime-dependency single-file web app tracking teams (people/hierarchy, daily and per-person notes, action items, milestones, risks). No server, no backend: all state lives in one `.tmv` file — AES-GCM encrypted, or plain-text password-less — the user opens and saves themselves. Original design spec + implementation plan in `docs/superpowers/`.

Desktop-only by design: layout fixed desktop shell (sidebar + split panes), UX keyboard-driven (Ctrl+S/Ctrl+K/Alt+…), mobile browsers lack the File System Access API the save flow depends on. Mobile devices get blocking notice instead of start screen — don't invest in responsive/mobile layouts.

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

Zero runtime dependencies hard constraint — `esbuild`, `typescript`, `vitest`, `jsdom`, `@playwright/test` dev-only. No runtime deps added.

## E2E tests (Playwright, `npm run test:e2e`)

`e2e/*.spec.ts` Playwright specs (not vitest's — excluded from `vitest.config.ts`, not typechecked/linted by `npm run typecheck`/`npm run lint` since `tsconfig.json` only includes `src`/`test`). `npm run test:e2e` builds first, runs against `dist/`. Chromium-only (`playwright.config.ts`'s sole project) — that's this app's userbase.

- `smoke.spec.ts` — loads `dist/app.html` over `file://`, like a real double-click. `e2e/opfs-shim.ts`'s `forceFallbackMode` strips the pickers before load, so the app takes its real download-fallback path (Chromium treats `file://` as insecure — no FS Access API, no OPFS).
- `fs-api.spec.ts` / `tab-lock.spec.ts` — served over `http://localhost` (`playwright.config.ts`'s `webServer` → zero-dep `e2e/static-server.mjs`), a secure context. `e2e/opfs-shim.ts`'s `installOpfsPickerShim` swaps the native pickers for OPFS-backed real `FileSystemFileHandle`s, so full create → encrypt → write → reopen → decrypt round trips, the backup mirror, and cross-tab single-writer handoff (two `page`s in one `context`) all run headlessly.

The insecure/secure-context reasoning and shim internals live in `e2e/opfs-shim.ts`'s header comment — treat that as the single source.

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
  - `save-controller.ts` — save orchestration: auto-save interval from `prefs.autoSaveMin`, `saveNow()` (coalesces in-flight saves into trailing round), `flush()`, `runExclusive()` for non-save writers (e.g. password change) so two writers never race the file handle. `backup-controller.ts` mirrors every successful save (and any password/format change) to a second, user-picked handle (`prefs.dailyBackupEnabled`/`backupHandleId`) — `.bck` sibling for corruption resilience, throttled to `prefs.backupFrequency` (`'daily'` → 24h, `'hourly'` → 1h), except immediately after a password change. Interval-gate seeding (from the `.bck`'s own `lastModified`, so the gate survives a reopen) is documented in `backup-controller.ts`'s header.
  - `change-password.ts` — re-encrypts (or plain-serializes, for password ↔ password-less transition) current doc under new password, persists it, wrapped in `save-controller.ts`'s `runExclusive()` so can't interleave with save. Extracted out of `main.ts` (which just wires its deps) specifically so this concurrency-sensitive path unit testable.
  - `tab-lock.ts` — Task 25 cross-tab single-writer coordination (Web Locks API + `BroadcastChannel` "take control" handshake). Also extracted out of `main.ts`, with `navigator.locks`/`BroadcastChannel` passed in as deps so tests can fake them (jsdom has no Web Locks API at all).
  - `idb.ts` — minimal single-connection IndexedDB key/value wrapper (`idbGet`/`idbSet`/`idbDel`), persists file/backup handles across sessions. Every *other* module mocks this out; own tests use `fake-indexeddb` (dev-only) since jsdom has no real `indexedDB`.
- **`src/modules/`** — feature panes (daily notes, people trees, person notes, action items, milestones, risks). Each exports render function registered with pane manager in `main.ts` under module id. Every renderer wrapped in `lifecycle.ts`'s `withDisposal()`, tears down whatever instance previously mounted into container before mounting new one — including instance of *different* module, since `ui/panes.ts` reuses one body element across module switches. Renderer's returned teardown must release everything attached outside `container` (its `store.subscribe` unsubscribe above all); `test/lifecycle.test.ts` counts live subscriptions to catch dropped one.
- **`src/ui/`** — shell, sidebar, pane manager (split view + per-pane history), command palette, search, modals, prefs. `dom.ts` `el()` DOM-building helper used everywhere.
- **`src/main.ts`** — wires everything: start screen → `onDocumentOpened` builds shell/store/panes/save-controller, registers hotkeys (Ctrl+S save, Ctrl+K palette, Alt+arrows history, Alt+1..9 team switch), sets up cross-tab single-writer locking (Web Locks API + BroadcastChannel: one read-write tab per file, others read-only with "take control" handshake). In-memory password lives only in module-level `app` closure — never on window/globals.

## Git workflow

- `main` release branch — PR-required, full gate: lint/typecheck/test, build on ubuntu+windows, CodeQL, and `changelog-gate` (a PR bumping `package.json` version must add a matching non-empty `## [X.Y.Z]` to `CHANGELOG.md`). `dev` takes direct commits — no feature branch, light gate via `.githooks/pre-push` + CI. One-time setup per machine: `git config core.hooksPath .githooks`. `.githooks/README.md` has the full gate list and what runs where (fast checks in pre-push; e2e and weekly `deps-audit.yml` in CI; opt-in `ENABLE_AI=1` review gates).
- `dev → main` PRs merged with a **merge commit** (`gh pr merge --merge`), never squash — the merge commit's parents include `dev`'s tip, so `dev` stays an ancestor of `main` and its ahead-count never drifts. (Squash mints a new hash on `main` untethered from `dev`'s commits, so `dev` diverges permanently — git compares ancestry, not diff. If GitHub ever shows `dev` N ahead / 0 behind, suspect a squash-merged PR: `git rev-list --count origin/main..origin/dev`.)
- No worktrees. All dev work happens directly on `dev` in this single checkout — don't create git worktrees or feature branches for tasks here, even when skill suggests it.

## Changelog

`CHANGELOG.md` source of truth for GitHub release notes — `.github/workflows/release.yml` extracts section matching pushed tag's version, uses via `--notes-file` instead of `--generate-notes` (falls back to auto-generated PR-title notes only if no matching entry exists, so missed update degrades instead of blocking release). Enforced upstream of that: CI's `changelog-gate` fails any `dev → main` PR that bumps `package.json` version without a matching, non-empty `## [X.Y.Z]` section — so the fallback is a safety net, not the normal path.

- **When**: add or update `## [X.Y.Z]` entry in same commit/PR that bumps `version` in `package.json` — whether dedicated `chore: bump version` commit or bundled into feature commit. Version in header must match `package.json` exactly (extraction literal string match on `## [<version>]`).
- **Where**: newest entry at top, directly under header block. Format [Keep a Changelog](https://keepachangelog.com/)-flavored: `### Added` / `### Changed` / `### Fixed` subsections; omit any subsection with nothing in it.
- **Audience**: file read by end users on GitHub releases page, not developers reading diff. Describe what changed *for person using app* — symptom fixed or capability added — not implementation. "Copying notes as plain text lost nested-list indentation" not "`htmlToPlainText`'s list renderer now indents 2 spaces per depth level." Skip anything with no user-visible effect (dependency bumps, CI tweaks, internal refactors, test-only changes) — if whole release like that, write one line: `_No user-facing changes — internal cleanup only._` instead of empty subsections.
- **Scope is the whole span since the last release tag, not the last commit.** Before writing, enumerate every commit in `git log <last-version-tag>..HEAD` (equivalently, the full commit range of the `dev → main` release PR). Walk all of them and write one entry per user-facing feature/fix in that range — never base the entry on a single commit when the release bundles several.
- **Skip fixes for bugs that never shipped.** If a bug was introduced *and* fixed within the same unreleased cycle — no tagged release between the commit that caused it and the commit that fixed it — omit it. Users never experienced it, so it's noise. Only changelog fixes for behavior that was broken in a previously released version.
- Don't backfill or rewrite entries for already-tagged releases except to fix factual error — treat published entries as immutable history, same as git tag they describe.

## Conventions

- i18n: two locales, `pt-BR` and `en-US`, via `t(locale, key)` in `core/i18n.ts`. All user-visible strings go through `t()`; add keys for both locales.
- Every `src` module has a matching `test/*.test.ts` (except type-only `core/types.ts`, wiring-only `main.ts`, and `*.d.ts`); tests run in jsdom, rely on browser APIs being feature-detected (Web Locks, BroadcastChannel, FS Access API absent in jsdom — code must degrade gracefully, also what keeps it testable).
- Comments referencing "Task N" trace decisions back to `docs/superpowers/plans/2026-07-02-team-tracker.md`; keep nontrivial concurrency/lifecycle reasoning documented in place same way.