import { CustomReaction } from '../conversation/MessageActions';
import type { QuerySources } from '../app/queries';
import { Effect } from 'effect';
import { component, list, view } from 'effectweb';
import Pencil from '@effectweb/lucide/icons/pencil';
import type { EffectMessagingClient } from '../../telegram/core/client';
import type { TelegramPeer } from '../../telegram/types';
import type { SavedTags, SavedReactionTag } from '../../telegram/savedMessages';
import { Dialog } from '../shared/Dialog';
import { savedSubscription } from './savedSubscription';
import './savedTags.css';
interface Props {
  api: EffectMessagingClient;
  customEmoji: QuerySources['customEmoji'];
  selfId: string;
  source?: TelegramPeer | undefined;
  premium: boolean;
  online: boolean;
  selected: readonly string[];
  change: (selected: string[]) => void;
}
interface State {
  tags: SavedReactionTag[];
  loading: boolean;
  editing: SavedReactionTag | undefined;
  title: string;
  busy: boolean;
  error: string;
}
type Message =
  | { type: 'Load' }
  | { type: 'Loaded'; result: SavedTags }
  | { type: 'Edit'; tag: SavedReactionTag | undefined }
  | { type: 'Title'; value: string }
  | { type: 'Save' }
  | { type: 'Saved' }
  | { type: 'Failed'; error: string };
export const SavedTagFilters = component<Props, State, Message>(
  {
    identity: (props) => `${props.selfId}/${props.source?.id ?? 'all'}`,
    init: () => ({
      tags: [],
      loading: false,
      editing: undefined,
      title: '',
      busy: false,
      error: '',
    }),
    update: (model, message) => {
      switch (message.type) {
        case 'Load':
          if (!model.props.online) return { model };
          return {
            model: { ...model, loading: true },
            commands: [
              {
                key: ['saved-tags', model.props.source?.id ?? 'all'],
                policy: 'replace',
                effect: model.props.api
                  .getSavedTags(model.props.source)
                  .pipe(
                    Effect.match({
                      onSuccess: (result): Message => ({ type: 'Loaded', result }),
                      onFailure: (error): Message => ({ type: 'Failed', error: error.message }),
                    }),
                  ),
              },
            ],
          };
        case 'Loaded':
          return { model: { ...model, loading: false, tags: message.result.tags } };
        case 'Edit':
          if (model.busy) return { model };
          return {
            model: { ...model, editing: message.tag, title: message.tag?.title ?? '', error: '' },
          };
        case 'Title':
          return { model: { ...model, title: message.value } };
        case 'Save': {
          if (!model.editing || model.busy || !model.props.online || !model.props.premium)
            return { model };
          if (Array.from(model.title.trim()).length > 12)
            return { model: { ...model, error: 'Use up to 12 characters.' } };
          return {
            model: { ...model, busy: true, error: '' },
            commands: [
              {
                key: ['rename-tag', model.editing.reaction],
                policy: 'drop',
                effect: model.props.api
                  .renameSavedTag(model.editing.reaction, model.title.trim())
                  .pipe(
                    Effect.match({
                      onSuccess: (): Message => ({ type: 'Saved' }),
                      onFailure: (error): Message => ({ type: 'Failed', error: error.message }),
                    }),
                  ),
              },
            ],
          };
        }
        case 'Saved':
          return { model: { ...model, busy: false, editing: undefined } };
        case 'Failed':
          return { model: { ...model, busy: false, loading: false, error: message.error } };
      }
    },
  },
  view((model, send) => (
    <div class="saved-tag-filters">
      <span
        hidden
        use={savedSubscription({
          api: model.props.api,
          peerId: model.props.selfId,
          online: model.props.online,
          reload: () => send({ type: 'Load' }),
        })}
      />
      <div class="saved-tag-strip" role="group" aria-label="Filter by saved tags">
        {list(
          model.tags,
          (tag) => tag.reaction,
          (tag) => (
            <span class="saved-tag-control">
              <button
                class="saved-tag-chip"
                aria-pressed={model.props.selected.includes(tag.reaction)}
                title={`Filter by ${tag.title || tag.reaction}`}
                onClick={() =>
                  model.props.change(
                    model.props.selected.includes(tag.reaction)
                      ? model.props.selected.filter((key) => key !== tag.reaction)
                      : [...model.props.selected, tag.reaction],
                  )
                }
              >
                <span class="saved-tag-emoji">
                  {tag.reaction.startsWith('custom:') ? (
                    <CustomReaction asset={model.props.customEmoji(tag.reaction.slice(7))} />
                  ) : (
                    tag.reaction
                  )}
                </span>
                {tag.title ? <span>{tag.title}</span> : null}
                <small>{tag.count}</small>
              </button>
              {model.props.premium ? (
                <button
                  class="saved-tag-rename"
                  title={`Rename ${tag.title || tag.reaction} tag`}
                  aria-label={`Rename ${tag.title || tag.reaction} tag`}
                  disabled={!model.props.online}
                  onClick={() => send({ type: 'Edit', tag })}
                >
                  <Pencil size={12} />
                </button>
              ) : null}
            </span>
          ),
        )}
      </div>
      {model.error && !model.editing ? (
        <p role="alert" class="management-help">
          {model.error}
        </p>
      ) : null}
      {model.editing ? (
        <Dialog
          class="saved-tag-dialog"
          title="Tag name"
          onClose={() => send({ type: 'Edit', tag: undefined })}
        >
          <form
            class="saved-tag-name"
            onSubmit={(event) => {
              event.preventDefault();
              send({ type: 'Save' });
            }}
          >
            <label>
              Name
              <input
                autofocus
                aria-label="Tag name"
                value={model.title}
                disabled={model.busy}
                onInput={(event) => send({ type: 'Title', value: event.currentTarget.value })}
              />
            </label>
            <p class="management-help">Up to 12 characters. Leave empty to show only the emoji.</p>
            {model.error ? <p role="alert">{model.error}</p> : null}
            <footer>
              <button
                type="button"
                class="secondary-button"
                disabled={model.busy}
                onClick={() => send({ type: 'Edit', tag: undefined })}
              >
                Cancel
              </button>
              <button
                type="submit"
                class="primary-button"
                disabled={model.busy || !model.props.online}
              >
                {model.busy ? 'Saving…' : 'Save'}
              </button>
            </footer>
          </form>
        </Dialog>
      ) : null}
    </div>
  )),
);
