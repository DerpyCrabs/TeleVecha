import { createMtprotoError } from '../errors';

export interface CryptoAdapter {
  randomBytes(length: number): Uint8Array;
  sha1(data: Uint8Array): Promise<Uint8Array>;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  pbkdf2Sha512(
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    bits: number,
  ): Promise<Uint8Array>;
}

export function createBrowserCryptoAdapter(source: Crypto = globalThis.crypto): CryptoAdapter {
  if (!source?.subtle || typeof source.getRandomValues !== 'function') {
    throw createMtprotoError('configuration', 'WebCrypto is not available.');
  }

  const digest = async (algorithm: 'SHA-1' | 'SHA-256', data: Uint8Array) => {
    try {
      return new Uint8Array(await source.subtle.digest(algorithm, ownedBytes(data)));
    } catch (cause) {
      throw createMtprotoError('crypto', `${algorithm} failed.`, { cause });
    }
  };

  return Object.freeze({
    randomBytes(length: number) {
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new RangeError('Random byte length must be a non-negative safe integer.');
      }
      const result = new Uint8Array(length);
      for (let offset = 0; offset < result.byteLength; offset += 65_536) {
        source.getRandomValues(
          result.subarray(offset, Math.min(offset + 65_536, result.byteLength)),
        );
      }
      return result;
    },
    sha1: (data: Uint8Array) => digest('SHA-1', data),
    sha256: (data: Uint8Array) => digest('SHA-256', data),
    async pbkdf2Sha512(password: Uint8Array, salt: Uint8Array, iterations: number, bits: number) {
      if (!Number.isSafeInteger(iterations) || iterations <= 0) {
        throw new RangeError('PBKDF2 iterations must be a positive safe integer.');
      }
      if (!Number.isSafeInteger(bits) || bits <= 0 || bits % 8 !== 0) {
        throw new RangeError('PBKDF2 output length must be a positive multiple of eight bits.');
      }
      try {
        const key = await source.subtle.importKey(
          'raw',
          ownedBytes(password),
          { name: 'PBKDF2' },
          false,
          ['deriveBits'],
        );
        const derived = await source.subtle.deriveBits(
          {
            name: 'PBKDF2',
            hash: 'SHA-512',
            salt: ownedBytes(salt),
            iterations,
          },
          key,
          bits,
        );
        return new Uint8Array(derived);
      } catch (cause) {
        throw createMtprotoError('crypto', 'PBKDF2-SHA512 failed.', { cause });
      }
    },
  });
}

export const createCrypto = createBrowserCryptoAdapter;

let defaultAdapter: CryptoAdapter | undefined;

export function browserCrypto() {
  return (defaultAdapter ??= createBrowserCryptoAdapter());
}

export function sha1(data: Uint8Array) {
  return browserCrypto().sha1(data);
}

export function sha256(data: Uint8Array) {
  return browserCrypto().sha256(data);
}

function ownedBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data);
}
