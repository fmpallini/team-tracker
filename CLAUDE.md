# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

## Project

Team Tracker — zero-runtime-dependency single-file web app tracking teams (people/hierarchy, daily and per-person notes, action items, milestones, risks). No server, no backend: all state lives in one `.tmv` file — AES-GCM encrypted, or plain-text password-less — the user opens and saves themselves. Original design spec + implementation plan in `docs/superpowers/`.

Desktop-only by design: layout fixed desktop shell (sidebar + split panes), UX keyboard-driven (Ctrl+S/Ctrl+K/Alt+…), mobile browsers lack the File System Access API the save flow depends on. Mobile devices get blocking notice instead of start screen — don't invest in responsive/mobile layouts.

## Commands

Zero runtime dependencies hard constraint — `esbuild`, `typescript`, `vitest`, `jsdom`, `@playwright/test` dev-only. No runtime deps added.

## E2E tests

Playwright specs live in `e2e/` (`npm run test:e2e`); details in `e2e/CLAUDE.md`.

## Build outputs (scripts/build.mjs)

Two variants bundled from same `src/main.ts` entry, differing only in esbuild defines `__APP_VERSION__` (from package.json version) and `__PWA__`:

- `dist/app.html` — fully self-contained single file (CSS + JS inlined into `index.html` placeholders `/*__CSS__*/` and `/*__JS__*/`). Opened via `file://`; must never reference external files.
- `dist/pwa/` — same app with `__PWA__=true` (registers `sw.js`, only over http(s)), plus manifest/icon and cache-first service worker whose cache name embeds app version (`__APP_VERSION__` placeholder in `pwa/sw.js` replaced at build time).

Tests define `__PWA__: false` in `vitest.config.ts`, so service-worker branch never runs under jsdom.

## Architecture

- **`src/core/`** — headless logic, no DOM construction:
  - `types.ts` / `document.ts` — `Doc` shape, `SCHEMA_VERSION`, `migrate()` ladder (`MIGRATIONS[n]` mutates version-n doc to n+1; opening newer-schema file throws `SchemaTooNewError`). Bump schema + add migration whenever persisted shape changes. `crypto.ts`'s `decryptDocumentWithVersion`/`parsePlainWithVersion` also return a file's pre-migration `schemaVersion` from the same single decrypt/parse — `main.ts`'s `onDocumentOpened` uses this to detect "a migration just ran on open" and fire one backup snapshot of the original, unmigrated bytes before any edit/autosave can overwrite them.
  - `crypto.ts` — `.tmv` binary format: `"TMV1"` magic + format version + PBKDF2-SHA256 (600k iterations) → AES-GCM, with key-check block so wrong password (`WrongPasswordError`) distinguishable from corruption (`CorruptFileError`). Payload `JSON.stringify(doc)`, run through `migrate()` on decrypt. Alongside encrypted path, `serializePlain`/`parsePlain` handle password-less files: ASCII `TMV-PLAIN\n` header line followed by raw `JSON.stringify(doc)` — fully human-readable, detected by sniffing that header before ever prompting for password.
  - `store.ts` — single mutable `Doc` holder. Two mutation channels: `update(fn, scope?)` (marks dirty, notifies `subscribe()` — full content re-render) and `updateNav()` (nav-only, bypasses `subscribe()`). `onMutate()` fires on both, receives `MutationKind`; `setReadOnly()` gates `update()` only. All prefs/content edits must go through `store.update`. `rev` monotonic mutation counter for cache invalidation — `Doc` mutated in place, so object identity never signals staleness.
  - `scope.ts` — `ChangeScope`/`Section` plus pure `scopeAffects()` predicate letting `store.update()` describe what it changed. Absent scope means "everything changed" — unscoped call sites keep pre-scoping behavior. Never narrow scope not certain of: too narrow shows stale UI, too wide only costs redundant render.
  - `switcher.ts` / `module-items.ts` — pure model of the Ctrl+Shift+K fast switch (Favorites → Due dates → Current team → Other teams; matching, favorite dedupe, 20-row cap via `allocateRows`) and the shared `buildModuleItems`/`titleFor` row builders. `ui/palette.ts` only renders it.
  - `pane-layout.ts` — transient (never-persisted) half of pane layout: un-split stash and history stepping, extracted from `ui/panes.ts` so navigation policy sits apart from DOM rendering.
  - `fs.ts` — File System Access API wrapper (`FileSession`), with download-fallback path for browsers without API (`session.handle === null` — no auto-save in that mode). Detects external file modification via `lastModified`, throws `ExternalChangeError`.
  - `save-controller.ts` — save orchestration: auto-save interval from `prefs.autoSaveMin`, `saveNow()` (coalesces in-flight saves into trailing round), `flush()`, `runExclusive()` for non-save writers (e.g. password change) so two writers never race the file handle. `backup-controller.ts` mirrors every successful save (and any password/format change) to a second, user-picked handle (`prefs.dailyBackupEnabled`/`backupHandleId`) — `.bck` sibling for corruption resilience, throttled to `prefs.backupFrequency` (`'daily'` → 24h, `'hourly'` → 1h), except immediately after a password change. Interval-gate seeding (from the `.bck`'s own `lastModified`, so the gate survives a reopen) is documented in `backup-controller.ts`'s header. `currentHealth()` is the single priority-ordered source of truth (orphaned → lapsed grant → stale password → write failure → `'ok'`) that the save pill, the Backup prefs tab, and `change-password.ts`'s post-write check all read, so a backup problem gets its own badge/message distinct from a primary-file save problem instead of the two being indistinguishable.
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

Every `package.json` version bump needs a matching non-empty `## [X.Y.Z]` entry in `CHANGELOG.md` (CI `changelog-gate`). Load the `changelog` skill for the full rules before writing one.

## Conventions

- i18n: two locales, `pt-BR` and `en-US`, via `t(locale, key)` in `core/i18n.ts`. All user-visible strings go through `t()`; add keys for both locales.
- Every `src` module has a matching `test/*.test.ts` (except type-only `core/types.ts`, wiring-only `main.ts`, and `*.d.ts`); tests run in jsdom, rely on browser APIs being feature-detected (Web Locks, BroadcastChannel, FS Access API absent in jsdom — code must degrade gracefully, also what keeps it testable).
- Comments referencing "Task N" trace decisions back to `docs/superpowers/plans/2026-07-02-team-tracker.md`; keep nontrivial concurrency/lifecycle reasoning documented in place same way.