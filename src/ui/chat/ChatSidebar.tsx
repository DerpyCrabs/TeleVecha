import BellOff from 'lucide-solid/icons/bell-off';
import Ban from 'lucide-solid/icons/ban';
import Archive from 'lucide-solid/icons/archive';
import ArchiveRestore from 'lucide-solid/icons/archive-restore';
import ArrowLeft from 'lucide-solid/icons/arrow-left';
import Check from 'lucide-solid/icons/check';
import CheckCheck from 'lucide-solid/icons/check-check';
import Pin from 'lucide-solid/icons/pin';
import PinOff from 'lucide-solid/icons/pin-off';
import Search from 'lucide-solid/icons/search';
import Settings from 'lucide-solid/icons/settings';
import Trash2 from 'lucide-solid/icons/trash-2';
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from 'solid-js';

import type { ChatSummary } from '../../domain/models';
import type { TelegramPeerSearchResult, TelegramUserDetails } from '../../telegram/types';
import type { SidebarLayout } from '../app/sidebarLayout';
import { MediaAssets } from '../media/mediaAssets';
import { Avatar } from '../shared/Avatar';
import { ChatDirectory } from './chatDirectory';
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
    </Show>
  );
}

function MutedIcon() {
  return <BellOff size={12} class="chat-muted-icon size-3 shrink-0" aria-label="Muted" />;
}

interface ChatSidebarProps {
  chats: ChatSummary[];
  activeChatId: string;
  online: boolean;
  layout: SidebarLayout;
  media: MediaAssets;
  directory: ChatDirectory;
  requestDelete: (peerId: string) => void;
  openSettings: () => void;
}

export function ChatSidebar(props: ChatSidebarProps) {
  const compact = () => props.layout.compact() && !props.layout.mobileOpen();
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
  const chatHref = (peerId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('chat', peerId);
    return `${url.pathname}${url.search}${url.hash}`;
  };
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

  createEffect(
    on(
      () => [query(), filter(), archiveOpen()] as const,
      () => {
        queueMicrotask(() => {
          if (!chatListElement) return;
          chatListElement.scrollTop = 0;
          setListScrollTop(0);
        });
      },
    ),
  );

  createEffect(
    on(
      () => props.activeChatId,
      (activeChatId) => {
        if (!activeChatId) return;
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
      },
    ),
  );

  createEffect(
    on(
      () => [query().trim(), props.online, archiveOpen(), filter()] as const,
      ([term, online, archived, selectedFilter]) => {
        const generation = ++peerSearchGeneration;
        setPeerResults([]);
        setPeerSearchFailed(false);
        if (!term || !online || archived || selectedFilter === 'unread') {
          setSearchingPeers(false);
          return;
        }
        setSearchingPeers(true);
        const timer = window.setTimeout(() => {
          void props.directory.search(term).then(
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
      },
    ),
  );

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
      class="chat-sidebar relative flex min-h-0 min-w-0 flex-col border-r border-line bg-panel"
      classList={{
        compact: compact(),
        'mobile-open': props.layout.mobileOpen(),
        'archive-open': archiveOpen(),
      }}
      data-testid="chat-sidebar"
      data-compact={compact() ? 'true' : 'false'}
      role={props.layout.mobileOpen() && props.layout.viewportWidth() <= 650 ? 'dialog' : undefined}
      aria-modal={
        props.layout.mobileOpen() && props.layout.viewportWidth() <= 650 ? 'true' : undefined
      }
      aria-label={
        props.layout.mobileOpen() && props.layout.viewportWidth() <= 650 ? 'Chat list' : undefined
      }
      tabIndex={props.layout.mobileOpen() && props.layout.viewportWidth() <= 650 ? -1 : undefined}
    >
      <header
        class="sidebar-header flex h-[3.6rem] items-center gap-3 px-4"
        classList={{
          hidden: compact() && !archiveOpen(),
          '!justify-center !px-0': compact() && archiveOpen(),
        }}
      >
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
        <label
          class="flex min-w-0 flex-1 items-center gap-2 rounded-[0.65rem] border border-transparent bg-surface px-3 py-2 text-muted focus-within:border-[color-mix(in_srgb,var(--accent)_60%,transparent)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)] [&>input]:min-w-0 [&>input]:flex-1 [&>input]:border-0 [&>input]:bg-transparent [&>input]:text-[0.82rem] [&>input]:text-ink [&>input]:outline-0"
          classList={{ hidden: compact() && archiveOpen() }}
        >
          <Search size={16} />
          <input
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder={archiveOpen() ? 'Search archived chats' : 'Search chats and people'}
            aria-label="Search chats"
          />
        </label>
      </header>

      <div
        class="chat-filters flex items-center gap-2 px-4 pb-3 text-xs font-medium text-muted"
        classList={{ hidden: compact() }}
      >
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
        class="scroll-area min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        classList={{ '!px-0 pt-2': compact() }}
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
            class="chat-row archived-chats-row relative flex h-16 w-full items-center gap-3 rounded-[0.55rem] border-0 bg-transparent px-[0.65rem] py-2.5 text-inherit transition duration-100 hover:bg-[var(--surface-subtle)]"
            classList={{
              '!justify-center !gap-0 !rounded-none !px-0 !py-[0.55rem]': compact(),
            }}
            aria-label={`Archived chats, ${archivedChats().length} ${
              archivedChats().length === 1 ? 'chat' : 'chats'
            }${archivedUnreadCount() > 0 ? `, ${describeUnreadCount(archivedUnreadCount())}` : ''}`}
            onClick={() => {
              setArchiveOpen(true);
              setContextMenu(undefined);
            }}
          >
            <div class="grid size-[2.65rem] shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--accent)_82%,#26303b)] text-white">
              <Archive size={19} />
            </div>
            <Show when={compact()}>
              <UnreadBadge count={archivedUnreadCount()} muted={archivedUnreadMuted()} compact />
            </Show>
            <span class="min-w-0 flex-1 text-left" classList={{ hidden: compact() }}>
              <span class="block text-[14px] font-semibold">Archived chats</span>
              <span class="mt-1 block truncate text-[13px] text-[var(--muted)]">
                {archivedChats().length} {archivedChats().length === 1 ? 'chat' : 'chats'}
              </span>
            </span>
            <Show when={!compact()}>
              <UnreadBadge count={archivedUnreadCount()} muted={archivedUnreadMuted()} />
            </Show>
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
            <a
              href={chatHref(chat.id)}
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
                setContextMenu(undefined);
                void props.directory.select(chat.id);
                props.layout.setMobileOpen(false);
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
                  void props.directory
                    .details(chat.id)
                    .then((details) => {
                      if (contextMenu()?.chatId === chat.id) setContextUser(details);
                    })
                    .catch(() => undefined);
                }
              }}
              aria-label={`${chat.title}, ${chat.preview}${
                chat.lastMessageStatus ? `, last message ${chat.lastMessageStatus}` : ''
              }${normalizeUnreadCount(chat.unread) > 0 ? `, ${describeUnreadCount(chat.unread)}` : ''}${chat.muted ? ', muted' : ''}`}
              aria-current={chat.id === props.activeChatId ? 'true' : undefined}
              aria-posinset={virtualRange().start + virtualIndex() + 1}
              aria-setsize={filteredChats().length}
            >
              <Avatar
                identity={props.media.avatarIdentity(chat.id)}
                initials={chat.initials}
                color={chat.color}
                online={chat.presence === 'online'}
                loadCached={() => props.media.loadAvatar(chat.id, true)}
                load={props.online ? () => props.media.loadAvatar(chat.id) : undefined}
              />
              <Show when={compact()}>
                <UnreadBadge count={chat.unread} muted={chat.muted} compact />
              </Show>
              <span class="min-w-0 flex-1 text-left" classList={{ hidden: compact() }}>
                <span class="flex items-baseline justify-between gap-3">
                  <span class="truncate text-[14px] font-semibold">{chat.title}</span>
                  <span class="shrink-0 text-[11px] text-[var(--muted)]">{chat.time}</span>
                </span>
                <span class="mt-1 flex min-w-0 items-center gap-1 text-[var(--muted)]">
                  <Show when={chat.lastMessageStatus === 'sent'}>
                    <Check
                      size={14}
                      class="chat-delivery-status size-3.5 shrink-0"
                      aria-label="Last message sent"
                    />
                  </Show>
                  <Show when={chat.lastMessageStatus === 'read'}>
                    <CheckCheck
                      size={14}
                      class="chat-delivery-status size-3.5 shrink-0 text-accent"
                      aria-label="Last message read"
                    />
                  </Show>
                  <span class="min-w-0 flex-1 truncate text-[13px]">{chat.preview}</span>
                  <span class="ml-auto flex shrink-0 items-center gap-1.5">
                    <Show when={chat.muted}>
                      <MutedIcon />
                    </Show>
                    <UnreadBadge count={chat.unread} muted={chat.muted} />
                  </span>
                </span>
              </span>
            </a>
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
          <p class="mx-[0.7rem] mt-3 mb-1 text-xs font-bold tracking-[0.04em] text-accent uppercase">
            Telegram
          </p>
          <For each={visiblePeerResults()}>
            {(result) => (
              <button
                class="chat-row relative flex h-16 w-full items-center gap-3 rounded-[0.55rem] border-0 bg-transparent px-[0.65rem] py-2.5 text-inherit transition duration-100 hover:bg-[var(--surface-subtle)]"
                classList={{
                  '!justify-center !gap-0 !rounded-none !px-0 !py-[0.55rem]': compact(),
                }}
                data-testid="peer-search-result"
                aria-label={`${result.title}, ${result.category}`}
                onClick={() => {
                  setQuery('');
                  setArchiveOpen(false);
                  void props.directory.open(result);
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
                          props.media.loadPeerAvatar(result.peer, result.hasAvatar, result.avatarId)
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
                    if (selected) void props.directory.setMuted(selected.id, !selected.muted);
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
                    if (selected) void props.directory.setPinned(selected.id, !selected.pinned);
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
                    if (selected) void props.directory.setArchived(selected.id, !selected.archived);
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
                      if (selected && details)
                        void props.directory.setBlocked(selected.id, !details.blocked);
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
        aria-valuemax={props.layout.responsiveMaxWidth()}
        aria-valuenow={props.layout.effectiveWidth()}
        tabIndex={0}
        onPointerDown={props.layout.startResize}
        onKeyDown={props.layout.resizeWithKeyboard}
      />
    </aside>
  );
}
