import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';

import type { TelegramSticker } from '../../telegram/types';
import { VisibilityVideo } from '../media/VisibilityVideo';

function GifOption(props: {
  gif: TelegramSticker;
  load: () => Promise<string>;
  cachedUrl: () => string | undefined;
  send: () => void;
}) {
  const [source, setSource] = createSignal(props.cachedUrl() ?? '');
  let button: HTMLButtonElement | undefined;
  onMount(() => {
    if (source()) return;
    const load = () => void props.load().then(setSource, () => undefined);
    if (!('IntersectionObserver' in window)) return load();
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        load();
      },
      { root: button?.closest('.gif-picker') ?? null, rootMargin: '120px' },
    );
    if (button) observer.observe(button);
    onCleanup(() => observer.disconnect());
  });
  return (
    <button
      ref={(element) => (button = element)}
      onClick={props.send}
      aria-label={`Send GIF ${props.gif.title ?? props.gif.emoji}`}
    >
      <Show when={source()} fallback={<span class="gif-placeholder">GIF</span>}>
        {(url) =>
          props.gif.mimeType.startsWith('video/') ? (
            <VisibilityVideo source={url()} label={`GIF ${props.gif.title ?? ''}`.trim()} />
          ) : (
            <img src={url()} alt="GIF" />
          )
        }
      </Show>
    </button>
  );
}

export function GifPicker(props: {
  gifs: TelegramSticker[];
  loading: boolean;
  error: string;
  query: string;
  load: (gif: TelegramSticker) => Promise<string>;
  cachedUrl: (gif: TelegramSticker) => string | undefined;
  search: (query: string) => Promise<TelegramSticker[]>;
  send: (gif: TelegramSticker) => void;
  retry: () => Promise<void>;
}) {
  const [searchResults, setSearchResults] = createSignal<TelegramSticker[]>([]);
  const [searching, setSearching] = createSignal(false);
  let searchVersion = 0;
  createEffect(() => {
    const query = props.query.trim();
    const version = ++searchVersion;
    if (!query) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void props
        .search(query)
        .then(
          (results) => {
            if (version === searchVersion) setSearchResults(results);
          },
          () => {
            if (version === searchVersion) setSearchResults([]);
          },
        )
        .finally(() => {
          if (version === searchVersion) setSearching(false);
        });
    }, 250);
    onCleanup(() => window.clearTimeout(timer));
  });
  const results = createMemo(() => {
    const term = props.query.trim().toLocaleLowerCase();
    return term ? searchResults() : props.gifs;
  });
  return (
    <div class="gif-picker" aria-label="GIFs">
      <Show when={!props.loading} fallback={<p>Loading GIF index…</p>}>
        <Show
          when={!props.error}
          fallback={
            <div role="alert">
              <p>{props.error}</p>
              <button onClick={() => void props.retry()}>Retry GIFs</button>
            </div>
          }
        >
          <For
            each={results()}
            fallback={<p>{searching() ? 'Searching Telegram…' : 'No GIFs found'}</p>}
          >
            {(gif) => (
              <GifOption
                gif={gif}
                load={() => props.load(gif)}
                cachedUrl={() => props.cachedUrl(gif)}
                send={() => props.send(gif)}
              />
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
