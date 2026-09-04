import { Crypto, Effect, Schedule } from 'effect';

import { createMtprotoError, errorMessage, isMtprotoError } from '../errors';
import type { PacketCodec, StreamingCipherFactory } from './types';

const ALIGNMENT = 4;
const HEADER_LENGTH = 64;
const MAX_WORD_COUNT = 0x00ff_ffff;
const OBFUSCATED_ABRIDGED_TAG = Uint8Array.of(0xef, 0xef, 0xef, 0xef);
const FORBIDDEN_PREFIXES = [
  Uint8Array.of(0x48, 0x45, 0x41, 0x44),
  Uint8Array.of(0x50, 0x4f, 0x53, 0x54),
  Uint8Array.of(0x47, 0x45, 0x54, 0x20),
  Uint8Array.of(0x4f, 0x50, 0x54, 0x49),
  Uint8Array.of(0x16, 0x03, 0x01, 0x02),
  Uint8Array.of(0xdd, 0xdd, 0xdd, 0xdd),
  Uint8Array.of(0xee, 0xee, 0xee, 0xee),
];

function equal(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function concat(left: Uint8Array, right: Uint8Array) {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left.slice();
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

function validHeader(header: Uint8Array) {
  if (header[0] === 0xef) return false;
  if (FORBIDDEN_PREFIXES.some((prefix) => equal(header.subarray(0, 4), prefix))) return false;
  return !equal(header.subarray(4, 8), new Uint8Array(4));
}

function packetPrefix(payloadLength: number) {
  if (payloadLength === 0 || payloadLength % ALIGNMENT !== 0) {
    throw new Error('MTProto abridged packets must be non-empty and four-byte aligned.');
  }
  const words = payloadLength / ALIGNMENT;
  if (words > MAX_WORD_COUNT) throw new Error('MTProto abridged packet is too large.');
  if (words < 0x7f) return Uint8Array.of(words);
  return Uint8Array.of(0x7f, words & 0xff, (words >>> 8) & 0xff, (words >>> 16) & 0xff);
}

export const createObfuscatedAbridgedCodec = Effect.fn('mtproto.connection.abridged')(
  function* (options: { createCipher: StreamingCipherFactory }) {
    const crypto = yield* Crypto.Crypto;
    const header = yield* crypto.randomBytes(HEADER_LENGTH).pipe(
      Effect.mapError((cause) =>
        createMtprotoError('crypto', 'Could not create an MTProto obfuscation header.', { cause }),
      ),
      Effect.filterOrFail(validHeader, () =>
        createMtprotoError('crypto', 'Generated an invalid MTProto obfuscation header.'),
      ),
      Effect.retry(Schedule.recurs(255)),
      Effect.map((bytes) => bytes.slice()),
    );
    const reversed = header.slice(8, 56).reverse();
    const [encryptor, decryptor] = yield* Effect.try({
      try: () =>
        [
          options.createCipher(header.slice(8, 40), header.slice(40, 56)),
          options.createCipher(reversed.slice(0, 32), reversed.slice(32, 48)),
        ] as const,
      catch: (cause) =>
        createMtprotoError(
          'crypto',
          `Could not initialize MTProto encryption: ${errorMessage(cause)}`,
          {
            cause,
          },
        ),
    });
    header.set(OBFUSCATED_ABRIDGED_TAG, 56);
    const encryptedHeader = encryptor.transform(header);
    header.set(encryptedHeader.subarray(56, 64), 56);

    let received = new Uint8Array(0);

    return {
      initialPacket() {
        return header.slice();
      },
      encodePacket(payload) {
        return Effect.try({
          try: () => encryptor.transform(concat(packetPrefix(payload.length), payload)),
          catch: (cause) =>
            createMtprotoError(
              'protocol',
              `Could not encode an MTProto packet: ${errorMessage(cause)}`,
              {
                cause,
              },
            ),
        });
      },
      accept(chunk) {
        return Effect.try({
          try: () => {
            if (chunk.length > 0) received = concat(received, decryptor.transform(chunk));
            const packets: Uint8Array[] = [];
            while (received.length > 0) {
              if (received[0]! > 0x7f) {
                received = new Uint8Array(0);
                throw createMtprotoError(
                  'protocol',
                  'Telegram sent an invalid abridged packet length.',
                );
              }
              const prefixLength = received[0] === 0x7f ? 4 : 1;
              if (received.length < prefixLength) break;
              const words =
                prefixLength === 1
                  ? received[0]!
                  : received[1]! | (received[2]! << 8) | (received[3]! << 16);
              if (words === 0 || words > MAX_WORD_COUNT) {
                received = new Uint8Array(0);
                throw createMtprotoError(
                  'protocol',
                  'Telegram sent an invalid abridged packet length.',
                );
              }
              const payloadLength = words * ALIGNMENT;
              if (received.length < prefixLength + payloadLength) break;
              packets.push(received.slice(prefixLength, prefixLength + payloadLength));
              received = received.slice(prefixLength + payloadLength);
            }
            return packets;
          },
          catch: (cause) =>
            isMtprotoError(cause)
              ? cause
              : createMtprotoError('protocol', errorMessage(cause), { cause }),
        });
      },
    } satisfies PacketCodec;
  },
);
