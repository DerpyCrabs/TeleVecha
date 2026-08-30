import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

import { beforeAll, describe, expect, it, vi } from 'vitest';

type WorkerEvent = { waitUntil(promise: Promise<unknown>): void };
type WorkerHandler = (event: WorkerEvent) => void;

let workerSource = '';

beforeAll(async () => {
  workerSource = await readFile(new URL('../../../public/sw.js', import.meta.url), 'utf8');
});

function workerHarness(options: { failAssetBatch?: boolean; cacheNames?: string[] } = {}) {
  const handlers = new Map<string, WorkerHandler>();
  const cacheEntries = new Map<string, Map<string, Response>>([
    [
      'televecha-shell-v1',
      new Map([
        ['/index.html', new Response('old html')],
        ['/assets/old-build.js', new Response('old build')],
      ]),
    ],
  ]);
  const deleted: string[] = [];
  let addAllCalls = 0;
  const caches = {
    open: vi.fn(async (name: string) => {
      const entries = cacheEntries.get(name) ?? new Map<string, Response>();
      cacheEntries.set(name, entries);
      return {
        async addAll(urls: string[]) {
          addAllCalls += 1;
          if (options.failAssetBatch && addAllCalls === 2) {
            throw new Error('new asset unavailable');
          }
          for (const url of urls) entries.set(url, new Response(`cached ${url}`));
        },
        async put(key: string | Request, response: Response) {
          entries.set(typeof key === 'string' ? key : key.url, response);
        },
      };
    }),
    keys: vi.fn(async () => options.cacheNames ?? [...cacheEntries.keys()]),
    delete: vi.fn(async (key: string) => {
      deleted.push(key);
      cacheEntries.delete(key);
      return true;
    }),
    match: vi.fn(async () => undefined),
  };
  const self = {
    addEventListener(type: string, handler: WorkerHandler) {
      handlers.set(type, handler);
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    location: { origin: 'https://televecha.test' },
  };
  const fetch = vi.fn(async () => {
    return new Response('<script src="/assets/new-build.js"></script>');
  });
  runInNewContext(workerSource, { self, caches, fetch, URL });

  const dispatch = async (type: string) => {
    let lifetime: Promise<unknown> = Promise.resolve();
    handlers.get(type)?.({
      waitUntil(promise) {
        lifetime = Promise.resolve(promise);
      },
    });
    return lifetime;
  };

  return { entries: (name: string) => cacheEntries.get(name) ?? new Map(), deleted, dispatch };
}

describe('service worker cache upgrades', () => {
  it('leaves the active offline shell untouched when a new install is incomplete', async () => {
    const worker = workerHarness({ failAssetBatch: true });

    await expect(worker.dispatch('install')).rejects.toThrow('new asset unavailable');

    expect(await worker.entries('televecha-shell-v1').get('/index.html')?.text()).toBe('old html');
  });

  it('removes hashed assets from older TeleVecha builds after a successful activation', async () => {
    const worker = workerHarness();

    await worker.dispatch('install');
    await worker.dispatch('activate');

    expect(worker.entries('televecha-shell-v1').has('/assets/old-build.js')).toBe(false);
    expect(worker.entries('televecha-shell-v2').has('/assets/new-build.js')).toBe(true);
  });

  it('does not delete caches owned by another app on the same origin', async () => {
    const worker = workerHarness({
      cacheNames: ['televecha-shell-v1', 'unrelated-application-cache'],
    });

    await worker.dispatch('activate');

    expect(worker.deleted).not.toContain('unrelated-application-cache');
  });
});
