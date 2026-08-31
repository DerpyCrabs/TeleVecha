import { MessagingEngine } from '../../telegram/core/engine';
import type { MessagingClient } from '../../telegram/core/client';
import { BrowserDebugReportRecorder } from '../../debug/reproReports';
import type { ReproBundleV1 } from '../../debug/reproFormat';
import { createReproEngine, injectedReproBundle } from '../../debug/reproRuntime';
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
    timelineCount: number;
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
  ignoreNextTransportCall?(method: string): void;
}

export type ReplayUiAction =
  | { type: 'select-chat'; peerId: string; afterSequence: number }
  | { type: 'composer-reply'; peerId: string; messageId: number; afterSequence: number }
  | { type: 'composer-send'; peerId: string; text: string; afterSequence: number };

interface ControlledRuntime extends AppRuntime {
  transport?: TelegramTransport | undefined;
}

export interface AppEnvironment {
  runtime: AppRuntime;
  credentials?: TelegramCredentials | undefined;
  configurationError?: string | undefined;
  replay?: boolean | undefined;
  replayUiActions?: readonly ReplayUiAction[] | undefined;
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
      const recordedTransport = debugReports.wrapTransport(sourceTransport);
      const engine = new MessagingEngine(recordedTransport, store, { manageTabLease: false });
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
  const reproBundle = injectedReproBundle();
  if (reproBundle) {
    const root = globalThis as typeof globalThis & { __televechaReproRuntime?: AppRuntime };
    const replayRuntime = (root.__televechaReproRuntime ??= {
      engine: createReproEngine(reproBundle),
    });
    return {
      runtime: replayRuntime,
      credentials: { apiId: 1, apiHash: 'offline-replay' },
      replay: true,
      replayUiActions: reproBundle.timeline.flatMap((event, index): ReplayUiAction[] => {
        if (event.kind !== 'ui') return [];
        if (!event.value || Array.isArray(event.value) || typeof event.value !== 'object')
          return [];
        const peerId = event.value.peerId;
        if (typeof peerId !== 'string') return [];
        const afterSequence = replayActionAfterSequence(reproBundle.timeline, index, peerId);
        if (event.method === 'select-chat') {
          return [{ type: 'select-chat', peerId, afterSequence }];
        }
        if (event.method === 'composer-reply') {
          const messageId = event.value.messageId;
          return typeof messageId === 'number' && Number.isSafeInteger(messageId)
            ? [{ type: 'composer-reply', peerId, messageId, afterSequence }]
            : [];
        }
        if (event.method === 'composer-send') {
          const text = event.value.text;
          return typeof text === 'string'
            ? [{ type: 'composer-send', peerId, text, afterSequence }]
            : [];
        }
        return [];
      }),
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

export function replayActionAfterSequence(
  timeline: ReproBundleV1['timeline'],
  actionIndex: number,
  peerId: string,
) {
  const transportKinds = new Set(['call', 'resolve', 'reject', 'push']);
  for (let index = actionIndex + 1; index < timeline.length; index += 1) {
    const event = timeline[index]!;
    if (event.kind !== 'call' || !reproValueReferencesPeer(event.args, peerId)) continue;
    for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
      const prior = timeline[priorIndex]!;
      if (transportKinds.has(prior.kind)) return prior.seq;
    }
    return 0;
  }
  for (let index = actionIndex - 1; index >= 0; index -= 1) {
    const event = timeline[index]!;
    if (transportKinds.has(event.kind)) return event.seq;
  }
  return 0;
}

function reproValueReferencesPeer(value: unknown, peerId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => reproValueReferencesPeer(item, peerId));
  const record = value as Record<string, unknown>;
  if (record.id === peerId || record.peerId === peerId) return true;
  return Object.values(record).some((item) => reproValueReferencesPeer(item, peerId));
}
