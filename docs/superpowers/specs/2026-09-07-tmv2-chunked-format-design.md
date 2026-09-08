# TMV2: Chunked File Format — Design Sketch

**Date:** 2026-09-07
**Status:** Idea — captured, not scheduled, not approved. No implementation should start from this document without a brainstorming pass first.
**Scope (if built):** `src/core/crypto.ts`, `src/core/fs.ts`, `src/core/document.ts`, `src/core/save-controller.ts`, `src/core/backup-controller.ts`, `src/core/tab-lock.ts`, `src/core/search.ts`, tests

## 1. Why this document exists

The 2.7.5 search work (see `CHANGELOG.md`) made querying a large document
substantially cheaper, and in doing so established that the remaining costs sit
somewhere else entirely: in the file format. Opening and saving are unaffected
by any amount of search tuning, because both are whole-document operations by
construction.

This is a parking-lot document. It records the shape of a possible answer — a
chunked container, provisionally "TMV2" — while the reasoning is fresh, so a
future refactor can start from it rather than rediscovering it. It also collects
the *other* limitations that a format change would be the natural moment to
address, since a format migration is expensive to do twice and we would want to
spend it well.

Nothing here is committed. Several parts are explicitly flagged as unmeasured or
unresolved.

## 2. What the format is today

`src/core/crypto.ts` writes a single self-contained blob:

```
"TMV1" | formatVersion(1) | salt(16) | ivKcv(12) | kcv(32) | ivData(12) | ciphertext(...)
```

The ciphertext is `JSON.stringify(doc)` under AES-GCM, with a 256-bit key from
PBKDF2-SHA256 at 600,000 iterations. A separate key-check block (`kcv`) lets a
wrong password be distinguished from a corrupt file. Password-less files use a
different, deliberately human-readable path: the ASCII line `TMV-PLAIN\n`
followed by the raw JSON.

Measured on a 17.5 MB-JSON document (Node, same Web Crypto implementation the
browser uses):

| Operation | Cost |
|---|---|
| PBKDF2 key derivation | ~99 ms |
| AES-GCM decrypt (whole payload) | ~47 ms |
| `JSON.parse` | ~18 ms |
| `migrate()` | ~0 ms |
| **Open, total** | **~165 ms** |
| `JSON.stringify` | ~32 ms |
| AES-GCM encrypt (whole payload) | ~50 ms |
| **Save, total (session key cached)** | **~82 ms** |

The derivation is paid once per session — `crypto.ts` caches the derived
`CryptoKey` — so subsequent saves are the ~82 ms figure, not ~170 ms.

None of these numbers are alarming at 17.5 MB. The point is their *shape*: every
one of them is O(whole document), so they grow linearly and without bound as a
user's file does, no matter which team or note they actually touched.

## 3. Limitations a format change could address

Not all of these are caused by the format. They are grouped by how directly a
chunked container would help, so a future planning pass can tell the genuine
wins from the wishful ones.

### 3.1 Directly caused by the single-blob format

1. **Save cost is proportional to the document, not to the edit.** Typing one
   character in one daily note re-serializes and re-encrypts every team, every
   note, every task. At 17.5 MB that is ~82 ms per autosave round; at 100 MB it
   is several hundred.
2. **Open cost is proportional to the document.** The user waits for the whole
   file before seeing the first team, even though the shell only renders one
   team's panes.
3. **The backup mirror rewrites everything too.** `backup-controller.ts` writes a
   full second copy on every throttled interval, doubling the write volume.
4. **Corruption is all-or-nothing.** One damaged byte in the ciphertext fails the
   GCM tag for the entire document. There is no partial recovery, and the `.bck`
   sibling is the only mitigation.
5. **Password change re-encrypts the whole document** (`change-password.ts`),
   which is why it needs `runExclusive()` and why it is slow on big files.
6. **Attachments are effectively impossible.** Any binary — a pasted image, a PDF
   — would have to be base64'd into the single JSON blob, inflating every
   subsequent parse, stringify, encrypt and decrypt by 4/3 of its size, forever,
   for every save.

### 3.2 Made harder by the format, but not purely its fault

7. **External-change detection is a hard failure, not a merge.** `fs.ts` compares
   `lastModified` and throws `ExternalChangeError`. With no structure inside the
   file there is nothing to merge, so a hard stop is the only safe response.
   Per-chunk digests would at least make "these three teams changed underneath
   you, yours did not" expressible.
8. **Cross-tab concurrency is one writer, full stop.** `tab-lock.ts` grants a
   single read-write tab per file and demotes the rest, because two tabs writing
   one blob would silently clobber. Chunk-level ownership is *conceivable* — but
   see §8, this is the speculative end of the document.
9. **No history or cross-session undo.** Keeping past versions of a
   whole-document blob means storing whole extra copies. Keeping past versions of
   a chunk is comparatively cheap.
10. **`SchemaTooNewError` is total.** A file written by a newer app version cannot
    be opened at all, even read-only, even for the teams whose shape did not
    change. A manifest carrying per-chunk schema versions could allow partial,
    read-only access instead of a blank refusal.

### 3.3 Would *not* be fixed by chunking

11. **PBKDF2's ~99 ms is inherent and intentional.** It is what makes an offline
    brute-force against a stolen file expensive. It stays.
12. **The search cache still has to be built** the first time a team is searched.
    A prebuilt index chunk is discussed in §7, but it is an optional extra, not a
    consequence of chunking.
13. **Mobile support.** Still gated on the File System Access API, which is a
    platform limitation and unrelated to what is inside the file.

## 4. Proposed container

The intent is the minimum structure that makes reads and writes proportional to
what changed.

```
"TMV2" | formatVersion(2) | salt(16) | ivManifest(12) | kcv block | manifestLen(u32) | manifest(enc) | chunk0 | chunk1 | ...
```

- **Manifest** — encrypted under the same derived key, always read in full on
  open. Holds, for each chunk: its id, kind, byte offset, byte length, its own
  IV, a digest of its ciphertext, and its schema version. It is small (kilobytes
  for hundreds of chunks) so reading it is effectively free.
- **Chunks** — independently encrypted AES-GCM payloads, each with its own IV.
  The natural chunking unit is the team, since teams are what the sidebar
  switches between and what `ChangeScope.teamId` already names. Document-level
  preferences and templates would be their own small chunk.

### 4.1 Two security details that must not be got wrong

These are the parts most likely to be implemented carelessly, so they are written
down explicitly:

**IV uniqueness.** AES-GCM's one hard requirement is that an IV never repeats
under a given key. Every chunk write must draw a fresh random 96-bit IV — never
derive one from a chunk index or a counter that resets. With random 96-bit IVs
the collision probability reaches roughly 2^-33 at 2^32 writes under one key,
which is acceptable, but it means "rewrite one chunk per keystroke forever"
deserves a rekey policy rather than an assumption. A full re-encrypt under a
fresh salt on password change already exists and would serve as the rekey.

**Whole-file integrity, not just per-chunk integrity.** GCM authenticates each
chunk on its own. It does *not* stop someone from deleting a chunk, reordering
chunks, or splicing in an older authenticated version of one. The manifest must
therefore carry a digest of every chunk's ciphertext, and the manifest itself
must be authenticated — which it is, being GCM-encrypted. Verification on open is
then: decrypt manifest, check every chunk's digest against it, and treat a
mismatch as `CorruptFileError`. Without this step TMV2 would be strictly weaker
than TMV1, which authenticates the whole document by construction.

## 5. Incremental save — the part that needs measuring first

The payoff depends entirely on whether a partial write is actually cheaper than a
full one, and that is a browser question, not a design question.

`FileSystemWritableFileStream` supports `seek()` and positioned `write()`, and
`createWritable({ keepExistingData: true })` is meant to preserve the rest of the
file. **However**, Chromium implements `createWritable` by copying the original
into a swap file first — so `keepExistingData: true` may cost a full file copy
before a single byte is written, wiping out the benefit entirely.

**This must be benchmarked before anything else in this document is built.**
`scripts/bench-search.mjs` is the model for how to do it: measure, in a real
Chromium, the cost of rewriting one 200 KB region of a 100 MB file versus
rewriting the whole file. If the swap-file copy dominates, chunking still buys
faster *opens* and everything in §3.1 items 4–6, but not faster saves, and the
design should be re-scoped around that.

A secondary complication: chunks change size as content is edited, so rewriting a
chunk in place is only possible while it still fits. This needs either slack
padding per chunk, an append-and-compact log, or accepting a periodic full
rewrite. An append-only log with occasional compaction is probably the simplest
correct answer and composes well with §3.2 item 9 (history), but it means the
file grows between compactions.

## 6. Migration

Two version numbers move independently and must not be conflated:

- `FORMAT_VERSION` in `crypto.ts` — the container. 1 → 2.
- `SCHEMA_VERSION` in `document.ts` — the shape of the `Doc` inside. Currently 13,
  with the `MIGRATIONS` ladder.

TMV2 is a container change. Ideally it lands with *no* schema change at all, so
the two can be debugged separately. If the refactor also wants schema changes —
and §3 suggests several would ride along naturally — they should still be
separate `MIGRATIONS` steps, applied after the container is parsed.

Reading must stay backward-compatible: sniff the magic, take the TMV1 path for
`"TMV1"`, the TMV2 path for `"TMV2"`, and `parsePlain` for `TMV-PLAIN\n`, as now.
Writing upgrades to TMV2 on the next save, which means a user's existing file
silently becomes unreadable by older app versions. That needs a deliberate
decision and probably a prompt — it is exactly the kind of one-way door the
`.bck` mirror exists to soften.

### 6.1 The plain-text format is a genuine conflict

`TMV-PLAIN` files are human-readable *on purpose* — that is the entire feature.
Chunking them would destroy that, and encrypting nothing means there is no
per-chunk crypto to gain from either.

The recommendation is that **password-less files stay a single JSON blob**,
unchunked, and TMV2 applies to the encrypted path only. This is a real asymmetry
in the codebase and should be documented rather than smoothed over. It is
defensible: a user who wants their file readable in a text editor has already
accepted that the file is a single document.

## 7. Optional: a persisted search index chunk

Once chunks exist, a prepared search index becomes storable — the normalized text
`search.ts` builds today could be written as its own chunk and loaded instead of
recomputed.

This is listed as optional and low priority, deliberately. The 2.7.5 work already
cut the cold index build roughly in half (284 ms → 154 ms on an 18.4 MB document),
so the remaining win is modest, and a persisted index introduces a staleness
problem that the current rev-keyed cache does not have. It should be considered
only after §5 is settled and only if measurement says the build cost still
matters.

## 8. Speculative: multi-writer

Chunk-level ownership could in principle replace `tab-lock.ts`'s single-writer
model with per-team leases, letting two tabs edit different teams at once.

This is the least-developed idea here and carries by far the most risk: it turns a
well-understood mutual-exclusion problem into a distributed-consistency one, in a
codebase whose whole premise is that there is no server. It is recorded because it
is the kind of thing that becomes tempting once chunks exist, and because writing
down *why it is risky* now is cheaper than relearning it later. It should not be in
scope for a first TMV2.

## 9. Non-goals

- **No runtime dependencies.** SQLite, IndexedDB-as-primary-store, and every
  similar suggestion are out. They break the hard constraint in `CLAUDE.md`, and
  worse, they demote the `.tmv` file the user owns and carries to a mere export
  format. The file is the product.
- **No server, no sync service.**
- **No mobile layout work** riding along on this.

## 10. If this gets built, roughly in this order

1. Benchmark partial writes in real Chromium (§5). Everything downstream depends
   on the result, and a negative result changes the scope substantially.
2. TMV2 container read/write, full-file only — same performance as TMV1, but
   structured. Round-trip and manifest-integrity tests, including deliberate
   tampering: dropped chunk, reordered chunks, spliced older chunk.
3. Lazy open: decrypt the manifest plus the active team, defer the rest.
4. Incremental save, only if step 1 justified it.
5. Whatever subset of §3.2 the structure now makes reachable.

Each step should be independently shippable and independently revertible. A format
migration that has to land all at once is a format migration that will sit
unfinished on a branch.
