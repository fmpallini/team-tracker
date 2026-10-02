// src/core/doc-bytes.ts — the one place that decides how a document becomes
// file bytes. A password means AES-GCM (crypto.ts's `.tmv` binary format);
// `null` means a password-less file (`TMV-PLAIN` header + readable JSON).
// Every writer — save, backup mirror, conflict overwrite/fork, password
// change, file creation — used to repeat this ternary inline.
//
// Lives apart from crypto.ts on purpose: callers' tests mock crypto.ts's two
// primitives to assert which one ran ("a null password never calls
// encryptDocument"). A helper in the same module would call its own local
// bindings and slip past those mocks; from here the mocks still apply.
import type { Doc } from './types'
import { encryptDocument, serializePlain } from './crypto'

export async function docToBytes(doc: Doc, password: string | null): Promise<Uint8Array> {
  return password === null ? serializePlain(doc) : await encryptDocument(doc, password)
}
