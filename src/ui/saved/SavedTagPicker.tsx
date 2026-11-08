import { CustomReaction } from '../conversation/MessageActions';
import type { QuerySources } from '../app/queries';
import { Effect } from 'effect';
import { component, list, view } from 'effectweb';
import type { EffectMessagingClient } from '../../telegram/core/client';
import type { SavedTags } from '../../telegram/savedMessages';
import { Dialog } from '../shared/Dialog';
import { savedSubscription } from './savedSubscription';
import { emojiEntries } from '../composer/emojiData';
import './savedTags.css';
interface Props {
  api: EffectMessagingClient;
  customEmoji: QuerySources['customEmoji'];
  selfId: string;
  messageId: number;
  selected: readonly string[];
  premium: boolean;
  online: boolean;
  close: () => void;
}
interface State {
  tags: SavedTags;
  selected: string[];
  loading: boolean;
  busy: boolean;
  error: string;
  more: boolean;
  query: string;
}
type Message =
  | { type: 'Load' }
  | { type: 'Loaded'; tags: SavedTags }
  | { type: 'Toggle'; key: string }
  | { type: 'More' }
  | { type: 'Query'; value: string }
  | { type: 'Save' }
  | { type: 'Saved' }
  | { type: 'Failed'; error: string };
export const SavedTagPicker = component<Props, State, Message>(
  {
    identity: (props) => `${props.selfId}/${props.messageId}`,
    init: (props) => ({
      tags: { tags: [], recommended: [] },
      selected: [...props.selected],
      loading: true,
      busy: false,
      error: '',
      more: false,
      query: '',
    }),
    update: (model, message) => {
      switch (message.type) {
        case 'Load':
          return {
            model,
            commands: [
              {
                key: ['tags', model.props.selfId],
                policy: 'replace',
                effect: model.props.api
                  .getSavedTags()
                  .pipe(
                    Effect.match({
                      onSuccess: (tags): Message => ({ type: 'Loaded', tags }),
                      onFailure: (error): Message => ({ type: 'Failed', error: error.message }),
                    }),
                  ),
              },
            ],
          };
        case 'Loaded':
          return { model: { ...model, tags: message.tags, loading: false } };
        case 'Toggle':
          return model.busy || !model.props.premium
            ? { model }
            : {
                model: {
                  ...model,
                  selected: model.selected.includes(message.key)
                    ? model.selected.filter((key) => key !== message.key)
                    : [...model.selected, message.key],
                },
              };
        case 'More':
          return { model: { ...model, more: !model.more } };
        case 'Query':
          return { model: { ...model, query: message.value } };
        case 'Save':
          if (model.busy || model.loading || !model.props.online || !model.props.premium)
            return { model };
          return {
            model: { ...model, busy: true, error: '' },
            commands: [
              {
                key: ['save-tags', model.props.messageId],
                policy: 'drop',
                effect: model.props.api
                  .setSavedMessageTags(model.props.messageId, model.selected)
                  .pipe(
                    Effect.match({
                      onSuccess: (): Message => ({ type: 'Saved' }),
                      onFailure: (error): Message => ({ type: 'Failed', error: error.message }),
                    }),
                  ),
              },
            ],
          };
        case 'Saved':
          return {
            model: { ...model, busy: false },
            commands: [{ key: 'close', policy: 'replace', effect: Effect.sync(model.props.close) }],
          };
        case 'Failed':
          return { model: { ...model, busy: false, loading: false, error: message.error } };
      }
    },
  },
  view((model, send) => {
    const choices = [
      ...new Set([
        ...model.tags.tags.map((tag) => tag.reaction),
        ...model.tags.recommended,
        ...model.selected,
      ]),
    ];
    return (
      <Dialog
        title="Message tags"
        onClose={() => {
          if (!model.busy) model.props.close();
        }}
        class="saved-tag-dialog"
      >
        <span
          hidden
          use={savedSubscription({
            api: model.props.api,
            peerId: model.props.selfId,
            online: model.props.online,
            reload: () => send({ type: 'Load' }),
          })}
        />
        <div class="saved-tag-picker-body">
          <p class="management-help">
            {model.props.premium
              ? 'Choose tags to find this message later.'
              : 'Adding and editing tags in Saved Messages requires Telegram Premium.'}
          </p>
          {model.loading ? <p role="status">Loading tags…</p> : null}
          <div class="saved-tag-choices" role="group" aria-label="Message tags">
            {list(
              choices,
              (key) => key,
              (key) => (
                <button
                  class="saved-tag-chip"
                  aria-pressed={model.selected.includes(key)}
                  disabled={model.busy || !model.props.premium || !model.props.online}
                  onClick={() => send({ type: 'Toggle', key })}
                >
                  <span class="saved-tag-emoji">
                    {key.startsWith('custom:') ? (
                      <CustomReaction asset={model.props.customEmoji(key.slice(7))} />
                    ) : (
                      key
                    )}
                  </span>
                  {model.tags.tags.find((tag) => tag.reaction === key)?.title}
                </button>
              ),
            )}
          </div>
          {model.props.premium ? (
            <button
              class="saved-more-emoji"
              onClick={() => send({ type: 'More' })}
              aria-expanded={model.more}
            >
              More emoji
            </button>
          ) : null}
          {model.more ? (
            <>
              <input
                class="saved-emoji-search"
                type="search"
                placeholder="Search emoji"
                aria-label="Search tag emoji"
                value={model.query}
                onInput={(event) => send({ type: 'Query', value: event.currentTarget.value })}
              />
              <div class="saved-tag-emoji-grid" role="group" aria-label="Tag emoji">
                {list(
                  emojiEntries.filter((entry) =>
                    `${entry.value} ${entry.keywords}`.includes(model.query.toLowerCase()),
                  ),
                  (entry) => entry.value,
                  (entry) => (
                    <button
                      aria-label={`Tag ${entry.value}`}
                      aria-pressed={model.selected.includes(entry.value)}
                      disabled={model.busy || !model.props.online}
                      onClick={() => send({ type: 'Toggle', key: entry.value })}
                    >
                      {entry.value}
                    </button>
                  ),
                )}
              </div>
            </>
          ) : null}
          {model.error ? (
            <p role="alert" class="text-sm text-red-400">
              {model.error}
            </p>
          ) : null}
        </div>
        <footer class="saved-tag-picker-footer">
          <button class="secondary-button" disabled={model.busy} onClick={model.props.close}>
            Cancel
          </button>
          {model.props.premium ? (
            <button
              class="primary-button"
              disabled={model.busy || model.loading || !model.props.online}
              onClick={() => send({ type: 'Save' })}
            >
              {model.busy ? 'Saving…' : 'Save'}
            </button>
          ) : null}
        </footer>
      </Dialog>
    );
  }),
);
