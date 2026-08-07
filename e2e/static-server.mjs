// e2e/static-server.mjs — zero-dependency static file server for dist/, used
// by playwright.config.ts's `webServer`. Existing e2e coverage loads
// dist/app.html via file://, which Chromium treats as an insecure context —
// window.showOpenFilePicker/showSaveFilePicker throw there, and OPFS
// (navigator.storage.getDirectory()) isn't available at all. Serving over
// http://localhost (which Chromium treats as secure, same as https) unlocks
// both, letting e2e drive the real File System Access API instead of only
// the download-fallback path.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist')
const PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 4319

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
}

const server = createServer((req, res) => {
  void (async () => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    // Strips any leading '../' segments so a crafted request path can't escape ROOT.
    const safePath = normalize(urlPath).replace(/^([/\\]?\.\.[/\\])+/, '')
    const filePath = join(ROOT, safePath)
    try {
      const data = await readFile(filePath)
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('Not found')
    }
  })()
})

server.listen(PORT, () => {
  console.log(`e2e static server on http://localhost:${PORT}`)
})
