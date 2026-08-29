import { describe, expect, it } from 'vitest';

import { bigIntToBytes, bytesToBigInt, bytesToHex, concatBytes, modPow } from '../bytes';
import { aesIgeEncrypt, createBrowserCryptoAdapter, type CryptoAdapter } from '../crypto';
import {
  createAuthKey,
  createAuthorizationKey,
  computePasswordHash,
  computePasswordSrpCheck,
  deriveTemporaryAes,
  factorizePq,
  TELEGRAM_DH_PRIME,
  validateDhParameters,
  validateDhPublicValue,
  type AuthorizationHandshakeWire,
  type ServerDhInner,
} from './index';

describe('MTProto authorization security', () => {
  it('factors bounded server semiprimes', () => {
    expect(factorizePq(323n)).toEqual({ p: 17n, q: 19n });
    expect(factorizePq(2_147_483_629n * 2_147_483_647n)).toEqual({
      p: 2_147_483_629n,
      q: 2_147_483_647n,
    });
    expect(factorizePq(179_424_611n * 179_424_673n)).toEqual({
      p: 179_424_611n,
      q: 179_424_673n,
    });
    expect(factorizePq(0x17ed_4894_1a08_f981n)).toEqual({
      p: 1_229_739_323n,
      q: 1_402_015_859n,
    });
  });

  it.each([0n, 1n, 2n, 3n, 4n, 5n, 17n, 45n, 49n])('rejects invalid pq value %s', (pq) => {
    expect(() => factorizePq(pq)).toThrow();
  });

  it('accepts only the known DH modulus and safe public values', () => {
    const prime = validateDhParameters(TELEGRAM_DH_PRIME, 3);
    const threshold = 1n << 1_984n;
    expect(() => validateDhPublicValue(threshold + 1n, prime, 'test')).not.toThrow();
    expect(() => validateDhPublicValue(threshold, prime, 'test')).toThrow('safe range');
    const changed = new Uint8Array(TELEGRAM_DH_PRIME);
    changed[0] = changed[0]! ^ 1;
    expect(() => validateDhParameters(changed, 3)).toThrow('Invalid DH prime');
  });

  it('derives the auth-key identity and nonce hashes without mutable state', async () => {
    const crypto = createBrowserCryptoAdapter();
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const key = await createAuthKey(bytes, crypto);
    expect(bytesToHex(key.hash)).toBe('4916d6bdb7f78e6803698cab32d1586ea457dfc8');
    expect(key.auxHash).toBe(7_534_231_595_173_418_569n);
    expect(key.id).toBe(14_474_384_091_129_631_026n);
    await expect(key.calculateNewNonceHash(123n, 1)).resolves.toBeTypeOf('bigint');
  });

  it('computes a deterministic Telegram password SRP proof', async () => {
    const base = createBrowserCryptoAdapter();
    const crypto: CryptoAdapter = {
      ...base,
      randomBytes(length) {
        return Uint8Array.from({ length }, (_, index) => (index * 29 + 7) & 0xff);
      },
    };
    const algorithm = {
      salt1: new Uint8Array([1, 3, 5, 7]),
      salt2: new Uint8Array([2, 4, 6, 8]),
      g: 3,
      p: TELEGRAM_DH_PRIME,
    };
    const prime = bytesToBigInt(algorithm.p);
    const passwordHash = await computePasswordHash(algorithm, 'correct horse', crypto);
    const passwordExponent = bytesToBigInt(passwordHash);
    const paddedPrime = bigIntToBytes(prime, 256);
    const paddedGenerator = bigIntToBytes(3n, 256);
    const multiplier = bytesToBigInt(
      await crypto.sha256(concatBytes(paddedPrime, paddedGenerator)),
    );
    const verifier = modPow(3n, passwordExponent, prime);
    const serverEphemeral = modPow(3n, 654_321n, prime);
    const serverPublic = (multiplier * verifier + serverEphemeral) % prime;
    const result = await computePasswordSrpCheck(
      {
        currentAlgo: algorithm,
        srpB: bigIntToBytes(serverPublic, 256),
        srpId: 42n,
      },
      'correct horse',
      crypto,
    );
    expect(result._).toBe('inputCheckPasswordSRP');
    expect(result.srpId).toBe(42n);
    expect(result.A).toHaveLength(256);
    expect(bytesToHex(result.M1)).toBe(
      '45955eaede61aadf732bc1257b542e25b29fcc3b4e6ef78aef69388726eb75db',
    );
  });

  it('runs the complete handshake through a normalized TL wire seam', async () => {
    const base = createBrowserCryptoAdapter();
    let randomCounter = 1;
    const crypto: CryptoAdapter = {
      ...base,
      randomBytes(length) {
        const seed = randomCounter++;
        return Uint8Array.from({ length }, (_, index) => (seed + index * 17) & 0xff);
      },
    };
    const serverNonce = 987_654_321n;
    const serverPrivate = 123_456n;
    const prime = bytesToBigInt(TELEGRAM_DH_PRIME);
    const serverPublic = modPow(3n, serverPrivate, prime);
    let requestNonce = 0n;
    let freshNonce = 0n;
    let clientPublic = 0n;
    const encodedServerInner = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    const serverInner: ServerDhInner = {
      nonce: requestNonce,
      serverNonce,
      generator: 3,
      dhPrime: TELEGRAM_DH_PRIME,
      serverPublic: bigIntToBytes(serverPublic, 256),
      serverTime: 1_700_000_000,
    };

    const wire: AuthorizationHandshakeWire = {
      async requestPq(nonce) {
        requestNonce = nonce;
        return {
          nonce,
          serverNonce,
          pq: new Uint8Array([1, 67]),
          serverPublicKeyFingerprints: [-3_414_540_481_677_951_611n],
        };
      },
      encodePqInnerData(input) {
        freshNonce = input.newNonce;
        return new Uint8Array([1, 2, 3, 4]);
      },
      async requestDh(input) {
        const temporary = await deriveTemporaryAes(serverNonce, freshNonce, crypto);
        const body = concatBytes(await crypto.sha1(encodedServerInner), encodedServerInner);
        return {
          kind: 'ok',
          nonce: input.nonce,
          serverNonce,
          encryptedAnswer: aesIgeEncrypt(temporary.key, temporary.iv, body, {
            randomBytes: (length) => crypto.randomBytes(length),
          }),
        };
      },
      decodeServerDhInner() {
        return {
          value: { ...serverInner, nonce: requestNonce },
          encoded: encodedServerInner,
          bytesRead: 4,
        };
      },
      encodeClientDhInner(input) {
        clientPublic = bytesToBigInt(input.clientPublic);
        return new Uint8Array([5, 6, 7, 8]);
      },
      async setClientDh(input) {
        const shared = modPow(clientPublic, serverPrivate, prime);
        const key = await createAuthKey(bigIntToBytes(shared, 256), crypto);
        return {
          kind: 'ok',
          nonce: input.nonce,
          serverNonce,
          newNonceHash: await key.calculateNewNonceHash(freshNonce, 1),
        };
      },
    };

    const result = await createAuthorizationKey({
      dcId: 2,
      wire,
      crypto,
      now: () => 1_700_000_000_000,
    });
    expect(result.authKey.bytes).toHaveLength(256);
    expect(result.timeOffset).toBe(0);
    expect(result.serverSalt).toBeTypeOf('bigint');
  });
});
