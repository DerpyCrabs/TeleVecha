import { Crypto, Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { createObfuscatedAbridgedCodec } from './abridged';

const identityCipher = () => ({ transform: (data: Uint8Array) => data.slice() });
const validHeader = () => Uint8Array.from({ length: 64 }, (_, index) => index + 1);
const testCrypto = Crypto.make({
  randomBytes: validHeader,
  digest: (_algorithm, data) => Effect.succeed(data),
});
const run = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(Crypto.Crypto, testCrypto)));

const concat = (...parts: readonly Uint8Array[]) => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

describe('obfuscated abridged transport', () => {
  it('creates the obfuscation header and keeps cipher state private', () =>
    run(
      Effect.gen(function* () {
        const cipherInputs: Array<{ key: Uint8Array; iv: Uint8Array }> = [];
        const codec = yield* createObfuscatedAbridgedCodec({
          createCipher(key, iv) {
            cipherInputs.push({ key: key.slice(), iv: iv.slice() });
            return identityCipher();
          },
        });
        const first = codec.initialPacket();
        first.fill(0);
        const second = codec.initialPacket();
        expect(second.slice(56, 60)).toEqual(Uint8Array.of(0xef, 0xef, 0xef, 0xef));
        expect(second[0]).toBe(1);
        expect(cipherInputs).toHaveLength(2);
        expect(cipherInputs[0]?.key).toEqual(validHeader().slice(8, 40));
        const reversed = validHeader().slice(8, 56).reverse();
        expect(cipherInputs[1]?.key).toEqual(reversed.slice(0, 32));
      }),
    ));

  it('frames short and extended packets across arbitrary chunks', () =>
    run(
      Effect.gen(function* () {
        const codec = yield* createObfuscatedAbridgedCodec({ createCipher: identityCipher });
        const short = Uint8Array.from({ length: 8 }, (_, index) => index + 10);
        const extended = Uint8Array.from({ length: 508 }, (_, index) => index & 0xff);
        const encodedShort = yield* codec.encodePacket(short);
        const encodedExtended = yield* codec.encodePacket(extended);
        expect(encodedShort[0]).toBe(2);
        expect(encodedExtended.slice(0, 4)).toEqual(Uint8Array.of(0x7f, 0x7f, 0, 0));
        const stream = concat(encodedShort, encodedExtended);
        expect(yield* codec.accept(stream.slice(0, 2))).toEqual([]);
        expect(yield* codec.accept(stream.slice(2, 100))).toEqual([short]);
        expect(yield* codec.accept(stream.slice(100))).toEqual([extended]);
      }),
    ));

  it('rejects malformed packet lengths before allocating payloads', () =>
    run(
      Effect.gen(function* () {
        const codec = yield* createObfuscatedAbridgedCodec({ createCipher: identityCipher });
        expect((yield* codec.encodePacket(new Uint8Array(0)).pipe(Effect.result))._tag).toBe(
          'Failure',
        );
        expect((yield* codec.encodePacket(new Uint8Array(3)).pipe(Effect.result))._tag).toBe(
          'Failure',
        );
        expect((yield* codec.accept(Uint8Array.of(0)).pipe(Effect.result))._tag).toBe('Failure');
        expect((yield* codec.accept(Uint8Array.of(0x80)).pipe(Effect.result))._tag).toBe('Failure');
      }),
    ));
});
