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
import type { CryptoAdapter } from '../crypto';
import { createMtprotoError } from '../errors';

export const DH_PRIME_BYTES = 256;
const DH_PUBLIC_VALUE_SECURITY_BITS = 64;
const MAX_PRIVATE_EXPONENT_ATTEMPTS = 128;

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

export function validateDhParameters(primeBytes: Uint8Array, generator: number) {
  const prime = bytesToBigInt(primeBytes);
  if (
    !equalBytesConstantTime(primeBytes, TELEGRAM_DH_PRIME) ||
    !isGeneratorGood(prime, generator)
  ) {
    throw createMtprotoError('protocol', 'Invalid DH prime or generator.');
  }
  return prime;
}

export function validateDhPublicValue(value: bigint, prime: bigint, label: string) {
  if (value <= 1n || value >= prime - 1n) {
    throw createMtprotoError('protocol', `DH ${label} is outside the modulus.`);
  }
  const threshold = 1n << BigInt(bitLength(prime) - DH_PUBLIC_VALUE_SECURITY_BITS);
  if (value <= threshold || value >= prime - threshold) {
    throw createMtprotoError('protocol', `DH ${label} is outside the safe range.`);
  }
}

export function generateDhPrivateExponent(
  prime: bigint,
  randomBytes: (length: number) => Uint8Array,
  serverRandom?: Uint8Array,
) {
  for (let attempt = 0; attempt < MAX_PRIVATE_EXPONENT_ATTEMPTS; attempt += 1) {
    const bytes = randomBytes(DH_PRIME_BYTES);
    if (bytes.byteLength !== DH_PRIME_BYTES) {
      throw createMtprotoError('crypto', 'Random source returned the wrong DH exponent length.');
    }
    if (serverRandom) {
      const count = Math.min(bytes.byteLength, serverRandom.byteLength);
      for (let index = 0; index < count; index += 1) {
        bytes[index] = bytes[index]! ^ serverRandom[index]!;
      }
    }
    const exponent = bytesToBigInt(bytes);
    if (exponent > 1n && exponent < prime - 1n) return exponent;
  }
  throw createMtprotoError('crypto', 'Could not generate a valid DH private exponent.');
}

export async function deriveTemporaryAes(
  serverNonce: bigint,
  newNonce: bigint,
  crypto: Pick<CryptoAdapter, 'sha1'>,
) {
  const server = bigIntToBytes(serverNonce, 16, { littleEndian: true, signed: true });
  const fresh = bigIntToBytes(newNonce, 32, { littleEndian: true, signed: true });
  const [first, second, third] = await Promise.all([
    crypto.sha1(concatBytes(fresh, server)),
    crypto.sha1(concatBytes(server, fresh)),
    crypto.sha1(concatBytes(fresh, fresh)),
  ]);
  return Object.freeze({
    key: concatBytes(first, second.subarray(0, 12)),
    iv: concatBytes(second.subarray(12, 20), third, fresh.subarray(0, 4)),
  });
}

export function calculateServerSalt(newNonce: bigint, serverNonce: bigint) {
  const fresh = bigIntToBytes(newNonce, 32, { littleEndian: true, signed: true });
  const server = bigIntToBytes(serverNonce, 16, { littleEndian: true, signed: true });
  return bytesToBigInt(xorBytes(fresh.subarray(0, 8), server.subarray(0, 8)), {
    littleEndian: true,
    signed: true,
  });
}

export function calculateDhValues(
  generator: number,
  serverPublic: bigint,
  privateExponent: bigint,
  prime: bigint,
) {
  const clientPublic = modPow(BigInt(generator), privateExponent, prime);
  const sharedSecret = modPow(serverPublic, privateExponent, prime);
  validateDhPublicValue(clientPublic, prime, 'g_b');
  return Object.freeze({ clientPublic, sharedSecret });
}

function isGeneratorGood(prime: bigint, generator: number) {
  if (generator === 2) return prime % 8n === 7n;
  if (generator === 3) return prime % 3n === 2n;
  if (generator === 4) return true;
  if (generator === 5) return prime % 5n === 1n || prime % 5n === 4n;
  if (generator === 6) return prime % 24n === 19n || prime % 24n === 23n;
  if (generator === 7) return [3n, 5n, 6n].includes(prime % 7n);
  return false;
}
