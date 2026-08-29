import {
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  equalBytesConstantTime,
  minimalBigEndianBytes,
} from '../bytes';
import { aesIgeDecrypt, aesIgeEncrypt, browserCrypto, type CryptoAdapter } from '../crypto';
import { createMtprotoError } from '../errors';
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
  requestPq(nonce: bigint): Promise<ResPq>;
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
  }): Promise<ServerDhParams>;
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
  }): Promise<DhGenerationResult>;
}

export interface AuthorizationHandshakeOptions {
  readonly dcId: number;
  readonly isTestServer?: boolean | undefined;
  readonly wire: AuthorizationHandshakeWire;
  readonly crypto?: CryptoAdapter | undefined;
  readonly now?: (() => number) | undefined;
  readonly trace?: ((message: string) => void) | undefined;
}

export interface AuthorizationResult {
  readonly authKey: AuthKey;
  readonly timeOffset: number;
  readonly serverSalt: bigint;
}

export async function createAuthorizationKey(
  options: AuthorizationHandshakeOptions,
): Promise<AuthorizationResult> {
  if (!Number.isSafeInteger(options.dcId) || options.dcId <= 0) {
    throw createMtprotoError('configuration', 'Data-center ID must be a positive integer.');
  }
  const crypto = options.crypto ?? browserCrypto();
  const trace = options.trace ?? (() => undefined);

  const nonceBytes = crypto.randomBytes(16);
  requireLength(nonceBytes, 16, 'authorization nonce');
  const nonce = bytesToBigInt(nonceBytes, { signed: true });
  const response = await options.wire.requestPq(nonce);
  trace('Received resPQ.');
  if (response.nonce !== nonce) fail('resPQ contained the wrong nonce.');
  validatePqEncoding(response.pq);
  const pq = bytesToBigInt(response.pq);
  const { p, q } = factorizePq(pq);
  const pBytes = minimalBigEndianBytes(p);
  const qBytes = minimalBigEndianBytes(q);
  const rsaKey = findTelegramRsaKey(response.serverPublicKeyFingerprints);
  if (!rsaKey) fail('Telegram did not offer a recognized RSA key.');

  const newNonceBytes = crypto.randomBytes(32);
  requireLength(newNonceBytes, 32, 'new nonce');
  const newNonce = bytesToBigInt(newNonceBytes, { littleEndian: true, signed: true });
  const innerData = options.wire.encodePqInnerData({
    pq: minimalBigEndianBytes(pq),
    p: pBytes,
    q: qBytes,
    nonce,
    serverNonce: response.serverNonce,
    newNonce,
    dcId: options.isTestServer ? options.dcId + 10_000 : options.dcId,
  });
  const encryptedData = await encryptRsaPaddedInnerData(innerData, rsaKey, crypto);
  const dhParams = await options.wire.requestDh({
    nonce,
    serverNonce: response.serverNonce,
    p: pBytes,
    q: qBytes,
    publicKeyFingerprint: rsaKey.fingerprint,
    encryptedData,
  });
  validateNonces(dhParams, nonce, response.serverNonce, 'server DH parameters');
  if (dhParams.kind === 'fail') {
    const digest = await crypto.sha1(
      bigIntToBytes(newNonce, 32, { littleEndian: true, signed: true }),
    );
    const expected = bytesToBigInt(digest.subarray(4, 20), {
      littleEndian: true,
      signed: true,
    });
    if (dhParams.newNonceHash !== expected) fail('DH rejection contained the wrong nonce hash.');
    fail('Telegram rejected the DH parameters.');
  }

  const temporary = await deriveTemporaryAes(response.serverNonce, newNonce, crypto);
  if (dhParams.encryptedAnswer.byteLength % 16 !== 0) {
    fail('Encrypted server DH data is not block-aligned.');
  }
  const plaintext = aesIgeDecrypt(temporary.key, temporary.iv, dhParams.encryptedAnswer);
  if (plaintext.byteLength < 20) fail('Encrypted server DH data is truncated.');
  const expectedHash = plaintext.subarray(0, 20);
  const decoded = options.wire.decodeServerDhInner(plaintext.subarray(20));
  if (
    !Number.isSafeInteger(decoded.bytesRead) ||
    decoded.bytesRead <= 0 ||
    decoded.bytesRead !== decoded.encoded.byteLength
  ) {
    fail('Server DH decoder returned an invalid body length.');
  }
  const paddingLength = plaintext.byteLength - 20 - decoded.bytesRead;
  if (paddingLength < 0 || paddingLength > 15) fail('Server DH data has invalid padding.');
  const actualHash = await crypto.sha1(decoded.encoded);
  if (!equalBytesConstantTime(expectedHash, actualHash))
    fail('Server DH data failed its hash check.');

  const inner = decoded.value;
  validateNonces(inner, nonce, response.serverNonce, 'server DH data');
  const prime = validateDhParameters(inner.dhPrime, inner.generator);
  const serverPublic = bytesToBigInt(inner.serverPublic);
  validateDhPublicValue(serverPublic, prime, 'g_a');
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1_000);
  const timeOffset = inner.serverTime - nowSeconds;
  let retryId = 0n;

  for (let attempt = 0; attempt < MAX_DH_ATTEMPTS; attempt += 1) {
    const privateExponent = generateDhPrivateExponent(prime, (length) =>
      crypto.randomBytes(length),
    );
    const values = calculateDhValues(inner.generator, serverPublic, privateExponent, prime);
    const authKeyBytes = bigIntToBytes(values.sharedSecret, DH_PRIME_BYTES);
    const authKey = await createAuthKey(authKeyBytes, crypto);
    const clientInner = options.wire.encodeClientDhInner({
      nonce,
      serverNonce: response.serverNonce,
      retryId,
      clientPublic: bigIntToBytes(values.clientPublic, DH_PRIME_BYTES),
    });
    const encrypted = aesIgeEncrypt(
      temporary.key,
      temporary.iv,
      concatBytes(await crypto.sha1(clientInner), clientInner),
      { randomBytes: (length) => crypto.randomBytes(length) },
    );
    const result = await options.wire.setClientDh({
      nonce,
      serverNonce: response.serverNonce,
      encryptedData: encrypted,
    });
    validateNonces(result, nonce, response.serverNonce, `DH ${result.kind}`);
    const hashNumber = result.kind === 'ok' ? 1 : result.kind === 'retry' ? 2 : 3;
    const expectedNonceHash = await authKey.calculateNewNonceHash(
      newNonce,
      hashNumber as 1 | 2 | 3,
    );
    if (result.newNonceHash !== expectedNonceHash)
      fail('DH result contained the wrong nonce hash.');
    if (result.kind === 'ok') {
      trace('Authorization key created.');
      return Object.freeze({
        authKey,
        timeOffset,
        serverSalt: calculateServerSalt(newNonce, response.serverNonce),
      });
    }
    if (result.kind === 'fail') fail('Telegram rejected the generated DH key.');
    retryId = bytesToBigInt(authKey.hash.subarray(0, 8), {
      littleEndian: true,
      signed: true,
    });
  }
  fail('DH generation exceeded its retry limit.');
}

function validatePqEncoding(pq: Uint8Array) {
  if (
    pq.byteLength === 0 ||
    pq.byteLength > MAX_PQ_BYTES ||
    pq[0] === 0 ||
    bytesToBigInt(pq) < 15n ||
    bytesToBigInt(pq) > 0x7fff_ffff_ffff_ffffn ||
    bytesToBigInt(pq) % 2n === 0n
  ) {
    fail('resPQ contained an invalid pq value.');
  }
}

function validateNonces(
  value: { readonly nonce: bigint; readonly serverNonce: bigint },
  nonce: bigint,
  serverNonce: bigint,
  label: string,
) {
  if (value.nonce !== nonce) fail(`${label} contained the wrong nonce.`);
  if (value.serverNonce !== serverNonce) fail(`${label} contained the wrong server nonce.`);
}

function requireLength(bytes: Uint8Array, length: number, label: string) {
  if (bytes.byteLength !== length) {
    throw createMtprotoError('crypto', `Random source returned the wrong ${label} length.`);
  }
}

function fail(message: string): never {
  throw createMtprotoError('protocol', message);
}
