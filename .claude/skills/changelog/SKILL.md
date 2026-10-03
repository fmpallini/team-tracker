---
name: changelog
description: Use when bumping the package.json version, preparing a dev to main release PR, or writing/editing a CHANGELOG.md entry — rules for what goes in a release entry and how CI's changelog-gate checks it.
---

# Changelog

`CHANGELOG.md` source of truth for GitHub release notes — `.github/workflows/release.yml` extracts section matching pushed tag's version, uses via `--notes-file` instead of `--generate-notes` (falls back to auto-generated PR-title notes only if no matching entry exists, so missed update degrades instead of blocking release). Enforced upstream of that: CI's `changelog-gate` fails any `dev → main` PR that bumps `package.json` version without a matching, non-empty `## [X.Y.Z]` section — so the fallback is a safety net, not the normal path.

- **When**: add or update `## [X.Y.Z]` entry in same commit/PR that bumps `version` in `package.json` — whether dedicated `chore: bump version` commit or bundled into feature commit. Version in header must match `package.json` exactly (extraction literal string match on `## [<version>]`).
- **Where**: newest entry at top, directly under header block. Format [Keep a Changelog](https://keepachangelog.com/)-flavored: `### Added` / `### Changed` / `### Fixed` subsections; omit any subsection with nothing in it.
- **Audience**: file read by end users on GitHub releases page, not developers reading diff. Describe what changed *for person using app* — symptom fixed or capability added — not implementation. "Copying notes as plain text lost nested-list indentation" not "`htmlToPlainText`'s list renderer now indents 2 spaces per depth level." Skip anything with no user-visible effect (dependency bumps, CI tweaks, internal refactors, test-only changes) — if whole release like that, write one line: `_No user-facing changes — internal cleanup only._` instead of empty subsections.
- **Scope is the whole span since the last release tag, not the last commit.** Before writing, enumerate every commit in `git log <last-version-tag>..HEAD` (equivalently, the full commit range of the `dev → main` release PR). Walk all of them and write one entry per user-facing feature/fix in that range — never base the entry on a single commit when the release bundles several.
- **Skip fixes for bugs that never shipped.** If a bug was introduced *and* fixed within the same unreleased cycle — no tagged release between the commit that caused it and the commit that fixed it — omit it. Users never experienced it, so it's noise. Only changelog fixes for behavior that was broken in a previously released version.
- Don't backfill or rewrite entries for already-tagged releases except to fix factual error — treat published entries as immutable history, same as git tag they describe.
