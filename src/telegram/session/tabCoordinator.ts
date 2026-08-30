import { Conversation } from '../core/conversation';
import type { MessagingClient } from '../core/client';
import type { MessagingEngine } from '../core/engine';
import type {
  EngineSnapshot,
  TelegramCredentials,
  TelegramMessage,
  TelegramResourceInvalidation,
} from '../types';

const PROTOCOL_VERSION = 3;
const OWNER_HEARTBEAT_MS = 2_000;
const OWNER_TIMEOUT_MS = 7_000;
const MAX_COMPLETED_REQUESTS = 128;
const CHANNEL_ERROR = 'This browser cannot provide the channel required for safe multi-tab sync.';
const LOCKS_ERROR = 'This browser cannot provide the locking required for safe multi-tab sync.';
const LOCK_ACCESS_ERROR =
  'This browser could not access the locking required for safe multi-tab sync.';

type CoordinatorMessage =
  | { type: 'hello'; version: number; from: string }
  | { type: 'client-heartbeat'; version: number; from: string }
  | { type: 'owner'; version: number; from: string; at: number }
  | { type: 'owner-gone'; version: number; from: string }
  | { type: 'client-gone'; version: number; from: string }
  | {
      type: 'state';
      version: number;
      from: string;
      to: string;
      snapshot: EngineSnapshot;
      pendingPayloadIds: string[];
    }
  | {
      type: 'resource';
      version: number;
      from: string;
      event: TelegramResourceInvalidation;
    }
  | {
      type: 'request';
      version: number;
      from: string;
      id: string;
      method: string;
      args: unknown[];
      activePeerId?: string | undefined;
    }
  | {
      type: 'response';
      version: number;
      from: string;
      to: string;
      id: string;
      result?: unknown;
      error?: string;
    }
  | { type: 'version-mismatch'; version: number; from: string; to: string };

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface VisibilityReport {
  peerId: string;
  visible: boolean;
  atBottom: boolean;
}

export interface TabCoordinatorOwner {
  engine: MessagingEngine;
  transport?: unknown;
}

export interface TabCoordinatorOptions {
  key: string;
  createOwner(): TabCoordinatorOwner;
  loadBlob(key: string): Promise<Blob | undefined>;
  hydrateSnapshot?(
    snapshot: EngineSnapshot,
    pendingPayloadIds: readonly string[],
  ): Promise<EngineSnapshot>;
  ownerChanged?(owner: TabCoordinatorOwner | undefined): void;
}

function emptySnapshot(): EngineSnapshot {
  return {
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
}

const chatScopedMethods = new Set([
  'ensureSharedMediaCounts',
  'getSharedMedia',
  'loadHistoryGap',
  'loadOlderMessages',
  'openMessage',
  'refreshReadReceipt',
  'retryHistory',
  'searchMessages',
]);

const viewMutationMethods = new Set([
  'deleteMessage',
  'editMessage',
  'forwardMessage',
  'sendAttachments',
  'sendDraft',
  'sendSticker',
  'setPinnedMessage',
  'toggleReaction',
]);

// These operations must not wait behind a slow network mutation. In particular,
// a draft typed while an edit is saving must become canonical promptly, and a
// newer chat selection must be able to supersede a slow message jump. Ordinary
// conversation opens stay serialized so failover restoration cannot race a send.
const concurrentMethods = new Set([
  'getBotCommands',
  'getChatAppearance',
  'getGroupMembers',
  'getRecentStickers',
  'getSavedGifs',
  'getStickerPacks',
  'getUserDetails',
  'openMessage',
  'searchPeers',
  'setDraft',
  'setTyping',
]);

const coalescedMethods = new Set([
  'ensureSharedMediaCounts',
  'getBotCommands',
  'getChatAppearance',
  'getGroupMembers',
  'getUserDetails',
  'refreshReadReceipt',
  'refreshUpdates',
  'retryOutbox',
]);

function sharedSnapshot(previous: EngineSnapshot, next: EngineSnapshot): EngineSnapshot {
  if (
    previous.phase === next.phase &&
    previous.sync === next.sync &&
    previous.online === next.online &&
    previous.dialogs === next.dialogs &&
    previous.drafts === next.drafts &&
    previous.pending === next.pending &&
    previous.activities === next.activities &&
    previous.authStep === next.authStep &&
    previous.codeViaApp === next.codeViaApp &&
    previous.operationError === next.operationError &&
    previous.error === next.error
  ) {
    return previous;
  }
  return {
    ...previous,
    phase: next.phase,
    sync: next.sync,
    online: next.online,
    dialogs: next.dialogs,
    drafts: next.drafts,
    pending: next.pending,
    activities: next.activities,
    authStep: next.authStep,
    codeViaApp: next.codeViaApp,
    operationError: next.operationError,
    error: next.error,
  };
}

function inactiveConversationSnapshot(
  previous: EngineSnapshot,
  next: EngineSnapshot,
): EngineSnapshot {
  const shared = sharedSnapshot(previous, next);
  const peerId = previous.activePeerId;
  if (!peerId) return shared;
  const topMessage = next.dialogs.find(({ peer }) => peer.id === peerId)?.topMessage;
  if (!topMessage) return shared;
  const known = previous.messages.some(
    (message) => message.peerId === peerId && String(message.id) === String(topMessage.id),
  );
  const messages = known
    ? previous.messages.map((message) =>
        message.peerId === peerId && String(message.id) === String(topMessage.id)
          ? topMessage
          : message,
      )
    : [...previous.messages, topMessage];
  return { ...shared, messages };
}

function transferableSnapshot(snapshot: EngineSnapshot): EngineSnapshot {
  return {
    ...snapshot,
    pending: snapshot.pending.map(
      ({ attachment: _attachment, album: _album, ...pending }) => pending,
    ),
  };
}

function pendingPayloadIds(snapshot: EngineSnapshot) {
  return snapshot.pending
    .filter((pending) => pending.attachment || pending.album)
    .map((pending) => pending.id);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns tab election, RPC, failover, and per-tab view snapshots behind one small
 * messaging interface. Only the elected owner constructs a MessagingEngine.
 */
export class TabCoordinator {
  readonly client: MessagingClient;

  private readonly clientId = crypto.randomUUID();
  private readonly channel: BroadcastChannel | undefined;
  private readonly listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private readonly resourceListeners = new Set<(event: TelegramResourceInvalidation) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly coalescedOperations = new Map<string, Promise<unknown>>();
  private readonly activeRequests = new Set<string>();
  private readonly completedRequests = new Map<string, { result?: unknown; error?: string }>();
  private readonly queuedStateClients = new Set<string>();
  private readonly clientSnapshots = new Map<string, EngineSnapshot>();
  private readonly clientActivePeers = new Map<string, string>();
  private readonly visibility = new Map<string, VisibilityReport>();
  private readonly clientSeenAt = new Map<string, number>();
  private snapshotValue = emptySnapshot();
  private owner: TabCoordinatorOwner | undefined;
  private credentials: TelegramCredentials | undefined;
  private ownerId: string | undefined;
  private ownerSeenAt = 0;
  private stateRevision = 0;
  private versionMismatch = false;
  private coordinationError: string | undefined;
  private ownerUnsubscribe: (() => void) | undefined;
  private resourceUnsubscribe: (() => void) | undefined;
  private ownerStarting: Promise<void> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private releaseOwnerLock: (() => void) | undefined;
  private electionPending = false;
  private stopped = false;
  private operationTail = Promise.resolve();
  private stateFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastVisibilityKey = '';
  private readonly handlePageHide = () => this.announceClosing();

  constructor(private readonly options: TabCoordinatorOptions) {
    let channel: BroadcastChannel | undefined;
    try {
      channel =
        typeof BroadcastChannel === 'undefined'
          ? undefined
          : new BroadcastChannel(`televecha:${options.key}`);
    } catch {
      channel = undefined;
    }
    this.channel = channel;
    this.channel?.addEventListener('message', (event: MessageEvent<CoordinatorMessage>) => {
      this.receive(event.data);
    });
    if (!this.channel) {
      this.coordinationError = CHANNEL_ERROR;
      this.snapshotValue = {
        ...this.snapshotValue,
        phase: 'error',
        online: false,
        error: CHANNEL_ERROR,
      };
    }
    window.addEventListener('pagehide', this.handlePageHide);
    const target = {
      snapshot: () => this.snapshotValue,
      subscribe: (listener: (snapshot: EngineSnapshot) => void) => this.subscribe(listener),
      subscribeResources: (listener: (event: TelegramResourceInvalidation) => void) =>
        this.subscribeResources(listener),
      start: (credentials: TelegramCredentials) => this.start(credentials),
      stop: () => this.stop(),
      openConversation: (peerId: string) => this.openConversation(peerId),
      clearOperationError: () => {
        void this.invoke('clearOperationError', []).catch(() => undefined);
      },
      setActiveConversationVisibility: (
        peerId: string | undefined,
        state: { visible: boolean; atBottom: boolean },
      ) => {
        const key = JSON.stringify([peerId, state]);
        if (key === this.lastVisibilityKey) return Promise.resolve();
        this.lastVisibilityKey = key;
        return this.invokeCoalesced('setActiveConversationVisibility', [peerId, state]).catch(
          (error) => {
            if (this.lastVisibilityKey === key) this.lastVisibilityKey = '';
            throw error;
          },
        );
      },
      mediaAssetKey: (message: TelegramMessage) => this.mediaAssetKey(message),
      loadCachedAvatar: (peer: { id: string }, avatarId?: string) =>
        this.options.loadBlob(`avatar:${peer.id}:${avatarId ?? 'unknown'}`),
      downloadAvatar: async (peer: { id: string }, avatarId?: string) => {
        const key = `avatar:${peer.id}:${avatarId ?? 'unknown'}`;
        const cached = await this.options.loadBlob(key);
        if (cached) return cached;
        const downloaded = await this.invokeCoalesced('downloadAvatar', [peer, avatarId]);
        if (downloaded instanceof Blob) return downloaded;
        return this.options.loadBlob(key);
      },
      downloadMedia: async (message: TelegramMessage) => {
        const key = this.mediaAssetKey(message);
        const cached = await this.options.loadBlob(key);
        if (cached) return cached;
        const downloaded = await this.invokeCoalesced('downloadMedia', [message]);
        if (downloaded instanceof Blob) return downloaded;
        const blob = await this.options.loadBlob(key);
        if (!blob) throw new Error('The downloaded media was not committed to the shared cache.');
        return blob;
      },
      downloadSticker: async (sticker: { id: string }) => {
        const key = `sticker:${sticker.id}`;
        const cached = await this.options.loadBlob(key);
        if (cached) return cached;
        const downloaded = await this.invokeCoalesced('downloadSticker', [sticker]);
        if (downloaded instanceof Blob) return downloaded;
        const blob = await this.options.loadBlob(key);
        if (!blob) throw new Error('The downloaded sticker was not committed to the shared cache.');
        return blob;
      },
      downloadCustomEmoji: async (documentId: string) => {
        const key = `custom-emoji:${documentId}`;
        const cached = await this.options.loadBlob(key);
        if (cached) return cached;
        const downloaded = await this.invokeCoalesced('downloadCustomEmoji', [documentId]);
        if (downloaded instanceof Blob) return downloaded;
        const blob = await this.options.loadBlob(key);
        if (!blob) throw new Error('The custom emoji was not committed to the shared cache.');
        return blob;
      },
      downloadWallpaper: async (wallpaperId: string) => {
        const key = `wallpaper:${wallpaperId}`;
        const cached = await this.options.loadBlob(key);
        if (cached) return cached;
        const downloaded = await this.invokeCoalesced('downloadWallpaper', [wallpaperId]);
        if (downloaded instanceof Blob) return downloaded;
        const blob = await this.options.loadBlob(key);
        if (!blob) throw new Error('The wallpaper was not committed to the shared cache.');
        return blob;
      },
    };
    this.client = new Proxy(target, {
      get: (source, property) => {
        if (property in source) {
          const value = Reflect.get(source, property);
          return typeof value === 'function' ? value.bind(source) : value;
        }
        if (typeof property !== 'string') return undefined;
        return (...args: unknown[]) =>
          coalescedMethods.has(property)
            ? this.invokeCoalesced(property, args)
            : this.invoke(property, args);
      },
    }) as unknown as MessagingClient;
  }

  private post(message: CoordinatorMessage) {
    if (!this.stopped) this.channel?.postMessage(message);
  }

  private announceOwner() {
    this.ownerSeenAt = Date.now();
    this.post({
      type: 'owner',
      version: PROTOCOL_VERSION,
      from: this.clientId,
      at: this.ownerSeenAt,
    });
  }

  private announceClosing() {
    if (this.stopped) return;
    this.post({
      type: this.owner ? 'owner-gone' : 'client-gone',
      version: PROTOCOL_VERSION,
      from: this.clientId,
    });
  }

  private receive(message: CoordinatorMessage) {
    if (!message || message.from === this.clientId || this.versionMismatch) return;
    if (message.version !== PROTOCOL_VERSION) {
      if (message.type === 'version-mismatch' && message.to === this.clientId) {
        this.showVersionMismatch();
      } else if ('from' in message) {
        this.post({
          type: 'version-mismatch',
          version: PROTOCOL_VERSION,
          from: this.clientId,
          to: message.from,
        });
      }
      return;
    }
    switch (message.type) {
      case 'hello':
        if (this.owner) {
          this.clientSeenAt.set(message.from, Date.now());
          this.clientSnapshots.set(
            message.from,
            sharedSnapshot(emptySnapshot(), this.owner.engine.snapshot()),
          );
          this.announceOwner();
          this.sendState(message.from);
        }
        break;
      case 'client-heartbeat':
        if (this.owner) this.clientSeenAt.set(message.from, Date.now());
        break;
      case 'owner':
        if (!this.owner) {
          const ownerChanged = this.ownerId !== message.from;
          this.ownerId = message.from;
          this.ownerSeenAt = Date.now();
          if (ownerChanged) {
            this.post({
              type: 'hello',
              version: PROTOCOL_VERSION,
              from: this.clientId,
            });
            const activePeerId = this.snapshotValue.activePeerId;
            if (activePeerId) {
              void this.invokeCoalesced('openConversation', [activePeerId]).catch(() => undefined);
            }
          }
        }
        break;
      case 'owner-gone':
        if (this.ownerId === message.from) {
          this.stateRevision += 1;
          this.ownerId = undefined;
          this.rejectPending(new Error('The active TeleVecha tab closed during the command.'));
          this.markReconnecting();
          void this.electOwner();
        }
        break;
      case 'client-gone':
        if (this.owner) this.removeClient(message.from);
        break;
      case 'state':
        if (message.to === this.clientId && message.from === this.ownerId) {
          const revision = ++this.stateRevision;
          const ownerId = this.ownerId;
          const incoming =
            !message.snapshot.activePeerId && this.snapshotValue.activePeerId
              ? sharedSnapshot(this.snapshotValue, message.snapshot)
              : message.snapshot;
          const hydration = this.options.hydrateSnapshot?.(
            incoming,
            message.pendingPayloadIds ?? [],
          );
          if (hydration)
            void hydration
              .then((snapshot) => {
                if (
                  revision === this.stateRevision &&
                  ownerId === this.ownerId &&
                  !this.owner &&
                  !this.versionMismatch
                ) {
                  this.setSnapshot(snapshot);
                }
              })
              .catch(() => {
                if (
                  revision === this.stateRevision &&
                  ownerId === this.ownerId &&
                  !this.owner &&
                  !this.versionMismatch
                ) {
                  this.setSnapshot(incoming);
                }
              });
          else this.setSnapshot(incoming);
        }
        break;
      case 'resource':
        if (message.from === this.ownerId) {
          for (const listener of this.resourceListeners) listener(message.event);
        }
        break;
      case 'request':
        if (this.owner) {
          this.clientSeenAt.set(message.from, Date.now());
          if (message.method === 'openConversation') {
            this.clientActivePeers.set(message.from, String(message.args[0]));
          }
          this.queueRequest(message);
        }
        break;
      case 'response': {
        if (message.to !== this.clientId || message.from !== this.ownerId) break;
        const pending = this.pending.get(message.id);
        if (!pending) break;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        break;
      }
      case 'version-mismatch':
        if (message.to === this.clientId) this.showVersionMismatch();
        break;
    }
  }

  private showVersionMismatch() {
    this.versionMismatch = true;
    this.stateRevision += 1;
    this.setSnapshot({
      ...this.snapshotValue,
      phase: 'error',
      sync: 'stale',
      online: false,
      error: 'Reload to finish updating TeleVecha.',
      requiresReload: true,
    });
  }

  private subscribe(listener: (snapshot: EngineSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshotValue);
    return () => this.listeners.delete(listener);
  }

  private subscribeResources(listener: (event: TelegramResourceInvalidation) => void) {
    this.resourceListeners.add(listener);
    return () => this.resourceListeners.delete(listener);
  }

  private setSnapshot(snapshot: EngineSnapshot) {
    this.snapshotValue = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private markReconnecting() {
    if (this.versionMismatch) return;
    this.setSnapshot({
      ...this.snapshotValue,
      phase: this.snapshotValue.dialogs.length > 0 ? 'ready' : 'connecting',
      sync: 'recovering',
      online: false,
      error: undefined,
    });
  }

  async start(credentials: TelegramCredentials) {
    this.credentials = credentials;
    if (!this.channel) return;
    if (this.monitor) return;
    this.stopped = false;
    this.monitor = setInterval(() => {
      if (this.owner) {
        this.clientSeenAt.set(this.clientId, Date.now());
        const cutoff = Date.now() - OWNER_TIMEOUT_MS;
        for (const [clientId, seenAt] of this.clientSeenAt) {
          if (clientId === this.clientId || seenAt >= cutoff) continue;
          this.removeClient(clientId);
        }
        return;
      }
      if (this.ownerId) {
        this.post({
          type: 'client-heartbeat',
          version: PROTOCOL_VERSION,
          from: this.clientId,
        });
      }
      if (this.electionPending) return;
      if (!this.ownerId) {
        this.ownerId = undefined;
        this.markReconnecting();
        void this.electOwner();
      } else if (Date.now() - this.ownerSeenAt > OWNER_TIMEOUT_MS) {
        // A suspended tab delays both heartbeat timers. Ask Web Locks who owns
        // the lease before changing visible connection state.
        void this.electOwner();
      }
    }, OWNER_HEARTBEAT_MS);
    await this.electOwner();
    if (!this.owner) {
      this.post({
        type: 'hello',
        version: PROTOCOL_VERSION,
        from: this.clientId,
      });
    }
  }

  private async electOwner() {
    if (this.electionPending || this.owner || this.stopped) return;
    if (!navigator.locks) {
      this.coordinationError = LOCKS_ERROR;
      this.setSnapshot({
        ...this.snapshotValue,
        phase: 'error',
        online: false,
        error: LOCKS_ERROR,
      });
      return;
    }
    this.coordinationError = undefined;
    this.electionPending = true;
    let settle!: (acquired: boolean | 'failed') => void;
    const acquired = new Promise<boolean | 'failed'>((resolve) => {
      settle = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      void navigator.locks
        .request(
          `televecha-owner:${this.options.key}`,
          { ifAvailable: true, mode: 'exclusive' },
          async (lock) => {
            if (!lock) {
              settle(false);
              return;
            }
            this.releaseOwnerLock = release;
            settle(true);
            await held;
          },
        )
        .catch(() => settle('failed'));
    } catch {
      settle('failed');
    }
    const won = await acquired;
    this.electionPending = false;
    if (this.stopped) {
      if (won === true) {
        const releaseOwnerLock = this.releaseOwnerLock;
        this.releaseOwnerLock = undefined;
        releaseOwnerLock?.();
      }
      return;
    }
    if (won === 'failed') {
      this.coordinationError = LOCK_ACCESS_ERROR;
      this.setSnapshot({
        ...this.snapshotValue,
        phase: 'error',
        online: false,
        error: LOCK_ACCESS_ERROR,
      });
    } else if (won && !this.stopped) {
      try {
        await this.becomeOwner();
      } catch (error) {
        await this.abandonFailedOwnership(error);
      }
    } else if (!won) {
      this.post({
        type: 'hello',
        version: PROTOCOL_VERSION,
        from: this.clientId,
      });
    }
  }

  private async becomeOwner() {
    const credentials = this.credentials;
    if (!credentials) return;
    this.ownerId = this.clientId;
    this.stateRevision += 1;
    this.clientSeenAt.set(this.clientId, Date.now());
    const owner = this.options.createOwner();
    this.owner = owner;
    this.options.ownerChanged?.(owner);
    this.clientSnapshots.set(this.clientId, this.snapshotValue);
    this.ownerUnsubscribe = owner.engine.subscribe((snapshot) => this.publishSnapshot(snapshot));
    this.resourceUnsubscribe = owner.engine.subscribeResources((event) => {
      for (const listener of this.resourceListeners) listener(event);
      this.post({
        type: 'resource',
        version: PROTOCOL_VERSION,
        from: this.clientId,
        event,
      });
    });
    const starting = owner.engine.start(credentials);
    this.ownerStarting = starting;
    this.heartbeat = setInterval(() => this.announceOwner(), OWNER_HEARTBEAT_MS);
    this.announceOwner();
    try {
      await starting;
    } finally {
      if (this.ownerStarting === starting) this.ownerStarting = undefined;
    }
  }

  private async abandonFailedOwnership(error: unknown) {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.ownerUnsubscribe?.();
    this.resourceUnsubscribe?.();
    this.ownerUnsubscribe = undefined;
    this.resourceUnsubscribe = undefined;
    const owner = this.owner;
    this.owner = undefined;
    this.ownerStarting = undefined;
    this.ownerId = undefined;
    try {
      await owner?.engine.stop();
    } catch {
      // The startup error is the actionable failure; shutdown is best effort here.
    }
    const releaseOwnerLock = this.releaseOwnerLock;
    this.releaseOwnerLock = undefined;
    releaseOwnerLock?.();
    try {
      if (owner) this.options.ownerChanged?.(undefined);
    } catch {
      // A view hook must not keep the cross-tab ownership lock alive.
    }
    this.setSnapshot({
      ...this.snapshotValue,
      phase: 'error',
      sync: 'stale',
      online: false,
      error: `Could not start the active TeleVecha tab. ${errorMessage(error)}`,
    });
  }

  private publishSnapshot(snapshot: EngineSnapshot) {
    if (!this.owner) return;
    if (!this.clientSnapshots.has(this.clientId)) {
      this.clientSnapshots.set(this.clientId, emptySnapshot());
    }
    for (const [clientId, previous] of this.clientSnapshots) {
      const activePeerId = previous.activePeerId;
      const ownsActiveView = Boolean(activePeerId) && activePeerId === snapshot.activePeerId;
      const next =
        ownsActiveView || (clientId === this.clientId && previous.activePeerId === undefined)
          ? snapshot
          : inactiveConversationSnapshot(previous, snapshot);
      if (next === previous) continue;
      this.clientSnapshots.set(clientId, next);
      if (clientId === this.clientId) this.setSnapshot(next);
      else this.queueState(clientId);
    }
    for (const { peerId } of this.visibility.values()) void this.applyVisibility(peerId);
  }

  private sendState(clientId: string) {
    const snapshot = this.clientSnapshots.get(clientId);
    if (!snapshot) return;
    this.post({
      type: 'state',
      version: PROTOCOL_VERSION,
      from: this.clientId,
      to: clientId,
      snapshot: transferableSnapshot(snapshot),
      pendingPayloadIds: pendingPayloadIds(snapshot),
    });
  }

  private queueState(clientId: string) {
    this.queuedStateClients.add(clientId);
    if (this.stateFlushTimer) return;
    this.stateFlushTimer = setTimeout(() => {
      this.stateFlushTimer = undefined;
      const clients = [...this.queuedStateClients];
      this.queuedStateClients.clear();
      for (const queuedClientId of clients) this.sendState(queuedClientId);
    }, 16);
  }

  private queueRequest(request: Extract<CoordinatorMessage, { type: 'request' }>) {
    const requestKey = `${request.from}:${request.id}`;
    const completed = this.completedRequests.get(requestKey);
    if (completed) {
      this.post({
        type: 'response',
        version: PROTOCOL_VERSION,
        from: this.clientId,
        to: request.from,
        id: request.id,
        ...completed,
      });
      return;
    }
    if (this.activeRequests.has(requestKey)) return;
    this.activeRequests.add(requestKey);
    if (concurrentMethods.has(request.method)) {
      void this.handleRequest(request, requestKey).finally(() =>
        this.activeRequests.delete(requestKey),
      );
      return;
    }
    const work = this.operationTail.then(() => this.handleRequest(request, requestKey));
    const tracked = work.finally(() => this.activeRequests.delete(requestKey));
    this.operationTail = tracked.then(
      () => undefined,
      () => undefined,
    );
  }

  private async handleRequest(
    request: Extract<CoordinatorMessage, { type: 'request' }>,
    requestKey: string,
  ) {
    try {
      const result = await this.invokeOwner(
        request.from,
        request.method,
        request.args,
        request.activePeerId,
      );
      this.rememberCompletedRequest(requestKey, { result });
      this.post({
        type: 'response',
        version: PROTOCOL_VERSION,
        from: this.clientId,
        to: request.from,
        id: request.id,
        result,
      });
    } catch (error) {
      const completed = { error: errorMessage(error) };
      this.rememberCompletedRequest(requestKey, completed);
      this.post({
        type: 'response',
        version: PROTOCOL_VERSION,
        from: this.clientId,
        to: request.from,
        id: request.id,
        ...completed,
      });
    }
  }

  private rememberCompletedRequest(id: string, result: { result?: unknown; error?: string }) {
    this.completedRequests.set(id, result);
    if (this.completedRequests.size <= MAX_COMPLETED_REQUESTS) return;
    const oldest = this.completedRequests.keys().next().value;
    if (oldest) this.completedRequests.delete(oldest);
  }

  private removeClient(clientId: string) {
    const peerId = this.visibility.get(clientId)?.peerId;
    this.clientSeenAt.delete(clientId);
    this.visibility.delete(clientId);
    this.clientSnapshots.delete(clientId);
    this.clientActivePeers.delete(clientId);
    if (peerId) void this.applyVisibility(peerId);
  }

  private async ensureOwnerPeer(clientId: string, peerId: string | undefined) {
    const engine = this.owner?.engine;
    if (!engine || !peerId) return false;
    const desiredPeerId = this.clientActivePeers.get(clientId);
    if (desiredPeerId && desiredPeerId !== peerId) {
      return false;
    }
    if (engine.snapshot().activePeerId === peerId) return true;
    await engine.openConversation(peerId, false);
    await this.applyVisibility(peerId);
    return true;
  }

  private async invokeOwner(
    clientId: string,
    method: string,
    args: unknown[],
    activePeerId?: string,
  ) {
    await this.ownerStarting;
    const engine = this.owner?.engine;
    if (!engine) throw new Error('TeleVecha is reconnecting in another tab.');
    if (method === 'openConversation') {
      const peerId = String(args[0]);
      this.clientActivePeers.set(clientId, peerId);
      await engine.openConversation(peerId, false);
      this.clientSnapshots.set(clientId, engine.snapshot());
      this.sendState(clientId);
      if (clientId === this.clientId) this.setSnapshot(engine.snapshot());
      await this.applyVisibility(peerId);
      return true;
    }
    if (method === 'setActiveConversationVisibility') {
      const peerId = String(args[0]);
      const state = args[1] as { visible: boolean; atBottom: boolean };
      this.clientSeenAt.set(clientId, Date.now());
      this.visibility.set(clientId, { peerId, ...state });
      await this.applyVisibility(peerId);
      return;
    }
    if (chatScopedMethods.has(method) || viewMutationMethods.has(method)) {
      if (!(await this.ensureOwnerPeer(clientId, activePeerId))) return;
    }
    const member = (engine as unknown as Record<string, unknown>)[method];
    if (typeof member !== 'function') throw new Error(`Unknown messaging command: ${method}`);
    const result = await (member as (...parameters: unknown[]) => unknown).apply(engine, args);
    const next = engine.snapshot();
    const previous = this.clientSnapshots.get(clientId) ?? emptySnapshot();
    this.clientSnapshots.set(
      clientId,
      next.activePeerId === activePeerId ? next : sharedSnapshot(previous, next),
    );
    if (clientId === this.clientId) this.setSnapshot(this.clientSnapshots.get(clientId)!);
    else this.sendState(clientId);
    return result;
  }

  private async applyVisibility(peerId: string) {
    const engine = this.owner?.engine;
    if (!engine) return;
    const cutoff = Date.now() - OWNER_TIMEOUT_MS;
    const reports = [...this.visibility.entries()]
      .filter(([clientId]) => (this.clientSeenAt.get(clientId) ?? 0) >= cutoff)
      .map(([, report]) => report)
      .filter((report) => report.peerId === peerId);
    const visible = reports.some((report) => report.visible);
    const atBottom = reports.some((report) => report.visible && report.atBottom);
    if (engine.snapshot().activePeerId === peerId) {
      await engine.setActiveConversationVisibility(peerId, { visible, atBottom });
    } else if (visible && atBottom) {
      await engine.markConversationRead(peerId);
    }
  }

  private invoke(method: string, args: unknown[]) {
    if (this.stopped) return Promise.reject(new Error('This tab is no longer connected.'));
    if (this.versionMismatch) {
      return Promise.reject(new Error('Reload to finish updating TeleVecha.'));
    }
    if (this.coordinationError) return Promise.reject(new Error(this.coordinationError));
    if (method === 'openConversation') {
      this.clientActivePeers.set(this.clientId, String(args[0]));
    }
    const activePeerId = this.snapshotValue.activePeerId;
    if (this.owner) {
      if (concurrentMethods.has(method)) {
        return this.invokeOwner(this.clientId, method, args, activePeerId);
      }
      const operation = this.operationTail.then(() =>
        this.invokeOwner(this.clientId, method, args, activePeerId),
      );
      this.operationTail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    }
    if (!this.ownerId) {
      this.markReconnecting();
      void this.electOwner();
    } else if (Date.now() - this.ownerSeenAt > OWNER_TIMEOUT_MS) {
      void this.electOwner();
    }
    const id = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({
        type: 'request',
        version: PROTOCOL_VERSION,
        from: this.clientId,
        id,
        method,
        args,
        activePeerId,
      });
    });
  }

  private invokeCoalesced(method: string, args: unknown[]) {
    const key = `${method}:${JSON.stringify(args)}`;
    const current = this.coalescedOperations.get(key);
    if (current) return current;
    const operation = this.invoke(method, args).finally(() => {
      if (this.coalescedOperations.get(key) === operation) this.coalescedOperations.delete(key);
    });
    this.coalescedOperations.set(key, operation);
    return operation;
  }

  private rejectPending(error: Error) {
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
  }

  private async openConversation(peerId: string) {
    await this.invokeCoalesced('openConversation', [peerId]);
    return new Conversation(this.client, peerId);
  }

  private mediaAssetKey(message: TelegramMessage) {
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

  async stop() {
    if (this.stopped) return;
    this.announceClosing();
    this.stopped = true;
    window.removeEventListener('pagehide', this.handlePageHide);
    if (this.monitor) clearInterval(this.monitor);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.stateFlushTimer) clearTimeout(this.stateFlushTimer);
    this.monitor = undefined;
    this.heartbeat = undefined;
    this.stateFlushTimer = undefined;
    this.queuedStateClients.clear();
    this.clientActivePeers.clear();
    this.rejectPending(new Error('This tab closed before the command completed.'));
    this.coalescedOperations.clear();
    this.activeRequests.clear();
    this.completedRequests.clear();
    try {
      if (this.owner) {
        this.ownerUnsubscribe?.();
        this.resourceUnsubscribe?.();
        try {
          await this.owner.engine.stop();
        } finally {
          this.owner = undefined;
          this.ownerStarting = undefined;
          const releaseOwnerLock = this.releaseOwnerLock;
          this.releaseOwnerLock = undefined;
          releaseOwnerLock?.();
          this.options.ownerChanged?.(undefined);
        }
      }
    } finally {
      this.channel?.close();
    }
  }
}
