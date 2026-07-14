# Team Tracker — PWA install / hosted-version promo (design)

Date: 2026-07-13. Approved by user on this date.

## Goal

Cross-promote the two build variants from inside the app:

- **PWA build** (GitHub Pages, `dist/pwa/`): offer to install as a local app — on the start screen (before a team file is opened) and via a persistent header button.
- **Local single-file build** (`dist/app.html`, opened via `file://`): use the same two slots to invite the user to the hosted PWA at GitHub Pages, where installation (and its benefits) is possible.

The pitch highlights benefits, including a teaser for a future feature: automatic Google Drive backup of the team file ("coming soon" — text only, nothing implemented now).

## Decisions (from brainstorming)

1. **Browsers without programmatic install** (Firefox, Safari — no `beforeinstallprompt`): show **manual instructions** in a modal instead of hiding the offer.
2. **Dismissal**: splash card is dismissible via ×, persisted in `localStorage` (never shows again in that browser). Header button is not affected by dismissal (small/unobtrusive) but hides when the app is already installed (standalone) or after `appinstalled`.
3. **Google Drive teaser**: benefits list includes "Automatic Google Drive backup of your team file (coming soon)". No date commitment, no Drive code.
4. **Pages URL**: injected at build time as `__PAGES_URL__`, sourced from a new `"homepage"` field in `package.json` (`https://fmpallini.github.io/team-tracker/`). Forks change one field.

## Architecture

New module **`src/ui/promo.ts`** — single module, two render slots, variant chosen by the existing `__PWA__` build flag (the two variants never coexist at runtime).

Exports:

- `initInstallCapture(): void` — called once near the top of `main.ts`, guarded by `__PWA__`. Registers the `beforeinstallprompt` listener immediately (the event fires early; a late listener misses it and the native prompt is lost) and stashes the event in module state. Also listens for `appinstalled` to remove live promo UI.
- `promoStartCard(locale: Locale): HTMLElement | null` — `start.ts` appends it below the advantages list. Returns `null` when nothing should show.
- `promoHeaderButton(locale: Locale): HTMLElement | null` — `main.ts` appends it into `shell.headerRight` (leftmost, before the save indicator). Returns `null` when nothing should show.

### Variants

| | PWA build (`__PWA__ = true`) | Local build (`__PWA__ = false`) |
|---|---|---|
| Card title | "Install as app" | "Try the installable version" |
| Card action | Install → native prompt (Chromium) or instructions modal | Open hosted version → `__PAGES_URL__` in new tab |
| Header button | `⬇` icon, tooltip pitch, same click behavior as card action | `🌐` icon, tooltip pitch, opens new tab |

Both cards share the benefits framing: works offline / own window + taskbar icon / auto-updates / Google Drive auto-backup (coming soon). The local-variant copy reassures: the same `.tmv` file keeps working there — nothing is uploaded; the hosted version is the same code delivered over https instead of `file://`.

### Visibility rules (both slots, evaluated at render and on events)

1. Running standalone (`matchMedia('(display-mode: standalone)')` matches) → hide everything (already installed).
2. `localStorage['tt-promo-dismissed']` set → hide the splash card only.
3. Local variant with empty/missing `__PAGES_URL__` → hide everything.
4. `appinstalled` fires mid-session → both slots remove themselves.

### Build changes

- `scripts/build.mjs`: new esbuild define `__PAGES_URL__` from `pkg.homepage ?? ''` (both variants — the local build needs it for the invite; the PWA build may ignore it).
- `package.json`: add `"homepage": "https://fmpallini.github.io/team-tracker/"`.
- `vitest.config.ts`: add `__PAGES_URL__` define (test value).
- `src/main.ts`: extend `declare global` with `__PAGES_URL__: string`.

## UX detail

**Splash card** (start screen, below the existing `tt-start-advantages` list): boxed card with small title, 2–3 benefit bullets, one action button, and an × dismiss control. × sets the localStorage flag and removes the card immediately.

**Header button**: icon button styled like the existing header buttons (`tt-btn`). Tooltip carries the one-line pitch.

**Instructions modal** (PWA variant, when no captured `beforeinstallprompt`): reuses the existing modal infrastructure (`src/ui/modal.ts`). Static i18n content listing: Chrome/Edge — install icon in the address bar; Safari — Share → Add to Dock / Add to Home Screen; Firefox — desktop does not support PWA install; the hosted app still works in a tab.

## Edge cases

- Chromium but `beforeinstallprompt` never fired (already installed elsewhere, install criteria unmet) → button/card action falls back to the instructions modal. No dead clicks.
- Native prompt shown once and dismissed → the captured event is single-use; subsequent clicks show the instructions modal (Chromium blocks re-prompting).
- jsdom / feature-absent environments: all browser APIs (`beforeinstallprompt`, `matchMedia`, `localStorage`) are feature-detected; the module degrades to the instructions-modal path and stays testable.
- `localStorage` throws (strict privacy modes) → try/catch; dismissal simply doesn't persist.

## i18n

~15 new keys in `src/core/i18n.ts`, both `pt-BR` and `en-US`: card titles ×2, benefit bullets ×4 (shared between variants where sensible), action buttons ×2, dismiss tooltip, header-button tooltips ×2, instructions modal title + per-browser body ×3.

## Testing (`test/promo.test.ts`, jsdom)

- PWA variant renders install card + header button; local variant renders invite card + link button.
- Dismiss sets the localStorage flag, removes the card, and prevents re-render on the next `showStartScreen`.
- Standalone media-query mock → both slots render nothing.
- Fake captured `beforeinstallprompt` → install click calls `prompt()` on it.
- No captured event → install click opens the instructions modal.
- Local variant link href equals the `__PAGES_URL__` define.
- Empty `__PAGES_URL__` → local variant renders nothing.

## Out of scope

- Google Drive backup implementation (teaser text only).
- Any change to save/load, crypto, or the `.tmv` format.
- Analytics/telemetry on install acceptance.
