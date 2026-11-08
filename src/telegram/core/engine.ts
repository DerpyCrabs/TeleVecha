import type { SavedDialogsOffset } from '../savedMessages';
import type { AdminLogRequest } from '../adminLog';
import type {
  CreateChatRequest,
  JoinRequestOffset,
  ChatInviteLinkDraft,
  ChatSettingChange,
  ChatParticipantFilter,
  ChatParticipantChange,
  ChatInviteLinksOffset,
} from '../chatManagement';
import { forumDraftKey } from '../forums';
import type { TransportMutationResult } from '../types';
import type { TelegramForumEdit, TelegramForumOffset } from '../forums';
import type { TelegramChatFolder } from '../chatFolders';
import type { TelegramSearchFilters } from '../types';
import type { TelegramWebAppRequest } from '../types';
import type { TelegramPrivacyKey, TelegramPrivacyChange } from '../types';
import type { TelegramReadReceipts } from '../types';
import { pollDraftError } from '../../domain/poll';
import type { TelegramPollDraft } from '../types';
import { mergePollResults, pollHasVote, pollIsClosed } from '../../domain/poll';
import type { TelegramPollAction } from '../types';
import { createMtprotoError } from '../mtproto/errors';
import type { TelegramContact } from '../types';
import type { TelegramForwardOptions } from '../types';
import { SecureRandom } from 'effect/crypto';
import { Deferred, Effect, Exit, Layer, Schedule, Scope, Stream } from 'effect';

import { reportDiagnostic } from './diagnostics';
import {
  canSendMediaKindToPermissions,
  canSendMessageToDialog,
  deleteDialogOptions,
  messageCapabilities,
  permissionsForDialog,
} from './chatPermissions';
import { withOperationDeadline } from './effectOperation';
import { makeCoalescingMailbox } from './coalescingMailbox';
import type { CoalescingMailbox } from './coalescingMailbox';
import { reconcileDialogPage, reconcileFetchedDialog } from './dialogReconciliation';
import { AccountState, AccountStateLayer } from './engineState';
import { EngineTasks, EngineTasksLayer, type EngineSerialLane } from './engineTasks';
import { createMessageRevisions } from './messageRevisions';
import { telegramMediaAssetKey } from './mediaAssetKey';
import { pendingMediaForMessage } from '../pendingMedia';
import { canReuseUploadedMedia } from '../localMedia';
import {
  parseChatAppearanceCache,
  parseStickerListCache,
  parseStickerPacksCache,
} from './metadataCache';
import { makePeerMetadata, type PeerMetadata } from './peerMetadata';
import { makePendingSendQueue } from './pendingQueue';
import type { PendingSendQueue } from './pendingQueue';
import { createPeerHistories } from './peerHistories';
import { makeResourceCache, type ResourceCache } from './resourceCache';
import { makeVersionIndex } from './versionIndex';
import type { CacheStore } from '../persistence/store';
import {
  acquireSingleTabLease,
  isTabLockUnsupportedError,
  type TabLease,
} from '../session/tabLock';
import type {
  CachedDialog,
  CachedMessage,
  AccountSnapshot,
  ConversationViewSnapshot,
  EditMediaOptions,
  OutgoingAttachmentMode,
  OutgoingAttachment,
  PendingSend,
  SharedMediaCounts,
  SharedMediaKind,
  TelegramBotCommand,
  TelegramChatAppearance,
  TelegramCredentials,
  TelegramChatPermissions,
  TelegramConversationEvent,
  TelegramDeleteDialogAction,
  TelegramDialog,
  TelegramDraftDetails,
  TelegramHistoryGap,
  TelegramActivityKind,
  TelegramGroupMember,
  TelegramGroupMemberPage,
  TelegramMessage,
  TelegramPeer,
  TelegramPeerSearchResult,
  TelegramReaction,
  TelegramResourceInvalidation,
  TelegramReplyTarget,
  TelegramSearchOffset,
  TelegramSearchPage,
  TelegramSticker,
  TelegramStickerPack,
  TelegramTextFormat,
  TelegramTransport,
  TelegramTransportError,
  TelegramUserDetails,
  TelegramUrlAuthAcceptOptions,
  TelegramWallpaper,
  TransportUpdateBatch,
  TransportUpdate,
} from '../types';

const GLOBAL_DIFFERENCE_LIMIT = 100;
const CHANNEL_DIFFERENCE_LIMIT = 500;
const DIALOG_PAGE_LIMIT = 100;
const HISTORY_LIMIT = 50;
const LOCAL_OPERATION_TIMEOUT_MS = 10_000;
const TELEGRAM_OPERATION_TIMEOUT_MS = 15_000;
const MESSAGE_DELIVERY_TIMEOUT_MS = 30_000;
const MEDIA_DELIVERY_TIMEOUT_MS = 5 * 60_000;
const SHARED_MEDIA_COUNT_TIMEOUT_MS = 5_000;
const SHARED_MEDIA_COUNT_RETRY_DELAY_MS = 1_000;
const MAX_ALBUM_ATTACHMENTS = 10;
const MAX_MESSAGE_TEXT_LENGTH = 4_096;
const MAX_CAPTION_TEXT_LENGTH = 1_024;
const EXPRESSION_INDEX_CACHE_KEYS = [
  'sticker-index:recent:v2',
  'sticker-index:favorites:v1',
  'sticker-index:packs:v2',
  'sticker-index:gifs:v2',
];

const PEER_METADATA_CACHE_TTL_MS = 5 * 60 * 1_000;

type Listener = (snapshot: AccountSnapshot) => void;
type ResourceListener = (event: TelegramResourceInvalidation) => void;
type ConversationListener = (event: TelegramConversationEvent) => void;
type TelegramSendPermission = keyof Pick<
  TelegramChatPermissions,
  'canSendMessages' | 'canSendMedia' | 'canSendStickers' | 'canSendGifs'
>;

function isChannelPeerId(peerId: string) {
  return peerId.startsWith('c:') || peerId.startsWith('channel:');
}

function isStickerFile(file: Pick<File, 'name' | 'type'>, sendAs: OutgoingAttachmentMode) {
  return (
    sendAs === 'media' &&
    (file.type === 'image/webp' ||
      file.type === 'application/x-tgsticker' ||
      file.name.toLocaleLowerCase().endsWith('.tgs'))
  );
}

function isGifFile(file: Pick<File, 'name' | 'type'>, sendAs: OutgoingAttachmentMode) {
  return (
    sendAs === 'media' &&
    (file.type.toLocaleLowerCase() === 'image/gif' ||
      file.name.toLocaleLowerCase().endsWith('.gif'))
  );
}

function isGifSticker(sticker: TelegramSticker) {
  return sticker.emoji === 'GIF' || sticker.mimeType.toLocaleLowerCase() === 'image/gif';
}

function makeMessagingEngineModule(
  transport: TelegramTransport,
  store: CacheStore,
  state: AccountState,
  tasks: EngineTasks,
  commandReady: Deferred.Deferred<void, Error>,
  accountReady: Deferred.Deferred<void, Error>,
  pendingQueue: PendingSendQueue,
  inboxReads: CoalescingMailbox<number>,
  options: { manageTabLease?: boolean } = {},
  rootScope: Scope.Scope,
  resources: ResourceCache,
  crypto: SecureRandom.SecureRandom['Service'],
) {
  let telegramTransport = transport;
  let cacheStore = store;
  let accountState = state;
  let engineTasks = tasks;
  let engineOptions = options;
  let commandReadySignal: Deferred.Deferred<void, Error> = commandReady;
  let accountReadySignal: Deferred.Deferred<void, Error> = accountReady;
  let tabLease: TabLease | undefined;
  let sessionScope: Scope.Closeable | undefined;
  let qrScope: Scope.Closeable | undefined;
  let quiescing = false;
  let currentCacheEpoch = 0;
  let resourceCache = resources;
  let versions = makeVersionIndex();
  const randomUuid = () =>
    crypto
      .uuidV4()
      .pipe(
        Effect.catchDefect((cause) =>
          Effect.fail(new Error('Could not generate a pending send identifier.', { cause })),
        ),
      );
  const randomId = Effect.fn('MessagingEngine.randomId')(function* () {
    const bytes = yield* crypto
      .randomBytes(8)
      .pipe(
        Effect.catchDefect((cause) =>
          Effect.fail(new Error('Could not generate a Telegram random ID.', { cause })),
        ),
      );
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return BigInt.asIntN(64, value).toString();
  });
  let pinnedMessageCache: PeerMetadata<TelegramMessage[]> = makePeerMetadata(
    'pinned-messages',
    resourceCache,
    {
      load: (peerId) =>
        runLocalOperation(
          () => cacheStore.loadPinnedMessages(peerId),
          'Loading cached pinned messages',
        ),
      save: (peerId, messages) =>
        runLocalOperation(
          () => cacheStore.savePinnedMessages(peerId, messages),
          'Caching pinned messages',
        ),
      remove: (peerId) =>
        runLocalOperation(
          () => cacheStore.deletePinnedMessages(peerId),
          'Invalidating cached pinned messages',
        ),
      onFailure: (operation, error) =>
        reportFailure('cache', `Could not ${operation} pinned messages.`, error),
    },
  );
  let groupMemberCache: PeerMetadata<TelegramGroupMember[]> = makePeerMetadata(
    'group-members',
    resourceCache,
    {
      load: (peerId) =>
        runLocalOperation(
          () => cacheStore.loadGroupMembers(peerId),
          'Loading cached group members',
        ),
      save: (peerId, members) =>
        runLocalOperation(
          () => cacheStore.saveGroupMembers(peerId, members),
          'Caching group members',
        ),
      remove: (peerId) =>
        runLocalOperation(
          () => cacheStore.deleteGroupMembers(peerId),
          'Invalidating cached group members',
        ),
      onFailure: (operation, error) =>
        reportFailure('cache', `Could not ${operation} group members.`, error),
    },
  );
  const groupMemberPages = new Map<string, Omit<TelegramGroupMemberPage, 'members'>>();
  let histories = createPeerHistories();
  let messageRevisions = createMessageRevisions();
  const assignedMessageRandomIds = new Map<string, string>();
  let inboxReadMailbox: CoalescingMailbox<number> = inboxReads;
  const inboxReadInFlight = new Set<string>();
  let sendQueue: PendingSendQueue = pendingQueue;
  let activeCredentials: TelegramCredentials | undefined;
  let activeAccountId: string | undefined;
  let cachedAccountId: string | undefined;
  let mayClaimLegacyAccount = true;
  let hasReachedReady = false;
  let metadataGeneration = 0;
  let updateSubscriptionSession: Scope.Closeable | undefined;
  let operationErrorArea: 'auth' | 'sync' | 'transport' | 'cache' | 'outbox' | undefined;
  function snapshot() {
    return accountState.snapshotUnsafe();
  }
  function currentSnapshot() {
    return snapshot();
  }
  function dialogForPeer(peerId: string) {
    return currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
  }
  function requirePeerPermission(
    peer: TelegramPeer,
    permission: TelegramSendPermission,
    action: string,
  ) {
    const dialog = dialogForPeer(peer.id);
    return (!dialog && peer.kind === 'user') || (dialog && permissionsForDialog(dialog)[permission])
      ? Effect.void
      : Effect.fail(new Error(`${action} is not available in ${dialog?.title ?? 'this chat'}.`));
  }
  function canDeliverToDialog(dialog: TelegramDialog, pending: PendingSend) {
    const permissions = permissionsForDialog(dialog);
    if (!permissions.canSendMessages) return false;
    if (pending.sticker) {
      return isGifSticker(pending.sticker) ? permissions.canSendGifs : permissions.canSendStickers;
    }
    const attachments = pending.attachment
      ? [pending.attachment]
      : (pending.album?.attachments ?? []);
    if (attachments.length > 0) {
      return attachments.every((attachment) =>
        attachment.asSticker
          ? permissions.canSendStickers
          : isGifFile({ name: attachment.name, type: attachment.mimeType }, attachment.sendAs)
            ? permissions.canSendGifs
            : permissions.canSendMedia,
      );
    }
    const source = pending.forward
      ? histories
          .loaded(pending.forward.fromPeer.id)
          ?.messages.find(({ id }) => id === pending.forward?.messageId)
      : undefined;
    if (pending.forward && !source && pending.forward.mediaKind === undefined) return false;
    return canSendMediaKindToPermissions(
      permissions,
      source?.media?.kind ?? pending.forward?.mediaKind,
    );
  }
  function clearOperationError() {
    operationErrorArea = undefined;
    return patch({ operationError: undefined });
  }
  const setActiveConversationVisibility = Effect.fn(
    'MessagingEngine.setActiveConversationVisibility',
  )(function* (peerId: string | undefined, state: { visible: boolean; atBottom: boolean }) {
    if (!peerId || !state.visible || !state.atBottom) return;
    const account = currentSnapshot();
    if (account.phase !== 'ready' || account.sync !== 'current') return;
    const dialog = account.dialogs.find(({ peer }) => peer.id === peerId);
    if (dialog) yield* markRead(dialog, dialog.topMessageId);
  });
  const refreshReadReceipt = Effect.fn('MessagingEngine.refreshReadReceipt')(function* (
    peerId: string,
  ) {
    if (!currentSnapshot().online || !peerId || !telegramTransport.getReadOutboxMaxId) return;
    const session = sessionScope;
    const accountId = activeAccountId;
    return yield* resourceCache.load(`read-receipt:${peerId}`, () => {
      return Effect.gen(function* () {
        const dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
        if (!dialog) return;
        const maxMessageId = yield* runTelegramOperation(
          () => telegramTransport.getReadOutboxMaxId!(dialog.peer),
          `Refreshing read state for ${dialog.title}`,
        );
        if (!isOperationCurrent(session, accountId)) return;
        if (maxMessageId <= dialog.readOutboxMaxId) return;
        yield* enqueueSyntheticUpdates(
          [
            {
              type: 'read-history',
              pts: 0,
              ptsCount: 0,
              peerId,
              maxMessageId,
              direction: 'outbox',
            },
          ],

          session,
          true,
          { accountId },
        );
      });
    });
  });
  const retryMarkRead = Effect.fn('MessagingEngine.retryMarkRead')(function* (peerId: string) {
    if (!peerId) return;
    if (!currentSnapshot().online) yield* retrySync();
    const dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
    if (dialog) yield* markRead(dialog, dialog.topMessageId);
  });
  const refreshUpdates = Effect.fn('MessagingEngine.refreshUpdates')(function* () {
    if (currentSnapshot().phase !== 'ready' || !currentSnapshot().online) return;
    const session = sessionScope;
    yield* engineTasks.runExclusive(
      'refresh-updates',
      runSerialized('update', '', () =>
        isLifecycleCurrent(session) ? reconcileStartup(false, session) : Effect.void,
      ).pipe(
        Effect.catch((error) =>
          isLifecycleCurrent(session)
            ? fail('sync', 'Could not catch up with Telegram updates.', error, false)
            : Effect.void,
        ),
        Effect.ensuring(
          isLifecycleCurrent(session) && currentSnapshot().sync === 'recovering'
            ? patch({ sync: 'stale' })
            : Effect.void,
        ),
      ),
    );
  });
  function subscribe(listener: Listener) {
    return accountState.subscribe(listener);
  }
  function subscribeResources(listener: ResourceListener) {
    return accountState.subscribeResources(listener);
  }
  function subscribeConversationEvents(listener: ConversationListener) {
    return accountState.subscribeConversationEvents(listener);
  }
  function invalidateResource(event: TelegramResourceInvalidation) {
    return accountState.invalidateResource(event);
  }
  function publishConversationEvent(event: TelegramConversationEvent) {
    return accountState.publishConversationEvent(event);
  }
  const start = Effect.fn('MessagingEngine.start')(function* (credentials: TelegramCredentials) {
    yield* engineTasks.awaitOperation('stop');
    yield* engineTasks.runExclusive('connection', prepareSession(credentials));
  });
  const prepareSession = Effect.fn('MessagingEngine.prepareSession')(function* (
    credentials: TelegramCredentials,
  ) {
    activeCredentials = credentials;
    if (currentSnapshot().phase === 'unauthorized') return;
    if (currentSnapshot().phase === 'ready' && currentSnapshot().online) return;
    if (currentSnapshot().phase === 'ready' && !currentSnapshot().online) {
      yield* retrySession();
      return;
    }

    quiescing = false;
    commandReadySignal = yield* Deferred.make<void, Error>();
    accountReadySignal = yield* Deferred.make<void, Error>();
    if (sessionScope) yield* Scope.close(sessionScope, Exit.void);
    tabLease = undefined;
    const session = yield* Scope.fork(rootScope, 'parallel');
    sessionScope = session;
    metadataGeneration += 1;
    const starting = trackLifecycleTask(() => startSession(credentials, session));
    yield* starting.pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (!(yield* Deferred.isDone(commandReadySignal))) {
            yield* Deferred.fail(
              commandReadySignal,

              new Error('The local messaging workspace could not be prepared.'),
            );
          }
          if (
            currentSnapshot().authStep === undefined &&
            !(yield* Deferred.isDone(accountReadySignal))
          ) {
            yield* Deferred.fail(
              accountReadySignal,

              new Error('Telegram is not connected for account changes.'),
            );
          }
        }),
      ),
    );
  });
  function whenCommandReady() {
    return Deferred.await(commandReadySignal);
  }
  function whenAccountReady() {
    return Deferred.await(accountReadySignal);
  }
  const renewAccountReady = Effect.fn('MessagingEngine.renewAccountReady')(function* () {
    if (yield* Deferred.isDone(accountReadySignal)) {
      accountReadySignal = yield* Deferred.make<void, Error>();
    }
  });
  const failAccountReady = Effect.fn('MessagingEngine.failAccountReady')(function* (error: Error) {
    yield* renewAccountReady();
    yield* Deferred.fail(accountReadySignal, error);
  });
  const ensureTabLease = Effect.fn('MessagingEngine.ensureTabLease')(function* (
    session: Scope.Closeable,
  ) {
    if (engineOptions.manageTabLease === false || tabLease) return true;
    return yield* Effect.gen(function* () {
      const lease = yield* acquireSingleTabLease();
      if (!isLifecycleCurrent(session)) {
        if (lease) yield* lease.release;
        return false;
      }
      if (!lease) {
        yield* patch({
          phase: 'error',
          sync: 'stale',
          online: false,
          error: 'TeleVecha is already open in another tab.',
        });
        return false;
      }
      tabLease = lease;
      yield* Scope.addFinalizer(session, lease.release);
      return true;
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!isLifecycleCurrent(session)) return false;
          yield* patch({
            phase: 'error',
            sync: 'stale',
            online: false,
            error: isTabLockUnsupportedError(error)
              ? error.message
              : `Could not acquire the single-tab lock. ${errorMessage(error)}`,
          });
          return false;
        }),
      ),
    );
  });
  const startSession = Effect.fn('MessagingEngine.startSession')(function* (
    credentials: TelegramCredentials,
    session: Scope.Closeable,
  ) {
    if (!(yield* ensureTabLease(session))) return;

    yield* patch({ phase: 'connecting', error: undefined });
    yield* Effect.gen(function* () {
      const { dialogs, drafts, draftDetails, draftRevisions, pending, epoch, accountId } =
        yield* runLocalOperation(
          () => cacheStore.loadWorkspace(),
          'Loading the local messaging workspace',
        );
      if (!isLifecycleCurrent(session)) return;
      cachedAccountId = accountId;
      currentCacheEpoch = epoch;
      versions.clear('draft');
      for (const peerId of Object.keys(drafts)) {
        versions.set('draft', peerId, draftRevisions[peerId] ?? 0);
      }
      const compatibleDialogs = dialogs
        .filter((dialog) => !dialog.transient)
        .map((dialog) => ({
          ...dialog,
          readInboxMaxId: dialog.readInboxMaxId ?? 0,
          readOutboxMaxId: dialog.readOutboxMaxId ?? 0,
          archived: dialog.archived ?? false,
          hasAvatar: dialog.hasAvatar ?? false,
          avatarId: dialog.avatarId,
        }));
      const compatiblePending = pending.filter(
        (send) => !accountId || !send.accountId || send.accountId === accountId,
      );
      const orderedPending = yield* sendQueue.restore(compatiblePending);
      if (!isLifecycleCurrent(session)) return;
      yield* patch({
        dialogs: sortDialogs(compatibleDialogs),
        drafts,
        draftDetails,
        pending: orderedPending,
      });
      yield* Deferred.succeed(commandReadySignal, undefined);
      yield* connectWithDeadline(credentials);
      if (!isLifecycleCurrent(session)) return;
      if (
        !(yield* runTelegramOperation(
          () => telegramTransport.isAuthorized(),
          'Checking the Telegram session',
        ))
      ) {
        if (!isLifecycleCurrent(session)) return;
        mayClaimLegacyAccount = false;
        yield* patch({ phase: 'unauthorized', online: false, authStep: 'phone' });
        return;
      }
      yield* activateAuthorizedSession(mayClaimLegacyAccount, session);
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!isLifecycleCurrent(session)) return;
          yield* renewAccountReady();
          if (currentSnapshot().online) {
            yield* disconnectTransport();
            yield* patch({ online: false });
          }
          if (currentSnapshot().dialogs.length > 0) {
            hasReachedReady = true;
            yield* patch({
              phase: 'ready',
              sync: 'stale',
              online: false,
              error: `Could not connect to Telegram. ${errorMessage(error)}`,
            });
            yield* scheduleReconnect();
          } else {
            yield* fail('transport', 'Could not start TeleVecha.', error);
          }
        }),
      ),
    );
  });
  const retrySync = Effect.fn('MessagingEngine.retrySync')(function* () {
    yield* engineTasks.awaitOperation('stop');
    yield* engineTasks.runExclusive('connection', retrySession());
  });
  const retrySession = Effect.fn('MessagingEngine.retrySession')(function* () {
    if (currentSnapshot().phase === 'idle' || currentSnapshot().phase === 'unauthorized') return;
    if (currentSnapshot().phase === 'ready' && currentSnapshot().online) return;
    const credentials = activeCredentials;
    if (!credentials) return;
    yield* renewAccountReady();
    const session = sessionScope;
    if (!session) return;
    const retry = trackLifecycleTask(() => {
      return Effect.gen(function* () {
        if (!(yield* ensureTabLease(session))) return;
        yield* patch({ sync: 'recovering', error: undefined });
        yield* Effect.gen(function* () {
          yield* connectWithDeadline(credentials);
          if (!isLifecycleCurrent(session)) return;
          if (
            !(yield* runTelegramOperation(
              () => telegramTransport.isAuthorized(),
              'Checking the Telegram session',
            ))
          ) {
            if (!isLifecycleCurrent(session)) return;
            mayClaimLegacyAccount = false;
            yield* patch({ phase: 'unauthorized', online: false, authStep: 'phone' });
            return;
          }
          if (!isLifecycleCurrent(session)) return;
          yield* activateAuthorizedSession(mayClaimLegacyAccount, session);
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (!isLifecycleCurrent(session)) return;
              yield* renewAccountReady();
              yield* disconnectTransport().pipe(Effect.ignore);
              yield* patch({ online: false });
              if (currentSnapshot().dialogs.length > 0 || hasReachedReady) {
                yield* patch({
                  phase: 'ready',
                  sync: 'stale',
                  online: false,
                  error: `Could not reconnect to Telegram. ${errorMessage(error)}`,
                });
              } else {
                yield* fail('transport', 'Could not reconnect to Telegram.', error);
              }
            }),
          ),
        );
      });
    });
    yield* retry.pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (
            currentSnapshot().authStep === undefined &&
            !(yield* Deferred.isDone(accountReadySignal))
          ) {
            yield* Deferred.fail(
              accountReadySignal,

              new Error('Telegram is not connected for account changes.'),
            );
          }
        }),
      ),
    );
  });
  function stop() {
    return engineTasks.runExclusive('stop', stopSession());
  }
  const stopSession = Effect.fn('MessagingEngine.stopSession')(function* () {
    quiescing = true;
    const session = sessionScope;
    sessionScope = undefined;
    qrScope = undefined;
    metadataGeneration += 1;
    yield* engineTasks.interruptOperation('connection');
    if (session) yield* Scope.close(session, Exit.void);
    yield* Deferred.fail(commandReadySignal, new Error('The messaging session has stopped.'));
    yield* failAccountReady(new Error('The messaging session has stopped.'));
    for (const peerId of new Set([
      ...currentSnapshot().dialogs.map(({ peer }) => peer.id),
      ...histories.peerIds(),
    ])) {
      histories.invalidate(peerId);
    }
    yield* Effect.all([
      engineTasks.clearDelays(),
      engineTasks.cancelRetry('reconnect'),
      engineTasks.interruptNetwork,
      engineTasks.interruptBackground,
    ]);
    const cleanup = patch({ phase: 'idle', sync: 'stale', online: false, pending: [] }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          tabLease = undefined;
          assignedMessageRandomIds.clear();
          versions.clear();
          yield* resourceCache.clear;
          yield* pinnedMessageCache.clear;
          yield* groupMemberCache.clear;
          groupMemberPages.clear();
          yield* sendQueue.clear;
        }),
      ),
    );

    yield* Effect.gen(function* () {
      yield* patch({ phase: 'idle', sync: 'stale', online: false });
      const disconnect = yield* Effect.exit(disconnectTransport());
      yield* Effect.all([engineTasks.drain, engineTasks.drainSerial()], { discard: true });
      yield* inboxReadMailbox.awaitEmpty;
      yield* Effect.forEach(
        [
          ...resourceCache.pendingWithPrefix('read-receipt:'),
          ...resourceCache.pendingWithPrefix('channel-recovery:'),
        ],
        (pending) => pending.pipe(Effect.result),
        { concurrency: 'unbounded', discard: true },
      );
      if (Exit.isFailure(disconnect)) return yield* Effect.failCause(disconnect.cause);
    }).pipe(Effect.ensuring(cleanup));
  });
  const loadConversationView = Effect.fn('MessagingEngine.loadConversationView')(function* (
    peerId: string,
  ): Effect.fn.Return<ConversationViewSnapshot, unknown> {
    return yield* tryLoadConversationView(peerId).pipe(
      Effect.repeat({ while: (view) => view === undefined, schedule: Schedule.recurs(2) }),
      Effect.map((view) => view ?? projectConversationView(peerId)),
    );
  });
  const tryLoadConversationView = Effect.fn('MessagingEngine.tryLoadConversationView')(function* (
    peerId: string,
  ) {
    const session = sessionScope;
    const accountId = activeAccountId ?? cachedAccountId;
    const dialog = currentSnapshot().dialogs.find((candidate) => candidate.peer.id === peerId);
    if (!dialog) {
      return yield* Effect.fail(new Error('The requested conversation is no longer available.'));
    }
    const loaded = histories.loaded(peerId);

    if (loaded) {
      touchHistory(peerId);
      yield* scheduleCachedHistoryRepair(dialog, loaded.messages);
      return projectConversationView(peerId);
    }

    const historyVersion = histories.version(peerId);
    const requestedCacheEpoch = currentCacheEpoch;
    let cached: CachedMessage[] = [];
    yield* Effect.gen(function* () {
      cached = (yield* cacheStore.loadMessages(peerId, HISTORY_LIMIT)).filter(
        (message) => message.cacheEpoch === requestedCacheEpoch,
      );
    }).pipe(
      Effect.catch((error) =>
        isPendingOperationCurrent(session, accountId)
          ? reportFailure('cache', `Could not load cached messages for ${dialog.title}.`, error)
          : Effect.void,
      ),
    );
    if (!isPendingOperationCurrent(session, accountId)) return projectConversationView(peerId);
    if (requestedCacheEpoch !== currentCacheEpoch || histories.version(peerId) !== historyVersion) {
      return undefined;
    }
    if (cached.length > 0) {
      const messages = sortMessages(cached);
      const oldestId = messages[0]?.id;
      if (oldestId !== undefined) histories.setOffset(peerId, oldestId);
      rememberHistory(peerId, { messages, hasOlderMessages: true }, 'newest');
      yield* scheduleCachedHistoryRepair(dialog, messages);
      return projectConversationView(peerId);
    }

    if (!currentSnapshot().online) {
      const message = 'Message history is unavailable while Telegram is offline.';
      histories.setIssue(peerId, { message });
      return projectConversationView(peerId);
    }

    const previousFailure = histories.failure(peerId);
    if (previousFailure && Date.now() < previousFailure.retryAt) {
      if (!histories.issue(peerId)) {
        histories.setIssue(peerId, {
          message: `Could not load ${dialog.title}. Retry after the current backoff expires.`,
          retryAt: previousFailure.retryAt,
        });
      }
      return projectConversationView(peerId);
    }

    const requestRevision = messageRevisions.capture();
    const applied = yield* Effect.gen(function* () {
      const page = yield* runTelegramOperation(
        () => telegramTransport.getHistory(dialog.peer, HISTORY_LIMIT, undefined),
        `Loading ${dialog.title}`,
      );
      return yield* queueDialogStateOperation(() => {
        return Effect.gen(function* () {
          if (!isHistoryOperationCurrent(peerId, historyVersion, session, accountId)) {
            return false;
          }
          const messages = page.messages.map((message) => ({
            ...message,
            cacheEpoch: requestedCacheEpoch,
          }));
          const fetched = messageRevisions.filter(peerId, messages, requestRevision);
          yield* cacheStore.putMessages(fetched);
          if (!isHistoryOperationCurrent(peerId, historyVersion, session, accountId)) {
            return false;
          }
          const loaded = histories.loaded(peerId)?.messages ?? [];
          const current = sortMessages([
            ...new Map(loaded.map((message) => [message.id, message])).values(),
          ]);
          const sortedMessages = messageRevisions.merge(peerId, current, fetched, requestRevision);
          if (page.channelPts !== undefined) {
            yield* patchChannelPts(peerId, page.channelPts);
          }
          if (page.nextBeforeMessageId !== undefined) {
            histories.setOffset(peerId, page.nextBeforeMessageId);
          } else {
            const oldestId = sortedMessages[0]?.id;
            if (oldestId !== undefined) histories.setOffset(peerId, oldestId);
          }
          rememberHistory(
            peerId,
            { messages: sortedMessages, hasOlderMessages: page.hasOlder },
            'newest',
          );
          clearHistoryFailure(peerId);
          return true;
        });
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (isPendingOperationCurrent(session, accountId)) {
            const failure = recordHistoryFailure(peerId);
            const message = `Could not load ${dialog.title}. ${errorMessage(error)}`;
            histories.setIssue(peerId, { message, retryAt: failure.retryAt });
            yield* reportFailure('sync', `Could not load ${dialog.title}.`, error);
          }
          return undefined;
        }),
      ),
    );
    if (applied === false && isPendingOperationCurrent(session, accountId)) return undefined;
    return projectConversationView(peerId);
  });
  function emptyConversationView(peerId: string): ConversationViewSnapshot {
    return {
      activePeerId: peerId,
      messages: [],
      loadingMessages: false,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      sharedMediaCounts: undefined,
      pinnedMessages: [],
      historyGaps: [],
      historyError: undefined,
      historyRetryAt: undefined,
    };
  }
  function projectConversationView(peerId: string): ConversationViewSnapshot {
    const history = histories.loaded(peerId);
    const messages = history?.messages ?? [];
    const issue = histories.issue(peerId);
    return {
      ...emptyConversationView(peerId),
      messages,
      hasOlderMessages: Boolean(history?.hasOlderMessages),
      pinnedMessages: pinnedMessageCache.current(peerId)?.value ?? [],
      historyGaps: histories.gaps(peerId),
      historyError: issue?.message,
      historyRetryAt: issue?.retryAt,
    };
  }
  const readMetadata = Effect.fn('MessagingEngine.readMetadata')(function* <Value>(key: string) {
    return yield* runLocalOperation(
      () => cacheStore.loadMetadata<Value>(key),
      `Loading cached metadata ${key}`,
    );
  });
  const writeMetadata = Effect.fn('MessagingEngine.writeMetadata')(function* <Value>(
    key: string,
    value: Value,
  ) {
    yield* queueMetadataWrite(() =>
      runLocalOperation(() => cacheStore.saveMetadata(key, value), `Caching metadata ${key}`),
    );
  });
  function metadataIsFresh(savedAt: number, ttlMs: number = PEER_METADATA_CACHE_TTL_MS) {
    return Date.now() - savedAt < ttlMs;
  }
  function queryMetadataKey(
    namespace: string,
    parts: readonly (string | number | boolean | undefined)[],
  ) {
    return `${namespace}:${JSON.stringify(parts)}`;
  }
  const refreshSharedMediaCounts = Effect.fn('MessagingEngine.refreshSharedMediaCounts')(function* (
    dialog: TelegramDialog,
    cacheKey: string,
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    if (!currentSnapshot().online || !accountId) return undefined;
    const counts = yield* getSharedMediaCountsWithDeadline(dialog.peer).pipe(
      Effect.retry({ times: 1, schedule: Schedule.spaced(SHARED_MEDIA_COUNT_RETRY_DELAY_MS) }),
    );
    if (!isOperationCurrent(session, accountId)) return undefined;
    yield* writeMetadata(cacheKey, counts);
    return counts;
  });
  const loadConversationSharedMediaCounts = Effect.fn(
    'MessagingEngine.loadConversationSharedMediaCounts',
  )(function* (peerId: string) {
    const dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
    if (!dialog) return undefined;
    const cacheKey = `shared-media-counts:${peerId}`;
    const cached = yield* readMetadata<SharedMediaCounts>(cacheKey);
    if (cached) {
      if (!metadataIsFresh(cached.savedAt) && currentSnapshot().online) {
        yield* forkBackgroundTask(() =>
          resourceCache
            .load(`shared-media-counts:${peerId}`, () => refreshSharedMediaCounts(dialog, cacheKey))
            .pipe(Effect.ignore),
        );
      }
      return cached.value;
    }
    if (!currentSnapshot().online || !activeAccountId) return undefined;
    return yield* resourceCache.load(`shared-media-counts:${peerId}`, () =>
      refreshSharedMediaCounts(dialog, cacheKey).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (currentSnapshot().online) {
              yield* reportFailure(
                'sync',
                `Could not load shared-media counts for ${dialog.title}.`,
                error,
              );
            }
            return undefined;
          }),
        ),
      ),
    );
  });
  const getSharedMediaCountsWithDeadline = Effect.fn(
    'MessagingEngine.getSharedMediaCountsWithDeadline',
  )(function* (peer: TelegramPeer) {
    return yield* runTransportWithDeadline(
      () => telegramTransport.getSharedMediaCounts(peer),
      SHARED_MEDIA_COUNT_TIMEOUT_MS,
      'Shared-media counts timed out after 5 seconds.',
      'shared-media-counts',
    );
  });
  const loadConversationPinnedMessages = Effect.fn(
    'MessagingEngine.loadConversationPinnedMessages',
  )(function* (peerId: string) {
    const dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
    if (!dialog) return [];
    return yield* loadPinnedMessages(dialog);
  });
  function loadPinnedMessages(dialog: TelegramDialog) {
    return pinnedMessageCache.request(dialog.peer.id, (version) =>
      loadPinnedMessagesFromCacheAndTelegram(dialog, version),
    );
  }
  const loadPinnedMessagesFromCacheAndTelegram = Effect.fn(
    'MessagingEngine.loadPinnedMessagesFromCacheAndTelegram',
  )(function* (dialog: TelegramDialog, version: number) {
    const session = sessionScope;
    const accountId = activeAccountId ?? cachedAccountId;
    const cached = yield* cachedPinnedMessages(dialog.peer.id);
    if (
      cached &&
      isPendingOperationCurrent(session, accountId) &&
      pinnedMessageCache.version(dialog.peer.id) === version
    ) {
      yield* publishPinnedMessages(dialog.peer.id, cached.value);
    }
    if (
      pinnedMessageCache.isFresh(dialog.peer.id, PEER_METADATA_CACHE_TTL_MS) ||
      !pinnedMessageCache.canRefresh(dialog.peer.id) ||
      !currentSnapshot().online
    ) {
      return cached?.value ?? [];
    }
    const loaded = yield* Effect.gen(function* () {
      const messages = yield* runTelegramOperation(
        () => telegramTransport.getPinnedMessages(dialog.peer),
        `Loading pinned messages for ${dialog.title}`,
      );
      if (
        isOperationCurrent(session, accountId) &&
        pinnedMessageCache.version(dialog.peer.id) === version
      ) {
        yield* rememberPinnedMessages(dialog.peer.id, messages);
        return messages;
      }
      return undefined;
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (
            isOperationCurrent(session, accountId) &&
            pinnedMessageCache.version(dialog.peer.id) === version
          ) {
            pinnedMessageCache.deferRefresh(dialog.peer.id);
            yield* reportFailure(
              'sync',
              `Could not load pinned messages for ${dialog.title}.`,
              error,
            );
          }
          return undefined;
        }),
      ),
    );
    if (loaded !== undefined) return loaded;
    return pinnedMessageCache.current(dialog.peer.id)?.value ?? cached?.value ?? [];
  });
  function cacheSearchMessages(page: TelegramSearchPage) {
    if (page.messages.length === 0) return Effect.void;
    return cacheStore
      .putMessages(page.messages.map((message) => ({ ...message, cacheEpoch: currentCacheEpoch })))
      .pipe(
        Effect.catch((error) =>
          reportFailure('cache', 'Could not cache Telegram search results.', error),
        ),
      );
  }
  const getConversationSharedMedia = Effect.fn('MessagingEngine.getConversationSharedMedia')(
    function* (peer: TelegramPeer, kind: SharedMediaKind, offset?: TelegramSearchOffset) {
      const cacheKey = queryMetadataKey('shared-media', [
        peer.id,
        kind,
        offset?.messageId,
        offset?.peer?.id,
        offset?.rate,
      ]);
      const cached = yield* readMetadata<TelegramSearchPage>(cacheKey);
      if (cached && !currentSnapshot().online) {
        return cached.value;
      }
      if (!currentSnapshot().online || !activeAccountId) {
        return cached?.value ?? { messages: [], hasMore: false };
      }
      const page = yield* runTelegramOperation(
        () => telegramTransport.getSharedMedia(peer, kind, 100, offset),
        'Loading shared media',
      );
      yield* Effect.all(
        [
          page.channelPts === undefined ? Effect.void : setChannelPts(peer.id, page.channelPts),
          cacheSearchMessages(page),
          writeMetadata(cacheKey, page),
        ],
        { discard: true },
      );
      return page;
    },
  );
  const getUnreadNotifications = Effect.fn('MessagingEngine.getUnreadNotifications')(function* (
    peer: TelegramPeer,
    kind: 'mention' | 'reaction',
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    if (!telegramTransport.getUnreadNotifications || !currentSnapshot().online)
      return (histories.loaded(peer.id)?.messages ?? []).filter((message) =>
        kind === 'mention' ? message.unreadMention : message.unreadReaction,
      );
    const dialogVersion = versions.current('dialog', peer.id);
    const requestRevision = messageRevisions.capture();
    const result = yield* runTelegramOperation(
      () => telegramTransport.getUnreadNotifications!(peer, kind),
      'Loading unread mentions and reactions',
    );
    if (!isOperationCurrent(session, accountId)) return [];
    const field = kind === 'mention' ? 'unreadMentionsCount' : 'unreadReactionsCount';
    yield* queueDialogStateOperation(() =>
      Effect.gen(function* () {
        if (!isOperationCurrent(session, accountId)) return;
        const dialog = dialogForPeer(peer.id);
        if (!dialog) return;
        if (versions.current('dialog', peer.id) !== dialogVersion) return;
        const changed = { ...dialog, [field]: result.count };
        versions.next('dialog', peer.id);
        yield* patch({
          dialogs: currentSnapshot().dialogs.map((item) =>
            item.peer.id === peer.id ? changed : item,
          ),
        });
        if (!changed.transient)
          yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
      }),
    );
    let reconciled: TelegramMessage[] = [];
    // The target may already be in history with stale unread flags. Reconcile
    // the server result before navigation so visibility can acknowledge it.
    yield* queueDialogStateOperation(() =>
      Effect.gen(function* () {
        if (!isOperationCurrent(session, accountId)) return;
        const fetched = messageRevisions.filter(peer.id, result.messages, requestRevision);
        for (const message of fetched) messageRevisions.record(peer.id, message.id);
        const reconciledRevision = messageRevisions.capture();
        yield* cacheStore.putMessages(
          fetched.map((message) => ({ ...message, cacheEpoch: currentCacheEpoch })),
        );
        if (!isOperationCurrent(session, accountId)) return;
        const accepted = messageRevisions.filter(peer.id, fetched, reconciledRevision);
        reconciled = accepted;
        const byId = new Map(accepted.map((message) => [message.id, message]));
        histories.updateLoaded(peer.id, (history) => ({
          ...history,
          messages: history.messages.map((message) => byId.get(message.id) ?? message),
        }));
        for (const message of accepted)
          yield* publishConversationEvent({ type: 'message-upsert', message });
      }),
    );
    return reconciled;
  });
  const searchConversationMessages = Effect.fn('MessagingEngine.searchConversationMessages')(
    function* (
      peer: TelegramPeer,
      query: string,
      global: boolean,
      offset?: TelegramSearchOffset,
      filters?: TelegramSearchFilters,
    ) {
      const term = query.trim();
      if (
        !term &&
        !filters?.kind &&
        !filters?.fromPeer &&
        !filters?.minDate &&
        !filters?.maxDate &&
        !filters?.chatType &&
        !filters?.savedPeer &&
        !filters?.savedReactions?.length
      )
        return { messages: [], hasMore: false } satisfies TelegramSearchPage;
      const cacheKey = queryMetadataKey('message-search', [
        global ? 'global' : peer.id,
        term.toLocaleLowerCase(),
        offset?.messageId,
        offset?.peer?.id,
        offset?.rate,
        filters?.kind,
        filters?.fromPeer?.id,
        filters?.minDate,
        filters?.maxDate,
        filters?.chatType,
        global ? undefined : filters?.topicId,
        global ? undefined : filters?.savedPeer?.id,
        global
          ? undefined
          : filters?.savedReactions
            ? JSON.stringify([...filters.savedReactions].sort())
            : undefined,
      ]);
      const cached = yield* readMetadata<TelegramSearchPage>(cacheKey);
      if (cached && !currentSnapshot().online) {
        return cached.value;
      }
      if (!currentSnapshot().online || !activeAccountId) {
        return cached?.value ?? { messages: [], hasMore: false };
      }
      const page = yield* runTelegramOperation(
        () =>
          telegramTransport.searchMessages(term, global ? undefined : peer, 50, offset, filters),
        'Searching messages',
      );
      yield* Effect.all(
        [
          page.channelPts === undefined ? Effect.void : setChannelPts(peer.id, page.channelPts),
          cacheSearchMessages(page),
          writeMetadata(cacheKey, page),
        ],
        { discard: true },
      );
      return page;
    },
  );
  const searchPeers = Effect.fn('MessagingEngine.searchPeers')(function* (query: string) {
    const term = query.trim();
    if (!term) return [];
    const cacheKey = queryMetadataKey('peer-search', [term.toLocaleLowerCase()]);
    const cached = yield* readMetadata<TelegramPeerSearchResult[]>(cacheKey);
    if (cached && !currentSnapshot().online) {
      return cached.value;
    }
    if (!currentSnapshot().online || !activeAccountId) return cached?.value ?? [];
    const results = yield* runTelegramOperation(
      () => telegramTransport.searchPeers(term, 50),
      'Searching chats',
    );
    yield* writeMetadata(cacheKey, results);
    return results;
  });
  const resolveUsername = Effect.fn('MessagingEngine.resolveUsername')(function* (
    username: string,
  ) {
    if (!telegramTransport.resolveUsername)
      return yield* Effect.fail(new Error('Opening Telegram links is unavailable.'));
    const result = yield* runTelegramOperation(
      () => telegramTransport.resolveUsername!(username),
      'Opening Telegram link',
    );
    if (!result) return yield* Effect.fail(new Error('This public chat could not be found.'));
    yield* addPeer(result);
    return result.peer;
  });
  const getLinkedMessage = Effect.fn('MessagingEngine.getLinkedMessage')(function* (
    peer: TelegramPeer,
    messageId: number,
  ) {
    if (!telegramTransport.getHistoryAround)
      return yield* Effect.fail(new Error('Opening posts is unavailable.'));
    const page = yield* runTelegramOperation(
      () => telegramTransport.getHistoryAround!(peer, messageId, 3),
      'Opening post',
    );
    const message = page.messages.find((message) => message.id === messageId);
    if (!message) return yield* Effect.fail(new Error('This post was deleted or is unavailable.'));
    return message;
  });
  const getDiscussion = Effect.fn('MessagingEngine.getDiscussion')(function* (
    peerId: string,
    messageId: number,
  ) {
    const peer = currentSnapshot().dialogs.find((dialog) => dialog.peer.id === peerId)?.peer;
    if (!peer || !telegramTransport.getDiscussion)
      return yield* Effect.fail(new Error('Comments are unavailable.'));
    const result = yield* runTelegramOperation(
      () => telegramTransport.getDiscussion!(peer, messageId),
      'Loading comments',
    );
    if (!result)
      return yield* Effect.fail(
        new Error('Comments for this post are unavailable or have been disabled.'),
      );
    return result;
  });
  const getReplies = Effect.fn('MessagingEngine.getReplies')(function* (
    peer: TelegramPeer,
    rootId: number,
    beforeMessageId?: number,
  ) {
    if (!telegramTransport.getReplies)
      return yield* Effect.fail(new Error('Comments are unavailable.'));
    const session = sessionScope,
      accountId = activeAccountId,
      epoch = currentCacheEpoch;
    const page = yield* runTelegramOperation(
      () => telegramTransport.getReplies!(peer, rootId, 50, beforeMessageId),
      'Loading replies',
    );
    if (isOperationCurrent(session, accountId) && epoch === currentCacheEpoch)
      yield* cacheStore
        .putMessages(page.messages.map((message) => ({ ...message, cacheEpoch: epoch })))
        .pipe(Effect.catch((error) => reportFailure('cache', 'Could not cache replies.', error)));
    return page;
  });
  const addPeer = Effect.fn('MessagingEngine.addPeer')(function* (
    result: TelegramPeerSearchResult,
  ) {
    const existing = currentSnapshot().dialogs.find(({ peer }) => peer.id === result.peer.id);
    const dialog: CachedDialog = existing
      ? {
          ...existing,
          peer: result.peer,
          title: result.title,
          initials: result.initials,
          color: result.color,
          username: result.username,
          bot: result.bot,
          hasAvatar: result.hasAvatar,
          avatarId: result.avatarId,
          ...(result.permissions ? { permissions: result.permissions } : {}),
          cacheEpoch: currentCacheEpoch,
        }
      : {
          peer: result.peer,
          transient: true,
          title: result.title,
          initials: result.initials,
          color: result.color,
          username: result.username,
          bot: result.bot,
          archived: false,
          topMessageId: 0,
          unreadCount: 0,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          muted: false,
          pinned: false,
          ...(result.permissions ? { permissions: result.permissions } : {}),
          hasAvatar: result.hasAvatar,
          avatarId: result.avatarId,
          cacheEpoch: currentCacheEpoch,
        };
    versions.next('dialog', result.peer.id);
    yield* patch({
      dialogs: sortDialogs([
        ...currentSnapshot().dialogs.filter(({ peer }) => peer.id !== result.peer.id),
        dialog,
      ]),
    });
  });
  const openMessageInConversationView = Effect.fn('MessagingEngine.openMessageInConversationView')(
    function* (
      message: TelegramMessage,
      currentView: ConversationViewSnapshot = projectConversationView(message.peerId),
    ) {
      const session = sessionScope;
      const accountId = activeAccountId;
      let dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === message.peerId);
      if (!dialog && message.peer) {
        const title = message.peerTitle || message.peer.id;
        yield* addPeer({
          peer: message.peer,
          category:
            message.peer.kind === 'user'
              ? 'user'
              : message.peer.kind === 'channel'
                ? 'channel'
                : 'group',
          title,
          initials: title.slice(0, 2).toUpperCase(),
          color: '#765cff',
          bot: false,
          isContact: false,
          hasAvatar: false,
          ...(message.permissions ? { permissions: message.permissions } : {}),
        });
        dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === message.peerId);
      }
      if (!dialog) return { conversation: currentView, found: false };
      const conversation =
        currentView.activePeerId === message.peerId
          ? currentView
          : yield* loadConversationView(message.peerId);
      if (conversation.messages.some(({ id }) => id === message.id)) {
        // The client view can lag behind a just-fetched notification event.
        // Resolve from the reconciled history instead of returning that stale view.
        const loaded = new Map(
          (histories.loaded(message.peerId)?.messages ?? []).map((item) => [item.id, item]),
        );
        return {
          conversation: {
            ...conversation,
            messages: conversation.messages.map((item) => loaded.get(item.id) ?? item),
          },
          found: true,
        };
      }

      const historyVersion = histories.version(message.peerId);
      const requestRevision = messageRevisions.capture();
      return yield* Effect.gen(function* () {
        const contextPage = yield* runTelegramOperation(
          () =>
            telegramTransport.getHistoryAround
              ? telegramTransport.getHistoryAround(dialog.peer, message.id, HISTORY_LIMIT)
              : telegramTransport
                  .getHistory(dialog.peer, HISTORY_LIMIT, message.id + 1)
                  .pipe(Effect.map(({ messages, channelPts }) => ({ messages, channelPts }))),
          `Opening a message in ${dialog.title}`,
        );
        if (contextPage.channelPts !== undefined) {
          yield* setChannelPts(message.peerId, contextPage.channelPts);
        }
        const context = contextPage.messages;
        if (!isHistoryOperationCurrent(message.peerId, historyVersion, session, accountId)) {
          return { conversation, found: false };
        }
        const resolvedTarget = context.find(({ id }) => id === message.id) ?? message;
        const fetched = messageRevisions.filter(
          message.peerId,
          [...context.filter(({ id }) => id !== message.id), resolvedTarget].map((item) => ({
            ...item,
            cacheEpoch: currentCacheEpoch,
          })),
          requestRevision,
        );
        yield* cacheStore.putMessages(fetched);
        if (!isHistoryOperationCurrent(message.peerId, historyVersion, session, accountId)) {
          return { conversation, found: false };
        }
        const previousMessages = sortMessages([
          ...new Map(
            [...conversation.messages, ...(histories.loaded(message.peerId)?.messages ?? [])].map(
              (current) => [current.id, current],
            ),
          ).values(),
        ]);
        const messages = messageRevisions.merge(
          message.peerId,
          previousMessages,
          fetched,
          requestRevision,
        );
        histories.recordLoadedRange(message.peerId, previousMessages, fetched);
        histories.setAnchor(message.peerId, resolvedTarget.id);
        // Keep the existing newest-window frontier. The around-target window can
        // be far older; replacing the cursor with its oldest ID would make the
        // entire middle gap unreachable by backward pagination.
        const oldestId = messages[0]?.id;
        const history = rememberHistory(
          message.peerId,
          { messages, hasOlderMessages: conversation.hasOlderMessages || (oldestId ?? 1) > 1 },
          'anchor',
        );
        return {
          conversation: {
            ...conversation,
            messages: histories.boundViewMessages(message.peerId, messages, 'anchor'),
            hasOlderMessages: history.hasOlderMessages,
            historyGaps: histories.gaps(message.peerId),
          },
          found: true,
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (isOperationCurrent(session, accountId)) {
              yield* fail(
                'sync',
                `Could not open the selected message in ${dialog.title}.`,
                error,
                false,
              );
            }
            return { conversation, found: false };
          }),
        ),
      );
    },
  );
  const loadHistoryGapConversationView = Effect.fn(
    'MessagingEngine.loadHistoryGapConversationView',
  )(function* (
    peerId: string,
    gap: TelegramHistoryGap,
    currentView: ConversationViewSnapshot = projectConversationView(peerId),
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    if (currentView.loadingOlderMessages) return currentView;
    const dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
    const matchesGap = (candidate: TelegramHistoryGap) =>
      candidate.olderMaxMessageId === gap.olderMaxMessageId &&
      candidate.newerMinMessageId === gap.newerMinMessageId;
    const currentGap = histories.findGap(peerId, gap) ?? currentView.historyGaps.find(matchesGap);
    if (!dialog || !currentGap) return currentView;
    if (!histories.findGap(peerId, currentGap)) {
      histories.setGaps(peerId, [...histories.gaps(peerId), currentGap]);
    }

    // An explicit gap action is a manual retry and bypasses automatic backoff.
    clearHistoryFailure(peerId);
    let view: ConversationViewSnapshot = {
      ...currentView,
      loadingOlderMessages: true,
      historyError: undefined,
      historyRetryAt: undefined,
    };
    if (!currentSnapshot().online) {
      const message = 'Messages in this gap are unavailable while Telegram is offline.';
      histories.setIssue(peerId, { message, gap: currentGap });
      return { ...view, loadingOlderMessages: false, historyError: message };
    }

    const historyVersion = histories.version(peerId);
    const requestRevision = messageRevisions.capture();
    yield* Effect.gen(function* () {
      const page = yield* runTelegramOperation(
        () =>
          telegramTransport.getHistory(dialog.peer, HISTORY_LIMIT, currentGap.newerMinMessageId),
        `Loading messages in ${dialog.title}`,
      );
      if (page.messages.length === 0 && page.hasOlder) {
        return yield* Effect.fail(
          new Error('Telegram returned no progress while loading this message gap.'),
        );
      }
      if (!isHistoryOperationCurrent(peerId, historyVersion, session, accountId)) return;
      const fetched = messageRevisions.filter(
        peerId,
        page.messages.map((item) => ({ ...item, cacheEpoch: currentCacheEpoch })),
        requestRevision,
      );
      yield* cacheStore.putMessages(fetched);
      if (!isHistoryOperationCurrent(peerId, historyVersion, session, accountId)) return;
      const messages = messageRevisions.merge(peerId, view.messages, fetched, requestRevision);
      const nextGaps = histories.advanceGap(peerId, currentGap, page.messages, page.hasOlder);
      const pageOldestId = page.messages.reduce<number | undefined>(
        (minimum, item) => (minimum === undefined ? item.id : Math.min(minimum, item.id)),
        undefined,
      );
      if (histories.offset(peerId) === currentGap.newerMinMessageId) {
        const nextOffset = nextGaps.some(
          (candidate) => candidate.olderMaxMessageId === currentGap.olderMaxMessageId,
        )
          ? (page.nextBeforeMessageId ?? pageOldestId)
          : messages[0]?.id;
        if (nextOffset !== undefined) histories.setOffset(peerId, nextOffset);
      }
      const history = rememberHistory(
        peerId,
        { messages, hasOlderMessages: view.hasOlderMessages },
        'anchor',
      );
      clearHistoryFailure(peerId);
      view = {
        ...view,
        messages: histories.boundViewMessages(peerId, messages, 'anchor'),
        hasOlderMessages: history.hasOlderMessages,
        historyGaps: histories.gaps(peerId).length > 0 ? histories.gaps(peerId) : nextGaps,
        historyError: undefined,
        historyRetryAt: undefined,
      };
    })
      .pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (!isOperationCurrent(session, accountId)) return;
            const failure = recordHistoryFailure(peerId);
            const message = `Could not load messages in ${dialog.title}. ${errorMessage(error)}`;
            histories.setIssue(peerId, { message, retryAt: failure.retryAt, gap: currentGap });
            view = { ...view, historyError: message, historyRetryAt: failure.retryAt };
            yield* reportFailure(
              'sync',
              `Could not load a message gap from ${dialog.title}.`,
              error,
            );
          }),
        ),
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            view = { ...view, loadingOlderMessages: false };
          }),
        ),
      );
    return view;
  });
  const setUnreadMark = Effect.fn('MessagingEngine.setUnreadMark')(function* (
    peer: TelegramPeer,
    unreadMark: boolean,
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    const operationKey = `unread-mark:${peer.id}`;
    const operationVersion = nextMutationVersion(operationKey);
    return yield* trackVersionedMutation(operationKey, operationVersion, () =>
      queueMutation(operationKey, () => {
        return Effect.gen(function* () {
          if (versions.current('mutation', operationKey) !== operationVersion) return false;
          return yield* Effect.gen(function* () {
            if (!isOperationCurrent(session, accountId)) return false;
            if (!unreadMark) {
              const dialog = dialogForPeer(peer.id);
              if (dialog) yield* flushInboxRead(peer.id, dialog.topMessageId);
            }
            yield* runTelegramOperation(
              () => telegramTransport.setUnreadMark(peer, unreadMark),
              'Changing unread mark',
            );
            if (!isOperationCurrent(session, accountId)) return false;
            versions.next('dialog', peer.id);
            return yield* queueDialogStateOperation(() => {
              return Effect.gen(function* () {
                if (!isOperationCurrent(session, accountId)) return false;
                const dialogs = currentSnapshot().dialogs.map((dialog) =>
                  dialog.peer.id === peer.id ? { ...dialog, unreadMark } : dialog,
                );
                yield* patch({ dialogs });
                const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
                if (changed && !changed.transient) {
                  yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
                }
                return true;
              });
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (isOperationCurrent(session, accountId)) {
                  yield* fail('sync', 'Could not change the unread mark.', error, false);
                }
                return false;
              }),
            ),
          );
        });
      }),
    );
  });
  const setMuted = Effect.fn('MessagingEngine.setMuted')(function* (
    peer: TelegramPeer,
    muted: boolean,
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    const operationKey = `mute:${peer.id}`;
    const operationVersion = nextMutationVersion(operationKey);
    return yield* trackVersionedMutation(operationKey, operationVersion, () =>
      queueMutation(operationKey, () => {
        return Effect.gen(function* () {
          if (versions.current('mutation', operationKey) !== operationVersion) return false;
          return yield* Effect.gen(function* () {
            yield* runTelegramOperation(
              () => telegramTransport.setMuted(peer, muted),
              'Changing notification settings',
            );
            if (!isOperationCurrent(session, accountId)) return false;
            versions.next('dialog', peer.id);
            return yield* queueDialogStateOperation(() => {
              return Effect.gen(function* () {
                if (!isOperationCurrent(session, accountId)) return false;
                const dialogs = currentSnapshot().dialogs.map((dialog) =>
                  dialog.peer.id === peer.id ? { ...dialog, muted } : dialog,
                );
                yield* patch({ dialogs });
                const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
                if (changed && !changed.transient) {
                  yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
                }
                return true;
              });
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (isOperationCurrent(session, accountId)) {
                  yield* fail('sync', 'Could not change notification settings.', error, false);
                }
                return false;
              }),
            ),
          );
        });
      }),
    );
  });
  const getUserDetails = Effect.fn('MessagingEngine.getUserDetails')(function* (
    peer: TelegramPeer,
  ) {
    const stored = currentSnapshot().dialogs.find(
      ({ peer: item }) => item.id === peer.id,
    )?.userDetails;
    if (stored) return stored;
    const session = sessionScope;
    const accountId = activeAccountId;
    const capturedMetadataGeneration = metadataGeneration;
    const resourceKey = `user-details:${peer.id}`;
    const resourceVersion = resourceCache.version(resourceKey);
    return yield* resourceCache.load(resourceKey, () =>
      trackLifecycleTask(() =>
        runTelegramOperation(
          () => telegramTransport.getUserDetails(peer),
          'Loading user details',
        ).pipe(
          Effect.tap((details) =>
            queueDialogStateOperation(() =>
              Effect.gen(function* () {
                if (
                  !isOperationCurrent(session, accountId) ||
                  capturedMetadataGeneration !== metadataGeneration ||
                  resourceCache.version(resourceKey) !== resourceVersion
                )
                  return;
                const dialogs = currentSnapshot().dialogs.map((dialog) =>
                  dialog.peer.id === peer.id ? { ...dialog, userDetails: details } : dialog,
                );
                yield* patch({ dialogs });
                const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
                if (changed && !changed.transient) {
                  yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
                }
              }),
            ),
          ),
          Effect.tapError((error) =>
            isOperationCurrent(session, accountId) &&
            capturedMetadataGeneration === metadataGeneration &&
            resourceCache.version(resourceKey) === resourceVersion
              ? reportFailure('sync', 'Could not load user details.', error)
              : Effect.void,
          ),
        ),
      ),
    );
  });
  const getGroupMembers = Effect.fn('MessagingEngine.getGroupMembers')(function* (
    peer: TelegramPeer,
    limit: number = 50,
    offset: number = 0,
    query?: string,
  ) {
    if (peer.kind === 'user' || !telegramTransport.getGroupMembers) {
      return { members: [], totalCount: 0, hasMore: false } satisfies TelegramGroupMemberPage;
    }
    // Search pages must not replace the cached, unfiltered membership list.
    if (query !== undefined) {
      if (!currentSnapshot().online) {
        const cached = yield* cachedGroupMembers(peer.id);
        const term = query.trim().toLocaleLowerCase().replace(/^@/, '');
        const matching = (cached?.value ?? []).filter((member) =>
          `${member.title} ${member.username ?? ''}`.toLocaleLowerCase().includes(term),
        );
        const nextOffset = offset + limit;
        return {
          members: matching.slice(offset, nextOffset),
          totalCount: matching.length,
          hasMore: nextOffset < matching.length,
          ...(nextOffset < matching.length ? { nextOffset } : {}),
        };
      }
      return yield* runTelegramOperation(
        () => telegramTransport.getGroupMembers!(peer, limit, offset, query.trim()),
        'Searching group members',
      );
    }
    if (offset > 0) {
      if (!currentSnapshot().online) {
        return { members: [], totalCount: 0, hasMore: false } satisfies TelegramGroupMemberPage;
      }
      const page = yield* runTelegramOperation(
        () => telegramTransport.getGroupMembers!(peer, limit, offset),
        'Loading more group members',
      );
      const cached = yield* cachedGroupMembers(peer.id);
      const known = new Set(cached?.value.map(({ peer: memberPeer }) => memberPeer.id) ?? []);
      const merged = [
        ...(cached?.value ?? []),
        ...page.members.filter(({ peer: memberPeer }) => !known.has(memberPeer.id)),
      ];
      yield* rememberGroupMembers(peer.id, merged);
      groupMemberPages.set(peer.id, {
        totalCount: page.totalCount,
        hasMore: page.hasMore,
        ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
      });
      return page;
    }
    const cached = yield* cachedGroupMembers(peer.id);
    if (cached) {
      if (
        !groupMemberCache.isFresh(peer.id, PEER_METADATA_CACHE_TTL_MS) &&
        currentSnapshot().online
      ) {
        yield* forkBackgroundTask(() => refreshGroupMembers(peer, limit));
      }
      const metadata = groupMemberPages.get(peer.id);
      const knownCount = dialogForPeer(peer.id)?.permissions?.memberCount;
      const totalCount = metadata?.totalCount ?? knownCount ?? cached.value.length;
      const hasMore = metadata?.hasMore ?? cached.value.length < totalCount;
      return {
        members: cached.value.slice(0, limit),
        totalCount,
        hasMore,
        ...(metadata?.nextOffset !== undefined
          ? { nextOffset: metadata.nextOffset }
          : hasMore
            ? { nextOffset: cached.value.length }
            : {}),
      } satisfies TelegramGroupMemberPage;
    }
    if (!currentSnapshot().online) {
      return { members: [], totalCount: 0, hasMore: false } satisfies TelegramGroupMemberPage;
    }
    return yield* refreshGroupMembers(peer, limit);
  });
  function refreshGroupMembers(peer: TelegramPeer, limit: number) {
    const session = sessionScope;
    const accountId = activeAccountId;
    return groupMemberCache
      .request(peer.id, (version) =>
        runTelegramOperation(
          () => telegramTransport.getGroupMembers!(peer, limit, 0),
          'Loading group members',
        ).pipe(
          Effect.flatMap((page) =>
            Effect.gen(function* () {
              if (
                !isOperationCurrent(session, accountId) ||
                groupMemberCache.version(peer.id) !== version
              ) {
                return groupMemberCache.current(peer.id)?.value ?? [];
              }
              groupMemberPages.set(peer.id, {
                totalCount: page.totalCount,
                hasMore: page.hasMore,
                ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
              });
              yield* rememberGroupMembers(peer.id, page.members);
              yield* invalidateResource({ kind: 'group-members', peerId: peer.id });
              return page.members;
            }),
          ),
        ),
      )
      .pipe(
        Effect.map(
          (members) =>
            ({
              members: members.slice(0, limit),
              ...(groupMemberPages.get(peer.id) ?? { totalCount: members.length, hasMore: false }),
            }) satisfies TelegramGroupMemberPage,
        ),
      );
  }
  const setBlocked = Effect.fn('MessagingEngine.setBlocked')(function* (
    peer: TelegramPeer,
    blocked: boolean,
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    const operationKey = `block:${peer.id}`;
    const operationVersion = nextMutationVersion(operationKey);
    return yield* trackVersionedMutation(operationKey, operationVersion, () =>
      queueMutation(operationKey, () => {
        return Effect.gen(function* () {
          if (versions.current('mutation', operationKey) !== operationVersion) return false;
          return yield* Effect.gen(function* () {
            yield* runTelegramOperation(
              () => telegramTransport.setBlocked(peer, blocked),
              `${blocked ? 'Blocking' : 'Unblocking'} user`,
            );
            if (!isOperationCurrent(session, accountId)) return false;
            const current = yield* resourceCache.pendingValue<TelegramUserDetails>(
              `user-details:${peer.id}`,
            );
            if (!isOperationCurrent(session, accountId)) return false;
            versions.next('dialog', peer.id);
            return yield* queueDialogStateOperation(() => {
              return Effect.gen(function* () {
                if (!isOperationCurrent(session, accountId)) return false;
                yield* resourceCache.forget(`user-details:${peer.id}`);
                const stored =
                  current ??
                  currentSnapshot().dialogs.find(({ peer: item }) => item.id === peer.id)
                    ?.userDetails;
                if (stored) {
                  const userDetails = { ...stored, blocked };
                  const dialogs = currentSnapshot().dialogs.map((dialog) =>
                    dialog.peer.id === peer.id ? { ...dialog, userDetails } : dialog,
                  );
                  yield* patch({ dialogs });
                  const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
                  if (changed && !changed.transient) {
                    yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
                  }
                }
                return true;
              });
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (isOperationCurrent(session, accountId)) {
                  yield* fail(
                    'sync',
                    `Could not ${blocked ? 'block' : 'unblock'} this user.`,
                    error,
                    false,
                  );
                }
                return false;
              }),
            ),
          );
        });
      }),
    );
  });
  const updateContact = Effect.fn('MessagingEngine.updateContact')(function* (
    peer: TelegramPeer,
    firstName: string,
    lastName: string,
    phone: string,
  ) {
    if (!telegramTransport.updateContact) return false;
    return yield* Effect.gen(function* () {
      yield* runTelegramOperation(
        () => telegramTransport.updateContact!(peer, firstName, lastName, phone),
        'Updating contact',
      );
      versions.next('dialog', peer.id);
      return yield* queueDialogStateOperation(() => {
        return Effect.gen(function* () {
          yield* resourceCache.forget(`user-details:${peer.id}`);
          const dialogs = currentSnapshot().dialogs.map((dialog) => {
            if (dialog.peer.id !== peer.id) return dialog;
            const title = `${firstName} ${lastName}`.trim() || dialog.title;
            return {
              ...dialog,
              title,
              initials: title
                .split(/\s+/u)
                .slice(0, 2)
                .map((part) => part[0])
                .join('')
                .toUpperCase(),
              userDetails: dialog.userDetails
                ? { ...dialog.userDetails, firstName, lastName, phone, isContact: true }
                : dialog.userDetails,
            };
          });
          yield* patch({ dialogs });
          const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
          if (changed && !changed.transient) {
            yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
          }
          return true;
        });
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* fail('sync', 'Could not update this contact.', error, false);
          return false;
        }),
      ),
    );
  });
  const deleteContact = Effect.fn('MessagingEngine.deleteContact')(function* (peer: TelegramPeer) {
    if (!telegramTransport.deleteContact) return false;
    return yield* Effect.gen(function* () {
      yield* runTelegramOperation(() => telegramTransport.deleteContact!(peer), 'Deleting contact');
      versions.next('dialog', peer.id);
      return yield* queueDialogStateOperation(() => {
        return Effect.gen(function* () {
          yield* resourceCache.forget(`user-details:${peer.id}`);
          const dialogs = currentSnapshot().dialogs.map((dialog) =>
            dialog.peer.id === peer.id && dialog.userDetails
              ? { ...dialog, userDetails: { ...dialog.userDetails, isContact: false } }
              : dialog,
          );
          yield* patch({ dialogs });
          const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
          if (changed && !changed.transient) {
            yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
          }
          return true;
        });
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* fail('sync', 'Could not delete this contact.', error, false);
          return false;
        }),
      ),
    );
  });
  const setPinnedDialog = Effect.fn('MessagingEngine.setPinnedDialog')(function* (
    peer: TelegramPeer,
    pinned: boolean,
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    const operationKey = `dialog-pin:${peer.id}`;
    const operationVersion = nextMutationVersion(operationKey);
    return yield* trackVersionedMutation(operationKey, operationVersion, () =>
      queueMutation(operationKey, () => {
        return Effect.gen(function* () {
          if (versions.current('mutation', operationKey) !== operationVersion) return false;
          return yield* Effect.gen(function* () {
            yield* runTelegramOperation(
              () => telegramTransport.setPinnedDialog(peer, pinned),
              `${pinned ? 'Pinning' : 'Unpinning'} chat`,
            );
            if (!isOperationCurrent(session, accountId)) return false;
            versions.next('dialog', peer.id);
            return yield* queueDialogStateOperation(() => {
              return Effect.gen(function* () {
                if (!isOperationCurrent(session, accountId)) return false;
                const pinnedDialogs = currentSnapshot()
                  .dialogs.filter((dialog) => dialog.pinned && dialog.peer.id !== peer.id)
                  .sort(
                    (left, right) =>
                      (left.pinnedOrder ?? Number.MAX_SAFE_INTEGER) -
                        (right.pinnedOrder ?? Number.MAX_SAFE_INTEGER) ||
                      (right.topMessage?.date ?? 0) - (left.topMessage?.date ?? 0),
                  );
                const pinnedOrderByPeer = new Map(
                  pinnedDialogs.map((dialog, index) => [dialog.peer.id, index + (pinned ? 1 : 0)]),
                );
                const dialogs = sortDialogs(
                  currentSnapshot().dialogs.map((dialog) =>
                    dialog.peer.id === peer.id
                      ? {
                          ...dialog,
                          pinned,
                          ...(pinned ? { pinnedOrder: 0 } : { pinnedOrder: undefined }),
                        }
                      : pinnedOrderByPeer.has(dialog.peer.id)
                        ? { ...dialog, pinnedOrder: pinnedOrderByPeer.get(dialog.peer.id) }
                        : dialog,
                  ),
                );
                yield* patch({ dialogs });
                const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
                if (changed && !changed.transient) {
                  yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
                }
                return true;
              });
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (isOperationCurrent(session, accountId)) {
                  yield* fail(
                    'sync',
                    `Could not ${pinned ? 'pin' : 'unpin'} this chat.`,
                    error,
                    false,
                  );
                }
                return false;
              }),
            ),
          );
        });
      }),
    );
  });
  const setArchived = Effect.fn('MessagingEngine.setArchived')(function* (
    peer: TelegramPeer,
    archived: boolean,
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    const operationKey = `archive:${peer.id}`;
    const operationVersion = nextMutationVersion(operationKey);
    return yield* trackVersionedMutation(operationKey, operationVersion, () =>
      queueMutation(operationKey, () => {
        return Effect.gen(function* () {
          if (versions.current('mutation', operationKey) !== operationVersion) return true;
          return yield* Effect.gen(function* () {
            const result = yield* runTelegramOperation(
              () => telegramTransport.setArchived(peer, archived),
              `${archived ? 'Archiving' : 'Unarchiving'} chat`,
            );
            if (!isOperationCurrent(session, accountId)) return true;
            yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
            if (!isOperationCurrent(session, accountId)) return true;
            versions.next('dialog', peer.id);
            return yield* queueDialogStateOperation(() => {
              return Effect.gen(function* () {
                if (!isOperationCurrent(session, accountId)) return true;
                const dialogs = sortDialogs(
                  currentSnapshot().dialogs.map((dialog) =>
                    dialog.peer.id === peer.id ? { ...dialog, archived } : dialog,
                  ),
                );
                yield* patch({ dialogs });
                const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
                if (changed && !changed.transient) {
                  yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
                }
                return true;
              });
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (isOperationCurrent(session, accountId)) {
                  yield* fail(
                    'sync',
                    `Could not ${archived ? 'archive' : 'unarchive'} this chat.`,
                    error,
                    false,
                  );
                }
                return false;
              }),
            ),
          );
        });
      }),
    );
  });
  const deleteDialog = Effect.fn('MessagingEngine.deleteDialog')(function* (
    peer: TelegramPeer,
    action: TelegramDeleteDialogAction = peer.kind === 'user'
      ? 'clear-for-me'
      : peer.kind === 'channel'
        ? 'leave'
        : 'leave',
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    const dialog = currentSnapshot().dialogs.find(
      ({ peer: candidate }) => candidate.id === peer.id,
    );
    if (dialog && !deleteDialogOptions(dialog).some((option) => option.action === action)) {
      return yield* Effect.fail(new Error('This Telegram chat does not allow that action.'));
    }
    const operationKey = `delete-dialog:${peer.id}`;
    const operationVersion = nextMutationVersion(operationKey);
    return yield* trackVersionedMutation(operationKey, operationVersion, () => {
      return Effect.gen(function* () {
        return yield* Effect.gen(function* () {
          const result = yield* runTelegramOperation(
            () => telegramTransport.deleteDialog(peer, action),
            action === 'leave'
              ? 'Leaving chat'
              : action === 'delete-channel'
                ? 'Deleting channel'
                : action === 'delete-chat'
                  ? 'Deleting group'
                  : 'Deleting chat',
          );
          if (!isOperationCurrent(session, accountId)) return false;
          yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
          if (
            !isOperationCurrent(session, accountId) ||
            versions.current('mutation', operationKey) !== operationVersion
          ) {
            return false;
          }
          versions.next('dialog', peer.id);
          return yield* queueDialogStateOperation(() => {
            return Effect.gen(function* () {
              if (
                !isOperationCurrent(session, accountId) ||
                versions.current('mutation', operationKey) !== operationVersion
              ) {
                return false;
              }
              const dialogs = currentSnapshot().dialogs.filter(
                (dialog) => dialog.peer.id !== peer.id,
              );
              const pending = currentSnapshot().pending.filter((send) => send.peer.id === peer.id);
              for (const send of pending) yield* sendQueue.cancel(send.id);
              yield* Effect.all([
                cacheStore.replaceDialogs(
                  dialogs
                    .filter((dialog) => !dialog.transient)
                    .map((dialog) => ({ ...dialog, cacheEpoch: currentCacheEpoch })),
                ),
                cacheStore.replaceMessages(peer.id, []),
                cacheStore.saveDraft(peer.id, ''),
                cacheStore.deletePinnedMessages(peer.id),
                cacheStore.deleteGroupMembers(peer.id),
                ...pending.map((send) => cacheStore.deletePending(send.id)),
              ]);
              for (const send of pending) {
                yield* sendQueue.finishCancellation(send.id);
              }
              sendQueue.releaseBlock(peer.id);
              if (!isOperationCurrent(session, accountId)) return false;
              invalidateHistory(peer.id);
              yield* pinnedMessageCache.forget(peer.id);
              yield* groupMemberCache.forget(peer.id);
              groupMemberPages.delete(peer.id);
              yield* resourceCache.forget(`user-details:${peer.id}`);
              yield* patch({
                dialogs,
                drafts: Object.fromEntries(
                  Object.entries(currentSnapshot().drafts).filter(([peerId]) => peerId !== peer.id),
                ),
                draftDetails: Object.fromEntries(
                  Object.entries(currentSnapshot().draftDetails).filter(
                    ([peerId]) => peerId !== peer.id,
                  ),
                ),
                pending: currentSnapshot().pending.filter((send) => send.peer.id !== peer.id),
              });
              return true;
            });
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (isOperationCurrent(session, accountId)) {
                yield* fail('sync', 'Could not delete this chat.', error, false);
              }
              return false;
            }),
          ),
        );
      });
    });
  });
  const setPinnedMessage = Effect.fn('MessagingEngine.setPinnedMessage')(function* (
    peer: TelegramPeer,
    messageId: number,
    pinned: boolean,
  ) {
    const dialog = dialogForPeer(peer.id);
    const source = histories.loaded(peer.id)?.messages.find(({ id }) => id === messageId);
    if (!dialog && peer.kind !== 'user') {
      return yield* Effect.fail(new Error('Pinning messages is not available in this chat.'));
    }
    if (
      dialog &&
      (!source
        ? !permissionsForDialog(dialog).canPinMessages
        : !messageCapabilities(dialog, source).canPin)
    ) {
      return yield* Effect.fail(new Error(`Pinning messages is not available in ${dialog.title}.`));
    }
    const session = sessionScope;
    const accountId = activeAccountId;
    const operationKey = `message-pin:${peer.id}:${messageId}`;
    const operationVersion = nextMutationVersion(operationKey);
    yield* pinnedMessageCache.bump(peer.id);
    return yield* trackVersionedMutation(operationKey, operationVersion, () =>
      queueMutation(operationKey, () => {
        return Effect.gen(function* () {
          if (versions.current('mutation', operationKey) !== operationVersion) return;
          yield* Effect.gen(function* () {
            const result = yield* runTelegramOperation(
              () => telegramTransport.setPinnedMessage(peer, messageId, pinned),
              `${pinned ? 'Pinning' : 'Unpinning'} message`,
            );
            if (!isOperationCurrent(session, accountId)) return;
            yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
            if (!isOperationCurrent(session, accountId)) return;
            const source =
              histories.loaded(peer.id)?.messages.find(({ id }) => id === messageId) ??
              (yield* cacheStore.loadMessage(peer.id, messageId));
            const current = pinnedMessageCache.current(peer.id)?.value ?? [];
            const pinnedMessages = pinned
              ? source
                ? [{ ...source, pinned: true }, ...current.filter(({ id }) => id !== messageId)]
                : current
              : current.filter(({ id }) => id !== messageId);
            yield* rememberPinnedMessages(peer.id, pinnedMessages);
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (isOperationCurrent(session, accountId)) {
                  yield* fail(
                    'sync',
                    `Could not ${pinned ? 'pin' : 'unpin'} the message.`,
                    error,
                    false,
                  );
                }
              }),
            ),
          );
        });
      }),
    );
  });
  const setTyping = Effect.fn('MessagingEngine.setTyping')(function* (
    peer: TelegramPeer,
    kind?: TelegramActivityKind,
  ) {
    // Typing is ephemeral and must never interrupt composer input.
    yield* runTelegramOperation(
      () => telegramTransport.setTyping(peer, kind),
      'Sending typing state',
    ).pipe(Effect.ignore);
  });
  const loadOlderConversationView = Effect.fn('MessagingEngine.loadOlderConversationView')(
    function* (
      peerId: string,
      currentView: ConversationViewSnapshot = projectConversationView(peerId),
    ) {
      const session = sessionScope;
      const accountId = activeAccountId;
      if (currentView.loadingOlderMessages || !currentView.hasOlderMessages) {
        return currentView;
      }
      const dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
      const oldest = currentView.messages[0];
      if (!dialog || !oldest) return currentView;
      let view: ConversationViewSnapshot = { ...currentView, loadingOlderMessages: true };
      const historyVersion = histories.version(peerId);
      const requestRevision = messageRevisions.capture();
      yield* Effect.gen(function* () {
        const repositoryOffset = histories.offset(peerId);
        const matchingGap = currentView.historyGaps.find(
          ({ newerMinMessageId }) => newerMinMessageId === repositoryOffset,
        );
        const requestedOffset = matchingGap ? repositoryOffset! : oldest.id;
        const loadedIds = new Set(view.messages.map(({ id }) => id));
        const cachedPage = (yield* cacheStore.loadMessagesBefore(
          peerId,
          requestedOffset,
          HISTORY_LIMIT,
        )).filter(
          (message) =>
            message.cacheEpoch === currentCacheEpoch &&
            !loadedIds.has(message.id) &&
            (!matchingGap || message.id > matchingGap.olderMaxMessageId),
        );
        if (!isHistoryOperationCurrent(peerId, historyVersion, session, accountId)) return;
        if (cachedPage.length > 0) {
          const cachedMessages = sortMessages(cachedPage);
          const nextOffset = cachedMessages[0]!.id;
          histories.setOffset(peerId, nextOffset);
          const messages = messageRevisions.merge(
            peerId,
            view.messages,
            cachedMessages,
            requestRevision,
          );
          rememberHistory(peerId, { messages, hasOlderMessages: true }, 'oldest');
          view = {
            ...view,
            messages: histories.boundViewMessages(peerId, messages, 'oldest'),
            hasOlderMessages: true,
            loadingOlderMessages: false,
            historyError: undefined,
            historyRetryAt: undefined,
          };
          return;
        }
        const failure = histories.failure(peerId);
        if (failure && Date.now() < failure.retryAt) {
          return;
        }
        if (!currentSnapshot().online) {
          const message = 'Older messages are unavailable while Telegram is offline.';
          histories.setIssue(peerId, { message });
          view = { ...view, historyError: message };
          return;
        }
        const page = yield* runTelegramOperation(
          () => telegramTransport.getHistory(dialog.peer, HISTORY_LIMIT, requestedOffset),
          `Loading older messages from ${dialog.title}`,
        );
        if (!isHistoryOperationCurrent(peerId, historyVersion, session, accountId)) return;
        if (page.channelPts !== undefined) {
          yield* setChannelPts(peerId, page.channelPts);
        }
        const fetched = messageRevisions.filter(
          peerId,
          page.messages.map((message) => ({ ...message, cacheEpoch: currentCacheEpoch })),
          requestRevision,
        );
        yield* cacheStore.putMessages(fetched);
        if (!isHistoryOperationCurrent(peerId, historyVersion, session, accountId)) return;
        const messages = messageRevisions.merge(peerId, view.messages, fetched, requestRevision);
        const pageOldestId = page.messages.reduce<number | undefined>(
          (minimum, message) =>
            minimum === undefined ? message.id : Math.min(minimum, message.id),
          undefined,
        );
        const nextOffset = page.nextBeforeMessageId ?? pageOldestId;
        const advanced = nextOffset !== undefined && nextOffset < requestedOffset;
        if (advanced) histories.setOffset(peerId, nextOffset);
        const nextGaps = matchingGap
          ? histories.advanceGap(peerId, matchingGap, page.messages, page.hasOlder)
          : view.historyGaps;
        clearHistoryFailure(peerId);
        const history = rememberHistory(
          peerId,
          { messages, hasOlderMessages: page.hasOlder && advanced },
          histories.anchor(peerId) !== undefined ? 'anchor' : 'oldest',
        );
        view = {
          ...view,
          messages: histories.boundViewMessages(
            peerId,
            messages,
            histories.anchor(peerId) !== undefined ? 'anchor' : 'oldest',
          ),
          hasOlderMessages: history.hasOlderMessages,
          historyGaps: nextGaps,
          historyError: undefined,
          historyRetryAt: undefined,
        };
      })
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (isOperationCurrent(session, accountId)) {
                const nextFailure = recordHistoryFailure(peerId);
                const message = `Could not load older messages from ${dialog.title}. ${errorMessage(error)}`;
                histories.setIssue(peerId, { message, retryAt: nextFailure.retryAt });
                view = { ...view, historyError: message, historyRetryAt: nextFailure.retryAt };
              }
              if (isOperationCurrent(session, accountId)) {
                yield* reportFailure(
                  'sync',
                  `Could not load older messages from ${dialog.title}.`,
                  error,
                );
              }
            }),
          ),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              view = { ...view, loadingOlderMessages: false };
            }),
          ),
        );
      return view;
    },
  );
  const retryConversationView = Effect.fn('MessagingEngine.retryConversationView')(function* (
    peerId: string,
    currentView: ConversationViewSnapshot = projectConversationView(peerId),
  ) {
    const failedGap = histories.issue(peerId)?.gap;
    clearHistoryFailure(peerId);
    const view = { ...currentView, historyError: undefined, historyRetryAt: undefined };
    if (failedGap) {
      return yield* loadHistoryGapConversationView(peerId, failedGap, view);
    }
    if (view.messages.length === 0) {
      histories.invalidate(peerId);
      return yield* loadConversationView(peerId);
    }
    return yield* loadOlderConversationView(peerId, { ...view, hasOlderMessages: true });
  });
  const setDraft = Effect.fn('MessagingEngine.setDraft')(function* (
    peerId: string,
    text: string,
    details?: TelegramDraftDetails,
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    const revision = versions.increment('draft', peerId);
    const nextDraftDetails = { ...currentSnapshot().draftDetails };
    if (details) nextDraftDetails[peerId] = details;
    else delete nextDraftDetails[peerId];
    yield* patch({
      drafts: { ...currentSnapshot().drafts, [peerId]: text },
      draftDetails: nextDraftDetails,
    });
    const write = runSerialized('draftWrite', peerId, () =>
      isOperationCurrent(session, accountId)
        ? runLocalOperation(
            () => cacheStore.saveDraft(peerId, text, revision, details),
            'Saving draft',
          )
        : Effect.void,
    );
    yield* write.pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          if (isOperationCurrent(session, accountId)) {
            yield* fail('cache', 'The draft was not saved to this device.', error, false);
          }
        }),
      ),
    );
  });
  const cancelQrLogin = Effect.fn('MessagingEngine.cancelQrLogin')(function* () {
    const scope = qrScope;
    qrScope = undefined;
    if (scope) yield* Scope.close(scope, Exit.void);
    if (currentSnapshot().authStep === 'qr')
      yield* patch({ authStep: 'phone', qrLogin: undefined, error: undefined });
  });
  const beginQrLogin = Effect.fn('MessagingEngine.beginQrLogin')(function* () {
    if (currentSnapshot().phase !== 'unauthorized' || !sessionScope) return;
    yield* cancelQrLogin();
    mayClaimLegacyAccount = false;
    const session = sessionScope;
    const scope = yield* Scope.fork(session, 'parallel');
    qrScope = scope;
    yield* patch({ authStep: 'qr', qrLogin: undefined, error: undefined });
    if (!telegramTransport.watchQrLogin) {
      yield* patch({ error: 'QR login is unavailable for this connection.' });
      return;
    }
    yield* Stream.runForEach(telegramTransport.watchQrLogin(), (result) =>
      Effect.gen(function* () {
        if (qrScope !== scope || !isLifecycleCurrent(session)) return;
        if (result.type === 'token') {
          yield* patch({ qrLogin: { url: result.url, expires: result.expires }, error: undefined });
        } else if (result.type === 'password-required') {
          yield* patch({ authStep: 'password', qrLogin: undefined, error: undefined });
        } else {
          yield* patch({ qrLogin: undefined });
          yield* activateAuthorizedSession(false, session);
        }
      }),
    ).pipe(
      Effect.catch((error) =>
        qrScope === scope && isLifecycleCurrent(session)
          ? patch({
              qrLogin: undefined,
              error: error instanceof Error ? error.message : 'Could not start QR login.',
            })
          : Effect.void,
      ),
      Effect.forkIn(scope, { startImmediately: true }),
    );
  });
  const requestCode = Effect.fn('MessagingEngine.requestCode')(function* (phoneNumber: string) {
    yield* cancelQrLogin();
    mayClaimLegacyAccount = false;
    yield* Effect.gen(function* () {
      const result = yield* runTelegramOperation(
        () => telegramTransport.requestCode(phoneNumber),
        'Requesting login code',
      );
      yield* patch({
        phase: 'unauthorized',
        authStep: 'code',
        codeViaApp: result.isCodeViaApp,
        error: undefined,
      });
    }).pipe(
      Effect.catch((error) => fail('auth', 'Telegram could not send a login code.', error, false)),
    );
  });
  const submitCode = Effect.fn('MessagingEngine.submitCode')(function* (code: string) {
    const result = yield* runTelegramOperation(
      () => telegramTransport.submitCode(code),
      'Submitting login code',
    ).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.gen(function* () {
            yield* fail('auth', 'Telegram rejected the login code.', error, false);
            return undefined;
          }),
        onSuccess: Effect.succeed,
      }),
    );
    if (result === undefined) return;
    if (result === 'password-required') {
      yield* patch({ authStep: 'password', error: undefined });
      return;
    }
    if (result === 'sign-up-required') {
      yield* patch({ error: 'TeleVecha signs in existing accounts only.' });
      return;
    }
    yield* activateAuthorizedSession(false);
  });
  const submitPassword = Effect.fn('MessagingEngine.submitPassword')(function* (password: string) {
    yield* Effect.gen(function* () {
      yield* runTelegramOperation(
        () => telegramTransport.submitPassword(password),
        'Submitting two-step verification password',
      );
      yield* activateAuthorizedSession(false);
    }).pipe(
      Effect.catch((error) =>
        fail('auth', 'Telegram rejected the two-step verification password.', error, false),
      ),
    );
  });
  const logOut = Effect.fn('MessagingEngine.logOut')(function* () {
    let remoteError: unknown;
    yield* runTelegramOperation(() => telegramTransport.logOut(), 'Signing out from Telegram').pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          remoteError = error;
          yield* reportFailure('auth', 'Telegram could not revoke the remote session.', error);
        }),
      ),
    );
    yield* stop();
    yield* cacheStore.clearAccountData();
    activeAccountId = undefined;
    cachedAccountId = undefined;
    mayClaimLegacyAccount = false;
    hasReachedReady = false;
    currentCacheEpoch = 0;
    histories.clear();
    yield* patch({
      phase: 'idle',
      sync: 'stale',
      online: false,
      dialogs: [],
      drafts: {},
      draftDetails: {},
      pending: [],
      activities: [],
      authStep: undefined,
      codeViaApp: undefined,
      operationError: undefined,
      error: undefined,
    });
    if (activeCredentials) yield* start(activeCredentials);
    if (remoteError && currentSnapshot().phase === 'unauthorized') {
      yield* patch({
        error: `Signed out on this device, but Telegram could not revoke the remote session. ${errorMessage(remoteError)}`,
      });
    }
  });
  const clearCache = Effect.fn('MessagingEngine.clearCache')(function* () {
    const credentials = activeCredentials;
    if (!credentials) {
      return yield* Effect.fail(new Error('Telegram credentials are unavailable.'));
    }
    yield* stop();
    yield* cacheStore.clearCacheData();
    currentCacheEpoch = 0;
    histories.clear();
    yield* start(credentials);
  });
  const sendDraft = Effect.fn('MessagingEngine.sendDraft')(function* (
    peer: TelegramPeer,
    text: string,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ) {
    if (!text.trim()) return;
    yield* requirePeerPermission(peer, 'canSendMessages', 'Sending messages');
    yield* validateTextLength(text, MAX_MESSAGE_TEXT_LENGTH, 'message');
    const draftKey = forumDraftKey(peer.id, reply?.topMessageId);
    const draftVersion = versions.current('draft', draftKey);
    const duplicateKey = draftSendKey(text, reply, formats, draftVersion);
    return yield* resourceCache.load(
      `draft-send:${JSON.stringify([peer.id, duplicateKey])}`,
      () => {
        return Effect.gen(function* () {
          const id = yield* randomUuid();
          const generatedRandomId = yield* randomId();
          const pending = sendQueue.create({
            id,
            accountId: activeAccountId ?? cachedAccountId,
            peer,
            text,
            randomId: generatedRandomId,
            createdAt: Date.now(),
            attempts: 0,
            ...(sendQueue.blockedBy(peer.id) ? { lastError: blockedSendMessage() } : {}),
            reply,
            formats,
          });
          const session = sessionScope;
          const accountId = pending.accountId;
          let delivery: Effect.Effect<void, unknown> | undefined;
          yield* patch({ pending: [...currentSnapshot().pending, pending] });
          yield* sendQueue.queueWrite(
            peer.id,
            Effect.gen(function* () {
              if (!isPendingOperationCurrent(session, accountId)) return;
              yield* Effect.gen(function* () {
                yield* reserveDraftSend(pending, text, draftVersion);
              }).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    if (isPendingOperationCurrent(session, accountId)) {
                      yield* patch({
                        pending: currentSnapshot().pending.filter(({ id }) => id !== pending.id),
                      });
                    }
                    return yield* Effect.fail(error);
                  }),
                ),
              );
              if (!isPendingOperationCurrent(session, accountId)) return;
              const drafts =
                currentSnapshot().drafts[draftKey] === text &&
                versions.current('draft', draftKey) === draftVersion
                  ? { ...currentSnapshot().drafts, [draftKey]: '' }
                  : currentSnapshot().drafts;
              const draftDetails =
                drafts === currentSnapshot().drafts
                  ? currentSnapshot().draftDetails
                  : Object.fromEntries(
                      Object.entries(currentSnapshot().draftDetails).filter(
                        ([peerId]) => peerId !== draftKey,
                      ),
                    );
              yield* patch({ drafts, draftDetails });
              if (canDeliver(pending)) delivery = deliver(pending);
            }),
          );
          if (delivery)
            yield* delivery.pipe(
              Effect.catch((error) =>
                reportFailure('outbox', 'A queued message delivery task failed.', error),
              ),
            );
        });
      },
    );
  });
  const sendAttachments = Effect.fn('MessagingEngine.sendAttachments')(function* (
    peer: TelegramPeer,
    attachments: OutgoingAttachment[],
    caption: string = '',
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ) {
    if (attachments.length === 0) return;
    yield* requirePeerPermission(peer, 'canSendMessages', 'Sending messages');
    yield* validateTextLength(caption, MAX_CAPTION_TEXT_LENGTH, 'caption');
    for (const { file } of attachments) yield* validateAttachment(file);
    if (
      attachments.some(
        ({ file, sendAs }) => !isStickerFile(file, sendAs) && !isGifFile(file, sendAs),
      )
    ) {
      yield* requirePeerPermission(peer, 'canSendMedia', 'Sending media');
    }
    if (attachments.some(({ file, sendAs }) => isStickerFile(file, sendAs))) {
      yield* requirePeerPermission(peer, 'canSendStickers', 'Sending stickers');
    }
    if (attachments.some(({ file, sendAs }) => isGifFile(file, sendAs))) {
      yield* requirePeerPermission(peer, 'canSendGifs', 'Sending GIFs');
    }
    const pending: PendingSend[] = [];
    const createdAt = Date.now();
    const accountId = activeAccountId ?? cachedAccountId;
    const draftKey = forumDraftKey(peer.id, reply?.topMessageId);
    const draftVersion = versions.current('draft', draftKey);
    const appendSingle = ({
      file,
      sendAs,
      width,
      height,
      duration,
      preview,
    }: (typeof attachments)[number]) =>
      Effect.gen(function* () {
        const isFirst = pending.length === 0;
        const id = yield* randomUuid();
        const generatedRandomId = yield* randomId();
        pending.push(
          sendQueue.create({
            id,
            accountId,
            peer,
            text: isFirst ? caption : '',
            randomId: generatedRandomId,
            createdAt: createdAt + pending.length,
            attempts: 0,
            reply: isFirst
              ? reply
              : reply?.topMessageId !== undefined
                ? { messageId: reply.topMessageId, topMessageId: reply.topMessageId }
                : undefined,
            formats: isFirst ? formats : undefined,
            attachment: {
              blob: file,
              name: file.name,
              mimeType: file.type || 'application/octet-stream',
              asSticker: isStickerFile(file, sendAs),
              sendAs,
              width,
              height,
              duration,
              preview,
            },
          }),
        );
      });
    const appendAlbum = (items: Array<(typeof attachments)[number]>) =>
      Effect.gen(function* () {
        const isFirst = pending.length === 0;
        const id = yield* randomUuid();
        const albumAttachments = yield* Effect.forEach(
          items,
          ({ file, sendAs, width, height, duration, preview }) =>
            randomId().pipe(
              Effect.map((generatedRandomId) => ({
                blob: file,
                name: file.name,
                mimeType: file.type || 'application/octet-stream',
                asSticker: false,
                sendAs,
                randomId: generatedRandomId,
                width,
                height,
                duration,
                preview,
              })),
            ),
        );
        pending.push(
          sendQueue.create({
            id,
            accountId,
            peer,
            text: isFirst ? caption : '',
            randomId: albumAttachments[0]!.randomId,
            createdAt: createdAt + pending.length,
            attempts: 0,
            reply: isFirst
              ? reply
              : reply?.topMessageId !== undefined
                ? { messageId: reply.topMessageId, topMessageId: reply.topMessageId }
                : undefined,
            formats: isFirst ? formats : undefined,
            album: { attachments: albumAttachments },
          }),
        );
      });

    for (let index = 0; index < attachments.length;) {
      const attachment = attachments[index]!;
      let end = index + 1;
      while (end < attachments.length && attachments[end]!.sendAs === attachment.sendAs) end += 1;
      while (index < end) {
        const count = Math.min(MAX_ALBUM_ATTACHMENTS, end - index);
        const items = attachments.slice(index, index + count);
        if (items.length > 1) yield* appendAlbum(items);
        else yield* appendSingle(items[0]!);
        index += count;
      }
    }
    yield* enqueuePendingBatch(pending, {
      peerId: draftKey,
      text: caption,
      revision: draftVersion,
    });
  });
  const downloadMedia = Effect.fn('MessagingEngine.downloadMedia')(function* (
    message: TelegramMessage,
    options?: import('../types').TelegramDownloadOptions,
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    const assetKey = mediaAssetKey(message);
    const cacheKey = options?.preview ? `preview:${assetKey}` : assetKey;
    const range = options?.range;
    if (
      range &&
      (options?.preview ||
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start)
    ) {
      return yield* Effect.fail(new Error('Invalid media byte range.'));
    }
    const mediaSlot = `${options?.preview ? 'preview:' : ''}${message.peerId}:${message.id}`;
    const mediaVersion = resourceCache.version(mediaSlot);
    const load = () =>
      downloadAndCacheMedia(
        cacheKey,
        message,
        mediaSlot,
        mediaVersion,
        session,
        accountId,
        options,
      );
    const requestKey = range
      ? `media:${cacheKey}:${range.start}-${range.end}`
      : `media:${cacheKey}`;
    return yield* options?.progress ? load() : resourceCache.load(requestKey, load);
  });
  function mediaAssetKey(message: TelegramMessage) {
    return telegramMediaAssetKey(message);
  }
  const downloadAndCacheMedia = Effect.fn('MessagingEngine.downloadAndCacheMedia')(function* (
    cacheKey: string,
    message: TelegramMessage,
    mediaSlot: string,
    mediaVersion: number,
    session: Scope.Closeable | undefined,
    accountId: string | undefined,
    options?: import('../types').TelegramDownloadOptions,
  ) {
    let cached: Blob | undefined;
    yield* Effect.gen(function* () {
      cached = yield* cacheStore.loadBlob(cacheKey);
      // Image documents can use their cached original as a thumbnail as well.
      if (!cached && options?.preview && message.media?.mimeType.startsWith('image/')) {
        cached = yield* cacheStore.loadBlob(mediaAssetKey(message));
      }
    }).pipe(
      Effect.catch((error) =>
        reportFailure('cache', 'Could not read cached media; downloading it again.', error),
      ),
    );
    if (!isOperationCurrent(session, accountId)) {
      return yield* Effect.fail(
        new Error('The media request no longer belongs to the active account.'),
      );
    }
    if (cached)
      return options?.range
        ? cached.slice(options.range.start, options.range.end + 1, cached.type)
        : cached;
    return yield* Effect.gen(function* () {
      const blob = yield* runTransportWithDeadline(
        () => telegramTransport.downloadMedia(message, { ...options }),
        MEDIA_DELIVERY_TIMEOUT_MS,
        'Media download timed out after 5 minutes.',
        'media-download',
      );
      if (
        isOperationCurrent(session, accountId) &&
        resourceCache.version(mediaSlot) === mediaVersion &&
        !options?.range
      ) {
        yield* cacheStore
          .saveBlob(cacheKey, blob)
          .pipe(
            Effect.catch((error) =>
              reportFailure('cache', 'Could not cache downloaded media.', error),
            ),
          );
      }
      return blob;
    }).pipe(
      Effect.catch((firstError) =>
        Effect.gen(function* () {
          if (!isOperationCurrent(session, accountId)) return yield* Effect.fail(firstError);
          yield* whenAccountReady();
          if (!isOperationCurrent(session, accountId)) return yield* Effect.fail(firstError);
          const dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === message.peerId);
          if (!dialog) return yield* Effect.fail(firstError);
          const requestRevision = messageRevisions.capture();
          const contextPage = telegramTransport.getHistoryAround
            ? yield* runTelegramOperation(
                () => telegramTransport.getHistoryAround!(dialog.peer, message.id, HISTORY_LIMIT),
                `Refreshing media in ${dialog.title}`,
              )
            : yield* runTelegramOperation(
                () => telegramTransport.getHistory(dialog.peer, HISTORY_LIMIT, undefined),
                `Refreshing media in ${dialog.title}`,
              ).pipe(Effect.map(({ messages, channelPts }) => ({ messages, channelPts })));
          if (contextPage.channelPts !== undefined) {
            yield* setChannelPts(message.peerId, contextPage.channelPts);
          }
          const context = contextPage.messages;
          if (!isOperationCurrent(session, accountId)) return yield* Effect.fail(firstError);
          const fetched = messageRevisions.filter(
            message.peerId,
            context.map((item) => ({ ...item, cacheEpoch: currentCacheEpoch })),
            requestRevision,
          );
          yield* cacheStore.putMessages(fetched);
          if (!isOperationCurrent(session, accountId)) return yield* Effect.fail(firstError);
          const loaded = histories.loaded(message.peerId);
          if (loaded) {
            histories.updateLoaded(message.peerId, (history) => ({
              ...history,
              messages: histories.boundMessages(
                message.peerId,
                messageRevisions.merge(message.peerId, history.messages, fetched, requestRevision),
                histories.mode(message.peerId) ?? 'newest',
              ),
            }));
          } else {
            rememberHistory(
              message.peerId,
              { messages: fetched, hasOlderMessages: fetched.some(({ id }) => id > 1) },
              'newest',
            );
          }
          for (const refreshed of fetched) {
            yield* publishConversationEvent({
              type: 'message-upsert',
              message: refreshed,
              insertIfMissing: true,
            });
          }
          const refreshed = context.find(({ id }) => id === message.id);
          if (!refreshed) return yield* Effect.fail(firstError);
          const blob = yield* runTransportWithDeadline(
            () => telegramTransport.downloadMedia(refreshed, { ...options }),
            MEDIA_DELIVERY_TIMEOUT_MS,
            'Media download timed out after 5 minutes.',
            'media-download',
          );
          if (
            isOperationCurrent(session, accountId) &&
            resourceCache.version(mediaSlot) === mediaVersion &&
            !options?.range
          ) {
            yield* cacheStore
              .saveBlob(cacheKey, blob)
              .pipe(
                Effect.catch((error) =>
                  reportFailure('cache', 'Could not cache downloaded media.', error),
                ),
              );
          }
          return blob;
        }),
      ),
    );
  });
  const downloadAvatar = Effect.fn('MessagingEngine.downloadAvatar')(function* (
    peer: TelegramPeer,
    avatarId?: string,
  ) {
    const cacheKey = `avatar:${peer.id}:${avatarId ?? 'unknown'}`;
    return yield* resourceCache.load(cacheKey, () => downloadAndCacheAvatar(cacheKey, peer));
  });
  const loadCachedAvatar = Effect.fn('MessagingEngine.loadCachedAvatar')(function* (
    peer: TelegramPeer,
    avatarId?: string,
  ) {
    return yield* cacheStore.loadBlob(`avatar:${peer.id}:${avatarId ?? 'unknown'}`);
  });
  const getWallpapers = Effect.fn('MessagingEngine.getWallpapers')(function* () {
    const cacheKey = 'wallpaper-catalog:v1';
    const cached = yield* readMetadata<TelegramWallpaper[]>(cacheKey);
    if (cached && !currentSnapshot().online) {
      return cached.value;
    }
    if (!telegramTransport.getWallpapers || !currentSnapshot().online || !activeAccountId) {
      return cached?.value ?? [];
    }
    return yield* runTelegramOperation(
      () => telegramTransport.getWallpapers!(),
      'Loading Telegram backgrounds',
    ).pipe(
      Effect.tap((wallpapers) => writeMetadata(cacheKey, wallpapers)),
      Effect.catch((error) => (cached ? Effect.succeed(cached.value) : Effect.fail(error))),
    );
  });
  const getChatAppearance = Effect.fn('MessagingEngine.getChatAppearance')(function* (
    peer: TelegramPeer,
  ) {
    if (!telegramTransport.getChatAppearance) return undefined;
    const cacheKey = `chat-appearance:${peer.id}`;
    const cachedMetadata = yield* readMetadata<TelegramChatAppearance | undefined>(cacheKey);
    let missingImage = false;
    if (cachedMetadata) {
      if (!currentSnapshot().online) return cachedMetadata.value;
      // A missing immutable asset needs fresh transport references even when
      // the appearance is already memoized in this session.
      const appearance = cachedMetadata.value;
      const wallpapers = appearance?.wallpaper
        ? [appearance.wallpaper]
        : (appearance?.theme?.settings.flatMap(({ wallpaper }) => (wallpaper ? [wallpaper] : [])) ??
          []);
      for (const wallpaper of wallpapers) {
        if (wallpaper.hasFile && !(yield* cacheStore.loadBlob(`wallpaper:${wallpaper.id}`))) {
          missingImage = true;
          break;
        }
      }
      if (!missingImage && metadataIsFresh(cachedMetadata.savedAt, 60 * 60 * 1_000)) {
        return appearance;
      }
      if (missingImage) yield* resourceCache.forget(cacheKey);
    }
    let legacy: TelegramChatAppearance | undefined;
    if (!cachedMetadata) {
      const cachedBlob = yield* cacheStore.loadBlob(cacheKey);
      if (cachedBlob) {
        const entry = yield* Effect.tryPromise({
          try: () => cachedBlob.text(),
          catch: (error) => error,
        }).pipe(
          Effect.flatMap((text) => Effect.try(() => parseChatAppearanceCache(text))),
          Effect.orElseSucceed(() => undefined),
        );
        legacy = entry?.value;
        if (entry) yield* writeMetadata(cacheKey, entry.value);
      }
    }
    const fallback = cachedMetadata?.value ?? legacy;
    if (!currentSnapshot().online || !activeAccountId) return fallback;
    return yield* resourceCache.cached(cacheKey, () =>
      runTelegramOperation(
        () => telegramTransport.getChatAppearance!(peer),
        'Loading chat appearance',
      ).pipe(
        Effect.tap((value) => writeMetadata(cacheKey, value)),
        Effect.catch((error) =>
          fallback !== undefined ? Effect.succeed(fallback) : Effect.fail(error),
        ),
      ),
    );
  });
  const downloadWallpaper = Effect.fn('MessagingEngine.downloadWallpaper')(function* (
    wallpaperId: string,
  ) {
    if (!telegramTransport.downloadWallpaper) {
      return yield* Effect.fail(new Error('This Telegram transport cannot download backgrounds.'));
    }
    const cacheKey = `wallpaper:${wallpaperId}`;
    return yield* resourceCache.load(cacheKey, () => {
      return Effect.gen(function* () {
        const cached = yield* cacheStore.loadBlob(cacheKey);
        if (cached) return cached;
        const blob = yield* runTransportWithDeadline(
          () => telegramTransport.downloadWallpaper!(wallpaperId),
          MEDIA_DELIVERY_TIMEOUT_MS,
          'Background download timed out after 5 minutes.',
          'wallpaper-download',
        );
        yield* cacheStore.saveBlob(cacheKey, blob);
        return blob;
      });
    });
  });
  const searchStickers = Effect.fn('MessagingEngine.searchStickers')(function* (
    query: string,
    offset: number = 0,
  ) {
    const term = query.trim();
    if (!term) return { stickers: [] };
    if (!telegramTransport.searchStickers)
      return yield* Effect.fail(new Error('Sticker search is unavailable.'));
    return yield* runTelegramOperation(
      () => telegramTransport.searchStickers!(term, offset),
      'Searching stickers',
    );
  });
  const getRecentStickers = Effect.fn('MessagingEngine.getRecentStickers')(function* () {
    const session = sessionScope;
    const accountId = activeAccountId;
    const capturedMetadataGeneration = metadataGeneration;
    return yield* cachedStickerList(
      'sticker-index:recent:v2',
      () => telegramTransport.getRecentStickers(),
      session,
      accountId,
      capturedMetadataGeneration,
    );
  });
  let favoriteStickerVersion = 0;
  const getFavoriteStickers = Effect.fn('MessagingEngine.getFavoriteStickers')(function* () {
    const cacheKey = 'sticker-index:favorites:v1';
    const cached = yield* readMetadata<TelegramSticker[]>(cacheKey);
    if (!currentSnapshot().online || !activeAccountId) return cached?.value ?? [];
    const session = sessionScope;
    const accountId = activeAccountId;
    const version = favoriteStickerVersion;
    const values = yield* runTelegramOperation(
      () => telegramTransport.getFavoriteStickers?.() ?? Effect.succeed([]),
      'Loading favorite stickers',
    );
    if (version !== favoriteStickerVersion || !isOperationCurrent(session, accountId)) return [];
    yield* writeMetadata(cacheKey, values);
    return values;
  });
  const setStickerFavorite = Effect.fn('MessagingEngine.setStickerFavorite')(function* (
    sticker: TelegramSticker,
    favorite: boolean,
  ) {
    if (!telegramTransport.setStickerFavorite)
      return yield* Effect.fail(new Error('Favorite stickers are unavailable.'));
    const session = sessionScope;
    const accountId = activeAccountId;
    const changed = yield* runTelegramOperation(
      () => telegramTransport.setStickerFavorite!(sticker, favorite),
      favorite ? 'Adding favorite sticker' : 'Removing favorite sticker',
    );
    if (!changed)
      return yield* Effect.fail(new Error('Telegram did not update favorite stickers.'));
    if (!isOperationCurrent(session, accountId)) return;
    favoriteStickerVersion += 1;
    yield* cacheStore.deleteMetadata('sticker-index:favorites:v1');
    yield* invalidateResource({ kind: 'expressions' });
  });
  let stickerPacksVersion = 0;
  const getStickerPack = Effect.fn('MessagingEngine.getStickerPack')(function* (shortName: string) {
    if (!telegramTransport.getStickerPack)
      return yield* Effect.fail(new Error('Sticker packs are unavailable.'));
    return yield* runTelegramOperation(
      () => telegramTransport.getStickerPack!(shortName),
      'Loading sticker pack',
    );
  });
  const searchStickerPacks = Effect.fn('MessagingEngine.searchStickerPacks')(function* (
    query: string,
  ) {
    if (!query.trim() || !telegramTransport.searchStickerPacks) return [];
    return yield* runTelegramOperation(
      () => telegramTransport.searchStickerPacks!(query.trim()),
      'Searching sticker packs',
    );
  });
  const setStickerPackInstalled = Effect.fn('MessagingEngine.setStickerPackInstalled')(function* (
    pack: TelegramStickerPack,
    installed: boolean,
  ) {
    if (!telegramTransport.setStickerPackInstalled)
      return yield* Effect.fail(new Error('Sticker packs are unavailable.'));
    const session = sessionScope;
    const accountId = activeAccountId;
    const changed = yield* runTelegramOperation(
      () => telegramTransport.setStickerPackInstalled!(pack, installed),
      installed ? 'Adding sticker pack' : 'Removing sticker pack',
    );
    if (!changed) return yield* Effect.fail(new Error('Telegram did not update the sticker pack.'));
    if (!isOperationCurrent(session, accountId)) return;
    stickerPacksVersion += 1;
    yield* Effect.all([
      cacheStore.deleteMetadata('sticker-index:packs:v2'),
      cacheStore.deleteBlob('sticker-index:packs:v2'),
    ]);
    yield* invalidateResource({ kind: 'expressions' });
  });
  const getStickerPacks = Effect.fn('MessagingEngine.getStickerPacks')(function* () {
    const session = sessionScope;
    const accountId = activeAccountId;
    const capturedMetadataGeneration = metadataGeneration;
    const version = stickerPacksVersion;
    const cacheKey = 'sticker-index:packs:v2';
    const cachedMetadata = yield* readMetadata<TelegramStickerPack[]>(cacheKey);
    if (
      cachedMetadata &&
      (!currentSnapshot().online || cachedMetadata.value.every((pack) => pack.accessHash))
    )
      return cachedMetadata.value;
    const legacyBlob = yield* cacheStore.loadBlob(cacheKey);
    if (legacyBlob && !currentSnapshot().online) {
      const legacy = yield* Effect.tryPromise({
        try: () => legacyBlob.text(),
        catch: (error) => error,
      }).pipe(
        Effect.flatMap((text) => Effect.try(() => parseStickerPacksCache(text))),
        Effect.orElseSucceed(() => undefined),
      );
      if (legacy !== undefined) {
        yield* writeMetadata(cacheKey, legacy);
        return legacy;
      }
    }
    if (!currentSnapshot().online || !activeAccountId) return [];
    const packs = yield* runTelegramOperation(
      () => telegramTransport.getStickerPacks(),
      'Loading sticker packs',
    );
    if (
      !isOperationCurrent(session, accountId) ||
      capturedMetadataGeneration !== metadataGeneration ||
      version !== stickerPacksVersion
    )
      return [];
    yield* writeMetadata(cacheKey, packs);
    return isOperationCurrent(session, accountId) &&
      capturedMetadataGeneration === metadataGeneration
      ? packs
      : [];
  });
  const getSavedGifs = Effect.fn('MessagingEngine.getSavedGifs')(function* () {
    const session = sessionScope;
    const accountId = activeAccountId;
    const capturedMetadataGeneration = metadataGeneration;
    return yield* cachedStickerList(
      'sticker-index:gifs:v2',
      () => telegramTransport.getSavedGifs(),
      session,
      accountId,
      capturedMetadataGeneration,
    );
  });
  const searchGifs = Effect.fn('MessagingEngine.searchGifs')(function* (
    peer: TelegramPeer,
    query: string,
  ) {
    const term = query.trim();
    if (!term) return [];
    const cacheKey = queryMetadataKey('gif-search', [peer.id, term.toLocaleLowerCase()]);
    const cached = yield* readMetadata<TelegramSticker[]>(cacheKey);
    if (cached && !currentSnapshot().online) return cached.value;
    if (!telegramTransport.searchGifs || !currentSnapshot().online || !activeAccountId) {
      return cached?.value ?? [];
    }
    const results = yield* runTelegramOperation(
      () => telegramTransport.searchGifs!(peer, term),
      'Searching GIFs',
    );
    yield* writeMetadata(cacheKey, results);
    return results;
  });
  const cachedStickerList = Effect.fn('MessagingEngine.cachedStickerList')(function* (
    cacheKey: string,
    fetch: () => Effect.Effect<TelegramSticker[], TelegramTransportError>,
    session: Scope.Closeable | undefined,
    accountId: string | undefined,
    capturedMetadataGeneration: number,
  ) {
    const cachedMetadata = yield* readMetadata<TelegramSticker[]>(cacheKey);
    if (cachedMetadata) return cachedMetadata.value;
    const legacyBlob = yield* cacheStore.loadBlob(cacheKey);
    if (legacyBlob) {
      const legacy = yield* Effect.tryPromise({
        try: () => legacyBlob.text(),
        catch: (error) => error,
      }).pipe(
        Effect.flatMap((text) => Effect.try(() => parseStickerListCache(text))),
        Effect.orElseSucceed(() => undefined),
      );
      if (legacy !== undefined) {
        yield* writeMetadata(cacheKey, legacy);
        return legacy;
      }
    }
    if (!currentSnapshot().online || !activeAccountId) return [];
    const stickers = yield* runTelegramOperation(fetch, 'Loading Telegram expressions');
    if (
      !isOperationCurrent(session, accountId) ||
      capturedMetadataGeneration !== metadataGeneration
    )
      return [];
    yield* writeMetadata(cacheKey, stickers);
    return isOperationCurrent(session, accountId) &&
      capturedMetadataGeneration === metadataGeneration
      ? stickers
      : [];
  });
  const downloadSticker = Effect.fn('MessagingEngine.downloadSticker')(function* (
    sticker: TelegramSticker,
  ) {
    const cacheKey = `sticker:${sticker.id}`;
    return yield* resourceCache.load(cacheKey, () => {
      return Effect.gen(function* () {
        const cached = yield* cacheStore.loadBlob(cacheKey);
        if (cached) return cached;
        const blob = yield* runTransportWithDeadline(
          () => telegramTransport.downloadSticker(sticker),
          MEDIA_DELIVERY_TIMEOUT_MS,
          'Sticker download timed out after 5 minutes.',
          'sticker-download',
        );
        yield* cacheStore.saveBlob(cacheKey, blob);
        return blob;
      });
    });
  });
  const downloadCustomEmoji = Effect.fn('MessagingEngine.downloadCustomEmoji')(function* (
    documentId: string,
  ) {
    const cacheKey = `custom-emoji:${documentId}`;
    return yield* resourceCache.load(cacheKey, () => {
      return Effect.gen(function* () {
        const cached = yield* cacheStore.loadBlob(cacheKey);
        if (cached) return cached;
        if (!telegramTransport.downloadCustomEmoji) {
          return yield* Effect.fail(
            new Error('This Telegram transport cannot download custom emoji.'),
          );
        }
        const blob = yield* runTransportWithDeadline(
          () => telegramTransport.downloadCustomEmoji!(documentId),
          MEDIA_DELIVERY_TIMEOUT_MS,
          'Custom emoji download timed out after 5 minutes.',
          'custom-emoji-download',
        );
        yield* cacheStore.saveBlob(cacheKey, blob);
        return blob;
      });
    });
  });
  const getBotApp = Effect.fn('MessagingEngine.getBotApp')(function* (
    bot: TelegramPeer,
    shortName: string,
  ) {
    if (!telegramTransport.getBotApp)
      return yield* Effect.fail(new Error('Mini Apps are unavailable.'));
    return yield* telegramTransport.getBotApp(bot, shortName);
  });
  const requestWebApp = Effect.fn('MessagingEngine.requestWebApp')(function* (
    request: TelegramWebAppRequest,
  ) {
    if (!telegramTransport.requestWebApp)
      return yield* Effect.fail(new Error('Mini Apps are unavailable.'));
    return yield* runTelegramOperation(
      () => telegramTransport.requestWebApp!(request),
      'Opening Mini App',
    );
  });
  const prolongWebApp = Effect.fn('MessagingEngine.prolongWebApp')(function* (
    peer: TelegramPeer,
    bot: TelegramPeer,
    queryId: string,
  ) {
    if (!telegramTransport.prolongWebApp)
      return yield* Effect.fail(new Error('Mini Apps are unavailable.'));
    yield* telegramTransport.prolongWebApp(peer, bot, queryId);
  });
  const sendWebAppData = Effect.fn('MessagingEngine.sendWebAppData')(function* (
    bot: TelegramPeer,
    text: string,
    data: string,
  ) {
    if (!telegramTransport.sendWebAppData)
      return yield* Effect.fail(new Error('Mini Apps are unavailable.'));
    const id = yield* randomId();
    yield* runTelegramOperation(
      () => telegramTransport.sendWebAppData!(bot, text, data, id),
      'Sending Mini App data',
    );
  });
  const invokeWebAppMethod = Effect.fn('MessagingEngine.invokeWebAppMethod')(function* (
    bot: TelegramPeer,
    method: string,
    params: string,
  ) {
    if (!telegramTransport.invokeWebAppMethod)
      return yield* Effect.fail(new Error('Mini Apps are unavailable.'));
    return yield* telegramTransport.invokeWebAppMethod(bot, method, params);
  });
  const getBotCommands = Effect.fn('MessagingEngine.getBotCommands')(function* (
    peer: TelegramPeer,
  ) {
    if (!telegramTransport.getBotCommands) return [];
    const cacheKey = `bot-commands:${peer.id}`;
    const session = sessionScope;
    const accountId = activeAccountId;
    const capturedMetadataGeneration = metadataGeneration;
    const cached = yield* readMetadata<TelegramBotCommand[]>(cacheKey);
    if (cached && !currentSnapshot().online) {
      return cached.value;
    }
    if (!currentSnapshot().online || !activeAccountId) return cached?.value ?? [];
    return yield* resourceCache.cached(`request:${cacheKey}`, () =>
      trackLifecycleTask(() =>
        runTelegramOperation(
          () => telegramTransport.getBotCommands!({ ...peer }),
          'Loading bot commands',
        ).pipe(
          Effect.flatMap((commands) =>
            isOperationCurrent(session, accountId) &&
            capturedMetadataGeneration === metadataGeneration
              ? writeMetadata(cacheKey, commands).pipe(Effect.as(commands))
              : Effect.succeed([]),
          ),
          Effect.tapError((error) =>
            isOperationCurrent(session, accountId) &&
            capturedMetadataGeneration === metadataGeneration
              ? reportFailure('sync', "Could not load this bot's commands.", error)
              : Effect.void,
          ),
        ),
      ),
    );
  });
  const startBot = Effect.fn('MessagingEngine.startBot')(function* (
    peer: TelegramPeer,
    startParam: string = '',
  ) {
    if (!telegramTransport.startBot) {
      yield* sendDraft(peer, startParam ? `/start ${startParam}` : '/start');
      return;
    }
    const id = yield* randomUuid();
    const generatedRandomId = yield* randomId();
    const pending = sendQueue.create({
      id,
      accountId: activeAccountId ?? cachedAccountId,
      peer,
      text: startParam ? `/start ${startParam}` : '/start',
      randomId: generatedRandomId,
      createdAt: Date.now(),
      attempts: 0,
      botStart: { startParam },
    });
    yield* enqueuePending(pending);
  });
  const answerBotCallback = Effect.fn('MessagingEngine.answerBotCallback')(function* (
    peer: TelegramPeer,
    messageId: number,
    data: number[],
  ) {
    if (!telegramTransport.answerBotCallback) return undefined;
    const session = sessionScope;
    const accountId = activeAccountId;
    return yield* trackLifecycleTask(() => {
      return Effect.gen(function* () {
        return yield* Effect.gen(function* () {
          const result = yield* runTelegramOperation(
            () => telegramTransport.answerBotCallback!({ ...peer }, messageId, [...data]),
            'Running bot action',
          );
          return isOperationCurrent(session, accountId) ? result : undefined;
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (isOperationCurrent(session, accountId)) {
                yield* fail('sync', 'The bot button did not respond.', error, false);
              }
              return yield* Effect.fail(error);
            }),
          ),
        );
      });
    });
  });
  const requestUrlAuth = Effect.fn('MessagingEngine.requestUrlAuth')(function* (
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
  ) {
    if (!telegramTransport.requestUrlAuth) return undefined;
    const session = sessionScope;
    const accountId = activeAccountId;
    return yield* trackLifecycleTask(() => {
      return Effect.gen(function* () {
        return yield* Effect.gen(function* () {
          const result = yield* runTelegramOperation(
            () => telegramTransport.requestUrlAuth!({ ...peer }, messageId, buttonId),
            'Verifying bot link',
          );
          return isOperationCurrent(session, accountId) ? result : undefined;
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (isOperationCurrent(session, accountId)) {
                yield* fail('sync', 'Could not verify this bot link.', error, false);
              }
              return yield* Effect.fail(error);
            }),
          ),
        );
      });
    });
  });
  const acceptUrlAuth = Effect.fn('MessagingEngine.acceptUrlAuth')(function* (
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
    options?: TelegramUrlAuthAcceptOptions,
  ) {
    if (!telegramTransport.acceptUrlAuth) return undefined;
    const session = sessionScope;
    const accountId = activeAccountId;
    return yield* trackLifecycleTask(() => {
      return Effect.gen(function* () {
        return yield* Effect.gen(function* () {
          const result = yield* runTelegramOperation(
            () =>
              telegramTransport.acceptUrlAuth!(
                { ...peer },
                messageId,
                buttonId,
                options ? { ...options } : undefined,
              ),
            'Authorizing bot link',
          );
          return isOperationCurrent(session, accountId) ? result : undefined;
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (isOperationCurrent(session, accountId)) {
                yield* fail('sync', 'Could not authorize this bot link.', error, false);
              }
              return yield* Effect.fail(error);
            }),
          ),
        );
      });
    });
  });
  const updatePoll = Effect.fn('MessagingEngine.updatePoll')(function* (
    peer: TelegramPeer,
    messageId: number,
    action: TelegramPollAction,
    options: readonly string[] = [],
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    const message =
      histories.loaded(peer.id)?.messages.find((item) => item.id === messageId) ??
      (yield* cacheStore.loadMessage(peer.id, messageId));
    if (!isOperationCurrent(session, accountId)) return;
    if (!message?.poll || !telegramTransport.updatePoll)
      return yield* Effect.fail(new Error('This poll is unavailable.'));
    const poll = message.poll;
    if (action === 'vote') {
      if (pollIsClosed(poll)) return yield* Effect.fail(new Error('This poll is closed.'));
      if ((poll.quiz || poll.revotingDisabled) && pollHasVote(poll))
        return yield* Effect.fail(new Error('Your vote cannot be changed.'));
      if ((poll.quiz || !poll.multipleChoice) && options.length > 1)
        return yield* Effect.fail(new Error('Choose one answer.'));
      if (
        new Set(options).size !== options.length ||
        options.some((option) => !poll.answers.some((answer) => answer.option === option))
      )
        return yield* Effect.fail(new Error('Invalid poll answer.'));
      if (poll.quiz && options.length === 0)
        return yield* Effect.fail(new Error('Choose an answer.'));
    }
    const result = yield* runTelegramOperation(
      () => telegramTransport.updatePoll!(peer, messageId, poll, action, options),
      'Updating poll',
    );
    if (!isOperationCurrent(session, accountId)) return;
    yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
  });
  const sendPoll = Effect.fn('MessagingEngine.sendPoll')(function* (
    peer: TelegramPeer,
    draft: TelegramPollDraft,
    reply?: TelegramReplyTarget,
  ) {
    yield* requirePeerPermission(peer, 'canSendMessages', 'Sending polls');
    const dialog = dialogForPeer(peer.id);
    if (dialog && permissionsForDialog(dialog).canSendPolls === false)
      return yield* Effect.fail(new Error('Polls are not allowed in this chat.'));
    const error = pollDraftError(draft);
    if (error) return yield* Effect.fail(new Error(error));
    if (!telegramTransport.sendPoll)
      return yield* Effect.fail(new Error('Sending polls is unavailable.'));
    const pending = sendQueue.create({
      id: yield* randomUuid(),
      accountId: activeAccountId ?? cachedAccountId,
      peer,
      text: '',
      randomId: yield* randomId(),
      createdAt: Date.now(),
      attempts: 0,
      reply,
      pollDraft: draft,
    });
    yield* enqueuePending(pending);
  });
  const sendContact = Effect.fn('MessagingEngine.sendContact')(function* (
    peer: TelegramPeer,
    contact: TelegramContact,
    reply?: TelegramReplyTarget,
  ) {
    yield* requirePeerPermission(peer, 'canSendMessages', 'Sending contacts');
    if (!contact.firstName.trim() || !contact.phoneNumber.trim())
      return yield* Effect.fail(new Error('A contact needs a name and phone number.'));
    if (!telegramTransport.sendContact)
      return yield* Effect.fail(new Error('Contact sharing is unavailable.'));
    const pending = sendQueue.create({
      id: yield* randomUuid(),
      accountId: activeAccountId ?? cachedAccountId,
      peer,
      text: '',
      randomId: yield* randomId(),
      createdAt: Date.now(),
      attempts: 0,
      reply,
      contact,
    });
    yield* enqueuePending(pending);
  });
  const sendSticker = Effect.fn('MessagingEngine.sendSticker')(function* (
    peer: TelegramPeer,
    sticker: TelegramSticker,
    reply?: TelegramReplyTarget,
  ) {
    yield* requirePeerPermission(peer, 'canSendMessages', 'Sending messages');
    const isGif = isGifSticker(sticker);
    yield* requirePeerPermission(
      peer,
      isGif ? 'canSendGifs' : 'canSendStickers',
      isGif ? 'Sending GIFs' : 'Sending stickers',
    );
    const id = yield* randomUuid();
    const generatedRandomId = yield* randomId();
    const pending = sendQueue.create({
      id,
      accountId: activeAccountId ?? cachedAccountId,
      peer,
      text: '',
      randomId: generatedRandomId,
      createdAt: Date.now(),
      attempts: 0,
      sticker,
      reply,
    });
    yield* enqueuePending(pending);
  });
  const getManagedParticipants = Effect.fn('MessagingEngine.getManagedParticipants')(function* (
    peer: TelegramPeer,
    filter?: ChatParticipantFilter,
    query?: string,
    offset?: number,
  ) {
    if (!telegramTransport.getManagedParticipants)
      return yield* Effect.fail(new Error('Participant management is unavailable.'));
    return yield* telegramTransport.getManagedParticipants(peer, filter, query, offset);
  });
  const participantMutation = <A extends TransportMutationResult, E>(
    peer: TelegramPeer,
    effect: Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const session = sessionScope,
        accountId = activeAccountId;
      const result = yield* effect;
      if (!isOperationCurrent(session, accountId))
        return yield* Effect.fail(new Error('The active account changed.'));
      yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
      if (!isOperationCurrent(session, accountId))
        return yield* Effect.fail(new Error('The active account changed.'));
      yield* invalidateGroupMembers(peer.id);
      yield* invalidateResource({ kind: 'chat-management', peerId: peer.id });
      yield* refreshDialogHead(peer.id);
      return result;
    });
  const addChatMember = Effect.fn('MessagingEngine.addChatMember')(function* (
    peer: TelegramPeer,
    user: TelegramPeer,
  ) {
    if (!telegramTransport.addChatMember)
      return yield* Effect.fail(new Error('Adding members is unavailable.'));
    const result = yield* participantMutation(peer, telegramTransport.addChatMember(peer, user));
    return { missingUserIds: result.missingUserIds };
  });
  const editChatParticipant = Effect.fn('MessagingEngine.editChatParticipant')(function* (
    peer: TelegramPeer,
    user: TelegramPeer,
    change: ChatParticipantChange,
  ) {
    if (!telegramTransport.editChatParticipant)
      return yield* Effect.fail(new Error('Participant management is unavailable.'));
    if (change.kind === 'admin' && change.rank.length > 16)
      return yield* Effect.fail(new Error('Administrator titles can be up to 16 characters.'));
    if (
      change.kind === 'restrict' &&
      (!Number.isSafeInteger(change.untilDate) ||
        change.untilDate < 0 ||
        change.untilDate > 2147483647)
    )
      return yield* Effect.fail(new Error('Choose a valid restriction end date.'));
    yield* participantMutation(peer, telegramTransport.editChatParticipant(peer, user, change));
  });
  const getSavedMessagesInfo = Effect.fn('MessagingEngine.savedInfo')(function* () {
    if (!telegramTransport.getSavedMessagesInfo)
      return yield* Effect.fail(new Error('Saved Messages are unavailable.'));
    const session = sessionScope,
      accountId = activeAccountId;
    const info = yield* telegramTransport.getSavedMessagesInfo();
    if (!isOperationCurrent(session, accountId))
      return yield* Effect.fail(new Error('The active account changed.'));
    yield* addPeer({
      peer: info.peer,
      title: 'Saved Messages',
      initials: 'SM',
      color: '#5288c1',
      hasAvatar: false,
      category: 'user',
      bot: false,
      isContact: false,
    });
    return info;
  });
  const getSavedDialogs = Effect.fn('MessagingEngine.savedDialogs')(function* (
    offset?: SavedDialogsOffset,
  ) {
    if (!telegramTransport.getSavedDialogs)
      return yield* Effect.fail(new Error('Saved chats are unavailable.'));
    return yield* telegramTransport.getSavedDialogs(offset);
  });
  const getEarlierGroupHistory = Effect.fn('MessagingEngine.earlierGroupHistory')(function* (
    peer: TelegramPeer,
    beforeMessageId?: number,
  ) {
    if (peer.kind !== 'group')
      return yield* Effect.fail(new Error('Choose the original basic group.'));
    const session = sessionScope,
      accountId = activeAccountId,
      epoch = currentCacheEpoch;
    const historyVersion = histories.version(peer.id);
    const key = queryMetadataKey('earlier-group-history', [peer.id, beforeMessageId]);
    if (!currentSnapshot().online) {
      const cached = yield* readMetadata<import('../types').HistoryPage>(key);
      if (cached) return cached.value;
      const messages = (yield* cacheStore.loadMessagesBefore(
        peer.id,
        beforeMessageId ?? 2147483647,
        51,
      )).filter((message) => message.cacheEpoch === epoch);
      if (!messages.length)
        return yield* Effect.fail(new Error('Earlier history is unavailable offline.'));
      return { messages: messages.slice(-50), hasOlder: messages.length > 50 };
    }
    const revision = messageRevisions.capture();
    const page = yield* runTelegramOperation(
      () => telegramTransport.getHistory(peer, 50, beforeMessageId),
      'Loading earlier group history',
    );
    if (
      !isHistoryOperationCurrent(peer.id, historyVersion, session, accountId) ||
      epoch !== currentCacheEpoch
    )
      return yield* Effect.fail(new Error('The account or group history changed.'));
    const messages = messageRevisions.merge(
      peer.id,
      [],
      page.messages.filter((message) => message.peerId === peer.id),
      revision,
    );
    const result = { ...page, messages };
    yield* cacheStore.putMessages(messages.map((message) => ({ ...message, cacheEpoch: epoch })));
    yield* writeMetadata(key, result);
    return result;
  });
  const getSavedHistory = Effect.fn('MessagingEngine.savedHistory')(function* (
    source: TelegramPeer,
    beforeMessageId?: number,
  ) {
    if (!telegramTransport.getSavedHistory)
      return yield* Effect.fail(new Error('Saved history is unavailable.'));
    const session = sessionScope,
      accountId = activeAccountId,
      epoch = currentCacheEpoch;
    const page = yield* telegramTransport.getSavedHistory(source, 50, beforeMessageId);
    if (isOperationCurrent(session, accountId) && epoch === currentCacheEpoch)
      yield* cacheStore
        .putMessages(page.messages.map((message) => ({ ...message, cacheEpoch: epoch })))
        .pipe(
          Effect.catch((error) => reportFailure('cache', 'Could not cache saved messages.', error)),
        );
    return page;
  });
  const getSavedTags = Effect.fn('MessagingEngine.savedTags')(function* (source?: TelegramPeer) {
    if (!telegramTransport.getSavedTags)
      return yield* Effect.fail(new Error('Saved tags are unavailable.'));
    return yield* telegramTransport.getSavedTags(source);
  });
  const renameSavedTag = Effect.fn('MessagingEngine.renameSavedTag')(function* (
    reaction: string,
    title: string,
  ) {
    if (!telegramTransport.renameSavedTag)
      return yield* Effect.fail(new Error('Saved tags are unavailable.'));
    const session = sessionScope,
      accountId = activeAccountId;
    yield* telegramTransport.renameSavedTag(reaction, title.trim());
    if (isOperationCurrent(session, accountId))
      yield* invalidateResource({ kind: 'saved-messages' });
  });
  const pinSavedDialog = Effect.fn('MessagingEngine.pinSavedDialog')(function* (
    source: TelegramPeer,
    pinned: boolean,
  ) {
    if (!telegramTransport.pinSavedDialog)
      return yield* Effect.fail(new Error('Saved chats are unavailable.'));
    const session = sessionScope,
      accountId = activeAccountId;
    yield* telegramTransport.pinSavedDialog(source, pinned);
    if (isOperationCurrent(session, accountId))
      yield* invalidateResource({ kind: 'saved-messages' });
  });
  const saveSavedTagsNow = Effect.fn('MessagingEngine.saveSavedTagsNow')(function* (
    message: TelegramMessage,
    reactions: readonly string[],
    session: Scope.Closeable | undefined,
    accountId: string | undefined,
  ) {
    if (!telegramTransport.setSavedMessageTags)
      return yield* Effect.fail(new Error('Saved tags are unavailable.'));
    if (!isOperationCurrent(session, accountId)) return;
    // Telegram requires removing pre-tag reactions before converting them to tags.
    if (!message.reactionsAsTags && message.reactions?.length) {
      const cleared = yield* telegramTransport.setSavedMessageTags(message.id, []);
      if (!isOperationCurrent(session, accountId)) return;
      yield* queueMutationUpdateBatches(cleared.updateBatches, session, accountId);
      yield* applyReactionChange(
        message.peerId,
        message.id,
        [],
        undefined,
        { session, accountId },
        undefined,
        true,
      );
    }
    if (!isOperationCurrent(session, accountId)) return;
    const result = yield* telegramTransport.setSavedMessageTags(message.id, reactions);
    if (!isOperationCurrent(session, accountId)) return;
    yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
    yield* applyReactionChange(
      message.peerId,
      message.id,
      [...new Set(reactions)].map((emoji) => ({
        emoji,
        count: 1,
        chosen: true,
        ...(emoji.startsWith('custom:') ? { customEmojiId: emoji.slice(7) } : {}),
      })),
      undefined,
      { session, accountId },
      undefined,
      true,
    );
    yield* invalidateResource({ kind: 'saved-messages' });
  });
  const setSavedMessageTags = Effect.fn('MessagingEngine.setSavedMessageTags')(function* (
    messageId: number,
    reactions: readonly string[],
  ) {
    const session = sessionScope,
      accountId = activeAccountId,
      peerId = `u:${accountId}`;
    yield* runSerialized('reaction', `${peerId}:${messageId}`, () =>
      Effect.gen(function* () {
        const message =
          histories.loaded(peerId)?.messages.find((message) => message.id === messageId) ??
          (yield* cacheStore.loadMessage(peerId, messageId));
        if (!message)
          return yield* Effect.fail(new Error('Open the saved message before tagging it.'));
        yield* saveSavedTagsNow(message, reactions, session, accountId);
      }),
    );
  });
  const getAdminLog = Effect.fn('MessagingEngine.getAdminLog')(function* (
    peer: TelegramPeer,
    request?: AdminLogRequest,
  ) {
    if (!telegramTransport.getAdminLog)
      return yield* Effect.fail(new Error('Recent actions are unavailable.'));
    return yield* telegramTransport.getAdminLog(peer, request);
  });
  const upgradeChat = Effect.fn('MessagingEngine.upgradeChat')(function* (peer: TelegramPeer) {
    if (!telegramTransport.upgradeChat)
      return yield* Effect.fail(new Error('Upgrading this group is unavailable.'));
    const session = sessionScope,
      accountId = activeAccountId;
    const result = yield* telegramTransport.upgradeChat(peer);
    if (!isOperationCurrent(session, accountId))
      return yield* Effect.fail(new Error('The active account changed.'));
    yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
    if (!isOperationCurrent(session, accountId))
      return yield* Effect.fail(new Error('The active account changed.'));
    yield* addPeer({
      peer: result.peer,
      title: result.title,
      initials: result.title.slice(0, 2).toUpperCase(),
      color: '#5288c1',
      hasAvatar: false,
      category: 'group',
      bot: false,
      isContact: false,
    });
    yield* refreshDialogHead(result.peer.id).pipe(Effect.catch(() => Effect.void));
    yield* refreshDialogHead(peer.id).pipe(Effect.catch(() => Effect.void));
    yield* invalidateResource({ kind: 'chat-management', peerId: peer.id });
    return result.peer;
  });
  const getChatManagement = Effect.fn('MessagingEngine.getChatManagement')(function* (
    peer: TelegramPeer,
  ) {
    if (!telegramTransport.getChatManagement)
      return yield* Effect.fail(new Error('Chat management is unavailable.'));
    return yield* telegramTransport.getChatManagement(peer);
  });
  const setChatSetting = Effect.fn('MessagingEngine.setChatSetting')(function* (
    peer: TelegramPeer,
    change: ChatSettingChange,
  ) {
    if (!telegramTransport.setChatSetting)
      return yield* Effect.fail(new Error('Chat management is unavailable.'));
    if (change.kind === 'title' && (!change.value.trim() || change.value.length > 128))
      return yield* Effect.fail(new Error('Enter a name of up to 128 characters.'));
    if (change.kind === 'about' && change.value.length > 255)
      return yield* Effect.fail(new Error('The description must be at most 255 characters.'));
    if (change.kind === 'username' && change.value && !/^[a-z][a-z0-9_]{4,31}$/i.test(change.value))
      return yield* Effect.fail(
        new Error('Use 5–32 letters, numbers or underscores, starting with a letter.'),
      );
    if (
      change.kind === 'slowModeSeconds' &&
      ![0, 10, 30, 60, 300, 900, 3600].includes(change.value)
    )
      return yield* Effect.fail(new Error('Choose a supported slow mode interval.'));
    const session = sessionScope,
      accountId = activeAccountId;
    const result = yield* telegramTransport.setChatSetting(peer, change);
    if (!isOperationCurrent(session, accountId)) return;
    yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
    if (!isOperationCurrent(session, accountId)) return;
    yield* refreshDialogHead(peer.id);
    yield* invalidateResource({ kind: 'chat-management', peerId: peer.id });
    yield* invalidateResource({ kind: 'peer-metadata', peerId: peer.id });
    if (change.kind === 'forum')
      yield* invalidateResource({ kind: 'forum-topics', peerId: peer.id });
  });
  function validateInviteDraft(draft: ChatInviteLinkDraft) {
    if (draft.title.length > 32)
      return Effect.fail(new Error('Link names can be up to 32 characters.'));
    if (
      !Number.isSafeInteger(draft.expireDate) ||
      draft.expireDate < 0 ||
      draft.expireDate > 2147483647 ||
      (draft.expireDate > 0 && draft.expireDate <= Date.now() / 1000)
    )
      return Effect.fail(new Error('Choose an expiration time in the future.'));
    if (
      !Number.isSafeInteger(draft.usageLimit) ||
      draft.usageLimit < 0 ||
      draft.usageLimit > 100000
    )
      return Effect.fail(new Error('The usage limit must be between 1 and 100000, or unlimited.'));
    return Effect.void;
  }
  const inviteLinkMutation = <A, E>(peer: TelegramPeer, effect: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const session = sessionScope,
        accountId = activeAccountId;
      const result = yield* effect;
      if (isOperationCurrent(session, accountId))
        yield* invalidateResource({ kind: 'invite-links', peerId: peer.id });
      return result;
    });
  const getChatInviteLinks = Effect.fn('MessagingEngine.getChatInviteLinks')(function* (
    peer: TelegramPeer,
    revoked?: boolean,
    offset?: ChatInviteLinksOffset,
  ) {
    if (!telegramTransport.getChatInviteLinks)
      return yield* Effect.fail(new Error('Invitation links are unavailable.'));
    return yield* telegramTransport.getChatInviteLinks(peer, revoked, offset);
  });
  const exportChatInviteLink = Effect.fn('MessagingEngine.exportChatInviteLink')(function* (
    peer: TelegramPeer,
    draft: ChatInviteLinkDraft,
  ) {
    if (!telegramTransport.exportChatInviteLink)
      return yield* Effect.fail(new Error('Invitation links are unavailable.'));
    yield* validateInviteDraft(draft);
    return yield* inviteLinkMutation(peer, telegramTransport.exportChatInviteLink(peer, draft));
  });
  const editChatInviteLink = Effect.fn('MessagingEngine.editChatInviteLink')(function* (
    peer: TelegramPeer,
    url: string,
    draft: ChatInviteLinkDraft,
  ) {
    if (!telegramTransport.editChatInviteLink)
      return yield* Effect.fail(new Error('Invitation links are unavailable.'));
    yield* validateInviteDraft(draft);
    yield* inviteLinkMutation(peer, telegramTransport.editChatInviteLink(peer, url, draft));
  });
  const revokeChatInviteLink = Effect.fn('MessagingEngine.revokeChatInviteLink')(function* (
    peer: TelegramPeer,
    url: string,
  ) {
    if (!telegramTransport.revokeChatInviteLink)
      return yield* Effect.fail(new Error('Invitation links are unavailable.'));
    yield* inviteLinkMutation(peer, telegramTransport.revokeChatInviteLink(peer, url));
  });
  const deleteChatInviteLink = Effect.fn('MessagingEngine.deleteChatInviteLink')(function* (
    peer: TelegramPeer,
    url: string,
  ) {
    if (!telegramTransport.deleteChatInviteLink)
      return yield* Effect.fail(new Error('Invitation links are unavailable.'));
    yield* inviteLinkMutation(peer, telegramTransport.deleteChatInviteLink(peer, url));
  });
  const getJoinRequests = Effect.fn('MessagingEngine.getJoinRequests')(function* (
    peer: TelegramPeer,
    query?: string,
    offset?: JoinRequestOffset,
  ) {
    if (!telegramTransport.getJoinRequests)
      return yield* Effect.fail(new Error('Join requests are unavailable.'));
    return yield* telegramTransport.getJoinRequests(peer, query, offset);
  });
  const resolveRequests = <E>(
    peer: TelegramPeer,
    effect: Effect.Effect<TransportMutationResult, E>,
  ) =>
    Effect.gen(function* () {
      const session = sessionScope,
        accountId = activeAccountId;
      const result = yield* effect;
      if (!isOperationCurrent(session, accountId)) return;
      yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
      if (!isOperationCurrent(session, accountId)) return;
      yield* invalidateResource({ kind: 'join-requests', peerId: peer.id });
      yield* invalidateGroupMembers(peer.id);
      yield* refreshDialogHead(peer.id);
    });
  const resolveJoinRequest = Effect.fn('MessagingEngine.resolveJoinRequest')(function* (
    peer: TelegramPeer,
    user: TelegramPeer,
    approved: boolean,
  ) {
    if (!telegramTransport.resolveJoinRequest)
      return yield* Effect.fail(new Error('Join requests are unavailable.'));
    yield* resolveRequests(peer, telegramTransport.resolveJoinRequest(peer, user, approved));
  });
  const resolveAllJoinRequests = Effect.fn('MessagingEngine.resolveAllJoinRequests')(function* (
    peer: TelegramPeer,
    approved: boolean,
  ) {
    if (!telegramTransport.resolveAllJoinRequests)
      return yield* Effect.fail(new Error('Join requests are unavailable.'));
    yield* resolveRequests(peer, telegramTransport.resolveAllJoinRequests(peer, approved));
  });
  const checkChatInvite = Effect.fn('MessagingEngine.checkChatInvite')(function* (hash: string) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(hash))
      return yield* Effect.fail(new Error('Invalid invitation link.'));
    if (!telegramTransport.checkChatInvite)
      return yield* Effect.fail(new Error('Invitations are unavailable.'));
    return yield* telegramTransport.checkChatInvite(hash);
  });
  const joinChatInvite = Effect.fn('MessagingEngine.joinChatInvite')(function* (hash: string) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(hash))
      return yield* Effect.fail(new Error('Invalid invitation link.'));
    if (!telegramTransport.joinChatInvite)
      return yield* Effect.fail(new Error('Invitations are unavailable.'));
    const session = sessionScope,
      accountId = activeAccountId;
    const result = yield* telegramTransport.joinChatInvite(hash);
    if (!isOperationCurrent(session, accountId))
      return yield* Effect.fail(new Error('The active account changed.'));
    yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
    if (result.peer) yield* refreshDialogHead(result.peer.id);
    else if (result.status === 'joined') yield* refreshDialogHeads();
    return { status: result.status, peer: result.peer };
  });
  const createChat = Effect.fn('MessagingEngine.createChat')(function* (
    request: CreateChatRequest,
  ) {
    const title = request.title.trim();
    if (!title || title.length > 128)
      return yield* Effect.fail(new Error('Enter a name of up to 128 characters.'));
    if ((request.about?.length ?? 0) > 255)
      return yield* Effect.fail(new Error('The description must be at most 255 characters.'));
    const users = [...new Map(request.users.map((user) => [user.id, user])).values()];
    if (request.kind === 'group' && (!users.length || users.some((user) => user.kind !== 'user')))
      return yield* Effect.fail(new Error('Select at least one person for the group.'));
    if (!telegramTransport.createChat)
      return yield* Effect.fail(new Error('Creating chats is unavailable.'));
    const session = sessionScope,
      accountId = activeAccountId;
    // Creation has no idempotency key: never automatically retry a possibly successful request.
    const result = yield* telegramTransport.createChat({ ...request, title, users });
    if (!isOperationCurrent(session, accountId))
      return yield* Effect.fail(new Error('The active account changed.'));
    yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
    if (!isOperationCurrent(session, accountId))
      return yield* Effect.fail(new Error('The active account changed.'));
    yield* addPeer({
      peer: result.peer,
      title,
      initials: title.slice(0, 2).toUpperCase(),
      color: '#5288c1',
      hasAvatar: false,
      category: request.kind,
      bot: false,
      isContact: false,
    });
    yield* refreshDialogHead(result.peer.id).pipe(Effect.catch(() => Effect.void));
    return { peer: result.peer, missingUserIds: result.missingUserIds };
  });
  const forumMutation = <E>(
    peer: TelegramPeer,
    effect: Effect.Effect<TransportMutationResult, E>,
  ) =>
    Effect.gen(function* () {
      const session = sessionScope,
        accountId = activeAccountId;
      const result = yield* effect;
      if (!isOperationCurrent(session, accountId)) return;
      yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
      yield* invalidateResource({ kind: 'forum-topics', peerId: peer.id });
    });
  const deleteForumTopic = Effect.fn('MessagingEngine.deleteForumTopic')(function* (
    peer: TelegramPeer,
    topicId: number,
  ) {
    if (!telegramTransport.deleteForumTopic)
      return yield* Effect.fail(new Error('Forum topics are unavailable.'));
    if (!Number.isSafeInteger(topicId) || topicId <= 1)
      return yield* Effect.fail(new Error('The General topic cannot be deleted.'));
    const session = sessionScope,
      accountId = activeAccountId;
    const result = yield* telegramTransport.deleteForumTopic(peer, topicId);
    if (!isOperationCurrent(session, accountId)) return;
    invalidateHistory(peer.id);
    yield* cacheStore.replaceMessages(peer.id, []);
    yield* cacheStore.deletePinnedMessages(peer.id);
    yield* pinnedMessageCache.invalidate(peer.id);
    if (peer.kind === 'channel') yield* setChannelPts(peer.id, result.pts);
    else
      yield* queueMutationUpdateBatches(
        [{ updates: [{ type: 'pts-advanced', pts: result.pts, ptsCount: result.ptsCount }] }],
        session,
        accountId,
      );
    yield* refreshDialogHead(peer.id);
    yield* invalidateResource({
      kind: 'forum-topics',
      peerId: peer.id,
      queryId: `deleted:${topicId}`,
    });
  });
  const getForumTopic = Effect.fn('MessagingEngine.getForumTopic')(function* (
    peer: TelegramPeer,
    topicId: number,
  ) {
    if (!telegramTransport.getForumTopic)
      return yield* Effect.fail(new Error('Forum topics are unavailable.'));
    return yield* telegramTransport.getForumTopic(peer, topicId);
  });
  const getForumTopics = Effect.fn('MessagingEngine.getForumTopics')(function* (
    peer: TelegramPeer,
    query?: string,
    offset?: TelegramForumOffset,
  ) {
    if (!telegramTransport.getForumTopics)
      return yield* Effect.fail(new Error('Forum topics are unavailable.'));
    return yield* telegramTransport.getForumTopics(peer, query, offset);
  });
  const createForumTopic = Effect.fn('MessagingEngine.createForumTopic')(function* (
    peer: TelegramPeer,
    title: string,
    iconColor: number,
    iconEmojiId?: string,
  ) {
    if (!telegramTransport.createForumTopic)
      return yield* Effect.fail(new Error('Forum topics are unavailable.'));
    if (!title.trim() || title.trim().length > 128)
      return yield* Effect.fail(new Error('Use a topic name of 1–128 characters.'));
    yield* forumMutation(
      peer,
      telegramTransport.createForumTopic(
        peer,
        title.trim(),
        iconColor,
        yield* randomId(),
        iconEmojiId,
      ),
    );
  });
  const editForumTopic = Effect.fn('MessagingEngine.editForumTopic')(function* (
    peer: TelegramPeer,
    topicId: number,
    edit: TelegramForumEdit,
  ) {
    if (!telegramTransport.editForumTopic)
      return yield* Effect.fail(new Error('Forum topics are unavailable.'));
    if (edit.title !== undefined && (!edit.title.trim() || edit.title.trim().length > 128))
      return yield* Effect.fail(new Error('Use a topic name of 1–128 characters.'));
    yield* forumMutation(
      peer,
      telegramTransport.editForumTopic(peer, topicId, {
        ...edit,
        ...(edit.title !== undefined ? { title: edit.title.trim() } : {}),
      }),
    );
  });
  const pinForumTopic = Effect.fn('MessagingEngine.pinForumTopic')(function* (
    peer: TelegramPeer,
    topicId: number,
    pinned: boolean,
  ) {
    if (!telegramTransport.pinForumTopic)
      return yield* Effect.fail(new Error('Forum topics are unavailable.'));
    yield* forumMutation(peer, telegramTransport.pinForumTopic(peer, topicId, pinned));
  });
  const readForumTopic = Effect.fn('MessagingEngine.readForumTopic')(function* (
    peer: TelegramPeer,
    topicId: number,
    maxMessageId: number,
  ) {
    if (!telegramTransport.readForumTopic)
      return yield* Effect.fail(new Error('Forum topics are unavailable.'));
    const session = sessionScope,
      accountId = activeAccountId;
    yield* telegramTransport.readForumTopic(peer, topicId, maxMessageId);
    if (isOperationCurrent(session, accountId)) {
      yield* refreshDialogHead(peer.id);
      if (isOperationCurrent(session, accountId))
        yield* invalidateResource({ kind: 'forum-topics', peerId: peer.id });
    }
  });
  const getChatFolders = Effect.fn('MessagingEngine.getChatFolders')(function* () {
    const session = sessionScope,
      accountId = activeAccountId;
    const key = 'chat-folders:v1';
    if (!currentSnapshot().online || !telegramTransport.getChatFolders)
      return (yield* readMetadata<TelegramChatFolder[]>(key))?.value ?? [];
    const folders = yield* runTelegramOperation(
      () => telegramTransport.getChatFolders!(),
      'Loading chat folders',
    );
    if (!isOperationCurrent(session, accountId)) return [];
    yield* writeMetadata(key, folders);
    return folders;
  });
  const changeFolders = <A, E>(operation: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const session = sessionScope,
        accountId = activeAccountId;
      const result = yield* operation;
      if (isOperationCurrent(session, accountId))
        yield* invalidateResource({ kind: 'chat-folders' });
      return result;
    });
  const saveChatFolder = Effect.fn('MessagingEngine.saveChatFolder')(function* (
    folder: TelegramChatFolder,
  ) {
    if (!telegramTransport.saveChatFolder)
      return yield* Effect.fail(new Error('Chat folders are unavailable.'));
    if (
      !Number.isSafeInteger(folder.id) ||
      folder.id < 2 ||
      !folder.title.trim() ||
      Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(folder.title))
        .length > 12
    )
      return yield* Effect.fail(new Error('Use a folder name of 1–12 characters.'));
    if (!folder.categories.length && !folder.included.length && !folder.pinned.length)
      return yield* Effect.fail(new Error('Add at least one chat or chat type.'));
    yield* changeFolders(
      telegramTransport.saveChatFolder({ ...folder, title: folder.title.trim() }),
    );
  });
  const deleteChatFolder = Effect.fn('MessagingEngine.deleteChatFolder')(function* (id: number) {
    if (!telegramTransport.deleteChatFolder || id < 2)
      return yield* Effect.fail(new Error('This folder cannot be deleted.'));
    yield* changeFolders(telegramTransport.deleteChatFolder(id));
  });
  const reorderChatFolders = Effect.fn('MessagingEngine.reorderChatFolders')(function* (
    ids: number[],
  ) {
    if (!telegramTransport.reorderChatFolders)
      return yield* Effect.fail(new Error('Folder ordering is unavailable.'));
    yield* changeFolders(telegramTransport.reorderChatFolders(ids));
  });
  const getFolderLinks = Effect.fn('MessagingEngine.getFolderLinks')(function* (id: number) {
    if (!telegramTransport.getFolderLinks)
      return yield* Effect.fail(new Error('Folder links are unavailable.'));
    return yield* telegramTransport.getFolderLinks(id);
  });
  const exportFolderLink = Effect.fn('MessagingEngine.exportFolderLink')(function* (
    id: number,
    title: string,
    peers: TelegramPeer[],
  ) {
    if (!telegramTransport.exportFolderLink)
      return yield* Effect.fail(new Error('Folder links are unavailable.'));
    return yield* changeFolders(telegramTransport.exportFolderLink(id, title, peers));
  });
  const deleteFolderLink = Effect.fn('MessagingEngine.deleteFolderLink')(function* (
    id: number,
    slug: string,
  ) {
    if (!telegramTransport.deleteFolderLink)
      return yield* Effect.fail(new Error('Folder links are unavailable.'));
    yield* changeFolders(telegramTransport.deleteFolderLink(id, slug));
  });
  const checkFolderInvite = Effect.fn('MessagingEngine.checkFolderInvite')(function* (
    slug: string,
  ) {
    if (!telegramTransport.checkFolderInvite)
      return yield* Effect.fail(new Error('Folder invitations are unavailable.'));
    return yield* telegramTransport.checkFolderInvite(slug);
  });
  const joinFolderInvite = Effect.fn('MessagingEngine.joinFolderInvite')(function* (
    slug: string,
    peers: TelegramPeer[],
  ) {
    if (!telegramTransport.joinFolderInvite)
      return yield* Effect.fail(new Error('Folder invitations are unavailable.'));
    const session = sessionScope,
      accountId = activeAccountId;
    const result = yield* telegramTransport.joinFolderInvite(slug, peers);
    if (!isOperationCurrent(session, accountId)) return;
    yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
    yield* refreshDialogHeads(session);
    yield* invalidateResource({ kind: 'chat-folders' });
  });
  const joinFolderUpdates = Effect.fn('MessagingEngine.joinFolderUpdates')(function* (
    id: number,
    peers: TelegramPeer[],
  ) {
    if (!telegramTransport.joinFolderUpdates)
      return yield* Effect.fail(new Error('Folder invitations are unavailable.'));
    const session = sessionScope,
      accountId = activeAccountId;
    const result = yield* telegramTransport.joinFolderUpdates(id, peers);
    if (!isOperationCurrent(session, accountId)) return;
    yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
    yield* refreshDialogHeads(session);
    yield* invalidateResource({ kind: 'chat-folders' });
  });
  const getFolderUpdates = Effect.fn('MessagingEngine.getFolderUpdates')(function* (id: number) {
    if (!telegramTransport.getFolderUpdates)
      return yield* Effect.fail(new Error('Folder updates are unavailable.'));
    return yield* telegramTransport.getFolderUpdates(id);
  });
  const getPrivacy = Effect.fn('MessagingEngine.getPrivacy')(function* (key: TelegramPrivacyKey) {
    if (!telegramTransport.getPrivacy)
      return yield* Effect.fail(new Error('Privacy settings are unavailable.'));
    return yield* telegramTransport.getPrivacy(key);
  });
  const setPrivacy = Effect.fn('MessagingEngine.setPrivacy')(function* (
    key: TelegramPrivacyKey,
    change: TelegramPrivacyChange,
  ) {
    if (!telegramTransport.setPrivacy)
      return yield* Effect.fail(new Error('Privacy settings are unavailable.'));
    if (key === 'added-by-phone' && change.audience === 'nobody')
      return yield* Effect.fail(new Error('Choose Everybody or My Contacts for phone discovery.'));
    return yield* telegramTransport.setPrivacy(key, change);
  });
  const getReadTimePrivacy = Effect.fn('MessagingEngine.getReadTimePrivacy')(function* () {
    if (!telegramTransport.getReadTimePrivacy)
      return yield* Effect.fail(new Error('Read time privacy is unavailable.'));
    return yield* telegramTransport.getReadTimePrivacy();
  });
  const setReadTimePrivacy = Effect.fn('MessagingEngine.setReadTimePrivacy')(function* (
    hidden: boolean,
  ) {
    if (!telegramTransport.setReadTimePrivacy)
      return yield* Effect.fail(new Error('Read time privacy is unavailable.'));
    return yield* telegramTransport.setReadTimePrivacy(hidden);
  });
  const getActiveSessions = Effect.fn('MessagingEngine.getActiveSessions')(function* () {
    if (!telegramTransport.getActiveSessions)
      return yield* Effect.fail(new Error('Active sessions are unavailable.'));
    return yield* telegramTransport.getActiveSessions();
  });
  const terminateSession = Effect.fn('MessagingEngine.terminateSession')(function* (hash?: string) {
    const session = sessionScope,
      accountId = activeAccountId;
    if (!telegramTransport.terminateSession)
      return yield* Effect.fail(new Error('Session management is unavailable.'));
    if (hash !== undefined) {
      const page = yield* getActiveSessions();
      if (!isOperationCurrent(session, accountId)) return;
      const target = page.sessions.find((item) => item.id === hash);
      if (!target) return;
      if (target.current)
        return yield* Effect.fail(new Error('Use Log out to end the current session.'));
    }
    yield* telegramTransport.terminateSession(hash);
  });
  const setSessionTtl = Effect.fn('MessagingEngine.setSessionTtl')(function* (days: number) {
    if (!Number.isInteger(days) || days < 1 || days > 366)
      return yield* Effect.fail(new Error('Invalid session expiry.'));
    if (!telegramTransport.setSessionTtl)
      return yield* Effect.fail(new Error('Session expiry is unavailable.'));
    yield* telegramTransport.setSessionTtl(days);
  });
  const getPollVotes = Effect.fn('MessagingEngine.getPollVotes')(function* (
    peer: TelegramPeer,
    messageId: number,
    option?: string,
    offset?: string,
  ) {
    const message =
      histories.loaded(peer.id)?.messages.find((item) => item.id === messageId) ??
      (yield* cacheStore.loadMessage(peer.id, messageId));
    if (!message?.poll?.publicVoters || !telegramTransport.getPollVotes)
      return yield* Effect.fail(new Error('Voters are unavailable for this poll.'));
    if (option && !message.poll.answers.some((answer) => answer.option === option))
      return yield* Effect.fail(new Error('This poll option is no longer available.'));
    return yield* runTelegramOperation(
      () => telegramTransport.getPollVotes!(peer, messageId, option, offset),
      'Loading poll voters',
    );
  });
  const getMessageReadReceipts = Effect.fn('MessagingEngine.getMessageReadReceipts')(function* (
    peer: TelegramPeer,
    messageId: number,
  ): Effect.fn.Return<TelegramReadReceipts, unknown> {
    const message =
      histories.loaded(peer.id)?.messages.find((item) => item.id === messageId) ??
      (yield* cacheStore.loadMessage(peer.id, messageId));
    if (!message?.outgoing || message.service || !telegramTransport.getMessageReadReceipts)
      return { state: 'unavailable', people: [] };
    return yield* telegramTransport.getMessageReadReceipts(peer, messageId);
  });
  const getReactionPeople = Effect.fn('MessagingEngine.getReactionPeople')(function* (
    peer: TelegramPeer,
    messageId: number,
    emoji: string,
  ) {
    if (!telegramTransport.getReactionPeople) {
      return yield* Effect.fail(new Error('Reaction details are unavailable.'));
    }
    return yield* runTelegramOperation(
      () => telegramTransport.getReactionPeople!(peer, messageId, emoji),
      'Loading reaction details',
    );
  });
  const toggleReaction = Effect.fn('MessagingEngine.toggleReaction')(function* (
    peer: TelegramPeer,
    messageId: number,
    emoji: string,
  ) {
    const key = `${peer.id}:${messageId}`;
    const session = sessionScope;
    const accountId = activeAccountId;
    const operation = runSerialized('reaction', key, () =>
      toggleReactionNow(peer, messageId, emoji, key, session, accountId),
    );
    yield* operation;
  });
  const toggleReactionNow = Effect.fn('MessagingEngine.toggleReactionNow')(function* (
    peer: TelegramPeer,
    messageId: number,
    emoji: string,
    key: string,
    session: Scope.Closeable | undefined,
    accountId: string | undefined,
  ) {
    if (!isOperationCurrent(session, accountId)) return;
    const message =
      histories.loaded(peer.id)?.messages.find(({ id }) => id === messageId) ??
      (yield* cacheStore.loadMessage(peer.id, messageId));
    if (!isOperationCurrent(session, accountId)) return;
    if (!message) {
      const error = new Error('The message is not available in the local conversation history.');
      yield* fail('sync', 'Could not update the reaction.', error, false);
      return yield* Effect.fail(error);
    }
    const previous = message.reactions ?? [];
    if (peer.id === `u:${accountId}` && telegramTransport.setSavedMessageTags) {
      const chosen = previous
        .filter((reaction) => reaction.chosen)
        .map((reaction) => reaction.emoji);
      yield* saveSavedTagsNow(
        message,
        chosen.includes(emoji) ? chosen.filter((key) => key !== emoji) : [...chosen, emoji],
        session,
        accountId,
      );
      return;
    }
    const target = previous.some((reaction) => reaction.emoji === emoji && reaction.chosen)
      ? undefined
      : emoji;
    const optimistic = reactionsAfterChoice(previous, target);
    const version = nextReactionVersion(key);
    yield* applyReactionChange(peer.id, messageId, optimistic, version, { session, accountId });
    if (!isOperationCurrent(session, accountId)) return;
    yield* Effect.gen(function* () {
      const result = yield* runTelegramOperation(
        () => telegramTransport.setReaction(peer, messageId, target),
        'Updating reaction',
      );
      if (!isOperationCurrent(session, accountId)) return;
      yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!isOperationCurrent(session, accountId)) return;
          if (versions.current('reaction', key) === version) {
            yield* applyReactionChange(peer.id, messageId, previous, nextReactionVersion(key), {
              session,
              accountId,
            });
          }
          if (isOperationCurrent(session, accountId)) {
            yield* fail('sync', 'Could not update the reaction.', error, false);
          }
        }),
      ),
    );
  });
  const deleteMessage = Effect.fn('MessagingEngine.deleteMessage')(function* (
    peer: TelegramPeer,
    messageId: number,
    revoke: boolean,
  ) {
    const dialog = dialogForPeer(peer.id);
    const source = histories.loaded(peer.id)?.messages.find(({ id }) => id === messageId);
    if (!dialog) {
      return yield* Effect.fail(new Error('Deleting messages requires a loaded chat.'));
    }
    const permissions = permissionsForDialog(dialog);
    const capabilities = source ? messageCapabilities(dialog, source) : undefined;
    const canDelete =
      capabilities?.canDelete ?? (peer.kind === 'user' || permissions.canDeleteMessages);
    const canDeleteForMe = capabilities?.canDeleteForMe ?? peer.kind !== 'channel';
    const canDeleteForEveryone =
      capabilities?.canDeleteForEveryone ?? permissions.canDeleteForEveryone;
    if (!canDelete || (revoke && !canDeleteForEveryone) || (!revoke && !canDeleteForMe)) {
      return yield* Effect.fail(
        new Error(`Deleting this message is not available in ${dialog.title}.`),
      );
    }
    const session = sessionScope;
    const accountId = activeAccountId;
    const operationKey = `delete-message:${peer.id}:${messageId}`;
    const operationVersion = nextMutationVersion(operationKey);
    return yield* trackVersionedMutation(operationKey, operationVersion, () => {
      return Effect.gen(function* () {
        return yield* Effect.gen(function* () {
          const result = yield* runTelegramOperation(
            () => telegramTransport.deleteMessages(peer, [messageId], revoke),
            'Deleting message',
          );
          if (
            !isOperationCurrent(session, accountId) ||
            versions.current('mutation', operationKey) !== operationVersion
          ) {
            return false;
          }
          yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
          if (
            !isOperationCurrent(session, accountId) ||
            versions.current('mutation', operationKey) !== operationVersion
          ) {
            return false;
          }
          yield* applyUpdate(
            {
              type: 'delete-messages',
              pts: 0,
              ptsCount: 0,
              peerId: peer.id,
              messageIds: [messageId],
            },
            true,
          );
          return true;
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (isOperationCurrent(session, accountId)) {
                yield* fail('sync', 'Could not delete the message.', error, false);
              }
              return false;
            }),
          ),
        );
      });
    });
  });
  const editMessage = Effect.fn('MessagingEngine.editMessage')(function* (
    peer: TelegramPeer,
    messageId: number,
    text: string,
    formats?: TelegramTextFormat[],
    replacement?: EditMediaOptions,
  ) {
    const dialog = dialogForPeer(peer.id);
    const source = histories.loaded(peer.id)?.messages.find(({ id }) => id === messageId);
    if (!dialog) {
      return yield* Effect.fail(new Error('Editing messages requires a loaded chat.'));
    }
    if (
      dialog &&
      (source
        ? !messageCapabilities(dialog, source).canEdit
        : !permissionsForDialog(dialog).canEditMessages)
    ) {
      return yield* Effect.fail(new Error(`Editing messages is not available in ${dialog.title}.`));
    }
    const session = sessionScope;
    const accountId = activeAccountId;
    const operationKey = `edit-message:${peer.id}:${messageId}`;
    const operationVersion = nextMutationVersion(operationKey);
    return yield* trackVersionedMutation(operationKey, operationVersion, () => {
      return Effect.gen(function* () {
        return yield* Effect.gen(function* () {
          const result = yield* runTelegramOperation(
            () =>
              telegramTransport.editMessage(
                { ...peer },
                messageId,
                text,
                formats?.map((format) => ({ ...format })),
                replacement
                  ? {
                      file: new File([replacement.file], replacement.file.name, {
                        type: replacement.file.type,
                      }),
                      sendAs: replacement.sendAs,
                    }
                  : undefined,
              ),
            'Editing message',
          );
          if (
            !isOperationCurrent(session, accountId) ||
            versions.current('mutation', operationKey) !== operationVersion
          ) {
            return result.message;
          }
          if (replacement) {
            yield* cacheUploadedMedia(result.message, replacement.file, replacement.preview);
          }
          yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
          if (
            !isOperationCurrent(session, accountId) ||
            versions.current('mutation', operationKey) !== operationVersion
          ) {
            return result.message;
          }
          yield* applyUpdate(
            { type: 'edit-message', pts: 0, ptsCount: 0, message: result.message },
            true,
          );
          return result.message;
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (isOperationCurrent(session, accountId)) {
                yield* fail('sync', 'Could not edit the message.', error, false);
              }
              return yield* Effect.fail(error);
            }),
          ),
        );
      });
    });
  });
  const forwardMessage = Effect.fn('MessagingEngine.forwardMessage')(function* (
    fromPeer: TelegramPeer,
    toPeer: TelegramPeer,
    messageId: number,
    options?: TelegramForwardOptions,
  ) {
    const source =
      histories.loaded(fromPeer.id)?.messages.find(({ id }) => id === messageId) ??
      (yield* cacheStore.loadMessage(fromPeer.id, messageId));
    if (!source) {
      return yield* Effect.fail(
        new Error('The message is no longer available in the local conversation history.'),
      );
    }
    const sourceDialog = dialogForPeer(fromPeer.id);
    if (sourceDialog && !messageCapabilities(sourceDialog, source).canForward) {
      return yield* Effect.fail(
        new Error(`Forwarding this message is not available in ${sourceDialog.title}.`),
      );
    }
    const targetDialog = dialogForPeer(toPeer.id);
    if (
      (!targetDialog && toPeer.kind !== 'user') ||
      (targetDialog && !canSendMessageToDialog(targetDialog, source))
    ) {
      return yield* Effect.fail(
        new Error(`Sending messages is not available in ${targetDialog?.title ?? 'this chat'}.`),
      );
    }
    const pending = sendQueue.create({
      id: yield* randomUuid(),
      accountId: activeAccountId ?? cachedAccountId,
      peer: toPeer,
      reply:
        options?.topMessageId !== undefined
          ? { messageId: options.topMessageId, topMessageId: options.topMessageId }
          : undefined,
      text: options?.hideCaption && source.media ? '' : source.text,
      randomId: yield* randomId(),
      createdAt: Date.now(),
      attempts: 0,
      forward: {
        fromPeer,
        messageId,
        options,
        ...(source.media ? { mediaKind: source.media.kind } : {}),
      },
    });
    yield* enqueuePending(pending);
  });
  const downloadAndCacheAvatar = Effect.fn('MessagingEngine.downloadAndCacheAvatar')(function* (
    cacheKey: string,
    peer: TelegramPeer,
  ) {
    const cached = yield* cacheStore.loadBlob(cacheKey);
    if (cached) return cached;
    const blob = yield* runTelegramOperation(
      () => telegramTransport.downloadAvatar(peer),
      'Loading a Telegram avatar',
    );
    if (blob) yield* cacheStore.saveBlob(cacheKey, blob);
    return blob;
  });
  const reconcileStartup = Effect.fn('MessagingEngine.reconcileStartup')(function* (
    showProgress: boolean = true,
    session: Scope.Closeable | undefined = sessionScope,
  ) {
    if (!isLifecycleCurrent(session)) return;
    if (showProgress) yield* patch({ phase: 'syncing', sync: 'recovering' });
    else yield* patch({ sync: 'recovering' });
    const cursor = yield* runLocalOperation(
      () => cacheStore.loadCursor(),
      'Loading the synchronization cursor',
    );
    if (!isLifecycleCurrent(session)) return;

    if (!cursor) {
      const current = yield* runTelegramOperation(
        () => telegramTransport.getCurrentState(),
        'Loading Telegram synchronization state',
      );
      if (!isLifecycleCurrent(session)) return;
      yield* cacheStore.saveCursor(current);
      if (!isLifecycleCurrent(session)) return;
      yield* refreshDialogHeads(session);
      if (!isLifecycleCurrent(session)) return;
      hasReachedReady = true;
      yield* patch({ phase: 'ready', sync: 'current', online: true });
      return;
    }

    const difference = yield* runTelegramOperation(
      () => telegramTransport.getDifference(cursor, GLOBAL_DIFFERENCE_LIMIT),
      'Loading Telegram updates',
    );
    if (!isLifecycleCurrent(session)) return;
    const embeddedTooLong =
      difference.type === 'complete' &&
      difference.updates.some((update) => update.type === 'too-long');
    const clientBudgetExceeded =
      difference.type === 'complete' &&
      (difference.cursor.pts - cursor.pts > GLOBAL_DIFFERENCE_LIMIT ||
        difference.updates.length > GLOBAL_DIFFERENCE_LIMIT);
    if (difference.type === 'too-long' || embeddedTooLong || clientBudgetExceeded) {
      const nextCursor = difference.cursor;
      reportDiagnostic({
        code: 'large-update-backlog-skipped',
        level: 'info',
        area: 'sync',
        message: "Skipped a large update backlog and loaded Telegram's latest state.",
        details: {
          oldPts: cursor.pts,
          newPts: nextCursor.pts,
          recoveredUpdates: difference.type === 'complete' ? difference.updates.length : undefined,
        },
      });
      yield* replaceWithLatestState(nextCursor, session);
    } else {
      yield* batchSnapshotNotifications(
        Effect.gen(function* () {
          for (const update of difference.updates) {
            if (!isLifecycleCurrent(session)) return;
            if (update.type === 'channel-too-long') yield* recoverChannel(update.peerId, true);
            else yield* applyUpdate(update, !showProgress);
          }
          if (!isLifecycleCurrent(session)) return;
          yield* cacheStore.saveCursor(difference.cursor);
          if (!isLifecycleCurrent(session)) return;
          if (showProgress) {
            yield* refreshDialogHeads(session);
          }
          if (!isLifecycleCurrent(session)) return;
          hasReachedReady = true;
          yield* patch({ phase: 'ready', sync: 'current', online: true });
        }),
      );
      return;
    }
    if (!isLifecycleCurrent(session)) return;
    hasReachedReady = true;
    yield* patch({ phase: 'ready', sync: 'current', online: true });
  });
  const activateAuthorizedSession = Effect.fn('MessagingEngine.activateAuthorizedSession')(
    function* (
      claimLegacyAccount: boolean = false,
      session: Scope.Closeable | undefined = sessionScope,
    ) {
      if (!(yield* confirmAuthorizedAccount(claimLegacyAccount, session))) return;
      const accountId = activeAccountId;
      if (!isOperationCurrent(session, accountId)) return;
      if (session && updateSubscriptionSession !== session) {
        updateSubscriptionSession = session;
        yield* Stream.runForEach(telegramTransport.updates, (batch) =>
          Effect.gen(function* () {
            if (!isLifecycleCurrent(session)) return;
            yield* enqueueUpdateBatch(batch, session, { accountId: activeAccountId });
          }).pipe(Effect.ignore),
        ).pipe(Effect.forkIn(session, { startImmediately: true }));
      }
      yield* patch({
        authStep: undefined,
        qrLogin: undefined,
        codeViaApp: undefined,
        error: undefined,
        online: true,
      });
      yield* renewAccountReady();
      yield* Deferred.succeed(accountReadySignal, undefined);
      const startupSync = runSerialized('update', '', () =>
        isOperationCurrent(session, accountId) ? reconcileStartup(true, session) : Effect.void,
      ).pipe(
        Effect.catch((error) =>
          isOperationCurrent(session, accountId)
            ? fail('sync', 'Could not synchronize with Telegram.', error)
            : Effect.void,
        ),
      );
      yield* startupSync;
      if (!isOperationCurrent(session, accountId)) return;
      yield* flushOutbox();
    },
  );
  function cachedHistoryNeedsRepair(dialog: TelegramDialog, messages: readonly TelegramMessage[]) {
    if (messages.length === 0) return false;
    // A current update cursor does not guarantee that this peer's cached
    // history contains the latest dialog head, including sends from other devices.
    if (dialog.topMessageId > 0 && !messages.some(({ id }) => id === dialog.topMessageId)) {
      return true;
    }
    // Only channels have per-peer consecutive message IDs for album repair.
    if (dialog.peer.kind !== 'channel') return false;
    const albums = new Map<string, number[]>();
    for (const message of messages) {
      if (!message.groupedId) continue;
      const ids = albums.get(message.groupedId) ?? [];
      ids.push(message.id);
      albums.set(message.groupedId, ids);
    }
    for (const ids of albums.values()) {
      ids.sort((left, right) => left - right);
      if (ids.some((id, index) => index > 0 && id !== ids[index - 1]! + 1)) return true;
    }
    return false;
  }
  const scheduleCachedHistoryRepair = Effect.fn('MessagingEngine.scheduleCachedHistoryRepair')(
    function* (dialog: TelegramDialog, messages: readonly TelegramMessage[]) {
      if (!currentSnapshot().online || !cachedHistoryNeedsRepair(dialog, messages)) return;
      const peerId = dialog.peer.id;
      const session = sessionScope;
      const accountId = activeAccountId;
      const historyVersion = histories.version(peerId);
      const requestedCacheEpoch = currentCacheEpoch;
      yield* forkBackgroundTask(() =>
        resourceCache.load(`history-repair:${peerId}`, () => {
          return Effect.gen(function* () {
            const requestRevision = messageRevisions.capture();
            const page = yield* runTelegramOperation(
              () => telegramTransport.getHistory(dialog.peer, HISTORY_LIMIT, undefined),
              `Repairing ${dialog.title}`,
            );
            if (
              requestedCacheEpoch !== currentCacheEpoch ||
              !isHistoryOperationCurrent(peerId, historyVersion, session, accountId)
            ) {
              return;
            }
            yield* queueDialogStateOperation(() => {
              return Effect.gen(function* () {
                if (
                  requestedCacheEpoch !== currentCacheEpoch ||
                  !isHistoryOperationCurrent(peerId, historyVersion, session, accountId)
                ) {
                  return;
                }
                const fetched = messageRevisions.filter(
                  peerId,
                  page.messages.map((message) => ({ ...message, cacheEpoch: requestedCacheEpoch })),
                  requestRevision,
                );
                yield* cacheStore.putMessages(fetched);
                if (!isHistoryOperationCurrent(peerId, historyVersion, session, accountId)) return;
                const current = histories.loaded(peerId)?.messages ?? [];
                const merged = messageRevisions.merge(peerId, current, fetched, requestRevision);
                rememberHistory(
                  peerId,
                  { messages: merged, hasOlderMessages: page.hasOlder },
                  'newest',
                );
                for (const message of fetched) {
                  yield* publishConversationEvent({
                    type: 'message-upsert',
                    message,
                    insertIfMissing: true,
                  });
                }
              });
            });
          });
        }),
      );
    },
  );
  const confirmAuthorizedAccount = Effect.fn('MessagingEngine.confirmAuthorizedAccount')(function* (
    claimLegacyAccount: boolean,
    session: Scope.Closeable | undefined,
  ) {
    const accountId = yield* runTelegramOperation(
      () => telegramTransport.getAuthorizedAccountId(),
      'Confirming the Telegram account',
    );
    if (!isLifecycleCurrent(session)) return false;
    const storedAccountId = yield* runLocalOperation(
      () => cacheStore.loadAccountId(),
      'Loading the cached account identity',
    );
    if (!isLifecycleCurrent(session)) return false;
    activeAccountId = accountId;
    if (storedAccountId === undefined && claimLegacyAccount) {
      yield* runLocalOperation(
        () => cacheStore.claimAccount(accountId),
        'Claiming the local messaging workspace',
      );
      if (!isLifecycleCurrent(session)) return false;
    } else if (storedAccountId !== accountId) {
      // Let account-A cache writes that already entered storage finish before
      // account B clears the namespace. Queued continuations observe the new
      // account ID and self-cancel instead of repopulating the reset cache.
      yield* engineTasks.drainSerial([
        'dialogState',
        'metadataWrite',
        'draftWrite',
        'outboxWrite',
        'reaction',
      ]);

      if (!isLifecycleCurrent(session)) return false;
      yield* runLocalOperation(
        () => cacheStore.resetForAccount(accountId),
        'Resetting the local messaging workspace',
      );
      if (!isLifecycleCurrent(session)) return false;
      mayClaimLegacyAccount = false;
      cachedAccountId = accountId;
      currentCacheEpoch = 0;
      histories.clear();
      assignedMessageRandomIds.clear();
      yield* inboxReadMailbox.clear;
      yield* engineTasks.clearDelays('inboxRead');
      messageRevisions.clear();
      versions.clear();
      yield* resourceCache.clear;
      yield* invalidateMetadata;
      yield* pinnedMessageCache.clear;
      yield* groupMemberCache.clear;
      groupMemberPages.clear();
      yield* sendQueue.clear;
      yield* patch({ dialogs: [], drafts: {}, draftDetails: {}, pending: [] });
      return true;
    }

    mayClaimLegacyAccount = false;
    cachedAccountId = accountId;
    const compatible: PendingSend[] = [];
    for (const pending of currentSnapshot().pending) {
      if (pending.accountId && pending.accountId !== accountId) continue;
      const owned = sendQueue.capture(pending.accountId ? pending : { ...pending, accountId });
      if (!pending.accountId) yield* cacheStore.commitOutbox(owned);
      if (!isLifecycleCurrent(session)) return false;
      compatible.push(owned);
    }
    if (!isLifecycleCurrent(session)) return false;
    yield* patch({ pending: compatible });
    return true;
  });
  const refreshDialogHeads = Effect.fn('MessagingEngine.refreshDialogHeads')(function* (
    session: Scope.Closeable | undefined = sessionScope,
  ) {
    const previousDialogs = new Map(
      currentSnapshot().dialogs.map((dialog) => [
        dialog.peer.id,
        { version: versions.current('dialog', dialog.peer.id) },
      ]),
    );
    const page = yield* runTelegramOperation(
      () => telegramTransport.getDialogs(DIALOG_PAGE_LIMIT),
      'Loading the conversation list',
    );
    if (!isLifecycleCurrent(session)) return;
    yield* queueDialogStateOperation(() => {
      return Effect.gen(function* () {
        if (!isLifecycleCurrent(session)) return;
        const beforeCommit = currentSnapshot().dialogs;
        const visibleDialogs = reconcileDialogPage(
          page.dialogs,
          beforeCommit,
          previousDialogs,
          (peerId) => versions.current('dialog', peerId),
        ).map((dialog): CachedDialog => ({ ...dialog, cacheEpoch: currentCacheEpoch }));
        yield* cacheStore.replaceDialogs(visibleDialogs.filter((dialog) => !dialog.transient));
        if (!isLifecycleCurrent(session)) return;
        for (const peerId of new Set([
          ...beforeCommit.map(({ peer }) => peer.id),
          ...visibleDialogs.map(({ peer }) => peer.id),
        ])) {
          versions.next('dialog', peerId);
        }
        yield* patch({ dialogs: sortDialogs(visibleDialogs) });
      });
    });
  });
  const refreshDialogHead = Effect.fn('MessagingEngine.refreshDialogHead')(function* (
    peerId: string,
    removeIfMissing: boolean = false,
    ignoredTopMessageIds?: ReadonlySet<number>,
  ) {
    const storedPeer = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId)?.peer;
    const dialogVersion = versions.current('dialog', peerId);
    const fresh = yield* runTelegramOperation(
      () =>
        storedPeer && telegramTransport.getDialog
          ? telegramTransport.getDialog(storedPeer)
          : telegramTransport
              .getDialogs(DIALOG_PAGE_LIMIT)
              .pipe(Effect.map(({ dialogs }) => dialogs.find(({ peer }) => peer.id === peerId))),
      'Refreshing a conversation',
    );
    return yield* queueDialogStateOperation(() => {
      return Effect.gen(function* () {
        if (!fresh) {
          if (removeIfMissing) {
            const dialogs = currentSnapshot().dialogs.filter(({ peer }) => peer.id !== peerId);
            yield* cacheStore.replaceDialogs(
              dialogs
                .filter((dialog) => !dialog.transient)
                .map((dialog) => ({ ...dialog, cacheEpoch: currentCacheEpoch })),
            );
            versions.next('dialog', peerId);
            yield* patch({ dialogs });
          }
          return false;
        }
        if (ignoredTopMessageIds?.has(fresh.topMessageId)) return false;
        const previous = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
        const changedWhileLoading = versions.current('dialog', peerId) !== dialogVersion;
        if (changedWhileLoading && !previous) return false;
        const dialog: CachedDialog = {
          ...reconcileFetchedDialog(fresh, previous, changedWhileLoading),
          cacheEpoch: currentCacheEpoch,
        };
        versions.next('dialog', peerId);
        yield* patch({
          dialogs: sortDialogs([
            ...currentSnapshot().dialogs.filter(({ peer }) => peer.id !== peerId),
            dialog,
          ]),
        });
        if (!dialog.transient) {
          yield* cacheStore.putDialog(dialog);
        } else {
          // Remove an older, incorrectly persisted preview once Telegram confirms it.
          yield* cacheStore.replaceDialogs(
            currentSnapshot()
              .dialogs.filter((candidate) => candidate.peer.id !== peerId && !candidate.transient)
              .map((candidate) => ({ ...candidate, cacheEpoch: currentCacheEpoch })),
          );
        }
        return true;
      });
    });
  });
  const replaceWithLatestState = Effect.fn('MessagingEngine.replaceWithLatestState')(function* (
    cursor: import('../types').SyncCursor,
    session: Scope.Closeable | undefined = sessionScope,
  ) {
    const accountId = activeAccountId;
    const dialogVersions = new Map(
      currentSnapshot().dialogs.map(({ peer }) => [
        peer.id,
        { version: versions.current('dialog', peer.id) },
      ]),
    );
    const page = yield* runTelegramOperation(
      () => telegramTransport.getDialogs(DIALOG_PAGE_LIMIT),
      'Reloading the conversation list',
    );
    if (!isOperationCurrent(session, accountId)) return;

    yield* queueDialogStateOperation(() => {
      return Effect.gen(function* () {
        if (!isOperationCurrent(session, accountId)) return;
        const currentDialogs = currentSnapshot().dialogs;
        const freshDialogs = reconcileDialogPage(
          page.dialogs,
          currentDialogs,
          dialogVersions,
          (peerId) => versions.current('dialog', peerId),
        );
        const durableDialogs = freshDialogs.filter((dialog) => !dialog.transient);

        const peersBeforeCommit = new Set([
          ...currentDialogs.map(({ peer }) => peer.id),
          ...freshDialogs.map(({ peer }) => peer.id),
          ...histories.peerIds(),
        ]);

        const epoch = yield* queueMetadataWrite(() => {
          return Effect.gen(function* () {
            if (!isOperationCurrent(session, accountId)) return undefined;
            return yield* cacheStore.commitLatestState({
              cursor,
              dialogs: durableDialogs,
              discardBlobKeys: EXPRESSION_INDEX_CACHE_KEYS,
              discardMetadataKeys: EXPRESSION_INDEX_CACHE_KEYS,
            });
          });
        });
        if (epoch === undefined || !isOperationCurrent(session, accountId)) return undefined;

        const peersAfterCommit = new Set([
          ...peersBeforeCommit,
          ...freshDialogs.map(({ peer }) => peer.id),
          ...histories.peerIds(),
        ]);
        for (const peerId of peersAfterCommit) {
          histories.invalidate(peerId);
          yield* pinnedMessageCache.bump(peerId);
          versions.next('shared-counts', peerId);
          versions.next('dialog', peerId);
        }
        yield* invalidateMetadata;
        yield* resourceCache.clear;
        histories.clear({ preserveVersions: true });
        yield* inboxReadMailbox.clear;
        yield* engineTasks.clearDelays('inboxRead');
        messageRevisions.clear();
        yield* engineTasks.clearDelays('activity');
        currentCacheEpoch = epoch;
        const cachedDialogs = sortDialogs(
          freshDialogs.map((dialog) => ({ ...dialog, cacheEpoch: epoch })),
        );
        yield* patch({ dialogs: cachedDialogs, activities: [] });
        yield* invalidateResource({ kind: 'expressions' });
        yield* invalidateResource({ kind: 'bot-commands' });
        yield* publishConversationEvent({ type: 'history-reset' });
      });
    });
  });
  function enqueueUpdateBatch(
    batch: TransportUpdateBatch,
    session: Scope.Closeable | undefined = sessionScope,
    operation?: { accountId: string | undefined },
  ): Effect.Effect<void, unknown> {
    const processing = runSerialized('update', '', () =>
      isUpdateOperationCurrent(session, operation)
        ? applyLiveUpdateBatch(batch, session, operation)
        : Effect.void,
    );
    return processing.pipe(
      Effect.catch((error) =>
        isUpdateOperationCurrent(session, operation)
          ? fail('sync', 'Could not apply a Telegram update batch.', error)
          : Effect.void,
      ),
    );
  }
  const applyLiveUpdateBatch = Effect.fn('MessagingEngine.applyLiveUpdateBatch')(function* (
    batch: TransportUpdateBatch,
    session: Scope.Closeable | undefined,
    operation?: { accountId: string | undefined },
  ) {
    if (!isUpdateOperationCurrent(session, operation)) return;
    const cursor = yield* cacheStore.loadCursor();
    if (!isUpdateOperationCurrent(session, operation)) return;
    if (cursor && batch.seq !== undefined && batch.seq > 0) {
      if (batch.seq <= cursor.seq) return;
      const seqStart = batch.seqStart ?? batch.seq;
      if (seqStart > cursor.seq + 1) {
        yield* patch({ sync: 'recovering' });
        yield* reconcileStartup(false, session);
        return;
      }
    }
    const incomingPeerIds = new Set<string>();
    for (const update of batch.updates) {
      if (!isUpdateOperationCurrent(session, operation)) return;
      yield* applyLiveUpdate(update, session);
      if (update.type === 'new-message' && !update.message.outgoing) {
        incomingPeerIds.add(update.message.peerId);
      }
    }
    if (telegramTransport.getDialog) {
      for (const peerId of incomingPeerIds) {
        if (!isUpdateOperationCurrent(session, operation)) return;
        yield* refreshDialogHead(peerId);
      }
    }
    if ((batch.seq === undefined || batch.seq <= 0) && batch.date === undefined) return;
    const latest = yield* cacheStore.loadCursor();
    if (!latest || !isUpdateOperationCurrent(session, operation)) return;
    yield* cacheStore.saveCursor({
      ...latest,
      ...(batch.date !== undefined ? { date: Math.max(latest.date, batch.date) } : {}),
      ...(batch.seq !== undefined && batch.seq > 0 ? { seq: Math.max(latest.seq, batch.seq) } : {}),
    });
  });
  const acceptMutationUpdateBatches = Effect.fn('MessagingEngine.acceptMutationUpdateBatches')(
    function* (
      batches: TransportUpdateBatch[] | undefined,
      session: Scope.Closeable | undefined,
      accountId: string | undefined,
    ) {
      if (!batches?.length) return false;
      for (const batch of batches) {
        yield* enqueueUpdateBatch(batch, session, { accountId });
        if (!isOperationCurrent(session, accountId)) return true;
      }
      return true;
    },
  );
  const queueMutationUpdateBatches = Effect.fn('MessagingEngine.queueMutationUpdateBatches')(
    function* (
      batches: TransportUpdateBatch[] | undefined,
      session: Scope.Closeable | undefined,
      accountId: string | undefined,
    ) {
      if (!batches?.length) return false;
      for (const batch of batches) {
        yield* engineTasks.forkBackground(
          enqueueUpdateBatch(batch, session, { accountId }).pipe(Effect.ignore),
        );
      }
      return true;
    },
  );
  function enqueueSyntheticUpdates(
    updates: TransportUpdate[],
    session: Scope.Closeable | undefined = sessionScope,
    publish: boolean = true,
    operation?: { accountId: string | undefined },
  ) {
    const processing = runSerialized('update', '', () => {
      return Effect.gen(function* () {
        if (!isUpdateOperationCurrent(session, operation)) return;
        for (const update of updates) {
          if (!isUpdateOperationCurrent(session, operation)) return;
          yield* applyUpdate(update, publish);
        }
      });
    });
    return processing.pipe(
      Effect.catch((error) =>
        isUpdateOperationCurrent(session, operation)
          ? fail('sync', 'Could not apply a local Telegram update.', error)
          : Effect.void,
      ),
    );
  }
  const applyLiveUpdate = Effect.fn('MessagingEngine.applyLiveUpdate')(function* (
    update: TransportUpdate,
    session: Scope.Closeable | undefined = sessionScope,
  ) {
    if (!isLifecycleCurrent(session)) return;
    if (update.type === 'connection-state') {
      if (!update.connected) yield* handleConnectionLost();
      return;
    }
    if (update.type === 'too-long') {
      yield* reconcileStartup(false, session);
      return;
    }
    if (update.type === 'channel-too-long') {
      yield* recoverChannel(update.peerId, true);
      return;
    }
    if ('pts' in update && 'channelScoped' in update && update.channelScoped) {
      yield* applyChannelUpdate(update);
      return;
    }
    if ('pts' in update && (!('channelScoped' in update) || !update.channelScoped)) {
      const cursor = yield* cacheStore.loadCursor();
      if (cursor && update.pts <= cursor.pts) return;
      if (cursor && cursor.pts + update.ptsCount !== update.pts) {
        yield* patch({ sync: 'recovering' });
        yield* reconcileStartup(false, session);
        return;
      }
      yield* applyUpdate(update, true);
      if (cursor) {
        yield* cacheStore.saveCursor({ ...cursor, pts: update.pts });
      }
    } else {
      yield* applyUpdate(update, true);
    }
  });
  const applyChannelUpdate = Effect.fn('MessagingEngine.applyChannelUpdate')(function* (
    update: Extract<TransportUpdate, { pts: number }>,
  ) {
    if (update.type === 'read-message-contents') {
      // Content receipts carry no channel PTS and must not trigger recovery.
      yield* applyUpdate(update, true);
      return;
    }
    const peerId = updatePeerId(update);
    if (!peerId) {
      yield* applyUpdate(update, true);
      return;
    }
    let dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
    const neededBaseline = !dialog || dialog.channelPts === undefined;
    if (!dialog || dialog.channelPts === undefined) {
      yield* refreshDialogHead(peerId);
      dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
    }
    if (update.type === 'read-history') {
      if (!dialog) return;
      // Channel read updates do not carry an increment count (and outbox reads
      // carry no PTS at all). Apply them as idempotent side effects without
      // advancing or rejecting the channel PTS stream.
      yield* applyUpdate(update, true);
      return;
    }
    if (!dialog) {
      yield* applyUpdate(update, true);
      yield* setChannelPts(peerId, update.pts);
      return;
    }
    const currentPts = dialog.channelPts ?? 0;
    if (update.pts <= currentPts) {
      if (neededBaseline && update.type === 'new-message') {
        yield* applyUpdate({ ...update, type: 'edit-message' }, true);
      }
      return;
    }
    if (currentPts + update.ptsCount !== update.pts) {
      yield* recoverChannel(peerId);
      const recoveredPts = currentSnapshot().dialogs.find(
        ({ peer }) => peer.id === peerId,
      )?.channelPts;
      if (recoveredPts === undefined || update.pts <= recoveredPts) return;
      if (recoveredPts + update.ptsCount === update.pts) {
        yield* applyUpdate(update, true);
        yield* setChannelPts(peerId, update.pts);
      }
      return;
    }
    yield* applyUpdate(update, true);
    yield* setChannelPts(peerId, update.pts);
  });
  const recoverChannel = Effect.fn('MessagingEngine.recoverChannel')(function* (
    peerId: string,
    knownTooLong: boolean = false,
  ) {
    return yield* resourceCache.load(`channel-recovery:${peerId}`, () => {
      return Effect.gen(function* () {
        let completed = false;
        yield* Effect.gen(function* () {
          yield* patch({ sync: 'recovering' });
          let dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
          if (!dialog) {
            yield* refreshDialogHead(peerId);
            dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
          }
          if (!dialog) return;
          if (knownTooLong) {
            yield* resetChannelHistory(dialog.peer);
            completed = true;
            return;
          }
          const difference = yield* runTelegramOperation(
            () =>
              telegramTransport.getChannelDifference(
                dialog.peer,
                dialog.channelPts ?? 0,
                CHANNEL_DIFFERENCE_LIMIT,
              ),
            `Recovering ${dialog.title}`,
          );
          if (difference.type === 'too-long') {
            yield* resetChannelHistory(dialog.peer, difference.pts);
            completed = true;
            return;
          }
          for (const recovered of difference.updates) {
            if (recovered.type === 'too-long' || recovered.type === 'channel-too-long') {
              yield* resetChannelHistory(dialog.peer, difference.pts);
              completed = true;
              return;
            }
            yield* applyUpdate(recovered, true);
          }
          yield* setChannelPts(peerId, difference.pts);
          completed = true;
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (currentSnapshot().online) yield* patch({ sync: completed ? 'current' : 'stale' });
            }),
          ),
        );
      });
    });
  });
  const resetChannelHistory = Effect.fn('MessagingEngine.resetChannelHistory')(function* (
    peer: TelegramPeer,
    pts?: number,
  ) {
    invalidateHistory(peer.id);
    yield* cacheStore.replaceMessages(peer.id, []);
    yield* refreshDialogHead(peer.id);
    if (pts !== undefined) yield* setChannelPts(peer.id, pts);
    yield* publishConversationEvent({ type: 'history-reset', peerId: peer.id });
  });
  const setChannelPts = Effect.fn('MessagingEngine.setChannelPts')(function* (
    peerId: string,
    channelPts: number,
  ) {
    yield* queueDialogStateOperation(() => {
      return patchChannelPts(peerId, channelPts);
    });
  });
  const patchChannelPts = Effect.fn('MessagingEngine.patchChannelPts')(function* (
    peerId: string,
    channelPts: number,
  ) {
    const existing = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
    if (!existing || (existing.channelPts !== undefined && existing.channelPts >= channelPts))
      return;
    const dialogs = currentSnapshot().dialogs.map((dialog) =>
      dialog.peer.id === peerId ? { ...dialog, channelPts } : dialog,
    );
    const changed = dialogs.find(({ peer }) => peer.id === peerId);
    if (!changed) return;
    versions.next('dialog', peerId);
    yield* patch({ dialogs });
    if (!changed.transient)
      yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
  });
  function updatePeerId(update: Extract<TransportUpdate, { pts: number }>) {
    if (update.type === 'new-message' || update.type === 'edit-message') {
      return update.message.peerId;
    }
    return 'peerId' in update ? update.peerId : undefined;
  }
  const applyUpdate = Effect.fn('MessagingEngine.applyUpdate')(function* (
    update: TransportUpdate,
    publish: boolean,
  ): Effect.fn.Return<void, unknown> {
    if (update.type === 'too-long' || update.type === 'channel-too-long') return;
    if (update.type === 'read-message-contents') {
      const session = sessionScope;
      const accountId = activeAccountId;
      return yield* queueDialogStateOperation(() =>
        Effect.gen(function* () {
          if (!isOperationCurrent(session, accountId)) return;
          const peerIds = update.peerId
            ? [update.peerId]
            : [
                ...new Set([
                  ...(yield* cacheStore.findMessagePeers(update.messageIds)),
                  ...histories.peerIds(),
                ]),
              ].filter((peerId) => !isChannelPeerId(peerId));
          if (!isOperationCurrent(session, accountId)) return;
          for (const peerId of peerIds) {
            for (const messageId of update.messageIds) {
              const stored = yield* cacheStore.loadMessage(peerId, messageId);
              if (!isOperationCurrent(session, accountId)) return;
              const previous =
                histories.loaded(peerId)?.messages.find(({ id }) => id === messageId) ?? stored;
              if (
                !previous ||
                (previous.mediaUnread === false &&
                  !previous.unreadMention &&
                  !previous.unreadReaction)
              )
                continue;
              messageRevisions.record(peerId, messageId);
              const message = {
                ...previous,
                mediaUnread: false,
                unreadMention: false,
                unreadReaction:
                  update.expectedReactionVersion === undefined ||
                  versions.current('reaction', `${peerId}:${messageId}`) ===
                    update.expectedReactionVersion
                    ? false
                    : previous.unreadReaction,
                cacheEpoch: currentCacheEpoch,
              };
              yield* cacheStore.putMessage(message);
              if (!isOperationCurrent(session, accountId)) return;
              histories.updateLoaded(peerId, (history) => ({
                ...history,
                messages: history.messages.map((candidate) =>
                  candidate.id === messageId ? message : candidate,
                ),
              }));
              const dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
              if (dialog) {
                const changed = {
                  ...dialog,
                  ...(dialog.topMessageId === messageId ? { topMessage: message } : {}),
                  unreadMentionsCount: Math.max(
                    0,
                    (dialog.unreadMentionsCount ?? 0) - Number(Boolean(previous.unreadMention)),
                  ),
                  unreadReactionsCount: Math.max(
                    0,
                    (dialog.unreadReactionsCount ?? 0) -
                      Number(Boolean(previous.unreadReaction && !message.unreadReaction)),
                  ),
                };
                versions.next('dialog', peerId);
                yield* patch({
                  dialogs: currentSnapshot().dialogs.map((candidate) =>
                    candidate.peer.id === peerId ? changed : candidate,
                  ),
                });
                if (!changed.transient)
                  yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
                if (!isOperationCurrent(session, accountId)) return;
              }
              if (publish) yield* publishConversationEvent({ type: 'message-upsert', message });
            }
          }
        }),
      );
    }
    let messageUpdate:
      | Extract<TransportUpdate, { type: 'new-message' | 'edit-message' }>
      | undefined;
    if (update.type === 'message-id-assigned') {
      const pending = currentSnapshot().pending.find(
        (send) =>
          send.randomId === update.randomId ||
          send.album?.attachments.some(({ randomId }) => randomId === update.randomId),
      );
      if (!pending) return;
      const key = `${pending.peer.id}:${update.messageId}`;
      assignedMessageRandomIds.set(key, update.randomId);
      const existing =
        histories.loaded(pending.peer.id)?.messages.find(({ id }) => id === update.messageId) ??
        (yield* cacheStore.loadMessage(pending.peer.id, update.messageId));
      if (!existing) return;
      if (!existing.outgoing || existing.randomId === update.randomId) {
        assignedMessageRandomIds.delete(key);
        return;
      }
      messageUpdate = {
        type: 'edit-message',
        pts: 0,
        ptsCount: 0,
        message: { ...existing, randomId: update.randomId },
      };
      assignedMessageRandomIds.delete(key);
    } else if (update.type === 'new-message' || update.type === 'edit-message') {
      messageUpdate = update;
    }
    if (messageUpdate) {
      if (
        messageUpdate.message.service?.kind === 'topic-created' ||
        messageUpdate.message.service?.kind === 'topic-changed'
      )
        yield* invalidateResource({ kind: 'forum-topics', peerId: messageUpdate.message.peerId });
      const existingMessage =
        histories
          .loaded(messageUpdate.message.peerId)
          ?.messages.find(({ id }) => id === messageUpdate.message.id) ??
        (yield* cacheStore.loadMessage(messageUpdate.message.peerId, messageUpdate.message.id));
      const assignedRandomId = messageUpdate.message.outgoing
        ? assignedMessageRandomIds.get(
            `${messageUpdate.message.peerId}:${messageUpdate.message.id}`,
          )
        : undefined;
      const randomId =
        messageUpdate.message.randomId ?? assignedRandomId ?? existingMessage?.randomId;
      const message: CachedMessage = {
        ...messageUpdate.message,
        ...(randomId ? { randomId } : {}),
        cacheEpoch: currentCacheEpoch,
      };
      if (assignedRandomId) {
        assignedMessageRandomIds.delete(`${message.peerId}:${message.id}`);
      }
      if (messageUpdate.type === 'edit-message') {
        yield* invalidateEditedMedia(existingMessage, message);
      }
      const upload = pendingMediaForMessage(currentSnapshot().pending, message);
      if (upload) {
        // Keep the uploaded media available before publishing the confirmation or
        // removing its outbox record, including when the server echo arrives first.
        yield* cacheUploadedMedia(message, upload.attachment.blob, upload.attachment.preview);
      }
      const isNewMessage = messageUpdate.type === 'new-message' && !existingMessage;
      messageRevisions.record(message.peerId, message.id);
      if (isNewMessage && !message.outgoing) {
        versions.next('unread', message.peerId);
      }
      yield* cacheStore.putMessage(message);
      if (
        isNewMessage &&
        (message.service?.kind === 'users-added' || message.service?.kind === 'user-removed')
      ) {
        yield* invalidateGroupMembers(message.peerId);
      }
      const loaded = histories.loaded(message.peerId);
      if (loaded) {
        histories.updateLoaded(message.peerId, (history) => ({
          ...history,
          messages: histories.boundMessages(
            message.peerId,
            [...history.messages.filter((current) => current.id !== message.id), message],
            histories.mode(message.peerId) ?? 'newest',
          ),
        }));
      } else {
        rememberHistory(
          message.peerId,
          { messages: [message], hasOlderMessages: message.id > 1 },
          'newest',
        );
      }
      yield* updateDialogHead(message, isNewMessage);
      if (publish) {
        yield* publishConversationEvent({
          type: 'message-upsert',
          message,
          // A new message can arrive after a newer one is already shown, for example when
          // a history page loaded between two updates. It belongs in the view either way.
          ...(message.outgoing || isNewMessage ? { insertIfMissing: true } : {}),
        });
      }
      return;
    }
    if (update.type === 'web-page-updated') {
      const peerIds = update.peerId ? [update.peerId] : histories.peerIds();
      for (const peerId of peerIds) {
        const loaded = histories.loaded(peerId);
        if (!loaded) continue;
        const matching = loaded.messages.filter(
          ({ linkPreview }) => linkPreview?.webPageId === update.webPageId,
        );
        for (const previous of matching) {
          const message: CachedMessage = {
            ...previous,
            linkPreview: {
              ...update.linkPreview,
              ...(previous.linkPreview?.photoSize
                ? { photoSize: previous.linkPreview.photoSize }
                : {}),
            },
            cacheEpoch: currentCacheEpoch,
          };
          yield* invalidateEditedMedia(previous, message);
          messageRevisions.record(peerId, message.id);
          yield* cacheStore.putMessage(message);
          histories.updateLoaded(peerId, (history) => ({
            ...history,
            messages: history.messages.map((candidate) =>
              candidate.id === message.id ? message : candidate,
            ),
          }));
          yield* updateDialogHead(message, false);
          if (publish) {
            yield* publishConversationEvent({ type: 'message-upsert', message });
          }
        }
      }
      return;
    }
    if (update.type === 'delete-messages') {
      const messagePeers = new Map<string, Set<number>>();
      if (update.peerId) {
        messagePeers.set(update.peerId, new Set(update.messageIds));
      } else {
        const candidatePeerIds = new Set<string>(
          (yield* cacheStore.findMessagePeers(update.messageIds)).filter((peerId) =>
            update.channelScoped ? isChannelPeerId(peerId) : !isChannelPeerId(peerId),
          ),
        );
        for (const peerId of histories.peerIds()) {
          if (isChannelPeerId(peerId) === Boolean(update.channelScoped)) {
            candidatePeerIds.add(peerId);
          }
        }
        const peersByMessageId = new Map<number, Set<string>>();
        for (const peerId of candidatePeerIds) {
          const loaded = histories.loaded(peerId);
          for (const messageId of update.messageIds) {
            const inHistory = loaded?.messages.some(({ id }) => id === messageId) ?? false;
            const inCache = inHistory || Boolean(yield* cacheStore.loadMessage(peerId, messageId));
            if (!inCache) continue;
            const peers = peersByMessageId.get(messageId) ?? new Set<string>();
            peers.add(peerId);
            peersByMessageId.set(messageId, peers);
          }
        }
        for (const [messageId, peers] of peersByMessageId) {
          // An unscoped update cannot safely identify a message when the same
          // numeric ID exists in more than one peer. Leave those records intact
          // until a peer-scoped update or a fresh history identifies them.
          if (peers.size !== 1) continue;
          const peerId = peers.values().next().value as string;
          const ids = messagePeers.get(peerId) ?? new Set<number>();
          ids.add(messageId);
          messagePeers.set(peerId, ids);
        }
      }
      if (messagePeers.size === 0) return;
      for (const [peerId, ids] of messagePeers) {
        for (const messageId of ids) messageRevisions.record(peerId, messageId);
        yield* cacheStore.deleteMessages(peerId, [...ids]);
      }
      const affectedDialogPeers: string[] = [];
      for (const peerId of histories.peerIds()) {
        const loaded = histories.loaded(peerId);
        if (!loaded) continue;
        const deleted = messagePeers.get(peerId);
        if (deleted) {
          histories.updateLoaded(peerId, (history) => ({
            ...history,
            messages: history.messages.filter((message) => !deleted.has(message.id)),
          }));
        }
      }
      const heads = new Map<string, TelegramMessage | undefined>();
      for (const dialog of currentSnapshot().dialogs) {
        const deleted = messagePeers.get(dialog.peer.id);
        if (!deleted || !deleted.has(dialog.topMessageId)) continue;
        affectedDialogPeers.push(dialog.peer.id);
        heads.set(
          dialog.peer.id,
          sortMessages(yield* cacheStore.loadMessages(dialog.peer.id, 1)).at(-1),
        );
      }
      // The heads were read asynchronously; apply them to the dialogs as they are now.
      const dialogs = currentSnapshot().dialogs.map((dialog): TelegramDialog => {
        if (!heads.has(dialog.peer.id)) return dialog;
        const topMessage = heads.get(dialog.peer.id);
        return { ...dialog, topMessageId: topMessage?.id ?? 0, topMessage };
      });
      for (const peerId of affectedDialogPeers) versions.next('dialog', peerId);
      yield* patch({ dialogs: sortDialogs(dialogs) });
      for (const dialog of dialogs) {
        if (heads.has(dialog.peer.id) && !dialog.transient)
          yield* cacheStore.putDialog({ ...dialog, cacheEpoch: currentCacheEpoch });
      }
      for (const peerId of affectedDialogPeers) {
        const local = dialogs.find(({ peer }) => peer.id === peerId);
        yield* refreshDialogHead(
          peerId,
          local?.topMessageId === 0,
          messagePeers.get(peerId) ?? new Set<number>(),
        );
      }
      if (publish) {
        yield* Effect.all(
          [...messagePeers].map(([peerId, ids]) =>
            publishConversationEvent({ type: 'messages-delete', peerId, messageIds: [...ids] }),
          ),
          { discard: true },
        );
      }
      return;
    }
    if (update.type === 'read-history') {
      if (update.direction === 'inbox') {
        versions.next('unread', update.peerId);
      }
      const dialogs = currentSnapshot().dialogs.map((dialog) => {
        if (dialog.peer.id !== update.peerId) return dialog;
        return update.direction === 'inbox'
          ? {
              ...dialog,
              readInboxMaxId: Math.max(dialog.readInboxMaxId, update.maxMessageId),
              unreadCount: update.stillUnreadCount ?? 0,
            }
          : { ...dialog, readOutboxMaxId: Math.max(dialog.readOutboxMaxId, update.maxMessageId) };
      });
      versions.next('dialog', update.peerId);
      yield* patch({ dialogs });
      const changed = dialogs.find(({ peer }) => peer.id === update.peerId);
      if (changed && !changed.transient) {
        yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
      }
      return;
    }
    if (update.type === 'poll-changed') {
      const candidates = new Map<string, TelegramMessage>();
      for (const peerId of histories.peerIds())
        for (const message of histories.loaded(peerId)?.messages ?? [])
          if (message.poll?.id === update.pollId)
            candidates.set(`${peerId}:${message.id}`, message);
      for (const dialog of currentSnapshot().dialogs)
        if (dialog.topMessage?.poll?.id === update.pollId)
          candidates.set(`${dialog.peer.id}:${dialog.topMessage.id}`, dialog.topMessage);
      if (update.peerId && update.messageId !== undefined) {
        const stored = yield* cacheStore.loadMessage(update.peerId, update.messageId);
        if (stored?.poll?.id === update.pollId && !candidates.has(`${stored.peerId}:${stored.id}`))
          candidates.set(`${stored.peerId}:${stored.id}`, stored);
      }
      for (const message of candidates.values()) {
        const previous = message.poll!;
        const poll = {
          ...(update.poll ?? previous),
          results: mergePollResults(previous.results, update.results),
        };
        yield* applyUpdate(
          { type: 'edit-message', pts: 0, ptsCount: 0, message: { ...message, poll } },
          true,
        );
      }
      return;
    }
    if (update.type === 'reaction-changed') {
      yield* applyReactionChange(
        update.peerId,
        update.messageId,
        update.reactions,
        undefined,
        undefined,
        update.unreadReaction,
        update.reactionsAsTags,
      );
      return;
    }
    if (update.type === 'activity') {
      const key = `${update.activity.peerId}:${update.activity.senderId}`;
      yield* patch({
        activities: [
          ...currentSnapshot().activities.filter(
            (activity) => `${activity.peerId}:${activity.senderId}` !== key,
          ),
          update.activity,
        ],
      });
      yield* engineTasks.delay(
        'activity',
        key,
        6000,
        Effect.gen(function* () {
          yield* patch({
            activities: currentSnapshot().activities.filter(
              (activity) => `${activity.peerId}:${activity.senderId}` !== key,
            ),
          });
        }),
      );
      return;
    }
    if (update.type === 'activity-ended') {
      const key = `${update.peerId}:${update.senderId}`;
      yield* engineTasks.cancelDelay('activity', key);
      yield* patch({
        activities: currentSnapshot().activities.filter(
          (activity) => `${activity.peerId}:${activity.senderId}` !== key,
        ),
      });
      return;
    }
    if (update.type === 'presence-changed') {
      const dialogs = currentSnapshot().dialogs.map((dialog) =>
        dialog.peer.id === update.peerId
          ? { ...dialog, presence: update.presence, lastSeenAt: update.lastSeenAt }
          : dialog,
      );
      versions.next('dialog', update.peerId);
      yield* patch({ dialogs });
      const changed = dialogs.find(({ peer }) => peer.id === update.peerId);
      if (changed && !changed.transient) {
        yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
      }
      return;
    }
    if (update.type === 'join-requests-invalidated') {
      yield* invalidateResource({ kind: 'join-requests', peerId: update.peerId });
      return;
    }
    if (update.type === 'forum-topics-invalidated') {
      if (update.read) yield* refreshDialogHead(update.peerId);
      yield* invalidateResource({ kind: 'forum-topics', peerId: update.peerId });
      return;
    }
    if (update.type === 'saved-messages-invalidated') {
      yield* invalidateResource({ kind: 'saved-messages' });
      return;
    }
    if (update.type === 'chat-folders-invalidated') {
      yield* invalidateResource({ kind: 'chat-folders' });
      return;
    }
    if (update.type === 'dialog-unread-mark') {
      versions.next('dialog', update.peerId);
      const dialogs = currentSnapshot().dialogs.map((dialog) =>
        dialog.peer.id === update.peerId ? { ...dialog, unreadMark: update.unread } : dialog,
      );
      yield* patch({ dialogs });
      const changed = dialogs.find((dialog) => dialog.peer.id === update.peerId);
      if (changed && !changed.transient)
        yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
      return;
    }
    if (update.type === 'mute-changed') {
      const dialogs = currentSnapshot().dialogs.map((dialog) =>
        dialog.peer.id === update.peerId ? { ...dialog, muted: update.muted } : dialog,
      );
      versions.next('dialog', update.peerId);
      yield* patch({ dialogs });
      const changed = dialogs.find(({ peer }) => peer.id === update.peerId);
      if (changed && !changed.transient) {
        yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
      }
      return;
    }
    if (update.type === 'dialog-pinned') {
      const dialogs = sortDialogs(
        currentSnapshot().dialogs.map((dialog) =>
          dialog.peer.id === update.peerId ? { ...dialog, pinned: update.pinned } : dialog,
        ),
      );
      versions.next('dialog', update.peerId);
      yield* patch({ dialogs });
      const changed = dialogs.find(({ peer }) => peer.id === update.peerId);
      if (changed && !changed.transient) {
        yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
      }
      return;
    }
    if (update.type === 'expression-index-changed') {
      if (update.kind !== 'gifs') {
        favoriteStickerVersion += 1;
        stickerPacksVersion += 1;
      }
      const keys =
        update.kind === 'gifs'
          ? ['sticker-index:gifs:v2']
          : update.kind === 'stickers'
            ? ['sticker-index:recent:v2', 'sticker-index:packs:v2', 'sticker-index:favorites:v1']
            : [
                'sticker-index:recent:v2',
                'sticker-index:packs:v2',
                'sticker-index:gifs:v2',
                'sticker-index:favorites:v1',
              ];
      yield* Effect.all(
        keys.flatMap((key) => [cacheStore.deleteBlob(key), cacheStore.deleteMetadata(key)]),
      );
      yield* invalidateResource({ kind: 'expressions' });
      return;
    }
    if (update.type === 'web-app-result') {
      yield* invalidateResource({ kind: 'web-app-result', queryId: update.queryId });
      return;
    }
    if (update.type === 'bot-commands-changed') {
      yield* Effect.all([
        resourceCache.forget(`request:bot-commands:${update.peerId}`),
        cacheStore.deleteMetadata(`bot-commands:${update.peerId}`),
      ]);
      yield* invalidateResource({ kind: 'bot-commands', peerId: update.peerId });
      return;
    }
    if (update.type === 'dialog-folders-changed') {
      const folders = new Map(update.folders.map(({ peerId, folderId }) => [peerId, folderId]));
      const dialogs = sortDialogs(
        currentSnapshot().dialogs.map((dialog) =>
          folders.has(dialog.peer.id)
            ? { ...dialog, archived: folders.get(dialog.peer.id) === 1 }
            : dialog,
        ),
      );
      const changed = dialogs.filter((dialog) => folders.has(dialog.peer.id) && !dialog.transient);
      for (const peerId of folders.keys()) versions.next('dialog', peerId);
      yield* patch({ dialogs });
      yield* Effect.all(
        changed.map((dialog) => cacheStore.putDialog({ ...dialog, cacheEpoch: currentCacheEpoch })),
      );
      return;
    }
    if (update.type === 'dialog-list-invalidated') {
      yield* refreshDialogHeads();
      return;
    }
    if (update.type === 'peer-metadata-changed') {
      yield* resourceCache.forget(`user-details:${update.peerId}`);
      versions.next('dialog', update.peerId);
      const dialogs = currentSnapshot().dialogs.map((dialog) =>
        dialog.peer.id === update.peerId ? { ...dialog, userDetails: undefined } : dialog,
      );
      yield* patch({ dialogs });
      yield* refreshDialogHead(update.peerId);
      yield* invalidateResource({ kind: 'peer-metadata', peerId: update.peerId });
      return;
    }
    if (update.type === 'pts-advanced') return;
    if (update.type === 'pinned-messages') {
      yield* invalidatePinnedMessages(update.peerId);
      const dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === update.peerId);
      if (!dialog) return;
      yield* forkBackgroundTask(() => loadPinnedMessages(dialog).pipe(Effect.asVoid));
      return;
    }
    if (update.type === 'dialog-changed') {
      const dialog: CachedDialog = { ...update.dialog, cacheEpoch: currentCacheEpoch };
      const next = [
        ...currentSnapshot().dialogs.filter((current) => current.peer.id !== dialog.peer.id),
        dialog,
      ];
      versions.next('dialog', dialog.peer.id);
      yield* patch({ dialogs: sortDialogs(next) });
      if (dialog.transient) {
        yield* cacheStore.replaceDialogs(
          next
            .filter((candidate) => !candidate.transient)
            .map((candidate) => ({ ...candidate, cacheEpoch: currentCacheEpoch })),
        );
      } else {
        yield* cacheStore.putDialog(dialog);
      }
    }
  });
  const updateDialogHead = Effect.fn('MessagingEngine.updateDialogHead')(function* (
    message: TelegramMessage,
    incrementUnread: boolean,
  ) {
    let existing = currentSnapshot().dialogs.find(({ peer }) => peer.id === message.peerId);
    let recovered = false;
    if (!existing) {
      recovered = yield* refreshDialogHead(message.peerId);
      existing = currentSnapshot().dialogs.find(({ peer }) => peer.id === message.peerId);
    }
    if (recovered && existing && existing.topMessageId >= message.id) return;
    if (!existing) {
      const kind: TelegramPeer['kind'] =
        message.peerId.startsWith('c:') || message.peerId.startsWith('channel:')
          ? 'channel'
          : message.peerId.startsWith('g:') ||
              message.peerId.startsWith('group:') ||
              message.peerId.startsWith('chat:')
            ? 'group'
            : 'user';
      const placeholder: CachedDialog = {
        peer: { id: message.peerId, kind },
        ...(kind === 'channel' ? { transient: true } : {}),
        title: message.peerId,
        initials: '?',
        color: '#765cff',
        topMessageId: message.id,
        topMessage: message,
        unreadCount: incrementUnread && !message.outgoing ? 1 : 0,
        readInboxMaxId: 0,
        readOutboxMaxId: 0,
        muted: false,
        pinned: false,
        archived: false,
        hasAvatar: false,
        cacheEpoch: currentCacheEpoch,
      };
      if (!placeholder.transient) yield* cacheStore.putDialog(placeholder);
      versions.next('dialog', message.peerId);
      yield* patch({ dialogs: sortDialogs([...currentSnapshot().dialogs, placeholder]) });
      return;
    }
    const dialogs = currentSnapshot().dialogs.map((dialog): TelegramDialog => {
      if (dialog.peer.id !== message.peerId) return dialog;
      return {
        ...dialog,
        // Public channel updates also arrive while previewing without membership.
        ...(dialog.transient && dialog.peer.kind !== 'channel' ? { transient: false } : {}),
        ...(message.id >= dialog.topMessageId
          ? { topMessageId: message.id, topMessage: message }
          : {}),
        unreadMentionsCount:
          (dialog.unreadMentionsCount ?? 0) +
          Number(
            Boolean(incrementUnread && message.id !== dialog.topMessageId && message.unreadMention),
          ),
        unreadCount:
          incrementUnread && message.id !== dialog.topMessageId && !message.outgoing
            ? dialog.unreadCount + 1
            : dialog.unreadCount,
      };
    });
    versions.next('dialog', message.peerId);
    yield* patch({ dialogs: sortDialogs(dialogs) });
    const changed = dialogs.find(({ peer }) => peer.id === message.peerId);
    if (changed && !changed.transient)
      yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
  });
  const applyReactionChange = Effect.fn('MessagingEngine.applyReactionChange')(function* (
    peerId: string,
    messageId: number,
    reactions: readonly TelegramReaction[],
    expectedVersion?: number,
    operation?: { session: Scope.Closeable | undefined; accountId: string | undefined },
    unreadReaction?: boolean,
    reactionsAsTags?: boolean,
  ) {
    const unread = {
      ...(unreadReaction === undefined ? {} : { unreadReaction }),
      ...(reactionsAsTags === undefined ? {} : { reactionsAsTags }),
    };
    const key = `${peerId}:${messageId}`;
    const version = expectedVersion ?? nextReactionVersion(key);
    messageRevisions.record(peerId, messageId);
    const stored = yield* cacheStore.loadMessage(peerId, messageId);
    if (operation && !isOperationCurrent(operation.session, operation.accountId)) {
      return;
    }
    if (versions.current('reaction', key) !== version) return;
    const previous =
      histories.loaded(peerId)?.messages.find((message) => message.id === messageId) ?? stored;
    if (unreadReaction !== undefined && !previous) yield* refreshDialogHead(peerId);
    if (
      unreadReaction !== undefined &&
      previous &&
      Boolean(previous.unreadReaction) !== unreadReaction
    ) {
      yield* queueDialogStateOperation(() =>
        Effect.gen(function* () {
          const dialog = dialogForPeer(peerId);
          if (!dialog) return;
          const changed = {
            ...dialog,
            unreadReactionsCount: Math.max(
              0,
              (dialog.unreadReactionsCount ?? 0) + (unreadReaction ? 1 : -1),
            ),
          };
          versions.next('dialog', peerId);
          yield* patch({
            dialogs: currentSnapshot().dialogs.map((item) =>
              item.peer.id === peerId ? changed : item,
            ),
          });
          if (!changed.transient)
            yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
        }),
      );
    }
    if (stored) yield* cacheStore.putMessage({ ...stored, reactions, ...unread });
    if (operation && !isOperationCurrent(operation.session, operation.accountId)) {
      return;
    }
    if (versions.current('reaction', key) !== version) return;
    const loaded = histories.loaded(peerId);
    if (loaded) {
      histories.updateLoaded(peerId, (history) => ({
        ...history,
        messages: history.messages.map((message) =>
          message.id === messageId ? { ...message, reactions, ...unread } : message,
        ),
      }));
    }
    const updated =
      histories.loaded(peerId)?.messages.find(({ id }) => id === messageId) ??
      (stored ? { ...stored, reactions, ...unread } : undefined);
    if (updated) yield* publishConversationEvent({ type: 'message-upsert', message: updated });
  });
  function nextReactionVersion(key: string) {
    return versions.next('reaction', key);
  }
  function reactionsAfterChoice(reactions: readonly TelegramReaction[], emoji?: string) {
    const next = reactions.flatMap((reaction) => {
      const count = reaction.chosen ? reaction.count - 1 : reaction.count;
      return count > 0 ? [{ ...reaction, count, chosen: false }] : [];
    });
    if (!emoji) return next;
    const existing = next.find((reaction) => reaction.emoji === emoji);
    if (existing) {
      existing.count += 1;
      existing.chosen = true;
    } else {
      next.push({ emoji, count: 1, chosen: true });
    }
    return next;
  }
  const retryPendingSend = Effect.fn('MessagingEngine.retryPendingSend')(function* (id: string) {
    let pending = currentSnapshot().pending.find((candidate) => candidate.id === id);
    if (!pending) return;
    const activeDelivery = yield* sendQueue.delivery(id);
    if (activeDelivery) {
      yield* activeDelivery;
      pending = currentSnapshot().pending.find((candidate) => candidate.id === id);
      if (!pending?.lastError) return;
    }
    if (!currentSnapshot().online) yield* retrySync();
    pending = currentSnapshot().pending.find((candidate) => candidate.id === id);
    if (!pending) return;
    if (canDeliver(pending)) yield* deliver(pending);
  });
  const cancelPendingSend = Effect.fn('MessagingEngine.cancelPendingSend')(function* (id: string) {
    const pending = currentSnapshot().pending.find((candidate) => candidate.id === id);
    if (!pending) return false;
    yield* sendQueue.cancel(id);
    yield* cacheStore.deletePending(id);
    const remaining = currentSnapshot().pending.filter((candidate) => candidate.id !== id);
    const clearOutboxError =
      operationErrorArea === 'outbox' && !remaining.some(({ lastError }) => lastError);
    if (clearOutboxError) operationErrorArea = undefined;
    yield* patch({
      pending: remaining,
      ...(clearOutboxError ? { operationError: undefined } : {}),
    });
    yield* sendQueue.finishCancellation(id);
    yield* releasePeerDeliveryBlock(pending.peer.id, id);
    return true;
  });
  const retryOutbox = Effect.fn('MessagingEngine.retryOutbox')(function* () {
    if (!currentSnapshot().online) yield* retrySync();
    yield* flushOutbox();
  });
  const flushOutbox = Effect.fn('MessagingEngine.flushOutbox')(function* () {
    yield* engineTasks.runExclusive(
      'flush-outbox',
      Effect.gen(function* () {
        const peerIds = [...new Set(currentSnapshot().pending.map(({ peer }) => peer.id))];
        yield* Effect.forEach(peerIds, (peerId) => flushPeerOutbox(peerId), {
          concurrency: 'unbounded',
          discard: true,
        });
      }),
    );
  });
  const flushPeerOutbox = Effect.fn('MessagingEngine.flushPeerOutbox')(function* (peerId: string) {
    const pending = currentSnapshot()
      .pending.filter((send) => send.peer.id === peerId)
      .sort(
        (left, right) =>
          (left.queueOrder ?? 0) - (right.queueOrder ?? 0) ||
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      );
    for (const send of pending) {
      if (!canDeliver(send)) return;
      yield* deliver(send);
    }
  });
  const reserveDraftSend = Effect.fn('MessagingEngine.reserveDraftSend')(function* (
    pending: PendingSend,
    expectedText: string,
    expectedRevision: number,
    session: Scope.Closeable | undefined = sessionScope,
    accountId: string | undefined = pending.accountId,
  ) {
    const peerId = forumDraftKey(pending.peer.id, pending.reply?.topMessageId);
    const reservation = runSerialized('draftWrite', peerId, () =>
      isPendingOperationCurrent(session, accountId)
        ? cacheStore.commitOutbox(pending, {
            peerId,
            text: expectedText,
            revision: expectedRevision,
          })
        : Effect.void,
    );
    yield* reservation.pipe(
      Effect.tapError((error) =>
        isPendingOperationCurrent(session, accountId)
          ? Effect.gen(function* () {
              if (isPendingOperationCurrent(session, accountId)) {
                yield* fail(
                  'cache',
                  'The message could not be saved to the send queue.',
                  error,
                  false,
                );
              }
            })
          : Effect.void,
      ),
    );
  });
  const reserveDraftBatch = Effect.fn('MessagingEngine.reserveDraftBatch')(function* (
    pending: PendingSend[],
    reservation: { peerId: string; text: string; revision?: number },
    session: Scope.Closeable | undefined = sessionScope,
    accountId: string | undefined = pending[0]?.accountId,
  ) {
    const write = runSerialized('draftWrite', reservation.peerId, () =>
      isPendingOperationCurrent(session, accountId)
        ? cacheStore.commitOutbox(pending, reservation)
        : Effect.void,
    );
    yield* write;
  });
  function draftSendKey(
    text: string,
    reply: TelegramReplyTarget | undefined,
    formats: TelegramTextFormat[] | undefined,
    draftVersion: number,
  ) {
    return JSON.stringify([
      draftVersion,
      text,
      reply?.messageId ?? null,
      reply?.topMessageId ?? null,
      reply?.quoteText ?? null,
      formats?.map(({ offset, length, kind, url }) => [offset, length, kind, url ?? null]) ?? [],
    ]);
  }
  const enqueuePending = Effect.fn('MessagingEngine.enqueuePending')(function* (
    pending: PendingSend,
  ) {
    const blockedBy = sendQueue.blockedBy(pending.peer.id);
    if (blockedBy && blockedBy !== pending.id) {
      pending = sendQueue.capture({ ...pending, lastError: blockedSendMessage() });
    }
    const session = sessionScope;
    const accountId = pending.accountId;
    let delivery: Effect.Effect<void, unknown> | undefined;
    yield* patch({ pending: [...currentSnapshot().pending, pending] });
    const operation = sendQueue.queueWrite(
      pending.peer.id,
      Effect.gen(function* () {
        if (!isPendingOperationCurrent(session, accountId)) return;
        yield* writeOutboxWithQuotaRecovery(sendQueue.blobBytes(pending), () =>
          cacheStore.commitOutbox(pending),
        ).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              if (isPendingOperationCurrent(session, accountId)) {
                yield* patch({
                  pending: currentSnapshot().pending.filter(({ id }) => id !== pending.id),
                });
                yield* fail(
                  'cache',
                  'The message could not be saved to the send queue.',
                  error,
                  false,
                );
              }
            }),
          ),
        );
        if (!isPendingOperationCurrent(session, accountId)) return;
        if (canDeliver(pending)) delivery = deliver(pending);
      }),
    );
    return yield* trackLifecycleTask(() => {
      return Effect.gen(function* () {
        yield* operation;
        if (delivery)
          yield* delivery.pipe(
            Effect.catch((error) =>
              reportFailure('outbox', 'A queued message delivery task failed.', error),
            ),
          );
      });
    });
  });
  const enqueuePendingBatch = Effect.fn('MessagingEngine.enqueuePendingBatch')(function* (
    pending: PendingSend[],
    draftReservation?: { peerId: string; text: string; revision?: number },
  ) {
    if (pending.length === 0) return Effect.void;
    const blockedBy = sendQueue.blockedBy(pending[0]!.peer.id);
    if (blockedBy) {
      pending = pending.map((send) =>
        send.id === blockedBy
          ? send
          : sendQueue.capture({ ...send, lastError: blockedSendMessage() }),
      );
    }
    const session = sessionScope;
    const accountId = pending[0]!.accountId;
    const peerId = pending[0]!.peer.id;
    let deliveries: Effect.Effect<void, unknown>[] = [];
    yield* patch({ pending: [...currentSnapshot().pending, ...pending] });
    const operation = sendQueue.queueWrite(
      peerId,
      Effect.gen(function* () {
        if (!isPendingOperationCurrent(session, accountId)) return;
        yield* Effect.gen(function* () {
          const bytes = pending.reduce((total, send) => total + sendQueue.blobBytes(send), 0);
          yield* writeOutboxWithQuotaRecovery(bytes, () =>
            draftReservation
              ? reserveDraftBatch(pending, draftReservation)
              : cacheStore.commitOutbox(pending),
          );
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              if (isPendingOperationCurrent(session, accountId)) {
                const failedIds = new Set(pending.map(({ id }) => id));
                yield* patch({
                  pending: currentSnapshot().pending.filter(({ id }) => !failedIds.has(id)),
                });
                yield* fail(
                  'cache',
                  'The messages could not be saved to the send queue.',
                  error,
                  false,
                );
              }
            }),
          ),
        );
        if (!isPendingOperationCurrent(session, accountId)) return;
        let drafts = currentSnapshot().drafts;
        if (
          draftReservation &&
          drafts[draftReservation.peerId] === draftReservation.text &&
          (draftReservation.revision === undefined ||
            versions.current('draft', draftReservation.peerId) === draftReservation.revision)
        ) {
          drafts = { ...drafts, [draftReservation.peerId]: '' };
        }
        const draftDetails =
          drafts === currentSnapshot().drafts || !draftReservation
            ? currentSnapshot().draftDetails
            : Object.fromEntries(
                Object.entries(currentSnapshot().draftDetails).filter(
                  ([peerId]) => peerId !== draftReservation.peerId,
                ),
              );
        yield* patch({ drafts, draftDetails });
        deliveries = pending.filter((send) => canDeliver(send)).map((send) => deliver(send));
      }),
    );
    return yield* trackLifecycleTask(() => {
      return Effect.gen(function* () {
        yield* operation;
        yield* Effect.all(
          deliveries.map((delivery) =>
            delivery.pipe(
              Effect.catch((error) =>
                reportFailure('outbox', 'A queued message delivery task failed.', error),
              ),
            ),
          ),
          { discard: true },
        );
      });
    });
  });
  function deliver(pending: PendingSend): Effect.Effect<void, unknown> {
    const session = sessionScope;
    return trackLifecycleTask(() =>
      sendQueue.scheduleDelivery(pending, deliverCurrent(pending, session)),
    );
  }
  const deliverCurrent = Effect.fn('MessagingEngine.deliverCurrent')(function* (
    pending: PendingSend,
    session: Scope.Closeable | undefined,
  ) {
    const accountId = pending.accountId;
    if (!isOperationCurrent(session, accountId)) return;
    if (!canDeliver(pending) || !sendQueue.beginAttempt(pending.id)) return;
    const attempting = sendQueue.capture({
      ...pending,
      attempts: pending.attempts + 1,
      lastError: undefined,
      uploadProgress: pending.attachment || pending.album ? 0 : undefined,
    });
    let failure: { pending: PendingSend; error: unknown } | undefined;
    const shouldFinishAttempt = yield* Effect.gen(function* () {
      yield* cacheStore.commitOutbox(attempting);
      if (sendQueue.isCancelled(attempting.id)) {
        yield* cacheStore.deletePending(attempting.id);
        return false;
      }
      if (!isOperationCurrent(session, accountId)) return false;
      yield* replacePending(attempting);
      const onProgress = (progress: number) =>
        Effect.suspend(() => {
          if (isOperationCurrent(session, accountId)) {
            return updateUploadProgress(attempting.id, progress);
          }
          return Effect.void;
        });
      const deliveryTimeout =
        attempting.attachment || attempting.album
          ? MEDIA_DELIVERY_TIMEOUT_MS
          : MESSAGE_DELIVERY_TIMEOUT_MS;
      const transport = telegramTransport;
      const { sentMessages, updateBatches } = yield* runTransportWithDeadline(
        () =>
          Effect.gen(function* () {
            if (attempting.botStart) {
              const result = transport.startBot
                ? yield* transport.startBot(
                    attempting.peer,
                    attempting.botStart.startParam,
                    attempting.randomId,
                  )
                : yield* transport.sendText(
                    attempting.peer,
                    attempting.text,
                    attempting.randomId,
                    undefined,
                    undefined,
                  );
              return { sentMessages: [result.message], updateBatches: result.updateBatches };
            }
            if (attempting.forward) {
              const result = yield* transport.forwardMessage(
                attempting.forward.fromPeer,
                attempting.peer,
                attempting.forward.messageId,
                attempting.randomId,
                attempting.forward.options,
              );
              return { sentMessages: [result.message], updateBatches: result.updateBatches };
            }
            if (attempting.pollDraft) {
              if (!transport.sendPoll)
                return yield* Effect.fail(
                  createMtprotoError('protocol', 'Sending polls is unavailable.'),
                );
              const result = yield* transport.sendPoll(
                attempting.peer,
                attempting.pollDraft,
                attempting.randomId,
                attempting.reply,
              );
              return { sentMessages: [result.message], updateBatches: result.updateBatches };
            }
            if (attempting.contact) {
              if (!transport.sendContact)
                return yield* Effect.fail(
                  createMtprotoError('protocol', 'Contact sharing is unavailable.'),
                );
              const result = yield* transport.sendContact(
                attempting.peer,
                attempting.contact,
                attempting.randomId,
                attempting.reply,
              );
              return { sentMessages: [result.message], updateBatches: result.updateBatches };
            }
            if (attempting.sticker) {
              const result = yield* transport.sendSticker(
                attempting.peer,
                attempting.sticker,
                attempting.randomId,
                attempting.reply,
              );
              return { sentMessages: [result.message], updateBatches: result.updateBatches };
            }
            if (attempting.album) {
              const result = yield* transport.sendAlbum(
                attempting.peer,
                attempting.album.attachments.map((attachment) => ({
                  file: new File([attachment.blob], attachment.name, { type: attachment.mimeType }),
                  randomId: attachment.randomId,
                  sendAs: attachment.sendAs,
                })),
                {
                  caption: attempting.text,
                  reply: attempting.reply,
                  formats: attempting.formats,
                  onProgress,
                },
              );
              return { sentMessages: result.messages, updateBatches: result.updateBatches };
            }
            if (attempting.attachment) {
              const result = yield* transport.sendFile(
                attempting.peer,
                new File([attempting.attachment.blob], attempting.attachment.name, {
                  type: attempting.attachment.mimeType,
                }),
                {
                  caption: attempting.text,
                  randomId: attempting.randomId,
                  asSticker: attempting.attachment.asSticker,
                  sendAs: attempting.attachment.sendAs,
                  reply: attempting.reply,
                  formats: attempting.formats,
                  onProgress,
                },
              );
              return { sentMessages: [result.message], updateBatches: result.updateBatches };
            }
            const result = yield* transport.sendText(
              attempting.peer,
              attempting.text,
              attempting.randomId,
              attempting.reply,
              attempting.formats,
            );
            return { sentMessages: [result.message], updateBatches: result.updateBatches };
          }),
        deliveryTimeout,
        `Message delivery timed out after ${deliveryTimeout / 1_000} seconds.`,
        'message-delivery',
      );
      if (sentMessages.length === 0)
        return yield* Effect.fail(new Error('Telegram returned no sent messages.'));
      if (!isOperationCurrent(session, accountId)) return false;
      if (sendQueue.isCancelled(attempting.id)) return false;
      yield* acceptMutationUpdateBatches(updateBatches, session, accountId);
      if (!isOperationCurrent(session, accountId)) return false;
      if (sendQueue.isCancelled(attempting.id)) return false;
      // Mutation envelopes can omit the caller-known random ID. Merge the RPC
      // result before deleting the durable outbox record so correlation
      // survives a crash between confirmation and cleanup.
      yield* enqueueSyntheticUpdates(
        sentMessages.map((message) => ({
          type: 'new-message' as const,
          pts: 0,
          ptsCount: 0,
          message,
        })),
        session,
        true,
        { accountId },
      );
      if (!isOperationCurrent(session, accountId)) return false;
      if (sendQueue.isCancelled(attempting.id)) return false;
      yield* cacheStore.deletePending(attempting.id);
      if (!isOperationCurrent(session, accountId)) return false;
      const remaining = currentSnapshot().pending.filter(({ id }) => id !== attempting.id);
      const clearOutboxError =
        operationErrorArea === 'outbox' && !remaining.some(({ lastError }) => lastError);
      if (clearOutboxError) operationErrorArea = undefined;
      yield* patch({
        pending: remaining,
        ...(clearOutboxError ? { operationError: undefined } : {}),
      });
      yield* releasePeerDeliveryBlock(attempting.peer.id, attempting.id);
      return true;
    })
      .pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (!isOperationCurrent(session, accountId)) return false;
            if (sendQueue.isCancelled(attempting.id)) return false;
            const current =
              currentSnapshot().pending.find(({ id }) => id === attempting.id) ?? attempting;
            const failed = sendQueue.capture({ ...current, lastError: errorMessage(error) });
            yield* cacheStore.commitOutbox(failed);
            if (!isOperationCurrent(session, accountId)) return false;
            if (sendQueue.isCancelled(attempting.id)) {
              yield* cacheStore.deletePending(attempting.id);
              return false;
            }
            sendQueue.block(attempting.peer.id, attempting.id);
            yield* markPeerQueueBlocked(attempting.peer.id, attempting.id);
            failure = { pending: failed, error };
            return true;
          }),
        ),
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            sendQueue.endAttempt(pending.id);
          }),
        ),
      );
    if (!shouldFinishAttempt) return;
    if (failure) {
      yield* replacePending(failure.pending);
      yield* fail('outbox', 'A message remains queued for retry.', failure.error, false);
    }
  });
  function replacePending(pending: PendingSend) {
    const captured = sendQueue.capture(pending);
    return patch({
      pending: currentSnapshot().pending.map((current) =>
        current.id === captured.id ? captured : current,
      ),
    });
  }
  const writeOutboxWithQuotaRecovery = Effect.fn('MessagingEngine.writeOutboxWithQuotaRecovery')(
    function* <E, R>(bytes: number, write: () => Effect.Effect<void, E, R>) {
      yield* cacheStore.prepareOutboxWrite(bytes);
      yield* write().pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (!isQuotaError(error)) return yield* Effect.fail(error);
            yield* cacheStore.prepareOutboxWrite(bytes, true);
            yield* write();
          }),
        ),
      );
    },
  );
  function isQuotaError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'QuotaExceededError'
    );
  }
  const validateTextLength = Effect.fn('MessagingEngine.validateTextLength')(function* (
    text: string,
    limit: number,
    label: string,
  ) {
    if (text.length <= limit) return;
    const error = new Error(`The ${label} is ${text.length} characters; Telegram allows ${limit}.`);
    yield* fail('outbox', `The ${label} was not queued.`, error, false);
    return yield* Effect.fail(error);
  });
  const validateAttachment = Effect.fn('MessagingEngine.validateAttachment')(function* (
    file: File,
  ) {
    if (file.size > 0) return;
    const error = new Error(`${file.name || 'The attachment'} is empty.`);
    yield* fail('outbox', 'The attachment was not queued.', error, false);
    return yield* Effect.fail(error);
  });
  const markPeerQueueBlocked = Effect.fn('MessagingEngine.markPeerQueueBlocked')(function* (
    peerId: string,
    blockedBy: string,
  ) {
    const message = blockedSendMessage();
    const blocked = currentSnapshot().pending.filter(
      (pending) => pending.peer.id === peerId && pending.id !== blockedBy && !pending.lastError,
    );
    if (blocked.length === 0) return;
    const replacements = blocked.map((pending) =>
      sendQueue.capture({ ...pending, lastError: message }),
    );
    yield* Effect.all(replacements.map((pending) => cacheStore.commitOutbox(pending)));
    const byId = new Map(replacements.map((pending) => [pending.id, pending]));
    yield* patch({
      pending: currentSnapshot().pending.map((pending) => byId.get(pending.id) ?? pending),
    });
  });
  function blockedSendMessage() {
    return 'Waiting for an earlier failed message. Retry or cancel that message first.';
  }
  function updateUploadProgress(id: string, progress: number) {
    const current = currentSnapshot().pending.find((pending) => pending.id === id);
    if (!current) return Effect.void;
    return replacePending({ ...current, uploadProgress: Math.max(0, Math.min(1, progress)) });
  }
  const markRead = Effect.fn('MessagingEngine.markRead')(function* (
    dialog: TelegramDialog,
    maxMessageId: number,
  ) {
    if (!currentSnapshot().online) return;
    if (maxMessageId <= dialog.readInboxMaxId && dialog.unreadCount === 0) return;
    const peerId = dialog.peer.id;
    yield* inboxReadMailbox.offer(peerId, maxMessageId);
    if (yield* engineTasks.hasDelay('inboxRead', peerId)) return;
    if (inboxReadInFlight.has(peerId)) return;
    inboxReadInFlight.add(peerId);
    return yield* inboxReadMailbox
      .flush(peerId, (pending) => flushInboxRead(peerId, pending))
      .pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => inboxReadInFlight.delete(peerId))));
  });
  const markMessageContentsRead = Effect.fn('MessagingEngine.markMessageContentsRead')(function* (
    peer: TelegramPeer,
    messageId: number,
    notificationsOnly: boolean,
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
    return yield* queueMutation(`media-read:${peer.id}:${messageId}`, () =>
      Effect.gen(function* () {
        if (!isOperationCurrent(session, accountId) || !currentSnapshot().online) return;
        const source =
          histories.loaded(peer.id)?.messages.find(({ id }) => id === messageId) ??
          (yield* cacheStore.loadMessage(peer.id, messageId));
        if (!isOperationCurrent(session, accountId)) return;
        if (
          !source ||
          (notificationsOnly
            ? !source.unreadMention && !source.unreadReaction
            : source.outgoing ||
              source.mediaUnread === false ||
              (source.media?.kind !== 'voice' && source.media?.kind !== 'round-video'))
        )
          return;
        const expectedReactionVersion = versions.current('reaction', `${peer.id}:${messageId}`);
        const result = yield* runTelegramOperation(
          () => telegramTransport.readMessageContents(peer, [messageId]),
          notificationsOnly
            ? 'Marking viewed mentions and reactions as read'
            : 'Marking voice or video message as listened',
        );
        if (!isOperationCurrent(session, accountId)) return;
        yield* queueMutationUpdateBatches(
          result.updateBatches?.map((batch) => ({
            ...batch,
            updates: batch.updates.map((update) =>
              update.type === 'read-message-contents'
                ? { ...update, expectedReactionVersion }
                : update,
            ),
          })),
          session,
          accountId,
        );
        // Also apply the acknowledged receipt when its PTS was already consumed
        // by a live update, or the channel RPC returned only Bool.
        yield* enqueueSyntheticUpdates(
          [
            {
              type: 'read-message-contents',
              expectedReactionVersion,
              peerId: peer.id,
              messageIds: [messageId],
              pts: 0,
              ptsCount: 0,
            },
          ],
          session,
          true,
          { accountId },
        );
      }),
    );
  });
  const markMediaRead = (peer: TelegramPeer, messageId: number) =>
    markMessageContentsRead(peer, messageId, false);
  const markMessageNotificationsRead = (peer: TelegramPeer, messageIds: number[]) =>
    Effect.forEach([...new Set(messageIds)], (id) => markMessageContentsRead(peer, id, true), {
      discard: true,
    });
  const markAllNotificationsRead = Effect.fn('MessagingEngine.markAllNotificationsRead')(function* (
    peer: TelegramPeer,
    kind: 'mention' | 'reaction',
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    if (!currentSnapshot().online || !telegramTransport.readAllNotifications)
      return yield* Effect.fail(new Error('Marking notifications as read is unavailable.'));
    return yield* queueMutation(`notifications-read:${peer.id}:${kind}`, () =>
      Effect.gen(function* () {
        if (!isOperationCurrent(session, accountId)) return;
        const requestRevision = messageRevisions.capture();
        const cached = yield* cacheStore.loadMessages(peer.id, Number.MAX_SAFE_INTEGER);
        if (!isOperationCurrent(session, accountId)) return;
        const candidates = [
          ...new Map(
            [...cached, ...(histories.loaded(peer.id)?.messages ?? [])].map((message) => [
              message.id,
              message,
            ]),
          ).values(),
        ];
        const dialogVersion = versions.current('dialog', peer.id);
        const result = yield* runTelegramOperation(
          () => telegramTransport.readAllNotifications!(peer, kind),
          'Marking all notifications as read',
        );
        if (!isOperationCurrent(session, accountId)) return;
        yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
        yield* queueDialogStateOperation(() =>
          Effect.gen(function* () {
            if (!isOperationCurrent(session, accountId)) return;
            const field = kind === 'mention' ? 'unreadMention' : 'unreadReaction';
            for (const previous of messageRevisions.filter(peer.id, candidates, requestRevision)) {
              if (!previous[field]) continue;
              const message = { ...previous, [field]: false, cacheEpoch: currentCacheEpoch };
              messageRevisions.record(peer.id, message.id);
              yield* cacheStore.putMessage(message);
              if (!isOperationCurrent(session, accountId)) return;
              histories.updateLoaded(peer.id, (history) => ({
                ...history,
                messages: history.messages.map((item) => (item.id === message.id ? message : item)),
              }));
              yield* publishConversationEvent({ type: 'message-upsert', message });
            }
            const dialog = dialogForPeer(peer.id);
            if (!dialog || versions.current('dialog', peer.id) !== dialogVersion) return;
            const countField = kind === 'mention' ? 'unreadMentionsCount' : 'unreadReactionsCount';
            const changed = { ...dialog, [countField]: 0 };
            versions.next('dialog', peer.id);
            yield* patch({
              dialogs: currentSnapshot().dialogs.map((item) =>
                item.peer.id === peer.id ? changed : item,
              ),
            });
            if (!changed.transient)
              yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
          }),
        );
        // Reconcile a count changed by a concurrent incoming notification.
        if (isOperationCurrent(session, accountId)) yield* getUnreadNotifications(peer, kind);
      }),
    );
  });
  const flushInboxRead = Effect.fn('MessagingEngine.flushInboxRead')(function* (
    peerId: string,
    maxMessageId: number,
  ) {
    const session = sessionScope;
    const accountId = activeAccountId;
    if (!currentSnapshot().online) return;
    const current = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
    if (!current) return;
    if (maxMessageId <= current.readInboxMaxId && current.unreadCount === 0) return;
    const unreadVersion = versions.current('unread', peerId);
    const result = yield* runTelegramOperation(
      () => telegramTransport.readHistory(current.peer, maxMessageId),
      `Marking ${current.title} as read`,
    );
    if (!isOperationCurrent(session, accountId)) return;
    yield* queueMutationUpdateBatches(result.updateBatches, session, accountId);
    if (!isOperationCurrent(session, accountId)) return;
    versions.next('dialog', peerId);
    yield* queueDialogStateOperation(() => {
      return Effect.gen(function* () {
        if (!isOperationCurrent(session, accountId)) return;
        // Publish before persisting: a dialog written back after the cache write would
        // erase every update that arrived while the write was in flight.
        const read = (dialog: TelegramDialog): TelegramDialog => ({
          ...dialog,
          readInboxMaxId: Math.max(dialog.readInboxMaxId, maxMessageId),
          unreadCount:
            versions.current('unread', peerId) === unreadVersion ? 0 : dialog.unreadCount,
        });
        const latest = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
        const changed = read(latest ?? current);
        if (latest) {
          yield* patch({
            dialogs: currentSnapshot().dialogs.map((candidate) =>
              candidate.peer.id === peerId ? changed : candidate,
            ),
          });
        }
        if (!changed.transient)
          yield* cacheStore.putDialog({ ...changed, cacheEpoch: currentCacheEpoch });
      });
    });
    if (currentSnapshot().operationError?.startsWith('Could not mark ')) {
      yield* clearOperationError();
    }
  });
  const handleInboxReadFailure = Effect.fn('MessagingEngine.handleInboxReadFailure')(function* (
    peerId: string,
    pending: number,
    error: unknown,
  ) {
    const current = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
    if (!current || !currentSnapshot().online) return;
    if (yield* engineTasks.hasDelay('inboxRead', peerId)) return;
    yield* engineTasks.delay(
      'inboxRead',
      peerId,
      500,
      Effect.gen(function* () {
        const latest = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
        const queued = inboxReadMailbox.pending(peerId) ?? pending;
        if (latest && currentSnapshot().online) {
          yield* markRead(latest, queued);
        }
      }),
      { onlyIfMissing: true },
    );
    yield* fail('sync', `Could not mark ${current.title} as read.`, error, false);
  });
  const batchSnapshotNotifications = Effect.fn('MessagingEngine.batchSnapshotNotifications')(
    function* <T, E, R>(operation: Effect.Effect<T, E, R>) {
      yield* accountState.beginNotificationBatch;
      return yield* operation.pipe(Effect.ensuring(accountState.endNotificationBatch));
    },
  );
  function patch(patch: Partial<AccountSnapshot>) {
    return accountState.patch(patch);
  }
  const fail = Effect.fn('MessagingEngine.fail')(function* (
    area: 'auth' | 'sync' | 'transport' | 'cache' | 'outbox',
    message: string,
    error: unknown,
    fatal: boolean = true,
  ) {
    const detail = errorMessage(error);
    reportDiagnostic({
      code: `${area}-failed`,
      level: 'error',
      area,
      message,
      details: { error: detail },
    });
    if (fatal && currentSnapshot().online) {
      yield* disconnectTransport().pipe(Effect.ignore);
    }
    if (fatal) yield* failAccountReady(new Error(`${message} ${detail}`));
    if (fatal && hasReachedReady) {
      operationErrorArea = undefined;
      yield* patch({
        phase: 'ready',
        sync: 'stale',
        online: false,
        operationError: undefined,
        error: `${message} ${detail}`,
      });
      if (area === 'sync' || area === 'transport') yield* scheduleReconnect();
      return;
    }
    if (fatal) {
      operationErrorArea = undefined;
      yield* patch({
        phase: 'error',
        online: false,
        operationError: undefined,
        error: `${message} ${detail}`,
      });
      return;
    }
    if (area === 'auth') {
      yield* patch({ error: `${message} ${detail}` });
      return;
    }
    if (
      area !== 'outbox' &&
      operationErrorArea === 'outbox' &&
      currentSnapshot().pending.some(({ lastError }) => lastError)
    ) {
      return;
    }
    operationErrorArea = area;
    yield* patch({ operationError: `${message} ${detail}` });
  });
  function reportFailure(
    area: 'auth' | 'sync' | 'transport' | 'cache' | 'outbox',
    message: string,
    error: unknown,
  ) {
    return Effect.sync(() =>
      reportDiagnostic({
        code: `${area}-operation-failed`,
        level: 'error',
        area,
        message,
        details: { error: errorMessage(error) },
      }),
    );
  }
  const handleConnectionLost = Effect.fn('MessagingEngine.handleConnectionLost')(function* () {
    reportDiagnostic({
      code: 'connection-lost',
      level: 'info',
      area: 'transport',
      message: 'Telegram connection was lost; cached data remains available.',
    });
    yield* renewAccountReady();
    yield* patch({
      phase: 'ready',
      sync: 'stale',
      online: false,
      error: 'Telegram connection was lost. Reconnect to continue.',
    });
    yield* disconnectTransport().pipe(Effect.ignore);
    yield* scheduleReconnect();
  });
  function scheduleReconnect(): Effect.Effect<void> {
    if (quiescing || !activeCredentials) return Effect.void;
    const session = sessionScope;
    return engineTasks.retry(
      'reconnect',
      Effect.gen(function* () {
        if (
          !isLifecycleCurrent(session) ||
          currentSnapshot().online ||
          currentSnapshot().phase === 'unauthorized'
        )
          return false;
        yield* retrySync();
        return (
          isLifecycleCurrent(session) &&
          !currentSnapshot().online &&
          currentSnapshot().phase !== 'unauthorized'
        );
      }),
    );
  }
  function canDeliver(pending: PendingSend) {
    const blockedBy = sendQueue.blockedBy(pending.peer.id);
    const dialog = dialogForPeer(pending.peer.id);
    return (
      currentSnapshot().online &&
      !!activeAccountId &&
      pending.accountId === activeAccountId &&
      (blockedBy === undefined || blockedBy === pending.id) &&
      !sendQueue.isCancelled(pending.id) &&
      (dialog ? canDeliverToDialog(dialog, pending) : pending.peer.kind === 'user')
    );
  }
  function releasePeerDeliveryBlock(
    peerId: string,
    pendingId: string,
  ): Effect.Effect<void, unknown> {
    if (!sendQueue.releaseBlock(peerId, pendingId)) return Effect.void;
    return forkBackgroundTask(() => flushPeerOutbox(peerId));
  }
  function isHistoryOperationCurrent(
    peerId: string,
    historyVersion: number,
    session: Scope.Closeable | undefined,
    accountId: string | undefined,
  ) {
    return (
      isPendingOperationCurrent(session, accountId) && histories.version(peerId) === historyVersion
    );
  }
  function invalidateHistory(peerId: string) {
    histories.invalidate(peerId);
  }
  function rememberHistory(
    peerId: string,
    history: { messages: TelegramMessage[]; hasOlderMessages: boolean },
    mode?: 'newest' | 'oldest' | 'anchor',
  ) {
    return histories.remember(peerId, history, mode);
  }
  function touchHistory(peerId: string) {
    histories.touch(peerId);
  }
  function recordHistoryFailure(peerId: string) {
    return histories.recordFailure(peerId);
  }
  function clearHistoryFailure(peerId: string) {
    histories.clearFailure(peerId);
  }
  const cachedPinnedMessages = Effect.fn('MessagingEngine.cachedPinnedMessages')(function* (
    peerId: string,
  ) {
    return yield* pinnedMessageCache.cached(peerId);
  });
  const rememberPinnedMessages = Effect.fn('MessagingEngine.rememberPinnedMessages')(function* (
    peerId: string,
    messages: TelegramMessage[],
  ) {
    yield* publishPinnedMessages(peerId, messages);
    yield* pinnedMessageCache.remember(peerId, messages);
  });
  const invalidatePinnedMessages = Effect.fn('MessagingEngine.invalidatePinnedMessages')(function* (
    peerId: string,
  ) {
    return yield* pinnedMessageCache.invalidate(peerId);
  });
  function publishPinnedMessages(peerId: string, messages: TelegramMessage[]) {
    return publishConversationEvent({ type: 'pinned-messages', peerId, messages });
  }
  const cachedGroupMembers = Effect.fn('MessagingEngine.cachedGroupMembers')(function* (
    peerId: string,
  ) {
    return yield* groupMemberCache.cached(peerId);
  });
  const rememberGroupMembers = Effect.fn('MessagingEngine.rememberGroupMembers')(function* (
    peerId: string,
    members: TelegramGroupMember[],
  ) {
    yield* groupMemberCache.remember(peerId, members);
  });
  const invalidateGroupMembers = Effect.fn('MessagingEngine.invalidateGroupMembers')(function* (
    peerId: string,
  ) {
    yield* groupMemberCache.invalidate(peerId);
    groupMemberPages.delete(peerId);
    yield* invalidateResource({ kind: 'group-members', peerId });
  });
  function isLifecycleCurrent(session: Scope.Closeable | undefined) {
    return !quiescing && session !== undefined && session === sessionScope;
  }
  const invalidateMetadata = Effect.sync(() => {
    metadataGeneration += 1;
  });
  function trackLifecycleTask<T, E>(task: () => Effect.Effect<T, E>) {
    const session = sessionScope;
    if (!session) return Effect.interrupt;
    return engineTasks.runSession(Effect.suspend(task));
  }
  function forkBackgroundTask<E>(task: () => Effect.Effect<unknown, E>) {
    const session = sessionScope;
    if (!isLifecycleCurrent(session)) return Effect.void;
    return engineTasks.forkBackground(
      Effect.suspend(task).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              if (!isLifecycleCurrent(session)) return;
              reportDiagnostic({
                code: 'background-task-failed',
                level: 'error',
                area: 'sync',
                message: 'A background Telegram task failed.',
                details: { error: errorMessage(error) },
              });
            }),
          onSuccess: () => Effect.void,
        }),
      ),
    );
  }
  function trackVersionedMutation<T>(
    key: string,
    version: number,
    task: () => Effect.Effect<T, unknown>,
  ) {
    return trackLifecycleTask(() =>
      task().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            versions.delete('mutation', key, version);
          }),
        ),
      ),
    );
  }
  function errorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\bFLOOD_WAIT(?:_\d+)?\b/u.test(message)) {
      return 'Telegram asked TeleVecha to wait before trying again.';
    }
    if (/\bCHAT_ADMIN_REQUIRED\b/u.test(message)) {
      return 'Telegram did not allow this change for this chat.';
    }
    if (/\b[A-Z][A-Z0-9_]{2,}\b/u.test(message) || /\([a-z]+\.[A-Za-z]+\)/u.test(message)) {
      return 'Telegram rejected this request. Try again or check your permissions.';
    }
    return message;
  }
  function nextMutationVersion(key: string) {
    return versions.next('mutation', key);
  }
  function queueMutation<T, E>(key: string, operation: () => Effect.Effect<T, E>) {
    return runSerialized('mutation', key, operation);
  }
  function queueDialogStateOperation<T, E>(operation: () => Effect.Effect<T, E>) {
    return runSerialized('dialogState', '', operation);
  }
  function queueMetadataWrite<T, E>(operation: () => Effect.Effect<T, E>) {
    return runSerialized('metadataWrite', '', operation);
  }
  function runSerialized<T>(
    lane: EngineSerialLane,
    key: string,
    operation: () => Effect.Effect<T, unknown>,
  ) {
    return engineTasks.serialize(lane, key, Effect.suspend(operation));
  }
  function isOperationCurrent(session: Scope.Closeable | undefined, accountId: string | undefined) {
    return isLifecycleCurrent(session) && activeAccountId === accountId;
  }
  function isPendingOperationCurrent(
    session: Scope.Closeable | undefined,
    accountId: string | undefined,
  ) {
    return isLifecycleCurrent(session) && (activeAccountId ?? cachedAccountId) === accountId;
  }
  function isUpdateOperationCurrent(
    session: Scope.Closeable | undefined,
    operation?: { accountId: string | undefined },
  ) {
    return operation
      ? isOperationCurrent(session, operation.accountId)
      : isLifecycleCurrent(session);
  }
  const cacheUploadedMedia = Effect.fn('MessagingEngine.cacheUploadedMedia')(function* (
    message: TelegramMessage,
    blob: Blob,
    preview?: Blob,
  ) {
    if (!canReuseUploadedMedia(message.media, blob)) return;
    const key = mediaAssetKey(message);
    yield* Effect.all([
      cacheStore.saveBlob(key, blob),
      ...(preview ? [cacheStore.saveBlob(`preview:${key}`, preview)] : []),
    ]).pipe(
      Effect.catch((error) => reportFailure('cache', 'Could not cache the uploaded media.', error)),
    );
  });
  const invalidateEditedMedia = Effect.fn('MessagingEngine.invalidateEditedMedia')(function* (
    previous: TelegramMessage | undefined,
    next: TelegramMessage,
  ) {
    const legacyKey = `media:${next.peerId}:${next.id}`;
    const previousKey = previous ? mediaAssetKey(previous) : legacyKey;
    const nextKey = mediaAssetKey(next);
    if (previousKey === nextKey && previousKey !== legacyKey) return;
    const mediaSlot = `${next.peerId}:${next.id}`;
    const previewSlot = `preview:${mediaSlot}`;
    yield* resourceCache.invalidate(mediaSlot, `media:${previousKey}`, `media:${legacyKey}`);
    yield* resourceCache.invalidate(
      previewSlot,
      `media:preview:${previousKey}`,
      `media:preview:${legacyKey}`,
    );
    yield* Effect.all([
      cacheStore.deleteBlob(previousKey),
      cacheStore.deleteBlob(`preview:${previousKey}`),
      ...(previousKey === legacyKey ? [] : [cacheStore.deleteBlob(legacyKey)]),
      ...(previousKey === legacyKey ? [] : [cacheStore.deleteBlob(`preview:${legacyKey}`)]),
    ]);
  });
  const connectWithDeadline = Effect.fn('MessagingEngine.connectWithDeadline')(function* (
    credentials: TelegramCredentials,
  ) {
    yield* runTransportWithDeadline(
      () => telegramTransport.connect(credentials),
      TELEGRAM_OPERATION_TIMEOUT_MS,
      'Telegram WebSocket connection timed out after 15 seconds.',
      'connect',
    ).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* disconnectTransport();
          return yield* Effect.fail(error);
        }),
      ),
    );
  });
  function runLocalOperation<Value>(operation: () => Effect.Effect<Value, unknown>, label: string) {
    return runWithDeadline(
      operation,
      LOCAL_OPERATION_TIMEOUT_MS,
      `${label} timed out after 10 seconds.`,
      'local-operation',
    );
  }
  function runTelegramOperation<Value>(
    operation: () => Effect.Effect<Value, TelegramTransportError>,
    label: string,
  ) {
    return runTransportWithDeadline(
      operation,
      TELEGRAM_OPERATION_TIMEOUT_MS,
      `${label} timed out after 15 seconds.`,
      'rpc',
    );
  }
  function runTransportWithDeadline<Value>(
    operation: () => Effect.Effect<Value, TelegramTransportError>,
    durationMs: number,
    message: string,
    name: string,
  ) {
    return engineTasks.runNetwork(
      withOperationDeadline(
        name,
        Effect.suspend(operation).pipe(Effect.withSpan(`telegram.${name}`)),
        durationMs,
        message,
      ),
    );
  }
  function runWithDeadline<Value>(
    operation: () => Effect.Effect<Value, unknown>,
    durationMs: number,
    message: string,
    name: string = 'operation',
  ) {
    return engineTasks.runNetwork(
      withOperationDeadline(name, Effect.suspend(operation), durationMs, message),
    );
  }
  function disconnectTransport() {
    return telegramTransport.disconnect();
  }
  function sortDialogs<T extends TelegramDialog>(dialogs: T[]) {
    return [...dialogs].sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      if (left.pinned && right.pinned) {
        const leftOrder = left.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = right.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      }
      return (right.topMessage?.date ?? 0) - (left.topMessage?.date ?? 0);
    });
  }
  function sortMessages<T extends TelegramMessage>(messages: T[]) {
    return [...messages].sort((left, right) => left.id - right.id);
  }
  return {
    snapshot: snapshot,
    clearOperationError: clearOperationError,
    setActiveConversationVisibility: setActiveConversationVisibility,
    refreshReadReceipt: refreshReadReceipt,
    retryMarkRead: retryMarkRead,
    markMediaRead,
    markMessageNotificationsRead,
    markAllNotificationsRead,
    refreshUpdates: refreshUpdates,
    subscribe: subscribe,
    subscribeResources: subscribeResources,
    subscribeConversationEvents: subscribeConversationEvents,
    start: start,
    whenCommandReady: whenCommandReady,
    whenAccountReady: whenAccountReady,
    retrySync: retrySync,
    stop: stop,
    loadConversationView: loadConversationView,
    loadConversationSharedMediaCounts: loadConversationSharedMediaCounts,
    loadConversationPinnedMessages: loadConversationPinnedMessages,
    getConversationSharedMedia: getConversationSharedMedia,
    searchConversationMessages: searchConversationMessages,
    getUnreadNotifications,
    getLinkedMessage,
    resolveUsername,
    getDiscussion,
    getReplies,
    searchPeers: searchPeers,
    addPeer: addPeer,
    openMessageInConversationView: openMessageInConversationView,
    loadHistoryGapConversationView: loadHistoryGapConversationView,
    setUnreadMark,
    setMuted: setMuted,
    getUserDetails: getUserDetails,
    getGroupMembers: getGroupMembers,
    setBlocked: setBlocked,
    updateContact: updateContact,
    deleteContact: deleteContact,
    setPinnedDialog: setPinnedDialog,
    setArchived: setArchived,
    deleteDialog: deleteDialog,
    setPinnedMessage: setPinnedMessage,
    setTyping: setTyping,
    loadOlderConversationView: loadOlderConversationView,
    retryConversationView: retryConversationView,
    setDraft: setDraft,
    beginQrLogin,
    cancelQrLogin,
    requestCode: requestCode,
    submitCode: submitCode,
    submitPassword: submitPassword,
    logOut: logOut,
    clearCache: clearCache,
    sendDraft: sendDraft,
    sendAttachments: sendAttachments,
    downloadMedia: downloadMedia,
    mediaAssetKey: mediaAssetKey,
    downloadAvatar: downloadAvatar,
    loadCachedAvatar: loadCachedAvatar,
    getWallpapers: getWallpapers,
    getChatAppearance: getChatAppearance,
    downloadWallpaper: downloadWallpaper,
    getRecentStickers: getRecentStickers,
    searchStickers,
    getFavoriteStickers,
    setStickerFavorite,
    getStickerPacks: getStickerPacks,
    getStickerPack,
    searchStickerPacks,
    setStickerPackInstalled,
    getSavedGifs: getSavedGifs,
    searchGifs: searchGifs,
    downloadSticker: downloadSticker,
    downloadCustomEmoji: downloadCustomEmoji,
    getBotApp,
    requestWebApp,
    prolongWebApp,
    sendWebAppData,
    invokeWebAppMethod,
    getBotCommands: getBotCommands,
    startBot: startBot,
    answerBotCallback: answerBotCallback,
    requestUrlAuth: requestUrlAuth,
    acceptUrlAuth: acceptUrlAuth,
    sendSticker: sendSticker,
    sendContact,
    sendPoll,
    updatePoll,
    getReactionPeople,
    getMessageReadReceipts,
    getPollVotes,
    getActiveSessions,
    deleteForumTopic,
    getForumTopic,
    getForumTopics,
    createForumTopic,
    editForumTopic,
    pinForumTopic,
    readForumTopic,
    getChatFolders,
    createChat,
    checkChatInvite,
    getJoinRequests,
    getChatInviteLinks,
    getChatManagement,
    upgradeChat,
    getAdminLog,
    getSavedMessagesInfo,
    getSavedDialogs,
    getSavedHistory,
    getEarlierGroupHistory,
    getSavedTags,
    renameSavedTag,
    pinSavedDialog,
    setSavedMessageTags,
    getManagedParticipants,
    addChatMember,
    editChatParticipant,
    setChatSetting,
    exportChatInviteLink,
    editChatInviteLink,
    revokeChatInviteLink,
    deleteChatInviteLink,
    resolveJoinRequest,
    resolveAllJoinRequests,
    joinChatInvite,
    saveChatFolder,
    deleteChatFolder,
    reorderChatFolders,
    getFolderUpdates,
    joinFolderUpdates,
    getFolderLinks,
    exportFolderLink,
    deleteFolderLink,
    checkFolderInvite,
    joinFolderInvite,
    getPrivacy,
    setPrivacy,
    getReadTimePrivacy,
    setReadTimePrivacy,
    terminateSession,
    setSessionTtl,
    toggleReaction: toggleReaction,
    deleteMessage: deleteMessage,
    editMessage: editMessage,
    forwardMessage: forwardMessage,
    retryPendingSend: retryPendingSend,
    cancelPendingSend: cancelPendingSend,
    retryOutbox: retryOutbox,
    handleInboxReadFailure: handleInboxReadFailure,
  };
}
export type MessagingEngine = ReturnType<typeof makeMessagingEngineModule>;

export const makeMessagingEngine = Effect.fn('MessagingEngine.make')(function* (
  transport: TelegramTransport,
  store: CacheStore,
  options: { manageTabLease?: boolean } = {},
) {
  const state = yield* AccountState;
  const tasks = yield* EngineTasks;
  const crypto = yield* SecureRandom.SecureRandom;
  const rootScope = yield* Scope.Scope;
  const commandReady = yield* Deferred.make<void, Error>();
  const accountReady = yield* Deferred.make<void, Error>();
  const pendingQueue = yield* makePendingSendQueue(store, tasks);
  const resources = yield* makeResourceCache();
  let engine: MessagingEngine;
  const inboxReads = yield* makeCoalescingMailbox<number>({
    merge: Math.max,
    onFailure: (peerId, pending, error) =>
      Effect.suspend(() => engine.handleInboxReadFailure(peerId, pending, error)),
  });
  engine = makeMessagingEngineModule(
    transport,
    store,
    state,
    tasks,
    commandReady,
    accountReady,
    pendingQueue,
    inboxReads,
    options,
    rootScope,
    resources,
    crypto,
  );

  return engine;
});

export const MessagingEngineLayer = Layer.mergeAll(AccountStateLayer, EngineTasksLayer);
