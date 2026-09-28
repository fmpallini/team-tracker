// e2e/tab-takeover.spec.ts — what a read-only tab shows and accepts, and
// what it works on after "Take control". tab-lock.spec.ts covers the lock
// handoff itself; this covers the document content on either side of it.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, readOpfsFile, writeOpfsFile, setNextOpenName } from './opfs-shim'
import { blockUpdateCheck } from './helpers'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'

const FILE = 'team-tracker.tmv'

async function openDaily(page: Page): Promise<void> {
  await setNextOpenName(page, FILE)
  await page.getByRole('button', { name: /Open/ }).first().click()
  await expect(page.locator('.tt-shell')).toBeVisible()
  const pane = page.locator('.tt-pane[data-pane-idx="0"]')
  await pane.locator('.tt-pane-modules-btn').click()
  await pane.locator('.tt-pane-menu-item', { hasText: /Daily/i }).first().click()
  await expect(pane.locator('.editor').first()).toBeVisible()
}

function editor(page: Page) {
  return page.locator('.tt-pane[data-pane-idx="0"] .editor').first()
}

test('a read-only tab takes no typing, and "Take control" picks up the other tab\'s saved edits', async ({ page: a, context }) => {
  await installOpfsPickerShim(context)
  await blockUpdateCheck(context)
  await a.goto(`${E2E_BASE_URL}/app.html`)
  const doc = createEmptyDocument('en-US')
  doc.teams.push(createEmptyTeam('t1', 'T1', '🚀', 'en-US'))
  doc.nav.activeTeamId = 't1'
  await writeOpfsFile(a, FILE, Array.from(new TextEncoder().encode('TMV-PLAIN\n' + JSON.stringify(doc))))
  await openDaily(a)

  const b = await context.newPage()
  await b.goto(`${E2E_BASE_URL}/app.html`)
  await openDaily(b)
  await expect(b.locator('.tt-readonly-banner')).toBeVisible()

  // Read-only: the editor refuses input, and browsing leaves nothing "unsaved".
  await expect(editor(b)).toHaveAttribute('contenteditable', 'false')
  await editor(b).click()
  await b.keyboard.type('TYPED-WHILE-READONLY')
  await expect(editor(b)).not.toContainText('TYPED-WHILE-READONLY')
  expect(await b.title()).not.toContain('●')

  // A edits and saves while B sits read-only on its older copy.
  await editor(a).click()
  await a.keyboard.type('EDIT-FROM-A')
  await a.waitForTimeout(400)
  await a.keyboard.press('Control+s')
  await expect.poll(async () => new TextDecoder().decode(new Uint8Array(await readOpfsFile(a, FILE)))).toContain('EDIT-FROM-A')

  await b.locator('.tt-readonly-takeover-btn').click()
  await expect(b.locator('.tt-readonly-banner')).toHaveCount(0)
  await expect(editor(b)).toContainText('EDIT-FROM-A')
  await expect(editor(b)).toHaveAttribute('contenteditable', 'true')

  // B's own save now lands cleanly — no external-change conflict.
  await editor(b).click()
  await b.keyboard.press('Control+End')
  await b.keyboard.type(' EDIT-FROM-B')
  await b.waitForTimeout(400)
  await b.keyboard.press('Control+s')
  await expect.poll(async () => new TextDecoder().decode(new Uint8Array(await readOpfsFile(b, FILE)))).toContain('EDIT-FROM-B')
  await expect(b.getByRole('dialog')).toHaveCount(0)
  const disk = new TextDecoder().decode(new Uint8Array(await readOpfsFile(b, FILE)))
  expect(disk).toContain('EDIT-FROM-A')
  await b.close()
})
