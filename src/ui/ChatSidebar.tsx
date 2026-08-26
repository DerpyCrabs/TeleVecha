import BellOff from 'lucide-solid/icons/bell-off';
import Ban from 'lucide-solid/icons/ban';
import Archive from 'lucide-solid/icons/archive';
import ArchiveRestore from 'lucide-solid/icons/archive-restore';
import ArrowLeft from 'lucide-solid/icons/arrow-left';
import Pin from 'lucide-solid/icons/pin';
import PinOff from 'lucide-solid/icons/pin-off';
import Search from 'lucide-solid/icons/search';
import Settings from 'lucide-solid/icons/settings';
import Trash2 from 'lucide-solid/icons/trash-2';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';

import type { ChatSummary } from '../domain/models';
import type { TelegramPeerSearchResult, TelegramUserDetails } from '../telegram/types';
import { Avatar } from './Avatar';
import { describeUnreadCount, formatUnreadCount, normalizeUnreadCount } from './unreadCount';

type ChatFilter = 'all' | 'unread' | 'groups';

const CHAT_ROW_HEIGHT = 64;
const CHAT_LIST_OVERSCAN = 8;
const CHAT_LIST_VIRTUALIZATION_THRESHOLD = 120;

interface UnreadBadgeProps {
  count: number;
  muted?: boolean | undefined;
  compact?: boolean | undefined;
}

function UnreadBadge(props: UnreadBadgeProps) {
  const count = () => normalizeUnreadCount(props.count);
  return (
    <Show when={count() > 0}>
      <span
        class={`chat-unread-badge chat-unread-badge-${props.compact ? 'compact' : 'trailing'}`}
        classList={{ muted: Boolean(props.muted) }}
        aria-hidden="true"
        title={describeUnreadCount(count())}
      >
        {formatUnreadCount(count())}
      </span>
    </Show>
  );
}

interface ChatSidebarProps {
  chats: ChatSummary[];
  activeChatId: string;
  compact: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  online: boolean;
  mobileOpen: boolean;
  modal: boolean;
  avatarIdentity: (peerId: string) => string;
  loadCachedAvatar: (peerId: string) => Promise<string | undefined>;
  loadAvatar: (peerId: string) => Promise<string | undefined>;
  loadPeerAvatar: (
    result: TelegramPeerSearchResult,
    cachedOnly: boolean,
  ) => Promise<string | undefined>;
  select: (peerId: string) => void;
  searchPeers: (query: string) => Promise<TelegramPeerSearchResult[]>;
  openPeer: (result: TelegramPeerSearchResult) => void;
  setMuted: (peerId: string, muted: boolean) => void;
  getUserDetails: (peerId: string) => Promise<TelegramUserDetails>;
  setBlocked: (peerId: string, blocked: boolean) => void;
  setPinned: (peerId: string, pinned: boolean) => void;
  setArchived: (peerId: string, archived: boolean) => void;
  requestDelete: (peerId: string) => void;
  openSettings: () => void;
  closeMobile: () => void;
  startResize: (event: PointerEvent & { currentTarget: HTMLDivElement }) => void;
  resizeWithKeyboard: (event: KeyboardEvent) => void;
}

export function ChatSidebar(props: ChatSidebarProps) {
  const [query, setQuery] = createSignal('');
  const [filter, setFilter] = createSignal<ChatFilter>('all');
  const [archiveOpen, setArchiveOpen] = createSignal(false);
  const [peerResults, setPeerResults] = createSignal<TelegramPeerSearchResult[]>([]);
  const [searchingPeers, setSearchingPeers] = createSignal(false);
  const [peerSearchFailed, setPeerSearchFailed] = createSignal(false);
  const [listScrollTop, setListScrollTop] = createSignal(0);
  const [listViewportHeight, setListViewportHeight] = createSignal(640);
  const [contextMenu, setContextMenu] = createSignal<{
    chatId: string;
    x: number;
    y: number;
  }>();
  const [contextUser, setContextUser] = createSignal<TelegramUserDetails>();
  let peerSearchGeneration = 0;
  let chatListElement: HTMLDivElement | undefined;
  let observedActiveChatId = '';
  const archivedChats = createMemo(() => props.chats.filter((chat) => chat.archived));
  const archivedUnreadCount = createMemo(() =>
    archivedChats().reduce((total, chat) => total + normalizeUnreadCount(chat.unread), 0),
  );
  const archivedUnreadMuted = createMemo(
    () =>
      archivedUnreadCount() > 0 && !archivedChats().some((chat) => chat.unread > 0 && !chat.muted),
  );
  const filteredChats = createMemo(() => {
    const term = query().trim().toLocaleLowerCase();
    return props.chats.filter((chat) => {
      const matchesQuery =
        !term ||
        `${chat.title} ${chat.username ?? ''} ${chat.preview}`.toLocaleLowerCase().includes(term);
      const matchesArchive = archiveOpen() ? Boolean(chat.archived) : term ? true : !chat.archived;
      const matchesFilter =
        filter() === 'all' ||
        (filter() === 'unread' && chat.unread > 0) ||
        (filter() === 'groups' && chat.kind === 'group');
      return matchesQuery && matchesArchive && matchesFilter;
    });
  });
  const visiblePeerResults = createMemo(() => {
    const localIds = new Set(filteredChats().map(({ id }) => id));
    return peerResults().filter(
      (result) =>
        !localIds.has(result.peer.id) &&
        filter() !== 'unread' &&
        (filter() !== 'groups' || result.category === 'group'),
    );
  });
  const virtualRange = createMemo(() => {
    const count = filteredChats().length;
    if (count <= CHAT_LIST_VIRTUALIZATION_THRESHOLD) return { start: 0, end: count };
    const archiveOffset =
      !archiveOpen() && !query().trim() && filter() === 'all' && archivedChats().length > 0
        ? CHAT_ROW_HEIGHT
        : 0;
    const localScrollTop = Math.max(0, listScrollTop() - archiveOffset);
    const start = Math.max(0, Math.floor(localScrollTop / CHAT_ROW_HEIGHT) - CHAT_LIST_OVERSCAN);
    const visibleCount = Math.ceil(listViewportHeight() / CHAT_ROW_HEIGHT);
    return {
      start,
      end: Math.min(count, start + visibleCount + CHAT_LIST_OVERSCAN * 2),
    };
  });
  const virtualChats = createMemo(() => {
    const { start, end } = virtualRange();
    return filteredChats().slice(start, end);
  });

  createEffect(() => {
    void query();
    void filter();
    void archiveOpen();
    queueMicrotask(() => {
      if (!chatListElement) return;
      chatListElement.scrollTop = 0;
      setListScrollTop(0);
    });
  });

  createEffect(() => {
    const activeChatId = props.activeChatId;
    if (!activeChatId || activeChatId === observedActiveChatId) return;
    observedActiveChatId = activeChatId;
    const index = filteredChats().findIndex(({ id }) => id === activeChatId);
    if (index < 0) return;
    queueMicrotask(() => {
      if (!chatListElement) return;
      const rendered = chatListElement.querySelector<HTMLElement>(
        `.chat-row[aria-posinset="${index + 1}"]`,
      );
      if (rendered) {
        rendered.scrollIntoView({ block: 'nearest' });
        return;
      }
      const archiveOffset =
        !archiveOpen() && !query().trim() && filter() === 'all' && archivedChats().length > 0
          ? CHAT_ROW_HEIGHT
          : 0;
      const centeredTop =
        archiveOffset +
        index * CHAT_ROW_HEIGHT -
        Math.max(0, (chatListElement.clientHeight - CHAT_ROW_HEIGHT) / 2);
      chatListElement.scrollTop = Math.max(0, centeredTop);
      setListScrollTop(chatListElement.scrollTop);
    });
  });

  createEffect(() => {
    const term = query().trim();
    const generation = ++peerSearchGeneration;
    setPeerResults([]);
    setPeerSearchFailed(false);
    if (!term || !props.online || archiveOpen() || filter() === 'unread') {
      setSearchingPeers(false);
      return;
    }
    setSearchingPeers(true);
    const timer = window.setTimeout(() => {
      void props.searchPeers(term).then(
        (results) => {
          if (generation !== peerSearchGeneration) return;
          setPeerResults(results);
          setSearchingPeers(false);
        },
        () => {
          if (generation !== peerSearchGeneration) return;
          setPeerSearchFailed(true);
          setSearchingPeers(false);
        },
      );
    }, 250);
    onCleanup(() => {
      window.clearTimeout(timer);
      if (generation === peerSearchGeneration) peerSearchGeneration += 1;
    });
  });

  onMount(() => {
    const listResizeObserver = chatListElement
      ? new ResizeObserver(() => setListViewportHeight(chatListElement?.clientHeight ?? 640))
      : undefined;
    if (chatListElement) {
      setListViewportHeight(chatListElement.clientHeight || 640);
      listResizeObserver?.observe(chatListElement);
    }
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element).closest?.('.chat-context-menu')) setContextMenu(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(undefined);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    onCleanup(() => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
      listResizeObserver?.disconnect();
    });
  });

  return (
    <aside
      class="chat-sidebar relative flex min-h-0 min-w-0 flex-col border-r border-[var(--line)] bg-[var(--panel)]"
      classList={{
        compact: props.compact,
        'mobile-open': props.mobileOpen,
        'archive-open': archiveOpen(),
      }}
      data-testid="chat-sidebar"
      data-compact={props.compact ? 'true' : 'false'}
      role={props.modal ? 'dialog' : undefined}
      aria-modal={props.modal ? 'true' : undefined}
      aria-label={props.modal ? 'Chat list' : undefined}
      tabIndex={props.modal ? -1 : undefined}
    >
      <header class="sidebar-header flex h-16 items-center gap-3 px-4">
        <Show when={archiveOpen()}>
          <button
            class="icon-button shrink-0"
            aria-label="Back to chats"
            onClick={() => {
              setArchiveOpen(false);
              setQuery('');
            }}
          >
            <ArrowLeft size={18} />
          </button>
        </Show>
        <label class="search-box">
          <Search size={16} />
          <input
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder={archiveOpen() ? 'Search archived chats' : 'Search chats and people'}
            aria-label="Search chats"
          />
        </label>
      </header>

      <div class="chat-filters flex items-center gap-2 px-4 pb-3 text-xs font-medium text-[var(--muted)]">
        <For each={['all', 'unread', 'groups'] as const}>
          {(value) => (
            <button
              class="rounded-full px-3 py-1.5"
              classList={{
                'bg-[var(--accent-soft)] text-[var(--accent)]': filter() === value,
                'hover:bg-white/5': filter() !== value,
              }}
              aria-pressed={filter() === value}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? 'All' : value === 'unread' ? 'Unread' : 'Groups'}
            </button>
          )}
        </For>
      </div>

      <div
        ref={(element) => (chatListElement = element)}
        class="scroll-area min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3"
        data-testid="chat-list"
        onScroll={(event) => {
          setListScrollTop(event.currentTarget.scrollTop);
          setContextMenu(undefined);
        }}
      >
        <Show
          when={
            !archiveOpen() && !query().trim() && filter() === 'all' && archivedChats().length > 0
          }
        >
          <button
            class="chat-row archived-chats-row"
            aria-label={`Archived chats, ${archivedChats().length} ${
              archivedChats().length === 1 ? 'chat' : 'chats'
            }${archivedUnreadCount() > 0 ? `, ${describeUnreadCount(archivedUnreadCount())}` : ''}`}
            onClick={() => {
              setArchiveOpen(true);
              setContextMenu(undefined);
            }}
          >
            <div class="archive-avatar">
              <Archive size={19} />
            </div>
            <UnreadBadge count={archivedUnreadCount()} muted={archivedUnreadMuted()} compact />
            <span class="min-w-0 flex-1 text-left">
              <span class="block text-[14px] font-semibold">Archived chats</span>
              <span class="mt-1 block truncate text-[13px] text-[var(--muted)]">
                {archivedChats().length} {archivedChats().length === 1 ? 'chat' : 'chats'}
              </span>
            </span>
            <UnreadBadge count={archivedUnreadCount()} muted={archivedUnreadMuted()} />
          </button>
        </Show>
        <Show when={virtualRange().start > 0}>
          <div
            aria-hidden="true"
            style={{ height: `${virtualRange().start * CHAT_ROW_HEIGHT}px` }}
          />
        </Show>
        <For each={virtualChats()}>
          {(chat, virtualIndex) => (
            <button
              class={`chat-row ${chat.id === props.activeChatId ? 'active' : ''}`}
              onClick={() => {
                setContextMenu(undefined);
                props.select(chat.id);
                props.closeMobile();
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                const menu = {
                  chatId: chat.id,
                  x: Math.min(event.clientX, window.innerWidth - 190),
                  y: Math.min(
                    event.clientY,
                    window.innerHeight - (chat.kind === 'user' ? 245 : 205),
                  ),
                };
                setContextUser(undefined);
                setContextMenu(menu);
                if (chat.kind === 'user') {
                  void props
                    .getUserDetails(chat.id)
                    .then((details) => {
                      if (contextMenu()?.chatId === chat.id) setContextUser(details);
                    })
                    .catch(() => undefined);
                }
              }}
              aria-label={`${chat.title}, ${chat.preview}${
                normalizeUnreadCount(chat.unread) > 0 ? `, ${describeUnreadCount(chat.unread)}` : ''
              }${chat.muted ? ', muted' : ''}`}
              aria-current={chat.id === props.activeChatId ? 'true' : undefined}
              aria-posinset={virtualRange().start + virtualIndex() + 1}
              aria-setsize={filteredChats().length}
            >
              <Avatar
                identity={props.avatarIdentity(chat.id)}
                initials={chat.initials}
                color={chat.color}
                online={chat.presence === 'online'}
                loadCached={() => props.loadCachedAvatar(chat.id)}
                load={props.online ? () => props.loadAvatar(chat.id) : undefined}
              />
              <UnreadBadge count={chat.unread} muted={chat.muted} compact />
              <span class="min-w-0 flex-1 text-left">
                <span class="flex items-baseline justify-between gap-3">
                  <span class="truncate text-[14px] font-semibold">{chat.title}</span>
                  <span class="shrink-0 text-[11px] text-[var(--muted)]">{chat.time}</span>
                </span>
                <span class="mt-1 flex items-center justify-between gap-2">
                  <span class="truncate text-[13px] text-[var(--muted)]">{chat.preview}</span>
                  <Show
                    when={chat.unread > 0}
                    fallback={chat.muted ? <BellOff size={12} class="text-[var(--muted)]" /> : null}
                  >
                    <UnreadBadge count={chat.unread} muted={chat.muted} />
                  </Show>
                </span>
              </span>
            </button>
          )}
        </For>
        <Show when={virtualRange().end < filteredChats().length}>
          <div
            aria-hidden="true"
            style={{
              height: `${(filteredChats().length - virtualRange().end) * CHAT_ROW_HEIGHT}px`,
            }}
          />
        </Show>
        <Show when={visiblePeerResults().length > 0}>
          <p class="sidebar-list-heading">Telegram</p>
          <For each={visiblePeerResults()}>
            {(result) => (
              <button
                class="chat-row"
                data-testid="peer-search-result"
                aria-label={`${result.title}, ${result.category}`}
                onClick={() => {
                  setQuery('');
                  setArchiveOpen(false);
                  props.openPeer(result);
                  props.closeMobile();
                }}
              >
                <Avatar
                  identity={`search:${result.peer.id}:${result.avatarId ?? 'none'}`}
                  initials={result.initials}
                  color={result.color}
                  loadCached={
                    result.hasAvatar ? () => props.loadPeerAvatar(result, true) : undefined
                  }
                  load={
                    props.online && result.hasAvatar
                      ? () => props.loadPeerAvatar(result, false)
                      : undefined
                  }
                />
                <span class="min-w-0 flex-1 text-left">
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
            )}
          </For>
        </Show>
        <Show when={searchingPeers()}>
          <p class="px-4 py-5 text-center text-sm text-[var(--muted)]">Searching Telegram…</p>
        </Show>
        <Show when={peerSearchFailed()}>
          <p class="px-4 py-5 text-center text-sm text-[var(--muted)]">
            Telegram search is unavailable. Try again.
          </p>
        </Show>
        <Show
          when={
            filteredChats().length === 0 &&
            visiblePeerResults().length === 0 &&
            !searchingPeers() &&
            !peerSearchFailed()
          }
        >
          <p class="px-4 py-10 text-center text-sm text-[var(--muted)]">
            {archiveOpen() && !query().trim() ? 'No archived chats' : 'No chats found'}
          </p>
        </Show>
        <Show when={contextMenu()}>
          {(menu) => {
            const chat = () => props.chats.find(({ id }) => id === menu().chatId);
            return (
              <div
                class="chat-context-menu"
                role="menu"
                aria-label="Chat actions"
                style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    const selected = chat();
                    setContextMenu(undefined);
                    if (selected) props.setMuted(selected.id, !selected.muted);
                  }}
                >
                  <BellOff size={16} />
                  {chat()?.muted ? 'Unmute' : 'Mute'}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    const selected = chat();
                    setContextMenu(undefined);
                    if (selected) props.setPinned(selected.id, !selected.pinned);
                  }}
                >
                  {chat()?.pinned ? <PinOff size={16} /> : <Pin size={16} />}
                  {chat()?.pinned ? 'Unpin chat' : 'Pin chat'}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    const selected = chat();
                    setContextMenu(undefined);
                    if (selected) props.setArchived(selected.id, !selected.archived);
                  }}
                >
                  {chat()?.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                  {chat()?.archived ? 'Unarchive chat' : 'Archive chat'}
                </button>
                <Show when={chat()?.kind === 'user'}>
                  <button
                    role="menuitem"
                    disabled={!contextUser()}
                    onClick={() => {
                      const selected = chat();
                      const details = contextUser();
                      setContextMenu(undefined);
                      if (selected && details) props.setBlocked(selected.id, !details.blocked);
                    }}
                  >
                    <Ban size={16} />
                    {contextUser()
                      ? contextUser()!.blocked
                        ? 'Unblock user'
                        : 'Block user'
                      : 'Loading…'}
                  </button>
                </Show>
                <button
                  class="danger"
                  role="menuitem"
                  onClick={() => {
                    const selected = chat();
                    setContextMenu(undefined);
                    if (selected) props.requestDelete(selected.id);
                  }}
                >
                  <Trash2 size={16} />
                  Delete chat
                </button>
              </div>
            );
          }}
        </Show>
      </div>
      <footer class="sidebar-settings-footer">
        <button onClick={props.openSettings} aria-label="Open settings">
          <Settings size={18} />
          <span>Settings</span>
        </button>
      </footer>
      <div
        class="left-sidebar-resizer"
        role="separator"
        aria-label="Resize chat list"
        aria-orientation="vertical"
        aria-valuemin={props.minWidth}
        aria-valuemax={props.maxWidth}
        aria-valuenow={props.width}
        tabIndex={0}
        onPointerDown={props.startResize}
        onKeyDown={props.resizeWithKeyboard}
      />
    </aside>
  );
}
