import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite-plus';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/src/vendor/weba/')) return 'telegram';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/vendor/**'],
    coverage: {
      include: ['src/telegram/*.ts'],
      exclude: ['src/telegram/*.test.ts', 'src/telegram/fixtureTransport.ts'],
      thresholds: {
        statements: 70,
        branches: 48,
        functions: 80,
        lines: 72,
      },
    },
  },
  lint: {
    ignorePatterns: ['coverage/**', 'dist/**', 'src/vendor/**', 'test-results/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'no-console': ['error', { allow: ['debug', 'info', 'warn', 'error'] }],
    },
  },
  fmt: {
    ignorePatterns: ['coverage/**', 'dist/**', 'src/vendor/**', 'test-results/**'],
    semi: true,
    singleQuote: true,
  },
});
