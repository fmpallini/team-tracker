// e2e/close-pending.spec.ts — closing the tab the instant after typing. The flush a closing page starts is asynchronous
// (row keys and seals come from crypto.subtle before the IndexedDB transaction opens), and a tab closed without a prompt
// was often gone before it landed: the last edit was lost without a word (most runs of the password-less case, some of
// the encrypted one). core/close-document.ts's beforeunload handler now asks while that write is pending; the prompt keeps
// the page alive long enough for it to land.
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { blockUpdateCheck, createEncryptedDoc, createPlainDoc, reopenLast, reopenLastPlain, openModule } from './helpers'

const PASSWORD = 'e2e-close-pending'
const MARKER = 'TYPED-RIGHT-BEFORE-CLOSING'

async function freshPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  return page
}

/** A team with its daily note open, every earlier write landed, then MARKER typed and the tab closed at once. */
async function typeAndClose(page: Page): Promise<string[]> {
  await page.getByRole('button', { name: /Create first team/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-team-name"]').fill('Team A')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  const pane = page.locator('.tt-pane[data-pane-idx="0"]')
  await openModule(pane, /Daily/i)
  await page.waitForTimeout(2_500) // the team's own write lands first: only the typed text is pending
  await pane.locator('.editor').first().click()
  await page.keyboard.type(MARKER)
  const prompts: string[] = []
  page.on('dialog', (d) => {
    prompts.push(d.type())
    setTimeout(() => void d.accept(), 1_000) // the user reads the prompt for a moment, then leaves anyway
  })
  await page.close({ runBeforeUnload: true })
  await page.waitForEvent('close')
  return prompts
}

const editorText = (page: Page) => page.locator('.tt-pane[data-pane-idx="0"] .editor').first()

test.describe('closing the tab right after typing', () => {
  test('encrypted: the page asks, and the edit survives', async ({ context }) => {
    const page = await freshPage(context)
    await createEncryptedDoc(page, PASSWORD)
    expect(await typeAndClose(page)).toEqual(['beforeunload'])
    const again = await freshPage(context)
    await reopenLast(again, PASSWORD)
    await expect(editorText(again)).toContainText(MARKER)
  })

  test('password-less: the page asks, and the edit survives', async ({ context }) => {
    const page = await freshPage(context)
    await createPlainDoc(page)
    expect(await typeAndClose(page)).toEqual(['beforeunload'])
    const again = await freshPage(context)
    await reopenLastPlain(again)
    await expect(editorText(again)).toContainText(MARKER)
  })
})
