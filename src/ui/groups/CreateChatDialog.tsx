import { component, list, view } from 'effectweb';
import { Effect } from 'effect';
import ArrowLeft from '@effectweb/lucide/icons/arrow-left';
import Users from '@effectweb/lucide/icons/users';
import Megaphone from '@effectweb/lucide/icons/megaphone';
import type { ChatCreationApi, CreatedChat } from '../../telegram/chatManagement';
import type { TelegramDialog, TelegramPeer, TelegramPeerSearchResult } from '../../telegram/types';
import type { ChatDirectory } from '../chat/chatDirectory';
import type { MediaAssets } from '../media/mediaAssets';
import { peerRows } from '../collections';
import { Avatar } from '../shared/Avatar';
import { Dialog } from '../shared/Dialog';
import { panelClass } from '../shared/panelStyles';
interface Props {
  api: ChatCreationApi;
  directory: ChatDirectory;
  dialogs: TelegramDialog[];
  media: MediaAssets;
  online: boolean;
  close: () => void;
}
interface State {
  page: 'kind' | 'info' | 'members' | 'created';
  kind: 'group' | 'channel';
  title: string;
  about: string;
  query: string;
  found: TelegramPeerSearchResult[];
  selected: TelegramPeer[];
  busy: boolean;
  searching: boolean;
  error: string;
  created: CreatedChat | undefined;
}
type Message =
  | { type: 'Kind'; kind: State['kind'] }
  | { type: 'Back' }
  | { type: 'Title' | 'About' | 'Query'; value: string }
  | { type: 'Found'; people: TelegramPeerSearchResult[]; error?: string }
  | { type: 'Select'; peer: TelegramPeer }
  | { type: 'Next' }
  | { type: 'Created'; result: CreatedChat }
  | { type: 'Failed'; error: string };
export const CreateChatDialog = component<Props, State, Message>(
  {
    init: () => ({
      page: 'kind',
      kind: 'group',
      title: '',
      about: '',
      query: '',
      found: [],
      selected: [],
      busy: false,
      searching: false,
      error: '',
      created: undefined,
    }),
    update: (model, message) => {
      if (model.busy && message.type !== 'Created' && message.type !== 'Failed') return { model };
      switch (message.type) {
        case 'Kind':
          return { model: { ...model, kind: message.kind, page: 'info', error: '' } };
        case 'Back':
          return {
            model: { ...model, page: model.page === 'members' ? 'info' : 'kind', error: '' },
          };
        case 'Title':
          return { model: { ...model, title: message.value } };
        case 'About':
          return { model: { ...model, about: message.value } };
        case 'Select':
          return {
            model: {
              ...model,
              selected: model.selected.some((peer) => peer.id === message.peer.id)
                ? model.selected.filter((peer) => peer.id !== message.peer.id)
                : [...model.selected, message.peer],
            },
          };
        case 'Query':
          return {
            model: {
              ...model,
              query: message.value,
              found: [],
              searching: Boolean(message.value.trim()),
              error: '',
            },
            commands: [
              {
                key: 'people',
                policy: 'replace',
                effect: (message.value.trim()
                  ? Effect.sleep(250).pipe(
                      Effect.andThen(model.props.directory.search(message.value)),
                    )
                  : Effect.succeed([])
                ).pipe(
                  Effect.match({
                    onSuccess: (people): Message => ({ type: 'Found', people }),
                    onFailure: (): Message => ({
                      type: 'Found',
                      people: [],
                      error: 'Could not search people. Try another search.',
                    }),
                  }),
                ),
              },
            ],
          };
        case 'Found':
          return {
            model: {
              ...model,
              found: message.people,
              searching: false,
              error: message.error ?? '',
            },
          };
        case 'Failed':
          return { model: { ...model, busy: false, error: message.error } };
        case 'Created':
          return {
            model: { ...model, busy: false, created: message.result, page: 'created' },
            commands: message.result.missingUserIds.length
              ? []
              : [
                  {
                    key: 'open',
                    policy: 'drop',
                    effect: Effect.promise(async () => {
                      if (await model.props.directory.select(message.result.peer.id))
                        model.props.close();
                    }).pipe(Effect.as({ type: 'Found', people: [] } as Message)),
                  },
                ],
          };
        case 'Next': {
          if (!model.title.trim() || !model.props.online) return { model };
          if (model.kind === 'group' && model.page === 'info')
            return { model: { ...model, page: 'members' } };
          if (model.kind === 'group' && !model.selected.length) return { model };
          return {
            model: { ...model, busy: true, error: '' },
            commands: [
              {
                key: 'create',
                policy: 'drop',
                effect: model.props.api
                  .createChat({
                    kind: model.kind,
                    title: model.title,
                    about: model.kind === 'channel' ? model.about : undefined,
                    users: model.selected,
                  })
                  .pipe(
                    Effect.match({
                      onSuccess: (result): Message => ({ type: 'Created', result }),
                      onFailure: (error): Message => ({
                        type: 'Failed',
                        error:
                          error instanceof Error ? error.message : 'Could not create the chat.',
                      }),
                    }),
                  ),
              },
            ],
          };
        }
      }
    },
  },
  view((model, send) => {
    const people = [
      ...new Map(
        [...model.props.dialogs, ...model.found]
          .filter((person) => person.peer.kind === 'user')
          .map((person) => [person.peer.id, person]),
      ).values(),
    ].filter(
      (person) =>
        !model.query.trim() ||
        person.title.toLowerCase().includes(model.query.toLowerCase()) ||
        model.found.some((found) => found.peer.id === person.peer.id),
    );
    const close = () => {
      if (!model.busy) model.props.close();
    };
    return (
      <Dialog
        class={`${panelClass} !max-w-[440px]`}
        title={
          model.page === 'kind'
            ? 'New message'
            : model.page === 'members'
              ? 'Add members'
              : model.kind === 'group'
                ? 'New group'
                : 'New channel'
        }
        onClose={close}
        headerLeading={
          model.page !== 'kind' && model.page !== 'created' ? (
            <button
              class="icon-button"
              aria-label="Back"
              disabled={model.busy}
              onClick={() => send({ type: 'Back' })}
            >
              <ArrowLeft size={20} />
            </button>
          ) : undefined
        }
      >
        <div class="create-chat-body scroll-area">
          {model.page === 'kind' ? (
            <div class="create-chat-options">
              <button class="folder-main" onClick={() => send({ type: 'Kind', kind: 'group' })}>
                <Users size={22} />
                <span>New group</span>
              </button>
              <button class="folder-main" onClick={() => send({ type: 'Kind', kind: 'channel' })}>
                <Megaphone size={22} />
                <span>New channel</span>
              </button>
            </div>
          ) : null}
          {model.page === 'info' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                send({ type: 'Next' });
              }}
            >
              <label class="create-chat-field">
                <span>{model.kind === 'group' ? 'Group name' : 'Channel name'}</span>
                <input
                  autofocus
                  value={model.title}
                  maxLength={128}
                  disabled={model.busy}
                  onInput={(event) => send({ type: 'Title', value: event.currentTarget.value })}
                />
              </label>
              {model.kind === 'channel' ? (
                <>
                  <label class="create-chat-field">
                    <span>Description (optional)</span>
                    <textarea
                      value={model.about}
                      maxLength={255}
                      rows={3}
                      disabled={model.busy}
                      onInput={(event) => send({ type: 'About', value: event.currentTarget.value })}
                    />
                  </label>
                  <p class="text-sm text-muted">
                    Your channel starts private. You can manage access and invitation links in its
                    settings.
                  </p>
                </>
              ) : (
                <p class="text-sm text-muted">Choose a name, then add people to your group.</p>
              )}
              <div class="folder-footer">
                <button
                  type="button"
                  class="secondary-button"
                  disabled={model.busy}
                  onClick={close}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="primary-button"
                  disabled={model.busy || !model.props.online || !model.title.trim()}
                >
                  {model.busy ? 'Creating…' : model.kind === 'group' ? 'Next' : 'Create channel'}
                </button>
              </div>
            </form>
          ) : null}
          {model.page === 'members' ? (
            <>
              <label class="create-chat-field">
                <span>Search people</span>
                <input
                  autofocus
                  value={model.query}
                  onInput={(event) => send({ type: 'Query', value: event.currentTarget.value })}
                  disabled={model.busy}
                />
              </label>
              <p class="text-sm text-muted">{model.selected.length} selected</p>
              <div class="create-chat-people">
                {list(peerRows(people), (person) => (
                  <label class="folder-choice">
                    <input
                      type="checkbox"
                      checked={model.selected.some((peer) => peer.id === person.peer.id)}
                      disabled={model.busy}
                      onChange={() => send({ type: 'Select', peer: person.peer })}
                    />
                    <Avatar
                      identity={person.peer.id}
                      initials={person.initials}
                      color={person.color}
                      size="sm"
                      loadCached={() =>
                        model.props.media.loadPeerAvatar(
                          person.peer,
                          person.hasAvatar,
                          person.avatarId,
                          true,
                        )
                      }
                      load={
                        model.props.online
                          ? () =>
                              model.props.media.loadPeerAvatar(
                                person.peer,
                                person.hasAvatar,
                                person.avatarId,
                              )
                          : undefined
                      }
                    />
                    <span>{person.title}</span>
                  </label>
                ))}
                {model.searching ? (
                  <p role="status">Searching…</p>
                ) : !people.length ? (
                  <p class="text-sm text-muted">No people found.</p>
                ) : null}
              </div>
              <div class="folder-footer">
                <button class="secondary-button" disabled={model.busy} onClick={close}>
                  Cancel
                </button>
                <button
                  class="primary-button"
                  disabled={model.busy || !model.props.online || !model.selected.length}
                  onClick={() => send({ type: 'Next' })}
                >
                  {model.busy ? 'Creating…' : 'Create group'}
                </button>
              </div>
            </>
          ) : null}
          {model.page === 'created' && model.created ? (
            <>
              <p>Your {model.kind} has been created.</p>
              {model.created.missingUserIds.length ? (
                <p class="text-sm text-muted">
                  Telegram could not add:{' '}
                  {model.created.missingUserIds
                    .map(
                      (id) =>
                        model.props.dialogs.find((dialog) => dialog.peer.id === id)?.title ??
                        model.found.find((person) => person.peer.id === id)?.title ??
                        id,
                    )
                    .join(', ')}
                  . You can share an invitation link with them.
                </p>
              ) : null}
              <div class="folder-footer">
                <button
                  class="primary-button"
                  onClick={() =>
                    Effect.promise(async () => {
                      if (await model.props.directory.select(model.created!.peer.id))
                        model.props.close();
                    })
                  }
                >
                  Open {model.kind}
                </button>
              </div>
            </>
          ) : null}
          {model.error ? (
            <p role="alert" class="text-sm text-red-400">
              {model.error}
            </p>
          ) : null}
          {!model.props.online ? (
            <p role="status" class="text-sm text-muted">
              Connect to Telegram to create a chat.
            </p>
          ) : null}
        </div>
      </Dialog>
    );
  }),
);
