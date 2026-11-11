import { Effect } from 'effect';
import { component, list, view } from 'effectweb';
import MoreHorizontal from '@effectweb/lucide/icons/ellipsis';
import type { EffectMessagingClient } from '../../telegram/core/client';
import type {
  HistoryPage,
  TelegramMessage,
  TelegramPeer,
  TelegramContact,
  TelegramConversationEvent,
} from '../../telegram/types';
import type { MediaAssets } from '../media/mediaAssets';
import type { QuerySources } from '../app/queries';
import { Avatar } from '../shared/Avatar';
import { MessageBody } from '../conversation/MessageBody';
import { MediaAttachment } from '../media/MediaAttachment';
import { ContactCard } from '../conversation/ContactCard';
import { PollCard } from '../conversation/PollCard';
import { presentMessage } from '../conversation/presentation';
import { earlierHistoryBinding } from './earlierHistoryBinding';
interface Props {
  api: EffectMessagingClient;
  peer: TelegramPeer;
  enabled: boolean;
  online: boolean;
  media: MediaAssets;
  queries: QuerySources;
  status: (status: 'loading' | 'present' | 'empty') => void;
  beforeChange: () => void;
  open: (message: TelegramMessage) => void;
  openPeer: (peer: TelegramPeer, name: string) => void;
  openContact: (contact: TelegramContact) => Promise<unknown>;
  addContact: (contact: TelegramContact) => Promise<unknown>;
}
interface State {
  generation: number;
  source: TelegramPeer | undefined;
  resolved: boolean;
  messages: TelegramMessage[];
  before: number | undefined;
  more: boolean;
  busy: boolean;
  error: string;
}
type Message =
  | { type: 'Start' }
  | { type: 'Source'; peer: TelegramPeer | undefined }
  | { type: 'More' }
  | { type: 'Page'; page: HistoryPage; generation: number }
  | { type: 'Failed'; error: string; generation: number }
  | { type: 'Event'; event: TelegramConversationEvent };
export const EarlierGroupHistory = component<Props, State, Message>(
  {
    identity: (props) => props.peer.id,
    init: () => ({
      generation: 0,
      source: undefined,
      resolved: false,
      messages: [],
      before: undefined,
      more: false,
      busy: false,
      error: '',
    }),
    update: (model, message) => {
      switch (message.type) {
        case 'Start':
          if (!model.props.enabled || model.busy || model.resolved) return { model };
          return {
            model: { ...model, busy: true, error: '' },
            commands: [
              {
                key: ['migration', model.props.peer.id],
                policy: 'replace',
                effect: Effect.sync(() => model.props.status('loading')).pipe(
                  Effect.andThen(model.props.api.getChatManagement(model.props.peer)),
                  Effect.match({
                    onSuccess: (settings): Message => ({
                      type: 'Source',
                      peer: settings.migratedFrom,
                    }),
                    onFailure: (error): Message => ({
                      type: 'Failed',
                      error: error.message,
                      generation: model.generation,
                    }),
                  }),
                ),
              },
            ],
          };
        case 'Source':
          return {
            model: {
              ...model,
              source: message.peer,
              resolved: true,
              busy: false,
              more: Boolean(message.peer),
            },
            commands: [
              {
                key: 'source-ready',
                policy: 'replace',
                effect: message.peer
                  ? Effect.succeed({ type: 'More' as const })
                  : Effect.sync(() => model.props.status('empty')),
              },
            ],
          };
        case 'More':
          if (!model.source || model.busy || !model.more || !model.props.enabled) return { model };
          return {
            model: { ...model, busy: true, error: '' },
            commands: [
              {
                key: ['earlier-history', model.source.id],
                policy: 'replace',
                effect: model.props.api.getEarlierGroupHistory(model.source, model.before).pipe(
                  Effect.tap(() => Effect.sync(model.props.beforeChange)),
                  Effect.match({
                    onSuccess: (page): Message => ({
                      type: 'Page',
                      page,
                      generation: model.generation,
                    }),
                    onFailure: (error): Message => ({
                      type: 'Failed',
                      error: error.message,
                      generation: model.generation,
                    }),
                  }),
                ),
              },
            ],
          };
        case 'Page': {
          if (message.generation !== model.generation) return { model };
          const rows = [
            ...new Map(
              [...message.page.messages, ...model.messages].map((row) => [row.id, row]),
            ).values(),
          ].sort((a, b) => a.id - b.id);
          const before = message.page.nextBeforeMessageId ?? message.page.messages[0]?.id;
          return {
            model: {
              ...model,
              messages: rows,
              before,
              more: message.page.hasOlder && before !== undefined && before !== model.before,
              busy: false,
            },
            commands: [
              {
                key: 'status',
                policy: 'replace',
                effect: Effect.sync(() => model.props.status(rows.length ? 'present' : 'empty')),
              },
            ],
          };
        }
        case 'Failed':
          if (message.generation !== model.generation) return { model };
          return {
            model: { ...model, busy: false, error: message.error },
            commands: [
              {
                key: 'status',
                policy: 'replace',
                effect: Effect.sync(() =>
                  model.props.status(model.messages.length ? 'present' : 'empty'),
                ),
              },
            ],
          };
        case 'Event': {
          const event = message.event;
          if (!model.source) return { model };
          if (event.type === 'message-upsert' && event.message.peerId === model.source.id)
            return {
              model: {
                ...model,
                messages: model.messages.map((row) =>
                  row.id === event.message.id ? event.message : row,
                ),
              },
            };
          if (
            event.type === 'messages-delete' &&
            (!event.peerId || event.peerId === model.source.id)
          )
            return {
              model: {
                ...model,
                messages: model.messages.filter((row) => !event.messageIds.includes(row.id)),
              },
            };
          if (event.type === 'history-reset' && (!event.peerId || event.peerId === model.source.id))
            return {
              model: {
                ...model,
                generation: model.generation + 1,
                messages: [],
                before: undefined,
                more: true,
                busy: false,
                error: '',
              },
              commands: [
                {
                  key: 'reset-history',
                  policy: 'replace',
                  effect: Effect.succeed({ type: 'More' as const }),
                },
              ],
            };
          return { model };
        }
      }
    },
  },
  view((model, send) => (
    <section
      class="earlier-group-history"
      aria-label="Earlier group messages"
      hidden={!model.props.enabled}
    >
      <span
        class="earlier-history-sentinel"
        use={earlierHistoryBinding({
          api: model.props.api,
          enabled: model.props.enabled,
          online: model.props.online,
          canLoad: model.more && !model.busy && !model.error,
          start: () => send({ type: 'Start' }),
          more: () => send({ type: 'More' }),
          event: (event) => send({ type: 'Event', event }),
        })}
      />
      {model.busy && model.messages.length === 0 ? (
        <p class="history-loader" role="status">
          Loading earlier messages…
        </p>
      ) : null}
      {model.error ? (
        <div class="history-error" role="alert">
          <span>{model.error}</span>
          <button onClick={() => send({ type: model.resolved ? 'More' : 'Start' })}>
            Retry history
          </button>
        </div>
      ) : null}
      {model.more && model.messages.length > 0 && !model.error ? (
        <button
          class="message-window-control"
          disabled={model.busy}
          onClick={() => send({ type: 'More' })}
        >
          {model.busy ? (
            <span role="status">Loading earlier messages…</span>
          ) : (
            'Load older messages'
          )}
        </button>
      ) : null}
      {list(
        model.messages,
        (message) => message.id,
        (message, index) => {
          const previous = model.messages[index - 1];
          const showDate =
            !previous ||
            new Date(previous.date * 1000).toDateString() !==
              new Date(message.date * 1000).toDateString();
          const sender = message.senderName || (message.outgoing ? 'You' : message.senderId);
          const peer: TelegramPeer = {
            id: message.senderId,
            kind: message.senderId.startsWith('u:') ? 'user' : 'group',
          };
          const presented = presentMessage(
            message,
            0,
            model.messages.find((row) => row.id === message.replyToId),
          );
          return (
            <div class="message-flow-row">
              {showDate ? (
                <div class="my-3 self-center rounded-full border border-white/5 bg-black/25 px-3 py-1 text-[11px] font-medium text-[var(--muted)] backdrop-blur">
                  {new Intl.DateTimeFormat(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  }).format(new Date(message.date * 1000))}
                </div>
              ) : null}
              <article
                class={`message ${message.outgoing ? 'outgoing' : 'incoming'}${message.service ? ' service' : ''}`}
                data-message-id={`earlier:${message.peerId}:${message.id}`}
                data-source-peer={message.peerId}
                data-source-message={message.id}
              >
                {!message.outgoing && !message.service ? (
                  <span class="message-sender-avatar">
                    <Avatar
                      identity={`${message.senderId}:${message.senderAvatarId ?? ''}`}
                      initials={sender.slice(0, 2)}
                      color={message.senderColor ?? 'var(--accent)'}
                      size="sm"
                      load={
                        model.props.online && message.senderHasAvatar !== false
                          ? () =>
                              model.props.media.loadPeerAvatar(peer, true, message.senderAvatarId)
                          : undefined
                      }
                    />
                  </span>
                ) : null}
                {!message.service ? <strong class="message-author">{sender}</strong> : null}
                {message.forwardedFrom ? (
                  <small class="message-forwarded-from">
                    Forwarded from {message.forwardedFrom.name}
                  </small>
                ) : null}
                {presented.replyTo ? (
                  <small class="message-reply">{presented.replyTo}</small>
                ) : null}
                {message.media ? (
                  <MediaAttachment
                    media={message.media}
                    protected={message.protected}
                    load={(progress) => model.props.media.loadMedia(message, progress)}
                    loadPlayback={() => model.props.media.playMedia(message)}
                    loadPreview={() => model.props.media.messagePreview(message).load()}
                  />
                ) : null}
                {message.contact ? (
                  <ContactCard
                    contact={message.contact}
                    media={model.props.media}
                    online={model.props.online}
                    protected={Boolean(message.protected)}
                    open={model.props.openContact}
                    add={model.props.addContact}
                  />
                ) : null}
                {message.poll && model.source ? (
                  <PollCard
                    poll={message.poll}
                    media={model.props.media}
                    online={model.props.online}
                    vote={(options) =>
                      model.props.api.updatePoll(model.source!, message.id, 'vote', options)
                    }
                    loadVotes={(option, offset) =>
                      model.props.api.getPollVotes(model.source!, message.id, option, offset)
                    }
                    openVoter={(person) => model.props.openPeer(person.peer, person.name)}
                  />
                ) : null}
                <MessageBody
                  message={presented}
                  richMedia={{
                    protected: message.protected,
                    load: (media, progress) =>
                      model.props.media.loadMedia({ ...message, media }, progress),
                  }}
                  previewPhoto={
                    message.linkPreview?.hasPhoto
                      ? model.props.queries.previewPhoto(message.peerId, String(message.id))
                      : undefined
                  }
                  loadPreviewMedia={
                    message.linkPreview?.media
                      ? () => model.props.media.loadMedia(message)
                      : undefined
                  }
                />
                {!message.service ? (
                  <button
                    class="earlier-message-actions"
                    title="Open original message and actions"
                    aria-label={`Open earlier message ${message.id}`}
                    onClick={() => model.props.open(message)}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                ) : null}
                <footer>
                  <time
                    dateTime={new Date(message.date * 1000).toISOString()}
                    title={new Date(message.date * 1000).toLocaleString()}
                  >
                    {presented.time}
                  </time>
                </footer>
              </article>
            </div>
          );
        },
      )}
      {model.messages.length ? <div class="earlier-history-boundary">Group upgraded</div> : null}
    </section>
  )),
);
