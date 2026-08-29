import { bytesToHex, hexToBytes } from '../bytes';
import { createMtprotoError, errorMessage } from '../errors';

const AUTH_KEY_HEX_LENGTH = 512;

export interface StoredMtprotoSession {
  readonly mainDcId: number;
  readonly keys: Readonly<Record<number, string>>;
  readonly isTest?: true | undefined;
}

export interface SessionPersistence {
  load(): Promise<unknown>;
  save(value: StoredMtprotoSession): Promise<void>;
  clear(): Promise<void>;
}

export interface SessionSaveQueue {
  schedule(value: StoredMtprotoSession | undefined): void;
  flush(): Promise<void>;
  error(): unknown;
}

export interface MtprotoSessionModel {
  snapshot(): StoredMtprotoSession;
  authKey(dcId?: number): Uint8Array | undefined;
  setMainDc(dcId: number, isTest?: boolean): void;
  setAuthKey(dcId: number, key: Uint8Array | undefined): void;
  delete(): void;
  flush(): Promise<void>;
}

export function createCacheSessionPersistence(store: {
  loadTransportSession(): Promise<unknown>;
  saveTransportSession(value: unknown): Promise<void>;
}): SessionPersistence {
  return Object.freeze({
    load: () => store.loadTransportSession(),
    save: (value: StoredMtprotoSession) => store.saveTransportSession(value),
    clear: () => store.saveTransportSession(undefined),
  });
}

export function parseStoredSession(value: unknown): StoredMtprotoSession | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalidSession('Session must be an object.');
  if (!isDcId(value.mainDcId)) throw invalidSession('Session has an invalid main data-center ID.');
  if (!isRecord(value.keys)) throw invalidSession('Session auth keys must be an object.');
  if (value.isTest !== undefined && value.isTest !== true) {
    throw invalidSession('Session test-network marker must be true or absent.');
  }

  const keys: Record<number, string> = {};
  for (const [dcIdText, encoded] of Object.entries(value.keys)) {
    const dcId = Number(dcIdText);
    if (!isDcId(dcId))
      throw invalidSession(`Session has an invalid auth-key data center: ${dcIdText}.`);
    if (
      typeof encoded !== 'string' ||
      encoded.length !== AUTH_KEY_HEX_LENGTH ||
      !/^[0-9a-f]+$/iu.test(encoded)
    ) {
      throw invalidSession(`Session auth key for data center ${dcId} is invalid.`);
    }
    keys[dcId] = encoded.toLowerCase();
  }

  return freezeSession({
    mainDcId: value.mainDcId,
    keys,
    ...(value.isTest ? { isTest: true as const } : {}),
  });
}

export function createSessionSaveQueue(
  persistence: SessionPersistence,
  onError: (error: unknown) => void = () => undefined,
): SessionSaveQueue {
  let tail = Promise.resolve();
  let lastError: unknown;

  return Object.freeze({
    schedule(value: StoredMtprotoSession | undefined) {
      const snapshot = value ? cloneSession(value) : undefined;
      tail = tail.then(async () => {
        try {
          if (snapshot) await persistence.save(snapshot);
          else await persistence.clear();
          lastError = undefined;
        } catch (error) {
          lastError = error;
          try {
            onError(error);
          } catch {
            // Persistence ordering must not depend on an observational callback.
          }
        }
      });
    },
    async flush() {
      await tail;
      if (lastError === undefined) return;
      throw createMtprotoError(
        'session',
        `Could not persist the Telegram authorization session. ${errorMessage(lastError)}`,
        { cause: lastError },
      );
    },
    error() {
      return lastError;
    },
  });
}

export function createMtprotoSession(
  initial: StoredMtprotoSession | undefined,
  saves: SessionSaveQueue,
  defaultDcId = 2,
): MtprotoSessionModel {
  if (!isDcId(defaultDcId)) throw new RangeError('Default data-center ID must be positive.');
  let mainDcId = initial?.mainDcId ?? defaultDcId;
  let isTest = initial?.isTest === true;
  const keys = new Map<number, Uint8Array>();
  for (const [dcId, encoded] of Object.entries(initial?.keys ?? {})) {
    keys.set(Number(dcId), hexToBytes(encoded));
  }

  const snapshot = () =>
    freezeSession({
      mainDcId,
      keys: Object.fromEntries(
        [...keys.entries()]
          .sort(([left], [right]) => left - right)
          .map(([dcId, key]) => [dcId, bytesToHex(key)]),
      ),
      ...(isTest ? { isTest: true as const } : {}),
    });
  const changed = () => saves.schedule(snapshot());

  return Object.freeze({
    snapshot,
    authKey(dcId = mainDcId) {
      const key = keys.get(dcId);
      return key ? new Uint8Array(key) : undefined;
    },
    setMainDc(dcId: number, nextIsTest = false) {
      if (!isDcId(dcId)) throw new RangeError('Data-center ID must be positive.');
      if (dcId === mainDcId && nextIsTest === isTest) return;
      if (nextIsTest !== isTest) keys.clear();
      mainDcId = dcId;
      isTest = nextIsTest;
      changed();
    },
    setAuthKey(dcId: number, key: Uint8Array | undefined) {
      if (!isDcId(dcId)) throw new RangeError('Data-center ID must be positive.');
      if (key && key.byteLength !== 256)
        throw new RangeError('An MTProto auth key must contain 256 bytes.');
      if (key) keys.set(dcId, new Uint8Array(key));
      else keys.delete(dcId);
      changed();
    },
    delete() {
      keys.clear();
      saves.schedule(undefined);
    },
    flush: () => saves.flush(),
  });
}

function cloneSession(value: StoredMtprotoSession) {
  return freezeSession({
    mainDcId: value.mainDcId,
    keys: { ...value.keys },
    ...(value.isTest ? { isTest: true as const } : {}),
  });
}

function freezeSession(value: StoredMtprotoSession): StoredMtprotoSession {
  return Object.freeze({
    mainDcId: value.mainDcId,
    keys: Object.freeze({ ...value.keys }),
    ...(value.isTest ? { isTest: true as const } : {}),
  });
}

function isDcId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 10_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidSession(message: string) {
  return createMtprotoError('session', message);
}
