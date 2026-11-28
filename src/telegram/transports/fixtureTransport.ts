import { migratedSearchPage } from '../migratedSearch';
import { messageInSavedDialog } from '../savedMessages';
import type { AdminLogEntry } from '../adminLog';
import { adminRightKeys } from '../chatManagement';
import type { ChatInviteLink, ChatManagementSettings, ManagedParticipant } from '../chatManagement';
import { messageInTopic, type TelegramForumTopic } from '../forums';
import type { TelegramChatFolder, TelegramFolderLink } from '../chatFolders';
import type { TelegramPollVotes } from '../types';
import type { TelegramStickerPack } from '../types';
import type { TelegramSearchFilters } from '../types';
import { changePrivacyRules } from '../../domain/privacy';
import type { TelegramPrivacyKey, TelegramPrivacyChange, TelegramPrivacySetting } from '../types';
import type { TelegramActiveSessions } from '../types';
import type { TelegramReadReceipts } from '../types';
import { pendingPoll } from '../../domain/poll';
import type { TelegramPollDraft } from '../types';
import { pollHasVote } from '../../domain/poll';
import type { TelegramPoll, TelegramPollAction } from '../types';
import type { TelegramContact } from '../types';
import type { TelegramForwardOptions } from '../types';
import { Deferred, Effect, PubSub, Queue, Stream } from 'effect';
import type { TelegramTransport } from '../types';
import type {
  EditMediaOptions,
  OutgoingAttachmentMode,
  SendAlbumAttachment,
  SendAlbumOptions,
  SendFileOptions,
  SharedMediaKind,
  SyncCursor,
  TelegramCredentials,
  TelegramActivityKind,
  TelegramBotCommand,
  TelegramDialog,
  TelegramDownloadOptions,
  TelegramMedia,
  TelegramMessage,
  TelegramPeer,
  TelegramPeerSearchResult,
  TelegramReplyTarget,
  TelegramReactionPerson,
  TelegramSearchOffset,
  TelegramSticker,
  TelegramTextFormat,
  TelegramUrlAuthAcceptOptions,
  TransportUpdateBatch,
  TransportUpdate,
} from '../types';
import { gzipSync, strToU8 } from 'fflate';
import { createMtprotoError, type MtprotoError } from '../mtproto/errors';
import { readVideoPreview } from '../localMedia';

const cursor: SyncCursor = { pts: 10, qts: 0, date: 1_700_000_000, seq: 1 };
const peers: TelegramPeer[] = [
  { id: 'u:101', kind: 'user', accessHash: '1' },
  { id: 'c:202', kind: 'channel', accessHash: '2' },
  { id: 'g:303', kind: 'group', accessHash: '3' },
  { id: 'u:505', kind: 'user', accessHash: '5' },
];

const initialMessages = new Map<string, TelegramMessage[]>([
  [
    peers[0]!.id,
    Array.from({ length: 80 }, (_, index): TelegramMessage => {
      const id = index + 1;
      const formatted = 'Hello @alice bold italic secret https://example.com/a/very/long/link';
      return {
        id,
        peerId: peers[0]!.id,
        senderId: id % 2 ? peers[0]!.id : 'self',
        text:
          id === 80
            ? 'Newest message from fixture'
            : id === 76
              ? formatted
              : `Fixture message ${id}`,
        date: 1_700_000_000 + id,
        outgoing: id % 2 === 0,
        ...(id === 76
          ? {
              mentions: [{ offset: 6, length: 6 }],
              links: [
                {
                  offset: 32,
                  length: formatted.length - 32,
                  url: 'https://example.com/a/very/long/link',
                },
              ],

              formats: [
                { offset: 13, length: 4, kind: 'bold' as const },
                { offset: 18, length: 6, kind: 'italic' as const },
                { offset: 25, length: 6, kind: 'spoiler' as const },
              ],

              linkPreview: {
                url: 'https://example.com/a/very/long/link',
                siteName: 'Example',
                title: 'Fixture link preview',
                description: 'Telegram supplied this preview description.',
                hasPhoto: true,
              },
            }
          : {}),
        ...(id === 77 ? { replyToId: 76, replyQuote: 'bold italic' } : {}),
        ...(id === 71
          ? {
              linkPreview: {
                url: 'https://packaged-media.redd.it/go8hnhimegnh1/pb/m2-res_480p.mp4?m=DASHPlaylist.mpd&c=wh_ben_en&var=sgpssan&v=1&e=1788559200&s=e6c15c65f080a400d2fa813cc16ee107a96f5bee',
                webPageId: '71',
                siteName: 'Reddit',
                hasPhoto: true,
                photoSize: 'small' as const,
              },
            }
          : {}),
        ...(id === 72
          ? {
              linkPreview: {
                url: 'https://packaged-media.redd.it/video.mp4?m=DASHPlaylist.mpd&c=wh_ben_en',
                type: 'video',
                siteName: 'Reddit',
                title:
                  'https://packaged-media.redd.it/a-very-long-video-name-that-must-stay-inside-the-preview/video.mp4?manifest=long',
                hasPhoto: true,
                photoSize: 'large' as const,
                media: {
                  kind: 'video' as const,
                  name: 'reddit-video.mp4',
                  mimeType: 'video/mp4',
                  size: 24,
                  width: 480,
                  height: 640,
                  duration: 12,
                  cacheKey: 'document:72',
                },
              },
            }
          : {}),
        ...(id === 73
          ? { forwardedFrom: { name: 'Release Channel', peerId: peers[1]!.id, messageId: 5 } }
          : {}),
        ...(id === 74
          ? {
              richMessage: {
                blocks: [
                  {
                    kind: 'heading' as const,
                    level: 2 as const,
                    text: { kind: 'text' as const, text: 'Rich Markdown' },
                  },
                  {
                    kind: 'text' as const,
                    role: 'paragraph' as const,
                    text: {
                      kind: 'concat' as const,
                      children: [
                        {
                          kind: 'marked' as const,
                          child: { kind: 'text' as const, text: 'Highlighted' },
                        },
                        { kind: 'text' as const, text: ' and ' },
                        {
                          kind: 'spoiler' as const,
                          child: { kind: 'text' as const, text: 'hidden' },
                        },
                      ],
                    },
                  },
                  {
                    kind: 'list' as const,
                    ordered: false,
                    items: [
                      {
                        checkbox: true,
                        checked: true,
                        text: { kind: 'text' as const, text: 'Rendered task' },
                      },
                    ],
                  },
                  {
                    kind: 'table' as const,
                    bordered: true,
                    rows: [
                      [
                        { header: true, text: { kind: 'text' as const, text: 'Feature' } },
                        { text: { kind: 'text' as const, text: 'Status' } },
                      ],
                    ],
                  },
                  {
                    kind: 'details' as const,
                    title: { kind: 'text' as const, text: 'More' },
                    blocks: [
                      {
                        kind: 'text' as const,
                        role: 'paragraph' as const,
                        text: { kind: 'text' as const, text: 'Nested content' },
                      },
                    ],
                  },
                ],
              },
            }
          : {}),
        ...(id === 79
          ? {
              replyToId: 78,
              replyQuote: 'fixture.jpg',
              reactions: [{ emoji: '👍', count: 2, chosen: false }],
            }
          : {}),
        ...(id === 75
          ? {
              media: {
                kind: 'file' as const,
                name: 'fixture-document.pdf',
                mimeType: 'application/pdf',
                size: 42_000,
              },
            }
          : {}),
        ...(id === 5
          ? {
              media: {
                kind: 'photo' as const,
                name: 'old-fixture.jpg',
                mimeType: 'image/jpeg',
                width: 320,
                height: 180,
              },
            }
          : {}),
        ...(id === 78
          ? {
              media: {
                kind: 'photo' as const,
                name: 'fixture.jpg',
                mimeType: 'image/jpeg',
                width: 320,
                height: 180,
              },
            }
          : {}),
      };
    }),
  ],

  [
    peers[1]!.id,
    [
      {
        id: 5,
        peerId: peers[1]!.id,
        senderId: 'u:404',
        senderName: 'Release Author',
        senderHasAvatar: true,
        senderAvatarId: 'fixture-u:404',
        senderColor: '#408acf',
        senderColorVersion: 2,
        senderRole: 'owner',
        senderRoleKind: 'owner',
        text: 'Release notes are ready https://example.com/release',
        date: 1_700_001_000,
        outgoing: false,
      },
    ],
  ],

  [
    peers[2]!.id,
    [
      {
        id: 12,
        peerId: peers[2]!.id,
        senderId: 'u:404',
        senderName: 'Fixture Author',
        text: 'Group fixture message',
        date: 1_700_000_500,
        outgoing: false,
      },
    ],
  ],

  [
    peers[3]!.id,
    Array.from({ length: 1_000 }, (_, index): TelegramMessage => ({
      id: index + 1,
      peerId: peers[3]!.id,
      senderId: index % 2 ? peers[3]!.id : 'self',
      text: `Long history message ${index + 1}`,
      date: 1_699_000_000 + index,
      outgoing: index % 2 === 0,
    })),
  ],
]);

interface FixtureStats {
  connect: number;
  getAuthorizedAccountId: number;
  getChannelDifference: number;
  requestCode: number;
  submitCode: number;
  submitPassword: number;
  getDialogs: number;
  getHistory: number;
  getHistoryAround: number;
  getSharedMediaCounts: number;
  sendText: number;
  lastSendRandomId?: string;
  sendFile: number;
  sendAlbum: number;
  readAllNotifications: { peerId: string; kind: 'mention' | 'reaction' }[];
  readMessageContents: { peerId: string; messageIds: number[] }[];
  readHistory: number;
  readHistoryPeers: string[];
  getReadOutboxMaxId: number;
  downloadMedia: number;
  downloadMediaRequests: Array<{
    peerId: string;
    messageId: number;
    name: string | undefined;
    preview: boolean;
  }>;
  downloadMediaPreview: number;
  downloadMediaFull: number;
  downloadAvatar: number;
  releaseAvatarDownload: number;
  getThemes: number;
  getWallpapers: number;
  getChatAppearance: number;
  downloadWallpaper: number;
  getRecentStickers: number;
  getStickerPacks: number;
  getSavedGifs: number;
  searchGifs: number;
  downloadSticker: number;
  getBotCommands: number;
  sendWebAppData: number;
  prolongWebApp: number;
  startBot: number;
  answerBotCallback: number;
  sendSticker: number;
  setReaction: number;
  deleteMessages: number;
  editMessage: number;
  forwardMessage: number;
  searchMessages: number;
  searchPeers: number;
  getSharedMedia: number;
  getPinnedMessages: number;
  setMuted: number;
  getUserDetails: number;
  getMessageReadReceipts: number;
  setBlocked: number;
  updateContact: number;
  deleteContact: number;
  setPinnedDialog: number;
  setArchived: number;
  deleteDialog: number;
  setPinnedMessage: number;
  setTyping: number;
}

declare global {
  interface Window {
    __televechaFixture?: {
      stats: FixtureStats;
      emit(update: TransportUpdate): void;
      setMessages(values: TelegramMessage[]): void;
      receiveMessage(message: Omit<TelegramMessage, 'id'>): void;
      releaseConnect(): void;
      releaseSend(): void;
      releaseUpload(): void;
      holdNextUpload(): void;
      changeAndHoldReleaseAvatar(): void;
      failPendingAvatar(): void;
      failNextHistory(peerId: string, message: string): void;
      setBotCommands(peerId: string, commands: TelegramBotCommand[]): void;
      holdNextBotCallback(): void;
      releaseBotCallback(): void;
      holdNextBotStart(): void;
      releaseBotStart(): void;
      useExtendedUrlAuth(): void;
      readonly acceptedUrlAuthOptions: TelegramUrlAuthAcceptOptions | undefined;
      holdNextEdit(): void;
      releaseEdit(): void;
      releaseHistory(): void;
      releaseHistoryAround(): void;
      releaseSharedMediaCounts(): void;
    };
  }
}

function fixtureVoiceBlob(duration: number = 2) {
  const sampleRate = 8_000;
  const samples = Math.round(Math.max(1, Math.min(120, duration)) * sampleRate);
  const bytes = new Uint8Array(44 + samples);
  bytes.fill(128, 44); // Unsigned 8-bit PCM silence.
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    bytes.set(new TextEncoder().encode(value), offset);
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  return new Blob([bytes], { type: 'audio/wav' });
}

function fixtureTgsBlob() {
  return new Blob(
    [
      gzipSync(
        strToU8(
          JSON.stringify({
            v: '5.5.7',
            fr: 30,
            ip: 0,
            op: 30,
            w: 128,
            h: 128,
            nm: 'Fixture TGS',
            ddd: 0,
            assets: [],
            layers: [
              {
                ddd: 0,
                ind: 1,
                ty: 4,
                nm: 'Rotating star',
                sr: 1,
                ks: {
                  o: { a: 0, k: 100 },
                  r: {
                    a: 1,
                    k: [
                      { t: 0, s: [0], e: [360], o: { x: 0.33, y: 0.33 }, i: { x: 0.67, y: 0.67 } },
                      { t: 30, s: [360] },
                    ],
                  },
                  p: { a: 0, k: [64, 64, 0] },
                  a: { a: 0, k: [0, 0, 0] },
                  s: { a: 0, k: [100, 100, 100] },
                },
                shapes: [
                  {
                    ty: 'sr',
                    sy: 1,
                    d: 1,
                    pt: { a: 0, k: 5 },
                    p: { a: 0, k: [0, 0] },
                    r: { a: 0, k: 0 },
                    or: { a: 0, k: 46 },
                    os: { a: 0, k: 0 },
                    ir: { a: 0, k: 21 },
                    is: { a: 0, k: 0 },
                  },
                  { ty: 'fl', c: { a: 0, k: [1, 0.75, 0.15, 1] }, o: { a: 0, k: 100 }, r: 1 },
                ],
                ip: 0,
                op: 30,
                st: 0,
                bm: 0,
              },
            ],
          }),
        ),
      ),
    ],

    { type: 'application/x-tgsticker' },
  );
}

const FIXTURE_MP4_BASE64 =
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAN0bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAp90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAEAAABAAAAAAIXbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAACgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABwm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAYJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAHZIAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAFAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAOGN0dHMAAAAAAAAABQAAAAEAAAQAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAUAAAABAAAAKHN0c3oAAAAAAAAAAAAAAAUAAALFAAAADAAAAAwAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAOkAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAAC/W1kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MjUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAPZYiEADP//vbsvgU2FMjBAAAACEGaJGxCv/7AAAAACEGeQniF/8GBAAAACAGeYXRCv8SAAAAACAGeY2pCv8SB';

function fixtureMp4Blob() {
  const bytes = Uint8Array.from(atob(FIXTURE_MP4_BASE64), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: 'video/mp4' });
}

export const createFixtureTelegramTransport = Effect.fn('telegram.fixtureTransport.make')(
  function* (gallery?: {
    chats: readonly {
      peer: TelegramPeer;
      title: string;
      color: string;
      history: TelegramMessage[];
    }[];
    afterSend?: (message: TelegramMessage) => void;
    asset: (media: TelegramMedia, options?: TelegramDownloadOptions) => Promise<Blob> | undefined;
  }) {
    const messages = gallery ? new Map(initialMessages) : initialMessages;
    for (const chat of gallery?.chats ?? []) messages.set(chat.peer.id, chat.history);
    function fixtureDialog(peer: TelegramPeer, title: string, color: string): TelegramDialog {
      const history = messages.get(peer.id) ?? [];
      const topMessage = history.at(-1);
      return {
        peer,
        ...(peer.kind === 'channel' ? { channelPts: cursor.pts } : {}),
        title,
        initials: title
          .split(' ')
          .map((word) => word[0]?.toUpperCase())
          .join(''),
        color,
        archived: false,
        topMessageId: topMessage?.id ?? 0,
        topMessage,
        unreadCount: 2,
        readInboxMaxId: Math.max(0, (topMessage?.id ?? 0) - 2),
        readOutboxMaxId: 0,
        muted: false,
        pinned: false,
        permissions: {
          canSendMessages: true,
          canSendMedia: true,
          canSendStickers: true,
          canSendGifs: true,
          canPinMessages: true,
          canEditMessages: peer.kind !== 'user',
          canDeleteMessages: true,
          canDeleteForEveryone: true,
          canDeleteChat: peer.kind === 'group',
          canDeleteChannel: peer.kind === 'channel',
          canLeave: peer.kind !== 'user',
          canViewMembers: peer.kind !== 'user',
          canManageInvites: peer.kind !== 'user',
          canManageChat: peer.kind !== 'user',
          ...(peer.kind === 'user' ? {} : { memberCount: 2 }),
        },
        hasAvatar: true,
        avatarId: `fixture-${peer.id}`,
      };
    }

    const updateHub = yield* PubSub.bounded<TransportUpdateBatch>(256);
    const controls = yield* Queue.unbounded<
      | { readonly _tag: 'emit'; readonly update: TransportUpdate }
      | {
          readonly _tag:
            | 'release-connect'
            | 'release-send'
            | 'release-history-around'
            | 'release-shared-media'
            | 'change-avatar'
            | 'fail-avatar';
        }
    >();
    const blockedPeers = new Set<string>();
    const pinnedPeers = new Set<string>();
    let chatFolders: TelegramChatFolder[] = [];
    const folderLinks = new Map<number, TelegramFolderLink[]>();
    const archivedPeers = new Set<string>();
    const unreadMarkedPeers = new Set<string>();
    const deletedPeers = new Set<string>();
    const scenario = new URLSearchParams(window.location.search).get('scenario') ?? '';
    const scenarios = new Set(scenario.split('+').filter(Boolean));
    const hasScenario = (value: string) => scenarios.has(value);
    const forumTopics: TelegramForumTopic[] = [1, 10].map((id) => ({
      id,
      title: id === 1 ? 'General' : 'Development',
      iconColor: 0x6fb9f0,
      date: 1700000000,
      topMessageId: 200,
      readInboxMaxId: 0,
      unreadCount: 2,
      unreadMentionsCount: 0,
      unreadReactionsCount: 0,
      closed: false,
      hidden: false,
      pinned: false,
      own: true,
    }));
    if (hasScenario('forums'))
      messages.set(
        'c:202',
        Array.from({ length: 120 }, (_, index): TelegramMessage => ({
          id: index + 101,
          peerId: 'c:202',
          peer: peers[1]!,
          senderId: 'u:101',
          senderName: 'Alice Fixture',
          text: `${index % 2 ? 'Development' : 'General'} message ${index + 1}`,
          date: 1700000100 + index,
          outgoing: false,
          topicId: index % 2 ? 10 : 1,
          replyToId: index % 2 ? 10 : 1,
        })),
      );

    let authorized = !scenario.startsWith('auth');
    let connected = false;
    let pendingConnect: Deferred.Deferred<void> | undefined;
    let pendingSend: Deferred.Deferred<void> | undefined;
    let pendingUpload: Deferred.Deferred<void> | undefined;
    let holdUpload = false;
    let avatarFailureArmed = false;
    let avatarFailureReleased = false;
    const pendingAvatarFailures = new Set<Deferred.Deferred<never, MtprotoError>>();
    let pendingHistory: Deferred.Deferred<void> | undefined;
    let historyReleasePending = false;
    const scenarioHistoryHeld = new Set<string>();
    let pendingHistoryAround: Deferred.Deferred<void> | undefined;
    let nextHistoryFailure: { readonly peerId: string; readonly message: string } | undefined;
    const botCommandsByPeer = new Map<string, TelegramBotCommand[]>();
    let holdBotCallback = false;
    let pendingBotCallback: Deferred.Deferred<void> | undefined;
    let heldBotStarts = 0;
    const pendingBotStarts: Deferred.Deferred<void>[] = [];
    let extendedUrlAuth = false;
    let acceptedUrlAuthOptions: TelegramUrlAuthAcceptOptions | undefined;
    let holdEdit = false;
    let pendingEdit: Deferred.Deferred<void> | undefined;
    let sharedMediaCountsReleased = false;
    let sharedMediaCountFailures = 0;
    const pendingSharedMediaCountReleases = new Set<Deferred.Deferred<void>>();
    yield* Stream.fromQueue(controls).pipe(
      Stream.runForEach((control) =>
        Effect.gen(function* () {
          switch (control._tag) {
            case 'emit':
              yield* PubSub.publish(updateHub, { updates: [control.update] });
              break;
            case 'release-connect':
              if (pendingConnect) yield* Deferred.succeed(pendingConnect, undefined);
              break;
            case 'release-send':
              if (pendingSend) yield* Deferred.succeed(pendingSend, undefined);
              break;
            case 'release-history-around':
              if (pendingHistoryAround) yield* Deferred.succeed(pendingHistoryAround, undefined);
              break;
            case 'release-shared-media':
              sharedMediaCountsReleased = true;
              yield* Effect.forEach(
                pendingSharedMediaCountReleases,
                (pending) => Deferred.succeed(pending, undefined),
                { discard: true },
              );
              pendingSharedMediaCountReleases.clear();
              break;
            case 'change-avatar': {
              avatarFailureArmed = true;
              const dialog = {
                ...fixtureDialog(peers[1]!, 'Release Channel', '#4ca184'),
                avatarId: 'fixture-c:202-updated',
              };
              yield* PubSub.publish(updateHub, { updates: [{ type: 'dialog-changed', dialog }] });
              break;
            }
            case 'fail-avatar':
              avatarFailureReleased = true;
              yield* Effect.forEach(
                pendingAvatarFailures,
                (pending) =>
                  Deferred.fail(
                    pending,
                    createMtprotoError('transport', 'Fixture avatar download failed'),
                  ),
                { discard: true },
              );
              pendingAvatarFailures.clear();
              break;
          }
        }),
      ),
      Effect.forkScoped,
    );
    let fixtureMediaFailures = 0;
    let fixturePts = cursor.pts;
    const stats: FixtureStats = {
      connect: 0,
      getAuthorizedAccountId: 0,
      getChannelDifference: 0,
      requestCode: 0,
      submitCode: 0,
      submitPassword: 0,
      getDialogs: 0,
      getHistory: 0,
      getHistoryAround: 0,
      getSharedMediaCounts: 0,
      sendText: 0,
      sendFile: 0,
      sendAlbum: 0,
      readMessageContents: [],
      readAllNotifications: [],
      readHistory: 0,
      readHistoryPeers: [],
      getReadOutboxMaxId: 0,
      downloadMedia: 0,
      downloadMediaRequests: [],
      downloadMediaPreview: 0,
      downloadMediaFull: 0,
      downloadAvatar: 0,
      releaseAvatarDownload: 0,
      getThemes: 0,
      getWallpapers: 0,
      getChatAppearance: 0,
      downloadWallpaper: 0,
      getRecentStickers: 0,
      getStickerPacks: 0,
      getSavedGifs: 0,
      searchGifs: 0,
      downloadSticker: 0,
      getBotCommands: 0,
      sendWebAppData: 0,
      prolongWebApp: 0,
      startBot: 0,
      answerBotCallback: 0,
      sendSticker: 0,
      setReaction: 0,
      deleteMessages: 0,
      editMessage: 0,
      forwardMessage: 0,
      searchMessages: 0,
      searchPeers: 0,
      getSharedMedia: 0,
      getPinnedMessages: 0,
      setMuted: 0,
      getUserDetails: 0,
      getMessageReadReceipts: 0,
      setBlocked: 0,
      updateContact: 0,
      deleteContact: 0,
      setPinnedDialog: 0,
      setArchived: 0,
      deleteDialog: 0,
      setPinnedMessage: 0,
      setTyping: 0,
    };
    const connect = Effect.fn('FixtureTransport.connect')(function* (
      _credentials: TelegramCredentials,
    ) {
      stats.connect += 1;
      if (scenario === 'connect-fails-once' && stats.connect === 1) {
        return yield* Effect.fail(createMtprotoError('transport', 'Fixture connection failure'));
      }
      if (hasScenario('held-connect')) {
        pendingConnect = yield* Deferred.make<void>();
        yield* Deferred.await(pendingConnect);
        pendingConnect = undefined;
      }
      connected = true;
    });
    function disconnect() {
      return Effect.sync(() => {
        connected = false;
      });
    }
    function logOut() {
      return Effect.sync(() => {
        authorized = false;
      });
    }
    function isAuthorized() {
      return Effect.sync(() => {
        return authorized;
      });
    }
    function getAuthorizedAccountId() {
      return Effect.sync(() => {
        stats.getAuthorizedAccountId += 1;
        return '900000001';
      });
    }
    const requestCode = Effect.fn('FixtureTransport.requestCode')(function* (phoneNumber: string) {
      stats.requestCode += 1;
      if (phoneNumber.includes('000'))
        return yield* Effect.fail(createMtprotoError('transport', 'Fixture rejected phone number'));
      return { isCodeViaApp: true };
    });
    const submitCode = Effect.fn('FixtureTransport.submitCode')(function* (code: string) {
      stats.submitCode += 1;
      if (code === '00000')
        return yield* Effect.fail(createMtprotoError('transport', 'Fixture rejected login code'));
      if (code === '99999') return 'sign-up-required';
      if (code === '22222') return 'password-required';
      authorized = true;
      return 'authorized';
    });
    const submitPassword = Effect.fn('FixtureTransport.submitPassword')(function* (
      password: string,
    ) {
      stats.submitPassword += 1;
      if (password === 'wrong')
        return yield* Effect.fail(createMtprotoError('transport', 'Fixture rejected password'));
      authorized = true;
    });
    function getCurrentState() {
      return Effect.sync(() => {
        return cursor;
      });
    }
    function getDifference() {
      return Effect.sync(() => {
        return { type: 'complete' as const, cursor, updates: [] };
      });
    }
    function getChannelDifference(_peer: TelegramPeer, pts: number, _totalLimit: number) {
      return Effect.sync(() => {
        stats.getChannelDifference += 1;
        return { type: 'complete' as const, pts, updates: [] };
      });
    }
    const migratedGroups = new Map<string, TelegramPeer>();
    const managementSettings = new Map<string, ChatManagementSettings>();
    const peerManagement = (peer: TelegramPeer): ChatManagementSettings => {
      let settings = managementSettings.get(peer.id);
      if (!settings) {
        const limited = hasScenario('management-limited');
        settings = {
          title:
            peer.id === 'g:303'
              ? 'Fixture Group'
              : peer.id === 'c:202'
                ? 'Release Channel'
                : (createdDialogs.find((dialog) => dialog.peer.id === peer.id)?.title ?? 'Group'),
          about: 'A place for our team.',
          username: '',
          broadcast: peer.id === 'c:202' && !hasScenario('forums'),
          forum: peer.id === 'c:202' && hasScenario('forums'),
          slowModeSeconds: 0,
          hiddenHistory: false,
          protectedContent: false,
          grantableAdminRights: Object.fromEntries(
            adminRightKeys.map((key) => [
              key,
              !limited || ['changeInfo', 'inviteUsers'].includes(key),
            ]),
          ),
          defaultRestrictions: { sendPolls: true },
          rights: {
            changeInfo: true,
            changeType: !limited,
            manageInvites: true,
            manageAdmins: !limited,
            restrictMembers: !limited,
            manageTopics: !limited,
            viewLog: peer.kind === 'channel',
          },
        };
        managementSettings.set(peer.id, settings);
      }
      return settings;
    };
    const participantLists = new Map<string, ManagedParticipant[]>();
    const peerParticipants = (peer: TelegramPeer) => {
      let people = participantLists.get(peer.id);
      if (!people) {
        people = [
          {
            peer: { id: 'u:900000001', kind: 'user', accessHash: '1' },
            title: 'Fixture Owner',
            initials: 'FO',
            color: '#5288c1',
            hasAvatar: false,
            role: 'owner',
            self: true,
            editable: false,
            rank: '',
            adminRights: {},
            restrictions: {},
            untilDate: 0,
          },
          {
            peer: { id: 'u:701', kind: 'user', accessHash: '1' },
            title: 'Nina Member',
            initials: 'NM',
            color: '#b26b3f',
            hasAvatar: false,
            role: 'member',
            self: false,
            editable: true,
            rank: '',
            adminRights: {},
            restrictions: {},
            untilDate: 0,
          },
          {
            peer: { id: 'u:702', kind: 'user', accessHash: '2' },
            title: 'Alex Admin',
            initials: 'AA',
            color: '#5288c1',
            hasAvatar: false,
            role: 'admin',
            self: false,
            editable: false,
            rank: 'Moderator',
            adminRights: { inviteUsers: true },
            restrictions: {},
            untilDate: 0,
          },
        ];
        participantLists.set(peer.id, people);
      }
      return people;
    };
    const inviteLinkLists = new Map<string, ChatInviteLink[]>();
    let inviteLinkId = 1;
    const peerInviteLinks = (peer: TelegramPeer) => {
      let links = inviteLinkLists.get(peer.id);
      if (!links) {
        links = [
          {
            url: `https://t.me/+primary_${peer.id.replace(':', '_')}`,
            title: '',
            adminId: 'u:900000001',
            date: 1700000000,
            permanent: true,
            revoked: false,
            requestNeeded: false,
            expireDate: 0,
            usageLimit: 0,
            usage: 12,
            requested: 0,
            paid: false,
          },
        ];
        inviteLinkLists.set(peer.id, links);
      }
      return links;
    };
    const createdDialogs: TelegramDialog[] = [];
    const savedSelf: TelegramPeer = { id: 'u:900000001', kind: 'user', accessHash: '1' };
    const savedPins = new Set<string>();
    const savedTagNames = new Map<string, string>([['⭐', 'Ideas']]);
    const ensureSaved = () => {
      if (messages.has(savedSelf.id)) return;
      const saved: TelegramMessage[] = [
        {
          id: 6001,
          peerId: savedSelf.id,
          peer: savedSelf,
          savedPeerId: 'u:101',
          senderId: 'u:101',
          senderName: 'Alice Fixture',
          text: 'Saved from Alice',
          date: 1700006001,
          outgoing: true,
          reactionsAsTags: true,
          reactions: [{ emoji: '⭐', count: 1, chosen: true }],
        },
        {
          id: 6002,
          peerId: savedSelf.id,
          peer: savedSelf,
          savedPeerId: 'c:202',
          senderId: 'c:202',
          senderName: 'Release Channel',
          text: 'Saved release checklist',
          date: 1700006002,
          outgoing: true,
        },
        {
          id: 6003,
          peerId: savedSelf.id,
          peer: savedSelf,
          savedPeerId: savedSelf.id,
          senderId: savedSelf.id,
          text: 'My personal note',
          date: 1700006003,
          outgoing: true,
        },
      ];
      messages.set(savedSelf.id, saved);
      createdDialogs.push({
        ...fixtureDialog(savedSelf, 'Saved Messages', '#5288c1'),
        hasAvatar: false,
      });
    };

    let joinRequestPeople = [
      {
        peer: { id: 'u:701', kind: 'user' as const, accessHash: '1' },
        title: 'Nina Request',
        initials: 'NR',
        color: '#5288c1',
        hasAvatar: false,
        date: 1700000000,
        about: 'I would like to join the project.',
      },
      {
        peer: { id: 'u:702', kind: 'user' as const, accessHash: '2' },
        title: 'Alex Request',
        initials: 'AR',
        color: '#b26b3f',
        hasAvatar: false,
        date: 1700000100,
        about: '',
      },
    ];
    function getDialogs() {
      return Effect.sync(() => {
        if (new URLSearchParams(window.location.search).get('chat') === savedSelf.id) ensureSaved();
        stats.getDialogs += 1;
        return {
          dialogs: [
            ...(gallery?.chats.map(({ peer, title, color }) => ({
              ...fixtureDialog(peer, title, color),
              hasAvatar: false,
              avatarId: undefined,
              unreadCount: 0,
              readInboxMaxId: messages.get(peer.id)?.at(-1)?.id ?? 0,
            })) ?? []),
            ...createdDialogs,
            {
              ...fixtureDialog(peers[0]!, 'Alice Fixture', '#7c5cff'),
              ...(scenario === 'single-unread' ? { unreadCount: 1, readInboxMaxId: 79 } : {}),
            },
            { ...fixtureDialog(peers[1]!, 'Release Channel', '#4ca184'), muted: Boolean(gallery) },
            fixtureDialog(peers[2]!, 'Fixture Group', '#b26b3f'),
            ...(['long-history', 'unread-history', 'delayed-history-media'].includes(scenario)
              ? [
                  {
                    ...fixtureDialog(peers[3]!, 'Long History', '#4b7bec'),
                    ...(scenario === 'unread-history'
                      ? { unreadCount: 15, readInboxMaxId: 970 }
                      : {}),
                  },
                ]
              : []),
          ]

            .filter((dialog) => !deletedPeers.has(dialog.peer.id))
            .map((dialog) => ({
              ...dialog,
              ...(migratedGroups.has(dialog.peer.id)
                ? {
                    permissions: {
                      ...dialog.permissions!,
                      canSendMessages: false,
                      canSendMedia: false,
                      canManageChat: false,
                      canManageInvites: false,
                    },
                  }
                : {}),
              pinned: pinnedPeers.has(dialog.peer.id),
              archived: archivedPeers.has(dialog.peer.id),
              broadcast: dialog.broadcast ?? (dialog.peer.id === 'c:202' && !hasScenario('forums')),
              forum: dialog.peer.id === 'c:202' && hasScenario('forums'),
              ...(managementSettings.has(dialog.peer.id)
                ? {
                    title: managementSettings.get(dialog.peer.id)!.title,
                    username: managementSettings.get(dialog.peer.id)!.username,
                    forum: managementSettings.get(dialog.peer.id)!.forum,
                    protectedContent: managementSettings.get(dialog.peer.id)!.protectedContent,
                  }
                : {}),
              isContact: dialog.peer.id === 'u:101',
              unreadMark: unreadMarkedPeers.has(dialog.peer.id),
            })),
        };
      });
    }
    const publicPeer: TelegramPeer = { id: 'c:707', kind: 'channel', accessHash: '7' };
    const discussionPeer: TelegramPeer = { id: 'c:909', kind: 'channel', accessHash: '9' };
    const publicPosts: TelegramMessage[] = [965, 966, 967].map((id) => ({
      id,
      peerId: publicPeer.id,
      peer: publicPeer,
      senderId: publicPeer.id,
      senderName: 'Public Fixture News',
      text: `Public post ${id}`,
      date: 1_700_000_000 + id,
      outgoing: false,
      comments: { count: id === 965 ? 75 : 0, channelId: discussionPeer.id },
    }));
    const navigationHistory = (peerId: string) => {
      if (peerId === publicPeer.id) return publicPosts;
      const history = messages.get(peerId) ?? [];
      return scenario.startsWith('comments') && peerId === peers[0]!.id
        ? history.map((message) =>
            message.id === 79
              ? {
                  ...message,
                  text: 'https://t.me/public_fixture_news/965',
                  linkPreview: {
                    url: 'https://t.me/public_fixture_news/965',
                    siteName: 'Telegram',
                    title: 'Public Fixture News',
                    description: 'Open the public post',
                  },
                }
              : message,
          )
        : history;
    };
    const resolveUsername = Effect.fn('FixtureTransport.resolveUsername')(function* (
      username: string,
    ) {
      return (yield* searchPeers(username)).find(
        (result) => result.username?.toLowerCase() === username.toLowerCase(),
      );
    });
    const getDiscussion = Effect.fn('FixtureTransport.getDiscussion')(function* (
      peer: TelegramPeer,
      postId: number,
    ) {
      if (peer.id !== publicPeer.id || ![965, 967].includes(postId)) return undefined;
      yield* Effect.void;
      const post = publicPosts.find((message) => message.id === postId)!;
      return {
        peer: discussionPeer,
        root: {
          ...post,
          id: postId === 965 ? 42 : 43,
          peerId: discussionPeer.id,
          peer: discussionPeer,
        },
        unreadCount: 0,
      };
    });
    let commentFailure = scenario === 'comments-fail-once';
    const getReplies = Effect.fn('FixtureTransport.getReplies')(function* (
      peer: TelegramPeer,
      rootId: number,
      limit: number,
      before?: number,
    ) {
      if (hasScenario('forums') && peer.id === 'c:202') {
        const all = (messages.get(peer.id) ?? []).filter(
          (message) => messageInTopic(message, rootId) && (!before || message.id < before),
        );
        const page = all.slice(-limit);
        return {
          messages: page,
          hasOlder: all.length > page.length,
          nextBeforeMessageId: page[0]?.id,
        };
      }
      if (commentFailure) {
        commentFailure = false;
        return yield* Effect.fail(createMtprotoError('transport', 'Could not load comments.'));
      }
      if (!messages.has(peer.id)) {
        messages.set(
          peer.id,
          Array.from({ length: 75 }, (_, index) => ({
            id: 100 + index,
            peerId: peer.id,
            peer,
            senderId: 'u:101',
            senderName: 'Alice Fixture',
            text: `Fixture comment ${index + 1}`,
            date: 1_700_001_000 + index,
            outgoing: false,
            replyToId: 42,
          })),
        );
      }
      const threadIds = new Set([rootId]);
      const all = (messages.get(peer.id) ?? []).filter((message) => {
        if (message.replyToId === undefined || !threadIds.has(message.replyToId)) return false;
        threadIds.add(message.id);
        return true;
      });
      const eligible = all.filter((message) => !before || message.id < before);
      const page = eligible.slice(-limit);
      return {
        messages: page,
        hasOlder: eligible.length > page.length,
        nextBeforeMessageId: page[0]?.id,
      };
    });
    const getHistory = Effect.fn('FixtureTransport.getHistory')(function* (
      peer: TelegramPeer,
      limit: number,
      beforeMessageId?: number,
    ) {
      stats.getHistory += 1;
      if (
        scenario === 'held-earlier-history' &&
        peer.kind === 'group' &&
        beforeMessageId !== undefined &&
        !scenarioHistoryHeld.has('earlier')
      ) {
        scenarioHistoryHeld.add('earlier');
        pendingHistory = yield* Deferred.make<void>();
        yield* Deferred.await(pendingHistory);
        pendingHistory = undefined;
      }
      if (nextHistoryFailure?.peerId === peer.id) {
        const failure = nextHistoryFailure;
        nextHistoryFailure = undefined;
        return yield* Effect.fail(createMtprotoError('transport', failure.message));
      }
      if (
        scenario === 'held-history' &&
        peer.id === peers[1]?.id &&
        !scenarioHistoryHeld.has(peer.id) &&
        beforeMessageId === undefined
      ) {
        scenarioHistoryHeld.add(peer.id);
        if (historyReleasePending) {
          historyReleasePending = false;
        } else {
          pendingHistory = yield* Deferred.make<void>();
          yield* Deferred.await(pendingHistory);
          pendingHistory = undefined;
        }
      }
      const history =
        scenario === 'long-channel-history' && peer.id === peers[1]!.id
          ? Array.from({ length: 100 }, (_, index): TelegramMessage => ({
              id: index + 1,
              peerId: peer.id,
              senderId: `u:${index % 3}`,
              senderName: `Channel author ${index % 3}`,
              text: `Channel history message ${index + 1}`,
              date: 1_700_000_000 + index,
              outgoing: false,
            }))
          : navigationHistory(peer.id);
      const eligible = beforeMessageId ? history.filter(({ id }) => id < beforeMessageId) : history;
      const pageLimit =
        scenario === 'single-message-first-page' &&
        peer.id === peers[0]!.id &&
        beforeMessageId === undefined
          ? 1
          : limit;
      const page = eligible.slice(-pageLimit);
      const renderedPage =
        (scenario === 'delayed-media' && peer.id === peers[0]!.id) ||
        (scenario === 'delayed-history-media' && peer.id === peers[3]!.id)
          ? page.map((message) =>
              message.id === (peer.id === peers[0]!.id ? 74 : 925)
                ? {
                    ...message,
                    media: {
                      kind: 'sticker' as const,
                      name:
                        peer.id === peers[0]!.id
                          ? 'delayed-layout.tgs'
                          : 'delayed-history-layout.tgs',
                      mimeType: 'application/x-tgsticker',
                    },
                  }
                : message,
            )
          : page;
      return {
        messages: renderedPage,
        ...(peer.kind === 'channel' ? { channelPts: fixturePts } : {}),
        hasOlder: [
          'long-history',
          'unread-history',
          'long-channel-history',
          'delayed-history-media',
        ].includes(scenario)
          ? page.length > 0
          : eligible.length > page.length,
        nextBeforeMessageId: page[0]?.id ?? beforeMessageId,
      };
    });
    const getHistoryAround = Effect.fn('FixtureTransport.getHistoryAround')(function* (
      peer: TelegramPeer,
      messageId: number,
      limit: number,
    ) {
      stats.getHistoryAround += 1;
      if (scenario === 'held-history-around') {
        pendingHistoryAround = yield* Deferred.make<void>();
        yield* Deferred.await(pendingHistoryAround);
        pendingHistoryAround = undefined;
      }
      const history = navigationHistory(peer.id);
      const target = Math.max(
        0,
        history.findIndex(({ id }) => id === messageId),
      );
      const start = Math.max(0, target - Math.floor(limit / 2));
      return {
        messages: history.slice(start, start + limit),
        ...(peer.kind === 'channel' ? { channelPts: fixturePts } : {}),
      };
    });
    const readHistory = Effect.fn('FixtureTransport.readHistory')(function* (peer: TelegramPeer) {
      stats.readHistory += 1;
      stats.readHistoryPeers.push(peer.id);
      if (scenario === 'read-receipt-fails') {
        return yield* Effect.fail(createMtprotoError('transport', 'fixture read receipt failure'));
      }
      return {};
    });
    function getReadOutboxMaxId() {
      return Effect.sync(() => {
        stats.getReadOutboxMaxId += 1;
        return scenario === 'missed-read-receipt' ? 80 : 0;
      });
    }
    const getSharedMediaCounts = Effect.fn('FixtureTransport.getSharedMediaCounts')(function* (
      peer: TelegramPeer,
    ) {
      stats.getSharedMediaCounts += 1;
      if (
        scenario === 'shared-media-counts-fail' ||
        (scenario === 'shared-media-counts-fail-once' && sharedMediaCountFailures++ === 0)
      ) {
        return yield* Effect.fail(
          createMtprotoError('transport', 'Fixture shared-media count failure'),
        );
      }
      if (scenario === 'held-shared-media-counts' && !sharedMediaCountsReleased) {
        const pending = yield* Deferred.make<void>();
        pendingSharedMediaCountReleases.add(pending);
        yield* Deferred.await(pending);
      }
      return peer.id === peers[0]!.id
        ? { photos: 128, videos: 9, files: 16, audio: 5, links: 44, voice: 11, gifs: 6 }
        : { photos: 7, videos: 2, files: 3, audio: 1, links: 12, voice: 4, gifs: 2 };
    });
    function getSharedMedia(
      peer: TelegramPeer,
      kind: SharedMediaKind,
      limit: number,
      offset?: TelegramSearchOffset,
    ) {
      return Effect.sync(() => {
        stats.getSharedMedia += 1;
        const sharedImageDocument: TelegramMessage = {
          id: 81,
          peerId: peer.id,
          senderId: peer.id,
          senderName: 'Alice Fixture',
          text: 'Shared diagram',
          date: 1_700_002_000,
          outgoing: false,
          media: { kind: 'file', name: 'shared-diagram.png', mimeType: 'image/png', size: 42_000 },
        };
        const sharedVideo: TelegramMessage = {
          id: 82,
          peerId: peer.id,
          senderId: peer.id,
          senderName: 'Alice Fixture',
          text: 'Large shared video',
          date: 1_700_002_100,
          outgoing: false,
          media: {
            kind: 'video',
            name: 'shared-video.mp4',
            mimeType: 'video/mp4',
            size: 590_000_000,
            width: 1920,
            height: 1080,
            duration: 690,
          },
        };
        const source =
          scenario === 'shared-image-document' && kind === 'files'
            ? [sharedImageDocument, ...(messages.get(peer.id) ?? [])]
            : scenario === 'shared-video' && kind === 'videos'
              ? [sharedVideo, ...(messages.get(peer.id) ?? [])]
              : (messages.get(peer.id) ?? []);
        const found = source.filter((message) => matchesMediaKind(message, kind));
        if (scenario === 'shared-media-pagination' || scenario === 'shared-media-short-pages') {
          const template = found[0];
          const shortPages = scenario === 'shared-media-short-pages';
          const all = template
            ? Array.from({ length: shortPages ? 3 : 205 }, (_, index) => ({
                ...template,
                id: 1000 - index,
              }))
            : [];
          return messagePage(all, shortPages ? 1 : limit, offset, false);
        }
        return messagePage(found, limit, offset, false);
      });
    }
    function matchesMediaKind(message: TelegramMessage, kind: SharedMediaKind) {
      return kind === 'links'
        ? Boolean(message.links?.length || /https?:\/\//u.test(message.text))
        : kind === 'files'
          ? message.media?.kind === 'file'
          : kind === 'photos'
            ? message.media?.kind === 'photo'
            : kind === 'videos'
              ? message.media?.kind === 'video'
              : kind === 'audio'
                ? message.media?.kind === 'file' && message.media.mimeType.startsWith('audio/')
                : kind === 'voice'
                  ? message.media?.kind === 'voice' || message.media?.kind === 'round-video'
                  : message.media?.kind === 'animation';
    }
    function searchMessages(
      query: string,
      peer?: TelegramPeer,
      limit: number = 50,
      offset?: TelegramSearchOffset,
      filters?: TelegramSearchFilters,
    ) {
      const previous =
        peer && (filters?.topicId === undefined || filters.topicId === 1)
          ? peerManagement(peer).migratedFrom
          : undefined;
      if (!peer || !previous) return searchSinglePeer(query, peer, limit, offset, filters);
      return migratedSearchPage(peer, previous, limit, offset, (target, size, cursor) =>
        searchSinglePeer(
          query,
          target,
          size,
          cursor,
          target.id === previous.id ? { ...filters, topicId: undefined } : filters,
        ),
      );
    }
    function searchSinglePeer(
      query: string,
      peer?: TelegramPeer,
      limit: number = 50,
      offset?: TelegramSearchOffset,
      filters?: TelegramSearchFilters,
    ) {
      return Effect.sync(() => {
        stats.searchMessages += 1;
        const term = query.toLocaleLowerCase();
        const sources = peer ? [messages.get(peer.id) ?? []] : [...messages.values()];
        const found = sources
          .flat()
          .filter((message) => message.text.toLocaleLowerCase().includes(term))
          .filter((message) => !filters?.minDate || message.date >= filters.minDate)
          .filter((message) => !filters?.maxDate || message.date <= filters.maxDate)
          .filter(
            (message) =>
              !peer || filters?.topicId === undefined || messageInTopic(message, filters.topicId),
          )
          .filter(
            (message) => !filters?.savedPeer || messageInSavedDialog(message, filters.savedPeer.id),
          )
          .filter(
            (message) =>
              !filters?.savedReactions?.length ||
              filters.savedReactions.every((emoji) =>
                message.reactions?.some((reaction) => reaction.emoji === emoji),
              ),
          )
          .filter((message) => !filters?.fromPeer || message.senderId === filters.fromPeer.id)
          .filter((message) => !filters?.kind || matchesMediaKind(message, filters.kind))
          .filter(
            (message) =>
              !filters?.chatType ||
              message.peerId.startsWith(
                filters.chatType === 'users' ? 'u:' : filters.chatType === 'groups' ? 'g:' : 'c:',
              ),
          );
        return messagePage(found, limit, offset, !peer);
      });
    }
    const searchPeers = Effect.fn('FixtureTransport.searchPeers')(function* (
      query: string,
      limit: number = 50,
    ) {
      stats.searchPeers += 1;
      if (scenario === 'peer-search-fails')
        return yield* Effect.fail(createMtprotoError('transport', 'fixture peer search failed'));
      const candidates: TelegramPeerSearchResult[] = [
        {
          peer: peers[0]!,
          category: 'user',
          title: 'Alice Fixture',
          initials: 'AF',
          color: '#7c5cff',
          username: 'alice_fixture',
          bot: false,
          isContact: true,
          hasAvatar: true,
          avatarId: 'fixture-u:101',
        },
        {
          peer: { id: 'u:606', kind: 'user', accessHash: '6' },
          category: 'bot',
          title: 'Fixture Helper Bot',
          initials: 'FHB',
          color: '#4ca184',
          username: 'fixture_helper_bot',
          bot: true,
          isContact: false,
          hasAvatar: false,
        },
        {
          peer: { id: 'c:707', kind: 'channel', accessHash: '7' },
          category: 'channel',
          title: 'Public Fixture News',
          initials: 'PFN',
          color: '#b26b3f',
          username: 'public_fixture_news',
          bot: false,
          isContact: false,
          hasAvatar: false,
          permissions: {
            canSendMessages: true,
            canSendMedia: true,
            canSendStickers: true,
            canSendGifs: true,
            canPinMessages: true,
            canEditMessages: false,
            canDeleteMessages: false,
            canDeleteForEveryone: false,
            canDeleteChat: false,
            canDeleteChannel: false,
            canLeave: true,
            canViewMembers: false,
          },
        },
        {
          peer: { id: 'u:808', kind: 'user', accessHash: '8' },
          category: 'user',
          title: 'Remote Fixture User',
          initials: 'RFU',
          color: '#4b7bec',
          username: 'remote_fixture_user',
          bot: false,
          isContact: false,
          hasAvatar: false,
        },
        {
          peer: { id: 'c:909', kind: 'channel', accessHash: '9' },
          category: 'group',
          title: 'Public Fixture Group',
          initials: 'PFG',
          color: '#8e6bbd',
          username: 'public_fixture_group',
          bot: false,
          isContact: false,
          hasAvatar: false,
          permissions: {
            canSendMessages: true,
            canSendMedia: true,
            canSendStickers: true,
            canSendGifs: true,
            canPinMessages: true,
            canEditMessages: false,
            canDeleteMessages: false,
            canDeleteForEveryone: false,
            canDeleteChat: false,
            canDeleteChannel: false,
            canLeave: true,
            canViewMembers: false,
          },
        },
        {
          peer: { id: 'u:1001', kind: 'user', accessHash: '10' },
          category: 'user',
          title: 'Fixture Search Contact',
          initials: 'FSC',
          color: '#357a66',
          username: 'fixture_search_contact',
          bot: false,
          isContact: true,
          hasAvatar: false,
        },
      ];

      const term = query.trim().toLocaleLowerCase();
      return candidates
        .filter((candidate) =>
          `${candidate.title} ${candidate.username ?? ''}`.toLocaleLowerCase().includes(term),
        )
        .slice(0, Math.max(0, limit));
    });
    function messagePage(
      candidates: TelegramMessage[],
      limit: number,
      offset: TelegramSearchOffset | undefined,
      global: boolean,
    ) {
      const ordered = [...candidates].sort(
        (left, right) =>
          right.date - left.date || right.id - left.id || left.peerId.localeCompare(right.peerId),
      );
      let start = 0;
      if (offset) {
        const exact = ordered.findIndex(
          (message) =>
            message.id === offset.messageId && (!global || message.peerId === offset.peer?.id),
        );
        start = exact >= 0 ? exact + 1 : global && offset.rate !== undefined ? offset.rate : 0;
      }
      const pageSize = Math.max(1, limit);
      const page = ordered.slice(start, start + pageSize);
      const last = page.at(-1);
      const hasMore = Boolean(last && start + page.length < ordered.length);
      if (!hasMore || !last) return { messages: page, hasMore: false };
      const nextPeer = global ? peers.find((peer) => peer.id === last.peerId) : undefined;
      if (global && !nextPeer) return { messages: page, hasMore: false };
      return {
        messages: page,
        hasMore: true,
        nextOffset: {
          messageId: last.id,
          ...(nextPeer ? { peer: nextPeer, rate: start + page.length } : {}),
        },
      };
    }
    function getPinnedMessages(peer: TelegramPeer) {
      return Effect.gen(function* () {
        stats.getPinnedMessages += 1;
        if (hasScenario('held-pins')) return yield* Effect.never;
        if (hasScenario('failed-pins'))
          return yield* Effect.fail(createMtprotoError('transport', 'Pinned messages unavailable'));
        if (hasScenario('multiple-pins') && peer.id === peers[0]?.id) {
          const history = messages.get(peer.id) ?? [];
          return [79, 5]
            .map((id) => history.find((message) => message.id === id))
            .filter((message): message is TelegramMessage => Boolean(message))
            .map((message) => ({ ...message, pinned: true }));
        }
        return (messages.get(peer.id) ?? []).filter(({ pinned }) => pinned);
      });
    }
    const setMuted = Effect.fn('FixtureTransport.setMuted')(function* (
      peer: TelegramPeer,
      muted: boolean,
    ) {
      stats.setMuted += 1;
      if (scenario === 'technical-mute-error') {
        return yield* Effect.fail(
          createMtprotoError('transport', 'CHAT_ADMIN_REQUIRED (account.updateNotifySettings)'),
        );
      }
      const update = fixtureDialog(
        peer,
        peer.id === peers[0]?.id
          ? 'Alice Fixture'
          : peer.id === peers[1]?.id
            ? 'Release Channel'
            : 'Fixture Group',
        '#7c5cff',
      );
      update.muted = muted;
    });
    function getUserDetails(peer: TelegramPeer) {
      return Effect.sync(() => {
        stats.getUserDetails += 1;
        return {
          ...(peer.id === 'u:606'
            ? {
                botMenu: { text: 'Open Bot App', url: 'https://example.com/mini' },
                botHasMainApp: true,
              }
            : {}),
          firstName: 'Alice',
          lastName: 'Fixture',
          phone: '+1 555 010 2048',
          username: 'alice_fixture',
          bio: 'Fixture profile used by end-to-end tests.\nalice@example.com https://example.com @telegram',
          birthday: { day: 14, month: 3, year: 1994 },
          isContact: true,
          blocked: blockedPeers.has(peer.id),
        };
      });
    }
    function updateContact(
      _peer: TelegramPeer,
      _firstName: string,
      _lastName: string,
      _phone: string,
    ) {
      return Effect.sync(() => {
        stats.updateContact += 1;
      });
    }
    function deleteContact(_peer: TelegramPeer) {
      return Effect.sync(() => {
        stats.deleteContact += 1;
      });
    }
    function getGroupMembers(
      peer: TelegramPeer,
      limit: number = 50,
      offset: number = 0,
      query?: string,
    ) {
      return Effect.sync(() => {
        if (peer.kind === 'user') return { members: [], totalCount: 0, hasMore: false };
        const allMembers = [
          {
            peer: { id: 'u:404', kind: 'user' as const },
            title: 'Fixture Author',
            username: 'fixture_author',
            initials: 'FA',
            color: '#408acf',
            role: 'owner',
            roleKind: 'owner' as const,
            hasAvatar: true,
            avatarId: 'fixture-u:404',
            presence: 'online' as const,
          },
          {
            peer: { id: 'u:405', kind: 'user' as const },
            title: 'Another Member',
            initials: 'AM',
            color: '#d95574',
            role: 'moderator',
            roleKind: 'admin' as const,
            hasAvatar: false,
            presence: 'offline' as const,
          },
        ];
        const term = query?.trim().toLocaleLowerCase().replace(/^@/, '') ?? '';
        const matching = allMembers.filter((member) =>
          `${member.title} ${member.username ?? ''}`.toLocaleLowerCase().includes(term),
        );
        const members = matching.slice(offset, offset + limit);
        const nextOffset = offset + members.length;
        return {
          members,
          totalCount: matching.length,
          hasMore: nextOffset < matching.length,
          ...(nextOffset < matching.length ? { nextOffset } : {}),
        };
      });
    }
    function setBlocked(peer: TelegramPeer, blocked: boolean) {
      return Effect.sync(() => {
        stats.setBlocked += 1;
        if (blocked) blockedPeers.add(peer.id);
        else blockedPeers.delete(peer.id);
      });
    }
    function setPinnedDialog(peer: TelegramPeer, pinned: boolean) {
      return Effect.sync(() => {
        stats.setPinnedDialog += 1;
        if (pinned) pinnedPeers.add(peer.id);
        else pinnedPeers.delete(peer.id);
      });
    }
    function setArchived(peer: TelegramPeer, archived: boolean) {
      return Effect.sync(() => {
        stats.setArchived += 1;
        if (archived) archivedPeers.add(peer.id);
        else archivedPeers.delete(peer.id);
        return {};
      });
    }
    function deleteDialog(
      peer: TelegramPeer,
      _action?: import('../types').TelegramDeleteDialogAction,
    ) {
      return Effect.sync(() => {
        stats.deleteDialog += 1;
        deletedPeers.add(peer.id);
        return {};
      });
    }
    function setPinnedMessage(peer: TelegramPeer, messageId: number, pinned: boolean) {
      return Effect.sync(() => {
        stats.setPinnedMessage += 1;
        messages.set(
          peer.id,
          (messages.get(peer.id) ?? []).map((message) =>
            message.id === messageId ? { ...message, pinned } : message,
          ),
        );
        return {};
      });
    }
    function setTyping(_peer: TelegramPeer, _kind?: TelegramActivityKind) {
      return Effect.sync(() => {
        stats.setTyping += 1;
      });
    }
    function updatePoll(
      peer: TelegramPeer,
      messageId: number,
      current: TelegramPoll,
      action: TelegramPollAction,
      options: readonly string[],
    ) {
      return Effect.sync(() => {
        const source = (messages.get(peer.id) ?? []).find((message) => message.id === messageId);
        const poll = source?.poll ?? current;
        const voted = pollHasVote(poll);
        const results =
          action === 'vote'
            ? {
                ...poll.results,
                min: false,
                totalVoters: Math.max(
                  0,
                  (poll.results.totalVoters ?? 0) - Number(voted) + Number(options.length > 0),
                ),
                answers: poll.answers.map((answer) => {
                  const old = poll.results.answers?.find((item) => item.option === answer.option);
                  const chosen = options.includes(answer.option);
                  return {
                    option: answer.option,
                    chosen,
                    correct: old?.correct,
                    voters: Math.max(
                      0,
                      (old?.voters ?? 0) - Number(Boolean(old?.chosen)) + Number(chosen),
                    ),
                  };
                }),
              }
            : poll.results;
        const next = { ...poll, closed: action === 'close' || poll.closed, results };
        if (source)
          messages.set(
            peer.id,
            (messages.get(peer.id) ?? []).map((message) =>
              message.id === messageId ? { ...message, poll: next } : message,
            ),
          );
        return {
          updateBatches: [
            {
              updates: [
                {
                  type: 'poll-changed' as const,
                  pollId: poll.id,
                  peerId: peer.id,
                  messageId,
                  poll: next,
                  results,
                },
              ],
            },
          ],
        };
      });
    }
    const sendPoll = Effect.fn('FixtureTransport.sendPoll')(function* (
      peer: TelegramPeer,
      draft: TelegramPollDraft,
      randomId: string,
      reply?: TelegramReplyTarget,
    ) {
      const result = yield* sendText(peer, '', randomId, reply);
      const poll = pendingPoll(draft, randomId);
      poll.results = {
        totalVoters: 0,
        solution: draft.solution,
        answers: poll.answers.map((answer, index) => ({
          option: answer.option,
          voters: 0,
          correct: draft.quiz && index === draft.correctAnswer,
        })),
      };
      const message = { ...result.message, poll };
      messages.set(
        peer.id,
        (messages.get(peer.id) ?? []).map((item) => (item.id === message.id ? message : item)),
      );
      return { ...result, message };
    });
    const sendContact = Effect.fn('FixtureTransport.sendContact')(function* (
      peer: TelegramPeer,
      contact: TelegramContact,
      randomId: string,
      reply?: TelegramReplyTarget,
    ) {
      const sent = yield* sendText(peer, '', randomId, reply);
      const message = { ...sent.message, contact };
      messages.set(
        peer.id,
        (messages.get(peer.id) ?? []).map((item) => (item.id === message.id ? message : item)),
      );
      return { message };
    });
    const sendText = Effect.fn('FixtureTransport.sendText')(function* (
      peer: TelegramPeer,
      text: string,
      randomId: string,
      reply?: TelegramReplyTarget,
      formats?: readonly TelegramTextFormat[],
    ) {
      stats.sendText += 1;
      stats.lastSendRandomId = randomId;
      if (text === 'FAIL')
        return yield* Effect.fail(createMtprotoError('transport', 'Fixture send failure'));
      if (scenario === 'held-send') {
        pendingSend = yield* Deferred.make<void>();
        yield* Deferred.await(pendingSend);
        pendingSend = undefined;
      }
      const message: TelegramMessage = {
        id: (messages.get(peer.id)?.at(-1)?.id ?? 0) + 1,
        peerId: peer.id,
        senderId: 'self',
        text,
        date: Math.floor(Date.now() / 1000),
        outgoing: true,
        randomId,
        topicId: reply?.topMessageId,
        replyToId: reply?.messageId,
        replyQuote: reply?.quoteText,
        formats: formats?.filter(({ kind }) => kind !== 'textUrl'),
        links: formats
          ?.filter(({ kind }) => kind === 'textUrl')
          .map(({ offset, length, url }) => ({ offset, length, url })),
      };
      if (gallery) {
        messages.set(peer.id, [...(messages.get(peer.id) ?? []), message]);
        gallery.afterSend?.(message);
      }
      return { message };
    });
    const sendFile = Effect.fn('FixtureTransport.sendFile')(function* (
      peer: TelegramPeer,
      file: File,
      options: SendFileOptions,
    ) {
      stats.sendFile += 1;
      if (options.onProgress) yield* options.onProgress(0.25);
      if (scenario === 'held-upload' || holdUpload) {
        holdUpload = false;
        pendingUpload = yield* Deferred.make<void>();
        yield* Deferred.await(pendingUpload);
        pendingUpload = undefined;
      }
      if (options.onProgress) yield* options.onProgress(1);
      const result = yield* sendText(
        peer,
        options.caption || file.name,
        options.randomId,
        options.reply,
        options.formats,
      );
      const dimensions = yield* fixtureMediaDimensions(file);
      return {
        message: {
          ...result.message,
          media: {
            kind: (options.asSticker
              ? 'sticker'
              : fixtureMediaKind(file, options.sendAs)) as TelegramMedia['kind'],
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            ...dimensions,
          },
        },
      };
    });
    const sendAlbum = Effect.fn('FixtureTransport.sendAlbum')(function* (
      peer: TelegramPeer,
      attachments: SendAlbumAttachment[],
      options: SendAlbumOptions,
    ) {
      stats.sendAlbum += 1;
      if (attachments.length < 2 || attachments.length > 10) {
        return yield* Effect.fail(
          createMtprotoError(
            'transport',
            'Fixture albums must contain between 2 and 10 attachments',
          ),
        );
      }
      if (options.onProgress) yield* options.onProgress(0.25);
      if (scenario === 'held-upload' || holdUpload) {
        holdUpload = false;
        pendingUpload = yield* Deferred.make<void>();
        yield* Deferred.await(pendingUpload);
        pendingUpload = undefined;
      }
      if (options.onProgress) yield* options.onProgress(1);
      const history = messages.get(peer.id) ?? [];
      const firstId = (history.at(-1)?.id ?? 0) + 1;
      const groupedId = `fixture-album-${attachments[0]!.randomId}`;
      const dimensions = yield* Effect.forEach(attachments, ({ file }) =>
        fixtureMediaDimensions(file),
      );
      const sent = attachments.map(({ file, randomId, sendAs }, index): TelegramMessage => ({
        id: firstId + index,
        peerId: peer.id,
        senderId: 'self',
        text: index === 0 ? options.caption : '',
        date: Math.floor(Date.now() / 1000),
        outgoing: true,
        randomId,
        groupedId,
        topicId: options.reply?.topMessageId,
        replyToId: options.reply?.messageId,
        replyQuote: options.reply?.quoteText,
        formats:
          index === 0 ? options.formats?.filter(({ kind }) => kind !== 'textUrl') : undefined,
        links:
          index === 0
            ? options.formats
                ?.filter(({ kind }) => kind === 'textUrl')
                .map(({ offset, length, url }) => ({ offset, length, url }))
            : undefined,
        media: {
          kind: fixtureMediaKind(file, sendAs),
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          ...dimensions[index],
        },
      }));
      messages.set(peer.id, [...history, ...sent]);
      return { messages: sent };
    });
    const downloadMedia = Effect.fn('FixtureTransport.downloadMedia')(function* (
      message: TelegramMessage,
      options?: TelegramDownloadOptions,
    ) {
      stats.downloadMedia += 1;
      stats.downloadMediaRequests.push({
        peerId: message.peerId,
        messageId: message.id,
        name: message.media?.name ?? message.linkPreview?.media?.name,
        preview: Boolean(options?.preview),
      });
      if (options?.preview) stats.downloadMediaPreview += 1;
      else stats.downloadMediaFull += 1;
      if (!connected) {
        return yield* Effect.fail(
          createMtprotoError('transport', 'Fixture media requested before connection was ready'),
        );
      }
      if (options?.progress) yield* Effect.sync(() => options.progress!(0));
      if (
        scenario === 'media-download-retry' &&
        message.media?.name === 'fixture.jpg' &&
        fixtureMediaFailures < 2
      ) {
        fixtureMediaFailures += 1;
        return yield* Effect.fail(createMtprotoError('transport', 'Fixture media download failed'));
      }
      if (
        ['delayed-layout.tgs', 'delayed-history-layout.tgs'].includes(message.media?.name ?? '')
      ) {
        yield* Effect.sleep(400);
      }
      if (
        scenario === 'held-media-download' &&
        [
          '4000_Essential_English_Words_all_books.zip',
          'held-image.png',
          'swarm-home-1.0.0.z01',
          'swarm-home-1.0.0.zip',
        ].includes(message.media?.name ?? '')
      ) {
        if (options?.progress) yield* Effect.sync(() => options.progress!(0.25));
        return yield* Effect.never;
      }
      const media = message.media ?? message.linkPreview?.media;
      const asset = media && gallery?.asset(media, options);
      if (asset)
        return yield* Effect.tryPromise({
          try: () => asset,
          catch: () => createMtprotoError('transport', 'Demo media unavailable'),
        });
      if (media?.kind === 'voice') return fixtureVoiceBlob(media.duration);
      if (media?.kind === 'round-video') return fixtureMp4Blob();
      if (media?.mimeType === 'application/x-tgsticker') return fixtureTgsBlob();
      if (message.linkPreview?.media && !options?.preview) {
        return fixtureMp4Blob();
      }
      const width = media?.width ?? 320;
      const height = media?.height ?? 180;
      const blob = new Blob(
        [
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#6650d8"/></svg>`,
        ],

        { type: 'image/svg+xml' },
      );
      if (options?.progress) yield* Effect.sync(() => options.progress!(1));
      return blob;
    });
    const downloadAvatar = Effect.fn('FixtureTransport.downloadAvatar')(function* (
      peer: TelegramPeer,
    ) {
      stats.downloadAvatar += 1;
      if (avatarFailureArmed && peer.id === peers[1]!.id) {
        stats.releaseAvatarDownload += 1;
        if (avatarFailureReleased)
          return yield* Effect.fail(
            createMtprotoError('transport', 'Fixture avatar download failed'),
          );
        const pending = yield* Deferred.make<never, MtprotoError>();
        pendingAvatarFailures.add(pending);
        return yield* Deferred.await(pending);
      }
      const label = peer.id === peers[0]!.id ? 'A' : 'R';
      return new Blob(
        [
          `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#6650d8"/><text x="48" y="61" text-anchor="middle" font-size="42" fill="white">${label}</text></svg>`,
        ],

        { type: 'image/svg+xml' },
      );
    });
    function getThemes() {
      return Effect.sync(() => {
        stats.getThemes += 1;
        return [
          {
            id: 'theme-fixture-ocean',
            slug: 'fixture-ocean',
            title: 'Ocean Blue',
            emoticon: '🌊',
            default: false,
            forChat: false,
            settings: [
              {
                baseTheme: 'tinted' as const,
                accentColor: '#56a8e8',
                outboxAccentColor: '#4b8fca',
                messageColors: ['#2b5278', '#376f9d'],
                messageColorsAnimated: false,
              },
            ],
          },
          {
            id: 'theme-fixture-mint',
            slug: 'fixture-mint',
            title: 'Mint Day',
            emoticon: '🌿',
            default: false,
            forChat: false,
            settings: [
              {
                baseTheme: 'day' as const,
                accentColor: '#2a9d8f',
                outboxAccentColor: '#70bfae',
                messageColors: ['#ccefe5'],
                messageColorsAnimated: false,
              },
            ],
          },
        ];
      });
    }
    function getChatAppearance(peer: TelegramPeer) {
      return Effect.sync(() => {
        stats.getChatAppearance += 1;
        if (peer.id !== peers[0]?.id) return undefined;
        return {
          theme: {
            id: 'theme-fixture-ocean',
            slug: 'fixture-ocean',
            title: 'Ocean Blue',
            emoticon: '🌊',
            default: false,
            forChat: true,
            settings: [
              {
                baseTheme: 'night' as const,
                accentColor: '#56a8e8',
                outboxAccentColor: '#4b8fca',
                messageColors: ['#e8f5cf', '#f4f8dc'],
                messageColorsAnimated: false,
                wallpaper: {
                  id: 'wallpaper-fixture-chat-ocean',
                  dark: false,
                  pattern: true,
                  hasFile: true,
                  settings: {
                    backgroundColors: ['#102d40', '#1d5960', '#312f61'],
                    blur: false,
                    motion: false,
                    rotation: 135,
                    intensity: 60,
                  },
                },
              },
            ],
          },
        };
      });
    }
    function getWallpapers() {
      return Effect.sync(() => {
        stats.getWallpapers += 1;
        return [
          {
            id: 'wallpaper-fixture-lagoon',
            slug: 'fixture-lagoon',
            dark: true,
            pattern: false,
            hasFile: true,
            settings: {
              backgroundColors: ['#183b56', '#267871'],
              blur: false,
              motion: false,
              rotation: 45,
            },
          },
          {
            id: 'wallpaper-fixture-peach',
            dark: false,
            pattern: false,
            hasFile: false,
            settings: {
              backgroundColors: ['#f7d9c4', '#c6def1', '#dbcdf0'],
              blur: false,
              motion: false,
              rotation: 135,
            },
          },
        ];
      });
    }
    const downloadWallpaper = Effect.fn('FixtureTransport.downloadWallpaper')(function* (
      wallpaperId: string,
    ) {
      stats.downloadWallpaper += 1;
      if (wallpaperId === 'wallpaper-fixture-chat-ocean') {
        return new Blob(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><g fill="none" stroke="#ffffff" stroke-opacity=".16" stroke-width="4"><circle cx="60" cy="60" r="24"/><path d="M140 40l42 42-42 42-42-42zM25 180h190"/></g></svg>',
          ],

          { type: 'image/svg+xml' },
        );
      }
      if (wallpaperId !== 'wallpaper-fixture-lagoon')
        return yield* Effect.fail(createMtprotoError('transport', 'Unknown fixture wallpaper.'));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#183b56"/><stop offset="1" stop-color="#267871"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><g fill="#ffffff" opacity=".08"><circle cx="180" cy="170" r="90"/><circle cx="900" cy="540" r="180"/></g></svg>`;
      return new Blob([svg], { type: 'image/svg+xml' });
    });
    let favoriteStickers: TelegramSticker[] = [];
    const getFavoriteStickers = () => Effect.sync(() => [...favoriteStickers]);
    const setStickerFavorite = (sticker: TelegramSticker, favorite: boolean) =>
      Effect.sync(() => {
        favoriteStickers = favoriteStickers.filter((value) => value.id !== sticker.id);
        if (favorite) favoriteStickers.unshift(sticker);
        return true;
      });
    const searchStickers = (query: string, offset: number = 0) =>
      Effect.sync(() => ({
        stickers: fixtureStickers()
          .slice(0, 2)
          .map((sticker, index) => ({
            ...sticker,
            id: `search-${query}-${offset + index}`,
            title: `${query} ${offset + index}`,
          })),
        ...(offset === 0 ? { nextOffset: 2 } : {}),
      }));
    function getRecentStickers() {
      return Effect.sync(() => {
        stats.getRecentStickers += 1;
        return fixtureStickers();
      });
    }
    const removedStickerPacks = new Set<string>();
    const addedStickerPacks = new Map<string, TelegramStickerPack>();
    const getStickerPack = (shortName: string) =>
      Effect.sync(() => ({
        id:
          shortName === 'FixtureAnimals'
            ? 'pack-a'
            : shortName === 'FixtureAnimated'
              ? 'pack-b'
              : 'pack-c',
        accessHash: '10',
        shortName,
        title:
          shortName === 'FixtureAnimals'
            ? 'Fixture Animals'
            : shortName === 'FixtureAnimated'
              ? 'Fixture Animated'
              : 'Fixture Cats',
        installed:
          shortName === 'FixtureAnimals'
            ? !removedStickerPacks.has('pack-a')
            : shortName === 'FixtureAnimated'
              ? !removedStickerPacks.has('pack-b')
              : addedStickerPacks.has('pack-c'),
        count: 3,
        stickers: fixtureStickers(),
      }));
    const searchStickerPacks = (_query: string) =>
      getStickerPack('FixtureCats').pipe(Effect.map((pack) => [pack]));
    const setStickerPackInstalled = (pack: TelegramStickerPack, installed: boolean) =>
      Effect.sync(() => {
        if (installed) {
          removedStickerPacks.delete(pack.id);
          addedStickerPacks.set(pack.id, { ...pack, installed: true });
        } else {
          removedStickerPacks.add(pack.id);
          addedStickerPacks.delete(pack.id);
        }
        return true;
      });
    function getStickerPacks() {
      return Effect.sync(() => {
        stats.getStickerPacks += 1;
        const recent = fixtureStickers();
        if (scenario === 'large-sticker-pack') {
          return [
            {
              id: 'pack-large',
              title: 'Large Fixture Pack',
              stickers: Array.from({ length: 100 }, (_, index) => ({
                ...recent[index % recent.length]!,
                id: `sticker-large-${index + 1}`,
                accessHash: `${index + 10}`,
                fileReference: new Uint8Array([index % 256]),
              })),
            },
          ];
        }
        return [
          {
            id: 'pack-a',
            accessHash: '10',
            shortName: 'FixtureAnimals',
            installed: true,
            title: 'Fixture Animals',
            stickers: recent.slice(0, 2),
          },
          {
            id: 'pack-b',
            accessHash: '11',
            shortName: 'FixtureAnimated',
            installed: true,
            title: 'Fixture Animated',
            stickers: recent.slice(2),
          },
          ...addedStickerPacks.values(),
        ].filter(
          (pack, index, all) =>
            !removedStickerPacks.has(pack.id) &&
            all.findIndex((value) => value.id === pack.id) === index,
        );
      });
    }
    const getSavedGifs = Effect.fn('FixtureTransport.getSavedGifs')(function* () {
      stats.getSavedGifs += 1;
      if (scenario === 'gif-index-fails')
        return yield* Effect.fail(createMtprotoError('transport', 'fixture GIF index failure'));
      return [
        {
          id: 'gif-1',
          accessHash: '4',
          fileReference: new Uint8Array([4]),
          emoji: 'GIF',
          mimeType: 'image/gif',
        },
      ];
    });
    function searchGifs(_peer: TelegramPeer, query: string) {
      return Effect.sync(() => {
        stats.searchGifs += 1;
        return [
          {
            id: `gif-search-${query}`,
            accessHash: '5',
            fileReference: new Uint8Array([5]),
            emoji: 'GIF',
            title: `${query} result`,
            mimeType: 'image/gif',
          },
        ];
      });
    }
    function fixtureStickers() {
      return [
        {
          id: 'sticker-1',
          accessHash: '1',
          fileReference: new Uint8Array([1]),
          emoji: '👍',
          mimeType: 'image/webp',
        },
        {
          id: 'sticker-2',
          accessHash: '2',
          fileReference: new Uint8Array([2]),
          emoji: '🎉',
          mimeType: 'image/webp',
        },
        {
          id: 'sticker-3',
          accessHash: '3',
          fileReference: new Uint8Array([3]),
          emoji: '✨',
          mimeType: 'application/x-tgsticker',
        },
      ];
    }
    function downloadSticker(sticker: TelegramSticker) {
      return Effect.sync(() => {
        stats.downloadSticker += 1;
        if (sticker.mimeType === 'application/x-tgsticker') {
          return fixtureTgsBlob();
        }
        if (scenario === 'large-sticker-pack' && sticker.id.startsWith('sticker-large-')) {
          const index = Number(sticker.id.slice('sticker-large-'.length));
          const [width, height] = index % 2 === 0 ? [128, 256] : [256, 128];
          return new Blob(
            [
              `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="2" y="2" width="${width - 4}" height="${height - 4}" rx="12" fill="#6650d8" stroke="#fff" stroke-width="4"/><text x="50%" y="55%" text-anchor="middle" font-size="48">${sticker.emoji}</text></svg>`,
            ],

            { type: 'image/svg+xml' },
          );
        }
        return new Blob(
          [
            `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="24" fill="#6650d8"/><text x="64" y="82" text-anchor="middle" font-size="58">${sticker.emoji}</text></svg>`,
          ],

          { type: 'image/svg+xml' },
        );
      });
    }
    function downloadCustomEmoji() {
      return Effect.sync(() => {
        return new Blob(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#6da9f7"/></svg>',
          ],

          { type: 'image/svg+xml' },
        );
      });
    }
    function getBotCommands(peer: TelegramPeer) {
      return Effect.sync(() => {
        stats.getBotCommands += 1;
        const configured = botCommandsByPeer.get(peer.id);
        if (configured) return configured.map((command) => ({ ...command }));
        const botId = peer.kind === 'user' ? peer.id : 'u:606';
        const bot = { botId, botUsername: 'fixture_helper_bot', botName: 'Fixture Helper Bot' };
        return [
          { command: 'help', description: 'Show available commands', ...bot },
          { command: 'status', description: 'Show fixture status', ...bot },
        ];
      });
    }
    const startBot = Effect.fn('FixtureTransport.startBot')(function* (
      peer: TelegramPeer,
      startParam: string,
      randomId: string,
    ) {
      stats.startBot += 1;
      if (heldBotStarts > 0) {
        heldBotStarts -= 1;
        const pending = yield* Deferred.make<void>();
        pendingBotStarts.push(pending);
        yield* Deferred.await(pending);
        return {
          message: {
            id: (messages.get(peer.id)?.at(-1)?.id ?? 0) + 1,
            peerId: peer.id,
            senderId: 'self',
            text: 'Fixture delayed bot action',
            date: Math.floor(Date.now() / 1000),
            outgoing: true,
            randomId,
          },
        };
      }
      const current = messages.get(peer.id) ?? [];
      const outgoing: TelegramMessage = {
        id: (current.at(-1)?.id ?? 0) + 1,
        peerId: peer.id,
        senderId: 'self',
        text: startParam ? `/start ${startParam}` : '/start',
        date: Math.floor(Date.now() / 1000),
        outgoing: true,
        randomId,
      };
      const replyMessage: TelegramMessage = {
        id: outgoing.id + 1,
        peerId: peer.id,
        senderId: peer.id,
        senderName: 'Fixture Helper Bot',
        text: 'Use the keyboard or the inline actions below.',
        date: outgoing.date + 1,
        outgoing: false,
        botKeyboard: {
          kind: 'reply',
          persistent: true,
          placeholder: 'Choose a bot action',
          rows: [
            [
              { kind: 'text', text: 'Status' },
              { kind: 'text', text: 'Help' },
              {
                kind: 'simple-web-app',
                text: 'Open Mini App',
                url: 'https://example.com/mini',
                bot: { id: 'u:606', kind: 'user', accessHash: '6' },
              },
            ],
          ],
        },
      };
      const inlineMessage: TelegramMessage = {
        id: outgoing.id + 2,
        peerId: peer.id,
        senderId: peer.id,
        senderName: 'Fixture Helper Bot',
        text: 'Inline actions',
        date: outgoing.date + 2,
        outgoing: false,
        botKeyboard: {
          kind: 'inline',
          rows: [
            [
              { kind: 'callback', text: 'Refresh', data: [1] },
              { kind: 'url', text: 'Docs', url: 'https://example.com/bot' },
              { kind: 'url-auth', text: 'Sign in', url: 'https://example.com/auth', buttonId: 4 },
              { kind: 'copy', text: 'Copy code', copyText: 'fixture-code' },
            ],
          ],
        },
      };
      messages.set(peer.id, [...current, outgoing, replyMessage, inlineMessage]);
      yield* PubSub.publish(updateHub, {
        updates: [{ type: 'new-message', pts: ++fixturePts, ptsCount: 1, message: replyMessage }],
      });
      yield* PubSub.publish(updateHub, {
        updates: [{ type: 'new-message', pts: ++fixturePts, ptsCount: 1, message: inlineMessage }],
      });
      return { message: outgoing };
    });
    const answerBotCallback = Effect.fn('FixtureTransport.answerBotCallback')(function* (
      _peer: TelegramPeer,
      _messageId: number,
      _data: number[],
    ) {
      stats.answerBotCallback += 1;
      if (holdBotCallback) {
        holdBotCallback = false;
        pendingBotCallback = yield* Deferred.make<void>();
        yield* Deferred.await(pendingBotCallback);
        pendingBotCallback = undefined;
      }
      return { message: 'Fixture callback complete.', alert: _data[0] === 99 };
    });
    function requestUrlAuth() {
      return Effect.sync(() => {
        return {
          kind: 'request' as const,
          botTitle: 'Fixture Helper Bot',
          domain: 'example.com',
          requestWriteAccess: true,
          requestPhoneNumber: false,
          matchCodesFirst: extendedUrlAuth,
          isApp: extendedUrlAuth,
          ...(extendedUrlAuth
            ? { matchCodes: ['F7Q2', 'L9M4'], verifiedAppName: 'Fixture Web App' }
            : {}),
        };
      });
    }
    function acceptUrlAuth(
      _peer: TelegramPeer,
      _messageId: number,
      _buttonId: number,
      options?: TelegramUrlAuthAcceptOptions,
    ) {
      return Effect.sync(() => {
        acceptedUrlAuthOptions = options;
        return { kind: 'accepted' as const, url: 'https://example.com/authenticated' };
      });
    }
    function sendSticker(
      peer: TelegramPeer,
      sticker: TelegramSticker,
      randomId: string,
      reply?: TelegramReplyTarget,
    ) {
      return Effect.sync(() => {
        stats.sendSticker += 1;
        const id = (messages.get(peer.id)?.at(-1)?.id ?? 0) + 1;
        return {
          message: {
            id,
            peerId: peer.id,
            senderId: 'self',
            text: '',
            date: Math.floor(Date.now() / 1000),
            outgoing: true,
            randomId,
            topicId: reply?.topMessageId,
            replyToId: reply?.messageId,
            replyQuote: reply?.quoteText,
            media: {
              kind: 'sticker' as const,
              name: `sticker-${sticker.id}.${sticker.mimeType === 'application/x-tgsticker' ? 'tgs' : 'webp'}`,
              mimeType: sticker.mimeType,
            },
          },
        };
      });
    }
    function getReactionPeople(peer: TelegramPeer, messageId: number, emoji: string) {
      return Effect.sync(() => {
        const reaction = messages
          .get(peer.id)
          ?.find(({ id }) => id === messageId)
          ?.reactions?.find((item) => item.emoji === emoji);
        const people: TelegramReactionPerson[] = [
          ...(reaction?.chosen ? [{ id: 'u:999', name: 'You' }] : []),
          { id: 'u:101', name: 'Alice Fixture' },
          { id: 'u:102', name: 'Bob Fixture' },
        ]
          .slice(0, reaction?.count ?? 0)
          .map((person) => ({
            ...person,
            peer: { id: person.id, kind: 'user', accessHash: person.id.slice(2) },
            initials: person.name
              .split(' ')
              .map((part) => part[0])
              .join(''),
            color: '#6650d8',
            hasAvatar: person.id !== 'u:999',
            ...(person.id !== 'u:999' ? { avatarId: `fixture-${person.id}` } : {}),
          }));
        return { people, count: reaction?.count ?? 0 };
      });
    }
    const getPollVotes = (
      peer: TelegramPeer,
      messageId: number,
      option?: string,
      offset?: string,
    ) =>
      Effect.sync((): TelegramPollVotes => {
        const poll = messages.get(peer.id)?.find((message) => message.id === messageId)?.poll;
        const answers = poll?.answers ?? [];
        const count = option
          ? (poll?.results.answers?.find((answer) => answer.option === option)?.voters ?? 0)
          : (poll?.results.totalVoters ?? 0);
        const start = Number(offset || 0);
        const people = Array.from(
          { length: Math.max(0, Math.min(2, count - start)) },
          (_, index) => ({
            id: `u:${101 + start + index}`,
            peer: { id: `u:${101 + start + index}`, kind: 'user' as const, accessHash: '1' },
            name: start + index === 0 ? 'Alice Fixture' : `Voter ${start + index + 1}`,
            initials: 'VF',
            color: '#6650d8',
            hasAvatar: true,
            avatarId: `fixture-voter-${start + index}`,
            options: [
              option ?? answers[(start + index) % Math.max(1, answers.length)]?.option ?? '00',
            ],
            date: 1700000000,
          }),
        );
        return {
          people,
          count,
          nextOffset: start + people.length < count ? String(start + people.length) : undefined,
        };
      });
    const privacySettings = new Map<TelegramPrivacyKey, TelegramPrivacySetting>();
    let hideReadTime = false;
    const getPrivacy = (key: TelegramPrivacyKey) =>
      Effect.sync(
        () =>
          privacySettings.get(key) ?? {
            key,
            rules: [{ kind: 'allow-contacts' as const }, { kind: 'deny-all' as const }],
            peers: [],
          },
      );
    const setPrivacy = Effect.fn('FixtureTransport.setPrivacy')(function* (
      key: TelegramPrivacyKey,
      change: TelegramPrivacyChange,
    ) {
      const current = yield* getPrivacy(key);
      const next = { ...current, rules: changePrivacyRules(current.rules, change) };
      privacySettings.set(key, next);
      return next;
    });
    const getReadTimePrivacy = () => Effect.sync(() => hideReadTime);
    const setReadTimePrivacy = (hidden: boolean) =>
      Effect.sync(() => {
        hideReadTime = hidden;
        return hidden;
      });
    let sessionTtl = 180;
    let activeSessions: TelegramActiveSessions['sessions'] = [
      {
        id: '0',
        current: true,
        device: 'Fixture browser',
        platform: 'Linux',
        systemVersion: '6',
        appName: 'TeleVecha',
        appVersion: '0.1',
        createdAt: 1700000000,
        activeAt: 1700000500,
        ip: '127.0.0.1',
        country: 'Local',
        region: '',
        passwordPending: false,
        unconfirmed: false,
      },
      {
        id: '1234567890123456789',
        current: false,
        device: 'Pixel 8',
        platform: 'Android',
        systemVersion: '15',
        appName: 'Telegram Android',
        appVersion: '12',
        createdAt: 1700000000,
        activeAt: 1700000400,
        ip: '192.0.2.1',
        country: 'Fixture',
        region: 'Test City',
        passwordPending: false,
        unconfirmed: false,
      },
      {
        id: '-234567890123456789',
        current: false,
        device: 'Desktop PC',
        platform: 'Windows',
        systemVersion: '11',
        appName: 'Telegram Desktop',
        appVersion: '6',
        createdAt: 1700000000,
        activeAt: 1700000200,
        ip: '192.0.2.2',
        country: 'Fixture',
        region: 'Test City',
        passwordPending: false,
        unconfirmed: false,
      },
    ];
    const getActiveSessions = () =>
      Effect.sync(() => ({
        sessions: activeSessions.map((session) => ({ ...session })),
        ttlDays: sessionTtl,
      }));
    const terminateSession = (hash?: string) =>
      Effect.sync(() => {
        activeSessions = activeSessions.filter(
          (session) => session.current || (hash !== undefined && session.id !== hash),
        );
      });
    const setSessionTtl = (days: number) =>
      Effect.sync(() => {
        sessionTtl = days;
      });
    function getMessageReadReceipts(peer: TelegramPeer, _messageId: number) {
      stats.getMessageReadReceipts += 1;
      if (scenario === 'unread-receipts' || scenario === 'slow-unread-receipts')
        return Effect.succeed<TelegramReadReceipts>({ state: 'unread', people: [] }).pipe(
          Effect.delay(scenario === 'slow-unread-receipts' ? 400 : 0),
        );
      return Effect.succeed<TelegramReadReceipts>({
        state: 'available',
        people: (peer.kind === 'user'
          ? [{ id: peer.id, name: 'Alice Fixture' }]
          : [
              { id: 'u:404', name: 'Fixture Author' },
              { id: 'u:405', name: 'Another Member' },
            ]
        ).map((person, index) => ({
          ...person,
          peer: { id: person.id, kind: 'user' as const, accessHash: '1' },
          initials: person.name
            .split(' ')
            .map((part) => part[0])
            .join(''),
          color: '#408acf',
          hasAvatar: true,
          avatarId: `fixture-${person.id}`,
          readAt: Math.floor(Date.now() / 1000) - 60 * (index + 1),
        })),
      }).pipe(Effect.delay(scenario === 'slow-read-receipts' ? 400 : 0));
    }
    function setReaction(peer: TelegramPeer, messageId: number, emoji?: string) {
      return Effect.sync(() => {
        stats.setReaction += 1;
        const reactions = emoji
          ? [
              {
                emoji,
                ...(emoji.startsWith('custom:')
                  ? { customEmojiId: emoji.slice('custom:'.length) }
                  : {}),
                count: 1,
                chosen: true,
              },
            ]
          : [];
        messages.set(
          peer.id,
          (messages.get(peer.id) ?? []).map((message) =>
            message.id === messageId ? { ...message, reactions } : message,
          ),
        );
        return {};
      });
    }
    function deleteMessages(peer: TelegramPeer, messageIds: number[], _revoke: boolean) {
      return Effect.sync(() => {
        stats.deleteMessages += 1;
        const deleted = new Set(messageIds);
        messages.set(
          peer.id,
          (messages.get(peer.id) ?? []).filter((message) => !deleted.has(message.id)),
        );
        return {};
      });
    }
    const editMessage = Effect.fn('FixtureTransport.editMessage')(function* (
      peer: TelegramPeer,
      messageId: number,
      text: string,
      formats?: readonly TelegramTextFormat[],
      replacement?: EditMediaOptions,
    ) {
      stats.editMessage += 1;
      if (holdEdit) {
        holdEdit = false;
        pendingEdit = yield* Deferred.make<void>();
        yield* Deferred.await(pendingEdit);
        pendingEdit = undefined;
      }
      const message = messages.get(peer.id)?.find(({ id }) => id === messageId);
      if (!message)
        return yield* Effect.fail(createMtprotoError('transport', 'Fixture message was not found'));
      const dimensions = replacement ? yield* fixtureMediaDimensions(replacement.file) : undefined;
      const edited: TelegramMessage = {
        ...message,
        text,
        formats: formats?.filter(({ kind }) => kind !== 'textUrl'),
        links: formats
          ?.filter(({ kind }) => kind === 'textUrl')
          .map(({ offset, length, url }) => ({ offset, length, url })),
        ...(replacement
          ? {
              media: {
                kind: fixtureMediaKind(replacement.file, replacement.sendAs),
                name: replacement.file.name,
                mimeType: replacement.file.type || 'application/octet-stream',
                size: replacement.file.size,
                ...dimensions,
              },
            }
          : {}),
        editedAt: Math.floor(Date.now() / 1000),
      };
      messages.set(
        peer.id,
        (messages.get(peer.id) ?? []).map((item) => (item.id === messageId ? edited : item)),
      );
      return { message: edited };
    });
    function fixtureMediaDimensions(file: File) {
      if (file.type.startsWith('video/') && typeof document !== 'undefined') {
        return Effect.tryPromise((signal) => readVideoPreview(file, signal)).pipe(
          Effect.map(({ width, height, duration }) => ({ width, height, duration })),
          Effect.catch(() => Effect.succeed(undefined)),
        );
      }
      if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') {
        return Effect.succeed(undefined);
      }
      return Effect.tryPromise(async () => {
        const image = await createImageBitmap(file);
        try {
          return { width: image.width, height: image.height };
        } finally {
          image.close();
        }
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    }
    function fixtureMediaKind(file: File, sendAs: OutgoingAttachmentMode) {
      if (sendAs === 'file') return 'file';
      if (file.type === 'image/gif') return 'animation';
      if (file.type.startsWith('image/')) return 'photo';
      if (file.type.startsWith('video/')) return 'video';
      return 'file';
    }
    const forwardMessage = Effect.fn('FixtureTransport.forwardMessage')(function* (
      fromPeer: TelegramPeer,
      toPeer: TelegramPeer,
      messageId: number,
      randomId: string,
      options?: TelegramForwardOptions,
    ) {
      stats.forwardMessage += 1;
      const source = messages.get(fromPeer.id)?.find(({ id }) => id === messageId);
      if (!source)
        return yield* Effect.fail(createMtprotoError('transport', 'Fixture message was not found'));
      const message: TelegramMessage = {
        ...source,
        groupedId: undefined,
        text: options?.hideCaption && source.media ? '' : source.text,
        formats: options?.hideCaption && source.media ? [] : source.formats,
        forwardedFrom:
          options?.hideAuthor || options?.hideCaption
            ? undefined
            : (source.forwardedFrom ?? {
                name: source.senderName ?? 'Fixture sender',
                peerId: fromPeer.id,
                messageId,
              }),
        id: (messages.get(toPeer.id)?.at(-1)?.id ?? 0) + 1,
        peerId: toPeer.id,
        topicId: options?.topMessageId,
        replyToId: options?.topMessageId,
        senderId: 'self',
        outgoing: true,
        date: Math.floor(Date.now() / 1000),
        randomId,
      };
      messages.set(toPeer.id, [...(messages.get(toPeer.id) ?? []), message]);
      return { message };
    });
    const forwardMessages = Effect.fn('FixtureTransport.forwardMessages')(function* (
      fromPeer: TelegramPeer,
      toPeer: TelegramPeer,
      items: readonly { messageId: number; randomId: string }[],
      options?: TelegramForwardOptions,
    ) {
      const groups = new Map(
        items.map(({ messageId }) => [
          messageId,
          messages.get(fromPeer.id)?.find(({ id }) => id === messageId)?.groupedId,
        ]),
      );
      const sent = yield* Effect.forEach(items, ({ messageId, randomId }) =>
        Effect.gen(function* () {
          const result = yield* forwardMessage(fromPeer, toPeer, messageId, randomId, options);
          const group = groups.get(messageId);
          if (group) result.message.groupedId = `forward:${items[0]!.randomId}:${group}`;
          return result.message;
        }),
      );
      stats.forwardMessage -= items.length - 1;
      return { messages: sent };
    });
    window.__televechaFixture = {
      stats,
      receiveMessage: (sample) => {
        const history = messages.get(sample.peerId) ?? [];
        const message = { ...sample, id: (history.at(-1)?.id ?? 0) + 1 };
        messages.set(message.peerId, [...history, message]);
        Queue.offerUnsafe(controls, {
          _tag: 'emit',
          update: { type: 'new-message', message, pts: ++fixturePts, ptsCount: 1 },
        });
      },
      setMessages: (values) => {
        for (const value of values)
          messages.set(
            value.peerId,
            [
              ...(messages.get(value.peerId) ?? []).filter((item) => item.id !== value.id),
              value,
            ].sort((a, b) => a.id - b.id),
          );
      },
      emit: (update) => {
        if (
          (update.type === 'new-message' || update.type === 'edit-message') &&
          update.message.peerId === discussionPeer.id
        ) {
          messages.set(
            discussionPeer.id,
            [
              ...(messages.get(discussionPeer.id) ?? []).filter(
                (message) => message.id !== update.message.id,
              ),
              update.message,
            ].sort((a, b) => a.id - b.id),
          );
        } else if (update.type === 'delete-messages' && update.peerId === discussionPeer.id) {
          messages.set(
            discussionPeer.id,
            (messages.get(discussionPeer.id) ?? []).filter(
              (message) => !update.messageIds.includes(message.id),
            ),
          );
        }
        Queue.offerUnsafe(controls, { _tag: 'emit', update });
      },
      releaseConnect: () => {
        Queue.offerUnsafe(controls, { _tag: 'release-connect' });
      },
      releaseSend: () => {
        Queue.offerUnsafe(controls, { _tag: 'release-send' });
      },
      releaseUpload: () => {
        if (pendingUpload) Deferred.doneUnsafe(pendingUpload, Effect.void);
      },
      holdNextUpload: () => {
        holdUpload = true;
      },
      changeAndHoldReleaseAvatar: () => {
        Queue.offerUnsafe(controls, { _tag: 'change-avatar' });
      },
      failPendingAvatar: () => {
        Queue.offerUnsafe(controls, { _tag: 'fail-avatar' });
      },
      failNextHistory: (peerId, message) => {
        nextHistoryFailure = { peerId, message };
      },
      setBotCommands: (peerId, commands) => {
        botCommandsByPeer.set(
          peerId,
          commands.map((command) => ({ ...command })),
        );
      },
      holdNextBotCallback: () => {
        holdBotCallback = true;
      },
      releaseBotCallback: () => {
        if (pendingBotCallback) Deferred.doneUnsafe(pendingBotCallback, Effect.void);
      },
      holdNextBotStart: () => {
        heldBotStarts += 1;
      },
      releaseBotStart: () => {
        const pending = pendingBotStarts.shift();
        if (pending) Deferred.doneUnsafe(pending, Effect.void);
      },
      useExtendedUrlAuth: () => {
        extendedUrlAuth = true;
      },
      get acceptedUrlAuthOptions() {
        return acceptedUrlAuthOptions;
      },
      holdNextEdit: () => {
        holdEdit = true;
      },
      releaseEdit: () => {
        if (pendingEdit) Deferred.doneUnsafe(pendingEdit, Effect.void);
      },
      releaseHistory: () => {
        if (pendingHistory) Deferred.doneUnsafe(pendingHistory, Effect.void);
        else historyReleasePending = true;
      },
      releaseHistoryAround: () => {
        Queue.offerUnsafe(controls, { _tag: 'release-history-around' });
      },
      releaseSharedMediaCounts: () => {
        Queue.offerUnsafe(controls, { _tag: 'release-shared-media' });
      },
    };
    return {
      connect,
      disconnect,
      logOut,
      isAuthorized,
      getAuthorizedAccountId,
      requestCode,
      watchQrLogin: () =>
        Stream.unfold<number, import('../types').TelegramQrLogin, never, never>(0, (index) =>
          Effect.gen(function* () {
            if (index > 0) yield* Effect.sleep(5000);
            if (scenario === 'auth-qr-password' && index === 1)
              return [{ type: 'password-required' as const }, index + 1] as const;
            if (scenario === 'auth-qr-success' && index === 1) {
              authorized = true;
              return [{ type: 'authorized' as const }, index + 1] as const;
            }
            if ((scenario === 'auth-qr-password' || scenario === 'auth-qr-success') && index > 1)
              return undefined;
            return [
              {
                type: 'token' as const,
                url: `tg://login?token=fixture-token-${index}`,
                expires: Math.floor(Date.now() / 1000) + 5,
              },
              index + 1,
            ] as const;
          }),
        ),
      submitCode,
      submitPassword,
      getCurrentState,
      getDifference,
      getChannelDifference,
      getDialogs,
      getHistory,
      getHistoryAround,
      getUnreadNotifications: (peer, kind) =>
        Effect.sync(() => {
          const unread = (messages.get(peer.id) ?? []).filter((message) =>
            kind === 'mention' ? message.unreadMention : message.unreadReaction,
          );
          return { messages: unread, count: unread.length };
        }),
      readAllNotifications: (peer, kind) =>
        Effect.sync(() => {
          stats.readAllNotifications.push({ peerId: peer.id, kind });
          const field = kind === 'mention' ? 'unreadMention' : 'unreadReaction';
          messages.set(
            peer.id,
            (messages.get(peer.id) ?? []).map((message) => ({ ...message, [field]: false })),
          );
          return {};
        }),
      readMessageContents: (peer, messageIds) =>
        Effect.sync(() => {
          stats.readMessageContents.push({ peerId: peer.id, messageIds: [...messageIds] });
          messages.set(
            peer.id,
            (messages.get(peer.id) ?? []).map((message) =>
              messageIds.includes(message.id)
                ? { ...message, mediaUnread: false, unreadMention: false, unreadReaction: false }
                : message,
            ),
          );
          return {};
        }),
      readHistory,
      getReadOutboxMaxId,
      getSharedMediaCounts,
      getSharedMedia,
      searchMessages,
      resolveUsername,
      getDiscussion,
      getReplies,
      searchPeers,
      getPinnedMessages,
      setUnreadMark: (peer, unread) =>
        Effect.sync(() => {
          if (unread) unreadMarkedPeers.add(peer.id);
          else unreadMarkedPeers.delete(peer.id);
        }),
      setMuted,
      getUserDetails,
      updateContact,
      deleteContact,
      getGroupMembers,
      setBlocked,
      setPinnedDialog,
      setArchived,
      deleteDialog,
      setPinnedMessage,
      setTyping,
      stopLiveDraft: () => Effect.void,
      queryWidget: (_peer, _messageId, data) => Effect.succeed(`Pong: ${data}`),
      sendText,
      sendContact,
      sendPoll,
      updatePoll,
      sendFile,
      sendAlbum,
      downloadMedia,
      downloadAvatar,
      getThemes,
      getChatAppearance,
      getWallpapers,
      downloadWallpaper,
      getRecentStickers,
      searchStickers,
      getFavoriteStickers,
      setStickerFavorite,
      getStickerPacks,
      getStickerPack,
      searchStickerPacks,
      setStickerPackInstalled,
      getSavedGifs,
      searchGifs,
      downloadSticker,
      downloadCustomEmoji,
      getBotApp: (_bot, shortName) =>
        Effect.succeed({
          id: '9223372036854775806',
          accessHash: '9223372036854775805',
          title: `Fixture ${shortName}`,
          description: 'A test Mini App opened from a Telegram link.',
          requestWriteAccess: true,
        }),
      requestWebApp: (request) =>
        Effect.succeed({
          url: new URL('/e2e/mini-app.html', window.location.href).href,
          ...(request.mode === 'simple' ? {} : { queryId: '9223372036854775806' }),
          fullsize: false,
          fullscreen: false,
        }),
      prolongWebApp: () =>
        Effect.sync(() => {
          stats.prolongWebApp++;
        }),
      sendWebAppData: (_bot, _text, _data, _id) =>
        Effect.sync(() => {
          stats.sendWebAppData++;
        }),
      invokeWebAppMethod: (_bot, _method, params) => Effect.succeed(params),
      getBotCommands,
      startBot,
      answerBotCallback,
      requestUrlAuth,
      acceptUrlAuth,
      sendSticker,
      getReactionPeople,
      setReaction,
      getMessageReadReceipts,
      getPollVotes,
      getActiveSessions,
      getManagedParticipants: (peer, filter = 'members', query = '') =>
        Effect.sync(() => {
          const people = peerParticipants(peer).filter(
            (person) =>
              (filter === 'members'
                ? person.role !== 'removed'
                : filter === 'admins'
                  ? person.role === 'admin' || person.role === 'owner'
                  : person.role === filter) &&
              (!query || person.title.toLowerCase().includes(query.toLowerCase())),
          );
          return { people: structuredClone(people), count: people.length };
        }),
      addChatMember: (peer, user) =>
        Effect.sync(() => {
          if (hasScenario('create-partial')) return { missingUserIds: [user.id] };
          const people = peerParticipants(peer);
          if (!people.some((person) => person.peer.id === user.id))
            people.push({
              peer: user,
              title: user.id === 'u:101' ? 'Alice Fixture' : user.id,
              initials: 'AF',
              color: '#5288c1',
              hasAvatar: false,
              role: 'member',
              self: false,
              editable: true,
              rank: '',
              adminRights: {},
              restrictions: {},
              untilDate: 0,
            });
          return { missingUserIds: [] };
        }),
      editChatParticipant: (peer, user, change) =>
        Effect.sync(() => {
          const person = peerParticipants(peer).find((person) => person.peer.id === user.id);
          if (person && person.editable) {
            if (change.kind === 'admin') {
              person.adminRights = change.rights;
              person.rank = change.rank;
              person.role = Object.values(change.rights).some(Boolean) ? 'admin' : 'member';
            }
            if (change.kind === 'restrict') {
              person.restrictions = change.restrictions;
              person.untilDate = change.untilDate;
              person.role = Object.values(change.restrictions).some(Boolean)
                ? 'restricted'
                : 'member';
            }
            if (change.kind === 'remove') {
              if (peer.kind === 'group')
                participantLists.set(
                  peer.id,
                  peerParticipants(peer).filter((person) => person.peer.id !== user.id),
                );
              else person.role = 'removed';
            }
            if (change.kind === 'unban')
              participantLists.set(
                peer.id,
                peerParticipants(peer).filter((person) => person.peer.id !== user.id),
              );
          }
          return {};
        }),
      getAdminLog: (peer, request = {}) =>
        Effect.sync(() => {
          const people = peerParticipants(peer);
          const owner = people[0]!;
          const entries: AdminLogEntry[] = [
            {
              id: '9007199254741010',
              date: 1760000010,
              actor: owner,
              action: 'changed the name',
              details: [
                { label: 'Previous', text: 'Old team' },
                { label: 'New', text: 'New team' },
              ],
            },
            {
              id: '9007199254741009',
              date: 1760000009,
              actor: owner,
              action: 'deleted a message',
              details: [{ label: 'Message', text: 'Removed message text' }],
            },
          ];
          const events = entries.filter(
            (event) =>
              (!request.beforeId || BigInt(event.id) < BigInt(request.beforeId)) &&
              (!request.actor || request.actor.id === event.actor.peer.id) &&
              (!request.query ||
                JSON.stringify(event).toLowerCase().includes(request.query.toLowerCase())) &&
              (!request.filter ||
                request.filter === 'all' ||
                (request.filter === 'messages'
                  ? event.action.includes('message')
                  : request.filter === 'settings'
                    ? event.action.includes('name')
                    : false)),
          );
          return {
            events: events.slice(0, 1),
            nextId: events.length > 1 ? events[0]!.id : undefined,
          };
        }),
      upgradeChat: (peer) =>
        Effect.sync(() => {
          const existing = migratedGroups.get(peer.id);
          if (existing) return { peer: existing, title: peerManagement(existing).title };
          const target: TelegramPeer = {
            id: `c:${7000 + migratedGroups.size}`,
            kind: 'channel',
            accessHash: '1',
          };
          const settings = structuredClone(peerManagement(peer));
          settings.rights.viewLog = true;
          settings.migratedFrom = peer;
          peerManagement(peer).migratedTo = target;
          managementSettings.set(target.id, settings);
          migratedGroups.set(peer.id, target);
          participantLists.set(target.id, structuredClone(peerParticipants(peer)));
          createdDialogs.push({
            ...fixtureDialog(target, settings.title, '#5288c1'),
            broadcast: false,
          });
          messages.set(target.id, []);
          return { peer: target, title: settings.title };
        }),
      getSavedMessagesInfo: () =>
        Effect.sync(() => {
          ensureSaved();
          return { peer: savedSelf, premium: !hasScenario('saved-free') };
        }),
      getSavedDialogs: () =>
        Effect.sync(() => {
          ensureSaved();
          return {
            dialogs: [savedSelf, peers[0]!, peers[1]!]
              .map((peer) => ({
                peer,
                title:
                  peer.id === savedSelf.id
                    ? 'My Notes'
                    : peer.id === 'u:101'
                      ? 'Alice Fixture'
                      : 'Release Channel',
                initials: peer.id === savedSelf.id ? 'MN' : 'S',
                color: '#5288c1',
                hasAvatar: false,
                pinned: savedPins.has(peer.id),
                topMessage: messages
                  .get(savedSelf.id)!
                  .filter((message) => messageInSavedDialog(message, peer.id))
                  .at(-1),
              }))
              .sort((a, b) => Number(b.pinned) - Number(a.pinned)),
          };
        }),
      getSavedHistory: (peer, limit = 50, before) =>
        Effect.sync(() => {
          ensureSaved();
          const all = messages
            .get(savedSelf.id)!
            .filter(
              (message) =>
                messageInSavedDialog(message, peer.id) && (!before || message.id < before),
            );
          return { messages: all.slice(-limit), hasOlder: all.length > limit };
        }),
      pinSavedDialog: (peer, pinned) =>
        Effect.sync(() => {
          if (pinned) savedPins.add(peer.id);
          else savedPins.delete(peer.id);
        }),
      getSavedTags: (source) =>
        Effect.sync(() => {
          ensureSaved();
          const counts = new Map<string, number>();
          for (const message of messages.get(savedSelf.id)!)
            if (!source || messageInSavedDialog(message, source.id))
              for (const reaction of message.reactions ?? [])
                counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1);
          return {
            tags: [...counts].map(([reaction, count]) => ({
              reaction,
              title: savedTagNames.get(reaction) ?? '',
              count,
            })),
            recommended: ['⭐', '❤', '👍'].filter((reaction) => !counts.has(reaction)),
          };
        }),
      renameSavedTag: (reaction, title) =>
        hasScenario('saved-free')
          ? Effect.fail(createMtprotoError('rpc', 'PREMIUM_ACCOUNT_REQUIRED'))
          : Effect.sync(() => {
              savedTagNames.set(reaction, title);
            }),
      setSavedMessageTags: (id, reactions) =>
        hasScenario('saved-free')
          ? Effect.fail(createMtprotoError('rpc', 'PREMIUM_ACCOUNT_REQUIRED'))
          : Effect.sync(() => {
              ensureSaved();
              const mapped = reactions.map((emoji) => ({ emoji, chosen: true, count: 1 }));
              messages.set(
                savedSelf.id,
                messages
                  .get(savedSelf.id)!
                  .map((message) =>
                    message.id === id
                      ? { ...message, reactions: mapped, reactionsAsTags: true }
                      : message,
                  ),
              );
              return {};
            }),
      getChatManagement: (peer) => Effect.sync(() => structuredClone(peerManagement(peer))),
      setChatSetting: (peer, change) =>
        Effect.sync(() => {
          Object.assign(peerManagement(peer), { [change.kind]: change.value });
          return {};
        }),
      getChatInviteLinks: (peer, revoked = false) =>
        Effect.sync(() => {
          const links = peerInviteLinks(peer).filter((link) => link.revoked === revoked);
          return { links: structuredClone(links), count: links.length };
        }),
      exportChatInviteLink: (peer, draft) =>
        Effect.sync(() => {
          const link: ChatInviteLink = {
            ...draft,
            url: `https://t.me/+created_${inviteLinkId++}`,
            adminId: 'u:900000001',
            date: Math.floor(Date.now() / 1000),
            permanent: false,
            revoked: false,
            usage: 0,
            requested: 0,
            paid: false,
          };
          peerInviteLinks(peer).push(link);
          return structuredClone(link);
        }),
      editChatInviteLink: (peer, url, draft) =>
        Effect.sync(() => {
          const link = peerInviteLinks(peer).find((link) => link.url === url);
          if (link) Object.assign(link, draft);
        }),
      revokeChatInviteLink: (peer, url) =>
        Effect.sync(() => {
          const link = peerInviteLinks(peer).find((link) => link.url === url);
          if (link) {
            link.revoked = true;
            if (link.permanent)
              peerInviteLinks(peer).push({
                ...link,
                url: `https://t.me/+primary_${inviteLinkId++}`,
                revoked: false,
              });
          }
        }),
      deleteChatInviteLink: (peer, url) =>
        Effect.sync(() => {
          inviteLinkLists.set(
            peer.id,
            peerInviteLinks(peer).filter((link) => link.url !== url || !link.revoked),
          );
        }),
      getJoinRequests: (_peer, query = '') =>
        Effect.sync(() => {
          const people = joinRequestPeople.filter((person) =>
            person.title.toLowerCase().includes(query.toLowerCase()),
          );
          return { people: structuredClone(people), count: people.length };
        }),
      resolveJoinRequest: (_peer, user, _approved) =>
        Effect.sync(() => {
          joinRequestPeople = joinRequestPeople.filter((person) => person.peer.id !== user.id);
          return {};
        }),
      resolveAllJoinRequests: () =>
        Effect.sync(() => {
          joinRequestPeople = [];
          return {};
        }),
      checkChatInvite: (hash) =>
        hash === 'expired'
          ? Effect.fail(createMtprotoError('rpc', 'This invitation link has expired.'))
          : Effect.succeed({
              title: 'Invited community',
              about: 'A place to make plans together.',
              participantsCount: 42,
              broadcast: false,
              requestNeeded: hash === 'request',
              alreadyJoined: hash === 'already',
              paid: hash === 'paid',
              peer: hash === 'already' ? peers[2]! : undefined,
            }),
      joinChatInvite: (hash) =>
        Effect.sync(() => {
          if (hash === 'request') return { status: 'requested' as const };
          const peer: TelegramPeer = { id: 'g:6000', kind: 'group' };
          messages.set(peer.id, []);
          if (!createdDialogs.some((dialog) => dialog.peer.id === peer.id))
            createdDialogs.push(fixtureDialog(peer, 'Invited community', '#5288c1'));
          return { status: 'joined' as const, peer };
        }),
      createChat: (request) =>
        Effect.sync(() => {
          const id = 5000 + createdDialogs.length;
          const peer: TelegramPeer = {
            id: `${request.kind === 'group' ? 'g' : 'c'}:${id}`,
            kind: request.kind === 'group' ? 'group' : 'channel',
            accessHash: '1',
          };
          messages.set(peer.id, []);
          createdDialogs.push({
            ...fixtureDialog(peer, request.title, '#5288c1'),
            broadcast: request.kind === 'channel',
          });
          return {
            peer,
            missingUserIds:
              scenario === 'create-partial' ? request.users.map((user) => user.id) : [],
          };
        }),
      deleteForumTopic: (peer, topicId) =>
        Effect.sync(() => {
          const index = forumTopics.findIndex((topic) => topic.id === topicId);
          if (index >= 0) forumTopics.splice(index, 1);
          messages.set(
            peer.id,
            (messages.get(peer.id) ?? []).filter((message) => !messageInTopic(message, topicId)),
          );
          return { pts: cursor.pts, ptsCount: 0 };
        }),
      getForumTopic: (_peer, topicId) =>
        Effect.sync(() => structuredClone(forumTopics.find((topic) => topic.id === topicId))),
      getForumTopics: (peer, query = '') =>
        Effect.sync(() => {
          const selected = forumTopics
            .filter((topic) => topic.title.toLowerCase().includes(query.toLowerCase()))
            .map((topic) => ({
              ...topic,
              topMessageId:
                (messages.get(peer.id) ?? [])
                  .filter((message) => messageInTopic(message, topic.id))
                  .at(-1)?.id ?? 0,
            }));
          return {
            topics: structuredClone(selected),
            messages: selected.flatMap((topic) => {
              const message = messages
                .get(peer.id)
                ?.find((message) => message.id === topic.topMessageId);
              return message ? [message] : [];
            }),
            count: selected.length,
            canCreate: true,
            canManage: true,
          };
        }),
      createForumTopic: (_peer, title, iconColor) =>
        Effect.sync(() => {
          forumTopics.push({
            ...forumTopics[0]!,
            id:
              Math.max(
                ...(messages.get('c:202') ?? []).map((message) => message.id),
                ...forumTopics.map((topic) => topic.id),
              ) + 1,
            title,
            iconColor,
            unreadCount: 0,
            readInboxMaxId: 0,
            topMessageId: 0,
            closed: false,
            hidden: false,
            pinned: false,
          });
          return {};
        }),
      editForumTopic: (_peer, id, change) =>
        Effect.sync(() => {
          const topic = forumTopics.find((topic) => topic.id === id);
          if (topic) Object.assign(topic, change);
          return {};
        }),
      pinForumTopic: (_peer, id, pinned) =>
        Effect.sync(() => {
          const topic = forumTopics.find((topic) => topic.id === id);
          if (topic) topic.pinned = pinned;
          return {};
        }),
      readForumTopic: (_peer, id, maxId) =>
        Effect.sync(() => {
          const topic = forumTopics.find((topic) => topic.id === id);
          if (topic) {
            topic.unreadCount = 0;
            topic.readInboxMaxId = maxId;
          }
        }),
      getChatFolders: () => Effect.sync(() => structuredClone(chatFolders)),
      saveChatFolder: (folder) =>
        Effect.sync(() => {
          const at = chatFolders.findIndex((item) => item.id === folder.id);
          if (at < 0) chatFolders.push(structuredClone(folder));
          else chatFolders[at] = structuredClone(folder);
        }),
      deleteChatFolder: (id) =>
        Effect.sync(() => {
          chatFolders = chatFolders.filter((folder) => folder.id !== id);
        }),
      reorderChatFolders: (ids) =>
        Effect.sync(() => {
          chatFolders.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        }),
      getFolderUpdates: (id) =>
        Effect.sync(() => ({
          slug: '',
          folderId: id,
          title: 'New chats in folder',
          already: [],
          peers: chatFolders
            .find((folder) => folder.id === id)
            ?.included.some((peer) => peer.id === peers[1]!.id)
            ? []
            : [
                {
                  peer: peers[1]!,
                  category: 'channel' as const,
                  title: 'Release Channel',
                  initials: 'RC',
                  color: '#408acf',
                  bot: false,
                  isContact: false,
                  hasAvatar: false,
                },
              ],
        })),
      joinFolderUpdates: (id, selected) =>
        Effect.sync(() => {
          const folder = chatFolders.find((item) => item.id === id);
          if (folder)
            folder.included.push(
              ...selected.filter((peer) => !folder.included.some((item) => item.id === peer.id)),
            );
          return {};
        }),
      getFolderLinks: (id) => Effect.sync(() => structuredClone(folderLinks.get(id) ?? [])),
      exportFolderLink: (id, title, selected) =>
        Effect.sync(() => {
          const link = {
            title,
            url: `https://t.me/addlist/fixture-${id}-${(folderLinks.get(id)?.length ?? 0) + 1}`,
            peers: selected,
          };
          folderLinks.set(id, [...(folderLinks.get(id) ?? []), link]);
          chatFolders = chatFolders.map((folder) =>
            folder.id === id ? { ...folder, shared: true } : folder,
          );
          return link;
        }),
      deleteFolderLink: (id, slug) =>
        Effect.sync(() => {
          folderLinks.set(
            id,
            (folderLinks.get(id) ?? []).filter((link) => !link.url.endsWith(`/${slug}`)),
          );
        }),
      checkFolderInvite: (slug) =>
        Effect.sync(() => ({
          slug,
          title: 'Shared fixture folder',
          already: [],
          peers: [
            {
              peer: peers[2]!,
              category: 'group' as const,
              title: 'Fixture Group',
              initials: 'FG',
              color: '#408acf',
              bot: false,
              isContact: false,
              hasAvatar: false,
            },
          ],
        })),
      joinFolderInvite: (_slug, selected) =>
        Effect.sync(() => {
          chatFolders.push({
            id: Math.max(1, ...chatFolders.map((folder) => folder.id)) + 1,
            title: 'Shared',
            shared: true,
            included: selected,
            excluded: [],
            pinned: [],
            categories: [],
            exclusions: [],
          });
          return {};
        }),
      getPrivacy,
      setPrivacy,
      getReadTimePrivacy,
      setReadTimePrivacy,
      terminateSession,
      setSessionTtl,
      deleteMessages,
      editMessage,
      forwardMessage,
      forwardMessages,
      updates: Stream.fromPubSub(updateHub),
    } satisfies TelegramTransport;
  },
);
