// src/ui/start.ts
import { t, type Locale } from '../core/i18n'
import type { Doc } from '../core/types'
import { el } from './dom'
import {
  supportsFsApi,
  pickOpen,
  pickCreate,
  reopenLast,
  writeFile,
  downloadFallback,
  type FileSession,
} from '../core/fs'
import { idbGet } from '../core/idb'
import { decryptDocument, encryptDocument, WrongPasswordError, CorruptFileError } from '../core/crypto'
import { createEmptyDocument, SchemaTooNewError } from '../core/document'
import { promptPassword, showErrorModal, toast } from './modal'

const SUGGESTED_NAME = 'team-tracker.tmv'

export function showStartScreen(
  locale: Locale,
  onOpen: (session: FileSession, doc: Doc, password: string) => void
): void {
  const container = document.getElementById('app') ?? document.body
  container.innerHTML = ''

  function reportUnexpected(e: unknown): void {
    console.error(e)
    showErrorModal(locale, t(locale, 'err_unexpected'))
  }

  async function decryptLoop(bytes: Uint8Array): Promise<{ doc: Doc; password: string } | null> {
    for (;;) {
      const password = await promptPassword(locale, { title: t(locale, 'open_file') })
      if (password === null) return null
      try {
        const doc = await decryptDocument(bytes, password)
        return { doc, password }
      } catch (e) {
        if (e instanceof WrongPasswordError) {
          toast(t(locale, 'err_wrong_password'))
          continue
        }
        if (e instanceof CorruptFileError) {
          showErrorModal(locale, t(locale, 'err_corrupt_file'))
          return null
        }
        if (e instanceof SchemaTooNewError) {
          showErrorModal(locale, t(locale, 'err_schema_too_new'))
          return null
        }
        throw e
      }
    }
  }

  async function handleOpenViaPicker(): Promise<void> {
    const result = await pickOpen()
    if (!result) return
    const outcome = await decryptLoop(result.bytes)
    if (outcome) onOpen(result.session, outcome.doc, outcome.password)
  }

  async function handleOpenFallbackFile(file: File): Promise<void> {
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const session: FileSession = { handle: null, name: file.name, lastModified: file.lastModified }
    const outcome = await decryptLoop(bytes)
    if (outcome) onOpen(session, outcome.doc, outcome.password)
  }

  async function handleReopenLast(): Promise<void> {
    const result = await reopenLast()
    if (!result) return
    const outcome = await decryptLoop(result.bytes)
    if (outcome) onOpen(result.session, outcome.doc, outcome.password)
  }

  async function handleCreate(): Promise<void> {
    if (supportsFsApi) {
      const session = await pickCreate(SUGGESTED_NAME)
      if (!session) return
      const password = await promptPassword(locale, { confirm: true, title: t(locale, 'create_file') })
      if (password === null) return
      const doc = createEmptyDocument(locale)
      const bytes = await encryptDocument(doc, password)
      await writeFile(session, bytes)
      onOpen(session, doc, password)
    } else {
      const password = await promptPassword(locale, { confirm: true, title: t(locale, 'create_file') })
      if (password === null) return
      const doc = createEmptyDocument(locale)
      const bytes = await encryptDocument(doc, password)
      downloadFallback(SUGGESTED_NAME, bytes)
      toast(t(locale, 'fallback_notice'), { sticky: true })
      const session: FileSession = { handle: null, name: SUGGESTED_NAME, lastModified: Date.now() }
      onOpen(session, doc, password)
    }
  }

  const fileInput = el('input', {
    type: 'file',
    accept: '.tmv',
    class: 'tt-hidden-input',
    onchange: () => {
      const file = fileInput.files?.[0]
      if (!file) return
      toast(t(locale, 'fallback_notice'), { sticky: true })
      handleOpenFallbackFile(file)
        .catch(reportUnexpected)
        .finally(() => {
          fileInput.value = ''
        })
    },
  })

  const openBtn = el(
    'button',
    {
      class: 'tt-btn tt-btn-primary tt-start-btn',
      type: 'button',
      onclick: () => {
        if (supportsFsApi) {
          handleOpenViaPicker().catch(reportUnexpected)
        } else {
          fileInput.click()
        }
      },
    },
    t(locale, 'start_open_ellipsis')
  )

  const createBtn = el(
    'button',
    {
      class: 'tt-btn tt-start-btn',
      type: 'button',
      onclick: () => {
        handleCreate().catch(reportUnexpected)
      },
    },
    t(locale, 'start_create_ellipsis')
  )

  const reopenBtn = el(
    'button',
    {
      class: 'tt-btn tt-start-btn',
      type: 'button',
      onclick: () => {
        handleReopenLast().catch(reportUnexpected)
      },
    },
    t(locale, 'start_reopen_ellipsis')
  )

  const title = el('h1', { class: 'tt-start-title' }, t(locale, 'app_name'))
  const tagline = el('p', { class: 'tt-start-tagline' }, t(locale, 'start_tagline'))
  const advantages = el(
    'ul',
    { class: 'tt-start-advantages' },
    el('li', {}, t(locale, 'start_adv_offline')),
    el('li', {}, t(locale, 'start_adv_ownership')),
    el('li', {}, t(locale, 'start_adv_crypto'))
  )
  const buttonsCol = el('div', { class: 'tt-start-buttons' }, reopenBtn, openBtn, createBtn)
  reopenBtn.style.display = 'none'

  const children: (Node | string | null)[] = [title, tagline, advantages, buttonsCol]
  if (!supportsFsApi) {
    children.push(el('p', { class: 'tt-start-fallback-notice' }, t(locale, 'fallback_notice')))
  }
  const root = el('div', { class: 'tt-start-screen' }, ...children)

  container.append(root, fileInput)

  idbGet('lastHandle').then((handle) => {
    if (handle !== undefined) reopenBtn.style.display = ''
  })
}
