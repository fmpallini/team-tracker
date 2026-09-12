# Backup resilience + save-pill alignment — design

## Goal

Two independent, scoped fixes to the daily-backup system (`src/core/backup-controller.ts` and friends), decided after a review of failure scenarios that could lose both the primary `.tmv` and its `.bck` mirror together:

1. **Pre-migration snapshot** — when opening a file whose on-disk schema is older than this build's `SCHEMA_VERSION`, mirror the *original, unmigrated* bytes to the backup file once, before any edit/autosave can overwrite that mirror with post-migration (potentially buggy) state.
2. **Save-pill alignment** — the save-state pill (`src/ui/shell.ts`) currently collapses "primary file permission lost" and "backup file permission lost" into the same `'permission'` state and the same toast message. Give backup-specific conditions their own pill states, their own toast copy, and make sure every place that mirrors or reads pill state (the action-items expanded-modal mini pill, the Prefs → Backup tab) stays consistent with it.

Out of scope (deliberately deferred, discussed but not adopted here): generational/rotating backups, directory-handle backup targets, and a "keep re-nagging" toast cadence beyond one-shot-per-episode — the persistent pill state itself is judged sufficient replacement for repeated nagging, since it doesn't require the user to have seen/kept a toast.

## Background: failure scenarios this addresses

- **Logical corruption / bad migration shared by both copies** — `backup-controller.ts`'s `writeBackupNow` mirrors whatever bytes the primary save just produced. If a migration ladder bug (`src/core/document.ts`'s `MIGRATIONS`) corrupts the doc on open, the very next autosave mirrors that corruption into the backup too, with no older copy to fall back to.
- **Silent backup failure, one warning per session** — `warnedThisSession`/`permissionEpisodeToasted` latches fire a toast once per failure episode; a long-running tab can have a lapsed grant for the rest of the session with no further signal once that one toast is dismissed or missed.
- **Password-change desync, zero signal** — `change-password.ts`'s immediate `writeBackupNow(bytes)` call after a password change can no-op (missing grant/handle) with **no toast at all** (that no-op path isn't an exception, so the `.catch()` never fires) — the backup silently stays encrypted under the old password.

## 1. Pre-migration snapshot

### Detecting "this open involved a migration"

`decryptDocument`/`parsePlain` (`src/core/crypto.ts`) call `migrate()` (`src/core/document.ts`) internally and only ever hand back the *already-migrated* `Doc` — by the time a caller sees it, `doc.schemaVersion === SCHEMA_VERSION` always, so there's no way to tell after the fact whether migration actually ran.

Rather than changing `decryptDocument`/`parsePlain`'s return shape (which would ripple through every call site and their mocks in `test/start.test.ts`), add two small, additive, read-only peek functions to `crypto.ts` that answer "what schema version is this file at *before* migration," independent of the real decrypt/parse path:

- `peekPlainSchemaVersion(bytes: Uint8Array): number | null` — same tag-sniff as `parsePlain`, but returns the raw (pre-`migrate()`) `schemaVersion` instead of a `Doc`. Returns `null` for "not a plain file" or "corrupt JSON" (best-effort only — the real `parsePlain` call alongside it is still the authoritative error path).
- `peekEncryptedSchemaVersion(bytes: Uint8Array, password: string): Promise<number>` — decrypts (reusing a newly-extracted, unexported `decryptRaw` helper that `decryptDocument` itself is refactored to call, so both share one decrypt implementation) and returns the raw `schemaVersion` without migrating. Only ever called immediately after a successful `decryptDocument(bytes, password)` on the same bytes/password, so its own error paths are dead in practice but kept type-honest.

### Wiring the snapshot at open time

`src/ui/start.ts`'s `onOpen` callback (type declared in `showStartScreen`'s signature) gains a 4th parameter: `migratedFrom: Uint8Array | null` — the original on-disk bytes, non-null only when the peeked schema version was below `SCHEMA_VERSION`. Every call site in `start.ts` (`openAndDecrypt`, `handleOpenFallbackFile`, `checkAutoLoad`, `handleCreate`) computes and passes it.

`src/main.ts`'s `openDocument`/`onDocumentOpened` thread the same 4th parameter through. Right after `onDocumentOpened` constructs `backupCtl` (`createBackupController(...)`), if `migratedFrom` is non-null, fire `void backupCtl.writeBackupNow(migratedFrom)` — no `await`, since nothing downstream depends on it and it must not delay rendering.

Because `writeBackupNow` already resets `maybeWriteBackup`'s interval gate on success (`lastBackupAt = Date.now()`), this pre-migration snapshot naturally survives in the `.bck` file for up to one full `backupFrequency` interval (hourly/daily) before the ordinary mirror overwrites it with post-edit state — a grace window, not permanent history, matching the scope decided on.

## 2. Save-pill alignment

### New `BackupHealth` type and `currentHealth()` query

`backup-controller.ts` gains:

```ts
export type BackupHealth = 'ok' | 'orphaned' | 'permission' | 'error' | 'password-mismatch'
```

and a new method `currentHealth(): Promise<BackupHealth>` that checks, in priority order, `checkOrphaned()` → `hasMissingGrant()` → an in-memory `lastWriteFailed` flag → an in-memory `passwordMismatch` flag → `'ok'`. This becomes the single source of truth both the pill (`save-controller.ts`) and the Prefs Backup tab (`prefs.ts`) read, replacing `prefs.ts`'s own independent `checkOrphaned()` poll.

`writeBackupNow`'s return type changes from `Promise<void>` to `Promise<boolean>` (true iff bytes were actually written) so callers can react to a specific write's outcome: `lastWriteFailed` is set `true` in the existing catch block and cleared `false` (along with `passwordMismatch`) on a successful write. A new `markPasswordMismatch(): void` method lets `change-password.ts` flag the latch explicitly when its own immediate write fails. Both new in-memory flags reset when `loadHandle()` notices `prefs.backupHandleId` pointing at a different id (a fresh target has no history to be stale about).

### Pill states and colors

`shell.ts`'s `SaveState` gains three values, reusing existing severity-coded palette tokens rather than introducing new ones per-palette (same `--danger`/`--brass` semantics as the primary states, `--accent` for the informational one):

| State | Token | Label (en-US) |
|---|---|---|
| `backup-error` | `--danger` | "Backup: error" |
| `backup-permission` | `--brass` | "Backup: grant needed" |
| `backup-password-mismatch` | `--accent` | "Backup: old password" |

All three carry an explicit "Backup:" prefix so the pill is unambiguous about which file it's describing without relying on color alone.

`backup-error` is **not** clickable — it has no single well-defined retry (covers orphan-adjacent generic write failures), same as today's toast-only handling. `backup-permission` and `backup-password-mismatch` **are** clickable: the former re-uses the existing `resolveGrants()` regrant flow, the latter triggers a new retry-write action (`shell.onBackupRetryRequest`).

### Toast differentiation

`save-controller.ts`'s `doSave()` tail (currently: check orphaned → check `hasMissingGrant` → reuse the *same* `reportPermissionNeeded()`/`'permission'`/`save_permission_toast` as the primary file) is rewritten to call `backupCtl.currentHealth()` once and dispatch on the result, each branch with its own one-shot-per-episode toast latch (mirroring the existing `permissionEpisodeToasted` pattern, kept fully separate per state so a primary-file toast can never suppress a backup one or vice versa):

- `'orphaned'` — unchanged (self-disables the pref, `backup_orphaned_toast`, pill returns to `'saved'`).
- `'permission'` — new `backup_permission_toast`, pill → `'backup-permission'`.
- `'error'` — existing `backup_write_failed_toast` (already backup-specific, just now also drives the pill), pill → `'backup-error'`.
- `'password-mismatch'` — new `backup_password_mismatch_toast`, pill → `'backup-password-mismatch'`.

`change-password.ts` computes the same health after its own write attempt (rather than unconditionally setting `'saved'`) so the pill is correct immediately, not just after the next save cycle.

### Prefs → Backup tab alignment

`prefs.ts`'s `renderBackup()` currently has its own, independent orphan-only notice (`orphanedField` / `backupOrphanedNotice`). Generalized to a `backupHealthNotice: Exclude<BackupHealth, 'ok'> | null` sourced from the same `backupHealth()` (new `PrefsAppCtl` method, replacing `checkBackupOrphaned`) call, rendering one of four hint messages with a state-appropriate action button (re-pick for orphaned, regrant for permission, retry-write for error/password-mismatch).

### Action-items mirrored pill

`src/modules/action-items.ts`'s expanded-modal mini pill (`subscribeSaveState` listener) independently duplicates `shell.ts`'s clickable-state list. It reuses `info.label`/`info.state` generically (so text/color already follow automatically), but its own hardcoded `info.state === 'dirty' || info.state === 'error' || info.state === 'permission'` check must be updated in lockstep with `shell.ts`'s list, or the mirror would show correct text/color for the new states but never look clickable.

## Files touched

- `src/core/crypto.ts` — `peekPlainSchemaVersion`, `peekEncryptedSchemaVersion`, internal `decryptRaw` extraction.
- `src/ui/start.ts`, `src/main.ts` — thread `migratedFrom` through the open flow.
- `src/core/backup-controller.ts` — `BackupHealth`, `currentHealth()`, `writeBackupNow` return type, `markPasswordMismatch()`.
- `src/core/change-password.ts` — capture `writeBackupNow`'s result, mark the mismatch latch, set pill state from real health.
- `src/ui/shell.ts` — new `SaveState` values, `SAVE_STATE_KEY`, clickable-state list, `requestSaveNow()` branches, `onBackupRetryRequest`.
- `src/core/save-controller.ts` — `doSave()` tail rewritten around `currentHealth()`.
- `src/core/i18n.ts` — new pill labels, toast copy, Prefs-tab hint/action copy, both locales.
- `src/ui/prefs.ts` — generalized health notice in the Backup tab.
- `src/modules/action-items.ts` — mirrored pill's clickable-state list.
- `styles.css` — three new `[data-state="…"]` rules.
