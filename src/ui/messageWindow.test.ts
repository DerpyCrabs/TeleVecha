import { describe, expect, it } from 'vitest';

import { albumSafeMessageWindow } from './messageWindow';

describe('albumSafeMessageWindow', () => {
  it('moves the start backward instead of cutting the beginning of an album', () => {
    const messages = [{ groupedId: 'album' }, { groupedId: 'album' }, {}, {}, {}];

    expect(albumSafeMessageWindow(messages, 1, 3)).toEqual({ start: 0, end: 4 });
  });

  it('extends the end instead of cutting the end of an album', () => {
    const messages = [{}, {}, { groupedId: 'album' }, { groupedId: 'album' }, {}];

    expect(albumSafeMessageWindow(messages, 0, 3)).toEqual({ start: 0, end: 4 });
  });

  it('keeps the newest edge when the requested start lands inside an album', () => {
    const messages = [
      {},
      {},
      {},
      { groupedId: 'album' },
      { groupedId: 'album' },
      { groupedId: 'album' },
      {},
      {},
    ];

    expect(albumSafeMessageWindow(messages, 5, 3)).toEqual({ start: 3, end: 8 });
  });
});
