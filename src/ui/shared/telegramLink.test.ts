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
    'https://t.me/share/url?url=https://example.com',
    'https://t.me/some_bot?start=payload',
    'https://t.me/user/story/42',
    'https://t.me/name/0',
    'https://t.me/name/2147483648',
    'https://t.me/name/1?comment=invalid',
    'https://t.me/name?comment=42',
    'tg://resolve?domain=some_bot&start=payload',
    'https://t.me/name/1/2/3',
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

describe('shared folder links', () => {
  it.each(['https://t.me/addlist/Abc_123-x', 'tg://addlist?slug=Abc_123-x'])(
    'opens a folder preview for %s',
    (url) => {
      expect(parseTelegramLink(url)).toEqual({ folderInvite: 'Abc_123-x' });
    },
  );
  it.each([
    'https://t.me.evil.test/addlist/a',
    'https://x@t.me/addlist/a',
    'tg://addlist?slug=a&slug=b',
    'tg://addlist?slug=a%2Fb',
    'https://t.me/addlist/a?other=b',
  ])('rejects malformed invitation %s', (url) => {
    expect(parseTelegramLink(url)).toBeUndefined();
  });
});

describe('forum message links', () => {
  it.each([
    ['https://t.me/forum_group/42/80', { username: 'forum_group', topicId: 42, messageId: 80 }],
    ['https://t.me/c/202/42/80', { peerId: 'c:202', topicId: 42, messageId: 80 }],
    ['https://t.me/c/202/80?thread=42', { peerId: 'c:202', topicId: 42, messageId: 80 }],
    [
      'tg://resolve?domain=forum_group&post=80&thread=42',
      { username: 'forum_group', topicId: 42, messageId: 80 },
    ],
    [
      'tg://privatepost?channel=202&post=80&thread=42',
      { peerId: 'c:202', topicId: 42, messageId: 80 },
    ],
  ])('recognizes %s', (url, target) => expect(parseTelegramLink(url as string)).toEqual(target));
  it.each([
    'https://t.me/c/202/0/80',
    'https://t.me/forum_group/x/80',
    'https://t.me/forum_group/42/80?thread=43',
    'https://t.me/forum_group/80?thread=42&thread=43',
    'tg://privatepost?channel=bad&post=80',
  ])('rejects malformed topic link %s', (url) => expect(parseTelegramLink(url)).toBeUndefined());
});

describe('private chat invitations', () => {
  it.each([
    'https://t.me/+Invite_12-abc',
    'https://telegram.me/joinchat/Invite_12-abc',
    'tg://join?invite=Invite_12-abc',
  ])('recognizes %s', (url) =>
    expect(parseTelegramLink(url)).toEqual({ chatInvite: 'Invite_12-abc' }),
  );
  it.each([
    'https://t.me.evil.test/+Invite',
    'https://user@t.me/+Invite',
    'https://t.me/+Invite/extra',
    'tg://join?invite=one&invite=two',
    'https://t.me/+Invite?redirect=evil',
    'https://t.me/+Invite#other',
    'https://t.me/joinchat/',
  ])('rejects malformed invitation %s', (url) => expect(parseTelegramLink(url)).toBeUndefined());
});
