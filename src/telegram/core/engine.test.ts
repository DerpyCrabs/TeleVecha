import { BrowserCrypto } from '@effect/platform-browser';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeMemoryCacheStore } from '../persistence/memoryStore';
import { createFixtureTelegramTransport } from '../transports/fixtureTransport';
import type { TelegramTransport } from '../types';
import { makeMessagingEngine, MessagingEngineLayer, type MessagingEngine } from './engine';

const credentials = { apiId: 1, apiHash: 'fixture' };

const withEngine = <A, E>(
  use: (
    engine: MessagingEngine,
    transport: TelegramTransport,
    cache: ReturnType<typeof makeMemoryCacheStore>,
  ) => Effect.Effect<A, E, never>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* createFixtureTelegramTransport();
      const cache = makeMemoryCacheStore();
      const engine = yield* makeMessagingEngine(transport, cache, { manageTabLease: false });
      return yield* use(engine, transport, cache);
    }).pipe(Effect.provide(MessagingEngineLayer), Effect.provide(BrowserCrypto.layer)),
  );

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MessagingEngine', () => {
  it('removes a previously persisted channel preview when membership is corrected', () =>
    Effect.runPromise(
      withEngine((engine, _transport, cache) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          const peer = yield* engine.resolveUsername('public_fixture_news');
          yield* engine.loadConversationView(peer.id);
          expect((yield* cache.loadDialogs()).some((dialog) => dialog.peer.id === peer.id)).toBe(
            false,
          );
          const preview = engine.snapshot().dialogs.find((dialog) => dialog.peer.id === peer.id)!;
          const mistaken = { ...preview, transient: false };
          window.__televechaFixture?.emit({ type: 'dialog-changed', dialog: mistaken });
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(
                engine.snapshot().dialogs.find((dialog) => dialog.peer.id === peer.id)?.transient,
              ).toBe(false),
            ),
          );
          expect((yield* cache.loadDialogs()).some((dialog) => dialog.peer.id === peer.id)).toBe(
            true,
          );
          window.__televechaFixture?.emit({
            type: 'dialog-changed',
            dialog: { ...preview, transient: true },
          });
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(
                engine.snapshot().dialogs.find((dialog) => dialog.peer.id === peer.id)?.transient,
              ).toBe(true),
            ),
          );
          const stored = yield* cache.loadDialogs();
          expect(stored.some((dialog) => dialog.peer.id === peer.id)).toBe(false);
          expect(stored.some((dialog) => dialog.peer.id === 'c:202')).toBe(true);
        }),
      ),
    ));

  it('starts, synchronizes a bounded dialog page, and stops in scope', () =>
    Effect.runPromise(
      withEngine((engine) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          expect(engine.snapshot()).toMatchObject({
            phase: 'ready',
            online: true,
            sync: 'current',
          });
          expect(engine.snapshot().dialogs.length).toBeGreaterThan(0);
          expect(window.__televechaFixture?.stats.getDialogs).toBe(1);
          yield* engine.stop();
          expect(engine.snapshot()).toMatchObject({ phase: 'idle', online: false });
        }),
      ),
    ));

  it('loads cached and remote conversation state through one Effect', () =>
    Effect.runPromise(
      withEngine((engine) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          const first = yield* engine.loadConversationView('u:101');
          const second = yield* engine.loadConversationView('u:101');
          expect(first.activePeerId).toBe('u:101');
          expect(first.messages.length).toBeGreaterThan(0);
          expect(second.messages).toEqual(first.messages);
          expect(window.__televechaFixture?.stats.getHistory).toBe(1);
        }),
      ),
    ));

  it('preserves typed transport failures when loading a conversation', () =>
    Effect.runPromise(
      withEngine((engine) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          window.__televechaFixture?.failNextHistory('g:303', 'Fixture history failure');
          const view = yield* engine.loadConversationView('g:303');
          expect(view.historyError).toContain('Fixture history failure');
        }),
      ),
    ));

  it('applies a late webpage video update to an already loaded message', () =>
    Effect.runPromise(
      withEngine((engine) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          const initial = yield* engine.loadConversationView('u:101');
          expect(initial.messages.find(({ id }) => id === 71)?.linkPreview?.media).toBeUndefined();

          window.__televechaFixture?.emit({
            type: 'web-page-updated',
            pts: 11,
            ptsCount: 1,
            webPageId: '71',
            linkPreview: {
              url: 'https://packaged-media.redd.it/video.mp4',
              webPageId: '71',
              type: 'video',
              hasPhoto: true,
              media: {
                kind: 'video',
                name: 'reddit-video.mp4',
                mimeType: 'video/mp4',
                width: 480,
                height: 640,
                duration: 12,
                cacheKey: 'document:71',
              },
            },
          });
          yield* Effect.yieldNow;

          const updated = yield* engine.loadConversationView('u:101');
          expect(updated.messages.find(({ id }) => id === 71)?.linkPreview).toMatchObject({
            webPageId: '71',
            type: 'video',
            photoSize: 'small',
            media: { kind: 'video', cacheKey: 'document:71' },
          });
        }),
      ),
    ));

  it('uses a fresh cache identity for Telegram webpage videos', () =>
    Effect.runPromise(
      withEngine((engine) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          const view = yield* engine.loadConversationView('u:101');
          const message = view.messages.find(({ id }) => id === 72);
          expect(message).toBeDefined();
          expect(engine.mediaAssetKey(message!)).toContain(':webpage-video-v2:document:72');
        }),
      ),
    ));

  it('keeps validation failures in the Effect error channel', () =>
    Effect.runPromise(
      withEngine((engine) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          const missingConversation = yield* engine
            .loadConversationView('missing')
            .pipe(Effect.result);
          expect(missingConversation._tag).toBe('Failure');
          const emptyMessage = yield* engine
            .sendDraft({ id: 'u:101', kind: 'user' }, 'x'.repeat(10_000))
            .pipe(Effect.result);
          expect(emptyMessage._tag).toBe('Failure');
        }),
      ),
    ));

  it('sends through the transport without a Promise registry', () =>
    Effect.runPromise(
      withEngine((engine) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          yield* engine.loadConversationView('u:101');
          yield* engine.sendDraft({ id: 'u:101', kind: 'user' }, 'Effect-native message');
          expect(window.__televechaFixture?.stats.sendText).toBe(1);
          expect(engine.snapshot().pending).toEqual([]);
        }),
      ),
    ));

  it('scopes unqualified message deletions to the right protocol peer', () =>
    Effect.runPromise(
      withEngine((engine) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          yield* engine.loadConversationView('u:101');
          yield* engine.loadConversationView('c:202');

          window.__televechaFixture?.emit({
            type: 'delete-messages',
            pts: 11,
            ptsCount: 1,
            messageIds: [5],
          });
          yield* Effect.yieldNow;

          const userAfterDelete = yield* engine.loadConversationView('u:101');
          const channelAfterDelete = yield* engine.loadConversationView('c:202');
          expect(userAfterDelete.messages.some(({ id }) => id === 5)).toBe(false);
          expect(channelAfterDelete.messages.some(({ id }) => id === 5)).toBe(true);

          const userWithOlderPage = yield* engine.loadOlderConversationView(
            'u:101',
            userAfterDelete,
          );
          expect(userWithOlderPage.messages.some(({ id }) => id === 12)).toBe(true);
          yield* engine.loadConversationView('g:303');

          window.__televechaFixture?.emit({
            type: 'delete-messages',
            pts: 12,
            ptsCount: 1,
            messageIds: [12],
          });
          yield* Effect.yieldNow;

          const userWithAmbiguousId = yield* engine.loadConversationView('u:101');
          const groupWithAmbiguousId = yield* engine.loadConversationView('g:303');
          expect(userWithAmbiguousId.messages.some(({ id }) => id === 12)).toBe(true);
          expect(groupWithAmbiguousId.messages.some(({ id }) => id === 12)).toBe(true);
        }),
      ),
    ));

  it('publishes scoped snapshot and resource subscriptions', () =>
    Effect.runPromise(
      withEngine((engine) =>
        Effect.gen(function* () {
          const phases: string[] = [];
          const resources: string[] = [];
          const unsubscribeSnapshots = yield* engine.subscribe((snapshot) => {
            phases.push(snapshot.phase);
          });
          const unsubscribeResources = yield* engine.subscribeResources((event) => {
            resources.push(event.kind);
          });
          yield* engine.start(credentials);
          window.__televechaFixture?.emit({ type: 'expression-index-changed', kind: 'all' });
          yield* Effect.yieldNow;
          yield* unsubscribeSnapshots;
          yield* unsubscribeResources;
          expect(phases).toContain('ready');
          expect(resources).toContain('expressions');
        }),
      ),
    ));

  it('keeps optional shared-media count failures out of the account error state', () => {
    vi.stubGlobal('window', { location: { search: '?scenario=shared-media-counts-fail-once' } });

    return Effect.runPromise(
      withEngine((engine) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          const counts = yield* engine.loadConversationSharedMediaCounts('u:101');

          expect(counts).toMatchObject({ photos: 128, files: 16 });
          expect(engine.snapshot().operationError).toBeUndefined();
        }),
      ),
    );
  });

  it('does not surface a permanent shared-media count failure as an account error', () => {
    vi.stubGlobal('window', { location: { search: '?scenario=shared-media-counts-fail' } });

    return Effect.runPromise(
      withEngine((engine) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          const counts = yield* engine.loadConversationSharedMediaCounts('u:101');

          expect(counts).toBeUndefined();
          expect(engine.snapshot().operationError).toBeUndefined();
          expect(window.__televechaFixture?.stats.getSharedMediaCounts).toBe(2);
        }),
      ),
    );
  });
});
