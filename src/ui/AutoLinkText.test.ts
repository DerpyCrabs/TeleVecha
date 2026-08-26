import { describe, expect, it } from 'vitest';

import { linkifyText } from './AutoLinkText';

describe('linkifyText', () => {
  it('links URLs, email addresses, and Telegram usernames without swallowing punctuation', () => {
    expect(
      linkifyText('Site https://example.com, www.example.org. me@example.com @telegram'),
    ).toEqual([
      { text: 'Site ' },
      { text: 'https://example.com', href: 'https://example.com/' },
      { text: ',' },
      { text: ' ' },
      { text: 'www.example.org', href: 'https://www.example.org/' },
      { text: '.' },
      { text: ' ' },
      { text: 'me@example.com', href: 'mailto:me@example.com' },
      { text: ' ' },
      { text: '@telegram', href: 'https://t.me/telegram' },
    ]);
  });
});
