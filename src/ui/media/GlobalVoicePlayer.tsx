import { component, domBinding, view } from 'effectweb';
import type { Send } from 'effectweb/program';
import Play from '@effectweb/lucide/icons/play';
import Pause from '@effectweb/lucide/icons/pause';
import X from '@effectweb/lucide/icons/x';
import LoaderCircle from '@effectweb/lucide/icons/loader-circle';
import type { VoicePlayback, VoicePlaybackState } from './voicePlayback';
import { formatMediaDuration } from './mediaPresentation';

interface Props {
  player: VoicePlayback;
}
interface Model {
  props: Props;
  state: VoicePlaybackState;
}
function acquire(
  _element: HTMLElement,
  input: () => { player: VoicePlayback; send: Send<VoicePlaybackState> },
) {
  return input().player.subscribe(() => input().send(input().player.snapshot()));
}
export const GlobalVoicePlayer = component<Props, Model, VoicePlaybackState>({
  init: (props) => ({ props, state: props.player.snapshot() }),
  receive: (model, props) => ({ model: { ...model, props } }),
  update: (model, state) => ({ model: { ...model, state } }),
  view: view((model, send) => {
    const { player } = model.props;
    const state = model.state;
    return (
      <div
        use={domBinding({ player, send }, acquire)}
        class="global-voice-player"
        hidden={!state.track}
        role="region"
        aria-label="Voice memo player"
      >
        <button
          class="global-voice-toggle"
          aria-label={
            state.playing
              ? 'Pause voice memo'
              : state.error
                ? 'Retry voice memo'
                : 'Resume voice memo'
          }
          onClick={() => player.toggle()}
        >
          {state.waiting ? (
            <LoaderCircle size={20} class="animate-spin" />
          ) : state.playing ? (
            <Pause size={18} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={18} fill="currentColor" strokeWidth={0} />
          )}
        </button>
        <div class="global-voice-details">
          <span class="global-voice-title">
            {state.error ? 'Unable to play · retry' : state.track?.label}
          </span>
          <span class="global-voice-time">
            {formatMediaDuration(Math.floor(state.position))} /{' '}
            {formatMediaDuration(state.duration)}
          </span>
        </div>
        <button
          class="global-voice-speed"
          aria-label={`Voice memo speed ${state.rate}x`}
          onClick={() => player.speed()}
        >
          {state.rate}×
        </button>
        <button
          class="global-voice-close"
          aria-label="Close voice memo player"
          onClick={() => player.stop()}
        >
          <X size={18} />
        </button>
        <div class="global-voice-progress">
          <div class="global-voice-progress-track" aria-hidden="true">
            <span
              style={{
                width: `${state.duration > 0 ? Math.min(100, (state.position / state.duration) * 100) : 0}%`,
              }}
            />
          </div>
          <input
            type="range"
            min="0"
            max={state.duration || 1}
            step="0.1"
            value={state.position}
            disabled={!state.ready}
            aria-label="Seek voice memo"
            aria-valuetext={`${formatMediaDuration(Math.floor(state.position))} of ${formatMediaDuration(state.duration)}`}
            onInput={(event) => player.seek(Number(event.currentTarget.value))}
          />
        </div>
      </div>
    );
  }),
});
