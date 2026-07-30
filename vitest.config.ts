import { defineConfig, configDefaults } from 'vitest/config'
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    pool: 'forks',
    // e2e/ holds Playwright specs (*.spec.ts) — a different runner/matcher
    // entirely, not vitest's to pick up.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
  define: { __APP_VERSION__: '"test"', __PWA__: 'false', __PAGES_URL__: '"https://example.test/app/"', __REPO__: '"fmpallini/team-tracker"' },
})
