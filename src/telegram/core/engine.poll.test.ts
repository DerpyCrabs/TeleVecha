import { BrowserCrypto } from '@effect/platform-browser';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMemoryCacheStore } from '../persistence/memoryStore';
import { createFixtureTelegramTransport } from '../transports/fixtureTransport';
import type { TelegramMessage, TelegramPoll } from '../types';
import { makeMessagingEngine, MessagingEngineLayer } from './engine';
import { createMtprotoError } from '../mtproto/errors';

const peer = { id: 'u:101', kind: 'user' as const };
const poll: TelegramPoll = {
  id: '42',
  hash: '0',
  question: 'Which?',
  answers: [
    { option: '00', text: 'One' },
    { option: '01', text: 'Two' },
  ],
  closed: false,
  publicVoters: false,
  multipleChoice: false,
  quiz: false,
  revotingDisabled: false,
  hideResultsUntilClose: false,
  results: { totalVoters: 0 },
};
const source: TelegramMessage = {
  id: 81,
  peerId: peer.id,
  senderId: 'u:101',
  text: '',
  date: 1700000081,
  outgoing: false,
  poll,
};
const run = <A, E>(
  effect: Effect.Effect<A, E, Effect.Services<ReturnType<typeof makeMessagingEngine>>>,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(MessagingEngineLayer),
      Effect.provide(BrowserCrypto.layer),
    ),
  );
beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }));
afterEach(() => vi.unstubAllGlobals());

describe('poll voting', () => {
  it('does not request identities for an anonymous poll', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const getPollVotes = vi.fn(() => Effect.succeed({ people: [], count: 0 }));
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            getPollVotes,
            getHistory: () => Effect.succeed({ messages: [source], hasOlder: false }),
          },
          makeMemoryCacheStore(),
          { manageTabLease: false },
        );
        yield* engine.start({ apiId: 1, apiHash: 'fixture' });
        yield* engine.loadConversationView(peer.id);
        expect((yield* engine.getPollVotes(peer, 81).pipe(Effect.result))._tag).toBe('Failure');
        expect(getPollVotes).not.toHaveBeenCalled();
      }),
    ));
  it('persists a quiz in the outbox before sending it', () =>
    run(
      Effect.gen(function* () {
        const transport = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const saved = vi.spyOn(store, 'commitOutbox');
        const sent = vi.spyOn(transport, 'sendPoll');
        const engine = yield* makeMessagingEngine(transport, store, { manageTabLease: false });
        yield* engine.start({ apiId: 1, apiHash: 'fixture' });
        yield* engine.loadConversationView(peer.id);
        const draft = {
          question: 'Question?',
          answers: ['One', 'Two'],
          quiz: true,
          multipleChoice: false,
          publicVoters: false,
          correctAnswer: 1,
          solution: 'Because two.',
        };
        yield* engine.sendPoll(peer, draft);
        expect(saved.mock.calls[0]?.[0]).toMatchObject({ pollDraft: draft });
        expect(sent).toHaveBeenCalledWith(peer, draft, expect.any(String));
        expect(engine.snapshot().pending).toEqual([]);
        expect(
          engine.snapshot().dialogs.find((dialog) => dialog.peer.id === peer.id)?.topMessage?.poll,
        ).toMatchObject({ question: draft.question, quiz: true });
        expect(
          (yield* engine.sendPoll(peer, { ...draft, correctAnswer: 5 }).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(sent).toHaveBeenCalledTimes(1);
      }),
    ));
  it('applies server results to history and cache, then retracts the vote', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            getHistory: () => Effect.succeed({ messages: [source], hasOlder: false }),
          },
          store,
          { manageTabLease: false },
        );
        yield* engine.start({ apiId: 1, apiHash: 'fixture' });
        yield* engine.loadConversationView(peer.id);
        yield* engine.updatePoll(peer, 81, 'vote', ['00']);
        expect((yield* store.loadMessage(peer.id, 81))?.poll?.results).toMatchObject({
          totalVoters: 1,
          answers: [
            { option: '00', chosen: true, voters: 1 },
            { option: '01', chosen: false, voters: 0 },
          ],
        });
        yield* engine.updatePoll(peer, 81, 'vote', []);
        expect((yield* store.loadMessage(peer.id, 81))?.poll?.results.totalVoters).toBe(0);
        yield* engine.updatePoll(peer, 81, 'close');
        expect((yield* store.loadMessage(peer.id, 81))?.poll?.closed).toBe(true);
        expect((yield* engine.updatePoll(peer, 81, 'vote', ['01']).pipe(Effect.result))._tag).toBe(
          'Failure',
        );
      }),
    ));
  it('leaves the vote untouched on failure and rejects invalid answers before RPC', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const updatePoll = vi.fn(() => Effect.fail(createMtprotoError('transport', 'Offline')));
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            updatePoll,
            getHistory: () => Effect.succeed({ messages: [source], hasOlder: false }),
          },
          store,
          { manageTabLease: false },
        );
        yield* engine.start({ apiId: 1, apiHash: 'fixture' });
        yield* engine.loadConversationView(peer.id);
        for (const options of [['ff'], ['00', '01'], ['00', '00']])
          expect(
            (yield* engine.updatePoll(peer, 81, 'vote', options).pipe(Effect.result))._tag,
          ).toBe('Failure');
        expect(updatePoll).not.toHaveBeenCalled();
        expect((yield* engine.updatePoll(peer, 81, 'vote', ['00']).pipe(Effect.result))._tag).toBe(
          'Failure',
        );
        expect((yield* store.loadMessage(peer.id, 81))?.poll?.results).toEqual(poll.results);
      }),
    ));
});
