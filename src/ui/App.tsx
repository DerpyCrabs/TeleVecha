import ArrowDown from 'lucide-solid/icons/arrow-down';
import Check from 'lucide-solid/icons/check';
import CheckCheck from 'lucide-solid/icons/check-check';
import ChevronDown from 'lucide-solid/icons/chevron-down';
import ChevronUp from 'lucide-solid/icons/chevron-up';
import CircleAlert from 'lucide-solid/icons/circle-alert';
import Clock3 from 'lucide-solid/icons/clock-3';
import Forward from 'lucide-solid/icons/forward';
import Menu from 'lucide-solid/icons/menu';
import MessageSquareText from 'lucide-solid/icons/message-square-text';
import PanelRightOpen from 'lucide-solid/icons/panel-right-open';
import Pencil from 'lucide-solid/icons/pencil';
import Pin from 'lucide-solid/icons/pin';
import Reply from 'lucide-solid/icons/reply';
import Search from 'lucide-solid/icons/search';
import Trash2 from 'lucide-solid/icons/trash-2';
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import { createStore, reconcile, type SetStoreFunction } from 'solid-js/store';

import type { ChatMessage, ChatSummary } from '../domain/models';
import { MessagingEngine } from '../telegram/engine';
import { FixtureTelegramTransport } from '../telegram/fixtureTransport';
import { IndexedDbCacheStore } from '../telegram/store';
import type {
  EngineSnapshot,
  PendingAttachment,
  TelegramBotButton,
  TelegramBotCommand,
  TelegramHistoryGap,
  TelegramCredentials,
  TelegramDialog,
  TelegramMessage,
  TelegramPeer,
  SharedMediaKind,
  TelegramSticker,
  TelegramStickerPack,
  TelegramTextFormat,
  TelegramTransport,
  TelegramUrlAuthAcceptOptions,
  TelegramUrlAuthResult,
} from '../telegram/types';
import { WebAGramJsTransport } from '../telegram/webAGramJsTransport';
import { Avatar } from './Avatar';
import { cachedAssetUrl, loadAssetUrl, pruneAssetUrls, rememberAssetUrl } from './assetUrls';
import { AuthOverlay } from './AuthOverlay';
import { BotControls } from './BotControls';
import { BotKeyboard } from './BotKeyboard';
import { BotUrlAuthDialog } from './BotUrlAuthDialog';
import { ChatComposer } from './ChatComposer';
import { ChatSidebar } from './ChatSidebar';
import { DeleteMessageDialog } from './DeleteMessageDialog';
import { DeleteChatDialog } from './DeleteChatDialog';
import { DetailsPane } from './DetailsPane';
import { ForwardMessageDialog } from './ForwardMessageDialog';
import { MediaAttachment } from './MediaAttachment';
import { MessageAlbum } from './MessageAlbum';
import { MessageActions } from './MessageActions';
import { MessageBody } from './MessageBody';
import { albumSafeMessageWindow } from './messageWindow';
import { SearchPanel } from './SearchPanel';
import { safeExternalUrl } from './safeUrl';
import { SharedMediaPanel } from './SharedMediaPanel';
import { stageAttachment, type StagedAttachment } from './outgoingAttachments';

function environmentCredentials(): TelegramCredentials | undefined {
  const envId = Number(import.meta.env.VITE_TELEGRAM_API_ID);
  const envHash = String(import.meta.env.VITE_TELEGRAM_API_HASH ?? '').trim();
  if (envId && envHash) return { apiId: envId, apiHash: envHash };
  return undefined;
}

const LEFT_SIDEBAR_STORAGE_KEY = 'televecha:left-sidebar-width';
const DETAILS_OPEN_STORAGE_KEY = 'televecha:details-open';
const LEFT_SIDEBAR_DEFAULT_WIDTH = 320;
const LEFT_SIDEBAR_MIN_WIDTH = 72;
const LEFT_SIDEBAR_MAX_WIDTH = 480;
const LEFT_SIDEBAR_COMPACT_WIDTH = 128;
const MAX_RENDERED_MESSAGES = 400;
const MAX_CACHED_MESSAGE_VIEWS = MAX_RENDERED_MESSAGES * 2;
const PRESENT_SCROLL_EPSILON = 0.5;

interface AppRuntime {
  store: IndexedDbCacheStore;
  transport: TelegramTransport;
  engine: MessagingEngine;
}

interface PendingBotUrlAuth {
  peer: TelegramPeer;
  messageId: number;
  buttonId: number;
  fallbackUrl?: string | undefined;
  request: Extract<TelegramUrlAuthResult, { kind: 'request' }>;
  generation: number;
  owner: string;
}

interface PendingInlineSwitch {
  query: string;
  botUsername?: string | undefined;
  owner: string;
}

function appRuntime(fixtureMode: boolean, fixtureScenario: string | null) {
  const root = globalThis as typeof globalThis & {
    __televechaRuntimes?: Map<string, AppRuntime>;
  };
  const key = fixtureMode ? `fixture:${fixtureScenario ?? 'default'}` : 'production';
  const runtimes = (root.__televechaRuntimes ??= new Map());
  const existing = runtimes.get(key);
  if (existing) return existing;
  const store = new IndexedDbCacheStore(
    fixtureMode ? `televecha-e2e${fixtureScenario ? `-${fixtureScenario}` : ''}` : 'televecha',
  );
  const transport: TelegramTransport = fixtureMode
    ? new FixtureTelegramTransport()
    : new WebAGramJsTransport(store);
  const runtime = { store, transport, engine: new MessagingEngine(transport, store) };
  runtimes.set(key, runtime);
  return runtime;
}

function clampLeftSidebarWidth(width: number) {
  return Math.min(LEFT_SIDEBAR_MAX_WIDTH, Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function storedLeftSidebarWidth() {
  try {
    const stored = Number(localStorage.getItem(LEFT_SIDEBAR_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0
      ? clampLeftSidebarWidth(stored)
      : LEFT_SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return LEFT_SIDEBAR_DEFAULT_WIDTH;
  }
}

function storedDetailsOpen() {
  try {
    return localStorage.getItem(DETAILS_OPEN_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(timestamp * 1000),
  );
}

function pendingAttachmentMedia(attachment: PendingAttachment): NonNullable<ChatMessage['media']> {
  const kind = attachment.asSticker
    ? 'sticker'
    : attachment.sendAs === 'file'
      ? 'file'
      : attachment.mimeType === 'image/gif'
        ? 'animation'
        : attachment.mimeType.startsWith('image/')
          ? 'photo'
          : attachment.mimeType.startsWith('video/')
            ? 'video'
            : 'file';
  return {
    kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.blob.size,
  };
}

function dialogSummary(dialog: TelegramDialog): ChatSummary {
  return {
    id: dialog.peer.id,
    title: dialog.title,
    initials: dialog.initials,
    color: dialog.color,
    preview: dialog.topMessage?.text || 'No messages yet',
    time: dialog.topMessage ? formatTime(dialog.topMessage.date) : '',
    unread: dialog.unreadCount,
    muted: dialog.muted,
    pinned: dialog.pinned,
    archived: Boolean(dialog.archived),
    ...(dialog.username ? { username: dialog.username } : {}),
    bot: Boolean(dialog.bot),
    ...(dialog.presence ? { presence: dialog.presence } : {}),
    lastSeenAt: dialog.lastSeenAt,
    kind: dialog.peer.kind,
  };
}

function messageView(
  message: TelegramMessage,
  readOutboxMaxId: number,
  repliedMessage?: TelegramMessage,
): ChatMessage {
  const senderName = (message as TelegramMessage & { senderName?: string }).senderName;
  return {
    id: String(message.id),
    author: message.outgoing ? 'You' : senderName || message.senderId,
    body: message.text || (message.media ? '' : 'Unsupported message'),
    time: formatTime(message.date),
    date: message.date,
    editedAt: message.editedAt,
    outgoing: message.outgoing,
    status: message.outgoing && message.id <= readOutboxMaxId ? 'read' : 'sent',
    groupedId: message.groupedId,
    service: message.service,
    botKeyboard: message.botKeyboard,
    media: message.media,
    reactions: message.reactions,
    mentions: message.mentions,
    links: message.links,
    linkPreview: message.linkPreview,
    formats: message.formats,
    replyTo: message.replyQuote || repliedMessage?.text || repliedMessage?.media?.name || undefined,
    replyToId: message.replyToId,
    replyMedia: repliedMessage?.media,
    replyMediaPeerId: repliedMessage?.peerId,
  };
}

function reuseArray<T>(previous: readonly T[], next: T[]) {
  return previous.length === next.length && previous.every((value, index) => value === next[index])
    ? previous
    : next;
}

interface StoredView<T extends object> {
  value: T;
  set: SetStoreFunction<T>;
}

interface KeyedMessageView {
  key: string;
  message: ChatMessage;
}

function stableView<T extends object>(cache: Map<string, StoredView<T>>, key: string, next: T) {
  const current = cache.get(key);
  if (current) {
    current.set(reconcile(next));
    cache.delete(key);
    cache.set(key, current);
    return current.value;
  }
  const [value, set] = createStore(next);
  cache.set(key, { value, set });
  return value;
}

function runInBackground(task: Promise<unknown>) {
  void task.catch(() => undefined);
}

export function App() {
  const fixtureMode = import.meta.env.VITE_TELEVECHA_E2E === '1';
  const credentials = fixtureMode ? { apiId: 1, apiHash: 'fixture' } : environmentCredentials();
  const configurationError = credentials
    ? undefined
    : 'TeleVecha could not find VITE_TELEGRAM_API_ID and VITE_TELEGRAM_API_HASH.';
  const fixtureScenario = new URLSearchParams(window.location.search).get('scenario');
  const { engine } = appRuntime(fixtureMode, fixtureScenario);
  const [snapshot, setSnapshot] = createSignal<EngineSnapshot>(engine.snapshot());
  const [authOpen, setAuthOpen] = createSignal(engine.snapshot().phase !== 'ready');
  const [activeChatId, setActiveChatId] = createSignal('empty');
  const [detailsOpen, setDetailsOpen] = createSignal(
    window.innerWidth > 1100 && storedDetailsOpen(),
  );
  const [viewportWidth, setViewportWidth] = createSignal(window.innerWidth);
  const [mobileSidebarOpen, setMobileSidebarOpen] = createSignal(false);
  const [leftSidebarWidth, setLeftSidebarWidth] = createSignal(storedLeftSidebarWidth());
  const [resizingLeftSidebar, setResizingLeftSidebar] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [draftFormats, setDraftFormats] = createSignal<TelegramTextFormat[]>([]);
  const [messageScroller, setMessageScroller] = createSignal<HTMLDivElement>();
  const [messageContent, setMessageContent] = createSignal<HTMLDivElement>();
  const [conversationReady, setConversationReady] = createSignal(true);
  const [conversationLoadError, setConversationLoadError] = createSignal('');
  const [conversationRetrying, setConversationRetrying] = createSignal(false);
  const [syncRetrying, setSyncRetrying] = createSignal(false);
  const [pendingActionId, setPendingActionId] = createSignal('');
  const [messageWindowStart, setMessageWindowStart] = createSignal(0);
  const [jumpToPresentVisible, setJumpToPresentVisible] = createSignal(false);
  const [stickerPickerOpen, setStickerPickerOpen] = createSignal(false);
  const [stickerPickerLoading, setStickerPickerLoading] = createSignal(false);
  const [gifPickerOpen, setGifPickerOpen] = createSignal(false);
  const [gifPickerLoading, setGifPickerLoading] = createSignal(false);
  const [expressionPickerVisible, setExpressionPickerVisible] = createSignal(false);
  const [savedGifs, setSavedGifs] = createSignal<TelegramSticker[]>([]);
  const [stickerPacks, setStickerPacks] = createSignal<TelegramStickerPack[]>([]);
  const [reactionPickerMessageId, setReactionPickerMessageId] = createSignal('');
  const [replyTarget, setReplyTarget] = createSignal<
    { messageId: number; preview: string; quoteText?: string } | undefined
  >();
  const [composerAttachments, setComposerAttachments] = createSignal<StagedAttachment[]>([]);
  const [messageContextMenu, setMessageContextMenu] = createSignal<
    { messageId: string; x: number; y: number } | undefined
  >();
  const [editingMessage, setEditingMessage] = createSignal<ChatMessage>();
  const [forwardingMessage, setForwardingMessage] = createSignal<ChatMessage>();
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [sharedMediaKind, setSharedMediaKind] = createSignal<SharedMediaKind>();
  const [deleteTarget, setDeleteTarget] = createSignal<ChatMessage>();
  const [deleteChatTarget, setDeleteChatTarget] = createSignal<ChatSummary>();
  const [pinnedMessageIndex, setPinnedMessageIndex] = createSignal(0);
  const [botCommands, setBotCommands] = createSignal<TelegramBotCommand[]>([]);
  const [botCommandsPeerId, setBotCommandsPeerId] = createSignal('');
  const [botCommandsLoading, setBotCommandsLoading] = createSignal(false);
  const [botMenuOpen, setBotMenuOpen] = createSignal(false);
  const [botStarting, setBotStarting] = createSignal(false);
  const [botButtonBusy, setBotButtonBusy] = createSignal<
    { owner: string; key: string } | undefined
  >();
  const [botNotice, setBotNotice] = createSignal('');
  const [botUrlAuth, setBotUrlAuth] = createSignal<PendingBotUrlAuth>();
  const [botUrlAuthBusy, setBotUrlAuthBusy] = createSignal(false);
  const [pendingInlineSwitch, setPendingInlineSwitch] = createSignal<PendingInlineSwitch>();
  const [replyKeyboardRevision, setReplyKeyboardRevision] = createSignal(0);
  let draftEditVersion = 0;
  let botCommandsLoadGeneration = 0;
  const avatarLoads = new Map<string, Promise<string | undefined>>();
  const customEmojiLoads = new Map<string, Promise<{ url: string; mimeType: string }>>();
  const avatarUrls = new Set<string>();
  const dialogViews = new Map<string, StoredView<ChatSummary>>();
  const messageViews = new Map<string, StoredView<ChatMessage>>();
  const attachmentDrafts = new Map<string, StagedAttachment[]>();
  const dismissedReplyKeyboards = new Set<string>();
  const handledForceReplies = new Set<string>();
  let appGridElement: HTMLDivElement | undefined;
  let conversationPaneElement: HTMLElement | undefined;
  let mobileSidebarTriggerElement: HTMLButtonElement | undefined;
  let stopSidebarResize: (() => void) | undefined;
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  let typingPeerId = '';
  let olderLoadRunning = false;
  let olderLoadQueued = false;
  let followPresent = true;
  let positioningPresent = false;
  let presentPositionGeneration = 0;
  let presentScrollWriteActive = false;
  let presentScrollWriteGeneration = 0;
  let presentScrollFrame: number | undefined;
  let touchScrollStart: { x: number; y: number } | undefined;
  let pointerScrollActive = false;
  let userScrollIntentActive = false;
  let userScrollIntentTimer: ReturnType<typeof setTimeout> | undefined;
  let userScrollIntentDirection: -1 | 0 | 1 = 0;
  let userScrollIntentMoved = false;
  let openingMessage = false;
  let historyAnchor: { messageId: string; top: number } | undefined;
  let historyRestoreGeneration = 0;
  let editingDraftRestore:
    | {
        peerId: string;
        text: string;
        formats: TelegramTextFormat[];
        attachments: StagedAttachment[];
      }
    | undefined;
  let visibilityFrame: number | undefined;
  let selectionGeneration = 0;
  let historyLoadGeneration = 0;
  let openMessageGeneration = 0;
  let peerOpenGeneration = 0;
  let botActionGeneration = 0;
  let botNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  let botUiPeerId = '';

  function invalidatePresentAlignment() {
    presentPositionGeneration += 1;
    positioningPresent = false;
    presentScrollWriteGeneration += 1;
    presentScrollWriteActive = false;
    if (presentScrollFrame !== undefined) cancelAnimationFrame(presentScrollFrame);
    presentScrollFrame = undefined;
  }

  const resetUserScrollIntent = () => {
    userScrollIntentDirection = 0;
    userScrollIntentMoved = false;
  };

  const settleUserScrollIntent = () => {
    if (pointerScrollActive || positioningPresent || presentScrollWriteActive) return false;
    const scroller = messageScroller();
    if (!scroller) return true;
    if (followPresent) alignScrollerToPresent(scroller);
    else updateJumpToPresent(scroller, userScrollIntentDirection !== -1 || !userScrollIntentMoved);
    return true;
  };

  const clearUserScrollIntent = (settle = true) => {
    const hadIntent = userScrollIntentActive || userScrollIntentTimer !== undefined;
    if (userScrollIntentTimer) clearTimeout(userScrollIntentTimer);
    userScrollIntentTimer = undefined;
    userScrollIntentActive = false;
    if (!settle || !hadIntent || settleUserScrollIntent()) resetUserScrollIntent();
  };

  const markUserScrollIntent = (direction: -1 | 0 | 1 = 0) => {
    if (userScrollIntentTimer) clearTimeout(userScrollIntentTimer);
    userScrollIntentActive = true;
    if (direction !== 0) userScrollIntentDirection = direction;
    userScrollIntentTimer = setTimeout(() => {
      userScrollIntentActive = false;
      userScrollIntentTimer = undefined;
      if (settleUserScrollIntent()) resetUserScrollIntent();
    }, 180);
  };

  onCleanup(() => {
    invalidatePresentAlignment();
    clearUserScrollIntent(false);
    selectionGeneration += 1;
    historyLoadGeneration += 1;
    historyRestoreGeneration += 1;
    openMessageGeneration += 1;
    olderLoadRunning = false;
    olderLoadQueued = false;
  });

  const cloneAttachments = (attachments: readonly StagedAttachment[]) =>
    attachments.map((attachment) => ({ ...attachment }));
  const rememberAttachmentDraft = (peerId: string, attachments: readonly StagedAttachment[]) => {
    if (!peerId || peerId === 'empty') return;
    if (attachments.length === 0) attachmentDrafts.delete(peerId);
    else attachmentDrafts.set(peerId, cloneAttachments(attachments));
  };

  const responsiveLeftSidebarMaxWidth = () =>
    viewportWidth() <= 1100 && viewportWidth() > 650
      ? Math.max(LEFT_SIDEBAR_MIN_WIDTH, viewportWidth() - 360)
      : LEFT_SIDEBAR_MAX_WIDTH;
  const effectiveLeftSidebarWidth = () =>
    Math.min(leftSidebarWidth(), responsiveLeftSidebarMaxWidth());
  const leftSidebarCompact = () => effectiveLeftSidebarWidth() <= LEFT_SIDEBAR_COMPACT_WIDTH;
  const online = () => {
    const current = snapshot() as EngineSnapshot & { online?: boolean };
    return current.phase === 'ready' && current.online !== false;
  };
  const activePeerMatches = () => {
    const peerId = activeChatId();
    return peerId !== 'empty' && snapshot().activePeerId === peerId;
  };
  const hasCachedWorkspace = () => snapshot().dialogs.length > 0;
  const canSend = () => online() && activePeerMatches();
  const updateDetailsOpen = (open: boolean) => {
    const scroller = messageScroller();
    if (scroller && !followPresent) historyAnchor = visibleHistoryAnchor(scroller);
    setDetailsOpen(open);
    if (open) setMobileSidebarOpen(false);
    try {
      localStorage.setItem(DETAILS_OPEN_STORAGE_KEY, String(open));
    } catch {
      // The pane still opens and closes when persistent storage is blocked.
    }
  };
  const toggleMobileSidebar = () => {
    setMobileSidebarOpen((open) => !open);
    setDetailsOpen(false);
  };
  const saveLeftSidebarWidth = (width: number) => {
    const next = Math.min(clampLeftSidebarWidth(width), responsiveLeftSidebarMaxWidth());
    setLeftSidebarWidth(next);
    try {
      localStorage.setItem(LEFT_SIDEBAR_STORAGE_KEY, String(next));
    } catch {
      // Resizing remains available when persistent storage is blocked.
    }
  };

  const startLeftSidebarResize = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const scroller = messageScroller();
    if (scroller && !followPresent) historyAnchor = visibleHistoryAnchor(scroller);
    const startWidth = effectiveLeftSidebarWidth();
    let pendingWidth = startWidth;
    let frame: number | undefined;
    setResizingLeftSidebar(true);

    const renderWidth = () => {
      frame = undefined;
      appGridElement?.style.setProperty('--left-sidebar-width', `${pendingWidth}px`);
      const sidebar = appGridElement?.querySelector<HTMLElement>('[data-testid="chat-sidebar"]');
      const compact = pendingWidth <= LEFT_SIDEBAR_COMPACT_WIDTH;
      sidebar?.classList.toggle('compact', compact);
      if (sidebar) sidebar.dataset.compact = String(compact);
    };
    const move = (moveEvent: PointerEvent) => {
      pendingWidth = Math.min(
        clampLeftSidebarWidth(startWidth + moveEvent.clientX - startX),
        responsiveLeftSidebarMaxWidth(),
      );
      if (frame === undefined) frame = requestAnimationFrame(renderWidth);
    };
    const finish = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      renderWidth();
      saveLeftSidebarWidth(pendingWidth);
      setResizingLeftSidebar(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      stopSidebarResize = undefined;
    };
    stopSidebarResize = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const resizeLeftSidebarWithKeyboard = (event: KeyboardEvent) => {
    const width = effectiveLeftSidebarWidth();
    const changes: Record<string, number> = {
      ArrowLeft: width - 16,
      ArrowRight: width + 16,
      Home: LEFT_SIDEBAR_MIN_WIDTH,
      End: responsiveLeftSidebarMaxWidth(),
    };
    const nextWidth = changes[event.key];
    if (nextWidth === undefined) return;
    event.preventDefault();
    const scroller = messageScroller();
    if (scroller && !followPresent) historyAnchor = visibleHistoryAnchor(scroller);
    saveLeftSidebarWidth(nextWidth);
  };

  const visibleChats = createMemo<ChatSummary[]>((previous) => {
    const next = snapshot()
      .dialogs.filter((dialog) => !dialog.transient)
      .map((dialog) => {
        const value = dialogSummary(dialog);
        return stableView(dialogViews, dialog.peer.id, value);
      });
    return reuseArray(previous, next) as ChatSummary[];
  }, []);

  const activeChat = createMemo(() => {
    const listed = visibleChats().find((chat) => chat.id === activeChatId());
    if (listed) return listed;
    const transient = snapshot().dialogs.find(({ peer }) => peer.id === activeChatId());
    if (transient) {
      return stableView(dialogViews, transient.peer.id, dialogSummary(transient));
    }
    return {
      id: 'empty',
      title: 'No chat selected',
      initials: '?',
      color: '#555b66',
      preview: '',
      time: '',
      unread: 0,
    };
  });
  const activeSharedCounts = createMemo(() => snapshot().sharedMediaCounts);
  const activeDialog = createMemo(() =>
    snapshot().dialogs.find(({ peer }) => peer.id === activeChatId()),
  );
  const activeUserDetails = createMemo(
    () => snapshot().dialogs.find(({ peer }) => peer.id === activeChatId())?.userDetails,
  );
  const activeReplyKeyboard = createMemo(() => {
    if (!activePeerMatches()) return undefined;
    for (let index = snapshot().messages.length - 1; index >= 0; index -= 1) {
      const message = snapshot().messages[index];
      if (message?.botKeyboard?.kind === 'reply') {
        return { message, messageId: message.id, keyboard: message.botKeyboard };
      }
    }
    return undefined;
  });
  const visibleReplyKeyboard = createMemo(() => {
    void replyKeyboardRevision();
    const current = activeReplyKeyboard();
    if (!current || current.keyboard.hidden) return undefined;
    const key = `${activeChatId()}:${current.messageId}`;
    return dismissedReplyKeyboards.has(key) ? undefined : current;
  });
  const botStarted = createMemo(
    () =>
      snapshot().messages.some(({ outgoing }) => outgoing) ||
      snapshot().pending.some(
        ({ peer, botStart }) => peer.id === activeChatId() && Boolean(botStart),
      ),
  );
  createEffect(() => {
    const peerId = activeChatId();
    if (botUiPeerId === peerId) return;
    botUiPeerId = peerId;
    botActionGeneration += 1;
    botCommandsLoadGeneration += 1;
    setBotCommands([]);
    setBotCommandsPeerId('');
    setBotCommandsLoading(false);
    setBotMenuOpen(false);
    setBotStarting(false);
    setBotButtonBusy(undefined);
    setBotNotice('');
    setBotUrlAuth(undefined);
    setBotUrlAuthBusy(false);
    setPendingInlineSwitch(undefined);
    if (botNoticeTimer) clearTimeout(botNoticeTimer);
  });
  createEffect(() => {
    const current = visibleReplyKeyboard();
    if (!current?.keyboard.forceReply) return;
    const key = `${activeChatId()}:${current.messageId}`;
    if (handledForceReplies.has(key)) return;
    if (replyTarget() || editingMessage()) return;
    handledForceReplies.add(key);
    setReplyTarget({
      messageId: current.messageId,
      preview: current.message.text || current.message.media?.name || 'The bot requested a reply',
    });
    queueMicrotask(() =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
    );
  });
  createEffect(() => {
    if (snapshot().phase !== 'ready') return;
    const dialog = snapshot().dialogs.find(({ peer }) => peer.id === activeChatId());
    if (dialog?.peer.kind === 'user' && !dialog.userDetails) {
      void engine.getUserDetails(dialog.peer).catch(() => undefined);
    }
  });
  const activeMessageEntries = createMemo<KeyedMessageView[]>(() => {
    if (!activePeerMatches()) return [];
    const readOutboxMaxId =
      snapshot().dialogs.find(({ peer }) => peer.id === activeChatId())?.readOutboxMaxId ?? 0;
    const messagesById = new Map(snapshot().messages.map((message) => [message.id, message]));
    const confirmedRandomIds = new Set(
      snapshot()
        .messages.map(({ randomId }) => randomId)
        .filter((randomId): randomId is string => Boolean(randomId)),
    );
    const current = snapshot().messages.map((message) => {
      const key = message.randomId
        ? `${message.peerId}:random:${message.randomId}`
        : `${message.peerId}:${message.id}`;
      return {
        key,
        message: messageView(
          message,
          readOutboxMaxId,
          message.replyToId ? messagesById.get(message.replyToId) : undefined,
        ),
      };
    });
    const pending = snapshot()
      .pending.filter((send) => send.peer.id === activeChatId())
      .flatMap((send): KeyedMessageView[] => {
        const buildView = (
          id: string,
          randomId: string,
          attachment?: PendingAttachment,
          index = 0,
        ): KeyedMessageView => {
          const first = index === 0;
          const media = send.sticker
            ? {
                kind: 'sticker' as const,
                name: `sticker-${send.sticker.id}`,
                mimeType: send.sticker.mimeType,
              }
            : attachment
              ? pendingAttachmentMedia(attachment)
              : undefined;
          const value: ChatMessage = {
            id,
            author: 'You',
            body: first ? send.text : '',
            time: new Intl.DateTimeFormat(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            }).format(new Date(send.createdAt)),
            date: Math.floor(send.createdAt / 1000),
            outgoing: true,
            status: send.lastError ? 'failed' : 'sending',
            ...(attachment ? { uploadProgress: send.uploadProgress ?? 0 } : {}),
            ...(first
              ? {
                  formats: send.formats?.filter(({ kind }) => kind !== 'textUrl'),
                  links: send.formats
                    ?.filter(({ kind }) => kind === 'textUrl')
                    .map(({ offset, length, url }) => ({ offset, length, url })),
                }
              : {}),
            ...(media ? { media } : {}),
            ...(send.album ? { groupedId: `pending:${send.id}` } : {}),
            ...(first && send.reply
              ? {
                  replyTo:
                    send.reply.quoteText ||
                    messagesById.get(send.reply.messageId)?.text ||
                    'Message',
                  replyToId: send.reply.messageId,
                }
              : {}),
          };
          return { key: `${send.peer.id}:random:${randomId}`, message: value };
        };
        if (send.album) {
          return send.album.attachments.flatMap((attachment, index) =>
            confirmedRandomIds.has(attachment.randomId)
              ? []
              : [buildView(`${send.id}:${index}`, attachment.randomId, attachment, index)],
          );
        }
        if (confirmedRandomIds.has(send.randomId)) return [];
        return [buildView(send.id, send.randomId, send.attachment)];
      });
    return [...current, ...pending];
  });
  const activeMessages = createMemo(() => activeMessageEntries().map(({ message }) => message));
  const pendingSendForMessage = (messageId: string) =>
    snapshot().pending.find(
      (send) =>
        send.id === messageId ||
        Boolean(
          send.album?.attachments.some((_attachment, index) => `${send.id}:${index}` === messageId),
        ),
    );
  const pendingAttachmentForMessage = (messageId: string) => {
    const send = pendingSendForMessage(messageId);
    if (!send) return undefined;
    if (!send.album) return send.attachment;
    const index = send.album.attachments.findIndex(
      (_attachment, candidate) => `${send.id}:${candidate}` === messageId,
    );
    return index >= 0 ? send.album.attachments[index] : undefined;
  };
  const pendingMediaAssetKey = (messageId: string) =>
    `pending-media:${activeChatId()}:${messageId}`;
  const messageWindowBounds = createMemo(() =>
    albumSafeMessageWindow(activeMessages(), messageWindowStart(), MAX_RENDERED_MESSAGES),
  );
  const renderedMessages = createMemo<ChatMessage[]>((previous) => {
    const entries = activeMessageEntries();
    const { start, end } = messageWindowBounds();
    const visibleEntries = entries.slice(start, end);
    const visibleKeys = new Set(visibleEntries.map(({ key }) => key));
    const next = visibleEntries.map(({ key, message }) => stableView(messageViews, key, message));
    for (const key of messageViews.keys()) {
      if (messageViews.size <= MAX_CACHED_MESSAGE_VIEWS) break;
      if (!visibleKeys.has(key)) messageViews.delete(key);
    }
    return reuseArray(previous, next) as ChatMessage[];
  }, []);
  const albumMessages = (message: ChatMessage, index: number) => {
    if (!message.groupedId) return [];
    const visible = renderedMessages();
    if (index > 0 && visible[index - 1]?.groupedId === message.groupedId) return [];
    const grouped: ChatMessage[] = [];
    for (let cursor = index; cursor < visible.length; cursor += 1) {
      const candidate = visible[cursor];
      if (!candidate || candidate.groupedId !== message.groupedId) break;
      if (candidate.media) grouped.push(candidate);
    }
    return grouped.length > 1 ? grouped : [];
  };
  const isAlbumContinuation = (message: ChatMessage, index: number) =>
    Boolean(
      message.groupedId &&
      index > 0 &&
      renderedMessages()[index - 1]?.groupedId === message.groupedId,
    );
  const albumCaptionMessage = (message: ChatMessage, index: number) =>
    albumMessages(message, index).find(({ body }) => Boolean(body)) ?? message;
  createEffect(() => {
    const peerId = activeChatId();
    const messageCount = activeMessages().length;
    void peerId;
    if (followPresent) {
      setMessageWindowStart(Math.max(0, messageCount - MAX_RENDERED_MESSAGES));
    } else {
      setMessageWindowStart((start) => Math.min(start, Math.max(0, messageCount - 1)));
      queueMicrotask(() => {
        if (activeChatId() !== peerId || followPresent) return;
        if (messageWindowBounds().end < activeMessages().length) {
          setJumpToPresentVisible(true);
          reportConversationVisibility();
        }
      });
    }
    queueMicrotask(pruneAssetUrls);
  });
  const activeActivity = createMemo(() =>
    snapshot().activities.find(({ peerId }) => peerId === activeChatId()),
  );
  const messageAuthor = (message: ChatMessage) => {
    if (message.outgoing || activeChat().kind === 'user') return '';
    return (
      snapshot().dialogs.find(({ peer }) => peer.id === message.author)?.title ||
      message.author ||
      activeChat().title
    );
  };
  const rendersVisualMedia = (message: ChatMessage) =>
    message.media?.kind === 'photo' ||
    message.media?.kind === 'video' ||
    (message.media?.kind === 'animation' && message.media.mimeType.startsWith('video/'));
  const isMediaOnlySurface = (message: ChatMessage, index: number) => {
    const album = albumMessages(message, index);
    const isAlbum = album.length > 1;
    return Boolean(
      ((isAlbum && album.every(({ uploadProgress }) => uploadProgress === undefined)) ||
        (rendersVisualMedia(message) && message.uploadProgress === undefined)) &&
      !albumCaptionMessage(message, index).body.trim() &&
      !messageAuthor(message) &&
      !message.replyTo &&
      !message.linkPreview &&
      !message.botKeyboard &&
      !message.reactions?.length &&
      message.status !== 'failed',
    );
  };
  const hasInlineTextTime = (message: ChatMessage, index: number) =>
    Boolean(
      !message.service &&
      albumMessages(message, index).length === 0 &&
      !message.media &&
      message.body.trim() &&
      !message.linkPreview &&
      message.botKeyboard?.kind !== 'inline',
    );
  const isCaptionedMediaPost = (message: ChatMessage, index: number) => {
    const album = albumMessages(message, index);
    const hasSupplementaryContent = Boolean(
      albumCaptionMessage(message, index).body.trim() ||
      messageAuthor(message) ||
      message.replyTo ||
      message.botKeyboard ||
      message.reactions?.length,
    );
    return Boolean(
      !message.service &&
      (album.length > 1 || rendersVisualMedia(message)) &&
      hasSupplementaryContent &&
      (album.length > 1
        ? album.every(({ uploadProgress }) => uploadProgress === undefined)
        : message.uploadProgress === undefined) &&
      message.status !== 'failed' &&
      !message.linkPreview,
    );
  };
  const visualMediaWidth = (message: ChatMessage, index: number) => {
    const album = albumMessages(message, index);
    if (album.length > 1) {
      return album.every(({ uploadProgress }) => uploadProgress === undefined) &&
        message.status !== 'failed'
        ? 'min(24rem, 100%)'
        : undefined;
    }
    if (
      !rendersVisualMedia(message) ||
      message.uploadProgress !== undefined ||
      message.status === 'failed'
    ) {
      return undefined;
    }
    const width = message.media?.width;
    const height = message.media?.height;
    if (!width || !height) return 'min(20rem, 100%)';
    return `min(${Math.max(12, Math.min(20, (24 * width) / height))}rem, 100%)`;
  };
  const cropsExtremePortraitMedia = (message: ChatMessage, index: number) => {
    if (albumMessages(message, index).length > 1 || !rendersVisualMedia(message)) return false;
    const width = message.media?.width;
    const height = message.media?.height;
    return Boolean(width && height && width / height < 0.5);
  };
  const activeStatus = createMemo(() => {
    const chat = activeChat();
    if (chat.id === 'empty') return 'Choose a chat';
    if (snapshot().phase === 'connecting') return 'connecting…';
    if (snapshot().phase === 'syncing') return 'syncing…';
    if (!online()) return 'offline · cached conversation';
    const activity = activeActivity();
    if (activity?.kind === 'typing') return 'typing…';
    if (activity?.kind === 'uploading') return 'uploading…';
    if (activity?.kind === 'recording') return 'recording…';
    if (activity?.kind === 'choosing-sticker') return 'choosing a sticker…';
    if (chat.kind === 'channel') return 'channel';
    if (chat.kind === 'group') return 'group';
    if (chat.presence === 'online') return 'online';
    if (chat.lastSeenAt) {
      const seen = new Date(chat.lastSeenAt * 1000);
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const time = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      }).format(seen);
      if (seen.toDateString() === today.toDateString()) return `last seen today at ${time}`;
      if (seen.toDateString() === yesterday.toDateString()) return `last seen yesterday at ${time}`;
      return `last seen ${new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
      }).format(seen)}`;
    }
    if (chat.presence === 'recently') return 'last seen recently';
    if (chat.presence === 'offline') return 'offline';
    return chat.kind === 'user' ? 'status unavailable' : '';
  });
  const activePinnedMessage = createMemo(() =>
    activePeerMatches() ? snapshot().pinnedMessages[pinnedMessageIndex()] : undefined,
  );
  let pinnedMessageSetKey = '';
  createEffect(() => {
    const key = `${activeChatId()}:${snapshot()
      .pinnedMessages.map(({ id }) => id)
      .join(',')}`;
    if (key === pinnedMessageSetKey) return;
    pinnedMessageSetKey = key;
    setPinnedMessageIndex(0);
  });
  const activeConversationLoaded = createMemo(() => {
    const current = snapshot();
    return (
      current.activePeerId === activeChatId() &&
      (!current.loadingMessages || current.messages.length > 0)
    );
  });

  const selectChat = async (
    id: string,
    linkedOpenGeneration?: number,
    linkedPeerOpenGeneration?: number,
  ) => {
    if (linkedPeerOpenGeneration === undefined) {
      peerOpenGeneration += 1;
    } else if (linkedPeerOpenGeneration !== peerOpenGeneration) {
      return false;
    }
    if (linkedOpenGeneration === undefined) {
      openMessageGeneration += 1;
      openingMessage = false;
    } else if (linkedOpenGeneration !== openMessageGeneration) {
      return false;
    }
    if (
      id === activeChatId() &&
      activePeerMatches() &&
      !snapshot().loadingMessages &&
      snapshot().messages.length > 0 &&
      snapshot().sharedMediaCounts
    ) {
      return activePeerMatches();
    }
    const generation = ++selectionGeneration;
    const previousPeerId = activeChatId();
    const changingPeer = id !== previousPeerId;
    if (changingPeer) {
      invalidatePresentAlignment();
      historyLoadGeneration += 1;
      historyRestoreGeneration += 1;
      olderLoadRunning = false;
      olderLoadQueued = false;
      if (editingDraftRestore) {
        rememberAttachmentDraft(editingDraftRestore.peerId, editingDraftRestore.attachments);
        editingDraftRestore = undefined;
      } else {
        rememberAttachmentDraft(previousPeerId, composerAttachments());
      }
      followPresent = true;
      historyAnchor = undefined;
      setMessageWindowStart(0);
      setJumpToPresentVisible(false);
      setConversationReady(false);
    }
    setConversationLoadError('');
    setActiveChatId(id);
    setMobileSidebarOpen(false);
    setStickerPickerOpen(false);
    setGifPickerOpen(false);
    setSearchOpen(false);
    setReactionPickerMessageId('');
    if (changingPeer) {
      setReplyTarget(undefined);
      setComposerAttachments(cloneAttachments(attachmentDrafts.get(id) ?? []));
      setEditingMessage(undefined);
      setDraftFormats([]);
    }
    if (typingTimer) clearTimeout(typingTimer);
    if (typingPeerId) {
      const previous = snapshot().dialogs.find(({ peer }) => peer.id === typingPeerId);
      if (previous) void engine.setTyping(previous.peer);
      typingPeerId = '';
    }
    if (changingPeer) setDraft(snapshot().drafts[id] ?? '');
    try {
      await engine.selectChat(id);
      if (generation !== selectionGeneration || activeChatId() !== id) return false;
      const current = engine.snapshot();
      if (
        current.activePeerId === id &&
        !current.loadingMessages &&
        current.messages.length === 0 &&
        current.historyError
      ) {
        setConversationLoadError(current.historyError);
      }
      return current.activePeerId === id;
    } catch (cause) {
      if (generation === selectionGeneration && activeChatId() === id)
        setConversationLoadError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };

  const retryConversation = async () => {
    if (conversationRetrying() || activeChatId() === 'empty') return;
    setConversationRetrying(true);
    setConversationLoadError('');
    setConversationReady(false);
    try {
      if (!engine.snapshot().online) await engine.retrySync();
      await engine.retryHistory();
      const current = engine.snapshot();
      if (!current.loadingMessages && current.messages.length === 0 && current.historyError) {
        setConversationLoadError(current.historyError);
      }
    } catch (cause) {
      setConversationLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConversationRetrying(false);
      setConversationReady(true);
    }
  };

  const retrySync = async () => {
    if (syncRetrying()) return;
    setSyncRetrying(true);
    try {
      await engine.retrySync();
      if (engine.snapshot().online) await engine.retryOutbox();
    } finally {
      setSyncRetrying(false);
    }
  };

  const retryPendingSend = async (id: string) => {
    if (pendingActionId()) return;
    setPendingActionId(id);
    try {
      await engine.retryPendingSend(id);
    } finally {
      setPendingActionId('');
    }
  };

  const cancelPendingSend = async (id: string) => {
    if (pendingActionId()) return;
    setPendingActionId(id);
    try {
      await engine.cancelPendingSend(id);
    } finally {
      setPendingActionId('');
    }
  };

  const reportConversationVisibility = () => {
    if (visibilityFrame !== undefined) return;
    visibilityFrame = requestAnimationFrame(() => {
      visibilityFrame = undefined;
      const peerId = activeChatId();
      if (!peerId || peerId === 'empty') return;
      const scroller = messageScroller();
      const windowIncludesPresent = messageWindowBounds().end >= activeMessages().length;
      const atBottom = scroller
        ? windowIncludesPresent &&
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 8
        : false;
      const obscured =
        mobileSidebarOpen() ||
        (detailsOpen() && window.matchMedia('(max-width: 1100px)').matches) ||
        searchOpen() ||
        Boolean(sharedMediaKind()) ||
        Boolean(forwardingMessage()) ||
        Boolean(deleteTarget()) ||
        Boolean(deleteChatTarget()) ||
        Boolean(pendingInlineSwitch()) ||
        expressionPickerVisible() ||
        botMenuOpen() ||
        authOpen() ||
        Boolean(document.querySelector('[aria-modal="true"]'));
      runInBackground(
        Promise.resolve(
          engine.setActiveConversationVisibility(peerId, {
            visible: document.visibilityState === 'visible' && document.hasFocus() && !obscured,
            atBottom,
          }),
        ),
      );
    });
  };

  createEffect(() => {
    void activeChatId();
    void mobileSidebarOpen();
    void detailsOpen();
    void searchOpen();
    void sharedMediaKind();
    void forwardingMessage();
    void deleteTarget();
    void deleteChatTarget();
    void pendingInlineSwitch();
    void expressionPickerVisible();
    void botMenuOpen();
    void authOpen();
    reportConversationVisibility();
  });

  createEffect(() => {
    const sidebarModal = mobileSidebarOpen() && viewportWidth() <= 650;
    const detailsModal = detailsOpen() && viewportWidth() <= 1100;
    if (!sidebarModal && !detailsModal) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const sidebar = appGridElement?.querySelector<HTMLElement>('[data-testid="chat-sidebar"]');
    const details = appGridElement?.querySelector<HTMLElement>('.details-pane');
    const panel = sidebarModal ? sidebar : details;
    const inerted: Array<{ element: HTMLElement; previous: boolean }> = [];
    const makeInert = (element: HTMLElement | null | undefined) => {
      if (!element) return;
      inerted.push({ element, previous: element.inert });
      element.inert = true;
    };
    makeInert(conversationPaneElement);
    if (detailsModal) makeInert(sidebar);

    const focusableSelector =
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const focusableElements = () =>
      [...(panel?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])].filter(
        (element) => !element.hidden && element.getClientRects().length > 0,
      );
    const handleDrawerKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (sidebarModal) setMobileSidebarOpen(false);
        else updateDetailsOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (
        event.shiftKey &&
        (document.activeElement === first || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    let active = true;
    document.addEventListener('keydown', handleDrawerKeyDown, true);
    const focusFrame = requestAnimationFrame(() => {
      if (!active) return;
      const target = panel?.querySelector<HTMLElement>('button[aria-label^="Close"]');
      target?.focus();
      if (panel && document.activeElement !== target) panel.focus();
    });

    onCleanup(() => {
      active = false;
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleDrawerKeyDown, true);
      for (const { element, previous } of inerted) element.inert = previous;
      requestAnimationFrame(() => {
        const fallback = sidebarModal
          ? mobileSidebarTriggerElement
          : document.querySelector<HTMLElement>('button[aria-label="Open details"]');
        const target = fallback ?? (previouslyFocused?.isConnected ? previouslyFocused : undefined);
        target?.focus();
      });
    });
  });

  const loadPeerAvatar = (
    peer: TelegramPeer,
    hasAvatar: boolean,
    avatarId: string | undefined,
    cachedOnly = false,
  ) => {
    if (!hasAvatar) return Promise.resolve(undefined);
    const key = `${peer.id}:${avatarId ?? 'unknown'}`;
    const current = avatarLoads.get(key);
    if (current) return current;
    const blob = cachedOnly
      ? engine.loadCachedAvatar(peer, avatarId)
      : engine.downloadAvatar(peer, avatarId);
    const loading = blob.then((blob) => {
      if (!blob) return undefined;
      const url = URL.createObjectURL(blob);
      avatarUrls.add(url);
      return url;
    });
    avatarLoads.set(key, loading);
    void loading.then(
      (url) => {
        if (!url) avatarLoads.delete(key);
      },
      () => avatarLoads.delete(key),
    );
    return loading;
  };

  const loadAvatar = (peerId: string, cachedOnly = false) => {
    const dialog = snapshot().dialogs.find(({ peer }) => peer.id === peerId);
    return dialog
      ? loadPeerAvatar(dialog.peer, dialog.hasAvatar, dialog.avatarId, cachedOnly)
      : Promise.resolve(undefined);
  };

  const avatarIdentity = (peerId: string) => {
    const dialog = snapshot().dialogs.find(({ peer }) => peer.id === peerId);
    return `${peerId}:${dialog?.avatarId ?? 'none'}`;
  };

  const loadMedia = (message: TelegramMessage) => {
    return loadAssetUrl(engine.mediaAssetKey(message), () => engine.downloadMedia(message));
  };
  const mediaSourceFor = (messageId: string | number) =>
    snapshot().messages.find((candidate) => String(candidate.id) === String(messageId));

  const alignScrollerToPresent = (scroller: HTMLDivElement, settled?: () => void) => {
    const writeGeneration = ++presentScrollWriteGeneration;
    presentScrollWriteActive = true;
    if (presentScrollFrame !== undefined) cancelAnimationFrame(presentScrollFrame);
    const align = () => {
      if (writeGeneration !== presentScrollWriteGeneration) return;
      if (!followPresent && !positioningPresent) {
        presentScrollWriteActive = false;
        presentScrollFrame = undefined;
        return;
      }
      scroller.scrollTop = scroller.scrollHeight;
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (distance > 2) {
        presentScrollFrame = requestAnimationFrame(align);
        return;
      }
      presentScrollFrame = requestAnimationFrame(() => {
        if (writeGeneration !== presentScrollWriteGeneration) return;
        const finalDistance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (finalDistance > 2) {
          presentScrollFrame = requestAnimationFrame(align);
          return;
        }
        presentScrollWriteActive = false;
        presentScrollFrame = undefined;
        if (followPresent) {
          setJumpToPresentVisible(false);
          reportConversationVisibility();
        }
        settled?.();
      });
    };
    align();
  };

  createEffect(() => {
    const peerId = activeChatId();
    if (!peerId || !activeConversationLoaded()) return;
    if (openingMessage) {
      invalidatePresentAlignment();
      followPresent = false;
      setConversationReady(true);
      return;
    }
    invalidatePresentAlignment();
    const positionGeneration = presentPositionGeneration;
    positioningPresent = true;
    followPresent = true;
    setMessageWindowStart(
      Math.max(0, untrack(() => activeMessages().length) - MAX_RENDERED_MESSAGES),
    );
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (
          positionGeneration !== presentPositionGeneration ||
          activeChatId() !== peerId ||
          !activeConversationLoaded()
        ) {
          return;
        }
        const scroller = messageScroller();
        if (!scroller) {
          positioningPresent = false;
          setConversationReady(true);
          return;
        }
        alignScrollerToPresent(scroller, () => {
          if (
            positionGeneration !== presentPositionGeneration ||
            activeChatId() !== peerId ||
            !activeConversationLoaded()
          ) {
            return;
          }
          positioningPresent = false;
          setJumpToPresentVisible(false);
          setConversationReady(true);
          reportConversationVisibility();
        });
      });
    });
  });

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const updateJumpToPresent = (scroller: HTMLDivElement, allowFollowingAtPresent = false) => {
    const distanceFromPresent = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const windowIncludesPresent = messageWindowBounds().end >= activeMessages().length;
    if (
      allowFollowingAtPresent &&
      distanceFromPresent <= PRESENT_SCROLL_EPSILON &&
      windowIncludesPresent
    ) {
      followPresent = true;
      historyAnchor = undefined;
    } else if (distanceFromPresent > PRESENT_SCROLL_EPSILON || !windowIncludesPresent) {
      followPresent = false;
      historyAnchor = visibleHistoryAnchor(scroller);
    }
    setJumpToPresentVisible(!windowIncludesPresent || distanceFromPresent > 160);
    reportConversationVisibility();
  };

  const jumpToPresent = () => {
    const scroller = messageScroller();
    if (!scroller) return;
    invalidatePresentAlignment();
    openMessageGeneration += 1;
    openingMessage = false;
    const peerId = activeChatId();
    const positionGeneration = presentPositionGeneration;
    followPresent = true;
    historyAnchor = undefined;
    setMessageWindowStart(Math.max(0, activeMessages().length - MAX_RENDERED_MESSAGES));
    requestAnimationFrame(() => {
      if (
        positionGeneration !== presentPositionGeneration ||
        activeChatId() !== peerId ||
        messageScroller() !== scroller ||
        !followPresent
      ) {
        return;
      }
      alignScrollerToPresent(scroller, () => {
        if (positionGeneration !== presentPositionGeneration || activeChatId() !== peerId) return;
        setJumpToPresentVisible(false);
        reportConversationVisibility();
      });
    });
  };

  const visibleHistoryAnchor = (scroller: HTMLDivElement) => {
    const top = scroller.getBoundingClientRect().top;
    const message = [...scroller.querySelectorAll<HTMLElement>('article.message')].find(
      (candidate) => candidate.getBoundingClientRect().bottom >= top,
    );
    return message?.dataset.messageId
      ? { messageId: message.dataset.messageId, top: message.getBoundingClientRect().top }
      : undefined;
  };

  const stopFollowingPresentForUser = (scroller: HTMLDivElement) => {
    invalidatePresentAlignment();
    openMessageGeneration += 1;
    openingMessage = false;
    historyRestoreGeneration += 1;
    followPresent = false;
    historyAnchor = visibleHistoryAnchor(scroller);
    setConversationReady(true);
    const distanceFromPresent = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const windowIncludesPresent = messageWindowBounds().end >= activeMessages().length;
    setJumpToPresentVisible(!windowIncludesPresent || distanceFromPresent > 160);
    reportConversationVisibility();
  };

  const preserveReadingPositionIfAwayFromPresent = (scroller: HTMLDivElement) => {
    const distanceFromPresent = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const windowIncludesPresent = messageWindowBounds().end >= activeMessages().length;
    if (!windowIncludesPresent || distanceFromPresent > 8) {
      stopFollowingPresentForUser(scroller);
    }
  };

  const restoreHistoryAnchor = (scroller: HTMLDivElement, anchor = historyAnchor) => {
    if (!anchor) return;
    const message = scroller.querySelector<HTMLElement>(
      `article[data-message-id="${CSS.escape(anchor.messageId)}"]`,
    );
    if (message) scroller.scrollTop += message.getBoundingClientRect().top - anchor.top;
  };

  const shiftMessageWindow = (direction: -1 | 1) => {
    const scroller = messageScroller();
    if (!scroller) return;
    invalidatePresentAlignment();
    openMessageGeneration += 1;
    openingMessage = false;
    followPresent = false;
    const restoreAnchor = visibleHistoryAnchor(scroller);
    historyAnchor = restoreAnchor;
    const peerId = activeChatId();
    const restoreGeneration = ++historyRestoreGeneration;
    const maxStart = Math.max(0, activeMessages().length - MAX_RENDERED_MESSAGES);
    const nextStart = Math.max(
      0,
      Math.min(maxStart, messageWindowStart() + direction * (MAX_RENDERED_MESSAGES / 2)),
    );
    setMessageWindowStart(nextStart);
    requestAnimationFrame(() => {
      if (
        restoreGeneration !== historyRestoreGeneration ||
        activeChatId() !== peerId ||
        messageScroller() !== scroller
      ) {
        return;
      }
      historyAnchor = restoreAnchor;
      restoreHistoryAnchor(scroller, restoreAnchor);
      requestAnimationFrame(() => {
        if (
          restoreGeneration !== historyRestoreGeneration ||
          activeChatId() !== peerId ||
          messageScroller() !== scroller
        ) {
          return;
        }
        historyAnchor = restoreAnchor;
        restoreHistoryAnchor(scroller, restoreAnchor);
        updateJumpToPresent(scroller);
      });
    });
  };

  const loadOlderAtTop = async (scroller: HTMLDivElement) => {
    if (scroller.scrollTop <= 120 && messageWindowStart() > 0) {
      shiftMessageWindow(-1);
      return;
    }
    if (
      scroller.scrollTop > 120 ||
      !snapshot().hasOlderMessages ||
      snapshot().historyError ||
      !activePeerMatches()
    ) {
      return;
    }
    followPresent = false;
    if (olderLoadRunning || snapshot().loadingOlderMessages) {
      olderLoadQueued = true;
      return;
    }

    const generation = ++historyLoadGeneration;
    const peerId = activeChatId();
    const restoreGeneration = ++historyRestoreGeneration;
    olderLoadRunning = true;
    try {
      let pagesLoaded = 0;
      do {
        if (generation !== historyLoadGeneration || activeChatId() !== peerId) break;
        olderLoadQueued = false;
        const pageAnchor = visibleHistoryAnchor(scroller);
        historyAnchor = pageAnchor;
        const before = snapshot();
        const beforeCount = before.messages.length;
        const beforeOldestId = before.messages[0]?.id;
        const beforeHasOlder = before.hasOlderMessages;
        await engine.loadOlderMessages();
        pagesLoaded += 1;
        if (generation !== historyLoadGeneration || activeChatId() !== peerId) break;
        const after = snapshot();
        const madeProgress =
          after.messages.length !== beforeCount ||
          after.messages[0]?.id !== beforeOldestId ||
          after.hasOlderMessages !== beforeHasOlder;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            if (
              generation === historyLoadGeneration &&
              restoreGeneration === historyRestoreGeneration &&
              activeChatId() === peerId &&
              messageScroller() === scroller
            ) {
              historyAnchor = pageAnchor;
              restoreHistoryAnchor(scroller, pageAnchor);
            }
            requestAnimationFrame(() => {
              if (
                generation === historyLoadGeneration &&
                restoreGeneration === historyRestoreGeneration &&
                activeChatId() === peerId &&
                messageScroller() === scroller
              ) {
                historyAnchor = pageAnchor;
                restoreHistoryAnchor(scroller, pageAnchor);
              }
              resolve();
            });
          });
        });
        if (!madeProgress || after.historyError || !online() || pagesLoaded >= 8) break;
      } while (
        generation === historyLoadGeneration &&
        activeChatId() === peerId &&
        snapshot().hasOlderMessages &&
        (olderLoadQueued || scroller.scrollHeight <= scroller.clientHeight + 120)
      );
    } finally {
      if (generation === historyLoadGeneration) {
        olderLoadRunning = false;
        olderLoadQueued = false;
      }
    }
  };

  const loadHistoryGap = async (gap: TelegramHistoryGap) => {
    const scroller = messageScroller();
    if (!scroller || olderLoadRunning || snapshot().loadingOlderMessages) return;
    invalidatePresentAlignment();
    followPresent = false;
    setConversationReady(true);
    const generation = ++historyLoadGeneration;
    const peerId = activeChatId();
    const restoreGeneration = ++historyRestoreGeneration;
    olderLoadRunning = true;
    olderLoadQueued = false;
    const restoreAnchor = visibleHistoryAnchor(scroller);
    historyAnchor = restoreAnchor;
    try {
      await engine.loadHistoryGap(gap);
      if (generation !== historyLoadGeneration || activeChatId() !== peerId) return;
      await nextFrame();
      if (
        generation !== historyLoadGeneration ||
        restoreGeneration !== historyRestoreGeneration ||
        activeChatId() !== peerId ||
        messageScroller() !== scroller
      ) {
        return;
      }
      historyAnchor = restoreAnchor;
      restoreHistoryAnchor(scroller, restoreAnchor);
      await nextFrame();
      if (
        generation !== historyLoadGeneration ||
        restoreGeneration !== historyRestoreGeneration ||
        activeChatId() !== peerId ||
        messageScroller() !== scroller
      ) {
        return;
      }
      historyAnchor = restoreAnchor;
      restoreHistoryAnchor(scroller, restoreAnchor);
      updateJumpToPresent(scroller);
    } finally {
      if (generation === historyLoadGeneration) {
        olderLoadRunning = false;
        olderLoadQueued = false;
      }
    }
  };

  const gapBefore = (message: ChatMessage) => {
    const messageId = Number(message.id);
    if (!Number.isSafeInteger(messageId)) return undefined;
    return (snapshot().historyGaps ?? []).find(
      ({ newerMinMessageId }) => newerMinMessageId === messageId,
    );
  };

  const handleMessageScrollerPointerDown = (event: PointerEvent) => {
    const scroller = messageScroller();
    if (!scroller) return;
    if (event.pointerType === 'touch') {
      touchScrollStart = { x: event.clientX, y: event.clientY };
      return;
    }
    const bounds = scroller.getBoundingClientRect();
    const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth;
    const isScrollbarPointer = scrollbarWidth > 0 && event.clientX >= bounds.right - scrollbarWidth;
    if (isScrollbarPointer || event.button === 1) {
      pointerScrollActive = true;
      markUserScrollIntent();
      stopFollowingPresentForUser(scroller);
    } else {
      clearUserScrollIntent();
      preserveReadingPositionIfAwayFromPresent(scroller);
    }
  };

  const handleMessageScrollerPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !touchScrollStart) return;
    if (
      Math.abs(event.clientX - touchScrollStart.x) < 4 &&
      Math.abs(event.clientY - touchScrollStart.y) < 4
    ) {
      return;
    }
    const direction = event.clientY > touchScrollStart.y ? -1 : 1;
    touchScrollStart = undefined;
    pointerScrollActive = true;
    markUserScrollIntent(direction);
    const scroller = messageScroller();
    if (scroller) stopFollowingPresentForUser(scroller);
  };

  const clearTouchScrollStart = () => {
    touchScrollStart = undefined;
    if (pointerScrollActive) markUserScrollIntent();
    pointerScrollActive = false;
  };

  onMount(() => {
    let narrowLayout = window.innerWidth <= 1100;
    const scroller = messageScroller();
    const content = messageContent();
    const resizeObserver =
      scroller && content
        ? new ResizeObserver(() => {
            if (positioningPresent) {
              reportConversationVisibility();
              return;
            }
            if (followPresent) alignScrollerToPresent(scroller);
            else {
              restoreHistoryAnchor(scroller);
              historyAnchor ??= visibleHistoryAnchor(scroller);
              const distanceFromPresent =
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
              const windowIncludesPresent = messageWindowBounds().end >= activeMessages().length;
              setJumpToPresentVisible(!windowIncludesPresent || distanceFromPresent > 160);
            }
            reportConversationVisibility();
          })
        : undefined;
    if (content) resizeObserver?.observe(content);
    if (scroller) resizeObserver?.observe(scroller);
    scroller?.addEventListener('pointerdown', handleMessageScrollerPointerDown, true);
    scroller?.addEventListener('pointermove', handleMessageScrollerPointerMove, true);
    scroller?.addEventListener('pointerup', clearTouchScrollStart, true);
    scroller?.addEventListener('pointercancel', clearTouchScrollStart, true);
    const dismissMenus = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest?.('.message-context-menu')) setMessageContextMenu(undefined);
      if (!target.closest?.('.reaction-picker')) setReactionPickerMessageId('');
      if (!target.closest?.('.bot-command-bar')) setBotMenuOpen(false);
    };
    const dismissMenusWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (
        messageContextMenu() ||
        reactionPickerMessageId() ||
        forwardingMessage() ||
        pendingInlineSwitch() ||
        botMenuOpen()
      ) {
        setMessageContextMenu(undefined);
        setReactionPickerMessageId('');
        setForwardingMessage(undefined);
        setPendingInlineSwitch(undefined);
        setBotMenuOpen(false);
        return;
      }
      if (mobileSidebarOpen() && viewportWidth() <= 650) {
        event.preventDefault();
        setMobileSidebarOpen(false);
        return;
      }
      if (detailsOpen() && viewportWidth() <= 1100) {
        event.preventDefault();
        updateDetailsOpen(false);
        return;
      }
      setMessageContextMenu(undefined);
      setReactionPickerMessageId('');
      setForwardingMessage(undefined);
    };
    document.addEventListener('pointerdown', dismissMenus);
    document.addEventListener('keydown', dismissMenusWithKeyboard);
    let telegramResume: Promise<void> | undefined;
    const resumeTelegramState = () => {
      if (telegramResume) return;
      const resume = (async () => {
        let current = engine.snapshot();
        if (current.phase !== 'ready') return;
        if (current.online) {
          try {
            await Promise.all([engine.refreshUpdates(), engine.refreshReadReceipt()]);
          } catch {
            // The engine records the failure. Re-read its state below so a failed
            // wake-up refresh can enter the normal reconnect path.
          }
        }
        await Promise.resolve();
        current = engine.snapshot();
        if (current.phase !== 'ready') return;
        if (!current.online) await engine.retrySync();
        if (engine.snapshot().online) await engine.retryOutbox();
      })();
      telegramResume = resume;
      runInBackground(
        resume.finally(() => {
          if (telegramResume === resume) telegramResume = undefined;
        }),
      );
    };
    const handleFocus = () => {
      reportConversationVisibility();
      resumeTelegramState();
    };
    const refreshVisibleTelegramState = () => {
      if (document.visibilityState === 'visible') resumeTelegramState();
      reportConversationVisibility();
    };
    const handleResize = () => {
      if (scroller && !followPresent) historyAnchor = visibleHistoryAnchor(scroller);
      const nextNarrowLayout = window.innerWidth <= 1100;
      setViewportWidth(window.innerWidth);
      if (nextNarrowLayout && !narrowLayout) setDetailsOpen(false);
      narrowLayout = nextNarrowLayout;
      if (window.innerWidth > 650) setMobileSidebarOpen(false);
      reportConversationVisibility();
    };
    const recoverOnlineConnection = () => resumeTelegramState();
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', reportConversationVisibility);
    window.addEventListener('resize', handleResize);
    window.addEventListener('online', recoverOnlineConnection);
    document.addEventListener('visibilitychange', refreshVisibleTelegramState);
    document.addEventListener('televecha:modal-visibility-change', reportConversationVisibility);

    const unsubscribe = engine.subscribe((next) => {
      setSnapshot(next);
      if (next.phase === 'unauthorized') {
        setAuthOpen(true);
      } else if (
        next.dialogs.length > 0 &&
        (next.phase === 'connecting' ||
          next.phase === 'syncing' ||
          next.phase === 'ready' ||
          next.phase === 'error')
      ) {
        setAuthOpen(false);
      } else if (
        next.phase === 'connecting' ||
        next.phase === 'syncing' ||
        next.phase === 'error'
      ) {
        setAuthOpen(true);
      }
      const currentPeerId = activeChatId();
      const currentExists = next.dialogs.some(({ peer }) => peer.id === currentPeerId);
      if (next.dialogs.length === 0) {
        if (currentPeerId !== 'empty') {
          invalidatePresentAlignment();
          selectionGeneration += 1;
          historyLoadGeneration += 1;
          historyRestoreGeneration += 1;
          olderLoadRunning = false;
          olderLoadQueued = false;
          setActiveChatId('empty');
          setDraft('');
          setDraftFormats([]);
          setSearchOpen(false);
          setSharedMediaKind(undefined);
          setReplyTarget(undefined);
          setEditingMessage(undefined);
          setComposerAttachments([]);
        }
      } else if (next.phase !== 'unauthorized' && !currentExists) {
        const enginePeerExists = next.dialogs.some(({ peer }) => peer.id === next.activePeerId);
        const target = enginePeerExists ? next.activePeerId : next.dialogs[0]?.peer.id;
        if (target) runInBackground(selectChat(target));
      }
    });
    if (credentials && engine.snapshot().phase === 'idle') void engine.start(credentials);

    onCleanup(() => {
      stopSidebarResize?.();
      if (typingTimer) clearTimeout(typingTimer);
      if (botNoticeTimer) clearTimeout(botNoticeTimer);
      unsubscribe();
      resizeObserver?.disconnect();
      scroller?.removeEventListener('pointerdown', handleMessageScrollerPointerDown, true);
      scroller?.removeEventListener('pointermove', handleMessageScrollerPointerMove, true);
      scroller?.removeEventListener('pointerup', clearTouchScrollStart, true);
      scroller?.removeEventListener('pointercancel', clearTouchScrollStart, true);
      document.removeEventListener('pointerdown', dismissMenus);
      document.removeEventListener('keydown', dismissMenusWithKeyboard);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', reportConversationVisibility);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('online', recoverOnlineConnection);
      document.removeEventListener('visibilitychange', refreshVisibleTelegramState);
      document.removeEventListener(
        'televecha:modal-visibility-change',
        reportConversationVisibility,
      );
      if (visibilityFrame !== undefined) cancelAnimationFrame(visibilityFrame);
      const peerId = activeChatId();
      if (peerId && peerId !== 'empty') {
        runInBackground(
          Promise.resolve(
            engine.setActiveConversationVisibility(peerId, { visible: false, atBottom: false }),
          ),
        );
      }
      for (const url of avatarUrls) URL.revokeObjectURL(url);
      if (!import.meta.hot) runInBackground(engine.stop());
    });
  });

  const showBotNotice = (message: string) => {
    if (botNoticeTimer) clearTimeout(botNoticeTimer);
    setBotNotice(message);
    botNoticeTimer = setTimeout(() => {
      setBotNotice('');
      botNoticeTimer = undefined;
    }, 5_000);
  };

  const openBotUrl = (value: string | undefined) => {
    const url = safeExternalUrl(value);
    if (!url) {
      showBotNotice('Telegram returned an unsafe or invalid link.');
      return;
    }
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) showBotNotice('The browser blocked the new tab.');
  };

  const loadBotCommands = async () => {
    const dialog = activeDialog();
    const supportsCommands = dialog?.bot || (dialog && dialog.peer.kind !== 'user');
    if (
      !dialog ||
      !supportsCommands ||
      botCommandsLoading() ||
      botCommandsPeerId() === dialog.peer.id
    )
      return;
    const peerId = dialog.peer.id;
    const loadGeneration = ++botCommandsLoadGeneration;
    setBotCommandsLoading(true);
    try {
      const commands = await engine.getBotCommands(dialog.peer);
      if (activeChatId() !== peerId || loadGeneration !== botCommandsLoadGeneration) return;
      setBotCommands(commands);
      setBotCommandsPeerId(peerId);
    } finally {
      if (activeChatId() === peerId && loadGeneration === botCommandsLoadGeneration) {
        setBotCommandsLoading(false);
      }
    }
  };

  let observedBotCommandsRevision = snapshot().botCommandsRevision;
  createEffect(() => {
    const revision = snapshot().botCommandsRevision;
    if (revision === observedBotCommandsRevision) return;
    observedBotCommandsRevision = revision;
    const hadLoadedCommands = botCommandsPeerId() === activeChatId();
    botCommandsLoadGeneration += 1;
    setBotCommands([]);
    setBotCommandsPeerId('');
    setBotCommandsLoading(false);
    const dialog = activeDialog();
    if (
      (dialog?.bot || (dialog && dialog.peer.kind !== 'user')) &&
      (hadLoadedCommands || botMenuOpen())
    ) {
      runInBackground(loadBotCommands());
    }
  });

  const toggleBotMenu = () => {
    const open = !botMenuOpen();
    setBotMenuOpen(open);
    if (open) runInBackground(loadBotCommands());
  };

  const startActiveBot = async () => {
    const dialog = activeDialog();
    if (!dialog?.bot || botStarting()) return;
    const peerId = dialog.peer.id;
    setBotStarting(true);
    setBotMenuOpen(false);
    try {
      await engine.startBot(dialog.peer);
    } finally {
      if (activeChatId() === peerId) setBotStarting(false);
    }
  };

  const sendBotCommand = (command: TelegramBotCommand) => {
    const dialog = activeDialog();
    if (!dialog) return;
    setBotMenuOpen(false);
    const suffix = dialog.bot || !command.botUsername ? '' : `@${command.botUsername}`;
    runInBackground(engine.sendDraft(dialog.peer, `/${command.command}${suffix}`));
  };

  const dismissSingleUseReplyKeyboard = (owner: string) => {
    if (owner !== 'reply') return;
    const current = visibleReplyKeyboard();
    if (!current?.keyboard.singleUse) return;
    dismissedReplyKeyboards.add(`${activeChatId()}:${current.messageId}`);
    setReplyKeyboardRevision((revision) => revision + 1);
  };

  const botActionStillCurrent = (peerId: string, generation: number) =>
    activeChatId() === peerId && botActionGeneration === generation;

  const pressBotButton = async (
    button: TelegramBotButton,
    owner: string,
    key: string,
    messageId?: number,
  ) => {
    const dialog = activeDialog();
    if (!dialog || botButtonBusy()) return;
    const peer = { ...dialog.peer };
    const peerId = peer.id;
    const generation = botActionGeneration;
    setBotButtonBusy({ owner, key });
    try {
      if (button.kind === 'text') {
        await engine.sendDraft(peer, button.text);
        if (botActionStillCurrent(peerId, generation)) dismissSingleUseReplyKeyboard(owner);
        return;
      }
      if (button.kind === 'url') {
        if (botActionStillCurrent(peerId, generation)) {
          openBotUrl(button.url);
          dismissSingleUseReplyKeyboard(owner);
        }
        return;
      }
      if (button.kind === 'url-auth') {
        if (messageId === undefined || button.buttonId === undefined) {
          if (botActionStillCurrent(peerId, generation)) {
            showBotNotice('This sign-in button is missing its Telegram authorization data.');
          }
          return;
        }
        const result = await engine.requestUrlAuth(peer, messageId, button.buttonId);
        if (!botActionStillCurrent(peerId, generation)) return;
        if (!result) {
          showBotNotice('Telegram sign-in is unavailable for this button.');
          return;
        }
        if (result.kind === 'request') {
          setBotUrlAuth({
            peer,
            messageId,
            buttonId: button.buttonId,
            fallbackUrl: button.url,
            request: result,
            generation,
            owner,
          });
          return;
        }
        openBotUrl(result.kind === 'accepted' ? (result.url ?? button.url) : button.url);
        dismissSingleUseReplyKeyboard(owner);
        return;
      }
      if (button.kind === 'copy') {
        await navigator.clipboard.writeText(button.copyText ?? '');
        if (botActionStillCurrent(peerId, generation)) {
          showBotNotice('Copied to the clipboard.');
          dismissSingleUseReplyKeyboard(owner);
        }
        return;
      }
      if (button.kind === 'callback') {
        if (messageId === undefined || !button.data) {
          if (botActionStillCurrent(peerId, generation)) {
            showBotNotice('This bot button is missing its callback data.');
          }
          return;
        }
        const answer = await engine.answerBotCallback(peer, messageId, button.data);
        if (!botActionStillCurrent(peerId, generation)) return;
        if (answer?.url) openBotUrl(answer.url);
        if (answer?.message) showBotNotice(answer.message);
        dismissSingleUseReplyKeyboard(owner);
        return;
      }
      if (button.kind === 'switch-inline') {
        if (!button.samePeer) {
          if (botActionStillCurrent(peerId, generation)) {
            setPendingInlineSwitch({
              query: button.query ?? '',
              ...(button.botUsername ? { botUsername: button.botUsername } : {}),
              owner,
            });
          }
          return;
        }
        const prefix = button.botUsername ? `@${button.botUsername} ` : '';
        const nextDraft = `${prefix}${button.query ?? ''}`;
        if (!botActionStillCurrent(peerId, generation)) return;
        draftEditVersion += 1;
        setDraft(nextDraft);
        await engine.setDraft(peerId, nextDraft);
        if (!botActionStillCurrent(peerId, generation)) return;
        dismissSingleUseReplyKeyboard(owner);
        queueMicrotask(() =>
          document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
        );
        return;
      }
      if (botActionStillCurrent(peerId, generation)) {
        showBotNotice('This Telegram button type is not supported.');
      }
    } catch {
      if (botActionStillCurrent(peerId, generation)) showBotNotice('The bot action failed.');
    } finally {
      if (botActionStillCurrent(peerId, generation)) {
        setBotButtonBusy((current) =>
          current?.owner === owner && current.key === key ? undefined : current,
        );
      }
    }
  };

  const chooseInlineSwitchChat = async (peerId: string) => {
    const pending = pendingInlineSwitch();
    if (!pending) return;
    dismissSingleUseReplyKeyboard(pending.owner);
    setPendingInlineSwitch(undefined);
    if (!(await selectChat(peerId))) return;
    const prefix = pending.botUsername ? `@${pending.botUsername} ` : '';
    const nextDraft = `${prefix}${pending.query}`;
    draftEditVersion += 1;
    setDraft(nextDraft);
    await engine.setDraft(peerId, nextDraft);
    if (activeChatId() !== peerId) return;
    queueMicrotask(() =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
    );
  };

  const acceptBotUrlAuth = async (options: TelegramUrlAuthAcceptOptions) => {
    const pending = botUrlAuth();
    if (!pending || botUrlAuthBusy()) return;
    setBotUrlAuthBusy(true);
    try {
      const result = await engine.acceptUrlAuth(
        pending.peer,
        pending.messageId,
        pending.buttonId,
        options,
      );
      if (!botActionStillCurrent(pending.peer.id, pending.generation)) return;
      if (!result) throw new Error('Telegram URL authorization is unavailable.');
      if (result.kind === 'request') {
        setBotUrlAuth({ ...pending, request: result });
        return;
      }
      setBotUrlAuth(undefined);
      openBotUrl(
        result.kind === 'accepted' ? (result.url ?? pending.fallbackUrl) : pending.fallbackUrl,
      );
      dismissSingleUseReplyKeyboard(pending.owner);
    } catch {
      if (botActionStillCurrent(pending.peer.id, pending.generation)) {
        showBotNotice('Telegram could not complete this sign-in request.');
      }
    } finally {
      if (botActionStillCurrent(pending.peer.id, pending.generation)) setBotUrlAuthBusy(false);
    }
  };

  const sendMessage = async () => {
    const body = draft();
    const attachments = composerAttachments().map((attachment) => ({ ...attachment }));
    const editing = editingMessage();
    const editRestore = editingDraftRestore;
    if (!body.trim() && attachments.length === 0 && !editing?.media) return;

    const dialog = snapshot().dialogs.find(({ peer }) => peer.id === activeChatId());
    if (!dialog || !canSend()) return;
    const peer = { ...dialog.peer };
    const reply = replyTarget();
    const capturedReply = reply ? { ...reply } : undefined;
    const telegramReply = capturedReply
      ? {
          messageId: capturedReply.messageId,
          ...(capturedReply.quoteText ? { quoteText: capturedReply.quoteText } : {}),
        }
      : undefined;
    const formats = draftFormats().map((format) => ({ ...format }));
    const capturedDraftEditVersion = draftEditVersion;

    if (typingTimer) clearTimeout(typingTimer);
    typingPeerId = '';
    void engine.setTyping(peer);
    setDraft('');
    setReplyTarget(undefined);
    setComposerAttachments([]);
    if (!editing) rememberAttachmentDraft(peer.id, []);
    setEditingMessage(undefined);
    setDraftFormats([]);
    try {
      if (editing) {
        const replacement = attachments[0];
        await engine.editMessage(
          peer,
          Number(editing.id),
          body,
          formats,
          replacement ? { file: replacement.file, sendAs: replacement.sendAs } : undefined,
        );
        const restore =
          editRestore?.peerId === peer.id
            ? editRestore
            : { peerId: peer.id, text: '', formats: [], attachments: [] };
        if (editingDraftRestore === editRestore) editingDraftRestore = undefined;
        if (activeChatId() === peer.id && draftEditVersion === capturedDraftEditVersion) {
          setDraft(restore.text);
          setDraftFormats(restore.formats);
          setComposerAttachments(cloneAttachments(restore.attachments));
          rememberAttachmentDraft(peer.id, restore.attachments);
        }
        return;
      }
      if (attachments.length > 0) {
        void engine.setTyping(peer, 'uploading');
        await engine.sendAttachments(
          peer,
          attachments.map(({ file, sendAs }) => ({ file, sendAs })),
          body,
          telegramReply,
          formats,
        );
        void engine.setTyping(peer);
      } else {
        await engine.sendDraft(peer, body, telegramReply, formats);
      }
    } catch {
      const hasNewerComposerState =
        activeChatId() !== peer.id ||
        draftEditVersion !== capturedDraftEditVersion ||
        draft() !== '' ||
        draftFormats().length > 0 ||
        composerAttachments().length > 0 ||
        replyTarget() !== undefined ||
        editingMessage() !== undefined;
      if (!hasNewerComposerState) {
        setDraft(body);
        setReplyTarget(capturedReply);
        setComposerAttachments(cloneAttachments(attachments));
        setEditingMessage(editing);
        setDraftFormats(formats);
        if (!editing) {
          rememberAttachmentDraft(peer.id, attachments);
          try {
            await engine.setDraft(peer.id, body);
          } catch {
            // The in-memory draft above remains editable if persistent storage is unavailable.
          }
        }
      } else if (!editing && activeChatId() !== peer.id) {
        rememberAttachmentDraft(peer.id, attachments);
      }
    }
  };

  const attachFiles = (files: File[]) => {
    if (files.length === 0) return;
    draftEditVersion += 1;
    const staged = files.map(stageAttachment);
    setComposerAttachments((current) => {
      const next = editingMessage() ? staged.slice(0, 1) : [...current, ...staged];
      if (!editingMessage()) rememberAttachmentDraft(activeChatId(), next);
      return next;
    });
  };

  const updateAttachment = (
    id: string,
    update: Partial<Pick<StagedAttachment, 'file' | 'sendAs'>>,
  ) => {
    draftEditVersion += 1;
    setComposerAttachments((current) => {
      const next = current.map((attachment) =>
        attachment.id === id ? { ...attachment, ...update } : attachment,
      );
      if (!editingMessage()) rememberAttachmentDraft(activeChatId(), next);
      return next;
    });
  };

  const removeAttachment = (id: string) => {
    draftEditVersion += 1;
    setComposerAttachments((current) => {
      const next = current.filter((attachment) => attachment.id !== id);
      if (!editingMessage()) rememberAttachmentDraft(activeChatId(), next);
      return next;
    });
  };

  const loadStickerIndexes = async () => {
    if (stickerPickerLoading()) return;
    setStickerPickerLoading(true);
    try {
      const [recent, installed] = await Promise.all([
        engine.getRecentStickers(),
        engine.getStickerPacks(),
      ]);
      setStickerPacks([
        ...(recent.length > 0 ? [{ id: 'recent', title: 'Recent', stickers: recent }] : []),
        ...installed,
      ]);
    } finally {
      setStickerPickerLoading(false);
    }
  };

  const loadGifIndex = async () => {
    if (gifPickerLoading()) return;
    setGifPickerLoading(true);
    try {
      setSavedGifs(await engine.getSavedGifs());
    } finally {
      setGifPickerLoading(false);
    }
  };

  const toggleStickerPicker = async () => {
    const open = !stickerPickerOpen();
    setStickerPickerOpen(open);
    if (open) setGifPickerOpen(false);
    if (open && stickerPacks().length === 0) await loadStickerIndexes();
  };

  const toggleGifPicker = async () => {
    const open = !gifPickerOpen();
    setGifPickerOpen(open);
    if (open) setStickerPickerOpen(false);
    if (open && savedGifs().length === 0) await loadGifIndex();
  };

  let observedExpressionRevision = snapshot().expressionRevision;
  createEffect(() => {
    const revision = snapshot().expressionRevision;
    if (revision === observedExpressionRevision) return;
    observedExpressionRevision = revision;
    setStickerPacks([]);
    setSavedGifs([]);
    if (stickerPickerOpen()) runInBackground(loadStickerIndexes());
    if (gifPickerOpen()) runInBackground(loadGifIndex());
  });

  const loadSticker = (sticker: TelegramSticker) => {
    const assetKey = `sticker:${sticker.id}`;
    return loadAssetUrl(assetKey, () => engine.downloadSticker(sticker));
  };

  const loadCustomEmoji = (documentId: string) => {
    const assetKey = `custom-emoji:${documentId}`;
    const current = customEmojiLoads.get(documentId);
    if (current && cachedAssetUrl(assetKey)) return current;
    if (current) customEmojiLoads.delete(documentId);
    const loading = engine.downloadCustomEmoji(documentId).then((blob) => ({
      url: rememberAssetUrl(assetKey, blob),
      mimeType: blob.type,
    }));
    customEmojiLoads.set(documentId, loading);
    void loading.catch(() => customEmojiLoads.delete(documentId));
    return loading;
  };

  const sendSticker = async (sticker: TelegramSticker) => {
    const dialog = snapshot().dialogs.find(({ peer }) => peer.id === activeChatId());
    if (!dialog || !online()) return;
    const reply = replyTarget();
    setStickerPickerOpen(false);
    setReplyTarget(undefined);
    await engine.sendSticker(
      dialog.peer,
      sticker,
      reply
        ? { messageId: reply.messageId, ...(reply.quoteText ? { quoteText: reply.quoteText } : {}) }
        : undefined,
    );
  };

  const sendGif = async (gif: TelegramSticker) => {
    setGifPickerOpen(false);
    await sendSticker(gif);
  };

  const reactToMessage = async (messageId: string, emoji: string) => {
    const id = Number(messageId);
    const dialog = snapshot().dialogs.find(({ peer }) => peer.id === activeChatId());
    if (!Number.isSafeInteger(id) || !dialog || !online()) return;
    setReactionPickerMessageId('');
    await engine.toggleReaction(dialog.peer, id, emoji);
  };

  const deleteMessage = async (messageId: string, revoke: boolean) => {
    const id = Number(messageId);
    const dialog = snapshot().dialogs.find(({ peer }) => peer.id === activeChatId());
    if (!Number.isSafeInteger(id) || !dialog || !online()) return;
    setMessageContextMenu(undefined);
    await engine.deleteMessage(dialog.peer, id, revoke);
  };

  const forwardMessage = async (targetPeerId: string) => {
    const message = forwardingMessage();
    const from = snapshot().dialogs.find(({ peer }) => peer.id === activeChatId());
    const to = snapshot().dialogs.find(({ peer }) => peer.id === targetPeerId);
    if (!message || !from || !to || !online()) return;
    setForwardingMessage(undefined);
    await engine.forwardMessage(from.peer, to.peer, Number(message.id));
  };

  const beginReply = (message: ChatMessage, element: HTMLElement) => {
    const scroller = messageScroller();
    if (scroller) {
      clearUserScrollIntent();
      preserveReadingPositionIfAwayFromPresent(scroller);
    }
    const selection = window.getSelection();
    const selected = selection?.toString().trim() ?? '';
    const anchorNode = selection?.anchorNode;
    const focusNode = selection?.focusNode;
    const selectionInside =
      selected.length > 0 &&
      Boolean(
        anchorNode && focusNode && element.contains(anchorNode) && element.contains(focusNode),
      );
    setReplyTarget({
      messageId: Number(message.id),
      preview: selectionInside ? selected : message.body || message.media?.name || 'Message',
      ...(selectionInside ? { quoteText: selected } : {}),
    });
    selection?.removeAllRanges();
    queueMicrotask(() =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
    );
  };

  const beginEdit = (message: ChatMessage) => {
    if (!editingMessage()) {
      rememberAttachmentDraft(activeChatId(), composerAttachments());
      editingDraftRestore = {
        peerId: activeChatId(),
        text: draft(),
        formats: [...draftFormats()],
        attachments: composerAttachments().map((attachment) => ({ ...attachment })),
      };
    }
    setReplyTarget(undefined);
    setComposerAttachments([]);
    setEditingMessage(message);
    setDraft(message.body);
    setDraftFormats(message.formats ? [...message.formats] : []);
  };

  const cancelEdit = () => {
    const restore = editingDraftRestore;
    editingDraftRestore = undefined;
    setEditingMessage(undefined);
    setDraft(restore?.text ?? '');
    setDraftFormats(restore?.formats ?? []);
    setComposerAttachments(cloneAttachments(restore?.attachments ?? []));
    if (restore) rememberAttachmentDraft(restore.peerId, restore.attachments);
  };

  const centerMessageWindow = (messageId: number) => {
    const index = activeMessages().findIndex(({ id }) => id === String(messageId));
    if (index < 0) return;
    const maxStart = Math.max(0, activeMessages().length - MAX_RENDERED_MESSAGES);
    setMessageWindowStart(Math.min(maxStart, Math.max(0, index - MAX_RENDERED_MESSAGES / 2)));
  };

  const revealMessage = async (
    messageId: number,
    peerId: string,
    openGeneration: number,
    selection: number,
  ) => {
    if (
      openGeneration !== openMessageGeneration ||
      selection !== selectionGeneration ||
      activeChatId() !== peerId
    ) {
      return false;
    }
    invalidatePresentAlignment();
    followPresent = false;
    centerMessageWindow(messageId);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await nextFrame();
      if (
        openGeneration !== openMessageGeneration ||
        selection !== selectionGeneration ||
        activeChatId() !== peerId ||
        engine.snapshot().activePeerId !== peerId
      ) {
        return false;
      }
      const scroller = messageScroller();
      const target = scroller?.querySelector<HTMLElement>(
        `:is(article.message, .media-album-item)[data-message-id="${messageId}"]`,
      );
      if (!target) continue;
      target.scrollIntoView({ block: 'center' });
      historyAnchor = { messageId: String(messageId), top: target.getBoundingClientRect().top };
      target.classList.add('message-target');
      window.setTimeout(() => target.classList.remove('message-target'), 1200);
      if (scroller) updateJumpToPresent(scroller);
      return true;
    }
    return false;
  };

  const scrollToReply = async (messageId: number) => {
    const local = snapshot().messages.find(({ id }) => id === messageId);
    const target =
      local ??
      ({
        id: messageId,
        peerId: activeChatId(),
        senderId: '',
        text: '',
        date: 0,
        outgoing: false,
      } as TelegramMessage);
    await openMessage(target);
  };

  const openMessage = async (message: TelegramMessage) => {
    const generation = ++openMessageGeneration;
    openingMessage = true;
    followPresent = false;
    let revealed = false;
    try {
      const selected = await selectChat(message.peerId, generation);
      const selection = selectionGeneration;
      if (!selected || generation !== openMessageGeneration || activeChatId() !== message.peerId)
        return;
      followPresent = false;
      if (!(await engine.openMessage(message))) return;
      if (
        generation !== openMessageGeneration ||
        selection !== selectionGeneration ||
        activeChatId() !== message.peerId ||
        engine.snapshot().activePeerId !== message.peerId
      ) {
        return;
      }
      revealed = await revealMessage(message.id, message.peerId, generation, selection);
    } finally {
      if (generation === openMessageGeneration) {
        openingMessage = false;
        if (!revealed) {
          const scroller = messageScroller();
          if (scroller) updateJumpToPresent(scroller, true);
        }
      }
    }
  };

  const openMessageActions = (message: ChatMessage, event: MouseEvent) => {
    if (message.service || !Number.isSafeInteger(Number(message.id))) return;
    event.preventDefault();
    event.stopPropagation();
    setStickerPickerOpen(false);
    setGifPickerOpen(false);
    setReactionPickerMessageId('');
    const anchor =
      event.currentTarget instanceof Element
        ? event.currentTarget.getBoundingClientRect()
        : undefined;
    setMessageContextMenu({
      messageId: message.id,
      x: event.clientX || anchor?.right || 8,
      y: event.clientY || anchor?.bottom || 8,
    });
  };
  const messageContextTarget = createMemo(() => {
    const menu = messageContextMenu();
    return menu ? renderedMessages().find(({ id }) => id === menu.messageId) : undefined;
  });

  const connectionNotice = createMemo(() => {
    const current = snapshot() as EngineSnapshot & { online?: boolean };
    if (!hasCachedWorkspace()) return '';
    if (current.phase === 'error')
      return `Offline. Showing cached data.${current.error ? ` ${current.error}` : ''}`;
    if (current.phase === 'ready' && current.online === false)
      return `Offline. Showing cached data.${current.error ? ` ${current.error}` : ''}`;
    return '';
  });

  return (
    <main class="h-dvh overflow-hidden bg-[var(--canvas)] text-[var(--text)]">
      <div
        ref={(element) => (appGridElement = element)}
        class="app-grid h-full"
        classList={{
          'details-visible': detailsOpen(),
          'mobile-sidebar-visible': mobileSidebarOpen(),
          'resizing-left-sidebar': resizingLeftSidebar(),
        }}
        style={{ '--left-sidebar-width': `${effectiveLeftSidebarWidth()}px` }}
      >
        <ChatSidebar
          chats={visibleChats()}
          activeChatId={activeChatId()}
          compact={leftSidebarCompact() && !mobileSidebarOpen()}
          width={effectiveLeftSidebarWidth()}
          minWidth={LEFT_SIDEBAR_MIN_WIDTH}
          maxWidth={responsiveLeftSidebarMaxWidth()}
          online={online()}
          mobileOpen={mobileSidebarOpen()}
          modal={mobileSidebarOpen() && viewportWidth() <= 650}
          avatarIdentity={avatarIdentity}
          loadCachedAvatar={(peerId) => loadAvatar(peerId, true)}
          loadAvatar={loadAvatar}
          loadPeerAvatar={(result, cachedOnly) =>
            loadPeerAvatar(result.peer, result.hasAvatar, result.avatarId, cachedOnly)
          }
          select={(peerId) => runInBackground(selectChat(peerId))}
          searchPeers={(query) => engine.searchPeers(query)}
          openPeer={(result) => {
            const generation = ++peerOpenGeneration;
            runInBackground(
              engine.addPeer(result).then(() => selectChat(result.peer.id, undefined, generation)),
            );
          }}
          setMuted={(peerId, muted) => {
            const dialog = snapshot().dialogs.find(({ peer }) => peer.id === peerId);
            if (dialog) void engine.setMuted(dialog.peer, muted);
          }}
          getUserDetails={(peerId) => {
            const dialog = snapshot().dialogs.find(({ peer }) => peer.id === peerId);
            return dialog
              ? engine.getUserDetails(dialog.peer)
              : Promise.reject(new Error('Chat is no longer available.'));
          }}
          setBlocked={(peerId, blocked) => {
            const dialog = snapshot().dialogs.find(({ peer }) => peer.id === peerId);
            if (dialog) void engine.setBlocked(dialog.peer, blocked);
          }}
          setPinned={(peerId, pinned) => {
            const dialog = snapshot().dialogs.find(({ peer }) => peer.id === peerId);
            if (dialog) void engine.setPinnedDialog(dialog.peer, pinned);
          }}
          setArchived={(peerId, archived) => {
            const dialog = snapshot().dialogs.find(({ peer }) => peer.id === peerId);
            if (dialog) void engine.setArchived(dialog.peer, archived);
          }}
          requestDelete={(peerId) => {
            const chat = visibleChats().find(({ id }) => id === peerId);
            if (chat) setDeleteChatTarget(chat);
          }}
          closeMobile={() => setMobileSidebarOpen(false)}
          startResize={startLeftSidebarResize}
          resizeWithKeyboard={resizeLeftSidebarWithKeyboard}
        />

        <Show when={mobileSidebarOpen() || detailsOpen()}>
          <button
            class="mobile-drawer-backdrop"
            aria-label="Close navigation panel"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => {
              setMobileSidebarOpen(false);
              updateDetailsOpen(false);
            }}
          />
        </Show>

        <section
          ref={(element) => (conversationPaneElement = element)}
          class="conversation-pane relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--chat)]"
        >
          <header class="chat-header flex h-16 shrink-0 items-center justify-between border-b border-[var(--line)] bg-[var(--panel)] px-4">
            <div class="flex min-w-0 items-center gap-3 text-left">
              <button
                ref={(element) => (mobileSidebarTriggerElement = element)}
                class="mobile-sidebar-trigger icon-button"
                onClick={toggleMobileSidebar}
                aria-label="Open chat list"
                aria-expanded={mobileSidebarOpen()}
              >
                <Menu size={19} />
              </button>
              <Avatar
                identity={avatarIdentity(activeChat().id)}
                initials={activeChat().initials}
                color={activeChat().color}
                size="sm"
                online={activeChat().presence === 'online'}
                loadCached={() => loadAvatar(activeChat().id, true)}
                load={online() ? () => loadAvatar(activeChat().id) : undefined}
              />
              <span class="min-w-0">
                <strong class="block truncate text-sm font-semibold">{activeChat().title}</strong>
                <span
                  class="block text-xs"
                  classList={{
                    'text-emerald-400': online(),
                    'text-[var(--muted)]': !online(),
                  }}
                  role="status"
                >
                  {activeStatus()}
                </span>
              </span>
            </div>
            <nav class="flex items-center gap-1">
              <button
                class="icon-button"
                onClick={() => setSearchOpen(true)}
                aria-label="Search messages"
                disabled={!activePeerMatches()}
              >
                <Search size={18} />
              </button>
              <Show when={!detailsOpen()}>
                <button
                  class="icon-button"
                  onClick={() => updateDetailsOpen(true)}
                  aria-label="Open details"
                >
                  <PanelRightOpen size={18} />
                </button>
              </Show>
            </nav>
          </header>

          <Show when={connectionNotice()}>
            <div class="sync-state-banner" role="alert">
              <span>{connectionNotice()}</span>
              <button disabled={syncRetrying()} onClick={() => void retrySync()}>
                {syncRetrying() ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          </Show>

          <Show when={snapshot().operationError}>
            {(message) => (
              <div class="sync-state-banner operation-state-banner" role="alert">
                <span>{message()}</span>
                <Show when={snapshot().pending.some(({ lastError }) => Boolean(lastError))}>
                  <button disabled={syncRetrying()} onClick={() => void retrySync()}>
                    {syncRetrying() ? 'Retrying…' : 'Retry queued'}
                  </button>
                </Show>
                <button onClick={() => engine.clearOperationError()}>Dismiss</button>
              </div>
            )}
          </Show>

          <Show when={activePinnedMessage()}>
            {(message) => (
              <div class="pinned-message-bar">
                <button
                  class="pinned-message-open"
                  onClick={() => runInBackground(openMessage(message()))}
                  aria-label={`Pinned message ${pinnedMessageIndex() + 1} of ${snapshot().pinnedMessages.length}: ${message().text || message().media?.name || 'Message'}`}
                >
                  <Pin size={15} />
                  <span>
                    <strong>
                      Pinned message {pinnedMessageIndex() + 1} of{' '}
                      {snapshot().pinnedMessages.length}
                    </strong>
                    {message().text || message().media?.name}
                  </span>
                </button>
                <Show when={snapshot().pinnedMessages.length > 1}>
                  <span class="pinned-message-navigation">
                    <button
                      aria-label="Previous pinned message"
                      onClick={() =>
                        setPinnedMessageIndex(
                          (pinnedMessageIndex() - 1 + snapshot().pinnedMessages.length) %
                            snapshot().pinnedMessages.length,
                        )
                      }
                    >
                      <ChevronUp size={16} />
                    </button>
                    <button
                      aria-label="Next pinned message"
                      onClick={() =>
                        setPinnedMessageIndex(
                          (pinnedMessageIndex() + 1) % snapshot().pinnedMessages.length,
                        )
                      }
                    >
                      <ChevronDown size={16} />
                    </button>
                  </span>
                </Show>
              </div>
            )}
          </Show>
          <div class="message-scroll-shell relative min-h-0 flex-1">
            <div
              ref={setMessageScroller}
              class="message-scroller scroll-area relative h-full min-h-0 overflow-y-auto overscroll-contain px-5 py-6"
              data-testid="message-scroller"
              onKeyDown={(event) => {
                if (
                  ['ArrowUp', 'PageUp', 'Home', 'ArrowDown', 'PageDown', 'End'].includes(event.key)
                ) {
                  const direction = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ? -1 : 1;
                  markUserScrollIntent(direction);
                  stopFollowingPresentForUser(event.currentTarget);
                }
              }}
              onScroll={(event) => {
                if (positioningPresent || presentScrollWriteActive) {
                  reportConversationVisibility();
                  return;
                }
                if (followPresent) {
                  alignScrollerToPresent(event.currentTarget);
                  return;
                }
                if (!userScrollIntentActive && !pointerScrollActive) {
                  restoreHistoryAnchor(event.currentTarget);
                  reportConversationVisibility();
                  return;
                }
                userScrollIntentMoved = true;
                markUserScrollIntent();
                updateJumpToPresent(event.currentTarget, userScrollIntentDirection !== -1);
                void loadOlderAtTop(event.currentTarget);
              }}
              onWheel={(event) => {
                const direction = event.deltaY < 0 ? -1 : event.deltaY > 0 ? 1 : 0;
                markUserScrollIntent(direction);
                if (event.deltaY < 0) stopFollowingPresentForUser(event.currentTarget);
                else if (event.deltaY > 0)
                  preserveReadingPositionIfAwayFromPresent(event.currentTarget);
                if (event.deltaY < 0 && event.currentTarget.scrollTop <= 120)
                  void loadOlderAtTop(event.currentTarget);
              }}
            >
              <div class="pointer-events-none absolute inset-0 chat-texture" />
              <div
                ref={setMessageContent}
                class="conversation-content relative mx-auto flex max-w-3xl flex-col gap-2"
                classList={{ 'conversation-ready': conversationReady() }}
              >
                <Show
                  when={snapshot().loadingMessages && snapshot().activePeerId === activeChatId()}
                >
                  <div class="conversation-state" role="status">
                    Loading messages…
                  </div>
                </Show>
                <Show
                  when={
                    (conversationLoadError() || snapshot().historyError) &&
                    activeMessages().length === 0
                  }
                >
                  <div class="conversation-state conversation-state-error" role="alert">
                    <strong>Messages could not be loaded</strong>
                    <span>{conversationLoadError() || snapshot().historyError}</span>
                    <button
                      disabled={conversationRetrying()}
                      onClick={() => void retryConversation()}
                    >
                      {conversationRetrying() ? 'Retrying…' : 'Retry'}
                    </button>
                  </div>
                </Show>
                <Show when={snapshot().loadingOlderMessages}>
                  <div class="history-loader" role="status">
                    Loading older messages…
                  </div>
                </Show>
                <Show when={messageWindowStart() > 0}>
                  <button class="message-window-control" onClick={() => shiftMessageWindow(-1)}>
                    Show earlier loaded messages
                  </button>
                </Show>
                <Show when={snapshot().historyError && activeMessages().length > 0}>
                  <div class="history-error" role="alert">
                    <span>{snapshot().historyError}</span>
                    <button
                      disabled={conversationRetrying()}
                      onClick={() => void retryConversation()}
                    >
                      {conversationRetrying() ? 'Retrying…' : 'Retry history'}
                    </button>
                  </div>
                </Show>
                <For
                  each={renderedMessages()}
                  fallback={
                    <Show
                      when={
                        !snapshot().loadingMessages &&
                        !conversationLoadError() &&
                        !snapshot().historyError &&
                        activeChatId() !== 'empty'
                      }
                    >
                      <div class="mx-auto mt-20 flex max-w-xs flex-col items-center text-center">
                        <div class="mb-4 grid size-14 place-items-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
                          <MessageSquareText size={25} />
                        </div>
                        <h2 class="font-semibold">No messages yet</h2>
                        <p class="mt-1 text-sm leading-5 text-[var(--muted)]">
                          Start a conversation when Telegram is online.
                        </p>
                      </div>
                    </Show>
                  }
                >
                  {(message, index) => (
                    <>
                      <Show when={gapBefore(message)}>
                        {(gap) => (
                          <button
                            class="message-window-control history-gap-control"
                            disabled={snapshot().loadingOlderMessages}
                            onClick={() => void loadHistoryGap(gap())}
                          >
                            {snapshot().loadingOlderMessages
                              ? 'Loading missing messages…'
                              : 'Load missing messages'}
                          </button>
                        )}
                      </Show>
                      <Show
                        when={
                          message.date !== undefined &&
                          (index() === 0 ||
                            new Date(message.date * 1000).toDateString() !==
                              new Date(
                                (renderedMessages()[index() - 1]?.date ?? message.date) * 1000,
                              ).toDateString())
                        }
                      >
                        <div class="my-3 self-center rounded-full border border-white/5 bg-black/25 px-3 py-1 text-[11px] font-medium text-[var(--muted)] backdrop-blur">
                          {new Intl.DateTimeFormat(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          }).format(new Date((message.date ?? 0) * 1000))}
                        </div>
                      </Show>
                      <article
                        class={`message ${message.outgoing ? 'outgoing' : 'incoming'}${message.service ? ' message-service' : ''}${albumMessages(message, index()).length > 1 ? ' message-has-album' : ''}${isMediaOnlySurface(message, index()) ? ' message-media-surface' : ''}${hasInlineTextTime(message, index()) ? ' message-inline-time' : ''}${isCaptionedMediaPost(message, index()) ? ' message-captioned-media' : ''}${cropsExtremePortraitMedia(message, index()) ? ' message-media-cropped' : ''}`}
                        style={{ width: visualMediaWidth(message, index()) }}
                        data-message-id={message.id}
                        data-media-kind={message.media?.kind}
                        hidden={isAlbumContinuation(message, index())}
                        aria-label={message.service?.text}
                        onContextMenu={(event) => openMessageActions(message, event)}
                      >
                        <Show when={!message.service && messageAuthor(message)}>
                          <strong class="message-author">{messageAuthor(message)}</strong>
                        </Show>
                        <Show when={message.replyTo}>
                          <button
                            class="message-reply"
                            onClick={() =>
                              message.replyToId && runInBackground(scrollToReply(message.replyToId))
                            }
                            aria-label={`Jump to replied message ${message.replyToId ?? ''}`}
                          >
                            <Show when={message.replyMedia && message.replyToId}>
                              <span class="reply-media-preview">
                                <MediaAttachment
                                  media={message.replyMedia!}
                                  revision={
                                    mediaSourceFor(message.replyToId!)
                                      ? engine.mediaAssetKey(mediaSourceFor(message.replyToId!)!)
                                      : undefined
                                  }
                                  load={() => {
                                    const source = mediaSourceFor(message.replyToId!);
                                    return source
                                      ? loadMedia(source)
                                      : Promise.reject(new Error('Reply media is unavailable.'));
                                  }}
                                  cachedUrl={() => {
                                    const source = mediaSourceFor(message.replyToId!);
                                    return source
                                      ? cachedAssetUrl(engine.mediaAssetKey(source))
                                      : undefined;
                                  }}
                                  compact
                                  decorative
                                />
                              </span>
                            </Show>
                            <span>{message.replyTo}</span>
                          </button>
                        </Show>
                        <Show when={albumMessages(message, index()).length > 1}>
                          <MessageAlbum
                            messages={albumMessages(message, index())}
                            revision={(albumMessage) => {
                              const source = mediaSourceFor(albumMessage.id);
                              return source
                                ? engine.mediaAssetKey(source)
                                : pendingAttachmentForMessage(albumMessage.id)
                                  ? pendingMediaAssetKey(albumMessage.id)
                                  : undefined;
                            }}
                            progress={(albumMessage) => albumMessage.uploadProgress}
                            cachedUrl={(albumMessage) => {
                              const source = mediaSourceFor(albumMessage.id);
                              if (source) return cachedAssetUrl(engine.mediaAssetKey(source));
                              return pendingAttachmentForMessage(albumMessage.id)
                                ? cachedAssetUrl(pendingMediaAssetKey(albumMessage.id))
                                : undefined;
                            }}
                            load={(albumMessage) => {
                              const source = mediaSourceFor(albumMessage.id);
                              if (source) return loadMedia(source);
                              const pending = pendingAttachmentForMessage(albumMessage.id);
                              return pending
                                ? Promise.resolve(
                                    rememberAssetUrl(
                                      pendingMediaAssetKey(albumMessage.id),
                                      pending.blob,
                                    ),
                                  )
                                : Promise.reject(new Error('Album media is unavailable.'));
                            }}
                            openActions={(albumMessage, event) =>
                              openMessageActions(albumMessage, event)
                            }
                          />
                        </Show>
                        <Show
                          when={
                            albumMessages(message, index()).length === 0 ? message.media : undefined
                          }
                        >
                          {(media) => (
                            <Show
                              when={message.uploadProgress === undefined}
                              fallback={
                                <div class="upload-progress">
                                  <span>{media().name}</span>
                                  <strong>
                                    {message.status === 'failed'
                                      ? 'Upload failed'
                                      : `${Math.round((message.uploadProgress ?? 0) * 100)}%`}
                                  </strong>
                                  <div>
                                    <i
                                      style={{
                                        width: `${Math.round((message.uploadProgress ?? 0) * 100)}%`,
                                      }}
                                    />
                                  </div>
                                </div>
                              }
                            >
                              <MediaAttachment
                                media={media()}
                                revision={
                                  mediaSourceFor(message.id)
                                    ? engine.mediaAssetKey(mediaSourceFor(message.id)!)
                                    : undefined
                                }
                                cachedUrl={() => {
                                  const source = mediaSourceFor(message.id);
                                  if (source) return cachedAssetUrl(engine.mediaAssetKey(source));
                                  const sticker = snapshot().pending.find(
                                    (send) => send.id === message.id,
                                  )?.sticker;
                                  return sticker
                                    ? cachedAssetUrl(`sticker:${sticker.id}`)
                                    : undefined;
                                }}
                                load={() => {
                                  const source = mediaSourceFor(message.id);
                                  if (source) return loadMedia(source);
                                  const pendingSticker = snapshot().pending.find(
                                    (send) => send.id === message.id,
                                  )?.sticker;
                                  return pendingSticker
                                    ? loadSticker(pendingSticker)
                                    : Promise.reject(new Error('Attachment data is unavailable.'));
                                }}
                              />
                            </Show>
                          )}
                        </Show>
                        <div class="message-copy">
                          <MessageBody
                            message={albumCaptionMessage(message, index())}
                            loadPreviewPhoto={
                              message.linkPreview?.hasPhoto
                                ? () => {
                                    const source = snapshot().messages.find(
                                      (candidate) => String(candidate.id) === message.id,
                                    );
                                    return source
                                      ? loadMedia(source)
                                      : Promise.reject(new Error('Preview image is unavailable.'));
                                  }
                                : undefined
                            }
                          />
                          <footer
                            aria-label={
                              message.outgoing
                                ? `${albumCaptionMessage(message, index()).editedAt ? 'Edited. ' : ''}${albumCaptionMessage(message, index()).time}. Message status: ${message.status ?? 'sent'}`
                                : undefined
                            }
                          >
                            <Show when={albumCaptionMessage(message, index()).editedAt}>
                              <span class="message-edited">edited</span>
                            </Show>
                            <span>{albumCaptionMessage(message, index()).time}</span>
                            <Show when={message.outgoing}>
                              <Show
                                when={message.status === 'read'}
                                fallback={
                                  <Show
                                    when={message.status === 'sending'}
                                    fallback={
                                      <Show
                                        when={message.status === 'failed'}
                                        fallback={<Check size={13} />}
                                      >
                                        <CircleAlert size={13} class="text-red-300" />
                                      </Show>
                                    }
                                  >
                                    <Clock3 size={12} />
                                  </Show>
                                }
                              >
                                <CheckCheck size={13} class="text-sky-300" />
                              </Show>
                            </Show>
                          </footer>
                        </div>
                        <Show
                          when={
                            !message.service && message.botKeyboard?.kind === 'inline'
                              ? message.botKeyboard
                              : undefined
                          }
                        >
                          {(keyboard) => (
                            <BotKeyboard
                              keyboard={keyboard()}
                              disabled={!canSend()}
                              busyButton={
                                botButtonBusy()?.owner === message.id
                                  ? botButtonBusy()?.key
                                  : undefined
                              }
                              label={`Actions for message ${message.id}`}
                              onPress={(button, key) =>
                                void pressBotButton(button, message.id, key, Number(message.id))
                              }
                            />
                          )}
                        </Show>
                        <Show
                          when={message.status === 'failed' && pendingSendForMessage(message.id)}
                        >
                          {(pending) => (
                            <div
                              class="pending-message-actions"
                              aria-label="Failed message actions"
                            >
                              <button
                                disabled={Boolean(pendingActionId())}
                                onClick={() => void retryPendingSend(pending().id)}
                              >
                                {pendingActionId() === pending().id ? 'Retrying…' : 'Retry'}
                              </button>
                              <button
                                disabled={Boolean(pendingActionId())}
                                onClick={() => void cancelPendingSend(pending().id)}
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </Show>
                        <Show when={!message.service && Number.isSafeInteger(Number(message.id))}>
                          <MessageActions
                            message={message}
                            pickerOpen={reactionPickerMessageId() === message.id}
                            setPickerOpen={(open) =>
                              setReactionPickerMessageId(open ? message.id : '')
                            }
                            react={(emoji) => void reactToMessage(message.id, emoji)}
                            reply={(article) => beginReply(message, article)}
                            loadCustomEmoji={loadCustomEmoji}
                          />
                        </Show>
                      </article>
                    </>
                  )}
                </For>
                <Show when={messageContextMenu()}>
                  {(menu) => (
                    <Show when={messageContextTarget()}>
                      {(target) => (
                        <div
                          class="message-context-menu"
                          role="menu"
                          aria-label="Message actions"
                          style={{
                            left:
                              menu().x > window.innerWidth - 190
                                ? 'auto'
                                : `${Math.max(8, menu().x)}px`,
                            right: menu().x > window.innerWidth - 190 ? '8px' : 'auto',
                            top:
                              menu().y > window.innerHeight / 2
                                ? 'auto'
                                : `${Math.max(8, menu().y)}px`,
                            bottom:
                              menu().y > window.innerHeight / 2
                                ? `${Math.max(8, window.innerHeight - menu().y)}px`
                                : 'auto',
                          }}
                        >
                          <button
                            role="menuitem"
                            onClick={() => {
                              const message = target();
                              setMessageContextMenu(undefined);
                              const element = document.querySelector<HTMLElement>(
                                `.media-album-item[data-message-id="${message.id}"], article[data-message-id="${message.id}"]`,
                              );
                              if (element) beginReply(message, element);
                            }}
                          >
                            <Reply size={15} /> Reply
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => {
                              setMessageContextMenu(undefined);
                              setForwardingMessage(target());
                            }}
                          >
                            <Forward size={15} /> Forward
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => {
                              const message = target();
                              setMessageContextMenu(undefined);
                              const dialog = activeDialog();
                              if (!dialog) return;
                              void engine.setPinnedMessage(
                                dialog.peer,
                                Number(message.id),
                                !snapshot().pinnedMessages.some(
                                  ({ id }) => id === Number(message.id),
                                ),
                              );
                            }}
                          >
                            <Pin size={15} />
                            {snapshot().pinnedMessages.some(({ id }) => id === Number(target().id))
                              ? 'Unpin'
                              : 'Pin'}
                          </button>
                          <Show when={target().outgoing && (target().body || target().media)}>
                            <button
                              role="menuitem"
                              onClick={() => {
                                const message = target();
                                setMessageContextMenu(undefined);
                                beginEdit(message);
                              }}
                            >
                              <Pencil size={15} /> Edit
                            </button>
                          </Show>
                          <button
                            class="danger"
                            role="menuitem"
                            onClick={() => {
                              const message = target();
                              setMessageContextMenu(undefined);
                              setDeleteTarget(message);
                            }}
                          >
                            <Trash2 size={15} /> Delete
                          </button>
                        </div>
                      )}
                    </Show>
                  )}
                </Show>
                <Show when={messageWindowBounds().end < activeMessages().length}>
                  <button class="message-window-control" onClick={() => shiftMessageWindow(1)}>
                    Show newer loaded messages
                  </button>
                </Show>
                <div class="present-scroll-anchor" aria-hidden="true" />
              </div>
            </div>

            <Show when={jumpToPresentVisible()}>
              <button
                class="jump-to-present"
                type="button"
                aria-label="Jump to present"
                onClick={jumpToPresent}
              >
                <ArrowDown size={19} />
              </button>
            </Show>
          </div>

          <Show when={botNotice()}>
            {(notice) => (
              <div class="bot-callback-notice" role="status">
                {notice()}
              </div>
            )}
          </Show>
          <Show
            when={
              activeChatId() !== 'empty' &&
              (activeChat().bot ||
                activeChat().kind !== 'user' ||
                botCommandsLoading() ||
                botCommands().length > 0 ||
                Boolean(visibleReplyKeyboard()?.keyboard.rows.some((row) => row.length > 0)))
            }
          >
            <BotControls
              isBot={Boolean(activeChat().bot)}
              showCommands={Boolean(
                activeChat().bot ||
                activeChat().kind !== 'user' ||
                botCommandsLoading() ||
                botCommands().length > 0,
              )}
              started={botStarted()}
              enabled={canSend()}
              starting={botStarting()}
              menuOpen={botMenuOpen()}
              loadingCommands={botCommandsLoading()}
              commands={botCommands()}
              replyKeyboard={visibleReplyKeyboard()?.keyboard}
              busyButton={botButtonBusy()?.owner === 'reply' ? botButtonBusy()?.key : undefined}
              onToggleMenu={toggleBotMenu}
              onStart={() => void startActiveBot()}
              onCommand={sendBotCommand}
              onReplyButton={(button, key) =>
                void pressBotButton(button, 'reply', key, visibleReplyKeyboard()?.messageId)
              }
            />
          </Show>
          <ChatComposer
            conversationId={activeChatId()}
            draft={draft()}
            placeholder={visibleReplyKeyboard()?.keyboard.placeholder}
            enabled={canSend()}
            stickerPickerOpen={stickerPickerOpen()}
            stickerPickerLoading={stickerPickerLoading()}
            gifPickerOpen={gifPickerOpen()}
            gifPickerLoading={gifPickerLoading()}
            gifs={savedGifs()}
            stickerPacks={stickerPacks()}
            reply={replyTarget()}
            editing={
              editingMessage()
                ? {
                    body: editingMessage()!.body,
                    mediaName: editingMessage()!.media?.name,
                    hasMedia: Boolean(editingMessage()!.media),
                  }
                : undefined
            }
            attachments={composerAttachments()}
            formats={draftFormats()}
            onDraft={(value) => {
              const scroller = messageScroller();
              if (scroller) {
                clearUserScrollIntent();
                preserveReadingPositionIfAwayFromPresent(scroller);
              }
              draftEditVersion += 1;
              setDraft(value);
              if (editingMessage()) return;
              if (activeChatId() !== 'empty') {
                runInBackground(engine.setDraft(activeChatId(), value));
                const dialog = snapshot().dialogs.find(({ peer }) => peer.id === activeChatId());
                if (dialog && online()) {
                  if (typingTimer) clearTimeout(typingTimer);
                  if (value && typingPeerId !== dialog.peer.id) {
                    typingPeerId = dialog.peer.id;
                    void engine.setTyping(dialog.peer, 'typing');
                  }
                  if (!value && typingPeerId === dialog.peer.id) {
                    typingPeerId = '';
                    void engine.setTyping(dialog.peer);
                  }
                  typingTimer = setTimeout(() => {
                    if (typingPeerId === dialog.peer.id) {
                      typingPeerId = '';
                      void engine.setTyping(dialog.peer);
                    }
                  }, 4500);
                }
              }
            }}
            onFormats={setDraftFormats}
            onSend={() => void sendMessage()}
            onAttach={attachFiles}
            onUpdateAttachment={updateAttachment}
            onRemoveAttachment={removeAttachment}
            onToggleStickers={() => runInBackground(toggleStickerPicker())}
            onToggleGifs={() => runInBackground(toggleGifPicker())}
            onLoadSticker={loadSticker}
            stickerUrl={(sticker) => cachedAssetUrl(`sticker:${sticker.id}`)}
            onSendSticker={(sticker) => void sendSticker(sticker)}
            onSendGif={(gif) => void sendGif(gif)}
            onSearchGifs={(query) => engine.searchGifs(query)}
            onCancelReply={() => setReplyTarget(undefined)}
            onCancelEdit={cancelEdit}
            onExpressionOpenChange={setExpressionPickerVisible}
          />
        </section>

        <Show when={forwardingMessage()}>
          <ForwardMessageDialog
            chats={visibleChats()}
            close={() => setForwardingMessage(undefined)}
            forward={(peerId) => void forwardMessage(peerId)}
          />
        </Show>

        <Show when={pendingInlineSwitch()}>
          <ForwardMessageDialog
            chats={visibleChats().filter(({ id }) => id !== activeChatId())}
            title="Choose a chat"
            label="Choose a chat for inline query"
            cancelLabel="Cancel inline query"
            close={() => setPendingInlineSwitch(undefined)}
            forward={(peerId) => void chooseInlineSwitchChat(peerId)}
          />
        </Show>

        <Show when={searchOpen()}>
          <SearchPanel
            dialogs={snapshot().dialogs}
            activePeerId={activeChatId()}
            search={(term, global, offset) => engine.searchMessages(term, global, offset)}
            openResult={(message) => {
              setSearchOpen(false);
              runInBackground(openMessage(message));
            }}
            close={() => setSearchOpen(false)}
          />
        </Show>

        <Show when={sharedMediaKind()}>
          {(kind) => (
            <SharedMediaPanel
              initialKind={kind()}
              loadItems={(selected, offset) => engine.getSharedMedia(selected, offset)}
              loadMedia={(message) => loadMedia(message)}
              cachedMedia={(message) => cachedAssetUrl(engine.mediaAssetKey(message))}
              openMessage={(message) => {
                setSharedMediaKind(undefined);
                runInBackground(openMessage(message));
              }}
              close={() => setSharedMediaKind(undefined)}
            />
          )}
        </Show>

        <Show when={deleteTarget()}>
          {(message) => (
            <DeleteMessageDialog
              outgoing={message().outgoing}
              close={() => setDeleteTarget(undefined)}
              confirm={(revoke) => {
                const messageId = message().id;
                setDeleteTarget(undefined);
                void deleteMessage(messageId, revoke);
              }}
            />
          )}
        </Show>

        <Show when={deleteChatTarget()}>
          {(chat) => (
            <DeleteChatDialog
              chat={chat()}
              close={() => setDeleteChatTarget(undefined)}
              confirm={() => {
                const peerId = chat().id;
                const dialog = snapshot().dialogs.find(({ peer }) => peer.id === peerId);
                setDeleteChatTarget(undefined);
                if (!dialog) return;
                runInBackground(engine.deleteDialog(dialog.peer));
              }}
            />
          )}
        </Show>

        <Show when={botUrlAuth()}>
          {(pending) => (
            <BotUrlAuthDialog
              request={pending().request}
              busy={botUrlAuthBusy()}
              close={() => {
                if (!botUrlAuthBusy()) setBotUrlAuth(undefined);
              }}
              confirm={(options) => void acceptBotUrlAuth(options)}
            />
          )}
        </Show>

        <DetailsPane
          chat={activeChat()}
          counts={activeSharedCounts()}
          userDetails={activeUserDetails()}
          online={online()}
          modal={detailsOpen() && viewportWidth() <= 1100}
          avatarIdentity={avatarIdentity(activeChat().id)}
          loadCachedAvatar={() => loadAvatar(activeChat().id, true)}
          loadAvatar={() => loadAvatar(activeChat().id)}
          close={() => updateDetailsOpen(false)}
          openShared={setSharedMediaKind}
        />
      </div>
      <Show when={authOpen()}>
        <AuthOverlay
          open
          snapshot={snapshot()}
          {...(configurationError ? { configurationError } : {})}
          onRetry={retrySync}
          onPhone={(phone) => engine.requestCode(phone)}
          onCode={(code) => engine.submitCode(code)}
          onPassword={(password) => engine.submitPassword(password)}
        />
      </Show>
    </main>
  );
}
