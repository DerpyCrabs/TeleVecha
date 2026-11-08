import { describe, expect, it } from 'vitest';
import { gzipSync, zlibSync, strToU8 } from 'fflate';
import { decodeWidgetPayload } from './widgetPayload';
describe('widget payload', () => {
  it('decodes current zlib and earlier gzip payloads', () => {
    const html = '<p>Привет</p>';
    for (const pack of [zlibSync, gzipSync])
      expect(decodeWidgetPayload(pack(strToU8(html)))).toBe(html);
  });
  it('rejects invalid and oversized payloads', () => {
    expect(() => decodeWidgetPayload(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => decodeWidgetPayload(zlibSync(new Uint8Array(1024 * 1024 + 1)))).toThrow(
      'too large',
    );
  });
});
