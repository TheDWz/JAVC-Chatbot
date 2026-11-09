// ESLint's recommended rules, with the right globals for each place the code runs.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['www/', 'android/', 'dist/'] }, // build output and the Android copy of it
  js.configs.recommended,
  { rules: { 'no-empty': ['error', { allowEmptyCatch: true }] } }, // `catch {}` marks a failure that's fine to ignore
  { files: ['**/*.js'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
  { files: ['**/*.mjs'], languageOptions: { globals: globals.node } },
  { files: ['renderer.js'], languageOptions: { sourceType: 'script' } }, // a classic <script>, not a module
  // Runs in the page (the smoke tests too, inside page.evaluate); index.html loads marked and lib.js before renderer.js.
  { files: ['renderer.js', 'lib.js', 'mobile/main.js', 'mobile/native.js', 'mobile/smoke/*.mjs'], languageOptions: { globals: { ...globals.browser, Lib: 'readonly', marked: 'readonly' } } },
];
