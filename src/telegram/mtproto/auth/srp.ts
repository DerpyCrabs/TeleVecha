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
import { pbkdf2Sha512, randomBytes, sha256 } from '../crypto';
import { createMtprotoError } from '../errors';
import { TELEGRAM_DH_PRIME, validateDhParameters } from './dh';

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

export const computePasswordHash = Effect.fn('mtproto.auth.passwordHash')(function* (
  algorithm: PasswordKdfAlgorithm,
  password: string,
) {
  const first = yield* sha256(concatBytes(algorithm.salt1, utf8Bytes(password), algorithm.salt1));
  const second = yield* sha256(concatBytes(algorithm.salt2, first, algorithm.salt2));
  const stretched = yield* pbkdf2Sha512(second, algorithm.salt1, 100_000, 512);
  return yield* sha256(concatBytes(algorithm.salt2, stretched, algorithm.salt2));
});

export const computePasswordSrpCheck = Effect.fn('mtproto.auth.passwordSrpCheck')(function* (
  state: PasswordSrpState,
  password: string,
) {
  const algorithm = state.currentAlgo;
  if (!algorithm)
    return yield* Effect.fail(
      createMtprotoError('protocol', 'Telegram did not provide a password algorithm.'),
    );
  yield* validatePasswordAlgorithm(algorithm);
  if (!state.srpB || state.srpId === undefined) {
    return yield* Effect.fail(
      createMtprotoError('protocol', 'Telegram did not provide complete SRP state.'),
    );
  }

  const p = bytesToBigInt(algorithm.p);
  const B = bytesToBigInt(state.srpB);
  if (B <= 0n || B >= p)
    return yield* Effect.fail(createMtprotoError('protocol', 'SRP B is outside the modulus.'));

  const passwordHash = yield* computePasswordHash(algorithm, password);
  const x = bytesToBigInt(passwordHash);
  const pBytes = paddedNumber(p);
  const gBytes = paddedNumber(BigInt(algorithm.g));
  if (state.srpB.byteLength > HASH_NUMBER_BYTES) {
    return yield* Effect.fail(
      createMtprotoError('protocol', 'SRP number exceeds the modulus size.'),
    );
  }
  const bBytes = concatBytes(new Uint8Array(HASH_NUMBER_BYTES - state.srpB.byteLength), state.srpB);
  const gX = modPow(BigInt(algorithm.g), x, p);
  const k = bytesToBigInt(yield* sha256(concatBytes(pBytes, gBytes)));
  const kgX = mod(k * gX, p);

  const { privateValue, publicBytes, scrambling } = yield* generateClientValue(
    algorithm.g,
    p,
    bBytes,
  );
  const adjustedServer = mod(B - kgX, p);
  yield* requireSafeModExp(adjustedServer, p, 'SRP g_b');
  const sharedSecret = modPow(adjustedServer, privateValue + scrambling * x, p);

  const [sessionKey, pHash, gHash, salt1Hash, salt2Hash] = yield* Effect.all(
    [
      sha256(paddedNumber(sharedSecret)),
      sha256(pBytes),
      sha256(gBytes),
      sha256(algorithm.salt1),
      sha256(algorithm.salt2),
    ],
    { concurrency: 'unbounded' },
  );
  const proof = yield* sha256(
    concatBytes(xorBytes(pHash, gHash), salt1Hash, salt2Hash, publicBytes, bBytes, sessionKey),
  );

  return {
    _: 'inputCheckPasswordSRP' as const,
    srpId: state.srpId,
    A: publicBytes,
    M1: proof,
  } satisfies InputCheckPasswordSrp;
});

export const computePasswordDigest = Effect.fn('mtproto.auth.passwordDigest')(function* (
  algorithm: PasswordKdfAlgorithm,
  password: string,
) {
  yield* validatePasswordAlgorithm(algorithm);
  const p = bytesToBigInt(algorithm.p);
  const hash = yield* computePasswordHash(algorithm, password);
  return paddedNumber(modPow(BigInt(algorithm.g), bytesToBigInt(hash), p));
});

const validatePasswordAlgorithm = Effect.fn('mtproto.auth.validatePasswordAlgorithm')(function* (
  algorithm: PasswordKdfAlgorithm,
) {
  if (!equalBytesConstantTime(algorithm.p, TELEGRAM_DH_PRIME)) {
    return yield* Effect.fail(createMtprotoError('protocol', 'Unsupported password modulus.'));
  }
  return yield* validateDhParameters(algorithm.p, algorithm.g).pipe(
    Effect.asVoid,
    Effect.mapError(() => createMtprotoError('protocol', 'Unsupported password generator.')),
  );
});

const generateClientValue = Effect.fn('mtproto.auth.srpClientValue')(function* (
  generator: number,
  prime: bigint,
  serverPublicBytes: Uint8Array,
) {
  return yield* Effect.gen(function* () {
    const privateValue = bytesToBigInt(yield* randomBytes(HASH_NUMBER_BYTES));
    const publicValue = modPow(BigInt(generator), privateValue, prime);
    if (!isSafeModExp(publicValue, prime)) {
      return yield* Effect.fail(createMtprotoError('crypto', 'Generated an unsafe SRP value.'));
    }
    const publicBytes = paddedNumber(publicValue);
    const scrambling = bytesToBigInt(yield* sha256(concatBytes(publicBytes, serverPublicBytes)));
    return yield* scrambling > 0n
      ? Effect.succeed({ privateValue, publicBytes, scrambling })
      : Effect.fail(createMtprotoError('crypto', 'Generated an invalid SRP scramble.'));
  }).pipe(Effect.retry(Schedule.recurs(PRIVATE_RANDOM_ATTEMPTS - 1)));
});

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

const requireSafeModExp = Effect.fn('mtproto.auth.requireSafeModExp')(function* (
  value: bigint,
  prime: bigint,
  label: string,
) {
  if (!isSafeModExp(value, prime)) {
    return yield* Effect.fail(
      createMtprotoError('protocol', `${label} is outside the safe range.`),
    );
  }
});
import { Effect, Schedule } from 'effect';
