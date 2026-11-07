import { parseStickerPackLink } from '../shared/telegramLink';
import { available, component, domBinding, list, resourceError, view } from 'effectweb';
import { Effect } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import ArrowLeft from '@effectweb/lucide/icons/arrow-left';
import { Dialog } from '../shared/Dialog';
import { panelClass } from '../shared/panelStyles';
import { LazyMedia } from '../media/LazyMedia';
import { idRows } from '../collections';
import type { TelegramSticker, TelegramStickerPack } from '../../telegram/types';

export interface StickerPackActions {
  getStickerPack: (shortName: string) => Effect.Effect<TelegramStickerPack, unknown>;
  searchStickerPacks: (query: string) => Effect.Effect<TelegramStickerPack[], unknown>;
  setStickerPackInstalled: (
    pack: TelegramStickerPack,
    installed: boolean,
  ) => Effect.Effect<void, unknown>;
}
interface Props extends StickerPackActions {
  initialShortName?: string;
  packs: TelegramStickerPack[];
  load: (sticker: TelegramSticker) => Effect.Effect<string, unknown>;
  cachedUrl: (sticker: TelegramSticker) => string | undefined;
  close: () => void;
}
function beginPackLoad(
  _element: HTMLElement,
  input: () => { name: string | undefined; load: () => void },
) {
  let loaded: string | undefined;
  const update = () => {
    const value = input();
    if (value.name && value.name !== loaded) {
      loaded = value.name;
      value.load();
    }
  };
  update();
  return { update, dispose() {} };
}
export const StickerPackManager = component(
  {
    identity: (props) => props.initialShortName ?? '',
    init: (_props: Props) => ({
      query: '',
      selected: AsyncResult.initial() as AsyncResult.AsyncResult<TelegramStickerPack, unknown>,
      results: AsyncResult.initial() as AsyncResult.AsyncResult<TelegramStickerPack[], unknown>,
      saving: AsyncResult.initial() as AsyncResult.AsyncResult<void, unknown>,
    }),
  },
  (owner) =>
    view((model) => {
      const props = model.props;
      const selected = available(model.selected);
      const installed = props.packs.filter(
        (pack) => pack.id !== 'recent' && pack.id !== 'favorites',
      );
      const results = model.query.trim() ? (available(model.results) ?? []) : installed;
      const error =
        resourceError(model.selected) ||
        resourceError(model.results) ||
        resourceError(model.saving);
      const image = (sticker: TelegramSticker, eager = false) => (
        <LazyMedia
          identity={sticker.id}
          mimeType={sticker.mimeType}
          placeholder={sticker.emoji}
          label={sticker.emoji}
          load={() => props.load(sticker)}
          cachedUrl={() => props.cachedUrl(sticker)}
          eager={eager}
        />
      );
      const search = (query: string) => {
        owner.cancel('selected');
        owner.patch({ query, results: AsyncResult.initial(), selected: AsyncResult.initial() });
        const name =
          parseStickerPackLink(query.trim()) ?? parseStickerPackLink(`https://${query.trim()}`);
        owner.task(
          'results',
          Effect.sleep(250).pipe(
            Effect.andThen(() =>
              name
                ? props.getStickerPack(name).pipe(Effect.map((pack) => [pack]))
                : query.trim()
                  ? props.searchStickerPacks(query.trim())
                  : Effect.succeed([]),
            ),
          ),
          'replace',
        );
      };
      return (
        <Dialog
          title={selected?.title ?? 'Sticker packs'}
          label="Manage sticker packs"
          closeLabel="Close sticker packs"
          onClose={props.close}
          class={`${panelClass} sticker-pack-manager`}
        >
          <span
            hidden
            use={domBinding(
              {
                name: props.initialShortName,
                load: () => {
                  if (props.initialShortName)
                    owner.task('selected', props.getStickerPack(props.initialShortName), 'replace');
                },
              },
              beginPackLoad,
            )}
          />
          {selected ? (
            <>
              <button
                disabled={model.saving.waiting}
                class="sticker-pack-back"
                type="button"
                onClick={() =>
                  owner.patch({ selected: AsyncResult.initial(), saving: AsyncResult.initial() })
                }
              >
                <ArrowLeft size={17} /> All packs
              </button>
              <div class="sticker-set-grid">
                {list(idRows(selected.stickers), (sticker) => (
                  <div class="sticker-set-item">{image(sticker)}</div>
                ))}
              </div>
              <div class="sticker-pack-footer">
                <span>{selected.count ?? selected.stickers.length} stickers</span>
                <button
                  disabled={model.saving.waiting}
                  onClick={() => {
                    const next = !selected.installed;
                    owner.task(
                      'saving',
                      props
                        .setStickerPackInstalled(selected, next)
                        .pipe(
                          Effect.tap(() =>
                            Effect.sync(() =>
                              owner.patch({
                                selected: AsyncResult.success({ ...selected, installed: next }),
                              }),
                            ),
                          ),
                        ),
                      'drop',
                    );
                  }}
                >
                  {model.saving.waiting
                    ? 'Saving…'
                    : selected.installed
                      ? 'Remove pack'
                      : 'Add pack'}
                </button>
              </div>
            </>
          ) : (
            <>
              <label class="sticker-pack-search">
                <input
                  type="search"
                  value={model.query}
                  aria-label="Search sticker packs"
                  placeholder="Search packs or paste a pack link"
                  onInput={(event) => search(event.currentTarget.value)}
                />
              </label>
              <div class="sticker-pack-list">
                {model.results.waiting || model.selected.waiting ? (
                  <p role="status">Loading sticker packs…</p>
                ) : null}
                {list(idRows(results), (pack) => (
                  <button
                    class="sticker-pack-row"
                    disabled={model.selected.waiting}
                    onClick={() => {
                      owner.patch({ saving: AsyncResult.initial() });
                      if (pack.shortName)
                        owner.task('selected', props.getStickerPack(pack.shortName), 'replace');
                      else owner.patch({ selected: AsyncResult.success(pack) });
                    }}
                  >
                    <span class="sticker-pack-icon">
                      {pack.stickers[0] ? image(pack.stickers[0], true) : '🎨'}
                    </span>
                    <span>
                      <strong>{pack.title}</strong>
                      <small>
                        {pack.count ?? pack.stickers.length} stickers
                        {installed.some((value) => value.id === pack.id) ? ' · Added' : ''}
                      </small>
                    </span>
                  </button>
                ))}
                {!results.length && !model.results.waiting ? (
                  <p>
                    {model.query.trim()
                      ? 'No sticker packs found'
                      : 'Search to add your first sticker pack'}
                  </p>
                ) : null}
              </div>
            </>
          )}
          {error ? (
            <p class="sticker-preview-error" role="alert">
              {error}
            </p>
          ) : null}
        </Dialog>
      );
    }),
);
