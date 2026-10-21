import type { Doc } from './types'
import { migrate, validateDoc } from './document'
import { createImageStore, type BlobCodec, type ImageStore } from './image-store'
import { packBlobs, sliceBlob, type BlobRange } from './blob-area'

export class WrongPasswordError extends Error {}
/**
 * `path` names the offending field when the file was readable but
 * structurally invalid (see document.ts's `validateDoc`) — e.g.
 * `teams[0].members[3].id`. Left undefined for the unreadable cases (bad
 * magic, failed GCM tag, unparseable JSON), where there is no path to name.
 */
export class CorruptFileError extends Error {
  constructor(readonly path?: string) { super(path ? `invalid document at ${path}` : 'corrupt file') }
}

const MAGIC = [0x54, 0x4d, 0x56, 0x31] // "TMV1"
// v1: header + AES-GCM(doc JSON). v2 (the only one written): header, u32be
// length of the doc envelope's ciphertext, that ciphertext (`{doc, index}`),
// then the blob area of individually sealed images. v1 is read-only legacy.
const FORMAT_V1 = 1
const FORMAT_VERSION = 2
const HEADER_LEN = 77
const ITERATIONS = 600_000
const KCV_PLAIN = new Uint8Array(16)

const PLAIN_TAG = 'TMV-PLAIN\n'
const PLAIN_TAG_BYTES = new TextEncoder().encode(PLAIN_TAG)
// v2 plain: tag, the `{doc, index}` envelope as one JSON line, '\n', raw blob area.
const PLAIN2_TAG_BYTES = new TextEncoder().encode('TMV-PLAIN2\n')

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

// Re-running the 600k-iteration PBKDF2 derivation on every single save is
// real wall-clock time (hundreds of ms+) that a save racing page teardown
// (see main.ts's beforeunload handler) may not get to finish. The derived
// key is cached per-password for the life of the running session — the same
// non-extractable CryptoKey (JS can never read its bytes out, same as
// before) is reused for every save until the password changes, at which
// point the cache key no longer matches and a fresh salt+key is derived and
// cached in its place. This doesn't weaken anything security-relevant: the
// 600k iterations exist to slow down offline brute-force against the file's
// stored salt, not to gate what an already-unlocked live session can do; and
// AES-GCM's actual requirement — the IV must never repeat under a given key
// — is unaffected, since ivKcv/ivData are still freshly randomized every call.
let sessionKey: { password: string; salt: Uint8Array; key: CryptoKey } | null = null

async function getSessionKey(password: string, salt?: Uint8Array): Promise<{ salt: Uint8Array; key: CryptoKey }> {
  if (sessionKey && sessionKey.password === password && (!salt || sameBytes(sessionKey.salt, salt))) {
    return sessionKey
  }
  const useSalt = salt ?? crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(password, useSalt)
  sessionKey = { password, salt: useSalt, key }
  return sessionKey
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Must be called when a document is closed (main.ts's `closeFile()`) — the
 * cache is keyed by password alone, with no notion of *which* document it
 * belongs to. Without this, closing file A and then creating a brand-new
 * file B under the same password would silently reuse file A's salt+key for
 * B: `encryptDocument` has no salt of its own to force a cache miss (unlike
 * `decryptDocument`, which always passes the target file's own stored salt).
 * Two unrelated files ending up with an identical salt in their headers
 * leaks that they share a password — exactly what the per-file random salt
 * exists to prevent — even though IV reuse itself stays safe either way.
 */
export function resetSessionKey(): void {
  sessionKey = null
}

/**
 * Seals/opens one image blob under the session key: a fresh 12-byte IV ahead
 * of the AES-GCM ciphertext, with the image id as additional data so a blob
 * swapped into another id's slot fails to open. The key is captured here, so
 * a codec keeps opening what it sealed even after the session key moves on.
 */
export async function blobCodec(password: string): Promise<BlobCodec> {
  const { key } = await getSessionKey(password)
  const aad = (id: string) => new TextEncoder().encode(id)
  return {
    async seal(id, plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(id) as BufferSource }, key, plain as BufferSource))
      const out = new Uint8Array(12 + ct.length)
      out.set(iv, 0); out.set(ct, 12)
      return out
    },
    async open(id, sealed) {
      if (sealed.length < 12 + 16) throw new CorruptFileError()
      try {
        return new Uint8Array(await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: sealed.subarray(0, 12) as BufferSource, additionalData: aad(id) as BufferSource }, key, sealed.subarray(12) as BufferSource))
      } catch { throw new CorruptFileError() }
    },
  }
}

interface Envelope { doc: Doc; index: Record<string, BlobRange>; area: Uint8Array }

/**
 * The doc envelope plus the blob area for `ids`. An id whose bytes the store
 * cannot produce (damaged blob) is left out of both the area and the written
 * `doc.images`, so a file never carries metadata for bytes it does not have.
 */
async function buildEnvelope(doc: Doc, images: ImageStore, ids: string[]): Promise<Envelope> {
  const blobs: { id: string; stored: Uint8Array }[] = []
  const kept: Doc['images'] = {}
  for (const id of ids) {
    const meta = doc.images[id]
    const stored = meta ? await images.getStored(id) : null
    if (!meta || !stored) continue
    blobs.push({ id, stored })
    kept[id] = meta
  }
  const { area, index } = packBlobs(blobs)
  return { doc: { ...doc, images: kept }, index, area }
}

/** `images`/`ids` default to "no images"; `docToBytes` is the one production caller and always passes both. */
export async function encryptDocument(doc: Doc, password: string, images: ImageStore = createImageStore(null), ids: string[] = []): Promise<Uint8Array> {
  const env = await buildEnvelope(doc, images, ids)
  const ivKcv = crypto.getRandomValues(new Uint8Array(12))
  const ivData = crypto.getRandomValues(new Uint8Array(12))
  const { salt, key } = await getSessionKey(password)
  const kcv = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivKcv }, key, KCV_PLAIN))
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivData }, key,
    new TextEncoder().encode(JSON.stringify({ doc: env.doc, index: env.index }))))
  const out = new Uint8Array(HEADER_LEN + 4 + data.length + env.area.length)
  out.set(MAGIC, 0); out[4] = FORMAT_VERSION
  out.set(salt, 5); out.set(ivKcv, 21); out.set(kcv, 33); out.set(ivData, 65)
  new DataView(out.buffer).setUint32(HEADER_LEN, data.length, false)
  out.set(data, HEADER_LEN + 4)
  out.set(env.area, HEADER_LEN + 4 + data.length)
  return out
}

/**
 * Whether `bytes` carry the `.tmv` container header (magic, format version,
 * and room for the fixed-size fields). Says nothing about the password or the
 * payload — it lets the open flow report an empty or foreign file as corrupt
 * BEFORE making the user type a password for it.
 */
export function looksLikeTmv(bytes: Uint8Array): boolean {
  return bytes.length >= 78 && MAGIC.every((b, i) => bytes[i] === b) && (bytes[4] === FORMAT_V1 || bytes[4] === FORMAT_VERSION)
}

interface RawFile { parsed: Record<string, unknown>; index: Record<string, BlobRange>; area: Uint8Array | null }

async function decryptRaw(bytes: Uint8Array, password: string): Promise<RawFile> {
  if (!looksLikeTmv(bytes)) throw new CorruptFileError()
  const v2 = bytes[4] === FORMAT_VERSION
  if (v2 && bytes.length < HEADER_LEN + 4) throw new CorruptFileError()
  const salt = bytes.slice(5, 21), ivKcv = bytes.slice(21, 33)
  const kcv = bytes.slice(33, 65), ivData = bytes.slice(65, 77)
  const docEnd = v2
    ? HEADER_LEN + 4 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(HEADER_LEN, false)
    : bytes.length
  if (docEnd > bytes.length) throw new CorruptFileError()
  const data = bytes.subarray(v2 ? HEADER_LEN + 4 : HEADER_LEN, docEnd)
  // getSessionKey caches before the key-check below has vouched for the
  // password. A failed attempt must not leave {wrong password, this file's
  // salt} behind: a new file created under that same string would then be
  // written with this unrelated file's salt (see resetSessionKey).
  const previousKey = sessionKey
  const { key } = await getSessionKey(password, salt)
  try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivKcv }, key, kcv) }
  catch { sessionKey = previousKey; throw new WrongPasswordError() }
  let plain: ArrayBuffer
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivData }, key, data as BufferSource) }
  catch { throw new CorruptFileError() }
  let json: unknown
  try { json = JSON.parse(new TextDecoder().decode(plain)) }
  catch { throw new CorruptFileError() }
  return v2 ? splitEnvelope(json, bytes.subarray(docEnd)) : { parsed: json as Record<string, unknown>, index: {}, area: null }
}

/** Unwraps a v2 `{doc, index}` envelope. The blob area is whatever follows it in the file. */
function splitEnvelope(json: unknown, area: Uint8Array): RawFile {
  const env = json as { doc?: unknown; index?: unknown } | null
  if (!env || typeof env.doc !== 'object' || env.doc === null) throw new CorruptFileError()
  const index = env.index && typeof env.index === 'object' && !Array.isArray(env.index) ? env.index as Record<string, BlobRange> : {}
  return { parsed: env.doc as Record<string, unknown>, index, area }
}

/** Registers every readable blob of the file with `store`; a missing or out-of-range one is not adopted, so its image shows the placeholder. */
function adoptBlobs(store: ImageStore, raw: RawFile): void {
  if (!raw.area) return
  for (const id of Object.keys(raw.index)) {
    const stored = sliceBlob(raw.area, raw.index, id)
    if (stored) store.adoptStored(id, stored)
  }
}

export async function decryptDocument(bytes: Uint8Array, password: string): Promise<Doc> {
  return (await decryptDocumentWithVersion(bytes, password)).doc
}

/**
 * Gap 4: the last gate before a parsed document reaches the store. Runs on
 * both load paths so a file that survives decryption/JSON parsing but whose
 * shape the app can't render is refused by name, rather than loaded and then
 * written back over the user's real file by the next auto-save.
 */
function checkShape(doc: Doc): Doc {
  const bad = validateDoc(doc)
  if (bad) throw new CorruptFileError(bad)
  return doc
}

/** A freshly opened document plus the schema version its file was at *before* migration (null when the file didn't carry a numeric one). */
export interface OpenedDoc {
  doc: Doc
  preSchemaVersion: number | null
  /** The file's image bytes (sealed blobs are opened lazily), bound to the file's own password. */
  images: ImageStore
}

/** Read before migrate(), which upgrades the parsed object in place. */
function schemaVersionOf(parsed: unknown): number | null {
  const v = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion
  return typeof v === 'number' ? v : null
}

/**
 * decryptDocument for the open path (ui/start.ts): also reports the file's
 * pre-migration schema version, which decides whether main.ts's
 * onDocumentOpened snapshots the original, unmigrated bytes to the backup.
 * Decrypts and parses once — reading the version through a second full
 * decrypt+parse used to double the cost of every open.
 */
export async function decryptDocumentWithVersion(bytes: Uint8Array, password: string): Promise<OpenedDoc> {
  const raw = await decryptRaw(bytes, password)
  const preSchemaVersion = schemaVersionOf(raw.parsed)
  const doc = checkShape(migrate(raw.parsed))
  const images = createImageStore(await blobCodec(password))
  adoptBlobs(images, raw)
  return { doc, preSchemaVersion, images }
}

/** Password-less counterpart of `encryptDocument`; same `images`/`ids` contract. */
export async function serializePlain(doc: Doc, images: ImageStore = createImageStore(null), ids: string[] = []): Promise<Uint8Array> {
  const env = await buildEnvelope(doc, images, ids)
  const head = new TextEncoder().encode(JSON.stringify({ doc: env.doc, index: env.index }))
  const out = new Uint8Array(PLAIN2_TAG_BYTES.length + head.length + 1 + env.area.length)
  out.set(PLAIN2_TAG_BYTES, 0)
  out.set(head, PLAIN2_TAG_BYTES.length)
  out[PLAIN2_TAG_BYTES.length + head.length] = 0x0a
  out.set(env.area, PLAIN2_TAG_BYTES.length + head.length + 1)
  return out
}

/**
 * Returns null (not a plain file) rather than throwing when the tag doesn't
 * match — callers fall through to decryptDocument for the encrypted path.
 * Only throws once we're committed to "this is a plain file, but a corrupt
 * one" (bad JSON) or "a plain file from a newer, unsupported schema".
 */
export function parsePlain(bytes: Uint8Array): Doc | null {
  return parsePlainWithVersion(bytes)?.doc ?? null
}

/** parsePlain for the open path — also reports the pre-migration schema version, from the same single parse (see decryptDocumentWithVersion). */
export function parsePlainWithVersion(bytes: Uint8Array): OpenedDoc | null {
  const v2 = startsWith(bytes, PLAIN2_TAG_BYTES)
  if (!v2 && !startsWith(bytes, PLAIN_TAG_BYTES)) return null
  const images = createImageStore(null)
  let parsed: unknown
  try {
    if (v2) {
      // The envelope is one JSON line (JSON.stringify never emits a raw newline); the blob area follows it.
      const start = PLAIN2_TAG_BYTES.length
      const nl = bytes.indexOf(0x0a, start)
      if (nl < 0) throw new CorruptFileError()
      const raw = splitEnvelope(JSON.parse(new TextDecoder().decode(bytes.subarray(start, nl))), bytes.subarray(nl + 1))
      adoptBlobs(images, raw)
      parsed = raw.parsed
    } else {
      parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(PLAIN_TAG_BYTES.length)))
    }
  } catch {
    throw new CorruptFileError()
  }
  const preSchemaVersion = schemaVersionOf(parsed)
  return { doc: checkShape(migrate(parsed)), preSchemaVersion, images }
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false
  return true
}
