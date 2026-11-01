// e2e/memory-after-write.spec.ts — a file write must not leave a second copy of the whole file behind. core/fs.ts
// used to keep the last written bytes to tell a sync client's mtime bump from a real external edit; with pictures
// in the document that pinned another file-sized buffer for the rest of the session (a 20 MB file left 40 MB held
// after one write). It keeps a SHA-256 now. Measured as V8's ArrayBuffer backing store after a forced GC.
import { test, expect } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, writeOpfsFile, setNextOpenName, installFileWriteCounter, fileWrites } from './opfs-shim'
import { blockUpdateCheck } from './helpers'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { serializePlain } from '../src/core/crypto'
import { createImageStore } from '../src/core/image-store'

test('a timed file write leaves no second copy of the file in memory', async ({ page, context }) => {
  test.setTimeout(120_000)
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('t1', 'T1', '🚀', 'en-US')
  const images = createImageStore(null)
  const ids: string[] = []
  const lines: string[] = []
  for (let i = 0; i < 10; i++) { // 10 MB: big enough to read through noise; a larger array through evaluate() is slow
    const bytes = new Uint8Array(randomBytes(1_000_000))
    const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    images.putPlain(id, bytes); ids.push(id)
    doc.images[id] = { mime: 'image/webp', w: 10, h: 10, bytes: bytes.length }
    lines.push(`![p${i}](img:${id})`)
  }
  team.dailyNotes['2020-01-01'] = lines.join('\n')
  doc.teams.push(team); doc.nav.activeTeamId = 't1'
  const file = await serializePlain(doc, images, ids)
  await page.clock.install()
  await installOpfsPickerShim(page); await installFileWriteCounter(page); await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await writeOpfsFile(page, 'm.tmv', Array.from(file))
  await setNextOpenName(page, 'm.tmv')
  await page.getByRole('button', { name: /Open/ }).first().click()
  await expect(page.locator('.tt-shell')).toBeVisible()
  const cdp = await context.newCDPSession(page)
  const mb = async () => { await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage'); return ((await cdp.send('Runtime.getHeapUsage')) as any).backingStorageSize / 1e6 }
  await page.clock.fastForward(5_000)
  const afterOpen = await mb()
  const writesBefore = await fileWrites(page, 'm.tmv')
  await page.locator('.tt-team-item').first().click() // a nav change: the document now differs from its file
  await page.clock.fastForward('01:01:00')
  await page.waitForTimeout(3000)
  await page.clock.fastForward(5_000)
  expect(await fileWrites(page, 'm.tmv')).toBeGreaterThan(writesBefore) // the timer wrote
  const afterWrite = await mb()
  console.log(`[memory] file ${(file.length / 1e6).toFixed(1)} MB, held after open ${afterOpen.toFixed(1)} MB, after a write ${afterWrite.toFixed(1)} MB`)
  expect(afterWrite - afterOpen).toBeLessThan(file.length / 1e6 / 2)
})
