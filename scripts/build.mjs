import { build, transform } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

async function bundle(pwa) {
  const r = await build({
    entryPoints: ['src/main.ts'],
    bundle: true, format: 'iife', write: false, minify: true, charset: 'utf8',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __PWA__: String(pwa),
      __PAGES_URL__: JSON.stringify(pkg.homepage ?? ''),
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
writeFileSync('dist/app.html', page(await bundle(false)))
writeFileSync('dist/pwa/index.html', withPwaHead(page(await bundle(true))))

// __APP_ORIGIN__ is the site origin, not pkg.homepage's /team-tracker/ subpath:
// the manifest's top-level "id" ("/") resolves against the manifest URL as an
// absolute-path reference, so Chrome's actually-computed app identity for every
// install to date is the origin root (verified via DevTools Application panel
// "Computed App Id"), not the subpath. The related_applications self-entry
// below must match that already-installed identity exactly or
// getInstalledRelatedApps() never matches.
const appOrigin = pkg.homepage ? `${new URL(pkg.homepage).origin}/` : ''
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
