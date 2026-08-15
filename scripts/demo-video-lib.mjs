// scripts/demo-video-lib.mjs — shared plumbing for the demo-video recording
// scripts (generate-demo-video.mjs's full tour, generate-demo-video-short.mjs's
// 60s cut). Not itself runnable.
//
// Served over http://localhost (e2e/static-server.mjs), not file://: Chromium
// treats localhost as a *secure* context, which unlocks the real File System
// Access API via e2e/opfs-shim.ts's installOpfsPickerShim (OPFS-backed, real
// FileSystemFileHandle, just sourced from sandboxed storage instead of a
// native OS picker Playwright can't drive). That lets these tours show the
// real create/password-change/daily-backup flows, not just the file://
// download-fallback path generate-screenshots.mjs deliberately exercises.
//
// Output is WebM only (Playwright's native recording format, no ffmpeg
// dependency) — this repo has zero runtime deps and no ffmpeg on PATH.
//
// Every interaction is driven through the click()/type() helpers below
// instead of Playwright's instant .click()/.fill(): they glide a real,
// visible fake cursor to the target (injected DOM overlay, tracks real
// mousemove events) and type at a readable pace, so the recording looks like
// a person driving the app instead of a script. A caption bar (same overlay)
// narrates each section. Both are pure page-side DOM injected once after
// load — no ffmpeg/subtitle-track muxing needed, they're just pixels burned
// into the recording.
import { chromium, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { installOpfsPickerShim } from '../e2e/opfs-shim.ts'
import { blockUpdateCheck } from '../e2e/helpers.ts'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const OUT_DIR = path.resolve(HERE, '../docs/videos')
export const PASSWORD = 'demo-password-123'
export const VIEWPORT = { width: 1280, height: 800 }

function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(url).then(
        () => resolve(),
        (err) => {
          if (Date.now() > deadline) reject(err)
          else setTimeout(tryOnce, 200)
        }
      )
    }
    tryOnce()
  })
}

// --- Fake cursor + caption overlay (page-side, injected once after load) ---

function installOverlayInPage() {
  const style = document.createElement('style')
  style.textContent = `
    #__demo-caption { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(8px);
      background: rgba(18,18,22,0.9); color: #fff; padding: 11px 22px; border-radius: 9px;
      font: 600 16px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: .2px;
      max-width: 82vw; text-align: center; z-index: 2147483000; pointer-events: none;
      opacity: 0; transition: opacity .3s ease, transform .3s ease; box-shadow: 0 6px 20px rgba(0,0,0,.4); }
    #__demo-caption.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    #__demo-cursor { position: fixed; width: 18px; height: 18px; border-radius: 50%;
      background: rgba(255,64,64,.92); border: 2px solid #fff;
      box-shadow: 0 0 0 2px rgba(0,0,0,.28), 0 2px 10px rgba(0,0,0,.45);
      transform: translate(-50%, -50%); z-index: 2147483001; pointer-events: none;
      transition: width .1s ease, height .1s ease; left: -100px; top: -100px; }
    #__demo-cursor.click { width: 28px; height: 28px; }
  `
  document.head.appendChild(style)
  const caption = document.createElement('div')
  caption.id = '__demo-caption'
  document.body.appendChild(caption)
  const cursor = document.createElement('div')
  cursor.id = '__demo-cursor'
  document.body.appendChild(cursor)
  window.addEventListener('mousemove', (e) => {
    cursor.style.left = e.clientX + 'px'
    cursor.style.top = e.clientY + 'px'
  })
  window.addEventListener('mousedown', () => cursor.classList.add('click'))
  window.addEventListener('mouseup', () => cursor.classList.remove('click'))
}

export async function installOverlay(page) {
  await page.evaluate(installOverlayInPage)
}

export async function caption(page, text, holdMs = 1500) {
  await page.evaluate((t) => {
    const el = document.getElementById('__demo-caption')
    el.textContent = t
    el.classList.add('show')
  }, text)
  await page.waitForTimeout(holdMs)
}

export async function hideCaption(page) {
  await page.evaluate(() => document.getElementById('__demo-caption')?.classList.remove('show'))
  await page.waitForTimeout(350)
}

// --- Natural-feeling mouse + typing helpers ---------------------------------

// Tracked in Node (not read back from the page) purely to avoid a round trip
// per move — the overlay's own on-page cursor is what actually reflects
// reality, this is just "where we last told the OS mouse to go".
let cursorX = VIEWPORT.width / 2
let cursorY = VIEWPORT.height / 2

export async function moveMouseTo(page, x, y, { steps = 16, totalMs = 320 } = {}) {
  const sx = cursorX
  const sy = cursorY
  const stepMs = totalMs / steps
  for (let i = 1; i <= steps; i++) {
    // ease-out: fast start, settles into the target instead of a robotic linear glide.
    const t = 1 - (1 - i / steps) ** 2
    await page.mouse.move(sx + (x - sx) * t, sy + (y - sy) * t)
    await page.waitForTimeout(stepMs)
  }
  cursorX = x
  cursorY = y
}

export async function clickAt(page, x, y) {
  await moveMouseTo(page, x, y)
  await page.waitForTimeout(110)
  await page.mouse.down()
  await page.waitForTimeout(70)
  await page.mouse.up()
  await page.waitForTimeout(150)
}

/**
 * Moves the visible cursor to `locator`'s center, then clicks it for real.
 * Uses the element's *first* client rect, not the bounding box: for a
 * wrapped multi-line inline element (e.g. a long @-reference chip title
 * wrapping across two lines), boundingBox()/getBoundingClientRect() returns
 * the union of every line fragment, and that union's geometric center can
 * land in the empty gap between lines instead of on any actual glyph — a
 * click there hits whatever's underneath, not the element. getClientRects()
 * returns one rect per line fragment; its first entry is always real text.
 */
export async function click(page, locator) {
  await locator.scrollIntoViewIfNeeded()
  const rect = await locator.evaluate((el) => {
    const r = el.getClientRects()[0] ?? el.getBoundingClientRect()
    return r.width > 0 || r.height > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null
  })
  if (!rect) {
    await locator.click()
    return
  }
  await clickAt(page, rect.x + rect.width / 2, rect.y + rect.height / 2)
}

/** Clicks into `locator` (visible cursor travel), then types at a readable pace. */
export async function type(page, locator, text, delay = 32) {
  await click(page, locator)
  await locator.pressSequentially(text, { delay })
}

export async function blurAway(page) {
  await clickAt(page, 5, 5)
}

export async function focusedRow(page, rowSelector, idAttr) {
  await page.waitForFunction((sel) => document.activeElement?.closest(sel) != null, rowSelector)
  const id = await page.evaluate(
    ({ sel, attr }) => document.activeElement.closest(sel).getAttribute(attr),
    { sel: rowSelector, attr: idAttr }
  )
  return page.locator(`${rowSelector}[${idAttr}="${id}"]`)
}

export async function pause(page, ms) {
  await page.waitForTimeout(ms)
}

// --- App flows shared by both tours ------------------------------------------

export async function createTeam(page, name, emoji, first) {
  if (first) {
    await click(page, page.getByRole('button', { name: /Create first team/ }))
  } else {
    await click(page, page.locator('.tt-team-add-btn'))
  }
  const dialog = page.getByRole('dialog')
  await type(page, dialog.locator('input[name="tt-team-name"]'), name)
  await type(page, dialog.locator('input[name="tt-team-emoji"]'), emoji)
  await click(page, dialog.locator('input[name="tt-team-name"]')) // closes emoji-picker popup
  await click(page, dialog.getByRole('button', { name: 'OK' }))
  await expect(dialog).toBeHidden()
}

export async function switchPaneModule(page, paneIdx, label) {
  const pane = page.locator(`.tt-pane[data-pane-idx="${paneIdx}"]`)
  await click(page, pane.locator('.tt-pane-modules-btn'))
  await click(page, pane.locator('.tt-pane-menu-item', { hasText: label }).first())
}

export async function addPerson(page, paneIdx, name, role) {
  const pane = page.locator(`.tt-pane[data-pane-idx="${paneIdx}"]`)
  await click(page, pane.locator('.tt-people-add-btn').first())
  const dialog = page.getByRole('dialog')
  await type(page, dialog.locator('input[name="tt-person-name"]'), name)
  await type(page, dialog.locator('input[name="tt-person-role"]'), role)
  await click(page, dialog.getByRole('button', { name: 'OK' }))
  await expect(dialog).toBeHidden()
}

export async function addChildPerson(page, paneIdx, parentName, childName, role) {
  const pane = page.locator(`.tt-pane[data-pane-idx="${paneIdx}"]`)
  await click(page, pane.locator('.tt-org-box', { hasText: parentName }).locator('.tt-people-add-child-btn'))
  const dialog = page.getByRole('dialog')
  await type(page, dialog.locator('input[name="tt-person-name"]'), childName)
  await type(page, dialog.locator('input[name="tt-person-role"]'), role)
  await click(page, dialog.getByRole('button', { name: 'OK' }))
  await expect(dialog).toBeHidden()
}

export async function typeIntoEditor(page, editor, text, delay = 18) {
  await type(page, editor, text, delay) // longer prose: faster than form fields or it drags
}

// --- Server + browser/context/video harness ----------------------------------

/**
 * Spins up e2e/static-server.mjs on `port`, launches a recorded Chromium
 * context, runs `script(page)`, then finalizes the recording as
 * `docs/videos/<outFile>`. `script` gets a real page already at APP_URL with
 * the overlay installed and the OPFS picker shim + update-check block already
 * wired — it should drive the tour and return normally when done.
 */
export async function runDemo({ outFile, port, script }) {
  const baseUrl = `http://localhost:${port}`
  const appUrl = `${baseUrl}/app.html`
  const tmpDir = path.resolve(HERE, `../.video-tmp-${port}`)

  await mkdir(OUT_DIR, { recursive: true })
  await rm(tmpDir, { recursive: true, force: true })
  await mkdir(tmpDir, { recursive: true })

  const server = spawn(process.execPath, [path.resolve(HERE, '../e2e/static-server.mjs')], {
    env: { ...process.env, E2E_PORT: String(port) },
    stdio: 'inherit',
  })
  const stopServer = () => { server.kill() }
  process.on('exit', stopServer)

  const startedAt = Date.now()
  try {
    await waitForServer(appUrl)

    const browser = await chromium.launch()
    const context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: tmpDir, size: VIEWPORT },
      acceptDownloads: true,
      locale: 'en-US',
    })
    await installOpfsPickerShim(context)
    await blockUpdateCheck(context)
    const page = await context.newPage()

    try {
      await page.goto(appUrl)
      await installOverlay(page)
      await pause(page, 400)
      await script(page)
    } finally {
      await context.close()
      await browser.close()
    }

    const files = await readdir(tmpDir)
    const webm = files.find((f) => f.endsWith('.webm'))
    if (!webm) throw new Error('No .webm recording found in ' + tmpDir)
    const dest = path.join(OUT_DIR, outFile)
    await rename(path.join(tmpDir, webm), dest)
    await rm(tmpDir, { recursive: true, force: true })
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`Wrote ${path.relative(process.cwd(), dest)} (~${elapsedS}s of recording)`)
  } finally {
    stopServer()
  }
}
