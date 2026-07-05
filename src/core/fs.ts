import { idbGet, idbSet } from './idb'

export interface FileSession {
  handle: FileSystemFileHandle | null // null in fallback mode
  name: string
  lastModified: number // updated after each read/write
}

export const supportsFsApi: boolean = typeof window !== 'undefined' && 'showOpenFilePicker' in window

export class ExternalChangeError extends Error {}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

async function readHandle(handle: FileSystemFileHandle): Promise<{ bytes: Uint8Array; lastModified: number }> {
  const file = await handle.getFile()
  const buf = await file.arrayBuffer()
  return { bytes: new Uint8Array(buf), lastModified: file.lastModified }
}

export async function pickOpen(): Promise<{ session: FileSession; bytes: Uint8Array } | null> {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Team Tracker', accept: { 'application/octet-stream': ['.tmv'] } }],
    })
    if (!handle) return null
    const { bytes, lastModified } = await readHandle(handle)
    const session: FileSession = { handle, name: handle.name, lastModified }
    await idbSet('lastHandle', handle)
    return { session, bytes }
  } catch (e) {
    if (isAbortError(e)) return null
    throw e
  }
}

export async function pickCreate(suggestedName: string): Promise<FileSession | null> {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'Team Tracker', accept: { 'application/octet-stream': ['.tmv'] } }],
    })
    const { lastModified } = await readHandle(handle)
    const session: FileSession = { handle, name: handle.name, lastModified }
    await idbSet('lastHandle', handle)
    return session
  } catch (e) {
    if (isAbortError(e)) return null
    throw e
  }
}

export async function reopenLast(): Promise<{ session: FileSession; bytes: Uint8Array } | null> {
  const handle = await idbGet<FileSystemFileHandle>('lastHandle')
  if (!handle) return null
  let permission = await handle.queryPermission({ mode: 'readwrite' })
  if (permission !== 'granted') permission = await handle.requestPermission({ mode: 'readwrite' })
  if (permission !== 'granted') return null
  const { bytes, lastModified } = await readHandle(handle)
  const session: FileSession = { handle, name: handle.name, lastModified }
  return { session, bytes }
}

export async function writeFile(session: FileSession, bytes: Uint8Array): Promise<void> {
  const { handle } = session
  if (!handle) throw new Error('writeFile requires a file handle (fallback mode has no handle)')
  const current = await handle.getFile()
  if (current.lastModified !== session.lastModified) throw new ExternalChangeError()
  const writable = await handle.createWritable()
  await writable.write(bytes as BufferSource)
  await writable.close()
  const after = await handle.getFile()
  session.lastModified = after.lastModified
  await idbSet('lastHandle', handle)
}

export async function forceWrite(session: FileSession, bytes: Uint8Array): Promise<void> {
  const { handle } = session
  if (!handle) throw new Error('forceWrite requires a file handle (fallback mode has no handle)')
  const writable = await handle.createWritable()
  await writable.write(bytes as BufferSource)
  await writable.close()
  const after = await handle.getFile()
  session.lastModified = after.lastModified
  await idbSet('lastHandle', handle)
}

export async function readCurrent(session: FileSession): Promise<Uint8Array> {
  const { handle } = session
  if (!handle) throw new Error('readCurrent requires a file handle (fallback mode has no handle)')
  const { bytes, lastModified } = await readHandle(handle)
  session.lastModified = lastModified
  return bytes
}

export function downloadFallback(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
