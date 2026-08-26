import { describe, expect, it } from 'vitest';

import { safeExternalUrl } from './safeUrl';

describe('safeExternalUrl', () => {
  it('allows web, mail, and Telegram links', () => {
    expect(safeExternalUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(safeExternalUrl('mailto:user@example.com')).toBe('mailto:user@example.com');
    expect(safeExternalUrl('tg://resolve?domain=telegram')).toBe('tg://resolve?domain=telegram');
  });

  it('rejects executable and local-resource schemes', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeExternalUrl('data:text/html,unsafe')).toBeUndefined();
    expect(safeExternalUrl('file:///etc/passwd')).toBeUndefined();
  });
});
