import {
  createTvBugManifest,
  createTvBugSanitizer,
  createTvBugBundle,
  type TvBugStateSourceV2,
  type TvBugTraceEventV2,
} from './tvbugFormat';
import { subscribeDiagnostics } from '../telegram/core/diagnostics';
import type { MessagingClient } from '../telegram/core/client';
import type { CacheCheckpoint, IndexedDbCacheStore } from '../telegram/persistence/store';
import type { EngineSnapshot, PendingSend, TelegramDialog } from '../telegram/types';
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

/**
 * Owns one browser session's account-free recording. Raw IndexedDB values are
 * held only long enough to synthesize the export and never enter the ZIP.
 */
export class BrowserDebugReportRecorder {
  private readonly startedAt = performance.now();
  private readonly sourceEpochMs = Math.floor(Date.now() / 1_000) * 1_000;
  private bootstrapActivePeerId = currentUrlPeerId();
  private readonly sanitizer = createTvBugSanitizer({ sourceEpochMs: this.sourceEpochMs });
  private readonly trace: StoredTraceEvent[] = [];
  private diagnosticCount = 0;
  private order = 0;
  private truncated = false;
  private engine: MessagingClient | undefined;

  constructor(private readonly store: IndexedDbCacheStore) {
    subscribeDiagnostics((diagnostic) => {
      this.append({
        seq: 0,
        tMs: this.elapsed(),
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
  }

  attachEngine(engine: MessagingClient) {
    this.engine = engine;
  }

  recordPeerSelection(peerId: string) {
    this.bootstrapActivePeerId ??= peerId;
    this.append({
      seq: 0,
      tMs: this.elapsed(),
      kind: 'ui',
      method: 'select-chat',
      value: { peerId },
    });
  }

  recordComposerReply(peerId: string, messageId: number) {
    this.append({
      seq: 0,
      tMs: this.elapsed(),
      kind: 'ui',
      method: 'composer-reply',
      value: { peerId, messageId },
    });
  }

  recordComposerSend(peerId: string, text: string) {
    this.append({
      seq: 0,
      tMs: this.elapsed(),
      kind: 'ui',
      method: 'composer-send',
      value: { peerId, text },
    });
  }

  recordComposerFocus(peerId: string, focused: boolean) {
    this.append({
      seq: 0,
      tMs: this.elapsed(),
      kind: 'ui',
      method: 'composer-focus',
      value: { peerId, focused },
    });
  }

  recordViewport(
    peerId: string,
    phase: 'before-send' | 'after-send',
    sample: number,
    geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
  ) {
    this.append({
      seq: 0,
      tMs: this.elapsed(),
      kind: 'ui',
      method: 'conversation-viewport',
      value: { peerId, phase, sample, ...geometry },
    });
  }

  async prepare(): Promise<PreparedDebugReport> {
    const checkpoint = await this.store.captureCheckpoint().catch(() => {
      this.truncated = true;
      return emptyCheckpoint();
    });
    const snapshot = this.engine?.snapshot();
    const activePeerId = snapshot?.activePeerId ?? checkpoint.lastPeerId;
    const sourceDialogs = snapshot?.dialogs ?? checkpoint.dialogs;
    const sourcePending = snapshot?.pending ?? checkpoint.pending;
    if (sourceDialogs.length > MAX_DIALOGS || sourcePending.length > MAX_PENDING_SENDS) {
      this.truncated = true;
    }
    const dialogs = limitDialogs(sourceDialogs, activePeerId);
    const messages = (
      snapshot?.messages ??
      checkpoint.messages.filter((message) => !activePeerId || message.peerId === activePeerId)
    ).slice(-MAX_ACTIVE_MESSAGES);
    if ((snapshot?.messages.length ?? checkpoint.messages.length) > messages.length) {
      this.truncated = true;
    }
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
      ui: captureUiState(snapshot?.activePeerId, this.bootstrapActivePeerId),
    };
    const state = this.sanitizer.sanitizeState(stateSource);
    const trace = this.trace
      .slice()
      .sort((left, right) => left.event.tMs - right.event.tMs || left.order - right.order)
      .map(({ event: { value, ...event } }, index): TvBugTraceEventV2 => ({
        ...event,
        seq: index + 1,
        ...(value !== undefined
          ? { value: this.sanitizeTraceValue(value, event.kind, event.method) }
          : {}),
      }));
    const manifest = createTvBugManifest({
      producer: {
        appVersion: packageMetadata.version,
        ...(import.meta.env.VITE_TELEVECHA_COMMIT
          ? { commit: import.meta.env.VITE_TELEVECHA_COMMIT }
          : {}),
      },
      capture: {
        durationMs: this.elapsed(),
        complete: !this.truncated,
        truncated: this.truncated,
        tabCount: 1,
      },
      environment: captureEnvironment(),
    });
    const bytes = createTvBugBundle({ manifest, snapshot: state, trace });
    const fingerprint = await shortDigest(bytes);
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const file = new File([ownedBuffer(bytes)], `televecha-${date}-${fingerprint}.tvbug`, {
      type: REPORT_MIME_TYPE,
    });
    return {
      file,
      preview: {
        compressedBytes: bytes.byteLength,
        diagnosticCount: this.diagnosticCount,
        messageCount: state.messages.length,
        traceCount: trace.length,
        truncated: this.truncated,
      },
    };
  }

  private append(event: StoredTraceEvent['event']) {
    if (event.kind === 'diagnostic' && this.diagnosticCount >= MAX_DIAGNOSTIC_EVENTS) {
      const oldestDiagnostic = this.trace.findIndex((stored) => stored.event.kind === 'diagnostic');
      if (oldestDiagnostic >= 0) {
        this.trace.splice(oldestDiagnostic, 1);
        this.diagnosticCount -= 1;
        this.truncated = true;
      }
    }
    if (this.trace.length >= MAX_TRACE_EVENTS) {
      const removed = this.trace.shift();
      if (removed?.event.kind === 'diagnostic') this.diagnosticCount -= 1;
      this.truncated = true;
    }
    this.trace.push({ event, order: ++this.order });
    if (event.kind === 'diagnostic') this.diagnosticCount += 1;
  }

  private sanitizeTraceValue(value: unknown, kind: string, method?: string) {
    try {
      return this.sanitizer.sanitizeValue(value, `trace.${kind}.${method ?? 'event'}`) ?? null;
    } catch {
      return { level: 'error', message: 'redacted' };
    }
  }

  private elapsed() {
    return Math.max(0, Math.round(performance.now() - this.startedAt));
  }
}

function compactRuntime(snapshot: EngineSnapshot) {
  const { dialogs, messages, drafts, pending, pinnedMessages, authStep, ...runtime } = snapshot;
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
  return {
    browser,
    ...(match ? { browserMajor: Number(match[1]) } : {}),
  };
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

async function shortDigest(bytes: Uint8Array) {
  if (!globalThis.crypto?.subtle) return String(bytes.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', ownedBuffer(bytes));
  return Array.from(new Uint8Array(digest).slice(0, 6), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}
