import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // android/ios are Capacitor native projects: their own tooling lints the
  // native code, and `cap sync` copies the built web bundle into them.
  globalIgnores(['dist', 'android', 'ios']),
  {
    // Node-executed files: build config + Vercel serverless functions.
    files: ['vite.config.js', 'api/**/*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // k6 load-test scripts — k6 injects __ENV / __VU at runtime.
    files: ['.scripts/load/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }] },
  },
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
])
