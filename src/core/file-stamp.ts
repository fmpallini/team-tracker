// Identity of one file write. `writeId` is what the browser store remembers
// (live-open.ts's lineage check); `savedAt` is display-only, never compared.
export interface FileStamp { writeId: string; savedAt: number }

export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function newStamp(now: number = Date.now()): FileStamp {
  return { writeId: randomHex(16), savedAt: now }
}

const HEX32 = /^[0-9a-f]{32}$/

/** The envelope's `stamp` field if well-formed, else null (files from before schema 18 carry none). */
export function parseStamp(raw: unknown): FileStamp | null {
  const s = raw as { writeId?: unknown; savedAt?: unknown } | null
  if (!s || typeof s !== 'object') return null
  if (typeof s.writeId !== 'string' || !HEX32.test(s.writeId)) return null
  if (typeof s.savedAt !== 'number' || !Number.isFinite(s.savedAt)) return null
  return { writeId: s.writeId, savedAt: s.savedAt }
}
