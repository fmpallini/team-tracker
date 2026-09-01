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
import { readFileSync } from 'node:fs'
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

// Every test here loads /pwa/index.html and waits on a real service-worker
// registration; running them concurrently (with each other and with the rest of
// the suite) starves `navigator.serviceWorker.ready` off the single static
// server and flakes the banner-visible waits. Serialise the file — same guard
// leak.spec.ts / perf.spec.ts / split-view.spec.ts already use.
test.describe.configure({ mode: 'serial' })

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

// --- Window Controls Overlay: "Reload now" must sit clear of the OS caption strip ---
//
// Cover for commit 43a032e (fix(pwa): keep update banner clear of the
// window-controls overlay) and for the follow-up report that "Reload now" is
// still dead in the collapsed system bar. In display-mode:window-controls-overlay
// the browser paints its min/max/close caption buttons as a top-pinned overlay;
// pointer events over that strip never reach the page (styles.css:180-184), so
// the centred "Reload now" button was unclickable until styles.css offset the
// fixed banner by env(titlebar-area-height).
//
// LIMITATION: nothing headless can make `@media (display-mode:
// window-controls-overlay)` actually match. CDP's Emulation.setEmulatedMedia
// takes a `display-mode` feature but Chromium ignores it (verified: even
// `standalone` stays unmatched while `prefers-color-scheme` works), and there is
// no override for the env(titlebar-area-*) vars. A real installed PWA with WCO
// granted is the only way to exercise the true media block — see the fixme.
//
// So these tests split the concern: one asserts the shipped CSS rule is present
// and correct in the bundle, and the rest prove — in real Chromium, against a
// real pointer-eating overlay element — that the banner offset is what makes the
// difference between a clickable and a dead "Reload now".

/** The minified `@media (display-mode:window-controls-overlay)` block as it
 *  ships in the built PWA bundle (CSS is inlined into index.html). */
function bundledWcoMediaBlock(): string {
  const html = readFileSync(new URL('../dist/pwa/index.html', import.meta.url), 'utf8')
  const marker = 'display-mode:window-controls-overlay){'
  const start = html.indexOf(marker)
  expect(start, 'window-controls-overlay media block missing from the bundled PWA CSS').toBeGreaterThanOrEqual(0)
  return html.slice(start, start + 600)
}

/** Stand-in for what the real WCO media block does to the banner: push the
 *  fixed banner down by the caption-strip height. Injected directly because the
 *  media query itself cannot be made to match headless (see LIMITATION above).
 *  `px === 0` models the pre-fix / bug state (banner pinned to viewport top). */
async function forceBannerOffset(page: Page, px: number): Promise<void> {
  await page.addStyleTag({ content: `.tt-update-banner{top:${px}px!important}` })
}

/** Stand-in for the OS-drawn caption overlay: a top-pinned, opaque hit target.
 *  Chromium's real overlay swallows every pointer event over it; an appended
 *  div with the default `pointer-events: auto` does the same to Playwright's
 *  actionability hit test (elementFromPoint under it returns the strip, never
 *  the page). Transparent background — hit-testing does not care about alpha. */
async function addCaptionStrip(page: Page, heightPx: number): Promise<void> {
  await page.evaluate((h) => {
    const strip = document.createElement('div')
    strip.id = '__fakeWcoCaptionStrip'
    strip.style.cssText =
      `position:fixed;top:0;left:0;right:0;height:${h}px;z-index:2147483647;background:transparent`
    document.body.appendChild(strip)
  }, heightPx)
}

async function showUpdateBanner(page: Page): Promise<void> {
  await mockNewerVersionAvailable(page)
  await page.goto(`${E2E_BASE_URL}/pwa/index.html`)
  await page.evaluate(() => navigator.serviceWorker.ready)
  await expect(page.locator('.tt-update-banner')).toBeVisible()
}

test.describe('PWA update banner clears the window-controls-overlay caption strip', () => {
  test('the bundled PWA CSS offsets the update banner by the titlebar-area height', () => {
    const block = bundledWcoMediaBlock()
    // The fix: banner dropped below the caption strip, same env var .tt-header
    // uses to clear the same region, with the 2.5rem fallback for UAs that do
    // not expose the var.
    expect(block).toMatch(/\.tt-update-banner\{top:env\(titlebar-area-height,\s*2\.5rem\)\}/)
  })

  test('Reload now is hit-testable and navigates when the banner is offset below the caption strip', async ({ page }) => {
    await showUpdateBanner(page)

    // 2.5rem — the fallback the shipped media block resolves to on a UA with no
    // real titlebar-area-height (which is every headless run).
    const stripPx = await page.evaluate(
      () => Math.ceil(2.5 * parseFloat(getComputedStyle(document.documentElement).fontSize))
    )
    await forceBannerOffset(page, stripPx)
    await addCaptionStrip(page, stripPx)

    const reloadBtn = page.locator('.tt-update-banner').getByRole('button', { name: 'Reload now' })
    const box = await reloadBtn.boundingBox()
    expect(box).not.toBeNull()
    // Whole button below the strip, not just its centre.
    expect(box!.y).toBeGreaterThanOrEqual(stripPx)

    // Real Chromium hit test: the strip does not intercept this click.
    await Promise.all([page.waitForEvent('load'), reloadBtn.click()])
  })

  test('Reload now is dead under the caption strip when the banner is not offset (reproduces the bug)', async ({ page }) => {
    await showUpdateBanner(page)

    const stripPx = await page.evaluate(
      () => Math.ceil(2.5 * parseFloat(getComputedStyle(document.documentElement).fontSize))
    )
    await forceBannerOffset(page, 0) // pre-fix / bug state: banner pinned to viewport top
    await addCaptionStrip(page, stripPx)

    const reloadBtn = page.locator('.tt-update-banner').getByRole('button', { name: 'Reload now' })
    await expect(reloadBtn).toBeVisible() // renders fine…

    // …but the caption strip covers its click point, so the actionability hit
    // test never resolves — this is exactly what "Reload now isn't clickable"
    // looks like to Playwright and to a user.
    const rejected = await reloadBtn
      .click({ trial: true, timeout: 1500 })
      .then(() => null)
      .catch((e: Error) => e)
    expect(rejected, 'expected the caption strip to intercept the click').not.toBeNull()
    expect(rejected!.message).toMatch(/intercept|not receive pointer|Timeout/i)
    expect(page.url()).toContain('/pwa/index.html') // no navigation happened
  })

  // The real end-to-end: install the PWA, let the browser grant
  // window-controls-overlay, restore (un-maximise) the window so the caption
  // overlay is at its widest — the "collapsed system bar" from the report — and
  // click "Reload now" for real. Needs a genuine env(titlebar-area-height); CDP
  // exposes no override and no headless Chromium grants WCO, so this cannot run
  // here yet. Kept as an executable description of the scenario to automate once
  // an installed-PWA fixture exists.
  test.fixme('installed PWA, collapsed window-controls overlay: Reload now stays clickable', async ({ page }) => {
    await showUpdateBanner(page)
    const reloadBtn = page.locator('.tt-update-banner').getByRole('button', { name: 'Reload now' })
    await Promise.all([page.waitForEvent('load'), reloadBtn.click()])
  })
})
