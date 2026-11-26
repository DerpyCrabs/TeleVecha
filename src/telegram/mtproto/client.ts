import { SecureRandom, Digest, Kdf } from 'effect/crypto';
import { Context, Effect, Layer, PubSub, RcMap, Ref, Schedule, Schema, Stream } from 'effect';

import * as Socket from 'effect/socket/Socket';

import {
  createAuthorizationKey,
  createAuthKey,
  type AuthorizationHandshakeWire,
  type DhGenerationResult,
  type ResPq,
  type ServerDhInner,
  type ServerDhParams,
} from './auth';
import { randomBytes } from './crypto';
import {
  createWebSocketPacketConnection,
  telegramWebSocketUrl,
  type PacketConnection,
} from './connection';
import { createMtprotoError, isMtprotoError, type MtprotoError } from './errors';
import type { MtprotoClientEvent } from './events';
import {
  downloadFile as downloadTelegramFile,
  downloadMedia as downloadTelegramMedia,
  downloadProfilePhoto as downloadTelegramProfilePhoto,
  uploadFile as uploadTelegramFile,
  type DownloadFileOptions,
  type DownloadMediaOptions,
  type FileRpc,
  type UploadFileOptions,
} from './files';
import { createMtprotoSession, parseStoredSession, type SessionPersistence } from './session';
import {
  createMtprotoSender,
  type MtprotoSender,
  type PlainMtprotoTransport,
  type TlCodec,
  type TlObject,
} from './sender';
import {
  Api,
  LAYER,
  createTl,
  createTlReader,
  decodeTl,
  decodeTlAt,
  encodeTl,
  resultTypeFor,
  type Tl,
  type TlTypeRef,
} from './tl';

const DEFAULT_DC_ID = 2;
const DEFAULT_REQUEST_RETRIES = 5;
const DEFAULT_CONNECTION_RETRIES = 2;
const DEFAULT_FLOOD_WAIT_SECONDS = 60;
const MAX_DC_ID = 5;

const ClientConfiguration = Schema.Struct({
  apiId: Schema.Int.check(Schema.isGreaterThan(0)),
  apiHash: Schema.String.check(Schema.isPattern(/\S/u)),
  requestRetries: Schema.Natural,
  connectionRetries: Schema.Natural,
  floodSleepLimitSeconds: Schema.Natural,
});
const isClientConfiguration = Schema.is(ClientConfiguration);

export type MtprotoConnectionPurpose = 'api' | 'media';

export interface MtprotoClientIdentity {
  readonly deviceModel: string;
  readonly systemVersion: string;
  readonly appVersion: string;
  readonly langCode: string;
  readonly systemLangCode: string;
  readonly langPack: string;
}

export interface CreateMtprotoClientOptions {
  readonly apiId: number;
  readonly apiHash: string;
  readonly session: SessionPersistence;
  readonly clientInfo?: Partial<MtprotoClientIdentity> | undefined;
  readonly defaultDcId?: number | undefined;
  readonly isTestServer?: boolean | undefined;
  readonly requestRetries?: number | undefined;
  readonly connectionRetries?: number | undefined;
  readonly floodSleepLimitSeconds?: number | undefined;
  readonly connectionFactory?:
    | ((input: {
        readonly dcId: number;
        readonly host: string;
        readonly port: number;
        readonly isTestServer: boolean;
        readonly purpose: MtprotoConnectionPurpose;
      }) => PacketConnection<
        (SecureRandom.SecureRandom | Digest.Digest | Kdf.Kdf) | Socket.WebSocketConstructor
      >)
    | undefined;
  readonly now?: (() => number) | undefined;
}

export interface MtprotoClient {
  readonly apiId: number;
  readonly apiHash: string;
  readonly connect: Effect.Effect<void, MtprotoError>;
  readonly connected: Effect.Effect<boolean, MtprotoError>;
  readonly invoke: <Request extends Tl.AnyRequest>(
    request: Request,
  ) => Effect.Effect<Tl.ResultOf<Request>, MtprotoError>;
  readonly switchDc: (dcId: number) => Effect.Effect<void, MtprotoError>;
  readonly getMe: Effect.Effect<Tl.User | undefined, MtprotoError>;
  readonly uploadFile: (
    options: UploadFileOptions,
  ) => Effect.Effect<Tl.InputFile | Tl.InputFileBig, MtprotoError>;
  readonly downloadFile: (
    location: TlObject,
    options: DownloadFileOptions,
  ) => Effect.Effect<Uint8Array, MtprotoError>;
  readonly downloadMedia: (
    value: unknown,
    options?: DownloadMediaOptions,
  ) => Effect.Effect<Uint8Array | undefined, MtprotoError>;
  readonly downloadProfilePhoto: (
    entity: unknown,
    big?: boolean,
  ) => Effect.Effect<Uint8Array | undefined, MtprotoError>;
  readonly events: Stream.Stream<MtprotoClientEvent>;
}

export const MtprotoClientService = Context.Service<MtprotoClient>(
  'televecha/telegram/mtproto/MtprotoClient',
);

function defaultIdentity(): MtprotoClientIdentity {
  const language = typeof navigator === 'undefined' ? 'en' : navigator.language || 'en';
  return {
    deviceModel: 'TeleVecha',
    systemVersion: typeof navigator === 'undefined' ? 'Unknown browser' : navigator.userAgent,
    appVersion: '0.1.0',
    langCode: language.split('-')[0] || 'en',
    systemLangCode: language,
    langPack: '',
  };
}

const endpoint = Effect.fn('mtproto.client.endpoint')(function* (
  dcId: number,
  dedicatedMedia: boolean = false,
) {
  if (!Number.isSafeInteger(dcId) || dcId < 1 || dcId > MAX_DC_ID) {
    return yield* Effect.fail(
      createMtprotoError('configuration', `Telegram data center ${dcId} is not supported.`),
    );
  }
  return { dcId, host: `zws${dcId}${dedicatedMedia ? '-1' : ''}.web.telegram.org`, port: 443 };
});

function field<Value>(value: TlObject, camel: string, snake: string): Value {
  return (value[camel] ?? value[snake]) as Value;
}

function normalizedHandshakeWire(plain: PlainMtprotoTransport): AuthorizationHandshakeWire {
  return {
    requestPq: (nonce): Effect.Effect<ResPq, MtprotoError> =>
      plain
        .invoke(createTl('req_pq_multi', { nonce }))
        .pipe(
          Effect.map((result) => ({
            nonce: field(result, 'nonce', 'nonce'),
            serverNonce: field(result, 'serverNonce', 'server_nonce'),
            pq: field(result, 'pq', 'pq'),
            serverPublicKeyFingerprints: field(
              result,
              'serverPublicKeyFingerprints',
              'server_public_key_fingerprints',
            ),
          })),
        ),
    encodePqInnerData: (input) =>
      encodeTl(
        createTl('p_q_inner_data_dc', {
          pq: input.pq,
          p: input.p,
          q: input.q,
          nonce: input.nonce,
          serverNonce: input.serverNonce,
          newNonce: input.newNonce,
          dc: input.dcId,
        }),
      ),
    requestDh: (input): Effect.Effect<ServerDhParams, MtprotoError> =>
      plain
        .invoke(
          createTl('req_DH_params', {
            nonce: input.nonce,
            serverNonce: input.serverNonce,
            p: input.p,
            q: input.q,
            publicKeyFingerprint: input.publicKeyFingerprint,
            encryptedData: input.encryptedData,
          }),
        )
        .pipe(
          Effect.map((result) =>
            result._ === 'server_DH_params_fail'
              ? {
                  kind: 'fail' as const,
                  nonce: field(result, 'nonce', 'nonce'),
                  serverNonce: field(result, 'serverNonce', 'server_nonce'),
                  newNonceHash: field(result, 'newNonceHash', 'new_nonce_hash'),
                }
              : {
                  kind: 'ok' as const,
                  nonce: field(result, 'nonce', 'nonce'),
                  serverNonce: field(result, 'serverNonce', 'server_nonce'),
                  encryptedAnswer: field(result, 'encryptedAnswer', 'encrypted_answer'),
                },
          ),
        ),
    decodeServerDhInner: (input) => {
      const reader = createTlReader(input);
      const decoded = decodeTlAt(reader) as TlObject;
      const value: ServerDhInner = {
        nonce: field(decoded, 'nonce', 'nonce'),
        serverNonce: field(decoded, 'serverNonce', 'server_nonce'),
        generator: field(decoded, 'g', 'g'),
        dhPrime: field(decoded, 'dhPrime', 'dh_prime'),
        serverPublic: field(decoded, 'gA', 'g_a'),
        serverTime: field(decoded, 'serverTime', 'server_time'),
      };
      return { value, encoded: input.slice(0, reader.offset), bytesRead: reader.offset };
    },
    encodeClientDhInner: (input) =>
      encodeTl(
        createTl('client_DH_inner_data', {
          nonce: input.nonce,
          serverNonce: input.serverNonce,
          retryId: input.retryId,
          gB: input.clientPublic,
        }),
      ),
    setClientDh: (input): Effect.Effect<DhGenerationResult, MtprotoError> =>
      plain
        .invoke(
          createTl('set_client_DH_params', {
            nonce: input.nonce,
            serverNonce: input.serverNonce,
            encryptedData: input.encryptedData,
          }),
        )
        .pipe(
          Effect.map((result) => {
            const kind =
              result._ === 'dh_gen_ok' ? 'ok' : result._ === 'dh_gen_retry' ? 'retry' : 'fail';
            return {
              kind,
              nonce: field(result, 'nonce', 'nonce'),
              serverNonce: field(result, 'serverNonce', 'server_nonce'),
              newNonceHash: field(
                result,
                kind === 'ok'
                  ? 'newNonceHash1'
                  : kind === 'retry'
                    ? 'newNonceHash2'
                    : 'newNonceHash3',
                kind === 'ok'
                  ? 'new_nonce_hash1'
                  : kind === 'retry'
                    ? 'new_nonce_hash2'
                    : 'new_nonce_hash3',
              ),
            };
          }),
        ),
  };
}

function rpcErrorMessage(error: MtprotoError) {
  if (error.kind !== 'rpc') return undefined;
  const value = error.details?.errorMessage;
  return typeof value === 'string' ? value : undefined;
}

export function telegramRpcErrorMessage(error: unknown) {
  return isMtprotoError(error) ? rpcErrorMessage(error) : undefined;
}

function migration(error: MtprotoError) {
  const match = rpcErrorMessage(error)?.match(/^(PHONE|NETWORK|USER|FILE)_MIGRATE_(\d+)$/u);
  return match ? { kind: match[1]!, dcId: Number(match[2]) } : undefined;
}

function floodWait(error: MtprotoError) {
  const match = rpcErrorMessage(error)?.match(/^(?:FLOOD(?:_PREMIUM)?_WAIT|SLOWMODE_WAIT)_(\d+)$/u);
  return match ? Number(match[1]) : undefined;
}

function retryableServerError(error: MtprotoError) {
  return error.kind === 'rpc' && (error.code ?? 0) >= 500;
}

type SenderKey = `${MtprotoConnectionPurpose}:${number}`;
type RetryRequest = Readonly<{ _tag: 'RetryRequest'; cause: MtprotoError; delayMs?: number }>;

const retryRequest = (cause: MtprotoError, delayMs?: number): RetryRequest => ({
  _tag: 'RetryRequest',
  cause,
  ...(delayMs === undefined ? {} : { delayMs }),
});

const isRetryRequest = (error: MtprotoError | RetryRequest): error is RetryRequest =>
  error._tag === 'RetryRequest';

const keyFor = (purpose: MtprotoConnectionPurpose, dcId: number): SenderKey => `${purpose}:${dcId}`;

const keyParts = (key: SenderKey) => {
  const [purpose, encodedDcId] = key.split(':') as [MtprotoConnectionPurpose, string];
  return { purpose, dcId: Number(encodedDcId) };
};

export const createMtprotoClient = Effect.fn('mtproto.client.make')(function* (
  options: CreateMtprotoClientOptions,
) {
  const crypto = yield* Effect.context<SecureRandom.SecureRandom | Digest.Digest | Kdf.Kdf>();
  const webSocket = yield* Socket.WebSocketConstructor;
  const provideDependencies = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideContext(crypto),
      Effect.provideService(Socket.WebSocketConstructor, webSocket),
    );
  const configuration = {
    apiId: options.apiId,
    apiHash: options.apiHash,
    requestRetries: options.requestRetries ?? DEFAULT_REQUEST_RETRIES,
    connectionRetries: options.connectionRetries ?? DEFAULT_CONNECTION_RETRIES,
    floodSleepLimitSeconds: options.floodSleepLimitSeconds ?? DEFAULT_FLOOD_WAIT_SECONDS,
  };
  if (!isClientConfiguration(configuration)) {
    return yield* Effect.fail(
      createMtprotoError(
        'configuration',
        'Telegram API credentials and retry limits must be valid.',
      ),
    );
  }
  const identity = { ...defaultIdentity(), ...options.clientInfo };
  const parsed = yield* options.session.load.pipe(Effect.flatMap(parseStoredSession));
  const session = yield* createMtprotoSession(
    parsed,
    options.session,
    options.defaultDcId ?? DEFAULT_DC_ID,
  );
  if (options.isTestServer !== undefined && options.isTestServer !== (parsed?.isTest === true)) {
    const snapshot = yield* session.snapshot;
    yield* session.setMainDc(snapshot.mainDcId, options.isTestServer);
  }
  const eventHub = yield* PubSub.bounded<MtprotoClientEvent>(256);
  const codec: TlCodec = {
    encode: encodeTl,
    decode: (bytes, expected) =>
      decodeTl(bytes, expected ? { expected: expected as TlTypeRef } : {}),
    resultTypeFor,
  };

  const initialize = (sender: MtprotoSender, query: TlObject) =>
    sender.invoke(
      createTl('invokeWithLayer', {
        layer: LAYER,
        query: createTl('initConnection', {
          apiId: options.apiId,
          deviceModel: identity.deviceModel,
          systemVersion: identity.systemVersion,
          appVersion: identity.appVersion,
          systemLangCode: identity.systemLangCode,
          langPack: identity.langPack,
          langCode: identity.langCode,
          query,
        }),
      }),
    );

  let senders!: RcMap.RcMap<SenderKey, MtprotoSender, MtprotoError>;
  const makeSender = Effect.fn('mtproto.client.sender')(function* (key: SenderKey) {
    const { purpose, dcId } = keyParts(key);
    const snapshot = yield* session.snapshot;
    let storedKey: Uint8Array | undefined = yield* session.authKey(dcId);
    const authKey = storedKey === undefined ? undefined : yield* createAuthKey(storedKey);
    const dedicatedMedia = purpose === 'media' && storedKey !== undefined;
    const dc = yield* endpoint(dcId, dedicatedMedia);
    const unresolvedConnection = options.connectionFactory
      ? options.connectionFactory({ ...dc, isTestServer: snapshot.isTest === true, purpose })
      : createWebSocketPacketConnection({
          url: telegramWebSocketUrl({
            host: dc.host,
            port: dc.port,
            test: snapshot.isTest === true,
          }),
        });
    const connection: PacketConnection = {
      packets: (outgoing) =>
        unresolvedConnection
          .packets(outgoing)
          .pipe(
            Stream.provideContext(crypto),
            Stream.provideService(Socket.WebSocketConstructor, webSocket),
          ),
    };
    const invalidateKey = () =>
      storedKey ? session.invalidateAuthKey(dcId, storedKey) : Effect.void;
    const rawSender = yield* provideDependencies(
      createMtprotoSender({
        purpose,
        dcId,
        connection,
        codec,
        ...(authKey ? { authKey } : {}),
        authorize: (plain) =>
          createAuthorizationKey({
            dcId,
            ...(snapshot.isTest ? { isTestServer: true } : {}),
            wire: normalizedHandshakeWire(plain),
            ...(options.now ? { now: options.now } : {}),
          }),
        onAuthKey: (authorization) => {
          storedKey = authorization.authKey.bytes;
          return session.setAuthKey(dcId, storedKey);
        },
        onAuthKeyInvalidated: invalidateKey,
        ...(options.now ? { now: options.now } : {}),
        reconnect: { retries: configuration.connectionRetries },
      }),
    );
    const sender: MtprotoSender = {
      ...rawSender,
      invoke: <Result>(request: TlObject) =>
        rawSender
          .invoke<Result>(request)
          .pipe(
            Effect.tapError((error) =>
              rpcErrorMessage(error) === 'AUTH_KEY_DUPLICATED' ? invalidateKey() : Effect.void,
            ),
          ),
    };
    yield* sender.events.pipe(
      Stream.runForEach((event) =>
        session.snapshot.pipe(
          Effect.flatMap((current) =>
            // Only the active API sender owns global connection state and
            // updates. Media senders and superseded DCs are auxiliary.
            purpose === 'api' && dcId === current.mainDcId
              ? PubSub.publish(eventHub, event)
              : Effect.void,
          ),
          Effect.asVoid,
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    if (purpose === 'media' && dcId !== snapshot.mainDcId) {
      const source = yield* RcMap.get(senders, keyFor('api', snapshot.mainDcId));
      const exported = (yield* source.invoke(
        createTl('auth.exportAuthorization', { dcId }),
      )) as TlObject;
      yield* initialize(
        sender,
        createTl('auth.importAuthorization', {
          id: field(exported, 'id', 'id'),
          bytes: field(exported, 'bytes', 'bytes'),
        }),
      );
    } else {
      yield* initialize(sender, createTl('help.getConfig'));
    }
    return sender;
  });
  senders = yield* RcMap.make({
    lookup: makeSender,
    // The main sender is also the push-update connection. Keep sender scopes
    // alive until the client scope closes; an idle RPC period must not stop
    // updates or publish a false disconnect.
    idleTimeToLive: Infinity,
  });

  const sender = (key: SenderKey) => RcMap.get(senders, key);
  const withSenderRetry = <Result>(
    initialKey: SenderKey,
    operation: (target: MtprotoSender) => Effect.Effect<Result, MtprotoError>,
  ): Effect.Effect<Result, MtprotoError> =>
    Effect.gen(function* () {
      const currentKey = yield* Ref.make(initialKey);
      const execute = Effect.suspend(() =>
        Effect.gen(function* () {
          const key = yield* Ref.get(currentKey);
          return yield* Effect.scoped(
            sender(key).pipe(
              Effect.tapError(() => RcMap.invalidate(senders, key)),
              Effect.flatMap(operation),
            ),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const key = yield* Ref.get(currentKey);
              const { purpose, dcId } = keyParts(key);
              const moved = migration(error);
              if (moved) {
                if (moved.kind === 'FILE') {
                  yield* Ref.set(currentKey, keyFor('media', moved.dcId));
                } else {
                  const snapshot = yield* session.snapshot;
                  yield* session.setMainDc(moved.dcId, snapshot.isTest === true);
                  yield* Ref.set(currentKey, keyFor('api', moved.dcId));
                }
                return yield* Effect.fail(retryRequest(error, 0));
              }
              const rpcMessage = rpcErrorMessage(error);
              if (rpcMessage === 'CONNECTION_NOT_INITED') {
                yield* Effect.scoped(
                  sender(key).pipe(
                    Effect.flatMap((target) => initialize(target, createTl('help.getConfig'))),
                  ),
                );
                return yield* Effect.fail(retryRequest(error, 0));
              }
              const forgottenAuthKey = error.kind === 'session' && error.code === -404;
              const expiredMediaSession =
                purpose === 'media' &&
                (rpcMessage === 'SESSION_REVOKED' ||
                  rpcMessage === 'SESSION_EXPIRED' ||
                  rpcMessage === 'AUTH_KEY_UNREGISTERED');
              if (rpcMessage === 'AUTH_KEY_DUPLICATED') {
                yield* RcMap.invalidate(senders, key);
                return yield* Effect.fail(retryRequest(error, 0));
              }
              if (forgottenAuthKey || expiredMediaSession) {
                if (dcId !== (yield* session.snapshot).mainDcId) {
                  yield* session.setAuthKey(dcId, undefined);
                }
                yield* RcMap.invalidate(senders, key);
                return yield* Effect.fail(retryRequest(error, 0));
              }
              const waitSeconds = floodWait(error);
              if (
                waitSeconds !== undefined &&
                waitSeconds <= configuration.floodSleepLimitSeconds
              ) {
                return yield* Effect.fail(retryRequest(error, waitSeconds * 1_000));
              }
              if (retryableServerError(error)) {
                return yield* Effect.fail(retryRequest(error));
              }
              return yield* Effect.fail(error);
            }),
          ),
        ),
      );
      return yield* execute.pipe(
        Effect.retry({
          schedule: Schedule.recurs(configuration.requestRetries).pipe(
            Schedule.addDelay(({ input, output }) =>
              Effect.succeed(isRetryRequest(input) ? (input.delayMs ?? (output + 1) * 1_000) : 0),
            ),
          ),
          while: isRetryRequest,
        }),
        Effect.mapError((error) => (isRetryRequest(error) ? error.cause : error)),
      );
    });

  const invokeWithRetry = <Result>(key: SenderKey, request: TlObject) =>
    withSenderRetry(key, (target) => target.invoke<Result>(request));
  const mainKey = session.snapshot.pipe(Effect.map((snapshot) => keyFor('api', snapshot.mainDcId)));
  const invoke = <Request extends Tl.AnyRequest>(request: Request) =>
    Effect.gen(function* () {
      const result = yield* invokeWithRetry<Tl.ResultOf<Request>>(yield* mainKey, request);
      if (request._ === 'auth.logOut') yield* session.delete;
      return result;
    });
  const invokeOnDc: FileRpc['invokeOnDc'] = <Result>(dcId: number, request: TlObject) =>
    invokeWithRetry<Result>(keyFor('media', dcId), request);
  const fileRpc: FileRpc = {
    currentDcId: session.snapshot.pipe(Effect.map((snapshot) => snapshot.mainDcId)),
    randomBytes: (length) => provideDependencies(randomBytes(length)),
    invokeOnDc,
    recoverDc: (dcId) => RcMap.invalidate(senders, keyFor('media', dcId)),
  };

  const client: MtprotoClient = {
    apiId: options.apiId,
    apiHash: options.apiHash,
    connect: mainKey.pipe(Effect.flatMap((key) => withSenderRetry(key, () => Effect.void))),
    connected: mainKey.pipe(
      Effect.flatMap((key) =>
        Effect.scoped(sender(key).pipe(Effect.flatMap((value) => value.connected))),
      ),
    ),
    invoke,
    switchDc: (dcId) =>
      Effect.gen(function* () {
        yield* endpoint(dcId);
        const snapshot = yield* session.snapshot;
        yield* session.setMainDc(dcId, snapshot.isTest === true);
        yield* Effect.scoped(sender(keyFor('api', dcId)));
      }).pipe(Effect.asVoid),
    getMe: invoke(Api.users.GetUsers({ id: [Api.InputUserSelf({})] })).pipe(
      Effect.map((users) => users.find((value) => Api.User.is(value))),
    ),
    uploadFile: (uploadOptions) =>
      uploadTelegramFile(fileRpc, uploadOptions) as Effect.Effect<
        Tl.InputFile | Tl.InputFileBig,
        MtprotoError
      >,
    downloadFile: (location, downloadOptions) =>
      downloadTelegramFile(fileRpc, location, downloadOptions),
    downloadMedia: (value, downloadOptions: DownloadMediaOptions | undefined = {}) =>
      downloadTelegramMedia(fileRpc, value, downloadOptions),
    downloadProfilePhoto: (entity, big: boolean | undefined = false) =>
      downloadTelegramProfilePhoto(fileRpc, entity, big),
    events: Stream.fromPubSub(eventHub),
  };
  return client;
});

export const mtprotoClientLayer = (
  options: CreateMtprotoClientOptions,
): Layer.Layer<
  MtprotoClient,
  MtprotoError,
  (SecureRandom.SecureRandom | Digest.Digest | Kdf.Kdf) | Socket.WebSocketConstructor
> => Layer.effect(MtprotoClientService, createMtprotoClient(options));
