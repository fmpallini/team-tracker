import { defineConfig, configDefaults } from 'vitest/config'
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    pool: 'forks',
    // A hang guard, not an assertion: the 5s default leaves the 3000-iteration fuzz and memory tests
    // (1-3s of CPU each) a 2-4x margin, which a starved CI runner or a parallel full run eats.
    testTimeout: 30_000,
    // Vitest blanks CSS imports by default; test/palette-contrast.test.ts reads styles.css via ?raw.
    css: { include: [/styles\.css/] },
    // Audits every store's update()/updateNav() against the scope it declares — see test/scope-contract.ts.
    setupFiles: ['test/setup-scope-contract.ts'],
    // e2e/ holds Playwright specs (*.spec.ts) — a different runner/matcher
    // entirely, not vitest's to pick up.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
  define: { __APP_VERSION__: '"test"', __PWA__: 'false', __PAGES_URL__: '"https://example.test/app/"', __REPO__: '"fmpallini/team-tracker"' },
})
