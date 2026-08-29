import { bytesToBigInt, concatBytes, modPow, bigIntToBytes } from '../bytes';
import { aesIgeEncrypt, type CryptoAdapter } from '../crypto';
import { createMtprotoError } from '../errors';

export interface TelegramRsaKey {
  readonly fingerprint: bigint;
  readonly modulus: bigint;
  readonly exponent: bigint;
}

const KEYS: readonly TelegramRsaKey[] = Object.freeze([
  Object.freeze({
    fingerprint: -3_414_540_481_677_951_611n,
    modulus: BigInt(
      '2937959817066933702298617714945612856538843112005886376816255642404751219133084745514657634448776440866' +
        '1701890505066208632169112269581063774293102577308490531282748465986139880977280302242772832972539403531' +
        '3160108704012876427630091361567343395380424193887227773571344877461690935390938502512438971889287359033' +
        '8945177273024525306296338410881284207988753897636046529094613963869149149606209957083647645485599631919' +
        '2747663615955633778034897140982517446405334423701359108810182097749467210509584293428076654573384828809' +
        '574217079944388301239431309115013843331317877374435868468779972014486325557807783825502498215169806323',
    ),
    exponent: 65_537n,
  }),
  Object.freeze({
    fingerprint: -5_595_554_452_916_591_101n,
    modulus: BigInt(
      '2534288944884041556497168959071347320689884775908477905258202659454602246385394058588521595116849196570' +
        '8222649399180603818074200620463776135424884632162512403163793083921641631564740959529419359595852941166' +
        '8489405859523376133330223960965841179548922160312292373029437018775884567383353986024616752250817918203' +
        '9315375750495263623495132323782003654358104782690612092797248736680529211579223142368426126233039432475' +
        '0785450942589751755390156647751460719351439969059949569615302809050721500330239005077889855323917509948' +
        '255722081644689442127297605422579707142646660768825302832201908302295573257427896031830742328565032949',
    ),
    exponent: 65_537n,
  }),
]);

export function findTelegramRsaKey(fingerprints: readonly bigint[]) {
  for (const fingerprint of fingerprints) {
    const key = KEYS.find((candidate) => candidate.fingerprint === fingerprint);
    if (key) return key;
  }
  return undefined;
}

export async function encryptRsaPaddedInnerData(
  innerData: Uint8Array,
  key: TelegramRsaKey,
  crypto: Pick<CryptoAdapter, 'randomBytes' | 'sha256'>,
  maximumAttempts = 20,
) {
  if (innerData.byteLength > 144) {
    throw createMtprotoError('protocol', 'PQ inner data exceeds the secure RSA payload limit.');
  }
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts <= 0) {
    throw new RangeError('RSA attempt limit must be a positive safe integer.');
  }
  const data = concatBytes(
    innerData,
    requireLength(
      crypto.randomBytes(192 - innerData.byteLength),
      192 - innerData.byteLength,
      'RSA padding',
    ),
  );
  const reversed = new Uint8Array(data).reverse();

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const temporaryKey = requireLength(crypto.randomBytes(32), 32, 'RSA temporary AES key');
    const hash = requireLength(
      await crypto.sha256(concatBytes(temporaryKey, data)),
      32,
      'SHA-256 digest',
    );
    const encrypted = aesIgeEncrypt(temporaryKey, new Uint8Array(32), concatBytes(reversed, hash), {
      padding: 'none',
    });
    const keyMask = requireLength(await crypto.sha256(encrypted), 32, 'SHA-256 digest');
    const maskedKey = new Uint8Array(32);
    for (let index = 0; index < maskedKey.byteLength; index += 1) {
      maskedKey[index] = temporaryKey[index]! ^ keyMask[index]!;
    }
    const payload = concatBytes(maskedKey, encrypted);
    const numericPayload = bytesToBigInt(payload);
    if (numericPayload >= key.modulus) continue;
    return bigIntToBytes(modPow(numericPayload, key.exponent, key.modulus), 256);
  }
  throw createMtprotoError('crypto', 'Could not produce an RSA payload below the server modulus.');
}

function requireLength(bytes: Uint8Array, expected: number, label: string) {
  if (bytes.byteLength !== expected) {
    throw createMtprotoError(
      'crypto',
      `${label} must contain ${expected} bytes, received ${bytes.byteLength}.`,
    );
  }
  return bytes;
}
