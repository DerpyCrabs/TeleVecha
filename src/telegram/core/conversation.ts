import type {
  EditMediaOptions,
  EngineSnapshot,
  TelegramActivityKind,
  TelegramBotCallbackResult,
  TelegramBotCommand,
  TelegramHistoryGap,
  TelegramMessage,
  TelegramPeer,
  TelegramReplyTarget,
  TelegramSearchOffset,
  TelegramSearchPage,
  TelegramSticker,
  TelegramTextFormat,
  TelegramUserDetails,
  TelegramUrlAuthAcceptOptions,
  TelegramUrlAuthResult,
  SharedMediaKind,
} from '../types';

type Attachment = { file: File; sendAs: 'media' | 'file' };

interface ConversationHost {
  snapshot(): EngineSnapshot;
  setDraft(peerId: string, text: string): Promise<void>;
  setTyping(peer: TelegramPeer, kind?: TelegramActivityKind): Promise<void>;
  sendDraft(
    peer: TelegramPeer,
    text: string,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ): Promise<void>;
  sendAttachments(
    peer: TelegramPeer,
    attachments: Attachment[],
    caption?: string,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ): Promise<void>;
  editMessage(
    peer: TelegramPeer,
    messageId: number,
    text: string,
    formats?: TelegramTextFormat[],
    replacement?: EditMediaOptions,
  ): Promise<unknown>;
  getBotCommands(peer: TelegramPeer): Promise<TelegramBotCommand[]>;
  startBot(peer: TelegramPeer, startParam?: string): Promise<void>;
  answerBotCallback(
    peer: TelegramPeer,
    messageId: number,
    data: number[],
  ): Promise<TelegramBotCallbackResult | undefined>;
  requestUrlAuth(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
  ): Promise<TelegramUrlAuthResult | undefined>;
  acceptUrlAuth(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
    options?: TelegramUrlAuthAcceptOptions,
  ): Promise<TelegramUrlAuthResult | undefined>;
  sendSticker(
    peer: TelegramPeer,
    sticker: TelegramSticker,
    reply?: TelegramReplyTarget,
  ): Promise<void>;
  toggleReaction(peer: TelegramPeer, messageId: number, emoji: string): Promise<void>;
  deleteMessage(peer: TelegramPeer, messageId: number, revoke: boolean): Promise<unknown>;
  openMessage(message: TelegramMessage): Promise<boolean>;
  loadOlderMessages(): Promise<void>;
  retryHistory(): Promise<void>;
  loadHistoryGap(gap: TelegramHistoryGap): Promise<void>;
  searchMessages(
    query: string,
    global: boolean,
    offset?: TelegramSearchOffset,
  ): Promise<TelegramSearchPage>;
  getSharedMedia(kind: SharedMediaKind, offset?: TelegramSearchOffset): Promise<TelegramSearchPage>;
  forwardMessage(fromPeer: TelegramPeer, toPeer: TelegramPeer, messageId: number): Promise<void>;
  getUserDetails(peer: TelegramPeer): Promise<TelegramUserDetails>;
  setBlocked(peer: TelegramPeer, blocked: boolean): Promise<unknown>;
  setPinnedMessage(peer: TelegramPeer, messageId: number, pinned: boolean): Promise<unknown>;
}

/**
 * A selected conversation. Its interface binds peer identity once and rejects
 * commands after selection moves elsewhere, removing that ordering rule from
 * every caller.
 */
export class Conversation {
  constructor(
    private readonly host: ConversationHost,
    readonly peerId: string,
  ) {}

  private peer() {
    const snapshot = this.host.snapshot();
    if (snapshot.activePeerId !== this.peerId) {
      throw new Error('This conversation is no longer selected.');
    }
    const dialog = snapshot.dialogs.find(({ peer }) => peer.id === this.peerId);
    if (!dialog) throw new Error('This conversation is no longer available.');
    return dialog.peer;
  }

  setDraft(text: string) {
    this.peer();
    return this.host.setDraft(this.peerId, text);
  }

  setTyping(kind?: TelegramActivityKind) {
    return this.host.setTyping(this.peer(), kind);
  }

  sendDraft(text: string, reply?: TelegramReplyTarget, formats?: TelegramTextFormat[]) {
    return this.host.sendDraft(this.peer(), text, reply, formats);
  }

  sendAttachments(
    attachments: Attachment[],
    caption?: string,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ) {
    return this.host.sendAttachments(this.peer(), attachments, caption, reply, formats);
  }

  editMessage(
    messageId: number,
    text: string,
    formats?: TelegramTextFormat[],
    replacement?: EditMediaOptions,
  ) {
    return this.host.editMessage(this.peer(), messageId, text, formats, replacement);
  }

  getBotCommands() {
    return this.host.getBotCommands(this.peer());
  }

  startBot(startParam = '') {
    return this.host.startBot(this.peer(), startParam);
  }

  answerBotCallback(messageId: number, data: number[]) {
    return this.host.answerBotCallback(this.peer(), messageId, data);
  }

  requestUrlAuth(messageId: number, buttonId: number) {
    return this.host.requestUrlAuth(this.peer(), messageId, buttonId);
  }

  acceptUrlAuth(messageId: number, buttonId: number, options?: TelegramUrlAuthAcceptOptions) {
    return this.host.acceptUrlAuth(this.peer(), messageId, buttonId, options);
  }

  sendSticker(sticker: TelegramSticker, reply?: TelegramReplyTarget) {
    return this.host.sendSticker(this.peer(), sticker, reply);
  }

  toggleReaction(messageId: number, emoji: string) {
    return this.host.toggleReaction(this.peer(), messageId, emoji);
  }

  deleteMessage(messageId: number, revoke: boolean) {
    return this.host.deleteMessage(this.peer(), messageId, revoke);
  }

  openMessage(message: TelegramMessage) {
    if (message.peerId !== this.peerId) throw new Error('The message belongs to another chat.');
    this.peer();
    return this.host.openMessage(message);
  }

  loadOlder() {
    this.peer();
    return this.host.loadOlderMessages();
  }

  retryHistory() {
    this.peer();
    return this.host.retryHistory();
  }

  loadGap(gap: TelegramHistoryGap) {
    this.peer();
    return this.host.loadHistoryGap(gap);
  }

  search(query: string, global: boolean, offset?: TelegramSearchOffset) {
    this.peer();
    return this.host.searchMessages(query, global, offset);
  }

  sharedMedia(kind: SharedMediaKind, offset?: TelegramSearchOffset) {
    this.peer();
    return this.host.getSharedMedia(kind, offset);
  }

  forwardTo(target: TelegramPeer, messageId: number) {
    return this.host.forwardMessage(this.peer(), target, messageId);
  }

  userDetails() {
    return this.host.getUserDetails(this.peer());
  }

  setBlocked(blocked: boolean) {
    return this.host.setBlocked(this.peer(), blocked);
  }

  setPinnedMessage(messageId: number, pinned: boolean) {
    return this.host.setPinnedMessage(this.peer(), messageId, pinned);
  }
}
