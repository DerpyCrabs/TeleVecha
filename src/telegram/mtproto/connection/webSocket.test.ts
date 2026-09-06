import { describe, expect, it } from 'vitest';

import { createWebSocketPacketConnection, telegramWebSocketUrl } from './webSocket';

describe('Telegram WebSocket packet connection', () => {
  it('uses the expected browser endpoint suffixes', () => {
    expect(telegramWebSocketUrl({ host: 'zws2.web.telegram.org' })).toBe(
      'wss://zws2.web.telegram.org:443/apiws',
    );
    expect(
      telegramWebSocketUrl({ host: 'example.test', port: 8443, test: true, premium: true }),
    ).toBe('wss://example.test:8443/apiws_test_premium');
  });

  it('exposes one scoped packet stream instead of imperative socket lifecycle methods', () => {
    const connection = createWebSocketPacketConnection({ url: 'wss://example.test/apiws' });
    expect(Object.keys(connection)).toEqual(['packets']);
    expect(typeof connection.packets).toBe('function');
  });
});
