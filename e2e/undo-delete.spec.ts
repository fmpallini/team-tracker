// e2e/undo-delete.spec.ts — proves the undo-on-delete wiring end to end in a
// real browser: the toast, its ten-second action button, and the restore
// actually putting a deleted team back into the sidebar at its original
// position, as the active team, with its content intact. A shallow restore
// (e.g. one that only re-inserts an empty team, or drops it at the end of
// the list, or leaves some other team active) fails this test.
import { test, expect } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

test.describe('undo on delete', () => {
  const PASSWORD = 'e2e-undo-password'

  test('deleting a team offers an undo that restores its position, active state, and content', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    // First team — this is the one we'll delete and restore.
    await page.getByRole('button', { name: /Create first team/ }).click()
    const createDialog = page.getByRole('dialog')
    await createDialog.locator('input[name="tt-team-name"]').fill('Doomed Team')
    await createDialog.getByRole('button', { name: 'OK' }).click()
    await expect(createDialog).toBeHidden()

    // Give it distinctive daily-notes content a shallow restore would lose.
    const editor = page.locator('.editor').first()
    await editor.click()
    await page.keyboard.type('Doomed content')
    await page.waitForTimeout(400) // let the 300ms debounced commit (scheduleChange) settle

    // Second team — created after, so it becomes active and sits after
    // "Doomed Team" in the list. Restoring "Doomed Team" must put it back
    // BEFORE "Safe Team" and hand active status back to it, not just make it
    // reappear somewhere.
    await page.locator('.tt-team-add-btn').click()
    const addDialog = page.getByRole('dialog')
    await addDialog.locator('input[name="tt-team-name"]').fill('Safe Team')
    await addDialog.getByRole('button', { name: 'OK' }).click()
    await expect(addDialog).toBeHidden()

    const teamItems = page.locator('.tt-team-item')
    await expect(teamItems).toHaveCount(2)
    await expect(teamItems.nth(0).locator('.tt-team-name')).toHaveText('Doomed Team')
    await expect(teamItems.nth(1).locator('.tt-team-name')).toHaveText('Safe Team')

    // Re-select "Doomed Team" so it's the active team going into the delete.
    await teamItems.nth(0).click()
    await expect(teamItems.nth(0)).toHaveClass(/active/)

    // Open its edit modal via the row's pencil button — sidebar rows have no
    // dblclick handler (a plain click on the row just selects the team); the
    // edit modal opens from `.tt-team-edit-btn` (src/ui/sidebar.ts).
    await teamItems.nth(0).locator('.tt-team-edit-btn').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await expect(page.locator('.tt-team-item')).toHaveCount(1)
    await expect(page.locator('.tt-team-item .tt-team-name')).toHaveText('Safe Team')

    const undo = page.locator('.tt-toast-action')
    await expect(undo).toHaveText('Undo')
    await undo.click()

    const restoredItems = page.locator('.tt-team-item')
    await expect(restoredItems).toHaveCount(2)
    // Original position: "Doomed Team" back at index 0, before "Safe Team".
    await expect(restoredItems.nth(0).locator('.tt-team-name')).toHaveText('Doomed Team')
    await expect(restoredItems.nth(1).locator('.tt-team-name')).toHaveText('Safe Team')
    // Restored as the active team, since it was active when deleted.
    await expect(restoredItems.nth(0)).toHaveClass(/active/)

    // Content intact — and the active pane switched back on its own (no
    // click here), proving the restore re-synced pane navigation too.
    await expect(page.locator('.editor').first()).toContainText('Doomed content')
  })
})
