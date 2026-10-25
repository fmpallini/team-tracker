// e2e/images.spec.ts — pictures inside notes, in a real Chromium.
//
// jsdom has no canvas, no createImageBitmap and no real contenteditable, so the
// unit tests only see the pieces. Here the whole path runs: paste / drop / the
// toolbar picker → real decode and WebP re-encode → block in the note → Lock/Close →
// bytes in the file → close, reopen, decrypt → the picture is back. Also the
// layout promises that only a layout engine can keep: centered, fitted to the
// pane, and not scaled by the font-size setting.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, readOpfsFile } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck, lockClose, reopenLast, clearBrowserCopy } from './helpers'
import { buildDoc, openDoc } from './layout-fixtures'

const PASSWORD = 'e2e-images-password'

/** What to draw: a gradient, or random noise (incompressible, so the file visibly grows). */
interface Pic { name: string; w: number; h: number; kind?: 'gradient' | 'noise' }

/**
 * Defines `window.__ttPicFile(pic)` in every page: draws the PNG there and wraps it in a File. A picture is made and
 * handed to the app inside the page — shipping its bytes through Playwright as a number array (a 2400x1200 gradient is
 * 3 MB, millions of elements, ~8 s each way) is what used to eat most of this suite's per-test timeout.
 */
async function installPicMaker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__ttPicFile = async (pic) => {
      const c = document.createElement('canvas')
      c.width = pic.w
      c.height = pic.h
      const ctx = c.getContext('2d')!
      if (pic.kind === 'noise') {
        const data = ctx.createImageData(pic.w, pic.h)
        for (let i = 0; i < data.data.length; i += 4) {
          data.data[i] = Math.random() * 256
          data.data[i + 1] = Math.random() * 256
          data.data[i + 2] = Math.random() * 256
          data.data[i + 3] = 255
        }
        ctx.putImageData(data, 0, 0)
      } else {
        const g = ctx.createLinearGradient(0, 0, pic.w, pic.h)
        g.addColorStop(0, '#c0392b')
        g.addColorStop(1, '#2980b9')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, pic.w, pic.h)
      }
      const blob: Blob = await new Promise((resolve) => c.toBlob((b) => resolve(b!), 'image/png'))
      return new File([blob], pic.name, { type: 'image/png' })
    }
  })
}

type PicMaker = (pic: Pic) => Promise<File>
// Inside page.evaluate callbacks (serialized to the page, so no Node-side closure is visible there).
declare global { interface Window { __ttPicFile: PicMaker } }

/** A PNG's bytes, for the few tests that embed it in HTML or hand it to a file input. Keep it small. */
async function makePng(page: Page, w: number, h: number): Promise<number[]> {
  return page.evaluate(async (pic) => {
    const file = await window.__ttPicFile(pic)
    return Array.from(new Uint8Array(await file.arrayBuffer()))
  }, { name: 'x.png', w, h })
}

/** Dispatches a paste carrying the given pictures and/or HTML at the first editor. */
async function pasteInto(page: Page, data: { files?: Pic[]; html?: string; text?: string }): Promise<void> {
  await page.evaluate(async (data) => {
    const ed = document.querySelector('.editor') as HTMLElement
    ed.focus()
    const dt = new DataTransfer()
    for (const f of data.files ?? []) dt.items.add(await window.__ttPicFile(f))
    if (data.html) dt.setData('text/html', data.html)
    if (data.text) dt.setData('text/plain', data.text)
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, data)
}

async function dropOnto(page: Page, files: Pic[]): Promise<void> {
  await page.evaluate(async (files) => {
    const ed = document.querySelector('.editor') as HTMLElement
    const r = ed.getBoundingClientRect()
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(await window.__ttPicFile(f))
    const init = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }
    ed.dispatchEvent(new DragEvent('dragover', init))
    ed.dispatchEvent(new DragEvent('drop', init))
  }, files)
}

const blocks = (page: Page) => page.locator('.editor .tt-img img')

async function newTeamWithEditor(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create first team/ }).click()
  const teamDialog = page.getByRole('dialog')
  await teamDialog.locator('input[name="tt-team-name"]').fill('T')
  await teamDialog.getByRole('button', { name: 'Save' }).click()
  await teamDialog.waitFor({ state: 'hidden' })
  await page.locator('.editor').first().click()
}

async function startEncrypted(page: Page): Promise<void> {
  await installOpfsPickerShim(page)
  await installPicMaker(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await createEncryptedDoc(page, PASSWORD)
  await newTeamWithEditor(page)
}

test.describe('pictures in notes', () => {
  test('a pasted screenshot is shown centered, fitted to the pane, with a blank line on each side', async ({ page }) => {
    await startEncrypted(page)
    // Wider than the pane: must be re-encoded under the 1600 px edge and then shrunk to fit.
    await pasteInto(page, { files: [{ name: 'shot.png', w: 2400, h: 1200 }] })
    await expect(blocks(page)).toHaveCount(1)
    await expect.poll(() => blocks(page).first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)

    const geo = await page.evaluate(() => {
      const ed = document.querySelector('.editor') as HTMLElement
      const block = ed.querySelector('.tt-img') as HTMLElement
      const img = block.querySelector('img') as HTMLImageElement
      const e = ed.getBoundingClientRect()
      const b = img.getBoundingClientRect()
      const cs = getComputedStyle(ed)
      const inner = e.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      return {
        natural: img.naturalWidth,
        shown: b.width,
        inner,
        offCenter: Math.abs((b.left + b.right) / 2 - (e.left + parseFloat(cs.paddingLeft) + inner / 2)),
        before: block.previousElementSibling?.textContent === '' ,
        after: block.nextElementSibling?.textContent === '',
      }
    })
    expect(geo.natural).toBeLessThanOrEqual(1600)
    expect(geo.shown).toBeLessThanOrEqual(geo.inner + 0.5)
    expect(geo.offCenter).toBeLessThan(3)
    expect(geo.before || geo.after).toBe(true)
  })

  test('text, picture, text pasted together keep their order', async ({ page }) => {
    await startEncrypted(page)
    const png = await makePng(page, 300, 200)
    const b64 = Buffer.from(png).toString('base64')
    await pasteInto(page, { html: `<p>alpha</p><img src="data:image/png;base64,${b64}" alt="pic"><p>omega</p>`, text: 'alpha omega' })
    await expect(blocks(page)).toHaveCount(1)
    const order = await page.evaluate(() => {
      const ed = document.querySelector('.editor') as HTMLElement
      const text = ed.innerText
      const img = ed.querySelector('.tt-img') as HTMLElement
      const kids = Array.from(ed.children)
      const at = (s: string) => kids.findIndex((k) => k.textContent?.includes(s))
      return { a: at('alpha'), i: kids.indexOf(img), o: at('omega'), text }
    })
    expect(order.a).toBeGreaterThanOrEqual(0)
    expect(order.a).toBeLessThan(order.i)
    expect(order.i).toBeLessThan(order.o)
  })

  test('dropping two image files adds both', async ({ page }) => {
    await startEncrypted(page)
    await dropOnto(page, [
      { name: 'a.png', w: 320, h: 200 },
      { name: 'b.png', w: 200, h: 320 },
    ])
    await expect(blocks(page)).toHaveCount(2)
  })

  test('the toolbar button takes files through the picker', async ({ page }) => {
    await startEncrypted(page)
    const bytes = await makePng(page, 280, 180)
    await page.locator('.tt-editor input[type="file"]').first().setInputFiles({
      name: 'picked.png',
      mimeType: 'image/png',
      buffer: Buffer.from(bytes),
    })
    await expect(blocks(page)).toHaveCount(1)
  })

  test('a file that is not an image is refused with a message and nothing is added', async ({ page }) => {
    await startEncrypted(page)
    await page.locator('.tt-editor input[type="file"]').first().setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    })
    await expect(page.locator('.tt-toast').filter({ hasText: /image/i }).first()).toBeVisible()
    await expect(blocks(page)).toHaveCount(0)
  })

  test('encrypted: the picture survives save, close and reopen, and the file holds no readable pixels', async ({ page }) => {
    await startEncrypted(page)
    await pasteInto(page, { files: [{ name: 'shot.png', w: 400, h: 260 }] })
    await expect(blocks(page)).toHaveCount(1)
    await page.waitForTimeout(500) // the debounced commit
    await page.click('.tt-btn-close-file') // Lock/Close writes the file, picture included
    await expect(page.locator('.tt-start-screen')).toBeVisible()

    const bytes = await readOpfsFile(page, 'team-tracker.tmv')
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('TMV1')
    expect(bytes[4]).toBe(2) // container v2: the picture bytes ride in the sealed blob area
    const asText = String.fromCharCode(...bytes)
    expect(asText).not.toContain('RIFF') // a WebP header would show if the pixels were stored in the clear
    expect(asText).not.toContain('img:')

    await clearBrowserCopy(page) // the picture must come back from the encrypted file, not from the browser's copy
    await page.getByRole('button', { name: /Reopen last/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[name="tt-password"]').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.locator('.tt-shell')).toBeVisible()
    await expect(blocks(page)).toHaveCount(1)
    await expect.poll(() => blocks(page).first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  })

  test('password-less: the picture survives close and reopen', async ({ page }) => {
    await installPicMaker(page)
    await openDoc(page, buildDoc('M', { kind: 'general' }))
    await page.locator('.editor').first().click()
    await pasteInto(page, { files: [{ name: 'shot.png', w: 400, h: 260 }] })
    await expect(blocks(page)).toHaveCount(1)
    await page.waitForTimeout(500)

    await page.click('.tt-btn-close-file') // Lock/Close writes the file
    await expect(page.locator('.tt-start-screen')).toBeVisible()
    const bytes = await readOpfsFile(page, 'fs.tmv')
    expect(String.fromCharCode(...bytes.slice(0, 11))).toBe('TMV-PLAIN2' + String.fromCharCode(10))

    await clearBrowserCopy(page) // the picture must come back from the file, not from the browser's copy
    await page.getByRole('button', { name: /Reopen last/ }).click()
    await expect(page.locator('.tt-shell')).toBeVisible()
    await expect(blocks(page)).toHaveCount(1)
    await expect.poll(() => blocks(page).first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  })

  test('deleting the note drops its picture from the file at the next write', async ({ page }) => {
    await startEncrypted(page)
    await pasteInto(page, { files: [{ name: 'noise.png', w: 500, h: 400, kind: 'noise' }] })
    await expect(blocks(page)).toHaveCount(1)
    await page.waitForTimeout(500)
    await lockClose(page)
    const withImage = (await readOpfsFile(page, 'team-tracker.tmv')).length

    await reopenLast(page, PASSWORD)
    await page.locator('.editor').first().click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await expect(blocks(page)).toHaveCount(0)
    await page.waitForTimeout(500)
    await lockClose(page)
    expect((await readOpfsFile(page, 'team-tracker.tmv')).length).toBeLessThan(withImage - 20_000)
  })

  test('Backspace removes a clicked picture and Ctrl+Z brings it back', async ({ page }) => {
    await startEncrypted(page)
    await pasteInto(page, { files: [{ name: 'undo.png', w: 300, h: 200 }] })
    await expect(blocks(page)).toHaveCount(1)
    await blocks(page).first().click()
    await page.keyboard.press('Backspace')
    await expect(blocks(page)).toHaveCount(0)
    await page.keyboard.press('Control+z')
    await expect(blocks(page)).toHaveCount(1)
    await expect.poll(() => blocks(page).first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  })

  test('Backspace after the caret has moved on edits text, it does not delete the picture clicked earlier', async ({ page }) => {
    await startEncrypted(page)
    await page.keyboard.type('hello')
    await pasteInto(page, { files: [{ name: 'keep.png', w: 300, h: 200 }] })
    await expect(blocks(page)).toHaveCount(1)
    await blocks(page).first().click()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Backspace')
    await expect(blocks(page)).toHaveCount(1)
  })

  test('turning a selection that includes a picture into a quote or list keeps the picture as its own line', async ({ page }) => {
    for (const title of ['Blockquote', 'Bulleted list']) {
      await startEncrypted(page)
      await page.keyboard.type('hello')
      await pasteInto(page, { files: [{ name: 'wrap.png', w: 300, h: 200 }] })
      await expect(blocks(page)).toHaveCount(1)
      await page.locator('.editor').first().click()
      await page.keyboard.press('Control+a')
      await page.locator(`.tt-editor-toolbar button[title^="${title}"]`).first().click()
      const topLevel = await page.evaluate(() => Array.from(document.querySelectorAll('.editor .tt-img')).every((b) => b.parentElement === document.querySelector('.editor')))
      expect(topLevel, title).toBe(true)
      await page.goto('about:blank')
    }
  })

  test('the font-size setting does not change how wide a picture is', async ({ page }) => {
    await installPicMaker(page)
    await openDoc(page, buildDoc('M', { kind: 'general' }))
    await page.locator('.editor').first().click()
    await pasteInto(page, { files: [{ name: 'fixed.png', w: 300, h: 200 }] })
    await expect(blocks(page)).toHaveCount(1)
    await expect.poll(() => blocks(page).first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const widthAt = async (size: string): Promise<number> => {
      await page.evaluate((s) => document.documentElement.setAttribute('data-size', s), size)
      return blocks(page).first().evaluate((i) => i.getBoundingClientRect().width)
    }
    const xs = await widthAt('XS')
    const xl = await widthAt('XL')
    expect(xs).toBe(300)
    expect(xl).toBe(300)
  })

  test('the Data tab counts the picture and its megabytes', async ({ page }) => {
    await startEncrypted(page)
    await pasteInto(page, { files: [{ name: 'shot.png', w: 300, h: 200 }] })
    await expect(blocks(page)).toHaveCount(1)
    await page.waitForTimeout(500)
    await page.click('.tt-btn-settings')
    await page.getByRole('tab', { name: 'Data' }).click()
    await expect(page.locator('.tt-data-images-usage')).toHaveText(/^1 picture · \d+\.\d MB of 150 MB$/)
  })
})
