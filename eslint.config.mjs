// eslint.config.mjs
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'pwa/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Highest-value rule for this codebase: save-controller.ts and the
      // cross-tab lock/dispose logic in main.ts are full of fire-and-forget
      // async — this catches an accidentally-unhandled promise where a
      // `void` or `.catch()` was meant but omitted.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // The codebase relies on structural typing and DOM globals (Element,
      // File, etc.) heavily enough that the stricter type-checked rules
      // below produce noise disproportionate to the bugs they'd catch here.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      // Cosmetic — flags `!`/`as X` the checker can prove don't change the
      // type. Doesn't catch bugs, and this codebase uses assertions somewhat
      // liberally after manual narrowing, so it's mostly noise here.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Test files intentionally exercise error paths, mocks, and
      // dynamically-typed fixtures where the extra rigor doesn't pay for
      // itself.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // Mock/stub methods are declared async to match the real API's return
      // type; the stub itself has nothing to await.
      '@typescript-eslint/require-await': 'off',
      // Spy fixtures capture whatever raw value the app handed them (e.g. a
      // Blob constructor arg) purely to assert on it — not meant to be a
      // display-safe string.
      '@typescript-eslint/no-base-to-string': 'off',
    },
  }
)
