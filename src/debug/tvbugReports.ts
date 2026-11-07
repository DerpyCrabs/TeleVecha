import { Effect } from 'effect';

import {
  createTvBugManifest,
  createTvBugSanitizer,
  createTvBugBundle,
  type TvBugStateSourceV2,
  type TvBugTraceEventV2,
  type TvBugUiSourceV2,
} from './tvbugFormat';
import { captureTvBugRenderState, type TvBugChatAppearanceState } from './tvbugUiState';
import { LAYER } from '../telegram/mtproto/tl/types';
import { subscribeDiagnostics } from '../telegram/core/diagnostics';
import type { CacheCheckpoint, IndexedDbCacheStore } from '../telegram/persistence/store';
import type {
  EngineSnapshot,
  PendingSend,
  TelegramDialog,
  TelegramChatAppearance,
} from '../telegram/types';
import { readThemePreferences } from '../ui/theme/themePreferences';
import packageMetadata from '../../package.json';

const MAX_TRACE_EVENTS = 300;
const MAX_DIAGNOSTIC_EVENTS = 200;
const MAX_DIALOGS = 250;
const MAX_ACTIVE_MESSAGES = 500;
const MAX_PENDING_SENDS = 100;
const REPORT_MIME_TYPE = 'application/vnd.televecha.tvbug+zip';
const SIDEBAR_WIDTH_STORAGE_KEY = 'televecha:left-sidebar-width';
const DETAILS_OPEN_STORAGE_KEY = 'televecha:details-open';

interface StoredTraceEvent {
  event: Omit<TvBugTraceEventV2, 'value'> & { value?: unknown };
  order: number;
}

export interface DebugReportPreview {
  compressedBytes: number;
  diagnosticCount: number;
  messageCount: number;
  traceCount: number;
  truncated: boolean;
}

export interface PreparedDebugReport {
  file: File;
  preview: DebugReportPreview;
}

interface RecorderState {
  readonly bootstrapActivePeerId: string | undefined;
  readonly diagnosticCount: number;
  readonly engine: SnapshotSource | undefined;
  readonly order: number;
  readonly trace: readonly StoredTraceEvent[];
  readonly truncated: boolean;
}

interface SnapshotSource {
  snapshot(): EngineSnapshot;
}

function appendTrace(state: RecorderState, event: StoredTraceEvent['event']): RecorderState {
  let trace = state.trace;
  let diagnosticCount = state.diagnosticCount;
  let truncated = state.truncated;
  if (event.kind === 'diagnostic' && diagnosticCount >= MAX_DIAGNOSTIC_EVENTS) {
    const index = trace.findIndex((stored) => stored.event.kind === 'diagnostic');
    if (index >= 0) {
      trace = [...trace.slice(0, index), ...trace.slice(index + 1)];
      diagnosticCount -= 1;
      truncated = true;
    }
  }
  if (trace.length >= MAX_TRACE_EVENTS) {
    const [removed, ...remaining] = trace;
    trace = remaining;
    if (removed?.event.kind === 'diagnostic') diagnosticCount -= 1;
    truncated = true;
  }
  const order = state.order + 1;
  return {
    ...state,
    trace: [...trace, { event, order }],
    order,
    diagnosticCount: diagnosticCount + (event.kind === 'diagnostic' ? 1 : 0),
    truncated,
  };
}

/**
 * Owns one browser session's account-free recording. Raw IndexedDB values are
 * held only long enough to synthesize the export and never enter the ZIP.
 */
export function createBrowserDebugReportRecorder(store: IndexedDbCacheStore) {
  const startedAt = performance.now();
  let uiSource: (() => TvBugUiSourceV2) | undefined;
  let lastAppearance = '';
  let lastRuntime = '';
  const sanitizer = createTvBugSanitizer({ sourceEpochMs: Math.floor(Date.now() / 1_000) * 1_000 });
  let recorder: RecorderState = {
    bootstrapActivePeerId: currentUrlPeerId(),
    diagnosticCount: 0,
    engine: undefined,
    order: 0,
    trace: [],
    truncated: false,
  };
  const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
  const append = (event: StoredTraceEvent['event']) => {
    recorder = appendTrace(recorder, event);
  };
  const markTruncated = () => {
    if (!recorder.truncated) recorder = { ...recorder, truncated: true };
  };
  const recordUi = (method: string, value: unknown) =>
    append({ seq: 0, tMs: elapsed(), kind: 'ui', method, value });
  const sanitizeTraceValue = (value: unknown, kind: string, method?: string) => {
    try {
      return sanitizer.sanitizeValue(value, `trace.${kind}.${method ?? 'event'}`) ?? null;
    } catch {
      return { level: 'error', message: 'redacted' };
    }
  };

  const unsubscribeDiagnostics = subscribeDiagnostics((diagnostic) => {
    append({
      seq: 0,
      tMs: elapsed(),
      kind: 'diagnostic',
      method: diagnostic.area,
      value: {
        ...(diagnostic.code ? { code: diagnostic.code } : {}),
        level: diagnostic.level,
        message: diagnostic.message,
        details: diagnostic.details,
      },
    });
  });

  const prepare = Effect.fn('DebugReports.prepare')(function* () {
    const checkpoint = yield* store.captureCheckpoint().pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          markTruncated();
          return emptyCheckpoint();
        }),
      ),
    );
    const snapshot = recorder.engine?.snapshot();
    const ui = {
      ...captureUiState(snapshot?.activePeerId, recorder.bootstrapActivePeerId),
      ...uiSource?.(),
    };
    const render = captureTvBugRenderState();
    if (render?.mediaTruncated) markTruncated();
    if (ui.chatAppearance?.peerId) {
      const capturedAppearance = ui.chatAppearance;
      let metadataReadFailed = false;
      let wallpaperReadFailed = false;
      const metadata = yield* store
        .loadMetadata<TelegramChatAppearance | undefined>(
          `chat-appearance:${capturedAppearance.peerId}`,
        )
        .pipe(
          Effect.orElseSucceed(() => {
            metadataReadFailed = true;
            return undefined;
          }),
        );
      const currentWallpaper =
        capturedAppearance.value?.wallpaper ??
        capturedAppearance.value?.theme?.settings.find(
          ({ baseTheme }) => baseTheme === capturedAppearance.selectedBaseTheme,
        )?.wallpaper;
      const cachedWallpaper = currentWallpaper?.hasFile
        ? yield* store.loadBlob(`wallpaper:${currentWallpaper.id}`).pipe(
            Effect.orElseSucceed(() => {
              wallpaperReadFailed = true;
              return undefined;
            }),
          )
        : undefined;
      ui.chatAppearance = {
        ...capturedAppearance,
        cache: {
          ...(!metadataReadFailed ? { metadataPresent: Boolean(metadata) } : {}),
          ...(metadata ? { metadataAgeMs: Math.max(0, Date.now() - metadata.savedAt) } : {}),
          ...(currentWallpaper?.hasFile && !wallpaperReadFailed
            ? { wallpaperPresent: Boolean(cachedWallpaper) }
            : {}),
          ...(metadataReadFailed || wallpaperReadFailed ? { inspectionFailed: true } : {}),
        },
      };
    }
    const activePeerId = snapshot?.activePeerId ?? checkpoint.lastPeerId;
    const sourceDialogs = snapshot?.dialogs ?? checkpoint.dialogs;
    const sourcePending = snapshot?.pending ?? checkpoint.pending;
    if (sourceDialogs.length > MAX_DIALOGS || sourcePending.length > MAX_PENDING_SENDS) {
      markTruncated();
    }
    const dialogs = limitDialogs(sourceDialogs, activePeerId);
    const sourceMessages =
      snapshot?.messages ??
      checkpoint.messages.filter((message) => !activePeerId || message.peerId === activePeerId);
    const visibleIndex = sourceMessages.findIndex(
      ({ id }) => id === render?.viewport?.firstVisibleMessageId,
    );
    const start =
      visibleIndex < 0
        ? Math.max(0, sourceMessages.length - MAX_ACTIVE_MESSAGES)
        : Math.max(0, Math.min(visibleIndex - 100, sourceMessages.length - MAX_ACTIVE_MESSAGES));
    const messages = sourceMessages.slice(start, start + MAX_ACTIVE_MESSAGES);
    if (sourceMessages.length > messages.length) {
      markTruncated();
    }
    const captured = recorder;
    const drafts = activePeerId
      ? pickRecord(snapshot?.drafts ?? checkpoint.drafts, activePeerId)
      : {};
    const draftRevisions = activePeerId ? pickRecord(checkpoint.draftRevisions, activePeerId) : {};
    const pending = limitPending(sourcePending);
    const pinnedMessages =
      activePeerId && snapshot
        ? { [activePeerId]: { value: snapshot.pinnedMessages, savedAt: Date.now() } }
        : activePeerId
          ? pickRecord(checkpoint.pinnedMessages, activePeerId)
          : {};
    const groupMembers = activePeerId ? pickRecord(checkpoint.groupMembers, activePeerId) : {};
    const stateSource: TvBugStateSourceV2 = {
      cursor: checkpoint.cursor,
      epoch: checkpoint.epoch,
      lastPeerId: checkpoint.lastPeerId,
      dialogs,
      messages,
      drafts,
      draftRevisions,
      pending: pending.map((item) => ({ ...item, accountId: undefined })),
      pinnedMessages,
      groupMembers,
      workspace: {
        activePeerId,
        phase: snapshot?.phase,
        sync: snapshot?.sync,
        online: snapshot?.online,
      },
      runtime: snapshot ? compactRuntime(snapshot) : {},
      ui: { ...ui, ...(render ? { render } : {}) },
    };
    const state = sanitizer.sanitizeState(stateSource);
    const trace = captured.trace
      .slice()
      .sort((left, right) => left.event.tMs - right.event.tMs || left.order - right.order)
      .map(({ event: { value, ...event } }, index): TvBugTraceEventV2 => ({
        ...event,
        seq: index + 1,
        ...(value !== undefined
          ? { value: sanitizeTraceValue(value, event.kind, event.method) }
          : {}),
      }));
    const manifest = createTvBugManifest({
      producer: {
        appVersion: packageMetadata.version,
        telegramLayer: LAYER,
        ...(typeof import.meta.env.VITE_TELEVECHA_SOURCE_MODIFIED === 'boolean'
          ? { sourceModified: import.meta.env.VITE_TELEVECHA_SOURCE_MODIFIED }
          : {}),
        ...(import.meta.env.VITE_TELEVECHA_COMMIT
          ? { commit: String(import.meta.env.VITE_TELEVECHA_COMMIT) }
          : {}),
      },
      capture: {
        durationMs: elapsed(),
        complete: !captured.truncated,
        truncated: captured.truncated,
        tabCount: 1,
      },
      environment: captureEnvironment(),
      coverage: {
        mode: 'snapshot',
        uiState: Boolean(uiSource),
        chatAppearance: Boolean(ui.chatAppearance),
        renderState: Boolean(render),
        media: 'synthetic',
        networkReplay: false,
        scope: 'current-tab',
        omissions: [
          'original-media-bytes',
          'network-and-cache-transition-replay',
          'other-tabs',
          'complete-ui-interaction-history',
          'history-outside-capture-window',
          ...(!import.meta.env.VITE_TELEVECHA_COMMIT ? ['build-commit'] : []),
        ],
      },
    });
    const bytes = createTvBugBundle({ manifest, snapshot: state, trace });
    const fingerprint = yield* shortDigest(bytes);
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const file = new File([ownedBuffer(bytes)], `televecha-${date}-${fingerprint}.tvbug`, {
      type: REPORT_MIME_TYPE,
    });
    return {
      file,
      preview: {
        compressedBytes: bytes.byteLength,
        diagnosticCount: captured.diagnosticCount,
        messageCount: state.messages.length,
        traceCount: trace.length,
        truncated: captured.truncated,
      },
    };
  });

  return {
    dispose() {
      unsubscribeDiagnostics();
      uiSource = undefined;
    },
    attachUi(source: () => TvBugUiSourceV2) {
      uiSource = source;
      return () => {
        if (uiSource === source) uiSource = undefined;
      };
    },
    recordChatAppearance(value: TvBugChatAppearanceState) {
      const summary = {
        peerId: value.peerId,
        phase: value.appearance.phase,
        waiting: value.appearance.waiting,
        hasValue: value.appearance.hasValue,
        wallpaper: value.wallpaper,
        pattern: value.pattern,
      };
      const serialized = JSON.stringify(summary);
      if (serialized === lastAppearance) return;
      lastAppearance = serialized;
      recordUi('chat-appearance-state', summary);
    },
    recordRuntime(value: {
      phase: string;
      sync: string;
      online: boolean;
      activePeerId?: string | undefined;
    }) {
      const serialized = JSON.stringify(value);
      if (serialized === lastRuntime) return;
      lastRuntime = serialized;
      recordUi('runtime-state', value);
    },
    attachEngine(engine: SnapshotSource) {
      recorder = { ...recorder, engine };
    },
    recordPeerSelection(peerId: string) {
      recorder = { ...recorder, bootstrapActivePeerId: recorder.bootstrapActivePeerId ?? peerId };
      recordUi('select-chat', { peerId });
    },
    recordComposerReply: (peerId: string, messageId: number) =>
      recordUi('composer-reply', { peerId, messageId }),
    recordComposerSend: (peerId: string, text: string) =>
      recordUi('composer-send', { peerId, text }),
    recordComposerFocus: (peerId: string, focused: boolean) =>
      recordUi('composer-focus', { peerId, focused }),
    recordViewport(
      peerId: string,
      phase: 'before-send' | 'after-send',
      sample: number,
      geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
    ) {
      recordUi('conversation-viewport', { peerId, phase, sample, ...geometry });
    },
    prepare,
  };
}

export type BrowserDebugReportRecorder = ReturnType<typeof createBrowserDebugReportRecorder>;

function compactRuntime(snapshot: EngineSnapshot) {
  const {
    dialogs,
    messages,
    drafts,
    pending,
    pinnedMessages,
    authStep,
    qrLogin: _qrLogin,
    ...runtime
  } = snapshot;
  return {
    ...runtime,
    ...(authStep ? { loginStep: authStep } : {}),
    dialogCount: dialogs.length,
    activeMessageCount: messages.length,
    draftCount: Object.values(drafts).filter(Boolean).length,
    pendingCount: pending.length,
    pinnedMessageCount: pinnedMessages.length,
  };
}

function limitDialogs(dialogs: readonly TelegramDialog[], activePeerId?: string) {
  if (dialogs.length <= MAX_DIALOGS) return dialogs;
  const limited = dialogs.slice(0, MAX_DIALOGS);
  const active = activePeerId && dialogs.find((dialog) => dialog.peer.id === activePeerId);
  if (active && !limited.some((dialog) => dialog.peer.id === activePeerId)) {
    limited[limited.length - 1] = active;
  }
  return limited;
}

function limitPending(pending: readonly PendingSend[]) {
  if (pending.length <= MAX_PENDING_SENDS) return pending;
  const failed = pending.filter((item) => item.lastError);
  const healthy = pending.filter((item) => !item.lastError);
  return [...failed, ...healthy].slice(0, MAX_PENDING_SENDS);
}

function pickRecord<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return key in record ? { [key]: record[key]! } : {};
}

function emptyCheckpoint(): CacheCheckpoint {
  return {
    dialogs: [],
    draftRevisions: {},
    drafts: {},
    epoch: 0,
    groupMembers: {},
    messages: [],
    pending: [],
    pinnedMessages: {},
  };
}

function captureUiState(engineActivePeerId?: string, bootstrapActivePeerId?: string) {
  const preferences = readThemePreferences();
  const url = new URL(window.location.href);
  const activePeerId = engineActivePeerId ?? url.searchParams.get('chat') ?? undefined;
  const sidebarWidth = readNumber(SIDEBAR_WIDTH_STORAGE_KEY);
  const detailsOpen = readBoolean(DETAILS_OPEN_STORAGE_KEY);
  return {
    route: url.pathname,
    ...(bootstrapActivePeerId ? { bootstrapActivePeerId } : {}),
    ...(activePeerId ? { activePeerId } : {}),
    ...(sidebarWidth !== undefined ? { sidebarWidth } : {}),
    ...(detailsOpen !== undefined ? { detailsOpen } : {}),
    appearance: {
      themeId: preferences.theme,
      chatFontSize: preferences.chatFontSize,
      wallpaperKind: wallpaperKind(preferences.wallpaper),
      blur: preferences.wallpaperBlur,
      dim: preferences.wallpaperDim,
      accentColor: preferences.accentColor,
      preferences,
    },
  };
}

function currentUrlPeerId() {
  try {
    return new URL(window.location.href).searchParams.get('chat') ?? undefined;
  } catch {
    return undefined;
  }
}

function captureEnvironment() {
  const browser = browserDetails(navigator.userAgent);
  return {
    ...browser,
    viewport: [window.innerWidth, window.innerHeight] as const,
    deviceScaleFactor: window.devicePixelRatio,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches
      ? ('dark' as const)
      : ('light' as const),
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}

function browserDetails(userAgent: string) {
  const match = userAgent.match(/(?:Edg|Chrome|Firefox|Version)\/(\d+)/u);
  const browser = /Edg\//u.test(userAgent)
    ? 'Edge'
    : /Firefox\//u.test(userAgent)
      ? 'Firefox'
      : /Chrome\//u.test(userAgent)
        ? 'Chrome'
        : /Safari\//u.test(userAgent)
          ? 'Safari'
          : 'Unknown';
  return { browser, ...(match ? { browserMajor: Number(match[1]) } : {}) };
}

function wallpaperKind(value: string): 'none' | 'solid' | 'gradient' | 'pattern' | 'image' {
  if (value === 'none') return 'none';
  if (value === 'doodles') return 'pattern';
  if (value === 'graphite') return 'solid';
  if (value === 'custom' || value === 'telegram') return 'image';
  return 'gradient';
}

function readNumber(key: string) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function readBoolean(key: string) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? undefined : value !== 'false';
  } catch {
    return undefined;
  }
}

const shortDigest = (bytes: Uint8Array) =>
  globalThis.crypto?.subtle
    ? Effect.tryPromise({
        try: () => crypto.subtle.digest('SHA-256', ownedBuffer(bytes)),
        catch: (cause) => cause,
      }).pipe(
        Effect.map((digest) =>
          Array.from(new Uint8Array(digest).slice(0, 6), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join(''),
        ),
      )
    : Effect.succeed(String(bytes.byteLength));

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}
