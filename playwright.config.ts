// playwright.config.ts
import { defineConfig, devices } from '@playwright/test'

// Chromium-only: that's this app's userbase, so that's the only engine e2e
// spends time on. Two ways the suite loads dist/:
//
// - file:// (smoke.spec.ts's APP_URL) — the actual self-contained
//   dist/app.html artifact, opened exactly like a real user would
//   double-click it. Chromium treats file:// as an *insecure* context, so
//   window.showOpenFilePicker/showSaveFilePicker throw there and OPFS
//   (navigator.storage.getDirectory()) isn't available — real create/open
//   flows can't run against this origin. e2e/opfs-shim.ts's
//   `forceFallbackMode` instead makes supportsFsApi (src/core/fs.ts) read
//   false here, same as any browser without the File System Access API, so
//   the app's own download-fallback path (still real, still shipped code)
//   gets exercised for real rather than just dropped from coverage.
// - http://localhost (E2E_BASE_URL, via the webServer below, backed by the
//   zero-dep e2e/static-server.mjs) — Chromium treats localhost as *secure*,
//   which unlocks OPFS. e2e/opfs-shim.ts's `installOpfsPickerShim` swaps in
//   OPFS-backed handles for the native pickers Playwright can't drive, so
//   fs-api.spec.ts and tab-lock.spec.ts can exercise the real create/open/
//   save/backup/cross-tab-lock flows against the real FileSystemFileHandle
//   API instead of a mock.
const E2E_PORT = 4319
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: [['list']],
  webServer: {
    command: 'node e2e/static-server.mjs',
    url: `${E2E_BASE_URL}/app.html`,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: String(E2E_PORT) },
  },
  use: {
    trace: 'on-first-retry',
    // App locale follows navigator.language (src/main.ts detectBrowserLocale) —
    // pin it so button/dialog copy in tests is deterministic across machines.
    locale: 'en-US',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
