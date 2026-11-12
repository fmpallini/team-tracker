---
name: release
description: Use when asked to release, ship, cut a version or merge dev to main — the full dev → main → tag → dev-resync flow, so the checkout is ready for the next iteration when it ends.
---

# Release

The release is not done until `dev` is back in sync with `main` in this checkout. Run every step below, in order.

1. **Commit and push pending work to `dev`.** Check `git status` first; stage files by name. Pre-push gates run on the push.
2. **Version and changelog.** Compare `package.json` with the latest tag (`git describe --tags --abbrev=0 origin/main`). If the current version has no tag yet, it is still unreleased: keep it, and fold every change since the last tag into its `## [X.Y.Z]` entry. Bump only when that version is already tagged. Load the `changelog` skill before writing the entry. Commit the bump separately and push.
3. **Open the PR.** `gh pr create --base main --head dev --title "Release X.Y.Z"`, body listing the headline changes.
4. **Wait for every check.** Use Monitor with `gh pr checks <n> --json name,bucket --jq ...` (no `jq` binary on PATH, see memory `no-jq-use-gh-jq`). Merge only when no check is failing; "skipping" is fine.
5. **Merge with a merge commit:** `gh pr merge <n> --merge`. Never squash (it makes `dev` diverge permanently).
6. **Tag the merge commit and push the tag:** `git fetch origin`, `git tag -a vX.Y.Z -m vX.Y.Z <merge-commit>`, `git push origin vX.Y.Z`. The push starts `release.yml`.
7. **Resync `dev`.** `sync-dev.yml` fast-forwards `origin/dev` to the merge commit within seconds. Poll `gh run list --workflow=sync-dev.yml --limit 1 --json status,conclusion` until it is `completed`/`success`, then `git pull --rebase`. Confirm `git status -sb` shows `dev...origin/dev` with no ahead/behind. Do this without waiting to be asked: a stale `dev` makes the next push fail.
8. **Watch `release.yml`** until it completes and report its conclusion. Step 7 does not wait for it.

Report at the end: PR number, merge commit, tag, sync result, release run conclusion.
