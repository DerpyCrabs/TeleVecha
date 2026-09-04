import { Effect, Predicate } from 'effect';

import { makeConversation } from '../telegram/core/conversation';
import type { EffectMessagingClient } from '../telegram/core/client';
import { MessagingError } from '../telegram/core/messagingError';
import { conversationViewSnapshot } from '../telegram/core/engineState';
import type {
  EngineSnapshot,
  SharedMediaCounts,
  SharedMediaKind,
  TelegramMessage,
  TelegramPeer,
  TelegramPeerSearchResult,
  TelegramSearchOffset,
  TelegramSearchPage,
  TelegramSticker,
} from '../telegram/types';
import { hydrateTvBugState, type TvBugBundleV2, type TvBugStateV2 } from './tvbugFormat';
import { createTvBugPlaceholder } from './tvbugMedia';
import {
  DEFAULT_THEME_PREFERENCES,
  saveThemePreferences,
  type ThemePresetId,
  type WallpaperId,
} from '../ui/theme/themePreferences';

const SIDEBAR_WIDTH_STORAGE_KEY = 'televecha:left-sidebar-width';
const DETAILS_OPEN_STORAGE_KEY = 'televecha:details-open';
const TVBUG_THEMES = new Set<ThemePresetId>(['classic', 'day', 'night', 'tinted']);

export type TvBugStatus = {
  state: 'loading' | 'ready' | 'error';
  message?: string | undefined;
};

declare global {
  interface Window {
    __televechaTvBugBundle?: TvBugBundleV2 | undefined;
    __televechaTvBugStatus?: TvBugStatus | undefined;
  }
}

export function injectedTvBugBundle() {
  return window.__televechaTvBugBundle;
}

/**
 * Opens the captured state directly without starting the messaging engine or Telegram transport.
 */
export function createTvBugSnapshotClient(bundle: TvBugBundleV2): EffectMessagingClient {
  try {
    const hydrated = hydrateTvBugState(bundle.snapshot);
    const histories = hydrated.histories;
    const pinnedMessages = hydrated.pinnedMessages;
    const listeners = new Set<(snapshot: EngineSnapshot) => void>();
    const runtime = runtimeRecord(bundle.snapshot);
    let snapshot = snapshotFromState(bundle.snapshot, runtime, hydrated);
    let client: EffectMessagingClient;

    const emit = () => {
      for (const listener of listeners) listener(snapshot);
    };
    const select = (peerId: string) => {
      if (!snapshot.dialogs.some((dialog) => dialog.peer.id === peerId)) {
        throw new Error('The captured snapshot does not contain this conversation.');
      }
      snapshot = {
        ...snapshot,
        activePeerId: peerId,
        messages: histories[peerId] ?? [],
        pinnedMessages: pinnedMessages[peerId]?.value ?? [],
        loadingMessages: false,
        loadingOlderMessages: false,
        hasOlderMessages: false,
        sharedMediaCounts: undefined,
        historyGaps: [],
      };
      emit();
    };

    const target = {
      snapshot: () => snapshot,
      subscribe(listener: (value: EngineSnapshot) => void) {
        return Effect.sync(() => {
          listeners.add(listener);
          listener(snapshot);
          return Effect.sync(() => {
            listeners.delete(listener);
          });
        });
      },
      subscribeResources() {
        return Effect.succeed(Effect.void);
      },
      conversation(peerId: string) {
        const dialog = snapshot.dialogs.find(({ peer }) => peer.id === peerId);
        return dialog ? makeConversation(client, dialog.peer) : undefined;
      },
      openConversation: (peerId: string) =>
        Effect.sync(() => {
          select(peerId);
          return target.conversation(peerId)!;
        }),
      mediaAssetKey(message: TelegramMessage) {
        return `${message.peerId}:${message.id}:${message.media?.cacheKey ?? 'snapshot'}`;
      },
      downloadMedia: (message: TelegramMessage) => Effect.succeed(placeholderForMessage(message)),
      downloadAvatar: () =>
        Effect.succeed(
          createTvBugPlaceholder({
            byteSize: 1_024,
            mimeType: 'image/svg+xml',
            width: 96,
            height: 96,
          }),
        ),
      loadCachedAvatar: () => Effect.succeed(undefined),
      downloadSticker: (sticker: TelegramSticker) =>
        Effect.succeed(
          createTvBugPlaceholder({
            byteSize: sticker.size ?? 4_096,
            mimeType: sticker.mimeType,
            width: 512,
            height: 512,
          }),
        ),
      downloadCustomEmoji: () =>
        Effect.succeed(
          createTvBugPlaceholder({
            byteSize: 4_096,
            mimeType: 'image/svg+xml',
            width: 64,
            height: 64,
          }),
        ),
      getUserDetails(peer: TelegramPeer) {
        const details = snapshot.dialogs.find((dialog) => dialog.peer.id === peer.id)?.userDetails;
        return details
          ? Effect.succeed(details)
          : Effect.fail(
              new MessagingError({
                message: 'User details were not present in the captured snapshot.',
                operation: 'getUserDetails',
              }),
            );
      },
      searchPeers(query: string) {
        const needle = query.trim().toLocaleLowerCase();
        return Effect.succeed(
          snapshot.dialogs
            .filter((dialog) => !needle || dialog.title.toLocaleLowerCase().includes(needle))
            .map(
              (dialog) =>
                ({
                  peer: dialog.peer,
                  category: dialog.bot ? ('bot' as const) : dialog.peer.kind,
                  title: dialog.title,
                  initials: dialog.initials,
                  color: dialog.color,
                  username: dialog.username,
                  bot: dialog.bot ?? false,
                  isContact: dialog.userDetails?.isContact ?? false,
                  hasAvatar: dialog.hasAvatar,
                  avatarId: dialog.avatarId,
                }) satisfies TelegramPeerSearchResult,
            ),
        );
      },
      searchConversationMessages(
        peer: TelegramPeer,
        query: string,
        global: boolean,
        offset?: TelegramSearchOffset,
      ) {
        void offset;
        return Effect.succeed(localSearch(histories, peer.id, query, global));
      },
      getConversationSharedMedia(
        peer: TelegramPeer,
        kind: SharedMediaKind,
        offset?: TelegramSearchOffset,
      ) {
        void offset;
        const messages = (histories[peer.id] ?? []).filter((message) =>
          matchesMediaKind(message, kind),
        );
        return Effect.succeed({ messages, hasMore: false });
      },
      openMessageInConversationView(
        message: TelegramMessage,
        currentView = conversationViewSnapshot(snapshot),
      ) {
        const messages = histories[message.peerId] ?? [];
        return Effect.succeed({
          conversation: { ...currentView, activePeerId: message.peerId, messages },
          found: messages.some(({ id }) => id === message.id),
        });
      },
      loadOlderConversationView(_peerId: string, currentView = conversationViewSnapshot(snapshot)) {
        return Effect.succeed(currentView);
      },
      loadHistoryGapConversationView(
        _peerId: string,
        _gap: unknown,
        currentView = conversationViewSnapshot(snapshot),
      ) {
        return Effect.succeed(currentView);
      },
      retryConversationView(_peerId: string, currentView = conversationViewSnapshot(snapshot)) {
        return Effect.succeed(currentView);
      },
      loadConversationSharedMediaCounts: () => Effect.succeed(undefined),
    };

    client = {
      ...target,
      start: () => Effect.void,
      stop: () => Effect.void,
      retrySync: () => Effect.void,
      refreshUpdates: () => Effect.void,
      refreshReadReceipt: () => Effect.void,
      retryMarkRead: () => Effect.void,
      clearOperationError: () => Effect.void,
      requestCode: () => Effect.void,
      submitCode: () => Effect.succeed(undefined),
      submitPassword: () => Effect.void,
      logOut: () => Effect.void,
      clearCache: () => Effect.succeed(undefined),
      setActiveConversationVisibility: () => Effect.void,
      setDraft: () => Effect.void,
      setTyping: () => Effect.void,
      sendDraft: () => Effect.void,
      sendAttachments: () => Effect.void,
      sendSticker: () => Effect.void,
      forwardMessage: () => Effect.succeed(undefined),
      editMessage: () =>
        Effect.fail(
          new MessagingError({
            message: 'Captured reports are read-only.',
            operation: 'editMessage',
          }),
        ),
      deleteMessage: () => Effect.succeed(false),
      toggleReaction: () => Effect.void,
      retryPendingSend: () => Effect.void,
      cancelPendingSend: () => Effect.succeed(false),
      retryOutbox: () => Effect.void,
      addPeer: () => Effect.void,
      getGroupMembers: () => Effect.succeed({ members: [], totalCount: 0, hasMore: false }),
      setMuted: () => Effect.succeed(false),
      setBlocked: () => Effect.succeed(false),
      updateContact: () => Effect.succeed(false),
      deleteContact: () => Effect.succeed(false),
      setPinnedDialog: () => Effect.succeed(false),
      setPinnedMessage: () => Effect.succeed(undefined),
      setArchived: () => Effect.succeed(false),
      deleteDialog: () => Effect.succeed(false),
      getWallpapers: () => Effect.succeed([]),
      getChatAppearance: () => Effect.succeed(undefined),
      downloadWallpaper: () => Effect.succeed(new Blob()),
      getRecentStickers: () => Effect.succeed([]),
      getStickerPacks: () => Effect.succeed([]),
      getSavedGifs: () => Effect.succeed([]),
      searchGifs: () => Effect.succeed([]),
      getBotCommands: () => Effect.succeed([]),
      startBot: () => Effect.void,
      answerBotCallback: () => Effect.succeed(undefined),
      requestUrlAuth: () => Effect.succeed(undefined),
      acceptUrlAuth: () => Effect.succeed(undefined),
    };
    setTvBugStatus({ state: 'ready' });
    return client;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setTvBugStatus({ state: 'error', message });
    throw error;
  }
}

export function applyTvBugUiState(state: TvBugStateV2) {
  const ui = state.ui;
  if (!ui) return;
  const appearance = ui.appearance;
  if (appearance) {
    const requestedTheme = appearance.themeId as ThemePresetId | undefined;
    const theme = requestedTheme && TVBUG_THEMES.has(requestedTheme) ? requestedTheme : 'night';
    saveThemePreferences({
      ...DEFAULT_THEME_PREFERENCES,
      theme,
      accentColor: appearance.accentColor ?? DEFAULT_THEME_PREFERENCES.accentColor,
      wallpaper: tvbugWallpaper(appearance.wallpaperKind),
      wallpaperBlur:
        typeof appearance.blur === 'number'
          ? appearance.blur
          : appearance.blur
            ? 8
            : DEFAULT_THEME_PREFERENCES.wallpaperBlur,
      wallpaperDim: appearance.dim ?? DEFAULT_THEME_PREFERENCES.wallpaperDim,
      chatFontSize: appearance.chatFontSize ?? DEFAULT_THEME_PREFERENCES.chatFontSize,
    });
  }
  try {
    if (ui.sidebarWidth !== undefined) {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(ui.sidebarWidth));
    }
    if (ui.detailsOpen !== undefined) {
      localStorage.setItem(DETAILS_OPEN_STORAGE_KEY, String(ui.detailsOpen));
    }
  } catch {
    // Snapshot inspection still works when browser storage is disabled.
  }
  const activePeerId = snapshotBootstrapPeerId(state);
  const url = new URL(window.location.href);
  if (ui.route?.startsWith('/')) url.pathname = ui.route;
  url.searchParams.set('tvbug', '1');
  if (activePeerId) url.searchParams.set('chat', activePeerId);
  window.history.replaceState({}, '', url);
}

export function snapshotBootstrapPeerId(state: TvBugStateV2) {
  return (
    state.workspace?.activePeerId ??
    state.ui?.activePeerId ??
    state.lastPeerId ??
    state.ui?.bootstrapActivePeerId
  );
}

function snapshotFromState(
  state: TvBugStateV2,
  runtime: Record<string, unknown>,
  hydrated: ReturnType<typeof hydrateTvBugState>,
): EngineSnapshot {
  const activePeerId = snapshotBootstrapPeerId(state);
  const sharedMediaCounts = decodeSharedMediaCounts(runtime.sharedMediaCounts);
  return {
    phase: capturedPhase(runtime.phase ?? state.workspace.phase, hydrated.dialogs.length),
    sync: capturedSync(runtime.sync ?? state.workspace.sync),
    // Inspection is intentionally read-only even when the capture happened online.
    online: false,
    dialogs: hydrated.dialogs,
    ...(activePeerId ? { activePeerId } : {}),
    messages: activePeerId
      ? (hydrated.histories[activePeerId] ?? hydrated.messages)
      : hydrated.messages,
    drafts: hydrated.drafts,
    draftDetails: {},
    pending: hydrated.pending,
    loadingMessages: booleanValue(runtime.loadingMessages),
    hasOlderMessages: booleanValue(runtime.hasOlderMessages),
    loadingOlderMessages: booleanValue(runtime.loadingOlderMessages),
    ...(sharedMediaCounts === undefined ? {} : { sharedMediaCounts }),
    pinnedMessages: activePeerId ? (hydrated.pinnedMessages[activePeerId]?.value ?? []) : [],
    historyGaps: Array.isArray(runtime.historyGaps)
      ? (runtime.historyGaps as EngineSnapshot['historyGaps'])
      : [],
    activities: Array.isArray(runtime.activities)
      ? (runtime.activities as EngineSnapshot['activities'])
      : [],
    ...(runtime.loginStep === 'phone' ||
    runtime.loginStep === 'code' ||
    runtime.loginStep === 'password'
      ? { authStep: runtime.loginStep }
      : {}),
    ...(typeof runtime.codeViaApp === 'boolean' ? { codeViaApp: runtime.codeViaApp } : {}),
    ...optionalString(runtime, 'historyError'),
    ...(typeof runtime.historyRetryAt === 'number'
      ? { historyRetryAt: runtime.historyRetryAt }
      : {}),
    ...optionalString(runtime, 'operationError'),
    ...optionalString(runtime, 'error'),
    ...(typeof runtime.requiresReload === 'boolean'
      ? { requiresReload: runtime.requiresReload }
      : {}),
  };
}

function decodeSharedMediaCounts(value: unknown): SharedMediaCounts | undefined {
  if (!Predicate.isObject(value)) return undefined;
  const number = (key: keyof SharedMediaCounts) =>
    typeof value[key] === 'number' ? value[key] : undefined;
  const photos = number('photos');
  const videos = number('videos');
  const files = number('files');
  const audio = number('audio');
  const links = number('links');
  const voice = number('voice');
  const gifs = number('gifs');
  if ([photos, videos, files, audio, links, voice, gifs].some((count) => count === undefined)) {
    return undefined;
  }
  return {
    photos: photos!,
    videos: videos!,
    files: files!,
    audio: audio!,
    links: links!,
    voice: voice!,
    gifs: gifs!,
  };
}

function runtimeRecord(state: TvBugStateV2) {
  return Predicate.isObject(state.runtime) ? state.runtime : {};
}

function capturedPhase(value: unknown, dialogCount: number): EngineSnapshot['phase'] {
  if (['idle', 'connecting', 'unauthorized', 'syncing', 'ready', 'error'].includes(String(value))) {
    return value as EngineSnapshot['phase'];
  }
  return dialogCount > 0 ? 'ready' : 'error';
}

function capturedSync(value: unknown): EngineSnapshot['sync'] {
  return value === 'current' || value === 'recovering' || value === 'stale' ? value : 'stale';
}

function booleanValue(value: unknown) {
  return value === true;
}

function optionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' ? { [key]: value } : {};
}

function placeholderForMessage(message: TelegramMessage) {
  const media = message.media ?? message.linkPreview?.media;
  return createTvBugPlaceholder({
    byteSize: media?.size ?? 4_096,
    mimeType: media?.mimeType ?? 'image/svg+xml',
    width: media?.width ?? (message.linkPreview?.photoSize === 'small' ? 96 : 640),
    height: media?.height ?? (message.linkPreview?.photoSize === 'small' ? 96 : 360),
  });
}

function localSearch(
  histories: Readonly<Record<string, TelegramMessage[]>>,
  activePeerId: string | undefined,
  query: string,
  global: boolean,
): TelegramSearchPage {
  const needle = query.trim().toLocaleLowerCase();
  const messages = (
    global ? Object.values(histories).flat() : activePeerId ? (histories[activePeerId] ?? []) : []
  ).filter((message) => message.text.toLocaleLowerCase().includes(needle));
  return { messages, hasMore: false };
}

function matchesMediaKind(message: TelegramMessage, kind: SharedMediaKind) {
  if (kind === 'links') return Boolean(message.links?.length || message.linkPreview);
  if (!message.media) return false;
  if (kind === 'photos') return message.media.kind === 'photo';
  if (kind === 'videos')
    return message.media.kind === 'video' || message.media.kind === 'round-video';
  if (kind === 'voice') return message.media.kind === 'voice';
  if (kind === 'audio')
    return message.media.kind === 'file' && message.media.mimeType.startsWith('audio/');
  if (kind === 'gifs') return message.media.kind === 'animation';
  return kind === 'files';
}

function tvbugWallpaper(
  kind: NonNullable<NonNullable<TvBugStateV2['ui']>['appearance']>['wallpaperKind'],
): WallpaperId {
  if (kind === 'pattern') return 'doodles';
  if (kind === 'solid') return 'graphite';
  if (kind === 'gradient') return 'aurora';
  return 'none';
}

function setTvBugStatus(status: TvBugStatus) {
  window.__televechaTvBugStatus = status;
  document.documentElement.dataset.tvbugStatus = status.state;
  if (status.message) document.documentElement.dataset.tvbugMessage = status.message;
  else delete document.documentElement.dataset.tvbugMessage;
}
