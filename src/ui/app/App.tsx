import ArrowDown from 'lucide-solid/icons/arrow-down';
import Check from 'lucide-solid/icons/check';
import CheckCheck from 'lucide-solid/icons/check-check';
import ChevronDown from 'lucide-solid/icons/chevron-down';
import ChevronUp from 'lucide-solid/icons/chevron-up';
import CircleAlert from 'lucide-solid/icons/circle-alert';
import Clock3 from 'lucide-solid/icons/clock-3';
import Copy from 'lucide-solid/icons/copy';
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
  on,
  onCleanup,
  onMount,
} from 'solid-js';
import { createStore, reconcile, type SetStoreFunction } from 'solid-js/store';

import { completeReproReplay, waitForReproSequence } from '../../debug/reproRuntime';
import type { ChatMessage, ChatSummary } from '../../domain/models';
import { messageTextForClipboard } from '../../domain/messageText';
import { telegramPeerColor } from '../../domain/peerColor';
import type { Conversation } from '../../telegram/core/conversation';
import type {
  EngineSnapshot,
  TelegramMessage,
  TelegramPeer,
  SharedMediaKind,
} from '../../telegram/types';
import type { AppEnvironment } from './appRuntime';
import { BotControls } from '../bots/BotControls';
import { BotKeyboard } from '../bots/BotKeyboard';
import { BotUrlAuthDialog } from '../bots/BotUrlAuthDialog';
import { createBotSession } from '../bots/botSession';
import { createReplyKeyboardSession } from '../bots/replyKeyboardSession';
import { ChatSidebar } from '../chat/ChatSidebar';
import { ChatDirectory } from '../chat/chatDirectory';
import { createContactDetailsSession } from '../chat/contactDetailsSession';
import { DeleteChatDialog } from '../chat/DeleteChatDialog';
import { DetailsPane } from '../chat/DetailsPane';
import { SearchPanel } from '../chat/SearchPanel';
import { SharedMediaPanel } from '../chat/SharedMediaPanel';
import { ChatComposer } from '../composer/ChatComposer';
import { createComposerSession } from '../composer/composerSession';
import { createExpressionSession } from '../composer/expressionSession';
import { DeleteMessageDialog } from '../conversation/DeleteMessageDialog';
import { ForwardMessageDialog } from '../conversation/ForwardMessageDialog';
import { MessageActions } from '../conversation/MessageActions';
import { MessageAlbum } from '../conversation/MessageAlbum';
import { MessageBody } from '../conversation/MessageBody';
import { createConversationHeaderSession } from '../conversation/conversationHeaderSession';
import { createConversationHistorySession } from '../conversation/conversationHistorySession';
import {
  presentConversation,
  type KeyedMessageView,
} from '../conversation/conversationPresentation';
import { createConversationViewport } from '../conversation/conversationViewport';
import { layoutMessages } from '../conversation/messageLayout';
import { presentDialog, presentMessage } from '../conversation/presentation';
import { MediaAttachment, type MediaPreview } from '../media/MediaAttachment';
import { MediaAssets, type MediaAsset } from '../media/mediaAssets';
import { MediaViewer } from '../media/MediaViewer';
import { copyImageUrl, saveMediaUrl } from '../media/mediaActions';
import { mediaPresentation } from '../media/mediaPresentation';
import { Avatar } from '../shared/Avatar';
import { modalVisible } from '../shared/focusScope';
import { createAppearanceSession } from '../theme/appearanceSession';
import { createChatAppearanceSession } from '../theme/chatAppearanceSession';
import { AuthOverlay } from './AuthOverlay';
import { createDrawerFocusSession } from './drawerFocusSession';
import { SettingsDialog } from './SettingsDialog';
import { createSidebarLayout } from './sidebarLayout';

const MAX_CACHED_MESSAGE_VIEWS = 800;

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

function messageLayoutRevision(messages: TelegramMessage[]) {
  return JSON.stringify(
    messages.map(
      ({
        id,
        text,
        editedAt,
        groupedId,
        replyToId,
        replyQuote,
        service,
        media,
        formats,
        richMessage,
        botKeyboard,
      }) => ({
        id,
        text,
        editedAt,
        groupedId,
        replyToId,
        replyQuote,
        service,
        media,
        formats,
        richMessage,
        botKeyboard,
      }),
    ),
  );
}

interface AppProps {
  environment: AppEnvironment;
}

export function App(props: AppProps) {
  const environment = props.environment;
  const { credentials, configurationError } = environment;
  const { engine } = environment.runtime;
  let initialUrlPeerId = new URL(window.location.href).searchParams.get('chat') ?? undefined;
  const [snapshot, setSnapshot] = createSignal<EngineSnapshot>(engine.snapshot());
  const [authOpen, setAuthOpen] = createSignal(engine.snapshot().phase !== 'ready');
  const [activeChatId, setActiveChatId] = createSignal('empty');
  const [activeConversation, setActiveConversation] = createSignal<Conversation>();
  const sidebarLayout = createSidebarLayout({
    captureConversationAnchor: () => viewport.captureAnchor(),
  });
  const {
    detailsOpen,
    setDetailsOpen,
    viewportWidth,
    setViewportWidth,
    mobileOpen: mobileSidebarOpen,
    setMobileOpen: setMobileSidebarOpen,
    resizing: resizingLeftSidebar,
    effectiveWidth: effectiveLeftSidebarWidth,
    updateDetailsOpen,
    toggleMobile: toggleMobileSidebar,
  } = sidebarLayout;
  let messageScroller: HTMLDivElement | undefined;
  let messageContent: HTMLDivElement | undefined;
  const [conversationLoadError, setConversationLoadError] = createSignal('');
  const [conversationRetrying, setConversationRetrying] = createSignal(false);
  const [syncRetrying, setSyncRetrying] = createSignal(false);
  const [loggingOut, setLoggingOut] = createSignal(false);
  const [clearingCache, setClearingCache] = createSignal(false);
  const [debugReportBusy, setDebugReportBusy] = createSignal(false);
  const [debugReportError, setDebugReportError] = createSignal('');
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const appearanceSession = createAppearanceSession({
    getWallpapers: () => engine.getWallpapers(),
    downloadWallpaper: (wallpaperId) => engine.downloadWallpaper(wallpaperId),
  });
  const {
    appearance,
    telegramWallpapers,
    catalogLoading: appearanceCatalogLoading,
    wallpaperBusy,
    wallpaperError,
    selectTheme,
    selectAccentColor,
    selectSystemAccent,
    selectChatFontSize,
    selectWallpaper,
    selectTelegramWallpaper,
    uploadWallpaper,
  } = appearanceSession;
  const [pendingActionId, setPendingActionId] = createSignal('');
  const [reactionPickerMessageId, setReactionPickerMessageId] = createSignal('');
  const [messageContextMenu, setMessageContextMenu] = createSignal<
    { messageId: string; x: number; y: number } | undefined
  >();
  const [forwardingMessage, setForwardingMessage] = createSignal<ChatMessage>();
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [sharedMediaKind, setSharedMediaKind] = createSignal<SharedMediaKind>();
  const [deleteTarget, setDeleteTarget] = createSignal<ChatMessage>();
  const [mediaViewer, setMediaViewer] = createSignal<
    | {
        messages: ChatMessage[];
        index: number;
        preview: MediaPreview;
        loading: boolean;
      }
    | undefined
  >();
  const [deleteChatTarget, setDeleteChatTarget] = createSignal<ChatSummary>();
  const mediaAssets = new MediaAssets(engine, () => snapshot().dialogs);
  const dialogViews = new Map<string, StoredView<ChatSummary>>();
  const messageViews = new Map<string, StoredView<ChatMessage>>();
  let appGridElement: HTMLDivElement | undefined;
  let conversationPaneElement: HTMLElement | undefined;
  let mobileSidebarTriggerElement: HTMLButtonElement | undefined;
  let openingMessage = false;
  let visibilityFrame: number | undefined;
  let selectionGeneration = 0;
  let conversationRetryGeneration = 0;
  let openMessageGeneration = 0;
  let replaySelectionsStarted = false;
  let viewport!: ReturnType<typeof createConversationViewport>;
  let history!: ReturnType<typeof createConversationHistorySession>;

  onCleanup(() => {
    selectionGeneration += 1;
    conversationRetryGeneration += 1;
    openMessageGeneration += 1;
  });

  const openSettings = () => {
    setMobileSidebarOpen(false);
    setSettingsOpen(true);
    if (!telegramWallpapers().length && !appearanceCatalogLoading()) {
      // Loading the export UI must not become part of the bug being exported.
      environment.runtime.debugReports?.ignoreNextTransportCall?.('getWallpapers');
      void appearanceSession.loadCatalog();
    }
  };

  const online = () => {
    const current = snapshot() as EngineSnapshot & { online?: boolean };
    return current.phase === 'ready' && current.online !== false;
  };
  const activePeerMatches = () => {
    const peerId = activeChatId();
    return peerId !== 'empty' && snapshot().activePeerId === peerId;
  };
  const activeConversationReady = () =>
    activePeerMatches() && activeConversation()?.peerId === activeChatId();
  const hasCachedWorkspace = () => snapshot().dialogs.length > 0;
  const canSend = () => online() && activeConversationReady();

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
  createEffect(() => {
    const chat = activeChat();
    document.title = chat.id === 'empty' ? 'TeleVecha' : `${chat.title} - TeleVecha`;
  });
  onCleanup(() => {
    document.title = 'TeleVecha';
  });
  const activeSharedCounts = createMemo(() =>
    activePeerMatches() ? snapshot().sharedMediaCounts : undefined,
  );
  const activeHistoryError = createMemo(() =>
    activePeerMatches() ? snapshot().historyError : undefined,
  );
  const activeLoadingOlderMessages = createMemo(
    () => activePeerMatches() && snapshot().loadingOlderMessages,
  );
  const conversationSwitching = createMemo(
    () => activeChatId() !== 'empty' && !activePeerMatches(),
  );
  createEffect(() => {
    const peerId = activeChatId();
    const current = snapshot();
    if (
      peerId !== 'empty' &&
      current.online &&
      current.activePeerId === peerId &&
      !current.sharedMediaCounts
    ) {
      runInBackground(engine.ensureSharedMediaCounts(peerId));
    }
  });
  const activeDialog = createMemo(() =>
    snapshot().dialogs.find(({ peer }) => peer.id === activeChatId()),
  );
  const chatAppearance = createChatAppearanceSession({
    source: engine,
    activeDialog,
    preferences: appearance,
  });
  const composer = createComposerSession({
    conversation: activeConversation,
    snapshot,
    activePeerId: activeChatId,
    activeDialog,
    canSend,
    beforeUiChange: () => {
      const scroller = messageScroller;
      if (!scroller) return;
      viewport.preserveReadingPosition(scroller);
    },
    beforeSend: () => viewport.jumpToPresent(),
    focus: () =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
    onReply: (messageId) => {
      const peerId = activeChatId();
      const reports = environment.runtime.debugReports;
      reports?.recordComposerReply?.(peerId, messageId);
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        reports?.recordComposerFocus?.(peerId, document.activeElement === input);
      });
    },
    onSend: (text) => {
      const peerId = activeChatId();
      const reports = environment.runtime.debugReports;
      reports?.recordComposerSend?.(peerId, text);
      const record = (phase: 'before-send' | 'after-send', sample: number) => {
        const scroller = messageScroller;
        if (!scroller) return;
        reports?.recordViewport?.(peerId, phase, sample, {
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
        });
      };
      record('before-send', 0);
      let sample = 0;
      const sampleFrames = () => {
        sample += 1;
        record('after-send', sample);
        if (sample < 8) requestAnimationFrame(sampleFrames);
      };
      requestAnimationFrame(sampleFrames);
    },
  });
  const canonicalDraft = createMemo(() => {
    const peerId = activeChatId();
    return peerId === 'empty' ? '' : (snapshot().drafts[peerId] ?? '');
  });
  createEffect(
    on(canonicalDraft, (draft) => {
      if (activeChatId() === 'empty' || composer.editing() || composer.draft() === draft) return;
      composer.syncDraft(draft);
    }),
  );
  const expressions = createExpressionSession({
    source: engine,
    conversation: activeConversation,
    online,
    reply: composer.reply,
    clearReply: composer.clearReply,
  });
  const expressionPickerVisible = expressions.visible;
  const closeConversationOverlays = () => {
    expressions.close();
    setMessageContextMenu(undefined);
    setReactionPickerMessageId('');
    setForwardingMessage(undefined);
    setSearchOpen(false);
    setSharedMediaKind(undefined);
    setDeleteTarget(undefined);
  };
  const contactDetails = createContactDetailsSession({
    source: engine,
    dialog: activeDialog,
    detailsOpen,
  });
  const replyKeyboard = createReplyKeyboardSession({
    snapshot,
    activePeerId: activeChatId,
    reply: composer.reply,
    editing: composer.editing,
    forceReply: composer.forceReply,
  });
  const {
    visible: visibleReplyKeyboard,
    botStarted,
    dismissSingleUse: dismissSingleUseReplyKeyboard,
  } = replyKeyboard;
  createEffect(
    on(
      () => {
        const dialog = activeDialog();
        return snapshot().phase === 'ready' && dialog?.peer.kind === 'user' && !dialog.userDetails
          ? dialog.peer.id
          : '';
      },
      (peerId) => {
        if (!peerId) return;
        const dialog = activeDialog();
        if (dialog?.peer.id === peerId)
          void engine.getUserDetails(dialog.peer).catch(() => undefined);
      },
    ),
  );
  const activeMessageEntries = createMemo<KeyedMessageView[]>(() => {
    return presentConversation(snapshot(), activeChatId());
  });
  createEffect(
    on(
      () => messageLayoutRevision(snapshot().messages),
      () => setMessageContextMenu(undefined),
      { defer: true },
    ),
  );
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
  let reportConversationVisibility = () => {};
  viewport = createConversationViewport({
    scroller: () => messageScroller,
    activePeerId: activeChatId,
    messages: activeMessages,
    canLoadOlder: () => {
      const current = snapshot();
      return (
        current.activePeerId === activeChatId() &&
        current.hasOlderMessages &&
        !current.loadingMessages &&
        !current.loadingOlderMessages
      );
    },
    reportVisibility: () => reportConversationVisibility(),
    loadOlder: (scroller) => history.loadOlder(scroller),
    cancelMessageOpen: () => {
      openMessageGeneration += 1;
      openingMessage = false;
    },
  });
  const renderedMessages = createMemo<ChatMessage[]>((previous) => {
    const entries = activeMessageEntries();
    const visibleEntries = entries;
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
  const conversationHeader = createConversationHeaderSession({
    snapshot,
    chat: activeChat,
    activePeerId: activeChatId,
    activePeerMatches,
    online,
  });
  const {
    status: activeStatus,
    pinnedMessage: activePinnedMessage,
    pinnedIndex: pinnedMessageIndex,
    setPinnedIndex: setPinnedMessageIndex,
  } = conversationHeader;
  const activePinnedCount = createMemo(() =>
    activePeerMatches() ? snapshot().pinnedMessages.length : 0,
  );
  const activeConversationLoaded = createMemo(() => {
    const current = snapshot();
    return (
      current.activePeerId === activeChatId() &&
      (!current.loadingMessages || current.messages.length > 0)
    );
  });
  history = createConversationHistorySession({
    snapshot,
    activePeerId: activeChatId,
    conversation: activeConversation,
    loaded: activeConversationLoaded,
    openingMessage: () => openingMessage,
    scroller: () => messageScroller,
    viewport: () => viewport,
  });

  const updateChatUrl = (peerId: string, mode: 'push' | 'replace') => {
    const url = new URL(window.location.href);
    url.searchParams.set('chat', peerId);
    window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', url);
  };

  const selectChat = async (
    id: string,
    linkedOpenGeneration?: number,
    urlMode: 'push' | 'replace' | 'none' = 'push',
  ) => {
    if (!environment.replay) {
      environment.runtime.debugReports?.recordPeerSelection?.(id);
    }
    if (linkedOpenGeneration === undefined) {
      openMessageGeneration += 1;
      openingMessage = false;
    } else if (linkedOpenGeneration !== openMessageGeneration) {
      return false;
    }
    if (
      id === activeChatId() &&
      activeConversation()?.peerId === id &&
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
      conversationRetryGeneration += 1;
      setActiveConversation(undefined);
      setConversationRetrying(false);
      viewport.resetForPeer();
      history.reset();
    }
    setConversationLoadError('');
    setActiveChatId(id);
    setMobileSidebarOpen(false);
    closeConversationOverlays();
    composer.switchPeer(previousPeerId, id, changingPeer);
    try {
      const conversation = await engine.openConversation(id);
      if (generation !== selectionGeneration || activeChatId() !== id) return false;
      setActiveConversation(conversation);
      const current = engine.snapshot();
      if (current.activePeerId === id && urlMode !== 'none') updateChatUrl(id, urlMode);
      if (
        current.activePeerId === id &&
        !current.loadingMessages &&
        current.messages.length === 0 &&
        current.historyError
      ) {
        setConversationLoadError(current.historyError);
      }
      if (changingPeer) composer.focus();
      return current.activePeerId === id;
    } catch (cause) {
      if (generation === selectionGeneration && activeChatId() === id) {
        setConversationLoadError(cause instanceof Error ? cause.message : String(cause));
        viewport.setReady(true);
      }
      return false;
    }
  };
  const chatDirectory = new ChatDirectory(engine, () => snapshot().dialogs, selectChat);

  const bot = createBotSession({
    conversation: activeConversation,
    snapshot,
    activePeerId: activeChatId,
    activeDialog,
    selectChat: (peerId) => selectChat(peerId),
    setDraft: composer.replaceDraft,
    dismissSingleUseKeyboard: dismissSingleUseReplyKeyboard,
    focusComposer: () =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
    resources: engine,
  });

  const retryConversation = async () => {
    const peerId = activeChatId();
    const conversation = activeConversation();
    if (
      conversationRetrying() ||
      peerId === 'empty' ||
      !conversation ||
      conversation.peerId !== peerId
    ) {
      return;
    }
    const generation = ++conversationRetryGeneration;
    const stillCurrent = () =>
      generation === conversationRetryGeneration &&
      activeChatId() === peerId &&
      activeConversation() === conversation;
    setConversationRetrying(true);
    setConversationLoadError('');
    viewport.setReady(false);
    try {
      if (!engine.snapshot().online) await engine.retrySync();
      if (!stillCurrent()) return;
      await conversation.retryHistory();
      if (!stillCurrent()) return;
      const current = engine.snapshot();
      if (!current.loadingMessages && current.messages.length === 0 && current.historyError) {
        setConversationLoadError(current.historyError);
      }
    } catch (cause) {
      if (stillCurrent()) {
        setConversationLoadError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (stillCurrent()) {
        setConversationRetrying(false);
        viewport.setReady(true);
      }
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
      conversationRetryGeneration += 1;
      setActiveChatId('empty');
      setActiveConversation(undefined);
      setConversationLoadError('');
      setConversationRetrying(false);
      closeConversationOverlays();
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
      conversationRetryGeneration += 1;
      setActiveChatId('empty');
      setActiveConversation(undefined);
      setConversationLoadError('');
      setConversationRetrying(false);
      closeConversationOverlays();
      setSettingsOpen(false);
    } finally {
      setClearingCache(false);
    }
  };

  const downloadDebugReport = async () => {
    const reports = environment.runtime.debugReports;
    if (!reports || debugReportBusy()) return;
    setDebugReportBusy(true);
    setDebugReportError('');
    try {
      const { file } = await reports.prepare();
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setDebugReportError(
        cause instanceof Error ? cause.message : 'TeleVecha could not prepare the debug report.',
      );
    } finally {
      setDebugReportBusy(false);
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
      const scroller = messageScroller;
      const atBottom = Boolean(scroller && viewport.followingPresent());
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
        modalVisible();
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

  createEffect(
    on(
      () => [
        activeChatId(),
        mobileSidebarOpen(),
        detailsOpen(),
        searchOpen(),
        sharedMediaKind(),
        forwardingMessage(),
        deleteTarget(),
        deleteChatTarget(),
        bot.inlineSwitch(),
        expressionPickerVisible(),
        bot.menuOpen(),
        authOpen(),
        modalVisible(),
      ],
      reportConversationVisibility,
    ),
  );

  createDrawerFocusSession({
    root: () => appGridElement,
    conversationPane: () => conversationPaneElement,
    mobileTrigger: () => mobileSidebarTriggerElement,
    mobileOpen: mobileSidebarOpen,
    detailsOpen,
    viewportWidth,
    closeMobile: () => setMobileSidebarOpen(false),
    closeDetails: () => updateDetailsOpen(false),
  });

  const mediaSourceFor = (messageId: string | number) =>
    snapshot().messages.find((candidate) => String(candidate.id) === String(messageId));
  const mediaAssetFor = (messageId: string | number): MediaAsset | undefined => {
    const id = String(messageId);
    const source = mediaSourceFor(id);
    if (source) return mediaAssets.message(source);
    const pending = pendingAttachmentForMessage(id);
    if (pending) return mediaAssets.pending(activeChatId(), id, pending.blob);
    const sticker = pendingSendForMessage(id)?.sticker;
    return sticker ? mediaAssets.sticker(sticker) : undefined;
  };
  const mediaPreviewAssetFor = (messageId: string | number): MediaAsset | undefined => {
    const source = mediaSourceFor(messageId);
    return source?.media?.kind === 'photo' || source?.media?.kind === 'video'
      ? mediaAssets.messagePreview(source)
      : mediaAssetFor(messageId);
  };
  const imageViewerMessages = () =>
    renderedMessages().filter(
      (message) => message.media && mediaPresentation(message.media).preview === 'image',
    );
  const openImageViewer = (
    message: ChatMessage,
    preview: MediaPreview,
    candidates = imageViewerMessages(),
  ) => {
    if (preview.kind !== 'image') return false;
    const messages = candidates.filter(
      (candidate) => candidate.media && mediaPresentation(candidate.media).preview === 'image',
    );
    const index = messages.findIndex(({ id }) => id === message.id);
    setMediaViewer({
      messages: index >= 0 ? messages : [message],
      index: Math.max(0, index),
      preview,
      loading: false,
    });
    return true;
  };
  const navigateImageViewer = async (index: number) => {
    const current = mediaViewer();
    const message = current?.messages[index];
    if (!current || !message?.media || current.loading) return;
    setMediaViewer({ ...current, loading: true });
    try {
      const asset = mediaAssetFor(message.id);
      if (!asset) return;
      const url = asset.cached() ?? (await asset.load());
      const latest = mediaViewer();
      if (!latest || latest.messages !== current.messages) return;
      setMediaViewer({
        messages: current.messages,
        index,
        loading: false,
        preview: { kind: 'image', name: message.media.name, url },
      });
    } finally {
      const latest = mediaViewer();
      if (latest?.messages === current.messages && latest.loading) {
        setMediaViewer({ ...latest, loading: false });
      }
    }
  };
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  onMount(() => {
    let narrowLayout = window.innerWidth <= 1100;
    const scroller = messageScroller;
    const content = messageContent;
    const detachViewport = scroller && content ? viewport.attach(scroller, content) : undefined;
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
    const handlePopState = () => {
      const peerId = new URL(window.location.href).searchParams.get('chat');
      if (peerId && snapshot().dialogs.some(({ peer }) => peer.id === peerId)) {
        runInBackground(selectChat(peerId, undefined, 'none'));
      }
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
    window.addEventListener('popstate', handlePopState);
    document.addEventListener('visibilitychange', refreshVisibleTelegramState);

    const unsubscribe = engine.subscribe((next) => {
      setSnapshot(next);
      if (next.requiresReload) {
        setAuthOpen(true);
      } else if (next.phase === 'unauthorized') {
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
          conversationRetryGeneration += 1;
          history.reset();
          setActiveChatId('empty');
          setActiveConversation(undefined);
          setConversationLoadError('');
          setConversationRetrying(false);
          closeConversationOverlays();
          composer.reset();
        }
      } else if (next.phase !== 'unauthorized' && !currentExists) {
        const requestedPeerExists = next.dialogs.some(({ peer }) => peer.id === initialUrlPeerId);
        const enginePeerExists = next.dialogs.some(({ peer }) => peer.id === next.activePeerId);
        const target = requestedPeerExists
          ? initialUrlPeerId
          : enginePeerExists
            ? next.activePeerId
            : next.dialogs[0]?.peer.id;
        if (initialUrlPeerId && !requestedPeerExists && next.phase === 'ready') {
          const url = new URL(window.location.href);
          url.searchParams.delete('chat');
          window.history.replaceState({}, '', url);
        }
        initialUrlPeerId = undefined;
        if (target) {
          const initialSelection = selectChat(target, undefined, 'replace');
          if (environment.replay && !replaySelectionsStarted) {
            replaySelectionsStarted = true;
            runInBackground(
              initialSelection.then(async () => {
                for (const action of environment.replayUiActions ?? []) {
                  await waitForReproSequence(action.afterSequence);
                  if (!engine.snapshot().dialogs.some(({ peer }) => peer.id === action.peerId)) {
                    continue;
                  }
                  if (activeChatId() !== action.peerId) await selectChat(action.peerId);
                  if (action.type === 'select-chat') continue;
                  if (action.type === 'composer-reply') {
                    await nextFrame();
                    const message = renderedMessages().find(
                      ({ id }) => Number(id) === action.messageId,
                    );
                    const element = messageScroller?.querySelector<HTMLElement>(
                      `article[data-message-id="${CSS.escape(String(action.messageId))}"]`,
                    );
                    if (message && element) composer.beginReply(message, element);
                    await nextFrame();
                    continue;
                  }
                  composer.replaceDraft(action.text);
                  await nextFrame();
                  await composer.send();
                }
                completeReproReplay();
              }),
            );
          } else {
            runInBackground(initialSelection);
          }
        } else if (environment.replay && next.phase === 'ready') {
          completeReproReplay();
        }
      }
    });
    if (credentials && engine.snapshot().phase === 'idle') void engine.start(credentials);

    onCleanup(() => {
      unsubscribe();
      detachViewport?.();
      document.removeEventListener('pointerdown', dismissMenus);
      document.removeEventListener('keydown', dismissMenusWithKeyboard);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', reportConversationVisibility);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('online', recoverOnlineConnection);
      window.removeEventListener('popstate', handlePopState);
      document.removeEventListener('visibilitychange', refreshVisibleTelegramState);
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

  const reactToMessage = async (messageId: string, emoji: string) => {
    const id = Number(messageId);
    const dialog = snapshot().dialogs.find(({ peer }) => peer.id === activeChatId());
    if (!Number.isSafeInteger(id) || !dialog || !online()) return;
    setReactionPickerMessageId('');
    await activeConversation()?.toggleReaction(id, emoji);
  };

  const deleteMessage = async (messageId: string, revoke: boolean) => {
    const id = Number(messageId);
    const dialog = snapshot().dialogs.find(({ peer }) => peer.id === activeChatId());
    if (!Number.isSafeInteger(id) || !dialog || !online()) return;
    setMessageContextMenu(undefined);
    await activeConversation()?.deleteMessage(id, revoke);
  };

  const forwardMessage = async (targetPeerId: string) => {
    const message = forwardingMessage();
    const to = snapshot().dialogs.find(({ peer }) => peer.id === targetPeerId);
    const conversation = activeConversation();
    if (!message || !conversation || !to || !online()) return;
    setForwardingMessage(undefined);
    await conversation.forwardTo(to.peer, Number(message.id));
  };

  const centerMessageWindow = (messageId: number) => {
    const index = activeMessages().findIndex(({ id }) => id === String(messageId));
    return index >= 0 && viewport.showMessage(index);
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
    for (let attempt = 0; attempt < 10; attempt += 1) {
      centerMessageWindow(messageId);
      await nextFrame();
      if (
        openGeneration !== openMessageGeneration ||
        selection !== selectionGeneration ||
        activeChatId() !== peerId ||
        engine.snapshot().activePeerId !== peerId
      ) {
        return false;
      }
      const scroller = messageScroller;
      const target = scroller?.querySelector<HTMLElement>(
        `:is(article.message, .media-album-item)[data-message-id="${messageId}"]`,
      );
      if (!target) continue;
      viewport.reveal(target);
      target.classList.add('message-target');
      window.setTimeout(() => target.classList.remove('message-target'), 1200);
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
      if (!(await activeConversation()?.openMessage(message))) return;
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
          const scroller = messageScroller;
          if (scroller) viewport.updateJump(scroller, true);
        }
      }
    }
  };

  const openMessageActions = (message: ChatMessage, event: MouseEvent) => {
    if (message.service || !Number.isSafeInteger(Number(message.id))) return;
    event.preventDefault();
    event.stopPropagation();
    expressions.close();
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
    queueMicrotask(() =>
      document.querySelector<HTMLButtonElement>('.message-context-menu [role="menuitem"]')?.focus(),
    );
  };
  const messageContextTarget = createMemo(() => {
    const menu = messageContextMenu();
    return menu ? renderedMessages().find(({ id }) => id === menu.messageId) : undefined;
  });
  const copyMessageText = async (message: ChatMessage) => {
    const text = messageTextForClipboard(message);
    setMessageContextMenu(undefined);
    if (text) await navigator.clipboard.writeText(text);
  };
  const saveMessageMedia = async (message: ChatMessage) => {
    setMessageContextMenu(undefined);
    if (!message.media || message.protected) return;
    const asset = mediaAssetFor(message.id);
    if (!asset) return;
    saveMediaUrl(asset.cached() ?? (await asset.load()), message.media.name);
  };
  const copyMessageImage = async (message: ChatMessage) => {
    setMessageContextMenu(undefined);
    if (
      !message.media ||
      message.protected ||
      mediaPresentation(message.media).preview !== 'image'
    ) {
      return;
    }
    const asset = mediaAssetFor(message.id);
    if (!asset) return;
    await copyImageUrl(asset.cached() ?? (await asset.load()));
  };
  const copyMediaFilename = async (message: ChatMessage) => {
    setMessageContextMenu(undefined);
    if (message.media?.name) await navigator.clipboard.writeText(message.media.name);
  };

  const connectionNotice = createMemo(() => {
    const current = snapshot() as EngineSnapshot & { online?: boolean };
    if (!hasCachedWorkspace()) return '';
    if (current.phase === 'error')
      return `Offline. Showing cached data.${current.error ? ` ${current.error}` : ''}`;
    if (current.phase === 'ready' && current.online === false)
      return `Offline. Showing cached data.${current.error ? ` ${current.error}` : ''}`;
    return '';
  });
  const readReceiptFailed = createMemo(() =>
    /^Could not mark .+ as read\./u.test(snapshot().operationError ?? ''),
  );

  return (
    <main class="h-dvh overflow-hidden bg-canvas text-ink">
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
          online={online()}
          layout={sidebarLayout}
          media={mediaAssets}
          directory={chatDirectory}
          requestDelete={(peerId) => {
            const chat = visibleChats().find(({ id }) => id === peerId);
            if (chat) setDeleteChatTarget(chat);
          }}
          openSettings={openSettings}
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
          class="conversation-pane relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-chat"
        >
          <header
            class="chat-header flex h-16 shrink-0 items-center justify-between border-b border-line bg-panel px-4"
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
                    'text-muted': !online(),
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
                disabled={!activeConversationReady()}
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
                <Show when={readReceiptFailed()}>
                  <button onClick={() => void engine.retryMarkRead(activeChatId())}>
                    Retry marking as read
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
                  aria-label={`Pinned message ${pinnedMessageIndex() + 1} of ${activePinnedCount()}: ${message().text || message().media?.name || 'Message'}`}
                >
                  <Pin size={15} />
                  <span>
                    <strong>
                      Pinned message {pinnedMessageIndex() + 1} of {activePinnedCount()}
                    </strong>
                    {message().text || message().media?.name}
                  </span>
                </button>
                <Show when={activePinnedCount() > 1}>
                  <span class="pinned-message-navigation">
                    <button
                      aria-label="Previous pinned message"
                      onClick={() =>
                        setPinnedMessageIndex(
                          (pinnedMessageIndex() - 1 + activePinnedCount()) % activePinnedCount(),
                        )
                      }
                    >
                      <ChevronUp size={16} />
                    </button>
                    <button
                      aria-label="Next pinned message"
                      onClick={() =>
                        setPinnedMessageIndex((pinnedMessageIndex() + 1) % activePinnedCount())
                      }
                    >
                      <ChevronDown size={16} />
                    </button>
                  </span>
                </Show>
              </div>
            )}
          </Show>
          <div
            class="message-scroll-shell relative min-h-0 flex-1"
            data-chat-theme={chatAppearance.settings() ? 'telegram' : undefined}
            data-chat-wallpaper={chatAppearance.wallpaper() ? 'telegram' : undefined}
            data-chat-pattern={chatAppearance.pattern()}
            style={chatAppearance.style()}
          >
            <div class="chat-wallpaper" aria-hidden="true" />
            <div
              ref={(element) => (messageScroller = element)}
              class={`message-scroller scroll-area relative h-full min-h-0 overflow-y-auto overscroll-contain px-5${activeChat().kind === 'channel' ? ' channel-messages' : ''}`}
              data-testid="message-scroller"
            >
              <div
                ref={(element) => (messageContent = element)}
                class="conversation-content relative mx-auto flex max-w-3xl flex-col"
                classList={{
                  'conversation-ready':
                    viewport.ready() ||
                    conversationSwitching() ||
                    (snapshot().loadingMessages && activePeerMatches()),
                }}
              >
                <Show
                  when={
                    conversationSwitching() || (snapshot().loadingMessages && activePeerMatches())
                  }
                >
                  <div class="conversation-state" role="status">
                    Loading messages…
                  </div>
                </Show>
                <Show
                  when={
                    (conversationLoadError() || activeHistoryError()) &&
                    activeMessages().length === 0
                  }
                >
                  <div class="conversation-state conversation-state-error" role="alert">
                    <strong>Messages could not be loaded</strong>
                    <span>{conversationLoadError() || activeHistoryError()}</span>
                    <button
                      disabled={conversationRetrying()}
                      onClick={() => void retryConversation()}
                    >
                      {conversationRetrying() ? 'Retrying…' : 'Retry'}
                    </button>
                  </div>
                </Show>
                <Show when={activeLoadingOlderMessages()}>
                  <div class="history-loader" role="status">
                    Loading older messages…
                  </div>
                </Show>
                <Show when={activeHistoryError() && activeMessages().length > 0}>
                  <div class="history-error" role="alert">
                    <span>{activeHistoryError()}</span>
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
                        activePeerMatches() &&
                        !conversationLoadError() &&
                        !activeHistoryError() &&
                        activeMessages().length === 0 &&
                        activeChatId() !== 'empty'
                      }
                    >
                      <div class="mx-auto my-auto flex max-w-xs flex-col items-center text-center">
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
                    const absoluteIndex = index;
                    const layout = () => messageLayouts()[absoluteIndex()]!;
                    const compactAfter = () =>
                      messageLayouts()
                        .slice(absoluteIndex() + 1)
                        .find((candidate) => !candidate.hide)
                        ?.className.includes('message-same-sender') ?? false;
                    return (
                      <div
                        class="message-flow-row"
                        classList={{
                          'message-flow-row-first': index() === 0,
                          'message-flow-row-compact': compactAfter(),
                        }}
                        hidden={layout().hide}
                      >
                        <Show when={history.gapBefore(message)}>
                          {(gap) => (
                            <button
                              class="message-window-control history-gap-control"
                              disabled={snapshot().loadingOlderMessages}
                              onClick={() => void history.loadGap(gap())}
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
                          <Show when={!message.service && layout().forwardedFrom}>
                            {(forwarded) => (
                              <button
                                type="button"
                                class="message-forwarded-from"
                                disabled={
                                  !forwarded().peerId ||
                                  !snapshot().dialogs.some(
                                    ({ peer }) => peer.id === forwarded().peerId,
                                  )
                                }
                                onClick={() => {
                                  const source = forwarded();
                                  if (!source.peerId) return;
                                  if (source.messageId !== undefined) {
                                    void openMessage({
                                      id: source.messageId,
                                      peerId: source.peerId,
                                      senderId: '',
                                      text: '',
                                      date: 0,
                                      outgoing: false,
                                    });
                                  } else {
                                    void selectChat(source.peerId);
                                  }
                                }}
                              >
                                <span class="message-forwarded-label">Forwarded from</span>
                                <Show when={forwarded().peerId}>
                                  {(peerId) => (
                                    <span class="message-forwarded-avatar" aria-hidden="true">
                                      <Avatar
                                        identity={`forwarded:${peerId()}:${forwarded().avatarId ?? 'none'}`}
                                        initials={senderInitials(forwarded().name)}
                                        color={forwarded().color ?? telegramPeerColor(peerId())}
                                        size="xs"
                                        loadCached={
                                          forwarded().hasAvatar !== false
                                            ? () =>
                                                mediaAssets.loadPeerAvatar(
                                                  peerFromId(peerId()),
                                                  true,
                                                  forwarded().avatarId,
                                                  true,
                                                )
                                            : undefined
                                        }
                                        load={
                                          online() && forwarded().hasAvatar !== false
                                            ? () =>
                                                mediaAssets.loadPeerAvatar(
                                                  peerFromId(peerId()),
                                                  true,
                                                  forwarded().avatarId,
                                                )
                                            : undefined
                                        }
                                      />
                                    </span>
                                  )}
                                </Show>
                                <span class="message-forwarded-name">{forwarded().name}</span>
                              </button>
                            )}
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
                                    revision={mediaAssetFor(message.replyToId!)?.revision}
                                    load={(progress) => {
                                      const asset = mediaAssetFor(message.replyToId!);
                                      return asset
                                        ? asset.load(progress)
                                        : Promise.reject(new Error('Reply media is unavailable.'));
                                    }}
                                    cachedUrl={() => mediaAssetFor(message.replyToId!)?.cached()}
                                    cachedPreviewUrl={() =>
                                      mediaPreviewAssetFor(message.replyToId!)?.cached()
                                    }
                                    loadPreview={
                                      message.replyMedia?.kind === 'photo' ||
                                      message.replyMedia?.kind === 'video'
                                        ? () => {
                                            const asset = mediaPreviewAssetFor(message.replyToId!);
                                            return asset
                                              ? asset.load()
                                              : Promise.reject(
                                                  new Error('Reply media preview is unavailable.'),
                                                );
                                          }
                                        : undefined
                                    }
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
                              revision={(albumMessage) => mediaAssetFor(albumMessage.id)?.revision}
                              progress={(albumMessage) => albumMessage.uploadProgress}
                              cachedUrl={(albumMessage) => mediaAssetFor(albumMessage.id)?.cached()}
                              cachedPreviewUrl={(albumMessage) =>
                                mediaPreviewAssetFor(albumMessage.id)?.cached()
                              }
                              loadPreview={(albumMessage) => {
                                const asset = mediaPreviewAssetFor(albumMessage.id);
                                return asset
                                  ? asset.load()
                                  : Promise.reject(new Error('Album preview is unavailable.'));
                              }}
                              load={(albumMessage, progress) => {
                                const asset = mediaAssetFor(albumMessage.id);
                                return asset
                                  ? asset.load(progress)
                                  : Promise.reject(new Error('Album media is unavailable.'));
                              }}
                              openActions={(albumMessage, event) =>
                                openMessageActions(albumMessage, event)
                              }
                              openPreview={(albumMessage, preview) =>
                                openImageViewer(albumMessage, preview, layout().album)
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
                                  protected={message.protected}
                                  revision={mediaAssetFor(message.id)?.revision}
                                  cachedUrl={() => mediaAssetFor(message.id)?.cached()}
                                  cachedPreviewUrl={() =>
                                    mediaPreviewAssetFor(message.id)?.cached()
                                  }
                                  loadPreview={
                                    media().kind === 'photo' || media().kind === 'video'
                                      ? () => {
                                          const asset = mediaPreviewAssetFor(message.id);
                                          return asset
                                            ? asset.load()
                                            : Promise.reject(
                                                new Error('Attachment preview is unavailable.'),
                                              );
                                        }
                                      : undefined
                                  }
                                  load={(progress) => {
                                    const asset = mediaAssetFor(message.id);
                                    return asset
                                      ? asset.load(progress)
                                      : Promise.reject(
                                          new Error('Attachment data is unavailable.'),
                                        );
                                  }}
                                  onOpenPreview={(preview) => openImageViewer(message, preview)}
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
                                  <CheckCheck size={13} class="message-status-read" />
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
                      </div>
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
                          <Show when={target().media && !target().protected}>
                            <button role="menuitem" onClick={() => void saveMessageMedia(target())}>
                              <Copy size={15} /> Save media as
                            </button>
                          </Show>
                          <Show
                            when={
                              target().media &&
                              !target().protected &&
                              mediaPresentation(target().media!).preview === 'image'
                            }
                          >
                            <button role="menuitem" onClick={() => void copyMessageImage(target())}>
                              <Copy size={15} /> Copy image
                            </button>
                          </Show>
                          <Show when={target().media?.kind === 'file'}>
                            <button
                              role="menuitem"
                              onClick={() => void copyMediaFilename(target())}
                            >
                              <Copy size={15} /> Copy filename
                            </button>
                          </Show>
                          <Show when={messageTextForClipboard(target())}>
                            <button role="menuitem" onClick={() => void copyMessageText(target())}>
                              <Copy size={15} /> Copy text
                            </button>
                          </Show>
                          <Show when={!target().protected}>
                            <button
                              role="menuitem"
                              onClick={() => {
                                setMessageContextMenu(undefined);
                                setForwardingMessage(target());
                              }}
                            >
                              <Forward size={15} /> Forward
                            </button>
                          </Show>
                          <button
                            role="menuitem"
                            onClick={() => {
                              const message = target();
                              setMessageContextMenu(undefined);
                              void activeConversation()?.setPinnedMessage(
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
                <div class="present-scroll-anchor" aria-hidden="true" />
              </div>
            </div>

            <Show when={viewport.jumpVisible()}>
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
                bot.commands().length > 0 ||
                Boolean(visibleReplyKeyboard()?.keyboard.rows.some((row) => row.length > 0)))
            }
          >
            <BotControls
              isBot={Boolean(activeChat().bot)}
              showCommands={Boolean(activeChat().bot || bot.commands().length > 0)}
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
            placeholder={visibleReplyKeyboard()?.keyboard.placeholder}
            enabled={canSend()}
            composer={composer}
            expressions={expressions}
            onGeometryChange={viewport.reconcileLayout}
            media={{
              loadSticker: (sticker) => mediaAssets.loadSticker(sticker),
              stickerUrl: (sticker) => mediaAssets.sticker(sticker).cached(),
            }}
          />
        </section>

        <Show when={mediaViewer()}>
          {(viewer) => {
            const message = () => viewer().messages[viewer().index]!;
            return (
              <MediaViewer
                kind={viewer().preview.kind}
                name={viewer().preview.name}
                url={viewer().preview.url}
                origin={viewer().preview.origin}
                author={message().author}
                time={message().time}
                caption={message().body}
                protected={message().protected}
                position={viewer().index + 1}
                count={viewer().messages.length}
                loading={viewer().loading}
                previous={
                  viewer().index > 0
                    ? () => void navigateImageViewer(viewer().index - 1)
                    : undefined
                }
                next={
                  viewer().index < viewer().messages.length - 1
                    ? () => void navigateImageViewer(viewer().index + 1)
                    : undefined
                }
                download={
                  message().protected
                    ? undefined
                    : () => saveMediaUrl(viewer().preview.url, viewer().preview.name)
                }
                forward={
                  message().protected
                    ? undefined
                    : () => {
                        const target = message();
                        setMediaViewer(undefined);
                        setForwardingMessage(target);
                      }
                }
                edit={
                  message().outgoing
                    ? () => {
                        const target = message();
                        setMediaViewer(undefined);
                        composer.beginEdit(target);
                      }
                    : undefined
                }
                delete={() => {
                  const target = message();
                  setMediaViewer(undefined);
                  setDeleteTarget(target);
                }}
                goToMessage={() => {
                  const target = message();
                  setMediaViewer(undefined);
                  queueMicrotask(() => {
                    const element = document.querySelector<HTMLElement>(
                      `:is(article.message, .media-album-item)[data-message-id="${CSS.escape(target.id)}"]`,
                    );
                    if (element) viewport.reveal(element);
                  });
                }}
                close={() => setMediaViewer(undefined)}
              />
            );
          }}
        </Show>

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
            search={(term, global, offset) => activeConversation()!.search(term, global, offset)}
            openResult={(message) => {
              setSearchOpen(false);
              runInBackground(openMessage(message));
            }}
            close={() => setSearchOpen(false)}
          />
        </Show>

        <Show when={sharedMediaKind()} keyed>
          {(kind) => (
            <SharedMediaPanel
              initialKind={kind}
              loadItems={(selected, offset) => activeConversation()!.sharedMedia(selected, offset)}
              loadMedia={(message, progress) => mediaAssets.loadMedia(message, progress)}
              loadMediaPreview={(message) => mediaAssets.messagePreview(message).load()}
              cachedMedia={(message) => mediaAssets.message(message).cached()}
              cachedMediaPreview={(message) => mediaAssets.messagePreview(message).cached()}
              openMessage={(message) => {
                setSharedMediaKind(undefined);
                runInBackground(openMessage(message));
              }}
              forwardMessage={(message) => {
                setSharedMediaKind(undefined);
                const readOutboxMaxId =
                  snapshot().dialogs.find(({ peer }) => peer.id === message.peerId)
                    ?.readOutboxMaxId ?? 0;
                setForwardingMessage(presentMessage(message, readOutboxMaxId));
              }}
              deleteMessage={(message) => {
                setSharedMediaKind(undefined);
                const readOutboxMaxId =
                  snapshot().dialogs.find(({ peer }) => peer.id === message.peerId)
                    ?.readOutboxMaxId ?? 0;
                setDeleteTarget(presentMessage(message, readOutboxMaxId));
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
              hasDraft={Boolean(snapshot().drafts[chat().id]?.trim())}
              queuedCount={snapshot().pending.filter(({ peer }) => peer.id === chat().id).length}
              close={() => setDeleteChatTarget(undefined)}
              confirm={() => {
                const peerId = chat().id;
                setDeleteChatTarget(undefined);
                runInBackground(chatDirectory.delete(peerId));
              }}
            />
          )}
        </Show>

        <Show when={bot.urlAuth()} keyed>
          {(pending) => (
            <BotUrlAuthDialog
              request={pending.request}
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
            debugReportBusy={debugReportBusy()}
            debugReportError={debugReportError()}
            close={() => !loggingOut() && !clearingCache() && setSettingsOpen(false)}
            clearCache={() => void clearCache()}
            downloadDebugReport={
              environment.runtime.debugReports ? () => void downloadDebugReport() : undefined
            }
            logOut={() => void logOut()}
            appearance={appearance()}
            telegramWallpapers={telegramWallpapers()}
            wallpaperBusy={wallpaperBusy()}
            wallpaperError={wallpaperError()}
            setTheme={selectTheme}
            setAccentColor={selectAccentColor}
            setSystemAccent={selectSystemAccent}
            setChatFontSize={selectChatFontSize}
            setWallpaper={selectWallpaper}
            setTelegramWallpaper={(wallpaper) => void selectTelegramWallpaper(wallpaper)}
            setWallpaperEffects={appearanceSession.update}
            uploadWallpaper={(file) => void uploadWallpaper(file)}
          />
        </Show>

        <DetailsPane
          chat={activeChat()}
          counts={activeSharedCounts()}
          online={online()}
          conversationReady={activeConversationReady()}
          modal={detailsOpen() && viewportWidth() <= 1100}
          media={mediaAssets}
          details={contactDetails}
          close={() => updateDetailsOpen(false)}
          openShared={(kind) => {
            if (activeConversationReady()) setSharedMediaKind(kind);
          }}
          setBlocked={(blocked) => {
            const dialog = activeDialog();
            const conversation = activeConversation();
            if (dialog?.peer.kind === 'user' && conversation?.peerId === dialog.peer.id) {
              runInBackground(conversation.setBlocked(blocked));
            }
          }}
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
