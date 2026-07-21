# Update Check & Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Check GitHub for a newer release at most once per 24h while the app is running, and notify the user — with a save-verified reload offer on the PWA build, a releases-page link on the standalone build.

**Architecture:** A headless `src/core/update-check.ts` (gate + fetch + compare, fully DI'd for tests) feeds a `src/ui/update-notice.ts` banner (same DI-opts pattern as the existing `src/ui/promo.ts`). `main.ts` wires a boot-time check plus an hourly re-check timer (the 24h gate itself lives in `update-check.ts`, not the timer), and owns the one piece of real risk — the PWA reload must save the open document and *verify* the save landed before navigating away.

**Tech Stack:** TypeScript, esbuild defines, vitest/jsdom, zero runtime deps (uses the global `fetch`).

## Global Constraints

- Zero runtime dependencies — no new npm packages (per `CLAUDE.md`).
- All user-visible strings go through `t(locale, key)`; every new key added to **both** `pt-BR` and `en-US` in `src/core/i18n.ts` (`en` is typed `Record<MsgKey, string>` against `keyof typeof pt`, so a missing English key is a compile error — use that as your check).
- Every `src` module needs a matching `test/*.test.ts`, **except** `src/main.ts`, which the codebase already leaves untested (pure wiring/glue) — do not add a `test/main.test.ts` for the wiring in Task 5.
- Follow the exact spec at `docs/superpowers/specs/2026-07-21-update-check-design.md` for the reload data-loss guarantee: `saveNow({ explicit: true })` → `flush()` → check `store.dirty` → only reload if not dirty.
- Comments referencing "Task N" trace to `docs/superpowers/plans/2026-07-02-team-tracker.md` — this plan's tasks are new work, not a continuation of that numbering; don't reuse "Task N" comment style for these unless genuinely documenting the same kind of nonobvious concurrency/lifecycle reasoning `save-controller.ts`/`main.ts` already use it for.

---

### Task 1: `__REPO__` build define

**Files:**
- Modify: `package.json` (add `"repository"` field)
- Modify: `scripts/build.mjs:10-14` (add `__REPO__` to both defines)
- Modify: `vitest.config.ts:4` (add `__REPO__` test define)
- Modify: `src/main.ts:1` (add `__REPO__` to the `declare global` line)

**Interfaces:**
- Produces: a global `__REPO__: string` compile-time constant, value `"fmpallini/team-tracker"` in real builds, `"fmpallini/team-tracker"` in tests too (same real value — no need for a fake in tests since it's just a string used to build URLs).

No test file for this task — it's a build-config change with no runtime behavior of its own; Task 2/4's tests exercise it indirectly via the `repo` DI param.

- [ ] **Step 1: Add the `repository` field to `package.json`**

Add this line right after `"homepage"` (line 4):

```json
  "homepage": "https://fmpallini.github.io/team-tracker/",
  "repository": "fmpallini/team-tracker",
```

- [ ] **Step 2: Add `__REPO__` to the esbuild defines in `scripts/build.mjs`**

In `scripts/build.mjs`, the `define` block (currently lines 10-14) becomes:

```js
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __PWA__: String(pwa),
      __PAGES_URL__: JSON.stringify(pkg.homepage ?? ''),
      __REPO__: JSON.stringify(pkg.repository ?? ''),
    },
```

- [ ] **Step 3: Add `__REPO__` to the vitest define in `vitest.config.ts`**

`vitest.config.ts` becomes:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { globals: true, environment: 'jsdom', pool: 'forks' },
  define: {
    __APP_VERSION__: '"test"',
    __PWA__: 'false',
    __PAGES_URL__: '"https://example.test/app/"',
    __REPO__: '"fmpallini/team-tracker"',
  },
})
```

- [ ] **Step 4: Add `__REPO__` to the `declare global` in `src/main.ts`**

`src/main.ts:1` becomes:

```ts
declare global { const __APP_VERSION__: string; const __PWA__: boolean; const __PAGES_URL__: string; const __REPO__: string }
```

- [ ] **Step 5: Verify the build and typecheck still pass**

Run: `npm run build && npm run typecheck`
Expected: both succeed with no errors (nothing yet reads `__REPO__` in application code, so this is purely a define plumbing check).

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/build.mjs vitest.config.ts src/main.ts
git commit -m "build: add __REPO__ define for the upcoming update-check feature"
```

---

### Task 2: `src/core/update-check.ts` — headless check logic

**Files:**
- Create: `src/core/update-check.ts`
- Test: `test/update-check.test.ts`

**Interfaces:**
- Produces:
  - `export const LAST_CHECK_STORAGE_KEY = 'tt-last-update-check'`
  - `export function shouldCheck(lastCheckIso: string | null, now: number): boolean`
  - `export function isNewer(latestTag: string, currentVersion: string): boolean`
  - `export type UpdateCheckResult = { status: 'newer'; version: string } | { status: 'up-to-date' } | { status: 'error' }`
  - `export async function checkForUpdate(fetchImpl: typeof fetch, currentVersion: string, repo: string): Promise<UpdateCheckResult>`
- Consumes: nothing from other new modules — this is the base layer.

`UpdateCheckResult` (rather than the spec's plain `string | null`) is what lets the caller in Task 5 distinguish "no newer version" from "the check itself failed" — required for the spec's rule that the 24h timestamp is written on completion but *not* on failure.

- [ ] **Step 1: Write the failing tests**

Create `test/update-check.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { shouldCheck, isNewer, checkForUpdate, LAST_CHECK_STORAGE_KEY } from '../src/core/update-check'

describe('shouldCheck', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  it('is true when there is no prior timestamp', () => {
    expect(shouldCheck(null, Date.now())).toBe(true)
  })

  it('is true when the timestamp is unparseable', () => {
    expect(shouldCheck('not-a-date', Date.now())).toBe(true)
  })

  it('is false just under 24h since the last check', () => {
    const now = Date.parse('2026-07-21T12:00:00.000Z')
    const last = new Date(now - DAY_MS + 1000).toISOString()
    expect(shouldCheck(last, now)).toBe(false)
  })

  it('is true at exactly 24h since the last check', () => {
    const now = Date.parse('2026-07-21T12:00:00.000Z')
    const last = new Date(now - DAY_MS).toISOString()
    expect(shouldCheck(last, now)).toBe(true)
  })

  it('is true well past 24h since the last check', () => {
    const now = Date.parse('2026-07-21T12:00:00.000Z')
    const last = new Date(now - DAY_MS * 3).toISOString()
    expect(shouldCheck(last, now)).toBe(true)
  })
})

describe('isNewer', () => {
  it('is true when the tag is a newer patch', () => {
    expect(isNewer('v1.5.3', '1.5.2')).toBe(true)
  })

  it('is true when the tag is a newer minor/major', () => {
    expect(isNewer('v1.6.0', '1.5.2')).toBe(true)
    expect(isNewer('v2.0.0', '1.5.2')).toBe(true)
  })

  it('is false when the tag equals the current version', () => {
    expect(isNewer('v1.5.2', '1.5.2')).toBe(false)
  })

  it('is false when the tag is older', () => {
    expect(isNewer('v1.4.9', '1.5.2')).toBe(false)
  })

  it('handles a tag with no leading v', () => {
    expect(isNewer('1.5.3', '1.5.2')).toBe(true)
  })
})

describe('checkForUpdate', () => {
  const REPO = 'fmpallini/team-tracker'

  it('returns status "newer" with the version when the tag is ahead', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v9.9.9' }),
    })
    const result = await checkForUpdate(fetchImpl as unknown as typeof fetch, '1.5.2', REPO)
    expect(result).toEqual({ status: 'newer', version: '9.9.9' })
    expect(fetchImpl).toHaveBeenCalledWith(`https://api.github.com/repos/${REPO}/releases/latest`)
  })

  it('returns status "up-to-date" when the tag matches the current version', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v1.5.2' }),
    })
    const result = await checkForUpdate(fetchImpl as unknown as typeof fetch, '1.5.2', REPO)
    expect(result).toEqual({ status: 'up-to-date' })
  })

  it('returns status "error" on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    const result = await checkForUpdate(fetchImpl as unknown as typeof fetch, '1.5.2', REPO)
    expect(result).toEqual({ status: 'error' })
  })

  it('returns status "error" when fetch throws (offline)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const result = await checkForUpdate(fetchImpl as unknown as typeof fetch, '1.5.2', REPO)
    expect(result).toEqual({ status: 'error' })
  })

  it('returns status "error" on malformed JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ no_tag_here: true }) })
    const result = await checkForUpdate(fetchImpl as unknown as typeof fetch, '1.5.2', REPO)
    expect(result).toEqual({ status: 'error' })
  })
})

it('exports the localStorage key used for the 24h gate', () => {
  expect(LAST_CHECK_STORAGE_KEY).toBe('tt-last-update-check')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/update-check.test.ts`
Expected: FAIL — `Cannot find module '../src/core/update-check'`

- [ ] **Step 3: Implement `src/core/update-check.ts`**

```ts
// src/core/update-check.ts
export const LAST_CHECK_STORAGE_KEY = 'tt-last-update-check'

const DAY_MS = 24 * 60 * 60 * 1000

export function shouldCheck(lastCheckIso: string | null, now: number): boolean {
  if (lastCheckIso === null) return true
  const last = Date.parse(lastCheckIso)
  if (Number.isNaN(last)) return true
  return now - last >= DAY_MS
}

function parseVersion(v: string): [number, number, number] | null {
  const stripped = v.startsWith('v') ? v.slice(1) : v
  const parts = stripped.split('.')
  if (parts.length !== 3) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null
  return nums as [number, number, number]
}

export function isNewer(latestTag: string, currentVersion: string): boolean {
  const latest = parseVersion(latestTag)
  const current = parseVersion(currentVersion)
  if (!latest || !current) return false
  for (let i = 0; i < 3; i++) {
    if (latest[i] > current[i]) return true
    if (latest[i] < current[i]) return false
  }
  return false
}

export type UpdateCheckResult = { status: 'newer'; version: string } | { status: 'up-to-date' } | { status: 'error' }

export async function checkForUpdate(
  fetchImpl: typeof fetch,
  currentVersion: string,
  repo: string
): Promise<UpdateCheckResult> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`)
    if (!res.ok) return { status: 'error' }
    const body = (await res.json()) as { tag_name?: unknown }
    if (typeof body.tag_name !== 'string') return { status: 'error' }
    const version = body.tag_name.startsWith('v') ? body.tag_name.slice(1) : body.tag_name
    if (!parseVersion(version)) return { status: 'error' }
    return isNewer(body.tag_name, currentVersion) ? { status: 'newer', version } : { status: 'up-to-date' }
  } catch (e) {
    console.error(e)
    return { status: 'error' }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/update-check.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean

- [ ] **Step 6: Commit**

```bash
git add src/core/update-check.ts test/update-check.test.ts
git commit -m "feat: add headless update-check (24h gate, version compare, GitHub fetch)"
```

---

### Task 3: i18n keys

**Files:**
- Modify: `src/core/i18n.ts:384` (end of `pt` object)
- Modify: `src/core/i18n.ts:766` (end of `en` object — line number shifts by however many lines Task 3's `pt` insert adds; find it by the closing `}` right before `const dicts`)

**Interfaces:**
- Produces: four new `MsgKey`s — `update_notice_title`, `update_notice_reload`, `update_notice_view_release`, `update_notice_dismiss_title` — consumed by Task 4's `update-notice.ts`.

No standalone test — `i18n.test.ts` (if present) already asserts locale-parity structurally via the `Record<MsgKey, string>` type; a missing `en` key is a TypeScript compile error, which Step 3 below checks directly.

- [ ] **Step 1: Add the Portuguese keys**

In `src/core/i18n.ts`, insert immediately before the `} as const` that closes `pt` (currently line 385, right after `team_picker_confirm_btn: 'Confirmar',` on line 384):

```ts
  update_notice_title: 'Nova versão {version} disponível',
  update_notice_reload: 'Recarregar agora',
  update_notice_view_release: 'Ver versão',
  update_notice_dismiss_title: 'Dispensar',
```

- [ ] **Step 2: Add the English keys**

Insert immediately before the `}` that closes `en` (right after `team_picker_confirm_btn: 'Confirm',`):

```ts
  update_notice_title: 'New version {version} available',
  update_notice_reload: 'Reload now',
  update_notice_view_release: 'View release',
  update_notice_dismiss_title: 'Dismiss',
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean — if the English block is missing a key, this fails with a `Record<MsgKey, string>` assignability error naming the missing property.

- [ ] **Step 4: Commit**

```bash
git add src/core/i18n.ts
git commit -m "feat: add update-notice i18n keys (pt-BR, en-US)"
```

---

### Task 4: `src/ui/update-notice.ts` — the banner

**Files:**
- Create: `src/ui/update-notice.ts`
- Test: `test/update-notice.test.ts`
- Modify: `styles.css` (append banner rules near the existing `.tt-readonly-banner` block, styles.css:314-315)

**Interfaces:**
- Consumes: `t(locale, key, params?)` from `../core/i18n` (`Locale`, `MsgKey` types); `el()` from `./dom`.
- Produces:
  - `export interface UpdateNoticeOpts { pwa?: boolean; repo?: string }`
  - `export function showUpdateNotice(locale: Locale, latestVersion: string, onReload: () => Promise<void>, onDismiss: (version: string) => void, opts?: UpdateNoticeOpts): HTMLElement`
  - CSS classes: `.tt-update-banner`, `.tt-update-banner-action`, `.tt-update-banner-dismiss`

`onReload` and `onDismiss` are injected by the caller (Task 5's `main.ts`) rather than imported directly — this module never touches `save-controller.ts` or `location.reload()` itself, keeping it a pure DOM/i18n unit testable without any app-controller state.

- [ ] **Step 1: Write the failing tests**

Create `test/update-notice.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { showUpdateNotice } from '../src/ui/update-notice'

const LOCALE = 'en-US' as const
const REPO = 'fmpallini/team-tracker'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('PWA variant', () => {
  it('renders a reload button that calls onReload', async () => {
    const onReload = vi.fn().mockResolvedValue(undefined)
    const onDismiss = vi.fn()
    const banner = showUpdateNotice(LOCALE, '9.9.9', onReload, onDismiss, { pwa: true })
    document.body.appendChild(banner)
    expect(banner.textContent).toContain('9.9.9')
    const btn = banner.querySelector<HTMLButtonElement>('.tt-update-banner-action')!
    expect(btn.textContent).toBe('Reload now')
    btn.click()
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('disables the reload button while onReload is pending and re-enables if it resolves without navigating', async () => {
    let resolvePending: () => void
    const pending = new Promise<void>((r) => { resolvePending = r })
    const onReload = vi.fn().mockReturnValue(pending)
    const banner = showUpdateNotice(LOCALE, '9.9.9', onReload, vi.fn(), { pwa: true })
    document.body.appendChild(banner)
    const btn = banner.querySelector<HTMLButtonElement>('.tt-update-banner-action')!
    btn.click()
    expect(btn.disabled).toBe(true)
    resolvePending!()
    await pending
    await Promise.resolve()
    expect(btn.disabled).toBe(false)
  })
})

describe('standalone variant', () => {
  it('renders a "view release" action that opens the releases page', () => {
    const banner = showUpdateNotice(LOCALE, '9.9.9', vi.fn(), vi.fn(), { pwa: false, repo: REPO })
    document.body.appendChild(banner)
    const btn = banner.querySelector<HTMLButtonElement>('.tt-update-banner-action')!
    expect(btn.textContent).toBe('View release')
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    btn.click()
    expect(open).toHaveBeenCalledWith(`https://github.com/${REPO}/releases/latest`, '_blank', 'noopener')
    open.mockRestore()
  })
})

describe('dismiss', () => {
  it('removes the banner and reports the dismissed version', () => {
    const onDismiss = vi.fn()
    const banner = showUpdateNotice(LOCALE, '9.9.9', vi.fn(), onDismiss, { pwa: true })
    document.body.appendChild(banner)
    banner.querySelector<HTMLButtonElement>('.tt-update-banner-dismiss')!.click()
    expect(banner.isConnected).toBe(false)
    expect(onDismiss).toHaveBeenCalledWith('9.9.9')
  })
})

describe('replacing an existing banner', () => {
  it('removes any prior .tt-update-banner before appending itself', () => {
    const first = showUpdateNotice(LOCALE, '1.0.0', vi.fn(), vi.fn(), { pwa: true })
    document.body.appendChild(first)
    const second = showUpdateNotice(LOCALE, '2.0.0', vi.fn(), vi.fn(), { pwa: true })
    document.body.appendChild(second)
    expect(document.querySelectorAll('.tt-update-banner').length).toBe(1)
    expect(document.body.textContent).toContain('2.0.0')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/update-notice.test.ts`
Expected: FAIL — `Cannot find module '../src/ui/update-notice'`

- [ ] **Step 3: Implement `src/ui/update-notice.ts`**

```ts
// src/ui/update-notice.ts
// Notifies the user a newer release exists (spec:
// docs/superpowers/specs/2026-07-21-update-check-design.md). PWA build
// (__PWA__): offers a reload that the caller wires to a save-then-verify
// flow (this module never touches save-controller.ts or location.reload()
// itself — see onReload). Standalone build: links to the GitHub releases
// page, since a static file:// build can't self-update.
import { t, type Locale } from '../core/i18n'
import { el } from './dom'

export interface UpdateNoticeOpts {
  pwa?: boolean
  repo?: string
}

function resolve(opts?: UpdateNoticeOpts): { pwa: boolean; repo: string } {
  return { pwa: opts?.pwa ?? __PWA__, repo: opts?.repo ?? __REPO__ }
}

export function showUpdateNotice(
  locale: Locale,
  latestVersion: string,
  onReload: () => Promise<void>,
  onDismiss: (version: string) => void,
  opts?: UpdateNoticeOpts
): HTMLElement {
  const { pwa, repo } = resolve(opts)
  document.querySelector('.tt-update-banner')?.remove()

  const actionBtn: HTMLButtonElement = pwa
    ? el(
        'button',
        {
          class: 'tt-btn tt-update-banner-action',
          type: 'button',
          onclick: () => {
            actionBtn.disabled = true
            onReload().finally(() => {
              // Only reachable if onReload resolved without navigating away
              // (the save failed and the caller aborted the reload).
              actionBtn.disabled = false
            })
          },
        },
        t(locale, 'update_notice_reload')
      )
    : el(
        'button',
        {
          class: 'tt-btn tt-update-banner-action',
          type: 'button',
          onclick: () => window.open(`https://github.com/${repo}/releases/latest`, '_blank', 'noopener'),
        },
        t(locale, 'update_notice_view_release')
      )

  const dismissBtn = el(
    'button',
    {
      class: 'tt-update-banner-dismiss',
      type: 'button',
      title: t(locale, 'update_notice_dismiss_title'),
      onclick: () => {
        banner.remove()
        onDismiss(latestVersion)
      },
    },
    '×'
  )

  const banner = el(
    'div',
    { class: 'tt-update-banner' },
    el('span', { class: 'tt-update-banner-text' }, t(locale, 'update_notice_title', { version: latestVersion })),
    actionBtn,
    dismissBtn
  )
  return banner
}
```

- [ ] **Step 4: Run the tests to verify they pass**

`actionBtn`'s and `dismissBtn`'s `onclick` closures reference `actionBtn`/`banner` before those `const`s finish initializing — this is safe (the closures only run later, on an actual click, by which point the assignment has long completed) and is the same self-referencing pattern `src/ui/promo.ts`'s own dismiss button already uses.

Run: `npx vitest run test/update-notice.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Add the banner CSS**

In `styles.css`, right after the `.tt-readonly-takeover-btn:hover` rule (currently line 314), add:

```css
/* Update-available banner (fixed to viewport top: can show before any document is open) */
.tt-update-banner {
  display: flex; align-items: center; justify-content: center; gap: .75rem;
  padding: .4rem .75rem; background: var(--accent); color: #fff; font-size: .9rem; text-align: center;
  position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
}
.tt-update-banner-action { border-color: rgba(255, 255, 255, .6); color: #fff; }
.tt-update-banner-action:hover { border-color: #fff; opacity: .85; }
.tt-update-banner-action:disabled { opacity: .5; cursor: default; }
.tt-update-banner-dismiss { border: none; background: none; color: #fff; font-size: 1.1rem; cursor: pointer; padding: .1rem .3rem; }
.tt-update-banner-dismiss:hover { opacity: .85; }
```

- [ ] **Step 6: Typecheck, lint, and full test run**

Run: `npm run typecheck && npm run lint && npx vitest run test/update-notice.test.ts`
Expected: all clean/passing

- [ ] **Step 7: Commit**

```bash
git add src/ui/update-notice.ts test/update-notice.test.ts styles.css
git commit -m "feat: add update-notice banner (PWA reload / standalone release link)"
```

---

### Task 5: Wire it up in `main.ts`

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes:
  - `shouldCheck`, `checkForUpdate`, `LAST_CHECK_STORAGE_KEY`, `UpdateCheckResult` from `./core/update-check`
  - `showUpdateNotice` from `./ui/update-notice`
  - Existing `app: AppController | null`, `saveCtl: SaveController` (already created inside `onDocumentOpened`), `store.dirty` (existing `Store` interface)
- Produces: no new exports — this task only adds wiring inside `main.ts`.

No dedicated test file for this task, per the Global Constraints note — `main.ts` orchestration is already untested in this codebase (`onDocumentOpened` itself has no direct unit test; its pieces are tested in isolation in `core/`/`ui/`). Verification for this task is the manual smoke test in Step 6.

- [ ] **Step 1: Add the new imports and the `activeSaveController` closure ref**

In `src/main.ts`, add to the import block (near the other `./core/*` and `./ui/*` imports, e.g. right after the `initInstallCapture` import on line 32):

```ts
import { shouldCheck, checkForUpdate, LAST_CHECK_STORAGE_KEY } from './core/update-check'
import { showUpdateNotice } from './ui/update-notice'
```

Then, right after the existing `let app: AppController | null = null` (line 60), add:

```ts
// Set in onDocumentOpened, cleared in closeFile — same closure-only pattern
// as `app` itself. Needed by reloadForUpdate() below: the update banner can
// be dismissed and re-shown across open/close cycles, so it can't just close
// over the SaveController from whatever onDocumentOpened call created it.
let activeSaveController: SaveController | null = null
```

- [ ] **Step 2: Set/clear `activeSaveController` alongside `app`**

In `onDocumentOpened`, right after the existing `app = { store, session, password, shell, pm, dispose }` (line 247), add:

```ts
  activeSaveController = saveCtl
```

In `closeFile()`, right after `app = null` (line 448), add:

```ts
      activeSaveController = null
```

- [ ] **Step 3: Add `reloadForUpdate`**

Add this function above `showStartScreen(detectBrowserLocale(), onDocumentOpened)` (currently line 552):

```ts
/**
 * The update banner's PWA reload action. Must guarantee no silent data loss:
 * `saveCtl.flush()` alone only waits out an *already in-flight* save, and
 * `saveNow()` resolves normally even when the write itself fails (errors
 * surface via save-controller.ts's own toast, not a rejection here). So this
 * explicitly saves, waits for that save (and any trailing round) to settle,
 * then checks `store.dirty` as the one signal that survives regardless of
 * *why* the save didn't land (write error, external-change conflict, or a
 * read-only tab that never attempts one in the first place) — if still
 * dirty, abort the reload and leave whatever error UI save-controller.ts
 * already raised as the user's recovery path.
 */
async function reloadForUpdate(): Promise<void> {
  const saveCtl = activeSaveController
  const store = app?.store ?? null
  if (saveCtl && store) {
    await saveCtl.saveNow({ explicit: true })
    await saveCtl.flush()
    if (store.dirty) return
  }
  location.reload()
}
```

- [ ] **Step 4: Add the update-check boot + periodic timer**

Add this right after `reloadForUpdate` (still above `showStartScreen(...)`):

```ts
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

let dismissedUpdateVersion: string | null = null

async function runUpdateCheck(): Promise<void> {
  if (!shouldCheck(localStorage.getItem(LAST_CHECK_STORAGE_KEY), Date.now())) return
  const result = await checkForUpdate(fetch, __APP_VERSION__, __REPO__)
  if (result.status === 'error') return
  localStorage.setItem(LAST_CHECK_STORAGE_KEY, new Date().toISOString())
  if (result.status !== 'newer' || result.version === dismissedUpdateVersion) return
  const locale = app?.store.doc.prefs.locale ?? detectBrowserLocale()
  showUpdateNotice(locale, result.version, reloadForUpdate, (v) => {
    dismissedUpdateVersion = v
  })
}
```

- [ ] **Step 5: Start the check at boot**

Right after `showStartScreen(detectBrowserLocale(), onDocumentOpened)` (line 552), add:

```ts

void runUpdateCheck()
setInterval(() => void runUpdateCheck(), UPDATE_CHECK_INTERVAL_MS)
```

- [ ] **Step 6: Manual smoke test**

First, the real (unmodified) build — confirms nothing errors and, if `package.json`'s version happens to already be behind the latest published tag, the banner shows for real:

Run: `npm run build`, then serve `dist/pwa/` over http (e.g. `npx http-server dist/pwa -p 8080`) and open it in a browser with devtools open. Confirm no console errors on load.

Then force the "newer version exists" path end-to-end (the fetch itself is real — only the local version is faked, so this exercises the exact production code path):
1. Temporarily edit `package.json`'s `"version"` to `"0.0.1"`.
2. `npm run build`, serve `dist/pwa/` again, hard-reload the tab (so the fresh bundle's boot-time `runUpdateCheck()` fires against a clean `localStorage`).
3. Confirm the banner appears with "Reload now" and the correct `{version}` text.
4. Open a document, type an edit (leave it dirty), click "Reload now" — confirm the page does **not** reload (save-then-verify aborted it) and the edit is still there after dismissing whatever error state appeared.
5. Let the edit actually save (or start from a clean/no-doc state), click "Reload now" again — confirm the page reloads.
6. Still with `"version": "0.0.1"`, also open `dist/app.html` (the standalone build) directly via `file://` and confirm the "View release" button opens `https://github.com/fmpallini/team-tracker/releases/latest` in a new tab.
7. Revert `package.json`'s `"version"` back to its real value and `npm run build` again before committing — the temporary `"0.0.1"` must not ship.

- [ ] **Step 7: Typecheck, lint, full test suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all clean/passing

- [ ] **Step 8: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire update-check boot/timer and save-verified PWA reload"
```

---

## Self-Review Notes

- **Spec coverage:** 24h gate (Task 2) · periodic re-check while open (Task 5, hourly timer + gate) · check runs regardless of doc-open state (Task 5, `runUpdateCheck` at top-level boot, locale falls back to `detectBrowserLocale()`) · PWA save-verified reload (Task 5 `reloadForUpdate`, per the spec's exact flow) · standalone releases-page link (Task 4) · session-only dismiss re-shown only for a newer version (Task 5 `dismissedUpdateVersion`) · i18n keys (Task 3) · `__REPO__` define (Task 1). All spec sections have a task.
- **Placeholder scan:** none — every step has real code or a concrete command.
- **Type consistency:** `UpdateCheckResult` (Task 2) is the same shape referenced in Task 5; `UpdateNoticeOpts { pwa?, repo? }` (Task 4) matches Task 5's un-opted call (relies on `__PWA__`/`__REPO__` defaults) and the tests' explicit opts. `showUpdateNotice`'s parameter order (`locale, latestVersion, onReload, onDismiss, opts?`) is identical between its Task 4 definition, its tests, and its Task 5 call site.
