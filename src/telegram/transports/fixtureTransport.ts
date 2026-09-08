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
  TelegramSearchOffset,
  TelegramSticker,
  TelegramTextFormat,
  TelegramUrlAuthAcceptOptions,
  TransportUpdateBatch,
  TransportUpdate,
} from '../types';
import { gzipSync, strToU8 } from 'fflate';
import { createMtprotoError, type MtprotoError } from '../mtproto/errors';

const cursor: SyncCursor = { pts: 10, qts: 0, date: 1_700_000_000, seq: 1 };
const peers: TelegramPeer[] = [
  { id: 'u:101', kind: 'user', accessHash: '1' },
  { id: 'c:202', kind: 'channel', accessHash: '2' },
  { id: 'g:303', kind: 'group', accessHash: '3' },
  { id: 'u:505', kind: 'user', accessHash: '5' },
];

const messages = new Map<string, TelegramMessage[]>([
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

function fixtureDialog(peer: TelegramPeer, title: string, color: string): TelegramDialog {
  const history = messages.get(peer.id) ?? [];
  const topMessage = history.at(-1);
  return {
    peer,
    ...(peer.kind === 'channel' ? { channelPts: cursor.pts } : {}),
    title,
    initials: title
      .split(' ')
      .map((word) => word[0])
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
      ...(peer.kind === 'user' ? {} : { memberCount: 2 }),
    },
    hasAvatar: true,
    avatarId: `fixture-${peer.id}`,
  };
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
            layers: [],
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
  function* () {
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
    const archivedPeers = new Set<string>();
    const deletedPeers = new Set<string>();
    const scenario = new URLSearchParams(window.location.search).get('scenario') ?? '';
    const scenarios = new Set(scenario.split('+').filter(Boolean));
    const hasScenario = (value: string) => scenarios.has(value);
    let authorized = scenario !== 'auth';
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
    function getDialogs() {
      return Effect.sync(() => {
        stats.getDialogs += 1;
        return {
          dialogs: [
            {
              ...fixtureDialog(peers[0]!, 'Alice Fixture', '#7c5cff'),
              ...(scenario === 'single-unread' ? { unreadCount: 1, readInboxMaxId: 79 } : {}),
            },
            fixtureDialog(peers[1]!, 'Release Channel', '#4ca184'),
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
              pinned: pinnedPeers.has(dialog.peer.id),
              archived: archivedPeers.has(dialog.peer.id),
            })),
        };
      });
    }
    const getHistory = Effect.fn('FixtureTransport.getHistory')(function* (
      peer: TelegramPeer,
      limit: number,
      beforeMessageId?: number,
    ) {
      stats.getHistory += 1;
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
          : (messages.get(peer.id) ?? []);
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
      const history = messages.get(peer.id) ?? [];
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
        const found = source.filter((message) =>
          kind === 'links'
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
                      : message.media?.kind === 'animation',
        );
        return messagePage(found, limit, offset, false);
      });
    }
    function searchMessages(
      query: string,
      peer?: TelegramPeer,
      limit = 50,
      offset?: TelegramSearchOffset,
    ) {
      return Effect.sync(() => {
        stats.searchMessages += 1;
        const term = query.toLocaleLowerCase();
        const sources = peer ? [messages.get(peer.id) ?? []] : [...messages.values()];
        const found = sources
          .flat()
          .filter((message) => message.text.toLocaleLowerCase().includes(term));
        return messagePage(found, limit, offset, !peer);
      });
    }
    const searchPeers = Effect.fn('FixtureTransport.searchPeers')(function* (
      query: string,
      limit = 50,
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
      return Effect.sync(() => {
        stats.getPinnedMessages += 1;
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
    function getGroupMembers(peer: TelegramPeer, limit = 50, offset = 0) {
      return Effect.sync(() => {
        if (peer.kind === 'user') return { members: [], totalCount: 0, hasMore: false };
        const allMembers = [
          {
            peer: { id: 'u:404', kind: 'user' as const },
            title: 'Fixture Author',
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
        const members = allMembers.slice(offset, offset + limit);
        const nextOffset = offset + members.length;
        return {
          members,
          totalCount: allMembers.length,
          hasMore: nextOffset < allMembers.length,
          ...(nextOffset < allMembers.length ? { nextOffset } : {}),
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
        replyToId: reply?.messageId,
        replyQuote: reply?.quoteText,
        formats: formats?.filter(({ kind }) => kind !== 'textUrl'),
        links: formats
          ?.filter(({ kind }) => kind === 'textUrl')
          .map(({ offset, length, url }) => ({ offset, length, url })),
      };
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
      const sent = attachments.map(({ file, randomId, sendAs }, index): TelegramMessage => ({
        id: firstId + index,
        peerId: peer.id,
        senderId: 'self',
        text: index === 0 ? options.caption : '',
        date: Math.floor(Date.now() / 1000),
        outgoing: true,
        randomId,
        groupedId,
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
      if (scenario === 'held-media-download' && message.media?.name === 'held-image.png') {
        if (options?.progress) yield* Effect.sync(() => options.progress!(0.25));
        return yield* Effect.never;
      }
      const media = message.media ?? message.linkPreview?.media;
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
    function getRecentStickers() {
      return Effect.sync(() => {
        stats.getRecentStickers += 1;
        return fixtureStickers();
      });
    }
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
          { id: 'pack-a', title: 'Fixture Animals', stickers: recent.slice(0, 2) },
          { id: 'pack-b', title: 'Fixture Animated', stickers: recent.slice(2) },
        ];
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
      return { message: 'Fixture callback complete.', alert: false };
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
    ) {
      stats.forwardMessage += 1;
      const source = messages.get(fromPeer.id)?.find(({ id }) => id === messageId);
      if (!source)
        return yield* Effect.fail(createMtprotoError('transport', 'Fixture message was not found'));
      const message = {
        ...source,
        id: (messages.get(toPeer.id)?.at(-1)?.id ?? 0) + 1,
        peerId: toPeer.id,
        senderId: 'self',
        outgoing: true,
        date: Math.floor(Date.now() / 1000),
        randomId,
      };
      messages.set(toPeer.id, [...(messages.get(toPeer.id) ?? []), message]);
      return { message };
    });
    window.__televechaFixture = {
      stats,
      emit: (update) => {
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
      submitCode,
      submitPassword,
      getCurrentState,
      getDifference,
      getChannelDifference,
      getDialogs,
      getHistory,
      getHistoryAround,
      readHistory,
      getReadOutboxMaxId,
      getSharedMediaCounts,
      getSharedMedia,
      searchMessages,
      searchPeers,
      getPinnedMessages,
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
      sendText,
      sendFile,
      sendAlbum,
      downloadMedia,
      downloadAvatar,
      getThemes,
      getChatAppearance,
      getWallpapers,
      downloadWallpaper,
      getRecentStickers,
      getStickerPacks,
      getSavedGifs,
      searchGifs,
      downloadSticker,
      downloadCustomEmoji,
      getBotCommands,
      startBot,
      answerBotCallback,
      requestUrlAuth,
      acceptUrlAuth,
      sendSticker,
      setReaction,
      deleteMessages,
      editMessage,
      forwardMessage,
      updates: Stream.fromPubSub(updateHub),
    } satisfies TelegramTransport;
  },
);
