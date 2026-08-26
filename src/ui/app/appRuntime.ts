import { MessagingEngine } from '../../telegram/core/engine';
import { IndexedDbCacheStore } from '../../telegram/persistence/store';
import { FixtureTelegramTransport } from '../../telegram/transports/fixtureTransport';
import type { TelegramCredentials, TelegramTransport } from '../../telegram/types';
import { WebAGramJsTransport } from '../../telegram/transports/webAGramJsTransport';

export interface AppRuntime {
  engine: MessagingEngine;
}

interface ControlledRuntime extends AppRuntime {
  transport: TelegramTransport;
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

  const store = new IndexedDbCacheStore(
    fixtureMode ? `televecha-e2e${fixtureScenario ? `-${fixtureScenario}` : ''}` : 'televecha',
  );
  const transport: TelegramTransport = fixtureMode
    ? new FixtureTelegramTransport()
    : new WebAGramJsTransport(store);
  const created = { engine: new MessagingEngine(transport, store), transport };
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
