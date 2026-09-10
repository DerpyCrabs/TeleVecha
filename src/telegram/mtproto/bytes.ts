const HEX_PAIR = /^[0-9a-f]{2}$/u;

export function concatBytes(...parts: readonly Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function xorBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) {
    throw new RangeError('Byte arrays must have the same length.');
  }
  const result = new Uint8Array(left.byteLength);
  for (let index = 0; index < result.byteLength; index += 1) {
    result[index] = left[index]! ^ right[index]!;
  }
  return result;
}

/**
 * Compares every byte even when lengths differ. JavaScript cannot promise
 * machine-level constant time, but this avoids content-dependent early exits.
 */
export function equalBytesConstantTime(left: Uint8Array, right: Uint8Array) {
  const length = Math.max(left.byteLength, right.byteLength);
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function bytesToHex(bytes: Uint8Array) {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

export function hexToBytes(hex: string) {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length % 2 !== 0) throw new TypeError('Hex input must contain complete bytes.');
  const result = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < result.byteLength; index += 1) {
    const pair = normalized.slice(index * 2, index * 2 + 2);
    if (!HEX_PAIR.test(pair)) throw new TypeError('Hex input contains a non-hexadecimal byte.');
    result[index] = Number.parseInt(pair, 16);
  }
  return result;
}

export function utf8Bytes(value: string) {
  return new TextEncoder().encode(value);
}

export function readInt32Le(bytes: Uint8Array, offset: number = 0) {
  requireRange(bytes, offset, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

export function readUint32Le(bytes: Uint8Array, offset: number = 0) {
  requireRange(bytes, offset, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

export function writeInt32Le(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return bytes;
}

export function writeUint32Le(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

export function bytesToBigInt(
  bytes: Uint8Array,
  options: { littleEndian?: boolean; signed?: boolean } = {},
) {
  if (bytes.byteLength === 0) return 0n;
  const littleEndian = options.littleEndian ?? false;
  let value = 0n;
  if (littleEndian) {
    for (let index = bytes.byteLength - 1; index >= 0; index -= 1) {
      value = (value << 8n) | BigInt(bytes[index]!);
    }
  } else {
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  }
  if (!options.signed) return value;
  const signMask = 1n << BigInt(bytes.byteLength * 8 - 1);
  return (value & signMask) === 0n ? value : value - (signMask << 1n);
}

export function bigIntToBytes(
  value: bigint,
  length: number,
  options: { littleEndian?: boolean; signed?: boolean } = {},
) {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new RangeError('Byte length must be a positive safe integer.');
  }
  const bits = BigInt(length * 8);
  const signed = options.signed ?? false;
  const minimum = signed ? -(1n << (bits - 1n)) : 0n;
  const maximum = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  if (value < minimum || value > maximum) {
    throw new RangeError(
      `Value does not fit in ${length} ${signed ? 'signed' : 'unsigned'} bytes.`,
    );
  }
  let remaining = signed && value < 0n ? (1n << bits) + value : value;
  const result = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const target = options.littleEndian ? index : length - index - 1;
    result[target] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

export function minimalBigEndianBytes(value: bigint) {
  if (value < 0n) throw new RangeError('Cannot encode a negative unsigned integer.');
  if (value === 0n) return new Uint8Array([0]);
  const length = Math.ceil(value.toString(2).length / 8);
  return bigIntToBytes(value, length);
}

export function mod(value: bigint, divisor: bigint) {
  if (divisor <= 0n) throw new RangeError('Modulus must be positive.');
  const remainder = value % divisor;
  return remainder < 0n ? remainder + divisor : remainder;
}

export function modPow(base: bigint, exponent: bigint, modulus: bigint) {
  if (exponent < 0n) throw new RangeError('Exponent must not be negative.');
  if (modulus <= 0n) throw new RangeError('Modulus must be positive.');
  let result = 1n;
  let factor = mod(base, modulus);
  let power = exponent;
  while (power > 0n) {
    if ((power & 1n) === 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
    power >>= 1n;
  }
  return result;
}

export function bitLength(value: bigint) {
  const absolute = value < 0n ? -value : value;
  return absolute === 0n ? 0 : absolute.toString(2).length;
}

function requireRange(bytes: Uint8Array, offset: number, length: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.byteLength) {
    throw new RangeError('Byte range is outside the input.');
  }
}
