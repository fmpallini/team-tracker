import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

async function bundle(pwa) {
  const r = await build({
    entryPoints: ['src/main.ts'],
    bundle: true, format: 'iife', write: false, minify: true,
    define: { __APP_VERSION__: JSON.stringify(pkg.version), __PWA__: String(pwa) },
  })
  return r.outputFiles[0].text
}

const css = readFileSync('styles.css', 'utf8')
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

copyFileSync('pwa/manifest.json', 'dist/pwa/manifest.json')
copyFileSync('pwa/icon.svg', 'dist/pwa/icon.svg')
const sw = readFileSync('pwa/sw.js', 'utf8').replaceAll('__APP_VERSION__', pkg.version)
writeFileSync('dist/pwa/sw.js', sw)

console.log('built dist/app.html and dist/pwa/index.html (+ manifest, sw.js, icon.svg)')
