import { Effect, Schema, SynchronizedRef } from 'effect';

import { bytesToHex, equalBytesConstantTime, hexToBytes } from '../bytes';
import { createMtprotoError, errorMessage, type MtprotoError } from '../errors';

const DataCenterId = Schema.Int.check(
  Schema.isBetween(
    { minimum: 1, maximum: 10_000 },
    { message: 'Session has an invalid main data-center ID.' },
  ),
);
const isDataCenterId = Schema.is(DataCenterId);
const AuthKey = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{512}$/iu, { message: 'Session auth key is invalid.' }),
);
const AuthKeys = Schema.Record(Schema.String, AuthKey).pipe(
  Schema.refine(
    (keys): keys is Readonly<Record<string, string>> =>
      Object.keys(keys).every((dcId) => isDataCenterId(Number(dcId))),
    { message: 'Session has an invalid auth-key data center.' },
  ),
);
const StoredSession = Schema.Struct({
  mainDcId: DataCenterId,
  keys: AuthKeys,
  isTest: Schema.optional(Schema.Boolean),
});
const decodeStoredSession = Schema.decodeUnknownSync(StoredSession);

export interface StoredMtprotoSession {
  readonly mainDcId: number;
  readonly keys: Readonly<Record<number, string>>;
  readonly isTest?: true | undefined;
}

export interface SessionPersistence {
  readonly load: Effect.Effect<unknown, MtprotoError>;
  readonly save: (value: StoredMtprotoSession) => Effect.Effect<void, MtprotoError>;
  readonly clear: Effect.Effect<void, MtprotoError>;
}

export interface MtprotoSessionModel {
  readonly snapshot: Effect.Effect<StoredMtprotoSession>;
  readonly authKey: (dcId?: number) => Effect.Effect<Uint8Array | undefined>;
  readonly setMainDc: (dcId: number, isTest?: boolean) => Effect.Effect<void, MtprotoError>;
  readonly setAuthKey: (
    dcId: number,
    key: Uint8Array | undefined,
  ) => Effect.Effect<void, MtprotoError>;
  readonly invalidateAuthKey: (
    dcId: number,
    rejected: Uint8Array,
  ) => Effect.Effect<void, MtprotoError>;
  readonly delete: Effect.Effect<void, MtprotoError>;
}

interface SessionState {
  readonly mainDcId: number;
  readonly isTest: boolean;
  readonly keys: ReadonlyMap<number, Uint8Array>;
}

export const parseStoredSession = Effect.fn('mtproto.session.parse')(function* (value: unknown) {
  if (value === undefined || value === null) return undefined;
  const decoded = yield* Effect.try({
    try: () => decodeStoredSession(value),
    catch: (cause) =>
      createMtprotoError('session', `Invalid Telegram session. ${errorMessage(cause)}`, { cause }),
  });
  return freezeSession({
    mainDcId: decoded.mainDcId,
    keys: Object.fromEntries(
      Object.entries(decoded.keys).map(([dcId, encoded]) => [dcId, encoded.toLowerCase()]),
    ),
    ...(decoded.isTest ? { isTest: true as const } : {}),
  });
});

export const createMtprotoSession = Effect.fn('mtproto.session.make')(function* (
  initial: StoredMtprotoSession | undefined,
  persistence: SessionPersistence,
  defaultDcId: number = 2,
) {
  if (!isDataCenterId(defaultDcId)) {
    return yield* Effect.fail(
      createMtprotoError('configuration', 'Data-center ID must be positive.'),
    );
  }
  const state = yield* SynchronizedRef.make<SessionState>({
    mainDcId: initial?.mainDcId ?? defaultDcId,
    isTest: initial?.isTest === true,
    keys: new Map(
      Object.entries(initial?.keys ?? {}).map(([dcId, encoded]) => [
        Number(dcId),
        hexToBytes(encoded),
      ]),
    ),
  });
  const encode = (value: SessionState) =>
    freezeSession({
      mainDcId: value.mainDcId,
      keys: Object.fromEntries(
        [...value.keys.entries()]
          .sort(([left], [right]) => left - right)
          .map(([dcId, key]) => [dcId, bytesToHex(key)]),
      ),
      ...(value.isTest ? { isTest: true as const } : {}),
    });
  const update = (
    change: (current: SessionState) => SessionState,
  ): Effect.Effect<void, MtprotoError> =>
    SynchronizedRef.updateEffect(state, (current) => {
      const next = change(current);
      return next === current
        ? Effect.succeed(current)
        : persistence.save(encode(next)).pipe(Effect.as(next));
    });

  return {
    snapshot: SynchronizedRef.get(state).pipe(Effect.map(encode)),
    authKey: (dcId?: number) =>
      SynchronizedRef.get(state).pipe(
        Effect.map((current) => {
          const key = current.keys.get(dcId ?? current.mainDcId);
          return key === undefined ? undefined : new Uint8Array(key);
        }),
      ),
    setMainDc: (dcId: number, isTest: boolean | undefined = false) => {
      if (!isDataCenterId(dcId)) {
        return Effect.fail(createMtprotoError('configuration', 'Data-center ID must be positive.'));
      }
      return update((current) => {
        if (current.mainDcId === dcId && current.isTest === isTest) return current;
        return {
          mainDcId: dcId,
          isTest,
          keys: current.isTest === isTest ? current.keys : new Map(),
        };
      });
    },
    setAuthKey: (dcId: number, key: Uint8Array | undefined) => {
      if (!isDataCenterId(dcId)) {
        return Effect.fail(createMtprotoError('configuration', 'Data-center ID must be positive.'));
      }
      if (key !== undefined && key.byteLength !== 256) {
        return Effect.fail(
          createMtprotoError('configuration', 'An MTProto auth key must contain 256 bytes.'),
        );
      }
      return update((current) => {
        const keys = new Map(current.keys);
        if (key === undefined) keys.delete(dcId);
        else keys.set(dcId, new Uint8Array(key));
        return { ...current, keys };
      });
    },
    invalidateAuthKey: (dcId: number, rejected: Uint8Array) =>
      update((current) => {
        const stored = current.keys.get(dcId);
        if (!stored || !equalBytesConstantTime(stored, rejected)) return current;
        const keys = new Map(current.keys);
        keys.delete(dcId);
        return { ...current, keys };
      }),
    delete: SynchronizedRef.updateEffect(state, (current) =>
      persistence.clear.pipe(Effect.as({ ...current, keys: new Map() })),
    ),
  } satisfies MtprotoSessionModel;
});

function freezeSession(value: StoredMtprotoSession): StoredMtprotoSession {
  return Object.freeze({
    mainDcId: value.mainDcId,
    keys: Object.freeze({ ...value.keys }),
    ...(value.isTest ? { isTest: true as const } : {}),
  });
}
