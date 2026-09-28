// Only media URLs are intercepted. The application shell always comes from the network.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith('televecha-shell-')).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function byteRange(header, size) {
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return undefined;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size
    ? { start, end }
    : undefined;
}

async function serveMedia(event, token) {
  const client = await self.clients.get(event.clientId);
  if (!client) return new Response(null, { status: 404 });
  const { port1, port2 } = new MessageChannel();
  let pending;
  const receive = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = undefined;
        reject(new Error('Media request timed out.'));
      }, 65_000);
      pending = { resolve, reject, timer };
    });
  port1.onmessage = ({ data }) => {
    if (!pending) return;
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    if (data.error) current.reject(new Error(data.error));
    else current.resolve(data);
  };
  const close = () => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Media request canceled.'));
      pending = undefined;
    }
    port1.postMessage({ cancel: true });
    port1.close();
  };
  try {
    const metadata = receive();
    client.postMessage({ type: 'televecha-media-stream', token }, [port2]);
    const { size, mimeType } = await metadata;
    const range = byteRange(event.request.headers.get('Range'), size);
    if (!range) {
      close();
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const partial = event.request.headers.has('Range');
    const headers = {
      'Content-Type': mimeType,
      'Content-Length': String(range.end - range.start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...(partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}),
    };
    if (event.request.method === 'HEAD') {
      close();
      return new Response(null, { status: partial ? 206 : 200, headers });
    }
    let position = range.start;
    let canceled = false;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const end = Math.min(range.end, position + 256 * 1024 - 1);
          const next = receive();
          port1.postMessage({ start: position, end });
          const { bytes } = await next;
          if (canceled) return;
          if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== end - position + 1)
            throw new Error('Incomplete media range.');
          controller.enqueue(new Uint8Array(bytes));
          position = end + 1;
          if (position > range.end) {
            controller.close();
            close();
          }
        } catch (error) {
          if (!canceled) controller.error(error);
          close();
        }
      },
      cancel() {
        canceled = true;
        close();
      },
    });
    return new Response(stream, { status: partial ? 206 : 200, headers });
  } catch {
    close();
    return new Response(null, { status: 502 });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const prefix = new URL('__televecha_media__/', self.registration.scope).pathname;
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return;
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
  event.respondWith(serveMedia(event, url.pathname.slice(prefix.length)));
});
