import { SecureRandom, Digest, Kdf } from 'effect/crypto';
import { Effect } from 'effect';

import { createMtprotoError } from '../errors';

const cryptoFailure = (operation: string) => (cause: unknown) =>
  createMtprotoError('crypto', `${operation} failed.`, { cause });

export const randomBytes = Effect.fn('mtproto.crypto.randomBytes')(function* (length: number) {
  if (!Number.isSafeInteger(length) || length < 0) {
    return yield* Effect.fail(
      createMtprotoError(
        'configuration',
        'Random byte length must be a non-negative safe integer.',
      ),
    );
  }
  const crypto = yield* SecureRandom.SecureRandom;
  return yield* crypto
    .randomBytes(length)
    .pipe(Effect.catchDefect((cause) => Effect.fail(cryptoFailure('Random generation')(cause))));
});

export const sha1 = Effect.fn('mtproto.crypto.sha1')(function* (data: Uint8Array) {
  const crypto = yield* Digest.Digest;
  return yield* crypto
    .digest(Digest.sha1, data)
    .pipe(Effect.catchDefect((cause) => Effect.fail(cryptoFailure('SHA-1')(cause))));
});

export const sha256 = Effect.fn('mtproto.crypto.sha256')(function* (data: Uint8Array) {
  const crypto = yield* Digest.Digest;
  return yield* crypto
    .digest(Digest.sha256, data)
    .pipe(Effect.catchDefect((cause) => Effect.fail(cryptoFailure('SHA-256')(cause))));
});

export const pbkdf2Sha512 = Effect.fn('mtproto.crypto.pbkdf2Sha512')(function* (
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  bits: number,
) {
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    return yield* Effect.fail(
      createMtprotoError('configuration', 'PBKDF2 iterations must be a positive safe integer.'),
    );
  }
  if (!Number.isSafeInteger(bits) || bits <= 0 || bits % 8 !== 0) {
    return yield* Effect.fail(
      createMtprotoError(
        'configuration',
        'PBKDF2 output length must be a positive multiple of eight bits.',
      ),
    );
  }
  const kdf = yield* Kdf.Kdf;
  return yield* kdf
    .derive(Kdf.pbkdf2({ hash: Digest.sha512, iterations }), password, { salt, length: bits / 8 })
    .pipe(Effect.mapError(cryptoFailure('PBKDF2-SHA512')));
});
