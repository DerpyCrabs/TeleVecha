import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MessagingEngine } from '../core/engine';
import type { EngineSnapshot } from '../types';
import { TabCoordinator } from './tabCoordinator';

class FakeBroadcastChannel {
  readonly sent: unknown[] = [];
  closed = false;

  addEventListener() {}

  postMessage(message: unknown) {
    this.sent.push(message);
  }

  close() {
    this.closed = true;
  }
}

interface CoordinatorInternals {
  clientId: string;
  channel?: FakeBroadcastChannel;
  owner?: { engine: unknown };
  releaseOwnerLock?: () => void;
  clientSnapshots: Map<string, EngineSnapshot>;
  publishSnapshot(snapshot: EngineSnapshot): void;
  receive(message: unknown): void;
}

function snapshot(error?: string): EngineSnapshot {
  return {
    phase: 'ready',
    sync: 'current',
    online: true,
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
    error,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function installBrowserFakes() {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

function coordinator(hydrateSnapshot?: (value: EngineSnapshot) => Promise<EngineSnapshot>) {
  return new TabCoordinator({
    key: 'test',
    createOwner() {
      throw new Error('The test coordinator must remain a follower.');
    },
    loadBlob: () => Promise.resolve(undefined),
    ...(hydrateSnapshot ? { hydrateSnapshot } : {}),
  });
}

function ownerEngine(overrides: Record<string, unknown> = {}, value: EngineSnapshot = snapshot()) {
  return {
    snapshot: () => value,
    subscribe: (listener: (next: EngineSnapshot) => void) => {
      listener(value);
      return vi.fn();
    },
    subscribeResources: () => vi.fn(),
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    ...overrides,
  } as unknown as MessagingEngine;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TabCoordinator', () => {
  it('reports a compatibility error when BroadcastChannel is unavailable', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const target = coordinator();

    expect(target.client.snapshot()).toMatchObject({
      phase: 'error',
      online: false,
      error: 'This browser cannot provide the channel required for safe multi-tab sync.',
    });
    await target.start({ apiId: 1, apiHash: 'test' });
    expect(target.client.snapshot().phase).toBe('error');
    await expect(target.client.refreshUpdates()).rejects.toThrow(
      'This browser cannot provide the channel required for safe multi-tab sync.',
    );
    await target.stop();
  });

  it('reports a compatibility error when opening BroadcastChannel is denied', async () => {
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          throw new Error('denied');
        }
      },
    );
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const target = coordinator();

    expect(target.client.snapshot()).toMatchObject({
      phase: 'error',
      online: false,
      error: 'This browser cannot provide the channel required for safe multi-tab sync.',
    });
    await target.stop();
  });

  it('reports a compatibility error when Web Locks are unavailable', async () => {
    installBrowserFakes();
    vi.stubGlobal('navigator', {});
    const target = coordinator();

    await target.start({ apiId: 1, apiHash: 'test' });

    expect(target.client.snapshot()).toMatchObject({
      phase: 'error',
      online: false,
      error: 'This browser cannot provide the locking required for safe multi-tab sync.',
    });
    await expect(target.client.refreshUpdates()).rejects.toThrow(
      'This browser cannot provide the locking required for safe multi-tab sync.',
    );
    await target.stop();
  });

  it('reports a compatibility error when requesting a Web Lock fails', async () => {
    installBrowserFakes();
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(() => {
          throw new Error('denied');
        }),
      },
    });
    const target = coordinator();

    await target.start({ apiId: 1, apiHash: 'test' });

    expect(target.client.snapshot()).toMatchObject({
      phase: 'error',
      online: false,
      error: 'This browser could not access the locking required for safe multi-tab sync.',
    });
    await expect(target.client.refreshUpdates()).rejects.toThrow(
      'This browser could not access the locking required for safe multi-tab sync.',
    );
    await target.stop();
  });

  it('keeps a protocol mismatch sticky and rejects further commands', async () => {
    installBrowserFakes();
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;

    internals.receive({
      type: 'version-mismatch',
      version: 999,
      from: 'future-owner',
      to: internals.clientId,
    });

    expect(target.client.snapshot()).toMatchObject({
      phase: 'error',
      online: false,
      requiresReload: true,
      error: 'Reload to finish updating TeleVecha.',
    });
    await expect(target.client.refreshUpdates()).rejects.toThrow(
      'Reload to finish updating TeleVecha.',
    );

    internals.receive({
      type: 'owner',
      version: 3,
      from: 'replacement-owner',
      at: Date.now(),
    });
    expect(target.client.snapshot().requiresReload).toBe(true);
    await target.stop();
  });

  it('does not let slow snapshot hydration overwrite newer owner state', async () => {
    installBrowserFakes();
    const first = deferred<EngineSnapshot>();
    const second = deferred<EngineSnapshot>();
    const target = coordinator((value) =>
      value.error === 'first' ? first.promise : second.promise,
    );
    const internals = target as unknown as CoordinatorInternals;

    internals.receive({
      type: 'owner',
      version: 3,
      from: 'owner',
      at: Date.now(),
    });
    internals.receive({
      type: 'state',
      version: 3,
      from: 'owner',
      to: internals.clientId,
      snapshot: snapshot('first'),
    });
    internals.receive({
      type: 'state',
      version: 3,
      from: 'owner',
      to: internals.clientId,
      snapshot: snapshot('second'),
    });

    second.resolve(snapshot('second'));
    await second.promise;
    await Promise.resolve();
    expect(target.client.snapshot().error).toBe('second');

    first.resolve(snapshot('first'));
    await first.promise;
    await Promise.resolve();
    expect(target.client.snapshot().error).toBe('second');
    await target.stop();
  });

  it('uses the raw owner snapshot when hydration fails', async () => {
    installBrowserFakes();
    const target = coordinator(() => Promise.reject(new Error('broken cached blob')));
    const internals = target as unknown as CoordinatorInternals;

    internals.receive({
      type: 'owner',
      version: 3,
      from: 'owner',
      at: Date.now(),
    });
    internals.receive({
      type: 'state',
      version: 3,
      from: 'owner',
      to: internals.clientId,
      snapshot: snapshot('raw snapshot'),
    });

    await vi.waitFor(() => expect(target.client.snapshot().error).toBe('raw snapshot'));
    await target.stop();
  });

  it('rejects an in-flight follower command as soon as its owner closes', async () => {
    installBrowserFakes();
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(
          async (
            _name: string,
            _options: unknown,
            callback: (lock: undefined) => Promise<void> | void,
          ) => callback(undefined),
        ),
      },
    });
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    internals.receive({
      type: 'owner',
      version: 3,
      from: 'owner',
      at: Date.now(),
    });

    const command = target.client.refreshUpdates();
    const rejection = expect(command).rejects.toThrow(
      'The active TeleVecha tab closed during the command.',
    );
    internals.receive({ type: 'owner-gone', version: 3, from: 'owner' });

    await rejection;
    await target.stop();
  });

  it('announces a follower once when it observes a new owner', async () => {
    installBrowserFakes();
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;

    internals.receive({ type: 'owner', version: 3, from: 'owner', at: Date.now() });
    internals.receive({ type: 'owner', version: 3, from: 'owner', at: Date.now() });

    expect(
      internals.channel?.sent.filter((message) => (message as { type?: string }).type === 'hello'),
    ).toHaveLength(1);
    internals.receive({
      type: 'state',
      version: 3,
      from: 'owner',
      to: internals.clientId,
      snapshot: { ...snapshot(), activePeerId: 'peer-1' },
    });
    internals.receive({
      type: 'owner',
      version: 3,
      from: 'replacement-owner',
      at: Date.now(),
    });
    expect(
      internals.channel?.sent.filter((message) => (message as { type?: string }).type === 'hello'),
    ).toHaveLength(2);
    expect(
      internals.channel?.sent.some(
        (message) =>
          (message as { type?: string; method?: string }).type === 'request' &&
          (message as { method?: string }).method === 'openConversation' &&
          (message as { args?: unknown[] }).args?.[0] === 'peer-1',
      ),
    ).toBe(true);
    internals.receive({
      type: 'state',
      version: 3,
      from: 'replacement-owner',
      to: internals.clientId,
      snapshot: snapshot(),
    });
    expect(target.client.snapshot().activePeerId).toBe('peer-1');
    await target.stop();
  });

  it('deduplicates in-flight request IDs per follower', async () => {
    installBrowserFakes();
    const execution = deferred<void>();
    const refreshUpdates = vi.fn(() => execution.promise);
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    internals.owner = {
      engine: {
        refreshUpdates,
        snapshot: () => snapshot(),
        stop: vi.fn(() => Promise.resolve()),
      },
    };
    const request = {
      type: 'request',
      version: 3,
      from: 'follower',
      id: 'same-request',
      method: 'refreshUpdates',
      args: [],
    };

    internals.receive(request);
    internals.receive(request);
    await vi.waitFor(() => expect(refreshUpdates).toHaveBeenCalledTimes(1));
    execution.resolve();
    await vi.waitFor(() => {
      const responses = internals.channel?.sent.filter(
        (message) =>
          (message as { type?: string; id?: string }).type === 'response' &&
          (message as { id?: string }).id === 'same-request',
      );
      expect(responses).toHaveLength(1);
    });

    const otherFollowerRequest = { ...request, from: 'other-follower' };
    internals.receive(otherFollowerRequest);
    await vi.waitFor(() => expect(refreshUpdates).toHaveBeenCalledTimes(2));
    await target.stop();
  });

  it('finishes failover conversation restoration before sending for that follower', async () => {
    installBrowserFakes();
    const opening = deferred<void>();
    const openConversation = vi.fn(() => opening.promise);
    const sendDraft = vi.fn(() => Promise.resolve());
    const value = { ...snapshot(), activePeerId: 'peer-1' };
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    internals.owner = {
      engine: ownerEngine(
        {
          openConversation,
          sendDraft,
          setActiveConversationVisibility: vi.fn(() => Promise.resolve()),
        },
        value,
      ),
    };

    internals.receive({
      type: 'request',
      version: 3,
      from: 'follower',
      id: 'restore-view',
      method: 'openConversation',
      args: ['peer-1'],
      activePeerId: 'peer-1',
    });
    internals.receive({
      type: 'request',
      version: 3,
      from: 'follower',
      id: 'send-after-restore',
      method: 'sendDraft',
      args: [{ id: 'peer-1', kind: 'user' }, 'hello'],
      activePeerId: 'peer-1',
    });

    await vi.waitFor(() => expect(openConversation).toHaveBeenCalledOnce());
    expect(sendDraft).not.toHaveBeenCalled();
    opening.resolve();
    await vi.waitFor(() => expect(sendDraft).toHaveBeenCalledOnce());
    await target.stop();
  });

  it('acquires one owner lock, starts the engine, and releases both on stop', async () => {
    installBrowserFakes();
    let lockCallbackFinished = false;
    const request = vi.fn(
      async (
        _name: string,
        _options: unknown,
        callback: (lock: { name: string }) => Promise<void> | void,
      ) => {
        await callback({ name: 'televecha-owner:test' });
        lockCallbackFinished = true;
      },
    );
    vi.stubGlobal('navigator', { locks: { request } });
    const startEngine = vi.fn(() => Promise.resolve());
    const stopEngine = vi.fn(() => Promise.resolve());
    const engine = ownerEngine({ start: startEngine, stop: stopEngine });
    const owner = { engine };
    const ownerChanged = vi.fn();
    const target = new TabCoordinator({
      key: 'test',
      createOwner: vi.fn(() => owner),
      loadBlob: () => Promise.resolve(undefined),
      ownerChanged,
    });

    await target.start({ apiId: 1, apiHash: 'test' });

    expect(request).toHaveBeenCalledOnce();
    expect(startEngine).toHaveBeenCalledWith({ apiId: 1, apiHash: 'test' });
    expect(ownerChanged).toHaveBeenCalledWith(owner);
    expect(target.client.snapshot().phase).toBe('ready');

    await target.stop();
    await vi.waitFor(() => expect(lockCallbackFinished).toBe(true));
    expect(stopEngine).toHaveBeenCalledOnce();
    expect(ownerChanged).toHaveBeenLastCalledWith(undefined);
  });

  it('releases the owner lock when owner construction fails', async () => {
    installBrowserFakes();
    let lockCallbackFinished = false;
    const request = vi.fn(
      async (
        _name: string,
        _options: unknown,
        callback: (lock: { name: string }) => Promise<void> | void,
      ) => {
        await callback({ name: 'televecha-owner:test' });
        lockCallbackFinished = true;
      },
    );
    vi.stubGlobal('navigator', { locks: { request } });
    const target = new TabCoordinator({
      key: 'test',
      createOwner() {
        throw new Error('owner construction failed');
      },
      loadBlob: () => Promise.resolve(undefined),
    });

    await target.start({ apiId: 1, apiHash: 'test' });

    await vi.waitFor(() => expect(lockCallbackFinished).toBe(true));
    expect(target.client.snapshot()).toMatchObject({
      phase: 'error',
      online: false,
      error: 'Could not start the active TeleVecha tab. owner construction failed',
    });
    await target.stop();
  });

  it('stops a partially created owner and releases its lock when startup rejects', async () => {
    installBrowserFakes();
    let lockCallbackFinished = false;
    const request = vi.fn(
      async (
        _name: string,
        _options: unknown,
        callback: (lock: { name: string }) => Promise<void> | void,
      ) => {
        await callback({ name: 'televecha-owner:test' });
        lockCallbackFinished = true;
      },
    );
    vi.stubGlobal('navigator', { locks: { request } });
    const stopEngine = vi.fn(() => Promise.resolve());
    const owner = {
      engine: ownerEngine({
        start: vi.fn(() => Promise.reject(new Error('session start failed'))),
        stop: stopEngine,
      }),
    };
    const ownerChanged = vi.fn();
    const target = new TabCoordinator({
      key: 'test',
      createOwner: () => owner,
      loadBlob: () => Promise.resolve(undefined),
      ownerChanged,
    });

    await target.start({ apiId: 1, apiHash: 'test' });

    await vi.waitFor(() => expect(lockCallbackFinished).toBe(true));
    expect(stopEngine).toHaveBeenCalledOnce();
    expect(ownerChanged).toHaveBeenNthCalledWith(1, owner);
    expect(ownerChanged).toHaveBeenLastCalledWith(undefined);
    expect(target.client.snapshot().error).toContain('session start failed');
    await target.stop();
  });

  it('releases a lock granted after the coordinator has already stopped', async () => {
    installBrowserFakes();
    let grantLock!: () => void;
    let lockCallbackFinished = false;
    const request = vi.fn(
      (
        _name: string,
        _options: unknown,
        callback: (lock: { name: string }) => Promise<void> | void,
      ) =>
        new Promise<void>((resolve) => {
          grantLock = () => {
            void Promise.resolve(callback({ name: 'televecha-owner:test' })).then(() => {
              lockCallbackFinished = true;
              resolve();
            });
          };
        }),
    );
    vi.stubGlobal('navigator', { locks: { request } });
    const createOwner = vi.fn();
    const target = new TabCoordinator({
      key: 'test',
      createOwner,
      loadBlob: () => Promise.resolve(undefined),
    });

    const starting = target.start({ apiId: 1, apiHash: 'test' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await target.stop();
    grantLock();
    await starting;

    await vi.waitFor(() => expect(lockCallbackFinished).toBe(true));
    expect(createOwner).not.toHaveBeenCalled();
  });

  it('replays a completed response without executing its command again', async () => {
    installBrowserFakes();
    const refreshUpdates = vi.fn(() => Promise.resolve('done'));
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    internals.owner = { engine: ownerEngine({ refreshUpdates }) };
    const request = {
      type: 'request',
      version: 3,
      from: 'follower',
      id: 'completed-request',
      method: 'refreshUpdates',
      args: [],
    };

    internals.receive(request);
    await vi.waitFor(() =>
      expect(
        internals.channel?.sent.filter(
          (message) => (message as { type?: string }).type === 'response',
        ),
      ).toHaveLength(1),
    );
    internals.receive(request);

    await vi.waitFor(() =>
      expect(
        internals.channel?.sent.filter(
          (message) => (message as { type?: string }).type === 'response',
        ),
      ).toHaveLength(2),
    );
    expect(refreshUpdates).toHaveBeenCalledOnce();
    await target.stop();
  });

  it('accepts state, resources, and responses only from the elected owner', async () => {
    installBrowserFakes();
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    const resourceListener = vi.fn();
    target.client.subscribeResources(resourceListener);
    internals.receive({ type: 'owner', version: 3, from: 'owner', at: Date.now() });

    internals.receive({
      type: 'state',
      version: 3,
      from: 'stranger',
      to: internals.clientId,
      snapshot: snapshot('foreign state'),
    });
    internals.receive({
      type: 'state',
      version: 3,
      from: 'owner',
      to: 'another-follower',
      snapshot: snapshot('misdirected state'),
    });
    internals.receive({
      type: 'resource',
      version: 3,
      from: 'stranger',
      event: { kind: 'expressions' },
    });
    expect(target.client.snapshot().error).toBeUndefined();
    expect(resourceListener).not.toHaveBeenCalled();

    const command = target.client.refreshUpdates();
    const request = internals.channel?.sent.find(
      (message) => (message as { type?: string }).type === 'request',
    ) as { id: string };
    const settled = vi.fn();
    void command.then(settled);
    internals.receive({
      type: 'response',
      version: 3,
      from: 'stranger',
      to: internals.clientId,
      id: request.id,
    });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    internals.receive({
      type: 'state',
      version: 3,
      from: 'owner',
      to: internals.clientId,
      snapshot: snapshot('owner state'),
    });
    internals.receive({
      type: 'resource',
      version: 3,
      from: 'owner',
      event: { kind: 'expressions' },
    });
    internals.receive({
      type: 'response',
      version: 3,
      from: 'owner',
      to: internals.clientId,
      id: request.id,
    });

    await command;
    expect(target.client.snapshot().error).toBe('owner state');
    expect(resourceListener).toHaveBeenCalledOnce();
    await target.stop();
  });

  it('removes a closed follower from the aggregate visibility state', async () => {
    installBrowserFakes();
    const setActiveConversationVisibility = vi.fn(() => Promise.resolve());
    const value = { ...snapshot(), activePeerId: 'peer-1' };
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    internals.owner = {
      engine: ownerEngine({ setActiveConversationVisibility }, value),
    };

    internals.receive({
      type: 'request',
      version: 3,
      from: 'follower',
      id: 'visible',
      method: 'setActiveConversationVisibility',
      args: ['peer-1', { visible: true, atBottom: true }],
    });
    await vi.waitFor(() =>
      expect(setActiveConversationVisibility).toHaveBeenLastCalledWith('peer-1', {
        visible: true,
        atBottom: true,
      }),
    );

    internals.receive({ type: 'client-gone', version: 3, from: 'follower' });

    await vi.waitFor(() =>
      expect(setActiveConversationVisibility).toHaveBeenLastCalledWith('peer-1', {
        visible: false,
        atBottom: false,
      }),
    );
    await target.stop();
  });

  it('strips non-transferable pending payloads from follower snapshots', async () => {
    installBrowserFakes();
    const pendingSnapshot: EngineSnapshot = {
      ...snapshot(),
      pending: [
        {
          id: 'pending-1',
          peer: { id: 'peer-1', kind: 'user' },
          text: 'upload',
          randomId: 'random-1',
          createdAt: 1,
          attempts: 0,
          attachment: {
            blob: new Blob(['payload']),
            name: 'file.txt',
            mimeType: 'text/plain',
            asSticker: false,
            sendAs: 'file',
          },
        },
      ],
    };
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    internals.owner = { engine: ownerEngine({}, pendingSnapshot) };

    internals.receive({ type: 'hello', version: 3, from: 'follower' });

    const state = internals.channel?.sent.find(
      (message) => (message as { type?: string }).type === 'state',
    ) as { snapshot: EngineSnapshot; pendingPayloadIds: string[] };
    expect(state.snapshot.pending[0]).not.toHaveProperty('attachment');
    expect(state.snapshot.pending[0]).toMatchObject({ id: 'pending-1', text: 'upload' });
    expect(state.pendingPayloadIds).toEqual(['pending-1']);
    await target.stop();
  });

  it('does not rebroadcast an owner-only view update to an inactive follower', async () => {
    installBrowserFakes();
    const shared = {
      ...snapshot(),
      activePeerId: 'owner-peer',
      messages: [],
    };
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    internals.owner = { engine: ownerEngine({}, shared) };
    internals.clientSnapshots.set('follower', {
      ...shared,
      activePeerId: 'follower-peer',
      messages: [],
    });

    internals.publishSnapshot({
      ...shared,
      messages: [...shared.messages],
    });

    expect(
      internals.channel?.sent.filter((message) => (message as { type?: string }).type === 'state'),
    ).toHaveLength(0);
    await target.stop();
  });

  it('rejects every pending follower command when the coordinator stops', async () => {
    installBrowserFakes();
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    internals.receive({ type: 'owner', version: 3, from: 'owner', at: Date.now() });
    const first = target.client.refreshUpdates();
    const second = target.client.getBotCommands({ id: 'peer-1', kind: 'user' });
    const firstRejection = expect(first).rejects.toThrow(
      'This tab closed before the command completed.',
    );
    const secondRejection = expect(second).rejects.toThrow(
      'This tab closed before the command completed.',
    );

    await target.stop();

    await firstRejection;
    await secondRejection;
  });

  it('releases the owner lock and closes the channel when engine shutdown fails', async () => {
    installBrowserFakes();
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    const releaseOwnerLock = vi.fn();
    internals.releaseOwnerLock = releaseOwnerLock;
    internals.owner = {
      engine: {
        stop: vi.fn(() => Promise.reject(new Error('shutdown failed'))),
      },
    };

    await expect(target.stop()).rejects.toThrow('shutdown failed');
    expect(releaseOwnerLock).toHaveBeenCalledOnce();
    expect(internals.channel?.closed).toBe(true);
  });

  it('accepts a late response for a command that legitimately exceeds 30 seconds', async () => {
    vi.useFakeTimers();
    installBrowserFakes();
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    internals.receive({ type: 'owner', version: 3, from: 'owner', at: Date.now() });
    const operation = target.client.refreshUpdates();
    const outcome = operation.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const request = internals.channel?.sent.find(
      (message) => (message as { type?: string }).type === 'request',
    ) as { id: string };

    try {
      await vi.advanceTimersByTimeAsync(31_000);
      internals.receive({
        type: 'response',
        version: 3,
        from: 'owner',
        to: internals.clientId,
        id: request.id,
        result: 'done',
      });
      await expect(outcome).resolves.toEqual({ status: 'resolved', value: 'done' });
    } finally {
      vi.useRealTimers();
      await target.stop();
    }
  });

  it('does not declare a Web Lock owner dead because background timers were delayed', async () => {
    vi.useFakeTimers();
    installBrowserFakes();
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(
          async (
            _name: string,
            _options: unknown,
            callback: (lock: null) => Promise<void> | void,
          ) => callback(null),
        ),
      },
    });
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;

    try {
      await target.start({ apiId: 1, apiHash: 'test' });
      internals.receive({ type: 'owner', version: 3, from: 'owner', at: Date.now() });
      internals.receive({
        type: 'state',
        version: 3,
        from: 'owner',
        to: internals.clientId,
        snapshot: snapshot(),
      });

      await vi.advanceTimersByTimeAsync(8_000);

      expect(target.client.snapshot()).toMatchObject({ phase: 'ready', online: true });
    } finally {
      vi.useRealTimers();
      await target.stop();
    }
  });

  it('does not block metadata work behind an unrelated slow operation', async () => {
    installBrowserFakes();
    const slow = deferred<void>();
    const getSavedGifs = vi.fn(async () => []);
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    internals.owner = {
      engine: ownerEngine({
        refreshUpdates: vi.fn(() => slow.promise),
        getSavedGifs,
      }),
    };
    const first = target.client.refreshUpdates();
    const second = target.client.getSavedGifs();

    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(getSavedGifs).toHaveBeenCalledOnce();
    } finally {
      slow.resolve();
      await Promise.all([first, second]);
      await target.stop();
    }
  });

  it('returns downloaded media to a follower when the shared cache has no entry', async () => {
    installBrowserFakes();
    const target = coordinator();
    const internals = target as unknown as CoordinatorInternals;
    internals.owner = {
      engine: ownerEngine({ downloadMedia: vi.fn(async () => new Blob(['large media'])) }),
    };
    internals.receive({
      type: 'request',
      version: 3,
      from: 'follower',
      id: 'download-without-cache',
      method: 'downloadMedia',
      args: [
        {
          id: 7,
          peerId: 'peer-1',
          senderId: 'peer-1',
          text: '',
          date: 1,
          outgoing: false,
        },
      ],
    });

    try {
      await vi.waitFor(() => {
        const response = internals.channel?.sent.find(
          (message) =>
            (message as { type?: string; id?: string }).type === 'response' &&
            (message as { id?: string }).id === 'download-without-cache',
        ) as { result?: unknown };
        expect(response.result).toBeInstanceOf(Blob);
      });
    } finally {
      await target.stop();
    }
  });
});
