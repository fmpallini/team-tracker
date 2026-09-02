// scripts/demo-video-lib.mjs — shared plumbing for generate-demo-video-short.mjs
// (the ~60s feature-tour cut). Not itself runnable.
//
// Served over http://localhost (e2e/static-server.mjs), not file://: Chromium
// treats localhost as a *secure* context, which unlocks the real File System
// Access API via e2e/opfs-shim.ts's installOpfsPickerShim (OPFS-backed, real
// FileSystemFileHandle, just sourced from sandboxed storage instead of a
// native OS picker Playwright can't drive). That lets the tour open a real
// seeded .tmv file, not just the file:// download-fallback path
// generate-screenshots.mjs deliberately exercises.
//
// Playwright records raw WebM (its native format). runDemo() then re-encodes
// that with ffmpeg to a smaller VP9 WebM — laying `music` under it when given —
// and, when `gifFile` is set, a two-pass palette GIF for the README (GitHub
// strips <video> from rendered markdown). ffmpeg is a build-time-only tool
// here — it never enters the app bundle, so the repo's zero-runtime-deps rule
// is untouched. If ffmpeg isn't on PATH the raw WebM is kept as-is and a
// warning is printed; nothing hard-fails.
//
// Every interaction is driven through the click()/type() helpers below
// instead of Playwright's instant .click()/.fill(): they glide a real,
// visible fake cursor (an arrow pointer, injected DOM overlay tracking real
// mousemove events) to the target and type at a readable pace, so the
// recording looks like a person driving the app instead of a script. A
// caption bar (same overlay) narrates each section. Both are pure page-side
// DOM burned into the recording — no subtitle-track muxing.
import { chromium, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { installOpfsPickerShim, setNextOpenName, writeOpfsFile } from '../e2e/opfs-shim.ts'
import { blockUpdateCheck } from '../e2e/helpers.ts'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const OUT_DIR = path.resolve(HERE, '../docs/videos')
export const PASSWORD = 'demo-password-123'
// Bigger than the app's real minimum desktop shell so the recording (and the
// GIF scaled down from it) stays crisp — the layout is fixed-desktop anyway.
export const VIEWPORT = { width: 1600, height: 1000 }

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
    #__demo-caption { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%) translateY(8px);
      background: rgba(18,18,22,0.9); color: #fff; padding: 13px 26px; border-radius: 10px;
      font: 600 20px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: .2px;
      max-width: 82vw; text-align: center; z-index: 2147483000; pointer-events: none;
      opacity: 0; transition: opacity .3s ease, transform .3s ease; box-shadow: 0 6px 20px rgba(0,0,0,.4); }
    #__demo-caption.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    /* A real arrow pointer (SVG), tip at ~(1,1) so left/top can stay = clientX/Y. */
    #__demo-cursor { position: fixed; width: 22px; height: 27px; left: -100px; top: -100px;
      margin: -1px 0 0 -1px; z-index: 2147483001; pointer-events: none;
      background: no-repeat left top / contain
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='27' viewBox='0 0 22 27'%3E%3Cpath d='M1 1 L1 20 L6 15.2 L9.4 23 L12.6 21.6 L9.2 14 L16 14 Z' fill='%23ffffff' stroke='%23111111' stroke-width='1.6' stroke-linejoin='round'/%3E%3C/svg%3E");
      filter: drop-shadow(0 1px 2px rgba(0,0,0,.45));
      transition: transform .1s ease; transform-origin: 2px 2px; }
    #__demo-cursor.click { transform: scale(.82); }
    #__demo-cursor::after { content: ''; position: absolute; left: 1px; top: 1px;
      width: 10px; height: 10px; border: 2px solid rgba(255,64,64,.9); border-radius: 50%;
      transform: translate(-50%, -50%) scale(0); opacity: 0; }
    #__demo-cursor.click::after { animation: __demo-ripple .42s ease-out; }
    @keyframes __demo-ripple {
      from { transform: translate(-50%, -50%) scale(.3); opacity: .85; }
      to { transform: translate(-50%, -50%) scale(3); opacity: 0; } }
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

/**
 * Clicks the start screen's "Open file…" button. runDemo() has already
 * dropped the seed bytes into OPFS and pointed the picker shim at them, so
 * this returns the pre-built document — a password-less (plain text) file, so
 * no password prompt — and the shell is up by the time this resolves.
 */
export async function openSeededFile(page) {
  await click(page, page.getByRole('button', { name: /Open file/ }))
  await expect(page.locator('.tt-shell')).toBeVisible({ timeout: 10000 })
  await pause(page, 700)
}

// --- Server + browser/context/video harness ----------------------------------

function ffmpegAvailable() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
}

function runFfmpeg(args) {
  const res = spawnSync('ffmpeg', args, { stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`ffmpeg exited ${res.status} for: ffmpeg ${args.join(' ')}`)
}

function probeDurationSec(file) {
  const res = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  const d = Number.parseFloat((res.stdout || '').trim())
  return Number.isFinite(d) ? d : null
}

/**
 * Re-encodes the raw Playwright WebM at `rawPath` to `webmDest` (VP9, visibly
 * cleaner and smaller than the raw VP8), mixing in `musicPath` as the
 * soundtrack (trimmed to the video length, 1s fade in / 2s fade out) when
 * given, and — when `gifDest` is given — a two-pass palette GIF for the README
 * (silent, GIF has no audio track). No-ops to a plain move when ffmpeg isn't
 * on PATH.
 */
async function postProcessRecording(rawPath, webmDest, gifDest, tmpDir, musicPath) {
  if (!ffmpegAvailable()) {
    console.warn('ffmpeg not on PATH — keeping the raw Playwright WebM as-is; no GIF generated.')
    await rename(rawPath, webmDest)
    return
  }
  const vArgs = ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-deadline', 'good', '-cpu-used', '3', '-row-mt', '1']
  if (musicPath) {
    const dur = probeDurationSec(rawPath) ?? 60
    const fadeOut = Math.max(0, dur - 2)
    runFfmpeg(['-y', '-i', rawPath, '-i', musicPath,
      '-map', '0:v:0', '-map', '1:a:0', ...vArgs,
      '-c:a', 'libopus', '-b:a', '128k',
      // loudnorm to a background level (well under 0 dBFS, so no clipping),
      // then fade in/out.
      '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=1,afade=t=out:st=${fadeOut.toFixed(2)}:d=2`,
      '-t', dur.toFixed(2), webmDest])
  } else {
    runFfmpeg(['-y', '-i', rawPath, ...vArgs, '-an', webmDest])
  }
  if (gifDest) {
    // README GIF from the ~63s tour: 1.3x speed, 12fps, 800px wide lands it
    // near ~9MB (vs ~16MB at full rate/size) while captions stay readable.
    const vf = 'setpts=PTS/1.3,fps=12,scale=800:-1:flags=lanczos'
    const palette = path.join(tmpDir, 'palette.png')
    runFfmpeg(['-y', '-i', webmDest, '-vf', `${vf},palettegen=stats_mode=diff`, '-update', '1', palette])
    runFfmpeg(['-y', '-i', webmDest, '-i', palette,
      '-lavfi', `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`,
      '-an', '-loop', '0', gifDest])
  }
}

/**
 * Spins up e2e/static-server.mjs on `port`, launches a recorded Chromium
 * context, runs `script(page)`, then finalizes the recording as
 * `docs/videos/<outFile>` (ffmpeg re-encode; see postProcessRecording).
 * `script` gets a real page already at APP_URL with the overlay installed and
 * the OPFS picker shim + update-check block already wired — it should drive
 * the tour and return normally when done.
 *
 * `seed` (optional): `{ filename, bytes }`. When given, the bytes are written
 * into OPFS and the picker shim is pointed at them before `script` runs, so
 * the tour can `openSeededFile(page)` instead of building a document on
 * camera. `gifFile` (optional): also emit `docs/videos/<gifFile>`. `music`
 * (optional): absolute path to an audio file to lay under the WebM.
 */
export async function runDemo({ outFile, gifFile, port, script, seed, music }) {
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
      if (seed) {
        await writeOpfsFile(page, seed.filename, Array.from(seed.bytes))
        await setNextOpenName(page, seed.filename)
      }
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
    const gifDest = gifFile ? path.join(OUT_DIR, gifFile) : null
    await postProcessRecording(path.join(tmpDir, webm), dest, gifDest, tmpDir, music)
    await rm(tmpDir, { recursive: true, force: true })
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1)
    const wrote = [dest, gifDest].filter(Boolean).map((f) => path.relative(process.cwd(), f)).join(' + ')
    console.log(`Wrote ${wrote} (~${elapsedS}s wall)`)
  } finally {
    stopServer()
  }
}
