import { describe, expect, it, vi } from 'vitest';

import { MessagingEngine } from './engine';
import type { CacheStore, DraftReservation, LatestStateCache } from '../persistence/store';
import type {
  CachedDialog,
  CachedMessage,
  ChannelDifferenceResult,
  DialogPage,
  DifferenceResult,
  EditMessageResult,
  EditMediaOptions,
  HistoryPage,
  PendingSend,
  SendAlbumResult,
  SendAlbumAttachment,
  SendAlbumOptions,
  SendFileOptions,
  SendTextResult,
  SharedMediaCounts,
  SyncCursor,
  TelegramCredentials,
  TelegramDialog,
  TelegramGroupMember,
  TelegramMessage,
  TelegramPeer,
  TelegramPeerSearchResult,
  TelegramReplyTarget,
  TelegramSticker,
  TelegramTextFormat,
  TelegramTransport,
  TransportUpdate,
  TransportUpdateBatch,
  TransportMutationResult,
} from '../types';

const sharedCounts = (value: number): SharedMediaCounts => ({
  photos: value,
  videos: value,
  files: value,
  audio: value,
  links: value,
  voice: value,
  gifs: value,
});

const peer: TelegramPeer = { id: 'peer-1', kind: 'user' };
const dialog: TelegramDialog = {
  peer,
  title: 'Mira',
  initials: 'M',
  color: '#765cff',
  topMessageId: 7,
  topMessage: {
    id: 7,
    peerId: peer.id,
    senderId: peer.id,
    text: 'Current message',
    date: 100,
    outgoing: false,
  },
  unreadCount: 1,
  readInboxMaxId: 0,
  readOutboxMaxId: 0,
  muted: false,
  pinned: false,
  hasAvatar: true,
};
const currentCursor: SyncCursor = { pts: 20, qts: 0, date: 100, seq: 3 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function pendingSend(text: string, createdAt: number): PendingSend {
  return {
    id: crypto.randomUUID(),
    accountId: 'account-1',
    peer,
    text,
    randomId: crypto.randomUUID(),
    createdAt,
    attempts: 0,
  };
}

class MemoryStore implements CacheStore {
  transportSession: unknown;
  accountId: string | undefined;
  cursor: SyncCursor | undefined;
  epoch = 0;
  dialogs: CachedDialog[] = [];
  messages: CachedMessage[] = [];
  drafts: Record<string, string> = {};
  draftRevisions: Record<string, number> = {};
  outbox: PendingSend[] = [];
  blobs = new Map<string, Blob>();
  pinnedMessages = new Map<string, { value: TelegramMessage[]; savedAt: number }>();
  groupMembers = new Map<string, { value: TelegramGroupMember[]; savedAt: number }>();
  lastPeerId: string | undefined;
  preparedOutboxBytes: number[] = [];

  async loadTransportSession() {
    return this.transportSession;
  }
  async loadWorkspace() {
    return {
      accountId: this.accountId,
      dialogs: this.dialogs,
      drafts: this.drafts,
      draftRevisions: this.draftRevisions,
      pending: this.outbox,
      epoch: this.epoch,
      lastPeerId: this.lastPeerId,
    };
  }
  async saveTransportSession(session: unknown) {
    this.transportSession = session;
  }
  async clearAccountData() {
    this.transportSession = undefined;
    this.accountId = undefined;
    this.cursor = undefined;
    this.epoch = 0;
    this.dialogs = [];
    this.messages = [];
    this.drafts = {};
    this.draftRevisions = {};
    this.outbox = [];
    this.blobs.clear();
    this.pinnedMessages.clear();
    this.groupMembers.clear();
    this.lastPeerId = undefined;
  }
  async clearCacheData() {
    this.cursor = undefined;
    this.epoch = 0;
    this.dialogs = [];
    this.messages = [];
    this.blobs.clear();
    this.pinnedMessages.clear();
    this.groupMembers.clear();
    this.lastPeerId = undefined;
  }
  async prepareOutboxWrite(bytes: number, _forceEviction?: boolean) {
    this.preparedOutboxBytes.push(bytes);
  }
  async loadAccountId() {
    return this.accountId;
  }
  async claimAccount(accountId: string) {
    this.accountId = accountId;
    this.outbox = this.outbox.map((send) => (send.accountId ? send : { ...send, accountId }));
  }
  async resetForAccount(accountId: string) {
    const previousAccountId = this.accountId;
    this.accountId = accountId;
    this.cursor = undefined;
    this.epoch = 0;
    this.dialogs = [];
    this.messages = [];
    this.drafts = {};
    this.draftRevisions = {};
    this.blobs.clear();
    this.pinnedMessages.clear();
    this.groupMembers.clear();
    this.lastPeerId = undefined;
    this.outbox = this.outbox.map((send) =>
      send.accountId
        ? send
        : {
            ...send,
            accountId: previousAccountId ?? 'legacy-unowned',
            lastError: 'Queued for a different Telegram account.',
          },
    );
  }

  async loadCursor() {
    return this.cursor;
  }
  async saveCursor(cursor: SyncCursor) {
    this.cursor = cursor;
  }
  async loadEpoch() {
    return this.epoch;
  }
  async beginNewEpoch() {
    this.epoch += 1;
    return this.epoch;
  }
  async commitLatestState(state: LatestStateCache) {
    this.epoch += 1;
    this.cursor = state.cursor;
    this.dialogs = state.dialogs.map((next) => ({ ...next, cacheEpoch: this.epoch }));
    this.messages =
      state.activeHistory?.messages.map((message) => ({
        ...message,
        cacheEpoch: this.epoch,
      })) ?? [];
    for (const key of state.discardBlobKeys ?? []) this.blobs.delete(key);
    return this.epoch;
  }
  async loadDialogs() {
    return this.dialogs;
  }
  async replaceDialogs(dialogs: CachedDialog[]) {
    this.dialogs = dialogs;
  }
  async putDialog(next: CachedDialog) {
    this.dialogs = [...this.dialogs.filter(({ peer }) => peer.id !== next.peer.id), next];
  }
  async loadMessages(peerId: string, limit = 500) {
    return this.messages.filter((message) => message.peerId === peerId).slice(-limit);
  }
  async loadMessage(peerId: string, messageId: number) {
    return this.messages.find((message) => message.peerId === peerId && message.id === messageId);
  }
  async replaceMessages(peerId: string, messages: CachedMessage[]) {
    this.messages = [...this.messages.filter((message) => message.peerId !== peerId), ...messages];
  }
  async putMessages(messages: CachedMessage[]) {
    for (const message of messages) await this.putMessage(message);
  }
  async putMessage(message: CachedMessage) {
    this.messages = [
      ...this.messages.filter(
        (current) => !(current.peerId === message.peerId && current.id === message.id),
      ),
      message,
    ];
  }
  async deleteMessages(peerId: string | undefined, messageIds: number[]) {
    this.messages = this.messages.filter(
      (message) =>
        (peerId !== undefined && message.peerId !== peerId) || !messageIds.includes(message.id),
    );
  }
  async loadPinnedMessages(peerId: string) {
    return this.pinnedMessages.get(peerId);
  }
  async savePinnedMessages(peerId: string, messages: TelegramMessage[]) {
    this.pinnedMessages.set(peerId, { value: messages, savedAt: Date.now() });
  }
  async deletePinnedMessages(peerId: string) {
    this.pinnedMessages.delete(peerId);
  }
  async loadGroupMembers(peerId: string) {
    return this.groupMembers.get(peerId);
  }
  async saveGroupMembers(peerId: string, members: TelegramGroupMember[]) {
    this.groupMembers.set(peerId, { value: members, savedAt: Date.now() });
  }
  async deleteGroupMembers(peerId: string) {
    this.groupMembers.delete(peerId);
  }
  async loadDrafts() {
    return this.drafts;
  }
  async loadDraftRevisions() {
    return this.draftRevisions;
  }
  async saveDraft(peerId: string, text: string, revision = 0) {
    if (text) {
      this.drafts[peerId] = text;
      this.draftRevisions[peerId] = revision;
    } else {
      delete this.drafts[peerId];
      delete this.draftRevisions[peerId];
    }
  }
  async loadOutbox() {
    return this.outbox;
  }
  async commitOutbox(sends: PendingSend | PendingSend[], draft?: DraftReservation) {
    const pending = Array.isArray(sends) ? sends : [sends];
    const ids = new Set(pending.map(({ id }) => id));
    this.outbox = [...this.outbox.filter(({ id }) => !ids.has(id)), ...pending];
    if (
      draft &&
      this.drafts[draft.peerId] === draft.text &&
      (this.draftRevisions[draft.peerId] ?? 0) === (draft.revision ?? 0)
    ) {
      delete this.drafts[draft.peerId];
      delete this.draftRevisions[draft.peerId];
    }
  }
  async deletePending(id: string) {
    this.outbox = this.outbox.filter((send) => send.id !== id);
  }
  async loadBlob(key: string) {
    return this.blobs.get(key);
  }
  async saveBlob(key: string, blob: Blob) {
    this.blobs.set(key, blob);
  }
  async deleteBlob(key: string) {
    this.blobs.delete(key);
  }
  async loadLastPeerId() {
    return this.lastPeerId;
  }
  async saveLastPeerId(peerId: string) {
    this.lastPeerId = peerId;
  }
}

class FakeTransport implements TelegramTransport {
  accountId = 'account-1';
  difference: DifferenceResult = { type: 'complete', cursor: currentCursor, updates: [] };
  authorized = true;
  failSend = false;
  differenceCalls = 0;
  differenceLimits: number[] = [];
  dialogLimits: number[] = [];
  sentRandomIds: string[] = [];
  sentAlbumRandomIds: string[][] = [];
  sentFileModes: Array<SendFileOptions['sendAs']> = [];
  forwardRandomIds: string[] = [];
  sentFormats: Array<TelegramTextFormat[] | undefined> = [];
  editedFormats: Array<TelegramTextFormat[] | undefined> = [];
  readCalls: Array<{ peer: TelegramPeer; maxMessageId: number }> = [];
  history = new Map<number, HistoryPage>();
  historyCalls: Array<number | undefined> = [];
  holdFileSend: Promise<void> | undefined;
  holdAlbumSend: Promise<void> | undefined;
  disconnectCalls = 0;
  downloadMediaCalls = 0;
  downloadAvatarCalls = 0;
  downloadCustomEmojiCalls = 0;
  downloadWallpaperCalls = 0;
  chatAppearanceCalls = 0;
  botCommandCalls = 0;
  botStartCalls: Array<{ startParam: string; randomId: string }> = [];
  botCallbackCalls: Array<{ messageId: number; data: number[] }> = [];
  sharedMediaCalls = 0;
  pinnedMessageCalls = 0;
  groupMemberCalls = 0;
  stickerPackCalls = 0;
  stickerPacks: import('../types').TelegramStickerPack[] = [];
  sentReplies: Array<TelegramReplyTarget | undefined> = [];
  reactionCalls: Array<{ messageId: number; emoji?: string }> = [];
  failReaction = false;
  muteCalls: boolean[] = [];
  blockCalls: boolean[] = [];
  contactUpdates: Array<{ firstName: string; lastName: string; phone: string }> = [];
  deleteContactCalls = 0;
  dialogPinCalls: boolean[] = [];
  archiveCalls: boolean[] = [];
  peerSearchResults: TelegramPeerSearchResult[] = [];
  deleteDialogCalls = 0;
  userDetailsCalls = 0;
  pinCalls: Array<{ messageId: number; pinned: boolean }> = [];
  pinnedMessages = [{ ...dialog.topMessage!, pinned: true }];
  typingCalls: Array<string | undefined> = [];
  failTyping = false;
  searchScopes: Array<string | undefined> = [];
  private listener: ((batch: TransportUpdateBatch) => void) | undefined;

  async connect(_credentials: TelegramCredentials) {}
  async disconnect() {
    this.disconnectCalls += 1;
  }
  async logOut() {
    this.authorized = false;
  }
  async isAuthorized() {
    return this.authorized;
  }
  async getAuthorizedAccountId() {
    return this.accountId;
  }
  async requestCode(_phoneNumber: string) {
    return { isCodeViaApp: true };
  }
  async submitCode(
    _code: string,
  ): Promise<'authorized' | 'password-required' | 'sign-up-required'> {
    return 'authorized';
  }
  async submitPassword(_password: string) {}
  async getCurrentState() {
    return currentCursor;
  }
  async downloadWallpaper(wallpaperId: string) {
    this.downloadWallpaperCalls += 1;
    return new Blob([wallpaperId], { type: 'image/svg+xml' });
  }
  async getChatAppearance(_peer: TelegramPeer) {
    this.chatAppearanceCalls += 1;
    return {
      wallpaper: {
        id: 'wallpaper-appearance',
        dark: true,
        pattern: true,
        hasFile: true,
        settings: {
          backgroundColors: ['#102d40', '#1d5960'],
          blur: false,
          motion: false,
          intensity: -60,
        },
      },
    };
  }
  async getDifference(_cursor: SyncCursor, totalLimit: number) {
    this.differenceCalls += 1;
    this.differenceLimits.push(totalLimit);
    return this.difference;
  }
  async getChannelDifference(
    _peer: TelegramPeer,
    pts: number,
    _totalLimit: number,
  ): Promise<ChannelDifferenceResult> {
    return { type: 'complete', pts, updates: [] };
  }
  async getDialogs(limit: number): Promise<DialogPage> {
    this.dialogLimits.push(limit);
    return { dialogs: [dialog] };
  }
  async searchPeers() {
    return this.peerSearchResults;
  }
  async getHistory(
    _peer: TelegramPeer,
    _limit: number,
    beforeMessageId?: number,
  ): Promise<HistoryPage> {
    this.historyCalls.push(beforeMessageId);
    const configured = this.history.get(beforeMessageId ?? 0);
    if (configured) return configured;
    return { messages: dialog.topMessage ? [dialog.topMessage] : [], hasOlder: false };
  }
  async readHistory(target: TelegramPeer, maxMessageId: number) {
    this.readCalls.push({ peer: target, maxMessageId });
    return {};
  }
  async getSharedMediaCounts(_peer: TelegramPeer) {
    this.sharedMediaCalls += 1;
    return { ...sharedCounts(0), photos: 12, files: 3, links: 4 };
  }
  async getSharedMedia() {
    return { messages: [dialog.topMessage!], hasMore: false };
  }
  async searchMessages(_query: string, target?: TelegramPeer) {
    this.searchScopes.push(target?.id);
    return { messages: [dialog.topMessage!], hasMore: false };
  }
  async getPinnedMessages(_peer: TelegramPeer): Promise<TelegramMessage[]> {
    this.pinnedMessageCalls += 1;
    return this.pinnedMessages;
  }
  async getGroupMembers(_peer: TelegramPeer): Promise<TelegramGroupMember[]> {
    this.groupMemberCalls += 1;
    return [
      {
        peer: { id: 'member-1', kind: 'user' },
        title: 'Member One',
        initials: 'MO',
        color: '#123456',
        hasAvatar: false,
      },
    ];
  }
  async setMuted(_peer: TelegramPeer, muted: boolean) {
    this.muteCalls.push(muted);
  }
  async getUserDetails() {
    this.userDetailsCalls += 1;
    return { phone: '+15550102048', username: 'mira', bio: 'Bio', blocked: false };
  }
  async setBlocked(_peer: TelegramPeer, blocked: boolean) {
    this.blockCalls.push(blocked);
  }
  async updateContact(_peer: TelegramPeer, firstName: string, lastName: string, phone: string) {
    this.contactUpdates.push({ firstName, lastName, phone });
  }
  async deleteContact(_peer: TelegramPeer) {
    this.deleteContactCalls += 1;
  }
  async setPinnedDialog(_peer: TelegramPeer, pinned: boolean) {
    this.dialogPinCalls.push(pinned);
  }
  async setArchived(_peer: TelegramPeer, archived: boolean) {
    this.archiveCalls.push(archived);
    return {};
  }
  async deleteDialog() {
    this.deleteDialogCalls += 1;
    return {};
  }
  async setPinnedMessage(_peer: TelegramPeer, messageId: number, pinned: boolean) {
    this.pinCalls.push({ messageId, pinned });
    return {};
  }
  async setTyping(_peer: TelegramPeer, kind?: import('../types').TelegramActivityKind) {
    this.typingCalls.push(kind);
    if (this.failTyping) throw new Error('not connected');
  }
  async sendText(
    target: TelegramPeer,
    text: string,
    randomId: string,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ): Promise<SendTextResult> {
    this.sentRandomIds.push(randomId);
    this.sentReplies.push(reply);
    this.sentFormats.push(formats);
    if (this.failSend) throw new Error('connection lost');
    return {
      message: {
        id: 8,
        peerId: target.id,
        senderId: 'self',
        text,
        date: 101,
        outgoing: true,
        randomId,
        formats,
      },
    };
  }
  async sendFile(target: TelegramPeer, file: File, options: SendFileOptions) {
    this.sentFileModes.push(options.sendAs);
    options.onProgress?.(0.5);
    await this.holdFileSend;
    options.onProgress?.(1);
    return this.sendText(
      target,
      options.caption || file.name,
      options.randomId,
      options.reply,
      options.formats,
    );
  }
  async sendAlbum(
    target: TelegramPeer,
    attachments: SendAlbumAttachment[],
    options: SendAlbumOptions,
  ): Promise<SendAlbumResult> {
    this.sentAlbumRandomIds.push(attachments.map(({ randomId }) => randomId));
    options.onProgress?.(0.5);
    await this.holdAlbumSend;
    if (this.failSend) throw new Error('connection lost');
    options.onProgress?.(1);
    const groupedId = `album-${attachments[0]!.randomId}`;
    return {
      messages: attachments.map(({ file, randomId }, index) => ({
        id: 8 + index,
        peerId: target.id,
        senderId: 'self',
        text: index === 0 ? options.caption : '',
        date: 101,
        outgoing: true,
        randomId,
        groupedId,
        media: {
          kind: file.type.startsWith('image/') ? ('photo' as const) : ('file' as const),
          name: file.name,
          mimeType: file.type,
          size: file.size,
        },
      })),
    };
  }
  async downloadMedia(_message: TelegramMessage) {
    this.downloadMediaCalls += 1;
    return new Blob();
  }
  async downloadAvatar() {
    this.downloadAvatarCalls += 1;
    return new Blob();
  }
  async getRecentStickers(): Promise<TelegramSticker[]> {
    return [];
  }
  async getStickerPacks() {
    this.stickerPackCalls += 1;
    return this.stickerPacks;
  }
  async getSavedGifs(): Promise<TelegramSticker[]> {
    return [
      {
        id: 'gif',
        accessHash: '1',
        fileReference: new Uint8Array(),
        emoji: 'GIF',
        mimeType: 'image/gif',
      },
    ];
  }
  async downloadSticker() {
    return new Blob();
  }
  async downloadCustomEmoji() {
    this.downloadCustomEmojiCalls += 1;
    return new Blob(['custom'], { type: 'image/webp' });
  }
  async getBotCommands() {
    this.botCommandCalls += 1;
    return [{ command: 'help', description: 'Show help' }];
  }
  async startBot(target: TelegramPeer, startParam: string, randomId: string) {
    this.botStartCalls.push({ startParam, randomId });
    return this.sendText(target, startParam ? `/start ${startParam}` : '/start', randomId);
  }
  async answerBotCallback(_peer: TelegramPeer, messageId: number, data: number[]) {
    this.botCallbackCalls.push({ messageId, data });
    return { message: 'Done', alert: false };
  }
  async sendSticker(target: TelegramPeer, _sticker: TelegramSticker, randomId: string) {
    return this.sendText(target, '', randomId);
  }
  async setReaction(_peer: TelegramPeer, messageId: number, emoji?: string) {
    this.reactionCalls.push({ messageId, ...(emoji ? { emoji } : {}) });
    if (this.failReaction) throw new Error('reaction failed');
    return {};
  }
  async deleteMessages() {
    return {};
  }
  async editMessage(
    target: TelegramPeer,
    messageId: number,
    text: string,
    formats?: TelegramTextFormat[],
    replacement?: EditMediaOptions,
  ): Promise<EditMessageResult> {
    this.editedFormats.push(formats);
    const source = dialog.topMessage!;
    return {
      message: {
        ...source,
        id: messageId,
        peerId: target.id,
        text,
        formats,
        editedAt: 200,
        ...(replacement
          ? {
              media: {
                kind: replacement.sendAs === 'file' ? ('file' as const) : ('photo' as const),
                name: replacement.file.name,
                mimeType: replacement.file.type,
                size: replacement.file.size,
              },
            }
          : {}),
      },
    };
  }
  async forwardMessage(
    _fromPeer: TelegramPeer,
    toPeer: TelegramPeer,
    messageId: number,
    randomId: string,
  ) {
    this.forwardRandomIds.push(randomId);
    if (this.failSend) throw new Error('connection lost');
    return {
      message: {
        ...dialog.topMessage!,
        id: messageId + 100,
        peerId: toPeer.id,
        senderId: 'self',
        outgoing: true,
        randomId,
      },
    };
  }
  subscribe(listener: (batch: TransportUpdateBatch) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  emit(update: TransportUpdate) {
    this.listener?.({ updates: [update] });
  }
  emitBatch(batch: TransportUpdateBatch) {
    this.listener?.(batch);
  }
}

const credentials = { apiId: 1, apiHash: 'hash' };

describe('MessagingEngine', () => {
  it('requests the complete dialog list during synchronization', async () => {
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());

    await engine.start(credentials);

    expect(transport.dialogLimits).toEqual([Number.MAX_SAFE_INTEGER]);
    await engine.stop();
  });

  it('caches user details and applies block, chat pin, and chat deletion locally', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    await expect(engine.getUserDetails(peer)).resolves.toMatchObject({ username: 'mira' });
    await expect(engine.getUserDetails(peer)).resolves.toMatchObject({ username: 'mira' });
    expect(transport.userDetailsCalls).toBe(1);
    expect(store.dialogs[0]?.userDetails).toMatchObject({ bio: 'Bio', blocked: false });

    await engine.setBlocked(peer, true);
    expect(transport.blockCalls).toEqual([true]);
    expect(engine.snapshot().dialogs[0]?.userDetails?.blocked).toBe(true);
    expect(store.dialogs[0]?.userDetails?.blocked).toBe(true);

    await engine.updateContact(peer, 'Mira', 'Lane', '+15550102048');
    expect(transport.contactUpdates).toEqual([
      { firstName: 'Mira', lastName: 'Lane', phone: '+15550102048' },
    ]);
    expect(engine.snapshot().dialogs[0]).toMatchObject({
      title: 'Mira Lane',
      userDetails: { firstName: 'Mira', lastName: 'Lane', isContact: true },
    });

    await engine.deleteContact(peer);
    expect(transport.deleteContactCalls).toBe(1);
    expect(engine.snapshot().dialogs[0]?.userDetails?.isContact).toBe(false);
    expect(store.dialogs[0]?.userDetails?.isContact).toBe(false);

    await engine.setPinnedDialog(peer, true);
    expect(transport.dialogPinCalls).toEqual([true]);
    expect(engine.snapshot().dialogs[0]?.pinned).toBe(true);

    await engine.setArchived(peer, true);
    expect(transport.archiveCalls).toEqual([true]);
    expect(engine.snapshot().dialogs[0]?.archived).toBe(true);
    expect(store.dialogs[0]?.archived).toBe(true);

    await engine.deleteDialog(peer);
    expect(transport.deleteDialogCalls).toBe(1);
    expect(engine.snapshot().dialogs).toEqual([]);
    expect(store.dialogs).toEqual([]);
    expect(store.messages).toEqual([]);
  });

  it('keeps a Telegram-wide peer search result transient until it becomes a dialog', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const result: TelegramPeerSearchResult = {
      peer: { id: 'c:99', kind: 'channel', accessHash: '199' },
      category: 'channel',
      title: 'Public Search Result',
      initials: 'PSR',
      color: '#445566',
      username: 'public_search_result',
      bot: false,
      isContact: false,
      hasAvatar: false,
    };
    transport.peerSearchResults = [result];
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    await expect(engine.searchPeers('public')).resolves.toEqual([result]);
    await engine.addPeer(result);

    expect(engine.snapshot().dialogs).toContainEqual(
      expect.objectContaining({
        peer: result.peer,
        title: result.title,
        username: result.username,
        archived: false,
        transient: true,
      }),
    );
    expect(store.dialogs).not.toContainEqual(
      expect.objectContaining({ peer: result.peer, title: result.title }),
    );

    await engine.sendDraft(result.peer, 'Open the conversation');
    expect(engine.snapshot().dialogs).toContainEqual(
      expect.objectContaining({ peer: result.peer, transient: false, topMessageId: 8 }),
    );
    expect(store.dialogs).toContainEqual(
      expect.objectContaining({ peer: result.peer, title: result.title, transient: false }),
    );
    await engine.stop();
  });

  it('drives search, shared content, mute, pins, GIFs, typing, and remote state updates', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    await expect(engine.getSharedMedia('photos')).resolves.toEqual({
      messages: [dialog.topMessage],
      hasMore: false,
    });
    await expect(engine.searchMessages('current', false)).resolves.toMatchObject({
      messages: [dialog.topMessage],
    });
    await engine.searchMessages('global', true);
    expect(transport.searchScopes).toEqual([peer.id, undefined]);

    await engine.setMuted(peer, true);
    expect(engine.snapshot().dialogs[0]?.muted).toBe(true);
    expect(transport.muteCalls).toEqual([true]);

    await engine.setPinnedMessage(peer, 7, true);
    expect(engine.snapshot().pinnedMessages).toEqual([expect.objectContaining({ id: 7 })]);
    await engine.setPinnedMessage(peer, 7, false);
    expect(engine.snapshot().pinnedMessages).toEqual([]);
    expect(transport.pinCalls).toEqual([
      { messageId: 7, pinned: true },
      { messageId: 7, pinned: false },
    ]);

    await engine.setTyping(peer, 'typing');
    expect(transport.typingCalls).toEqual(['typing']);
    await expect(engine.getSavedGifs()).resolves.toHaveLength(1);

    transport.emit({
      type: 'activity',
      activity: { peerId: peer.id, senderId: peer.id, kind: 'uploading' },
    });
    await vi.waitFor(() => expect(engine.snapshot().activities).toHaveLength(1));
    transport.emit({ type: 'activity-ended', peerId: peer.id, senderId: peer.id });
    await vi.waitFor(() => expect(engine.snapshot().activities).toEqual([]));
    transport.emit({ type: 'presence-changed', peerId: peer.id, presence: 'online' });
    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.presence).toBe('online'));
    transport.emit({
      type: 'presence-changed',
      peerId: peer.id,
      presence: 'offline',
      lastSeenAt: 123,
    });
    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.lastSeenAt).toBe(123));
    transport.emit({ type: 'mute-changed', peerId: peer.id, muted: false });
    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.muted).toBe(false));
    transport.emit({ type: 'dialog-pinned', peerId: peer.id, pinned: true });
    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.pinned).toBe(true));
    transport.pinnedMessages = [
      { ...dialog.topMessage!, id: 6, text: 'Older pin', pinned: true },
      { ...dialog.topMessage!, pinned: true },
    ];
    transport.emit({
      type: 'pinned-messages',
      pts: 21,
      ptsCount: 1,
      peerId: peer.id,
      messageIds: [6],
      pinned: true,
    });
    await vi.waitFor(() =>
      expect(engine.snapshot().pinnedMessages.map(({ id }) => id)).toEqual([6, 7]),
    );
    expect(transport.pinnedMessageCalls).toBe(2);
    await engine.stop();
  });

  it('reuses cached pinned messages and group members across engine instances', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const groupPeer: TelegramPeer = { id: 'group-1', kind: 'group' };

    const first = new MessagingEngine(transport, store);
    await first.start(credentials);
    await first.selectChat(peer.id);
    await vi.waitFor(() => expect(first.snapshot().pinnedMessages).toHaveLength(1));
    await expect(first.getGroupMembers(groupPeer)).resolves.toHaveLength(1);
    await expect(first.getGroupMembers(groupPeer)).resolves.toHaveLength(1);
    expect(transport.pinnedMessageCalls).toBe(1);
    expect(transport.groupMemberCalls).toBe(1);
    await first.stop();

    const second = new MessagingEngine(transport, store);
    await second.start(credentials);
    await second.selectChat(peer.id);
    await vi.waitFor(() => expect(second.snapshot().pinnedMessages).toHaveLength(1));
    await expect(second.getGroupMembers(groupPeer)).resolves.toHaveLength(1);
    expect(transport.pinnedMessageCalls).toBe(1);
    expect(transport.groupMemberCalls).toBe(1);
    await second.stop();
  });

  it('returns stale group members immediately and refreshes them in the background', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const groupPeer: TelegramPeer = { id: 'group-1', kind: 'group' };
    store.groupMembers.set(groupPeer.id, {
      value: [
        {
          peer: { id: 'cached-member', kind: 'user' },
          title: 'Cached Member',
          initials: 'CM',
          color: '#654321',
          hasAvatar: false,
        },
      ],
      savedAt: 0,
    });

    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    await expect(engine.getGroupMembers(groupPeer)).resolves.toEqual([
      expect.objectContaining({ title: 'Cached Member' }),
    ]);
    await vi.waitFor(() =>
      expect(store.groupMembers.get(groupPeer.id)?.value).toEqual([
        expect.objectContaining({ title: 'Member One' }),
      ]),
    );
    expect(transport.groupMemberCalls).toBe(1);
    await engine.stop();
  });

  it('invalidates cached group members when the membership changes', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const groupPeer: TelegramPeer = { id: 'group-1', kind: 'group' };
    const engine = new MessagingEngine(transport, store);
    const invalidations: string[] = [];
    const unsubscribe = engine.subscribeResources(({ kind, peerId }) =>
      invalidations.push(`${kind}:${peerId ?? ''}`),
    );
    await engine.start(credentials);
    await engine.getGroupMembers(groupPeer);
    const invalidationCount = invalidations.length;

    transport.emit({
      type: 'new-message',
      pts: 21,
      ptsCount: 1,
      message: {
        id: 8,
        peerId: groupPeer.id,
        senderId: peer.id,
        text: '',
        date: 101,
        outgoing: false,
        service: {
          kind: 'users-added',
          text: 'Member Two joined the group',
          targetUserIds: ['member-2'],
        },
      },
    });

    await vi.waitFor(() => expect(invalidations.length).toBeGreaterThan(invalidationCount));
    expect(invalidations.at(-1)).toBe(`group-members:${groupPeer.id}`);
    await engine.getGroupMembers(groupPeer);
    expect(transport.groupMemberCalls).toBe(2);
    unsubscribe();
    await engine.stop();
  });

  it('does not widen a conversation search to global scope without an active dialog', async () => {
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);

    await expect(engine.searchMessages('local only', false)).resolves.toEqual({
      messages: [],
      hasMore: false,
    });
    expect(transport.searchScopes).toEqual([]);

    await engine.searchMessages('global', true);
    expect(transport.searchScopes).toEqual([undefined]);
    await engine.stop();
  });

  it('loads installed sticker packs and applies edit and forward actions', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    await expect(engine.getStickerPacks()).resolves.toEqual([]);
    const formats: TelegramTextFormat[] = [{ offset: 0, length: 6, kind: 'bold' }];
    await engine.editMessage(peer, 7, 'Edited current message', formats);
    expect(engine.snapshot().messages.find(({ id }) => id === 7)?.text).toBe(
      'Edited current message',
    );
    expect(transport.editedFormats).toEqual([formats]);

    await engine.forwardMessage(peer, peer, 7);
    expect(engine.snapshot().messages.find(({ id }) => id === 107)).toMatchObject({
      peerId: peer.id,
      outgoing: true,
    });
    await engine.stop();
  });

  it('invalidates cached expression indexes after Telegram changes them', async () => {
    const store = new MemoryStore();
    store.blobs.set('sticker-index:recent:v2', new Blob(['recent']));
    store.blobs.set('sticker-index:packs:v2', new Blob(['packs']));
    store.blobs.set('sticker-index:gifs:v2', new Blob(['gifs']));
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    const invalidations: string[] = [];
    const unsubscribe = engine.subscribeResources(({ kind }) => invalidations.push(kind));
    await engine.start(credentials);

    transport.emit({ type: 'expression-index-changed', kind: 'stickers' });
    await vi.waitFor(() => expect(invalidations).toEqual(['expressions']));
    expect(store.blobs.has('sticker-index:recent:v2')).toBe(false);
    expect(store.blobs.has('sticker-index:packs:v2')).toBe(false);
    expect(store.blobs.has('sticker-index:gifs:v2')).toBe(true);

    transport.emit({ type: 'expression-index-changed', kind: 'gifs' });
    await vi.waitFor(() => expect(invalidations).toEqual(['expressions', 'expressions']));
    expect(store.blobs.has('sticker-index:gifs:v2')).toBe(false);
    unsubscribe();
    await engine.stop();
  });

  it('reuses a persisted usable sticker-pack index across repeated picker loads', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.stickerPacks = [
      {
        id: 'pack-1',
        title: 'Usable pack',
        stickers: [
          {
            id: 'sticker-1',
            accessHash: '2',
            fileReference: new Uint8Array([3]),
            emoji: '🙂',
            mimeType: 'image/webp',
          },
        ],
      },
    ];
    const engine = new MessagingEngine(transport, store);

    await expect(engine.getStickerPacks()).resolves.toEqual(transport.stickerPacks);
    await expect(engine.getStickerPacks()).resolves.toEqual(transport.stickerPacks);

    expect(transport.stickerPackCalls).toBe(1);
    expect(store.blobs.has('sticker-index:packs:v2')).toBe(true);
  });

  it('keeps failed sticker sends durable and retries their random id after restart', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const first = new MessagingEngine(transport, store);
    await first.start(credentials);
    await first.selectChat(peer.id);
    const sticker: TelegramSticker = {
      id: '31',
      accessHash: '32',
      fileReference: new Uint8Array([3]),
      emoji: '🎉',
      mimeType: 'image/webp',
    };

    await first.sendSticker(peer, sticker);
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]?.sticker).toEqual(sticker);
    const randomId = store.outbox[0]!.randomId;
    await first.stop();

    transport.failSend = false;
    const restarted = new MessagingEngine(transport, store);
    await restarted.start(credentials);
    expect(transport.sentRandomIds).toEqual([randomId, randomId]);
    expect(store.outbox).toEqual([]);
  });

  it('keeps failed forwards durable and retries their persisted random id after restart', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const first = new MessagingEngine(transport, store);
    await first.start(credentials);
    await first.selectChat(peer.id);

    await first.forwardMessage(peer, peer, 7);

    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]?.forward).toEqual({ fromPeer: peer, messageId: 7 });
    const randomId = store.outbox[0]!.randomId;
    expect(transport.forwardRandomIds).toEqual([randomId]);
    await first.stop();

    transport.failSend = false;
    const restarted = new MessagingEngine(transport, store);
    await restarted.start(credentials);

    expect(transport.forwardRandomIds).toEqual([randomId, randomId]);
    expect(store.outbox).toEqual([]);
    await restarted.stop();
  });

  it('deduplicates and caches concurrent sticker downloads', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    const sticker: TelegramSticker = {
      id: '31',
      accessHash: '32',
      fileReference: new Uint8Array([3]),
      emoji: '🎉',
      mimeType: 'image/webp',
    };

    await expect(engine.getRecentStickers()).resolves.toEqual([]);
    const [first, second] = await Promise.all([
      engine.downloadSticker(sticker),
      engine.downloadSticker(sticker),
    ]);

    expect(first).toBe(second);
    expect(store.blobs.get('sticker:31')).toBe(first);
  });

  it('delivers durable replies with their selected quote metadata', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await engine.setDraft(peer.id, 'Reply body');

    await engine.sendDraft(peer, 'Reply body', { messageId: 7, quoteText: 'Current' });

    expect(transport.sentReplies).toEqual([{ messageId: 7, quoteText: 'Current' }]);
    expect(engine.snapshot().messages.at(-1)).toMatchObject({ text: 'Reply body' });
    expect(store.outbox).toEqual([]);
  });

  it('rolls a failed optimistic reaction back in memory and cache', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    transport.failReaction = true;

    await engine.toggleReaction(peer, 7, '🔥');

    expect(transport.reactionCalls).toEqual([{ messageId: 7, emoji: '🔥' }]);
    expect(engine.snapshot().messages[0]?.reactions).toEqual([]);
    expect(store.messages.find(({ id }) => id === 7)?.reactions).toEqual([]);
  });

  it('serializes rapid reaction toggles for the same message', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const firstReaction = deferred<void>();
    transport.setReaction = async (_peer, messageId, emoji) => {
      transport.reactionCalls.push({ messageId, ...(emoji ? { emoji } : {}) });
      if (transport.reactionCalls.length === 1) await firstReaction.promise;
      return {};
    };
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    const first = engine.toggleReaction(peer, 7, '🔥');
    await vi.waitFor(() =>
      expect(transport.reactionCalls).toEqual([{ messageId: 7, emoji: '🔥' }]),
    );
    const second = engine.toggleReaction(peer, 7, '🔥');
    await Promise.resolve();
    expect(transport.reactionCalls).toHaveLength(1);

    firstReaction.resolve();
    await Promise.all([first, second]);

    expect(transport.reactionCalls).toEqual([{ messageId: 7, emoji: '🔥' }, { messageId: 7 }]);
    expect(engine.snapshot().messages[0]?.reactions).toEqual([]);
    expect(store.messages.find(({ id }) => id === 7)?.reactions).toEqual([]);
    await engine.stop();
  });

  it('does not let a failed local reaction overwrite a newer server update', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const reaction = deferred<void>();
    transport.setReaction = async (_peer, messageId, emoji) => {
      transport.reactionCalls.push({ messageId, ...(emoji ? { emoji } : {}) });
      await reaction.promise;
      return {};
    };
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    const toggling = engine.toggleReaction(peer, 7, '🔥');
    await vi.waitFor(() => expect(transport.reactionCalls).toHaveLength(1));
    const serverReactions = [{ emoji: '❤️', count: 2, chosen: false }];
    transport.emit({
      type: 'reaction-changed',
      peerId: peer.id,
      messageId: 7,
      reactions: serverReactions,
    });
    await vi.waitFor(() =>
      expect(engine.snapshot().messages[0]?.reactions).toEqual(serverReactions),
    );

    reaction.reject(new Error('reaction failed'));
    await toggling;

    expect(engine.snapshot().messages[0]?.reactions).toEqual(serverReactions);
    expect(store.messages.find(({ id }) => id === 7)?.reactions).toEqual(serverReactions);
    await engine.stop();
  });

  it('versions cached avatars by Telegram photo id', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);

    await engine.downloadAvatar(peer, 'photo-1');
    expect(await engine.loadCachedAvatar(peer, 'photo-1')).toEqual(
      store.blobs.get('avatar:peer-1:photo-1'),
    );
    await engine.downloadAvatar(peer, 'photo-1');
    await engine.downloadAvatar(peer, 'photo-2');

    expect(transport.downloadAvatarCalls).toBe(2);
    expect([...store.blobs.keys()]).toEqual(['avatar:peer-1:photo-1', 'avatar:peer-1:photo-2']);
  });

  it('replaces cached dialog heads so removed or archived chats disappear', async () => {
    const store = new MemoryStore();
    store.dialogs = [
      {
        ...dialog,
        peer: { id: 'archived-peer', kind: 'user' },
        title: 'Previously cached archive',
        cacheEpoch: 0,
      },
    ];
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);

    expect(store.dialogs.map(({ peer: cachedPeer }) => cachedPeer.id)).toEqual([peer.id]);
    expect(engine.snapshot().dialogs.map(({ peer: activePeer }) => activePeer.id)).toEqual([
      peer.id,
    ]);
  });

  it('starts at current server state without replaying history on first login', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);

    expect(transport.differenceCalls).toBe(0);
    expect(store.cursor).toEqual(currentCursor);
    expect(engine.snapshot().phase).toBe('ready');
    expect(engine.snapshot().dialogs.map(({ title }) => title)).toEqual(['Mira']);
    await engine.stop();
  });

  it('skips a large backlog and starts a fresh cache epoch', async () => {
    const store = new MemoryStore();
    store.cursor = { ...currentCursor, pts: 1 };
    const transport = new FakeTransport();
    transport.difference = { type: 'too-long', cursor: currentCursor };
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);

    expect(store.epoch).toBe(1);
    expect(store.dialogs[0]?.cacheEpoch).toBe(1);
    expect(store.cursor).toEqual(currentCursor);
    expect(engine.snapshot().sync).toBe('current');
    await engine.stop();
  });

  it('replays a complete difference at the 100-PTS latest-state boundary', async () => {
    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new FakeTransport();
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: currentCursor.pts + 100, date: 200 },
      updates: [
        {
          type: 'new-message',
          pts: currentCursor.pts + 100,
          ptsCount: 100,
          message: {
            ...dialog.topMessage!,
            id: 8,
            text: 'Last update within the replay budget',
            date: 200,
          },
        },
      ],
    };
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);

    expect(transport.differenceLimits).toEqual([100]);
    expect(store.epoch).toBe(0);
    expect(store.cursor?.pts).toBe(currentCursor.pts + 100);
    expect(store.messages).toContainEqual(
      expect.objectContaining({ id: 8, text: 'Last update within the replay budget' }),
    );
    await engine.stop();
  });

  it('atomically loads latest state above the replay budget without losing drafts or outbox', async () => {
    const cachedMessage: CachedMessage = {
      ...dialog.topMessage!,
      text: 'Cached before reconnect',
      cacheEpoch: 4,
    };
    const latestMessage: TelegramMessage = {
      ...dialog.topMessage!,
      id: 200,
      text: 'Current server head',
      date: 300,
    };
    const latestDialog: TelegramDialog = {
      ...dialog,
      topMessageId: latestMessage.id,
      topMessage: latestMessage,
    };
    class LatestStateTransport extends FakeTransport {
      override async getDialogs(limit: number): Promise<DialogPage> {
        this.dialogLimits.push(limit);
        return { dialogs: [latestDialog] };
      }

      override async getHistory(
        _peer: TelegramPeer,
        _limit: number,
        beforeMessageId?: number,
      ): Promise<HistoryPage> {
        this.historyCalls.push(beforeMessageId);
        return { messages: [latestMessage], hasOlder: false };
      }
    }

    const pending = pendingSend('Queued while offline', 1);
    const store = new MemoryStore();
    store.accountId = 'account-1';
    store.cursor = currentCursor;
    store.epoch = 4;
    store.dialogs = [{ ...dialog, topMessage: cachedMessage, cacheEpoch: 4 }];
    store.messages = [cachedMessage];
    store.drafts = { [peer.id]: 'Unsent local draft' };
    store.draftRevisions = { [peer.id]: 6 };
    store.outbox = [pending];
    store.lastPeerId = peer.id;
    const transport = new LatestStateTransport();
    transport.failSend = true;
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: currentCursor.pts + 101, date: 300 },
      updates: [
        {
          type: 'new-message',
          pts: currentCursor.pts + 101,
          ptsCount: 101,
          message: {
            ...dialog.topMessage!,
            id: 99,
            text: 'Historical update that must not be replayed',
            date: 250,
          },
        },
      ],
    };
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);

    expect(store.epoch).toBe(5);
    expect(store.cursor?.pts).toBe(currentCursor.pts + 101);
    expect(store.dialogs[0]).toMatchObject({ topMessageId: 200, cacheEpoch: 5 });
    expect(store.messages.map(({ id }) => id)).toEqual([200]);
    expect(store.drafts).toEqual({ [peer.id]: 'Unsent local draft' });
    expect(store.draftRevisions).toEqual({ [peer.id]: 6 });
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]).toMatchObject({
      id: pending.id,
      randomId: pending.randomId,
      text: pending.text,
    });
    await engine.stop();
  });

  it('publishes a small difference without exposing intermediate dialog heads', async () => {
    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    const observedTopMessageIds: number[] = [];
    const unsubscribe = engine.subscribe((snapshot) => {
      const topMessageId = snapshot.dialogs[0]?.topMessageId;
      if (topMessageId !== undefined) observedTopMessageIds.push(topMessageId);
    });
    observedTopMessageIds.length = 0;
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: currentCursor.pts + 3, date: 103 },
      updates: [8, 9, 10].map((id, index) => ({
        type: 'new-message' as const,
        pts: currentCursor.pts + index + 1,
        ptsCount: 1,
        message: {
          ...dialog.topMessage!,
          id,
          text: `Caught-up message ${id}`,
          date: 101 + index,
        },
      })),
    };

    await engine.refreshUpdates();

    expect(observedTopMessageIds).not.toContain(8);
    expect(observedTopMessageIds).not.toContain(9);
    expect(observedTopMessageIds.at(-1)).toBe(10);
    unsubscribe();
    await engine.stop();
  });

  it('preserves the previous cache and cursor when latest-state fetching fails before commit', async () => {
    const cachedMessage: CachedMessage = {
      ...dialog.topMessage!,
      text: 'Safe cached message',
      cacheEpoch: 7,
    };
    const cachedDialog: CachedDialog = {
      ...dialog,
      title: 'Safe cached dialog',
      topMessage: cachedMessage,
      cacheEpoch: 7,
    };
    const latestMessage: TelegramMessage = {
      ...dialog.topMessage!,
      id: 300,
      text: 'Uncommitted server message',
      date: 400,
    };
    class FailingLatestStateTransport extends FakeTransport {
      override async getDialogs(limit: number): Promise<DialogPage> {
        this.dialogLimits.push(limit);
        return {
          dialogs: [
            {
              ...dialog,
              title: 'Uncommitted server dialog',
              topMessageId: latestMessage.id,
              topMessage: latestMessage,
            },
          ],
        };
      }

      override async getHistory(): Promise<HistoryPage> {
        throw new Error('latest history fetch failed');
      }
    }

    const store = new MemoryStore();
    store.accountId = 'account-1';
    store.cursor = currentCursor;
    store.epoch = 7;
    store.dialogs = [cachedDialog];
    store.messages = [cachedMessage];
    store.drafts = { [peer.id]: 'Keep this draft too' };
    store.draftRevisions = { [peer.id]: 2 };
    store.lastPeerId = peer.id;
    const transport = new FailingLatestStateTransport();
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: currentCursor.pts + 101, date: 400 },
      updates: [],
    };
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);

    expect(store.epoch).toBe(7);
    expect(store.cursor).toEqual(currentCursor);
    expect(store.dialogs).toEqual([cachedDialog]);
    expect(store.messages).toEqual([cachedMessage]);
    expect(store.drafts).toEqual({ [peer.id]: 'Keep this draft too' });
    expect(store.draftRevisions).toEqual({ [peer.id]: 2 });
    expect(engine.snapshot().sync).toBe('stale');
    await engine.stop();
  });

  it('preserves and reloads the final chat selection while latest-state commit is deferred', async () => {
    const secondPeer: TelegramPeer = { id: 'peer-2', kind: 'user' };
    const secondMessage: TelegramMessage = {
      ...dialog.topMessage!,
      id: 22,
      peerId: secondPeer.id,
      senderId: secondPeer.id,
      text: 'Latest second-chat message',
      date: 220,
    };
    const secondDialog: TelegramDialog = {
      ...dialog,
      peer: secondPeer,
      title: 'Second chat',
      topMessageId: secondMessage.id,
      topMessage: secondMessage,
    };
    const commitStarted = deferred<void>();
    const releaseCommit = deferred<void>();
    class DeferredLatestStateStore extends MemoryStore {
      override async commitLatestState(state: LatestStateCache) {
        commitStarted.resolve(undefined);
        await releaseCommit.promise;
        return super.commitLatestState(state);
      }
    }
    class TwoChatTransport extends FakeTransport {
      historyPeers: string[] = [];

      override async getDialogs(limit: number): Promise<DialogPage> {
        this.dialogLimits.push(limit);
        return { dialogs: [dialog, secondDialog] };
      }

      override async getHistory(target: TelegramPeer): Promise<HistoryPage> {
        this.historyPeers.push(target.id);
        return {
          messages: [target.id === secondPeer.id ? secondMessage : dialog.topMessage!],
          hasOlder: false,
        };
      }
    }

    const store = new DeferredLatestStateStore();
    store.accountId = 'account-1';
    store.cursor = currentCursor;
    store.dialogs = [
      { ...dialog, cacheEpoch: 0 },
      { ...secondDialog, topMessage: undefined, cacheEpoch: 0 },
    ];
    store.lastPeerId = peer.id;
    const transport = new TwoChatTransport();
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: currentCursor.pts + 101 },
      updates: [],
    };
    const engine = new MessagingEngine(transport, store);

    const starting = engine.start(credentials);
    await commitStarted.promise;
    const switches = [
      engine.selectChat(secondPeer.id),
      engine.selectChat(peer.id),
      engine.selectChat(secondPeer.id),
      engine.selectChat(peer.id),
      engine.selectChat(secondPeer.id),
    ];
    expect(engine.snapshot().activePeerId).toBe(secondPeer.id);
    releaseCommit.resolve(undefined);
    await Promise.all([starting, ...switches]);

    expect(store.cursor?.pts).toBe(currentCursor.pts + 101);
    expect(store.epoch).toBe(1);
    expect(engine.snapshot().activePeerId).toBe(secondPeer.id);
    expect(engine.snapshot().messages).toContainEqual(
      expect.objectContaining({ peerId: secondPeer.id, id: secondMessage.id }),
    );
    expect(store.lastPeerId).toBe(secondPeer.id);
    await engine.stop();
  });

  it('keeps latest-state shared-media counts when an older request resolves last', async () => {
    const oldCountsStarted = deferred<void>();
    const oldCounts = deferred<SharedMediaCounts>();
    const latestCounts = { ...sharedCounts(0), photos: 90, files: 12, links: 7 };
    class RefreshingCountsTransport extends FakeTransport {
      countRequests = 0;

      override getSharedMediaCounts() {
        this.countRequests += 1;
        if (this.countRequests === 1) {
          oldCountsStarted.resolve(undefined);
          return oldCounts.promise;
        }
        return Promise.resolve(latestCounts);
      }
    }

    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new RefreshingCountsTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await oldCountsStarted.promise;
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: currentCursor.pts + 101 },
      updates: [],
    };

    await engine.refreshUpdates();
    expect(engine.snapshot().sharedMediaCounts).toEqual(latestCounts);
    oldCounts.resolve(sharedCounts(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.snapshot().sharedMediaCounts).toEqual(latestCounts);
    await engine.stop();
  });

  it('reloads shared-media counts when the latest-state count request fails', async () => {
    const initialCounts = { ...sharedCounts(0), photos: 4 };
    const refreshedCounts = { ...sharedCounts(0), photos: 14, videos: 6, files: 2 };
    class FlakyLatestStateCountsTransport extends FakeTransport {
      countRequests = 0;

      override async getSharedMediaCounts() {
        this.countRequests += 1;
        if (this.countRequests === 2) throw new Error('latest-state count failure');
        return this.countRequests === 1 ? initialCounts : refreshedCounts;
      }
    }

    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new FlakyLatestStateCountsTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await vi.waitFor(() => expect(engine.snapshot().sharedMediaCounts).toEqual(initialCounts));
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: currentCursor.pts + 101 },
      updates: [],
    };

    await engine.refreshUpdates();

    await vi.waitFor(() => expect(engine.snapshot().sharedMediaCounts).toEqual(refreshedCounts));
    expect(transport.countRequests).toBe(3);
    await engine.stop();
  });

  it('fences stale user details and sticker indexes before latest-state commit', async () => {
    const details = deferred<{ phone: string; username: string; bio: string; blocked: boolean }>();
    const recent = deferred<TelegramSticker[]>();
    const commitStarted = deferred<void>();
    const releaseCommit = deferred<void>();
    class DeferredMetadataStore extends MemoryStore {
      override async commitLatestState(state: LatestStateCache) {
        commitStarted.resolve(undefined);
        await releaseCommit.promise;
        return super.commitLatestState(state);
      }
    }
    class DeferredMetadataTransport extends FakeTransport {
      override getUserDetails() {
        return details.promise;
      }

      override getRecentStickers() {
        return recent.promise;
      }
    }
    const staleSticker: TelegramSticker = {
      id: 'stale-sticker',
      accessHash: '1',
      fileReference: new Uint8Array(),
      emoji: 'old',
      mimeType: 'image/webp',
    };
    const store = new DeferredMetadataStore();
    store.cursor = currentCursor;
    const transport = new DeferredMetadataTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    const staleDetails = engine.getUserDetails(peer);
    const staleRecent = engine.getRecentStickers();
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: currentCursor.pts + 101 },
      updates: [],
    };

    const refreshing = engine.refreshUpdates();
    await commitStarted.promise;
    details.resolve({ phone: '+1', username: 'stale', bio: 'Old', blocked: false });
    recent.resolve([staleSticker]);
    releaseCommit.resolve(undefined);
    await Promise.all([refreshing, staleDetails, staleRecent]);

    expect(engine.snapshot().dialogs[0]?.userDetails).toBeUndefined();
    expect(store.dialogs[0]?.userDetails).toBeUndefined();
    expect(store.blobs.has('sticker-index:recent:v2')).toBe(false);
    await engine.stop();
  });

  it('applies a confirmed dialog mutation after an in-progress latest-state replacement', async () => {
    const commitStarted = deferred<void>();
    const releaseCommit = deferred<void>();
    class DeferredMutationStore extends MemoryStore {
      override async commitLatestState(state: LatestStateCache) {
        commitStarted.resolve(undefined);
        await releaseCommit.promise;
        return super.commitLatestState(state);
      }
    }

    const store = new DeferredMutationStore();
    store.cursor = currentCursor;
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: currentCursor.pts + 101 },
      updates: [],
    };

    const refreshing = engine.refreshUpdates();
    await commitStarted.promise;
    const muting = engine.setMuted(peer, true);
    releaseCommit.resolve(undefined);
    await Promise.all([refreshing, muting]);

    expect(engine.snapshot().dialogs[0]?.muted).toBe(true);
    expect(store.dialogs[0]?.muted).toBe(true);
    await engine.stop();
  });

  it('does not increment unread when a queued live message is already the fresh dialog head', async () => {
    const dialogsRequested = deferred<void>();
    const latestDialogs = deferred<DialogPage>();
    class DeferredDialogTransport extends FakeTransport {
      deferNextDialogs = false;

      override getDialogs(limit: number): Promise<DialogPage> {
        this.dialogLimits.push(limit);
        if (!this.deferNextDialogs) return Promise.resolve({ dialogs: [dialog] });
        dialogsRequested.resolve(undefined);
        return latestDialogs.promise;
      }
    }
    const incoming: TelegramMessage = {
      ...dialog.topMessage!,
      id: 8,
      text: 'Already reflected by getDialogs',
      date: 200,
      outgoing: false,
      randomId: 'live-random-id',
    };
    const snapshotHead: TelegramMessage = {
      ...incoming,
      text: 'Dialog snapshot before live correlation',
      randomId: 'uncorrelated-server-id',
    };
    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new DeferredDialogTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    transport.deferNextDialogs = true;
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: currentCursor.pts + 101 },
      updates: [],
    };

    const refreshing = engine.refreshUpdates();
    await dialogsRequested.promise;
    transport.emit({ type: 'new-message', pts: 122, ptsCount: 1, message: incoming });
    latestDialogs.resolve({
      dialogs: [
        {
          ...dialog,
          topMessageId: incoming.id,
          topMessage: snapshotHead,
          unreadCount: 2,
        },
      ],
    });
    await refreshing;
    await vi.waitFor(() => expect(store.cursor?.pts).toBe(122));

    expect(engine.snapshot().dialogs[0]).toMatchObject({
      topMessageId: 8,
      unreadCount: 2,
      topMessage: {
        text: 'Already reflected by getDialogs',
        randomId: 'live-random-id',
      },
    });
    expect(store.dialogs[0]).toMatchObject({
      topMessageId: 8,
      unreadCount: 2,
      topMessage: { randomId: 'live-random-id' },
    });
    await engine.stop();
  });

  it('retries a durable send with the same random id after restart', async () => {
    const store = new MemoryStore();
    const failingTransport = new FakeTransport();
    failingTransport.failSend = true;
    const firstEngine = new MessagingEngine(failingTransport, store);
    await firstEngine.start(credentials);
    await firstEngine.setDraft(peer.id, 'Never duplicate this');
    await firstEngine.sendDraft(peer, 'Never duplicate this');

    const originalRandomId = store.outbox[0]?.randomId;
    expect(originalRandomId).toBeDefined();
    expect(failingTransport.sentRandomIds).toEqual([originalRandomId]);
    await firstEngine.stop();

    const recoveredTransport = new FakeTransport();
    const recoveredEngine = new MessagingEngine(recoveredTransport, store);
    await recoveredEngine.start(credentials);

    expect(recoveredTransport.sentRandomIds).toEqual([originalRandomId]);
    expect(store.outbox).toEqual([]);
    await recoveredEngine.stop();
  });

  it('retries a legacy attachment without a stored mode as media', async () => {
    const store = new MemoryStore();
    store.accountId = 'account-1';
    store.outbox = [
      {
        id: 'legacy-attachment',
        accountId: 'account-1',
        peer,
        text: 'Legacy photo',
        randomId: '901',
        createdAt: 1,
        attempts: 0,
        attachment: {
          blob: new Blob(['photo'], { type: 'image/png' }),
          name: 'legacy.png',
          mimeType: 'image/png',
          asSticker: false,
        },
      } as PendingSend,
    ];
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);

    expect(transport.sentFileModes).toEqual(['media']);
    expect(store.outbox).toEqual([]);
    await engine.stop();
  });

  it('marks an opened chat as read and applies outgoing read receipts', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    await engine.selectChat(peer.id);
    await engine.setActiveConversationVisibility(peer.id, { visible: true, atBottom: true });
    expect(transport.readCalls).toEqual([{ peer, maxMessageId: 7 }]);
    expect(engine.snapshot().dialogs[0]?.unreadCount).toBe(0);

    transport.emit({
      type: 'read-history',
      pts: 21,
      ptsCount: 1,
      peerId: peer.id,
      maxMessageId: 8,
      direction: 'outbox',
    });
    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.readOutboxMaxId).toBe(8));
    await engine.stop();
  });

  it('ignores an already-applied PTS update without reconciling again', async () => {
    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    expect(transport.differenceCalls).toBe(1);

    transport.emit({
      type: 'read-history',
      pts: currentCursor.pts,
      ptsCount: 1,
      peerId: peer.id,
      maxMessageId: 8,
      direction: 'outbox',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.differenceCalls).toBe(1);
    expect(engine.snapshot().dialogs[0]?.readOutboxMaxId).toBe(0);
    await engine.stop();
  });

  it('silently catches up messages sent from another client', async () => {
    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: 21, date: 101 },
      updates: [
        {
          type: 'new-message',
          pts: 21,
          ptsCount: 1,
          message: {
            ...dialog.topMessage!,
            id: 8,
            text: 'Sent from Telegram Desktop',
            outgoing: true,
          },
        },
      ],
    };

    await engine.refreshUpdates();

    expect(engine.snapshot().phase).toBe('ready');
    expect(engine.snapshot().messages).toContainEqual(
      expect.objectContaining({ id: 8, text: 'Sent from Telegram Desktop' }),
    );
    expect(engine.snapshot().dialogs[0]?.topMessage).toMatchObject({
      id: 8,
      text: 'Sent from Telegram Desktop',
    });
    expect(store.cursor?.pts).toBe(21);
    await engine.stop();
  });

  it('loads and deduplicates older history pages', async () => {
    const makeMessage = (id: number) => ({
      id,
      peerId: peer.id,
      senderId: peer.id,
      text: `Message ${id}`,
      date: id,
      outgoing: false,
    });
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.history.set(0, {
      messages: Array.from({ length: 50 }, (_, index) => makeMessage(index + 51)),
      hasOlder: true,
    });
    transport.history.set(51, {
      messages: Array.from({ length: 51 }, (_, index) => makeMessage(index + 1)),
      hasOlder: false,
    });
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await engine.loadOlderMessages();

    expect(transport.historyCalls).toEqual([undefined, 51]);
    expect(engine.snapshot().messages).toHaveLength(100);
    expect(engine.snapshot().messages[0]?.id).toBe(1);
    expect(engine.snapshot().hasOlderMessages).toBe(false);
    await engine.stop();
  });

  it('publishes attachment upload progress while the durable send is in flight', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    let releaseUpload!: () => void;
    transport.holdFileSend = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    const sending = engine.sendAttachment(
      peer,
      new File(['payload'], 'photo.webp', { type: 'image/webp' }),
    );
    await vi.waitFor(() => expect(engine.snapshot().pending[0]?.uploadProgress).toBe(0.5));
    releaseUpload();
    await sending;

    expect(engine.snapshot().pending).toEqual([]);
    await engine.stop();
  });

  it('persists a mixed attachment plan before starting its first album upload', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const releaseAlbum = deferred<void>();
    transport.holdAlbumSend = releaseAlbum.promise;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    const image = (name: string) => new File([name], name, { type: 'image/png' });
    const sending = engine.sendAttachments(
      peer,
      [
        { file: image('one.png'), sendAs: 'media' },
        { file: image('two.png'), sendAs: 'media' },
        { file: new File(['pdf'], 'three.pdf', { type: 'application/pdf' }), sendAs: 'file' },
        { file: image('four.png'), sendAs: 'media' },
        { file: image('five.png'), sendAs: 'media' },
      ],
      'Batch caption',
    );
    await vi.waitFor(() => expect(transport.sentAlbumRandomIds).toHaveLength(1));

    expect(store.outbox).toHaveLength(3);
    const persisted = [...store.outbox].sort((left, right) => left.createdAt - right.createdAt);
    expect(persisted.map((send) => (send.album ? 'album' : send.attachment?.sendAs))).toEqual([
      'album',
      'file',
      'album',
    ]);
    expect(persisted[0]).toMatchObject({ text: 'Batch caption' });
    expect(persisted[1]).toMatchObject({ text: '' });
    releaseAlbum.resolve(undefined);
    await sending;
    expect(transport.sentAlbumRandomIds).toHaveLength(2);
    expect(store.outbox).toEqual([]);
    await engine.stop();
  });

  it('waits for an older draft write before atomically reserving an attachment batch', async () => {
    const draftWriteStarted = deferred<void>();
    const releaseDraftWrite = deferred<void>();
    class SlowDraftStore extends MemoryStore {
      override async saveDraft(peerId: string, text: string, revision = 0) {
        if (text === 'Captured caption') {
          draftWriteStarted.resolve(undefined);
          await releaseDraftWrite.promise;
        }
        await super.saveDraft(peerId, text, revision);
      }
    }
    const store = new SlowDraftStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    const saving = engine.setDraft(peer.id, 'Captured caption');
    await draftWriteStarted.promise;
    const sending = engine.sendAttachments(
      peer,
      [
        { file: new File(['one'], 'one.png', { type: 'image/png' }), sendAs: 'media' },
        { file: new File(['two'], 'two.png', { type: 'image/png' }), sendAs: 'media' },
      ],
      'Captured caption',
    );
    await Promise.resolve();
    expect(store.outbox).toEqual([]);

    releaseDraftWrite.resolve(undefined);
    await Promise.all([saving, sending]);

    expect(store.drafts).toEqual({});
    expect(store.outbox).toHaveLength(1);
    expect(engine.snapshot().drafts[peer.id]).toBe('');
    await engine.stop();
  });

  it('preserves newer typing queued behind an attachment reservation', async () => {
    const reservationStarted = deferred<void>();
    const releaseReservation = deferred<void>();
    class SlowReservationStore extends MemoryStore {
      override async commitOutbox(sends: PendingSend | PendingSend[], draft?: DraftReservation) {
        if (draft) {
          reservationStarted.resolve(undefined);
          await releaseReservation.promise;
        }
        await super.commitOutbox(sends, draft);
      }
    }
    const store = new SlowReservationStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.setDraft(peer.id, 'Captured caption');

    const sending = engine.sendAttachments(
      peer,
      [{ file: new File(['one'], 'one.png', { type: 'image/png' }), sendAs: 'media' }],
      'Captured caption',
    );
    await reservationStarted.promise;
    const savingNewer = engine.setDraft(peer.id, 'Newer typing');
    releaseReservation.resolve(undefined);
    await Promise.all([sending, savingNewer]);

    expect(store.drafts).toEqual({ [peer.id]: 'Newer typing' });
    expect(engine.snapshot().drafts[peer.id]).toBe('Newer typing');
    await engine.stop();
  });

  it('reuses every persisted album random id when retrying', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    await engine.sendAttachments(
      peer,
      [
        { file: new File(['one'], 'one.png', { type: 'image/png' }), sendAs: 'media' },
        { file: new File(['two'], 'two.png', { type: 'image/png' }), sendAs: 'media' },
      ],
      'Album caption',
    );
    const queued = engine.snapshot().pending[0]!;
    const randomIds = queued.album!.attachments.map(({ randomId }) => randomId);
    expect(transport.sentAlbumRandomIds).toEqual([randomIds]);
    expect(queued).toMatchObject({ attempts: 1, lastError: 'connection lost' });

    transport.failSend = false;
    await engine.retryPendingSend(queued.id);
    expect(transport.sentAlbumRandomIds).toEqual([randomIds, randomIds]);
    expect(engine.snapshot().pending).toEqual([]);
    expect(engine.snapshot().messages.filter(({ groupedId }) => groupedId)).toHaveLength(2);
    await engine.stop();
  });

  it('delivers sends to one peer strictly in durable queue order', async () => {
    const releaseFirst = deferred<void>();
    class OrderedTransport extends FakeTransport {
      texts: string[] = [];

      override async sendText(
        target: TelegramPeer,
        text: string,
        randomId: string,
        reply?: TelegramReplyTarget,
        formats?: TelegramTextFormat[],
      ) {
        this.texts.push(text);
        if (this.texts.length === 1) await releaseFirst.promise;
        const result = await super.sendText(target, text, randomId, reply, formats);
        return {
          ...result,
          message: { ...result.message, id: 7 + this.texts.length },
        };
      }
    }
    const transport = new OrderedTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);

    const first = engine.sendDraft(peer, 'First');
    await vi.waitFor(() => expect(transport.texts).toEqual(['First']));
    const second = engine.sendDraft(peer, 'Second');
    await Promise.resolve();
    expect(transport.texts).toEqual(['First']);

    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);
    expect(transport.texts).toEqual(['First', 'Second']);
    await engine.stop();
  });

  it('replays same-millisecond persisted sends by stable peer queue order', async () => {
    class RecordingTransport extends FakeTransport {
      texts: string[] = [];

      override async sendText(
        target: TelegramPeer,
        text: string,
        randomId: string,
        reply?: TelegramReplyTarget,
        formats?: TelegramTextFormat[],
      ) {
        this.texts.push(text);
        return super.sendText(target, text, randomId, reply, formats);
      }
    }
    const store = new MemoryStore();
    store.accountId = 'account-1';
    store.outbox = [
      {
        ...pendingSend('Second', 10),
        id: 'second',
        randomId: 'second-random',
        queueOrder: 2,
      },
      {
        ...pendingSend('First', 10),
        id: 'first',
        randomId: 'first-random',
        queueOrder: 1,
      },
    ];
    const transport = new RecordingTransport();
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);

    expect(transport.texts).toEqual(['First', 'Second']);
    await engine.stop();
  });

  it('keeps the tab lifecycle quiescing while a pending send is being persisted', async () => {
    const pendingWriteStarted = deferred<void>();
    const releasePendingWrite = deferred<void>();
    class SlowPendingStore extends MemoryStore {
      override async commitOutbox(send: PendingSend) {
        pendingWriteStarted.resolve(undefined);
        await releasePendingWrite.promise;
        await super.commitOutbox(send);
      }
    }
    const store = new SlowPendingStore();
    const engine = new MessagingEngine(new FakeTransport(), store);
    await engine.start(credentials);

    const sending = engine.sendAttachment(peer, new File(['payload'], 'pending.txt'));
    await pendingWriteStarted.promise;
    let stopped = false;
    const stopping = engine.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releasePendingWrite.resolve(undefined);
    await Promise.all([sending, stopping]);

    expect(store.outbox).toHaveLength(1);
    expect(engine.snapshot()).toMatchObject({ phase: 'idle', online: false, pending: [] });
  });

  it('runs the phone and code authorization flow before synchronizing', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.authorized = false;
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);
    expect(engine.snapshot()).toMatchObject({ phase: 'unauthorized', authStep: 'phone' });
    await engine.requestCode('+79991234567');
    expect(engine.snapshot()).toMatchObject({
      phase: 'unauthorized',
      authStep: 'code',
      codeViaApp: true,
    });
    await engine.submitCode('12345');
    expect(engine.snapshot().phase).toBe('ready');
    await engine.stop();
  });

  it('keeps focus retries from restarting the transport during authorization', async () => {
    const transport = new FakeTransport();
    transport.authorized = false;
    const connect = vi.spyOn(transport, 'connect');
    const engine = new MessagingEngine(transport, new MemoryStore());

    await engine.start(credentials);
    await engine.requestCode('+79991234567');
    await engine.retrySync();

    expect(connect).toHaveBeenCalledOnce();
    expect(engine.snapshot()).toMatchObject({ phase: 'unauthorized', authStep: 'code' });
    await engine.stop();
  });

  it('moves from a login code to a two-step verification password', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.authorized = false;
    transport.submitCode = async () => 'password-required';
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);
    await engine.requestCode('+79991234567');
    await engine.submitCode('22222');
    expect(engine.snapshot().authStep).toBe('password');
    await engine.submitPassword('correct');
    expect(engine.snapshot().phase).toBe('ready');
    await engine.stop();
  });

  it('rejects sign-up without leaving the existing-account login flow', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.authorized = false;
    transport.submitCode = async () => 'sign-up-required';
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);
    await engine.requestCode('+79991234567');
    await engine.submitCode('99999');
    expect(engine.snapshot()).toMatchObject({
      phase: 'unauthorized',
      authStep: 'code',
      error: 'TeleVecha signs in existing accounts only.',
    });
    await engine.stop();
  });

  it('uses compatible cached messages without requesting history again', async () => {
    const store = new MemoryStore();
    store.messages = [{ ...dialog.topMessage!, cacheEpoch: 0 }];
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    await engine.selectChat(peer.id);
    expect(transport.historyCalls).toEqual([]);
    expect(engine.snapshot().messages).toEqual([store.messages[0]]);
    expect(engine.snapshot().loadingMessages).toBe(false);
    await engine.stop();
  });

  it('keeps a partial cached conversation eligible for older-history requests', async () => {
    const store = new MemoryStore();
    store.messages = Array.from({ length: 30 }, (_, index) => ({
      ...dialog.topMessage!,
      id: 971 + index,
      text: `Cached message ${971 + index}`,
      cacheEpoch: 0,
    }));
    const transport = new FakeTransport();
    transport.history.set(971, {
      messages: [{ ...dialog.topMessage!, id: 970, text: 'Older message' }],
      hasOlder: true,
      nextBeforeMessageId: 970,
    });
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    await engine.selectChat(peer.id);
    expect(engine.snapshot().hasOlderMessages).toBe(true);
    await engine.loadOlderMessages();

    expect(transport.historyCalls).toEqual([971]);
    expect(engine.snapshot().messages[0]).toMatchObject({ id: 970, text: 'Older message' });
    await engine.stop();
  });

  it('loads an empty active history after Telegram connects', async () => {
    const store = new MemoryStore();
    store.cursor = currentCursor;
    store.lastPeerId = peer.id;
    store.messages = [];
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);

    expect(engine.snapshot()).toMatchObject({
      activePeerId: peer.id,
      online: true,
      historyError: undefined,
    });
    expect(engine.snapshot().messages).toEqual([
      expect.objectContaining({ id: dialog.topMessage?.id, text: dialog.topMessage?.text }),
    ]);
    expect(transport.historyCalls).toEqual([undefined]);
    await engine.stop();
  });

  it('loads shared-media counts for the restored active chat without reselecting it', async () => {
    const cachedMessage: CachedMessage = {
      ...dialog.topMessage!,
      cacheEpoch: 0,
    };
    const store = new MemoryStore();
    store.cursor = currentCursor;
    store.dialogs = [{ ...dialog, topMessage: cachedMessage, cacheEpoch: 0 }];
    store.messages = [cachedMessage];
    store.lastPeerId = peer.id;
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);

    await vi.waitFor(() =>
      expect(engine.snapshot().sharedMediaCounts).toEqual({
        ...sharedCounts(0),
        photos: 12,
        files: 3,
        links: 4,
      }),
    );
    expect(transport.sharedMediaCalls).toBe(1);
    await engine.stop();
  });

  it('keeps remembered cached history pageable after startup reconciliation', async () => {
    const store = new MemoryStore();
    store.cursor = currentCursor;
    store.lastPeerId = peer.id;
    store.messages = Array.from({ length: 30 }, (_, index) => ({
      ...dialog.topMessage!,
      id: 971 + index,
      text: `Remembered message ${971 + index}`,
      cacheEpoch: 0,
    }));
    const transport = new FakeTransport();
    transport.history.set(971, {
      messages: [{ ...dialog.topMessage!, id: 970, text: 'Older remembered message' }],
      hasOlder: true,
      nextBeforeMessageId: 970,
    });
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);
    expect(engine.snapshot()).toMatchObject({
      activePeerId: peer.id,
      hasOlderMessages: true,
    });
    await engine.loadOlderMessages();

    expect(transport.historyCalls).toEqual([undefined, 971]);
    expect(engine.snapshot().messages.find(({ id }) => id === 970)).toMatchObject({
      id: 970,
      text: 'Older remembered message',
    });
    await engine.stop();
  });

  it('does no transport or cache work when the loaded active chat is selected again', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await vi.waitFor(() => expect(transport.sharedMediaCalls).toBe(1));
    const messagesBefore = engine.snapshot().messages;
    const historyCallsBefore = [...transport.historyCalls];
    const readCallsBefore = [...transport.readCalls];

    await engine.selectChat(peer.id);

    expect(engine.snapshot().messages).toBe(messagesBefore);
    expect(transport.historyCalls).toEqual(historyCallsBefore);
    expect(transport.readCalls).toEqual(readCallsBefore);
    expect(transport.sharedMediaCalls).toBe(1);
    await engine.stop();
  });

  it('switches back to an in-memory conversation without clearing or reloading it', async () => {
    const secondPeer: TelegramPeer = { id: 'peer-2', kind: 'group' };
    const secondMessage: TelegramMessage = {
      ...dialog.topMessage!,
      id: 20,
      peerId: secondPeer.id,
      senderId: secondPeer.id,
      text: 'Second conversation',
    };
    const secondDialog: TelegramDialog = {
      ...dialog,
      peer: secondPeer,
      title: 'Second',
      topMessageId: secondMessage.id,
      topMessage: secondMessage,
    };
    class TwoChatTransport extends FakeTransport {
      override async getDialogs() {
        return { dialogs: [dialog, secondDialog] };
      }
      override async getHistory(target: TelegramPeer) {
        this.historyCalls.push(undefined);
        return {
          messages: [target.id === peer.id ? dialog.topMessage! : secondMessage],
          hasOlder: false,
        };
      }
    }
    const store = new MemoryStore();
    const transport = new TwoChatTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    const firstMessages = engine.snapshot().messages;
    await engine.selectChat(secondPeer.id);
    await engine.selectChat(peer.id);
    await vi.waitFor(() => expect(store.lastPeerId).toBe(peer.id));

    expect(transport.historyCalls).toHaveLength(2);
    expect(engine.snapshot().messages).toBe(firstMessages);
    expect(engine.snapshot().loadingMessages).toBe(false);
    await engine.stop();
  });

  it('ignores cached messages from an obsolete cache epoch', async () => {
    const store = new MemoryStore();
    store.epoch = 3;
    store.messages = [{ ...dialog.topMessage!, text: 'Stale cache', cacheEpoch: 2 }];
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    await engine.selectChat(peer.id);
    expect(transport.historyCalls).toEqual([undefined]);
    expect(engine.snapshot().messages[0]?.text).toBe('Current message');
    await engine.stop();
  });

  it('does not let a slow chat selection overwrite a newer selection', async () => {
    const secondPeer: TelegramPeer = { id: 'peer-2', kind: 'group' };
    const secondDialog: TelegramDialog = {
      ...dialog,
      peer: secondPeer,
      title: 'Second',
      topMessageId: 9,
      topMessage: { ...dialog.topMessage!, id: 9, peerId: secondPeer.id, text: 'Second message' },
    };
    const firstHistory = deferred<HistoryPage>();
    const secondHistory = deferred<HistoryPage>();
    class RaceTransport extends FakeTransport {
      override async getDialogs() {
        return { dialogs: [dialog, secondDialog] };
      }
      override async getHistory(target: TelegramPeer) {
        return target.id === peer.id ? firstHistory.promise : secondHistory.promise;
      }
    }
    const store = new MemoryStore();
    const transport = new RaceTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    const selectingFirst = engine.selectChat(peer.id);
    await vi.waitFor(() => expect(engine.snapshot().activePeerId).toBe(peer.id));
    const selectingSecond = engine.selectChat(secondPeer.id);
    secondHistory.resolve({ messages: [secondDialog.topMessage!], hasOlder: false });
    await selectingSecond;
    firstHistory.resolve({ messages: [dialog.topMessage!], hasOlder: false });
    await selectingFirst;

    expect(engine.snapshot().activePeerId).toBe(secondPeer.id);
    expect(engine.snapshot().messages.map(({ text }) => text)).toEqual(['Second message']);
    expect(store.lastPeerId).toBe(secondPeer.id);
    await engine.stop();
  });

  it('coalesces concurrent downloads and serves later requests from the blob cache', async () => {
    const media = deferred<Blob>();
    class SlowMediaTransport extends FakeTransport {
      override async downloadMedia() {
        this.downloadMediaCalls += 1;
        return media.promise;
      }
    }
    const store = new MemoryStore();
    const transport = new SlowMediaTransport();
    const engine = new MessagingEngine(transport, store);
    const message = dialog.topMessage!;

    const first = engine.downloadMedia(message);
    const second = engine.downloadMedia(message);
    await vi.waitFor(() => expect(transport.downloadMediaCalls).toBe(1));
    const blob = new Blob(['cached']);
    media.resolve(blob);
    expect(await first).toBe(blob);
    expect(await second).toBe(blob);
    expect(await engine.downloadMedia(message)).toBe(blob);
    expect(transport.downloadMediaCalls).toBe(1);
  });

  it('caches custom emoji documents across repeated renders', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);

    const first = await engine.downloadCustomEmoji('99');
    const second = await engine.downloadCustomEmoji('99');

    expect(first.type).toBe('image/webp');
    expect(second).toBe(first);
    expect(transport.downloadCustomEmojiCalls).toBe(1);
    expect(store.blobs.has('custom-emoji:99')).toBe(true);
  });

  it('refreshes message metadata and retries a failed media download once', async () => {
    class ExpiredMediaTransport extends FakeTransport {
      override async downloadMedia() {
        this.downloadMediaCalls += 1;
        if (this.downloadMediaCalls === 1) throw new Error('expired file reference');
        return new Blob(['refreshed']);
      }
    }
    const store = new MemoryStore();
    const transport = new ExpiredMediaTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    const result = await engine.downloadMedia(dialog.topMessage!);
    expect(result.size).toBeGreaterThan(0);
    expect(transport.downloadMediaCalls).toBe(2);
    expect(transport.historyCalls).toEqual([undefined]);
    await engine.stop();
  });

  it('serializes live updates and applies new, edited, and deleted messages in order', async () => {
    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    const message = { ...dialog.topMessage!, id: 8, text: 'New' };

    transport.emit({ type: 'new-message', pts: 21, ptsCount: 1, message });
    transport.emit({
      type: 'edit-message',
      pts: 22,
      ptsCount: 1,
      message: { ...message, text: 'Edited' },
    });
    transport.emit({
      type: 'delete-messages',
      pts: 23,
      ptsCount: 1,
      peerId: peer.id,
      messageIds: [8],
    });

    await vi.waitFor(() => expect(store.cursor?.pts).toBe(23));
    expect(engine.snapshot().messages.some(({ id }) => id === 8)).toBe(false);
    expect(store.messages.some(({ id }) => id === 8)).toBe(false);
    await engine.stop();
  });

  it('recovers from a gap instead of applying an out-of-order live update', async () => {
    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    const initialDifferenceCalls = transport.differenceCalls;

    transport.emit({
      type: 'new-message',
      pts: 30,
      ptsCount: 1,
      message: { ...dialog.topMessage!, id: 30, text: 'Out of order' },
    });

    await vi.waitFor(() => expect(transport.differenceCalls).toBe(initialDifferenceCalls + 1));
    expect(store.messages.some(({ id }) => id === 30)).toBe(false);
    expect(engine.snapshot().sync).toBe('current');
    await engine.stop();
  });

  it('publishes photo captions and reactions recovered through a pts gap', async () => {
    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    const photo: TelegramMessage = {
      ...dialog.topMessage!,
      id: 8,
      text: 'Recovered photo caption',
      media: { kind: 'photo', name: 'photo.jpg', mimeType: 'image/jpeg' },
      reactions: [{ emoji: '👍', count: 1, chosen: false }],
    };
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: 29 },
      updates: [{ type: 'new-message', pts: 29, ptsCount: 9, message: photo }],
    };

    transport.emit({
      type: 'new-message',
      pts: 30,
      ptsCount: 1,
      message: { ...photo, id: 9, text: 'Trigger gap recovery' },
    });

    await vi.waitFor(() =>
      expect(engine.snapshot().messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 8, text: 'Recovered photo caption' }),
        ]),
      ),
    );
    expect(engine.snapshot().messages.find(({ id }) => id === 8)).toMatchObject({
      media: { kind: 'photo' },
      reactions: [{ emoji: '👍', count: 1 }],
    });
    await engine.stop();
  });

  it('publishes deletions recovered through a pts gap', async () => {
    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: 29 },
      updates: [
        {
          type: 'delete-messages',
          pts: 29,
          ptsCount: 9,
          peerId: peer.id,
          messageIds: [7],
        },
      ],
    };

    transport.emit({
      type: 'new-message',
      pts: 30,
      ptsCount: 1,
      message: { ...dialog.topMessage!, id: 30 },
    });

    await vi.waitFor(() => expect(engine.snapshot().messages).toEqual([]));
    expect(store.messages).toEqual([]);
    await engine.stop();
  });

  it('restores the previous dialog preview after deleting its top message', async () => {
    const previous = { ...dialog.topMessage!, id: 6, text: 'Previous message' };
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.history.set(0, {
      messages: [previous, dialog.topMessage!],
      hasOlder: false,
    });
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    await engine.deleteMessage(peer, 7, true);

    expect(engine.snapshot().messages.map(({ id }) => id)).toEqual([6]);
    expect(engine.snapshot().dialogs[0]).toMatchObject({
      topMessageId: 6,
      topMessage: { text: 'Previous message' },
    });
    await engine.stop();
  });

  it('prevents concurrent older-history requests', async () => {
    const older = deferred<HistoryPage>();
    class SlowHistoryTransport extends FakeTransport {
      override async getHistory(target: TelegramPeer, limit: number, beforeMessageId?: number) {
        if (beforeMessageId) {
          this.historyCalls.push(beforeMessageId);
          return older.promise;
        }
        return super.getHistory(target, limit, beforeMessageId);
      }
    }
    const store = new MemoryStore();
    const transport = new SlowHistoryTransport();
    transport.history.set(0, { messages: [dialog.topMessage!], hasOlder: true });
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    const first = engine.loadOlderMessages();
    const second = engine.loadOlderMessages();
    await vi.waitFor(() => expect(transport.historyCalls).toEqual([undefined, 7]));
    older.resolve({ messages: [], hasOlder: false });
    await Promise.all([first, second]);
    expect(transport.historyCalls).toEqual([undefined, 7]);
    expect(engine.snapshot().loadingOlderMessages).toBe(false);
    await engine.stop();
  });

  it('keeps a failed send durable and records the attempted random id once', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.setDraft(peer.id, 'Queued');
    await engine.sendDraft(peer, 'Queued');

    expect(engine.snapshot().pending).toHaveLength(1);
    expect(engine.snapshot().pending[0]).toMatchObject({
      text: 'Queued',
      attempts: 1,
      lastError: 'connection lost',
    });
    expect(store.outbox).toHaveLength(1);
    expect(transport.sentRandomIds).toHaveLength(1);
    expect(engine.snapshot().drafts[peer.id]).toBe('');
    expect(engine.snapshot()).toMatchObject({
      error: undefined,
      operationError: expect.stringContaining('remains queued'),
    });
    await engine.stop();
  });

  it('accepts a retry as soon as the failed send becomes actionable', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    let retry: Promise<void> | undefined;
    const unsubscribe = engine.subscribe((snapshot) => {
      const failed = snapshot.pending.find(({ lastError }) => Boolean(lastError));
      if (failed && !retry) retry = engine.retryPendingSend(failed.id);
    });

    await engine.setDraft(peer.id, 'Retry immediately');
    await engine.sendDraft(peer, 'Retry immediately');
    expect(retry).toBeDefined();
    await retry;

    expect(engine.snapshot().pending[0]).toMatchObject({
      attempts: 2,
      lastError: 'connection lost',
    });
    expect(transport.sentRandomIds).toHaveLength(2);
    unsubscribe();
    await engine.stop();
  });

  it('delivers a WebP attachment as a sticker and preserves its caption', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    let releaseUpload!: () => void;
    transport.holdFileSend = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    const sending = engine.sendAttachment(
      peer,
      new File(['sticker'], 'sticker.webp', { type: 'image/webp' }),
      'caption',
    );
    await vi.waitFor(() =>
      expect(engine.snapshot().pending[0]?.attachment).toMatchObject({
        name: 'sticker.webp',
        asSticker: true,
      }),
    );
    releaseUpload();
    await sending;
    expect(engine.snapshot().messages.at(-1)?.text).toBe('caption');
    await engine.stop();
  });

  it('passes a replacement file through an outgoing message edit', async () => {
    const engine = new MessagingEngine(new FakeTransport(), new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    await engine.editMessage(peer, 7, 'Replacement caption', undefined, {
      file: new File(['replacement'], 'replacement.png', { type: 'image/png' }),
      sendAs: 'file',
    });

    expect(engine.snapshot().messages.at(-1)).toMatchObject({
      text: 'Replacement caption',
      media: { kind: 'file', name: 'replacement.png' },
    });
    await engine.stop();
  });

  it('notifies subscribers immediately and stops after unsubscribe', async () => {
    const engine = new MessagingEngine(new FakeTransport(), new MemoryStore());
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    await engine.start(credentials);
    expect(listener).toHaveBeenCalledOnce();
    await engine.stop();
  });

  it('times out a hung connection, disconnects it, and reports a fatal transport error', async () => {
    vi.useFakeTimers();
    try {
      class HangingTransport extends FakeTransport {
        override async connect() {
          await new Promise<void>(() => undefined);
        }
      }
      const transport = new HangingTransport();
      const engine = new MessagingEngine(transport, new MemoryStore());
      const starting = engine.start(credentials);
      await vi.advanceTimersByTimeAsync(15_001);
      await starting;

      expect(transport.disconnectCalls).toBe(1);
      expect(engine.snapshot()).toMatchObject({
        phase: 'error',
        error:
          'Could not start TeleVecha. Telegram WebSocket connection timed out after 15 seconds.',
      });
      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a retry with startup and keeps stop pending until startup quiesces', async () => {
    const connection = deferred<void>();
    class SlowConnectTransport extends FakeTransport {
      connectCalls = 0;

      override async connect() {
        this.connectCalls += 1;
        await connection.promise;
      }
    }
    const transport = new SlowConnectTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());

    const starting = engine.start(credentials);
    await vi.waitFor(() => expect(transport.connectCalls).toBe(1));
    const retrying = engine.retrySync();
    expect(transport.connectCalls).toBe(1);

    let stopped = false;
    const stopping = engine.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    connection.resolve();
    await Promise.all([starting, retrying, stopping]);
    expect(transport.connectCalls).toBe(1);
    expect(engine.snapshot()).toMatchObject({ phase: 'idle', online: false });
  });

  it('does not let a retry queued behind stop reacquire the transport', async () => {
    const disconnection = deferred<void>();
    const transport = new FakeTransport();
    const connect = vi.spyOn(transport, 'connect');
    transport.disconnect = async () => disconnection.promise;
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);

    const stopping = engine.stop();
    const retrying = engine.retrySync();
    disconnection.resolve();
    await Promise.all([stopping, retrying]);

    expect(connect).toHaveBeenCalledOnce();
    expect(engine.snapshot()).toMatchObject({ phase: 'idle', online: false });
  });

  it('does not bypass a denied single-tab lease when sync is retried', async () => {
    vi.useFakeTimers();
    const request = vi.fn(
      async (_name: string, _options: unknown, callback: (lock: undefined) => Promise<void>) =>
        callback(undefined),
    );
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { locks: { request } });
    try {
      const transport = new FakeTransport();
      const connect = vi.spyOn(transport, 'connect');
      const engine = new MessagingEngine(transport, new MemoryStore());

      const starting = engine.start(credentials);
      await vi.runAllTimersAsync();
      await starting;
      expect(engine.snapshot()).toMatchObject({
        phase: 'error',
        error: 'TeleVecha is already open in another tab.',
      });

      const retrying = engine.retrySync();
      await vi.runAllTimersAsync();
      await retrying;
      expect(connect).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(4);
      await engine.stop();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('does not publish shared-media counts returned for a chat that is no longer active', async () => {
    const secondPeer: TelegramPeer = { id: 'peer-2', kind: 'group' };
    const secondDialog: TelegramDialog = {
      ...dialog,
      peer: secondPeer,
      title: 'Second',
      topMessage: { ...dialog.topMessage!, peerId: secondPeer.id },
    };
    const firstCounts = deferred<SharedMediaCounts>();
    const secondCounts = deferred<SharedMediaCounts>();
    class SlowCountsTransport extends FakeTransport {
      override async getDialogs() {
        return { dialogs: [dialog, secondDialog] };
      }
      override async getSharedMediaCounts(target: TelegramPeer) {
        return target.id === peer.id ? firstCounts.promise : secondCounts.promise;
      }
    }
    const engine = new MessagingEngine(new SlowCountsTransport(), new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await engine.selectChat(secondPeer.id);
    const expectedCounts = { ...sharedCounts(0), photos: 2, files: 3, links: 4 };
    secondCounts.resolve(expectedCounts);
    firstCounts.resolve(sharedCounts(100));

    await vi.waitFor(() => expect(engine.snapshot().sharedMediaCounts).toEqual(expectedCounts));
    await engine.stop();
  });

  it('retries shared-media counts without requiring the chat to be selected again', async () => {
    vi.useFakeTimers();
    try {
      const expectedCounts = { ...sharedCounts(0), photos: 8, videos: 3, links: 5 };
      class FlakyCountsTransport extends FakeTransport {
        countRequests = 0;

        override async getSharedMediaCounts() {
          this.countRequests += 1;
          if (this.countRequests === 1) throw new Error('temporary count failure');
          return expectedCounts;
        }
      }

      const transport = new FlakyCountsTransport();
      const engine = new MessagingEngine(transport, new MemoryStore());
      await engine.start(credentials);
      await engine.selectChat(peer.id);
      await Promise.resolve();
      await Promise.resolve();

      expect(transport.countRequests).toBe(1);
      expect(engine.snapshot().sharedMediaCounts).toBeUndefined();

      await vi.advanceTimersByTimeAsync(500);

      expect(transport.countRequests).toBe(2);
      expect(engine.snapshot().sharedMediaCounts).toEqual(expectedCounts);
      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a shared-media count request that never settles', async () => {
    vi.useFakeTimers();
    try {
      const stuckRequest = deferred<SharedMediaCounts>();
      const expectedCounts = { ...sharedCounts(0), photos: 21, voice: 7 };
      class StuckCountsTransport extends FakeTransport {
        countRequests = 0;

        override getSharedMediaCounts() {
          this.countRequests += 1;
          return this.countRequests === 1 ? stuckRequest.promise : Promise.resolve(expectedCounts);
        }
      }

      const transport = new StuckCountsTransport();
      const engine = new MessagingEngine(transport, new MemoryStore());
      await engine.start(credentials);
      await engine.selectChat(peer.id);

      expect(transport.countRequests).toBe(1);
      await vi.advanceTimersByTimeAsync(5_500);

      expect(transport.countRequests).toBe(2);
      expect(engine.snapshot().sharedMediaCounts).toEqual(expectedCounts);
      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the message loading state after a history failure without killing the session', async () => {
    class FailedHistoryTransport extends FakeTransport {
      override async getHistory(): Promise<HistoryPage> {
        throw new Error('history unavailable');
      }
    }
    const engine = new MessagingEngine(new FailedHistoryTransport(), new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    expect(engine.snapshot()).toMatchObject({
      phase: 'ready',
      loadingMessages: false,
      historyError: 'Could not load Mira. history unavailable',
    });
    await engine.stop();
  });

  it('serializes draft persistence so an older slow write cannot replace newer text', async () => {
    const firstWrite = deferred<void>();
    const firstWriteStarted = deferred<void>();
    class SlowDraftStore extends MemoryStore {
      private writes = 0;

      override async saveDraft(peerId: string, text: string, revision = 0) {
        this.writes += 1;
        if (this.writes === 1) {
          firstWriteStarted.resolve();
          await firstWrite.promise;
        }
        await super.saveDraft(peerId, text, revision);
      }
    }
    const store = new SlowDraftStore();
    const engine = new MessagingEngine(new FakeTransport(), store);

    const savingOld = engine.setDraft(peer.id, 'old');
    await firstWriteStarted.promise;
    const savingNew = engine.setDraft(peer.id, 'new');
    firstWrite.resolve();
    await Promise.all([savingOld, savingNew]);

    expect(store.drafts[peer.id]).toBe('new');
  });

  it('hydrates a restored draft revision so sending it clears durable storage', async () => {
    const store = new MemoryStore();
    await store.saveDraft(peer.id, 'Restored draft', 7);
    const transport = new FakeTransport();
    transport.failSend = true;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    expect(engine.snapshot().drafts[peer.id]).toBe('Restored draft');
    await engine.sendDraft(peer, 'Restored draft');

    expect(store.outbox).toEqual([expect.objectContaining({ text: 'Restored draft' })]);
    expect(store.drafts).toEqual({});
    await engine.stop();

    const restarted = new MessagingEngine(new FakeTransport(), store);
    await restarted.start(credentials);
    expect(restarted.snapshot().drafts).toEqual({});
    await restarted.stop();
  });

  it('queues captured text behind a pending draft write while preserving newer typing', async () => {
    const firstWrite = deferred<void>();
    const firstWriteStarted = deferred<void>();
    class SlowDraftStore extends MemoryStore {
      private writes = 0;

      override async saveDraft(peerId: string, text: string, revision = 0) {
        this.writes += 1;
        if (this.writes === 1) {
          firstWriteStarted.resolve();
          await firstWrite.promise;
        }
        await super.saveDraft(peerId, text, revision);
      }
    }
    const store = new SlowDraftStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    const savingCaptured = engine.setDraft(peer.id, 'Captured A');
    await firstWriteStarted.promise;
    const sendingCaptured = engine.sendDraft(peer, 'Captured A');
    const savingNewer = engine.setDraft(peer.id, 'Newer B');
    expect(engine.snapshot().drafts[peer.id]).toBe('Newer B');
    firstWrite.resolve();
    await Promise.all([savingCaptured, savingNewer, sendingCaptured]);

    expect(store.outbox).toEqual([expect.objectContaining({ text: 'Captured A' })]);
    expect(store.drafts).toEqual({ [peer.id]: 'Newer B' });
    expect(engine.snapshot().drafts[peer.id]).toBe('Newer B');
    await engine.stop();
  });

  it('does not enqueue the same draft twice when send is triggered concurrently', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.setDraft(peer.id, 'Only once');

    await Promise.all([engine.sendDraft(peer, 'Only once'), engine.sendDraft(peer, 'Only once')]);

    expect(transport.sentRandomIds).toHaveLength(1);
    expect(store.outbox).toHaveLength(0);
    await engine.stop();
  });

  it('preserves an identically retyped draft while the older send is being reserved', async () => {
    const reservationStarted = deferred<void>();
    const releaseReservation = deferred<void>();
    class HoldingStore extends MemoryStore {
      override async commitOutbox(sends: PendingSend | PendingSend[], draft?: DraftReservation) {
        if (draft) {
          reservationStarted.resolve();
          await releaseReservation.promise;
        }
        await super.commitOutbox(sends, draft);
      }
    }
    const store = new HoldingStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.setDraft(peer.id, 'Same text');

    const sending = engine.sendDraft(peer, 'Same text');
    await reservationStarted.promise;
    const savingRetyped = engine.setDraft(peer.id, 'Same text');
    releaseReservation.resolve();
    await Promise.all([sending, savingRetyped]);

    expect(store.drafts).toEqual({ [peer.id]: 'Same text' });
    expect(engine.snapshot().drafts[peer.id]).toBe('Same text');
    await engine.stop();
  });

  it('allows an explicitly sent identical retyped draft while the first send is pending', async () => {
    const firstReservationStarted = deferred<void>();
    const releaseFirstReservation = deferred<void>();
    class HoldingStore extends MemoryStore {
      reservations = 0;

      override async commitOutbox(sends: PendingSend | PendingSend[], draft?: DraftReservation) {
        if (draft) {
          this.reservations += 1;
          if (this.reservations === 1) {
            firstReservationStarted.resolve();
            await releaseFirstReservation.promise;
          }
        }
        await super.commitOutbox(sends, draft);
      }
    }
    const store = new HoldingStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.setDraft(peer.id, 'Same text');

    const sendingFirst = engine.sendDraft(peer, 'Same text');
    await firstReservationStarted.promise;
    const savingSecond = engine.setDraft(peer.id, 'Same text');
    const sendingSecond = engine.sendDraft(peer, 'Same text');
    releaseFirstReservation.resolve();
    await Promise.all([sendingFirst, savingSecond, sendingSecond]);

    expect(store.reservations).toBe(2);
    expect(store.outbox.filter(({ text }) => text === 'Same text')).toHaveLength(2);
    expect(transport.sentRandomIds).toHaveLength(1);
    expect(store.drafts).toEqual({});
    await engine.stop();
  });

  it('queues rapid distinct sends for one peer behind the active reservation', async () => {
    const firstReservationStarted = deferred<void>();
    const releaseFirstReservation = deferred<void>();
    class HoldingStore extends MemoryStore {
      reservations = 0;

      override async commitOutbox(sends: PendingSend | PendingSend[], draft?: DraftReservation) {
        if (draft) {
          this.reservations += 1;
          if (this.reservations === 1) {
            firstReservationStarted.resolve();
            await releaseFirstReservation.promise;
          }
        }
        await super.commitOutbox(sends, draft);
      }
    }
    const store = new HoldingStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.setDraft(peer.id, 'First A');

    const sendingFirst = engine.sendDraft(peer, 'First A');
    await firstReservationStarted.promise;
    const savingSecond = engine.setDraft(peer.id, 'Second B');
    const sendingSecond = engine.sendDraft(peer, 'Second B');
    releaseFirstReservation.resolve();
    await Promise.all([sendingFirst, savingSecond, sendingSecond]);

    expect(store.reservations).toBe(2);
    expect(new Set(store.outbox.map(({ text }) => text))).toEqual(new Set(['First A', 'Second B']));
    expect(transport.sentRandomIds).toHaveLength(1);
    expect(store.drafts).toEqual({});
    await engine.stop();
  });

  it('sends an immutable captured draft and preserves text typed while it is reserved', async () => {
    const reservationStarted = deferred<void>();
    const releaseReservation = deferred<void>();
    class HoldingStore extends MemoryStore {
      override async commitOutbox(sends: PendingSend | PendingSend[], draft?: DraftReservation) {
        if (draft) {
          reservationStarted.resolve();
          await releaseReservation.promise;
        }
        await super.commitOutbox(sends, draft);
      }
    }
    const store = new HoldingStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.setDraft(peer.id, 'Captured text');
    const reply: TelegramReplyTarget = { messageId: 7, quoteText: 'Original quote' };
    const formats: TelegramTextFormat[] = [{ offset: 0, length: 8, kind: 'bold' }];

    const sending = engine.sendDraft(peer, 'Captured text', reply, formats);
    await reservationStarted.promise;
    const savingNewer = engine.setDraft(peer.id, 'Newer text');
    reply.quoteText = 'Changed quote';
    formats[0]!.length = 2;
    formats.push({ offset: 9, length: 4, kind: 'italic' });
    releaseReservation.resolve();
    await Promise.all([sending, savingNewer]);

    expect(transport.sentReplies).toEqual([{ messageId: 7, quoteText: 'Original quote' }]);
    expect(transport.sentFormats).toEqual([[{ offset: 0, length: 8, kind: 'bold' }]]);
    expect(store.drafts).toEqual({ [peer.id]: 'Newer text' });
    expect(engine.snapshot().drafts[peer.id]).toBe('Newer text');
    await engine.stop();
  });

  it('surfaces a failed draft persistence write without discarding the editable text', async () => {
    class FailedDraftStore extends MemoryStore {
      override async saveDraft() {
        throw new Error('storage unavailable');
      }
    }
    const engine = new MessagingEngine(new FakeTransport(), new FailedDraftStore());

    await expect(engine.setDraft(peer.id, 'Keep editing')).rejects.toThrow('storage unavailable');

    expect(engine.snapshot().drafts[peer.id]).toBe('Keep editing');
    expect(engine.snapshot().operationError).toContain('The draft was not saved to this device.');
  });

  it('refreshes old message metadata around the target before retrying media', async () => {
    const oldMessage = { ...dialog.topMessage!, id: 2, text: 'Old media' };
    class OldMediaTransport extends FakeTransport {
      aroundCalls: number[] = [];

      override async downloadMedia(message: TelegramMessage) {
        this.downloadMediaCalls += 1;
        if (message.text === 'Old media') throw new Error('expired file reference');
        return new Blob(['refreshed']);
      }

      async getHistoryAround(_peer: TelegramPeer, messageId: number) {
        this.aroundCalls.push(messageId);
        return [{ ...oldMessage, text: 'Refreshed old media' }];
      }
    }
    const transport = new OldMediaTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);

    const blob = await engine.downloadMedia(oldMessage);

    expect(blob.size).toBeGreaterThan(0);
    expect(transport.aroundCalls).toEqual([2]);
    expect(transport.downloadMediaCalls).toBe(2);
    await engine.stop();
  });

  it('merges mark-read completion into newer dialog state', async () => {
    const read = deferred<void>();
    const readStarted = deferred<void>();
    class SlowReadTransport extends FakeTransport {
      override async readHistory(target: TelegramPeer, maxMessageId: number) {
        this.readCalls.push({ peer: target, maxMessageId });
        readStarted.resolve();
        await read.promise;
        return {};
      }
    }
    const transport = new SlowReadTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    const markingRead = engine.setActiveConversationVisibility(peer.id, {
      visible: true,
      atBottom: true,
    });
    await readStarted.promise;

    transport.emit({ type: 'mute-changed', peerId: peer.id, muted: true });
    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.muted).toBe(true));
    read.resolve();
    await markingRead;
    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.unreadCount).toBe(0));

    expect(engine.snapshot().dialogs[0]?.muted).toBe(true);
    await engine.stop();
  });

  it('persists live dialog previews and does not count edits as unread messages', async () => {
    const secondPeer: TelegramPeer = { id: 'peer-2', kind: 'user' };
    const secondDialog: TelegramDialog = {
      ...dialog,
      peer: secondPeer,
      title: 'Inactive',
      unreadCount: 4,
      topMessage: { ...dialog.topMessage!, peerId: secondPeer.id },
    };
    class TwoDialogTransport extends FakeTransport {
      override async getDialogs() {
        return { dialogs: [dialog, secondDialog] };
      }
    }
    const store = new MemoryStore();
    const transport = new TwoDialogTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    transport.emit({
      type: 'edit-message',
      pts: 21,
      ptsCount: 1,
      message: { ...secondDialog.topMessage!, text: 'Edited inactive preview' },
    });
    await vi.waitFor(() =>
      expect(engine.snapshot().dialogs.find(({ peer }) => peer.id === secondPeer.id)).toMatchObject(
        {
          unreadCount: 4,
          topMessage: { text: 'Edited inactive preview' },
        },
      ),
    );
    expect(store.dialogs.find(({ peer }) => peer.id === secondPeer.id)).toMatchObject({
      unreadCount: 4,
      topMessage: { text: 'Edited inactive preview' },
    });
    await engine.stop();
  });

  it('counts unique incoming messages when Telegram delivers newest first', async () => {
    const mutedDialog: TelegramDialog = {
      ...dialog,
      unreadCount: 0,
      muted: true,
    };
    class MutedDialogTransport extends FakeTransport {
      override async getDialogs() {
        return { dialogs: [mutedDialog] };
      }
    }
    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new MutedDialogTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    transport.emitBatch({
      updates: [12, 11, 10, 9, 8].map((id, index) => ({
        type: 'new-message' as const,
        pts: 21 + index,
        ptsCount: 1,
        message: { ...dialog.topMessage!, id, text: `Incoming ${id}` },
      })),
    });

    await vi.waitFor(() => expect(store.cursor?.pts).toBe(25));
    expect(engine.snapshot().dialogs[0]).toMatchObject({
      topMessageId: 12,
      unreadCount: 5,
      muted: true,
    });
    await engine.stop();
  });

  it('refreshes unread and mute metadata after an incoming update', async () => {
    const incoming = { ...dialog.topMessage!, id: 8, text: 'Newest incoming message' };
    class AuthoritativeDialogTransport extends FakeTransport {
      async getDialog() {
        return {
          ...dialog,
          topMessageId: incoming.id,
          topMessage: incoming,
          unreadCount: 5,
          muted: true,
        };
      }
    }
    const store = new MemoryStore();
    store.cursor = currentCursor;
    const transport = new AuthoritativeDialogTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    transport.emit({ type: 'new-message', pts: 21, ptsCount: 1, message: incoming });

    await vi.waitFor(() => expect(store.cursor?.pts).toBe(21));
    expect(engine.snapshot().dialogs[0]).toMatchObject({
      topMessageId: 8,
      unreadCount: 5,
      muted: true,
    });
    await engine.stop();
  });

  it('treats typing updates as best effort when the connection is unavailable', async () => {
    const transport = new FakeTransport();
    transport.failTyping = true;
    const engine = new MessagingEngine(transport, new MemoryStore());

    await expect(engine.setTyping(peer, 'typing')).resolves.toBeUndefined();
    expect(transport.typingCalls).toEqual(['typing']);
  });

  it('stops pagination when Telegram repeats a page without advancing the offset', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.history.set(0, { messages: [dialog.topMessage!], hasOlder: true });
    transport.history.set(7, {
      messages: [dialog.topMessage!],
      hasOlder: true,
      nextBeforeMessageId: 7,
    });
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    await engine.loadOlderMessages();
    await engine.loadOlderMessages();

    expect(transport.historyCalls).toEqual([undefined, 7]);
    expect(engine.snapshot().hasOlderMessages).toBe(false);
    await engine.stop();
  });

  it('unsubscribes from transport updates when stopped', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.stop();

    transport.emit({
      type: 'new-message',
      pts: 21,
      ptsCount: 1,
      message: { ...dialog.topMessage!, id: 21, text: 'After stop' },
    });
    await Promise.resolve();
    expect(store.messages.some(({ id }) => id === 21)).toBe(false);
    expect(engine.snapshot().phase).toBe('idle');
  });

  it('merges a slow history response without overwriting a newer live message', async () => {
    const history = deferred<HistoryPage>();
    const historyStarted = deferred<void>();
    class SlowHistoryTransport extends FakeTransport {
      override async getHistory(_peer: TelegramPeer, _limit: number, beforeMessageId?: number) {
        this.historyCalls.push(beforeMessageId);
        historyStarted.resolve();
        return history.promise;
      }
    }
    const store = new MemoryStore();
    const transport = new SlowHistoryTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    const selecting = engine.selectChat(peer.id);
    await historyStarted.promise;
    transport.emit({
      type: 'new-message',
      pts: 21,
      ptsCount: 1,
      message: { ...dialog.topMessage!, id: 8, text: 'Live version' },
    });
    await vi.waitFor(() =>
      expect(store.messages.find(({ id }) => id === 8)?.text).toBe('Live version'),
    );
    history.resolve({
      messages: [dialog.topMessage!, { ...dialog.topMessage!, id: 8, text: 'Stale version' }],
      hasOlder: false,
    });
    await selecting;

    expect(engine.snapshot().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 7 }),
        expect.objectContaining({ id: 8, text: 'Live version' }),
      ]),
    );
    expect(store.messages.find(({ id }) => id === 8)?.text).toBe('Live version');
    await engine.stop();
  });

  it('merges concurrent same-peer message jumps and prefers fetched targets', async () => {
    const first = deferred<TelegramMessage[]>();
    const second = deferred<TelegramMessage[]>();
    class AroundTransport extends FakeTransport {
      aroundCalls: number[] = [];
      async getHistoryAround(_peer: TelegramPeer, messageId: number, _limit: number) {
        this.aroundCalls.push(messageId);
        return messageId === 2 ? first.promise : second.promise;
      }
    }
    const transport = new AroundTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    const openingFirst = engine.openMessage({
      ...dialog.topMessage!,
      id: 2,
      text: '',
    });
    const openingSecond = engine.openMessage({
      ...dialog.topMessage!,
      id: 3,
      text: '',
    });
    await vi.waitFor(() => expect(transport.aroundCalls).toHaveLength(2));
    second.resolve([{ ...dialog.topMessage!, id: 3, text: 'Full second target' }]);
    first.resolve([{ ...dialog.topMessage!, id: 2, text: 'Full first target' }]);
    await Promise.all([openingFirst, openingSecond]);

    expect(engine.snapshot().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 2, text: 'Full first target' }),
        expect.objectContaining({ id: 3, text: 'Full second target' }),
      ]),
    );
    await engine.stop();
  });

  it('resets history offsets when a too-long recovery starts a new epoch', async () => {
    class EpochTransport extends FakeTransport {
      latestLoads = 0;
      override async getHistory(
        _peer: TelegramPeer,
        _limit: number,
        beforeMessageId?: number,
      ): Promise<HistoryPage> {
        this.historyCalls.push(beforeMessageId);
        if (beforeMessageId === 101) {
          return {
            messages: [{ ...dialog.topMessage!, id: 100, text: 'Recovered older' }],
            hasOlder: false,
          };
        }
        this.latestLoads += 1;
        return this.latestLoads === 1
          ? {
              messages: [{ ...dialog.topMessage!, id: 51, text: 'Old epoch' }],
              hasOlder: true,
              nextBeforeMessageId: 51,
            }
          : {
              messages: [{ ...dialog.topMessage!, id: 101, text: 'New epoch' }],
              hasOlder: true,
              nextBeforeMessageId: 101,
            };
      }
    }
    const store = new MemoryStore();
    const transport = new EpochTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: 121 },
      updates: [],
    };

    transport.emit({ type: 'too-long' });
    await vi.waitFor(() => expect(store.epoch).toBe(1));
    await vi.waitFor(() => expect(engine.snapshot().messages[0]?.id).toBe(101));
    await engine.loadOlderMessages();

    expect(transport.historyCalls).toEqual([undefined, undefined, 101]);
    expect(engine.snapshot().messages.map(({ id }) => id)).toEqual([100, 101]);
    await engine.stop();
  });

  it('recovers a channel gap before applying the triggering live update', async () => {
    const channelPeer: TelegramPeer = { id: 'c:42', kind: 'channel', accessHash: '42' };
    const channelDialog: TelegramDialog = {
      ...dialog,
      peer: channelPeer,
      channelPts: 10,
      topMessage: { ...dialog.topMessage!, peerId: channelPeer.id },
    };
    class ChannelTransport extends FakeTransport {
      override async getDialogs() {
        return { dialogs: [channelDialog] };
      }
      override async getChannelDifference(): Promise<ChannelDifferenceResult> {
        return {
          type: 'complete',
          pts: 12,
          updates: [
            {
              type: 'new-message',
              pts: 12,
              ptsCount: 0,
              channelScoped: true,
              message: {
                ...dialog.topMessage!,
                id: 8,
                peerId: channelPeer.id,
                text: 'Recovered channel message',
              },
            },
          ],
        };
      }
    }
    const store = new MemoryStore();
    const transport = new ChannelTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    transport.emit({
      type: 'new-message',
      pts: 13,
      ptsCount: 1,
      channelScoped: true,
      message: {
        ...dialog.topMessage!,
        id: 9,
        peerId: channelPeer.id,
        text: 'Triggering channel message',
      },
    });

    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.channelPts).toBe(13));
    expect(store.messages.map(({ id }) => id).sort((left, right) => left - right)).toEqual([8, 9]);
    await engine.stop();
  });

  it('creates a correctly typed dialog for the first live channel message', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    transport.emit({
      type: 'new-message',
      pts: 1,
      ptsCount: 1,
      channelScoped: true,
      message: {
        ...dialog.topMessage!,
        id: 1,
        peerId: 'c:99',
        text: 'First channel message',
      },
    });

    await vi.waitFor(() =>
      expect(engine.snapshot().dialogs.find(({ peer }) => peer.id === 'c:99')).toMatchObject({
        peer: { kind: 'channel' },
        channelPts: 1,
        unreadCount: 1,
      }),
    );
    expect(store.messages).toEqual([
      expect.objectContaining({ peerId: 'c:99', text: 'First channel message' }),
    ]);
    await engine.stop();
  });

  it('does not let an older read RPC clear a newer unread message', async () => {
    const reading = deferred<void>();
    const readStarted = deferred<void>();
    class SlowReadTransport extends FakeTransport {
      override async readHistory(target: TelegramPeer, maxMessageId: number) {
        this.readCalls.push({ peer: target, maxMessageId });
        readStarted.resolve();
        await reading.promise;
        return {};
      }
    }
    const transport = new SlowReadTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    const markingRead = engine.setActiveConversationVisibility(peer.id, {
      visible: true,
      atBottom: true,
    });
    await readStarted.promise;
    await engine.setActiveConversationVisibility(peer.id, { visible: false, atBottom: false });
    transport.emit({
      type: 'new-message',
      pts: 21,
      ptsCount: 1,
      message: { ...dialog.topMessage!, id: 8, text: 'New while reading' },
    });
    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.unreadCount).toBe(2));
    reading.resolve();
    await markingRead;

    expect(engine.snapshot().dialogs[0]).toMatchObject({
      readInboxMaxId: 7,
      unreadCount: 2,
    });
    await engine.stop();
  });

  it('keeps cached conversations usable offline and queues sends without delivering', async () => {
    class OfflineTransport extends FakeTransport {
      override async connect() {
        throw new Error('offline');
      }
    }
    const store = new MemoryStore();
    store.accountId = 'account-1';
    store.dialogs = [{ ...dialog, cacheEpoch: 0 }];
    store.messages = [{ ...dialog.topMessage!, cacheEpoch: 0 }];
    store.drafts = { [peer.id]: 'Queued offline' };
    const transport = new OfflineTransport();
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);
    expect(engine.snapshot()).toMatchObject({ phase: 'ready', sync: 'stale', online: false });
    await engine.selectChat(peer.id);
    expect(engine.snapshot().messages).toHaveLength(1);
    await engine.sendDraft(peer, 'Queued offline');

    expect(transport.sentRandomIds).toEqual([]);
    expect(store.outbox).toEqual([
      expect.objectContaining({ text: 'Queued offline', accountId: 'account-1', attempts: 0 }),
    ]);
    await engine.stop();
  });

  it('quarantines an old account outbox before synchronizing a different account', async () => {
    const store = new MemoryStore();
    store.accountId = 'account-a';
    store.dialogs = [{ ...dialog, cacheEpoch: 0 }];
    store.outbox = [
      {
        id: 'old-account-send',
        accountId: 'account-a',
        peer,
        text: 'old account',
        randomId: 'old-account-send',
        createdAt: 1,
        attempts: 0,
      },
    ];
    const transport = new FakeTransport();
    transport.accountId = 'account-b';
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);

    expect(transport.sentRandomIds).toEqual([]);
    expect(engine.snapshot().pending).toEqual([]);
    expect(store.accountId).toBe('account-b');
    expect(store.outbox).toEqual([
      expect.objectContaining({ id: 'old-account-send', accountId: 'account-a' }),
    ]);
    await engine.stop();
  });

  it('rejects delayed old-account history for a same-id peer after account switch', async () => {
    const oldHistoryStarted = deferred<void>();
    const oldHistory = deferred<HistoryPage>();
    class AccountSwitchHistoryTransport extends FakeTransport {
      firstHistory = true;

      override async getHistory(target: TelegramPeer, limit: number, beforeMessageId?: number) {
        if (this.firstHistory) {
          this.firstHistory = false;
          oldHistoryStarted.resolve(undefined);
          return oldHistory.promise;
        }
        return super.getHistory(target, limit, beforeMessageId);
      }
    }
    const store = new MemoryStore();
    store.accountId = 'account-a';
    const transport = new AccountSwitchHistoryTransport();
    transport.accountId = 'account-a';
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    const selecting = engine.selectChat(peer.id);
    await oldHistoryStarted.promise;
    transport.emit({ type: 'connection-state', connected: false });
    await vi.waitFor(() => expect(engine.snapshot().online).toBe(false));
    transport.accountId = 'account-b';
    await engine.retrySync();
    expect(store.accountId).toBe('account-b');

    oldHistory.resolve({
      messages: [{ ...dialog.topMessage!, text: 'Old-account secret' }],
      hasOlder: false,
    });
    await selecting;

    expect(store.messages).not.toContainEqual(
      expect.objectContaining({ text: 'Old-account secret' }),
    );
    expect(engine.snapshot().messages).not.toContainEqual(
      expect.objectContaining({ text: 'Old-account secret' }),
    );
    await engine.stop();
  });

  it('recovers a post-ready fatal update failure through retrySync', async () => {
    class FailingMessageStore extends MemoryStore {
      failMessages = false;
      override async putMessage(message: CachedMessage) {
        if (this.failMessages) throw new Error('cache unavailable');
        await super.putMessage(message);
      }
    }
    const store = new FailingMessageStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    store.failMessages = true;

    transport.emit({
      type: 'new-message',
      pts: 21,
      ptsCount: 1,
      message: { ...dialog.topMessage!, id: 8, text: 'Fails once' },
    });
    await vi.waitFor(() =>
      expect(engine.snapshot()).toMatchObject({ phase: 'ready', sync: 'stale', online: false }),
    );
    store.failMessages = false;
    await engine.retrySync();

    expect(engine.snapshot()).toMatchObject({ phase: 'ready', sync: 'current', online: true });
    await engine.stop();
  });

  it('retries and cancels queued sends through the durable outbox interface', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.setDraft(peer.id, 'Retry me');
    await engine.sendDraft(peer, 'Retry me');
    const retryId = engine.snapshot().pending[0]?.id;
    expect(retryId).toBeDefined();

    transport.failSend = false;
    await engine.retryPendingSend(retryId!);
    expect(engine.snapshot().pending).toEqual([]);
    expect(store.outbox).toEqual([]);
    expect(engine.snapshot().operationError).toBeUndefined();
    expect(new Set(transport.sentRandomIds)).toHaveLength(1);

    transport.failSend = true;
    await engine.setDraft(peer.id, 'Cancel me');
    await engine.sendDraft(peer, 'Cancel me');
    const cancelId = engine.snapshot().pending[0]?.id;
    await expect(engine.cancelPendingSend(cancelId!)).resolves.toBe(true);
    expect(engine.snapshot().pending).toEqual([]);
    expect(store.outbox).toEqual([]);
    expect(engine.snapshot().operationError).toBeUndefined();
    await engine.stop();
  });

  it('removes a peer outbox when its dialog is deleted', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.failSend = true;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.setDraft(peer.id, 'Must not return after deletion');
    await engine.sendDraft(peer, 'Must not return after deletion');
    expect(store.outbox).toHaveLength(1);

    await engine.deleteDialog(peer);

    expect(engine.snapshot().pending).toEqual([]);
    expect(store.outbox).toEqual([]);
    await engine.stop();
  });

  it('quarantines an unowned legacy outbox after an explicit new login', async () => {
    const store = new MemoryStore();
    store.dialogs = [{ ...dialog, cacheEpoch: 0 }];
    store.outbox = [
      {
        id: 'legacy-send',
        peer,
        text: 'Do not auto-send',
        randomId: 'legacy-random',
        createdAt: 1,
        attempts: 0,
      },
    ];
    const transport = new FakeTransport();
    transport.authorized = false;
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    await engine.submitCode('12345');

    expect(engine.snapshot()).toMatchObject({ phase: 'ready', pending: [] });
    expect(transport.sentRandomIds).toEqual([]);
    expect(store.outbox).toEqual([
      expect.objectContaining({ id: 'legacy-send', accountId: 'legacy-unowned' }),
    ]);
    await engine.stop();
  });

  it('honors Telegram still-unread counts on inbox read updates', async () => {
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);

    transport.emit({
      type: 'read-history',
      pts: 21,
      ptsCount: 1,
      peerId: peer.id,
      maxMessageId: 5,
      direction: 'inbox',
      stillUnreadCount: 3,
    });

    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.unreadCount).toBe(3));
    expect(engine.snapshot().dialogs[0]?.readInboxMaxId).toBe(5);
    await engine.stop();
  });

  it('falls back to network history when noncritical cache selection work fails', async () => {
    class BrokenSelectionStore extends MemoryStore {
      override async saveLastPeerId() {
        throw new Error('last peer unavailable');
      }
      override async loadMessages(_peerId: string, _limit?: number): Promise<CachedMessage[]> {
        throw new Error('message cache unavailable');
      }
    }
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, new BrokenSelectionStore());
    await engine.start(credentials);

    await engine.selectChat(peer.id);

    expect(engine.snapshot()).toMatchObject({ loadingMessages: false, historyError: undefined });
    expect(engine.snapshot().messages).toEqual([expect.objectContaining({ id: 7 })]);
    expect(transport.historyCalls).toEqual([undefined]);
    await engine.stop();
  });

  it('backs off repeated failed history loads until retryHistory is requested', async () => {
    class FlakyHistoryTransport extends FakeTransport {
      failures = 0;
      override async getHistory(
        _peer: TelegramPeer,
        _limit: number,
        beforeMessageId?: number,
      ): Promise<HistoryPage> {
        this.historyCalls.push(beforeMessageId);
        this.failures += 1;
        if (this.failures === 1) throw new Error('temporary history failure');
        return { messages: [dialog.topMessage!], hasOlder: false };
      }
    }
    const transport = new FlakyHistoryTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    await engine.selectChat(peer.id);
    expect(transport.historyCalls).toHaveLength(1);
    expect(engine.snapshot().historyRetryAt).toBeGreaterThan(Date.now());
    await engine.retryHistory();

    expect(transport.historyCalls).toHaveLength(2);
    expect(engine.snapshot()).toMatchObject({ historyError: undefined, loadingMessages: false });
    await engine.stop();
  });

  it('reloads only the affected channel after a channel-too-long signal', async () => {
    const channelPeer: TelegramPeer = { id: 'c:7', kind: 'channel', accessHash: '7' };
    const channelDialog: TelegramDialog = {
      ...dialog,
      peer: channelPeer,
      channelPts: 7,
      topMessage: { ...dialog.topMessage!, peerId: channelPeer.id },
    };
    class TooLongChannelTransport extends FakeTransport {
      loads = 0;
      override async getDialogs() {
        return { dialogs: [channelDialog] };
      }
      override async getHistory(): Promise<HistoryPage> {
        this.loads += 1;
        return {
          messages: [
            {
              ...dialog.topMessage!,
              id: this.loads === 1 ? 7 : 9,
              peerId: channelPeer.id,
              text: this.loads === 1 ? 'Old channel cache' : 'Reloaded channel head',
            },
          ],
          hasOlder: false,
        };
      }
    }
    const store = new MemoryStore();
    const transport = new TooLongChannelTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(channelPeer.id);

    transport.emit({ type: 'channel-too-long', peerId: channelPeer.id });

    await vi.waitFor(() => expect(engine.snapshot().messages[0]?.id).toBe(9));
    expect(store.messages.map(({ id }) => id)).toEqual([9]);
    await engine.stop();
  });

  it('bounds remembered histories and reloads the least recently used conversation', async () => {
    const peers = Array.from({ length: 9 }, (_, index): TelegramPeer => ({
      id: `peer-${index + 1}`,
      kind: 'user',
    }));
    const dialogs = peers.map((target, index): TelegramDialog => ({
      ...dialog,
      peer: target,
      title: `Peer ${index + 1}`,
      topMessageId: index + 1,
      topMessage: { ...dialog.topMessage!, id: index + 1, peerId: target.id },
    }));
    class ManyChatTransport extends FakeTransport {
      peerHistoryCalls: string[] = [];
      override async getDialogs() {
        return { dialogs };
      }
      override async getHistory(target: TelegramPeer): Promise<HistoryPage> {
        this.peerHistoryCalls.push(target.id);
        const source = dialogs.find(({ peer }) => peer.id === target.id)!;
        return { messages: [source.topMessage!], hasOlder: false };
      }
    }
    const store = new MemoryStore();
    const transport = new ManyChatTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    for (const target of peers) await engine.selectChat(target.id);
    store.messages = store.messages.filter(({ peerId }) => peerId !== peers[0]!.id);

    await engine.selectChat(peers[0]!.id);

    expect(transport.peerHistoryCalls.filter((peerId) => peerId === peers[0]!.id)).toHaveLength(2);
    await engine.stop();
  });

  it('recovers a deleted dialog head from Telegram when no older message is cached', async () => {
    const previous = { ...dialog.topMessage!, id: 6, text: 'Server previous' };
    class DeletedHeadTransport extends FakeTransport {
      deleted = false;
      override async getDialogs() {
        return {
          dialogs: [
            this.deleted ? { ...dialog, topMessageId: previous.id, topMessage: previous } : dialog,
          ],
        };
      }
      override async deleteMessages() {
        this.deleted = true;
        return {};
      }
    }
    const transport = new DeletedHeadTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    await engine.deleteMessage(peer, 7, true);

    expect(engine.snapshot().dialogs[0]).toMatchObject({
      topMessageId: 6,
      topMessage: { text: 'Server previous' },
    });
    await engine.stop();
  });

  it('applies channel inbox and outbox reads without advancing or rejecting channel PTS', async () => {
    const channelPeer: TelegramPeer = { id: 'c:55', kind: 'channel', accessHash: '55' };
    const channelDialog: TelegramDialog = {
      ...dialog,
      peer: channelPeer,
      channelPts: 10,
      unreadCount: 8,
      topMessage: { ...dialog.topMessage!, peerId: channelPeer.id },
    };
    class ChannelReadTransport extends FakeTransport {
      override async getDialogs() {
        return { dialogs: [channelDialog] };
      }
      override async getChannelDifference(): Promise<ChannelDifferenceResult> {
        throw new Error('equal/non-PTS channel reads must not recover a gap');
      }
    }
    const transport = new ChannelReadTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);

    transport.emit({
      type: 'read-history',
      pts: 10,
      ptsCount: 0,
      channelScoped: true,
      peerId: channelPeer.id,
      maxMessageId: 21,
      direction: 'inbox',
      stillUnreadCount: 5,
    });
    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.unreadCount).toBe(5));
    transport.emit({
      type: 'read-history',
      pts: 0,
      ptsCount: 0,
      channelScoped: true,
      peerId: channelPeer.id,
      maxMessageId: 22,
      direction: 'outbox',
    });
    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.readOutboxMaxId).toBe(22));

    expect(engine.snapshot().dialogs[0]?.channelPts).toBe(10);
    await engine.stop();
  });

  it('moves to cached-offline state on transport disconnect and reconnects explicitly', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    transport.emit({ type: 'connection-state', connected: false });
    await vi.waitFor(() =>
      expect(engine.snapshot()).toMatchObject({ phase: 'ready', sync: 'stale', online: false }),
    );
    transport.emit({
      type: 'new-message',
      pts: 21,
      ptsCount: 1,
      message: { ...dialog.topMessage!, id: 8, text: 'Must be ignored while unsubscribed' },
    });
    await Promise.resolve();
    expect(store.messages).toEqual([]);

    await engine.retrySync();
    expect(engine.snapshot()).toMatchObject({ phase: 'ready', sync: 'current', online: true });
    transport.emit({
      type: 'new-message',
      pts: 21,
      ptsCount: 1,
      message: { ...dialog.topMessage!, id: 9, text: 'After explicit reconnect' },
    });
    await vi.waitFor(() => expect(store.messages.some(({ id }) => id === 9)).toBe(true));
    await engine.stop();
  });

  it('reconnects automatically after a live connection loss', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const connect = vi.spyOn(transport, 'connect');
      const engine = new MessagingEngine(transport, new MemoryStore());
      await engine.start(credentials);

      transport.emit({ type: 'connection-state', connected: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(engine.snapshot()).toMatchObject({ phase: 'ready', online: false });

      await vi.advanceTimersByTimeAsync(1_001);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(engine.snapshot()).toMatchObject({ phase: 'ready', online: true });
      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs out remotely, clears account data, and returns to phone authentication', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.setDraft(peer.id, 'Private draft');
    store.blobs.set('private-file', new Blob(['private']));

    await engine.logOut();

    expect(engine.snapshot()).toMatchObject({
      phase: 'unauthorized',
      online: false,
      dialogs: [],
      drafts: {},
      pending: [],
      authStep: 'phone',
    });
    expect(store.transportSession).toBeUndefined();
    expect(store.accountId).toBeUndefined();
    expect(store.blobs.size).toBe(0);
    await engine.stop();
  });

  it('rejects oversized text before it can poison the peer queue', async () => {
    const engine = new MessagingEngine(new FakeTransport(), new MemoryStore());
    await engine.start(credentials);

    await expect(engine.sendDraft(peer, 'x'.repeat(4_097))).rejects.toThrow('Telegram allows 4096');
    expect(engine.snapshot().pending).toEqual([]);
    expect(engine.snapshot().operationError).toContain('was not queued');
    await engine.stop();
  });

  it('reserves browser storage for attachment bytes before enqueueing', async () => {
    const store = new MemoryStore();
    const engine = new MessagingEngine(new FakeTransport(), store);
    await engine.start(credentials);

    await engine.sendAttachment(
      peer,
      new File(['attachment'], 'attachment.txt', { type: 'text/plain' }),
    );

    expect(store.preparedOutboxBytes).toContain(10);
    await engine.stop();
  });

  it('keeps the newest pagination frontier after opening a far older message', async () => {
    class FarJumpTransport extends FakeTransport {
      async getHistoryAround() {
        return [{ ...dialog.topMessage!, id: 100, text: 'Far target' }];
      }
      override async getHistory(
        _peer: TelegramPeer,
        _limit: number,
        beforeMessageId?: number,
      ): Promise<HistoryPage> {
        this.historyCalls.push(beforeMessageId);
        if (beforeMessageId === 951) {
          return {
            messages: [{ ...dialog.topMessage!, id: 950, text: 'Gap page' }],
            hasOlder: true,
            nextBeforeMessageId: 950,
          };
        }
        return {
          messages: [{ ...dialog.topMessage!, id: 951, text: 'Newest window' }],
          hasOlder: true,
          nextBeforeMessageId: 951,
        };
      }
    }
    const transport = new FarJumpTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await engine.openMessage({ ...dialog.topMessage!, id: 100, text: '' });

    expect(engine.snapshot().historyGaps).toEqual([
      { olderMaxMessageId: 100, newerMinMessageId: 951 },
    ]);

    await engine.loadOlderMessages();

    expect(transport.historyCalls).toEqual([undefined, 951]);
    expect(engine.snapshot().historyGaps).toEqual([
      { olderMaxMessageId: 100, newerMinMessageId: 950 },
    ]);
    expect(engine.snapshot().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 100, text: 'Far target' }),
        expect.objectContaining({ id: 950, text: 'Gap page' }),
      ]),
    );
    await engine.stop();
  });

  it('retries the exact failed history gap without losing its boundaries', async () => {
    class RetryGapTransport extends FakeTransport {
      gapAttempts = 0;
      async getHistoryAround() {
        return [{ ...dialog.topMessage!, id: 100, text: 'Far target' }];
      }
      override async getHistory(
        _peer: TelegramPeer,
        _limit: number,
        beforeMessageId?: number,
      ): Promise<HistoryPage> {
        this.historyCalls.push(beforeMessageId);
        if (beforeMessageId === 951) {
          this.gapAttempts += 1;
          if (this.gapAttempts === 1) throw new Error('offline during gap load');
          return {
            messages: [{ ...dialog.topMessage!, id: 950, text: 'Recovered gap page' }],
            hasOlder: true,
            nextBeforeMessageId: 950,
          };
        }
        return {
          messages: [{ ...dialog.topMessage!, id: 951, text: 'Newest window' }],
          hasOlder: true,
          nextBeforeMessageId: 951,
        };
      }
    }
    const transport = new RetryGapTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await engine.openMessage({ ...dialog.topMessage!, id: 100, text: '' });
    const gap = engine.snapshot().historyGaps[0]!;

    await engine.loadHistoryGap(gap);

    expect(engine.snapshot()).toMatchObject({
      loadingOlderMessages: false,
      historyGaps: [gap],
      historyError: expect.stringContaining('offline during gap load'),
    });

    await engine.retryHistory();

    expect(transport.gapAttempts).toBe(2);
    expect(engine.snapshot()).toMatchObject({
      loadingOlderMessages: false,
      historyError: undefined,
      historyGaps: [{ olderMaxMessageId: 100, newerMinMessageId: 950 }],
    });
    await engine.stop();
  });

  it('preserves an older-history failure when switching away and retries it on return', async () => {
    const secondPeer: TelegramPeer = { id: 'peer-2', kind: 'user' };
    const secondDialog: TelegramDialog = {
      ...dialog,
      peer: secondPeer,
      title: 'Second',
      topMessage: { ...dialog.topMessage!, peerId: secondPeer.id },
    };
    class RetryOlderTransport extends FakeTransport {
      olderAttempts = 0;
      override async getDialogs() {
        return { dialogs: [dialog, secondDialog] };
      }
      override async getHistory(
        target: TelegramPeer,
        _limit: number,
        beforeMessageId?: number,
      ): Promise<HistoryPage> {
        this.historyCalls.push(beforeMessageId);
        if (target.id === secondPeer.id) {
          return { messages: [secondDialog.topMessage!], hasOlder: false };
        }
        if (beforeMessageId === 7) {
          this.olderAttempts += 1;
          if (this.olderAttempts === 1) throw new Error('temporary history failure');
          return {
            messages: [{ ...dialog.topMessage!, id: 6, text: 'Recovered older message' }],
            hasOlder: false,
            nextBeforeMessageId: 6,
          };
        }
        return { messages: [dialog.topMessage!], hasOlder: true, nextBeforeMessageId: 7 };
      }
    }
    const transport = new RetryOlderTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await engine.loadOlderMessages();
    expect(engine.snapshot()).toMatchObject({
      hasOlderMessages: true,
      historyError: expect.stringContaining('temporary history failure'),
    });

    await engine.selectChat(secondPeer.id);
    await engine.selectChat(peer.id);

    expect(engine.snapshot()).toMatchObject({
      hasOlderMessages: true,
      historyError: expect.stringContaining('temporary history failure'),
    });
    await engine.retryHistory();
    expect(transport.olderAttempts).toBe(2);
    expect(engine.snapshot().messages.map(({ id }) => id)).toEqual([6, 7]);
    expect(engine.snapshot().historyError).toBeUndefined();
    await engine.stop();
  });

  it('coalesces in-flight inbox reads to the highest requested message id', async () => {
    const firstRead = deferred<void>();
    class CoalescedReadTransport extends FakeTransport {
      override async readHistory(target: TelegramPeer, maxMessageId: number) {
        this.readCalls.push({ peer: target, maxMessageId });
        if (this.readCalls.length === 1) await firstRead.promise;
        return {};
      }
    }
    const transport = new CoalescedReadTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    const first = engine.setActiveConversationVisibility(peer.id, {
      visible: true,
      atBottom: true,
    });
    await vi.waitFor(() => expect(transport.readCalls).toHaveLength(1));

    transport.emit({
      type: 'new-message',
      pts: 21,
      ptsCount: 1,
      message: { ...dialog.topMessage!, id: 8, text: 'Eight' },
    });
    transport.emit({
      type: 'new-message',
      pts: 22,
      ptsCount: 1,
      message: { ...dialog.topMessage!, id: 9, text: 'Nine' },
    });
    await vi.waitFor(() => expect(engine.snapshot().dialogs[0]?.topMessageId).toBe(9));
    firstRead.resolve();
    await first;
    await vi.waitFor(() => expect(transport.readCalls).toHaveLength(2));

    expect(transport.readCalls.map(({ maxMessageId }) => maxMessageId)).toEqual([7, 9]);
    await vi.waitFor(() =>
      expect(engine.snapshot().dialogs[0]).toMatchObject({
        readInboxMaxId: 9,
        unreadCount: 0,
      }),
    );
    await engine.stop();
  });

  it('caches bot commands and durably delivers start and callback actions', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    const invalidations: string[] = [];
    const unsubscribe = engine.subscribeResources(({ kind, peerId }) =>
      invalidations.push(`${kind}:${peerId ?? ''}`),
    );
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    await expect(engine.getBotCommands(peer)).resolves.toEqual([
      { command: 'help', description: 'Show help' },
    ]);
    await expect(engine.getBotCommands(peer)).resolves.toHaveLength(1);
    expect(transport.botCommandCalls).toBe(1);
    transport.emit({ type: 'bot-commands-changed', peerId: peer.id });
    await vi.waitFor(() => expect(invalidations).toContain(`bot-commands:${peer.id}`));
    await expect(engine.getBotCommands(peer)).resolves.toHaveLength(1);
    expect(transport.botCommandCalls).toBe(2);

    await engine.startBot(peer, 'fixture');
    expect(transport.botStartCalls).toEqual([
      { startParam: 'fixture', randomId: expect.any(String) },
    ]);
    expect(store.outbox).toEqual([]);
    expect(engine.snapshot().messages.at(-1)).toMatchObject({ text: '/start fixture' });
    unsubscribe();

    await expect(engine.answerBotCallback(peer, 7, [1, 2])).resolves.toEqual({
      message: 'Done',
      alert: false,
    });
    expect(transport.botCallbackCalls).toEqual([{ messageId: 7, data: [1, 2] }]);
    await engine.stop();
  });

  it('keeps nonfatal operation failures separate from connection state', async () => {
    class FailingMuteTransport extends FakeTransport {
      override async setMuted() {
        throw new Error('settings denied');
      }
    }
    const engine = new MessagingEngine(new FailingMuteTransport(), new MemoryStore());
    await engine.start(credentials);

    await engine.setMuted(peer, true);

    expect(engine.snapshot()).toMatchObject({
      phase: 'ready',
      online: true,
      error: undefined,
      operationError: expect.stringContaining('settings denied'),
    });
    engine.clearOperationError();
    expect(engine.snapshot().operationError).toBeUndefined();
    await engine.stop();
  });

  it('bounds a large active history without silently dropping the middle range', async () => {
    const historyMessages = (first: number, last: number) =>
      Array.from({ length: last - first + 1 }, (_, index) => ({
        ...dialog.topMessage!,
        id: first + index,
        text: `Message ${first + index}`,
      }));
    class LargeHistoryTransport extends FakeTransport {
      override async getHistory(
        _peer: TelegramPeer,
        _limit: number,
        beforeMessageId?: number,
      ): Promise<HistoryPage> {
        this.historyCalls.push(beforeMessageId);
        if (beforeMessageId === 5_001) {
          return {
            messages: historyMessages(4_951, 5_000),
            hasOlder: true,
            nextBeforeMessageId: 4_951,
          };
        }
        if (beforeMessageId === 4_951) {
          return {
            messages: historyMessages(4_901, 4_950),
            hasOlder: true,
            nextBeforeMessageId: 4_901,
          };
        }
        return {
          messages: historyMessages(5_001, 10_000),
          hasOlder: true,
          nextBeforeMessageId: 5_001,
        };
      }
    }
    const transport = new LargeHistoryTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await engine.loadOlderMessages();
    await engine.loadOlderMessages();

    expect(transport.historyCalls).toEqual([undefined, 5_001, 4_951]);
    expect(engine.snapshot().messages).toHaveLength(5_000);
    expect(engine.snapshot().messages[0]?.id).toBe(4_901);
    expect(engine.snapshot().messages.at(-1)?.id).toBe(10_000);
    expect(engine.snapshot().historyGaps).toEqual([
      { olderMaxMessageId: 7_400, newerMinMessageId: 7_501 },
    ]);
    await engine.stop();
  });

  it('ignores late edit, archive, and message-pin completions after stop', async () => {
    const edited = deferred<EditMessageResult>();
    const archived = deferred<TransportMutationResult>();
    const pinned = deferred<TransportMutationResult>();
    class SlowMutationTransport extends FakeTransport {
      editStarted = false;
      archiveStarted = false;
      pinStarted = false;

      override editMessage() {
        this.editStarted = true;
        return edited.promise;
      }

      override setArchived() {
        this.archiveStarted = true;
        return archived.promise;
      }

      override setPinnedMessage() {
        this.pinStarted = true;
        return pinned.promise;
      }
    }
    const store = new MemoryStore();
    const transport = new SlowMutationTransport();
    transport.pinnedMessages = [];
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    const editing = engine.editMessage(peer, 7, 'Late edit');
    const archiving = engine.setArchived(peer, true);
    const pinning = engine.setPinnedMessage(peer, 7, true);
    await vi.waitFor(() => {
      expect(transport.editStarted).toBe(true);
      expect(transport.archiveStarted).toBe(true);
      expect(transport.pinStarted).toBe(true);
    });
    const stopping = engine.stop();
    edited.resolve({
      message: { ...dialog.topMessage!, text: 'Late edit', editedAt: 200 },
    });
    archived.resolve({});
    pinned.resolve({});
    await Promise.allSettled([editing, archiving, pinning, stopping]);

    expect(store.messages.find(({ id }) => id === 7)?.text).toBe('Current message');
    expect(store.dialogs.find(({ peer: item }) => item.id === peer.id)?.archived).not.toBe(true);
    expect(engine.snapshot().pinnedMessages).toEqual([]);
  });

  it('does not apply a pin completion to a newly active chat with the same message id', async () => {
    const secondPeer: TelegramPeer = { id: 'peer-2', kind: 'user' };
    const secondMessage = {
      ...dialog.topMessage!,
      peerId: secondPeer.id,
      senderId: secondPeer.id,
      text: 'Second peer message',
    };
    const secondDialog: TelegramDialog = {
      ...dialog,
      peer: secondPeer,
      title: 'Second peer',
      topMessage: secondMessage,
    };
    const pinResult = deferred<TransportMutationResult>();
    class SwitchingPinTransport extends FakeTransport {
      override async getDialogs() {
        return { dialogs: [dialog, secondDialog] };
      }

      override async getHistory(target: TelegramPeer) {
        return {
          messages: [target.id === peer.id ? dialog.topMessage! : secondMessage],
          hasOlder: false,
        };
      }

      override async getPinnedMessages(target: TelegramPeer) {
        return target.id === secondPeer.id ? [{ ...secondMessage, pinned: true }] : [];
      }

      override setPinnedMessage() {
        return pinResult.promise;
      }
    }
    const transport = new SwitchingPinTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    const pinning = engine.setPinnedMessage(peer, 7, true);
    await engine.selectChat(secondPeer.id);
    pinResult.resolve({});
    await pinning;

    expect(engine.snapshot().activePeerId).toBe(secondPeer.id);
    expect(engine.snapshot().pinnedMessages).toEqual([
      expect.objectContaining({ id: 7, peerId: secondPeer.id, text: 'Second peer message' }),
    ]);
    await engine.stop();
  });

  it('serializes archive intents so the latest action is the final server RPC', async () => {
    const firstResult = deferred<TransportMutationResult>();
    const secondResult = deferred<TransportMutationResult>();
    class OrderedArchiveTransport extends FakeTransport {
      override async setArchived(_peer: TelegramPeer, archived: boolean) {
        this.archiveCalls.push(archived);
        return this.archiveCalls.length === 1 ? firstResult.promise : secondResult.promise;
      }
    }
    const transport = new OrderedArchiveTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);

    const first = engine.setArchived(peer, true);
    await vi.waitFor(() => expect(transport.archiveCalls).toEqual([true]));
    const second = engine.setArchived(peer, false);
    await Promise.resolve();
    expect(transport.archiveCalls).toEqual([true]);
    firstResult.resolve({});
    await vi.waitFor(() => expect(transport.archiveCalls).toEqual([true, false]));
    secondResult.resolve({});
    await Promise.all([first, second]);

    expect(engine.snapshot().dialogs[0]?.archived).toBe(false);
    await engine.stop();
  });

  it('serializes rapid mute, block, dialog-pin, and message-pin intents', async () => {
    const muteGates = [deferred<void>(), deferred<void>()];
    const blockGates = [deferred<void>(), deferred<void>()];
    const dialogPinGates = [deferred<void>(), deferred<void>()];
    const messagePinGates = [
      deferred<TransportMutationResult>(),
      deferred<TransportMutationResult>(),
    ];
    class OrderedToggleTransport extends FakeTransport {
      override async setMuted(_peer: TelegramPeer, muted: boolean) {
        const index = this.muteCalls.length;
        this.muteCalls.push(muted);
        await muteGates[index]!.promise;
      }

      override async setBlocked(_peer: TelegramPeer, blocked: boolean) {
        const index = this.blockCalls.length;
        this.blockCalls.push(blocked);
        await blockGates[index]!.promise;
      }

      override async setPinnedDialog(_peer: TelegramPeer, pinned: boolean) {
        const index = this.dialogPinCalls.length;
        this.dialogPinCalls.push(pinned);
        await dialogPinGates[index]!.promise;
      }

      override async setPinnedMessage(_peer: TelegramPeer, messageId: number, pinned: boolean) {
        const index = this.pinCalls.length;
        this.pinCalls.push({ messageId, pinned });
        return messagePinGates[index]!.promise;
      }
    }
    const transport = new OrderedToggleTransport();
    transport.pinnedMessages = [];
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await engine.getUserDetails(peer);

    const first = [
      engine.setMuted(peer, true),
      engine.setBlocked(peer, true),
      engine.setPinnedDialog(peer, true),
      engine.setPinnedMessage(peer, 7, true),
    ];
    await vi.waitFor(() => {
      expect(transport.muteCalls).toEqual([true]);
      expect(transport.blockCalls).toEqual([true]);
      expect(transport.dialogPinCalls).toEqual([true]);
      expect(transport.pinCalls).toEqual([{ messageId: 7, pinned: true }]);
    });
    const second = [
      engine.setMuted(peer, false),
      engine.setBlocked(peer, false),
      engine.setPinnedDialog(peer, false),
      engine.setPinnedMessage(peer, 7, false),
    ];
    await Promise.resolve();
    expect(transport.muteCalls).toEqual([true]);
    expect(transport.blockCalls).toEqual([true]);
    expect(transport.dialogPinCalls).toEqual([true]);
    expect(transport.pinCalls).toEqual([{ messageId: 7, pinned: true }]);

    muteGates[0]!.resolve(undefined);
    blockGates[0]!.resolve(undefined);
    dialogPinGates[0]!.resolve(undefined);
    messagePinGates[0]!.resolve({});
    await vi.waitFor(() => {
      expect(transport.muteCalls).toEqual([true, false]);
      expect(transport.blockCalls).toEqual([true, false]);
      expect(transport.dialogPinCalls).toEqual([true, false]);
      expect(transport.pinCalls).toEqual([
        { messageId: 7, pinned: true },
        { messageId: 7, pinned: false },
      ]);
    });
    muteGates[1]!.resolve(undefined);
    blockGates[1]!.resolve(undefined);
    dialogPinGates[1]!.resolve(undefined);
    messagePinGates[1]!.resolve({});
    await Promise.all([...first, ...second]);

    expect(engine.snapshot().dialogs[0]).toMatchObject({ muted: false, pinned: false });
    expect(engine.snapshot().dialogs[0]?.userDetails?.blocked).toBe(false);
    expect(engine.snapshot().pinnedMessages).toEqual([]);
    await engine.stop();
  });

  it('does not increment unread twice when an applied update is replayed', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    const repeatedUpdate: TransportUpdate = {
      type: 'new-message',
      pts: 21,
      ptsCount: 1,
      message: { ...dialog.topMessage!, id: 8, text: 'Replay once' },
    };
    transport.emit(repeatedUpdate);
    await vi.waitFor(() => expect(store.cursor?.pts).toBe(21));
    expect(engine.snapshot().dialogs[0]?.unreadCount).toBe(2);
    store.cursor = currentCursor;
    transport.emit(repeatedUpdate);
    await vi.waitFor(() => expect(store.cursor?.pts).toBe(21));

    expect(engine.snapshot().dialogs[0]?.unreadCount).toBe(2);
    expect(store.messages.filter(({ id }) => id === 8)).toHaveLength(1);
    await engine.stop();
  });

  it('invalidates replaced media and uses a revision-specific cache key', async () => {
    const originalMessage: TelegramMessage = {
      ...dialog.topMessage!,
      media: {
        kind: 'photo',
        name: 'old.png',
        mimeType: 'image/png',
        size: 3,
      },
    };
    class ReplacedMediaTransport extends FakeTransport {
      override async getHistory() {
        return { messages: [originalMessage], hasOlder: false };
      }

      override async downloadMedia(message: TelegramMessage) {
        this.downloadMediaCalls += 1;
        return new Blob([message.media?.name ?? 'none']);
      }
    }
    const store = new MemoryStore();
    const transport = new ReplacedMediaTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    const original = engine.snapshot().messages[0]!;
    const originalKey = engine.mediaAssetKey(original);
    await engine.downloadMedia(original);
    expect(store.blobs.has(originalKey)).toBe(true);

    await engine.editMessage(peer, 7, 'Current message', undefined, {
      file: new File(['new'], 'new.png', { type: 'image/png' }),
      sendAs: 'media',
    });
    const replaced = engine.snapshot().messages.find(({ id }) => id === 7)!;
    const replacementKey = engine.mediaAssetKey(replaced);

    expect(replacementKey).not.toBe(originalKey);
    expect(store.blobs.has(originalKey)).toBe(false);
    await engine.downloadMedia(replaced);
    expect(transport.downloadMediaCalls).toBe(2);
    expect(store.blobs.has(replacementKey)).toBe(true);
    await engine.stop();
  });

  it('keeps pinned-message projections current across edit and delete', async () => {
    const engine = new MessagingEngine(new FakeTransport(), new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await engine.setPinnedMessage(peer, 7, true);

    await engine.editMessage(peer, 7, 'Edited while pinned');
    expect(engine.snapshot().pinnedMessages).toEqual([
      expect.objectContaining({ id: 7, text: 'Edited while pinned' }),
    ]);
    await engine.deleteMessage(peer, 7, true);
    expect(engine.snapshot().pinnedMessages).toEqual([]);
    await engine.stop();
  });

  it('applies pts updates from a seq-zero envelope without advancing seq', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    transport.emitBatch({
      seq: 0,
      date: 101,
      updates: [
        {
          type: 'new-message',
          pts: 21,
          ptsCount: 1,
          message: { ...dialog.topMessage!, id: 8, text: 'Seq zero' },
        },
      ],
    });
    await vi.waitFor(() => expect(store.cursor?.pts).toBe(21));

    expect(store.cursor).toMatchObject({ pts: 21, seq: 3, date: 101 });
    expect(engine.snapshot().dialogs[0]?.topMessageId).toBe(8);
    await engine.stop();
  });

  it('does not regress cursor date when PTS-gap recovery advances it beyond the batch', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    transport.difference = {
      type: 'complete',
      cursor: { ...currentCursor, pts: 21, date: 200 },
      updates: [],
    };

    transport.emitBatch({
      date: 101,
      updates: [
        {
          type: 'new-message',
          pts: 22,
          ptsCount: 1,
          message: { ...dialog.topMessage!, id: 9, text: 'After a gap' },
        },
      ],
    });
    await vi.waitFor(() => expect(store.cursor?.pts).toBe(21));

    expect(store.cursor?.date).toBe(200);
    await engine.stop();
  });

  it('routes mutation-returned updates through the sequencer without synthetic replay', async () => {
    class CountingStore extends MemoryStore {
      editedWrites = 0;

      override async putMessage(message: CachedMessage) {
        if (message.id === 7 && message.editedAt === 200) this.editedWrites += 1;
        await super.putMessage(message);
      }
    }
    class BatchEditTransport extends FakeTransport {
      override async editMessage(target: TelegramPeer, messageId: number, text: string) {
        const message = {
          ...dialog.topMessage!,
          id: messageId,
          peerId: target.id,
          text,
          editedAt: 200,
        };
        return {
          message,
          updateBatches: [
            {
              updates: [{ type: 'edit-message' as const, pts: 21, ptsCount: 1, message }],
            },
          ],
        };
      }
    }
    const store = new CountingStore();
    const engine = new MessagingEngine(new BatchEditTransport(), store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    await engine.editMessage(peer, 7, 'Sequenced edit');

    expect(store.cursor?.pts).toBe(21);
    expect(store.editedWrites).toBe(1);
    expect(engine.snapshot().messages[0]?.text).toBe('Sequenced edit');
    await engine.stop();
  });

  it('falls back to the persisted start text when startBot is unavailable after reload', async () => {
    const store = new MemoryStore();
    store.accountId = 'account-1';
    store.outbox = [
      {
        ...pendingSend('/start durable', 10),
        id: 'persisted-start',
        randomId: 'persisted-start-random',
        queueOrder: 1,
        botStart: { startParam: 'durable' },
      },
    ];
    const transport = new FakeTransport();
    Object.defineProperty(transport, 'startBot', { value: undefined });
    const engine = new MessagingEngine(transport, store);

    await engine.start(credentials);

    expect(transport.sentRandomIds).toEqual(['persisted-start-random']);
    expect(store.messages.at(-1)).toMatchObject({ text: '/start durable' });
    expect(store.outbox).toEqual([]);
    await engine.stop();
  });

  it('keeps later sends blocked behind a failed message until its retry succeeds', async () => {
    class OrderedRetryTransport extends FakeTransport {
      texts: string[] = [];
      failedFirst = false;

      override async sendText(
        target: TelegramPeer,
        text: string,
        randomId: string,
        reply?: TelegramReplyTarget,
        formats?: TelegramTextFormat[],
      ) {
        this.texts.push(text);
        if (text === 'First' && !this.failedFirst) {
          this.failedFirst = true;
          throw new Error('temporary failure');
        }
        return super.sendText(target, text, randomId, reply, formats);
      }
    }
    const transport = new OrderedRetryTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);

    await engine.setDraft(peer.id, 'First');
    await engine.sendDraft(peer, 'First');
    const failedId = engine.snapshot().pending.find(({ text }) => text === 'First')!.id;
    await engine.setDraft(peer.id, 'Second');
    await engine.sendDraft(peer, 'Second');

    expect(transport.texts).toEqual(['First']);
    expect(engine.snapshot().pending.map(({ text }) => text)).toEqual(['First', 'Second']);
    expect(engine.snapshot().pending.find(({ text }) => text === 'Second')?.lastError).toContain(
      'earlier failed message',
    );

    await engine.retryPendingSend(failedId);
    await vi.waitFor(() => expect(transport.texts).toEqual(['First', 'First', 'Second']));
    await vi.waitFor(() => expect(engine.snapshot().pending).toEqual([]));
    await engine.stop();
  });

  it('releases later sends when the failed head of a peer queue is cancelled', async () => {
    class OrderedCancelTransport extends FakeTransport {
      texts: string[] = [];

      override async sendText(
        target: TelegramPeer,
        text: string,
        randomId: string,
        reply?: TelegramReplyTarget,
        formats?: TelegramTextFormat[],
      ) {
        this.texts.push(text);
        if (text === 'First') throw new Error('permanent failure');
        return super.sendText(target, text, randomId, reply, formats);
      }
    }
    const transport = new OrderedCancelTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);

    await engine.setDraft(peer.id, 'First');
    await engine.sendDraft(peer, 'First');
    const failedId = engine.snapshot().pending.find(({ text }) => text === 'First')!.id;
    await engine.setDraft(peer.id, 'Second');
    await engine.sendDraft(peer, 'Second');
    expect(transport.texts).toEqual(['First']);

    await engine.cancelPendingSend(failedId);
    await vi.waitFor(() => expect(transport.texts).toEqual(['First', 'Second']));
    await vi.waitFor(() => expect(engine.snapshot().pending).toEqual([]));
    await engine.stop();
  });

  it('does not apply an old-account send completion after a same-generation account switch', async () => {
    const sendStarted = deferred<void>();
    const oldSend = deferred<SendTextResult>();
    class AccountSwitchSendTransport extends FakeTransport {
      override async sendText(
        target: TelegramPeer,
        text: string,
        randomId: string,
      ): Promise<SendTextResult> {
        sendStarted.resolve(undefined);
        const result = await oldSend.promise;
        return {
          ...result,
          message: { ...result.message, peerId: target.id, text, randomId },
        };
      }
    }
    const store = new MemoryStore();
    store.accountId = 'account-a';
    const transport = new AccountSwitchSendTransport();
    transport.accountId = 'account-a';
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    await engine.setDraft(peer.id, 'Old-account send');
    const sending = engine.sendDraft(peer, 'Old-account send');
    await sendStarted.promise;
    transport.emit({ type: 'connection-state', connected: false });
    await vi.waitFor(() => expect(engine.snapshot().online).toBe(false));
    transport.accountId = 'account-b';
    await engine.retrySync();
    expect(store.accountId).toBe('account-b');

    oldSend.resolve({
      message: {
        id: 99,
        peerId: peer.id,
        senderId: 'self',
        text: 'Old-account send',
        date: 200,
        outgoing: true,
      },
    });
    await sending;

    expect(store.messages).not.toContainEqual(expect.objectContaining({ id: 99 }));
    expect(engine.snapshot().messages).not.toContainEqual(expect.objectContaining({ id: 99 }));
    expect(engine.snapshot().pending).toEqual([]);
    await engine.stop();
  });

  it('uses monotonic mutation tokens across an edit ABA completion order', async () => {
    const edits = [
      deferred<EditMessageResult>(),
      deferred<EditMessageResult>(),
      deferred<EditMessageResult>(),
    ];
    class AbaEditTransport extends FakeTransport {
      calls = 0;

      override editMessage() {
        return edits[this.calls++]!.promise;
      }
    }
    const transport = new AbaEditTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    const result = (text: string, editedAt: number): EditMessageResult => ({
      message: { ...dialog.topMessage!, text, editedAt },
    });
    const first = engine.editMessage(peer, 7, 'First');
    const second = engine.editMessage(peer, 7, 'Second');
    edits[1]!.resolve(result('Second', 202));
    await second;
    expect(engine.snapshot().messages[0]?.text).toBe('Second');

    const third = engine.editMessage(peer, 7, 'Third');
    edits[0]!.resolve(result('First', 201));
    await first;
    expect(engine.snapshot().messages[0]?.text).toBe('Second');

    edits[2]!.resolve(result('Third', 203));
    await third;
    expect(engine.snapshot().messages[0]?.text).toBe('Third');
    await engine.stop();
  });

  it('applies the first live message after refreshing a legacy channel with no cached PTS', async () => {
    const channelPeer: TelegramPeer = { id: 'c:legacy', kind: 'channel', accessHash: '10' };
    const liveMessage: TelegramMessage = {
      ...dialog.topMessage!,
      id: 8,
      peerId: channelPeer.id,
      senderId: channelPeer.id,
      text: 'First after legacy cache',
    };
    const legacyDialog: TelegramDialog = {
      ...dialog,
      peer: channelPeer,
      title: 'Legacy channel',
      topMessageId: 7,
      topMessage: { ...dialog.topMessage!, peerId: channelPeer.id, senderId: channelPeer.id },
      channelPts: undefined,
    };
    class LegacyChannelTransport extends FakeTransport {
      override async getDialogs() {
        return { dialogs: [legacyDialog] };
      }

      async getDialog() {
        return {
          ...legacyDialog,
          topMessageId: liveMessage.id,
          topMessage: liveMessage,
          unreadCount: 2,
          channelPts: 11,
        };
      }
    }
    const store = new MemoryStore();
    const transport = new LegacyChannelTransport();
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    transport.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      channelScoped: true,
      message: liveMessage,
    });
    await vi.waitFor(() =>
      expect(store.messages).toContainEqual(
        expect.objectContaining({ peerId: channelPeer.id, id: 8 }),
      ),
    );

    expect(engine.snapshot().dialogs[0]).toMatchObject({ topMessageId: 8, channelPts: 11 });
    await engine.stop();
  });

  it('discards stale sticker and GIF indexes fetched across an account reset', async () => {
    const recent = deferred<TelegramSticker[]>();
    const gifs = deferred<TelegramSticker[]>();
    const packs = deferred<import('../types').TelegramStickerPack[]>();
    class AccountSwitchExpressionTransport extends FakeTransport {
      override getRecentStickers() {
        return recent.promise;
      }

      override getSavedGifs() {
        return gifs.promise;
      }

      override getStickerPacks() {
        return packs.promise;
      }
    }
    const sticker: TelegramSticker = {
      id: 'old-sticker',
      accessHash: '1',
      fileReference: new Uint8Array(),
      emoji: 'old',
      mimeType: 'image/webp',
    };
    const store = new MemoryStore();
    store.accountId = 'account-a';
    const transport = new AccountSwitchExpressionTransport();
    transport.accountId = 'account-a';
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    const oldRecent = engine.getRecentStickers();
    const oldGifs = engine.getSavedGifs();
    const oldPacks = engine.getStickerPacks();
    transport.emit({ type: 'connection-state', connected: false });
    await vi.waitFor(() => expect(engine.snapshot().online).toBe(false));
    transport.accountId = 'account-b';
    await engine.retrySync();

    recent.resolve([sticker]);
    gifs.resolve([{ ...sticker, id: 'old-gif' }]);
    packs.resolve([{ id: 'old-pack', title: 'Old', stickers: [sticker] }]);
    await expect(oldRecent).resolves.toEqual([]);
    await expect(oldGifs).resolves.toEqual([]);
    await expect(oldPacks).resolves.toEqual([]);
    expect([...store.blobs.keys()].filter((key) => key.startsWith('sticker-index:'))).toEqual([]);
    await engine.stop();
  });

  it('ignores a shared-media error that arrives after stop', async () => {
    const started = deferred<void>();
    const counts = deferred<SharedMediaCounts>();
    class SlowSharedMediaTransport extends FakeTransport {
      override getSharedMediaCounts() {
        started.resolve(undefined);
        return counts.promise;
      }
    }
    const engine = new MessagingEngine(new SlowSharedMediaTransport(), new MemoryStore());
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    await started.promise;
    await engine.stop();

    counts.reject(new Error('late failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.snapshot()).toMatchObject({ phase: 'idle', online: false });
    expect(engine.snapshot().operationError).toBeUndefined();
  });

  it('persists caller-known random IDs before deleting confirmed text and album outbox rows', async () => {
    const deleteStarted = deferred<void>();
    const allowDelete = deferred<void>();
    class SlowDeleteStore extends MemoryStore {
      delayed = true;

      override async deletePending(id: string) {
        if (this.delayed) {
          this.delayed = false;
          deleteStarted.resolve(undefined);
          await allowDelete.promise;
        }
        await super.deletePending(id);
      }
    }
    class CorrelationTransport extends FakeTransport {
      override async sendText(
        target: TelegramPeer,
        text: string,
        randomId: string,
      ): Promise<SendTextResult> {
        const message: TelegramMessage = {
          id: 8,
          peerId: target.id,
          senderId: 'self',
          text,
          date: 101,
          outgoing: true,
          randomId,
        };
        return {
          message,
          updateBatches: [
            {
              updates: [
                {
                  type: 'new-message',
                  pts: 21,
                  ptsCount: 1,
                  message: { ...message, randomId: undefined },
                },
              ],
            },
          ],
        };
      }

      override async sendAlbum(
        target: TelegramPeer,
        attachments: SendAlbumAttachment[],
        options: SendAlbumOptions,
      ) {
        const messages = attachments.map(({ file, randomId }, index): TelegramMessage => ({
          id: 9 + index,
          peerId: target.id,
          senderId: 'self',
          text: index === 0 ? options.caption : '',
          date: 102,
          outgoing: true,
          randomId,
          groupedId: 'grouped',
          media: { kind: 'photo', name: file.name, mimeType: file.type, size: file.size },
        }));
        return {
          messages,
          updateBatches: [
            {
              updates: messages.map((message, index) => ({
                type: 'new-message' as const,
                pts: 22 + index,
                ptsCount: 1,
                message: { ...message, randomId: undefined },
              })),
            },
          ],
        };
      }
    }
    const store = new SlowDeleteStore();
    const engine = new MessagingEngine(new CorrelationTransport(), store);
    await engine.start(credentials);
    await engine.setDraft(peer.id, 'Correlated text');
    const sending = engine.sendDraft(peer, 'Correlated text');
    await deleteStarted.promise;

    const textPending = engine.snapshot().pending[0]!;
    expect(store.messages.find(({ id }) => id === 8)?.randomId).toBe(textPending.randomId);
    expect(store.outbox).toHaveLength(1);
    allowDelete.resolve(undefined);
    await sending;

    await engine.sendAttachments(
      peer,
      [
        { file: new File(['one'], 'one.png', { type: 'image/png' }), sendAs: 'media' },
        { file: new File(['two'], 'two.png', { type: 'image/png' }), sendAs: 'media' },
      ],
      'Album',
    );
    const albumMessages = store.messages.filter(({ groupedId }) => groupedId === 'grouped');
    expect(albumMessages).toHaveLength(2);
    expect(albumMessages.every(({ randomId }) => Boolean(randomId))).toBe(true);
    expect(store.outbox).toEqual([]);
    await engine.stop();
  });

  it('keeps the last confirmed serialized setting when the newer intent fails', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    class PartiallyFailingMuteTransport extends FakeTransport {
      override async setMuted(_peer: TelegramPeer, muted: boolean) {
        const index = this.muteCalls.length;
        this.muteCalls.push(muted);
        await (index === 0 ? first.promise : second.promise);
      }
    }
    const transport = new PartiallyFailingMuteTransport();
    const engine = new MessagingEngine(transport, new MemoryStore());
    await engine.start(credentials);

    const enabling = engine.setMuted(peer, true);
    await vi.waitFor(() => expect(transport.muteCalls).toEqual([true]));
    const disabling = engine.setMuted(peer, false);
    first.resolve(undefined);
    await vi.waitFor(() => expect(transport.muteCalls).toEqual([true, false]));
    second.reject(new Error('newer intent failed'));
    await Promise.all([enabling, disabling]);

    expect(engine.snapshot().dialogs[0]?.muted).toBe(true);
    await engine.stop();
  });

  it('drains active account-A draft writes and cancels queued ones before resetting for B', async () => {
    const firstWriteStarted = deferred<void>();
    const releaseFirstWrite = deferred<void>();
    class SlowDraftStore extends MemoryStore {
      writes = 0;

      override async saveDraft(peerId: string, text: string, revision = 0) {
        this.writes += 1;
        if (this.writes === 1) {
          firstWriteStarted.resolve(undefined);
          await releaseFirstWrite.promise;
        }
        await super.saveDraft(peerId, text, revision);
      }
    }
    const store = new SlowDraftStore();
    store.accountId = 'account-a';
    const transport = new FakeTransport();
    transport.accountId = 'account-a';
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);

    const firstSave = engine.setDraft(peer.id, 'Writing on A');
    await firstWriteStarted.promise;
    const queuedSave = engine.setDraft(peer.id, 'Queued on A');
    transport.emit({ type: 'connection-state', connected: false });
    await vi.waitFor(() => expect(engine.snapshot().online).toBe(false));
    transport.accountId = 'account-b';
    const switching = engine.retrySync();
    await Promise.resolve();
    expect(store.accountId).toBe('account-a');

    releaseFirstWrite.resolve(undefined);
    await Promise.all([firstSave, queuedSave, switching]);

    expect(store.accountId).toBe('account-b');
    expect(store.drafts).toEqual({});
    await engine.stop();
  });

  it('does not run a queued account-A reaction intent after switching to account B', async () => {
    const firstReaction = deferred<TransportMutationResult>();
    class SlowReactionTransport extends FakeTransport {
      override async setReaction(_peer: TelegramPeer, messageId: number, emoji?: string) {
        this.reactionCalls.push({ messageId, ...(emoji ? { emoji } : {}) });
        return firstReaction.promise;
      }
    }
    const store = new MemoryStore();
    store.accountId = 'account-a';
    const transport = new SlowReactionTransport();
    transport.accountId = 'account-a';
    const engine = new MessagingEngine(transport, store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);

    const first = engine.toggleReaction(peer, 7, '👍');
    await vi.waitFor(() => expect(transport.reactionCalls).toHaveLength(1));
    const queued = engine.toggleReaction(peer, 7, '❤️');
    transport.emit({ type: 'connection-state', connected: false });
    await vi.waitFor(() => expect(engine.snapshot().online).toBe(false));
    transport.accountId = 'account-b';
    const switching = engine.retrySync();
    await Promise.resolve();
    firstReaction.resolve({});
    await Promise.all([first, queued, switching]);

    expect(transport.reactionCalls).toHaveLength(1);
    expect(store.accountId).toBe('account-b');
    expect(
      store.messages.some(({ reactions }) => reactions?.some(({ emoji }) => emoji === '❤️')),
    ).toBe(false);
    await engine.stop();
  });

  it('does not let an obsolete in-flight media download repopulate an invalidated cache key', async () => {
    const oldDownload = deferred<Blob>();
    const originalMessage: TelegramMessage = {
      ...dialog.topMessage!,
      media: { kind: 'photo', name: 'old.png', mimeType: 'image/png', size: 3 },
    };
    class SlowReplacedMediaTransport extends FakeTransport {
      override async getHistory() {
        return { messages: [originalMessage], hasOlder: false };
      }

      override downloadMedia() {
        return oldDownload.promise;
      }
    }
    const store = new MemoryStore();
    const engine = new MessagingEngine(new SlowReplacedMediaTransport(), store);
    await engine.start(credentials);
    await engine.selectChat(peer.id);
    const original = engine.snapshot().messages[0]!;
    const originalKey = engine.mediaAssetKey(original);
    const downloading = engine.downloadMedia(original);

    await engine.editMessage(peer, 7, 'Replaced', undefined, {
      file: new File(['new'], 'new.png', { type: 'image/png' }),
      sendAs: 'media',
    });
    oldDownload.resolve(new Blob(['old']));
    await downloading;

    expect(store.blobs.has(originalKey)).toBe(false);
    await engine.stop();
  });

  it('caches each Telegram wallpaper by id and coalesces concurrent downloads', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);

    const [first, concurrent] = await Promise.all([
      engine.downloadWallpaper('wallpaper-77'),
      engine.downloadWallpaper('wallpaper-77'),
    ]);
    const cached = await engine.downloadWallpaper('wallpaper-77');

    expect(transport.downloadWallpaperCalls).toBe(1);
    expect(await first.text()).toBe('wallpaper-77');
    expect(await concurrent.text()).toBe('wallpaper-77');
    expect(await cached.text()).toBe('wallpaper-77');
    expect(store.blobs.has('wallpaper:wallpaper-77')).toBe(true);
  });

  it('caches chat appearance metadata in memory and persistent storage', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const engine = new MessagingEngine(transport, store);

    const first = await engine.getChatAppearance(peer);
    const cached = await engine.getChatAppearance(peer);

    expect(first?.wallpaper?.id).toBe('wallpaper-appearance');
    expect(cached).toEqual(first);
    expect(transport.chatAppearanceCalls).toBe(1);
    expect(store.blobs.has(`chat-appearance:${peer.id}`)).toBe(true);

    const nextEngine = new MessagingEngine(transport, store);
    const persisted = await nextEngine.getChatAppearance(peer);
    expect(persisted).toEqual(first);
    expect(transport.chatAppearanceCalls).toBe(1);
  });

  it('replays persisted outbox peers concurrently while preserving each peer queue', async () => {
    const slowPeer: TelegramPeer = { id: 'peer-slow', kind: 'user' };
    const fastPeer: TelegramPeer = { id: 'peer-fast', kind: 'user' };
    const slowStarted = deferred<void>();
    const releaseSlow = deferred<void>();
    class ConcurrentReplayTransport extends FakeTransport {
      calls: string[] = [];

      override async sendText(target: TelegramPeer, text: string, randomId: string) {
        this.calls.push(target.id);
        if (target.id === slowPeer.id) {
          slowStarted.resolve(undefined);
          await releaseSlow.promise;
        }
        return {
          message: {
            id: target.id === slowPeer.id ? 8 : 9,
            peerId: target.id,
            senderId: 'self',
            text,
            date: 101,
            outgoing: true,
            randomId,
          },
        };
      }
    }
    const store = new MemoryStore();
    store.accountId = 'account-1';
    store.outbox = [
      {
        ...pendingSend('Slow replay', 1),
        id: 'slow-pending',
        peer: slowPeer,
        randomId: 'slow-random',
        queueOrder: 1,
      },
      {
        ...pendingSend('Fast replay', 2),
        id: 'fast-pending',
        peer: fastPeer,
        randomId: 'fast-random',
        queueOrder: 1,
      },
    ];
    const transport = new ConcurrentReplayTransport();
    const engine = new MessagingEngine(transport, store);

    const starting = engine.start(credentials);
    await slowStarted.promise;
    await vi.waitFor(() => expect(transport.calls).toContain(fastPeer.id));
    await vi.waitFor(() => expect(store.outbox.map(({ id }) => id)).toEqual(['slow-pending']));

    releaseSlow.resolve(undefined);
    await starting;
    expect(store.outbox).toEqual([]);
    await engine.stop();
  });
});
