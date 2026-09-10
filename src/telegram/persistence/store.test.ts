import 'fake-indexeddb/auto';

import { Effect, Exit, Scope } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import { createIndexedDbCacheStore } from './store';
import type { CachedDialog, CachedMessage, PendingSend, TelegramPeer } from '../types';

const peer: TelegramPeer = { id: 'peer-1', kind: 'user' };
const secondPeer: TelegramPeer = { id: 'peer-2', kind: 'group' };

function databaseName() {
  return `televecha-test-${crypto.randomUUID()}`;
}

const scopes: Scope.Closeable[] = [];
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
async function openStore(name: string) {
  const scope = await run(Scope.make());
  scopes.push(scope);
  return run(createIndexedDbCacheStore(name).pipe(Scope.provide(scope)));
}

afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => run(Scope.close(scope, Exit.void))));
});

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
  return { id, peer, text: id, randomId: id, createdAt, attempts: 0 };
}

describe('IndexedDbCacheStore', () => {
  it('captures an atomic logical checkpoint without session or file bytes', async () => {
    const store = await openStore(databaseName());
    await run(store.saveTransportSession({ authKey: 'must-not-leave-the-browser' }));
    await run(store.claimAccount('account-secret'));
    await run(store.saveCursor({ pts: 4, qts: 3, date: 2, seq: 1 }));
    await run(store.beginNewEpoch());
    await run(store.replaceDialogs([cachedDialog(peer, 'Private title')]));
    await run(store.putMessage({ ...cachedMessage(peer, 7), text: 'Private message' }));
    await run(store.saveDraft(peer.id, 'Private draft', 3));
    await run(store.commitOutbox(pending('private pending', 10)));
    await run(store.saveBlob('media:secret', new Blob(['private bytes'])));

    const checkpoint = await run(store.captureCheckpoint());

    expect(checkpoint).toMatchObject({
      cursor: { pts: 4, qts: 3, date: 2, seq: 1 },
      epoch: 1,
      dialogs: [expect.objectContaining({ title: 'Private title' })],
      messages: [expect.objectContaining({ id: 7, text: 'Private message' })],
      drafts: { [peer.id]: 'Private draft' },
      draftRevisions: { [peer.id]: 3 },
      pending: [expect.objectContaining({ id: 'private pending' })],
    });
    expect(JSON.stringify(checkpoint)).not.toContain('must-not-leave-the-browser');
    expect(JSON.stringify(checkpoint)).not.toContain('account-secret');
    expect(JSON.stringify(checkpoint)).not.toContain('private bytes');
  });

  it('round-trips transport session, cursor, and epoch', async () => {
    const store = await openStore(databaseName());
    const cursor = { pts: 4, qts: 3, date: 2, seq: 1 };

    expect(await run(store.loadTransportSession)).toBeUndefined();
    await run(store.saveTransportSession({ dcId: 2 }));
    await run(store.saveCursor(cursor));
    expect(await run(store.beginNewEpoch())).toBe(1);
    expect(await run(store.beginNewEpoch())).toBe(2);

    expect(await run(store.loadTransportSession)).toEqual({ dcId: 2 });
    expect(await run(store.loadCursor())).toEqual(cursor);
    expect(await run(store.loadEpoch())).toBe(2);
    await run(store.saveTransportSession(undefined));
    expect(await run(store.loadTransportSession)).toBeUndefined();
  });

  it('atomically commits a latest-state snapshot without clearing durable local data', async () => {
    const store = await openStore(databaseName());
    const oldCursor = { pts: 1, qts: 1, date: 1, seq: 1 };
    const nextCursor = { pts: 20, qts: 3, date: 30, seq: 4 };
    await run(store.saveCursor(oldCursor));
    await run(store.beginNewEpoch());
    await run(
      store.replaceDialogs([
        cachedDialog(peer, 'Old first'),
        cachedDialog(secondPeer, 'Old second'),
      ]),
    );
    await run(store.replaceMessages(peer.id, [cachedMessage(peer, 1)]));
    await run(store.replaceMessages(secondPeer.id, [cachedMessage(secondPeer, 2)]));
    await run(store.saveDraft(peer.id, 'Keep this draft', 5));
    await run(store.commitOutbox(pending('keep-this-send', 10)));
    await run(store.saveBlob('sticker-index:packs:v2', new Blob(['discard'])));
    await run(store.saveBlob('media:peer-1:7', new Blob(['preserve'])));

    const epoch = await run(
      store.commitLatestState({
        cursor: nextCursor,
        dialogs: [cachedDialog(secondPeer, 'Current second')],
        discardBlobKeys: ['sticker-index:packs:v2'],
      }),
    );

    expect(epoch).toBe(2);
    expect(await run(store.loadEpoch())).toBe(2);
    expect(await run(store.loadCursor())).toEqual(nextCursor);
    expect(await run(store.loadDialogs())).toEqual([
      expect.objectContaining({ peer: secondPeer, title: 'Current second', cacheEpoch: 2 }),
    ]);
    expect(await run(store.loadMessages(peer.id))).toEqual([]);
    expect(await run(store.loadMessages(secondPeer.id))).toEqual([]);
    expect(await run(store.loadDrafts())).toEqual({ [peer.id]: 'Keep this draft' });
    expect(await run(store.loadOutbox())).toEqual([
      expect.objectContaining({ id: 'keep-this-send' }),
    ]);
    expect(await run(store.loadBlob('sticker-index:packs:v2'))).toBeUndefined();
    expect(await (await run(store.loadBlob('media:peer-1:7')))?.text()).toBe('preserve');
  });

  it('rolls back every latest-state change when a snapshot record cannot be cloned', async () => {
    const store = await openStore(databaseName());
    const cursor = { pts: 1, qts: 1, date: 1, seq: 1 };
    await run(store.saveCursor(cursor));
    await run(store.beginNewEpoch());
    await run(store.replaceDialogs([cachedDialog(peer, 'Existing')]));
    await run(store.replaceMessages(peer.id, [cachedMessage(peer, 1)]));
    await run(store.saveBlob('sticker-index:packs:v2', new Blob(['existing'])));
    const invalidDialog = {
      ...cachedDialog(secondPeer, 'Invalid'),
      invalidValue: () => undefined,
    } as unknown as CachedDialog;

    await expect(
      run(
        store.commitLatestState({
          cursor: { pts: 20, qts: 2, date: 20, seq: 2 },
          dialogs: [invalidDialog],
          discardBlobKeys: ['sticker-index:packs:v2'],
        }),
      ),
    ).rejects.toBeDefined();

    expect(await run(store.loadEpoch())).toBe(1);
    expect(await run(store.loadCursor())).toEqual(cursor);
    expect(await run(store.loadDialogs())).toEqual([
      expect.objectContaining({ peer, title: 'Existing' }),
    ]);
    expect(await run(store.loadMessages(peer.id))).toEqual([
      expect.objectContaining({ id: 1, peerId: peer.id }),
    ]);
    expect(await (await run(store.loadBlob('sticker-index:packs:v2')))?.text()).toBe('existing');
  });

  it('replaces the dialog list and upserts a single dialog by peer id', async () => {
    const store = await openStore(databaseName());
    await run(
      store.replaceDialogs([cachedDialog(peer, 'First'), cachedDialog(secondPeer, 'Second')]),
    );
    await run(store.putDialog(cachedDialog(peer, 'First renamed')));

    const dialogs = await run(store.loadDialogs());
    expect(dialogs).toHaveLength(2);
    expect(dialogs.find(({ peer: target }) => target.id === peer.id)?.title).toBe('First renamed');
    await run(store.replaceDialogs([cachedDialog(secondPeer, 'Only')]));
    expect((await run(store.loadDialogs())).map(({ title }) => title)).toEqual(['Only']);
  });

  it('replaces messages only for the requested peer and upserts by composite key', async () => {
    const store = await openStore(databaseName());
    await run(store.replaceMessages(peer.id, [cachedMessage(peer, 1), cachedMessage(peer, 2)]));
    await run(store.replaceMessages(secondPeer.id, [cachedMessage(secondPeer, 1)]));
    await run(store.replaceMessages(peer.id, [cachedMessage(peer, 3)]));
    await run(store.putMessage({ ...cachedMessage(peer, 3), text: 'updated' }));

    expect(await run(store.loadMessages(peer.id))).toEqual([
      expect.objectContaining({ id: 3, text: 'updated' }),
    ]);
    expect(await run(store.loadMessages(secondPeer.id))).toEqual([
      expect.objectContaining({ id: 1, peerId: secondPeer.id }),
    ]);

    await run(store.putMessages([cachedMessage(peer, 4), cachedMessage(peer, 5)]));
    expect((await run(store.loadMessages(peer.id))).map(({ id }) => id)).toEqual([3, 4, 5]);
  });

  it('preserves album, service-event, and inline media metadata in cached history', async () => {
    const store = await openStore(databaseName());
    await run(
      store.putMessages([
        {
          ...cachedMessage(peer, 1),
          groupedId: 'album-1',
          media: { kind: 'voice', name: 'voice.ogg', mimeType: 'audio/ogg', duration: 9 },
        },
        {
          ...cachedMessage(peer, 2),
          text: 'Alice pinned a message',
          service: { kind: 'message-pinned', text: 'Alice pinned a message', actorId: 'u:1' },
        },
      ]),
    );

    expect(await run(store.loadMessages(peer.id))).toEqual([
      expect.objectContaining({
        groupedId: 'album-1',
        media: expect.objectContaining({ kind: 'voice', duration: 9 }) as unknown,
      }),
      expect.objectContaining({
        service: expect.objectContaining({ kind: 'message-pinned' }) as unknown,
      }),
    ]);
  });

  it('bounds peer history reads and can fetch one older cached message exactly', async () => {
    const store = await openStore(databaseName());
    await run(
      store.putMessages(Array.from({ length: 520 }, (_, index) => cachedMessage(peer, index + 1))),
    );

    const defaultWindow = await run(store.loadMessages(peer.id));
    expect(defaultWindow).toHaveLength(500);
    expect(defaultWindow[0]?.id).toBe(21);
    expect(defaultWindow.at(-1)?.id).toBe(520);
    expect((await run(store.loadMessages(peer.id, 10))).map(({ id }) => id)).toEqual([
      511, 512, 513, 514, 515, 516, 517, 518, 519, 520,
    ]);
    expect((await run(store.loadMessagesBefore(peer.id, 511, 10))).map(({ id }) => id)).toEqual([
      501, 502, 503, 504, 505, 506, 507, 508, 509, 510,
    ]);
    await expect(run(store.loadMessage(peer.id, 1))).resolves.toEqual(
      expect.objectContaining({ id: 1, peerId: peer.id }),
    );
  });

  it('claims legacy data for an existing authorized account without clearing it', async () => {
    const store = await openStore(databaseName());
    await run(store.replaceDialogs([cachedDialog(peer, 'Existing')]));
    await run(store.saveDraft(peer.id, 'keep me'));
    await run(store.commitOutbox(pending('legacy', 1)));

    await run(store.claimAccount('account-a'));

    expect(await run(store.loadAccountId())).toBe('account-a');
    expect(await run(store.loadDialogs())).toHaveLength(1);
    expect(await run(store.loadDrafts())).toEqual({ [peer.id]: 'keep me' });
    expect(await run(store.loadOutbox())).toEqual([
      expect.objectContaining({ id: 'legacy', accountId: 'account-a' }),
    ]);
  });

  it('clears account-scoped cache while quarantining another account outbox', async () => {
    const store = await openStore(databaseName());
    await run(store.claimAccount('account-a'));
    await run(store.saveTransportSession({ dcId: 2 }));
    await run(store.replaceDialogs([cachedDialog(peer, 'Old account')]));
    await run(store.replaceMessages(peer.id, [cachedMessage(peer, 1)]));
    await run(store.saveDraft(peer.id, 'old draft'));
    await run(store.commitOutbox({ ...pending('old-send', 1), accountId: 'account-a' }));
    await run(store.saveCursor({ pts: 1, qts: 0, date: 1, seq: 1 }));
    await run(store.beginNewEpoch());
    await run(store.saveBlob('old-file', new Blob(['old'])));

    await run(store.resetForAccount('account-b'));

    expect(await run(store.loadAccountId())).toBe('account-b');
    expect(await run(store.loadTransportSession)).toEqual({ dcId: 2 });
    expect(await run(store.loadDialogs())).toEqual([]);
    expect(await run(store.loadMessages(peer.id))).toEqual([]);
    expect(await run(store.loadDrafts())).toEqual({});
    expect(await run(store.loadCursor())).toBeUndefined();
    expect(await run(store.loadEpoch())).toBe(0);
    expect(await run(store.loadBlob('old-file'))).toBeUndefined();
    expect(await run(store.loadOutbox())).toEqual([
      expect.objectContaining({ id: 'old-send', accountId: 'account-a' }),
    ]);
  });

  it('clears disposable cache without removing the session, drafts, or queued sends', async () => {
    const store = await openStore(databaseName());
    await run(store.claimAccount('account-a'));
    await run(store.saveTransportSession({ dcId: 2 }));
    await run(store.replaceDialogs([cachedDialog(peer, 'Cached')]));
    await run(store.replaceMessages(peer.id, [cachedMessage(peer, 1)]));
    await run(store.saveDraft(peer.id, 'keep draft'));
    await run(store.commitOutbox({ ...pending('keep-send', 1), accountId: 'account-a' }));
    await run(store.saveCursor({ pts: 1, qts: 0, date: 1, seq: 1 }));
    await run(store.saveBlob('avatar:u:1:1', new Blob(['cached avatar'])));

    await run(store.clearCacheData());

    expect(await run(store.loadTransportSession)).toEqual({ dcId: 2 });
    expect(await run(store.loadAccountId())).toBe('account-a');
    expect(await run(store.loadDrafts())).toEqual({ [peer.id]: 'keep draft' });
    expect(await run(store.loadOutbox())).toEqual([
      expect.objectContaining({ id: 'keep-send', accountId: 'account-a' }),
    ]);
    expect(await run(store.loadDialogs())).toEqual([]);
    expect(await run(store.loadMessages(peer.id))).toEqual([]);
    expect(await run(store.loadCursor())).toBeUndefined();
    expect(await run(store.loadBlob('avatar:u:1:1'))).toBeUndefined();
  });

  it('persists peer metadata and removes it with the disposable cache', async () => {
    const name = databaseName();
    const store = await openStore(name);
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
    await run(store.savePinnedMessages(peer.id, pinned));
    await run(store.saveGroupMembers(peer.id, members));

    const reopened = await openStore(name);
    await expect(run(reopened.loadPinnedMessages(peer.id))).resolves.toMatchObject({
      value: pinned,
    });
    await expect(run(reopened.loadGroupMembers(peer.id))).resolves.toMatchObject({
      value: members,
    });

    await run(reopened.clearCacheData());
    await expect(run(reopened.loadPinnedMessages(peer.id))).resolves.toBeUndefined();
    await expect(run(reopened.loadGroupMembers(peer.id))).resolves.toBeUndefined();
  });

  it('supports peer-scoped and global message deletion', async () => {
    const store = await openStore(databaseName());
    await run(store.replaceMessages(peer.id, [cachedMessage(peer, 1), cachedMessage(peer, 2)]));
    await run(
      store.replaceMessages(secondPeer.id, [
        cachedMessage(secondPeer, 1),
        cachedMessage(secondPeer, 2),
      ]),
    );

    await run(store.deleteMessages(peer.id, [1]));
    expect((await run(store.loadMessages(peer.id))).map(({ id }) => id)).toEqual([2]);
    expect((await run(store.loadMessages(secondPeer.id))).map(({ id }) => id)).toEqual([1, 2]);
    await run(store.deleteMessages(secondPeer.id, [2]));
    expect((await run(store.loadMessages(peer.id))).map(({ id }) => id)).toEqual([2]);
    expect((await run(store.loadMessages(secondPeer.id))).map(({ id }) => id)).toEqual([1]);
  });

  it('persists independent drafts and deletes empty drafts', async () => {
    const store = await openStore(databaseName());
    await run(
      store.saveDraft(peer.id, 'First draft', 7, {
        formats: [{ offset: 0, length: 5, kind: 'bold' }],
        reply: { messageId: 42, preview: 'Original message' },
      }),
    );
    await run(store.saveDraft(secondPeer.id, 'Second draft'));
    expect(await run(store.loadDrafts())).toEqual({
      [peer.id]: 'First draft',
      [secondPeer.id]: 'Second draft',
    });
    expect(await run(store.loadDraftRevisions())).toEqual({ [peer.id]: 7, [secondPeer.id]: 0 });
    expect((await run(store.loadWorkspace())).draftDetails).toEqual({
      [peer.id]: {
        formats: [{ offset: 0, length: 5, kind: 'bold' }],
        reply: { messageId: 42, preview: 'Original message' },
      },
    });
    await run(store.saveDraft(peer.id, ''));
    expect(await run(store.loadDrafts())).toEqual({ [secondPeer.id]: 'Second draft' });
    expect(await run(store.loadDraftRevisions())).toEqual({ [secondPeer.id]: 0 });
  });

  it('stores non-media resource metadata separately from binary blobs', async () => {
    const name = databaseName();
    const store = await openStore(name);
    await run(store.saveMetadata('shared-media-counts:u:1', { photos: 12 }));
    await run(store.saveBlob('media:u:1:12', new Blob(['binary'])));

    const reopened = await openStore(name);
    await expect(run(reopened.loadMetadata('shared-media-counts:u:1'))).resolves.toMatchObject({
      value: { photos: 12 },
    });
    expect(await (await run(reopened.loadBlob('media:u:1:12')))?.text()).toBe('binary');

    await run(reopened.deleteMetadata('shared-media-counts:u:1'));
    await expect(run(reopened.loadMetadata('shared-media-counts:u:1'))).resolves.toBeUndefined();
    expect(await (await run(reopened.loadBlob('media:u:1:12')))?.text()).toBe('binary');
  });

  it('stores a pending send and clears only its matching draft in one transaction', async () => {
    const store = await openStore(databaseName());
    await run(store.saveDraft(peer.id, 'Captured text', 1));
    await run(
      store.commitOutbox(pending('captured-send', 1), {
        peerId: peer.id,
        text: 'Captured text',
        revision: 1,
      }),
    );

    expect(await run(store.loadDrafts())).toEqual({});
    expect(await run(store.loadOutbox())).toEqual([
      expect.objectContaining({ id: 'captured-send', text: 'captured-send' }),
    ]);

    await run(store.saveDraft(peer.id, 'Captured text', 2));
    await run(
      store.commitOutbox(pending('older-identical-send', 2), {
        peerId: peer.id,
        text: 'Captured text',
        revision: 1,
      }),
    );
    expect(await run(store.loadDrafts())).toEqual({ [peer.id]: 'Captured text' });

    await run(store.saveDraft(peer.id, 'Newer text', 3));
    await run(
      store.commitOutbox(pending('older-send', 3), {
        peerId: peer.id,
        text: 'Captured text',
        revision: 2,
      }),
    );
    expect(await run(store.loadDrafts())).toEqual({ [peer.id]: 'Newer text' });
  });

  it('rolls back the draft clear when the pending record cannot be cloned', async () => {
    const store = await openStore(databaseName());
    await run(store.saveDraft(peer.id, 'Keep this draft'));
    const invalid = {
      ...pending('invalid', 1),
      peer: { ...peer, invalidValue: () => undefined },
    } as unknown as PendingSend;

    await expect(
      run(store.commitOutbox(invalid, { peerId: peer.id, text: 'Keep this draft' })),
    ).rejects.toBeDefined();
    expect(await run(store.loadDrafts())).toEqual({ [peer.id]: 'Keep this draft' });
    expect(await run(store.loadOutbox())).toEqual([]);
  });

  it('atomically stores an attachment batch and clears only the captured draft revision', async () => {
    const store = await openStore(databaseName());
    await run(store.saveDraft(peer.id, 'Album caption', 4));
    await run(
      store.commitOutbox(
        [
          { ...pending('album', 10), queueOrder: 1 },
          { ...pending('file', 10), queueOrder: 2 },
        ],
        { peerId: peer.id, text: 'Album caption', revision: 4 },
      ),
    );

    expect(await run(store.loadDrafts())).toEqual({});
    expect((await run(store.loadOutbox())).map(({ id }) => id)).toEqual(['album', 'file']);

    await run(store.saveDraft(peer.id, 'Newer caption', 5));
    await run(
      store.commitOutbox([{ ...pending('older-caption', 11), queueOrder: 3 }], {
        peerId: peer.id,
        text: 'Album caption',
        revision: 4,
      }),
    );
    expect(await run(store.loadDrafts())).toEqual({ [peer.id]: 'Newer caption' });
  });

  it('rolls back an attachment batch and matching draft clear together', async () => {
    const store = await openStore(databaseName());
    await run(store.saveDraft(peer.id, 'Keep this caption', 1));
    const invalid = {
      ...pending('invalid-batch-item', 12),
      peer: { ...peer, invalidValue: () => undefined },
    } as unknown as PendingSend;

    await expect(
      run(
        store.commitOutbox([pending('rolled-back-batch-item', 12), invalid], {
          peerId: peer.id,
          text: 'Keep this caption',
          revision: 1,
        }),
      ),
    ).rejects.toBeDefined();
    expect(await run(store.loadDrafts())).toEqual({ [peer.id]: 'Keep this caption' });
    expect(await run(store.loadOutbox())).toEqual([]);
  });

  it('orders the durable outbox by creation time and deletes delivered entries', async () => {
    const store = await openStore(databaseName());
    await run(store.commitOutbox(pending('later', 20)));
    await run(store.commitOutbox(pending('earlier', 10)));
    await run(store.commitOutbox({ ...pending('later', 20), attempts: 2 }));

    expect((await run(store.loadOutbox())).map(({ id }) => id)).toEqual(['earlier', 'later']);
    expect((await run(store.loadOutbox()))[1]?.attempts).toBe(2);
    await run(store.deletePending('earlier'));
    expect((await run(store.loadOutbox())).map(({ id }) => id)).toEqual(['later']);
  });

  it('uses per-peer queue order when timestamps collide or move backwards', async () => {
    const store = await openStore(databaseName());
    await run(store.commitOutbox({ ...pending('second', 10), queueOrder: 2 }));
    await run(store.commitOutbox({ ...pending('first', 20), queueOrder: 1 }));

    expect((await run(store.loadOutbox())).map(({ id }) => id)).toEqual(['first', 'second']);
  });

  it('writes an attachment plan in one outbox transaction', async () => {
    const store = await openStore(databaseName());
    await run(store.commitOutbox([pending('album', 10), pending('file', 11)]));
    expect((await run(store.loadOutbox())).map(({ id }) => id)).toEqual(['album', 'file']);

    const invalid = {
      ...pending('invalid', 12),
      peer: { ...peer, invalidValue: () => undefined },
    } as unknown as PendingSend;
    await expect(
      run(store.commitOutbox([pending('rolled-back', 12), invalid])),
    ).rejects.toBeDefined();
    expect((await run(store.loadOutbox())).map(({ id }) => id)).toEqual(['album', 'file']);
  });

  it('evicts the oldest messages after a peer exceeds the persistent history cap', async () => {
    const store = await openStore(databaseName());
    await run(
      store.putMessages(
        Array.from({ length: 1_005 }, (_, index) => cachedMessage(peer, index + 1)),
      ),
    );

    const retained = await run(store.loadMessages(peer.id, 2_000));
    expect(retained).toHaveLength(1_000);
    expect(retained[0]?.id).toBe(6);
    await expect(run(store.loadMessage(peer.id, 1))).resolves.toBeUndefined();
  });

  it('round-trips binary blobs by cache key', async () => {
    const store = await openStore(databaseName());
    const blob = new Blob(['payload'], { type: 'text/plain' });
    expect(await run(store.loadBlob('missing'))).toBeUndefined();
    await run(store.saveBlob('media:peer-1:7', blob));
    const cached = await run(store.loadBlob('media:peer-1:7'));
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
        const messages = database.createObjectStore('messages', { keyPath: ['peerId', 'id'] });
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

    const store = await openStore(name);
    await run(store.saveBlob('avatar:peer-1', new Blob(['avatar'])));
    expect(await (await run(store.loadBlob('avatar:peer-1')))?.text()).toBe('avatar');
  });

  it('recreates the disposable version-two raw-blob store during migration', async () => {
    const name = databaseName();
    const request = indexedDB.open(name, 2);
    await new Promise<void>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('meta');
        database.createObjectStore('dialogs', { keyPath: 'peer.id' });
        const messages = database.createObjectStore('messages', { keyPath: ['peerId', 'id'] });
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

    const store = await openStore(name);
    expect(await run(store.loadBlob('legacy-file'))).toBeUndefined();
    await run(store.saveBlob('new-file', new Blob(['new'])));
    expect(await (await run(store.loadBlob('new-file')))?.text()).toBe('new');
  });

  it('adds message lookup indexes to a version-three database without losing records', async () => {
    const name = databaseName();
    const request = indexedDB.open(name, 3);
    await new Promise<void>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('meta');
        database.createObjectStore('dialogs', { keyPath: 'peer.id' });
        const messages = database.createObjectStore('messages', { keyPath: ['peerId', 'id'] });
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

    const store = await openStore(name);
    expect(await run(store.loadMessage(peer.id, 7))).toEqual(expect.objectContaining({ id: 7 }));
    await run(store.deleteMessages(peer.id, [7]));
    expect(await run(store.loadMessages(peer.id))).toEqual([]);
    expect(await run(store.loadMessages(secondPeer.id))).toEqual([
      expect.objectContaining({ id: 7, peerId: secondPeer.id }),
    ]);
  });

  it('preserves version-five messages during the version-six migration', async () => {
    const name = databaseName();
    const request = indexedDB.open(name, 5);
    await new Promise<void>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('meta');
        database.createObjectStore('dialogs', { keyPath: 'peer.id' });
        const messages = database.createObjectStore('messages', { keyPath: ['peerId', 'id'] });
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

    const store = await openStore(name);
    expect(await run(store.loadMessages(peer.id))).toEqual([
      expect.objectContaining({ id: 7, peerId: peer.id }),
    ]);
  });

  it('settles a blocked schema upgrade with an actionable failure', async () => {
    const name = databaseName();
    const request = indexedDB.open(name, 5);
    const oldConnection = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let outcome: 'settled' | 'blocked';

    try {
      outcome = await Promise.race([
        run(Effect.scoped(createIndexedDbCacheStore(name).pipe(Effect.result))).then(
          () => 'settled' as const,
          () => 'settled' as const,
        ),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
      ]);
    } finally {
      oldConnection.close();
    }

    expect(outcome).toBe('settled');
  });

  it('bounds the binary cache by entry count', async () => {
    const store = await openStore(databaseName());
    for (let index = 0; index < 257; index += 1) {
      await run(store.saveBlob(`blob-${index.toString().padStart(3, '0')}`, new Blob(['x'])));
    }

    let retained = 0;
    for (let index = 0; index < 257; index += 1) {
      if (await run(store.loadBlob(`blob-${index.toString().padStart(3, '0')}`))) retained += 1;
    }
    expect(retained).toBe(256);
  });
});
