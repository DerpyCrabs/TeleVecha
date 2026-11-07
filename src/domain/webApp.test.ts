import { describe, expect, it } from 'vitest';
import { parseWebAppEvent, validWebAppData, validWebAppUrl } from './webApp';
describe('Mini App inputs', () => {
  it('requires HTTPS and rejects credentials and executable URLs', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'http://example.com',
      'https://user:secret@example.com',
      'not a URL',
    ])
      expect(validWebAppUrl(url)).toBeUndefined();
    expect(validWebAppUrl('https://example.com/app#tgWebAppData=test')).toBe(
      'https://example.com/app#tgWebAppData=test',
    );
  });
  it('enforces the UTF-8 byte limit for keyboard data', () => {
    expect(validWebAppData('')).toBe(false);
    expect(validWebAppData('a'.repeat(4096))).toBe(true);
    expect(validWebAppData('🙂'.repeat(1024))).toBe(true);
    expect(validWebAppData('🙂'.repeat(1025))).toBe(false);
  });
  it('ignores malformed, unrelated and non-object event payloads', () => {
    for (const value of [
      '{',
      'null',
      '{"eventType":"other"}',
      { eventType: 'web_app_close', eventData: [] },
    ])
      expect(parseWebAppEvent(value)).toBeUndefined();
    expect(parseWebAppEvent('{"eventType":"web_app_ready"}')).toEqual({
      eventType: 'web_app_ready',
      eventData: {},
    });
  });
});
