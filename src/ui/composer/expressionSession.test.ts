import { Context, Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import type { TelegramResourceInvalidation } from '../../telegram/types';
import { createExpressionSession, ExpressionSource } from './expressionSession';
import { queryCache } from '@effectweb/query';

it('shares catalog data across session recreation and invalidates the defined expression queries', () => {
  const listeners: Array<(event: TelegramResourceInvalidation) => void> = [];
  const recent = vi.fn(() => Effect.succeed([]));
  const packs = vi.fn(() => Effect.succeed([]));
  const gifs = vi.fn(() => Effect.succeed([]));
  const source = {
    getRecentStickers: recent,
    getStickerPacks: packs,
    getSavedGifs: gifs,
    searchGifs: vi.fn(() => Effect.succeed([])),
    subscribeResources: (listener: (event: TelegramResourceInvalidation) => void) =>
      Effect.sync(() => {
        listeners.push(listener);
        return Effect.void;
      }),
  };
  const options = {
    source,
    runEffect: Effect.runPromise,
    runTask: Effect.runFork,
    conversation: () => undefined,
    reply: () => undefined,
    canSendStickers: () => true,
    canSendGifs: () => true,
    clearReply() {},
  };
  const cache = queryCache(Context.make(ExpressionSource, source));
  const context = { cache, changed() {} };
  const first = createExpressionSession(options, context);
  first.toggleStickers();
  expect(recent).toHaveBeenCalledTimes(1);
  expect(packs).toHaveBeenCalledTimes(1);
  expect(gifs).not.toHaveBeenCalled();
  first.dispose();
  const second = createExpressionSession({ ...options, source: { ...source } }, context);
  second.toggleStickers();
  expect(recent).toHaveBeenCalledTimes(1);
  expect(packs).toHaveBeenCalledTimes(1);
  listeners.at(-1)!({ kind: 'expressions' });
  expect(recent).toHaveBeenCalledTimes(2);
  expect(packs).toHaveBeenCalledTimes(2);
  expect(gifs).not.toHaveBeenCalled();
  second.toggleGifs();
  expect(gifs).toHaveBeenCalledTimes(1);
  expect(second.snapshot().gifLoading).toBe(false);
  const peer = { id: 'u:1', kind: 'user' as const };
  expect(second.gifSearch(peer, 'cat')).toBe(second.gifSearch(peer, 'cat'));
  expect(second.snapshot().gifPeer).toBeUndefined();
  second.dispose();
  cache.dispose();
});
