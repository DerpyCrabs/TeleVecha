import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthorizationResult } from './auth';
import type { CryptoAdapter } from './crypto';
import type { PacketConnection } from './connection';
import { createMtprotoError } from './errors';
import type { MtprotoSender, MtprotoSenderOptions, TlObject } from './sender';

interface SenderDouble extends MtprotoSender {
  readonly testState: {
    connectCalls: number;
    invocations: TlObject[];
    options: MtprotoSenderOptions;
  };
  forceOffline(): void;
}

const harness = vi.hoisted(() => ({
  senders: [] as SenderDouble[],
  authorizationCalls: [] as number[],
  authorize: undefined as ((dcId: number) => Promise<AuthorizationResult>) | undefined,
  beforeInvoke: undefined as
    | ((sender: SenderDouble, request: TlObject) => void | Promise<void>)
    | undefined,
}));

vi.mock('./auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth')>();
  return {
    ...actual,
    createAuthorizationKey: vi.fn(async ({ dcId }: { dcId: number }) => {
      harness.authorizationCalls.push(dcId);
      if (harness.authorize) return harness.authorize(dcId);
      return {
        authKey: {
          bytes: new Uint8Array(256).fill(dcId),
          hash: new Uint8Array(20),
          auxHash: 0n,
          id: BigInt(dcId),
          calculateNewNonceHash: async () => 0n,
        },
        timeOffset: 0,
        serverSalt: 0n,
      } satisfies AuthorizationResult;
    }),
  };
});

vi.mock('./sender', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sender')>();
  return {
    ...actual,
    createMtprotoSender: vi.fn((_options: MtprotoSenderOptions) => {
      let connected = false;
      let authorized = Boolean(_options.authKey);
      let connecting: Promise<void> | undefined;
      const testState = { connectCalls: 0, invocations: [] as TlObject[], options: _options };
      const sender: SenderDouble = {
        dcId: _options.dcId,
        testState,
        async connect() {
          testState.connectCalls += 1;
          if (connected) return;
          if (connecting) return connecting;
          if (authorized) {
            connected = true;
            return;
          }
          const operation = (async () => {
            const authorization = await _options.authorize({
              invoke: async <Result extends TlObject>() => ({ _: 'unused' }) as Result,
              dispose() {},
            });
            await _options.onAuthKey(authorization);
            authorized = true;
            connected = true;
          })();
          const tracked = operation.finally(() => {
            if (connecting === tracked) connecting = undefined;
          });
          connecting = tracked;
          return tracked;
        },
        disconnect() {
          connected = false;
        },
        forceOffline() {
          connected = false;
        },
        isConnected: () => connected,
        async invoke<Result>(request: TlObject) {
          testState.invocations.push(request);
          await harness.beforeInvoke?.(sender, request);
          if (request._ === 'upload.getFile') {
            return { _: 'upload.file', bytes: new Uint8Array(0) } as Result;
          }
          return { _: 'test.result' } as Result;
        },
        subscribe: () => () => undefined,
      };
      harness.senders.push(sender);
      return sender;
    }),
  };
});

import { createMtprotoClient, type CreateMtprotoClientOptions } from './client';
import { Api } from './tl';

function cryptoDouble(): CryptoAdapter {
  return {
    randomBytes: (length) => new Uint8Array(length),
    sha1: async () => new Uint8Array(20),
    sha256: async () => new Uint8Array(32),
    pbkdf2Sha512: async (_password, _salt, _iterations, bits) => new Uint8Array(bits / 8),
  };
}

describe('MTProto client lifecycle recovery', () => {
  beforeEach(() => {
    harness.senders.length = 0;
    harness.authorizationCalls.length = 0;
    harness.authorize = undefined;
    harness.beforeInvoke = undefined;
  });

  it('reopens an offline sender without superseding the active client lifecycle', async () => {
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      session: {
        load: async () => ({ mainDcId: 2, keys: { 2: '00'.repeat(256) } }),
        save: async () => undefined,
        clear: async () => undefined,
      },
      crypto: cryptoDouble(),
    });
    await client.connect();
    const sender = harness.senders[0]!;
    sender.forceOffline();

    await expect(client.invoke(Api.updates.GetState({}))).resolves.toEqual({ _: 'test.result' });
    expect(sender.testState.connectCalls).toBe(2);
    expect(client.isConnected()).toBe(true);
    expect(sender.testState.invocations.at(-1)?._).toBe('updates.getState');
    client.disconnect();
  });

  it('drops a stored test-network key when production is explicitly selected', async () => {
    const saves: Array<{
      mainDcId: number;
      keys: Readonly<Record<number, string>>;
      isTest?: true | undefined;
    }> = [];
    const connectionInputs: Parameters<
      NonNullable<CreateMtprotoClientOptions['connectionFactory']>
    >[0][] = [];
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      isTestServer: false,
      session: {
        load: async () => ({ mainDcId: 2, keys: { 2: '11'.repeat(256) }, isTest: true }),
        save: async (value) => {
          saves.push(value);
        },
        clear: async () => undefined,
      },
      crypto: cryptoDouble(),
      connectionFactory: (input) => {
        connectionInputs.push(input);
        return {} as PacketConnection;
      },
    });

    await client.connect();
    harness.senders[0]!.testState.options.connection();

    expect(harness.senders[0]!.testState.options.authKey).toBeUndefined();
    expect(harness.authorizationCalls).toEqual([2]);
    expect(connectionInputs[0]).toMatchObject({ isTestServer: false });
    expect(saves).toContainEqual({ mainDcId: 2, keys: {} });
    expect(saves.at(-1)).toEqual({ mainDcId: 2, keys: { 2: '02'.repeat(256) } });
    client.disconnect();
  });

  it('routes same-DC file requests through a dedicated media sender and -1 host', async () => {
    const connectionInputs: Parameters<
      NonNullable<CreateMtprotoClientOptions['connectionFactory']>
    >[0][] = [];
    const connectionFactory: NonNullable<CreateMtprotoClientOptions['connectionFactory']> = (
      input,
    ) => {
      connectionInputs.push(input);
      return {} as PacketConnection;
    };
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      session: {
        load: async () => ({ mainDcId: 2, keys: { 2: '00'.repeat(256) } }),
        save: async () => undefined,
        clear: async () => undefined,
      },
      crypto: cryptoDouble(),
      connectionFactory,
    });
    await client.connect();

    await client.downloadProfilePhoto({
      _: 'user',
      id: 10n,
      accessHash: 20n,
      photo: { _: 'userProfilePhoto', photoId: 30n, dcId: 2 },
    });

    expect(harness.senders).toHaveLength(2);
    expect(harness.senders[0]!.testState.invocations.map(({ _ }) => _)).not.toContain(
      'upload.getFile',
    );
    expect(harness.senders[1]!.testState.invocations.map(({ _ }) => _)).toContain('upload.getFile');
    harness.senders[0]!.testState.options.connection();
    harness.senders[1]!.testState.options.connection();
    expect(connectionInputs).toEqual([
      {
        dcId: 2,
        host: 'zws2.web.telegram.org',
        port: 443,
        isTestServer: false,
        purpose: 'api',
      },
      {
        dcId: 2,
        host: 'zws2-1.web.telegram.org',
        port: 443,
        isTestServer: false,
        purpose: 'media',
      },
    ]);
    client.disconnect();
  });

  it('replaces a forgotten main-DC media sender without clearing the main key', async () => {
    const saves: Array<{ mainDcId: number; keys: Readonly<Record<number, string>> }> = [];
    const connectionInputs: Parameters<
      NonNullable<CreateMtprotoClientOptions['connectionFactory']>
    >[0][] = [];
    let staleSender: SenderDouble | undefined;
    let invalidation: Promise<void> | undefined;
    harness.beforeInvoke = async (sender, request) => {
      if (request._ !== 'upload.getFile' || (staleSender && staleSender !== sender)) return;
      staleSender ??= sender;
      sender.forceOffline();
      invalidation ??= Promise.resolve(sender.testState.options.onAuthKeyInvalidated?.());
      await invalidation;
      throw createMtprotoError('session', 'Telegram forgot this authorization key.', {
        code: -404,
      });
    };
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      session: {
        load: async () => ({ mainDcId: 2, keys: { 2: '00'.repeat(256) } }),
        save: async (value) => {
          saves.push(value);
        },
        clear: async () => undefined,
      },
      crypto: cryptoDouble(),
      connectionFactory: (input) => {
        connectionInputs.push(input);
        return {} as PacketConnection;
      },
    });
    await client.connect();
    const entity = {
      _: 'user',
      id: 10n,
      accessHash: 20n,
      photo: { _: 'userProfilePhoto', photoId: 30n, dcId: 2 },
    };

    await expect(
      Promise.all([client.downloadProfilePhoto(entity), client.downloadProfilePhoto(entity)]),
    ).resolves.toEqual([new Uint8Array(), new Uint8Array()]);

    expect(harness.senders).toHaveLength(3);
    for (const sender of harness.senders) sender.testState.options.connection();
    expect(connectionInputs.map(({ host, purpose }) => ({ host, purpose }))).toEqual([
      { host: 'zws2.web.telegram.org', purpose: 'api' },
      { host: 'zws2-1.web.telegram.org', purpose: 'media' },
      { host: 'zws2-1.web.telegram.org', purpose: 'media' },
    ]);
    expect(harness.senders[2]!.testState.options.authKey?.bytes).toEqual(new Uint8Array(256));
    expect(harness.authorizationCalls).toEqual([]);
    expect(saves).toEqual([]);
    client.disconnect();
  });

  it('imports authorization into a persisted auxiliary media sender', async () => {
    const connectionInputs: Parameters<
      NonNullable<CreateMtprotoClientOptions['connectionFactory']>
    >[0][] = [];
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      session: {
        load: async () => ({
          mainDcId: 2,
          keys: { 2: '00'.repeat(256), 4: '11'.repeat(256) },
        }),
        save: async () => undefined,
        clear: async () => undefined,
      },
      crypto: cryptoDouble(),
      connectionFactory: (input) => {
        connectionInputs.push(input);
        return {} as PacketConnection;
      },
    });
    await client.connect();

    await client.downloadProfilePhoto({
      _: 'user',
      id: 10n,
      accessHash: 20n,
      photo: { _: 'userProfilePhoto', photoId: 30n, dcId: 4 },
    });

    expect(harness.senders).toHaveLength(2);
    expect(harness.senders[0]!.dcId).toBe(2);
    expect(harness.senders[0]!.testState.invocations).toContainEqual({
      _: 'auth.exportAuthorization',
      dcId: 4,
    });
    expect(harness.senders[1]!.dcId).toBe(4);
    expect(harness.senders[1]!.testState.invocations).toContainEqual(
      expect.objectContaining({
        _: 'invokeWithLayer',
        query: expect.objectContaining({
          _: 'initConnection',
          query: expect.objectContaining({ _: 'auth.importAuthorization' }),
        }),
      }),
    );
    harness.senders[1]!.testState.options.connection();
    expect(connectionInputs.at(-1)).toEqual({
      dcId: 4,
      host: 'zws4-1.web.telegram.org',
      port: 443,
      isTestServer: false,
      purpose: 'media',
    });
    client.disconnect();
  });

  it('creates a missing auxiliary key on the normal endpoint before importing it', async () => {
    const connectionInputs: Parameters<
      NonNullable<CreateMtprotoClientOptions['connectionFactory']>
    >[0][] = [];
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      session: {
        load: async () => ({ mainDcId: 2, keys: { 2: '00'.repeat(256) } }),
        save: async () => undefined,
        clear: async () => undefined,
      },
      crypto: cryptoDouble(),
      connectionFactory: (input) => {
        connectionInputs.push(input);
        return {} as PacketConnection;
      },
    });
    await client.connect();

    await client.downloadProfilePhoto({
      _: 'user',
      id: 10n,
      accessHash: 20n,
      photo: { _: 'userProfilePhoto', photoId: 30n, dcId: 4 },
    });

    expect(harness.authorizationCalls).toEqual([4]);
    expect(harness.senders).toHaveLength(2);
    harness.senders[1]!.testState.options.connection();
    expect(connectionInputs).toEqual([
      {
        dcId: 4,
        host: 'zws4.web.telegram.org',
        port: 443,
        isTestServer: false,
        purpose: 'media',
      },
    ]);
    expect(harness.senders[0]!.testState.invocations).toContainEqual({
      _: 'auth.exportAuthorization',
      dcId: 4,
    });
    client.disconnect();
  });

  it('recovers a forgotten persisted auxiliary key through the normal endpoint once', async () => {
    const saves: Array<{ mainDcId: number; keys: Readonly<Record<number, string>> }> = [];
    const connectionInputs: Parameters<
      NonNullable<CreateMtprotoClientOptions['connectionFactory']>
    >[0][] = [];
    let staleSender: SenderDouble | undefined;
    let invalidation: Promise<void> | undefined;
    harness.beforeInvoke = async (sender, request) => {
      if (request._ !== 'upload.getFile' || (staleSender && staleSender !== sender)) return;
      staleSender ??= sender;
      sender.forceOffline();
      invalidation ??= Promise.resolve(sender.testState.options.onAuthKeyInvalidated?.());
      await invalidation;
      throw createMtprotoError('session', 'Telegram forgot this authorization key.', {
        code: -404,
      });
    };
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      session: {
        load: async () => ({
          mainDcId: 2,
          keys: { 2: '00'.repeat(256), 4: '11'.repeat(256) },
        }),
        save: async (value) => {
          saves.push(value);
        },
        clear: async () => undefined,
      },
      crypto: cryptoDouble(),
      connectionFactory: (input) => {
        connectionInputs.push(input);
        return {} as PacketConnection;
      },
    });
    await client.connect();
    const entity = {
      _: 'user',
      id: 10n,
      accessHash: 20n,
      photo: { _: 'userProfilePhoto', photoId: 30n, dcId: 4 },
    };

    await expect(
      Promise.all([client.downloadProfilePhoto(entity), client.downloadProfilePhoto(entity)]),
    ).resolves.toEqual([new Uint8Array(), new Uint8Array()]);

    expect(harness.senders).toHaveLength(3);
    for (const sender of harness.senders) sender.testState.options.connection();
    expect(connectionInputs.map(({ host, purpose }) => ({ host, purpose }))).toEqual([
      { host: 'zws2.web.telegram.org', purpose: 'api' },
      { host: 'zws4-1.web.telegram.org', purpose: 'media' },
      { host: 'zws4.web.telegram.org', purpose: 'media' },
    ]);
    expect(harness.authorizationCalls).toEqual([4]);
    expect(
      harness.senders[0]!.testState.invocations.filter(({ _ }) => _ === 'auth.exportAuthorization'),
    ).toHaveLength(2);
    expect(
      harness.senders[2]!.testState.invocations.filter(({ _ }) => _ === 'invokeWithLayer'),
    ).toHaveLength(1);
    expect(saves).toContainEqual({ mainDcId: 2, keys: { 2: '00'.repeat(256) } });
    expect(saves.at(-1)).toEqual({
      mainDcId: 2,
      keys: { 2: '00'.repeat(256), 4: '04'.repeat(256) },
    });
    client.disconnect();
  });

  it('shares one DH authorization between concurrent API and media senders for a DC', async () => {
    let finishAuthorization!: (value: AuthorizationResult) => void;
    harness.authorize = () =>
      new Promise<AuthorizationResult>((resolve) => {
        finishAuthorization = resolve;
      });
    let migrated = false;
    harness.beforeInvoke = (sender, request) => {
      if (sender !== harness.senders[0] || request._ !== 'updates.getState' || migrated) return;
      migrated = true;
      throw createMtprotoError('rpc', 'Telegram moved this request.', {
        code: 303,
        details: { errorMessage: 'NETWORK_MIGRATE_4' },
      });
    };
    const connectionInputs: Parameters<
      NonNullable<CreateMtprotoClientOptions['connectionFactory']>
    >[0][] = [];
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      session: {
        load: async () => ({ mainDcId: 2, keys: { 2: '00'.repeat(256) } }),
        save: async () => undefined,
        clear: async () => undefined,
      },
      crypto: cryptoDouble(),
      connectionFactory: (input) => {
        connectionInputs.push(input);
        return {} as PacketConnection;
      },
    });
    await client.connect();

    const migrating = client.invoke(Api.updates.GetState({}));
    await vi.waitFor(() => expect(harness.authorizationCalls).toEqual([4]));
    const downloading = client.downloadProfilePhoto({
      _: 'user',
      id: 10n,
      accessHash: 20n,
      photo: { _: 'userProfilePhoto', photoId: 30n, dcId: 4 },
    });
    await vi.waitFor(() => expect(harness.senders).toHaveLength(3));
    expect(harness.authorizationCalls).toEqual([4]);
    expect(harness.senders[1]!.testState.options.authKey).toBeUndefined();
    expect(harness.senders[2]!.testState.options.authKey).toBeUndefined();

    finishAuthorization({
      authKey: {
        bytes: new Uint8Array(256).fill(4),
        hash: new Uint8Array(20),
        auxHash: 0n,
        id: 4n,
        calculateNewNonceHash: async () => 0n,
      },
      timeOffset: 0,
      serverSalt: 0n,
    });
    await expect(Promise.all([migrating, downloading])).resolves.toHaveLength(2);

    harness.senders[1]!.testState.options.connection();
    harness.senders[2]!.testState.options.connection();
    expect(connectionInputs).toEqual([
      {
        dcId: 4,
        host: 'zws4.web.telegram.org',
        port: 443,
        isTestServer: false,
        purpose: 'api',
      },
      {
        dcId: 4,
        host: 'zws4.web.telegram.org',
        port: 443,
        isTestServer: false,
        purpose: 'media',
      },
    ]);
    expect(harness.authorizationCalls).toEqual([4]);
    client.disconnect();
  });
});
