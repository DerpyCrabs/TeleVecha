import type { StickerSearchProps } from './StickerSearchResults';
import type { StickerPackActions } from './StickerPackManager';
import { list, component, sequence, view } from 'effectweb';
import type { Effect } from 'effect';
import type { TelegramSticker, TelegramStickerPack } from '../../telegram/types';
import { emojiRows } from '../collections';
import Search from '@effectweb/lucide/icons/search';
import { GifPicker, type GifResults } from './GifPicker';
import { pickerPageMotion } from './pickerPageMotion';
import { StickerPicker } from './StickerPicker';
import { emojiEntries } from './emojiData';
export type ExpressionTab = 'emoji' | 'gifs' | 'stickers';
interface ExpressionPickerProps {
  packActions: StickerPackActions;
  stickerSearch: (query: string) => StickerSearchProps;
  tab: ExpressionTab;
  setTab: (tab: ExpressionTab) => void;
  stickersLoading: boolean;
  stickerError: string;
  retryStickers: () => Effect.Effect<void, unknown>;
  setStickerFavorite: (sticker: TelegramSticker, favorite: boolean) => Effect.Effect<void, unknown>;
  gifsLoading: boolean;
  gifError: string;
  gifs: TelegramSticker[];
  packs: TelegramStickerPack[];
  insertEmoji: (emoji: string) => void;
  canSend: boolean;
  canSendGifs: boolean;
  canSendStickers: boolean;
  load: (sticker: TelegramSticker) => Effect.Effect<string, unknown>;
  stickerUrl: (sticker: TelegramSticker) => string | undefined;
  sendSticker: (sticker: TelegramSticker) => void;
  sendGif: (gif: TelegramSticker) => void;
  gifSearch?: ((text: string) => GifResults) | undefined;
  retryGifs: () => Effect.Effect<void, unknown>;
}
export const ExpressionPicker = component<ExpressionPickerProps, { query: string }>(
  { init: () => ({ query: '' }) },
  view((model, send) => {
    const props = model.props;
    const matchingEmoji = (() => {
      const term = model.query.trim().toLocaleLowerCase();
      return term
        ? emojiEntries.filter(({ value, keywords }) => `${value} ${keywords}`.includes(term))
        : emojiEntries;
    })();
    return (
      <div class="expression-picker" role="dialog" aria-label="Emoji, GIFs and stickers">
        <nav class="expression-tabs" data-tab={props.tab} aria-label="Picker type">
          {list(sequence(['emoji', 'gifs', 'stickers'] as const), (tab) => (
            <button
              classList={{ active: props.tab === tab }}
              aria-pressed={props.tab === tab}
              disabled={
                (tab === 'gifs' && !props.canSendGifs) ||
                (tab === 'stickers' && !props.canSendStickers)
              }
              onClick={() => props.setTab(tab)}
            >
              {tab === 'emoji' ? 'Emoji' : tab === 'gifs' ? 'GIFs' : 'Stickers'}
            </button>
          ))}
        </nav>
        <label class="expression-search">
          <Search size={15} />
          <input
            type="search"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && model.query) {
                event.preventDefault();
                event.stopPropagation();
                send({ query: '' });
              }
            }}
            value={model.query}
            onInput={(event) => send({ query: event.currentTarget.value })}
            placeholder={`Search ${props.tab}`}
            aria-label="Search expressions"
          />
        </label>
        <div class="expression-content" use={pickerPageMotion(props.tab)}>
          {props.tab === 'emoji' ? (
            <div class="emoji-grid" aria-label="Emoji">
              {matchingEmoji!.length ? (
                list(emojiRows(matchingEmoji), (item) => (
                  <button
                    disabled={!props.canSend}
                    onClick={() => props.insertEmoji(item.value)}
                    aria-label={`Insert ${item.value}`}
                  >
                    {item.value}
                  </button>
                ))
              ) : (
                <p>No emoji found</p>
              )}
            </div>
          ) : null}
          {props.tab === 'gifs' ? (
            <GifPicker
              gifs={props.gifs}
              loading={props.gifsLoading}
              error={props.gifError}
              load={props.load}
              send={props.sendGif}
              query={model.query}
              cachedUrl={props.stickerUrl}
              results={
                props.gifSearch && model.query.trim()
                  ? props.gifSearch(model.query.trim())
                  : undefined
              }
              retry={props.retryGifs}
              enabled={props.canSend && props.canSendGifs}
            />
          ) : null}
          {props.tab === 'stickers' ? (
            <StickerPicker
              packs={props.packs}
              search={model.query.trim() ? props.stickerSearch(model.query.trim()) : undefined}
              packActions={props.packActions}
              error={props.stickerError}
              retry={props.retryStickers}
              setFavorite={props.setStickerFavorite}
              loading={props.stickersLoading}
              load={props.load}
              send={props.sendSticker}
              query={model.query}
              clearQuery={() => send({ query: '' })}
              cachedUrl={props.stickerUrl}
              enabled={props.canSend && props.canSendStickers}
            />
          ) : null}
        </div>
      </div>
    );
  }),
);
