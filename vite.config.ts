import { widgetSandbox } from '@telegram/widget-sandbox/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite-plus';
import { effectwebLint } from '@effectweb/compiler/lint-preset';
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
  plugins: [
    effectweb(),
    tailwindcss(),
    {
      ...widgetSandbox(),
      // Isolate only the dedicated widget viewer; bot Mini Apps keep their existing context.
      config: () => ({
        worker: { format: 'es' },
        optimizeDeps: { exclude: ['@telegram/widget-sandbox-quickjs'] },
      }),
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/assets/') || req.url?.includes('/@telegram/widget-sandbox/')) {
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          }
          if (req.url?.split('?')[0] === '/widget.html') {
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          }
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/assets/') || req.url?.includes('/@telegram/widget-sandbox/')) {
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          }
          if (req.url?.split('?')[0] === '/widget.html') {
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          }
          next();
        });
      },
    },
  ],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { main: 'index.html', widget: 'widget.html' },
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
    jsPlugins: effectwebLint.jsPlugins,
    options: { typeAware: true, typeCheck: true },
    rules: {
      ...effectwebLint.rules,
      'effecttsgo/missing-effect-context': 'error',
      'effecttsgo/missing-effect-error': 'error',
      'effecttsgo/missing-layer-context': 'error',
      'effecttsgo/missing-return-yield-star': 'error',
      'effecttsgo/missing-star-in-yield-effect-gen': 'error',
      'effecttsgo/class-self-mismatch': 'error',
      'effecttsgo/non-object-effect-service-type': 'error',
      'typescript/no-misused-promises': 'error',
      'typescript/switch-exhaustiveness-check': 'error',
      'typescript/no-explicit-any': 'error',
      'typescript/no-floating-promises': ['error', { ignoreVoid: false }],
      'typescript/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
      'effecttsgo/any-unknown-in-error-context': 'off',
      'effecttsgo/floating-effect': 'error',
      'no-console': ['error', { allow: ['debug', 'info', 'warn', 'error'] }],
    },
    overrides: [
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
        rules: {
          'typescript/no-unsafe-argument': 'error',
          'typescript/no-unsafe-assignment': 'error',
          'typescript/no-unsafe-call': 'error',
          'typescript/no-unsafe-member-access': 'error',
          'typescript/no-unsafe-return': 'error',
        },
      },
    ],
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
