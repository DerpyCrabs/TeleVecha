import { afterEach, expect, it, vi } from 'vitest';
import { canReuseUploadedMedia, readVideoPreview } from './localMedia';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('reuses renamed photos and unchanged documents but rejects a changed video encoding', () => {
  const image = new Blob(['image'], { type: 'image/png' });
  expect(
    canReuseUploadedMedia({ kind: 'photo', name: 'photo-123.jpg', mimeType: 'image/jpeg' }, image),
  ).toBe(true);
  const video = new Blob(['video'], { type: 'video/webm' });
  expect(
    canReuseUploadedMedia({ kind: 'video', name: 'video.webm', mimeType: 'video/webm' }, video),
  ).toBe(true);
  expect(
    canReuseUploadedMedia({ kind: 'video', name: 'video.mp4', mimeType: 'video/mp4' }, video),
  ).toBe(false);
});

it.each(['abort', 'timeout', 'decode-error'] as const)(
  'releases the video and its URL on %s',
  async (failure) => {
    vi.useFakeTimers();
    const video = {
      src: '',
      onloadeddata: null as (() => void) | null,
      onerror: null as (() => void) | null,
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    vi.stubGlobal('document', { createElement: () => video });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-video');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const abort = new AbortController();
    const result = readVideoPreview(new Blob(['video']), abort.signal);
    const rejected = expect(result).rejects.toThrow();
    if (failure === 'abort') abort.abort();
    else if (failure === 'timeout') await vi.advanceTimersByTimeAsync(15_000);
    else video.onerror!();
    await rejected;
    expect(video.onloadeddata).toBeNull();
    expect(video.onerror).toBeNull();
    expect(video.removeAttribute).toHaveBeenCalledExactlyOnceWith('src');
    expect(video.load).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:local-video');
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('ignores a thumbnail that finishes encoding after cancellation', async () => {
  const video = {
    src: '',
    onloadeddata: null as (() => void) | null,
    onerror: null as (() => void) | null,
    videoWidth: 600,
    videoHeight: 400,
    duration: 1,
    removeAttribute: vi.fn(),
    load: vi.fn(),
  };
  let finish!: (blob: Blob) => void;
  const canvas = {
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (callback: typeof finish) => {
      finish = callback;
    },
  };
  vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'video' ? video : canvas) });
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  const abort = new AbortController();
  const result = readVideoPreview(new Blob(['video']), abort.signal);
  video.onloadeddata!();
  abort.abort();
  await expect(result).rejects.toThrow('canceled');
  finish(new Blob(['thumbnail'], { type: 'image/jpeg' }));
  expect(revoke).toHaveBeenCalledOnce();
  expect(video.load).toHaveBeenCalledOnce();
});
