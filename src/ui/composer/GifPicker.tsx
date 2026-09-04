import { createUiResource, createDebouncedValue } from '../reactivity/solid';
import type { UiLoad } from '../reactivity/model';
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';

import type { TelegramSticker } from '../../telegram/types';
import { VisibilityVideo } from '../media/VisibilityVideo';

function GifOption(props: {
  gif: TelegramSticker;
  load: () => Promise<string>;
  cachedUrl: () => string | undefined;
  send: () => void;
  enabled: boolean;
}) {
  const [visible, setVisible] = createSignal(false);
  const [loaded] = createUiResource(
    () => visible() && props.gif.id,
    () => props.cachedUrl() ?? props.load(),
  );
  const source = () => props.cachedUrl() ?? loaded();
  let button: HTMLButtonElement | undefined;
  onMount(() => {
    if (source()) return;
    const load = () => setVisible(true);
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
      disabled={!props.enabled}
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
  search: (query: string) => UiLoad<TelegramSticker[]>;
  send: (gif: TelegramSticker) => void;
  enabled: boolean;
  retry: () => Promise<void>;
}) {
  const term = () => props.query.trim();
  const debouncedTerm = createDebouncedValue(term);
  const [loadedSearch] = createUiResource(
    () => (term() && term() === debouncedTerm() ? term() : false),
    (query) => props.search(query),
    { namespace: 'gif-search' },
  );
  const searchResults = () => loadedSearch() ?? [];
  const searching = () => Boolean(term()) && (term() !== debouncedTerm() || loadedSearch.loading);
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
                enabled={props.enabled}
              />
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
