import { component, view, list } from 'effectweb';
import { Effect } from 'effect';
import ArrowLeft from '@effectweb/lucide/icons/arrow-left';
import Plus from '@effectweb/lucide/icons/plus';
import Hash from '@effectweb/lucide/icons/hash';
import Lock from '@effectweb/lucide/icons/lock';
import Pin from '@effectweb/lucide/icons/pin';
import Ellipsis from '@effectweb/lucide/icons/ellipsis';
import type { EffectMessagingClient } from '../../telegram/core/client';
import type { TelegramDialog } from '../../telegram/types';
import type {
  TelegramForumTopic,
  TelegramForumPage,
  TelegramForumOffset,
} from '../../telegram/forums';
import { idRows } from '../collections';
import { Dialog } from '../shared/Dialog';
import { topicSubscription } from './topicSubscription';
interface Props {
  api: EffectMessagingClient;
  dialog: TelegramDialog;
  online: boolean;
  selected?: number | undefined;
  updateTopics: (topics: TelegramForumTopic[]) => void;
  select: (topic: TelegramForumTopic) => void;
  back: () => void;
}
interface State {
  topics: TelegramForumTopic[];
  previews: Record<number, string>;
  query: string;
  offset: TelegramForumOffset | undefined;
  busy: boolean;
  error: string;
  canCreate: boolean;
  canManage: boolean;
  editing: TelegramForumTopic | 'new' | undefined;
  deleting: TelegramForumTopic | undefined;
  title: string;
  color: number;
  menu: number | undefined;
}
type Message =
  | { type: 'Load'; more?: boolean }
  | { type: 'Loaded'; peerId: string; page: TelegramForumPage; more: boolean }
  | { type: 'Query'; value: string }
  | { type: 'Edit'; topic: TelegramForumTopic | 'new' | undefined }
  | { type: 'Title'; value: string }
  | { type: 'Color'; value: number }
  | { type: 'Menu'; id: number | undefined }
  | { type: 'Delete'; topic: TelegramForumTopic | undefined }
  | { type: 'ConfirmDelete' }
  | { type: 'Deleted'; id: number }
  | { type: 'Save' }
  | { type: 'Pin'; topic: TelegramForumTopic }
  | { type: 'Close'; topic: TelegramForumTopic }
  | { type: 'Hide'; topic: TelegramForumTopic }
  | { type: 'Done' }
  | { type: 'Error'; error: string };
const colors = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f];
export const ForumTopics = component<Props, State, Message>(
  {
    init: () => ({
      topics: [],
      previews: {},
      query: '',
      offset: undefined,
      busy: false,
      error: '',
      canCreate: false,
      canManage: false,
      editing: undefined,
      deleting: undefined,
      title: '',
      color: colors[0]!,
      menu: undefined,
    }),
    update: (model, message) => {
      const peer = model.props.dialog.peer;
      const run = (effect: Effect.Effect<Message, unknown>, key = 'mutation') => ({
        model: { ...model, busy: true, error: '', menu: key === 'load' ? model.menu : undefined },
        commands: [
          {
            key: ['forum', peer.id, key],
            policy: 'replace' as const,
            effect: effect.pipe(
              Effect.catch((error) =>
                Effect.succeed({
                  type: 'Error',
                  error: error instanceof Error ? error.message : 'Could not load topics.',
                } as Message),
              ),
            ),
          },
        ],
      });
      const load = (more = false) =>
        model.props.api.getForumTopics(peer, model.query, more ? model.offset : undefined).pipe(
          Effect.tap((page) => Effect.sync(() => model.props.updateTopics(page.topics))),
          Effect.map((page): Message => ({ type: 'Loaded', peerId: peer.id, page, more })),
        );
      const mutate = (effect: Effect.Effect<void, unknown>) =>
        run(effect.pipe(Effect.as({ type: 'Done' } as Message)));
      switch (message.type) {
        case 'Load':
          return run(load(Boolean(message.more)), 'load');
        case 'Loaded':
          return message.peerId !== peer.id
            ? { model }
            : {
                model: {
                  ...model,
                  busy: false,
                  topics: message.more
                    ? [
                        ...new Map(
                          [...model.topics, ...message.page.topics].map((topic) => [
                            topic.id,
                            topic,
                          ]),
                        ).values(),
                      ]
                    : message.page.topics,
                  previews: {
                    ...(message.more ? model.previews : {}),
                    ...Object.fromEntries(
                      message.page.topics.map((topic) => [
                        topic.id,
                        message.page.messages.find((item) => item.id === topic.topMessageId)
                          ?.text ?? '',
                      ]),
                    ),
                  },
                  offset: message.page.nextOffset,
                  canCreate: message.page.canCreate,
                  canManage: message.page.canManage,
                },
              };
        case 'Query':
          return {
            model: { ...model, query: message.value },
            commands: [
              {
                key: ['forum', peer.id, 'search'],
                policy: 'replace' as const,
                effect: Effect.sleep(200).pipe(Effect.as({ type: 'Load' } as Message)),
              },
            ],
          };
        case 'Edit':
          return {
            model: {
              ...model,
              editing: message.topic,
              title: typeof message.topic === 'object' ? message.topic.title : '',
              color: colors[0]!,
              menu: undefined,
              error: '',
            },
          };
        case 'Title':
          return { model: { ...model, title: message.value } };
        case 'Color':
          return { model: { ...model, color: message.value } };
        case 'Menu':
          return { model: { ...model, menu: message.id } };
        case 'Error':
          return { model: { ...model, busy: false, error: message.error } };
        case 'Done':
          return {
            ...run(load(), 'load'),
            model: {
              ...model,
              editing: undefined,
              deleting: undefined,
              menu: undefined,
              busy: true,
            },
          };
        case 'Delete':
          return { model: { ...model, deleting: message.topic, menu: undefined, error: '' } };
        case 'ConfirmDelete':
          return model.deleting
            ? mutate(model.props.api.deleteForumTopic(peer, model.deleting.id))
            : { model };
        case 'Deleted':
          return model.props.selected === message.id
            ? run(
                model.props.api.getForumTopic(peer, 1).pipe(
                  Effect.tap((topic) =>
                    Effect.sync(() => {
                      if (topic) model.props.select(topic);
                    }),
                  ),
                  Effect.as({ type: 'Done' } as Message),
                ),
              )
            : { model };
        case 'Save':
          return model.editing === 'new'
            ? mutate(model.props.api.createForumTopic(peer, model.title, model.color))
            : model.editing
              ? mutate(
                  model.props.api.editForumTopic(peer, model.editing.id, { title: model.title }),
                )
              : { model };
        case 'Pin':
          return mutate(
            model.props.api.pinForumTopic(peer, message.topic.id, !message.topic.pinned),
          );
        case 'Close':
          return mutate(
            model.props.api.editForumTopic(peer, message.topic.id, {
              closed: !message.topic.closed,
            }),
          );
        case 'Hide':
          return mutate(
            model.props.api.editForumTopic(peer, message.topic.id, {
              hidden: !message.topic.hidden,
            }),
          );
      }
    },
  },
  view((model, send) => (
    <aside
      class="forum-sidebar"
      data-testid="chat-sidebar"
      tabIndex={-1}
      aria-label="Forum topics"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && model.menu !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          send({ type: 'Menu', id: undefined });
        }
      }}
      use={topicSubscription({
        api: model.props.api,
        peerId: model.props.dialog.peer.id,
        online: model.props.online,
        reload: () => send({ type: 'Load' }),
        deleted: (id) => send({ type: 'Deleted', id }),
      })}
    >
      <header class="forum-sidebar-header">
        <button
          class="icon-button"
          aria-label="Back to chats"
          title="Back to chats"
          onClick={model.props.back}
        >
          <ArrowLeft size={21} />
        </button>
        <strong>{model.props.dialog.title}</strong>
        {model.canCreate ? (
          <button
            class="icon-button"
            aria-label="Create topic"
            title="Create topic"
            disabled={!model.props.online}
            onClick={() => send({ type: 'Edit', topic: 'new' })}
          >
            <Plus size={21} />
          </button>
        ) : null}
      </header>
      <label class="forum-search">
        <input
          aria-label="Search topics"
          placeholder="Search topics"
          value={model.query}
          onInput={(event) => send({ type: 'Query', value: event.currentTarget.value })}
        />
      </label>
      {model.error ? (
        <p role="alert" class="folder-error">
          {model.error}
        </p>
      ) : null}
      <div class="forum-topic-list scroll-area" aria-busy={model.busy}>
        {list(idRows(model.topics), (topic) => (
          <div class="forum-topic" classList={{ selected: model.props.selected === topic.id }}>
            <button
              class="forum-topic-main"
              onClick={() => model.props.select(topic)}
              onContextMenu={(event) => {
                event.preventDefault();
                send({ type: 'Menu', id: topic.id });
              }}
            >
              <span
                class="forum-topic-icon"
                style={{ color: `#${topic.iconColor.toString(16).padStart(6, '0')}` }}
              >
                <Hash size={25} />
              </span>
              <span class="forum-topic-copy">
                <strong>{topic.title}</strong>
                <small>
                  {topic.hidden
                    ? 'Hidden topic'
                    : topic.closed
                      ? 'Closed topic'
                      : model.previews[topic.id] || 'No messages yet'}
                </small>
              </span>
              {topic.closed ? <Lock size={13} /> : null}
              {topic.pinned ? <Pin size={13} /> : null}
              {topic.unreadCount > 0 ? <span class="forum-unread">{topic.unreadCount}</span> : null}
            </button>
            {model.canManage || topic.own ? (
              <button
                class="icon-button forum-topic-options"
                aria-label={`Manage ${topic.title}`}
                title="Manage topic"
                onClick={() =>
                  send({ type: 'Menu', id: model.menu === topic.id ? undefined : topic.id })
                }
              >
                <Ellipsis size={18} />
              </button>
            ) : null}
            {model.menu === topic.id && (model.canManage || topic.own) ? (
              <div class="forum-topic-menu" role="menu" aria-label={`Manage ${topic.title}`}>
                <button role="menuitem" onClick={() => send({ type: 'Edit', topic })}>
                  Edit topic
                </button>
                <button
                  role="menuitem"
                  disabled={!model.props.online || model.busy}
                  onClick={() => send({ type: 'Close', topic })}
                >
                  {topic.closed ? 'Reopen topic' : 'Close topic'}
                </button>
                {model.canManage ? (
                  <button
                    role="menuitem"
                    disabled={!model.props.online || model.busy}
                    onClick={() => send({ type: 'Pin', topic })}
                  >
                    {topic.pinned ? 'Unpin topic' : 'Pin topic'}
                  </button>
                ) : null}
                {topic.id !== 1 &&
                (model.props.dialog.permissions?.canDeleteMessages || topic.own) ? (
                  <button
                    role="menuitem"
                    class="text-red-400"
                    disabled={!model.props.online || model.busy}
                    onClick={() => send({ type: 'Delete', topic })}
                  >
                    Delete topic
                  </button>
                ) : null}
                {model.canManage && topic.id === 1 ? (
                  <button
                    role="menuitem"
                    disabled={!model.props.online || model.busy}
                    onClick={() => send({ type: 'Hide', topic })}
                  >
                    {topic.hidden ? 'Show topic' : 'Hide topic'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {!model.busy && !model.topics.length ? (
          <p class="folder-help">{model.query ? 'No topics found.' : 'No topics yet.'}</p>
        ) : null}
        {model.offset ? (
          <button
            class="forum-load-more"
            disabled={model.busy}
            onClick={() => send({ type: 'Load', more: true })}
          >
            More topics
          </button>
        ) : null}
      </div>
      {model.deleting ? (
        <Dialog title="Delete Topic" onClose={() => send({ type: 'Delete', topic: undefined })}>
          <p class="folder-help">
            Delete “{model.deleting.title}” and all its messages for everyone? This cannot be
            undone.
          </p>
          {model.error ? (
            <p role="alert" class="folder-error">
              {model.error}
            </p>
          ) : null}
          <div class="folder-footer">
            <button
              class="secondary-button"
              disabled={model.busy}
              onClick={() => send({ type: 'Delete', topic: undefined })}
            >
              Cancel
            </button>
            <button
              class="primary-button danger-button"
              disabled={model.busy || !model.props.online}
              onClick={() => send({ type: 'ConfirmDelete' })}
            >
              Delete Topic
            </button>
          </div>
        </Dialog>
      ) : null}
      {model.editing ? (
        <Dialog
          title={model.editing === 'new' ? 'New Topic' : 'Edit Topic'}
          onClose={() => send({ type: 'Edit', topic: undefined })}
        >
          <label class="folder-field">
            Topic name
            <input
              aria-label="Topic name"
              maxlength={128}
              autofocus
              value={model.title}
              onInput={(event) => send({ type: 'Title', value: event.currentTarget.value })}
            />
          </label>
          {model.editing === 'new' ? (
            <div class="forum-colors" aria-label="Topic color">
              {list(colors, (color) => (
                <button
                  class="forum-color"
                  aria-label={`Color ${color.toString(16)}`}
                  aria-pressed={model.color === color}
                  style={{ background: `#${color.toString(16)}` }}
                  onClick={() => send({ type: 'Color', value: color })}
                />
              ))}
            </div>
          ) : null}
          {model.error ? (
            <p role="alert" class="folder-error">
              {model.error}
            </p>
          ) : null}
          <div class="folder-footer">
            <button
              class="primary-button"
              disabled={model.busy || !model.props.online || !model.title.trim()}
              onClick={() => send({ type: 'Save' })}
            >
              {model.editing === 'new' ? 'Create' : 'Save'}
            </button>
          </div>
        </Dialog>
      ) : null}
    </aside>
  )),
);
