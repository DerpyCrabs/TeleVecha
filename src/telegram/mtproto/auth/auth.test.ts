import { BrowserCrypto } from '@effect/platform-browser';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { bigIntToBytes, bytesToBigInt, bytesToHex, concatBytes, modPow } from '../bytes';
import { sha256 } from '../crypto';
import {
  createAuthKey,
  computePasswordDigest,
  computePasswordHash,
  computePasswordSrpCheck,
  factorizePq,
  TELEGRAM_DH_PRIME,
  validateDhParameters,
  validateDhPublicValue,
} from './index';

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BrowserCrypto.layer)) as Effect.Effect<A, E>);

describe('MTProto authorization security', () => {
  it('factors bounded server semiprimes and rejects invalid values', () => {
    expect(factorizePq(323n)).toEqual({ p: 17n, q: 19n });
    expect(factorizePq(0x17ed_4894_1a08_f981n)).toEqual({ p: 1_229_739_323n, q: 1_402_015_859n });
    for (const value of [0n, 1n, 2n, 3n, 4n, 5n, 17n, 45n, 49n]) {
      expect(() => factorizePq(value)).toThrow();
    }
  });

  it('accepts only the pinned DH modulus and safe public values', () =>
    run(
      Effect.gen(function* () {
        const prime = yield* validateDhParameters(TELEGRAM_DH_PRIME, 3);
        const threshold = 1n << 1_984n;
        expect(
          (yield* validateDhPublicValue(threshold + 1n, prime, 'test').pipe(Effect.result))._tag,
        ).toBe('Success');
        expect(
          (yield* validateDhPublicValue(threshold, prime, 'test').pipe(Effect.result))._tag,
        ).toBe('Failure');
        const changed = new Uint8Array(TELEGRAM_DH_PRIME);
        changed[0] = changed[0]! ^ 1;
        expect((yield* validateDhParameters(changed, 3).pipe(Effect.result))._tag).toBe('Failure');
      }),
    ));

  it('derives the auth-key identity and nonce hashes in the error channel', () =>
    run(
      Effect.gen(function* () {
        const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
        const key = yield* createAuthKey(bytes);
        expect(bytesToHex(key.hash)).toBe('4916d6bdb7f78e6803698cab32d1586ea457dfc8');
        expect(key.auxHash).toBe(7_534_231_595_173_418_569n);
        expect(key.id).toBe(14_474_384_091_129_631_026n);
        expect(yield* key.calculateNewNonceHash(123n, 1)).toBeTypeOf('bigint');
      }),
    ));

  it('computes a deterministic password SRP proof', () =>
    run(
      Effect.gen(function* () {
        const algorithm = {
          salt1: new Uint8Array([1, 3, 5, 7]),
          salt2: new Uint8Array([2, 4, 6, 8]),
          g: 3,
          p: TELEGRAM_DH_PRIME,
        };
        const prime = bytesToBigInt(algorithm.p);
        const passwordHash = yield* computePasswordHash(algorithm, 'correct horse');
        const paddedPrime = bigIntToBytes(prime, 256);
        const multiplier = bytesToBigInt(
          yield* sha256(concatBytes(paddedPrime, bigIntToBytes(3n, 256))),
        );
        const verifier = modPow(3n, bytesToBigInt(passwordHash), prime);
        const serverPublic = (multiplier * verifier + modPow(3n, 654_321n, prime)) % prime;
        const proof = yield* computePasswordSrpCheck(
          { currentAlgo: algorithm, srpB: bigIntToBytes(serverPublic, 256), srpId: 42n },
          'correct horse',
        );
        expect(proof._).toBe('inputCheckPasswordSRP');
        expect(proof.srpId).toBe(42n);
        expect(proof.A).toHaveLength(256);
        expect(proof.M1).toHaveLength(32);
      }),
    ));

  it('rejects an SRP generator incompatible with the pinned modulus', () =>
    run(
      Effect.gen(function* () {
        const algorithm = {
          salt1: new Uint8Array([1]),
          salt2: new Uint8Array([2]),
          g: 5,
          p: TELEGRAM_DH_PRIME,
        };
        expect((yield* computePasswordDigest(algorithm, 'password').pipe(Effect.result))._tag).toBe(
          'Failure',
        );
        expect(
          (yield* computePasswordSrpCheck(
            { currentAlgo: algorithm, srpB: new Uint8Array(256), srpId: 1n },
            'x',
          ).pipe(Effect.result))._tag,
        ).toBe('Failure');
      }),
    ));
});
