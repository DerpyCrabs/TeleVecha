import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoicePlayback, type VoiceTrack } from './voicePlayback';

class FakeAudio extends EventTarget {
  hidden = false;
  dataset = {};
  preload = '';
  src = '';
  currentTime = 0;
  duration = 10;
  paused = true;
  ended = false;
  readyState = 1;
  playbackRate = 1;
  play = vi.fn(async () => {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event('playing'));
  });
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  load() {
    this.currentTime = 0;
  }
  removeAttribute() {
    this.src = '';
  }
  remove = vi.fn();
  finish() {
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }
}
function setup() {
  vi.stubGlobal('document', { body: { append: vi.fn() } });
  const audio = new FakeAudio();
  return { audio, player: createVoicePlayback(() => audio as unknown as HTMLAudioElement) };
}
const track = (id: number, changes: Partial<VoiceTrack> = {}): VoiceTrack => ({
  key: `alice:${id}`,
  peerId: 'alice',
  id,
  label: 'Alice',
  duration: 10,
  unheard: true,
  load: vi.fn(async () => `blob:${id}`),
  heard: vi.fn(),
  ...changes,
});
afterEach(() => vi.unstubAllGlobals());

describe('app voice playback', () => {
  it('keeps duration through metadata loading and publishes playback start atomically', async () => {
    const { audio, player } = setup();
    const note = track(1, { duration: 5 });
    audio.duration = 0;
    const states: Array<{ playing: boolean; waiting: boolean; duration: number }> = [];
    player.subscribe(() => {
      const state = player.snapshot();
      if (state.track)
        states.push({ playing: state.playing, waiting: state.waiting, duration: state.duration });
    });
    player.start(note, [note]);
    audio.dispatchEvent(new Event('durationchange'));
    await vi.waitFor(() => expect(player.snapshot().playing).toBe(true));
    expect(states.every((state) => state.duration === 5)).toBe(true);
    expect(states.every((state) => state.waiting || state.playing)).toBe(true);
    player.dispose();
  });

  it('retains the source queue when another chat updates and skips heard, earlier, and foreign notes', async () => {
    const { audio, player } = setup();
    const first = track(2);
    const next = track(5);
    player.start(first, [
      next,
      track(1),
      track(3, { unheard: false }),
      track(4, { peerId: 'bob' }),
      first,
    ]);
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    const unsubscribe = player.subscribe(vi.fn());
    unsubscribe();
    player.updateQueue('bob', [track(20, { peerId: 'bob' })]);
    player.speed();
    audio.finish();
    await vi.waitFor(() => expect(player.snapshot().track).toBe(next));
    expect(audio.playbackRate).toBe(1.5);
    expect(first.heard).toHaveBeenCalledOnce();
    expect(next.heard).toHaveBeenCalledOnce();
    player.toggle();
    player.toggle();
    expect(next.heard).toHaveBeenCalledTimes(2);
    audio.finish();
    await vi.waitFor(() => expect(player.snapshot().waiting).toBe(false));
    expect(audio.play).toHaveBeenCalledTimes(3);
    player.dispose();
    expect(audio.remove).toHaveBeenCalledOnce();
  });

  it('ignores downloads that finish after another memo starts or the player closes', async () => {
    const { audio, player } = setup();
    let finish!: (source: string) => void;
    const pending = track(1, {
      load: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    player.start(pending, [pending]);
    const latest = track(2);
    player.start(latest, [latest]);
    await vi.waitFor(() => expect(audio.src).toBe('blob:2'));
    finish('blob:old');
    await Promise.resolve();
    expect(audio.src).toBe('blob:2');
    player.start(pending, [pending]);
    player.stop();
    finish('blob:closed');
    await Promise.resolve();
    expect(audio.src).toBe('');
    expect(player.snapshot().track).toBeUndefined();
    expect(pending.heard).not.toHaveBeenCalled();
    player.dispose();
  });

  it('retries failed downloads and cancels pending next-memo lookup on close', async () => {
    const { audio, player } = setup();
    let finishNext!: (value: VoiceTrack) => void;
    const first = track(1, {
      load: vi
        .fn<VoiceTrack['load']>()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue('blob:1'),
      next: () =>
        new Promise((resolve) => {
          finishNext = resolve;
        }),
    });
    player.start(first, [first]);
    await vi.waitFor(() => expect(player.snapshot().error).toBe(true));
    expect(first.heard).not.toHaveBeenCalled();
    player.toggle();
    await vi.waitFor(() => expect(player.snapshot().playing).toBe(true));
    audio.finish();
    expect(player.snapshot().waiting).toBe(true);
    player.stop();
    const next = track(2);
    finishNext(next);
    await Promise.resolve();
    expect(next.load).not.toHaveBeenCalled();
    expect(player.snapshot().track).toBeUndefined();
    player.dispose();
  });
});
