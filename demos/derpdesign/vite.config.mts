import type { IncomingMessage } from 'node:http';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mergeConfig, type ViteDevServer } from 'vite';
import app from '../../vite.config';

const support = import.meta.dirname;
const root = resolve(support, '../..');
const cli = realpathSync(execFileSync('which', ['derpdesign'], { encoding: 'utf8' }).trim());
const harness = resolve(dirname(cli), '../packages/harness');
export default mergeConfig(app, {
  root,
  define: { 'import.meta.env.VITE_TELEVECHA_E2E': JSON.stringify('1') },
  resolve: { alias: { '@derpdesign/harness': harness } },
  server: { host: '127.0.0.1', strictPort: true, fs: { allow: [root, harness] } },
  plugins: [
    {
      name: 'conversation-gallery',
      enforce: 'pre',
      transformIndexHtml() {
        return [
          {
            tag: 'script',
            attrs: { type: 'module', src: '/demos/derpdesign/main.ts' },
            injectTo: 'head-prepend' as const,
          },
        ];
      },
      configureServer(server: ViteDevServer) {
        // Vite closes ping sockets before its normal connection error handler is installed.
        // Ladybird may answer that close with a protocol error during a server restart.
        server.httpServer?.on('upgrade', (request: IncomingMessage) => {
          if (request.headers['sec-websocket-protocol'] !== 'vite-ping') return;
          for (const { socket } of server.ws.clients) {
            if (socket.readyState === socket.CLOSING && !socket.listenerCount('error')) {
              socket.once('error', () => socket.terminate());
            }
          }
        });
      },
      resolveId(id: string, importer?: string) {
        if (importer?.split('?')[0] !== resolve(root, 'src/ui/app/appRuntime.ts')) return;
        if (id === '../../telegram/transports/fixtureTransport')
          return resolve(support, 'gallery.ts');
        if (id === '../../telegram/persistence/store') return resolve(support, 'cache-mock.ts');
        return undefined;
      },
    },
  ],
});
