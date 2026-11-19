import { createMenuPresence, menuAtPoint } from '../shared/menuSurface';
import AtSign from '@effectweb/lucide/icons/at-sign';
import Heart from '@effectweb/lucide/icons/heart';
import Menu from '@effectweb/lucide/icons/menu';
import MessagesSquare from '@effectweb/lucide/icons/messages-square';
import Users from '@effectweb/lucide/icons/users';
import Bookmark from '@effectweb/lucide/icons/bookmark';
import { CreateChatDialog } from '../groups/CreateChatDialog';
import type { ChatCreationApi } from '../../telegram/chatManagement';
import SquarePen from '@effectweb/lucide/icons/square-pen';
import {
  folderContains,
  type ChatFoldersApi,
  type TelegramChatFolder,
} from '../../telegram/chatFolders';
import { folderSubscription } from '../folders/folderSubscription';
import { FolderSettings } from '../folders/FolderSettings';
import { Dialog } from '../shared/Dialog';
import FolderCog from '@effectweb/lucide/icons/folder-cog';
import { list, component, domBinding, domMount, sequence, view } from 'effectweb';
import { cachedLoad } from '../shared/cachedLoad';
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
import Mail from '@effectweb/lucide/icons/mail';
import Check from '@effectweb/lucide/icons/check';
import CheckCheck from '@effectweb/lucide/icons/check-check';
import Pin from '@effectweb/lucide/icons/pin';
import PinOff from '@effectweb/lucide/icons/pin-off';
import Search from '@effectweb/lucide/icons/search';
import Settings from '@effectweb/lucide/icons/settings';
import Trash2 from '@effectweb/lucide/icons/trash-2';
import type { MediaAssets } from '../media/mediaAssets';
import type { Command, RunKey } from 'effectweb';
import type { Send, Transition } from 'effectweb';
import { Avatar } from '../shared/Avatar';
import type { ChatDirectory } from './chatDirectory';
import { describeUnreadCount, formatUnreadCount, normalizeUnreadCount } from './unreadCount';
const commandPeers = 'peers';
const commandContextUser = 'context-user';

const filterLabels = {
  all: 'All',
  unread: 'Unread',
  groups: 'Groups',
  archived: 'Archived',
} as const;

type ChatFilter = 'all' | 'unread' | 'groups' | 'archived' | `folder:${number}`;
const CHAT_ROW_HEIGHT = 64;
const CHAT_LIST_OVERSCAN = 8;
const CHAT_LIST_VIRTUALIZATION_THRESHOLD = 120;
interface UnreadBadgeProps {
  count: number;
  marked?: boolean | undefined;
  muted?: boolean | undefined;
  compact?: boolean | undefined;
}
const UnreadBadge = view<UnreadBadgeProps, never>((props, _send) => {
  const count = () => normalizeUnreadCount(props.count);
  return count() > 0 || props.marked ? (
    <span
      class="chat-unread-badge grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5 text-[10px] leading-none font-bold text-white"
      classList={{
        'chat-unread-badge-compact': Boolean(props.compact),
        'chat-unread-badge-trailing': !props.compact,
        muted: Boolean(props.muted),
        'absolute top-[0.2rem] right-[0.2rem] z-[2] h-6 min-w-6 border-2 border-panel px-[0.3rem] text-xs':
          Boolean(props.compact),
      }}
      aria-hidden="true"
      title={count() > 0 ? describeUnreadCount(count()) : 'Marked as unread'}
    >
      {count() > 0 ? formatUnreadCount(count()) : '•'}
    </span>
  ) : null;
});
const AttentionBadges = view<
  { mentions?: number | undefined; reactions?: number | undefined; compact?: boolean },
  never
>((props) => (
  <span
    class="chat-attention-badges"
    classList={{ 'chat-attention-badges-compact': Boolean(props.compact) }}
  >
    {(props.mentions ?? 0) > 0 ? (
      <span
        class="chat-attention-badge"
        title={`${props.mentions} unread replies and mentions`}
        aria-label={`${props.mentions} unread replies and mentions`}
      >
        <AtSign size={14} aria-hidden="true" />
      </span>
    ) : null}
    {(props.reactions ?? 0) > 0 ? (
      <span
        class="chat-attention-badge"
        title={`${props.reactions} unread reactions`}
        aria-label={`${props.reactions} unread reactions`}
      >
        <Heart size={13} fill="currentColor" aria-hidden="true" />
      </span>
    ) : null}
  </span>
));
const MutedIcon = view<Record<string, never>, never>((_props, _send) => {
  return <BellOff size={12} class="chat-muted-icon size-3 shrink-0" aria-label="Muted" />;
});
interface ChatSidebarProps {
  foldersApi: ChatFoldersApi;
  creationApi: ChatCreationApi;
  foldersReady: boolean;
  chats: ChatSummary[];
  dialogs: TelegramDialog[];
  activeChatId: string;
  online: boolean;
  layout: SidebarLayout;
  media: MediaAssets;
  directory: ChatDirectory;
  requestDelete: (peerId: string) => void;
  openSettings: () => void;
  openSaved: () => void;
}
type ContextUser = NonNullable<ReturnType<ChatDirectory['cachedDetails']>>;
type ChatSidebarState = {
  dialogsById: ReadonlyMap<string, TelegramDialog>;
  folders: TelegramChatFolder[];
  foldersOpen: boolean;
  createOpen: boolean;
  peers: TelegramPeerSearchResult[];
  peersLoading: boolean;
  peersError: boolean;
  searchKey: string;
  contextUser: ContextUser | undefined;
  contextUserKey: string;
  query: string;
  filter: ChatFilter;
  listScrollTop: number;
  listViewportHeight: number;
  contextMenu: { chatId: string; x: number; y: number } | undefined;
};
type ChatSidebarModel = ChatSidebarState & { readonly props: ChatSidebarProps };
type ChatSidebarMessage =
  | { type: 'CreateOpen'; open: boolean }
  | { type: 'LoadFolders' }
  | { type: 'FoldersLoaded'; folders: TelegramChatFolder[] }
  | { type: 'FoldersOpen'; open: boolean }
  | { type: 'RetrySearch' }
  | { type: 'Peers'; values: TelegramPeerSearchResult[]; error: boolean }
  | { type: 'ContextUser'; value: ContextUser | undefined }
  | { type: 'Query'; value: string }
  | { type: 'Filter'; value: ChatFilter }
  | { type: 'ListScrollTop'; value: number }
  | { type: 'ListViewportHeight'; value: number }
  | { type: 'ContextMenu'; value: { chatId: string; x: number; y: number } | undefined };
function refreshSidebar(
  model: ChatSidebarModel,
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
    cancel: RunKey[] = [];
  let next = model;
  if (retry || searchKey !== model.searchKey) {
    next = { ...next, searchKey, peers: [], peersError: false, peersLoading: Boolean(searchKey) };
    if (!searchKey) cancel.push(commandPeers);
    else
      commands.push({
        key: commandPeers,
        policy: 'replace',
        effect: Effect.sleep(retry ? 0 : 250).pipe(
          Effect.andThen(Effect.suspend(() => model.props.directory.search(term))),
          Effect.matchCause({
            onSuccess: (values) => ({ type: 'Peers', values, error: false }) as const,
            onFailure: () => ({ type: 'Peers', values: [], error: true }) as const,
          }),
        ),
      });
  }
  if (userKey !== model.contextUserKey) {
    next = { ...next, contextUserKey: userKey, contextUser: undefined };
    if (!userKey) cancel.push(commandContextUser);
    else
      commands.push({
        key: commandContextUser,
        policy: 'replace',
        effect: cachedLoad(
          () => model.props.directory.cachedDetails(userKey),
          () => model.props.directory.details(userKey),
        ).pipe(
          Effect.matchCause({
            onSuccess: (value) => ({ type: 'ContextUser', value }) as const,
            onFailure: () => ({ type: 'ContextUser', value: undefined }) as const,
          }),
        ),
      });
  }
  return { model: next, commands, cancel };
}
const ChatMenu = createMenuPresence<NonNullable<ChatSidebarState['contextMenu']>>();
const chatHref = (peerId: string) => `?chat=${encodeURIComponent(peerId)}`;
const filterEdges = domMount<HTMLDivElement>((element) => {
  const update = () => {
    const end = element.scrollWidth - element.clientWidth;
    element.toggleAttribute('data-overflow-start', element.scrollLeft > 1);
    element.toggleAttribute('data-overflow-end', end - element.scrollLeft > 1);
  };
  const placeIndicator = () => {
    const selected = element.querySelector<HTMLElement>('button[aria-pressed="true"]');
    if (!selected) return;
    element.style.setProperty('--folder-x', selected.offsetLeft + 'px');
    element.style.setProperty('--folder-y', selected.offsetTop + 'px');
    element.style.setProperty('--folder-width', selected.offsetWidth + 'px');
    element.style.setProperty('--folder-height', selected.offsetHeight + 'px');
  };
  const layout = () => {
    update();
    placeIndicator();
  };
  const resize = new ResizeObserver(layout);
  const children = new MutationObserver(layout);
  resize.observe(element);
  children.observe(element, {
    childList: true,
    subtree: true,
    characterData: true,
    attributeFilter: ['aria-pressed', 'class'],
  });
  element.addEventListener('scroll', update, { passive: true });
  layout();
  return () => {
    resize.disconnect();
    children.disconnect();
    element.removeEventListener('scroll', update);
  };
});
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
  topMessage: TelegramDialog['topMessage'];
  send: Send<ChatSidebarMessage>;
}
function acquireList(element: HTMLDivElement, input: () => ListInput) {
  let previousQuery: string | undefined,
    previousFilter: ChatFilter | undefined,
    previousPeer: string | undefined;
  let listFade: Animation | undefined;
  let previousIndex = -1;
  let previousMessageId: number | undefined;
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
    const index = data.filtered.findIndex((chat) => chat.id === data.activeChatId);
    const movedAfterSend =
      !select &&
      !reset &&
      index >= 0 &&
      index < previousIndex &&
      data.topMessage?.outgoing &&
      data.topMessage.id > (previousMessageId ?? 0);
    previousIndex = index;
    previousMessageId = data.topMessage?.id;
    previousQuery = data.query;
    if (previousFilter !== undefined && previousFilter !== data.filter) {
      listFade?.cancel();
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        listFade = element.animate([{ opacity: 0.55 }, { opacity: 1 }], {
          duration: 160,
          easing: 'ease-out',
          id: 'folder-change',
        });
      }
    }
    previousFilter = data.filter;
    previousPeer = data.activeChatId;
    if (movedAfterSend) {
      const top = index * CHAT_ROW_HEIGHT;
      if (top + CHAT_ROW_HEIGHT <= element.scrollTop) {
        element.scrollTo({
          top: top + CHAT_ROW_HEIGHT <= element.clientHeight ? 0 : top,
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        });
      }
    }
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
      listFade?.cancel();
      observer.disconnect();
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    },
  };
}
const listMount = (input: ListInput) => domBinding(input, acquireList);
function indexDialogs(dialogs: readonly TelegramDialog[]): ReadonlyMap<string, TelegramDialog> {
  const index = new Map<string, TelegramDialog>();
  for (const dialog of dialogs) {
    if (!index.has(dialog.peer.id)) index.set(dialog.peer.id, dialog);
  }
  return index;
}

export const ChatSidebar = component<ChatSidebarProps, ChatSidebarState, ChatSidebarMessage>(
  {
    init: (props) => ({
      dialogsById: indexDialogs(props.dialogs),
      peers: [],
      folders: [],
      foldersOpen: false,
      createOpen: false,
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
    receive: (model, previous) =>
      refreshSidebar({
        ...model,
        dialogsById:
          model.props.dialogs === previous.dialogs
            ? model.dialogsById
            : indexDialogs(model.props.dialogs),
        contextMenu:
          model.props.activeChatId !== previous.activeChatId ? undefined : model.contextMenu,
      }),
    update: (model, message) => {
      switch (message.type) {
        case 'LoadFolders':
          return {
            model,
            commands: [
              {
                key: ['sidebar', 'folders'],
                policy: 'replace',
                effect: model.props.foldersApi
                  .getChatFolders()
                  .pipe(
                    Effect.match({
                      onSuccess: (folders) => ({ type: 'FoldersLoaded', folders }) as const,
                      onFailure: () => ({ type: 'FoldersLoaded', folders: model.folders }) as const,
                    }),
                  ),
              },
            ],
          };
        case 'FoldersLoaded':
          return {
            model: {
              ...model,
              folders: message.folders,
              filter:
                model.filter.startsWith('folder:') &&
                !message.folders.some((folder) => `folder:${folder.id}` === model.filter)
                  ? 'all'
                  : model.filter,
            },
          };
        case 'CreateOpen':
          return { model: { ...model, createOpen: message.open } };
        case 'FoldersOpen':
          return { model: { ...model, foldersOpen: message.open } };

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
  },
  view((model, send) => {
    const props = model.props;
    const runInBackground = (task: Promise<unknown>) => {
      void task.catch(() => undefined);
    };
    const compact = () => props.layout.compact && !props.layout.mobileOpen;
    const archiveOpen = () => model.filter === 'archived';
    const peerResults = model.peers;
    const searchingPeers = model.peersLoading;
    const peerSearchFailed = model.peersError;
    const contextUser = () =>
      (model.contextMenu
        ? model.dialogsById.get(model.contextMenu.chatId)?.userDetails
        : undefined) ?? model.contextUser;
    const peerResource = { refetch: () => send({ type: 'RetrySearch' }) };
    const archivedChats = (() => props.chats.filter((chat) => chat.archived))();
    const archivedUnreadCount = (() =>
      archivedChats.reduce((total, chat) => total + normalizeUnreadCount(chat.unread), 0))();
    const archivedUnreadMuted = (() =>
      archivedUnreadCount > 0 && !archivedChats.some((chat) => chat.unread > 0 && !chat.muted))();
    const selectedFolder = model.folders.find((folder) => `folder:${folder.id}` === model.filter);
    const filteredChats = (() => {
      const term = model.query.trim().toLocaleLowerCase();
      return props.chats.filter((chat) => {
        const matchesQuery =
          !term ||
          `${chat.title} ${chat.username ?? ''} ${chat.preview}`.toLocaleLowerCase().includes(term);
        if (selectedFolder) {
          const dialog = model.dialogsById.get(chat.id);
          return Boolean(matchesQuery && dialog && folderContains(selectedFolder, dialog));
        }
        const matchesArchive = archiveOpen() ? Boolean(chat.archived) : !chat.archived;
        const matchesFilter =
          model.filter === 'all' ||
          (model.filter === 'unread' && (chat.unread > 0 || chat.unreadMark)) ||
          (model.filter === 'groups' && chat.kind === 'group') ||
          model.filter === 'archived';
        return matchesQuery && matchesArchive && matchesFilter;
      });
    })().sort((left, right) => {
      if (!selectedFolder) return 0;
      const l = selectedFolder.pinned.findIndex((peer) => peer.id === left.id),
        r = selectedFolder.pinned.findIndex((peer) => peer.id === right.id);
      return (l < 0 ? Infinity : l) - (r < 0 ? Infinity : r);
    });
    const visiblePeerResults = (() => {
      const localIds = new Set(filteredChats.map(({ id }) => id));
      return peerResults.filter(
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
          use={folderSubscription(
            props.foldersApi,
            () => send({ type: 'LoadFolders' }),
            props.foldersReady,
          )}
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
          class="flex min-w-0 items-center gap-1 px-3 pb-2 text-xs font-medium text-muted"
          classList={{
            hidden: compact() && !model.folders.length,
            '!flex-col !px-0 !gap-0': compact(),
          }}
        >
          <div
            class="chat-filters flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            classList={{ '!flex-col !flex-none': compact() }}
            use={filterEdges}
            onWheel={scrollFilters}
          >
            {list(sequence(['all', 'unread', 'groups', 'archived'] as const), (value) => (
              <button
                class="shrink-0 rounded-full px-2.5 py-1.5 transition-colors duration-150 focus-visible:outline-offset-[-2px]"
                classList={{
                  'text-[var(--accent)]': model.filter === value,
                  '!grid !size-11 place-items-center !p-0': compact(),
                  'hover:bg-[var(--surface-hover)]': model.filter !== value,
                }}
                title={filterLabels[value]}
                aria-label={filterLabels[value]}
                aria-pressed={model.filter === value}
                onClick={() => send({ type: 'Filter', value: value })}
              >
                {compact() ? (
                  value === 'all' ? (
                    <MessagesSquare size={20} />
                  ) : value === 'unread' ? (
                    <Mail size={20} />
                  ) : value === 'groups' ? (
                    <Users size={20} />
                  ) : (
                    <Archive size={20} />
                  )
                ) : (
                  filterLabels[value]
                )}
              </button>
            ))}
            {list(idRows(model.folders), (folder) => (
              <button
                class="shrink-0 rounded-full px-2.5 py-1.5 transition-colors duration-150 focus-visible:outline-offset-[-2px]"
                classList={{
                  'text-[var(--accent)]': model.filter === `folder:${folder.id}`,
                  '!grid !size-11 place-items-center !p-0': compact(),
                }}
                title={folder.title}
                aria-label={folder.title}
                aria-pressed={model.filter === `folder:${folder.id}`}
                onClick={() => send({ type: 'Filter', value: `folder:${folder.id}` })}
              >
                {compact()
                  ? folder.emoticon || folder.title.slice(0, 2)
                  : `${folder.emoticon ?? ''} ${folder.title}`}
              </button>
            ))}
          </div>
          <button
            class="icon-button shrink-0"
            title="Edit chat folders"
            aria-label="Edit chat folders"
            onClick={() => send({ type: 'FoldersOpen', open: true })}
          >
            <FolderCog size={18} />
          </button>
        </div>

        {compact() && model.filter === 'all' && archivedChats.length > 0 ? (
          <button
            class="chat-row archived-chats-row relative flex h-16 w-full items-center justify-center border-0 bg-transparent py-[0.55rem] text-inherit transition-colors duration-150 hover:bg-[var(--surface-subtle)]"
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
            topMessage: model.dialogsById.get(props.activeChatId)?.topMessage,
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
          {list(idRows(virtualChats), (chat, virtualIndex) => (
            <a
              href={chatHref(chat.id)}
              draggable={false}
              role="button"
              class="chat-row relative flex h-16 w-full items-center gap-3 rounded-[0.55rem] border-0 bg-transparent px-[0.65rem] py-2.5 text-inherit transition-colors duration-150 hover:bg-[var(--surface-subtle)]"
              classList={{
                active: chat.id === props.activeChatId,
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
                const menu = { chatId: chat.id, x: event.clientX, y: event.clientY };
                send({ type: 'ContextMenu', value: menu });
              }}
              aria-label={`${chat.title}, ${chat.preview}${chat.lastMessageStatus ? `, last message ${chat.lastMessageStatus}` : ''}${normalizeUnreadCount(chat.unread) > 0 ? `, ${describeUnreadCount(chat.unread)}` : ''}${chat.muted ? ', muted' : ''}`}
              aria-current={chat.id === props.activeChatId ? 'true' : undefined}
              aria-posinset={virtualRange.start + virtualIndex + 1}
              aria-setsize={filteredChats.length}
            >
              <Avatar
                identity={`${chat.id}:${model.dialogsById.get(chat.id)?.avatarId ?? 'none'}`}
                initials={chat.initials}
                color={chat.color}
                online={chat.presence === 'online'}
                loadCached={() => props.media.loadAvatar(chat.id, true)}
                load={props.online ? () => props.media.loadAvatar(chat.id) : undefined}
              />
              {compact() ? (
                <>
                  <UnreadBadge
                    count={chat.unread}
                    marked={chat.unreadMark}
                    muted={chat.muted}
                    compact
                  />
                  <AttentionBadges
                    mentions={chat.unreadMentions}
                    reactions={chat.unreadReactions}
                    compact
                  />
                </>
              ) : null}
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
                    <AttentionBadges
                      mentions={chat.unreadMentions}
                      reactions={chat.unreadReactions}
                    />
                    {chat.muted ? <MutedIcon /> : null}
                    <UnreadBadge count={chat.unread} marked={chat.unreadMark} muted={chat.muted} />
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
              {list(remotePeerRows(visiblePeerResults), (result) => (
                <button
                  class="chat-row relative flex h-16 w-full items-center gap-3 rounded-[0.55rem] border-0 bg-transparent px-[0.65rem] py-2.5 text-inherit transition-colors duration-150 hover:bg-[var(--surface-subtle)]"
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
          {searchingPeers ? (
            <p class="px-4 py-5 text-center text-sm text-[var(--muted)]">Searching Telegram…</p>
          ) : null}
          {peerSearchFailed ? (
            <div class="px-4 py-5 text-center text-sm text-[var(--muted)]" role="alert">
              <p>Telegram search is unavailable. Try again.</p>
              <button onClick={() => peerResource.refetch()}>Retry search</button>
            </div>
          ) : null}
          {filteredChats.length === 0 &&
          visiblePeerResults.length === 0 &&
          !searchingPeers &&
          !peerSearchFailed ? (
            <p class="px-4 py-10 text-center text-sm text-[var(--muted)]">
              {archiveOpen() && !model.query.trim() ? 'No archived chats' : 'No chats found'}
            </p>
          ) : null}
          <ChatMenu
            value={model.contextMenu}
            render={(menu, closing) => {
              const chat = () => props.chats.find(({ id }) => id === menu.chatId);
              return (
                <div
                  class="menu-surface chat-context-menu"
                  inert={closing}
                  aria-hidden={closing || undefined}
                  role="menu"
                  aria-label="Chat actions"
                  use={menuAtPoint(menu)}
                >
                  <button
                    role="menuitem"
                    disabled={!props.online}
                    onClick={() => {
                      const selected = chat();
                      send({ type: 'ContextMenu', value: undefined });
                      if (selected)
                        runInBackground(
                          props.directory.setUnreadMark(
                            selected.id,
                            !(selected.unread > 0 || selected.unreadMark),
                          ),
                        );
                    }}
                  >
                    {chat()?.unread || chat()?.unreadMark ? (
                      <CheckCheck size={16} />
                    ) : (
                      <Mail size={16} />
                    )}
                    {chat()?.unread || chat()?.unreadMark ? 'Mark as read' : 'Mark as unread'}
                  </button>
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
            }}
          />
        </div>
        {model.createOpen ? (
          <CreateChatDialog
            api={props.creationApi}
            directory={props.directory}
            dialogs={props.dialogs}
            media={props.media}
            online={props.online}
            close={() => send({ type: 'CreateOpen', open: false })}
          />
        ) : null}
        {model.foldersOpen ? (
          <Dialog title="Chat Folders" onClose={() => send({ type: 'FoldersOpen', open: false })}>
            <div class="scroll-area min-h-0 overflow-y-auto">
              <FolderSettings
                api={props.foldersApi}
                online={props.online}
                dialogs={props.dialogs}
                media={props.media}
              />
            </div>
          </Dialog>
        ) : null}
        <footer
          class="sidebar-settings-footer flex shrink-0 border-t border-line px-3 py-[0.55rem]"
          classList={{ '!px-0': compact() }}
        >
          <button
            class="flex min-h-11 w-full items-center gap-[0.65rem] rounded-[0.55rem] border-0 bg-transparent px-[0.7rem] py-[0.6rem] text-left text-muted hover:bg-[var(--surface-hover)] hover:text-ink"
            classList={{ '!justify-center !rounded-none !px-0': compact() }}
            popovertarget="sidebar-main-menu"
            aria-label="Open main menu"
            title="Menu"
          >
            <Menu size={20} />
            <span classList={{ hidden: compact() }}>Menu</span>
          </button>
          <nav
            id="sidebar-main-menu"
            popover="auto"
            class="menu-surface sidebar-main-menu"
            aria-label="Main menu"
          >
            <button
              popovertarget="sidebar-main-menu"
              popovertargetaction="hide"
              onClick={props.openSaved}
            >
              <Bookmark size={20} />
              Saved Messages
            </button>
            <button
              popovertarget="sidebar-main-menu"
              popovertargetaction="hide"
              onClick={() => send({ type: 'CreateOpen', open: true })}
            >
              <SquarePen size={20} />
              New message
            </button>
            <button
              popovertarget="sidebar-main-menu"
              popovertargetaction="hide"
              onClick={props.openSettings}
              aria-label="Open settings"
            >
              <Settings size={20} />
              Settings
            </button>
          </nav>
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
);
