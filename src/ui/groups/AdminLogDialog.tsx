import { Effect } from 'effect';
import { component, list, sequence, view } from 'effectweb';
import ArrowLeft from '@effectweb/lucide/icons/arrow-left';
import SlidersHorizontal from '@effectweb/lucide/icons/sliders-horizontal';
import type { EffectMessagingClient } from '../../telegram/core/client';
import {
  adminLogFilters,
  type AdminLogFilter,
  type AdminLogPage,
  type AdminLogActor,
} from '../../telegram/adminLog';
import type { TelegramPeer, TelegramDialog } from '../../telegram/types';
import type { MediaAssets } from '../media/mediaAssets';
import { idRows, peerRows } from '../collections';
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
  filter: AdminLogFilter;
  actorId: string;
  actors: AdminLogActor[];
  filtersOpen: boolean;
  page: AdminLogPage | undefined;
  loading: boolean;
  error: string;
}
type Message =
  | { type: 'Load'; more?: boolean }
  | { type: 'Query'; value: string }
  | { type: 'Filter'; value: AdminLogFilter }
  | { type: 'Actor'; value: string }
  | { type: 'ToggleFilters' }
  | { type: 'Loaded'; page: AdminLogPage; more: boolean; actors: AdminLogActor[] }
  | { type: 'Failed'; error: string };
const loadAuthors = Effect.fn('AdminLog.loadAuthors')(function* (
  api: EffectMessagingClient,
  peer: TelegramPeer,
) {
  const actors: AdminLogActor[] = [];
  let offset: number | undefined;
  do {
    const page = yield* api.getManagedParticipants(peer, 'admins', '', offset);
    actors.push(...page.people);
    if (page.nextOffset === undefined || page.nextOffset === offset) break;
    offset = page.nextOffset;
  } while (true);
  return actors;
});
const filterOptions = Object.entries(adminLogFilters).map(([id, title]) => ({
  id: id as AdminLogFilter,
  title,
}));
export const AdminLogDialog = component<Props, State, Message>(
  {
    identity: (props) => props.dialog.peer.id,
    init: () => ({
      query: '',
      filter: 'all',
      actorId: '',
      actors: [],
      filtersOpen: false,
      page: undefined,
      loading: false,
      error: '',
    }),
    update: (model, message) => {
      switch (message.type) {
        case 'ToggleFilters':
          return { model: { ...model, filtersOpen: !model.filtersOpen } };
        case 'Load':
        case 'Query':
        case 'Filter':
        case 'Actor': {
          const more = message.type === 'Load' && Boolean(message.more);
          const query = message.type === 'Query' ? message.value : model.query;
          const filter = message.type === 'Filter' ? message.value : model.filter;
          const actorId = message.type === 'Actor' ? message.value : model.actorId;
          const beforeId = more ? model.page?.nextId : undefined;
          if (!model.props.online || (more && (!beforeId || model.loading))) return { model };
          return {
            model: {
              ...model,
              query,
              filter,
              actorId,
              loading: true,
              error: '',
              page: message.type === 'Load' ? model.page : undefined,
            },
            commands: [
              {
                key: ['admin-log', model.props.dialog.peer.id],
                policy: 'replace',
                effect: Effect.sleep(message.type === 'Query' ? 200 : 0).pipe(
                  Effect.andThen(
                    model.props.api.getAdminLog(model.props.dialog.peer, {
                      query,
                      filter,
                      ...(beforeId ? { beforeId } : {}),
                      ...(actorId
                        ? { actor: model.actors.find((actor) => actor.peer.id === actorId)!.peer }
                        : {}),
                    }),
                  ),
                  Effect.flatMap((page) =>
                    (message.type === 'Load' && !more
                      ? loadAuthors(model.props.api, model.props.dialog.peer).pipe(
                          Effect.catch(() => Effect.succeed([] as AdminLogActor[])),
                        )
                      : Effect.succeed([] as AdminLogActor[])
                    ).pipe(Effect.map((actors) => ({ page, actors }))),
                  ),
                  Effect.match({
                    onSuccess: ({ page, actors }): Message => ({
                      type: 'Loaded',
                      page,
                      more,
                      actors,
                    }),
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
              actors: [
                ...new Map(
                  [
                    ...model.actors,
                    ...message.actors,
                    ...message.page.events.map((event) => event.actor),
                  ].map((actor) => [actor.peer.id, actor]),
                ).values(),
              ],
              page: {
                ...message.page,
                events: message.more
                  ? [
                      ...new Map(
                        [...(model.page?.events ?? []), ...message.page.events].map((event) => [
                          event.id,
                          event,
                        ]),
                      ).values(),
                    ]
                  : message.page.events,
              },
            },
          };
        case 'Failed':
          return { model: { ...model, loading: false, error: message.error } };
      }
    },
  },
  view((model, send) => (
    <Dialog
      title="Recent actions"
      class={`${panelClass} !max-w-[620px]`}
      onClose={model.props.close}
      headerLeading={
        <button class="icon-button" aria-label="Back" onClick={model.props.close}>
          <ArrowLeft size={20} />
        </button>
      }
    >
      <span
        hidden
        use={groupResourceSubscription({
          api: model.props.api,
          peerId: model.props.dialog.peer.id,
          kind: 'chat-management',
          online: model.props.online,
          reload: () => send({ type: 'Load' }),
        })}
      />
      <div class="admin-log-toolbar">
        <input
          aria-label="Search recent actions"
          placeholder="Search"
          value={model.query}
          onInput={(event) => send({ type: 'Query', value: event.currentTarget.value })}
        />
        <button
          class="icon-button"
          aria-label="Filter actions"
          aria-expanded={model.filtersOpen}
          title="Filter actions"
          onClick={() => send({ type: 'ToggleFilters' })}
        >
          <SlidersHorizontal size={20} />
        </button>
      </div>
      {model.filtersOpen ? (
        <div class="admin-log-filters">
          <label class="create-chat-field">
            <span>Action type</span>
            <select
              value={model.filter}
              onChange={(event) =>
                send({ type: 'Filter', value: event.currentTarget.value as AdminLogFilter })
              }
            >
              {list(idRows(filterOptions), (option) => (
                <option value={option.id}>{option.title}</option>
              ))}
            </select>
          </label>
          <label class="create-chat-field">
            <span>Author</span>
            <select
              value={model.actorId}
              onChange={(event) => send({ type: 'Actor', value: event.currentTarget.value })}
            >
              <option value="">All authors</option>
              {list(peerRows(model.actors), (actor) => (
                <option value={actor.peer.id}>{actor.title}</option>
              ))}
            </select>
          </label>
        </div>
      ) : model.filter !== 'all' || model.actorId ? (
        <p class="admin-log-filter-summary">
          {adminLogFilters[model.filter]}
          {model.actorId
            ? ` · ${model.actors.find((actor) => actor.peer.id === model.actorId)?.title ?? ''}`
            : ''}
        </p>
      ) : null}
      <div class="admin-log-body scroll-area" aria-busy={model.loading}>
        <p class="management-help">Recent changes, member activity and administrator actions.</p>
        {list(idRows(model.page?.events ?? []), (event) => (
          <article class="admin-log-event" data-testid="admin-log-event">
            <Avatar
              identity={event.actor.peer.id}
              initials={event.actor.initials}
              color={event.actor.color}
              size="sm"
              load={
                model.props.online
                  ? () =>
                      model.props.media.loadPeerAvatar(
                        event.actor.peer,
                        event.actor.hasAvatar,
                        event.actor.avatarId,
                      )
                  : undefined
              }
            />
            <div class="admin-log-content">
              <p>
                <strong>{event.actor.title}</strong> {event.action}
              </p>
              <time
                dateTime={new Date(event.date * 1000).toISOString()}
                title={new Date(event.date * 1000).toLocaleString()}
              >
                {new Date(event.date * 1000).toLocaleString()}
              </time>
              {event.details.length ? (
                <details>
                  <summary>Details</summary>
                  {list(sequence(event.details), (detail) => (
                    <div class="admin-log-detail">
                      <span>{detail.label}</span>
                      <p>{detail.text}</p>
                    </div>
                  ))}
                </details>
              ) : null}
            </div>
          </article>
        ))}
        {!model.loading && !model.error && model.page && !model.page.events.length ? (
          <p class="join-requests-empty">No recent actions found</p>
        ) : null}
        {model.loading ? <p role="status">Loading actions…</p> : null}
        {model.error ? (
          <p role="alert" class="text-sm text-red-400">
            {model.error}
          </p>
        ) : null}
        {!model.props.online ? (
          <p role="status" class="text-sm text-muted">
            Connect to Telegram to view recent actions.
          </p>
        ) : null}
        {model.page?.nextId ? (
          <button
            class="secondary-button"
            disabled={model.loading || !model.props.online}
            onClick={() => send({ type: 'Load', more: true })}
          >
            Earlier actions
          </button>
        ) : null}
      </div>
    </Dialog>
  )),
);
