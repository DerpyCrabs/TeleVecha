import { hydrateReproState, type ReproBundleV1, type ReproStateV1 } from './reproFormat';
import { createReplayTelegramTransport, createReproPlaceholder } from './reproTransport';
import { MessagingEngine } from '../telegram/core/engine';
import { MemoryCacheStore } from '../telegram/persistence/memoryStore';
import type { TelegramDialog, TelegramMessage } from '../telegram/types';
import {
  DEFAULT_THEME_PREFERENCES,
  saveThemePreferences,
  type ThemePresetId,
  type WallpaperId,
} from '../ui/theme/themePreferences';

const SIDEBAR_WIDTH_STORAGE_KEY = 'televecha:left-sidebar-width';
const DETAILS_OPEN_STORAGE_KEY = 'televecha:details-open';
const REPLAY_COMPLETION_GRACE_MS = 2_000;
const REPRO_THEMES = new Set<ThemePresetId>(['classic', 'day', 'night', 'tinted']);
let replaySequence = 0;
let replayTransportComplete = false;
let replayUiComplete = false;
let replayCompletionTimer: ReturnType<typeof setTimeout> | undefined;
const sequenceWaiters = new Set<{ sequence: number; resolve(): void }>();

export type ReproStatus = {
  state: 'loading' | 'ready' | 'diverged' | 'error';
  message?: string | undefined;
};

declare global {
  interface Window {
    __televechaReproBundle?: ReproBundleV1 | undefined;
    __televechaReproStatus?: ReproStatus | undefined;
  }
}

export function injectedReproBundle() {
  return window.__televechaReproBundle;
}

export function createReproEngine(bundle: ReproBundleV1) {
  setReproStatus({ state: 'loading' });
  replaySequence = 0;
  replayTransportComplete = false;
  replayUiComplete = false;
  if (replayCompletionTimer) clearTimeout(replayCompletionTimer);
  replayCompletionTimer = undefined;
  sequenceWaiters.clear();
  try {
    const hydrated = hydrateReproState(bundle.state);
    const store = new MemoryCacheStore(
      {
        ...hydrated.workspace,
        cursor: hydrated.cursor,
        messages: hydrated.messages,
      },
      { replay: true },
    );
    let engine: MessagingEngine | undefined;
    let stoppingAfterMismatch = false;
    const transport = createReplayTelegramTransport(bundle.timeline, {
      timeScale: 0,
      onMismatch: (error) => {
        if (window.__televechaReproStatus?.state !== 'diverged') {
          setReproStatus({ state: 'diverged', message: error.message });
        }
        if (stoppingAfterMismatch) return;
        stoppingAfterMismatch = true;
        queueMicrotask(() => void engine?.stop().catch(() => undefined));
      },
      onEvent: (event) => advanceReplaySequence(event.seq),
      onComplete: () => {
        replayTransportComplete = true;
        finishReproReplayIfComplete();
      },
    });
    engine = new MessagingEngine(transport, store, { manageTabLease: false });
    seedReproAssetCache(store, engine, hydrated.dialogs, hydrated.messages, bundle.timeline);
    engine.subscribe((snapshot) => {
      const message = snapshot.error ?? snapshot.operationError;
      if (message && isDivergence(message)) {
        setReproStatus({ state: 'diverged', message });
      } else if (snapshot.phase === 'error') {
        setReproStatus({ state: 'error', message: message ?? 'Replay failed to start.' });
      }
    });
    return engine;
  } catch (error) {
    const message = errorMessage(error);
    setReproStatus({ state: 'error', message });
    throw error;
  }
}

function seedReproAssetCache(
  store: MemoryCacheStore,
  engine: MessagingEngine,
  dialogs: readonly TelegramDialog[],
  messages: readonly TelegramMessage[],
  timeline: ReproBundleV1['timeline'],
) {
  const recordedMedia = recordedAssetIds(timeline, 'downloadMedia', true);
  const recordedAvatars = recordedAssetIds(timeline, 'downloadAvatar', false);

  for (const message of messages) {
    if (!message.media && !message.linkPreview?.hasPhoto) continue;
    if (recordedMedia.has(`${message.peerId}\0${message.id}`)) continue;
    const media = message.media;
    const previewSize = message.linkPreview?.photoSize === 'small' ? 96 : 640;
    void store.saveBlob(
      engine.mediaAssetKey(message),
      createReproPlaceholder({
        byteSize: media?.size ?? 4_096,
        mimeType: media?.mimeType ?? 'image/svg+xml',
        width: media?.width ?? previewSize,
        height: media?.height ?? (message.linkPreview?.photoSize === 'small' ? 96 : 360),
        mediaKind: media?.kind ?? 'photo',
      }),
    );
  }

  for (const dialog of dialogs) {
    if (!dialog.hasAvatar || recordedAvatars.has(dialog.peer.id)) continue;
    void store.saveBlob(
      `avatar:${dialog.peer.id}:${dialog.avatarId ?? 'unknown'}`,
      createReproPlaceholder({
        byteSize: 1_024,
        mimeType: 'image/svg+xml',
        width: 96,
        height: 96,
        mediaKind: 'photo',
      }),
    );
  }
}

function recordedAssetIds(
  timeline: ReproBundleV1['timeline'],
  method: 'downloadMedia' | 'downloadAvatar',
  includeMessageId: boolean,
) {
  const result = new Set<string>();
  for (const event of timeline) {
    if (event.kind !== 'call' || event.method !== method || !Array.isArray(event.args)) continue;
    const argument = event.args[0];
    if (!argument || Array.isArray(argument) || typeof argument !== 'object') continue;
    const id = argument.id;
    if (method === 'downloadMedia') {
      const peerId = argument.peerId;
      if (typeof peerId === 'string' && typeof id === 'number') {
        result.add(includeMessageId ? `${peerId}\0${id}` : peerId);
      }
    } else if (typeof id === 'string') {
      result.add(id);
    }
  }
  return result;
}

export function completeReproReplay() {
  replayUiComplete = true;
  finishReproReplayIfComplete();
  if (!replayTransportComplete && !replayCompletionTimer) {
    replayCompletionTimer = setTimeout(() => {
      replayCompletionTimer = undefined;
      if (window.__televechaReproStatus?.state === 'loading') {
        setReproStatus({
          state: 'diverged',
          message: `Replay stopped after event ${replaySequence} before consuming the recorded transport timeline.`,
        });
      }
    }, REPLAY_COMPLETION_GRACE_MS);
  }
}

export function waitForReproSequence(sequence: number) {
  if (replaySequence >= sequence) return Promise.resolve();
  return new Promise<void>((resolve) => sequenceWaiters.add({ sequence, resolve }));
}

/** Applies only allowlisted visual state; the injected bundle never controls arbitrary storage. */
export function applyReproUiState(state: ReproStateV1) {
  const ui = state.ui;
  if (!ui) return;
  const appearance = ui.appearance;
  if (appearance) {
    const requestedTheme = appearance.themeId as ThemePresetId | undefined;
    const theme = requestedTheme && REPRO_THEMES.has(requestedTheme) ? requestedTheme : 'night';
    saveThemePreferences({
      ...DEFAULT_THEME_PREFERENCES,
      theme,
      accentColor: appearance.accentColor ?? DEFAULT_THEME_PREFERENCES.accentColor,
      wallpaper: replayWallpaper(appearance.wallpaperKind),
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
    // Replay still works when browser storage is disabled.
  }
  const activePeerId = ui.bootstrapActivePeerId ?? state.lastPeerId;
  const url = new URL(window.location.href);
  if (ui.route?.startsWith('/')) url.pathname = ui.route;
  url.searchParams.set('repro', '1');
  if (activePeerId) url.searchParams.set('chat', activePeerId);
  window.history.replaceState({}, '', url);
}

function setReproStatus(status: ReproStatus) {
  window.__televechaReproStatus = status;
  document.documentElement.dataset.reproStatus = status.state;
  if (status.message) document.documentElement.dataset.reproMessage = status.message;
  else delete document.documentElement.dataset.reproMessage;
}

function finishReproReplayIfComplete() {
  const current = window.__televechaReproStatus;
  if (replayTransportComplete && replayUiComplete && (!current || current.state === 'loading')) {
    if (replayCompletionTimer) clearTimeout(replayCompletionTimer);
    replayCompletionTimer = undefined;
    setReproStatus({ state: 'ready' });
  }
}

function advanceReplaySequence(sequence: number) {
  replaySequence = Math.max(replaySequence, sequence);
  for (const waiter of sequenceWaiters) {
    if (waiter.sequence > replaySequence) continue;
    sequenceWaiters.delete(waiter);
    waiter.resolve();
  }
}

function replayWallpaper(
  kind: NonNullable<NonNullable<ReproStateV1['ui']>['appearance']>['wallpaperKind'],
): WallpaperId {
  if (kind === 'pattern') return 'doodles';
  if (kind === 'solid') return 'graphite';
  if (kind === 'gradient') return 'aurora';
  return 'none';
}

function isDivergence(message: string) {
  return /replay divergence|unexpected .*transport event|recorded transport/iu.test(message);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
