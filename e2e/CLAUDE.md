# E2E tests (Playwright, `npm run test:e2e`)

`e2e/*.spec.ts` Playwright specs (not vitest's — excluded from `vitest.config.ts`, not typechecked/linted by `npm run typecheck`/`npm run lint` since `tsconfig.json` only includes `src`/`test`). `npm run test:e2e` builds first, runs against `dist/`. Chromium-only (`playwright.config.ts`'s sole project) — that's this app's userbase.

- `smoke.spec.ts` — loads `dist/app.html` over `file://`, like a real double-click. `e2e/opfs-shim.ts`'s `forceFallbackMode` strips the pickers before load, so the app takes its real download-fallback path (Chromium treats `file://` as insecure — no FS Access API, no OPFS).
- `fs-api.spec.ts` / `tab-lock.spec.ts` — served over `http://localhost` (`playwright.config.ts`'s `webServer` → zero-dep `e2e/static-server.mjs`), a secure context. `e2e/opfs-shim.ts`'s `installOpfsPickerShim` swaps the native pickers for OPFS-backed real `FileSystemFileHandle`s, so full create → encrypt → write → reopen → decrypt round trips, the backup mirror, and cross-tab single-writer handoff (two `page`s in one `context`) all run headlessly.

The insecure/secure-context reasoning and shim internals live in `e2e/opfs-shim.ts`'s header comment — treat that as the single source.
