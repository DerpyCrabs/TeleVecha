import {
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  equalBytesConstantTime,
  minimalBigEndianBytes,
} from '../bytes';
import { aesIgeDecrypt, aesIgeEncrypt, randomBytes, sha1 } from '../crypto';
import { createMtprotoError, type MtprotoError } from '../errors';
import { createAuthKey, type AuthKey } from './authKey';
import {
  calculateDhValues,
  calculateServerSalt,
  deriveTemporaryAes,
  DH_PRIME_BYTES,
  generateDhPrivateExponent,
  validateDhParameters,
  validateDhPublicValue,
} from './dh';
import { factorizePq } from './factorization';
import { encryptRsaPaddedInnerData, findTelegramRsaKey } from './rsa';

const MAX_PQ_BYTES = 8;
const MAX_DH_ATTEMPTS = 5;

export interface ResPq {
  readonly nonce: bigint;
  readonly serverNonce: bigint;
  readonly pq: Uint8Array;
  readonly serverPublicKeyFingerprints: readonly bigint[];
}

export type ServerDhParams =
  | {
      readonly kind: 'ok';
      readonly nonce: bigint;
      readonly serverNonce: bigint;
      readonly encryptedAnswer: Uint8Array;
    }
  | {
      readonly kind: 'fail';
      readonly nonce: bigint;
      readonly serverNonce: bigint;
      readonly newNonceHash: bigint;
    };

export interface ServerDhInner {
  readonly nonce: bigint;
  readonly serverNonce: bigint;
  readonly generator: number;
  readonly dhPrime: Uint8Array;
  readonly serverPublic: Uint8Array;
  readonly serverTime: number;
}

export type DhGenerationResult = Readonly<{
  kind: 'ok' | 'retry' | 'fail';
  nonce: bigint;
  serverNonce: bigint;
  newNonceHash: bigint;
}>;

export interface AuthorizationHandshakeWire {
  requestPq(nonce: bigint): Effect.Effect<ResPq, MtprotoError>;
  encodePqInnerData(input: {
    pq: Uint8Array;
    p: Uint8Array;
    q: Uint8Array;
    nonce: bigint;
    serverNonce: bigint;
    newNonce: bigint;
    dcId: number;
  }): Uint8Array;
  requestDh(input: {
    nonce: bigint;
    serverNonce: bigint;
    p: Uint8Array;
    q: Uint8Array;
    publicKeyFingerprint: bigint;
    encryptedData: Uint8Array;
  }): Effect.Effect<ServerDhParams, MtprotoError>;
  decodeServerDhInner(input: Uint8Array): {
    value: ServerDhInner;
    encoded: Uint8Array;
    bytesRead: number;
  };
  encodeClientDhInner(input: {
    nonce: bigint;
    serverNonce: bigint;
    retryId: bigint;
    clientPublic: Uint8Array;
  }): Uint8Array;
  setClientDh(input: {
    nonce: bigint;
    serverNonce: bigint;
    encryptedData: Uint8Array;
  }): Effect.Effect<DhGenerationResult, MtprotoError>;
}

export interface AuthorizationHandshakeOptions {
  readonly dcId: number;
  readonly isTestServer?: boolean | undefined;
  readonly wire: AuthorizationHandshakeWire;
  readonly now?: (() => number) | undefined;
  readonly trace?: ((message: string) => void) | undefined;
}

export interface AuthorizationResult {
  readonly authKey: AuthKey;
  readonly timeOffset: number;
  readonly serverSalt: bigint;
}

export const createAuthorizationKey = Effect.fn('mtproto.auth.authorize')(function* (
  options: AuthorizationHandshakeOptions,
) {
  if (!Number.isSafeInteger(options.dcId) || options.dcId <= 0) {
    return yield* Effect.fail(
      createMtprotoError('configuration', 'Data-center ID must be a positive integer.'),
    );
  }
  const trace = options.trace ?? (() => undefined);

  const nonceBytes = yield* randomBytes(16);
  const nonce = bytesToBigInt(nonceBytes, { signed: true });
  const response = yield* options.wire.requestPq(nonce);
  yield* Effect.sync(() => trace('Received resPQ.'));
  if (response.nonce !== nonce) return yield* Effect.fail(fail('resPQ contained the wrong nonce.'));
  yield* validatePqEncoding(response.pq);
  const pq = bytesToBigInt(response.pq);
  const { p, q } = factorizePq(pq);
  const pBytes = minimalBigEndianBytes(p);
  const qBytes = minimalBigEndianBytes(q);
  const rsaKey = findTelegramRsaKey(response.serverPublicKeyFingerprints);
  if (!rsaKey) return yield* Effect.fail(fail('Telegram did not offer a recognized RSA key.'));

  const newNonceBytes = yield* randomBytes(32);
  const newNonce = bytesToBigInt(newNonceBytes, { littleEndian: true, signed: true });
  const innerData = yield* Effect.try({
    try: () =>
      options.wire.encodePqInnerData({
        pq: minimalBigEndianBytes(pq),
        p: pBytes,
        q: qBytes,
        nonce,
        serverNonce: response.serverNonce,
        newNonce,
        dcId: options.isTestServer ? options.dcId + 10_000 : options.dcId,
      }),
    catch: (cause) => createMtprotoError('protocol', 'Could not encode PQ inner data.', { cause }),
  });
  const encryptedData = yield* encryptRsaPaddedInnerData(innerData, rsaKey);
  const dhParams = yield* options.wire.requestDh({
    nonce,
    serverNonce: response.serverNonce,
    p: pBytes,
    q: qBytes,
    publicKeyFingerprint: rsaKey.fingerprint,
    encryptedData,
  });
  yield* validateNonces(dhParams, nonce, response.serverNonce, 'server DH parameters');
  if (dhParams.kind === 'fail') {
    const digest = yield* sha1(bigIntToBytes(newNonce, 32, { littleEndian: true, signed: true }));
    const expected = bytesToBigInt(digest.subarray(4, 20), {
      littleEndian: true,
      signed: true,
    });
    if (dhParams.newNonceHash !== expected)
      return yield* Effect.fail(fail('DH rejection contained the wrong nonce hash.'));
    return yield* Effect.fail(fail('Telegram rejected the DH parameters.'));
  }

  const temporary = yield* deriveTemporaryAes(response.serverNonce, newNonce);
  if (dhParams.encryptedAnswer.byteLength % 16 !== 0) {
    return yield* Effect.fail(fail('Encrypted server DH data is not block-aligned.'));
  }
  const plaintext = yield* Effect.try({
    try: () => aesIgeDecrypt(temporary.key, temporary.iv, dhParams.encryptedAnswer),
    catch: (cause) => createMtprotoError('crypto', 'Could not decrypt server DH data.', { cause }),
  });
  if (plaintext.byteLength < 20)
    return yield* Effect.fail(fail('Encrypted server DH data is truncated.'));
  const expectedHash = plaintext.subarray(0, 20);
  const decoded = yield* Effect.try({
    try: () => options.wire.decodeServerDhInner(plaintext.subarray(20)),
    catch: (cause) => createMtprotoError('protocol', 'Could not decode server DH data.', { cause }),
  });
  if (
    !Number.isSafeInteger(decoded.bytesRead) ||
    decoded.bytesRead <= 0 ||
    decoded.bytesRead !== decoded.encoded.byteLength
  ) {
    return yield* Effect.fail(fail('Server DH decoder returned an invalid body length.'));
  }
  const paddingLength = plaintext.byteLength - 20 - decoded.bytesRead;
  if (paddingLength < 0 || paddingLength > 15)
    return yield* Effect.fail(fail('Server DH data has invalid padding.'));
  const actualHash = yield* sha1(decoded.encoded);
  if (!equalBytesConstantTime(expectedHash, actualHash))
    return yield* Effect.fail(fail('Server DH data failed its hash check.'));

  const inner = decoded.value;
  yield* validateNonces(inner, nonce, response.serverNonce, 'server DH data');
  const prime = yield* validateDhParameters(inner.dhPrime, inner.generator);
  const serverPublic = bytesToBigInt(inner.serverPublic);
  yield* validateDhPublicValue(serverPublic, prime, 'g_a');
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1_000);
  const timeOffset = inner.serverTime - nowSeconds;
  const retryId = yield* Ref.make(0n);

  return yield* Effect.gen(function* () {
    const privateExponent = yield* generateDhPrivateExponent(prime);
    const values = yield* calculateDhValues(inner.generator, serverPublic, privateExponent, prime);
    const authKeyBytes = bigIntToBytes(values.sharedSecret, DH_PRIME_BYTES);
    const authKey = yield* createAuthKey(authKeyBytes);
    const currentRetryId = yield* Ref.get(retryId);
    const clientInner = yield* Effect.try({
      try: () =>
        options.wire.encodeClientDhInner({
          nonce,
          serverNonce: response.serverNonce,
          retryId: currentRetryId,
          clientPublic: bigIntToBytes(values.clientPublic, DH_PRIME_BYTES),
        }),
      catch: (cause) =>
        createMtprotoError('protocol', 'Could not encode client DH data.', { cause }),
    });
    const digest = yield* sha1(clientInner);
    const unpadded = concatBytes(digest, clientInner);
    const paddingLength = (16 - (unpadded.byteLength % 16)) % 16;
    const padding = yield* randomBytes(paddingLength);
    const encrypted = yield* Effect.try({
      try: () =>
        aesIgeEncrypt(temporary.key, temporary.iv, concatBytes(unpadded, padding), {
          padding: 'none',
        }),
      catch: (cause) =>
        createMtprotoError('crypto', 'Could not encrypt client DH data.', { cause }),
    });
    const result = yield* options.wire.setClientDh({
      nonce,
      serverNonce: response.serverNonce,
      encryptedData: encrypted,
    });
    yield* validateNonces(result, nonce, response.serverNonce, `DH ${result.kind}`);
    const hashNumber = result.kind === 'ok' ? 1 : result.kind === 'retry' ? 2 : 3;
    const expectedNonceHash = yield* authKey.calculateNewNonceHash(
      newNonce,
      hashNumber as 1 | 2 | 3,
    );
    if (result.newNonceHash !== expectedNonceHash)
      return yield* Effect.fail(fail('DH result contained the wrong nonce hash.'));
    if (result.kind === 'ok') {
      yield* Effect.sync(() => trace('Authorization key created.'));
      return {
        authKey,
        timeOffset,
        serverSalt: calculateServerSalt(newNonce, response.serverNonce),
      } satisfies AuthorizationResult;
    }
    if (result.kind === 'fail')
      return yield* Effect.fail(fail('Telegram rejected the generated DH key.'));
    yield* Ref.set(
      retryId,
      bytesToBigInt(authKey.hash.subarray(0, 8), {
        littleEndian: true,
        signed: true,
      }),
    );
    return yield* Effect.fail(
      createMtprotoError('protocol', 'Telegram requested another DH key.', {
        details: { retry: true },
      }),
    );
  }).pipe(
    Effect.retry({
      schedule: Schedule.recurs(MAX_DH_ATTEMPTS - 1),
      while: (error) => error.details?.retry === true,
    }),
  );
});

const validatePqEncoding = Effect.fn('mtproto.auth.validatePq')(function* (pq: Uint8Array) {
  if (
    pq.byteLength === 0 ||
    pq.byteLength > MAX_PQ_BYTES ||
    pq[0] === 0 ||
    bytesToBigInt(pq) < 15n ||
    bytesToBigInt(pq) > 0x7fff_ffff_ffff_ffffn ||
    bytesToBigInt(pq) % 2n === 0n
  ) {
    return yield* Effect.fail(fail('resPQ contained an invalid pq value.'));
  }
});

const validateNonces = Effect.fn('mtproto.auth.validateNonces')(function* (
  value: { readonly nonce: bigint; readonly serverNonce: bigint },
  nonce: bigint,
  serverNonce: bigint,
  label: string,
) {
  if (value.nonce !== nonce) return yield* Effect.fail(fail(`${label} contained the wrong nonce.`));
  if (value.serverNonce !== serverNonce)
    return yield* Effect.fail(fail(`${label} contained the wrong server nonce.`));
});

function fail(message: string) {
  return createMtprotoError('protocol', message);
}
import { Effect, Ref, Schedule } from 'effect';
