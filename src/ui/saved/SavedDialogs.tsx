import { Effect } from 'effect';
import { component, list, view } from 'effectweb';
import ArrowLeft from '@effectweb/lucide/icons/arrow-left';
import Bookmark from '@effectweb/lucide/icons/bookmark';
import Pin from '@effectweb/lucide/icons/pin';
import type { EffectMessagingClient } from '../../telegram/core/client';
import type {
  SavedDialog,
  SavedDialogsPage,
  SavedDialogsOffset,
} from '../../telegram/savedMessages';
import type { MediaAssets } from '../media/mediaAssets';
import { peerRows } from '../collections';
import { Avatar } from '../shared/Avatar';
import { savedSubscription } from './savedSubscription';
interface Props {
  api: EffectMessagingClient;
  selfId: string;
  online: boolean;
  media: MediaAssets;
  selected?: string | undefined;
  select: (source: SavedDialog | undefined) => void;
  back: () => void;
}
interface State {
  dialogs: SavedDialog[];
  next: SavedDialogsOffset | undefined;
  query: string;
  loading: boolean;
  pinning: string | undefined;
  error: string;
}
type Message =
  | { type: 'Load'; more?: boolean }
  | { type: 'Loaded'; page: SavedDialogsPage; more: boolean }
  | { type: 'Query'; value: string }
  | { type: 'Pin'; source: SavedDialog }
  | { type: 'Pinned' }
  | { type: 'Failed'; error: string };
export const SavedDialogs = component<Props, State, Message>(
  {
    identity: (props) => props.selfId,
    init: () => ({
      dialogs: [],
      next: undefined,
      query: '',
      loading: false,
      pinning: undefined,
      error: '',
    }),
    update: (model, message) => {
      switch (message.type) {
        case 'Query':
          return { model: { ...model, query: message.value } };
        case 'Load': {
          const more = Boolean(message.more);
          if (!model.props.online || (more && (model.loading || !model.next))) return { model };
          return {
            model: { ...model, loading: true, error: '' },
            commands: [
              {
                key: ['saved-dialogs', model.props.selfId],
                policy: 'replace',
                effect: model.props.api
                  .getSavedDialogs(more ? model.next : undefined)
                  .pipe(
                    Effect.match({
                      onSuccess: (page): Message => ({ type: 'Loaded', page, more }),
                      onFailure: (error): Message => ({ type: 'Failed', error: error.message }),
                    }),
                  ),
              },
            ],
          };
        }
        case 'Loaded':
          return {
            model: {
              ...model,
              loading: false,
              next: message.page.nextOffset,
              dialogs: message.more
                ? [
                    ...new Map(
                      [...model.dialogs, ...message.page.dialogs].map((dialog) => [
                        dialog.peer.id,
                        dialog,
                      ]),
                    ).values(),
                  ]
                : message.page.dialogs,
            },
          };
        case 'Pin':
          if (model.pinning || !model.props.online) return { model };
          return {
            model: { ...model, pinning: message.source.peer.id, error: '' },
            commands: [
              {
                key: ['saved-pin', model.props.selfId],
                policy: 'drop',
                effect: model.props.api
                  .pinSavedDialog(message.source.peer, !message.source.pinned)
                  .pipe(
                    Effect.match({
                      onSuccess: (): Message => ({ type: 'Pinned' }),
                      onFailure: (error): Message => ({ type: 'Failed', error: error.message }),
                    }),
                  ),
              },
            ],
          };
        case 'Pinned':
          return { model: { ...model, pinning: undefined } };
        case 'Failed':
          return { model: { ...model, loading: false, pinning: undefined, error: message.error } };
      }
    },
  },
  view((model, send) => (
    <aside class="forum-sidebar saved-dialogs-panel" aria-label="Saved chats">
      <span
        hidden
        use={savedSubscription({
          api: model.props.api,
          peerId: model.props.selfId,
          online: model.props.online,
          reload: () => send({ type: 'Load' }),
        })}
      />
      <header>
        <button
          class="icon-button"
          aria-label="Back to chats"
          title="Back to chats"
          onClick={model.props.back}
        >
          <ArrowLeft size={20} />
        </button>
        <strong>Saved Messages</strong>
      </header>
      <label class="saved-dialogs-search">
        <span class="sr-only">Search saved chats</span>
        <input
          placeholder="Search chats"
          value={model.query}
          onInput={(event) => send({ type: 'Query', value: event.currentTarget.value })}
        />
      </label>
      <div class="saved-dialogs-list scroll-area">
        <button
          class="saved-dialog-main"
          classList={{ 'saved-dialog-selected': !model.props.selected }}
          onClick={() => model.props.select(undefined)}
        >
          <span class="saved-dialog-bookmark">
            <Bookmark size={23} />
          </span>
          <span>
            <strong>All messages</strong>
            <small>Everything you saved</small>
          </span>
        </button>
        {list(
          peerRows(
            model.dialogs.filter((dialog) =>
              dialog.title.toLocaleLowerCase().includes(model.query.toLocaleLowerCase()),
            ),
          ),
          (dialog) => (
            <div
              class="saved-dialog-row"
              classList={{ 'saved-dialog-selected': model.props.selected === dialog.peer.id }}
            >
              <button class="saved-dialog-main" onClick={() => model.props.select(dialog)}>
                <Avatar
                  identity={dialog.peer.id}
                  initials={dialog.initials}
                  color={dialog.color}
                  size="md"
                  load={
                    model.props.online
                      ? () =>
                          model.props.media.loadPeerAvatar(
                            dialog.peer,
                            dialog.hasAvatar,
                            dialog.avatarId,
                          )
                      : undefined
                  }
                />
                <span>
                  <strong>{dialog.title}</strong>
                  <small>
                    {dialog.topMessage?.text ||
                      (dialog.topMessage?.media ? 'Media' : 'Saved messages')}
                  </small>
                </span>
              </button>
              <button
                class="icon-button saved-dialog-pin"
                title={`${dialog.pinned ? 'Unpin' : 'Pin'} ${dialog.title}`}
                aria-label={`${dialog.pinned ? 'Unpin' : 'Pin'} ${dialog.title}`}
                aria-pressed={dialog.pinned}
                disabled={!model.props.online || Boolean(model.pinning)}
                onClick={() => send({ type: 'Pin', source: dialog })}
              >
                <Pin size={15} />
              </button>
            </div>
          ),
        )}
        {model.loading ? (
          <p role="status" class="management-help">
            Loading saved chats…
          </p>
        ) : !model.dialogs.length ? (
          <p class="management-help">
            Forward messages here to organize them by their original chats.
          </p>
        ) : null}
        {model.error ? (
          <p role="alert" class="text-sm text-red-400">
            {model.error}
          </p>
        ) : null}
        {model.next ? (
          <button
            class="secondary-button"
            disabled={model.loading || !model.props.online}
            onClick={() => send({ type: 'Load', more: true })}
          >
            More saved chats
          </button>
        ) : null}
        {!model.props.online ? (
          <p class="management-help">Connect to Telegram to load saved chats.</p>
        ) : null}
      </div>
    </aside>
  )),
);
