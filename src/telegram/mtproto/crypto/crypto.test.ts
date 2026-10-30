import { describe, expect, it } from 'vitest';
import { BrowserCrypto } from '@effect/platform-browser';
import { Effect } from 'effect';
import { Digest, Kdf, SecureRandom } from 'effect/crypto';

import { bytesToHex, hexToBytes, utf8Bytes } from '../bytes';
import {
  aesIgeDecrypt,
  aesIgeEncrypt,
  createAesCtr,
  pbkdf2Sha512,
  randomBytes,
  sha1,
  sha256,
} from './index';

describe('MTProto cryptography', () => {
  it('matches SHA and PBKDF2 published vectors', async () => {
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.runPromise(effect.pipe(Effect.provide(BrowserCrypto.layer)) as Effect.Effect<A, E>);
    await expect(run(sha1(utf8Bytes('abc'))).then(bytesToHex)).resolves.toBe(
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    );
    await expect(run(sha256(utf8Bytes('abc'))).then(bytesToHex)).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    await expect(
      run(pbkdf2Sha512(utf8Bytes('password'), utf8Bytes('salt'), 1, 512)).then(bytesToHex),
    ).resolves.toBe(
      '867f70cf1ade02cff3752599a3a53dc4af34c7a669815ae5d513554e1c8cf252' +
        'c02d470a285a0501bad999bfe943c08f050235d7d68b1da55e63f73b60a57fce',
    );
  });

  it('turns provider digest defects into typed MTProto errors', async () => {
    const failure = new Error('digest unavailable');
    const result = await Effect.runPromise(
      sha256(utf8Bytes('abc')).pipe(
        Effect.provideService(
          Digest.Digest,
          Digest.Digest.of({
            digest: () => Effect.die(failure),
            digestHex: () => Effect.die(failure),
          }),
        ),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure).toMatchObject({ kind: 'crypto', cause: failure });
  });

  it('turns random provider defects into typed MTProto errors', async () => {
    const failure = new Error('random unavailable');
    const result = await Effect.runPromise(
      randomBytes(8).pipe(
        Effect.provideService(
          SecureRandom.SecureRandom,
          SecureRandom.make(() => {
            throw failure;
          }),
        ),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure).toMatchObject({ kind: 'crypto', cause: failure });
  });

  it('rejects PBKDF2 parameters outside the backend limits as typed errors', async () => {
    const result = await Effect.runPromise(
      pbkdf2Sha512(utf8Bytes('p'), utf8Bytes('s'), 2 ** 31, 512).pipe(
        Effect.provide(Kdf.layerWebCrypto),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
  });

  it('matches the NIST AES-CTR vector across uneven chunks', () => {
    const key = hexToBytes('2b7e151628aed2a6abf7158809cf4f3c');
    const counter = hexToBytes('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff');
    const plaintext = hexToBytes(
      '6bc1bee22e409f96e93d7e117393172a' +
        'ae2d8a571e03ac9c9eb76fac45af8e51' +
        '30c81c46a35ce411e5fbc1191a0a52ef' +
        'f69f2445df4f9b17ad2b417be66c3710',
    );
    const expected =
      '874d6191b620e3261bef6864990db6ce' +
      '9806f66b7970fdff8617187bb9fffdff' +
      '5ae4df3edbd5d35e5b4f09020db03eab' +
      '1e031dda2fbe03d1792170a0f3009cee';
    const ctr = createAesCtr(key, counter);
    const encrypted = new Uint8Array(plaintext.byteLength);
    encrypted.set(ctr.transform(plaintext.subarray(0, 7)), 0);
    encrypted.set(ctr.transform(plaintext.subarray(7, 39)), 7);
    encrypted.set(ctr.transform(plaintext.subarray(39)), 39);
    expect(bytesToHex(encrypted)).toBe(expected);
  });

  it('matches a fixed AES-IGE vector and decrypts it', () => {
    const key = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const iv = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const plaintext = hexToBytes(
      '00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100',
    );
    const encrypted = aesIgeEncrypt(key, iv, plaintext, { padding: 'none' });
    expect(bytesToHex(encrypted)).toBe(
      '68f07915956f5244b3f6903843b4e44e32cdbf8d6979b3c0139382a6f288886d',
    );
    expect(aesIgeDecrypt(key, iv, encrypted)).toEqual(plaintext);
  });

  it('matches the published OpenSSL AES-IGE test vector', () => {
    const key = hexToBytes('000102030405060708090a0b0c0d0e0f');
    const iv = hexToBytes('000102030405060708090a0b0c0d0e0f' + '101112131415161718191a1b1c1d1e1f');
    const plaintext = new Uint8Array(32);
    const expected = hexToBytes(
      '1a8519a6557be652e9da8e43da4ef445' + '3cf456b4ca488aa383c79c98b34797cb',
    );

    expect(aesIgeEncrypt(key, iv, plaintext, { padding: 'none' })).toEqual(expected);
    expect(aesIgeDecrypt(key, iv, expected)).toEqual(plaintext);
  });
});
