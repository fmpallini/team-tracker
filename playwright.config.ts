// playwright.config.ts
import { defineConfig, devices } from '@playwright/test'

// Smoke-test rig for dist/app.html, the self-contained file:// build.
//
// Chromium ships `window.showOpenFilePicker` unconditionally (feature-
// detectable even though calling it under an insecure context like file://
// throws), so `supportsFsApi` in src/core/fs.ts reads true there and the app
// tries to open a native OS file picker — something Playwright cannot drive.
// Firefox/WebKit never implement the File System Access API, so the app
// takes its download-fallback path instead (hidden <input type="file"> +
// anchor-click download), which Playwright automates natively via
// `page.on('filechooser')` / `page.waitForEvent('download')`. Firefox is the
// project used for tests that exercise the create/open flow end to end;
// chromium is kept for a plain load smoke test.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
    // App locale follows navigator.language (src/main.ts detectBrowserLocale) —
    // pin it so button/dialog copy in tests is deterministic across machines.
    locale: 'en-US',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
})
