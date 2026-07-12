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

Deliberately not ported from other projects' hooks:

- **Lint** — no ESLint config in this repo yet; add it here once one exists.
- **E2E** — no browser-driven end-to-end suite; `test/` is jsdom-only unit/integration tests.
- **New-file coverage check** — `CLAUDE.md` says every `src` module gets a matching
  `test/*.test.ts`, but it's not 1:1 today (`dom.ts`, `idb.ts`, `palette.ts`,
  `fs-api.d.ts` have none) — a blocking gate here would false-positive on those.
- **AI review gates** — useful in principle for `core/crypto.ts`/`core/store.ts`
  changes specifically, but adds a hard dependency on the `claude` CLI and slows
  down every single push. Worth revisiting as an opt-in, not a default.

## Bypass

```bash
git push --no-verify
```
