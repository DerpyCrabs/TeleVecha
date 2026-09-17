import { list as renderList } from 'effectweb';
import { commandSlot } from 'effectweb';
import type { Snapshot } from 'effectweb';
import { effectCommand } from 'effectweb/program';
import { cachedLoad } from 'effectweb/load';
import { Effect } from 'effect';
import type { ChatSummary } from '../../domain/models';
import type { TelegramDialog, TelegramPeerSearchResult } from '../../telegram/types';
import type { SidebarLayout } from '../app/sidebarLayout';
import { idRows, remotePeerRows } from '../collections';
import Archive from '@effectweb/lucide/icons/archive';
import ArchiveRestore from '@effectweb/lucide/icons/archive-restore';
import ArrowLeft from '@effectweb/lucide/icons/arrow-left';
import Ban from '@effectweb/lucide/icons/ban';
import BellOff from '@effectweb/lucide/icons/bell-off';
import Check from '@effectweb/lucide/icons/check';
import CheckCheck from '@effectweb/lucide/icons/check-check';
import Pin from '@effectweb/lucide/icons/pin';
import PinOff from '@effectweb/lucide/icons/pin-off';
import Search from '@effectweb/lucide/icons/search';
import Settings from '@effectweb/lucide/icons/settings';
import Trash2 from '@effectweb/lucide/icons/trash-2';
import type { MediaAssets } from '../media/mediaAssets';
import type { Command, CommandSlot } from 'effectweb';
import { component, domBinding, sequence, view } from 'effectweb';
import type { Send, Transition } from 'effectweb/program';
import { loadEffect } from 'effectweb/cache';
import { Avatar } from '../shared/Avatar';
import type { ChatDirectory } from './chatDirectory';
import { describeUnreadCount, formatUnreadCount, normalizeUnreadCount } from './unreadCount';
const commandPeers = commandSlot('peers');
const commandContextUser = commandSlot('context-user');

type ChatFilter = 'all' | 'unread' | 'groups' | 'archived';
const CHAT_ROW_HEIGHT = 64;
const CHAT_LIST_OVERSCAN = 8;
const CHAT_LIST_VIRTUALIZATION_THRESHOLD = 120;
interface UnreadBadgeProps {
  count: number;
  muted?: boolean | undefined;
  compact?: boolean | undefined;
}
const UnreadBadge = view<UnreadBadgeProps, never>((props, _send) => {
  const count = () => normalizeUnreadCount(props.count);
  return count() > 0 ? (
    <span
      class="chat-unread-badge grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-accent px-1.5 text-[10px] leading-none font-bold text-white"
      classList={{
        'chat-unread-badge-compact': Boolean(props.compact),
        'chat-unread-badge-trailing': !props.compact,
        muted: Boolean(props.muted),
        'absolute top-[0.2rem] right-[0.2rem] z-[2] h-6 min-w-6 border-2 border-panel px-[0.3rem] text-xs':
          Boolean(props.compact),
        'bg-[#626873]': Boolean(props.muted),
      }}
      aria-hidden="true"
      title={describeUnreadCount(count())}
    >
      {formatUnreadCount(count())}
    </span>
  ) : null;
});
const MutedIcon = view<Record<string, never>, never>((_props, _send) => {
  return <BellOff size={12} class="chat-muted-icon size-3 shrink-0" aria-label="Muted" />;
});
interface ChatSidebarProps {
  chats: ChatSummary[];
  dialogs: TelegramDialog[];
  activeChatId: string;
  online: boolean;
  layout: SidebarLayout;
  media: MediaAssets;
  directory: ChatDirectory;
  requestDelete: (peerId: string) => void;
  openSettings: () => void;
}
type ContextUser = NonNullable<ReturnType<ChatDirectory['cachedDetails']>>;
type ChatSidebarModel = {
  peers: TelegramPeerSearchResult[];
  peersLoading: boolean;
  peersError: boolean;
  searchKey: string;
  contextUser: ContextUser | undefined;
  contextUserKey: string;
  props: ChatSidebarProps;
  query: string;
  filter: ChatFilter;
  listScrollTop: number;
  listViewportHeight: number;
  contextMenu: { chatId: string; x: number; y: number } | undefined;
};
type ChatSidebarMessage =
  | { type: 'RetrySearch' }
  | { type: 'Peers'; values: TelegramPeerSearchResult[]; error: boolean }
  | { type: 'ContextUser'; value: ContextUser | undefined }
  | { type: 'Query'; value: string }
  | { type: 'Filter'; value: ChatFilter }
  | { type: 'ListScrollTop'; value: number }
  | { type: 'ListViewportHeight'; value: number }
  | { type: 'ContextMenu'; value: { chatId: string; x: number; y: number } | undefined };
function refreshSidebar(
  model: Snapshot<ChatSidebarModel>,
  retry: boolean = false,
): Transition<ChatSidebarModel, ChatSidebarMessage> {
  const term = model.query.trim();
  const searchKey =
    term && model.filter !== 'archived' && model.filter !== 'unread'
      ? `${model.props.online}:${term}`
      : '';
  const userKey =
    model.contextMenu?.chatId &&
    model.props.chats.some((chat) => chat.id === model.contextMenu?.chatId && chat.kind === 'user')
      ? model.contextMenu.chatId
      : '';
  const commands: Command<ChatSidebarMessage>[] = [],
    cancel: CommandSlot[] = [];
  let next = model;
  if (retry || searchKey !== model.searchKey) {
    next = { ...next, searchKey, peers: [], peersError: false, peersLoading: Boolean(searchKey) };
    if (!searchKey) cancel.push(commandPeers);
    else
      commands.push(
        effectCommand(
          commandPeers,
          () =>
            Effect.sleep(retry ? 0 : 250).pipe(
              Effect.andThen(loadEffect(() => model.props.directory.search(term))),
            ),
          {
            policy: 'replace',
            onSuccess: (values) => ({ type: 'Peers', values, error: false }) as const,
            onFailure: () => ({ type: 'Peers', values: [], error: true }) as const,
          },
        ),
      );
  }
  if (userKey !== model.contextUserKey) {
    next = { ...next, contextUserKey: userKey, contextUser: undefined };
    if (!userKey) cancel.push(commandContextUser);
    else
      commands.push(
        effectCommand(
          commandContextUser,
          () =>
            cachedLoad(
              () => model.props.directory.cachedDetails(userKey),
              () => model.props.directory.details(userKey),
            ),
          {
            policy: 'replace',
            onSuccess: (value) => ({ type: 'ContextUser', value }) as const,
            onFailure: () => ({ type: 'ContextUser', value: undefined }) as const,
          },
        ),
      );
  }
  return { model: next, commands, cancel };
}
function menuPosition(x: number, y: number, height: number) {
  return { x: Math.min(x, window.innerWidth - 190), y: Math.min(y, window.innerHeight - height) };
}
const chatHref = (peerId: string) => `?chat=${encodeURIComponent(peerId)}`;
function scrollFilters(event: WheelEvent & { currentTarget: HTMLElement }) {
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;
  const before = event.currentTarget.scrollLeft;
  event.currentTarget.scrollLeft += delta;
  if (event.currentTarget.scrollLeft !== before) event.preventDefault();
}
interface ListInput {
  query: string;
  filter: ChatFilter;
  activeChatId: string;
  filtered: ChatSummary[];
  send: Send<ChatSidebarMessage>;
}
function acquireList(element: HTMLDivElement, input: () => Snapshot<ListInput>) {
  let previousQuery: string | undefined,
    previousFilter: ChatFilter | undefined,
    previousPeer: string | undefined;
  let disposed = false,
    generation = 0;
  const resize = () =>
    input().send({ type: 'ListViewportHeight', value: element.clientHeight || 640 });
  const observer = new ResizeObserver(resize);
  observer.observe(element);
  resize();
  const dismiss = (event: PointerEvent) => {
    if (!(event.target as Element).closest?.('.chat-context-menu'))
      input().send({ type: 'ContextMenu', value: undefined });
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') input().send({ type: 'ContextMenu', value: undefined });
  };
  document.addEventListener('pointerdown', dismiss);
  document.addEventListener('keydown', escape);
  const update = () => {
    const data = input(),
      reset = data.query !== previousQuery || data.filter !== previousFilter,
      select = data.activeChatId !== previousPeer;
    previousQuery = data.query;
    previousFilter = data.filter;
    previousPeer = data.activeChatId;
    if (!reset && !select) return;
    const token = ++generation;
    queueMicrotask(() => {
      if (disposed || token !== generation) return;
      const data = input();
      if (reset) {
        element.scrollTop = 0;
        data.send({ type: 'ListScrollTop', value: 0 });
      }
      if (!select || !data.activeChatId) return;
      const index = data.filtered.findIndex((chat) => chat.id === data.activeChatId);
      if (index < 0) return;
      const rendered = element.querySelector<HTMLElement>(
        `.chat-row[aria-posinset="${index + 1}"]`,
      );
      if (rendered) rendered.scrollIntoView({ block: 'nearest' });
      else {
        element.scrollTop = Math.max(
          0,
          index * CHAT_ROW_HEIGHT - Math.max(0, (element.clientHeight - CHAT_ROW_HEIGHT) / 2),
        );
        data.send({ type: 'ListScrollTop', value: element.scrollTop });
      }
    });
  };
  update();
  return {
    update,
    dispose: () => {
      disposed = true;
      generation++;
      observer.disconnect();
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    },
  };
}
const listMount = (input: ListInput) => domBinding(input, acquireList);
export const ChatSidebar = component<ChatSidebarProps, ChatSidebarModel, ChatSidebarMessage>({
  init: (props) => ({
    props,
    peers: [],
    peersLoading: false,
    peersError: false,
    searchKey: '',
    contextUser: undefined,
    contextUserKey: '',
    query: '',
    filter: 'all',
    listScrollTop: 0,
    listViewportHeight: 640,
    contextMenu: undefined,
  }),
  receive: (model, props) =>
    refreshSidebar({
      ...model,
      props,
      contextMenu: props.activeChatId !== model.props.activeChatId ? undefined : model.contextMenu,
    }),
  update: (model, message) => {
    switch (message.type) {
      case 'RetrySearch':
        return refreshSidebar(model, true);
      case 'Peers':
        return {
          model: {
            ...model,
            peers: message.values,
            peersError: message.error,
            peersLoading: false,
          },
        };
      case 'ContextUser':
        return { model: { ...model, contextUser: message.value } };
      case 'Query':
        return refreshSidebar({ ...model, query: message.value, listScrollTop: 0 });
      case 'Filter':
        return refreshSidebar({ ...model, filter: message.value, listScrollTop: 0 });
      case 'ListScrollTop':
        return { model: { ...model, listScrollTop: message.value } };
      case 'ListViewportHeight':
        return { model: { ...model, listViewportHeight: message.value } };
      case 'ContextMenu':
        return refreshSidebar({ ...model, contextMenu: message.value });
    }
  },
  view: view((model, send) => {
    const props = model.props;
    const runInBackground = (task: Promise<unknown>) => {
      void task.catch(() => undefined);
    };
    const compact = () => props.layout.compact && !props.layout.mobileOpen;
    const archiveOpen = () => model.filter === 'archived';
    const peerResults = () => model.peers;
    const searchingPeers = () => model.peersLoading;
    const peerSearchFailed = () => model.peersError;
    const contextUser = () =>
      props.dialogs.find((dialog) => dialog.peer.id === model.contextMenu?.chatId)?.userDetails ??
      model.contextUser;
    const peerResource = { refetch: () => send({ type: 'RetrySearch' }) };
    const archivedChats = (() => props.chats.filter((chat) => chat.archived))();
    const archivedUnreadCount = (() =>
      archivedChats.reduce((total, chat) => total + normalizeUnreadCount(chat.unread), 0))();
    const archivedUnreadMuted = (() =>
      archivedUnreadCount > 0 && !archivedChats.some((chat) => chat.unread > 0 && !chat.muted))();
    const filteredChats = (() => {
      const term = model.query.trim().toLocaleLowerCase();
      return props.chats.filter((chat) => {
        const matchesQuery =
          !term ||
          `${chat.title} ${chat.username ?? ''} ${chat.preview}`.toLocaleLowerCase().includes(term);
        const matchesArchive = archiveOpen() ? Boolean(chat.archived) : !chat.archived;
        const matchesFilter =
          model.filter === 'all' ||
          (model.filter === 'unread' && chat.unread > 0) ||
          (model.filter === 'groups' && chat.kind === 'group') ||
          model.filter === 'archived';
        return matchesQuery && matchesArchive && matchesFilter;
      });
    })();
    const visiblePeerResults = (() => {
      const localIds = new Set(filteredChats.map(({ id }) => id));
      return peerResults().filter(
        (result) =>
          !localIds.has(result.peer.id) &&
          model.filter !== 'unread' &&
          (model.filter !== 'groups' || result.category === 'group'),
      );
    })();
    const virtualRange = (() => {
      const count = filteredChats.length;
      if (count <= CHAT_LIST_VIRTUALIZATION_THRESHOLD) return { start: 0, end: count };
      const start = Math.max(
        0,
        Math.floor(model.listScrollTop / CHAT_ROW_HEIGHT) - CHAT_LIST_OVERSCAN,
      );
      const visibleCount = Math.ceil(model.listViewportHeight / CHAT_ROW_HEIGHT);
      return { start, end: Math.min(count, start + visibleCount + CHAT_LIST_OVERSCAN * 2) };
    })();
    const virtualChats = (() => {
      const { start, end } = virtualRange;
      return filteredChats.slice(start, end);
    })();
    return (
      <aside
        class="chat-sidebar relative flex min-h-0 min-w-0 flex-col border-r border-line bg-panel"
        classList={{ compact: compact(), 'mobile-open': props.layout.mobileOpen }}
        data-testid="chat-sidebar"
        data-compact={compact() ? 'true' : 'false'}
        role={props.layout.mobileOpen && props.layout.viewportWidth <= 650 ? 'dialog' : undefined}
        aria-modal={
          props.layout.mobileOpen && props.layout.viewportWidth <= 650 ? 'true' : undefined
        }
        aria-label={
          props.layout.mobileOpen && props.layout.viewportWidth <= 650 ? 'Chat list' : undefined
        }
        tabIndex={props.layout.mobileOpen && props.layout.viewportWidth <= 650 ? -1 : undefined}
      >
        <header
          class="sidebar-header flex h-[3.6rem] items-center gap-3 px-4"
          classList={{
            hidden: compact() && !archiveOpen(),
            '!justify-center !px-0': compact() && archiveOpen(),
          }}
        >
          {compact() && archiveOpen() ? (
            <button
              class="icon-button shrink-0"
              aria-label="Back to chats"
              onClick={() => {
                send({ type: 'Filter', value: 'all' });
                send({ type: 'Query', value: '' });
              }}
            >
              <ArrowLeft size={18} />
            </button>
          ) : null}
          <label
            class="flex min-w-0 flex-1 items-center gap-2 rounded-[0.65rem] border border-transparent bg-surface px-3 py-2 text-muted focus-within:border-[color-mix(in_srgb,var(--accent)_60%,transparent)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)] [&>input]:min-w-0 [&>input]:flex-1 [&>input]:border-0 [&>input]:bg-transparent [&>input]:text-[0.82rem] [&>input]:text-ink [&>input]:outline-0"
            classList={{ hidden: compact() && archiveOpen() }}
          >
            <Search size={16} />
            <input
              value={model.query}
              onInput={(event) => send({ type: 'Query', value: event.currentTarget.value })}
              placeholder={archiveOpen() ? 'Search archived chats' : 'Search chats and people'}
              aria-label="Search chats"
            />
          </label>
        </header>

        <div
          class="chat-filters flex items-center gap-2 overflow-x-auto px-4 pb-3 text-xs font-medium text-muted"
          classList={{ hidden: compact() }}
          onWheel={scrollFilters}
        >
          {renderList(sequence(['all', 'unread', 'groups', 'archived'] as const), (value) => (
            <button
              class="shrink-0 rounded-full px-3 py-1.5"
              classList={{
                'bg-[var(--accent-soft)] text-[var(--accent)]': model.filter === value,
                'hover:bg-white/5': model.filter !== value,
              }}
              aria-pressed={model.filter === value}
              onClick={() => send({ type: 'Filter', value: value })}
            >
              {value === 'all'
                ? 'All'
                : value === 'unread'
                  ? 'Unread'
                  : value === 'groups'
                    ? 'Groups'
                    : 'Archived'}
            </button>
          ))}
        </div>

        {compact() && model.filter === 'all' && archivedChats.length > 0 ? (
          <button
            class="chat-row archived-chats-row relative flex h-16 w-full items-center justify-center border-0 bg-transparent py-[0.55rem] text-inherit transition duration-100 hover:bg-[var(--surface-subtle)]"
            aria-label={`Archived chats, ${archivedChats.length} ${archivedChats.length === 1 ? 'chat' : 'chats'}${archivedUnreadCount > 0 ? `, ${describeUnreadCount(archivedUnreadCount)}` : ''}`}
            onClick={() => {
              send({ type: 'Filter', value: 'archived' });
              send({ type: 'ContextMenu', value: undefined });
            }}
          >
            <div class="grid size-[2.65rem] shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--accent)_82%,#26303b)] text-white">
              <Archive size={19} />
            </div>
            <UnreadBadge count={archivedUnreadCount} muted={archivedUnreadMuted} compact />
          </button>
        ) : null}

        <div
          use={listMount({
            query: model.query,
            filter: model.filter,
            activeChatId: props.activeChatId,
            filtered: filteredChats,
            send,
          })}
          class="scroll-area min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          classList={{ '!px-0 pt-2': compact() }}
          data-testid="chat-list"
          onScroll={(event) => {
            send({ type: 'ListScrollTop', value: event.currentTarget.scrollTop });
            send({ type: 'ContextMenu', value: undefined });
          }}
        >
          {virtualRange.start > 0 ? (
            <div
              aria-hidden="true"
              style={{ height: `${virtualRange.start * CHAT_ROW_HEIGHT}px` }}
            />
          ) : null}
          {renderList(idRows(virtualChats), (chat, virtualIndex) => (
            <a
              href={chatHref(chat.id)}
              draggable={false}
              role="button"
              class="chat-row relative flex h-16 w-full items-center gap-3 rounded-[0.55rem] border-0 bg-transparent px-[0.65rem] py-2.5 text-inherit transition duration-100 hover:bg-[var(--surface-subtle)]"
              classList={{
                active: chat.id === props.activeChatId,
                '!bg-[var(--dialog-selected)] text-white [--muted:rgb(255_255_255/0.85)]':
                  chat.id === props.activeChatId,
                '!justify-center !gap-0 !rounded-none !px-0 !py-[0.55rem]': compact(),
              }}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                send({ type: 'ContextMenu', value: undefined });
                runInBackground(props.directory.select(chat.id));
                props.layout.setMobileOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== ' ') return;
                event.preventDefault();
                send({ type: 'ContextMenu', value: undefined });
                runInBackground(props.directory.select(chat.id));
                props.layout.setMobileOpen(false);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                const menu = {
                  chatId: chat.id,
                  ...menuPosition(event.clientX, event.clientY, chat.kind === 'user' ? 245 : 205),
                };
                send({ type: 'ContextMenu', value: menu });
              }}
              aria-label={`${chat.title}, ${chat.preview}${chat.lastMessageStatus ? `, last message ${chat.lastMessageStatus}` : ''}${normalizeUnreadCount(chat.unread) > 0 ? `, ${describeUnreadCount(chat.unread)}` : ''}${chat.muted ? ', muted' : ''}`}
              aria-current={chat.id === props.activeChatId ? 'true' : undefined}
              aria-posinset={virtualRange.start + virtualIndex + 1}
              aria-setsize={filteredChats.length}
            >
              <Avatar
                identity={`${chat.id}:${props.dialogs.find((dialog) => dialog.peer.id === chat.id)?.avatarId ?? 'none'}`}
                initials={chat.initials}
                color={chat.color}
                online={chat.presence === 'online'}
                loadCached={() => props.media.loadAvatar(chat.id, true)}
                load={props.online ? () => props.media.loadAvatar(chat.id) : undefined}
              />
              {compact() ? <UnreadBadge count={chat.unread} muted={chat.muted} compact /> : null}
              <span class="min-w-0 flex-1 text-left" classList={{ hidden: compact() }}>
                <span class="flex items-baseline justify-between gap-3">
                  <span class="truncate text-[14px] font-semibold">{chat.title}</span>
                  <span class="shrink-0 text-[11px] text-[var(--muted)]">{chat.time}</span>
                </span>
                <span class="mt-1 flex min-w-0 items-center gap-1 text-[var(--muted)]">
                  {chat.lastMessageStatus === 'sent' ? (
                    <Check
                      size={14}
                      class="chat-delivery-status size-3.5 shrink-0"
                      aria-label="Last message sent"
                    />
                  ) : null}
                  {chat.lastMessageStatus === 'read' ? (
                    <CheckCheck
                      size={14}
                      class="chat-delivery-status size-3.5 shrink-0 text-accent"
                      aria-label="Last message read"
                    />
                  ) : null}
                  <span class="min-w-0 flex-1 truncate text-[13px]">{chat.preview}</span>
                  <span class="ml-auto flex shrink-0 items-center gap-1.5">
                    {chat.muted ? <MutedIcon /> : null}
                    <UnreadBadge count={chat.unread} muted={chat.muted} />
                  </span>
                </span>
              </span>
            </a>
          ))}
          {virtualRange.end < filteredChats.length ? (
            <div
              aria-hidden="true"
              style={{ height: `${(filteredChats.length - virtualRange.end) * CHAT_ROW_HEIGHT}px` }}
            />
          ) : null}
          {visiblePeerResults.length > 0 ? (
            <>
              <p class="mx-[0.7rem] mt-3 mb-1 text-xs font-bold tracking-[0.04em] text-accent uppercase">
                Telegram
              </p>
              {renderList(remotePeerRows(visiblePeerResults), (result) => (
                <button
                  class="chat-row relative flex h-16 w-full items-center gap-3 rounded-[0.55rem] border-0 bg-transparent px-[0.65rem] py-2.5 text-inherit transition duration-100 hover:bg-[var(--surface-subtle)]"
                  classList={{
                    '!justify-center !gap-0 !rounded-none !px-0 !py-[0.55rem]': compact(),
                  }}
                  data-testid="peer-search-result"
                  aria-label={`${result.title}, ${result.category}`}
                  onClick={() => {
                    send({ type: 'Query', value: '' });
                    runInBackground(props.directory.open(result));
                    props.layout.setMobileOpen(false);
                  }}
                >
                  <Avatar
                    identity={`search:${result.peer.id}:${result.avatarId ?? 'none'}`}
                    initials={result.initials}
                    color={result.color}
                    loadCached={
                      result.hasAvatar
                        ? () =>
                            props.media.loadPeerAvatar(
                              result.peer,
                              result.hasAvatar,
                              result.avatarId,
                              true,
                            )
                        : undefined
                    }
                    load={
                      props.online && result.hasAvatar
                        ? () =>
                            props.media.loadPeerAvatar(
                              result.peer,
                              result.hasAvatar,
                              result.avatarId,
                            )
                        : undefined
                    }
                  />
                  <span class="min-w-0 flex-1 text-left" classList={{ hidden: compact() }}>
                    <span class="block truncate text-[14px] font-semibold">{result.title}</span>
                    <span class="mt-1 block truncate text-[13px] text-[var(--muted)]">
                      {result.username ? `@${result.username} · ` : ''}
                      {result.category === 'bot'
                        ? 'Bot'
                        : result.isContact
                          ? 'Contact'
                          : result.category === 'channel'
                            ? 'Public channel'
                            : result.category === 'group'
                              ? 'Public group'
                              : 'Telegram user'}
                    </span>
                  </span>
                </button>
              ))}
            </>
          ) : null}
          {searchingPeers() ? (
            <p class="px-4 py-5 text-center text-sm text-[var(--muted)]">Searching Telegram…</p>
          ) : null}
          {peerSearchFailed() ? (
            <div class="px-4 py-5 text-center text-sm text-[var(--muted)]" role="alert">
              <p>Telegram search is unavailable. Try again.</p>
              <button onClick={() => peerResource.refetch()}>Retry search</button>
            </div>
          ) : null}
          {filteredChats.length === 0 &&
          visiblePeerResults.length === 0 &&
          !searchingPeers() &&
          !peerSearchFailed() ? (
            <p class="px-4 py-10 text-center text-sm text-[var(--muted)]">
              {archiveOpen() && !model.query.trim() ? 'No archived chats' : 'No chats found'}
            </p>
          ) : null}
          {model.contextMenu
            ? ((menu) => {
                const chat = () => props.chats.find(({ id }) => id === menu.chatId);
                return (
                  <div
                    class="chat-context-menu"
                    role="menu"
                    aria-label="Chat actions"
                    style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
                  >
                    <button
                      role="menuitem"
                      onClick={() => {
                        const selected = chat();
                        send({ type: 'ContextMenu', value: undefined });
                        if (selected)
                          runInBackground(props.directory.setMuted(selected.id, !selected.muted));
                      }}
                    >
                      <BellOff size={16} />
                      {chat()?.muted ? 'Unmute' : 'Mute'}
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        const selected = chat();
                        send({ type: 'ContextMenu', value: undefined });
                        if (selected)
                          runInBackground(props.directory.setPinned(selected.id, !selected.pinned));
                      }}
                    >
                      {chat()?.pinned ? <PinOff size={16} /> : <Pin size={16} />}
                      {chat()?.pinned ? 'Unpin chat' : 'Pin chat'}
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        const selected = chat();
                        send({ type: 'ContextMenu', value: undefined });
                        if (selected)
                          runInBackground(
                            props.directory.setArchived(selected.id, !selected.archived),
                          );
                      }}
                    >
                      {chat()?.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                      {chat()?.archived ? 'Unarchive chat' : 'Archive chat'}
                    </button>
                    {chat()?.kind === 'user' ? (
                      <button
                        role="menuitem"
                        disabled={!contextUser()}
                        onClick={() => {
                          const selected = chat();
                          const details = contextUser();
                          send({ type: 'ContextMenu', value: undefined });
                          if (selected && details)
                            runInBackground(
                              props.directory.setBlocked(selected.id, !details.blocked),
                            );
                        }}
                      >
                        <Ban size={16} />
                        {contextUser()
                          ? contextUser()!.blocked
                            ? 'Unblock user'
                            : 'Block user'
                          : 'Loading…'}
                      </button>
                    ) : null}
                    <button
                      class="danger"
                      role="menuitem"
                      onClick={() => {
                        const selected = chat();
                        send({ type: 'ContextMenu', value: undefined });
                        if (selected) props.requestDelete(selected.id);
                      }}
                    >
                      <Trash2 size={16} />
                      Delete chat
                    </button>
                  </div>
                );
              })(model.contextMenu!)
            : null}
        </div>
        <footer
          class="sidebar-settings-footer shrink-0 border-t border-line px-3 py-[0.55rem]"
          classList={{ '!px-0': compact() }}
        >
          <button
            class="flex min-h-11 w-full items-center gap-[0.65rem] rounded-[0.55rem] border-0 bg-transparent px-[0.7rem] py-[0.6rem] text-left text-muted hover:bg-[var(--surface-hover)] hover:text-ink"
            classList={{ '!justify-center !rounded-none !px-0': compact() }}
            onClick={props.openSettings}
            aria-label="Open settings"
          >
            <Settings size={18} />
            <span classList={{ hidden: compact() }}>Settings</span>
          </button>
        </footer>
        <div
          class="left-sidebar-resizer"
          role="separator"
          aria-label="Resize chat list"
          aria-orientation="vertical"
          aria-valuemin={72}
          aria-valuemax={props.layout.responsiveMaxWidth}
          aria-valuenow={props.layout.effectiveWidth}
          tabIndex={0}
          onPointerDown={props.layout.startResize}
          onKeyDown={props.layout.resizeWithKeyboard}
        />
      </aside>
    );
  }),
});
