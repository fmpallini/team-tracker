// e2e/launch-queue-shim.ts — Playwright can't simulate an OS-level "open
// with" / double-click launch (src/ui/start.ts's window.launchQueue
// consumer, Chromium's File Handling API, PWA-installed only). This captures
// the consumer function the app registers at boot so a test can invoke it
// directly with a real OPFS FileSystemFileHandle (see opfs-shim.ts) — same
// shape the real API would hand the app, just triggered by the test instead
// of the OS.
import type { Page, BrowserContext } from '@playwright/test'

interface FileHandlingLaunchParams {
  files: FileSystemFileHandle[]
}

declare global {
  interface Window {
    __launchConsumer?: (launchParams: FileHandlingLaunchParams) => void
  }
}

// Self-contained — Playwright serializes this via Function.prototype.toString()
// and runs it in the page, so it cannot close over this module's scope.
//
// window.launchQueue is a getter-only accessor (Window.launchQueue's IDL is
// `readonly attribute LaunchQueue`) — `window.launchQueue = {...}` silently
// no-ops in sloppy-mode scripts (verified: reading it straight back afterward
// still returns the original native LaunchQueue instance, not the
// assignment). The real instance's own setConsumer lives on its prototype,
// which IS an ordinary writable/configurable method — patching that instead
// captures every consumer registered against the real object without
// touching the read-only binding itself.
function installShimInPage(): void {
  const lq = window.launchQueue
  if (!lq) return
  const proto = Object.getPrototypeOf(lq) as { setConsumer: typeof lq.setConsumer }
  proto.setConsumer = (consumer) => {
    window.__launchConsumer = consumer
  }
}

/** Installs the capture as an init script — must run before src/ui/start.ts's own `window.launchQueue?.setConsumer(...)` call, i.e. before `goto`. */
export async function installLaunchQueueCapture(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(installShimInPage)
}

/** Simulates an OS "open with .tmv" launch (or a File Handling API re-launch while already open) by invoking the captured consumer with a real OPFS file handle. */
export async function relaunchWithFile(page: Page, name: string): Promise<void> {
  await page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(n)
    window.__launchConsumer?.({ files: [handle] })
  }, name)
}
