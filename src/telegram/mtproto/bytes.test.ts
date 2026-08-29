import { describe, expect, it } from 'vitest';

import {
  bigIntToBytes,
  bytesToBigInt,
  bytesToHex,
  concatBytes,
  equalBytesConstantTime,
  hexToBytes,
  modPow,
  xorBytes,
} from './bytes';

describe('MTProto byte helpers', () => {
  it('round-trips signed and unsigned integers in both byte orders', () => {
    expect(bytesToBigInt(bigIntToBytes(0x0123_4567_89ab_cdefn, 8))).toBe(0x0123_4567_89ab_cdefn);
    expect(
      bytesToBigInt(bigIntToBytes(-2n, 8, { littleEndian: true, signed: true }), {
        littleEndian: true,
        signed: true,
      }),
    ).toBe(-2n);
  });

  it('handles hex, concatenation, xor, and modular exponentiation', () => {
    const first = hexToBytes('0011aa');
    const second = hexToBytes('ff220f');
    expect(bytesToHex(concatBytes(first, second))).toBe('0011aaff220f');
    expect(bytesToHex(xorBytes(first, second))).toBe('ff33a5');
    expect(modPow(4n, 13n, 497n)).toBe(445n);
  });

  it('compares complete inputs and rejects malformed hex', () => {
    expect(equalBytesConstantTime(hexToBytes('00ff'), hexToBytes('00ff'))).toBe(true);
    expect(equalBytesConstantTime(hexToBytes('00ff'), hexToBytes('00fe'))).toBe(false);
    expect(equalBytesConstantTime(hexToBytes('00ff'), hexToBytes('00ff00'))).toBe(false);
    expect(() => hexToBytes('abc')).toThrow('complete bytes');
    expect(() => hexToBytes('zz')).toThrow('non-hexadecimal');
  });
});
