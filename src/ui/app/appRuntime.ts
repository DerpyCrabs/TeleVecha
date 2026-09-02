import { MessagingEngine } from '../../telegram/core/engine';
import type { MessagingClient } from '../../telegram/core/client';
import { BrowserDebugReportRecorder } from '../../debug/tvbugReports';
import { createTvBugSnapshotClient, injectedTvBugBundle } from '../../debug/tvbugRuntime';
import { IndexedDbCacheStore } from '../../telegram/persistence/store';
import { TabCoordinator, type TabCoordinatorOwner } from '../../telegram/session/tabCoordinator';
import { FixtureTelegramTransport } from '../../telegram/transports/fixtureTransport';
import type { PendingSend, TelegramCredentials, TelegramTransport } from '../../telegram/types';
import { createWebTelegramTransport } from '../../telegram/transports/webTelegramTransport';

export interface AppRuntime {
  engine: MessagingClient;
  debugReports?: DebugReportModule | undefined;
}

export interface PreparedDebugReport {
  file: File;
  preview: {
    compressedBytes: number;
    diagnosticCount: number;
    messageCount: number;
    traceCount: number;
    truncated: boolean;
  };
}

export interface DebugReportModule {
  prepare(): Promise<PreparedDebugReport>;
  recordPeerSelection?(peerId: string): void;
  recordComposerReply?(peerId: string, messageId: number): void;
  recordComposerSend?(peerId: string, text: string): void;
  recordComposerFocus?(peerId: string, focused: boolean): void;
  recordViewport?(
    peerId: string,
    phase: 'before-send' | 'after-send',
    sample: number,
    geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
  ): void;
}

interface ControlledRuntime extends AppRuntime {
  transport?: TelegramTransport | undefined;
}

export interface AppEnvironment {
  runtime: AppRuntime;
  credentials?: TelegramCredentials | undefined;
  configurationError?: string | undefined;
  tvbug?: boolean | undefined;
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
  const debugReports = new BrowserDebugReportRecorder(reader);
  created.debugReports = debugReports;
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
      const sourceTransport: TelegramTransport = fixtureMode
        ? new FixtureTelegramTransport()
        : createWebTelegramTransport(store);
      const engine = new MessagingEngine(sourceTransport, store, { manageTabLease: false });
      debugReports.attachEngine(engine);
      return {
        engine,
        // Keep the controllable live transport available to fixture tooling. Exposing the
        // recording proxy here would make a test override call back into its own wrapper.
        transport: sourceTransport,
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
  const tvbugBundle = injectedTvBugBundle();
  if (tvbugBundle) {
    const root = globalThis as typeof globalThis & { __televechaTvBugRuntime?: AppRuntime };
    const tvbugRuntime = (root.__televechaTvBugRuntime ??= {
      engine: createTvBugSnapshotClient(tvbugBundle),
    });
    return {
      runtime: tvbugRuntime,
      tvbug: true,
    };
  }
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
