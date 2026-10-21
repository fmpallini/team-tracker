# Embedded Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users paste, drop or pick images into any rich-text note; images live encrypted inside the same `.tmv` file under a size policy.

**Architecture:** `Doc.images` holds metadata only; bytes live in a per-document `ImageStore` (`store.images`) that is never JSON-serialized. A new `.tmv` format v2 is the only format written: the encrypted (or plain) doc envelope comes first, followed by a blob area of individually AES-GCM-sealed images; the reader still accepts v1. Notes reference images as `![alt](img:<id>)` on their own line; unreferenced images are simply not written (mark-and-sweep at serialization time). Import re-encodes through the browser (canvas) under hard caps.

**Tech Stack:** TypeScript, esbuild, vitest + jsdom, Playwright (e2e). Zero runtime dependencies; only platform APIs (`createImageBitmap`, canvas `toBlob`, `crypto.subtle`, `FileReader`).

**Spec:** `docs/superpowers/specs/2026-10-20-embedded-images-design.md`

## Global Constraints

- Zero runtime dependencies; no new package. Work directly on `dev` (no worktree, no feature branch).
- Every user-visible string goes through `t(locale, key)` with keys in **both** `pt-BR` and `en-US` (`src/core/i18n.ts`; `test/i18n.test.ts` enforces parity).
- Every new `src` module gets a matching `test/*.test.ts` (jsdom; Web Locks, FS Access, `createImageBitmap`, canvas encoding are absent in jsdom, so inject them).
- Limits (named constants in `src/core/image-import.ts`, one place): per image **1 MB** after processing; long edge **1600 px**, floor **800 px**; WebP quality ladder **0.85 → 0.7 → 0.55** then scale ×0.75; total cap **150 MB**, warning at **100 MB**; image id = first **32 hex chars** of SHA-256 of the stored bytes.
- Accepted: PNG, JPEG, WebP, GIF, AVIF, BMP (decoded by the browser, judged by decode success and magic bytes, never by extension/MIME). Not accepted: SVG, HEIC/HEIF, TIFF, JPEG XL, ICO, non-images. Animated GIF / APNG / animated WebP are stored as original bytes if ≤ 1 MB, else refused.
- Images render centered, natural pixel size, `max-width: 100%`, never scaled by app font size (px units, never `em`/`rem`), one blank line above and below.
- Format: `.tmv` v2 is the only format written; v1 and legacy `TMV-PLAIN\n` are read-only legacy, lifted by `migrate()` (schema **16 → 17**). A damaged or missing blob never blocks open or save.
- Background saves keep a minimum gap of `20 ×` the last successful save duration (max of the last three); exempt: Ctrl+S/save pill, `beforeunload`, close/switch file, tab-lock handover, conflict and password-change flows.
- Changelog: bump `package.json` to **3.2.0** with a matching brief `## [3.2.0]` entry (load the `changelog` skill first; 1–4 headline bullets).
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Run `npm run typecheck && npm run lint && npm test` before each commit.

## Review Focus

Failure modes the spec implies that no single task would otherwise pin (each has a test in the named task):

1. **A paste mixing text and several images** where one image is refused: text and the surviving images still land in order; no stray token text remains (Task 11).
2. **Undo after delete after save**: delete a note with an image, save (image not written), undo, save again — the image is written again (Task 5).
3. **Change password with images**, including password → none and none → password, and a failed write rolling back (Task 6).
4. **Pasting an image already in the document** (copy/paste inside the app, or the same screenshot twice) produces one stored blob (Task 7).
5. **Opening a file whose image area is truncated or tampered**: the document opens, that image shows the placeholder, other images still load, the next save does not crash (Task 4).

## File Structure

| File | Responsibility |
|---|---|
| `src/core/types.ts` (modify) | `ImageMeta`, `Doc.images` |
| `src/core/document.ts` (modify) | schema 17, migration, `validateDoc` for `images`, empty doc |
| `src/core/image-ref.ts` (create) | ref syntax, markdown-field enumeration, referenced-id scan |
| `src/core/image-store.ts` (create) | in-memory blobs (plain + sealed cache), lazy open, `rekey` |
| `src/core/blob-area.ts` (create) | pack/unpack the v2 blob area + index |
| `src/core/crypto.ts` (modify) | v2 encrypt/decrypt + plain v2, `blobCodec`, `OpenedDoc.images` |
| `src/core/doc-bytes.ts` (modify) | `docToBytes(doc, password, images)` filters to referenced images |
| `src/core/store.ts` (modify) | `Store.images`, `replaceDoc(doc, images?)` |
| `src/core/image-import.ts` (create) | sniff, caps, ladder, dedupe — pure, codec injected |
| `src/ui/image-codec.ts` (create) | browser `ImageCodec` (`createImageBitmap` + canvas) |
| `src/ui/image-host.ts` (create) | per-editor-bundle data-URI cache, `importFiles`, toasts |
| `src/core/markdown.ts` (modify) | `mdToHtml` / `htmlToMd` image block, `stripMd` in `search.ts` |
| `src/ui/editor.ts`, `src/ui/rich-editor.ts` (modify) | image blocks, selection/delete, paste/drop/button |
| `src/core/blur-save.ts`, `src/core/save-controller.ts`, `src/main.ts` (modify) | merged away-save, min-gap gate, `urgent` |
| `src/ui/prefs.ts`, `src/core/i18n.ts`, `src/styles.css` (modify) | Data-tab usage line, strings, styling |

---

### Task 1: Types, schema 17, reference scan

**Files:**
- Modify: `src/core/types.ts`, `src/core/document.ts`
- Create: `src/core/image-ref.ts`
- Test: `test/document.test.ts` (extend), `test/image-ref.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface ImageMeta { mime: string; w: number; h: number; bytes: number }` and `Doc.images: Record<string, ImageMeta>` in `types.ts`.
  - `const IMAGE_ID_RE = /^[0-9a-f]{32}$/`, `imageRefLine(id: string, alt: string): string` (strips `[]()\\` and newlines from alt, returns `![alt](img:id)`), `parseImageLine(line: string): { id: string; alt: string } | null`.
  - `markdownFields(doc: Doc): Iterable<string>` yielding every free-text field: each team's `dailyNotes` values, `generalNotes`, person `notes` (stakeholders and members), action `notes` and `summary`, milestone/risk `followup`, template `body`.
  - `collectImageRefs(doc: Doc): Set<string>` (ids found on image lines in those fields) and `referencedBytes(doc: Doc): number` (sum of `doc.images[id].bytes` over referenced ids).

- [ ] **Step 1: Write failing tests.** `document.test.ts`: `migrate()` of a schema-16 doc yields `schemaVersion === 17` and `images` equal to `{}`; `validateDoc` returns a non-null path string for `images: []`, for an entry with non-numeric `w`, and for an id that fails `IMAGE_ID_RE`; `createEmptyDocument` has `images: {}`. `image-ref.test.ts`: `parseImageLine('![shot](img:' + 'a'.repeat(32) + ')')` returns `{ id, alt: 'shot' }`; `imageRefLine('x', 'a[b](c)\n')` has alt `abc`; `parseImageLine` returns null for text with a prefix, for an uppercase id, and for `![x](https://…)`; `collectImageRefs` finds ids in a daily note, a follow-up, an action note and a template body, ignores an id mentioned inline mid-sentence, and counts duplicates once; `referencedBytes` sums only referenced pool entries.
- [ ] **Step 2: Run** `npx vitest run test/document.test.ts test/image-ref.test.ts` — expect FAIL (missing exports/field).
- [ ] **Step 3: Implement** the types, `SCHEMA_VERSION = 17`, `MIGRATIONS[16] = (d) => { d.images = {} }`, `validateDoc` checks for `images` (object, each key matches `IMAGE_ID_RE`, each value has string `mime` and finite non-negative integers `w`,`h`,`bytes`), `createEmptyDocument`, and `image-ref.ts`. Dangling refs (a ref to an id not in `images`) must not fail validation.
- [ ] **Step 4: Run** the same command — expect PASS; then `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(images): schema 17 and image reference scan`.

### Task 2: ImageStore and blob area

**Files:**
- Create: `src/core/image-store.ts`, `src/core/blob-area.ts`
- Test: `test/image-store.test.ts`, `test/blob-area.test.ts`

**Interfaces:**
- Consumes: `blobCodec` (Task 3, injected in tests as a fake `BlobCodec`).
- Produces:
  - `interface BlobCodec { seal(id: string, plain: Uint8Array): Promise<Uint8Array>; open(id: string, sealed: Uint8Array): Promise<Uint8Array> }`
  - `interface ImageStore { has(id: string): boolean; getPlain(id: string): Promise<Uint8Array | null>; putPlain(id: string, plain: Uint8Array): void; adoptStored(id: string, stored: Uint8Array): void; getStored(id: string): Promise<Uint8Array | null>; rekey(codec: BlobCodec | null): Promise<void> }`
  - `createImageStore(codec: BlobCodec | null): ImageStore` — `codec === null` means password-less: stored bytes are the raw bytes.
  - `packBlobs(blobs: { id: string; stored: Uint8Array }[]): { area: Uint8Array; index: Record<string, [number, number]> }` and `sliceBlob(area: Uint8Array, index: Record<string, [number, number]>, id: string): Uint8Array | null` (null when the range is outside `area`).

- [ ] **Step 1: Write failing tests.** `getPlain` after `putPlain` returns the same bytes without calling the codec; after `adoptStored` it opens once via `codec.open` and caches (second call does not call `open`); a codec whose `open` throws makes `getPlain` return `null` (and `has` stays true); `getStored` seals once and reuses the sealed bytes on the second call (count `seal` calls); with a null codec `getStored` equals the plain bytes and `seal` is never called; `rekey(newCodec)` first loads every adopted entry's plain bytes using the **old** codec, then drops sealed caches so the next `getStored` calls the **new** codec's `seal` (assert order with a recorded call log), and an entry that could not be opened is omitted from later `getStored` (returns null); `packBlobs`/`sliceBlob` round-trip three blobs of different lengths, and `sliceBlob` returns null for an out-of-range index entry and for an unknown id.
- [ ] **Step 2: Run** `npx vitest run test/image-store.test.ts test/blob-area.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** both modules. Entries hold `{ plain: Uint8Array | null; stored: Uint8Array | null; storedValid: boolean }`; `adoptStored` marks `storedValid` true; `putPlain` leaves `stored` null; never evict bytes during the session (this is what makes undo-after-save work, see Task 5).
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(images): in-memory image store and blob area packing`.

### Task 3: Crypto primitives and v2 container

**Files:**
- Modify: `src/core/crypto.ts`
- Test: `test/crypto.test.ts` (extend)

**Interfaces:**
- Consumes: `ImageStore`, `packBlobs`, `sliceBlob`, `collectImageRefs` is **not** used here (filtering happens in Task 4).
- Produces:
  - `blobCodec(password: string): Promise<BlobCodec>` — uses the cached session key; `seal` = fresh 12-byte IV ‖ AES-GCM ciphertext with `additionalData = UTF-8 of id`; `open` is the inverse and throws `CorruptFileError` on failure.
  - `encryptDocument(doc: Doc, password: string, images: ImageStore, ids: string[]): Promise<Uint8Array>` and `serializePlain(doc: Doc, images: ImageStore, ids: string[]): Promise<Uint8Array>` (now async because `getStored` is). `ids` is the already-filtered list of image ids to write; ids whose `getStored` returns null are skipped and removed from the written `doc.images`.
  - `OpenedDoc` gains `images: ImageStore`; `decryptDocumentWithVersion` and `parsePlainWithVersion` fill it. `looksLikeTmv` accepts format versions 1 and 2.
- Layouts: **encrypted v2** = existing header through `ivData` (offset 77) with `bytes[4] = 2`, then `u32be docCipherLen`, then the AES-GCM ciphertext of the UTF-8 JSON envelope `{"doc": Doc, "index": Record<id,[off,len]>}`, then the blob area. **Plain v2** = `TMV-PLAIN2\n` + the same envelope JSON (single line) + `\n` + the raw blob area (JSON never contains a literal newline). v1 payload (JSON of the doc itself) and `TMV-PLAIN\n` remain readable.

- [ ] **Step 1: Write failing tests.** Round trip encrypted v2 with two images: bytes after reopen via `getPlain` equal originals; header byte 4 is 2; wrong password throws `WrongPasswordError`; a v1 fixture (build one with a local helper replicating the v1 layout, or keep a checked-in `test/fixtures/v1.tmv`) opens and reports `preSchemaVersion` 16; plain v2 round trip including a blob whose bytes contain `0x0A`; a document with zero images still writes v2 and round-trips; flipping one byte inside one blob's region leaves the document opening, makes that image's `getPlain` return null, and does not affect the other image; truncating the file inside the blob area opens the document with all affected images unreadable (null), not a throw; two `seal` calls of the same plaintext give different outputs; opening a blob with the wrong id as AAD fails (swap two blobs' index entries in a crafted file and assert both read as null).
- [ ] **Step 2: Run** `npx vitest run test/crypto.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** in `crypto.ts`; `adoptStored` each index entry via `sliceBlob`. The per-file open must `createImageStore(await blobCodec(password))` (or `null` for plain).
- [ ] **Step 4: Run** the same command — expect PASS, then `npx vitest run test/doc-bytes.test.ts test/start*.test.ts` to see callers that now fail; they are fixed in Tasks 4–5.
- [ ] **Step 5: Commit** `feat(images): tmv format v2 with sealed image blobs`.

### Task 4: `docToBytes` filtering and open-path plumbing

**Files:**
- Modify: `src/core/doc-bytes.ts`, `src/core/reload-document.ts`, `src/ui/start.ts`
- Test: `test/doc-bytes.test.ts`, `test/reload-document.test.ts`, `test/start.test.ts` (adjust)

**Interfaces:**
- Consumes: `collectImageRefs`, `ImageStore`, v2 `encryptDocument`/`serializePlain`.
- Produces: `docToBytes(doc: Doc, password: string | null, images: ImageStore): Promise<Uint8Array>`; `reload-document.ts` result gains `images: ImageStore`; `start.ts` passes the opened `images` through to `onDocumentOpened` and creates `createImageStore(null/codec)` for new documents.

- [ ] **Step 1: Write failing tests.** `docToBytes` writes only referenced images (doc with images `a`,`b`, only `a` referenced in a daily note: reopened pool has only `a`) but does not mutate `doc.images` in memory; a reference to an id absent from the store writes the document without it; `validateDoc` failure still throws `CorruptFileError`; `reload-document` returns images for encrypted and plain files; password prompt flow unchanged.
- [ ] **Step 2: Run** the three test files — expect FAIL.
- [ ] **Step 3: Implement.** Build the id list as `collectImageRefs(doc)` ∩ `Object.keys(doc.images)`; the written doc is `{ ...doc, images: pick(doc.images, ids) }` (shallow copy; never mutate the live doc).
- [ ] **Step 4: Run** the three test files — expect PASS.
- [ ] **Step 5: Commit** `feat(images): serialize only referenced images, thread store through open`.

### Task 5: Store, save, conflict and backup call sites

**Files:**
- Modify: `src/core/store.ts`, `src/core/save-controller.ts`, `src/core/conflict-flow.ts`, `src/main.ts`
- Test: `test/store.test.ts`, `test/save-controller.test.ts`, `test/conflict-flow.test.ts`, `test/doc-bytes.test.ts`

**Interfaces:**
- Produces: `createStore(doc: Doc, images?: ImageStore): Store` (default `createImageStore(null)`), `Store.images: ImageStore`, `Store.replaceDoc(doc: Doc, images?: ImageStore): void` (when `images` is given it replaces `Store.images`).

- [ ] **Step 1: Write failing tests.** Save-controller passes `store.images` to `docToBytes` (assert via a mocked `docToBytes`); conflict-flow's fork and overwrite writes pass the right store; conflict Reload calls `replaceDoc(doc, images)`; **undo-after-save** (Review Focus 2): with a real store, put an image, reference it from a daily note, delete the note, `docToBytes` (image absent in output), restore the note, `docToBytes` again (image present).
- [ ] **Step 2: Run** the four test files — expect FAIL.
- [ ] **Step 3: Implement** and update every `docToBytes` caller (`save-controller.ts` lines ~238 and ~319, `conflict-flow.ts` ~85 and ~119, `main.ts` backup ~465, `change-password.ts` is Task 6). `undo-delete.ts` needs no change: unreferenced bytes stay in memory for the session.
- [ ] **Step 4: Run** the four test files plus `npm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(images): Store.images and save/backup/conflict wiring`.

### Task 6: Change password with images

**Files:**
- Modify: `src/core/change-password.ts`, `src/main.ts` (only if it owns the password closure)
- Test: `test/change-password.test.ts`

**Interfaces:**
- Consumes: `ImageStore.rekey(codec | null)`, `blobCodec`.

- [ ] **Step 1: Write failing tests.** password A → B: images readable after reopening with B and not A; A → none and none → A both round-trip; a write failure after rekey restores the old codec (`store.images.getStored` still yields bytes sealed for A: assert by opening the previous file bytes with A and by calling `rekey` spy with the old codec); the whole sequence runs inside `runExclusive`.
- [ ] **Step 2: Run** `npx vitest run test/change-password.test.ts` — expect FAIL.
- [ ] **Step 3: Implement:** inside the existing exclusive section, `await images.rekey(newPw === null ? null : await blobCodec(newPw))` before `docToBytes(doc, newPw, images)`; on any failure `await images.rekey(oldCodec)` where `oldCodec` was captured before the switch.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(images): re-seal images on password change`.

### Task 7: Import pipeline (pure)

**Files:**
- Create: `src/core/image-import.ts`
- Test: `test/image-import.test.ts`

**Interfaces:**
- Produces:
  - `const IMAGE_LIMITS` (the Global Constraints values).
  - `sniffImage(bytes: Uint8Array): { kind: 'png' | 'jpeg' | 'webp' | 'gif' | 'avif' | 'bmp'; animated: boolean } | null` (magic bytes; animated = GIF with >1 image descriptor, PNG with an `acTL` chunk, WebP with an `ANIM` chunk).
  - `interface ImageCodec { decode(bytes: Uint8Array): Promise<{ w: number; h: number; hasAlpha: boolean }>; encode(bytes: Uint8Array, opts: { maxEdge: number; quality: number }): Promise<{ bytes: Uint8Array; mime: string; w: number; h: number }> }`
  - `type ImportRefusal = 'too_large' | 'unsupported' | 'corrupt' | 'cap_reached'`
  - `type ImportResult = { ok: true; id: string; meta: ImageMeta; alt: string; isNew: boolean } | { ok: false; reason: ImportRefusal; name: string }`
  - `importImage(input: { bytes: Uint8Array; name: string }, ctx: { codec: ImageCodec; images: ImageStore; doc: Doc }): Promise<ImportResult>` — when `isNew`, it calls `ctx.images.putPlain` but does **not** touch `doc` (caller adds `doc.images[id] = meta` inside `store.update`).
  - `importImages(inputs, ctx): Promise<{ results: ImportResult[]; crossedWarn: boolean }>` — sequential; stops accepting at the first image that would exceed the total cap and refuses it and every later one with `cap_reached`. The cap is measured on `referencedBytes(ctx.doc)` plus images accepted earlier in this batch (not on unreferenced leftovers).
  - `imageId(bytes: Uint8Array): Promise<string>` (SHA-256, first 32 hex).

- [ ] **Step 1: Write failing tests** with a fake codec: PNG 3000×2000 → encode called with `maxEdge 1600`, result mime `image/webp`, id equals `imageId(result.bytes)`; a result over 1 MB at q 0.85 retries 0.7 then 0.55 then scales down, and a fake that never shrinks gives `too_large` (and never goes below `minLongEdge` 800); small WebP ≤ 1 MB and ≤ 1600 px is stored **unchanged** so re-pasting our own output dedupes (`isNew === false` the second time, pool size stays 1 — Review Focus 4); animated GIF ≤ 1 MB stored as original, > 1 MB refused `too_large`; APNG and animated WebP likewise; random bytes → `unsupported`; a truncated PNG (valid magic, fake `decode` rejects) → `corrupt`; alt is the file name without extension and without `[]()` characters, empty for an empty name; batch of three where the third crosses the cap: first two ok, third `cap_reached`; `crossedWarn` is true when the batch pushes referenced bytes past 100 MB; re-encode result larger than an original that already fits keeps the original bytes.
- [ ] **Step 2: Run** `npx vitest run test/image-import.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Prefer the original bytes when re-encode is larger and the original fits the cap and is not animated.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(images): import pipeline with caps and dedupe`.

### Task 8: Browser codec

**Files:**
- Create: `src/ui/image-codec.ts`
- Test: `test/image-codec.test.ts`

**Interfaces:**
- Produces: `browserImageCodec: ImageCodec` — `decode` uses `createImageBitmap` (rejects → caller maps to `corrupt`); `encode` draws to an `OffscreenCanvas` (or `document.createElement('canvas')` fallback) scaled so the long edge ≤ `maxEdge` (never upscaled), `convertToBlob`/`toBlob('image/webp', quality)`, and when the returned type is not `image/webp` falls back to PNG for images with alpha and JPEG (white-filled) otherwise.

- [ ] **Step 1: Write failing tests** with stubbed `createImageBitmap` and a stubbed canvas: scaling math (3000×2000 with `maxEdge 1600` yields 1600×1067; 800×600 is not upscaled); alpha image falls back to PNG when the stub encoder returns `image/png`; opaque image falls back to JPEG with a white fill call before drawing.
- [ ] **Step 2: Run** `npx vitest run test/image-codec.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Real-browser behavior is proven in Task 12's e2e.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(images): browser image codec`.

### Task 9: Markdown round trip and search

**Files:**
- Modify: `src/core/markdown.ts`, `src/core/search.ts`
- Test: `test/markdown.test.ts`, `test/search.test.ts`, `test/markdown-fuzz.test.ts`

**Interfaces:**
- Consumes: `parseImageLine`, `imageRefLine`.
- Produces: `mdToHtml` renders an image line as `<div class="tt-img" contenteditable="false" data-img-id="ID" data-alt="ALT"></div>` (block; no `src` yet, the editor hydrates it); `htmlToMd` serializes any top-level element carrying `data-img-id` back to `imageRefLine(id, alt)` and **guarantees a blank line above and below** (adds `''` lines when the neighbors are non-empty text blocks, and does not double them when already blank). `stripMdSyntax` in `search.ts` replaces image lines with their alt text only.

- [ ] **Step 1: Write failing tests.** `md → html → md` identity for `a\n\n![x](img:ID)\n\nb`; `htmlToMd` of `<div>a</div><div class="tt-img" data-img-id="ID" data-alt="x"></div><div>b</div>` yields exactly `a\n\n![x](img:ID)\n\nb`; an image as the first or last block has no leading or trailing blank-line artifacts; two adjacent image blocks get one blank line between them; an image reference **inside** a sentence stays literal text; `![x](img:ID)` is never rendered as a link and `safeHref('img:...')` returns null; `stripMd('see\n\n![shot](img:ID)')` contains `shot` and no `img:` or id; search over a note whose window edge falls mid-reference never shows id fragments (Review Focus: search/highlight); add the image line to the fuzz alphabet so round trips stay idempotent.
- [ ] **Step 2: Run** the three test files — expect FAIL.
- [ ] **Step 3: Implement** next to the existing `hr` branches (`mdToHtml` ~line 355, `htmlToMd` ~lines 991 and 1084).
- [ ] **Step 4: Run** the three test files — expect PASS.
- [ ] **Step 5: Commit** `feat(images): markdown image block and search stripping`.

### Task 10: ImageHost and image rendering in the editor

**Files:**
- Create: `src/ui/image-host.ts`
- Modify: `src/ui/editor.ts`, `src/ui/rich-editor.ts`, `src/styles.css`
- Test: `test/image-host.test.ts`, `test/editor.test.ts` (extend), `test/lifecycle.test.ts` (extend)

**Interfaces:**
- Produces:
  - `interface ImageHost { getDataUri(id: string): Promise<string | null>; importFiles(files: File[]): Promise<{ id: string; alt: string }[]>; dispose(): void }`
  - `createImageHost(store: Store, locale: Locale, codec?: ImageCodec): ImageHost` — `getDataUri` reads `store.images.getPlain`, builds a `data:<mime>;base64,…` string, caches it per host (map id → string); `dispose()` clears the cache. `importFiles` is implemented in Task 11.
  - `EditorHooks.images?: ImageHost`; `createRichEditorBundle` constructs the host from `opts.store`/`opts.locale` and calls `host.dispose()` in `bundle.dispose()`.

- [ ] **Step 1: Write failing tests.** Host: `getDataUri` returns the same string instance on the second call (cache), returns null for an unknown or damaged id, and `dispose()` empties the cache. Editor: `setMd` with an image line creates a `.tt-img` block whose child `<img>` gets `src` starting `data:image/` after the host resolves; the `<img>` has `width`/`height` attributes from `doc.images[id]`; a missing image (host returns null) gets class `tt-img-missing` and the translated placeholder text; clicking the block adds `.is-selected`; Backspace or Delete with a selected block removes it and `getMd()` no longer contains the id; the markdown after `setMd(getMd())` is unchanged; an editor with no `hooks.images` renders the placeholder and does not throw; `lifecycle.test.ts` mounting and unmounting a notes module twice leaves no live data-URI cache entries (spy on `dispose`).
- [ ] **Step 2: Run** `npx vitest run test/image-host.test.ts test/editor.test.ts test/lifecycle.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** hydration after `setMd`/`insertHTML` (one helper that walks `.tt-img` blocks lacking an `<img>`), CSS `.tt-img { display:flex; justify-content:center; user-select:none }`, `.tt-img img { max-width:100%; height:auto }` with pixel sizing only, `.is-selected` outline using the accent color, and the keydown handler.
- [ ] **Step 4: Run** the three test files — expect PASS.
- [ ] **Step 5: Commit** `feat(images): render image blocks in the editor`.

### Task 11: Paste, drop, toolbar button, limit reporting

**Files:**
- Modify: `src/ui/image-host.ts`, `src/ui/editor.ts`, `src/core/i18n.ts`
- Test: `test/image-host.test.ts`, `test/editor.test.ts`, `test/i18n.test.ts`

**Interfaces:**
- Consumes: `importImages`, `browserImageCodec`, `toast` (`src/ui/modal.ts`), `store.update`.
- Produces: `ImageHost.importFiles` imports through `importImages`, then in **one** `store.update` adds `doc.images[id] = meta` for each ok result, then shows one aggregated toast with `key: 'image-import'`; inserts the editor blocks; returns the inserted `{id, alt}` list. Editor: `insertImageBlocks(items)` inserts blocks at the caret as top-level blocks and guarantees an empty block directly above and below each image; toolbar button (icon + `title` from i18n) opens `<input type="file" accept="image/*" multiple>`; `dragover`/`drop` on the editor accepts `dataTransfer.files`; `onPaste` handles clipboard `files`/`items` of type `image/*`; for pasted HTML, each `<img src="data:…">` is replaced **before** `htmlToMd` by an own-line token `⟦tt-img:N⟧`, the text is inserted as today, then after `importFiles` resolves each token block is replaced by its image block (or removed when refused). Remote `http(s)` images are dropped and never fetched.
- Strings (both locales, keys under `img_*`): toolbar title, "N added" / "N added, M not added: reason", the four refusal reasons, cap-reached toast with "Show usage" action label, 100 MB warning toast, broken-image placeholder, non-image-drop notice, Data-tab line label.

- [ ] **Step 1: Write failing tests.** Paste of an `image/png` file in `clipboardData.files` inserts one block with an empty block before and after; paste of HTML `<p>a</p><img src="data:image/png;base64,…"><p>b</p>` yields text `a`, image, text `b` in order; with the codec refusing the image (fake `too_large`), `a` and `b` remain, no `⟦tt-img` text is left, and the toast reads "0 added, 1 not added: …" (Review Focus 1); a drop of two image files and one `.txt` inserts two images and the notice; `<img src="https://…">` in pasted HTML inserts nothing and issues no fetch (`fetch` spy); toolbar button click triggers the hidden input's `click`; read-only editor ignores paste/drop; an aggregated toast is shown once per batch and replaced by key; cap reached shows the cap toast with an action that calls the supplied `onShowUsage`; `i18n.test.ts` passes with all new keys in both locales.
- [ ] **Step 2: Run** `npx vitest run test/image-host.test.ts test/editor.test.ts test/i18n.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** `ImageHost` takes an optional `onShowUsage: () => void` in `createImageHost`; `rich-editor.ts` wires it to open Prefs → Data.
- [ ] **Step 4: Run** the three test files — expect PASS.
- [ ] **Step 5: Commit** `feat(images): paste, drop and picker import with limit messages`.

### Task 12: Data-tab usage line, e2e, docs, release

**Files:**
- Modify: `src/ui/prefs.ts`, `src/core/CLAUDE.md`, `CLAUDE.md` (only the architecture bullets that mention the file format), help strings in `src/core/i18n.ts`, `package.json`, `CHANGELOG.md`
- Create: `e2e/images.spec.ts`
- Test: `test/prefs.test.ts` (extend)

- [ ] **Step 1: Write failing tests.** `prefs.test.ts`: the Data tab shows `N images · X MB of 150 MB` from `collectImageRefs`/`referencedBytes`; the line carries the warning class at ≥ 100 MB and the error class at ≥ 150 MB (use a doc whose `images[...].bytes` are set directly). `e2e/images.spec.ts` (Chromium; follow `e2e/paste-sources.spec.ts` for clipboard/drag helpers and `e2e/opfs-shim.ts` for save/reopen): paste a PNG into a note → image visible, centered, width ≤ editor width; drop two files → both appear; toolbar picker via `setInputFiles`; save, reload, reopen the file (encrypted and password-less) → image still renders; delete the note, save, and assert the saved file is smaller than before; Ctrl+click font-size steps do not change the image's rendered width.
- [ ] **Step 2: Run** `npx vitest run test/prefs.test.ts` — expect FAIL; `npm run test:e2e -- images.spec.ts` — expect FAIL.
- [ ] **Step 3: Implement** the Data-tab line (file size is intentionally omitted: YAGNI, noted in the spec), update `src/core/CLAUDE.md` (image modules, v2 container, sweep-at-serialize, the undo reasoning), the help text that describes file format, bump `package.json` to 3.2.0, and write the `## [3.2.0]` entry.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm test` and `npm run test:e2e` — expect all PASS.
- [ ] **Step 5: Commit** `feat(images): usage line, e2e, docs; bump 3.2.0`.

### Task 13: Merged away-save and minimum save gap

**Files:**
- Modify: `src/core/blur-save.ts`, `src/core/save-controller.ts`, `src/main.ts`
- Test: `test/blur-save.test.ts`, `test/save-controller.test.ts`

**Interfaces:**
- Produces: `installBlurSave` also arms the same timer on `document` `visibilitychange` to `hidden` and cancels on `visible`; `SaveController.saveNow(opts?: { explicit?: boolean; urgent?: boolean }): Promise<void>`; `main.ts` drops its immediate `onVisibilityChange` save and passes `{ urgent: true }` from `onBeforeUnload`. `createSaveController` deps gain `now?: () => number` (default `Date.now`).

- [ ] **Step 1: Write failing tests.** Blur-save: hiding the tab arms the timer and saves after the delay if still away; returning before the delay cancels it; blur and hidden together arm only one timer. Save-controller (fake clock): after a save that took 1000 ms, a non-urgent non-explicit `saveNow()` 5 s later does **not** write but arms one trailing save at the end of a 20 s gap, which writes if still dirty; two such calls arm only one timer; `explicit: true` and `urgent: true` calls write immediately; the gap uses the max of the last three successful durations; a failed save does not update it; in fallback mode (no handle) `urgent` does **not** trigger a download (only `explicit` does); a clean document never writes.
- [ ] **Step 2: Run** `npx vitest run test/blur-save.test.ts test/save-controller.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the gate at the top of `saveNow()` after the read-only/conflict checks. `main.ts` must keep calling `flushAllEditors()` where `beforeunload` already does; the visibility handler's `flushAllEditors()` is covered by `deps.flushPending` inside `saveNow`.
- [ ] **Step 4: Run** both test files plus `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(save): merge tab-hidden into away-save, add minimum gap for background saves`.

### Task 14: Copy-menu behavior with images

**Files:**
- Modify: `src/ui/editor.ts` (`copyPlain`, `copyFormatted`, `copyMarkdown`), `src/core/markdown.ts` (`htmlToPlainText`), `src/core/i18n.ts`
- Test: `test/editor.test.ts`, `test/markdown.test.ts`, `test/i18n.test.ts`

**Interfaces:**
- Consumes: `ImageHost.getDataUri` (Task 10), `toast` (`src/ui/modal.ts`), `.tt-img` block shape (Task 9).
- Produces: `htmlToPlainText` renders a `.tt-img` block as one line `[image: ALT]` (or `[image]` from i18n key `img_plain_marker` when the alt is empty, formatted with `{alt}`), with at most one blank line around it. `copyFormatted` becomes async-aware: it first awaits `getDataUri` for every `.tt-img` block, then builds the HTML from a clone in which each block is `<p style="text-align:center"><img src="data:…" alt width height></p>` (no `data-*` or `contenteditable` attributes; a block whose image is missing is dropped). `copyMarkdown` copies `htmlToMd(editorEl)` unchanged and, when the note contains at least one image block, shows `toast(t(locale, 'img_copy_md_toast'), { key: 'image-copy-md' })`.
- Strings (both locales): `img_plain_marker` (`[image]` / `[imagem]`), `img_copy_md_toast` ("Images are copied as references. Use Formatted to copy the pictures." and its pt-BR equivalent).

- [ ] **Step 1: Write failing tests.** `markdown.test.ts`: `htmlToPlainText` of `<div>a</div><div><br></div><div class="tt-img" data-img-id="ID" data-alt="shot"></div><div><br></div><div>b</div>` equals `a\n\n[image: shot]\n\nb`; empty alt gives the localized `[image]` marker; two adjacent image blocks give two marker lines separated by one blank line. `editor.test.ts`: `copyFormatted` writes `text/html` containing `<img src="data:image/webp` and `text-align:center`, and containing neither `data-img-id` nor `contenteditable`; it waits for a host promise that resolves late (no image missing from the output); a block whose host returns null is omitted; the `text/plain` flavor equals the plain-text output with markers; `copyMarkdown` text contains `![shot](img:ID)` and shows the toast key `image-copy-md` exactly once, and shows no toast for a note without images; the existing `copyFormattedViaSelection` fallback still runs when `ClipboardItem` is absent and also receives the cleaned (data-URI, centered) clone.
- [ ] **Step 2: Run** `npx vitest run test/markdown.test.ts test/editor.test.ts test/i18n.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** in the named functions; do not change Ctrl+C / Ctrl+X (`writeSelectionToClipboard`), which already carries the data-URI images.
- [ ] **Step 4: Run** the same command — expect PASS, then `npm run typecheck && npm run lint`.
- [ ] **Step 5: Commit** `feat(images): copy menu handles images`.

---

## Self-Review

- **Spec coverage:** formats/animated rules → Task 7; editor behavior (centered, no zoom scaling, blank lines, atomic block) → Tasks 9–10; paste/drop/button + mixed content + remote drop → Task 11; storage/format/crypto/lazy open → Tasks 2–4; sweep + undo → Tasks 4–5; change password → Task 6; limits and reporting → Tasks 7, 11, 12; write-moments review and min gap → Task 13; Data tab → Task 12; docs/changelog → Task 12; copy menu (plain/formatted/markdown) → Task 14.
- **Deviations from the spec, to confirm with the user:** (1) images use **data URIs** as `src`, not object URLs, so copy/paste across notes and apps needs no special path and there is nothing to revoke; (2) the sweep happens only when serializing, and bytes stay in memory for the session, so the spec's "keep undo snapshot text as references" is unnecessary; (3) team export carries no notes and card transfer stays inside one `Doc`, so neither needs image handling; (4) the external-change digest and the Data tab's file-size figure are omitted (YAGNI); (5) older app versions opening a v2 file will show their generic corrupt-file message, since they cannot be changed.
- **Type consistency:** `ImageStore`, `BlobCodec`, `ImageMeta`, `ImageCodec`, `ImageHost`, `docToBytes(doc, password, images)` are defined once (Tasks 1–3, 7, 10) and used with those exact signatures afterwards.
- **Order note:** Tasks 3 and 4 change signatures that each other's callers use (`encryptDocument`/`serializePlain` vs `docToBytes`), so land them as one commit (or accept a red typecheck between them). Every other task leaves the app compiling and tests passing at its commit. Task 13 is independent and may run any time after Task 5. Task 14 needs Tasks 9–10 and runs before Task 12's e2e so the e2e can cover it.
