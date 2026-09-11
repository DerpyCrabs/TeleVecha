import { component, domBinding, view } from 'effectweb';
import type { Send } from 'effectweb/program';
import Play from '@effectweb/lucide/icons/play';
import Pause from '@effectweb/lucide/icons/pause';
import Download from '@effectweb/lucide/icons/download';
import RotateCcw from '@effectweb/lucide/icons/rotate-ccw';
import LoaderCircle from '@effectweb/lucide/icons/loader-circle';
import { formatMediaDuration } from './mediaPresentation';
import { voiceWaveformBars } from './voiceWaveform';

interface VoicePlayerProps {
  source: string;
  duration?: number | undefined;
  waveform?: readonly number[] | undefined;
  loading: boolean;
  error: string;
  load: () => void;
  onPlaybackStarted?: (() => void) | undefined;
}
interface PlaybackState {
  position: number;
  duration: number;
  playing: boolean;
  waiting: boolean;
  ready: boolean;
  rate: number;
  error: boolean;
}
type VoiceModel = PlaybackState & { props: VoicePlayerProps };
type VoiceMessage = { type: 'Playback'; state: PlaybackState } | { type: 'Error' };
const initialPlayback = (): PlaybackState => ({
  position: 0,
  duration: 0,
  playing: false,
  waiting: false,
  ready: false,
  rate: 1,
  error: false,
});
type AudioInput = {
  send: Send<VoiceMessage>;
  onPlaybackStarted: VoicePlayerProps['onPlaybackStarted'];
};

function acquireAudio(audio: HTMLAudioElement, input: () => AudioInput) {
  let waiting = false;
  const update = () =>
    input().send({
      type: 'Playback',
      state: {
        position: audio.currentTime,
        duration: Number.isFinite(audio.duration) ? audio.duration : 0,
        playing: !audio.paused && !audio.ended,
        waiting,
        ready: audio.readyState >= 1,
        rate: audio.playbackRate,
        error: Boolean(audio.error),
      },
    });
  const onPlaying = () => {
    waiting = false;
    for (const other of document.querySelectorAll<HTMLAudioElement>('audio[data-voice-audio]')) {
      if (other !== audio && !other.paused) other.pause();
    }
    update();
    input().onPlaybackStarted?.();
  };
  const onWaiting = () => {
    waiting = true;
    update();
  };
  const onPause = () => {
    waiting = false;
    update();
  };
  const events = [
    'timeupdate',
    'loadedmetadata',
    'durationchange',
    'ended',
    'seeked',
    'ratechange',
    'error',
  ] as const;
  for (const event of events) audio.addEventListener(event, update);
  audio.addEventListener('playing', onPlaying);
  audio.addEventListener('waiting', onWaiting);
  audio.addEventListener('pause', onPause);
  return () => {
    for (const event of events) audio.removeEventListener(event, update);
    audio.removeEventListener('playing', onPlaying);
    audio.removeEventListener('waiting', onWaiting);
    audio.removeEventListener('pause', onPause);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  };
}

function playerAudio(element: HTMLElement) {
  return element.closest('.voice-player')?.querySelector('audio');
}

export const VoicePlayer = component<VoicePlayerProps, VoiceModel, VoiceMessage>({
  init: (props) => ({ props, ...initialPlayback() }),
  receive: (model, props) => ({
    model: { ...model, ...(props.source !== model.props.source ? initialPlayback() : {}), props },
  }),
  update: (model, message) => ({
    model:
      message.type === 'Playback'
        ? { ...model, ...message.state }
        : { ...model, waiting: false, playing: false, error: true },
  }),
  view: view((model, send) => {
    const props = model.props;
    const duration = model.duration || props.duration || 0;
    const position = Math.min(duration, Math.max(0, model.position));
    const elapsed = formatMediaDuration(Math.floor(position));
    const total = formatMediaDuration(duration);
    const busy = props.loading || model.waiting;
    const failed = Boolean(props.error) || model.error;
    const bars = voiceWaveformBars(props.waveform);
    const waveform = bars
      .map((height, index) => `M${index * 5 + 2.5} ${(32 - height) / 2}v${height}`)
      .join(' ');
    const toggle = (element: HTMLElement) => {
      const audio = playerAudio(element);
      if (!props.source) {
        props.load();
        return;
      }
      if (!audio) return;
      if (!audio.paused) {
        audio.pause();
        return;
      }
      if (audio.error) audio.load();
      void audio.play().catch((error: unknown) => {
        if (audio.isConnected && !(error instanceof DOMException && error.name === 'AbortError'))
          send({ type: 'Error' });
      });
    };
    return (
      <div class="voice-player" classList={{ 'voice-playing': model.playing }}>
        <audio
          use={domBinding({ send, onPlaybackStarted: props.onPlaybackStarted }, acquireAudio)}
          src={props.source || undefined}
          preload="metadata"
          data-voice-audio
          hidden
          aria-hidden="true"
        />
        <button
          type="button"
          class="voice-play"
          disabled={props.loading}
          aria-label={
            failed
              ? 'Retry voice message'
              : model.playing
                ? 'Pause voice message'
                : 'Play voice message'
          }
          aria-busy={busy}
          onClick={(event) => {
            event.stopPropagation();
            toggle(event.currentTarget);
          }}
        >
          {busy ? (
            <LoaderCircle class="animate-spin" size={21} />
          ) : failed ? (
            <RotateCcw size={20} />
          ) : model.playing ? (
            <Pause size={21} fill="currentColor" strokeWidth={0} />
          ) : props.source ? (
            <Play size={21} fill="currentColor" strokeWidth={0} />
          ) : (
            <Download size={21} />
          )}
        </button>
        <div class="voice-track">
          <div class="voice-seek">
            <svg viewBox="0 0 240 32" preserveAspectRatio="none" aria-hidden="true">
              <path class="voice-waveform" d={waveform} />
              <path
                class="voice-waveform-played"
                d={waveform}
                style={{
                  'clip-path': `inset(0 ${duration > 0 ? 100 - (position / duration) * 100 : 100}% 0 0)`,
                }}
              />
            </svg>
            <input
              type="range"
              min="0"
              max={duration || 1}
              step="0.1"
              value={position}
              disabled={!model.ready}
              aria-label="Seek voice message"
              aria-valuetext={`${elapsed} of ${total}`}
              onClick={(event) => event.stopPropagation()}
              onInput={(event) => {
                const audio = playerAudio(event.currentTarget);
                if (audio && Number.isFinite(audio.duration))
                  audio.currentTime = Number(event.currentTarget.value);
              }}
            />
          </div>
          <div class="voice-details">
            <span class="voice-duration">
              {failed
                ? 'Unable to play'
                : props.loading
                  ? 'Loading…'
                  : position > 0 && position < duration
                    ? `${elapsed} / ${total}`
                    : total || 'Voice message'}
            </span>
            <button
              type="button"
              class="voice-speed"
              aria-label={`Playback speed ${model.rate}x`}
              title="Change playback speed"
              onClick={(event) => {
                event.stopPropagation();
                const audio = playerAudio(event.currentTarget);
                if (audio) audio.playbackRate = model.rate === 1 ? 1.5 : model.rate === 1.5 ? 2 : 1;
              }}
            >
              {model.rate}×
            </button>
          </div>
        </div>
      </div>
    );
  }),
});
