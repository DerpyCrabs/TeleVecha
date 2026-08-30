const registryKey = '__televechaAssetUrls';
const pendingRegistryKey = '__televechaPendingAssetUrls';
const MAX_CACHED_ASSET_URLS = 256;

type AssetRegistry = Map<string, string>;

function registry(): AssetRegistry {
  const root = globalThis as typeof globalThis & { [registryKey]?: AssetRegistry };
  return (root[registryKey] ??= new Map());
}

function pendingRegistry() {
  const root = globalThis as typeof globalThis & {
    [pendingRegistryKey]?: Map<string, Promise<string>>;
  };
  return (root[pendingRegistryKey] ??= new Map());
}

export function cachedAssetUrl(key: string) {
  const assets = registry();
  const url = assets.get(key);
  if (url) {
    assets.delete(key);
    assets.set(key, url);
  }
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
  for (const url of registry().values()) URL.revokeObjectURL(url);
  registry().clear();
  pendingRegistry().clear();
}

export function pruneAssetUrls(protectedUrls: ReadonlySet<string> = new Set()) {
  const assets = registry();
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
  registry().set(key, url);
  pruneAssetUrls(new Set([url]));
  return url;
}

export function loadAssetUrl(key: string, load: () => Promise<Blob>) {
  const cached = cachedAssetUrl(key);
  if (cached) return Promise.resolve(cached);
  const pending = pendingRegistry();
  const current = pending.get(key);
  if (current) return current;
  const request = load().then((blob) => rememberAssetUrl(key, blob));
  pending.set(key, request);
  const clear = () => {
    if (pending.get(key) === request) pending.delete(key);
  };
  void request.then(clear, clear);
  return request;
}
