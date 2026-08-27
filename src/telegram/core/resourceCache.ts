/**
 * Owns request coalescing and versioning for disposable Telegram resources.
 * The engine decides how a resource is loaded; this module guarantees that
 * concurrent callers share one request and stale media cannot be persisted.
 */
export class ResourceCache {
  private readonly requests = new Map<string, Promise<unknown>>();
  private readonly values = new Map<string, unknown>();
  private readonly versions = new Map<string, number>();

  async load<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const current = this.requests.get(key) as Promise<T> | undefined;
    if (current) return current;

    const request = loader();
    this.requests.set(key, request);
    try {
      return await request;
    } finally {
      if (this.requests.get(key) === request) this.requests.delete(key);
    }
  }

  async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    if (this.values.has(key)) return this.values.get(key) as T;
    return this.load(key, async () => {
      const value = await loader();
      this.values.set(key, value);
      return value;
    });
  }

  forget(key: string) {
    this.requests.delete(key);
    this.values.delete(key);
  }

  version(key: string) {
    return this.versions.get(key) ?? 0;
  }

  invalidate(key: string, ...requestKeys: string[]) {
    this.versions.set(key, this.version(key) + 1);
    for (const requestKey of requestKeys) this.requests.delete(requestKey);
  }

  deleteRequest(key: string) {
    this.requests.delete(key);
  }

  clear() {
    this.requests.clear();
    this.values.clear();
    this.versions.clear();
  }
}
