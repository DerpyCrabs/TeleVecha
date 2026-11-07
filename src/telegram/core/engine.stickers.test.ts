import { BrowserCrypto } from '@effect/platform-browser';
import { Effect } from 'effect';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeMemoryCacheStore } from '../persistence/memoryStore';
import { createFixtureTelegramTransport } from '../transports/fixtureTransport';
import { makeMessagingEngine, MessagingEngineLayer } from './engine';

beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }));
afterEach(() => vi.unstubAllGlobals());

it('updates favorite stickers on the server, invalidates the picker and handles a rejected change', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const engine = yield* makeMessagingEngine(transport, store, { manageTabLease: false });
        yield* engine.start({ apiId: 1, apiHash: 'fixture' });
        const events: string[] = [];
        const unsubscribe = yield* engine.subscribeResources((event) => {
          events.push(event.kind);
        });
        const [sticker] = yield* engine.getRecentStickers();
        expect(sticker).toBeDefined();
        expect(yield* engine.getFavoriteStickers()).toEqual([]);
        yield* engine.setStickerFavorite(sticker!, true);
        expect(events).toContain('expressions');
        expect((yield* engine.getFavoriteStickers()).map((value) => value.id)).toEqual([
          sticker!.id,
        ]);
        yield* engine.setStickerFavorite(sticker!, false);
        expect(yield* engine.getFavoriteStickers()).toEqual([]);
        const count = events.length;
        vi.spyOn(transport, 'setStickerFavorite').mockReturnValue(Effect.succeed(false));
        const rejected = yield* engine.setStickerFavorite(sticker!, true).pipe(Effect.result);
        expect(rejected._tag).toBe('Failure');
        expect(events).toHaveLength(count);
        yield* unsubscribe;
        expect(yield* engine.getFavoriteStickers()).toEqual([]);
      }),
    ).pipe(Effect.provide(MessagingEngineLayer), Effect.provide(BrowserCrypto.layer)),
  ));

it('invalidates cached installed packs after removal and installation', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* createFixtureTelegramTransport();
        const engine = yield* makeMessagingEngine(transport, makeMemoryCacheStore(), {
          manageTabLease: false,
        });
        yield* engine.start({ apiId: 1, apiHash: 'fixture' });
        const packs = yield* engine.getStickerPacks();
        const pack = packs[0]!;
        yield* engine.setStickerPackInstalled(pack, false);
        expect((yield* engine.getStickerPacks()).some((value) => value.id === pack.id)).toBe(false);
        yield* engine.setStickerPackInstalled(pack, true);
        expect(
          (yield* engine.getStickerPacks()).filter((value) => value.id === pack.id),
        ).toHaveLength(1);
      }),
    ).pipe(Effect.provide(MessagingEngineLayer), Effect.provide(BrowserCrypto.layer)),
  ));
