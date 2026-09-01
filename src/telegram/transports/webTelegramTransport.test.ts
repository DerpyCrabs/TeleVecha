import { describe, expect, it, vi } from 'vitest';
import { gzipSync, strToU8 } from 'fflate';

import type { CreateMtprotoClientOptions, MtprotoClient } from '../mtproto';
import { Api, type Tl } from '../mtproto/tl';
import { connectionStateEvent, sessionGapEvent, updateEvent } from '../mtproto/events';
import type { TransportUpdate, TransportUpdateBatch } from '../types';
import {
  createWebTelegramTransport,
  createWebTelegramTransportForTesting,
  type WebTelegramTransportDependencies,
} from './webTelegramTransport';

function transport(dependencies: WebTelegramTransportDependencies = {}) {
  return createWebTelegramTransportForTesting(
    {
      loadTransportSession: async () => undefined,
      saveTransportSession: async () => undefined,
    },
    dependencies,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function anyTl(factory: { is(value: unknown): boolean; tlName: string }) {
  return {
    asymmetricMatch: (value: unknown) => factory.is(value),
    toString: () => `Any<${factory.tlName}>`,
    getExpectedType: () => 'object',
  };
}

type TransportInternals = {
  client: {
    invoke(request: unknown): Promise<unknown>;
    disconnect?(): void;
    isConnected?(): boolean;
    flushSession?(): Promise<void>;
    uploadFile?(options: unknown): Promise<Tl.TypeInputFile>;
    getMe?(): Promise<Tl.TypeUser | undefined>;
    downloadMedia?(media: unknown, options: unknown): Promise<Uint8Array | undefined>;
    downloadProfilePhoto?(entity: unknown): Promise<Uint8Array | undefined>;
    subscribe?(handler: unknown): void | (() => void);
  };
  phoneNumber: string;
  phoneCodeHash: string;
  wallpaperDocuments: Map<string, Tl.Document>;
  notifyDefaults: Map<string, Tl.TypePeerNotifySettings>;
  notifyDefaultsLoading?: Promise<void>;
  notifyDefaultsLoaded: boolean;
  channelRolesLoading: Map<string, Promise<void>>;
  installEventHandler(): void;
  mapUpdateEnvelope(update: unknown): TransportUpdateBatch;
  mapMessage(
    message: Tl.TypeMessage,
  ): ReturnType<ReturnType<typeof createWebTelegramTransport>['getHistory']>;
  inputPeer(peer: { id: string; kind: 'user' | 'group' | 'channel'; accessHash?: string }): unknown;
};

function mappedUpdates(target: TransportInternals, update: unknown) {
  return target.mapUpdateEnvelope(update).updates;
}

describe('web Telegram transport mapping', () => {
  it('does not expose mutable white-box internals from the application factory', () => {
    const target = createWebTelegramTransport({
      loadTransportSession: async () => undefined,
      saveTransportSession: async () => undefined,
    });

    expect('client' in target).toBe(false);
    expect('mapMessage' in target).toBe(false);
    expect('clearRuntimeCaches' in target).toBe(false);
  });

  it('coalesces connection setup and invalidates it when disconnect wins the race', async () => {
    const session = deferred<unknown>();
    const loadTransportSession = vi.fn(() => session.promise);
    const target = createWebTelegramTransport({
      loadTransportSession,
      saveTransportSession: async () => undefined,
    });

    const first = target.connect({ apiId: 1, apiHash: 'hash' });
    const second = target.connect({ apiId: 1, apiHash: 'hash' });
    await Promise.resolve();
    expect(loadTransportSession).toHaveBeenCalledOnce();

    const firstResult = expect(first).rejects.toThrow('connection attempt was superseded');
    const secondResult = expect(second).rejects.toThrow('connection attempt was superseded');
    const disconnecting = target.disconnect();
    session.resolve(undefined);
    await Promise.all([firstResult, secondResult, disconnecting]);
    expect(loadTransportSession).toHaveBeenCalledOnce();
  });

  it('clears account-scoped transient state when a disconnected client is replaced', async () => {
    const firstUnsubscribe = vi.fn();
    const firstDisconnect = vi.fn();
    let firstConnected = false;
    const firstClient = {
      apiId: 1,
      apiHash: 'hash',
      connect: vi.fn(async () => {
        firstConnected = true;
      }),
      disconnect: firstDisconnect.mockImplementation(() => {
        firstConnected = false;
      }),
      isConnected: vi.fn(() => firstConnected),
      flushSession: vi.fn(async () => undefined),
      subscribe: vi.fn(() => firstUnsubscribe),
    } as unknown as MtprotoClient;
    let secondConnected = false;
    const secondClient = {
      apiId: 1,
      apiHash: 'hash',
      connect: vi.fn(async () => {
        secondConnected = true;
      }),
      disconnect: vi.fn(() => {
        secondConnected = false;
      }),
      isConnected: vi.fn(() => secondConnected),
      flushSession: vi.fn(async () => undefined),
      subscribe: vi.fn(() => vi.fn()),
    } as unknown as MtprotoClient;
    const clients = [firstClient, secondClient];
    const createClient = vi.fn((_options: CreateMtprotoClientOptions) => {
      const client = clients.shift();
      if (!client) throw new Error('Unexpected client creation');
      return client;
    });
    const target = transport({ createClient });

    await target.connect({ apiId: 1, apiHash: 'hash' });
    const internals = target as unknown as TransportInternals;
    internals.phoneNumber = '+15551234567';
    internals.phoneCodeHash = 'stale-code-hash';
    internals.wallpaperDocuments.set(
      '99',
      Api.Document({
        id: 99n,
        accessHash: 199n,
        fileReference: new Uint8Array(),
        date: 1,
        mimeType: 'image/jpeg',
        size: 1n,
        dcId: 2,
        attributes: [],
      }),
    );
    firstConnected = false;

    await target.connect({ apiId: 1, apiHash: 'hash' });

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(firstDisconnect).toHaveBeenCalledOnce();
    expect(firstUnsubscribe).toHaveBeenCalledOnce();
    expect(internals.phoneNumber).toBe('');
    expect(internals.phoneCodeHash).toBe('');
    expect(internals.wallpaperDocuments.size).toBe(0);
    await target.disconnect();
  });

  it('returns the raw Telegram user id for the authorized account', async () => {
    const target = transport();
    const getMe = vi.fn().mockResolvedValue(Api.User({ id: 991n, firstName: 'Self' }));
    (target as unknown as TransportInternals).client = { invoke: vi.fn(), getMe };

    await expect(target.getAuthorizedAccountId()).resolves.toBe('991');
    expect(getMe).toHaveBeenCalledOnce();
  });

  it('reads Telegram themes and wallpapers without installing either', async () => {
    const target = transport();
    const wallpaper = Api.WallPaperNoFile({
      id: 55n,
      dark: true,
      settings: Api.WallPaperSettings({
        backgroundColor: 0x17212b,
        secondBackgroundColor: 0x2b5278,
        rotation: 45,
        blur: true,
      }),
    });
    const invoke = vi.fn((request: unknown) => {
      if (Api.account.GetThemes.is(request)) {
        return Promise.resolve(
          Api.account.Themes({
            hash: 1n,
            themes: [
              Api.Theme({
                id: 10n,
                accessHash: 11n,
                slug: 'ocean',
                title: 'Ocean',
                settings: [
                  Api.ThemeSettings({
                    baseTheme: Api.BaseThemeTinted(),
                    accentColor: 0x56a8e8,
                    outboxAccentColor: 0x4b8fca,
                    messageColors: [0x2b5278, 0x376f9d],
                    wallpaper,
                  }),
                ],
              }),
            ],
          }),
        );
      }
      if (Api.account.GetWallPapers.is(request)) {
        return Promise.resolve(Api.account.WallPapers({ hash: 2n, wallpapers: [wallpaper] }));
      }
      throw new Error('Unexpected request');
    });
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.getThemes()).resolves.toEqual([
      expect.objectContaining({
        id: '10',
        title: 'Ocean',
        settings: [
          expect.objectContaining({
            baseTheme: 'tinted',
            accentColor: '#56a8e8',
            outboxAccentColor: '#4b8fca',
            messageColors: ['#2b5278', '#376f9d'],
            wallpaper: expect.objectContaining({ id: '55', dark: true }),
          }),
        ],
      }),
    ]);
    await expect(target.getWallpapers()).resolves.toEqual([
      expect.objectContaining({
        id: '55',
        hasFile: false,
        settings: expect.objectContaining({
          backgroundColors: ['#17212b', '#2b5278'],
          rotation: 45,
          blur: true,
        }),
      }),
    ]);
    expect(Api.account.GetThemes.is(invoke.mock.calls[0]?.[0])).toBe(true);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ format: 'tdesktop', hash: 0n });
    expect(Api.account.GetWallPapers.is(invoke.mock.calls[1]?.[0])).toBe(true);
  });

  it('decodes Telegram TGV wallpaper patterns into browser-readable SVG', async () => {
    const target = transport();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h8v8z"/></svg>';
    const document = Api.Document({
      id: 501n,
      accessHash: 502n,
      fileReference: new Uint8Array([1]),
      date: 1,
      mimeType: 'application/x-tgwallpattern',
      size: 100n,
      dcId: 2,
      attributes: [],
    });
    const wallpaper = Api.WallPaper({
      id: 500n,
      accessHash: 503n,
      slug: 'pattern',
      pattern: true,
      document,
      settings: Api.WallPaperSettings({ backgroundColor: 0x102d40, intensity: 60 }),
    });
    const invoke = vi
      .fn()
      .mockResolvedValue(Api.account.WallPapers({ hash: 1n, wallpapers: [wallpaper] }));
    const downloadMedia = vi.fn().mockResolvedValue(gzipSync(strToU8(svg)));
    (target as unknown as TransportInternals).client = { invoke, downloadMedia };

    const decoded = await target.downloadWallpaper('500');

    expect(decoded.type).toBe('image/svg+xml');
    await expect(decoded.text()).resolves.toBe(svg);
    expect(invoke).toHaveBeenCalledWith(anyTl(Api.account.GetWallPapers));
    expect(downloadMedia).toHaveBeenCalledWith(document, { workers: 1 });
  });

  it('includes the chat theme request in the runtime TL schema', () => {
    expect(Api.account.GetChatThemes).toBeTypeOf('function');
    expect(Api.account.GetChatThemes.is(Api.account.GetChatThemes({ hash: 0n }))).toBe(true);
  });

  it('resolves the theme and background assigned to a private chat', async () => {
    const target = transport();
    const wallpaper = Api.WallPaperNoFile({
      id: 77n,
      settings: Api.WallPaperSettings({
        backgroundColor: 0x102d40,
        secondBackgroundColor: 0x1d5960,
      }),
    });
    const theme = Api.Theme({
      id: 88n,
      accessHash: 89n,
      slug: 'ocean-chat',
      title: 'Ocean Chat',
      emoticon: '🌊',
      forChat: true,
      settings: [
        Api.ThemeSettings({
          baseTheme: Api.BaseThemeNight(),
          accentColor: 0x56a8e8,
          messageColors: [0x2b5278],
          wallpaper,
        }),
      ],
    });
    const invoke = vi.fn((request: unknown) => {
      if (Api.users.GetFullUser.is(request)) {
        return Promise.resolve(
          Api.users.UserFull({
            fullUser: Api.UserFull({
              id: 11n,
              settings: Api.PeerSettings({}),
              notifySettings: Api.PeerNotifySettings({}),
              commonChatsCount: 0,
              theme: Api.ChatTheme({ emoticon: '🌊' }),
            }),
            chats: [],
            users: [Api.User({ id: 11n, firstName: 'Alice' })],
          }),
        );
      }
      if (Api.account.GetChatThemes.is(request)) {
        return Promise.resolve(Api.account.Themes({ hash: 1n, themes: [theme] }));
      }
      throw new Error('Unexpected request');
    });
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.getChatAppearance({ id: 'u:11', kind: 'user', accessHash: '12' }),
    ).resolves.toEqual({
      theme: expect.objectContaining({
        id: '88',
        emoticon: '🌊',
        settings: [expect.objectContaining({ wallpaper: expect.objectContaining({ id: '77' }) })],
      }),
    });
    expect(Api.account.GetChatThemes.is(invoke.mock.calls[1]?.[0])).toBe(true);
  });

  it('installs the raw update handler on every replacement client', () => {
    const target = transport() as unknown as TransportInternals;
    const first = vi.fn();
    const second = vi.fn();
    target.client = { invoke: vi.fn(), subscribe: first };
    target.installEventHandler();
    target.client = { invoke: vi.fn(), subscribe: second };
    target.installEventHandler();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('delivers a raw cross-client message from MTProto to transport subscribers', () => {
    const target = transport();
    let handler: ((update: unknown) => void) | undefined;
    (target as unknown as TransportInternals).client = {
      invoke: vi.fn(),
      subscribe: (callback: unknown) => {
        handler = callback as (update: unknown) => void;
      },
    };
    const received: TransportUpdate[] = [];
    target.subscribe((batch) => received.push(...batch.updates));
    (target as unknown as TransportInternals).installEventHandler();

    handler?.(
      updateEvent(
        Api.UpdateNewMessage({
          message: Api.Message({
            id: 88,
            out: true,
            peerId: Api.PeerUser({ userId: 11n }),
            date: 100,
            message: 'Sent from another Telegram client',
          }),
          pts: 12,
          ptsCount: 1,
        }),
      ),
    );

    expect(received).toEqual([
      expect.objectContaining({
        type: 'new-message',
        message: expect.objectContaining({
          id: 88,
          outgoing: true,
          text: 'Sent from another Telegram client',
        }),
      }),
    ]);
  });

  it('ignores events from a superseded client generation', () => {
    vi.useFakeTimers();
    const target = transport();
    const internals = target as unknown as {
      client: unknown;
      connectionGeneration: number;
      installEventHandler(client: unknown, generation: number): void;
    };
    let firstHandler: ((update: unknown) => void) | undefined;
    let secondHandler: ((update: unknown) => void) | undefined;
    const firstClient = {
      invoke: vi.fn(),
      subscribe: (callback: unknown) => {
        firstHandler = callback as (update: unknown) => void;
      },
    };
    const secondClient = {
      invoke: vi.fn(),
      subscribe: (callback: unknown) => {
        secondHandler = callback as (update: unknown) => void;
      },
    };
    const received: TransportUpdate[] = [];
    target.subscribe((batch) => received.push(...batch.updates));

    internals.connectionGeneration = 1;
    internals.client = firstClient;
    internals.installEventHandler(firstClient, 1);
    firstHandler?.(connectionStateEvent('disconnected'));
    internals.connectionGeneration = 2;
    internals.client = secondClient;
    internals.installEventHandler(secondClient, 2);

    vi.advanceTimersByTime(5_000);
    expect(received).toEqual([]);

    secondHandler?.(connectionStateEvent('disconnected'));
    vi.advanceTimersByTime(5_000);

    expect(received).toEqual([{ type: 'connection-state', connected: false }]);
    vi.useRealTimers();
  });

  it('does not report background wake-up warnings as connection loss', () => {
    vi.useFakeTimers();
    const target = transport();
    let handler: ((update: unknown) => void) | undefined;
    const client = {
      invoke: vi.fn(),
      subscribe: (callback: unknown) => {
        handler = callback as (update: unknown) => void;
      },
    };
    const internals = target as unknown as {
      client: unknown;
      connectionGeneration: number;
      installEventHandler(client: unknown, generation: number): void;
    };
    const received: TransportUpdate[] = [];
    target.subscribe((batch) => received.push(...batch.updates));
    internals.connectionGeneration = 1;
    internals.client = client;
    internals.installEventHandler(client, 1);

    handler?.(connectionStateEvent('disconnected'));
    vi.advanceTimersByTime(1_000);
    handler?.(connectionStateEvent('connected'));
    vi.advanceTimersByTime(5_000);

    expect(received).toEqual([]);
    vi.useRealTimers();
  });

  it('reports a connection loss that remains disconnected past the wake-up grace period', () => {
    vi.useFakeTimers();
    const target = transport();
    let handler: ((update: unknown) => void) | undefined;
    const client = {
      invoke: vi.fn(),
      subscribe: (callback: unknown) => {
        handler = callback as (update: unknown) => void;
      },
    };
    const internals = target as unknown as {
      client: unknown;
      connectionGeneration: number;
      installEventHandler(client: unknown, generation: number): void;
    };
    const received: TransportUpdate[] = [];
    target.subscribe((batch) => received.push(...batch.updates));
    internals.connectionGeneration = 1;
    internals.client = client;
    internals.installEventHandler(client, 1);

    handler?.(connectionStateEvent('disconnected'));
    vi.advanceTimersByTime(4_999);
    expect(received).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(received).toEqual([{ type: 'connection-state', connected: false }]);
    vi.useRealTimers();
  });

  it('reports disconnects and requests catch-up only for real session or PTS gaps', () => {
    const target = transport() as unknown as TransportInternals;
    expect(mappedUpdates(target, connectionStateEvent('connected'))).toEqual([]);
    expect(mappedUpdates(target, connectionStateEvent('disconnected'))).toEqual([
      { type: 'connection-state', connected: false },
    ]);
    expect(mappedUpdates(target, sessionGapEvent(1n, 2n))).toEqual([{ type: 'too-long' }]);
    expect(mappedUpdates(target, Api.UpdatePtsChanged())).toEqual([{ type: 'too-long' }]);
  });

  it('preserves one combined socket envelope with its date and sequence range', () => {
    const target = transport() as unknown as TransportInternals;
    const batch = target.mapUpdateEnvelope(
      Api.UpdatesCombined({
        updates: [
          Api.UpdateNewMessage({
            message: Api.Message({
              id: 91,
              peerId: Api.PeerUser({ userId: 11n }),
              date: 110,
              message: 'Combined update',
            }),
            pts: 31,
            ptsCount: 1,
          }),
        ],

        users: [],
        chats: [],
        date: 110,
        seqStart: 8,
        seq: 10,
      }),
    );

    expect(batch).toMatchObject({
      date: 110,
      seqStart: 8,
      seq: 10,
      updates: [{ type: 'new-message', pts: 31, ptsCount: 1 }],
    });
  });

  it('correlates Telegram message ids with random ids across one update envelope', () => {
    const target = transport() as unknown as TransportInternals;
    const batch = target.mapUpdateEnvelope(
      Api.Updates({
        updates: [
          Api.UpdateNewMessage({
            message: Api.Message({
              id: 92,
              out: true,
              peerId: Api.PeerUser({ userId: 11n }),
              date: 111,
              message: 'Correlated update',
            }),
            pts: 32,
            ptsCount: 1,
          }),
          Api.UpdateMessageID({ id: 92, randomId: 9_200n }),
        ],

        users: [],
        chats: [],
        date: 111,
        seq: 11,
      }),
    );

    expect(batch).toMatchObject({
      updates: [{ type: 'new-message', message: { id: 92, randomId: '9200' } }],
    });
  });

  it('keeps short-update metadata intact through the raw MTProto handoff', () => {
    const envelope = Api.UpdateShort({ update: Api.UpdatePtsChanged(), date: 111 });

    expect((transport() as unknown as TransportInternals).mapUpdateEnvelope(envelope)).toEqual({
      updates: [{ type: 'too-long' }],
      date: 111,
    });
  });

  it('keeps dialog top messages separate when different peers reuse the same message id', async () => {
    const firstPeer = Api.PeerUser({ userId: 1n });
    const secondPeer = Api.PeerUser({ userId: 2n });
    const notifySettings = Api.PeerNotifySettings({ muteUntil: 2_147_483_647 });
    const result = Api.messages.Dialogs({
      dialogs: [
        Api.Dialog({
          peer: firstPeer,
          topMessage: 5,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          unreadCount: 0,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          notifySettings,
        }),
        Api.Dialog({
          peer: secondPeer,
          topMessage: 5,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          unreadCount: 0,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          notifySettings,
        }),
      ],

      messages: [
        Api.Message({
          id: 5,
          peerId: firstPeer,
          date: 10,
          message: 'First preview',
        }),
        Api.Message({
          id: 5,
          peerId: secondPeer,
          date: 20,
          message: 'Second preview',
        }),
      ],

      chats: [],
      users: [Api.User({ id: 1n, firstName: 'First' }), Api.User({ id: 2n, firstName: 'Second' })],
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    (target as unknown as TransportInternals).client = { invoke };

    const page = await target.getDialogs(100);
    expect(page.dialogs.map(({ topMessage }) => topMessage?.text)).toEqual([
      'First preview',
      'Second preview',
    ]);
  });

  it('preserves the per-channel PTS cursor from dialog snapshots', async () => {
    const peer = Api.PeerChannel({ channelId: 12n });
    const result = Api.messages.Dialogs({
      dialogs: [
        Api.Dialog({
          peer,
          topMessage: 0,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          unreadCount: 0,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          notifySettings: Api.PeerNotifySettings(),
          pts: 44,
        }),
      ],

      messages: [],
      chats: [
        Api.Channel({
          id: 12n,
          accessHash: 92n,
          title: 'Channel',
          photo: Api.ChatPhotoEmpty(),
          date: 1,
        }),
      ],

      users: [],
    });
    const target = transport();
    (target as unknown as TransportInternals).client = {
      invoke: vi.fn().mockResolvedValue(result),
    };

    await expect(target.getDialogs(100)).resolves.toMatchObject({
      dialogs: [{ peer: { id: 'c:12', accessHash: '92' }, channelPts: 44 }],
    });
  });

  it('loads archived dialogs and maps downloadable user profile photos', async () => {
    const visiblePeer = Api.PeerUser({ userId: 1n });
    const archivedPeer = Api.PeerUser({ userId: 2n });
    const visiblePhoto = Api.UserProfilePhoto({
      photoId: 91n,
      dcId: 2,
    });
    const visibleUser = Api.User({
      id: 1n,
      accessHash: 11n,
      firstName: 'Visible',
      username: 'visible_bot',
      bot: true,
      photo: visiblePhoto,
    });
    const archivedUser = Api.User({ id: 2n, firstName: 'Archived' });
    const notifySettings = Api.PeerNotifySettings({ muteUntil: 2_147_483_647 });
    const result = Api.messages.Dialogs({
      dialogs: [
        Api.Dialog({
          peer: visiblePeer,
          topMessage: 1,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          unreadCount: 0,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          notifySettings,
        }),
        Api.Dialog({
          peer: archivedPeer,
          topMessage: 2,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          unreadCount: 0,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          notifySettings,
          folderId: 1,
        }),
      ],

      messages: [],
      chats: [],
      users: [visibleUser, archivedUser],
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    const downloadProfilePhoto = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    (target as unknown as TransportInternals).client = { invoke, downloadProfilePhoto };

    const page = await target.getDialogs(100);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ folderId: 0 });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ folderId: 1 });
    expect(page.dialogs).toHaveLength(2);
    expect(page.dialogs[0]).toMatchObject({
      title: 'Visible',
      archived: false,
      muted: true,
      username: 'visible_bot',
      bot: true,
      hasAvatar: true,
      avatarId: '91',
    });
    expect(page.dialogs[1]).toMatchObject({ title: 'Archived', archived: true, muted: true });

    const avatar = await target.downloadAvatar(page.dialogs[0]!.peer);
    expect(avatar).toMatchObject({ size: 3, type: 'image/jpeg' });
    expect(downloadProfilePhoto).toHaveBeenCalledWith(visibleUser);
  });

  it('refetches a missing or partial entity before downloading its avatar', async () => {
    const user = Api.User({
      id: 1n,
      accessHash: 11n,
      firstName: 'Refetched',
      photo: Api.UserProfilePhoto({ photoId: 92n, dcId: 2 }),
    });
    const invoke = vi.fn().mockResolvedValue([user]);
    const downloadProfilePhoto = vi.fn().mockResolvedValue(new Uint8Array([4, 5]));
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke, downloadProfilePhoto };
    (target as unknown as { entities: Map<string, Tl.TypeUser> }).entities.set(
      'u:1',
      Api.User({ id: 1n, accessHash: 11n, firstName: 'Partial' }),
    );

    await expect(
      target.downloadAvatar({ id: 'u:1', kind: 'user', accessHash: '11' }),
    ).resolves.toMatchObject({ size: 2, type: 'image/jpeg' });
    expect(Api.users.GetUsers.is(invoke.mock.calls[0]?.[0])).toBe(true);
    expect(downloadProfilePhoto).toHaveBeenCalledWith(user);
  });

  it('inherits mute state from the Telegram default when the dialog has no override', async () => {
    const peer = Api.PeerUser({ userId: 11n });
    const dialogPage = Api.messages.Dialogs({
      dialogs: [
        Api.Dialog({
          peer,
          topMessage: 1,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          unreadCount: 5,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          notifySettings: Api.PeerNotifySettings(),
        }),
      ],

      messages: [],
      chats: [],
      users: [Api.User({ id: 11n, firstName: 'Muted by default' })],
    });
    const target = transport();
    const invoke = vi.fn((request: unknown) => {
      if (Api.account.GetNotifySettings.is(request)) {
        return Promise.resolve(
          Api.InputNotifyUsers.is(request.peer)
            ? Api.PeerNotifySettings({ muteUntil: 2_147_483_647 })
            : Api.PeerNotifySettings(),
        );
      }
      return Promise.resolve(dialogPage);
    });
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.getDialogs(100)).resolves.toMatchObject({
      dialogs: [expect.objectContaining({ unreadCount: 5, muted: true })],
    });
  });

  it('returns dialogs when optional notification defaults do not answer', async () => {
    vi.useFakeTimers();
    const peer = Api.PeerUser({ userId: 11n });
    const dialogPage = Api.messages.Dialogs({
      dialogs: [
        Api.Dialog({
          peer,
          topMessage: 1,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          unreadCount: 2,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          notifySettings: Api.PeerNotifySettings(),
        }),
      ],
      messages: [
        Api.Message({
          id: 1,
          peerId: peer,
          date: 1,
          message: 'Available before defaults',
        }),
      ],
      chats: [],
      users: [Api.User({ id: 11n, accessHash: 91n, firstName: 'Ready' })],
    });
    const notificationDefaults = deferred<Tl.TypePeerNotifySettings>();
    const invoke = vi.fn((request: unknown) => {
      if (Api.account.GetNotifySettings.is(request)) return notificationDefaults.promise;
      if (Api.messages.GetDialogs.is(request)) return Promise.resolve(dialogPage);
      throw new Error('Unexpected dialogs request');
    });
    const target = transport({ optionalEnrichmentDeadlineMs: 50 });
    const internals = target as unknown as TransportInternals;
    internals.client = {
      invoke,
      disconnect: vi.fn(),
      flushSession: vi.fn(async () => undefined),
    };

    try {
      const dialogs = target.getDialogs(1);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
      await expect(dialogs).resolves.toMatchObject({
        dialogs: [
          expect.objectContaining({
            title: 'Ready',
            unreadCount: 2,
            muted: false,
            topMessage: expect.objectContaining({ text: 'Available before defaults' }),
          }),
        ],
      });
      const staleLoading = internals.notifyDefaultsLoading;
      expect(staleLoading).toBeDefined();

      await target.disconnect();
      notificationDefaults.resolve(Api.PeerNotifySettings({ muteUntil: 2_147_483_647 }));
      await staleLoading;

      expect(internals.notifyDefaults.size).toBe(0);
      expect(internals.notifyDefaultsLoaded).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns one dialog when optional notification defaults do not answer', async () => {
    const peer = Api.PeerUser({ userId: 12n });
    const dialogPage = Api.messages.PeerDialogs({
      dialogs: [
        Api.Dialog({
          peer,
          topMessage: 2,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          unreadCount: 0,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          notifySettings: Api.PeerNotifySettings(),
        }),
      ],
      messages: [
        Api.Message({
          id: 2,
          peerId: peer,
          date: 2,
          message: 'One ready dialog',
        }),
      ],
      chats: [],
      users: [Api.User({ id: 12n, accessHash: 92n, firstName: 'Single' })],
      state: Api.updates.State({ pts: 1, qts: 1, date: 1, seq: 1, unreadCount: 0 }),
    });
    const notificationDefaults = deferred<Tl.TypePeerNotifySettings>();
    const invoke = vi.fn((request: unknown) => {
      if (Api.account.GetNotifySettings.is(request)) return notificationDefaults.promise;
      if (Api.messages.GetPeerDialogs.is(request)) return Promise.resolve(dialogPage);
      throw new Error('Unexpected peer-dialog request');
    });
    const target = transport({ optionalEnrichmentDeadlineMs: 0 });
    const internals = target as unknown as TransportInternals;
    internals.client = { invoke };

    await expect(
      target.getDialog({ id: 'u:12', kind: 'user', accessHash: '92' }),
    ).resolves.toMatchObject({
      title: 'Single',
      muted: false,
      topMessage: expect.objectContaining({ text: 'One ready dialog' }),
    });
    const loading = internals.notifyDefaultsLoading;
    expect(loading).toBeDefined();
    notificationDefaults.resolve(Api.PeerNotifySettings());
    await loading;
  });

  it('treats the dialog limit as a total result cap', async () => {
    const notifySettings = Api.PeerNotifySettings();
    const page = (ids: number[]) =>
      Api.messages.Dialogs({
        dialogs: ids.map((id) =>
          Api.Dialog({
            peer: Api.PeerUser({ userId: BigInt(id) }),
            topMessage: id * 10,
            readInboxMaxId: 0,
            readOutboxMaxId: 0,
            unreadCount: 0,
            unreadMentionsCount: 0,
            unreadReactionsCount: 0,
            unreadPollVotesCount: 0,
            notifySettings,
          }),
        ),
        messages: ids.map((id) =>
          Api.Message({
            id: id * 10,
            peerId: Api.PeerUser({ userId: BigInt(id) }),
            date: id * 100,
            message: `Message ${id}`,
          }),
        ),
        chats: [],
        users: ids.map((id) =>
          Api.User({ id: BigInt(id), accessHash: BigInt(id + 100), firstName: `User ${id}` }),
        ),
      });
    const target = transport();
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(page([3, 2]))
      .mockResolvedValueOnce(page([1]));
    (target as unknown as TransportInternals).client = { invoke };

    const result = await target.getDialogs(2);
    const dialogRequests = invoke.mock.calls.filter(([request]) =>
      Api.messages.GetDialogs.is(request),
    );

    expect(result.dialogs.map(({ title }) => title)).toEqual(['User 3', 'User 2']);
    expect(dialogRequests).toHaveLength(1);
    expect(dialogRequests[0]?.[0]).toMatchObject({ limit: 2 });
  });

  it('keeps paging until every dialog in both folders is loaded', async () => {
    const notifySettings = Api.PeerNotifySettings();
    const page = (ids: number[], archived = false) =>
      Api.messages.Dialogs({
        dialogs: ids.map((id) =>
          Api.Dialog({
            peer: Api.PeerUser({ userId: BigInt(id) }),
            topMessage: id,
            readInboxMaxId: 0,
            readOutboxMaxId: 0,
            unreadCount: 0,
            unreadMentionsCount: 0,
            unreadReactionsCount: 0,
            unreadPollVotesCount: 0,
            notifySettings,
            ...(archived ? { folderId: 1 } : {}),
          }),
        ),
        messages: ids.map((id) =>
          Api.Message({
            id,
            peerId: Api.PeerUser({ userId: BigInt(id) }),
            date: id,
            message: `Message ${id}`,
          }),
        ),
        chats: [],
        users: ids.map((id) =>
          Api.User({ id: BigInt(id), accessHash: BigInt(id), firstName: `User ${id}` }),
        ),
      });
    const firstPageIds = Array.from({ length: 100 }, (_, index) => 101 - index);
    const target = transport();
    const invoke = vi.fn((request: unknown) => {
      const dialogRequest = request as { folderId?: number; offsetId?: number };
      if (dialogRequest.folderId === 1) return Promise.resolve(page([201], true));
      if (dialogRequest.offsetId === 0) return Promise.resolve(page(firstPageIds));
      return Promise.resolve(page([1]));
    });
    (target as unknown as TransportInternals).client = { invoke };

    const result = await target.getDialogs(Number.MAX_SAFE_INTEGER);
    const dialogRequests = invoke.mock.calls.filter(([request]) =>
      Api.messages.GetDialogs.is(request),
    );

    expect(result.dialogs).toHaveLength(102);
    expect(result.dialogs.filter(({ archived }) => archived)).toHaveLength(1);
    expect(dialogRequests).toHaveLength(3);
    expect(dialogRequests.map(([request]) => (request as { folderId: number }).folderId)).toEqual([
      0, 0, 1,
    ]);
  });

  it('searches contacts, users, bots, public groups, and channels', async () => {
    const contact = Api.User({
      id: 11n,
      accessHash: 111n,
      firstName: 'Saved Contact',
      username: 'saved_contact',
      contact: true,
    });
    const bot = Api.User({
      id: 12n,
      accessHash: 112n,
      firstName: 'Search Bot',
      username: 'search_bot',
      bot: true,
    });
    const group = Api.Channel({
      id: 13n,
      accessHash: 113n,
      title: 'Public Group',
      username: 'public_group',
      megagroup: true,
      photo: Api.ChatPhotoEmpty(),
      date: 1,
    });
    const channel = Api.Channel({
      id: 14n,
      accessHash: 114n,
      title: 'Public Channel',
      username: 'public_channel',
      broadcast: true,
      photo: Api.ChatPhotoEmpty(),
      date: 1,
    });
    const result = Api.contacts.Found({
      myResults: [Api.PeerUser({ userId: 11n })],
      results: [
        Api.PeerUser({ userId: 12n }),
        Api.PeerChannel({ channelId: 13n }),
        Api.PeerChannel({ channelId: 14n }),
      ],

      users: [contact, bot],
      chats: [group, channel],
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.searchPeers('public')).resolves.toMatchObject([
      { title: 'Saved Contact', category: 'user', isContact: true, username: 'saved_contact' },
      { title: 'Search Bot', category: 'bot', bot: true },
      { title: 'Public Group', category: 'group' },
      { title: 'Public Channel', category: 'channel' },
    ]);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      q: 'public',
      limit: 50,
      broadcasts: true,
      bots: true,
    });
  });

  it('does not classify every local search result as a saved contact', async () => {
    const recent = Api.User({
      id: 15n,
      accessHash: 115n,
      firstName: 'Recent Stranger',
    });
    const target = transport();
    (target as unknown as TransportInternals).client = {
      invoke: vi.fn().mockResolvedValue(
        Api.contacts.Found({
          myResults: [Api.PeerUser({ userId: 15n })],
          results: [],
          users: [recent],
          chats: [],
        }),
      ),
    };

    await expect(target.searchPeers('recent')).resolves.toMatchObject([
      { title: 'Recent Stranger', isContact: false },
    ]);
  });

  it('moves dialogs between the main and archive folders', async () => {
    const target = transport();
    const invoke = vi.fn((request: unknown) => {
      const folderId = (request as Tl.folders.EditPeerFolders).folderPeers[0]!.folderId;
      return Promise.resolve(
        Api.Updates({
          updates: [
            Api.UpdateFolderPeers({
              folderPeers: [
                Api.FolderPeer({
                  peer: Api.PeerUser({ userId: 11n }),
                  folderId,
                }),
              ],

              pts: folderId + 10,
              ptsCount: 1,
            }),
          ],

          users: [],
          chats: [],
          date: 100 + folderId,
          seq: 7 + folderId,
        }),
      );
    });
    (target as unknown as TransportInternals).client = { invoke };
    const peer = { id: 'u:11', kind: 'user' as const, accessHash: '91' };

    const archived = await target.setArchived(peer, true);
    await target.setArchived(peer, false);

    expect(archived.updateBatches).toMatchObject([
      {
        date: 101,
        seq: 8,
        updates: [
          {
            type: 'dialog-folders-changed',
            pts: 11,
            ptsCount: 1,
            folders: [{ peerId: 'u:11', folderId: 1 }],
          },
        ],
      },
    ]);

    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      folderPeers: [expect.objectContaining({ folderId: 1 })],
    });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      folderPeers: [expect.objectContaining({ folderId: 0 })],
    });
  });

  it('maps compact user and group message updates with peer and sender ids', () => {
    const target = transport() as unknown as TransportInternals;
    const user = mappedUpdates(
      target,
      Api.UpdateShortMessage({
        id: 7,
        userId: 11n,
        message: 'User update',
        pts: 4,
        ptsCount: 1,
        date: 100,
      }),
    );
    const group = mappedUpdates(
      target,
      Api.UpdateShortChatMessage({
        id: 8,
        fromId: 12n,
        chatId: 13n,
        message: 'Group update',
        pts: 5,
        ptsCount: 1,
        date: 101,
      }),
    );

    expect(user[0]).toMatchObject({
      type: 'new-message',
      message: { peerId: 'u:11', senderId: 'u:11', text: 'User update' },
    });
    expect(group[0]).toMatchObject({
      type: 'new-message',
      message: { peerId: 'g:13', senderId: 'u:12', text: 'Group update' },
    });
  });

  it('preserves Telegram still-unread counts on inbox read updates', () => {
    const target = transport() as unknown as TransportInternals;

    expect(
      mappedUpdates(
        target,
        Api.UpdateReadHistoryInbox({
          peer: Api.PeerUser({ userId: 11n }),
          maxId: 20,
          stillUnreadCount: 4,
          pts: 8,
          ptsCount: 1,
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: 'read-history',
        peerId: 'u:11',
        maxMessageId: 20,
        stillUnreadCount: 4,
      }),
    ]);
    expect(
      mappedUpdates(
        target,
        Api.UpdateReadChannelInbox({
          channelId: 12n,
          maxId: 21,
          stillUnreadCount: 5,
          pts: 9,
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: 'read-history',
        peerId: 'c:12',
        maxMessageId: 21,
        stillUnreadCount: 5,
        channelScoped: true,
      }),
    ]);
    expect(
      mappedUpdates(
        target,
        Api.UpdateReadChannelOutbox({
          channelId: 12n,
          maxId: 22,
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: 'read-history',
        peerId: 'c:12',
        maxMessageId: 22,
        direction: 'outbox',
        pts: 0,
        ptsCount: 0,
        channelScoped: true,
      }),
    ]);
  });

  it('maps Telegram document attributes and image documents to visible media', () => {
    const target = transport() as unknown as {
      mapMessage(message: Tl.TypeMessage):
        | {
            protected?: boolean;
            media?: { kind: string; name: string; cacheKey?: string; spoiler?: boolean };
          }
        | undefined;
    };
    const kinds = [
      Api.DocumentAttributeSticker({
        alt: 'x',
        stickerset: Api.InputStickerSetEmpty(),
      }),
      Api.DocumentAttributeAnimated(),
      Api.DocumentAttributeVideo({ duration: 1, w: 10, h: 10 }),
      Api.DocumentAttributeFilename({ fileName: 'plain.bin' }),
    ];

    const mapped = kinds.map((attribute, index) => {
      const document = Api.Document({
        id: BigInt(index + 1),
        accessHash: 1n,
        fileReference: new Uint8Array(),
        date: 1,
        mimeType: 'application/octet-stream',
        size: 10n,
        dcId: 2,
        attributes: [attribute, Api.DocumentAttributeFilename({ fileName: `file-${index}` })],
      });
      return target.mapMessage(
        Api.Message({
          id: index + 1,
          peerId: Api.PeerUser({ userId: 1n }),
          date: 1,
          message: '',
          media: Api.MessageMediaDocument({ document }),
        }),
      )?.media;
    });

    const png = Api.Document({
      id: 5n,
      accessHash: 1n,
      fileReference: new Uint8Array(),
      date: 1,
      mimeType: 'image/png',
      size: 10n,
      dcId: 2,
      attributes: [Api.DocumentAttributeFilename({ fileName: 'telegram-image.png' })],
    });
    const protectedImageDocument = target.mapMessage(
      Api.Message({
        id: 5,
        peerId: Api.PeerUser({ userId: 1n }),
        date: 1,
        message: '',
        noforwards: true,
        media: Api.MessageMediaDocument({ document: png, spoiler: true }),
      }),
    );
    mapped.push(protectedImageDocument?.media);

    expect(mapped.map((media) => media?.kind)).toEqual([
      'sticker',
      'animation',
      'video',
      'file',
      'file',
    ]);
    expect(mapped[3]?.name).toBe('plain.bin');
    expect(mapped[4]?.name).toBe('telegram-image.png');
    expect(mapped[4]?.cacheKey).toBe('document:5');
    expect(mapped[4]?.spoiler).toBe(true);
    expect(protectedImageDocument?.protected).toBe(true);

    const photo = target.mapMessage(
      Api.Message({
        id: 6,
        peerId: Api.PeerUser({ userId: 1n }),
        date: 1,
        message: '',
        media: Api.MessageMediaPhoto({
          photo: Api.Photo({
            id: 6n,
            accessHash: 2n,
            fileReference: new Uint8Array(),
            date: 1,
            sizes: [],
            dcId: 2,
          }),
        }),
      }),
    )?.media;
    expect(photo).toMatchObject({ kind: 'photo', cacheKey: 'photo:6' });
  });

  it('maps voice notes, round videos, and grouped album ids without losing metadata', () => {
    const target = transport() as unknown as {
      mapMessage(message: Tl.TypeMessage):
        | {
            groupedId?: string;
            media?: {
              kind: string;
              name: string;
              duration?: number;
              width?: number;
              height?: number;
            };
          }
        | undefined;
    };
    const mediaMessage = (
      id: number,
      attribute: Tl.DocumentAttributeAudio | Tl.DocumentAttributeVideo,
      mimeType: string,
    ) =>
      target.mapMessage(
        Api.Message({
          id,
          peerId: Api.PeerUser({ userId: 1n }),
          date: 1,
          message: '',
          groupedId: 9_007_199_254_740_999n,
          media: Api.MessageMediaDocument({
            document: Api.Document({
              id: BigInt(id),
              accessHash: 1n,
              fileReference: new Uint8Array(),
              date: 1,
              mimeType,
              size: 10n,
              dcId: 2,
              attributes: [attribute],
            }),
          }),
        }),
      );

    expect(
      mediaMessage(10, Api.DocumentAttributeAudio({ voice: true, duration: 13 }), 'audio/ogg'),
    ).toMatchObject({
      groupedId: '9007199254740999',
      media: { kind: 'voice', name: 'voice-10.ogg', duration: 13 },
    });
    expect(
      mediaMessage(
        11,
        Api.DocumentAttributeVideo({ roundMessage: true, duration: 7.5, w: 360, h: 640 }),
        'video/mp4',
      ),
    ).toMatchObject({
      media: {
        kind: 'round-video',
        name: 'round-video-11.mp4',
        duration: 7.5,
        width: 360,
        height: 640,
      },
    });
  });

  it('maps Telegram service messages with actor and target details', () => {
    const target = transport() as unknown as {
      entities: Map<string, Tl.TypeUser | Tl.TypeChat>;
      mapMessage(message: Tl.TypeMessage):
        | {
            text: string;
            service?: {
              kind: string;
              actorId?: string;
              targetUserIds?: string[];
              text: string;
            };
          }
        | undefined;
    };
    target.entities.set('u:2', Api.User({ id: 2n, firstName: 'Alice' }));
    target.entities.set('u:3', Api.User({ id: 3n, firstName: 'Bob' }));

    const message = target.mapMessage(
      Api.MessageService({
        id: 20,
        fromId: Api.PeerUser({ userId: 2n }),
        peerId: Api.PeerChat({ chatId: 8n }),
        date: 100,
        action: Api.MessageActionChatAddUser({ users: [3n] }),
      }),
    );

    expect(message).toMatchObject({
      text: 'Alice added Bob',
      service: {
        kind: 'users-added',
        actorId: 'u:2',
        targetUserIds: ['u:3'],
        text: 'Alice added Bob',
      },
    });
  });

  it('maps reactions, mentions, links, formatting, spoilers, replies, and link previews', () => {
    const target = transport() as unknown as {
      mapMessage(message: Tl.TypeMessage):
        | {
            reactions?: unknown[];
            mentions?: unknown[];
            links?: unknown[];
            formats?: unknown[];
            replyToId?: number;
            replyQuote?: string;
            linkPreview?: unknown;
          }
        | undefined;
    };
    const message = Api.Message({
      id: 8,
      peerId: Api.PeerUser({ userId: 1n }),
      date: 100,
      message: '@alice bold secret link',
      entities: [
        Api.MessageEntityMention({ offset: 0, length: 6 }),
        Api.MessageEntityBold({ offset: 7, length: 4 }),
        Api.MessageEntitySpoiler({ offset: 12, length: 6 }),
        Api.MessageEntityTextUrl({ offset: 19, length: 4, url: 'https://example.com' }),
        Api.MessageEntityBlockquote({ offset: 7, length: 4, collapsed: true }),
        Api.MessageEntityCustomEmoji({ offset: 0, length: 2, documentId: 88n }),
        Api.MessageEntityFormattedDate({ offset: 19, length: 4, date: 1_700_000_000 }),
        Api.MessageEntityDiffReplace({ offset: 7, length: 4, oldText: 'cold' }),
      ],

      reactions: Api.MessageReactions({
        results: [
          Api.ReactionCount({
            chosenOrder: 0,
            reaction: Api.ReactionEmoji({ emoticon: '👍' }),
            count: 2,
          }),
          Api.ReactionCount({
            reaction: Api.ReactionCustomEmoji({ documentId: 99n }),
            count: 3,
          }),
        ],
      }),
      replyTo: Api.MessageReplyHeader({ replyToMsgId: 7, quoteText: 'quoted' }),
      media: Api.MessageMediaWebPage({
        forceSmallMedia: true,
        webpage: Api.WebPage({
          id: 1n,
          url: 'https://example.com',
          displayUrl: 'example.com',
          hash: 1,
          siteName: 'Example',
          title: 'Preview title',
          description: 'Preview description',
          photo: Api.Photo({
            id: 2n,
            accessHash: 3n,
            fileReference: new Uint8Array(),
            date: 100,
            sizes: [],
            dcId: 2,
          }),
        }),
      }),
    });

    expect(target.mapMessage(message)).toMatchObject({
      reactions: [
        { emoji: '👍', count: 2, chosen: true },
        { emoji: 'custom:99', customEmojiId: '99', count: 3, chosen: false },
      ],

      mentions: [{ offset: 0, length: 6 }],
      links: [{ offset: 19, length: 4, url: 'https://example.com' }],
      formats: [
        { offset: 7, length: 4, kind: 'bold' },
        { offset: 12, length: 6, kind: 'spoiler' },
        { offset: 7, length: 4, kind: 'expandableBlockquote' },
        { offset: 0, length: 2, kind: 'customEmoji', customEmojiId: '88' },
        { offset: 19, length: 4, kind: 'formattedDate', timestamp: 1_700_000_000 },
        { offset: 7, length: 4, kind: 'diffReplace', oldText: 'cold' },
      ],

      replyToId: 7,
      replyQuote: 'quoted',
      linkPreview: {
        url: 'https://example.com',
        siteName: 'Example',
        title: 'Preview title',
        description: 'Preview description',
        hasPhoto: true,
        photoSize: 'small',
      },
    });
  });

  it('maps forwarded message authors and original channel posts', () => {
    const target = transport() as unknown as {
      entities: Map<string, Tl.TypeUser | Tl.TypeChat>;
      mapMessage(message: Tl.TypeMessage):
        | {
            forwardedFrom?: {
              name: string;
              peerId?: string;
              messageId?: number;
              hasAvatar?: boolean;
              avatarId?: string;
              color?: string;
            };
          }
        | undefined;
    };
    target.entities.set(
      'c:202',
      Api.Channel({
        id: 202n,
        title: 'Release Channel',
        photo: Api.ChatPhoto({ photoId: 77n, dcId: 2 }),
        date: 100,
      }),
    );

    const mapped = target.mapMessage(
      Api.Message({
        id: 18,
        peerId: Api.PeerUser({ userId: 1n }),
        date: 100,
        message: 'Forwarded post',
        fwdFrom: Api.MessageFwdHeader({
          fromId: Api.PeerChannel({ channelId: 202n }),
          channelPost: 17,
          date: 90,
        }),
      }),
    );

    expect(mapped?.forwardedFrom).toEqual({
      name: 'Release Channel',
      peerId: 'c:202',
      messageId: 17,
      hasAvatar: true,
      avatarId: '77',
      color: '#d95574',
    });
  });

  it('maps bot rich messages into safe structured content', () => {
    const target = transport() as unknown as {
      mapMessage(
        message: Tl.TypeMessage,
      ): { richMessage?: { rtl?: boolean; blocks: Array<Record<string, unknown>> } } | undefined;
    };
    const richMessage = Api.RichMessage({
      rtl: true,
      blocks: [
        Api.PageBlockHeading1({ text: Api.TextPlain({ text: 'Release notes' }) }),
        Api.PageBlockParagraph({
          text: Api.TextConcat({
            texts: [
              Api.TextBold({ text: Api.TextPlain({ text: 'Rich Markdown' }) }),
              Api.TextPlain({ text: ' with ' }),
              Api.TextMarked({ text: Api.TextPlain({ text: 'highlighting' }) }),
              Api.TextCustomEmoji({ documentId: 55n, alt: '👍' }),
            ],
          }),
        }),
        Api.PageBlockList({
          items: [
            Api.PageListItemText({
              checkbox: true,
              checked: true,
              text: Api.TextPlain({ text: 'Task done' }),
            }),
          ],
        }),
        Api.PageBlockBlockquoteBlocks({
          blocks: [Api.PageBlockParagraph({ text: Api.TextPlain({ text: 'Hidden quote' }) })],

          caption: Api.TextPlain({ text: 'Source' }),
        }),
        Api.PageBlockTable({
          bordered: true,
          title: Api.TextPlain({ text: 'Numbers' }),
          rows: [
            Api.PageTableRow({
              cells: [
                Api.PageTableCell({
                  header: true,
                  text: Api.TextPlain({ text: 'Value' }),
                }),
              ],
            }),
          ],
        }),
      ],

      photos: [],
      documents: [],
    });

    expect(
      target.mapMessage(
        Api.Message({
          id: 9,
          peerId: Api.PeerUser({ userId: 1n }),
          date: 100,
          message: '',
          richMessage,
        }),
      ),
    ).toMatchObject({
      richMessage: {
        rtl: true,
        blocks: [
          { kind: 'heading', level: 1, text: { kind: 'text', text: 'Release notes' } },
          {
            kind: 'text',
            role: 'paragraph',
            text: {
              kind: 'concat',
              children: [
                { kind: 'bold', child: { kind: 'text', text: 'Rich Markdown' } },
                { kind: 'text', text: ' with ' },
                { kind: 'marked', child: { kind: 'text', text: 'highlighting' } },
                { kind: 'customEmoji', documentId: '55', alt: '👍' },
              ],
            },
          },
          {
            kind: 'list',
            ordered: false,
            items: [{ checkbox: true, checked: true, text: { kind: 'text', text: 'Task done' } }],
          },
          {
            kind: 'quote',
            expandable: true,
            caption: { kind: 'text', text: 'Source' },
          },
          {
            kind: 'table',
            bordered: true,
            title: { kind: 'text', text: 'Numbers' },
            rows: [[{ header: true, text: { kind: 'text', text: 'Value' } }]],
          },
        ],
      },
    });
  });

  it('hides pending and absent webpage previews like Telegram Desktop', () => {
    const target = transport() as unknown as {
      mapMessage(message: Tl.TypeMessage): { linkPreview?: unknown } | undefined;
    };
    const peerId = Api.PeerUser({ userId: 1n });
    const pending = target.mapMessage(
      Api.Message({
        id: 9,
        peerId,
        date: 100,
        message: 'https://www.reddit.com/r/example',
        media: Api.MessageMediaWebPage({
          webpage: Api.WebPagePending({
            id: 4n,
            url: 'https://www.reddit.com/r/example',
            date: 100,
          }),
        }),
      }),
    );
    const absent = target.mapMessage(
      Api.Message({
        id: 10,
        peerId,
        date: 100,
        message: 'Read https://example.org/path now',
      }),
    );
    const empty = target.mapMessage(
      Api.Message({
        id: 11,
        peerId,
        date: 100,
        message: 'https://www.instagram.com/p/example',
        media: Api.MessageMediaWebPage({
          webpage: Api.WebPageEmpty({
            id: 5n,
            url: 'https://www.instagram.com/p/example',
          }),
        }),
      }),
    );

    expect(pending?.linkPreview).toBeUndefined();
    expect(absent?.linkPreview).toBeUndefined();
    expect(empty?.linkPreview).toBeUndefined();
  });

  it('uses Telegram reaction RPCs for choosing and clearing an emoji', async () => {
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(Api.UpdatesTooLong());
    (target as unknown as TransportInternals).client = { invoke };

    const peer = { id: 'u:11', kind: 'user' as const, accessHash: '91' };
    await target.setReaction(peer, 7, '🔥');
    await target.setReaction(peer, 7, 'custom:99');
    await target.setReaction(peer, 7);

    expect(Api.messages.SendReaction.is(invoke.mock.calls[0]?.[0])).toBe(true);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      msgId: 7,
      reaction: [expect.objectContaining({ emoticon: '🔥' })],
    });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      msgId: 7,
      reaction: [expect.objectContaining({ documentId: 99n })],
    });
    expect(invoke.mock.calls[2]?.[0]).toMatchObject({ msgId: 7, reaction: [] });
  });

  it('downloads a custom emoji document with its Telegram MIME type', async () => {
    const document = Api.Document({
      id: 99n,
      accessHash: 1n,
      fileReference: new Uint8Array(),
      date: 1,
      mimeType: 'video/webm',
      size: 3n,
      dcId: 2,
      attributes: [],
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue([document]);
    const downloadMedia = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    (target as unknown as TransportInternals).client = { invoke, downloadMedia };

    const blob = await target.downloadCustomEmoji('99');

    expect(blob.type).toBe('video/webm');
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ documentId: [99n] });
    expect(downloadMedia).toHaveBeenCalledWith(document, { workers: 1 });
  });

  it('loads and downloads recent Telegram stickers', async () => {
    const document = Api.Document({
      id: 31n,
      accessHash: 32n,
      fileReference: new Uint8Array([3]),
      date: 1,
      mimeType: 'image/webp',
      size: 3n,
      dcId: 2,
      attributes: [
        Api.DocumentAttributeSticker({
          alt: '🎉',
          stickerset: Api.InputStickerSetEmpty(),
        }),
      ],
    });
    const result = Api.messages.RecentStickers({
      hash: 1n,
      packs: [],
      stickers: [document],
      dates: [1],
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    const downloadMedia = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    (target as unknown as TransportInternals).client = { invoke, downloadMedia };

    const stickers = await target.getRecentStickers();
    expect(stickers).toEqual([
      expect.objectContaining({ id: '31', accessHash: '32', emoji: '🎉', mimeType: 'image/webp' }),
    ]);
    await expect(target.downloadSticker(stickers[0]!)).resolves.toMatchObject({
      size: 3,
      type: 'image/webp',
    });
    expect(downloadMedia).toHaveBeenCalledWith(document, { workers: 1 });
  });

  it('loads every installed sticker set as a named pack', async () => {
    const set = Api.StickerSet({
      id: 41n,
      accessHash: 42n,
      title: 'Installed pack',
      shortName: 'installed_pack',
      count: 1,
      hash: 1,
    });
    const document = Api.Document({
      id: 43n,
      accessHash: 44n,
      fileReference: new Uint8Array([4]),
      date: 1,
      mimeType: 'image/webp',
      size: 3n,
      dcId: 2,
      attributes: [
        Api.DocumentAttributeSticker({
          alt: '🐈',
          stickerset: Api.InputStickerSetID({ id: set.id, accessHash: set.accessHash }),
        }),
      ],
    });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(Api.messages.AllStickers({ hash: 1n, sets: [set] }))
      .mockResolvedValueOnce(
        Api.messages.StickerSet({ set, packs: [], keywords: [], documents: [document] }),
      );
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.getStickerPacks()).resolves.toEqual([
      {
        id: '41',
        title: 'Installed pack',
        stickers: [expect.objectContaining({ id: '43', emoji: '🐈' })],
      },
    ]);
    expect(Api.messages.GetAllStickers.is(invoke.mock.calls[0]?.[0])).toBe(true);
    expect(Api.messages.GetStickerSet.is(invoke.mock.calls[1]?.[0])).toBe(true);
  });

  it('limits concurrent installed sticker-set requests', async () => {
    const sets = Array.from({ length: 9 }, (_, index) =>
      Api.StickerSet({
        id: BigInt(index + 1),
        accessHash: BigInt(index + 101),
        title: `Pack ${index + 1}`,
        shortName: `pack_${index + 1}`,
        count: 0,
        hash: 1,
      }),
    );
    let active = 0;
    let maximumActive = 0;
    const invoke = vi.fn(async (request: unknown) => {
      if (Api.messages.GetAllStickers.is(request)) {
        return Api.messages.AllStickers({ hash: 1n, sets });
      }
      const stickerRequest = request as Tl.messages.GetStickerSet;
      const input = stickerRequest.stickerset as Tl.InputStickerSetID;
      const set = sets.find(({ id }) => id === input.id)!;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return Api.messages.StickerSet({ set, packs: [], keywords: [], documents: [] });
    });
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke };

    await target.getStickerPacks();

    expect(maximumActive).toBe(4);
    expect(invoke).toHaveBeenCalledTimes(10);
  });

  it('keeps usable installed sticker packs when another set fails to load', async () => {
    const failedSet = Api.StickerSet({
      id: 61n,
      accessHash: 62n,
      title: 'Unavailable pack',
      shortName: 'unavailable_pack',
      count: 1,
      hash: 1,
    });
    const usableSet = Api.StickerSet({
      id: 71n,
      accessHash: 72n,
      title: 'Usable pack',
      shortName: 'usable_pack',
      count: 1,
      hash: 1,
    });
    const document = Api.Document({
      id: 73n,
      accessHash: 74n,
      fileReference: new Uint8Array([7]),
      date: 1,
      mimeType: 'image/webp',
      size: 3n,
      dcId: 2,
      attributes: [
        Api.DocumentAttributeSticker({
          alt: '🙂',
          stickerset: Api.InputStickerSetID({
            id: usableSet.id,
            accessHash: usableSet.accessHash,
          }),
        }),
      ],
    });
    const invoke = vi.fn(async (request: unknown) => {
      if (Api.messages.GetAllStickers.is(request)) {
        return Api.messages.AllStickers({ hash: 1n, sets: [failedSet, usableSet] });
      }
      const input = (request as Tl.messages.GetStickerSet).stickerset as Tl.InputStickerSetID;
      if (input.id === failedSet.id) throw new Error('pack unavailable');
      return Api.messages.StickerSet({
        set: usableSet,
        packs: [],
        keywords: [],
        documents: [document],
      });
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.getStickerPacks()).resolves.toEqual([
      {
        id: '71',
        title: 'Usable pack',
        stickers: [expect.objectContaining({ id: '73' })],
      },
    ]);
    expect(warning).toHaveBeenCalledWith(
      '[televecha]',
      expect.objectContaining({
        message: 'Could not load the installed sticker pack Unavailable pack.',
      }),
    );
    warning.mockRestore();
  });

  it('loads saved GIF documents for the GIF picker', async () => {
    const document = Api.Document({
      id: 51n,
      accessHash: 52n,
      fileReference: new Uint8Array([5]),
      date: 1,
      mimeType: 'video/mp4',
      size: 10n,
      dcId: 2,
      attributes: [Api.DocumentAttributeAnimated()],
    });
    const target = transport();
    const invoke = vi
      .fn()
      .mockResolvedValue(Api.messages.SavedGifs({ hash: 1n, gifs: [document] }));
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.getSavedGifs()).resolves.toEqual([
      expect.objectContaining({ id: '51', accessHash: '52', emoji: 'GIF', mimeType: 'video/mp4' }),
    ]);
    expect(Api.messages.GetSavedGifs.is(invoke.mock.calls[0]?.[0])).toBe(true);
  });

  it('creates the correct input-peer type and preserves access hashes', () => {
    const target = transport() as unknown as TransportInternals;
    const user = target.inputPeer({ id: 'u:11', kind: 'user', accessHash: '91' });
    const group = target.inputPeer({ id: 'g:12', kind: 'group' });
    const channel = target.inputPeer({ id: 'c:13', kind: 'channel', accessHash: '93' });

    expect(Api.InputPeerUser.is(user)).toBe(true);
    expect(user).toMatchObject({ userId: 11n, accessHash: 91n });
    expect(Api.InputPeerChat.is(group)).toBe(true);
    expect(group).toMatchObject({ chatId: 12n });
    expect(Api.InputPeerChannel.is(channel)).toBe(true);
    expect(channel).toMatchObject({ channelId: 13n, accessHash: 93n });
  });

  it('maps a Telegram too-long envelope to an explicit resynchronization signal', () => {
    const target = transport() as unknown as TransportInternals;
    expect(mappedUpdates(target, Api.UpdatesTooLong())).toEqual([{ type: 'too-long' }]);
  });

  it('uses the global difference limit and rejects an oversized final difference', async () => {
    const finalDifference = Api.updates.Difference({
      newMessages: [],
      newEncryptedMessages: [],
      otherUpdates: [
        Api.UpdateDeleteMessages({ messages: [1], pts: 11, ptsCount: 1 }),
        Api.UpdateDeleteMessages({ messages: [2], pts: 12, ptsCount: 1 }),
      ],

      chats: [],
      users: [],
      state: Api.updates.State({ pts: 12, qts: 2, date: 20, seq: 3, unreadCount: 0 }),
    });
    const latestState = Api.updates.State({
      pts: 15,
      qts: 2,
      date: 21,
      seq: 4,
      unreadCount: 0,
    });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(finalDifference)
      .mockResolvedValueOnce(latestState);
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.getDifference({ pts: 10, qts: 2, date: 19, seq: 2 }, 1)).resolves.toEqual({
      type: 'too-long',
      cursor: { pts: 15, qts: 2, date: 21, seq: 4 },
    });
    expect(Api.updates.GetDifference.is(invoke.mock.calls[0]?.[0])).toBe(true);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      pts: 10,
      ptsLimit: 1,
      ptsTotalLimit: 1,
      qtsLimit: 1,
    });
    expect(Api.updates.GetState.is(invoke.mock.calls[1]?.[0])).toBe(true);
  });

  it('paginates channel differences from the supplied channel PTS', async () => {
    const firstMessage = Api.Message({
      id: 21,
      peerId: Api.PeerChannel({ channelId: 12n }),
      date: 100,
      message: 'Recovered one',
    });
    const secondMessage = Api.Message({
      id: 22,
      peerId: Api.PeerChannel({ channelId: 12n }),
      date: 101,
      message: 'Recovered two',
    });
    const channel = Api.Channel({
      id: 12n,
      accessHash: 92n,
      title: 'Channel',
      photo: Api.ChatPhotoEmpty(),
      date: 1,
    });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(
        Api.updates.ChannelDifference({
          pts: 12,
          newMessages: [firstMessage],
          otherUpdates: [],
          chats: [channel],
          users: [],
        }),
      )
      .mockResolvedValueOnce(
        Api.updates.ChannelDifference({
          final: true,
          pts: 13,
          newMessages: [secondMessage],
          otherUpdates: [
            Api.UpdateReadChannelInbox({
              channelId: 12n,
              maxId: 22,
              stillUnreadCount: 3,
              pts: 13,
            }),
          ],

          chats: [channel],
          users: [],
        }),
      );
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.getChannelDifference({ id: 'c:12', kind: 'channel', accessHash: '92' }, 10, 100),
    ).resolves.toMatchObject({
      type: 'complete',
      pts: 13,
      updates: [
        { type: 'new-message', channelScoped: true, message: { id: 21 } },
        { type: 'new-message', channelScoped: true, message: { id: 22 } },
        {
          type: 'read-history',
          channelScoped: true,
          peerId: 'c:12',
          stillUnreadCount: 3,
        },
      ],
    });
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      force: true,
      channel: expect.objectContaining({ channelId: 12n, accessHash: 92n }),
      filter: anyTl(Api.ChannelMessagesFilterEmpty),
      pts: 10,
      limit: 100,
    });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ pts: 12, limit: 99 });
  });

  it('returns the authoritative PTS when a channel difference is too long', async () => {
    const result = Api.updates.ChannelDifferenceTooLong({
      final: true,
      dialog: Api.Dialog({
        peer: Api.PeerChannel({ channelId: 12n }),
        topMessage: 50,
        readInboxMaxId: 40,
        readOutboxMaxId: 42,
        unreadCount: 10,
        unreadMentionsCount: 0,
        unreadReactionsCount: 0,
        unreadPollVotesCount: 0,
        notifySettings: Api.PeerNotifySettings(),
        pts: 77,
      }),
      messages: [],
      chats: [],
      users: [],
    });
    const target = transport();
    (target as unknown as TransportInternals).client = {
      invoke: vi.fn().mockResolvedValue(result),
    };

    await expect(
      target.getChannelDifference({ id: 'c:12', kind: 'channel', accessHash: '92' }, 10, 100),
    ).resolves.toEqual({ type: 'too-long', pts: 77 });
  });

  it('remembers access hashes delivered with update envelopes', () => {
    const target = transport() as unknown as TransportInternals;
    mappedUpdates(
      target,
      Api.Updates({
        updates: [],
        users: [
          Api.User({
            id: 11n,
            accessHash: 1234n,
            firstName: 'Updated user',
          }),
        ],

        chats: [],
        date: 100,
        seq: 1,
      }),
    );

    expect(target.inputPeer({ id: 'u:11', kind: 'user' })).toMatchObject({
      userId: 11n,
      accessHash: 1234n,
    });
  });

  it('maps a remembered sender name onto group messages', () => {
    const target = transport() as unknown as TransportInternals;

    const updates = mappedUpdates(
      target,
      Api.Updates({
        updates: [
          Api.UpdateNewMessage({
            message: Api.Message({
              id: 9,
              fromId: Api.PeerUser({ userId: 404n }),
              peerId: Api.PeerChat({ chatId: 303n }),
              date: 100,
              message: 'From a named author',
            }),
            pts: 4,
            ptsCount: 1,
          }),
        ],

        users: [
          Api.User({
            id: 404n,
            accessHash: 1404n,
            firstName: 'Dana',
            lastName: 'Author',
          }),
        ],

        chats: [],
        date: 100,
        seq: 1,
      }),
    );

    expect(updates).toEqual([
      expect.objectContaining({
        type: 'new-message',
        message: expect.objectContaining({ senderId: 'u:404', senderName: 'Dana Author' }),
      }),
    ]);
  });

  it('maps channel author avatars and administrator roles', async () => {
    const author = Api.User({
      id: 404n,
      accessHash: 1404n,
      firstName: 'Dana',
      photo: Api.UserProfilePhoto({ photoId: 900n, dcId: 2 }),
    });
    const history = Api.messages.Messages({
      messages: [
        Api.Message({
          id: 9,
          fromId: Api.PeerUser({ userId: 404n }),
          peerId: Api.PeerChannel({ channelId: 303n }),
          date: 100,
          message: 'Channel post',
          postAuthor: 'editor-in-chief',
        }),
      ],

      topics: [],
      users: [author],
      chats: [],
    });
    const administrators = Api.channels.ChannelParticipants({
      count: 1,
      participants: [
        Api.ChannelParticipantCreator({
          userId: 404n,
          adminRights: Api.ChatAdminRights({}),
          rank: 'server-role',
        }),
      ],

      users: [author],
      chats: [],
    });
    const invoke = vi.fn((request: unknown) =>
      Promise.resolve(Api.channels.GetParticipants.is(request) ? administrators : history),
    );
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke };

    const page = await target.getHistory({ id: 'c:303', kind: 'channel', accessHash: '1303' }, 50);

    expect(page.messages[0]).toMatchObject({
      senderId: 'u:404',
      senderName: 'Dana',
      senderHasAvatar: true,
      senderAvatarId: '900',
      senderRole: 'editor-in-chief',
      senderRoleKind: 'owner',
    });
    expect(Api.channels.GetParticipants.is(invoke.mock.calls[1]?.[0])).toBe(true);
  });

  it('returns channel history when optional administrator enrichment does not answer', async () => {
    const author = Api.User({
      id: 405n,
      accessHash: 1405n,
      firstName: 'Unblocked',
    });
    const history = Api.messages.Messages({
      messages: [
        Api.Message({
          id: 10,
          fromId: Api.PeerUser({ userId: 405n }),
          peerId: Api.PeerChannel({ channelId: 304n }),
          date: 101,
          message: 'History before roles',
        }),
      ],
      topics: [],
      users: [author],
      chats: [],
    });
    const administrators = deferred<Tl.channels.ChannelParticipants>();
    const invoke = vi.fn((request: unknown) => {
      if (Api.channels.GetParticipants.is(request)) return administrators.promise;
      if (Api.messages.GetHistory.is(request)) return Promise.resolve(history);
      throw new Error('Unexpected history request');
    });
    const target = transport({ optionalEnrichmentDeadlineMs: 0 });
    const internals = target as unknown as TransportInternals;
    internals.client = { invoke };

    await expect(
      target.getHistory({ id: 'c:304', kind: 'channel', accessHash: '1304' }, 50),
    ).resolves.toMatchObject({
      messages: [
        expect.objectContaining({
          senderId: 'u:405',
          senderName: 'Unblocked',
          text: 'History before roles',
        }),
      ],
    });
    const loading = internals.channelRolesLoading.get('c:304');
    expect(loading).toBeDefined();
    administrators.resolve(
      Api.channels.ChannelParticipants({
        count: 0,
        participants: [],
        users: [],
        chats: [],
      }),
    );
    await loading;
  });

  it('requests bounded history before the oldest id and maps the returned messages', async () => {
    const result = Api.messages.Messages({
      messages: [
        Api.Message({
          id: 7,
          peerId: Api.PeerUser({ userId: 11n }),
          date: 100,
          message: 'History item',
        }),
        Api.Message({
          id: 6,
          peerId: Api.PeerUser({ userId: 11n }),
          date: 99,
          message: 'Lookahead item',
        }),
      ],

      topics: [],
      chats: [],
      users: [],
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    (target as unknown as TransportInternals).client = { invoke };

    const page = await target.getHistory({ id: 'u:11', kind: 'user', accessHash: '91' }, 1, 8);
    expect(page).toMatchObject({
      messages: [expect.objectContaining({ id: 7, peerId: 'u:11', text: 'History item' })],
      hasOlder: true,
      nextBeforeMessageId: 7,
    });
    expect(Api.messages.GetHistory.is(invoke.mock.calls[0]?.[0])).toBe(true);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ offsetId: 8, limit: 2 });
  });

  it('does not treat a full 50-message slice as the end of a 1,000-message history', async () => {
    const result = Api.messages.MessagesSlice({
      count: 1_000,
      messages: Array.from({ length: 50 }, (_, index) =>
        Api.Message({
          id: 1_000 - index,
          peerId: Api.PeerUser({ userId: 11n }),
          date: 2_000 - index,
          message: `History item ${1_000 - index}`,
        }),
      ),
      topics: [],
      chats: [],
      users: [],
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    (target as unknown as TransportInternals).client = { invoke };

    const page = await target.getHistory({ id: 'u:11', kind: 'user', accessHash: '91' }, 50);

    expect(page.messages).toHaveLength(50);
    expect(page.hasOlder).toBe(true);
  });

  it('keeps paging when Telegram returns 50 messages without a total count', async () => {
    const result = Api.messages.Messages({
      messages: Array.from({ length: 50 }, (_, index) =>
        Api.Message({
          id: 1_000 - index,
          peerId: Api.PeerUser({ userId: 11n }),
          date: 2_000 - index,
          message: `History item ${1_000 - index}`,
        }),
      ),
      topics: [],
      chats: [],
      users: [],
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    (target as unknown as TransportInternals).client = { invoke };

    const page = await target.getHistory({ id: 'u:11', kind: 'user', accessHash: '91' }, 50);

    expect(page.messages).toHaveLength(50);
    expect(page.hasOlder).toBe(true);
  });

  it('ends history pagination only after Telegram returns an empty page', async () => {
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(
      Api.messages.Messages({
        messages: [],
        topics: [],
        chats: [],
        users: [],
      }),
    );
    (target as unknown as TransportInternals).client = { invoke };

    const page = await target.getHistory({ id: 'u:11', kind: 'user', accessHash: '91' }, 50, 951);

    expect(page).toMatchObject({ messages: [], hasOlder: false });
  });

  it('uses channel and non-channel read-history RPCs correctly', async () => {
    const target = transport();
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(Api.messages.AffectedMessages({ pts: 21, ptsCount: 1 }))
      .mockResolvedValueOnce(true);
    (target as unknown as TransportInternals).client = { invoke };

    const result = await target.readHistory({ id: 'u:11', kind: 'user', accessHash: '91' }, 7);
    await target.readHistory({ id: 'c:12', kind: 'channel', accessHash: '92' }, 8);
    expect(result.updateBatches).toEqual([
      {
        updates: [
          {
            type: 'read-history',
            pts: 21,
            ptsCount: 1,
            peerId: 'u:11',
            maxMessageId: 7,
            direction: 'inbox',
          },
        ],
      },
    ]);
    expect(Api.messages.ReadHistory.is(invoke.mock.calls[0]?.[0])).toBe(true);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ maxId: 7 });
    expect(Api.channels.ReadHistory.is(invoke.mock.calls[1]?.[0])).toBe(true);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ maxId: 8 });
  });

  it('refreshes one peer read receipt without reloading dialogs or history', async () => {
    const peer = Api.PeerUser({ userId: 11n });
    const result = Api.messages.PeerDialogs({
      dialogs: [
        Api.Dialog({
          peer,
          topMessage: 80,
          readInboxMaxId: 79,
          readOutboxMaxId: 80,
          unreadCount: 0,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          notifySettings: Api.PeerNotifySettings(),
        }),
      ],

      messages: [],
      chats: [],
      users: [],
      state: Api.updates.State({ pts: 1, qts: 1, date: 1, seq: 1, unreadCount: 0 }),
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.getReadOutboxMaxId({ id: 'u:11', kind: 'user', accessHash: '91' }),
    ).resolves.toBe(80);
    expect(invoke).toHaveBeenCalledOnce();
    expect(Api.messages.GetPeerDialogs.is(invoke.mock.calls[0]?.[0])).toBe(true);
  });

  it('requests all Telegram Desktop shared-content counters in one RPC', async () => {
    const target = transport();
    const filters = [
      Api.InputMessagesFilterPhotos(),
      Api.InputMessagesFilterVideo(),
      Api.InputMessagesFilterDocument(),
      Api.InputMessagesFilterMusic(),
      Api.InputMessagesFilterUrl(),
      Api.InputMessagesFilterRoundVoice(),
      Api.InputMessagesFilterGif(),
    ];

    const invoke = vi
      .fn()
      .mockResolvedValue(
        filters.map((filter, index) => Api.messages.SearchCounter({ filter, count: index + 1 })),
      );
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.getSharedMediaCounts({ id: 'u:11', kind: 'user', accessHash: '91' }),
    ).resolves.toEqual({ photos: 1, videos: 2, files: 3, audio: 4, links: 5, voice: 6, gifs: 7 });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      filters: [
        anyTl(Api.InputMessagesFilterPhotos),
        anyTl(Api.InputMessagesFilterVideo),
        anyTl(Api.InputMessagesFilterDocument),
        anyTl(Api.InputMessagesFilterMusic),
        anyTl(Api.InputMessagesFilterUrl),
        anyTl(Api.InputMessagesFilterRoundVoice),
        anyTl(Api.InputMessagesFilterGif),
      ],
    });
  });

  it.each([
    ['photos', Api.InputMessagesFilterPhotos],
    ['videos', Api.InputMessagesFilterVideo],
    ['files', Api.InputMessagesFilterDocument],
    ['audio', Api.InputMessagesFilterMusic],
    ['links', Api.InputMessagesFilterUrl],
    ['voice', Api.InputMessagesFilterRoundVoice],
    ['gifs', Api.InputMessagesFilterGif],
  ] as const)('uses the Telegram %s filter when loading shared content', async (kind, Filter) => {
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(
      Api.messages.Messages({
        messages: [],
        topics: [],
        chats: [],
        users: [],
      }),
    );
    (target as unknown as TransportInternals).client = { invoke };

    await target.getSharedMedia({ id: 'u:11', kind: 'user', accessHash: '91' }, kind, 20);

    expect(Filter.is((invoke.mock.calls[0]?.[0] as { filter?: unknown })?.filter)).toBe(true);
  });

  it('uses Telegram RPCs for search, shared content, pins, mute, and typing', async () => {
    const message = Api.Message({
      id: 14,
      peerId: Api.PeerUser({ userId: 11n }),
      date: 100,
      message: 'Search result',
    });
    const result = Api.messages.Messages({
      messages: [message],
      topics: [],
      chats: [],
      users: [],
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    (target as unknown as TransportInternals).client = { invoke };
    const peer = { id: 'u:11', kind: 'user' as const, accessHash: '91' };

    await expect(target.searchMessages('Search', peer)).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: 14 })],
    });
    await expect(target.searchMessages('Search')).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: 14 })],
    });
    await expect(target.getSharedMedia(peer, 'links', 20)).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: 14 })],
      hasMore: false,
    });
    await expect(target.getPinnedMessages(peer)).resolves.toHaveLength(1);
    await target.setMuted(peer, true);
    await target.setPinnedMessage(peer, 14, true);
    await target.setTyping(peer, 'typing');
    await target.setTyping(peer);

    const requests = invoke.mock.calls.map(([request]) => request);
    expect(Api.messages.Search.is(requests[0])).toBe(true);
    expect(Api.messages.SearchGlobal.is(requests[1])).toBe(true);
    expect(requests[2]).toMatchObject({ filter: anyTl(Api.InputMessagesFilterUrl) });
    expect(requests[3]).toMatchObject({ filter: anyTl(Api.InputMessagesFilterPinned) });
    expect(Api.account.UpdateNotifySettings.is(requests[4])).toBe(true);
    expect(Api.messages.UpdatePinnedMessage.is(requests[5])).toBe(true);
    expect(requests[6]).toMatchObject({ action: anyTl(Api.SendMessageTypingAction) });
    expect(requests[7]).toMatchObject({ action: anyTl(Api.SendMessageCancelAction) });
  });

  it('passes search offsets through and reports another page from the probe result', async () => {
    const result = Api.messages.MessagesSlice({
      count: 10,
      nextRate: 8,
      messages: [30, 29, 28].map((id) =>
        Api.Message({
          id,
          peerId: Api.PeerUser({ userId: 11n }),
          date: id,
          message: `Result ${id}`,
        }),
      ),
      topics: [],
      chats: [],
      users: [Api.User({ id: 11n, accessHash: 91n, firstName: 'Result user' })],
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    (target as unknown as TransportInternals).client = { invoke };
    const peer = { id: 'u:11', kind: 'user' as const, accessHash: '91' };

    await expect(
      target.getSharedMedia(peer, 'photos', 2, { messageId: 31 }),
    ).resolves.toMatchObject({
      messages: [{ id: 30 }, { id: 29 }],
      hasMore: true,
      nextOffset: { messageId: 29 },
    });
    await expect(
      target.searchMessages('result', peer, 2, { messageId: 30 }),
    ).resolves.toMatchObject({
      messages: [{ id: 30 }, { id: 29 }],
      hasMore: true,
      nextOffset: { messageId: 29 },
    });
    await expect(
      target.searchMessages('result', undefined, 2, {
        messageId: 29,
        peer,
        rate: 7,
      }),
    ).resolves.toMatchObject({
      messages: [{ id: 30 }, { id: 29 }],
      hasMore: true,
      nextOffset: { messageId: 29, peer, rate: 8 },
    });

    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ offsetId: 31, limit: 3 });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ offsetId: 30, limit: 3 });
    expect(invoke.mock.calls[2]?.[0]).toMatchObject({
      offsetId: 29,
      offsetPeer: expect.objectContaining({ userId: 11n, accessHash: 91n }),
      offsetRate: 7,
      limit: 2,
    });
  });

  it('uses Telegram RPCs for user details, contacts, block, dialog pin, and private-chat deletion', async () => {
    const details = Api.users.UserFull({
      fullUser: Api.UserFull({
        id: 11n,
        about: 'Profile bio',
        blocked: true,
        birthday: Api.Birthday({ day: 14, month: 3, year: 1994 }),
        settings: Api.PeerSettings(),
        notifySettings: Api.PeerNotifySettings(),
        commonChatsCount: 0,
      }),
      chats: [],
      users: [
        Api.User({
          id: 11n,
          accessHash: 91n,
          firstName: 'Mira',
          lastName: 'Lane',
          phone: '15550102048',
          username: 'mira',
          contact: true,
        }),
      ],
    });
    const affected = Api.messages.AffectedHistory({ pts: 1, ptsCount: 1, offset: 0 });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(details)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(affected);
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke };
    const peer = { id: 'u:11', kind: 'user' as const, accessHash: '91' };

    await expect(target.getUserDetails(peer)).resolves.toEqual({
      firstName: 'Mira',
      lastName: 'Lane',
      phone: '15550102048',
      username: 'mira',
      bio: 'Profile bio',
      birthday: { day: 14, month: 3, year: 1994 },
      isContact: true,
      blocked: true,
    });
    await target.updateContact(peer, 'Mira', 'Lane', '15550102048');
    await target.deleteContact(peer);
    await target.setBlocked(peer, false);
    await target.setPinnedDialog(peer, true);
    const deletion = await target.deleteDialog(peer);

    expect(deletion.updateBatches).toEqual([
      { updates: [{ type: 'pts-advanced', pts: 1, ptsCount: 1 }] },
    ]);

    const requests = invoke.mock.calls.map(([request]) => request);
    expect(Api.users.GetFullUser.is(requests[0])).toBe(true);
    expect(requests[1]).toMatchObject({
      id: anyTl(Api.InputUser),
      firstName: 'Mira',
      lastName: 'Lane',
      phone: '15550102048',
    });
    expect(Api.contacts.AddContact.is(requests[1])).toBe(true);
    expect(Api.contacts.DeleteContacts.is(requests[2])).toBe(true);
    expect(Api.contacts.Unblock.is(requests[3])).toBe(true);
    expect(requests[4]).toMatchObject({
      pinned: true,
      peer: anyTl(Api.InputDialogPeer),
    });
    expect(Api.messages.DeleteHistory.is(requests[5])).toBe(true);
  });

  it('maps typing and pinned-message updates', () => {
    const target = transport() as unknown as TransportInternals;
    expect(
      mappedUpdates(
        target,
        Api.UpdateUserTyping({
          userId: 11n,
          action: Api.SendMessageUploadPhotoAction({ progress: 50 }),
        }),
      ),
    ).toEqual([
      {
        type: 'activity',
        activity: { peerId: 'u:11', senderId: 'u:11', kind: 'uploading' },
      },
    ]);
    expect(
      mappedUpdates(
        target,
        Api.UpdatePinnedChannelMessages({
          pinned: true,
          channelId: 12n,
          messages: [15],
          pts: 3,
          ptsCount: 1,
        }),
      ),
    ).toEqual([
      {
        type: 'pinned-messages',
        pts: 3,
        ptsCount: 1,
        channelScoped: true,
        peerId: 'c:12',
        messageIds: [15],
        pinned: true,
      },
    ]);
    expect(
      mappedUpdates(
        target,
        Api.UpdatePinnedMessages({
          pinned: true,
          peer: Api.PeerUser({ userId: 11n }),
          messages: [14],
          pts: 2,
          ptsCount: 1,
        }),
      ),
    ).toEqual([
      {
        type: 'pinned-messages',
        pts: 2,
        ptsCount: 1,
        peerId: 'u:11',
        messageIds: [14],
        pinned: true,
      },
    ]);
    expect(
      mappedUpdates(
        target,
        Api.UpdateUserTyping({
          userId: 11n,
          action: Api.SendMessageCancelAction(),
        }),
      ),
    ).toEqual([{ type: 'activity-ended', peerId: 'u:11', senderId: 'u:11' }]);
    expect(
      mappedUpdates(
        target,
        Api.UpdateUserStatus({
          userId: 11n,
          status: Api.UserStatusOnline({ expires: Math.floor(Date.now() / 1000) + 60 }),
        }),
      ),
    ).toEqual([{ type: 'presence-changed', peerId: 'u:11', presence: 'online' }]);
    expect(
      mappedUpdates(
        target,
        Api.UpdateUserStatus({
          userId: 11n,
          status: Api.UserStatusOffline({ wasOnline: 123 }),
        }),
      ),
    ).toEqual([{ type: 'presence-changed', peerId: 'u:11', presence: 'offline', lastSeenAt: 123 }]);
    expect(
      mappedUpdates(
        target,
        Api.UpdateNotifySettings({
          peer: Api.NotifyPeer({ peer: Api.PeerUser({ userId: 11n }) }),
          notifySettings: Api.PeerNotifySettings({ muteUntil: 2_147_483_647 }),
        }),
      ),
    ).toEqual([{ type: 'mute-changed', peerId: 'u:11', muted: true }]);
  });

  it('propagates channel and group leave update envelopes', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(Api.Updates({ updates: [], users: [], chats: [], date: 120, seq: 4 }))
      .mockResolvedValueOnce(Api.Updates({ updates: [], users: [], chats: [], date: 121, seq: 5 }));
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.deleteDialog({ id: 'c:12', kind: 'channel', accessHash: '92' }),
    ).resolves.toEqual({ updateBatches: [{ updates: [], date: 120, seq: 4 }] });
    await expect(target.deleteDialog({ id: 'g:13', kind: 'group' })).resolves.toEqual({
      updateBatches: [{ updates: [], date: 121, seq: 5 }],
    });
    expect(Api.channels.LeaveChannel.is(invoke.mock.calls[0]?.[0])).toBe(true);
    expect(Api.messages.DeleteChatUser.is(invoke.mock.calls[1]?.[0])).toBe(true);
  });

  it('returns the exact sent message from Telegram updates with the caller random id', async () => {
    const message = Api.Message({
      id: 21,
      out: true,
      fromId: Api.PeerUser({ userId: 11n }),
      peerId: Api.PeerUser({ userId: 11n }),
      date: 100,
      message: 'Sent text',
    });
    const result = Api.Updates({
      updates: [
        Api.UpdateMessageID({ id: 21, randomId: 123n }),
        Api.UpdateNewMessage({ message, pts: 2, ptsCount: 1 }),
      ],

      users: [],
      chats: [],
      date: 100,
      seq: 1,
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.sendText(
        { id: 'u:11', kind: 'user', accessHash: '91' },
        'Sent text',
        '123',
        undefined,
        [
          { offset: 0, length: 4, kind: 'bold' },
          { offset: 0, length: 4, kind: 'italic' },
          { offset: 0, length: 4, kind: 'underline' },
          { offset: 0, length: 4, kind: 'strike' },
          { offset: 0, length: 4, kind: 'code' },
          { offset: 0, length: 4, kind: 'pre' },
          { offset: 0, length: 4, kind: 'spoiler' },
          { offset: 0, length: 4, kind: 'blockquote' },
          { offset: 5, length: 4, kind: 'textUrl', url: 'https://example.com' },
        ],
      ),
    ).resolves.toMatchObject({
      message: { id: 21, text: 'Sent text', randomId: '123' },
      updateBatches: [
        {
          date: 100,
          seq: 1,
          updates: [{ pts: 2, ptsCount: 1, message: { id: 21, randomId: '123' } }],
        },
      ],
    });
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      message: 'Sent text',
      randomId: 123n,
      entities: [
        anyTl(Api.MessageEntityBold),
        anyTl(Api.MessageEntityItalic),
        anyTl(Api.MessageEntityUnderline),
        anyTl(Api.MessageEntityStrike),
        anyTl(Api.MessageEntityCode),
        anyTl(Api.MessageEntityPre),
        anyTl(Api.MessageEntitySpoiler),
        anyTl(Api.MessageEntityBlockquote),
        anyTl(Api.MessageEntityTextUrl),
      ],
    });
  });

  it('builds the exact sent message from Telegram short-send responses', async () => {
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(
      Api.UpdateShortSentMessage({
        out: true,
        id: 23,
        pts: 3,
        ptsCount: 1,
        date: 102,
        entities: [Api.MessageEntityBold({ offset: 0, length: 4 })],
      }),
    );
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.sendText({ id: 'u:11', kind: 'user', accessHash: '91' }, 'Sent text', '124', {
        messageId: 9,
        quoteText: 'Quoted',
      }),
    ).resolves.toMatchObject({
      message: {
        id: 23,
        peerId: 'u:11',
        senderId: 'self',
        text: 'Sent text',
        date: 102,
        outgoing: true,
        randomId: '124',
        replyToId: 9,
        replyQuote: 'Quoted',
        formats: [{ offset: 0, length: 4, kind: 'bold' }],
      },
      updateBatches: [{ date: 102, updates: [{ pts: 3, ptsCount: 1 }] }],
    });
  });

  it('maps a short-send file response without retrying an accepted upload', async () => {
    const target = transport();
    const uploadFile = vi
      .fn()
      .mockResolvedValue(Api.InputFile({ id: 4n, parts: 1, name: 'report.pdf', md5Checksum: '' }));
    const invoke = vi.fn().mockResolvedValue(
      Api.UpdateShortSentMessage({
        out: true,
        id: 24,
        pts: 4,
        ptsCount: 1,
        date: 103,
        media: Api.MessageMediaDocument({
          document: Api.Document({
            id: 204n,
            accessHash: 205n,
            fileReference: new Uint8Array([2, 0, 4]),
            date: 103,
            mimeType: 'application/pdf',
            size: 6n,
            dcId: 2,
            attributes: [Api.DocumentAttributeFilename({ fileName: 'report.pdf' })],
          }),
        }),
        entities: [Api.MessageEntityBold({ offset: 0, length: 4 })],
      }),
    );
    (target as unknown as TransportInternals).client = { invoke, uploadFile };

    await expect(
      target.sendFile(
        { id: 'u:11', kind: 'user', accessHash: '91' },
        new File(['report'], 'report.pdf', { type: 'application/pdf' }),
        {
          caption: 'File caption',
          randomId: '304',
          asSticker: false,
          sendAs: 'file',
          reply: { messageId: 10, quoteText: 'Quoted file' },
          formats: [{ offset: 0, length: 4, kind: 'italic' }],
        },
      ),
    ).resolves.toMatchObject({
      message: {
        id: 24,
        peerId: 'u:11',
        senderId: 'self',
        text: 'File caption',
        date: 103,
        outgoing: true,
        randomId: '304',
        replyToId: 10,
        replyQuote: 'Quoted file',
        formats: [{ offset: 0, length: 4, kind: 'bold' }],
        media: {
          kind: 'file',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          size: 6,
          cacheKey: 'document:204',
        },
      },
      updateBatches: [
        {
          date: 103,
          updates: [
            {
              type: 'new-message',
              pts: 4,
              ptsCount: 1,
              message: { id: 24, randomId: '304', media: { cacheKey: 'document:204' } },
            },
          ],
        },
      ],
    });
    expect(Api.messages.SendMedia.is(invoke.mock.calls[0]?.[0])).toBe(true);
  });

  it('maps a short-send document sticker response without retrying the accepted send', async () => {
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(
      Api.UpdateShortSentMessage({
        out: true,
        id: 25,
        pts: 5,
        ptsCount: 1,
        date: 104,
        media: Api.MessageMediaDocument({
          document: Api.Document({
            id: 305n,
            accessHash: 306n,
            fileReference: new Uint8Array([3, 0, 5]),
            date: 104,
            mimeType: 'image/webp',
            size: 7n,
            dcId: 2,
            attributes: [
              Api.DocumentAttributeSticker({
                alt: '🎉',
                stickerset: Api.InputStickerSetEmpty(),
              }),
            ],
          }),
        }),
      }),
    );
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.sendSticker(
        { id: 'u:11', kind: 'user', accessHash: '91' },
        {
          id: '305',
          accessHash: '306',
          fileReference: new Uint8Array([3, 0, 5]),
          emoji: '🎉',
          mimeType: 'image/webp',
          dcId: 2,
          size: 7,
        },
        '405',
        { messageId: 11, quoteText: 'Quoted sticker' },
      ),
    ).resolves.toMatchObject({
      message: {
        id: 25,
        peerId: 'u:11',
        senderId: 'self',
        text: '',
        date: 104,
        outgoing: true,
        randomId: '405',
        replyToId: 11,
        replyQuote: 'Quoted sticker',
        media: {
          kind: 'sticker',
          mimeType: 'image/webp',
          size: 7,
          cacheKey: 'document:305',
        },
      },
      updateBatches: [
        {
          date: 104,
          updates: [
            {
              type: 'new-message',
              pts: 5,
              ptsCount: 1,
              message: { id: 25, randomId: '405', media: { cacheKey: 'document:305' } },
            },
          ],
        },
      ],
    });
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      media: anyTl(Api.InputMediaDocument),
      randomId: 405n,
      replyTo: expect.objectContaining({ replyToMsgId: 11, quoteText: 'Quoted sticker' }),
    });
  });

  it('fetches an inline result by returned id when its short response omits content', async () => {
    const target = transport();
    const sent = Api.Message({
      id: 26,
      out: true,
      peerId: Api.PeerUser({ userId: 11n }),
      date: 105,
      message: 'GIF caption',
      replyTo: Api.MessageReplyHeader({ replyToMsgId: 12, quoteText: 'Quoted GIF' }),
      media: Api.MessageMediaDocument({
        document: Api.Document({
          id: 406n,
          accessHash: 407n,
          fileReference: new Uint8Array([4, 0, 6]),
          date: 105,
          mimeType: 'image/gif',
          size: 8n,
          dcId: 2,
          attributes: [
            Api.DocumentAttributeFilename({ fileName: 'result.gif' }),
            Api.DocumentAttributeAnimated(),
          ],
        }),
      }),
    });
    const invoke = vi.fn(async (request: unknown) => {
      if (Api.messages.SendInlineBotResult.is(request)) {
        return Api.UpdateShortSentMessage({
          out: true,
          id: 26,
          pts: 6,
          ptsCount: 1,
          date: 105,
        });
      }
      if (Api.messages.GetMessages.is(request)) {
        return Api.messages.Messages({
          messages: [sent],
          topics: [],
          chats: [],
          users: [],
        });
      }
      throw new Error('Unexpected inline-result request');
    });
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.sendSticker(
        { id: 'u:11', kind: 'user', accessHash: '91' },
        {
          id: '406',
          accessHash: '407',
          fileReference: new Uint8Array([4, 0, 6]),
          emoji: 'GIF',
          mimeType: 'image/gif',
          inlineQueryId: '408',
          inlineResultId: 'gif-result',
        },
        '409',
        { messageId: 12, quoteText: 'Quoted GIF' },
      ),
    ).resolves.toMatchObject({
      message: {
        id: 26,
        peerId: 'u:11',
        text: 'GIF caption',
        randomId: '409',
        replyToId: 12,
        replyQuote: 'Quoted GIF',
        media: { kind: 'animation', name: 'result.gif', cacheKey: 'document:406' },
      },
      updateBatches: [
        {
          date: 105,
          updates: [{ type: 'new-message', pts: 6, ptsCount: 1, message: { id: 26 } }],
        },
      ],
    });
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      queryId: 408n,
      id: 'gif-result',
      randomId: 409n,
    });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      id: [expect.objectContaining({ id: 26 })],
    });
    expect(Api.messages.GetMessages.is(invoke.mock.calls[1]?.[0])).toBe(true);
  });

  it('forces an uploaded image to a document when sent in file mode', async () => {
    const target = transport();
    const uploadFile = vi
      .fn()
      .mockResolvedValue(Api.InputFile({ id: 1n, parts: 1, name: 'photo.jpg', md5Checksum: '' }));
    const invoke = vi.fn().mockResolvedValue(
      Api.Updates({
        updates: [
          Api.UpdateNewMessage({
            message: Api.Message({
              id: 31,
              out: true,
              peerId: Api.PeerUser({ userId: 11n }),
              date: 103,
              message: 'Document caption',
            }),
            pts: 31,
            ptsCount: 1,
          }),
        ],

        users: [],
        chats: [],
        date: 103,
        seq: 1,
      }),
    );
    (target as unknown as TransportInternals).client = { invoke, uploadFile };

    await target.sendFile(
      { id: 'u:11', kind: 'user', accessHash: '91' },
      new File(['image'], 'photo.jpg', { type: 'image/jpeg' }),
      {
        caption: 'Document caption',
        randomId: '301',
        asSticker: false,
        sendAs: 'file',
      },
    );

    const request = invoke.mock.calls[0]?.[0] as Tl.messages.SendMedia;
    expect(Api.messages.SendMedia.is(request)).toBe(true);
    expect(Api.InputMediaUploadedDocument.is(request.media)).toBe(true);
    expect(request.media).toMatchObject({ forceFile: true, mimeType: 'image/jpeg' });
  });

  it('keeps a GIF sent in file mode as a plain document', async () => {
    const target = transport();
    (target as unknown as TransportInternals).client = {
      invoke: vi.fn(),
      uploadFile: vi
        .fn()
        .mockResolvedValue(Api.InputFile({ id: 2n, parts: 1, name: 'image.gif', md5Checksum: '' })),
    };

    const media = await (
      target as unknown as {
        uploadInputMedia(
          file: File,
          sendAs: 'media' | 'file',
          asSticker: boolean,
        ): Promise<Tl.TypeInputMedia>;
      }
    ).uploadInputMedia(new File(['gif'], 'image.gif', { type: 'image/gif' }), 'file', false);

    expect(media).toMatchObject({ forceFile: true, mimeType: 'image/gif' });
    expect(Api.InputMediaUploadedDocument.is(media)).toBe(true);
    expect((media as Tl.InputMediaUploadedDocument).attributes).toEqual([
      anyTl(Api.DocumentAttributeFilename),
    ]);
  });

  it('adds Telegram video metadata when uploading a video in media mode', async () => {
    const target = transport({
      readVideoMetadata: async () => ({ duration: 12.5, width: 1280, height: 720 }),
    });
    const uploadFile = vi
      .fn()
      .mockResolvedValue(Api.InputFile({ id: 3n, parts: 1, name: 'clip.mp4', md5Checksum: '' }));
    const invoke = vi.fn().mockResolvedValue(
      Api.Updates({
        updates: [
          Api.UpdateNewMessage({
            message: Api.Message({
              id: 33,
              out: true,
              peerId: Api.PeerUser({ userId: 11n }),
              date: 103,
              message: '',
            }),
            pts: 33,
            ptsCount: 1,
          }),
        ],

        users: [],
        chats: [],
        date: 103,
        seq: 1,
      }),
    );
    (target as unknown as TransportInternals).client = { invoke, uploadFile };

    await target.sendFile(
      { id: 'u:11', kind: 'user', accessHash: '91' },
      new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
      { caption: '', randomId: '302', asSticker: false, sendAs: 'media' },
    );

    const request = invoke.mock.calls[0]?.[0] as Tl.messages.SendMedia;
    const media = request.media as Tl.InputMediaUploadedDocument;
    expect(Api.InputMediaUploadedDocument.is(media)).toBe(true);
    expect(media.attributes).toEqual([
      anyTl(Api.DocumentAttributeFilename),
      expect.objectContaining({
        duration: 12.5,
        w: 1280,
        h: 720,
        supportsStreaming: true,
      }),
    ]);
    expect(Api.DocumentAttributeVideo.is(media.attributes[1])).toBe(true);
  });

  it('sends media attachments as one Telegram album with stable item ids', async () => {
    const target = transport();
    const uploadFile = vi
      .fn()
      .mockResolvedValueOnce(Api.InputFile({ id: 1n, parts: 1, name: 'one.png', md5Checksum: '' }))
      .mockResolvedValueOnce(Api.InputFile({ id: 2n, parts: 1, name: 'two.gif', md5Checksum: '' }));
    const sentUpdates = Api.Updates({
      updates: [
        Api.UpdateMessageID({ id: 41, randomId: 401n }),
        Api.UpdateMessageID({ id: 42, randomId: 402n }),
        Api.UpdateNewMessage({
          message: Api.Message({
            id: 41,
            out: true,
            peerId: Api.PeerUser({ userId: 11n }),
            groupedId: 900n,
            date: 104,
            message: 'Album caption',
          }),
          pts: 41,
          ptsCount: 1,
        }),
        Api.UpdateNewMessage({
          message: Api.Message({
            id: 42,
            out: true,
            peerId: Api.PeerUser({ userId: 11n }),
            groupedId: 900n,
            date: 104,
            message: '',
          }),
          pts: 42,
          ptsCount: 1,
        }),
      ],

      users: [],
      chats: [],
      date: 104,
      seq: 1,
    });
    let uploadedIndex = 0;
    const invoke = vi.fn(async (request: unknown) => {
      if (Api.messages.UploadMedia.is(request)) {
        uploadedIndex += 1;
        if (uploadedIndex === 2) {
          return Api.MessageMediaDocument({
            document: Api.Document({
              id: 2n,
              accessHash: 102n,
              fileReference: new Uint8Array([2]),
              date: 104,
              mimeType: 'image/gif',
              size: 3n,
              dcId: 2,
              attributes: [
                Api.DocumentAttributeFilename({ fileName: 'two.gif' }),
                Api.DocumentAttributeAnimated(),
              ],
            }),
          });
        }
        return Api.MessageMediaPhoto({
          photo: Api.Photo({
            id: BigInt(uploadedIndex),
            accessHash: BigInt(100 + uploadedIndex),
            fileReference: new Uint8Array([uploadedIndex]),
            date: 104,
            sizes: [],
            dcId: 2,
          }),
        });
      }
      if (Api.messages.SendMultiMedia.is(request)) return sentUpdates;
      throw new Error('Unexpected album request');
    });
    (target as unknown as TransportInternals).client = { invoke, uploadFile };

    await expect(
      target.sendAlbum(
        { id: 'u:11', kind: 'user', accessHash: '91' },
        [
          {
            file: new File(['one'], 'one.png', { type: 'image/png' }),
            randomId: '401',
            sendAs: 'media',
          },
          {
            file: new File(['two'], 'two.gif', { type: 'image/gif' }),
            randomId: '402',
            sendAs: 'media',
          },
        ],

        {
          caption: 'Album caption',
          reply: { messageId: 9 },
          formats: [{ offset: 0, length: 5, kind: 'bold' }],
        },
      ),
    ).resolves.toMatchObject({
      messages: [
        expect.objectContaining({ id: 41, groupedId: '900', randomId: '401' }),
        expect.objectContaining({ id: 42, groupedId: '900', randomId: '402' }),
      ],

      updateBatches: [
        {
          date: 104,
          seq: 1,
          updates: [
            { message: { id: 41, randomId: '401' } },
            { message: { id: 42, randomId: '402' } },
          ],
        },
      ],
    });
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      media: anyTl(Api.InputMediaUploadedPhoto),
    });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      media: anyTl(Api.InputMediaUploadedDocument),
    });
    const request = invoke.mock.calls[2]?.[0] as Tl.messages.SendMultiMedia;
    expect(Api.messages.SendMultiMedia.is(request)).toBe(true);
    expect(request.replyTo).toMatchObject({ replyToMsgId: 9 });
    expect(request.multiMedia).toEqual([
      expect.objectContaining({
        randomId: 401n,
        message: 'Album caption',
        media: anyTl(Api.InputMediaPhoto),
        entities: [anyTl(Api.MessageEntityBold)],
      }),
      expect.objectContaining({
        randomId: 402n,
        message: '',
        media: anyTl(Api.InputMediaDocument),
      }),
    ]);
  });

  it('uploads replacement media as part of an edit request', async () => {
    const target = transport();
    const uploadFile = vi
      .fn()
      .mockResolvedValue(
        Api.InputFile({ id: 3n, parts: 1, name: 'replacement.png', md5Checksum: '' }),
      );
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(Api.Updates({ updates: [], users: [], chats: [], date: 105, seq: 1 }))
      .mockResolvedValueOnce(
        Api.messages.Messages({
          messages: [
            Api.Message({
              id: 21,
              out: true,
              peerId: Api.PeerUser({ userId: 11n }),
              date: 105,
              message: 'Edited caption',
            }),
          ],
          topics: [],
          chats: [],
          users: [],
        }),
      );
    (target as unknown as TransportInternals).client = { invoke, uploadFile };

    await target.editMessage(
      { id: 'u:11', kind: 'user', accessHash: '91' },
      21,
      'Edited caption',
      undefined,
      {
        file: new File(['replacement'], 'replacement.png', { type: 'image/png' }),
        sendAs: 'media',
      },
    );

    const request = invoke.mock.calls[0]?.[0] as Tl.messages.EditMessage;
    expect(Api.messages.EditMessage.is(request)).toBe(true);
    expect(Api.InputMediaUploadedPhoto.is(request.media)).toBe(true);
  });

  it('does not mistake an identical outgoing history message for the current send', async () => {
    const target = transport();
    const result = Api.Updates({ updates: [], users: [], chats: [], date: 100, seq: 1 });
    (target as unknown as TransportInternals).client = {
      invoke: vi.fn().mockResolvedValue(result),
    };
    const getHistory = vi.spyOn(target, 'getHistory').mockResolvedValue({
      messages: [
        {
          id: 22,
          peerId: 'u:11',
          senderId: 'self',
          text: 'Sent text',
          date: 101,
          outgoing: true,
        },
      ],

      hasOlder: true,
    });

    await expect(
      target.sendText({ id: 'u:11', kind: 'user', accessHash: '91' }, 'Sent text', '123'),
    ).rejects.toThrow('returned no message');
    expect(getHistory).not.toHaveBeenCalled();
  });

  it('maps external dialog pin changes and reconciles compact list updates', () => {
    const target = transport() as unknown as TransportInternals;
    expect(
      mappedUpdates(
        target,
        Api.UpdateDialogPinned({
          pinned: true,
          peer: Api.DialogPeer({ peer: Api.PeerUser({ userId: 11n }) }),
        }),
      ),
    ).toEqual([{ type: 'dialog-pinned', peerId: 'u:11', pinned: true }]);
    expect(mappedUpdates(target, Api.UpdatePinnedDialogs())).toEqual([
      { type: 'dialog-list-invalidated' },
    ]);
    expect(
      mappedUpdates(
        target,
        Api.UpdateFolderPeers({
          folderPeers: [Api.FolderPeer({ peer: Api.PeerUser({ userId: 11n }), folderId: 1 })],

          pts: 2,
          ptsCount: 1,
        }),
      ),
    ).toEqual([
      {
        type: 'dialog-folders-changed',
        pts: 2,
        ptsCount: 1,
        folders: [{ peerId: 'u:11', folderId: 1 }],
      },
    ]);
    expect(mappedUpdates(target, Api.UpdateChannelTooLong({ channelId: 12n, pts: 44 }))).toEqual([
      { type: 'channel-too-long', peerId: 'c:12' },
    ]);
  });

  it('maps sticker and GIF index invalidations', () => {
    const target = transport() as unknown as TransportInternals;
    expect(mappedUpdates(target, Api.UpdateStickerSets())).toEqual([
      { type: 'expression-index-changed', kind: 'stickers' },
    ]);
    expect(mappedUpdates(target, Api.UpdateRecentStickers())).toEqual([
      { type: 'expression-index-changed', kind: 'stickers' },
    ]);
    expect(mappedUpdates(target, Api.UpdateSavedGifs())).toEqual([
      { type: 'expression-index-changed', kind: 'gifs' },
    ]);
    expect(
      mappedUpdates(
        target,
        Api.UpdateBotCommands({
          peer: Api.PeerChat({ chatId: 12n }),
          botId: 7n,
          commands: [Api.BotCommand({ command: 'help', description: 'Help' })],
        }),
      ),
    ).toEqual([{ type: 'bot-commands-changed', peerId: 'g:12', botId: 'u:7' }]);
  });

  it('forwards through Telegram and returns the message created in the target chat', async () => {
    const message = Api.Message({
      id: 31,
      out: true,
      fromId: Api.PeerUser({ userId: 11n }),
      peerId: Api.PeerChannel({ channelId: 12n }),
      date: 100,
      message: 'Forwarded text',
    });
    const result = Api.Updates({
      updates: [Api.UpdateNewChannelMessage({ message, pts: 2, ptsCount: 1 })],
      users: [],
      chats: [],
      date: 100,
      seq: 1,
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.forwardMessage(
        { id: 'u:11', kind: 'user', accessHash: '91' },
        { id: 'c:12', kind: 'channel', accessHash: '92' },
        30,
        '987',
      ),
    ).resolves.toMatchObject({
      message: {
        id: 31,
        peerId: 'c:12',
        text: 'Forwarded text',
        randomId: '987',
      },
      updateBatches: [{ date: 100, seq: 1 }],
    });
    expect(Api.messages.ForwardMessages.is(invoke.mock.calls[0]?.[0])).toBe(true);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ id: [30], randomId: [987n] });
  });

  it('fetches a forwarded message by returned id after a short success response', async () => {
    const target = transport();
    const forwarded = Api.Message({
      id: 32,
      out: true,
      peerId: Api.PeerChannel({ channelId: 12n }),
      date: 101,
      message: 'Fetched forwarded text',
    });
    const invoke = vi.fn(async (request: unknown) => {
      if (Api.messages.ForwardMessages.is(request)) {
        return Api.UpdateShortSentMessage({
          out: true,
          id: 32,
          pts: 3,
          ptsCount: 1,
          date: 101,
        });
      }
      if (Api.channels.GetMessages.is(request)) {
        return Api.messages.Messages({
          messages: [forwarded],
          topics: [],
          chats: [],
          users: [],
        });
      }
      throw new Error('Unexpected forward request');
    });
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.forwardMessage(
        { id: 'u:11', kind: 'user', accessHash: '91' },
        { id: 'c:12', kind: 'channel', accessHash: '92' },
        30,
        '988',
      ),
    ).resolves.toMatchObject({
      message: {
        id: 32,
        peerId: 'c:12',
        text: 'Fetched forwarded text',
        randomId: '988',
      },
      updateBatches: [
        {
          date: 101,
          updates: [{ type: 'new-message', pts: 3, ptsCount: 1, message: { id: 32 } }],
        },
      ],
    });
    expect(Api.channels.GetMessages.is(invoke.mock.calls[1]?.[0])).toBe(true);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      channel: expect.objectContaining({ channelId: 12n, accessHash: 92n }),
      id: [expect.objectContaining({ id: 32 })],
    });
  });

  it('retrieves the edited message around its id when Telegram omits it from updates', async () => {
    const target = transport();
    const edited = Api.Message({
      id: 21,
      out: true,
      peerId: Api.PeerUser({ userId: 11n }),
      date: 100,
      message: 'Edited old message',
    });
    const invoke = vi.fn(async (request: unknown) => {
      if (Api.messages.EditMessage.is(request)) {
        return Api.Updates({ updates: [], users: [], chats: [], date: 100, seq: 1 });
      }
      return Api.messages.Messages({
        messages: [edited],
        topics: [],
        chats: [],
        users: [],
      });
    });
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.editMessage({ id: 'u:11', kind: 'user', accessHash: '91' }, 21, 'Edited old message', [
        { offset: 0, length: 6, kind: 'bold' },
      ]),
    ).resolves.toMatchObject({ message: { id: 21, text: 'Edited old message' } });
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      entities: [anyTl(Api.MessageEntityBold)],
    });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ offsetId: 21, addOffset: -1, limit: 3 });
  });

  it('uses the correct deletion RPC for channels and ordinary chats', async () => {
    const target = transport();
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(Api.messages.AffectedMessages({ pts: 20, ptsCount: 1 }))
      .mockResolvedValueOnce(Api.messages.AffectedMessages({ pts: 21, ptsCount: 1 }));
    (target as unknown as TransportInternals).client = { invoke };

    await target.deleteMessages({ id: 'u:11', kind: 'user', accessHash: '91' }, [4], true);
    await target.deleteMessages({ id: 'c:12', kind: 'channel', accessHash: '92' }, [5], true);

    expect(Api.messages.DeleteMessages.is(invoke.mock.calls[0]?.[0])).toBe(true);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ id: [4], revoke: true });
    expect(Api.channels.DeleteMessages.is(invoke.mock.calls[1]?.[0])).toBe(true);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ id: [5] });
  });

  it('downloads media only after its Telegram media reference has been mapped', async () => {
    const target = transport();
    const invoke = vi.fn();
    const downloadMedia = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    (target as unknown as TransportInternals).client = { invoke, downloadMedia };
    const telegramMessage = Api.Message({
      id: 7,
      peerId: Api.PeerUser({ userId: 11n }),
      date: 100,
      message: '',
      media: Api.MessageMediaDocument({
        document: Api.Document({
          id: 1n,
          accessHash: 2n,
          fileReference: new Uint8Array(),
          date: 100,
          mimeType: 'text/plain',
          size: 3n,
          dcId: 2,
          attributes: [Api.DocumentAttributeFilename({ fileName: 'file.txt' })],
        }),
      }),
    });
    const mapped = (
      target as unknown as {
        mapMessage(message: Tl.TypeMessage):
          | {
              id: number;
              peerId: string;
              senderId: string;
              text: string;
              date: number;
              outgoing: boolean;
              media?: { kind: 'file'; name: string; mimeType: string };
            }
          | undefined;
      }
    ).mapMessage(telegramMessage);
    if (!mapped) throw new Error('Expected mapped fixture message');

    const progress = Object.assign(vi.fn(), { isCanceled: false });
    const blob = await target.downloadMedia(mapped, { progress });
    expect(blob.size).toBe(3);
    expect(blob.type).toBe('text/plain');
    expect(downloadMedia).toHaveBeenCalledWith(expect.anything(), {
      workers: 1,
      progressCallback: progress,
    });
    const preview = await target.downloadMedia(mapped, { preview: true });
    expect(preview.type).toBe('image/jpeg');
    expect(downloadMedia).toHaveBeenLastCalledWith(expect.anything(), {
      workers: 1,
      sizeType: 'm',
      progressCallback: undefined,
    });
    await expect(target.downloadMedia({ ...mapped, id: 8 })).rejects.toThrow(
      'Media data is no longer in memory',
    );
  });

  it('bounds raw message media references and clears runtime caches on disconnect', async () => {
    const target = transport();
    const document = Api.Document({
      id: 1n,
      accessHash: 2n,
      fileReference: new Uint8Array(),
      date: 100,
      mimeType: 'text/plain',
      size: 3n,
      dcId: 2,
      attributes: [Api.DocumentAttributeFilename({ fileName: 'file.txt' })],
    });
    const internals = target as unknown as {
      messageMedia: Map<string, unknown>;
      stickerDocuments: Map<string, unknown>;
      wallpaperDocuments: Map<string, Tl.Document>;
      entities: Map<string, unknown>;
      phoneNumber: string;
      phoneCodeHash: string;
      mapMessage(message: Tl.TypeMessage): unknown;
    };
    for (let id = 1; id <= 1_005; id += 1) {
      internals.mapMessage(
        Api.Message({
          id,
          peerId: Api.PeerUser({ userId: 11n }),
          date: id,
          message: '',
          media: Api.MessageMediaDocument({ document }),
        }),
      );
    }

    expect(internals.messageMedia.size).toBe(1_000);
    expect(internals.messageMedia.has('u:11:1')).toBe(false);
    expect(internals.messageMedia.has('u:11:1005')).toBe(true);
    internals.stickerDocuments.set('sticker', document);
    internals.wallpaperDocuments.set('wallpaper', document);
    internals.entities.set('u:11', Api.User({ id: 11n }));
    internals.phoneNumber = '+15551234567';
    internals.phoneCodeHash = 'stale-code-hash';

    await target.disconnect();

    expect(internals.messageMedia.size).toBe(0);
    expect(internals.stickerDocuments.size).toBe(0);
    expect(internals.wallpaperDocuments.size).toBe(0);
    expect(internals.entities.size).toBe(0);
    expect(internals.phoneNumber).toBe('');
    expect(internals.phoneCodeHash).toBe('');
  });

  it('maps inline and reply bot keyboards without exposing unsupported button actions', () => {
    const target = transport() as unknown as {
      entities: Map<string, Tl.TypeUser | Tl.TypeChat>;
      mapMessage(message: Tl.TypeMessage): {
        botKeyboard?: { kind: string; rows: Array<Array<Record<string, unknown>>> };
      };
    };
    target.entities.set(
      'u:7',
      Api.User({
        id: 7n,
        accessHash: 77n,
        firstName: 'Inline Bot',
        username: 'inline_fixture_bot',
        bot: true,
      }),
    );
    const inline = target.mapMessage(
      Api.Message({
        id: 30,
        peerId: Api.PeerChat({ chatId: 12n }),
        fromId: Api.PeerUser({ userId: 7n }),
        date: 1,
        message: 'Choose',
        replyMarkup: Api.ReplyInlineMarkup({
          rows: [
            Api.KeyboardButtonRow({
              buttons: [
                Api.KeyboardButtonCallback({
                  text: 'Refresh',
                  data: new Uint8Array([1, 2, 3]),
                }),
                Api.KeyboardButtonUrl({ text: 'Docs', url: 'https://example.com/docs' }),
                Api.KeyboardButtonUrlAuth({
                  text: 'Sign in',
                  url: 'https://example.com/auth',
                  buttonId: 4,
                }),
                Api.KeyboardButtonCopy({ text: 'Copy', copyText: 'fixture-value' }),
                Api.KeyboardButtonSwitchInline({
                  samePeer: true,
                  text: 'Search',
                  query: 'cats',
                }),
              ],
            }),
          ],
        }),
      }),
    );
    const reply = target.mapMessage(
      Api.Message({
        id: 31,
        peerId: Api.PeerUser({ userId: 7n }),
        date: 2,
        message: 'Reply',
        replyMarkup: Api.ReplyKeyboardMarkup({
          resize: true,
          persistent: true,
          placeholder: 'Pick one',
          rows: [
            Api.KeyboardButtonRow({
              buttons: [
                Api.KeyboardButton({ text: 'Status' }),
                Api.KeyboardButtonRequestGeoLocation({ text: 'Location' }),
              ],
            }),
          ],
        }),
      }),
    );

    expect(inline.botKeyboard).toEqual({
      kind: 'inline',
      rows: [
        [
          { kind: 'callback', text: 'Refresh', data: [1, 2, 3] },
          { kind: 'url', text: 'Docs', url: 'https://example.com/docs' },
          {
            kind: 'url-auth',
            text: 'Sign in',
            url: 'https://example.com/auth',
            buttonId: 4,
          },
          { kind: 'copy', text: 'Copy', copyText: 'fixture-value' },
          {
            kind: 'switch-inline',
            text: 'Search',
            query: 'cats',
            samePeer: true,
            botUsername: 'inline_fixture_bot',
          },
        ],
      ],
    });
    expect(reply.botKeyboard).toMatchObject({
      kind: 'reply',
      persistent: true,
      placeholder: 'Pick one',
      rows: [
        [
          { kind: 'text', text: 'Status' },
          { kind: 'unsupported', text: 'Location' },
        ],
      ],
    });
  });

  it('requests and accepts Telegram URL authorization for an inline button', async () => {
    const bot = Api.User({
      id: 7n,
      accessHash: 77n,
      firstName: 'Fixture Bot',
      bot: true,
    });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(
        Api.UrlAuthResultRequest({
          requestWriteAccess: true,
          requestPhoneNumber: true,
          bot,
          domain: 'example.com',
          matchCodes: ['1234'],
          matchCodesFirst: true,
        }),
      )
      .mockResolvedValueOnce(
        Api.UrlAuthResultAccepted({ url: 'https://example.com/authenticated' }),
      );
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke };
    const peer = { id: 'u:7', kind: 'user' as const, accessHash: '77' };

    await expect(target.requestUrlAuth(peer, 30, 4)).resolves.toEqual({
      kind: 'request',
      botTitle: 'Fixture Bot',
      domain: 'example.com',
      requestWriteAccess: true,
      requestPhoneNumber: true,
      matchCodesFirst: true,
      isApp: false,
      matchCodes: ['1234'],
      verifiedAppName: undefined,
    });
    await expect(
      target.acceptUrlAuth(peer, 30, 4, {
        writeAllowed: true,
        sharePhoneNumber: true,
        matchCode: '1234',
      }),
    ).resolves.toEqual({ kind: 'accepted', url: 'https://example.com/authenticated' });
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ msgId: 30, buttonId: 4 });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      msgId: 30,
      buttonId: 4,
      writeAllowed: true,
      sharePhoneNumber: true,
      matchCode: '1234',
    });
  });

  it('loads bot commands, starts bots with a stable random id, and answers callbacks', async () => {
    const target = transport();
    const peer = { id: 'u:7', kind: 'user' as const, accessHash: '77' };
    const fullUser = Api.users.UserFull({
      fullUser: Api.UserFull({
        id: 7n,
        settings: Api.PeerSettings(),
        notifySettings: Api.PeerNotifySettings(),
        commonChatsCount: 0,
        botInfo: Api.BotInfo({
          commands: [Api.BotCommand({ command: 'help', description: 'Show help' })],
        }),
      }),
      chats: [],
      users: [Api.User({ id: 7n, accessHash: 77n, firstName: 'Fixture Bot', bot: true })],
    });
    const startUpdates = Api.Updates({
      updates: [
        Api.UpdateNewMessage({
          message: Api.Message({
            id: 44,
            out: true,
            peerId: Api.PeerUser({ userId: 7n }),
            date: 10,
            message: '/start',
          }),
          pts: 1,
          ptsCount: 1,
        }),
      ],

      users: [],
      chats: [],
      date: 10,
      seq: 1,
    });
    const callback = Api.messages.BotCallbackAnswer({
      alert: true,
      message: 'Updated',
      url: 'https://example.com/result',
      cacheTime: 0,
    });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(fullUser)
      .mockResolvedValueOnce(startUpdates)
      .mockResolvedValueOnce(startUpdates)
      .mockResolvedValueOnce(callback);
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.getBotCommands(peer)).resolves.toEqual([
      {
        command: 'help',
        description: 'Show help',
        botId: 'u:7',
        botName: 'Fixture Bot',
      },
    ]);
    await expect(target.startBot(peer, '', '987')).resolves.toMatchObject({
      message: { id: 44, text: '/start', randomId: '987' },
    });
    await expect(target.startBot(peer, 'deep-link', '988')).resolves.toMatchObject({
      message: { id: 44, randomId: '988' },
    });
    await expect(target.answerBotCallback(peer, 44, [4, 5])).resolves.toEqual({
      message: 'Updated',
      alert: true,
      url: 'https://example.com/result',
    });
    expect(Api.messages.SendMessage.is(invoke.mock.calls[1]?.[0])).toBe(true);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ randomId: 987n, message: '/start' });
    expect(Api.messages.StartBot.is(invoke.mock.calls[2]?.[0])).toBe(true);
    expect(invoke.mock.calls[2]?.[0]).toMatchObject({
      randomId: 988n,
      startParam: 'deep-link',
    });
    expect(invoke.mock.calls[3]?.[0]).toMatchObject({ msgId: 44, data: new Uint8Array([4, 5]) });
  });

  it('loads chat-scoped command menus for every bot in a basic group', async () => {
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(
      Api.messages.ChatFull({
        fullChat: Api.ChatFull({
          id: 12n,
          about: '',
          participants: Api.ChatParticipantsForbidden({ chatId: 12n }),
          notifySettings: Api.PeerNotifySettings(),
          botInfo: [
            Api.BotInfo({
              userId: 7n,
              commands: [Api.BotCommand({ command: 'help', description: 'Show help' })],
            }),
            Api.BotInfo({
              userId: 8n,
              commands: [Api.BotCommand({ command: 'weather', description: 'Show weather' })],
            }),
          ],
        }),
        chats: [Api.ChatForbidden({ id: 12n, title: 'Bots group' })],
        users: [
          Api.User({
            id: 7n,
            accessHash: 77n,
            firstName: 'Helper Bot',
            username: 'helper_bot',
            bot: true,
          }),
          Api.User({
            id: 8n,
            accessHash: 88n,
            firstName: 'Weather Bot',
            username: 'weather_bot',
            bot: true,
          }),
        ],
      }),
    );
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.getBotCommands({ id: 'g:12', kind: 'group' })).resolves.toEqual([
      {
        command: 'help',
        description: 'Show help',
        botId: 'u:7',
        botUsername: 'helper_bot',
        botName: 'Helper Bot',
      },
      {
        command: 'weather',
        description: 'Show weather',
        botId: 'u:8',
        botUsername: 'weather_bot',
        botName: 'Weather Bot',
      },
    ]);
    expect(Api.messages.GetFullChat.is(invoke.mock.calls[0]?.[0])).toBe(true);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ chatId: 12n });
  });

  it('fetches the exact bot-start message after a short success response', async () => {
    const target = transport();
    const peer = { id: 'u:7', kind: 'user' as const, accessHash: '77' };
    const started = Api.Message({
      id: 45,
      out: true,
      peerId: Api.PeerUser({ userId: 7n }),
      date: 11,
      message: '/start',
    });
    const invoke = vi.fn(async (request: unknown) => {
      if (Api.messages.StartBot.is(request)) {
        return Api.UpdateShortSentMessage({
          out: true,
          id: 45,
          pts: 2,
          ptsCount: 1,
          date: 11,
        });
      }
      if (Api.messages.GetMessages.is(request)) {
        return Api.messages.Messages({
          messages: [started],
          topics: [],
          chats: [],
          users: [],
        });
      }
      throw new Error('Unexpected bot-start request');
    });
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.startBot(peer, 'deep-link', '989')).resolves.toMatchObject({
      message: {
        id: 45,
        peerId: 'u:7',
        text: '/start',
        randomId: '989',
      },
      updateBatches: [
        {
          date: 11,
          updates: [{ type: 'new-message', pts: 2, ptsCount: 1, message: { id: 45 } }],
        },
      ],
    });
    expect(Api.messages.GetMessages.is(invoke.mock.calls[1]?.[0])).toBe(true);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      id: [expect.objectContaining({ id: 45 })],
    });
  });

  it('correlates a persisted unsigned random id with its decoded signed TL long', async () => {
    const target = transport();
    const peer = { id: 'u:7', kind: 'user' as const, accessHash: '77' };
    const persistedRandomId = '9223372036854775808';
    const invoke = vi.fn(async (request: unknown) => {
      if (Api.messages.StartBot.is(request)) {
        return Api.Updates({
          updates: [Api.UpdateMessageID({ id: 46, randomId: -9_223_372_036_854_775_808n })],
          users: [],
          chats: [],
          date: 12,
          seq: 2,
        });
      }
      if (Api.messages.GetMessages.is(request)) {
        return Api.messages.Messages({
          messages: [
            Api.Message({
              id: 46,
              out: true,
              peerId: Api.PeerUser({ userId: 7n }),
              date: 12,
              message: '/start legacy',
            }),
          ],
          topics: [],
          chats: [],
          users: [],
        });
      }
      throw new Error('Unexpected bot-start request');
    });
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.startBot(peer, 'legacy', persistedRandomId)).resolves.toMatchObject({
      message: { id: 46, randomId: persistedRandomId },
    });
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      randomId: -9_223_372_036_854_775_808n,
    });
    expect(Api.messages.GetMessages.is(invoke.mock.calls[1]?.[0])).toBe(true);
  });

  it('surfaces a failed authorization-session write when the transport is flushed', async () => {
    const target = transport();
    const internals = target as unknown as { sessionSaveError: unknown };
    internals.sessionSaveError = new Error('IndexedDB is unavailable');

    await expect(target.disconnect()).rejects.toThrow(
      'Could not persist the Telegram authorization session. IndexedDB is unavailable',
    );
  });

  it('maps username changes to a peer metadata invalidation', () => {
    const target = transport() as unknown as TransportInternals;

    const updates = mappedUpdates(target, {
      _: 'updateUserName',
      userId: 7n,
      firstName: 'New',
      lastName: 'Name',
      usernames: [],
    } as Tl.UpdateUserName);

    expect(updates).not.toEqual([]);
  });

  it('maps remote blocked-state changes to a peer metadata invalidation', () => {
    const target = transport() as unknown as TransportInternals;

    const updates = mappedUpdates(target, {
      _: 'updatePeerBlocked',
      blocked: true,
      peerId: Api.PeerUser({ userId: 7n }),
    } as Tl.UpdatePeerBlocked);

    expect(updates).not.toEqual([]);
  });
});
