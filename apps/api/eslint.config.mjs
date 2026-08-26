// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';

/**
 * ESLint flat config for the API.
 *
 * The security rules here were previously hand-written on the production
 * server as `/opt/reboot-remote/eslint-security.config.mjs`, referencing
 * globally-installed plugins by absolute path. That file was never in version
 * control, so nobody could reproduce a run and nothing enforced it. It lives
 * here now, with the plugins as real devDependencies.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    plugins: { security },
    languageOptions: {
      parserOptions: { sourceType: 'module', ecmaVersion: 'latest' },
    },
    rules: {
      // ── Security ──────────────────────────────────────────────────────────
      'security/detect-unsafe-regex': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-new-buffer': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-non-literal-require': 'warn',
      'security/detect-possible-timing-attacks': 'warn',

      // These two fire constantly on ordinary Nest/Prisma code — a `where`
      // clause built from a validated DTO is not object injection, and every
      // file-serving route reads a path we constructed. Left off rather than
      // left screaming, so the errors above stay meaningful.
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      // We shell out deliberately (systemctl, fail2ban, df) and always with an
      // args array, never a shell string. semgrep-rules/nodejs-security.yml
      // covers the dangerous form.
      'security/detect-child-process': 'off',

      // ── TypeScript ────────────────────────────────────────────────────────
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Nest DTOs and Prisma JSON columns legitimately reach for `any`.
      // Warn so it stays visible without blocking a build.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  {
    // Test harnesses and one-off scripts are plain ESM run by hand.
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
