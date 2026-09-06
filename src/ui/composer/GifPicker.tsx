import type { Effect } from 'effect';
import type { TelegramSticker } from '../../telegram/types';
import { idRows } from '../collections';
import { LazyMedia } from '../media/LazyMedia';
import { AsyncContent, effectEvent, resourceComponent, slot, view } from 'effectweb';
import type { UiLoad } from 'effectweb/cache';
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
export const GifPicker = resourceComponent<
  {
    gifs: TelegramSticker[];
    loading: boolean;
    error: string;
    query: string;
    load: (gif: TelegramSticker) => Effect.Effect<string, unknown>;
    cachedUrl: (gif: TelegramSticker) => string | undefined;
    search: (query: string) => UiLoad<TelegramSticker[]>;
    send: (gif: TelegramSticker) => void;
    enabled: boolean;
    retry: () => Effect.Effect<void, unknown>;
  },
  TelegramSticker[]
>({
  request: (props) =>
    props.query.trim()
      ? { key: props.query.trim(), delay: 250, load: () => props.search(props.query.trim()) }
      : undefined,
  view: view((model, _send) => {
    const props = model.props;
    const results = slot((gifs: TelegramSticker[]) => {
      if (!gifs.length) return <p>No GIFs found</p>;
      return idRows(gifs).map((gif) => (
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
            <button onClick={effectEvent('drop', () => props.retry())}>Retry GIFs</button>
          </div>
        );
      if (props.query.trim())
        return (
          <AsyncContent
            result={model.result}
            content={results}
            pending={<p>Searching Telegram…</p>}
            empty={<p>Searching Telegram…</p>}
            failure={slot((_cause) => (
              <p role="alert">Could not search GIFs. Try again.</p>
            ))}
          />
        );
      return results(props.gifs);
    };
    return (
      <div class="gif-picker" aria-label="GIFs">
        {contents()}
      </div>
    );
  }),
});
