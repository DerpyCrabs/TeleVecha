import type {
  ChannelDifferenceResult,
  DifferenceResult,
  EditMediaOptions,
  OutgoingAttachmentMode,
  SendAlbumAttachment,
  SendAlbumOptions,
  SendFileOptions,
  SendTextResult,
  SharedMediaKind,
  SyncCursor,
  TelegramCredentials,
  TelegramActivityKind,
  TelegramDialog,
  TelegramMedia,
  TelegramMessage,
  TelegramPeer,
  TelegramPeerSearchResult,
  TelegramReplyTarget,
  TelegramSearchOffset,
  TelegramSearchPage,
  TelegramSticker,
  TelegramStickerPack,
  TelegramTextFormat,
  TelegramTransport,
  TelegramUrlAuthAcceptOptions,
  TransportUpdateBatch,
  TransportUpdate,
} from '../types';
import { gzipSync, strToU8 } from 'fflate';

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
                        {
                          header: true,
                          text: { kind: 'text' as const, text: 'Feature' },
                        },
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
  sendFile: number;
  sendAlbum: number;
  readHistory: number;
  getReadOutboxMaxId: number;
  downloadMedia: number;
  downloadAvatar: number;
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
      releaseHistoryAround(): void;
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
    readInboxMaxId: 0,
    readOutboxMaxId: 0,
    muted: false,
    pinned: false,
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

export class FixtureTelegramTransport implements TelegramTransport {
  private readonly listeners = new Set<(batch: TransportUpdateBatch) => void>();
  private readonly blockedPeers = new Set<string>();
  private readonly pinnedPeers = new Set<string>();
  private readonly archivedPeers = new Set<string>();
  private readonly deletedPeers = new Set<string>();
  private readonly scenario = new URLSearchParams(window.location.search).get('scenario') ?? '';
  private authorized = this.scenario !== 'auth';
  private releasePendingConnect: (() => void) | undefined;
  private releasePendingSend: (() => void) | undefined;
  private releasePendingUpload: (() => void) | undefined;
  private releasePendingHistoryAround: (() => void) | undefined;
  private fixtureMediaFailures = 0;
  private fixturePts = cursor.pts;
  private readonly stats: FixtureStats = {
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
    getReadOutboxMaxId: 0,
    downloadMedia: 0,
    downloadAvatar: 0,
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

  constructor() {
    window.__televechaFixture = {
      stats: this.stats,
      emit: (update) => {
        for (const listener of this.listeners) listener({ updates: [update] });
      },
      releaseConnect: () => this.releasePendingConnect?.(),
      releaseSend: () => this.releasePendingSend?.(),
      releaseUpload: () => this.releasePendingUpload?.(),
      releaseHistoryAround: () => this.releasePendingHistoryAround?.(),
    };
  }

  async connect(_credentials: TelegramCredentials) {
    this.stats.connect += 1;
    if (this.scenario === 'connect-fails-once' && this.stats.connect === 1) {
      throw new Error('Fixture connection failure');
    }
    if (this.scenario === 'held-connect') {
      await new Promise<void>((resolve) => {
        this.releasePendingConnect = resolve;
      });
      this.releasePendingConnect = undefined;
    }
  }
  async disconnect() {}
  async logOut() {
    this.authorized = false;
  }
  async isAuthorized() {
    return this.authorized;
  }
  async getAuthorizedAccountId() {
    this.stats.getAuthorizedAccountId += 1;
    return '900000001';
  }
  async requestCode(phoneNumber: string) {
    this.stats.requestCode += 1;
    if (phoneNumber.includes('000')) throw new Error('Fixture rejected phone number');
    return { isCodeViaApp: true };
  }
  async submitCode(code: string): Promise<'authorized' | 'password-required' | 'sign-up-required'> {
    this.stats.submitCode += 1;
    if (code === '00000') throw new Error('Fixture rejected login code');
    if (code === '99999') return 'sign-up-required';
    if (code === '22222') return 'password-required';
    this.authorized = true;
    return 'authorized';
  }
  async submitPassword(password: string) {
    this.stats.submitPassword += 1;
    if (password === 'wrong') throw new Error('Fixture rejected password');
    this.authorized = true;
  }
  async getCurrentState() {
    return cursor;
  }
  async getDifference(): Promise<DifferenceResult> {
    return { type: 'complete', cursor, updates: [] };
  }
  async getChannelDifference(
    _peer: TelegramPeer,
    pts: number,
    _totalLimit: number,
  ): Promise<ChannelDifferenceResult> {
    this.stats.getChannelDifference += 1;
    return { type: 'complete', pts, updates: [] };
  }
  async getDialogs() {
    this.stats.getDialogs += 1;
    return {
      dialogs: [
        fixtureDialog(peers[0]!, 'Alice Fixture', '#7c5cff'),
        fixtureDialog(peers[1]!, 'Release Channel', '#4ca184'),
        fixtureDialog(peers[2]!, 'Fixture Group', '#b26b3f'),
        ...(['long-history', 'delayed-history-media'].includes(this.scenario)
          ? [fixtureDialog(peers[3]!, 'Long History', '#4b7bec')]
          : []),
      ]
        .filter((dialog) => !this.deletedPeers.has(dialog.peer.id))
        .map((dialog) => ({
          ...dialog,
          pinned: this.pinnedPeers.has(dialog.peer.id),
          archived: this.archivedPeers.has(dialog.peer.id),
        })),
    };
  }
  async getHistory(peer: TelegramPeer, limit: number, beforeMessageId?: number) {
    this.stats.getHistory += 1;
    const history = messages.get(peer.id) ?? [];
    const eligible = beforeMessageId ? history.filter(({ id }) => id < beforeMessageId) : history;
    const page = eligible.slice(-limit);
    const renderedPage =
      (this.scenario === 'delayed-media' && peer.id === peers[0]!.id) ||
      (this.scenario === 'delayed-history-media' && peer.id === peers[3]!.id)
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
      hasOlder: ['long-history', 'delayed-history-media'].includes(this.scenario)
        ? page.length > 0
        : eligible.length > page.length,
      nextBeforeMessageId: page[0]?.id ?? beforeMessageId,
    };
  }
  async getHistoryAround(peer: TelegramPeer, messageId: number, limit: number) {
    this.stats.getHistoryAround += 1;
    if (this.scenario === 'held-history-around') {
      await new Promise<void>((resolve) => {
        this.releasePendingHistoryAround = resolve;
      });
      this.releasePendingHistoryAround = undefined;
    }
    const history = messages.get(peer.id) ?? [];
    const target = Math.max(
      0,
      history.findIndex(({ id }) => id === messageId),
    );
    const start = Math.max(0, target - Math.floor(limit / 2));
    return history.slice(start, start + limit);
  }
  async readHistory() {
    this.stats.readHistory += 1;
    return {};
  }
  async getReadOutboxMaxId() {
    this.stats.getReadOutboxMaxId += 1;
    return this.scenario === 'missed-read-receipt' ? 80 : 0;
  }
  async getSharedMediaCounts(peer: TelegramPeer) {
    this.stats.getSharedMediaCounts += 1;
    return peer.id === peers[0]!.id
      ? { media: 128, files: 16, links: 44 }
      : { media: 7, files: 3, links: 12 };
  }
  async getSharedMedia(
    peer: TelegramPeer,
    kind: SharedMediaKind,
    limit: number,
    offset?: TelegramSearchOffset,
  ): Promise<TelegramSearchPage> {
    this.stats.getSharedMedia += 1;
    const found = (messages.get(peer.id) ?? []).filter((message) =>
      kind === 'links'
        ? Boolean(message.links?.length || /https?:\/\//u.test(message.text))
        : kind === 'files'
          ? message.media?.kind === 'file'
          : Boolean(message.media && message.media.kind !== 'file'),
    );
    return this.messagePage(found, limit, offset, false);
  }
  async searchMessages(
    query: string,
    peer?: TelegramPeer,
    limit = 50,
    offset?: TelegramSearchOffset,
  ) {
    this.stats.searchMessages += 1;
    const term = query.toLocaleLowerCase();
    const sources = peer ? [messages.get(peer.id) ?? []] : [...messages.values()];
    const found = sources
      .flat()
      .filter((message) => message.text.toLocaleLowerCase().includes(term));
    return this.messagePage(found, limit, offset, !peer);
  }

  async searchPeers(query: string, limit = 50): Promise<TelegramPeerSearchResult[]> {
    this.stats.searchPeers += 1;
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
  }

  private messagePage(
    candidates: TelegramMessage[],
    limit: number,
    offset: TelegramSearchOffset | undefined,
    global: boolean,
  ): TelegramSearchPage {
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
  async getPinnedMessages(peer: TelegramPeer) {
    this.stats.getPinnedMessages += 1;
    if (this.scenario === 'multiple-pins' && peer.id === peers[0]?.id) {
      const history = messages.get(peer.id) ?? [];
      return [79, 5]
        .map((id) => history.find((message) => message.id === id))
        .filter((message): message is TelegramMessage => Boolean(message))
        .map((message) => ({ ...message, pinned: true }));
    }
    return (messages.get(peer.id) ?? []).filter(({ pinned }) => pinned);
  }
  async setMuted(peer: TelegramPeer, muted: boolean) {
    this.stats.setMuted += 1;
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
  }
  async getUserDetails(peer: TelegramPeer) {
    this.stats.getUserDetails += 1;
    return {
      firstName: 'Alice',
      lastName: 'Fixture',
      phone: '+1 555 010 2048',
      username: 'alice_fixture',
      bio: 'Fixture profile used by end-to-end tests.\nalice@example.com https://example.com @telegram',
      birthday: { day: 14, month: 3, year: 1994 },
      isContact: true,
      blocked: this.blockedPeers.has(peer.id),
    };
  }
  async updateContact(_peer: TelegramPeer, _firstName: string, _lastName: string, _phone: string) {
    this.stats.updateContact += 1;
  }
  async deleteContact(_peer: TelegramPeer) {
    this.stats.deleteContact += 1;
  }
  async getGroupMembers(peer: TelegramPeer) {
    if (peer.kind === 'user') return [];
    return [
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
  }
  async setBlocked(peer: TelegramPeer, blocked: boolean) {
    this.stats.setBlocked += 1;
    if (blocked) this.blockedPeers.add(peer.id);
    else this.blockedPeers.delete(peer.id);
  }
  async setPinnedDialog(peer: TelegramPeer, pinned: boolean) {
    this.stats.setPinnedDialog += 1;
    if (pinned) this.pinnedPeers.add(peer.id);
    else this.pinnedPeers.delete(peer.id);
  }
  async setArchived(peer: TelegramPeer, archived: boolean) {
    this.stats.setArchived += 1;
    if (archived) this.archivedPeers.add(peer.id);
    else this.archivedPeers.delete(peer.id);
    return {};
  }
  async deleteDialog(peer: TelegramPeer) {
    this.stats.deleteDialog += 1;
    this.deletedPeers.add(peer.id);
    return {};
  }
  async setPinnedMessage(peer: TelegramPeer, messageId: number, pinned: boolean) {
    this.stats.setPinnedMessage += 1;
    const message = messages.get(peer.id)?.find(({ id }) => id === messageId);
    if (message) message.pinned = pinned;
    return {};
  }
  async setTyping(_peer: TelegramPeer, _kind?: TelegramActivityKind) {
    this.stats.setTyping += 1;
  }
  async sendText(
    peer: TelegramPeer,
    text: string,
    randomId: string,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ) {
    this.stats.sendText += 1;
    if (text === 'FAIL') throw new Error('Fixture send failure');
    if (this.scenario === 'held-send') {
      await new Promise<void>((resolve) => {
        this.releasePendingSend = resolve;
      });
      this.releasePendingSend = undefined;
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
  }
  async sendFile(
    peer: TelegramPeer,
    file: File,
    options: SendFileOptions,
  ): Promise<SendTextResult> {
    this.stats.sendFile += 1;
    options.onProgress?.(0.25);
    if (this.scenario === 'held-upload') {
      await new Promise<void>((resolve) => {
        this.releasePendingUpload = resolve;
      });
      this.releasePendingUpload = undefined;
    }
    options.onProgress?.(1);
    const result = await this.sendText(
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
          kind: options.asSticker ? 'sticker' : this.fixtureMediaKind(file, options.sendAs),
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
        },
      },
    };
  }
  async sendAlbum(
    peer: TelegramPeer,
    attachments: SendAlbumAttachment[],
    options: SendAlbumOptions,
  ) {
    this.stats.sendAlbum += 1;
    if (attachments.length < 2 || attachments.length > 10) {
      throw new Error('Fixture albums must contain between 2 and 10 attachments');
    }
    options.onProgress?.(0.25);
    if (this.scenario === 'held-upload') {
      await new Promise<void>((resolve) => {
        this.releasePendingUpload = resolve;
      });
      this.releasePendingUpload = undefined;
    }
    options.onProgress?.(1);
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
      formats: index === 0 ? options.formats?.filter(({ kind }) => kind !== 'textUrl') : undefined,
      links:
        index === 0
          ? options.formats
              ?.filter(({ kind }) => kind === 'textUrl')
              .map(({ offset, length, url }) => ({ offset, length, url }))
          : undefined,
      media: {
        kind: this.fixtureMediaKind(file, sendAs),
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
      },
    }));
    messages.set(peer.id, [...history, ...sent]);
    return { messages: sent };
  }
  async downloadMedia(message: TelegramMessage) {
    this.stats.downloadMedia += 1;
    if (
      this.scenario === 'media-download-retry' &&
      message.media?.name === 'fixture.jpg' &&
      this.fixtureMediaFailures < 2
    ) {
      this.fixtureMediaFailures += 1;
      throw new Error('Fixture media download failed');
    }
    if (['delayed-layout.tgs', 'delayed-history-layout.tgs'].includes(message.media?.name ?? '')) {
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    }
    if (message.media?.mimeType === 'application/x-tgsticker') return fixtureTgsBlob();
    const width = message.media?.width ?? 320;
    const height = message.media?.height ?? 180;
    return new Blob(
      [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#6650d8"/></svg>`,
      ],
      { type: 'image/svg+xml' },
    );
  }
  async downloadAvatar(peer: TelegramPeer) {
    this.stats.downloadAvatar += 1;
    const label = peer.id === peers[0]!.id ? 'A' : 'R';
    return new Blob(
      [
        `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#6650d8"/><text x="48" y="61" text-anchor="middle" font-size="42" fill="white">${label}</text></svg>`,
      ],
      { type: 'image/svg+xml' },
    );
  }
  async getRecentStickers(): Promise<TelegramSticker[]> {
    this.stats.getRecentStickers += 1;
    return this.fixtureStickers();
  }
  async getStickerPacks(): Promise<TelegramStickerPack[]> {
    this.stats.getStickerPacks += 1;
    const recent = this.fixtureStickers();
    if (this.scenario === 'large-sticker-pack') {
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
  }
  async getSavedGifs(): Promise<TelegramSticker[]> {
    this.stats.getSavedGifs += 1;
    return [
      {
        id: 'gif-1',
        accessHash: '4',
        fileReference: new Uint8Array([4]),
        emoji: 'GIF',
        mimeType: 'image/gif',
      },
    ];
  }
  async searchGifs(_peer: TelegramPeer, query: string): Promise<TelegramSticker[]> {
    this.stats.searchGifs += 1;
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
  }
  private fixtureStickers(): TelegramSticker[] {
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
  async downloadSticker(sticker: TelegramSticker) {
    this.stats.downloadSticker += 1;
    if (sticker.mimeType === 'application/x-tgsticker') {
      return fixtureTgsBlob();
    }
    if (this.scenario === 'large-sticker-pack' && sticker.id.startsWith('sticker-large-')) {
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
  }
  async downloadCustomEmoji() {
    return new Blob(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#6da9f7"/></svg>',
      ],
      { type: 'image/svg+xml' },
    );
  }
  async getBotCommands(peer: TelegramPeer) {
    this.stats.getBotCommands += 1;
    const botId = peer.kind === 'user' ? peer.id : 'u:606';
    const bot = {
      botId,
      botUsername: 'fixture_helper_bot',
      botName: 'Fixture Helper Bot',
    };
    return [
      { command: 'help', description: 'Show available commands', ...bot },
      { command: 'status', description: 'Show fixture status', ...bot },
    ];
  }
  async startBot(peer: TelegramPeer, startParam: string, randomId: string) {
    this.stats.startBot += 1;
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
            {
              kind: 'url-auth',
              text: 'Sign in',
              url: 'https://example.com/auth',
              buttonId: 4,
            },
            { kind: 'copy', text: 'Copy code', copyText: 'fixture-code' },
          ],
        ],
      },
    };
    messages.set(peer.id, [...current, outgoing, replyMessage, inlineMessage]);
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener({
          updates: [
            {
              type: 'new-message',
              pts: ++this.fixturePts,
              ptsCount: 1,
              message: replyMessage,
            },
          ],
        });
        listener({
          updates: [
            {
              type: 'new-message',
              pts: ++this.fixturePts,
              ptsCount: 1,
              message: inlineMessage,
            },
          ],
        });
      }
    });
    return { message: outgoing };
  }
  async answerBotCallback(_peer: TelegramPeer, _messageId: number, _data: number[]) {
    this.stats.answerBotCallback += 1;
    return { message: 'Fixture callback complete.', alert: false };
  }
  async requestUrlAuth() {
    return {
      kind: 'request' as const,
      botTitle: 'Fixture Helper Bot',
      domain: 'example.com',
      requestWriteAccess: true,
      requestPhoneNumber: false,
      matchCodesFirst: false,
      isApp: false,
    };
  }
  async acceptUrlAuth(
    _peer: TelegramPeer,
    _messageId: number,
    _buttonId: number,
    _options?: TelegramUrlAuthAcceptOptions,
  ) {
    return { kind: 'accepted' as const, url: 'https://example.com/authenticated' };
  }
  async sendSticker(
    peer: TelegramPeer,
    sticker: TelegramSticker,
    randomId: string,
    reply?: TelegramReplyTarget,
  ) {
    this.stats.sendSticker += 1;
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
  }
  async setReaction(peer: TelegramPeer, messageId: number, emoji?: string) {
    this.stats.setReaction += 1;
    const message = messages.get(peer.id)?.find(({ id }) => id === messageId);
    if (message) {
      message.reactions = emoji
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
    }
    return {};
  }
  async deleteMessages(peer: TelegramPeer, messageIds: number[], _revoke: boolean) {
    this.stats.deleteMessages += 1;
    const deleted = new Set(messageIds);
    messages.set(
      peer.id,
      (messages.get(peer.id) ?? []).filter((message) => !deleted.has(message.id)),
    );
    return {};
  }
  async editMessage(
    peer: TelegramPeer,
    messageId: number,
    text: string,
    formats?: TelegramTextFormat[],
    replacement?: EditMediaOptions,
  ) {
    this.stats.editMessage += 1;
    const message = messages.get(peer.id)?.find(({ id }) => id === messageId);
    if (!message) throw new Error('Fixture message was not found');
    message.text = text;
    message.formats = formats?.filter(({ kind }) => kind !== 'textUrl');
    message.links = formats
      ?.filter(({ kind }) => kind === 'textUrl')
      .map(({ offset, length, url }) => ({ offset, length, url }));
    if (replacement) {
      message.media = {
        kind: this.fixtureMediaKind(replacement.file, replacement.sendAs),
        name: replacement.file.name,
        mimeType: replacement.file.type || 'application/octet-stream',
        size: replacement.file.size,
      };
    }
    message.editedAt = Math.floor(Date.now() / 1000);
    return { message: { ...message } };
  }

  private fixtureMediaKind(file: File, sendAs: OutgoingAttachmentMode): TelegramMedia['kind'] {
    if (sendAs === 'file') return 'file';
    if (file.type === 'image/gif') return 'animation';
    if (file.type.startsWith('image/')) return 'photo';
    if (file.type.startsWith('video/')) return 'video';
    return 'file';
  }
  async forwardMessage(
    fromPeer: TelegramPeer,
    toPeer: TelegramPeer,
    messageId: number,
    randomId: string,
  ) {
    this.stats.forwardMessage += 1;
    const source = messages.get(fromPeer.id)?.find(({ id }) => id === messageId);
    if (!source) throw new Error('Fixture message was not found');
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
  }
  subscribe(listener: (batch: TransportUpdateBatch) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
