import { available, component, observe, resourceError, view, type Source } from 'effectweb';
import { Effect } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import type { InfiniteData } from '@effectweb/query';
import type { TelegramSticker, TelegramStickerSearchPage } from '../../telegram/types';
import { StickerGrid, type StickerGridProps } from './StickerGrid';

export type StickerSearchData = AsyncResult.AsyncResult<
  InfiniteData<TelegramStickerSearchPage, number>,
  unknown
>;
export interface StickerSearchProps {
  query: string;
  results: Source<StickerSearchData>;
  more: () => Effect.Effect<unknown, unknown>;
  retry: () => void;
}
export function mergeStickerResults(
  local: readonly TelegramSticker[],
  pages: readonly TelegramStickerSearchPage[],
) {
  return [
    ...new Map(
      [...local, ...pages.flatMap((page) => page.stickers)].map((sticker) => [sticker.id, sticker]),
    ).values(),
  ];
}
export const StickerSearchResults = component(
  {
    init: (
      _props: StickerSearchProps &
        Omit<StickerGridProps, 'stickers'> & { local: readonly TelegramSticker[] },
    ) => ({ next: AsyncResult.initial() as AsyncResult.AsyncResult<unknown, unknown> }),
    identity: (props) => props.query,
  },
  (owner) =>
    view((model) =>
      observe(model.props.results, (result) => {
        const props = model.props;
        const data = available(result);
        const rows = mergeStickerResults(props.local, data?.pages.map((page) => page.value) ?? []);
        const error = resourceError(result) || resourceError(model.next);
        return (
          <>
            <StickerGrid {...props} stickers={rows} />
            {result.waiting && !data ? (
              <p class="sticker-search-status" role="status">
                Searching Telegram…
              </p>
            ) : null}
            {error ? (
              <div class="sticker-search-status" role="alert">
                <p>Could not load sticker results.</p>
                <button
                  onClick={() => {
                    if (resourceError(model.next)) owner.task('next', props.more(), 'drop');
                    else props.retry();
                  }}
                >
                  Try again
                </button>
              </div>
            ) : null}
            {!result.waiting && !error && !rows.length ? (
              <p class="sticker-empty">No stickers found</p>
            ) : null}
            {data?.next !== undefined && !error ? (
              <button
                class="sticker-search-more"
                disabled={model.next.waiting}
                onClick={() => owner.task('next', props.more(), 'drop')}
              >
                {model.next.waiting ? 'Loading…' : 'More stickers'}
              </button>
            ) : null}
          </>
        );
      }),
    ),
);
