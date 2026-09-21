import { describe, expect, it } from 'vitest';
import { parseTelegramLink } from './telegramLink';

describe('Telegram chat and post links', () => {
  it.each([
    ['https://t.me/Fourier_series/965', { username: 'Fourier_series', messageId: 965 }],
    ['https://telegram.me/Fourier_series', { username: 'Fourier_series' }],
    ['https://t.me/s/Fourier_series/965?single', { username: 'Fourier_series', messageId: 965 }],
    [
      'https://t.me/Fourier_series/965?comment=42',
      { username: 'Fourier_series', messageId: 965, commentId: 42 },
    ],
    [
      'tg://resolve?domain=Fourier_series&post=965&comment=42',
      { username: 'Fourier_series', messageId: 965, commentId: 42 },
    ],
    ['https://t.me/c/1234567890/965', { peerId: 'c:1234567890', messageId: 965 }],
  ])('recognizes %s', (url, target) => expect(parseTelegramLink(url as string)).toEqual(target));
  it.each([
    'https://t.me.evil.test/name/1',
    'https://t.me@evil.test/name/1',
    'https://evil.test/t.me/name/1',
    'https://t.me/+invite',
    'https://t.me/joinchat/invite',
    'https://t.me/share/url?url=https://example.com',
    'https://t.me/some_bot?start=payload',
    'https://t.me/user/story/42',
    'https://t.me/name/0',
    'https://t.me/name/2147483648',
    'https://t.me/name/1?comment=invalid',
    'https://t.me/name?comment=42',
    'tg://resolve?domain=some_bot&start=payload',
    'https://t.me/name/1/2',
    'https://t.me/login',
    'https://t.me:8443/name',
    'javascript:alert(1)',
  ])('leaves unrelated or malformed URLs alone: %s', (url) =>
    expect(parseTelegramLink(url)).toBeUndefined(),
  );
});
