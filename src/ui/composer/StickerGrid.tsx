import { list, view } from 'effectweb';
import type { Effect } from 'effect';
import type { TelegramSticker } from '../../telegram/types';
import { stickerHoldPreview } from './stickerHoldPreview';
import { LazyMedia } from '../media/LazyMedia';
import { idRows } from '../collections';
interface StickerImageProps {
  sticker: TelegramSticker;
  load: () => Effect.Effect<string, unknown>;
  cachedUrl: () => string | undefined;
  eager?: boolean;
  label?: string | undefined;
}
export const StickerImage = view<StickerImageProps, never>((props, _send) => (
  <LazyMedia
    identity={props.sticker.id}
    mimeType={props.sticker.mimeType}
    label={props.label}
    placeholder={props.sticker.emoji}
    load={props.load}
    cachedUrl={props.cachedUrl}
    eager={props.eager}
    rootSelector=".sticker-pack-grid"
    class="sticker-image"
  />
));

export interface StickerGridProps {
  stickers: readonly TelegramSticker[];
  load: (sticker: TelegramSticker) => Effect.Effect<string, unknown>;
  cachedUrl: (sticker: TelegramSticker) => string | undefined;
  send: (sticker: TelegramSticker) => void;
  preview: (sticker: TelegramSticker) => void;
  holdPreview: (sticker: TelegramSticker | undefined) => void;
  enabled: boolean;
}
export const StickerGrid = view<StickerGridProps>((props) => (
  <>
    {list(idRows(props.stickers), (sticker) => (
      <div class="sticker-cell">
        <button
          class="sticker-option"
          use={stickerHoldPreview({
            show: () => props.holdPreview(sticker),
            hide: () => props.holdPreview(undefined),
          })}
          onContextMenu={(event) => {
            event.preventDefault();
            props.preview(sticker);
          }}
          disabled={!props.enabled}
          onClick={() => props.send(sticker)}
          aria-label={`Send ${sticker.emoji} sticker`}
          title={`${sticker.emoji} · Hold to preview · Right-click for options`}
        >
          <StickerImage
            sticker={sticker}
            load={() => props.load(sticker)}
            cachedUrl={() => props.cachedUrl(sticker)}
          />
        </button>
      </div>
    ))}
  </>
));
