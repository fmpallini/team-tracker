// e2e/link-insert.spec.ts — the link modal (src/ui/editor.ts insertLink,
// opened with Ctrl+K) submitted with the Enter key. Regression: the generic
// modal (src/ui/modal.ts) fired its primary action on Enter without
// preventDefault, so after the modal closed and insertLink (a microtask
// later) focused the editor and spliced in the link, the browser's own
// default Enter then ran on the now-focused contenteditable and split off a
// stray empty paragraph — leaving the caret on a blank line, adrift from
// the link the user had just made. Needs a real browser: jsdom has no
// contenteditable editing model and no default-Enter behaviour to leak.
import { test, expect } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

test('Ctrl+K link modal submitted with Enter inserts the link without a stray paragraph', async ({ page }) => {
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await createEncryptedDoc(page, 'e2e-link-insert-pw')

  await page.getByRole('button', { name: /Create first team/ }).click()
  const teamDialog = page.getByRole('dialog')
  await teamDialog.locator('input[name="tt-team-name"]').fill('T')
  await teamDialog.getByRole('button', { name: 'OK' }).click()
  await teamDialog.waitFor({ state: 'hidden' })

  const editor = page.locator('.editor').first()
  await editor.click()

  await page.keyboard.press('Control+k')
  const dlg = page.getByRole('dialog')
  await dlg.locator('input[name="tt-link-text"]').fill('casa')
  await dlg.locator('input[name="tt-link-url"]').click()
  await page.keyboard.type('g1.com.br')
  await page.keyboard.press('Enter') // submit the modal from the URL field
  await dlg.waitFor({ state: 'hidden' })

  const result = await page.evaluate(() => {
    const ed = document.querySelector('.editor') as HTMLElement
    const sel = getSelection()!
    return {
      blocks: ed.childNodes.length,
      hasEmptyTrailingBlock: !!(ed.lastElementChild && ed.lastElementChild.textContent === '' && ed.children.length > 1),
      href: ed.querySelector('a[href]')?.getAttribute('href') ?? null,
      linkText: ed.querySelector('a[href]')?.textContent ?? null,
      caretInLinkBlock: !!ed.querySelector('a[href]')?.closest('div')?.contains(sel.focusNode),
    }
  })

  expect(result.href).toBe('https://g1.com.br')
  expect(result.linkText).toBe('casa')
  expect(result.blocks).toBe(1) // no stray empty paragraph split off by a leaked Enter
  expect(result.hasEmptyTrailingBlock).toBe(false)
  expect(result.caretInLinkBlock).toBe(true) // caret stays with the link, not adrift on a blank line
})
