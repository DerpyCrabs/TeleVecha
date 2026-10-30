import { SecureRandom, Digest, Kdf } from 'effect/crypto';
import { BrowserCrypto, BrowserSocket } from '@effect/platform-browser';
import { Cause, Effect, Fiber, FiberSet, Layer } from 'effect';
import * as Socket from 'effect/socket/Socket';

import { createBrowserDebugReportRecorder } from '../../debug/tvbugReports';
import type { TvBugUiSourceV2 } from '../../debug/tvbugFormat';
import type { TvBugChatAppearanceState } from '../../debug/tvbugUiState';
import { createTvBugSnapshotClient, injectedTvBugBundle } from '../../debug/tvbugRuntime';
import type { EffectMessagingClient } from '../../telegram/core/client';
import { makeMessagingEngine, MessagingEngineLayer } from '../../telegram/core/engine';
import { makeResourceCache } from '../../telegram/core/resourceCache';
import { AccountState, EngineStateLayer } from '../../telegram/core/engineState';
import { EngineTasks } from '../../telegram/core/engineTasks';
import {
  createIndexedDbCacheStore,
  type IndexedDbCacheStore,
} from '../../telegram/persistence/store';
import {
  makeTabCoordinator,
  type TabCoordinatorOwner,
} from '../../telegram/session/tabCoordinator';
import { CoordinatorTasksLayer } from '../../telegram/session/coordinatorTasks';
import { createWebTelegramTransport } from '../../telegram/transports/webTelegramTransport';
import type { PendingSend, TelegramCredentials, TelegramTransport } from '../../telegram/types';

export interface AppRuntime {
  engine: EffectMessagingClient;
  runEffect: UiEffectRunner;
  runTask: UiTaskRunner;
  runSharedEffect: UiSharedEffectRunner;
  debugReports?: DebugReportModule | undefined;
}

export type UiEffectRunner = <Value, Error>(effect: Effect.Effect<Value, Error>) => Promise<Value>;
/** Start work in the application scope and keep its completion as an Effect fiber. */
export type UiTaskRunner = <Value, Error>(
  effect: Effect.Effect<Value, Error>,
) => Fiber.Fiber<Value, Error>;
export interface UiSharedEffectRunner {
  <Value, Error>(key: string, effect: Effect.Effect<Value, Error>): Promise<Value>;
  cancel(key: string): Promise<void>;
  load<Value, Error>(key: string, effect: Effect.Effect<Value, Error>): Effect.Effect<Value, Error>;
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
  dispose(): void;
  prepare(): Effect.Effect<PreparedDebugReport, unknown>;
  attachUi?(source: () => TvBugUiSourceV2): () => void;
  recordChatAppearance?(value: TvBugChatAppearanceState): void;
  recordRuntime?(value: {
    phase: string;
    sync: string;
    online: boolean;
    activePeerId?: string | undefined;
  }): void;
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

/** The application owns subscription acquisition, cancellation, and async release. */
export const subscribeAtUi = <Error>(
  runTask: UiTaskRunner,
  acquire: Effect.Effect<Effect.Effect<void>, Error>,
) => {
  const fiber = runTask(
    Effect.scoped(
      Effect.acquireRelease(acquire, (release) => release).pipe(
        Effect.andThen(Effect.never),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause),
        ),
      ),
    ),
  );
  return () => {
    runTask(Fiber.interrupt(fiber));
  };
};

function environmentCredentials(): TelegramCredentials | undefined {
  const envId = Number(import.meta.env.VITE_TELEGRAM_API_ID);
  const envHash = String(import.meta.env.VITE_TELEGRAM_API_HASH ?? '').trim();
  if (envId && envHash) return { apiId: envId, apiHash: envHash };
  return undefined;
}

const makeRuntime = Effect.fn('AppRuntime.make')(function* (
  fixtureMode: boolean,
  fixtureScenario: string | null,
  runEffect: UiEffectRunner,
  runTask: UiTaskRunner,
) {
  const crypto = yield* Effect.context<SecureRandom.SecureRandom | Digest.Digest | Kdf.Kdf>();
  const webSocket = yield* Socket.WebSocketConstructor;
  const accountState = yield* AccountState;
  const engineTasks = yield* EngineTasks;
  const databaseName = fixtureMode
    ? `televecha-e2e${fixtureScenario ? `-${fixtureScenario}` : ''}`
    : 'televecha';
  const store = yield* createIndexedDbCacheStore(databaseName);
  const sharedEffects = yield* makeResourceCache();
  const runSharedEffect: UiSharedEffectRunner = Object.assign(
    <Value, Error>(key: string, effect: Effect.Effect<Value, Error>) =>
      runEffect(sharedEffects.load(key, () => effect)),
    {
      cancel: (key: string) => runEffect(sharedEffects.forget(key)),
      load: <Value, Error>(key: string, effect: Effect.Effect<Value, Error>) =>
        sharedEffects.load(key, () => effect),
    },
  );
  const pendingPayloads = new Map<string, PendingSend>();
  let controlled: ControlledRuntime | undefined;
  const coordinator = yield* makeTabCoordinator({
    key: fixtureMode ? `fixture:${fixtureScenario ?? 'default'}` : 'production',
    loadBlob: (blobKey) => store.loadBlob(blobKey),
    hydrateSnapshot: (snapshot, pendingPayloadIds) =>
      Effect.gen(function* () {
        const payloadIds = new Set(pendingPayloadIds);
        for (const id of pendingPayloads.keys()) {
          if (!payloadIds.has(id)) pendingPayloads.delete(id);
        }
        const missing = pendingPayloadIds.filter((id) => !pendingPayloads.has(id));
        if (missing.length > 0) {
          const missingIds = new Set(missing);
          for (const pending of (yield* store.loadWorkspace()).pending) {
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
      }),
    createOwner: () =>
      Effect.gen(function* () {
        const transport =
          import.meta.env.VITE_TELEVECHA_E2E === '1'
            ? yield* Effect.tryPromise({
                try: () => import('../../telegram/transports/fixtureTransport'),
                catch: (cause) => new Error('Could not load the fixture transport.', { cause }),
              }).pipe(
                Effect.flatMap(({ createFixtureTelegramTransport }) =>
                  createFixtureTelegramTransport(),
                ),
              )
            : yield* createWebTelegramTransport(store).pipe(
                Effect.provideContext(crypto),
                Effect.provideService(Socket.WebSocketConstructor, webSocket),
              );
        const engine = yield* makeMessagingEngine(transport, store, { manageTabLease: false }).pipe(
          Effect.provideService(AccountState, accountState),
          Effect.provideService(EngineTasks, engineTasks),
          Effect.provideContext(crypto),
        );
        return import.meta.env.VITE_TELEVECHA_E2E === '1'
          ? ({ engine, transport } satisfies TabCoordinatorOwner)
          : ({ engine } satisfies TabCoordinatorOwner);
      }),
    ...(import.meta.env.VITE_TELEVECHA_E2E === '1'
      ? {
          ownerChanged: (owner: TabCoordinatorOwner | undefined) =>
            Effect.sync(() => {
              if (controlled)
                controlled.transport = owner?.transport as TelegramTransport | undefined;
            }),
        }
      : {}),
  });
  const engine = coordinator.client;
  const recorder = createBrowserDebugReportRecorder(store as IndexedDbCacheStore);
  yield* Effect.addFinalizer(() => Effect.sync(() => recorder.dispose()));
  recorder.attachEngine(engine);
  const debugReports: DebugReportModule = { ...recorder };
  controlled = { engine, runEffect, runTask, runSharedEffect, debugReports };
  if (import.meta.env.VITE_TELEVECHA_E2E === '1') {
    const root = globalThis as typeof globalThis & {
      __televechaRuntimes?: Map<string, ControlledRuntime>;
    };
    const key = `fixture:${fixtureScenario ?? 'default'}`;
    (root.__televechaRuntimes ??= new Map()).set(key, controlled);
  }
  return controlled;
});

export const appRuntimeLayer = Layer.mergeAll(
  MessagingEngineLayer,
  EngineStateLayer,
  CoordinatorTasksLayer,
  BrowserCrypto.layer,
  BrowserSocket.layerWebSocketConstructor,
);

export const makeDefaultAppEnvironment = Effect.fn('AppEnvironment.make')(function* (
  search: string = window.location.search,
) {
  const tasks = yield* FiberSet.make();
  const runEffect = yield* FiberSet.runtimePromise(tasks)();
  const runTask = yield* FiberSet.runtime(tasks)();
  const tvbugBundle = injectedTvBugBundle();
  if (tvbugBundle) {
    const sharedEffects = yield* makeResourceCache();
    const runSharedEffect: UiSharedEffectRunner = Object.assign(
      <Value, Error>(key: string, effect: Effect.Effect<Value, Error>) =>
        runEffect(sharedEffects.load(key, () => effect)),
      {
        cancel: (key: string) => runEffect(sharedEffects.forget(key)),
        load: <Value, Error>(key: string, effect: Effect.Effect<Value, Error>) =>
          sharedEffects.load(key, () => effect),
      },
    );
    return {
      runtime: {
        engine: createTvBugSnapshotClient(tvbugBundle),
        runEffect,
        runTask,
        runSharedEffect,
      },
      tvbug: true,
    } satisfies AppEnvironment;
  }
  const fixtureMode = import.meta.env.VITE_TELEVECHA_E2E === '1';
  const credentials = fixtureMode ? { apiId: 1, apiHash: 'fixture' } : environmentCredentials();
  const fixtureScenario = new URLSearchParams(search).get('scenario');
  return {
    runtime: yield* makeRuntime(fixtureMode, fixtureScenario, runEffect, runTask),
    credentials,
    configurationError: credentials
      ? undefined
      : 'TeleVecha could not find VITE_TELEGRAM_API_ID and VITE_TELEGRAM_API_HASH.',
  } satisfies AppEnvironment;
});
