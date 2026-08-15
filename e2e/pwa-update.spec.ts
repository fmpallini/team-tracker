// e2e/pwa-update.spec.ts — src/main.ts's reloadForUpdate() and
// ensureServiceWorkerReady() only ever run in the PWA build variant
// (dist/pwa/, __PWA__ true) — the plain dist/app.html served by every other
// e2e spec never shows the update banner's real "Reload now" action at all
// (see ui/update-notice.ts's pwa/standalone branch), so this is the one spec
// that navigates to /pwa/index.html instead. e2e/static-server.mjs already
// serves the whole dist/ tree, so no new webServer config is needed — just a
// different path. A real service worker registers here (Chromium treats
// localhost as a secure context), which is also what ensureServiceWorkerReady
// needs to be worth testing for real.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc } from './helpers'

/** Fulfills the GitHub releases check with a version newer than package.json's, so the update banner actually shows (unlike helpers.ts's blockUpdateCheck, which reports "up to date"). */
async function mockNewerVersionAvailable(page: Page): Promise<void> {
  await page.route('https://api.github.com/repos/**/releases/latest', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v99.0.0' }) })
  )
}

/** Records every real `ServiceWorkerRegistration.update()` call so a test can prove ensureServiceWorkerReady() actually forces one — independent of the boot-time `register()` call, which never calls `.update()` itself. */
function installSwUpdateSpyInPage(): void {
  const proto = window.ServiceWorkerRegistration?.prototype
  if (!proto) return
  const original = proto.update
  window.__swUpdateCalls = 0
  proto.update = function (this: ServiceWorkerRegistration, ...args: []) {
    window.__swUpdateCalls = (window.__swUpdateCalls ?? 0) + 1
    return original.apply(this, args)
  }
}

/** Lets a test force the next `FileSystemFileHandle.createWritable()` call to fail, simulating a real write error (e.g. disk/permission failure) without touching app code. */
function installWritePoisonInPage(): void {
  const proto = window.FileSystemFileHandle?.prototype
  if (!proto) return
  const original = proto.createWritable
  window.__poisonNextWrite = false
  proto.createWritable = function (this: FileSystemFileHandle, ...args: unknown[]) {
    if (window.__poisonNextWrite) {
      window.__poisonNextWrite = false
      return Promise.reject(new Error('e2e: simulated write failure'))
    }
    return original.apply(this, args as never)
  }
}

declare global {
  interface Window {
    __swUpdateCalls?: number
    __poisonNextWrite?: boolean
  }
}

test.describe('PWA update banner (src/main.ts reloadForUpdate / ensureServiceWorkerReady)', () => {
  test('Reload now: forces a real service-worker update check, then saves and navigates away', async ({ page }) => {
    await page.addInitScript(installSwUpdateSpyInPage)
    await mockNewerVersionAvailable(page)
    await page.goto(`${E2E_BASE_URL}/pwa/index.html`)

    // Real SW registration (main.ts's boot-time register()) has to land
    // before ensureServiceWorkerReady's own registration.update() call has
    // anything to act on.
    await page.evaluate(() => navigator.serviceWorker.ready)

    const banner = page.locator('.tt-update-banner')
    await expect(banner).toBeVisible()
    // ensureServiceWorkerReady() ran as part of showing this banner and
    // called registration.update() itself — not just relying on whatever the
    // boot-time register() call happens to do on its own schedule.
    await expect.poll(() => page.evaluate(() => window.__swUpdateCalls ?? 0)).toBeGreaterThan(0)

    const reloadBtn = banner.getByRole('button', { name: 'Reload now' })
    await expect(reloadBtn).toBeEnabled()
    await Promise.all([page.waitForEvent('load'), reloadBtn.click()])
  })

  test('Reload now aborts (no navigation) when the pre-reload save fails and the document is still dirty', async ({ page }) => {
    await installOpfsPickerShim(page)
    await page.addInitScript(installWritePoisonInPage)
    await mockNewerVersionAvailable(page)
    await page.goto(`${E2E_BASE_URL}/pwa/index.html`)

    // Checked before the (slow — real 600k-iteration PBKDF2) doc creation
    // below: the banner's own timing depends only on the mocked fetch
    // resolving, not on anything document-related, so asserting it early
    // keeps this from flaking under parallel worker load.
    const banner = page.locator('.tt-update-banner')
    await expect(banner).toBeVisible()
    await page.evaluate(() => navigator.serviceWorker.ready)

    const PASSWORD = 'e2e-pwa-update-password'
    await createEncryptedDoc(page, PASSWORD)
    await page.locator('.tt-team-add-btn').click()
    const teamDialog = page.getByRole('dialog')
    await teamDialog.locator('input[name="tt-team-name"]').fill('Alpha')
    await teamDialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.locator('.tt-save-pill[data-state="dirty"]')).toBeVisible()

    await page.evaluate(() => {
      window.__poisonNextWrite = true
    })
    const reloadBtn = banner.getByRole('button', { name: 'Reload now' })
    await reloadBtn.click()

    // reloadForUpdate's saveNow()+flush() ran, the write failed, dirty never
    // cleared — the reload it guards must not have happened. Same page, same
    // document, still dirty; the button re-enables once reloadForUpdate's
    // promise settles (see update-notice.ts's onclick .finally()).
    await expect(page.locator('.tt-shell')).toBeVisible()
    await expect(page.locator('.tt-save-pill[data-state="dirty"], .tt-save-pill[data-state="error"]')).toBeVisible()
    await expect(reloadBtn).toBeEnabled()
    expect(page.url()).toContain('/pwa/index.html')
  })
})
