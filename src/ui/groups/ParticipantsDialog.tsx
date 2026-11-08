import { Effect } from 'effect';
import { collection, component, list, sequence, view } from 'effectweb';
import ArrowLeft from '@effectweb/lucide/icons/arrow-left';
import Plus from '@effectweb/lucide/icons/plus';
import ChevronRight from '@effectweb/lucide/icons/chevron-right';
import type { EffectMessagingClient } from '../../telegram/core/client';
import type {
  ChatAdminRights,
  ChatRestrictions,
  ChatParticipantFilter,
  ChatParticipantChange,
  ChatManagementSettings,
  ManagedParticipant,
  ManagedParticipantsPage,
} from '../../telegram/chatManagement';
import type { TelegramDialog, TelegramPeerSearchResult } from '../../telegram/types';
import type { MediaAssets } from '../media/mediaAssets';
import { peerRows } from '../collections';
import { Avatar } from '../shared/Avatar';
import { Dialog } from '../shared/Dialog';
import { panelClass } from '../shared/panelStyles';
import { groupResourceSubscription } from './groupResourceSubscription';
import {
  adminLabels,
  permissionLabels,
  permissionKeys,
  expandedRestrictions,
  visibleAdminRights,
  newAdminRights,
} from './participantEditor';
interface Props {
  api: EffectMessagingClient;
  dialog: TelegramDialog;
  settings: ChatManagementSettings;
  initialFilter: ChatParticipantFilter;
  dialogs: TelegramDialog[];
  online: boolean;
  media: MediaAssets;
  close: () => void;
}
interface State {
  page: 'list' | 'person' | 'admin' | 'restrict' | 'confirm' | 'add';
  filter: ChatParticipantFilter;
  query: string;
  people: ManagedParticipantsPage | undefined;
  selected: ManagedParticipant | undefined;
  rights: ChatAdminRights;
  restrictions: ChatRestrictions;
  rank: string;
  until: string;
  confirm: 'remove' | 'demote' | 'unban';
  found: TelegramPeerSearchResult[];
  loading: boolean;
  busy: boolean;
  error: string;
  notice: string;
}
type Message =
  | { type: 'Load'; more?: boolean }
  | { type: 'Loaded'; people: ManagedParticipantsPage; more: boolean }
  | { type: 'Filter'; value: ChatParticipantFilter }
  | { type: 'Query'; value: string }
  | { type: 'Open'; person: ManagedParticipant }
  | { type: 'Back' }
  | { type: 'Admin' | 'Restrict' | 'Add' | 'SaveAdmin' | 'SaveRestriction' | 'ConfirmSave' }
  | { type: 'Right'; key: keyof ChatAdminRights; value: boolean }
  | { type: 'Permission'; key: keyof ChatRestrictions; value: boolean }
  | { type: 'Rank' | 'Until'; value: string }
  | { type: 'Confirm'; action: State['confirm'] }
  | { type: 'Found'; people: TelegramPeerSearchResult[] }
  | { type: 'Invite'; person: TelegramPeerSearchResult | TelegramDialog }
  | { type: 'Done'; missing?: string }
  | { type: 'Error'; error: string };
const permissionRows = collection<keyof typeof permissionLabels>((key) => key).from;
const adminRows = collection<keyof ChatAdminRights>((key) => key).from;
const filterLabels = {
  members: 'Members',
  admins: 'Administrators',
  restricted: 'Restricted users',
  removed: 'Removed users',
};
export const ParticipantsDialog = component<Props, State, Message>(
  {
    identity: (props) => props.dialog.peer.id,
    init: (props) => ({
      page: 'list',
      filter: props.initialFilter,
      query: '',
      people: undefined,
      selected: undefined,
      rights: {},
      restrictions: {},
      rank: '',
      until: '0',
      confirm: 'remove',
      found: [],
      loading: false,
      busy: false,
      error: '',
      notice: '',
    }),
    update: (model, message) => {
      const props = model.props,
        peer = props.dialog.peer;
      const run = (effect: Effect.Effect<Message, unknown>) => ({
        model: { ...model, busy: true, error: '', notice: '' },
        commands: [
          {
            key: ['member-write', peer.id],
            policy: 'drop' as const,
            effect: effect.pipe(
              Effect.catch((error) =>
                Effect.succeed({
                  type: 'Error',
                  error:
                    error instanceof Error ? error.message : 'Could not update this participant.',
                } as Message),
              ),
            ),
          },
        ],
      });
      const apply = (change: ChatParticipantChange) =>
        model.selected
          ? run(
              props.api
                .editChatParticipant(peer, model.selected.peer, change)
                .pipe(Effect.as({ type: 'Done' } as Message)),
            )
          : { model };
      switch (message.type) {
        case 'Load':
        case 'Filter':
        case 'Query': {
          const query =
            message.type === 'Query' ? message.value : message.type === 'Filter' ? '' : model.query;
          const filter = message.type === 'Filter' ? message.value : model.filter;
          const more = message.type === 'Load' && Boolean(message.more);
          if (!props.online || (more && model.people?.nextOffset === undefined)) return { model };
          const effect =
            model.page === 'add'
              ? props.api
                  .searchPeers(query)
                  .pipe(Effect.map((people): Message => ({ type: 'Found', people })))
              : props.api
                  .getManagedParticipants(
                    peer,
                    filter,
                    query,
                    more ? model.people?.nextOffset : undefined,
                  )
                  .pipe(Effect.map((people): Message => ({ type: 'Loaded', people, more })));
          return {
            model: {
              ...model,
              filter,
              query,
              loading: true,
              error: '',
              people: message.type === 'Filter' ? undefined : model.people,
            },
            commands: [
              {
                key: ['members-load', peer.id],
                policy: 'replace',
                effect: Effect.sleep(message.type === 'Query' ? 200 : 0).pipe(
                  Effect.andThen(effect),
                  Effect.catch((error) =>
                    Effect.succeed({ type: 'Error', error: error.message } as Message),
                  ),
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
              people: {
                ...message.people,
                people: message.more
                  ? [
                      ...new Map(
                        [...(model.people?.people ?? []), ...message.people.people].map(
                          (person) => [person.peer.id, person],
                        ),
                      ).values(),
                    ]
                  : message.people.people,
              },
            },
          };
        case 'Found':
          return { model: { ...model, loading: false, found: message.people } };
        case 'Open':
          return {
            model: { ...model, page: 'person', selected: message.person, error: '', notice: '' },
          };
        case 'Back':
          return model.busy
            ? { model }
            : {
                model: {
                  ...model,
                  page: ['admin', 'restrict', 'confirm'].includes(model.page) ? 'person' : 'list',
                  query: '',
                  error: '',
                  notice: '',
                },
                commands: [
                  {
                    key: 'back-load',
                    policy: 'replace',
                    effect: Effect.succeed({ type: 'Load' } as Message),
                  },
                ],
              };
        case 'Admin':
          return !model.selected
            ? { model }
            : {
                model: {
                  ...model,
                  page: 'admin',
                  rights:
                    model.selected.role === 'admin'
                      ? model.selected.adminRights
                      : newAdminRights(props.settings),
                  rank: model.selected.rank,
                },
              };
        case 'Restrict':
          return !model.selected
            ? { model }
            : {
                model: {
                  ...model,
                  page: 'restrict',
                  restrictions: expandedRestrictions(model.selected.restrictions),
                  until: model.selected.untilDate ? String(model.selected.untilDate) : '0',
                },
              };
        case 'Add':
          return { model: { ...model, page: 'add', query: '', found: [], error: '', notice: '' } };
        case 'Right':
          return { model: { ...model, rights: { ...model.rights, [message.key]: message.value } } };
        case 'Permission':
          return {
            model: {
              ...model,
              restrictions: { ...model.restrictions, [message.key]: !message.value },
            },
          };
        case 'Rank':
          return { model: { ...model, rank: message.value } };
        case 'Until':
          return { model: { ...model, until: message.value } };
        case 'SaveAdmin': {
          if (peer.kind === 'channel' && !Object.values(model.rights).some(Boolean))
            return {
              model: {
                ...model,
                error:
                  'Select at least one permission. Use Remove administrator to revoke the role.',
              },
            };
          return apply({
            kind: 'admin',
            rights: peer.kind === 'group' ? { changeInfo: true } : model.rights,
            rank: model.rank,
          });
        }
        case 'SaveRestriction':
          return run(
            Effect.sync(() =>
              model.until === 'day'
                ? Math.floor(Date.now() / 1000) + 86400
                : model.until === 'week'
                  ? Math.floor(Date.now() / 1000) + 604800
                  : Number(model.until),
            ).pipe(
              Effect.flatMap((untilDate) =>
                props.api.editChatParticipant(peer, model.selected!.peer, {
                  kind: 'restrict',
                  restrictions: model.restrictions,
                  untilDate,
                }),
              ),
              Effect.as({ type: 'Done' } as Message),
            ),
          );
        case 'Confirm':
          return { model: { ...model, page: 'confirm', confirm: message.action, error: '' } };
        case 'ConfirmSave':
          return apply(
            model.confirm === 'demote'
              ? { kind: 'admin', rights: {}, rank: '' }
              : { kind: model.confirm },
          );
        case 'Invite':
          return run(
            props.api
              .addChatMember(peer, message.person.peer)
              .pipe(
                Effect.map((result): Message => ({
                  type: 'Done',
                  ...(result.missingUserIds.length ? { missing: message.person.title } : {}),
                })),
              ),
          );
        case 'Done':
          return {
            model: {
              ...model,
              busy: false,
              page: message.missing ? 'add' : 'list',
              selected: undefined,
              query: '',
              notice: message.missing
                ? `Telegram could not add ${message.missing}. Share an invitation link with them instead.`
                : '',
              error: '',
            },
            commands: [
              {
                key: 'after-write',
                policy: 'replace',
                effect: Effect.succeed({ type: 'Load' } as Message),
              },
            ],
          };
        case 'Error':
          return { model: { ...model, busy: false, loading: false, error: message.error } };
      }
    },
  },
  view((model, send) => {
    const props = model.props,
      person = model.selected,
      settings = props.settings;
    const defaults = expandedRestrictions(settings.defaultRestrictions ?? {});
    const candidates = [
      ...new Map(
        [...props.dialogs, ...model.found]
          .filter((item) => item.peer.kind === 'user')
          .map((item) => [item.peer.id, item]),
      ).values(),
    ].filter(
      (item) =>
        !model.query ||
        item.title.toLowerCase().includes(model.query.toLowerCase()) ||
        model.found.some((found) => found.peer.id === item.peer.id),
    );
    const title =
      model.page === 'list'
        ? filterLabels[model.filter]
        : model.page === 'add'
          ? 'Add member'
          : model.page === 'admin'
            ? 'Administrator permissions'
            : model.page === 'restrict'
              ? 'User permissions'
              : model.page === 'confirm'
                ? model.confirm === 'remove'
                  ? 'Remove member?'
                  : model.confirm === 'demote'
                    ? 'Remove administrator?'
                    : 'Allow this user to rejoin?'
                : (person?.title ?? 'Participant');
    return (
      <Dialog
        title={title}
        class={`${panelClass} !max-w-[460px]`}
        onClose={() => {
          if (!model.busy) props.close();
        }}
        headerLeading={
          <button
            class="icon-button"
            aria-label="Back"
            disabled={model.busy}
            onClick={() => (model.page === 'list' ? props.close() : send({ type: 'Back' }))}
          >
            <ArrowLeft size={20} />
          </button>
        }
      >
        <span
          hidden
          use={groupResourceSubscription({
            api: props.api,
            peerId: props.dialog.peer.id,
            kind: 'group-members',
            online: props.online,
            reload: () => send({ type: 'Load' }),
          })}
        />
        <div class="participants-body scroll-area">
          {model.page === 'list' || model.page === 'add' ? (
            <>
              {model.page === 'list' ? (
                <nav class="participant-tabs" aria-label="Participant filter">
                  {list(
                    sequence(
                      props.dialog.peer.kind === 'channel'
                        ? (['members', 'admins', 'restricted', 'removed'] as const)
                        : (['members', 'admins'] as const),
                    ),
                    (filter) => (
                      <button
                        aria-pressed={model.filter === filter}
                        onClick={() => send({ type: 'Filter', value: filter })}
                      >
                        {filterLabels[filter]}
                      </button>
                    ),
                  )}
                </nav>
              ) : null}
              <label class="create-chat-field">
                <span>{model.page === 'add' ? 'Search people' : 'Search participants'}</span>
                <input
                  value={model.query}
                  onInput={(event) => send({ type: 'Query', value: event.currentTarget.value })}
                />
              </label>
              {model.page === 'list' && settings.rights.manageInvites ? (
                <button
                  class="folder-main text-accent"
                  disabled={!props.online}
                  onClick={() => send({ type: 'Add' })}
                >
                  <Plus size={20} />
                  <span>Add member</span>
                </button>
              ) : null}
              {model.page === 'list'
                ? list(peerRows(model.people?.people ?? []), (item) => (
                    <button
                      class="participant-row"
                      onClick={() => send({ type: 'Open', person: item })}
                    >
                      <Avatar
                        identity={item.peer.id}
                        initials={item.initials}
                        color={item.color}
                        size="sm"
                        loadCached={() =>
                          props.media.loadPeerAvatar(item.peer, item.hasAvatar, item.avatarId, true)
                        }
                        load={
                          props.online
                            ? () =>
                                props.media.loadPeerAvatar(item.peer, item.hasAvatar, item.avatarId)
                            : undefined
                        }
                      />
                      <span>
                        <strong>{item.title}</strong>
                        <small>
                          {item.self ? 'You · ' : ''}
                          {item.rank || item.role}
                        </small>
                      </span>
                      <ChevronRight size={18} />
                    </button>
                  ))
                : list(peerRows(candidates), (item) => (
                    <button
                      class="participant-row"
                      disabled={model.busy || !props.online}
                      onClick={() => send({ type: 'Invite', person: item })}
                    >
                      <Avatar
                        identity={item.peer.id}
                        initials={item.initials}
                        color={item.color}
                        size="sm"
                        load={
                          props.online
                            ? () =>
                                props.media.loadPeerAvatar(item.peer, item.hasAvatar, item.avatarId)
                            : undefined
                        }
                      />
                      <span>
                        <strong>{item.title}</strong>
                      </span>
                      <Plus size={18} />
                    </button>
                  ))}
              {model.loading ? (
                <p role="status">Loading people…</p>
              ) : model.page === 'list' && !model.people?.people.length ? (
                <p class="join-requests-empty">No participants found</p>
              ) : null}
              {model.page === 'list' && model.people?.nextOffset !== undefined ? (
                <button
                  class="secondary-button"
                  disabled={model.loading || !props.online}
                  onClick={() => send({ type: 'Load', more: true })}
                >
                  Load more
                </button>
              ) : null}
            </>
          ) : model.page === 'person' && person ? (
            <>
              <div class="participant-profile">
                <Avatar
                  identity={person.peer.id}
                  initials={person.initials}
                  color={person.color}
                  size="lg"
                  load={
                    props.online
                      ? () =>
                          props.media.loadPeerAvatar(person.peer, person.hasAvatar, person.avatarId)
                      : undefined
                  }
                />
                <strong>{person.title}</strong>
                <small>{person.rank || person.role}</small>
              </div>
              {person.editable ? (
                <>
                  {settings.rights.manageAdmins &&
                  person.peer.kind === 'user' &&
                  person.role !== 'removed' ? (
                    <button
                      class="folder-main"
                      disabled={!props.online}
                      onClick={() => send({ type: 'Admin' })}
                    >
                      <span>
                        {person.role === 'admin' ? 'Edit administrator' : 'Add as administrator'}
                      </span>
                      <ChevronRight size={18} />
                    </button>
                  ) : null}
                  {settings.rights.restrictMembers && person.role !== 'admin' ? (
                    <>
                      {props.dialog.peer.kind === 'channel' && person.role !== 'removed' ? (
                        <button
                          class="folder-main"
                          disabled={!props.online}
                          onClick={() => send({ type: 'Restrict' })}
                        >
                          <span>Restrict user</span>
                          <ChevronRight size={18} />
                        </button>
                      ) : null}
                      <button
                        class="folder-main text-red-400"
                        disabled={!props.online}
                        onClick={() =>
                          send({
                            type: 'Confirm',
                            action: person.role === 'removed' ? 'unban' : 'remove',
                          })
                        }
                      >
                        <span>
                          {person.role === 'removed' ? 'Allow to rejoin' : 'Remove member'}
                        </span>
                      </button>
                    </>
                  ) : null}
                </>
              ) : (
                <p class="text-sm text-muted">
                  {person.self
                    ? 'You cannot change your own role here.'
                    : person.role === 'owner'
                      ? 'The owner cannot be changed here.'
                      : 'You do not have permission to edit this administrator.'}
                </p>
              )}
            </>
          ) : model.page === 'admin' && person ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                send({ type: 'SaveAdmin' });
              }}
            >
              <p class="participant-editor-name">{person.title}</p>
              {props.dialog.peer.kind === 'group' ? (
                <p class="management-help">
                  Administrators in this basic group share the same role.
                </p>
              ) : (
                <>
                  {list(adminRows(visibleAdminRights(settings)), (key) => (
                    <label class="participant-permission">
                      <span>{adminLabels[key]}</span>
                      <input
                        type="checkbox"
                        checked={Boolean(model.rights[key])}
                        disabled={model.busy || !settings.grantableAdminRights?.[key]}
                        onChange={(event) =>
                          send({ type: 'Right', key, value: event.currentTarget.checked })
                        }
                      />
                    </label>
                  ))}
                  <label class="create-chat-field">
                    <span>Administrator title (optional)</span>
                    <input
                      value={model.rank}
                      maxLength={16}
                      disabled={model.busy}
                      onInput={(event) => send({ type: 'Rank', value: event.currentTarget.value })}
                    />
                  </label>
                </>
              )}
              {person.role === 'admin' ? (
                <button
                  type="button"
                  class="invite-link-danger"
                  disabled={model.busy}
                  onClick={() => send({ type: 'Confirm', action: 'demote' })}
                >
                  Remove administrator
                </button>
              ) : null}
              <div class="folder-footer">
                <button
                  type="button"
                  class="secondary-button"
                  disabled={model.busy}
                  onClick={() => send({ type: 'Back' })}
                >
                  Cancel
                </button>
                <button class="primary-button" type="submit" disabled={model.busy || !props.online}>
                  {model.busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          ) : model.page === 'restrict' && person ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                send({ type: 'SaveRestriction' });
              }}
            >
              <p class="participant-editor-name">{person.title}</p>
              <p class="management-help">
                Choose what this user is allowed to do. Group-wide restrictions still apply.
              </p>
              {list(
                permissionRows(
                  permissionKeys.filter((key) => settings.forum || key !== 'manageTopics'),
                ),
                (key) => (
                  <label class="participant-permission">
                    <span>{permissionLabels[key]}</span>
                    <input
                      type="checkbox"
                      checked={!model.restrictions[key] && !defaults[key]}
                      disabled={model.busy || Boolean(defaults[key])}
                      onChange={(event) =>
                        send({ type: 'Permission', key, value: event.currentTarget.checked })
                      }
                    />
                  </label>
                ),
              )}
              <label class="create-chat-field">
                <span>Restriction duration</span>
                <select
                  value={model.until}
                  disabled={model.busy}
                  onChange={(event) => send({ type: 'Until', value: event.currentTarget.value })}
                >
                  <option value="0">Forever</option>
                  <option value="day">1 day</option>
                  <option value="week">1 week</option>
                  {person.untilDate ? (
                    <option value={String(person.untilDate)}>
                      Until {new Date(person.untilDate * 1000).toLocaleString()}
                    </option>
                  ) : null}
                </select>
              </label>
              <div class="folder-footer">
                <button
                  type="button"
                  class="secondary-button"
                  disabled={model.busy}
                  onClick={() => send({ type: 'Back' })}
                >
                  Cancel
                </button>
                <button class="primary-button" type="submit" disabled={model.busy || !props.online}>
                  {model.busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          ) : model.page === 'confirm' && person ? (
            <>
              <p>
                {model.confirm === 'demote'
                  ? `${person.title} will lose administrator permissions and remain a member.`
                  : model.confirm === 'unban'
                    ? `${person.title} will be able to join again using an invitation. This does not add them automatically.`
                    : `${person.title} will be removed from ${props.dialog.title}. Their existing messages will remain.`}
              </p>
              <div class="folder-footer">
                <button
                  class="secondary-button"
                  disabled={model.busy}
                  onClick={() => send({ type: 'Back' })}
                >
                  Cancel
                </button>
                <button
                  class="secondary-button text-red-400"
                  disabled={model.busy || !props.online}
                  onClick={() => send({ type: 'ConfirmSave' })}
                >
                  {model.busy
                    ? 'Please wait…'
                    : model.confirm === 'demote'
                      ? 'Remove administrator'
                      : model.confirm === 'unban'
                        ? 'Allow to rejoin'
                        : 'Remove member'}
                </button>
              </div>
            </>
          ) : null}
          {model.notice ? (
            <p role="status" class="text-sm text-muted">
              {model.notice}
            </p>
          ) : null}
          {model.error ? (
            <p role="alert" class="text-sm text-red-400">
              {model.error}
            </p>
          ) : null}
          {!props.online ? (
            <p role="status" class="text-sm text-muted">
              Connect to Telegram to manage participants.
            </p>
          ) : null}
        </div>
      </Dialog>
    );
  }),
);
