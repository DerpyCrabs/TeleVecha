import { createServer } from '@voidzero-dev/vite-plus-core';

const port = Number(process.argv[2] ?? 4174);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid Playwright server port: ${process.argv[2] ?? ''}`);
}

const server = await createServer({
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
  },
});

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
};

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

await server.listen();
server.printUrls();
