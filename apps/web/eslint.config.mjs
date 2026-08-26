import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const compat = new FlatCompat({ recommendedConfig: js.configs.recommended });

/**
 * ESLint flat config for the web app.
 *
 * `next lint` previously had no config at all, so it dropped into its
 * interactive setup prompt and hung rather than linting anything — which is
 * also why it never ran in CI.
 *
 * eslint-config-next is still eslintrc-shaped, hence FlatCompat.
 */
const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },

  ...compat.extends('next/core-web-vitals'),

  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: { parser: tseslint.parser },
    rules: {
      // The app deliberately serves branding logos and Quick Connect assets
      // from paths the operator controls, and `next/image` cannot optimise a
      // runtime-configured URL. The plain <img> is the correct call there.
      '@next/next/no-img-element': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];

export default config;
