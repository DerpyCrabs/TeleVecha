import { Crypto, Effect, Result, FiberMap, PubSub, ScopedRef, Semaphore, Stream } from 'effect';
import * as Socket from 'effect/unstable/socket/Socket';
import { telegramPeerColor } from '../../domain/peerColor';
import { gunzipSync } from 'fflate';
import type { RichBlock, RichCaption, RichText } from '../../domain/richMessage';
import { reportDiagnostic } from '../core/diagnostics';
import type { TransportSessionStorage } from '../persistence/store';
import type {
  ChannelDifferenceResult,
  DifferenceResult,
  EditMediaOptions,
  OutgoingAttachmentMode,
  SendAlbumAttachment,
  SendAlbumOptions,
  SendFileOptions,
  SharedMediaKind,
  SyncCursor,
  TelegramBotButton,
  TelegramBotCommand,
  TelegramBotKeyboard,
  TelegramCredentials,
  TelegramActivityKind,
  TelegramChatPermissions,
  TelegramDeleteDialogAction,
  TelegramDialog,
  TelegramDownloadOptions,
  TelegramGroupMemberPage,
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
  TelegramThemeSettings,
  TelegramTextFormat,
  TelegramTransport,
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
import { createMtprotoError, isMtprotoError, type MtprotoError } from '../mtproto/errors';
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
  readVideoMetadata?: (
    file: File,
  ) => Effect.Effect<{ duration: number; width: number; height: number }, MtprotoError>;
  optionalEnrichmentDeadlineMs?: number;
  createClient?: typeof createMtprotoClient;
}>;

export type WebTelegramTransport = TelegramTransport;

export const createWebTelegramTransport = Effect.fn('telegram.webTransport.make')(function* (
  store: TransportSessionStorage,
  dependencies: WebTelegramTransportDependencies = {},
) {
  const crypto = yield* Crypto.Crypto;
  const webSocket = yield* Socket.WebSocketConstructor;
  const provideRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(Socket.WebSocketConstructor, webSocket),
    );
  const optionalEnrichmentDeadlineMs =
    dependencies.optionalEnrichmentDeadlineMs ?? OPTIONAL_ENRICHMENT_DEADLINE_MS;
  if (!Number.isFinite(optionalEnrichmentDeadlineMs) || optionalEnrichmentDeadlineMs < 0) {
    return yield* Effect.fail(
      createMtprotoError(
        'configuration',
        'Optional Telegram enrichment deadline must be non-negative.',
      ),
    );
  }
  const clients = yield* ScopedRef.make<MtprotoClient | undefined>(() => undefined);
  const connectionLock = yield* Semaphore.make(1);
  const clientTasks = yield* FiberMap.make<string, void, never>();
  const updateHub = yield* PubSub.bounded<TransportUpdateBatch>(256);
  const state = {
    credentials: undefined as TelegramCredentials | undefined,
    phoneNumber: '',
    phoneCodeHash: '',
    messageMedia: new Map<string, Tl.TypeMessageMedia>(),
    linkPreviewPhotos: new Map<string, Tl.Photo>(),
    stickerDocuments: new Map<string, Tl.Document>(),
    wallpaperDocuments: new Map<string, Tl.Document>(),
    entities: new Map<string, Tl.TypeUser | Tl.TypeChat>(),
    channelSenderRoles: new Map<string, { label: string; kind: 'owner' | 'admin' }>(),
    channelRolesLoaded: new Set<string>(),
    notifyDefaults: new Map<'users' | 'groups' | 'channels', Tl.TypePeerNotifySettings>(),
    notifyDefaultsLoaded: false,
  };
  const getClient = ScopedRef.get(clients).pipe(
    Effect.flatMap((client) =>
      client === undefined
        ? Effect.fail(createMtprotoError('transport', 'Telegram transport is not connected.'))
        : Effect.succeed(client),
    ),
  );
  const storageError = (cause: unknown) =>
    createMtprotoError('session', 'Could not persist the Telegram authorization session.', {
      cause,
    });
  const handleClientEvent = (event: import('../mtproto/events').MtprotoClientEvent) => {
    const raw: unknown = updateEvent.is(event) ? event.update : event;
    if (connectionStateEvent.is(raw)) {
      if (raw.state === 'connected') {
        return Effect.gen(function* () {
          const reconnected = yield* FiberMap.has(clientTasks, 'connection-loss');
          yield* FiberMap.remove(clientTasks, 'connection-loss');
          if (reconnected) {
            yield* PubSub.publish(updateHub, { updates: [{ type: 'too-long' }] });
          }
        });
      }
      return FiberMap.run(
        clientTasks,
        'connection-loss',
        Effect.sleep(CONNECTION_LOSS_GRACE_MS).pipe(
          Effect.andThen(
            PubSub.publish(updateHub, {
              updates: [{ type: 'connection-state', connected: false }],
            }),
          ),
        ),
      ).pipe(Effect.asVoid);
    }
    const batch = mapUpdateEnvelope(raw);
    if (
      batch.updates.length === 0 &&
      batch.date === undefined &&
      batch.seq === undefined &&
      batch.seqStart === undefined
    ) {
      return Effect.void;
    }
    return PubSub.publish(updateHub, batch).pipe(Effect.asVoid);
  };
  const connect = (credentials: TelegramCredentials) =>
    Semaphore.withPermit(connectionLock)(
      Effect.gen(function* () {
        const current = yield* ScopedRef.get(clients);
        if (
          current &&
          state.credentials?.apiId === credentials.apiId &&
          state.credentials.apiHash === credentials.apiHash
        )
          return;
        yield* ScopedRef.set(
          clients,
          Effect.gen(function* () {
            const client = yield* provideRuntime(
              (dependencies.createClient ?? createMtprotoClient)({
                apiId: credentials.apiId,
                apiHash: credentials.apiHash,
                session: {
                  load: store.loadTransportSession.pipe(Effect.mapError(storageError)),
                  save: (value) =>
                    store.saveTransportSession(value).pipe(Effect.mapError(storageError)),
                  clear: store.saveTransportSession(undefined).pipe(Effect.mapError(storageError)),
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
              }),
            );
            yield* client.connect;
            yield* client.events.pipe(
              Stream.runForEach(handleClientEvent),
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* Effect.sync(() => {
              state.credentials = credentials;
            });
            return client;
          }),
        );
      }),
    );
  const disconnect = Effect.gen(function* () {
    yield* ScopedRef.set(clients, Effect.succeed(undefined));
    yield* FiberMap.clear(clientTasks);
    yield* Effect.sync(clearRuntimeCaches);
  });
  const logOut = getClient.pipe(
    Effect.flatMap((client) => client.invoke(Api.auth.LogOut())),
    Effect.andThen(disconnect),
  );
  const isAuthorized = Effect.fn('WebTelegramTransport.isAuthorized')(
    function* (): Effect.fn.Return<boolean, MtprotoError> {
      return yield* Effect.gen(function* () {
        yield* (yield* getClient).invoke(Api.updates.GetState());
        return true;
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (
              ['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED'].includes(
                telegramRpcErrorMessage(error) ?? '',
              )
            ) {
              return false;
            }
            return yield* Effect.fail(
              isMtprotoError(error)
                ? error
                : createMtprotoError('protocol', 'Telegram operation failed.', { cause: error }),
            );
          }),
        ),
      );
    },
  );
  const getAuthorizedAccountId = Effect.fn('WebTelegramTransport.getAuthorizedAccountId')(
    function* () {
      const self = yield* (yield* getClient).getMe;
      if (!Api.User.is(self)) {
        return yield* Effect.fail(
          createMtprotoError('protocol', 'Telegram did not return the authorized account.'),
        );
      }
      return self.id.toString();
    },
  );
  const requestCode = Effect.fn('WebTelegramTransport.requestCode')(function* (
    phoneNumber: string,
  ) {
    state.phoneNumber = phoneNumber.replace(/[^+\d]/g, '');
    const client = yield* getClient;
    const sent = yield* client.invoke(
      Api.auth.SendCode({
        phoneNumber: state.phoneNumber,
        apiId: client.apiId,
        apiHash: client.apiHash,
        settings: Api.CodeSettings(),
      }),
    );
    if (!Api.auth.SentCode.is(sent)) {
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram returned an unexpected login response.'),
      );
    }
    state.phoneCodeHash = sent.phoneCodeHash;
    return { isCodeViaApp: Api.auth.SentCodeTypeApp.is(sent.type) };
  });
  const submitCode = Effect.fn('WebTelegramTransport.submitCode')(function* (
    code: string,
  ): Effect.fn.Return<AuthResult, MtprotoError> {
    if (!state.phoneNumber || !state.phoneCodeHash) {
      return yield* Effect.fail(createMtprotoError('protocol', 'Request a login code first.'));
    }
    return yield* Effect.gen(function* () {
      const result = yield* (yield* getClient).invoke(
        Api.auth.SignIn({
          phoneNumber: state.phoneNumber,
          phoneCodeHash: state.phoneCodeHash,
          phoneCode: code.trim(),
        }),
      );
      if (Api.auth.AuthorizationSignUpRequired.is(result)) return 'sign-up-required' as const;
      return 'authorized' as const;
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (telegramRpcErrorMessage(error) === 'SESSION_PASSWORD_NEEDED') {
            return 'password-required' as const;
          }
          return yield* Effect.fail(
            isMtprotoError(error)
              ? error
              : createMtprotoError('protocol', 'Telegram operation failed.', { cause: error }),
          );
        }),
      ),
    );
  });
  const submitPassword = Effect.fn('WebTelegramTransport.submitPassword')(function* (
    password: string,
  ) {
    const client = yield* getClient;
    const passwordState = yield* client.invoke(Api.account.GetPassword());
    if (
      !Api.PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow.is(
        passwordState.currentAlgo,
      )
    ) {
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram returned an unsupported password algorithm.'),
      );
    }
    const proof = yield* provideRuntime(
      computePasswordSrpCheck(
        {
          currentAlgo: passwordState.currentAlgo,
          srpB: passwordState.srpB,
          srpId: passwordState.srpId,
        },
        password,
      ),
    );
    yield* client.invoke(
      Api.auth.CheckPassword({
        password: Api.InputCheckPasswordSRP({ srpId: proof.srpId, A: proof.A, M1: proof.M1 }),
      }),
    );
  });
  const getCurrentState = Effect.fn('WebTelegramTransport.getCurrentState')(function* () {
    return mapCursor(yield* (yield* getClient).invoke(Api.updates.GetState()));
  });
  const getDifference = Effect.fn('WebTelegramTransport.getDifference')(function* (
    cursor: SyncCursor,
    totalLimit: number,
  ): Effect.fn.Return<DifferenceResult, MtprotoError> {
    const updates: TransportUpdate[] = [];
    let current = cursor;

    for (;;) {
      const result = yield* (yield* getClient).invoke(
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
        return { type: 'too-long', cursor: yield* getCurrentState() };
      }
      if (Api.updates.DifferenceEmpty.is(result)) {
        return {
          type: 'complete',
          cursor: { ...current, date: result.date, seq: result.seq },
          updates,
        };
      }

      rememberEntities(result.users, result.chats);

      for (const update of result.otherUpdates) {
        if (Api.UpdateMessageID.is(update)) updates.push(...mapUpdate(update));
      }
      for (const message of result.newMessages) {
        const mapped = mapMessage(message);
        if (mapped) {
          updates.push({ type: 'new-message', pts: current.pts, ptsCount: 0, message: mapped });
        }
      }
      for (const update of result.otherUpdates) {
        if (!Api.UpdateMessageID.is(update)) updates.push(...mapUpdate(update));
      }

      if (updates.length > totalLimit) {
        return { type: 'too-long', cursor: yield* getCurrentState() };
      }

      if (Api.updates.DifferenceSlice.is(result)) {
        if (updates.length >= totalLimit) {
          return { type: 'too-long', cursor: yield* getCurrentState() };
        }
        current = mapCursor(result.intermediateState);
        continue;
      }
      return { type: 'complete', cursor: mapCursor(result.state), updates };
    }
  });
  const getChannelDifference = Effect.fn('WebTelegramTransport.getChannelDifference')(function* (
    peer: TelegramPeer,
    pts: number,
    totalLimit: number,
  ): Effect.fn.Return<ChannelDifferenceResult, MtprotoError> {
    if (peer.kind !== 'channel')
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Channel recovery requires a channel peer.'),
      );
    const updates: TransportUpdate[] = [];
    let currentPts = pts;

    for (let page = 0; page < 100; page += 1) {
      const remaining = totalLimit - updates.length;
      if (remaining <= 0) return { type: 'too-long', pts: currentPts };
      const result = yield* (yield* getClient).invoke(
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
      for (const update of result.otherUpdates) {
        if (Api.UpdateMessageID.is(update)) updates.push(...mapUpdate(update));
      }
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
      for (const update of result.otherUpdates) {
        if (!Api.UpdateMessageID.is(update)) updates.push(...mapUpdate(update));
      }
      if (updates.length > totalLimit) return { type: 'too-long', pts: result.pts };
      if (result.final || result.pts === currentPts) {
        return { type: 'complete', pts: result.pts, updates };
      }
      currentPts = result.pts;
    }

    return { type: 'too-long', pts: currentPts };
  });
  const getDialogs = Effect.fn('WebTelegramTransport.getDialogs')(function* (limit: number) {
    const pageSize = Math.max(0, Math.min(100, limit));
    if (pageSize === 0) return { dialogs: [] };
    const dialogs = new Map<string, TelegramDialog>();
    const notifySettingsByPeer = new Map<string, Tl.TypePeerNotifySettings>();
    for (const folderId of [0, 1]) {
      let offsetDate = 0;
      let offsetId = 0;
      let offsetPeer: Tl.TypeInputPeer = Api.InputPeerEmpty();
      const seenOffsets = new Set<string>();

      while (true) {
        const result = yield* (yield* getClient).invoke(
          Api.messages.GetDialogs({
            excludePinned: true,
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
        if (!Api.messages.DialogsSlice.is(result) || result.dialogs.length < pageSize) break;

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

      const pinned = yield* (yield* getClient).invoke(Api.messages.GetPinnedDialogs({ folderId }));
      if (Api.messages.PeerDialogs.is(pinned)) {
        rememberEntities(pinned.users, pinned.chats);
        const messages = new Map<string, TelegramMessage>();
        for (const message of pinned.messages) {
          const mapped = mapMessage(message);
          if (mapped) messages.set(`${mapped.peerId}:${mapped.id}`, mapped);
        }
        const entities = entityMap(pinned.users, pinned.chats);
        for (const [pinnedOrder, item] of pinned.dialogs.entries()) {
          if (!Api.Dialog.is(item)) continue;
          const dialog = mapDialog(item, entities, messages);
          if (!dialog) continue;
          const normalized: TelegramDialog = {
            ...dialog,
            archived: folderId === 1,
            pinned: true,
            pinnedOrder,
          };
          dialogs.set(normalized.peer.id, normalized);
          notifySettingsByPeer.set(normalized.peer.id, item.notifySettings);
        }
      }
    }
    yield* waitForOptionalEnrichment(ensureNotifyDefaults());
    return {
      dialogs: [...dialogs.values()].map((dialog) => ({
        ...dialog,
        muted: isMuted(
          notifySettingsByPeer.get(dialog.peer.id),
          dialog.peer,
          state.entities.get(dialog.peer.id),
        ),
      })),
    };
  });
  const searchPeers = Effect.fn('WebTelegramTransport.searchPeers')(function* (
    query: string,
    limit: number = 50,
  ) {
    const term = query.trim();
    if (!term || limit <= 0) return [];
    const result = yield* (yield* getClient).invoke(
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
        permissions: mapDialogPermissions(peer, entity),
      });
      if (found.length >= limit) break;
    }
    return found;
  });
  const getDialog = Effect.fn('WebTelegramTransport.getDialog')(function* (peer: TelegramPeer) {
    const result = yield* (yield* getClient).invoke(
      Api.messages.GetPeerDialogs({ peers: [Api.InputDialogPeer({ peer: toInputPeer(peer) })] }),
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
    yield* waitForOptionalEnrichment(ensureNotifyDefaults());
    return item ? mapDialog(item, entities, messages) : undefined;
  });
  const getHistory = Effect.fn('WebTelegramTransport.getHistory')(function* (
    peer: TelegramPeer,
    limit: number,
    beforeMessageId?: number,
  ) {
    const result = yield* (yield* getClient).invoke(
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
    yield* waitForOptionalEnrichment(
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
      ...(Api.messages.ChannelMessages.is(result) ? { channelPts: result.pts } : {}),
      hasOlder: rawMessages.length > limit,
      nextBeforeMessageId: ids.length > 0 ? Math.min(...ids) : beforeMessageId,
    };
  });
  const getHistoryAround = Effect.fn('WebTelegramTransport.getHistoryAround')(function* (
    peer: TelegramPeer,
    messageId: number,
    limit: number,
  ) {
    const result = yield* (yield* getClient).invoke(
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
    if (Api.messages.MessagesNotModified.is(result)) return { messages: [] };
    rememberEntities(result.users, result.chats);
    yield* waitForOptionalEnrichment(
      ensureChannelSenderRoles(
        peer,
        result.messages.flatMap((message) => {
          const senderId = 'fromId' in message ? toPeerId(message.fromId) : undefined;
          return senderId ? [senderId] : [];
        }),
      ),
    );
    return {
      messages: result.messages
        .map((candidate) => mapMessage(candidate))
        .filter((candidate): candidate is TelegramMessage => Boolean(candidate)),
      ...(Api.messages.ChannelMessages.is(result) ? { channelPts: result.pts } : {}),
    };
  });
  const readHistory = Effect.fn('WebTelegramTransport.readHistory')(function* (
    peer: TelegramPeer,
    maxMessageId: number,
  ): Effect.fn.Return<TransportMutationResult, MtprotoError> {
    if (peer.kind === 'channel') {
      yield* (yield* getClient).invoke(
        Api.channels.ReadHistory({ channel: inputChannel(peer), maxId: maxMessageId }),
      );
      return {};
    }
    const result = yield* (yield* getClient).invoke(
      Api.messages.ReadHistory({ peer: toInputPeer(peer), maxId: maxMessageId }),
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
  });
  const getReadOutboxMaxId = Effect.fn('WebTelegramTransport.getReadOutboxMaxId')(function* (
    peer: TelegramPeer,
  ) {
    const result = yield* (yield* getClient).invoke(
      Api.messages.GetPeerDialogs({ peers: [Api.InputDialogPeer({ peer: toInputPeer(peer) })] }),
    );
    const dialog = result.dialogs.find(
      (candidate): candidate is Tl.Dialog =>
        Api.Dialog.is(candidate) && toPeerId(candidate.peer) === peer.id,
    );
    return dialog?.readOutboxMaxId ?? 0;
  });
  const getSharedMediaCounts = Effect.fn('WebTelegramTransport.getSharedMediaCounts')(function* (
    peer: TelegramPeer,
  ) {
    const filters = sharedMediaFilters();
    const counters = yield* (yield* getClient).invoke(
      Api.messages.GetSearchCounters({ peer: toInputPeer(peer), filters: Object.values(filters) }),
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
  });
  const getSharedMedia = Effect.fn('WebTelegramTransport.getSharedMedia')(function* (
    peer: TelegramPeer,
    kind: SharedMediaKind,
    limit: number,
    offset?: TelegramSearchOffset,
  ) {
    const filters = sharedMediaFilters();
    const result = yield* (yield* getClient).invoke(
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
  });
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
  const searchMessages = Effect.fn('WebTelegramTransport.searchMessages')(function* (
    query: string,
    peer?: TelegramPeer,
    limit: number = 50,
    offset?: TelegramSearchOffset,
  ) {
    const result = peer
      ? yield* (yield* getClient).invoke(
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
      : yield* (yield* getClient).invoke(
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
  });
  const getPinnedMessages = Effect.fn('WebTelegramTransport.getPinnedMessages')(function* (
    peer: TelegramPeer,
  ) {
    const result = yield* (yield* getClient).invoke(
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
  });
  const setMuted = Effect.fn('WebTelegramTransport.setMuted')(function* (
    peer: TelegramPeer,
    muted: boolean,
  ) {
    yield* (yield* getClient).invoke(
      Api.account.UpdateNotifySettings({
        peer: Api.InputNotifyPeer({ peer: toInputPeer(peer) }),
        settings: Api.InputPeerNotifySettings({ muteUntil: muted ? 2_147_483_647 : 0 }),
      }),
    );
  });
  const getUserDetails = Effect.fn('WebTelegramTransport.getUserDetails')(function* (
    peer: TelegramPeer,
  ) {
    if (peer.kind !== 'user')
      return yield* Effect.fail(
        createMtprotoError('protocol', 'User details require a user peer.'),
      );
    const result = yield* (yield* getClient).invoke(Api.users.GetFullUser({ id: inputUser(peer) }));
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
  });
  const updateContact = Effect.fn('WebTelegramTransport.updateContact')(function* (
    peer: TelegramPeer,
    firstName: string,
    lastName: string,
    phone: string,
  ) {
    if (peer.kind !== 'user')
      return yield* Effect.fail(createMtprotoError('protocol', 'Only users can be contacts.'));
    yield* (yield* getClient).invoke(
      Api.contacts.AddContact({ id: inputUser(peer), firstName, lastName, phone }),
    );
  });
  const deleteContact = Effect.fn('WebTelegramTransport.deleteContact')(function* (
    peer: TelegramPeer,
  ) {
    if (peer.kind !== 'user')
      return yield* Effect.fail(createMtprotoError('protocol', 'Only users can be contacts.'));
    yield* (yield* getClient).invoke(Api.contacts.DeleteContacts({ id: [inputUser(peer)] }));
  });
  const getGroupMembers = Effect.fn('WebTelegramTransport.getGroupMembers')(function* (
    peer: TelegramPeer,
    limit: number = 50,
    offset: number = 0,
  ) {
    if (peer.kind === 'user') return { members: [], totalCount: 0, hasMore: false };
    if (peer.kind === 'channel') {
      const result = yield* (yield* getClient).invoke(
        Api.channels.GetParticipants({
          channel: inputChannel(peer),
          filter: Api.ChannelParticipantsRecent(),
          offset,
          limit,
          hash: 0n,
        }),
      );
      if (!Api.channels.ChannelParticipants.is(result)) {
        return { members: [], totalCount: 0, hasMore: false };
      }
      rememberEntities(result.users, result.chats);
      const users = new Map(result.users.map((user) => [user.id.toString(), user] as const));
      const members = result.participants.flatMap((participant) => {
        const user = 'userId' in participant ? users.get(participant.userId.toString()) : undefined;
        if (!Api.User.is(user)) return [];
        const role = Api.ChannelParticipantCreator.is(participant)
          ? { role: participant.rank?.trim() || 'owner', roleKind: 'owner' as const }
          : Api.ChannelParticipantAdmin.is(participant)
            ? { role: participant.rank?.trim() || 'admin', roleKind: 'admin' as const }
            : {};
        return [mapGroupMember(user, role)];
      });
      const nextOffset = offset + members.length;
      return {
        members,
        totalCount: result.count,
        hasMore: nextOffset < result.count,
        ...(nextOffset < result.count ? { nextOffset } : {}),
      } satisfies TelegramGroupMemberPage;
    }
    const result = yield* (yield* getClient).invoke(
      Api.messages.GetFullChat({ chatId: BigInt(peer.id.slice(2)) }),
    );
    rememberEntities(result.users, result.chats);
    const participants =
      Api.ChatFull.is(result.fullChat) && Api.ChatParticipants.is(result.fullChat.participants)
        ? result.fullChat.participants.participants
        : [];
    const users = new Map(result.users.map((user) => [user.id.toString(), user] as const));
    const allMembers = participants.flatMap((participant) => {
      const user = users.get(participant.userId.toString());
      if (!Api.User.is(user)) return [];
      const role = Api.ChatParticipantCreator.is(participant)
        ? { role: participant.rank?.trim() || 'owner', roleKind: 'owner' as const }
        : Api.ChatParticipantAdmin.is(participant)
          ? { role: participant.rank?.trim() || 'admin', roleKind: 'admin' as const }
          : {};
      return [mapGroupMember(user, role)];
    });
    const members = allMembers.slice(offset, offset + limit);
    const totalCount = allMembers.length;
    const nextOffset = offset + members.length;
    return {
      members,
      totalCount,
      hasMore: nextOffset < totalCount,
      ...(nextOffset < totalCount ? { nextOffset } : {}),
    } satisfies TelegramGroupMemberPage;
  });
  const setBlocked = Effect.fn('WebTelegramTransport.setBlocked')(function* (
    peer: TelegramPeer,
    blocked: boolean,
  ) {
    if (peer.kind !== 'user')
      return yield* Effect.fail(createMtprotoError('protocol', 'Only users can be blocked.'));
    const request = blocked
      ? Api.contacts.Block({ id: toInputPeer(peer) })
      : Api.contacts.Unblock({ id: toInputPeer(peer) });
    yield* (yield* getClient).invoke(request);
  });
  const setPinnedDialog = Effect.fn('WebTelegramTransport.setPinnedDialog')(function* (
    peer: TelegramPeer,
    pinned: boolean,
  ) {
    yield* (yield* getClient).invoke(
      Api.messages.ToggleDialogPin({
        peer: Api.InputDialogPeer({ peer: toInputPeer(peer) }),
        ...(pinned ? { pinned: true as const } : {}),
      }),
    );
  });
  const setArchived = Effect.fn('WebTelegramTransport.setArchived')(function* (
    peer: TelegramPeer,
    archived: boolean,
  ) {
    const result = yield* (yield* getClient).invoke(
      Api.folders.EditPeerFolders({
        folderPeers: [Api.InputFolderPeer({ peer: toInputPeer(peer), folderId: archived ? 1 : 0 })],
      }),
    );
    return { updateBatches: toUpdateBatches(result) };
  });
  const deleteDialog = Effect.fn('WebTelegramTransport.deleteDialog')(function* (
    peer: TelegramPeer,
    action: TelegramDeleteDialogAction = peer.kind === 'user'
      ? 'clear-for-me'
      : peer.kind === 'channel'
        ? 'leave'
        : 'leave',
  ) {
    if (peer.kind === 'channel') {
      if (action !== 'leave' && action !== 'delete-channel') {
        return yield* Effect.fail(
          createMtprotoError('protocol', 'Unsupported channel deletion action.'),
        );
      }
      if (action === 'delete-channel') {
        const result = yield* (yield* getClient).invoke(
          Api.channels.DeleteChannel({ channel: inputChannel(peer) }),
        );
        return { updateBatches: toUpdateBatches(result) };
      }
      const result = yield* (yield* getClient).invoke(
        Api.channels.LeaveChannel({ channel: inputChannel(peer) }),
      );
      return { updateBatches: toUpdateBatches(result) };
    }
    if (peer.kind === 'group') {
      if (action !== 'leave' && action !== 'delete-chat') {
        return yield* Effect.fail(
          createMtprotoError('protocol', 'Unsupported group deletion action.'),
        );
      }
      if (action === 'delete-chat') {
        const updateBatches: TransportUpdateBatch[] = [];
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const history = yield* (yield* getClient).invoke(
            Api.messages.DeleteHistory({ revoke: true, peer: toInputPeer(peer), maxId: 0 }),
          );
          updateBatches.push({
            updates: [{ type: 'pts-advanced', pts: history.pts, ptsCount: history.ptsCount }],
          });
          if (history.offset <= 0) break;
          if (attempt === 99) {
            return yield* Effect.fail(
              createMtprotoError('protocol', 'Telegram did not finish deleting the group history.'),
            );
          }
        }
        yield* (yield* getClient).invoke(
          Api.messages.DeleteChat({ chatId: BigInt(peer.id.slice(2)) }),
        );
        return { updateBatches };
      }
      const updateBatches: TransportUpdateBatch[] = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const history = yield* (yield* getClient).invoke(
          Api.messages.DeleteHistory({ justClear: true, peer: toInputPeer(peer), maxId: 0 }),
        );
        updateBatches.push({
          updates: [{ type: 'pts-advanced', pts: history.pts, ptsCount: history.ptsCount }],
        });
        if (history.offset <= 0) break;
        if (attempt === 99) {
          return yield* Effect.fail(
            createMtprotoError('protocol', 'Telegram did not finish clearing the group history.'),
          );
        }
      }
      const result = yield* (yield* getClient).invoke(
        Api.messages.DeleteChatUser({
          chatId: BigInt(peer.id.slice(2)),
          userId: Api.InputUserSelf(),
        }),
      );
      return { updateBatches: [...updateBatches, ...toUpdateBatches(result)] };
    }
    if (action !== 'clear-for-me' && action !== 'delete-for-everyone') {
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Unsupported private-chat deletion action.'),
      );
    }
    const updateBatches: TransportUpdateBatch[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = yield* (yield* getClient).invoke(
        Api.messages.DeleteHistory({
          peer: toInputPeer(peer),
          maxId: 0,
          ...(action === 'clear-for-me' ? { justClear: true as const } : { revoke: true as const }),
        }),
      );
      updateBatches.push({
        updates: [{ type: 'pts-advanced', pts: result.pts, ptsCount: result.ptsCount }],
      });
      if (result.offset <= 0) return { updateBatches };
    }
    return yield* Effect.fail(
      createMtprotoError('protocol', 'Telegram did not finish deleting the chat history.'),
    );
  });
  const setPinnedMessage = Effect.fn('WebTelegramTransport.setPinnedMessage')(function* (
    peer: TelegramPeer,
    messageId: number,
    pinned: boolean,
  ) {
    const result = yield* (yield* getClient).invoke(
      Api.messages.UpdatePinnedMessage({
        peer: toInputPeer(peer),
        id: messageId,
        silent: true,
        ...(pinned ? {} : { unpin: true as const }),
      }),
    );
    return { updateBatches: toUpdateBatches(result) };
  });
  const setTyping = Effect.fn('WebTelegramTransport.setTyping')(function* (
    peer: TelegramPeer,
    kind?: TelegramActivityKind,
  ) {
    const action = !kind
      ? Api.SendMessageCancelAction()
      : kind === 'uploading'
        ? Api.SendMessageUploadDocumentAction({ progress: 0 })
        : kind === 'recording'
          ? Api.SendMessageRecordAudioAction()
          : kind === 'choosing-sticker'
            ? Api.SendMessageChooseStickerAction()
            : Api.SendMessageTypingAction();
    yield* (yield* getClient).invoke(Api.messages.SetTyping({ peer: toInputPeer(peer), action }));
  });
  const sendText = Effect.fn('WebTelegramTransport.sendText')(function* (
    peer: TelegramPeer,
    text: string,
    randomId: string,
    reply?: TelegramReplyTarget,
    formats?: readonly TelegramTextFormat[],
  ) {
    const result = yield* (yield* getClient).invoke(
      Api.messages.SendMessage({
        peer: toInputPeer(peer),
        message: text,
        randomId: telegramLong(randomId),
        ...(reply ? { replyTo: inputReply(reply) } : {}),
        ...(formats?.length ? { entities: inputEntities(formats) } : {}),
      }),
    );
    if (Api.UpdateShortSentMessage.is(result)) {
      return yield* mapShortSentMessage(peer, text, randomId, result, reply, formats);
    }
    const message = messagesFromUpdates(result)
      .map((candidate) => mapMessage(candidate))
      .find((candidate): candidate is TelegramMessage => Boolean(candidate));
    if (message) {
      const sentMessage = { ...message, randomId };
      return { message: sentMessage, updateBatches: toUpdateBatches(result, [sentMessage]) };
    }
    return yield* Effect.fail(
      createMtprotoError('protocol', 'Telegram accepted the send but returned no message.'),
    );
  });
  const sendFile = Effect.fn('WebTelegramTransport.sendFile')(function* (
    peer: TelegramPeer,
    file: File,
    options: SendFileOptions,
  ) {
    const media = yield* uploadInputMedia(
      file,
      options.sendAs,
      options.asSticker,
      options.onProgress,
    );
    const result = yield* (yield* getClient).invoke(
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
      return yield* mapShortSentMessage(
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
    if (!message)
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram accepted the upload but returned no message.'),
      );
    const sentMessage = { ...message, randomId: options.randomId };
    return { message: sentMessage, updateBatches: toUpdateBatches(result, [sentMessage]) };
  });
  const sendAlbum = Effect.fn('WebTelegramTransport.sendAlbum')(function* (
    peer: TelegramPeer,
    attachments: SendAlbumAttachment[],
    options: SendAlbumOptions,
  ) {
    if (attachments.length < 2 || attachments.length > 10) {
      return yield* Effect.fail(
        createMtprotoError(
          'protocol',
          'Telegram albums must contain between 2 and 10 attachments.',
        ),
      );
    }
    const inputPeer = toInputPeer(peer);
    const multiMedia: Tl.InputSingleMedia[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const uploadedMedia = yield* uploadInputMedia(
        attachment.file,
        attachment.sendAs,
        false,
        options.onProgress
          ? (progress) => options.onProgress!((index + progress) / attachments.length)
          : undefined,
      );
      const media = yield* uploadAlbumMedia(inputPeer, uploadedMedia);
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
    const result = yield* (yield* getClient).invoke(
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
      return yield* Effect.fail(
        createMtprotoError(
          'protocol',
          'Telegram accepted the album but returned an incomplete message list.',
        ),
      );
    }
    const sentMessages = messages.map((message, index) => ({
      ...message,
      randomId: attachments[index]!.randomId,
    }));
    return { messages: sentMessages, updateBatches: toUpdateBatches(result, sentMessages) };
  });
  const downloadMedia = Effect.fn('WebTelegramTransport.downloadMedia')(function* (
    message: TelegramMessage,
    options?: TelegramDownloadOptions,
  ) {
    const key = `${message.peerId}:${message.id}`;
    const media = options?.preview
      ? (state.linkPreviewPhotos.get(key) ?? state.messageMedia.get(key))
      : (state.messageMedia.get(key) ?? state.linkPreviewPhotos.get(key));
    if (!media)
      return yield* Effect.fail(
        createMtprotoError(
          'protocol',
          'Media data is no longer in memory. Reopen the chat and retry.',
        ),
      );
    const bytes = yield* (yield* getClient).downloadMedia(media, {
      workers: 1,
      ...(options?.preview ? { sizeType: 'm' } : {}),
      progress: options?.progress
        ? (progress) => Effect.sync(() => options.progress!(progress))
        : undefined,
    });
    if (!bytes)
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram returned no media bytes.'),
      );
    return new Blob([bytes as BlobPart], {
      type: options?.preview
        ? 'image/jpeg'
        : message.media?.mimeType ||
          message.linkPreview?.media?.mimeType ||
          'application/octet-stream',
    });
  });
  const downloadAvatar = Effect.fn('WebTelegramTransport.downloadAvatar')(function* (
    peer: TelegramPeer,
  ) {
    let entity = state.entities.get(peer.id);
    if (!hasDownloadableAvatar(entity)) entity = yield* fetchEntity(peer);
    if (!hasDownloadableAvatar(entity)) return undefined;
    const client = yield* getClient;
    const bytes = yield* client.downloadProfilePhoto(entity as Tl.User | Tl.Chat, false);
    return bytes ? new Blob([bytes as BlobPart], { type: 'image/jpeg' }) : undefined;
  });
  const getThemes = Effect.fn('WebTelegramTransport.getThemes')(function* () {
    const result = yield* (yield* getClient).invoke(
      Api.account.GetThemes({ format: 'tdesktop', hash: 0n }),
    );
    return mapThemes(result);
  });
  const getChatThemes = Effect.fn('WebTelegramTransport.getChatThemes')(function* () {
    const result = yield* (yield* getClient).invoke(Api.account.GetChatThemes({ hash: 0n }));
    return mapThemes(result);
  });
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
  const getChatAppearance = Effect.fn('WebTelegramTransport.getChatAppearance')(function* (
    peer: TelegramPeer,
  ) {
    let themeEmoticon: string | undefined;
    let wallpaper: TelegramWallpaper | undefined;
    let inlineTheme: TelegramTheme | undefined;

    if (peer.kind === 'user') {
      const result = yield* (yield* getClient).invoke(
        Api.users.GetFullUser({ id: inputUser(peer) }),
      );
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
          ? yield* (yield* getClient).invoke(
              Api.channels.GetFullChannel({ channel: inputChannel(peer) }),
            )
          : yield* (yield* getClient).invoke(
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
        ? (yield* getChatThemes()).find(({ emoticon }) => emoticon === themeEmoticon)
        : undefined);
    return theme || wallpaper
      ? { ...(theme ? { theme } : {}), ...(wallpaper ? { wallpaper } : {}) }
      : undefined;
  });
  const getWallpapers = Effect.fn('WebTelegramTransport.getWallpapers')(function* () {
    const client = yield* getClient;
    const request = Api.account.GetWallPapers({ hash: 0n });
    const result = yield* client.invoke(request);
    if (!Api.account.WallPapers.is(result)) return [];
    return result.wallpapers.flatMap((wallpaper) => mapWallpaper(wallpaper));
  });
  const downloadWallpaper = Effect.fn('WebTelegramTransport.downloadWallpaper')(function* (
    wallpaperId: string,
  ) {
    let document = state.wallpaperDocuments.get(wallpaperId);
    if (!document) {
      yield* getWallpapers();
      document = state.wallpaperDocuments.get(wallpaperId);
    }
    if (!document)
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Reload the Telegram backgrounds and try again.'),
      );
    const bytes = yield* (yield* getClient).downloadMedia(document, { workers: 1 });
    if (!bytes)
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram returned no background image bytes.'),
      );
    if (document.mimeType === 'application/x-tgwallpattern') {
      return yield* Effect.sync(() => {
        return new Blob([gunzipSync(bytes)], { type: 'image/svg+xml' });
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            return yield* Effect.fail(
              createMtprotoError(
                'protocol',
                'Telegram returned an invalid TGV wallpaper pattern.',
                { cause: error },
              ),
            );
          }),
        ),
      );
    }
    return new Blob([bytes as BlobPart], { type: document.mimeType || 'image/jpeg' });
  });
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
  const getRecentStickers = Effect.fn('WebTelegramTransport.getRecentStickers')(function* () {
    const result = yield* (yield* getClient).invoke(Api.messages.GetRecentStickers({ hash: 0n }));
    if (!Api.messages.RecentStickers.is(result)) return [];
    return result.stickers.flatMap((document) => mapStickerDocument(document));
  });
  const getStickerPacks = Effect.fn('WebTelegramTransport.getStickerPacks')(function* () {
    const result = yield* (yield* getClient).invoke(Api.messages.GetAllStickers({ hash: 0n }));
    if (!Api.messages.AllStickers.is(result)) return [];
    const sets = result.sets.filter(
      (set): set is Tl.StickerSet => Api.StickerSet.is(set) && !set.masks && !set.emojis,
    );
    const packs: TelegramStickerPack[] = [];
    for (let offset = 0; offset < sets.length; offset += 4) {
      const batch = yield* Effect.all(
        sets.slice(offset, offset + 4).map((set) =>
          Effect.gen(function* () {
            const contents = yield* (yield* getClient).invoke(
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
          }).pipe(Effect.result),
        ),
        { concurrency: 4 },
      );
      for (const [index, loaded] of batch.entries()) {
        if (Result.isSuccess(loaded)) {
          packs.push(loaded.success);
          continue;
        }
        const set = sets[offset + index];
        reportDiagnostic({
          code: 'sticker-pack-load-failed',
          level: 'warn',
          area: 'transport',
          message: `Could not load the installed sticker pack ${set?.title ?? set?.id ?? 'unknown'}.`,
          details: { error: loaded.failure.message },
        });
      }
    }
    return packs.filter(({ stickers }) => stickers.length > 0);
  });
  const getSavedGifs = Effect.fn('WebTelegramTransport.getSavedGifs')(function* () {
    const result = yield* (yield* getClient).invoke(Api.messages.GetSavedGifs({ hash: 0n }));
    if (!Api.messages.SavedGifs.is(result)) return [];
    return result.gifs.flatMap((document) => mapGifDocument(document));
  });
  const searchGifs = Effect.fn('WebTelegramTransport.searchGifs')(function* (
    peer: TelegramPeer,
    query: string,
  ) {
    const config = yield* (yield* getClient).invoke(Api.help.GetConfig());
    const resolved = yield* (yield* getClient).invoke(
      Api.contacts.ResolveUsername({ username: config.gifSearchUsername || 'gif' }),
    );
    const bot = resolved.users.find((user): user is Tl.User => Api.User.is(user));
    if (!bot?.accessHash) return [];
    const result = yield* (yield* getClient).invoke(
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
  });
  const downloadSticker = Effect.fn('WebTelegramTransport.downloadSticker')(function* (
    sticker: TelegramSticker,
  ) {
    const document = state.stickerDocuments.get(sticker.id);
    let bytes: File | Uint8Array | undefined;
    if (document) {
      bytes = yield* (yield* getClient).downloadMedia(document, { workers: 1 });
    } else {
      if (sticker.dcId === undefined)
        return yield* Effect.fail(
          createMtprotoError(
            'protocol',
            'The cached sticker index is obsolete. Reopen the picker to refresh it.',
          ),
        );
      bytes = yield* (yield* getClient).downloadFile(
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
    if (!bytes)
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram returned no sticker bytes.'),
      );
    return new Blob([bytes as BlobPart], { type: sticker.mimeType });
  });
  const downloadCustomEmoji = Effect.fn('WebTelegramTransport.downloadCustomEmoji')(function* (
    documentId: string,
  ) {
    const documents = yield* (yield* getClient).invoke(
      Api.messages.GetCustomEmojiDocuments({ documentId: [BigInt(documentId)] }),
    );
    const document = documents.find((candidate): candidate is Tl.Document =>
      Api.Document.is(candidate),
    );
    if (!document)
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram returned no custom emoji document.'),
      );
    const bytes = yield* (yield* getClient).downloadMedia(document, { workers: 1 });
    if (!bytes)
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram returned no custom emoji bytes.'),
      );
    return new Blob([bytes as BlobPart], { type: document.mimeType });
  });
  const getBotCommands = Effect.fn('WebTelegramTransport.getBotCommands')(function* (
    peer: TelegramPeer,
  ) {
    if (peer.kind === 'user') {
      const result = yield* (yield* getClient).invoke(
        Api.users.GetFullUser({ id: inputUser(peer) }),
      );
      rememberEntities(result.users, result.chats);
      const botInfo = Api.UserFull.is(result.fullUser) ? result.fullUser.botInfo : undefined;
      return Api.BotInfo.is(botInfo) ? mapBotCommands([botInfo], result.users, peer.id) : [];
    }
    const result =
      peer.kind === 'channel'
        ? yield* (yield* getClient).invoke(
            Api.channels.GetFullChannel({ channel: inputChannel(peer) }),
          )
        : yield* (yield* getClient).invoke(
            Api.messages.GetFullChat({ chatId: BigInt(peer.id.slice(2)) }),
          );
    rememberEntities(result.users, result.chats);
    const botInfo =
      Api.ChatFull.is(result.fullChat) || Api.ChannelFull.is(result.fullChat)
        ? (result.fullChat.botInfo ?? [])
        : [];
    return mapBotCommands(botInfo, result.users);
  });
  const startBot = Effect.fn('WebTelegramTransport.startBot')(function* (
    peer: TelegramPeer,
    startParam: string,
    randomId: string,
  ) {
    if (peer.kind !== 'user')
      return yield* Effect.fail(createMtprotoError('protocol', 'Only a user bot can be started.'));
    if (!startParam) return yield* sendText(peer, '/start', randomId);
    const result = yield* (yield* getClient).invoke(
      Api.messages.StartBot({
        bot: inputUser(peer),
        peer: toInputPeer(peer),
        randomId: telegramLong(randomId),
        startParam,
      }),
    );
    return yield* mapOutgoingSendResult(
      result,
      peer,
      randomId,
      'Telegram started the bot but returned no outgoing message.',
    );
  });
  const answerBotCallback = Effect.fn('WebTelegramTransport.answerBotCallback')(function* (
    peer: TelegramPeer,
    messageId: number,
    data: number[],
  ) {
    const result = yield* (yield* getClient).invoke(
      Api.messages.GetBotCallbackAnswer({
        peer: toInputPeer(peer),
        msgId: messageId,
        data: new Uint8Array(data),
      }),
    );
    return { message: result.message, alert: Boolean(result.alert), url: result.url };
  });
  const requestUrlAuth = Effect.fn('WebTelegramTransport.requestUrlAuth')(function* (
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
  ) {
    const result = yield* (yield* getClient).invoke(
      Api.messages.RequestUrlAuth({ peer: toInputPeer(peer), msgId: messageId, buttonId }),
    );
    return mapUrlAuthResult(result);
  });
  const acceptUrlAuth = Effect.fn('WebTelegramTransport.acceptUrlAuth')(function* (
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
    acceptOptions: TelegramUrlAuthAcceptOptions = {},
  ) {
    const result = yield* (yield* getClient).invoke(
      Api.messages.AcceptUrlAuth({
        peer: toInputPeer(peer),
        msgId: messageId,
        buttonId,
        ...(acceptOptions.writeAllowed ? { writeAllowed: true as const } : {}),
        ...(acceptOptions.sharePhoneNumber ? { sharePhoneNumber: true as const } : {}),
        ...(acceptOptions.matchCode ? { matchCode: acceptOptions.matchCode } : {}),
      }),
    );
    return mapUrlAuthResult(result);
  });
  const sendSticker = Effect.fn('WebTelegramTransport.sendSticker')(function* (
    peer: TelegramPeer,
    sticker: TelegramSticker,
    randomId: string,
    reply?: TelegramReplyTarget,
  ) {
    if (sticker.inlineQueryId && sticker.inlineResultId) {
      const result = yield* (yield* getClient).invoke(
        Api.messages.SendInlineBotResult({
          peer: toInputPeer(peer),
          randomId: telegramLong(randomId),
          queryId: BigInt(sticker.inlineQueryId),
          id: sticker.inlineResultId,
          ...(reply ? { replyTo: inputReply(reply) } : {}),
        }),
      );
      return yield* mapOutgoingSendResult(
        result,
        peer,
        randomId,
        'Telegram accepted the GIF but returned no message.',
      );
    }
    const result = yield* (yield* getClient).invoke(
      Api.messages.SendMedia({
        peer: toInputPeer(peer),
        media: Api.InputMediaDocument({ id: inputDocument(sticker) }),
        message: '',
        randomId: telegramLong(randomId),
        ...(reply ? { replyTo: inputReply(reply) } : {}),
      }),
    );
    if (Api.UpdateShortSentMessage.is(result)) {
      return yield* mapShortSentMessage(peer, '', randomId, result, reply);
    }
    const message = messagesFromUpdates(result)
      .map((candidate) => mapMessage(candidate))
      .find((candidate): candidate is TelegramMessage => Boolean(candidate));
    if (!message)
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram accepted the sticker but returned no message.'),
      );
    const sentMessage = { ...message, randomId };
    return { message: sentMessage, updateBatches: toUpdateBatches(result, [sentMessage]) };
  });
  const setReaction = Effect.fn('WebTelegramTransport.setReaction')(function* (
    peer: TelegramPeer,
    messageId: number,
    emoji?: string,
  ) {
    const customEmojiId = emoji?.startsWith('custom:') ? emoji.slice('custom:'.length) : undefined;
    const result = yield* (yield* getClient).invoke(
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
  });
  const deleteMessages = Effect.fn('WebTelegramTransport.deleteMessages')(function* (
    peer: TelegramPeer,
    messageIds: number[],
    revoke: boolean,
  ): Effect.fn.Return<TransportMutationResult, MtprotoError> {
    let result: Tl.messages.AffectedMessages;
    if (peer.kind === 'channel') {
      if (!revoke) {
        return yield* Effect.fail(
          createMtprotoError('protocol', 'Channel messages can only be deleted for everyone.'),
        );
      }
      result = yield* (yield* getClient).invoke(
        Api.channels.DeleteMessages({ channel: inputChannel(peer), id: messageIds }),
      );
      for (const messageId of messageIds) forgetMessageMedia(peer.id, messageId);
    } else {
      result = yield* (yield* getClient).invoke(
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
  });
  const editMessage = Effect.fn('WebTelegramTransport.editMessage')(function* (
    peer: TelegramPeer,
    messageId: number,
    text: string,
    formats?: readonly TelegramTextFormat[],
    replacement?: EditMediaOptions,
  ) {
    const media = replacement
      ? yield* uploadInputMedia(replacement.file, replacement.sendAs, false, undefined)
      : undefined;
    const result = yield* (yield* getClient).invoke(
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
    const history = yield* getHistoryAround(peer, messageId, 3);
    const fallback = history.messages.find(({ id }) => id === messageId);
    if (!fallback)
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram accepted the edit but returned no message.'),
      );
    return { message: fallback, updateBatches };
  });
  const forwardMessage = Effect.fn('WebTelegramTransport.forwardMessage')(function* (
    fromPeer: TelegramPeer,
    toPeer: TelegramPeer,
    messageId: number,
    randomId: string,
  ) {
    const result = yield* (yield* getClient).invoke(
      Api.messages.ForwardMessages({
        fromPeer: toInputPeer(fromPeer),
        id: [messageId],
        randomId: [telegramLong(randomId)],
        toPeer: toInputPeer(toPeer),
      }),
    );
    return yield* mapOutgoingSendResult(
      result,
      toPeer,
      randomId,
      'Telegram accepted the forward but returned no message.',
    );
  });
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
    if (Api.UpdateMessageID.is(update)) {
      return [
        { type: 'message-id-assigned', messageId: update.id, randomId: update.randomId.toString() },
      ];
    }
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
    if (update._ === 'updateWebPage' || update._ === 'updateChannelWebPage') {
      const webpageUpdate = update as Tl.UpdateWebPage | Tl.UpdateChannelWebPage;
      if (!Api.WebPage.is(webpageUpdate.webpage)) {
        return [
          {
            type: 'pts-advanced',
            pts: webpageUpdate.pts,
            ptsCount: webpageUpdate.ptsCount,
            ...(update._ === 'updateChannelWebPage' ? { channelScoped: true } : {}),
          },
        ];
      }
      const linkPreview = refreshRememberedWebPage(webpageUpdate.webpage);
      return linkPreview
        ? [
            {
              type: 'web-page-updated',
              pts: webpageUpdate.pts,
              ptsCount: webpageUpdate.ptsCount,
              ...(update._ === 'updateChannelWebPage'
                ? {
                    channelScoped: true,
                    peerId: `c:${(webpageUpdate as Tl.UpdateChannelWebPage).channelId}`,
                  }
                : {}),
              webPageId: webpageUpdate.webpage.id.toString(),
              linkPreview,
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
        { type: 'peer-metadata-changed', peerId: `u:${(update as Tl.UpdateUserName).userId}` },
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
    if (Api.UpdateDialogPinned.is(update) || Api.UpdatePinnedDialogs.is(update)) {
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
      const peer = peerFromId(peerId, state.entities);
      const peerEntity = state.entities.get(peerId);
      const senderId = toPeerId(message.fromId) ?? (message.out ? 'self' : peerId);
      const sender = state.entities.get(senderId);
      const senderName = entityTitle(sender);
      const service = mapServiceAction(message.action, senderId);
      return {
        id: message.id,
        peerId,
        ...(peer ? { peer } : {}),
        ...(entityTitle(peerEntity) ? { peerTitle: entityTitle(peerEntity) } : {}),
        ...(peer ? { permissions: mapDialogPermissions(peer, peerEntity) } : {}),
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
    const peer = peerFromId(peerId, state.entities);
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
      ...(peer ? { peer } : {}),
      ...(entityTitle(peerEntity) ? { peerTitle: entityTitle(peerEntity) } : {}),
      ...(peer ? { permissions: mapDialogPermissions(peer, peerEntity) } : {}),
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
      return { kind: 'url-auth', text: button.text, url: button.url, buttonId: button.buttonId };
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
        return [{ offset: entity.offset, length: entity.length, userId: `u:${entity.userId}` }];
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
      const webpage = media.webpage;
      const hasPhoto = Api.Photo.is(webpage.photo);
      const hasMetadata = Boolean(
        webpage.siteName || webpage.title || webpage.description || webpage.author,
      );
      const isVideoPage =
        webpage.type === 'video' || webpage.type === 'gif' || Boolean(webpage.embedUrl);
      const defaultsToSmall = Boolean(
        hasPhoto &&
        hasMetadata &&
        !webpage.document &&
        !isVideoPage &&
        !['photo', 'document', 'story'].includes(webpage.type ?? '') &&
        !['twitter', 'x', 'x (formerly twitter)', 'facebook'].includes(
          webpage.siteName?.trim().toLowerCase() ?? '',
        ) &&
        !webpage.cachedPage,
      );
      const photoSize = media.forceLargeMedia
        ? ('large' as const)
        : media.forceSmallMedia
          ? ('small' as const)
          : defaultsToSmall
            ? ('small' as const)
            : ('large' as const);
      const document = Api.Document.is(webpage.document) ? webpage.document : undefined;
      const videoAttribute = document?.attributes.find(
        (attribute): attribute is Tl.DocumentAttributeVideo =>
          Api.DocumentAttributeVideo.is(attribute),
      );
      const filename = document?.attributes.find(
        (attribute): attribute is Tl.DocumentAttributeFilename =>
          Api.DocumentAttributeFilename.is(attribute),
      );
      const animated = document?.attributes.some((attribute) =>
        Api.DocumentAttributeAnimated.is(attribute),
      );
      const previewMedia =
        document && (videoAttribute || animated)
          ? {
              kind: animated ? ('animation' as const) : ('video' as const),
              name: filename?.fileName ?? `web-video-${document.id}.mp4`,
              mimeType: document.mimeType,
              size: Number(document.size),
              ...(videoAttribute
                ? {
                    width: videoAttribute.w,
                    height: videoAttribute.h,
                    duration: videoAttribute.duration,
                  }
                : {}),
              cacheKey: `document:${document.id}`,
            }
          : undefined;
      return {
        url: webpage.url,
        webPageId: webpage.id.toString(),
        ...(webpage.type ? { type: webpage.type } : {}),
        ...(webpage.embedUrl ? { hasEmbed: true } : {}),
        siteName: webpage.siteName,
        title: webpage.title,
        description: webpage.description,
        hasPhoto,
        ...(hasPhoto ? { photoSize } : {}),
        ...(previewMedia ? { media: previewMedia } : {}),
      };
    }
    return undefined;
  }
  function refreshRememberedWebPage(webpage: Tl.WebPage) {
    let previewMedia: Tl.MessageMediaWebPage = Api.MessageMediaWebPage({ webpage });
    for (const [key, media] of state.messageMedia) {
      if (
        !Api.MessageMediaWebPage.is(media) ||
        !Api.WebPage.is(media.webpage) ||
        !sameTelegramLong(media.webpage.id, webpage.id)
      ) {
        continue;
      }
      const refreshed: Tl.MessageMediaWebPage = { ...media, webpage };
      state.messageMedia.set(key, refreshed);
      previewMedia = refreshed;
      if (Api.Photo.is(webpage.photo)) {
        rememberBounded(state.linkPreviewPhotos, key, webpage.photo, MAX_MESSAGE_MEDIA_ENTRIES);
      } else {
        state.linkPreviewPhotos.delete(key);
      }
    }
    return mapLinkPreview(previewMedia);
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
      return { kind: 'link', child: mapRichText(text.text), url: richTextValue(text.text) };
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
      return { kind: 'link', child: mapRichText(text.text), url: `tg://user?id=${text.userId}` };
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
      return { kind: 'diff', child: mapRichText(text.text), oldText: mapRichText(text.oldText) };
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
        { kind: 'heading', level: heading as 1 | 2 | 3 | 4 | 5 | 6, text: mapRichText(block.text) },
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
        { kind: 'author', author: mapRichText(block.author), publishedAt: block.publishedDate },
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
  const uploadAlbumMedia = Effect.fn('WebTelegramTransport.uploadAlbumMedia')(function* (
    peer: Tl.TypeInputPeer,
    media: Tl.TypeInputMedia,
  ) {
    const uploaded = yield* (yield* getClient).invoke(Api.messages.UploadMedia({ peer, media }));
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
    return yield* Effect.fail(
      createMtprotoError('protocol', 'Telegram could not prepare an album attachment.'),
    );
  });
  const uploadInputMedia = Effect.fn('WebTelegramTransport.uploadInputMedia')(function* (
    file: File,
    sendAs: OutgoingAttachmentMode,
    asSticker: boolean,
    onProgress?: (progress: number) => Effect.Effect<void>,
  ) {
    const uploaded = yield* (yield* getClient).uploadFile({
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
        Api.DocumentAttributeSticker({ alt: '🙂', stickerset: Api.InputStickerSetEmpty() }),
      );
    } else if (sendAs === 'media' && file.type === 'image/gif') {
      attributes.push(Api.DocumentAttributeAnimated());
    } else if (sendAs === 'media' && file.type.startsWith('video/')) {
      const metadata = yield* (dependencies.readVideoMetadata ?? readVideoMetadata)(file);
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
  });
  const readVideoMetadata = Effect.fn('WebTelegramTransport.readVideoMetadata')(function* (
    file: File,
  ) {
    if (
      typeof document === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return yield* Effect.fail(
        createMtprotoError('configuration', 'Video metadata is unavailable in this browser.'),
      );
    }
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => URL.createObjectURL(file)),
      (url) =>
        Effect.callback<{ duration: number; width: number; height: number }, MtprotoError>(
          (resume) => {
            const video = document.createElement('video');
            let settled = false;
            const finish = (
              result?: { duration: number; width: number; height: number },
              error?: MtprotoError,
            ) => {
              if (settled) return;
              settled = true;
              video.onloadedmetadata = null;
              video.onerror = null;
              video.removeAttribute('src');
              video.load();
              if (error) resume(Effect.fail(error));
              else if (result) resume(Effect.succeed(result));
            };
            video.preload = 'metadata';
            video.onloadedmetadata = () => {
              const duration = video.duration;
              const width = video.videoWidth;
              const height = video.videoHeight;
              if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) {
                finish(
                  undefined,
                  createMtprotoError('configuration', 'The selected video has invalid metadata.'),
                );
                return;
              }
              finish({ duration, width, height });
            };
            video.onerror = () => {
              finish(
                undefined,
                createMtprotoError('transport', 'Could not read the selected video.'),
              );
            };
            video.src = url;
            return Effect.sync(() => finish());
          },
        ).pipe(
          Effect.timeoutOrElse({
            duration: 15_000,
            orElse: () =>
              Effect.fail(
                createMtprotoError('transport', 'Timed out while reading video metadata.'),
              ),
          }),
        ),
      (url) => Effect.sync(() => URL.revokeObjectURL(url)),
    );
  });
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
      permissions: mapDialogPermissions(peer, entity),
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
  function mapDialogPermissions(
    peer: TelegramPeer,
    entity: Tl.TypeUser | Tl.TypeChat | undefined,
  ): TelegramChatPermissions {
    if (peer.kind === 'user' || Api.User.is(entity)) {
      return {
        canSendMessages: true,
        canSendMedia: true,
        canSendStickers: true,
        canSendGifs: true,
        canPinMessages: true,
        canEditMessages: false,
        canDeleteMessages: false,
        canDeleteForEveryone: true,
        canDeleteChat: false,
        canDeleteChannel: false,
        canLeave: false,
        canViewMembers: false,
      };
    }
    const manageableEntity = Api.Channel.is(entity) || Api.Chat.is(entity) ? entity : undefined;
    if (!manageableEntity) {
      return {
        canSendMessages: false,
        canSendMedia: false,
        canSendStickers: false,
        canSendGifs: false,
        canPinMessages: false,
        canEditMessages: false,
        canDeleteMessages: false,
        canDeleteForEveryone: false,
        canDeleteChat: false,
        canDeleteChannel: false,
        canLeave: true,
        canViewMembers: false,
      };
    }
    const creator = Boolean(manageableEntity?.creator);
    const rights = manageableEntity?.adminRights;
    const currentBanned = Api.Channel.is(entity) ? entity.bannedRights : undefined;
    const banned = currentBanned ?? manageableEntity?.defaultBannedRights;
    const canManageMessages = creator || Boolean(rights?.deleteMessages);
    const canPinMessages = creator || Boolean(rights?.pinMessages);
    const canEditMessages = creator || Boolean(rights?.editMessages);
    const base = {
      canSendMessages: !manageableEntity?.left && !banned?.sendMessages,
      canSendMedia: !banned?.sendMedia,
      canSendStickers: !banned?.sendStickers,
      canSendGifs: !banned?.sendGifs,
      canPinMessages,
      canEditMessages,
      canDeleteMessages: canManageMessages,
      canDeleteForEveryone: canManageMessages,
      canLeave: !creator,
      canViewMembers: true,
    } satisfies Omit<TelegramChatPermissions, 'canDeleteChat' | 'canDeleteChannel' | 'memberCount'>;
    if (Api.Channel.is(entity)) {
      return {
        ...base,
        canSendMessages:
          base.canSendMessages &&
          (!entity.broadcast ||
            creator ||
            Boolean(rights?.postMessages) ||
            Boolean(entity.broadcastMessagesAllowed)),
        canDeleteChat: false,
        canDeleteChannel: creator,
        canViewMembers: !entity.broadcast,
        ...(entity.participantsCount === undefined
          ? {}
          : { memberCount: entity.participantsCount }),
      };
    }
    if (Api.Chat.is(entity)) {
      return {
        ...base,
        canDeleteChat: creator,
        canDeleteChannel: false,
        ...(entity.participantsCount === undefined
          ? {}
          : { memberCount: entity.participantsCount }),
      };
    }
    return { ...groupFallbackPermissions(), canLeave: true };
  }
  function groupFallbackPermissions(): TelegramChatPermissions {
    return {
      canSendMessages: false,
      canSendMedia: false,
      canSendStickers: false,
      canSendGifs: false,
      canPinMessages: false,
      canEditMessages: false,
      canDeleteMessages: false,
      canDeleteForEveryone: false,
      canDeleteChat: false,
      canDeleteChannel: false,
      canLeave: true,
      canViewMembers: false,
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
    return { id, kind: peerKind(id), accessHash };
  }
  function peerFromId(id: string, entities: Map<string, Tl.TypeUser | Tl.TypeChat>): TelegramPeer {
    const entity = entities.get(id);
    const accessHash =
      entity && 'accessHash' in entity && entity.accessHash !== undefined
        ? entity.accessHash.toString()
        : undefined;
    return { id, kind: peerKind(id), accessHash };
  }
  function peerKind(id: string): TelegramPeer['kind'] {
    return id.startsWith('u:') ? 'user' : id.startsWith('c:') ? 'channel' : 'group';
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
  const mapShortSentMessage = Effect.fn('telegram.webTransport.shortSent')(function* (
    peer: TelegramPeer,
    text: string,
    randomId: string,
    result: Tl.UpdateShortSentMessage,
    reply?: TelegramReplyTarget,
    formats?: readonly TelegramTextFormat[],
  ) {
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
    if (!message)
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram accepted the send but returned no message.'),
      );
    const sentMessage = { ...message, randomId };
    return { message: sentMessage, updateBatches: shortSentUpdateBatches(result, sentMessage) };
  });
  const mapOutgoingSendResult = Effect.fn('WebTelegramTransport.mapOutgoingSendResult')(function* (
    result: Tl.TypeUpdates,
    peer: TelegramPeer,
    randomId: string,
    failureMessage: string,
  ) {
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
      message = yield* getMessageById(peer, returnedMessageId);
    }
    if (!message) return yield* Effect.fail(createMtprotoError('protocol', failureMessage));
    const sentMessage = { ...message, randomId };
    return {
      message: sentMessage,
      updateBatches: Api.UpdateShortSentMessage.is(result)
        ? shortSentUpdateBatches(result, sentMessage)
        : toUpdateBatches(result, [sentMessage]),
    };
  });
  const getMessageById = Effect.fn('WebTelegramTransport.getMessageById')(function* (
    peer: TelegramPeer,
    messageId: number,
  ) {
    const id = [Api.InputMessageID({ id: messageId })];
    const result =
      peer.kind === 'channel'
        ? yield* (yield* getClient).invoke(
            Api.channels.GetMessages({ channel: inputChannel(peer), id }),
          )
        : yield* (yield* getClient).invoke(Api.messages.GetMessages({ id }));
    if (Api.messages.MessagesNotModified.is(result)) return undefined;
    rememberEntities(result.users, result.chats);
    return result.messages
      .map((candidate) => mapMessage(candidate))
      .find(
        (candidate): candidate is TelegramMessage =>
          candidate?.id === messageId && candidate.peerId === peer.id,
      );
  });
  function shortSentUpdateBatches(
    result: Tl.UpdateShortSentMessage,
    message: TelegramMessage,
  ): TransportUpdateBatch[] {
    return [
      {
        updates: [{ type: 'new-message', pts: result.pts, ptsCount: result.ptsCount, message }],

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
    const channelPts = Api.messages.ChannelMessages.is(result) ? result.pts : undefined;
    const hasContinuation = global
      ? Api.messages.MessagesSlice.is(result) && result.nextRate !== undefined
      : result.messages.length > limit;
    if (!hasContinuation) {
      return { messages, hasMore: false, ...(channelPts === undefined ? {} : { channelPts }) };
    }

    let last: Tl.Message | undefined;
    for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
      const candidate = rawMessages[index];
      if (Api.Message.is(candidate)) {
        last = candidate;
        break;
      }
    }
    if (!last) {
      return { messages, hasMore: false, ...(channelPts === undefined ? {} : { channelPts }) };
    }
    const nextPeer = global ? mapPeer(last.peerId, state.entities) : undefined;
    if (global && !nextPeer) {
      return { messages, hasMore: false, ...(channelPts === undefined ? {} : { channelPts }) };
    }
    const nextOffset: TelegramSearchOffset = {
      messageId: last.id,
      ...(nextPeer ? { peer: nextPeer } : {}),
      ...(global
        ? { rate: Api.messages.MessagesSlice.is(result) ? (result.nextRate ?? 0) : 0 }
        : {}),
    };
    return {
      messages,
      hasMore: true,
      nextOffset,
      ...(channelPts === undefined ? {} : { channelPts }),
    };
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
  const fetchEntity = Effect.fn('WebTelegramTransport.fetchEntity')(function* (peer: TelegramPeer) {
    if (peer.kind === 'user') {
      const users = yield* (yield* getClient).invoke(Api.users.GetUsers({ id: [inputUser(peer)] }));
      rememberEntities(users, []);
      return users.find((user) => `u:${user.id}` === peer.id);
    }
    const result =
      peer.kind === 'channel'
        ? yield* (yield* getClient).invoke(Api.channels.GetChannels({ id: [inputChannel(peer)] }))
        : yield* (yield* getClient).invoke(
            Api.messages.GetChats({ id: [BigInt(peer.id.slice(2))] }),
          );
    rememberEntities([], result.chats);
    return result.chats.find((chat) => {
      const prefix = Api.Channel.is(chat) || Api.ChannelForbidden.is(chat) ? 'c' : 'g';
      return `${prefix}:${chat.id}` === peer.id;
    });
  });
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
    state.messageMedia.clear();
    state.linkPreviewPhotos.clear();
    state.stickerDocuments.clear();
    state.wallpaperDocuments.clear();
    state.entities.clear();
    state.channelSenderRoles.clear();
    state.channelRolesLoaded.clear();
    state.notifyDefaults.clear();
    state.notifyDefaultsLoaded = false;
    state.phoneNumber = '';
    state.phoneCodeHash = '';
  }
  function waitForOptionalEnrichment(operation: Effect.Effect<unknown, unknown>) {
    return optionalEnrichmentDeadlineMs === 0
      ? operation.pipe(Effect.ignore)
      : operation.pipe(Effect.timeout(optionalEnrichmentDeadlineMs), Effect.ignore);
  }
  const ensureNotifyDefaults = Effect.fn('WebTelegramTransport.ensureNotifyDefaults')(function* () {
    if (state.notifyDefaultsLoaded) return;
    const client = yield* getClient;
    const requests = [
      ['users', Api.InputNotifyUsers()],
      ['groups', Api.InputNotifyChats()],
      ['channels', Api.InputNotifyBroadcasts()],
    ] as const;
    const results = yield* Effect.all(
      requests.map(([, peer]) =>
        client.invoke(Api.account.GetNotifySettings({ peer })).pipe(Effect.result),
      ),
      { concurrency: 3 },
    );
    results.forEach((result, index) => {
      if (Result.isSuccess(result) && Api.PeerNotifySettings.is(result.success)) {
        state.notifyDefaults.set(requests[index]![0], result.success);
      }
    });
    state.notifyDefaultsLoaded = true;
  });
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
    return { senderRole: label, senderRoleKind: role?.kind ?? (ownerLabel ? 'owner' : 'admin') };
  }
  const ensureChannelSenderRoles = Effect.fn('WebTelegramTransport.ensureChannelSenderRoles')(
    function* (peer: TelegramPeer, senderIds: readonly string[]) {
      if (peer.kind !== 'channel' || state.channelRolesLoaded.has(peer.id)) return;
      const client = yield* getClient;
      const result = yield* client
        .invoke(
          Api.channels.GetParticipants({
            channel: inputChannel(peer),
            filter: Api.ChannelParticipantsAdmins(),
            offset: 0,
            limit: 200,
            hash: 0n,
          }),
        )
        .pipe(Effect.result);
      if (Result.isSuccess(result) && Api.channels.ChannelParticipants.is(result.success)) {
        rememberEntities(result.success.users, result.success.chats);
        for (const participant of result.success.participants) {
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
        yield* fetchVisibleChannelSenderRoles(peer, senderIds, client);
      }
      state.channelRolesLoaded.add(peer.id);
    },
  );
  const fetchVisibleChannelSenderRoles = Effect.fn(
    'WebTelegramTransport.fetchVisibleChannelSenderRoles',
  )(function* (peer: TelegramPeer, senderIds: readonly string[], client: MtprotoClient) {
    const userIds = [...new Set(senderIds.filter((senderId) => senderId.startsWith('u:')))].slice(
      0,
      20,
    );
    const results = yield* Effect.all(
      userIds.map((senderId) =>
        client
          .invoke(
            Api.channels.GetParticipant({
              channel: inputChannel(peer),
              participant: toInputPeer({ id: senderId, kind: 'user' }),
            }),
          )
          .pipe(Effect.result),
      ),
      { concurrency: 4 },
    );
    results.forEach((result, index) => {
      if (!Result.isSuccess(result) || !Api.channels.ChannelParticipant.is(result.success)) return;
      rememberEntities(result.success.users, result.success.chats);
      const participant = result.success.participant;
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
  });
  function peerColor(peerId: string, entity?: Tl.TypeUser | Tl.TypeChat) {
    const color = entity && 'color' in entity ? entity.color : undefined;
    if (Api.PeerColorCollectible.is(color)) {
      const value = color.darkAccentColor ?? color.accentColor;
      return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
    }
    return telegramPeerColor(peerId, Api.PeerColor.is(color) ? color.color : undefined);
  }
  return {
    connect,
    disconnect: () => disconnect,
    logOut: () => logOut,
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
    updates: Stream.fromPubSub(updateHub),
  } satisfies TelegramTransport;
});
