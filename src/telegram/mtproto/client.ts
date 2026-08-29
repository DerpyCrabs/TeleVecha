import {
  createAuthorizationKey,
  createAuthKey,
  type AuthorizationHandshakeWire,
  type DhGenerationResult,
  type ResPq,
  type ServerDhInner,
  type ServerDhParams,
} from './auth';
import { createAesCtr, createBrowserCryptoAdapter, type CryptoAdapter } from './crypto';
import {
  createWebSocketPacketConnection,
  telegramWebSocketUrl,
  type PacketConnection,
} from './connection';
import { createMtprotoError, isMtprotoError } from './errors';
import { createMtprotoEventHub, type MtprotoEventListener } from './events';
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
import {
  createCacheSessionPersistence,
  createMtprotoSession,
  createSessionSaveQueue,
  parseStoredSession,
  type MtprotoSessionModel,
  type SessionPersistence,
} from './session';
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

export interface MtprotoClientIdentity {
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  langCode: string;
  systemLangCode: string;
  langPack: string;
}

export type MtprotoSessionInput =
  | SessionPersistence
  | {
      loadTransportSession(): Promise<unknown>;
      saveTransportSession(value: unknown): Promise<void>;
    };

export interface CreateMtprotoClientOptions {
  apiId: number;
  apiHash: string;
  session: MtprotoSessionInput;
  clientInfo?: Partial<MtprotoClientIdentity> | undefined;
  crypto?: CryptoAdapter | undefined;
  defaultDcId?: number | undefined;
  isTestServer?: boolean | undefined;
  requestRetries?: number | undefined;
  connectionRetries?: number | undefined;
  floodSleepLimitSeconds?: number | undefined;
  connectionFactory?:
    | ((input: {
        dcId: number;
        host: string;
        port: number;
        isTestServer: boolean;
      }) => PacketConnection)
    | undefined;
  onSessionError?: ((error: unknown) => void) | undefined;
  now?: (() => number) | undefined;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
}

export interface MtprotoClient {
  readonly apiId: number;
  readonly apiHash: string;
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  flushSession(): Promise<void>;
  invoke<Request extends Tl.AnyRequest>(
    request: Request,
    options?: { signal?: AbortSignal },
  ): Promise<Tl.ResultOf<Request>>;
  getMe(): Promise<Tl.User | undefined>;
  uploadFile(options: UploadFileOptions): Promise<Tl.InputFile | Tl.InputFileBig>;
  downloadFile(location: TlObject, options: DownloadFileOptions): Promise<Uint8Array>;
  downloadMedia(value: unknown, options?: DownloadMediaOptions): Promise<Uint8Array | undefined>;
  downloadProfilePhoto(entity: unknown, big?: boolean): Promise<Uint8Array | undefined>;
  subscribe(listener: MtprotoEventListener): () => void;
}

function isSessionPersistence(value: MtprotoSessionInput): value is SessionPersistence {
  return 'load' in value && 'save' in value && 'clear' in value;
}

function sessionPersistence(value: MtprotoSessionInput) {
  return isSessionPersistence(value) ? value : createCacheSessionPersistence(value);
}

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

function endpoint(dcId: number) {
  if (!Number.isSafeInteger(dcId) || dcId < 1 || dcId > MAX_DC_ID) {
    throw createMtprotoError('configuration', `Telegram data center ${dcId} is not supported.`);
  }
  return { dcId, host: `zws${dcId}.web.telegram.org`, port: 443 };
}

function field<Value>(value: TlObject, camel: string, snake: string): Value {
  return (value[camel] ?? value[snake]) as Value;
}

function normalizedHandshakeWire(plain: PlainMtprotoTransport): AuthorizationHandshakeWire {
  return {
    async requestPq(nonce): Promise<ResPq> {
      const result = await plain.invoke(createTl('req_pq_multi', { nonce }));
      return {
        nonce: field(result, 'nonce', 'nonce'),
        serverNonce: field(result, 'serverNonce', 'server_nonce'),
        pq: field(result, 'pq', 'pq'),
        serverPublicKeyFingerprints: field(
          result,
          'serverPublicKeyFingerprints',
          'server_public_key_fingerprints',
        ),
      };
    },
    encodePqInnerData(input) {
      return encodeTl(
        createTl('p_q_inner_data_dc', {
          pq: input.pq,
          p: input.p,
          q: input.q,
          nonce: input.nonce,
          serverNonce: input.serverNonce,
          newNonce: input.newNonce,
          dc: input.dcId,
        }),
      );
    },
    async requestDh(input): Promise<ServerDhParams> {
      const result = await plain.invoke(
        createTl('req_DH_params', {
          nonce: input.nonce,
          serverNonce: input.serverNonce,
          p: input.p,
          q: input.q,
          publicKeyFingerprint: input.publicKeyFingerprint,
          encryptedData: input.encryptedData,
        }),
      );
      if (result._ === 'server_DH_params_fail') {
        return {
          kind: 'fail',
          nonce: field(result, 'nonce', 'nonce'),
          serverNonce: field(result, 'serverNonce', 'server_nonce'),
          newNonceHash: field(result, 'newNonceHash', 'new_nonce_hash'),
        };
      }
      return {
        kind: 'ok',
        nonce: field(result, 'nonce', 'nonce'),
        serverNonce: field(result, 'serverNonce', 'server_nonce'),
        encryptedAnswer: field(result, 'encryptedAnswer', 'encrypted_answer'),
      };
    },
    decodeServerDhInner(input) {
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
    encodeClientDhInner(input) {
      return encodeTl(
        createTl('client_DH_inner_data', {
          nonce: input.nonce,
          serverNonce: input.serverNonce,
          retryId: input.retryId,
          gB: input.clientPublic,
        }),
      );
    },
    async setClientDh(input): Promise<DhGenerationResult> {
      const result = await plain.invoke(
        createTl('set_client_DH_params', {
          nonce: input.nonce,
          serverNonce: input.serverNonce,
          encryptedData: input.encryptedData,
        }),
      );
      const kind = result._ === 'dh_gen_ok' ? 'ok' : result._ === 'dh_gen_retry' ? 'retry' : 'fail';
      return {
        kind,
        nonce: field(result, 'nonce', 'nonce'),
        serverNonce: field(result, 'serverNonce', 'server_nonce'),
        newNonceHash: field(
          result,
          kind === 'ok' ? 'newNonceHash1' : kind === 'retry' ? 'newNonceHash2' : 'newNonceHash3',
          kind === 'ok'
            ? 'new_nonce_hash1'
            : kind === 'retry'
              ? 'new_nonce_hash2'
              : 'new_nonce_hash3',
        ),
      };
    },
  };
}

function rpcErrorMessage(error: unknown) {
  if (!isMtprotoError(error) || error.kind !== 'rpc') return undefined;
  const value = error.details?.errorMessage;
  return typeof value === 'string' ? value : undefined;
}

export function telegramRpcErrorMessage(error: unknown) {
  return rpcErrorMessage(error);
}

function migration(error: unknown) {
  const message = rpcErrorMessage(error);
  const match = message?.match(/^(PHONE|NETWORK|USER|FILE)_MIGRATE_(\d+)$/u);
  if (!match) return undefined;
  return { kind: match[1]!, dcId: Number(match[2]) };
}

function floodWait(error: unknown) {
  const message = rpcErrorMessage(error);
  const match = message?.match(/^(?:FLOOD(?:_PREMIUM)?_WAIT|SLOWMODE_WAIT)_(\d+)$/u);
  return match ? Number(match[1]) : undefined;
}

function retryableServerError(error: unknown) {
  return isMtprotoError(error) && error.kind === 'rpc' && (error.code ?? 0) >= 500;
}

export function createMtprotoClient(options: CreateMtprotoClientOptions): MtprotoClient {
  if (!Number.isSafeInteger(options.apiId) || options.apiId <= 0 || !options.apiHash.trim()) {
    throw createMtprotoError('configuration', 'Telegram API ID and hash are required.');
  }
  const crypto = options.crypto ?? createBrowserCryptoAdapter();
  const identity = { ...defaultIdentity(), ...options.clientInfo };
  const persistence = sessionPersistence(options.session);
  const saves = createSessionSaveQueue(persistence, options.onSessionError);
  const events = createMtprotoEventHub();
  const senders = new Map<number, MtprotoSender>();
  const senderCreations = new Map<number, Promise<MtprotoSender>>();
  const senderSubscriptions = new Map<number, () => void>();
  const imported = new Set<number>();
  const importing = new Map<number, { sender: MtprotoSender; operation: Promise<void> }>();
  const auxiliaryRecoveries = new Map<number, Promise<MtprotoSender>>();
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)));
  const requestRetries = Math.max(0, Math.trunc(options.requestRetries ?? DEFAULT_REQUEST_RETRIES));
  const floodSleepLimit = Math.max(
    0,
    Math.trunc(options.floodSleepLimitSeconds ?? DEFAULT_FLOOD_WAIT_SECONDS),
  );
  let session: MtprotoSessionModel | undefined;
  let sessionLoading: Promise<MtprotoSessionModel> | undefined;
  let mainSender: MtprotoSender | undefined;
  let connectOperation: Promise<void> | undefined;
  let disconnected = true;
  let lifecycleGeneration = 0;

  const loadSession = () => {
    if (session) return Promise.resolve(session);
    if (sessionLoading) return sessionLoading;
    const loading = persistence.load().then((stored) => {
      const parsed = parseStoredSession(stored);
      const model = createMtprotoSession(parsed, saves, options.defaultDcId ?? DEFAULT_DC_ID);
      if (options.isTestServer && !parsed?.isTest) model.setMainDc(model.snapshot().mainDcId, true);
      session = model;
      return model;
    });
    const tracked = loading.finally(() => {
      if (sessionLoading === tracked) sessionLoading = undefined;
    });
    sessionLoading = tracked;
    return tracked;
  };

  const codec: TlCodec = {
    encode: encodeTl,
    decode(bytes, expected) {
      return decodeTl(bytes, expected ? { expected: expected as TlTypeRef } : {});
    },
    resultTypeFor,
  };

  const makeConnection = (dcId: number) => {
    const dc = endpoint(dcId);
    const test = session?.snapshot().isTest === true;
    if (options.connectionFactory) {
      return options.connectionFactory({ ...dc, isTestServer: test });
    }
    return createWebSocketPacketConnection({
      url: telegramWebSocketUrl({ host: dc.host, port: dc.port, test }),
      randomBytes: (length) => crypto.randomBytes(length),
      createCipher: createAesCtr,
    });
  };

  const assertActive = (generation: number) => {
    if (!disconnected && generation === lifecycleGeneration) return;
    throw createMtprotoError('cancelled', 'Telegram connection attempt was superseded.');
  };

  const createSender = async (dcId: number, generation: number) => {
    const model = await loadSession();
    const storedKey = model.authKey(dcId);
    const authKey = storedKey ? await createAuthKey(storedKey, crypto) : undefined;
    assertActive(generation);
    const sender = createMtprotoSender({
      dcId,
      connection: () => makeConnection(dcId),
      codec,
      crypto,
      ...(authKey ? { authKey } : {}),
      authorize: (plain) =>
        createAuthorizationKey({
          dcId,
          ...(model.snapshot().isTest ? { isTestServer: true } : {}),
          wire: normalizedHandshakeWire(plain),
          crypto,
          ...(options.now ? { now: options.now } : {}),
        }),
      async onAuthKey(authorization) {
        assertActive(generation);
        model.setAuthKey(dcId, authorization.authKey.bytes);
        if (dcId !== model.snapshot().mainDcId) imported.delete(dcId);
        await model.flush();
        assertActive(generation);
      },
      ...(options.now ? { now: options.now } : {}),
      reconnect: { retries: options.connectionRetries ?? DEFAULT_CONNECTION_RETRIES },
    });
    if (disconnected || generation !== lifecycleGeneration) {
      sender.disconnect();
      assertActive(generation);
    }
    senders.set(dcId, sender);
    return sender;
  };

  const senderFor = async (dcId: number, observeEvents = false) => {
    const generation = lifecycleGeneration;
    let sender = senders.get(dcId);
    if (!sender) {
      let creating = senderCreations.get(dcId);
      if (!creating) {
        const operation = createSender(dcId, generation);
        const tracked = operation.finally(() => {
          if (senderCreations.get(dcId) === tracked) senderCreations.delete(dcId);
        });
        senderCreations.set(dcId, tracked);
        creating = tracked;
      }
      sender = await creating;
    }
    if (observeEvents) {
      for (const unsubscribe of senderSubscriptions.values()) unsubscribe();
      senderSubscriptions.clear();
      senderSubscriptions.set(
        sender.dcId,
        sender.subscribe((event) => events.emit(event)),
      );
    }
    await sender.connect();
    if (disconnected || generation !== lifecycleGeneration) {
      sender.disconnect();
      if (senders.get(dcId) === sender) senders.delete(dcId);
      assertActive(generation);
    }
    return sender;
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

  const subscribeMain = (sender: MtprotoSender) => {
    for (const unsubscribe of senderSubscriptions.values()) unsubscribe();
    senderSubscriptions.clear();
    senderSubscriptions.set(
      sender.dcId,
      sender.subscribe((event) => events.emit(event)),
    );
  };

  const closeSenders = () => {
    for (const unsubscribe of senderSubscriptions.values()) unsubscribe();
    senderSubscriptions.clear();
    for (const sender of senders.values()) sender.disconnect();
    senders.clear();
    senderCreations.clear();
    imported.clear();
    importing.clear();
    auxiliaryRecoveries.clear();
    mainSender = undefined;
  };

  const connect = () => {
    if (mainSender?.isConnected()) return saves.flush();
    if (connectOperation) return connectOperation;
    const beginsUserLifecycle = disconnected;
    disconnected = false;
    const generation = beginsUserLifecycle ? ++lifecycleGeneration : lifecycleGeneration;
    const operation = (async () => {
      try {
        const model = await loadSession();
        assertActive(generation);
        const sender = await senderFor(model.snapshot().mainDcId, true);
        assertActive(generation);
        mainSender = sender;
        subscribeMain(sender);
        await initialize(sender, createTl('help.getConfig'));
        assertActive(generation);
        await model.flush();
      } catch (error) {
        if (generation === lifecycleGeneration) {
          disconnected = true;
          closeSenders();
        }
        throw error;
      }
    })();
    const tracked = operation.finally(() => {
      if (connectOperation === tracked) connectOperation = undefined;
    });
    connectOperation = tracked;
    return tracked;
  };

  const discardAuxSender = async (failedSender: MtprotoSender, generation: number) => {
    const dcId = failedSender.dcId;
    assertActive(generation);
    if (senders.get(dcId) !== failedSender) return;
    imported.delete(dcId);
    const activeImport = importing.get(dcId);
    if (activeImport?.sender === failedSender) importing.delete(dcId);
    senderSubscriptions.get(dcId)?.();
    senderSubscriptions.delete(dcId);
    senders.delete(dcId);
    failedSender.disconnect();
    const model = await loadSession();
    assertActive(generation);
    model.setAuthKey(dcId, undefined);
    await model.flush();
    assertActive(generation);
  };

  const recoverAuxSender = (failedSender: MtprotoSender, expectedGeneration?: number) => {
    const dcId = failedSender.dcId;
    const running = auxiliaryRecoveries.get(dcId);
    if (running) return running;
    const generation = expectedGeneration ?? lifecycleGeneration;
    assertActive(generation);
    const operation = (async () => {
      await discardAuxSender(failedSender, generation);
      assertActive(generation);
      return ensureExportedSender(dcId, generation);
    })();
    const tracked = operation.finally(() => {
      if (auxiliaryRecoveries.get(dcId) === tracked) auxiliaryRecoveries.delete(dcId);
    });
    auxiliaryRecoveries.set(dcId, tracked);
    return tracked;
  };

  const ensureExportedSender = async (dcId: number, expectedGeneration: number) => {
    assertActive(expectedGeneration);
    await connect();
    const generation = expectedGeneration;
    assertActive(generation);
    const model = await loadSession();
    assertActive(generation);
    if (dcId === model.snapshot().mainDcId) return mainSender!;
    const target = await senderFor(dcId);
    assertActive(generation);
    if (imported.has(dcId)) return target;
    const running = importing.get(dcId);
    if (running?.sender === target) {
      await running.operation;
      assertActive(generation);
      return target;
    }
    const operation = (async () => {
      let initializeMainBeforeExport = false;
      let lastError: unknown;
      for (let attempt = 0; attempt <= requestRetries; attempt += 1) {
        let phase: 'export' | 'import' = 'export';
        try {
          assertActive(generation);
          const source = mainSender;
          if (!source) {
            throw createMtprotoError('transport', 'Telegram main sender is unavailable.');
          }
          if (initializeMainBeforeExport) {
            await initialize(source, createTl('help.getConfig'));
            assertActive(generation);
            initializeMainBeforeExport = false;
          }
          const exported = (await source.invoke(
            createTl('auth.exportAuthorization', { dcId }),
          )) as TlObject;
          assertActive(generation);
          phase = 'import';
          await initialize(
            target,
            createTl('auth.importAuthorization', {
              id: field(exported, 'id', 'id'),
              bytes: field(exported, 'bytes', 'bytes'),
            }),
          );
          assertActive(generation);
          if (senders.get(dcId) !== target) {
            throw createMtprotoError('cancelled', 'Telegram auxiliary sender was superseded.');
          }
          imported.add(dcId);
          return;
        } catch (error) {
          assertActive(generation);
          lastError = error;
          if (attempt >= requestRetries) throw error;
          const rpcMessage = rpcErrorMessage(error);
          const waitSeconds = floodWait(error);
          if (waitSeconds !== undefined) {
            if (waitSeconds > floodSleepLimit) throw error;
            await sleep(waitSeconds * 1_000);
            assertActive(generation);
            continue;
          }
          if (rpcMessage === 'CONNECTION_NOT_INITED') {
            if (phase === 'export') initializeMainBeforeExport = true;
            continue;
          }
          if (retryableServerError(error) || phase === 'import') {
            await sleep(1_000 * (attempt + 1));
            assertActive(generation);
            continue;
          }
          throw error;
        }
      }
      throw lastError;
    })();
    const entry = { sender: target, operation };
    importing.set(dcId, entry);
    try {
      await operation;
      assertActive(generation);
    } finally {
      if (importing.get(dcId) === entry) importing.delete(dcId);
    }
    return target;
  };

  const switchMainDc = async (dcId: number, generation: number) => {
    assertActive(generation);
    const model = await loadSession();
    assertActive(generation);
    if (model.snapshot().mainDcId === dcId && mainSender) return mainSender;
    const sender = await senderFor(dcId, true);
    assertActive(generation);
    await initialize(sender, createTl('help.getConfig'));
    assertActive(generation);
    model.setMainDc(dcId, model.snapshot().isTest === true);
    mainSender = sender;
    subscribeMain(sender);
    await model.flush();
    assertActive(generation);
    return sender;
  };

  const invokeWithRetry = async <Result>(
    initialSender: MtprotoSender,
    request: TlObject,
    generation: number,
    invokeOptions: { signal?: AbortSignal } = {},
  ): Promise<Result> => {
    let sender = initialSender;
    let lastError: unknown;
    let initializationRecoveries = 0;
    let auxiliarySessionRecoveries = 0;
    for (let attempt = 0; attempt <= requestRetries; attempt += 1) {
      try {
        assertActive(generation);
        return await sender.invoke<Result>(request, invokeOptions);
      } catch (error) {
        assertActive(generation);
        lastError = error;
        const rpcMessage = rpcErrorMessage(error);
        if (rpcMessage === 'CONNECTION_NOT_INITED' && initializationRecoveries < 1) {
          initializationRecoveries += 1;
          const model = await loadSession();
          assertActive(generation);
          if (sender.dcId === model.snapshot().mainDcId) {
            await initialize(sender, createTl('help.getConfig'));
            assertActive(generation);
          } else {
            sender = await recoverAuxSender(sender, generation);
          }
          continue;
        }
        if (
          auxiliarySessionRecoveries < 1 &&
          (rpcMessage === 'SESSION_REVOKED' ||
            rpcMessage === 'SESSION_EXPIRED' ||
            rpcMessage === 'AUTH_KEY_UNREGISTERED')
        ) {
          const model = await loadSession();
          assertActive(generation);
          if (sender.dcId !== model.snapshot().mainDcId) {
            auxiliarySessionRecoveries += 1;
            sender = await recoverAuxSender(sender, generation);
            continue;
          }
        }
        const moved = migration(error);
        if (moved) {
          sender =
            moved.kind === 'FILE'
              ? await ensureExportedSender(moved.dcId, generation)
              : await switchMainDc(moved.dcId, generation);
          continue;
        }
        const waitSeconds = floodWait(error);
        if (
          waitSeconds !== undefined &&
          waitSeconds <= floodSleepLimit &&
          attempt < requestRetries
        ) {
          await sleep(waitSeconds * 1_000);
          assertActive(generation);
          continue;
        }
        if (retryableServerError(error) && attempt < requestRetries) {
          await sleep(1_000 * (attempt + 1));
          assertActive(generation);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  };

  const invokeOnDc = async <Result>(
    dcId: number,
    request: TlObject,
    invokeOptions: { signal?: AbortSignal } = {},
  ) => {
    const generation = disconnected ? lifecycleGeneration + 1 : lifecycleGeneration;
    await connect();
    assertActive(generation);
    const model = await loadSession();
    assertActive(generation);
    let sender: MtprotoSender;
    if (dcId === model.snapshot().mainDcId) {
      sender = mainSender!;
    } else {
      sender = await ensureExportedSender(dcId, generation);
    }
    assertActive(generation);
    return invokeWithRetry<Result>(sender, request, generation, invokeOptions);
  };

  const fileRpc: FileRpc = {
    get currentDcId() {
      return session?.snapshot().mainDcId ?? options.defaultDcId ?? DEFAULT_DC_ID;
    },
    randomBytes: (length) => crypto.randomBytes(length),
    invokeOnDc,
    async recoverDc(dcId) {
      const generation = lifecycleGeneration;
      assertActive(generation);
      const model = await loadSession();
      assertActive(generation);
      if (dcId === model.snapshot().mainDcId) return;
      const sender = senders.get(dcId);
      if (sender) await recoverAuxSender(sender, generation);
    },
  };

  const invoke = async <Request extends Tl.AnyRequest>(
    request: Request,
    invokeOptions: { signal?: AbortSignal } = {},
  ): Promise<Tl.ResultOf<Request>> => {
    const generation = disconnected ? lifecycleGeneration + 1 : lifecycleGeneration;
    await connect();
    assertActive(generation);
    const result = await invokeWithRetry<Tl.ResultOf<Request>>(
      mainSender!,
      request,
      generation,
      invokeOptions,
    );
    assertActive(generation);
    if (request._ === 'auth.logOut') {
      const model = await loadSession();
      model.delete();
      await model.flush();
    }
    return result;
  };

  const getMe = async () => {
    const users = await invoke(Api.users.GetUsers({ id: [Api.InputUserSelf({})] }));
    return users.find((value) => Api.User.is(value));
  };

  return {
    apiId: options.apiId,
    apiHash: options.apiHash,
    connect,
    disconnect() {
      disconnected = true;
      lifecycleGeneration += 1;
      connectOperation = undefined;
      closeSenders();
    },
    isConnected() {
      return !disconnected && Boolean(mainSender?.isConnected());
    },
    async flushSession() {
      if (session) await session.flush();
      else await saves.flush();
    },
    invoke,
    getMe,
    uploadFile(uploadOptions) {
      return uploadTelegramFile(fileRpc, uploadOptions) as Promise<Tl.InputFile | Tl.InputFileBig>;
    },
    downloadFile(location, downloadOptions) {
      return downloadTelegramFile(fileRpc, location, downloadOptions);
    },
    downloadMedia(value, downloadOptions = {}) {
      return downloadTelegramMedia(fileRpc, value, downloadOptions);
    },
    downloadProfilePhoto(entity, big = false) {
      return downloadTelegramProfilePhoto(fileRpc, entity, big);
    },
    subscribe: (listener) => events.subscribe(listener),
  };
}
