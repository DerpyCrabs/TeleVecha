import { describe, expect, it } from 'vitest';

import type { TelegramMedia } from '../../telegram/types';
import { describeMedia, formatMediaDuration, mediaPresentation } from './mediaPresentation';

function media(overrides: Partial<TelegramMedia> = {}): TelegramMedia {
  return {
    kind: 'file',
    name: 'diagram.png',
    mimeType: 'image/png',
    size: 42_000,
    ...overrides,
  };
}

describe('media presentation', () => {
  it('keeps image documents as file cards while allowing image preview', () => {
    expect(mediaPresentation(media())).toEqual({
      display: 'file',
      preview: 'image',
      preload: true,
    });
  });

  it('does not preview arbitrary documents', () => {
    expect(mediaPresentation(media({ name: 'report.pdf', mimeType: 'application/pdf' }))).toEqual({
      display: 'file',
      preload: false,
    });
  });

  it('keeps Telegram photos inline and previewable', () => {
    expect(
      mediaPresentation(media({ kind: 'photo', name: 'photo.jpg', mimeType: 'image/jpeg' })),
    ).toEqual({ display: 'image', preview: 'image', preload: true });
  });

  it('formats file size and type for attachment metadata', () => {
    expect(describeMedia(media())).toBe('41 KB · image/png');
    expect(describeMedia(media({ size: 2_621_440 }))).toBe('2.5 MB · image/png');
  });

  it('formats video duration without dropping hours', () => {
    expect(formatMediaDuration(45.369)).toBe('0:45');
    expect(formatMediaDuration(690.167)).toBe('11:30');
    expect(formatMediaDuration(3_661)).toBe('1:01:01');
  });
});
