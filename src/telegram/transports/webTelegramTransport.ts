import { telegramPeerColor } from '../../domain/peerColor';
import { gunzipSync } from 'fflate';
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
  TelegramDownloadOptions,
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
  TelegramBaseTheme,
  TelegramTheme,
  TelegramChatAppearance,
  TelegramThemeSettings,
  TelegramTextFormat,
  TelegramTransport,
  TelegramUserDetails,
  TelegramWallpaper,
  TelegramWallpaperSettings,
  TelegramUrlAuthAcceptOptions,
  TelegramUrlAuthResult,
  TransportMutationResult,
  TransportUpdate,
  TransportUpdateBatch,
} from '../types';
import {
  computePasswordSrpCheck,
  createMtprotoClient,
  telegramRpcErrorMessage,
  type MtprotoClient,
} from '../mtproto';
import { Api, type Tl } from '../mtproto/tl';
import { connectionStateEvent, sessionGapEvent, updateEvent } from '../mtproto/events';

type AuthResult = 'authorized' | 'password-required' | 'sign-up-required';

const MAX_MESSAGE_MEDIA_ENTRIES = 1_000;
const MAX_STICKER_DOCUMENT_ENTRIES = 512;
const MAX_ENTITY_ENTRIES = 2_000;
const CONNECTION_LOSS_GRACE_MS = 5_000;
const OPTIONAL_ENRICHMENT_DEADLINE_MS = 250;

function telegramLong(value: string | bigint) {
  return BigInt.asIntN(64, BigInt(value));
}

function sameTelegramLong(left: string | bigint, right: string | bigint) {
  return telegramLong(left) === telegramLong(right);
}

export type WebTelegramTransportDependencies = Readonly<{
  readVideoMetadata?: (file: File) => Promise<{ duration: number; width: number; height: number }>;
  optionalEnrichmentDeadlineMs?: number;
  createClient?: typeof createMtprotoClient;
  isPageActive?: () => boolean;
}>;

export type WebTelegramTransport = {
  [Key in keyof TelegramTransport]-?: NonNullable<TelegramTransport[Key]>;
};

export function createWebTelegramTransport(
  store: Pick<CacheStore, 'loadTransportSession' | 'saveTransportSession'>,
  dependencies: WebTelegramTransportDependencies = {},
): WebTelegramTransport {
  return createWebTelegramTransportImplementation(store, dependencies, false);
}

/** @internal White-box test harness; application code must use createWebTelegramTransport. */
export function createWebTelegramTransportForTesting(
  store: Pick<CacheStore, 'loadTransportSession' | 'saveTransportSession'>,
  dependencies: WebTelegramTransportDependencies = {},
): WebTelegramTransport {
  return createWebTelegramTransportImplementation(store, dependencies, true);
}

function createWebTelegramTransportImplementation(
  store: Pick<CacheStore, 'loadTransportSession' | 'saveTransportSession'>,
  dependencies: WebTelegramTransportDependencies,
  exposeTestInternals: boolean,
): WebTelegramTransport {
  const optionalEnrichmentDeadlineMs =
    dependencies.optionalEnrichmentDeadlineMs ?? OPTIONAL_ENRICHMENT_DEADLINE_MS;
  const isPageActive =
    dependencies.isPageActive ??
    (() => document.visibilityState === 'visible' && document.hasFocus());
  if (!Number.isFinite(optionalEnrichmentDeadlineMs) || optionalEnrichmentDeadlineMs < 0) {
    throw new RangeError('Optional Telegram enrichment deadline must be non-negative.');
  }
  const state = {
    client: undefined as MtprotoClient | undefined,
    connectionGeneration: 0,
    connecting: undefined as Promise<void> | undefined,
    phoneNumber: '',
    phoneCodeHash: '',
    listeners: new Set<(batch: TransportUpdateBatch) => void>(),
    messageMedia: new Map<string, Tl.TypeMessageMedia>(),
    linkPreviewPhotos: new Map<string, Tl.Photo>(),
    stickerDocuments: new Map<string, Tl.Document>(),
    wallpaperDocuments: new Map<string, Tl.Document>(),
    entities: new Map<string, Tl.TypeUser | Tl.TypeChat>(),
    channelSenderRoles: new Map<string, { label: string; kind: 'owner' | 'admin' }>(),
    channelRolesLoaded: new Set<string>(),
    channelRolesLoading: new Map<string, Promise<void>>(),
    notifyDefaults: new Map<'users' | 'groups' | 'channels', Tl.TypePeerNotifySettings>(),
    notifyDefaultsLoading: undefined as Promise<void> | undefined,
    notifyDefaultsLoaded: false,
    sessionSaveError: undefined as unknown,
    eventHandlerClient: undefined as MtprotoClient | undefined,
    eventUnsubscribe: undefined as (() => void) | undefined,
    connectionLossTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  async function connect(credentials: TelegramCredentials) {
    if (state.connecting) return state.connecting;
    if (state.client?.isConnected()) {
      await flushSessionSave();
      return;
    }
    const generation = ++state.connectionGeneration;
    clearConnectionLossTimer();
    const connecting = connectClient(credentials, generation);
    state.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (state.connecting === connecting) state.connecting = undefined;
    }
  }
  async function connectClient(credentials: TelegramCredentials, generation: number) {
    const storedSession = await store.loadTransportSession();
    if (generation !== state.connectionGeneration) {
      throw new Error('Telegram connection attempt was superseded.');
    }
    const client = (dependencies.createClient ?? createMtprotoClient)({
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      session: {
        load: async () => storedSession,
        save: (value) => store.saveTransportSession(value),
        clear: () => store.saveTransportSession(undefined),
      },
      clientInfo: {
        appVersion: '0.1.0',
        deviceModel: 'TeleVecha',
        systemVersion: navigator.userAgent,
        langCode: navigator.language.split('-')[0] || 'en',
        systemLangCode: navigator.language,
        langPack: '',
      },
      connectionRetries: 2,
      requestRetries: 5,
      onSessionError(error) {
        state.sessionSaveError = error;
        reportDiagnostic({
          level: 'error',
          area: 'cache',
          message: 'Could not persist the Telegram authorization session.',
          details: { error: error instanceof Error ? error.message : String(error) },
        });
      },
    });
    if (generation !== state.connectionGeneration) {
      client.disconnect();
      throw new Error('Telegram connection attempt was superseded.');
    }
    if (state.client && state.client !== client) {
      state.client.disconnect();
      clearRuntimeCaches();
    }
    state.client = client;
    try {
      await client.connect();
      await flushSessionSave(client);
    } catch (error) {
      const isCurrent = generation === state.connectionGeneration && state.client === client;
      if (state.client === client) state.client = undefined;
      client.disconnect();
      if (isCurrent) clearRuntimeCaches();
      throw error;
    }
    if (generation !== state.connectionGeneration || state.client !== client) {
      client.disconnect();
      throw new Error('Telegram connection attempt was superseded.');
    }
    installEventHandler(client, generation);
  }
  async function disconnect() {
    const generation = ++state.connectionGeneration;
    clearConnectionLossTimer();
    const connecting = state.connecting;
    const client = state.client;
    state.client = undefined;
    state.eventUnsubscribe?.();
    state.eventUnsubscribe = undefined;
    state.eventHandlerClient = undefined;
    client?.disconnect();
    if (connecting) await connecting.catch(() => undefined);
    let sessionError: unknown;
    try {
      await flushSessionSave(client);
    } catch (error) {
      sessionError = error;
    }
    if (generation === state.connectionGeneration) clearRuntimeCaches();
    if (sessionError) throw sessionError;
  }
  async function logOut() {
    const client = getClient();
    await client.invoke(Api.auth.LogOut());
    await flushSessionSave(client);
  }
  async function isAuthorized() {
    try {
      await getClient().invoke(Api.updates.GetState());
      return true;
    } catch (error) {
      if (
        ['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED'].includes(
          telegramRpcErrorMessage(error) ?? '',
        )
      ) {
        return false;
      }
      throw error;
    }
  }
  async function getAuthorizedAccountId() {
    const self = await getClient().getMe();
    if (!Api.User.is(self)) {
      throw new Error('Telegram did not return the authorized account.');
    }
    return self.id.toString();
  }
  async function requestCode(phoneNumber: string) {
    state.phoneNumber = phoneNumber.replace(/[^+\d]/g, '');
    const client = getClient();
    const sent = await client.invoke(
      Api.auth.SendCode({
        phoneNumber: state.phoneNumber,
        apiId: client.apiId,
        apiHash: client.apiHash,
        settings: Api.CodeSettings(),
      }),
    );
    if (!Api.auth.SentCode.is(sent)) {
      throw new Error('Telegram returned an unexpected login response.');
    }
    state.phoneCodeHash = sent.phoneCodeHash;
    return { isCodeViaApp: Api.auth.SentCodeTypeApp.is(sent.type) };
  }
  async function submitCode(code: string): Promise<AuthResult> {
    if (!state.phoneNumber || !state.phoneCodeHash) {
      throw new Error('Request a login code first.');
    }
    try {
      const result = await getClient().invoke(
        Api.auth.SignIn({
          phoneNumber: state.phoneNumber,
          phoneCodeHash: state.phoneCodeHash,
          phoneCode: code.trim(),
        }),
      );
      if (Api.auth.AuthorizationSignUpRequired.is(result)) return 'sign-up-required';
      await flushSessionSave();
      return 'authorized';
    } catch (error) {
      if (telegramRpcErrorMessage(error) === 'SESSION_PASSWORD_NEEDED') {
        return 'password-required';
      }
      throw error;
    }
  }
  async function submitPassword(password: string) {
    const client = getClient();
    const passwordState = await client.invoke(Api.account.GetPassword());
    if (
      !Api.PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow.is(
        passwordState.currentAlgo,
      )
    ) {
      throw new Error('Telegram returned an unsupported password algorithm.');
    }
    const proof = await computePasswordSrpCheck(
      {
        currentAlgo: passwordState.currentAlgo,
        srpB: passwordState.srpB,
        srpId: passwordState.srpId,
      },
      password,
    );
    await client.invoke(
      Api.auth.CheckPassword({
        password: Api.InputCheckPasswordSRP({ srpId: proof.srpId, A: proof.A, M1: proof.M1 }),
      }),
    );
    await flushSessionSave();
  }
  async function getCurrentState() {
    return mapCursor(await getClient().invoke(Api.updates.GetState()));
  }
  async function getDifference(cursor: SyncCursor, totalLimit: number): Promise<DifferenceResult> {
    const updates: TransportUpdate[] = [];
    let current = cursor;

    for (;;) {
      const result = await getClient().invoke(
        Api.updates.GetDifference({
          pts: current.pts,
          ptsLimit: totalLimit,
          ptsTotalLimit: totalLimit,
          date: current.date,
          qts: current.qts,
          qtsLimit: totalLimit,
        }),
      );

      if (Api.updates.DifferenceTooLong.is(result)) {
        return { type: 'too-long', cursor: await getCurrentState() };
      }
      if (Api.updates.DifferenceEmpty.is(result)) {
        return {
          type: 'complete',
          cursor: { ...current, date: result.date, seq: result.seq },
          updates,
        };
      }

      rememberEntities(result.users, result.chats);

      for (const message of result.newMessages) {
        const mapped = mapMessage(message);
        if (mapped) {
          updates.push({ type: 'new-message', pts: current.pts, ptsCount: 0, message: mapped });
        }
      }
      for (const update of result.otherUpdates) {
        updates.push(...mapUpdate(update));
      }

      if (updates.length > totalLimit) {
        return { type: 'too-long', cursor: await getCurrentState() };
      }

      if (Api.updates.DifferenceSlice.is(result)) {
        if (updates.length >= totalLimit) {
          return { type: 'too-long', cursor: await getCurrentState() };
        }
        current = mapCursor(result.intermediateState);
        continue;
      }
      return {
        type: 'complete',
        cursor: mapCursor(result.state),
        updates,
      };
    }
  }
  async function getChannelDifference(
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
      const result = await getClient().invoke(
        Api.updates.GetChannelDifference({
          force: true,
          channel: inputChannel(peer),
          filter: Api.ChannelMessagesFilterEmpty(),
          pts: currentPts,
          limit: Math.max(1, Math.min(100, remaining)),
        }),
      );

      if (Api.updates.ChannelDifferenceTooLong.is(result)) {
        const nextPts = Api.Dialog.is(result.dialog) ? result.dialog.pts : undefined;
        return { type: 'too-long', pts: nextPts ?? currentPts };
      }
      if (Api.updates.ChannelDifferenceEmpty.is(result)) {
        if (result.final || result.pts === currentPts) {
          return { type: 'complete', pts: result.pts, updates };
        }
        currentPts = result.pts;
        continue;
      }

      rememberEntities(result.users, result.chats);
      for (const message of result.newMessages) {
        const mapped = mapMessage(message);
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
      for (const update of result.otherUpdates) updates.push(...mapUpdate(update));
      if (updates.length > totalLimit) return { type: 'too-long', pts: result.pts };
      if (result.final || result.pts === currentPts) {
        return { type: 'complete', pts: result.pts, updates };
      }
      currentPts = result.pts;
    }

    return { type: 'too-long', pts: currentPts };
  }
  async function getDialogs(limit: number): Promise<DialogPage> {
    const totalLimit = Math.max(0, limit);
    if (totalLimit === 0) return { dialogs: [] };
    const dialogs = new Map<string, TelegramDialog>();
    const notifySettingsByPeer = new Map<string, Tl.TypePeerNotifySettings>();
    for (const folderId of [0, 1]) {
      let offsetDate = 0;
      let offsetId = 0;
      let offsetPeer: Tl.TypeInputPeer = Api.InputPeerEmpty();
      const seenOffsets = new Set<string>();

      while (dialogs.size < totalLimit) {
        const pageSize = Math.max(1, Math.min(100, totalLimit - dialogs.size));
        const result = await getClient().invoke(
          Api.messages.GetDialogs({
            folderId,
            offsetDate,
            offsetId,
            offsetPeer,
            limit: pageSize,
            hash: 0n,
          }),
        );
        if (Api.messages.DialogsNotModified.is(result)) break;
        rememberEntities(result.users, result.chats);

        const messages = new Map<string, TelegramMessage>();
        for (const message of result.messages) {
          const mapped = mapMessage(message);
          if (mapped) messages.set(`${mapped.peerId}:${mapped.id}`, mapped);
        }
        const entities = entityMap(result.users, result.chats);
        const rawDialogs = result.dialogs.filter(
          (item): item is Tl.Dialog =>
            Api.Dialog.is(item) && (folderId === 1 ? item.folderId === 1 : item.folderId !== 1),
        );
        for (const item of rawDialogs) {
          const dialog = mapDialog(item, entities, messages);
          if (dialog) {
            dialogs.set(dialog.peer.id, dialog);
            notifySettingsByPeer.set(dialog.peer.id, item.notifySettings);
          }
        }
        if (result.dialogs.length < pageSize || dialogs.size >= totalLimit) break;

        const last = rawDialogs.at(-1);
        const peer = last ? mapPeer(last.peer, entities) : undefined;
        if (!last || !peer) break;
        const topMessage = result.messages.find(
          (message): message is Tl.Message | Tl.MessageService =>
            (Api.Message.is(message) || Api.MessageService.is(message)) &&
            message.id === last.topMessage &&
            toPeerId(message.peerId) === peer.id,
        );
        const nextOffset = `${peer.id}:${last.topMessage}:${topMessage?.date ?? 0}`;
        if (seenOffsets.has(nextOffset)) break;
        seenOffsets.add(nextOffset);
        offsetId = last.topMessage;
        offsetDate = topMessage?.date ?? 0;
        offsetPeer = toInputPeer(peer);
      }
    }
    await waitForOptionalEnrichment(ensureNotifyDefaults());
    return {
      dialogs: [...dialogs.values()].slice(0, totalLimit).map((dialog) => ({
        ...dialog,
        muted: isMuted(
          notifySettingsByPeer.get(dialog.peer.id),
          dialog.peer,
          state.entities.get(dialog.peer.id),
        ),
      })),
    };
  }
  async function searchPeers(query: string, limit = 50): Promise<TelegramPeerSearchResult[]> {
    const term = query.trim();
    if (!term || limit <= 0) return [];
    const result = await getClient().invoke(
      Api.contacts.Search({ q: term, limit, broadcasts: true, bots: true }),
    );
    rememberEntities(result.users, result.chats);
    const entities = entityMap(result.users, result.chats);
    const found: TelegramPeerSearchResult[] = [];
    const seen = new Set<string>();
    for (const candidate of [...result.myResults, ...result.results]) {
      const peer = mapPeer(candidate, entities);
      if (!peer || seen.has(peer.id)) continue;
      const entity = entities.get(peer.id);
      const title = entityTitle(entity) || peer.id;
      const photo = Api.User.is(entity)
        ? Api.UserProfilePhoto.is(entity.photo)
          ? entity.photo
          : undefined
        : Api.Chat.is(entity) || Api.Channel.is(entity)
          ? Api.ChatPhoto.is(entity.photo)
            ? entity.photo
            : undefined
          : undefined;
      seen.add(peer.id);
      found.push({
        peer,
        category: Api.User.is(entity)
          ? entity.bot
            ? 'bot'
            : 'user'
          : Api.Channel.is(entity) && entity.broadcast
            ? 'channel'
            : 'group',
        title,
        initials: initials(title),
        color: peerColor(peer.id, entity),
        username: Api.User.is(entity) || Api.Channel.is(entity) ? entity.username : undefined,
        bot: Api.User.is(entity) && Boolean(entity.bot),
        isContact: Api.User.is(entity) && Boolean(entity.contact),
        hasAvatar: Boolean(photo),
        avatarId: photo?.photoId.toString(),
      });
      if (found.length >= limit) break;
    }
    return found;
  }
  async function getDialog(peer: TelegramPeer): Promise<TelegramDialog | undefined> {
    const result = await getClient().invoke(
      Api.messages.GetPeerDialogs({
        peers: [Api.InputDialogPeer({ peer: toInputPeer(peer) })],
      }),
    );
    rememberEntities(result.users, result.chats);
    const messages = new Map<string, TelegramMessage>();
    for (const message of result.messages) {
      const mapped = mapMessage(message);
      if (mapped) messages.set(`${mapped.peerId}:${mapped.id}`, mapped);
    }
    const entities = entityMap(result.users, result.chats);
    const item = result.dialogs.find(
      (candidate): candidate is Tl.Dialog =>
        Api.Dialog.is(candidate) && toPeerId(candidate.peer) === peer.id,
    );
    await waitForOptionalEnrichment(ensureNotifyDefaults());
    return item ? mapDialog(item, entities, messages) : undefined;
  }
  async function getHistory(
    peer: TelegramPeer,
    limit: number,
    beforeMessageId?: number,
  ): Promise<HistoryPage> {
    const result = await getClient().invoke(
      Api.messages.GetHistory({
        peer: toInputPeer(peer),
        offsetId: beforeMessageId ?? 0,
        offsetDate: 0,
        addOffset: 0,
        limit: limit + 1,
        maxId: 0,
        minId: 0,
        hash: 0n,
      }),
    );
    if (Api.messages.MessagesNotModified.is(result)) {
      return { messages: [], hasOlder: false };
    }
    rememberEntities(result.users, result.chats);
    const rawMessages = result.messages;
    const displayedRawMessages = rawMessages.slice(0, limit);
    await waitForOptionalEnrichment(
      ensureChannelSenderRoles(
        peer,
        displayedRawMessages.flatMap((message) => {
          const senderId = 'fromId' in message ? toPeerId(message.fromId) : undefined;
          return senderId ? [senderId] : [];
        }),
      ),
    );
    const messages = displayedRawMessages
      .map((message) => mapMessage(message))
      .filter((message): message is TelegramMessage => Boolean(message));
    const ids = displayedRawMessages.flatMap((message) => ('id' in message ? [message.id] : []));
    return {
      messages,
      hasOlder: rawMessages.length > 0,
      nextBeforeMessageId: ids.length > 0 ? Math.min(...ids) : beforeMessageId,
    };
  }
  async function getHistoryAround(peer: TelegramPeer, messageId: number, limit: number) {
    const result = await getClient().invoke(
      Api.messages.GetHistory({
        peer: toInputPeer(peer),
        offsetId: messageId,
        offsetDate: 0,
        addOffset: -Math.floor(limit / 2),
        limit,
        maxId: 0,
        minId: 0,
        hash: 0n,
      }),
    );
    if (Api.messages.MessagesNotModified.is(result)) return [];
    rememberEntities(result.users, result.chats);
    await waitForOptionalEnrichment(
      ensureChannelSenderRoles(
        peer,
        result.messages.flatMap((message) => {
          const senderId = 'fromId' in message ? toPeerId(message.fromId) : undefined;
          return senderId ? [senderId] : [];
        }),
      ),
    );
    return result.messages
      .map((candidate) => mapMessage(candidate))
      .filter((candidate): candidate is TelegramMessage => Boolean(candidate));
  }
  async function readHistory(
    peer: TelegramPeer,
    maxMessageId: number,
  ): Promise<TransportMutationResult> {
    if (peer.kind === 'channel') {
      await getClient().invoke(
        Api.channels.ReadHistory({
          channel: inputChannel(peer),
          maxId: maxMessageId,
        }),
      );
      return {};
    }
    const result = await getClient().invoke(
      Api.messages.ReadHistory({
        peer: toInputPeer(peer),
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
  async function getReadOutboxMaxId(peer: TelegramPeer) {
    const result = await getClient().invoke(
      Api.messages.GetPeerDialogs({
        peers: [Api.InputDialogPeer({ peer: toInputPeer(peer) })],
      }),
    );
    const dialog = result.dialogs.find(
      (candidate): candidate is Tl.Dialog =>
        Api.Dialog.is(candidate) && toPeerId(candidate.peer) === peer.id,
    );
    return dialog?.readOutboxMaxId ?? 0;
  }
  async function getSharedMediaCounts(peer: TelegramPeer) {
    const filters = sharedMediaFilters();
    const counters = await getClient().invoke(
      Api.messages.GetSearchCounters({
        peer: toInputPeer(peer),
        filters: Object.values(filters),
      }),
    );
    return {
      photos: counters[0]?.count ?? 0,
      videos: counters[1]?.count ?? 0,
      files: counters[2]?.count ?? 0,
      audio: counters[3]?.count ?? 0,
      links: counters[4]?.count ?? 0,
      voice: counters[5]?.count ?? 0,
      gifs: counters[6]?.count ?? 0,
    };
  }
  async function getSharedMedia(
    peer: TelegramPeer,
    kind: SharedMediaKind,
    limit: number,
    offset?: TelegramSearchOffset,
  ): Promise<TelegramSearchPage> {
    const filters = sharedMediaFilters();
    const result = await getClient().invoke(
      Api.messages.Search({
        peer: toInputPeer(peer),
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
    if (Api.messages.MessagesNotModified.is(result)) {
      return { messages: [], hasMore: false };
    }
    rememberEntities(result.users, result.chats);
    return mapSearchPage(result, limit, false);
  }
  function sharedMediaFilters() {
    return {
      photos: Api.InputMessagesFilterPhotos(),
      videos: Api.InputMessagesFilterVideo(),
      files: Api.InputMessagesFilterDocument(),
      audio: Api.InputMessagesFilterMusic(),
      links: Api.InputMessagesFilterUrl(),
      voice: Api.InputMessagesFilterRoundVoice(),
      gifs: Api.InputMessagesFilterGif(),
    } satisfies Record<SharedMediaKind, Tl.TypeMessagesFilter>;
  }
  async function searchMessages(
    query: string,
    peer?: TelegramPeer,
    limit = 50,
    offset?: TelegramSearchOffset,
  ) {
    const result = peer
      ? await getClient().invoke(
          Api.messages.Search({
            peer: toInputPeer(peer),
            q: query,
            filter: Api.InputMessagesFilterEmpty(),
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
      : await getClient().invoke(
          Api.messages.SearchGlobal({
            q: query,
            filter: Api.InputMessagesFilterEmpty(),
            minDate: 0,
            maxDate: 0,
            offsetRate: offset?.rate ?? 0,
            offsetPeer: offset?.peer ? toInputPeer(offset.peer) : Api.InputPeerEmpty(),
            offsetId: offset?.messageId ?? 0,
            limit,
          }),
        );
    if (Api.messages.MessagesNotModified.is(result)) {
      return { messages: [], hasMore: false };
    }
    rememberEntities(result.users, result.chats);
    return mapSearchPage(result, limit, !peer);
  }
  async function getPinnedMessages(peer: TelegramPeer) {
    const result = await getClient().invoke(
      Api.messages.Search({
        peer: toInputPeer(peer),
        q: '',
        filter: Api.InputMessagesFilterPinned(),
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
    if (Api.messages.MessagesNotModified.is(result)) return [];
    rememberEntities(result.users, result.chats);
    return result.messages
      .map((message) => mapMessage(message))
      .filter((message): message is TelegramMessage => Boolean(message));
  }
  async function setMuted(peer: TelegramPeer, muted: boolean) {
    await getClient().invoke(
      Api.account.UpdateNotifySettings({
        peer: Api.InputNotifyPeer({ peer: toInputPeer(peer) }),
        settings: Api.InputPeerNotifySettings({ muteUntil: muted ? 2_147_483_647 : 0 }),
      }),
    );
  }
  async function getUserDetails(peer: TelegramPeer): Promise<TelegramUserDetails> {
    if (peer.kind !== 'user') throw new Error('User details require a user peer.');
    const result = await getClient().invoke(Api.users.GetFullUser({ id: inputUser(peer) }));
    rememberEntities(result.users, result.chats);
    const user = result.users.find(
      (candidate): candidate is Tl.User =>
        Api.User.is(candidate) && candidate.id.toString() === peer.id.slice(2),
    );
    return {
      firstName: user?.firstName,
      lastName: user?.lastName,
      phone: user?.phone,
      username: user?.username,
      bio: Api.UserFull.is(result.fullUser) ? result.fullUser.about : undefined,
      birthday:
        Api.UserFull.is(result.fullUser) && Api.Birthday.is(result.fullUser.birthday)
          ? {
              day: result.fullUser.birthday.day,
              month: result.fullUser.birthday.month,
              ...(result.fullUser.birthday.year ? { year: result.fullUser.birthday.year } : {}),
            }
          : undefined,
      isContact: Boolean(user?.contact),
      blocked: Api.UserFull.is(result.fullUser) && Boolean(result.fullUser.blocked),
    };
  }
  async function updateContact(
    peer: TelegramPeer,
    firstName: string,
    lastName: string,
    phone: string,
  ) {
    if (peer.kind !== 'user') throw new Error('Only users can be contacts.');
    await getClient().invoke(
      Api.contacts.AddContact({
        id: inputUser(peer),
        firstName,
        lastName,
        phone,
      }),
    );
  }
  async function deleteContact(peer: TelegramPeer) {
    if (peer.kind !== 'user') throw new Error('Only users can be contacts.');
    await getClient().invoke(Api.contacts.DeleteContacts({ id: [inputUser(peer)] }));
  }
  async function getGroupMembers(peer: TelegramPeer, limit = 50) {
    if (peer.kind === 'user') return [];
    if (peer.kind === 'channel') {
      const result = await getClient().invoke(
        Api.channels.GetParticipants({
          channel: inputChannel(peer),
          filter: Api.ChannelParticipantsRecent(),
          offset: 0,
          limit,
          hash: 0n,
        }),
      );
      if (!Api.channels.ChannelParticipants.is(result)) return [];
      rememberEntities(result.users, result.chats);
      const participants = new Map(
        result.participants.flatMap((participant) =>
          'userId' in participant ? [[participant.userId.toString(), participant] as const] : [],
        ),
      );
      return result.users.flatMap((user) => {
        if (!Api.User.is(user)) return [];
        const participant = participants.get(user.id.toString());
        const role = Api.ChannelParticipantCreator.is(participant)
          ? { role: participant.rank?.trim() || 'owner', roleKind: 'owner' as const }
          : Api.ChannelParticipantAdmin.is(participant)
            ? { role: participant.rank?.trim() || 'admin', roleKind: 'admin' as const }
            : {};
        return [mapGroupMember(user, role)];
      });
    }
    const result = await getClient().invoke(
      Api.messages.GetFullChat({ chatId: BigInt(peer.id.slice(2)) }),
    );
    rememberEntities(result.users, result.chats);
    const participants =
      Api.ChatFull.is(result.fullChat) && Api.ChatParticipants.is(result.fullChat.participants)
        ? result.fullChat.participants.participants
        : [];
    const participantById = new Map(
      participants.map((participant) => [participant.userId.toString(), participant] as const),
    );
    return result.users.slice(0, limit).flatMap((user) => {
      if (!Api.User.is(user)) return [];
      const participant = participantById.get(user.id.toString());
      const role = Api.ChatParticipantCreator.is(participant)
        ? { role: participant.rank?.trim() || 'owner', roleKind: 'owner' as const }
        : Api.ChatParticipantAdmin.is(participant)
          ? { role: participant.rank?.trim() || 'admin', roleKind: 'admin' as const }
          : {};
      return [mapGroupMember(user, role)];
    });
  }
  async function setBlocked(peer: TelegramPeer, blocked: boolean) {
    if (peer.kind !== 'user') throw new Error('Only users can be blocked.');
    const request = blocked
      ? Api.contacts.Block({ id: toInputPeer(peer) })
      : Api.contacts.Unblock({ id: toInputPeer(peer) });
    await getClient().invoke(request);
  }
  async function setPinnedDialog(peer: TelegramPeer, pinned: boolean) {
    await getClient().invoke(
      Api.messages.ToggleDialogPin({
        peer: Api.InputDialogPeer({ peer: toInputPeer(peer) }),
        ...(pinned ? { pinned: true as const } : {}),
      }),
    );
  }
  async function setArchived(
    peer: TelegramPeer,
    archived: boolean,
  ): Promise<TransportMutationResult> {
    const result = await getClient().invoke(
      Api.folders.EditPeerFolders({
        folderPeers: [Api.InputFolderPeer({ peer: toInputPeer(peer), folderId: archived ? 1 : 0 })],
      }),
    );
    return { updateBatches: toUpdateBatches(result) };
  }
  async function deleteDialog(peer: TelegramPeer): Promise<TransportMutationResult> {
    if (peer.kind === 'channel') {
      const result = await getClient().invoke(
        Api.channels.LeaveChannel({ channel: inputChannel(peer) }),
      );
      return { updateBatches: toUpdateBatches(result) };
    }
    if (peer.kind === 'group') {
      const result = await getClient().invoke(
        Api.messages.DeleteChatUser({
          chatId: BigInt(peer.id.slice(2)),
          userId: Api.InputUserSelf(),
        }),
      );
      return { updateBatches: toUpdateBatches(result) };
    }
    const updateBatches: TransportUpdateBatch[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await getClient().invoke(
        Api.messages.DeleteHistory({ peer: toInputPeer(peer), maxId: 0 }),
      );
      updateBatches.push({
        updates: [{ type: 'pts-advanced', pts: result.pts, ptsCount: result.ptsCount }],
      });
      if (result.offset <= 0) return { updateBatches };
    }
    throw new Error('Telegram did not finish deleting the chat history.');
  }
  async function setPinnedMessage(
    peer: TelegramPeer,
    messageId: number,
    pinned: boolean,
  ): Promise<TransportMutationResult> {
    const result = await getClient().invoke(
      Api.messages.UpdatePinnedMessage({
        peer: toInputPeer(peer),
        id: messageId,
        silent: true,
        ...(pinned ? {} : { unpin: true as const }),
      }),
    );
    return { updateBatches: toUpdateBatches(result) };
  }
  async function setTyping(peer: TelegramPeer, kind?: TelegramActivityKind) {
    const action = !kind
      ? Api.SendMessageCancelAction()
      : kind === 'uploading'
        ? Api.SendMessageUploadDocumentAction({ progress: 0 })
        : kind === 'recording'
          ? Api.SendMessageRecordAudioAction()
          : kind === 'choosing-sticker'
            ? Api.SendMessageChooseStickerAction()
            : Api.SendMessageTypingAction();
    await getClient().invoke(Api.messages.SetTyping({ peer: toInputPeer(peer), action }));
  }
  async function sendText(
    peer: TelegramPeer,
    text: string,
    randomId: string,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ): Promise<SendTextResult> {
    const result = await getClient().invoke(
      Api.messages.SendMessage({
        peer: toInputPeer(peer),
        message: text,
        randomId: telegramLong(randomId),
        ...(reply ? { replyTo: inputReply(reply) } : {}),
        ...(formats?.length ? { entities: inputEntities(formats) } : {}),
      }),
    );
    if (Api.UpdateShortSentMessage.is(result)) {
      return mapShortSentMessage(peer, text, randomId, result, reply, formats);
    }
    const message = messagesFromUpdates(result)
      .map((candidate) => mapMessage(candidate))
      .find((candidate): candidate is TelegramMessage => Boolean(candidate));
    if (message) {
      const sentMessage = { ...message, randomId };
      return {
        message: sentMessage,
        updateBatches: toUpdateBatches(result, [sentMessage]),
      };
    }
    throw new Error('Telegram accepted the send but returned no message.');
  }
  async function sendFile(
    peer: TelegramPeer,
    file: File,
    options: SendFileOptions,
  ): Promise<SendTextResult> {
    const media = await uploadInputMedia(
      file,
      options.sendAs,
      options.asSticker,
      options.onProgress,
    );
    const result = await getClient().invoke(
      Api.messages.SendMedia({
        peer: toInputPeer(peer),
        media,
        message: options.caption,
        randomId: telegramLong(options.randomId),
        ...(options.reply ? { replyTo: inputReply(options.reply) } : {}),
        ...(options.formats?.length ? { entities: inputEntities(options.formats) } : {}),
      }),
    );
    if (Api.UpdateShortSentMessage.is(result)) {
      return mapShortSentMessage(
        peer,
        options.caption,
        options.randomId,
        result,
        options.reply,
        options.formats,
      );
    }
    const message = messagesFromUpdates(result)
      .map((candidate) => mapMessage(candidate))
      .find((candidate): candidate is TelegramMessage => Boolean(candidate));
    if (!message) throw new Error('Telegram accepted the upload but returned no message.');
    const sentMessage = { ...message, randomId: options.randomId };
    return {
      message: sentMessage,
      updateBatches: toUpdateBatches(result, [sentMessage]),
    };
  }
  async function sendAlbum(
    peer: TelegramPeer,
    attachments: SendAlbumAttachment[],
    options: SendAlbumOptions,
  ) {
    if (attachments.length < 2 || attachments.length > 10) {
      throw new Error('Telegram albums must contain between 2 and 10 attachments.');
    }
    const inputPeer = toInputPeer(peer);
    const multiMedia: Tl.InputSingleMedia[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const uploadedMedia = await uploadInputMedia(
        attachment.file,
        attachment.sendAs,
        false,
        options.onProgress
          ? (progress) => options.onProgress!((index + progress) / attachments.length)
          : undefined,
      );
      const media = await uploadAlbumMedia(inputPeer, uploadedMedia);
      multiMedia.push(
        Api.InputSingleMedia({
          media,
          randomId: telegramLong(attachment.randomId),
          message: index === 0 ? options.caption : '',
          ...(index === 0 && options.formats?.length
            ? { entities: inputEntities(options.formats) }
            : {}),
        }),
      );
    }
    const result = await getClient().invoke(
      Api.messages.SendMultiMedia({
        peer: inputPeer,
        multiMedia,
        ...(options.reply ? { replyTo: inputReply(options.reply) } : {}),
      }),
    );
    const messages = messagesFromUpdates(result)
      .map((candidate) => mapMessage(candidate))
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
      updateBatches: toUpdateBatches(result, sentMessages),
    };
  }
  async function downloadMedia(message: TelegramMessage, options?: TelegramDownloadOptions) {
    const key = `${message.peerId}:${message.id}`;
    const media = state.linkPreviewPhotos.get(key) ?? state.messageMedia.get(key);
    if (!media) throw new Error('Media data is no longer in memory. Reopen the chat and retry.');
    const bytes = await getClient().downloadMedia(media, {
      workers: 1,
      ...(options?.preview ? { sizeType: 'm' } : {}),
      progressCallback: options?.progress,
    });
    if (!bytes) throw new Error('Telegram returned no media bytes.');
    return new Blob([bytes as BlobPart], {
      type: options?.preview ? 'image/jpeg' : message.media?.mimeType || 'application/octet-stream',
    });
  }
  async function downloadAvatar(peer: TelegramPeer) {
    let entity = state.entities.get(peer.id);
    if (!hasDownloadableAvatar(entity)) entity = await fetchEntity(peer);
    if (!hasDownloadableAvatar(entity)) return undefined;
    const bytes = await getClient().downloadProfilePhoto(entity as Tl.User | Tl.Chat);
    return bytes ? new Blob([bytes as BlobPart], { type: 'image/jpeg' }) : undefined;
  }
  async function getThemes(): Promise<TelegramTheme[]> {
    const result = await getClient().invoke(
      Api.account.GetThemes({ format: 'tdesktop', hash: 0n }),
    );
    return mapThemes(result);
  }
  async function getChatThemes(): Promise<TelegramTheme[]> {
    const result = await getClient().invoke(Api.account.GetChatThemes({ hash: 0n }));
    return mapThemes(result);
  }
  function mapThemes(result: Tl.account.TypeThemes): TelegramTheme[] {
    if (!Api.account.Themes.is(result)) return [];
    return result.themes.flatMap((theme) => {
      if (!Api.Theme.is(theme)) return [];
      return [
        {
          id: theme.id.toString(),
          slug: theme.slug,
          title: theme.title,
          ...(theme.emoticon ? { emoticon: theme.emoticon } : {}),
          default: Boolean(theme.default),
          forChat: Boolean(theme.forChat),
          settings: (theme.settings ?? []).flatMap((settings) =>
            Api.ThemeSettings.is(settings) ? [mapThemeSettings(settings)] : [],
          ),
        },
      ];
    });
  }
  async function getChatAppearance(
    peer: TelegramPeer,
  ): Promise<TelegramChatAppearance | undefined> {
    let themeEmoticon: string | undefined;
    let wallpaper: TelegramWallpaper | undefined;
    let inlineTheme: TelegramTheme | undefined;

    if (peer.kind === 'user') {
      const result = await getClient().invoke(Api.users.GetFullUser({ id: inputUser(peer) }));
      rememberEntities(result.users, result.chats);
      if (Api.UserFull.is(result.fullUser)) {
        if (Api.ChatTheme.is(result.fullUser.theme)) {
          themeEmoticon = result.fullUser.theme.emoticon;
        } else if (Api.ChatThemeUniqueGift.is(result.fullUser.theme)) {
          inlineTheme = {
            id: `chat-gift:${peer.id}`,
            slug: '',
            title: 'Chat theme',
            default: false,
            forChat: true,
            settings: result.fullUser.theme.themeSettings.flatMap((settings) =>
              Api.ThemeSettings.is(settings) ? [mapThemeSettings(settings)] : [],
            ),
          };
        }
        wallpaper = result.fullUser.wallpaper
          ? mapWallpaper(result.fullUser.wallpaper)[0]
          : undefined;
      }
    } else {
      const result =
        peer.kind === 'channel'
          ? await getClient().invoke(Api.channels.GetFullChannel({ channel: inputChannel(peer) }))
          : await getClient().invoke(
              Api.messages.GetFullChat({ chatId: BigInt(peer.id.slice(2)) }),
            );
      rememberEntities(result.users, result.chats);
      if (Api.ChatFull.is(result.fullChat) || Api.ChannelFull.is(result.fullChat)) {
        themeEmoticon = result.fullChat.themeEmoticon;
        wallpaper =
          Api.ChannelFull.is(result.fullChat) && result.fullChat.wallpaper
            ? mapWallpaper(result.fullChat.wallpaper)[0]
            : undefined;
      }
    }

    const theme =
      inlineTheme ??
      (themeEmoticon
        ? (await getChatThemes()).find(({ emoticon }) => emoticon === themeEmoticon)
        : undefined);
    return theme || wallpaper
      ? { ...(theme ? { theme } : {}), ...(wallpaper ? { wallpaper } : {}) }
      : undefined;
  }
  async function getWallpapers(): Promise<TelegramWallpaper[]> {
    const result = await getClient().invoke(Api.account.GetWallPapers({ hash: 0n }));
    if (!Api.account.WallPapers.is(result)) return [];
    return result.wallpapers.flatMap((wallpaper) => mapWallpaper(wallpaper));
  }
  async function downloadWallpaper(wallpaperId: string) {
    let document = state.wallpaperDocuments.get(wallpaperId);
    if (!document) {
      await getWallpapers();
      document = state.wallpaperDocuments.get(wallpaperId);
    }
    if (!document) throw new Error('Reload the Telegram backgrounds and try again.');
    const bytes = await getClient().downloadMedia(document, { workers: 1 });
    if (!bytes) throw new Error('Telegram returned no background image bytes.');
    if (document.mimeType === 'application/x-tgwallpattern') {
      try {
        return new Blob([gunzipSync(bytes)], { type: 'image/svg+xml' });
      } catch (error) {
        throw new Error('Telegram returned an invalid TGV wallpaper pattern.', { cause: error });
      }
    }
    return new Blob([bytes as BlobPart], { type: document.mimeType || 'image/jpeg' });
  }
  function mapThemeSettings(settings: Tl.ThemeSettings): TelegramThemeSettings {
    return {
      baseTheme: mapBaseTheme(settings.baseTheme),
      accentColor: telegramColor(settings.accentColor),
      ...(settings.outboxAccentColor !== undefined
        ? { outboxAccentColor: telegramColor(settings.outboxAccentColor) }
        : {}),
      messageColors: (settings.messageColors ?? []).map((color) => telegramColor(color)),
      messageColorsAnimated: Boolean(settings.messageColorsAnimated),
      ...(settings.wallpaper ? { wallpaper: mapWallpaper(settings.wallpaper)[0] } : {}),
    };
  }
  function mapBaseTheme(theme: Tl.TypeBaseTheme): TelegramBaseTheme {
    if (Api.BaseThemeDay.is(theme)) return 'day';
    if (Api.BaseThemeNight.is(theme)) return 'night';
    if (Api.BaseThemeTinted.is(theme)) return 'tinted';
    if (Api.BaseThemeArctic.is(theme)) return 'arctic';
    return 'classic';
  }
  function mapWallpaperSettings(settings?: Tl.TypeWallPaperSettings): TelegramWallpaperSettings {
    const value = Api.WallPaperSettings.is(settings) ? settings : undefined;
    return {
      backgroundColors: [
        value?.backgroundColor,
        value?.secondBackgroundColor,
        value?.thirdBackgroundColor,
        value?.fourthBackgroundColor,
      ].flatMap((color) => (color === undefined ? [] : [telegramColor(color)])),
      blur: Boolean(value?.blur),
      motion: Boolean(value?.motion),
      ...(value?.intensity !== undefined ? { intensity: value.intensity } : {}),
      ...(value?.rotation !== undefined ? { rotation: value.rotation } : {}),
      ...(value?.emoticon ? { emoticon: value.emoticon } : {}),
    };
  }
  function mapWallpaper(wallpaper: Tl.TypeWallPaper): TelegramWallpaper[] {
    if (Api.WallPaper.is(wallpaper)) {
      if (Api.Document.is(wallpaper.document)) {
        state.wallpaperDocuments.set(wallpaper.id.toString(), wallpaper.document);
      }
      return [
        {
          id: wallpaper.id.toString(),
          slug: wallpaper.slug,
          dark: Boolean(wallpaper.dark),
          pattern: Boolean(wallpaper.pattern),
          hasFile: Api.Document.is(wallpaper.document),
          settings: mapWallpaperSettings(wallpaper.settings),
        },
      ];
    }
    if (Api.WallPaperNoFile.is(wallpaper)) {
      return [
        {
          id: wallpaper.id.toString(),
          dark: Boolean(wallpaper.dark),
          pattern: false,
          hasFile: false,
          settings: mapWallpaperSettings(wallpaper.settings),
        },
      ];
    }
    return [];
  }
  function telegramColor(color: number) {
    return `#${(color >>> 0).toString(16).padStart(8, '0').slice(-6)}`;
  }
  async function getRecentStickers(): Promise<TelegramSticker[]> {
    const result = await getClient().invoke(Api.messages.GetRecentStickers({ hash: 0n }));
    if (!Api.messages.RecentStickers.is(result)) return [];
    return result.stickers.flatMap((document) => mapStickerDocument(document));
  }
  async function getStickerPacks(): Promise<TelegramStickerPack[]> {
    const result = await getClient().invoke(Api.messages.GetAllStickers({ hash: 0n }));
    if (!Api.messages.AllStickers.is(result)) return [];
    const sets = result.sets.filter(
      (set): set is Tl.StickerSet => Api.StickerSet.is(set) && !set.masks && !set.emojis,
    );
    const packs: TelegramStickerPack[] = [];
    for (let offset = 0; offset < sets.length; offset += 4) {
      const batch = await Promise.allSettled(
        sets.slice(offset, offset + 4).map(async (set) => {
          const contents = await getClient().invoke(
            Api.messages.GetStickerSet({
              stickerset: Api.InputStickerSetID({ id: set.id, accessHash: set.accessHash }),
              hash: 0,
            }),
          );
          return {
            id: set.id.toString(),
            title: set.title,
            stickers: Api.messages.StickerSet.is(contents)
              ? contents.documents.flatMap((document) => mapStickerDocument(document))
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
  async function getSavedGifs(): Promise<TelegramSticker[]> {
    const result = await getClient().invoke(Api.messages.GetSavedGifs({ hash: 0n }));
    if (!Api.messages.SavedGifs.is(result)) return [];
    return result.gifs.flatMap((document) => mapGifDocument(document));
  }
  async function searchGifs(peer: TelegramPeer, query: string): Promise<TelegramSticker[]> {
    const config = await getClient().invoke(Api.help.GetConfig());
    const resolved = await getClient().invoke(
      Api.contacts.ResolveUsername({ username: config.gifSearchUsername || 'gif' }),
    );
    const bot = resolved.users.find((user): user is Tl.User => Api.User.is(user));
    if (!bot?.accessHash) return [];
    const result = await getClient().invoke(
      Api.messages.GetInlineBotResults({
        bot: Api.InputUser({ userId: bot.id, accessHash: bot.accessHash }),
        peer: toInputPeer(peer),
        query,
        offset: '',
      }),
    );
    if (!Api.messages.BotResults.is(result)) return [];
    return result.results.flatMap((item) => {
      if (!Api.BotInlineMediaResult.is(item) || !Api.Document.is(item.document)) return [];
      return mapGifDocument(item.document).map((gif) => ({
        ...gif,
        title: item.title || item.description || query,
        inlineQueryId: result.queryId.toString(),
        inlineResultId: item.id,
      }));
    });
  }
  async function downloadSticker(sticker: TelegramSticker) {
    const document = state.stickerDocuments.get(sticker.id);
    let bytes: File | Uint8Array | undefined;
    if (document) {
      bytes = await getClient().downloadMedia(document, { workers: 1 });
    } else {
      if (sticker.dcId === undefined)
        throw new Error('The cached sticker index is obsolete. Reopen the picker to refresh it.');
      bytes = await getClient().downloadFile(
        Api.InputDocumentFileLocation({
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
  async function downloadCustomEmoji(documentId: string) {
    const documents = await getClient().invoke(
      Api.messages.GetCustomEmojiDocuments({ documentId: [BigInt(documentId)] }),
    );
    const document = documents.find((candidate): candidate is Tl.Document =>
      Api.Document.is(candidate),
    );
    if (!document) throw new Error('Telegram returned no custom emoji document.');
    const bytes = await getClient().downloadMedia(document, { workers: 1 });
    if (!bytes) throw new Error('Telegram returned no custom emoji bytes.');
    return new Blob([bytes as BlobPart], { type: document.mimeType });
  }
  async function getBotCommands(peer: TelegramPeer): Promise<TelegramBotCommand[]> {
    if (peer.kind === 'user') {
      const result = await getClient().invoke(Api.users.GetFullUser({ id: inputUser(peer) }));
      rememberEntities(result.users, result.chats);
      const botInfo = Api.UserFull.is(result.fullUser) ? result.fullUser.botInfo : undefined;
      return Api.BotInfo.is(botInfo) ? mapBotCommands([botInfo], result.users, peer.id) : [];
    }
    const result =
      peer.kind === 'channel'
        ? await getClient().invoke(Api.channels.GetFullChannel({ channel: inputChannel(peer) }))
        : await getClient().invoke(Api.messages.GetFullChat({ chatId: BigInt(peer.id.slice(2)) }));
    rememberEntities(result.users, result.chats);
    const botInfo =
      Api.ChatFull.is(result.fullChat) || Api.ChannelFull.is(result.fullChat)
        ? (result.fullChat.botInfo ?? [])
        : [];
    return mapBotCommands(botInfo, result.users);
  }
  async function startBot(peer: TelegramPeer, startParam: string, randomId: string) {
    if (peer.kind !== 'user') throw new Error('Only a user bot can be started.');
    if (!startParam) return sendText(peer, '/start', randomId);
    const result = await getClient().invoke(
      Api.messages.StartBot({
        bot: inputUser(peer),
        peer: toInputPeer(peer),
        randomId: telegramLong(randomId),
        startParam,
      }),
    );
    return mapOutgoingSendResult(
      result,
      peer,
      randomId,
      'Telegram started the bot but returned no outgoing message.',
    );
  }
  async function answerBotCallback(
    peer: TelegramPeer,
    messageId: number,
    data: number[],
  ): Promise<TelegramBotCallbackResult> {
    const result = await getClient().invoke(
      Api.messages.GetBotCallbackAnswer({
        peer: toInputPeer(peer),
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
  async function requestUrlAuth(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
  ): Promise<TelegramUrlAuthResult> {
    const result = await getClient().invoke(
      Api.messages.RequestUrlAuth({
        peer: toInputPeer(peer),
        msgId: messageId,
        buttonId,
      }),
    );
    return mapUrlAuthResult(result);
  }
  async function acceptUrlAuth(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
    options: TelegramUrlAuthAcceptOptions = {},
  ): Promise<TelegramUrlAuthResult> {
    const result = await getClient().invoke(
      Api.messages.AcceptUrlAuth({
        peer: toInputPeer(peer),
        msgId: messageId,
        buttonId,
        ...(options.writeAllowed ? { writeAllowed: true as const } : {}),
        ...(options.sharePhoneNumber ? { sharePhoneNumber: true as const } : {}),
        ...(options.matchCode ? { matchCode: options.matchCode } : {}),
      }),
    );
    return mapUrlAuthResult(result);
  }
  async function sendSticker(
    peer: TelegramPeer,
    sticker: TelegramSticker,
    randomId: string,
    reply?: TelegramReplyTarget,
  ) {
    if (sticker.inlineQueryId && sticker.inlineResultId) {
      const result = await getClient().invoke(
        Api.messages.SendInlineBotResult({
          peer: toInputPeer(peer),
          randomId: telegramLong(randomId),
          queryId: BigInt(sticker.inlineQueryId),
          id: sticker.inlineResultId,
          ...(reply ? { replyTo: inputReply(reply) } : {}),
        }),
      );
      return mapOutgoingSendResult(
        result,
        peer,
        randomId,
        'Telegram accepted the GIF but returned no message.',
      );
    }
    const result = await getClient().invoke(
      Api.messages.SendMedia({
        peer: toInputPeer(peer),
        media: Api.InputMediaDocument({ id: inputDocument(sticker) }),
        message: '',
        randomId: telegramLong(randomId),
        ...(reply ? { replyTo: inputReply(reply) } : {}),
      }),
    );
    if (Api.UpdateShortSentMessage.is(result)) {
      return mapShortSentMessage(peer, '', randomId, result, reply);
    }
    const message = messagesFromUpdates(result)
      .map((candidate) => mapMessage(candidate))
      .find((candidate): candidate is TelegramMessage => Boolean(candidate));
    if (!message) throw new Error('Telegram accepted the sticker but returned no message.');
    const sentMessage = { ...message, randomId };
    return {
      message: sentMessage,
      updateBatches: toUpdateBatches(result, [sentMessage]),
    };
  }
  async function setReaction(
    peer: TelegramPeer,
    messageId: number,
    emoji?: string,
  ): Promise<TransportMutationResult> {
    const customEmojiId = emoji?.startsWith('custom:') ? emoji.slice('custom:'.length) : undefined;
    const result = await getClient().invoke(
      Api.messages.SendReaction({
        peer: toInputPeer(peer),
        msgId: messageId,
        reaction: customEmojiId
          ? [Api.ReactionCustomEmoji({ documentId: BigInt(customEmojiId) })]
          : emoji
            ? [Api.ReactionEmoji({ emoticon: emoji })]
            : [],
        addToRecent: true,
      }),
    );
    return { updateBatches: toUpdateBatches(result) };
  }
  async function deleteMessages(
    peer: TelegramPeer,
    messageIds: number[],
    revoke: boolean,
  ): Promise<TransportMutationResult> {
    let result: Tl.messages.AffectedMessages;
    if (peer.kind === 'channel') {
      result = await getClient().invoke(
        Api.channels.DeleteMessages({ channel: inputChannel(peer), id: messageIds }),
      );
      for (const messageId of messageIds) forgetMessageMedia(peer.id, messageId);
    } else {
      result = await getClient().invoke(
        Api.messages.DeleteMessages({ id: messageIds, ...(revoke ? { revoke: true } : {}) }),
      );
      for (const messageId of messageIds) forgetMessageMedia(peer.id, messageId);
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
  async function editMessage(
    peer: TelegramPeer,
    messageId: number,
    text: string,
    formats?: TelegramTextFormat[],
    replacement?: EditMediaOptions,
  ): Promise<EditMessageResult> {
    const media = replacement
      ? await uploadInputMedia(replacement.file, replacement.sendAs, false)
      : undefined;
    const result = await getClient().invoke(
      Api.messages.EditMessage({
        peer: toInputPeer(peer),
        id: messageId,
        message: text,
        ...(formats?.length ? { entities: inputEntities(formats) } : {}),
        ...(media ? { media } : {}),
      }),
    );
    const message = messagesFromUpdates(result)
      .map((candidate) => mapMessage(candidate))
      .find((candidate): candidate is TelegramMessage => Boolean(candidate));
    const updateBatches = toUpdateBatches(result);
    if (message) return { message, updateBatches };
    const history = await getHistoryAround(peer, messageId, 3);
    const fallback = history.find(({ id }) => id === messageId);
    if (!fallback) throw new Error('Telegram accepted the edit but returned no message.');
    return { message: fallback, updateBatches };
  }
  async function forwardMessage(
    fromPeer: TelegramPeer,
    toPeer: TelegramPeer,
    messageId: number,
    randomId: string,
  ) {
    const result = await getClient().invoke(
      Api.messages.ForwardMessages({
        fromPeer: toInputPeer(fromPeer),
        id: [messageId],
        randomId: [telegramLong(randomId)],
        toPeer: toInputPeer(toPeer),
      }),
    );
    return mapOutgoingSendResult(
      result,
      toPeer,
      randomId,
      'Telegram accepted the forward but returned no message.',
    );
  }
  function subscribe(listener: (batch: TransportUpdateBatch) => void) {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }
  function installEventHandler(client = getClient(), generation = state.connectionGeneration) {
    if (state.eventHandlerClient === client) return;
    state.eventUnsubscribe?.();
    state.eventUnsubscribe = client.subscribe((event) => {
      const raw: unknown = updateEvent.is(event) ? event.update : event;
      if (generation !== state.connectionGeneration || state.client !== client) return;
      if (connectionStateEvent.is(raw)) {
        if (raw.state === 'connected') {
          clearConnectionLossTimer();
          return;
        }
        if (raw.state === 'disconnected') {
          scheduleConnectionLoss(client, generation);
          return;
        }
      }
      const batch = mapUpdateEnvelope(raw);
      if (
        batch.updates.length === 0 &&
        batch.date === undefined &&
        batch.seq === undefined &&
        batch.seqStart === undefined
      ) {
        return;
      }
      for (const listener of state.listeners) listener(batch);
    });
    state.eventHandlerClient = client;
  }
  function scheduleConnectionLoss(client: MtprotoClient, generation: number) {
    if (state.connectionLossTimer !== undefined) return;
    state.connectionLossTimer = setTimeout(() => {
      state.connectionLossTimer = undefined;
      if (generation !== state.connectionGeneration || state.client !== client) return;
      if (!isPageActive()) {
        scheduleConnectionLoss(client, generation);
        return;
      }
      const batch: TransportUpdateBatch = {
        updates: [{ type: 'connection-state', connected: false }],
      };
      for (const listener of state.listeners) listener(batch);
    }, CONNECTION_LOSS_GRACE_MS);
  }
  function clearConnectionLossTimer() {
    if (state.connectionLossTimer === undefined) return;
    clearTimeout(state.connectionLossTimer);
    state.connectionLossTimer = undefined;
  }
  function mapUpdateEnvelope(raw: unknown): TransportUpdateBatch {
    if (sessionGapEvent.is(raw)) return { updates: [{ type: 'too-long' }] };
    if (connectionStateEvent.is(raw)) {
      return {
        updates: raw.state === 'connected' ? [] : [{ type: 'connection-state', connected: false }],
      };
    }
    if (Api.UpdatesTooLong.is(raw)) return { updates: [{ type: 'too-long' }] };
    if (Api.UpdateShortMessage.is(raw)) {
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
              replyToId: Api.MessageReplyHeader.is(raw.replyTo)
                ? raw.replyTo.replyToMsgId
                : undefined,
              replyQuote: Api.MessageReplyHeader.is(raw.replyTo)
                ? raw.replyTo.quoteText
                : undefined,
              mentions: mapMentions(raw.entities),
              links: mapLinks(raw.entities),
              formats: mapFormats(raw.entities),
              forwardedFrom: mapForwardedFrom(raw.fwdFrom),
            },
          },
        ],
      };
    }
    if (Api.UpdateShortChatMessage.is(raw)) {
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
              replyToId: Api.MessageReplyHeader.is(raw.replyTo)
                ? raw.replyTo.replyToMsgId
                : undefined,
              replyQuote: Api.MessageReplyHeader.is(raw.replyTo)
                ? raw.replyTo.quoteText
                : undefined,
              mentions: mapMentions(raw.entities),
              links: mapLinks(raw.entities),
              formats: mapFormats(raw.entities),
              forwardedFrom: mapForwardedFrom(raw.fwdFrom),
            },
          },
        ],
      };
    }
    if (Api.UpdatesCombined.is(raw)) {
      rememberEntities(raw.users, raw.chats);
      const randomIds = randomIdsByMessageId(raw.updates);
      return {
        updates: raw.updates.flatMap((update) => mapUpdate(update, randomIds)),
        date: raw.date,
        seqStart: raw.seqStart,
        seq: raw.seq,
      };
    }
    if (Api.Updates.is(raw)) {
      rememberEntities(raw.users, raw.chats);
      const randomIds = randomIdsByMessageId(raw.updates);
      return {
        updates: raw.updates.flatMap((update) => mapUpdate(update, randomIds)),
        date: raw.date,
        seq: raw.seq,
      };
    }
    if (Api.UpdateShort.is(raw)) {
      return { updates: mapUpdate(raw.update), date: raw.date };
    }
    if (Api.UpdateShortSentMessage.is(raw)) return { updates: [], date: raw.date };
    return { updates: mapUpdate(raw as Tl.TypeUpdate) };
  }
  function mapUpdate(
    update: Tl.TypeUpdate,
    randomIds: ReadonlyMap<number, string> = new Map(),
  ): TransportUpdate[] {
    if (Api.UpdatePtsChanged.is(update)) return [{ type: 'too-long' }];
    if (Api.UpdateNewMessage.is(update) || Api.UpdateNewChannelMessage.is(update)) {
      const message = mapMessage(update.message);
      const randomId = message ? randomIds.get(message.id) : undefined;
      return message
        ? [
            {
              type: 'new-message',
              pts: update.pts,
              ptsCount: update.ptsCount,
              channelScoped: Api.UpdateNewChannelMessage.is(update),
              message: randomId ? { ...message, randomId } : message,
            },
          ]
        : [];
    }
    if (Api.UpdateEditMessage.is(update) || Api.UpdateEditChannelMessage.is(update)) {
      const message = mapMessage(update.message);
      return message
        ? [
            {
              type: 'edit-message',
              pts: update.pts,
              ptsCount: update.ptsCount,
              channelScoped: Api.UpdateEditChannelMessage.is(update),
              message,
            },
          ]
        : [];
    }
    if (Api.UpdateDeleteMessages.is(update)) {
      return [
        {
          type: 'delete-messages',
          pts: update.pts,
          ptsCount: update.ptsCount,
          messageIds: [...update.messages],
        },
      ];
    }
    if (Api.UpdateDeleteChannelMessages.is(update)) {
      return [
        {
          type: 'delete-messages',
          pts: update.pts,
          ptsCount: update.ptsCount,
          channelScoped: true,
          peerId: `c:${update.channelId}`,
          messageIds: [...update.messages],
        },
      ];
    }
    if (Api.UpdateReadHistoryInbox.is(update)) {
      const peerId = toPeerId(update.peer);
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
    if (Api.UpdateReadHistoryOutbox.is(update)) {
      const peerId = toPeerId(update.peer);
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
    if (Api.UpdateReadChannelInbox.is(update)) {
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
    if (Api.UpdateReadChannelOutbox.is(update)) {
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
    if (Api.UpdateMessageReactions.is(update)) {
      const peerId = toPeerId(update.peer);
      return peerId
        ? [
            {
              type: 'reaction-changed',
              peerId,
              messageId: update.msgId,
              reactions: mapReactions(update.reactions),
            },
          ]
        : [];
    }
    if (Api.UpdateUserTyping.is(update)) {
      return [activityUpdate(`u:${update.userId}`, `u:${update.userId}`, update.action)];
    }
    if (Api.UpdateChatUserTyping.is(update)) {
      return [
        activityUpdate(`g:${update.chatId}`, toPeerId(update.fromId) ?? 'unknown', update.action),
      ];
    }
    if (Api.UpdateChannelUserTyping.is(update)) {
      return [
        activityUpdate(
          `c:${update.channelId}`,
          toPeerId(update.fromId) ?? 'unknown',
          update.action,
        ),
      ];
    }
    if (Api.UpdateUserStatus.is(update)) {
      return [
        {
          type: 'presence-changed',
          peerId: `u:${update.userId}`,
          ...mapUserPresence(update.status),
        },
      ];
    }
    if (update._ === 'updateUserName') {
      return [
        {
          type: 'peer-metadata-changed',
          peerId: `u:${(update as Tl.UpdateUserName).userId}`,
        },
      ];
    }
    if (update._ === 'updatePeerBlocked') {
      const peerId = toPeerId((update as Tl.UpdatePeerBlocked).peerId);
      return peerId ? [{ type: 'peer-metadata-changed', peerId }] : [];
    }
    if (
      Api.UpdateNotifySettings.is(update) &&
      Api.NotifyPeer.is(update.peer) &&
      Api.PeerNotifySettings.is(update.notifySettings)
    ) {
      const peerId = toPeerId(update.peer.peer);
      return peerId
        ? [
            {
              type: 'mute-changed',
              peerId,
              muted: isMuted(
                update.notifySettings,
                mapPeer(update.peer.peer, state.entities),
                state.entities.get(peerId),
              ),
            },
          ]
        : [];
    }
    if (Api.UpdateNotifySettings.is(update) && Api.PeerNotifySettings.is(update.notifySettings)) {
      const kind = Api.NotifyUsers.is(update.peer)
        ? 'users'
        : Api.NotifyChats.is(update.peer)
          ? 'groups'
          : Api.NotifyBroadcasts.is(update.peer)
            ? 'channels'
            : undefined;
      if (kind) {
        state.notifyDefaults.set(kind, update.notifySettings);
        state.notifyDefaultsLoaded = true;
        return [{ type: 'dialog-list-invalidated' }];
      }
    }
    if (
      Api.UpdateDialogPinned.is(update) &&
      (update.folderId === undefined || update.folderId === 0) &&
      Api.DialogPeer.is(update.peer)
    ) {
      const peerId = toPeerId(update.peer.peer);
      return peerId ? [{ type: 'dialog-pinned', peerId, pinned: Boolean(update.pinned) }] : [];
    }
    if (Api.UpdatePinnedDialogs.is(update)) {
      return [{ type: 'dialog-list-invalidated' }];
    }
    if (Api.UpdateFolderPeers.is(update)) {
      return [
        {
          type: 'dialog-folders-changed',
          pts: update.pts,
          ptsCount: update.ptsCount,
          folders: update.folderPeers.flatMap(({ peer, folderId }) => {
            const peerId = toPeerId(peer);
            return peerId ? [{ peerId, folderId }] : [];
          }),
        },
      ];
    }
    if (Api.UpdateSavedGifs.is(update)) {
      return [{ type: 'expression-index-changed', kind: 'gifs' }];
    }
    if (
      Api.UpdateNewStickerSet.is(update) ||
      Api.UpdateStickerSetsOrder.is(update) ||
      Api.UpdateStickerSets.is(update) ||
      Api.UpdateRecentStickers.is(update) ||
      Api.UpdateFavedStickers.is(update) ||
      Api.UpdateMoveStickerSetToTop.is(update)
    ) {
      return [{ type: 'expression-index-changed', kind: 'stickers' }];
    }
    if (Api.UpdatePinnedMessages.is(update)) {
      const peerId = toPeerId(update.peer);
      return peerId
        ? [
            {
              type: 'pinned-messages',
              pts: update.pts,
              ptsCount: update.ptsCount,
              peerId,
              messageIds: [...update.messages],
              pinned: Boolean(update.pinned),
            },
          ]
        : [];
    }
    if (Api.UpdatePinnedChannelMessages.is(update)) {
      return [
        {
          type: 'pinned-messages',
          pts: update.pts,
          ptsCount: update.ptsCount,
          channelScoped: true,
          peerId: `c:${update.channelId}`,
          messageIds: [...update.messages],
          pinned: Boolean(update.pinned),
        },
      ];
    }
    if (Api.UpdateChannelTooLong.is(update)) {
      return [{ type: 'channel-too-long', peerId: `c:${update.channelId}` }];
    }
    if (Api.UpdateBotCommands.is(update)) {
      const peerId = toPeerId(update.peer);
      return peerId ? [{ type: 'bot-commands-changed', peerId, botId: `u:${update.botId}` }] : [];
    }
    return [];
  }
  function mapCursor(state: Tl.updates.State): SyncCursor {
    return { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq };
  }
  function mapActivity(action: Tl.TypeSendMessageAction): TelegramActivityKind {
    if (
      Api.SendMessageUploadPhotoAction.is(action) ||
      Api.SendMessageUploadVideoAction.is(action) ||
      Api.SendMessageUploadDocumentAction.is(action) ||
      Api.SendMessageUploadAudioAction.is(action) ||
      Api.SendMessageUploadRoundAction.is(action)
    ) {
      return 'uploading';
    }
    if (
      Api.SendMessageRecordAudioAction.is(action) ||
      Api.SendMessageRecordVideoAction.is(action) ||
      Api.SendMessageRecordRoundAction.is(action)
    ) {
      return 'recording';
    }
    if (Api.SendMessageChooseStickerAction.is(action)) return 'choosing-sticker';
    return 'typing';
  }
  function activityUpdate(
    peerId: string,
    senderId: string,
    action: Tl.TypeSendMessageAction,
  ): TransportUpdate {
    return Api.SendMessageCancelAction.is(action)
      ? { type: 'activity-ended', peerId, senderId }
      : { type: 'activity', activity: { peerId, senderId, kind: mapActivity(action) } };
  }
  function mapMessage(message: Tl.TypeMessage): TelegramMessage | undefined {
    if (Api.MessageService.is(message)) {
      const peerId = toPeerId(message.peerId);
      if (!peerId) return undefined;
      const senderId = toPeerId(message.fromId) ?? (message.out ? 'self' : peerId);
      const sender = state.entities.get(senderId);
      const senderName = entityTitle(sender);
      const service = mapServiceAction(message.action, senderId);
      return {
        id: message.id,
        peerId,
        senderId,
        ...(senderName ? { senderName } : {}),
        ...senderAvatar(senderId, sender),
        ...senderRole(peerId, senderId),
        text: service.text,
        date: message.date,
        outgoing: Boolean(message.out),
        replyToId: Api.MessageReplyHeader.is(message.replyTo)
          ? message.replyTo.replyToMsgId
          : undefined,
        reactions: mapReactions(message.reactions),
        service,
      };
    }
    if (!Api.Message.is(message)) return undefined;
    const peerId = toPeerId(message.peerId);
    if (!peerId) return undefined;
    const mediaKey = `${peerId}:${message.id}`;
    if (message.media) {
      rememberBounded(state.messageMedia, mediaKey, message.media, MAX_MESSAGE_MEDIA_ENTRIES);
    } else {
      state.messageMedia.delete(mediaKey);
    }
    if (
      Api.MessageMediaWebPage.is(message.media) &&
      Api.WebPage.is(message.media.webpage) &&
      Api.Photo.is(message.media.webpage.photo)
    ) {
      rememberBounded(
        state.linkPreviewPhotos,

        mediaKey,
        message.media.webpage.photo,
        MAX_MESSAGE_MEDIA_ENTRIES,
      );
    } else {
      state.linkPreviewPhotos.delete(mediaKey);
    }
    const links = mapLinks(message.entities);
    const senderId = toPeerId(message.fromId) ?? (message.out ? 'self' : peerId);
    const sender = state.entities.get(senderId);
    const peerEntity = state.entities.get(peerId);
    const senderName = entityTitle(sender);
    const keyboardBot = state.entities.get(
      message.viaBotId !== undefined ? `u:${message.viaBotId}` : senderId,
    );
    const botUsername =
      Api.User.is(keyboardBot) && keyboardBot.bot ? keyboardBot.username : undefined;
    return {
      id: message.id,
      peerId,
      senderId,
      ...(senderName ? { senderName } : {}),
      ...senderAvatar(senderId, sender),
      ...senderRole(peerId, senderId, message.postAuthor),
      text: message.message,
      date: message.date,
      outgoing: Boolean(message.out),
      protected: Boolean(
        message.noforwards ||
        ((Api.Chat.is(peerEntity) || Api.Channel.is(peerEntity)) && peerEntity.noforwards),
      ),
      editedAt: message.editDate,
      groupedId: message.groupedId?.toString(),
      forwardedFrom: mapForwardedFrom(message.fwdFrom),
      replyToId: Api.MessageReplyHeader.is(message.replyTo)
        ? message.replyTo.replyToMsgId
        : undefined,
      replyQuote: Api.MessageReplyHeader.is(message.replyTo)
        ? message.replyTo.quoteText
        : undefined,
      botKeyboard: mapBotKeyboard(message.replyMarkup, botUsername),
      media: mapMedia(message.media),
      reactions: mapReactions(message.reactions),
      mentions: mapMentions(message.entities),
      links,
      linkPreview: mapLinkPreview(message.media),
      formats: mapFormats(message.entities),
      richMessage: mapRichMessage(message.richMessage),
      pinned: message.pinned,
    };
  }
  function mapForwardedFrom(
    header: Tl.TypeMessageFwdHeader | undefined,
  ): TelegramMessage['forwardedFrom'] {
    if (!header) return undefined;
    const source = header.fromId ?? header.savedFromId ?? header.savedFromPeer;
    const peerId = toPeerId(source);
    const name =
      header.fromName ||
      (peerId ? entityTitle(state.entities.get(peerId)) : '') ||
      header.savedFromName ||
      header.postAuthor ||
      peerId;
    if (!name) return undefined;
    const messageId = header.channelPost ?? header.savedFromMsgId;
    const entity = peerId ? state.entities.get(peerId) : undefined;
    const avatar = peerId ? forwardedAvatar(peerId, entity) : undefined;
    return {
      name,
      ...(peerId ? { peerId } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
      ...avatar,
    };
  }
  function forwardedAvatar(peerId: string, entity: Tl.TypeUser | Tl.TypeChat | undefined) {
    const photo = Api.User.is(entity)
      ? Api.UserProfilePhoto.is(entity.photo)
        ? entity.photo
        : undefined
      : Api.Chat.is(entity) || Api.Channel.is(entity)
        ? Api.ChatPhoto.is(entity.photo)
          ? entity.photo
          : undefined
        : undefined;
    return {
      hasAvatar: Boolean(photo),
      ...(photo ? { avatarId: photo.photoId.toString() } : {}),
      color: peerColor(peerId, entity),
    };
  }
  function mapServiceAction(
    action: Tl.TypeMessageAction,
    actorId: string,
  ): NonNullable<TelegramMessage['service']> {
    const actor = servicePeerName(actorId);
    const base = { actorId };
    if (Api.MessageActionChatCreate.is(action)) {
      return {
        ...base,
        kind: 'chat-created',
        title: action.title,
        text: `${actor} created the group "${action.title}"`,
      };
    }
    if (Api.MessageActionChannelCreate.is(action)) {
      return {
        ...base,
        kind: 'chat-created',
        title: action.title,
        text: `${actor} created the channel "${action.title}"`,
      };
    }
    if (Api.MessageActionChatEditTitle.is(action)) {
      return {
        ...base,
        kind: 'title-changed',
        title: action.title,
        text: `${actor} changed the chat name to "${action.title}"`,
      };
    }
    if (Api.MessageActionChatEditPhoto.is(action)) {
      return { ...base, kind: 'photo-changed', text: `${actor} changed the chat photo` };
    }
    if (Api.MessageActionChatDeletePhoto.is(action)) {
      return { ...base, kind: 'photo-removed', text: `${actor} removed the chat photo` };
    }
    if (Api.MessageActionChatAddUser.is(action)) {
      const users = action.users.map((id) => serviceUser(id));
      const targetUserIds = users.map(({ id }) => id);
      const targets = serviceNameList(users.map(({ name }) => name));
      const joined = targetUserIds.length === 1 && targetUserIds[0] === actorId;
      return {
        ...base,
        kind: 'users-added',
        targetUserIds,
        text: joined ? `${actor} joined the group` : `${actor} added ${targets}`,
      };
    }
    if (Api.MessageActionChatDeleteUser.is(action)) {
      const target = serviceUser(action.userId);
      return {
        ...base,
        kind: 'user-removed',
        targetUserIds: [target.id],
        text: target.id === actorId ? `${actor} left the group` : `${actor} removed ${target.name}`,
      };
    }
    if (Api.MessageActionChatJoinedByLink.is(action)) {
      return { ...base, kind: 'joined-by-link', text: `${actor} joined via an invite link` };
    }
    if (Api.MessageActionChatJoinedByRequest.is(action)) {
      return {
        ...base,
        kind: 'joined-by-request',
        text: `${actor} joined after their request was approved`,
      };
    }
    if (Api.MessageActionPinMessage.is(action)) {
      return { ...base, kind: 'message-pinned', text: `${actor} pinned a message` };
    }
    if (Api.MessageActionHistoryClear.is(action)) {
      return { ...base, kind: 'history-cleared', text: `${actor} cleared the chat history` };
    }
    if (Api.MessageActionSetMessagesTTL.is(action)) {
      return {
        ...base,
        kind: 'auto-delete-changed',
        text:
          action.period === 0
            ? `${actor} turned off auto-delete`
            : `${actor} set messages to auto-delete after ${serviceDuration(action.period)}`,
      };
    }
    if (Api.MessageActionTopicCreate.is(action)) {
      return {
        ...base,
        kind: 'topic-created',
        title: action.title,
        text: `${actor} created the topic "${action.title}"`,
      };
    }
    if (Api.MessageActionTopicEdit.is(action)) {
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
    if (Api.MessageActionScreenshotTaken.is(action)) {
      return { ...base, kind: 'screenshot-taken', text: `${actor} took a screenshot` };
    }
    if (Api.MessageActionCustomAction.is(action)) {
      return { ...base, kind: 'custom', text: action.message };
    }
    if (Api.MessageActionContactSignUp.is(action)) {
      return { ...base, kind: 'other', text: `${actor} joined Telegram` };
    }
    if (
      Api.MessageActionChatMigrateTo.is(action) ||
      Api.MessageActionChannelMigrateFrom.is(action)
    ) {
      return { ...base, kind: 'other', text: 'This group was upgraded to a channel' };
    }
    if (Api.MessageActionGroupCallScheduled.is(action)) {
      const when = new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(action.scheduleDate * 1000));
      return { ...base, kind: 'other', text: `${actor} scheduled a group call for ${when}` };
    }
    if (Api.MessageActionGroupCall.is(action)) {
      return {
        ...base,
        kind: 'other',
        text: action.duration
          ? `Group call ended after ${serviceDuration(action.duration)}`
          : `${actor} started a group call`,
      };
    }
    if (Api.MessageActionInviteToGroupCall.is(action)) {
      const users = action.users.map((id) => serviceUser(id));
      return {
        ...base,
        kind: 'other',
        targetUserIds: users.map(({ id }) => id),
        text: `${actor} invited ${serviceNameList(users.map(({ name }) => name))} to a group call`,
      };
    }
    if (Api.MessageActionGameScore.is(action)) {
      return { ...base, kind: 'other', text: `${actor} scored ${action.score} in a game` };
    }
    return { ...base, kind: 'other', text: 'Telegram service event' };
  }
  function serviceUser(userId: bigint) {
    const id = `u:${userId}`;
    return { id, name: servicePeerName(id) };
  }
  function servicePeerName(peerId: string) {
    if (peerId === 'self') return 'You';
    return entityTitle(state.entities.get(peerId)) || 'Someone';
  }
  function serviceNameList(names: readonly string[]) {
    if (names.length <= 1) return names[0] ?? 'someone';
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
  }
  function serviceDuration(seconds: number) {
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
  function mapReactions(reactions: Tl.TypeMessageReactions | undefined): TelegramReaction[] {
    if (!Api.MessageReactions.is(reactions)) return [];
    return reactions.results.flatMap((result) => {
      if (Api.ReactionEmoji.is(result.reaction)) {
        return [
          {
            emoji: result.reaction.emoticon,
            count: result.count,
            chosen: result.chosenOrder !== undefined,
          },
        ];
      }
      if (Api.ReactionCustomEmoji.is(result.reaction)) {
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
  function mapBotCommands(
    botInfo: readonly Tl.BotInfo[],
    users: readonly Tl.TypeUser[],
    fallbackBotId?: string,
  ): TelegramBotCommand[] {
    const userById = new Map(
      users
        .filter((user): user is Tl.User => Api.User.is(user))
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
  function mapBotKeyboard(
    markup: Tl.TypeReplyMarkup | undefined,
    botUsername?: string,
  ): TelegramBotKeyboard | undefined {
    if (Api.ReplyKeyboardHide.is(markup)) {
      return { kind: 'reply', rows: [], hidden: true };
    }
    if (Api.ReplyKeyboardForceReply.is(markup)) {
      return {
        kind: 'reply',
        rows: [],
        forceReply: true,
        singleUse: Boolean(markup.singleUse),
        placeholder: markup.placeholder,
      };
    }
    if (Api.ReplyKeyboardMarkup.is(markup)) {
      return {
        kind: 'reply',
        rows: markup.rows.map((row) =>
          row.buttons.map((button) => mapBotButton(button, botUsername)),
        ),
        singleUse: Boolean(markup.singleUse),
        persistent: Boolean(markup.persistent),
        placeholder: markup.placeholder,
      };
    }
    if (Api.ReplyInlineMarkup.is(markup)) {
      return {
        kind: 'inline',
        rows: markup.rows.map((row) =>
          row.buttons.map((button) => mapBotButton(button, botUsername)),
        ),
      };
    }
    return undefined;
  }
  function mapBotButton(button: Tl.TypeKeyboardButton, botUsername?: string): TelegramBotButton {
    if (Api.KeyboardButton.is(button)) return { kind: 'text', text: button.text };
    if (Api.KeyboardButtonUrl.is(button)) {
      return { kind: 'url', text: button.text, url: button.url };
    }
    if (Api.KeyboardButtonUrlAuth.is(button)) {
      return {
        kind: 'url-auth',
        text: button.text,
        url: button.url,
        buttonId: button.buttonId,
      };
    }
    if (Api.KeyboardButtonCallback.is(button)) {
      return { kind: 'callback', text: button.text, data: [...button.data] };
    }
    if (Api.KeyboardButtonCopy.is(button)) {
      return { kind: 'copy', text: button.text, copyText: button.copyText };
    }
    if (Api.KeyboardButtonSwitchInline.is(button)) {
      return {
        kind: 'switch-inline',
        text: button.text,
        query: button.query,
        samePeer: Boolean(button.samePeer),
        ...(botUsername ? { botUsername } : {}),
      };
    }
    if (Api.KeyboardButtonUserProfile.is(button)) {
      return { kind: 'url', text: button.text, url: `tg://user?id=${button.userId}` };
    }
    return { kind: 'unsupported', text: button.text };
  }
  function mapUrlAuthResult(result: Tl.TypeUrlAuthResult): TelegramUrlAuthResult {
    if (Api.UrlAuthResultAccepted.is(result)) {
      return { kind: 'accepted', url: result.url };
    }
    if (Api.UrlAuthResultDefault.is(result)) return { kind: 'default' };
    const botTitle = entityTitle(result.bot) || 'Telegram bot';
    rememberEntities([result.bot], []);
    return {
      kind: 'request',
      botTitle,
      domain: result.domain,
      requestWriteAccess: Boolean(result.requestWriteAccess),
      requestPhoneNumber: Boolean(result.requestPhoneNumber),
      matchCodesFirst: Boolean(result.matchCodesFirst),
      isApp: Boolean(result.isApp),
      matchCodes: result.matchCodes ? [...result.matchCodes] : undefined,
      verifiedAppName: result.verifiedAppName,
    };
  }
  function mapMentions(entities: readonly Tl.TypeMessageEntity[] | undefined) {
    return (entities ?? []).flatMap((entity) => {
      if (Api.MessageEntityMention.is(entity)) {
        return [{ offset: entity.offset, length: entity.length }];
      }
      if (Api.MessageEntityMentionName.is(entity)) {
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
  function mapLinks(entities: readonly Tl.TypeMessageEntity[] | undefined): TelegramLink[] {
    return (entities ?? []).flatMap((entity) => {
      if (Api.MessageEntityUrl.is(entity)) {
        return [{ offset: entity.offset, length: entity.length }];
      }
      if (Api.MessageEntityTextUrl.is(entity)) {
        return [{ offset: entity.offset, length: entity.length, url: entity.url }];
      }
      return [];
    });
  }
  function mapLinkPreview(media: Tl.TypeMessageMedia | undefined) {
    if (!Api.MessageMediaWebPage.is(media)) return undefined;
    if (Api.WebPage.is(media.webpage)) {
      return {
        url: media.webpage.url,
        siteName: media.webpage.siteName,
        title: media.webpage.title,
        description: media.webpage.description,
        hasPhoto: Api.Photo.is(media.webpage.photo),
        ...(media.forceLargeMedia
          ? { photoSize: 'large' as const }
          : media.forceSmallMedia
            ? { photoSize: 'small' as const }
            : {}),
      };
    }
    return undefined;
  }
  function mapFormats(entities: readonly Tl.TypeMessageEntity[] | undefined) {
    return (entities ?? []).flatMap((entity) => {
      const kind = Api.MessageEntityBold.is(entity)
        ? ('bold' as const)
        : Api.MessageEntityItalic.is(entity)
          ? ('italic' as const)
          : Api.MessageEntityUnderline.is(entity)
            ? ('underline' as const)
            : Api.MessageEntityStrike.is(entity)
              ? ('strike' as const)
              : Api.MessageEntityCode.is(entity)
                ? ('code' as const)
                : Api.MessageEntityPre.is(entity)
                  ? ('pre' as const)
                  : Api.MessageEntitySpoiler.is(entity)
                    ? ('spoiler' as const)
                    : Api.MessageEntityBlockquote.is(entity)
                      ? entity.collapsed
                        ? ('expandableBlockquote' as const)
                        : ('blockquote' as const)
                      : Api.MessageEntityCustomEmoji.is(entity)
                        ? ('customEmoji' as const)
                        : Api.MessageEntityFormattedDate.is(entity)
                          ? ('formattedDate' as const)
                          : Api.MessageEntityDiffInsert.is(entity)
                            ? ('diffInsert' as const)
                            : Api.MessageEntityDiffReplace.is(entity)
                              ? ('diffReplace' as const)
                              : Api.MessageEntityDiffDelete.is(entity)
                                ? ('diffDelete' as const)
                                : undefined;
      if (!kind) return [];
      return [
        {
          offset: entity.offset,
          length: entity.length,
          kind,
          ...(Api.MessageEntityCustomEmoji.is(entity)
            ? { customEmojiId: entity.documentId.toString() }
            : {}),
          ...(Api.MessageEntityFormattedDate.is(entity) ? { timestamp: entity.date } : {}),
          ...(Api.MessageEntityDiffReplace.is(entity) ? { oldText: entity.oldText } : {}),
        },
      ];
    });
  }
  function mapRichMessage(message: Tl.TypeRichMessage | undefined) {
    if (!Api.RichMessage.is(message)) return undefined;
    return {
      blocks: message.blocks.flatMap((block) => mapRichBlock(block)),
      rtl: Boolean(message.rtl),
      partial: Boolean(message.part),
    };
  }
  function richTextValue(text: Tl.TypeRichText): string {
    if (Api.TextPlain.is(text)) return text.text;
    if (Api.TextConcat.is(text)) return text.texts.map((part) => richTextValue(part)).join('');
    if (Api.TextCustomEmoji.is(text)) return text.alt;
    if (Api.TextMath.is(text)) return text.source;
    if (Api.TextImage.is(text)) return '\ufffc';
    if ('text' in text && text.text) return richTextValue(text.text);
    return '';
  }
  function mapRichText(text: Tl.TypeRichText): RichText {
    if (Api.TextPlain.is(text)) return { kind: 'text', text: text.text };
    if (Api.TextEmpty.is(text)) return { kind: 'text', text: '' };
    if (Api.TextConcat.is(text)) {
      return { kind: 'concat', children: text.texts.map((part) => mapRichText(part)) };
    }
    if (Api.TextBold.is(text)) return { kind: 'bold', child: mapRichText(text.text) };
    if (Api.TextItalic.is(text)) return { kind: 'italic', child: mapRichText(text.text) };
    if (Api.TextUnderline.is(text)) return { kind: 'underline', child: mapRichText(text.text) };
    if (Api.TextStrike.is(text)) return { kind: 'strike', child: mapRichText(text.text) };
    if (Api.TextFixed.is(text)) return { kind: 'code', child: mapRichText(text.text) };
    if (Api.TextSubscript.is(text)) return { kind: 'subscript', child: mapRichText(text.text) };
    if (Api.TextSuperscript.is(text)) return { kind: 'superscript', child: mapRichText(text.text) };
    if (Api.TextMarked.is(text)) return { kind: 'marked', child: mapRichText(text.text) };
    if (Api.TextSpoiler.is(text)) return { kind: 'spoiler', child: mapRichText(text.text) };
    if (Api.TextUrl.is(text)) {
      return { kind: 'link', child: mapRichText(text.text), url: text.url };
    }
    if (Api.TextEmail.is(text)) {
      return { kind: 'link', child: mapRichText(text.text), url: `mailto:${text.email}` };
    }
    if (Api.TextPhone.is(text)) {
      return { kind: 'link', child: mapRichText(text.text), url: `tel:${text.phone}` };
    }
    if (Api.TextAutoUrl.is(text)) {
      return {
        kind: 'link',
        child: mapRichText(text.text),
        url: richTextValue(text.text),
      };
    }
    if (Api.TextAutoEmail.is(text)) {
      return {
        kind: 'link',
        child: mapRichText(text.text),
        url: `mailto:${richTextValue(text.text)}`,
      };
    }
    if (Api.TextAutoPhone.is(text)) {
      return {
        kind: 'link',
        child: mapRichText(text.text),
        url: `tel:${richTextValue(text.text)}`,
      };
    }
    if (Api.TextMentionName.is(text)) {
      return {
        kind: 'link',
        child: mapRichText(text.text),
        url: `tg://user?id=${text.userId}`,
      };
    }
    if (Api.TextMention.is(text)) {
      const value = richTextValue(text.text);
      return {
        kind: 'link',
        child: mapRichText(text.text),
        url: value.startsWith('@') ? `https://t.me/${value.slice(1)}` : value,
      };
    }
    if (Api.TextCustomEmoji.is(text)) {
      return { kind: 'customEmoji', alt: text.alt, documentId: text.documentId.toString() };
    }
    if (Api.TextImage.is(text)) {
      return { kind: 'customEmoji', alt: '\ufffc', documentId: text.documentId.toString() };
    }
    if (Api.TextMath.is(text)) return { kind: 'math', source: text.source };
    if (Api.TextAnchor.is(text)) {
      return { kind: 'anchor', child: mapRichText(text.text), name: text.name };
    }
    if (Api.TextDate.is(text)) {
      return { kind: 'date', child: mapRichText(text.text), timestamp: text.date };
    }
    if (Api.TextDiff.is(text)) {
      return {
        kind: 'diff',
        child: mapRichText(text.text),
        oldText: mapRichText(text.oldText),
      };
    }
    if ('text' in text && text.text) return mapRichText(text.text);
    return { kind: 'text', text: '' };
  }
  function mapRichCaption(caption: Tl.TypePageCaption): RichCaption {
    return {
      text: mapRichText(caption.text),
      ...(Api.TextEmpty.is(caption.credit) ? {} : { credit: mapRichText(caption.credit) }),
    };
  }
  function mapRichBlock(block: Tl.TypePageBlock): RichBlock[] {
    const textRole = Api.PageBlockTitle.is(block)
      ? ('title' as const)
      : Api.PageBlockSubtitle.is(block)
        ? ('subtitle' as const)
        : Api.PageBlockHeader.is(block)
          ? ('header' as const)
          : Api.PageBlockSubheader.is(block)
            ? ('subheader' as const)
            : Api.PageBlockParagraph.is(block)
              ? ('paragraph' as const)
              : Api.PageBlockFooter.is(block)
                ? ('footer' as const)
                : Api.PageBlockKicker.is(block)
                  ? ('kicker' as const)
                  : Api.PageBlockThinking.is(block)
                    ? ('thinking' as const)
                    : undefined;
    if (textRole && 'text' in block) {
      return [{ kind: 'text', role: textRole, text: mapRichText(block.text) }];
    }
    const heading = Api.PageBlockHeading1.is(block)
      ? 1
      : Api.PageBlockHeading2.is(block)
        ? 2
        : Api.PageBlockHeading3.is(block)
          ? 3
          : Api.PageBlockHeading4.is(block)
            ? 4
            : Api.PageBlockHeading5.is(block)
              ? 5
              : Api.PageBlockHeading6.is(block)
                ? 6
                : undefined;
    if (heading && 'text' in block) {
      return [
        {
          kind: 'heading',
          level: heading as 1 | 2 | 3 | 4 | 5 | 6,
          text: mapRichText(block.text),
        },
      ];
    }
    if (Api.PageBlockPreformatted.is(block)) {
      return [
        { kind: 'pre', text: mapRichText(block.text), language: block.language || undefined },
      ];
    }
    if (Api.PageBlockDivider.is(block)) return [{ kind: 'divider' }];
    if (Api.PageBlockAnchor.is(block)) return [{ kind: 'anchor', name: block.name }];
    if (Api.PageBlockMath.is(block)) return [{ kind: 'math', source: block.source }];
    if (Api.PageBlockAuthorDate.is(block)) {
      return [
        {
          kind: 'author',
          author: mapRichText(block.author),
          publishedAt: block.publishedDate,
        },
      ];
    }
    if (Api.PageBlockList.is(block) || Api.PageBlockOrderedList.is(block)) {
      return [
        {
          kind: 'list',
          ordered: Api.PageBlockOrderedList.is(block),
          ...(Api.PageBlockOrderedList.is(block)
            ? { reversed: Boolean(block.reversed), start: block.start }
            : {}),
          items: block.items.map((item) => ({
            ...('checkbox' in item
              ? { checkbox: Boolean(item.checkbox), checked: Boolean(item.checked) }
              : {}),
            ...('num' in item && item.num ? { marker: item.num } : {}),
            ...('value' in item && item.value !== undefined ? { value: item.value } : {}),
            ...('text' in item
              ? { text: mapRichText(item.text) }
              : 'blocks' in item
                ? { blocks: item.blocks.flatMap((child) => mapRichBlock(child)) }
                : {}),
          })),
        },
      ];
    }
    if (Api.PageBlockBlockquote.is(block)) {
      return [
        {
          kind: 'quote',
          blocks: [{ kind: 'text', role: 'paragraph', text: mapRichText(block.text) }],
          ...(Api.TextEmpty.is(block.caption) ? {} : { caption: mapRichText(block.caption) }),
        },
      ];
    }
    if (Api.PageBlockPullquote.is(block)) {
      return [
        {
          kind: 'quote',
          pull: true,
          blocks: [{ kind: 'text', role: 'paragraph', text: mapRichText(block.text) }],
          ...(Api.TextEmpty.is(block.caption) ? {} : { caption: mapRichText(block.caption) }),
        },
      ];
    }
    if (Api.PageBlockBlockquoteBlocks.is(block)) {
      return [
        {
          kind: 'quote',
          expandable: true,
          blocks: block.blocks.flatMap((child) => mapRichBlock(child)),
          ...(Api.TextEmpty.is(block.caption) ? {} : { caption: mapRichText(block.caption) }),
        },
      ];
    }
    if (Api.PageBlockDetails.is(block)) {
      return [
        {
          kind: 'details',
          title: mapRichText(block.title),
          blocks: block.blocks.flatMap((child) => mapRichBlock(child)),
          open: Boolean(block.open),
        },
      ];
    }
    if (Api.PageBlockTable.is(block)) {
      return [
        {
          kind: 'table',
          ...(Api.TextEmpty.is(block.title) ? {} : { title: mapRichText(block.title) }),
          bordered: Boolean(block.bordered),
          striped: Boolean(block.striped),
          rows: block.rows.map((row) =>
            row.cells.map((cell) => ({
              ...(cell.text ? { text: mapRichText(cell.text) } : {}),
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
    if (Api.PageBlockCover.is(block)) {
      return [{ kind: 'group', mode: 'cover', blocks: mapRichBlock(block.cover) }];
    }
    if (Api.PageBlockCollage.is(block) || Api.PageBlockSlideshow.is(block)) {
      return [
        {
          kind: 'group',
          mode: Api.PageBlockCollage.is(block) ? 'collage' : 'slideshow',
          blocks: block.items.flatMap((child) => mapRichBlock(child)),
          caption: mapRichCaption(block.caption),
        },
      ];
    }
    if (
      Api.PageBlockPhoto.is(block) ||
      Api.PageBlockVideo.is(block) ||
      Api.PageBlockAudio.is(block)
    ) {
      return [
        {
          kind: 'media',
          mediaKind: Api.PageBlockPhoto.is(block)
            ? 'photo'
            : Api.PageBlockVideo.is(block)
              ? 'video'
              : 'audio',
          id: (Api.PageBlockPhoto.is(block)
            ? block.photoId
            : Api.PageBlockVideo.is(block)
              ? block.videoId
              : block.audioId
          ).toString(),
          caption: mapRichCaption(block.caption),
          ...('spoiler' in block ? { spoiler: Boolean(block.spoiler) } : {}),
        },
      ];
    }
    if (Api.PageBlockEmbed.is(block)) {
      return [
        {
          kind: 'media',
          mediaKind: 'embed',
          url: block.url,
          caption: mapRichCaption(block.caption),
        },
      ];
    }
    if (Api.PageBlockMap.is(block)) {
      const url = Api.GeoPoint.is(block.geo)
        ? `https://www.openstreetmap.org/?mlat=${block.geo.lat}&mlon=${block.geo.long}`
        : undefined;
      return [{ kind: 'media', mediaKind: 'map', url, caption: mapRichCaption(block.caption) }];
    }
    if (Api.PageBlockEmbedPost.is(block)) {
      return [
        {
          kind: 'quote',
          blocks: block.blocks.flatMap((child) => mapRichBlock(child)),
          caption: { kind: 'link', child: { kind: 'text', text: block.author }, url: block.url },
        },
      ];
    }
    if (Api.PageBlockChannel.is(block)) {
      return [
        {
          kind: 'text',
          role: 'paragraph',
          text: { kind: 'text', text: 'title' in block.channel ? block.channel.title : 'Channel' },
        },
      ];
    }
    if (Api.PageBlockRelatedArticles.is(block)) {
      return [
        { kind: 'text', role: 'subheader', text: mapRichText(block.title) },
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
  function inputDocument(sticker: TelegramSticker) {
    return Api.InputDocument({
      id: BigInt(sticker.id),
      accessHash: BigInt(sticker.accessHash),
      fileReference: new Uint8Array(sticker.fileReference),
    });
  }
  function inputEntities(formats: readonly TelegramTextFormat[]): Tl.TypeMessageEntity[] {
    return formats.map((format): Tl.TypeMessageEntity => {
      const base = { offset: format.offset, length: format.length };
      if (format.kind === 'bold') return Api.MessageEntityBold(base);
      if (format.kind === 'italic') return Api.MessageEntityItalic(base);
      if (format.kind === 'underline') return Api.MessageEntityUnderline(base);
      if (format.kind === 'strike') return Api.MessageEntityStrike(base);
      if (format.kind === 'code') return Api.MessageEntityCode(base);
      if (format.kind === 'pre') return Api.MessageEntityPre({ ...base, language: '' });
      if (format.kind === 'spoiler') return Api.MessageEntitySpoiler(base);
      if (format.kind === 'blockquote') return Api.MessageEntityBlockquote(base);
      if (format.kind === 'expandableBlockquote') {
        return Api.MessageEntityBlockquote({ ...base, collapsed: true });
      }
      if (format.kind === 'textUrl') {
        return Api.MessageEntityTextUrl({ ...base, url: format.url ?? '' });
      }
      if (format.kind === 'customEmoji') {
        return Api.MessageEntityCustomEmoji({
          ...base,
          documentId: BigInt(format.customEmojiId ?? 0),
        });
      }
      if (format.kind === 'formattedDate') {
        return Api.MessageEntityFormattedDate({ ...base, date: format.timestamp ?? 0 });
      }
      if (format.kind === 'diffInsert') return Api.MessageEntityDiffInsert(base);
      if (format.kind === 'diffReplace') {
        return Api.MessageEntityDiffReplace({ ...base, oldText: format.oldText ?? '' });
      }
      return Api.MessageEntityDiffDelete(base);
    });
  }
  async function uploadAlbumMedia(
    peer: Tl.TypeInputPeer,
    media: Tl.TypeInputMedia,
  ): Promise<Tl.TypeInputMedia> {
    const uploaded = await getClient().invoke(Api.messages.UploadMedia({ peer, media }));
    if (Api.MessageMediaPhoto.is(uploaded) && Api.Photo.is(uploaded.photo)) {
      return Api.InputMediaPhoto({
        id: Api.InputPhoto({
          id: uploaded.photo.id,
          accessHash: uploaded.photo.accessHash,
          fileReference: uploaded.photo.fileReference,
        }),
      });
    }
    if (Api.MessageMediaDocument.is(uploaded) && Api.Document.is(uploaded.document)) {
      return Api.InputMediaDocument({
        id: Api.InputDocument({
          id: uploaded.document.id,
          accessHash: uploaded.document.accessHash,
          fileReference: uploaded.document.fileReference,
        }),
      });
    }
    throw new Error('Telegram could not prepare an album attachment.');
  }
  async function uploadInputMedia(
    file: File,
    sendAs: OutgoingAttachmentMode,
    asSticker: boolean,
    onProgress?: (progress: number) => void,
  ): Promise<Tl.TypeInputMedia> {
    const uploaded = await getClient().uploadFile({
      file,
      workers: 2,
      ...(onProgress ? { onProgress } : {}),
    });
    const isPlainPhoto =
      sendAs === 'media' &&
      file.type.startsWith('image/') &&
      !asSticker &&
      file.type !== 'image/gif';
    if (isPlainPhoto) return Api.InputMediaUploadedPhoto({ file: uploaded });
    const attributes: Tl.TypeDocumentAttribute[] = [
      Api.DocumentAttributeFilename({ fileName: file.name }),
    ];

    if (asSticker) {
      attributes.push(
        Api.DocumentAttributeSticker({
          alt: '🙂',
          stickerset: Api.InputStickerSetEmpty(),
        }),
      );
    } else if (sendAs === 'media' && file.type === 'image/gif') {
      attributes.push(Api.DocumentAttributeAnimated());
    } else if (sendAs === 'media' && file.type.startsWith('video/')) {
      const metadata = await (dependencies.readVideoMetadata ?? readVideoMetadata)(file);
      attributes.push(
        Api.DocumentAttributeVideo({
          duration: metadata.duration,
          w: metadata.width,
          h: metadata.height,
          supportsStreaming: true,
        }),
      );
    }
    return Api.InputMediaUploadedDocument({
      file: uploaded,
      mimeType: file.type || 'application/octet-stream',
      attributes,
      ...(asSticker || sendAs === 'file' ? { forceFile: true as const } : {}),
    });
  }
  async function readVideoMetadata(file: File) {
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
  function mapStickerDocument(document: Tl.TypeDocument): TelegramSticker[] {
    if (!Api.Document.is(document)) return [];
    rememberBounded(
      state.stickerDocuments,

      document.id.toString(),
      document,
      MAX_STICKER_DOCUMENT_ENTRIES,
    );
    const attribute = document.attributes.find(
      (candidate): candidate is Tl.DocumentAttributeSticker =>
        Api.DocumentAttributeSticker.is(candidate),
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
  function mapGifDocument(document: Tl.TypeDocument): TelegramSticker[] {
    if (!Api.Document.is(document)) return [];
    rememberBounded(
      state.stickerDocuments,

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
  function inputReply(reply: TelegramReplyTarget) {
    return Api.InputReplyToMessage({
      replyToMsgId: reply.messageId,
      ...(reply.quoteText ? { quoteText: reply.quoteText } : {}),
    });
  }
  function mapMedia(media: Tl.TypeMessageMedia | undefined) {
    if (Api.MessageMediaPhoto.is(media) && Api.Photo.is(media.photo)) {
      const dimensions = [...media.photo.sizes]
        .reverse()
        .find((size): size is typeof size & { w: number; h: number } => 'w' in size && 'h' in size);
      return {
        kind: 'photo' as const,
        name: `photo-${media.photo.id}.jpg`,
        mimeType: 'image/jpeg',
        cacheKey: `photo:${media.photo.id}`,
        ...(media.spoiler ? { spoiler: true } : {}),
        ...(dimensions ? { width: dimensions.w, height: dimensions.h } : {}),
      };
    }
    if (!Api.MessageMediaDocument.is(media) || !Api.Document.is(media.document)) {
      return undefined;
    }
    const document = media.document;
    const filename = document.attributes.find(
      (attribute): attribute is Tl.DocumentAttributeFilename =>
        Api.DocumentAttributeFilename.is(attribute),
    );
    const sticker = document.attributes.some((attribute) =>
      Api.DocumentAttributeSticker.is(attribute),
    );
    const videoAttribute = document.attributes.find(
      (attribute): attribute is Tl.DocumentAttributeVideo =>
        Api.DocumentAttributeVideo.is(attribute),
    );
    const audioAttribute = document.attributes.find(
      (attribute): attribute is Tl.DocumentAttributeAudio =>
        Api.DocumentAttributeAudio.is(attribute),
    );
    const imageAttribute = document.attributes.find(
      (attribute): attribute is Tl.DocumentAttributeImageSize =>
        Api.DocumentAttributeImageSize.is(attribute),
    );
    const animated = document.attributes.some((attribute) =>
      Api.DocumentAttributeAnimated.is(attribute),
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
      ...(media.spoiler ? { spoiler: true } : {}),
    };
  }
  function entityMap(users: readonly Tl.TypeUser[], chats: readonly Tl.TypeChat[]) {
    const entities = new Map<string, Tl.TypeUser | Tl.TypeChat>();
    for (const user of users) entities.set(`u:${user.id}`, user);
    for (const chat of chats) {
      const prefix = Api.Channel.is(chat) || Api.ChannelForbidden.is(chat) ? 'c' : 'g';
      entities.set(`${prefix}:${chat.id}`, chat);
    }
    return entities;
  }
  function mapDialog(
    item: Tl.Dialog,
    entities: Map<string, Tl.TypeUser | Tl.TypeChat>,
    messages: Map<string, TelegramMessage>,
  ): TelegramDialog | undefined {
    const peer = mapPeer(item.peer, entities);
    if (!peer) return undefined;
    const entity = entities.get(peer.id);
    const title = entityTitle(entity) || peer.id;
    const presence = Api.User.is(entity)
      ? mapUserPresence(entity.status)
      : { presence: 'offline' as const };
    return {
      peer,
      ...(peer.kind === 'channel' && item.pts !== undefined ? { channelPts: item.pts } : {}),
      title,
      initials: initials(title),
      color: peerColor(peer.id, entity),
      username: Api.User.is(entity) || Api.Channel.is(entity) ? entity.username : undefined,
      bot: Api.User.is(entity) && Boolean(entity.bot),
      archived: item.folderId === 1,
      topMessageId: item.topMessage,
      topMessage: messages.get(`${peer.id}:${item.topMessage}`),
      unreadCount: item.unreadCount,
      readInboxMaxId: item.readInboxMaxId,
      readOutboxMaxId: item.readOutboxMaxId,
      muted: isMuted(item.notifySettings, peer, entity),
      pinned: Boolean(item.pinned),
      hasAvatar: Api.User.is(entity)
        ? Api.UserProfilePhoto.is(entity.photo)
        : Api.Chat.is(entity) || Api.Channel.is(entity)
          ? Api.ChatPhoto.is(entity.photo)
          : false,
      avatarId:
        Api.User.is(entity) && Api.UserProfilePhoto.is(entity.photo)
          ? entity.photo.photoId.toString()
          : (Api.Chat.is(entity) || Api.Channel.is(entity)) && Api.ChatPhoto.is(entity.photo)
            ? entity.photo.photoId.toString()
            : undefined,
      ...presence,
    };
  }
  function mapUserPresence(status: Tl.TypeUserStatus | undefined): {
    presence: 'online' | 'recently' | 'offline';
    lastSeenAt?: number | undefined;
  } {
    if (Api.UserStatusOnline.is(status) && status.expires > Date.now() / 1000) {
      return { presence: 'online' };
    }
    if (Api.UserStatusOffline.is(status)) {
      return { presence: 'offline', lastSeenAt: status.wasOnline };
    }
    if (Api.UserStatusRecently.is(status)) return { presence: 'recently' };
    return { presence: 'offline' };
  }
  function mapPeer(
    peer: Tl.TypePeer,
    entities: Map<string, Tl.TypeUser | Tl.TypeChat>,
  ): TelegramPeer | undefined {
    const id = toPeerId(peer);
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
  function toPeerId(peer: Tl.TypePeer | undefined) {
    if (Api.PeerUser.is(peer)) return `u:${peer.userId}`;
    if (Api.PeerChat.is(peer)) return `g:${peer.chatId}`;
    if (Api.PeerChannel.is(peer)) return `c:${peer.channelId}`;
    return undefined;
  }
  function toInputPeer(peer: TelegramPeer): Tl.TypeInputPeer {
    const id = BigInt(peer.id.slice(2));
    const entity = state.entities.get(peer.id);
    const accessHash =
      peer.accessHash ??
      (entity && 'accessHash' in entity && entity.accessHash !== undefined
        ? entity.accessHash.toString()
        : '0');
    if (peer.kind === 'user') {
      return Api.InputPeerUser({ userId: id, accessHash: BigInt(accessHash) });
    }
    if (peer.kind === 'channel') {
      return Api.InputPeerChannel({ channelId: id, accessHash: BigInt(accessHash) });
    }
    return Api.InputPeerChat({ chatId: id });
  }
  function inputChannel(peer: TelegramPeer) {
    if (peer.kind !== 'channel') throw new Error('Expected a channel peer.');
    const entity = state.entities.get(peer.id);
    const accessHash =
      peer.accessHash ??
      (entity && 'accessHash' in entity && entity.accessHash !== undefined
        ? entity.accessHash.toString()
        : '0');
    return Api.InputChannel({
      channelId: BigInt(peer.id.slice(2)),
      accessHash: BigInt(accessHash),
    });
  }
  function inputUser(peer: TelegramPeer) {
    if (peer.kind !== 'user') throw new Error('Expected a user peer.');
    const input = toInputPeer(peer);
    if (!Api.InputPeerUser.is(input)) throw new Error('Expected a user peer.');
    return Api.InputUser({ userId: input.userId, accessHash: input.accessHash });
  }
  function entityTitle(entity: Tl.TypeUser | Tl.TypeChat | undefined) {
    if (Api.User.is(entity)) {
      return [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || '';
    }
    if (entity && 'title' in entity) return entity.title;
    return '';
  }
  function messagesFromUpdates(updates: Tl.TypeUpdates) {
    if (Api.Updates.is(updates) || Api.UpdatesCombined.is(updates)) {
      rememberEntities(updates.users, updates.chats);
      return updates.updates.flatMap((update) =>
        Api.UpdateNewMessage.is(update) || Api.UpdateNewChannelMessage.is(update)
          ? [update.message]
          : [],
      );
    }
    return [];
  }
  function mapShortSentMessage(
    peer: TelegramPeer,
    text: string,
    randomId: string,
    result: Tl.UpdateShortSentMessage,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ): SendTextResult {
    const peerId =
      peer.kind === 'user'
        ? Api.PeerUser({ userId: BigInt(peer.id.slice(2)) })
        : peer.kind === 'channel'
          ? Api.PeerChannel({ channelId: BigInt(peer.id.slice(2)) })
          : Api.PeerChat({ chatId: BigInt(peer.id.slice(2)) });
    const message = mapMessage(
      Api.Message({
        id: result.id,
        out: true,
        peerId,
        date: result.date,
        message: text,
        ...(result.media ? { media: result.media } : {}),
        ...(result.entities
          ? { entities: result.entities }
          : formats?.length
            ? { entities: inputEntities(formats) }
            : {}),
        ...(reply
          ? {
              replyTo: Api.MessageReplyHeader({
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
      updateBatches: shortSentUpdateBatches(result, sentMessage),
    };
  }
  async function mapOutgoingSendResult(
    result: Tl.TypeUpdates,
    peer: TelegramPeer,
    randomId: string,
    failureMessage: string,
  ): Promise<SendTextResult> {
    let message = Api.UpdateShortSentMessage.is(result)
      ? undefined
      : messagesFromUpdates(result)
          .map((candidate) => mapMessage(candidate))
          .find(
            (candidate): candidate is TelegramMessage =>
              candidate?.peerId === peer.id && candidate.outgoing,
          );
    const returnedMessageId = Api.UpdateShortSentMessage.is(result)
      ? result.id
      : Api.Updates.is(result) || Api.UpdatesCombined.is(result)
        ? result.updates.find(
            (update): update is Tl.UpdateMessageID =>
              Api.UpdateMessageID.is(update) && sameTelegramLong(update.randomId, randomId),
          )?.id
        : undefined;
    if (!message && returnedMessageId !== undefined) {
      message = await getMessageById(peer, returnedMessageId);
    }
    if (!message) throw new Error(failureMessage);
    const sentMessage = { ...message, randomId };
    return {
      message: sentMessage,
      updateBatches: Api.UpdateShortSentMessage.is(result)
        ? shortSentUpdateBatches(result, sentMessage)
        : toUpdateBatches(result, [sentMessage]),
    };
  }
  async function getMessageById(peer: TelegramPeer, messageId: number) {
    const id = [Api.InputMessageID({ id: messageId })];
    const result =
      peer.kind === 'channel'
        ? await getClient().invoke(Api.channels.GetMessages({ channel: inputChannel(peer), id }))
        : await getClient().invoke(Api.messages.GetMessages({ id }));
    if (Api.messages.MessagesNotModified.is(result)) return undefined;
    rememberEntities(result.users, result.chats);
    return result.messages
      .map((candidate) => mapMessage(candidate))
      .find(
        (candidate): candidate is TelegramMessage =>
          candidate?.id === messageId && candidate.peerId === peer.id,
      );
  }
  function shortSentUpdateBatches(
    result: Tl.UpdateShortSentMessage,
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
  function randomIdsByMessageId(updates: readonly Tl.TypeUpdate[]) {
    return new Map(
      updates.flatMap((update) =>
        Api.UpdateMessageID.is(update) ? [[update.id, update.randomId.toString()] as const] : [],
      ),
    );
  }
  function toUpdateBatches(
    updates: Tl.TypeUpdates,
    sentMessages: TelegramMessage[] = [],
  ): TransportUpdateBatch[] {
    const batch = mapUpdateEnvelope(updates);
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
  function mapSearchPage(
    result: Tl.messages.Messages | Tl.messages.MessagesSlice | Tl.messages.ChannelMessages,
    limit: number,
    global: boolean,
  ): TelegramSearchPage {
    const rawMessages = result.messages.slice(0, limit);
    const messages = rawMessages
      .map((message) => mapMessage(message))
      .filter((message): message is TelegramMessage => Boolean(message));
    const hasContinuation = global
      ? Api.messages.MessagesSlice.is(result) && result.nextRate !== undefined
      : result.messages.length > limit;
    if (!hasContinuation) return { messages, hasMore: false };

    let last: Tl.Message | undefined;
    for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
      const candidate = rawMessages[index];
      if (Api.Message.is(candidate)) {
        last = candidate;
        break;
      }
    }
    if (!last) return { messages, hasMore: false };
    const nextPeer = global ? mapPeer(last.peerId, state.entities) : undefined;
    if (global && !nextPeer) return { messages, hasMore: false };
    const nextOffset: TelegramSearchOffset = {
      messageId: last.id,
      ...(nextPeer ? { peer: nextPeer } : {}),
      ...(global
        ? { rate: Api.messages.MessagesSlice.is(result) ? (result.nextRate ?? 0) : 0 }
        : {}),
    };
    return { messages, hasMore: true, nextOffset };
  }
  function rememberEntities(users: readonly Tl.TypeUser[], chats: readonly Tl.TypeChat[]) {
    for (const user of users) {
      rememberBounded(state.entities, `u:${user.id}`, user, MAX_ENTITY_ENTRIES);
    }
    for (const chat of chats) {
      const prefix = Api.Channel.is(chat) || Api.ChannelForbidden.is(chat) ? 'c' : 'g';
      rememberBounded(state.entities, `${prefix}:${chat.id}`, chat, MAX_ENTITY_ENTRIES);
    }
  }
  async function fetchEntity(peer: TelegramPeer): Promise<Tl.TypeUser | Tl.TypeChat | undefined> {
    if (peer.kind === 'user') {
      const users = await getClient().invoke(Api.users.GetUsers({ id: [inputUser(peer)] }));
      rememberEntities(users, []);
      return users.find((user) => `u:${user.id}` === peer.id);
    }
    const result =
      peer.kind === 'channel'
        ? await getClient().invoke(Api.channels.GetChannels({ id: [inputChannel(peer)] }))
        : await getClient().invoke(Api.messages.GetChats({ id: [BigInt(peer.id.slice(2))] }));
    rememberEntities([], result.chats);
    return result.chats.find((chat) => {
      const prefix = Api.Channel.is(chat) || Api.ChannelForbidden.is(chat) ? 'c' : 'g';
      return `${prefix}:${chat.id}` === peer.id;
    });
  }
  function hasDownloadableAvatar(entity: Tl.TypeUser | Tl.TypeChat | undefined) {
    if (Api.User.is(entity)) return Api.UserProfilePhoto.is(entity.photo);
    if (Api.Chat.is(entity) || Api.Channel.is(entity)) {
      return Api.ChatPhoto.is(entity.photo);
    }
    return false;
  }
  function rememberBounded<Key, Value>(
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
  function forgetMessageMedia(peerId: string, messageId: number) {
    const key = `${peerId}:${messageId}`;
    state.messageMedia.delete(key);
    state.linkPreviewPhotos.delete(key);
  }
  function clearRuntimeCaches() {
    clearConnectionLossTimer();
    state.eventUnsubscribe?.();
    state.eventUnsubscribe = undefined;
    state.messageMedia.clear();
    state.linkPreviewPhotos.clear();
    state.stickerDocuments.clear();
    state.wallpaperDocuments.clear();
    state.entities.clear();
    state.channelSenderRoles.clear();
    state.channelRolesLoaded.clear();
    state.channelRolesLoading.clear();
    state.notifyDefaults.clear();
    state.notifyDefaultsLoading = undefined;
    state.notifyDefaultsLoaded = false;
    state.eventHandlerClient = undefined;
    state.phoneNumber = '';
    state.phoneCodeHash = '';
  }
  async function flushSessionSave(client = state.client) {
    if (client) {
      await client.flushSession();
      state.sessionSaveError = undefined;
    }
    if (!state.sessionSaveError) return;
    const detail =
      state.sessionSaveError instanceof Error
        ? state.sessionSaveError.message
        : typeof state.sessionSaveError === 'string'
          ? state.sessionSaveError
          : 'Unknown storage error.';
    throw new Error(`Could not persist the Telegram authorization session. ${detail}`);
  }
  async function waitForOptionalEnrichment(operation: Promise<unknown>) {
    const guarded = operation.then(
      () => undefined,
      () => undefined,
    );
    if (optionalEnrichmentDeadlineMs === 0) {
      void guarded;
      return;
    }
    let deadline: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      await Promise.race([
        guarded,
        new Promise<void>((resolve) => {
          deadline = globalThis.setTimeout(resolve, optionalEnrichmentDeadlineMs);
        }),
      ]);
    } finally {
      if (deadline !== undefined) globalThis.clearTimeout(deadline);
    }
  }
  async function ensureNotifyDefaults() {
    if (state.notifyDefaultsLoaded) return;
    if (state.notifyDefaultsLoading) return state.notifyDefaultsLoading;
    const generation = state.connectionGeneration;
    const client = getClient();
    const loading = (async () => {
      const requests = [
        ['users', Api.InputNotifyUsers()],
        ['groups', Api.InputNotifyChats()],
        ['channels', Api.InputNotifyBroadcasts()],
      ] as const;
      const results = await Promise.allSettled(
        requests.map(([, peer]) => client.invoke(Api.account.GetNotifySettings({ peer }))),
      );
      if (generation !== state.connectionGeneration || state.client !== client) return;
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && Api.PeerNotifySettings.is(result.value)) {
          state.notifyDefaults.set(requests[index]![0], result.value);
        }
      });
      state.notifyDefaultsLoaded = true;
    })();
    state.notifyDefaultsLoading = loading;
    try {
      await loading;
    } finally {
      if (state.notifyDefaultsLoading === loading) state.notifyDefaultsLoading = undefined;
    }
  }
  function isMuted(
    settings: Tl.TypePeerNotifySettings | undefined,
    peer?: TelegramPeer,
    entity?: Tl.TypeUser | Tl.TypeChat,
  ) {
    const kind =
      Api.User.is(entity) || peer?.kind === 'user'
        ? 'users'
        : Api.Channel.is(entity) && entity.broadcast
          ? 'channels'
          : 'groups';
    const defaultSettings = state.notifyDefaults.get(kind);
    const muteUntil = Number(
      settings && 'muteUntil' in settings && settings.muteUntil !== undefined
        ? settings.muteUntil
        : defaultSettings && 'muteUntil' in defaultSettings
          ? defaultSettings.muteUntil
          : 0,
    );
    return muteUntil < 0 || muteUntil > Date.now() / 1000;
  }
  function initials(title: string) {
    return title
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase())
      .join('');
  }
  function senderAvatar(senderId: string, sender: Tl.TypeUser | Tl.TypeChat | undefined) {
    if (!sender) return { senderColor: peerColor(senderId) };
    const photo = Api.User.is(sender)
      ? Api.UserProfilePhoto.is(sender.photo)
        ? sender.photo
        : undefined
      : Api.Chat.is(sender) || Api.Channel.is(sender)
        ? Api.ChatPhoto.is(sender.photo)
          ? sender.photo
          : undefined
        : undefined;
    return {
      senderHasAvatar: Boolean(photo),
      senderAvatarId: photo?.photoId.toString(),
      senderColor: peerColor(senderId, sender),
      senderColorVersion: 2,
    };
  }
  function mapGroupMember(user: Tl.User, role: { role?: string; roleKind?: 'owner' | 'admin' }) {
    const peer = mapPeer(Api.PeerUser({ userId: user.id }), state.entities)!;
    const title = entityTitle(user) || peer.id;
    const photo = Api.UserProfilePhoto.is(user.photo) ? user.photo : undefined;
    return {
      peer,
      title,
      initials: initials(title),
      color: peerColor(peer.id, user),
      username: user.username,
      ...role,
      hasAvatar: Boolean(photo),
      avatarId: photo?.photoId.toString(),
      ...mapUserPresence(user.status),
    };
  }
  function senderRole(peerId: string, senderId: string, postAuthor?: string) {
    const role = state.channelSenderRoles.get(`${peerId}:${senderId}`);
    const label = postAuthor?.trim() || role?.label;
    if (!label) return {};
    const ownerLabel = /^(owner|creator|владелец)$/iu.test(label);
    return {
      senderRole: label,
      senderRoleKind: role?.kind ?? (ownerLabel ? 'owner' : 'admin'),
    };
  }
  async function ensureChannelSenderRoles(peer: TelegramPeer, senderIds: readonly string[]) {
    if (peer.kind !== 'channel' || state.channelRolesLoaded.has(peer.id)) return;
    const current = state.channelRolesLoading.get(peer.id);
    if (current) return current;
    const generation = state.connectionGeneration;
    const client = getClient();
    const loading = (async () => {
      try {
        const result = await client.invoke(
          Api.channels.GetParticipants({
            channel: inputChannel(peer),
            filter: Api.ChannelParticipantsAdmins(),
            offset: 0,
            limit: 200,
            hash: 0n,
          }),
        );
        if (generation !== state.connectionGeneration || state.client !== client) return;
        if (Api.channels.ChannelParticipants.is(result)) {
          rememberEntities(result.users, result.chats);
          for (const participant of result.participants) {
            if (Api.ChannelParticipantCreator.is(participant)) {
              state.channelSenderRoles.set(`${peer.id}:u:${participant.userId}`, {
                label: participant.rank?.trim() || 'owner',
                kind: 'owner',
              });
            } else if (Api.ChannelParticipantAdmin.is(participant)) {
              state.channelSenderRoles.set(`${peer.id}:u:${participant.userId}`, {
                label: participant.rank?.trim() || 'admin',
                kind: 'admin',
              });
            }
          }
        } else {
          await fetchVisibleChannelSenderRoles(peer, senderIds, client, generation);
        }
      } catch {
        if (generation !== state.connectionGeneration || state.client !== client) return;
        await fetchVisibleChannelSenderRoles(peer, senderIds, client, generation);
      }
      if (generation === state.connectionGeneration && state.client === client) {
        state.channelRolesLoaded.add(peer.id);
      }
    })();
    state.channelRolesLoading.set(peer.id, loading);
    try {
      await loading;
    } finally {
      if (state.channelRolesLoading.get(peer.id) === loading) {
        state.channelRolesLoading.delete(peer.id);
      }
    }
  }
  async function fetchVisibleChannelSenderRoles(
    peer: TelegramPeer,
    senderIds: readonly string[],
    client = getClient(),
    generation = state.connectionGeneration,
  ) {
    const userIds = [...new Set(senderIds.filter((senderId) => senderId.startsWith('u:')))].slice(
      0,
      20,
    );
    const results = await Promise.allSettled(
      userIds.map((senderId) =>
        client.invoke(
          Api.channels.GetParticipant({
            channel: inputChannel(peer),
            participant: toInputPeer({ id: senderId, kind: 'user' }),
          }),
        ),
      ),
    );
    if (generation !== state.connectionGeneration || state.client !== client) return;
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled' || !Api.channels.ChannelParticipant.is(result.value)) {
        return;
      }
      rememberEntities(result.value.users, result.value.chats);
      const participant = result.value.participant;
      if (Api.ChannelParticipantCreator.is(participant)) {
        state.channelSenderRoles.set(`${peer.id}:${userIds[index]}`, {
          label: participant.rank?.trim() || 'owner',
          kind: 'owner',
        });
      } else if (Api.ChannelParticipantAdmin.is(participant)) {
        state.channelSenderRoles.set(`${peer.id}:${userIds[index]}`, {
          label: participant.rank?.trim() || 'admin',
          kind: 'admin',
        });
      }
    });
  }
  function peerColor(peerId: string, entity?: Tl.TypeUser | Tl.TypeChat) {
    const color = entity && 'color' in entity ? entity.color : undefined;
    if (Api.PeerColorCollectible.is(color)) {
      const value = color.darkAccentColor ?? color.accentColor;
      return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
    }
    return telegramPeerColor(peerId, Api.PeerColor.is(color) ? color.color : undefined);
  }
  function getClient() {
    if (!state.client) throw new Error('Telegram transport is not connected.');
    return state.client;
  }
  const transport = {
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
    searchPeers,
    getDialog,
    getHistory,
    getHistoryAround,
    readHistory,
    getReadOutboxMaxId,
    getSharedMediaCounts,
    getSharedMedia,
    searchMessages,
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
    subscribe,
  };
  if (!exposeTestInternals) return transport satisfies TelegramTransport;
  Object.assign(transport, {
    connectClient,
    sharedMediaFilters,
    getChatThemes,
    mapThemes,
    mapThemeSettings,
    mapBaseTheme,
    mapWallpaperSettings,
    mapWallpaper,
    telegramColor,
    installEventHandler,
    scheduleConnectionLoss,
    clearConnectionLossTimer,
    mapUpdateEnvelope,
    mapUpdate,
    mapCursor,
    mapActivity,
    activityUpdate,
    mapMessage,
    mapForwardedFrom,
    mapServiceAction,
    serviceUser,
    servicePeerName,
    serviceNameList,
    serviceDuration,
    mapReactions,
    mapBotCommands,
    mapBotKeyboard,
    mapBotButton,
    mapUrlAuthResult,
    mapMentions,
    mapLinks,
    mapLinkPreview,
    mapFormats,
    mapRichMessage,
    richTextValue,
    mapRichText,
    mapRichCaption,
    mapRichBlock,
    inputDocument,
    inputEntities,
    uploadAlbumMedia,
    uploadInputMedia,
    readVideoMetadata,
    mapStickerDocument,
    mapGifDocument,
    inputReply,
    mapMedia,
    entityMap,
    mapDialog,
    mapUserPresence,
    mapPeer,
    peerId: toPeerId,
    inputPeer: toInputPeer,
    inputChannel,
    inputUser,
    entityTitle,
    messagesFromUpdates,
    mapShortSentMessage,
    mapOutgoingSendResult,
    getMessageById,
    shortSentUpdateBatches,
    randomIdsByMessageId,
    updateBatches: toUpdateBatches,
    mapSearchPage,
    rememberEntities,
    fetchEntity,
    hasDownloadableAvatar,
    rememberBounded,
    forgetMessageMedia,
    clearRuntimeCaches,
    flushSessionSave,
    ensureNotifyDefaults,
    isMuted,
    initials,
    senderAvatar,
    mapGroupMember,
    senderRole,
    ensureChannelSenderRoles,
    fetchVisibleChannelSenderRoles,
    peerColor,
    getClient,
  });
  Object.defineProperties(transport, {
    client: {
      get() {
        return state.client;
      },
      set(value) {
        state.client = value;
      },
      configurable: true,
    },
    connectionGeneration: {
      get() {
        return state.connectionGeneration;
      },
      set(value) {
        state.connectionGeneration = value;
      },
      configurable: true,
    },
    connecting: {
      get() {
        return state.connecting;
      },
      set(value) {
        state.connecting = value;
      },
      configurable: true,
    },
    phoneNumber: {
      get() {
        return state.phoneNumber;
      },
      set(value) {
        state.phoneNumber = value;
      },
      configurable: true,
    },
    phoneCodeHash: {
      get() {
        return state.phoneCodeHash;
      },
      set(value) {
        state.phoneCodeHash = value;
      },
      configurable: true,
    },
    listeners: {
      get() {
        return state.listeners;
      },
      set(value) {
        state.listeners = value;
      },
      configurable: true,
    },
    messageMedia: {
      get() {
        return state.messageMedia;
      },
      set(value) {
        state.messageMedia = value;
      },
      configurable: true,
    },
    linkPreviewPhotos: {
      get() {
        return state.linkPreviewPhotos;
      },
      set(value) {
        state.linkPreviewPhotos = value;
      },
      configurable: true,
    },
    stickerDocuments: {
      get() {
        return state.stickerDocuments;
      },
      set(value) {
        state.stickerDocuments = value;
      },
      configurable: true,
    },
    wallpaperDocuments: {
      get() {
        return state.wallpaperDocuments;
      },
      set(value) {
        state.wallpaperDocuments = value;
      },
      configurable: true,
    },
    entities: {
      get() {
        return state.entities;
      },
      set(value) {
        state.entities = value;
      },
      configurable: true,
    },
    channelSenderRoles: {
      get() {
        return state.channelSenderRoles;
      },
      set(value) {
        state.channelSenderRoles = value;
      },
      configurable: true,
    },
    channelRolesLoaded: {
      get() {
        return state.channelRolesLoaded;
      },
      set(value) {
        state.channelRolesLoaded = value;
      },
      configurable: true,
    },
    channelRolesLoading: {
      get() {
        return state.channelRolesLoading;
      },
      set(value) {
        state.channelRolesLoading = value;
      },
      configurable: true,
    },
    notifyDefaults: {
      get() {
        return state.notifyDefaults;
      },
      set(value) {
        state.notifyDefaults = value;
      },
      configurable: true,
    },
    notifyDefaultsLoading: {
      get() {
        return state.notifyDefaultsLoading;
      },
      set(value) {
        state.notifyDefaultsLoading = value;
      },
      configurable: true,
    },
    notifyDefaultsLoaded: {
      get() {
        return state.notifyDefaultsLoaded;
      },
      set(value) {
        state.notifyDefaultsLoaded = value;
      },
      configurable: true,
    },
    sessionSaveError: {
      get() {
        return state.sessionSaveError;
      },
      set(value) {
        state.sessionSaveError = value;
      },
      configurable: true,
    },
    eventHandlerClient: {
      get() {
        return state.eventHandlerClient;
      },
      set(value) {
        state.eventHandlerClient = value;
      },
      configurable: true,
    },
    eventUnsubscribe: {
      get() {
        return state.eventUnsubscribe;
      },
      set(value) {
        state.eventUnsubscribe = value;
      },
      configurable: true,
    },
    connectionLossTimer: {
      get() {
        return state.connectionLossTimer;
      },
      set(value) {
        state.connectionLossTimer = value;
      },
      configurable: true,
    },
  });
  return transport satisfies TelegramTransport;
}
