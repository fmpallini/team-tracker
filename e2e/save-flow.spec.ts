// e2e/save-flow.spec.ts — the save model end to end: the browser holds the live
// copy of the document and the file is written at open, at Lock/Close and on a
// timer, not on every change. Real OPFS file, real IndexedDB, real reload.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, readOpfsFile } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck, lockClose, reopenLast, clearBrowserCopy } from './helpers'

const PASSWORD = 'e2e-save-flow-password'

async function addTeam(page: Page, name: string, first: boolean): Promise<void> {
  await (first ? page.getByRole('button', { name: /Create first team/ }) : page.locator('.tt-team-add-btn')).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-team-name"]').fill(name)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(dialog).toBeHidden()
}

const diskBytes = async (page: Page): Promise<number[]> => Array.from(await readOpfsFile(page, 'team-tracker.tmv'))

test.describe('save flow', () => {
  test('an edit is kept in the browser at once: a page reload brings it back although the file was not rewritten', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)
    await expect(page.locator('.tt-save-pill[data-state="ok"]')).toBeVisible()
    const fileAtOpen = await diskBytes(page)

    await addTeam(page, 'Save Flow Team', true)
    // The file is not what holds an edit any more, so nothing is "unsaved" and nothing was written.
    await expect(page.locator('.tt-save-pill[data-state="ok"]')).toBeVisible()
    await page.waitForTimeout(700) // the persister's debounce, plus slack
    expect(await diskBytes(page)).toEqual(fileAtOpen)

    await page.reload()
    await expect(page.locator('.tt-start-screen')).toBeVisible()
    await reopenLast(page, PASSWORD)
    // The file still has no team: this one came from the browser's copy, and opening it rewrote the file.
    await expect(page.locator('.tt-team-item .tt-team-name')).toHaveText('Save Flow Team')
    await expect.poll(async () => (await diskBytes(page)).length).not.toBe(fileAtOpen.length)
  })

  test('Lock/Close writes the file: with the browser copy cleared, the edit is still there', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)
    await addTeam(page, 'Written At Close', true)

    await lockClose(page)
    await clearBrowserCopy(page)
    await reopenLast(page, PASSWORD)

    await expect(page.locator('.tt-team-item .tt-team-name')).toHaveText('Written At Close')
  })

  test('the Ctrl+S chord does nothing and the browser save dialog never opens', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)
    await addTeam(page, 'No Manual Save', true)
    const before = await diskBytes(page)

    const prevented = await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })
      document.dispatchEvent(ev)
      return ev.defaultPrevented
    })

    expect(prevented).toBe(true)
    await page.waitForTimeout(300)
    expect(await diskBytes(page)).toEqual(before)
  })
})
