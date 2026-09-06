import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite-plus';
import { effectweb } from '@effectweb/compiler/vite';

export default defineConfig({
  plugins: [effectweb(), tailwindcss()],
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
    },
  },
  lint: {
    ignorePatterns: ['coverage/**', 'dist/**', 'test-results/**'],
    plugins: ['typescript', 'unicorn', 'oxc', 'effecttsgo'],
    jsPlugins: ['@effectweb/compiler/oxlint'],
    options: { typeAware: true, typeCheck: true },
    rules: {
      'effecttsgo/any-unknown-in-error-context': 'off',
      'effecttsgo/floating-effect': 'error',
      'effectweb/valid-view': 'error',
      'no-console': ['error', { allow: ['debug', 'info', 'warn', 'error'] }],
    },
  },
  fmt: {
    ignorePatterns: ['coverage/**', 'dist/**', 'test-results/**'],
    semi: true,
    singleQuote: true,
    objectWrap: 'collapse',
    // Generated bindings must keep the layout emitted by their generator.
    overrides: [{ files: ['**/*.generated.ts'], options: { objectWrap: 'preserve' } }],
  },
});
