import { expect, it } from 'vitest';
import { decodeVoiceWaveform } from './voiceWaveform';

it('decodes Telegram amplitudes across byte boundaries and ignores incomplete tail bits', () => {
  expect(decodeVoiceWaveform(new Uint8Array([0x20, 0x88, 0x41, 0x8a, 0x39]))).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7,
  ]);
  expect(decodeVoiceWaveform(new Uint8Array([0xff, 0xff]))).toEqual([31, 31, 31]);
  expect(decodeVoiceWaveform(new Uint8Array())).toEqual([]);
});
