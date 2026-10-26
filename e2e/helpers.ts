// e2e/helpers.ts — shared flows used across the e2e suite.
import type { Page, BrowserContext, Locator } from '@playwright/test'
import { expect } from '@playwright/test'

export async function createEncryptedDoc(page: Page, password: string): Promise<void> {
  await page.getByRole('button', { name: /Create new/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-password"]').fill(password)
  await dialog.locator('input[name="tt-password-confirm"]').fill(password)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('.tt-shell')).toBeVisible()
}

/** Lock/Close (the header lock button): writes the file now and returns to the start screen. */
export async function lockClose(page: Page): Promise<void> {
  await page.locator('.tt-btn-close-file').click()
  await expect(page.locator('.tt-start-screen')).toBeVisible()
}

/** Start screen -> "Reopen last" -> password -> the shell. */
export async function reopenLast(page: Page, password: string): Promise<void> {
  await page.getByRole('button', { name: /Reopen last/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-password"]').fill(password)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('.tt-shell')).toBeVisible()
}

/** Opens an existing password-less file from the start screen's "Reopen last" button. */
export async function reopenLastPlain(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Reopen last/ }).click()
  await expect(page.locator('.tt-shell')).toBeVisible()
}

/** Creates a password-less document ("Create without password") and waits for the shell. */
export async function createPlainDoc(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create new/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Create without password' }).click()
  await expect(page.locator('.tt-shell')).toBeVisible()
}

/**
 * Runs the flush a hiding or closing page triggers (`pagehide`: editors into the store, then the store into the browser
 * copy) and lets its commit land. The persister otherwise waits for a couple of seconds of quiet before it writes.
 */
export async function flushLiveCopy(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await page.waitForTimeout(400)
}

/**
 * Everything the browser's live database holds, flattened to one string of readable characters (keys, strings, and every
 * byte as a latin-1 character): what someone reading the browser profile off the disk could see. For asserting that an
 * encrypted document leaves no plaintext behind.
 */
export async function liveDatabaseDump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('team-tracker-live')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('open failed'))
    })
    const walk = (v: unknown): string => {
      if (ArrayBuffer.isView(v)) return String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
      if (Array.isArray(v)) return v.map(walk).join(' ')
      if (v && typeof v === 'object') return Object.entries(v).map(([k, x]) => k + ' ' + walk(x)).join(' ')
      return String(v)
    }
    let out = ''
    for (const name of Array.from(db.objectStoreNames)) {
      const tx = db.transaction(name, 'readonly')
      const store = tx.objectStore(name)
      const [keys, values]: [unknown[], unknown[]] = await Promise.all([
        new Promise<unknown[]>((res, rej) => { const r = store.getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error ?? new Error('keys')) }),
        new Promise<unknown[]>((res, rej) => { const r = store.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error ?? new Error('values')) }),
      ])
      out += `\n[${name}] ` + walk(keys) + ' ' + walk(values)
    }
    db.close()
    return out
  })
}

/** How many records and blobs the live database holds for the open document. */
export async function liveRowCounts(page: Page): Promise<{ records: number; blobs: number }> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('team-tracker-live')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('open failed'))
    })
    const count = (name: string): Promise<number> => new Promise((res, rej) => {
      const r = db.transaction(name, 'readonly').objectStore(name).count()
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error ?? new Error('count'))
    })
    const out = { records: await count('records'), blobs: await count('blobs') }
    db.close()
    return out
  })
}

/** Forgets the browser's copy of every document, as "clear site data" would: the next open can only use the file. */
export async function clearBrowserCopy(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('team-tracker-live')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('could not delete the live database'))
    req.onblocked = () => resolve()
  }))
}

/**
 * `src/main.ts` fires a real `fetch` to the GitHub releases API on every
 * boot (`runUpdateCheck`), unthrottled in a fresh browser context since
 * `localStorage`'s `LAST_CHECK_STORAGE_KEY` starts empty. Left alone, every
 * e2e run hits the live API — under a full parallel test run (or CI) that
 * reliably trips GitHub's unauthenticated rate limit, and Chromium logs a
 * "Failed to load resource: 403" console message for the failed fetch
 * *regardless* of how gracefully `checkForUpdate` handles the response,
 * which then fails any test asserting on `console` output (e.g.
 * smoke.spec.ts). Fulfilling with a synthetic "no update available" response
 * keeps the check's own code path real while decoupling every other test
 * from a flaky, rate-limited external dependency. Must be installed before
 * `goto` — call on the page (or context, for multi-page tests) before
 * navigating.
 */
export async function blockUpdateCheck(target: Page | BrowserContext): Promise<void> {
  await target.route('https://api.github.com/repos/**/releases/latest', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v0.0.1' }) })
  )
}

/**
 * Switches `pane` to the module called `name`, by whichever selector the pane's width shows: the module tabs when
 * they are laid out (their accessible name is the module's, also when only the icon is drawn), else the dropdown.
 */
export async function openModule(pane: Locator, name: string | RegExp): Promise<void> {
  const tab = pane.locator('button.tt-pane-tab:visible').and(pane.getByLabel(name)).first()
  if (await tab.count()) {
    await tab.click()
    return
  }
  await pane.locator('.tt-pane-modules-btn').click()
  await pane.locator('.tt-pane-menu-item', { hasText: name }).first().click()
}
