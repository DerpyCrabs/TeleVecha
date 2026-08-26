import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTelegramTransport } from './fixtureTransport';

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FixtureTelegramTransport contracts', () => {
  it('provides a stable account identity and per-channel cursor', async () => {
    const target = new FixtureTelegramTransport();
    const dialogs = await target.getDialogs();
    const channel = dialogs.dialogs.find(({ peer }) => peer.kind === 'channel');
    if (!channel) throw new Error('Expected a fixture channel.');
    if (channel.channelPts === undefined) throw new Error('Expected a fixture channel cursor.');

    await expect(target.getAuthorizedAccountId()).resolves.toBe('900000001');
    expect(channel.channelPts).toBe(10);
    await expect(
      target.getChannelDifference(channel.peer, channel.channelPts, 100),
    ).resolves.toEqual({ type: 'complete', pts: 10, updates: [] });
    expect(window.__televechaFixture?.stats.getAuthorizedAccountId).toBe(1);
    expect(window.__televechaFixture?.stats.getChannelDifference).toBe(1);
  });

  it('paginates peer search and shared media with deterministic continuation tokens', async () => {
    const target = new FixtureTelegramTransport();
    const alice = (await target.getDialogs()).dialogs.find(({ peer }) => peer.id === 'u:101')?.peer;
    if (!alice) throw new Error('Expected the Alice fixture peer.');

    const firstSearch = await target.searchMessages('Fixture message', alice, 2);
    expect(firstSearch).toMatchObject({
      messages: [{ id: 79 }, { id: 78 }],
      hasMore: true,
      nextOffset: { messageId: 78 },
    });
    await expect(
      target.searchMessages('Fixture message', alice, 2, firstSearch.nextOffset),
    ).resolves.toMatchObject({
      messages: [{ id: 77 }, { id: 75 }],
      hasMore: true,
    });

    const firstMedia = await target.getSharedMedia(alice, 'media', 1);
    expect(firstMedia).toMatchObject({
      messages: [{ id: 78 }],
      hasMore: true,
      nextOffset: { messageId: 78 },
    });
    await expect(target.getSharedMedia(alice, 'media', 1, firstMedia.nextOffset)).resolves.toEqual({
      messages: [expect.objectContaining({ id: 5 })],
      hasMore: false,
    });
    expect(window.__televechaFixture?.stats.searchMessages).toBe(2);
    expect(window.__televechaFixture?.stats.getSharedMedia).toBe(2);
  });

  it('uses peer and rate data to continue global search across duplicate message ids', async () => {
    const target = new FixtureTelegramTransport();

    const first = await target.searchMessages('message', undefined, 1);
    expect(first).toMatchObject({
      messages: [{ peerId: 'g:303', id: 12 }],
      hasMore: true,
      nextOffset: {
        messageId: 12,
        peer: { id: 'g:303' },
        rate: 1,
      },
    });
    await expect(
      target.searchMessages('message', undefined, 1, first.nextOffset),
    ).resolves.toMatchObject({
      messages: [{ peerId: 'u:101', id: 80 }],
      hasMore: true,
    });
  });
});
