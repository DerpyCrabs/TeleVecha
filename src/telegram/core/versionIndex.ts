type VersionDomain = 'dialog' | 'draft' | 'mutation' | 'reaction' | 'shared-counts' | 'unread';

/** Owns monotonic invalidation tokens across independent async concerns. */
export function makeVersionIndex() {
  const versions = new Map<string, number>();
  let sequence = 0;
  const entryKey = (domain: VersionDomain, key: string) => `${domain}\u0000${key}`;

  return {
    current: (domain: VersionDomain, key: string) => versions.get(entryKey(domain, key)) ?? 0,
    set(domain: VersionDomain, key: string, version: number) {
      sequence = Math.max(sequence, version);
      versions.set(entryKey(domain, key), version);
      return version;
    },
    next(domain: VersionDomain, key: string) {
      const version = ++sequence;
      versions.set(entryKey(domain, key), version);
      return version;
    },
    increment(domain: VersionDomain, key: string) {
      const version = (versions.get(entryKey(domain, key)) ?? 0) + 1;
      sequence = Math.max(sequence, version);
      versions.set(entryKey(domain, key), version);
      return version;
    },
    delete(domain: VersionDomain, key: string, version?: number) {
      const encoded = entryKey(domain, key);
      if (version !== undefined && versions.get(encoded) !== version) return false;
      return versions.delete(encoded);
    },
    clear(domain?: VersionDomain) {
      if (!domain) {
        versions.clear();
        sequence = 0;
        return;
      }
      const prefix = `${domain}\u0000`;
      for (const key of versions.keys()) {
        if (key.startsWith(prefix)) versions.delete(key);
      }
    },
  };
}
