import type { Doc } from './types'
import { migrate } from './document'

export class WrongPasswordError extends Error {}
export class CorruptFileError extends Error {}

const MAGIC = [0x54, 0x4d, 0x56, 0x31] // "TMV1"
const FORMAT_VERSION = 1
const ITERATIONS = 600_000
const KCV_PLAIN = new Uint8Array(16)

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
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

export async function encryptDocument(doc: Doc, password: string): Promise<Uint8Array> {
  const ivKcv = crypto.getRandomValues(new Uint8Array(12))
  const ivData = crypto.getRandomValues(new Uint8Array(12))
  const { salt, key } = await getSessionKey(password)
  const kcv = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivKcv }, key, KCV_PLAIN))
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivData }, key,
    new TextEncoder().encode(JSON.stringify(doc))))
  const out = new Uint8Array(4 + 1 + 16 + 12 + 32 + 12 + data.length)
  out.set(MAGIC, 0); out[4] = FORMAT_VERSION
  out.set(salt, 5); out.set(ivKcv, 21); out.set(kcv, 33); out.set(ivData, 65); out.set(data, 77)
  return out
}

export async function decryptDocument(bytes: Uint8Array, password: string): Promise<Doc> {
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
  try { return migrate(JSON.parse(new TextDecoder().decode(plain))) }
  catch (e) { if (e instanceof Error && e.constructor.name !== 'SyntaxError') throw e; throw new CorruptFileError() }
}
