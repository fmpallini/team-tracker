// src/ui/open-document.ts — the step between "the file is decoded" and "the app
// mounts it": reconcile with the browser's copy of the document (core/live-open.ts),
// asking the user the questions that needs, and hand main.ts everything it mounts.
// Shared by the start screen (open, create) and by the conflict-fork reopen.
import type { Doc } from '../core/types'
import type { FileSession } from '../core/fs'
import type { OpenedDoc } from '../core/crypto'
import type { FileStamp } from '../core/file-stamp'
import type { ImageStore } from '../core/image-store'
import type { LiveDb } from '../core/live-db'
import { resolveOpen, OpenCancelled, type LiveHandle } from '../core/live-open'
import { createStore, type Store } from '../core/store'
import { t, type Locale } from '../core/i18n'
import { askOlderFile, askBothChanged } from './reconcile-dialogs'
import { promptPassword, toast } from './modal'

export interface OpenedDocument {
  session: FileSession
  doc: Doc
  password: string | null
  images: ImageStore
  /** The store the browser copy follows (or, without browser storage, a plain one). */
  store: Store
  /** Null when the browser could not open its storage: the document then lives in memory and the file only. */
  handle: LiveHandle | null
  /** The browser copy won, so the file is behind and should be written right after mounting. */
  needsFileWrite: boolean
  /** The stamp of the file that was opened. */
  stamp: FileStamp | null
}

/** Null: the user backed out of a question. Anything else unexpected propagates. */
export async function reconcileOpen(opts: {
  locale: Locale
  db: LiveDb | null
  session: FileSession
  opened: OpenedDoc
  password: string | null
}): Promise<OpenedDocument | null> {
  const { locale, db, session, opened, password } = opts
  if (!db) {
    toast(t(locale, 'live_store_unavailable_toast'), { sticky: true })
    const store = createStore(opened.doc, opened.images)
    return { session, doc: opened.doc, password, images: opened.images, store, handle: null, needsFileWrite: false, stamp: opened.stamp }
  }
  try {
    const r = await resolveOpen({
      db, opened, password, fileName: session.name,
      askOlderFile: () => askOlderFile(locale),
      askBothChanged: () => askBothChanged(locale),
      askBrowserPassword: async () => {
        const result = await promptPassword(locale, { title: t(locale, 'live_copy_password_title') })
        return result !== null && 'password' in result ? result.password : null
      },
      createStore,
    })
    return { session, doc: r.doc, password: r.password, images: r.images, store: r.store, handle: r.handle, needsFileWrite: r.needsFileWrite, stamp: r.stamp }
  } catch (e) {
    if (e instanceof OpenCancelled) return null
    throw e
  }
}
