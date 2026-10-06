import {
  available,
  list,
  observe,
  resourceError,
  slot,
  view,
  type Snapshot,
  type Source,
} from 'effectweb';
import type { Effect } from 'effect';
import type * as AsyncResult from 'effect/reactivity/AsyncResult';
import type { TelegramSticker } from '../../telegram/types';
import type { MessagingError } from '../../telegram/core/messagingError';
import { idRows } from '../collections';
import { LazyMedia } from '../media/LazyMedia';
const GifOption = view<
  {
    gif: TelegramSticker;
    load: () => Effect.Effect<string, unknown>;
    cachedUrl: () => string | undefined;
    send: () => void;
    enabled: boolean;
  },
  never
>((props, _send) => {
  return (
    <button
      onClick={props.send}
      disabled={!props.enabled}
      aria-label={`Send GIF ${props.gif.title ?? props.gif.emoji}`}
    >
      <LazyMedia
        identity={props.gif.id}
        mimeType={props.gif.mimeType}
        label={`GIF ${props.gif.title ?? ''}`.trim()}
        placeholder="GIF"
        load={props.load}
        cachedUrl={props.cachedUrl}
        rootSelector=".gif-picker"
      />
    </button>
  );
});
/** Cached search results for one term. */
export type GifResults = Source<
  AsyncResult.AsyncResult<Snapshot<TelegramSticker[]>, MessagingError>
>;
export const GifPicker = view<{
  gifs: TelegramSticker[];
  loading: boolean;
  error: string;
  query: string;
  load: (gif: TelegramSticker) => Effect.Effect<string, unknown>;
  cachedUrl: (gif: TelegramSticker) => string | undefined;
  /** Search results for the current query; absent when the query is empty or search is unavailable. */
  results?: GifResults | undefined;
  send: (gif: TelegramSticker) => void;
  enabled: boolean;
  retry: () => Effect.Effect<void, unknown>;
}>((props) => {
  const results = slot((gifs: readonly TelegramSticker[]) => {
    if (!gifs.length) return <p>No GIFs found</p>;
    return list(idRows(gifs), (gif) => (
      <GifOption
        gif={gif}
        load={() => props.load(gif)}
        cachedUrl={() => props.cachedUrl(gif)}
        send={() => props.send(gif)}
        enabled={props.enabled}
      />
    ));
  });
  const contents = () => {
    if (props.loading) return <p>Loading GIF index…</p>;
    if (props.error)
      return (
        <div role="alert">
          <p>{props.error}</p>
          <button onClick={() => props.retry()}>Retry GIFs</button>
        </div>
      );
    if (props.results)
      return observe(props.results, (result) => {
        const gifs = available(result);
        const failed = !result.waiting && resourceError(result) !== undefined;
        const failure = failed ? <p role="alert">Could not search GIFs. Try again.</p> : null;
        if (gifs)
          return (
            <>
              {results(gifs)}
              {failure}
            </>
          );
        return failure ?? <p>Searching Telegram…</p>;
      });
    return results(props.query.trim() ? [] : props.gifs);
  };
  return (
    <div class="gif-picker" aria-label="GIFs">
      {contents()}
    </div>
  );
});
