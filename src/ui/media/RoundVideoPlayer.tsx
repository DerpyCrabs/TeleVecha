import { component, domBinding, view } from 'effectweb';
import type { Send } from 'effectweb/program';
import Play from '@effectweb/lucide/icons/play';
import Pause from '@effectweb/lucide/icons/pause';
import LoaderCircle from '@effectweb/lucide/icons/loader-circle';
import RotateCcw from '@effectweb/lucide/icons/rotate-ccw';

interface Props {
  source: string;
  mediaUnread?: boolean | undefined;
  duration?: number | undefined;
  onPlaybackStarted?: (() => void) | undefined;
}
const initial = () => ({ position: 0, duration: 0, playing: false, waiting: false, error: false });
type Playback = ReturnType<typeof initial>;
type Model = Playback & { props: Props };
type Message = { type: 'Playback'; state: Playback } | { type: 'Error' };
function acquireVideo(video: HTMLVideoElement, input: () => { send: Send<Message>; props: Props }) {
  let waiting = false;
  const sync = () =>
    input().send({
      type: 'Playback',
      state: {
        position: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        playing: !video.paused && !video.ended,
        waiting,
        error: Boolean(video.error),
      },
    });
  const playing = () => {
    waiting = false;
    for (const other of document.querySelectorAll<HTMLVideoElement>('video[data-round-video]')) {
      if (other !== video && !other.paused) other.pause();
    }
    sync();
    input().props.onPlaybackStarted?.();
  };
  const wait = () => {
    waiting = true;
    sync();
  };
  const settled = () => {
    waiting = false;
    sync();
  };
  const events = ['timeupdate', 'loadedmetadata', 'durationchange', 'play', 'seeked'] as const;
  for (const event of events) video.addEventListener(event, sync);
  video.addEventListener('playing', playing);
  video.addEventListener('waiting', wait);
  const stopEvents = ['pause', 'ended', 'error', 'canplay'] as const;
  for (const event of stopEvents) video.addEventListener(event, settled);
  return () => {
    for (const event of events) video.removeEventListener(event, sync);
    for (const event of stopEvents) video.removeEventListener(event, settled);
    video.removeEventListener('playing', playing);
    video.removeEventListener('waiting', wait);
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}
function videoFor(element: HTMLElement) {
  return element.closest('.round-video-player')?.querySelector('video');
}
export const RoundVideoPlayer = component<Props, Model, Message>({
  init: (props) => ({ props, ...initial() }),
  receive: (model, props) => ({
    model: { ...model, ...(props.source !== model.props.source ? initial() : {}), props },
  }),
  update: (model, message) => ({
    model:
      message.type === 'Playback'
        ? { ...model, ...message.state }
        : { ...model, error: true, waiting: false },
  }),
  view: view((model, send) => {
    const duration = model.duration || model.props.duration || 0;
    const position = Math.min(duration, Math.max(0, model.position));
    const active = model.playing || model.waiting || position > 0;
    const progress =
      !active && model.props.mediaUnread === false
        ? 100
        : duration > 0
          ? (position / duration) * 100
          : 0;
    const toggle = (element: HTMLElement) => {
      const video = videoFor(element);
      if (!video) return;
      if (!video.paused) {
        video.pause();
        return;
      }
      if (video.error) video.load();
      if (video.ended) video.currentTime = 0;
      void video.play().catch((error: unknown) => {
        if (video.isConnected && !(error instanceof DOMException && error.name === 'AbortError'))
          send({ type: 'Error' });
      });
    };
    return (
      <div
        class="round-video-player"
        data-media-unread={model.props.mediaUnread}
        classList={{ 'round-video-feedback': model.waiting || model.error }}
      >
        <video
          use={domBinding({ send, props: model.props }, acquireVideo)}
          src={model.props.source}
          playsinline
          preload="metadata"
          data-round-video
          aria-label={
            model.props.mediaUnread === false
              ? 'Watched video message'
              : model.props.mediaUnread === true
                ? 'Unwatched video message'
                : 'Round video message'
          }
        />
        <svg class="round-video-progress" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="round-video-progress-track" cx="50" cy="50" r="48" />
          <circle
            cx="50"
            cy="50"
            r="48"
            pathLength="100"
            stroke-dasharray={progress >= 100 ? undefined : '100'}
            stroke-dashoffset={100 - progress}
          />
        </svg>
        <button
          type="button"
          class="round-video-toggle"
          aria-label={
            model.error
              ? 'Retry video message'
              : model.playing
                ? 'Pause video message'
                : 'Play video message'
          }
          aria-busy={model.waiting}
          onClick={(event) => {
            event.stopPropagation();
            toggle(event.currentTarget);
          }}
        >
          <span class="round-video-play-icon">
            {model.waiting ? (
              <LoaderCircle class="animate-spin" size={28} />
            ) : model.error ? (
              <RotateCcw size={28} />
            ) : model.playing ? (
              <Pause size={28} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play size={28} fill="currentColor" strokeWidth={0} />
            )}
          </span>
        </button>
      </div>
    );
  }),
});
