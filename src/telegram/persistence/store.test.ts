import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { IndexedDbCacheStore } from './store';
import type { CachedDialog, CachedMessage, PendingSend, TelegramPeer } from '../types';

const peer: TelegramPeer = { id: 'peer-1', kind: 'user' };
const secondPeer: TelegramPeer = { id: 'peer-2', kind: 'group' };

function databaseName() {
  return `televecha-test-${crypto.randomUUID()}`;
}

function cachedDialog(target: TelegramPeer, title: string): CachedDialog {
  return {
    peer: target,
    title,
    initials: title[0] ?? '?',
    color: '#765cff',
    topMessageId: 0,
    unreadCount: 0,
    readInboxMaxId: 0,
    readOutboxMaxId: 0,
    muted: false,
    pinned: false,
    hasAvatar: false,
    cacheEpoch: 1,
  };
}

function cachedMessage(target: TelegramPeer, id: number): CachedMessage {
  return {
    id,
    peerId: target.id,
    senderId: target.id,
    text: `${target.id}-${id}`,
    date: id,
    outgoing: false,
    cacheEpoch: 1,
  };
}

function pending(id: string, createdAt: number): PendingSend {
  return {
    id,
    peer,
    text: id,
    randomId: id,
    createdAt,
    attempts: 0,
  };
}

describe('IndexedDbCacheStore', () => {
  it('round-trips transport session, cursor, epoch, and the last peer', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    const cursor = { pts: 4, qts: 3, date: 2, seq: 1 };

    expect(await store.loadTransportSession()).toBeUndefined();
    await store.saveTransportSession({ dcId: 2 });
    await store.saveCursor(cursor);
    await store.saveLastPeerId(peer.id);
    expect(await store.beginNewEpoch()).toBe(1);
    expect(await store.beginNewEpoch()).toBe(2);

    expect(await store.loadTransportSession()).toEqual({ dcId: 2 });
    expect(await store.loadCursor()).toEqual(cursor);
    expect(await store.loadLastPeerId()).toBe(peer.id);
    expect(await store.loadEpoch()).toBe(2);
    await store.saveTransportSession(undefined);
    expect(await store.loadTransportSession()).toBeUndefined();
  });

  it('atomically commits a latest-state snapshot without clearing durable local data', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    const oldCursor = { pts: 1, qts: 1, date: 1, seq: 1 };
    const nextCursor = { pts: 20, qts: 3, date: 30, seq: 4 };
    await store.saveCursor(oldCursor);
    await store.beginNewEpoch();
    await store.replaceDialogs([
      cachedDialog(peer, 'Old first'),
      cachedDialog(secondPeer, 'Old second'),
    ]);
    await store.replaceMessages(peer.id, [cachedMessage(peer, 1)]);
    await store.replaceMessages(secondPeer.id, [cachedMessage(secondPeer, 2)]);
    await store.saveDraft(peer.id, 'Keep this draft', 5);
    await store.commitOutbox(pending('keep-this-send', 10));
    await store.saveBlob('sticker-index:packs:v2', new Blob(['discard']));
    await store.saveBlob('media:peer-1:7', new Blob(['preserve']));

    const epoch = await store.commitLatestState({
      cursor: nextCursor,
      dialogs: [cachedDialog(secondPeer, 'Current second')],
      activeHistory: {
        peerId: secondPeer.id,
        messages: [{ ...cachedMessage(secondPeer, 9), text: 'Current message' }],
      },
      discardBlobKeys: ['sticker-index:packs:v2'],
    });

    expect(epoch).toBe(2);
    expect(await store.loadEpoch()).toBe(2);
    expect(await store.loadCursor()).toEqual(nextCursor);
    expect(await store.loadDialogs()).toEqual([
      expect.objectContaining({
        peer: secondPeer,
        title: 'Current second',
        cacheEpoch: 2,
      }),
    ]);
    expect(await store.loadMessages(peer.id)).toEqual([]);
    expect(await store.loadMessages(secondPeer.id)).toEqual([
      expect.objectContaining({ id: 9, text: 'Current message', cacheEpoch: 2 }),
    ]);
    expect(await store.loadDrafts()).toEqual({ [peer.id]: 'Keep this draft' });
    expect(await store.loadOutbox()).toEqual([expect.objectContaining({ id: 'keep-this-send' })]);
    expect(await store.loadBlob('sticker-index:packs:v2')).toBeUndefined();
    expect(await (await store.loadBlob('media:peer-1:7'))?.text()).toBe('preserve');
  });

  it('rolls back every latest-state change when a snapshot record cannot be cloned', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    const cursor = { pts: 1, qts: 1, date: 1, seq: 1 };
    await store.saveCursor(cursor);
    await store.beginNewEpoch();
    await store.replaceDialogs([cachedDialog(peer, 'Existing')]);
    await store.replaceMessages(peer.id, [cachedMessage(peer, 1)]);
    await store.saveBlob('sticker-index:packs:v2', new Blob(['existing']));
    const invalidDialog = {
      ...cachedDialog(secondPeer, 'Invalid'),
      invalidValue: () => undefined,
    } as unknown as CachedDialog;

    await expect(
      store.commitLatestState({
        cursor: { pts: 20, qts: 2, date: 20, seq: 2 },
        dialogs: [invalidDialog],
        discardBlobKeys: ['sticker-index:packs:v2'],
      }),
    ).rejects.toBeDefined();

    expect(await store.loadEpoch()).toBe(1);
    expect(await store.loadCursor()).toEqual(cursor);
    expect(await store.loadDialogs()).toEqual([
      expect.objectContaining({ peer, title: 'Existing' }),
    ]);
    expect(await store.loadMessages(peer.id)).toEqual([
      expect.objectContaining({ id: 1, peerId: peer.id }),
    ]);
    expect(await (await store.loadBlob('sticker-index:packs:v2'))?.text()).toBe('existing');
  });

  it('replaces the dialog list and upserts a single dialog by peer id', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.replaceDialogs([cachedDialog(peer, 'First'), cachedDialog(secondPeer, 'Second')]);
    await store.putDialog(cachedDialog(peer, 'First renamed'));

    const dialogs = await store.loadDialogs();
    expect(dialogs).toHaveLength(2);
    expect(dialogs.find(({ peer: target }) => target.id === peer.id)?.title).toBe('First renamed');
    await store.replaceDialogs([cachedDialog(secondPeer, 'Only')]);
    expect((await store.loadDialogs()).map(({ title }) => title)).toEqual(['Only']);
  });

  it('replaces messages only for the requested peer and upserts by composite key', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.replaceMessages(peer.id, [cachedMessage(peer, 1), cachedMessage(peer, 2)]);
    await store.replaceMessages(secondPeer.id, [cachedMessage(secondPeer, 1)]);
    await store.replaceMessages(peer.id, [cachedMessage(peer, 3)]);
    await store.putMessage({ ...cachedMessage(peer, 3), text: 'updated' });

    expect(await store.loadMessages(peer.id)).toEqual([
      expect.objectContaining({ id: 3, text: 'updated' }),
    ]);
    expect(await store.loadMessages(secondPeer.id)).toEqual([
      expect.objectContaining({ id: 1, peerId: secondPeer.id }),
    ]);

    await store.putMessages([cachedMessage(peer, 4), cachedMessage(peer, 5)]);
    expect((await store.loadMessages(peer.id)).map(({ id }) => id)).toEqual([3, 4, 5]);
  });

  it('preserves album, service-event, and inline media metadata in cached history', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.putMessages([
      {
        ...cachedMessage(peer, 1),
        groupedId: 'album-1',
        media: {
          kind: 'voice',
          name: 'voice.ogg',
          mimeType: 'audio/ogg',
          duration: 9,
        },
      },
      {
        ...cachedMessage(peer, 2),
        text: 'Alice pinned a message',
        service: {
          kind: 'message-pinned',
          text: 'Alice pinned a message',
          actorId: 'u:1',
        },
      },
    ]);

    expect(await store.loadMessages(peer.id)).toEqual([
      expect.objectContaining({
        groupedId: 'album-1',
        media: expect.objectContaining({ kind: 'voice', duration: 9 }),
      }),
      expect.objectContaining({
        service: expect.objectContaining({ kind: 'message-pinned' }),
      }),
    ]);
  });

  it('bounds peer history reads and can fetch one older cached message exactly', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.putMessages(
      Array.from({ length: 520 }, (_, index) => cachedMessage(peer, index + 1)),
    );

    const defaultWindow = await store.loadMessages(peer.id);
    expect(defaultWindow).toHaveLength(500);
    expect(defaultWindow[0]?.id).toBe(21);
    expect(defaultWindow.at(-1)?.id).toBe(520);
    expect((await store.loadMessages(peer.id, 10)).map(({ id }) => id)).toEqual([
      511, 512, 513, 514, 515, 516, 517, 518, 519, 520,
    ]);
    expect((await store.loadMessagesBefore(peer.id, 511, 10)).map(({ id }) => id)).toEqual([
      501, 502, 503, 504, 505, 506, 507, 508, 509, 510,
    ]);
    await expect(store.loadMessage(peer.id, 1)).resolves.toEqual(
      expect.objectContaining({ id: 1, peerId: peer.id }),
    );
  });

  it('claims legacy data for an existing authorized account without clearing it', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.replaceDialogs([cachedDialog(peer, 'Existing')]);
    await store.saveDraft(peer.id, 'keep me');
    await store.commitOutbox(pending('legacy', 1));

    await store.claimAccount('account-a');

    expect(await store.loadAccountId()).toBe('account-a');
    expect(await store.loadDialogs()).toHaveLength(1);
    expect(await store.loadDrafts()).toEqual({ [peer.id]: 'keep me' });
    expect(await store.loadOutbox()).toEqual([
      expect.objectContaining({ id: 'legacy', accountId: 'account-a' }),
    ]);
  });

  it('clears account-scoped cache while quarantining another account outbox', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.claimAccount('account-a');
    await store.saveTransportSession({ dcId: 2 });
    await store.replaceDialogs([cachedDialog(peer, 'Old account')]);
    await store.replaceMessages(peer.id, [cachedMessage(peer, 1)]);
    await store.saveDraft(peer.id, 'old draft');
    await store.commitOutbox({ ...pending('old-send', 1), accountId: 'account-a' });
    await store.saveCursor({ pts: 1, qts: 0, date: 1, seq: 1 });
    await store.beginNewEpoch();
    await store.saveLastPeerId(peer.id);
    await store.saveBlob('old-file', new Blob(['old']));

    await store.resetForAccount('account-b');

    expect(await store.loadAccountId()).toBe('account-b');
    expect(await store.loadTransportSession()).toEqual({ dcId: 2 });
    expect(await store.loadDialogs()).toEqual([]);
    expect(await store.loadMessages(peer.id)).toEqual([]);
    expect(await store.loadDrafts()).toEqual({});
    expect(await store.loadCursor()).toBeUndefined();
    expect(await store.loadEpoch()).toBe(0);
    expect(await store.loadLastPeerId()).toBeUndefined();
    expect(await store.loadBlob('old-file')).toBeUndefined();
    expect(await store.loadOutbox()).toEqual([
      expect.objectContaining({ id: 'old-send', accountId: 'account-a' }),
    ]);
  });

  it('clears disposable cache without removing the session, drafts, or queued sends', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.claimAccount('account-a');
    await store.saveTransportSession({ dcId: 2 });
    await store.replaceDialogs([cachedDialog(peer, 'Cached')]);
    await store.replaceMessages(peer.id, [cachedMessage(peer, 1)]);
    await store.saveDraft(peer.id, 'keep draft');
    await store.commitOutbox({ ...pending('keep-send', 1), accountId: 'account-a' });
    await store.saveCursor({ pts: 1, qts: 0, date: 1, seq: 1 });
    await store.saveLastPeerId(peer.id);
    await store.saveBlob('avatar:u:1:1', new Blob(['cached avatar']));

    await store.clearCacheData();

    expect(await store.loadTransportSession()).toEqual({ dcId: 2 });
    expect(await store.loadAccountId()).toBe('account-a');
    expect(await store.loadDrafts()).toEqual({ [peer.id]: 'keep draft' });
    expect(await store.loadOutbox()).toEqual([
      expect.objectContaining({ id: 'keep-send', accountId: 'account-a' }),
    ]);
    expect(await store.loadDialogs()).toEqual([]);
    expect(await store.loadMessages(peer.id)).toEqual([]);
    expect(await store.loadCursor()).toBeUndefined();
    expect(await store.loadLastPeerId()).toBeUndefined();
    expect(await store.loadBlob('avatar:u:1:1')).toBeUndefined();
  });

  it('persists peer metadata and removes it with the disposable cache', async () => {
    const name = databaseName();
    const store = new IndexedDbCacheStore(name);
    const pinned = [{ ...cachedMessage(peer, 7), pinned: true }];
    const members = [
      {
        peer: { id: 'u:2', kind: 'user' as const },
        title: 'Member',
        initials: 'M',
        color: '#123456',
        hasAvatar: false,
      },
    ];
    await store.savePinnedMessages(peer.id, pinned);
    await store.saveGroupMembers(peer.id, members);

    const reopened = new IndexedDbCacheStore(name);
    await expect(reopened.loadPinnedMessages(peer.id)).resolves.toMatchObject({ value: pinned });
    await expect(reopened.loadGroupMembers(peer.id)).resolves.toMatchObject({ value: members });

    await reopened.clearCacheData();
    await expect(reopened.loadPinnedMessages(peer.id)).resolves.toBeUndefined();
    await expect(reopened.loadGroupMembers(peer.id)).resolves.toBeUndefined();
  });

  it('supports peer-scoped and global message deletion', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.replaceMessages(peer.id, [cachedMessage(peer, 1), cachedMessage(peer, 2)]);
    await store.replaceMessages(secondPeer.id, [
      cachedMessage(secondPeer, 1),
      cachedMessage(secondPeer, 2),
    ]);

    await store.deleteMessages(peer.id, [1]);
    expect((await store.loadMessages(peer.id)).map(({ id }) => id)).toEqual([2]);
    expect((await store.loadMessages(secondPeer.id)).map(({ id }) => id)).toEqual([1, 2]);
    await store.deleteMessages(undefined, [2]);
    expect(await store.loadMessages(peer.id)).toEqual([]);
    expect((await store.loadMessages(secondPeer.id)).map(({ id }) => id)).toEqual([1]);
  });

  it('persists independent drafts and deletes empty drafts', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.saveDraft(peer.id, 'First draft', 7);
    await store.saveDraft(secondPeer.id, 'Second draft');
    expect(await store.loadDrafts()).toEqual({
      [peer.id]: 'First draft',
      [secondPeer.id]: 'Second draft',
    });
    expect(await store.loadDraftRevisions()).toEqual({
      [peer.id]: 7,
      [secondPeer.id]: 0,
    });
    await store.saveDraft(peer.id, '');
    expect(await store.loadDrafts()).toEqual({ [secondPeer.id]: 'Second draft' });
    expect(await store.loadDraftRevisions()).toEqual({ [secondPeer.id]: 0 });
  });

  it('stores a pending send and clears only its matching draft in one transaction', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.saveDraft(peer.id, 'Captured text', 1);
    await store.commitOutbox(pending('captured-send', 1), {
      peerId: peer.id,
      text: 'Captured text',
      revision: 1,
    });

    expect(await store.loadDrafts()).toEqual({});
    expect(await store.loadOutbox()).toEqual([
      expect.objectContaining({ id: 'captured-send', text: 'captured-send' }),
    ]);

    await store.saveDraft(peer.id, 'Captured text', 2);
    await store.commitOutbox(pending('older-identical-send', 2), {
      peerId: peer.id,
      text: 'Captured text',
      revision: 1,
    });
    expect(await store.loadDrafts()).toEqual({ [peer.id]: 'Captured text' });

    await store.saveDraft(peer.id, 'Newer text', 3);
    await store.commitOutbox(pending('older-send', 3), {
      peerId: peer.id,
      text: 'Captured text',
      revision: 2,
    });
    expect(await store.loadDrafts()).toEqual({ [peer.id]: 'Newer text' });
  });

  it('rolls back the draft clear when the pending record cannot be cloned', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.saveDraft(peer.id, 'Keep this draft');
    const invalid = {
      ...pending('invalid', 1),
      peer: { ...peer, invalidValue: () => undefined },
    } as unknown as PendingSend;

    await expect(
      store.commitOutbox(invalid, { peerId: peer.id, text: 'Keep this draft' }),
    ).rejects.toBeDefined();
    expect(await store.loadDrafts()).toEqual({ [peer.id]: 'Keep this draft' });
    expect(await store.loadOutbox()).toEqual([]);
  });

  it('atomically stores an attachment batch and clears only the captured draft revision', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.saveDraft(peer.id, 'Album caption', 4);
    await store.commitOutbox(
      [
        { ...pending('album', 10), queueOrder: 1 },
        { ...pending('file', 10), queueOrder: 2 },
      ],
      { peerId: peer.id, text: 'Album caption', revision: 4 },
    );

    expect(await store.loadDrafts()).toEqual({});
    expect((await store.loadOutbox()).map(({ id }) => id)).toEqual(['album', 'file']);

    await store.saveDraft(peer.id, 'Newer caption', 5);
    await store.commitOutbox([{ ...pending('older-caption', 11), queueOrder: 3 }], {
      peerId: peer.id,
      text: 'Album caption',
      revision: 4,
    });
    expect(await store.loadDrafts()).toEqual({ [peer.id]: 'Newer caption' });
  });

  it('rolls back an attachment batch and matching draft clear together', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.saveDraft(peer.id, 'Keep this caption', 1);
    const invalid = {
      ...pending('invalid-batch-item', 12),
      peer: { ...peer, invalidValue: () => undefined },
    } as unknown as PendingSend;

    await expect(
      store.commitOutbox([pending('rolled-back-batch-item', 12), invalid], {
        peerId: peer.id,
        text: 'Keep this caption',
        revision: 1,
      }),
    ).rejects.toBeDefined();
    expect(await store.loadDrafts()).toEqual({ [peer.id]: 'Keep this caption' });
    expect(await store.loadOutbox()).toEqual([]);
  });

  it('orders the durable outbox by creation time and deletes delivered entries', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.commitOutbox(pending('later', 20));
    await store.commitOutbox(pending('earlier', 10));
    await store.commitOutbox({ ...pending('later', 20), attempts: 2 });

    expect((await store.loadOutbox()).map(({ id }) => id)).toEqual(['earlier', 'later']);
    expect((await store.loadOutbox())[1]?.attempts).toBe(2);
    await store.deletePending('earlier');
    expect((await store.loadOutbox()).map(({ id }) => id)).toEqual(['later']);
  });

  it('uses per-peer queue order when timestamps collide or move backwards', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.commitOutbox({ ...pending('second', 10), queueOrder: 2 });
    await store.commitOutbox({ ...pending('first', 20), queueOrder: 1 });

    expect((await store.loadOutbox()).map(({ id }) => id)).toEqual(['first', 'second']);
  });

  it('writes an attachment plan in one outbox transaction', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.commitOutbox([pending('album', 10), pending('file', 11)]);
    expect((await store.loadOutbox()).map(({ id }) => id)).toEqual(['album', 'file']);

    const invalid = {
      ...pending('invalid', 12),
      peer: { ...peer, invalidValue: () => undefined },
    } as unknown as PendingSend;
    await expect(store.commitOutbox([pending('rolled-back', 12), invalid])).rejects.toBeDefined();
    expect((await store.loadOutbox()).map(({ id }) => id)).toEqual(['album', 'file']);
  });

  it('evicts the oldest messages after a peer exceeds the persistent history cap', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    await store.putMessages(
      Array.from({ length: 1_005 }, (_, index) => cachedMessage(peer, index + 1)),
    );

    const retained = await store.loadMessages(peer.id, 2_000);
    expect(retained).toHaveLength(1_000);
    expect(retained[0]?.id).toBe(6);
    await expect(store.loadMessage(peer.id, 1)).resolves.toBeUndefined();
  });

  it('round-trips binary blobs by cache key', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    const blob = new Blob(['payload'], { type: 'text/plain' });
    expect(await store.loadBlob('missing')).toBeUndefined();
    await store.saveBlob('media:peer-1:7', blob);
    const cached = await store.loadBlob('media:peer-1:7');
    expect(cached?.type).toBe('text/plain');
    expect(await cached?.text()).toBe('payload');
  });

  it('upgrades a version-one database with the binary file store', async () => {
    const name = databaseName();
    const request = indexedDB.open(name, 1);
    await new Promise<void>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('meta');
        database.createObjectStore('dialogs', { keyPath: 'peer.id' });
        const messages = database.createObjectStore('messages', {
          keyPath: ['peerId', 'id'],
        });
        messages.createIndex('byPeer', 'peerId');
        database.createObjectStore('drafts', { keyPath: 'peerId' });
        const outbox = database.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('byCreatedAt', 'createdAt');
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    const store = new IndexedDbCacheStore(name);
    await store.saveBlob('avatar:peer-1', new Blob(['avatar']));
    expect(await (await store.loadBlob('avatar:peer-1'))?.text()).toBe('avatar');
  });

  it('recreates the disposable version-two raw-blob store during migration', async () => {
    const name = databaseName();
    const request = indexedDB.open(name, 2);
    await new Promise<void>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('meta');
        database.createObjectStore('dialogs', { keyPath: 'peer.id' });
        const messages = database.createObjectStore('messages', {
          keyPath: ['peerId', 'id'],
        });
        messages.createIndex('byPeer', 'peerId');
        database.createObjectStore('drafts', { keyPath: 'peerId' });
        const outbox = database.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('byCreatedAt', 'createdAt');
        database.createObjectStore('files').put(new Blob(['legacy']), 'legacy-file');
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    const store = new IndexedDbCacheStore(name);
    expect(await store.loadBlob('legacy-file')).toBeUndefined();
    await store.saveBlob('new-file', new Blob(['new']));
    expect(await (await store.loadBlob('new-file'))?.text()).toBe('new');
  });

  it('adds message lookup indexes to a version-three database without losing records', async () => {
    const name = databaseName();
    const request = indexedDB.open(name, 3);
    await new Promise<void>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('meta');
        database.createObjectStore('dialogs', { keyPath: 'peer.id' });
        const messages = database.createObjectStore('messages', {
          keyPath: ['peerId', 'id'],
        });
        messages.createIndex('byPeer', 'peerId');
        messages.put(cachedMessage(peer, 7));
        messages.put(cachedMessage(secondPeer, 7));
        database.createObjectStore('drafts', { keyPath: 'peerId' });
        const outbox = database.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('byCreatedAt', 'createdAt');
        database.createObjectStore('files', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    const store = new IndexedDbCacheStore(name);
    expect(await store.loadMessage(peer.id, 7)).toEqual(expect.objectContaining({ id: 7 }));
    await store.deleteMessages(undefined, [7]);
    expect(await store.loadMessages(peer.id)).toEqual([]);
    expect(await store.loadMessages(secondPeer.id)).toEqual([]);
  });

  it('preserves version-five messages during the version-six migration', async () => {
    const name = databaseName();
    const request = indexedDB.open(name, 5);
    await new Promise<void>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('meta');
        database.createObjectStore('dialogs', { keyPath: 'peer.id' });
        const messages = database.createObjectStore('messages', {
          keyPath: ['peerId', 'id'],
        });
        messages.createIndex('byPeer', 'peerId');
        messages.createIndex('byMessageId', 'id');
        messages.createIndex('byDate', 'date');
        messages.put(cachedMessage(peer, 7));
        database.createObjectStore('drafts', { keyPath: 'peerId' });
        const outbox = database.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('byCreatedAt', 'createdAt');
        database.createObjectStore('files', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    const store = new IndexedDbCacheStore(name);
    expect(await store.loadMessages(peer.id)).toEqual([
      expect.objectContaining({ id: 7, peerId: peer.id }),
    ]);
  });

  it('bounds the binary cache by entry count', async () => {
    const store = new IndexedDbCacheStore(databaseName());
    for (let index = 0; index < 257; index += 1) {
      await store.saveBlob(`blob-${index.toString().padStart(3, '0')}`, new Blob(['x']));
    }

    let retained = 0;
    for (let index = 0; index < 257; index += 1) {
      if (await store.loadBlob(`blob-${index.toString().padStart(3, '0')}`)) retained += 1;
    }
    expect(retained).toBe(256);
  });
});
