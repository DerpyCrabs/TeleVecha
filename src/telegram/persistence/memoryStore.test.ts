import { describe, expect, it, vi } from 'vitest';

import { MemoryCacheStore } from './memoryStore';
import type {
  CachedDialog,
  CachedMessage,
  PendingSend,
  TelegramGroupMember,
  TelegramPeer,
} from '../types';

const peer: TelegramPeer = { id: 'peer-1', kind: 'user' };
const secondPeer: TelegramPeer = { id: 'peer-2', kind: 'group' };

function dialog(target: TelegramPeer, title: string, cacheEpoch = 1): CachedDialog {
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

function message(target: TelegramPeer, id: number, cacheEpoch = 1): CachedMessage {
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

function send(id: string, createdAt: number, target = peer): PendingSend {
  return {
    id,
    peer: target,
    text: id,
    randomId: `random-${id}`,
    createdAt,
    attempts: 0,
  };
}

const member: TelegramGroupMember = {
  peer: { id: 'member-1', kind: 'user' },
  title: 'Member',
  initials: 'M',
  color: '#123456',
  hasAvatar: false,
};

describe('MemoryCacheStore', () => {
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
    const store = new MemoryCacheStore({
      accountId: 'self',
      cursor: { pts: 8, qts: 3, date: 5, seq: 2 },
      epoch: 4,
      dialogs: [firstDialog, dialog(secondPeer, 'Second', 4)],
      messages: [latestMessage, message(secondPeer, 3, 4), message(peer, 2, 4)],
      drafts: { [peer.id]: 'draft' },
      draftRevisions: { [peer.id]: 7 },
      pending: [send('pending', 10)],
      lastPeerId: peer.id,
      pinned: { [peer.id]: { value: [latestMessage], savedAt: 111 } },
      groupMembers: new Map([[secondPeer.id, { value: [member], savedAt: 222 }]]),
      blobs: { 'media:peer-1:9': new Blob(['generated media']) },
    });

    firstDialog.title = 'mutated fixture';
    latestMessage.media.width = 1;

    const workspace = await store.loadWorkspace();
    expect(workspace).toMatchObject({
      accountId: 'self',
      epoch: 4,
      drafts: { [peer.id]: 'draft' },
      draftRevisions: { [peer.id]: 7 },
      lastPeerId: peer.id,
    });
    expect(workspace.dialogs.map(({ title }) => title)).toEqual(['First', 'Second']);
    expect((await store.loadMessages(peer.id)).map(({ id }) => id)).toEqual([2, 9]);
    expect((await store.loadMessage(peer.id, 9))?.media).toMatchObject({
      size: 2_048,
      width: 1_920,
      height: 1_080,
      duration: 17,
    });
    expect((await store.loadMessage(peer.id, 9))?.text).toHaveLength(87);
    expect(await store.loadPinnedMessages(peer.id)).toEqual({
      value: [expect.objectContaining({ id: 9 })],
      savedAt: 111,
    });
    expect(await store.loadGroupMembers(secondPeer.id)).toEqual({ value: [member], savedAt: 222 });
    expect(await (await store.loadBlob('media:peer-1:9'))?.text()).toBe('generated media');

    workspace.dialogs[0]!.title = 'mutated load';
    expect((await store.loadWorkspace()).dialogs[0]?.title).toBe('First');
  });

  it('supports cache writes, scoped replacement, draft revisions, and metadata deletion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(12_345);
    const store = new MemoryCacheStore({
      dialogs: [dialog(peer, 'First')],
      messages: [message(peer, 1), message(secondPeer, 1)],
    });

    const renamed = dialog(peer, 'Renamed');
    await store.putDialog(renamed);
    renamed.title = 'changed after write';
    await store.replaceMessages(peer.id, [message(peer, 3), message(peer, 2)]);
    await store.putMessage({ ...message(peer, 3), text: 'updated' });
    await store.saveDraft(peer.id, 'draft', 9);
    await store.savePinnedMessages(peer.id, [message(peer, 3)]);
    await store.saveGroupMembers(secondPeer.id, [member]);
    await store.saveBlob('file', new Blob(['payload'], { type: 'text/plain' }));

    expect((await store.loadDialogs()).map(({ title }) => title)).toEqual(['Renamed']);
    expect((await store.loadMessages(peer.id)).map(({ id, text }) => [id, text])).toEqual([
      [2, 'peer-1-2'],
      [3, 'updated'],
    ]);
    expect((await store.loadMessages(secondPeer.id)).map(({ id }) => id)).toEqual([1]);
    expect(await store.loadDrafts()).toEqual({ [peer.id]: 'draft' });
    expect(await store.loadDraftRevisions()).toEqual({ [peer.id]: 9 });
    expect(await store.loadPinnedMessages(peer.id)).toEqual({
      value: [expect.objectContaining({ id: 3 })],
      savedAt: 12_345,
    });
    expect(await store.loadGroupMembers(secondPeer.id)).toEqual({
      value: [member],
      savedAt: 12_345,
    });
    expect((await store.loadBlob('file'))?.type).toBe('text/plain');

    await store.deleteMessages(undefined, [1]);
    await store.saveDraft(peer.id, '');
    await store.deletePinnedMessages(peer.id);
    await store.deleteGroupMembers(secondPeer.id);
    await store.deleteBlob('file');
    expect(await store.loadMessages(secondPeer.id)).toEqual([]);
    expect(await store.loadDrafts()).toEqual({});
    expect(await store.loadPinnedMessages(peer.id)).toBeUndefined();
    expect(await store.loadGroupMembers(secondPeer.id)).toBeUndefined();
    expect(await store.loadBlob('file')).toBeUndefined();
    vi.useRealTimers();
  });

  it('increments epochs and replaces only latest-state cache data in one commit', async () => {
    const store = new MemoryCacheStore({
      epoch: 6,
      cursor: { pts: 1, qts: 0, date: 1, seq: 1 },
      dialogs: [dialog(peer, 'Old', 6)],
      messages: [message(peer, 1, 6)],
      drafts: { [peer.id]: 'keep' },
      pending: [send('keep', 1)],
      blobs: {
        discard: new Blob(['discard']),
        preserve: new Blob(['preserve']),
      },
    });
    const cursor = { pts: 20, qts: 2, date: 30, seq: 4 };

    expect(await store.beginNewEpoch()).toBe(7);
    const epoch = await store.commitLatestState({
      cursor,
      dialogs: [dialog(secondPeer, 'Current', 0)],
      activeHistory: {
        peerId: secondPeer.id,
        messages: [{ ...message(secondPeer, 8, 0), text: 'Current message' }],
      },
      discardBlobKeys: ['discard'],
    });
    cursor.pts = 999;

    expect(epoch).toBe(8);
    expect(await store.loadEpoch()).toBe(8);
    expect(await store.loadCursor()).toEqual({ pts: 20, qts: 2, date: 30, seq: 4 });
    expect(await store.loadDialogs()).toEqual([
      expect.objectContaining({ title: 'Current', cacheEpoch: 8 }),
    ]);
    expect(await store.loadMessages(peer.id)).toEqual([]);
    expect(await store.loadMessages(secondPeer.id)).toEqual([
      expect.objectContaining({ id: 8, cacheEpoch: 8 }),
    ]);
    expect(await store.loadDrafts()).toEqual({ [peer.id]: 'keep' });
    expect((await store.loadOutbox()).map(({ id }) => id)).toEqual(['keep']);
    expect(await store.loadBlob('discard')).toBeUndefined();
    expect(await (await store.loadBlob('preserve'))?.text()).toBe('preserve');
  });

  it('upserts and orders the outbox while clearing only the captured draft revision', async () => {
    const store = new MemoryCacheStore({
      drafts: { [peer.id]: 'caption' },
      draftRevisions: { [peer.id]: 4 },
      pending: [send('later', 30)],
    });
    const second = { ...send('second', 10), queueOrder: 2 };
    const first = { ...send('first', 20), queueOrder: 1 };

    await store.commitOutbox([second, first], {
      peerId: peer.id,
      text: 'caption',
      revision: 4,
    });
    first.text = 'mutated after write';
    await store.commitOutbox({ ...send('later', 30), attempts: 2 });

    expect((await store.loadOutbox()).map(({ id }) => id)).toEqual(['first', 'second', 'later']);
    expect((await store.loadOutbox()).find(({ id }) => id === 'later')?.attempts).toBe(2);
    expect((await store.loadOutbox()).find(({ id }) => id === 'first')?.text).toBe('first');
    expect(await store.loadDrafts()).toEqual({});
    await store.deletePending('second');
    expect((await store.loadOutbox()).map(({ id }) => id)).toEqual(['first', 'later']);
  });

  it('clones a transport session at its boundary', async () => {
    const ordinary = new MemoryCacheStore();
    const session = { dcId: 2 };
    await ordinary.saveTransportSession(session);
    session.dcId = 4;
    expect(await ordinary.loadTransportSession()).toEqual({ dcId: 2 });
    await ordinary.saveTransportSession(undefined);
    expect(await ordinary.loadTransportSession()).toBeUndefined();
  });
});
