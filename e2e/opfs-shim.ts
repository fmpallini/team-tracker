// e2e/opfs-shim.ts — Chromium implements the File System Access API, but
// Playwright can't drive its native OS picker dialog. `installOpfsPickerShim`
// replaces window.showOpenFilePicker/showSaveFilePicker with equivalents
// backed by the Origin Private File System (navigator.storage.getDirectory())
// — a REAL, disk-backed FileSystemFileHandle implementation (real
// createWritable/getFile/isSameEntry/permissions), just sourced from
// sandboxed storage instead of a user-driven dialog. App code
// (src/core/fs.ts) can't tell the difference: it's the same Web API, not a
// mock.
//
// OPFS requires a secure context, which is why this only works served over
// http://localhost (see e2e/static-server.mjs) — Chromium treats file://
// (smoke.spec.ts's APP_URL, the actual distributed dist/app.html artifact) as
// insecure, so neither the real pickers nor this shim's OPFS backing are
// available there. `forceFallbackMode` covers that origin instead: it
// removes the pickers entirely so supportsFsApi reads false, exercising the
// app's real download-fallback path the same way a browser without the File
// System Access API would.
import type { Page, BrowserContext } from '@playwright/test'

declare global {
  interface Window {
    /** Per file name, how many times the app opened it for writing in this page load (see `installFileWriteCounter`). */
    __e2eFileWrites?: Record<string, number>
    /** What `queryPermission` answers for every handle (see `installPermissionControl`). */
    __e2ePermission?: 'granted' | 'prompt'
    /** How many times the app asked to re-grant. */
    __e2eRegrants?: number
    /**
     * `showOpenFilePicker` has no `suggestedName` — a real picker lets the
     * user choose which file. Tests set this immediately before triggering
     * the open flow so the shim knows which OPFS file to "pick". Defaults to
     * the app's own suggested filename (src/ui/start.ts's SUGGESTED_NAME),
     * which covers the common case (open the file just created) without
     * every test needing to set it explicitly.
     */
    __e2eOpenName?: string
  }
}

// Must stay a fully self-contained function — Playwright serializes it via
// Function.prototype.toString() and runs it in the page, so it cannot close
// over anything from this module's scope.
function installShimInPage(): void {
  const DEFAULT_NAME = 'team-tracker.tmv'

  window.showSaveFilePicker = (async (options?: { suggestedName?: string }) => {
    const root = await navigator.storage.getDirectory()
    const name = options?.suggestedName ?? DEFAULT_NAME
    return root.getFileHandle(name, { create: true })
  }) as typeof window.showSaveFilePicker

  window.showOpenFilePicker = (async () => {
    const root = await navigator.storage.getDirectory()
    const name = window.__e2eOpenName ?? DEFAULT_NAME
    const handle = await root.getFileHandle(name)
    return [handle]
  }) as typeof window.showOpenFilePicker
}

/**
 * Installs the shim as an init script — applies to every navigation/page
 * this target produces, before any app code runs, so `supportsFsApi`'s
 * `'showOpenFilePicker' in window` feature-detection (src/core/fs.ts) sees
 * it in place from the very first script tag. Pass a `BrowserContext` (not
 * just a `Page`) for multi-tab tests: context-level init scripts apply to
 * pages opened later in that same context too.
 */
export async function installOpfsPickerShim(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(installShimInPage)
}

/** Tells the shim which OPFS file the next `showOpenFilePicker()` call should return. */
export async function setNextOpenName(page: Page, name: string): Promise<void> {
  await page.evaluate((n) => {
    window.__e2eOpenName = n
  }, name)
}

/**
 * Reads an OPFS file's raw bytes directly — for asserting on what the app actually wrote to disk, independent of app-level UI state.
 *
 * While the app commits a save (`createWritable().close()`), the file is briefly
 * reported as missing (`NotFoundError`) or unreadable (`NotReadableError`). A
 * test polling the file for the saved text hits that window, and `expect.poll`
 * does not retry a throwing callback — so a read racing a commit retries here
 * instead of failing the test. A file that stays missing still throws.
 */
export async function readOpfsFile(page: Page, name: string): Promise<number[]> {
  return page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory()
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await root.getFileHandle(n)
        const file = await handle.getFile()
        const buf = await file.arrayBuffer()
        return Array.from(new Uint8Array(buf))
      } catch (e) {
        const transient = e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'NotReadableError')
        if (!transient || attempt >= 50) throw e
        await new Promise((r) => setTimeout(r, 20))
      }
    }
  }, name)
}

/**
 * Writes raw bytes to an OPFS file directly, bypassing the app entirely —
 * for simulating another program/tab modifying the file on disk (e.g. a sync
 * client), independent of anything the app under test wrote. Real OPFS write
 * updates the file's `lastModified`, so this alone is enough to trigger
 * `src/core/fs.ts`'s `writeFile` external-change check.
 */
export async function writeOpfsFile(page: Page, name: string, bytes: number[]): Promise<void> {
  await page.evaluate(
    async ({ n, b }) => {
      const root = await navigator.storage.getDirectory()
      const handle = await root.getFileHandle(n, { create: true })
      const writable = await handle.createWritable()
      await writable.write(new Uint8Array(b))
      await writable.close()
    },
    { n: name, b: bytes }
  )
}

/** Whether an OPFS file with this name currently exists. */
export async function opfsFileExists(page: Page, name: string): Promise<boolean> {
  return page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory()
    try {
      await root.getFileHandle(n)
      return true
    } catch {
      return false
    }
  }, name)
}

// Self-contained for the same reason as installShimInPage above — no
// closures over this module's scope, since Playwright re-runs this as raw
// source in the page.
function removePickersInPage(): void {
  // `delete` (not `= undefined`) so `'showOpenFilePicker' in window` — the
  // exact feature-detection src/core/fs.ts's `supportsFsApi` uses — reads
  // false, same as a browser that never implemented the API at all.
  delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
}

/**
 * Forces the app's download-fallback path on Chromium by removing the
 * picker functions before any app code runs — same effect as running on a
 * browser without the File System Access API, without needing one.
 */
export async function forceFallbackMode(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(removePickersInPage)
}

function countWritesInPage(): void {
  window.__e2eFileWrites = {}
  const original = FileSystemFileHandle.prototype.createWritable
  FileSystemFileHandle.prototype.createWritable = function (this: FileSystemFileHandle, ...args: Parameters<typeof original>) {
    const counts = window.__e2eFileWrites!
    counts[this.name] = (counts[this.name] ?? 0) + 1
    return original.apply(this, args)
  }
}

/**
 * Counts every time the app opens a file for writing (`createWritable`), per file name, from the start of each page load.
 * It is what lets a spec say "the file was NOT rewritten" or "it was written exactly once", which the file's bytes alone
 * cannot (a rewrite of identical content is invisible there).
 */
export async function installFileWriteCounter(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(countWritesInPage)
}

export async function fileWrites(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => window.__e2eFileWrites?.[n] ?? 0, name)
}

function controlPermissionInPage(): void {
  window.__e2ePermission = 'granted'
  window.__e2eRegrants = 0
  FileSystemFileHandle.prototype.queryPermission = async () => window.__e2ePermission ?? 'granted'
  FileSystemFileHandle.prototype.requestPermission = async () => {
    window.__e2eRegrants = (window.__e2eRegrants ?? 0) + 1
    window.__e2ePermission = 'granted'
    return 'granted'
  }
}

/**
 * Makes the permission on every file handle scriptable: `setFilePermission(page, 'prompt')` is "the browser lost write
 * access" (the app's writes then fail with the real NotAllowedError its own check raises); a re-grant request flips it back.
 */
export async function installPermissionControl(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(controlPermissionInPage)
}

export async function setFilePermission(page: Page, state: 'granted' | 'prompt'): Promise<void> {
  await page.evaluate((v) => { window.__e2ePermission = v }, state)
}

export async function regrantRequests(page: Page): Promise<number> {
  return page.evaluate(() => window.__e2eRegrants ?? 0)
}
