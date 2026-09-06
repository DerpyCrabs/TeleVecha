import { Crypto, Effect } from 'effect';
import { BrowserCrypto } from '@effect/platform-browser';

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
  const crypto = yield* Crypto.Crypto;
  return yield* crypto
    .randomBytes(length)
    .pipe(Effect.mapError(cryptoFailure('Random generation')));
});

export const sha1 = Effect.fn('mtproto.crypto.sha1')(function* (data: Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.digest('SHA-1', data).pipe(Effect.mapError(cryptoFailure('SHA-1')));
});

export const sha256 = Effect.fn('mtproto.crypto.sha256')(function* (data: Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.digest('SHA-256', data).pipe(Effect.mapError(cryptoFailure('SHA-256')));
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
  const crypto = yield* BrowserCrypto.WebCrypto;
  return yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits'],
      );
      const derived = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-512', salt: new Uint8Array(salt), iterations },
        key,
        bits,
      );
      return new Uint8Array(derived);
    },
    catch: cryptoFailure('PBKDF2-SHA512'),
  });
});
