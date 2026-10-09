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

- **`src/core/`** — headless logic, no DOM construction. Per-module notes (schema/migrations, `.tmv` crypto format, store mutation channels, scope, switcher, pane layout, fs, save/backup controllers, change-password, tab lock, idb) live in `src/core/CLAUDE.md`, loaded when working there.
- **`src/modules/`** — feature panes (daily notes, people trees, person notes, action items, milestones, risks). Each exports render function registered with pane manager in `main.ts` under module id. Every renderer wrapped in `lifecycle.ts`'s `withDisposal()`, tears down whatever instance previously mounted into container before mounting new one — including instance of *different* module, since `ui/panes.ts` reuses one body element across module switches. Renderer's returned teardown must release everything attached outside `container` (its `store.subscribe` unsubscribe above all); `test/lifecycle.test.ts` counts live subscriptions to catch dropped one.
- **`src/ui/`** — shell, sidebar, pane manager (split view + per-pane history), command palette, search, modals, prefs. `dom.ts` `el()` DOM-building helper used everywhere.
- **`src/main.ts`** — wires everything: start screen → `onDocumentOpened` builds shell/store/panes/save-controller, registers hotkeys (Ctrl+S save, Ctrl+K palette, Alt+arrows history, Alt+1..9 team switch), sets up cross-tab single-writer locking (Web Locks API + BroadcastChannel: one read-write tab per file, others read-only with "take control" handshake). In-memory password lives only in module-level `app` closure — never on window/globals.

## Git workflow

- `main` release branch — PR-required, full gate: lint/typecheck/test, build on ubuntu+windows, CodeQL, and `changelog-gate` (a PR bumping `package.json` version must add a matching non-empty `## [X.Y.Z]` to `CHANGELOG.md`). `dev` takes direct commits — no feature branch, light gate via `.githooks/pre-push` + CI. One-time setup per machine: `git config core.hooksPath .githooks`. `.githooks/README.md` has the full gate list and what runs where (fast checks in pre-push; e2e and weekly `deps-audit.yml` in CI; opt-in `ENABLE_AI=1` review gates).
- `dev → main` PRs merged with a **merge commit** (`gh pr merge --merge`), never squash — the merge commit's parents include `dev`'s tip, so `dev` stays an ancestor of `main` and its ahead-count never drifts. (Squash mints a new hash on `main` untethered from `dev`'s commits, so `dev` diverges permanently — git compares ancestry, not diff. If GitHub ever shows `dev` N ahead / 0 behind, suspect a squash-merged PR: `git rev-list --count origin/main..origin/dev`.)
- No worktrees. All dev work happens directly on `dev` in this single checkout — don't create git worktrees or feature branches for tasks here, even when skill suggests it.

## Changelog

Every `package.json` version bump needs a matching non-empty `## [X.Y.Z]` entry in `CHANGELOG.md` (CI `changelog-gate`). Load the `changelog` skill for the full rules before writing one. Keep entries short: a line or two per change, folding sweeping ones into a single headline bullet rather than listing every screen or button touched (the pre-push hook nags past 6 bullets or a 200-char line).

## Conventions

- i18n: two locales, `pt-BR` and `en-US`, via `t(locale, key)` in `core/i18n.ts`. All user-visible strings go through `t()`; add keys for both locales.
- Every `src` module has a matching `test/*.test.ts` (except type-only `core/types.ts`, wiring-only `main.ts`, and `*.d.ts`); tests run in jsdom, rely on browser APIs being feature-detected (Web Locks, BroadcastChannel, FS Access API absent in jsdom — code must degrade gracefully, also what keeps it testable).
- Comments referencing "Task N" trace decisions back to `docs/superpowers/plans/2026-07-02-team-tracker.md`; keep nontrivial concurrency/lifecycle reasoning documented in place same way.