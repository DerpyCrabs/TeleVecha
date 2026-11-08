import { Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import { migratedSearchPage } from './migratedSearch';
import type {
  TelegramMessage,
  TelegramPeer,
  TelegramSearchOffset,
  TelegramSearchPage,
} from './types';
const current: TelegramPeer = { id: 'c:20', kind: 'channel', accessHash: '2' };
const previous: TelegramPeer = { id: 'g:10', kind: 'group' };
const message = (peer: TelegramPeer, id: number): TelegramMessage => ({
  id,
  peerId: peer.id,
  senderId: 'u:1',
  text: 'match',
  date: id,
  outgoing: false,
});
it('fills a partial last channel page from the old group without conflating IDs', async () => {
  const load = vi.fn(
    (
      peer: TelegramPeer,
      _limit: number,
      _offset: TelegramSearchOffset | undefined,
    ): Effect.Effect<TelegramSearchPage> =>
      Effect.succeed(
        peer.id === current.id
          ? { messages: [message(peer, 7)], hasMore: false }
          : { messages: [message(peer, 7)], hasMore: true, nextOffset: { messageId: 7 } },
      ),
  );
  const page = await Effect.runPromise(migratedSearchPage(current, previous, 2, undefined, load));
  expect(page.messages.map((item) => `${item.peerId}:${item.id}`)).toEqual(['c:20:7', 'g:10:7']);
  expect(page.nextOffset).toEqual({ messageId: 7, peer: previous });
  expect(load.mock.calls[1]?.slice(0, 2)).toEqual([previous, 1]);
  load.mockClear();
  await Effect.runPromise(migratedSearchPage(current, previous, 2, page.nextOffset, load));
  expect(load).toHaveBeenCalledTimes(1);
  expect(load.mock.calls[0]).toEqual([previous, 2, { messageId: 7, peer: previous }]);
});
it('does not request old history before current search results are exhausted', async () => {
  const load = vi.fn((peer: TelegramPeer) =>
    Effect.succeed({ messages: [message(peer, 8)], hasMore: true, nextOffset: { messageId: 8 } }),
  );
  const page = await Effect.runPromise(migratedSearchPage(current, previous, 1, undefined, load));
  expect(load).toHaveBeenCalledTimes(1);
  expect(page.nextOffset).toEqual({ messageId: 8 });
});
it('uses an explicit old-peer boundary when the last new page is full', async () => {
  const load = vi.fn((peer: TelegramPeer) =>
    Effect.succeed({ messages: [message(peer, 8)], hasMore: false }),
  );
  const page = await Effect.runPromise(migratedSearchPage(current, previous, 1, undefined, load));
  expect(page.nextOffset).toEqual({ messageId: 0, peer: previous });
  expect(load).toHaveBeenCalledTimes(1);
});
it('returns a terminal page when neither history contains a result', async () => {
  const load = vi.fn(() => Effect.succeed({ messages: [], hasMore: false }));
  expect(
    await Effect.runPromise(migratedSearchPage(current, previous, 10, undefined, load)),
  ).toMatchObject({ messages: [], hasMore: false });
  expect(load).toHaveBeenCalledTimes(2);
});
