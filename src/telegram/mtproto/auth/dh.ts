import { Effect, Schedule } from 'effect';

import {
  bigIntToBytes,
  bitLength,
  bytesToBigInt,
  concatBytes,
  equalBytesConstantTime,
  hexToBytes,
  modPow,
  xorBytes,
} from '../bytes';
import { randomBytes, sha1 } from '../crypto';
import { createMtprotoError } from '../errors';

export const DH_PRIME_BYTES = 256;
const DH_PUBLIC_VALUE_SECURITY_BITS = 64;

export const TELEGRAM_DH_PRIME = hexToBytes(
  'c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f' +
    '48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c37' +
    '20fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f64' +
    '2477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a' +
    '4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754' +
    'fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae' +
    '4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851' +
    'f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b',
);

export const validateDhParameters = Effect.fn('mtproto.auth.validateDhParameters')(function* (
  primeBytes: Uint8Array,
  generator: number,
) {
  const prime = bytesToBigInt(primeBytes);
  if (
    !equalBytesConstantTime(primeBytes, TELEGRAM_DH_PRIME) ||
    !isGeneratorGood(prime, generator)
  ) {
    return yield* Effect.fail(createMtprotoError('protocol', 'Invalid DH prime or generator.'));
  }
  return prime;
});

export const validateDhPublicValue = Effect.fn('mtproto.auth.validateDhPublicValue')(function* (
  value: bigint,
  prime: bigint,
  label: string,
) {
  const threshold = 1n << BigInt(bitLength(prime) - DH_PUBLIC_VALUE_SECURITY_BITS);
  if (value <= threshold || value >= prime - threshold) {
    return yield* Effect.fail(
      createMtprotoError('protocol', `DH ${label} is outside the safe range.`),
    );
  }
});

export const generateDhPrivateExponent = Effect.fn('mtproto.auth.privateExponent')(function* (
  prime: bigint,
  serverRandom?: Uint8Array,
) {
  return yield* randomBytes(DH_PRIME_BYTES).pipe(
    Effect.map((bytes) => {
      if (serverRandom) {
        const count = Math.min(bytes.byteLength, serverRandom.byteLength);
        for (let index = 0; index < count; index += 1) {
          bytes[index] = bytes[index]! ^ serverRandom[index]!;
        }
      }
      return bytesToBigInt(bytes);
    }),
    Effect.filterOrFail(
      (exponent) => exponent > 1n && exponent < prime - 1n,
      () => createMtprotoError('crypto', 'Generated an invalid DH private exponent.'),
    ),
    Effect.retry(Schedule.recurs(127)),
  );
});

export const deriveTemporaryAes = Effect.fn('mtproto.auth.temporaryAes')(function* (
  serverNonce: bigint,
  newNonce: bigint,
) {
  const server = bigIntToBytes(serverNonce, 16, { littleEndian: true, signed: true });
  const fresh = bigIntToBytes(newNonce, 32, { littleEndian: true, signed: true });
  const [first, second, third] = yield* Effect.all(
    [
      sha1(concatBytes(fresh, server)),
      sha1(concatBytes(server, fresh)),
      sha1(concatBytes(fresh, fresh)),
    ],
    { concurrency: 'unbounded' },
  );
  return {
    key: concatBytes(first, second.subarray(0, 12)),
    iv: concatBytes(second.subarray(12, 20), third, fresh.subarray(0, 4)),
  };
});

export function calculateServerSalt(newNonce: bigint, serverNonce: bigint) {
  const fresh = bigIntToBytes(newNonce, 32, { littleEndian: true, signed: true });
  const server = bigIntToBytes(serverNonce, 16, { littleEndian: true, signed: true });
  return bytesToBigInt(xorBytes(fresh.subarray(0, 8), server.subarray(0, 8)), {
    littleEndian: true,
    signed: true,
  });
}

export const calculateDhValues = Effect.fn('mtproto.auth.calculateDhValues')(function* (
  generator: number,
  serverPublic: bigint,
  privateExponent: bigint,
  prime: bigint,
) {
  const clientPublic = modPow(BigInt(generator), privateExponent, prime);
  yield* validateDhPublicValue(clientPublic, prime, 'g_b');
  return { clientPublic, sharedSecret: modPow(serverPublic, privateExponent, prime) };
});

function isGeneratorGood(prime: bigint, generator: number) {
  if (generator === 2) return prime % 8n === 7n;
  if (generator === 3) return prime % 3n === 2n;
  if (generator === 4) return true;
  if (generator === 5) return prime % 5n === 1n || prime % 5n === 4n;
  if (generator === 6) return prime % 24n === 19n || prime % 24n === 23n;
  if (generator === 7) return [3n, 5n, 6n].includes(prime % 7n);
  return false;
}
