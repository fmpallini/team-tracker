# Browser live store — design

Status: draft for approval. Supersedes the "second backup file" model and the save-timing work (tab-hidden and blur saves, minimum gap between background saves) that landed on `dev` in 3.2.0 (unreleased). It keeps the embedded-images feature of 3.2.0 and the `.tmv` v2 container.

## Intent

Today the `.tmv` file is the live store: every change must be written to it, so a save rewrites the whole file, images included. With 30–50+ images per file that is slow and heavy, and it forced a pile of timing logic (away-save timer, tab-hidden, minimum gap) to keep saves from hurting.

The new model flips this. The browser's IndexedDB is the live store. Every edit lands there immediately, and only the records that changed are rewritten. The `.tmv` becomes a periodic snapshot: it is written at a few well-defined moments and otherwise left alone. The file's job is backup and portability, not live persistence.

## Goals

- Edits are durable in the browser within a fraction of a second, writing only what changed (one daily note, one person, one action item, one image), never the whole document.
- Images are first-class separate records, not part of a monolithic write.
- The `.tmv` keeps its current format (v2, as in 3.2.0): one self-contained file, encrypted with the user's password or plain. It still opens anywhere the app runs.
- A password-protected file is never readable from the browser store without the password: the IndexedDB content is encrypted too, including images.
- The user never has to think about saving. There is no manual save command.

## Non-goals and anti-goals

- No multi-device or multi-browser sync. One browser on one device is the supported use. The `.tmv` placed in a cloud-synced folder is the user's backup, not a sync channel. This is a stated limitation, documented in the README.
- Not an offline-first rewrite of the data model. The in-memory `Doc` and the `store.update(fn, scope)` channel stay as they are; no module is rewritten.
- No second backup file. The existing backup feature (a `.bck` sibling written to a second user-picked handle) is removed entirely. A backup is the user's responsibility, and cloud sync of the `.tmv` is the suggested way.
- No protection against someone who can read the browser profile *and* has the password, nor against someone modifying the browser store. Confidentiality for encrypted files is required; tamper-proofing the browser store is not.
- Anti-goal: silent data loss. Any path where the file write fails must say so and offer a way out.

## When the file is written

The file is written, in full, only at these moments:

1. **On open**, according to the open rules below (when the browser copy is the newer one).
2. **On Lock/Close**, the app's own action. This is the moment the user is told to rely on; the write must complete (or fail loudly, see "When a file write fails") before the document is released.
3. **On the auto-timer.** The interval is a preference, 1 to 24 hours, default 1 hour (builder's default; the earlier minimum was lower). The timer measures from the last successful file write.

Not triggers anymore: window blur, tab hidden, Ctrl+S (the shortcut and any manual "save now" are removed), password-change aside (see below). The minimum-gap logic and the away-save timer from 3.2.0 are deleted. When the tab is hidden or unloading, the app flushes pending edits to IndexedDB only.

A password change writes the file immediately, as today, because the file's key changes.

### Window close

The browser window or tab being closed cannot be relied on to finish an asynchronous file write. So the app shows the browser's "leave site?" warning only when the file on disk is older than the auto-timer interval (that is, when the timer is overdue), not on every close with unsaved-to-file changes. The text recommends closing the file with Lock/Close first. If the user closes anyway, nothing is lost: the browser store has everything, and the next open reconciles with the file.

### Browsers without silent file writes

Browsers without the File System Access API (the existing download-fallback mode) cannot write a file silently. There, automatic file writes are off entirely, and the browser store still works normally. The save pill becomes an always-clickable "Export file" button showing the age of the last export ("Export file · last 3 h ago"), turning amber once that age exceeds the timer interval. Export downloads a `.tmv`. No other manual save exists. The README gains a short section explaining why Chromium-based browsers are the better choice (silent file writes, permission re-grant, no downloads) and what the other browsers get.

## The browser store

One IndexedDB database holds, per document id, a small meta record, the record set, and the image blobs. The existing single-connection `idb.ts` key/value wrapper holds file handles and stays; the live store is a separate module with its own object stores because it needs indexed access and transactions.

### Records

The persisted unit is a record: one per daily note, per person, per action item, per milestone, per risk, per template, per kanban column, a record each for a team's scalar fields, the general notes, the preferences/navigation/favorites, and one per image. Exact keys and shapes are the builder's call, with one rule: for an encrypted document, keys must not reveal titles, names or dates (use random ids, or a keyed hash of the entity path under the store's sub-key). Record count and approximate sizes may be visible; contents may not.

The store keeps the whole document loadable in one read at open, and writes are transactional: a debounced flush writes the changed records together, so a crash mid-flush leaves either the old or the new state of the batch, not a mix.

### Dirty marking

Modules keep calling `store.update(fn, scope)`. The scope describes UI re-render, and an absent scope means "everything", so it cannot be trusted as a list of changed records. Instead, the browser store keeps, per record, the serialized form it last wrote (or a hash of it). After each mutation, on a short debounce (builder's call, on the order of a few hundred milliseconds), it re-serializes the candidate records and writes those that differ; records that vanished are deleted. The scope is used only as a hint to skip records that cannot have changed, never to include a record that did (a too-narrow hint would lose data; a too-wide one only costs a comparison). The existing `rev` counter and `onMutate` channel are the hook points. A differential test in the style of `test/search-differential.test.ts` should fuzz mutations against "persist everything" to prove the diff never misses a change.

Images are written when imported (before the markdown reference lands), keyed by content id, and deleted from the store when the file is next written and they are no longer referenced (the same sweep rule as today, applied at the file-write moment so that an undo still finds the bytes).

### Encryption

For a password-protected document, the key derived from the user's password and the file's salt (PBKDF2, as today) is the master. The browser store derives its own sub-key from it with HKDF, so the file and the store never use the same raw key. Every record and every image blob is sealed with AES-GCM, a fresh random 96-bit IV each time, and an AAD that binds the document id and the record key, so a record cannot be swapped for another. Images are sealed exactly like records. The salt and the password-check block are stored unencrypted in the document's meta record, as they are in the file header. The derived key lives only in memory and is never persisted. A password change re-seals every record and image in one transaction, together with the new file write. Plain (password-less) documents are stored unencrypted.

### Persistence request

At first use the app calls `navigator.storage.persist()`. If the browser refuses, the save pill's tooltip and the Data tab say that clearing site data would lose work not yet written to the file.

## Reconciling the browser store with the file (open)

Timestamps are not used to decide which side is newer: they can be wrong, restored, or identical after a copy. The decision rests on identity and lineage.

The `.tmv` envelope gains (schema 18):
- `docId`: a random id, created with the document and kept for its life.
- `writeId`: a fresh random 128-bit value set on every file write.
- `savedAt`: the wall clock at write time, for display only.

The browser's meta record for a document holds:
- `lastWriteId`: the `writeId` of the last file write or file load it knows about.
- `knownWriteIds`: a short list (the last 20) of `writeId`s this browser has produced or loaded, newest first.
- `unwrittenChanges`: true if the store has edits that are not in the file at `lastWriteId`.

Decision at open, after the user has picked or been remembered the file and the password (if any) has unlocked it:

| Situation | Result |
| --- | --- |
| No browser copy for `docId` | Import the file into the store. |
| File `writeId` = `lastWriteId`, no unwritten changes | Identical, nothing to do. |
| File `writeId` = `lastWriteId`, unwritten changes | Browser is newer: load from the store, write the file. |
| File `writeId` is in `knownWriteIds` but not the latest | File is an older version of what this browser produced (for example a cloud-history restore). Ask: keep the browser copy (default) or replace it with the older file. |
| File `writeId` unknown, no unwritten changes | File came from elsewhere (restored backup, another browser): file wins; load it into the store. |
| File `writeId` unknown, unwritten changes | Both sides changed: show the existing conflict choice (keep browser copy and overwrite the file, or load the file and discard unwritten changes). |
| Different `docId` | A different document; it gets its own store entry. |

A file whose password the user cannot supply never reaches this table; the existing wrong-password flow applies. The existing conflict modal and `ExternalChangeError` detection (the file changing on disk while the app is open) stay in service for the timer and Lock/Close writes.

The cross-tab single-writer lock (Web Locks plus the "take control" handshake) is unchanged; the tab holding it owns the store's writes. A tab that takes over reloads from the browser store rather than from the file.

## When a file write fails

A failure on Lock/Close does not discard anything and does not close the document silently. A dialog offers, as applicable: re-grant file permission (when the permission was lost), download a copy of the file now, retry, or "close anyway — the browser keeps your work, the file is behind". A failure on the timer sets the pill to an error state; the pill opens the same dialog. Failures never touch the browser store.

## The save pill

The pill reports whether the app can write the file when it needs to, not whether the document is dirty (the browser store makes "dirty" mostly moot). It shows the file-permission state; hovering shows when the file was last written (and, in fallback browsers, last exported). Click does something in exactly two cases: re-granting file permission when it was lost (and, in fallback browsers, exporting; and opening the failure dialog above after a failed write). Otherwise it is inert. The text is revisited to fit, in both locales. The small badge tab tucked behind the pill (the backup health indicator) is removed with the backup feature; the pill's backup-related states and their strings go with it.

## What is removed

- The backup feature end to end: `backup-controller.ts`, the `.bck` writes, `prefs.dailyBackupEnabled` / `backupHandleId` / `backupFrequency`, the Backup prefs tab, the pill's backup tab and `backup-*` states, `currentHealth()` backup priorities, README and help text.
- Ctrl+S and every "save now" affordance; the away-save timer, tab-hidden save and minimum-gap logic from 3.2.0 (`blur-save.ts` and the matching parts of `save-controller.ts`).
- The user-facing wording that treats the file as the live store.

Preferences migrate: removed backup preferences are dropped on load; `autoSaveMin` is clamped to the 60–1440 range.

## Documentation

The README FAQ and the in-app help state the architecture change plainly: the browser holds the live content; the file is written at open, at Lock/Close and on a 1–24 hour timer; clearing browser data before the file has been written loses the work done since; the recommendation is to close with Lock/Close, which guarantees a file write; a failed write offers a download or a permission re-grant; there is no multi-device sync, and a cloud-synced folder is the suggested backup for the file. A short "Why Chromium" section explains what other browsers lose. The CHANGELOG stays brief; since 3.2.0 is unreleased, the entry covers images and this change together.

## Left to the builder

Record keys and shapes; the debounce value; whether the store is one module or split (live store, reconcile-on-open, failure dialog); the exact pill strings; how the `knownWriteIds` ask-dialog is worded; test layout. The differential persist test and a fake-indexeddb round-trip suite are required.

## Risks the builder should check deliberately

- A diff that misses a mutation path (the fuzz test above is the guard).
- Memory and time of re-serializing large records on every debounce with 50+ images: images must not be re-hashed or re-sealed unless new.
- Password change failing halfway: file and store must not end up under different keys (the same class of bug as the 3.2.0 header-key fix).
- Opening a document whose browser entry was written by a newer schema.
- Storage quota exceeded in IndexedDB: the edit must not be dropped silently; the pill and a toast say so.
