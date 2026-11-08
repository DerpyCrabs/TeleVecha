import { Api, createTl } from '../mtproto/tl';
import { describeMessageContent } from '../transports/messageContentDiagnostic';
import { BrowserCrypto } from '@effect/platform-browser';
import { Effect, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeMemoryCacheStore } from '../persistence/memoryStore';
import { createFixtureTelegramTransport } from '../transports/fixtureTransport';
import type { TelegramChatAppearance, TelegramTransport, TelegramWallpaper } from '../types';
import { createMtprotoError } from '../mtproto/errors';
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
  it('rechecks legacy empty cached messages without reloading the conversation head', () =>
    Effect.runPromise(
      withEngine((engine, transport, cache) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          const dialog = engine.snapshot().dialogs.find(({ peer }) => peer.id === 'u:101')!;
          const page = yield* transport.getHistory(dialog.peer, 50);
          const epoch = yield* cache.loadEpoch();
          const legacy = {
            id: page.messages[0]!.id,
            peerId: dialog.peer.id,
            senderId: dialog.peer.id,
            text: '',
            date: page.messages[0]!.date,
            outgoing: false,
            cacheEpoch: epoch,
          };
          const contentDiagnostic = describeMessageContent(
            Api.Message({
              id: legacy.id,
              peerId: Api.PeerUser({ userId: 101n }),
              date: 1,
              message: '',
              media: createTl('messageMediaUnsupported', {}),
            }),
            legacy,
          );
          const remote = { ...legacy, contentDiagnostic };
          yield* cache.putMessages([
            ...page.messages
              .filter(({ id }) => id !== legacy.id)
              .map((message) => ({ ...message, cacheEpoch: epoch })),
            legacy,
          ]);
          const head = vi.spyOn(transport, 'getHistory');
          const around = vi
            .spyOn(transport, 'getHistoryAround')
            .mockReturnValue(Effect.succeed({ messages: [remote] }));
          yield* engine.loadConversationView(dialog.peer.id);
          yield* Effect.promise(() =>
            vi.waitFor(async () => {
              expect(
                (await Effect.runPromise(cache.loadMessage(dialog.peer.id, legacy.id)))
                  ?.contentDiagnostic,
              ).toEqual(contentDiagnostic);
            }),
          );
          expect(around).toHaveBeenCalledWith(dialog.peer, legacy.id, 3);
          expect(head).not.toHaveBeenCalled();
          const reopened = yield* engine.loadConversationView(dialog.peer.id);
          expect(reopened.messages.find(({ id }) => id === legacy.id)?.contentDiagnostic).toEqual(
            contentDiagnostic,
          );
          expect(around).toHaveBeenCalledTimes(1);
        }),
      ),
    ));

  it('reads earlier group history without replacing the open conversation and caches the original peer', () =>
    Effect.runPromise(
      withEngine((engine, transport, cache) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          const view = yield* engine.loadConversationView('u:101');
          const snapshot = engine.snapshot();
          const source = { id: 'g:303', kind: 'group' as const };
          const page = yield* engine.getEarlierGroupHistory(source);
          expect(page.messages.length).toBeGreaterThan(0);
          expect(page.messages.every((message) => message.peerId === source.id)).toBe(true);
          expect(engine.snapshot()).toEqual(snapshot);
          expect((yield* cache.loadMessage(source.id, page.messages[0]!.id))?.text).toBe(
            'Group fixture message',
          );
          expect(view.activePeerId).toBe('u:101');
          const spy = vi.spyOn(transport, 'getHistory');
          const failure = yield* engine
            .getEarlierGroupHistory({ id: 'c:202', kind: 'channel' })
            .pipe(Effect.result);
          expect(failure._tag).toBe('Failure');
          expect(spy).not.toHaveBeenCalled();
        }),
      ),
    ));

  it('searches group senders without replacing the complete member cache', () =>
    Effect.runPromise(
      withEngine((engine, transport) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          const peer = { id: 'g:303', kind: 'group' as const };
          const full = yield* engine.getGroupMembers(peer);
          expect(full.members).toHaveLength(2);
          const spy = vi.spyOn(transport, 'getGroupMembers');
          const filtered = yield* engine.getGroupMembers(peer, 1, 0, '  member  ');
          expect(filtered.members.map((member) => member.peer.id)).toEqual(['u:405']);
          expect(spy).toHaveBeenCalledWith(peer, 1, 0, 'member');
          expect((yield* engine.getGroupMembers(peer)).members).toEqual(full.members);
          const first = yield* engine.getGroupMembers(peer, 1, 0, '');
          expect(first.nextOffset).toBe(1);
          const second = yield* engine.getGroupMembers(peer, 1, first.nextOffset, '');
          expect(second.members[0]?.peer.id).toBe('u:405');
          expect(second.hasMore).toBe(false);
        }),
      ),
    ));

  it('cancels QR token work when switching to phone login and clears the token', () =>
    Effect.runPromise(
      withEngine((engine, transport) =>
        Effect.gen(function* () {
          vi.spyOn(transport, 'isAuthorized').mockReturnValue(Effect.succeed(false));
          let cancelled = 0;
          transport.watchQrLogin = () =>
            Stream.concat(
              Stream.make({
                type: 'token' as const,
                url: 'tg://login?token=test',
                expires: 9999999999,
              }),
              Stream.never,
            ).pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  cancelled++;
                }),
              ),
            );
          yield* engine.start(credentials);
          yield* engine.beginQrLogin();
          yield* Effect.yieldNow;
          expect(engine.snapshot()).toMatchObject({
            authStep: 'qr',
            qrLogin: { url: 'tg://login?token=test' },
          });
          yield* engine.cancelQrLogin();
          expect(engine.snapshot().authStep).toBe('phone');
          expect(engine.snapshot().qrLogin).toBeUndefined();
          expect(cancelled).toBe(1);
          yield* engine.beginQrLogin();
          yield* engine.requestCode('+123456789');
          expect(engine.snapshot().authStep).toBe('code');
          expect(engine.snapshot().qrLogin).toBeUndefined();
          expect(cancelled).toBe(2);
        }),
      ),
    ));
  it('routes QR password requirements through the existing 2FA flow', () =>
    Effect.runPromise(
      withEngine((engine, transport) =>
        Effect.gen(function* () {
          vi.spyOn(transport, 'isAuthorized').mockReturnValue(Effect.succeed(false));
          transport.watchQrLogin = () => Stream.make({ type: 'password-required' as const });
          yield* engine.start(credentials);
          yield* engine.beginQrLogin();
          yield* Effect.yieldNow;
          expect(engine.snapshot().authStep).toBe('password');
          expect(engine.snapshot().qrLogin).toBeUndefined();
          yield* engine.submitPassword('fixture-password');
          expect(engine.snapshot().phase).toBe('ready');
          expect(engine.snapshot().authStep).toBeUndefined();
        }),
      ),
    ));

  it('downloads independent video ranges without caching a partial file as the original', () =>
    Effect.runPromise(
      withEngine((engine, transport, cache) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          const message = {
            id: 700,
            peerId: 'u:101',
            senderId: 'u:101',
            date: 1,
            text: '',
            outgoing: false,
          };
          const original = new Blob(['0123456789'], { type: 'video/mp4' });
          const download = vi
            .spyOn(transport, 'downloadMedia')
            .mockImplementation((_message, options) =>
              Effect.succeed(
                options?.range
                  ? original.slice(options.range.start, options.range.end + 1, original.type)
                  : original,
              ),
            );
          const ranges = yield* Effect.all(
            [
              engine.downloadMedia(message, { range: { start: 0, end: 2 } }),
              engine.downloadMedia(message, { range: { start: 7, end: 9 } }),
            ],
            { concurrency: 'unbounded' },
          );
          expect(
            yield* Effect.promise(() => Promise.all(ranges.map((blob) => blob.text()))),
          ).toEqual(['012', '789']);
          expect(download).toHaveBeenCalledTimes(2);
          expect(yield* cache.loadBlob(engine.mediaAssetKey(message))).toBeUndefined();
          expect(yield* engine.downloadMedia(message)).toEqual(original);
          expect(yield* cache.loadBlob(engine.mediaAssetKey(message))).toEqual(original);
          const cachedRange = yield* engine.downloadMedia(message, { range: { start: 3, end: 6 } });
          expect(yield* Effect.promise(() => cachedRange.text())).toBe('3456');
          expect(cachedRange.type).toBe('video/mp4');
          expect(download).toHaveBeenCalledTimes(3);
        }),
      ),
    ));

  it.each([
    { themed: false, imageCached: false, stale: false },
    { themed: false, imageCached: false, stale: true },
    { themed: true, imageCached: false, stale: false },
    { themed: true, imageCached: false, stale: true },
    { themed: false, imageCached: true, stale: false },
    { themed: true, imageCached: true, stale: false },
  ])(
    'restores wallpaper download references after reload (themed=$themed, imageCached=$imageCached, stale=$stale)',
    ({ themed, imageCached, stale }) =>
      Effect.runPromise(
        withEngine((engine, transport, cache) =>
          Effect.gen(function* () {
            yield* engine.start(credentials);
            const peer = { id: 'u:101', kind: 'user' } as const;
            const wallpaper: TelegramWallpaper = {
              id: 'chat-only-pattern',
              dark: true,
              pattern: true,
              hasFile: true,
              settings: { backgroundColors: ['#112233', '#445566'], blur: false, motion: false },
            };
            const appearance: TelegramChatAppearance = themed
              ? {
                  theme: {
                    id: 'chat-theme',
                    slug: '',
                    title: 'Chat theme',
                    default: false,
                    forChat: true,
                    settings: [
                      {
                        baseTheme: 'night',
                        accentColor: '#123456',
                        messageColors: [],
                        messageColorsAnimated: false,
                        wallpaper,
                      },
                    ],
                  },
                }
              : { wallpaper };
            // Model persisted metadata with an empty transport document map after reload.
            yield* cache.saveMetadata(`chat-appearance:${peer.id}`, appearance);
            if (stale) {
              const loadMetadata = cache.loadMetadata;
              vi.spyOn(cache, 'loadMetadata').mockImplementation((key) =>
                loadMetadata(key).pipe(
                  Effect.map((entry) =>
                    entry ? { ...entry, savedAt: Date.now() - 5 * 24 * 60 * 60 * 1_000 } : entry,
                  ),
                ),
              );
            }
            const image = new Blob(['pattern'], { type: 'image/png' });
            if (imageCached) yield* cache.saveBlob(`wallpaper:${wallpaper.id}`, image);
            let documentAvailable = false;
            const getAppearance = vi.spyOn(transport, 'getChatAppearance').mockImplementation(() =>
              Effect.sync(() => {
                documentAvailable = true;
                return appearance;
              }),
            );
            const download = vi
              .spyOn(transport, 'downloadWallpaper')
              .mockImplementation(() =>
                documentAvailable
                  ? Effect.succeed(image)
                  : Effect.fail(createMtprotoError('protocol', 'Missing wallpaper document.')),
              );
            expect(yield* engine.getChatAppearance(peer)).toEqual(appearance);
            expect(yield* engine.downloadWallpaper(wallpaper.id)).toEqual(image);
            expect(getAppearance).toHaveBeenCalledTimes(imageCached ? 0 : 1);
            expect(download).toHaveBeenCalledTimes(imageCached ? 0 : 1);
            expect(yield* cache.loadBlob(`wallpaper:${wallpaper.id}`)).toEqual(image);
            yield* engine.getChatAppearance(peer);
            expect(getAppearance).toHaveBeenCalledTimes(imageCached ? 0 : 1);
            // Simulate losing the persisted asset and transport references after
            // this session has already memoized the appearance.
            yield* cache.deleteBlob(`wallpaper:${wallpaper.id}`);
            documentAvailable = false;
            yield* engine.getChatAppearance(peer);
            expect(yield* engine.downloadWallpaper(wallpaper.id)).toEqual(image);
            expect(getAppearance).toHaveBeenCalledTimes(imageCached ? 1 : 2);
            expect(download).toHaveBeenCalledTimes(imageCached ? 1 : 2);
          }),
        ),
      ),
  );

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

  it('protects the current session while terminating other devices and changing expiry', () =>
    Effect.runPromise(
      withEngine((engine, transport) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          const reset = vi.spyOn(transport, 'terminateSession');
          expect((yield* engine.terminateSession('0').pipe(Effect.result))._tag).toBe('Failure');
          expect(reset).not.toHaveBeenCalled();
          yield* engine.terminateSession('1234567890123456789');
          expect((yield* engine.getActiveSessions()).sessions.map((session) => session.id)).toEqual(
            ['0', '-234567890123456789'],
          );
          yield* engine.terminateSession();
          expect((yield* engine.getActiveSessions()).sessions.map((session) => session.id)).toEqual(
            ['0'],
          );
          yield* engine.setSessionTtl(30);
          expect((yield* engine.getActiveSessions()).ttlDays).toBe(30);
          expect((yield* engine.setSessionTtl(0).pipe(Effect.result))._tag).toBe('Failure');
        }),
      ),
    ));

  it('loads read receipts only for outgoing messages', () =>
    Effect.runPromise(
      withEngine((engine, transport) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          yield* engine.loadConversationView('u:101');
          const read = vi.spyOn(transport, 'getMessageReadReceipts');
          const peer = { id: 'u:101', kind: 'user' as const };
          expect(yield* engine.getMessageReadReceipts(peer, 79)).toEqual({
            state: 'unavailable',
            people: [],
          });
          expect(read).not.toHaveBeenCalled();
          expect((yield* engine.getMessageReadReceipts(peer, 80)).people[0]?.name).toBe(
            'Alice Fixture',
          );
          expect(read).toHaveBeenCalledTimes(1);
        }),
      ),
    ));

  it('persists contact cards before sending and retains them in conversation history', () =>
    Effect.runPromise(
      withEngine((engine, transport, cache) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          yield* engine.loadConversationView('u:101');
          const send = vi.spyOn(transport, 'sendContact');
          const save = vi.spyOn(cache, 'commitOutbox');
          const peer = { id: 'u:101', kind: 'user' } as const;
          const contact = {
            firstName: 'Ada',
            lastName: 'Lovelace',
            phoneNumber: '+123456789',
            vcard: '',
            peer,
          };
          yield* engine.sendContact(peer, contact);
          expect(save.mock.calls[0]?.[0]).toMatchObject({ text: '', contact });
          expect(send).toHaveBeenCalledWith(peer, contact, expect.any(String), undefined);
          expect(engine.snapshot().pending).toEqual([]);
          expect(
            engine.snapshot().dialogs.find((dialog) => dialog.peer.id === peer.id)?.topMessage
              ?.contact,
          ).toEqual(contact);
        }),
      ),
    ));

  it('carries forwarding privacy options through the durable queue to the transport', () =>
    Effect.runPromise(
      withEngine((engine, transport, cache) =>
        Effect.gen(function* () {
          yield* engine.start(credentials);
          yield* engine.loadConversationView('u:101');
          const forward = vi.spyOn(transport, 'forwardMessage');
          const save = vi.spyOn(cache, 'commitOutbox');
          const peer = { id: 'u:101', kind: 'user' } as const;
          const options = { hideAuthor: true, hideCaption: true };
          yield* engine.forwardMessage(peer, peer, 78, options);
          expect(save.mock.calls[0]?.[0]).toMatchObject({
            text: '',
            forward: { messageId: 78, options },
          });
          expect(forward).toHaveBeenCalledWith(peer, peer, 78, expect.any(String), options);
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

  it('delivers Mini App completion to subscribers without losing the query id', () =>
    Effect.runPromise(
      withEngine((engine) =>
        Effect.gen(function* () {
          const received: unknown[] = [];
          const unsubscribe = yield* engine.subscribeResources((event) => {
            if (event.kind === 'web-app-result') received.push(event);
          });
          yield* engine.start(credentials);
          window.__televechaFixture?.emit({
            type: 'web-app-result',
            queryId: '9223372036854775806',
          });
          yield* Effect.yieldNow;
          yield* unsubscribe;
          expect(received).toEqual([{ kind: 'web-app-result', queryId: '9223372036854775806' }]);
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
