# Git Hooks

Pre-push quality gates run automatically before every `git push` — the fast,
deterministic checks, so a broken push is caught locally in seconds instead of
by a red CI run minutes later.

The slower checks run in CI instead:

- **E2E** (`npm run test:e2e`, Playwright/Chromium) — `.github/workflows/ci.yml`'s
  `e2e` jobs, on every push to `dev` and every PR into `main`. Run as three parallel
  parts (the serial `leak.spec.ts` on its own runner, the rest in two shards); a release PR whose head commit already passed E2E on the `dev` push (and
  that `main` adds nothing to) skips the repeat.
- **`npm audit` / `npm outdated`** — `.github/workflows/deps-audit.yml`, weekly
  cron (plus `workflow_dispatch`). Fails on high/critical, same threshold the
  pre-push gate used.

## One-time setup (per machine)

```bash
git config core.hooksPath .githooks
```

## Gate summary

"Pushes to `dev`" means the refs git reports on the hook's stdin, not the
checked-out branch: `git push origin other-branch:dev` gets the dev gates,
while a push of only tags (e.g. `git push origin v2.8.3`) or only branch
deletions skips every gate. Run by hand from a terminal, the hook falls back
to the checked-out branch against `origin/dev`.

| Gate | Blocks push? | Notes |
|------|-------------|-------|
| Lint (`eslint src test`) | Yes | flat config, type-checked rules — see `eslint.config.mjs` |
| TypeCheck (`tsc --noEmit`) | Yes | |
| Tests (`vitest run`) | Yes | |
| Test coverage sanity | Yes (new files only) | dev pushes only — see below |
| Changelog entry | No | dev pushes only — warns if `package.json` version changed vs remote `dev` with no matching `## [x.y.z]` in `CHANGELOG.md`, and nags (also non-blocking) when that entry is wordy — more than 6 bullets or a line over 200 chars; CI hard-fails the missing-entry check on the `dev → main` PR |
| Remote dev is an ancestor | Yes | dev pushes only — fails fast with `git pull --rebase` advice when `origin/dev` has commits you lack (typically the release sync) |

### Test coverage sanity

`CLAUDE.md`'s "every `src` module gets a matching `test/*.test.ts`" convention is
effectively 1:1 today; the only exempt files are `src/core/types.ts` (type-only),
`src/main.ts` (wiring, covered by e2e), and `*.d.ts` ambient declarations. Scoped
to the commits this push lands on `dev` (remote `dev` tip → pushed commit):

- A **new** `src/**/*.ts` file with no matching `test/<name>.test.ts` **fails the
  push** — the convention is real, so this is a mistake, not a style choice.
- A **modified** `src/**/*.ts` file whose matching test file exists but wasn't
  touched in the same push only gets a **warning** — not every edit needs a new
  assertion, and this gate can't tell the difference.

The e2e suite runs in CI (see top of this file), not as a pre-push gate.

## Requirements

- Node.js + npm

## Bypass

```bash
git push --no-verify
```
