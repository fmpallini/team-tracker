# Git Hooks

Pre-push quality gates run automatically before every `git push` — the fast,
deterministic checks, so a broken push is caught locally in seconds instead of
by a red CI run minutes later.

The slower checks run in CI instead:

- **E2E** (`npm run test:e2e`, Playwright/Chromium) — `.github/workflows/ci.yml`'s
  `e2e` job, on every push to `dev` and every PR into `main`.
- **`npm audit` / `npm outdated`** — `.github/workflows/deps-audit.yml`, weekly
  cron (plus `workflow_dispatch`). Fails on high/critical, same threshold the
  pre-push gate used.

## One-time setup (per machine)

```bash
git config core.hooksPath .githooks
```

## Gate summary

| Gate | Blocks push? | Notes |
|------|-------------|-------|
| Lint (`eslint src test`) | Yes | flat config, type-checked rules — see `eslint.config.mjs` |
| TypeCheck (`tsc --noEmit`) | Yes | |
| Tests (`vitest run`) | Yes | |
| Test coverage sanity | Yes (new files only) | dev pushes only — see below |
| Changelog entry | No | dev pushes only — warns if `package.json` version changed vs `origin/dev` with no matching `## [x.y.z]` in `CHANGELOG.md`; CI hard-fails the same check on the `dev → main` PR |
| AI: Simplify / Security review / Bug hunt / Test Coverage | Yes (HIGH only) | opt-in (`ENABLE_AI=1`), dev pushes only, requires `claude` CLI — see [AI gates](#ai-gates) |

### Test coverage sanity

`CLAUDE.md`'s "every `src` module gets a matching `test/*.test.ts`" convention is
effectively 1:1 today; the only exempt files are `src/core/types.ts` (type-only),
`src/main.ts` (wiring, covered by e2e), and `*.d.ts` ambient declarations. Scoped
to the diff against `origin/dev` on pushes to `dev`:

- A **new** `src/**/*.ts` file with no matching `test/<name>.test.ts` **fails the
  push** — the convention is real, so this is a mistake, not a style choice.
- A **modified** `src/**/*.ts` file whose matching test file exists but wasn't
  touched in the same push only gets a **warning** — not every edit needs a new
  assertion, and this gate can't tell the difference.

Whether an existing test actually exercises the *new* behavior (as opposed to
merely existing) is a judgment call this gate can't make — that's what the AI
Test Coverage gate below is for.

The e2e suite runs in CI (see top of this file), not as a pre-push gate — and
*whether a given change needed a new/updated e2e spec* is still judgment-based,
folded into the AI Test Coverage gate instead of a hard rule.

## AI gates

Run only when pushing to `dev` — that's the branch that now takes direct
commits with no PR in front of them, so it's the one spot an AI second look
at the diff earns its keep. Pushes to any other branch skip this phase
entirely; `main` only ever changes via a reviewed PR anyway.

They're opt-in, off by default — every push skips them unless you ask for
them:

```bash
ENABLE_AI=1 git push
```

The prefix must be on `git push` itself — `ENABLE_AI=1 git commit && git push` only
sets it for the commit, so the push wouldn't run the AI gates anyway. They're
also skipped automatically if the `claude` CLI isn't installed, even with
`ENABLE_AI=1`.

When an AI gate finds a HIGH-severity issue it blocks the push and launches
`claude` interactively to fix it; review the changes, commit, then push again.
MEDIUM/LOW findings are printed but never block.

Each gate's prompt — including the Security gate's extra weight on
`crypto.ts`/`store.ts`/`fs.ts` and the Test Coverage gate's instruction to
open the actual `test/*.test.ts` rather than just confirm it was touched —
lives inline in `pre-push`; read it there.

## Requirements

- Node.js + npm
- `claude` CLI installed and authenticated (AI gates only — skipped
  gracefully if absent)

## Bypass

```bash
git push --no-verify
```
