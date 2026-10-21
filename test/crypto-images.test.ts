import {
  encryptDocument, decryptDocument, decryptDocumentWithVersion, serializePlain, parsePlainWithVersion,
  looksLikeTmv, resetSessionKey, blobCodec, WrongPasswordError, CorruptFileError,
} from '../src/core/crypto'
import { createEmptyDocument, SCHEMA_VERSION } from '../src/core/document'
import { createImageStore } from '../src/core/image-store'

// Format v2: the doc envelope first, then individually sealed image blobs.
describe('format v2 images', () => {
  const A = 'a'.repeat(32)
  const B = 'b'.repeat(32)
  const bytesA = new Uint8Array([1, 2, 3, 0x0a, 4, 5, 0x0a])
  const bytesB = new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff))

  async function withImages(password: string | null) {
    const doc = createEmptyDocument('en-US')
    doc.images = {
      [A]: { mime: 'image/webp', w: 1, h: 1, bytes: bytesA.length },
      [B]: { mime: 'image/webp', w: 2, h: 2, bytes: bytesB.length },
    }
    const store = createImageStore(password === null ? null : await blobCodec(password))
    store.putPlain(A, bytesA)
    store.putPlain(B, bytesB)
    return { doc, store }
  }
  const bytesOf = async (p: Promise<Uint8Array | null>) => { const r = await p; return r && [...r] }

  it('round-trips two images through an encrypted file; header says format 2', async () => {
    const { doc, store } = await withImages('pw')
    const bytes = await encryptDocument(doc, 'pw', store, [A, B])
    expect(bytes[4]).toBe(2)
    const opened = await decryptDocumentWithVersion(bytes, 'pw')
    expect(opened.doc.images).toEqual(doc.images)
    expect(await bytesOf(opened.images.getPlain(A))).toEqual([...bytesA])
    expect(await bytesOf(opened.images.getPlain(B))).toEqual([...bytesB])
    await expect(decryptDocument(bytes, 'nope')).rejects.toBeInstanceOf(WrongPasswordError)
  }, 30000)

  it('opened images re-save without being re-sealed (stored bytes are carried over)', async () => {
    const { doc, store } = await withImages('pw')
    const first = await encryptDocument(doc, 'pw', store, [A, B])
    const opened = await decryptDocumentWithVersion(first, 'pw')
    const second = await encryptDocument(opened.doc, 'pw', opened.images, [A, B])
    const reopened = await decryptDocumentWithVersion(second, 'pw')
    expect(await bytesOf(reopened.images.getPlain(B))).toEqual([...bytesB])
    const tail = 35 + 12 + 300 + 16
    expect([...second.slice(second.length - tail)]).toEqual([...first.slice(first.length - tail)])
  }, 30000)

  it('a document with zero images still writes v2 and round-trips', async () => {
    const doc = createEmptyDocument('en-US')
    const bytes = await encryptDocument(doc, 'pw')
    expect(bytes[4]).toBe(2)
    expect(await decryptDocument(bytes, 'pw')).toEqual(doc)
  }, 30000)

  it('reads a v1 file (single AES-GCM doc payload) and reports its schema version', async () => {
    const doc = { ...createEmptyDocument('en-US'), schemaVersion: 16 } as Record<string, unknown>
    delete doc.images
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const ivKcv = crypto.getRandomValues(new Uint8Array(12)), ivData = crypto.getRandomValues(new Uint8Array(12))
    const kcv = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivKcv }, key, new Uint8Array(16)))
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivData }, key, new TextEncoder().encode(JSON.stringify(doc))))
    const v1 = new Uint8Array(77 + data.length)
    v1.set([0x54, 0x4d, 0x56, 0x31, 1], 0); v1.set(salt, 5); v1.set(ivKcv, 21); v1.set(kcv, 33); v1.set(ivData, 65); v1.set(data, 77)
    resetSessionKey()
    expect(looksLikeTmv(v1)).toBe(true)
    const opened = await decryptDocumentWithVersion(v1, 'pw')
    expect(opened.preSchemaVersion).toBe(16)
    expect(opened.doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(opened.doc.images).toEqual({})
    // the store is bound to the file's password, so an image added now can be saved
    opened.images.putPlain(A, bytesA)
    expect(await opened.images.getStored(A)).not.toBeNull()
  }, 30000)

  it('round-trips plain v2 including a blob that contains newline bytes', async () => {
    const { doc, store } = await withImages(null)
    const bytes = await serializePlain(doc, store, [A, B])
    const opened = parsePlainWithVersion(bytes)!
    expect(opened.doc.images).toEqual(doc.images)
    expect(await bytesOf(opened.images.getPlain(A))).toEqual([...bytesA])
    expect(await bytesOf(opened.images.getPlain(B))).toEqual([...bytesB])
  })

  it('still reads legacy TMV-PLAIN files (v1 plain)', () => {
    const doc = { ...createEmptyDocument('en-US'), schemaVersion: 16 } as Record<string, unknown>
    delete doc.images
    const opened = parsePlainWithVersion(new TextEncoder().encode('TMV-PLAIN\n' + JSON.stringify(doc)))!
    expect(opened.preSchemaVersion).toBe(16)
    expect(opened.doc.images).toEqual({})
  })

  it('a flipped byte inside one blob leaves the document and the other image readable', async () => {
    const { doc, store } = await withImages('pw')
    const bytes = await encryptDocument(doc, 'pw', store, [A, B])
    // blob order is [A, B]; A sealed = 12 iv + 7 + 16 tag = 35 bytes, B = 12 + 300 + 16
    const areaStart = bytes.length - (35 + 12 + 300 + 16)
    bytes[areaStart + 20] = bytes[areaStart + 20]! ^ 0xff
    const opened = await decryptDocumentWithVersion(bytes, 'pw')
    expect(await opened.images.getPlain(A)).toBeNull()
    expect(await bytesOf(opened.images.getPlain(B))).toEqual([...bytesB])
  }, 30000)

  it('a file truncated inside the blob area opens; the cut image is unreadable, not a throw', async () => {
    const { doc, store } = await withImages('pw')
    const bytes = await encryptDocument(doc, 'pw', store, [A, B])
    const opened = await decryptDocumentWithVersion(bytes.slice(0, bytes.length - 100), 'pw')
    expect(await bytesOf(opened.images.getPlain(A))).toEqual([...bytesA])
    expect(await opened.images.getPlain(B)).toBeNull()
  }, 30000)

  it('a doc ciphertext length that runs past the end of the file is corrupt', async () => {
    const bytes = await encryptDocument(createEmptyDocument('en-US'), 'pw')
    new DataView(bytes.buffer).setUint32(77, 0xffffffff, false)
    await expect(decryptDocument(bytes, 'pw')).rejects.toBeInstanceOf(CorruptFileError)
  }, 30000)

  it('two seals of the same plaintext differ (fresh IV)', async () => {
    const codec = await blobCodec('pw')
    const x = await codec.seal(A, bytesA)
    const y = await codec.seal(A, bytesA)
    expect([...x]).not.toEqual([...y])
  }, 30000)

  it('a blob moved to another id slot fails to open (the id is authenticated)', async () => {
    const codec = await blobCodec('pw')
    const sealed = await codec.seal(A, bytesA)
    await expect(codec.open(B, sealed)).rejects.toBeInstanceOf(CorruptFileError)
    expect([...await codec.open(A, sealed)]).toEqual([...bytesA])
  }, 30000)

  it('swapped index entries in a crafted file read as null for both images', async () => {
    const { doc, store } = await withImages('pw')
    const opened = await decryptDocumentWithVersion(await encryptDocument(doc, 'pw', store, [A, B]), 'pw')
    const a = (await opened.images.getStored(A))!
    const b = (await opened.images.getStored(B))!
    const swapped = createImageStore(await blobCodec('pw'))
    swapped.adoptStored(A, b)
    swapped.adoptStored(B, a)
    expect(await swapped.getPlain(A)).toBeNull()
    expect(await swapped.getPlain(B)).toBeNull()
  }, 30000)

  it('an id the store cannot produce is skipped and left out of the written doc.images', async () => {
    const { doc, store } = await withImages('pw')
    doc.images['c'.repeat(32)] = { mime: 'image/webp', w: 1, h: 1, bytes: 1 }
    const bytes = await encryptDocument(doc, 'pw', store, [A, B, 'c'.repeat(32)])
    const opened = await decryptDocumentWithVersion(bytes, 'pw')
    expect(Object.keys(opened.doc.images).sort()).toEqual([A, B])
  }, 30000)
})

// The header key and the image seal key must be one key, whatever happens to the
// module-level session-key cache while a document is open (a conflict Fork reopens
// with the same image store after the previous app tore down; opening a second
// file replaces the cache while the first is still open).
describe('header key follows the image store, not the global cache', () => {
  const A = 'a'.repeat(32)
  const bytesA = new Uint8Array([9, 8, 7, 6])
  const docWith = () => {
    const doc = createEmptyDocument('en-US')
    doc.images = { [A]: { mime: 'image/webp', w: 1, h: 1, bytes: bytesA.length } }
    return doc
  }
  async function savedFile() {
    const store = createImageStore(await blobCodec('pw'))
    store.putPlain(A, bytesA)
    return { store, file: await encryptDocument(docWith(), 'pw', store, [A]) }
  }
  const readable = async (file: Uint8Array) => {
    resetSessionKey()
    const re = await decryptDocumentWithVersion(file, 'pw')
    const got = await re.images.getPlain(A)
    return got && [...got]
  }

  it('a save after the cache was reset (fork reopen, teardown) still opens with its pictures', async () => {
    const { store } = await savedFile()
    resetSessionKey()
    const next = await encryptDocument(docWith(), 'pw', store, [A])
    expect(await readable(next)).toEqual([...bytesA])
  }, 30000)

  it('opening a second file while the first is open does not break either file\'s next save', async () => {
    resetSessionKey()
    const second = await encryptDocument(createEmptyDocument('en-US'), 'pw') // another file: its own salt
    resetSessionKey()
    const first = await savedFile()
    const opened = await decryptDocumentWithVersion(second, 'pw') // replaces the cache with the second file's key
    const resavedFirst = await encryptDocument(docWith(), 'pw', first.store, [A])
    expect(await readable(resavedFirst)).toEqual([...bytesA])
    resetSessionKey() // first app's teardown
    const resavedSecond = await encryptDocument(opened.doc, 'pw', opened.images, [])
    resetSessionKey()
    await expect(decryptDocument(resavedSecond, 'pw')).resolves.toBeTruthy()
  }, 30000)

  it('a decrypt that fails after the key check leaves the cache as it was', async () => {
    resetSessionKey()
    const other = await encryptDocument(createEmptyDocument('en-US'), 'pw') // its own salt
    resetSessionKey()
    const { file } = await savedFile()
    // Damage the second file's data so the key check passes and the payload does not.
    const broken = other.slice()
    broken[broken.length - 1]! ^= 0xff
    await expect(decryptDocument(broken, 'pw')).rejects.toBeInstanceOf(CorruptFileError)
    const next = await encryptDocument(docWith(), 'pw') // no store: header comes from the cache
    expect(new Uint8Array(next.subarray(5, 21))).toEqual(new Uint8Array(file.subarray(5, 21)))
  }, 30000)
})
