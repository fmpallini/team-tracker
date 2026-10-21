// e2e/live-store.spec.ts — the browser live store and the file snapshot, in a real
// Chromium with a real OPFS file and a real IndexedDB: IndexedDB holds every edit at once,
// and the `.tmv` is written only at open, at Lock/Close and on the timer.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import {
  installOpfsPickerShim, installFileWriteCounter, fileWrites, installPermissionControl, setFilePermission, regrantRequests,
  readOpfsFile, writeOpfsFile, setNextOpenName,
} from './opfs-shim'
import { blockUpdateCheck, createEncryptedDoc, createPlainDoc, lockClose, reopenLast, reopenLastPlain, clearBrowserCopy, liveDatabaseDump, liveRowCounts } from './helpers'
import { openLargeDoc } from './large-doc'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'

const FILE = 'team-tracker.tmv'
const text = async (page: Page, name = FILE): Promise<string> => new TextDecoder().decode(new Uint8Array(await readOpfsFile(page, name)))
const editor = (page: Page) => page.locator('.tt-pane[data-pane-idx="0"] .editor').first()

async function prepare(page: Page): Promise<void> {
  await installOpfsPickerShim(page)
  await installFileWriteCounter(page)
  await installPermissionControl(page)
  await blockUpdateCheck(page)
}

async function startPlain(page: Page): Promise<void> {
  await prepare(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await createPlainDoc(page)
}

async function addTeam(page: Page, name: string): Promise<void> {
  const create = page.getByRole('button', { name: /Create first team/ })
  await ((await create.count()) > 0 ? create : page.locator('.tt-team-add-btn')).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-team-name"]').fill(name)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(dialog).toBeHidden()
}

async function typeNote(page: Page, note: string): Promise<void> {
  await editor(page).click()
  await page.keyboard.type(note)
  await page.waitForTimeout(700) // the editor's debounce, then the persister's
}

test.describe('the browser holds the live copy', () => {
  test('(a) an edit survives a page reload although the file was not rewritten in between', async ({ page }) => {
    await startPlain(page)
    await addTeam(page, 'Team A')
    await typeNote(page, 'LIVE-NOTE-A')
    const fileBefore = await readOpfsFile(page, FILE)

    await page.reload()
    await expect(page.locator('.tt-start-screen')).toBeVisible()
    expect(await readOpfsFile(page, FILE)).toEqual(fileBefore) // nothing rewrote it
    await reopenLastPlain(page)

    await expect(editor(page)).toContainText('LIVE-NOTE-A')
    // the browser copy was ahead of the file, so opening it rewrote the file, once
    await expect.poll(async () => fileWrites(page, FILE)).toBe(1)
    expect(await text(page)).toContain('LIVE-NOTE-A')
  })

  test('(b) Lock/Close writes the file exactly once, and the file alone carries the edit', async ({ page }) => {
    await startPlain(page)
    await addTeam(page, 'Team B')
    await typeNote(page, 'LIVE-NOTE-B')
    const before = await fileWrites(page, FILE)
    expect(await text(page)).not.toContain('LIVE-NOTE-B')

    await lockClose(page)
    expect(await fileWrites(page, FILE)).toBe(before + 1)
    expect(await text(page)).toContain('LIVE-NOTE-B')

    await clearBrowserCopy(page)
    await reopenLastPlain(page)
    await expect(editor(page)).toContainText('LIVE-NOTE-B')
  })

  test('(d) with the browser copy cleared, opening the file gives the file\'s content: work not yet written is gone', async ({ page }) => {
    await startPlain(page)
    await addTeam(page, 'Team D')
    await typeNote(page, 'WRITTEN-AT-CLOSE')
    await lockClose(page)
    await reopenLastPlain(page)
    await typeNote(page, ' UNWRITTEN-TAIL')
    await page.reload()
    await clearBrowserCopy(page)
    await reopenLastPlain(page)

    await expect(editor(page)).toContainText('WRITTEN-AT-CLOSE')
    await expect(editor(page)).not.toContainText('UNWRITTEN-TAIL')
  })
})

test.describe('a password-protected file leaves nothing readable in the browser', () => {
  test('(c) no note text, team name or password in any IndexedDB row', async ({ page }) => {
    const PASSWORD = 'e2e-correct-horse-battery'
    await prepare(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)
    await addTeam(page, 'Secret Team Name')
    await typeNote(page, 'SECRET-NOTE-TEXT-777')

    expect((await liveRowCounts(page)).records).toBeGreaterThan(3) // it really is in there...
    const dump = await liveDatabaseDump(page)
    expect(dump).not.toContain('SECRET-NOTE-TEXT-777') // ...and unreadable
    expect(dump).not.toContain('Secret Team Name')
    expect(dump).not.toContain(PASSWORD)
    expect(dump).not.toMatch(/daily|general|members|actionItems/)
  })
})

test.describe('opening a file that has a browser copy', () => {
  test('(e) a restored older file asks; keeping the browser copy brings it back and rewrites the file', async ({ page }) => {
    await startPlain(page)
    await addTeam(page, 'Team One')
    await lockClose(page)
    const olderFile = await readOpfsFile(page, FILE)

    await reopenLastPlain(page)
    await addTeam(page, 'Team Two')
    await lockClose(page)
    expect(await text(page)).toContain('Team Two')

    await writeOpfsFile(page, FILE, olderFile) // a cloud-history restore
    await page.getByRole('button', { name: /Reopen last/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.tt-modal-title')).toHaveText(/older than this browser/i)
    await dialog.getByRole('button', { name: 'Keep browser copy' }).click()

    await expect(page.locator('.tt-shell')).toBeVisible()
    await expect(page.locator('.tt-team-item .tt-team-name')).toHaveText(['Team One', 'Team Two'])
    await expect.poll(() => text(page)).toContain('Team Two') // the file was rewritten from the browser copy
  })
})

test.describe('when the file cannot be written', () => {
  test('(f) a lost permission shows on the pill; closing offers to grant it again, and granting writes the file and closes', async ({ page }) => {
    await startPlain(page)
    await addTeam(page, 'Team F')
    await typeNote(page, 'KEPT-IN-THE-BROWSER')

    await setFilePermission(page, 'prompt')
    await page.locator('.tt-btn-close-file').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.tt-modal-title')).toHaveText('The file could not be written')
    await expect(page.locator('.tt-save-pill[data-state="permission"]')).toBeVisible()
    await expect(page.locator('.tt-shell')).toBeVisible() // still open
    expect(await text(page)).not.toContain('KEPT-IN-THE-BROWSER')

    await dialog.getByRole('button', { name: 'Grant access…' }).click()
    await expect(page.locator('.tt-start-screen')).toBeVisible()
    expect(await regrantRequests(page)).toBe(1)
    expect(await text(page)).toContain('KEPT-IN-THE-BROWSER')
  })

  test('(f) "close anyway" leaves the file behind and the next open brings the work back from the browser', async ({ page }) => {
    await startPlain(page)
    await addTeam(page, 'Team G')
    await typeNote(page, 'BEHIND-IN-THE-FILE')
    await setFilePermission(page, 'prompt')
    await page.locator('.tt-btn-close-file').click()
    await page.getByRole('dialog').getByRole('button', { name: /Close anyway/ }).click()
    await expect(page.locator('.tt-start-screen')).toBeVisible()
    expect(await text(page)).not.toContain('BEHIND-IN-THE-FILE')

    await setFilePermission(page, 'granted')
    await reopenLastPlain(page)
    await expect(editor(page)).toContainText('BEHIND-IN-THE-FILE')
    await expect.poll(() => text(page)).toContain('BEHIND-IN-THE-FILE') // and the open rewrote the file
  })
})

test.describe('the timer', () => {
  test('(g) the file is written once the hour passes, and not before', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-21T10:00:00') })
    await startPlain(page)
    await addTeam(page, 'Team T')
    await typeNote(page, 'EDITED-AFTER-OPEN')
    const writes = await fileWrites(page, FILE)

    await page.clock.fastForward('59:00')
    expect(await fileWrites(page, FILE)).toBe(writes)
    expect(await text(page)).not.toContain('EDITED-AFTER-OPEN')

    await page.clock.fastForward('02:00')
    await expect.poll(() => fileWrites(page, FILE)).toBe(writes + 1)
    expect(await text(page)).toContain('EDITED-AFTER-OPEN')
  })

  test('(g) the window-close warning appears only once the file is overdue', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-21T10:00:00') })
    await startPlain(page)
    await addTeam(page, 'Team W')
    await typeNote(page, 'UNWRITTEN-FOR-AN-HOUR')
    // The file cannot be written, so it can only fall further behind.
    await setFilePermission(page, 'prompt')
    const prompts = (): Promise<boolean> => page.evaluate(() => {
      const ev = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(ev)
      return ev.defaultPrevented
    })

    await page.clock.fastForward('30:00')
    expect(await prompts()).toBe(false)
    await page.clock.fastForward('31:00')
    await expect(page.locator('.tt-save-pill[data-state="permission"]')).toBeVisible() // the timer tried and failed
    expect(await prompts()).toBe(true)

    // once the permission is back and the pill clicked, the write goes through and the warning goes away
    await page.locator('.tt-save-pill').click()
    await expect.poll(async () => prompts()).toBe(false)
  })
})

test.describe('pictures', () => {
  async function noisePng(page: Page, seed: number): Promise<number[]> {
    return page.evaluate(async (seed) => {
      const c = document.createElement('canvas')
      c.width = 48
      c.height = 48
      const ctx = c.getContext('2d')!
      const data = ctx.createImageData(48, 48)
      let x = seed * 2654435761 >>> 0
      for (let i = 0; i < data.data.length; i += 4) {
        x = (x * 1664525 + 1013904223) >>> 0
        data.data[i] = x & 255; data.data[i + 1] = (x >> 8) & 255; data.data[i + 2] = (x >> 16) & 255; data.data[i + 3] = 255
      }
      ctx.putImageData(data, 0, 0)
      const blob: Blob = await new Promise((resolve) => c.toBlob((b) => resolve(b!), 'image/png'))
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    }, seed)
  }

  async function pasteImage(page: Page, bytes: number[]): Promise<void> {
    await page.evaluate((bytes) => {
      const ed = document.querySelector('.editor') as HTMLElement
      ed.focus()
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(bytes)], 'p.png', { type: 'image/png' }))
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, bytes)
  }

  test('(h) 30 pasted pictures are stored once each, later edits write no picture again, and a reload shows them all', async ({ page }) => {
    await page.addInitScript(() => {
      const puts: Record<string, number> = {}
      ;(window as unknown as { __e2ePuts: Record<string, number> }).__e2ePuts = puts
      const original = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
        puts[this.name] = (puts[this.name] ?? 0) + 1
        return original.apply(this, args)
      }
    })
    const puts = (): Promise<Record<string, number>> => page.evaluate(() => (window as unknown as { __e2ePuts: Record<string, number> }).__e2ePuts)
    await startPlain(page)
    await addTeam(page, 'Team Pictures')
    await editor(page).click()
    const blocks = page.locator('.editor .tt-img img')
    for (let i = 0; i < 30; i++) {
      await pasteImage(page, await noisePng(page, i + 1))
      await expect(blocks).toHaveCount(i + 1)
    }
    await page.waitForTimeout(1200)
    expect((await puts()).blobs ?? 0).toBe(30)
    expect((await liveRowCounts(page)).blobs).toBe(30)

    const recordPutsBefore = (await puts()).records ?? 0
    await editor(page).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' one more word')
    await page.waitForTimeout(900)
    expect((await puts()).blobs ?? 0).toBe(30) // no picture was written again
    expect(((await puts()).records ?? 0) - recordPutsBefore).toBeLessThan(6) // and only the changed records were

    await page.reload()
    await reopenLastPlain(page)
    await expect(blocks).toHaveCount(30)
    await expect.poll(() => blocks.nth(29).evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  })
})

test.describe('two tabs', () => {
  test('(i) taking control shows the other tab\'s edits from the browser copy, with no file write', async ({ page: a, context }) => {
    await installOpfsPickerShim(context)
    await installFileWriteCounter(context)
    await blockUpdateCheck(context)
    await a.goto(`${E2E_BASE_URL}/app.html`)
    const doc = createEmptyDocument('en-US')
    doc.teams.push(createEmptyTeam('t1', 'T1', '🚀', 'en-US'))
    doc.nav.activeTeamId = 't1'
    await writeOpfsFile(a, FILE, Array.from(new TextEncoder().encode('TMV-PLAIN\n' + JSON.stringify(doc))))
    const open = async (p: Page): Promise<void> => {
      await setNextOpenName(p, FILE)
      await p.getByRole('button', { name: /Open/ }).first().click()
      await expect(p.locator('.tt-shell')).toBeVisible()
      const pane = p.locator('.tt-pane[data-pane-idx="0"]')
      await pane.locator('.tt-pane-modules-btn').click()
      await pane.locator('.tt-pane-menu-item', { hasText: /Daily/i }).first().click()
      await expect(editor(p)).toBeVisible()
    }
    await open(a)
    const seededWrites = await fileWrites(a, FILE) // the seeding above went through createWritable too
    const b = await context.newPage()
    await b.goto(`${E2E_BASE_URL}/app.html`)
    await open(b)
    await expect(b.locator('.tt-readonly-banner')).toBeVisible()

    await editor(a).click()
    await a.keyboard.type('FROM-TAB-A')
    await a.waitForTimeout(700)
    await b.locator('.tt-readonly-takeover-btn').click()

    await expect(editor(b)).toContainText('FROM-TAB-A')
    expect(await fileWrites(a, FILE)).toBe(seededWrites)
    expect(await fileWrites(b, FILE)).toBe(0)
    expect(await text(a)).not.toContain('FROM-TAB-A')
    await b.close()
  })
})

test.describe('a very large document', () => {
  test.describe.configure({ timeout: 180_000 })

  test('(j) typing never stalls the page: no long task while the browser copy follows every edit', async ({ page }) => {
    await page.addInitScript(() => {
      const longTasks: number[] = []
      ;(window as unknown as { __e2eLongTasks: number[] }).__e2eLongTasks = longTasks
      new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(e.duration) }).observe({ entryTypes: ['longtask'] })
    })
    await openLargeDoc(page)
    // self-check: the observer really sees a long task (otherwise "0 ms" below would prove nothing)
    await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 120) { /* busy */ } })
    await expect.poll(() => page.evaluate(() => (window as unknown as { __e2eLongTasks: number[] }).__e2eLongTasks.length)).toBeGreaterThan(0)
    const pane = page.locator('.tt-pane[data-pane-idx="0"]')
    await pane.locator('.tt-pane-modules-btn').click()
    await pane.locator('.tt-pane-menu-item', { hasText: /Daily/i }).first().click()
    await editor(page).click()
    await page.evaluate(() => { (window as unknown as { __e2eLongTasks: number[] }).__e2eLongTasks.length = 0 })

    for (let burst = 0; burst < 6; burst++) {
      await page.keyboard.type('some typing in a very large document ', { delay: 8 })
      await page.waitForTimeout(600) // let each debounced browser-copy flush run
    }
    const longest = Math.max(0, ...(await page.evaluate(() => (window as unknown as { __e2eLongTasks: number[] }).__e2eLongTasks)))
    console.log(`[live-store/large-doc] longest main-thread task while typing: ${Math.round(longest)}ms`)
    expect(longest).toBeLessThan(250)
  })
})
