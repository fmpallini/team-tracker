# Password-less team files, password strength meter, daily backup file

Date: 2026-08-04
Modules: `src/core/crypto.ts`, `src/core/document.ts`, `src/core/types.ts`,
`src/core/save-controller.ts`, `src/core/fs.ts`, `src/core/idb.ts`,
`src/core/password-strength.ts` (new), `src/core/backup-controller.ts` (new),
`src/ui/start.ts`, `src/ui/modal.ts`, `src/ui/prefs.ts`, `src/main.ts`,
`src/core/i18n.ts`, `styles.css`, `CLAUDE.md`, `README.md`

## Problem

Team Tracker always encrypts `.tmv` files (AES-256-GCM, password-derived
key). Some users want to skip that overhead entirely — a file they don't mind
being plaintext, e.g. one already stored somewhere they trust or protected by
other means. There's also no in-app signal of password quality, and no
built-in resilience against file corruption beyond "keep it in a synced
folder" (README's existing backup advice).

This adds three independent pieces:

1. Password-less (`plain`) `.tmv` files, with migration either direction
   between plain and encrypted.
2. A password-strength meter shown wherever a password is set.
3. An opt-in daily `.bck` sibling file for corruption resilience.

## 1. Password-less file format

### On-disk shape

Plain files start with the ASCII tag line `TMV-PLAIN\n` (10 bytes), followed
by `JSON.stringify(doc)` in UTF-8 — no binary framing after the tag, so the
file is fully readable/greppable/indexable by any text tool. Encrypted files
are completely unchanged (`"TMV1"` magic + format version + salt/IV/ciphertext,
see existing `crypto.ts`) — every file written by earlier versions of the app
still opens exactly as today.

Detection on open: read the first bytes of the file. If they match
`TMV-PLAIN\n`, it's a plain file — parse directly, no password prompt. If
not, fall through to the existing encrypted path (`decryptDocument`'s own
magic-byte check already throws `CorruptFileError` on anything else
malformed).

### `crypto.ts` additions

```ts
const PLAIN_TAG = 'TMV-PLAIN\n' // ASCII, matches by exact byte prefix

export function serializePlain(doc: Doc): Uint8Array {
  return new TextEncoder().encode(PLAIN_TAG + JSON.stringify(doc))
}

/** Returns null (not a plain file) rather than throwing — callers fall through to decryptDocument. */
export function parsePlain(bytes: Uint8Array): Doc | null {
  const tagBytes = new TextEncoder().encode(PLAIN_TAG)
  if (bytes.length < tagBytes.length || !tagBytes.every((b, i) => bytes[i] === b)) return null
  const json = new TextDecoder().decode(bytes.slice(tagBytes.length))
  try { return migrate(JSON.parse(json)) }
  catch (e) { if (e instanceof Error && e.constructor.name !== 'SyntaxError') throw e; throw new CorruptFileError() }
}
```

`encryptDocument`/`decryptDocument` are unchanged — plain files never touch
`getSessionKey`/PBKDF2 at all.

### Password becomes nullable end to end

`password: string | null` replaces `password: string` everywhere it's
threaded, with `null` meaning "this file has no password, write it plain":

- `AppController.password` (`main.ts`)
- `SaveControllerDeps.getPassword(): string | null`
- `onOpen(session, doc, password)` callback signature (`start.ts` → `main.ts`)
- `PrefsAppCtl.currentPassword(): string | null` and
  `PrefsAppCtl.changePassword(newPw: string | null): Promise<void>`

Every current call site of the form `encryptDocument(doc, password)` becomes:

```ts
password === null ? serializePlain(doc) : await encryptDocument(doc, password)
```

Call sites affected: `save-controller.ts`'s `doSave`, `main.ts`'s conflict
modal (`onReload`/`onOverwrite`) and `changePassword`, `start.ts`'s create
flow. `decryptDocument` calls in the reload path stay conditioned on
`password !== null` (a plain file's conflict-reload just re-parses with
`parsePlain`).

### Creation flow (`start.ts`)

Unchanged up through the file-system picker: "Create…" still calls
`pickCreate()` first. Only the password step changes — see §1a below
(`promptPassword`'s new `allowPlain` option). `handleCreate()` becomes:

```ts
const session = await pickCreate(SUGGESTED_NAME)
if (!session) return
const result = await promptPassword(locale, { confirm: true, allowPlain: true, title: t(locale, 'create_file') })
if (result === null) return
const doc = createEmptyDocument(locale)
const bytes = 'plain' in result ? serializePlain(doc) : await encryptDocument(doc, result.password)
await writeFile(session, bytes)
onOpen(session, doc, 'plain' in result ? null : result.password)
```

The fallback (no FS API) branch mirrors this with `downloadFallback`.

### §1a. `modal.ts`'s `promptPassword`

New `allowPlain?: boolean` option (only ever set `true` from the create
flow). When set, the dialog gets a third button, **"Use without password"**,
with a muted hint line beneath it (i18n `create_plain_hint`) — visible
*before* the click, read as a warning, not a confirmation afterthought:

> "Stored as plain, unencrypted text — readable by anyone with access to the
> file, including automated scanning by cloud backup providers."

Return type changes from `Promise<string | null>` to:

```ts
Promise<{ password: string } | { plain: true } | null>  // null = Cancel, unchanged
```

Callers without `allowPlain` (the open-file password prompt) only ever see
`{password}` or `null` — behavior there is unchanged, just a narrower slice
of the same union.

### Migration UI (`prefs.ts`'s Security tab)

Conditional on the file's current mode (`appCtl.currentPassword() === null`
→ plain):

- **Currently encrypted:** existing change-password form stays, plus a new
  "Migrate to password-less" button beneath it. Click opens a confirm modal
  asking for the current password (same check as change-password) and
  showing the same plain-text-exposure warning as `create_plain_hint`. On
  confirm: `appCtl.changePassword(null)`.
- **Currently plain:** no "current password" field — there isn't one. Just
  new-password + confirm, submit label "Set Password" (this is the one path
  that turns a plain file *into* an encrypted one). Calls
  `appCtl.changePassword(newPw)`.

`main.ts`'s `changePassword` implementation:

```ts
async changePassword(newPw: string | null): Promise<void> {
  await saveCtl.runExclusive(async () => {
    if (store.readOnly) throw new Error('read-only')
    const bytes = newPw === null ? serializePlain(store.doc) : await encryptDocument(store.doc, newPw)
    if (session.handle) await writeFile(session, bytes)
    else { downloadFallback(session.name, bytes); toast(t(store.doc.prefs.locale, 'fallback_notice')) }
    if (app) app.password = newPw
    store.markSaved()
    shell.setSaveState('saved')
    shell.setTitle(session.name, false)
    // §3 addendum: also re-writes the backup file under the new format, see below.
  })
}
```

## 2. Password strength meter

Zero-runtime-dependency constraint rules out zxcvbn or similar. New
`src/core/password-strength.ts`, a deliberately crude local heuristic (not a
real entropy estimate — good enough to nudge, documented as such):

```ts
export type Strength = 'weak' | 'fair' | 'good' | 'strong'

export function estimateStrength(pw: string): Strength {
  // length<8 -> weak regardless; otherwise score = length bonus + 1 point
  // per character class present (lower/upper/digit/symbol), mapped to the
  // four buckets. Crude on purpose: nudges toward longer/more varied
  // passwords, doesn't claim to model real attacker cost.
}
```

UI: a 4-segment bar + text label, rendered under the password input,
updating live on `oninput`. Two mount points:

- `modal.ts`'s `promptPassword`, when `opts.confirm` is true (the
  `pwInput`/`confirmInput` pair already built there).
- `prefs.ts`'s Security tab, on the new-password field (both the
  set-password and change-password forms).

Colors reuse existing palette CSS custom properties (danger/warn/ok/good —
whatever `styles.css` already exposes for status coloring); new i18n keys
`pwstrength_weak`/`pwstrength_fair`/`pwstrength_good`/`pwstrength_strong`.

## 3. Daily backup file (`.bck`)

### Schema (bump `SCHEMA_VERSION` 8 → 9)

`Prefs` gains:

```ts
dailyBackupEnabled: boolean   // default false
backupHandleId: string | null // default null; opaque UUID, IDB key for the handle
```

Migration step 8: `prefs.dailyBackupEnabled = prefs.dailyBackupEnabled ?? false; prefs.backupHandleId = prefs.backupHandleId ?? null`.

### Enabling the toggle (General tab, `prefs.ts`)

Placed near the auto-save/due-soon fields. Disabled (with an explanatory
hint) when `!supportsFsApi` (fallback/download-only mode has no "same
folder" to speak of) or the current session has no `session.handle`.

Turning it on triggers the existing `pickCreate()`-style save-file picker,
suggested name = the original file's name with `.tmv` swapped for `.bck`
(e.g. `team-tracker.bck`) — one click, same folder is the natural default
(matches the browser's own "last used location" behavior, no new permission
model needed). The returned handle is stored via `idbSet(backupHandleId,
handle)` where `backupHandleId` is a freshly minted UUID written into
`prefs.backupHandleId` at the same time — mirrors `fs.ts`'s existing
`idbSet('lastHandle', handle)` pattern, just keyed per-document instead of
one global slot. If the user cancels the picker, the pref stays off.

Turning it off just flips `dailyBackupEnabled` to `false`. The stored
handle/backup file are left alone — the app doesn't delete user files on its
own anywhere else either.

### New module: `src/core/backup-controller.ts`

Single shared entry point so the 24h-interval path and the
immediate-on-password-change path (below) never duplicate the write logic:

```ts
export interface BackupController {
  /** Writes `bytes` to the backup handle now and resets the elapsed-time clock. No-op if the pref is off or no handle is cached yet. */
  writeBackupNow(bytes: Uint8Array): Promise<void>
  /** Writes `bytes` only if >=24h have elapsed since the last backup write (or none yet this session). */
  maybeWriteBackup(bytes: Uint8Array): Promise<void>
}

export function createBackupController(deps: { store: Store }): BackupController
```

Internally: `lastBackupAt` is an in-memory timestamp, not persisted (a
reload resets it — worst case one extra backup write shortly after
reopening, which is harmless). The backup handle itself is fetched from IDB
via `store.doc.prefs.backupHandleId` and cached after first lookup.
`writeBackupNow`/`maybeWriteBackup` use a `forceWrite`-style write (no
`lastModified` conflict check — the backup file isn't shared with anything
else that could modify it concurrently).

### Wiring

- `save-controller.ts`'s `doSave()`, right after `deps.store.markSaved()` on
  a successful write: calls `backupCtl.maybeWriteBackup(bytes)` with the same
  `bytes` just written to the main file (same format, encrypted or plain,
  whatever the doc's current mode is — no `.bck`-specific serialization
  logic anywhere). A failure here is logged, not surfaced as a save error
  (the primary save already succeeded), but the *first* failure in a session
  shows a one-time non-sticky toast so it isn't totally invisible.
- `main.ts`'s `changePassword` (§1 above), after the main file write
  succeeds and inside the same `runExclusive` block: calls
  `backupCtl.writeBackupNow(bytes)` unconditionally (not gated on the 24h
  window) — a password/format change must propagate to the backup
  immediately, since sitting under the old key or format for up to 24h would
  defeat the point of the backup being a faithful mirror. This is the reason
  the split between `writeBackupNow` (always) and `maybeWriteBackup`
  (time-gated) exists as two entry points on the same controller rather than
  one function with a flag.

### Renaming to `.tmv` recovery path

No `.bck`-specific logic in `crypto.ts`/`document.ts` — the backup file uses
the exact same header/serialization as the primary file at every point in
time, so renaming it to `.tmv` and opening it through the normal open flow
works unmodified. This is a consequence of the design, not a separate
feature to build.

## Out of scope / explicitly deferred

- No attempt to auto-detect "this cloud-synced folder already encrypts
  things" — the plain-file warning is shown unconditionally whenever a user
  chooses it, regardless of where they're saving.
- No password strength *gate* (blocking weak passwords) — the meter is
  informational only, matching the existing `password_too_short` (4-char
  minimum) as the only hard requirement.
- Backup file count is exactly one rotating `.bck` (overwritten each write),
  not a dated history of backups — matches the "at least daily backup in
  case of corruption" requirement without building a retention/rotation
  system nobody asked for.
- No UI to inspect/verify the backup file's contents from within the app —
  recovery is "rename it to `.tmv` and open it," same as any other file.

## i18n additions

New `pt-BR`/`en-US` keys in `core/i18n.ts`: `create_plain_hint`,
`prefs_security_migrate_plain_btn`, `prefs_security_migrate_plain_confirm_*`,
`prefs_security_set_password_btn`, `pwstrength_weak/fair/good/strong`,
`prefs_backup_label`, `prefs_backup_hint`, `prefs_backup_disabled_hint`,
`backup_write_failed_toast`.

## Docs updates

- **`CLAUDE.md`**: `crypto.ts` bullet gains a line on the plain-file
  header/detection and `serializePlain`/`parsePlain`. `save-controller.ts`
  bullet notes the backup-controller hook. Note the schema bump to 9 and its
  migration once implemented (per the existing convention of documenting
  schema changes here).
- **`README.md`**: "🔒 End-to-end encryption (AES-256)" bullet in the Why
  section becomes "optional end-to-end encryption," explicitly noting the
  file is encrypted by default but can be made plain at creation or via
  Settings. "Data file" and "Backing up your team file" sections get a
  paragraph on the new `.bck` feature as a second, independent line of
  defense against corruption (distinct from cloud-sync version history,
  which already covers the "lost the file" case). FAQ gets two new Q&As:
  "Can I skip the password?" (yes, with the same readability caveat as the
  in-app warning) and "What's the `.bck` file?" (rotating same-folder
  backup, rename to `.tmv` to open).

## Testing

- `crypto.test.ts`: `serializePlain`/`parsePlain` round-trip; `parsePlain`
  returns `null` (not a throw) on encrypted-file bytes and on garbage;
  `parsePlain` runs `migrate()` on an old-schema plain payload.
- `password-strength.test.ts` (new): boundary cases for each bucket
  (short → weak regardless of variety; long+varied → strong; etc).
- `start.test.ts` additions: create flow's "Use without password" path calls
  `onOpen` with `password === null` and writes `serializePlain` bytes, not
  `encryptDocument`.
- `modal.test.ts` additions: `promptPassword` with `allowPlain` renders the
  third button and hint text; clicking it resolves `{plain: true}`; without
  `allowPlain`, no third button, return shape unchanged.
- `prefs.test.ts` additions: Security tab renders the plain-file variant
  (no current-password field, "Set Password" label) when
  `currentPassword() === null`; migrate-to-plain button only appears when
  encrypted; both call `changePassword` with the right argument.
- `backup-controller.test.ts` (new): `maybeWriteBackup` no-ops when pref is
  off or before 24h elapsed, writes when the pref is on and the window has
  passed; `writeBackupNow` always writes regardless of elapsed time.
- `document.test.ts`: migration step 8 backfills
  `dailyBackupEnabled`/`backupHandleId` on an old-schema doc.
