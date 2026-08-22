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

  // "Reopen last file" is hidden from regular users by default (src/ui/
  // start.ts's SHOW_REOPEN_KEY) — revealed here so specs can drive that real
  // flow the same way a developer would via the console (ttShowReopenButton),
  // just without its location.reload() round trip.
  try {
    localStorage.setItem('tt-show-reopen', '1')
  } catch {
    // ignore — matches start.ts's own best-effort localStorage handling
  }

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

/** Reads an OPFS file's raw bytes directly — for asserting on what the app actually wrote to disk (e.g. the backup mirror), independent of app-level UI state. */
export async function readOpfsFile(page: Page, name: string): Promise<number[]> {
  return page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(n)
    const file = await handle.getFile()
    const buf = await file.arrayBuffer()
    return Array.from(new Uint8Array(buf))
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
