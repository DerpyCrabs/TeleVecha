import Search from 'lucide-solid/icons/search';
import { For, Show, createMemo, createSignal } from 'solid-js';

import type { TelegramSticker, TelegramStickerPack } from '../telegram/types';
import { GifPicker } from './GifPicker';
import { StickerPicker } from './StickerPicker';
import { emojiEntries } from './emojiData';

export type ExpressionTab = 'emoji' | 'gifs' | 'stickers';

interface ExpressionPickerProps {
  tab: ExpressionTab;
  setTab: (tab: ExpressionTab) => void;
  stickersLoading: boolean;
  gifsLoading: boolean;
  gifs: TelegramSticker[];
  packs: TelegramStickerPack[];
  insertEmoji: (emoji: string) => void;
  load: (sticker: TelegramSticker) => Promise<string>;
  stickerUrl: (sticker: TelegramSticker) => string | undefined;
  sendSticker: (sticker: TelegramSticker) => void;
  sendGif: (gif: TelegramSticker) => void;
  searchGifs: (query: string) => Promise<TelegramSticker[]>;
}

export function ExpressionPicker(props: ExpressionPickerProps) {
  const [query, setQuery] = createSignal('');
  const matchingEmoji = createMemo(() => {
    const term = query().trim().toLocaleLowerCase();
    return term
      ? emojiEntries.filter(({ value, keywords }) => `${value} ${keywords}`.includes(term))
      : emojiEntries;
  });
  return (
    <div class="expression-picker" role="dialog" aria-label="Emoji, GIFs and stickers">
      <nav class="expression-tabs" aria-label="Picker type">
        <For each={['emoji', 'gifs', 'stickers'] as const}>
          {(tab) => (
            <button
              classList={{ active: props.tab === tab }}
              aria-pressed={props.tab === tab}
              onClick={() => props.setTab(tab)}
            >
              {tab === 'emoji' ? 'Emoji' : tab === 'gifs' ? 'GIFs' : 'Stickers'}
            </button>
          )}
        </For>
      </nav>
      <label class="expression-search">
        <Search size={15} />
        <input
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder={`Search ${props.tab}`}
          aria-label="Search expressions"
        />
      </label>
      <div class="expression-content">
        <Show when={props.tab === 'emoji'}>
          <div class="emoji-grid" aria-label="Emoji">
            <For each={matchingEmoji()} fallback={<p>No emoji found</p>}>
              {(item) => (
                <button
                  onClick={() => props.insertEmoji(item.value)}
                  aria-label={`Insert ${item.value}`}
                >
                  {item.value}
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.tab === 'gifs'}>
          <GifPicker
            gifs={props.gifs}
            loading={props.gifsLoading}
            load={props.load}
            send={props.sendGif}
            query={query()}
            cachedUrl={props.stickerUrl}
            search={props.searchGifs}
          />
        </Show>
        <Show when={props.tab === 'stickers'}>
          <StickerPicker
            packs={props.packs}
            loading={props.stickersLoading}
            load={props.load}
            send={props.sendSticker}
            query={query()}
            cachedUrl={props.stickerUrl}
          />
        </Show>
      </div>
    </div>
  );
}
