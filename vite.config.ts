import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite-plus';
import { effectweb } from '@effectweb/compiler/vite';
import { execFileSync } from 'node:child_process';

function sourceRevision() {
  try {
    return {
      commit:
        process.env.VITE_TELEVECHA_COMMIT ||
        execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      modified: Boolean(
        execFileSync('git', ['status', '--porcelain'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      ),
    };
  } catch {
    return { commit: process.env.VITE_TELEVECHA_COMMIT ?? '', modified: undefined };
  }
}
const revision = sourceRevision();

export default defineConfig({
  define: {
    'import.meta.env.VITE_TELEVECHA_COMMIT': JSON.stringify(revision.commit),
    'import.meta.env.VITE_TELEVECHA_SOURCE_MODIFIED': JSON.stringify(revision.modified ?? null),
  },
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
