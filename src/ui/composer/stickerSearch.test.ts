import { Context, Effect } from 'effect';
import { queryCache, querySource, fetchNextPage } from '@effectweb/query';
import { available } from 'effectweb';
import { expect, it, vi } from 'vitest';
import type { TelegramSticker, TelegramStickerSearchPage } from '../../telegram/types';
import { ExpressionSource, stickerSearch } from './expressionSession';
import { mergeStickerResults } from './StickerSearchResults';

const sticker = (id: string): TelegramSticker => ({
  id,
  accessHash: '1',
  fileReference: new Uint8Array([1]),
  emoji: '🐈',
  mimeType: 'image/webp',
});
const cacheFor = (searchStickers: NonNullable<ExpressionSource['searchStickers']>) =>
  queryCache(
    Context.make(ExpressionSource, {
      searchStickers,
      getRecentStickers: () => Effect.succeed([]),
      getStickerPacks: () => Effect.succeed([]),
      getSavedGifs: () => Effect.succeed([]),
      searchGifs: () => Effect.succeed([]),
      subscribeResources: () => Effect.succeed(Effect.void),
    }),
  );

it('merges local and remote stickers without duplicates, retaining the newest document reference', () => {
  const updated = { ...sticker('1'), fileReference: new Uint8Array([2]) };
  const merged = mergeStickerResults(
    [sticker('1')],
    [{ stickers: [updated, sticker('2')] }, { stickers: [sticker('2'), sticker('3')] }],
  );
  expect(merged.map((value) => value.id)).toEqual(['1', '2', '3']);
  expect(merged[0]?.fileReference).toEqual(new Uint8Array([2]));
});

it('loads all search pages with the server cursor', async () => {
  const search = vi.fn((_query: string, offset = 0) =>
    Effect.succeed<TelegramStickerSearchPage>(
      offset === 0
        ? { stickers: [sticker('1'), sticker('2')], nextOffset: 7 }
        : { stickers: [sticker('2'), sticker('3')] },
    ),
  );
  const cache = cacheFor(search);
  const source = querySource(cache, stickerSearch, 'cats');
  const stop = source.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(available(source.model())?.next).toBe(7));
    await Effect.runPromise(fetchNextPage(cache, stickerSearch, 'cats'));
    const data = available(source.model())!;
    expect(data.next).toBeUndefined();
    expect(
      mergeStickerResults(
        [],
        data.pages.map((page) => page.value),
      ).map((value) => value.id),
    ).toEqual(['1', '2', '3']);
    expect(search.mock.calls).toEqual([
      ['cats', 0],
      ['cats', 7],
    ]);
  } finally {
    stop();
    cache.dispose();
  }
});

it('cancels an abandoned query before its debounce sends an RPC', async () => {
  const search = vi.fn((_query: string, _offset = 0) => Effect.succeed({ stickers: [] }));
  const cache = cacheFor(search);
  const old = querySource(cache, stickerSearch, 'cat');
  const stopOld = old.subscribe(() => {});
  stopOld();
  const current = querySource(cache, stickerSearch, 'dog');
  const stop = current.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(available(current.model())).toBeDefined());
    expect(search.mock.calls).toEqual([['dog', 0]]);
  } finally {
    stop();
    cache.dispose();
  }
});
