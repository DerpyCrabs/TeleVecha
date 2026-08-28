import { MessagingEngine } from '../../telegram/core/engine';
import type { MessagingClient } from '../../telegram/core/client';
import { IndexedDbCacheStore } from '../../telegram/persistence/store';
import { TabCoordinator, type TabCoordinatorOwner } from '../../telegram/session/tabCoordinator';
import { FixtureTelegramTransport } from '../../telegram/transports/fixtureTransport';
import type { PendingSend, TelegramCredentials, TelegramTransport } from '../../telegram/types';
import { WebAGramJsTransport } from '../../telegram/transports/webAGramJsTransport';

export interface AppRuntime {
  engine: MessagingClient;
}

interface ControlledRuntime extends AppRuntime {
  transport?: TelegramTransport | undefined;
}

export interface AppEnvironment {
  runtime: AppRuntime;
  credentials?: TelegramCredentials | undefined;
  configurationError?: string | undefined;
}

function environmentCredentials(): TelegramCredentials | undefined {
  const envId = Number(import.meta.env.VITE_TELEGRAM_API_ID);
  const envHash = String(import.meta.env.VITE_TELEGRAM_API_HASH ?? '').trim();
  if (envId && envHash) return { apiId: envId, apiHash: envHash };
  return undefined;
}

function runtime(fixtureMode: boolean, fixtureScenario: string | null): ControlledRuntime {
  const root = globalThis as typeof globalThis & {
    __televechaRuntimes?: Map<string, ControlledRuntime>;
  };
  const key = fixtureMode ? `fixture:${fixtureScenario ?? 'default'}` : 'production';
  const runtimes = (root.__televechaRuntimes ??= new Map());
  const existing = runtimes.get(key);
  if (existing) return existing;

  const databaseName = fixtureMode
    ? `televecha-e2e${fixtureScenario ? `-${fixtureScenario}` : ''}`
    : 'televecha';
  const created: ControlledRuntime = { engine: undefined as unknown as MessagingClient };
  const reader = new IndexedDbCacheStore(databaseName);
  const pendingPayloads = new Map<string, PendingSend>();
  const coordinator = new TabCoordinator({
    key,
    loadBlob: (blobKey) => reader.loadBlob(blobKey),
    hydrateSnapshot: async (snapshot, pendingPayloadIds) => {
      const payloadIds = new Set(pendingPayloadIds);
      for (const id of pendingPayloads.keys()) {
        if (!payloadIds.has(id)) pendingPayloads.delete(id);
      }
      const missing = pendingPayloadIds.filter((id) => !pendingPayloads.has(id));
      if (missing.length > 0) {
        const missingIds = new Set(missing);
        for (const pending of (await reader.loadWorkspace()).pending) {
          if (missingIds.has(pending.id)) pendingPayloads.set(pending.id, pending);
        }
      }
      if (pendingPayloads.size === 0) return snapshot;
      return {
        ...snapshot,
        pending: snapshot.pending.map((pending) =>
          payloadIds.has(pending.id) ? (pendingPayloads.get(pending.id) ?? pending) : pending,
        ),
      };
    },
    createOwner(): TabCoordinatorOwner {
      const store = new IndexedDbCacheStore(databaseName);
      const transport: TelegramTransport = fixtureMode
        ? new FixtureTelegramTransport()
        : new WebAGramJsTransport(store);
      return {
        engine: new MessagingEngine(transport, store, { manageTabLease: false }),
        transport,
      };
    },
    ownerChanged(owner) {
      created.transport = owner?.transport as TelegramTransport | undefined;
    },
  });
  created.engine = coordinator.client;
  runtimes.set(key, created);
  return created;
}

export function defaultAppEnvironment(search = window.location.search): AppEnvironment {
  const fixtureMode = import.meta.env.VITE_TELEVECHA_E2E === '1';
  const credentials = fixtureMode ? { apiId: 1, apiHash: 'fixture' } : environmentCredentials();
  const fixtureScenario = new URLSearchParams(search).get('scenario');
  return {
    runtime: runtime(fixtureMode, fixtureScenario),
    credentials,
    configurationError: credentials
      ? undefined
      : 'TeleVecha could not find VITE_TELEGRAM_API_ID and VITE_TELEGRAM_API_HASH.',
  };
}
