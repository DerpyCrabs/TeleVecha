import { describe, expect, it, vi } from 'vitest';

import { Api } from '../../vendor/weba/src/lib/gramjs/tl';
import {
  UpdateConnectionState,
  UpdateSessionGap,
} from '../../vendor/weba/src/lib/gramjs/network/updates';
import TelegramClient from '../../vendor/weba/src/lib/gramjs/client/TelegramClient';
import type { TransportUpdate, TransportUpdateBatch } from '../types';
import { WebAGramJsTransport } from './webAGramJsTransport';

function transport() {
  return new WebAGramJsTransport({
    loadTransportSession: async () => undefined,
    saveTransportSession: async () => undefined,
  });
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

type TransportInternals = {
  client: {
    invoke(request: unknown): Promise<unknown>;
    uploadFile?(options: unknown): Promise<Api.TypeInputFile>;
    getMe?(): Promise<Api.TypeUser | undefined>;
    downloadMedia?(media: unknown, options: unknown): Promise<Uint8Array | undefined>;
    downloadProfilePhoto?(entity: unknown): Promise<Uint8Array | undefined>;
    addEventHandler?(handler: unknown, builder: unknown): void;
  };
  installEventHandler(): void;
  mapUpdateEnvelope(update: unknown): TransportUpdateBatch;
  mapMessage(message: Api.TypeMessage): ReturnType<WebAGramJsTransport['getHistory']>;
  inputPeer(peer: { id: string; kind: 'user' | 'group' | 'channel'; accessHash?: string }): unknown;
};

function mappedUpdates(target: TransportInternals, update: unknown) {
  return target.mapUpdateEnvelope(update).updates;
}

describe('WebAGramJsTransport mapping', () => {
  it('coalesces connection setup and invalidates it when disconnect wins the race', async () => {
    const session = deferred<unknown>();
    const loadTransportSession = vi.fn(() => session.promise);
    const target = new WebAGramJsTransport({
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

  it('returns the raw Telegram user id for the authorized account', async () => {
    const target = transport();
    const getMe = vi.fn().mockResolvedValue(new Api.User({ id: 991n, firstName: 'Self' }));
    (target as unknown as TransportInternals).client = { invoke: vi.fn(), getMe };

    await expect(target.getAuthorizedAccountId()).resolves.toBe('991');
    expect(getMe).toHaveBeenCalledOnce();
  });

  it('installs the raw update handler on every replacement client', () => {
    const target = transport() as unknown as TransportInternals;
    const first = vi.fn();
    const second = vi.fn();
    target.client = { invoke: vi.fn(), addEventHandler: first };
    target.installEventHandler();
    target.client = { invoke: vi.fn(), addEventHandler: second };
    target.installEventHandler();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('delivers a raw cross-client message from GramJS to transport subscribers', () => {
    const target = transport();
    let handler: ((update: unknown) => void) | undefined;
    (target as unknown as TransportInternals).client = {
      invoke: vi.fn(),
      addEventHandler: (callback: unknown) => {
        handler = callback as (update: unknown) => void;
      },
    };
    const received: TransportUpdate[] = [];
    target.subscribe((batch) => received.push(...batch.updates));
    (target as unknown as TransportInternals).installEventHandler();

    handler?.(
      new Api.UpdateNewMessage({
        message: new Api.Message({
          id: 88,
          out: true,
          peerId: new Api.PeerUser({ userId: 11n }),
          date: 100,
          message: 'Sent from another Telegram client',
        }),
        pts: 12,
        ptsCount: 1,
      }),
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
      addEventHandler: (callback: unknown) => {
        firstHandler = callback as (update: unknown) => void;
      },
    };
    const secondClient = {
      invoke: vi.fn(),
      addEventHandler: (callback: unknown) => {
        secondHandler = callback as (update: unknown) => void;
      },
    };
    const received: TransportUpdate[] = [];
    target.subscribe((batch) => received.push(...batch.updates));

    internals.connectionGeneration = 1;
    internals.client = firstClient;
    internals.installEventHandler(firstClient, 1);
    firstHandler?.(new UpdateConnectionState(UpdateConnectionState.disconnected));
    internals.connectionGeneration = 2;
    internals.client = secondClient;
    internals.installEventHandler(secondClient, 2);

    vi.advanceTimersByTime(5_000);
    expect(received).toEqual([]);

    secondHandler?.(new UpdateConnectionState(UpdateConnectionState.disconnected));
    vi.advanceTimersByTime(5_000);

    expect(received).toEqual([{ type: 'connection-state', connected: false }]);
    vi.useRealTimers();
  });

  it('does not report GramJS background wake-up warnings as connection loss', () => {
    vi.useFakeTimers();
    const target = transport();
    let handler: ((update: unknown) => void) | undefined;
    const client = {
      invoke: vi.fn(),
      addEventHandler: (callback: unknown) => {
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

    handler?.(new UpdateConnectionState(UpdateConnectionState.disconnected));
    vi.advanceTimersByTime(1_000);
    handler?.(new UpdateConnectionState(UpdateConnectionState.connected));
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
      addEventHandler: (callback: unknown) => {
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

    handler?.(new UpdateConnectionState(UpdateConnectionState.disconnected));
    vi.advanceTimersByTime(4_999);
    expect(received).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(received).toEqual([{ type: 'connection-state', connected: false }]);
    vi.useRealTimers();
  });

  it('reports disconnects and requests catch-up only for real session or PTS gaps', () => {
    const target = transport() as unknown as TransportInternals;
    expect(
      mappedUpdates(target, new UpdateConnectionState(UpdateConnectionState.connected)),
    ).toEqual([]);
    expect(
      mappedUpdates(target, new UpdateConnectionState(UpdateConnectionState.disconnected)),
    ).toEqual([{ type: 'connection-state', connected: false }]);
    expect(mappedUpdates(target, new UpdateSessionGap(1n, 2n))).toEqual([{ type: 'too-long' }]);
    expect(mappedUpdates(target, new Api.UpdatePtsChanged())).toEqual([{ type: 'too-long' }]);
  });

  it('preserves one combined socket envelope with its date and sequence range', () => {
    const target = transport() as unknown as TransportInternals;
    const batch = target.mapUpdateEnvelope(
      new Api.UpdatesCombined({
        updates: [
          new Api.UpdateNewMessage({
            message: new Api.Message({
              id: 91,
              peerId: new Api.PeerUser({ userId: 11n }),
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
      new Api.Updates({
        updates: [
          new Api.UpdateNewMessage({
            message: new Api.Message({
              id: 92,
              out: true,
              peerId: new Api.PeerUser({ userId: 11n }),
              date: 111,
              message: 'Correlated update',
            }),
            pts: 32,
            ptsCount: 1,
          }),
          new Api.UpdateMessageID({ id: 92, randomId: 9_200n }),
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

  it('keeps short-update metadata intact through the raw GramJS handoff', () => {
    const envelope = new Api.UpdateShort({ update: new Api.UpdatePtsChanged(), date: 111 });
    const processUpdate = vi.fn();

    TelegramClient.prototype._handleUpdate.call(
      { _processUpdate: processUpdate } as unknown as TelegramClient,
      envelope,
    );

    expect(processUpdate).toHaveBeenCalledWith(envelope, undefined);
    expect((transport() as unknown as TransportInternals).mapUpdateEnvelope(envelope)).toEqual({
      updates: [{ type: 'too-long' }],
      date: 111,
    });
  });

  it('keeps dialog top messages separate when different peers reuse the same message id', async () => {
    const firstPeer = new Api.PeerUser({ userId: 1n });
    const secondPeer = new Api.PeerUser({ userId: 2n });
    const notifySettings = new Api.PeerNotifySettings({ muteUntil: 2_147_483_647 });
    const result = new Api.messages.Dialogs({
      dialogs: [
        new Api.Dialog({
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
        new Api.Dialog({
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
        new Api.Message({
          id: 5,
          peerId: firstPeer,
          date: 10,
          message: 'First preview',
        }),
        new Api.Message({
          id: 5,
          peerId: secondPeer,
          date: 20,
          message: 'Second preview',
        }),
      ],
      chats: [],
      users: [
        new Api.User({ id: 1n, firstName: 'First' }),
        new Api.User({ id: 2n, firstName: 'Second' }),
      ],
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
    const peer = new Api.PeerChannel({ channelId: 12n });
    const result = new Api.messages.Dialogs({
      dialogs: [
        new Api.Dialog({
          peer,
          topMessage: 0,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          unreadCount: 0,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          notifySettings: new Api.PeerNotifySettings(),
          pts: 44,
        }),
      ],
      messages: [],
      chats: [
        new Api.Channel({
          id: 12n,
          accessHash: 92n,
          title: 'Channel',
          photo: new Api.ChatPhotoEmpty(),
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
    const visiblePeer = new Api.PeerUser({ userId: 1n });
    const archivedPeer = new Api.PeerUser({ userId: 2n });
    const visiblePhoto = new Api.UserProfilePhoto({
      photoId: 91n,
      dcId: 2,
    });
    const visibleUser = new Api.User({
      id: 1n,
      accessHash: 11n,
      firstName: 'Visible',
      username: 'visible_bot',
      bot: true,
      photo: visiblePhoto,
    });
    const archivedUser = new Api.User({ id: 2n, firstName: 'Archived' });
    const notifySettings = new Api.PeerNotifySettings({ muteUntil: 2_147_483_647 });
    const result = new Api.messages.Dialogs({
      dialogs: [
        new Api.Dialog({
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
        new Api.Dialog({
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
    const user = new Api.User({
      id: 1n,
      accessHash: 11n,
      firstName: 'Refetched',
      photo: new Api.UserProfilePhoto({ photoId: 92n, dcId: 2 }),
    });
    const invoke = vi.fn().mockResolvedValue([user]);
    const downloadProfilePhoto = vi.fn().mockResolvedValue(new Uint8Array([4, 5]));
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke, downloadProfilePhoto };
    (target as unknown as { entities: Map<string, Api.TypeUser> }).entities.set(
      'u:1',
      new Api.User({ id: 1n, accessHash: 11n, firstName: 'Partial' }),
    );

    await expect(
      target.downloadAvatar({ id: 'u:1', kind: 'user', accessHash: '11' }),
    ).resolves.toMatchObject({ size: 2, type: 'image/jpeg' });
    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.users.GetUsers);
    expect(downloadProfilePhoto).toHaveBeenCalledWith(user);
  });

  it('inherits mute state from the Telegram default when the dialog has no override', async () => {
    const peer = new Api.PeerUser({ userId: 11n });
    const dialogPage = new Api.messages.Dialogs({
      dialogs: [
        new Api.Dialog({
          peer,
          topMessage: 1,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          unreadCount: 5,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          notifySettings: new Api.PeerNotifySettings(),
        }),
      ],
      messages: [],
      chats: [],
      users: [new Api.User({ id: 11n, firstName: 'Muted by default' })],
    });
    const target = transport();
    const invoke = vi.fn((request: unknown) => {
      if (request instanceof Api.account.GetNotifySettings) {
        return Promise.resolve(
          request.peer instanceof Api.InputNotifyUsers
            ? new Api.PeerNotifySettings({ muteUntil: 2_147_483_647 })
            : new Api.PeerNotifySettings(),
        );
      }
      return Promise.resolve(dialogPage);
    });
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.getDialogs(100)).resolves.toMatchObject({
      dialogs: [expect.objectContaining({ unreadCount: 5, muted: true })],
    });
  });

  it('treats the dialog limit as a total result cap', async () => {
    const notifySettings = new Api.PeerNotifySettings();
    const page = (ids: number[]) =>
      new Api.messages.Dialogs({
        dialogs: ids.map(
          (id) =>
            new Api.Dialog({
              peer: new Api.PeerUser({ userId: BigInt(id) }),
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
        messages: ids.map(
          (id) =>
            new Api.Message({
              id: id * 10,
              peerId: new Api.PeerUser({ userId: BigInt(id) }),
              date: id * 100,
              message: `Message ${id}`,
            }),
        ),
        chats: [],
        users: ids.map(
          (id) =>
            new Api.User({ id: BigInt(id), accessHash: BigInt(id + 100), firstName: `User ${id}` }),
        ),
      });
    const target = transport();
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(page([3, 2]))
      .mockResolvedValueOnce(page([1]));
    (target as unknown as TransportInternals).client = { invoke };

    const result = await target.getDialogs(2);
    const dialogRequests = invoke.mock.calls.filter(
      ([request]) => request instanceof Api.messages.GetDialogs,
    );

    expect(result.dialogs.map(({ title }) => title)).toEqual(['User 3', 'User 2']);
    expect(dialogRequests).toHaveLength(1);
    expect(dialogRequests[0]?.[0]).toMatchObject({ limit: 2 });
  });

  it('keeps paging until every dialog in both folders is loaded', async () => {
    const notifySettings = new Api.PeerNotifySettings();
    const page = (ids: number[], archived = false) =>
      new Api.messages.Dialogs({
        dialogs: ids.map(
          (id) =>
            new Api.Dialog({
              peer: new Api.PeerUser({ userId: BigInt(id) }),
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
        messages: ids.map(
          (id) =>
            new Api.Message({
              id,
              peerId: new Api.PeerUser({ userId: BigInt(id) }),
              date: id,
              message: `Message ${id}`,
            }),
        ),
        chats: [],
        users: ids.map(
          (id) => new Api.User({ id: BigInt(id), accessHash: BigInt(id), firstName: `User ${id}` }),
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
    const dialogRequests = invoke.mock.calls.filter(
      ([request]) => request instanceof Api.messages.GetDialogs,
    );

    expect(result.dialogs).toHaveLength(102);
    expect(result.dialogs.filter(({ archived }) => archived)).toHaveLength(1);
    expect(dialogRequests).toHaveLength(3);
    expect(dialogRequests.map(([request]) => (request as { folderId: number }).folderId)).toEqual([
      0, 0, 1,
    ]);
  });

  it('searches contacts, users, bots, public groups, and channels', async () => {
    const contact = new Api.User({
      id: 11n,
      accessHash: 111n,
      firstName: 'Saved Contact',
      username: 'saved_contact',
      contact: true,
    });
    const bot = new Api.User({
      id: 12n,
      accessHash: 112n,
      firstName: 'Search Bot',
      username: 'search_bot',
      bot: true,
    });
    const group = new Api.Channel({
      id: 13n,
      accessHash: 113n,
      title: 'Public Group',
      username: 'public_group',
      megagroup: true,
      photo: new Api.ChatPhotoEmpty(),
      date: 1,
    });
    const channel = new Api.Channel({
      id: 14n,
      accessHash: 114n,
      title: 'Public Channel',
      username: 'public_channel',
      broadcast: true,
      photo: new Api.ChatPhotoEmpty(),
      date: 1,
    });
    const result = new Api.contacts.Found({
      myResults: [new Api.PeerUser({ userId: 11n })],
      results: [
        new Api.PeerUser({ userId: 12n }),
        new Api.PeerChannel({ channelId: 13n }),
        new Api.PeerChannel({ channelId: 14n }),
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
    const recent = new Api.User({
      id: 15n,
      accessHash: 115n,
      firstName: 'Recent Stranger',
    });
    const target = transport();
    (target as unknown as TransportInternals).client = {
      invoke: vi.fn().mockResolvedValue(
        new Api.contacts.Found({
          myResults: [new Api.PeerUser({ userId: 15n })],
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
      const folderId = (request as Api.folders.EditPeerFolders).folderPeers[0]!.folderId;
      return Promise.resolve(
        new Api.Updates({
          updates: [
            new Api.UpdateFolderPeers({
              folderPeers: [
                new Api.FolderPeer({
                  peer: new Api.PeerUser({ userId: 11n }),
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
      new Api.UpdateShortMessage({
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
      new Api.UpdateShortChatMessage({
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
        new Api.UpdateReadHistoryInbox({
          peer: new Api.PeerUser({ userId: 11n }),
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
        new Api.UpdateReadChannelInbox({
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
        new Api.UpdateReadChannelOutbox({
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
      mapMessage(
        message: Api.TypeMessage,
      ): { media?: { kind: string; name: string; cacheKey?: string } } | undefined;
    };
    const kinds = [
      new Api.DocumentAttributeSticker({
        alt: 'x',
        stickerset: new Api.InputStickerSetEmpty(),
      }),
      new Api.DocumentAttributeAnimated(),
      new Api.DocumentAttributeVideo({ duration: 1, w: 10, h: 10 }),
      new Api.DocumentAttributeFilename({ fileName: 'plain.bin' }),
    ];

    const mapped = kinds.map((attribute, index) => {
      const document = new Api.Document({
        id: BigInt(index + 1),
        accessHash: 1n,
        fileReference: new Uint8Array(),
        date: 1,
        mimeType: 'application/octet-stream',
        size: 10n,
        dcId: 2,
        attributes: [attribute, new Api.DocumentAttributeFilename({ fileName: `file-${index}` })],
      });
      return target.mapMessage(
        new Api.Message({
          id: index + 1,
          peerId: new Api.PeerUser({ userId: 1n }),
          date: 1,
          message: '',
          media: new Api.MessageMediaDocument({ document }),
        }),
      )?.media;
    });

    const png = new Api.Document({
      id: 5n,
      accessHash: 1n,
      fileReference: new Uint8Array(),
      date: 1,
      mimeType: 'image/png',
      size: 10n,
      dcId: 2,
      attributes: [new Api.DocumentAttributeFilename({ fileName: 'telegram-image.png' })],
    });
    mapped.push(
      target.mapMessage(
        new Api.Message({
          id: 5,
          peerId: new Api.PeerUser({ userId: 1n }),
          date: 1,
          message: '',
          media: new Api.MessageMediaDocument({ document: png }),
        }),
      )?.media,
    );

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

    const photo = target.mapMessage(
      new Api.Message({
        id: 6,
        peerId: new Api.PeerUser({ userId: 1n }),
        date: 1,
        message: '',
        media: new Api.MessageMediaPhoto({
          photo: new Api.Photo({
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
      mapMessage(message: Api.TypeMessage):
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
      attribute: Api.DocumentAttributeAudio | Api.DocumentAttributeVideo,
      mimeType: string,
    ) =>
      target.mapMessage(
        new Api.Message({
          id,
          peerId: new Api.PeerUser({ userId: 1n }),
          date: 1,
          message: '',
          groupedId: 9_007_199_254_740_999n,
          media: new Api.MessageMediaDocument({
            document: new Api.Document({
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
      mediaMessage(10, new Api.DocumentAttributeAudio({ voice: true, duration: 13 }), 'audio/ogg'),
    ).toMatchObject({
      groupedId: '9007199254740999',
      media: { kind: 'voice', name: 'voice-10.ogg', duration: 13 },
    });
    expect(
      mediaMessage(
        11,
        new Api.DocumentAttributeVideo({ roundMessage: true, duration: 7.5, w: 360, h: 640 }),
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
      entities: Map<string, Api.TypeUser | Api.TypeChat>;
      mapMessage(message: Api.TypeMessage):
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
    target.entities.set('u:2', new Api.User({ id: 2n, firstName: 'Alice' }));
    target.entities.set('u:3', new Api.User({ id: 3n, firstName: 'Bob' }));

    const message = target.mapMessage(
      new Api.MessageService({
        id: 20,
        fromId: new Api.PeerUser({ userId: 2n }),
        peerId: new Api.PeerChat({ chatId: 8n }),
        date: 100,
        action: new Api.MessageActionChatAddUser({ users: [3n] }),
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
      mapMessage(message: Api.TypeMessage):
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
    const message = new Api.Message({
      id: 8,
      peerId: new Api.PeerUser({ userId: 1n }),
      date: 100,
      message: '@alice bold secret link',
      entities: [
        new Api.MessageEntityMention({ offset: 0, length: 6 }),
        new Api.MessageEntityBold({ offset: 7, length: 4 }),
        new Api.MessageEntitySpoiler({ offset: 12, length: 6 }),
        new Api.MessageEntityTextUrl({ offset: 19, length: 4, url: 'https://example.com' }),
        new Api.MessageEntityBlockquote({ offset: 7, length: 4, collapsed: true }),
        new Api.MessageEntityCustomEmoji({ offset: 0, length: 2, documentId: 88n }),
        new Api.MessageEntityFormattedDate({ offset: 19, length: 4, date: 1_700_000_000 }),
        new Api.MessageEntityDiffReplace({ offset: 7, length: 4, oldText: 'cold' }),
      ],
      reactions: new Api.MessageReactions({
        results: [
          new Api.ReactionCount({
            chosenOrder: 0,
            reaction: new Api.ReactionEmoji({ emoticon: '👍' }),
            count: 2,
          }),
          new Api.ReactionCount({
            reaction: new Api.ReactionCustomEmoji({ documentId: 99n }),
            count: 3,
          }),
        ],
      }),
      replyTo: new Api.MessageReplyHeader({ replyToMsgId: 7, quoteText: 'quoted' }),
      media: new Api.MessageMediaWebPage({
        webpage: new Api.WebPage({
          id: 1n,
          url: 'https://example.com',
          displayUrl: 'example.com',
          hash: 1,
          siteName: 'Example',
          title: 'Preview title',
          description: 'Preview description',
          photo: new Api.Photo({
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
      },
    });
  });

  it('maps forwarded message authors and original channel posts', () => {
    const target = transport() as unknown as {
      entities: Map<string, Api.TypeUser | Api.TypeChat>;
      mapMessage(
        message: Api.TypeMessage,
      ): { forwardedFrom?: { name: string; peerId?: string; messageId?: number } } | undefined;
    };
    target.entities.set(
      'c:202',
      new Api.Channel({
        id: 202n,
        title: 'Release Channel',
        photo: new Api.ChatPhotoEmpty(),
        date: 100,
      }),
    );

    const mapped = target.mapMessage(
      new Api.Message({
        id: 18,
        peerId: new Api.PeerUser({ userId: 1n }),
        date: 100,
        message: 'Forwarded post',
        fwdFrom: new Api.MessageFwdHeader({
          fromId: new Api.PeerChannel({ channelId: 202n }),
          channelPost: 17,
          date: 90,
        }),
      }),
    );

    expect(mapped?.forwardedFrom).toEqual({
      name: 'Release Channel',
      peerId: 'c:202',
      messageId: 17,
    });
  });

  it('maps bot rich messages into safe structured content', () => {
    const target = transport() as unknown as {
      mapMessage(
        message: Api.TypeMessage,
      ): { richMessage?: { rtl?: boolean; blocks: Array<Record<string, unknown>> } } | undefined;
    };
    const richMessage = new Api.RichMessage({
      rtl: true,
      blocks: [
        new Api.PageBlockHeading1({ text: new Api.TextPlain({ text: 'Release notes' }) }),
        new Api.PageBlockParagraph({
          text: new Api.TextConcat({
            texts: [
              new Api.TextBold({ text: new Api.TextPlain({ text: 'Rich Markdown' }) }),
              new Api.TextPlain({ text: ' with ' }),
              new Api.TextMarked({ text: new Api.TextPlain({ text: 'highlighting' }) }),
              new Api.TextCustomEmoji({ documentId: 55n, alt: '👍' }),
            ],
          }),
        }),
        new Api.PageBlockList({
          items: [
            new Api.PageListItemText({
              checkbox: true,
              checked: true,
              text: new Api.TextPlain({ text: 'Task done' }),
            }),
          ],
        }),
        new Api.PageBlockBlockquoteBlocks({
          blocks: [
            new Api.PageBlockParagraph({ text: new Api.TextPlain({ text: 'Hidden quote' }) }),
          ],
          caption: new Api.TextPlain({ text: 'Source' }),
        }),
        new Api.PageBlockTable({
          bordered: true,
          title: new Api.TextPlain({ text: 'Numbers' }),
          rows: [
            new Api.PageTableRow({
              cells: [
                new Api.PageTableCell({
                  header: true,
                  text: new Api.TextPlain({ text: 'Value' }),
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
        new Api.Message({
          id: 9,
          peerId: new Api.PeerUser({ userId: 1n }),
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
      mapMessage(message: Api.TypeMessage): { linkPreview?: unknown } | undefined;
    };
    const peerId = new Api.PeerUser({ userId: 1n });
    const pending = target.mapMessage(
      new Api.Message({
        id: 9,
        peerId,
        date: 100,
        message: 'https://www.reddit.com/r/example',
        media: new Api.MessageMediaWebPage({
          webpage: new Api.WebPagePending({
            id: 4n,
            url: 'https://www.reddit.com/r/example',
            date: 100,
          }),
        }),
      }),
    );
    const absent = target.mapMessage(
      new Api.Message({
        id: 10,
        peerId,
        date: 100,
        message: 'Read https://example.org/path now',
      }),
    );
    const empty = target.mapMessage(
      new Api.Message({
        id: 11,
        peerId,
        date: 100,
        message: 'https://www.instagram.com/p/example',
        media: new Api.MessageMediaWebPage({
          webpage: new Api.WebPageEmpty({
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
    const invoke = vi.fn().mockResolvedValue(new Api.UpdatesTooLong());
    (target as unknown as TransportInternals).client = { invoke };

    const peer = { id: 'u:11', kind: 'user' as const, accessHash: '91' };
    await target.setReaction(peer, 7, '🔥');
    await target.setReaction(peer, 7, 'custom:99');
    await target.setReaction(peer, 7);

    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.messages.SendReaction);
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
    const document = new Api.Document({
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
    const document = new Api.Document({
      id: 31n,
      accessHash: 32n,
      fileReference: new Uint8Array([3]),
      date: 1,
      mimeType: 'image/webp',
      size: 3n,
      dcId: 2,
      attributes: [
        new Api.DocumentAttributeSticker({
          alt: '🎉',
          stickerset: new Api.InputStickerSetEmpty(),
        }),
      ],
    });
    const result = new Api.messages.RecentStickers({
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
    const set = new Api.StickerSet({
      id: 41n,
      accessHash: 42n,
      title: 'Installed pack',
      shortName: 'installed_pack',
      count: 1,
      hash: 1,
    });
    const document = new Api.Document({
      id: 43n,
      accessHash: 44n,
      fileReference: new Uint8Array([4]),
      date: 1,
      mimeType: 'image/webp',
      size: 3n,
      dcId: 2,
      attributes: [
        new Api.DocumentAttributeSticker({
          alt: '🐈',
          stickerset: new Api.InputStickerSetID({ id: set.id, accessHash: set.accessHash }),
        }),
      ],
    });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(new Api.messages.AllStickers({ hash: 1n, sets: [set] }))
      .mockResolvedValueOnce(
        new Api.messages.StickerSet({ set, packs: [], keywords: [], documents: [document] }),
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
    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.messages.GetAllStickers);
    expect(invoke.mock.calls[1]?.[0]).toBeInstanceOf(Api.messages.GetStickerSet);
  });

  it('limits concurrent installed sticker-set requests', async () => {
    const sets = Array.from(
      { length: 9 },
      (_, index) =>
        new Api.StickerSet({
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
      if (request instanceof Api.messages.GetAllStickers) {
        return new Api.messages.AllStickers({ hash: 1n, sets });
      }
      const stickerRequest = request as Api.messages.GetStickerSet;
      const input = stickerRequest.stickerset as Api.InputStickerSetID;
      const set = sets.find(({ id }) => id === input.id)!;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return new Api.messages.StickerSet({ set, packs: [], keywords: [], documents: [] });
    });
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke };

    await target.getStickerPacks();

    expect(maximumActive).toBe(4);
    expect(invoke).toHaveBeenCalledTimes(10);
  });

  it('keeps usable installed sticker packs when another set fails to load', async () => {
    const failedSet = new Api.StickerSet({
      id: 61n,
      accessHash: 62n,
      title: 'Unavailable pack',
      shortName: 'unavailable_pack',
      count: 1,
      hash: 1,
    });
    const usableSet = new Api.StickerSet({
      id: 71n,
      accessHash: 72n,
      title: 'Usable pack',
      shortName: 'usable_pack',
      count: 1,
      hash: 1,
    });
    const document = new Api.Document({
      id: 73n,
      accessHash: 74n,
      fileReference: new Uint8Array([7]),
      date: 1,
      mimeType: 'image/webp',
      size: 3n,
      dcId: 2,
      attributes: [
        new Api.DocumentAttributeSticker({
          alt: '🙂',
          stickerset: new Api.InputStickerSetID({
            id: usableSet.id,
            accessHash: usableSet.accessHash,
          }),
        }),
      ],
    });
    const invoke = vi.fn(async (request: unknown) => {
      if (request instanceof Api.messages.GetAllStickers) {
        return new Api.messages.AllStickers({ hash: 1n, sets: [failedSet, usableSet] });
      }
      const input = (request as Api.messages.GetStickerSet).stickerset as Api.InputStickerSetID;
      if (input.id === failedSet.id) throw new Error('pack unavailable');
      return new Api.messages.StickerSet({
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
    const document = new Api.Document({
      id: 51n,
      accessHash: 52n,
      fileReference: new Uint8Array([5]),
      date: 1,
      mimeType: 'video/mp4',
      size: 10n,
      dcId: 2,
      attributes: [new Api.DocumentAttributeAnimated()],
    });
    const target = transport();
    const invoke = vi
      .fn()
      .mockResolvedValue(new Api.messages.SavedGifs({ hash: 1n, gifs: [document] }));
    (target as unknown as TransportInternals).client = { invoke };

    await expect(target.getSavedGifs()).resolves.toEqual([
      expect.objectContaining({ id: '51', accessHash: '52', emoji: 'GIF', mimeType: 'video/mp4' }),
    ]);
    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.messages.GetSavedGifs);
  });

  it('creates the correct input-peer type and preserves access hashes', () => {
    const target = transport() as unknown as TransportInternals;
    const user = target.inputPeer({ id: 'u:11', kind: 'user', accessHash: '91' });
    const group = target.inputPeer({ id: 'g:12', kind: 'group' });
    const channel = target.inputPeer({ id: 'c:13', kind: 'channel', accessHash: '93' });

    expect(user).toBeInstanceOf(Api.InputPeerUser);
    expect(user).toMatchObject({ userId: 11n, accessHash: 91n });
    expect(group).toBeInstanceOf(Api.InputPeerChat);
    expect(group).toMatchObject({ chatId: 12n });
    expect(channel).toBeInstanceOf(Api.InputPeerChannel);
    expect(channel).toMatchObject({ channelId: 13n, accessHash: 93n });
  });

  it('maps a Telegram too-long envelope to an explicit resynchronization signal', () => {
    const target = transport() as unknown as TransportInternals;
    expect(mappedUpdates(target, new Api.UpdatesTooLong())).toEqual([{ type: 'too-long' }]);
  });

  it('uses the global difference limit and rejects an oversized final difference', async () => {
    const finalDifference = new Api.updates.Difference({
      newMessages: [],
      newEncryptedMessages: [],
      otherUpdates: [
        new Api.UpdateDeleteMessages({ messages: [1], pts: 11, ptsCount: 1 }),
        new Api.UpdateDeleteMessages({ messages: [2], pts: 12, ptsCount: 1 }),
      ],
      chats: [],
      users: [],
      state: new Api.updates.State({ pts: 12, qts: 2, date: 20, seq: 3, unreadCount: 0 }),
    });
    const latestState = new Api.updates.State({
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
    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.updates.GetDifference);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      pts: 10,
      ptsLimit: 1,
      ptsTotalLimit: 1,
      qtsLimit: 1,
    });
    expect(invoke.mock.calls[1]?.[0]).toBeInstanceOf(Api.updates.GetState);
  });

  it('paginates channel differences from the supplied channel PTS', async () => {
    const firstMessage = new Api.Message({
      id: 21,
      peerId: new Api.PeerChannel({ channelId: 12n }),
      date: 100,
      message: 'Recovered one',
    });
    const secondMessage = new Api.Message({
      id: 22,
      peerId: new Api.PeerChannel({ channelId: 12n }),
      date: 101,
      message: 'Recovered two',
    });
    const channel = new Api.Channel({
      id: 12n,
      accessHash: 92n,
      title: 'Channel',
      photo: new Api.ChatPhotoEmpty(),
      date: 1,
    });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(
        new Api.updates.ChannelDifference({
          pts: 12,
          newMessages: [firstMessage],
          otherUpdates: [],
          chats: [channel],
          users: [],
        }),
      )
      .mockResolvedValueOnce(
        new Api.updates.ChannelDifference({
          final: true,
          pts: 13,
          newMessages: [secondMessage],
          otherUpdates: [
            new Api.UpdateReadChannelInbox({
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
      filter: expect.any(Api.ChannelMessagesFilterEmpty),
      pts: 10,
      limit: 100,
    });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ pts: 12, limit: 99 });
  });

  it('returns the authoritative PTS when a channel difference is too long', async () => {
    const result = new Api.updates.ChannelDifferenceTooLong({
      final: true,
      dialog: new Api.Dialog({
        peer: new Api.PeerChannel({ channelId: 12n }),
        topMessage: 50,
        readInboxMaxId: 40,
        readOutboxMaxId: 42,
        unreadCount: 10,
        unreadMentionsCount: 0,
        unreadReactionsCount: 0,
        unreadPollVotesCount: 0,
        notifySettings: new Api.PeerNotifySettings(),
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
      new Api.Updates({
        updates: [],
        users: [
          new Api.User({
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
      new Api.Updates({
        updates: [
          new Api.UpdateNewMessage({
            message: new Api.Message({
              id: 9,
              fromId: new Api.PeerUser({ userId: 404n }),
              peerId: new Api.PeerChat({ chatId: 303n }),
              date: 100,
              message: 'From a named author',
            }),
            pts: 4,
            ptsCount: 1,
          }),
        ],
        users: [
          new Api.User({
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
    const author = new Api.User({
      id: 404n,
      accessHash: 1404n,
      firstName: 'Dana',
      photo: new Api.UserProfilePhoto({ photoId: 900n, dcId: 2 }),
    });
    const history = new Api.messages.Messages({
      messages: [
        new Api.Message({
          id: 9,
          fromId: new Api.PeerUser({ userId: 404n }),
          peerId: new Api.PeerChannel({ channelId: 303n }),
          date: 100,
          message: 'Channel post',
          postAuthor: 'editor-in-chief',
        }),
      ],
      topics: [],
      users: [author],
      chats: [],
    });
    const administrators = new Api.channels.ChannelParticipants({
      count: 1,
      participants: [
        new Api.ChannelParticipantCreator({
          userId: 404n,
          adminRights: new Api.ChatAdminRights({}),
          rank: 'server-role',
        }),
      ],
      users: [author],
      chats: [],
    });
    const invoke = vi.fn((request: unknown) =>
      Promise.resolve(request instanceof Api.channels.GetParticipants ? administrators : history),
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
    expect(invoke.mock.calls[1]?.[0]).toBeInstanceOf(Api.channels.GetParticipants);
  });

  it('requests bounded history before the oldest id and maps the returned messages', async () => {
    const result = new Api.messages.Messages({
      messages: [
        new Api.Message({
          id: 7,
          peerId: new Api.PeerUser({ userId: 11n }),
          date: 100,
          message: 'History item',
        }),
        new Api.Message({
          id: 6,
          peerId: new Api.PeerUser({ userId: 11n }),
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
    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.messages.GetHistory);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ offsetId: 8, limit: 2 });
  });

  it('does not treat a full 50-message slice as the end of a 1,000-message history', async () => {
    const result = new Api.messages.MessagesSlice({
      count: 1_000,
      messages: Array.from(
        { length: 50 },
        (_, index) =>
          new Api.Message({
            id: 1_000 - index,
            peerId: new Api.PeerUser({ userId: 11n }),
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
    const result = new Api.messages.Messages({
      messages: Array.from(
        { length: 50 },
        (_, index) =>
          new Api.Message({
            id: 1_000 - index,
            peerId: new Api.PeerUser({ userId: 11n }),
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
      new Api.messages.Messages({
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
      .mockResolvedValueOnce(new Api.messages.AffectedMessages({ pts: 21, ptsCount: 1 }))
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
    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.messages.ReadHistory);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ maxId: 7 });
    expect(invoke.mock.calls[1]?.[0]).toBeInstanceOf(Api.channels.ReadHistory);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ maxId: 8 });
  });

  it('refreshes one peer read receipt without reloading dialogs or history', async () => {
    const peer = new Api.PeerUser({ userId: 11n });
    const result = new Api.messages.PeerDialogs({
      dialogs: [
        new Api.Dialog({
          peer,
          topMessage: 80,
          readInboxMaxId: 79,
          readOutboxMaxId: 80,
          unreadCount: 0,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          notifySettings: new Api.PeerNotifySettings(),
        }),
      ],
      messages: [],
      chats: [],
      users: [],
      state: new Api.updates.State({ pts: 1, qts: 1, date: 1, seq: 1, unreadCount: 0 }),
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.getReadOutboxMaxId({ id: 'u:11', kind: 'user', accessHash: '91' }),
    ).resolves.toBe(80);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.messages.GetPeerDialogs);
  });

  it('requests global photo, document, and link counts', async () => {
    const target = transport();
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(
        new Api.messages.MessagesSlice({
          count: 12,
          messages: [],
          topics: [],
          chats: [],
          users: [],
        }),
      )
      .mockResolvedValueOnce(
        new Api.messages.MessagesSlice({
          count: 3,
          messages: [],
          topics: [],
          chats: [],
          users: [],
        }),
      )
      .mockResolvedValueOnce(
        new Api.messages.MessagesSlice({
          count: 4,
          messages: [],
          topics: [],
          chats: [],
          users: [],
        }),
      );
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.getSharedMediaCounts({ id: 'u:11', kind: 'user', accessHash: '91' }),
    ).resolves.toEqual({ media: 12, files: 3, links: 4 });
    expect(invoke.mock.calls.map(([request]) => (request as { filter: unknown }).filter)).toEqual([
      expect.any(Api.InputMessagesFilterPhotoVideo),
      expect.any(Api.InputMessagesFilterDocument),
      expect.any(Api.InputMessagesFilterUrl),
    ]);
  });

  it('uses Telegram RPCs for search, shared content, pins, mute, and typing', async () => {
    const message = new Api.Message({
      id: 14,
      peerId: new Api.PeerUser({ userId: 11n }),
      date: 100,
      message: 'Search result',
    });
    const result = new Api.messages.Messages({
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
    expect(requests[0]).toBeInstanceOf(Api.messages.Search);
    expect(requests[1]).toBeInstanceOf(Api.messages.SearchGlobal);
    expect(requests[2]).toMatchObject({ filter: expect.any(Api.InputMessagesFilterUrl) });
    expect(requests[3]).toMatchObject({ filter: expect.any(Api.InputMessagesFilterPinned) });
    expect(requests[4]).toBeInstanceOf(Api.account.UpdateNotifySettings);
    expect(requests[5]).toBeInstanceOf(Api.messages.UpdatePinnedMessage);
    expect(requests[6]).toMatchObject({ action: expect.any(Api.SendMessageTypingAction) });
    expect(requests[7]).toMatchObject({ action: expect.any(Api.SendMessageCancelAction) });
  });

  it('passes search offsets through and reports another page from the probe result', async () => {
    const result = new Api.messages.MessagesSlice({
      count: 10,
      nextRate: 8,
      messages: [30, 29, 28].map(
        (id) =>
          new Api.Message({
            id,
            peerId: new Api.PeerUser({ userId: 11n }),
            date: id,
            message: `Result ${id}`,
          }),
      ),
      topics: [],
      chats: [],
      users: [new Api.User({ id: 11n, accessHash: 91n, firstName: 'Result user' })],
    });
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(result);
    (target as unknown as TransportInternals).client = { invoke };
    const peer = { id: 'u:11', kind: 'user' as const, accessHash: '91' };

    await expect(target.getSharedMedia(peer, 'media', 2, { messageId: 31 })).resolves.toMatchObject(
      {
        messages: [{ id: 30 }, { id: 29 }],
        hasMore: true,
        nextOffset: { messageId: 29 },
      },
    );
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
    const details = new Api.users.UserFull({
      fullUser: new Api.UserFull({
        id: 11n,
        about: 'Profile bio',
        blocked: true,
        birthday: new Api.Birthday({ day: 14, month: 3, year: 1994 }),
        settings: new Api.PeerSettings(),
        notifySettings: new Api.PeerNotifySettings(),
        commonChatsCount: 0,
      }),
      chats: [],
      users: [
        new Api.User({
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
    const affected = new Api.messages.AffectedHistory({ pts: 1, ptsCount: 1, offset: 0 });
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
    expect(requests[0]).toBeInstanceOf(Api.users.GetFullUser);
    expect(requests[1]).toMatchObject({
      id: expect.any(Api.InputUser),
      firstName: 'Mira',
      lastName: 'Lane',
      phone: '15550102048',
    });
    expect(requests[1]).toBeInstanceOf(Api.contacts.AddContact);
    expect(requests[2]).toBeInstanceOf(Api.contacts.DeleteContacts);
    expect(requests[3]).toBeInstanceOf(Api.contacts.Unblock);
    expect(requests[4]).toMatchObject({
      pinned: true,
      peer: expect.any(Api.InputDialogPeer),
    });
    expect(requests[5]).toBeInstanceOf(Api.messages.DeleteHistory);
  });

  it('maps typing and pinned-message updates', () => {
    const target = transport() as unknown as TransportInternals;
    expect(
      mappedUpdates(
        target,
        new Api.UpdateUserTyping({
          userId: 11n,
          action: new Api.SendMessageUploadPhotoAction({ progress: 50 }),
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
        new Api.UpdatePinnedChannelMessages({
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
        new Api.UpdatePinnedMessages({
          pinned: true,
          peer: new Api.PeerUser({ userId: 11n }),
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
        new Api.UpdateUserTyping({
          userId: 11n,
          action: new Api.SendMessageCancelAction(),
        }),
      ),
    ).toEqual([{ type: 'activity-ended', peerId: 'u:11', senderId: 'u:11' }]);
    expect(
      mappedUpdates(
        target,
        new Api.UpdateUserStatus({
          userId: 11n,
          status: new Api.UserStatusOnline({ expires: Math.floor(Date.now() / 1000) + 60 }),
        }),
      ),
    ).toEqual([{ type: 'presence-changed', peerId: 'u:11', presence: 'online' }]);
    expect(
      mappedUpdates(
        target,
        new Api.UpdateUserStatus({
          userId: 11n,
          status: new Api.UserStatusOffline({ wasOnline: 123 }),
        }),
      ),
    ).toEqual([{ type: 'presence-changed', peerId: 'u:11', presence: 'offline', lastSeenAt: 123 }]);
    expect(
      mappedUpdates(
        target,
        new Api.UpdateNotifySettings({
          peer: new Api.NotifyPeer({ peer: new Api.PeerUser({ userId: 11n }) }),
          notifySettings: new Api.PeerNotifySettings({ muteUntil: 2_147_483_647 }),
        }),
      ),
    ).toEqual([{ type: 'mute-changed', peerId: 'u:11', muted: true }]);
  });

  it('propagates channel and group leave update envelopes', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(
        new Api.Updates({ updates: [], users: [], chats: [], date: 120, seq: 4 }),
      )
      .mockResolvedValueOnce(
        new Api.Updates({ updates: [], users: [], chats: [], date: 121, seq: 5 }),
      );
    const target = transport();
    (target as unknown as TransportInternals).client = { invoke };

    await expect(
      target.deleteDialog({ id: 'c:12', kind: 'channel', accessHash: '92' }),
    ).resolves.toEqual({ updateBatches: [{ updates: [], date: 120, seq: 4 }] });
    await expect(target.deleteDialog({ id: 'g:13', kind: 'group' })).resolves.toEqual({
      updateBatches: [{ updates: [], date: 121, seq: 5 }],
    });
    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.channels.LeaveChannel);
    expect(invoke.mock.calls[1]?.[0]).toBeInstanceOf(Api.messages.DeleteChatUser);
  });

  it('returns the exact sent message from Telegram updates with the caller random id', async () => {
    const message = new Api.Message({
      id: 21,
      out: true,
      fromId: new Api.PeerUser({ userId: 11n }),
      peerId: new Api.PeerUser({ userId: 11n }),
      date: 100,
      message: 'Sent text',
    });
    const result = new Api.Updates({
      updates: [
        new Api.UpdateMessageID({ id: 21, randomId: 123n }),
        new Api.UpdateNewMessage({ message, pts: 2, ptsCount: 1 }),
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
        expect.any(Api.MessageEntityBold),
        expect.any(Api.MessageEntityItalic),
        expect.any(Api.MessageEntityUnderline),
        expect.any(Api.MessageEntityStrike),
        expect.any(Api.MessageEntityCode),
        expect.any(Api.MessageEntityPre),
        expect.any(Api.MessageEntitySpoiler),
        expect.any(Api.MessageEntityBlockquote),
        expect.any(Api.MessageEntityTextUrl),
      ],
    });
  });

  it('builds the exact sent message from Telegram short-send responses', async () => {
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(
      new Api.UpdateShortSentMessage({
        out: true,
        id: 23,
        pts: 3,
        ptsCount: 1,
        date: 102,
        entities: [new Api.MessageEntityBold({ offset: 0, length: 4 })],
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
      .mockResolvedValue(
        new Api.InputFile({ id: 4n, parts: 1, name: 'report.pdf', md5Checksum: '' }),
      );
    const invoke = vi.fn().mockResolvedValue(
      new Api.UpdateShortSentMessage({
        out: true,
        id: 24,
        pts: 4,
        ptsCount: 1,
        date: 103,
        media: new Api.MessageMediaDocument({
          document: new Api.Document({
            id: 204n,
            accessHash: 205n,
            fileReference: new Uint8Array([2, 0, 4]),
            date: 103,
            mimeType: 'application/pdf',
            size: 6n,
            dcId: 2,
            attributes: [new Api.DocumentAttributeFilename({ fileName: 'report.pdf' })],
          }),
        }),
        entities: [new Api.MessageEntityBold({ offset: 0, length: 4 })],
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
    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.messages.SendMedia);
  });

  it('maps a short-send document sticker response without retrying the accepted send', async () => {
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(
      new Api.UpdateShortSentMessage({
        out: true,
        id: 25,
        pts: 5,
        ptsCount: 1,
        date: 104,
        media: new Api.MessageMediaDocument({
          document: new Api.Document({
            id: 305n,
            accessHash: 306n,
            fileReference: new Uint8Array([3, 0, 5]),
            date: 104,
            mimeType: 'image/webp',
            size: 7n,
            dcId: 2,
            attributes: [
              new Api.DocumentAttributeSticker({
                alt: '🎉',
                stickerset: new Api.InputStickerSetEmpty(),
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
      media: expect.any(Api.InputMediaDocument),
      randomId: 405n,
      replyTo: expect.objectContaining({ replyToMsgId: 11, quoteText: 'Quoted sticker' }),
    });
  });

  it('fetches an inline result by returned id when its short response omits content', async () => {
    const target = transport();
    const sent = new Api.Message({
      id: 26,
      out: true,
      peerId: new Api.PeerUser({ userId: 11n }),
      date: 105,
      message: 'GIF caption',
      replyTo: new Api.MessageReplyHeader({ replyToMsgId: 12, quoteText: 'Quoted GIF' }),
      media: new Api.MessageMediaDocument({
        document: new Api.Document({
          id: 406n,
          accessHash: 407n,
          fileReference: new Uint8Array([4, 0, 6]),
          date: 105,
          mimeType: 'image/gif',
          size: 8n,
          dcId: 2,
          attributes: [
            new Api.DocumentAttributeFilename({ fileName: 'result.gif' }),
            new Api.DocumentAttributeAnimated(),
          ],
        }),
      }),
    });
    const invoke = vi.fn(async (request: unknown) => {
      if (request instanceof Api.messages.SendInlineBotResult) {
        return new Api.UpdateShortSentMessage({
          out: true,
          id: 26,
          pts: 6,
          ptsCount: 1,
          date: 105,
        });
      }
      if (request instanceof Api.messages.GetMessages) {
        return new Api.messages.Messages({
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
    expect(invoke.mock.calls[1]?.[0]).toBeInstanceOf(Api.messages.GetMessages);
  });

  it('forces an uploaded image to a document when sent in file mode', async () => {
    const target = transport();
    const uploadFile = vi
      .fn()
      .mockResolvedValue(
        new Api.InputFile({ id: 1n, parts: 1, name: 'photo.jpg', md5Checksum: '' }),
      );
    const invoke = vi.fn().mockResolvedValue(
      new Api.Updates({
        updates: [
          new Api.UpdateNewMessage({
            message: new Api.Message({
              id: 31,
              out: true,
              peerId: new Api.PeerUser({ userId: 11n }),
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

    const request = invoke.mock.calls[0]?.[0] as Api.messages.SendMedia;
    expect(request).toBeInstanceOf(Api.messages.SendMedia);
    expect(request.media).toBeInstanceOf(Api.InputMediaUploadedDocument);
    expect(request.media).toMatchObject({ forceFile: true, mimeType: 'image/jpeg' });
  });

  it('keeps a GIF sent in file mode as a plain document', async () => {
    const target = transport();
    (target as unknown as TransportInternals).client = {
      invoke: vi.fn(),
      uploadFile: vi
        .fn()
        .mockResolvedValue(
          new Api.InputFile({ id: 2n, parts: 1, name: 'image.gif', md5Checksum: '' }),
        ),
    };

    const media = await (
      target as unknown as {
        uploadInputMedia(
          file: File,
          sendAs: 'media' | 'file',
          asSticker: boolean,
        ): Promise<Api.TypeInputMedia>;
      }
    ).uploadInputMedia(new File(['gif'], 'image.gif', { type: 'image/gif' }), 'file', false);

    expect(media).toMatchObject({ forceFile: true, mimeType: 'image/gif' });
    expect(media).toBeInstanceOf(Api.InputMediaUploadedDocument);
    expect((media as Api.InputMediaUploadedDocument).attributes).toEqual([
      expect.any(Api.DocumentAttributeFilename),
    ]);
  });

  it('adds Telegram video metadata when uploading a video in media mode', async () => {
    const target = transport();
    const uploadFile = vi
      .fn()
      .mockResolvedValue(
        new Api.InputFile({ id: 3n, parts: 1, name: 'clip.mp4', md5Checksum: '' }),
      );
    vi.spyOn(
      target as unknown as {
        readVideoMetadata(file: File): Promise<{
          duration: number;
          width: number;
          height: number;
        }>;
      },
      'readVideoMetadata',
    ).mockResolvedValue({ duration: 12.5, width: 1280, height: 720 });
    const invoke = vi.fn().mockResolvedValue(
      new Api.Updates({
        updates: [
          new Api.UpdateNewMessage({
            message: new Api.Message({
              id: 33,
              out: true,
              peerId: new Api.PeerUser({ userId: 11n }),
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

    const request = invoke.mock.calls[0]?.[0] as Api.messages.SendMedia;
    const media = request.media as Api.InputMediaUploadedDocument;
    expect(media).toBeInstanceOf(Api.InputMediaUploadedDocument);
    expect(media.attributes).toEqual([
      expect.any(Api.DocumentAttributeFilename),
      expect.objectContaining({
        duration: 12.5,
        w: 1280,
        h: 720,
        supportsStreaming: true,
      }),
    ]);
    expect(media.attributes[1]).toBeInstanceOf(Api.DocumentAttributeVideo);
  });

  it('sends media attachments as one Telegram album with stable item ids', async () => {
    const target = transport();
    const uploadFile = vi
      .fn()
      .mockResolvedValueOnce(
        new Api.InputFile({ id: 1n, parts: 1, name: 'one.png', md5Checksum: '' }),
      )
      .mockResolvedValueOnce(
        new Api.InputFile({ id: 2n, parts: 1, name: 'two.gif', md5Checksum: '' }),
      );
    const sentUpdates = new Api.Updates({
      updates: [
        new Api.UpdateMessageID({ id: 41, randomId: 401n }),
        new Api.UpdateMessageID({ id: 42, randomId: 402n }),
        new Api.UpdateNewMessage({
          message: new Api.Message({
            id: 41,
            out: true,
            peerId: new Api.PeerUser({ userId: 11n }),
            groupedId: 900n,
            date: 104,
            message: 'Album caption',
          }),
          pts: 41,
          ptsCount: 1,
        }),
        new Api.UpdateNewMessage({
          message: new Api.Message({
            id: 42,
            out: true,
            peerId: new Api.PeerUser({ userId: 11n }),
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
      if (request instanceof Api.messages.UploadMedia) {
        uploadedIndex += 1;
        if (uploadedIndex === 2) {
          return new Api.MessageMediaDocument({
            document: new Api.Document({
              id: 2n,
              accessHash: 102n,
              fileReference: new Uint8Array([2]),
              date: 104,
              mimeType: 'image/gif',
              size: 3n,
              dcId: 2,
              attributes: [
                new Api.DocumentAttributeFilename({ fileName: 'two.gif' }),
                new Api.DocumentAttributeAnimated(),
              ],
            }),
          });
        }
        return new Api.MessageMediaPhoto({
          photo: new Api.Photo({
            id: BigInt(uploadedIndex),
            accessHash: BigInt(100 + uploadedIndex),
            fileReference: new Uint8Array([uploadedIndex]),
            date: 104,
            sizes: [],
            dcId: 2,
          }),
        });
      }
      if (request instanceof Api.messages.SendMultiMedia) return sentUpdates;
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
      media: expect.any(Api.InputMediaUploadedPhoto),
    });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      media: expect.any(Api.InputMediaUploadedDocument),
    });
    const request = invoke.mock.calls[2]?.[0] as Api.messages.SendMultiMedia;
    expect(request).toBeInstanceOf(Api.messages.SendMultiMedia);
    expect(request.replyTo).toMatchObject({ replyToMsgId: 9 });
    expect(request.multiMedia).toEqual([
      expect.objectContaining({
        randomId: 401n,
        message: 'Album caption',
        media: expect.any(Api.InputMediaPhoto),
        entities: [expect.any(Api.MessageEntityBold)],
      }),
      expect.objectContaining({
        randomId: 402n,
        message: '',
        media: expect.any(Api.InputMediaDocument),
      }),
    ]);
  });

  it('uploads replacement media as part of an edit request', async () => {
    const target = transport();
    const uploadFile = vi
      .fn()
      .mockResolvedValue(
        new Api.InputFile({ id: 3n, parts: 1, name: 'replacement.png', md5Checksum: '' }),
      );
    const invoke = vi
      .fn()
      .mockResolvedValue(new Api.Updates({ updates: [], users: [], chats: [], date: 105, seq: 1 }));
    (target as unknown as TransportInternals).client = { invoke, uploadFile };
    vi.spyOn(target, 'getHistoryAround').mockResolvedValue([
      {
        id: 21,
        peerId: 'u:11',
        senderId: 'self',
        text: 'Edited caption',
        date: 105,
        outgoing: true,
        media: { kind: 'photo', name: 'replacement.png', mimeType: 'image/png' },
      },
    ]);

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

    const request = invoke.mock.calls[0]?.[0] as Api.messages.EditMessage;
    expect(request).toBeInstanceOf(Api.messages.EditMessage);
    expect(request.media).toBeInstanceOf(Api.InputMediaUploadedPhoto);
  });

  it('does not mistake an identical outgoing history message for the current send', async () => {
    const target = transport();
    const result = new Api.Updates({ updates: [], users: [], chats: [], date: 100, seq: 1 });
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
        new Api.UpdateDialogPinned({
          pinned: true,
          peer: new Api.DialogPeer({ peer: new Api.PeerUser({ userId: 11n }) }),
        }),
      ),
    ).toEqual([{ type: 'dialog-pinned', peerId: 'u:11', pinned: true }]);
    expect(mappedUpdates(target, new Api.UpdatePinnedDialogs())).toEqual([
      { type: 'dialog-list-invalidated' },
    ]);
    expect(
      mappedUpdates(
        target,
        new Api.UpdateFolderPeers({
          folderPeers: [
            new Api.FolderPeer({ peer: new Api.PeerUser({ userId: 11n }), folderId: 1 }),
          ],
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
    expect(
      mappedUpdates(target, new Api.UpdateChannelTooLong({ channelId: 12n, pts: 44 })),
    ).toEqual([{ type: 'channel-too-long', peerId: 'c:12' }]);
  });

  it('maps sticker and GIF index invalidations', () => {
    const target = transport() as unknown as TransportInternals;
    expect(mappedUpdates(target, new Api.UpdateStickerSets())).toEqual([
      { type: 'expression-index-changed', kind: 'stickers' },
    ]);
    expect(mappedUpdates(target, new Api.UpdateRecentStickers())).toEqual([
      { type: 'expression-index-changed', kind: 'stickers' },
    ]);
    expect(mappedUpdates(target, new Api.UpdateSavedGifs())).toEqual([
      { type: 'expression-index-changed', kind: 'gifs' },
    ]);
    expect(
      mappedUpdates(
        target,
        new Api.UpdateBotCommands({
          peer: new Api.PeerChat({ chatId: 12n }),
          botId: 7n,
          commands: [new Api.BotCommand({ command: 'help', description: 'Help' })],
        }),
      ),
    ).toEqual([{ type: 'bot-commands-changed', peerId: 'g:12', botId: 'u:7' }]);
  });

  it('forwards through Telegram and returns the message created in the target chat', async () => {
    const message = new Api.Message({
      id: 31,
      out: true,
      fromId: new Api.PeerUser({ userId: 11n }),
      peerId: new Api.PeerChannel({ channelId: 12n }),
      date: 100,
      message: 'Forwarded text',
    });
    const result = new Api.Updates({
      updates: [new Api.UpdateNewChannelMessage({ message, pts: 2, ptsCount: 1 })],
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
    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.messages.ForwardMessages);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ id: [30], randomId: [987n] });
  });

  it('fetches a forwarded message by returned id after a short success response', async () => {
    const target = transport();
    const forwarded = new Api.Message({
      id: 32,
      out: true,
      peerId: new Api.PeerChannel({ channelId: 12n }),
      date: 101,
      message: 'Fetched forwarded text',
    });
    const invoke = vi.fn(async (request: unknown) => {
      if (request instanceof Api.messages.ForwardMessages) {
        return new Api.UpdateShortSentMessage({
          out: true,
          id: 32,
          pts: 3,
          ptsCount: 1,
          date: 101,
        });
      }
      if (request instanceof Api.channels.GetMessages) {
        return new Api.messages.Messages({
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
    expect(invoke.mock.calls[1]?.[0]).toBeInstanceOf(Api.channels.GetMessages);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      channel: expect.objectContaining({ channelId: 12n, accessHash: 92n }),
      id: [expect.objectContaining({ id: 32 })],
    });
  });

  it('retrieves the edited message around its id when Telegram omits it from updates', async () => {
    const target = transport();
    const edited = new Api.Message({
      id: 21,
      out: true,
      peerId: new Api.PeerUser({ userId: 11n }),
      date: 100,
      message: 'Edited old message',
    });
    const invoke = vi.fn(async (request: unknown) => {
      if (request instanceof Api.messages.EditMessage) {
        return new Api.Updates({ updates: [], users: [], chats: [], date: 100, seq: 1 });
      }
      return new Api.messages.Messages({
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
      entities: [expect.any(Api.MessageEntityBold)],
    });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ offsetId: 21, addOffset: -1, limit: 3 });
  });

  it('uses the correct deletion RPC for channels and ordinary chats', async () => {
    const target = transport();
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(new Api.messages.AffectedMessages({ pts: 20, ptsCount: 1 }))
      .mockResolvedValueOnce(new Api.messages.AffectedMessages({ pts: 21, ptsCount: 1 }));
    (target as unknown as TransportInternals).client = { invoke };

    await target.deleteMessages({ id: 'u:11', kind: 'user', accessHash: '91' }, [4], true);
    await target.deleteMessages({ id: 'c:12', kind: 'channel', accessHash: '92' }, [5], true);

    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.messages.DeleteMessages);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ id: [4], revoke: true });
    expect(invoke.mock.calls[1]?.[0]).toBeInstanceOf(Api.channels.DeleteMessages);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ id: [5] });
  });

  it('downloads media only after its Telegram media reference has been mapped', async () => {
    const target = transport();
    const invoke = vi.fn();
    const downloadMedia = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    (target as unknown as TransportInternals).client = { invoke, downloadMedia };
    const telegramMessage = new Api.Message({
      id: 7,
      peerId: new Api.PeerUser({ userId: 11n }),
      date: 100,
      message: '',
      media: new Api.MessageMediaDocument({
        document: new Api.Document({
          id: 1n,
          accessHash: 2n,
          fileReference: new Uint8Array(),
          date: 100,
          mimeType: 'text/plain',
          size: 3n,
          dcId: 2,
          attributes: [new Api.DocumentAttributeFilename({ fileName: 'file.txt' })],
        }),
      }),
    });
    const mapped = (
      target as unknown as {
        mapMessage(message: Api.TypeMessage):
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

    const blob = await target.downloadMedia(mapped);
    expect(blob.size).toBe(3);
    expect(blob.type).toBe('text/plain');
    expect(downloadMedia).toHaveBeenCalledOnce();
    await expect(target.downloadMedia({ ...mapped, id: 8 })).rejects.toThrow(
      'Media data is no longer in memory',
    );
  });

  it('bounds raw message media references and clears runtime caches on disconnect', async () => {
    const target = transport();
    const document = new Api.Document({
      id: 1n,
      accessHash: 2n,
      fileReference: new Uint8Array(),
      date: 100,
      mimeType: 'text/plain',
      size: 3n,
      dcId: 2,
      attributes: [new Api.DocumentAttributeFilename({ fileName: 'file.txt' })],
    });
    const internals = target as unknown as {
      messageMedia: Map<string, unknown>;
      stickerDocuments: Map<string, unknown>;
      entities: Map<string, unknown>;
      mapMessage(message: Api.TypeMessage): unknown;
    };
    for (let id = 1; id <= 1_005; id += 1) {
      internals.mapMessage(
        new Api.Message({
          id,
          peerId: new Api.PeerUser({ userId: 11n }),
          date: id,
          message: '',
          media: new Api.MessageMediaDocument({ document }),
        }),
      );
    }

    expect(internals.messageMedia.size).toBe(1_000);
    expect(internals.messageMedia.has('u:11:1')).toBe(false);
    expect(internals.messageMedia.has('u:11:1005')).toBe(true);
    internals.stickerDocuments.set('sticker', document);
    internals.entities.set('u:11', new Api.User({ id: 11n }));

    await target.disconnect();

    expect(internals.messageMedia.size).toBe(0);
    expect(internals.stickerDocuments.size).toBe(0);
    expect(internals.entities.size).toBe(0);
  });

  it('maps inline and reply bot keyboards without exposing unsupported button actions', () => {
    const target = transport() as unknown as {
      entities: Map<string, Api.TypeUser | Api.TypeChat>;
      mapMessage(message: Api.TypeMessage): {
        botKeyboard?: { kind: string; rows: Array<Array<Record<string, unknown>>> };
      };
    };
    target.entities.set(
      'u:7',
      new Api.User({
        id: 7n,
        accessHash: 77n,
        firstName: 'Inline Bot',
        username: 'inline_fixture_bot',
        bot: true,
      }),
    );
    const inline = target.mapMessage(
      new Api.Message({
        id: 30,
        peerId: new Api.PeerChat({ chatId: 12n }),
        fromId: new Api.PeerUser({ userId: 7n }),
        date: 1,
        message: 'Choose',
        replyMarkup: new Api.ReplyInlineMarkup({
          rows: [
            new Api.KeyboardButtonRow({
              buttons: [
                new Api.KeyboardButtonCallback({
                  text: 'Refresh',
                  data: new Uint8Array([1, 2, 3]),
                }),
                new Api.KeyboardButtonUrl({ text: 'Docs', url: 'https://example.com/docs' }),
                new Api.KeyboardButtonUrlAuth({
                  text: 'Sign in',
                  url: 'https://example.com/auth',
                  buttonId: 4,
                }),
                new Api.KeyboardButtonCopy({ text: 'Copy', copyText: 'fixture-value' }),
                new Api.KeyboardButtonSwitchInline({
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
      new Api.Message({
        id: 31,
        peerId: new Api.PeerUser({ userId: 7n }),
        date: 2,
        message: 'Reply',
        replyMarkup: new Api.ReplyKeyboardMarkup({
          resize: true,
          persistent: true,
          placeholder: 'Pick one',
          rows: [
            new Api.KeyboardButtonRow({
              buttons: [
                new Api.KeyboardButton({ text: 'Status' }),
                new Api.KeyboardButtonRequestGeoLocation({ text: 'Location' }),
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
    const bot = new Api.User({
      id: 7n,
      accessHash: 77n,
      firstName: 'Fixture Bot',
      bot: true,
    });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(
        new Api.UrlAuthResultRequest({
          requestWriteAccess: true,
          requestPhoneNumber: true,
          bot,
          domain: 'example.com',
          matchCodes: ['1234'],
          matchCodesFirst: true,
        }),
      )
      .mockResolvedValueOnce(
        new Api.UrlAuthResultAccepted({ url: 'https://example.com/authenticated' }),
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
    const fullUser = new Api.users.UserFull({
      fullUser: new Api.UserFull({
        id: 7n,
        settings: new Api.PeerSettings(),
        notifySettings: new Api.PeerNotifySettings(),
        commonChatsCount: 0,
        botInfo: new Api.BotInfo({
          commands: [new Api.BotCommand({ command: 'help', description: 'Show help' })],
        }),
      }),
      chats: [],
      users: [new Api.User({ id: 7n, accessHash: 77n, firstName: 'Fixture Bot', bot: true })],
    });
    const startUpdates = new Api.Updates({
      updates: [
        new Api.UpdateNewMessage({
          message: new Api.Message({
            id: 44,
            out: true,
            peerId: new Api.PeerUser({ userId: 7n }),
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
    const callback = new Api.messages.BotCallbackAnswer({
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
    expect(invoke.mock.calls[1]?.[0]).toBeInstanceOf(Api.messages.SendMessage);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ randomId: 987n, message: '/start' });
    expect(invoke.mock.calls[2]?.[0]).toBeInstanceOf(Api.messages.StartBot);
    expect(invoke.mock.calls[2]?.[0]).toMatchObject({
      randomId: 988n,
      startParam: 'deep-link',
    });
    expect(invoke.mock.calls[3]?.[0]).toMatchObject({ msgId: 44, data: new Uint8Array([4, 5]) });
  });

  it('loads chat-scoped command menus for every bot in a basic group', async () => {
    const target = transport();
    const invoke = vi.fn().mockResolvedValue(
      new Api.messages.ChatFull({
        fullChat: new Api.ChatFull({
          id: 12n,
          about: '',
          participants: new Api.ChatParticipantsForbidden({ chatId: 12n }),
          notifySettings: new Api.PeerNotifySettings(),
          botInfo: [
            new Api.BotInfo({
              userId: 7n,
              commands: [new Api.BotCommand({ command: 'help', description: 'Show help' })],
            }),
            new Api.BotInfo({
              userId: 8n,
              commands: [new Api.BotCommand({ command: 'weather', description: 'Show weather' })],
            }),
          ],
        }),
        chats: [new Api.ChatForbidden({ id: 12n, title: 'Bots group' })],
        users: [
          new Api.User({
            id: 7n,
            accessHash: 77n,
            firstName: 'Helper Bot',
            username: 'helper_bot',
            bot: true,
          }),
          new Api.User({
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
    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.messages.GetFullChat);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ chatId: 12n });
  });

  it('fetches the exact bot-start message after a short success response', async () => {
    const target = transport();
    const peer = { id: 'u:7', kind: 'user' as const, accessHash: '77' };
    const started = new Api.Message({
      id: 45,
      out: true,
      peerId: new Api.PeerUser({ userId: 7n }),
      date: 11,
      message: '/start',
    });
    const invoke = vi.fn(async (request: unknown) => {
      if (request instanceof Api.messages.StartBot) {
        return new Api.UpdateShortSentMessage({
          out: true,
          id: 45,
          pts: 2,
          ptsCount: 1,
          date: 11,
        });
      }
      if (request instanceof Api.messages.GetMessages) {
        return new Api.messages.Messages({
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
    expect(invoke.mock.calls[1]?.[0]).toBeInstanceOf(Api.messages.GetMessages);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      id: [expect.objectContaining({ id: 45 })],
    });
  });

  it('surfaces a failed authorization-session write when the transport is flushed', async () => {
    const target = transport();
    const internals = target as unknown as { sessionSaveError: unknown };
    internals.sessionSaveError = new Error('IndexedDB is unavailable');

    await expect(target.disconnect()).rejects.toThrow(
      'Could not persist the Telegram authorization session. IndexedDB is unavailable',
    );
  });
});
