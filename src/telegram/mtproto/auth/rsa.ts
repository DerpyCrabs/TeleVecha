import { Effect, Schedule } from 'effect';

import { bytesToBigInt, concatBytes, modPow, bigIntToBytes } from '../bytes';
import { aesIgeEncrypt, randomBytes, sha256 } from '../crypto';
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

export const encryptRsaPaddedInnerData = Effect.fn('mtproto.auth.rsaEncrypt')(function* (
  innerData: Uint8Array,
  key: TelegramRsaKey,
  maximumAttempts: number = 20,
) {
  if (innerData.byteLength > 144) {
    return yield* Effect.fail(
      createMtprotoError('protocol', 'PQ inner data exceeds the secure RSA payload limit.'),
    );
  }
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts <= 0) {
    return yield* Effect.fail(
      createMtprotoError('configuration', 'RSA attempt limit must be a positive safe integer.'),
    );
  }
  const data = concatBytes(innerData, yield* randomBytes(192 - innerData.byteLength));
  const reversed = new Uint8Array(data).reverse();
  return yield* Effect.gen(function* () {
    const temporaryKey = yield* randomBytes(32);
    const hash = yield* sha256(concatBytes(temporaryKey, data));
    const encrypted = aesIgeEncrypt(temporaryKey, new Uint8Array(32), concatBytes(reversed, hash), {
      padding: 'none',
    });
    const keyMask = yield* sha256(encrypted);
    const maskedKey = Uint8Array.from(temporaryKey, (byte, index) => byte ^ keyMask[index]!);
    const numericPayload = bytesToBigInt(concatBytes(maskedKey, encrypted));
    return yield* numericPayload < key.modulus
      ? Effect.succeed(bigIntToBytes(modPow(numericPayload, key.exponent, key.modulus), 256))
      : Effect.fail(
          createMtprotoError('crypto', 'Generated an RSA payload above the server modulus.'),
        );
  }).pipe(Effect.retry(Schedule.recurs(maximumAttempts - 1)));
});
