import {
  sanitizeMessageContentDiagnostic,
  type MessageContentDiagnostic,
} from '../telegram/core/messageContentDiagnostic';
import { Data } from 'effect';
import { Inflate, strToU8, zipSync } from 'fflate';

import type { RichBlock, RichMessage, RichText } from '../domain/richMessage';
import type { ThemePreferences } from '../ui/theme/themePreferences';
import { normalizeThemePreferences } from '../ui/theme/themePreferences';
import type {
  TvBugChatAppearanceState,
  TvBugRenderState,
  TvBugResourceState,
} from './tvbugUiState';
import type {
  CachedDialog,
  CachedMessage,
  PendingSend,
  SyncCursor,
  TelegramBotKeyboard,
  TelegramDialog,
  TelegramGroupMember,
  TelegramLink,
  TelegramLinkPreview,
  TelegramMedia,
  TelegramMention,
  TelegramMessage,
  TelegramPeer,
  TelegramReaction,
  TelegramServiceMessage,
  TelegramTextFormat,
  TelegramChatAppearance,
  TelegramWallpaper,
} from '../telegram/types';

export const TVBUG_FORMAT = 'televecha-debug' as const;
export const TVBUG_VERSION = 2 as const;
export const TVBUG_FIXED_EPOCH_SECONDS = 1_577_836_800;

const MANIFEST_FILE = 'manifest.json';
const SNAPSHOT_FILE = 'snapshot.v2.json';
const TRACE_FILE = 'trace.v2.ndjson';
const REQUIRED_FILES = new Set([MANIFEST_FILE, SNAPSHOT_FILE, TRACE_FILE]);
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_TRACE_BYTES = 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_COLLECTION_ITEMS = 100_000;
const MAX_TRACE_EVENTS = 300;
const MAX_TEXT_UTF16_LENGTH = 2_000_000;
const MAX_SYNTHETIC_ATTACHMENT_BYTES = 256 * 1024 * 1024;
const MAX_CALLBACK_DATA_LENGTH = 1024 * 1024;
const ZIP_CHUNK_BYTES = 4 * 1024;
const ZIP_END_SIGNATURE = 0x0605_4b50;
const ZIP_CENTRAL_SIGNATURE = 0x0201_4b50;
const ZIP_LOCAL_SIGNATURE = 0x0403_4b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_MTIME = new Date('2020-01-01T00:00:00.000Z');
const SAFE_THEME_IDS = new Set(['classic', 'day', 'night', 'tinted']);
const CRC32_TABLE = createCrc32Table();
const SAFE_SEMANTIC_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  area: new Set(['auth', 'sync', 'transport', 'cache', 'outbox', 'coordination']),
  align: new Set(['left', 'center', 'right']),
  basetheme: new Set(['classic', 'day', 'night', 'tinted', 'arctic']),
  category: new Set(['user', 'bot', 'group', 'channel']),
  direction: new Set(['inbox', 'outbox']),
  kind: new Set([
    'user',
    'group',
    'channel',
    'photo',
    'image',
    'video',
    'round-video',
    'voice',
    'animation',
    'sticker',
    'file',
    'text',
    'url',
    'url-auth',
    'callback',
    'copy',
    'switch-inline',
    'unsupported',
    'inline',
    'reply',
    'chat-created',
    'title-changed',
    'photo-changed',
    'photo-removed',
    'users-added',
    'user-removed',
    'joined-by-link',
    'joined-by-request',
    'message-pinned',
    'history-cleared',
    'auto-delete-changed',
    'topic-created',
    'topic-changed',
    'screenshot-taken',
    'custom',
    'other',
    'default',
    'accepted',
    'request',
    'bold',
    'italic',
    'underline',
    'strike',
    'code',
    'pre',
    'spoiler',
    'blockquote',
    'expandableBlockquote',
    'mention',
    'mentionName',
    'textUrl',
    'customEmoji',
    'formattedDate',
    'diffInsert',
    'diffReplace',
    'diffDelete',
    'typing',
    'uploading',
    'recording',
    'choosing-sticker',
    'photos',
    'videos',
    'files',
    'audio',
    'links',
    'gifs',
    'stickers',
    'all',
    'expressions',
    'bot-commands',
    'group-members',
    'peer-metadata',
    'concat',
    'link',
    'anchor',
    'math',
    'date',
    'subscript',
    'superscript',
    'marked',
    'diff',
    'heading',
    'divider',
    'list',
    'quote',
    'details',
    'table',
    'media',
    'author',
  ]),
  level: new Set(['debug', 'info', 'warn', 'error']),
  mediakind: new Set(['photo', 'video', 'audio', 'embed', 'map']),
  mode: new Set(['cover', 'collage', 'slideshow']),
  phase: new Set([
    'idle',
    'connecting',
    'unauthorized',
    'syncing',
    'ready',
    'error',
    'call',
    'resolve',
    'push',
    'loading',
    'before-send',
    'after-send',
  ]),
  pattern: new Set(['none', 'normal', 'inverted']),
  source: new Set(['none', 'blob', 'data', 'external']),
  focusedcontrol: new Set(['composer', 'other', 'none']),
  photosize: new Set(['small', 'large']),
  presence: new Set(['online', 'recently', 'offline']),
  role: new Set([
    'title',
    'subtitle',
    'header',
    'subheader',
    'paragraph',
    'footer',
    'kicker',
    'thinking',
  ]),
  rolekind: new Set(['owner', 'admin']),
  sendas: new Set(['media', 'file']),
  sync: new Set(['current', 'recovering', 'stale']),
  wallpaperkind: new Set(['none', 'solid', 'gradient', 'pattern', 'image']),
  type: new Set([
    'new-message',
    'edit-message',
    'delete-messages',
    'read-history',
    'dialog-changed',
    'reaction-changed',
    'activity',
    'activity-ended',
    'presence-changed',
    'mute-changed',
    'dialog-pinned',
    'expression-index-changed',
    'pinned-messages',
    'dialog-folders-changed',
    'bot-commands-changed',
    'pts-advanced',
    'dialog-list-invalidated',
    'peer-metadata-changed',
    'channel-too-long',
    'connection-state',
    'too-long',
    'complete',
    'default',
    'accepted',
    'request',
    'tvbug-undefined',
    'tvbug-binary',
    'tvbug-file',
    'tvbug-bigint',
    'tvbug-number',
    'tvbug-redacted',
    'tvbug-function',
    'tvbug-cycle',
    'secret-connect',
    'secret-requestcode',
    'secret-submitcode',
    'secret-submitpassword',
  ]),
  verticalalign: new Set(['top', 'middle', 'bottom']),
};

const FORBIDDEN_KEYS = new Set(
  [
    'accesshash',
    'apikey',
    'apihash',
    'auth',
    'authkey',
    'blob',
    'bytes',
    'credential',
    'credentials',
    'filereference',
    'password',
    'phone',
    'phonenumber',
    'raw',
    'session',
    'token',
  ].map(normalizeKey),
);

export interface TvBugTextMetricsV2 {
  utf16Length: number;
  graphemeCount: number;
  lineCount: number;
  lineUtf16Lengths: number[];
}

export interface TvBugTextV2 {
  value: string;
  metrics: TvBugTextMetricsV2;
}

export interface TvBugManifestV2 {
  format: typeof TVBUG_FORMAT;
  version: typeof TVBUG_VERSION;
  producer: {
    appVersion: string;
    commit?: string | undefined;
    telegramLayer?: number | undefined;
    sourceModified?: boolean | undefined;
  };
  capture: { durationMs: number; complete: boolean; truncated: boolean; tabCount: number };
  /** Describes reproduction coverage separately from whether bounded capture completed. */
  coverage?:
    | {
        mode: 'snapshot';
        uiState: boolean;
        chatAppearance: boolean;
        renderState: boolean;
        media: 'synthetic';
        networkReplay: false;
        scope: 'current-tab';
        omissions: string[];
      }
    | undefined;
  environment?: {
    browser?: string | undefined;
    browserMajor?: number | undefined;
    viewport?: readonly [number, number] | undefined;
    deviceScaleFactor?: number | undefined;
    locale?: string | undefined;
    timezone?: string | undefined;
    timezoneOffsetMinutes?: number | undefined;
    colorScheme?: 'light' | 'dark' | undefined;
    reducedMotion?: boolean | undefined;
  };
  privacy: {
    profile: 'account-free-v2';
    rawText: false;
    rawMedia: false;
    stableIdentifiers: false;
    authMaterial: false;
  };
}

export interface TvBugPeerV2 {
  id: string;
  kind: TelegramPeer['kind'];
}

export interface TvBugMediaV2 {
  spoiler?: boolean | undefined;
  kind: TelegramMedia['kind'];
  name: TvBugTextV2;
  mimeType: string;
  byteSize?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  duration?: number | undefined;
  cacheKey?: string | undefined;
}

export interface TvBugTextFormatV2 {
  userId?: string | undefined;
  offset: number;
  length: number;
  kind: TelegramTextFormat['kind'];
  url?: string | undefined;
  customEmojiId?: string | undefined;
  timestamp?: number | undefined;
  oldText?: TvBugTextV2 | undefined;
}

export interface TvBugMessageV2 {
  savedPeerId?: string | undefined;
  topicId?: number | undefined;
  reactionsAsTags?: boolean | undefined;
  protected?: boolean | undefined;
  unreadReaction?: boolean | undefined;
  unreadMention?: boolean | undefined;
  mediaUnread?: boolean | undefined;
  id: number;
  peerId: string;
  senderId: string;
  senderName?: TvBugTextV2 | undefined;
  senderHasAvatar?: boolean | undefined;
  senderAvatarId?: string | undefined;
  senderColor?: string | undefined;
  senderColorVersion?: number | undefined;
  senderRole?: TvBugTextV2 | undefined;
  senderRoleKind?: 'owner' | 'admin' | undefined;
  text: string;
  textMetrics: TvBugTextMetricsV2;
  date: number;
  outgoing: boolean;
  editedAt?: number | undefined;
  replyToId?: number | undefined;
  replyQuote?: TvBugTextV2 | undefined;
  randomId?: string | undefined;
  groupedId?: string | undefined;
  forwardedFrom?: {
    name: TvBugTextV2;
    peerId?: string | undefined;
    messageId?: number | undefined;
    hasAvatar?: boolean | undefined;
    avatarId?: string | undefined;
    color?: string | undefined;
  };
  service?: TvBugServiceMessageV2 | undefined;
  botKeyboard?: TvBugBotKeyboardV2 | undefined;
  media?: TvBugMediaV2 | undefined;
  reactions?: TvBugReactionV2[] | undefined;
  mentions?: TvBugMentionV2[] | undefined;
  links?: TvBugLinkV2[] | undefined;
  linkPreview?: TvBugLinkPreviewV2 | undefined;
  formats?: TvBugTextFormatV2[] | undefined;
  richMessage?: TvBugRichMessageV2 | undefined;
  contentDiagnostic?: MessageContentDiagnostic | undefined;
  widget?: { width: number; height: number; isCopy: boolean } | undefined;
  pinned?: boolean | undefined;
  cacheEpoch?: number | undefined;
}

export type TvBugRichTextV2 =
  | { kind: 'button'; child: TvBugRichTextV2; button: TvBugBotKeyboardV2['rows'][number][number] }
  | { kind: 'text'; text: TvBugTextV2 }
  | { kind: 'concat'; children: TvBugRichTextV2[] }
  | {
      kind:
        | 'bold'
        | 'italic'
        | 'underline'
        | 'strike'
        | 'code'
        | 'subscript'
        | 'superscript'
        | 'marked'
        | 'spoiler'
        | 'diff';
      child: TvBugRichTextV2;
      oldText?: TvBugRichTextV2 | undefined;
    }
  | { kind: 'link'; child: TvBugRichTextV2; url: string }
  | { kind: 'anchor'; child: TvBugRichTextV2; name: TvBugTextV2 }
  | { kind: 'customEmoji'; alt: TvBugTextV2; documentId: string }
  | { kind: 'math'; source: TvBugTextV2 }
  | { kind: 'date'; child: TvBugRichTextV2; timestamp: number };

export type TvBugRichBlockV2 =
  | {
      kind: 'buttons';
      buttons: TvBugBotKeyboardV2['rows'][number];
      align: 'left' | 'center' | 'right';
    }
  | { kind: 'text'; role: Extract<RichBlock, { kind: 'text' }>['role']; text: TvBugRichTextV2 }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: TvBugRichTextV2 }
  | { kind: 'pre'; text: TvBugRichTextV2; language?: TvBugTextV2 | undefined }
  | { kind: 'divider' }
  | { kind: 'anchor'; name: TvBugTextV2 }
  | {
      kind: 'list';
      ordered: boolean;
      reversed?: boolean | undefined;
      start?: number | undefined;
      items: Array<{
        text?: TvBugRichTextV2 | undefined;
        blocks?: TvBugRichBlockV2[] | undefined;
        checked?: boolean | undefined;
        checkbox?: boolean | undefined;
        marker?: TvBugTextV2 | undefined;
        value?: number | undefined;
      }>;
    }
  | {
      kind: 'quote';
      blocks: TvBugRichBlockV2[];
      caption?: TvBugRichTextV2 | undefined;
      pull?: boolean | undefined;
      expandable?: boolean | undefined;
    }
  | {
      kind: 'details';
      title: TvBugRichTextV2;
      blocks: TvBugRichBlockV2[];
      open?: boolean | undefined;
    }
  | {
      kind: 'table';
      title?: TvBugRichTextV2 | undefined;
      rows: Array<
        Array<{
          text?: TvBugRichTextV2 | undefined;
          header?: boolean | undefined;
          align?: 'left' | 'center' | 'right' | undefined;
          verticalAlign?: 'top' | 'middle' | 'bottom' | undefined;
          colSpan?: number | undefined;
          rowSpan?: number | undefined;
        }>
      >;
      bordered?: boolean | undefined;
      compact?: boolean | undefined;
      striped?: boolean | undefined;
    }
  | { kind: 'math'; source: TvBugTextV2 }
  | {
      kind: 'media';
      mediaKind: 'photo' | 'video' | 'audio' | 'embed' | 'map' | 'file';
      attachment?: TvBugMediaV2 | undefined;
      id?: string | undefined;
      url?: string | undefined;
      caption?: { text: TvBugRichTextV2; credit?: TvBugRichTextV2 | undefined };
      spoiler?: boolean | undefined;
    }
  | {
      kind: 'group';
      mode: 'cover' | 'collage' | 'slideshow';
      blocks: TvBugRichBlockV2[];
      caption?: { text: TvBugRichTextV2; credit?: TvBugRichTextV2 | undefined };
    }
  | { kind: 'author'; author: TvBugRichTextV2; publishedAt: number };

export interface TvBugRichMessageV2 {
  blocks: TvBugRichBlockV2[];
  rtl?: boolean | undefined;
  partial?: boolean | undefined;
}

export interface TvBugReactionV2 {
  emoji: TvBugTextV2;
  customEmojiId?: string | undefined;
  count: number;
  chosen: boolean;
}

export interface TvBugMentionV2 {
  offset: number;
  length: number;
  userId?: string | undefined;
}

export interface TvBugLinkV2 {
  offset: number;
  length: number;
  url?: string | undefined;
}

export interface TvBugLinkPreviewV2 {
  url: string;
  type?: string | undefined;
  hasEmbed?: boolean | undefined;
  siteName?: TvBugTextV2 | undefined;
  title?: TvBugTextV2 | undefined;
  description?: TvBugTextV2 | undefined;
  hasPhoto?: boolean | undefined;
  photoSize?: 'small' | 'large' | undefined;
  media?: (TvBugMediaV2 & { kind: 'video' | 'animation' }) | undefined;
}

export interface TvBugServiceMessageV2 {
  kind: TelegramServiceMessage['kind'];
  text: TvBugTextV2;
  actorId?: string | undefined;
  targetUserIds?: string[] | undefined;
  title?: TvBugTextV2 | undefined;
}

export interface TvBugBotKeyboardV2 {
  kind: TelegramBotKeyboard['kind'];
  rows: Array<
    Array<{
      kind: TelegramBotKeyboard['rows'][number][number]['kind'];
      text: TvBugTextV2;
      url?: string | undefined;
      buttonId?: number | undefined;
      dataLength?: number | undefined;
      copyText?: TvBugTextV2 | undefined;
      query?: TvBugTextV2 | undefined;
      samePeer?: boolean | undefined;
      botUsername?: TvBugTextV2 | undefined;
    }>
  >;
  hidden?: boolean | undefined;
  forceReply?: boolean | undefined;
  singleUse?: boolean | undefined;
  persistent?: boolean | undefined;
  placeholder?: TvBugTextV2 | undefined;
}

export interface TvBugDialogV2 {
  unreadReactionsCount?: number | undefined;
  unreadMentionsCount?: number | undefined;
  unreadMark?: boolean | undefined;
  protectedContent?: boolean | undefined;
  broadcast?: boolean | undefined;
  forum?: boolean | undefined;
  peer: TvBugPeerV2;
  transient?: boolean | undefined;
  channelPts?: number | undefined;
  title: TvBugTextV2;
  initials: TvBugTextV2;
  color: string;
  username?: TvBugTextV2 | undefined;
  archived?: boolean | undefined;
  topMessageId: number;
  topMessage?: TvBugMessageV2 | undefined;
  unreadCount: number;
  readInboxMaxId: number;
  readOutboxMaxId: number;
  muted: boolean;
  pinned: boolean;
  bot?: boolean | undefined;
  hasAvatar: boolean;
  avatarId?: string | undefined;
  presence?: 'online' | 'recently' | 'offline' | undefined;
  lastSeenAt?: number | undefined;
  userDetails?: {
    firstName?: TvBugTextV2 | undefined;
    lastName?: TvBugTextV2 | undefined;
    username?: TvBugTextV2 | undefined;
    bio?: TvBugTextV2 | undefined;
    isContact?: boolean | undefined;
    blocked: boolean;
  };
  cacheEpoch?: number | undefined;
}

export interface TvBugPendingAttachmentV2 {
  duration?: number | undefined;
  height?: number | undefined;
  width?: number | undefined;
  name: TvBugTextV2;
  mimeType: string;
  byteSize: number;
  asSticker: boolean;
  sendAs: 'media' | 'file';
  randomId?: string | undefined;
}

export interface TvBugPendingSendV2 {
  id: string;
  accountId?: string | undefined;
  peer: TvBugPeerV2;
  text: string;
  textMetrics: TvBugTextMetricsV2;
  randomId: string;
  createdAt: number;
  queueOrder?: number | undefined;
  attempts: number;
  lastError?: 'recorded-send-failure' | undefined;
  uploadProgress?: number | undefined;
  reply?:
    | { messageId: number; topMessageId?: number | undefined; quoteText?: TvBugTextV2 | undefined }
    | undefined;
  formats?: TvBugTextFormatV2[] | undefined;
  sticker?: {
    id: string;
    emoji: TvBugTextV2;
    mimeType: string;
    byteSize?: number | undefined;
    title?: TvBugTextV2 | undefined;
  };
  forward?: { fromPeer: TvBugPeerV2; messageId: number } | undefined;
  botStart?: { startParam: TvBugTextV2 } | undefined;
  attachment?: TvBugPendingAttachmentV2 | undefined;
  album?: { id: string; attachments: TvBugPendingAttachmentV2[] } | undefined;
}

export interface TvBugGroupMemberV2 {
  peer: TvBugPeerV2;
  title: TvBugTextV2;
  initials: TvBugTextV2;
  color: string;
  username?: TvBugTextV2 | undefined;
  role?: TvBugTextV2 | undefined;
  roleKind?: 'owner' | 'admin' | undefined;
  hasAvatar: boolean;
  avatarId?: string | undefined;
  presence?: 'online' | 'recently' | 'offline' | undefined;
}

export interface TvBugTimedValueV2<T> {
  value: T;
  savedAt: number;
}

export interface TvBugTimedSourceV2<T> {
  value: readonly T[];
  savedAt: number;
}

export interface TvBugWorkspaceSourceV2 {
  accountId?: string | undefined;
  dialogs?: readonly CachedDialog[] | undefined;
  draftRevisions?: Readonly<Record<string, number>> | undefined;
  drafts?: Readonly<Record<string, string>> | undefined;
  epoch?: number | undefined;
  lastPeerId?: string | undefined;
  pending?: readonly PendingSend[] | undefined;
  activePeerId?: string | undefined;
  phase?: 'idle' | 'connecting' | 'unauthorized' | 'syncing' | 'ready' | 'error' | undefined;
  sync?: 'current' | 'recovering' | 'stale' | undefined;
  online?: boolean | undefined;
}

export interface TvBugUiSourceV2 {
  route?: string | undefined;
  bootstrapActivePeerId?: string | undefined;
  activePeerId?: string | undefined;
  sidebarWidth?: number | undefined;
  detailsOpen?: boolean | undefined;
  chatAppearance?: TvBugChatAppearanceState | undefined;
  render?: TvBugRenderState | undefined;
  appearance?:
    | {
        themeId?: string | undefined;
        chatFontSize?: number | undefined;
        wallpaperKind?: 'none' | 'solid' | 'gradient' | 'pattern' | 'image' | undefined;
        blur?: number | boolean | undefined;
        dim?: number | undefined;
        accentColor?: string | undefined;
        preferences?: ThemePreferences | undefined;
      }
    | undefined;
}

export interface TvBugStateSourceV2 {
  cursor?: SyncCursor | undefined;
  epoch?: number | undefined;
  lastPeerId?: string | undefined;
  dialogs?: readonly (TelegramDialog | CachedDialog)[] | undefined;
  messages?: readonly (TelegramMessage | CachedMessage)[] | undefined;
  histories?: Readonly<Record<string, readonly (TelegramMessage | CachedMessage)[]>> | undefined;
  drafts?: Readonly<Record<string, string>> | undefined;
  draftRevisions?: Readonly<Record<string, number>> | undefined;
  pending?: readonly PendingSend[] | undefined;
  pinnedMessages?: Readonly<Record<string, TvBugTimedSourceV2<TelegramMessage>>> | undefined;
  groupMembers?: Readonly<Record<string, TvBugTimedSourceV2<TelegramGroupMember>>> | undefined;
  workspace?: TvBugWorkspaceSourceV2 | undefined;
  /** Runtime flags and errors, excluding collections already represented above. */
  runtime?: unknown;
  ui?: TvBugUiSourceV2 | undefined;
}

export interface TvBugStateV2 {
  version: typeof TVBUG_VERSION;
  cursor?: SyncCursor | undefined;
  epoch: number;
  lastPeerId?: string | undefined;
  dialogs: TvBugDialogV2[];
  messages: TvBugMessageV2[];
  histories: Record<string, number[]>;
  drafts: Record<string, string>;
  draftMetrics: Record<string, TvBugTextMetricsV2>;
  draftRevisions: Record<string, number>;
  pending: TvBugPendingSendV2[];
  pinnedMessages: Record<string, TvBugTimedValueV2<TvBugMessageV2[]>>;
  groupMembers: Record<string, TvBugTimedValueV2<TvBugGroupMemberV2[]>>;
  workspace: {
    accountId?: string | undefined;
    activePeerId?: string | undefined;
    phase?: TvBugWorkspaceSourceV2['phase'];
    sync?: TvBugWorkspaceSourceV2['sync'];
    online?: boolean | undefined;
  };
  runtime: TvBugJsonValue;
  ui?: {
    route?: string | undefined;
    bootstrapActivePeerId?: string | undefined;
    activePeerId?: string | undefined;
    sidebarWidth?: number | undefined;
    detailsOpen?: boolean | undefined;
    chatAppearance?: TvBugChatAppearanceState | undefined;
    render?: TvBugRenderState | undefined;
    appearance?: {
      themeId?: string | undefined;
      chatFontSize?: number | undefined;
      wallpaperKind?: 'none' | 'solid' | 'gradient' | 'pattern' | 'image' | undefined;
      blur?: number | boolean | undefined;
      dim?: number | undefined;
      accentColor?: string | undefined;
      preferences?: ThemePreferences | undefined;
    };
  };
}

export type TvBugJsonPrimitive = string | number | boolean | null;
export type TvBugJsonValue =
  | TvBugJsonPrimitive
  | TvBugJsonValue[]
  | { [key: string]: TvBugJsonValue };

export type TvBugTraceKindV2 = 'ui' | 'diagnostic';

export interface TvBugTraceEventV2 {
  seq: number;
  tMs: number;
  kind: TvBugTraceKindV2;
  method?: string | undefined;
  value?: TvBugJsonValue | undefined;
}

export interface TvBugBundleV2 {
  manifest: TvBugManifestV2;
  snapshot: TvBugStateV2;
  trace: TvBugTraceEventV2[];
}

export interface CreateTvBugBundleInputV2 extends TvBugBundleV2 {}

export interface TvBugSanitizerV2 {
  sanitizeState(source: TvBugStateSourceV2): TvBugStateV2;
  sanitizeValue(value: unknown, context?: string): TvBugJsonValue | undefined;
  alias(category: string, value: string | number): string;
  shiftSeconds(value: number): number;
  shiftMilliseconds(value: number): number;
}

export interface TvBugSanitizerOptionsV2 {
  sourceEpochMs?: number | undefined;
}

export interface HydratedTvBugStateV2 {
  cursor?: SyncCursor | undefined;
  epoch: number;
  lastPeerId?: string | undefined;
  dialogs: CachedDialog[];
  messages: CachedMessage[];
  histories: Record<string, CachedMessage[]>;
  drafts: Record<string, string>;
  draftRevisions: Record<string, number>;
  pending: PendingSend[];
  pinnedMessages: Record<string, TvBugTimedValueV2<TelegramMessage[]>>;
  groupMembers: Record<string, TvBugTimedValueV2<TelegramGroupMember[]>>;
  workspace: {
    accountId?: string | undefined;
    dialogs: CachedDialog[];
    draftRevisions: Record<string, number>;
    drafts: Record<string, string>;
    epoch: number;
    lastPeerId?: string | undefined;
    pending: PendingSend[];
    pinnedMessages: Record<string, TvBugTimedValueV2<TelegramMessage[]>>;
    groupMembers: Record<string, TvBugTimedValueV2<TelegramGroupMember[]>>;
  };
  ui?: TvBugStateV2['ui'];
}

export class TvBugFormatError extends Data.TaggedError('TvBugFormatError')<{
  readonly message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

export function createTvBugManifest(
  input: Omit<TvBugManifestV2, 'format' | 'version' | 'privacy'>,
): TvBugManifestV2 {
  return {
    format: TVBUG_FORMAT,
    version: TVBUG_VERSION,
    producer: { ...input.producer },
    capture: { ...input.capture },
    ...(input.coverage ? { coverage: { ...input.coverage } } : {}),
    ...(input.environment ? { environment: { ...input.environment } } : {}),
    privacy: {
      profile: 'account-free-v2',
      rawText: false,
      rawMedia: false,
      stableIdentifiers: false,
      authMaterial: false,
    },
  };
}

export function sanitizeTvBugText(value: string): TvBugTextV2 {
  assertTextSize(value, 'text');
  const synthetic = Array.from(value, synthesizeCodePoint).join('');
  return { value: synthetic, metrics: measureText(synthetic) };
}

export function measureText(value: string): TvBugTextMetricsV2 {
  assertTextSize(value, 'text');
  const lines = value.split(/\r\n|[\n\r\u2028\u2029]/u);
  return {
    utf16Length: value.length,
    graphemeCount: countGraphemes(value),
    lineCount: lines.length,
    lineUtf16Lengths: lines.map((line) => line.length),
  };
}

export function createTvBugSanitizer(options: TvBugSanitizerOptionsV2 = {}): TvBugSanitizerV2 {
  const aliases = createAliasBook();
  let time =
    options.sourceEpochMs === undefined ? undefined : createTimeShifter([], options.sourceEpochMs);
  const requireTime = () => {
    if (!time) {
      throw new TvBugFormatError(
        'Timestamp shifting needs sourceEpochMs or a sanitized initial state first.',
      );
    }
    return time;
  };

  return {
    sanitizeState(source) {
      const sanitizer = new StateSanitizer(source, aliases, time);
      time = sanitizer.timeShifter;
      return sanitizer.sanitize();
    },
    sanitizeValue: (value, context: string | undefined = 'value') =>
      sanitizeJsonValue(value, context, aliases, time, 0),
    alias(category, value) {
      if (!/^[a-z][a-z0-9-]{0,31}$/u.test(category)) {
        throw new TvBugFormatError('Alias categories must be short lowercase names.');
      }
      return aliases.get(category, String(value));
    },
    shiftSeconds: (value) => requireTime().shiftSeconds(value),
    shiftMilliseconds: (value) => requireTime().shiftMilliseconds(value),
  };
}

export function sanitizeTvBugState(source: TvBugStateSourceV2): TvBugStateV2 {
  return createTvBugSanitizer().sanitizeState(source);
}

export function createTvBugBundle(bundle: CreateTvBugBundleInputV2): Uint8Array {
  validateBundle(bundle);
  const manifest = strToU8(JSON.stringify(bundle.manifest, null, 2));
  const snapshot = strToU8(JSON.stringify(bundle.snapshot, null, 2));
  const trace = strToU8(
    bundle.trace.map((event) => JSON.stringify(event)).join('\n') +
      (bundle.trace.length ? '\n' : ''),
  );
  assertFileSizes(manifest.byteLength, snapshot.byteLength, trace.byteLength);
  const result = zipSync(
    {
      [MANIFEST_FILE]: [manifest, { mtime: ZIP_MTIME }],
      [SNAPSHOT_FILE]: [snapshot, { mtime: ZIP_MTIME }],
      [TRACE_FILE]: [trace, { mtime: ZIP_MTIME }],
    },
    { level: 9 },
  );
  if (result.byteLength > MAX_COMPRESSED_BYTES) {
    throw new TvBugFormatError('The compressed .tvbug bundle exceeds 8 MiB.');
  }
  return result;
}

interface TvBugZipEntry {
  name: string;
  flags: number;
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  dataOffset: number;
  dataEnd: number;
}

function extractTvBugZip(data: Uint8Array): Record<string, Uint8Array> {
  const entries = inspectTvBugZip(data);
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) files[entry.name] = extractZipEntry(data, entry);
  return files;
}

function inspectTvBugZip(data: Uint8Array): TvBugZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const endOffset = findZipEnd(view);
  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new TvBugFormatError('Multi-disk .tvbug ZIPs are not supported.');
  }
  if (entryCount === 0xffff || centralSize === 0xffff_ffff || centralOffset === 0xffff_ffff) {
    throw new TvBugFormatError('ZIP64 .tvbug bundles are not supported.');
  }
  const centralEnd = checkedZipEnd(centralOffset, centralSize, endOffset, 'central directory');
  if (centralEnd !== endOffset) {
    throw new TvBugFormatError('The .tvbug ZIP central directory is inconsistent.');
  }

  const entries: TvBugZipEntry[] = [];
  const seen = new Set<string>();
  let totalSize = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    checkedZipEnd(offset, 46, centralEnd, 'central directory entry');
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new TvBugFormatError('The .tvbug ZIP central directory is malformed.');
    }
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const entryDisk = view.getUint16(offset + 34, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameOffset = offset + 46;
    const nextOffset = checkedZipEnd(
      nameOffset,
      nameLength + extraLength + commentLength,
      centralEnd,
      'central directory entry',
    );
    const name = decodeUtf8(data.subarray(nameOffset, nameOffset + nameLength), 'ZIP entry name');
    validateZipEntryMetadata(name, flags, compression, entryDisk, seen);
    const fileLimit = zipFileLimit(name);
    if (uncompressedSize > fileLimit) {
      throw new TvBugFormatError(`${name} exceeds its size limit.`);
    }
    totalSize += uncompressedSize;
    if (totalSize > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new TvBugFormatError('The uncompressed .tvbug bundle exceeds 10 MiB.');
    }
    const entry = inspectLocalZipEntry(data, view, centralOffset, {
      name,
      flags,
      compression,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    entries.push(entry);
    offset = nextOffset;
  }
  if (offset !== centralEnd) {
    throw new TvBugFormatError('The .tvbug ZIP central directory has trailing data.');
  }
  for (const file of REQUIRED_FILES) {
    if (!seen.has(file)) throw new TvBugFormatError(`Missing ${file} in .tvbug bundle.`);
  }
  const localOrder = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  let expectedOffset = 0;
  for (const entry of localOrder) {
    if (entry.localOffset !== expectedOffset) {
      throw new TvBugFormatError('The .tvbug ZIP contains overlapping, hidden, or padded data.');
    }
    expectedOffset = entry.dataEnd;
  }
  if (expectedOffset !== centralOffset) {
    throw new TvBugFormatError('The .tvbug ZIP contains unlisted file data.');
  }
  return entries;
}

function findZipEnd(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === view.byteLength) return offset;
  }
  throw new TvBugFormatError('The .tvbug ZIP end record is missing or malformed.');
}

function inspectLocalZipEntry(
  data: Uint8Array,
  view: DataView,
  centralOffset: number,
  central: Omit<TvBugZipEntry, 'dataOffset' | 'dataEnd'>,
): TvBugZipEntry {
  checkedZipEnd(central.localOffset, 30, centralOffset, `${central.name} local header`);
  if (view.getUint32(central.localOffset, true) !== ZIP_LOCAL_SIGNATURE) {
    throw new TvBugFormatError(`${central.name} has a malformed local ZIP header.`);
  }
  const flags = view.getUint16(central.localOffset + 6, true);
  const compression = view.getUint16(central.localOffset + 8, true);
  const crc32 = view.getUint32(central.localOffset + 14, true);
  const compressedSize = view.getUint32(central.localOffset + 18, true);
  const uncompressedSize = view.getUint32(central.localOffset + 22, true);
  const nameLength = view.getUint16(central.localOffset + 26, true);
  const extraLength = view.getUint16(central.localOffset + 28, true);
  const nameOffset = central.localOffset + 30;
  const dataOffset = checkedZipEnd(
    nameOffset,
    nameLength + extraLength,
    centralOffset,
    `${central.name} local header`,
  );
  const name = decodeUtf8(data.subarray(nameOffset, nameOffset + nameLength), 'ZIP entry name');
  if (
    name !== central.name ||
    flags !== central.flags ||
    compression !== central.compression ||
    crc32 !== central.crc32 ||
    compressedSize !== central.compressedSize ||
    uncompressedSize !== central.uncompressedSize
  ) {
    throw new TvBugFormatError(`${central.name} local and central ZIP metadata disagree.`);
  }
  const dataEnd = checkedZipEnd(
    dataOffset,
    compressedSize,
    centralOffset,
    `${central.name} compressed data`,
  );
  if (compression === 0 && compressedSize !== uncompressedSize) {
    throw new TvBugFormatError(`${central.name} has inconsistent stored ZIP sizes.`);
  }
  return { ...central, dataOffset, dataEnd };
}

function validateZipEntryMetadata(
  name: string,
  flags: number,
  compression: number,
  entryDisk: number,
  seen: Set<string>,
) {
  if (!REQUIRED_FILES.has(name) || name.includes('/') || name.includes('\\')) {
    throw new TvBugFormatError(`Unexpected file in .tvbug bundle: ${name}`);
  }
  if (seen.has(name)) throw new TvBugFormatError(`Duplicate file in .tvbug bundle: ${name}`);
  seen.add(name);
  if (entryDisk !== 0) throw new TvBugFormatError(`${name} refers to another ZIP disk.`);
  if ((flags & ~ZIP_UTF8_FLAG) !== 0) {
    throw new TvBugFormatError(`${name} uses unsupported ZIP flags.`);
  }
  if (compression !== 0 && compression !== 8) {
    throw new TvBugFormatError(`${name} uses an unsupported ZIP compression method.`);
  }
}

function extractZipEntry(data: Uint8Array, entry: TvBugZipEntry): Uint8Array {
  const fileLimit = zipFileLimit(entry.name);
  const output = new Uint8Array(entry.uncompressedSize);
  let written = 0;
  let checksum = 0xffff_ffff;
  let finished = false;
  const append = (chunk: Uint8Array, final: boolean) => {
    const next = written + chunk.byteLength;
    if (next > entry.uncompressedSize || next > fileLimit) {
      throw new TvBugFormatError(
        `${entry.name} expands beyond its declared size or materialization limit.`,
      );
    }
    output.set(chunk, written);
    written = next;
    checksum = updateCrc32(checksum, chunk);
    if (final) finished = true;
  };

  if (entry.compression === 0) {
    append(data.subarray(entry.dataOffset, entry.dataEnd), true);
  } else {
    const inflate = new Inflate(append);
    if (entry.compressedSize === 0) {
      inflate.push(new Uint8Array(), true);
    } else {
      for (let offset = entry.dataOffset; offset < entry.dataEnd; offset += ZIP_CHUNK_BYTES) {
        const end = Math.min(entry.dataEnd, offset + ZIP_CHUNK_BYTES);
        inflate.push(data.subarray(offset, end), end === entry.dataEnd);
      }
    }
  }
  if (!finished || written !== entry.uncompressedSize) {
    throw new TvBugFormatError(`${entry.name} does not match its declared uncompressed size.`);
  }
  if ((checksum ^ 0xffff_ffff) >>> 0 !== entry.crc32) {
    throw new TvBugFormatError(`${entry.name} failed its ZIP CRC-32 check.`);
  }
  return output;
}

function checkedZipEnd(start: number, length: number, limit: number, context: string): number {
  const end = start + length;
  if (!Number.isSafeInteger(end) || start < 0 || length < 0 || end > limit) {
    throw new TvBugFormatError(`The .tvbug ZIP ${context} is out of bounds.`);
  }
  return end;
}

function zipFileLimit(name: string): number {
  if (name === MANIFEST_FILE) return MAX_MANIFEST_BYTES;
  if (name === SNAPSHOT_FILE) return MAX_SNAPSHOT_BYTES;
  return MAX_TRACE_BYTES;
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function updateCrc32(checksum: number, data: Uint8Array): number {
  let value = checksum;
  for (const byte of data) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
}

export function parseTvBugBundle(data: Uint8Array): TvBugBundleV2 {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    throw new TvBugFormatError('The .tvbug bundle is empty.');
  }
  if (data.byteLength > MAX_COMPRESSED_BYTES) {
    throw new TvBugFormatError('The compressed .tvbug bundle exceeds 8 MiB.');
  }
  let files: Record<string, Uint8Array>;
  try {
    files = extractTvBugZip(data);
  } catch (error) {
    if (error instanceof TvBugFormatError) throw error;
    throw new TvBugFormatError(`Cannot read .tvbug ZIP: ${errorMessage(error)}`);
  }
  for (const file of REQUIRED_FILES) {
    if (!files[file]) throw new TvBugFormatError(`Missing ${file} in .tvbug bundle.`);
  }
  assertFileSizes(
    files[MANIFEST_FILE]!.byteLength,
    files[SNAPSHOT_FILE]!.byteLength,
    files[TRACE_FILE]!.byteLength,
  );
  const manifest = parseJsonFile(files[MANIFEST_FILE]!, MANIFEST_FILE);
  const snapshot = parseJsonFile(files[SNAPSHOT_FILE]!, SNAPSHOT_FILE);
  const traceText = decodeUtf8(files[TRACE_FILE]!, TRACE_FILE);
  const trace = traceText
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line, index) => parseJsonText(line, `${TRACE_FILE}:${index + 1}`));
  const bundle = { manifest, snapshot, trace } as TvBugBundleV2;
  validateBundle(bundle);
  return bundle;
}

export function hydrateTvBugState(state: TvBugStateV2): HydratedTvBugStateV2 {
  validateStateForHydration(state);
  const hydrationNow = Date.now();
  const messages = state.messages.map((message) => hydrateMessage(message, state.epoch));
  const messageIndex = new Map(
    messages.map((message) => [`${message.peerId}\0${message.id}`, message]),
  );
  const histories: Record<string, CachedMessage[]> = {};
  for (const [peerId, ids] of Object.entries(state.histories)) {
    histories[peerId] = ids.map((id) => {
      const message = messageIndex.get(`${peerId}\0${id}`);
      if (!message)
        throw new TvBugFormatError(`History references missing message ${peerId}/${id}.`);
      return message;
    });
  }
  const dialogs = state.dialogs.map((dialog) => hydrateDialog(dialog, state.epoch));
  const pending = state.pending.map(hydratePending);
  const pinnedMessages: Record<string, TvBugTimedValueV2<TelegramMessage[]>> = {};
  for (const [peerId, cached] of Object.entries(state.pinnedMessages)) {
    pinnedMessages[peerId] = {
      value: cached.value.map((message) => hydrateMessage(message, state.epoch)),
      savedAt: rebaseCacheTimestamp(cached.savedAt, hydrationNow),
    };
  }
  const groupMembers: Record<string, TvBugTimedValueV2<TelegramGroupMember[]>> = {};
  for (const [peerId, cached] of Object.entries(state.groupMembers)) {
    groupMembers[peerId] = {
      value: cached.value.map(hydrateGroupMember),
      savedAt: rebaseCacheTimestamp(cached.savedAt, hydrationNow),
    };
  }
  return {
    ...(state.cursor ? { cursor: { ...state.cursor } } : {}),
    epoch: state.epoch,
    ...(state.lastPeerId ? { lastPeerId: state.lastPeerId } : {}),
    dialogs,
    messages,
    histories,
    drafts: { ...state.drafts },
    draftRevisions: { ...state.draftRevisions },
    pending,
    pinnedMessages,
    groupMembers,
    workspace: {
      ...(state.workspace.accountId ? { accountId: state.workspace.accountId } : {}),
      dialogs,
      draftRevisions: { ...state.draftRevisions },
      drafts: { ...state.drafts },
      epoch: state.epoch,
      ...(state.lastPeerId ? { lastPeerId: state.lastPeerId } : {}),
      pending,
      pinnedMessages,
      groupMembers,
    },
    ...(state.ui ? { ui: structuredClone(state.ui) } : {}),
  };
}

function hydrateGroupMember(member: TvBugGroupMemberV2): TelegramGroupMember {
  return {
    peer: { ...member.peer },
    title: member.title.value,
    initials: member.initials.value,
    color: member.color,
    ...(member.username ? { username: member.username.value } : {}),
    ...(member.role ? { role: member.role.value } : {}),
    ...(member.roleKind ? { roleKind: member.roleKind } : {}),
    hasAvatar: member.hasAvatar,
    ...(member.avatarId ? { avatarId: member.avatarId } : {}),
    ...(member.presence ? { presence: member.presence } : {}),
  };
}

function rebaseCacheTimestamp(savedAt: number, hydrationNow: number) {
  return hydrationNow + (savedAt - TVBUG_FIXED_EPOCH_SECONDS * 1_000);
}

function hydrateDialog(dialog: TvBugDialogV2, epoch: number): CachedDialog {
  return {
    ...(dialog.unreadReactionsCount !== undefined
      ? { unreadReactionsCount: dialog.unreadReactionsCount }
      : {}),
    ...(dialog.unreadMentionsCount !== undefined
      ? { unreadMentionsCount: dialog.unreadMentionsCount }
      : {}),
    ...(dialog.unreadMark !== undefined ? { unreadMark: dialog.unreadMark } : {}),
    ...(dialog.protectedContent !== undefined ? { protectedContent: dialog.protectedContent } : {}),
    ...(dialog.broadcast !== undefined ? { broadcast: dialog.broadcast } : {}),
    ...(dialog.forum !== undefined ? { forum: dialog.forum } : {}),
    peer: { ...dialog.peer },
    ...(dialog.transient !== undefined ? { transient: dialog.transient } : {}),
    ...(dialog.channelPts !== undefined ? { channelPts: dialog.channelPts } : {}),
    title: dialog.title.value,
    initials: dialog.initials.value,
    color: dialog.color,
    ...(dialog.username ? { username: dialog.username.value } : {}),
    ...(dialog.archived !== undefined ? { archived: dialog.archived } : {}),
    topMessageId: dialog.topMessageId,
    ...(dialog.topMessage ? { topMessage: hydrateMessage(dialog.topMessage, epoch) } : {}),
    unreadCount: dialog.unreadCount,
    readInboxMaxId: dialog.readInboxMaxId,
    readOutboxMaxId: dialog.readOutboxMaxId,
    muted: dialog.muted,
    pinned: dialog.pinned,
    ...(dialog.bot !== undefined ? { bot: dialog.bot } : {}),
    hasAvatar: dialog.hasAvatar,
    ...(dialog.avatarId ? { avatarId: dialog.avatarId } : {}),
    ...(dialog.presence ? { presence: dialog.presence } : {}),
    ...(dialog.lastSeenAt !== undefined ? { lastSeenAt: dialog.lastSeenAt } : {}),
    ...(dialog.userDetails
      ? {
          userDetails: {
            ...(dialog.userDetails.firstName
              ? { firstName: dialog.userDetails.firstName.value }
              : {}),
            ...(dialog.userDetails.lastName ? { lastName: dialog.userDetails.lastName.value } : {}),
            ...(dialog.userDetails.username ? { username: dialog.userDetails.username.value } : {}),
            ...(dialog.userDetails.bio ? { bio: dialog.userDetails.bio.value } : {}),
            ...(dialog.userDetails.isContact !== undefined
              ? { isContact: dialog.userDetails.isContact }
              : {}),
            blocked: dialog.userDetails.blocked,
          },
        }
      : {}),
    cacheEpoch: dialog.cacheEpoch ?? epoch,
  };
}

function hydrateMessage(message: TvBugMessageV2, epoch: number): CachedMessage {
  return {
    ...(message.savedPeerId !== undefined ? { savedPeerId: message.savedPeerId } : {}),
    ...(message.topicId !== undefined ? { topicId: message.topicId } : {}),
    ...(message.reactionsAsTags !== undefined ? { reactionsAsTags: message.reactionsAsTags } : {}),
    ...(message.protected !== undefined ? { protected: message.protected } : {}),
    ...(message.unreadReaction !== undefined ? { unreadReaction: message.unreadReaction } : {}),
    ...(message.unreadMention !== undefined ? { unreadMention: message.unreadMention } : {}),
    ...(message.mediaUnread !== undefined ? { mediaUnread: message.mediaUnread } : {}),
    id: message.id,
    peerId: message.peerId,
    senderId: message.senderId,
    ...(message.senderName ? { senderName: message.senderName.value } : {}),
    ...(message.senderHasAvatar !== undefined ? { senderHasAvatar: message.senderHasAvatar } : {}),
    ...(message.senderAvatarId ? { senderAvatarId: message.senderAvatarId } : {}),
    ...(message.senderColor ? { senderColor: message.senderColor } : {}),
    ...(message.senderColorVersion !== undefined
      ? { senderColorVersion: message.senderColorVersion }
      : {}),
    ...(message.senderRole ? { senderRole: message.senderRole.value } : {}),
    ...(message.senderRoleKind ? { senderRoleKind: message.senderRoleKind } : {}),
    text: message.text,
    date: message.date,
    outgoing: message.outgoing,
    ...(message.editedAt !== undefined ? { editedAt: message.editedAt } : {}),
    ...(message.replyToId !== undefined ? { replyToId: message.replyToId } : {}),
    ...(message.replyQuote ? { replyQuote: message.replyQuote.value } : {}),
    ...(message.randomId ? { randomId: message.randomId } : {}),
    ...(message.groupedId ? { groupedId: message.groupedId } : {}),
    ...(message.forwardedFrom
      ? {
          forwardedFrom: {
            name: message.forwardedFrom.name.value,
            ...(message.forwardedFrom.peerId ? { peerId: message.forwardedFrom.peerId } : {}),
            ...(message.forwardedFrom.messageId !== undefined
              ? { messageId: message.forwardedFrom.messageId }
              : {}),
            ...(message.forwardedFrom.hasAvatar !== undefined
              ? { hasAvatar: message.forwardedFrom.hasAvatar }
              : {}),
            ...(message.forwardedFrom.avatarId ? { avatarId: message.forwardedFrom.avatarId } : {}),
            ...(message.forwardedFrom.color ? { color: message.forwardedFrom.color } : {}),
          },
        }
      : {}),
    ...(message.service ? { service: hydrateService(message.service) } : {}),
    ...(message.botKeyboard ? { botKeyboard: hydrateKeyboard(message.botKeyboard) } : {}),
    ...(message.media
      ? {
          media: {
            kind: message.media.kind,
            ...(message.media.spoiler !== undefined ? { spoiler: message.media.spoiler } : {}),

            name: message.media.name.value,
            mimeType: message.media.mimeType,
            ...(message.media.byteSize !== undefined ? { size: message.media.byteSize } : {}),
            ...(message.media.width !== undefined ? { width: message.media.width } : {}),
            ...(message.media.height !== undefined ? { height: message.media.height } : {}),
            ...(message.media.duration !== undefined ? { duration: message.media.duration } : {}),
            ...(message.media.cacheKey ? { cacheKey: message.media.cacheKey } : {}),
          },
        }
      : {}),
    ...(message.reactions
      ? {
          reactions: message.reactions.map((reaction) => ({
            emoji: reaction.emoji.value,
            ...(reaction.customEmojiId ? { customEmojiId: reaction.customEmojiId } : {}),
            count: reaction.count,
            chosen: reaction.chosen,
          })),
        }
      : {}),
    ...(message.mentions ? { mentions: message.mentions.map((mention) => ({ ...mention })) } : {}),
    ...(message.links ? { links: message.links.map((link) => ({ ...link })) } : {}),
    ...(message.linkPreview
      ? {
          linkPreview: {
            url: message.linkPreview.url,
            ...(message.linkPreview.type ? { type: message.linkPreview.type } : {}),
            ...(message.linkPreview.hasEmbed ? { hasEmbed: true } : {}),
            ...(message.linkPreview.siteName
              ? { siteName: message.linkPreview.siteName.value }
              : {}),
            ...(message.linkPreview.title ? { title: message.linkPreview.title.value } : {}),
            ...(message.linkPreview.description
              ? { description: message.linkPreview.description.value }
              : {}),
            ...(message.linkPreview.hasPhoto !== undefined
              ? { hasPhoto: message.linkPreview.hasPhoto }
              : {}),
            ...(message.linkPreview.photoSize ? { photoSize: message.linkPreview.photoSize } : {}),
            ...(message.linkPreview.media
              ? {
                  media: {
                    kind: message.linkPreview.media.kind,
                    ...(message.linkPreview.media.spoiler !== undefined
                      ? { spoiler: message.linkPreview.media.spoiler }
                      : {}),

                    name: message.linkPreview.media.name.value,
                    mimeType: message.linkPreview.media.mimeType,
                    ...(message.linkPreview.media.byteSize !== undefined
                      ? { size: message.linkPreview.media.byteSize }
                      : {}),
                    ...(message.linkPreview.media.width !== undefined
                      ? { width: message.linkPreview.media.width }
                      : {}),
                    ...(message.linkPreview.media.height !== undefined
                      ? { height: message.linkPreview.media.height }
                      : {}),
                    ...(message.linkPreview.media.duration !== undefined
                      ? { duration: message.linkPreview.media.duration }
                      : {}),
                    ...(message.linkPreview.media.cacheKey
                      ? { cacheKey: message.linkPreview.media.cacheKey }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(message.widget
      ? { widget: { ...message.widget, html: '', canQuery: false, backgroundQuery: false } }
      : {}),
    ...(message.contentDiagnostic
      ? { contentDiagnostic: sanitizeMessageContentDiagnostic(message.contentDiagnostic) }
      : {}),
    ...(message.formats ? { formats: message.formats.map(hydrateFormat) } : {}),
    ...(message.richMessage ? { richMessage: hydrateRichMessage(message.richMessage) } : {}),
    ...(message.pinned !== undefined ? { pinned: message.pinned } : {}),
    cacheEpoch: message.cacheEpoch ?? epoch,
  };
}

function hydrateService(service: TvBugServiceMessageV2): TelegramServiceMessage {
  return {
    kind: service.kind,
    text: service.text.value,
    ...(service.actorId ? { actorId: service.actorId } : {}),
    ...(service.targetUserIds ? { targetUserIds: [...service.targetUserIds] } : {}),
    ...(service.title ? { title: service.title.value } : {}),
  };
}

function hydrateKeyboard(keyboard: TvBugBotKeyboardV2): TelegramBotKeyboard {
  return {
    kind: keyboard.kind,
    rows: keyboard.rows.map((row) =>
      row.map((button) => ({
        kind: button.kind,
        text: button.text.value,
        ...(button.url ? { url: button.url } : {}),
        ...(button.buttonId !== undefined ? { buttonId: button.buttonId } : {}),
        ...(button.dataLength !== undefined
          ? { data: Array.from({ length: button.dataLength }, () => 0) }
          : {}),
        ...(button.copyText ? { copyText: button.copyText.value } : {}),
        ...(button.query ? { query: button.query.value } : {}),
        ...(button.samePeer !== undefined ? { samePeer: button.samePeer } : {}),
        ...(button.botUsername ? { botUsername: button.botUsername.value } : {}),
      })),
    ),
    ...(keyboard.hidden !== undefined ? { hidden: keyboard.hidden } : {}),
    ...(keyboard.forceReply !== undefined ? { forceReply: keyboard.forceReply } : {}),
    ...(keyboard.singleUse !== undefined ? { singleUse: keyboard.singleUse } : {}),
    ...(keyboard.persistent !== undefined ? { persistent: keyboard.persistent } : {}),
    ...(keyboard.placeholder ? { placeholder: keyboard.placeholder.value } : {}),
  };
}

function hydrateFormat(format: TvBugTextFormatV2): TelegramTextFormat {
  return {
    offset: format.offset,
    length: format.length,
    kind: format.kind,
    ...(format.userId ? { userId: format.userId } : {}),
    ...(format.url ? { url: format.url } : {}),
    ...(format.customEmojiId ? { customEmojiId: format.customEmojiId } : {}),
    ...(format.timestamp !== undefined ? { timestamp: format.timestamp } : {}),
    ...(format.oldText ? { oldText: format.oldText.value } : {}),
  };
}

function hydratePending(send: TvBugPendingSendV2): PendingSend {
  return {
    id: send.id,
    ...(send.accountId ? { accountId: send.accountId } : {}),
    peer: { ...send.peer },
    text: send.text,
    randomId: send.randomId,
    createdAt: send.createdAt,
    ...(send.queueOrder !== undefined ? { queueOrder: send.queueOrder } : {}),
    attempts: send.attempts,
    ...(send.lastError ? { lastError: send.lastError } : {}),
    ...(send.uploadProgress !== undefined ? { uploadProgress: send.uploadProgress } : {}),
    ...(send.reply
      ? {
          reply: {
            ...(send.reply.topMessageId !== undefined
              ? { topMessageId: send.reply.topMessageId }
              : {}),
            messageId: send.reply.messageId,
            ...(send.reply.quoteText ? { quoteText: send.reply.quoteText.value } : {}),
          },
        }
      : {}),
    ...(send.formats ? { formats: send.formats.map(hydrateFormat) } : {}),
    ...(send.sticker
      ? {
          sticker: {
            id: send.sticker.id,
            accessHash: '0',
            fileReference: new Uint8Array(),
            emoji: send.sticker.emoji.value,
            mimeType: send.sticker.mimeType,
            ...(send.sticker.byteSize !== undefined ? { size: send.sticker.byteSize } : {}),
            ...(send.sticker.title ? { title: send.sticker.title.value } : {}),
          },
        }
      : {}),
    ...(send.forward
      ? { forward: { fromPeer: { ...send.forward.fromPeer }, messageId: send.forward.messageId } }
      : {}),
    ...(send.botStart ? { botStart: { startParam: send.botStart.startParam.value } } : {}),
    ...(send.attachment ? { attachment: hydrateAttachment(send.attachment) } : {}),
    ...(send.album
      ? {
          album: {
            attachments: send.album.attachments.map((attachment, index) => ({
              ...hydrateAttachment(attachment),
              randomId: attachment.randomId ?? `${send.album!.id}:random:${index + 1}`,
            })),
          },
        }
      : {}),
  };
}

function hydrateAttachment(attachment: TvBugPendingAttachmentV2) {
  return {
    ...(attachment.duration !== undefined ? { duration: attachment.duration } : {}),
    ...(attachment.height !== undefined ? { height: attachment.height } : {}),
    ...(attachment.width !== undefined ? { width: attachment.width } : {}),
    blob: createSizedBlob(attachment.byteSize, attachment.mimeType),
    name: attachment.name.value,
    mimeType: attachment.mimeType,
    asSticker: attachment.asSticker,
    sendAs: attachment.sendAs,
  };
}

function createSizedBlob(byteSize: number, mimeType: string) {
  const chunk = new Uint8Array(Math.min(byteSize, 64 * 1024));
  const parts: BlobPart[] = [];
  let remaining = byteSize;
  while (remaining >= chunk.byteLength && chunk.byteLength > 0) {
    parts.push(chunk);
    remaining -= chunk.byteLength;
  }
  if (remaining > 0) parts.push(chunk.subarray(0, remaining));
  return new Blob(parts, { type: mimeType });
}

function hydrateRichMessage(message: TvBugRichMessageV2): RichMessage {
  return {
    blocks: message.blocks.map(hydrateRichBlock),
    ...(message.rtl !== undefined ? { rtl: message.rtl } : {}),
    ...(message.partial !== undefined ? { partial: message.partial } : {}),
  };
}

function hydrateRichText(text: TvBugRichTextV2): RichText {
  switch (text.kind) {
    case 'button':
      return {
        kind: 'button',
        child: hydrateRichText(text.child),
        button: hydrateKeyboard({ kind: 'inline', rows: [[text.button]] }).rows[0]![0]!,
      };
    case 'text':
      return { kind: 'text', text: text.text.value };
    case 'concat':
      return { kind: 'concat', children: text.children.map(hydrateRichText) };
    case 'link':
      return { kind: 'link', child: hydrateRichText(text.child), url: text.url };
    case 'anchor':
      return { kind: 'anchor', child: hydrateRichText(text.child), name: text.name.value };
    case 'customEmoji':
      return { kind: 'customEmoji', alt: text.alt.value, documentId: text.documentId };
    case 'math':
      return { kind: 'math', source: text.source.value };
    case 'date':
      return { kind: 'date', child: hydrateRichText(text.child), timestamp: text.timestamp };
    case 'bold':
    case 'code':
    case 'diff':
    case 'italic':
    case 'marked':
    case 'spoiler':
    case 'strike':
    case 'subscript':
    case 'superscript':
    case 'underline':
      return {
        kind: text.kind,
        child: hydrateRichText(text.child),
        ...(text.oldText ? { oldText: hydrateRichText(text.oldText) } : {}),
      };
  }
}

function hydrateRichBlock(block: TvBugRichBlockV2): RichBlock {
  switch (block.kind) {
    case 'buttons':
      return {
        kind: 'buttons',
        align: block.align,
        buttons: hydrateKeyboard({ kind: 'inline', rows: [block.buttons] }).rows[0]!,
      };
    case 'text':
      return { kind: 'text', role: block.role, text: hydrateRichText(block.text) };
    case 'heading':
      return { kind: 'heading', level: block.level, text: hydrateRichText(block.text) };
    case 'pre':
      return {
        kind: 'pre',
        text: hydrateRichText(block.text),
        ...(block.language ? { language: block.language.value } : {}),
      };
    case 'divider':
      return { kind: 'divider' };
    case 'anchor':
      return { kind: 'anchor', name: block.name.value };
    case 'list':
      return {
        kind: 'list',
        ordered: block.ordered,
        ...(block.reversed !== undefined ? { reversed: block.reversed } : {}),
        ...(block.start !== undefined ? { start: block.start } : {}),
        items: block.items.map((item) => ({
          ...(item.text ? { text: hydrateRichText(item.text) } : {}),
          ...(item.blocks ? { blocks: item.blocks.map(hydrateRichBlock) } : {}),
          ...(item.checked !== undefined ? { checked: item.checked } : {}),
          ...(item.checkbox !== undefined ? { checkbox: item.checkbox } : {}),
          ...(item.marker ? { marker: item.marker.value } : {}),
          ...(item.value !== undefined ? { value: item.value } : {}),
        })),
      };
    case 'quote':
      return {
        kind: 'quote',
        blocks: block.blocks.map(hydrateRichBlock),
        ...(block.caption ? { caption: hydrateRichText(block.caption) } : {}),
        ...(block.pull !== undefined ? { pull: block.pull } : {}),
        ...(block.expandable !== undefined ? { expandable: block.expandable } : {}),
      };
    case 'details':
      return {
        kind: 'details',
        title: hydrateRichText(block.title),
        blocks: block.blocks.map(hydrateRichBlock),
        ...(block.open !== undefined ? { open: block.open } : {}),
      };
    case 'table':
      return {
        kind: 'table',
        ...(block.title ? { title: hydrateRichText(block.title) } : {}),
        rows: block.rows.map((row) =>
          row.map((cell) => ({
            ...(cell.text ? { text: hydrateRichText(cell.text) } : {}),
            ...(cell.header !== undefined ? { header: cell.header } : {}),
            ...(cell.align ? { align: cell.align } : {}),
            ...(cell.verticalAlign ? { verticalAlign: cell.verticalAlign } : {}),
            ...(cell.colSpan !== undefined ? { colSpan: cell.colSpan } : {}),
            ...(cell.rowSpan !== undefined ? { rowSpan: cell.rowSpan } : {}),
          })),
        ),
        ...(block.bordered !== undefined ? { bordered: block.bordered } : {}),
        ...(block.compact !== undefined ? { compact: block.compact } : {}),
        ...(block.striped !== undefined ? { striped: block.striped } : {}),
      };
    case 'math':
      return { kind: 'math', source: block.source.value };
    case 'media':
      return {
        kind: 'media',
        mediaKind: block.mediaKind,
        ...(block.attachment
          ? {
              attachment: {
                kind: block.attachment.kind,
                ...(block.attachment.spoiler !== undefined
                  ? { spoiler: block.attachment.spoiler }
                  : {}),

                name: block.attachment.name.value,
                mimeType: block.attachment.mimeType,
                ...(block.attachment.byteSize !== undefined
                  ? { size: block.attachment.byteSize }
                  : {}),
                ...(block.attachment.cacheKey ? { cacheKey: block.attachment.cacheKey } : {}),
              },
            }
          : {}),
        ...(block.id ? { id: block.id } : {}),
        ...(block.url ? { url: block.url } : {}),
        ...(block.caption
          ? {
              caption: {
                text: hydrateRichText(block.caption.text),
                ...(block.caption.credit ? { credit: hydrateRichText(block.caption.credit) } : {}),
              },
            }
          : {}),
        ...(block.spoiler !== undefined ? { spoiler: block.spoiler } : {}),
      };
    case 'group':
      return {
        kind: 'group',
        mode: block.mode,
        blocks: block.blocks.map(hydrateRichBlock),
        ...(block.caption
          ? {
              caption: {
                text: hydrateRichText(block.caption.text),
                ...(block.caption.credit ? { credit: hydrateRichText(block.caption.credit) } : {}),
              },
            }
          : {}),
      };
    case 'author':
      return {
        kind: 'author',
        author: hydrateRichText(block.author),
        publishedAt: block.publishedAt,
      };
  }
}

function validateStateForHydration(state: TvBugStateV2) {
  validateBundle({
    manifest: createTvBugManifest({
      producer: { appVersion: 'hydrate' },
      capture: { durationMs: 0, complete: true, truncated: false, tabCount: 1 },
    }),
    snapshot: state,
    trace: [],
  });
}

class StateSanitizer {
  readonly timeShifter: TimeShifter;
  private readonly dialogs: readonly (TelegramDialog | CachedDialog)[];
  private readonly messages: readonly (TelegramMessage | CachedMessage)[];
  private readonly pending: readonly PendingSend[];
  private readonly drafts: Readonly<Record<string, string>>;
  private readonly draftRevisions: Readonly<Record<string, number>>;
  private readonly pinnedMessages: Readonly<Record<string, TvBugTimedSourceV2<TelegramMessage>>>;
  private readonly groupMembers: Readonly<Record<string, TvBugTimedSourceV2<TelegramGroupMember>>>;

  constructor(
    private readonly source: TvBugStateSourceV2,
    private readonly aliases: {
      registerPeer: (rawId: string, kind?: TelegramPeer['kind']) => void;
      peer(rawId: string, kind?: TelegramPeer['kind']): string;
      get: (category: string, rawId: string) => string;
    } = createAliasBook(),
    time?: TimeShifter,
  ) {
    const workspace = source.workspace;
    this.dialogs = source.dialogs ?? workspace?.dialogs ?? [];
    this.pending = source.pending ?? workspace?.pending ?? [];
    this.drafts = source.drafts ?? workspace?.drafts ?? {};
    this.draftRevisions = source.draftRevisions ?? workspace?.draftRevisions ?? {};
    this.pinnedMessages = source.pinnedMessages ?? {};
    this.groupMembers = source.groupMembers ?? {};
    this.messages = mergeMessages(source.messages ?? [], source.histories ?? {});
    assertCollectionSize(this.dialogs.length, 'dialogs');
    assertCollectionSize(this.messages.length, 'messages');
    assertCollectionSize(this.pending.length, 'pending sends');
    assertCollectionSize(Object.keys(this.pinnedMessages).length, 'pinned message caches');
    assertCollectionSize(Object.keys(this.groupMembers).length, 'group member caches');
    this.discoverPeers();
    this.timeShifter =
      time ??
      createTimeShifter(collectTimestamps(source, this.dialogs, this.messages, this.pending));
  }

  sanitize(): TvBugStateV2 {
    const workspace = this.source.workspace;
    const epoch = finiteInteger(this.source.epoch ?? workspace?.epoch ?? 0, 'epoch');
    const safeDialogs = this.dialogs.map((dialog) => this.sanitizeDialog(dialog));
    const safeMessages = this.messages.map((message) => this.sanitizeMessage(message));
    const histories: Record<string, number[]> = {};
    for (const message of safeMessages) {
      (histories[message.peerId] ??= []).push(message.id);
    }
    for (const ids of Object.values(histories)) ids.sort((left, right) => left - right);

    const drafts: Record<string, string> = {};
    const draftMetrics: Record<string, TvBugTextMetricsV2> = {};
    for (const [peerId, text] of Object.entries(this.drafts)) {
      const safePeerId = this.peerId(peerId);
      const safeText = sanitizeTvBugText(text);
      drafts[safePeerId] = safeText.value;
      draftMetrics[safePeerId] = safeText.metrics;
    }
    const draftRevisions: Record<string, number> = {};
    for (const [peerId, revision] of Object.entries(this.draftRevisions)) {
      draftRevisions[this.peerId(peerId)] = finiteInteger(revision, 'draft revision');
    }

    const lastPeerId = this.source.lastPeerId ?? workspace?.lastPeerId;
    const pinnedMessages = this.sanitizePinnedMessages();
    const groupMembers = this.sanitizeGroupMembers();
    return {
      version: TVBUG_VERSION,
      ...(this.source.cursor ? { cursor: this.sanitizeCursor(this.source.cursor) } : {}),
      epoch,
      ...(lastPeerId ? { lastPeerId: this.peerId(lastPeerId) } : {}),
      dialogs: safeDialogs,
      messages: safeMessages,
      histories,
      drafts,
      draftMetrics,
      draftRevisions,
      pending: this.pending.map((send, index) => this.sanitizePending(send, index)),
      pinnedMessages,
      groupMembers,
      workspace: {
        ...(workspace?.accountId
          ? { accountId: this.aliases.get('account', workspace.accountId) }
          : {}),
        ...(workspace?.activePeerId ? { activePeerId: this.peerId(workspace.activePeerId) } : {}),
        ...(workspace?.phase ? { phase: workspace.phase } : {}),
        ...(workspace?.sync ? { sync: workspace.sync } : {}),
        ...(workspace?.online !== undefined ? { online: workspace.online } : {}),
      },
      runtime:
        sanitizeJsonValue(
          this.source.runtime ?? {},
          'runtime',
          this.aliases,
          this.timeShifter,
          0,
        ) ?? {},
      ...(this.source.ui ? { ui: this.sanitizeUi(this.source.ui) } : {}),
    };
  }

  private discoverPeers() {
    for (const dialog of this.dialogs) {
      this.aliases.registerPeer(dialog.peer.id, dialog.peer.kind);
      if (dialog.topMessage) this.discoverMessagePeers(dialog.topMessage);
    }
    for (const message of this.messages) this.discoverMessagePeers(message);
    for (const send of this.pending) {
      this.aliases.registerPeer(send.peer.id, send.peer.kind);
      if (send.forward)
        this.aliases.registerPeer(send.forward.fromPeer.id, send.forward.fromPeer.kind);
    }
    for (const peerId of Object.keys(this.drafts)) this.aliases.registerPeer(peerId);
    for (const peerId of Object.keys(this.draftRevisions)) this.aliases.registerPeer(peerId);
    for (const [peerId, cached] of Object.entries(this.pinnedMessages)) {
      this.aliases.registerPeer(peerId);
      for (const message of cached.value) this.discoverMessagePeers(message);
    }
    for (const [peerId, cached] of Object.entries(this.groupMembers)) {
      this.aliases.registerPeer(peerId);
      for (const member of cached.value) {
        this.aliases.registerPeer(member.peer.id, member.peer.kind);
      }
    }
    if (this.source.lastPeerId) this.aliases.registerPeer(this.source.lastPeerId);
    if (this.source.workspace?.lastPeerId)
      this.aliases.registerPeer(this.source.workspace.lastPeerId);
    if (this.source.workspace?.activePeerId) {
      this.aliases.registerPeer(this.source.workspace.activePeerId);
    }
    if (this.source.ui?.bootstrapActivePeerId) {
      this.aliases.registerPeer(this.source.ui.bootstrapActivePeerId);
    }
    if (this.source.ui?.activePeerId) this.aliases.registerPeer(this.source.ui.activePeerId);
  }

  private discoverMessagePeers(message: TelegramMessage) {
    this.aliases.registerPeer(message.peerId);
    this.aliases.registerPeer(message.senderId);
    if (message.forwardedFrom?.peerId) this.aliases.registerPeer(message.forwardedFrom.peerId);
    if (message.service?.actorId) this.aliases.registerPeer(message.service.actorId);
    for (const target of message.service?.targetUserIds ?? []) this.aliases.registerPeer(target);
    for (const mention of message.mentions ?? []) {
      if (mention.userId) this.aliases.registerPeer(mention.userId, 'user');
    }
  }

  private sanitizeCursor(cursor: SyncCursor): SyncCursor {
    return {
      pts: finiteInteger(cursor.pts, 'cursor.pts'),
      qts: finiteInteger(cursor.qts, 'cursor.qts'),
      date: this.timeShifter.shiftSeconds(cursor.date),
      seq: finiteInteger(cursor.seq, 'cursor.seq'),
    };
  }

  private sanitizePeer(peer: TelegramPeer): TvBugPeerV2 {
    return { id: this.peerId(peer.id, peer.kind), kind: peer.kind };
  }

  private sanitizeDialog(dialog: TelegramDialog | CachedDialog): TvBugDialogV2 {
    const peerId = dialog.peer.id;
    return {
      ...(dialog.unreadReactionsCount !== undefined
        ? {
            unreadReactionsCount: finiteNonNegativeInteger(
              dialog.unreadReactionsCount,
              'dialog.unreadReactionsCount',
            ),
          }
        : {}),
      ...(dialog.unreadMentionsCount !== undefined
        ? {
            unreadMentionsCount: finiteNonNegativeInteger(
              dialog.unreadMentionsCount,
              'dialog.unreadMentionsCount',
            ),
          }
        : {}),
      ...(dialog.unreadMark !== undefined ? { unreadMark: Boolean(dialog.unreadMark) } : {}),
      ...(dialog.protectedContent !== undefined
        ? { protectedContent: Boolean(dialog.protectedContent) }
        : {}),
      ...(dialog.broadcast !== undefined ? { broadcast: Boolean(dialog.broadcast) } : {}),
      ...(dialog.forum !== undefined ? { forum: Boolean(dialog.forum) } : {}),
      peer: this.sanitizePeer(dialog.peer),
      ...(dialog.transient !== undefined ? { transient: dialog.transient } : {}),
      ...(dialog.channelPts !== undefined
        ? { channelPts: finiteInteger(dialog.channelPts, 'dialog.channelPts') }
        : {}),
      title: sanitizeTvBugText(dialog.title),
      initials: sanitizeTvBugText(dialog.initials),
      color: sanitizeColor(dialog.color),
      ...(dialog.username ? { username: sanitizeTvBugText(dialog.username) } : {}),
      ...(dialog.archived !== undefined ? { archived: dialog.archived } : {}),
      topMessageId: this.messageId(peerId, dialog.topMessageId),
      ...(dialog.topMessage ? { topMessage: this.sanitizeMessage(dialog.topMessage) } : {}),
      unreadCount: finiteNonNegativeInteger(dialog.unreadCount, 'dialog.unreadCount'),
      readInboxMaxId: this.messageId(peerId, dialog.readInboxMaxId),
      readOutboxMaxId: this.messageId(peerId, dialog.readOutboxMaxId),
      muted: dialog.muted,
      pinned: dialog.pinned,
      ...(dialog.bot !== undefined ? { bot: dialog.bot } : {}),
      hasAvatar: dialog.hasAvatar,
      ...(dialog.avatarId ? { avatarId: this.aliases.get('avatar', dialog.avatarId) } : {}),
      ...(dialog.presence ? { presence: dialog.presence } : {}),
      ...(dialog.lastSeenAt !== undefined
        ? { lastSeenAt: this.timeShifter.shiftSeconds(dialog.lastSeenAt) }
        : {}),
      ...(dialog.userDetails
        ? {
            userDetails: {
              ...(dialog.userDetails.firstName
                ? { firstName: sanitizeTvBugText(dialog.userDetails.firstName) }
                : {}),
              ...(dialog.userDetails.lastName
                ? { lastName: sanitizeTvBugText(dialog.userDetails.lastName) }
                : {}),
              ...(dialog.userDetails.username
                ? { username: sanitizeTvBugText(dialog.userDetails.username) }
                : {}),
              ...(dialog.userDetails.bio ? { bio: sanitizeTvBugText(dialog.userDetails.bio) } : {}),
              ...(dialog.userDetails.isContact !== undefined
                ? { isContact: dialog.userDetails.isContact }
                : {}),
              blocked: dialog.userDetails.blocked,
            },
          }
        : {}),
      ...('cacheEpoch' in dialog
        ? { cacheEpoch: finiteInteger(dialog.cacheEpoch, 'dialog.cacheEpoch') }
        : {}),
    };
  }

  private sanitizeMessage(message: TelegramMessage | CachedMessage): TvBugMessageV2 {
    const text = sanitizeTvBugText(message.text);
    return {
      ...(message.savedPeerId !== undefined
        ? { savedPeerId: this.peerId(message.savedPeerId) }
        : {}),
      ...(message.topicId !== undefined
        ? { topicId: this.messageId(message.peerId, message.topicId) }
        : {}),
      ...(message.reactionsAsTags !== undefined
        ? { reactionsAsTags: Boolean(message.reactionsAsTags) }
        : {}),
      ...(message.protected !== undefined ? { protected: Boolean(message.protected) } : {}),
      ...(message.unreadReaction !== undefined
        ? { unreadReaction: Boolean(message.unreadReaction) }
        : {}),
      ...(message.unreadMention !== undefined
        ? { unreadMention: Boolean(message.unreadMention) }
        : {}),
      ...(message.mediaUnread !== undefined ? { mediaUnread: Boolean(message.mediaUnread) } : {}),
      id: this.messageId(message.peerId, message.id),
      peerId: this.peerId(message.peerId),
      senderId: this.peerId(message.senderId),
      ...(message.senderName ? { senderName: sanitizeTvBugText(message.senderName) } : {}),
      ...(message.senderHasAvatar !== undefined
        ? { senderHasAvatar: message.senderHasAvatar }
        : {}),
      ...(message.senderAvatarId
        ? { senderAvatarId: this.aliases.get('avatar', message.senderAvatarId) }
        : {}),
      ...(message.senderColor ? { senderColor: sanitizeColor(message.senderColor) } : {}),
      ...(message.senderColorVersion !== undefined
        ? {
            senderColorVersion: finiteInteger(
              message.senderColorVersion,
              'message.senderColorVersion',
            ),
          }
        : {}),
      ...(message.senderRole ? { senderRole: sanitizeTvBugText(message.senderRole) } : {}),
      ...(message.senderRoleKind ? { senderRoleKind: message.senderRoleKind } : {}),
      text: text.value,
      textMetrics: text.metrics,
      date: this.timeShifter.shiftSeconds(message.date),
      outgoing: message.outgoing,
      ...(message.editedAt !== undefined
        ? { editedAt: this.timeShifter.shiftSeconds(message.editedAt) }
        : {}),
      ...(message.replyToId !== undefined
        ? { replyToId: this.messageId(message.peerId, message.replyToId) }
        : {}),
      ...(message.replyQuote ? { replyQuote: sanitizeTvBugText(message.replyQuote) } : {}),
      ...(message.randomId ? { randomId: this.aliases.get('random', message.randomId) } : {}),
      ...(message.groupedId ? { groupedId: this.aliases.get('album', message.groupedId) } : {}),
      ...(message.forwardedFrom
        ? {
            forwardedFrom: {
              name: sanitizeTvBugText(message.forwardedFrom.name),
              ...(message.forwardedFrom.peerId
                ? { peerId: this.peerId(message.forwardedFrom.peerId) }
                : {}),
              ...(message.forwardedFrom.messageId !== undefined
                ? {
                    messageId: this.messageId(
                      message.forwardedFrom.peerId ?? message.peerId,
                      message.forwardedFrom.messageId,
                    ),
                  }
                : {}),
              ...(message.forwardedFrom.hasAvatar !== undefined
                ? { hasAvatar: message.forwardedFrom.hasAvatar }
                : {}),
              ...(message.forwardedFrom.avatarId
                ? { avatarId: this.aliases.get('avatar', message.forwardedFrom.avatarId) }
                : {}),
              ...(message.forwardedFrom.color ? { color: message.forwardedFrom.color } : {}),
            },
          }
        : {}),
      ...(message.service ? { service: this.sanitizeService(message.service) } : {}),
      ...(message.botKeyboard ? { botKeyboard: this.sanitizeKeyboard(message.botKeyboard) } : {}),
      ...(message.media ? { media: this.sanitizeMedia(message.media) } : {}),
      ...(message.reactions
        ? { reactions: message.reactions.map((reaction) => this.sanitizeReaction(reaction)) }
        : {}),
      ...(message.mentions
        ? { mentions: message.mentions.map((mention) => this.sanitizeMention(mention)) }
        : {}),
      ...(message.links ? { links: message.links.map((link) => this.sanitizeLink(link)) } : {}),
      ...(message.linkPreview
        ? { linkPreview: this.sanitizeLinkPreview(message.linkPreview) }
        : {}),
      ...(message.widget
        ? {
            widget: {
              width: finiteNumber(message.widget.width, 'widget.width'),
              height: finiteNumber(message.widget.height, 'widget.height'),
              isCopy: message.widget.isCopy,
            },
          }
        : {}),
      ...(message.contentDiagnostic
        ? { contentDiagnostic: sanitizeMessageContentDiagnostic(message.contentDiagnostic) }
        : {}),
      ...(message.formats ? { formats: this.sanitizeFormats(message.formats) } : {}),
      ...(message.richMessage
        ? { richMessage: this.sanitizeRichMessage(message.richMessage) }
        : {}),
      ...(message.pinned !== undefined ? { pinned: message.pinned } : {}),
      ...('cacheEpoch' in message
        ? { cacheEpoch: finiteInteger(message.cacheEpoch, 'message.cacheEpoch') }
        : {}),
    };
  }

  private sanitizeMedia(media: TelegramMedia): TvBugMediaV2 {
    return {
      ...(media.spoiler !== undefined ? { spoiler: Boolean(media.spoiler) } : {}),

      kind: media.kind,
      name: sanitizeTvBugText(media.name),
      mimeType: sanitizeMimeType(media.mimeType),
      ...(media.size !== undefined
        ? { byteSize: finiteNonNegativeInteger(media.size, 'media.size') }
        : {}),
      ...(media.width !== undefined
        ? { width: finiteNonNegativeNumber(media.width, 'media.width') }
        : {}),
      ...(media.height !== undefined
        ? { height: finiteNonNegativeNumber(media.height, 'media.height') }
        : {}),
      ...(media.duration !== undefined
        ? { duration: finiteNonNegativeNumber(media.duration, 'media.duration') }
        : {}),
      ...(media.cacheKey ? { cacheKey: this.aliases.get('media', media.cacheKey) } : {}),
    };
  }

  private sanitizeFormats(formats: readonly TelegramTextFormat[]): TvBugTextFormatV2[] {
    assertCollectionSize(formats.length, 'text formats');
    return formats.map((format) => ({
      offset: finiteNonNegativeInteger(format.offset, 'format.offset'),
      length: finiteNonNegativeInteger(format.length, 'format.length'),
      kind: format.kind,
      ...(format.userId ? { userId: this.peerId(format.userId, 'user') } : {}),
      ...(format.url ? { url: this.safeUrl(format.url) } : {}),
      ...(format.customEmojiId
        ? { customEmojiId: this.aliases.get('custom-emoji', format.customEmojiId) }
        : {}),
      ...(format.timestamp !== undefined
        ? { timestamp: this.timeShifter.shiftSeconds(format.timestamp) }
        : {}),
      ...(format.oldText ? { oldText: sanitizeTvBugText(format.oldText) } : {}),
    }));
  }

  private sanitizeReaction(reaction: TelegramReaction): TvBugReactionV2 {
    return {
      emoji: sanitizeTvBugText(reaction.emoji),
      ...(reaction.customEmojiId
        ? { customEmojiId: this.aliases.get('custom-emoji', reaction.customEmojiId) }
        : {}),
      count: finiteNonNegativeInteger(reaction.count, 'reaction.count'),
      chosen: reaction.chosen,
    };
  }

  private sanitizeMention(mention: TelegramMention): TvBugMentionV2 {
    return {
      offset: finiteNonNegativeInteger(mention.offset, 'mention.offset'),
      length: finiteNonNegativeInteger(mention.length, 'mention.length'),
      ...(mention.userId ? { userId: this.peerId(mention.userId, 'user') } : {}),
    };
  }

  private sanitizeLink(link: TelegramLink): TvBugLinkV2 {
    return {
      offset: finiteNonNegativeInteger(link.offset, 'link.offset'),
      length: finiteNonNegativeInteger(link.length, 'link.length'),
      ...(link.url ? { url: this.safeUrl(link.url) } : {}),
    };
  }

  private sanitizeLinkPreview(preview: TelegramLinkPreview): TvBugLinkPreviewV2 {
    return {
      url: this.safeUrl(preview.url),
      ...(preview.type ? { type: preview.type.slice(0, 32) } : {}),
      ...(preview.hasEmbed ? { hasEmbed: true } : {}),
      ...(preview.siteName ? { siteName: sanitizeTvBugText(preview.siteName) } : {}),
      ...(preview.title ? { title: sanitizeTvBugText(preview.title) } : {}),
      ...(preview.description ? { description: sanitizeTvBugText(preview.description) } : {}),
      ...(preview.hasPhoto !== undefined ? { hasPhoto: preview.hasPhoto } : {}),
      ...(preview.photoSize ? { photoSize: preview.photoSize } : {}),
      ...(preview.media
        ? {
            media: {
              kind: preview.media.kind,
              name: sanitizeTvBugText(preview.media.name),
              mimeType: sanitizeMimeType(preview.media.mimeType),
              ...(preview.media.size !== undefined ? { byteSize: preview.media.size } : {}),
              ...(preview.media.width !== undefined ? { width: preview.media.width } : {}),
              ...(preview.media.height !== undefined ? { height: preview.media.height } : {}),
              ...(preview.media.duration !== undefined ? { duration: preview.media.duration } : {}),
              ...(preview.media.cacheKey
                ? { cacheKey: this.aliases.get('media', preview.media.cacheKey) }
                : {}),
            },
          }
        : {}),
    };
  }

  private sanitizeService(service: TelegramServiceMessage): TvBugServiceMessageV2 {
    return {
      kind: service.kind,
      text: sanitizeTvBugText(service.text),
      ...(service.actorId ? { actorId: this.peerId(service.actorId) } : {}),
      ...(service.targetUserIds
        ? { targetUserIds: service.targetUserIds.map((id) => this.peerId(id)) }
        : {}),
      ...(service.title ? { title: sanitizeTvBugText(service.title) } : {}),
    };
  }

  private sanitizeKeyboard(keyboard: TelegramBotKeyboard): TvBugBotKeyboardV2 {
    assertCollectionSize(keyboard.rows.length, 'keyboard rows');
    return {
      kind: keyboard.kind,
      rows: keyboard.rows.map((row) => {
        assertCollectionSize(row.length, 'keyboard buttons');
        return row.map((button) => ({
          kind: button.kind,
          text: sanitizeTvBugText(button.text),
          ...(button.url ? { url: this.safeUrl(button.url) } : {}),
          ...(button.buttonId !== undefined
            ? { buttonId: finiteInteger(button.buttonId, 'button.buttonId') }
            : {}),
          ...(button.data ? { dataLength: button.data.length } : {}),
          ...(button.copyText ? { copyText: sanitizeTvBugText(button.copyText) } : {}),
          ...(button.query ? { query: sanitizeTvBugText(button.query) } : {}),
          ...(button.samePeer !== undefined ? { samePeer: button.samePeer } : {}),
          ...(button.botUsername ? { botUsername: sanitizeTvBugText(button.botUsername) } : {}),
        }));
      }),
      ...(keyboard.hidden !== undefined ? { hidden: keyboard.hidden } : {}),
      ...(keyboard.forceReply !== undefined ? { forceReply: keyboard.forceReply } : {}),
      ...(keyboard.singleUse !== undefined ? { singleUse: keyboard.singleUse } : {}),
      ...(keyboard.persistent !== undefined ? { persistent: keyboard.persistent } : {}),
      ...(keyboard.placeholder ? { placeholder: sanitizeTvBugText(keyboard.placeholder) } : {}),
    };
  }

  private sanitizePending(send: PendingSend, index: number): TvBugPendingSendV2 {
    const text = sanitizeTvBugText(send.text);
    return {
      id: this.aliases.get('pending', send.id),
      ...(send.accountId ? { accountId: this.aliases.get('account', send.accountId) } : {}),
      peer: this.sanitizePeer(send.peer),
      text: text.value,
      textMetrics: text.metrics,
      randomId: this.aliases.get('random', send.randomId),
      createdAt: this.timeShifter.shiftMilliseconds(send.createdAt),
      ...(send.queueOrder !== undefined
        ? { queueOrder: finiteInteger(send.queueOrder, 'pending.queueOrder') }
        : { queueOrder: index }),
      attempts: finiteNonNegativeInteger(send.attempts, 'pending.attempts'),
      ...(send.lastError ? { lastError: 'recorded-send-failure' as const } : {}),
      ...(send.uploadProgress !== undefined
        ? { uploadProgress: finiteNonNegativeNumber(send.uploadProgress, 'pending.uploadProgress') }
        : {}),
      ...(send.reply
        ? {
            reply: {
              ...(send.reply.topMessageId !== undefined
                ? { topMessageId: this.messageId(send.peer.id, send.reply.topMessageId) }
                : {}),
              messageId: this.messageId(send.peer.id, send.reply.messageId),
              ...(send.reply.quoteText
                ? { quoteText: sanitizeTvBugText(send.reply.quoteText) }
                : {}),
            },
          }
        : {}),
      ...(send.formats ? { formats: this.sanitizeFormats(send.formats) } : {}),
      ...(send.sticker
        ? {
            sticker: {
              id: this.aliases.get('sticker', send.sticker.id),
              emoji: sanitizeTvBugText(send.sticker.emoji),
              mimeType: sanitizeMimeType(send.sticker.mimeType),
              ...(send.sticker.size !== undefined
                ? { byteSize: finiteNonNegativeInteger(send.sticker.size, 'sticker.size') }
                : {}),
              ...(send.sticker.title ? { title: sanitizeTvBugText(send.sticker.title) } : {}),
            },
          }
        : {}),
      ...(send.forward
        ? {
            forward: {
              fromPeer: this.sanitizePeer(send.forward.fromPeer),
              messageId: this.messageId(send.forward.fromPeer.id, send.forward.messageId),
            },
          }
        : {}),
      ...(send.botStart
        ? { botStart: { startParam: sanitizeTvBugText(send.botStart.startParam) } }
        : {}),
      ...(send.attachment ? { attachment: this.sanitizeAttachment(send.attachment) } : {}),
      ...(send.album
        ? {
            album: {
              id: this.aliases.get('album', `pending:${send.id}`),
              attachments: send.album.attachments.map((attachment) =>
                this.sanitizeAttachment(attachment),
              ),
            },
          }
        : {}),
    };
  }

  private sanitizePinnedMessages(): Record<string, TvBugTimedValueV2<TvBugMessageV2[]>> {
    const result: Record<string, TvBugTimedValueV2<TvBugMessageV2[]>> = {};
    for (const [peerId, cached] of Object.entries(this.pinnedMessages)) {
      assertCollectionSize(cached.value.length, 'cached pinned messages');
      result[this.peerId(peerId)] = {
        value: cached.value.map((message) => this.sanitizeMessage(message)),
        savedAt: this.timeShifter.shiftMilliseconds(cached.savedAt),
      };
    }
    return result;
  }

  private sanitizeGroupMembers(): Record<string, TvBugTimedValueV2<TvBugGroupMemberV2[]>> {
    const result: Record<string, TvBugTimedValueV2<TvBugGroupMemberV2[]>> = {};
    for (const [peerId, cached] of Object.entries(this.groupMembers)) {
      assertCollectionSize(cached.value.length, 'cached group members');
      result[this.peerId(peerId)] = {
        value: cached.value.map((member) => this.sanitizeGroupMember(member)),
        savedAt: this.timeShifter.shiftMilliseconds(cached.savedAt),
      };
    }
    return result;
  }

  private sanitizeGroupMember(member: TelegramGroupMember): TvBugGroupMemberV2 {
    return {
      peer: this.sanitizePeer(member.peer),
      title: sanitizeTvBugText(member.title),
      initials: sanitizeTvBugText(member.initials),
      color: sanitizeColor(member.color),
      ...(member.username ? { username: sanitizeTvBugText(member.username) } : {}),
      ...(member.role ? { role: sanitizeTvBugText(member.role) } : {}),
      ...(member.roleKind ? { roleKind: member.roleKind } : {}),
      hasAvatar: member.hasAvatar,
      ...(member.avatarId ? { avatarId: this.aliases.get('avatar', member.avatarId) } : {}),
      ...(member.presence ? { presence: member.presence } : {}),
    };
  }

  private sanitizeAttachment(
    attachment:
      | PendingSend['attachment']
      | NonNullable<PendingSend['album']>['attachments'][number],
  ): TvBugPendingAttachmentV2 {
    if (!attachment) throw new TvBugFormatError('Missing pending attachment.');
    return {
      ...(attachment.duration !== undefined
        ? { duration: finiteNonNegativeNumber(attachment.duration, 'attachment.duration') }
        : {}),
      ...(attachment.height !== undefined
        ? { height: finiteNonNegativeNumber(attachment.height, 'attachment.height') }
        : {}),
      ...(attachment.width !== undefined
        ? { width: finiteNonNegativeNumber(attachment.width, 'attachment.width') }
        : {}),
      name: sanitizeTvBugText(attachment.name),
      mimeType: sanitizeMimeType(attachment.mimeType),
      byteSize: finiteNonNegativeInteger(attachment.blob.size, 'attachment size'),
      asSticker: attachment.asSticker,
      sendAs: attachment.sendAs,
      ...('randomId' in attachment
        ? { randomId: this.aliases.get('random', attachment.randomId) }
        : {}),
    };
  }

  private sanitizeUi(ui: TvBugUiSourceV2): NonNullable<TvBugStateV2['ui']> {
    return {
      ...(ui.route ? { route: sanitizeRoute(ui.route) } : {}),
      ...(ui.bootstrapActivePeerId
        ? { bootstrapActivePeerId: this.peerId(ui.bootstrapActivePeerId) }
        : {}),
      ...(ui.activePeerId ? { activePeerId: this.peerId(ui.activePeerId) } : {}),
      ...(ui.sidebarWidth !== undefined
        ? { sidebarWidth: finiteNonNegativeNumber(ui.sidebarWidth, 'ui.sidebarWidth') }
        : {}),
      ...(ui.detailsOpen !== undefined ? { detailsOpen: ui.detailsOpen } : {}),
      ...(ui.chatAppearance
        ? { chatAppearance: this.sanitizeChatAppearance(ui.chatAppearance) }
        : {}),
      ...(ui.render
        ? {
            render: sanitizeJsonValue(
              ui.render,
              'ui.render',
              this.aliases,
              undefined,
              0,
            ) as unknown as TvBugRenderState,
          }
        : {}),
      ...(ui.appearance
        ? {
            appearance: {
              ...(ui.appearance.themeId
                ? {
                    themeId: SAFE_THEME_IDS.has(ui.appearance.themeId)
                      ? ui.appearance.themeId
                      : 'night',
                  }
                : {}),
              ...(ui.appearance.chatFontSize !== undefined
                ? {
                    chatFontSize: finiteNonNegativeNumber(
                      ui.appearance.chatFontSize,
                      'ui.appearance.chatFontSize',
                    ),
                  }
                : {}),
              ...(ui.appearance.wallpaperKind
                ? { wallpaperKind: ui.appearance.wallpaperKind }
                : {}),
              ...(ui.appearance.blur !== undefined ? { blur: ui.appearance.blur } : {}),
              ...(ui.appearance.dim !== undefined
                ? { dim: finiteNonNegativeNumber(ui.appearance.dim, 'ui.appearance.dim') }
                : {}),
              ...(ui.appearance.accentColor
                ? { accentColor: sanitizeColor(ui.appearance.accentColor) }
                : {}),
              ...(ui.appearance.preferences
                ? { preferences: this.sanitizePreferences(ui.appearance.preferences) }
                : {}),
            },
          }
        : {}),
    };
  }

  private sanitizeWallpaper(wallpaper: TelegramWallpaper): TelegramWallpaper {
    return {
      id: this.aliases.get('wallpaper', wallpaper.id),
      dark: wallpaper.dark,
      pattern: wallpaper.pattern,
      hasFile: wallpaper.hasFile,
      settings: {
        backgroundColors: wallpaper.settings.backgroundColors.map(sanitizeColor),
        blur: wallpaper.settings.blur,
        motion: wallpaper.settings.motion,
        ...(wallpaper.settings.intensity !== undefined
          ? { intensity: finiteNumber(wallpaper.settings.intensity, 'wallpaper.intensity') }
          : {}),
        ...(wallpaper.settings.rotation !== undefined
          ? { rotation: finiteNumber(wallpaper.settings.rotation, 'wallpaper.rotation') }
          : {}),
      },
    };
  }

  private sanitizeChatAppearance(source: TvBugChatAppearanceState): TvBugChatAppearanceState {
    const resource = (value: TvBugResourceState): TvBugResourceState => ({
      phase: value.phase,
      waiting: value.waiting,
      hasValue: value.hasValue,
      ...(value.error ? { error: sanitizeTvBugText(value.error).value } : {}),
      ...(value.code ? { code: sanitizeSemanticString(value.code, 'code') } : {}),
    });
    const value = source.value;
    const safeValue: TelegramChatAppearance | undefined = value
      ? {
          ...(value.wallpaper ? { wallpaper: this.sanitizeWallpaper(value.wallpaper) } : {}),
          ...(value.theme
            ? {
                theme: {
                  id: this.aliases.get('theme', value.theme.id),
                  slug: '',
                  title: sanitizeTvBugText(value.theme.title).value,
                  default: value.theme.default,
                  forChat: value.theme.forChat,
                  settings: value.theme.settings.map((settings) => ({
                    baseTheme: settings.baseTheme,
                    accentColor: sanitizeColor(settings.accentColor),
                    ...(settings.outboxAccentColor
                      ? { outboxAccentColor: sanitizeColor(settings.outboxAccentColor) }
                      : {}),
                    messageColors: settings.messageColors.map(sanitizeColor),
                    messageColorsAnimated: settings.messageColorsAnimated,
                    ...(settings.wallpaper
                      ? { wallpaper: this.sanitizeWallpaper(settings.wallpaper) }
                      : {}),
                  })),
                },
              }
            : {}),
        }
      : undefined;
    return {
      ...(source.peerId ? { peerId: this.peerId(source.peerId) } : {}),
      ...(safeValue ? { value: safeValue } : {}),
      appearance: resource(source.appearance),
      wallpaper: {
        ...resource(source.wallpaper),
        ...(source.wallpaper.byteSize !== undefined
          ? { byteSize: finiteNonNegativeInteger(source.wallpaper.byteSize, 'wallpaper.byteSize') }
          : {}),
        ...(source.wallpaper.mimeType
          ? { mimeType: sanitizeMimeType(source.wallpaper.mimeType) }
          : {}),
      },
      pattern: source.pattern,
      ...(source.selectedBaseTheme ? { selectedBaseTheme: source.selectedBaseTheme } : {}),
      ...(source.cache
        ? {
            cache: {
              ...(source.cache.metadataPresent !== undefined
                ? { metadataPresent: source.cache.metadataPresent }
                : {}),
              ...(source.cache.metadataAgeMs !== undefined
                ? {
                    metadataAgeMs: finiteNonNegativeNumber(
                      source.cache.metadataAgeMs,
                      'cache.metadataAgeMs',
                    ),
                  }
                : {}),
              ...(source.cache.wallpaperPresent !== undefined
                ? { wallpaperPresent: source.cache.wallpaperPresent }
                : {}),
              ...(source.cache.inspectionFailed ? { inspectionFailed: true } : {}),
            },
          }
        : {}),
    };
  }

  private sanitizePreferences(source: ThemePreferences): ThemePreferences {
    const value = normalizeThemePreferences(source);
    return {
      ...value,
      ...(value.telegramTheme
        ? {
            telegramTheme: {
              ...value.telegramTheme,
              id: this.aliases.get('theme', value.telegramTheme.id),
              title: sanitizeTvBugText(value.telegramTheme.title).value,
            },
          }
        : {}),
      ...(value.telegramWallpaper
        ? {
            telegramWallpaper: {
              ...value.telegramWallpaper,
              id: this.aliases.get('wallpaper', value.telegramWallpaper.id),
              label: sanitizeTvBugText(value.telegramWallpaper.label).value,
            },
          }
        : {}),
    };
  }

  private sanitizeRichMessage(message: RichMessage): TvBugRichMessageV2 {
    assertCollectionSize(message.blocks.length, 'rich message blocks');
    return {
      blocks: message.blocks.map((block) => this.sanitizeRichBlock(block, 0)),
      ...(message.rtl !== undefined ? { rtl: message.rtl } : {}),
      ...(message.partial !== undefined ? { partial: message.partial } : {}),
    };
  }

  private sanitizeRichText(text: RichText, depth: number): TvBugRichTextV2 {
    assertNestingDepth(depth);
    switch (text.kind) {
      case 'button':
        return {
          kind: 'button',
          child: this.sanitizeRichText(text.child, depth + 1),
          button: this.sanitizeKeyboard({ kind: 'inline', rows: [[text.button]] }).rows[0]![0]!,
        };
      case 'text':
        return { kind: 'text', text: sanitizeTvBugText(text.text) };
      case 'concat':
        assertCollectionSize(text.children.length, 'rich text children');
        return {
          kind: 'concat',
          children: text.children.map((child) => this.sanitizeRichText(child, depth + 1)),
        };
      case 'command':
        return this.sanitizeRichText(text.child, depth + 1);
      case 'link':
        return {
          kind: 'link',
          child: this.sanitizeRichText(text.child, depth + 1),
          url: this.safeUrl(text.url),
        };
      case 'anchor':
        return {
          kind: 'anchor',
          child: this.sanitizeRichText(text.child, depth + 1),
          name: sanitizeTvBugText(text.name),
        };
      case 'customEmoji':
        return {
          kind: 'customEmoji',
          alt: sanitizeTvBugText(text.alt),
          documentId: this.aliases.get('custom-emoji', text.documentId),
        };
      case 'math':
        return { kind: 'math', source: sanitizeTvBugText(text.source) };
      case 'date':
        return {
          kind: 'date',
          child: this.sanitizeRichText(text.child, depth + 1),
          timestamp: this.timeShifter.shiftSeconds(text.timestamp),
        };
      case 'bold':
      case 'code':
      case 'diff':
      case 'italic':
      case 'marked':
      case 'spoiler':
      case 'strike':
      case 'subscript':
      case 'superscript':
      case 'underline':
        return {
          kind: text.kind,
          child: this.sanitizeRichText(text.child, depth + 1),
          ...(text.oldText ? { oldText: this.sanitizeRichText(text.oldText, depth + 1) } : {}),
        };
    }
  }

  private sanitizeRichBlock(block: RichBlock, depth: number): TvBugRichBlockV2 {
    assertNestingDepth(depth);
    switch (block.kind) {
      case 'buttons':
        return {
          kind: 'buttons',
          align: block.align,
          buttons: this.sanitizeKeyboard({ kind: 'inline', rows: [block.buttons] }).rows[0]!,
        };
      case 'text':
        return {
          kind: 'text',
          role: block.role,
          text: this.sanitizeRichText(block.text, depth + 1),
        };
      case 'heading':
        return {
          kind: 'heading',
          level: block.level,
          text: this.sanitizeRichText(block.text, depth + 1),
        };
      case 'pre':
        return {
          kind: 'pre',
          text: this.sanitizeRichText(block.text, depth + 1),
          ...(block.language ? { language: sanitizeTvBugText(block.language) } : {}),
        };
      case 'divider':
        return { kind: 'divider' };
      case 'anchor':
        return { kind: 'anchor', name: sanitizeTvBugText(block.name) };
      case 'list':
        assertCollectionSize(block.items.length, 'rich list items');
        return {
          kind: 'list',
          ordered: block.ordered,
          ...(block.reversed !== undefined ? { reversed: block.reversed } : {}),
          ...(block.start !== undefined ? { start: block.start } : {}),
          items: block.items.map((item) => ({
            ...(item.text ? { text: this.sanitizeRichText(item.text, depth + 1) } : {}),
            ...(item.blocks
              ? { blocks: item.blocks.map((child) => this.sanitizeRichBlock(child, depth + 1)) }
              : {}),
            ...(item.checked !== undefined ? { checked: item.checked } : {}),
            ...(item.checkbox !== undefined ? { checkbox: item.checkbox } : {}),
            ...(item.marker ? { marker: sanitizeTvBugText(item.marker) } : {}),
            ...(item.value !== undefined ? { value: item.value } : {}),
          })),
        };
      case 'quote':
        return {
          kind: 'quote',
          blocks: block.blocks.map((child) => this.sanitizeRichBlock(child, depth + 1)),
          ...(block.caption ? { caption: this.sanitizeRichText(block.caption, depth + 1) } : {}),
          ...(block.pull !== undefined ? { pull: block.pull } : {}),
          ...(block.expandable !== undefined ? { expandable: block.expandable } : {}),
        };
      case 'details':
        return {
          kind: 'details',
          title: this.sanitizeRichText(block.title, depth + 1),
          blocks: block.blocks.map((child) => this.sanitizeRichBlock(child, depth + 1)),
          ...(block.open !== undefined ? { open: block.open } : {}),
        };
      case 'table':
        return {
          kind: 'table',
          ...(block.title ? { title: this.sanitizeRichText(block.title, depth + 1) } : {}),
          rows: block.rows.map((row) =>
            row.map((cell) => ({
              ...(cell.text ? { text: this.sanitizeRichText(cell.text, depth + 1) } : {}),
              ...(cell.header !== undefined ? { header: cell.header } : {}),
              ...(cell.align ? { align: cell.align } : {}),
              ...(cell.verticalAlign ? { verticalAlign: cell.verticalAlign } : {}),
              ...(cell.colSpan !== undefined ? { colSpan: cell.colSpan } : {}),
              ...(cell.rowSpan !== undefined ? { rowSpan: cell.rowSpan } : {}),
            })),
          ),
          ...(block.bordered !== undefined ? { bordered: block.bordered } : {}),
          ...(block.compact !== undefined ? { compact: block.compact } : {}),
          ...(block.striped !== undefined ? { striped: block.striped } : {}),
        };
      case 'math':
        return { kind: 'math', source: sanitizeTvBugText(block.source) };
      case 'media':
        return {
          kind: 'media',
          mediaKind: block.mediaKind,
          ...(block.attachment ? { attachment: this.sanitizeMedia(block.attachment) } : {}),
          ...(block.id ? { id: this.aliases.get('rich-media', block.id) } : {}),
          ...(block.url ? { url: this.safeUrl(block.url) } : {}),
          ...(block.caption
            ? {
                caption: {
                  text: this.sanitizeRichText(block.caption.text, depth + 1),
                  ...(block.caption.credit
                    ? { credit: this.sanitizeRichText(block.caption.credit, depth + 1) }
                    : {}),
                },
              }
            : {}),
          ...(block.spoiler !== undefined ? { spoiler: block.spoiler } : {}),
        };
      case 'group':
        return {
          kind: 'group',
          mode: block.mode,
          blocks: block.blocks.map((child) => this.sanitizeRichBlock(child, depth + 1)),
          ...(block.caption
            ? {
                caption: {
                  text: this.sanitizeRichText(block.caption.text, depth + 1),
                  ...(block.caption.credit
                    ? { credit: this.sanitizeRichText(block.caption.credit, depth + 1) }
                    : {}),
                },
              }
            : {}),
        };
      case 'author':
        return {
          kind: 'author',
          author: this.sanitizeRichText(block.author, depth + 1),
          publishedAt: this.timeShifter.shiftSeconds(block.publishedAt),
        };
    }
  }

  private peerId(rawId: string, kind?: TelegramPeer['kind']): string {
    return this.aliases.peer(rawId, kind);
  }

  private messageId(peerId: string, rawId: number): number {
    void peerId;
    return finiteInteger(rawId, 'message id');
  }

  private safeUrl(rawUrl: string): string {
    return `https://example.invalid/${this.aliases.get('url', rawUrl)}`;
  }
}

function createAliasBook() {
  const maps = new Map<string, Map<string, string>>();
  const peerKinds = new Map<string, TelegramPeer['kind']>();
  const registerPeer = (rawId: string, kind?: TelegramPeer['kind']) => {
    const inferred =
      kind ?? (rawId.startsWith('g:') ? 'group' : rawId.startsWith('c:') ? 'channel' : undefined);
    if (inferred && !peerKinds.has(rawId)) peerKinds.set(rawId, inferred);
  };
  const get = (category: string, rawId: string) => {
    let aliases = maps.get(category);
    if (!aliases) {
      aliases = new Map();
      maps.set(category, aliases);
    }
    const existing = aliases.get(rawId);
    if (existing) return existing;
    const alias = `${category}:${aliases.size + 1}`;
    aliases.set(rawId, alias);
    return alias;
  };
  return {
    registerPeer,
    peer(rawId: string, kind?: TelegramPeer['kind']) {
      registerPeer(rawId, kind);
      const resolvedKind = peerKinds.get(rawId) ?? 'user';
      return get(resolvedKind === 'user' ? 'u' : resolvedKind === 'group' ? 'g' : 'c', rawId);
    },
    get,
  };
}

type AliasBook = ReturnType<typeof createAliasBook>;

function createTimeShifter(values: readonly number[], sourceEpochMs?: number) {
  const epoch =
    sourceEpochMs !== undefined
      ? finiteNumber(sourceEpochMs, 'sourceEpochMs')
      : values.length
        ? Math.floor(Math.min(...values.map(timestampToMilliseconds)) / 1_000) * 1_000
        : 0;
  return {
    shiftSeconds(value: number) {
      finiteNumber(value, 'timestamp');
      return TVBUG_FIXED_EPOCH_SECONDS + (value * 1_000 - epoch) / 1_000;
    },
    shiftMilliseconds(value: number) {
      finiteNumber(value, 'timestamp');
      return TVBUG_FIXED_EPOCH_SECONDS * 1_000 + (value - epoch);
    },
  };
}

type TimeShifter = ReturnType<typeof createTimeShifter>;

function mergeMessages(
  flat: readonly (TelegramMessage | CachedMessage)[],
  histories: Readonly<Record<string, readonly (TelegramMessage | CachedMessage)[]>>,
): Array<TelegramMessage | CachedMessage> {
  const messages = new Map<string, TelegramMessage | CachedMessage>();
  for (const message of flat) messages.set(`${message.peerId}\0${message.id}`, message);
  for (const history of Object.values(histories)) {
    assertCollectionSize(history.length, 'history messages');
    for (const message of history) messages.set(`${message.peerId}\0${message.id}`, message);
  }
  return [...messages.values()];
}

function collectTimestamps(
  source: TvBugStateSourceV2,
  dialogs: readonly (TelegramDialog | CachedDialog)[],
  messages: readonly (TelegramMessage | CachedMessage)[],
  pending: readonly PendingSend[],
): number[] {
  const result: number[] = [];
  const seconds = (value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) result.push(value * 1_000);
  };
  const milliseconds = (value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) result.push(value);
  };
  seconds(source.cursor?.date);
  for (const dialog of dialogs) {
    seconds(dialog.lastSeenAt);
    if (dialog.topMessage) collectMessageTimestamps(dialog.topMessage, seconds);
  }
  for (const message of messages) collectMessageTimestamps(message, seconds);
  for (const send of pending) milliseconds(send.createdAt);
  for (const cached of Object.values(source.pinnedMessages ?? {})) {
    milliseconds(cached.savedAt);
    for (const message of cached.value) collectMessageTimestamps(message, seconds);
  }
  for (const cached of Object.values(source.groupMembers ?? {})) {
    milliseconds(cached.savedAt);
  }
  return result;
}

function collectMessageTimestamps(
  message: TelegramMessage,
  addSeconds: (value: number | undefined) => void,
) {
  addSeconds(message.date);
  addSeconds(message.editedAt);
  for (const format of message.formats ?? []) addSeconds(format.timestamp);
  if (message.richMessage) collectRichBlockTimestamps(message.richMessage.blocks, addSeconds, 0);
}

function collectRichBlockTimestamps(
  blocks: readonly RichBlock[],
  addSeconds: (value: number | undefined) => void,
  depth: number,
) {
  assertNestingDepth(depth);
  for (const block of blocks) {
    if (block.kind === 'author') addSeconds(block.publishedAt);
    if (block.kind === 'list') {
      for (const item of block.items) {
        if (item.blocks) collectRichBlockTimestamps(item.blocks, addSeconds, depth + 1);
      }
    } else if (block.kind === 'quote' || block.kind === 'details' || block.kind === 'group') {
      collectRichBlockTimestamps(block.blocks, addSeconds, depth + 1);
    }
  }
}

function sanitizeJsonValue(
  value: unknown,
  context: string,
  aliases: AliasBook,
  time: TimeShifter | undefined,
  depth: number,
): TvBugJsonValue | undefined {
  assertNestingDepth(depth);
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    finiteNumber(value, context);
    const key = normalizeKey(lastPathPart(context));
    if (/\.birthday\.(?:day|month|year)$/iu.test(context)) {
      return key === 'year' ? 2000 : 1;
    }
    if (time && /(?:date|editedat|lastseenat|timestamp|publishedat)$/u.test(key)) {
      return time.shiftSeconds(value);
    }
    if (time && /(?:createdat|savedat|retryat)(?:ms)?$/u.test(key)) {
      return time.shiftMilliseconds(value);
    }
    return value;
  }
  if (typeof value === 'bigint') {
    return aliases.get(aliasCategory(context), value.toString());
  }
  if (typeof value === 'string') {
    assertTextSize(value, context);
    const key = normalizeKey(lastPathPart(context));
    if (key === 'url') return `https://example.invalid/${aliases.get('url', value)}`;
    if (key.includes('color')) return sanitizeColor(value);
    if (
      [
        'peerid',
        'activepeerid',
        'bootstrapactivepeerid',
        'senderid',
        'userid',
        'actorid',
        'targetuserids',
      ].includes(key)
    ) {
      return aliases.peer(value);
    }
    if (key === 'accountid') return aliases.get('account', value);
    if (isIdentifierKey(key)) return aliases.get(aliasCategory(context), value);
    if (key === 'role' && /richmessage.*blocks.*\.role$/iu.test(context)) {
      return sanitizeSemanticString(value, key);
    }
    if (isSemanticStringKey(key)) return sanitizeSemanticString(value, key);
    return sanitizeTvBugText(value).value;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Blob) {
    throw new TvBugFormatError(`${context} contains raw binary data.`);
  }
  if (Array.isArray(value)) {
    assertCollectionSize(value.length, context);
    const result: TvBugJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const safe = sanitizeJsonValue(
        value[index],
        `${context}[${index}]`,
        aliases,
        time,
        depth + 1,
      );
      if (safe !== undefined) result.push(safe);
    }
    return result;
  }
  if (!isPlainObject(value)) throw new TvBugFormatError(`${context} is not safe JSON data.`);
  const peer =
    typeof value.id === 'string' &&
    (value.kind === 'user' || value.kind === 'group' || value.kind === 'channel')
      ? { id: value.id, kind: value.kind as TelegramPeer['kind'] }
      : undefined;
  if (peer) aliases.registerPeer(peer.id, peer.kind);
  const entries = Object.entries(value);
  assertCollectionSize(entries.length, `${context} fields`);
  const result: Record<string, TvBugJsonValue> = {};
  for (const [key, child] of entries) {
    if (isForbiddenField(key, child)) {
      throw new TvBugFormatError(`${context}.${key} is forbidden in a .tvbug bundle.`);
    }
    const safe =
      peer && key === 'id'
        ? aliases.peer(peer.id, peer.kind)
        : sanitizeJsonValue(child, `${context}.${key}`, aliases, time, depth + 1);
    const safeKey =
      normalizeKey(lastPathPart(context)) === 'draftdetails' ? aliases.peer(key) : key;
    if (safe !== undefined) result[safeKey] = safe;
  }
  if (
    typeof value.id === 'number' &&
    typeof value.peerId === 'string' &&
    typeof value.text === 'string' &&
    typeof value.date === 'number' &&
    typeof value.outgoing === 'boolean'
  ) {
    const safeText = typeof result.text === 'string' ? result.text : '';
    const metrics = measureText(safeText);
    result.textMetrics = {
      utf16Length: metrics.utf16Length,
      graphemeCount: metrics.graphemeCount,
      lineCount: metrics.lineCount,
      lineUtf16Lengths: metrics.lineUtf16Lengths,
    };
  }
  return result;
}

function synthesizeCodePoint(value: string): string {
  if (/\p{White_Space}/u.test(value)) return value;
  const codePoint = value.codePointAt(0) ?? 0;
  if (
    (codePoint >= 0x200c && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfe0e ||
    codePoint === 0xfe0f
  ) {
    return value;
  }
  if (/\p{Mark}/u.test(value)) return value.length === 2 ? '\u{1d165}' : '\u0301';
  if (/\p{Punctuation}/u.test(value)) return value;
  if (/\p{Decimal_Number}/u.test(value)) return value.length === 2 ? '\u{1d7ce}' : '0';
  if (/\p{Regional_Indicator}/u.test(value)) return '🇦';
  if (/\p{Emoji_Modifier}/u.test(value)) return value;
  if (/\p{Script=Arabic}/u.test(value)) return value.length === 2 ? '𞸀' : 'ش';
  if (/\p{Script=Hebrew}/u.test(value)) return value.length === 2 ? '𞸀' : 'א';
  if (/\p{Script=Cyrillic}/u.test(value)) return value.length === 2 ? '😀' : 'ж';
  if (/\p{Script=Greek}/u.test(value)) return value.length === 2 ? '😀' : 'α';
  if (/\p{Script=Han}/u.test(value)) return value.length === 2 ? '𠀀' : '界';
  if (/\p{Script=Hangul}/u.test(value)) return value.length === 2 ? '😀' : '한';
  if (/\p{Script=Hiragana}/u.test(value)) return value.length === 2 ? '😀' : 'あ';
  if (/\p{Script=Katakana}/u.test(value)) return value.length === 2 ? '😀' : 'ア';
  if (/\p{Script=Devanagari}/u.test(value)) return value.length === 2 ? '😀' : 'क';
  if (/\p{Script=Thai}/u.test(value)) return value.length === 2 ? '😀' : 'ก';
  if (/\p{Script=Latin}/u.test(value)) {
    if (value.length === 2) return '😀';
    return value.toLocaleUpperCase() === value && value.toLocaleLowerCase() !== value ? 'A' : 'a';
  }
  if (/\p{Extended_Pictographic}/u.test(value)) return value.length === 2 ? '😀' : '★';
  if (/\p{Symbol}/u.test(value)) return value.length === 2 ? '😀' : '•';
  return value.length === 2 ? '😀' : 'x';
}

function countGraphemes(value: string): number {
  const Segmenter = Intl.Segmenter;
  if (Segmenter)
    return [...new Segmenter('und', { granularity: 'grapheme' }).segment(value)].length;
  return Array.from(value).length;
}

function validateBundle(value: unknown): asserts value is TvBugBundleV2 {
  const bundle = requireRecord(value, 'bundle');
  requireExactKeys(bundle, ['manifest', 'snapshot', 'trace'], 'bundle');
  const manifest = requireRecord(bundle.manifest, 'manifest');
  if (manifest.format !== TVBUG_FORMAT || manifest.version !== TVBUG_VERSION) {
    throw new TvBugFormatError('Unsupported .tvbug format or version.');
  }
  const privacy = requireRecord(manifest.privacy, 'manifest.privacy');
  if (
    privacy.profile !== 'account-free-v2' ||
    privacy.rawText !== false ||
    privacy.rawMedia !== false ||
    privacy.stableIdentifiers !== false ||
    privacy.authMaterial !== false
  ) {
    throw new TvBugFormatError('The .tvbug privacy declaration is missing or unsafe.');
  }
  if (manifest.environment !== undefined) {
    const environment = requireRecord(manifest.environment, 'manifest.environment');
    if (
      environment.timezone !== undefined &&
      (typeof environment.timezone !== 'string' || !isValidTimeZone(environment.timezone))
    ) {
      throw new TvBugFormatError('manifest.environment.timezone is invalid.');
    }
  }
  const state = requireRecord(bundle.snapshot, 'snapshot');
  if (state.version !== TVBUG_VERSION) throw new TvBugFormatError('Unsupported state version.');
  requireRecord(state.runtime, 'state.runtime');
  if (
    !Array.isArray(state.dialogs) ||
    !Array.isArray(state.messages) ||
    !Array.isArray(state.pending)
  ) {
    throw new TvBugFormatError('State collections are malformed.');
  }
  assertCollectionSize(state.dialogs.length, 'state.dialogs');
  assertCollectionSize(state.messages.length, 'state.messages');
  assertCollectionSize(state.pending.length, 'state.pending');
  requireRecord(state.pinnedMessages, 'state.pinnedMessages');
  requireRecord(state.groupMembers, 'state.groupMembers');
  if (state.ui !== undefined) {
    const ui = requireRecord(state.ui, 'state.ui');
    if (ui.chatAppearance !== undefined) validateChatAppearance(ui.chatAppearance);
  }
  for (const [index, raw] of state.messages.entries()) validateMessage(raw, index);
  let pendingAttachmentBytes = 0;
  for (const [index, raw] of state.pending.entries()) {
    pendingAttachmentBytes += validatePending(raw, index);
    if (pendingAttachmentBytes > MAX_SYNTHETIC_ATTACHMENT_BYTES) {
      throw new TvBugFormatError(
        'Pending attachments exceed the 256 MiB aggregate materialization limit.',
      );
    }
  }
  if (!Array.isArray(bundle.trace)) throw new TvBugFormatError('Trace must be an array.');
  if (bundle.trace.length > MAX_TRACE_EVENTS) {
    throw new TvBugFormatError('Trace exceeds 300 events.');
  }
  let priorSeq = -1;
  let priorTime = -1;
  for (const [index, raw] of bundle.trace.entries()) {
    const event = requireRecord(raw, `trace[${index}]`);
    const seq = finiteNonNegativeInteger(event.seq, `trace[${index}].seq`);
    const tMs = finiteNonNegativeNumber(event.tMs, `trace[${index}].tMs`);
    if (seq <= priorSeq) throw new TvBugFormatError('Trace sequence numbers must increase.');
    if (tMs < priorTime) throw new TvBugFormatError('Trace times must not move backward.');
    if (!['ui', 'diagnostic'].includes(String(event.kind))) {
      throw new TvBugFormatError(`Unknown trace kind at event ${index}.`);
    }
    priorSeq = seq;
    priorTime = tMs;
  }
  auditSafeJson(bundle, 'bundle', 0);
}

function validateChatAppearance(value: unknown) {
  const state = requireRecord(value, 'ui.chatAppearance');
  for (const key of ['appearance', 'wallpaper']) {
    const resource = requireRecord(state[key], `chatAppearance.${key}`);
    if (
      !['idle', 'loading', 'ready', 'error'].includes(String(resource.phase)) ||
      typeof resource.waiting !== 'boolean' ||
      typeof resource.hasValue !== 'boolean'
    ) {
      throw new TvBugFormatError('Invalid captured appearance resource state.');
    }
  }
  if (!['none', 'normal', 'inverted'].includes(String(state.pattern))) {
    throw new TvBugFormatError('Invalid captured wallpaper pattern mode.');
  }
  const colors = (value: unknown) => {
    if (
      !Array.isArray(value) ||
      value.length > 4 ||
      value.some((color) => typeof color !== 'string' || sanitizeColor(color) !== color)
    ) {
      throw new TvBugFormatError('Invalid captured appearance colors.');
    }
  };
  const wallpaper = (value: unknown) => {
    const item = requireRecord(value, 'captured wallpaper');
    requireString(item.id, 'wallpaper.id');
    for (const key of ['dark', 'pattern', 'hasFile']) {
      if (typeof item[key] !== 'boolean')
        throw new TvBugFormatError('Invalid captured wallpaper flags.');
    }
    const settings = requireRecord(item.settings, 'wallpaper.settings');
    colors(settings.backgroundColors);
    for (const key of ['intensity', 'rotation']) {
      if (settings[key] !== undefined) finiteNumber(settings[key], `wallpaper.${key}`);
    }
  };
  if (state.value === undefined) return;
  const appearance = requireRecord(state.value, 'chatAppearance.value');
  if (appearance.wallpaper !== undefined) wallpaper(appearance.wallpaper);
  if (appearance.theme !== undefined) {
    const theme = requireRecord(appearance.theme, 'chatAppearance.theme');
    if (!Array.isArray(theme.settings) || theme.settings.length > 16)
      throw new TvBugFormatError('Invalid captured theme settings.');
    for (const raw of theme.settings) {
      const settings = requireRecord(raw, 'theme.settings');
      if (!SAFE_SEMANTIC_VALUES.basetheme!.has(String(settings.baseTheme)))
        throw new TvBugFormatError('Invalid captured base theme.');
      colors([settings.accentColor]);
      if (settings.outboxAccentColor !== undefined) colors([settings.outboxAccentColor]);
      colors(settings.messageColors);
      if (settings.wallpaper !== undefined) wallpaper(settings.wallpaper);
    }
  }
}

function validatePending(value: unknown, index: number): number {
  const pending = requireRecord(value, `state.pending[${index}]`);
  let byteSize = 0;
  if (pending.attachment !== undefined) {
    byteSize += validatePendingAttachment(pending.attachment, `state.pending[${index}].attachment`);
  }
  if (pending.album !== undefined) {
    const album = requireRecord(pending.album, `state.pending[${index}].album`);
    if (!Array.isArray(album.attachments)) {
      throw new TvBugFormatError(`state.pending[${index}].album.attachments must be an array.`);
    }
    assertCollectionSize(album.attachments.length, `state.pending[${index}].album.attachments`);
    album.attachments.forEach((attachment, attachmentIndex) => {
      byteSize += validatePendingAttachment(
        attachment,
        `state.pending[${index}].album.attachments[${attachmentIndex}]`,
      );
    });
  }
  return byteSize;
}

function validatePendingAttachment(value: unknown, context: string): number {
  const attachment = requireRecord(value, context);
  const byteSize = finiteNonNegativeInteger(attachment.byteSize, `${context}.byteSize`);
  if (byteSize > MAX_SYNTHETIC_ATTACHMENT_BYTES) {
    throw new TvBugFormatError(`${context}.byteSize exceeds the 256 MiB materialization limit.`);
  }
  return byteSize;
}

function validateMessage(value: unknown, index: number) {
  const message = requireRecord(value, `state.messages[${index}]`);
  const text = requireString(message.text, `state.messages[${index}].text`);
  validateMetrics(text, message.textMetrics, `state.messages[${index}].textMetrics`);
  if (message.media !== undefined) {
    const media = requireRecord(message.media, `state.messages[${index}].media`);
    for (const key of ['byteSize', 'width', 'height', 'duration']) {
      if (media[key] !== undefined) finiteNonNegativeNumber(media[key], `media.${key}`);
    }
  }
}

function validateMetrics(value: string, raw: unknown, context: string) {
  const metrics = requireRecord(raw, context);
  const measured = measureText(value);
  if (
    metrics.utf16Length !== measured.utf16Length ||
    metrics.graphemeCount !== measured.graphemeCount ||
    metrics.lineCount !== measured.lineCount ||
    !Array.isArray(metrics.lineUtf16Lengths) ||
    metrics.lineUtf16Lengths.length !== measured.lineUtf16Lengths.length ||
    metrics.lineUtf16Lengths.some((length, index) => length !== measured.lineUtf16Lengths[index])
  ) {
    throw new TvBugFormatError(`${context} does not match its generated text.`);
  }
}

function auditSafeJson(value: unknown, context: string, depth: number) {
  assertNestingDepth(depth);
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') {
    finiteNumber(value, context);
    return;
  }
  if (Array.isArray(value)) {
    assertCollectionSize(value.length, context);
    value.forEach((child, index) => auditSafeJson(child, `${context}[${index}]`, depth + 1));
    return;
  }
  const record = requireRecord(value, context);
  if (
    typeof record.value === 'string' &&
    record.metrics !== undefined &&
    Object.keys(record).every((key) => key === 'value' || key === 'metrics')
  ) {
    validateMetrics(record.value, record.metrics, `${context}.metrics`);
  }
  for (const [key, child] of Object.entries(record)) {
    if (isForbiddenField(key, child)) {
      throw new TvBugFormatError(`${context}.${key} is forbidden in a .tvbug bundle.`);
    }
    const normalized = normalizeKey(key);
    if (
      normalized === 'url' &&
      (typeof child !== 'string' || !/^https:\/\/example\.invalid\/[a-z0-9-]+:\d+$/u.test(child))
    ) {
      throw new TvBugFormatError(`${context}.${key} contains an unsafe URL.`);
    }
    if (
      normalized === 'datalength' &&
      finiteNonNegativeInteger(child, `${context}.${key}`) > MAX_CALLBACK_DATA_LENGTH
    ) {
      throw new TvBugFormatError(`${context}.${key} exceeds the callback data limit.`);
    }
    auditSafeJson(child, `${context}.${key}`, depth + 1);
  }
}

function assertFileSizes(manifest: number, state: number, trace: number) {
  if (manifest > MAX_MANIFEST_BYTES) throw new TvBugFormatError('manifest.json exceeds 256 KiB.');
  if (state > MAX_SNAPSHOT_BYTES) throw new TvBugFormatError('snapshot.v2.json exceeds 8 MiB.');
  if (trace > MAX_TRACE_BYTES) {
    throw new TvBugFormatError('trace.v2.ndjson exceeds 1 MiB.');
  }
  if (manifest + state + trace > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw new TvBugFormatError('The uncompressed .tvbug bundle exceeds 10 MiB.');
  }
}

function parseJsonFile(value: Uint8Array, name: string): unknown {
  return parseJsonText(decodeUtf8(value, name), name);
}

function parseJsonText(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new TvBugFormatError(`Malformed JSON in ${name}: ${errorMessage(error)}`);
  }
}

function decodeUtf8(value: Uint8Array, name: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch (error) {
    throw new TvBugFormatError(`Invalid UTF-8 in ${name}: ${errorMessage(error)}`);
  }
}

function sanitizeColor(value: string): string {
  return /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.% ,/+-]+\))$/iu.test(value) ? value : '#765cff';
}

function sanitizeMimeType(value: string): string {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(value)
    ? value.toLowerCase()
    : 'application/octet-stream';
}

function sanitizeRoute(value: string): string {
  return /^\/[a-z0-9/_-]{0,200}$/u.test(value) ? value.replace(/[0-9]+/gu, '1') : '/';
}

function sanitizeSemanticString(value: string, key: string): string {
  const maximum = key === 'method' || key === 'code' ? 160 : 80;
  if (value.length > maximum || !/^[a-z0-9_.:/+-]+$/iu.test(value)) return 'redacted';
  const allowed =
    SAFE_SEMANTIC_VALUES[key] ??
    (key.endsWith('rolekind')
      ? SAFE_SEMANTIC_VALUES.rolekind
      : key.endsWith('kind')
        ? SAFE_SEMANTIC_VALUES.kind
        : undefined);
  if (allowed && !allowed.has(value)) return 'redacted';
  return value;
}

function isSemanticStringKey(key: string): boolean {
  return (
    [
      'area',
      'align',
      'basetheme',
      'category',
      'code',
      'color',
      'direction',
      'kind',
      'level',
      'method',
      'mimetype',
      'mode',
      'phase',
      'pattern',
      'source',
      'focusedcontrol',
      'photosize',
      'presence',
      'sendas',
      'sync',
      'type',
      'verticalalign',
    ].includes(key) || key.endsWith('kind')
  );
}

function isForbiddenField(key: string, value: unknown): boolean {
  const normalized = normalizeKey(key);
  if (
    (normalized === 'authmaterial' || normalized === 'rawtext' || normalized === 'rawmedia') &&
    value === false
  ) {
    return false;
  }
  if (normalized === 'requestphonenumber' && typeof value === 'boolean') return false;
  if (FORBIDDEN_KEYS.has(normalized)) return true;
  return [
    'accesshash',
    'apikey',
    'apihash',
    'auth',
    'credential',
    'filereference',
    'password',
    'phone',
    'secret',
    'session',
    'token',
  ].some((fragment) => normalized.includes(fragment));
}

function isIdentifierKey(key: string): boolean {
  return key === 'id' || key.endsWith('id') || key.endsWith('key');
}

function aliasCategory(context: string): string {
  const key = normalizeKey(lastPathPart(context));
  if (key === 'id' && /wallpaper/iu.test(context)) return 'wallpaper';
  if (key === 'id' && /theme/iu.test(context)) return 'theme';
  if (key === 'id' && /sticker/iu.test(context)) return 'sticker';
  if (key === 'id' && /emoji/iu.test(context)) return 'custom-emoji';
  if (key === 'id' && /(?:^|\.)(?:peer|frompeer)\.id$/iu.test(context)) return 'peer';
  if (['peerid', 'senderid', 'userid', 'actorid'].includes(key)) return 'peer';
  if (key === 'accountid') return 'account';
  if (key === 'randomid') return 'random';
  if (key === 'groupedid') return 'album';
  if (key === 'cachekey') return 'media';
  if (key === 'callid') return 'call';
  return key.replace(/id$/u, '') || 'id';
}

function lastPathPart(context: string): string {
  return (
    context
      .split('.')
      .at(-1)
      ?.replace(/\[\d+\]$/u, '') ?? context
  );
}

function normalizeKey(value: string): string {
  return value.replace(/[^a-z0-9]/giu, '').toLowerCase();
}

function timestampToMilliseconds(value: number): number {
  return value;
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TvBugFormatError(`${context} must be an object.`);
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  context: string,
) {
  const expected = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) throw new TvBugFormatError(`Unexpected ${context} field: ${key}`);
  }
  for (const key of expected) {
    if (!(key in record)) throw new TvBugFormatError(`Missing ${context}.${key}.`);
  }
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new TvBugFormatError(`${context} must be a string.`);
  return value;
}

function isValidTimeZone(value: string) {
  if (value.length === 0 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function finiteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TvBugFormatError(`${context} must be a finite number.`);
  }
  return value;
}

function finiteInteger(value: unknown, context: string): number {
  const number = finiteNumber(value, context);
  if (!Number.isSafeInteger(number))
    throw new TvBugFormatError(`${context} must be a safe integer.`);
  return number;
}

function finiteNonNegativeInteger(value: unknown, context: string): number {
  const number = finiteInteger(value, context);
  if (number < 0) throw new TvBugFormatError(`${context} must not be negative.`);
  return number;
}

function finiteNonNegativeNumber(value: unknown, context: string): number {
  const number = finiteNumber(value, context);
  if (number < 0) throw new TvBugFormatError(`${context} must not be negative.`);
  return number;
}

function assertTextSize(value: string, context: string) {
  if (typeof value !== 'string') throw new TvBugFormatError(`${context} must be a string.`);
  if (value.length > MAX_TEXT_UTF16_LENGTH) {
    throw new TvBugFormatError(`${context} exceeds the text length limit.`);
  }
}

function assertCollectionSize(length: number, context: string) {
  if (length > MAX_COLLECTION_ITEMS) {
    throw new TvBugFormatError(`${context} contains too many items.`);
  }
}

function assertNestingDepth(depth: number) {
  if (depth > 64) throw new TvBugFormatError('The .tvbug data is nested too deeply.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
