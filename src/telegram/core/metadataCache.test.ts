import { describe, expect, it } from 'vitest';

import {
  parseChatAppearanceCache,
  parseStickerListCache,
  serializeChatAppearanceCache,
  serializeStickerListCache,
} from './metadataCache';

describe('metadataCache', () => {
  it('round-trips sticker file references through JSON', () => {
    const stored = serializeStickerListCache([
      {
        id: 'sticker-1',
        accessHash: '2',
        fileReference: new Uint8Array([3, 4]),
        emoji: '🙂',
        mimeType: 'image/webp',
      },
    ]);

    expect(parseStickerListCache(stored)[0]?.fileReference).toEqual(new Uint8Array([3, 4]));
  });

  it('rejects malformed cache entries instead of trusting a cast', () => {
    expect(() => parseStickerListCache('[{"id":1}]')).toThrow();
    expect(() => parseChatAppearanceCache('{"savedAt":"now","value":null}')).toThrow();
  });

  it('round-trips an absent chat appearance', () => {
    expect(parseChatAppearanceCache(serializeChatAppearanceCache(10, undefined))).toEqual({
      savedAt: 10,
      value: undefined,
    });
  });
});
