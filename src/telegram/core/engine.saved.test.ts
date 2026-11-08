import { BrowserCrypto } from '@effect/platform-browser';
import { Effect } from 'effect';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeMemoryCacheStore } from '../persistence/memoryStore';
import { createFixtureTelegramTransport } from '../transports/fixtureTransport';
import type { TelegramMessage } from '../types';
import { makeMessagingEngine, MessagingEngineLayer } from './engine';
const self = { id: 'u:1', kind: 'user' as const, accessHash: '1' };
const source = { id: 'u:2', kind: 'user' as const, accessHash: '2' };
beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }));
afterEach(() => vi.unstubAllGlobals());
it.each([true, false])(
  'keeps multiple saved tags and converts legacy reactions only once (tags=%s)',
  (tags) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const original = yield* createFixtureTelegramTransport();
          const message: TelegramMessage = {
            id: 50,
            peer: self,
            peerId: self.id,
            savedPeerId: source.id,
            senderId: self.id,
            outgoing: true,
            date: 1700000000,
            text: 'Saved idea',
            reactionsAsTags: tags,
            reactions: [{ emoji: '⭐', count: 1, chosen: true }],
          };
          const setSavedMessageTags = vi.fn((_id: number, _reactions: readonly string[]) =>
            Effect.succeed({}),
          );
          const cache = makeMemoryCacheStore();
          const engine = yield* makeMessagingEngine(
            {
              ...original,
              getAuthorizedAccountId: () => Effect.succeed('1'),
              getSavedMessagesInfo: () => Effect.succeed({ peer: self, premium: true }),
              getSavedHistory: () => Effect.succeed({ messages: [message], hasOlder: false }),
              setSavedMessageTags,
            },
            cache,
            { manageTabLease: false },
          );
          yield* engine.start({ apiId: 1, apiHash: 'fixture' });
          yield* engine.getSavedMessagesInfo();
          yield* engine.getSavedHistory(source);
          yield* engine.toggleReaction(self, 50, '❤');
          expect(setSavedMessageTags.mock.calls.map((call) => call[1])).toEqual(
            tags ? [['⭐', '❤']] : [[], ['⭐', '❤']],
          );
          yield* engine.toggleReaction(self, 50, '⭐');
          expect(setSavedMessageTags.mock.calls.at(-1)).toEqual([50, ['❤']]);
          expect((yield* cache.loadMessage(self.id, 50))?.reactions).toEqual([
            { emoji: '❤', count: 1, chosen: true },
          ]);
          expect((yield* cache.loadMessage(self.id, 50))?.reactionsAsTags).toBe(true);
        }),
      ).pipe(Effect.provide(MessagingEngineLayer), Effect.provide(BrowserCrypto.layer)),
    ),
);
