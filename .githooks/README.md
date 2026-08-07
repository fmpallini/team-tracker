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
| Lint (`eslint src test`) | Yes | flat config, type-checked rules — see `eslint.config.mjs` |
| TypeCheck (`tsc --noEmit`) | Yes | |
| Tests (`vitest run`) | Yes | |
| Test coverage sanity | Yes (new files only) | dev pushes only — see below |
| Security audit (`npm audit`) | Yes (high/critical only) | moderate = advisory |
| Outdated packages | No | advisory only |
| AI: Simplify | Yes (HIGH only) | opt-in (`ENABLE_AI=1`), dev pushes only, requires `claude` CLI |
| AI: Security review | Yes (HIGH only) | opt-in (`ENABLE_AI=1`), dev pushes only, requires `claude` CLI |
| AI: Bug hunt | Yes (HIGH only) | opt-in (`ENABLE_AI=1`), dev pushes only, requires `claude` CLI |
| AI: Test Coverage | Yes (HIGH only) | opt-in (`ENABLE_AI=1`), dev pushes only, requires `claude` CLI |

`eslint.config.mjs`'s highest-value rules are `@typescript-eslint/no-floating-promises`
and `no-misused-promises` — the save/lock/dispose code in `save-controller.ts` and
`main.ts` is full of fire-and-forget async, exactly the bug class an unhandled
rejection slips through. `no-unnecessary-type-assertion` is turned off project-wide
(cosmetic, not a bug signal); a few test-only rules (`require-await`, `no-base-to-string`)
are relaxed for mocks/stubs that intentionally don't need the rigor.

### Test coverage sanity (deterministic, Phase 1)

`CLAUDE.md`'s "every `src` module gets a matching `test/*.test.ts`" convention is
now effectively 1:1 (the historical exceptions — `dom.ts`, `idb.ts`, `palette.ts` —
all got tests since); the only files exempt today are `src/core/types.ts`
(type-only), `src/main.ts` (wiring, covered by e2e instead), and `*.d.ts` ambient
declarations. Scoped to the diff against `origin/dev` on pushes to `dev`:

- A **new** `src/**/*.ts` file with no matching `test/<name>.test.ts` **fails the
  push** — the convention is real, so this is a mistake, not a style choice.
- A **modified** `src/**/*.ts` file whose matching test file exists but wasn't
  touched in the same push only gets a **warning** — not every edit needs a new
  assertion, and this gate can't tell the difference.

Whether an existing test actually exercises the *new* behavior (as opposed to
merely existing) is a judgment call this gate can't make — that's what the AI
Test Coverage gate below is for.

No browser-driven e2e coverage check runs deterministically here — "does this
change need e2e" is also judgment-based, folded into the AI Test Coverage gate
instead of a separate hard rule.

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

When an AI gate finds a HIGH-severity issue, it blocks the push and launches
`claude` interactively with instructions to fix it; review the changes,
commit, then push again. MEDIUM/LOW findings are printed but never block.

The Security gate is told to weigh `src/core/crypto.ts`, `src/core/store.ts`,
and `src/core/fs.ts` more heavily than the rest of the diff — the app's whole
value proposition rests on the password never leaving the browser and the
`.tmv` format being sound.

The Test Coverage gate is told to actually open the relevant `test/*.test.ts`
(not just confirm it was touched) and check it exercises the new/changed code
path, and to check whether a change to a cross-cutting flow (FS Access/OPFS
round trips, cross-tab locking, external-change conflicts, password-change)
should have touched `e2e/*.spec.ts` and didn't.

## Requirements

- Node.js + npm
- `claude` CLI installed and authenticated (AI gates only — skipped
  gracefully if absent)

## Bypass

```bash
git push --no-verify
```
