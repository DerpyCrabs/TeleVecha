import { BrowserCrypto } from '@effect/platform-browser';
import { Effect, Queue, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import * as Socket from 'effect/unstable/socket/Socket';
import { describe, expect, it, vi } from 'vitest';

import type { AuthKey } from '../auth';
import {
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  readInt32Le,
  readUint32Le,
  writeInt32Le,
} from '../bytes';
import type { PacketConnection } from '../connection';
import { aesIgeDecrypt, aesIgeEncrypt, sha256 } from '../crypto';
import { createMtprotoError, type MtprotoError } from '../errors';
import { updateEvent } from '../events';
import { decodeTl, encodeTl, resultTypeFor, type TlTypeRef } from '../tl';
import { createMtprotoSender } from './sender';
import type { TlObject } from './types';

const key: AuthKey = {
  bytes: Uint8Array.from({ length: 256 }, (_, index) => index),
  hash: new Uint8Array(20),
  auxHash: 0n,
  id: 123n,
  calculateNewNonceHash: () => Effect.succeed(0n),
};
const now = 1_700_000_000_000;
const serverId = (index: number) => (BigInt(now / 1_000) << 32n) | (BigInt(index) * 4n + 1n);
const containerId = 0x73f1f8dc;

const material = (messageKey: Uint8Array, x: number) =>
  Effect.gen(function* () {
    const first = yield* sha256(concatBytes(messageKey, key.bytes.slice(x, x + 36)));
    const second = yield* sha256(concatBytes(key.bytes.slice(40 + x, 76 + x), messageKey));
    return {
      key: concatBytes(first.slice(0, 8), second.slice(8, 24), first.slice(24, 32)),
      iv: concatBytes(second.slice(0, 8), first.slice(8, 24), second.slice(24, 32)),
    };
  });

const incomingPacket = (sessionId: bigint, messageId: bigint, seq: number, body: Uint8Array) =>
  Effect.gen(function* () {
    const header = concatBytes(
      bigIntToBytes(5n, 8, { littleEndian: true }),
      bigIntToBytes(sessionId, 8, { littleEndian: true, signed: true }),
      bigIntToBytes(messageId, 8, { littleEndian: true }),
      writeInt32Le(seq),
      writeInt32Le(body.length),
      body,
    );
    const padding = 12 + ((16 - ((header.length + 12) % 16)) % 16);
    const plaintext = concatBytes(header, new Uint8Array(padding));
    const hash = yield* sha256(concatBytes(key.bytes.slice(96, 128), plaintext));
    const messageKey = hash.slice(8, 24);
    const aes = yield* material(messageKey, 8);
    return concatBytes(
      bigIntToBytes(key.id, 8, { littleEndian: true }),
      messageKey,
      aesIgeEncrypt(aes.key, aes.iv, plaintext, { padding: 'none' }),
    );
  });

function outgoingMessages(body: Uint8Array): TlObject[] {
  if (readUint32Le(body) === 0xc4f9186b) return [{ _: 'help.getConfig' }];
  if (readUint32Le(body) === 0xf3427b8c) return [{ _: 'ping_delay_disconnect' }];
  if (readUint32Le(body) !== containerId) return [decodeTl(body) as TlObject];
  const messages: TlObject[] = [];
  let offset = 8;
  for (let index = 0; index < readInt32Le(body, 4); index += 1) {
    const length = readInt32Le(body, offset + 12);
    messages.push(...outgoingMessages(body.slice(offset + 16, offset + 16 + length)));
    offset += 16 + length;
  }
  return messages;
}

const waitUntil = (predicate: () => boolean) =>
  Effect.promise(() => vi.waitFor(() => expect(predicate()).toBe(true), { interval: 1 }));

const makeServer = Effect.gen(function* () {
  const attempts: {
    incoming: Queue.Queue<Uint8Array, MtprotoError>;
    sent: { sessionId: bigint; messages: TlObject[] }[];
    closed: boolean;
  }[] = [];
  const connection: PacketConnection<import('effect').Crypto.Crypto> = {
    packets: (outgoing) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const attempt: (typeof attempts)[number] = {
            incoming: yield* Queue.unbounded<Uint8Array, MtprotoError>(),
            sent: [],
            closed: false,
          };
          attempts.push(attempt);
          return Stream.merge(
            Stream.fromQueue(attempt.incoming),
            outgoing.pipe(
              Stream.mapEffect((packet) =>
                Effect.gen(function* () {
                  const aes = yield* material(packet.slice(8, 24), 0);
                  const data = aesIgeDecrypt(aes.key, aes.iv, packet.slice(24));
                  attempt.sent.push({
                    sessionId: bytesToBigInt(data.slice(8, 16), {
                      littleEndian: true,
                      signed: true,
                    }),
                    messages: outgoingMessages(data.slice(32, 32 + readInt32Le(data, 28))),
                  });
                }),
              ),
              Stream.drain,
            ),
          ).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                attempt.closed = true;
              }),
            ),
          );
        }),
      ),
  };
  const sender = yield* createMtprotoSender({
    dcId: 2,
    connection,
    authKey: key,
    serverSalt: 5n,
    now: () => now,
    authorize: () => Effect.fail(createMtprotoError('protocol', 'Unexpected handshake')),
    onAuthKey: () => Effect.void,
    reconnect: { retries: 1, delayMs: 10 },
    codec: {
      encode: encodeTl,
      decode: (bytes, expected) =>
        decodeTl(bytes, expected ? { expected: expected as TlTypeRef } : {}),
      resultTypeFor,
    },
  });
  const updates: unknown[] = [];
  yield* sender.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (updateEvent.is(event)) updates.push(event.update);
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* sender.invoke({ _: 'help.getConfig' }).pipe(Effect.forkScoped);
  yield* waitUntil(() => (attempts[0]?.sent.length ?? 0) > 0);
  return { sender, attempts, updates };
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(BrowserCrypto.layer),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Socket.WebSocketConstructor, () => {
        throw new Error('Unexpected WebSocket');
      }),
    ) as Effect.Effect<A, E>,
  );

describe('MTProto connection recovery', () => {
  it.each(['packet', 'container', 'whole-container'] as const)(
    'acknowledges a repeated %s without delivering updates twice',
    (repeat) =>
      run(
        Effect.gen(function* () {
          const { sender, attempts, updates } = yield* makeServer;
          const first = attempts[0]!;
          const sessionId = first.sent[0]!.sessionId;
          const body = encodeTl({ _: 'updatesTooLong' });
          const initialBody =
            repeat === 'whole-container'
              ? concatBytes(
                  writeInt32Le(containerId),
                  writeInt32Le(1),
                  bigIntToBytes(serverId(0), 8, { littleEndian: true }),
                  writeInt32Le(1),
                  writeInt32Le(body.length),
                  body,
                )
              : body;
          const packet = yield* incomingPacket(
            sessionId,
            serverId(repeat === 'whole-container' ? 1 : 0),
            repeat === 'whole-container' ? 2 : 1,
            initialBody,
          );
          const ackCount = () =>
            first.sent
              .flatMap(({ messages }) => messages)
              .filter((message) => message._ === 'msgs_ack').length;
          yield* Queue.offer(first.incoming, packet);
          yield* waitUntil(() => updates.length === 1 && ackCount() === 1);
          if (repeat !== 'container') {
            yield* Queue.offer(first.incoming, packet);
          } else {
            const container = concatBytes(
              writeInt32Le(containerId),
              writeInt32Le(2),
              bigIntToBytes(serverId(0), 8, { littleEndian: true }),
              writeInt32Le(1),
              writeInt32Le(body.length),
              body,
              bigIntToBytes(serverId(1), 8, { littleEndian: true }),
              writeInt32Le(3),
              writeInt32Le(body.length),
              body,
            );
            yield* Queue.offer(
              first.incoming,
              yield* incomingPacket(sessionId, serverId(2), 4, container),
            );
          }
          yield* waitUntil(() => ackCount() === 2);
          expect(updates.length).toBe(repeat === 'container' ? 2 : 1);
          expect(attempts.length).toBe(1);
          expect(yield* sender.connected).toBe(true);
          const ack = first.sent
            .flatMap(({ messages }) => messages)
            .filter((message) => message._ === 'msgs_ack')
            .at(-1);
          expect(ack?.msgIds).toContain(serverId(0));
        }),
      ),
  );

  it('closes a silent socket on a missed pong and reconnects promptly', () =>
    run(
      Effect.gen(function* () {
        const { sender, attempts } = yield* makeServer;
        yield* TestClock.adjust('3 seconds');
        yield* waitUntil(() =>
          attempts[0]!.sent.some(({ messages }) =>
            messages.some((message) => message._ === 'ping_delay_disconnect'),
          ),
        );
        yield* TestClock.adjust('5 seconds');
        expect(attempts[0]!.closed).toBe(true);
        expect(yield* sender.connected).toBe(false);
        yield* TestClock.adjust('10 millis');
        yield* waitUntil(() => attempts.length === 2);
        expect(yield* sender.connected).toBe(true);
      }),
    ));

  it('resets retry backoff after successful traffic across repeated disconnects', () =>
    run(
      Effect.gen(function* () {
        const { sender, attempts, updates } = yield* makeServer;
        for (let index = 0; index < 4; index += 1) {
          yield* waitUntil(() => (attempts[index]?.sent.length ?? 0) > 0);
          const attempt = attempts[index]!;
          yield* Queue.offer(
            attempt.incoming,
            yield* incomingPacket(
              attempt.sent[0]!.sessionId,
              serverId(0),
              1,
              encodeTl({ _: 'updatesTooLong' }),
            ),
          );
          yield* waitUntil(() => updates.length === index + 1);
          yield* Queue.fail(attempt.incoming, createMtprotoError('transport', 'Connection lost'));
          yield* waitUntil(() => attempt.closed);
          yield* TestClock.adjust('10 millis');
          yield* waitUntil(() => attempts.length === index + 2);
          expect(yield* sender.connected).toBe(true);
        }
        expect(attempts.length).toBe(5);
      }),
    ));

  it('bounds retries when reopened sockets never receive valid traffic', () =>
    run(
      Effect.gen(function* () {
        const { sender, attempts } = yield* makeServer;
        yield* Queue.fail(
          attempts[0]!.incoming,
          createMtprotoError('transport', 'Connection lost'),
        );
        yield* waitUntil(() => attempts[0]!.closed);
        yield* TestClock.adjust('10 millis');
        yield* waitUntil(() => (attempts[1]?.sent.length ?? 0) > 0);
        yield* Queue.fail(
          attempts[1]!.incoming,
          createMtprotoError('transport', 'Connection lost'),
        );
        yield* waitUntil(() => attempts[1]!.closed);
        yield* TestClock.adjust('1 second');
        expect(attempts.length).toBe(2);
        expect(yield* sender.connected).toBe(false);
        expect(yield* sender.invoke({ _: 'help.getConfig' }).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: { kind: 'transport' },
        });
      }),
    ));
});
