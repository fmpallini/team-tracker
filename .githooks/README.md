# Git Hooks

Pre-push quality gates run automatically before every `git push`, catching
what the CI gate would catch anyway but before you wait on a CI run.

## One-time setup (per machine)

```bash
git config core.hooksPath .githooks
```

## Gate summary

| Gate | Blocks push? | Notes |
|------|-------------|-------|
| TypeCheck (`tsc --noEmit`) | Yes | |
| Tests (`vitest run`) | Yes | |
| Security audit (`npm audit`) | Yes (high/critical only) | moderate = advisory |
| Outdated packages | No | advisory only |
| AI: Simplify | Yes (HIGH only) | dev pushes only, requires `claude` CLI |
| AI: Security review | Yes (HIGH only) | dev pushes only, requires `claude` CLI |
| AI: Bug hunt | Yes (HIGH only) | dev pushes only, requires `claude` CLI |

Deliberately not ported from other projects' hooks:

- **Lint** — no ESLint config in this repo yet; add it here once one exists.
- **E2E** — no browser-driven end-to-end suite; `test/` is jsdom-only unit/integration tests.
- **New-file coverage check** — `CLAUDE.md` says every `src` module gets a matching
  `test/*.test.ts`, but it's not 1:1 today (`dom.ts`, `idb.ts`, `palette.ts`,
  `fs-api.d.ts` have none) — a blocking gate here would false-positive on those.

## AI gates

Run only when pushing to `dev` — that's the branch that now takes direct
commits with no PR in front of them, so it's the one spot an AI second look
at the diff earns its keep. Pushes to any other branch skip this phase
entirely; `main` only ever changes via a reviewed PR anyway.

They run by default on every `dev` push. Bypass them when offline or in a
hurry:

```bash
SKIP_AI=1 git push
```

The prefix must be on `git push` itself — `SKIP_AI=1 git commit && git push` only
sets it for the commit, so the push still runs the AI gates. They're also skipped
automatically if the `claude` CLI isn't installed.

When an AI gate finds a HIGH-severity issue, it blocks the push and launches
`claude` interactively with instructions to fix it; review the changes,
commit, then push again. MEDIUM/LOW findings are printed but never block.

The Security gate is told to weigh `src/core/crypto.ts`, `src/core/store.ts`,
and `src/core/fs.ts` more heavily than the rest of the diff — the app's whole
value proposition rests on the password never leaving the browser and the
`.tmv` format being sound.

## Requirements

- Node.js + npm
- `claude` CLI installed and authenticated (AI gates only — skipped
  gracefully if absent)

## Bypass

```bash
git push --no-verify
```
