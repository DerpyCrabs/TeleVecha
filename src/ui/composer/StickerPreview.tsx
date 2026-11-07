import { component, resourceError, view } from 'effectweb';
import { Effect } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import Star from '@effectweb/lucide/icons/star';
import Send from '@effectweb/lucide/icons/send';
import { Dialog } from '../shared/Dialog';
import { panelClass } from '../shared/panelStyles';
import { LazyMedia } from '../media/LazyMedia';
import type { TelegramSticker } from '../../telegram/types';

interface Props {
  sticker: TelegramSticker;
  favorite: boolean;
  enabled: boolean;
  load: () => Effect.Effect<string, unknown>;
  cachedUrl: () => string | undefined;
  setFavorite: (favorite: boolean) => Effect.Effect<void, unknown>;
  send: () => void;
  close: () => void;
}
export const StickerPreview = component(
  {
    init: (_props: Props) => ({
      saving: AsyncResult.initial() as AsyncResult.AsyncResult<void, unknown>,
    }),
    identity: (props) => props.sticker.id,
  },
  (owner) =>
    view((model) => (
      <Dialog
        title={model.props.sticker.emoji ? `${model.props.sticker.emoji} Sticker` : 'Sticker'}
        label="Sticker preview"
        closeLabel="Close sticker preview"
        onClose={model.props.close}
        class={`${panelClass} sticker-preview-dialog`}
      >
        <div class="sticker-preview-image">
          <LazyMedia
            identity={model.props.sticker.id}
            mimeType={model.props.sticker.mimeType}
            placeholder={model.props.sticker.emoji}
            label="Sticker preview"
            eager
            load={model.props.load}
            cachedUrl={model.props.cachedUrl}
          />
        </div>
        {resourceError(model.saving) ? (
          <p class="sticker-preview-error" role="alert">
            Could not update favorites. Try again.
          </p>
        ) : null}
        <div class="sticker-preview-actions">
          <button
            type="button"
            disabled={model.saving.waiting}
            aria-pressed={model.props.favorite}
            onClick={() =>
              owner.task('saving', model.props.setFavorite(!model.props.favorite), 'drop')
            }
          >
            <Star size={18} fill={model.props.favorite ? 'currentColor' : 'none'} />
            {model.saving.waiting
              ? 'Saving…'
              : model.props.favorite
                ? 'Remove from favorites'
                : 'Add to favorites'}
          </button>
          <button
            type="button"
            class="primary"
            disabled={!model.props.enabled}
            onClick={model.props.send}
          >
            <Send size={18} /> Send sticker
          </button>
        </div>
      </Dialog>
    )),
);
