import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { globals: true, environment: 'jsdom', pool: 'forks' },
  define: { __APP_VERSION__: '"test"', __PWA__: 'false', __PAGES_URL__: '"https://example.test/app/"', __REPO__: '"fmpallini/team-tracker"' },
})
