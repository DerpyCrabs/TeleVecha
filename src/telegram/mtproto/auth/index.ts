export { createAuthKey, type AuthKey } from './authKey';
export {
  calculateDhValues,
  calculateServerSalt,
  deriveTemporaryAes,
  DH_PRIME_BYTES,
  generateDhPrivateExponent,
  TELEGRAM_DH_PRIME,
  validateDhParameters,
  validateDhPublicValue,
} from './dh';
export { factorizePq } from './factorization';
export {
  createAuthorizationKey,
  type AuthorizationHandshakeOptions,
  type AuthorizationHandshakeWire,
  type AuthorizationResult,
  type DhGenerationResult,
  type ResPq,
  type ServerDhInner,
  type ServerDhParams,
} from './handshake';
export { encryptRsaPaddedInnerData, findTelegramRsaKey, type TelegramRsaKey } from './rsa';
export {
  computePasswordDigest,
  computePasswordHash,
  computePasswordSrpCheck,
  type InputCheckPasswordSrp,
  type PasswordKdfAlgorithm,
  type PasswordSrpState,
} from './srp';
