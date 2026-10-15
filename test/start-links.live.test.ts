// Live reachability check for the start screen's external links. Hits the
// network, so it is skipped in normal runs (pre-push, CI) and only runs from
// .github/workflows/links-check.yml (weekly) or by hand:
//   CHECK_LINKS=1 npx vitest run test/start-links.live.test.ts
import { describe, expect, test } from 'vitest'
import { START_LINKS } from '../src/ui/start'

const live = process.env.CHECK_LINKS === '1'

// Vendors serve bots a challenge page or 403 on a bare fetch; a browser-like
// UA keeps the check about "does the URL still exist", not "do they like Node".
const HEADERS = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' }

async function status(url: string): Promise<number> {
  // The #fragment never reaches the server; strip it so the log shows what was requested.
  const target = url.split('#')[0]!
  let last = 0
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(target, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20_000) })
      await res.body?.cancel()
      last = res.status
      if (res.ok) return last
    } catch {
      last = 0
    }
  }
  return last
}

describe.skipIf(!live)('start screen links are reachable', () => {
  test.each(Object.entries(START_LINKS))('%s', async (_name, url) => {
    const code = await status(url)
    expect(code, `${url} answered ${code || 'no response'}`).toBeGreaterThanOrEqual(200)
    expect(code, `${url} answered ${code}`).toBeLessThan(300)
  }, 45_000)
})
