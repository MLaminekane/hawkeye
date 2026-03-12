import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  js.configs.recommended,
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        globalThis: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // TypeScript handles these
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',

      // TypeScript-specific
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',

      // General quality
      'no-console': 'off', // CLI tool, console is expected
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', '**/*.mjs', '!eslint.config.js'],
  },
];
