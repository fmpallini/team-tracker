// e2e/images.spec.ts — pictures inside notes, in a real Chromium.
//
// jsdom has no canvas, no createImageBitmap and no real contenteditable, so the
// unit tests only see the pieces. Here the whole path runs: paste / drop / the
// toolbar picker → real decode and WebP re-encode → block in the note → Ctrl+S →
// bytes in the file → close, reopen, decrypt → the picture is back. Also the
// layout promises that only a layout engine can keep: centered, fitted to the
// pane, and not scaled by the font-size setting.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, readOpfsFile } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'
import { buildDoc, openDoc } from './layout-fixtures'

const PASSWORD = 'e2e-images-password'

/** A PNG made in the page: a gradient, or random noise (incompressible, so the file visibly grows). */
async function makePng(page: Page, w: number, h: number, kind: 'gradient' | 'noise' = 'gradient'): Promise<number[]> {
  return page.evaluate(async ({ w, h, kind }) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    if (kind === 'noise') {
      const data = ctx.createImageData(w, h)
      for (let i = 0; i < data.data.length; i += 4) {
        data.data[i] = Math.random() * 256
        data.data[i + 1] = Math.random() * 256
        data.data[i + 2] = Math.random() * 256
        data.data[i + 3] = 255
      }
      ctx.putImageData(data, 0, 0)
    } else {
      const g = ctx.createLinearGradient(0, 0, w, h)
      g.addColorStop(0, '#c0392b')
      g.addColorStop(1, '#2980b9')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
    }
    const blob: Blob = await new Promise((resolve) => c.toBlob((b) => resolve(b!), 'image/png'))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  }, { w, h, kind })
}

/** Dispatches a paste carrying the given files and/or HTML at the first editor. */
async function pasteInto(page: Page, data: { files?: { name: string; bytes: number[] }[]; html?: string; text?: string }): Promise<void> {
  await page.evaluate((data) => {
    const ed = document.querySelector('.editor') as HTMLElement
    ed.focus()
    const dt = new DataTransfer()
    for (const f of data.files ?? []) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'image/png' }))
    if (data.html) dt.setData('text/html', data.html)
    if (data.text) dt.setData('text/plain', data.text)
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, data)
}

async function dropOnto(page: Page, files: { name: string; bytes: number[] }[]): Promise<void> {
  await page.evaluate((files) => {
    const ed = document.querySelector('.editor') as HTMLElement
    const r = ed.getBoundingClientRect()
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'image/png' }))
    const init = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }
    ed.dispatchEvent(new DragEvent('dragover', init))
    ed.dispatchEvent(new DragEvent('drop', init))
  }, files)
}

const blocks = (page: Page) => page.locator('.editor .tt-img img')

async function waitForSaved(page: Page): Promise<void> {
  await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()
}

async function newTeamWithEditor(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create first team/ }).click()
  const teamDialog = page.getByRole('dialog')
  await teamDialog.locator('input[name="tt-team-name"]').fill('T')
  await teamDialog.getByRole('button', { name: 'OK' }).click()
  await teamDialog.waitFor({ state: 'hidden' })
  await page.locator('.editor').first().click()
}

async function startEncrypted(page: Page): Promise<void> {
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await createEncryptedDoc(page, PASSWORD)
  await newTeamWithEditor(page)
}

test.describe('pictures in notes', () => {
  test('a pasted screenshot is shown centered, fitted to the pane, with a blank line on each side', async ({ page }) => {
    await startEncrypted(page)
    // Wider than the pane: must be re-encoded under the 1600 px edge and then shrunk to fit.
    await pasteInto(page, { files: [{ name: 'shot.png', bytes: await makePng(page, 2400, 1200) }] })
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
      { name: 'a.png', bytes: await makePng(page, 320, 200) },
      { name: 'b.png', bytes: await makePng(page, 200, 320) },
    ])
    await expect(blocks(page)).toHaveCount(2)
  })

  test('the toolbar button takes files through the picker', async ({ page }) => {
    await startEncrypted(page)
    const bytes = await makePng(page, 280, 180)
    await page.locator('.tt-editor input[type="file"], input[type="file"][accept="image/*"]').first().setInputFiles({
      name: 'picked.png',
      mimeType: 'image/png',
      buffer: Buffer.from(bytes),
    })
    await expect(blocks(page)).toHaveCount(1)
  })

  test('a file that is not an image is refused with a message and nothing is added', async ({ page }) => {
    await startEncrypted(page)
    await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    })
    await expect(page.locator('.tt-toast').filter({ hasText: /image/i }).first()).toBeVisible()
    await expect(blocks(page)).toHaveCount(0)
  })

  test('encrypted: the picture survives save, close and reopen, and the file holds no readable pixels', async ({ page }) => {
    await startEncrypted(page)
    await pasteInto(page, { files: [{ name: 'shot.png', bytes: await makePng(page, 400, 260) }] })
    await expect(blocks(page)).toHaveCount(1)
    await page.waitForTimeout(500) // the debounced commit
    await page.keyboard.press('Control+s')
    await waitForSaved(page)

    const bytes = await readOpfsFile(page, 'team-tracker.tmv')
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('TMV1')
    expect(bytes[4]).toBe(2) // container v2: the picture bytes ride in the sealed blob area
    const asText = String.fromCharCode(...bytes)
    expect(asText).not.toContain('RIFF') // a WebP header would show if the pixels were stored in the clear
    expect(asText).not.toContain('img:')

    await page.click('.tt-btn-close-file')
    await page.getByRole('button', { name: /Reopen last/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[name="tt-password"]').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.locator('.tt-shell')).toBeVisible()
    await expect(blocks(page)).toHaveCount(1)
    await expect.poll(() => blocks(page).first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  })

  test('password-less: the picture survives save, close and reopen', async ({ page }) => {
    await openDoc(page, buildDoc('M', { kind: 'general' }))
    await page.locator('.editor').first().click()
    await pasteInto(page, { files: [{ name: 'shot.png', bytes: await makePng(page, 400, 260) }] })
    await expect(blocks(page)).toHaveCount(1)
    await page.waitForTimeout(500)
    await page.keyboard.press('Control+s')
    await waitForSaved(page)

    const bytes = await readOpfsFile(page, 'fs.tmv')
    expect(String.fromCharCode(...bytes.slice(0, 11))).toBe('TMV-PLAIN2' + String.fromCharCode(10))

    await page.click('.tt-btn-close-file')
    await page.getByRole('button', { name: /Reopen last/ }).click()
    await expect(page.locator('.tt-shell')).toBeVisible()
    await expect(blocks(page)).toHaveCount(1)
    await expect.poll(() => blocks(page).first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  })

  test('deleting the note drops its picture from the file at the next save', async ({ page }) => {
    await startEncrypted(page)
    await pasteInto(page, { files: [{ name: 'noise.png', bytes: await makePng(page, 500, 400, 'noise') }] })
    await expect(blocks(page)).toHaveCount(1)
    await page.waitForTimeout(500)
    await page.keyboard.press('Control+s')
    await waitForSaved(page)
    const withImage = (await readOpfsFile(page, 'team-tracker.tmv')).length

    await page.locator('.editor').first().click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await expect(blocks(page)).toHaveCount(0)
    await page.waitForTimeout(500)
    await page.keyboard.press('Control+s')
    await expect.poll(async () => (await readOpfsFile(page, 'team-tracker.tmv')).length, { timeout: 10_000 }).toBeLessThan(withImage - 20_000)
  })

  test('Backspace removes a clicked picture and Ctrl+Z brings it back', async ({ page }) => {
    await startEncrypted(page)
    await pasteInto(page, { files: [{ name: 'undo.png', bytes: await makePng(page, 300, 200) }] })
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
    await pasteInto(page, { files: [{ name: 'keep.png', bytes: await makePng(page, 300, 200) }] })
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
      await pasteInto(page, { files: [{ name: 'wrap.png', bytes: await makePng(page, 300, 200) }] })
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
    await openDoc(page, buildDoc('M', { kind: 'general' }))
    await page.locator('.editor').first().click()
    await pasteInto(page, { files: [{ name: 'fixed.png', bytes: await makePng(page, 300, 200) }] })
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
    await pasteInto(page, { files: [{ name: 'shot.png', bytes: await makePng(page, 300, 200) }] })
    await expect(blocks(page)).toHaveCount(1)
    await page.waitForTimeout(500)
    await page.click('.tt-btn-settings')
    await page.getByRole('tab', { name: 'Data' }).click()
    await expect(page.locator('.tt-data-images-usage')).toHaveText(/^1 picture · \d+\.\d MB of 150 MB$/)
  })
})
