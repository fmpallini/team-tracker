---
name: release
description: Use when asked to release, ship, cut a version or merge dev to main — the full dev → main → tag → dev-resync flow, so the checkout is ready for the next iteration when it ends.
---

# Release

The release is not done until `dev` is back in sync with `main` in this checkout. Run every step below, in order.

1. **Commit pending work to `dev`, without pushing yet.** Check `git status` first; stage files by name.
2. **Version and changelog.** Compare `package.json` with the latest tag (`git describe --tags --abbrev=0 origin/main`). If the current version has no tag yet, it is still unreleased: keep it, and fold every change since the last tag into its `## [X.Y.Z]` entry. Bump only when that version is already tagged. Load the `changelog` skill before writing the entry. Commit the bump separately.
3. **Push once.** `git push` sends the work and the bump together; pre-push gates run on it. Every push to `dev` pays for a full CI run with E2E, and the release PR reuses only the run for its head commit, so a separate push for the bump is a whole extra suite.
4. **Open the PR and arm auto-merge.** `gh pr create --base main --head dev --title "Release X.Y.Z"`, body listing the headline changes, then right away `gh pr merge <n> --merge --auto`. GitHub merges it with a merge commit once every required check is green (lint/typecheck/test, build on ubuntu and windows, E2E, changelog entry, CodeQL). Never squash (it makes `dev` diverge permanently). The PR's E2E waits for the push's run on the same commit and reuses it, so expect the verdict when that run ends.
5. **Wait for the merge.** Use Monitor polling `gh pr view <n> --json state,autoMergeRequest,mergeCommit --jq ...` until `state` is `MERGED`, and have it also emit any check that ends `fail` (`gh pr checks <n> --json name,bucket --jq ...`; no `jq` binary on PATH, see memory `no-jq-use-gh-jq`). On a failure, fix on `dev` and push; if `autoMergeRequest` is then null, arm it again with the same command.
6. **Tag the merge commit and push the tag:** `git fetch origin`, `git tag -a vX.Y.Z -m vX.Y.Z <merge-commit>`, `git push origin vX.Y.Z`. The push starts `release.yml`.
7. **Resync `dev`.** `sync-dev.yml` fast-forwards `origin/dev` to the merge commit within seconds. Poll `gh run list --workflow=sync-dev.yml --limit 1 --json status,conclusion` until it is `completed`/`success`, then `git pull --rebase`. Confirm `git status -sb` shows `dev...origin/dev` with no ahead/behind. Do this without waiting to be asked: a stale `dev` makes the next push fail.
8. **Watch `release.yml`** until it completes and report its conclusion. Step 7 does not wait for it.

Report at the end: PR number, merge commit, tag, sync result, release run conclusion.
