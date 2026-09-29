import { list as renderList, localComponent, sequence, view } from 'effectweb';
import type { Effect } from 'effect';
import type { TelegramSticker, TelegramStickerPack } from '../../telegram/types';
import { emojiRows } from '../collections';
import Search from '@effectweb/lucide/icons/search';
import { GifPicker, type GifResults } from './GifPicker';
import { StickerPicker } from './StickerPicker';
import { emojiEntries } from './emojiData';
export type ExpressionTab = 'emoji' | 'gifs' | 'stickers';
interface ExpressionPickerProps {
  tab: ExpressionTab;
  setTab: (tab: ExpressionTab) => void;
  stickersLoading: boolean;
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
export const ExpressionPicker = localComponent<ExpressionPickerProps, { query: string }>({
  init: () => ({ query: '' }),
  view: view((model, send) => {
    const props = model.props;
    const matchingEmoji = (() => {
      const term = model.query.trim().toLocaleLowerCase();
      return term
        ? emojiEntries.filter(({ value, keywords }) => `${value} ${keywords}`.includes(term))
        : emojiEntries;
    })();
    return (
      <div class="expression-picker" role="dialog" aria-label="Emoji, GIFs and stickers">
        <nav class="expression-tabs" aria-label="Picker type">
          {renderList(sequence(['emoji', 'gifs', 'stickers'] as const), (tab) => (
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
            value={model.query}
            onInput={(event) => send({ query: event.currentTarget.value })}
            placeholder={`Search ${props.tab}`}
            aria-label="Search expressions"
          />
        </label>
        <div class="expression-content">
          {props.tab === 'emoji' ? (
            <div class="emoji-grid" aria-label="Emoji">
              {matchingEmoji!.length ? (
                renderList(emojiRows(matchingEmoji), (item) => (
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
              loading={props.stickersLoading}
              load={props.load}
              send={props.sendSticker}
              query={model.query}
              cachedUrl={props.stickerUrl}
              enabled={props.canSend && props.canSendStickers}
            />
          ) : null}
        </div>
      </div>
    );
  }),
});
