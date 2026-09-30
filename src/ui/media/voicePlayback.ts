const COMPLETED_DISMISS_DELAY_MS = 5_000;
export const VOICE_DISMISS_ANIMATION_MS = 250;

export interface VoiceTrack {
  key: string;
  peerId: string;
  id: number;
  label: string;
  duration: number;
  unheard: boolean;
  load: () => Promise<string>;
  heard: () => void;
  next?: ((heard: ReadonlySet<string>) => Promise<VoiceTrack | undefined>) | undefined;
}

export interface VoicePlaybackState {
  closing: boolean;
  track: VoiceTrack | undefined;
  position: number;
  duration: number;
  playing: boolean;
  waiting: boolean;
  ready: boolean;
  rate: number;
  error: boolean;
}

/** One audio owner per app; message bubbles only subscribe to it. */
export function createVoicePlayback(createAudio = () => document.createElement('audio')) {
  let audio: HTMLAudioElement | undefined;
  let queue: VoiceTrack[] = [];
  let generation = 0;
  let dismissTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const heard = new Set<string>();
  const listeners = new Set<() => void>();
  let state: VoicePlaybackState = {
    closing: false,
    track: undefined,
    position: 0,
    duration: 0,
    playing: false,
    waiting: false,
    ready: false,
    rate: 1,
    error: false,
  };
  const publish = (changes: Partial<VoicePlaybackState>) => {
    state = { ...state, ...changes };
    for (const listener of listeners) listener();
  };
  const cancelDismiss = () => {
    clearTimeout(dismissTimer);
    clearTimeout(closeTimer);
    dismissTimer = undefined;
    closeTimer = undefined;
    if (state.closing) publish({ closing: false });
  };
  const scheduleDismiss = () => {
    cancelDismiss();
    if (!audio?.ended || state.playing) return;
    dismissTimer = setTimeout(() => {
      dismissTimer = undefined;
      publish({ closing: true });
      closeTimer = setTimeout(stop, VOICE_DISMISS_ANIMATION_MS);
    }, COMPLETED_DISMISS_DELAY_MS);
  };
  const ensureAudio = () => {
    if (audio) return audio;
    audio = createAudio();
    audio.hidden = true;
    audio.dataset.voiceAudio = '';
    audio.preload = 'metadata';
    // Mounted at app lifetime so the asset cache also protects its object URL.
    document.body.append(audio);
    const sync = (changes: Partial<VoicePlaybackState> = {}) => {
      if (!audio) return;
      publish({
        position: audio.currentTime,
        duration:
          Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.duration,
        playing: !audio.paused && !audio.ended,
        ready: audio.readyState >= 1,
        rate: audio.playbackRate,
        ...changes,
      });
    };
    for (const event of ['timeupdate', 'loadedmetadata', 'durationchange', 'seeked', 'ratechange'])
      audio.addEventListener(event, () => sync());
    audio.addEventListener('playing', () => {
      cancelDismiss();
      sync({ waiting: false, error: false });
      const track = state.track;
      if (track) {
        heard.add(track.key);
        // The engine deduplicates successful receipts; resuming retries a failed receipt.
        track.heard();
      }
    });
    audio.addEventListener('pause', () => {
      sync({ waiting: false });
    });
    audio.addEventListener('waiting', () => publish({ waiting: true }));
    audio.addEventListener('error', () => publish({ error: true, waiting: false, playing: false }));
    audio.addEventListener('ended', () => {
      sync();
      const current = state.track;
      if (!current) return;
      const token = generation;
      const localNext = () =>
        queue.find(
          (track) =>
            track.peerId === current.peerId &&
            track.id > current.id &&
            track.unheard &&
            !heard.has(track.key),
        );
      const advance = async () => {
        publish({ waiting: true });
        let next = localNext();
        try {
          if (current.next) next = await current.next(heard);
        } catch {
          // The retained queue still works while offline.
        }
        if (token !== generation) return;
        publish({ waiting: false });
        if (next) await play(next);
        else scheduleDismiss();
      };
      void advance().catch(() => publish({ waiting: false, error: true }));
    });
    return audio;
  };
  const play = async (track: VoiceTrack) => {
    cancelDismiss();
    const token = ++generation;
    const element = ensureAudio();
    element.pause();
    element.removeAttribute('src');
    element.load();
    publish({
      track,
      position: 0,
      duration: track.duration,
      playing: false,
      waiting: true,
      ready: false,
      error: false,
    });
    try {
      const source = await track.load();
      if (token !== generation) return;
      element.src = source;
      element.playbackRate = state.rate;
      await element.play();
    } catch {
      if (token === generation) publish({ waiting: false, playing: false, error: true });
    }
  };
  const stop = () => {
    cancelDismiss();
    generation++;
    audio?.pause();
    audio?.removeAttribute('src');
    audio?.load();
    queue = [];
    heard.clear();
    publish({
      track: undefined,
      position: 0,
      duration: 0,
      playing: false,
      waiting: false,
      ready: false,
      error: false,
    });
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      listener();
      return () => {
        listeners.delete(listener);
      };
    },
    updateQueue(peerId: string, tracks: VoiceTrack[]) {
      if (state.track?.peerId === peerId) queue = [...tracks].sort((a, b) => a.id - b.id);
    },
    start(track: VoiceTrack, tracks: VoiceTrack[]) {
      queue = [...tracks].sort((a, b) => a.id - b.id);
      void play(track).catch(() => publish({ waiting: false, error: true }));
    },
    toggle() {
      if (!state.track) return;
      cancelDismiss();
      if (state.waiting) {
        stop();
        return;
      }
      if (state.error) {
        void play(state.track).catch(() => publish({ waiting: false, error: true }));
        return;
      }
      if (!audio?.paused) audio?.pause();
      else {
        const token = generation;
        void audio.play().catch(() => {
          if (token === generation) publish({ error: true, waiting: false });
        });
      }
    },
    seek(position: number) {
      cancelDismiss();
      if (audio && state.ready) audio.currentTime = Math.min(state.duration, Math.max(0, position));
    },
    speed() {
      const rate = state.rate === 1 ? 1.5 : state.rate === 1.5 ? 2 : 1;
      if (audio) {
        audio.defaultPlaybackRate = rate;
        audio.playbackRate = rate;
      }
      publish({ rate });
    },
    stop,
    dispose() {
      stop();
      audio?.remove();
      audio = undefined;
      heard.clear();
      listeners.clear();
    },
  };
}
export type VoicePlayback = ReturnType<typeof createVoicePlayback>;
/** The app's shared voice player; `start` resolves the message and its playlist by track key. */
export interface VoiceService {
  readonly player: VoicePlayback;
  readonly start: (key: string) => void;
}
/** One voice message's handle on the shared player. */
export interface VoiceControl {
  readonly service: VoiceService;
  readonly key: string;
}
