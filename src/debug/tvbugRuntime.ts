import { Conversation } from '../telegram/core/conversation';
import type { MessagingClient } from '../telegram/core/client';
import type {
  EngineSnapshot,
  SharedMediaKind,
  TelegramMessage,
  TelegramPeer,
  TelegramPeerSearchResult,
  TelegramSearchOffset,
  TelegramSearchPage,
  TelegramSticker,
  TelegramUserDetails,
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
export function createTvBugSnapshotClient(bundle: TvBugBundleV2): MessagingClient {
  try {
    const hydrated = hydrateTvBugState(bundle.snapshot);
    const histories = hydrated.histories;
    const pinnedMessages = hydrated.pinnedMessages;
    const listeners = new Set<(snapshot: EngineSnapshot) => void>();
    const runtime = runtimeRecord(bundle.snapshot);
    let snapshot = snapshotFromState(bundle.snapshot, runtime, hydrated);
    let client: MessagingClient;

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
        listeners.add(listener);
        listener(snapshot);
        return () => listeners.delete(listener);
      },
      subscribeResources() {
        return () => undefined;
      },
      async openConversation(peerId: string) {
        select(peerId);
        return new Conversation(client as never, peerId);
      },
      async selectChat(peerId: string) {
        select(peerId);
      },
      mediaAssetKey(message: TelegramMessage) {
        return `${message.peerId}:${message.id}:${message.media?.cacheKey ?? 'snapshot'}`;
      },
      async downloadMedia(message: TelegramMessage) {
        return placeholderForMessage(message);
      },
      async downloadAvatar() {
        return createTvBugPlaceholder({
          byteSize: 1_024,
          mimeType: 'image/svg+xml',
          width: 96,
          height: 96,
        });
      },
      async loadCachedAvatar() {
        return undefined;
      },
      async downloadSticker(sticker: TelegramSticker) {
        return createTvBugPlaceholder({
          byteSize: sticker.size ?? 4_096,
          mimeType: sticker.mimeType,
          width: 512,
          height: 512,
        });
      },
      async downloadCustomEmoji() {
        return createTvBugPlaceholder({
          byteSize: 4_096,
          mimeType: 'image/svg+xml',
          width: 64,
          height: 64,
        });
      },
      async getUserDetails(peer: TelegramPeer): Promise<TelegramUserDetails> {
        const details = snapshot.dialogs.find((dialog) => dialog.peer.id === peer.id)?.userDetails;
        if (!details) throw new Error('User details were not present in the captured snapshot.');
        return details;
      },
      async searchPeers(query: string): Promise<TelegramPeerSearchResult[]> {
        const needle = query.trim().toLocaleLowerCase();
        return snapshot.dialogs
          .filter((dialog) => !needle || dialog.title.toLocaleLowerCase().includes(needle))
          .map((dialog) => ({
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
          }));
      },
      async searchMessages(
        query: string,
        global: boolean,
        offset?: TelegramSearchOffset,
      ): Promise<TelegramSearchPage> {
        void offset;
        return localSearch(histories, snapshot.activePeerId, query, global);
      },
      async getSharedMedia(
        kind: SharedMediaKind,
        offset?: TelegramSearchOffset,
      ): Promise<TelegramSearchPage> {
        void offset;
        const messages = snapshot.messages.filter((message) => matchesMediaKind(message, kind));
        return { messages, hasMore: false };
      },
      async openMessage(message: TelegramMessage) {
        if (message.peerId !== snapshot.activePeerId) select(message.peerId);
        return snapshot.messages.some((candidate) => candidate.id === message.id);
      },
      async stop() {},
      async start() {},
      async refreshUpdates() {},
      async refreshReadReceipt() {},
      async retrySync() {},
      async retryOutbox() {},
      async ensureSharedMediaCounts() {},
      async setActiveConversationVisibility() {},
      clearOperationError() {},
    };

    client = new Proxy(target, {
      get(current, property, receiver) {
        const member = Reflect.get(current, property, receiver);
        if (member !== undefined) return member;
        if (typeof property !== 'string') return undefined;
        return async () => snapshotDefaultResult(property);
      },
    }) as unknown as MessagingClient;
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
    pending: hydrated.pending,
    loadingMessages: booleanValue(runtime.loadingMessages),
    hasOlderMessages: booleanValue(runtime.hasOlderMessages),
    loadingOlderMessages: booleanValue(runtime.loadingOlderMessages),
    ...(isRecord(runtime.sharedMediaCounts)
      ? {
          sharedMediaCounts:
            runtime.sharedMediaCounts as unknown as EngineSnapshot['sharedMediaCounts'],
        }
      : {}),
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

function runtimeRecord(state: TvBugStateV2) {
  return isRecord(state.runtime) ? state.runtime : {};
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
  return createTvBugPlaceholder({
    byteSize: message.media?.size ?? 4_096,
    mimeType: message.media?.mimeType ?? 'image/svg+xml',
    width: message.media?.width ?? (message.linkPreview?.photoSize === 'small' ? 96 : 640),
    height: message.media?.height ?? (message.linkPreview?.photoSize === 'small' ? 96 : 360),
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

function snapshotDefaultResult(method: string) {
  if (/^(?:get|search)/u.test(method)) return [];
  if (/^(?:download)/u.test(method)) return new Blob();
  if (method === 'openMessage') return false;
  return undefined;
}

function tvbugWallpaper(
  kind: NonNullable<NonNullable<TvBugStateV2['ui']>['appearance']>['wallpaperKind'],
): WallpaperId {
  if (kind === 'pattern') return 'doodles';
  if (kind === 'solid') return 'graphite';
  if (kind === 'gradient') return 'aurora';
  return 'none';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function setTvBugStatus(status: TvBugStatus) {
  window.__televechaTvBugStatus = status;
  document.documentElement.dataset.tvbugStatus = status.state;
  if (status.message) document.documentElement.dataset.tvbugMessage = status.message;
  else delete document.documentElement.dataset.tvbugMessage;
}
