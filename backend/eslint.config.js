// backend/eslint.config.js
// ESLint 9 flat config format

'use strict';

const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals
        require:   'readonly',
        module:    'readonly',
        exports:   'readonly',
        __dirname: 'readonly',
        __filename:'readonly',
        process:   'readonly',
        console:   'readonly',
        Buffer:    'readonly',
        setTimeout:'readonly',
        clearTimeout:'readonly',
        setInterval:'readonly',
        clearInterval:'readonly',
        Promise:   'readonly',
        // Jest globals
        describe:  'readonly',
        it:        'readonly',
        test:      'readonly',
        expect:    'readonly',
        beforeAll: 'readonly',
        afterAll:  'readonly',
        beforeEach:'readonly',
        afterEach: 'readonly',
        jest:      'readonly',
      },
    },
    rules: {
      // ── Errors ──────────────────────────────────────────────────────────
      'no-unused-vars':        ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef':              'error',
      'no-console':            ['warn', { allow: ['warn', 'error'] }],
      'no-eval':               'error',
      'no-implied-eval':       'error',
      'no-new-func':           'error',

      // ── Security-relevant ────────────────────────────────────────────────
      // Catch prototype pollution vectors in source
      'no-extend-native':      'error',
      'no-proto':              'error',

      // ── Style (non-breaking) ─────────────────────────────────────────────
      'eqeqeq':                ['warn', 'always', { null: 'ignore' }],
      'curly':                 ['warn', 'all'],
      'prefer-const':          'warn',
    },
    ignores: [
      'node_modules/**',
      'coverage/**',
      '*.min.js',
    ],
  },
];
