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

test('a read-only tab takes no typing, and "Take control" picks up the other tab\'s edits from the browser copy', async ({ page: a, context }) => {
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

  // A edits while B sits read-only on its older copy. Nothing is written to the file: the browser copy carries it.
  await editor(a).click()
  await a.keyboard.type('EDIT-FROM-A')
  await a.waitForTimeout(400)

  await b.locator('.tt-readonly-takeover-btn').click()
  await expect(b.locator('.tt-readonly-banner')).toHaveCount(0)
  await expect(editor(b)).toContainText('EDIT-FROM-A')
  await expect(editor(b)).toHaveAttribute('contenteditable', 'true')
  const onDisk = async (): Promise<string> => new TextDecoder().decode(new Uint8Array(await readOpfsFile(b, FILE)))
  expect(await onDisk()).not.toContain('EDIT-FROM-A')

  // B's own edits land on top of A's, with no conflict dialog and none of A's work lost.
  await editor(b).click()
  await b.keyboard.press('Control+End')
  await b.keyboard.type(' EDIT-FROM-B')
  await b.waitForTimeout(400)
  await expect(editor(b)).toContainText('EDIT-FROM-A')
  await expect(editor(b)).toContainText('EDIT-FROM-B')
  await expect(b.getByRole('dialog')).toHaveCount(0)

  // Lock/Close in the tab that now holds the lock writes everything to the file.
  await b.locator('.tt-btn-close-file').click()
  await expect.poll(onDisk).toContain('EDIT-FROM-B')
  expect(await onDisk()).toContain('EDIT-FROM-A')
  await b.close()
})

async function twoTabs(context: import('@playwright/test').BrowserContext, a: Page): Promise<Page> {
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
  return b
}

test('keystrokes typed just before another tab takes control are kept, not dropped', async ({ page: a, context }) => {
  const b = await twoTabs(context, a)

  await editor(a).click()
  await a.keyboard.type('JUST-TYPED')
  // No wait: the editor's debounce has not necessarily fired when B asks.
  await b.locator('.tt-readonly-takeover-btn').click()

  await expect(b.locator('.tt-readonly-banner')).toHaveCount(0)
  await expect(editor(b)).toContainText('JUST-TYPED')
  await b.close()
})

test('a holder that cannot store its edits in the browser keeps control, says so, and hands over once asked again after the problem is gone', async ({ page: a, context }) => {
  const b = await twoTabs(context, a)

  await editor(a).click()
  await a.keyboard.type('NOT-STORED-IN-A')
  await a.waitForTimeout(400)
  // The browser refuses A's next write (a full disk, say): the edit exists only in A's memory.
  await a.evaluate(() => {
    const w = window as unknown as { __origPut?: unknown }
    w.__origPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function () { throw new DOMException('full', 'QuotaExceededError') }
  })
  await editor(a).click()
  await a.keyboard.type('-AND-MORE')
  await a.waitForTimeout(700)

  await b.locator('.tt-readonly-takeover-btn').click()

  // A could not hand the edit over: it keeps the lock and its edits, B stays read-only.
  await expect(a.locator('.tt-toast', { hasText: /could not store/i })).toBeVisible()
  await expect(a.locator('.tt-readonly-banner')).toHaveCount(0)
  await expect(editor(a)).toHaveAttribute('contenteditable', 'true')
  await expect(b.locator('.tt-readonly-banner')).toBeVisible()

  // The problem goes away; B asks again and now gets everything.
  await a.evaluate(() => {
    const w = window as unknown as { __origPut: typeof IDBObjectStore.prototype.put }
    IDBObjectStore.prototype.put = w.__origPut
  })
  await b.locator('.tt-readonly-takeover-btn').click()
  await expect(b.locator('.tt-readonly-banner')).toHaveCount(0)
  await expect(editor(b)).toContainText('NOT-STORED-IN-A-AND-MORE')
  await expect(a.locator('.tt-readonly-banner')).toBeVisible()
  await b.close()
})

test('double-clicking "Take control" does not leave a request that steals the lock back later', async ({ page: a, context }) => {
  const b = await twoTabs(context, a)

  await b.locator('.tt-readonly-takeover-btn').dblclick()
  await expect(b.locator('.tt-readonly-banner')).toHaveCount(0)
  await expect(a.locator('.tt-readonly-banner')).toBeVisible()

  // A asks for it back with ONE click; B must yield and stay yielded.
  await a.locator('.tt-readonly-takeover-btn').click()
  await expect(a.locator('.tt-readonly-banner')).toHaveCount(0)
  await expect(b.locator('.tt-readonly-banner')).toBeVisible()
  await a.waitForTimeout(500)
  await expect(a.locator('.tt-readonly-banner')).toHaveCount(0)
  await b.close()
})
