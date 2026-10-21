# Browser Live Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make IndexedDB the live store of an open document (per-record dirty writes, images as separate records, sealed with the password key for encrypted files) and demote the `.tmv` file to a snapshot written at open, at Lock/Close and on a 1–24 h timer; remove the second backup file, Ctrl+S, and the blur/tab-hidden/min-gap save logic.

**Architecture:** The in-memory `Doc` and `store.update(fn, scope)` stay untouched. A new persister watches `store.onMutate`, splits the doc into path-addressed records, diffs them against what it last wrote and commits only the changes (plus new image blobs) in one IndexedDB transaction on a short debounce. Opening a file reconciles it with the browser copy by identity (`docId`) and lineage (`writeId`), never by timestamp. A new file-snapshot controller replaces the save controller and owns the three write moments, the pill health and the failure paths.

**Tech Stack:** TypeScript, Web Crypto (AES-GCM, existing PBKDF2 key), IndexedDB, vitest + jsdom + `fake-indexeddb` (already a dev dependency, see `test/idb.test.ts`), Playwright e2e. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-21-browser-live-store-design.md` (approved). Read it first; this plan only adds the decisions the spec leaves open.

## Global Constraints

- Work directly on `dev`; no worktrees, branches or pushes. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Before every commit run `npm run typecheck && rtk bypass npm run lint && npm test`. Run single files with `npm test -- <file>` (never `npx vitest`). Every commit must leave the whole tree green, so a task that deletes or renames a symbol also fixes every importer and test in the same commit.
- Zero runtime dependencies. No new dev dependencies.
- All user-visible strings go through `t(locale, key)`, with keys in both `pt-BR` and `en-US` in `src/core/i18n.ts`. Delete keys that lose their last user.
- Every `src` module has a matching `test/*.test.ts` (not `main.ts`, `types.ts`, `*.d.ts`). jsdom has no `indexedDB`, Web Locks or File System Access API; code feature-detects, tests inject fakes.
- Comments follow the surrounding density; nontrivial concurrency reasoning is documented in place. Do not add "Task N" comments pointing at this plan's numbering.
- CHANGELOG stays brief (1–4 bullets, headline level). `package.json` is already `3.2.0` and unreleased, so this work joins the existing `## [3.2.0]` entry; do not bump.
- The `.tmv` container stays v2 (3.2.0). The file schema moves 17 → 18; migration 17 → 18 is edited in place by later tasks because 17 never shipped as the final shape (nothing from 3.2.0 is released).
- Caveman-terse chat; commits, docs and README stay normal prose.

## Rulings made while planning

Provisional calls the executor must honor; each costs little if wrong.

- **No HKDF.** Records are sealed with the file's own AES-GCM key under a domain-separated AAD (`live:<docId>:<recordKey>`), random 96-bit IV per seal. Equivalent safety for AES-GCM and no raw key bits exposed to JS (spec said HKDF; it was marked "my call").
- **Image blobs in IndexedDB are the file's stored form verbatim** (`ImageStore.getStored`: sealed under the file key with AAD = image id, or raw for plain files). No re-sealing at open or at file write, and `adoptStored` loads them lazily. Password change rewrites them from the re-keyed `ImageStore`.
- **Record keys are random ids for encrypted docs** and the sealed payload carries `{path, value}`; the path→key map is built when the doc loads (everything is read at open anyway). Plain docs use the same scheme (one code path); readability in devtools is not a goal.
- **No scope-hint optimization.** The persister re-serializes every record on each debounce and compares strings. Add scope hints later only if the large-doc e2e shows a cost.
- **Title asterisk dropped.** With hourly file writes the document is nearly always "unwritten"; the pill carries the information. `shell.setTitle(name)` loses its `dirty` argument.
- **`store.dirty` now means "the file is behind the browser copy".** It is set by every mutation (as today), cleared only by a successful file write, and mirrored into the browser meta as `unwrittenChanges`.
- **Fork** (conflict modal) gives the forked document a fresh `docId`, writes the fork file, deletes the old browser entry and reopens. **Reload** into a file whose `docId` differs from the open document is refused with the existing `conflict_reload_failed` toast.
- **`autoSaveMin` stays in minutes**, clamped 60–1440 (default 60); the Preferences field shows hours (1–24).
- If IndexedDB cannot be opened or a write fails, the app keeps working in memory, the pill shows an error state, and file writes still happen at their moments. It never silently drops an edit (see Review Focus).

## Review Focus

Failure modes the spec implies but the obvious tests would not exercise, most likely first. Each is pinned by a test in the owning task.

1. **The diff misses a mutation path.** `updateNav`, `replaceDoc`, undo-restore of a deleted team, image-only changes and reordering must all reach IndexedDB. Pinned in Task 7 by a differential fuzz against "persist everything" and explicit cases for each path.
2. **Header key vs record key drift** (the 3.2.0 critical bug class). After a password change, a fork, or a second open under the same password, the browser copy must open with the file's current password and only with it. Pinned in Tasks 6, 14.
3. **Browser copy exists but cannot be used**: sealed under a different password than the file just opened, or written by a newer schema. No crash, no silent overwrite; the user chooses. Pinned in Task 8.
4. **Storage failure**: quota exceeded, blocked or unavailable IndexedDB. The edit stays in memory, the pill says so, the next flush retries. Pinned in Task 7.
5. **Read-only tabs and takeover**: a read-only tab never writes records; a tab taking the write lock reloads from the browser store, not from stale memory or the older file. Pinned in Task 11.

---

### Task 1: Schema 18 — `docId` and the file write stamp

**Files:**
- Create: `src/core/file-stamp.ts`, `test/file-stamp.test.ts`
- Modify: `src/core/types.ts`, `src/core/document.ts`, `src/core/crypto.ts`, `src/core/doc-bytes.ts`
- Test: `test/document.test.ts`, `test/crypto.test.ts`, `test/doc-bytes.test.ts`

**Interfaces:**
- Produces (`file-stamp.ts`): `interface FileStamp { writeId: string; savedAt: number }`; `randomHex(bytes: number): string`; `newStamp(now?: number): FileStamp` (`writeId` = 32 hex chars).
- Produces: `Doc.docId: string` (32 hex, created with the document, immutable); `SCHEMA_VERSION = 18`; `migrate()` gives every older doc a fresh `docId`.
- Produces: `OpenedDoc.stamp: FileStamp | null` (null for files written before this change); `encryptDocument(doc, password, images?, ids?, stamp?)` and `serializePlain(doc, images?, ids?, stamp?)` write the stamp into the envelope (`{doc, index, stamp}`; plain: same JSON line); `docToBytes(doc, password, images, stamp?: FileStamp)` defaults to `newStamp()` so every file written from now on carries one.

- [ ] **Step 1: Write failing tests.** `file-stamp`: ids are 32 lowercase hex and unique across 1000 calls; `newStamp(5).savedAt === 5`. `document`: `createEmptyDocument` has a 32-hex `docId`; a schema-17 fixture without `docId` migrates to 18 with one; `validateDoc` rejects a doc whose `docId` is missing or not 32 hex. `crypto`: encrypt→decrypt returns the same `stamp` (password and plain); a file built without a stamp (use a v2 fixture from before this change, or craft an envelope without `stamp`) opens with `stamp === null`; a stamp with non-string `writeId` is treated as null. `doc-bytes`: two calls without a stamp produce different `writeId`s; a passed stamp is written verbatim.
- [ ] **Step 2: Run** `npm test -- test/file-stamp.test.ts test/document.test.ts test/crypto.test.ts test/doc-bytes.test.ts`. Expected: FAIL (missing module/field).
- [ ] **Step 3: Implement** `file-stamp.ts`, the `Doc.docId` field, the 17→18 migration (sets `docId` via `randomHex(16)`), validation, and the envelope/`OpenedDoc` plumbing in `crypto.ts` and `doc-bytes.ts`. Update every place that builds a `Doc` literal (`createEmptyDocument`, team import, test helpers) so typecheck passes. Parsing validates the stamp shape (`writeId` 32 hex string, `savedAt` finite number) and returns null otherwise.
- [ ] **Step 4: Run** the four test files, then the full gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(schema): docId and file write stamp (schema 18)`.

---

### Task 2: Remove the backup feature

**Files:**
- Delete: `src/core/backup-controller.ts`, `test/backup-controller.test.ts`, `e2e/backup.spec.ts`
- Modify: `src/core/types.ts`, `src/core/document.ts` (migration drops `dailyBackupEnabled`, `backupHandleId`, `backupFrequency`), `src/core/save-controller.ts`, `src/core/change-password.ts`, `src/core/conflict-flow.ts`, `src/core/fs.ts` (`pickCreateBackup`), `src/core/i18n.ts`, `src/main.ts`, `src/ui/prefs.ts`, `src/ui/shell.ts`, `src/modules/action-items.ts`, `src/core/undo-delete.ts` and `src/core/crypto.ts`/`doc-bytes.ts` (comments only), `styles.css`
- Test: update `test/save-controller.test.ts`, `test/change-password*.test.ts`, `test/conflict-flow.test.ts`, `test/prefs.test.ts`, `test/shell.test.ts`, `test/action-items.test.ts`, `test/fs.test.ts`, `test/document.test.ts`; e2e `external-change`, `fs-api`, `leak` specs where they reference backup.

**Interfaces:**
- Consumes: nothing from the live store; this task is independent.
- Produces: `SaveState` loses `backup-error`, `backup-permission`, `backup-password-mismatch`; `SaveStatusInfo` loses `backup`; `createBackupTab`/`paintBackupTab` are deleted; `Prefs` loses the three backup fields; `migrate()` strips them from old docs; the Preferences "Backup" tab and the start screen's backup tip keep only what makes sense (the tab becomes the autosave tab, retitled "Saving"/"Salvamento"; the start-screen tip about cloud-synced folders stays, text revisited in Task 16).

- [ ] **Step 1: Write failing tests.** `document`: a doc with the three backup prefs migrates without them. `shell`: pill snapshot has no `backup` key and the DOM has no `.tt-save-pill-backup-tab`. `prefs`: no backup section/tab is rendered; the autosave field is still reachable. `save-controller`/`change-password`/`conflict-flow`: existing behavior tests keep passing with the `backupCtl` dependency removed (edit them to stop constructing it); add a `save_as` test that no backup pref is touched.
- [ ] **Step 2: Run** the listed test files. Expected: FAIL on the new assertions, compile errors on removed deps.
- [ ] **Step 3: Implement** the deletion. `saveAs()` no longer detaches backup prefs; `doSave()` loses all backup latches, toasts and `currentHealth()` branches (tail becomes: `markSaved`, dismiss save toasts, `setSaveState(dirty ? 'dirty' : 'saved')`); `resolveGrants()` loses its backup half (it only re-grants the primary handle, then saves); `change-password.ts` loses the mirror write and mismatch bookkeeping; `conflict-flow.ts` fork no longer builds a detached prefs copy; `main.ts` loses `backupCtl`, `retryBackupWrite`, the migrated-bytes snapshot (`migratedFrom` stays in the `onOpen` signature for now but is ignored; Task 9 removes it) and `onBackupRetryRequest`. Remove the i18n keys `save_backup_*`, `backup_*`, `prefs_backup_*`, `save_as_backup_detached_toast`, `backup_same_file_toast` and the styles. Docs mentions are handled in Task 16.
- [ ] **Step 4: Run** the full gate and `npm run test:e2e` for the touched specs (`npm run test:e2e -- e2e/external-change.spec.ts e2e/fs-api.spec.ts`). Expected: PASS.
- [ ] **Step 5: Commit** `refactor: remove the second backup file`.

---

### Task 3: Record codec

**Files:**
- Modify: `src/core/crypto.ts`
- Test: `test/crypto-records.test.ts` (new)

**Interfaces:**
- Produces: `interface RecordCodec { readonly salt: Uint8Array; seal(aad: string, plain: Uint8Array): Promise<Uint8Array>; open(aad: string, sealed: Uint8Array): Promise<Uint8Array>; makeCheck(): Promise<Uint8Array>; verifyCheck(check: Uint8Array): Promise<boolean> }` and `recordCodec(password: string, salt?: Uint8Array): Promise<RecordCodec>`. `seal` output is `iv(12) ‖ ciphertext`; the real AAD is `'live:' + aad`; `open` throws `CorruptFileError` on any failure; `verifyCheck` never throws and returns false for a wrong key or malformed input.
- Constraint: without `salt` it uses the session key (same key and salt as `blobCodec(password)` and the file header). With a `salt` different from the cached one it derives a fresh key **without** touching the module-level session-key cache (it must not evict the open document's key).

- [ ] **Step 1: Write failing tests.** Round trip; wrong aad fails; a record sealed by `recordCodec` cannot be opened by `blobCodec(password).open` for the same string and vice versa (domain separation); `recordCodec(pw).salt` equals `blobCodec(pw).header.salt` byte for byte; `verifyCheck(await makeCheck())` true and false under another password; `recordCodec(pw, otherSalt)` leaves `blobCodec(pw)` still returning the original salt afterwards (cache not evicted); two seals of the same plaintext differ.
- [ ] **Step 2: Run** `npm test -- test/crypto-records.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `recordCodec` next to `blobCodec`, reusing `getSessionKey`/`deriveKey` (a shared helper for the seal/open core is fine).
- [ ] **Step 4: Run** the file then the full gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(crypto): record codec for the browser store`.

---

### Task 4: Doc ⇄ records

**Files:**
- Create: `src/core/doc-records.ts`
- Test: `test/doc-records.test.ts`

**Interfaces:**
- Produces: `type DocRecords = Map<string, unknown>` keyed by path; `splitDoc(doc: Doc): DocRecords`; `joinDoc(records: DocRecords): Doc`.
- Paths: `doc` (the `Doc` minus `teams`, `templates`, `images`, plus `_order: { teams: string[]; templates: string[] }`); `team/<tid>` (the team minus its collections, plus `_order` of `stakeholders|members|actionItems|milestones|risks`); `team/<tid>/daily/<date>`; `team/<tid>/general`; `team/<tid>/<stakeholders|members|actionItems|milestones|risks>/<id>`; `tpl/<id>`; `img/<id>` (the `ImageMeta`). Anything else on a doc or team object rides in the `doc`/`team` remainder record automatically (so a newly added scalar field is persisted without touching this file); a newly added *collection* is stored inside the remainder, which is correct though coarse.
- Contract: `joinDoc(splitDoc(d))` deep-equals `d` for every valid doc, including empty-string daily notes, a team with no collections, `generalNotes` undefined vs `''`, and arrays in their original order. Record values are JSON-safe plain objects/strings.

- [ ] **Step 1: Write failing tests.** Round trip on `createEmptyDocument`; on a populated fixture (2 teams, every collection, daily notes, templates, images metadata, favorites, nav); a seeded property-style fuzz (200 random docs built with the existing doc test factories, shuffled order, empty strings, unicode) asserting `joinDoc(splitDoc(d))` equals `d` and `JSON.stringify` of unchanged records is stable between two splits; reordering two action items changes only the owning `team/<tid>` record; editing one daily note changes exactly one record; a guard test: a field added at runtime to the doc and to a team (`(doc as any).future = 1`) survives the round trip via the remainder records.
- [ ] **Step 2: Run** `npm test -- test/doc-records.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `splitDoc`/`joinDoc`. Do not mutate the input; `joinDoc` must tolerate records arriving in any map order. Missing `_order` entries fall back to path-sorted order.
- [ ] **Step 4: Run** the file then the full gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(live): split a document into addressable records`.

---

### Task 5: Raw IndexedDB layer

**Files:**
- Create: `src/core/live-db.ts`
- Test: `test/live-db.test.ts` (use `fake-indexeddb` the way `test/idb.test.ts` does; inject an `IDBFactory` so each test gets a fresh database)

**Interfaces:**
- Produces:
  - `interface LiveMeta { docId: string; encrypted: boolean; salt: Uint8Array | null; check: Uint8Array | null; lastWriteId: string | null; knownWriteIds: string[]; unwrittenChanges: boolean; schemaVersion: number; fileName: string; modifiedAt: number; lastFileWriteAt: number | null }`
  - `interface LiveBatch { putRecords: { key: string; value: unknown }[]; deleteRecords: string[]; putBlobs: { id: string; bytes: Uint8Array }[]; deleteBlobs: string[]; meta?: LiveMeta }`
  - `interface LiveDb { getMeta(docId: string): Promise<LiveMeta | undefined>; listMeta(): Promise<LiveMeta[]>; readAll(docId: string): Promise<{ records: { key: string; value: unknown }[]; blobs: { id: string; bytes: Uint8Array }[] }>; commit(docId: string, batch: LiveBatch): Promise<void>; deleteDoc(docId: string): Promise<void>; close(): void }`
  - `openLiveDb(factory?: IDBFactory, name = 'team-tracker-live'): Promise<LiveDb>` — database separate from `idb.ts`'s `team-tracker` so that module stays untouched. Object stores `meta` (key docId), `records` (key `[docId, recordKey]`), `blobs` (key `[docId, imageId]`).
- Contract: `commit` is one transaction over the three stores (all or nothing); a `QuotaExceededError` rejects the whole commit with that error name preserved; the cached connection handles `close`/`versionchange` like `idb.ts`; rejects (does not hang) when `indexedDB` is undefined.

- [ ] **Step 1: Write failing tests.** meta CRUD and `listMeta`; `readAll` returns only the requested doc's rows; `commit` applies puts+deletes+meta atomically (inject a failing request mid-transaction via a wrapped store and assert nothing landed); `deleteDoc` removes meta, records and blobs; two docs do not leak into each other; `Uint8Array` values round-trip as `Uint8Array`; a simulated quota error surfaces with `name === 'QuotaExceededError'` and leaves prior data intact.
- [ ] **Step 2: Run** `npm test -- test/live-db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with plain IndexedDB, no libs.
- [ ] **Step 4: Run** the file then the full gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(live): IndexedDB layer for the browser store`.

---

### Task 6: Sealed, document-scoped store

**Files:**
- Create: `src/core/live-store.ts`
- Test: `test/live-store.test.ts`

**Interfaces:**
- Consumes: `LiveDb`, `LiveMeta`, `RecordCodec`.
- Produces:
  - `interface LiveStore { readonly docId: string; readonly encrypted: boolean; meta(): Promise<LiveMeta | undefined>; load(): Promise<{ records: DocRecords; blobs: Map<string, Uint8Array> }>; write(change: { puts?: DocRecords; deletes?: string[]; putBlobs?: Map<string, Uint8Array>; deleteBlobs?: string[]; meta?: Partial<LiveMeta> }): Promise<void>; rekey(codec: RecordCodec | null, blobs: Map<string, Uint8Array>): Promise<void>; remove(): Promise<void> }`
  - `createLiveStore(db: LiveDb, docId: string, codec: RecordCodec | null): LiveStore`.
- Contract: a stored record value is `{ s: Uint8Array }` (sealed JSON of `{path, value}`; AAD = the record key) for encrypted docs and `{ v: { path, value } }` for plain ones; keys are random 128-bit hex minted at first write and remembered in a path→key map built by `load()`; `write` seals new/changed records before opening the transaction and commits atomically; `meta` is created on the first write with `encrypted`, `salt` and `check` filled from the codec and `schemaVersion = SCHEMA_VERSION`, `modifiedAt` stamped on each write; `rekey` re-seals every record, replaces the blobs and updates `meta` (`encrypted`, `salt`, `check`) in one commit and then swaps the internal codec; a failed `rekey` leaves the old codec in force.
- Blobs: `putBlobs` bytes are the image's stored form verbatim (see rulings); the store does no sealing for them.

- [ ] **Step 1: Write failing tests.** Round trip plain and encrypted; the raw IndexedDB rows of an encrypted doc contain none of a distinctive plaintext string (scan every stored value's bytes, keys included), and no row key reveals a path or date; a record opened with a different docId's aad fails (swap two rows' values and `load` drops/flags them rather than returning the wrong path's content); `load` of a row sealed under another key rejects the whole load with `CorruptFileError`; `write` of a delete removes the row; `rekey` then `load` with the new codec works and the old password's codec fails (`verifyCheck` false); `rekey` with an injected commit failure keeps the old codec working; plain→encrypted and encrypted→plain via `rekey`.
- [ ] **Step 2: Run** `npm test -- test/live-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Pin the header-key coupling: the codec passed to `createLiveStore` must come from the same `recordCodec` call whose `salt` is written into `meta`, never a second lookup of the global cache.
- [ ] **Step 4: Run** the file then the full gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(live): sealed per-document store`.

---

### Task 7: The persister

**Files:**
- Create: `src/core/live-persist.ts`
- Test: `test/live-persist.test.ts`, `test/live-persist-differential.test.ts`

**Interfaces:**
- Consumes: `Store` (`onMutate`, `onDirty`, `doc`, `images`, `readOnly`, `dirty`, `rev`), `LiveStore`, `splitDoc`, `FileStamp`.
- Produces:
  - `interface LivePersister { flush(): Promise<void>; markFileWritten(stamp: FileStamp): Promise<void>; adoptFileStamp(stamp: FileStamp | null): Promise<void>; readonly lastError: unknown; dispose(): void }`
  - `createLivePersister(deps: { store: Store; live: LiveStore; fileName: string; onError?(e: unknown): void; onRecovered?(): void; debounceMs?: number; schedule?: (fn: () => void, ms: number) => () => void }): Promise<LivePersister>` — the promise resolves after the initial sync (see Step 3). Default debounce 400 ms.
- Behavior:
  - **Initial sync:** if the browser store has no records for this doc, write every record and every referenced-or-known image blob; otherwise treat the loaded state as already persisted and seed the cache from `splitDoc(store.doc)` (when the caller opened *from the file* over an existing copy, Task 8 calls `syncFromFile` below instead).
  - **Flush:** `splitDoc(store.doc)`, compare each record's `JSON.stringify` to the cache, commit changed/new records and the deletes of vanished paths, plus blobs for ids in `doc.images` not yet persisted (bytes from `store.images.getStored(id)`; skipped silently if null). Unreferenced images are **not** deleted here. A flush never runs while `store.readOnly`.
  - **Triggers:** every `onMutate` (content and nav) schedules a debounced flush; `flush()` runs immediately and awaits any in-flight commit; mutations during a commit schedule a trailing flush; `dispose()` cancels timers (it does not flush; the caller flushes first).
  - **Meta:** each commit also writes `unwrittenChanges = store.dirty` and `fileName`; `onDirty` triggers a meta-only commit.
  - `markFileWritten(stamp)`: sets `lastWriteId = stamp.writeId`, prepends it to `knownWriteIds` (cap 20), `unwrittenChanges = false`, `lastFileWriteAt = stamp.savedAt`, and sweeps blobs of images no markdown field references (`collectImageRefs`), all in one commit.
  - `adoptFileStamp(stamp)`: used after the app adopted the file as truth (conflict Reload, Task 11): does a full-diff flush then sets `lastWriteId`/`knownWriteIds`/`unwrittenChanges = false`.
  - **Errors:** a rejected commit sets `lastError`, calls `onError(e)`, keeps the cache unchanged (so the next flush retries the same records) and schedules a retry on the next mutation or after 30 s; the first success after an error calls `onRecovered()`.
  - `replaceDoc` (store emits `onMutate('content')`) needs no special case: the diff deletes vanished paths and writes the rest. Image ids absent from the new `ImageStore` are not re-written.

- [ ] **Step 1: Write failing tests.** Using `fake-indexeddb` and a real `createStore`: initial sync on an empty store writes all records once; editing one daily note commits exactly one record put (count the `putRecords`); typing 50 times inside one debounce window commits once; `updateNav` persists nav; `replaceDoc` with a different document leaves the browser store reloadable to the new doc and none of the old; deleting a team removes its records; undo-restore of a deleted team (re-insert via `store.update`) reappears; reordering a list persists the new order; importing an image (put in `ImageStore`, ref added via `store.update`) writes the blob once and a second flush writes nothing; `markFileWritten` sets the meta fields, prunes `knownWriteIds` to 20 and deletes the blob of an image no note references while keeping a referenced one; a read-only store never commits; a failing commit leaves the cache so the retry writes the record, calls `onError` once and `onRecovered` after the retry; `flush()` resolves only after the in-flight commit. Differential test: a seeded fuzz of ~300 random operations (daily-note edit, add/remove/reorder entity, nav change, prefs change, image add, replaceDoc) applying each op through the real store, flushing, then asserting `joinDoc(load())` deep-equals `store.doc` after every op.
- [ ] **Step 2: Run** `npm test -- test/live-persist.test.ts test/live-persist-differential.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep scheduling injectable so tests drive the debounce deterministically.
- [ ] **Step 4: Run** the files then the full gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(live): per-record persister with debounced diff`.

---

### Task 8: Opening — reconcile the file with the browser copy

**Files:**
- Create: `src/core/live-open.ts`, `src/ui/reconcile-dialogs.ts`
- Modify: `src/core/i18n.ts`
- Test: `test/live-open.test.ts`, `test/reconcile-dialogs.test.ts`

**Interfaces:**
- Consumes: `LiveDb`, `LiveStore`, `LiveMeta`, `FileStamp`, `OpenedDoc` (with `stamp`), `recordCodec`, `blobCodec`, `splitDoc/joinDoc`, `createLivePersister`.
- Produces:
  - `type OpenDecision = 'import' | 'identical' | 'browser-newer' | 'ask-older-file' | 'file-from-elsewhere' | 'ask-both-changed'`
  - `decideOpen(file: { docId: string; stamp: FileStamp | null }, meta: LiveMeta | undefined): OpenDecision` — pure; the spec's table: no meta → `import`; same `writeId` and not unwritten → `identical`; same and unwritten → `browser-newer`; `writeId` in `knownWriteIds` but not `lastWriteId` → `ask-older-file`; unknown/null stamp and not unwritten → `file-from-elsewhere`; unknown/null stamp and unwritten → `ask-both-changed`.
  - `interface LiveHandle { live: LiveStore; persister: LivePersister }`
  - `interface Reconciled { doc: Doc; images: ImageStore; password: string | null; stamp: FileStamp | null; source: 'file' | 'browser'; handle: LiveHandle; needsFileWrite: boolean }`
  - `resolveOpen(deps: { db: LiveDb; opened: OpenedDoc; password: string | null; fileName: string; askOlderFile(): Promise<'browser' | 'file'>; askBothChanged(): Promise<'browser' | 'file'>; askBrowserPassword(): Promise<string | null>; createStore(doc: Doc, images: ImageStore): Store }): Promise<Reconciled>` — loads the chosen side, builds the persister, and for `source: 'file'` runs a full sync of the file's content into the browser store with `lastWriteId = opened.stamp?.writeId`, `unwrittenChanges = false`; for `source: 'browser'` it loads doc+images from the store (blobs via `adoptStored`) and sets `needsFileWrite = true`.
  - `ui/reconcile-dialogs.ts`: `askOlderFile(locale)`, `askBothChanged(locale)`: modal returning the choice (dismiss = keep browser copy, the safe default for the first; dismiss = cancel the open for the second, signalled by rejecting with a `OpenCancelled` error the caller treats as "back to start").
- Rules beyond the table:
  - **Locked browser copy:** when the browser copy is the candidate but `recordCodec(password, meta.salt).verifyCheck(meta.check)` is false (different password than the file just opened), call `askBrowserPassword()` in a loop; on null fall back to the file (`source: 'file'`, the browser copy is replaced at sync). The password that opens the used side becomes `Reconciled.password`.
  - **Newer browser schema** (`meta.schemaVersion > SCHEMA_VERSION`): never read it; use the file and overwrite after `askBothChanged`-style confirmation only if unwritten; otherwise silently replace (the old-app-opened-new-store case cannot lose data the current app could read).
  - A browser copy that fails to load (`CorruptFileError`) is treated as absent, with a console error and a toast key `live_copy_unreadable_toast`.
  - Plain files and plain browser entries need no password.

- [ ] **Step 1: Write failing tests.** `decideOpen`: one test per table row plus the null-stamp rows and "different docId never reaches here" (caller keys meta by `docId`, so a missing meta is `import`). `resolveOpen` with `fake-indexeddb`: import writes the store and returns `source: 'file'`; browser-newer returns the browser content with `needsFileWrite`; identical returns the file source with no record writes beyond meta; older-file with user choice browser/file; both-changed each choice; file-from-elsewhere replaces the browser copy; wrong password for the browser copy prompts and succeeds on the second try; cancelling the browser-password prompt uses the file; corrupted browser copy falls back to the file; a newer-schema entry is not read. Dialog tests: button labels, dismiss defaults, locale strings present in both locales.
- [ ] **Step 2: Run** `npm test -- test/live-open.test.ts test/reconcile-dialogs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules and the i18n keys (`reconcile_older_title/body/keep_browser/use_file`, `reconcile_both_title/body/keep_browser/use_file/cancel`, `live_copy_unreadable_toast`, `live_copy_password_title`). Reuse `showModal`/`promptPassword` from `ui/modal.ts`.
- [ ] **Step 4: Run** the files then the full gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(live): reconcile a file with its browser copy on open`.

---

### Task 9: Wire opening and the persister into the app

**Files:**
- Modify: `src/ui/start.ts`, `src/main.ts`, `src/core/save-controller.ts`, `src/core/change-password.ts`, `src/core/conflict-flow.ts`
- Create: `src/core/snapshot.ts`, `test/snapshot.test.ts`
- Test: `test/start.test.ts`, `test/save-controller.test.ts`, `test/change-password.test.ts`, `test/conflict-flow.test.ts`

**Interfaces:**
- Produces (`snapshot.ts`): `buildSnapshot(store: Store, password: string | null): Promise<{ bytes: Uint8Array; stamp: FileStamp; revAtSnapshot: number }>` (one `newStamp()`, one `docToBytes`, rev captured *before* serializing) and `commitSnapshot(persister: LivePersister | null, stamp: FileStamp): Promise<void>` (calls `markFileWritten`, swallowing and logging a failure so a successful file write is never reported as failed).
- `showStartScreen`'s `onOpen` becomes `onOpen(opened: OpenedDocument)` where `OpenedDocument = { session; doc; password; images; handle: LiveHandle; needsFileWrite: boolean; stamp: FileStamp | null }` (the `migratedFrom` backup argument is gone; the open flow opens the live DB once per app via a lazy singleton and calls `resolveOpen`). Create flow: new doc, new `docId`, `resolveOpen`-equivalent "import" path, first file write stamped.
- `main.ts`: `onDocumentOpened` builds the persister from `OpenedDocument.handle`, flushes it in `teardownApp` before the file save, disposes it with the document, subscribes `visibilitychange` (hidden) and `pagehide` to `persister.flush()`, and—if `needsFileWrite`—calls `saveCtl.saveNow({ explicit: true })` right after mount. The old save controller keeps writing the file at its current cadence in this task (switch happens in Task 11) but now builds bytes through `buildSnapshot` and calls `commitSnapshot` after each successful write; `change-password.ts`, `conflict-flow.ts` overwrite and the create flow do the same.

- [ ] **Step 1: Write failing tests.** `snapshot`: stamp unique per build, `revAtSnapshot` equals the store rev before serialization, `commitSnapshot` tolerates a throwing persister. `start`: opening a file with no browser copy imports it (`onOpen` receives a handle whose store contains the doc); opening with an unwritten browser copy resolves to the browser content and `needsFileWrite`; the two ask dialogs are invoked for their rows (inject via deps/mocks); create writes a stamped file and registers the doc. `save-controller`/`change-password`/`conflict-flow`: after a successful write `markFileWritten` is called with the stamp that was written; a failed write does not call it.
- [ ] **Step 2: Run** the listed files. Expected: FAIL.
- [ ] **Step 3: Implement.** The live DB opens lazily; if `openLiveDb` fails, `start.ts` opens the document from the file with a no-op handle (persister null) and shows `live_store_unavailable_toast` (sticky, add both locales), so the old behavior survives. Auto-load-last for plain files goes through the same `resolveOpen`. Keep `lockKey` and everything else as is.
- [ ] **Step 4: Run** the files, the full gate, and `npm run test:e2e -- e2e/save-flow.spec.ts e2e/relaunch.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(live): open reconciles with the browser copy and the persister runs`.

---

### Task 10: File snapshot controller

**Files:**
- Create: `src/core/file-snapshot.ts`
- Test: `test/file-snapshot.test.ts`

**Interfaces:**
- Consumes: `Store`, `FileSession`, `writeFile`, `downloadFallback`, `buildSnapshot`, `commitSnapshot`, `LivePersister`, `ExternalChangeError`.
- Produces:
  - `type WriteReason = 'open' | 'close' | 'timer' | 'export'`
  - `type FileHealth = { kind: 'ok'; lastWrittenAt: number | null } | { kind: 'writing' } | { kind: 'permission' } | { kind: 'error'; message?: string } | { kind: 'export'; lastExportedAt: number | null }` (`export` only when `session.handle` is null)
  - `interface FileSnapshot { writeNow(reason: WriteReason): Promise<WriteResult>; scheduleFrom(prefs: Prefs): void; health(): FileHealth; subscribe(fn: (h: FileHealth) => void): () => void; resolveGrants(): Promise<boolean>; runExclusive<T>(fn: () => Promise<T>): Promise<T>; flush(): Promise<void>; isOverdue(): boolean; dispose(): void }` and `type WriteResult = { ok: true } | { ok: false; reason: 'permission' | 'conflict' | 'error' | 'readonly' | 'nohandle' }`.
- Behavior:
  - `writeNow` runs `deps.flushPending?.()` (editors' debounce), flushes the persister, builds a snapshot, writes through `writeFile` (never a download unless `reason === 'export'`), then `commitSnapshot`, `store.markSaved()` only if `store.rev === revAtSnapshot`, and stamps `lastWrittenAt`. Single-flight: a call during a write returns the in-flight promise; a mutation during the write leaves `store.dirty` true (no trailing write is queued — the next moment handles it).
  - `writeNow` is a no-op returning `{ ok: true }` when the store is clean, except `'open'` and `'export'` which always write.
  - Read-only stores never write (`readonly`). `ExternalChangeError` → `deps.onExternalChange()` unless `isConflictOpen()`, result `conflict`. `NotAllowedError` → health `permission`. Anything else → health `error`. A later success resets health to `ok`.
  - `scheduleFrom(prefs)`: one `setTimeout` for `lastWriteAt + clamp(prefs.autoSaveMin, 60, 1440) minutes` (measured from the last successful write, or from open); on fire, `writeNow('timer')` then re-arm. No timer without a handle. Re-called when the pref changes.
  - `isOverdue()`: `store.dirty` and the interval has elapsed since the last successful write (or since open).
  - `resolveGrants()`: `queryPermission` then `requestPermission({mode:'readwrite'})` on the handle (needs a user gesture); on success retries `writeNow('timer')`; returns whether the grant is held.
  - `runExclusive` / `flush`: same single-writer gate semantics as the old `save-controller` (copy the reentrancy reasoning; `changePassword` uses it).
  - Injectable `now`, timers and `locale`.

- [ ] **Step 1: Write failing tests.** Open write always happens; clean store skips timer/close writes; timer re-arms from the last success and respects a changed pref; rev-guard (edit during a write keeps `dirty`); permission → `permission` health then `resolveGrants` success clears it and writes; `ExternalChangeError` opens the conflict hook once; export reason downloads in fallback mode and sets `lastExportedAt`; no timer without handle; read-only returns `readonly`; `runExclusive` serializes two callers; `isOverdue` before/after the interval; write failure keeps `store.dirty` and the persister untouched; commit failure after a good file write still reports `ok`.
- [ ] **Step 2: Run** `npm test -- test/file-snapshot.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Follow the module-level comment style of `save-controller.ts`; keep toast/pill text out of this module (it only exposes health; Task 13 renders it).
- [ ] **Step 4: Run** the file then the full gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(save): file snapshot controller`.

---

### Task 11: Switch the app to snapshots

**Files:**
- Delete: `src/core/save-controller.ts`, `src/core/blur-save.ts`, `test/save-controller.test.ts`, `test/blur-save.test.ts`
- Modify: `src/main.ts`, `src/core/tab-lock.ts`, `src/core/conflict-flow.ts`, `src/core/change-password.ts`, `src/core/reload-document.ts` (only if its signature changes), `src/ui/app-hotkeys.ts`, `src/ui/shell.ts` (setTitle drops `dirty`), `src/ui/conflict.ts`, `src/core/i18n.ts`
- Test: `test/tab-lock.test.ts`, `test/conflict-flow.test.ts`, `test/change-password.test.ts`, `test/app-hotkeys.test.ts`, `test/shell.test.ts`; e2e: `save-flow`, `close-unsaved`, `tab-takeover`, `tab-lock`, `external-change`, `password-change`, `relaunch` specs

**Interfaces:**
- Consumes: `FileSnapshot` (Task 10), `LivePersister`.
- Produces: `main.ts` builds `FileSnapshot` instead of `SaveController`; hooks: open (`needsFileWrite` → `writeNow('open')`; a first open of a file that is already identical writes nothing), timer via `scheduleFrom`, and the `prefs.autoSaveMin` change subscriber. `resolveAppHotkey` no longer has a `save` action (Ctrl+S falls through to the browser's default, which the app must `preventDefault` to avoid the page-save dialog — keep a no-op handler). `tab-lock`'s dep `saveCtl: SaveController` becomes `{ flushLive(): Promise<void> }` (persister flush); the hand-over no longer writes the file and releases the lock once `flushLive()` resolves, and `refreshBeforeWritable` in `main.ts` becomes `reloadFromLive()` (read the whole doc back from the live store and `store.replaceDoc`), not a disk compare. `conflict-flow`'s reload still reads the file but must (a) refuse a different `docId`, (b) call `persister.adoptFileStamp(stamp)` after `replaceDoc`; overwrite uses `buildSnapshot`/`forceWrite`/`commitSnapshot`; fork assigns `doc.docId = randomHex(16)`, writes the fork file, `live.remove()`s the old entry and reopens through `onOpen` with a fresh handle. `change-password` runs inside `snapshot.runExclusive` (its live re-sealing is Task 14; this task keeps the file write and stamp).
- Removed UI: the `Ctrl+S` mention in help/tooltips, the `fallback` Ctrl+S hint, all `explicit/urgent` options, the 15 s away-save and minimum-gap logic.
- `store.dirty` handling in `onDirty`: no longer sets the title asterisk or `shell.setSaveState('dirty')`; the pill subscribes to `FileSnapshot.subscribe` instead (rendering lands in Task 13, so this task maps `FileHealth` onto the existing `SaveState` values as a thin adapter: `ok`→saved, `writing`→saving, `permission`→permission, `error`→error, `export`→dirty).

- [ ] **Step 1: Write failing tests.** `app-hotkeys`: Ctrl+S resolves to no action but still `preventDefault`s. `tab-lock`: hand-over awaits `flushLive` and releases without any file write; a takeover while `flushLive` rejects keeps the lock and toasts. `conflict-flow`: reload refuses a mismatched `docId` with the toast and leaves the document unchanged; successful reload calls `adoptFileStamp`; fork produces a document with a new `docId`, removes the old live entry, and `reopen` receives a handle; overwrite stamps and commits. `shell`: `setTitle(name)` has no asterisk. A dependency test in `test/lifecycle.test.ts`-style: the persister and snapshot subscriptions are released on `dispose`.
- [ ] **Step 2: Run** the listed unit tests. Expected: FAIL.
- [ ] **Step 3: Implement** the switch and delete the old modules; update all importers (`SAVE_PERMISSION_TOAST_KEY`/`SAVE_ERROR_TOAST_KEY` move into `file-snapshot.ts` or the dialog module of Task 12). Update the e2e specs listed: `close-unsaved.spec.ts` now asserts the Lock/Close failure dialog path (finalized in Task 12), `tab-takeover.spec.ts` asserts the new tab sees the old tab's unwritten edits via the browser store, `save-flow.spec.ts` asserts edit → reload page → edit present even though the file was not rewritten.
- [ ] **Step 4: Run** the full gate and the touched e2e specs. Expected: PASS.
- [ ] **Step 5: Commit** `feat(save): browser store is live, file is a periodic snapshot`.

---

### Task 12: Lock/Close, write failures, window-close warning

**Files:**
- Create: `src/ui/write-failed.ts`, `src/core/close-document.ts` (the close/teardown orchestration extracted from `main.ts` with deps injected, so it is unit-testable)
- Modify: `src/main.ts`, `src/core/i18n.ts`
- Test: `test/write-failed.test.ts`, `test/close-document.test.ts`

**Interfaces:**
- Produces:
  - `showWriteFailedDialog(opts: { locale: Locale; reason: 'permission' | 'error' | 'conflict'; canRegrant: boolean; onRegrant(): Promise<boolean>; onDownload(): void; onRetry(): Promise<boolean>; }): Promise<'closed-anyway' | 'resolved' | 'cancelled'>` — buttons: re-grant permission (only for `permission`), download a copy, retry, close anyway, cancel. Download builds bytes with `buildSnapshot` and `downloadFallback`.
  - `closeDocument(deps: { store; persister; snapshot; flushEditors(): void; ask: typeof showWriteFailedDialog adapter; teardown(): void }): Promise<'closed' | 'kept-open'>`: flush editors → `persister.flush()` → `snapshot.writeNow('close')`; on success teardown; on failure show the dialog and honor the choice; **a failed browser flush with a clean file write still closes** but toasts; a read-only tab closes without writing.
  - Window close: `beforeunload` always flushes editors and starts a best-effort `persister.flush()`; it calls `preventDefault`/`returnValue` **only if `snapshot.isOverdue()`**.
- Replaces `confirmDiscardUnsaved`/`close_unsaved_*` (delete those keys and add `write_failed_*`).

- [ ] **Step 1: Write failing tests.** Close success path tears down in order (flush editors, persister, write, teardown); permission failure shows the dialog with the re-grant button and, on success of `onRegrant`, retries the write and closes; "download" produces a `.tmv` that decodes back to the same document; "close anyway" tears down and leaves `store.dirty` true; cancel keeps the document open; a conflict result does not stack a dialog on the conflict modal (`isConflictOpen`). `beforeunload` handler: not prevented when not overdue, prevented when overdue, always calls flush.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Wire `closeFile()` and the update-banner `reloadForUpdate()` (it currently calls `saveNow` + checks `dirty`; it now calls `closeDocument`-style write via `snapshot.writeNow('close')` and aborts the reload when it fails).
- [ ] **Step 4: Run** the full gate and `npm run test:e2e -- e2e/close-unsaved.spec.ts e2e/pwa-update.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(save): Lock/Close writes the file or offers a way out`.

---

### Task 13: The save pill

**Files:**
- Modify: `src/ui/shell.ts`, `src/ui/panes.ts`, `src/modules/action-items.ts`, `src/main.ts`, `src/core/i18n.ts`, `styles.css`
- Test: `test/shell.test.ts`, `test/action-items.test.ts`, `test/panes.test.ts` (adjust)

**Interfaces:**
- Produces: `shell.setFileHealth(h: FileHealth, ctx: { nextWriteAt: number | null; persistent: boolean | null; storeError: boolean })` replaces `setSaveState`/`setFallbackHint`; `SaveStatusInfo = { health: FileHealth['kind'] | 'store-error'; label: string; title: string; clickable: boolean; stale: boolean }`; `shell.onPillAction(cb: (action: 'regrant' | 'export' | 'failure') => void)` replaces `onSaveRequest`/`onGrantRequest`; `requestSaveNow` becomes `requestPillAction` for the mirrored pill. The `SaveState` union and its CSS classes map to health kinds.
- Behavior: label ok → "Salvo"/"Saved" hover tooltip "Arquivo gravado às HH:MM · próxima gravação até HH:MM" / "File written at HH:MM · next write by HH:MM" (+ a persistence warning line when `persistent === false`); `permission` → label "Conceder acesso"/"Grant access", clickable (re-grant); `error` → "Arquivo não gravado"/"File not written", clickable (opens the failure dialog); `store-error` → "Armazenamento do navegador falhou"/"Browser storage failed", not clickable, tooltip explains; `export` (no handle) → "Exportar arquivo"/"Export file" with "· há 3 h"/"· 3 h ago", always clickable, `stale` when older than the interval (amber); while a write is running: "Gravando…"/"Writing…". Nothing else is clickable. Never show a dirty/unsaved wording.
- The mirrored pill in the expanded action-item modal uses the same snapshot; its backup mini-tab is already gone (Task 2).

- [ ] **Step 1: Write failing tests.** Each health kind's label/title/clickable in both locales; the tooltip includes the last-written and next-write times formatted with `formatHHMM`; the stale class toggles in export mode; clicking an inert pill does nothing; clicking in `permission` calls the action once; mirrored pill follows the shell's snapshot; no `saved`/`dirty` legacy strings remain.
- [ ] **Step 2: Run** the touched tests. Expected: FAIL.
- [ ] **Step 3: Implement** and remove the Task 11 adapter; delete dead i18n keys (`save_dirty*`, `save_fallback_hint`, `fallback_notice` wording is rewritten to describe export, not Ctrl+S).
- [ ] **Step 4: Run** the full gate and `npm run test:e2e -- e2e/fs-api.spec.ts e2e/smoke.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): save pill reports file health`.

---

### Task 14: Password change on the live store

**Files:**
- Modify: `src/core/change-password.ts`, `src/core/live-persist.ts` (a `rekey` pass-through), `src/main.ts`
- Test: `test/change-password.test.ts`, `test/change-password-images.test.ts`, `test/live-persist.test.ts`; e2e `password-change.spec.ts`

**Interfaces:**
- Consumes: `LiveStore.rekey`, `recordCodec`, `blobCodec`, `ImageStore.rekey`.
- Behavior: inside `snapshot.runExclusive`: flush the persister, `images.rekey(newBlobCodec)`, build and write the file, then `live.rekey(recordCodec(newPw), blobs)` where `blobs` are the re-keyed stored forms of every image in the browser store (`images.getStored`) — in that order, so a failed file write rolls back only the image codec exactly as today and leaves the browser store untouched. If the file write succeeded but `live.rekey` fails, the browser copy stays under the old key: surface `error` health and a toast (`live_rekey_failed_toast`), and **set a marker** so the next open reconciles by the old password path (`Task 8`'s locked-copy prompt) instead of losing the copy; do not roll back the file.
- Plain↔encrypted transitions follow the same path (`recordCodec` null for plain).

- [ ] **Step 1: Write failing tests.** After a change, a fresh `resolveOpen` with the new password loads the browser copy and with the old password reports locked; a failed file write leaves both the old file key and the old browser key working (fork-after-reset scenario from 3.2.0: call `resetSessionKey()` between steps); a failed `live.rekey` after a good file write surfaces the toast and the next open prompts for the old password; plain→encrypted and encrypted→plain re-seal everything (raw rows contain no plaintext after the first, readable after the second).
- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full gate and `npm run test:e2e -- e2e/password-change.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(save): password change re-seals the browser copy`.

---

### Task 15: Preferences and storage status

**Files:**
- Modify: `src/ui/prefs.ts`, `src/ui/prefs-fields.ts` (only if the number field needs a unit tweak), `src/core/storage-persist.ts`, `src/main.ts`, `src/core/i18n.ts`, `src/core/document.ts` (migration clamps `autoSaveMin` to 60–1440; default 60)
- Test: `test/prefs.test.ts`, `test/storage-persist.test.ts`, `test/document.test.ts`

**Interfaces:**
- Produces: the "Saving" prefs tab (the former Backup tab) shows the file-write interval in hours (1–24, stored as minutes) with a hint that the browser copy is saved continuously and this only controls how often the file is rewritten; and a read-only status line "Browser storage: protected / not guaranteed" driven by `getPersistStatus(): Promise<boolean | null>` (`navigator.storage.persisted()`), with the persistence request now made on every build when a document opens (`requestPersistentStorage` currently runs only in the PWA build). The Data tab's existing picture-usage line is unaffected.
- The pill's `persistent` context (Task 13) comes from the same function; a `false` result adds the tooltip warning line.

- [ ] **Step 1: Write failing tests.** Migration clamps 5 → 60 and 5000 → 1440, keeps 120; the field commits hours as minutes and rejects outside 1–24; `getPersistStatus` returns null when unsupported; the status line renders each state in both locales; `requestPersistentStorage` is called once per opened document in both build variants (`__PWA__` false in tests).
- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(prefs): file-write interval in hours and storage status`.

---

### Task 16: Documentation

**Files:**
- Modify: `README.md` (FAQ), `src/ui/help.ts` and `src/core/i18n.ts` help strings, `src/core/CLAUDE.md`, root `CLAUDE.md` (only the lines that say the file is the live store or mention backup), `docs/ARCHITECTURE.md`, `CHANGELOG.md`, start-screen tip strings (`start_backup_tip_*`), `e2e/CLAUDE.md`
- Test: `test/help.test.ts`, `test/start.test.ts` (string keys), `test/readme-faq.test.ts` if such a docs test exists (grep first; follow its pattern)

**Interfaces:** none produced. Content requirements (normal prose, both languages where in-app):
- README FAQ: how saving works now (browser holds the live content; file written at open, at Lock/Close and every 1–24 h); clearing browser data or site storage before the file is written loses the work since the last write; always close with Lock/Close, which guarantees a file write; what happens when a write fails (re-grant permission or download a copy); one browser, one device, no multi-device sync, and a cloud-synced folder is the suggested backup because the file's contents are encrypted; why Chromium-based browsers are recommended (silent file writes, permission re-grant, no downloads) and what other browsers get (browser store plus manual Export from the pill); the 3.2.0 note that earlier releases cannot open the new files stays.
- Help text and `src/core/CLAUDE.md`: replace the "save-controller / backup-controller" bullets with the live store, persister, reconcile and file-snapshot modules and the rulings above that a future maintainer needs (record layout, AAD domain, image blob form, reconcile table, `docId`/`writeId`).
- CHANGELOG: fold into `## [3.2.0]` as headline bullets, brief: pictures in notes (existing), the browser now holds the live copy and the file is written at open/close/timer, backup file removed. No per-button lists.
- Start-screen backup tip rewritten to "put your `.tmv` in a cloud-synced folder; that is your backup".

- [ ] **Step 1: Write/adjust failing tests** for any string-key or snapshot tests that pin the old wording.
- [ ] **Step 2: Run** `npm test -- test/help.test.ts test/start.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the documentation.**
- [ ] **Step 4: Run** the full gate. Expected: PASS.
- [ ] **Step 5: Commit** `docs: browser live store, file snapshots, Chromium recommendation`.

---

### Task 17: End-to-end coverage

**Files:**
- Create: `e2e/live-store.spec.ts`
- Modify: any e2e spec still asserting old save behavior (`hotpath`, `perf`, `large-doc`, `leak`, `fs-api`, `relaunch`), `e2e/CLAUDE.md`, `e2e/opfs-shim.ts` if write counting is needed
- Test: the specs themselves

**Interfaces:** none produced.

- [ ] **Step 1: Write the specs** (real Chromium, OPFS shim as in `fs-api.spec.ts`): (a) edit a note, reload the page, reopen the file → the edit is present and the file on disk was **not** rewritten in between (count shim writes); (b) Lock/Close writes the file once and the reopened file contains the edit; (c) with a password file, scan every IndexedDB row of the origin for the typed note text and password → absent; (d) clear IndexedDB between sessions → opening the file loads the file's content; (e) restore an older file copy while the browser has later changes → the older-file dialog appears and "keep browser copy" rewrites the file; (f) revoke the permission mid-session (shim) → pill goes to the re-grant state, Lock/Close shows the failure dialog, re-grant then close succeeds; (g) timer: with `autoSaveMin` forced to 60 and a faked clock, the file is written once the hour passes and not before; the window-close warning only fires after it; (h) 30 pictures pasted → one flush writes only new blobs (assert write counts), reload shows them; (i) two tabs: edit in tab A, "Take control" in tab B → B shows A's edits without a file write; (j) the large-doc case from `large-doc.ts`: typing stays under the existing budget in `perf.spec.ts`.
- [ ] **Step 2: Run** `npm run test:e2e -- e2e/live-store.spec.ts`. Expected: FAIL until the earlier tasks are complete; fix only the spec or genuine defects found, recording any defect as a regression test in its owning module's unit test first (TDD).
- [ ] **Step 3: Update** the other specs to the new semantics (no Ctrl+S, no dirty/unsaved wording, no backup).
- [ ] **Step 4: Run** `npm run typecheck && rtk bypass npm run lint && npm test` then `npm run test:e2e` (full, fresh build). Expected: PASS.
- [ ] **Step 5: Commit** `test(e2e): browser live store flows`.
