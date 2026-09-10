import { BrowserCrypto } from '@effect/platform-browser';
import { Effect, Fiber, PubSub, Stream } from 'effect';
import * as Socket from 'effect/unstable/socket/Socket';
import { describe, expect, it } from 'vitest';

import type { AuthKey } from '../auth';
import type { PacketConnection } from '../connection';
import { createMtprotoError } from '../errors';
import { createMtprotoSender } from './sender';
import type { MtprotoSender, MtprotoSenderOptions, TlCodec } from './types';

const key: AuthKey = {
  bytes: Uint8Array.from({ length: 256 }, (_, index) => index),
  hash: new Uint8Array(20),
  auxHash: 0n,
  id: 123n,
  calculateNewNonceHash: () => Effect.succeed(0n),
};

const codec: TlCodec = {
  encode: () => Uint8Array.of(1, 0, 0, 0),
  decode: () => ({ _: 'unused' }),
  resultTypeFor: () => undefined,
};

const unusedSocket = (() => {
  throw new Error('Unexpected WebSocket construction.');
}) as Socket.WebSocketConstructor['Service'];

const providePlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(BrowserCrypto.layer),
    Effect.provideService(Socket.WebSocketConstructor, unusedSocket),
  ) as Effect.Effect<
    A,
    E,
    Exclude<R, import('effect').Crypto.Crypto | Socket.WebSocketConstructor>
  >;

const connectionDouble = Effect.gen(function* () {
  const incoming = yield* PubSub.sliding<Uint8Array>(8);
  const sent: Uint8Array[] = [];
  let closed = false;
  const connection: PacketConnection = {
    packets: (outgoing) =>
      Stream.merge(
        Stream.fromPubSub(incoming),
        outgoing.pipe(
          Stream.tap((packet) =>
            Effect.sync(() => {
              sent.push(packet);
            }),
          ),
          Stream.drain,
        ),
      ).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            closed = true;
          }),
        ),
      ),
  };
  return { connection, sent, incoming, closed: () => closed };
});

const senderOptions = (connection: PacketConnection): MtprotoSenderOptions => ({
  dcId: 2,
  connection,
  codec,
  authKey: key,
  authorize: () => Effect.fail(createMtprotoError('protocol', 'Stored keys skip authorization.')),
  onAuthKey: () => Effect.void,
  reconnect: { retries: 0, delayMs: 0 },
});

const withSender = <A, E>(
  use: (
    sender: MtprotoSender,
    connection: Effect.Success<typeof connectionDouble>,
  ) => Effect.Effect<A, E, never>,
  options: (connection: PacketConnection) => MtprotoSenderOptions = senderOptions,
) =>
  Effect.scoped(
    providePlatform(
      Effect.gen(function* () {
        const connection = yield* connectionDouble;
        const sender = yield* createMtprotoSender(options(connection.connection));
        return yield* use(sender, connection);
      }),
    ),
  );

describe('MTProto sender', () => {
  it('rejects invalid queue and deadline configuration in the typed channel', () =>
    Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const connection = yield* connectionDouble;
            const invalidTimeout = yield* createMtprotoSender({
              ...senderOptions(connection.connection),
              requestTimeoutMs: 0,
            }).pipe(Effect.result);
            const invalidCapacity = yield* createMtprotoSender({
              ...senderOptions(connection.connection),
              receiveQueueCapacity: 0,
            }).pipe(Effect.result);
            expect(invalidTimeout).toMatchObject({
              _tag: 'Failure',
              failure: { _tag: 'MtprotoError', kind: 'configuration' },
            });
            expect(invalidCapacity._tag).toBe('Failure');
          }),
        ),
      ),
    ));

  it('starts its connection supervisor inside the enclosing scope', () =>
    Effect.runPromise(
      withSender((sender, connection) =>
        Effect.gen(function* () {
          expect(yield* sender.connected).toBe(true);
          expect(connection.sent).toEqual([]);
        }),
      ),
    ));

  it('reconnects when the packet stream closes without an error', () =>
    Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const reconnected = yield* PubSub.sliding<void>(1);
            let attempts = 0;
            const connection: PacketConnection = {
              packets: () => {
                attempts += 1;
                if (attempts === 1) return Stream.empty;
                return Stream.fromPubSub(reconnected).pipe(Stream.drain);
              },
            };
            const sender = yield* createMtprotoSender({
              ...senderOptions(connection),
              reconnect: { retries: 1, delayMs: 0 },
            });
            yield* Effect.repeat(
              Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => attempts))),
              { until: (count) => count === 2 },
            );
            expect(attempts).toBe(2);
            expect(yield* sender.connected).toBe(true);
          }),
        ),
      ),
    ));

  it('fails unanswered RPCs at the sender deadline', () =>
    Effect.runPromise(
      withSender(
        (sender) =>
          Effect.gen(function* () {
            const result = yield* sender.invoke({ _: 'messages.getHistory' }).pipe(Effect.result);
            expect(result).toMatchObject({
              _tag: 'Failure',
              failure: {
                _tag: 'MtprotoError',
                kind: 'transport',
                message: expect.stringContaining('timed out') as unknown,
              },
            });
          }),
        (connection) => ({ ...senderOptions(connection), requestTimeoutMs: 1 }),
      ),
    ));

  it('interrupts pending requests without retaining a Promise registry', () =>
    Effect.runPromise(
      withSender((sender) =>
        Effect.gen(function* () {
          const request = yield* sender
            .invoke({ _: 'messages.sendMessage' })
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(request);
          expect(yield* sender.connected).toBe(true);
        }),
      ),
    ));

  it('releases the packet stream when its scope closes', async () => {
    let isClosed = () => false;
    await Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const connection = yield* connectionDouble;
            isClosed = connection.closed;
            yield* createMtprotoSender(senderOptions(connection.connection));
          }),
        ),
      ),
    );
    expect(isClosed()).toBe(true);
  });
});
