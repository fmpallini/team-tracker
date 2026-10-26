// e2e/close-unsaved.spec.ts — Lock/Close writes the file, and when it cannot the
// document must not silently go away. core/close-document.ts writes before it
// tears the document down; these cover the two ways that write can fail
// (a write error, an external change) and assert the document stays open
// behind a dialog that says why, instead of returning to the start screen.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, readOpfsFile, writeOpfsFile, setNextOpenName } from './opfs-shim'
import { blockUpdateCheck, openModule } from './helpers'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'

const FILE = 'team-tracker.tmv'
const MARKER = 'IMPORTANT-UNSAVED-NOTE'

async function openSeededDoc(page: Page): Promise<void> {
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  const doc = createEmptyDocument('en-US')
  doc.teams.push(createEmptyTeam('t1', 'T1', '🚀', 'en-US'))
  doc.nav.activeTeamId = 't1'
  await writeOpfsFile(page, FILE, Array.from(new TextEncoder().encode('TMV-PLAIN\n' + JSON.stringify(doc))))
  await setNextOpenName(page, FILE)
  await page.getByRole('button', { name: /Open/ }).first().click()
  await expect(page.locator('.tt-shell')).toBeVisible()
  const pane = page.locator('.tt-pane[data-pane-idx="0"]')
  await openModule(pane, /Daily/i)
  await pane.locator('.editor').first().click()
  await page.keyboard.type(MARKER)
}

async function diskText(page: Page): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await readOpfsFile(page, FILE)))
}

test.describe('closing a file whose final write fails', () => {
  test('a write error keeps the document open and offers a way out', async ({ page }) => {
    await openSeededDoc(page)
    // Simulates a file locked by another process / a full disk.
    await page.evaluate(() => {
      ;(FileSystemFileHandle.prototype as unknown as { createWritable: () => Promise<never> }).createWritable = async () => {
        throw new DOMException('locked', 'NoModificationAllowedError')
      }
    })

    await page.locator('.tt-btn-close-file').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(/could not be written/i)
    await expect(dialog.getByRole('button', { name: /Download a copy/i })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Try again/i })).toBeVisible()
    await expect(page.locator('.tt-shell')).toBeVisible()
    await expect(page.locator('.tt-start-screen')).toHaveCount(0)

    // Cancelling leaves the edit in place for another attempt.
    await dialog.getByRole('button', { name: /^Cancel$/i }).click()
    await expect(page.locator('.tt-pane[data-pane-idx="0"] .editor').first()).toContainText(MARKER)

    // Leaving the file behind is an explicit, separate choice — the browser keeps the work.
    await page.locator('.tt-btn-close-file').click()
    await page.getByRole('dialog').getByRole('button', { name: /Close anyway/i }).click()
    await expect(page.locator('.tt-start-screen')).toBeVisible()
    expect(await diskText(page)).not.toContain(MARKER)
  })

  test('an external change keeps the document open behind the conflict dialog', async ({ page }) => {
    await openSeededDoc(page)
    await page.waitForTimeout(400) // let the debounced edit reach the store
    // Another program really changes the file (a trailing newline is enough: the
    // bytes differ). A sync client merely re-touching identical bytes is NOT a
    // conflict any more — see external-change.spec.ts.
    const cur = await readOpfsFile(page, FILE)
    await page.waitForTimeout(20)
    await writeOpfsFile(page, FILE, [...cur, 10])

    await page.locator('.tt-btn-close-file').click()

    await expect(page.getByRole('dialog')).toContainText(/changed externally/i)
    await expect(page.locator('.tt-shell')).toBeVisible()
    await expect(page.locator('.tt-start-screen')).toHaveCount(0)

    await page.getByRole('button', { name: /Overwrite/i }).click()
    await expect.poll(() => diskText(page)).toContain(MARKER)
  })
})
