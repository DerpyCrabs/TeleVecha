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
          if (id.includes('/src/telegram/mtproto/')) return 'telegram';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/telegram/**/*.ts'],
      exclude: ['src/telegram/**/*.test.ts', 'src/telegram/transports/fixtureTransport.ts'],
      thresholds: {
        statements: 70,
        branches: 48,
        functions: 80,
        lines: 72,
      },
    },
  },
  lint: {
    ignorePatterns: ['coverage/**', 'dist/**', 'test-results/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'no-console': ['error', { allow: ['debug', 'info', 'warn', 'error'] }],
    },
  },
  fmt: {
    ignorePatterns: ['coverage/**', 'dist/**', 'test-results/**'],
    semi: true,
    singleQuote: true,
  },
});
