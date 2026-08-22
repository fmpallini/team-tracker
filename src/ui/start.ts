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
  NeedsRepickError,
  type FileSession,
} from '../core/fs'
import { idbGet } from '../core/idb'
import { logEvent } from '../core/debug-log'
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
  onOpen: (session: FileSession, doc: Doc, password: string | null) => void
): void {
  const container = document.getElementById('app') ?? document.body
  container.innerHTML = ''

  if (isMobileDevice()) {
    showMobileBlockScreen(container, locale)
    return
  }

  function reportUnexpected(e: unknown): void {
    console.error(e)
    logEvent('start.reportUnexpected', String(e))
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
    logEvent('start.openAndDecrypt', 'fetching session+bytes')
    const result = await fetchResult()
    logEvent('start.openAndDecrypt', result ? 'got session+bytes' : 'fetchResult returned null (cancelled/denied)')
    if (!result) return
    let plainDoc: Doc | null
    try {
      plainDoc = parsePlain(result.bytes)
      logEvent('start.openAndDecrypt', `parsePlain -> ${plainDoc ? 'plain doc' : 'encrypted, needs password'}`)
    } catch (e) {
      logEvent('start.openAndDecrypt', `parsePlain threw: ${String(e)}`)
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
      logEvent('start.openAndDecrypt', 'onOpen called (plain doc)')
      return
    }
    const outcome = await decryptLoop(result.bytes)
    logEvent('start.openAndDecrypt', outcome ? 'decryptLoop succeeded' : 'decryptLoop cancelled/failed')
    if (outcome) {
      onOpen(result.session, outcome.doc, outcome.password)
      logEvent('start.openAndDecrypt', 'onOpen called (decrypted doc)')
    }
  }

  const handleOpenViaPicker = (): Promise<void> => openAndDecrypt(() => pickOpen())

  /**
   * Shared by `handleReopenLast` and `handleLaunchFile`: both go through
   * `openFromHandle`, which throws `NeedsRepickError` instead of ever calling
   * `requestPermission()` on a lapsed grant (see that class's doc comment in
   * core/fs.ts for the crash history behind this). Falls back to the plain
   * file picker, pre-pointed at the same folder, so "reopen last" still ends
   * up open — just via one extra click — instead of the crashing dialog.
   */
  async function openWithRepickFallback(fetchResult: () => Promise<{ session: FileSession; bytes: Uint8Array } | null>): Promise<void> {
    try {
      await openAndDecrypt(fetchResult)
    } catch (e) {
      if (!(e instanceof NeedsRepickError)) throw e
      logEvent('start.openWithRepickFallback', 'permission lapsed, falling back to file picker')
      toast(t(locale, 'reopen_needs_repick_toast'))
      await openAndDecrypt(() => pickOpen(e.handle))
    }
  }

  const handleReopenLast = (): Promise<void> => {
    logEvent('start.handleReopenLast', 'clicked')
    return openWithRepickFallback(reopenLast)
  }
  const handleLaunchFile = (handle: FileSystemFileHandle): Promise<void> => openWithRepickFallback(() => openFromHandle(handle))

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
  const buttonsCol = el('div', { class: 'tt-start-buttons' }, reopenBtn, openBtn, createBtn)
  reopenBtn.style.display = 'none'

  const children: (Node | string | null)[] = [title, versionTag, tagline, advantages, backupTip, buttonsCol]
  if (!supportsFsApi) {
    children.push(el('p', { class: 'tt-start-fallback-notice' }, t(locale, 'fallback_notice')))
  }
  children.push(promoStartCard(locale))
  const root = el('div', { class: 'tt-start-screen' }, el('div', { class: 'tt-start-content' }, ...children))

  container.append(root, fileInput)

  idbGet('lastHandle')
    .then((handle) => {
      if (handle !== undefined) reopenBtn.style.display = ''
    })
    .catch((e: unknown) => console.error(e))

  // Absent outside Chromium and in jsdom (tests) — feature-detected, no-op
  // everywhere else.
  window.launchQueue?.setConsumer((launchParams) => {
    const handle = launchParams.files[0]
    if (handle) handleLaunchFile(handle).catch(reportUnexpected)
  })
}
