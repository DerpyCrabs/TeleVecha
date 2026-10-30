import { SecureRandom, Digest } from 'effect/crypto';
import { Effect, Stream } from 'effect';

import * as Socket from 'effect/socket/Socket';

import { createAesCtr } from '../crypto';
import { createMtprotoError } from '../errors';
import { createObfuscatedAbridgedCodec } from './abridged';
import type { PacketConnection, StreamingCipherFactory } from './types';

export function telegramWebSocketUrl(input: {
  host: string;
  port?: number;
  test?: boolean;
  premium?: boolean;
}) {
  const port = input.port ?? 443;
  const suffix = `${input.test ? '_test' : ''}${input.premium ? '_premium' : ''}`;
  return `wss://${input.host}:${port}/apiws${suffix}`;
}

export function createWebSocketPacketConnection(options: {
  url: string;
  createCipher?: StreamingCipherFactory;
  connectTimeoutMs?: number;
}): PacketConnection<(SecureRandom.SecureRandom | Digest.Digest) | Socket.WebSocketConstructor> {
  return {
    packets: (outgoing) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const codec = yield* createObfuscatedAbridgedCodec({
            createCipher: options.createCipher ?? createAesCtr,
          });
          const socket = yield* Socket.makeWebSocket(options.url, {
            protocols: 'binary',
            openTimeout: options.connectTimeoutMs ?? 10_000,
          });
          return Stream.concat(
            Stream.succeed(codec.initialPacket()),
            outgoing.pipe(Stream.mapEffect((packet) => codec.encodePacket(packet))),
          ).pipe(
            Stream.pipeThroughChannelOrFail(Socket.toChannel(socket)),
            Stream.mapError((cause) =>
              createMtprotoError('transport', 'Telegram WebSocket failed.', { cause }),
            ),
            Stream.mapEffect((chunk) => codec.accept(chunk)),
            Stream.flattenIterable,
          );
        }),
      ),
  };
}
