import { reportDiagnostic } from './diagnostics';
import { Conversation } from './conversation';
import { PendingSendQueue } from './pendingQueue';
import { ResourceCache } from './resourceCache';
import { RetryScheduler } from './retryScheduler';
import type { CacheStore, TimedCacheValue } from '../persistence/store';
import { acquireSingleTabLease, TabLockUnsupportedError, type TabLease } from '../session/tabLock';
import type {
  CachedDialog,
  CachedMessage,
  EditMediaOptions,
  EngineSnapshot,
  OutgoingAttachmentMode,
  PendingSend,
  TelegramBotCallbackResult,
  TelegramBotCommand,
  TelegramChatAppearance,
  TelegramCredentials,
  TelegramDialog,
  TelegramHistoryGap,
  TelegramActivityKind,
  TelegramGroupMember,
  TelegramMessage,
  TelegramPeer,
  TelegramPeerSearchResult,
  TelegramReaction,
  TelegramResourceInvalidation,
  TelegramReplyTarget,
  TelegramSticker,
  TelegramStickerPack,
  TelegramSearchOffset,
  TelegramTextFormat,
  TelegramTransport,
  TelegramUrlAuthAcceptOptions,
  TelegramUrlAuthResult,
  TransportUpdateBatch,
  TelegramUserDetails,
  TransportUpdate,
} from '../types';

const GLOBAL_DIFFERENCE_LIMIT = 100;
const CHANNEL_DIFFERENCE_LIMIT = 500;
const DIALOG_PAGE_LIMIT = 100;
const HISTORY_LIMIT = 50;
const MAX_LOADED_HISTORIES = 8;
const MAX_MESSAGES_PER_HISTORY = 500;
const MAX_ACTIVE_MESSAGES = 5_000;
const MAX_MESSAGE_MUTATIONS = 5_000;
const HISTORY_RETRY_BASE_MS = 1_000;
const HISTORY_RETRY_MAX_MS = 30_000;
const SHARED_MEDIA_COUNT_TIMEOUT_MS = 5_000;
const MAX_ALBUM_ATTACHMENTS = 10;
const MAX_MESSAGE_TEXT_LENGTH = 4_096;
const MAX_CAPTION_TEXT_LENGTH = 1_024;
const EXPRESSION_INDEX_CACHE_KEYS = [
  'sticker-index:recent:v2',
  'sticker-index:packs:v2',
  'sticker-index:gifs:v2',
];
const PEER_METADATA_CACHE_TTL_MS = 5 * 60 * 1_000;

type Listener = (snapshot: EngineSnapshot) => void;
type ResourceListener = (event: TelegramResourceInvalidation) => void;

export class MessagingEngine {
  private snapshotValue: EngineSnapshot = {
    phase: 'idle',
    sync: 'stale',
    online: false,
    dialogs: [],
    messages: [],
    drafts: {},
    pending: [],
    loadingMessages: false,
    hasOlderMessages: false,
    loadingOlderMessages: false,
    pinnedMessages: [],
    historyGaps: [],
    activities: [],
  };
  private readonly listeners = new Set<Listener>();
  private readonly resourceListeners = new Set<ResourceListener>();
  private readonly lifecycleTasks = new Set<Promise<unknown>>();
  private readonly reactionQueues = new Map<string, Promise<void>>();
  private readonly reactionVersions = new Map<string, number>();
  private tabLease: TabLease | undefined;
  private unsubscribeTransport: (() => void) | undefined;
  private lifecycleGeneration = 0;
  private quiescing = false;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private epoch = 0;
  private updateQueue = Promise.resolve();
  private selectionVersion = 0;
  private lastPeerWrite = Promise.resolve();
  private readonly resources = new ResourceCache();
  private readonly mutationVersions = new Map<string, number>();
  private mutationSequence = 0;
  private readonly mutationTails = new Map<string, Promise<void>>();
  private dialogStateTail = Promise.resolve();
  private metadataWriteTail = Promise.resolve();
  private readonly pinnedMessageVersions = new Map<string, number>();
  private readonly pinnedMessageCache = new Map<string, TimedCacheValue<TelegramMessage[]>>();
  private readonly pinnedMessageCacheLoaded = new Set<string>();
  private readonly pinnedMessageRequests = new Map<
    string,
    { version: number; request: Promise<void> }
  >();
  private readonly groupMemberVersions = new Map<string, number>();
  private readonly groupMemberCache = new Map<string, TimedCacheValue<TelegramGroupMember[]>>();
  private readonly groupMemberCacheLoaded = new Set<string>();
  private readonly groupMemberRequests = new Map<
    string,
    { version: number; request: Promise<TelegramGroupMember[]> }
  >();
  private readonly draftWrites = new Map<string, Promise<void>>();
  private readonly draftVersions = new Map<string, number>();
  private readonly duplicateDraftSends = new Map<string, Map<string, Promise<void>>>();
  private readonly loadedHistories = new Map<
    string,
    { messages: TelegramMessage[]; hasOlderMessages: boolean }
  >();
  private readonly historyOffsets = new Map<string, number>();
  private readonly activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly userDetails = new Map<string, Promise<TelegramUserDetails>>();
  private readonly readReceiptRefreshes = new Map<string, Promise<void>>();
  private readonly unreadVersions = new Map<string, number>();
  private readonly historyVersions = new Map<string, number>();
  private readonly messageMutations = new Map<string, number>();
  private readonly historyFailures = new Map<string, { attempts: number; retryAt: number }>();
  private readonly historyIssues = new Map<
    string,
    { message: string; retryAt?: number | undefined; gap?: TelegramHistoryGap | undefined }
  >();
  private readonly historyGaps = new Map<string, TelegramHistoryGap[]>();
  private readonly historyModes = new Map<string, 'newest' | 'oldest' | 'anchor'>();
  private readonly historyAnchors = new Map<string, number>();
  private readonly pendingInboxReadMax = new Map<string, number>();
  private readonly inboxReadRequests = new Map<string, Promise<void>>();
  private readonly inboxReadRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingQueue: PendingSendQueue;
  private readonly channelRefreshes = new Map<string, Promise<void>>();
  private refreshingUpdates: Promise<void> | undefined;
  private retryingSync: Promise<void> | undefined;
  private flushingOutbox: Promise<void> | undefined;
  private disconnecting: Promise<void> | undefined;
  private readonly reconnect = new RetryScheduler(1_000, 30_000);
  private readonly sharedMediaCountRetry = new RetryScheduler(500, 30_000);
  private credentials: TelegramCredentials | undefined;
  private accountId: string | undefined;
  private cachedAccountId: string | undefined;
  private mayClaimLegacyAccount = true;
  private hasReachedReady = false;
  private messageRevision = 0;
  private messageMutationFloor = 0;
  private snapshotNotificationBatchDepth = 0;
  private snapshotNotificationPending = false;
  private metadataGeneration = 0;
  private readonly sharedMediaCountVersions = new Map<string, number>();
  private sharedMediaCountRequest: { peerId: string; request: Promise<void> } | undefined;
  private operationErrorArea: 'auth' | 'sync' | 'transport' | 'cache' | 'outbox' | undefined;
  private readViewport: {
    peerId?: string | undefined;
    visible: boolean;
    atBottom: boolean;
  } = { visible: false, atBottom: false };

  constructor(
    private readonly transport: TelegramTransport,
    private readonly store: CacheStore,
    private readonly options: { manageTabLease?: boolean } = {},
  ) {
    this.pendingQueue = new PendingSendQueue(store);
  }

  snapshot() {
    return this.snapshotValue;
  }

  clearOperationError() {
    this.operationErrorArea = undefined;
    this.patch({ operationError: undefined });
  }

  async setActiveConversationVisibility(
    peerId: string | undefined,
    state: { visible: boolean; atBottom: boolean },
  ) {
    this.readViewport = { peerId, visible: state.visible, atBottom: state.atBottom };
    if (!peerId || !this.canMarkRead(peerId)) return;
    const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
    if (dialog) await this.markRead(dialog, dialog.topMessageId);
  }

  async refreshReadReceipt(peerId = this.snapshotValue.activePeerId) {
    if (!this.snapshotValue.online || !peerId || !this.transport.getReadOutboxMaxId) return;
    const current = this.readReceiptRefreshes.get(peerId);
    if (current) return current;
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const refreshing = (async () => {
      const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
      if (!dialog) return;
      const maxMessageId = await this.transport.getReadOutboxMaxId!(dialog.peer);
      if (!this.isOperationCurrent(generation, accountId)) return;
      if (maxMessageId <= dialog.readOutboxMaxId) return;
      await this.enqueueSyntheticUpdates(
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
        generation,
        true,
        { accountId },
      );
    })();
    this.readReceiptRefreshes.set(peerId, refreshing);
    try {
      await refreshing;
    } finally {
      this.readReceiptRefreshes.delete(peerId);
    }
  }

  async retryMarkRead(peerId = this.snapshotValue.activePeerId) {
    if (!peerId) return;
    const timer = this.inboxReadRetryTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.inboxReadRetryTimers.delete(peerId);
    const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
    if (dialog) await this.markRead(dialog, dialog.topMessageId, true);
  }

  async markConversationRead(peerId: string) {
    if (this.inboxReadRetryTimers.has(peerId)) return;
    const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
    if (dialog) await this.markRead(dialog, dialog.topMessageId, true);
  }

  async refreshUpdates() {
    if (this.snapshotValue.phase !== 'ready' || !this.snapshotValue.online) return;
    if (this.refreshingUpdates) return this.refreshingUpdates;
    const generation = this.lifecycleGeneration;
    const refresh = this.updateQueue.then(() =>
      this.isLifecycleCurrent(generation)
        ? this.reconcileStartup(false, generation)
        : Promise.resolve(),
    );
    this.refreshingUpdates = refresh;
    this.updateQueue = refresh.catch((error: unknown) => {
      if (this.isLifecycleCurrent(generation)) {
        this.fail('sync', 'Could not catch up with Telegram updates.', error, false);
      }
    });
    try {
      await refresh;
    } finally {
      if (this.refreshingUpdates === refresh) this.refreshingUpdates = undefined;
    }
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.snapshotValue);
    return () => this.listeners.delete(listener);
  }

  subscribeResources(listener: ResourceListener) {
    this.resourceListeners.add(listener);
    return () => this.resourceListeners.delete(listener);
  }

  private invalidateResource(event: TelegramResourceInvalidation) {
    for (const listener of this.resourceListeners) listener(event);
  }

  async start(credentials: TelegramCredentials) {
    this.credentials = credentials;
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.retryingSync) return this.retryingSync;
    if (this.snapshotValue.phase === 'unauthorized') return;
    if (this.snapshotValue.phase === 'ready' && this.snapshotValue.online) return;
    if (this.snapshotValue.phase === 'ready' && !this.snapshotValue.online) {
      await this.retrySync();
      return;
    }

    this.quiescing = false;
    const generation = ++this.lifecycleGeneration;
    const starting = this.trackLifecycleTask(this.startSession(credentials, generation));
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async startSession(credentials: TelegramCredentials, generation: number) {
    if (this.options.manageTabLease !== false && !this.tabLease) {
      try {
        const lease = await acquireSingleTabLease();
        if (!this.isLifecycleCurrent(generation)) {
          lease?.release();
          return;
        }
        this.tabLease = lease;
      } catch (error) {
        if (!this.isLifecycleCurrent(generation)) return;
        if (error instanceof TabLockUnsupportedError) {
          this.patch({ phase: 'error', online: false, error: error.message });
          return;
        }
        this.fail('transport', 'Could not acquire the single-tab lock.', error);
        return;
      }
      if (!this.tabLease) {
        this.patch({ phase: 'error', error: 'TeleVecha is already open in another tab.' });
        return;
      }
    }

    this.patch({ phase: 'connecting', error: undefined });
    try {
      const { dialogs, drafts, draftRevisions, pending, epoch, lastPeerId, accountId } =
        await this.store.loadWorkspace();
      if (!this.isLifecycleCurrent(generation)) return;
      this.cachedAccountId = accountId;
      this.epoch = epoch;
      this.draftVersions.clear();
      for (const peerId of Object.keys(drafts)) {
        this.draftVersions.set(peerId, draftRevisions[peerId] ?? 0);
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
      const orderedPending = await this.pendingQueue.restore(compatiblePending);
      if (!this.isLifecycleCurrent(generation)) return;
      const publishCachedWorkspace = () => {
        this.patch({
          dialogs: this.sortDialogs(compatibleDialogs),
          drafts,
          pending: orderedPending,
          ...(lastPeerId ? { activePeerId: lastPeerId } : {}),
        });
      };
      try {
        await this.connectWithDeadline(credentials);
      } catch (error) {
        if (this.isLifecycleCurrent(generation)) publishCachedWorkspace();
        throw error;
      }
      if (!this.isLifecycleCurrent(generation)) return;
      if (!(await this.transport.isAuthorized())) {
        if (!this.isLifecycleCurrent(generation)) return;
        this.mayClaimLegacyAccount = false;
        this.patch({ phase: 'unauthorized', online: false, authStep: 'phone' });
        return;
      }
      if (!this.isLifecycleCurrent(generation)) return;
      const authorizedAccountId = await this.transport.getAuthorizedAccountId();
      if (!this.isLifecycleCurrent(generation)) return;
      if (accountId === undefined || accountId === authorizedAccountId) {
        publishCachedWorkspace();
      }
      await this.activateAuthorizedSession(this.mayClaimLegacyAccount, generation);
    } catch (error) {
      if (!this.isLifecycleCurrent(generation)) return;
      if (this.snapshotValue.online) {
        this.unsubscribeTransport?.();
        this.unsubscribeTransport = undefined;
        await this.disconnectTransport();
        this.patch({ online: false });
      }
      if (this.snapshotValue.dialogs.length > 0) {
        this.hasReachedReady = true;
        this.patch({
          phase: 'ready',
          sync: 'stale',
          online: false,
          error: `Could not connect to Telegram. ${this.errorMessage(error)}`,
        });
      } else {
        this.fail('transport', 'Could not start TeleVecha.', error);
      }
    }
  }

  async retrySync() {
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.retryingSync) return this.retryingSync;
    if (this.snapshotValue.phase === 'idle' || this.snapshotValue.phase === 'unauthorized') return;
    if (this.snapshotValue.phase === 'ready' && this.snapshotValue.online) return;
    const credentials = this.credentials;
    if (!credentials) return;
    const generation = this.lifecycleGeneration;
    const retry = this.trackLifecycleTask(
      (async () => {
        if (!this.tabLease) {
          try {
            const lease = await acquireSingleTabLease();
            if (!this.isLifecycleCurrent(generation)) {
              lease?.release();
              return;
            }
            this.tabLease = lease;
          } catch (error) {
            if (!this.isLifecycleCurrent(generation)) return;
            const message =
              error instanceof TabLockUnsupportedError
                ? error.message
                : `Could not acquire the single-tab lock. ${this.errorMessage(error)}`;
            this.patch({ phase: 'error', sync: 'stale', online: false, error: message });
            return;
          }
          if (!this.tabLease) {
            this.patch({
              phase: 'error',
              sync: 'stale',
              online: false,
              error: 'TeleVecha is already open in another tab.',
            });
            return;
          }
        }
        this.patch({ sync: 'recovering', error: undefined });
        try {
          await this.connectWithDeadline(credentials);
          if (!this.isLifecycleCurrent(generation)) return;
          if (!(await this.transport.isAuthorized())) {
            if (!this.isLifecycleCurrent(generation)) return;
            this.mayClaimLegacyAccount = false;
            this.patch({ phase: 'unauthorized', online: false, authStep: 'phone' });
            return;
          }
          if (!this.isLifecycleCurrent(generation)) return;
          await this.activateAuthorizedSession(this.mayClaimLegacyAccount, generation);
        } catch (error) {
          if (!this.isLifecycleCurrent(generation)) return;
          if (this.snapshotValue.online) {
            this.unsubscribeTransport?.();
            this.unsubscribeTransport = undefined;
            await this.disconnectTransport();
            this.patch({ online: false });
          }
          if (this.snapshotValue.dialogs.length > 0 || this.hasReachedReady) {
            this.patch({
              phase: 'ready',
              sync: 'stale',
              online: false,
              error: `Could not reconnect to Telegram. ${this.errorMessage(error)}`,
            });
          } else {
            this.fail('transport', 'Could not reconnect to Telegram.', error);
          }
        }
      })(),
    );
    this.retryingSync = retry;
    try {
      await retry;
    } finally {
      if (this.retryingSync === retry) this.retryingSync = undefined;
    }
  }

  async stop() {
    if (this.stopping) return this.stopping;
    const stopping = this.stopSession();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  private async stopSession() {
    this.quiescing = true;
    this.reconnect.cancel();
    this.lifecycleGeneration += 1;
    this.selectionVersion += 1;
    for (const peerId of new Set([
      ...this.snapshotValue.dialogs.map(({ peer }) => peer.id),
      ...this.loadedHistories.keys(),
    ])) {
      this.historyVersions.set(peerId, this.historyVersion(peerId) + 1);
    }
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = undefined;
    for (const timer of this.activityTimers.values()) clearTimeout(timer);
    this.activityTimers.clear();
    for (const timer of this.inboxReadRetryTimers.values()) clearTimeout(timer);
    this.inboxReadRetryTimers.clear();
    let disconnectError: unknown;
    try {
      this.patch({
        phase: 'idle',
        sync: 'stale',
        online: false,
        activePeerId: undefined,
        loadingMessages: false,
        loadingOlderMessages: false,
      });
      try {
        await this.disconnectTransport();
      } catch (error) {
        disconnectError = error;
      }
      await this.drainLifecycleTasks();
      await Promise.allSettled([
        this.updateQueue,
        this.lastPeerWrite,
        this.dialogStateTail,
        this.metadataWriteTail,
        ...this.draftWrites.values(),
        ...this.pendingQueue.pendingWrites(),
        ...this.inboxReadRequests.values(),
        ...this.readReceiptRefreshes.values(),
        ...this.channelRefreshes.values(),
      ]);
      if (disconnectError) throw disconnectError;
    } finally {
      try {
        this.patch({
          phase: 'idle',
          sync: 'stale',
          online: false,
          pending: [],
          activePeerId: undefined,
          loadingMessages: false,
          loadingOlderMessages: false,
        });
      } finally {
        this.tabLease?.release();
        this.tabLease = undefined;
        this.reactionQueues.clear();
        this.reactionVersions.clear();
        this.resources.clear();
        this.mutationVersions.clear();
        this.mutationSequence = 0;
        this.mutationTails.clear();
        this.pinnedMessageVersions.clear();
        this.pinnedMessageCache.clear();
        this.pinnedMessageCacheLoaded.clear();
        this.pinnedMessageRequests.clear();
        this.groupMemberVersions.clear();
        this.groupMemberCache.clear();
        this.groupMemberCacheLoaded.clear();
        this.groupMemberRequests.clear();
        this.sharedMediaCountVersions.clear();
        this.sharedMediaCountRequest = undefined;
        this.sharedMediaCountRetry.reset();
        this.pendingQueue.clear();
      }
    }
  }

  async selectChat(peerId: string, rememberSelection = true) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    if (
      this.snapshotValue.activePeerId === peerId &&
      !this.snapshotValue.loadingMessages &&
      this.snapshotValue.messages.length > 0
    ) {
      const current = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
      if (current) {
        if (!this.snapshotValue.sharedMediaCounts) void this.loadSharedMediaCounts(current);
        if (this.snapshotValue.pinnedMessages.length === 0) void this.loadPinnedMessages(current);
      }
      return;
    }
    const dialog = this.snapshotValue.dialogs.find((candidate) => candidate.peer.id === peerId);
    if (!dialog) return;
    const previousHistoryError =
      this.snapshotValue.activePeerId === peerId ? this.snapshotValue.historyError : undefined;
    const selectionVersion = ++this.selectionVersion;
    if (this.snapshotValue.activePeerId !== peerId) {
      this.readViewport = { peerId, visible: false, atBottom: false };
    }
    const previousPeerId = this.snapshotValue.activePeerId;
    if (previousPeerId && this.snapshotValue.messages.length > 0) {
      this.rememberHistory(previousPeerId, {
        messages: this.snapshotValue.messages,
        hasOlderMessages: this.snapshotValue.hasOlderMessages,
      });
    }
    const loaded = this.loadedHistories.get(peerId);

    if (loaded) {
      const issue = this.historyIssues.get(peerId);
      this.touchHistory(peerId);
      const messages =
        loaded.messages.length > HISTORY_LIMIT
          ? loaded.messages.slice(-HISTORY_LIMIT)
          : loaded.messages;
      const oldestId = messages[0]?.id;
      if (oldestId !== undefined) this.historyOffsets.set(peerId, oldestId);
      this.patch({
        activePeerId: peerId,
        messages,
        loadingMessages: false,
        hasOlderMessages: loaded.messages.length > messages.length || loaded.hasOlderMessages,
        loadingOlderMessages: false,
        sharedMediaCounts: undefined,
        pinnedMessages: [],
        historyGaps: this.historyGaps.get(peerId) ?? [],
        historyError: issue?.message,
        historyRetryAt: issue?.retryAt,
      });
      const lastPeerWrite = this.lastPeerWrite.then(() =>
        rememberSelection && this.isOperationCurrent(generation, accountId)
          ? this.store.saveLastPeerId(peerId)
          : undefined,
      );
      this.lastPeerWrite = lastPeerWrite.catch((error: unknown) => {
        this.reportFailure('cache', 'Could not remember the selected conversation.', error);
      });
      if (this.canMarkRead(peerId)) void this.markRead(dialog, dialog.topMessageId);
      if (this.snapshotValue.online) void this.loadSharedMediaCounts(dialog);
      void this.loadPinnedMessages(dialog);
      // A channel cursor can legitimately be newer than an incomplete local cache
      // (for example after another tab refreshed dialog metadata first). Reconcile
      // the newest page in the background so the cache remains instant to render
      // but missing middle messages are restored without requiring a reconnect.
      if (this.snapshotValue.online && this.cachedChannelNeedsRepair(dialog, messages)) {
        void this.refreshActiveConversationAfterConnect(generation, accountId);
      }
      return;
    }

    this.patch({
      activePeerId: peerId,
      messages: [],
      loadingMessages: true,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      sharedMediaCounts: undefined,
      pinnedMessages: [],
      historyGaps: this.historyGaps.get(peerId) ?? [],
      historyError: undefined,
      historyRetryAt: undefined,
    });
    const lastPeerWrite = this.lastPeerWrite.then(() =>
      rememberSelection && this.isOperationCurrent(generation, accountId)
        ? this.store.saveLastPeerId(peerId)
        : undefined,
    );
    this.lastPeerWrite = lastPeerWrite.catch((error: unknown) => {
      this.reportFailure('cache', 'Could not remember the selected conversation.', error);
    });
    let cached: CachedMessage[] = [];
    try {
      cached = (await this.store.loadMessages(peerId, HISTORY_LIMIT)).filter(
        (message) => message.cacheEpoch === this.epoch,
      );
    } catch (error) {
      if (this.isOperationCurrent(generation, accountId)) {
        this.reportFailure('cache', `Could not load cached messages for ${dialog.title}.`, error);
      }
    }
    if (
      !this.isOperationCurrent(generation, accountId) ||
      selectionVersion !== this.selectionVersion
    ) {
      return;
    }
    if (cached.length > 0) {
      const issue = this.historyIssues.get(peerId);
      const messages = this.sortMessages(cached);
      const oldestId = messages[0]?.id;
      if (oldestId !== undefined) this.historyOffsets.set(peerId, oldestId);
      this.rememberHistory(
        peerId,
        {
          messages,
          hasOlderMessages: true,
        },
        'newest',
      );
      this.patch({
        messages,
        loadingMessages: false,
        hasOlderMessages: true,
        historyError: issue?.message,
        historyRetryAt: issue?.retryAt,
      });
      if (this.canMarkRead(peerId)) void this.markRead(dialog, dialog.topMessageId);
      if (this.snapshotValue.online) void this.loadSharedMediaCounts(dialog);
      void this.loadPinnedMessages(dialog);
      if (this.snapshotValue.online && this.cachedChannelNeedsRepair(dialog, messages)) {
        void this.refreshActiveConversationAfterConnect(generation, accountId);
      }
      return;
    }

    if (!this.snapshotValue.online) {
      const message = 'Message history is unavailable while Telegram is offline.';
      this.historyIssues.set(peerId, { message });
      this.patch({
        loadingMessages: false,
        historyError: message,
      });
      return;
    }

    const previousFailure = this.historyFailures.get(peerId);
    if (previousFailure && Date.now() < previousFailure.retryAt) {
      this.patch({
        loadingMessages: false,
        hasOlderMessages: false,
        historyError:
          this.historyIssues.get(peerId)?.message ??
          previousHistoryError ??
          `Could not load ${dialog.title}. Retry after the current backoff expires.`,
        historyRetryAt: previousFailure.retryAt,
      });
      return;
    }

    const historyVersion = this.historyVersion(peerId);
    const requestRevision = this.messageRevision;
    try {
      const page = await this.transport.getHistory(dialog.peer, HISTORY_LIMIT);
      const applied = await this.queueDialogStateOperation(async () => {
        if (
          !this.isHistoryOperationCurrent(peerId, historyVersion, generation, accountId) ||
          selectionVersion !== this.selectionVersion
        ) {
          return false;
        }
        const messages = page.messages.map((message) => ({ ...message, cacheEpoch: this.epoch }));
        const fetched = this.filterFetchedMessages(peerId, messages, requestRevision);
        await this.store.putMessages(fetched);
        if (
          !this.isHistoryOperationCurrent(peerId, historyVersion, generation, accountId) ||
          selectionVersion !== this.selectionVersion
        ) {
          return false;
        }
        const sortedMessages = this.mergeFetchedMessages(
          peerId,
          this.snapshotValue.messages,
          fetched,
          requestRevision,
        );
        if (page.nextBeforeMessageId !== undefined) {
          this.historyOffsets.set(peerId, page.nextBeforeMessageId);
        } else {
          const oldestId = sortedMessages[0]?.id;
          if (oldestId !== undefined) this.historyOffsets.set(peerId, oldestId);
        }
        const history = this.rememberHistory(
          peerId,
          {
            messages: sortedMessages,
            hasOlderMessages: page.hasOlder,
          },
          'newest',
        );
        this.clearHistoryFailure(peerId);
        this.patch({
          messages: history.messages,
          loadingMessages: false,
          hasOlderMessages: history.hasOlderMessages,
          historyError: undefined,
          historyRetryAt: undefined,
        });
        return true;
      });
      if (!applied) return;
      if (this.canMarkRead(peerId)) void this.markRead(dialog, dialog.topMessageId);
      void this.loadSharedMediaCounts(dialog);
      void this.loadPinnedMessages(dialog);
    } catch (error) {
      if (
        this.isOperationCurrent(generation, accountId) &&
        selectionVersion === this.selectionVersion
      ) {
        const failure = this.recordHistoryFailure(peerId);
        const message = `Could not load ${dialog.title}. ${this.errorMessage(error)}`;
        this.historyIssues.set(peerId, { message, retryAt: failure.retryAt });
        this.patch({
          loadingMessages: false,
          hasOlderMessages: false,
          historyError: message,
          historyRetryAt: failure.retryAt,
        });
      }
      if (this.isOperationCurrent(generation, accountId)) {
        this.reportFailure('sync', `Could not load ${dialog.title}.`, error);
      }
    }
  }

  async openConversation(peerId: string, rememberSelection = true) {
    await this.selectChat(peerId, rememberSelection);
    if (this.snapshotValue.activePeerId !== peerId) {
      throw new Error('Could not select the requested conversation.');
    }
    return new Conversation(this, peerId);
  }

  ensureSharedMediaCounts(peerId = this.snapshotValue.activePeerId) {
    if (
      !peerId ||
      !this.snapshotValue.online ||
      this.snapshotValue.activePeerId !== peerId ||
      this.snapshotValue.sharedMediaCounts
    ) {
      return Promise.resolve();
    }
    const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
    return dialog ? this.loadSharedMediaCounts(dialog) : Promise.resolve();
  }

  private loadSharedMediaCounts(dialog: TelegramDialog) {
    const current = this.sharedMediaCountRequest;
    if (current?.peerId === dialog.peer.id) return current.request;
    this.sharedMediaCountRetry.reset();
    const request = Promise.resolve()
      .then(() => this.fetchSharedMediaCounts(dialog))
      .then((retry) => {
        if (retry) this.scheduleSharedMediaCountRetry(dialog);
      })
      .finally(() => {
        if (this.sharedMediaCountRequest?.request === request) {
          this.sharedMediaCountRequest = undefined;
        }
      });
    this.sharedMediaCountRequest = { peerId: dialog.peer.id, request };
    return request;
  }

  private scheduleSharedMediaCountRetry(dialog: TelegramDialog) {
    this.sharedMediaCountRetry.schedule(async () => {
      if (
        !this.snapshotValue.online ||
        this.snapshotValue.activePeerId !== dialog.peer.id ||
        !this.snapshotValue.dialogs.some(({ peer }) => peer.id === dialog.peer.id)
      ) {
        return false;
      }
      return this.fetchSharedMediaCounts(dialog);
    });
  }

  private async fetchSharedMediaCounts(dialog: TelegramDialog) {
    if (!this.snapshotValue.online) return false;
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const requestVersion = (this.sharedMediaCountVersions.get(dialog.peer.id) ?? 0) + 1;
    this.sharedMediaCountVersions.set(dialog.peer.id, requestVersion);
    this.patch({ sharedMediaCounts: undefined });
    try {
      const counts = await this.getSharedMediaCountsWithDeadline(dialog.peer);
      if (
        this.isOperationCurrent(generation, accountId) &&
        this.sharedMediaCountVersions.get(dialog.peer.id) === requestVersion &&
        this.snapshotValue.activePeerId === dialog.peer.id
      ) {
        this.patch({ sharedMediaCounts: counts });
        this.sharedMediaCountRetry.reset();
      }
      return false;
    } catch (error) {
      if (
        this.isOperationCurrent(generation, accountId) &&
        this.sharedMediaCountVersions.get(dialog.peer.id) === requestVersion &&
        this.snapshotValue.activePeerId === dialog.peer.id
      ) {
        this.fail('sync', `Could not load shared-media counts for ${dialog.title}.`, error, false);
        return true;
      }
      return false;
    }
  }

  private async getSharedMediaCountsWithDeadline(peer: TelegramPeer) {
    const request = this.transport.getSharedMediaCounts(peer);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('Shared-media counts timed out after 5 seconds.')),
        SHARED_MEDIA_COUNT_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private loadPinnedMessages(
    dialog: TelegramDialog,
    version = this.pinnedMessageVersions.get(dialog.peer.id) ?? 0,
  ) {
    const current = this.pinnedMessageRequests.get(dialog.peer.id);
    if (current?.version === version) return current.request;
    const request = this.loadPinnedMessagesFromCacheAndTelegram(dialog, version).finally(() => {
      if (this.pinnedMessageRequests.get(dialog.peer.id)?.request === request) {
        this.pinnedMessageRequests.delete(dialog.peer.id);
      }
    });
    this.pinnedMessageRequests.set(dialog.peer.id, { version, request });
    return request;
  }

  private async loadPinnedMessagesFromCacheAndTelegram(dialog: TelegramDialog, version: number) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const cached = await this.cachedPinnedMessages(dialog.peer.id);
    if (
      cached &&
      this.isOperationCurrent(generation, accountId) &&
      this.snapshotValue.activePeerId === dialog.peer.id &&
      (this.pinnedMessageVersions.get(dialog.peer.id) ?? 0) === version
    ) {
      this.patch({ pinnedMessages: cached.value });
    }
    if (this.isFreshPeerMetadata(cached) || !this.snapshotValue.online) return;
    try {
      const messages = await this.transport.getPinnedMessages(dialog.peer);
      if (
        this.isOperationCurrent(generation, accountId) &&
        (this.pinnedMessageVersions.get(dialog.peer.id) ?? 0) === version
      ) {
        await this.rememberPinnedMessages(dialog.peer.id, messages);
        if (this.snapshotValue.activePeerId === dialog.peer.id) {
          this.patch({ pinnedMessages: messages });
        }
      }
    } catch (error) {
      if (this.isOperationCurrent(generation, accountId)) {
        this.fail('sync', `Could not load pinned messages for ${dialog.title}.`, error, false);
      }
    }
  }

  async getSharedMedia(kind: import('../types').SharedMediaKind, offset?: TelegramSearchOffset) {
    const dialog = this.snapshotValue.dialogs.find(
      ({ peer }) => peer.id === this.snapshotValue.activePeerId,
    );
    return dialog
      ? this.transport.getSharedMedia(dialog.peer, kind, 100, offset)
      : { messages: [], hasMore: false };
  }

  async searchMessages(query: string, global: boolean, offset?: TelegramSearchOffset) {
    const dialog = this.snapshotValue.dialogs.find(
      ({ peer }) => peer.id === this.snapshotValue.activePeerId,
    );
    if (!global && !dialog) return { messages: [], hasMore: false };
    return this.transport.searchMessages(query, global ? undefined : dialog?.peer, 50, offset);
  }

  searchPeers(query: string) {
    const term = query.trim();
    if (!term || !this.snapshotValue.online) return Promise.resolve([]);
    return this.transport.searchPeers(term, 50);
  }

  async addPeer(result: TelegramPeerSearchResult) {
    const existing = this.snapshotValue.dialogs.find(({ peer }) => peer.id === result.peer.id);
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
          cacheEpoch: this.epoch,
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
          hasAvatar: result.hasAvatar,
          avatarId: result.avatarId,
          cacheEpoch: this.epoch,
        };
    this.patch({
      dialogs: this.sortDialogs([
        ...this.snapshotValue.dialogs.filter(({ peer }) => peer.id !== result.peer.id),
        dialog,
      ]),
    });
  }

  async openMessage(message: TelegramMessage) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === message.peerId);
    if (!dialog) return false;
    await this.selectChat(message.peerId);
    if (
      !this.isOperationCurrent(generation, accountId) ||
      this.snapshotValue.activePeerId !== message.peerId
    ) {
      return false;
    }
    if (this.snapshotValue.messages.some(({ id }) => id === message.id)) return true;

    const historyVersion = this.historyVersion(message.peerId);
    const requestRevision = this.messageRevision;
    try {
      const context = this.transport.getHistoryAround
        ? await this.transport.getHistoryAround(dialog.peer, message.id, HISTORY_LIMIT)
        : (await this.transport.getHistory(dialog.peer, HISTORY_LIMIT, message.id + 1)).messages;
      if (!this.isHistoryOperationCurrent(message.peerId, historyVersion, generation, accountId)) {
        return false;
      }
      if (this.snapshotValue.activePeerId !== message.peerId) return false;
      const resolvedTarget = context.find(({ id }) => id === message.id) ?? message;
      const fetched = this.filterFetchedMessages(
        message.peerId,
        [...context.filter(({ id }) => id !== message.id), resolvedTarget].map((item) => ({
          ...item,
          cacheEpoch: this.epoch,
        })),
        requestRevision,
      );
      await this.store.putMessages(fetched);
      if (
        !this.isHistoryOperationCurrent(message.peerId, historyVersion, generation, accountId) ||
        this.snapshotValue.activePeerId !== message.peerId
      ) {
        return false;
      }
      const previousMessages = this.snapshotValue.messages;
      const messages = this.mergeFetchedMessages(
        message.peerId,
        previousMessages,
        fetched,
        requestRevision,
      );
      this.recordLoadedHistoryRange(message.peerId, previousMessages, fetched);
      this.historyAnchors.set(message.peerId, resolvedTarget.id);
      // Keep the existing newest-window frontier. The around-target window can
      // be far older; replacing the cursor with its oldest ID would make the
      // entire middle gap unreachable by backward pagination.
      const oldestId = messages[0]?.id;
      const history = this.rememberHistory(
        message.peerId,
        {
          messages,
          hasOlderMessages: this.snapshotValue.hasOlderMessages || (oldestId ?? 1) > 1,
        },
        'anchor',
      );
      this.patch({
        messages: history.messages,
        hasOlderMessages: history.hasOlderMessages,
        historyGaps: this.historyGaps.get(message.peerId) ?? [],
      });
      return true;
    } catch (error) {
      if (this.isOperationCurrent(generation, accountId)) {
        this.fail('sync', `Could not open the selected message in ${dialog.title}.`, error, false);
      }
      return false;
    }
  }

  async loadHistoryGap(gap: TelegramHistoryGap) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const peerId = this.snapshotValue.activePeerId;
    if (!peerId || this.snapshotValue.loadingOlderMessages) return;
    const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
    const currentGap = this.findHistoryGap(peerId, gap);
    if (!dialog || !currentGap) return;

    // An explicit gap action is a manual retry and bypasses automatic backoff.
    this.clearHistoryFailure(peerId);
    this.patch({
      loadingOlderMessages: true,
      historyError: undefined,
      historyRetryAt: undefined,
    });
    if (!this.snapshotValue.online) {
      const message = 'Messages in this gap are unavailable while Telegram is offline.';
      this.historyIssues.set(peerId, { message, gap: currentGap });
      this.patch({ historyError: message });
      this.patch({ loadingOlderMessages: false });
      return;
    }

    const historyVersion = this.historyVersion(peerId);
    const requestRevision = this.messageRevision;
    try {
      const page = await this.transport.getHistory(
        dialog.peer,
        HISTORY_LIMIT,
        currentGap.newerMinMessageId,
      );
      if (page.messages.length === 0 && page.hasOlder) {
        throw new Error('Telegram returned no progress while loading this message gap.');
      }
      if (
        !this.isHistoryOperationCurrent(peerId, historyVersion, generation, accountId) ||
        this.snapshotValue.activePeerId !== peerId
      ) {
        return;
      }
      const fetched = this.filterFetchedMessages(
        peerId,
        page.messages.map((item) => ({ ...item, cacheEpoch: this.epoch })),
        requestRevision,
      );
      await this.store.putMessages(fetched);
      if (
        !this.isHistoryOperationCurrent(peerId, historyVersion, generation, accountId) ||
        this.snapshotValue.activePeerId !== peerId
      ) {
        return;
      }
      const messages = this.mergeFetchedMessages(
        peerId,
        this.snapshotValue.messages,
        fetched,
        requestRevision,
      );
      const nextGaps = this.advanceHistoryGap(peerId, currentGap, page.messages, page.hasOlder);
      const pageOldestId = page.messages.reduce<number | undefined>(
        (minimum, item) => (minimum === undefined ? item.id : Math.min(minimum, item.id)),
        undefined,
      );
      if (this.historyOffsets.get(peerId) === currentGap.newerMinMessageId) {
        const nextOffset = nextGaps.some(
          (candidate) => candidate.olderMaxMessageId === currentGap.olderMaxMessageId,
        )
          ? (page.nextBeforeMessageId ?? pageOldestId)
          : messages[0]?.id;
        if (nextOffset !== undefined) this.historyOffsets.set(peerId, nextOffset);
      }
      const history = this.rememberHistory(
        peerId,
        { messages, hasOlderMessages: this.snapshotValue.hasOlderMessages },
        'anchor',
      );
      this.clearHistoryFailure(peerId);
      this.patch({
        messages: history.messages,
        historyGaps: this.historyGaps.get(peerId) ?? nextGaps,
        historyError: undefined,
        historyRetryAt: undefined,
      });
    } catch (error) {
      if (!this.isOperationCurrent(generation, accountId)) return;
      const failure = this.recordHistoryFailure(peerId);
      const message = `Could not load messages in ${dialog.title}. ${this.errorMessage(error)}`;
      this.historyIssues.set(peerId, { message, retryAt: failure.retryAt, gap: currentGap });
      if (this.snapshotValue.activePeerId === peerId) {
        this.patch({ historyError: message, historyRetryAt: failure.retryAt });
      }
      this.reportFailure('sync', `Could not load a message gap from ${dialog.title}.`, error);
    } finally {
      if (
        this.isOperationCurrent(generation, accountId) &&
        this.snapshotValue.activePeerId === peerId
      ) {
        this.patch({ loadingOlderMessages: false });
      }
    }
  }

  async setMuted(peer: TelegramPeer, muted: boolean) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const operationKey = `mute:${peer.id}`;
    const operationVersion = this.nextMutationVersion(this.mutationVersions, operationKey);
    return this.trackVersionedMutation(
      operationKey,
      operationVersion,
      this.queueMutation(operationKey, async () => {
        if (this.mutationVersions.get(operationKey) !== operationVersion) return false;
        try {
          await this.transport.setMuted(peer, muted);
          if (!this.isOperationCurrent(generation, accountId)) return false;
          return await this.queueDialogStateOperation(async () => {
            if (!this.isOperationCurrent(generation, accountId)) return false;
            const dialogs = this.snapshotValue.dialogs.map((dialog) =>
              dialog.peer.id === peer.id ? { ...dialog, muted } : dialog,
            );
            this.patch({ dialogs });
            const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
            if (changed && !changed.transient) {
              await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
            }
            return true;
          });
        } catch (error) {
          if (this.isOperationCurrent(generation, accountId)) {
            this.fail('sync', 'Could not change notification settings.', error, false);
          }
          return false;
        }
      }),
    );
  }

  getUserDetails(peer: TelegramPeer) {
    const stored = this.snapshotValue.dialogs.find(
      ({ peer: item }) => item.id === peer.id,
    )?.userDetails;
    if (stored) return Promise.resolve(stored);
    const cached = this.userDetails.get(peer.id);
    if (cached) return cached;
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const metadataGeneration = this.metadataGeneration;
    const request = this.trackLifecycleTask(
      this.transport
        .getUserDetails(peer)
        .then(async (details) => {
          await this.queueDialogStateOperation(async () => {
            if (
              !this.isOperationCurrent(generation, accountId) ||
              metadataGeneration !== this.metadataGeneration
            ) {
              return;
            }
            const dialogs = this.snapshotValue.dialogs.map((dialog) =>
              dialog.peer.id === peer.id ? { ...dialog, userDetails: details } : dialog,
            );
            this.patch({ dialogs });
            const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
            if (changed && !changed.transient) {
              await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
            }
          });
          return details;
        })
        .catch((error: unknown) => {
          if (this.userDetails.get(peer.id) === request) this.userDetails.delete(peer.id);
          if (
            this.isOperationCurrent(generation, accountId) &&
            metadataGeneration === this.metadataGeneration
          ) {
            this.fail('sync', 'Could not load user details.', error, false);
          }
          throw error;
        }),
    );
    this.userDetails.set(peer.id, request);
    return request;
  }

  async getGroupMembers(peer: TelegramPeer, limit = 50) {
    if (peer.kind === 'user' || !this.transport.getGroupMembers) return Promise.resolve([]);
    const cached = await this.cachedGroupMembers(peer.id);
    if (cached) {
      if (!this.isFreshPeerMetadata(cached) && this.snapshotValue.online) {
        void this.refreshGroupMembers(peer, limit).catch(() => undefined);
      }
      return cached.value.slice(0, limit);
    }
    if (!this.snapshotValue.online) return [];
    return this.refreshGroupMembers(peer, limit);
  }

  private refreshGroupMembers(peer: TelegramPeer, limit: number) {
    const version = this.groupMemberVersions.get(peer.id) ?? 0;
    const current = this.groupMemberRequests.get(peer.id);
    if (current?.version === version) return current.request;
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const request = this.transport.getGroupMembers!(peer, limit)
      .then(async (members) => {
        if (
          !this.isOperationCurrent(generation, accountId) ||
          (this.groupMemberVersions.get(peer.id) ?? 0) !== version
        ) {
          return this.groupMemberCache.get(peer.id)?.value.slice(0, limit) ?? [];
        }
        await this.rememberGroupMembers(peer.id, members);
        this.invalidateResource({ kind: 'group-members', peerId: peer.id });
        return members;
      })
      .finally(() => {
        if (this.groupMemberRequests.get(peer.id)?.request === request) {
          this.groupMemberRequests.delete(peer.id);
        }
      });
    this.groupMemberRequests.set(peer.id, { version, request });
    return request;
  }

  async setBlocked(peer: TelegramPeer, blocked: boolean) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const operationKey = `block:${peer.id}`;
    const operationVersion = this.nextMutationVersion(this.mutationVersions, operationKey);
    return this.trackVersionedMutation(
      operationKey,
      operationVersion,
      this.queueMutation(operationKey, async () => {
        if (this.mutationVersions.get(operationKey) !== operationVersion) return false;
        try {
          await this.transport.setBlocked(peer, blocked);
          if (!this.isOperationCurrent(generation, accountId)) return false;
          const current = await this.userDetails.get(peer.id)?.catch(() => undefined);
          if (!this.isOperationCurrent(generation, accountId)) return false;
          return await this.queueDialogStateOperation(async () => {
            if (!this.isOperationCurrent(generation, accountId)) return false;
            const stored =
              current ??
              this.snapshotValue.dialogs.find(({ peer: item }) => item.id === peer.id)?.userDetails;
            if (stored) {
              const userDetails = { ...stored, blocked };
              this.userDetails.set(peer.id, Promise.resolve(userDetails));
              const dialogs = this.snapshotValue.dialogs.map((dialog) =>
                dialog.peer.id === peer.id ? { ...dialog, userDetails } : dialog,
              );
              this.patch({ dialogs });
              const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
              if (changed && !changed.transient) {
                await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
              }
            }
            return true;
          });
        } catch (error) {
          if (this.isOperationCurrent(generation, accountId)) {
            this.fail(
              'sync',
              `Could not ${blocked ? 'block' : 'unblock'} this user.`,
              error,
              false,
            );
          }
          return false;
        }
      }),
    );
  }

  async updateContact(peer: TelegramPeer, firstName: string, lastName: string, phone: string) {
    if (!this.transport.updateContact) return false;
    try {
      await this.transport.updateContact(peer, firstName, lastName, phone);
      return await this.queueDialogStateOperation(async () => {
        const dialogs = this.snapshotValue.dialogs.map((dialog) => {
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
        this.patch({ dialogs });
        const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
        if (changed && !changed.transient) {
          await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
        }
        if (changed?.userDetails) {
          this.userDetails.set(peer.id, Promise.resolve(changed.userDetails));
        }
        return true;
      });
    } catch (error) {
      this.fail('sync', 'Could not update this contact.', error, false);
      return false;
    }
  }

  async deleteContact(peer: TelegramPeer) {
    if (!this.transport.deleteContact) return false;
    try {
      await this.transport.deleteContact(peer);
      return await this.queueDialogStateOperation(async () => {
        const dialogs = this.snapshotValue.dialogs.map((dialog) =>
          dialog.peer.id === peer.id && dialog.userDetails
            ? { ...dialog, userDetails: { ...dialog.userDetails, isContact: false } }
            : dialog,
        );
        this.patch({ dialogs });
        const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
        if (changed && !changed.transient) {
          await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
        }
        if (changed?.userDetails) {
          this.userDetails.set(peer.id, Promise.resolve(changed.userDetails));
        }
        return true;
      });
    } catch (error) {
      this.fail('sync', 'Could not delete this contact.', error, false);
      return false;
    }
  }

  async setPinnedDialog(peer: TelegramPeer, pinned: boolean) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const operationKey = `dialog-pin:${peer.id}`;
    const operationVersion = this.nextMutationVersion(this.mutationVersions, operationKey);
    return this.trackVersionedMutation(
      operationKey,
      operationVersion,
      this.queueMutation(operationKey, async () => {
        if (this.mutationVersions.get(operationKey) !== operationVersion) return false;
        try {
          await this.transport.setPinnedDialog(peer, pinned);
          if (!this.isOperationCurrent(generation, accountId)) return false;
          return await this.queueDialogStateOperation(async () => {
            if (!this.isOperationCurrent(generation, accountId)) return false;
            const dialogs = this.sortDialogs(
              this.snapshotValue.dialogs.map((dialog) =>
                dialog.peer.id === peer.id ? { ...dialog, pinned } : dialog,
              ),
            );
            this.patch({ dialogs });
            const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
            if (changed && !changed.transient) {
              await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
            }
            return true;
          });
        } catch (error) {
          if (this.isOperationCurrent(generation, accountId)) {
            this.fail('sync', `Could not ${pinned ? 'pin' : 'unpin'} this chat.`, error, false);
          }
          return false;
        }
      }),
    );
  }

  async setArchived(peer: TelegramPeer, archived: boolean) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const operationKey = `archive:${peer.id}`;
    const operationVersion = this.nextMutationVersion(this.mutationVersions, operationKey);
    return this.trackVersionedMutation(
      operationKey,
      operationVersion,
      this.queueMutation(operationKey, async () => {
        if (this.mutationVersions.get(operationKey) !== operationVersion) return true;
        try {
          const result = await this.transport.setArchived(peer, archived);
          if (!this.isOperationCurrent(generation, accountId)) return true;
          await this.acceptMutationUpdateBatches(result.updateBatches, generation, accountId);
          if (!this.isOperationCurrent(generation, accountId)) return true;
          return await this.queueDialogStateOperation(async () => {
            if (!this.isOperationCurrent(generation, accountId)) return true;
            const dialogs = this.sortDialogs(
              this.snapshotValue.dialogs.map((dialog) =>
                dialog.peer.id === peer.id ? { ...dialog, archived } : dialog,
              ),
            );
            this.patch({ dialogs });
            const changed = dialogs.find((dialog) => dialog.peer.id === peer.id);
            if (changed && !changed.transient) {
              await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
            }
            return true;
          });
        } catch (error) {
          if (this.isOperationCurrent(generation, accountId)) {
            this.fail(
              'sync',
              `Could not ${archived ? 'archive' : 'unarchive'} this chat.`,
              error,
              false,
            );
          }
          return false;
        }
      }),
    );
  }

  async deleteDialog(peer: TelegramPeer) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const operationKey = `delete-dialog:${peer.id}`;
    const operationVersion = this.nextMutationVersion(this.mutationVersions, operationKey);
    return this.trackVersionedMutation(
      operationKey,
      operationVersion,
      (async () => {
        try {
          const result = await this.transport.deleteDialog(peer);
          if (!this.isOperationCurrent(generation, accountId)) return false;
          await this.acceptMutationUpdateBatches(result.updateBatches, generation, accountId);
          if (
            !this.isOperationCurrent(generation, accountId) ||
            this.mutationVersions.get(operationKey) !== operationVersion
          ) {
            return false;
          }
          return await this.queueDialogStateOperation(async () => {
            if (
              !this.isOperationCurrent(generation, accountId) ||
              this.mutationVersions.get(operationKey) !== operationVersion
            ) {
              return false;
            }
            const dialogs = this.snapshotValue.dialogs.filter(
              (dialog) => dialog.peer.id !== peer.id,
            );
            const pending = this.snapshotValue.pending.filter((send) => send.peer.id === peer.id);
            for (const send of pending) this.pendingQueue.cancel(send.id);
            await Promise.all([
              this.store.replaceDialogs(
                dialogs
                  .filter((dialog) => !dialog.transient)
                  .map((dialog) => ({ ...dialog, cacheEpoch: this.epoch })),
              ),
              this.store.replaceMessages(peer.id, []),
              this.store.saveDraft(peer.id, ''),
              this.store.deletePinnedMessages?.(peer.id),
              this.store.deleteGroupMembers?.(peer.id),
              ...pending.map((send) => this.store.deletePending(send.id)),
            ]);
            for (const send of pending) {
              this.pendingQueue.finishCancellation(send.id);
            }
            this.pendingQueue.releaseBlock(peer.id);
            if (!this.isOperationCurrent(generation, accountId)) return false;
            this.invalidateHistory(peer.id, false);
            this.userDetails.delete(peer.id);
            const deletingActive = this.snapshotValue.activePeerId === peer.id;
            this.patch({
              dialogs,
              drafts: Object.fromEntries(
                Object.entries(this.snapshotValue.drafts).filter(([peerId]) => peerId !== peer.id),
              ),
              pending: this.snapshotValue.pending.filter((send) => send.peer.id !== peer.id),
              ...(deletingActive
                ? {
                    activePeerId: undefined,
                    messages: [],
                    sharedMediaCounts: undefined,
                    pinnedMessages: [],
                    hasOlderMessages: false,
                  }
                : {}),
            });
            return true;
          });
        } catch (error) {
          if (this.isOperationCurrent(generation, accountId)) {
            this.fail('sync', 'Could not delete this chat.', error, false);
          }
          return false;
        }
      })(),
    );
  }

  async setPinnedMessage(peer: TelegramPeer, messageId: number, pinned: boolean) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const operationKey = `message-pin:${peer.id}:${messageId}`;
    const operationVersion = this.nextMutationVersion(this.mutationVersions, operationKey);
    this.nextMutationVersion(this.pinnedMessageVersions, peer.id);
    return this.trackVersionedMutation(
      operationKey,
      operationVersion,
      this.queueMutation(operationKey, async () => {
        if (this.mutationVersions.get(operationKey) !== operationVersion) return;
        try {
          const result = await this.transport.setPinnedMessage(peer, messageId, pinned);
          if (!this.isOperationCurrent(generation, accountId)) return;
          await this.acceptMutationUpdateBatches(result.updateBatches, generation, accountId);
          if (
            !this.isOperationCurrent(generation, accountId) ||
            this.snapshotValue.activePeerId !== peer.id
          ) {
            return;
          }
          const source = this.snapshotValue.messages.find(
            (message) => message.id === messageId && message.peerId === peer.id,
          );
          const pinnedMessages = pinned
            ? source
              ? [
                  { ...source, pinned: true },
                  ...this.snapshotValue.pinnedMessages.filter(({ id }) => id !== messageId),
                ]
              : this.snapshotValue.pinnedMessages
            : this.snapshotValue.pinnedMessages.filter(({ id }) => id !== messageId);
          this.patch({ pinnedMessages });
          await this.rememberPinnedMessages(peer.id, pinnedMessages);
        } catch (error) {
          if (this.isOperationCurrent(generation, accountId)) {
            this.fail('sync', `Could not ${pinned ? 'pin' : 'unpin'} the message.`, error, false);
          }
        }
      }),
    );
  }

  async setTyping(peer: TelegramPeer, kind?: TelegramActivityKind) {
    try {
      await this.transport.setTyping(peer, kind);
    } catch {
      // Typing is ephemeral and must never break input or create unhandled rejection spam.
    }
  }

  async loadOlderMessages() {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const peerId = this.snapshotValue.activePeerId;
    if (
      !peerId ||
      this.snapshotValue.loadingOlderMessages ||
      !this.snapshotValue.hasOlderMessages
    ) {
      return;
    }
    const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
    const oldest = this.snapshotValue.messages[0];
    if (!dialog || !oldest) return;
    this.patch({ loadingOlderMessages: true });
    const historyVersion = this.historyVersion(peerId);
    const requestRevision = this.messageRevision;
    try {
      const requestedOffset = this.historyOffsets.get(peerId) ?? oldest.id;
      const matchingGap = (this.historyGaps.get(peerId) ?? []).find(
        ({ newerMinMessageId }) => newerMinMessageId === requestedOffset,
      );
      const loadedIds = new Set(this.snapshotValue.messages.map(({ id }) => id));
      const cachedPage = (
        await this.store.loadMessagesBefore(peerId, requestedOffset, HISTORY_LIMIT)
      ).filter(
        (message) =>
          message.cacheEpoch === this.epoch &&
          !loadedIds.has(message.id) &&
          (!matchingGap || message.id > matchingGap.olderMaxMessageId),
      );
      if (
        !this.isHistoryOperationCurrent(peerId, historyVersion, generation, accountId) ||
        this.snapshotValue.activePeerId !== peerId
      ) {
        return;
      }
      if (cachedPage.length > 0) {
        const cachedMessages = this.sortMessages(cachedPage);
        const nextOffset = cachedMessages[0]!.id;
        this.historyOffsets.set(peerId, nextOffset);
        const messages = this.mergeFetchedMessages(
          peerId,
          this.snapshotValue.messages,
          cachedMessages,
          requestRevision,
        );
        const history = this.rememberHistory(
          peerId,
          { messages, hasOlderMessages: true },
          'oldest',
        );
        this.patch({
          messages: history.messages,
          hasOlderMessages: true,
          historyError: undefined,
          historyRetryAt: undefined,
        });
        return;
      }
      const failure = this.historyFailures.get(peerId);
      if (failure && Date.now() < failure.retryAt) return;
      if (!this.snapshotValue.online) {
        const message = 'Older messages are unavailable while Telegram is offline.';
        this.historyIssues.set(peerId, { message });
        this.patch({ historyError: message });
        return;
      }
      const page = await this.transport.getHistory(dialog.peer, HISTORY_LIMIT, requestedOffset);
      if (
        !this.isHistoryOperationCurrent(peerId, historyVersion, generation, accountId) ||
        this.snapshotValue.activePeerId !== peerId
      ) {
        return;
      }
      const fetched = this.filterFetchedMessages(
        peerId,
        page.messages.map((message) => ({ ...message, cacheEpoch: this.epoch })),
        requestRevision,
      );
      await this.store.putMessages(fetched);
      if (
        !this.isHistoryOperationCurrent(peerId, historyVersion, generation, accountId) ||
        this.snapshotValue.activePeerId !== peerId
      ) {
        return;
      }
      const messages = this.mergeFetchedMessages(
        peerId,
        this.snapshotValue.messages,
        fetched,
        requestRevision,
      );
      const pageOldestId = page.messages.reduce<number | undefined>(
        (minimum, message) => (minimum === undefined ? message.id : Math.min(minimum, message.id)),
        undefined,
      );
      const nextOffset = page.nextBeforeMessageId ?? pageOldestId;
      const advanced = nextOffset !== undefined && nextOffset < requestedOffset;
      if (advanced) this.historyOffsets.set(peerId, nextOffset);
      const nextGaps = matchingGap
        ? this.advanceHistoryGap(peerId, matchingGap, page.messages, page.hasOlder)
        : (this.historyGaps.get(peerId) ?? []);
      this.clearHistoryFailure(peerId);
      const history = this.rememberHistory(
        peerId,
        {
          messages,
          hasOlderMessages: page.hasOlder && advanced,
        },
        this.historyAnchors.has(peerId) ? 'anchor' : 'oldest',
      );
      this.patch({
        messages: history.messages,
        hasOlderMessages: history.hasOlderMessages,
        historyGaps: this.historyGaps.get(peerId) ?? nextGaps,
        historyError: undefined,
        historyRetryAt: undefined,
      });
    } catch (error) {
      if (
        this.isOperationCurrent(generation, accountId) &&
        this.snapshotValue.activePeerId === peerId
      ) {
        const nextFailure = this.recordHistoryFailure(peerId);
        const message = `Could not load older messages from ${dialog.title}. ${this.errorMessage(error)}`;
        this.historyIssues.set(peerId, { message, retryAt: nextFailure.retryAt });
        this.patch({
          historyError: message,
          historyRetryAt: nextFailure.retryAt,
        });
      }
      if (this.isOperationCurrent(generation, accountId)) {
        this.reportFailure('sync', `Could not load older messages from ${dialog.title}.`, error);
      }
    } finally {
      if (
        this.isOperationCurrent(generation, accountId) &&
        this.snapshotValue.activePeerId === peerId
      ) {
        this.patch({ loadingOlderMessages: false });
      }
    }
  }

  async retryHistory() {
    const peerId = this.snapshotValue.activePeerId;
    if (!peerId) return;
    const failedGap = this.historyIssues.get(peerId)?.gap;
    this.clearHistoryFailure(peerId);
    this.patch({ historyError: undefined, historyRetryAt: undefined });
    if (failedGap) {
      await this.loadHistoryGap(failedGap);
      return;
    }
    if (this.snapshotValue.messages.length === 0) {
      this.loadedHistories.delete(peerId);
      await this.selectChat(peerId);
      return;
    }
    this.patch({ hasOlderMessages: true });
    await this.loadOlderMessages();
  }

  async setDraft(peerId: string, text: string) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const revision = (this.draftVersions.get(peerId) ?? 0) + 1;
    this.draftVersions.set(peerId, revision);
    this.patch({ drafts: { ...this.snapshotValue.drafts, [peerId]: text } });
    const previous = this.draftWrites.get(peerId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() =>
        this.isOperationCurrent(generation, accountId)
          ? this.store.saveDraft(peerId, text, revision)
          : undefined,
      );
    this.draftWrites.set(peerId, write);
    try {
      await write;
    } catch (error) {
      if (this.isOperationCurrent(generation, accountId)) {
        this.fail('cache', 'The draft was not saved to this device.', error, false);
      }
      throw error;
    } finally {
      if (this.draftWrites.get(peerId) === write) this.draftWrites.delete(peerId);
    }
  }

  async requestCode(phoneNumber: string) {
    this.mayClaimLegacyAccount = false;
    try {
      const result = await this.transport.requestCode(phoneNumber);
      this.patch({
        phase: 'unauthorized',
        authStep: 'code',
        codeViaApp: result.isCodeViaApp,
        error: undefined,
      });
    } catch (error) {
      this.fail('auth', 'Telegram could not send a login code.', error, false);
    }
  }

  async submitCode(code: string) {
    try {
      const result = await this.transport.submitCode(code);
      if (result === 'password-required') {
        this.patch({ authStep: 'password', error: undefined });
        return;
      }
      if (result === 'sign-up-required') {
        this.patch({ error: 'TeleVecha signs in existing accounts only.' });
        return;
      }
      await this.activateAuthorizedSession(false);
    } catch (error) {
      this.fail('auth', 'Telegram rejected the login code.', error, false);
    }
  }

  async submitPassword(password: string) {
    try {
      await this.transport.submitPassword(password);
      await this.activateAuthorizedSession(false);
    } catch (error) {
      this.fail('auth', 'Telegram rejected the two-step verification password.', error, false);
    }
  }

  async logOut() {
    let remoteError: unknown;
    try {
      await this.transport.logOut();
    } catch (error) {
      remoteError = error;
      this.reportFailure('auth', 'Telegram could not revoke the remote session.', error);
    }
    await this.stop();
    await this.store.clearAccountData();
    this.accountId = undefined;
    this.cachedAccountId = undefined;
    this.mayClaimLegacyAccount = false;
    this.hasReachedReady = false;
    this.epoch = 0;
    this.loadedHistories.clear();
    this.historyOffsets.clear();
    this.historyGaps.clear();
    this.historyIssues.clear();
    this.patch({
      phase: 'idle',
      sync: 'stale',
      online: false,
      dialogs: [],
      messages: [],
      drafts: {},
      pending: [],
      activePeerId: undefined,
      loadingMessages: false,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      sharedMediaCounts: undefined,
      pinnedMessages: [],
      historyGaps: [],
      activities: [],
      authStep: undefined,
      codeViaApp: undefined,
      historyError: undefined,
      historyRetryAt: undefined,
      operationError: undefined,
      error: undefined,
    });
    if (this.credentials) await this.start(this.credentials);
    if (remoteError && this.snapshotValue.phase === 'unauthorized') {
      this.patch({
        error: `Signed out on this device, but Telegram could not revoke the remote session. ${this.errorMessage(remoteError)}`,
      });
    }
  }

  async clearCache() {
    const credentials = this.credentials;
    if (!credentials) throw new Error('Telegram credentials are unavailable.');
    await this.stop();
    await this.store.clearCacheData();
    this.epoch = 0;
    this.loadedHistories.clear();
    this.historyOffsets.clear();
    this.historyVersions.clear();
    this.historyFailures.clear();
    this.historyIssues.clear();
    this.historyGaps.clear();
    this.historyModes.clear();
    this.historyAnchors.clear();
    await this.start(credentials);
  }

  async sendDraft(
    peer: TelegramPeer,
    text: string,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ) {
    if (!text.trim()) return;
    this.validateTextLength(text, MAX_MESSAGE_TEXT_LENGTH, 'message');
    const pending = this.pendingQueue.create({
      id: crypto.randomUUID(),
      accountId: this.accountId ?? this.cachedAccountId,
      peer,
      text,
      randomId: this.randomId(),
      createdAt: Date.now(),
      attempts: 0,
      ...(this.pendingQueue.blockedBy(peer.id) ? { lastError: this.blockedSendMessage() } : {}),
      reply,
      formats,
    });
    const draftVersion = this.draftVersions.get(peer.id) ?? 0;
    const duplicateKey = this.draftSendKey(pending, draftVersion);
    const peerDuplicates = this.duplicateDraftSends.get(peer.id) ?? new Map();
    const duplicate = peerDuplicates.get(duplicateKey);
    if (duplicate) return duplicate;

    const generation = this.lifecycleGeneration;
    const accountId = pending.accountId;
    let delivery: Promise<void> | undefined;
    this.patch({ pending: [...this.snapshotValue.pending, pending] });
    const reservation = this.pendingQueue.queueWrite(peer.id, async () => {
      if (!this.isPendingOperationCurrent(generation, accountId)) return;
      try {
        await this.reserveDraftSend(pending, text, draftVersion);
      } catch (error) {
        if (this.isPendingOperationCurrent(generation, accountId)) {
          this.patch({
            pending: this.snapshotValue.pending.filter(({ id }) => id !== pending.id),
          });
        }
        throw error;
      }
      if (!this.isPendingOperationCurrent(generation, accountId)) return;
      const drafts =
        this.snapshotValue.drafts[peer.id] === text &&
        (this.draftVersions.get(peer.id) ?? 0) === draftVersion
          ? { ...this.snapshotValue.drafts, [peer.id]: '' }
          : this.snapshotValue.drafts;
      this.patch({ drafts });
      if (this.canDeliver(pending)) delivery = this.deliver(pending);
    });

    let sending!: Promise<void>;
    sending = (async () => {
      try {
        await reservation;
        await delivery;
      } finally {
        const duplicates = this.duplicateDraftSends.get(peer.id);
        if (duplicates?.get(duplicateKey) === sending) duplicates.delete(duplicateKey);
        if (duplicates?.size === 0) this.duplicateDraftSends.delete(peer.id);
      }
    })();
    peerDuplicates.set(duplicateKey, sending);
    this.duplicateDraftSends.set(peer.id, peerDuplicates);
    return sending;
  }

  async sendAttachment(
    peer: TelegramPeer,
    file: File,
    caption = '',
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
    sendAs: OutgoingAttachmentMode = 'media',
  ) {
    this.validateTextLength(caption, MAX_CAPTION_TEXT_LENGTH, 'caption');
    this.validateAttachment(file);
    const pending = this.pendingQueue.create({
      id: crypto.randomUUID(),
      accountId: this.accountId ?? this.cachedAccountId,
      peer,
      text: caption,
      randomId: this.randomId(),
      createdAt: Date.now(),
      attempts: 0,
      reply,
      formats,
      attachment: {
        blob: file,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        asSticker:
          sendAs === 'media' &&
          (file.type === 'image/webp' ||
            file.type === 'application/x-tgsticker' ||
            file.name.toLocaleLowerCase().endsWith('.tgs')),
        sendAs,
      },
    });
    await this.enqueuePending(pending);
  }

  async sendAttachments(
    peer: TelegramPeer,
    attachments: Array<{ file: File; sendAs: OutgoingAttachmentMode }>,
    caption = '',
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ) {
    if (attachments.length === 0) return;
    this.validateTextLength(caption, MAX_CAPTION_TEXT_LENGTH, 'caption');
    for (const { file } of attachments) this.validateAttachment(file);
    const pending: PendingSend[] = [];
    const createdAt = Date.now();
    const accountId = this.accountId ?? this.cachedAccountId;
    const draftVersion = this.draftVersions.get(peer.id) ?? 0;
    const appendSingle = ({ file, sendAs }: (typeof attachments)[number]) => {
      const isFirst = pending.length === 0;
      pending.push(
        this.pendingQueue.create({
          id: crypto.randomUUID(),
          accountId,
          peer,
          text: isFirst ? caption : '',
          randomId: this.randomId(),
          createdAt: createdAt + pending.length,
          attempts: 0,
          reply: isFirst ? reply : undefined,
          formats: isFirst ? formats : undefined,
          attachment: {
            blob: file,
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            asSticker:
              sendAs === 'media' &&
              (file.type === 'image/webp' ||
                file.type === 'application/x-tgsticker' ||
                file.name.toLocaleLowerCase().endsWith('.tgs')),
            sendAs,
          },
        }),
      );
    };
    const appendAlbum = (items: Array<(typeof attachments)[number]>) => {
      const isFirst = pending.length === 0;
      const albumAttachments = items.map(({ file }) => ({
        blob: file,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        asSticker: false,
        sendAs: 'media' as const,
        randomId: this.randomId(),
      }));
      pending.push(
        this.pendingQueue.create({
          id: crypto.randomUUID(),
          accountId,
          peer,
          text: isFirst ? caption : '',
          randomId: albumAttachments[0]!.randomId,
          createdAt: createdAt + pending.length,
          attempts: 0,
          reply: isFirst ? reply : undefined,
          formats: isFirst ? formats : undefined,
          album: { attachments: albumAttachments },
        }),
      );
    };

    for (let index = 0; index < attachments.length;) {
      const attachment = attachments[index]!;
      if (attachment.sendAs === 'file') {
        appendSingle(attachment);
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < attachments.length && attachments[end]!.sendAs === 'media') end += 1;
      while (index < end) {
        const count = Math.min(MAX_ALBUM_ATTACHMENTS, end - index);
        const items = attachments.slice(index, index + count);
        if (items.length > 1) appendAlbum(items);
        else appendSingle(items[0]!);
        index += count;
      }
    }
    await this.enqueuePendingBatch(pending, {
      peerId: peer.id,
      text: caption,
      revision: draftVersion,
    });
  }

  async downloadMedia(
    message: TelegramMessage,
    options?: import('../types').TelegramDownloadOptions,
  ) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const assetKey = this.mediaAssetKey(message);
    const cacheKey = options?.preview ? `preview:${assetKey}` : assetKey;
    const mediaSlot = `${options?.preview ? 'preview:' : ''}${message.peerId}:${message.id}`;
    const mediaVersion = this.resources.version(mediaSlot);
    const load = () =>
      this.downloadAndCacheMedia(
        cacheKey,
        message,
        mediaSlot,
        mediaVersion,
        generation,
        accountId,
        options,
      );
    return options?.progress ? load() : this.resources.load(`media:${cacheKey}`, load);
  }

  mediaAssetKey(message: TelegramMessage) {
    const media = message.media;
    const identity =
      media?.cacheKey ??
      [
        message.editedAt ?? 0,
        media?.kind ?? 'preview',
        media?.name ?? message.linkPreview?.url ?? '',
        media?.mimeType ?? '',
        media?.size ?? '',
        media?.width ?? '',
        media?.height ?? '',
        media?.duration ?? '',
      ].join(':');
    return `media:${message.peerId}:${message.id}:${identity}`;
  }

  private async downloadAndCacheMedia(
    cacheKey: string,
    message: TelegramMessage,
    mediaSlot: string,
    mediaVersion: number,
    generation: number,
    accountId: string | undefined,
    options?: import('../types').TelegramDownloadOptions,
  ) {
    let cached: Blob | undefined;
    try {
      cached = await this.store.loadBlob(cacheKey);
    } catch (error) {
      this.reportFailure('cache', 'Could not read cached media; downloading it again.', error);
    }
    if (!this.isOperationCurrent(generation, accountId)) {
      throw new Error('The media request no longer belongs to the active account.');
    }
    if (cached) return cached;
    try {
      const blob = await this.transport.downloadMedia(message, options);
      if (
        this.isOperationCurrent(generation, accountId) &&
        this.resources.version(mediaSlot) === mediaVersion
      ) {
        try {
          await this.store.saveBlob(cacheKey, blob);
        } catch (error) {
          this.reportFailure('cache', 'Could not cache downloaded media.', error);
        }
      }
      return blob;
    } catch (firstError) {
      if (options?.progress?.isCanceled) throw firstError;
      if (!this.isOperationCurrent(generation, accountId)) throw firstError;
      const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === message.peerId);
      if (!dialog) throw firstError;
      const requestRevision = this.messageRevision;
      const context = this.transport.getHistoryAround
        ? await this.transport.getHistoryAround(dialog.peer, message.id, HISTORY_LIMIT)
        : (await this.transport.getHistory(dialog.peer, HISTORY_LIMIT)).messages;
      if (!this.isOperationCurrent(generation, accountId)) throw firstError;
      const fetched = this.filterFetchedMessages(
        message.peerId,
        context.map((item) => ({ ...item, cacheEpoch: this.epoch })),
        requestRevision,
      );
      await this.store.putMessages(fetched);
      if (!this.isOperationCurrent(generation, accountId)) throw firstError;
      const loaded = this.loadedHistories.get(message.peerId);
      if (loaded) {
        loaded.messages = this.boundHistoryMessages(
          message.peerId,
          this.mergeFetchedMessages(message.peerId, loaded.messages, fetched, requestRevision),
          this.historyModes.get(message.peerId) ?? 'newest',
        );
      }
      if (this.snapshotValue.activePeerId === message.peerId) {
        const previousMessages = this.snapshotValue.messages;
        const messages = this.mergeFetchedMessages(
          message.peerId,
          previousMessages,
          fetched,
          requestRevision,
        );
        this.recordLoadedHistoryRange(message.peerId, previousMessages, fetched);
        this.patch({
          messages: this.boundHistoryMessages(
            message.peerId,
            messages,
            this.historyModes.get(message.peerId) ?? 'newest',
          ),
          historyGaps: this.historyGaps.get(message.peerId) ?? [],
        });
      }
      const refreshed = context.find(({ id }) => id === message.id);
      if (!refreshed) throw firstError;
      const blob = await this.transport.downloadMedia(refreshed, options);
      if (
        this.isOperationCurrent(generation, accountId) &&
        this.resources.version(mediaSlot) === mediaVersion
      ) {
        try {
          await this.store.saveBlob(cacheKey, blob);
        } catch (error) {
          this.reportFailure('cache', 'Could not cache downloaded media.', error);
        }
      }
      return blob;
    }
  }

  async downloadAvatar(peer: TelegramPeer, avatarId?: string) {
    const cacheKey = `avatar:${peer.id}:${avatarId ?? 'unknown'}`;
    return this.resources.load(cacheKey, () => this.downloadAndCacheAvatar(cacheKey, peer));
  }

  async loadCachedAvatar(peer: TelegramPeer, avatarId?: string) {
    return this.store.loadBlob(`avatar:${peer.id}:${avatarId ?? 'unknown'}`);
  }

  async getAppearanceCatalog() {
    const [themes, wallpapers] = await Promise.all([
      this.transport.getThemes?.() ?? Promise.resolve([]),
      this.transport.getWallpapers?.() ?? Promise.resolve([]),
    ]);
    return { themes, wallpapers };
  }

  async getWallpapers() {
    return this.transport.getWallpapers?.() ?? [];
  }

  async getChatAppearance(peer: TelegramPeer) {
    if (!this.transport.getChatAppearance) return undefined;
    const cacheKey = `chat-appearance:${peer.id}`;
    return this.resources.cached<TelegramChatAppearance | undefined>(cacheKey, async () => {
      const cached = await this.store.loadBlob(cacheKey);
      if (cached) {
        try {
          const entry = JSON.parse(await cached.text()) as {
            savedAt: number;
            value: TelegramChatAppearance | null;
          };
          if (Date.now() - entry.savedAt < 60 * 60 * 1000) {
            const value = entry.value ?? undefined;
            return value;
          }
        } catch {
          await this.store.deleteBlob(cacheKey).catch(() => undefined);
        }
      }
      const value = await this.transport.getChatAppearance!(peer);
      await this.store.saveBlob(
        cacheKey,
        new Blob([JSON.stringify({ savedAt: Date.now(), value: value ?? null })], {
          type: 'application/json',
        }),
      );
      return value;
    });
  }

  async downloadWallpaper(wallpaperId: string) {
    if (!this.transport.downloadWallpaper) {
      throw new Error('This Telegram transport cannot download backgrounds.');
    }
    const cacheKey = `wallpaper:${wallpaperId}`;
    return this.resources.load(cacheKey, async () => {
      const cached = await this.store.loadBlob(cacheKey);
      if (cached) return cached;
      const blob = await this.transport.downloadWallpaper!(wallpaperId);
      await this.store.saveBlob(cacheKey, blob);
      return blob;
    });
  }

  async getRecentStickers() {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const metadataGeneration = this.metadataGeneration;
    return this.cachedStickerList(
      'sticker-index:recent:v2',
      () => this.transport.getRecentStickers(),
      generation,
      accountId,
      metadataGeneration,
    );
  }

  async getStickerPacks() {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const metadataGeneration = this.metadataGeneration;
    const cacheKey = 'sticker-index:packs:v2';
    const cached = await this.store.loadBlob(cacheKey);
    if (
      !this.isOperationCurrent(generation, accountId) ||
      metadataGeneration !== this.metadataGeneration
    )
      return [];
    if (cached) {
      try {
        const packs = (
          JSON.parse(await cached.text()) as Array<
            Omit<TelegramStickerPack, 'stickers'> & {
              stickers: Array<Omit<TelegramSticker, 'fileReference'> & { fileReference: number[] }>;
            }
          >
        ).map((pack) => ({
          ...pack,
          stickers: pack.stickers.map((sticker) => ({
            ...sticker,
            fileReference: new Uint8Array(sticker.fileReference),
          })),
        }));
        return this.isOperationCurrent(generation, accountId) &&
          metadataGeneration === this.metadataGeneration
          ? packs
          : [];
      } catch {
        // A malformed index is replaced from Telegram below.
      }
    }
    const packs = await this.transport.getStickerPacks();
    if (
      !this.isOperationCurrent(generation, accountId) ||
      metadataGeneration !== this.metadataGeneration
    )
      return [];
    await this.queueMetadataWrite(async () => {
      if (
        !this.isOperationCurrent(generation, accountId) ||
        metadataGeneration !== this.metadataGeneration
      ) {
        return;
      }
      await this.store.saveBlob(
        cacheKey,
        new Blob([
          JSON.stringify(
            packs.map((pack) => ({
              ...pack,
              stickers: pack.stickers.map((sticker) => ({
                ...sticker,
                fileReference: [...sticker.fileReference],
              })),
            })),
          ),
        ]),
      );
    });
    return this.isOperationCurrent(generation, accountId) &&
      metadataGeneration === this.metadataGeneration
      ? packs
      : [];
  }

  async getSavedGifs() {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const metadataGeneration = this.metadataGeneration;
    return this.cachedStickerList(
      'sticker-index:gifs:v2',
      () => this.transport.getSavedGifs(),
      generation,
      accountId,
      metadataGeneration,
    );
  }

  async searchGifs(query: string) {
    const dialog = this.snapshotValue.dialogs.find(
      ({ peer }) => peer.id === this.snapshotValue.activePeerId,
    );
    return dialog && this.transport.searchGifs ? this.transport.searchGifs(dialog.peer, query) : [];
  }

  private async cachedStickerList(
    cacheKey: string,
    fetch: () => Promise<TelegramSticker[]>,
    generation: number,
    accountId: string | undefined,
    metadataGeneration: number,
  ) {
    const cached = await this.store.loadBlob(cacheKey);
    if (
      !this.isOperationCurrent(generation, accountId) ||
      metadataGeneration !== this.metadataGeneration
    )
      return [];
    if (cached) {
      try {
        const stickers = (
          JSON.parse(await cached.text()) as Array<
            Omit<TelegramSticker, 'fileReference'> & { fileReference: number[] }
          >
        ).map((sticker) => ({
          ...sticker,
          fileReference: new Uint8Array(sticker.fileReference),
        }));
        return this.isOperationCurrent(generation, accountId) &&
          metadataGeneration === this.metadataGeneration
          ? stickers
          : [];
      } catch {
        // A malformed index is replaced from Telegram below.
      }
    }
    const stickers = await fetch();
    if (
      !this.isOperationCurrent(generation, accountId) ||
      metadataGeneration !== this.metadataGeneration
    )
      return [];
    await this.queueMetadataWrite(async () => {
      if (
        !this.isOperationCurrent(generation, accountId) ||
        metadataGeneration !== this.metadataGeneration
      ) {
        return;
      }
      await this.store.saveBlob(
        cacheKey,
        new Blob([
          JSON.stringify(
            stickers.map((sticker) => ({
              ...sticker,
              fileReference: [...sticker.fileReference],
            })),
          ),
        ]),
      );
    });
    return this.isOperationCurrent(generation, accountId) &&
      metadataGeneration === this.metadataGeneration
      ? stickers
      : [];
  }

  async downloadSticker(sticker: TelegramSticker) {
    const cacheKey = `sticker:${sticker.id}`;
    return this.resources.load(cacheKey, async () => {
      const cached = await this.store.loadBlob(cacheKey);
      if (cached) return cached;
      const blob = await this.transport.downloadSticker(sticker);
      await this.store.saveBlob(cacheKey, blob);
      return blob;
    });
  }

  async downloadCustomEmoji(documentId: string) {
    const cacheKey = `custom-emoji:${documentId}`;
    return this.resources.load(cacheKey, async () => {
      const cached = await this.store.loadBlob(cacheKey);
      if (cached) return cached;
      if (!this.transport.downloadCustomEmoji) {
        throw new Error('This Telegram transport cannot download custom emoji.');
      }
      const blob = await this.transport.downloadCustomEmoji(documentId);
      await this.store.saveBlob(cacheKey, blob);
      return blob;
    });
  }

  async getBotCommands(peer: TelegramPeer): Promise<TelegramBotCommand[]> {
    if (!this.transport.getBotCommands) return [];
    const cacheKey = `bot-commands:${peer.id}`;
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const metadataGeneration = this.metadataGeneration;
    return this.resources.cached(cacheKey, () =>
      this.trackLifecycleTask(
        this.transport.getBotCommands!({ ...peer })
          .then((commands) => {
            const current =
              this.isOperationCurrent(generation, accountId) &&
              metadataGeneration === this.metadataGeneration
                ? commands
                : [];
            return current;
          })
          .catch((error: unknown) => {
            if (
              this.isOperationCurrent(generation, accountId) &&
              metadataGeneration === this.metadataGeneration
            ) {
              this.fail('sync', "Could not load this bot's commands.", error, false);
            }
            throw error;
          }),
      ),
    );
  }

  async startBot(peer: TelegramPeer, startParam = '') {
    if (!this.transport.startBot) {
      await this.sendDraft(peer, startParam ? `/start ${startParam}` : '/start');
      return;
    }
    const pending = this.pendingQueue.create({
      id: crypto.randomUUID(),
      accountId: this.accountId ?? this.cachedAccountId,
      peer,
      text: startParam ? `/start ${startParam}` : '/start',
      randomId: this.randomId(),
      createdAt: Date.now(),
      attempts: 0,
      botStart: { startParam },
    });
    await this.enqueuePending(pending);
  }

  async answerBotCallback(
    peer: TelegramPeer,
    messageId: number,
    data: number[],
  ): Promise<TelegramBotCallbackResult | undefined> {
    if (!this.transport.answerBotCallback) return undefined;
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    return this.trackLifecycleTask(
      (async () => {
        try {
          const result = await this.transport.answerBotCallback!({ ...peer }, messageId, [...data]);
          return this.isOperationCurrent(generation, accountId) ? result : undefined;
        } catch (error) {
          if (this.isOperationCurrent(generation, accountId)) {
            this.fail('sync', 'The bot button did not respond.', error, false);
          }
          throw error;
        }
      })(),
    );
  }

  async requestUrlAuth(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
  ): Promise<TelegramUrlAuthResult | undefined> {
    if (!this.transport.requestUrlAuth) return undefined;
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    return this.trackLifecycleTask(
      (async () => {
        try {
          const result = await this.transport.requestUrlAuth!({ ...peer }, messageId, buttonId);
          return this.isOperationCurrent(generation, accountId) ? result : undefined;
        } catch (error) {
          if (this.isOperationCurrent(generation, accountId)) {
            this.fail('sync', 'Could not verify this bot link.', error, false);
          }
          throw error;
        }
      })(),
    );
  }

  async acceptUrlAuth(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
    options?: TelegramUrlAuthAcceptOptions,
  ): Promise<TelegramUrlAuthResult | undefined> {
    if (!this.transport.acceptUrlAuth) return undefined;
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    return this.trackLifecycleTask(
      (async () => {
        try {
          const result = await this.transport.acceptUrlAuth!(
            { ...peer },
            messageId,
            buttonId,
            options ? { ...options } : undefined,
          );
          return this.isOperationCurrent(generation, accountId) ? result : undefined;
        } catch (error) {
          if (this.isOperationCurrent(generation, accountId)) {
            this.fail('sync', 'Could not authorize this bot link.', error, false);
          }
          throw error;
        }
      })(),
    );
  }

  async sendSticker(peer: TelegramPeer, sticker: TelegramSticker, reply?: TelegramReplyTarget) {
    const pending = this.pendingQueue.create({
      id: crypto.randomUUID(),
      accountId: this.accountId ?? this.cachedAccountId,
      peer,
      text: '',
      randomId: this.randomId(),
      createdAt: Date.now(),
      attempts: 0,
      sticker,
      reply,
    });
    await this.enqueuePending(pending);
  }

  async toggleReaction(peer: TelegramPeer, messageId: number, emoji: string) {
    const key = `${peer.id}:${messageId}`;
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const previous = this.reactionQueues.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.toggleReactionNow(peer, messageId, emoji, key, generation, accountId));
    this.reactionQueues.set(key, operation);
    const tracked = this.trackLifecycleTask(operation);
    try {
      await tracked;
    } finally {
      if (this.reactionQueues.get(key) === operation) this.reactionQueues.delete(key);
    }
  }

  private async toggleReactionNow(
    peer: TelegramPeer,
    messageId: number,
    emoji: string,
    key: string,
    generation: number,
    accountId: string | undefined,
  ) {
    if (!this.isOperationCurrent(generation, accountId)) return;
    const message = this.snapshotValue.messages.find(
      ({ id, peerId }) => id === messageId && peerId === peer.id,
    );
    if (!message) return;
    const previous = message.reactions ?? [];
    const target = previous.some((reaction) => reaction.emoji === emoji && reaction.chosen)
      ? undefined
      : emoji;
    const optimistic = this.reactionsAfterChoice(previous, target);
    const version = this.nextReactionVersion(key);
    await this.applyReactionChange(peer.id, messageId, optimistic, version, {
      generation,
      accountId,
    });
    if (!this.isOperationCurrent(generation, accountId)) return;
    try {
      const result = await this.transport.setReaction(peer, messageId, target);
      if (!this.isOperationCurrent(generation, accountId)) return;
      await this.acceptMutationUpdateBatches(result.updateBatches, generation, accountId);
    } catch (error) {
      if (!this.isOperationCurrent(generation, accountId)) return;
      if (this.reactionVersions.get(key) === version) {
        await this.applyReactionChange(
          peer.id,
          messageId,
          previous,
          this.nextReactionVersion(key),
          { generation, accountId },
        );
      }
      if (this.isOperationCurrent(generation, accountId)) {
        this.fail('sync', 'Could not update the reaction.', error, false);
      }
    }
  }

  async deleteMessage(peer: TelegramPeer, messageId: number, revoke: boolean) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const operationKey = `delete-message:${peer.id}:${messageId}`;
    const operationVersion = this.nextMutationVersion(this.mutationVersions, operationKey);
    return this.trackVersionedMutation(
      operationKey,
      operationVersion,
      (async () => {
        try {
          const result = await this.transport.deleteMessages(peer, [messageId], revoke);
          if (
            !this.isOperationCurrent(generation, accountId) ||
            this.mutationVersions.get(operationKey) !== operationVersion
          ) {
            return false;
          }
          await this.acceptMutationUpdateBatches(result.updateBatches, generation, accountId);
          if (
            !this.isOperationCurrent(generation, accountId) ||
            this.mutationVersions.get(operationKey) !== operationVersion
          ) {
            return false;
          }
          const hasSemanticUpdate = this.hasMutationUpdate(
            result.updateBatches,
            (update) =>
              update.type === 'delete-messages' &&
              (!update.peerId || update.peerId === peer.id) &&
              update.messageIds.includes(messageId),
          );
          if (!hasSemanticUpdate) {
            await this.enqueueSyntheticUpdates(
              [
                {
                  type: 'delete-messages',
                  pts: 0,
                  ptsCount: 0,
                  peerId: peer.id,
                  messageIds: [messageId],
                },
              ],
              generation,
              true,
              { accountId },
            );
          }
          return true;
        } catch (error) {
          if (this.isOperationCurrent(generation, accountId)) {
            this.fail('sync', 'Could not delete the message.', error, false);
          }
          return false;
        }
      })(),
    );
  }

  async editMessage(
    peer: TelegramPeer,
    messageId: number,
    text: string,
    formats?: TelegramTextFormat[],
    replacement?: EditMediaOptions,
  ) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    const operationKey = `edit-message:${peer.id}:${messageId}`;
    const operationVersion = this.nextMutationVersion(this.mutationVersions, operationKey);
    return this.trackVersionedMutation(
      operationKey,
      operationVersion,
      (async () => {
        try {
          const result = await this.transport.editMessage(
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
          );
          if (
            !this.isOperationCurrent(generation, accountId) ||
            this.mutationVersions.get(operationKey) !== operationVersion
          ) {
            return result.message;
          }
          await this.acceptMutationUpdateBatches(result.updateBatches, generation, accountId);
          if (
            !this.isOperationCurrent(generation, accountId) ||
            this.mutationVersions.get(operationKey) !== operationVersion
          ) {
            return result.message;
          }
          const hasSemanticUpdate = this.hasMutationUpdate(
            result.updateBatches,
            (update) =>
              update.type === 'edit-message' &&
              update.message.peerId === peer.id &&
              update.message.id === messageId,
          );
          if (!hasSemanticUpdate) {
            await this.enqueueSyntheticUpdates(
              [{ type: 'edit-message', pts: 0, ptsCount: 0, message: result.message }],
              generation,
              true,
              { accountId },
            );
          }
          return result.message;
        } catch (error) {
          if (this.isOperationCurrent(generation, accountId)) {
            this.fail('sync', 'Could not edit the message.', error, false);
          }
          throw error;
        }
      })(),
    );
  }

  async forwardMessage(fromPeer: TelegramPeer, toPeer: TelegramPeer, messageId: number) {
    const pending = this.pendingQueue.create({
      id: crypto.randomUUID(),
      accountId: this.accountId ?? this.cachedAccountId,
      peer: toPeer,
      text:
        this.snapshotValue.messages.find(
          (message) => message.peerId === fromPeer.id && message.id === messageId,
        )?.text ?? '',
      randomId: this.randomId(),
      createdAt: Date.now(),
      attempts: 0,
      forward: { fromPeer, messageId },
    });
    await this.enqueuePending(pending);
  }

  private async downloadAndCacheAvatar(cacheKey: string, peer: TelegramPeer) {
    const cached = await this.store.loadBlob(cacheKey);
    if (cached) return cached;
    const blob = await this.transport.downloadAvatar(peer);
    if (blob) await this.store.saveBlob(cacheKey, blob);
    return blob;
  }

  private async reconcileStartup(showProgress = true, generation = this.lifecycleGeneration) {
    if (!this.isLifecycleCurrent(generation)) return;
    if (showProgress) this.patch({ phase: 'syncing', sync: 'recovering' });
    else this.patch({ sync: 'recovering' });
    const cursor = await this.store.loadCursor();
    if (!this.isLifecycleCurrent(generation)) return;

    if (!cursor) {
      const current = await this.transport.getCurrentState();
      if (!this.isLifecycleCurrent(generation)) return;
      await this.store.saveCursor(current);
      if (!this.isLifecycleCurrent(generation)) return;
      await this.refreshDialogHeads(generation);
      if (!this.isLifecycleCurrent(generation)) return;
      this.hasReachedReady = true;
      this.patch({ phase: 'ready', sync: 'current', online: true });
      return;
    }

    const difference = await this.transport.getDifference(cursor, GLOBAL_DIFFERENCE_LIMIT);
    if (!this.isLifecycleCurrent(generation)) return;
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
      await this.replaceWithLatestState(nextCursor, generation);
    } else {
      await this.batchSnapshotNotifications(async () => {
        for (const update of difference.updates) {
          if (!this.isLifecycleCurrent(generation)) return;
          if (update.type === 'channel-too-long') await this.recoverChannel(update.peerId, true);
          else await this.applyUpdate(update, !showProgress);
        }
        if (!this.isLifecycleCurrent(generation)) return;
        await this.store.saveCursor(difference.cursor);
        if (!this.isLifecycleCurrent(generation)) return;
        if (showProgress) {
          await this.refreshDialogHeads(generation);
          if (!this.isLifecycleCurrent(generation)) return;
          await this.refreshActiveConversationFromCache(generation);
        }
        if (!this.isLifecycleCurrent(generation)) return;
        this.hasReachedReady = true;
        this.patch({ phase: 'ready', sync: 'current', online: true });
      });
      return;
    }
    if (!this.isLifecycleCurrent(generation)) return;
    this.hasReachedReady = true;
    this.patch({ phase: 'ready', sync: 'current', online: true });
  }

  private async activateAuthorizedSession(
    claimLegacyAccount = false,
    generation = this.lifecycleGeneration,
  ) {
    this.reconnect.reset();
    if (!(await this.confirmAuthorizedAccount(claimLegacyAccount, generation))) return;
    const accountId = this.accountId;
    if (!this.isOperationCurrent(generation, accountId)) return;
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = this.transport.subscribe((batch) => {
      if (!this.isOperationCurrent(generation, accountId)) return;
      void this.enqueueUpdateBatch(batch, generation, { accountId }).catch(() => undefined);
    });
    this.patch({ authStep: undefined, codeViaApp: undefined, error: undefined, online: true });
    const startupSync = this.updateQueue.then(() =>
      this.isOperationCurrent(generation, accountId)
        ? this.reconcileStartup(true, generation)
        : Promise.resolve(),
    );
    this.updateQueue = startupSync.catch((error: unknown) => {
      if (this.isOperationCurrent(generation, accountId)) {
        this.fail('sync', 'Could not synchronize with Telegram.', error);
      }
    });
    await startupSync;
    if (!this.isOperationCurrent(generation, accountId)) return;
    await this.refreshActiveConversationAfterConnect(generation, accountId);
    if (!this.isOperationCurrent(generation, accountId)) return;
    await this.flushOutbox();
  }

  private async refreshActiveConversationAfterConnect(
    generation: number,
    accountId: string | undefined,
  ) {
    const peerId = this.snapshotValue.activePeerId;
    if (!peerId || !this.snapshotValue.online) return;
    const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
    if (!dialog) return;
    void this.loadSharedMediaCounts(dialog);
    void this.loadPinnedMessages(dialog);
    try {
      if (this.snapshotValue.messages.length === 0) {
        await this.reloadActiveConversation(generation);
        return;
      }
      const requestRevision = this.messageRevision;
      const page = await this.transport.getHistory(dialog.peer, HISTORY_LIMIT);
      if (
        !this.isOperationCurrent(generation, accountId) ||
        this.snapshotValue.activePeerId !== peerId
      ) {
        return;
      }
      const fetched = this.filterFetchedMessages(
        peerId,
        page.messages.map((message) => ({ ...message, cacheEpoch: this.epoch })),
        requestRevision,
      );
      await this.store.putMessages(fetched);
      if (
        !this.isOperationCurrent(generation, accountId) ||
        this.snapshotValue.activePeerId !== peerId
      ) {
        return;
      }
      const messages = this.mergeFetchedMessages(
        peerId,
        this.snapshotValue.messages,
        fetched,
        requestRevision,
      );
      const history = this.rememberHistory(peerId, {
        messages,
        hasOlderMessages: this.snapshotValue.hasOlderMessages || page.hasOlder,
      });
      this.historyIssues.delete(peerId);
      this.patch({
        messages: history.messages,
        hasOlderMessages: history.hasOlderMessages,
        loadingMessages: false,
        historyError: undefined,
        historyRetryAt: undefined,
      });
    } catch (error) {
      if (!this.isOperationCurrent(generation, accountId)) return;
      const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
      const message = `Could not load ${dialog?.title ?? 'this chat'}. ${this.errorMessage(error)}`;
      this.historyIssues.set(peerId, { message });
      this.patch({
        loadingMessages: false,
        historyError: message,
        historyRetryAt: undefined,
      });
      this.reportFailure('sync', `Could not refresh ${dialog?.title ?? 'the active chat'}.`, error);
    }
  }

  private cachedChannelNeedsRepair(dialog: TelegramDialog, messages: readonly TelegramMessage[]) {
    if (dialog.peer.kind !== 'channel' || messages.length === 0) return false;
    if (
      dialog.topMessageId !== undefined &&
      !messages.some(({ id }) => id === dialog.topMessageId)
    ) {
      return true;
    }
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

  private async confirmAuthorizedAccount(claimLegacyAccount: boolean, generation: number) {
    const accountId = await this.transport.getAuthorizedAccountId();
    if (!this.isLifecycleCurrent(generation)) return false;
    const storedAccountId = await this.store.loadAccountId();
    if (!this.isLifecycleCurrent(generation)) return false;
    this.accountId = accountId;
    if (storedAccountId === undefined && claimLegacyAccount) {
      await this.store.claimAccount(accountId);
      if (!this.isLifecycleCurrent(generation)) return false;
    } else if (storedAccountId !== accountId) {
      // Let account-A cache writes that already entered storage finish before
      // account B clears the namespace. Queued continuations observe the new
      // account ID and self-cancel instead of repopulating the reset cache.
      await Promise.allSettled([
        this.dialogStateTail,
        this.metadataWriteTail,
        ...this.draftWrites.values(),
        ...this.reactionQueues.values(),
      ]);
      if (!this.isLifecycleCurrent(generation)) return false;
      await this.store.resetForAccount(accountId);
      if (!this.isLifecycleCurrent(generation)) return false;
      this.mayClaimLegacyAccount = false;
      this.cachedAccountId = accountId;
      this.epoch = 0;
      this.selectionVersion += 1;
      this.loadedHistories.clear();
      this.historyOffsets.clear();
      this.historyVersions.clear();
      this.historyFailures.clear();
      this.historyIssues.clear();
      this.historyGaps.clear();
      this.historyModes.clear();
      this.historyAnchors.clear();
      this.pendingInboxReadMax.clear();
      for (const timer of this.inboxReadRetryTimers.values()) clearTimeout(timer);
      this.inboxReadRetryTimers.clear();
      this.messageMutations.clear();
      this.draftWrites.clear();
      this.draftVersions.clear();
      this.userDetails.clear();
      this.resources.clear();
      this.metadataGeneration += 1;
      this.sharedMediaCountRequest = undefined;
      this.sharedMediaCountRetry.reset();
      this.reactionQueues.clear();
      this.reactionVersions.clear();
      this.mutationVersions.clear();
      this.mutationSequence = 0;
      this.mutationTails.clear();
      this.pinnedMessageVersions.clear();
      this.pinnedMessageCache.clear();
      this.pinnedMessageCacheLoaded.clear();
      this.pinnedMessageRequests.clear();
      this.groupMemberVersions.clear();
      this.groupMemberCache.clear();
      this.groupMemberCacheLoaded.clear();
      this.groupMemberRequests.clear();
      this.sharedMediaCountVersions.clear();
      this.unreadVersions.clear();
      this.duplicateDraftSends.clear();
      this.pendingQueue.clear();
      this.patch({
        dialogs: [],
        messages: [],
        drafts: {},
        pending: [],
        activePeerId: undefined,
        loadingMessages: false,
        hasOlderMessages: false,
        loadingOlderMessages: false,
        historyGaps: [],
        historyError: undefined,
        historyRetryAt: undefined,
        sharedMediaCounts: undefined,
        pinnedMessages: [],
      });
      return true;
    }

    this.mayClaimLegacyAccount = false;
    this.cachedAccountId = accountId;
    const compatible: PendingSend[] = [];
    for (const pending of this.snapshotValue.pending) {
      if (pending.accountId && pending.accountId !== accountId) continue;
      const owned = this.pendingQueue.capture(
        pending.accountId ? pending : { ...pending, accountId },
      );
      if (!pending.accountId) await this.store.commitOutbox(owned);
      if (!this.isLifecycleCurrent(generation)) return false;
      compatible.push(owned);
    }
    if (!this.isLifecycleCurrent(generation)) return false;
    this.patch({ pending: compatible });
    return true;
  }

  private async refreshDialogHeads(generation = this.lifecycleGeneration) {
    const page = await this.transport.getDialogs(DIALOG_PAGE_LIMIT);
    if (!this.isLifecycleCurrent(generation)) return;
    const cachedDetails = new Map(
      this.snapshotValue.dialogs.map((dialog) => [dialog.peer.id, dialog.userDetails]),
    );
    const dialogs: CachedDialog[] = page.dialogs.map((dialog) => ({
      ...dialog,
      ...(cachedDetails.get(dialog.peer.id)
        ? { userDetails: cachedDetails.get(dialog.peer.id) }
        : {}),
      cacheEpoch: this.epoch,
    }));
    const serverPeerIds = new Set(dialogs.map(({ peer }) => peer.id));
    const transientDialogs = this.snapshotValue.dialogs.filter((dialog): dialog is CachedDialog =>
      Boolean(dialog.transient && !serverPeerIds.has(dialog.peer.id)),
    );
    const visibleDialogs = [...dialogs, ...transientDialogs];
    await this.store.replaceDialogs(dialogs);
    if (!this.isLifecycleCurrent(generation)) return;
    const activeStillExists =
      !this.snapshotValue.activePeerId ||
      visibleDialogs.some(({ peer }) => peer.id === this.snapshotValue.activePeerId);
    this.patch({
      dialogs: this.sortDialogs(visibleDialogs),
      ...(!activeStillExists
        ? {
            activePeerId: undefined,
            messages: [],
            hasOlderMessages: false,
            loadingMessages: false,
            sharedMediaCounts: undefined,
            pinnedMessages: [],
          }
        : {}),
    });
  }

  private async refreshDialogHead(
    peerId: string,
    removeIfMissing = false,
    ignoredTopMessageIds?: ReadonlySet<number>,
  ) {
    const storedPeer = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId)?.peer;
    const fresh =
      storedPeer && this.transport.getDialog
        ? await this.transport.getDialog(storedPeer)
        : (await this.transport.getDialogs(DIALOG_PAGE_LIMIT)).dialogs.find(
            ({ peer }) => peer.id === peerId,
          );
    if (!fresh) {
      if (removeIfMissing) {
        const dialogs = this.snapshotValue.dialogs.filter(({ peer }) => peer.id !== peerId);
        await this.store.replaceDialogs(
          dialogs.map((dialog) => ({ ...dialog, cacheEpoch: this.epoch })),
        );
        this.patch({ dialogs });
      }
      return false;
    }
    if (ignoredTopMessageIds?.has(fresh.topMessageId)) return false;
    const previous = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
    const dialog: CachedDialog = {
      ...fresh,
      ...(previous?.channelPts !== undefined ? { channelPts: previous.channelPts } : {}),
      ...(previous?.userDetails ? { userDetails: previous.userDetails } : {}),
      cacheEpoch: this.epoch,
    };
    await this.store.putDialog(dialog);
    this.patch({
      dialogs: this.sortDialogs([
        ...this.snapshotValue.dialogs.filter(({ peer }) => peer.id !== peerId),
        dialog,
      ]),
    });
    return true;
  }

  private async replaceWithLatestState(
    cursor: import('../types').SyncCursor,
    generation = this.lifecycleGeneration,
  ) {
    const accountId = this.accountId;
    const reloadPeerId = await this.queueDialogStateOperation(async () => {
      if (!this.isOperationCurrent(generation, accountId)) return undefined;
      const page = await this.transport.getDialogs(DIALOG_PAGE_LIMIT);
      if (!this.isOperationCurrent(generation, accountId)) return undefined;

      const stagedActivePeerId = this.snapshotValue.activePeerId;
      const stagedSelectionVersion = this.selectionVersion;
      const stagedActiveDialog = page.dialogs.find(({ peer }) => peer.id === stagedActivePeerId);
      let activePage: Awaited<ReturnType<TelegramTransport['getHistory']>> | undefined;
      let sharedMediaCounts: EngineSnapshot['sharedMediaCounts'];
      let pinnedMessages: TelegramMessage[] = [];
      if (stagedActivePeerId && stagedActiveDialog) {
        activePage = await this.transport.getHistory(stagedActiveDialog.peer, HISTORY_LIMIT);
        if (!this.isOperationCurrent(generation, accountId)) return undefined;
        if (
          this.snapshotValue.activePeerId === stagedActivePeerId &&
          this.selectionVersion === stagedSelectionVersion
        ) {
          const [counts, pins] = await Promise.allSettled([
            this.getSharedMediaCountsWithDeadline(stagedActiveDialog.peer),
            this.transport.getPinnedMessages(stagedActiveDialog.peer),
          ]);
          if (!this.isOperationCurrent(generation, accountId)) return undefined;
          if (counts.status === 'fulfilled') sharedMediaCounts = counts.value;
          if (pins.status === 'fulfilled') pinnedMessages = pins.value;
        }
      }

      const peersBeforeCommit = new Set([
        ...this.snapshotValue.dialogs.map(({ peer }) => peer.id),
        ...page.dialogs.map(({ peer }) => peer.id),
        ...this.loadedHistories.keys(),
      ]);
      for (const peerId of peersBeforeCommit) {
        this.historyVersions.set(peerId, this.historyVersion(peerId) + 1);
        this.pinnedMessageVersions.set(peerId, (this.pinnedMessageVersions.get(peerId) ?? 0) + 1);
        this.sharedMediaCountVersions.set(
          peerId,
          (this.sharedMediaCountVersions.get(peerId) ?? 0) + 1,
        );
      }
      this.metadataGeneration += 1;
      this.sharedMediaCountRequest = undefined;
      this.sharedMediaCountRetry.reset();
      this.userDetails.clear();
      this.resources.clear();

      const epoch = await this.queueMetadataWrite(async () => {
        if (!this.isOperationCurrent(generation, accountId)) return undefined;
        return this.store.commitLatestState({
          cursor,
          dialogs: page.dialogs,
          ...(stagedActivePeerId && activePage
            ? {
                activeHistory: {
                  peerId: stagedActivePeerId,
                  messages: activePage.messages,
                },
              }
            : {}),
          discardBlobKeys: EXPRESSION_INDEX_CACHE_KEYS,
        });
      });
      if (epoch === undefined || !this.isOperationCurrent(generation, accountId)) return undefined;

      const transientDialogs = this.snapshotValue.dialogs.filter(
        (dialog) =>
          dialog.transient && !page.dialogs.some(({ peer }) => peer.id === dialog.peer.id),
      );
      const freshDialogs = [...page.dialogs, ...transientDialogs];
      const currentActivePeerId = this.snapshotValue.activePeerId;
      const retainedActivePeerId = freshDialogs.some(({ peer }) => peer.id === currentActivePeerId)
        ? currentActivePeerId
        : undefined;
      const stagedActiveStillCurrent =
        retainedActivePeerId !== undefined &&
        retainedActivePeerId === stagedActivePeerId &&
        this.selectionVersion === stagedSelectionVersion &&
        activePage !== undefined;
      const peersAfterCommit = new Set([
        ...this.snapshotValue.dialogs.map(({ peer }) => peer.id),
        ...freshDialogs.map(({ peer }) => peer.id),
        ...this.loadedHistories.keys(),
      ]);
      for (const peerId of peersAfterCommit) {
        this.historyVersions.set(peerId, this.historyVersion(peerId) + 1);
        this.pinnedMessageVersions.set(peerId, (this.pinnedMessageVersions.get(peerId) ?? 0) + 1);
      }
      this.selectionVersion += 1;
      this.loadedHistories.clear();
      this.historyOffsets.clear();
      this.historyFailures.clear();
      this.historyIssues.clear();
      this.historyGaps.clear();
      this.historyModes.clear();
      this.historyAnchors.clear();
      this.pendingInboxReadMax.clear();
      for (const timer of this.inboxReadRetryTimers.values()) clearTimeout(timer);
      this.inboxReadRetryTimers.clear();
      this.messageMutations.clear();
      for (const timer of this.activityTimers.values()) clearTimeout(timer);
      this.activityTimers.clear();
      this.epoch = epoch;
      const dialogs = this.sortDialogs(
        freshDialogs.map((dialog) => ({ ...dialog, cacheEpoch: epoch })),
      );
      let messages: CachedMessage[] = [];
      let hasOlderMessages = false;
      if (stagedActiveStillCurrent && stagedActivePeerId && activePage) {
        messages = this.sortMessages(
          activePage.messages.map((message) => ({ ...message, cacheEpoch: epoch })),
        );
        const oldestId = messages[0]?.id;
        if (activePage.nextBeforeMessageId !== undefined) {
          this.historyOffsets.set(stagedActivePeerId, activePage.nextBeforeMessageId);
        } else if (oldestId !== undefined) {
          this.historyOffsets.set(stagedActivePeerId, oldestId);
        }
        const history = this.rememberHistory(
          stagedActivePeerId,
          { messages, hasOlderMessages: activePage.hasOlder },
          'newest',
        );
        messages = history.messages as CachedMessage[];
        hasOlderMessages = history.hasOlderMessages;
      }
      this.patch({
        dialogs,
        activePeerId: retainedActivePeerId,
        messages,
        hasOlderMessages,
        loadingMessages: retainedActivePeerId !== undefined && !stagedActiveStillCurrent,
        loadingOlderMessages: false,
        historyGaps: [],
        historyError: undefined,
        historyRetryAt: undefined,
        sharedMediaCounts: stagedActiveStillCurrent ? sharedMediaCounts : undefined,
        pinnedMessages: stagedActiveStillCurrent ? pinnedMessages : [],
        activities: [],
      });
      if (stagedActiveStillCurrent && sharedMediaCounts === undefined && stagedActiveDialog) {
        void this.loadSharedMediaCounts(stagedActiveDialog);
      }
      this.invalidateResource({ kind: 'expressions' });
      this.invalidateResource({ kind: 'bot-commands' });
      return stagedActiveStillCurrent ? undefined : retainedActivePeerId;
    });

    if (
      reloadPeerId &&
      this.isOperationCurrent(generation, accountId) &&
      this.snapshotValue.activePeerId === reloadPeerId
    ) {
      await this.selectChat(reloadPeerId);
    }
  }

  private async refreshActiveConversationFromCache(generation = this.lifecycleGeneration) {
    const accountId = this.accountId;
    if (!this.isOperationCurrent(generation, accountId)) return;
    const peerId = this.snapshotValue.activePeerId;
    if (!peerId) return;
    const cached = (await this.store.loadMessages(peerId, HISTORY_LIMIT)).filter(
      (message) => message.cacheEpoch === this.epoch,
    );
    if (
      !this.isOperationCurrent(generation, accountId) ||
      this.snapshotValue.activePeerId !== peerId
    ) {
      return;
    }
    const messages = this.sortMessages(cached);
    const oldestId = messages[0]?.id;
    if (oldestId !== undefined) this.historyOffsets.set(peerId, oldestId);
    const hasOlderMessages = messages.length > 0;
    const history = this.rememberHistory(
      peerId,
      {
        messages,
        hasOlderMessages,
      },
      'newest',
    );
    this.patch({
      messages: history.messages,
      hasOlderMessages: history.hasOlderMessages,
      historyGaps: this.historyGaps.get(peerId) ?? [],
    });
  }

  private async reloadActiveConversation(generation = this.lifecycleGeneration) {
    const accountId = this.accountId;
    if (!this.isOperationCurrent(generation, accountId)) return;
    const peerId = this.snapshotValue.activePeerId;
    const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
    if (!peerId || !dialog) return;
    const page = await this.transport.getHistory(dialog.peer, HISTORY_LIMIT);
    if (!this.isOperationCurrent(generation, accountId)) return;
    const messages = page.messages.map((message) => ({ ...message, cacheEpoch: this.epoch }));
    await this.store.replaceMessages(peerId, messages);
    if (
      !this.isOperationCurrent(generation, accountId) ||
      this.snapshotValue.activePeerId !== peerId
    ) {
      return;
    }
    const sorted = this.sortMessages(messages);
    const oldestId = sorted[0]?.id;
    if (page.nextBeforeMessageId !== undefined) {
      this.historyOffsets.set(peerId, page.nextBeforeMessageId);
    } else if (oldestId !== undefined) {
      this.historyOffsets.set(peerId, oldestId);
    } else {
      this.historyOffsets.delete(peerId);
    }
    this.historyGaps.delete(peerId);
    this.historyAnchors.delete(peerId);
    const history = this.rememberHistory(
      peerId,
      {
        messages: sorted,
        hasOlderMessages: page.hasOlder,
      },
      'newest',
    );
    this.patch({
      messages: history.messages,
      hasOlderMessages: history.hasOlderMessages,
      historyGaps: [],
      loadingMessages: false,
      historyError: undefined,
      historyRetryAt: undefined,
    });
  }

  private enqueueUpdateBatch(
    batch: TransportUpdateBatch,
    generation = this.lifecycleGeneration,
    operation?: { accountId: string | undefined },
  ) {
    const processing = this.updateQueue.then(() =>
      this.isUpdateOperationCurrent(generation, operation)
        ? this.applyLiveUpdateBatch(batch, generation, operation)
        : Promise.resolve(),
    );
    this.updateQueue = processing.catch((error: unknown) => {
      if (this.isUpdateOperationCurrent(generation, operation)) {
        this.fail('sync', 'Could not apply a Telegram update batch.', error);
      }
    });
    return processing;
  }

  private async applyLiveUpdateBatch(
    batch: TransportUpdateBatch,
    generation: number,
    operation?: { accountId: string | undefined },
  ) {
    if (!this.isUpdateOperationCurrent(generation, operation)) return;
    const cursor = await this.store.loadCursor();
    if (!this.isUpdateOperationCurrent(generation, operation)) return;
    if (cursor && batch.seq !== undefined && batch.seq > 0) {
      if (batch.seq <= cursor.seq) return;
      const seqStart = batch.seqStart ?? batch.seq;
      if (seqStart > cursor.seq + 1) {
        this.patch({ sync: 'recovering' });
        await this.reconcileStartup(false, generation);
        return;
      }
    }
    const incomingPeerIds = new Set<string>();
    for (const update of batch.updates) {
      if (!this.isUpdateOperationCurrent(generation, operation)) return;
      await this.applyLiveUpdate(update, generation);
      if (update.type === 'new-message' && !update.message.outgoing) {
        incomingPeerIds.add(update.message.peerId);
      }
    }
    if (this.transport.getDialog) {
      for (const peerId of incomingPeerIds) {
        if (!this.isUpdateOperationCurrent(generation, operation)) return;
        await this.refreshDialogHead(peerId);
      }
    }
    if ((batch.seq === undefined || batch.seq <= 0) && batch.date === undefined) return;
    const latest = await this.store.loadCursor();
    if (!latest || !this.isUpdateOperationCurrent(generation, operation)) return;
    await this.store.saveCursor({
      ...latest,
      ...(batch.date !== undefined ? { date: Math.max(latest.date, batch.date) } : {}),
      ...(batch.seq !== undefined && batch.seq > 0 ? { seq: Math.max(latest.seq, batch.seq) } : {}),
    });
  }

  private async acceptMutationUpdateBatches(
    batches: TransportUpdateBatch[] | undefined,
    generation: number,
    accountId: string | undefined,
  ) {
    if (!batches?.length) return false;
    for (const batch of batches) {
      await this.enqueueUpdateBatch(batch, generation, { accountId });
      if (!this.isOperationCurrent(generation, accountId)) return true;
    }
    return true;
  }

  private hasMutationUpdate(
    batches: TransportUpdateBatch[] | undefined,
    predicate: (update: TransportUpdate) => boolean,
  ) {
    return batches?.some((batch) => batch.updates.some(predicate)) ?? false;
  }

  private enqueueSyntheticUpdates(
    updates: TransportUpdate[],
    generation = this.lifecycleGeneration,
    publish = true,
    operation?: { accountId: string | undefined },
  ) {
    const processing = this.updateQueue.then(async () => {
      if (!this.isUpdateOperationCurrent(generation, operation)) return;
      for (const update of updates) {
        if (!this.isUpdateOperationCurrent(generation, operation)) return;
        await this.applyUpdate(update, publish);
      }
    });
    this.updateQueue = processing.catch((error: unknown) => {
      if (this.isUpdateOperationCurrent(generation, operation)) {
        this.fail('sync', 'Could not apply a local Telegram update.', error);
      }
    });
    return processing;
  }

  private async applyLiveUpdate(update: TransportUpdate, generation = this.lifecycleGeneration) {
    if (!this.isLifecycleCurrent(generation)) return;
    if (update.type === 'connection-state') {
      if (!update.connected) this.handleConnectionLost();
      return;
    }
    if (update.type === 'too-long') {
      await this.reconcileStartup(false, generation);
      return;
    }
    if (update.type === 'channel-too-long') {
      await this.recoverChannel(update.peerId, true);
      return;
    }
    if ('pts' in update && 'channelScoped' in update && update.channelScoped) {
      await this.applyChannelUpdate(update);
      return;
    }
    if ('pts' in update && (!('channelScoped' in update) || !update.channelScoped)) {
      const cursor = await this.store.loadCursor();
      if (cursor && update.pts <= cursor.pts) return;
      if (cursor && cursor.pts + update.ptsCount !== update.pts) {
        this.patch({ sync: 'recovering' });
        await this.reconcileStartup(false, generation);
        return;
      }
      await this.applyUpdate(update, true);
      if (cursor) {
        await this.store.saveCursor({ ...cursor, pts: update.pts });
      }
    } else {
      await this.applyUpdate(update, true);
    }
  }

  private async applyChannelUpdate(update: Extract<TransportUpdate, { pts: number }>) {
    const peerId = this.updatePeerId(update);
    if (!peerId) {
      await this.applyUpdate(update, true);
      return;
    }
    let dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
    const neededBaseline = !dialog || dialog.channelPts === undefined;
    if (!dialog || dialog.channelPts === undefined) {
      await this.refreshDialogHead(peerId);
      dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
    }
    if (update.type === 'read-history') {
      if (!dialog) return;
      // Channel read updates do not carry an increment count (and outbox reads
      // carry no PTS at all). Apply them as idempotent side effects without
      // advancing or rejecting the channel PTS stream.
      await this.applyUpdate(update, true);
      return;
    }
    if (!dialog) {
      await this.applyUpdate(update, true);
      await this.setChannelPts(peerId, update.pts);
      return;
    }
    const currentPts = dialog.channelPts ?? 0;
    if (update.pts <= currentPts) {
      if (neededBaseline && update.type === 'new-message') {
        await this.applyUpdate({ ...update, type: 'edit-message' }, true);
      }
      return;
    }
    if (currentPts + update.ptsCount !== update.pts) {
      await this.recoverChannel(peerId);
      const recoveredPts = this.snapshotValue.dialogs.find(
        ({ peer }) => peer.id === peerId,
      )?.channelPts;
      if (recoveredPts === undefined || update.pts <= recoveredPts) return;
      if (recoveredPts + update.ptsCount === update.pts) {
        await this.applyUpdate(update, true);
        await this.setChannelPts(peerId, update.pts);
      }
      return;
    }
    await this.applyUpdate(update, true);
    await this.setChannelPts(peerId, update.pts);
  }

  private async recoverChannel(peerId: string, knownTooLong = false) {
    const current = this.channelRefreshes.get(peerId);
    if (current) return current;
    let completed = false;
    const refreshing = (async () => {
      this.patch({ sync: 'recovering' });
      let dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
      if (!dialog) {
        await this.refreshDialogHead(peerId);
        dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
      }
      if (!dialog) return;
      if (knownTooLong) {
        await this.resetChannelHistory(dialog.peer);
        completed = true;
        return;
      }
      const difference = await this.transport.getChannelDifference(
        dialog.peer,
        dialog.channelPts ?? 0,
        CHANNEL_DIFFERENCE_LIMIT,
      );
      if (difference.type === 'too-long') {
        await this.resetChannelHistory(dialog.peer, difference.pts);
        completed = true;
        return;
      }
      for (const recovered of difference.updates) {
        if (recovered.type === 'too-long' || recovered.type === 'channel-too-long') {
          await this.resetChannelHistory(dialog.peer, difference.pts);
          completed = true;
          return;
        }
        await this.applyUpdate(recovered, true);
      }
      await this.setChannelPts(peerId, difference.pts);
      completed = true;
    })();
    this.channelRefreshes.set(peerId, refreshing);
    try {
      await refreshing;
    } finally {
      if (this.channelRefreshes.get(peerId) === refreshing) this.channelRefreshes.delete(peerId);
      if (completed && this.snapshotValue.online) this.patch({ sync: 'current' });
    }
  }

  private async resetChannelHistory(peer: TelegramPeer, pts?: number) {
    this.invalidateHistory(peer.id);
    await this.store.replaceMessages(peer.id, []);
    await this.refreshDialogHead(peer.id);
    if (pts !== undefined) await this.setChannelPts(peer.id, pts);
    if (this.snapshotValue.activePeerId === peer.id) await this.reloadActiveConversation();
  }

  private async setChannelPts(peerId: string, channelPts: number) {
    await this.queueDialogStateOperation(async () => {
      const dialogs = this.snapshotValue.dialogs.map((dialog) =>
        dialog.peer.id === peerId ? { ...dialog, channelPts } : dialog,
      );
      const changed = dialogs.find(({ peer }) => peer.id === peerId);
      if (!changed) return;
      await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
      this.patch({ dialogs });
    });
  }

  private updatePeerId(update: Extract<TransportUpdate, { pts: number }>) {
    if (update.type === 'new-message' || update.type === 'edit-message') {
      return update.message.peerId;
    }
    return 'peerId' in update ? update.peerId : undefined;
  }

  private async applyUpdate(update: TransportUpdate, publish: boolean) {
    if (update.type === 'too-long' || update.type === 'channel-too-long') return;
    if (update.type === 'new-message' || update.type === 'edit-message') {
      const message: CachedMessage = { ...update.message, cacheEpoch: this.epoch };
      const existingMessage =
        this.snapshotValue.messages.find(
          ({ peerId, id }) => peerId === message.peerId && id === message.id,
        ) ??
        this.loadedHistories.get(message.peerId)?.messages.find(({ id }) => id === message.id) ??
        (await this.store.loadMessage(message.peerId, message.id));
      if (update.type === 'edit-message') {
        await this.invalidateEditedMedia(existingMessage, message);
      }
      const isNewMessage = update.type === 'new-message' && !existingMessage;
      this.noteMessageMutation(message.peerId, message.id);
      if (isNewMessage && !message.outgoing) {
        this.unreadVersions.set(message.peerId, (this.unreadVersions.get(message.peerId) ?? 0) + 1);
      }
      await this.store.putMessage(message);
      if (
        isNewMessage &&
        (message.service?.kind === 'users-added' || message.service?.kind === 'user-removed')
      ) {
        await this.invalidateGroupMembers(message.peerId);
      }
      const loaded = this.loadedHistories.get(message.peerId);
      if (loaded) {
        loaded.messages = this.boundHistoryMessages(
          message.peerId,
          [...loaded.messages.filter((current) => current.id !== message.id), message],
          this.historyModes.get(message.peerId) ?? 'newest',
        );
      }
      if (publish && this.snapshotValue.activePeerId === message.peerId) {
        const next = this.boundHistoryMessages(
          message.peerId,
          [...this.snapshotValue.messages.filter((current) => current.id !== message.id), message],
          this.historyModes.get(message.peerId) ?? 'newest',
        );
        const pinnedMessages = this.snapshotValue.pinnedMessages.map((pinned) =>
          pinned.id === message.id && pinned.peerId === message.peerId ? message : pinned,
        );
        this.patch({
          messages: next,
          pinnedMessages,
          historyGaps: this.historyGaps.get(message.peerId) ?? [],
        });
        if (pinnedMessages.some(({ id }) => id === message.id)) {
          await this.rememberPinnedMessages(message.peerId, pinnedMessages);
        }
      }
      await this.updateDialogHead(message, isNewMessage);
      if (publish && !message.outgoing && this.canMarkRead(message.peerId)) {
        const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === message.peerId);
        if (dialog) void this.markRead(dialog, message.id);
      }
      return;
    }
    if (update.type === 'delete-messages') {
      const mutationPeers = update.peerId
        ? [update.peerId]
        : this.snapshotValue.dialogs.map(({ peer }) => peer.id);
      for (const peerId of mutationPeers) {
        for (const messageId of update.messageIds) this.noteMessageMutation(peerId, messageId);
      }
      await this.store.deleteMessages(update.peerId, update.messageIds);
      const deleted = new Set(update.messageIds);
      const affectedDialogPeers: string[] = [];
      for (const [peerId, loaded] of this.loadedHistories) {
        if (!update.peerId || update.peerId === peerId) {
          loaded.messages = loaded.messages.filter((message) => !deleted.has(message.id));
        }
      }
      if (publish && (!update.peerId || this.snapshotValue.activePeerId === update.peerId)) {
        const activePeerId = this.snapshotValue.activePeerId;
        const pinnedMessages = this.snapshotValue.pinnedMessages.filter(
          (message) => !deleted.has(message.id),
        );
        this.patch({
          messages: this.snapshotValue.messages.filter((message) => !deleted.has(message.id)),
          pinnedMessages,
        });
        if (activePeerId) await this.rememberPinnedMessages(activePeerId, pinnedMessages);
      }
      const dialogs = await Promise.all(
        this.snapshotValue.dialogs.map(async (dialog) => {
          if (
            (update.peerId && update.peerId !== dialog.peer.id) ||
            !deleted.has(dialog.topMessageId)
          ) {
            return dialog;
          }
          affectedDialogPeers.push(dialog.peer.id);
          const remaining = this.sortMessages(await this.store.loadMessages(dialog.peer.id, 1));
          const topMessage = remaining.at(-1);
          const next: TelegramDialog = {
            ...dialog,
            topMessageId: topMessage?.id ?? 0,
            topMessage,
          };
          await this.store.putDialog({ ...next, cacheEpoch: this.epoch });
          return next;
        }),
      );
      this.patch({ dialogs: this.sortDialogs(dialogs) });
      for (const peerId of affectedDialogPeers) {
        const local = dialogs.find(({ peer }) => peer.id === peerId);
        await this.refreshDialogHead(peerId, local?.topMessageId === 0, deleted);
      }
      return;
    }
    if (update.type === 'read-history') {
      if (update.direction === 'inbox') {
        this.unreadVersions.set(update.peerId, (this.unreadVersions.get(update.peerId) ?? 0) + 1);
      }
      const dialogs = this.snapshotValue.dialogs.map((dialog) => {
        if (dialog.peer.id !== update.peerId) return dialog;
        return update.direction === 'inbox'
          ? {
              ...dialog,
              readInboxMaxId: Math.max(dialog.readInboxMaxId, update.maxMessageId),
              unreadCount: update.stillUnreadCount ?? 0,
            }
          : {
              ...dialog,
              readOutboxMaxId: Math.max(dialog.readOutboxMaxId, update.maxMessageId),
            };
      });
      this.patch({ dialogs });
      const changed = dialogs.find(({ peer }) => peer.id === update.peerId);
      if (changed && !changed.transient) {
        await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
      }
      return;
    }
    if (update.type === 'reaction-changed') {
      await this.applyReactionChange(update.peerId, update.messageId, update.reactions);
      return;
    }
    if (update.type === 'activity') {
      const key = `${update.activity.peerId}:${update.activity.senderId}`;
      const timer = this.activityTimers.get(key);
      if (timer) clearTimeout(timer);
      this.patch({
        activities: [
          ...this.snapshotValue.activities.filter(
            (activity) => `${activity.peerId}:${activity.senderId}` !== key,
          ),
          update.activity,
        ],
      });
      this.activityTimers.set(
        key,
        setTimeout(() => {
          this.patch({
            activities: this.snapshotValue.activities.filter(
              (activity) => `${activity.peerId}:${activity.senderId}` !== key,
            ),
          });
          this.activityTimers.delete(key);
        }, 6000),
      );
      return;
    }
    if (update.type === 'activity-ended') {
      const key = `${update.peerId}:${update.senderId}`;
      const timer = this.activityTimers.get(key);
      if (timer) clearTimeout(timer);
      this.activityTimers.delete(key);
      this.patch({
        activities: this.snapshotValue.activities.filter(
          (activity) => `${activity.peerId}:${activity.senderId}` !== key,
        ),
      });
      return;
    }
    if (update.type === 'presence-changed') {
      const dialogs = this.snapshotValue.dialogs.map((dialog) =>
        dialog.peer.id === update.peerId
          ? {
              ...dialog,
              presence: update.presence,
              lastSeenAt: update.lastSeenAt,
            }
          : dialog,
      );
      this.patch({ dialogs });
      const changed = dialogs.find(({ peer }) => peer.id === update.peerId);
      if (changed && !changed.transient) {
        await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
      }
      return;
    }
    if (update.type === 'mute-changed') {
      const dialogs = this.snapshotValue.dialogs.map((dialog) =>
        dialog.peer.id === update.peerId ? { ...dialog, muted: update.muted } : dialog,
      );
      this.patch({ dialogs });
      const changed = dialogs.find(({ peer }) => peer.id === update.peerId);
      if (changed && !changed.transient) {
        await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
      }
      return;
    }
    if (update.type === 'dialog-pinned') {
      const dialogs = this.sortDialogs(
        this.snapshotValue.dialogs.map((dialog) =>
          dialog.peer.id === update.peerId ? { ...dialog, pinned: update.pinned } : dialog,
        ),
      );
      this.patch({ dialogs });
      const changed = dialogs.find(({ peer }) => peer.id === update.peerId);
      if (changed && !changed.transient) {
        await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
      }
      return;
    }
    if (update.type === 'expression-index-changed') {
      const keys =
        update.kind === 'gifs'
          ? ['sticker-index:gifs:v2']
          : update.kind === 'stickers'
            ? ['sticker-index:recent:v2', 'sticker-index:packs:v2']
            : ['sticker-index:recent:v2', 'sticker-index:packs:v2', 'sticker-index:gifs:v2'];
      await Promise.all(keys.map((key) => this.store.deleteBlob(key)));
      this.invalidateResource({ kind: 'expressions' });
      return;
    }
    if (update.type === 'bot-commands-changed') {
      this.resources.forget(`bot-commands:${update.peerId}`);
      this.invalidateResource({ kind: 'bot-commands', peerId: update.peerId });
      return;
    }
    if (update.type === 'dialog-folders-changed') {
      const folders = new Map(update.folders.map(({ peerId, folderId }) => [peerId, folderId]));
      const dialogs = this.sortDialogs(
        this.snapshotValue.dialogs.map((dialog) =>
          folders.has(dialog.peer.id)
            ? { ...dialog, archived: folders.get(dialog.peer.id) === 1 }
            : dialog,
        ),
      );
      const changed = dialogs.filter((dialog) => folders.has(dialog.peer.id) && !dialog.transient);
      await Promise.all(
        changed.map((dialog) => this.store.putDialog({ ...dialog, cacheEpoch: this.epoch })),
      );
      this.patch({ dialogs });
      return;
    }
    if (update.type === 'dialog-list-invalidated') {
      await this.refreshDialogHeads();
      return;
    }
    if (update.type === 'peer-metadata-changed') {
      this.userDetails.delete(update.peerId);
      const dialogs = this.snapshotValue.dialogs.map((dialog) =>
        dialog.peer.id === update.peerId ? { ...dialog, userDetails: undefined } : dialog,
      );
      this.patch({ dialogs });
      await this.refreshDialogHead(update.peerId);
      this.invalidateResource({ kind: 'peer-metadata', peerId: update.peerId });
      return;
    }
    if (update.type === 'pts-advanced') return;
    if (update.type === 'pinned-messages') {
      const pinVersion = this.nextMutationVersion(this.pinnedMessageVersions, update.peerId);
      await this.invalidatePinnedMessages(update.peerId);
      if (this.snapshotValue.activePeerId !== update.peerId) return;
      const dialog = this.snapshotValue.dialogs.find(({ peer }) => peer.id === update.peerId);
      if (!dialog) return;
      await this.loadPinnedMessages(dialog, pinVersion);
      return;
    }
    if (update.type === 'dialog-changed') {
      const dialog: CachedDialog = { ...update.dialog, cacheEpoch: this.epoch };
      await this.store.putDialog(dialog);
      const next = [
        ...this.snapshotValue.dialogs.filter((current) => current.peer.id !== dialog.peer.id),
        dialog,
      ];
      this.patch({ dialogs: this.sortDialogs(next) });
    }
  }

  private async updateDialogHead(message: TelegramMessage, incrementUnread: boolean) {
    let existing = this.snapshotValue.dialogs.find(({ peer }) => peer.id === message.peerId);
    let recovered = false;
    if (!existing) {
      recovered = await this.refreshDialogHead(message.peerId);
      existing = this.snapshotValue.dialogs.find(({ peer }) => peer.id === message.peerId);
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
        title: message.peerId,
        initials: '?',
        color: '#765cff',
        topMessageId: message.id,
        topMessage: message,
        unreadCount:
          incrementUnread && !message.outgoing && !this.canMarkRead(message.peerId) ? 1 : 0,
        readInboxMaxId: 0,
        readOutboxMaxId: 0,
        muted: false,
        pinned: false,
        archived: false,
        hasAvatar: false,
        cacheEpoch: this.epoch,
      };
      await this.store.putDialog(placeholder);
      this.patch({ dialogs: this.sortDialogs([...this.snapshotValue.dialogs, placeholder]) });
      return;
    }
    const dialogs = this.snapshotValue.dialogs.map((dialog): TelegramDialog => {
      if (dialog.peer.id !== message.peerId) return dialog;
      return {
        ...dialog,
        ...(dialog.transient ? { transient: false } : {}),
        ...(message.id >= dialog.topMessageId
          ? { topMessageId: message.id, topMessage: message }
          : {}),
        unreadCount:
          incrementUnread &&
          message.id !== dialog.topMessageId &&
          !message.outgoing &&
          !this.canMarkRead(message.peerId)
            ? dialog.unreadCount + 1
            : dialog.unreadCount,
      };
    });
    this.patch({ dialogs: this.sortDialogs(dialogs) });
    const changed = dialogs.find(({ peer }) => peer.id === message.peerId);
    if (changed) await this.store.putDialog({ ...changed, cacheEpoch: this.epoch });
  }

  private async applyReactionChange(
    peerId: string,
    messageId: number,
    reactions: TelegramReaction[],
    expectedVersion?: number,
    operation?: { generation: number; accountId: string | undefined },
  ) {
    const key = `${peerId}:${messageId}`;
    const version = expectedVersion ?? this.nextReactionVersion(key);
    this.noteMessageMutation(peerId, messageId);
    const stored = await this.store.loadMessage(peerId, messageId);
    if (operation && !this.isOperationCurrent(operation.generation, operation.accountId)) {
      return;
    }
    if (this.reactionVersions.get(key) !== version) return;
    if (stored) await this.store.putMessage({ ...stored, reactions });
    if (operation && !this.isOperationCurrent(operation.generation, operation.accountId)) {
      return;
    }
    if (this.reactionVersions.get(key) !== version) return;
    const loaded = this.loadedHistories.get(peerId);
    if (loaded) {
      loaded.messages = loaded.messages.map((message) =>
        message.id === messageId ? { ...message, reactions } : message,
      );
    }
    if (this.snapshotValue.activePeerId !== peerId) return;
    this.patch({
      messages: this.snapshotValue.messages.map((message) =>
        message.id === messageId ? { ...message, reactions } : message,
      ),
    });
  }

  private nextReactionVersion(key: string) {
    const version = (this.reactionVersions.get(key) ?? 0) + 1;
    this.reactionVersions.set(key, version);
    return version;
  }

  private reactionsAfterChoice(reactions: TelegramReaction[], emoji?: string) {
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

  async retryPendingSend(id: string) {
    let pending = this.snapshotValue.pending.find((candidate) => candidate.id === id);
    if (!pending) return;
    const activeDelivery = this.pendingQueue.delivery(id);
    if (activeDelivery) {
      await activeDelivery;
      pending = this.snapshotValue.pending.find((candidate) => candidate.id === id);
      if (!pending?.lastError) return;
    }
    if (!this.snapshotValue.online) await this.retrySync();
    pending = this.snapshotValue.pending.find((candidate) => candidate.id === id);
    if (!pending) return;
    if (this.canDeliver(pending)) await this.deliver(pending);
  }

  async cancelPendingSend(id: string) {
    const pending = this.snapshotValue.pending.find((candidate) => candidate.id === id);
    if (!pending) return false;
    this.pendingQueue.cancel(id);
    await this.store.deletePending(id);
    const remaining = this.snapshotValue.pending.filter((candidate) => candidate.id !== id);
    const clearOutboxError =
      this.operationErrorArea === 'outbox' && !remaining.some(({ lastError }) => lastError);
    if (clearOutboxError) this.operationErrorArea = undefined;
    this.patch({
      pending: remaining,
      ...(clearOutboxError ? { operationError: undefined } : {}),
    });
    this.pendingQueue.finishCancellation(id);
    this.releasePeerDeliveryBlock(pending.peer.id, id);
    return true;
  }

  async retryOutbox() {
    if (!this.snapshotValue.online) await this.retrySync();
    await this.flushOutbox();
  }

  private async flushOutbox() {
    if (this.flushingOutbox) return this.flushingOutbox;
    const flushing = (async () => {
      const peerIds = [...new Set(this.snapshotValue.pending.map(({ peer }) => peer.id))];
      await Promise.all(peerIds.map((peerId) => this.flushPeerOutbox(peerId)));
    })();
    this.flushingOutbox = flushing;
    try {
      await flushing;
    } finally {
      if (this.flushingOutbox === flushing) this.flushingOutbox = undefined;
    }
  }

  private async flushPeerOutbox(peerId: string) {
    const pending = this.snapshotValue.pending
      .filter((send) => send.peer.id === peerId)
      .sort(
        (left, right) =>
          (left.queueOrder ?? 0) - (right.queueOrder ?? 0) ||
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      );
    for (const send of pending) {
      if (!this.canDeliver(send)) return;
      await this.deliver(send);
    }
  }

  private async reserveDraftSend(
    pending: PendingSend,
    expectedText: string,
    expectedRevision: number,
    generation = this.lifecycleGeneration,
    accountId = pending.accountId,
  ) {
    const peerId = pending.peer.id;
    const previous = this.draftWrites.get(peerId) ?? Promise.resolve();
    const reservation = previous
      .catch(() => undefined)
      .then(() =>
        this.isPendingOperationCurrent(generation, accountId)
          ? this.store.commitOutbox(pending, {
              peerId,
              text: expectedText,
              revision: expectedRevision,
            })
          : undefined,
      );
    this.draftWrites.set(peerId, reservation);
    try {
      await reservation;
    } catch (error) {
      if (this.isPendingOperationCurrent(generation, accountId)) {
        this.fail('cache', 'The message could not be saved to the send queue.', error, false);
      }
      throw error;
    } finally {
      if (this.draftWrites.get(peerId) === reservation) this.draftWrites.delete(peerId);
    }
  }

  private async reserveDraftBatch(
    pending: PendingSend[],
    reservation: { peerId: string; text: string; revision?: number },
    generation = this.lifecycleGeneration,
    accountId = pending[0]?.accountId,
  ) {
    const previous = this.draftWrites.get(reservation.peerId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() =>
        this.isPendingOperationCurrent(generation, accountId)
          ? this.store.commitOutbox(pending, reservation)
          : undefined,
      );
    this.draftWrites.set(reservation.peerId, write);
    try {
      await write;
    } finally {
      if (this.draftWrites.get(reservation.peerId) === write) {
        this.draftWrites.delete(reservation.peerId);
      }
    }
  }

  private draftSendKey(pending: PendingSend, draftVersion: number) {
    return JSON.stringify([
      draftVersion,
      pending.text,
      pending.reply?.messageId ?? null,
      pending.reply?.quoteText ?? null,
      pending.formats?.map(({ offset, length, kind, url }) => [
        offset,
        length,
        kind,
        url ?? null,
      ]) ?? [],
    ]);
  }

  private enqueuePending(pending: PendingSend) {
    const blockedBy = this.pendingQueue.blockedBy(pending.peer.id);
    if (blockedBy && blockedBy !== pending.id) {
      pending = this.pendingQueue.capture({ ...pending, lastError: this.blockedSendMessage() });
    }
    const generation = this.lifecycleGeneration;
    const accountId = pending.accountId;
    let delivery: Promise<void> | undefined;
    this.patch({ pending: [...this.snapshotValue.pending, pending] });
    const operation = this.pendingQueue.queueWrite(pending.peer.id, async () => {
      if (!this.isPendingOperationCurrent(generation, accountId)) return;
      try {
        await this.writeOutboxWithQuotaRecovery(this.pendingQueue.blobBytes(pending), () =>
          this.store.commitOutbox(pending),
        );
      } catch (error) {
        if (this.isPendingOperationCurrent(generation, accountId)) {
          this.patch({
            pending: this.snapshotValue.pending.filter(({ id }) => id !== pending.id),
          });
          this.fail('cache', 'The message could not be saved to the send queue.', error, false);
        }
        throw error;
      }
      if (!this.isPendingOperationCurrent(generation, accountId)) return;
      if (this.canDeliver(pending)) delivery = this.deliver(pending);
    });
    return this.trackLifecycleTask(
      operation.then(async () => {
        await delivery;
      }),
    );
  }

  private enqueuePendingBatch(
    pending: PendingSend[],
    draftReservation?: { peerId: string; text: string; revision?: number },
  ) {
    if (pending.length === 0) return Promise.resolve();
    const blockedBy = this.pendingQueue.blockedBy(pending[0]!.peer.id);
    if (blockedBy) {
      pending = pending.map((send) =>
        send.id === blockedBy
          ? send
          : this.pendingQueue.capture({ ...send, lastError: this.blockedSendMessage() }),
      );
    }
    const generation = this.lifecycleGeneration;
    const accountId = pending[0]!.accountId;
    const peerId = pending[0]!.peer.id;
    let deliveries: Promise<void>[] = [];
    this.patch({ pending: [...this.snapshotValue.pending, ...pending] });
    const operation = this.pendingQueue.queueWrite(peerId, async () => {
      if (!this.isPendingOperationCurrent(generation, accountId)) return;
      try {
        const bytes = pending.reduce((total, send) => total + this.pendingQueue.blobBytes(send), 0);
        await this.writeOutboxWithQuotaRecovery(bytes, () =>
          draftReservation
            ? this.reserveDraftBatch(pending, draftReservation)
            : this.store.commitOutbox(pending),
        );
      } catch (error) {
        if (this.isPendingOperationCurrent(generation, accountId)) {
          const failedIds = new Set(pending.map(({ id }) => id));
          this.patch({
            pending: this.snapshotValue.pending.filter(({ id }) => !failedIds.has(id)),
          });
          this.fail('cache', 'The messages could not be saved to the send queue.', error, false);
        }
        throw error;
      }
      if (!this.isPendingOperationCurrent(generation, accountId)) return;
      let drafts = this.snapshotValue.drafts;
      if (
        draftReservation &&
        drafts[draftReservation.peerId] === draftReservation.text &&
        (draftReservation.revision === undefined ||
          (this.draftVersions.get(draftReservation.peerId) ?? 0) === draftReservation.revision)
      ) {
        drafts = { ...drafts, [draftReservation.peerId]: '' };
      }
      this.patch({ drafts });
      deliveries = pending
        .filter((send) => this.canDeliver(send))
        .map((send) => this.deliver(send));
    });
    return this.trackLifecycleTask(
      operation.then(async () => {
        await Promise.all(deliveries);
      }),
    );
  }

  private deliver(pending: PendingSend) {
    const generation = this.lifecycleGeneration;
    return this.trackLifecycleTask(
      this.pendingQueue.scheduleDelivery(pending, () => this.deliverCurrent(pending, generation)),
    );
  }

  private async deliverCurrent(pending: PendingSend, generation: number) {
    const accountId = pending.accountId;
    if (!this.isOperationCurrent(generation, accountId)) return;
    if (!this.canDeliver(pending) || !this.pendingQueue.beginAttempt(pending.id)) return;
    const attempting = this.pendingQueue.capture({
      ...pending,
      attempts: pending.attempts + 1,
      lastError: undefined,
      uploadProgress: pending.attachment || pending.album ? 0 : undefined,
    });
    let failure: { pending: PendingSend; error: unknown } | undefined;
    try {
      await this.store.commitOutbox(attempting);
      if (this.pendingQueue.isCancelled(attempting.id)) {
        await this.store.deletePending(attempting.id);
        return;
      }
      if (!this.isOperationCurrent(generation, accountId)) return;
      this.replacePending(attempting);
      const onProgress = (progress: number) => {
        if (this.isOperationCurrent(generation, accountId)) {
          this.updateUploadProgress(attempting.id, progress);
        }
      };
      let sentMessages: TelegramMessage[];
      let updateBatches: TransportUpdateBatch[] | undefined;
      if (attempting.botStart) {
        const result = this.transport.startBot
          ? await this.transport.startBot(
              attempting.peer,
              attempting.botStart.startParam,
              attempting.randomId,
            )
          : await this.transport.sendText(attempting.peer, attempting.text, attempting.randomId);
        sentMessages = [result.message];
        updateBatches = result.updateBatches;
      } else if (attempting.forward) {
        const result = await this.transport.forwardMessage(
          attempting.forward.fromPeer,
          attempting.peer,
          attempting.forward.messageId,
          attempting.randomId,
        );
        sentMessages = [result.message];
        updateBatches = result.updateBatches;
      } else if (attempting.sticker) {
        const result = await this.transport.sendSticker(
          attempting.peer,
          attempting.sticker,
          attempting.randomId,
          attempting.reply,
        );
        sentMessages = [result.message];
        updateBatches = result.updateBatches;
      } else if (attempting.album) {
        const result = await this.transport.sendAlbum(
          attempting.peer,
          attempting.album.attachments.map((attachment) => ({
            file: new File([attachment.blob], attachment.name, {
              type: attachment.mimeType,
            }),
            randomId: attachment.randomId,
            sendAs: 'media',
          })),
          {
            caption: attempting.text,
            reply: attempting.reply,
            formats: attempting.formats,
            onProgress,
          },
        );
        sentMessages = result.messages;
        updateBatches = result.updateBatches;
      } else if (attempting.attachment) {
        const result = await this.transport.sendFile(
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
        sentMessages = [result.message];
        updateBatches = result.updateBatches;
      } else {
        const result = await this.transport.sendText(
          attempting.peer,
          attempting.text,
          attempting.randomId,
          attempting.reply,
          attempting.formats,
        );
        sentMessages = [result.message];
        updateBatches = result.updateBatches;
      }
      if (sentMessages.length === 0) throw new Error('Telegram returned no sent messages.');
      if (!this.isOperationCurrent(generation, accountId)) return;
      if (this.pendingQueue.isCancelled(attempting.id)) return;
      await this.acceptMutationUpdateBatches(updateBatches, generation, accountId);
      if (!this.isOperationCurrent(generation, accountId)) return;
      if (this.pendingQueue.isCancelled(attempting.id)) return;
      // Mutation envelopes can omit the caller-known random ID. Merge the RPC
      // result before deleting the durable outbox record so correlation
      // survives a crash between confirmation and cleanup.
      await this.enqueueSyntheticUpdates(
        sentMessages.map((message) => ({
          type: 'new-message' as const,
          pts: 0,
          ptsCount: 0,
          message,
        })),
        generation,
        true,
        { accountId },
      );
      if (!this.isOperationCurrent(generation, accountId)) return;
      if (this.pendingQueue.isCancelled(attempting.id)) return;
      await this.store.deletePending(attempting.id);
      if (!this.isOperationCurrent(generation, accountId)) return;
      const remaining = this.snapshotValue.pending.filter(({ id }) => id !== attempting.id);
      const clearOutboxError =
        this.operationErrorArea === 'outbox' && !remaining.some(({ lastError }) => lastError);
      if (clearOutboxError) this.operationErrorArea = undefined;
      this.patch({
        pending: remaining,
        ...(clearOutboxError ? { operationError: undefined } : {}),
      });
      this.releasePeerDeliveryBlock(attempting.peer.id, attempting.id);
    } catch (error) {
      if (!this.isOperationCurrent(generation, accountId)) return;
      if (this.pendingQueue.isCancelled(attempting.id)) return;
      const current =
        this.snapshotValue.pending.find(({ id }) => id === attempting.id) ?? attempting;
      const failed = this.pendingQueue.capture({ ...current, lastError: this.errorMessage(error) });
      await this.store.commitOutbox(failed);
      if (!this.isOperationCurrent(generation, accountId)) return;
      if (this.pendingQueue.isCancelled(attempting.id)) {
        await this.store.deletePending(attempting.id);
        return;
      }
      this.pendingQueue.block(attempting.peer.id, attempting.id);
      await this.markPeerQueueBlocked(attempting.peer.id, attempting.id);
      failure = { pending: failed, error };
    } finally {
      this.pendingQueue.endAttempt(pending.id);
    }
    if (failure) {
      this.replacePending(failure.pending);
      this.fail('outbox', 'A message remains queued for retry.', failure.error, false);
    }
  }

  private replacePending(pending: PendingSend) {
    const captured = this.pendingQueue.capture(pending);
    this.patch({
      pending: this.snapshotValue.pending.map((current) =>
        current.id === captured.id ? captured : current,
      ),
    });
  }

  private async writeOutboxWithQuotaRecovery(bytes: number, write: () => Promise<void>) {
    await this.store.prepareOutboxWrite(bytes);
    try {
      await write();
    } catch (error) {
      if (!this.isQuotaError(error)) throw error;
      await this.store.prepareOutboxWrite(bytes, true);
      await write();
    }
  }

  private isQuotaError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'QuotaExceededError'
    );
  }

  private validateTextLength(text: string, limit: number, label: string) {
    if (text.length <= limit) return;
    const error = new Error(`The ${label} is ${text.length} characters; Telegram allows ${limit}.`);
    this.fail('outbox', `The ${label} was not queued.`, error, false);
    throw error;
  }

  private validateAttachment(file: File) {
    if (file.size > 0) return;
    const error = new Error(`${file.name || 'The attachment'} is empty.`);
    this.fail('outbox', 'The attachment was not queued.', error, false);
    throw error;
  }

  private async markPeerQueueBlocked(peerId: string, blockedBy: string) {
    const message = this.blockedSendMessage();
    const blocked = this.snapshotValue.pending.filter(
      (pending) => pending.peer.id === peerId && pending.id !== blockedBy && !pending.lastError,
    );
    if (blocked.length === 0) return;
    const replacements = blocked.map((pending) =>
      this.pendingQueue.capture({ ...pending, lastError: message }),
    );
    await Promise.all(replacements.map((pending) => this.store.commitOutbox(pending)));
    const byId = new Map(replacements.map((pending) => [pending.id, pending]));
    this.patch({
      pending: this.snapshotValue.pending.map((pending) => byId.get(pending.id) ?? pending),
    });
  }

  private blockedSendMessage() {
    return 'Waiting for an earlier failed message. Retry or cancel that message first.';
  }

  private updateUploadProgress(id: string, progress: number) {
    const current = this.snapshotValue.pending.find((pending) => pending.id === id);
    if (!current) return;
    this.replacePending({ ...current, uploadProgress: Math.max(0, Math.min(1, progress)) });
  }

  private async markRead(dialog: TelegramDialog, maxMessageId: number, force = false) {
    if (!this.snapshotValue.online || (!force && !this.canMarkRead(dialog.peer.id))) return;
    if (maxMessageId <= dialog.readInboxMaxId && dialog.unreadCount === 0) return;
    const peerId = dialog.peer.id;
    this.pendingInboxReadMax.set(
      peerId,
      Math.max(this.pendingInboxReadMax.get(peerId) ?? 0, maxMessageId),
    );
    const currentRequest = this.inboxReadRequests.get(peerId);
    if (currentRequest) return currentRequest;
    const request = this.flushInboxReads(peerId, force).finally(() => {
      if (this.inboxReadRequests.get(peerId) === request) {
        this.inboxReadRequests.delete(peerId);
      }
      const pendingMax = this.pendingInboxReadMax.get(peerId);
      const current = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
      if (
        pendingMax !== undefined &&
        current &&
        !this.inboxReadRetryTimers.has(peerId) &&
        (force || this.canMarkRead(peerId))
      ) {
        void this.markRead(current, pendingMax, force);
      }
    });
    this.inboxReadRequests.set(peerId, request);
    return request;
  }

  private async flushInboxReads(peerId: string, force = false) {
    const generation = this.lifecycleGeneration;
    const accountId = this.accountId;
    while (this.snapshotValue.online && (force || this.canMarkRead(peerId))) {
      const maxMessageId = this.pendingInboxReadMax.get(peerId);
      if (maxMessageId === undefined) return;
      this.pendingInboxReadMax.delete(peerId);
      const current = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
      if (!current) return;
      if (maxMessageId <= current.readInboxMaxId && current.unreadCount === 0) continue;
      const unreadVersion = this.unreadVersions.get(peerId) ?? 0;
      try {
        const result = await this.transport.readHistory(current.peer, maxMessageId);
        if (!this.isOperationCurrent(generation, accountId)) return;
        await this.acceptMutationUpdateBatches(result.updateBatches, generation, accountId);
        if (!this.isOperationCurrent(generation, accountId)) return;
      } catch (error) {
        this.pendingInboxReadMax.set(peerId, maxMessageId);
        if (this.isOperationCurrent(generation, accountId)) {
          this.fail('sync', `Could not mark ${current.title} as read.`, error, false);
          if (!this.inboxReadRetryTimers.has(peerId)) {
            const timer = setTimeout(() => {
              this.inboxReadRetryTimers.delete(peerId);
              const latest = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId);
              if (latest && this.snapshotValue.online) {
                void this.markRead(
                  latest,
                  this.pendingInboxReadMax.get(peerId) ?? maxMessageId,
                  force,
                );
              }
            }, 500);
            this.inboxReadRetryTimers.set(peerId, timer);
          }
        }
        return;
      }
      await this.queueDialogStateOperation(async () => {
        if (!this.isOperationCurrent(generation, accountId)) return;
        const latest = this.snapshotValue.dialogs.find(({ peer }) => peer.id === peerId) ?? current;
        const changed: CachedDialog = {
          ...latest,
          readInboxMaxId: Math.max(latest.readInboxMaxId, maxMessageId),
          unreadCount:
            (this.unreadVersions.get(peerId) ?? 0) === unreadVersion ? 0 : latest.unreadCount,
          cacheEpoch: this.epoch,
        };
        await this.store.putDialog(changed);
        this.patch({
          dialogs: this.snapshotValue.dialogs.map((candidate) =>
            candidate.peer.id === peerId ? changed : candidate,
          ),
        });
      });
      if (this.snapshotValue.operationError?.startsWith('Could not mark ')) {
        this.clearOperationError();
      }
    }
    this.pendingInboxReadMax.delete(peerId);
  }

  private async batchSnapshotNotifications<T>(operation: () => Promise<T>) {
    this.snapshotNotificationBatchDepth += 1;
    try {
      return await operation();
    } finally {
      this.snapshotNotificationBatchDepth -= 1;
      if (this.snapshotNotificationBatchDepth === 0 && this.snapshotNotificationPending) {
        this.snapshotNotificationPending = false;
        for (const listener of this.listeners) listener(this.snapshotValue);
      }
    }
  }

  private patch(patch: Partial<EngineSnapshot>) {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    if (this.snapshotNotificationBatchDepth > 0) {
      this.snapshotNotificationPending = true;
      return;
    }
    for (const listener of this.listeners) listener(this.snapshotValue);
  }

  private fail(
    area: 'auth' | 'sync' | 'transport' | 'cache' | 'outbox',
    message: string,
    error: unknown,
    fatal = true,
  ) {
    const detail = this.errorMessage(error);
    reportDiagnostic({
      code: `${area}-failed`,
      level: 'error',
      area,
      message,
      details: { error: detail },
    });
    if (fatal && (this.snapshotValue.online || this.unsubscribeTransport)) {
      this.unsubscribeTransport?.();
      this.unsubscribeTransport = undefined;
      void this.disconnectTransport().catch(() => undefined);
    }
    if (fatal && this.hasReachedReady) {
      this.operationErrorArea = undefined;
      this.patch({
        phase: 'ready',
        sync: 'stale',
        online: false,
        operationError: undefined,
        error: `${message} ${detail}`,
      });
      return;
    }
    if (fatal) {
      this.operationErrorArea = undefined;
      this.patch({
        phase: 'error',
        online: false,
        operationError: undefined,
        error: `${message} ${detail}`,
      });
      return;
    }
    if (area === 'auth') {
      this.patch({ error: `${message} ${detail}` });
      return;
    }
    if (
      area !== 'outbox' &&
      this.operationErrorArea === 'outbox' &&
      this.snapshotValue.pending.some(({ lastError }) => lastError)
    ) {
      return;
    }
    this.operationErrorArea = area;
    this.patch({ operationError: `${message} ${detail}` });
  }

  private reportFailure(
    area: 'auth' | 'sync' | 'transport' | 'cache' | 'outbox',
    message: string,
    error: unknown,
  ) {
    reportDiagnostic({
      code: `${area}-operation-failed`,
      level: 'error',
      area,
      message,
      details: { error: this.errorMessage(error) },
    });
  }

  private handleConnectionLost() {
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = undefined;
    reportDiagnostic({
      code: 'connection-lost',
      level: 'info',
      area: 'transport',
      message: 'Telegram connection was lost; cached data remains available.',
    });
    this.patch({
      phase: 'ready',
      sync: 'stale',
      online: false,
      error: 'Telegram connection was lost. Reconnect to continue.',
    });
    void this.disconnectTransport().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.quiescing || !this.credentials) return;
    const generation = this.lifecycleGeneration;
    this.reconnect.schedule(async () => {
      if (!this.isLifecycleCurrent(generation) || this.snapshotValue.online) return false;
      await this.retrySync();
      return this.isLifecycleCurrent(generation) && !this.snapshotValue.online;
    });
  }

  private canMarkRead(peerId: string) {
    return (
      this.snapshotValue.online &&
      this.snapshotValue.activePeerId === peerId &&
      this.readViewport.peerId === peerId &&
      this.readViewport.visible &&
      this.readViewport.atBottom
    );
  }

  private canDeliver(pending: PendingSend) {
    const blockedBy = this.pendingQueue.blockedBy(pending.peer.id);
    return (
      this.snapshotValue.online &&
      !!this.accountId &&
      pending.accountId === this.accountId &&
      (blockedBy === undefined || blockedBy === pending.id) &&
      !this.pendingQueue.isCancelled(pending.id)
    );
  }

  private releasePeerDeliveryBlock(peerId: string, pendingId: string) {
    if (!this.pendingQueue.releaseBlock(peerId, pendingId)) return;
    void this.flushPeerOutbox(peerId);
  }

  private historyVersion(peerId: string) {
    return this.historyVersions.get(peerId) ?? 0;
  }

  private isHistoryOperationCurrent(
    peerId: string,
    historyVersion: number,
    generation: number,
    accountId: string | undefined,
  ) {
    return (
      this.isOperationCurrent(generation, accountId) &&
      this.historyVersion(peerId) === historyVersion
    );
  }

  private invalidateHistory(peerId: string, removeMessages = true) {
    this.historyVersions.set(peerId, this.historyVersion(peerId) + 1);
    this.loadedHistories.delete(peerId);
    this.historyOffsets.delete(peerId);
    this.historyFailures.delete(peerId);
    this.historyIssues.delete(peerId);
    this.historyGaps.delete(peerId);
    this.historyModes.delete(peerId);
    this.historyAnchors.delete(peerId);
    if (removeMessages && this.snapshotValue.activePeerId === peerId) {
      this.patch({
        messages: [],
        hasOlderMessages: false,
        loadingOlderMessages: false,
        historyGaps: [],
        historyError: undefined,
        historyRetryAt: undefined,
      });
    }
  }

  private rememberHistory(
    peerId: string,
    history: { messages: TelegramMessage[]; hasOlderMessages: boolean },
    mode?: 'newest' | 'oldest' | 'anchor',
  ) {
    const resolvedMode = mode ?? this.historyModes.get(peerId) ?? 'newest';
    this.historyModes.set(peerId, resolvedMode);
    const bounded = {
      ...history,
      messages: this.boundHistoryMessages(peerId, history.messages, resolvedMode),
    };
    this.loadedHistories.delete(peerId);
    this.loadedHistories.set(peerId, bounded);
    while (this.loadedHistories.size > MAX_LOADED_HISTORIES) {
      const evicted = [...this.loadedHistories.keys()].find(
        (candidate) => candidate !== this.snapshotValue.activePeerId,
      );
      if (!evicted) break;
      this.loadedHistories.delete(evicted);
      this.historyOffsets.delete(evicted);
      this.historyFailures.delete(evicted);
      this.historyIssues.delete(evicted);
      this.historyGaps.delete(evicted);
      this.historyModes.delete(evicted);
      this.historyAnchors.delete(evicted);
    }
    return bounded;
  }

  private boundHistoryMessages(
    peerId: string,
    messages: TelegramMessage[],
    mode: 'newest' | 'oldest' | 'anchor',
  ) {
    const unique = [...new Map(messages.map((message) => [message.id, message])).values()];
    const alreadySortedAndUnique =
      unique.length === messages.length &&
      messages.every(
        (message, index) => index === 0 || (messages[index - 1]?.id ?? 0) < message.id,
      );
    const sorted = alreadySortedAndUnique ? messages : this.sortMessages(unique);
    const limit =
      this.snapshotValue.activePeerId === peerId ? MAX_ACTIVE_MESSAGES : MAX_MESSAGES_PER_HISTORY;
    if (sorted.length <= limit) return sorted;
    if (mode === 'newest') {
      return this.finalizeBoundHistory(peerId, sorted, sorted.slice(-limit));
    }
    if (mode === 'oldest') {
      const olderCount = Math.floor(limit / 2);
      return this.finalizeBoundHistory(peerId, sorted, [
        ...sorted.slice(0, olderCount),
        ...sorted.slice(-(limit - olderCount)),
      ]);
    }

    const anchor = this.historyAnchors.get(peerId);
    const anchorIndex = anchor === undefined ? -1 : sorted.findIndex(({ id }) => id === anchor);
    if (anchorIndex < 0) {
      return this.finalizeBoundHistory(peerId, sorted, sorted.slice(-limit));
    }
    const selected = new Map<number, TelegramMessage>();
    const anchorStart = Math.max(0, anchorIndex - 50);
    const anchorEnd = Math.min(sorted.length, anchorIndex + 51);
    for (const message of sorted.slice(anchorStart, anchorEnd)) selected.set(message.id, message);
    for (let index = sorted.length - 1; index >= 0 && selected.size < limit; index -= 1) {
      const message = sorted[index];
      if (message) selected.set(message.id, message);
    }
    return this.finalizeBoundHistory(peerId, sorted, this.sortMessages([...selected.values()]));
  }

  private finalizeBoundHistory(
    peerId: string,
    source: TelegramMessage[],
    retained: TelegramMessage[],
  ) {
    const retainedIds = new Set(retained.map(({ id }) => id));
    const retainedGaps = (this.historyGaps.get(peerId) ?? []).filter(
      (gap) => retainedIds.has(gap.olderMaxMessageId) && retainedIds.has(gap.newerMinMessageId),
    );
    let previousRetained: TelegramMessage | undefined;
    let droppedAfterPrevious = false;
    for (const message of source) {
      if (retainedIds.has(message.id)) {
        if (previousRetained && droppedAfterPrevious) {
          retainedGaps.push({
            olderMaxMessageId: previousRetained.id,
            newerMinMessageId: message.id,
          });
        }
        previousRetained = message;
        droppedAfterPrevious = false;
      } else if (previousRetained) {
        droppedAfterPrevious = true;
      }
    }
    const gaps = this.normalizeHistoryGaps(retainedGaps);
    if (gaps.length > 0) this.historyGaps.set(peerId, gaps);
    else this.historyGaps.delete(peerId);
    if (source[0] && !retainedIds.has(source[0].id) && retained[0]) {
      this.historyOffsets.set(peerId, retained[0].id);
    }
    return retained;
  }

  private recordLoadedHistoryRange(
    peerId: string,
    previousMessages: TelegramMessage[],
    fetched: TelegramMessage[],
  ) {
    if (previousMessages.length === 0 || fetched.length === 0) return;
    const rangeMinimum = Math.min(...fetched.map(({ id }) => id));
    const rangeMaximum = Math.max(...fetched.map(({ id }) => id));
    let gaps = (this.historyGaps.get(peerId) ?? []).flatMap((gap) => {
      if (rangeMaximum <= gap.olderMaxMessageId || rangeMinimum >= gap.newerMinMessageId) {
        return [gap];
      }
      const split: TelegramHistoryGap[] = [];
      if (rangeMinimum > gap.olderMaxMessageId) {
        split.push({
          olderMaxMessageId: gap.olderMaxMessageId,
          newerMinMessageId: rangeMinimum,
        });
      }
      if (rangeMaximum < gap.newerMinMessageId) {
        split.push({
          olderMaxMessageId: rangeMaximum,
          newerMinMessageId: gap.newerMinMessageId,
        });
      }
      return split;
    });
    const overlapsLoaded = previousMessages.some(
      ({ id }) => id >= rangeMinimum && id <= rangeMaximum,
    );
    if (!overlapsLoaded) {
      const immediateOlder = previousMessages
        .filter(({ id }) => id < rangeMinimum)
        .reduce<number | undefined>(
          (maximum, { id }) => (maximum === undefined ? id : Math.max(maximum, id)),
          undefined,
        );
      const immediateNewer = previousMessages
        .filter(({ id }) => id > rangeMaximum)
        .reduce<number | undefined>(
          (minimum, { id }) => (minimum === undefined ? id : Math.min(minimum, id)),
          undefined,
        );
      const isAlreadySplit = gaps.some(
        (gap) => gap.olderMaxMessageId <= rangeMaximum && gap.newerMinMessageId >= rangeMinimum,
      );
      if (!isAlreadySplit && immediateNewer !== undefined) {
        gaps.push({
          olderMaxMessageId: rangeMaximum,
          newerMinMessageId: immediateNewer,
        });
      } else if (!isAlreadySplit && immediateOlder !== undefined) {
        gaps.push({
          olderMaxMessageId: immediateOlder,
          newerMinMessageId: rangeMinimum,
        });
      }
    }
    gaps = this.normalizeHistoryGaps(gaps);
    if (gaps.length > 0) this.historyGaps.set(peerId, gaps);
    else this.historyGaps.delete(peerId);
  }

  private findHistoryGap(peerId: string, requested: TelegramHistoryGap) {
    return (this.historyGaps.get(peerId) ?? []).find(
      (gap) =>
        gap.olderMaxMessageId === requested.olderMaxMessageId &&
        gap.newerMinMessageId === requested.newerMinMessageId,
    );
  }

  private advanceHistoryGap(
    peerId: string,
    current: TelegramHistoryGap,
    fetched: TelegramMessage[],
    hasOlder: boolean,
  ) {
    const pageOldestId = fetched.reduce<number | undefined>(
      (minimum, { id }) => (minimum === undefined ? id : Math.min(minimum, id)),
      undefined,
    );
    const replacement =
      pageOldestId !== undefined && pageOldestId > current.olderMaxMessageId
        ? { ...current, newerMinMessageId: pageOldestId }
        : undefined;
    const next = (this.historyGaps.get(peerId) ?? []).flatMap((gap) => {
      if (
        gap.olderMaxMessageId !== current.olderMaxMessageId ||
        gap.newerMinMessageId !== current.newerMinMessageId
      ) {
        return [gap];
      }
      if (replacement) return [replacement];
      return pageOldestId === undefined && hasOlder ? [gap] : [];
    });
    const normalized = this.normalizeHistoryGaps(next);
    if (normalized.length > 0) this.historyGaps.set(peerId, normalized);
    else this.historyGaps.delete(peerId);
    return normalized;
  }

  private normalizeHistoryGaps(gaps: TelegramHistoryGap[]) {
    const unique = new Map<string, TelegramHistoryGap>();
    for (const gap of gaps) {
      if (gap.olderMaxMessageId + 1 >= gap.newerMinMessageId) continue;
      unique.set(`${gap.olderMaxMessageId}:${gap.newerMinMessageId}`, gap);
    }
    return [...unique.values()].sort(
      (left, right) => left.newerMinMessageId - right.newerMinMessageId,
    );
  }

  private touchHistory(peerId: string) {
    const history = this.loadedHistories.get(peerId);
    if (!history) return;
    this.loadedHistories.delete(peerId);
    this.loadedHistories.set(peerId, history);
  }

  private noteMessageMutation(peerId: string, messageId: number) {
    this.messageRevision += 1;
    const key = `${peerId}:${messageId}`;
    this.messageMutations.delete(key);
    this.messageMutations.set(key, this.messageRevision);
    while (this.messageMutations.size > MAX_MESSAGE_MUTATIONS) {
      const oldestKey = this.messageMutations.keys().next().value;
      if (oldestKey === undefined) break;
      this.messageMutationFloor = Math.max(
        this.messageMutationFloor,
        this.messageMutations.get(oldestKey) ?? 0,
      );
      this.messageMutations.delete(oldestKey);
    }
  }

  private filterFetchedMessages<T extends TelegramMessage>(
    peerId: string,
    messages: T[],
    requestRevision: number,
  ) {
    if (requestRevision < this.messageMutationFloor) return [];
    return messages.filter(
      ({ id }) => (this.messageMutations.get(`${peerId}:${id}`) ?? 0) <= requestRevision,
    );
  }

  private mergeFetchedMessages(
    peerId: string,
    current: TelegramMessage[],
    fetched: TelegramMessage[],
    requestRevision: number,
  ) {
    const merged = new Map(current.map((message) => [message.id, message]));
    if (requestRevision < this.messageMutationFloor) return this.sortMessages([...merged.values()]);
    for (const message of fetched) {
      if ((this.messageMutations.get(`${peerId}:${message.id}`) ?? 0) <= requestRevision) {
        merged.set(message.id, message);
      }
    }
    return this.sortMessages([...merged.values()]);
  }

  private recordHistoryFailure(peerId: string) {
    const attempts = (this.historyFailures.get(peerId)?.attempts ?? 0) + 1;
    const delay = Math.min(
      HISTORY_RETRY_MAX_MS,
      HISTORY_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    );
    const failure = { attempts, retryAt: Date.now() + delay };
    this.historyFailures.set(peerId, failure);
    return failure;
  }

  private clearHistoryFailure(peerId: string) {
    this.historyFailures.delete(peerId);
    this.historyIssues.delete(peerId);
  }

  private isFreshPeerMetadata<T>(cached: TimedCacheValue<T> | undefined) {
    return Boolean(cached && Date.now() - cached.savedAt < PEER_METADATA_CACHE_TTL_MS);
  }

  private async cachedPinnedMessages(peerId: string) {
    if (this.pinnedMessageCacheLoaded.has(peerId)) return this.pinnedMessageCache.get(peerId);
    this.pinnedMessageCacheLoaded.add(peerId);
    try {
      const cached = await this.store.loadPinnedMessages?.(peerId);
      if (cached) this.pinnedMessageCache.set(peerId, cached);
      return cached;
    } catch (error) {
      this.reportFailure('cache', 'Could not load cached pinned messages.', error);
      return undefined;
    }
  }

  private async rememberPinnedMessages(peerId: string, messages: TelegramMessage[]) {
    this.pinnedMessageCacheLoaded.add(peerId);
    this.pinnedMessageCache.set(peerId, { value: messages, savedAt: Date.now() });
    try {
      await this.store.savePinnedMessages?.(peerId, messages);
    } catch (error) {
      this.reportFailure('cache', 'Could not cache pinned messages.', error);
    }
  }

  private async invalidatePinnedMessages(peerId: string) {
    this.pinnedMessageCache.delete(peerId);
    this.pinnedMessageCacheLoaded.add(peerId);
    try {
      await this.store.deletePinnedMessages?.(peerId);
    } catch (error) {
      this.reportFailure('cache', 'Could not invalidate cached pinned messages.', error);
    }
  }

  private async cachedGroupMembers(peerId: string) {
    if (this.groupMemberCacheLoaded.has(peerId)) return this.groupMemberCache.get(peerId);
    this.groupMemberCacheLoaded.add(peerId);
    try {
      const cached = await this.store.loadGroupMembers?.(peerId);
      if (cached) this.groupMemberCache.set(peerId, cached);
      return cached;
    } catch (error) {
      this.reportFailure('cache', 'Could not load cached group members.', error);
      return undefined;
    }
  }

  private async rememberGroupMembers(peerId: string, members: TelegramGroupMember[]) {
    this.groupMemberCacheLoaded.add(peerId);
    this.groupMemberCache.set(peerId, { value: members, savedAt: Date.now() });
    try {
      await this.store.saveGroupMembers?.(peerId, members);
    } catch (error) {
      this.reportFailure('cache', 'Could not cache group members.', error);
    }
  }

  private async invalidateGroupMembers(peerId: string) {
    this.nextMutationVersion(this.groupMemberVersions, peerId);
    this.groupMemberCache.delete(peerId);
    this.groupMemberCacheLoaded.add(peerId);
    try {
      await this.store.deleteGroupMembers?.(peerId);
    } catch (error) {
      this.reportFailure('cache', 'Could not invalidate cached group members.', error);
    }
    this.invalidateResource({ kind: 'group-members', peerId });
  }

  private isLifecycleCurrent(generation: number) {
    return !this.quiescing && generation === this.lifecycleGeneration;
  }

  private trackLifecycleTask<T>(task: Promise<T>) {
    this.lifecycleTasks.add(task);
    const clear = () => this.lifecycleTasks.delete(task);
    void task.then(clear, clear);
    return task;
  }

  private trackVersionedMutation<T>(key: string, version: number, task: Promise<T>) {
    return this.trackLifecycleTask(
      task.finally(() => {
        if (this.mutationVersions.get(key) === version) this.mutationVersions.delete(key);
      }),
    );
  }

  private async drainLifecycleTasks() {
    while (this.lifecycleTasks.size > 0) {
      await Promise.allSettled(this.lifecycleTasks);
    }
  }

  private errorMessage(error: unknown) {
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

  private nextMutationVersion(versions: Map<string, number>, key: string) {
    const version = ++this.mutationSequence;
    versions.set(key, version);
    return version;
  }

  private queueMutation<T>(key: string, operation: () => Promise<T>) {
    const previous = this.mutationTails.get(key) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    this.mutationTails.set(key, tail);
    void tail.then(() => {
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key);
    });
    return queued;
  }

  private queueDialogStateOperation<T>(operation: () => Promise<T>) {
    const queued = this.dialogStateTail.catch(() => undefined).then(operation);
    this.dialogStateTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private queueMetadataWrite<T>(operation: () => Promise<T>) {
    const queued = this.metadataWriteTail.catch(() => undefined).then(operation);
    this.metadataWriteTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private isOperationCurrent(generation: number, accountId: string | undefined) {
    return this.isLifecycleCurrent(generation) && this.accountId === accountId;
  }

  private isPendingOperationCurrent(generation: number, accountId: string | undefined) {
    return (
      this.isLifecycleCurrent(generation) && (this.accountId ?? this.cachedAccountId) === accountId
    );
  }

  private isUpdateOperationCurrent(
    generation: number,
    operation?: { accountId: string | undefined },
  ) {
    return operation
      ? this.isOperationCurrent(generation, operation.accountId)
      : this.isLifecycleCurrent(generation);
  }

  private async invalidateEditedMedia(
    previous: TelegramMessage | undefined,
    next: TelegramMessage,
  ) {
    const legacyKey = `media:${next.peerId}:${next.id}`;
    const previousKey = previous ? this.mediaAssetKey(previous) : legacyKey;
    const nextKey = this.mediaAssetKey(next);
    if (previousKey === nextKey && previousKey !== legacyKey) return;
    const mediaSlot = `${next.peerId}:${next.id}`;
    const previewSlot = `preview:${mediaSlot}`;
    this.resources.invalidate(mediaSlot, `media:${previousKey}`, `media:${legacyKey}`);
    this.resources.invalidate(
      previewSlot,
      `media:preview:${previousKey}`,
      `media:preview:${legacyKey}`,
    );
    await Promise.all([
      this.store.deleteBlob(previousKey),
      this.store.deleteBlob(`preview:${previousKey}`),
      ...(previousKey === legacyKey ? [] : [this.store.deleteBlob(legacyKey)]),
      ...(previousKey === legacyKey ? [] : [this.store.deleteBlob(`preview:${legacyKey}`)]),
    ]);
  }

  private async connectWithDeadline(credentials: TelegramCredentials) {
    await this.disconnecting;
    const connection = this.transport.connect(credentials);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('Telegram WebSocket connection timed out after 15 seconds.')),
        15_000,
      );
    });
    try {
      await Promise.race([connection, timeout]);
    } catch (error) {
      void connection.catch(() => undefined);
      await this.disconnectTransport();
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private disconnectTransport() {
    if (this.disconnecting) return this.disconnecting;
    const disconnecting = this.transport.disconnect();
    this.disconnecting = disconnecting;
    const clear = () => {
      if (this.disconnecting === disconnecting) this.disconnecting = undefined;
    };
    void disconnecting.then(clear, clear);
    return disconnecting;
  }

  private randomId() {
    const bytes = crypto.getRandomValues(new Uint32Array(2));
    const wireValue = (BigInt(bytes[0] ?? 0) << 32n) | BigInt(bytes[1] ?? 0);
    return BigInt.asIntN(64, wireValue).toString();
  }

  private sortDialogs<T extends TelegramDialog>(dialogs: T[]) {
    return [...dialogs].sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return (right.topMessage?.date ?? 0) - (left.topMessage?.date ?? 0);
    });
  }

  private sortMessages<T extends TelegramMessage>(messages: T[]) {
    return [...messages].sort((left, right) => left.id - right.id);
  }
}
