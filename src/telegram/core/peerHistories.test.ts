import { expect, it } from 'vitest';
import { createPeerHistories } from './peerHistories';
import type { TelegramMessage } from '../types';

const messages = (...ids: number[]): TelegramMessage[] =>
  ids.map((id) => ({
    id,
    peerId: 'c:1',
    senderId: 'u:1',
    outgoing: false,
    date: id,
    text: String(id),
  }));
const range = (size: number) => messages(...Array.from({ length: size }, (_, i) => i + 1));
const gap = (olderMaxMessageId: number, newerMinMessageId: number) => ({
  olderMaxMessageId,
  newerMinMessageId,
});
const peer = 'c:1';

it('keeps earlier messages reachable after trimming a complete history', () => {
  const h = createPeerHistories();
  expect(h.remember(peer, { messages: range(501), hasOlderMessages: false }).hasOlderMessages).toBe(
    true,
  );
});

it('retains the gap created when a live update overflows an oldest window', () => {
  const h = createPeerHistories();
  h.remember(peer, { messages: range(500), hasOlderMessages: false }, 'oldest');
  h.updateLoaded(peer, (history) => ({
    ...history,
    messages: h.boundMessages(peer, [...history.messages, ...messages(501)], 'oldest'),
  }));
  expect(h.gaps(peer)).toEqual([gap(250, 252)]);
});

it('invalidates outstanding page requests upon LRU eviction', () => {
  const h = createPeerHistories();
  h.remember(peer, { messages: messages(1), hasOlderMessages: false });
  const version = h.version(peer);
  for (let i = 0; i < 8; i++)
    h.remember('other' + i, { messages: messages(1), hasOlderMessages: false });
  expect(h.version(peer)).toBeGreaterThan(version);
});

it('tracks both sides of a newly discovered isolated range', () => {
  const h = createPeerHistories();
  h.recordLoadedRange(peer, messages(1, 100), messages(30, 31));
  expect(h.gaps(peer)).toEqual([gap(1, 30), gap(31, 100)]);
});

it('closes a gap when the server exhausted accessible history', () => {
  const h = createPeerHistories();
  h.setGaps(peer, [gap(1, 100)]);
  expect(h.advanceGap(peer, gap(1, 100), messages(30), false)).toEqual([]);
});

it('does not expand a gap on an out-of-window response', () => {
  const h = createPeerHistories();
  h.setGaps(peer, [gap(1, 100)]);
  expect(h.advanceGap(peer, gap(1, 100), messages(120), true)).toEqual([gap(1, 100)]);
});

it('reanchors a known gap when a boundary message is deleted', () => {
  const h = createPeerHistories();
  h.remember(peer, { messages: messages(9, 10, 20, 21), hasOlderMessages: true });
  h.setGaps(peer, [gap(10, 20)]);
  h.updateLoaded(peer, (history) => ({
    ...history,
    messages: history.messages.filter((m) => m.id !== 10),
  }));
  expect(h.gaps(peer)).toEqual([gap(9, 20)]);
});
