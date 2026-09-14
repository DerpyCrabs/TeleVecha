import { list as renderList } from 'effectweb';
import { fromPromise } from 'effectweb/load';
import { Effect } from 'effect';
import { messageTextForClipboard } from '../../domain/messageText';
import type { ChatMessage } from '../../domain/models';
import { telegramPeerColor } from '../../domain/peerColor';
import type { TelegramMessageCapabilities } from '../../telegram/core/chatPermissions';
import { messageCapabilities } from '../../telegram/core/chatPermissions';
import type { TelegramMessage, TelegramPeer } from '../../telegram/types';
import { BotControls } from '../bots/BotControls';
import { BotKeyboard } from '../bots/BotKeyboard';
import { BotUrlAuthDialog } from '../bots/BotUrlAuthDialog';
import { ChatSidebar } from '../chat/ChatSidebar';
import { DeleteChatDialog } from '../chat/DeleteChatDialog';
import { DetailsPane } from '../chat/DetailsPane';
import { SearchPanel } from '../chat/SearchPanel';
import { SharedMediaPanel } from '../chat/SharedMediaPanel';
import { ChatComposer } from '../composer/ChatComposer';
import { DeleteMessageDialog } from '../conversation/DeleteMessageDialog';
import { ForwardMessageDialog } from '../conversation/ForwardMessageDialog';
import { MessageActions } from '../conversation/MessageActions';
import { MessageAlbum } from '../conversation/MessageAlbum';
import { MessageBody } from '../conversation/MessageBody';
import { presentMessage } from '../conversation/presentation';
import ArrowDown from '@effectweb/lucide/icons/arrow-down';
import Check from '@effectweb/lucide/icons/check';
import CheckCheck from '@effectweb/lucide/icons/check-check';
import ChevronDown from '@effectweb/lucide/icons/chevron-down';
import ChevronUp from '@effectweb/lucide/icons/chevron-up';
import CircleAlert from '@effectweb/lucide/icons/circle-alert';
import Clock3 from '@effectweb/lucide/icons/clock-3';
import Copy from '@effectweb/lucide/icons/copy';
import Forward from '@effectweb/lucide/icons/forward';
import Menu from '@effectweb/lucide/icons/menu';
import MessageSquareText from '@effectweb/lucide/icons/message-square-text';
import PanelRightOpen from '@effectweb/lucide/icons/panel-right-open';
import Pencil from '@effectweb/lucide/icons/pencil';
import Pin from '@effectweb/lucide/icons/pin';
import Reply from '@effectweb/lucide/icons/reply';
import Search from '@effectweb/lucide/icons/search';
import Trash2 from '@effectweb/lucide/icons/trash-2';
import { MediaAttachment } from '../media/MediaAttachment';
import { MediaViewer } from '../media/MediaViewer';
import { saveMediaUrl } from '../media/mediaActions';
import type { MediaAsset } from '../media/mediaAssets';
import { mediaPresentation } from '../media/mediaPresentation';
import { collection, view } from 'effectweb';
import { Avatar } from '../shared/Avatar';
import { AuthOverlay } from './AuthOverlay';
import { SettingsDialog } from './SettingsDialog';
import type { AppViewModel, RenderedMessage } from './appController';
const messageEntries = collection<RenderedMessage>((entry) => entry.key).from;
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
export const AppView = view<AppViewModel, never>((model, _send) => {
  const detailsOpen = model.detailsOpen;
  const mobileSidebarOpen = model.mobileSidebarOpen;
  const resizingLeftSidebar = model.resizingLeftSidebar;
  const effectiveLeftSidebarWidth = model.effectiveLeftSidebarWidth;
  const visibleChats = model.visibleChats;
  const activeChatId = model.activeChatId;
  const online = model.online;
  const sidebarLayout = model.sidebarLayout;
  const mediaAssets = model.mediaAssets;
  const chatDirectory = model.chatDirectory;
  const snapshot = model.snapshot;
  const setDeleteChatTarget = model.setDeleteChatTarget;
  const openSettings = model.openSettings;
  const setMobileSidebarOpen = model.setMobileSidebarOpen;
  const updateDetailsOpen = model.updateDetailsOpen;
  const toggleMobileSidebar = model.toggleMobileSidebar;
  const activeChat = model.activeChat;
  const activeStatus = model.activeStatus;
  const connectionStatus = model.connectionStatus;
  const syncRetrying = model.syncRetrying;
  const retrySync = model.retrySync;
  const setSearchOpen = model.setSearchOpen;
  const activeConversationReady = model.activeConversationReady;
  const readReceiptFailed = model.readReceiptFailed;
  const runEffect = model.runEffect;
  const engine = model.engine;
  const clipboardError = model.clipboardError;
  const setClipboardError = model.setClipboardError;
  const activePinnedMessage = model.activePinnedMessage;
  const openMessage = model.openMessage;
  const pinnedMessageIndex = model.pinnedMessageIndex;
  const activePinnedCount = model.activePinnedCount;
  const setPinnedMessageIndex = model.setPinnedMessageIndex;
  const chatAppearance = model.chatAppearance;
  const viewport = model.viewport;
  const conversationSwitching = model.conversationSwitching;
  const activePeerMatches = model.activePeerMatches;
  const conversationLoadError = model.conversationLoadError;
  const activeHistoryError = model.activeHistoryError;
  const activeMessages = model.activeMessages;
  const conversationRetrying = model.conversationRetrying;
  const retryConversation = model.retryConversation;
  const activeLoadingOlderMessages = model.activeLoadingOlderMessages;
  const messageRows = model.messageRows;
  const history = model.history;
  const initialUnreadMessageId = model.initialUnreadMessageId;
  const openMessageActions = model.openMessageActions;
  const selectChat = model.selectChat;
  const scrollToReply = model.scrollToReply;
  const openImageViewer = model.openImageViewer;
  const canUseLiveCommands = model.canUseLiveCommands;
  const bot = model.bot;
  const pendingActionId = model.pendingActionId;
  const retryPendingSend = model.retryPendingSend;
  const cancelPendingSend = model.cancelPendingSend;
  const reactionPickerMessageId = model.reactionPickerMessageId;
  const setReactionPickerMessageId = model.setReactionPickerMessageId;
  const reactToMessage = model.reactToMessage;
  const composer = model.composer;
  const messageContextMenu = model.messageContextMenu;
  const messageContextTarget = model.messageContextTarget;
  const setMessageContextMenu = model.setMessageContextMenu;
  const saveMessageMedia = model.saveMessageMedia;
  const copyMediaFilename = model.copyMediaFilename;
  const copyMessageText = model.copyMessageText;
  const setForwardingMessage = model.setForwardingMessage;
  const activeConversation = model.activeConversation;
  const setDeleteTarget = model.setDeleteTarget;
  const visibleReplyKeyboard = model.visibleReplyKeyboard;
  const botStarted = model.botStarted;
  const canQueueMessage = model.canQueueMessage;
  const canSendMedia = model.canSendMedia;
  const canSendStickers = model.canSendStickers;
  const canSendGifs = model.canSendGifs;
  const expressions = model.expressions;
  const editLastMessage = model.editLastMessage;
  const mediaViewer = model.mediaViewer;
  const navigateImageViewer = model.navigateImageViewer;
  const setMediaViewer = model.setMediaViewer;
  const forwardingMessage = model.forwardingMessage;
  const forwardMessage = model.forwardMessage;
  const searchOpen = model.searchOpen;
  const sharedMediaKind = model.sharedMediaKind;
  const setSharedMediaKind = model.setSharedMediaKind;
  const deleteTarget = model.deleteTarget;
  const deleteMessage = model.deleteMessage;
  const deleteChatTarget = model.deleteChatTarget;
  const settingsOpen = model.settingsOpen;
  const loggingOut = model.loggingOut;
  const clearingCache = model.clearingCache;
  const debugReportBusy = model.debugReportBusy;
  const debugReportError = model.debugReportError;
  const setSettingsOpen = model.setSettingsOpen;
  const clearCache = model.clearCache;
  const downloadDebugReport = model.downloadDebugReport;
  const logOut = model.logOut;
  const appearance = model.appearance;
  const telegramWallpapers = model.telegramWallpapers;
  const wallpaperBusy = model.wallpaperBusy;
  const wallpaperError = model.wallpaperError;
  const selectTheme = model.selectTheme;
  const selectAccentColor = model.selectAccentColor;
  const selectSystemAccent = model.selectSystemAccent;
  const selectChatFontSize = model.selectChatFontSize;
  const selectWallpaper = model.selectWallpaper;
  const selectTelegramWallpaper = model.selectTelegramWallpaper;
  const appearanceSession = model.appearanceSession;
  const uploadWallpaper = model.uploadWallpaper;
  const activeSharedCounts = model.activeSharedCounts;
  const viewportWidth = model.viewportWidth;
  const contactDetails = model.contactDetails;
  const activeDialog = model.activeDialog;
  const authOpen = model.authOpen;
  const configurationError = model.configurationError;
  const noMessageCapabilities = (): TelegramMessageCapabilities => ({
    canPin: false,
    canEdit: false,
    canDelete: false,
    canDeleteForMe: false,
    canDeleteForEveryone: false,
    canForward: false,
  });
  const dialogForPeer = (peerId: string | undefined) =>
    snapshot.dialogs.find(({ peer }) => peer.id === (peerId ?? activeChatId));
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
  const pendingSendForMessage = (messageId: string) =>
    snapshot.pending.find(
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
  const mediaSourceFor = (messageId: string | number) =>
    snapshot.messages.find((candidate) => String(candidate.id) === String(messageId));
  const mediaAssetFor = (messageId: string | number): MediaAsset | undefined => {
    const id = String(messageId);
    const source = mediaSourceFor(id);
    if (source) return mediaAssets.message(source);
    const pending = pendingAttachmentForMessage(id);
    if (pending) return mediaAssets.pending(activeChatId, id, pending.blob);
    const sticker = pendingSendForMessage(id)?.sticker;
    return sticker ? mediaAssets.sticker(sticker) : undefined;
  };
  const mediaPreviewAssetFor = (messageId: string | number): MediaAsset | undefined => {
    const source = mediaSourceFor(messageId);
    if (source?.media && mediaPresentation(source.media).preview)
      return mediaAssets.messagePreview(source);
    const pending = pendingAttachmentForMessage(String(messageId));
    if (pending?.preview)
      return mediaAssets.pendingPreview(activeChatId, String(messageId), pending.preview);
    return pending?.mimeType.startsWith('video/') ? undefined : mediaAssetFor(messageId);
  };
  const gapBefore = (message: ChatMessage) =>
    Number.isSafeInteger(Number(message.id))
      ? (snapshot.historyGaps ?? []).find((gap) => gap.newerMinMessageId === Number(message.id))
      : undefined;
  return (
    <main use={model.dom.mount} class="h-dvh overflow-hidden bg-canvas text-ink">
      <div
        use={model.dom.appGridElement}
        class="app-grid h-full"
        classList={{
          'details-visible': detailsOpen,
          'mobile-sidebar-visible': mobileSidebarOpen,
          'resizing-left-sidebar': resizingLeftSidebar,
        }}
        style={{ '--left-sidebar-width': `${effectiveLeftSidebarWidth}px` }}
      >
        <ChatSidebar
          chats={visibleChats}
          activeChatId={activeChatId}
          online={online}
          layout={sidebarLayout}
          media={mediaAssets}
          directory={chatDirectory}
          requestDelete={(peerId) => {
            const dialog = snapshot.dialogs.find(({ peer }) => peer.id === peerId);
            if (dialog) setDeleteChatTarget(dialog);
          }}
          openSettings={openSettings}
          dialogs={snapshot.dialogs}
        />

        {mobileSidebarOpen || detailsOpen ? (
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
        ) : null}

        <section
          use={model.dom.conversationPaneElement}
          class="conversation-pane relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-chat"
        >
          <header
            class="chat-header flex h-16 shrink-0 items-center justify-between border-b border-line bg-panel px-4"
            data-testid="conversation-header"
          >
            <div class="flex min-w-0 items-center gap-3 text-left">
              <button
                use={model.dom.mobileSidebarTriggerElement}
                class="mobile-sidebar-trigger icon-button"
                onClick={toggleMobileSidebar}
                aria-label="Open chat list"
                aria-expanded={mobileSidebarOpen}
              >
                <Menu size={19} />
              </button>
              <Avatar
                identity={`${activeChat.id}:${snapshot.dialogs.find((dialog) => dialog.peer.id === activeChat.id)?.avatarId ?? 'none'}`}
                initials={activeChat.initials}
                color={activeChat.color}
                size="sm"
                online={activeChat.presence === 'online'}
                loadCached={() => mediaAssets.loadAvatar(activeChat.id, true)}
                load={online ? () => mediaAssets.loadAvatar(activeChat.id) : undefined}
              />
              <span class="min-w-0">
                <strong class="block truncate text-sm font-semibold">{activeChat.title}</strong>
                <span
                  class="block text-xs"
                  classList={{
                    'text-emerald-400': activeChat.presence === 'online',
                    'text-muted': activeChat.presence !== 'online',
                  }}
                  role="status"
                >
                  {activeStatus}
                </span>
              </span>
            </div>
            <nav class="flex items-center gap-1">
              {connectionStatus
                ? ((status) => (
                    <button
                      class="connection-state-chip"
                      disabled={syncRetrying}
                      onClick={() => void retrySync()}
                      aria-label={`${status} Retry Telegram connection`}
                    >
                      {status}
                    </button>
                  ))(connectionStatus!)
                : null}
              <button
                class="icon-button"
                onClick={() => setSearchOpen(true)}
                aria-label="Search messages"
                disabled={!activeConversationReady}
              >
                <Search size={18} />
              </button>
              {!detailsOpen ? (
                <button
                  class="icon-button"
                  onClick={() => updateDetailsOpen(true)}
                  aria-label="Open details"
                >
                  <PanelRightOpen size={18} />
                </button>
              ) : null}
            </nav>
          </header>

          {snapshot.operationError
            ? ((message) => (
                <div class="sync-state-banner operation-state-banner" role="alert">
                  <span>{message}</span>
                  {snapshot.pending.some(({ lastError }) => Boolean(lastError)) ? (
                    <button disabled={syncRetrying} onClick={() => void retrySync()}>
                      {syncRetrying ? 'Retrying…' : 'Retry queued'}
                    </button>
                  ) : null}
                  {readReceiptFailed ? (
                    <button
                      onClick={() => runInBackground(runEffect(engine.retryMarkRead(activeChatId)))}
                    >
                      Retry marking as read
                    </button>
                  ) : null}
                  <button onClick={() => runInBackground(runEffect(engine.clearOperationError()))}>
                    Dismiss
                  </button>
                </div>
              ))(snapshot.operationError!)
            : null}

          {clipboardError
            ? ((message) => (
                <div class="sync-state-banner operation-state-banner" role="alert">
                  <span>{message}</span>
                  <button onClick={() => setClipboardError('')}>Dismiss</button>
                </div>
              ))(clipboardError!)
            : null}

          {activePinnedMessage
            ? ((message) => (
                <div class="pinned-message-bar">
                  <button
                    class="pinned-message-open"
                    onClick={() => runInBackground(openMessage(message))}
                    aria-label={`Pinned message ${pinnedMessageIndex + 1} of ${activePinnedCount}: ${message.text || message.media?.name || 'Message'}`}
                  >
                    <Pin size={15} />
                    <span>
                      <strong>
                        Pinned message {pinnedMessageIndex + 1} of {activePinnedCount}
                      </strong>
                      {message.text || message.media?.name}
                    </span>
                  </button>
                  {activePinnedCount > 1 ? (
                    <span class="pinned-message-navigation">
                      <button
                        aria-label="Previous pinned message"
                        onClick={() =>
                          setPinnedMessageIndex(
                            (pinnedMessageIndex - 1 + activePinnedCount) % activePinnedCount,
                          )
                        }
                      >
                        <ChevronUp size={16} />
                      </button>
                      <button
                        aria-label="Next pinned message"
                        onClick={() =>
                          setPinnedMessageIndex((pinnedMessageIndex + 1) % activePinnedCount)
                        }
                      >
                        <ChevronDown size={16} />
                      </button>
                    </span>
                  ) : null}
                </div>
              ))(activePinnedMessage!)
            : null}
          <div
            class="message-scroll-shell relative min-h-0 flex-1"
            data-chat-theme={chatAppearance.settings ? 'telegram' : undefined}
            data-chat-wallpaper={chatAppearance.wallpaper ? 'telegram' : undefined}
            data-chat-pattern={chatAppearance.pattern}
            style={chatAppearance.style}
          >
            <div class="chat-wallpaper" aria-hidden="true" />
            <div
              use={model.dom.messageScroller}
              class={`message-scroller scroll-area relative h-full min-h-0 overflow-y-auto overscroll-contain px-5${activeChat.kind === 'channel' ? ' channel-messages' : ''}`}
              data-testid="message-scroller"
            >
              <div
                use={model.dom.messageContent}
                class="conversation-content relative mx-auto flex max-w-3xl flex-col"
                classList={{
                  'conversation-ready':
                    viewport.ready ||
                    conversationSwitching ||
                    (snapshot.loadingMessages && activePeerMatches),
                }}
              >
                {conversationSwitching || (snapshot.loadingMessages && activePeerMatches) ? (
                  <div class="conversation-state" role="status">
                    Loading messages…
                  </div>
                ) : null}
                {(conversationLoadError || activeHistoryError) && activeMessages.length === 0 ? (
                  <div class="conversation-state conversation-state-error" role="alert">
                    <strong>Messages could not be loaded</strong>
                    <span>{conversationLoadError || activeHistoryError}</span>
                    <button
                      disabled={conversationRetrying}
                      onClick={() => void retryConversation()}
                    >
                      {conversationRetrying ? 'Retrying…' : 'Retry'}
                    </button>
                  </div>
                ) : null}
                {activeLoadingOlderMessages ? (
                  <div class="history-loader" role="status">
                    Loading older messages…
                  </div>
                ) : null}
                {activeHistoryError && activeMessages.length > 0 ? (
                  <div class="history-error" role="alert">
                    <span>{activeHistoryError}</span>
                    <button
                      disabled={conversationRetrying}
                      onClick={() => void retryConversation()}
                    >
                      {conversationRetrying ? 'Retrying…' : 'Retry history'}
                    </button>
                  </div>
                ) : null}
                {messageRows.messages!.length ? (
                  renderList(messageEntries(messageRows.entries), (entry, index) => {
                    const message = entry.message;
                    const layout = (() => entry.layout)();
                    // Layout can change while the caption stays the same (for example,
                    // prepending history or changing the trailing avatar of a sender group).
                    const caption = (() => layout.caption)();
                    return (
                      <div
                        class="message-flow-row"
                        classList={{
                          'message-flow-row-first': index === 0,
                          'message-flow-row-compact': layout.compactAfter,
                        }}
                        hidden={layout.hide}
                      >
                        {gapBefore(message)
                          ? ((gap) => (
                              <button
                                class="message-window-control history-gap-control"
                                disabled={snapshot.loadingOlderMessages}
                                onClick={() => void history.loadGap(gap)}
                              >
                                {snapshot.loadingOlderMessages
                                  ? 'Loading missing messages…'
                                  : 'Load missing messages'}
                              </button>
                            ))(gapBefore(message)!)
                          : null}
                        {layout.showDateDivider ? (
                          <div class="my-3 self-center rounded-full border border-white/5 bg-black/25 px-3 py-1 text-[11px] font-medium text-[var(--muted)] backdrop-blur">
                            {new Intl.DateTimeFormat(undefined, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            }).format(new Date((message.date ?? 0) * 1000))}
                          </div>
                        ) : null}
                        {message.id === initialUnreadMessageId ? (
                          <div class="unread-messages-divider" data-unread-message-id={message.id}>
                            Unread messages
                          </div>
                        ) : null}
                        <article
                          class={layout.className}
                          style={{ width: layout.width }}
                          data-message-id={message.id}
                          data-media-kind={message.media?.kind}
                          aria-label={message.service?.text}
                          onContextMenu={(event) => openMessageActions(message, event)}
                        >
                          {layout.showSenderAvatar ? (
                            <span class="message-sender-avatar" aria-hidden="true">
                              <Avatar
                                identity={`${message.senderId}:${message.senderAvatarId ?? 'none'}`}
                                initials={senderInitials(layout.author || message.author)}
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
                                  online && message.senderHasAvatar !== false
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
                          ) : null}
                          {!message.service && layout.author ? (
                            <strong
                              class="message-author"
                              style={{ color: messageSenderColor(message) }}
                            >
                              <span>{layout.author}</span>
                              {message.senderRole ? (
                                <span
                                  class={`message-sender-role ${message.senderRoleKind === 'owner' ? 'owner' : 'admin'}`}
                                >
                                  {message.senderRole}
                                </span>
                              ) : null}
                            </strong>
                          ) : null}
                          {!message.service && layout.forwardedFrom
                            ? ((forwarded) => (
                                <button
                                  type="button"
                                  class="message-forwarded-from"
                                  disabled={
                                    !forwarded.peerId ||
                                    !snapshot.dialogs.some(
                                      ({ peer }) => peer.id === forwarded.peerId,
                                    )
                                  }
                                  onClick={() => {
                                    const source = forwarded;
                                    if (!source.peerId) return;
                                    if (source.messageId !== undefined) {
                                      runInBackground(
                                        openMessage({
                                          id: source.messageId,
                                          peerId: source.peerId,
                                          senderId: '',
                                          text: '',
                                          date: 0,
                                          outgoing: false,
                                        }),
                                      );
                                    } else {
                                      runInBackground(selectChat(source.peerId));
                                    }
                                  }}
                                >
                                  <span class="message-forwarded-label">Forwarded from</span>
                                  {forwarded.peerId
                                    ? ((peerId) => (
                                        <span class="message-forwarded-avatar" aria-hidden="true">
                                          <Avatar
                                            identity={`forwarded:${peerId}:${forwarded.avatarId ?? 'none'}`}
                                            initials={senderInitials(forwarded.name)}
                                            color={forwarded.color ?? telegramPeerColor(peerId)}
                                            size="xs"
                                            loadCached={
                                              forwarded.hasAvatar !== false
                                                ? () =>
                                                    mediaAssets.loadPeerAvatar(
                                                      peerFromId(peerId),
                                                      true,
                                                      forwarded.avatarId,
                                                      true,
                                                    )
                                                : undefined
                                            }
                                            load={
                                              online && forwarded.hasAvatar !== false
                                                ? () =>
                                                    mediaAssets.loadPeerAvatar(
                                                      peerFromId(peerId),
                                                      true,
                                                      forwarded.avatarId,
                                                    )
                                                : undefined
                                            }
                                          />
                                        </span>
                                      ))(forwarded.peerId!)
                                    : null}
                                  <span class="message-forwarded-name">{forwarded.name}</span>
                                </button>
                              ))((!message.service && layout.forwardedFrom)!)
                            : null}
                          {message.replyTo ? (
                            <button
                              class="message-reply"
                              onClick={() => {
                                if (message.replyToId)
                                  runInBackground(scrollToReply(message.replyToId));
                              }}
                              aria-label={`Jump to replied message ${message.replyToId ?? ''}`}
                            >
                              {message.replyMedia &&
                              message.replyToId &&
                              mediaPresentation(message.replyMedia).preview ? (
                                <span class="reply-media-preview">
                                  <MediaAttachment
                                    media={message.replyMedia!}
                                    revision={model.mediaRevisions[message.replyToId!]}
                                    load={(progress) => {
                                      const asset = mediaAssetFor(message.replyToId!);
                                      return asset
                                        ? asset.load(progress)
                                        : Effect.fail(new Error('Reply media is unavailable.'));
                                    }}
                                    cachedUrl={() => mediaAssetFor(message.replyToId!)?.cached()}
                                    cachedPreviewUrl={() =>
                                      mediaPreviewAssetFor(message.replyToId!)?.cached()
                                    }
                                    loadPreview={
                                      message.replyMedia &&
                                      mediaPresentation(message.replyMedia).preview
                                        ? () => {
                                            const asset = mediaPreviewAssetFor(message.replyToId!);
                                            return asset
                                              ? asset.load()
                                              : Effect.fail(
                                                  new Error('Reply media preview is unavailable.'),
                                                );
                                          }
                                        : undefined
                                    }
                                    compact
                                    decorative
                                  />
                                </span>
                              ) : null}
                              <span class="message-reply-copy">
                                <strong>
                                  {snapshot.dialogs.find(
                                    ({ peer }) => peer.id === message.replyAuthor,
                                  )?.title ||
                                    message.replyAuthor ||
                                    'Reply'}
                                </strong>
                                <span>{message.replyTo}</span>
                              </span>
                            </button>
                          ) : null}
                          {layout.album.length > 1 ? (
                            <MessageAlbum
                              messages={layout.album}
                              revisions={model.mediaRevisions}
                              cachedUrl={(albumMessage) => mediaAssetFor(albumMessage.id)?.cached()}
                              cachedPreviewUrl={(albumMessage) =>
                                mediaPreviewAssetFor(albumMessage.id)?.cached()
                              }
                              loadPreview={(albumMessage) => {
                                const asset = mediaPreviewAssetFor(albumMessage.id);
                                return asset
                                  ? asset.load()
                                  : Effect.fail(new Error('Album preview is unavailable.'));
                              }}
                              load={(albumMessage, progress) => {
                                const asset = mediaAssetFor(albumMessage.id);
                                return asset
                                  ? asset.load(progress)
                                  : Effect.fail(new Error('Album media is unavailable.'));
                              }}
                              openActions={(albumMessage, event) =>
                                openMessageActions(albumMessage, event)
                              }
                              openPreview={(albumMessage, preview) =>
                                openImageViewer(albumMessage, preview, layout.album)
                              }
                            />
                          ) : null}
                          {layout.media
                            ? ((media) => (
                                <>
                                  <MediaAttachment
                                    media={media}
                                    uploadProgress={message.uploadProgress}
                                    uploadFailed={message.status === 'failed'}
                                    protected={message.protected}
                                    revision={model.mediaRevisions[message.id]}
                                    messageKey={`${activeChatId}:${message.id}`}
                                    onPlaybackStarted={() => {
                                      const dialog = dialogForPeer(message.peerId);
                                      if (dialog)
                                        runInBackground(
                                          model.runEffect(
                                            model.engine.markMediaRead(
                                              dialog.peer,
                                              Number(message.id),
                                            ),
                                          ),
                                        );
                                    }}
                                    cachedUrl={() => mediaAssetFor(message.id)?.cached()}
                                    cachedPreviewUrl={() =>
                                      mediaPreviewAssetFor(message.id)?.cached()
                                    }
                                    loadPreview={
                                      mediaPresentation(media).preview
                                        ? () => {
                                            const asset = mediaPreviewAssetFor(message.id);
                                            return asset
                                              ? asset.load()
                                              : Effect.fail(
                                                  new Error('Attachment preview is unavailable.'),
                                                );
                                          }
                                        : undefined
                                    }
                                    load={(progress) => {
                                      const asset = mediaAssetFor(message.id);
                                      return asset
                                        ? asset.load(progress)
                                        : Effect.fail(new Error('Attachment data is unavailable.'));
                                    }}
                                    onOpenPreview={(preview) => openImageViewer(message, preview)}
                                  />
                                </>
                              ))(layout.media!)
                            : null}
                          <div class="message-copy">
                            <MessageBody
                              message={caption}
                              loadPreviewPhoto={
                                message.linkPreview?.hasPhoto
                                  ? () => {
                                      const source = snapshot.messages.find(
                                        (candidate) => String(candidate.id) === message.id,
                                      );
                                      return source
                                        ? mediaAssets.messagePreview(source).load()
                                        : Effect.fail(new Error('Preview image is unavailable.'));
                                    }
                                  : undefined
                              }
                              loadPreviewMedia={
                                message.linkPreview?.media
                                  ? () => {
                                      const source = snapshot.messages.find(
                                        (candidate) => String(candidate.id) === message.id,
                                      );
                                      return source
                                        ? mediaAssets.loadMedia(source)
                                        : Effect.fail(new Error('Preview video is unavailable.'));
                                    }
                                  : undefined
                              }
                            />
                            {!message.service && Number.isSafeInteger(Number(message.id)) ? (
                              <MessageActions
                                message={message}
                                pickerOpen={reactionPickerMessageId === message.id}
                                setPickerOpen={(open) =>
                                  setReactionPickerMessageId(open ? message.id : '')
                                }
                                react={(emoji) =>
                                  runInBackground(reactToMessage(message.id, emoji))
                                }
                                loadReactionPeople={(emoji) => {
                                  const peer = snapshot.dialogs.find(
                                    ({ peer }) => peer.id === message.peerId,
                                  )?.peer;
                                  return peer
                                    ? engine.getReactionPeople(peer, Number(message.id), emoji)
                                    : Effect.fail(new Error('Reaction details are unavailable.'));
                                }}
                                loadReactionAvatar={(person, cachedOnly) =>
                                  mediaAssets.loadPeerAvatar(
                                    person.peer,
                                    person.hasAvatar,
                                    person.avatarId,
                                    cachedOnly || !online,
                                  )
                                }
                                reply={(article) => composer.beginReply(message, article)}
                                loadCustomEmoji={(documentId) =>
                                  mediaAssets.loadCustomEmoji(documentId)
                                }
                              />
                            ) : null}
                            <footer
                              aria-label={
                                message.outgoing
                                  ? `${layout.caption.editedAt ? 'Edited. ' : ''}${layout.caption.time}. Message status: ${message.status ?? 'sent'}`
                                  : undefined
                              }
                            >
                              {layout.caption.editedAt ? (
                                <span class="message-edited">edited</span>
                              ) : null}
                              <span>{layout.caption.time}</span>
                              {message.outgoing ? (
                                message.status === 'read' ? (
                                  <CheckCheck size={13} class="message-status-read" />
                                ) : message.status === 'sending' ? (
                                  <Clock3 size={12} />
                                ) : message.status === 'failed' ? (
                                  <CircleAlert size={13} class="text-red-300" />
                                ) : (
                                  <Check size={13} />
                                )
                              ) : null}
                            </footer>
                          </div>
                          {(
                            !message.service && message.botKeyboard?.kind === 'inline'
                              ? message.botKeyboard
                              : undefined
                          )
                            ? ((keyboard) => (
                                <BotKeyboard
                                  keyboard={keyboard}
                                  disabled={!canUseLiveCommands}
                                  busyButton={
                                    bot.buttonBusy?.owner === message.id
                                      ? bot.buttonBusy?.key
                                      : undefined
                                  }
                                  label={`Actions for message ${message.id}`}
                                  onPress={(button, key) =>
                                    runInBackground(
                                      bot.press(button, message.id, key, Number(message.id)),
                                    )
                                  }
                                />
                              ))(
                                (!message.service && message.botKeyboard?.kind === 'inline'
                                  ? message.botKeyboard
                                  : undefined)!,
                              )
                            : null}
                          {message.status === 'failed' && pendingSendForMessage(message.id)
                            ? ((pending) => (
                                <div
                                  class="pending-message-actions"
                                  aria-label="Failed message actions"
                                >
                                  <p>{pending.lastError}</p>
                                  <button
                                    disabled={Boolean(pendingActionId)}
                                    onClick={() => void retryPendingSend(pending.id)}
                                  >
                                    {pendingActionId === pending.id ? 'Retrying…' : 'Retry'}
                                  </button>
                                  <button
                                    disabled={Boolean(pendingActionId)}
                                    onClick={() => void cancelPendingSend(pending.id)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ))(pendingSendForMessage(message.id)!)
                            : null}
                        </article>
                      </div>
                    );
                  })
                ) : !snapshot.loadingMessages &&
                  activePeerMatches &&
                  !conversationLoadError &&
                  !activeHistoryError &&
                  activeMessages.length === 0 &&
                  activeChatId !== 'empty' ? (
                  <div class="mx-auto my-auto flex max-w-xs flex-col items-center text-center">
                    <div class="mb-4 grid size-14 place-items-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
                      <MessageSquareText size={25} />
                    </div>
                    <h2 class="font-semibold">No messages yet</h2>
                    <p class="mt-1 text-sm leading-5 text-[var(--muted)]">
                      Start a conversation when Telegram is online.
                    </p>
                  </div>
                ) : null}
                {messageContextMenu
                  ? ((menu) =>
                      messageContextTarget
                        ? ((target) => (
                            <div
                              class="message-context-menu"
                              role="menu"
                              aria-label="Message actions"
                              style={{
                                left:
                                  menu.x > viewportWidth - 190
                                    ? 'auto'
                                    : `${Math.max(8, menu.x)}px`,
                                right: menu.x > viewportWidth - 190 ? '8px' : 'auto',
                                top:
                                  menu.y > model.viewportHeight / 2
                                    ? 'auto'
                                    : `${Math.max(8, menu.y)}px`,
                                bottom:
                                  menu.y > model.viewportHeight / 2
                                    ? `${Math.max(8, model.viewportHeight - menu.y)}px`
                                    : 'auto',
                              }}
                            >
                              <button
                                role="menuitem"
                                onClick={() => {
                                  const message = target;
                                  setMessageContextMenu(undefined);
                                  model.replyTo(message);
                                }}
                              >
                                <Reply size={15} /> Reply
                              </button>
                              {target.media && !target.protected ? (
                                <button
                                  role="menuitem"
                                  onClick={() => void saveMessageMedia(target)}
                                >
                                  <Copy size={15} /> Save media as
                                </button>
                              ) : null}
                              {target.media?.kind === 'file' ? (
                                <button
                                  role="menuitem"
                                  onClick={() => void copyMediaFilename(target)}
                                >
                                  <Copy size={15} /> Copy filename
                                </button>
                              ) : null}
                              {messageTextForClipboard(target) ? (
                                <button
                                  role="menuitem"
                                  onClick={() => void copyMessageText(target)}
                                >
                                  <Copy size={15} /> Copy text
                                </button>
                              ) : null}
                              {messageCapabilitiesForUi(target).canForward ? (
                                <button
                                  role="menuitem"
                                  onClick={() => {
                                    setMessageContextMenu(undefined);
                                    setForwardingMessage(target);
                                  }}
                                >
                                  <Forward size={15} /> Forward
                                </button>
                              ) : null}
                              {messageCapabilitiesForUi(target).canPin ? (
                                <button
                                  role="menuitem"
                                  onClick={() => {
                                    const message = target;
                                    setMessageContextMenu(undefined);
                                    const conversation = activeConversation;
                                    if (conversation) {
                                      runInBackground(
                                        runEffect(
                                          conversation.setPinnedMessage(
                                            Number(message.id),
                                            !snapshot.pinnedMessages.some(
                                              ({ id }) => id === Number(message.id),
                                            ),
                                          ),
                                        ),
                                      );
                                    }
                                  }}
                                >
                                  <Pin size={15} />
                                  {snapshot.pinnedMessages.some(
                                    ({ id }) => id === Number(target.id),
                                  )
                                    ? 'Unpin'
                                    : 'Pin'}
                                </button>
                              ) : null}
                              {messageCapabilitiesForUi(target).canEdit ? (
                                <button
                                  role="menuitem"
                                  onClick={() => {
                                    const message = target;
                                    setMessageContextMenu(undefined);
                                    composer.beginEdit(message);
                                  }}
                                >
                                  <Pencil size={15} /> Edit
                                </button>
                              ) : null}
                              {messageCapabilitiesForUi(target).canDelete ? (
                                <button
                                  class="danger"
                                  role="menuitem"
                                  onClick={() => {
                                    const message = target;
                                    setMessageContextMenu(undefined);
                                    setDeleteTarget(message);
                                  }}
                                >
                                  <Trash2 size={15} /> Delete
                                </button>
                              ) : null}
                            </div>
                          ))(messageContextTarget!)
                        : null)(messageContextMenu!)
                  : null}
                <div class="present-scroll-anchor" aria-hidden="true" />
              </div>
            </div>

            {viewport.jumpVisible ? (
              <button
                class="jump-to-present"
                type="button"
                aria-label="Jump to present"
                onClick={() => {
                  model.jumpToPresent();
                }}
              >
                <ArrowDown size={19} />
              </button>
            ) : null}
          </div>

          {bot.notice
            ? ((notice) => (
                <div class="bot-callback-notice" role="status">
                  {notice}
                </div>
              ))(bot.notice!)
            : null}
          {activeChatId !== 'empty' &&
          (activeChat.bot ||
            bot.commands.length > 0 ||
            Boolean(visibleReplyKeyboard?.keyboard.rows.some((row) => row.length > 0))) ? (
            <BotControls
              isBot={Boolean(activeChat.bot)}
              showCommands={Boolean(activeChat.bot || bot.commands.length > 0)}
              started={botStarted}
              enabled={canUseLiveCommands}
              starting={bot.starting}
              menuOpen={bot.menuOpen}
              loadingCommands={bot.commandsLoading}
              commands={bot.commands}
              replyKeyboard={visibleReplyKeyboard?.keyboard}
              busyButton={bot.buttonBusy?.owner === 'reply' ? bot.buttonBusy?.key : undefined}
              onToggleMenu={bot.toggleMenu}
              onStart={() => runInBackground(bot.start())}
              onCommand={bot.sendCommand}
              onReplyButton={(button, key) =>
                runInBackground(bot.press(button, 'reply', key, visibleReplyKeyboard?.messageId))
              }
            />
          ) : null}
          <ChatComposer
            conversationId={activeChatId}
            placeholder={visibleReplyKeyboard?.keyboard.placeholder}
            enabled={canQueueMessage}
            canSendMedia={canSendMedia}
            canSendStickers={canSendStickers}
            canSendGifs={canSendGifs}
            composer={composer}
            expressions={expressions}
            editLastMessage={editLastMessage}
            onGeometryChange={viewport.reconcileLayout}
            media={{
              loadSticker: (sticker) => mediaAssets.loadSticker(sticker),
              stickerUrl: (sticker) => mediaAssets.sticker(sticker).cached(),
            }}
          />
        </section>

        {mediaViewer
          ? ((viewer) => {
              const message = () => viewer.messages[viewer.index]!;
              const capabilities = () => messageCapabilitiesForUi(message());
              return (
                <MediaViewer
                  kind={viewer.preview.kind}
                  name={viewer.preview.name}
                  url={viewer.preview.url}
                  origin={viewer.preview.origin}
                  author={message().author}
                  time={message().time}
                  caption={message().body}
                  protected={message().protected}
                  position={viewer.index + 1}
                  count={viewer.messages.length}
                  loading={viewer.loading}
                  previous={
                    viewer.index > 0 ? () => void navigateImageViewer(viewer.index - 1) : undefined
                  }
                  next={
                    viewer.index < viewer.messages.length - 1
                      ? () => void navigateImageViewer(viewer.index + 1)
                      : undefined
                  }
                  download={
                    message().protected
                      ? undefined
                      : () => saveMediaUrl(viewer.preview.url, viewer.preview.name)
                  }
                  forward={
                    !capabilities().canForward
                      ? undefined
                      : () => {
                          const target = message();
                          setMediaViewer(undefined);
                          setForwardingMessage(target);
                        }
                  }
                  edit={
                    capabilities().canEdit
                      ? () => {
                          const target = message();
                          setMediaViewer(undefined);
                          composer.beginEdit(target);
                        }
                      : undefined
                  }
                  delete={
                    capabilities().canDelete
                      ? () => {
                          const target = message();
                          setMediaViewer(undefined);
                          setDeleteTarget(target);
                        }
                      : undefined
                  }
                  goToMessage={() => {
                    const target = message();
                    setMediaViewer(undefined);
                    model.revealMessage(target.id);
                  }}
                  close={() => setMediaViewer(undefined)}
                />
              );
            })(mediaViewer!)
          : null}

        {forwardingMessage ? (
          <ForwardMessageDialog
            chats={visibleChats}
            close={() => setForwardingMessage(undefined)}
            search={(query) => engine.searchPeers(query)}
            forward={(peerId, result) => runInBackground(forwardMessage(peerId, result))}
          />
        ) : null}

        {bot.inlineSwitch ? (
          <ForwardMessageDialog
            chats={visibleChats.filter(({ id }) => id !== activeChatId)}
            title="Choose a chat"
            label="Choose a chat for inline query"
            cancelLabel="Cancel inline query"
            close={bot.closeInlineSwitch}
            forward={(peerId) => void bot.chooseInlineChat(peerId)}
          />
        ) : null}

        {searchOpen ? (
          <SearchPanel
            dialogs={snapshot.dialogs}
            activePeerId={activeChatId}
            search={(term, global, offset) => activeConversation!.search(term, global, offset)}
            openResult={(message) => {
              setSearchOpen(false);
              runInBackground(openMessage(message));
            }}
            close={() => setSearchOpen(false)}
          />
        ) : null}

        {sharedMediaKind
          ? ((kind) => (
              <SharedMediaPanel
                peerId={activeChatId}
                initialKind={kind}
                loadItems={(selected, offset) => activeConversation!.sharedMedia(selected, offset)}
                loadMedia={(message, progress) => mediaAssets.loadMedia(message, progress)}
                loadMediaPreview={(message) => mediaAssets.messagePreview(message).load()}
                cachedMedia={(message) => mediaAssets.message(message).cached()}
                cachedMediaPreview={(message) => mediaAssets.messagePreview(message).cached()}
                openMessage={(message) => {
                  setSharedMediaKind(undefined);
                  runInBackground(openMessage(message));
                }}
                dialogs={snapshot.dialogs}
                forwardMessage={(message) => {
                  if (!telegramMessageCapabilitiesForUi(message).canForward) return;
                  setSharedMediaKind(undefined);
                  const readOutboxMaxId =
                    snapshot.dialogs.find(({ peer }) => peer.id === message.peerId)
                      ?.readOutboxMaxId ?? 0;
                  setForwardingMessage(presentMessage(message, readOutboxMaxId));
                }}
                deleteMessage={(message) => {
                  if (!telegramMessageCapabilitiesForUi(message).canDelete) return;
                  setSharedMediaKind(undefined);
                  const readOutboxMaxId =
                    snapshot.dialogs.find(({ peer }) => peer.id === message.peerId)
                      ?.readOutboxMaxId ?? 0;
                  setDeleteTarget(presentMessage(message, readOutboxMaxId));
                }}
                close={() => setSharedMediaKind(undefined)}
              />
            ))(sharedMediaKind!)
          : null}

        {deleteTarget
          ? ((message) => (
              <DeleteMessageDialog
                canDeleteForMe={messageCapabilitiesForUi(message).canDeleteForMe}
                canDeleteForEveryone={messageCapabilitiesForUi(message).canDeleteForEveryone}
                close={() => setDeleteTarget(undefined)}
                confirm={(revoke) => {
                  const messageId = message.id;
                  setDeleteTarget(undefined);
                  runInBackground(deleteMessage(messageId, revoke));
                }}
              />
            ))(deleteTarget!)
          : null}

        {deleteChatTarget
          ? ((chat) => (
              <DeleteChatDialog
                dialog={chat}
                hasDraft={Boolean(snapshot.drafts[chat.peer.id]?.trim())}
                queuedCount={snapshot.pending.filter(({ peer }) => peer.id === chat.peer.id).length}
                close={() => setDeleteChatTarget(undefined)}
                confirm={(action) => {
                  const peerId = chat.peer.id;
                  setDeleteChatTarget(undefined);
                  runInBackground(model.deleteChat(peerId, action));
                }}
              />
            ))(deleteChatTarget!)
          : null}

        {bot.urlAuth
          ? ((pending) => (
              <BotUrlAuthDialog
                request={pending.request}
                busy={bot.urlAuthBusy}
                close={bot.closeUrlAuth}
                confirm={(options) => void bot.acceptUrlAuth(options)}
              />
            ))(bot.urlAuth!)
          : null}

        {settingsOpen ? (
          <SettingsDialog
            loggingOut={loggingOut}
            clearingCache={clearingCache}
            debugReportBusy={debugReportBusy}
            debugReportError={debugReportError}
            close={() => !loggingOut && !clearingCache && setSettingsOpen(false)}
            clearCache={() => void clearCache()}
            downloadDebugReport={
              model.debugReportsAvailable ? () => void downloadDebugReport() : undefined
            }
            logOut={() => void logOut()}
            appearance={appearance}
            telegramWallpapers={telegramWallpapers}
            wallpaperBusy={wallpaperBusy}
            wallpaperError={wallpaperError}
            setTheme={selectTheme}
            setAccentColor={selectAccentColor}
            setSystemAccent={selectSystemAccent}
            setChatFontSize={selectChatFontSize}
            setWallpaper={selectWallpaper}
            setTelegramWallpaper={(wallpaper) => void selectTelegramWallpaper(wallpaper)}
            setWallpaperEffects={appearanceSession.update}
            uploadWallpaper={(file) => void uploadWallpaper(file)}
          />
        ) : null}

        <DetailsPane
          chat={activeChat}
          avatarIdentity={`${activeChat.id}:${activeDialog?.avatarId ?? 'none'}`}
          counts={activeSharedCounts}
          online={online}
          conversationReady={activeConversationReady}
          modal={detailsOpen && viewportWidth <= 1100}
          media={mediaAssets}
          details={contactDetails}
          close={() => updateDetailsOpen(false)}
          openShared={(kind) => {
            if (activeConversationReady) setSharedMediaKind(kind);
          }}
          setBlocked={(blocked) => {
            const dialog = activeDialog;
            const conversation = activeConversation;
            if (dialog?.peer.kind === 'user' && conversation?.peerId === dialog.peer.id) {
              runInBackground(runEffect(conversation.setBlocked(blocked)));
            }
          }}
        />
      </div>
      {authOpen ? (
        <AuthOverlay
          open
          snapshot={snapshot}
          configurationError={configurationError}
          onRetry={() => fromPromise(retrySync)}
          onPhone={(phone) => engine.requestCode(phone).pipe(Effect.asVoid)}
          onCode={(code) => engine.submitCode(code).pipe(Effect.asVoid)}
          onPassword={(password) => engine.submitPassword(password).pipe(Effect.asVoid)}
        />
      ) : null}
    </main>
  );
});
function runInBackground(task: Promise<unknown>) {
  void task.catch(() => undefined);
}
