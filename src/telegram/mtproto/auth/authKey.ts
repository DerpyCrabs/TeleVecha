import { SecureRandom, Digest } from 'effect/crypto';
import { Effect } from 'effect';

import { bigIntToBytes, bytesToBigInt, concatBytes } from '../bytes';
import { createMtprotoError, type MtprotoError } from '../errors';
import { sha1 } from '../crypto';

export interface AuthKey {
  readonly bytes: Uint8Array;
  readonly hash: Uint8Array;
  readonly auxHash: bigint;
  readonly id: bigint;
  readonly calculateNewNonceHash: (
    newNonce: bigint,
    number: 1 | 2 | 3,
  ) => Effect.Effect<bigint, MtprotoError, SecureRandom.SecureRandom | Digest.Digest>;
}

export const createAuthKey = Effect.fn('mtproto.auth.createKey')(function* (bytes: Uint8Array) {
  if (bytes.byteLength !== 256) {
    return yield* Effect.fail(
      createMtprotoError('configuration', 'An MTProto auth key must contain 256 bytes.'),
    );
  }
  const keyBytes = new Uint8Array(bytes);
  const hash = yield* sha1(keyBytes);
  if (hash.byteLength !== 20) {
    return yield* Effect.fail(createMtprotoError('crypto', 'SHA-1 must return 20 bytes.'));
  }
  const auxHash = bytesToBigInt(hash.subarray(0, 8), { littleEndian: true });
  const id = bytesToBigInt(hash.subarray(12, 20), { littleEndian: true });

  return {
    bytes: keyBytes,
    hash,
    auxHash,
    id,
    calculateNewNonceHash: Effect.fn('mtproto.auth.newNonceHash')(function* (
      newNonce: bigint,
      number: 1 | 2 | 3,
    ) {
      const nonce = bigIntToBytes(newNonce, 32, { littleEndian: true, signed: true });
      const aux = bigIntToBytes(auxHash, 8, { littleEndian: true });
      const digest = yield* sha1(concatBytes(nonce, new Uint8Array([number]), aux));
      return bytesToBigInt(digest.subarray(4, 20), { littleEndian: true, signed: true });
    }),
  } satisfies AuthKey;
});
