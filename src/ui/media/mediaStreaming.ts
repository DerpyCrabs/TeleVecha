const CHUNK_SIZE = 256 * 1024;
const MAX_CHUNKS = 64;

/** Serve browser range requests through the tab that owns this media URL. */
export function createMediaStreaming() {
  const entries = new Map<
    string,
    {
      token: string;
      size: number;
      mimeType: string;
      load: (start: number, end: number) => Promise<Blob>;
    }
  >();
  const urls = new Map<string, string>();
  const chunks = new Map<string, Promise<Blob>>();
  const ports = new Set<MessagePort>();
  let disposed = false;
  let ready: Promise<boolean> | undefined;
  const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const base = new URL(
    import.meta.env.BASE_URL || '/',
    typeof location === 'undefined' ? 'http://localhost/' : location.href,
  );

  const prepare = () =>
    (ready ??= (async () => {
      if (!supported) return false;
      try {
        const registration = await navigator.serviceWorker.register(new URL('sw.js', base), {
          scope: base.pathname,
        });
        return await new Promise<boolean>((resolve) => {
          const controlled = () => {
            if (navigator.serviceWorker.controller?.scriptURL !== new URL('sw.js', base).href)
              return;
            clearTimeout(timer);
            navigator.serviceWorker.removeEventListener('controllerchange', controlled);
            resolve(true);
          };
          const timer = setTimeout(() => {
            navigator.serviceWorker.removeEventListener('controllerchange', controlled);
            resolve(false);
          }, 5_000);
          navigator.serviceWorker.addEventListener('controllerchange', controlled);
          // The active worker claims existing clients, so first playback needs no reload.
          if (registration.active) controlled();
        });
      } catch {
        return false;
      }
    })());

  const onMessage = (event: MessageEvent<{ type?: unknown; token?: unknown } | undefined>) => {
    if (
      event.data?.type !== 'televecha-media-stream' ||
      typeof event.data.token !== 'string' ||
      !event.ports[0]
    )
      return;
    const port = event.ports[0];
    const entry = entries.get(event.data.token);
    if (!entry || disposed) {
      port.postMessage({ error: 'Media is no longer available.' });
      port.close();
      return;
    }
    ports.add(port);
    port.onmessage = ({ data }: MessageEvent<{ cancel?: boolean; start: number; end: number }>) => {
      if (data.cancel) {
        ports.delete(port);
        port.close();
        return;
      }
      const { start, end } = data as { start: number; end: number };
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end >= entry.size ||
        end - start >= CHUNK_SIZE
      ) {
        port.postMessage({ error: 'Invalid media range.' });
        return;
      }
      const read = async () => {
        const blobs: Blob[] = [];
        const first = Math.floor(start / CHUNK_SIZE) * CHUNK_SIZE;
        for (let offset = first; offset <= end; offset += CHUNK_SIZE) {
          const key = `${entry.token}:${offset}`;
          let chunk = chunks.get(key);
          if (!chunk) {
            chunk = entry.load(offset, Math.min(entry.size - 1, offset + CHUNK_SIZE - 1));
            chunks.set(key, chunk);
          } else {
            chunks.delete(key);
            chunks.set(key, chunk);
          }
          while (chunks.size > MAX_CHUNKS) chunks.delete(chunks.keys().next().value!);
          try {
            blobs.push(await chunk);
          } catch (error) {
            chunks.delete(key);
            throw error;
          }
          if (!ports.has(port) || disposed) return;
        }
        const bytes = await new Blob(blobs).slice(start - first, end - first + 1).arrayBuffer();
        if (ports.has(port)) port.postMessage({ bytes }, [bytes]);
      };
      read().catch(() => {
        if (ports.has(port))
          port.postMessage({ error: 'Could not load this video. Try opening it again.' });
      });
    };
    port.postMessage({ size: entry.size, mimeType: entry.mimeType });
  };
  if (supported) navigator.serviceWorker.addEventListener('message', onMessage);
  return {
    async url(
      key: string,
      size: number,
      mimeType: string,
      load: (start: number, end: number) => Promise<Blob>,
    ) {
      if (!Number.isSafeInteger(size) || size <= 0 || !(await prepare()) || disposed)
        return undefined;
      // Keys stay in this tab; URLs contain only random, session-local tokens.
      const known = urls.get(key);
      if (known) return known;
      const entry = { token: crypto.randomUUID(), size, mimeType, load };
      entries.set(entry.token, entry);
      const url = new URL(`__televecha_media__/${entry.token}`, base).href;
      urls.set(key, url);
      return url;
    },
    dispose() {
      disposed = true;
      if (supported) navigator.serviceWorker.removeEventListener('message', onMessage);
      for (const port of ports) {
        port.postMessage({ error: 'Media playback closed.' });
        port.close();
      }
      ports.clear();
      entries.clear();
      chunks.clear();
      urls.clear();
    },
  };
}
