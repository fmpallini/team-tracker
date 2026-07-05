// Team Tracker service worker — cache-first app shell.
// The version placeholder below is replaced by scripts/build.mjs with the
// real app version at build time, so each release gets a fresh cache name
// and old caches are dropped on activate.
const CACHE = 'tt-v__APP_VERSION__'
const SHELL = ['./', './manifest.json', './icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
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
        .catch(() => cached)
    })
  )
})
