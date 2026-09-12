# Backup Resilience + Save-Pill Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Snapshot the pre-migration file to the backup mirror on open, and give backup-specific save-pill states (permission lost, generic write error, password out of date) their own color/label/toast distinct from the primary file's, kept in sync across the header pill, its action-items mirror, and the Prefs → Backup tab.

**Architecture:** Two independent additive features sharing one file (`backup-controller.ts`). (1) `crypto.ts` gains two read-only "peek" functions so the open flow can detect a migration without changing `decryptDocument`/`parsePlain`'s existing return shape or touching their many existing mocks. (2) `backup-controller.ts` gains a single `currentHealth()` query backed by two new in-memory flags; `save-controller.ts`, `change-password.ts`, and `prefs.ts` all read from that one method instead of each deriving backup state their own way.

**Tech Stack:** TypeScript, Vitest (jsdom), esbuild. Zero runtime dependencies — dev-only tooling unaffected.

**Spec:** `docs/superpowers/specs/2026-09-11-backup-resilience-and-pill-alignment-design.md`

## Global Constraints

- Zero runtime dependencies — no new packages, dev or otherwise.
- Every `src` module keeps its matching `test/*.test.ts` (per `CLAUDE.md`); new exported functions get new tests, changed return types get their existing assertions updated.
- All user-visible strings go through `t()`; every new i18n key gets both `pt-BR` and `en-US` entries in `src/core/i18n.ts`.
- `npm run typecheck` (strict) and `npm run lint` must pass after every task — a changed function signature that isn't threaded through every call site fails typecheck immediately, which is the intended safety net for this plan's several signature changes.
- No comments explaining *what* code does — only non-obvious *why* (existing codebase convention).

---

## Task 1: `crypto.ts` — pre-migration schema-version peek functions

**Files:**
- Modify: `src/core/crypto.ts:80-118` (extract `decryptRaw`, add `peekEncryptedSchemaVersion`, add `peekPlainSchemaVersion`)
- Test: `test/crypto.test.ts`

**Interfaces:**
- Consumes: nothing new — reuses `MAGIC`, `FORMAT_VERSION`, `PLAIN_TAG_BYTES`, `getSessionKey`, `WrongPasswordError`, `CorruptFileError` already in this file; `SCHEMA_VERSION` from `./document` (test-only import, not needed by the implementation itself).
- Produces: `peekPlainSchemaVersion(bytes: Uint8Array): number | null` and `peekEncryptedSchemaVersion(bytes: Uint8Array, password: string): Promise<number>`, both consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Add to `test/crypto.test.ts`:

```ts
import { encryptDocument, decryptDocument, resetSessionKey, WrongPasswordError, CorruptFileError, serializePlain, parsePlain, peekPlainSchemaVersion, peekEncryptedSchemaVersion } from '../src/core/crypto'

test('peekEncryptedSchemaVersion reads the pre-migration schema version without migrating', async () => {
  const oldDoc = { ...createEmptyDocument('pt-BR'), schemaVersion: SCHEMA_VERSION - 1 }
  const bytes = await encryptDocument(oldDoc, 'pw')
  await expect(peekEncryptedSchemaVersion(bytes, 'pw')).resolves.toBe(SCHEMA_VERSION - 1)
  // decryptDocument on the same bytes still migrates all the way up, unaffected.
  const decrypted = await decryptDocument(bytes, 'pw')
  expect(decrypted.schemaVersion).toBe(SCHEMA_VERSION)
}, 20000)

test('peekEncryptedSchemaVersion returns the current version for an up-to-date file', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'pw')
  await expect(peekEncryptedSchemaVersion(bytes, 'pw')).resolves.toBe(SCHEMA_VERSION)
}, 20000)

test('peekEncryptedSchemaVersion rejects with WrongPasswordError, same as decryptDocument', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'right')
  await expect(peekEncryptedSchemaVersion(bytes, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError)
}, 20000)

test('peekPlainSchemaVersion reads the pre-migration schema version for a plain file', () => {
  const oldDoc = { ...createEmptyDocument('en-US'), schemaVersion: SCHEMA_VERSION - 1 }
  const bytes = serializePlain(oldDoc)
  expect(peekPlainSchemaVersion(bytes)).toBe(SCHEMA_VERSION - 1)
})

test('peekPlainSchemaVersion returns null for a non-plain (encrypted) file', async () => {
  const bytes = await encryptDocument(createEmptyDocument('en-US'), 'pw')
  expect(peekPlainSchemaVersion(bytes)).toBeNull()
}, 20000)

test('peekPlainSchemaVersion returns null for a plain file with corrupt JSON', () => {
  const bytes = new TextEncoder().encode('TMV-PLAIN\n{not json')
  expect(peekPlainSchemaVersion(bytes)).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/crypto.test.ts -t peek`
Expected: FAIL — `peekPlainSchemaVersion`/`peekEncryptedSchemaVersion` are not exported.

- [ ] **Step 3: Implement — extract `decryptRaw`, add both peek functions**

In `src/core/crypto.ts`, replace the body of `decryptDocument` (current lines 80-93):

```ts
async function decryptRaw(bytes: Uint8Array, password: string): Promise<Record<string, unknown>> {
  if (bytes.length < 78 || MAGIC.some((b, i) => bytes[i] !== b) || bytes[4] !== FORMAT_VERSION)
    throw new CorruptFileError()
  const salt = bytes.slice(5, 21), ivKcv = bytes.slice(21, 33)
  const kcv = bytes.slice(33, 65), ivData = bytes.slice(65, 77), data = bytes.slice(77)
  const { key } = await getSessionKey(password, salt)
  try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivKcv }, key, kcv) }
  catch { throw new WrongPasswordError() }
  let plain: ArrayBuffer
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivData }, key, data) }
  catch { throw new CorruptFileError() }
  try { return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown> }
  catch { throw new CorruptFileError() }
}

export async function decryptDocument(bytes: Uint8Array, password: string): Promise<Doc> {
  return migrate(await decryptRaw(bytes, password))
}

/**
 * Read-only peek at the schema version a file is at *before* migration —
 * used only to decide whether to fire a one-off pre-migration backup
 * snapshot on open (see main.ts's onDocumentOpened). Always called
 * immediately after a successful decryptDocument() on the same bytes and
 * password, so its own error paths never actually trigger in practice; kept
 * type-honest (same errors as decryptDocument) rather than assumed away.
 */
export async function peekEncryptedSchemaVersion(bytes: Uint8Array, password: string): Promise<number> {
  const parsed = await decryptRaw(bytes, password)
  const schemaVersion = parsed.schemaVersion
  if (typeof schemaVersion !== 'number') throw new CorruptFileError()
  return schemaVersion
}
```

Then, after `parsePlain` (current lines 105-118), add:

```ts
/**
 * Same tag-sniff as parsePlain, but stops short of migrate() — best-effort
 * only (returns null rather than throwing on corrupt JSON): the real
 * parsePlain() call made alongside this one is still the authoritative
 * error path, this is purely advisory for the pre-migration snapshot decision.
 */
export function peekPlainSchemaVersion(bytes: Uint8Array): number | null {
  if (bytes.length < PLAIN_TAG_BYTES.length) return null
  for (let i = 0; i < PLAIN_TAG_BYTES.length; i++) {
    if (bytes[i] !== PLAIN_TAG_BYTES[i]) return null
  }
  const json = new TextDecoder().decode(bytes.slice(PLAIN_TAG_BYTES.length))
  try {
    const parsed = JSON.parse(json) as { schemaVersion?: unknown }
    return typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : null
  } catch {
    return null
  }
}
```

`migrate` is already imported at the top of `crypto.ts` (`import { migrate } from './document'`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/crypto.test.ts`
Expected: PASS — including every pre-existing test in the file (the `decryptDocument`/`parsePlain` public contracts are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/core/crypto.ts test/crypto.test.ts
git commit -m "feat(crypto): add pre-migration schema-version peek functions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Wire the pre-migration snapshot into the open flow

**Files:**
- Modify: `src/ui/start.ts` (all `onOpen(...)` call sites, `showStartScreen`'s type signature, `decryptLoop`)
- Modify: `src/main.ts:80-89` (`openDocument`), `src/main.ts:124` (`onDocumentOpened` signature), `src/main.ts:224` (after `backupCtl` construction)
- Test: `test/start.test.ts`

**Interfaces:**
- Consumes: `peekPlainSchemaVersion`, `peekEncryptedSchemaVersion` from Task 1; `SCHEMA_VERSION` from `src/core/document.ts` (already exported).
- Produces: `onOpen`'s 4th parameter `migratedFrom: Uint8Array | null`, threaded through to `onDocumentOpened`, which fires `backupCtl.writeBackupNow(migratedFrom)` once at open.

- [ ] **Step 1: Write the failing tests**

`test/start.test.ts` already imports `SCHEMA_VERSION` (its line 2: `import { createEmptyDocument, SCHEMA_VERSION } from '../src/core/document'`) and mocks `../src/core/crypto` via a hoisted `cryptoMocks` object (lines 24-36) reset in `beforeEach` (lines 55-58). Add the two new peek functions to both:

```ts
// In the hoisted cryptoMocks object (alongside decryptDocument/parsePlain):
peekPlainSchemaVersion: vi.fn((_bytes: Uint8Array) => SCHEMA_VERSION as number | null),
peekEncryptedSchemaVersion: vi.fn(async (_bytes: Uint8Array, _password: string) => SCHEMA_VERSION),
```

```ts
// In beforeEach, alongside the other cryptoMocks.*.mockReset() calls:
cryptoMocks.peekPlainSchemaVersion.mockReset().mockReturnValue(SCHEMA_VERSION)
cryptoMocks.peekEncryptedSchemaVersion.mockReset().mockResolvedValue(SCHEMA_VERSION)
```

New tests, following this file's existing `clickByText`/`flush`/`fsMocks.pickOpen`/`input[name="tt-password"]` pattern (see e.g. the existing "open flow: wrong password loops..." test at line 171 and "create flow: prompts confirm password..." at line 230):

```ts
test('open flow: a plain file below the current schema version calls onOpen with the raw bytes as migratedFrom', async () => {
  const session: FileSession = { handle: null, name: 'old.tmv', lastModified: 1 }
  const bytes = new Uint8Array([9])
  fsMocks.pickOpen.mockResolvedValue({ session, bytes })
  const plainDoc = createEmptyDocument('en-US')
  cryptoMocks.parsePlain.mockReturnValue(plainDoc)
  cryptoMocks.peekPlainSchemaVersion.mockReturnValue(SCHEMA_VERSION - 1)

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('📂 Open file…')
  await flush()

  expect(onOpen).toHaveBeenCalledTimes(1)
  const [, , , migratedFrom] = onOpen.mock.calls[0] as [FileSession, Doc, string | null, Uint8Array | null]
  expect(migratedFrom).toBe(bytes)
})

test('open flow: a plain file already at the current schema version calls onOpen with migratedFrom null', async () => {
  const session: FileSession = { handle: null, name: 'current.tmv', lastModified: 1 }
  fsMocks.pickOpen.mockResolvedValue({ session, bytes: new Uint8Array([9]) })
  cryptoMocks.parsePlain.mockReturnValue(createEmptyDocument('en-US'))
  cryptoMocks.peekPlainSchemaVersion.mockReturnValue(SCHEMA_VERSION)

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('📂 Open file…')
  await flush()

  const [, , , migratedFrom] = onOpen.mock.calls[0] as [FileSession, Doc, string | null, Uint8Array | null]
  expect(migratedFrom).toBeNull()
})

test('open flow: an encrypted file below the current schema version calls onOpen with the raw bytes as migratedFrom', async () => {
  const session: FileSession = { handle: null, name: 'old-enc.tmv', lastModified: 1 }
  const bytes = new Uint8Array([9])
  fsMocks.pickOpen.mockResolvedValue({ session, bytes })
  cryptoMocks.parsePlain.mockReturnValue(null)
  cryptoMocks.decryptDocument.mockResolvedValue(createEmptyDocument('en-US'))
  cryptoMocks.peekEncryptedSchemaVersion.mockResolvedValue(SCHEMA_VERSION - 1)

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('📂 Open file…')
  await flush()

  const pwInput = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  pwInput.value = 'right'
  pwInput.dispatchEvent(new Event('input'))
  clickByText('OK')
  await flush()
  await flush()

  expect(onOpen).toHaveBeenCalledTimes(1)
  const [, , , migratedFrom] = onOpen.mock.calls[0] as [FileSession, Doc, string | null, Uint8Array | null]
  expect(migratedFrom).toBe(bytes)
})

test('create flow: always calls onOpen with migratedFrom null (a brand-new document is never migrated)', async () => {
  const session: FileSession = { handle: {} as unknown as FileSystemFileHandle, name: 'team-tracker.tmv', lastModified: 1 }
  fsMocks.pickCreate.mockResolvedValue(session)

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('✨ Create new…')
  await flush()
  clickByText('Create without password')
  await flush()
  await flush()

  const [, , , migratedFrom] = onOpen.mock.calls[0] as [FileSession, Doc, string | null, Uint8Array | null]
  expect(migratedFrom).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/start.test.ts -t migratedFrom`
Expected: FAIL — `onOpen` is only ever called with 3 arguments today, so `migratedFrom` reads as `undefined`, not `null`/bytes as asserted.

- [ ] **Step 3: Implement — thread `migratedFrom` through `start.ts`**

In `src/ui/start.ts`:

1. Import the two peek functions and `SCHEMA_VERSION`:

```ts
import { decryptDocument, encryptDocument, serializePlain, parsePlain, peekPlainSchemaVersion, peekEncryptedSchemaVersion, WrongPasswordError, CorruptFileError } from '../core/crypto'
import { createEmptyDocument, SchemaTooNewError, SCHEMA_VERSION } from '../core/document'
```

2. Update `showStartScreen`'s signature (current line 78-82):

```ts
export function showStartScreen(
  locale: Locale,
  onOpen: (session: FileSession, doc: Doc, password: string | null, migratedFrom: Uint8Array | null) => void,
  opts?: { skipAutoLoad?: boolean }
): void {
```

3. Update `decryptLoop` (current lines 96-121) to also compute and return `migratedFrom`:

```ts
async function decryptLoop(bytes: Uint8Array): Promise<{ doc: Doc; password: string; migratedFrom: Uint8Array | null } | null> {
    for (;;) {
      const result = await promptPassword(locale, { title: t(locale, 'open_file') })
      if (result === null) return null
      const password = (result as { password: string }).password
      try {
        const doc = await decryptDocument(bytes, password)
        const preSchemaVersion = await peekEncryptedSchemaVersion(bytes, password)
        return { doc, password, migratedFrom: preSchemaVersion < SCHEMA_VERSION ? bytes : null }
      } catch (e) {
        if (e instanceof WrongPasswordError) {
          toast(t(locale, 'err_wrong_password'))
          continue
        }
        if (e instanceof CorruptFileError) {
          showErrorModal(locale, t(locale, 'err_corrupt_file'))
          return null
        }
        if (e instanceof SchemaTooNewError) {
          showErrorModal(locale, t(locale, 'err_schema_too_new'))
          return null
        }
        throw e
      }
    }
}
```

4. Update `openAndDecrypt` (current lines 127-150):

```ts
async function openAndDecrypt(fetchResult: () => Promise<{ session: FileSession; bytes: Uint8Array } | null>): Promise<void> {
    const result = await fetchResult()
    if (!result) return
    let plainDoc: Doc | null
    try {
      plainDoc = parsePlain(result.bytes)
    } catch (e) {
      if (e instanceof CorruptFileError) {
        showErrorModal(locale, t(locale, 'err_corrupt_file'))
        return
      }
      if (e instanceof SchemaTooNewError) {
        showErrorModal(locale, t(locale, 'err_schema_too_new'))
        return
      }
      throw e
    }
    if (plainDoc) {
      const preSchemaVersion = peekPlainSchemaVersion(result.bytes)
      onOpen(result.session, plainDoc, null, preSchemaVersion !== null && preSchemaVersion < SCHEMA_VERSION ? result.bytes : null)
      return
    }
    const outcome = await decryptLoop(result.bytes)
    if (outcome) onOpen(result.session, outcome.doc, outcome.password, outcome.migratedFrom)
}
```

5. Update `handleOpenFallbackFile` (current lines 156-180) the same way as `openAndDecrypt`'s plain/encrypted branches:

```ts
async function handleOpenFallbackFile(file: File): Promise<void> {
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const session: FileSession = { handle: null, name: file.name, lastModified: file.lastModified }
    let plainDoc: Doc | null
    try {
      plainDoc = parsePlain(bytes)
    } catch (e) {
      if (e instanceof CorruptFileError) {
        showErrorModal(locale, t(locale, 'err_corrupt_file'))
        return
      }
      if (e instanceof SchemaTooNewError) {
        showErrorModal(locale, t(locale, 'err_schema_too_new'))
        return
      }
      throw e
    }
    if (plainDoc) {
      const preSchemaVersion = peekPlainSchemaVersion(bytes)
      onOpen(session, plainDoc, null, preSchemaVersion !== null && preSchemaVersion < SCHEMA_VERSION ? bytes : null)
      return
    }
    const outcome = await decryptLoop(bytes)
    if (outcome) onOpen(session, outcome.doc, outcome.password, outcome.migratedFrom)
}
```

6. Update `handleCreate` (current lines 182-197) — a brand-new document is never migrated. Both its `onOpen(session, doc, ...)` calls (the `supportsFsApi` branch and its `else`) gain a 4th argument, `null`:

```ts
      onOpen(session, doc, 'plain' in result ? null : result.password, null)
```

(this is the same call already in the file, current line 191, with `null` appended — the `else` branch's fallback-mode path at the end of `handleCreate` has the identical call shape and gets the same `null` appended.)

7. Update `checkAutoLoad` (current lines 341-360) — plain-only path:

```ts
async function checkAutoLoad(): Promise<void> {
    const result = await peekLastFile()
    if (!result) return
    let plainDoc: Doc | null
    try {
      plainDoc = parsePlain(result.bytes)
    } catch (e) {
      console.error(e)
      return
    }
    if (!plainDoc) return
    const autoLoad = (await idbGet<boolean>('autoLoadLast')) === true
    autoLoadRow.style.display = ''
    autoLoadCheckbox.checked = autoLoad
    if (autoLoad && !opts?.skipAutoLoad) {
      const preSchemaVersion = peekPlainSchemaVersion(result.bytes)
      onOpen(result.session, plainDoc, null, preSchemaVersion !== null && preSchemaVersion < SCHEMA_VERSION ? result.bytes : null)
    }
}
```

- [ ] **Step 4: Implement — thread `migratedFrom` through `main.ts`**

In `src/main.ts`:

1. Update `openDocument` (current lines 78-89):

```ts
function openDocument(session: FileSession, doc: Doc, password: string | null, migratedFrom: Uint8Array | null): void {
  onDocumentOpened(session, doc, password, migratedFrom).catch((e: unknown) => {
    console.error(e)
    showErrorModal(doc.prefs.locale, t(doc.prefs.locale, 'err_unexpected'))
  })
}
```

2. Update `onDocumentOpened`'s signature (current line 124):

```ts
async function onDocumentOpened(session: FileSession, doc: Doc, password: string | null, migratedFrom: Uint8Array | null): Promise<void> {
```

3. Right after `const backupCtl = createBackupController({ store })` (current line 224), add:

```ts
  // A migration just ran on open (see start.ts's peekPlainSchemaVersion/
  // peekEncryptedSchemaVersion) — snapshot the original, unmigrated bytes to
  // the backup mirror once, before any edit/autosave can overwrite it with
  // post-migration state. Fire-and-forget: writeBackupNow never throws, and
  // nothing downstream depends on this completing before the shell renders.
  if (migratedFrom) {
    void backupCtl.writeBackupNow(migratedFrom)
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/start.test.ts`
Expected: PASS — including every pre-existing test (they destructure `onOpen.mock.calls[0]` with only 3 names, so the added 4th argument doesn't affect them).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (`main.ts` has no dedicated test file per `CLAUDE.md`'s convention — typecheck is what catches a missed call site here.)

- [ ] **Step 7: Commit**

```bash
git add src/ui/start.ts src/main.ts test/start.test.ts
git commit -m "feat(backup): snapshot pre-migration bytes to backup on open

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `backup-controller.ts` — `BackupHealth` and `currentHealth()`

**Files:**
- Modify: `src/core/backup-controller.ts`
- Test: `test/backup-controller.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export type BackupHealth = 'ok' | 'orphaned' | 'permission' | 'error' | 'password-mismatch'`; `BackupController.currentHealth(): Promise<BackupHealth>`; `BackupController.markPasswordMismatch(): void`; `export function backupHealthPillState(health: BackupHealth)`; `writeBackupNow` now returns `Promise<boolean>` instead of `Promise<void>`. Consumed by Task 4 (`change-password.ts`), Task 6 (`save-controller.ts`), Task 8 (`prefs.ts`).

- [ ] **Step 1: Write the failing tests**

Update `test/backup-controller.test.ts`'s existing import (line 1) to also pull in `backupHealthPillState`:

```ts
import { createBackupController, backupHealthPillState } from '../src/core/backup-controller'
```

Add:

```ts
test('writeBackupNow resolves true on a successful write', async () => {
  const store = storeWithBackup(true)
  const ctl = createBackupController({ store })
  await expect(ctl.writeBackupNow(new Uint8Array([1]))).resolves.toBe(true)
})

test('writeBackupNow resolves false when the pref is off', async () => {
  const store = storeWithBackup(false)
  const ctl = createBackupController({ store })
  await expect(ctl.writeBackupNow(new Uint8Array([1]))).resolves.toBe(false)
})

test('writeBackupNow resolves false on a write failure', async () => {
  writeMock.mockRejectedValue(new Error('disk full'))
  const store = storeWithBackup(true)
  const ctl = createBackupController({ store })
  await expect(ctl.writeBackupNow(new Uint8Array([1]))).resolves.toBe(false)
})

describe('currentHealth', () => {
  test('is "ok" when backups are off', async () => {
    const store = storeWithBackup(false)
    const ctl = createBackupController({ store })
    await expect(ctl.currentHealth()).resolves.toBe('ok')
  })

  test('is "ok" when everything is fine', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await expect(ctl.currentHealth()).resolves.toBe('ok')
  })

  test('is "orphaned" when the configured handle has no matching IDB entry', async () => {
    idbMocks.idbGet.mockResolvedValue(undefined)
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await expect(ctl.currentHealth()).resolves.toBe('orphaned')
  })

  test('is "permission" when the grant has lapsed (and not orphaned)', async () => {
    queryPermissionMock.mockResolvedValue('prompt')
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await expect(ctl.currentHealth()).resolves.toBe('permission')
  })

  test('is "error" after a write failure that is not a permission or orphan issue', async () => {
    writeMock.mockRejectedValue(new Error('disk full'))
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    await expect(ctl.currentHealth()).resolves.toBe('error')
  })

  test('"error" clears after a subsequent successful write', async () => {
    writeMock.mockRejectedValueOnce(new Error('disk full'))
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    await expect(ctl.currentHealth()).resolves.toBe('error')
    await ctl.writeBackupNow(new Uint8Array([2]))
    await expect(ctl.currentHealth()).resolves.toBe('ok')
  })

  test('is "password-mismatch" after markPasswordMismatch(), and clears on a successful write', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    ctl.markPasswordMismatch()
    await expect(ctl.currentHealth()).resolves.toBe('password-mismatch')
    await ctl.writeBackupNow(new Uint8Array([1]))
    await expect(ctl.currentHealth()).resolves.toBe('ok')
  })

  test('"orphaned" takes priority over a pending password-mismatch', async () => {
    idbMocks.idbGet.mockResolvedValue(undefined)
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    ctl.markPasswordMismatch()
    await expect(ctl.currentHealth()).resolves.toBe('orphaned')
  })

  test('a lapsed grant takes priority over a pending password-mismatch', async () => {
    queryPermissionMock.mockResolvedValue('prompt')
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    ctl.markPasswordMismatch()
    await expect(ctl.currentHealth()).resolves.toBe('permission')
  })

  test.each([
    ['ok', 'saved'],
    ['orphaned', 'saved'],
    ['permission', 'backup-permission'],
    ['error', 'backup-error'],
    ['password-mismatch', 'backup-password-mismatch'],
  ] as const)('backupHealthPillState(%s) is %s', (health, expected) => {
    expect(backupHealthPillState(health)).toBe(expected)
  })

  test('markPasswordMismatch and the error latch both reset when backupHandleId changes to a new id', async () => {
    writeMock.mockRejectedValueOnce(new Error('disk full'))
    const store = storeWithBackup(true, 'backup-1')
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    ctl.markPasswordMismatch()
    store.update((d) => { d.prefs.backupHandleId = 'backup-2' })
    await expect(ctl.currentHealth()).resolves.toBe('ok')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/backup-controller.test.ts -t currentHealth`
Expected: FAIL — `currentHealth`/`markPasswordMismatch` don't exist yet, and `writeBackupNow` resolves `undefined` rather than a boolean.

- [ ] **Step 3: Implement**

In `src/core/backup-controller.ts`:

1. Add the exported type near the top (after the imports):

```ts
export type BackupHealth = 'ok' | 'orphaned' | 'permission' | 'error' | 'password-mismatch'
```

2. Add `lastWriteFailed`/`passwordMismatch` alongside the existing closure state (current lines 76-83):

```ts
  let lastWriteFailed = false
  let passwordMismatch = false
```

3. In `loadHandle()`'s "resolved a different id" branch (current lines 92-117, right where `lastBackupAt = 0` is reset), add:

```ts
      lastWriteFailed = false
      passwordMismatch = false
```

4. Change `writeBackupNow`'s signature and body (current lines 186-200):

```ts
  async function writeBackupNow(bytes: Uint8Array): Promise<boolean> {
    if (!deps.store.doc.prefs.dailyBackupEnabled) return false
    try {
      const handle = await getHandle()
      if (!handle) return false
      await writeBackupBytes(handle, bytes)
      lastBackupAt = Date.now()
      lastWriteFailed = false
      passwordMismatch = false
      return true
    } catch (e) {
      console.error(e)
      lastWriteFailed = true
      if (!warnedThisSession) {
        warnedThisSession = true
        toast(t(deps.store.doc.prefs.locale, 'backup_write_failed_toast'), { sticky: false })
      }
      return false
    }
  }
```

5. Add `markPasswordMismatch` and `currentHealth`:

```ts
  function markPasswordMismatch(): void {
    passwordMismatch = true
  }

  async function currentHealth(): Promise<BackupHealth> {
    if (!deps.store.doc.prefs.dailyBackupEnabled) return 'ok'
    if (await checkOrphaned()) return 'orphaned'
    if (await hasMissingGrant()) return 'permission'
    if (lastWriteFailed) return 'error'
    if (passwordMismatch) return 'password-mismatch'
    return 'ok'
  }
```

Also add this small, standalone exported helper (module-level function, not inside `createBackupController`) right after the `BackupHealth` type — it maps a health value to the pill state that means it, so `save-controller.ts`'s `resolveGrants()` and `change-password.ts`'s tail (both of which only need "what should the pill say," no side effects) share one mapping instead of each re-deriving it:

```ts
/**
 * 'ok' and 'orphaned' both mean "nothing backup-related to show right now" —
 * orphaned self-disables the pref elsewhere (save-controller.ts's doSave()
 * tail) and has nothing left to flag on the pill once that's done. The other
 * three health values map 1:1 onto their SaveState.
 */
export function backupHealthPillState(health: BackupHealth): 'saved' | 'backup-permission' | 'backup-error' | 'backup-password-mismatch' {
  if (health === 'ok' || health === 'orphaned') return 'saved'
  return `backup-${health}`
}
```

6. Update the `BackupController` interface (current lines 12-67) to add both new members' doc comments and signatures, and change `writeBackupNow`'s declared return type to `Promise<boolean>`:

```ts
  /** Writes now and resets the elapsed-time clock. Never rejects. No-op if the pref is off, no handle is stored yet, or the stored handle's write permission has lapsed. Resolves true iff the write actually happened. */
  writeBackupNow(bytes: Uint8Array): Promise<boolean>
```

```ts
  /** Flags that the most recent password-change's immediate backup write did not go through — the backup file may still be encrypted under the previous password. Cleared automatically by the next successful writeBackupNow, or by backupHandleId changing to a new target. */
  markPasswordMismatch(): void
  /**
   * Single priority-ordered health summary — orphaned, then a lapsed grant,
   * then a generic write failure, then a stale password, else 'ok'. The one
   * source of truth save-controller.ts's pill, change-password.ts's
   * post-write pill update, and the Prefs Backup tab all read instead of
   * each deriving backup state their own way.
   */
  currentHealth(): Promise<BackupHealth>
```

7. Update the final `return { ... }` statement (current line 253) to include `markPasswordMismatch, currentHealth`.

- [ ] **Step 4: Fix the two pre-existing assertions this return-type change breaks**

In `test/backup-controller.test.ts`, change:
- line ~261 (`'writeBackupNow resolves (never rejects) when the IDB handle lookup fails'`): `.resolves.toBeUndefined()` → `.resolves.toBe(false)`
- line ~282 (`'a non-granted permission on the restored handle is a clean no-op'`): `.resolves.toBeUndefined()` → `.resolves.toBe(false)`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/backup-controller.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/backup-controller.ts test/backup-controller.test.ts
git commit -m "feat(backup): add currentHealth() and a password-mismatch latch

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: `change-password.ts` — reflect real backup health after a password change

**Files:**
- Modify: `src/core/change-password.ts:61-70`
- Test: `test/change-password.test.ts`

**Interfaces:**
- Consumes: `BackupController.writeBackupNow(): Promise<boolean>`, `.markPasswordMismatch()`, `.currentHealth()` from Task 3; `Shell.setSaveState(state: SaveState)` (`SaveState` gains new values in Task 5 — this task only calls `setSaveState('saved')` still for the healthy case, plus reads `currentHealth()`, so it is not blocked on Task 5's pill-state additions landing first as long as this task is applied after Task 5, or `setSaveState` is called with a value already valid before Task 5. To avoid an ordering dependency, this task should be implemented **after** Task 5.).
- Produces: nothing new consumed elsewhere.

- [ ] **Step 1: Write the failing test**

`test/change-password.test.ts` builds `backupCtl` through a shared local factory, `makeBackupCtl(): BackupController` (current lines 32-34) — a single object literal with `writeBackupNow`/`maybeWriteBackup`/`regrantPermission`/`hasMissingGrant`/`checkOrphaned`/`getStatus`, all defaulting to the healthy/no-op case. Every existing test in the file calls this one factory, so extending it in one place (rather than N call sites, unlike `save-controller.test.ts`) fixes typecheck for all of them at once:

```ts
function makeBackupCtl(overrides?: Partial<BackupController>): BackupController {
  return {
    writeBackupNow: vi.fn(async () => true),
    maybeWriteBackup: vi.fn(async () => {}),
    regrantPermission: vi.fn(async () => {}),
    hasMissingGrant: vi.fn(async () => false),
    checkOrphaned: vi.fn(async () => false),
    getStatus: vi.fn(async () => null),
    currentHealth: vi.fn(async () => 'ok'),
    markPasswordMismatch: vi.fn(),
    ...overrides,
  }
}
```

(Note the default `writeBackupNow` changes from `vi.fn(async () => {})` to `vi.fn(async () => true)` — this file's existing tests never assert on `writeBackupNow`'s return value, only that it was called with the right bytes, so this default change doesn't affect them; it just needs to be a valid `boolean`-returning mock now that Task 3 changed the real signature.)

Add, using this factory's new `overrides` parameter — following the same `createChangePassword({ store, session, shell, backupCtl, runExclusive: (fn) => fn(), setPassword })` construction the existing tests use (see current lines 44-52):

```ts
test('marks the password-mismatch latch and reflects it on the pill when the immediate backup write fails', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const session = makeSession()
  const shell = makeShell()
  const backupCtl = makeBackupCtl({
    writeBackupNow: vi.fn(async () => false),
    currentHealth: vi.fn(async () => 'password-mismatch'),
  })
  const changePassword = createChangePassword({
    store, session, shell, backupCtl, runExclusive: (fn) => fn(), setPassword: vi.fn(),
  })

  await changePassword('new-password')

  expect(backupCtl.markPasswordMismatch).toHaveBeenCalledTimes(1)
  expect(shell.setSaveState).toHaveBeenCalledWith('backup-password-mismatch')
})

test('does not mark the password-mismatch latch when the immediate backup write succeeds', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const session = makeSession()
  const shell = makeShell()
  const backupCtl = makeBackupCtl({ writeBackupNow: vi.fn(async () => true), currentHealth: vi.fn(async () => 'ok') })
  const changePassword = createChangePassword({
    store, session, shell, backupCtl, runExclusive: (fn) => fn(), setPassword: vi.fn(),
  })

  await changePassword('new-password')

  expect(backupCtl.markPasswordMismatch).not.toHaveBeenCalled()
  expect(shell.setSaveState).toHaveBeenCalledWith('saved')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/change-password.test.ts -t "password-mismatch"`
Expected: FAIL — `markPasswordMismatch` is never called today, and the final `setSaveState` call is unconditionally `'saved'`.

- [ ] **Step 3: Implement**

In `src/core/change-password.ts`, replace the tail of the function (current lines 61-70):

```ts
      const backupOk = await deps.backupCtl.writeBackupNow(bytes).catch((e: unknown) => {
        console.error(e)
        return false
      })
      if (!backupOk) deps.backupCtl.markPasswordMismatch()
      deps.setPassword(newPw)
      deps.store.markSaved()
      deps.shell.setSaveState(backupHealthPillState(await deps.backupCtl.currentHealth()))
      deps.shell.setTitle(deps.session.name, false)
```

Add `backupHealthPillState` to this file's import from `./backup-controller`:

```ts
import type { BackupController } from './backup-controller'
import { backupHealthPillState } from './backup-controller'
```

(An `'orphaned'` health here maps to `'saved'` via `backupHealthPillState`, same as the `'ok'` case — an orphan is only ever detected, and self-disables the pref, from `save-controller.ts`'s regular save path, never from this one-off password-change write, so this branch is defensive rather than reachable in practice.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/change-password.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/change-password.ts test/change-password.test.ts
git commit -m "fix(backup): surface backup health immediately after a password change

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: `shell.ts` — new `SaveState` values, colors, and click routing

**Files:**
- Modify: `src/ui/shell.ts`
- Modify: `styles.css` (new `[data-state="…"]` rules)
- Modify: `src/core/i18n.ts` (new pill-label keys)
- Test: `test/shell.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SaveState` gains `'backup-error' | 'backup-permission' | 'backup-password-mismatch'`; `Shell.onBackupRetryRequest(cb: () => void): void` (new registration, mirrors `onGrantRequest`); `requestSaveNow()` routes the two clickable new states to `grantRequestHandler`/a new `backupRetryHandler`. Consumed by Task 6 (`save-controller.ts` sets these states) and Task 7's `main.ts` wiring, Task 9 (`action-items.ts`'s mirrored clickable-list).

- [ ] **Step 1: Write the failing tests**

`test/shell.test.ts` builds shells via a local `setup(): Shell` helper (calls `stubMatchMedia()` then `createShell('en-US')`, appends `shell.root` to `document.body` — see its lines 17-22), reads the pill via `shell.root.querySelector('.tt-save-pill')`, and drives clicks with `pill.click()` (see its existing "clicking the pill in the permission state..." test at line 158). Add, following that exact pattern:

```ts
describe('backup-specific states', () => {
  test.each(['backup-error', 'backup-permission', 'backup-password-mismatch'] as const)(
    'setSaveState(%s) stamps data-state',
    (state) => {
      const shell = setup()
      shell.setSaveState(state)
      expect(shell.root.querySelector('.tt-save-pill')!.getAttribute('data-state')).toBe(state)
    }
  )

  test('the pill is clickable in backup-permission and backup-password-mismatch, not in backup-error', () => {
    const shell = setup()
    const pill = shell.root.querySelector('.tt-save-pill') as HTMLElement
    shell.setSaveState('backup-permission')
    expect(pill.classList.contains('tt-save-pill-clickable')).toBe(true)
    shell.setSaveState('backup-password-mismatch')
    expect(pill.classList.contains('tt-save-pill-clickable')).toBe(true)
    shell.setSaveState('backup-error')
    expect(pill.classList.contains('tt-save-pill-clickable')).toBe(false)
  })

  test('clicking the pill in backup-permission fires onGrantRequest, not onBackupRetryRequest', () => {
    const shell = setup()
    const grantCb = vi.fn()
    const backupRetryCb = vi.fn()
    shell.onGrantRequest(grantCb)
    shell.onBackupRetryRequest(backupRetryCb)
    const pill = shell.root.querySelector('.tt-save-pill') as HTMLElement

    shell.setSaveState('backup-permission')
    pill.click()

    expect(grantCb).toHaveBeenCalledOnce()
    expect(backupRetryCb).not.toHaveBeenCalled()
  })

  test('clicking the pill in backup-password-mismatch fires onBackupRetryRequest, not onGrantRequest', () => {
    const shell = setup()
    const grantCb = vi.fn()
    const backupRetryCb = vi.fn()
    shell.onGrantRequest(grantCb)
    shell.onBackupRetryRequest(backupRetryCb)
    const pill = shell.root.querySelector('.tt-save-pill') as HTMLElement

    shell.setSaveState('backup-password-mismatch')
    pill.click()

    expect(backupRetryCb).toHaveBeenCalledOnce()
    expect(grantCb).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/shell.test.ts -t backup`
Expected: FAIL — the new `SaveState` values don't typecheck yet / `onBackupRetryRequest` doesn't exist.

- [ ] **Step 3: Implement**

In `src/ui/shell.ts`:

1. Extend the union (current line 7):

```ts
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'permission' | 'backup-error' | 'backup-permission' | 'backup-password-mismatch'
```

2. Extend `SAVE_STATE_KEY` (current lines 105-111):

```ts
const SAVE_STATE_KEY: Record<SaveState, MsgKey> = {
  saved: 'save_saved',
  dirty: 'save_dirty',
  saving: 'save_saving',
  error: 'save_error',
  permission: 'save_permission',
  'backup-error': 'save_backup_error',
  'backup-permission': 'save_backup_permission',
  'backup-password-mismatch': 'save_backup_password_mismatch',
}
```

3. Add the new `onBackupRetryRequest` registration to the `Shell` interface (near `onGrantRequest`, current lines 52-59):

```ts
  /**
   * Registers the click handler for the save-state pill while it's in the
   * 'backup-password-mismatch' state — the backup mirror is known to still be
   * encrypted under a previous password. Separate from onGrantRequest: the
   * fix here is a fresh write, not a permission re-grant.
   */
  onBackupRetryRequest(cb: () => void): void
```

4. Inside `createShell`, add the handler variable alongside `grantRequestHandler` (find its declaration near the other `*Handler` variables) and its setter:

```ts
  function onBackupRetryRequest(cb: () => void): void {
    backupRetryRequestHandler = cb
  }
```

(declare `let backupRetryRequestHandler: (() => void) | null = null` alongside the existing handler variables.)

5. Update `renderSaveIndicator()`'s clickable-class toggle (current lines 266-269):

```ts
    saveIndicator.classList.toggle(
      'tt-save-pill-clickable',
      currentState === 'dirty' || currentState === 'error' || currentState === 'permission' ||
      currentState === 'backup-permission' || currentState === 'backup-password-mismatch'
    )
```

6. Update `requestSaveNow()` (current lines 339-345):

```ts
  function requestSaveNow(): void {
    if (currentState === 'permission' || currentState === 'backup-permission') {
      grantRequestHandler?.()
      return
    }
    if (currentState === 'backup-password-mismatch') {
      backupRetryRequestHandler?.()
      return
    }
    if (currentState === 'dirty' || currentState === 'error') saveRequestHandler?.()
  }
```

7. Add `onBackupRetryRequest` to the final `return { ... }` (current line 363).

In `src/core/i18n.ts`, add three keys to both the `pt-BR` block (near `save_permission` at line 18) and the `en-US` block (near `save_permission` at line 550):

```ts
// pt-BR
save_backup_error: 'Backup: erro',
save_backup_permission: 'Backup: permissão necessária',
save_backup_password_mismatch: 'Backup: senha antiga',
```

```ts
// en-US
save_backup_error: 'Backup: error',
save_backup_permission: 'Backup: grant needed',
save_backup_password_mismatch: 'Backup: old password',
```

In `styles.css`, after the existing `[data-state="permission"]` rule (current lines 363-372), add:

```css
/* Backup-specific pill states — same severity-coded tokens as the primary
   file's states (danger=broken, brass=needs a grant), so color still means
   the same thing everywhere; the pill's "Backup:" label prefix is what
   disambiguates which file a given state is about. */
.tt-save-pill[data-state="backup-error"] {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, var(--panel));
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
}
.tt-save-pill[data-state="backup-permission"] {
  color: var(--brass);
  background: color-mix(in srgb, var(--brass) 14%, var(--panel));
  border-color: color-mix(in srgb, var(--brass) 45%, var(--border));
}
.tt-save-pill[data-state="backup-password-mismatch"] {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--panel));
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/shell.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/shell.ts src/core/i18n.ts styles.css test/shell.test.ts
git commit -m "feat(ui): add backup-specific save-pill states

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: `save-controller.ts` — dispatch on `currentHealth()`, distinct toasts

**Files:**
- Modify: `src/core/save-controller.ts:148-194` (`resolveGrants`'s tail), `src/core/save-controller.ts:274-311` (`doSave`'s tail)
- Modify: `src/core/i18n.ts` (new toast keys)
- Test: `test/save-controller.test.ts`

**Interfaces:**
- Consumes: `BackupController.currentHealth()`, `backupHealthPillState()` (Task 3), new `SaveState` values + `onBackupRetryRequest` (Task 5).
- Produces: nothing new consumed elsewhere — this is the orchestration layer.

**Important — this task changes the shape of the `BackupController` interface `test/save-controller.test.ts` mocks against.** That file builds `backupCtl` as hand-written object literals (not via the real `createBackupController`), e.g. lines 330-337, 363, 409-416, 445-454, 890, 910ish, 946ish, 974ish, 1014 (search the file for `const backupCtl = {` to find all of them — there are roughly eight). Once `BackupController` requires `currentHealth`/`markPasswordMismatch` (Task 3), every one of these object literals fails to typecheck without them. Fixing this is part of Step 3 below, not optional cleanup.

It also changes the *behavior* two existing tests assert on: `'a successful primary save with a missing backup grant sets state to permission, not saved, and toasts'` (current line 403) and `'"Grant access..." for a backup-only lapse mirrors to the backup now instead of waiting for the interval'` (current line 434) both currently expect the primary `'permission'` state and the primary `save_permission_toast` copy for what is actually a *backup*-only lapse — exactly the conflation this plan fixes. Both need rewriting, not just a mechanical mock patch.

- [ ] **Step 1: Write the failing tests**

This file constructs everything inline per test (`createStore(createEmptyDocument('en-US'))`, `makeShell()`, `makeSession()`, `createSaveController({...})` directly, `vi.spyOn(shell, 'setSaveState')`) rather than through shared factory helpers — follow that exact style. A store is dirtied the same way the existing `'saveNow happy path'`-style tests do: `store.update((d) => { d.prefs.autoSaveMin = 9 })` (any mutation works; that's what the file's own tests use). Add:

```ts
test('a backup grant lapse (primary fine) sets backup-permission, not permission, and toasts backup-specific copy', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const setSaveStateSpy = vi.spyOn(shell, 'setSaveState')
  const session = makeSession()
  const backupCtl = {
    writeBackupNow: vi.fn(async () => true),
    maybeWriteBackup: vi.fn(async () => {}),
    regrantPermission: vi.fn(async () => {}),
    hasMissingGrant: vi.fn(async () => true),
    checkOrphaned: vi.fn(async () => false),
    getStatus: vi.fn(async () => null),
    currentHealth: vi.fn(async () => 'permission' as const),
    markPasswordMismatch: vi.fn(),
  }

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(), backupCtl,
  })

  await ctl.saveNow()

  expect(setSaveStateSpy.mock.calls.map((c) => c[0])).toEqual(['saving', 'backup-permission'])
  const [msg] = modalMocks.toast.mock.calls[0] as [string]
  expect(msg).toBe('Backup file write access was lost — your data is still saved to the primary file')
})

test('a generic backup write error sets backup-error', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const setSaveStateSpy = vi.spyOn(shell, 'setSaveState')
  const session = makeSession()
  const backupCtl = {
    writeBackupNow: vi.fn(async () => false),
    maybeWriteBackup: vi.fn(async () => {}),
    regrantPermission: vi.fn(async () => {}),
    hasMissingGrant: vi.fn(async () => false),
    checkOrphaned: vi.fn(async () => false),
    getStatus: vi.fn(async () => null),
    currentHealth: vi.fn(async () => 'error' as const),
    markPasswordMismatch: vi.fn(),
  }

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(), backupCtl,
  })

  await ctl.saveNow()

  expect(setSaveStateSpy.mock.calls.map((c) => c[0])).toEqual(['saving', 'backup-error'])
})

test('a stale backup password sets backup-password-mismatch', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const setSaveStateSpy = vi.spyOn(shell, 'setSaveState')
  const session = makeSession()
  const backupCtl = {
    writeBackupNow: vi.fn(async () => true),
    maybeWriteBackup: vi.fn(async () => {}),
    regrantPermission: vi.fn(async () => {}),
    hasMissingGrant: vi.fn(async () => false),
    checkOrphaned: vi.fn(async () => false),
    getStatus: vi.fn(async () => null),
    currentHealth: vi.fn(async () => 'password-mismatch' as const),
    markPasswordMismatch: vi.fn(),
  }

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(), backupCtl,
  })

  await ctl.saveNow()

  expect(setSaveStateSpy.mock.calls.map((c) => c[0])).toEqual(['saving', 'backup-password-mismatch'])
})

test('each backup-permission toast fires once per episode, independently of the primary permission toast latch', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const session = makeSession()
  const backupCtl = {
    writeBackupNow: vi.fn(async () => true),
    maybeWriteBackup: vi.fn(async () => {}),
    regrantPermission: vi.fn(async () => {}),
    hasMissingGrant: vi.fn(async () => true),
    checkOrphaned: vi.fn(async () => false),
    getStatus: vi.fn(async () => null),
    currentHealth: vi.fn(async () => 'permission' as const),
    markPasswordMismatch: vi.fn(),
  }

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(), backupCtl,
  })

  await ctl.saveNow()
  store.update((d) => { d.prefs.autoSaveMin = 8 })
  await ctl.saveNow({ explicit: true })

  expect(modalMocks.toast).toHaveBeenCalledTimes(1)
})

test('orphaned still disables the pref and returns the pill to saved (unchanged behavior)', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9; d.prefs.dailyBackupEnabled = true })
  const shell = makeShell()
  const setSaveStateSpy = vi.spyOn(shell, 'setSaveState')
  const session = makeSession()
  const backupCtl = {
    writeBackupNow: vi.fn(async () => false),
    maybeWriteBackup: vi.fn(async () => {}),
    regrantPermission: vi.fn(async () => {}),
    hasMissingGrant: vi.fn(async () => false),
    checkOrphaned: vi.fn(async () => true),
    getStatus: vi.fn(async () => null),
    currentHealth: vi.fn(async () => 'orphaned' as const),
    markPasswordMismatch: vi.fn(),
  }

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(), backupCtl,
  })

  await ctl.saveNow()

  expect(store.doc.prefs.dailyBackupEnabled).toBe(false)
  expect(setSaveStateSpy.mock.calls.map((c) => c[0])).toEqual(['saving', 'saved'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/save-controller.test.ts -t "backup-permission"`
Expected: FAIL — `doSave()`'s tail today calls `hasMissingGrant()`/`checkOrphaned()` directly and always sets the primary `'permission'` state for a backup grant lapse.

- [ ] **Step 3: Implement**

In `src/core/save-controller.ts`:

1. Add two more one-shot latches alongside `permissionEpisodeToasted` (current line 124):

```ts
  let backupPermissionEpisodeToasted = false
  let backupErrorEpisodeToasted = false
  let backupPasswordMismatchEpisodeToasted = false
```

2. Add three small report functions alongside `reportPermissionNeeded` (current lines 137-146), each following the same one-shot-sticky-toast shape:

```ts
  function reportBackupPermissionNeeded(): void {
    deps.shell.setSaveState('backup-permission')
    if (backupPermissionEpisodeToasted) return
    backupPermissionEpisodeToasted = true
    const lc = deps.locale()
    toast(t(lc, 'backup_permission_toast'), {
      sticky: true,
      action: { label: t(lc, 'grant_access_ellipsis'), onClick: () => void resolveGrants() },
    })
  }

  function reportBackupError(): void {
    deps.shell.setSaveState('backup-error')
    if (backupErrorEpisodeToasted) return
    backupErrorEpisodeToasted = true
    toast(t(deps.locale(), 'backup_write_failed_toast'), { sticky: false })
  }

  function reportBackupPasswordMismatch(): void {
    deps.shell.setSaveState('backup-password-mismatch')
    if (backupPasswordMismatchEpisodeToasted) return
    backupPasswordMismatchEpisodeToasted = true
    toast(t(deps.locale(), 'backup_password_mismatch_toast'), { sticky: true })
  }
```

(`backup_write_failed_toast` already exists and already fires from inside `backup-controller.ts`'s own `writeBackupNow` catch block — this is a *second*, pill-driven firing of the same copy from the orchestration layer once `currentHealth()` reports `'error'`. Since `writeBackupNow`'s own latch, `warnedThisSession`, is a completely separate variable from this file's `backupErrorEpisodeToasted`, the two don't double-fire on the same event in practice: `writeBackupNow`'s toast fires at most once per session per underlying failure episode from inside `maybeWriteBackup`'s own call in `doSave` above this tail, while this one guards the *tail's own* re-check. Accepting that both could in principle toast once each around the same failure is consistent with how `backup_orphaned_toast`/`save_permission_toast` already coexist with their own call sites elsewhere in this file — not a new pattern.)

3. Replace `doSave()`'s tail (current lines 274-309):

```ts
    await deps.backupCtl?.maybeWriteBackup(bytes)
    deps.store.markSaved()
    const health = (await deps.backupCtl?.currentHealth()) ?? 'ok'
    if (health === 'orphaned') {
      // The moved-computer case: `backupHandleId` travelled inside the .tmv
      // itself, but the handle it names only ever lived in the old machine's
      // IndexedDB. Left alone this fails silently forever. Disabling the pref
      // here (rather than just toasting) also self-heals: the pref flip is
      // itself a mutation, so the dirty guard schedules a trailing save that
      // persists `dailyBackupEnabled: false` to the primary file.
      deps.store.update((d) => {
        d.prefs.dailyBackupEnabled = false
      })
      const openBackupPrefs = deps.onOpenBackupPrefs
      toast(t(deps.locale(), 'backup_orphaned_toast'), {
        sticky: true,
        ...(openBackupPrefs ? { action: { label: t(deps.locale(), 'backup_orphaned_action'), onClick: () => openBackupPrefs() } } : {}),
      })
      permissionEpisodeToasted = false
      deps.shell.setSaveState('saved')
    } else if (health === 'permission') {
      reportBackupPermissionNeeded()
    } else if (health === 'error') {
      reportBackupError()
    } else if (health === 'password-mismatch') {
      reportBackupPasswordMismatch()
    } else {
      permissionEpisodeToasted = false
      backupPermissionEpisodeToasted = false
      backupErrorEpisodeToasted = false
      backupPasswordMismatchEpisodeToasted = false
      deps.shell.setSaveState('saved')
    }
    deps.shell.setTitle(deps.session.name, false)
```

4. `resolveGrants()` (current lines 148-194) has its own final line reporting whether the *backup* grant is still missing after a regrant attempt — this is the exact same conflation as `doSave()`'s tail (it currently reuses primary `'permission'`/`'saved'`), and must be fixed the same way. Import `backupHealthPillState` (already imported for Task 4's `change-password.ts`; add the same import here) and replace the current tail (current lines 192-193):

```ts
    const stillMissing = (await deps.backupCtl?.hasMissingGrant()) ?? false
    deps.shell.setSaveState(stillMissing ? 'permission' : 'saved')
```

with:

```ts
    deps.shell.setSaveState(backupHealthPillState((await deps.backupCtl?.currentHealth()) ?? 'ok'))
```

5. Wire `shell.onBackupRetryRequest` in `src/main.ts` (see Task 7 — kept in that task since it also needs the shared `retryBackupWrite` helper `prefs.ts` reuses).

- [ ] **Step 4: Fix the pre-existing tests this task's interface/behavior change breaks**

In `test/save-controller.test.ts`:

1. Add `currentHealth: vi.fn(async () => 'ok' as const), markPasswordMismatch: vi.fn(),` to every pre-existing `backupCtl` object literal in the file (search for `const backupCtl = {` — every hit needs both fields, or the object no longer satisfies `BackupController` and the file fails to typecheck). For the handful that already exercise a non-`'ok'` scenario via `hasMissingGrant`/`checkOrphaned`, set `currentHealth` to match what those mocks imply (e.g. a literal with `hasMissingGrant: vi.fn(async () => true)` should get `currentHealth: vi.fn(async () => 'permission' as const)`, one with `checkOrphaned: vi.fn(async () => true)` should get `currentHealth: vi.fn(async () => 'orphaned' as const)`) — `doSave()`'s tail and `resolveGrants()` now read `currentHealth()` directly rather than deriving it from the other two methods, so a mismatched pair would make the test assert against a path the code no longer takes.

2. Rewrite `'a successful primary save with a missing backup grant sets state to permission, not saved, and toasts'` (current lines 403-432) — this is the test superseded by this task's first new test above (same scenario, corrected expectations). Delete it; its replacement is the `'a backup grant lapse (primary fine) sets backup-permission...'` test already added in Step 1.

3. Rewrite `'"Grant access..." for a backup-only lapse mirrors to the backup now instead of waiting for the interval'` (current lines 434-477): its `backupCtl.hasMissingGrant` mock (`mockResolvedValueOnce(true).mockResolvedValue(false)`) drove both the initial tail check *and* `resolveGrants()`'s final check under the old code; under the new code both instead read `currentHealth()`, so give it the matching sequence and update the expected state trail:

```ts
    hasMissingGrant: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
    checkOrphaned: vi.fn(async () => false),
    getStatus: vi.fn(async () => null),
    currentHealth: vi.fn().mockResolvedValueOnce('permission' as const).mockResolvedValue('ok' as const),
    markPasswordMismatch: vi.fn(),
```

and change the final assertion from `expect(setSaveStateSpy.mock.calls.map((c) => c[0])).toEqual(['saving', 'permission', 'saved'])` to `expect(setSaveStateSpy.mock.calls.map((c) => c[0])).toEqual(['saving', 'backup-permission', 'saved'])`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/save-controller.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the new i18n keys**

In `src/core/i18n.ts`, add to the `pt-BR` block near `backup_write_failed_toast` (current line 330):

```ts
backup_permission_toast: 'Permissão de escrita do backup perdida — os dados seguem salvos no arquivo principal',
backup_password_mismatch_toast: 'O backup pode ainda estar criptografado com a senha anterior — clique para atualizá-lo agora',
```

And to the `en-US` block near `backup_write_failed_toast` (current line 852):

```ts
backup_permission_toast: 'Backup file write access was lost — your data is still saved to the primary file',
backup_password_mismatch_toast: 'The backup may still be encrypted with your previous password — click to update it now',
```

- [ ] **Step 7: Commit**

```bash
git add src/core/save-controller.ts src/core/i18n.ts test/save-controller.test.ts
git commit -m "feat(backup): distinct pill state and toast per backup health condition

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: `main.ts` — wire the backup-retry action

**Files:**
- Modify: `src/main.ts:389` (add `retryBackupWrite`), `src/main.ts:449` (wire `onBackupRetryRequest`)

**Interfaces:**
- Consumes: `Shell.onBackupRetryRequest` (Task 5), `BackupController.writeBackupNow` (Task 3).
- Produces: `retryBackupWrite(): Promise<void>`, reused by Task 8's `prefsAppCtl.retryBackupWrite`.

`main.ts` is wiring-only per `CLAUDE.md`'s testing convention (no dedicated `test/main.test.ts`) — this task's correctness is verified by `npm run typecheck` plus a manual smoke check (Step 3).

- [ ] **Step 1: Implement**

In `src/main.ts`, right before `const prefsAppCtl: PrefsAppCtl = {` (current line 390), add:

```ts
  async function retryBackupWrite(): Promise<void> {
    try {
      const currentPw = app ? app.password : password
      const bytes = currentPw === null ? serializePlain(store.doc) : await encryptDocument(store.doc, currentPw)
      await backupCtl.writeBackupNow(bytes)
    } catch (e) {
      console.error(e)
    }
  }
```

Then, alongside the existing `shell.onGrantRequest(...)` wiring (current line 449), add:

```ts
  shell.onBackupRetryRequest(() => void retryBackupWrite())
```

(`encryptDocument`/`serializePlain` are already imported at the top of `main.ts`.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual smoke check**

Run: `npm run build && npx playwright test e2e/fs-api.spec.ts` (or `npm run dev`-equivalent if this project has one — check `package.json` scripts; otherwise open `dist/app.html`) — create a passworded file, enable backup, then in the browser console temporarily force `backupCtl.currentHealth` down a mocked path is impractical for a manual check, so instead: enable backup, change the password, confirm the pill briefly shows "Backup: old password" (or immediately reads "Saved" if the immediate write succeeded, which it should on a normal local file) and clicking a manufactured mismatch state (e.g. by revoking the backup file's permission via the browser's site-settings UI before changing the password) triggers a fresh write and clears the pill.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(backup): wire the pill's backup-retry click to a fresh write

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: `prefs.ts` — generalize the Backup tab's orphan-only notice

**Files:**
- Modify: `src/ui/prefs.ts` (`PrefsAppCtl` interface, `renderBackup`)
- Modify: `src/main.ts` (`prefsAppCtl` object literal)
- Modify: `src/core/i18n.ts` (new hint/action keys)
- Test: `test/prefs.test.ts`

**Interfaces:**
- Consumes: `BackupController.currentHealth()` (Task 3), `retryBackupWrite` (Task 7, reused here as `prefsAppCtl.retryBackupWrite`).
- Produces: `PrefsAppCtl.backupHealth(): Promise<BackupHealth>` and `.regrantBackupPermission(): Promise<void>` and `.retryBackupWrite(): Promise<void>` replace `.checkBackupOrphaned()`.

**Important — this task removes `PrefsAppCtl.checkBackupOrphaned`, which `test/prefs.test.ts` already builds and overrides directly.** Its `setup()` helper (current lines 42-65) constructs a full `appCtl: PrefsAppCtl` object literal including `checkBackupOrphaned: vi.fn(async () => false)` (current line 62), and three existing tests — `'backup tab: an orphaned backup handle turns the pref off and shows the re-setup notice'` (line 755), `'...the orphaned notice's "Set up backup…" button re-picks a target...'` (line 772), `'...in read-only mode shows the notice without flipping the pref'` (line 791) — reassign `appCtl.checkBackupOrphaned = vi.fn(...)` directly. All of these move to `backupHealth`. Fixing this is part of Step 3 below.

- [ ] **Step 1: Write the failing tests**

This file's `setup()` returns a real `{ store, shell, appCtl, ... }` (via `createStore`/`createShell`), and drives the UI with real DOM: `openPrefs(store, shell, 'en-US', appCtl)`, `clickTab('Backup')`, then `await new Promise((resolve) => setTimeout(resolve, 0))` to let the async `backupHealth()`/`backupStatus()` reads resolve, then queries real elements (see the existing orphan tests at lines 755-804 for this exact shape). Add, right after those three existing tests:

```ts
test('backup tab: a lapsed backup grant shows a permission notice with a regrant action', async () => {
  const { store, shell, appCtl } = setup()
  store.update((d) => { d.prefs.dailyBackupEnabled = true; d.prefs.backupHandleId = 'backup-1' })
  appCtl.backupHealth = vi.fn(async () => 'permission')
  appCtl.regrantBackupPermission = vi.fn(async () => {})
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Backup')
  await new Promise((resolve) => setTimeout(resolve, 0))

  const hint = document.querySelector('.tt-prefs-backup-orphaned-hint')
  expect(hint).not.toBeNull()
  const btn = document.querySelector('.tt-prefs-backup-change-btn') as HTMLButtonElement
  btn.dispatchEvent(new Event('click'))
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(appCtl.regrantBackupPermission).toHaveBeenCalledTimes(1)
})

test('backup tab: a stale backup password shows a retry action', async () => {
  const { store, shell, appCtl } = setup()
  store.update((d) => { d.prefs.dailyBackupEnabled = true; d.prefs.backupHandleId = 'backup-1' })
  appCtl.backupHealth = vi.fn(async () => 'password-mismatch')
  appCtl.retryBackupWrite = vi.fn(async () => {})
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Backup')
  await new Promise((resolve) => setTimeout(resolve, 0))

  const btn = document.querySelector('.tt-prefs-backup-change-btn') as HTMLButtonElement
  btn.dispatchEvent(new Event('click'))
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(appCtl.retryBackupWrite).toHaveBeenCalledTimes(1)
})

test('backup tab: a generic backup error shows a retry action', async () => {
  const { store, shell, appCtl } = setup()
  store.update((d) => { d.prefs.dailyBackupEnabled = true; d.prefs.backupHandleId = 'backup-1' })
  appCtl.backupHealth = vi.fn(async () => 'error')
  appCtl.retryBackupWrite = vi.fn(async () => {})
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Backup')
  await new Promise((resolve) => setTimeout(resolve, 0))

  const btn = document.querySelector('.tt-prefs-backup-change-btn') as HTMLButtonElement
  btn.dispatchEvent(new Event('click'))
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(appCtl.retryBackupWrite).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/prefs.test.ts -t "backup tab: a lapsed"`
Expected: FAIL — `PrefsAppCtl` has no `backupHealth`/`regrantBackupPermission`/`retryBackupWrite` yet.

- [ ] **Step 3: Implement**

In `src/ui/prefs.ts`:

1. Replace `checkBackupOrphaned` in the `PrefsAppCtl` interface (current lines 62-71) with:

```ts
  /**
   * Single priority-ordered backup health summary (orphaned / lapsed grant /
   * generic write error / stale password / ok) — see BackupController.currentHealth.
   * Replaces the old orphan-only checkBackupOrphaned() so the Backup tab and
   * the save pill read from the same source of truth.
   */
  backupHealth(): Promise<BackupHealth>
  /** Re-requests write permission on the configured backup handle — the Backup tab's action for a "permission" health notice. */
  regrantBackupPermission(): Promise<void>
  /** Encrypts/serializes the current document under the live password and writes it straight to the backup handle — the Backup tab's action for an "error" or "password-mismatch" health notice. */
  retryBackupWrite(): Promise<void>
```

Add `import type { BackupStatus, BackupHealth } from '../core/backup-controller'` (extending the existing `BackupStatus`-only import at current line 10).

2. Replace the `backupOrphanedNotice` local (current line 190) with:

```ts
  let backupHealthNotice: Exclude<BackupHealth, 'ok'> | null = null
```

3. Replace the orphan-check block inside `renderBackup` (current lines 512-529):

```ts
    if (prefs.dailyBackupEnabled && prefs.backupHandleId && !backupHealthNotice) {
      appCtl
        .backupHealth()
        .then((health) => {
          if (health === 'ok') return
          backupHealthNotice = health
          if (health === 'orphaned' && !appCtl.isReadOnly()) {
            store.update((d) => { d.prefs.dailyBackupEnabled = false }, PREFS_ONLY)
          }
          renderActiveTab()
        })
        .catch(() => {})
```

(leave the `statusBody`/`statusWrap` block right after it unchanged — still gated on `!backupHealthNotice`, just renamed from `!backupOrphanedNotice`.)

4. Replace `orphanedField` (current lines 552-577) with a generalized `healthNoticeField`:

```ts
    const HEALTH_NOTICE_HINT_KEY: Record<Exclude<BackupHealth, 'ok'>, MsgKey> = {
      orphaned: 'prefs_backup_orphaned_hint',
      permission: 'prefs_backup_permission_hint',
      error: 'prefs_backup_error_hint',
      'password-mismatch': 'prefs_backup_password_mismatch_hint',
    }
    const HEALTH_NOTICE_ACTION_KEY: Record<Exclude<BackupHealth, 'ok'>, MsgKey> = {
      orphaned: 'backup_orphaned_action',
      permission: 'prefs_backup_permission_action',
      error: 'prefs_backup_retry_action',
      'password-mismatch': 'prefs_backup_retry_action',
    }
    const healthNoticeField = backupHealthNotice
      ? el(
          'div',
          { class: 'tt-prefs-field tt-prefs-backup-orphaned' },
          el('p', { class: 'tt-data-hint tt-prefs-backup-orphaned-hint' }, t(locale, HEALTH_NOTICE_HINT_KEY[backupHealthNotice])),
          el(
            'button',
            {
              class: 'tt-btn tt-prefs-backup-change-btn',
              type: 'button',
              disabled: !backupAvailable || appCtl.isReadOnly(),
              onclick: () => {
                if (backupHealthNotice === 'orphaned') {
                  pickAndStoreBackupTarget()
                    .then((picked) => {
                      if (picked) {
                        backupHealthNotice = null
                        renderActiveTab()
                      }
                    })
                    .catch(() => {})
                } else if (backupHealthNotice === 'permission') {
                  appCtl.regrantBackupPermission().then(() => renderActiveTab()).catch(() => {})
                } else {
                  appCtl.retryBackupWrite().then(() => renderActiveTab()).catch(() => {})
                }
              },
            },
            t(locale, HEALTH_NOTICE_ACTION_KEY[backupHealthNotice])
          )
        )
      : null
```

5. Update the `children`/`if` block at the end of `renderBackup` (current lines 579-583) to push `healthNoticeField` instead of `orphanedField`.

In `src/main.ts`, replace `checkBackupOrphaned: () => backupCtl.checkOrphaned(),` (current line 410) with:

```ts
    backupHealth: () => backupCtl.currentHealth(),
    regrantBackupPermission: () => backupCtl.regrantPermission(),
    retryBackupWrite,
```

(`retryBackupWrite` is the function Task 7 already defined in this same scope — reused here, not redefined.)

In `src/core/i18n.ts`, add to the `pt-BR` block near `prefs_backup_orphaned_hint` (current line 431):

```ts
prefs_backup_permission_hint: 'Permissão de escrita do backup foi perdida. Conceda acesso novamente para retomar os backups automáticos.',
prefs_backup_error_hint: 'A última tentativa de backup falhou. Tente novamente ou verifique o local do arquivo .bck.',
prefs_backup_password_mismatch_hint: 'O arquivo de backup pode ainda estar criptografado com a senha anterior.',
prefs_backup_permission_action: 'Conceder acesso…',
prefs_backup_retry_action: 'Fazer backup agora',
```

And to the `en-US` block near `prefs_backup_orphaned_hint` (current line 951):

```ts
prefs_backup_permission_hint: 'Backup write access was lost. Grant access again to resume automatic backups.',
prefs_backup_error_hint: 'The last backup attempt failed. Try again, or check the .bck file\'s location.',
prefs_backup_password_mismatch_hint: 'The backup file may still be encrypted with your previous password.',
prefs_backup_permission_action: 'Grant access…',
prefs_backup_retry_action: 'Back up now',
```

- [ ] **Step 4: Fix the pre-existing tests this task's interface change breaks**

In `test/prefs.test.ts`:

1. In `setup()` (current lines 53-63), replace `checkBackupOrphaned: vi.fn(async () => false),` with:

```ts
    backupHealth: vi.fn(async () => 'ok'),
    regrantBackupPermission: vi.fn(async () => {}),
    retryBackupWrite: vi.fn(async () => {}),
```

2. In the three existing orphan tests (current lines 755, 772, 791 — `'backup tab: an orphaned backup handle turns the pref off and shows the re-setup notice'`, `'...the orphaned notice's "Set up backup…" button...'`, `'...in read-only mode shows the notice without flipping the pref'`), replace each `appCtl.checkBackupOrphaned = vi.fn(...)` reassignment with the equivalent `appCtl.backupHealth`:

- Line 758 and line 794: `appCtl.checkBackupOrphaned = vi.fn(async () => true)` → `appCtl.backupHealth = vi.fn(async () => 'orphaned')`
- Line 775: `appCtl.checkBackupOrphaned = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)` → `appCtl.backupHealth = vi.fn().mockResolvedValueOnce('orphaned').mockResolvedValue('ok')`

No other lines in these three tests need to change — they assert on the rendered DOM (`.tt-prefs-backup-orphaned-hint`, the "Set up backup…" button, `store.doc.prefs.dailyBackupEnabled`), not on `appCtl.checkBackupOrphaned` itself, so the rendered behavior stays identical once `backupHealth` reports `'orphaned'` the same way `checkBackupOrphaned` used to report `true`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/prefs.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/prefs.ts src/main.ts src/core/i18n.ts test/prefs.test.ts
git commit -m "feat(prefs): generalize the Backup tab's orphan notice to every health state

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: `action-items.ts` — keep the mirrored pill's clickable list in sync

**Files:**
- Modify: `src/modules/action-items.ts:584-587`
- Test: `test/action-items.test.ts`

**Interfaces:**
- Consumes: nothing new — reads the already-updated `SaveState` union from Task 5 via `SaveStatusInfo`.
- Produces: nothing new consumed elsewhere.

- [ ] **Step 1: Write the failing test**

`test/action-items.test.ts` already has a controllable fake for this exact purpose, `fakeSaveStatus()` (current lines 12-28: returns `{ api, emit, requestCount, subscriberCount }`, where `emit(info)` drives every subscriber the same way `shell.ts`'s real `setSaveState()` would), and an existing test using it — `'the mini pill mirrors whatever ctx.saveStatus broadcasts...'` (current line 1383) — that opens the card modal, expands it, and reads `.tt-save-pill-text`/`.tt-save-pill`'s `data-state`. That test, and the `openModal()` helper it uses, live inside the `describe('renderActionItems — expand mode and the header save-state pill', ...)` block starting at current line 1344 (`openModal` is declared local to that `describe`, current line 1345) — add the new test inside that same `describe` block, immediately after the existing mini-pill test, following its exact pattern:

```ts
test('the mini pill is clickable for backup-permission and backup-password-mismatch, not backup-error', () => {
  const team = makeTeam({ actionItems: [item({ id: 'a' })] })
  const { container, store, pm, loc } = setup(team)
  const fake = fakeSaveStatus()
  render(container, loc, store, pm, 0, fake.api)
  openModal(container)
  document.querySelector<HTMLButtonElement>('.tt-kanban-expand-btn')!.click()

  const pill = document.querySelector('.tt-save-pill')!

  fake.emit({ state: 'backup-permission', label: 'Backup: grant needed', title: 'Backup: grant needed' })
  expect(pill.classList.contains('tt-save-pill-clickable')).toBe(true)

  fake.emit({ state: 'backup-password-mismatch', label: 'Backup: old password', title: 'Backup: old password' })
  expect(pill.classList.contains('tt-save-pill-clickable')).toBe(true)

  fake.emit({ state: 'backup-error', label: 'Backup: error', title: 'Backup: error' })
  expect(pill.classList.contains('tt-save-pill-clickable')).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/action-items.test.ts -t "mini pill"`
Expected: FAIL — the mirror's hardcoded list (current line 586) doesn't include the new states yet.

- [ ] **Step 3: Implement**

In `src/modules/action-items.ts`, update the `subscribeSaveState` callback's clickable-class condition (current lines 584-587):

```ts
    const unsubscribeSaveStatus = ctx.saveStatus.subscribeSaveState((info) => {
      savePillMiniText.textContent = info.label
      savePillMini.title = info.title
      savePillMini.dataset.state = info.state
      savePillMini.classList.toggle(
        'tt-save-pill-clickable',
        info.state === 'dirty' || info.state === 'error' || info.state === 'permission' ||
        info.state === 'backup-permission' || info.state === 'backup-password-mismatch'
      )
    })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/action-items.ts test/action-items.test.ts
git commit -m "fix(ui): keep the action-items mini pill's clickable states in sync with the header pill

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 10: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Build and run the e2e suite**

Run: `npm run build && npm run test:e2e`
Expected: PASS — in particular `fs-api.spec.ts`'s save/backup-related flows, since those exercise the real (OPFS-shimmed) `FileSystemFileHandle` permission/write paths this plan changes the branching around.

- [ ] **Step 4: Update the changelog**

Per `CLAUDE.md`'s changelog convention, add a `### Fixed` entry to the top of `CHANGELOG.md` (under a new or the current unreleased version header, matched to whatever version bump this work ships under) describing the user-visible effect, e.g.:

```markdown
### Fixed
- A lapsed backup permission or a stale backup password no longer look identical to a primary-file save problem — the save indicator and the Backup preferences tab now say specifically which file needs attention.
- Opening a file saved by an older app version now snapshots the original file to your backup before any edits, in case the update introduces a problem.
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for backup resilience + pill alignment

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
