// Root ESLint flat config for the monorepo (apps/web + apps/server + packages/shared).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/data/**', '**/*.d.ts', 'apps/web/public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'off',
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipRegExps: true, skipComments: true }],
    },
  },
  // Frontend: React hooks rules + browser-only code.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      // Never render raw HTML from data.
      'no-restricted-syntax': [
        'error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'dangerouslySetInnerHTML is forbidden (XSS). Render text or use <Markdown>.' },
      ],
      'no-restricted-imports': ['error', { paths: [{ name: 'rehype-raw', message: 'Raw HTML in markdown is forbidden.' }] }],
    },
  },
  // Node: server, shared, e2e, scripts / configs
  {
    files: ['**/*.{js,cjs,mjs}', 'apps/server/**/*.ts', 'packages/shared/**/*.ts', 'e2e/**/*.ts', '**/vite.config.ts', '**/vitest.config.ts', '**/tsup.config.ts', '**/drizzle.config.ts'],
    languageOptions: {
      globals: {
        process: 'readonly', console: 'readonly', __dirname: 'readonly', module: 'readonly', require: 'readonly', URL: 'readonly',
        Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', fetch: 'readonly', structuredClone: 'readonly',
      },
    },
  },
  {
    files: ['apps/web/public/**/*.js'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly' } },
  },
);
