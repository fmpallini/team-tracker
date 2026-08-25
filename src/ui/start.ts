// src/ui/start.ts
import { t, type Locale } from '../core/i18n'
import type { Doc } from '../core/types'
import { el } from './dom'
import { promoStartCard } from './promo'
import {
  supportsFsApi,
  pickOpen,
  pickCreate,
  reopenLast,
  writeFile,
  downloadFallback,
  openFromHandle,
  peekLastFile,
  type FileSession,
} from '../core/fs'
import { idbGet, idbSet } from '../core/idb'
import { decryptDocument, encryptDocument, serializePlain, parsePlain, WrongPasswordError, CorruptFileError } from '../core/crypto'
import { createEmptyDocument, SchemaTooNewError } from '../core/document'
import { promptPassword, showErrorModal, toast } from './modal'

const SUGGESTED_NAME = 'team-tracker.tmv'

// File Handling API (Chromium, PWA-installed only): OS-level "open with" /
// double-click on a .tmv file launches the app and hands it the file's
// FileSystemFileHandle here instead of the picker flow. Declared locally
// since it's not yet in lib.dom.d.ts. See pwa/manifest.json's file_handlers.
interface FileHandlingLaunchParams {
  files: FileSystemFileHandle[]
}
declare global {
  interface Window {
    launchQueue?: {
      setConsumer(consumer: (launchParams: FileHandlingLaunchParams) => void): void
    }
  }
}

/**
 * Mobile browsers get a blocking notice instead of the start screen: they
 * lack the File System Access API (every save would degrade to a fresh
 * download) and the UI is keyboard/large-screen-only by design. Detection is
 * best-effort UA sniffing — `userAgentData.mobile` where available, plus the
 * iPadOS 13+ case where Safari masquerades as macOS but exposes multi-touch.
 * Exported for tests (jsdom's default UA is desktop-like).
 */
export function isMobileDevice(nav: Navigator = navigator): boolean {
  const uaData = (nav as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  if (uaData?.mobile === true) return true
  const ua = nav.userAgent
  if (/Android|iPhone|iPod|iPad|IEMobile|Opera Mini|Mobile Safari/i.test(ua)) return true
  return /Macintosh/i.test(ua) && nav.maxTouchPoints > 1
}

function showMobileBlockScreen(container: HTMLElement, locale: Locale): void {
  container.appendChild(
    el(
      'div',
      { class: 'tt-start-screen' },
      el(
        'div',
        { class: 'tt-start-content' },
        el('h1', { class: 'tt-start-title' }, t(locale, 'app_name')),
        el('h2', { class: 'tt-mobile-block-title' }, '📵 ' + t(locale, 'mobile_block_title')),
        el('p', { class: 'tt-start-tagline' }, t(locale, 'mobile_block_intro')),
        el(
          'ul',
          { class: 'tt-start-advantages' },
          el('li', {}, t(locale, 'mobile_block_reason_fs')),
          el('li', {}, t(locale, 'mobile_block_reason_ux'))
        ),
        el('p', { class: 'tt-start-tagline' }, t(locale, 'mobile_block_hint'))
      )
    )
  )
}

export function showStartScreen(
  locale: Locale,
  onOpen: (session: FileSession, doc: Doc, password: string | null) => void,
  opts?: { skipAutoLoad?: boolean }
): void {
  const container = document.getElementById('app') ?? document.body
  container.innerHTML = ''

  if (isMobileDevice()) {
    showMobileBlockScreen(container, locale)
    return
  }

  function reportUnexpected(e: unknown): void {
    console.error(e)
    showErrorModal(locale, t(locale, 'err_unexpected'))
  }

  async function decryptLoop(bytes: Uint8Array): Promise<{ doc: Doc; password: string } | null> {
    for (;;) {
      const result = await promptPassword(locale, { title: t(locale, 'open_file') })
      if (result === null) return null
      // allowPlain is never set for this prompt, so result is always {password}.
      const password = (result as { password: string }).password
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

  // Shared by every "get a {session, bytes} pair, then decrypt it" open
  // route (picker, reopen-last, File Handling API launch) — they differ only
  // in how the pair is obtained. A plain (password-less) file is sniffed
  // first so it can open directly, without ever prompting for a password.
  async function openAndDecrypt(fetchResult: () => Promise<{ session: FileSession; bytes: Uint8Array } | null>): Promise<void> {
    const result = await fetchResult()
    if (!result) return
    let plainDoc: Doc | null
    try {
      plainDoc = parsePlain(result.bytes)
    } catch (e) {
      if (e instanceof CorruptFileError) {
        showErrorModal(locale, t(locale, 'err_corrupt_file'))
        return
      }
      if (e instanceof SchemaTooNewError) {
        showErrorModal(locale, t(locale, 'err_schema_too_new'))
        return
      }
      throw e
    }
    if (plainDoc) {
      onOpen(result.session, plainDoc, null)
      return
    }
    const outcome = await decryptLoop(result.bytes)
    if (outcome) onOpen(result.session, outcome.doc, outcome.password)
  }

  const handleOpenViaPicker = (): Promise<void> => openAndDecrypt(() => pickOpen())
  const handleReopenLast = (): Promise<void> => openAndDecrypt(reopenLast)
  const handleLaunchFile = (handle: FileSystemFileHandle): Promise<void> => openAndDecrypt(() => openFromHandle(handle))

  async function handleOpenFallbackFile(file: File): Promise<void> {
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const session: FileSession = { handle: null, name: file.name, lastModified: file.lastModified }
    let plainDoc: Doc | null
    try {
      plainDoc = parsePlain(bytes)
    } catch (e) {
      if (e instanceof CorruptFileError) {
        showErrorModal(locale, t(locale, 'err_corrupt_file'))
        return
      }
      if (e instanceof SchemaTooNewError) {
        showErrorModal(locale, t(locale, 'err_schema_too_new'))
        return
      }
      throw e
    }
    if (plainDoc) {
      onOpen(session, plainDoc, null)
      return
    }
    const outcome = await decryptLoop(bytes)
    if (outcome) onOpen(session, outcome.doc, outcome.password)
  }

  async function handleCreate(): Promise<void> {
    if (supportsFsApi) {
      const session = await pickCreate(SUGGESTED_NAME)
      if (!session) return
      const result = await promptPassword(locale, { confirm: true, allowPlain: true, title: t(locale, 'create_file') })
      if (result === null) return
      const doc = createEmptyDocument(locale)
      const bytes = 'plain' in result ? serializePlain(doc) : await encryptDocument(doc, result.password)
      await writeFile(session, bytes)
      onOpen(session, doc, 'plain' in result ? null : result.password)
    } else {
      const result = await promptPassword(locale, { confirm: true, allowPlain: true, title: t(locale, 'create_file') })
      if (result === null) return
      const doc = createEmptyDocument(locale)
      const bytes = 'plain' in result ? serializePlain(doc) : await encryptDocument(doc, result.password)
      downloadFallback(SUGGESTED_NAME, bytes)
      // Not sticky: this announces the download that just happened. The
      // *ongoing* fact that this browser has no direct file access is a mode,
      // not an event, and lives on the save pill (shell.setFallbackHint) —
      // a sticky toast here outlived the start screen and sat over the app.
      toast(t(locale, 'fallback_notice'))
      const session: FileSession = { handle: null, name: SUGGESTED_NAME, lastModified: Date.now() }
      onOpen(session, doc, 'plain' in result ? null : result.password)
    }
  }

  const fileInput = el('input', {
    type: 'file',
    accept: '.tmv',
    class: 'tt-hidden-input',
    onchange: () => {
      const file = fileInput.files?.[0]
      if (!file) return
      // Not sticky: this announces the download that just happened. The
      // *ongoing* fact that this browser has no direct file access is a mode,
      // not an event, and lives on the save pill (shell.setFallbackHint) —
      // a sticky toast here outlived the start screen and sat over the app.
      toast(t(locale, 'fallback_notice'))
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
  const versionTag = el(
    'p',
    { class: 'tt-start-version' },
    el(
      'a',
      {
        href: 'https://github.com/fmpallini/team-tracker/releases',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      `v${__APP_VERSION__}`
    )
  )
  const tagline = el('p', { class: 'tt-start-tagline' }, t(locale, 'start_tagline'))
  const advantages = el(
    'ul',
    { class: 'tt-start-advantages' },
    el('li', {}, t(locale, 'start_adv_offline')),
    el('li', {}, t(locale, 'start_adv_ownership')),
    el('li', {}, t(locale, 'start_adv_crypto'))
  )
  const cloudLink = (href: string, label: string): HTMLAnchorElement =>
    el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label)
  const backupTip = el(
    'p',
    { class: 'tt-start-backup-tip' },
    t(locale, 'start_backup_tip_prefix'),
    cloudLink('https://workspace.google.com/products/drive/#download', t(locale, 'start_backup_tip_link_drive')),
    ', ',
    cloudLink('https://www.microsoft.com/microsoft-365/onedrive/download', t(locale, 'start_backup_tip_link_onedrive')),
    ', ',
    cloudLink('https://www.dropbox.com/install', t(locale, 'start_backup_tip_link_dropbox')),
    t(locale, 'start_backup_tip_suffix')
  )
  const autoLoadCheckbox = el('input', {
    type: 'checkbox',
    class: 'tt-start-autoload-checkbox',
    onchange: () => {
      idbSet('autoLoadLast', autoLoadCheckbox.checked).catch((e: unknown) => console.error(e))
    },
  }) as HTMLInputElement
  const autoLoadRow = el('label', { class: 'tt-start-autoload' }, autoLoadCheckbox, ' ' + t(locale, 'start_auto_load_last'))
  autoLoadRow.style.display = 'none'

  const reopenRow = el('div', { class: 'tt-start-reopen-row' }, reopenBtn, autoLoadRow)
  const buttonsCol = el('div', { class: 'tt-start-buttons' }, reopenRow, openBtn, createBtn)
  reopenBtn.style.display = 'none'
  reopenRow.style.display = 'none'

  const children: (Node | string | null)[] = [title, versionTag, tagline, advantages, backupTip, buttonsCol]
  if (!supportsFsApi) {
    children.push(el('p', { class: 'tt-start-fallback-notice' }, t(locale, 'fallback_notice')))
  }
  children.push(promoStartCard(locale))
  const root = el('div', { class: 'tt-start-screen' }, el('div', { class: 'tt-start-content' }, ...children))

  container.append(root, fileInput)

  idbGet('lastHandle')
    .then((handle) => {
      if (handle !== undefined) {
        reopenBtn.style.display = ''
        reopenRow.style.display = ''
      }
    })
    .catch((e: unknown) => console.error(e))

  // Silent (no permission prompt) peek at the last file, to offer/act on
  // "auto-open on startup" — only possible when it's passwordless (nothing
  // to prompt for) and the FS permission grant hasn't lapsed since last
  // visit. Never surfaces an error modal: an unreadable/corrupt last file
  // here just means no auto-load, same as if there were no last file at all.
  async function checkAutoLoad(): Promise<void> {
    const result = await peekLastFile()
    if (!result) return
    let plainDoc: Doc | null
    try {
      plainDoc = parsePlain(result.bytes)
    } catch (e) {
      console.error(e)
      return
    }
    if (!plainDoc) return
    const autoLoad = (await idbGet<boolean>('autoLoadLast')) === true
    autoLoadRow.style.display = ''
    autoLoadCheckbox.checked = autoLoad
    // skipAutoLoad: this render came from closeFile() (main.ts) — the user
    // just chose to leave this exact file, so re-opening it right back
    // would trap them (open/create would be unreachable). The checkbox still
    // reflects/edits the pref; only the immediate re-open is suppressed.
    if (autoLoad && !opts?.skipAutoLoad) onOpen(result.session, plainDoc, null)
  }
  checkAutoLoad().catch((e: unknown) => console.error(e))

  // Absent outside Chromium and in jsdom (tests) — feature-detected, no-op
  // everywhere else.
  window.launchQueue?.setConsumer((launchParams) => {
    const handle = launchParams.files[0]
    if (handle) handleLaunchFile(handle).catch(reportUnexpected)
  })
}
