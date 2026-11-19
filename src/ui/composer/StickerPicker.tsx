import { pickerPageMotion } from './pickerPageMotion';
import { StickerGrid, StickerImage } from './StickerGrid';
import { StickerSearchResults, type StickerSearchProps } from './StickerSearchResults';
import Settings from '@effectweb/lucide/icons/settings';
import { StickerPackManager, type StickerPackActions } from './StickerPackManager';
import Star from '@effectweb/lucide/icons/star';
import { StickerPreview } from './StickerPreview';
import { list, Portal } from 'effectweb';
import type { Effect } from 'effect';
import type { TelegramSticker, TelegramStickerPack } from '../../telegram/types';
import { idRows } from '../collections';
import Clock3 from '@effectweb/lucide/icons/clock-3';
import { component, view } from 'effectweb';
function scrollPackTabs(event: WheelEvent & { currentTarget: HTMLElement }) {
  if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  event.currentTarget.scrollLeft += delta;
  event.preventDefault();
}
type StickerPickerState = {
  activePackId: string;
  preview: TelegramSticker | undefined;
  managing: boolean;
  held: TelegramSticker | undefined;
};
type StickerPickerMessage =
  | { type: 'ActivePackId'; value: string }
  | { type: 'Preview'; value: TelegramSticker | undefined }
  | { type: 'Held'; value: TelegramSticker | undefined }
  | { type: 'Manage'; value: boolean };
export const StickerPicker = component<
  {
    packActions: StickerPackActions;
    packs: TelegramStickerPack[];
    loading: boolean;
    error: string;
    retry: () => Effect.Effect<void, unknown>;
    setFavorite: (sticker: TelegramSticker, favorite: boolean) => Effect.Effect<void, unknown>;
    query: string;
    clearQuery: () => void;
    search?: StickerSearchProps | undefined;
    load: (sticker: TelegramSticker) => Effect.Effect<string, unknown>;
    cachedUrl: (sticker: TelegramSticker) => string | undefined;
    send: (sticker: TelegramSticker) => void;
    enabled: boolean;
  },
  StickerPickerState,
  StickerPickerMessage
>(
  {
    init: () => ({ activePackId: 'recent', preview: undefined, managing: false, held: undefined }),
    update: (model, message) => {
      switch (message.type) {
        case 'Held':
          return { model: { ...model, held: message.value } };
        case 'Manage':
          return { model: { ...model, managing: message.value } };
        case 'Preview':
          return { model: { ...model, preview: message.value } };
        case 'ActivePackId':
          return { model: { ...model, activePackId: message.value } };
      }
    },
  },
  view((model, send) => {
    const props = model.props;
    const activePack = () =>
      props.packs.find(({ id }) => id === model.activePackId) ??
      props.packs.find((pack) => pack.stickers.length > 0) ??
      props.packs[0];
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
        {props.error ? (
          <div class="sticker-catalog-error" role="alert">
            <span>{props.error}</span>
            <button onClick={props.retry}>Try again</button>
          </div>
        ) : null}
        {!props.loading ? (
          <>
            <nav class="sticker-pack-tabs" aria-label="Sticker packs" onWheel={scrollPackTabs}>
              {list(idRows(props.packs), (pack) => (
                <button
                  classList={{ active: !props.query && pack.id === activePack()?.id }}
                  aria-pressed={!props.query && pack.id === activePack()?.id}
                  onClick={(event) => {
                    send({ type: 'ActivePackId', value: pack.id });
                    props.clearQuery();
                    event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'center' });
                  }}
                  aria-label={pack.title}
                  title={pack.title}
                >
                  {pack.id === 'favorites' ? (
                    <Star size={19} aria-hidden="true" />
                  ) : pack.id !== 'recent' ? (
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
              <button
                class="sticker-manage-packs"
                title="Manage sticker packs"
                aria-label="Manage sticker packs"
                onClick={() => send({ type: 'Manage', value: true })}
              >
                <Settings size={19} />
              </button>
            </nav>
            <div
              class="sticker-pack-grid"
              use={pickerPageMotion(props.query ? 'search' : (activePack()?.id ?? ''))}
              aria-label={
                props.query ? 'Sticker search results' : activePack()?.title || 'Sticker pack'
              }
            >
              {props.search ? (
                <StickerSearchResults
                  {...props.search}
                  local={results}
                  load={props.load}
                  cachedUrl={props.cachedUrl}
                  send={props.send}
                  enabled={props.enabled}
                  holdPreview={(sticker) => send({ type: 'Held', value: sticker })}
                  preview={(sticker) => send({ type: 'Preview', value: sticker })}
                />
              ) : results!.length ? (
                <StickerGrid
                  stickers={results}
                  load={props.load}
                  cachedUrl={props.cachedUrl}
                  send={props.send}
                  enabled={props.enabled}
                  holdPreview={(sticker) => send({ type: 'Held', value: sticker })}
                  preview={(sticker) => send({ type: 'Preview', value: sticker })}
                />
              ) : (
                <p class="sticker-empty">
                  {activePack()?.id === 'favorites' && !props.query
                    ? 'Add stickers to your favorites from their preview.'
                    : 'No stickers found'}
                </p>
              )}
            </div>
          </>
        ) : (
          <p>Loading sticker index…</p>
        )}
        {model.held ? (
          <Portal>
            <div class="sticker-hold-preview" aria-hidden="true">
              <StickerImage
                sticker={model.held}
                load={() => props.load(model.held!)}
                cachedUrl={() => props.cachedUrl(model.held!)}
                eager
              />
            </div>
          </Portal>
        ) : null}
        {model.managing ? (
          <StickerPackManager
            {...props.packActions}
            packs={props.packs}
            load={props.load}
            cachedUrl={props.cachedUrl}
            close={() => send({ type: 'Manage', value: false })}
          />
        ) : null}
        {model.preview ? (
          <StickerPreview
            sticker={model.preview}
            favorite={
              props.packs
                .find((pack) => pack.id === 'favorites')
                ?.stickers.some((sticker) => sticker.id === model.preview?.id) ?? false
            }
            enabled={props.enabled}
            load={() => props.load(model.preview!)}
            cachedUrl={() => props.cachedUrl(model.preview!)}
            setFavorite={(favorite) => props.setFavorite(model.preview!, favorite)}
            send={() => props.send(model.preview!)}
            close={() => send({ type: 'Preview', value: undefined })}
          />
        ) : null}
      </div>
    );
  }),
);
