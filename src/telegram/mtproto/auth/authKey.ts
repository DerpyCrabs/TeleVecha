import { bigIntToBytes, bytesToBigInt, concatBytes } from '../bytes';
import { browserCrypto, type CryptoAdapter } from '../crypto';

export interface AuthKey {
  readonly bytes: Uint8Array;
  readonly hash: Uint8Array;
  readonly auxHash: bigint;
  readonly id: bigint;
  calculateNewNonceHash(newNonce: bigint, number: 1 | 2 | 3): Promise<bigint>;
}

export async function createAuthKey(
  bytes: Uint8Array,
  crypto: Pick<CryptoAdapter, 'sha1'> = browserCrypto(),
): Promise<AuthKey> {
  if (bytes.byteLength !== 256) throw new RangeError('An MTProto auth key must contain 256 bytes.');
  const keyBytes = new Uint8Array(bytes);
  const hash = new Uint8Array(await crypto.sha1(keyBytes));
  if (hash.byteLength !== 20) throw new RangeError('SHA-1 must return 20 bytes.');
  const auxHash = bytesToBigInt(hash.subarray(0, 8), { littleEndian: true });
  const id = bytesToBigInt(hash.subarray(12, 20), { littleEndian: true });

  return Object.freeze({
    bytes: keyBytes,
    hash,
    auxHash,
    id,
    async calculateNewNonceHash(newNonce: bigint, number: 1 | 2 | 3) {
      const nonce = bigIntToBytes(newNonce, 32, { littleEndian: true, signed: true });
      const aux = bigIntToBytes(auxHash, 8, { littleEndian: true });
      const digest = await crypto.sha1(concatBytes(nonce, new Uint8Array([number]), aux));
      return bytesToBigInt(digest.subarray(4, 20), { littleEndian: true, signed: true });
    },
  });
}
