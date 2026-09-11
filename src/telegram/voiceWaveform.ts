/** Telegram packs voice amplitudes as consecutive little-endian 5-bit samples. */
export function decodeVoiceWaveform(bytes: Uint8Array): number[] {
  return Array.from({ length: Math.floor((bytes.length * 8) / 5) }, (_, index) => {
    const bit = index * 5;
    const offset = bit >> 3;
    return (((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >> (bit % 8)) & 31;
  });
}
