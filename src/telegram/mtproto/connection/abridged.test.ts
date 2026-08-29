import { describe, expect, it, vi } from 'vitest';

import { createObfuscatedAbridgedCodec } from './abridged';

const identityCipher = () => ({
  transform: (data: Uint8Array) => data.slice(),
});

function validHeader() {
  return Uint8Array.from({ length: 64 }, (_, index) => index + 1);
}

function concat(...parts: readonly Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

describe('obfuscated abridged transport', () => {
  it('creates the obfuscation header and keeps cipher state private', () => {
    const randomBytes = vi
      .fn<(length: number) => Uint8Array>()
      .mockReturnValueOnce(new Uint8Array(64))
      .mockReturnValueOnce(validHeader());
    const cipherInputs: Array<{ key: Uint8Array; iv: Uint8Array }> = [];
    const codec = createObfuscatedAbridgedCodec({
      randomBytes,
      createCipher(key, iv) {
        cipherInputs.push({ key: key.slice(), iv: iv.slice() });
        return identityCipher();
      },
    });

    const first = codec.initialPacket();
    first.fill(0);
    const second = codec.initialPacket();

    expect(randomBytes).toHaveBeenCalledTimes(2);
    expect(second).toHaveLength(64);
    expect(second.slice(56, 60)).toEqual(Uint8Array.of(0xef, 0xef, 0xef, 0xef));
    expect(second[0]).toBe(1);
    expect(cipherInputs).toHaveLength(2);
    expect(cipherInputs[0]?.key).toEqual(validHeader().slice(8, 40));
    expect(cipherInputs[0]?.iv).toEqual(validHeader().slice(40, 56));
    const reversed = validHeader().slice(8, 56).reverse();
    expect(cipherInputs[1]?.key).toEqual(reversed.slice(0, 32));
    expect(cipherInputs[1]?.iv).toEqual(reversed.slice(32, 48));
  });

  it('frames short and extended packets across arbitrary chunks', () => {
    const codec = createObfuscatedAbridgedCodec({
      randomBytes: validHeader,
      createCipher: identityCipher,
    });
    const short = Uint8Array.from({ length: 8 }, (_, index) => index + 10);
    const extended = Uint8Array.from({ length: 508 }, (_, index) => index & 0xff);
    const encodedShort = codec.encodePacket(short);
    const encodedExtended = codec.encodePacket(extended);

    expect(encodedShort[0]).toBe(2);
    expect(encodedExtended.slice(0, 4)).toEqual(Uint8Array.of(0x7f, 0x7f, 0, 0));
    const stream = concat(encodedShort, encodedExtended);
    expect(codec.accept(stream.slice(0, 2))).toEqual([]);
    expect(codec.accept(stream.slice(2, 100))).toEqual([short]);
    expect(codec.accept(stream.slice(100))).toEqual([extended]);
  });

  it('rejects malformed packet lengths before allocating payloads', () => {
    const codec = createObfuscatedAbridgedCodec({
      randomBytes: validHeader,
      createCipher: identityCipher,
    });

    expect(() => codec.encodePacket(new Uint8Array(0))).toThrow('non-empty');
    expect(() => codec.encodePacket(new Uint8Array(3))).toThrow('four-byte aligned');
    expect(() => codec.accept(Uint8Array.of(0))).toThrow('invalid abridged packet length');
    expect(() => codec.accept(Uint8Array.of(0x80))).toThrow('invalid abridged packet length');
  });
});
