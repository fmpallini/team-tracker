# PWA Install / Hosted-Version Promo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross-promote the two build variants: the PWA build offers "install as app" (splash card + header button); the local `file://` build uses the same slots to invite users to the hosted PWA on GitHub Pages.

**Architecture:** One new module `src/ui/promo.ts` renders both slots; the variant is chosen by the existing `__PWA__` esbuild define (the two variants never coexist at runtime). A new `__PAGES_URL__` define carries the hosted URL from `package.json` `"homepage"`. Native install prompt on Chromium via a `beforeinstallprompt` capture registered early in `main.ts`; manual-instructions modal everywhere else. Spec: `docs/superpowers/specs/2026-07-13-pwa-install-promo-design.md`.

**Tech Stack:** TypeScript strict, esbuild defines, vitest + jsdom, `el()` DOM helper, existing `showModal()` infra, `t()` i18n.

## Global Constraints

- Zero runtime dependencies — nothing added to `package.json` `dependencies`.
- All user-visible strings go through `t(locale, key)` with keys in BOTH `pt-BR` and `en-US` (`src/core/i18n.ts`).
- All browser APIs feature-detected (`matchMedia`, `localStorage`, install events) — code must degrade gracefully under jsdom.
- `dist/app.html` must stay fully self-contained (no external references).
- Commits on `dev` branch, direct commits allowed. Pre-push hook runs lint/typecheck/test.
- Google Drive backup is TEXT ONLY ("coming soon") — implement no Drive code.

---

### Task 1: `__PAGES_URL__` build plumbing

**Files:**
- Modify: `package.json` (add `homepage` field)
- Modify: `scripts/build.mjs:10` (define)
- Modify: `vitest.config.ts:4` (define)
- Modify: `src/main.ts:1` (declare global)

**Interfaces:**
- Produces: global constant `__PAGES_URL__: string` usable in any `src/` module. Value: `"https://fmpallini.github.io/team-tracker/"` in real builds, `"https://example.test/app/"` under vitest.

- [ ] **Step 1: Add `homepage` to package.json**

In `package.json`, after the `"version"` line, add:

```json
  "homepage": "https://fmpallini.github.io/team-tracker/",
```

- [ ] **Step 2: Add define in scripts/build.mjs**

Change line 10 from:

```js
    define: { __APP_VERSION__: JSON.stringify(pkg.version), __PWA__: String(pwa) },
```

to:

```js
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __PWA__: String(pwa),
      __PAGES_URL__: JSON.stringify(pkg.homepage ?? ''),
    },
```

- [ ] **Step 3: Add define in vitest.config.ts**

Change line 4 from:

```ts
  define: { __APP_VERSION__: '"test"', __PWA__: 'false' },
```

to:

```ts
  define: { __APP_VERSION__: '"test"', __PWA__: 'false', __PAGES_URL__: '"https://example.test/app/"' },
```

- [ ] **Step 4: Extend declare global in src/main.ts**

Change line 1 from:

```ts
declare global { const __APP_VERSION__: string; const __PWA__: boolean }
```

to:

```ts
declare global { const __APP_VERSION__: string; const __PWA__: boolean; const __PAGES_URL__: string }
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run build`
Expected: both succeed. (Nothing references the define yet — esbuild drops unused defines; Task 3's tests and Task 5's grep prove the value flows through.)

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/build.mjs vitest.config.ts src/main.ts
git commit -m "build: inject __PAGES_URL__ define from package.json homepage"
```

---

### Task 2: i18n keys for promo strings

**Files:**
- Modify: `src/core/i18n.ts` (both locale objects)

**Interfaces:**
- Produces: 15 new `MsgKey` values (listed below) resolvable via `t(locale, key)` in both locales. Later tasks call them by these exact names.

- [ ] **Step 1: Add keys to the `pt` object**

In `src/core/i18n.ts`, inside the `pt` object (e.g. right after the `start_reopen_ellipsis` entry around line 31), add:

```ts
  promo_card_title_install: 'Instale como aplicativo',
  promo_card_title_hosted: 'Experimente a versão instalável',
  promo_adv_app: '🖥️ Janela própria e ícone na barra de tarefas — funciona offline',
  promo_adv_updates: '🔄 Atualizações automáticas',
  promo_adv_drive: '☁️ Backup automático do arquivo do time no Google Drive (em breve)',
  promo_hosted_note:
    'Seu arquivo .tmv continua funcionando lá — nada é enviado: é o mesmo app, entregue via https em vez de file://.',
  promo_action_install: 'Instalar',
  promo_action_open_hosted: 'Abrir versão hospedada',
  promo_dismiss_title: 'Dispensar',
  promo_header_install_title: 'Instalar como aplicativo — offline, janela própria, atualizações automáticas',
  promo_header_hosted_title: 'Abrir a versão hospedada instalável',
  promo_instr_title: 'Instalar o aplicativo',
  promo_instr_chrome: 'Chrome/Edge: clique no ícone de instalação na barra de endereço.',
  promo_instr_safari: 'Safari: Compartilhar → Adicionar ao Dock / à Tela de Início.',
  promo_instr_firefox:
    'Firefox (desktop) não suporta instalação de PWA — o app continua funcionando normalmente na aba.',
```

- [ ] **Step 2: Add the same keys to the `en` object**

Inside the `en` object (right after its `start_reopen_ellipsis` entry around line 297), add:

```ts
  promo_card_title_install: 'Install as an app',
  promo_card_title_hosted: 'Try the installable version',
  promo_adv_app: '🖥️ Own window and taskbar icon — works offline',
  promo_adv_updates: '🔄 Automatic updates',
  promo_adv_drive: '☁️ Automatic Google Drive backup of your team file (coming soon)',
  promo_hosted_note:
    'Your .tmv file keeps working there — nothing is uploaded: same app, delivered over https instead of file://.',
  promo_action_install: 'Install',
  promo_action_open_hosted: 'Open hosted version',
  promo_dismiss_title: 'Dismiss',
  promo_header_install_title: 'Install as an app — offline, own window, automatic updates',
  promo_header_hosted_title: 'Open the installable hosted version',
  promo_instr_title: 'Install the app',
  promo_instr_chrome: 'Chrome/Edge: click the install icon in the address bar.',
  promo_instr_safari: 'Safari: Share → Add to Dock / Add to Home Screen.',
  promo_instr_firefox: 'Firefox (desktop) does not support PWA install — the app still works in a tab.',
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npx vitest run test/i18n.test.ts`
Expected: typecheck passes (the `en` object's type requires exact key parity with `pt` — a missing/misspelled key fails here). i18n tests pass. If `test/i18n.test.ts` doesn't exist, run `npm test` instead.

- [ ] **Step 4: Commit**

```bash
git add src/core/i18n.ts
git commit -m "feat(i18n): strings for PWA install / hosted-version promo"
```

---

### Task 3: `src/ui/promo.ts` module (TDD)

**Files:**
- Create: `src/ui/promo.ts`
- Test: `test/promo.test.ts`

**Interfaces:**
- Consumes: `t`, `Locale` from `../core/i18n` (Task 2 keys); `el` from `./dom`; `showModal` from `./modal`; globals `__PWA__`, `__PAGES_URL__` (Task 1).
- Produces (Tasks 4–5 use these exact signatures):
  - `initInstallCapture(): void`
  - `promoStartCard(locale: Locale, opts?: PromoOpts): HTMLElement | null`
  - `promoHeaderButton(locale: Locale, opts?: PromoOpts): HTMLElement | null`
  - `interface PromoOpts { pwa?: boolean; pagesUrl?: string }` (test seam — defaults come from the globals)
  - `resetPromoStateForTests(): void`
  - CSS class names: card `tt-promo-card`, header button `tt-btn-promo`, dismiss `tt-promo-dismiss`, action `tt-promo-action`, hosted note `tt-promo-note`.
  - localStorage key: `tt-promo-dismissed` (value `'1'`).

- [ ] **Step 1: Write the failing tests**

Create `test/promo.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initInstallCapture,
  promoStartCard,
  promoHeaderButton,
  resetPromoStateForTests,
} from '../src/ui/promo'

const LOCALE = 'en-US' as const
const URL = 'https://example.test/app/'

function firePrompt(): { prompt: ReturnType<typeof vi.fn> } {
  const ev = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void> }
  const prompt = vi.fn(async () => {})
  ev.prompt = prompt
  window.dispatchEvent(ev)
  return { prompt }
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  resetPromoStateForTests()
})

describe('local variant (hosted invite)', () => {
  it('renders invite card with link action', () => {
    const card = promoStartCard(LOCALE, { pwa: false, pagesUrl: URL })
    expect(card).not.toBeNull()
    expect(card!.classList.contains('tt-promo-card')).toBe(true)
    expect(card!.textContent).toContain('Try the installable version')
    expect(card!.textContent).toContain('coming soon')
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    card!.querySelector<HTMLButtonElement>('.tt-promo-action')!.click()
    expect(open).toHaveBeenCalledWith(URL, '_blank', 'noopener')
    open.mockRestore()
  })

  it('renders header button that opens the hosted URL', () => {
    const btn = promoHeaderButton(LOCALE, { pwa: false, pagesUrl: URL })
    expect(btn).not.toBeNull()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    btn!.click()
    expect(open).toHaveBeenCalledWith(URL, '_blank', 'noopener')
    open.mockRestore()
  })

  it('renders nothing when pagesUrl is empty', () => {
    expect(promoStartCard(LOCALE, { pwa: false, pagesUrl: '' })).toBeNull()
    expect(promoHeaderButton(LOCALE, { pwa: false, pagesUrl: '' })).toBeNull()
  })
})

describe('PWA variant (install offer)', () => {
  it('renders install card and header button', () => {
    const card = promoStartCard(LOCALE, { pwa: true })
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Install as an app')
    expect(promoHeaderButton(LOCALE, { pwa: true })).not.toBeNull()
  })

  it('calls prompt() on the captured beforeinstallprompt event', () => {
    initInstallCapture()
    const { prompt } = firePrompt()
    const card = promoStartCard(LOCALE, { pwa: true })!
    document.body.appendChild(card)
    card.querySelector<HTMLButtonElement>('.tt-promo-action')!.click()
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('captured event is single-use: second click opens the instructions modal', () => {
    initInstallCapture()
    firePrompt()
    const card = promoStartCard(LOCALE, { pwa: true })!
    document.body.appendChild(card)
    const action = card.querySelector<HTMLButtonElement>('.tt-promo-action')!
    action.click()
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
    action.click()
    expect(document.querySelector('.tt-modal-overlay')).not.toBeNull()
    expect(document.body.textContent).toContain('Install the app')
  })

  it('opens instructions modal when no event was captured', () => {
    const card = promoStartCard(LOCALE, { pwa: true })!
    document.body.appendChild(card)
    card.querySelector<HTMLButtonElement>('.tt-promo-action')!.click()
    expect(document.querySelector('.tt-modal-overlay')).not.toBeNull()
    expect(document.body.textContent).toContain('address bar')
  })

  it('appinstalled removes live promo UI and blocks new renders', () => {
    initInstallCapture()
    const card = promoStartCard(LOCALE, { pwa: true })!
    const btn = promoHeaderButton(LOCALE, { pwa: true })!
    document.body.append(card, btn)
    window.dispatchEvent(new Event('appinstalled'))
    expect(document.querySelector('.tt-promo-card')).toBeNull()
    expect(document.querySelector('.tt-btn-promo')).toBeNull()
    expect(promoStartCard(LOCALE, { pwa: true })).toBeNull()
    expect(promoHeaderButton(LOCALE, { pwa: true })).toBeNull()
  })
})

describe('dismissal and standalone', () => {
  it('dismiss removes card, persists, header button unaffected', () => {
    const card = promoStartCard(LOCALE, { pwa: false, pagesUrl: URL })!
    document.body.appendChild(card)
    card.querySelector<HTMLButtonElement>('.tt-promo-dismiss')!.click()
    expect(document.querySelector('.tt-promo-card')).toBeNull()
    expect(localStorage.getItem('tt-promo-dismissed')).toBe('1')
    expect(promoStartCard(LOCALE, { pwa: false, pagesUrl: URL })).toBeNull()
    expect(promoHeaderButton(LOCALE, { pwa: false, pagesUrl: URL })).not.toBeNull()
  })

  it('renders nothing when running standalone', () => {
    const orig = window.matchMedia
    window.matchMedia = ((q: string) =>
      ({ matches: q === '(display-mode: standalone)', addEventListener: () => {}, removeEventListener: () => {} })) as never
    expect(promoStartCard(LOCALE, { pwa: true })).toBeNull()
    expect(promoHeaderButton(LOCALE, { pwa: true })).toBeNull()
    window.matchMedia = orig
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/promo.test.ts`
Expected: FAIL — cannot resolve `../src/ui/promo`.

- [ ] **Step 3: Implement src/ui/promo.ts**

```ts
// src/ui/promo.ts
// Cross-promotion between the two build variants (spec:
// docs/superpowers/specs/2026-07-13-pwa-install-promo-design.md).
// PWA build (__PWA__): offer "install as app" — native prompt on Chromium,
// manual-instructions modal elsewhere. Local file:// build: invite to the
// hosted PWA at __PAGES_URL__. The two variants never coexist at runtime;
// PromoOpts exists so tests can exercise both from a single vitest define.
import { t, type Locale } from '../core/i18n'
import { el } from './dom'
import { showModal, type ModalHandle } from './modal'

export interface PromoOpts {
  pwa?: boolean
  pagesUrl?: string
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
}

const DISMISS_KEY = 'tt-promo-dismissed'

// The captured event is single-use: Chromium blocks re-prompting after the
// user dismisses the native dialog, so triggerInstall() clears it and later
// clicks fall through to the instructions modal.
let deferredPrompt: BeforeInstallPromptEvent | null = null
let installed = false

export function resetPromoStateForTests(): void {
  deferredPrompt = null
  installed = false
}

/**
 * Must run as early as possible in main.ts (PWA build only):
 * `beforeinstallprompt` fires before the UI mounts, and a listener added
 * later simply misses it — losing the native-prompt path for the session.
 */
export function initInstallCapture(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e as BeforeInstallPromptEvent
  })
  window.addEventListener('appinstalled', () => {
    installed = true
    deferredPrompt = null
    document.querySelectorAll('.tt-promo-card, .tt-btn-promo').forEach((n) => n.remove())
  })
}

function isStandalone(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  )
}

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

function setDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    // Strict privacy modes: dismissal just doesn't persist.
  }
}

function resolve(opts?: PromoOpts): { pwa: boolean; pagesUrl: string } {
  return { pwa: opts?.pwa ?? __PWA__, pagesUrl: opts?.pagesUrl ?? __PAGES_URL__ }
}

function showInstallInstructions(locale: Locale): void {
  const body = el(
    'div',
    { class: 'tt-promo-instructions' },
    el('p', {}, t(locale, 'promo_instr_chrome')),
    el('p', {}, t(locale, 'promo_instr_safari')),
    el('p', {}, t(locale, 'promo_instr_firefox'))
  )
  const handle: ModalHandle = showModal({
    title: t(locale, 'promo_instr_title'),
    body,
    buttons: [{ label: t(locale, 'ok'), primary: true, onClick: () => handle.close() }],
  })
}

function triggerInstall(locale: Locale): void {
  const ev = deferredPrompt
  if (ev) {
    deferredPrompt = null
    ev.prompt().catch(() => showInstallInstructions(locale))
  } else {
    showInstallInstructions(locale)
  }
}

function openHosted(pagesUrl: string): void {
  window.open(pagesUrl, '_blank', 'noopener')
}

function hiddenEverywhere(pwa: boolean, pagesUrl: string): boolean {
  return installed || isStandalone() || (!pwa && !pagesUrl)
}

export function promoStartCard(locale: Locale, opts?: PromoOpts): HTMLElement | null {
  const { pwa, pagesUrl } = resolve(opts)
  if (hiddenEverywhere(pwa, pagesUrl) || isDismissed()) return null

  const action = el(
    'button',
    {
      class: 'tt-btn tt-btn-primary tt-promo-action',
      type: 'button',
      onclick: () => (pwa ? triggerInstall(locale) : openHosted(pagesUrl)),
    },
    t(locale, pwa ? 'promo_action_install' : 'promo_action_open_hosted')
  )
  const dismiss = el(
    'button',
    {
      class: 'tt-promo-dismiss',
      type: 'button',
      title: t(locale, 'promo_dismiss_title'),
      onclick: () => {
        setDismissed()
        card.remove()
      },
    },
    '×'
  )
  const card = el(
    'div',
    { class: 'tt-promo-card' },
    dismiss,
    el('h2', { class: 'tt-promo-title' }, t(locale, pwa ? 'promo_card_title_install' : 'promo_card_title_hosted')),
    el(
      'ul',
      { class: 'tt-promo-advantages' },
      el('li', {}, t(locale, 'promo_adv_app')),
      el('li', {}, t(locale, 'promo_adv_updates')),
      el('li', {}, t(locale, 'promo_adv_drive'))
    ),
    pwa ? null : el('p', { class: 'tt-promo-note' }, t(locale, 'promo_hosted_note')),
    action
  )
  return card
}

export function promoHeaderButton(locale: Locale, opts?: PromoOpts): HTMLElement | null {
  const { pwa, pagesUrl } = resolve(opts)
  if (hiddenEverywhere(pwa, pagesUrl)) return null
  return el(
    'button',
    {
      class: 'tt-btn tt-btn-promo',
      type: 'button',
      title: t(locale, pwa ? 'promo_header_install_title' : 'promo_header_hosted_title'),
      onclick: () => (pwa ? triggerInstall(locale) : openHosted(pagesUrl)),
    },
    pwa ? '⬇' : '🌐'
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/promo.test.ts && npm run typecheck`
Expected: all promo tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/promo.ts test/promo.test.ts
git commit -m "feat: promo module — PWA install offer / hosted-version invite"
```

---

### Task 4: Start-screen card wiring + CSS

**Files:**
- Modify: `src/ui/start.ts` (append card)
- Modify: `styles.css` (card styles)
- Test: `test/start.test.ts` (one new test)

**Interfaces:**
- Consumes: `promoStartCard(locale)` from Task 3 (no `opts` — real builds use the globals; under vitest `__PWA__` is `false` and `__PAGES_URL__` is `"https://example.test/app/"`, so the start screen shows the hosted-invite variant in tests).

- [ ] **Step 1: Write the failing test**

Append to `test/start.test.ts` (top-level, after the existing tests; the file's `beforeEach` already resets `#app`):

```ts
describe('promo card', () => {
  it('start screen shows the hosted-invite promo card (test build: __PWA__ false, pages URL set)', () => {
    localStorage.removeItem('tt-promo-dismissed')
    showStartScreen('en-US', vi.fn())
    const card = document.querySelector('.tt-promo-card')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Try the installable version')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/start.test.ts`
Expected: FAIL — `.tt-promo-card` not found (new test only; existing tests stay green).

- [ ] **Step 3: Wire the card into src/ui/start.ts**

Add the import at the top, alongside the other `./` imports:

```ts
import { promoStartCard } from './promo'
```

In `showStartScreen`, change the children-assembly block (currently):

```ts
  const children: (Node | string | null)[] = [title, tagline, advantages, buttonsCol]
  if (!supportsFsApi) {
    children.push(el('p', { class: 'tt-start-fallback-notice' }, t(locale, 'fallback_notice')))
  }
```

to:

```ts
  const children: (Node | string | null)[] = [title, tagline, advantages, buttonsCol]
  if (!supportsFsApi) {
    children.push(el('p', { class: 'tt-start-fallback-notice' }, t(locale, 'fallback_notice')))
  }
  children.push(promoStartCard(locale))
```

(`el()` already skips `null` children, so no guard needed.)

- [ ] **Step 4: Add card styles to styles.css**

Append after the `.tt-start-*` rules (around line 87):

```css
.tt-promo-card { position: relative; max-width: 36em; margin-top: 1.25rem; padding: .9rem 2.2rem .9rem 1.1rem; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); text-align: left; font-size: .9rem; color: var(--muted); }
.tt-promo-title { font-size: 1rem; margin: 0 0 .4rem; color: var(--fg); }
.tt-promo-advantages { list-style: none; padding: 0; margin: 0 0 .6rem; display: flex; flex-direction: column; gap: .3rem; line-height: 1.5; }
.tt-promo-note { margin: 0 0 .6rem; font-size: .8rem; }
.tt-promo-dismiss { position: absolute; top: .3rem; right: .45rem; border: none; background: none; color: var(--muted); font-size: 1.1rem; cursor: pointer; padding: .1rem .3rem; }
.tt-promo-dismiss:hover { color: var(--fg); }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/start.test.ts test/promo.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/start.ts styles.css test/start.test.ts
git commit -m "feat: promo card on start screen"
```

---

### Task 5: main.ts wiring — install capture + header button

**Files:**
- Modify: `src/main.ts` (two insertions)

**Interfaces:**
- Consumes: `initInstallCapture()`, `promoHeaderButton(locale)` from Task 3; `shell.headerRight` from `createShell()`.

- [ ] **Step 1: Import and init capture early**

In `src/main.ts`, add to the `./ui/` import block:

```ts
import { initInstallCapture, promoHeaderButton } from './ui/promo'
```

Immediately after the import block (before any other statements run), add:

```ts
// beforeinstallprompt fires before the UI mounts — capture must be
// registered at startup or the native install prompt is lost (see
// src/ui/promo.ts). PWA build only; the file:// build has nothing to install.
if (__PWA__) initInstallCapture()
```

- [ ] **Step 2: Mount the header button on document open**

In `onDocumentOpened` (src/main.ts:184), right after `shell.applyPrefs(doc.prefs)`:

```ts
  const promoBtn = promoHeaderButton(doc.prefs.locale)
  if (promoBtn) shell.headerRight.prepend(promoBtn)
```

(`prepend` puts it leftmost, before the save indicator — per spec.)

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all pass.

Run (Git Bash): `grep -c 'fmpallini.github.io' dist/app.html && grep -c 'beforeinstallprompt' dist/pwa/index.html`
Expected: both `1` or more — the local build embeds the Pages URL (invite variant), the PWA build embeds the install capture.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Open `dist/app.html` in a browser: start screen shows "Try the installable version" card with 🌐 header-invite behavior after opening a file; × dismiss hides the card and survives reload. Serve `dist/pwa/` over http (`npx serve dist/pwa` or similar) in Chrome: card shows "Install as an app"; button triggers the native prompt or the instructions modal.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: PWA install capture + promo header button"
```
