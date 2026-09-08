import { Effect } from 'effect';
import * as Atom from 'effect/unstable/reactivity/Atom';
import { messageTextForClipboard } from '../../domain/messageText';
import type { ChatMessage, ChatSummary } from '../../domain/models';
import { telegramPeerColor } from '../../domain/peerColor';
import type { TelegramMessageCapabilities } from '../../telegram/core/chatPermissions';
import {
  canSendMessageToDialog,
  canSendMessageToPermissions,
  messageCapabilities,
  permissionsForDialog,
} from '../../telegram/core/chatPermissions';
import type { EffectConversation } from '../../telegram/core/conversation';
import type {
  EngineSnapshot,
  PendingSend,
  SharedMediaCounts,
  SharedMediaKind,
  TelegramChatPermissions,
  TelegramDialog,
  TelegramMessage,
  TelegramPeerSearchResult,
} from '../../telegram/types';
import { createBotSession } from '../bots/botSession';
import { createReplyKeyboardSession } from '../bots/replyKeyboardSession';
import { createChatDirectory } from '../chat/chatDirectory';
import { createContactDetailsSession } from '../chat/contactDetailsSession';
import { createComposerSession } from '../composer/composerSession';
import { createExpressionSession } from '../composer/expressionSession';
import { createConversationHeaderSession } from '../conversation/conversationHeaderSession';
import { createConversationHistorySession } from '../conversation/conversationHistorySession';
import {
  createConversationPresenter,
  type KeyedMessageView,
} from '../conversation/conversationPresentation';
import { createConversationViewport } from '../conversation/conversationViewport';
import { layoutMessages } from '../conversation/messageLayout';
import { createDialogPresenter } from '../conversation/presentation';
import { saveMediaUrl } from '../media/mediaActions';
import type { MediaAsset } from '../media/mediaAssets';
import { createMediaAssets } from '../media/mediaAssets';
import type { MediaPreview } from '../media/MediaAttachment';
import { mediaPresentation } from '../media/mediaPresentation';
import { domMount, program } from 'effectweb';
import { makeQueryCache, shareValue } from 'effectweb/cache';
import { modalVisible, subscribeModalVisibility } from '../shared/focusScope';
import { createAppearanceSession } from '../theme/appearanceSession';
import { createChatAppearanceSession, chatAppearanceQuery } from '../theme/chatAppearanceSession';
import type { AppEnvironment } from './appRuntime';
import { subscribeAtUi } from './appRuntime';
import { createDrawerFocusSession } from './drawerFocusSession';
import { retainPeerValue } from './retainedPeerValues';
import type { SessionContext } from 'effectweb/session';
import { lifetime, projectionCache, sessionGroup } from 'effectweb/session';
import { createSidebarLayout } from './sidebarLayout';
function whenChanged<A>(read: () => A, run: (value: A) => void) {
  let started = false,
    previous: A;
  return () => {
    const next = read();
    if (!started || !Object.is(previous, next)) {
      started = true;
      previous = next;
      run(next);
    }
  };
}
function senderInitials(name: string) {
  return name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase())
    .join('');
}
function reuseArray<T>(previous: readonly T[], next: T[]) {
  return previous.length === next.length && previous.every((value, index) => value === next[index])
    ? previous
    : next;
}
function runInBackground(task: Promise<unknown>) {
  void task.catch(() => undefined);
}
interface AppProps {
  environment: AppEnvironment;
}
export function createAppController(props: AppProps) {
  const environment = props.environment;
  const { credentials, configurationError } = environment;
  const { engine, runEffect, runTask, runSharedEffect } = environment.runtime;
  const scope = lifetime();
  const state = program<AppControllerModel, AppControllerMessage>({
    initial: {
      snapshot: engine.snapshot(),
      authOpen: engine.snapshot().phase !== 'ready',
      activeChatId: 'empty',
      activeConversation: undefined,
      initialUnreadAfterId: undefined,
      conversationLoadError: '',
      conversationRetrying: false,
      syncRetrying: false,
      loggingOut: false,
      clearingCache: false,
      debugReportBusy: false,
      debugReportError: '',
      clipboardError: '',
      settingsOpen: false,
      pendingActionId: '',
      reactionPickerMessageId: '',
      messageContextMenu: undefined,
      forwardingMessage: undefined,
      searchOpen: false,
      sharedMediaKind: undefined,
      deleteTarget: undefined,
      mediaViewer: undefined,
      deleteChatTarget: undefined,
    },
    update: (model, message) => {
      const changes: Partial<AppControllerModel> =
        message.type === 'ConversationClosed'
          ? {
              activeChatId: 'empty',
              activeConversation: undefined,
              initialUnreadAfterId: undefined,
              conversationLoadError: '',
              conversationRetrying: false,
            }
          : message.changes;
      return {
        model: (Object.keys(changes) as (keyof AppControllerModel)[]).every((key) =>
          Object.is(model[key], changes[key]),
        )
          ? model
          : { ...model, ...changes },
      };
    },
  });
  type AppControllerModel = {
    snapshot: EngineSnapshot;
    authOpen: boolean;
    activeChatId: string;
    activeConversation: EffectConversation | undefined;
    initialUnreadAfterId: number | undefined;
    conversationLoadError: string;
    conversationRetrying: boolean;
    syncRetrying: boolean;
    loggingOut: boolean;
    clearingCache: boolean;
    debugReportBusy: boolean;
    debugReportError: string;
    clipboardError: string;
    settingsOpen: boolean;
    pendingActionId: string;
    reactionPickerMessageId: string;
    messageContextMenu: { messageId: string; x: number; y: number } | undefined;
    forwardingMessage: ChatMessage | undefined;
    searchOpen: boolean;
    sharedMediaKind: SharedMediaKind | undefined;
    deleteTarget: ChatMessage | undefined;
    mediaViewer:
      | { messages: readonly ChatMessage[]; index: number; preview: MediaPreview; loading: boolean }
      | undefined;
    deleteChatTarget: TelegramDialog | undefined;
  };
  type AppControllerMessage =
    | { type: 'Changed'; changes: Partial<AppControllerModel> }
    | { type: 'ConversationClosed' };
  let initialUrlPeerId = new URL(window.location.href).searchParams.get('chat') ?? undefined;
  const selectors = projectionCache();
  let readyToPublish = false,
    queued = false,
    disposed = false;
  const changed = () => {
    selectors.invalidate();
    if (!readyToPublish || queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed) return;
      refresh();
      const next = shareValue(published, project());
      if (next !== published) {
        published = next;
        for (const listener of listeners) listener(next);
      }
      drawerFocus.refresh();
    });
  };
  scope.add(state.subscribe(changed));
  const model = makeQueryCache();
  const context: SessionContext = { cache: model, changed };
  const presentConversation = createConversationPresenter();
  const presentDialog = createDialogPresenter();
  const sidebarLayout = createSidebarLayout({
    captureConversationAnchor: () => viewport.captureAnchor(),
  });
  const detailsOpen = () => sidebarLayout.snapshot().detailsOpen;
  const setDetailsOpen = sidebarLayout.setDetailsOpen;
  const viewportWidth = () => sidebarLayout.snapshot().viewportWidth;
  const setViewportWidth = sidebarLayout.setViewportWidth;
  const mobileSidebarOpen = () => sidebarLayout.snapshot().mobileOpen;
  const setMobileSidebarOpen = sidebarLayout.setMobileOpen;
  const resizingLeftSidebar = () => sidebarLayout.snapshot().resizing;
  const effectiveLeftSidebarWidth = () => sidebarLayout.snapshot().effectiveWidth;
  const updateDetailsOpen = sidebarLayout.updateDetailsOpen;
  const toggleMobileSidebar = sidebarLayout.toggleMobile;
  let messageScroller: HTMLDivElement | undefined;
  let messageContent: HTMLDivElement | undefined;
  const appearanceSession = createAppearanceSession(
    {
      getWallpapers: () => engine.getWallpapers(),
      downloadWallpaper: (wallpaperId) => engine.downloadWallpaper(wallpaperId),
    },
    runEffect,
    context,
  );
  const appearance = () => appearanceSession.snapshot().appearance;
  const telegramWallpapers = () => appearanceSession.snapshot().telegramWallpapers;
  const appearanceCatalogLoading = () => appearanceSession.snapshot().catalogLoading;
  const wallpaperBusy = () => appearanceSession.snapshot().wallpaperBusy;
  const wallpaperError = () => appearanceSession.snapshot().wallpaperError;
  const selectTheme = appearanceSession.selectTheme;
  const selectAccentColor = appearanceSession.selectAccentColor;
  const selectSystemAccent = appearanceSession.selectSystemAccent;
  const selectChatFontSize = appearanceSession.selectChatFontSize;
  const selectWallpaper = appearanceSession.selectWallpaper;
  const selectTelegramWallpaper = appearanceSession.selectTelegramWallpaper;
  const uploadWallpaper = appearanceSession.uploadWallpaper;
  const mediaAssets = createMediaAssets(
    engine,
    runSharedEffect,
    () => state.model().snapshot.dialogs,
  );
  let appGridElement: HTMLDivElement | undefined;
  let conversationPaneElement: HTMLElement | undefined;
  let mobileSidebarTriggerElement: HTMLButtonElement | undefined;
  let openingMessage = false;
  let visibilityFrame: number | undefined;
  let selectionGeneration = 0;
  let conversationRetryGeneration = 0;
  let openMessageGeneration = 0;
  let viewport!: ReturnType<typeof createConversationViewport>;
  let history!: ReturnType<typeof createConversationHistorySession>;
  scope.add(() => {
    selectionGeneration += 1;
    conversationRetryGeneration += 1;
    openMessageGeneration += 1;
  });
  const openSettings = () => {
    setMobileSidebarOpen(false);
    state.send({ type: 'Changed', changes: { settingsOpen: true } });
    if (!telegramWallpapers().length && !appearanceCatalogLoading()) {
      // Loading the export UI must not become part of the bug being exported.
      void appearanceSession.loadCatalog();
    }
  };
  const online = () => {
    const current = state.model().snapshot as EngineSnapshot & { online?: boolean };
    return current.phase === 'ready' && current.online !== false;
  };
  const activePeerMatches = () => {
    const peerId = state.model().activeChatId;
    return peerId !== 'empty' && state.model().snapshot.activePeerId === peerId;
  };
  const activeConversationReady = () =>
    activePeerMatches() && state.model().activeConversation?.peerId === state.model().activeChatId;
  const conversationCommandsReady = () =>
    state.model().activeConversation?.peerId === state.model().activeChatId;
  const hasCachedWorkspace = () => state.model().snapshot.dialogs.length > 0;
  const canUseLiveCommands = () => online() && activeConversationReady() && canQueueMessage();
  const activeSendPermissions = (): TelegramChatPermissions | undefined => {
    const dialog = state
      .model()
      .snapshot.dialogs.find(({ peer }) => peer.id === state.model().activeChatId);
    return dialog ? permissionsForDialog(dialog) : undefined;
  };
  const canQueueMessage = () =>
    conversationCommandsReady() && Boolean(activeSendPermissions()?.canSendMessages);
  const canSendMedia = () => canQueueMessage() && Boolean(activeSendPermissions()?.canSendMedia);
  const canSendStickers = () =>
    canQueueMessage() && Boolean(activeSendPermissions()?.canSendStickers);
  const canSendGifs = () => canQueueMessage() && Boolean(activeSendPermissions()?.canSendGifs);
  const visibleChats = selectors.select<ChatSummary[]>((previous) => {
    const current = state.model().snapshot;
    const latestPendingByPeer = new Map<string, PendingSend>();
    for (const pending of current.pending) {
      const latest = latestPendingByPeer.get(pending.peer.id);
      if (!latest || pending.createdAt >= latest.createdAt) {
        latestPendingByPeer.set(pending.peer.id, pending);
      }
    }
    const next = current.dialogs
      .filter((dialog) => !dialog.transient)
      .map((dialog) => {
        const value = presentDialog(dialog, latestPendingByPeer.get(dialog.peer.id));
        return value;
      });
    return reuseArray(previous, next) as ChatSummary[];
  }, []);
  const updateAppBadge = whenChanged(
    () => state.model().snapshot.dialogs,
    () => {
      const badgeNavigator = navigator as Navigator & {
        setAppBadge?: (contents?: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      };
      const unread = state
        .model()
        .snapshot.dialogs.reduce((total, dialog) => total + Math.max(0, dialog.unreadCount), 0);
      const update =
        unread > 0 ? badgeNavigator.setAppBadge?.(unread) : badgeNavigator.clearAppBadge?.();
      if (update) runInBackground(update);
    },
  );
  const activeChat = selectors.select(() => {
    const listed = visibleChats().find((chat) => chat.id === state.model().activeChatId);
    if (listed) return listed;
    const transient = state
      .model()
      .snapshot.dialogs.find(({ peer }) => peer.id === state.model().activeChatId);
    if (transient) {
      return presentDialog(transient);
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
  const updateDocumentTitle = whenChanged(
    () => activeChat().title,
    () => {
      const chat = activeChat();
      document.title = chat.id === 'empty' ? 'TeleVecha' : `${chat.title} - TeleVecha`;
    },
  );
  scope.add(() => {
    document.title = 'TeleVecha';
  });
  const sharedCountsByPeer = selectors.select(
    (previous: ReadonlyMap<string, SharedMediaCounts>) => {
      const current = state.model().snapshot;
      return retainPeerValue(previous, current.activePeerId, current.sharedMediaCounts);
    },
    new Map<string, SharedMediaCounts>(),
  );
  const activeSharedCounts = selectors.select(() =>
    sharedCountsByPeer().get(state.model().activeChatId),
  );
  const activeHistoryError = selectors.select(() =>
    activePeerMatches() ? state.model().snapshot.historyError : undefined,
  );
  const activeLoadingOlderMessages = selectors.select(
    () => activePeerMatches() && state.model().snapshot.loadingOlderMessages,
  );
  const conversationSwitching = selectors.select(
    () => state.model().activeChatId !== 'empty' && !activePeerMatches(),
  );
  const loadMissingSharedCounts = whenChanged(
    () => {
      const s = state.model().snapshot;
      return s.online && s.activePeerId === state.model().activeChatId && !s.sharedMediaCounts
        ? s.activePeerId
        : undefined;
    },
    () => {
      const peerId = state.model().activeChatId;
      const current = state.model().snapshot;
      if (
        peerId !== 'empty' &&
        current.online &&
        current.activePeerId === peerId &&
        !current.sharedMediaCounts
      ) {
        runInBackground(runEffect(engine.loadConversationSharedMediaCounts(peerId)));
      }
    },
  );
  const activeDialog = selectors.select(() =>
    state.model().snapshot.dialogs.find(({ peer }) => peer.id === state.model().activeChatId),
  );
  const noMessageCapabilities = (): TelegramMessageCapabilities => ({
    canPin: false,
    canEdit: false,
    canDelete: false,
    canDeleteForMe: false,
    canDeleteForEveryone: false,
    canForward: false,
  });
  const dialogForPeer = (peerId: string | undefined) =>
    state
      .model()
      .snapshot.dialogs.find(({ peer }) => peer.id === (peerId ?? state.model().activeChatId));
  const messageCapabilitiesForUi = (message: ChatMessage): TelegramMessageCapabilities => {
    const dialog = dialogForPeer(message.peerId);
    if (!dialog) return noMessageCapabilities();
    return messageCapabilities(dialog, {
      outgoing: message.outgoing,
      protected: message.protected,
      service: message.service ? { kind: 'custom', text: message.service.text } : undefined,
      forwardedFrom: message.forwardedFrom,
      media: message.media,
      text: message.body,
    });
  };
  const telegramMessageCapabilitiesForUi = (
    message: TelegramMessage,
  ): TelegramMessageCapabilities => {
    const dialog = dialogForPeer(message.peerId);
    return dialog ? messageCapabilities(dialog, message) : noMessageCapabilities();
  };
  const chatAppearance = createChatAppearanceSession(
    { source: engine, runEffect, activeDialog, online, preferences: appearance },
    context,
  );
  const composer = createComposerSession({
    conversation: () => state.model().activeConversation,
    runTask,
    snapshot: () => state.model().snapshot,
    activePeerId: () => state.model().activeChatId,
    activeDialog,
    canSend: canQueueMessage,
    canSendMedia,
    beforeUiChange: () => {
      const scroller = messageScroller;
      if (!scroller) return;
      viewport.preserveReadingPosition(scroller);
    },
    beforeSend: () => viewport.jumpToPresent(),
    focus: () =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
    onReply: (messageId) => {
      const peerId = state.model().activeChatId;
      const reports = environment.runtime.debugReports;
      reports?.recordComposerReply?.(peerId, messageId);
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        reports?.recordComposerFocus?.(peerId, document.activeElement === input);
      });
    },
    onSend: (text) => {
      const peerId = state.model().activeChatId;
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
  const expressions = createExpressionSession(
    {
      source: engine,
      runEffect,
      conversation: () => state.model().activeConversation,
      reply: () => composer.model().reply,
      canSendStickers,
      canSendGifs,
      clearReply: composer.clearReply,
    },
    context,
  );
  const expressionPickerVisible = () => expressions.model().visible;
  const closeConversationOverlays = () => {
    expressions.close();
    state.send({
      type: 'Changed',
      changes: {
        messageContextMenu: undefined,
        reactionPickerMessageId: '',
        forwardingMessage: undefined,
        searchOpen: false,
        sharedMediaKind: undefined,
        deleteTarget: undefined,
      },
    });
  };
  const contactDetails = createContactDetailsSession(
    { source: engine, runEffect, dialog: activeDialog, detailsOpen },
    context,
  );
  const replyKeyboard = createReplyKeyboardSession({
    snapshot: () => state.model().snapshot,
    activePeerId: () => state.model().activeChatId,
    reply: () => composer.model().reply,
    editing: () => composer.model().editing,
    forceReply: composer.forceReply,
  });
  const visibleReplyKeyboard = () => replyKeyboard.snapshot().visible;
  const botStarted = () => replyKeyboard.snapshot().botStarted;
  const dismissSingleUseReplyKeyboard = replyKeyboard.dismissSingleUse;
  const reconcileReplyKeyboard = whenChanged(
    () => {
      const dialog = activeDialog();
      return state.model().snapshot.phase === 'ready' &&
        dialog?.peer.kind === 'user' &&
        !dialog.userDetails
        ? dialog.peer.id
        : '';
    },
    (peerId) => {
      if (!peerId) return;
      const dialog = activeDialog();
      if (dialog?.peer.id === peerId)
        void runEffect(engine.getUserDetails(dialog.peer)).catch(() => undefined);
    },
  );
  const activeMessageEntries = selectors.select<KeyedMessageView[]>(() => {
    return presentConversation(state.model().snapshot, state.model().activeChatId);
  });
  const activeMessages = selectors.select(() =>
    activeMessageEntries().map(({ message }) => message),
  );
  const initialUnreadMessageId = selectors.select(() => {
    const unreadAfterId = state.model().initialUnreadAfterId;
    if (unreadAfterId === undefined) return undefined;
    return activeMessages().find(
      (message) => !message.outgoing && Number(message.id) > unreadAfterId,
    )?.id;
  });
  const pendingSendForMessage = (messageId: string) =>
    state
      .model()
      .snapshot.pending.find(
        (send) =>
          send.id === messageId ||
          Boolean(
            send.album?.attachments.some(
              (_attachment, index) => `${send.id}:${index}` === messageId,
            ),
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
  let initiallyMarkedReadPeer = '';
  viewport = createConversationViewport({
    scroller: () => messageScroller,
    activePeerId: () => state.model().activeChatId,
    messages: activeMessages,
    canLoadOlder: () => {
      const current = state.model().snapshot;
      return (
        current.activePeerId === state.model().activeChatId &&
        current.hasOlderMessages &&
        !current.loadingMessages &&
        !current.loadingOlderMessages
      );
    },
    reportVisibility: () => reportConversationVisibility(),
    dismissUnreadMarker: () =>
      state.send({ type: 'Changed', changes: { initialUnreadAfterId: undefined } }),
    loadOlder: (scroller) => history.loadOlder(scroller),
    cancelMessageOpen: () => {
      openMessageGeneration += 1;
      openingMessage = false;
    },
  });
  const renderedMessages = selectors.select<ChatMessage[]>((previous) => {
    const entries = activeMessageEntries();
    const visibleEntries = entries;
    const next = visibleEntries.map(({ message }) => message);
    return reuseArray(previous, next) as ChatMessage[];
  }, []);
  const messageRows = selectors.select<{
    entries: RenderedMessage[];
    messages: readonly ChatMessage[];
    layouts: ReturnType<typeof layoutMessages>;
  }>((previous) => {
    const entries = activeMessageEntries();
    const messages = renderedMessages();
    const layouts = layoutMessages(
      messages,
      activeChat(),
      state.model().snapshot.dialogs,
      previous?.layouts,
    );
    if (previous?.messages === messages && previous.layouts === layouts) return previous;
    return {
      entries: entries.map((entry, index) => ({ ...entry, layout: layouts[index]! })),
      messages,
      layouts,
    };
  });
  const conversationHeader = createConversationHeaderSession({
    snapshot: () => state.model().snapshot,
    chat: activeChat,
    activePeerId: () => state.model().activeChatId,
    activePeerMatches,
  });
  const activeStatus = () => conversationHeader.snapshot().status;
  const activePinnedMessage = () => conversationHeader.snapshot().pinnedMessage;
  const pinnedMessageIndex = () => conversationHeader.snapshot().pinnedIndex;
  const setPinnedMessageIndex = conversationHeader.setPinnedIndex;
  const activePinnedCount = selectors.select(() =>
    activePeerMatches() ? state.model().snapshot.pinnedMessages.length : 0,
  );
  const activeConversationLoaded = selectors.select(() => {
    const current = state.model().snapshot;
    return (
      current.activePeerId === state.model().activeChatId &&
      (!current.loadingMessages || current.messages.length > 0)
    );
  });
  history = createConversationHistorySession({
    snapshot: () => state.model().snapshot,
    activePeerId: () => state.model().activeChatId,
    conversation: () => state.model().activeConversation,
    runEffect,
    loaded: activeConversationLoaded,
    openingMessage: () => openingMessage,
    unreadAfterId: () => state.model().initialUnreadAfterId,
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
    if (!environment.tvbug) {
      environment.runtime.debugReports?.recordPeerSelection?.(id);
    }
    if (linkedOpenGeneration === undefined) {
      openMessageGeneration += 1;
      openingMessage = false;
    } else if (linkedOpenGeneration !== openMessageGeneration) {
      return false;
    }
    if (
      id === state.model().activeChatId &&
      state.model().activeConversation?.peerId === id &&
      activePeerMatches() &&
      !state.model().snapshot.loadingMessages &&
      state.model().snapshot.messages.length > 0 &&
      state.model().snapshot.sharedMediaCounts
    ) {
      return activePeerMatches();
    }
    const generation = ++selectionGeneration;
    const previousPeerId = state.model().activeChatId;
    const changingPeer = id !== previousPeerId;
    const commandConversation = engine.conversation(id);
    if (state.model().activeConversation?.peerId !== id)
      state.send({ type: 'Changed', changes: { activeConversation: commandConversation } });
    if (changingPeer) {
      const dialog = state.model().snapshot.dialogs.find(({ peer }) => peer.id === id);
      state.send({
        type: 'Changed',
        changes: {
          initialUnreadAfterId:
            dialog && dialog.unreadCount > 0 ? dialog.readInboxMaxId : undefined,
        },
      });
      initiallyMarkedReadPeer = '';
      conversationRetryGeneration += 1;
      state.send({ type: 'Changed', changes: { conversationRetrying: false } });
      viewport.resetForPeer();
      history.reset();
    }
    state.send({ type: 'Changed', changes: { conversationLoadError: '', activeChatId: id } });
    setMobileSidebarOpen(false);
    closeConversationOverlays();
    composer.switchPeer(previousPeerId, id, changingPeer);
    const focusAtSelection = document.activeElement;
    try {
      const conversation = await runEffect(engine.openConversation(id));
      if (generation !== selectionGeneration || state.model().activeChatId !== id) return false;
      state.send({ type: 'Changed', changes: { activeConversation: conversation } });
      const current = engine.snapshot();
      if (current.activePeerId === id && urlMode !== 'none') updateChatUrl(id, urlMode);
      if (
        current.activePeerId === id &&
        !current.loadingMessages &&
        current.messages.length === 0 &&
        current.historyError
      ) {
        state.send({ type: 'Changed', changes: { conversationLoadError: current.historyError } });
      }
      if (changingPeer && document.activeElement === focusAtSelection) composer.focus();
      return current.activePeerId === id;
    } catch (cause) {
      if (generation === selectionGeneration && state.model().activeChatId === id) {
        state.send({
          type: 'Changed',
          changes: {
            conversationLoadError: cause instanceof Error ? cause.message : String(cause),
          },
        });
        viewport.setReady(true);
      }
      return false;
    }
  };
  const chatDirectory = createChatDirectory(
    engine,
    runEffect,
    () => state.model().snapshot.dialogs,
    selectChat,
  );
  const bot = createBotSession(
    {
      conversation: () => state.model().activeConversation,
      runEffect,
      snapshot: () => state.model().snapshot,
      activePeerId: () => state.model().activeChatId,
      activeDialog,
      selectChat: (peerId) => selectChat(peerId),
      setDraft: composer.replaceDraft,
      setPeerDraft: (peerId, value) => engine.setDraft(peerId, value),
      dismissSingleUseKeyboard: dismissSingleUseReplyKeyboard,
      focusComposer: () =>
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
      resources: engine,
    },
    context,
  );
  const retryConversation = async () => {
    const peerId = state.model().activeChatId;
    const conversation = state.model().activeConversation;
    if (
      state.model().conversationRetrying ||
      peerId === 'empty' ||
      !conversation ||
      conversation.peerId !== peerId
    ) {
      return;
    }
    const generation = ++conversationRetryGeneration;
    const stillCurrent = () =>
      generation === conversationRetryGeneration &&
      state.model().activeChatId === peerId &&
      state.model().activeConversation === conversation;
    state.send({
      type: 'Changed',
      changes: { conversationRetrying: true, conversationLoadError: '' },
    });
    viewport.setReady(false);
    try {
      if (!engine.snapshot().online) await runEffect(engine.retrySync());
      if (!stillCurrent()) return;
      await runEffect(conversation.retryHistory());
      if (!stillCurrent()) return;
      const current = engine.snapshot();
      if (!current.loadingMessages && current.messages.length === 0 && current.historyError) {
        state.send({ type: 'Changed', changes: { conversationLoadError: current.historyError } });
      }
    } catch (cause) {
      if (stillCurrent()) {
        state.send({
          type: 'Changed',
          changes: {
            conversationLoadError: cause instanceof Error ? cause.message : String(cause),
          },
        });
      }
    } finally {
      if (stillCurrent()) {
        state.send({ type: 'Changed', changes: { conversationRetrying: false } });
        viewport.setReady(true);
      }
    }
  };
  const retrySync = async () => {
    if (state.model().syncRetrying) return;
    state.send({ type: 'Changed', changes: { syncRetrying: true } });
    try {
      await runEffect(engine.retrySync());
      if (engine.snapshot().online) await runEffect(engine.retryOutbox());
    } finally {
      state.send({ type: 'Changed', changes: { syncRetrying: false } });
    }
  };
  const logOut = async () => {
    if (state.model().loggingOut) return;
    state.send({ type: 'Changed', changes: { loggingOut: true } });
    try {
      await runEffect(engine.logOut());
      conversationRetryGeneration += 1;
      state.send({ type: 'ConversationClosed' });
      closeConversationOverlays();
      composer.reset();
      setMobileSidebarOpen(false);
    } finally {
      state.send({ type: 'Changed', changes: { loggingOut: false, settingsOpen: false } });
    }
  };
  const clearCache = async () => {
    if (state.model().clearingCache || state.model().loggingOut) return;
    state.send({ type: 'Changed', changes: { clearingCache: true } });
    try {
      mediaAssets.dispose();
      await runEffect(engine.clearCache());
      Atom.batch(() => model.resetResources());
      conversationRetryGeneration += 1;
      state.send({ type: 'ConversationClosed' });
      closeConversationOverlays();
      state.send({ type: 'Changed', changes: { settingsOpen: false } });
    } finally {
      state.send({ type: 'Changed', changes: { clearingCache: false } });
    }
  };
  const downloadDebugReport = async () => {
    const reports = environment.runtime.debugReports;
    if (!reports || state.model().debugReportBusy) return;
    state.send({ type: 'Changed', changes: { debugReportBusy: true, debugReportError: '' } });
    try {
      const { file } = await runEffect(reports.prepare());
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      state.send({
        type: 'Changed',
        changes: {
          debugReportError:
            cause instanceof Error
              ? cause.message
              : 'TeleVecha could not prepare the debug report.',
        },
      });
    } finally {
      state.send({ type: 'Changed', changes: { debugReportBusy: false } });
    }
  };
  const retryPendingSend = async (id: string) => {
    if (state.model().pendingActionId) return;
    state.send({ type: 'Changed', changes: { pendingActionId: id } });
    try {
      await runEffect(engine.retryPendingSend(id));
    } finally {
      state.send({ type: 'Changed', changes: { pendingActionId: '' } });
    }
  };
  const cancelPendingSend = async (id: string) => {
    if (state.model().pendingActionId) return;
    state.send({ type: 'Changed', changes: { pendingActionId: id } });
    try {
      await runEffect(engine.cancelPendingSend(id));
    } finally {
      state.send({ type: 'Changed', changes: { pendingActionId: '' } });
    }
  };
  reportConversationVisibility = () => {
    if (visibilityFrame !== undefined) return;
    visibilityFrame = requestAnimationFrame(() => {
      visibilityFrame = undefined;
      const peerId = state.model().activeChatId;
      if (!peerId || peerId === 'empty') return;
      const scroller = messageScroller;
      const atBottom = Boolean(scroller && viewport.followingPresent());
      const obscured =
        mobileSidebarOpen() ||
        (detailsOpen() && window.matchMedia('(max-width: 1100px)').matches) ||
        state.model().searchOpen ||
        Boolean(state.model().sharedMediaKind) ||
        Boolean(state.model().forwardingMessage) ||
        Boolean(state.model().deleteTarget) ||
        Boolean(state.model().deleteChatTarget) ||
        Boolean(bot.snapshot().inlineSwitch) ||
        expressionPickerVisible() ||
        bot.snapshot().menuOpen ||
        state.model().authOpen ||
        modalVisible();
      const visible = document.visibilityState === 'visible' && document.hasFocus() && !obscured;
      if (
        visible &&
        viewport.ready() &&
        state.model().initialUnreadAfterId !== undefined &&
        initiallyMarkedReadPeer !== peerId
      ) {
        initiallyMarkedReadPeer = peerId;
        runInBackground(
          runEffect(engine.retryMarkRead(peerId)).then(() =>
            runEffect(engine.setActiveConversationVisibility(peerId, { visible, atBottom })),
          ),
        );
        return;
      }
      runInBackground(
        runEffect(engine.setActiveConversationVisibility(peerId, { visible, atBottom })),
      );
    });
  };
  const updateConversationVisibility = whenChanged(
    () => [
      state.model().activeChatId,
      mobileSidebarOpen(),
      detailsOpen(),
      state.model().searchOpen,
      state.model().sharedMediaKind,
      state.model().forwardingMessage,
      state.model().deleteTarget,
      state.model().deleteChatTarget,
      bot.snapshot().inlineSwitch,
      expressionPickerVisible(),
      bot.snapshot().menuOpen,
      state.model().authOpen,
      modalVisible(),
    ],
    reportConversationVisibility,
  );
  const drawerFocus = createDrawerFocusSession({
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
    state.model().snapshot.messages.find((candidate) => String(candidate.id) === String(messageId));
  const mediaAssetFor = (messageId: string | number): MediaAsset | undefined => {
    const id = String(messageId);
    const source = mediaSourceFor(id);
    if (source) return mediaAssets.message(source);
    const pending = pendingAttachmentForMessage(id);
    if (pending) return mediaAssets.pending(state.model().activeChatId, id, pending.blob);
    const sticker = pendingSendForMessage(id)?.sticker;
    return sticker ? mediaAssets.sticker(sticker) : undefined;
  };
  const mediaPreviewAssetFor = (messageId: string | number): MediaAsset | undefined => {
    const source = mediaSourceFor(messageId);
    return source?.media && mediaPresentation(source.media).preview
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
    candidates: readonly ChatMessage[] = imageViewerMessages(),
  ) => {
    if (preview.kind !== 'image') return false;
    const messages = candidates.filter(
      (candidate) => candidate.media && mediaPresentation(candidate.media).preview === 'image',
    );
    const index = messages.findIndex(({ id }) => id === message.id);
    state.send({
      type: 'Changed',
      changes: {
        mediaViewer: {
          messages: index >= 0 ? messages : [message],
          index: Math.max(0, index),
          preview,
          loading: false,
        },
      },
    });
    return true;
  };
  const navigateImageViewer = async (index: number) => {
    const current = state.model().mediaViewer;
    const message = current?.messages[index];
    if (!current || !message?.media || current.loading) return;
    state.send({ type: 'Changed', changes: { mediaViewer: { ...current, loading: true } } });
    try {
      const asset = mediaAssetFor(message.id);
      if (!asset) return;
      const url = asset.cached() ?? (await runEffect(asset.load()));
      const latest = state.model().mediaViewer;
      if (!latest || latest.messages !== current.messages) return;
      state.send({
        type: 'Changed',
        changes: {
          mediaViewer: {
            messages: current.messages,
            index,
            loading: false,
            preview: { kind: 'image', name: message.media.name, url },
          },
        },
      });
    } finally {
      const latest = state.model().mediaViewer;
      if (latest?.messages === current.messages && latest.loading) {
        state.send({ type: 'Changed', changes: { mediaViewer: { ...latest, loading: false } } });
      }
    }
  };
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const mount = () => {
    let narrowLayout = window.innerWidth <= 1100;
    const scroller = messageScroller;
    const content = messageContent;
    const detachViewport = scroller && content ? viewport.attach(scroller, content) : undefined;
    const dismissMenus = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest?.('.message-context-menu'))
        state.send({ type: 'Changed', changes: { messageContextMenu: undefined } });
      if (!target.closest?.('.reaction-picker'))
        state.send({ type: 'Changed', changes: { reactionPickerMessageId: '' } });
      if (!target.closest?.('.bot-command-bar')) bot.closeMenu();
    };
    const dismissMenusWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (
        state.model().messageContextMenu ||
        state.model().reactionPickerMessageId ||
        state.model().forwardingMessage ||
        bot.snapshot().inlineSwitch ||
        bot.snapshot().menuOpen
      ) {
        state.send({
          type: 'Changed',
          changes: {
            messageContextMenu: undefined,
            reactionPickerMessageId: '',
            forwardingMessage: undefined,
          },
        });
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
      state.send({
        type: 'Changed',
        changes: {
          messageContextMenu: undefined,
          reactionPickerMessageId: '',
          forwardingMessage: undefined,
        },
      });
    };
    document.addEventListener('pointerdown', dismissMenus);
    document.addEventListener('keydown', dismissMenusWithKeyboard);
    const resumeTelegramState = () => {
      runInBackground(
        runSharedEffect(
          'app:resume-telegram',
          Effect.gen(function* () {
            let current = engine.snapshot();
            if (current.phase !== 'ready') return;
            if (current.online) {
              // The engine records refresh failures. Continue into the normal
              // reconnect path after re-reading its state.
              yield* Effect.all(
                [
                  engine.refreshUpdates(),
                  current.activePeerId
                    ? engine.refreshReadReceipt(current.activePeerId)
                    : Effect.void,
                ],
                { concurrency: 'unbounded' },
              ).pipe(Effect.ignore);
            }
            yield* Effect.yieldNow;
            current = engine.snapshot();
            if (current.phase !== 'ready') return;
            if (!current.online) yield* engine.retrySync();
            if (engine.snapshot().online) yield* engine.retryOutbox();
          }),
        ),
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
      if (peerId && state.model().snapshot.dialogs.some(({ peer }) => peer.id === peerId)) {
        runInBackground(selectChat(peerId, undefined, 'none'));
        return;
      }
      const currentPeerId = state.model().activeChatId;
      if (state.model().snapshot.dialogs.some(({ peer }) => peer.id === currentPeerId)) {
        updateChatUrl(currentPeerId, 'replace');
        return;
      }
      const url = new URL(window.location.href);
      url.searchParams.delete('chat');
      window.history.replaceState({}, '', url);
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
    let mounted = true;
    let wasUnauthorized = false;
    const unsubscribeResources = subscribeAtUi(
      runEffect,
      engine.subscribeResources((event) => {
        if (!mounted) return;
        if (event.kind === 'peer-metadata') {
          model.invalidate(event.peerId ? `user-details:${event.peerId}` : 'user-details:');
          model.invalidateQuery(chatAppearanceQuery);
        }
      }),
    );
    const unsubscribe = subscribeAtUi(
      runEffect,
      engine.subscribe((next) => {
        if (!mounted) return;
        environment.runtime.debugReports?.recordRuntime?.({
          phase: next.phase,
          sync: next.sync,
          online: next.online,
          activePeerId: next.activePeerId,
        });
        const clearedAccount =
          next.phase === 'unauthorized' && state.model().snapshot.phase !== 'unauthorized';
        const authenticated = wasUnauthorized && next.phase === 'ready';
        if (next.phase === 'unauthorized') wasUnauthorized = true;
        if (authenticated) wasUnauthorized = false;
        Atom.batch(() => {
          state.send({ type: 'Changed', changes: { snapshot: next } });
          if (clearedAccount) mediaAssets.dispose();
          if (clearedAccount || authenticated) model.resetResources();
        });
        if (next.requiresReload) {
          state.send({ type: 'Changed', changes: { authOpen: true } });
        } else if (next.phase === 'unauthorized') {
          state.send({ type: 'Changed', changes: { authOpen: true } });
        } else if (
          next.dialogs.length > 0 &&
          (next.phase === 'connecting' ||
            next.phase === 'syncing' ||
            next.phase === 'ready' ||
            next.phase === 'error')
        ) {
          state.send({ type: 'Changed', changes: { authOpen: false } });
        } else if (
          next.phase === 'connecting' ||
          next.phase === 'syncing' ||
          next.phase === 'error'
        ) {
          state.send({ type: 'Changed', changes: { authOpen: true } });
        }
        const currentPeerId = state.model().activeChatId;
        const currentExists = next.dialogs.some(({ peer }) => peer.id === currentPeerId);
        if (next.dialogs.length === 0) {
          if (currentPeerId !== 'empty') {
            viewport.resetForPeer();
            selectionGeneration += 1;
            conversationRetryGeneration += 1;
            history.reset();
            state.send({ type: 'ConversationClosed' });
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
            runInBackground(selectChat(target, undefined, 'replace'));
          }
        }
      }),
    );
    if (credentials && engine.snapshot().phase === 'idle') {
      runInBackground(runEffect(engine.start(credentials)));
    }
    scope.add(() => {
      mounted = false;
      unsubscribe();
      unsubscribeResources();
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
      const peerId = state.model().activeChatId;
      if (peerId && peerId !== 'empty') {
        runInBackground(
          runEffect(
            engine.setActiveConversationVisibility(peerId, { visible: false, atBottom: false }),
          ),
        );
      }
      mediaAssets.dispose();
      const badgeNavigator = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
      if (badgeNavigator.clearAppBadge) runInBackground(badgeNavigator.clearAppBadge());
      if (!import.meta.hot) runInBackground(runEffect(engine.stop()));
    });
  };
  const reactToMessage = async (messageId: string, emoji: string) => {
    const id = Number(messageId);
    const dialog = state
      .model()
      .snapshot.dialogs.find(({ peer }) => peer.id === state.model().activeChatId);
    if (!Number.isSafeInteger(id) || !dialog) return;
    state.send({ type: 'Changed', changes: { reactionPickerMessageId: '' } });
    const conversation = state.model().activeConversation;
    if (conversation) await runEffect(conversation.toggleReaction(id, emoji));
  };
  const deleteMessage = async (messageId: string, revoke: boolean) => {
    const id = Number(messageId);
    const target =
      state.model().deleteTarget?.id === messageId
        ? state.model().deleteTarget
        : renderedMessages().find(({ id: candidateId }) => candidateId === messageId);
    const dialog = dialogForPeer(target?.peerId);
    if (!Number.isSafeInteger(id) || !dialog || !target) return;
    const capabilities = messageCapabilitiesForUi(target);
    if (
      !capabilities.canDelete ||
      (revoke && !capabilities.canDeleteForEveryone) ||
      (!revoke && !capabilities.canDeleteForMe)
    ) {
      return;
    }
    state.send({ type: 'Changed', changes: { messageContextMenu: undefined } });
    const conversation = state.model().activeConversation;
    if (conversation && conversation.peerId === dialog.peer.id) {
      await runEffect(conversation.deleteMessage(id, dialog.peer.kind === 'channel' || revoke));
    }
  };
  const forwardMessage = async (targetPeerId: string, result?: TelegramPeerSearchResult) => {
    const message = state.model().forwardingMessage;
    const to =
      result?.peer ??
      state.model().snapshot.dialogs.find(({ peer }) => peer.id === targetPeerId)?.peer;
    const conversation = state.model().activeConversation;
    if (!message || !conversation || !to || !messageCapabilitiesForUi(message).canForward) return;
    if (result && !state.model().snapshot.dialogs.some(({ peer }) => peer.id === result.peer.id)) {
      await runEffect(engine.addPeer(result));
    }
    const targetDialog = state.model().snapshot.dialogs.find(({ peer }) => peer.id === to.id);
    if (
      (targetDialog && !canSendMessageToDialog(targetDialog, message)) ||
      (result?.permissions && !canSendMessageToPermissions(result.permissions, message))
    ) {
      return;
    }
    state.send({ type: 'Changed', changes: { forwardingMessage: undefined } });
    await runEffect(conversation.forwardTo(to, Number(message.id)));
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
      state.model().activeChatId !== peerId
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
        state.model().activeChatId !== peerId ||
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
    const local = state.model().snapshot.messages.find(({ id }) => id === messageId);
    const target =
      local ??
      ({
        id: messageId,
        peerId: state.model().activeChatId,
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
      if (
        !state.model().snapshot.dialogs.some(({ peer }) => peer.id === message.peerId) &&
        message.peer
      ) {
        const title = message.peerTitle || message.peer.id;
        await runEffect(
          engine.addPeer({
            peer: message.peer,
            category:
              message.peer.kind === 'user'
                ? 'user'
                : message.peer.kind === 'channel'
                  ? 'channel'
                  : 'group',
            title,
            initials: senderInitials(title),
            color: telegramPeerColor(message.peer.id),
            bot: false,
            isContact: false,
            hasAvatar: false,
            ...(message.permissions ? { permissions: message.permissions } : {}),
          }),
        );
      }
      const selected = await selectChat(message.peerId, generation);
      const selection = selectionGeneration;
      if (
        !selected ||
        generation !== openMessageGeneration ||
        state.model().activeChatId !== message.peerId
      )
        return;
      viewport.pauseAtHistory();
      const conversation = state.model().activeConversation;
      if (!conversation || !(await runEffect(conversation.openMessage(message)))) return;
      if (
        generation !== openMessageGeneration ||
        selection !== selectionGeneration ||
        state.model().activeChatId !== message.peerId ||
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
    if (event.target instanceof HTMLImageElement) return;
    event.preventDefault();
    event.stopPropagation();
    expressions.close();
    state.send({ type: 'Changed', changes: { reactionPickerMessageId: '' } });
    const anchor =
      event.currentTarget instanceof Element
        ? event.currentTarget.getBoundingClientRect()
        : undefined;
    state.send({
      type: 'Changed',
      changes: {
        messageContextMenu: {
          messageId: message.id,
          x: event.clientX || anchor?.right || 8,
          y: event.clientY || anchor?.bottom || 8,
        },
      },
    });
    queueMicrotask(() =>
      document.querySelector<HTMLButtonElement>('.message-context-menu [role="menuitem"]')?.focus(),
    );
  };
  const messageContextTarget = selectors.select(() => {
    const menu = state.model().messageContextMenu;
    return menu ? renderedMessages().find(({ id }) => id === menu.messageId) : undefined;
  });
  const editLastMessage = () => {
    const message = renderedMessages()
      .slice()
      .reverse()
      .find(
        (candidate) =>
          candidate.outgoing &&
          !candidate.service &&
          Boolean(candidate.body || candidate.media) &&
          Number.isSafeInteger(Number(candidate.id)) &&
          messageCapabilitiesForUi(candidate).canEdit,
      );
    if (!message) return false;
    composer.beginEdit(message);
    return true;
  };
  const copyMessageText = async (message: ChatMessage) => {
    const text = messageTextForClipboard(message);
    state.send({ type: 'Changed', changes: { messageContextMenu: undefined } });
    if (!text) return;
    state.send({ type: 'Changed', changes: { clipboardError: '' } });
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      state.send({
        type: 'Changed',
        changes: { clipboardError: 'Could not copy the message to the clipboard.' },
      });
    }
  };
  const saveMessageMedia = async (message: ChatMessage) => {
    state.send({ type: 'Changed', changes: { messageContextMenu: undefined } });
    if (!message.media || message.protected) return;
    const asset = mediaAssetFor(message.id);
    if (!asset) return;
    saveMediaUrl(asset.cached() ?? (await runEffect(asset.load())), message.media.name);
  };
  const copyMediaFilename = async (message: ChatMessage) => {
    state.send({ type: 'Changed', changes: { messageContextMenu: undefined } });
    if (!message.media?.name) return;
    state.send({ type: 'Changed', changes: { clipboardError: '' } });
    try {
      await navigator.clipboard.writeText(message.media.name);
    } catch {
      state.send({
        type: 'Changed',
        changes: { clipboardError: 'Could not copy the filename to the clipboard.' },
      });
    }
  };
  const connectionStatus = selectors.select(() => {
    const current = state.model().snapshot as EngineSnapshot & { online?: boolean };
    if (!hasCachedWorkspace()) return '';
    if (
      current.phase === 'connecting' ||
      current.phase === 'syncing' ||
      state.model().syncRetrying
    ) {
      return 'Reconnecting…';
    }
    if (current.phase === 'error' || (current.phase === 'ready' && current.online === false)) {
      return 'Offline';
    }
    return '';
  });
  const readReceiptFailed = selectors.select(() =>
    /^Could not mark .+ as read\./u.test(state.model().snapshot.operationError ?? ''),
  );
  const actions = {
    jumpToPresent: () => {
      openMessageGeneration += 1;
      openingMessage = false;
      viewport.jumpToPresent();
    },
    replyTo: (message: ChatMessage) => {
      const element = document.querySelector<HTMLElement>(
        `:is(article.message, .media-album-item)[data-message-id="${CSS.escape(message.id)}"]`,
      );
      if (element) composer.beginReply(message, element);
    },
    revealMessage: (id: string) =>
      queueMicrotask(() => {
        const element = document.querySelector<HTMLElement>(
          `:is(article.message, .media-album-item)[data-message-id="${CSS.escape(id)}"]`,
        );
        if (element) viewport.reveal(element);
      }),
    sidebarLayout,
    mediaAssets,
    chatDirectory,
    setDeleteChatTarget: (
      value:
        | TelegramDialog
        | undefined
        | ((previous: TelegramDialog | undefined) => TelegramDialog | undefined),
    ) =>
      state.send({
        type: 'Changed',
        changes: {
          deleteChatTarget:
            typeof value === 'function' ? value(state.model().deleteChatTarget) : value,
        },
      }),
    openSettings,
    setMobileSidebarOpen,
    updateDetailsOpen,
    toggleMobileSidebar,
    retrySync,
    setSearchOpen: (value: boolean | ((previous: boolean) => boolean)) =>
      state.send({
        type: 'Changed',
        changes: {
          searchOpen: typeof value === 'function' ? value(state.model().searchOpen) : value,
        },
      }),
    runEffect,
    engine,
    setClipboardError: (value: string | ((previous: string) => string)) =>
      state.send({
        type: 'Changed',
        changes: {
          clipboardError: typeof value === 'function' ? value(state.model().clipboardError) : value,
        },
      }),
    openMessage,
    setPinnedMessageIndex,
    chatAppearance,
    viewport,
    retryConversation,
    history,
    openMessageActions,
    selectChat,
    scrollToReply,
    mediaAssetFor,
    mediaPreviewAssetFor,
    openImageViewer,
    bot,
    pendingSendForMessage,
    retryPendingSend,
    cancelPendingSend,
    setReactionPickerMessageId: (value: string | ((previous: string) => string)) =>
      state.send({
        type: 'Changed',
        changes: {
          reactionPickerMessageId:
            typeof value === 'function' ? value(state.model().reactionPickerMessageId) : value,
        },
      }),
    reactToMessage,
    composer,
    setMessageContextMenu: (
      value:
        | { messageId: string; x: number; y: number }
        | undefined
        | ((
            previous: { messageId: string; x: number; y: number } | undefined,
          ) => { messageId: string; x: number; y: number } | undefined),
    ) =>
      state.send({
        type: 'Changed',
        changes: {
          messageContextMenu:
            typeof value === 'function' ? value(state.model().messageContextMenu) : value,
        },
      }),
    saveMessageMedia,
    copyMediaFilename,
    copyMessageText,
    messageCapabilitiesForUi,
    setForwardingMessage: (
      value:
        | ChatMessage
        | undefined
        | ((previous: ChatMessage | undefined) => ChatMessage | undefined),
    ) =>
      state.send({
        type: 'Changed',
        changes: {
          forwardingMessage:
            typeof value === 'function' ? value(state.model().forwardingMessage) : value,
        },
      }),
    setDeleteTarget: (
      value:
        | ChatMessage
        | undefined
        | ((previous: ChatMessage | undefined) => ChatMessage | undefined),
    ) =>
      state.send({
        type: 'Changed',
        changes: {
          deleteTarget: typeof value === 'function' ? value(state.model().deleteTarget) : value,
        },
      }),
    expressions,
    editLastMessage,
    navigateImageViewer,
    setMediaViewer: (
      value:
        | {
            messages: readonly ChatMessage[];
            index: number;
            preview: MediaPreview;
            loading: boolean;
          }
        | undefined
        | ((
            previous:
              | {
                  messages: readonly ChatMessage[];
                  index: number;
                  preview: MediaPreview;
                  loading: boolean;
                }
              | undefined,
          ) =>
            | {
                messages: readonly ChatMessage[];
                index: number;
                preview: MediaPreview;
                loading: boolean;
              }
            | undefined),
    ) =>
      state.send({
        type: 'Changed',
        changes: {
          mediaViewer: typeof value === 'function' ? value(state.model().mediaViewer) : value,
        },
      }),
    forwardMessage,
    setSharedMediaKind: (
      value:
        | SharedMediaKind
        | undefined
        | ((previous: SharedMediaKind | undefined) => SharedMediaKind | undefined),
    ) =>
      state.send({
        type: 'Changed',
        changes: {
          sharedMediaKind:
            typeof value === 'function' ? value(state.model().sharedMediaKind) : value,
        },
      }),
    telegramMessageCapabilitiesForUi,
    deleteMessage,
    setSettingsOpen: (value: boolean | ((previous: boolean) => boolean)) =>
      state.send({
        type: 'Changed',
        changes: {
          settingsOpen: typeof value === 'function' ? value(state.model().settingsOpen) : value,
        },
      }),
    clearCache,
    environment,
    downloadDebugReport,
    logOut,
    selectTheme,
    selectAccentColor,
    selectSystemAccent,
    selectChatFontSize,
    selectWallpaper,
    selectTelegramWallpaper,
    appearanceSession,
    uploadWallpaper,
    contactDetails,
    configurationError,
  };
  const dom = {
    appGridElement: domMount((element) => {
      appGridElement = element as HTMLDivElement;
      return () => {
        appGridElement = undefined;
      };
    }),
    conversationPaneElement: domMount((element) => {
      conversationPaneElement = element as HTMLElement;
      return () => {
        conversationPaneElement = undefined;
      };
    }),
    mobileSidebarTriggerElement: domMount((element) => {
      mobileSidebarTriggerElement = element as HTMLButtonElement;
      return () => {
        mobileSidebarTriggerElement = undefined;
      };
    }),
    messageScroller: domMount((element) => {
      messageScroller = element as HTMLDivElement;
      return () => {
        messageScroller = undefined;
      };
    }),
    messageContent: domMount((element) => {
      messageContent = element as HTMLDivElement;
      return () => {
        messageContent = undefined;
      };
    }),
    mount: domMount(() => {
      queueMicrotask(() => {
        if (disposed) return;
        mount();
        changed();
      });
      return () => {};
    }),
  };
  const sessions = sessionGroup(
    [
      sidebarLayout,
      appearanceSession,
      chatAppearance,
      composer,
      expressions,
      contactDetails,
      replyKeyboard,
      conversationHeader,
      bot,
      viewport,
      history,
    ],
    changed,
  );
  scope.add(() => model.dispose());
  scope.add(() => state.dispose());
  scope.add(() => drawerFocus.dispose());
  scope.add(sessions.dispose);
  scope.add(subscribeModalVisibility(changed));
  function refresh() {
    sessions.refresh();
    environment.runtime.debugReports?.recordChatAppearance?.(chatAppearance.diagnostics());
    updateAppBadge();
    updateDocumentTitle();
    loadMissingSharedCounts();
    reconcileReplyKeyboard();
    updateConversationVisibility();
  }
  const project = () => ({
    ...actions,
    detailsOpen: detailsOpen(),
    mobileSidebarOpen: mobileSidebarOpen(),
    resizingLeftSidebar: resizingLeftSidebar(),
    effectiveLeftSidebarWidth: effectiveLeftSidebarWidth(),
    visibleChats: visibleChats(),
    activeChatId: state.model().activeChatId,
    online: online(),
    snapshot: state.model().snapshot,
    activeChat: activeChat(),
    activeStatus: activeStatus(),
    connectionStatus: connectionStatus(),
    syncRetrying: state.model().syncRetrying,
    activeConversationReady: activeConversationReady(),
    readReceiptFailed: readReceiptFailed(),
    clipboardError: state.model().clipboardError,
    activePinnedMessage: activePinnedMessage(),
    pinnedMessageIndex: pinnedMessageIndex(),
    activePinnedCount: activePinnedCount(),
    conversationSwitching: conversationSwitching(),
    activePeerMatches: activePeerMatches(),
    conversationLoadError: state.model().conversationLoadError,
    activeHistoryError: activeHistoryError(),
    activeMessages: activeMessages(),
    conversationRetrying: state.model().conversationRetrying,
    activeLoadingOlderMessages: activeLoadingOlderMessages(),
    messageRows: messageRows(),
    initialUnreadMessageId: initialUnreadMessageId(),
    canUseLiveCommands: canUseLiveCommands(),
    pendingActionId: state.model().pendingActionId,
    reactionPickerMessageId: state.model().reactionPickerMessageId,
    messageContextMenu: state.model().messageContextMenu,
    messageContextTarget: messageContextTarget(),
    activeConversation: state.model().activeConversation,
    visibleReplyKeyboard: visibleReplyKeyboard(),
    botStarted: botStarted(),
    canQueueMessage: canQueueMessage(),
    canSendMedia: canSendMedia(),
    canSendStickers: canSendStickers(),
    canSendGifs: canSendGifs(),
    mediaViewer: state.model().mediaViewer,
    forwardingMessage: state.model().forwardingMessage,
    searchOpen: state.model().searchOpen,
    sharedMediaKind: state.model().sharedMediaKind,
    deleteTarget: state.model().deleteTarget,
    deleteChatTarget: state.model().deleteChatTarget,
    settingsOpen: state.model().settingsOpen,
    loggingOut: state.model().loggingOut,
    clearingCache: state.model().clearingCache,
    debugReportBusy: state.model().debugReportBusy,
    debugReportError: state.model().debugReportError,
    appearance: appearance(),
    telegramWallpapers: telegramWallpapers(),
    wallpaperBusy: wallpaperBusy(),
    wallpaperError: wallpaperError(),
    activeSharedCounts: activeSharedCounts(),
    viewportWidth: viewportWidth(),
    activeDialog: activeDialog(),
    authOpen: state.model().authOpen,
    sidebarLayout: sidebarLayout.snapshot(),
    composer: composer.snapshot(),
    expressions: expressions.snapshot(),
    bot: bot.snapshot(),
    contactDetails: contactDetails.snapshot(),
    chatAppearance: chatAppearance.snapshot(),
    viewport: { ...viewport, ...viewport.snapshot() },
    viewportHeight: window.innerHeight,
    dom,
  });
  const listeners = new Set<(model: ReturnType<typeof project>) => void>();
  const detachDebugUi = environment.runtime.debugReports?.attachUi?.(() => ({
    activePeerId: state.model().activeChatId,
    sidebarWidth: effectiveLeftSidebarWidth(),
    detailsOpen: detailsOpen(),
    chatAppearance: chatAppearance.diagnostics(),
  }));
  if (detachDebugUi) scope.add(detachDebugUi);
  refresh();
  let published = project();
  readyToPublish = true;
  return {
    model: () => published,
    send: (_message: never) => {},
    subscribe: (listener: (model: ReturnType<typeof project>) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      scope.dispose();
    },
  };
}
export type AppViewModel = ReturnType<ReturnType<typeof createAppController>['model']>;

export type RenderedMessage = KeyedMessageView & {
  readonly layout: ReturnType<typeof layoutMessages>[number];
};
