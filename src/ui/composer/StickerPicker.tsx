import { list as renderList } from 'effectweb';
import type { Effect } from 'effect';
import type { TelegramSticker, TelegramStickerPack } from '../../telegram/types';
import { idRows } from '../collections';
import Clock3 from '@effectweb/lucide/icons/clock-3';
import { LazyMedia } from '../media/LazyMedia';
import { component, view } from 'effectweb';
function scrollPackTabs(event: WheelEvent & { currentTarget: HTMLElement }) {
  if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  event.currentTarget.scrollLeft += delta;
  event.preventDefault();
}
interface StickerImageProps {
  sticker: TelegramSticker;
  load: () => Effect.Effect<string, unknown>;
  cachedUrl: () => string | undefined;
  eager?: boolean;
  label?: string | undefined;
}
const StickerImage = view<StickerImageProps, never>((props, _send) => (
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
type StickerPickerModel = {
  props: {
    packs: TelegramStickerPack[];
    loading: boolean;
    query: string;
    load: (sticker: TelegramSticker) => Effect.Effect<string, unknown>;
    cachedUrl: (sticker: TelegramSticker) => string | undefined;
    send: (sticker: TelegramSticker) => void;
    enabled: boolean;
  };
  activePackId: string;
};
type StickerPickerMessage = { type: 'ActivePackId'; value: string };
export const StickerPicker = component<
  {
    packs: TelegramStickerPack[];
    loading: boolean;
    query: string;
    load: (sticker: TelegramSticker) => Effect.Effect<string, unknown>;
    cachedUrl: (sticker: TelegramSticker) => string | undefined;
    send: (sticker: TelegramSticker) => void;
    enabled: boolean;
  },
  StickerPickerModel,
  StickerPickerMessage
>({
  init: (props) => ({ props, activePackId: 'recent' }),

  update: (model, message) => {
    switch (message.type) {
      case 'ActivePackId':
        return { model: { ...model, activePackId: message.value } };
    }
  },
  view: view((model, send) => {
    const props = model.props;
    const activePack = () =>
      props.packs.find(({ id }) => id === model.activePackId) ?? props.packs[0];
    const results = (() => {
      const term = props.query.trim().toLocaleLowerCase();
      if (!term) return activePack()?.stickers ?? [];
      return [
        ...new Map(
          props.packs
            .flatMap((pack) =>
              pack.stickers.filter((sticker) =>
                `${pack.title} ${sticker.emoji}`.toLocaleLowerCase().includes(term),
              ),
            )
            .map((sticker) => [sticker.id, sticker]),
        ).values(),
      ];
    })();
    return (
      <div class="sticker-picker" aria-label="Stickers">
        {!props.loading ? (
          <>
            <nav class="sticker-pack-tabs" aria-label="Sticker packs" onWheel={scrollPackTabs}>
              {renderList(idRows(props.packs), (pack) => (
                <button
                  classList={{ active: pack.id === activePack()?.id }}
                  onClick={(event) => {
                    send({ type: 'ActivePackId', value: pack.id });
                    event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'center' });
                  }}
                  aria-label={pack.title}
                  title={pack.title}
                >
                  {pack.id !== 'recent' ? (
                    pack.stickers[0] ? (
                      ((sticker) => (
                        <StickerImage
                          sticker={sticker}
                          load={() => props.load(sticker)}
                          cachedUrl={() => props.cachedUrl(sticker)}
                          eager
                          label={`${pack.title} icon`}
                        />
                      ))(pack.stickers[0]!)
                    ) : null
                  ) : (
                    <Clock3 size={19} aria-hidden="true" />
                  )}
                </button>
              ))}
            </nav>
            <div
              class="sticker-pack-grid"
              aria-label={
                props.query ? 'Sticker search results' : activePack()?.title || 'Sticker pack'
              }
            >
              {results!.length ? (
                renderList(idRows(results), (sticker) => (
                  <button
                    class="sticker-option"
                    disabled={!props.enabled}
                    onClick={() => props.send(sticker)}
                    aria-label={`Send ${sticker.emoji} sticker`}
                    title={sticker.emoji}
                  >
                    <StickerImage
                      sticker={sticker}
                      load={() => props.load(sticker)}
                      cachedUrl={() => props.cachedUrl(sticker)}
                    />
                  </button>
                ))
              ) : (
                <p>No stickers found</p>
              )}
            </div>
          </>
        ) : (
          <p>Loading sticker index…</p>
        )}
      </div>
    );
  }),
});
