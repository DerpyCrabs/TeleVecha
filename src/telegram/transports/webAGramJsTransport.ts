import { telegramPeerColor } from '../../domain/peerColor';
import type { RichBlock, RichCaption, RichText } from '../../domain/richMessage';
import { reportDiagnostic } from '../core/diagnostics';
import type { CacheStore } from '../persistence/store';
import type {
  ChannelDifferenceResult,
  DialogPage,
  DifferenceResult,
  EditMessageResult,
  EditMediaOptions,
  HistoryPage,
  OutgoingAttachmentMode,
  SendAlbumAttachment,
  SendAlbumOptions,
  SendFileOptions,
  SendTextResult,
  SharedMediaKind,
  SyncCursor,
  TelegramBotButton,
  TelegramBotCallbackResult,
  TelegramBotCommand,
  TelegramBotKeyboard,
  TelegramCredentials,
  TelegramActivityKind,
  TelegramDialog,
  TelegramLink,
  TelegramMessage,
  TelegramPeer,
  TelegramPeerSearchResult,
  TelegramReaction,
  TelegramReplyTarget,
  TelegramSearchOffset,
  TelegramSearchPage,
  TelegramSticker,
  TelegramStickerPack,
  TelegramTextFormat,
  TelegramTransport,
  TelegramUserDetails,
  TelegramUrlAuthAcceptOptions,
  TelegramUrlAuthResult,
  TransportMutationResult,
  TransportUpdate,
  TransportUpdateBatch,
} from '../types';
import { computeCheck } from '../../vendor/weba/src/lib/gramjs/Password';
import TelegramClient, {
  type Update as GramUpdate,
} from '../../vendor/weba/src/lib/gramjs/client/TelegramClient';
import { RPCError } from '../../vendor/weba/src/lib/gramjs/errors';
import CallbackSession from '../../vendor/weba/src/lib/gramjs/sessions/CallbackSession';
import Session from '../../vendor/weba/src/lib/gramjs/sessions/Abstract';
import { Api } from '../../vendor/weba/src/lib/gramjs/tl';
import { Logger } from '../../vendor/weba/src/lib/gramjs/extensions';
import {
  UpdateConnectionState,
  UpdateSessionGap,
} from '../../vendor/weba/src/lib/gramjs/network/updates';
import type { SessionData } from '../../vendor/weba/src/lib/gramjs/types';

type AuthResult = 'authorized' | 'password-required' | 'sign-up-required';

const MAX_MESSAGE_MEDIA_ENTRIES = 1_000;
const MAX_STICKER_DOCUMENT_ENTRIES = 512;
const MAX_ENTITY_ENTRIES = 2_000;
const CONNECTION_LOSS_GRACE_MS = 5_000;

export class WebAGramJsTransport implements TelegramTransport {
  private client: TelegramClient | undefined;
  private connectionGeneration = 0;
  private connecting: Promise<void> | undefined;
  private phoneNumber = '';
  private phoneCodeHash = '';
  private readonly listeners = new Set<(batch: TransportUpdateBatch) => void>();
  private readonly messageMedia = new Map<string, Api.TypeMessageMedia>();
  private readonly linkPreviewPhotos = new Map<string, Api.Photo>();
  private readonly stickerDocuments = new Map<string, Api.Document>();
  private readonly entities = new Map<string, Api.TypeUser | Api.TypeChat>();
  private readonly channelSenderRoles = new Map<
    string,
    { label: string; kind: 'owner' | 'admin' }
  >();
  private readonly channelRolesLoaded = new Set<string>();
  private readonly channelRolesLoading = new Map<string, Promise<void>>();
  private readonly notifyDefaults = new Map<
    'users' | 'groups' | 'channels',
    Api.TypePeerNotifySettings
  >();
  private notifyDefaultsLoading: Promise<void> | undefined;
  private notifyDefaultsLoaded = false;
  private sessionSave = Promise.resolve();
  private sessionSaveError: unknown;
  private eventHandlerClient: TelegramClient | undefined;
  private connectionLossTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: Pick<CacheStore, 'loadTransportSession' | 'saveTransportSession'>,
  ) {}

  async connect(credentials: TelegramCredentials) {
    if (this.connecting) return this.connecting;
    if (this.client?.isConnected()) {
      await this.flushSessionSave();
      return;
    }
    const generation = ++this.connectionGeneration;
    this.clearConnectionLossTimer();
    const connecting = this.connectClient(credentials, generation);
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }

  private async connectClient(credentials: TelegramCredentials, generation: number) {
    Logger.setLevel('error');

    const stored = (await this.store.loadTransportSession()) as SessionData | undefined;
    if (generation !== this.connectionGeneration) {
      throw new Error('Telegram connection attempt was superseded.');
    }
    const session = new CallbackSession(stored, (next) => {
      this.sessionSave = this.sessionSave.then(async () => {
        try {
          await this.store.saveTransportSession(next);
          this.sessionSaveError = undefined;
        } catch (error) {
          this.sessionSaveError = error;
          reportDiagnostic({
            level: 'error',
            area: 'cache',
            message: 'Could not persist the Telegram authorization session.',
            details: { error: error instanceof Error ? error.message : String(error) },
          });
        }
      });
    });
    const client = new TelegramClient(
      session as unknown as Session,
      credentials.apiId,
      credentials.apiHash,
      {
        baseLogger: new Logger('error'),
        appVersion: '0.1.0',
        deviceModel: 'TeleVecha',
        systemVersion: navigator.userAgent,
        langCode: navigator.language.split('-')[0] || 'en',
        systemLangCode: navigator.language,
        langPack: '',
        useWSS: true,
        connectionRetries: 2,
        requestRetries: 5,
        autoReconnect: true,
      },
    );
    if (generation !== this.connectionGeneration) {
      client.disconnect();
      throw new Error('Telegram connection attempt was superseded.');
    }
    this.client = client;
    try {
      await client.connect();
      await this.flushSessionSave();
    } catch (error) {
      const isCurrent = generation === this.connectionGeneration && this.client === client;
      if (this.client === client) this.client = undefined;
      client.disconnect();
      if (isCurrent) this.clearRuntimeCaches();
      throw error;
    }
    if (generation !== this.connectionGeneration || this.client !== client) {
      client.disconnect();
      throw new Error('Telegram connection attempt was superseded.');
    }
    this.installEventHandler(client, generation);
  }

  async disconnect() {
    const generation = ++this.connectionGeneration;
    this.clearConnectionLossTimer();
    const connecting = this.connecting;
    const client = this.client;
    this.client = undefined;
    client?.disconnect();
    if (connecting) await connecting.catch(() => undefined);
    let sessionError: unknown;
    try {
      await this.flushSessionSave();
    } catch (error) {
      sessionError = error;
    }
    if (generation === this.connectionGeneration) this.clearRuntimeCaches();
    if (sessionError) throw sessionError;
  }

  async logOut() {
    const client = this.getClient();
    await client.invoke(new Api.auth.LogOut());
    await this.store.saveTransportSession(undefined);
  }

  async isAuthorized() {
    try {
      await this.getClient().invoke(new Api.updates.GetState());
      return true;
    } catch (error) {
      if (
        error instanceof RPCError &&
        ['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED'].includes(error.errorMessage)
      ) {
        return false;
      }
      throw error;
    }
  }

  async getAuthorizedAccountId() {
    const self = await this.getClient().getMe();
    if (!(self instanceof Api.User)) {
      throw new Error('Telegram did not return the authorized account.');
    }
    return self.id.toString();
  }

  async requestCode(phoneNumber: string) {
    this.phoneNumber = phoneNumber.replace(/[^+\d]/g, '');
    const client = this.getClient();
    const sent = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: this.phoneNumber,
        apiId: client.apiId,
        apiHash: client.apiHash,
        settings: new Api.CodeSettings(),
      }),
    );
    if (!(sent instanceof Api.auth.SentCode)) {
      throw new Error('Telegram returned an unexpected login response.');
    }
    this.phoneCodeHash = sent.phoneCodeHash;
    return { isCodeViaApp: sent.type instanceof Api.auth.SentCodeTypeApp };
  }

  async submitCode(code: string): Promise<AuthResult> {
    if (!this.phoneNumber || !this.phoneCodeHash) {
      throw new Error('Request a login code first.');
    }
    try {
      const result = await this.getClient().invoke(
        new Api.auth.SignIn({
          phoneNumber: this.phoneNumber,
          phoneCodeHash: this.phoneCodeHash,
          phoneCode: code.trim(),
        }),
      );
      if (result instanceof Api.auth.AuthorizationSignUpRequired) return 'sign-up-required';
      await this.flushSessionSave();
      return 'authorized';
    } catch (error) {
      if (error instanceof RPCError && error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        return 'password-required';
      }
      throw error;
    }
  }

  async submitPassword(password: string) {
    const client = this.getClient();
    const state = await client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(state, password);
    await client.invoke(new Api.auth.CheckPassword({ password: check }));
    await this.flushSessionSave();
  }

  async getCurrentState() {
    return this.mapCursor(await this.getClient().invoke(new Api.updates.GetState()));
  }

  async getDifference(cursor: SyncCursor, totalLimit: number): Promise<DifferenceResult> {
    const updates: TransportUpdate[] = [];
    let current = cursor;

    for (;;) {
      const result = await this.getClient().invoke(
        new Api.updates.GetDifference({
          pts: current.pts,
          ptsLimit: totalLimit,
          ptsTotalLimit: totalLimit,
          date: current.date,
          qts: current.qts,
          qtsLimit: totalLimit,
        }),
      );

      if (result instanceof Api.updates.DifferenceTooLong) {
        return { type: 'too-long', cursor: await this.getCurrentState() };
      }
      if (result instanceof Api.updates.DifferenceEmpty) {
        return {
          type: 'complete',
          cursor: { ...current, date: result.date, seq: result.seq },
          updates,
        };
      }

      this.rememberEntities(result.users, result.chats);

      for (const message of result.newMessages) {
        const mapped = this.mapMessage(message);
        if (mapped) {
          updates.push({ type: 'new-message', pts: current.pts, ptsCount: 0, message: mapped });
        }
      }
      for (const update of result.otherUpdates) {
        updates.push(...this.mapUpdate(update));
      }

      if (updates.length > totalLimit) {
        return { type: 'too-long', cursor: await this.getCurrentState() };
      }

      if (result instanceof Api.updates.DifferenceSlice) {
        if (updates.length >= totalLimit) {
          return { type: 'too-long', cursor: await this.getCurrentState() };
        }
        current = this.mapCursor(result.intermediateState);
        continue;
      }
      return {
        type: 'complete',
        cursor: this.mapCursor(result.state),
        updates,
      };
    }
  }

  async getChannelDifference(
    peer: TelegramPeer,
    pts: number,
    totalLimit: number,
  ): Promise<ChannelDifferenceResult> {
    if (peer.kind !== 'channel') throw new Error('Channel recovery requires a channel peer.');
    const updates: TransportUpdate[] = [];
    let currentPts = pts;

    for (let page = 0; page < 100; page += 1) {
      const remaining = totalLimit - updates.length;
      if (remaining <= 0) return { type: 'too-long', pts: currentPts };
      const result = await this.getClient().invoke(
        new Api.updates.GetChannelDifference({
          force: true,
          channel: this.inputChannel(peer),
          filter: new Api.ChannelMessagesFilterEmpty(),
          pts: currentPts,
          limit: Math.max(1, Math.min(100, remaining)),
        }),
      );

      if (result instanceof Api.updates.ChannelDifferenceTooLong) {
        const nextPts = result.dialog instanceof Api.Dialog ? result.dialog.pts : undefined;
        return { type: 'too-long', pts: nextPts ?? currentPts };
      }
      if (result instanceof Api.updates.ChannelDifferenceEmpty) {
        if (result.final || result.pts === currentPts) {
          return { type: 'complete', pts: result.pts, updates };
        }
        currentPts = result.pts;
        continue;
      }

      this.rememberEntities(result.users, result.chats);
      for (const message of result.newMessages) {
        const mapped = this.mapMessage(message);
        if (mapped) {
          updates.push({
            type: 'new-message',
            pts: result.pts,
            ptsCount: 0,
            channelScoped: true,
            message: mapped,
          });
        }
      }
      for (const update of result.otherUpdates) updates.push(...this.mapUpdate(update));
      if (updates.length > totalLimit) return { type: 'too-long', pts: result.pts };
      if (result.final || result.pts === currentPts) {
        return { type: 'complete', pts: result.pts, updates };
      }
      currentPts = result.pts;
    }

    return { type: 'too-long', pts: currentPts };
  }

  async getDialogs(limit: number): Promise<DialogPage> {
    const totalLimit = Math.max(0, limit);
    if (totalLimit === 0) return { dialogs: [] };
    const dialogs = new Map<string, TelegramDialog>();
    const notifySettingsByPeer = new Map<string, Api.TypePeerNotifySettings>();
    for (const folderId of [0, 1]) {
      let offsetDate = 0;
      let offsetId = 0;
      let offsetPeer: Api.TypeInputPeer = new Api.InputPeerEmpty();
      const seenOffsets = new Set<string>();

      while (dialogs.size < totalLimit) {
        const pageSize = Math.max(1, Math.min(100, totalLimit - dialogs.size));
        const result = await this.getClient().invoke(
          new Api.messages.GetDialogs({
            folderId,
            offsetDate,
            offsetId,
            offsetPeer,
            limit: pageSize,
            hash: 0n,
          }),
        );
        if (result instanceof Api.messages.DialogsNotModified) break;
        this.rememberEntities(result.users, result.chats);

        const messages = new Map<string, TelegramMessage>();
        for (const message of result.messages) {
          const mapped = this.mapMessage(message);
          if (mapped) messages.set(`${mapped.peerId}:${mapped.id}`, mapped);
        }
        const entities = this.entityMap(result.users, result.chats);
        const rawDialogs = result.dialogs.filter(
          (item): item is Api.Dialog =>
            item instanceof Api.Dialog &&
            (folderId === 1 ? item.folderId === 1 : item.folderId !== 1),
        );
        for (const item of rawDialogs) {
          const dialog = this.mapDialog(item, entities, messages);
          if (dialog) {
            dialogs.set(dialog.peer.id, dialog);
            notifySettingsByPeer.set(dialog.peer.id, item.notifySettings);
          }
        }
        if (result.dialogs.length < pageSize || dialogs.size >= totalLimit) break;

        const last = rawDialogs.at(-1);
        const peer = last ? this.mapPeer(last.peer, entities) : undefined;
        if (!last || !peer) break;
        const topMessage = result.messages.find(
          (message): message is Api.Message | Api.MessageService =>
            (message instanceof Api.Message || message instanceof Api.MessageService) &&
            message.id === last.topMessage &&
            this.peerId(message.peerId) === peer.id,
        );
        const nextOffset = `${peer.id}:${last.topMessage}:${topMessage?.date ?? 0}`;
        if (seenOffsets.has(nextOffset)) break;
        seenOffsets.add(nextOffset);
        offsetId = last.topMessage;
        offsetDate = topMessage?.date ?? 0;
        offsetPeer = this.inputPeer(peer);
      }
    }
    await this.ensureNotifyDefaults();
    return {
      dialogs: [...dialogs.values()].slice(0, totalLimit).map((dialog) => ({
        ...dialog,
        muted: this.isMuted(
          notifySettingsByPeer.get(dialog.peer.id),
          dialog.peer,
          this.entities.get(dialog.peer.id),
        ),
      })),
    };
  }

  async searchPeers(query: string, limit = 50): Promise<TelegramPeerSearchResult[]> {
    const term = query.trim();
    if (!term || limit <= 0) return [];
    const result = await this.getClient().invoke(
      new Api.contacts.Search({ q: term, limit, broadcasts: true, bots: true }),
    );
    this.rememberEntities(result.users, result.chats);
    const entities = this.entityMap(result.users, result.chats);
    const found: TelegramPeerSearchResult[] = [];
    const seen = new Set<string>();
    for (const candidate of [...result.myResults, ...result.results]) {
      const peer = this.mapPeer(candidate, entities);
      if (!peer || seen.has(peer.id)) continue;
      const entity = entities.get(peer.id);
      const title = this.entityTitle(entity) || peer.id;
      const photo =
        entity instanceof Api.User
          ? entity.photo instanceof Api.UserProfilePhoto
            ? entity.photo
            : undefined
          : entity instanceof Api.Chat || entity instanceof Api.Channel
            ? entity.photo instanceof Api.ChatPhoto
              ? entity.photo
              : undefined
            : undefined;
      seen.add(peer.id);
      found.push({
        peer,
        category:
          entity instanceof Api.User
            ? entity.bot
              ? 'bot'
              : 'user'
            : entity instanceof Api.Channel && entity.broadcast
              ? 'channel'
              : 'group',
        title,
        initials: this.initials(title),
        color: this.peerColor(peer.id, entity),
        username:
          entity instanceof Api.User || entity instanceof Api.Channel ? entity.username : undefined,
        bot: entity instanceof Api.User && Boolean(entity.bot),
        isContact: entity instanceof Api.User && Boolean(entity.contact),
        hasAvatar: Boolean(photo),
        avatarId: photo?.photoId.toString(),
      });
      if (found.length >= limit) break;
    }
    return found;
  }

  async getDialog(peer: TelegramPeer): Promise<TelegramDialog | undefined> {
    const result = await this.getClient().invoke(
      new Api.messages.GetPeerDialogs({
        peers: [new Api.InputDialogPeer({ peer: this.inputPeer(peer) })],
      }),
    );
    this.rememberEntities(result.users, result.chats);
    const messages = new Map<string, TelegramMessage>();
    for (const message of result.messages) {
      const mapped = this.mapMessage(message);
      if (mapped) messages.set(`${mapped.peerId}:${mapped.id}`, mapped);
    }
    const entities = this.entityMap(result.users, result.chats);
    const item = result.dialogs.find(
      (candidate): candidate is Api.Dialog =>
        candidate instanceof Api.Dialog && this.peerId(candidate.peer) === peer.id,
    );
    await this.ensureNotifyDefaults();
    return item ? this.mapDialog(item, entities, messages) : undefined;
  }

  async getHistory(
    peer: TelegramPeer,
    limit: number,
    beforeMessageId?: number,
  ): Promise<HistoryPage> {
    const result = await this.getClient().invoke(
      new Api.messages.GetHistory({
        peer: this.inputPeer(peer),
        offsetId: beforeMessageId ?? 0,
        offsetDate: 0,
        addOffset: 0,
        limit: limit + 1,
        maxId: 0,
        minId: 0,
        hash: 0n,
      }),
    );
    if (result instanceof Api.messages.MessagesNotModified) {
      return { messages: [], hasOlder: false };
    }
    this.rememberEntities(result.users, result.chats);
    const rawMessages = result.messages;
    const displayedRawMessages = rawMessages.slice(0, limit);
    await this.ensureChannelSenderRoles(
      peer,
      displayedRawMessages.flatMap((message) => {
        const senderId = 'fromId' in message ? this.peerId(message.fromId) : undefined;
        return senderId ? [senderId] : [];
      }),
    );
    const messages = displayedRawMessages
      .map((message) => this.mapMessage(message))
      .filter((message): message is TelegramMessage => Boolean(message));
    const ids = displayedRawMessages.flatMap((message) => ('id' in message ? [message.id] : []));
    return {
      messages,
      hasOlder: rawMessages.length > 0,
      nextBeforeMessageId: ids.length > 0 ? Math.min(...ids) : beforeMessageId,
    };
  }

  async getHistoryAround(peer: TelegramPeer, messageId: number, limit: number) {
    const result = await this.getClient().invoke(
      new Api.messages.GetHistory({
        peer: this.inputPeer(peer),
        offsetId: messageId,
        offsetDate: 0,
        addOffset: -Math.floor(limit / 2),
        limit,
        maxId: 0,
        minId: 0,
        hash: 0n,
      }),
    );
    if (result instanceof Api.messages.MessagesNotModified) return [];
    this.rememberEntities(result.users, result.chats);
    await this.ensureChannelSenderRoles(
      peer,
      result.messages.flatMap((message) => {
        const senderId = 'fromId' in message ? this.peerId(message.fromId) : undefined;
        return senderId ? [senderId] : [];
      }),
    );
    return result.messages
      .map((candidate) => this.mapMessage(candidate))
      .filter((candidate): candidate is TelegramMessage => Boolean(candidate));
  }

  async readHistory(peer: TelegramPeer, maxMessageId: number): Promise<TransportMutationResult> {
    if (peer.kind === 'channel') {
      await this.getClient().invoke(
        new Api.channels.ReadHistory({
          channel: this.inputChannel(peer),
          maxId: maxMessageId,
        }),
      );
      return {};
    }
    const result = await this.getClient().invoke(
      new Api.messages.ReadHistory({
        peer: this.inputPeer(peer),
        maxId: maxMessageId,
      }),
    );
    return {
      updateBatches: [
        {
          updates: [
            {
              type: 'read-history',
              pts: result.pts,
              ptsCount: result.ptsCount,
              peerId: peer.id,
              maxMessageId,
              direction: 'inbox',
            },
          ],
        },
      ],
    };
  }

  async getReadOutboxMaxId(peer: TelegramPeer) {
    const result = await this.getClient().invoke(
      new Api.messages.GetPeerDialogs({
        peers: [new Api.InputDialogPeer({ peer: this.inputPeer(peer) })],
      }),
    );
    const dialog = result.dialogs.find(
      (candidate): candidate is Api.Dialog =>
        candidate instanceof Api.Dialog && this.peerId(candidate.peer) === peer.id,
    );
    return dialog?.readOutboxMaxId ?? 0;
  }

  async getSharedMediaCounts(peer: TelegramPeer) {
    const count = async (filter: Api.TypeMessagesFilter) => {
      const result = await this.getClient().invoke(
        new Api.messages.Search({
          peer: this.inputPeer(peer),
          q: '',
          filter,
          minDate: 0,
          maxDate: 0,
          offsetId: 0,
          addOffset: 0,
          limit: 1,
          maxId: 0,
          minId: 0,
          hash: 0n,
        }),
      );
      if (!(result instanceof Api.messages.MessagesNotModified)) {
        this.rememberEntities(result.users, result.chats);
      }
      return 'count' in result ? result.count : result.messages.length;
    };
    const [media, files, links] = await Promise.all([
      count(new Api.InputMessagesFilterPhotoVideo()),
      count(new Api.InputMessagesFilterDocument()),
      count(new Api.InputMessagesFilterUrl()),
    ]);
    return { media, files, links };
  }

  async getSharedMedia(
    peer: TelegramPeer,
    kind: SharedMediaKind,
    limit: number,
    offset?: TelegramSearchOffset,
  ): Promise<TelegramSearchPage> {
    const filters = {
      media: new Api.InputMessagesFilterPhotoVideo(),
      files: new Api.InputMessagesFilterDocument(),
      links: new Api.InputMessagesFilterUrl(),
    } satisfies Record<SharedMediaKind, Api.TypeMessagesFilter>;
    const result = await this.getClient().invoke(
      new Api.messages.Search({
        peer: this.inputPeer(peer),
        q: '',
        filter: filters[kind],
        minDate: 0,
        maxDate: 0,
        offsetId: offset?.messageId ?? 0,
        addOffset: 0,
        limit: limit + 1,
        maxId: 0,
        minId: 0,
        hash: 0n,
      }),
    );
    if (result instanceof Api.messages.MessagesNotModified) {
      return { messages: [], hasMore: false };
    }
    this.rememberEntities(result.users, result.chats);
    return this.mapSearchPage(result, limit, false);
  }

  async searchMessages(
    query: string,
    peer?: TelegramPeer,
    limit = 50,
    offset?: TelegramSearchOffset,
  ) {
    const result = peer
      ? await this.getClient().invoke(
          new Api.messages.Search({
            peer: this.inputPeer(peer),
            q: query,
            filter: new Api.InputMessagesFilterEmpty(),
            minDate: 0,
            maxDate: 0,
            offsetId: offset?.messageId ?? 0,
            addOffset: 0,
            limit: limit + 1,
            maxId: 0,
            minId: 0,
            hash: 0n,
          }),
        )
      : await this.getClient().invoke(
          new Api.messages.SearchGlobal({
            q: query,
            filter: new Api.InputMessagesFilterEmpty(),
            minDate: 0,
            maxDate: 0,
            offsetRate: offset?.rate ?? 0,
            offsetPeer: offset?.peer ? this.inputPeer(offset.peer) : new Api.InputPeerEmpty(),
            offsetId: offset?.messageId ?? 0,
            limit,
          }),
        );
    if (result instanceof Api.messages.MessagesNotModified) {
      return { messages: [], hasMore: false };
    }
    this.rememberEntities(result.users, result.chats);
    return this.mapSearchPage(result, limit, !peer);
  }

  async getPinnedMessages(peer: TelegramPeer) {
    const result = await this.getClient().invoke(
      new Api.messages.Search({
        peer: this.inputPeer(peer),
        q: '',
        filter: new Api.InputMessagesFilterPinned(),
        minDate: 0,
        maxDate: 0,
        offsetId: 0,
        addOffset: 0,
        limit: 50,
        maxId: 0,
        minId: 0,
        hash: 0n,
      }),
    );
    if (result instanceof Api.messages.MessagesNotModified) return [];
    this.rememberEntities(result.users, result.chats);
    return result.messages
      .map((message) => this.mapMessage(message))
      .filter((message): message is TelegramMessage => Boolean(message));
  }

  async setMuted(peer: TelegramPeer, muted: boolean) {
    await this.getClient().invoke(
      new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer: this.inputPeer(peer) }),
        settings: new Api.InputPeerNotifySettings({ muteUntil: muted ? 2_147_483_647 : 0 }),
      }),
    );
  }

  async getUserDetails(peer: TelegramPeer): Promise<TelegramUserDetails> {
    if (peer.kind !== 'user') throw new Error('User details require a user peer.');
    const result = await this.getClient().invoke(
      new Api.users.GetFullUser({ id: this.inputUser(peer) }),
    );
    this.rememberEntities(result.users, result.chats);
    const user = result.users.find(
      (candidate): candidate is Api.User =>
        candidate instanceof Api.User && candidate.id.toString() === peer.id.slice(2),
    );
    return {
      firstName: user?.firstName,
      lastName: user?.lastName,
      phone: user?.phone,
      username: user?.username,
      bio: result.fullUser instanceof Api.UserFull ? result.fullUser.about : undefined,
      birthday:
        result.fullUser instanceof Api.UserFull && result.fullUser.birthday instanceof Api.Birthday
          ? {
              day: result.fullUser.birthday.day,
              month: result.fullUser.birthday.month,
              ...(result.fullUser.birthday.year ? { year: result.fullUser.birthday.year } : {}),
            }
          : undefined,
      isContact: Boolean(user?.contact),
      blocked: result.fullUser instanceof Api.UserFull && Boolean(result.fullUser.blocked),
    };
  }

  async updateContact(peer: TelegramPeer, firstName: string, lastName: string, phone: string) {
    if (peer.kind !== 'user') throw new Error('Only users can be contacts.');
    await this.getClient().invoke(
      new Api.contacts.AddContact({
        id: this.inputUser(peer),
        firstName,
        lastName,
        phone,
      }),
    );
  }

  async deleteContact(peer: TelegramPeer) {
    if (peer.kind !== 'user') throw new Error('Only users can be contacts.');
    await this.getClient().invoke(new Api.contacts.DeleteContacts({ id: [this.inputUser(peer)] }));
  }

  async getGroupMembers(peer: TelegramPeer, limit = 50) {
    if (peer.kind === 'user') return [];
    if (peer.kind === 'channel') {
      const result = await this.getClient().invoke(
        new Api.channels.GetParticipants({
          channel: this.inputChannel(peer),
          filter: new Api.ChannelParticipantsRecent(),
          offset: 0,
          limit,
          hash: 0n,
        }),
      );
      if (!(result instanceof Api.channels.ChannelParticipants)) return [];
      this.rememberEntities(result.users, result.chats);
      const participants = new Map(
        result.participants.flatMap((participant) =>
          'userId' in participant ? [[participant.userId.toString(), participant] as const] : [],
        ),
      );
      return result.users.flatMap((user) => {
        if (!(user instanceof Api.User)) return [];
        const participant = participants.get(user.id.toString());
        const role =
          participant instanceof Api.ChannelParticipantCreator
            ? { role: participant.rank?.trim() || 'owner', roleKind: 'owner' as const }
            : participant instanceof Api.ChannelParticipantAdmin
              ? { role: participant.rank?.trim() || 'admin', roleKind: 'admin' as const }
              : {};
        return [this.mapGroupMember(user, role)];
      });
    }
    const result = await this.getClient().invoke(
      new Api.messages.GetFullChat({ chatId: BigInt(peer.id.slice(2)) }),
    );
    this.rememberEntities(result.users, result.chats);
    const participants =
      result.fullChat instanceof Api.ChatFull &&
      result.fullChat.participants instanceof Api.ChatParticipants
        ? result.fullChat.participants.participants
        : [];
    const participantById = new Map(
      participants.map((participant) => [participant.userId.toString(), participant] as const),
    );
    return result.users.slice(0, limit).flatMap((user) => {
      if (!(user instanceof Api.User)) return [];
      const participant = participantById.get(user.id.toString());
      const role =
        participant instanceof Api.ChatParticipantCreator
          ? { role: participant.rank?.trim() || 'owner', roleKind: 'owner' as const }
          : participant instanceof Api.ChatParticipantAdmin
            ? { role: participant.rank?.trim() || 'admin', roleKind: 'admin' as const }
            : {};
      return [this.mapGroupMember(user, role)];
    });
  }

  async setBlocked(peer: TelegramPeer, blocked: boolean) {
    if (peer.kind !== 'user') throw new Error('Only users can be blocked.');
    const request = blocked
      ? new Api.contacts.Block({ id: this.inputPeer(peer) })
      : new Api.contacts.Unblock({ id: this.inputPeer(peer) });
    await this.getClient().invoke(request);
  }

  async setPinnedDialog(peer: TelegramPeer, pinned: boolean) {
    await this.getClient().invoke(
      new Api.messages.ToggleDialogPin({
        peer: new Api.InputDialogPeer({ peer: this.inputPeer(peer) }),
        ...(pinned ? { pinned: true as const } : {}),
      }),
    );
  }

  async setArchived(peer: TelegramPeer, archived: boolean): Promise<TransportMutationResult> {
    const result = await this.getClient().invoke(
      new Api.folders.EditPeerFolders({
        folderPeers: [
          new Api.InputFolderPeer({ peer: this.inputPeer(peer), folderId: archived ? 1 : 0 }),
        ],
      }),
    );
    return { updateBatches: this.updateBatches(result) };
  }

  async deleteDialog(peer: TelegramPeer): Promise<TransportMutationResult> {
    if (peer.kind === 'channel') {
      const result = await this.getClient().invoke(
        new Api.channels.LeaveChannel({ channel: this.inputChannel(peer) }),
      );
      return { updateBatches: this.updateBatches(result) };
    }
    if (peer.kind === 'group') {
      const result = await this.getClient().invoke(
        new Api.messages.DeleteChatUser({
          chatId: BigInt(peer.id.slice(2)),
          userId: new Api.InputUserSelf(),
        }),
      );
      return { updateBatches: this.updateBatches(result) };
    }
    const updateBatches: TransportUpdateBatch[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await this.getClient().invoke(
        new Api.messages.DeleteHistory({ peer: this.inputPeer(peer), maxId: 0 }),
      );
      updateBatches.push({
        updates: [{ type: 'pts-advanced', pts: result.pts, ptsCount: result.ptsCount }],
      });
      if (result.offset <= 0) return { updateBatches };
    }
    throw new Error('Telegram did not finish deleting the chat history.');
  }

  async setPinnedMessage(
    peer: TelegramPeer,
    messageId: number,
    pinned: boolean,
  ): Promise<TransportMutationResult> {
    const result = await this.getClient().invoke(
      new Api.messages.UpdatePinnedMessage({
        peer: this.inputPeer(peer),
        id: messageId,
        silent: true,
        ...(pinned ? {} : { unpin: true as const }),
      }),
    );
    return { updateBatches: this.updateBatches(result) };
  }

  async setTyping(peer: TelegramPeer, kind?: TelegramActivityKind) {
    const action = !kind
      ? new Api.SendMessageCancelAction()
      : kind === 'uploading'
        ? new Api.SendMessageUploadDocumentAction({ progress: 0 })
        : kind === 'recording'
          ? new Api.SendMessageRecordAudioAction()
          : kind === 'choosing-sticker'
            ? new Api.SendMessageChooseStickerAction()
            : new Api.SendMessageTypingAction();
    await this.getClient().invoke(
      new Api.messages.SetTyping({ peer: this.inputPeer(peer), action }),
    );
  }

  async sendText(
    peer: TelegramPeer,
    text: string,
    randomId: string,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ): Promise<SendTextResult> {
    const result = await this.getClient().invoke(
      new Api.messages.SendMessage({
        peer: this.inputPeer(peer),
        message: text,
        randomId: BigInt(randomId),
        ...(reply ? { replyTo: this.inputReply(reply) } : {}),
        ...(formats?.length ? { entities: this.inputEntities(formats) } : {}),
      }),
    );
    if (result instanceof Api.UpdateShortSentMessage) {
      return this.mapShortSentMessage(peer, text, randomId, result, reply, formats);
    }
    const message = this.messagesFromUpdates(result)
      .map((candidate) => this.mapMessage(candidate))
      .find((candidate): candidate is TelegramMessage => Boolean(candidate));
    if (message) {
      const sentMessage = { ...message, randomId };
      return {
        message: sentMessage,
        updateBatches: this.updateBatches(result, [sentMessage]),
      };
    }
    throw new Error('Telegram accepted the send but returned no message.');
  }

  async sendFile(
    peer: TelegramPeer,
    file: File,
    options: SendFileOptions,
  ): Promise<SendTextResult> {
    const media = await this.uploadInputMedia(
      file,
      options.sendAs,
      options.asSticker,
      options.onProgress,
    );
    const result = await this.getClient().invoke(
      new Api.messages.SendMedia({
        peer: this.inputPeer(peer),
        media,
        message: options.caption,
        randomId: BigInt(options.randomId),
        ...(options.reply ? { replyTo: this.inputReply(options.reply) } : {}),
        ...(options.formats?.length ? { entities: this.inputEntities(options.formats) } : {}),
      }),
    );
    if (result instanceof Api.UpdateShortSentMessage) {
      return this.mapShortSentMessage(
        peer,
        options.caption,
        options.randomId,
        result,
        options.reply,
        options.formats,
      );
    }
    const message = this.messagesFromUpdates(result)
      .map((candidate) => this.mapMessage(candidate))
      .find((candidate): candidate is TelegramMessage => Boolean(candidate));
    if (!message) throw new Error('Telegram accepted the upload but returned no message.');
    const sentMessage = { ...message, randomId: options.randomId };
    return {
      message: sentMessage,
      updateBatches: this.updateBatches(result, [sentMessage]),
    };
  }

  async sendAlbum(
    peer: TelegramPeer,
    attachments: SendAlbumAttachment[],
    options: SendAlbumOptions,
  ) {
    if (attachments.length < 2 || attachments.length > 10) {
      throw new Error('Telegram albums must contain between 2 and 10 attachments.');
    }
    const inputPeer = this.inputPeer(peer);
    const multiMedia: Api.InputSingleMedia[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const uploadedMedia = await this.uploadInputMedia(
        attachment.file,
        attachment.sendAs,
        false,
        options.onProgress
          ? (progress) => options.onProgress!((index + progress) / attachments.length)
          : undefined,
      );
      const media = await this.uploadAlbumMedia(inputPeer, uploadedMedia);
      multiMedia.push(
        new Api.InputSingleMedia({
          media,
          randomId: BigInt(attachment.randomId),
          message: index === 0 ? options.caption : '',
          ...(index === 0 && options.formats?.length
            ? { entities: this.inputEntities(options.formats) }
            : {}),
        }),
      );
    }
    const result = await this.getClient().invoke(
      new Api.messages.SendMultiMedia({
        peer: inputPeer,
        multiMedia,
        ...(options.reply ? { replyTo: this.inputReply(options.reply) } : {}),
      }),
    );
    const messages = this.messagesFromUpdates(result)
      .map((candidate) => this.mapMessage(candidate))
      .filter((candidate): candidate is TelegramMessage => candidate?.peerId === peer.id)
      .sort((left, right) => left.id - right.id);
    if (messages.length !== attachments.length) {
      throw new Error('Telegram accepted the album but returned an incomplete message list.');
    }
    const sentMessages = messages.map((message, index) => ({
      ...message,
      randomId: attachments[index]!.randomId,
    }));
    return {
      messages: sentMessages,
      updateBatches: this.updateBatches(result, sentMessages),
    };
  }

  async downloadMedia(message: TelegramMessage) {
    const key = `${message.peerId}:${message.id}`;
    const media = this.linkPreviewPhotos.get(key) ?? this.messageMedia.get(key);
    if (!media) throw new Error('Media data is no longer in memory. Reopen the chat and retry.');
    const bytes = await this.getClient().downloadMedia(media, { workers: 1 });
    if (!bytes) throw new Error('Telegram returned no media bytes.');
    return new Blob([bytes as BlobPart], {
      type: message.media?.mimeType || 'application/octet-stream',
    });
  }

  async downloadAvatar(peer: TelegramPeer) {
    let entity = this.entities.get(peer.id);
    if (!this.hasDownloadableAvatar(entity)) entity = await this.fetchEntity(peer);
    if (!this.hasDownloadableAvatar(entity)) return undefined;
    const bytes = await this.getClient().downloadProfilePhoto(entity as Api.User | Api.Chat);
    return bytes ? new Blob([bytes as BlobPart], { type: 'image/jpeg' }) : undefined;
  }

  async getRecentStickers(): Promise<TelegramSticker[]> {
    const result = await this.getClient().invoke(new Api.messages.GetRecentStickers({ hash: 0n }));
    if (!(result instanceof Api.messages.RecentStickers)) return [];
    return result.stickers.flatMap((document) => this.mapStickerDocument(document));
  }

  async getStickerPacks(): Promise<TelegramStickerPack[]> {
    const result = await this.getClient().invoke(new Api.messages.GetAllStickers({ hash: 0n }));
    if (!(result instanceof Api.messages.AllStickers)) return [];
    const sets = result.sets.filter(
      (set): set is Api.StickerSet => set instanceof Api.StickerSet && !set.masks && !set.emojis,
    );
    const packs: TelegramStickerPack[] = [];
    for (let offset = 0; offset < sets.length; offset += 4) {
      const batch = await Promise.allSettled(
        sets.slice(offset, offset + 4).map(async (set) => {
          const contents = await this.getClient().invoke(
            new Api.messages.GetStickerSet({
              stickerset: new Api.InputStickerSetID({ id: set.id, accessHash: set.accessHash }),
              hash: 0,
            }),
          );
          return {
            id: set.id.toString(),
            title: set.title,
            stickers:
              contents instanceof Api.messages.StickerSet
                ? contents.documents.flatMap((document) => this.mapStickerDocument(document))
                : [],
          };
        }),
      );
      for (const [index, loaded] of batch.entries()) {
        if (loaded.status === 'fulfilled') {
          packs.push(loaded.value);
          continue;
        }
        const set = sets[offset + index];
        reportDiagnostic({
          level: 'warn',
          area: 'transport',
          message: `Could not load the installed sticker pack ${set?.title ?? set?.id ?? 'unknown'}.`,
          details: {
            error: loaded.reason instanceof Error ? loaded.reason.message : String(loaded.reason),
          },
        });
      }
    }
    return packs.filter(({ stickers }) => stickers.length > 0);
  }

  async getSavedGifs(): Promise<TelegramSticker[]> {
    const result = await this.getClient().invoke(new Api.messages.GetSavedGifs({ hash: 0n }));
    if (!(result instanceof Api.messages.SavedGifs)) return [];
    return result.gifs.flatMap((document) => this.mapGifDocument(document));
  }

  async searchGifs(peer: TelegramPeer, query: string): Promise<TelegramSticker[]> {
    const config = await this.getClient().invoke(new Api.help.GetConfig());
    const resolved = await this.getClient().invoke(
      new Api.contacts.ResolveUsername({ username: config.gifSearchUsername || 'gif' }),
    );
    const bot = resolved.users.find((user): user is Api.User => user instanceof Api.User);
    if (!bot?.accessHash) return [];
    const result = await this.getClient().invoke(
      new Api.messages.GetInlineBotResults({
        bot: new Api.InputUser({ userId: bot.id, accessHash: bot.accessHash }),
        peer: this.inputPeer(peer),
        query,
        offset: '',
      }),
    );
    if (!(result instanceof Api.messages.BotResults)) return [];
    return result.results.flatMap((item) => {
      if (!(item instanceof Api.BotInlineMediaResult) || !(item.document instanceof Api.Document))
        return [];
      return this.mapGifDocument(item.document).map((gif) => ({
        ...gif,
        title: item.title || item.description || query,
        inlineQueryId: result.queryId.toString(),
        inlineResultId: item.id,
      }));
    });
  }

  async downloadSticker(sticker: TelegramSticker) {
    const document = this.stickerDocuments.get(sticker.id);
    let bytes: File | Uint8Array | undefined;
    if (document) {
      bytes = await this.getClient().downloadMedia(document, { workers: 1 });
    } else {
      if (sticker.dcId === undefined)
        throw new Error('The cached sticker index is obsolete. Reopen the picker to refresh it.');
      bytes = await this.getClient().downloadFile(
        new Api.InputDocumentFileLocation({
          id: BigInt(sticker.id),
          accessHash: BigInt(sticker.accessHash),
          fileReference: new Uint8Array(sticker.fileReference),
          thumbSize: '',
        }),
        {
          workers: 1,
          dcId: sticker.dcId,
          ...(sticker.size !== undefined ? { fileSize: sticker.size } : {}),
        },
      );
    }
    if (!bytes) throw new Error('Telegram returned no sticker bytes.');
    return new Blob([bytes as BlobPart], { type: sticker.mimeType });
  }

  async downloadCustomEmoji(documentId: string) {
    const documents = await this.getClient().invoke(
      new Api.messages.GetCustomEmojiDocuments({ documentId: [BigInt(documentId)] }),
    );
    const document = documents.find(
      (candidate): candidate is Api.Document => candidate instanceof Api.Document,
    );
    if (!document) throw new Error('Telegram returned no custom emoji document.');
    const bytes = await this.getClient().downloadMedia(document, { workers: 1 });
    if (!bytes) throw new Error('Telegram returned no custom emoji bytes.');
    return new Blob([bytes as BlobPart], { type: document.mimeType });
  }

  async getBotCommands(peer: TelegramPeer): Promise<TelegramBotCommand[]> {
    if (peer.kind === 'user') {
      const result = await this.getClient().invoke(
        new Api.users.GetFullUser({ id: this.inputUser(peer) }),
      );
      this.rememberEntities(result.users, result.chats);
      const botInfo = result.fullUser instanceof Api.UserFull ? result.fullUser.botInfo : undefined;
      return botInfo instanceof Api.BotInfo
        ? this.mapBotCommands([botInfo], result.users, peer.id)
        : [];
    }
    const result =
      peer.kind === 'channel'
        ? await this.getClient().invoke(
            new Api.channels.GetFullChannel({ channel: this.inputChannel(peer) }),
          )
        : await this.getClient().invoke(
            new Api.messages.GetFullChat({ chatId: BigInt(peer.id.slice(2)) }),
          );
    this.rememberEntities(result.users, result.chats);
    const botInfo =
      result.fullChat instanceof Api.ChatFull || result.fullChat instanceof Api.ChannelFull
        ? (result.fullChat.botInfo ?? [])
        : [];
    return this.mapBotCommands(botInfo, result.users);
  }

  async startBot(peer: TelegramPeer, startParam: string, randomId: string) {
    if (peer.kind !== 'user') throw new Error('Only a user bot can be started.');
    if (!startParam) return this.sendText(peer, '/start', randomId);
    const result = await this.getClient().invoke(
      new Api.messages.StartBot({
        bot: this.inputUser(peer),
        peer: this.inputPeer(peer),
        randomId: BigInt(randomId),
        startParam,
      }),
    );
    return this.mapOutgoingSendResult(
      result,
      peer,
      randomId,
      'Telegram started the bot but returned no outgoing message.',
    );
  }

  async answerBotCallback(
    peer: TelegramPeer,
    messageId: number,
    data: number[],
  ): Promise<TelegramBotCallbackResult> {
    const result = await this.getClient().invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: this.inputPeer(peer),
        msgId: messageId,
        data: new Uint8Array(data),
      }),
    );
    return {
      message: result.message,
      alert: Boolean(result.alert),
      url: result.url,
    };
  }

  async requestUrlAuth(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
  ): Promise<TelegramUrlAuthResult> {
    const result = await this.getClient().invoke(
      new Api.messages.RequestUrlAuth({
        peer: this.inputPeer(peer),
        msgId: messageId,
        buttonId,
      }),
    );
    return this.mapUrlAuthResult(result);
  }

  async acceptUrlAuth(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
    options: TelegramUrlAuthAcceptOptions = {},
  ): Promise<TelegramUrlAuthResult> {
    const result = await this.getClient().invoke(
      new Api.messages.AcceptUrlAuth({
        peer: this.inputPeer(peer),
        msgId: messageId,
        buttonId,
        ...(options.writeAllowed ? { writeAllowed: true as const } : {}),
        ...(options.sharePhoneNumber ? { sharePhoneNumber: true as const } : {}),
        ...(options.matchCode ? { matchCode: options.matchCode } : {}),
      }),
    );
    return this.mapUrlAuthResult(result);
  }

  async sendSticker(
    peer: TelegramPeer,
    sticker: TelegramSticker,
    randomId: string,
    reply?: TelegramReplyTarget,
  ) {
    if (sticker.inlineQueryId && sticker.inlineResultId) {
      const result = await this.getClient().invoke(
        new Api.messages.SendInlineBotResult({
          peer: this.inputPeer(peer),
          randomId: BigInt(randomId),
          queryId: BigInt(sticker.inlineQueryId),
          id: sticker.inlineResultId,
          ...(reply ? { replyTo: this.inputReply(reply) } : {}),
        }),
      );
      return this.mapOutgoingSendResult(
        result,
        peer,
        randomId,
        'Telegram accepted the GIF but returned no message.',
      );
    }
    const result = await this.getClient().invoke(
      new Api.messages.SendMedia({
        peer: this.inputPeer(peer),
        media: new Api.InputMediaDocument({ id: this.inputDocument(sticker) }),
        message: '',
        randomId: BigInt(randomId),
        ...(reply ? { replyTo: this.inputReply(reply) } : {}),
      }),
    );
    if (result instanceof Api.UpdateShortSentMessage) {
      return this.mapShortSentMessage(peer, '', randomId, result, reply);
    }
    const message = this.messagesFromUpdates(result)
      .map((candidate) => this.mapMessage(candidate))
      .find((candidate): candidate is TelegramMessage => Boolean(candidate));
    if (!message) throw new Error('Telegram accepted the sticker but returned no message.');
    const sentMessage = { ...message, randomId };
    return {
      message: sentMessage,
      updateBatches: this.updateBatches(result, [sentMessage]),
    };
  }

  async setReaction(
    peer: TelegramPeer,
    messageId: number,
    emoji?: string,
  ): Promise<TransportMutationResult> {
    const customEmojiId = emoji?.startsWith('custom:') ? emoji.slice('custom:'.length) : undefined;
    const result = await this.getClient().invoke(
      new Api.messages.SendReaction({
        peer: this.inputPeer(peer),
        msgId: messageId,
        reaction: customEmojiId
          ? [new Api.ReactionCustomEmoji({ documentId: BigInt(customEmojiId) })]
          : emoji
            ? [new Api.ReactionEmoji({ emoticon: emoji })]
            : [],
        addToRecent: true,
      }),
    );
    return { updateBatches: this.updateBatches(result) };
  }

  async deleteMessages(
    peer: TelegramPeer,
    messageIds: number[],
    revoke: boolean,
  ): Promise<TransportMutationResult> {
    let result: Api.messages.AffectedMessages;
    if (peer.kind === 'channel') {
      result = await this.getClient().invoke(
        new Api.channels.DeleteMessages({ channel: this.inputChannel(peer), id: messageIds }),
      );
      for (const messageId of messageIds) this.forgetMessageMedia(peer.id, messageId);
    } else {
      result = await this.getClient().invoke(
        new Api.messages.DeleteMessages({ id: messageIds, ...(revoke ? { revoke: true } : {}) }),
      );
      for (const messageId of messageIds) this.forgetMessageMedia(peer.id, messageId);
    }
    return {
      updateBatches: [
        {
          updates: [
            {
              type: 'delete-messages',
              pts: result.pts,
              ptsCount: result.ptsCount,
              ...(peer.kind === 'channel' ? { channelScoped: true as const } : {}),
              peerId: peer.id,
              messageIds,
            },
          ],
        },
      ],
    };
  }

  async editMessage(
    peer: TelegramPeer,
    messageId: number,
    text: string,
    formats?: TelegramTextFormat[],
    replacement?: EditMediaOptions,
  ): Promise<EditMessageResult> {
    const media = replacement
      ? await this.uploadInputMedia(replacement.file, replacement.sendAs, false)
      : undefined;
    const result = await this.getClient().invoke(
      new Api.messages.EditMessage({
        peer: this.inputPeer(peer),
        id: messageId,
        message: text,
        ...(formats?.length ? { entities: this.inputEntities(formats) } : {}),
        ...(media ? { media } : {}),
      }),
    );
    const message = this.messagesFromUpdates(result)
      .map((candidate) => this.mapMessage(candidate))
      .find((candidate): candidate is TelegramMessage => Boolean(candidate));
    const updateBatches = this.updateBatches(result);
    if (message) return { message, updateBatches };
    const history = await this.getHistoryAround(peer, messageId, 3);
    const fallback = history.find(({ id }) => id === messageId);
    if (!fallback) throw new Error('Telegram accepted the edit but returned no message.');
    return { message: fallback, updateBatches };
  }

  async forwardMessage(
    fromPeer: TelegramPeer,
    toPeer: TelegramPeer,
    messageId: number,
    randomId: string,
  ) {
    const result = await this.getClient().invoke(
      new Api.messages.ForwardMessages({
        fromPeer: this.inputPeer(fromPeer),
        id: [messageId],
        randomId: [BigInt(randomId)],
        toPeer: this.inputPeer(toPeer),
      }),
    );
    return this.mapOutgoingSendResult(
      result,
      toPeer,
      randomId,
      'Telegram accepted the forward but returned no message.',
    );
  }

  subscribe(listener: (batch: TransportUpdateBatch) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private installEventHandler(client = this.getClient(), generation = this.connectionGeneration) {
    if (this.eventHandlerClient === client) return;
    client.addEventHandler(
      (raw: GramUpdate) => {
        if (generation !== this.connectionGeneration || this.client !== client) return;
        if (raw instanceof UpdateConnectionState) {
          if (raw.state === UpdateConnectionState.connected) {
            this.clearConnectionLossTimer();
            return;
          }
          if (raw.state === UpdateConnectionState.disconnected) {
            this.scheduleConnectionLoss(client, generation);
            return;
          }
        }
        const batch = this.mapUpdateEnvelope(raw);
        if (
          batch.updates.length === 0 &&
          batch.date === undefined &&
          batch.seq === undefined &&
          batch.seqStart === undefined
        ) {
          return;
        }
        for (const listener of this.listeners) listener(batch);
      },
      { build: (update) => update },
    );
    this.eventHandlerClient = client;
  }

  private scheduleConnectionLoss(client: TelegramClient, generation: number) {
    if (this.connectionLossTimer !== undefined) return;
    this.connectionLossTimer = setTimeout(() => {
      this.connectionLossTimer = undefined;
      if (generation !== this.connectionGeneration || this.client !== client) return;
      const batch: TransportUpdateBatch = {
        updates: [{ type: 'connection-state', connected: false }],
      };
      for (const listener of this.listeners) listener(batch);
    }, CONNECTION_LOSS_GRACE_MS);
  }

  private clearConnectionLossTimer() {
    if (this.connectionLossTimer === undefined) return;
    clearTimeout(this.connectionLossTimer);
    this.connectionLossTimer = undefined;
  }

  private mapUpdateEnvelope(raw: GramUpdate): TransportUpdateBatch {
    if (raw instanceof UpdateSessionGap) return { updates: [{ type: 'too-long' }] };
    if (raw instanceof UpdateConnectionState) {
      return {
        updates:
          raw.state === UpdateConnectionState.connected
            ? []
            : [{ type: 'connection-state', connected: false }],
      };
    }
    if (raw instanceof Api.UpdatesTooLong) return { updates: [{ type: 'too-long' }] };
    if (raw instanceof Api.UpdateShortMessage) {
      const peerId = `u:${raw.userId}`;
      return {
        date: raw.date,
        updates: [
          {
            type: 'new-message',
            pts: raw.pts,
            ptsCount: raw.ptsCount,
            message: {
              id: raw.id,
              peerId,
              senderId: raw.out ? 'self' : peerId,
              text: raw.message,
              date: raw.date,
              outgoing: Boolean(raw.out),
              replyToId:
                raw.replyTo instanceof Api.MessageReplyHeader
                  ? raw.replyTo.replyToMsgId
                  : undefined,
              replyQuote:
                raw.replyTo instanceof Api.MessageReplyHeader ? raw.replyTo.quoteText : undefined,
              mentions: this.mapMentions(raw.entities),
              links: this.mapLinks(raw.entities),
              formats: this.mapFormats(raw.entities),
              forwardedFrom: this.mapForwardedFrom(raw.fwdFrom),
            },
          },
        ],
      };
    }
    if (raw instanceof Api.UpdateShortChatMessage) {
      return {
        date: raw.date,
        updates: [
          {
            type: 'new-message',
            pts: raw.pts,
            ptsCount: raw.ptsCount,
            message: {
              id: raw.id,
              peerId: `g:${raw.chatId}`,
              senderId: raw.out ? 'self' : `u:${raw.fromId}`,
              text: raw.message,
              date: raw.date,
              outgoing: Boolean(raw.out),
              replyToId:
                raw.replyTo instanceof Api.MessageReplyHeader
                  ? raw.replyTo.replyToMsgId
                  : undefined,
              replyQuote:
                raw.replyTo instanceof Api.MessageReplyHeader ? raw.replyTo.quoteText : undefined,
              mentions: this.mapMentions(raw.entities),
              links: this.mapLinks(raw.entities),
              formats: this.mapFormats(raw.entities),
              forwardedFrom: this.mapForwardedFrom(raw.fwdFrom),
            },
          },
        ],
      };
    }
    if (raw instanceof Api.UpdatesCombined) {
      this.rememberEntities(raw.users, raw.chats);
      const randomIds = this.randomIdsByMessageId(raw.updates);
      return {
        updates: raw.updates.flatMap((update) => this.mapUpdate(update, randomIds)),
        date: raw.date,
        seqStart: raw.seqStart,
        seq: raw.seq,
      };
    }
    if (raw instanceof Api.Updates) {
      this.rememberEntities(raw.users, raw.chats);
      const randomIds = this.randomIdsByMessageId(raw.updates);
      return {
        updates: raw.updates.flatMap((update) => this.mapUpdate(update, randomIds)),
        date: raw.date,
        seq: raw.seq,
      };
    }
    if (raw instanceof Api.UpdateShort) {
      return { updates: this.mapUpdate(raw.update), date: raw.date };
    }
    if (raw instanceof Api.UpdateShortSentMessage) return { updates: [], date: raw.date };
    return { updates: this.mapUpdate(raw as Api.TypeUpdate) };
  }

  private mapUpdate(
    update: Api.TypeUpdate,
    randomIds: ReadonlyMap<number, string> = new Map(),
  ): TransportUpdate[] {
    if (update instanceof Api.UpdatePtsChanged) return [{ type: 'too-long' }];
    if (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) {
      const message = this.mapMessage(update.message);
      const randomId = message ? randomIds.get(message.id) : undefined;
      return message
        ? [
            {
              type: 'new-message',
              pts: update.pts,
              ptsCount: update.ptsCount,
              channelScoped: update instanceof Api.UpdateNewChannelMessage,
              message: randomId ? { ...message, randomId } : message,
            },
          ]
        : [];
    }
    if (update instanceof Api.UpdateEditMessage || update instanceof Api.UpdateEditChannelMessage) {
      const message = this.mapMessage(update.message);
      return message
        ? [
            {
              type: 'edit-message',
              pts: update.pts,
              ptsCount: update.ptsCount,
              channelScoped: update instanceof Api.UpdateEditChannelMessage,
              message,
            },
          ]
        : [];
    }
    if (update instanceof Api.UpdateDeleteMessages) {
      return [
        {
          type: 'delete-messages',
          pts: update.pts,
          ptsCount: update.ptsCount,
          messageIds: update.messages,
        },
      ];
    }
    if (update instanceof Api.UpdateDeleteChannelMessages) {
      return [
        {
          type: 'delete-messages',
          pts: update.pts,
          ptsCount: update.ptsCount,
          channelScoped: true,
          peerId: `c:${update.channelId}`,
          messageIds: update.messages,
        },
      ];
    }
    if (update instanceof Api.UpdateReadHistoryInbox) {
      const peerId = this.peerId(update.peer);
      return peerId
        ? [
            {
              type: 'read-history',
              pts: update.pts,
              ptsCount: update.ptsCount,
              peerId,
              maxMessageId: update.maxId,
              direction: 'inbox',
              stillUnreadCount: update.stillUnreadCount,
            },
          ]
        : [];
    }
    if (update instanceof Api.UpdateReadHistoryOutbox) {
      const peerId = this.peerId(update.peer);
      return peerId
        ? [
            {
              type: 'read-history',
              pts: update.pts,
              ptsCount: update.ptsCount,
              peerId,
              maxMessageId: update.maxId,
              direction: 'outbox',
            },
          ]
        : [];
    }
    if (update instanceof Api.UpdateReadChannelInbox) {
      return [
        {
          type: 'read-history',
          pts: update.pts,
          ptsCount: 0,
          channelScoped: true,
          peerId: `c:${update.channelId}`,
          maxMessageId: update.maxId,
          direction: 'inbox',
          stillUnreadCount: update.stillUnreadCount,
        },
      ];
    }
    if (update instanceof Api.UpdateReadChannelOutbox) {
      return [
        {
          type: 'read-history',
          pts: 0,
          ptsCount: 0,
          channelScoped: true,
          peerId: `c:${update.channelId}`,
          maxMessageId: update.maxId,
          direction: 'outbox',
        },
      ];
    }
    if (update instanceof Api.UpdateMessageReactions) {
      const peerId = this.peerId(update.peer);
      return peerId
        ? [
            {
              type: 'reaction-changed',
              peerId,
              messageId: update.msgId,
              reactions: this.mapReactions(update.reactions),
            },
          ]
        : [];
    }
    if (update instanceof Api.UpdateUserTyping) {
      return [this.activityUpdate(`u:${update.userId}`, `u:${update.userId}`, update.action)];
    }
    if (update instanceof Api.UpdateChatUserTyping) {
      return [
        this.activityUpdate(
          `g:${update.chatId}`,
          this.peerId(update.fromId) ?? 'unknown',
          update.action,
        ),
      ];
    }
    if (update instanceof Api.UpdateChannelUserTyping) {
      return [
        this.activityUpdate(
          `c:${update.channelId}`,
          this.peerId(update.fromId) ?? 'unknown',
          update.action,
        ),
      ];
    }
    if (update instanceof Api.UpdateUserStatus) {
      return [
        {
          type: 'presence-changed',
          peerId: `u:${update.userId}`,
          ...this.mapUserPresence(update.status),
        },
      ];
    }
    if (
      update instanceof Api.UpdateNotifySettings &&
      update.peer instanceof Api.NotifyPeer &&
      update.notifySettings instanceof Api.PeerNotifySettings
    ) {
      const peerId = this.peerId(update.peer.peer);
      return peerId
        ? [
            {
              type: 'mute-changed',
              peerId,
              muted: this.isMuted(
                update.notifySettings,
                this.mapPeer(update.peer.peer, this.entities),
                this.entities.get(peerId),
              ),
            },
          ]
        : [];
    }
    if (
      update instanceof Api.UpdateNotifySettings &&
      update.notifySettings instanceof Api.PeerNotifySettings
    ) {
      const kind =
        update.peer instanceof Api.NotifyUsers
          ? 'users'
          : update.peer instanceof Api.NotifyChats
            ? 'groups'
            : update.peer instanceof Api.NotifyBroadcasts
              ? 'channels'
              : undefined;
      if (kind) {
        this.notifyDefaults.set(kind, update.notifySettings);
        this.notifyDefaultsLoaded = true;
        return [{ type: 'dialog-list-invalidated' }];
      }
    }
    if (
      update instanceof Api.UpdateDialogPinned &&
      (update.folderId === undefined || update.folderId === 0) &&
      update.peer instanceof Api.DialogPeer
    ) {
      const peerId = this.peerId(update.peer.peer);
      return peerId ? [{ type: 'dialog-pinned', peerId, pinned: Boolean(update.pinned) }] : [];
    }
    if (update instanceof Api.UpdatePinnedDialogs) {
      return [{ type: 'dialog-list-invalidated' }];
    }
    if (update instanceof Api.UpdateFolderPeers) {
      return [
        {
          type: 'dialog-folders-changed',
          pts: update.pts,
          ptsCount: update.ptsCount,
          folders: update.folderPeers.flatMap(({ peer, folderId }) => {
            const peerId = this.peerId(peer);
            return peerId ? [{ peerId, folderId }] : [];
          }),
        },
      ];
    }
    if (update instanceof Api.UpdateSavedGifs) {
      return [{ type: 'expression-index-changed', kind: 'gifs' }];
    }
    if (
      update instanceof Api.UpdateNewStickerSet ||
      update instanceof Api.UpdateStickerSetsOrder ||
      update instanceof Api.UpdateStickerSets ||
      update instanceof Api.UpdateRecentStickers ||
      update instanceof Api.UpdateFavedStickers ||
      update instanceof Api.UpdateMoveStickerSetToTop
    ) {
      return [{ type: 'expression-index-changed', kind: 'stickers' }];
    }
    if (update instanceof Api.UpdatePinnedMessages) {
      const peerId = this.peerId(update.peer);
      return peerId
        ? [
            {
              type: 'pinned-messages',
              pts: update.pts,
              ptsCount: update.ptsCount,
              peerId,
              messageIds: update.messages,
              pinned: Boolean(update.pinned),
            },
          ]
        : [];
    }
    if (update instanceof Api.UpdatePinnedChannelMessages) {
      return [
        {
          type: 'pinned-messages',
          pts: update.pts,
          ptsCount: update.ptsCount,
          channelScoped: true,
          peerId: `c:${update.channelId}`,
          messageIds: update.messages,
          pinned: Boolean(update.pinned),
        },
      ];
    }
    if (update instanceof Api.UpdateChannelTooLong) {
      return [{ type: 'channel-too-long', peerId: `c:${update.channelId}` }];
    }
    if (update instanceof Api.UpdateBotCommands) {
      const peerId = this.peerId(update.peer);
      return peerId ? [{ type: 'bot-commands-changed', peerId, botId: `u:${update.botId}` }] : [];
    }
    return [];
  }

  private mapCursor(state: Api.updates.State): SyncCursor {
    return { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq };
  }

  private mapActivity(action: Api.TypeSendMessageAction): TelegramActivityKind {
    if (
      action instanceof Api.SendMessageUploadPhotoAction ||
      action instanceof Api.SendMessageUploadVideoAction ||
      action instanceof Api.SendMessageUploadDocumentAction ||
      action instanceof Api.SendMessageUploadAudioAction ||
      action instanceof Api.SendMessageUploadRoundAction
    ) {
      return 'uploading';
    }
    if (
      action instanceof Api.SendMessageRecordAudioAction ||
      action instanceof Api.SendMessageRecordVideoAction ||
      action instanceof Api.SendMessageRecordRoundAction
    ) {
      return 'recording';
    }
    if (action instanceof Api.SendMessageChooseStickerAction) return 'choosing-sticker';
    return 'typing';
  }

  private activityUpdate(
    peerId: string,
    senderId: string,
    action: Api.TypeSendMessageAction,
  ): TransportUpdate {
    return action instanceof Api.SendMessageCancelAction
      ? { type: 'activity-ended', peerId, senderId }
      : { type: 'activity', activity: { peerId, senderId, kind: this.mapActivity(action) } };
  }

  private mapMessage(message: Api.TypeMessage): TelegramMessage | undefined {
    if (message instanceof Api.MessageService) {
      const peerId = this.peerId(message.peerId);
      if (!peerId) return undefined;
      const senderId = this.peerId(message.fromId) ?? (message.out ? 'self' : peerId);
      const sender = this.entities.get(senderId);
      const senderName = this.entityTitle(sender);
      const service = this.mapServiceAction(message.action, senderId);
      return {
        id: message.id,
        peerId,
        senderId,
        ...(senderName ? { senderName } : {}),
        ...this.senderAvatar(senderId, sender),
        ...this.senderRole(peerId, senderId),
        text: service.text,
        date: message.date,
        outgoing: Boolean(message.out),
        replyToId:
          message.replyTo instanceof Api.MessageReplyHeader
            ? message.replyTo.replyToMsgId
            : undefined,
        reactions: this.mapReactions(message.reactions),
        service,
      };
    }
    if (!(message instanceof Api.Message)) return undefined;
    const peerId = this.peerId(message.peerId);
    if (!peerId) return undefined;
    const mediaKey = `${peerId}:${message.id}`;
    if (message.media) {
      this.rememberBounded(this.messageMedia, mediaKey, message.media, MAX_MESSAGE_MEDIA_ENTRIES);
    } else {
      this.messageMedia.delete(mediaKey);
    }
    if (
      message.media instanceof Api.MessageMediaWebPage &&
      message.media.webpage instanceof Api.WebPage &&
      message.media.webpage.photo instanceof Api.Photo
    ) {
      this.rememberBounded(
        this.linkPreviewPhotos,
        mediaKey,
        message.media.webpage.photo,
        MAX_MESSAGE_MEDIA_ENTRIES,
      );
    } else {
      this.linkPreviewPhotos.delete(mediaKey);
    }
    const links = this.mapLinks(message.entities);
    const senderId = this.peerId(message.fromId) ?? (message.out ? 'self' : peerId);
    const sender = this.entities.get(senderId);
    const senderName = this.entityTitle(sender);
    const keyboardBot = this.entities.get(
      message.viaBotId !== undefined ? `u:${message.viaBotId}` : senderId,
    );
    const botUsername =
      keyboardBot instanceof Api.User && keyboardBot.bot ? keyboardBot.username : undefined;
    return {
      id: message.id,
      peerId,
      senderId,
      ...(senderName ? { senderName } : {}),
      ...this.senderAvatar(senderId, sender),
      ...this.senderRole(peerId, senderId, message.postAuthor),
      text: message.message,
      date: message.date,
      outgoing: Boolean(message.out),
      editedAt: message.editDate,
      groupedId: message.groupedId?.toString(),
      forwardedFrom: this.mapForwardedFrom(message.fwdFrom),
      replyToId:
        message.replyTo instanceof Api.MessageReplyHeader
          ? message.replyTo.replyToMsgId
          : undefined,
      replyQuote:
        message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo.quoteText : undefined,
      botKeyboard: this.mapBotKeyboard(message.replyMarkup, botUsername),
      media: this.mapMedia(message.media),
      reactions: this.mapReactions(message.reactions),
      mentions: this.mapMentions(message.entities),
      links,
      linkPreview: this.mapLinkPreview(message.media),
      formats: this.mapFormats(message.entities),
      richMessage: this.mapRichMessage(message.richMessage),
      pinned: message.pinned,
    };
  }

  private mapForwardedFrom(
    header: Api.TypeMessageFwdHeader | undefined,
  ): TelegramMessage['forwardedFrom'] {
    if (!header) return undefined;
    const source = header.fromId ?? header.savedFromId ?? header.savedFromPeer;
    const peerId = this.peerId(source);
    const name =
      header.fromName ||
      (peerId ? this.entityTitle(this.entities.get(peerId)) : '') ||
      header.savedFromName ||
      header.postAuthor ||
      peerId;
    if (!name) return undefined;
    const messageId = header.channelPost ?? header.savedFromMsgId;
    return {
      name,
      ...(peerId ? { peerId } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
    };
  }

  private mapServiceAction(
    action: Api.TypeMessageAction,
    actorId: string,
  ): NonNullable<TelegramMessage['service']> {
    const actor = this.servicePeerName(actorId);
    const base = { actorId };
    if (action instanceof Api.MessageActionChatCreate) {
      return {
        ...base,
        kind: 'chat-created',
        title: action.title,
        text: `${actor} created the group "${action.title}"`,
      };
    }
    if (action instanceof Api.MessageActionChannelCreate) {
      return {
        ...base,
        kind: 'chat-created',
        title: action.title,
        text: `${actor} created the channel "${action.title}"`,
      };
    }
    if (action instanceof Api.MessageActionChatEditTitle) {
      return {
        ...base,
        kind: 'title-changed',
        title: action.title,
        text: `${actor} changed the chat name to "${action.title}"`,
      };
    }
    if (action instanceof Api.MessageActionChatEditPhoto) {
      return { ...base, kind: 'photo-changed', text: `${actor} changed the chat photo` };
    }
    if (action instanceof Api.MessageActionChatDeletePhoto) {
      return { ...base, kind: 'photo-removed', text: `${actor} removed the chat photo` };
    }
    if (action instanceof Api.MessageActionChatAddUser) {
      const users = action.users.map((id) => this.serviceUser(id));
      const targetUserIds = users.map(({ id }) => id);
      const targets = this.serviceNameList(users.map(({ name }) => name));
      const joined = targetUserIds.length === 1 && targetUserIds[0] === actorId;
      return {
        ...base,
        kind: 'users-added',
        targetUserIds,
        text: joined ? `${actor} joined the group` : `${actor} added ${targets}`,
      };
    }
    if (action instanceof Api.MessageActionChatDeleteUser) {
      const target = this.serviceUser(action.userId);
      return {
        ...base,
        kind: 'user-removed',
        targetUserIds: [target.id],
        text: target.id === actorId ? `${actor} left the group` : `${actor} removed ${target.name}`,
      };
    }
    if (action instanceof Api.MessageActionChatJoinedByLink) {
      return { ...base, kind: 'joined-by-link', text: `${actor} joined via an invite link` };
    }
    if (action instanceof Api.MessageActionChatJoinedByRequest) {
      return {
        ...base,
        kind: 'joined-by-request',
        text: `${actor} joined after their request was approved`,
      };
    }
    if (action instanceof Api.MessageActionPinMessage) {
      return { ...base, kind: 'message-pinned', text: `${actor} pinned a message` };
    }
    if (action instanceof Api.MessageActionHistoryClear) {
      return { ...base, kind: 'history-cleared', text: `${actor} cleared the chat history` };
    }
    if (action instanceof Api.MessageActionSetMessagesTTL) {
      return {
        ...base,
        kind: 'auto-delete-changed',
        text:
          action.period === 0
            ? `${actor} turned off auto-delete`
            : `${actor} set messages to auto-delete after ${this.serviceDuration(action.period)}`,
      };
    }
    if (action instanceof Api.MessageActionTopicCreate) {
      return {
        ...base,
        kind: 'topic-created',
        title: action.title,
        text: `${actor} created the topic "${action.title}"`,
      };
    }
    if (action instanceof Api.MessageActionTopicEdit) {
      const text = action.title
        ? `${actor} renamed the topic to "${action.title}"`
        : action.closed === true
          ? `${actor} closed the topic`
          : action.closed === false
            ? `${actor} reopened the topic`
            : action.hidden === true
              ? `${actor} hid the topic`
              : action.hidden === false
                ? `${actor} made the topic visible`
                : `${actor} changed the topic`;
      return {
        ...base,
        kind: 'topic-changed',
        ...(action.title ? { title: action.title } : {}),
        text,
      };
    }
    if (action instanceof Api.MessageActionScreenshotTaken) {
      return { ...base, kind: 'screenshot-taken', text: `${actor} took a screenshot` };
    }
    if (action instanceof Api.MessageActionCustomAction) {
      return { ...base, kind: 'custom', text: action.message };
    }
    if (action instanceof Api.MessageActionContactSignUp) {
      return { ...base, kind: 'other', text: `${actor} joined Telegram` };
    }
    if (
      action instanceof Api.MessageActionChatMigrateTo ||
      action instanceof Api.MessageActionChannelMigrateFrom
    ) {
      return { ...base, kind: 'other', text: 'This group was upgraded to a channel' };
    }
    if (action instanceof Api.MessageActionGroupCallScheduled) {
      const when = new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(action.scheduleDate * 1000));
      return { ...base, kind: 'other', text: `${actor} scheduled a group call for ${when}` };
    }
    if (action instanceof Api.MessageActionGroupCall) {
      return {
        ...base,
        kind: 'other',
        text: action.duration
          ? `Group call ended after ${this.serviceDuration(action.duration)}`
          : `${actor} started a group call`,
      };
    }
    if (action instanceof Api.MessageActionInviteToGroupCall) {
      const users = action.users.map((id) => this.serviceUser(id));
      return {
        ...base,
        kind: 'other',
        targetUserIds: users.map(({ id }) => id),
        text: `${actor} invited ${this.serviceNameList(users.map(({ name }) => name))} to a group call`,
      };
    }
    if (action instanceof Api.MessageActionGameScore) {
      return { ...base, kind: 'other', text: `${actor} scored ${action.score} in a game` };
    }
    return { ...base, kind: 'other', text: 'Telegram service event' };
  }

  private serviceUser(userId: bigint) {
    const id = `u:${userId}`;
    return { id, name: this.servicePeerName(id) };
  }

  private servicePeerName(peerId: string) {
    if (peerId === 'self') return 'You';
    return this.entityTitle(this.entities.get(peerId)) || 'Someone';
  }

  private serviceNameList(names: string[]) {
    if (names.length <= 1) return names[0] ?? 'someone';
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
  }

  private serviceDuration(seconds: number) {
    if (seconds % 86_400 === 0) {
      const days = seconds / 86_400;
      return `${days} day${days === 1 ? '' : 's'}`;
    }
    if (seconds % 3_600 === 0) {
      const hours = seconds / 3_600;
      return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    if (seconds % 60 === 0) {
      const minutes = seconds / 60;
      return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }

  private mapReactions(reactions: Api.TypeMessageReactions | undefined): TelegramReaction[] {
    if (!(reactions instanceof Api.MessageReactions)) return [];
    return reactions.results.flatMap((result) => {
      if (result.reaction instanceof Api.ReactionEmoji) {
        return [
          {
            emoji: result.reaction.emoticon,
            count: result.count,
            chosen: result.chosenOrder !== undefined,
          },
        ];
      }
      if (result.reaction instanceof Api.ReactionCustomEmoji) {
        const customEmojiId = result.reaction.documentId.toString();
        return [
          {
            emoji: `custom:${customEmojiId}`,
            customEmojiId,
            count: result.count,
            chosen: result.chosenOrder !== undefined,
          },
        ];
      }
      return [];
    });
  }

  private mapBotCommands(
    botInfo: Api.BotInfo[],
    users: Api.TypeUser[],
    fallbackBotId?: string,
  ): TelegramBotCommand[] {
    const userById = new Map(
      users
        .filter((user): user is Api.User => user instanceof Api.User)
        .map((user) => [`u:${user.id}`, user]),
    );
    return botInfo.flatMap((info) => {
      const botId = info.userId !== undefined ? `u:${info.userId}` : fallbackBotId;
      const bot = botId ? userById.get(botId) : undefined;
      const botName = bot
        ? [bot.firstName, bot.lastName].filter(Boolean).join(' ') || bot.username
        : undefined;
      return (info.commands ?? []).map(({ command, description }) => ({
        command,
        description,
        ...(botId ? { botId } : {}),
        ...(bot?.username ? { botUsername: bot.username } : {}),
        ...(botName ? { botName } : {}),
      }));
    });
  }

  private mapBotKeyboard(
    markup: Api.TypeReplyMarkup | undefined,
    botUsername?: string,
  ): TelegramBotKeyboard | undefined {
    if (markup instanceof Api.ReplyKeyboardHide) {
      return { kind: 'reply', rows: [], hidden: true };
    }
    if (markup instanceof Api.ReplyKeyboardForceReply) {
      return {
        kind: 'reply',
        rows: [],
        forceReply: true,
        singleUse: Boolean(markup.singleUse),
        placeholder: markup.placeholder,
      };
    }
    if (markup instanceof Api.ReplyKeyboardMarkup) {
      return {
        kind: 'reply',
        rows: markup.rows.map((row) =>
          row.buttons.map((button) => this.mapBotButton(button, botUsername)),
        ),
        singleUse: Boolean(markup.singleUse),
        persistent: Boolean(markup.persistent),
        placeholder: markup.placeholder,
      };
    }
    if (markup instanceof Api.ReplyInlineMarkup) {
      return {
        kind: 'inline',
        rows: markup.rows.map((row) =>
          row.buttons.map((button) => this.mapBotButton(button, botUsername)),
        ),
      };
    }
    return undefined;
  }

  private mapBotButton(button: Api.TypeKeyboardButton, botUsername?: string): TelegramBotButton {
    if (button instanceof Api.KeyboardButton) return { kind: 'text', text: button.text };
    if (button instanceof Api.KeyboardButtonUrl) {
      return { kind: 'url', text: button.text, url: button.url };
    }
    if (button instanceof Api.KeyboardButtonUrlAuth) {
      return {
        kind: 'url-auth',
        text: button.text,
        url: button.url,
        buttonId: button.buttonId,
      };
    }
    if (button instanceof Api.KeyboardButtonCallback) {
      return { kind: 'callback', text: button.text, data: [...button.data] };
    }
    if (button instanceof Api.KeyboardButtonCopy) {
      return { kind: 'copy', text: button.text, copyText: button.copyText };
    }
    if (button instanceof Api.KeyboardButtonSwitchInline) {
      return {
        kind: 'switch-inline',
        text: button.text,
        query: button.query,
        samePeer: Boolean(button.samePeer),
        ...(botUsername ? { botUsername } : {}),
      };
    }
    if (button instanceof Api.KeyboardButtonUserProfile) {
      return { kind: 'url', text: button.text, url: `tg://user?id=${button.userId}` };
    }
    return { kind: 'unsupported', text: button.text };
  }

  private mapUrlAuthResult(result: Api.TypeUrlAuthResult): TelegramUrlAuthResult {
    if (result instanceof Api.UrlAuthResultAccepted) {
      return { kind: 'accepted', url: result.url };
    }
    if (result instanceof Api.UrlAuthResultDefault) return { kind: 'default' };
    const botTitle = this.entityTitle(result.bot) || 'Telegram bot';
    this.rememberEntities([result.bot], []);
    return {
      kind: 'request',
      botTitle,
      domain: result.domain,
      requestWriteAccess: Boolean(result.requestWriteAccess),
      requestPhoneNumber: Boolean(result.requestPhoneNumber),
      matchCodesFirst: Boolean(result.matchCodesFirst),
      isApp: Boolean(result.isApp),
      matchCodes: result.matchCodes,
      verifiedAppName: result.verifiedAppName,
    };
  }

  private mapMentions(entities: Api.TypeMessageEntity[] | undefined) {
    return (entities ?? []).flatMap((entity) => {
      if (entity instanceof Api.MessageEntityMention) {
        return [{ offset: entity.offset, length: entity.length }];
      }
      if (entity instanceof Api.MessageEntityMentionName) {
        return [
          {
            offset: entity.offset,
            length: entity.length,
            userId: `u:${entity.userId}`,
          },
        ];
      }
      return [];
    });
  }

  private mapLinks(entities: Api.TypeMessageEntity[] | undefined): TelegramLink[] {
    return (entities ?? []).flatMap((entity) => {
      if (entity instanceof Api.MessageEntityUrl) {
        return [{ offset: entity.offset, length: entity.length }];
      }
      if (entity instanceof Api.MessageEntityTextUrl) {
        return [{ offset: entity.offset, length: entity.length, url: entity.url }];
      }
      return [];
    });
  }

  private mapLinkPreview(media: Api.TypeMessageMedia | undefined) {
    if (!(media instanceof Api.MessageMediaWebPage)) return undefined;
    if (media.webpage instanceof Api.WebPage) {
      return {
        url: media.webpage.url,
        siteName: media.webpage.siteName,
        title: media.webpage.title,
        description: media.webpage.description,
        hasPhoto: media.webpage.photo instanceof Api.Photo,
      };
    }
    return undefined;
  }

  private mapFormats(entities: Api.TypeMessageEntity[] | undefined) {
    return (entities ?? []).flatMap((entity) => {
      const kind =
        entity instanceof Api.MessageEntityBold
          ? ('bold' as const)
          : entity instanceof Api.MessageEntityItalic
            ? ('italic' as const)
            : entity instanceof Api.MessageEntityUnderline
              ? ('underline' as const)
              : entity instanceof Api.MessageEntityStrike
                ? ('strike' as const)
                : entity instanceof Api.MessageEntityCode
                  ? ('code' as const)
                  : entity instanceof Api.MessageEntityPre
                    ? ('pre' as const)
                    : entity instanceof Api.MessageEntitySpoiler
                      ? ('spoiler' as const)
                      : entity instanceof Api.MessageEntityBlockquote
                        ? entity.collapsed
                          ? ('expandableBlockquote' as const)
                          : ('blockquote' as const)
                        : entity instanceof Api.MessageEntityCustomEmoji
                          ? ('customEmoji' as const)
                          : entity instanceof Api.MessageEntityFormattedDate
                            ? ('formattedDate' as const)
                            : entity instanceof Api.MessageEntityDiffInsert
                              ? ('diffInsert' as const)
                              : entity instanceof Api.MessageEntityDiffReplace
                                ? ('diffReplace' as const)
                                : entity instanceof Api.MessageEntityDiffDelete
                                  ? ('diffDelete' as const)
                                  : undefined;
      if (!kind) return [];
      return [
        {
          offset: entity.offset,
          length: entity.length,
          kind,
          ...(entity instanceof Api.MessageEntityCustomEmoji
            ? { customEmojiId: entity.documentId.toString() }
            : {}),
          ...(entity instanceof Api.MessageEntityFormattedDate ? { timestamp: entity.date } : {}),
          ...(entity instanceof Api.MessageEntityDiffReplace ? { oldText: entity.oldText } : {}),
        },
      ];
    });
  }

  private mapRichMessage(message: Api.TypeRichMessage | undefined) {
    if (!(message instanceof Api.RichMessage)) return undefined;
    return {
      blocks: message.blocks.flatMap((block) => this.mapRichBlock(block)),
      rtl: Boolean(message.rtl),
      partial: Boolean(message.part),
    };
  }

  private richTextValue(text: Api.TypeRichText): string {
    if (text instanceof Api.TextPlain) return text.text;
    if (text instanceof Api.TextConcat)
      return text.texts.map((part) => this.richTextValue(part)).join('');
    if (text instanceof Api.TextCustomEmoji) return text.alt;
    if (text instanceof Api.TextMath) return text.source;
    if (text instanceof Api.TextImage) return '\ufffc';
    if ('text' in text && text.text) return this.richTextValue(text.text);
    return '';
  }

  private mapRichText(text: Api.TypeRichText): RichText {
    if (text instanceof Api.TextPlain) return { kind: 'text', text: text.text };
    if (text instanceof Api.TextEmpty) return { kind: 'text', text: '' };
    if (text instanceof Api.TextConcat) {
      return { kind: 'concat', children: text.texts.map((part) => this.mapRichText(part)) };
    }
    if (text instanceof Api.TextBold) return { kind: 'bold', child: this.mapRichText(text.text) };
    if (text instanceof Api.TextItalic)
      return { kind: 'italic', child: this.mapRichText(text.text) };
    if (text instanceof Api.TextUnderline)
      return { kind: 'underline', child: this.mapRichText(text.text) };
    if (text instanceof Api.TextStrike)
      return { kind: 'strike', child: this.mapRichText(text.text) };
    if (text instanceof Api.TextFixed) return { kind: 'code', child: this.mapRichText(text.text) };
    if (text instanceof Api.TextSubscript)
      return { kind: 'subscript', child: this.mapRichText(text.text) };
    if (text instanceof Api.TextSuperscript)
      return { kind: 'superscript', child: this.mapRichText(text.text) };
    if (text instanceof Api.TextMarked)
      return { kind: 'marked', child: this.mapRichText(text.text) };
    if (text instanceof Api.TextSpoiler)
      return { kind: 'spoiler', child: this.mapRichText(text.text) };
    if (text instanceof Api.TextUrl) {
      return { kind: 'link', child: this.mapRichText(text.text), url: text.url };
    }
    if (text instanceof Api.TextEmail) {
      return { kind: 'link', child: this.mapRichText(text.text), url: `mailto:${text.email}` };
    }
    if (text instanceof Api.TextPhone) {
      return { kind: 'link', child: this.mapRichText(text.text), url: `tel:${text.phone}` };
    }
    if (text instanceof Api.TextAutoUrl) {
      return {
        kind: 'link',
        child: this.mapRichText(text.text),
        url: this.richTextValue(text.text),
      };
    }
    if (text instanceof Api.TextAutoEmail) {
      return {
        kind: 'link',
        child: this.mapRichText(text.text),
        url: `mailto:${this.richTextValue(text.text)}`,
      };
    }
    if (text instanceof Api.TextAutoPhone) {
      return {
        kind: 'link',
        child: this.mapRichText(text.text),
        url: `tel:${this.richTextValue(text.text)}`,
      };
    }
    if (text instanceof Api.TextMentionName) {
      return {
        kind: 'link',
        child: this.mapRichText(text.text),
        url: `tg://user?id=${text.userId}`,
      };
    }
    if (text instanceof Api.TextMention) {
      const value = this.richTextValue(text.text);
      return {
        kind: 'link',
        child: this.mapRichText(text.text),
        url: value.startsWith('@') ? `https://t.me/${value.slice(1)}` : value,
      };
    }
    if (text instanceof Api.TextCustomEmoji) {
      return { kind: 'customEmoji', alt: text.alt, documentId: text.documentId.toString() };
    }
    if (text instanceof Api.TextImage) {
      return { kind: 'customEmoji', alt: '\ufffc', documentId: text.documentId.toString() };
    }
    if (text instanceof Api.TextMath) return { kind: 'math', source: text.source };
    if (text instanceof Api.TextAnchor) {
      return { kind: 'anchor', child: this.mapRichText(text.text), name: text.name };
    }
    if (text instanceof Api.TextDate) {
      return { kind: 'date', child: this.mapRichText(text.text), timestamp: text.date };
    }
    if (text instanceof Api.TextDiff) {
      return {
        kind: 'diff',
        child: this.mapRichText(text.text),
        oldText: this.mapRichText(text.oldText),
      };
    }
    if ('text' in text && text.text) return this.mapRichText(text.text);
    return { kind: 'text', text: '' };
  }

  private mapRichCaption(caption: Api.TypePageCaption): RichCaption {
    return {
      text: this.mapRichText(caption.text),
      ...(caption.credit instanceof Api.TextEmpty
        ? {}
        : { credit: this.mapRichText(caption.credit) }),
    };
  }

  private mapRichBlock(block: Api.TypePageBlock): RichBlock[] {
    const textRole =
      block instanceof Api.PageBlockTitle
        ? ('title' as const)
        : block instanceof Api.PageBlockSubtitle
          ? ('subtitle' as const)
          : block instanceof Api.PageBlockHeader
            ? ('header' as const)
            : block instanceof Api.PageBlockSubheader
              ? ('subheader' as const)
              : block instanceof Api.PageBlockParagraph
                ? ('paragraph' as const)
                : block instanceof Api.PageBlockFooter
                  ? ('footer' as const)
                  : block instanceof Api.PageBlockKicker
                    ? ('kicker' as const)
                    : block instanceof Api.PageBlockThinking
                      ? ('thinking' as const)
                      : undefined;
    if (textRole && 'text' in block) {
      return [{ kind: 'text', role: textRole, text: this.mapRichText(block.text) }];
    }
    const heading =
      block instanceof Api.PageBlockHeading1
        ? 1
        : block instanceof Api.PageBlockHeading2
          ? 2
          : block instanceof Api.PageBlockHeading3
            ? 3
            : block instanceof Api.PageBlockHeading4
              ? 4
              : block instanceof Api.PageBlockHeading5
                ? 5
                : block instanceof Api.PageBlockHeading6
                  ? 6
                  : undefined;
    if (heading && 'text' in block) {
      return [
        {
          kind: 'heading',
          level: heading as 1 | 2 | 3 | 4 | 5 | 6,
          text: this.mapRichText(block.text),
        },
      ];
    }
    if (block instanceof Api.PageBlockPreformatted) {
      return [
        { kind: 'pre', text: this.mapRichText(block.text), language: block.language || undefined },
      ];
    }
    if (block instanceof Api.PageBlockDivider) return [{ kind: 'divider' }];
    if (block instanceof Api.PageBlockAnchor) return [{ kind: 'anchor', name: block.name }];
    if (block instanceof Api.PageBlockMath) return [{ kind: 'math', source: block.source }];
    if (block instanceof Api.PageBlockAuthorDate) {
      return [
        {
          kind: 'author',
          author: this.mapRichText(block.author),
          publishedAt: block.publishedDate,
        },
      ];
    }
    if (block instanceof Api.PageBlockList || block instanceof Api.PageBlockOrderedList) {
      return [
        {
          kind: 'list',
          ordered: block instanceof Api.PageBlockOrderedList,
          ...(block instanceof Api.PageBlockOrderedList
            ? { reversed: Boolean(block.reversed), start: block.start }
            : {}),
          items: block.items.map((item) => ({
            ...('checkbox' in item
              ? { checkbox: Boolean(item.checkbox), checked: Boolean(item.checked) }
              : {}),
            ...('num' in item && item.num ? { marker: item.num } : {}),
            ...('value' in item && item.value !== undefined ? { value: item.value } : {}),
            ...('text' in item
              ? { text: this.mapRichText(item.text) }
              : 'blocks' in item
                ? { blocks: item.blocks.flatMap((child) => this.mapRichBlock(child)) }
                : {}),
          })),
        },
      ];
    }
    if (block instanceof Api.PageBlockBlockquote) {
      return [
        {
          kind: 'quote',
          blocks: [{ kind: 'text', role: 'paragraph', text: this.mapRichText(block.text) }],
          ...(block.caption instanceof Api.TextEmpty
            ? {}
            : { caption: this.mapRichText(block.caption) }),
        },
      ];
    }
    if (block instanceof Api.PageBlockPullquote) {
      return [
        {
          kind: 'quote',
          pull: true,
          blocks: [{ kind: 'text', role: 'paragraph', text: this.mapRichText(block.text) }],
          ...(block.caption instanceof Api.TextEmpty
            ? {}
            : { caption: this.mapRichText(block.caption) }),
        },
      ];
    }
    if (block instanceof Api.PageBlockBlockquoteBlocks) {
      return [
        {
          kind: 'quote',
          expandable: true,
          blocks: block.blocks.flatMap((child) => this.mapRichBlock(child)),
          ...(block.caption instanceof Api.TextEmpty
            ? {}
            : { caption: this.mapRichText(block.caption) }),
        },
      ];
    }
    if (block instanceof Api.PageBlockDetails) {
      return [
        {
          kind: 'details',
          title: this.mapRichText(block.title),
          blocks: block.blocks.flatMap((child) => this.mapRichBlock(child)),
          open: Boolean(block.open),
        },
      ];
    }
    if (block instanceof Api.PageBlockTable) {
      return [
        {
          kind: 'table',
          ...(block.title instanceof Api.TextEmpty ? {} : { title: this.mapRichText(block.title) }),
          bordered: Boolean(block.bordered),
          striped: Boolean(block.striped),
          rows: block.rows.map((row) =>
            row.cells.map((cell) => ({
              ...(cell.text ? { text: this.mapRichText(cell.text) } : {}),
              header: Boolean(cell.header),
              align: cell.alignRight ? 'right' : cell.alignCenter ? 'center' : 'left',
              verticalAlign: cell.valignBottom ? 'bottom' : cell.valignMiddle ? 'middle' : 'top',
              colSpan: cell.colspan,
              rowSpan: cell.rowspan,
            })),
          ),
        },
      ];
    }
    if (block instanceof Api.PageBlockCover) {
      return [{ kind: 'group', mode: 'cover', blocks: this.mapRichBlock(block.cover) }];
    }
    if (block instanceof Api.PageBlockCollage || block instanceof Api.PageBlockSlideshow) {
      return [
        {
          kind: 'group',
          mode: block instanceof Api.PageBlockCollage ? 'collage' : 'slideshow',
          blocks: block.items.flatMap((child) => this.mapRichBlock(child)),
          caption: this.mapRichCaption(block.caption),
        },
      ];
    }
    if (
      block instanceof Api.PageBlockPhoto ||
      block instanceof Api.PageBlockVideo ||
      block instanceof Api.PageBlockAudio
    ) {
      return [
        {
          kind: 'media',
          mediaKind:
            block instanceof Api.PageBlockPhoto
              ? 'photo'
              : block instanceof Api.PageBlockVideo
                ? 'video'
                : 'audio',
          id: (block instanceof Api.PageBlockPhoto
            ? block.photoId
            : block instanceof Api.PageBlockVideo
              ? block.videoId
              : block.audioId
          ).toString(),
          caption: this.mapRichCaption(block.caption),
          ...('spoiler' in block ? { spoiler: Boolean(block.spoiler) } : {}),
        },
      ];
    }
    if (block instanceof Api.PageBlockEmbed) {
      return [
        {
          kind: 'media',
          mediaKind: 'embed',
          url: block.url,
          caption: this.mapRichCaption(block.caption),
        },
      ];
    }
    if (block instanceof Api.PageBlockMap) {
      const url =
        block.geo instanceof Api.GeoPoint
          ? `https://www.openstreetmap.org/?mlat=${block.geo.lat}&mlon=${block.geo.long}`
          : undefined;
      return [
        { kind: 'media', mediaKind: 'map', url, caption: this.mapRichCaption(block.caption) },
      ];
    }
    if (block instanceof Api.PageBlockEmbedPost) {
      return [
        {
          kind: 'quote',
          blocks: block.blocks.flatMap((child) => this.mapRichBlock(child)),
          caption: { kind: 'link', child: { kind: 'text', text: block.author }, url: block.url },
        },
      ];
    }
    if (block instanceof Api.PageBlockChannel) {
      return [
        {
          kind: 'text',
          role: 'paragraph',
          text: { kind: 'text', text: 'title' in block.channel ? block.channel.title : 'Channel' },
        },
      ];
    }
    if (block instanceof Api.PageBlockRelatedArticles) {
      return [
        { kind: 'text', role: 'subheader', text: this.mapRichText(block.title) },
        {
          kind: 'list',
          ordered: false,
          items: block.articles.map((article) => ({
            text: {
              kind: 'link',
              child: { kind: 'text', text: article.title || article.description || article.url },
              url: article.url,
            },
          })),
        },
      ];
    }
    return [];
  }

  private inputDocument(sticker: TelegramSticker) {
    return new Api.InputDocument({
      id: BigInt(sticker.id),
      accessHash: BigInt(sticker.accessHash),
      fileReference: new Uint8Array(sticker.fileReference),
    });
  }

  private inputEntities(formats: TelegramTextFormat[]): Api.TypeMessageEntity[] {
    return formats.map((format): Api.TypeMessageEntity => {
      const base = { offset: format.offset, length: format.length };
      if (format.kind === 'bold') return new Api.MessageEntityBold(base);
      if (format.kind === 'italic') return new Api.MessageEntityItalic(base);
      if (format.kind === 'underline') return new Api.MessageEntityUnderline(base);
      if (format.kind === 'strike') return new Api.MessageEntityStrike(base);
      if (format.kind === 'code') return new Api.MessageEntityCode(base);
      if (format.kind === 'pre') return new Api.MessageEntityPre({ ...base, language: '' });
      if (format.kind === 'spoiler') return new Api.MessageEntitySpoiler(base);
      if (format.kind === 'blockquote') return new Api.MessageEntityBlockquote(base);
      if (format.kind === 'expandableBlockquote') {
        return new Api.MessageEntityBlockquote({ ...base, collapsed: true });
      }
      if (format.kind === 'textUrl') {
        return new Api.MessageEntityTextUrl({ ...base, url: format.url ?? '' });
      }
      if (format.kind === 'customEmoji') {
        return new Api.MessageEntityCustomEmoji({
          ...base,
          documentId: BigInt(format.customEmojiId ?? 0),
        });
      }
      if (format.kind === 'formattedDate') {
        return new Api.MessageEntityFormattedDate({ ...base, date: format.timestamp ?? 0 });
      }
      if (format.kind === 'diffInsert') return new Api.MessageEntityDiffInsert(base);
      if (format.kind === 'diffReplace') {
        return new Api.MessageEntityDiffReplace({ ...base, oldText: format.oldText ?? '' });
      }
      return new Api.MessageEntityDiffDelete(base);
    });
  }

  private async uploadAlbumMedia(
    peer: Api.TypeInputPeer,
    media: Api.TypeInputMedia,
  ): Promise<Api.TypeInputMedia> {
    const uploaded = await this.getClient().invoke(new Api.messages.UploadMedia({ peer, media }));
    if (uploaded instanceof Api.MessageMediaPhoto && uploaded.photo instanceof Api.Photo) {
      return new Api.InputMediaPhoto({
        id: new Api.InputPhoto({
          id: uploaded.photo.id,
          accessHash: uploaded.photo.accessHash,
          fileReference: uploaded.photo.fileReference,
        }),
      });
    }
    if (uploaded instanceof Api.MessageMediaDocument && uploaded.document instanceof Api.Document) {
      return new Api.InputMediaDocument({
        id: new Api.InputDocument({
          id: uploaded.document.id,
          accessHash: uploaded.document.accessHash,
          fileReference: uploaded.document.fileReference,
        }),
      });
    }
    throw new Error('Telegram could not prepare an album attachment.');
  }

  private async uploadInputMedia(
    file: File,
    sendAs: OutgoingAttachmentMode,
    asSticker: boolean,
    onProgress?: (progress: number) => void,
  ): Promise<Api.TypeInputMedia> {
    const uploaded = await this.getClient().uploadFile({
      file,
      workers: 2,
      ...(onProgress ? { onProgress } : {}),
    });
    const isPlainPhoto =
      sendAs === 'media' &&
      file.type.startsWith('image/') &&
      !asSticker &&
      file.type !== 'image/gif';
    if (isPlainPhoto) return new Api.InputMediaUploadedPhoto({ file: uploaded });
    const attributes: Api.TypeDocumentAttribute[] = [
      new Api.DocumentAttributeFilename({ fileName: file.name }),
    ];
    if (asSticker) {
      attributes.push(
        new Api.DocumentAttributeSticker({
          alt: '🙂',
          stickerset: new Api.InputStickerSetEmpty(),
        }),
      );
    } else if (sendAs === 'media' && file.type === 'image/gif') {
      attributes.push(new Api.DocumentAttributeAnimated());
    } else if (sendAs === 'media' && file.type.startsWith('video/')) {
      const metadata = await this.readVideoMetadata(file);
      attributes.push(
        new Api.DocumentAttributeVideo({
          duration: metadata.duration,
          w: metadata.width,
          h: metadata.height,
          supportsStreaming: true,
        }),
      );
    }
    return new Api.InputMediaUploadedDocument({
      file: uploaded,
      mimeType: file.type || 'application/octet-stream',
      attributes,
      ...(asSticker || sendAs === 'file' ? { forceFile: true as const } : {}),
    });
  }

  private async readVideoMetadata(file: File) {
    if (
      typeof document === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      throw new Error('Video metadata is unavailable in this browser.');
    }
    const url = URL.createObjectURL(file);
    try {
      return await new Promise<{ duration: number; width: number; height: number }>(
        (resolve, reject) => {
          const video = document.createElement('video');
          let settled = false;
          const finish = (
            result?: { duration: number; width: number; height: number },
            error?: Error,
          ) => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timeout);
            video.onloadedmetadata = null;
            video.onerror = null;
            video.removeAttribute('src');
            video.load();
            if (error) reject(error);
            else if (result) resolve(result);
          };
          const timeout = globalThis.setTimeout(
            () => finish(undefined, new Error('Timed out while reading video metadata.')),
            15_000,
          );
          video.preload = 'metadata';
          video.onloadedmetadata = () => {
            const duration = video.duration;
            const width = video.videoWidth;
            const height = video.videoHeight;
            if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) {
              finish(undefined, new Error('The selected video has invalid metadata.'));
              return;
            }
            finish({ duration, width, height });
          };
          video.onerror = () => {
            finish(undefined, new Error('Could not read the selected video.'));
          };
          video.src = url;
        },
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private mapStickerDocument(document: Api.TypeDocument): TelegramSticker[] {
    if (!(document instanceof Api.Document)) return [];
    this.rememberBounded(
      this.stickerDocuments,
      document.id.toString(),
      document,
      MAX_STICKER_DOCUMENT_ENTRIES,
    );
    const attribute = document.attributes.find(
      (candidate): candidate is Api.DocumentAttributeSticker =>
        candidate instanceof Api.DocumentAttributeSticker,
    );
    return [
      {
        id: document.id.toString(),
        accessHash: document.accessHash.toString(),
        fileReference: document.fileReference,
        emoji: attribute?.alt || '🙂',
        mimeType: document.mimeType,
        dcId: document.dcId,
        size: Number(document.size),
      },
    ];
  }

  private mapGifDocument(document: Api.TypeDocument): TelegramSticker[] {
    if (!(document instanceof Api.Document)) return [];
    this.rememberBounded(
      this.stickerDocuments,
      document.id.toString(),
      document,
      MAX_STICKER_DOCUMENT_ENTRIES,
    );
    return [
      {
        id: document.id.toString(),
        accessHash: document.accessHash.toString(),
        fileReference: document.fileReference,
        emoji: 'GIF',
        mimeType: document.mimeType,
        dcId: document.dcId,
        size: Number(document.size),
      },
    ];
  }

  private inputReply(reply: TelegramReplyTarget) {
    return new Api.InputReplyToMessage({
      replyToMsgId: reply.messageId,
      ...(reply.quoteText ? { quoteText: reply.quoteText } : {}),
    });
  }

  private mapMedia(media: Api.TypeMessageMedia | undefined) {
    if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
      const dimensions = [...media.photo.sizes]
        .reverse()
        .find((size): size is typeof size & { w: number; h: number } => 'w' in size && 'h' in size);
      return {
        kind: 'photo' as const,
        name: `photo-${media.photo.id}.jpg`,
        mimeType: 'image/jpeg',
        cacheKey: `photo:${media.photo.id}`,
        ...(dimensions ? { width: dimensions.w, height: dimensions.h } : {}),
      };
    }
    if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) {
      return undefined;
    }
    const document = media.document;
    const filename = document.attributes.find(
      (attribute): attribute is Api.DocumentAttributeFilename =>
        attribute instanceof Api.DocumentAttributeFilename,
    );
    const sticker = document.attributes.some(
      (attribute) => attribute instanceof Api.DocumentAttributeSticker,
    );
    const videoAttribute = document.attributes.find(
      (attribute): attribute is Api.DocumentAttributeVideo =>
        attribute instanceof Api.DocumentAttributeVideo,
    );
    const audioAttribute = document.attributes.find(
      (attribute): attribute is Api.DocumentAttributeAudio =>
        attribute instanceof Api.DocumentAttributeAudio,
    );
    const imageAttribute = document.attributes.find(
      (attribute): attribute is Api.DocumentAttributeImageSize =>
        attribute instanceof Api.DocumentAttributeImageSize,
    );
    const animated = document.attributes.some(
      (attribute) => attribute instanceof Api.DocumentAttributeAnimated,
    );
    const voice = Boolean(audioAttribute?.voice);
    const roundVideo = Boolean(videoAttribute?.roundMessage);
    return {
      kind: sticker
        ? ('sticker' as const)
        : voice
          ? ('voice' as const)
          : roundVideo
            ? ('round-video' as const)
            : animated
              ? ('animation' as const)
              : videoAttribute
                ? ('video' as const)
                : ('file' as const),
      name:
        filename?.fileName ??
        (voice
          ? `voice-${document.id}.ogg`
          : roundVideo
            ? `round-video-${document.id}.mp4`
            : `file-${document.id}`),
      mimeType: document.mimeType,
      size: Number(document.size),
      ...(videoAttribute
        ? { width: videoAttribute.w, height: videoAttribute.h }
        : imageAttribute
          ? { width: imageAttribute.w, height: imageAttribute.h }
          : sticker
            ? { width: 512, height: 512 }
            : {}),
      ...(audioAttribute
        ? { duration: audioAttribute.duration }
        : videoAttribute
          ? { duration: videoAttribute.duration }
          : {}),
      cacheKey: `document:${document.id}`,
    };
  }

  private entityMap(users: Api.TypeUser[], chats: Api.TypeChat[]) {
    const entities = new Map<string, Api.TypeUser | Api.TypeChat>();
    for (const user of users) entities.set(`u:${user.id}`, user);
    for (const chat of chats) {
      const prefix =
        chat instanceof Api.Channel || chat instanceof Api.ChannelForbidden ? 'c' : 'g';
      entities.set(`${prefix}:${chat.id}`, chat);
    }
    return entities;
  }

  private mapDialog(
    item: Api.Dialog,
    entities: Map<string, Api.TypeUser | Api.TypeChat>,
    messages: Map<string, TelegramMessage>,
  ): TelegramDialog | undefined {
    const peer = this.mapPeer(item.peer, entities);
    if (!peer) return undefined;
    const entity = entities.get(peer.id);
    const title = this.entityTitle(entity) || peer.id;
    const presence =
      entity instanceof Api.User
        ? this.mapUserPresence(entity.status)
        : { presence: 'offline' as const };
    return {
      peer,
      ...(peer.kind === 'channel' && item.pts !== undefined ? { channelPts: item.pts } : {}),
      title,
      initials: this.initials(title),
      color: this.peerColor(peer.id, entity),
      username:
        entity instanceof Api.User || entity instanceof Api.Channel ? entity.username : undefined,
      bot: entity instanceof Api.User && Boolean(entity.bot),
      archived: item.folderId === 1,
      topMessageId: item.topMessage,
      topMessage: messages.get(`${peer.id}:${item.topMessage}`),
      unreadCount: item.unreadCount,
      readInboxMaxId: item.readInboxMaxId,
      readOutboxMaxId: item.readOutboxMaxId,
      muted: this.isMuted(item.notifySettings, peer, entity),
      pinned: Boolean(item.pinned),
      hasAvatar:
        entity instanceof Api.User
          ? entity.photo instanceof Api.UserProfilePhoto
          : entity instanceof Api.Chat || entity instanceof Api.Channel
            ? entity.photo instanceof Api.ChatPhoto
            : false,
      avatarId:
        entity instanceof Api.User && entity.photo instanceof Api.UserProfilePhoto
          ? entity.photo.photoId.toString()
          : (entity instanceof Api.Chat || entity instanceof Api.Channel) &&
              entity.photo instanceof Api.ChatPhoto
            ? entity.photo.photoId.toString()
            : undefined,
      ...presence,
    };
  }

  private mapUserPresence(status: Api.TypeUserStatus | undefined): {
    presence: 'online' | 'recently' | 'offline';
    lastSeenAt?: number | undefined;
  } {
    if (status instanceof Api.UserStatusOnline && status.expires > Date.now() / 1000) {
      return { presence: 'online' };
    }
    if (status instanceof Api.UserStatusOffline) {
      return { presence: 'offline', lastSeenAt: status.wasOnline };
    }
    if (status instanceof Api.UserStatusRecently) return { presence: 'recently' };
    return { presence: 'offline' };
  }

  private mapPeer(
    peer: Api.TypePeer,
    entities: Map<string, Api.TypeUser | Api.TypeChat>,
  ): TelegramPeer | undefined {
    const id = this.peerId(peer);
    if (!id) return undefined;
    const entity = entities.get(id);
    const accessHash =
      entity && 'accessHash' in entity && entity.accessHash !== undefined
        ? entity.accessHash.toString()
        : undefined;
    return {
      id,
      kind: id.startsWith('u:') ? 'user' : id.startsWith('c:') ? 'channel' : 'group',
      accessHash,
    };
  }

  private peerId(peer: Api.TypePeer | undefined) {
    if (peer instanceof Api.PeerUser) return `u:${peer.userId}`;
    if (peer instanceof Api.PeerChat) return `g:${peer.chatId}`;
    if (peer instanceof Api.PeerChannel) return `c:${peer.channelId}`;
    return undefined;
  }

  private inputPeer(peer: TelegramPeer): Api.TypeInputPeer {
    const id = BigInt(peer.id.slice(2));
    const entity = this.entities.get(peer.id);
    const accessHash =
      peer.accessHash ??
      (entity && 'accessHash' in entity && entity.accessHash !== undefined
        ? entity.accessHash.toString()
        : '0');
    if (peer.kind === 'user') {
      return new Api.InputPeerUser({ userId: id, accessHash: BigInt(accessHash) });
    }
    if (peer.kind === 'channel') {
      return new Api.InputPeerChannel({ channelId: id, accessHash: BigInt(accessHash) });
    }
    return new Api.InputPeerChat({ chatId: id });
  }

  private inputChannel(peer: TelegramPeer) {
    if (peer.kind !== 'channel') throw new Error('Expected a channel peer.');
    const entity = this.entities.get(peer.id);
    const accessHash =
      peer.accessHash ??
      (entity && 'accessHash' in entity && entity.accessHash !== undefined
        ? entity.accessHash.toString()
        : '0');
    return new Api.InputChannel({
      channelId: BigInt(peer.id.slice(2)),
      accessHash: BigInt(accessHash),
    });
  }

  private inputUser(peer: TelegramPeer) {
    if (peer.kind !== 'user') throw new Error('Expected a user peer.');
    const input = this.inputPeer(peer);
    if (!(input instanceof Api.InputPeerUser)) throw new Error('Expected a user peer.');
    return new Api.InputUser({ userId: input.userId, accessHash: input.accessHash });
  }

  private entityTitle(entity: Api.TypeUser | Api.TypeChat | undefined) {
    if (entity instanceof Api.User) {
      return [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || '';
    }
    if (entity && 'title' in entity) return entity.title;
    return '';
  }

  private messagesFromUpdates(updates: Api.TypeUpdates) {
    if (updates instanceof Api.Updates || updates instanceof Api.UpdatesCombined) {
      this.rememberEntities(updates.users, updates.chats);
      return updates.updates.flatMap((update) =>
        update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage
          ? [update.message]
          : [],
      );
    }
    return [];
  }

  private mapShortSentMessage(
    peer: TelegramPeer,
    text: string,
    randomId: string,
    result: Api.UpdateShortSentMessage,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ): SendTextResult {
    const peerId =
      peer.kind === 'user'
        ? new Api.PeerUser({ userId: BigInt(peer.id.slice(2)) })
        : peer.kind === 'channel'
          ? new Api.PeerChannel({ channelId: BigInt(peer.id.slice(2)) })
          : new Api.PeerChat({ chatId: BigInt(peer.id.slice(2)) });
    const message = this.mapMessage(
      new Api.Message({
        id: result.id,
        out: true,
        peerId,
        date: result.date,
        message: text,
        ...(result.media ? { media: result.media } : {}),
        ...(result.entities
          ? { entities: result.entities }
          : formats?.length
            ? { entities: this.inputEntities(formats) }
            : {}),
        ...(reply
          ? {
              replyTo: new Api.MessageReplyHeader({
                replyToMsgId: reply.messageId,
                ...(reply.quoteText ? { quoteText: reply.quoteText } : {}),
              }),
            }
          : {}),
      }),
    );
    if (!message) throw new Error('Telegram accepted the send but returned no message.');
    const sentMessage = { ...message, randomId };
    return {
      message: sentMessage,
      updateBatches: this.shortSentUpdateBatches(result, sentMessage),
    };
  }

  private async mapOutgoingSendResult(
    result: Api.TypeUpdates,
    peer: TelegramPeer,
    randomId: string,
    failureMessage: string,
  ): Promise<SendTextResult> {
    let message =
      result instanceof Api.UpdateShortSentMessage
        ? undefined
        : this.messagesFromUpdates(result)
            .map((candidate) => this.mapMessage(candidate))
            .find(
              (candidate): candidate is TelegramMessage =>
                candidate?.peerId === peer.id && candidate.outgoing,
            );
    const returnedMessageId =
      result instanceof Api.UpdateShortSentMessage
        ? result.id
        : result instanceof Api.Updates || result instanceof Api.UpdatesCombined
          ? result.updates.find(
              (update): update is Api.UpdateMessageID =>
                update instanceof Api.UpdateMessageID && update.randomId.toString() === randomId,
            )?.id
          : undefined;
    if (!message && returnedMessageId !== undefined) {
      message = await this.getMessageById(peer, returnedMessageId);
    }
    if (!message) throw new Error(failureMessage);
    const sentMessage = { ...message, randomId };
    return {
      message: sentMessage,
      updateBatches:
        result instanceof Api.UpdateShortSentMessage
          ? this.shortSentUpdateBatches(result, sentMessage)
          : this.updateBatches(result, [sentMessage]),
    };
  }

  private async getMessageById(peer: TelegramPeer, messageId: number) {
    const id = [new Api.InputMessageID({ id: messageId })];
    const result =
      peer.kind === 'channel'
        ? await this.getClient().invoke(
            new Api.channels.GetMessages({ channel: this.inputChannel(peer), id }),
          )
        : await this.getClient().invoke(new Api.messages.GetMessages({ id }));
    if (result instanceof Api.messages.MessagesNotModified) return undefined;
    this.rememberEntities(result.users, result.chats);
    return result.messages
      .map((candidate) => this.mapMessage(candidate))
      .find(
        (candidate): candidate is TelegramMessage =>
          candidate?.id === messageId && candidate.peerId === peer.id,
      );
  }

  private shortSentUpdateBatches(
    result: Api.UpdateShortSentMessage,
    message: TelegramMessage,
  ): TransportUpdateBatch[] {
    return [
      {
        updates: [
          {
            type: 'new-message',
            pts: result.pts,
            ptsCount: result.ptsCount,
            message,
          },
        ],
        date: result.date,
      },
    ];
  }

  private randomIdsByMessageId(updates: Api.TypeUpdate[]) {
    return new Map(
      updates.flatMap((update) =>
        update instanceof Api.UpdateMessageID
          ? [[update.id, update.randomId.toString()] as const]
          : [],
      ),
    );
  }

  private updateBatches(
    updates: Api.TypeUpdates,
    sentMessages: TelegramMessage[] = [],
  ): TransportUpdateBatch[] {
    const batch = this.mapUpdateEnvelope(updates);
    const sentByMessage = new Map(
      sentMessages
        .filter((message) => message.randomId !== undefined)
        .map((message) => [`${message.peerId}:${message.id}`, message]),
    );
    const correlatedBatch =
      sentByMessage.size === 0
        ? batch
        : {
            ...batch,
            updates: batch.updates.map((update) => {
              if (update.type !== 'new-message') return update;
              const sent = sentByMessage.get(`${update.message.peerId}:${update.message.id}`);
              return sent?.randomId
                ? { ...update, message: { ...update.message, randomId: sent.randomId } }
                : update;
            }),
          };
    return batch.updates.length > 0 ||
      batch.date !== undefined ||
      batch.seq !== undefined ||
      batch.seqStart !== undefined
      ? [correlatedBatch]
      : [];
  }

  private mapSearchPage(
    result: Api.messages.Messages | Api.messages.MessagesSlice | Api.messages.ChannelMessages,
    limit: number,
    global: boolean,
  ): TelegramSearchPage {
    const rawMessages = result.messages.slice(0, limit);
    const messages = rawMessages
      .map((message) => this.mapMessage(message))
      .filter((message): message is TelegramMessage => Boolean(message));
    const hasContinuation = global
      ? result instanceof Api.messages.MessagesSlice && result.nextRate !== undefined
      : result.messages.length > limit;
    if (!hasContinuation) return { messages, hasMore: false };

    let last: Api.Message | undefined;
    for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
      const candidate = rawMessages[index];
      if (candidate instanceof Api.Message) {
        last = candidate;
        break;
      }
    }
    if (!last) return { messages, hasMore: false };
    const nextPeer = global ? this.mapPeer(last.peerId, this.entities) : undefined;
    if (global && !nextPeer) return { messages, hasMore: false };
    const nextOffset: TelegramSearchOffset = {
      messageId: last.id,
      ...(nextPeer ? { peer: nextPeer } : {}),
      ...(global
        ? { rate: result instanceof Api.messages.MessagesSlice ? (result.nextRate ?? 0) : 0 }
        : {}),
    };
    return { messages, hasMore: true, nextOffset };
  }

  private rememberEntities(users: Api.TypeUser[], chats: Api.TypeChat[]) {
    for (const user of users) {
      this.rememberBounded(this.entities, `u:${user.id}`, user, MAX_ENTITY_ENTRIES);
    }
    for (const chat of chats) {
      const prefix =
        chat instanceof Api.Channel || chat instanceof Api.ChannelForbidden ? 'c' : 'g';
      this.rememberBounded(this.entities, `${prefix}:${chat.id}`, chat, MAX_ENTITY_ENTRIES);
    }
  }

  private async fetchEntity(peer: TelegramPeer): Promise<Api.TypeUser | Api.TypeChat | undefined> {
    if (peer.kind === 'user') {
      const users = await this.getClient().invoke(
        new Api.users.GetUsers({ id: [this.inputUser(peer)] }),
      );
      this.rememberEntities(users, []);
      return users.find((user) => `u:${user.id}` === peer.id);
    }
    const result =
      peer.kind === 'channel'
        ? await this.getClient().invoke(
            new Api.channels.GetChannels({ id: [this.inputChannel(peer)] }),
          )
        : await this.getClient().invoke(
            new Api.messages.GetChats({ id: [BigInt(peer.id.slice(2))] }),
          );
    this.rememberEntities([], result.chats);
    return result.chats.find((chat) => {
      const prefix =
        chat instanceof Api.Channel || chat instanceof Api.ChannelForbidden ? 'c' : 'g';
      return `${prefix}:${chat.id}` === peer.id;
    });
  }

  private hasDownloadableAvatar(entity: Api.TypeUser | Api.TypeChat | undefined) {
    if (entity instanceof Api.User) return entity.photo instanceof Api.UserProfilePhoto;
    if (entity instanceof Api.Chat || entity instanceof Api.Channel) {
      return entity.photo instanceof Api.ChatPhoto;
    }
    return false;
  }

  private rememberBounded<Key, Value>(
    cache: Map<Key, Value>,
    key: Key,
    value: Value,
    limit: number,
  ) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  private forgetMessageMedia(peerId: string, messageId: number) {
    const key = `${peerId}:${messageId}`;
    this.messageMedia.delete(key);
    this.linkPreviewPhotos.delete(key);
  }

  private clearRuntimeCaches() {
    this.clearConnectionLossTimer();
    this.messageMedia.clear();
    this.linkPreviewPhotos.clear();
    this.stickerDocuments.clear();
    this.entities.clear();
    this.channelSenderRoles.clear();
    this.channelRolesLoaded.clear();
    this.channelRolesLoading.clear();
    this.notifyDefaults.clear();
    this.notifyDefaultsLoading = undefined;
    this.notifyDefaultsLoaded = false;
    this.eventHandlerClient = undefined;
  }

  private async flushSessionSave() {
    await this.sessionSave;
    if (!this.sessionSaveError) return;
    const detail =
      this.sessionSaveError instanceof Error
        ? this.sessionSaveError.message
        : typeof this.sessionSaveError === 'string'
          ? this.sessionSaveError
          : 'Unknown storage error.';
    throw new Error(`Could not persist the Telegram authorization session. ${detail}`);
  }

  private async ensureNotifyDefaults() {
    if (this.notifyDefaultsLoaded) return;
    if (this.notifyDefaultsLoading) return this.notifyDefaultsLoading;
    const loading = (async () => {
      const requests = [
        ['users', new Api.InputNotifyUsers()],
        ['groups', new Api.InputNotifyChats()],
        ['channels', new Api.InputNotifyBroadcasts()],
      ] as const;
      const results = await Promise.allSettled(
        requests.map(([, peer]) =>
          this.getClient().invoke(new Api.account.GetNotifySettings({ peer })),
        ),
      );
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value instanceof Api.PeerNotifySettings) {
          this.notifyDefaults.set(requests[index]![0], result.value);
        }
      });
      this.notifyDefaultsLoaded = true;
    })();
    this.notifyDefaultsLoading = loading;
    try {
      await loading;
    } finally {
      if (this.notifyDefaultsLoading === loading) this.notifyDefaultsLoading = undefined;
    }
  }

  private isMuted(
    settings: Api.TypePeerNotifySettings | undefined,
    peer?: TelegramPeer,
    entity?: Api.TypeUser | Api.TypeChat,
  ) {
    const kind =
      entity instanceof Api.User || peer?.kind === 'user'
        ? 'users'
        : entity instanceof Api.Channel && entity.broadcast
          ? 'channels'
          : 'groups';
    const defaultSettings = this.notifyDefaults.get(kind);
    const muteUntil = Number(
      settings && 'muteUntil' in settings && settings.muteUntil !== undefined
        ? settings.muteUntil
        : defaultSettings && 'muteUntil' in defaultSettings
          ? defaultSettings.muteUntil
          : 0,
    );
    return muteUntil < 0 || muteUntil > Date.now() / 1000;
  }

  private initials(title: string) {
    return title
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase())
      .join('');
  }

  private senderAvatar(senderId: string, sender: Api.TypeUser | Api.TypeChat | undefined) {
    if (!sender) return { senderColor: this.peerColor(senderId) };
    const photo =
      sender instanceof Api.User
        ? sender.photo instanceof Api.UserProfilePhoto
          ? sender.photo
          : undefined
        : sender instanceof Api.Chat || sender instanceof Api.Channel
          ? sender.photo instanceof Api.ChatPhoto
            ? sender.photo
            : undefined
          : undefined;
    return {
      senderHasAvatar: Boolean(photo),
      senderAvatarId: photo?.photoId.toString(),
      senderColor: this.peerColor(senderId, sender),
      senderColorVersion: 2,
    };
  }

  private mapGroupMember(user: Api.User, role: { role?: string; roleKind?: 'owner' | 'admin' }) {
    const peer = this.mapPeer(new Api.PeerUser({ userId: user.id }), this.entities)!;
    const title = this.entityTitle(user) || peer.id;
    const photo = user.photo instanceof Api.UserProfilePhoto ? user.photo : undefined;
    return {
      peer,
      title,
      initials: this.initials(title),
      color: this.peerColor(peer.id, user),
      username: user.username,
      ...role,
      hasAvatar: Boolean(photo),
      avatarId: photo?.photoId.toString(),
      ...this.mapUserPresence(user.status),
    };
  }

  private senderRole(peerId: string, senderId: string, postAuthor?: string) {
    const role = this.channelSenderRoles.get(`${peerId}:${senderId}`);
    const label = postAuthor?.trim() || role?.label;
    if (!label) return {};
    const ownerLabel = /^(owner|creator|владелец)$/iu.test(label);
    return {
      senderRole: label,
      senderRoleKind: role?.kind ?? (ownerLabel ? 'owner' : 'admin'),
    };
  }

  private async ensureChannelSenderRoles(peer: TelegramPeer, senderIds: string[]) {
    if (peer.kind !== 'channel' || this.channelRolesLoaded.has(peer.id)) return;
    const current = this.channelRolesLoading.get(peer.id);
    if (current) return current;
    const loading = (async () => {
      try {
        const result = await this.getClient().invoke(
          new Api.channels.GetParticipants({
            channel: this.inputChannel(peer),
            filter: new Api.ChannelParticipantsAdmins(),
            offset: 0,
            limit: 200,
            hash: 0n,
          }),
        );
        if (result instanceof Api.channels.ChannelParticipants) {
          this.rememberEntities(result.users, result.chats);
          for (const participant of result.participants) {
            if (participant instanceof Api.ChannelParticipantCreator) {
              this.channelSenderRoles.set(`${peer.id}:u:${participant.userId}`, {
                label: participant.rank?.trim() || 'owner',
                kind: 'owner',
              });
            } else if (participant instanceof Api.ChannelParticipantAdmin) {
              this.channelSenderRoles.set(`${peer.id}:u:${participant.userId}`, {
                label: participant.rank?.trim() || 'admin',
                kind: 'admin',
              });
            }
          }
        } else {
          await this.fetchVisibleChannelSenderRoles(peer, senderIds);
        }
      } catch {
        await this.fetchVisibleChannelSenderRoles(peer, senderIds);
      } finally {
        this.channelRolesLoaded.add(peer.id);
      }
    })();
    this.channelRolesLoading.set(peer.id, loading);
    try {
      await loading;
    } finally {
      if (this.channelRolesLoading.get(peer.id) === loading) {
        this.channelRolesLoading.delete(peer.id);
      }
    }
  }

  private async fetchVisibleChannelSenderRoles(peer: TelegramPeer, senderIds: string[]) {
    const userIds = [...new Set(senderIds.filter((senderId) => senderId.startsWith('u:')))].slice(
      0,
      20,
    );
    const results = await Promise.allSettled(
      userIds.map((senderId) =>
        this.getClient().invoke(
          new Api.channels.GetParticipant({
            channel: this.inputChannel(peer),
            participant: this.inputPeer({ id: senderId, kind: 'user' }),
          }),
        ),
      ),
    );
    results.forEach((result, index) => {
      if (
        result.status !== 'fulfilled' ||
        !(result.value instanceof Api.channels.ChannelParticipant)
      ) {
        return;
      }
      this.rememberEntities(result.value.users, result.value.chats);
      const participant = result.value.participant;
      if (participant instanceof Api.ChannelParticipantCreator) {
        this.channelSenderRoles.set(`${peer.id}:${userIds[index]}`, {
          label: participant.rank?.trim() || 'owner',
          kind: 'owner',
        });
      } else if (participant instanceof Api.ChannelParticipantAdmin) {
        this.channelSenderRoles.set(`${peer.id}:${userIds[index]}`, {
          label: participant.rank?.trim() || 'admin',
          kind: 'admin',
        });
      }
    });
  }

  private peerColor(peerId: string, entity?: Api.TypeUser | Api.TypeChat) {
    const color = entity && 'color' in entity ? entity.color : undefined;
    if (color instanceof Api.PeerColorCollectible) {
      const value = color.darkAccentColor ?? color.accentColor;
      return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
    }
    return telegramPeerColor(peerId, color instanceof Api.PeerColor ? color.color : undefined);
  }

  private getClient() {
    if (!this.client) throw new Error('Telegram transport is not connected.');
    return this.client;
  }
}
