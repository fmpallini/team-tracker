// e2e/helpers.ts — shared flows used by both fs-api.spec.ts and
// tab-lock.spec.ts (both require the OPFS picker shim, see opfs-shim.ts).
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

export async function createEncryptedDoc(page: Page, password: string): Promise<void> {
  await page.getByRole('button', { name: /Create new/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-password"]').fill(password)
  await dialog.locator('input[name="tt-password-confirm"]').fill(password)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('.tt-shell')).toBeVisible()
}
