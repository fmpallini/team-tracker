// e2e/close-unsaved.spec.ts — closing a file must never discard edits whose
// final save did not land. main.ts's teardownApp() saves before tearing the
// document down; these cover the two ways that save can fail to persist
// (a write error, an external change) and assert the document stays open
// instead of silently returning to the start screen.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, readOpfsFile, writeOpfsFile, setNextOpenName } from './opfs-shim'
import { blockUpdateCheck } from './helpers'
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
  await pane.locator('.tt-pane-modules-btn').click()
  await pane.locator('.tt-pane-menu-item', { hasText: /Daily/i }).first().click()
  await pane.locator('.editor').first().click()
  await page.keyboard.type(MARKER)
}

async function diskText(page: Page): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await readOpfsFile(page, FILE)))
}

test.describe('closing a file whose final save fails', () => {
  test('a write error keeps the document open and asks before discarding', async ({ page }) => {
    await openSeededDoc(page)
    // Simulates a file locked by another process / a full disk.
    await page.evaluate(() => {
      ;(FileSystemFileHandle.prototype as unknown as { createWritable: () => Promise<never> }).createWritable = async () => {
        throw new DOMException('locked', 'NoModificationAllowedError')
      }
    })

    await page.locator('.tt-btn-close-file').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(/not saved/i)
    await expect(page.locator('.tt-shell')).toBeVisible()
    await expect(page.locator('.tt-start-screen')).toHaveCount(0)

    // Keeping it open leaves the edit in place for another attempt.
    await dialog.getByRole('button', { name: /Keep open/i }).click()
    await expect(page.locator('.tt-pane[data-pane-idx="0"] .editor').first()).toContainText(MARKER)

    // Discarding is an explicit, separate choice.
    await page.locator('.tt-btn-close-file').click()
    await page.getByRole('dialog').getByRole('button', { name: /Close without saving/i }).click()
    await expect(page.locator('.tt-start-screen')).toBeVisible()
    expect(await diskText(page)).not.toContain(MARKER)
  })

  test('an external change keeps the document open behind the conflict dialog', async ({ page }) => {
    await openSeededDoc(page)
    await page.waitForTimeout(400) // let the debounced edit reach the store
    // A sync client rewriting the same bytes still moves lastModified.
    const cur = await readOpfsFile(page, FILE)
    await page.waitForTimeout(20)
    await writeOpfsFile(page, FILE, cur)

    await page.locator('.tt-btn-close-file').click()

    await expect(page.getByRole('dialog')).toContainText(/changed externally/i)
    await expect(page.locator('.tt-shell')).toBeVisible()
    await expect(page.locator('.tt-start-screen')).toHaveCount(0)

    await page.getByRole('button', { name: /Overwrite/i }).click()
    await expect.poll(() => diskText(page)).toContain(MARKER)
  })
})
