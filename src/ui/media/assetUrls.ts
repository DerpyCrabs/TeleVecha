import { Effect } from 'effect';

const MAX_CACHED_ASSET_URLS = 256;

type AssetRegistry = Map<string, string>;
const assets: AssetRegistry = new Map();

export function cachedAssetUrl(key: string) {
  const url = assets.get(key);
  if (url) {
    assets.delete(key);
    assets.set(key, url);
  }
  return url;
}

/** Moves an upload's URL to its confirmed media key without revoking the mounted image. */
export function moveAssetUrl(from: string, to: string) {
  const current = cachedAssetUrl(to);
  if (current) return current;
  const url = assets.get(from);
  if (!url) return undefined;
  assets.delete(from);
  assets.set(to, url);
  return url;
}

function activeObjectUrls() {
  if (typeof document === 'undefined') return new Set<string>();
  const active = new Set<string>();
  for (const element of document.querySelectorAll<HTMLElement>('[src], [href]')) {
    if (
      element instanceof HTMLImageElement ||
      element instanceof HTMLVideoElement ||
      element instanceof HTMLAudioElement
    ) {
      if (element.src.startsWith('blob:')) active.add(element.src);
    } else if (element instanceof HTMLAnchorElement && element.href.startsWith('blob:')) {
      active.add(element.href);
    }
  }
  return active;
}

export function clearAssetUrls() {
  for (const url of assets.values()) URL.revokeObjectURL(url);
  assets.clear();
}

export function pruneAssetUrls(protectedUrls: ReadonlySet<string> = new Set()) {
  if (assets.size <= MAX_CACHED_ASSET_URLS) return;
  const active = activeObjectUrls();
  for (const [key, url] of assets) {
    if (assets.size <= MAX_CACHED_ASSET_URLS) break;
    if (active.has(url) || protectedUrls.has(url)) continue;
    assets.delete(key);
    URL.revokeObjectURL(url);
  }
}

export function rememberAssetUrl(key: string, blob: Blob) {
  const cached = cachedAssetUrl(key);
  if (cached) return cached;
  // Prune before allocating, then protect the new URL until its consumer can mount it.
  // Otherwise the first URL beyond the cap is the only inactive entry and gets revoked
  // before the resolved promise can put it in an image or video element.
  pruneAssetUrls();
  const url = URL.createObjectURL(blob);
  assets.set(key, url);
  pruneAssetUrls(new Set([url]));
  return url;
}

export const loadAssetUrl = <Error>(key: string, load: () => Effect.Effect<Blob, Error>) =>
  Effect.suspend(() => {
    const cached = cachedAssetUrl(key);
    if (cached) return Effect.succeed(cached);
    return load().pipe(Effect.map((blob) => rememberAssetUrl(key, blob)));
  });
