// Team Tracker service worker — cache-first app shell.
// The version placeholder below is replaced by scripts/build.mjs with the
// real app version at build time, so each release gets a fresh cache name
// and old caches are dropped on activate.
const CACHE = 'tt-v__APP_VERSION__'
const SHELL = [
  './',
  './manifest.json',
  './icon.svg',
  './icon-maskable.svg',
  './icon-192.png',
  './icon-512.png',
]

// Each shell file is fetched with cache: 'reload', not cache.addAll(): addAll
// goes through the HTTP cache, and GitHub Pages serves everything with
// max-age=600, so a worker installed within 10 minutes of a previous load
// could fill its brand-new cache with the previous release's HTML.
function precache(cache) {
  return Promise.all(
    SHELL.map((url) =>
      fetch(url, { cache: 'reload' }).then((res) => {
        if (!res.ok) throw new Error(url + ' ' + res.status)
        return cache.put(url, res)
      })
    )
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(precache).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tt-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  if (new URL(req.url).origin !== self.location.origin) return

  event.respondWith(
    caches.open(CACHE).then((c) => c.match(req)).then((cached) => {
      if (cached) return cached
      return fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put(req, copy))
          }
          return res
        })
        .catch(() =>
          // Offline and not cached. A navigation (a launch URL with a query
          // string, or /index.html) is served the cached app shell; anything
          // else fails as a normal network error.
          req.mode === 'navigate'
            ? caches.open(CACHE).then((c) => c.match('./')).then((shell) => shell || Response.error())
            : Response.error()
        )
    })
  )
})
