import {
  bigIntToBytes,
  bitLength,
  bytesToBigInt,
  concatBytes,
  equalBytesConstantTime,
  mod,
  modPow,
  utf8Bytes,
  xorBytes,
} from '../bytes';
import { browserCrypto, type CryptoAdapter } from '../crypto';
import { createMtprotoError } from '../errors';
import { TELEGRAM_DH_PRIME } from './dh';

const HASH_NUMBER_BYTES = 256;
const PRIVATE_RANDOM_ATTEMPTS = 128;

export interface PasswordKdfAlgorithm {
  readonly salt1: Uint8Array;
  readonly salt2: Uint8Array;
  readonly g: number;
  readonly p: Uint8Array;
}

export interface PasswordSrpState {
  readonly currentAlgo?: PasswordKdfAlgorithm | undefined;
  readonly srpB?: Uint8Array | undefined;
  readonly srpId?: bigint | undefined;
}

export interface InputCheckPasswordSrp {
  readonly _: 'inputCheckPasswordSRP';
  readonly srpId: bigint;
  readonly A: Uint8Array;
  readonly M1: Uint8Array;
}

export async function computePasswordHash(
  algorithm: PasswordKdfAlgorithm,
  password: string,
  crypto: CryptoAdapter = browserCrypto(),
) {
  const first = await crypto.sha256(
    concatBytes(algorithm.salt1, utf8Bytes(password), algorithm.salt1),
  );
  const second = await crypto.sha256(concatBytes(algorithm.salt2, first, algorithm.salt2));
  const stretched = await crypto.pbkdf2Sha512(second, algorithm.salt1, 100_000, 512);
  return crypto.sha256(concatBytes(algorithm.salt2, stretched, algorithm.salt2));
}

export async function computePasswordSrpCheck(
  state: PasswordSrpState,
  password: string,
  crypto: CryptoAdapter = browserCrypto(),
): Promise<InputCheckPasswordSrp> {
  const algorithm = state.currentAlgo;
  if (!algorithm)
    throw createMtprotoError('protocol', 'Telegram did not provide a password algorithm.');
  validatePasswordAlgorithm(algorithm);
  if (!state.srpB || state.srpId === undefined) {
    throw createMtprotoError('protocol', 'Telegram did not provide complete SRP state.');
  }

  const p = bytesToBigInt(algorithm.p);
  const B = bytesToBigInt(state.srpB);
  if (B <= 0n || B >= p) throw createMtprotoError('protocol', 'SRP B is outside the modulus.');

  const passwordHash = await computePasswordHash(algorithm, password, crypto);
  const x = bytesToBigInt(passwordHash);
  const pBytes = paddedNumber(p);
  const gBytes = paddedNumber(BigInt(algorithm.g));
  const bBytes = paddedBytes(state.srpB);
  const gX = modPow(BigInt(algorithm.g), x, p);
  const k = bytesToBigInt(await crypto.sha256(concatBytes(pBytes, gBytes)));
  const kgX = mod(k * gX, p);

  const { privateValue, publicBytes, scrambling } = await generateClientValue(
    algorithm.g,
    p,
    bBytes,
    crypto,
  );
  const adjustedServer = mod(B - kgX, p);
  requireSafeModExp(adjustedServer, p, 'SRP g_b');
  const sharedSecret = modPow(adjustedServer, privateValue + scrambling * x, p);

  const [sessionKey, pHash, gHash, salt1Hash, salt2Hash] = await Promise.all([
    crypto.sha256(paddedNumber(sharedSecret)),
    crypto.sha256(pBytes),
    crypto.sha256(gBytes),
    crypto.sha256(algorithm.salt1),
    crypto.sha256(algorithm.salt2),
  ]);
  const proof = await crypto.sha256(
    concatBytes(xorBytes(pHash, gHash), salt1Hash, salt2Hash, publicBytes, bBytes, sessionKey),
  );

  return Object.freeze({
    _: 'inputCheckPasswordSRP' as const,
    srpId: state.srpId,
    A: publicBytes,
    M1: proof,
  });
}

export async function computePasswordDigest(
  algorithm: PasswordKdfAlgorithm,
  password: string,
  crypto: CryptoAdapter = browserCrypto(),
) {
  validatePasswordAlgorithm(algorithm);
  const p = bytesToBigInt(algorithm.p);
  const hash = await computePasswordHash(algorithm, password, crypto);
  return paddedNumber(modPow(BigInt(algorithm.g), bytesToBigInt(hash), p));
}

function validatePasswordAlgorithm(algorithm: PasswordKdfAlgorithm) {
  if (!equalBytesConstantTime(algorithm.p, TELEGRAM_DH_PRIME)) {
    throw createMtprotoError('protocol', 'Unsupported password modulus.');
  }
  if (![3, 4, 5, 7].includes(algorithm.g)) {
    throw createMtprotoError('protocol', 'Unsupported password generator.');
  }
}

async function generateClientValue(
  generator: number,
  prime: bigint,
  serverPublicBytes: Uint8Array,
  crypto: CryptoAdapter,
) {
  for (let attempt = 0; attempt < PRIVATE_RANDOM_ATTEMPTS; attempt += 1) {
    const privateValue = bytesToBigInt(crypto.randomBytes(HASH_NUMBER_BYTES));
    const publicValue = modPow(BigInt(generator), privateValue, prime);
    if (!isSafeModExp(publicValue, prime)) continue;
    const publicBytes = paddedNumber(publicValue);
    const scrambling = bytesToBigInt(
      await crypto.sha256(concatBytes(publicBytes, serverPublicBytes)),
    );
    if (scrambling > 0n) return { privateValue, publicBytes, scrambling };
  }
  throw createMtprotoError('crypto', 'Could not generate a safe SRP client value.');
}

function paddedBytes(value: Uint8Array) {
  if (value.byteLength > HASH_NUMBER_BYTES) {
    throw createMtprotoError('protocol', 'SRP number exceeds the modulus size.');
  }
  return concatBytes(new Uint8Array(HASH_NUMBER_BYTES - value.byteLength), value);
}

function paddedNumber(value: bigint) {
  return bigIntToBytes(value, HASH_NUMBER_BYTES);
}

function isSafeModExp(value: bigint, prime: bigint) {
  const difference = prime - value;
  return (
    difference >= 0n &&
    bitLength(difference) >= 1_984 &&
    bitLength(value) >= 1_984 &&
    Math.ceil(bitLength(value) / 8) <= HASH_NUMBER_BYTES
  );
}

function requireSafeModExp(value: bigint, prime: bigint, label: string) {
  if (!isSafeModExp(value, prime)) {
    throw createMtprotoError('protocol', `${label} is outside the safe range.`);
  }
}
