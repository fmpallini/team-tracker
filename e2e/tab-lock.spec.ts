// e2e/tab-lock.spec.ts — proves core/tab-lock.ts's Task 25 cross-tab
// coordination against the REAL browser Web Locks API + BroadcastChannel,
// not the fake LockManager test/tab-lock.test.ts uses (jsdom has no Web
// Locks API at all). Two pages in the same browser context share the same
// origin — same navigator.locks namespace, same BroadcastChannel, same
// IndexedDB — exactly like two real tabs of the same browser open on the
// same file.
import { test, expect } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

test.describe('cross-tab single-writer lock', () => {
  const PASSWORD = 'e2e-tab-lock-password'

  test('a second tab opening the same file goes read-only; "Take control" hands write access back', async ({ page: pageA, context }) => {
    // Context-level (not page-level): applies to pageB too, opened below.
    await installOpfsPickerShim(context)
    await blockUpdateCheck(context)

    await pageA.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(pageA, PASSWORD)
    // Tab A now holds the write lock — see core/tab-lock.ts's requestLock(false).
    await expect(pageA.locator('.tt-readonly-banner')).toHaveCount(0)

    const pageB = await context.newPage()
    await pageB.goto(`${E2E_BASE_URL}/app.html`)
    await expect(pageB.getByRole('button', { name: /Reopen last/ })).toBeVisible()
    await pageB.getByRole('button', { name: /Reopen last/ }).click()
    const dialog = pageB.getByRole('dialog')
    await dialog.locator('input[name="tt-password"]').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(pageB.locator('.tt-shell')).toBeVisible()

    // B sees the lock already held by A: goes read-only, shows the banner.
    const banner = pageB.locator('.tt-readonly-banner')
    await expect(banner).toBeVisible()
    await expect(pageA.locator('.tt-readonly-banner')).toHaveCount(0)

    // B requests "take control" — real BroadcastChannel message to A, which
    // saves+flushes (Task 25 fix #4) before releasing the real Web Lock.
    await banner.locator('.tt-readonly-takeover-btn').click()

    await expect(pageA.locator('.tt-readonly-banner')).toBeVisible()
    await expect(pageB.locator('.tt-readonly-banner')).toHaveCount(0)

    await pageB.close()
  })
})
