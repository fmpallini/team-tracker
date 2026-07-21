# Update check & notice — design

## Goal

Notify the user when a newer release exists on GitHub, checking at most once per 24h (gate persisted in `localStorage`), while the app is running. The two build variants react differently:

- **PWA build** (`__PWA__`, served over http(s), whether installed or just open in a tab): offer a "Reload now" action that saves any unsaved doc, verifies the save actually landed, and only then reloads.
- **Standalone `dist/app.html`** (`file://`): no self-update is possible — the notice just links to the GitHub releases page so the user can manually download the new file.

## Data source

GitHub's `GET https://api.github.com/repos/${repo}/releases/latest` already excludes drafts/prereleases, so no extra filtering is needed. `repo` is a new build-time define `__REPO__`, sourced from a new `"repository": "fmpallini/team-tracker"` field in `package.json` — mirrors how `__PAGES_URL__` is derived from `homepage` today. Used to build both the API URL and `https://github.com/${repo}/releases/latest`.

Version comparison: strip an optional leading `v` from `tag_name`, compare `major.minor.patch` numerically against `__APP_VERSION__`. No semver ranges/prerelease suffixes to handle since `/releases/latest` already resolves to a single stable tag.

## `src/core/update-check.ts` (headless)

```ts
export function shouldCheck(lastCheckIso: string | null, now: number): boolean
export function isNewer(latestTag: string, currentVersion: string): boolean
export async function checkForUpdate(
  fetchImpl: typeof fetch,
  currentVersion: string,
  repo: string
): Promise<string | null>  // returns the newer version, or null (no update / any failure)
```

- `localStorage` key `tt-last-update-check` holds the last-check ISO timestamp.
- `checkForUpdate` swallows all errors internally (network failure, non-2xx, bad JSON) and returns `null` — it must never throw, since it runs unattended off a timer.
- The timestamp is written by the **caller**, and only when `checkForUpdate` completes (success or "no newer version") — not on failure. A transient offline check leaves the gate unwritten so the next periodic tick retries, rather than waiting out the full 24h.

## `src/ui/update-notice.ts`

Mirrors `promo.ts`'s shape: a `UpdateNoticeOpts { pwa?: boolean; repo?: string }` DI seam for tests, resolved against `__PWA__`/`__REPO__` defaults.

```ts
export function showUpdateNotice(
  locale: Locale,
  latestVersion: string,
  onReload: () => Promise<void>,
  opts?: UpdateNoticeOpts
): HTMLElement
```

- Dismissible banner (`tt-update-banner`), appended to `document.body`, works whether the start screen or the shell is currently showing.
- PWA variant: button "Reload now" → `disabled = true`, `await onReload()`, `disabled = false` (only reached if `onReload` returns without having reloaded — i.e. the save failed and the reload was aborted).
- Standalone variant: button/link "View release" → `window.open(releasesUrl, '_blank', 'noopener')`.
- Dismiss (×) removes the banner for the session only (in-memory flag, not persisted). A later periodic tick re-shows it only if it finds a version newer than the one just dismissed.

## Reload flow (the data-loss guarantee)

`saveController.flush()` only waits out an *already in-flight* save — it does not trigger one, and `saveNow()` resolves normally even when the write fails (errors surface via a toast, not a rejection). So "reload" must explicitly save, wait, then verify:

```ts
async function reloadForUpdate(): Promise<void> {
  if (activeSaveController && activeStore) {
    await activeSaveController.saveNow({ explicit: true })
    await activeSaveController.flush()
    if (activeStore.dirty) {
      // Save failed (write error / external-change conflict) or this tab
      // never had one to make (mid-conflict). The existing error toast or
      // conflict modal from save-controller.ts is already the user's
      // recovery path — do not reload and silently discard the edit.
      return
    }
  }
  location.reload()
}
```

- `explicit: true` is required so fallback mode (no File System Access handle) actually triggers its download-fallback path.
- Checking `activeStore.dirty` after `flush()` is the actual guarantee — it's the one signal that survives regardless of *why* the save didn't land. Read-only tabs never have `dirty === true` (edits are gated at `store.update()`), so this is a no-op there, never a false block.
- If `activeSaveController`/`activeStore` are both `null` (start screen, no doc open), reload immediately — nothing to lose.

## Wiring in `main.ts`

- Two new module-level closure refs, set/cleared alongside the existing `app` password closure: `let activeSaveController: SaveController | null` and `let activeStore: Store | null`, assigned in `onDocumentOpened`, cleared on document close.
- At top-level boot (next to `initInstallCapture()` / `showStartScreen(...)`): run one check immediately, then `setInterval` every hour to re-run `shouldCheck` + `checkForUpdate` (the 24h gate, not the timer interval, controls actual check frequency). On a newer version, call `showUpdateNotice(locale, version, reloadForUpdate)` unless already dismissed for that version this session.

## i18n

New keys in both `pt-BR` and `en-US`: `update_notice_title` ("New version {version} available" / "Nova versão {version} disponível"), `update_notice_reload`, `update_notice_view_release`, `update_notice_dismiss_title`.

## Testing

- `update-check.test.ts`: `shouldCheck`/`isNewer` pure-function cases (boundary at exactly 24h, malformed tags, equal/older/newer versions); `checkForUpdate` with an injected fake `fetch` covering success, non-2xx, network throw, and malformed JSON — all must resolve `null` without throwing.
- `update-notice.test.ts`: both build variants render the right action; dismiss removes the banner and a re-render with the same version doesn't reappear (in-memory), a newer version does; reload button is disabled during `onReload` and re-enabled if `onReload` returns without navigating (simulate via a fake `location.reload` and a controller whose `flush()` leaves `dirty` true).
- `main.test.ts` (or wherever `onDocumentOpened`/close is already exercised): `activeSaveController`/`activeStore` refs get set and cleared correctly across open/close.

## Out of scope / explicitly deferred

- No service-worker-driven update flow (`skipWaiting`/`controllerchange` listening) — the version check is fully independent of the SW lifecycle already in `pwa/sw.js`.
- No per-version persisted dismissal — session-only, per the approved design.
- No exponential backoff / rate-limit handling beyond "swallow and return null" — GitHub's unauthenticated per-IP limit is generous relative to one check per user per 24h.
