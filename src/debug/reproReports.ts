import {
  createReproManifest,
  createReproSanitizer,
  createTvBugBundle,
  type ReproStateSourceV1,
  type ReproTimelineEventV1,
} from './reproFormat';
import type { ReproTransportEvent, ReproTransportEventSink } from './reproTransport';
import { subscribeDiagnostics } from '../telegram/core/diagnostics';
import type { MessagingClient } from '../telegram/core/client';
import type { CacheCheckpoint, IndexedDbCacheStore } from '../telegram/persistence/store';
import type { TelegramTransport } from '../telegram/types';
import { createRecordingTelegramTransport } from './reproTransport';
import { readThemePreferences } from '../ui/theme/themePreferences';

const MAX_TIMELINE_EVENTS = 100_000;
const MAX_DIAGNOSTIC_EVENTS = 2_000;
const REPORT_MIME_TYPE = 'application/vnd.televecha.tvbug+zip';
const SIDEBAR_WIDTH_STORAGE_KEY = 'televecha:left-sidebar-width';
const DETAILS_OPEN_STORAGE_KEY = 'televecha:details-open';

interface StoredTimelineEvent {
  event: ReproTimelineEventV1;
  order: number;
}

export interface DebugReportPreview {
  compressedBytes: number;
  diagnosticCount: number;
  messageCount: number;
  timelineCount: number;
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
  private readonly sanitizer = createReproSanitizer({ sourceEpochMs: this.sourceEpochMs });
  private readonly checkpoint: Promise<CacheCheckpoint>;
  private readonly timeline: StoredTimelineEvent[] = [];
  private diagnosticCount = 0;
  private transportGeneration = 0;
  private order = 0;
  private truncated = false;
  private engine: MessagingClient | undefined;
  private readonly ignoredTransportCalls = new Map<string, number>();

  constructor(store: IndexedDbCacheStore) {
    this.checkpoint = store.captureCheckpoint().catch(() => {
      this.truncated = true;
      return emptyCheckpoint();
    });
    subscribeDiagnostics((diagnostic) => {
      if (this.diagnosticCount >= MAX_DIAGNOSTIC_EVENTS) {
        this.truncated = true;
        return;
      }
      try {
        this.append({
          seq: 0,
          tMs: this.elapsed(),
          kind: 'diagnostic',
          method: diagnostic.area,
          value: this.sanitizer.sanitizeValue(
            {
              level: diagnostic.level,
              message: diagnostic.message,
              details: diagnostic.details,
            },
            'diagnostic',
          ),
        });
        this.diagnosticCount += 1;
      } catch {
        this.append({
          seq: 0,
          tMs: this.elapsed(),
          kind: 'diagnostic',
          method: diagnostic.area,
          value: { level: diagnostic.level, message: 'redacted' },
        });
        this.diagnosticCount += 1;
      }
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
      value: { peerId: this.sanitizer.alias(peerAliasCategory(peerId), peerId) },
    });
  }

  recordComposerReply(peerId: string, messageId: number) {
    this.append({
      seq: 0,
      tMs: this.elapsed(),
      kind: 'ui',
      method: 'composer-reply',
      value: this.sanitizer.sanitizeValue({ peerId, messageId }, 'ui.composer-reply'),
    });
  }

  recordComposerSend(peerId: string, text: string) {
    this.append({
      seq: 0,
      tMs: this.elapsed(),
      kind: 'ui',
      method: 'composer-send',
      value: this.sanitizer.sanitizeValue({ peerId, text }, 'ui.composer-send'),
    });
  }

  recordComposerFocus(peerId: string, focused: boolean) {
    this.append({
      seq: 0,
      tMs: this.elapsed(),
      kind: 'ui',
      method: 'composer-focus',
      value: this.sanitizer.sanitizeValue({ peerId, focused }, 'ui.composer-focus'),
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
      value: this.sanitizer.sanitizeValue(
        { peerId, phase, sample, ...geometry },
        'ui.conversation-viewport',
      ),
    });
  }

  ignoreNextTransportCall(method: string) {
    this.ignoredTransportCalls.set(method, (this.ignoredTransportCalls.get(method) ?? 0) + 1);
  }

  wrapTransport(transport: TelegramTransport): TelegramTransport {
    const generation = `transport:${++this.transportGeneration}`;
    const sink: ReproTransportEventSink = {
      append: (event) => {
        const callId = event.callId ? `${generation}:${event.callId}` : undefined;
        this.append({
          ...event,
          seq: 0,
          tMs: this.elapsed(),
          ...(callId ? { callId } : {}),
        });
      },
    };
    return createRecordingTelegramTransport(transport, sink, {
      sanitizer: this.sanitizer,
      beforeInvoke: (method) =>
        method === 'connect' ? this.checkpoint.then(() => undefined) : undefined,
      onCaptureError: () => {
        this.truncated = true;
      },
      shouldRecord: (method) => {
        if (method === 'setTyping') return false;
        const remaining = this.ignoredTransportCalls.get(method) ?? 0;
        if (remaining === 0) return true;
        if (remaining === 1) this.ignoredTransportCalls.delete(method);
        else this.ignoredTransportCalls.set(method, remaining - 1);
        return false;
      },
    });
  }

  async prepare(): Promise<PreparedDebugReport> {
    const checkpoint = await this.checkpoint;
    const snapshot = this.engine?.snapshot();
    const stateSource: ReproStateSourceV1 = {
      cursor: checkpoint.cursor,
      epoch: checkpoint.epoch,
      lastPeerId: checkpoint.lastPeerId,
      dialogs: checkpoint.dialogs,
      messages: checkpoint.messages,
      drafts: checkpoint.drafts,
      draftRevisions: checkpoint.draftRevisions,
      pending: checkpoint.pending.map((pending) => ({ ...pending, accountId: undefined })),
      pinnedMessages: checkpoint.pinnedMessages,
      groupMembers: checkpoint.groupMembers,
      workspace: {
        phase: snapshot?.phase,
        sync: snapshot?.sync,
        online: snapshot?.online,
      },
      ui: captureUiState(snapshot?.activePeerId, this.bootstrapActivePeerId),
    };
    const state = this.sanitizer.sanitizeState(stateSource);
    const timeline = this.timeline
      .slice()
      .sort((left, right) => left.event.tMs - right.event.tMs || left.order - right.order)
      .map(({ event }, index) => ({ ...event, seq: index + 1 }));
    const manifest = createReproManifest({
      producer: { appVersion: '0.1.0' },
      capture: {
        durationMs: this.elapsed(),
        complete: !this.truncated,
        truncated: this.truncated,
        tabCount: 1,
      },
      environment: captureEnvironment(),
    });
    const bytes = createTvBugBundle({ manifest, state, timeline });
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
        timelineCount: timeline.length,
        truncated: this.truncated,
      },
    };
  }

  private append(event: ReproTimelineEventV1 | ReproTransportEvent) {
    if (this.timeline.length >= MAX_TIMELINE_EVENTS) {
      this.truncated = true;
      return;
    }
    this.timeline.push({ event, order: ++this.order });
  }

  private elapsed() {
    return Math.max(0, Math.round(performance.now() - this.startedAt));
  }
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

function peerAliasCategory(peerId: string) {
  return peerId.startsWith('u:') ? 'u' : peerId.startsWith('g:') ? 'g' : 'c';
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
