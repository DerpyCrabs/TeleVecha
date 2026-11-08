import { Effect } from 'effect';
import { component, list, view } from 'effectweb';
import type { EffectMessagingClient } from '../../telegram/core/client';
import type { JoinRequestsPage } from '../../telegram/chatManagement';
import type { TelegramDialog, TelegramPeer } from '../../telegram/types';
import type { MediaAssets } from '../media/mediaAssets';
import { peerRows } from '../collections';
import { Avatar } from '../shared/Avatar';
import { Dialog } from '../shared/Dialog';
import { panelClass } from '../shared/panelStyles';
import { groupResourceSubscription } from './groupResourceSubscription';
interface Props {
  api: EffectMessagingClient;
  dialog: TelegramDialog;
  online: boolean;
  media: MediaAssets;
  close: () => void;
}
interface State {
  query: string;
  page: JoinRequestsPage | undefined;
  loading: boolean;
  pending: string[];
  error: string;
  confirm: boolean | undefined;
}
type Message =
  | { type: 'Load'; more?: boolean }
  | { type: 'Query'; value: string }
  | { type: 'Loaded'; page: JoinRequestsPage; more: boolean }
  | { type: 'Failed'; error: string; user?: string }
  | { type: 'Resolve'; user: TelegramPeer; approved: boolean }
  | { type: 'Resolved'; user: string }
  | { type: 'Confirm'; approved: boolean | undefined }
  | { type: 'ResolveAll' };
export const JoinRequestsDialog = component<Props, State, Message>(
  {
    identity: (props) => props.dialog.peer.id,
    init: () => ({
      query: '',
      page: undefined,
      loading: false,
      pending: [],
      error: '',
      confirm: undefined,
    }),
    update: (model, message) => {
      const peer = model.props.dialog.peer;
      switch (message.type) {
        case 'Load':
        case 'Query': {
          const query = message.type === 'Query' ? message.value : model.query;
          const more = message.type === 'Load' && Boolean(message.more);
          const offset = more ? model.page?.nextOffset : undefined;
          if (!model.props.online || (more && !offset)) return { model };
          return {
            model: {
              ...model,
              query,
              loading: true,
              error: '',
              page: message.type === 'Query' ? undefined : model.page,
            },
            commands: [
              {
                key: ['requests', peer.id],
                policy: 'replace',
                effect: Effect.sleep(message.type === 'Query' ? 200 : 0).pipe(
                  Effect.andThen(model.props.api.getJoinRequests(peer, query, offset)),
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
              page: {
                ...message.page,
                people: message.more
                  ? [
                      ...new Map(
                        [...(model.page?.people ?? []), ...message.page.people].map((person) => [
                          person.peer.id,
                          person,
                        ]),
                      ).values(),
                    ]
                  : message.page.people,
              },
            },
          };
        case 'Failed':
          return {
            model: {
              ...model,
              loading: false,
              pending: message.user
                ? model.pending.filter((id) => id !== message.user)
                : model.pending,
              error: message.error,
            },
          };
        case 'Resolve': {
          if (model.pending.includes(message.user.id) || !model.props.online) return { model };
          return {
            model: { ...model, pending: [...model.pending, message.user.id], error: '' },
            commands: [
              {
                key: ['resolve', peer.id, message.user.id],
                policy: 'drop',
                effect: model.props.api
                  .resolveJoinRequest(peer, message.user, message.approved)
                  .pipe(
                    Effect.match({
                      onSuccess: (): Message => ({ type: 'Resolved', user: message.user.id }),
                      onFailure: (error): Message => ({
                        type: 'Failed',
                        user: message.user.id,
                        error: error.message,
                      }),
                    }),
                  ),
              },
            ],
          };
        }
        case 'Resolved':
          return {
            model: {
              ...model,
              confirm: undefined,
              pending: model.pending.filter((id) => id !== message.user),
              page: model.page
                ? {
                    ...model.page,
                    people: model.page.people.filter((person) => person.peer.id !== message.user),
                  }
                : undefined,
            },
            commands: [
              {
                key: ['reload', peer.id],
                policy: 'replace',
                effect: Effect.succeed({ type: 'Load' } as Message),
              },
            ],
          };
        case 'Confirm':
          return { model: { ...model, confirm: message.approved } };
        case 'ResolveAll': {
          if (model.confirm === undefined || model.pending.length || !model.props.online)
            return { model };
          return {
            model: { ...model, pending: ['all'], error: '' },
            commands: [
              {
                key: ['resolve-all', peer.id],
                policy: 'drop',
                effect: model.props.api
                  .resolveAllJoinRequests(peer, model.confirm)
                  .pipe(
                    Effect.match({
                      onSuccess: (): Message => ({ type: 'Resolved', user: 'all' }),
                      onFailure: (error): Message => ({
                        type: 'Failed',
                        user: 'all',
                        error: error.message,
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
    const props = model.props;
    const busy = model.pending.length > 0;
    return (
      <Dialog
        title={
          model.confirm === undefined
            ? 'Join requests'
            : model.confirm
              ? 'Approve all requests?'
              : 'Dismiss all requests?'
        }
        class={`${panelClass} !max-w-[480px]`}
        onClose={() => {
          if (!busy) props.close();
        }}
      >
        <span
          hidden
          use={groupResourceSubscription({
            api: props.api,
            peerId: props.dialog.peer.id,
            kind: 'join-requests',
            online: props.online,
            reload: () => send({ type: 'Load' }),
          })}
        />
        <div class="join-requests-body scroll-area">
          {model.confirm !== undefined ? (
            <>
              <p>
                {model.confirm
                  ? 'All people with pending requests will be added to'
                  : 'All pending requests will be dismissed for'}{' '}
                <strong>{props.dialog.title}</strong>.
              </p>
              <div class="folder-footer">
                <button
                  class="secondary-button"
                  disabled={busy}
                  onClick={() => send({ type: 'Confirm', approved: undefined })}
                >
                  Cancel
                </button>
                <button
                  class={model.confirm ? 'primary-button' : 'secondary-button text-red-400'}
                  disabled={busy || !props.online}
                  onClick={() => send({ type: 'ResolveAll' })}
                >
                  {busy ? 'Please wait…' : model.confirm ? 'Approve all' : 'Dismiss all'}
                </button>
              </div>
            </>
          ) : (
            <>
              <label class="create-chat-field">
                <span>Search requests</span>
                <input
                  value={model.query}
                  onInput={(event) => send({ type: 'Query', value: event.currentTarget.value })}
                />
              </label>
              {model.page ? (
                <p class="text-sm text-muted">
                  {model.page.count} pending {model.page.count === 1 ? 'request' : 'requests'}
                </p>
              ) : null}
              {list(peerRows(model.page?.people ?? []), (person) => (
                <article class="join-request-row" aria-label={person.title}>
                  <Avatar
                    identity={person.peer.id}
                    initials={person.initials}
                    color={person.color}
                    size="md"
                    loadCached={() =>
                      props.media.loadPeerAvatar(
                        person.peer,
                        person.hasAvatar,
                        person.avatarId,
                        true,
                      )
                    }
                    load={
                      props.online
                        ? () =>
                            props.media.loadPeerAvatar(
                              person.peer,
                              person.hasAvatar,
                              person.avatarId,
                            )
                        : undefined
                    }
                  />
                  <div class="min-w-0">
                    <strong>{person.title}</strong>
                    <p
                      class="text-xs text-muted"
                      title={new Date(person.date * 1000).toLocaleString()}
                    >
                      {new Date(person.date * 1000).toLocaleDateString()}
                    </p>
                    {person.about ? <p class="join-request-about">{person.about}</p> : null}
                    <div class="join-request-actions">
                      <button
                        class="primary-button"
                        disabled={
                          !props.online ||
                          model.pending.includes(person.peer.id) ||
                          model.pending.includes('all')
                        }
                        onClick={() => send({ type: 'Resolve', user: person.peer, approved: true })}
                      >
                        Approve
                      </button>
                      <button
                        class="secondary-button"
                        disabled={
                          !props.online ||
                          model.pending.includes(person.peer.id) ||
                          model.pending.includes('all')
                        }
                        onClick={() =>
                          send({ type: 'Resolve', user: person.peer, approved: false })
                        }
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </article>
              ))}
              {model.loading ? (
                <p role="status" class="text-sm text-muted">
                  Loading requests…
                </p>
              ) : model.page && !model.page.people.length ? (
                <p class="join-requests-empty">
                  {model.query ? 'No matching requests' : 'No pending requests'}
                </p>
              ) : null}
              {model.page?.nextOffset ? (
                <button
                  class="secondary-button"
                  disabled={model.loading || !props.online}
                  onClick={() => send({ type: 'Load', more: true })}
                >
                  Load more
                </button>
              ) : null}
              {model.page && model.page.count > 1 && !model.query ? (
                <div class="folder-footer">
                  <button
                    class="secondary-button text-red-400"
                    disabled={busy || !props.online}
                    onClick={() => send({ type: 'Confirm', approved: false })}
                  >
                    Dismiss all
                  </button>
                  <button
                    class="secondary-button"
                    disabled={busy || !props.online}
                    onClick={() => send({ type: 'Confirm', approved: true })}
                  >
                    Approve all
                  </button>
                </div>
              ) : null}
            </>
          )}
          {model.error ? (
            <p role="alert" class="text-sm text-red-400">
              {model.error}
            </p>
          ) : null}
          {!props.online ? (
            <p role="status" class="text-sm text-muted">
              Connect to Telegram to manage requests.
            </p>
          ) : null}
        </div>
      </Dialog>
    );
  }),
);
