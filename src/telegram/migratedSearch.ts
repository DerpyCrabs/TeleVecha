import { Effect } from 'effect';
import type { TelegramPeer, TelegramSearchOffset, TelegramSearchPage } from './types';

/** Channel messages follow the old basic-group history. Keep each peer's cursor
 * separate: the two message ID sequences can overlap and have unrelated ranges. */
export function migratedSearchPage<E, R>(
  current: TelegramPeer,
  previous: TelegramPeer | undefined,
  limit: number,
  offset: TelegramSearchOffset | undefined,
  load: (
    peer: TelegramPeer,
    limit: number,
    offset: TelegramSearchOffset | undefined,
  ) => Effect.Effect<TelegramSearchPage, E, R>,
): Effect.Effect<TelegramSearchPage, E, R> {
  return Effect.gen(function* () {
    if (!previous) return yield* load(current, limit, offset);
    const oldPage = (size: number, cursor?: TelegramSearchOffset) =>
      load(previous, size, cursor).pipe(
        Effect.map((page) => ({
          ...page,
          nextOffset: page.nextOffset ? { ...page.nextOffset, peer: previous } : undefined,
        })),
      );
    if (offset?.peer?.id === previous.id) return yield* oldPage(limit, offset);
    const recent = yield* load(current, limit, offset);
    if (recent.hasMore) return recent;
    const remaining = limit - recent.messages.length;
    if (remaining <= 0)
      return { ...recent, hasMore: true, nextOffset: { messageId: 0, peer: previous } };
    const earlier = yield* oldPage(remaining);
    return {
      ...recent,
      messages: [...recent.messages, ...earlier.messages],
      hasMore: earlier.hasMore,
      nextOffset: earlier.nextOffset,
    };
  });
}
