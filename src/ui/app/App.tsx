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

import type { ChatMessage, ChatSummary } from '../../domain/models';
import { telegramPeerColor } from '../../domain/peerColor';
import type {
  EngineSnapshot,
  TelegramGroupMember,
  TelegramHistoryGap,
  TelegramMessage,
  TelegramPeer,
  SharedMediaKind,
  TelegramSticker,
  TelegramStickerPack,
} from '../../telegram/types';
import type { AppEnvironment } from './appRuntime';
import { BotControls } from '../bots/BotControls';
import { BotKeyboard } from '../bots/BotKeyboard';
import { BotUrlAuthDialog } from '../bots/BotUrlAuthDialog';
import { createBotSession } from '../bots/botSession';
import { ChatSidebar } from '../chat/ChatSidebar';
import { DeleteChatDialog } from '../chat/DeleteChatDialog';
import { DetailsPane } from '../chat/DetailsPane';
import { SearchPanel } from '../chat/SearchPanel';
import { SharedMediaPanel } from '../chat/SharedMediaPanel';
import { ChatComposer } from '../composer/ChatComposer';
import { createComposerSession } from '../composer/composerSession';
import { DeleteMessageDialog } from '../conversation/DeleteMessageDialog';
import { ForwardMessageDialog } from '../conversation/ForwardMessageDialog';
import { MessageActions } from '../conversation/MessageActions';
import { MessageAlbum } from '../conversation/MessageAlbum';
import { MessageBody } from '../conversation/MessageBody';
import {
  presentConversation,
  type KeyedMessageView,
} from '../conversation/conversationPresentation';
import { createConversationViewport } from '../conversation/conversationViewport';
import { layoutMessages } from '../conversation/messageLayout';
import { albumSafeMessageWindow } from '../conversation/messageWindow';
import { presentDialog } from '../conversation/presentation';
import { MediaAttachment } from '../media/MediaAttachment';
import { cachedAssetUrl, pruneAssetUrls, rememberAssetUrl } from '../media/assetUrls';
import { MediaAssets } from '../media/mediaAssets';
import { Avatar } from '../shared/Avatar';
import { AuthOverlay } from './AuthOverlay';
import { SettingsDialog } from './SettingsDialog';

const LEFT_SIDEBAR_STORAGE_KEY = 'televecha:left-sidebar-width';
const DETAILS_OPEN_STORAGE_KEY = 'televecha:details-open';
const LEFT_SIDEBAR_DEFAULT_WIDTH = 320;
const LEFT_SIDEBAR_MIN_WIDTH = 72;
const LEFT_SIDEBAR_MAX_WIDTH = 480;
const LEFT_SIDEBAR_COMPACT_WIDTH = 128;
const MAX_RENDERED_MESSAGES = 400;
const MAX_CACHED_MESSAGE_VIEWS = MAX_RENDERED_MESSAGES * 2;

function peerFromId(peerId: string): TelegramPeer {
  return {
    id: peerId,
    kind: peerId.startsWith('u:') ? 'user' : peerId.startsWith('g:') ? 'group' : 'channel',
  };
}

function senderInitials(name: string) {
  return name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase())
    .join('');
}

function messageSenderColor(message: ChatMessage) {
  return message.senderColorVersion === 2 && message.senderColor
    ? message.senderColor
    : telegramPeerColor(message.senderId ?? '');
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

function reuseArray<T>(previous: readonly T[], next: T[]) {
  return previous.length === next.length && previous.every((value, index) => value === next[index])
    ? previous
    : next;
}

interface StoredView<T extends object> {
  value: T;
  set: SetStoreFunction<T>;
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

interface AppProps {
  environment: AppEnvironment;
}

export function App(props: AppProps) {
  const environment = props.environment;
  const { credentials, configurationError } = environment;
  const { engine } = environment.runtime;
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
  const [messageScroller, setMessageScroller] = createSignal<HTMLDivElement>();
  const [messageContent, setMessageContent] = createSignal<HTMLDivElement>();
  const [conversationReady, setConversationReady] = createSignal(true);
  const [conversationLoadError, setConversationLoadError] = createSignal('');
  const [conversationRetrying, setConversationRetrying] = createSignal(false);
  const [syncRetrying, setSyncRetrying] = createSignal(false);
  const [loggingOut, setLoggingOut] = createSignal(false);
  const [clearingCache, setClearingCache] = createSignal(false);
  const [groupMembers, setGroupMembers] = createSignal<TelegramGroupMember[]>([]);
  const [groupMembersLoading, setGroupMembersLoading] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
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
  const [messageContextMenu, setMessageContextMenu] = createSignal<
    { messageId: string; x: number; y: number } | undefined
  >();
  const [forwardingMessage, setForwardingMessage] = createSignal<ChatMessage>();
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [sharedMediaKind, setSharedMediaKind] = createSignal<SharedMediaKind>();
  const [deleteTarget, setDeleteTarget] = createSignal<ChatMessage>();
  const [deleteChatTarget, setDeleteChatTarget] = createSignal<ChatSummary>();
  const [pinnedMessageIndex, setPinnedMessageIndex] = createSignal(0);
  const [replyKeyboardRevision, setReplyKeyboardRevision] = createSignal(0);
  const mediaAssets = new MediaAssets(engine, () => snapshot().dialogs);
  const dialogViews = new Map<string, StoredView<ChatSummary>>();
  const messageViews = new Map<string, StoredView<ChatMessage>>();
  const dismissedReplyKeyboards = new Set<string>();
  const handledForceReplies = new Set<string>();
  let appGridElement: HTMLDivElement | undefined;
  let conversationPaneElement: HTMLElement | undefined;
  let mobileSidebarTriggerElement: HTMLButtonElement | undefined;
  let stopSidebarResize: (() => void) | undefined;
  let olderLoadRunning = false;
  let olderLoadQueued = false;
  let openingMessage = false;
  let historyRestoreGeneration = 0;
  let visibilityFrame: number | undefined;
  let selectionGeneration = 0;
  let historyLoadGeneration = 0;
  let openMessageGeneration = 0;
  let peerOpenGeneration = 0;
  let viewport!: ReturnType<typeof createConversationViewport>;

  onCleanup(() => {
    selectionGeneration += 1;
    historyLoadGeneration += 1;
    historyRestoreGeneration += 1;
    openMessageGeneration += 1;
    olderLoadRunning = false;
    olderLoadQueued = false;
  });

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
    viewport.captureAnchor();
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
    viewport.captureAnchor();
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
    viewport.captureAnchor();
    saveLeftSidebarWidth(nextWidth);
  };

  const visibleChats = createMemo<ChatSummary[]>((previous) => {
    const next = snapshot()
      .dialogs.filter((dialog) => !dialog.transient)
      .map((dialog) => {
        const value = presentDialog(dialog);
        return stableView(dialogViews, dialog.peer.id, value);
      });
    return reuseArray(previous, next) as ChatSummary[];
  }, []);

  createEffect(() => {
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (contents?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const unread = snapshot().dialogs.reduce(
      (total, dialog) => total + Math.max(0, dialog.unreadCount),
      0,
    );
    const update =
      unread > 0 ? badgeNavigator.setAppBadge?.(unread) : badgeNavigator.clearAppBadge?.();
    if (update) runInBackground(update);
  });

  const activeChat = createMemo(() => {
    const listed = visibleChats().find((chat) => chat.id === activeChatId());
    if (listed) return listed;
    const transient = snapshot().dialogs.find(({ peer }) => peer.id === activeChatId());
    if (transient) {
      return stableView(dialogViews, transient.peer.id, presentDialog(transient));
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
  const composer = createComposerSession({
    engine,
    snapshot,
    activePeerId: activeChatId,
    activeDialog,
    canSend,
    beforeUiChange: () => {
      const scroller = messageScroller();
      if (!scroller) return;
      viewport.preserveReadingPosition(scroller);
    },
    focus: () =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
  });
  const activeUserDetails = createMemo(
    () => snapshot().dialogs.find(({ peer }) => peer.id === activeChatId())?.userDetails,
  );
  let groupMembersLoadGeneration = 0;
  createEffect(() => {
    const open = detailsOpen();
    const peerId = activeChatId();
    const kind = activeChat().kind;
    const generation = ++groupMembersLoadGeneration;
    setGroupMembers([]);
    setGroupMembersLoading(false);
    if (!open || !peerId || peerId === 'empty' || kind === 'user' || !kind) return;
    const dialog = untrack(() => activeDialog());
    if (!dialog) return;
    setGroupMembersLoading(true);
    void engine
      .getGroupMembers(dialog.peer)
      .then((members) => {
        if (generation === groupMembersLoadGeneration) setGroupMembers(members);
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation === groupMembersLoadGeneration) setGroupMembersLoading(false);
      });
  });
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
  const dismissSingleUseReplyKeyboard = (owner: string) => {
    if (owner !== 'reply') return;
    const current = visibleReplyKeyboard();
    if (!current?.keyboard.singleUse) return;
    dismissedReplyKeyboards.add(`${activeChatId()}:${current.messageId}`);
    setReplyKeyboardRevision((revision) => revision + 1);
  };
  createEffect(() => {
    const current = visibleReplyKeyboard();
    if (!current?.keyboard.forceReply) return;
    const key = `${activeChatId()}:${current.messageId}`;
    if (handledForceReplies.has(key)) return;
    if (composer.reply() || composer.editing()) return;
    handledForceReplies.add(key);
    composer.forceReply(
      current.messageId,
      current.message.text || current.message.media?.name || 'The bot requested a reply',
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
    return presentConversation(snapshot(), activeChatId());
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
  let reportConversationVisibility = () => {};
  viewport = createConversationViewport({
    scroller: messageScroller,
    activePeerId: activeChatId,
    messageCount: () => activeMessages().length,
    windowIncludesPresent: () => messageWindowBounds().end >= activeMessages().length,
    windowStart: messageWindowStart,
    setWindowStart: setMessageWindowStart,
    setJumpVisible: setJumpToPresentVisible,
    setReady: setConversationReady,
    maxRenderedMessages: MAX_RENDERED_MESSAGES,
    reportVisibility: () => reportConversationVisibility(),
    loadOlder: (scroller) => void loadOlderAtTop(scroller),
    invalidateHistoryRestore: () => {
      historyRestoreGeneration += 1;
    },
    cancelMessageOpen: () => {
      openMessageGeneration += 1;
      openingMessage = false;
    },
  });
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
  const messageLayouts = createMemo(
    (previous: ReturnType<typeof layoutMessages>) =>
      layoutMessages(renderedMessages(), activeChat(), snapshot().dialogs, previous),
    [],
  );
  createEffect(() => {
    const peerId = activeChatId();
    const messageCount = activeMessages().length;
    void peerId;
    if (viewport.followingPresent()) {
      setMessageWindowStart(Math.max(0, messageCount - MAX_RENDERED_MESSAGES));
    } else {
      setMessageWindowStart((start) => Math.min(start, Math.max(0, messageCount - 1)));
      queueMicrotask(() => {
        if (activeChatId() !== peerId || viewport.followingPresent()) return;
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
      viewport.resetForPeer();
      historyLoadGeneration += 1;
      olderLoadRunning = false;
      olderLoadQueued = false;
    }
    setConversationLoadError('');
    setActiveChatId(id);
    setMobileSidebarOpen(false);
    setStickerPickerOpen(false);
    setGifPickerOpen(false);
    setSearchOpen(false);
    setReactionPickerMessageId('');
    composer.switchPeer(previousPeerId, id, changingPeer);
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

  const bot = createBotSession({
    engine,
    snapshot,
    activePeerId: activeChatId,
    activeDialog,
    selectChat: (peerId) => selectChat(peerId),
    setDraft: composer.replaceDraft,
    dismissSingleUseKeyboard: dismissSingleUseReplyKeyboard,
    focusComposer: () =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
  });

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

  const logOut = async () => {
    if (loggingOut()) return;
    setLoggingOut(true);
    try {
      await engine.logOut();
      setActiveChatId('empty');
      composer.reset();
      setMobileSidebarOpen(false);
    } finally {
      setLoggingOut(false);
      setSettingsOpen(false);
    }
  };

  const clearCache = async () => {
    if (clearingCache() || loggingOut()) return;
    setClearingCache(true);
    try {
      mediaAssets.dispose();
      await engine.clearCache();
      setActiveChatId('empty');
      setSettingsOpen(false);
    } finally {
      setClearingCache(false);
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

  reportConversationVisibility = () => {
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
        Boolean(bot.inlineSwitch()) ||
        expressionPickerVisible() ||
        bot.menuOpen() ||
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
    void bot.inlineSwitch();
    void expressionPickerVisible();
    void bot.menuOpen();
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

  const mediaSourceFor = (messageId: string | number) =>
    snapshot().messages.find((candidate) => String(candidate.id) === String(messageId));

  createEffect(() => {
    const peerId = activeChatId();
    if (!peerId || !activeConversationLoaded()) return;
    if (openingMessage) {
      viewport.invalidateAlignment();
      setConversationReady(true);
      return;
    }
    const messageCount = untrack(() => activeMessages().length);
    viewport.positionAtPresent(peerId, messageCount, activeConversationLoaded);
  });

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const shiftMessageWindow = (direction: -1 | 1) => {
    const scroller = messageScroller();
    if (!scroller) return;
    viewport.invalidateAlignment();
    openMessageGeneration += 1;
    openingMessage = false;
    viewport.pauseAtHistory();
    const restoreAnchor = viewport.visibleAnchor(scroller);
    viewport.setAnchor(restoreAnchor);
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
      viewport.setAnchor(restoreAnchor);
      viewport.restoreAnchor(scroller, restoreAnchor);
      requestAnimationFrame(() => {
        if (
          restoreGeneration !== historyRestoreGeneration ||
          activeChatId() !== peerId ||
          messageScroller() !== scroller
        ) {
          return;
        }
        viewport.setAnchor(restoreAnchor);
        viewport.restoreAnchor(scroller, restoreAnchor);
        viewport.updateJump(scroller);
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
    viewport.pauseAtHistory();
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
        const pageAnchor = viewport.visibleAnchor(scroller);
        viewport.setAnchor(pageAnchor);
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
              viewport.setAnchor(pageAnchor);
              viewport.restoreAnchor(scroller, pageAnchor);
            }
            requestAnimationFrame(() => {
              if (
                generation === historyLoadGeneration &&
                restoreGeneration === historyRestoreGeneration &&
                activeChatId() === peerId &&
                messageScroller() === scroller
              ) {
                viewport.setAnchor(pageAnchor);
                viewport.restoreAnchor(scroller, pageAnchor);
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
    viewport.pauseAtHistory();
    setConversationReady(true);
    const generation = ++historyLoadGeneration;
    const peerId = activeChatId();
    const restoreGeneration = ++historyRestoreGeneration;
    olderLoadRunning = true;
    olderLoadQueued = false;
    const restoreAnchor = viewport.visibleAnchor(scroller);
    viewport.setAnchor(restoreAnchor);
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
      viewport.setAnchor(restoreAnchor);
      viewport.restoreAnchor(scroller, restoreAnchor);
      await nextFrame();
      if (
        generation !== historyLoadGeneration ||
        restoreGeneration !== historyRestoreGeneration ||
        activeChatId() !== peerId ||
        messageScroller() !== scroller
      ) {
        return;
      }
      viewport.setAnchor(restoreAnchor);
      viewport.restoreAnchor(scroller, restoreAnchor);
      viewport.updateJump(scroller);
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

  onMount(() => {
    let narrowLayout = window.innerWidth <= 1100;
    const scroller = messageScroller();
    const content = messageContent();
    const resizeObserver =
      scroller && content
        ? new ResizeObserver(() => {
            if (viewport.followingPresent()) viewport.alignToPresent(scroller);
            else {
              viewport.restoreAnchor(scroller);
              viewport.ensureAnchor();
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
    scroller?.addEventListener('pointerdown', viewport.handlePointerDown, true);
    scroller?.addEventListener('pointermove', viewport.handlePointerMove, true);
    scroller?.addEventListener('pointerup', viewport.handlePointerEnd, true);
    scroller?.addEventListener('pointercancel', viewport.handlePointerEnd, true);
    const dismissMenus = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest?.('.message-context-menu')) setMessageContextMenu(undefined);
      if (!target.closest?.('.reaction-picker')) setReactionPickerMessageId('');
      if (!target.closest?.('.bot-command-bar')) bot.closeMenu();
    };
    const dismissMenusWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (
        messageContextMenu() ||
        reactionPickerMessageId() ||
        forwardingMessage() ||
        bot.inlineSwitch() ||
        bot.menuOpen()
      ) {
        setMessageContextMenu(undefined);
        setReactionPickerMessageId('');
        setForwardingMessage(undefined);
        bot.closeInlineSwitch();
        bot.closeMenu();
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
      viewport.captureAnchor();
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
          viewport.resetForPeer();
          selectionGeneration += 1;
          historyLoadGeneration += 1;
          olderLoadRunning = false;
          olderLoadQueued = false;
          setActiveChatId('empty');
          composer.reset();
          setSearchOpen(false);
          setSharedMediaKind(undefined);
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
      unsubscribe();
      resizeObserver?.disconnect();
      scroller?.removeEventListener('pointerdown', viewport.handlePointerDown, true);
      scroller?.removeEventListener('pointermove', viewport.handlePointerMove, true);
      scroller?.removeEventListener('pointerup', viewport.handlePointerEnd, true);
      scroller?.removeEventListener('pointercancel', viewport.handlePointerEnd, true);
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
      mediaAssets.dispose();
      const badgeNavigator = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
      if (badgeNavigator.clearAppBadge) runInBackground(badgeNavigator.clearAppBadge());
      if (!import.meta.hot) runInBackground(engine.stop());
    });
  });

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

  const sendSticker = async (sticker: TelegramSticker) => {
    const dialog = snapshot().dialogs.find(({ peer }) => peer.id === activeChatId());
    if (!dialog || !online()) return;
    const reply = composer.reply();
    setStickerPickerOpen(false);
    composer.clearReply();
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
    viewport.pauseAtHistory();
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
      viewport.setAnchor({ messageId: String(messageId), top: target.getBoundingClientRect().top });
      target.classList.add('message-target');
      window.setTimeout(() => target.classList.remove('message-target'), 1200);
      if (scroller) viewport.updateJump(scroller);
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
    viewport.pauseAtHistory();
    let revealed = false;
    try {
      const selected = await selectChat(message.peerId, generation);
      const selection = selectionGeneration;
      if (!selected || generation !== openMessageGeneration || activeChatId() !== message.peerId)
        return;
      viewport.pauseAtHistory();
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
          if (scroller) viewport.updateJump(scroller, true);
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
          avatarIdentity={(peerId) => mediaAssets.avatarIdentity(peerId)}
          loadCachedAvatar={(peerId) => mediaAssets.loadAvatar(peerId, true)}
          loadAvatar={(peerId) => mediaAssets.loadAvatar(peerId)}
          loadPeerAvatar={(result, cachedOnly) =>
            mediaAssets.loadPeerAvatar(result.peer, result.hasAvatar, result.avatarId, cachedOnly)
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
          openSettings={() => {
            setMobileSidebarOpen(false);
            setSettingsOpen(true);
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
          <header
            class="chat-header flex h-16 shrink-0 items-center justify-between border-b border-[var(--line)] bg-[var(--panel)] px-4"
            data-testid="conversation-header"
          >
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
                identity={mediaAssets.avatarIdentity(activeChat().id)}
                initials={activeChat().initials}
                color={activeChat().color}
                size="sm"
                online={activeChat().presence === 'online'}
                loadCached={() => mediaAssets.loadAvatar(activeChat().id, true)}
                load={online() ? () => mediaAssets.loadAvatar(activeChat().id) : undefined}
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
              class={`message-scroller scroll-area relative h-full min-h-0 overflow-y-auto overscroll-contain px-5 py-6${activeChat().kind === 'channel' ? ' channel-messages' : ''}`}
              data-testid="message-scroller"
              onKeyDown={viewport.handleKeyDown}
              onScroll={viewport.handleScroll}
              onWheel={viewport.handleWheel}
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
                  {(message, index) => {
                    const layout = () => messageLayouts()[index()]!;
                    return (
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
                        <Show when={layout().showDateDivider}>
                          <div class="my-3 self-center rounded-full border border-white/5 bg-black/25 px-3 py-1 text-[11px] font-medium text-[var(--muted)] backdrop-blur">
                            {new Intl.DateTimeFormat(undefined, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            }).format(new Date((message.date ?? 0) * 1000))}
                          </div>
                        </Show>
                        <article
                          class={layout().className}
                          style={{ width: layout().width }}
                          data-message-id={message.id}
                          data-media-kind={message.media?.kind}
                          hidden={layout().hide}
                          aria-label={message.service?.text}
                          onContextMenu={(event) => openMessageActions(message, event)}
                        >
                          <Show when={layout().showSenderAvatar}>
                            <span class="message-sender-avatar" aria-hidden="true">
                              <Avatar
                                identity={`${message.senderId}:${message.senderAvatarId ?? 'none'}`}
                                initials={senderInitials(layout().author || message.author)}
                                color={messageSenderColor(message)}
                                size="sm"
                                loadCached={
                                  message.senderHasAvatar !== false
                                    ? () =>
                                        mediaAssets.loadPeerAvatar(
                                          peerFromId(message.senderId!),
                                          true,
                                          message.senderAvatarId,
                                          true,
                                        )
                                    : undefined
                                }
                                load={
                                  online() && message.senderHasAvatar !== false
                                    ? () =>
                                        mediaAssets.loadPeerAvatar(
                                          peerFromId(message.senderId!),
                                          true,
                                          message.senderAvatarId,
                                        )
                                    : undefined
                                }
                              />
                            </span>
                          </Show>
                          <Show when={!message.service && layout().author}>
                            <strong
                              class="message-author"
                              style={{ color: messageSenderColor(message) }}
                            >
                              <span>{layout().author}</span>
                              <Show when={message.senderRole}>
                                <span
                                  class={`message-sender-role ${message.senderRoleKind === 'owner' ? 'owner' : 'admin'}`}
                                >
                                  {message.senderRole}
                                </span>
                              </Show>
                            </strong>
                          </Show>
                          <Show when={message.replyTo}>
                            <button
                              class="message-reply"
                              onClick={() =>
                                message.replyToId &&
                                runInBackground(scrollToReply(message.replyToId))
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
                                        ? mediaAssets.loadMedia(source)
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
                          <Show when={layout().album.length > 1}>
                            <MessageAlbum
                              messages={layout().album}
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
                                if (source) return mediaAssets.loadMedia(source);
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
                          <Show when={layout().media}>
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
                                    if (source) return mediaAssets.loadMedia(source);
                                    const pendingSticker = snapshot().pending.find(
                                      (send) => send.id === message.id,
                                    )?.sticker;
                                    return pendingSticker
                                      ? mediaAssets.loadSticker(pendingSticker)
                                      : Promise.reject(
                                          new Error('Attachment data is unavailable.'),
                                        );
                                  }}
                                />
                              </Show>
                            )}
                          </Show>
                          <div class="message-copy">
                            <MessageBody
                              message={layout().caption}
                              loadPreviewPhoto={
                                message.linkPreview?.hasPhoto
                                  ? () => {
                                      const source = snapshot().messages.find(
                                        (candidate) => String(candidate.id) === message.id,
                                      );
                                      return source
                                        ? mediaAssets.loadMedia(source)
                                        : Promise.reject(
                                            new Error('Preview image is unavailable.'),
                                          );
                                    }
                                  : undefined
                              }
                            />
                            <footer
                              aria-label={
                                message.outgoing
                                  ? `${layout().caption.editedAt ? 'Edited. ' : ''}${layout().caption.time}. Message status: ${message.status ?? 'sent'}`
                                  : undefined
                              }
                            >
                              <Show when={layout().caption.editedAt}>
                                <span class="message-edited">edited</span>
                              </Show>
                              <span>{layout().caption.time}</span>
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
                                  bot.buttonBusy()?.owner === message.id
                                    ? bot.buttonBusy()?.key
                                    : undefined
                                }
                                label={`Actions for message ${message.id}`}
                                onPress={(button, key) =>
                                  void bot.press(button, message.id, key, Number(message.id))
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
                                <p>{pending().lastError}</p>
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
                              reply={(article) => composer.beginReply(message, article)}
                              loadCustomEmoji={(documentId) =>
                                mediaAssets.loadCustomEmoji(documentId)
                              }
                            />
                          </Show>
                        </article>
                      </>
                    );
                  }}
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
                              if (element) composer.beginReply(message, element);
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
                                composer.beginEdit(message);
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
                onClick={() => {
                  openMessageGeneration += 1;
                  openingMessage = false;
                  viewport.jumpToPresent();
                }}
              >
                <ArrowDown size={19} />
              </button>
            </Show>
          </div>

          <Show when={bot.notice()}>
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
                activeChat().kind === 'group' ||
                bot.commandsLoading() ||
                bot.commands().length > 0 ||
                Boolean(visibleReplyKeyboard()?.keyboard.rows.some((row) => row.length > 0)))
            }
          >
            <BotControls
              isBot={Boolean(activeChat().bot)}
              showCommands={Boolean(
                activeChat().bot ||
                activeChat().kind === 'group' ||
                bot.commandsLoading() ||
                bot.commands().length > 0,
              )}
              started={botStarted()}
              enabled={canSend()}
              starting={bot.starting()}
              menuOpen={bot.menuOpen()}
              loadingCommands={bot.commandsLoading()}
              commands={bot.commands()}
              replyKeyboard={visibleReplyKeyboard()?.keyboard}
              busyButton={bot.buttonBusy()?.owner === 'reply' ? bot.buttonBusy()?.key : undefined}
              onToggleMenu={bot.toggleMenu}
              onStart={() => void bot.start()}
              onCommand={bot.sendCommand}
              onReplyButton={(button, key) =>
                void bot.press(button, 'reply', key, visibleReplyKeyboard()?.messageId)
              }
            />
          </Show>
          <ChatComposer
            conversationId={activeChatId()}
            draft={composer.draft()}
            placeholder={visibleReplyKeyboard()?.keyboard.placeholder}
            enabled={canSend()}
            stickerPickerOpen={stickerPickerOpen()}
            stickerPickerLoading={stickerPickerLoading()}
            gifPickerOpen={gifPickerOpen()}
            gifPickerLoading={gifPickerLoading()}
            gifs={savedGifs()}
            stickerPacks={stickerPacks()}
            reply={composer.reply()}
            editing={
              composer.editing()
                ? {
                    body: composer.editing()!.body,
                    mediaName: composer.editing()!.media?.name,
                    hasMedia: Boolean(composer.editing()!.media),
                  }
                : undefined
            }
            attachments={composer.attachments()}
            formats={composer.formats()}
            onDraft={composer.changeDraft}
            onFormats={composer.setFormats}
            onSend={() => void composer.send()}
            onAttach={composer.attach}
            onUpdateAttachment={composer.updateAttachment}
            onRemoveAttachment={composer.removeAttachment}
            onToggleStickers={() => runInBackground(toggleStickerPicker())}
            onToggleGifs={() => runInBackground(toggleGifPicker())}
            onLoadSticker={(sticker) => mediaAssets.loadSticker(sticker)}
            stickerUrl={(sticker) => cachedAssetUrl(`sticker:${sticker.id}`)}
            onSendSticker={(sticker) => void sendSticker(sticker)}
            onSendGif={(gif) => void sendGif(gif)}
            onSearchGifs={(query) => engine.searchGifs(query)}
            onCancelReply={composer.clearReply}
            onCancelEdit={composer.cancelEdit}
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

        <Show when={bot.inlineSwitch()}>
          <ForwardMessageDialog
            chats={visibleChats().filter(({ id }) => id !== activeChatId())}
            title="Choose a chat"
            label="Choose a chat for inline query"
            cancelLabel="Cancel inline query"
            close={bot.closeInlineSwitch}
            forward={(peerId) => void bot.chooseInlineChat(peerId)}
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
              loadMedia={(message) => mediaAssets.loadMedia(message)}
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

        <Show when={bot.urlAuth()}>
          {(pending) => (
            <BotUrlAuthDialog
              request={pending().request}
              busy={bot.urlAuthBusy()}
              close={bot.closeUrlAuth}
              confirm={(options) => void bot.acceptUrlAuth(options)}
            />
          )}
        </Show>

        <Show when={settingsOpen()}>
          <SettingsDialog
            loggingOut={loggingOut()}
            clearingCache={clearingCache()}
            close={() => !loggingOut() && !clearingCache() && setSettingsOpen(false)}
            clearCache={() => void clearCache()}
            logOut={() => void logOut()}
          />
        </Show>

        <DetailsPane
          chat={activeChat()}
          counts={activeSharedCounts()}
          userDetails={activeUserDetails()}
          members={groupMembers()}
          membersLoading={groupMembersLoading()}
          online={online()}
          modal={detailsOpen() && viewportWidth() <= 1100}
          avatarIdentity={mediaAssets.avatarIdentity(activeChat().id)}
          loadCachedAvatar={() => mediaAssets.loadAvatar(activeChat().id, true)}
          loadAvatar={() => mediaAssets.loadAvatar(activeChat().id)}
          loadCachedMemberAvatar={(member) =>
            mediaAssets.loadPeerAvatar(member.peer, member.hasAvatar, member.avatarId, true)
          }
          loadMemberAvatar={(member) =>
            mediaAssets.loadPeerAvatar(member.peer, member.hasAvatar, member.avatarId)
          }
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
