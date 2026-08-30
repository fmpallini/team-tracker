import { build, transform } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { computeAppOrigin } from './app-origin.mjs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

async function bundle(pwa) {
  const r = await build({
    entryPoints: ['src/main.ts'],
    bundle: true, format: 'iife', write: false, minify: true, charset: 'utf8',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __PWA__: String(pwa),
      __PAGES_URL__: JSON.stringify(pkg.homepage ?? ''),
      __REPO__: JSON.stringify(pkg.repository ?? ''),
    },
  })
  return r.outputFiles[0].text
}

const css = (await transform(readFileSync('styles.css', 'utf8'), { loader: 'css', minify: true })).code
const tpl = readFileSync('index.html', 'utf8')
const page = (js) => tpl.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js)

// PWA variant gets a manifest link + theme-color meta injected before
// </head>; the plain file:// variant (dist/app.html) must not reference
// files that won't exist next to it when the user copies just that one file.
const withPwaHead = (html) =>
  html.replace(
    '</head>',
    '<link rel="manifest" href="manifest.json">\n<meta name="theme-color" content="#3b5a6b">\n</head>'
  )

mkdirSync('dist/pwa', { recursive: true })
// The two variants only differ in the __PWA__ define, so bundle them
// concurrently rather than back-to-back — esbuild's service process handles
// both jobs in parallel instead of one waiting on the other.
const [appJs, pwaJs] = await Promise.all([bundle(false), bundle(true)])

// Guard: a raw C0 control byte or DEL in the bundle survives esbuild's
// charset:'utf8' pass-through, and once inlined into app.html it makes
// Chromium's file:// text decoder substitute U+FFFD — which silently
// corrupts regex character classes (an out-of-order range then throws and
// the whole app fails to boot) and string literals. jsdom-based unit tests
// read the .ts source directly and never see this, so it has to be caught
// here. Tab / LF / CR are legitimate inside minified template literals.
for (const [name, js] of [['app', appJs], ['pwa', pwaJs]]) {
  const m = js.match(new RegExp("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]"))
  if (m) {
    const at = js.indexOf(m[0])
    const cp = m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
    throw new Error(
      `build: "${name}" bundle contains raw control byte U+${cp} at offset ${at} — ` +
      `author it as a \\u escape in source. Context: ${JSON.stringify(js.slice(at - 40, at + 40))}`
    )
  }
}

writeFileSync('dist/app.html', page(appJs))
writeFileSync('dist/pwa/index.html', withPwaHead(page(pwaJs)))

const appOrigin = computeAppOrigin(pkg.homepage)
const manifest = readFileSync('pwa/manifest.json', 'utf8')
  .replaceAll('__APP_VERSION__', pkg.version)
  .replaceAll('__APP_ORIGIN__', appOrigin)
writeFileSync('dist/pwa/manifest.json', manifest)
copyFileSync('pwa/icon.svg', 'dist/pwa/icon.svg')
copyFileSync('pwa/icon-maskable.svg', 'dist/pwa/icon-maskable.svg')
copyFileSync('pwa/icon-192.png', 'dist/pwa/icon-192.png')
copyFileSync('pwa/icon-512.png', 'dist/pwa/icon-512.png')
const sw = readFileSync('pwa/sw.js', 'utf8').replaceAll('__APP_VERSION__', pkg.version)
writeFileSync('dist/pwa/sw.js', sw)

console.log('built dist/app.html and dist/pwa/index.html (+ manifest, sw.js, icon.svg)')
