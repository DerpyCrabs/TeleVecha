import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import { createFixtureTelegramTransport } from './fixtureTransport';

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FixtureTelegramTransport contracts', () => {
  const make = () => Effect.runPromise(Effect.scoped(createFixtureTelegramTransport()));
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  it('edits, pins and reacts without mutating messages already returned to callers', async () => {
    const target = await make();
    const peer = { id: 'u:101', kind: 'user' as const, accessHash: '1' };
    const read = async () =>
      (await run(target.getHistory(peer, 80))).messages.find((message) => message.id === 20)!;
    const original = Object.freeze(await read());
    await run(target.setPinnedMessage(peer, original.id, true));
    const pinned = Object.freeze(await read());
    expect(pinned).not.toBe(original);
    expect(pinned.pinned).toBe(true);
    expect(original.pinned).not.toBe(true);
    await run(target.setReaction(peer, original.id, '👍'));
    const reacted = Object.freeze(await read());
    expect(reacted.reactions).toMatchObject([{ emoji: '👍', chosen: true }]);
    expect(pinned.reactions).not.toEqual(reacted.reactions);
    await run(target.editMessage(peer, original.id, 'Immutable fixture edit'));
    expect((await read()).text).toBe('Immutable fixture edit');
    expect(original.text).toBe('Fixture message 20');
    expect(reacted.text).toBe(original.text);
  });

  it('provides a stable account identity and per-channel cursor', async () => {
    const target = await make();
    const dialogs = await run(target.getDialogs());
    const channel = dialogs.dialogs.find(({ peer }) => peer.kind === 'channel');
    if (!channel) throw new Error('Expected a fixture channel.');
    if (channel.channelPts === undefined) throw new Error('Expected a fixture channel cursor.');

    await expect(run(target.getAuthorizedAccountId())).resolves.toBe('900000001');
    expect(channel.channelPts).toBe(10);
    await expect(
      run(target.getChannelDifference(channel.peer, channel.channelPts, 100)),
    ).resolves.toEqual({ type: 'complete', pts: 10, updates: [] });
    expect(window.__televechaFixture?.stats.getAuthorizedAccountId).toBe(1);
    expect(window.__televechaFixture?.stats.getChannelDifference).toBe(1);
  });

  it('paginates peer search and shared media with deterministic continuation tokens', async () => {
    const target = await make();
    const alice = (await run(target.getDialogs())).dialogs.find(
      ({ peer }) => peer.id === 'u:101',
    )?.peer;
    if (!alice) throw new Error('Expected the Alice fixture peer.');

    const firstSearch = await run(target.searchMessages('Fixture message', alice, 2));
    expect(firstSearch).toMatchObject({
      messages: [{ id: 79 }, { id: 78 }],
      hasMore: true,
      nextOffset: { messageId: 78 },
    });
    await expect(
      run(target.searchMessages('Fixture message', alice, 2, firstSearch.nextOffset)),
    ).resolves.toMatchObject({ messages: [{ id: 77 }, { id: 75 }], hasMore: true });

    const firstMedia = await run(target.getSharedMedia(alice, 'photos', 1));
    expect(firstMedia).toMatchObject({
      messages: [{ id: 78 }],
      hasMore: true,
      nextOffset: { messageId: 78 },
    });
    await expect(
      run(target.getSharedMedia(alice, 'photos', 1, firstMedia.nextOffset)),
    ).resolves.toEqual({ messages: [expect.objectContaining({ id: 5 })], hasMore: false });
    expect(window.__televechaFixture?.stats.searchMessages).toBe(2);
    expect(window.__televechaFixture?.stats.getSharedMedia).toBe(2);
  });

  it('uses peer and rate data to continue global search across duplicate message ids', async () => {
    const target = await make();

    const first = await run(target.searchMessages('message', undefined, 1));
    expect(first).toMatchObject({
      messages: [{ peerId: 'g:303', id: 12 }],
      hasMore: true,
      nextOffset: { messageId: 12, peer: { id: 'g:303' }, rate: 1 },
    });
    await expect(
      run(target.searchMessages('message', undefined, 1, first.nextOffset)),
    ).resolves.toMatchObject({ messages: [{ peerId: 'u:101', id: 80 }], hasMore: true });
  });

  it('returns group members in pages with a stable continuation offset', async () => {
    const target = await make();
    const group = (await run(target.getDialogs())).dialogs.find(
      ({ peer }) => peer.kind === 'group',
    );
    if (!group || !target.getGroupMembers) throw new Error('Expected a fixture group.');

    const first = await run(target.getGroupMembers(group.peer, 1));
    expect(first).toMatchObject({
      members: [{ peer: { id: 'u:404' } }],
      totalCount: 2,
      hasMore: true,
      nextOffset: 1,
    });
    await expect(
      run(target.getGroupMembers(group.peer, 1, first.nextOffset)),
    ).resolves.toMatchObject({
      members: [{ peer: { id: 'u:405' } }],
      totalCount: 2,
      hasMore: false,
    });
  });
});
