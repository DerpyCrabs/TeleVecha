import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import { makeMemoryCacheStore } from './memoryStore';
import type {
  CachedDialog,
  CachedMessage,
  PendingSend,
  TelegramGroupMember,
  TelegramPeer,
} from '../types';

const peer: TelegramPeer = { id: 'peer-1', kind: 'user' };
const secondPeer: TelegramPeer = { id: 'peer-2', kind: 'group' };

function dialog(target: TelegramPeer, title: string, cacheEpoch: number = 1): CachedDialog {
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
    cacheEpoch,
  };
}

function message(target: TelegramPeer, id: number, cacheEpoch: number = 1): CachedMessage {
  return {
    id,
    peerId: target.id,
    senderId: target.id,
    text: `${target.id}-${id}`,
    date: id,
    outgoing: false,
    cacheEpoch,
  };
}

function send(id: string, createdAt: number, target: TelegramPeer = peer): PendingSend {
  return { id, peer: target, text: id, randomId: `random-${id}`, createdAt, attempts: 0 };
}

const member: TelegramGroupMember = {
  peer: { id: 'member-1', kind: 'user' },
  title: 'Member',
  initials: 'M',
  color: '#123456',
  hasAvatar: false,
};

describe('MemoryCacheStore', () => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  it('loads a cloned seeded workspace, ordered history, and cache metadata', async () => {
    const firstDialog = dialog(peer, 'First', 4);
    const latestMessage = {
      ...message(peer, 9, 4),
      text: 'x'.repeat(87),
      media: {
        kind: 'video' as const,
        name: 'generated.mp4',
        mimeType: 'video/mp4',
        size: 2_048,
        width: 1_920,
        height: 1_080,
        duration: 17,
      },
    };
    const store = makeMemoryCacheStore({
      accountId: 'self',
      cursor: { pts: 8, qts: 3, date: 5, seq: 2 },
      epoch: 4,
      dialogs: [firstDialog, dialog(secondPeer, 'Second', 4)],
      messages: [latestMessage, message(secondPeer, 3, 4), message(peer, 2, 4)],
      drafts: { [peer.id]: 'draft' },
      draftRevisions: { [peer.id]: 7 },
      pending: [send('pending', 10)],
      pinned: { [peer.id]: { value: [latestMessage], savedAt: 111 } },
      groupMembers: new Map([[secondPeer.id, { value: [member], savedAt: 222 }]]),
      blobs: { 'media:peer-1:9': new Blob(['generated media']) },
    });

    firstDialog.title = 'mutated fixture';
    latestMessage.media.width = 1;

    const workspace = await run(store.loadWorkspace());
    expect(workspace).toMatchObject({
      accountId: 'self',
      epoch: 4,
      drafts: { [peer.id]: 'draft' },
      draftRevisions: { [peer.id]: 7 },
    });
    expect(workspace.dialogs.map(({ title }) => title)).toEqual(['First', 'Second']);
    expect((await run(store.loadMessages(peer.id))).map(({ id }) => id)).toEqual([2, 9]);
    expect((await run(store.loadMessage(peer.id, 9)))?.media).toMatchObject({
      size: 2_048,
      width: 1_920,
      height: 1_080,
      duration: 17,
    });
    expect((await run(store.loadMessage(peer.id, 9)))?.text).toHaveLength(87);
    expect(await run(store.loadPinnedMessages(peer.id))).toEqual({
      value: [expect.objectContaining({ id: 9 })],
      savedAt: 111,
    });
    expect(await run(store.loadGroupMembers(secondPeer.id))).toEqual({
      value: [member],
      savedAt: 222,
    });
    expect(await (await run(store.loadBlob('media:peer-1:9')))?.text()).toBe('generated media');

    workspace.dialogs[0]!.title = 'mutated load';
    expect((await run(store.loadWorkspace())).dialogs[0]?.title).toBe('First');
  });

  it('supports cache writes, scoped replacement, draft revisions, and metadata deletion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(12_345);
    const store = makeMemoryCacheStore({
      dialogs: [dialog(peer, 'First')],
      messages: [message(peer, 1), message(secondPeer, 1)],
    });

    const renamed = dialog(peer, 'Renamed');
    await run(store.putDialog(renamed));
    renamed.title = 'changed after write';
    await run(store.replaceMessages(peer.id, [message(peer, 3), message(peer, 2)]));
    await run(store.putMessage({ ...message(peer, 3), text: 'updated' }));
    await run(store.saveDraft(peer.id, 'draft', 9));
    await run(store.saveMetadata('wallpaper-catalog:v1', [{ id: 'lagoon' }]));
    await run(store.savePinnedMessages(peer.id, [message(peer, 3)]));
    await run(store.saveGroupMembers(secondPeer.id, [member]));
    await run(store.saveBlob('file', new Blob(['payload'], { type: 'text/plain' })));

    expect((await run(store.loadDialogs())).map(({ title }) => title)).toEqual(['Renamed']);
    expect((await run(store.loadMessages(peer.id))).map(({ id, text }) => [id, text])).toEqual([
      [2, 'peer-1-2'],
      [3, 'updated'],
    ]);
    expect((await run(store.loadMessages(secondPeer.id))).map(({ id }) => id)).toEqual([1]);
    expect(await run(store.loadDrafts())).toEqual({ [peer.id]: 'draft' });
    expect(await run(store.loadDraftRevisions())).toEqual({ [peer.id]: 9 });
    expect(await run(store.loadMetadata('wallpaper-catalog:v1'))).toEqual({
      value: [{ id: 'lagoon' }],
      savedAt: 12_345,
    });
    expect(await run(store.loadPinnedMessages(peer.id))).toEqual({
      value: [expect.objectContaining({ id: 3 })],
      savedAt: 12_345,
    });
    expect(await run(store.loadGroupMembers(secondPeer.id))).toEqual({
      value: [member],
      savedAt: 12_345,
    });
    expect((await run(store.loadBlob('file')))?.type).toBe('text/plain');

    await run(store.deleteMessages(secondPeer.id, [1]));
    await run(store.saveDraft(peer.id, ''));
    await run(store.deletePinnedMessages(peer.id));
    await run(store.deleteGroupMembers(secondPeer.id));
    await run(store.deleteMetadata('wallpaper-catalog:v1'));
    await run(store.deleteBlob('file'));
    expect(await run(store.loadMessages(secondPeer.id))).toEqual([]);
    expect(await run(store.loadDrafts())).toEqual({});
    expect(await run(store.loadPinnedMessages(peer.id))).toBeUndefined();
    expect(await run(store.loadGroupMembers(secondPeer.id))).toBeUndefined();
    expect(await run(store.loadMetadata('wallpaper-catalog:v1'))).toBeUndefined();
    expect(await run(store.loadBlob('file'))).toBeUndefined();
    vi.useRealTimers();
  });

  it('increments epochs and replaces only latest-state cache data in one commit', async () => {
    const store = makeMemoryCacheStore({
      epoch: 6,
      cursor: { pts: 1, qts: 0, date: 1, seq: 1 },
      dialogs: [dialog(peer, 'Old', 6)],
      messages: [message(peer, 1, 6)],
      drafts: { [peer.id]: 'keep' },
      pending: [send('keep', 1)],
      blobs: { discard: new Blob(['discard']), preserve: new Blob(['preserve']) },
    });
    const cursor = { pts: 20, qts: 2, date: 30, seq: 4 };

    expect(await run(store.beginNewEpoch())).toBe(7);
    const epoch = await run(
      store.commitLatestState({
        cursor,
        dialogs: [dialog(secondPeer, 'Current', 0)],
        discardBlobKeys: ['discard'],
      }),
    );
    cursor.pts = 999;

    expect(epoch).toBe(8);
    expect(await run(store.loadEpoch())).toBe(8);
    expect(await run(store.loadCursor())).toEqual({ pts: 20, qts: 2, date: 30, seq: 4 });
    expect(await run(store.loadDialogs())).toEqual([
      expect.objectContaining({ title: 'Current', cacheEpoch: 8 }),
    ]);
    expect(await run(store.loadMessages(peer.id))).toEqual([]);
    expect(await run(store.loadMessages(secondPeer.id))).toEqual([]);
    expect(await run(store.loadDrafts())).toEqual({ [peer.id]: 'keep' });
    expect((await run(store.loadOutbox())).map(({ id }) => id)).toEqual(['keep']);
    expect(await run(store.loadBlob('discard'))).toBeUndefined();
    expect(await (await run(store.loadBlob('preserve')))?.text()).toBe('preserve');
  });

  it('upserts and orders the outbox while clearing only the captured draft revision', async () => {
    const store = makeMemoryCacheStore({
      drafts: { [peer.id]: 'caption' },
      draftRevisions: { [peer.id]: 4 },
      pending: [send('later', 30)],
    });
    const second = { ...send('second', 10), queueOrder: 2 };
    const first = { ...send('first', 20), queueOrder: 1 };

    await run(
      store.commitOutbox([second, first], { peerId: peer.id, text: 'caption', revision: 4 }),
    );
    first.text = 'mutated after write';
    await run(store.commitOutbox({ ...send('later', 30), attempts: 2 }));

    expect((await run(store.loadOutbox())).map(({ id }) => id)).toEqual([
      'first',
      'second',
      'later',
    ]);
    expect((await run(store.loadOutbox())).find(({ id }) => id === 'later')?.attempts).toBe(2);
    expect((await run(store.loadOutbox())).find(({ id }) => id === 'first')?.text).toBe('first');
    expect(await run(store.loadDrafts())).toEqual({});
    await run(store.deletePending('second'));
    expect((await run(store.loadOutbox())).map(({ id }) => id)).toEqual(['first', 'later']);
  });

  it('clones a transport session at its boundary', async () => {
    const ordinary = makeMemoryCacheStore();
    const session = { dcId: 2 };
    await run(ordinary.saveTransportSession(session));
    session.dcId = 4;
    expect(await run(ordinary.loadTransportSession)).toEqual({ dcId: 2 });
    await run(ordinary.saveTransportSession(undefined));
    expect(await run(ordinary.loadTransportSession)).toBeUndefined();
  });
});

it('isolates nested draft details returned by loadWorkspace', async () => {
  const store = makeMemoryCacheStore({
    draftDetails: { p: { formats: [], reply: { messageId: 1, preview: 'old' } } },
  });
  (await Effect.runPromise(store.loadWorkspace())).draftDetails.p!.reply!.preview = 'changed';
  expect((await Effect.runPromise(store.loadWorkspace())).draftDetails.p!.reply!.preview).toBe(
    'old',
  );
});

it('applies last-write-wins for duplicate outbox keys in a batch like IndexedDB', async () => {
  const store = makeMemoryCacheStore();
  await Effect.runPromise(store.commitOutbox([send('one', 1), send('one', 2)]));
  expect(await Effect.runPromise(store.loadOutbox())).toEqual([send('one', 2)]);
});

it('replaces repeated history keys with their final version like IndexedDB', async () => {
  const store = makeMemoryCacheStore();
  const first = message(peer, 1),
    edited = { ...first, text: 'edited' };
  await Effect.runPromise(store.replaceMessages(peer.id, [first, edited]));
  expect(await Effect.runPromise(store.loadMessage(peer.id, 1))).toEqual(edited);
});
