import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const FRAMEWORK_PACKAGES = [
  'express',
  'express/*',
  'cors',
  'helmet',
  'pino',
  'pino-http',
  'kysely',
  'pg',
  'jose',
  'zod',
  'xss',
];

export default defineConfig(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.data/**', '.tmp/**', 'walkthrough/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  // Clean Architecture boundaries, enforced by the linter:
  // the domain layer depends on nothing but itself and the shared kernel.
  {
    files: ['src/**/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: FRAMEWORK_PACKAGES,
              message: 'Domain code must not depend on frameworks, transport or persistence.',
            },
            {
              group: [
                '**/application/**',
                '**/repositories/**',
                '**/controllers/**',
                '**/infrastructure/**',
                '**/config/**',
              ],
              message: 'Domain code must not depend on outer layers.',
            },
          ],
        },
      ],
    },
  },
  // Use cases orchestrate the domain through ports; they never touch HTTP or SQL.
  {
    files: ['src/**/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: FRAMEWORK_PACKAGES,
              message: 'Application code must not depend on frameworks, transport or persistence.',
            },
            {
              group: ['**/controllers/**', '**/infrastructure/**', '**/repositories/postgres/**'],
              message: 'Application code depends on ports, not on adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
