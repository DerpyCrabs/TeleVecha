import { unsafe as nobleAes } from '@noble/ciphers/aes.js';

import { concatBytes } from '../bytes';

const AES_BLOCK_BYTES = 16;

export interface AesCtr {
  transform(data: Uint8Array): Uint8Array;
}

export function createAesCtr(key: Uint8Array, iv: Uint8Array): AesCtr {
  requireAesKey(key);
  requireLength(iv, AES_BLOCK_BYTES, 'AES-CTR IV');
  const expandedKey = nobleAes.expandKeyLE(new Uint8Array(key));
  const counter = new Uint8Array(iv);
  let carry: Uint8Array | undefined;
  let carryOffset = 0;

  const nextBlock = () => {
    const block = new Uint8Array(counter);
    nobleAes.encryptBlock(expandedKey, block);
    incrementCounter(counter);
    return block;
  };

  return Object.freeze({
    transform(data: Uint8Array) {
      const result = new Uint8Array(data.byteLength);
      let offset = 0;
      while (offset < data.byteLength) {
        if (!carry || carryOffset === AES_BLOCK_BYTES) {
          carry = nextBlock();
          carryOffset = 0;
        }
        const count = Math.min(AES_BLOCK_BYTES - carryOffset, data.byteLength - offset);
        for (let index = 0; index < count; index += 1) {
          result[offset + index] = data[offset + index]! ^ carry[carryOffset + index]!;
        }
        carryOffset += count;
        offset += count;
      }
      return result;
    },
  });
}

export function aesIgeEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  options: {
    padding?: 'none' | 'random';
    randomBytes?: ((length: number) => Uint8Array) | undefined;
  } = {},
) {
  requireAesKey(key);
  requireLength(iv, AES_BLOCK_BYTES * 2, 'AES-IGE IV');
  const remainder = plaintext.byteLength % AES_BLOCK_BYTES;
  let input = new Uint8Array(plaintext);
  if (remainder !== 0) {
    if ((options.padding ?? 'random') === 'none') {
      throw new RangeError('AES-IGE plaintext must contain complete blocks.');
    }
    const paddingLength = AES_BLOCK_BYTES - remainder;
    if (!options.randomBytes) {
      throw new RangeError('AES-IGE random padding must be supplied by the caller.');
    }
    const padding = options.randomBytes(paddingLength);
    requireLength(padding, paddingLength, 'AES-IGE padding');
    input = concatBytes(input, padding);
  }
  return transformIge(key, iv, input, false);
}

export function aesIgeDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array) {
  requireAesKey(key);
  requireLength(iv, AES_BLOCK_BYTES * 2, 'AES-IGE IV');
  if (ciphertext.byteLength === 0 || ciphertext.byteLength % AES_BLOCK_BYTES !== 0) {
    throw new RangeError('AES-IGE ciphertext must contain complete blocks.');
  }
  return transformIge(key, iv, new Uint8Array(ciphertext), true);
}

function transformIge(key: Uint8Array, iv: Uint8Array, input: Uint8Array, decrypt: boolean) {
  const expandedKey = decrypt
    ? nobleAes.expandKeyDecLE(new Uint8Array(key))
    : nobleAes.expandKeyLE(new Uint8Array(key));
  const output = new Uint8Array(input.byteLength);
  let previousCiphertext = iv.slice(0, AES_BLOCK_BYTES);
  let previousPlaintext = iv.slice(AES_BLOCK_BYTES);
  try {
    for (let offset = 0; offset < input.byteLength; offset += AES_BLOCK_BYTES) {
      const inputBlock = input.subarray(offset, offset + AES_BLOCK_BYTES);
      const transformed = new Uint8Array(AES_BLOCK_BYTES);
      const beforeCipher = decrypt ? previousPlaintext : previousCiphertext;
      for (let index = 0; index < AES_BLOCK_BYTES; index += 1) {
        transformed[index] = inputBlock[index]! ^ beforeCipher[index]!;
      }
      if (decrypt) nobleAes.decryptBlock(expandedKey, transformed);
      else nobleAes.encryptBlock(expandedKey, transformed);
      const afterCipher = decrypt ? previousCiphertext : previousPlaintext;
      const outputBlock = output.subarray(offset, offset + AES_BLOCK_BYTES);
      for (let index = 0; index < AES_BLOCK_BYTES; index += 1) {
        outputBlock[index] = transformed[index]! ^ afterCipher[index]!;
      }
      previousCiphertext = decrypt ? new Uint8Array(inputBlock) : new Uint8Array(outputBlock);
      previousPlaintext = decrypt ? new Uint8Array(outputBlock) : new Uint8Array(inputBlock);
    }
    return output;
  } finally {
    expandedKey.fill(0);
  }
}

function incrementCounter(counter: Uint8Array) {
  for (let index = counter.byteLength - 1; index >= 0; index -= 1) {
    counter[index] = (counter[index]! + 1) & 0xff;
    if (counter[index] !== 0) return;
  }
}

function requireAesKey(key: Uint8Array) {
  if (![16, 24, 32].includes(key.byteLength)) {
    throw new RangeError('AES key must contain 16, 24, or 32 bytes.');
  }
}

function requireLength(value: Uint8Array, length: number, name: string) {
  if (value.byteLength !== length) throw new RangeError(`${name} must contain ${length} bytes.`);
}
