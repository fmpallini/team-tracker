// scripts/demo-video-lib.mjs — shared plumbing for the README media:
// generate-demo-video-short.mjs (the ~75s feature tour) and
// generate-screenshots.mjs. Not itself runnable.
//
// Both open the sample workspace (sample-seed.mjs) through withSeededApp(),
// served over http://localhost (e2e/static-server.mjs), not file://: Chromium
// treats localhost as a *secure* context, which unlocks the real File System
// Access API via e2e/opfs-shim.ts's installOpfsPickerShim (OPFS-backed, real
// FileSystemFileHandle, just sourced from sandboxed storage instead of a
// native OS picker Playwright can't drive). So the app runs as it does for a
// Chrome user — the save indicator reads "Saved", not the Firefox-style
// "Export file" of the file:// download fallback.
//
// Playwright records raw WebM (its native format). runDemo() then re-encodes
// that with ffmpeg to a smaller VP9 WebM — laying `music` under it when given —
// and, when `gifFile` is set, a two-pass palette GIF for the README (GitHub
// strips <video> from rendered markdown). ffmpeg is a build-time-only tool
// here — it never enters the app bundle, so the repo's zero-runtime-deps rule
// is untouched. If ffmpeg isn't on PATH the raw WebM is kept as-is and a
// warning is printed; nothing hard-fails.
//
// Every tour interaction is driven through the click() helper below
// instead of Playwright's instant .click()/.fill(): they glide a real,
// visible fake cursor (an arrow pointer, injected DOM overlay tracking real
// mousemove events) to the target, and the tour types at a readable pace, so the
// recording looks like a person driving the app instead of a script. A
// caption bar (same overlay) narrates each section. Both are pure page-side
// DOM burned into the recording — no subtitle-track muxing.
import { chromium, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { installOpfsPickerShim, setNextOpenName, writeOpfsFile } from '../e2e/opfs-shim.ts'
import { blockUpdateCheck } from '../e2e/update-check.ts'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const OUT_DIR = path.resolve(HERE, '../docs/videos')
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

export async function pause(page, ms) {
  await page.waitForTimeout(ms)
}

// --- App flows ----------------------------------------------------------------

export async function switchPaneModule(page, paneIdx, label) {
  const pane = page.locator(`.tt-pane[data-pane-idx="${paneIdx}"]`)
  // A wide pane shows the module tabs (accessible name = the module's); a narrow one the dropdown.
  const tab = pane.locator('button.tt-pane-tab:visible').and(pane.getByLabel(label)).first()
  if (await tab.count()) {
    await click(page, tab)
    return
  }
  await click(page, pane.locator('.tt-pane-modules-btn'))
  await click(page, pane.locator('.tt-pane-menu-item', { hasText: label }).first())
}

/**
 * Clicks the start screen's "Open file…" button. withSeededApp() has already
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
  const vArgs = ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1']
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
    // README GIF from the ~77s tour: 1.3x speed, 12fps, 1200px wide (GitHub
    // shows it ~830px, so text stays sharp on retina) lands near ~9MB.
    const vf = 'setpts=PTS/1.3,fps=12,scale=1200:-1:flags=lanczos'
    const palette = path.join(tmpDir, 'palette.png')
    runFfmpeg(['-y', '-i', webmDest, '-vf', `${vf},palettegen=stats_mode=diff`, '-update', '1', palette])
    runFfmpeg(['-y', '-i', webmDest, '-i', palette,
      '-lavfi', `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4`,
      '-an', '-loop', '0', gifDest])
  }
}

/**
 * Turns the timestamped screencast frames into one near-lossless intermediate
 * (x264 crf 6) that postProcessRecording re-encodes, holding each frame for the
 * time until the next one. The timestamp unit isn't pinned down by the types,
 * so it is inferred from the wall-clock length of the recording.
 */
async function assembleFrames(framesDir, frames, wallSec, tmpDir) {
  if (frames.length === 0) throw new Error('screencast produced no frames')
  const span = frames[frames.length - 1].timestamp - frames[0].timestamp
  const perSec = span / wallSec > 100 ? 1000 : 1
  const lines = []
  frames.forEach((f, i) => {
    const next = frames[i + 1]
    const dur = next ? (next.timestamp - f.timestamp) / perSec : 0.5
    lines.push(`file 'frames/${f.name}'`, `duration ${Math.max(dur, 0.001).toFixed(4)}`)
  })
  lines.push(`file 'frames/${frames[frames.length - 1].name}'`) // concat drops the last duration without a trailing file
  const list = path.join(tmpDir, 'frames.txt')
  await writeFile(list, `${lines.join('\n')}\n`)
  const out = path.join(tmpDir, 'raw.mkv')
  runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=25,format=yuv420p',
    '-c:v', 'libx264', '-crf', '6', '-preset', 'veryfast', out])
  return out
}

/**
 * Spins up e2e/static-server.mjs on `port`, launches Chromium at `viewport`
 * with the OPFS picker shim and the update-check block, opens the app, drops
 * `seed` (`{ filename, bytes }`) into OPFS and points the picker at it, then
 * runs `fn(page)` on the start screen — call openSeededFile() to open it.
 * Returns what `fn` returns; the browser and the server are closed either way.
 */
export async function withSeededApp({ port, viewport, seed }, fn) {
  const appUrl = `http://localhost:${port}/app.html`
  const server = spawn(process.execPath, [path.resolve(HERE, '../e2e/static-server.mjs')], {
    env: { ...process.env, E2E_PORT: String(port) },
    stdio: 'inherit',
  })
  const stopServer = () => { server.kill() }
  process.on('exit', stopServer)
  try {
    await waitForServer(appUrl)
    const browser = await chromium.launch()
    try {
      // App locale follows navigator.language — pinned like playwright.config.ts, so the copy is English on any host.
      const context = await browser.newContext({ viewport, acceptDownloads: true, locale: 'en-US' })
      await installOpfsPickerShim(context)
      await blockUpdateCheck(context)
      const page = await context.newPage()
      await page.goto(appUrl)
      await writeOpfsFile(page, seed.filename, Array.from(seed.bytes))
      await setNextOpenName(page, seed.filename)
      return await fn(page)
    } finally {
      await browser.close()
    }
  } finally {
    stopServer()
  }
}

/**
 * Records `script(page)` against the seeded app (withSeededApp) and finalizes
 * the recording as `docs/videos/<outFile>` (ffmpeg re-encode; see
 * postProcessRecording). `script` gets the start screen with the overlay
 * installed and should drive the tour, opening the file with openSeededFile().
 * `gifFile` (optional): also emit `docs/videos/<gifFile>`. `music`
 * (optional): absolute path to an audio file to lay under the WebM.
 */
export async function runDemo({ outFile, gifFile, port, script, seed, music }) {
  const tmpDir = path.resolve(HERE, `../.video-tmp-${port}`)
  await mkdir(OUT_DIR, { recursive: true })
  await rm(tmpDir, { recursive: true, force: true })
  await mkdir(tmpDir, { recursive: true })

  const startedAt = Date.now()
  const rawPath = await withSeededApp({ port, viewport: VIEWPORT, seed }, async (page) => {
    await installOverlay(page)
    await pause(page, 400)
    // Frames come from the screencast as q100 JPEGs rather than Playwright's
    // recordVideo, whose fixed ~1 Mbit/s VP8 stream smears text before ffmpeg
    // ever sees it. Frames only arrive when the page changes, so each one is
    // kept with its timestamp and replayed for exactly that long below.
    const framesDir = path.join(tmpDir, 'frames')
    await mkdir(framesDir, { recursive: true })
    const frames = []
    const writes = []
    const recStart = Date.now()
    await page.screencast.start({
      size: VIEWPORT,
      quality: 100,
      onFrame: ({ data, timestamp }) => {
        const name = `f${String(frames.length).padStart(6, '0')}.jpg`
        frames.push({ name, timestamp })
        writes.push(writeFile(path.join(framesDir, name), data))
      },
    })
    await script(page)
    await page.screencast.stop()
    await Promise.all(writes)
    return assembleFrames(framesDir, frames, (Date.now() - recStart) / 1000, tmpDir)
  })

  const dest = path.join(OUT_DIR, outFile)
  const gifDest = gifFile ? path.join(OUT_DIR, gifFile) : null
  await postProcessRecording(rawPath, dest, gifDest, tmpDir, music)
  await rm(tmpDir, { recursive: true, force: true })
  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1)
  const wrote = [dest, gifDest].filter(Boolean).map((f) => path.relative(process.cwd(), f)).join(' + ')
  console.log(`Wrote ${wrote} (~${elapsedS}s wall)`)
}
