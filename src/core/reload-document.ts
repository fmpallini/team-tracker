// src/core/reload-document.ts — turns the bytes now on disk into a Doc when the
// app re-reads its OWN open file (conflict modal "Reload", or a tab taking the
// write lock over from another).
//
// Extracted out of main.ts's `reloadFromDisk` because the easy assumption —
// "the file is still under the password I opened it with" — is false exactly
// when another tab changed the password, or switched the file between
// password-protected and password-less. Decoding with the stale password then
// failed, the tab went writable on an out-of-date document, and a later
// "Overwrite" quietly reverted the other tab's password change and edits.
import type { Doc } from './types'
import { decryptDocument, parsePlain, WrongPasswordError } from './crypto'

export class ReloadCancelledError extends Error {}

export interface ReloadedDocument {
  doc: Doc
  /** The password the file is under NOW — null for a password-less file. May differ from the one passed in. */
  password: string | null
}

/**
 * `askPassword` is called only when the current password no longer opens the
 * file; `wasWrong` is true on a retry after a rejected attempt. Resolving null
 * (the user cancelled) rejects with `ReloadCancelledError`.
 */
export async function decodeForReload(
  bytes: Uint8Array,
  currentPassword: string | null,
  askPassword: (wasWrong: boolean) => Promise<string | null>
): Promise<ReloadedDocument> {
  // Format first, not password first: a file that is now password-less must not
  // be fed to the decryptor, and one that is now encrypted must not be.
  const plain = parsePlain(bytes)
  if (plain) return { doc: plain, password: null }

  if (currentPassword !== null) {
    try {
      return { doc: await decryptDocument(bytes, currentPassword), password: currentPassword }
    } catch (e) {
      if (!(e instanceof WrongPasswordError)) throw e
    }
  }

  let wasWrong = currentPassword !== null
  for (;;) {
    const pw = await askPassword(wasWrong)
    if (pw === null) throw new ReloadCancelledError()
    try {
      return { doc: await decryptDocument(bytes, pw), password: pw }
    } catch (e) {
      if (!(e instanceof WrongPasswordError)) throw e
      wasWrong = true
    }
  }
}
