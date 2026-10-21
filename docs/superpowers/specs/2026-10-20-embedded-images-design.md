# Embedded images in free-text fields

Design, 2026-10-20. Lets the user paste, drop or pick images into any
free-text field (daily notes, person notes, general notes, action-item notes,
follow-ups, …). Images live inside the `.tmv` file, are encrypted with the same
key as everything else, and never make saves meaningfully worse for people who
do not use them.

## Why

The trigger was concrete: the user wanted to paste a screenshot of a
conversation into a note and could not. A note will often carry several such
screenshots, and a file can reasonably accumulate 30–50 or more. The design has
to stay comfortable at that scale without giving up the app's core premise:
**one file, the user's own, is the single source of truth.**

## Goals

- Images render inside the WYSIWYG editor and in read views, centered, never
  upscaled, shrunk to fit narrow panes with aspect ratio kept.
- Three ways in: paste (clipboard image, or mixed text+image content), drag and
  drop of image files from the file system, and a toolbar button with a file
  picker. All three accept several images at once.
- Images are stored in the `.tmv`, encrypted with the file's key when the file
  has a password.
- A hard size policy (re-encode on import, per-image cap, total cap) keeps the
  file size, and therefore save time, bounded and predictable.
- **One file format.** Every file the new version saves uses the new
  container, with or without images. Files from earlier versions are migrated
  on open through the existing migration path (including the pre-migration
  backup snapshot).

## Non-goals

- File types other than images. Only formats the browser itself decodes and
  renders natively.
- SVG in this version (see "Calls I made"). Remote (`http(s)`) images in pasted
  HTML are not fetched.
- Image editing: crop, rotate, annotate, per-image width, captions, galleries.
- A sidecar image file, an OPFS/SQLite working database, an IndexedDB journal,
  or any storage that makes the `.tmv` not the source of truth. Considered and
  rejected; see "Evidence".
- Partial/in-place file writes. Measured not to help; see "Evidence".
- Mobile/responsive concerns (the app is desktop-only by design).

## Anti-goals — failure even if the feature "works"

- A file that will not open, or will not save, because of one bad image.
- Silently losing an image the user can still see referenced.
- A save that freezes the UI, or saves of image-free files getting slower.
- A file from an earlier version failing to open, or losing data, in migration.

## Evidence that shaped the storage decision

Chrome on the author's machine, 200 MB test file, three runs per variant
(throwaway page, not committed):

| Write strategy | Total per write |
|---|---|
| Full rewrite, default `createWritable()` (what the app does today) | ≈ 2.05 s |
| Append 1 MB with `keepExistingData` (siloed or `mode:'exclusive'`) | ≈ 2.0 s |
| Overwrite 4 KB at offset 0 (siloed or exclusive) | ≈ 1.95 s |
| Exclusive without `keepExistingData`, seek to end, append | ≈ 2.2 s **and the head of the file is destroyed** |

Every variant used a `.crswap` swap file and the real file never changed before
`close()`. About 1.7 s of each write is `close()` committing the swap file, and
it does not depend on how many bytes were written. **Cost per save is therefore
proportional to total file size (~8.5 ms/MB measured), not to bytes changed.**
(Linear extrapolation: 15 MB ≈ 0.13 s, 50 MB ≈ 0.4 s, 150 MB ≈ 1.3 s. Worth a
50 MB re-run to confirm before relying on it.) `close()` is async, so the UI
stays responsive; the save pill just reads "saving" a little longer. In-place
writes (`inPlace`) were removed from the File System Access proposal in 2019 and
`createSyncAccessHandle()` only works on origin-private storage; neither is
available for a user-picked file.

Consequence: partial-write cleverness is pointless. The lever is **keeping the
file small**, which is what the byte caps are for.

## Editor behavior

- An image is an **atomic block** in the contenteditable: the caret cannot enter
  it. Click selects it (visible outline); Backspace/Delete removes it.
- It renders **centered**. Natural pixel size when narrower than the available
  width; otherwise `max-width: 100%; height: auto`. Sizing is in `px` and the
  image never scales with the app font size (`prefs.fontSize`, Ctrl+wheel) —
  do not size it in `em`/`rem`. (Browser page zoom scales everything,
  images included; that is not countered.)
- **One blank line above and below** every image, between text blocks. The
  editor guarantees an empty paragraph on each side at insertion time and the
  markdown serializer normalizes to blank lines on both sides, so the property
  survives a round trip.
- Insertion paths, all feeding one import pipeline:
  - **Paste.** A clipboard image becomes an image block at the caret. Mixed
    content (text + images, e.g. copied from a web page or document) keeps the
    document order: text stays text, embedded images (`data:`/`blob:`) become
    image blocks at their positions. Remote `http(s)` `<img>` in pasted HTML is
    not fetched (no network access, no CORS, privacy) and is dropped.
  - **Drag and drop** of one or more image files from the file system onto the
    editor; non-image files are ignored with a short notice.
  - **Toolbar button** opening `<input type=file accept=image/* multiple>`.
- **Copy/cut** needs no special path: the editor renders images with `data:`
  URIs, so the existing copy handler already puts them in the clipboard HTML,
  and any paste (same document, another document, another app) goes through the
  normal import pipeline, where hashing dedupes. A stored WebP that is already
  within the limits is kept byte-for-byte on import so a copy/paste round trip
  yields the same id.
- Alt text defaults to the source file name without extension (empty for
  clipboard images). It is indexed by search; the image itself is not.
- Image blocks are available wherever the rich editor is used. Fields that are
  plain single-line inputs are unaffected.

## Copy menu (toolbar "copy" button)

The three whole-note copy options behave as follows when a note has images:

- **Plain text:** each image becomes one line `[image: alt]` (or a localized
  `[image]` when it has no alt), with at most one blank line around it. Plain
  text cannot carry a picture; the marker tells the reader one was there.
- **Formatted:** images are copied as real pictures. The HTML is built from a
  clean clone: each image is a centered `<p><img src="data:…" alt width height>`
  with none of the editor's `data-*` or `contenteditable` attributes. Copy waits
  for any image still loading so none is missing, and drops one that cannot be
  read. The existing fallback path gets the same cleaned clone.
- **Markdown:** unchanged, it is the stored source and so contains
  `![alt](img:<id>)` references that mean nothing outside this file. When the
  note has images, a toast says "Images are copied as references. Use Formatted
  to copy the pictures." Embedding base64 in the markdown was rejected (several
  MB of text on the clipboard for a handful of screenshots).
- Ctrl+C / Ctrl+X on a selection need no change: the handler already copies the
  selected HTML including the data-URI images.

## Import pipeline: re-encoding and size policy

The browser does the work; no dependency is added.

1. Accept natively decodable raster formats: PNG, JPEG, WebP, GIF, AVIF, BMP.
   Decode with `createImageBitmap`. The test is **"the browser decoded it"**,
   not the extension or the reported MIME type (clipboard images often have no
   file name): sniff the magic bytes to pick the branch below, and treat a
   decode failure as "not a supported image". AVIF/WebP support therefore
   follows the user's browser version. Not accepted: SVG (see "Calls I made"),
   HEIC/HEIF, TIFF, JPEG XL, ICO (not decodable by Chrome/Edge on desktop, or
   not worth the surface), and any non-image file.
   - **Animated images** are detected by sniffing, because `createImageBitmap`
     silently returns only the first frame: GIF with more than one frame, APNG
     (`acTL` chunk) and animated WebP (`ANIM` chunk). They skip the re-encode
     (it would flatten them) and are stored as their original bytes if they fit
     the 1 MB cap, otherwise refused with the "too large" message.
   - The stored type is whatever the pipeline produced: normally `image/webp`
     (or the PNG/JPEG fallback), `image/gif`/`image/png`/`image/webp` for
     kept-as-is animated or already-small originals.
2. If the long edge exceeds **1600 px**, downscale to 1600 (aspect kept). Never
   upscale.
3. Re-encode through a canvas with `toBlob`, targeting **WebP at quality 0.85**
   (keeps alpha; screenshots of text compress well). If the browser returns a
   different type (no WebP encoder), fall back to PNG for images with
   transparency and JPEG otherwise.
4. If the re-encoded result is larger than the original bytes and the original
   already fits the cap, keep the original bytes.
5. **Per-image hard cap: 1 MB** after processing. Step quality down
   (0.85 → 0.7 → 0.55), then scale down in 0.75 steps, with a floor of
   800 px on the long edge. If it still does not fit, refuse that image with an
   explanatory message and do not insert it.
6. **Animated images** (GIF, APNG, animated WebP) follow the pass-through rule
   in step 1.
7. Id = lowercase hex of the **SHA-256 of the processed bytes** (shortened if
   the builder prefers; collision-resistance matters more than length). The
   same image pasted twice is stored once.
8. **Total cap 150 MB** of stored image bytes; a warning once past **100 MB**
   (in the Data tab and as a toast on import). At the cap, new images are
   refused with a message. All three numbers are starting points, expected to
   be tuned; keep them as named constants in one place.

Prefs → Data tab gains a read-only line: image count and total image size
against the cap (the file's own size is not shown; it is not tracked outside
the save controller).

### Limits and how they are reported

| Limit | Value | When hit |
|---|---|---|
| Per image, after re-encode | 1 MB (long edge ≤ 1600 px, floor 800 px) | That image is not added |
| Total image bytes | 150 MB cap, warning at 100 MB | New images are refused once the cap would be exceeded |
| Image count | none of its own | Bounded by the total: roughly 150 images at the 1 MB worst case, many hundreds at typical 100–400 KB screenshots |

All feedback uses the existing `toast()` in `ui/modal.ts` (it supports `key`
replacement, an action button, `sticky`, and caps the stack at 3), plus the Data
tab. Nothing is silent, and nothing blocks the editor with a modal.

- **One aggregated message per import batch.** A drop or paste of several
  images is processed in order and reported once under a shared toast `key`:
  "3 images added, 1 not added: too large to fit 1 MB even after shrinking."
  The text and any images that fit are always inserted; a refusal never cancels
  the rest of the paste.
- **Refusal reasons, each with its own i18n string** (both locales): over the
  per-image cap after the full ladder; file type not decodable by the browser
  (or a non-image dropped); decode failure (corrupt or truncated file); total
  cap reached.
- **Total cap reached:** a non-sticky toast of about 8 s, "Image limit reached
  (150 MB). Delete notes or images you no longer need, then try again", with a
  "Show usage" action that opens Prefs → Data. The cap is checked against the
  pool *after* a reference sweep, so unreferenced leftovers (e.g. a note deleted
  a minute ago) are released before refusing; bytes still held for an undo
  window count until it closes. Processing a multi-image batch stops accepting at
  the first image that would exceed the cap and refuses the rest.
- **Warning at 100 MB:** one toast per session, the first time an import crosses
  the line, with the same "Show usage" action. The Data tab line turns to the
  app's warning color from 100 MB and to the error color at the cap, and shows
  the file's total size so the save-time cost is visible.
- **Per-image cap vs total cap** read differently to the user: the first says
  "this image is too big", the second "the file is full".
- **Opening a file already over the cap** (cap lowered in a later version, or a
  hand-edited file) never fails; the user just cannot add images until they
  remove some.

## Storage model

### Document

- `Doc` gains `images`: a map `id → { mime, w, h, bytes }` — **metadata only**.
  The bytes are never part of the JSON-serialized `Doc`; they live in a
  separate in-memory blob store owned by the image module.
- Schema bump (16 → 17) with a migration that adds `images: {}`. `validateDoc`
  checks the metadata shape. Dangling references (markdown pointing at an id
  that is not in the pool) never invalidate a document; they render a broken-
  image placeholder.
- Markdown reference: standard image syntax with a private scheme,
  `![alt](img:<id>)`, on its own line between blank lines. `mdToHtml` renders
  it as an `<img>` carrying `data-img-id`; the `src` is attached afterwards
  (object URL from a lazy decrypt), so rendering stays synchronous. `htmlToMd`
  serializes back. `img:` must not be treated as a clickable link by
  `safeHref`, and `stripMd` (search, highlight) must not leak ids into text.

### File format

- A new **`.tmv` format version (2)** is the **only format the app writes**,
  for every document, including one with zero images (an empty blob area).
  The reader still accepts version 1 and the legacy plain header, and the
  existing `migrate()` ladder lifts them: schema 17 and format 2 land together,
  so the "a migration just ran on open" detection that fires the
  pre-migration backup snapshot (`main.ts`'s `onDocumentOpened`, via the
  pre-migration version `crypto.ts` already returns) covers the format change
  too. There is no dual-format writer, so `doc-bytes.ts` stays one code path
  per password/no-password case. Consequence, same as every earlier schema
  bump: once a file is saved by the new app, older app versions refuse it
  (the schema bump alone already causes that, so a dual format would not have
  preserved compatibility anyway).
- Version-2 layout requirements (exact byte layout is the builder's):
  - The doc section is readable **without touching any blob** (open decrypts
    only the doc section; images decrypt lazily when displayed).
  - Each blob is **independently AES-GCM encrypted with the same derived key**,
    fresh random IV per blob, with the blob id bound as additional
    authenticated data so blobs cannot be swapped undetected.
  - The image index (id → offset/length/mime/w/h) lives inside the encrypted
    doc section, so image structure is not readable from outside the file.
  - Password-less files: the readable `TMV-PLAIN` JSON stays, followed by raw
    binary blobs (not base64). The file is no longer pure text; the JSON part
    remains human-readable.
- An older app opening a version-2 file must fail with a clear "newer file
  format" style message rather than a generic corruption error. Today
  `isEncrypted` checks `bytes[4] === FORMAT_VERSION`, so verify what an older
  build actually reports and adjust the version-2 header so that path is clean.
- **A damaged blob or a missing blob never blocks open or save.** It renders a
  placeholder; the rest of the document is unaffected.

### Memory and crypto

- A newly imported image is held as plaintext until the first save that
  encrypts it, then its **ciphertext is cached and reused unchanged on every
  later save** (no re-encryption, no re-hashing of unchanged images). Decrypt
  happens on first display, with a small LRU of decoded object URLs.
- The per-editor data-URI cache is released in the renderer teardown
  (`lifecycle.ts`'s `withDisposal`); extend `test/lifecycle.test.ts`-style leak
  counting to it.
- **Change password** (`change-password.ts`, inside `runExclusive`): decrypt all
  blobs with the old key, re-encrypt with the new one. Password ↔ no password
  switches container encoding. Expected cost is small (AES-GCM over ≤150 MB).
- Save and backup both go through `doc-bytes.ts` and so pick up the container
  automatically; the backup mirror writes the larger file but keeps its
  existing daily/hourly throttle.
- The external-change check in `fs.ts` is left as is (whole-file bytes, only
  compared when the modified time differs). A digest optimization was
  considered and dropped as unnecessary at the capped file sizes.
- Images are shown with `data:` URIs rather than object URLs, trading roughly
  1.33× memory for the displayed images (bounded by the 150 MB cap) for a
  design with no URL revocation lifecycle and native copy/paste.

## Removing images: reference scan and sweep

Blobs are **immutable and content-addressed**, so "update" never happens: an
edit is a new id. Only addition and removal exist.

Removal is a **mark-and-sweep at save time**:

- On every write that goes through `doc-bytes.ts`, build the set of image ids
  referenced by any markdown field in the document, and write only pool entries
  in that set. Unreferenced blobs are simply not written, so the next save
  shrinks the file.
- The scan is a regex over strings already in memory (milliseconds) and is the
  single source of truth, so it is correct for every way an image can become
  unreferenced: deleting a note, person, action, milestone or risk; removing the
  image in the editor; cleanup in Prefs → Data purging old daily notes; a
  template edit.
- **Why not "mark ids as dropped when a note is deleted" (the original idea).**
  Deletion sites already scan for references (`unlinkRefsInTeam`), which is why
  it looked natural, and the sweep reuses the same idea. But deletion-time
  marking is fragile: dedupe means one blob can be referenced from several
  notes, so a deleted note's image may still be needed elsewhere; editor edits
  and cleanup remove references without any delete site; and undo has to bring
  images back. Counting references at save time handles all of that with no
  per-site code.
- **Undo (`undo-delete.ts`).** The sweep only decides what is *written*; image
  bytes and `doc.images` metadata stay in memory for the whole session. A
  delete followed by a save omits the image from the file, and an undo plus the
  next save writes it again. No coupling to the undo module is needed; the
  unreferenced bytes disappear for good when the file is closed.
- Removing an image in the editor leaves the blob in the pool until the next
  sweep, so native `Ctrl+Z` in the editor still works.
- Export and card-transfer need no image handling: `team-export.ts` exports
  only org structure (no notes), and `card-transfer.ts` moves cards inside one
  `Doc`, where the image pool is shared.

## Review of write moments

Today the document is written (all through `saveNow()`, which already skips when
`!dirty`) on: Ctrl+S / the save pill (explicit); the auto-save interval
(`autoSaveMin`, default 10 minutes); `visibilitychange` → hidden (immediately,
on any tab switch); window blur after 15 s away (`blur-save.ts`, covers
minimize and OS app switches that leave the page "visible"); `beforeunload`
(only when dirty); closing or switching file, a tab-lock handover, and the
conflict and password-change flows (explicit, each a correctness requirement);
plus the backup mirror, which reuses each successful save. Given that cost is
proportional to file size and independent of what changed, the review is:

- **Merge the two "user left" triggers into one delayed trigger.** The
  immediate `visibilitychange` save fires on every tab flip, including a
  5-second glance at another tab, and each one is a full file write. Fold it
  into the blur-save mechanism: when the tab becomes hidden *or* the window
  blurs, arm the same 15 s timer, cancel it if the user returns, and save only
  if still away and dirty. The exposure change is at most 15 s of edits in a
  window where `beforeunload` and the 10-minute interval already bound the
  loss, and rapid tab switching stops producing writes. (Background tabs can
  throttle timers, but a 15 s timer still fires well inside a minute.)
- **Keep the rest.** The interval is the crash-safety net for someone who never
  leaves the window; `beforeunload` and close/switch are the last chance before
  data is lost; the explicit and handover paths are correctness requirements.
  None of them fires without `dirty`.
- **No new save triggers.** Pasting an image marks the document dirty exactly
  like typing; it does not force a save.
- **Keep the `!dirty` short-circuit** and confirm no path writes a clean
  document (including the backup mirror and tab-lock handoff).
- **Self-calibrating minimum gap between background saves.** A background save
  (the auto-save interval or the merged away-save) is deferred, not dropped,
  until at least `20 × duration of the last successful save` has passed since
  that save finished, so saving never consumes more than ~5% of wall-clock
  time on a slow disk or heavy antivirus. It is enforced once, in
  `saveNow()` (the choke point every trigger funnels through), so the interval
  and the away-save both respect it. A deferred save arms a single trailing
  timer for the end of the gap; if edits are still dirty then, it runs.
  - **Exempt** (never deferred): Ctrl+S / save pill, `beforeunload`, close or
    switch file, tab-lock handover, conflict and password-change flows. Today
    `beforeunload` calls `saveNow()` without the `explicit` flag, so the
    builder needs a distinct "urgent" notion rather than reusing `explicit`
    blindly (check what `explicit` also changes in `save-controller.ts`).
  - "Duration" is wall time from `createWritable()` to the end of `close()`
    plus the encrypt step. Use the last successful save, or a small smoothing
    (e.g. the max of the last three) so one fluke does not set the gap. Failed
    saves do not update it.
  - Effect at typical sizes: a 0.13 s save gives a 2.6 s gap, below the 15 s
    away delay, so nothing changes; a 1.3 s save (≈150 MB) gives a 26 s gap,
    which is what stops rapid away/return cycles from re-saving a heavy file.
    The 10-minute interval is unaffected by default and is protected only if
    the user sets a very short interval.
- **Show the cost:** the Data tab line (file size / image size / cap) is how
  the user sees why saves take longer as images accumulate.
- The blur-save delay stays as is; it already only fires when dirty.

## Testing

Every new `src` module gets its `test/*.test.ts` (jsdom, feature-detected APIs).
Behaviors that need proof:

- Round trip of v2 files, encrypted and plain, including wrong password,
  tampered blob, missing blob, and a document with a dangling `img:` reference.
- Opening a v1 encrypted file and a legacy plain file: migrates, fires the
  pre-migration backup snapshot of the original bytes, and the next save writes
  v2 (including a document with zero images).
- Migration 16 → 17; `validateDoc` on the new field.
- Dedupe; the cap and re-encode ladder (use injectable encoder/decoder, since
  jsdom has neither `createImageBitmap` nor canvas encoding); animated GIF
  passthrough.
- Sweep: unreferenced blobs omitted, shared blobs kept, undo window keeps
  bytes, cleanup and entity delete free them.
- Change password re-encrypts every blob; null ↔ password transition.
- Search/highlight/backlinks ignore ids; `htmlToMd` ↔ `mdToHtml` round trip
  keeps the blank line above and below.
- Object-URL leak counting in `lifecycle` teardown.
- Playwright e2e (`e2e/`): paste, file drop and the toolbar button each insert
  an image; save, reload and reopen shows it; delete a note and confirm the file
  shrinks. Check `e2e/CLAUDE.md` for drag-and-drop and clipboard helpers, and
  note the pinned Chromium constraint in memory (IDB file-handle read).

## Project conventions to follow

- All user-visible strings through `t()` in both `pt-BR` and `en-US`
  (toolbar button, refusal messages, cap warning, Data tab line, help text).
- Zero runtime dependencies: everything above uses the platform
  (`createImageBitmap`, canvas, `crypto.subtle`, `Blob`).
- A `package.json` version bump needs a matching brief `CHANGELOG.md` entry
  (load the `changelog` skill; headline-level, one to four bullets).
- Update `src/core/CLAUDE.md` for the image module, container format and
  sweep, and the help/doc pages that describe the file format.
- Work directly on `dev`; no worktree or feature branch.

## Calls I made (flagged for review)

- **SVG excluded** for now: avoids a sanitization/XSS surface (the repo already
  carries CodeQL `js/xss` caveats) and screenshots are the stated use. Easy to
  add later as `<img>`-only.
- **Remote images in pasted HTML are dropped**, not fetched.
- **Plain files get a binary blob tail**, not base64. Not yet confirmed with the
  user; the alternative is base64 (pure text, +33%, painful in a text editor).
- **Single format, always migrate** (decided with the user): v2 is the only
  format written; v1 is read-only legacy. The earlier idea of keeping
  image-free files on v1 was dropped as a second writer path with no real
  compatibility benefit.
- **Mark-and-sweep at save time** instead of marking ids on delete (reasoning
  above).
- **Constants** — 1600 px, WebP 0.85, 1 MB per image, 100 MB warn / 150 MB cap,
  `20 ×` save-duration floor — are tunable starting points.
- **No new save moments**, no immediate save on paste, and the immediate
  tab-hidden save merged into the 15 s away-save (see "Review of write
  moments").

## Left to the builder

- Exact v2 byte layout and header; digest used for the external-change check.
- The blob store's in-memory representation (typed arrays vs `Blob`s) and the
  LRU size.
- How a corrupt/missing blob is represented in the pool and when a save drops
  it.
- Image-block caret/selection details (keyboard navigation across it, drag to
  move it within the note).
- Whether ids are the full SHA-256 or a shortened form.
- Clipboard details across browsers for mixed content.
