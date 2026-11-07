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

describe('Mini App links', () => {
  it.each([
    ['https://t.me/example_bot?startapp', { username: 'example_bot', webApp: { startParam: '' } }],
    [
      'https://t.me/example_bot/shop?startapp=order_123&mode=compact',
      {
        username: 'example_bot',
        webApp: { shortName: 'shop', startParam: 'order_123', mode: 'compact' },
      },
    ],
    ['https://t.me/example_bot/shop', { username: 'example_bot', webApp: { shortName: 'shop' } }],
    [
      'tg://resolve?domain=example_bot&startapp=abc&mode=fullscreen',
      { username: 'example_bot', webApp: { startParam: 'abc', mode: 'fullscreen' } },
    ],
    [
      'tg://resolve?domain=example_bot&appname=shop',
      { username: 'example_bot', webApp: { shortName: 'shop' } },
    ],
  ])('parses %s', (url, target) => expect(parseTelegramLink(url as string)).toEqual(target));
  it.each([
    'https://t.me/example_bot?startapp=x&startapp=y',
    'https://t.me/example_bot/shop?mode=invalid',
    'https://t.me/example_bot/shop?startapp=hello%20world',
    'https://t.me/example_bot/shop/extra',
    'https://t.me.evil.test/example_bot/shop',
    'tg://resolve?domain=example_bot&appname=shop&post=123',
  ])('rejects malformed Mini App links %s', (url) =>
    expect(parseTelegramLink(url)).toBeUndefined(),
  );
});

describe('sticker pack links', () => {
  it.each([
    'https://t.me/addstickers/Cats_Pack',
    'https://telegram.me/addstickers/Cats_Pack/',
    'http://www.telegram.dog/addstickers/Cats_Pack',
    'tg://addstickers?set=Cats_Pack',
  ])('opens %s as a sticker pack', (url) => {
    expect(parseTelegramLink(url)).toEqual({ stickerPack: 'Cats_Pack' });
  });
  it.each([
    'https://t.me.evil.test/addstickers/Cats',
    'https://user@t.me/addstickers/Cats',
    'https://t.me:8443/addstickers/Cats',
    'https://t.me/addstickers/Cats/extra',
    'https://t.me/addstickers/Cats?url=https://evil.test',
    'tg://addstickers?set=Cats&set=Dogs',
    'tg://addstickers?set=../Cats',
    'tg://addemoji?set=Cats',
  ])('leaves unsupported or ambiguous pack links alone: %s', (url) => {
    expect(parseTelegramLink(url)).toBeUndefined();
  });
});
