// pwa/sw.js and pwa/manifest.json are plain assets copied by scripts/build.mjs,
// not modules — so they're exercised here by evaluating/parsing the source.
import { describe, it, expect, vi } from 'vitest'
import swSource from '../pwa/sw.js?raw'
import manifestSource from '../pwa/manifest.json?raw'

type FetchHandler = (event: { request: { method: string; url: string; mode: string }; respondWith(p: Promise<Response>): void }) => void

/** Evaluates sw.js against a fake ServiceWorkerGlobalScope and returns its fetch listener. */
function loadFetchHandler(opts: { cached?: Map<string, Response>; fetchImpl: () => Promise<Response> }): FetchHandler {
  const listeners: Record<string, FetchHandler> = {}
  const cache = {
    match: async (req: string | { url: string }) => opts.cached?.get(typeof req === 'string' ? req : req.url),
    put: async () => {},
    addAll: async () => {},
  }
  const self = {
    location: { origin: 'https://example.test' },
    addEventListener: (type: string, fn: FetchHandler) => { listeners[type] = fn },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  }
  const caches = { open: async () => cache, keys: async () => [], delete: async () => true }
  // Repo-owned source, no interpolation — the only way to run a classic
  // (non-module) service worker script against fake globals.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'caches', 'fetch', 'Response', swSource)(self, caches, opts.fetchImpl, Response)
  return listeners['fetch']!
}

function run(handler: FetchHandler, url: string, mode: string): Promise<Response> {
  let out!: Promise<Response>
  handler({ request: { method: 'GET', url, mode }, respondWith: (p) => { out = p } })
  return out
}

describe('sw.js offline fallback', () => {
  const shell = new Response('shell')
  const offline = () => Promise.reject(new TypeError('offline'))

  it('serves the cached app shell for an uncached navigation while offline', async () => {
    const handler = loadFetchHandler({ cached: new Map([['./', shell]]), fetchImpl: offline })
    const res = await run(handler, 'https://example.test/?launch=1', 'navigate')
    expect(await res.text()).toBe('shell')
  })

  it('fails an uncached non-navigation request instead of serving the shell', async () => {
    const handler = loadFetchHandler({ cached: new Map([['./', shell]]), fetchImpl: offline })
    const res = await run(handler, 'https://example.test/other.json', 'cors')
    expect(res.type).toBe('error')
  })

  it('prefers a cached copy over the network', async () => {
    const fetchImpl = vi.fn(offline)
    const handler = loadFetchHandler({
      cached: new Map([['https://example.test/icon.svg', new Response('icon')]]),
      fetchImpl,
    })
    const res = await run(handler, 'https://example.test/icon.svg', 'no-cors')
    expect(await res.text()).toBe('icon')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('sw.js install', () => {
  function install(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
    const listeners: Record<string, (event: { waitUntil(p: Promise<unknown>): void }) => void> = {}
    const put = vi.fn(async () => {})
    const cache = { match: async () => undefined, put }
    const self = {
      location: { origin: 'https://example.test' },
      addEventListener: (type: string, fn: (event: { waitUntil(p: Promise<unknown>): void }) => void) => { listeners[type] = fn },
      skipWaiting: vi.fn(async () => {}),
      clients: { claim: async () => {} },
    }
    const caches = { open: async () => cache, keys: async () => [], delete: async () => true }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('self', 'caches', 'fetch', 'Response', swSource)(self, caches, fetchImpl, Response)
    let done!: Promise<unknown>
    listeners['install']!({ waitUntil: (p) => { done = p } })
    return { done, put, skipWaiting: self.skipWaiting }
  }

  it('precaches the shell bypassing the HTTP cache, so a new release never stores the previous one', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('fresh'))
    const { done, put, skipWaiting } = install(fetchImpl)
    await done
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0)
    for (const call of fetchImpl.mock.calls) expect(call[1]).toEqual({ cache: 'reload' })
    expect(put).toHaveBeenCalledTimes(fetchImpl.mock.calls.length)
    expect(skipWaiting).toHaveBeenCalled()
  })

  it('fails the install, without taking over, when a shell file does not load', async () => {
    const { done, skipWaiting } = install(async () => new Response('nope', { status: 404 }))
    await expect(done).rejects.toThrow()
    expect(skipWaiting).not.toHaveBeenCalled()
  })
})

describe('manifest.json', () => {
  const manifest = JSON.parse(manifestSource) as {
    icons: { src: string }[]
    file_handlers: { icons?: { src: string }[] }[]
  }

  it('gives the .tmv file association icons that are also shipped as app icons', () => {
    const shipped = manifest.icons.map((i) => i.src)
    const icons = manifest.file_handlers[0]?.icons ?? []
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) expect(shipped).toContain(icon.src)
  })
})
