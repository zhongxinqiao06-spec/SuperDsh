import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import { adminBrowserBoundary } from './scripts/eslint-admin-boundaries.mjs'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'apps/desktop/lib/**',
      'apps/desktop/core/lib/**',
      'apps/desktop/plugins/harness/lib/**',
      'dsh-community-market/lib/**',
      '**/dist/**',
      'apps/desktop/ui/client/**',
      'apps/desktop/ui/native-ui/**',
      '**/.superdsh/**',
      '**/coverage/**',
      '**/generated/**',
      'apps/admin/.next/**',
      'apps/admin/.next-*/**',
      'apps/admin/out/**',
      'apps/admin/next-env.d.ts',
      '**/api-catalog.ts',
      '**/slot-catalog.ts',
      'vendor/**',
      'deepseek-harness/**',
      'agents-anywhere/**',
      'dsh-community-fabric/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // Existing plugin contracts use explicit any for open extension maps.
      // Strict TypeScript checks still validate all concrete implementations.
      '@typescript-eslint/no-explicit-any': 'off',
      // Declaration merging is the typed extension registry mechanism.
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'always', allowObjectTypes: 'always' },
      ],
      // Parser callbacks intentionally retain their receiver across closures.
      '@typescript-eslint/no-this-alias': 'off',
      // Terminal codecs and path validators explicitly reject control bytes.
      'no-control-regex': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['apps/admin/src/**/*.{ts,tsx}'],
    plugins: {
      'superdsh-admin': { rules: { 'browser-boundary': adminBrowserBoundary } },
    },
    rules: { 'superdsh-admin/browser-boundary': 'error' },
  },
  {
    files: [
      'apps/desktop/ui/src/**/*.{ts,tsx}',
      'apps/admin/src/**/*.{ts,tsx}',
    ],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
)
