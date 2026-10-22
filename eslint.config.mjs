import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.serverless/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/mobile/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['services/api/**/*.js', 'services/api/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
);
