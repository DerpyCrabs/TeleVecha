import { component, domBinding, view } from 'effectweb';
import { Cause, Effect, Queue, Stream } from 'effect';
import type { ChatMessage } from '../../domain/models';
import type { TelegramTransferProgress } from '../../telegram/types';
import Download from '@effectweb/lucide/icons/download';
import FileText from '@effectweb/lucide/icons/file-text';
import Play from '@effectweb/lucide/icons/play';
import LoaderCircle from '@effectweb/lucide/icons/loader-circle';
import X from '@effectweb/lucide/icons/x';
import type { Send, Transition } from 'effectweb';
import { MediaViewer } from './MediaViewer';
import { TgsPlayer } from './TgsPlayer';
import type { VoiceControl } from './voicePlayback';
import { VoicePlayer } from './VoicePlayer';
import { RoundVideoPlayer } from './RoundVideoPlayer';
import { saveMediaUrl } from './mediaActions';
import {
  describeMedia,
  formatMediaDuration,
  formatMediaSize,
  mediaPresentation,
} from './mediaPresentation';
const commandDisplay = 'display';
const commandOriginal = 'original';
function fitChatPhoto(frame: HTMLElement, input: () => { width: number; height: number }) {
  if (!frame.parentElement?.parentElement?.matches('article.message')) return;
  const update = () => {
    const { width, height } = input();
    if (!width || !height) return;
    const ratio = width / height;
    frame.style.setProperty('--photo-min-height', ratio > 1 && width >= 192 ? '100px' : '0px');
    const box = frame.getBoundingClientRect();
    if (!box.width || !box.height) return;
    // Telegram Desktop's DecideFrameResize permits vertical cropping only
    // when at least three quarters of the scaled image remains visible.
    const scaledHeight = box.width / ratio;
    frame.dataset.photoFit =
      scaledHeight >= box.height - 1 && scaledHeight * 0.75 <= box.height + 1 ? 'cover' : 'contain';
  };
  // Set the floor before measuring, including when the first render is offscreen.
  frame.dataset.photoFit = 'contain';
  const observer = new ResizeObserver(update);
  observer.observe(frame);
  update();
  return { update, dispose: () => observer.disconnect() };
}

const commandDownload = 'download';
const commandOpen = 'open';

interface MediaAttachmentProps {
  voiceControl?: VoiceControl | undefined;
  mediaUnread?: boolean | undefined;
  media: NonNullable<ChatMessage['media']>;
  load: (progress?: TelegramTransferProgress) => Effect.Effect<string, unknown>;
  loadPlayback?: (() => Effect.Effect<string, unknown>) | undefined;
  loadPreview?: (() => Effect.Effect<string, unknown>) | undefined;
  cachedUrl?: (() => string | undefined) | undefined;
  cachedPreviewUrl?: (() => string | undefined) | undefined;
  uploadProgress?: number | undefined;
  uploadFailed?: boolean | undefined;
  compact?: boolean | undefined;
  decorative?: boolean | undefined;
  revision?: string | number | undefined;
  messageKey?: string | undefined;
  onOpenPreview?: ((preview: MediaPreview) => boolean | void) | undefined;
  onPlaybackStarted?: (() => void) | undefined;
  protected?: boolean | undefined;
}
export interface MediaPreview {
  kind: 'image' | 'video';
  name: string;
  url: string;
  origin?: DOMRect | undefined;
}
type MediaAttachmentState = {
  identity: string;
  url: string;
  previousImageUrl: string;
  loading: boolean;
  error: string;
  standalonePreview: MediaPreview | undefined;
  inlineVideoUrl: string;
  inlineVideoPlaying: boolean;
  nearViewport: boolean;
  spoilerRevealed: boolean;
  downloadProgress: number | undefined;
};
type MediaAttachmentModel = MediaAttachmentState & { readonly props: MediaAttachmentProps };
type MediaAttachmentMessage =
  | { type: 'Load' }
  | { type: 'Original'; purpose: Purpose; origin?: DOMRect | undefined }
  | { type: 'OriginalLoaded'; purpose: Purpose; url: string; origin?: DOMRect | undefined }
  | { type: 'Cancel' }
  | { type: 'StopHover' }
  | { type: 'PreviewOpened'; standalone: MediaPreview | undefined }
  | { type: 'Url'; value: string }
  | { type: 'Loading'; value: boolean }
  | { type: 'Error'; value: string }
  | { type: 'StandalonePreview'; value: MediaPreview | undefined }
  | { type: 'InlineVideoUrl'; value: string }
  | { type: 'InlineVideoPlaying'; value: boolean }
  | { type: 'NearViewport'; value: boolean }
  | { type: 'SpoilerRevealed'; value: boolean }
  | { type: 'DownloadProgress'; value: number | undefined };
type Purpose = 'preview' | 'download' | 'hover';
function identity(props: MediaAttachmentProps) {
  return `${props.revision ?? ''}:${props.media.cacheKey ?? ''}:${props.media.kind}:${props.media.name}:${props.media.mimeType}`;
}
function cachedDisplayUrl(props: MediaAttachmentProps) {
  return props.loadPreview && mediaPresentation(props.media).display !== 'image'
    ? (props.cachedPreviewUrl?.() ?? '')
    : (props.cachedUrl?.() ?? '');
}
function transfer(
  props: MediaAttachmentProps,
  display: boolean,
  purpose?: Purpose,
  origin?: DOMRect,
) {
  return Stream.callback<MediaAttachmentMessage>((queue) =>
    Effect.gen(function* () {
      const lightweight =
        display && Boolean(props.loadPreview) && mediaPresentation(props.media).display !== 'image';
      const progress: TelegramTransferProgress = Object.assign(
        (value: number) => Queue.offerUnsafe(queue, { type: 'DownloadProgress', value }),
        { isCanceled: false },
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          progress.isCanceled = true;
        }),
      );
      const result = yield* Effect.suspend(() => {
        const cached = lightweight ? props.cachedPreviewUrl?.() : props.cachedUrl?.();
        return cached
          ? Effect.succeed(cached)
          : lightweight
            ? props.loadPreview!()
            : purpose !== 'download' &&
                props.loadPlayback &&
                props.media.mimeType.startsWith('video/')
              ? props.loadPlayback()
              : props.load(progress);
      }).pipe(
        Effect.flatMap((url) => {
          const presentation = mediaPresentation(props.media);
          const image =
            presentation.display === 'image' || presentation.preview === 'image' || lightweight;
          return display && image
            ? Effect.tryPromise(async () => {
                const image = new Image();
                image.src = url;
                await image.decode();
                return url;
              })
            : Effect.succeed(url);
        }),
        Effect.matchCause({
          onSuccess: (url): MediaAttachmentMessage =>
            display
              ? { type: 'Url', value: url }
              : { type: 'OriginalLoaded', purpose: purpose!, url, origin },
          onFailure: (cause): MediaAttachmentMessage => ({
            type: 'Error',
            value: String(Cause.squash(cause)),
          }),
        }),
      );
      Queue.offerUnsafe(queue, result);
      Queue.endUnsafe(queue);
    }),
  );
}
function startDisplay(
  model: MediaAttachmentModel,
): Transition<MediaAttachmentModel, MediaAttachmentMessage> {
  if (model.url || model.loading) return { model };
  return {
    model: { ...model, loading: true, error: '', downloadProgress: 0 },
    commands: [{ policy: 'replace', key: commandDisplay, stream: transfer(model.props, true) }],
  };
}
function automatic(model: MediaAttachmentModel) {
  return model.nearViewport && mediaPresentation(model.props.media).preload && !model.error
    ? startDisplay(model)
    : { model };
}
function observeVisibility(element: HTMLElement, input: () => Send<MediaAttachmentMessage>) {
  if (typeof IntersectionObserver === 'undefined') {
    input()({ type: 'NearViewport', value: true });
    return () => undefined;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        input()({ type: 'NearViewport', value: true });
      }
    },
    {
      root: element.closest('[data-testid="message-scroller"], .shared-items'),
      rootMargin: '600px 0px',
    },
  );
  observer.observe(element);
  return () => observer.disconnect();
}
const visibilityMount = (send: Send<MediaAttachmentMessage>) =>
  domBinding(send, observeVisibility, { identity: send });
function pause(video: HTMLVideoElement) {
  video.pause();
  video.currentTime = 0;
}
function play(video: HTMLVideoElement) {
  void video.play().catch(() => undefined);
}
function acquirePlayback(
  video: HTMLVideoElement,
  input: () => { playing: boolean; source: string },
) {
  let current = input();
  const sync = () => {
    if (current.playing) {
      if (current.source) play(video);
    } else pause(video);
  };
  video.addEventListener('loadedmetadata', sync);
  sync();
  return {
    update() {
      const next = input();
      if (next.playing === current.playing && next.source === current.source) return;
      current = next;
      sync();
    },
    dispose: () => {
      video.removeEventListener('loadedmetadata', sync);
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
  };
}
const playbackMount = (playing: boolean, source: string) =>
  domBinding({ playing, source }, acquirePlayback);
export const MediaAttachment = component<
  MediaAttachmentProps,
  MediaAttachmentState,
  MediaAttachmentMessage
>(
  {
    init: (props) => ({
      identity: identity(props),
      url: cachedDisplayUrl(props),
      previousImageUrl: '',
      loading: false,
      error: '',
      standalonePreview: undefined,
      inlineVideoUrl: '',
      inlineVideoPlaying: false,
      nearViewport: false,
      spoilerRevealed: false,
      downloadProgress: undefined,
    }),
    receive: (model, previous) => {
      const key = identity(model.props);
      const changed = key !== model.identity;
      const next = changed
        ? {
            ...model,
            identity: key,
            url: cachedDisplayUrl(model.props),
            previousImageUrl:
              model.props.messageKey !== undefined &&
              model.props.messageKey === previous.messageKey &&
              mediaPresentation(model.props.media).display === 'image' &&
              mediaPresentation(previous.media).display === 'image' &&
              (!previous.media.spoiler || model.spoilerRevealed) &&
              !model.props.media.spoiler
                ? model.url || model.previousImageUrl
                : '',
            error: '',
            loading: false,
            downloadProgress: undefined,
            spoilerRevealed: false,
            inlineVideoUrl: '',
            inlineVideoPlaying: false,
            standalonePreview: undefined,
          }
        : model;
      const transition = automatic(next);
      return changed ? { ...transition, cancel: [commandDisplay, commandOriginal] } : transition;
    },
    update: (model, message) => {
      switch (message.type) {
        case 'Load':
          return startDisplay({ ...model, error: '' });
        case 'Cancel':
          return {
            model: { ...model, loading: false, downloadProgress: undefined },
            cancel: [commandDisplay, commandOriginal],
          };
        case 'StopHover':
          return { model: { ...model, inlineVideoPlaying: false } };
        case 'PreviewOpened':
          return {
            model: message.standalone ? { ...model, standalonePreview: message.standalone } : model,
          };
        case 'Original': {
          const kind = mediaPresentation(model.props.media).preview;
          if (
            (message.purpose === 'download' && model.props.protected) ||
            (message.purpose === 'preview' &&
              (!kind ||
                model.props.decorative ||
                (model.props.media.spoiler && !model.spoilerRevealed)))
          )
            return { model };
          if (message.purpose === 'hover' && model.inlineVideoUrl)
            return { model: { ...model, inlineVideoPlaying: true } };
          return {
            model: {
              ...model,
              loading: true,
              error: '',
              downloadProgress: 0,
              inlineVideoPlaying: message.purpose === 'hover' || model.inlineVideoPlaying,
            },
            commands: [
              {
                policy: 'replace',
                key: commandOriginal,
                stream: transfer(model.props, false, message.purpose, message.origin),
              },
            ],
          };
        }
        case 'OriginalLoaded': {
          const next = { ...model, loading: false, downloadProgress: undefined };
          if (message.purpose === 'hover')
            return { model: { ...next, inlineVideoUrl: message.url } };
          const props = model.props;
          if (message.purpose === 'download')
            return {
              model: next,
              commands: [
                {
                  key: commandDownload,
                  policy: 'replace',
                  effect: Effect.sync(() => {
                    if (!props.protected) saveMediaUrl(message.url, props.media.name);
                  }),
                },
              ],
            };
          const kind = mediaPresentation(props.media).preview;
          if (!kind) return { model: next };
          const preview: MediaPreview = {
            kind,
            name: props.media.name,
            url: message.url,
            origin: message.origin,
          };
          return {
            model: next,
            commands: [
              {
                policy: 'replace',
                key: commandOpen,
                effect: Effect.sync((): MediaAttachmentMessage => ({
                  type: 'PreviewOpened',
                  standalone:
                    props.onOpenPreview && props.onOpenPreview(preview) !== false
                      ? undefined
                      : preview,
                })),
              },
            ],
          };
        }
        case 'Url':
          return {
            model: {
              ...model,
              url: message.value,
              previousImageUrl: '',
              loading: false,
              downloadProgress: undefined,
            },
          };
        case 'Loading':
          return { model: { ...model, loading: message.value } };
        case 'Error':
          return {
            model: {
              ...model,
              error: message.value,
              previousImageUrl: '',
              loading: false,
              downloadProgress: undefined,
            },
          };
        case 'StandalonePreview':
          return { model: { ...model, standalonePreview: message.value } };
        case 'InlineVideoUrl':
          return { model: { ...model, inlineVideoUrl: message.value } };
        case 'InlineVideoPlaying':
          return { model: { ...model, inlineVideoPlaying: message.value } };
        case 'NearViewport':
          return automatic({ ...model, nearViewport: message.value });
        case 'SpoilerRevealed':
          return { model: { ...model, spoilerRevealed: message.value } };
        case 'DownloadProgress':
          return { model: { ...model, downloadProgress: message.value } };
      }
    },
  },
  view((model, send) => {
    const props = model.props;
    const presentation = mediaPresentation(props.media);
    const isImage =
      presentation.display === 'image' ||
      Boolean(props.compact && presentation.preview === 'image');
    const isVideo = presentation.display === 'video';
    const isRoundVideo = presentation.display === 'round-video';
    const isVoice = presentation.display === 'voice';
    const isTgs = presentation.display === 'tgs';
    const isInlinePlayer = isRoundVideo || isVoice;
    const displayUrl = model.url || (isImage ? model.previousImageUrl : '');
    const previewKind = presentation.preview;
    const fileStatus =
      model.loading && model.downloadProgress !== undefined
        ? `${Math.round(model.downloadProgress * 100)}% downloaded`
        : model.error || describeMedia(props.media);
    const previewEnabled =
      Boolean((model.url || isVideo) && previewKind && !props.decorative) &&
      (!props.media.spoiler || model.spoilerRevealed);
    const openPreview = (origin?: HTMLElement) =>
      send({ type: 'Original', purpose: 'preview', origin: origin?.getBoundingClientRect() });
    const load = () => send({ type: 'Load' });
    const download = () => send({ type: 'Original', purpose: 'download' });
    const startVideoPreview = () => send({ type: 'Original', purpose: 'hover' });
    const stopVideoPreview = () => send({ type: 'StopHover' });
    const loadFallback = (kind: string) => (
      <>
        <span
          class="media-placeholder"
          hidden={model.nearViewport || Boolean(model.error) || Boolean(displayUrl)}
          aria-hidden="true"
        />
        <span
          class="media-loading"
          hidden={!model.nearViewport || Boolean(model.error) || Boolean(displayUrl)}
          aria-live="polite"
          aria-label={`Loading ${kind}`}
        >
          <LoaderCircle class="animate-spin" size={20} />
        </span>
        {!props.decorative ? (
          <button
            class="media-load-error"
            hidden={!model.error || Boolean(props.decorative) || Boolean(model.url)}
            onClick={(event) => {
              event.stopPropagation();
              load();
            }}
            aria-label={`Retry loading ${props.media.name}`}
          >
            <span>{model.error}</span>
            <strong>Retry</strong>
          </button>
        ) : null}
        <span
          class="media-load-error"
          hidden={!model.error || !props.decorative || Boolean(model.url)}
        >
          Unavailable
        </span>
      </>
    );
    return (
      <div
        use={visibilityMount(send)}
        classList={{ 'media-file-preview': props.media.kind === 'file' && Boolean(previewKind) }}
        class={`media-attachment media-${props.media.kind}${props.compact ? ' media-compact' : ''}${displayUrl ? ' media-loaded' : ''}`}
      >
        {isImage ? (
          <div
            use={
              props.media.kind === 'photo' && props.media.width && props.media.height
                ? domBinding({ width: props.media.width, height: props.media.height }, fitChatPhoto)
                : undefined
            }
            class="media-visual"
            classList={{ 'media-previewable': previewEnabled }}
            role={previewEnabled ? 'button' : undefined}
            tabIndex={previewEnabled ? 0 : undefined}
            aria-label={previewEnabled ? `Open ${props.media.name} fullscreen preview` : undefined}
            onClick={(event) => openPreview(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openPreview(event.currentTarget);
              }
            }}
            style={{
              '--photo-backdrop': displayUrl
                ? 'url(' + JSON.stringify(displayUrl) + ')'
                : undefined,
              'aspect-ratio':
                props.media.width && props.media.height
                  ? `${props.media.width} / ${props.media.height}`
                  : undefined,
            }}
          >
            <img
              draggable={false}
              src={displayUrl || undefined}
              alt={props.decorative ? '' : props.media.name}
              loading="lazy"
              hidden={!displayUrl}
            />
            {loadFallback('image')}
          </div>
        ) : null}
        {isVideo ? (
          <div
            class="media-visual"
            classList={{ 'media-previewable': previewEnabled }}
            role={previewEnabled ? 'button' : undefined}
            tabIndex={previewEnabled ? 0 : undefined}
            aria-label={previewEnabled ? `Open ${props.media.name} fullscreen preview` : undefined}
            onPointerEnter={() => startVideoPreview()}
            onPointerLeave={stopVideoPreview}
            onFocus={() => startVideoPreview()}
            onBlur={stopVideoPreview}
            onClick={(event) => openPreview(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openPreview(event.currentTarget);
              }
            }}
            style={{
              'aspect-ratio':
                props.media.width && props.media.height
                  ? `${props.media.width} / ${props.media.height}`
                  : undefined,
            }}
          >
            {props.loadPreview ? (
              <>
                <img
                  draggable={false}
                  src={model.url || undefined}
                  alt={props.media.name}
                  loading="lazy"
                  hidden={!model.url || Boolean(model.inlineVideoUrl)}
                />
                <video
                  use={playbackMount(model.inlineVideoPlaying, model.inlineVideoUrl)}
                  src={model.inlineVideoUrl || undefined}
                  muted
                  loop
                  playsinline
                  preload="metadata"
                  aria-label={`${props.media.name}. Hover to play.`}
                  hidden={!model.inlineVideoUrl}
                />
              </>
            ) : (
              <video
                use={playbackMount(model.inlineVideoPlaying, model.url)}
                src={model.url || undefined}
                muted
                loop
                playsinline
                preload="metadata"
                aria-label={`${props.media.name}. Hover to play.`}
                tabIndex={model.url ? 0 : -1}
                hidden={!model.url}
              />
            )}
            {props.media.kind === 'video' && !model.inlineVideoPlaying ? (
              <>
                <span class="media-video-play" aria-hidden="true">
                  <span />
                </span>
                <span class="media-video-metadata">
                  {formatMediaSize(props.media.size)
                    ? ((size) => <span>{size}</span>)(formatMediaSize(props.media.size)!)
                    : null}
                  {formatMediaDuration(props.media.duration)
                    ? ((duration) => <span>{duration}</span>)(
                        formatMediaDuration(props.media.duration)!,
                      )
                    : null}
                </span>
              </>
            ) : null}
            {loadFallback('video')}
          </div>
        ) : null}
        {isRoundVideo ? (
          <div class="media-visual media-round-video-visual">
            {model.url ? (
              <RoundVideoPlayer
                mediaUnread={props.mediaUnread}
                source={model.url}
                duration={props.media.duration}
                onPlaybackStarted={props.onPlaybackStarted}
              />
            ) : null}
            {loadFallback('video message')}
          </div>
        ) : null}
        {isVoice ? (
          <VoicePlayer
            control={props.voiceControl}
            mediaUnread={props.mediaUnread}
            source={model.url}
            duration={props.media.duration}
            waveform={props.media.waveform}
            loading={model.loading}
            error={model.error}
            load={load}
            onPlaybackStarted={props.onPlaybackStarted}
          />
        ) : null}
        {isTgs ? (
          <div class="media-visual">
            {model.url ? <TgsPlayer source={model.url} label={props.media.name} /> : null}
            {loadFallback('sticker')}
          </div>
        ) : null}
        {!isImage && !isVideo && !isInlinePlayer && !isTgs ? (
          <>
            {previewKind ? (
              <>
                <button
                  class="media-file-thumbnail media-file-image-thumbnail"
                  onClick={(event) => openPreview(event.currentTarget)}
                  aria-label={`Preview ${props.media.name}`}
                >
                  {model.url ? (
                    <img draggable={false} src={model.url} alt="" />
                  ) : model.loading ? (
                    <LoaderCircle class="animate-spin" size={20} />
                  ) : previewKind === 'video' ? (
                    <Play size={20} />
                  ) : (
                    <FileText size={20} />
                  )}
                </button>
                <button
                  class="media-file-copy"
                  onClick={(event) => openPreview(event.currentTarget)}
                  aria-label={`Open ${props.media.name} fullscreen preview`}
                >
                  <strong>{props.media.name}</strong>
                  <small>{fileStatus}</small>
                </button>
              </>
            ) : (
              <div class="media-file-details" aria-busy={model.loading}>
                <span class="media-file-thumbnail" aria-hidden="true">
                  {model.loading ? (
                    <LoaderCircle class="animate-spin" size={20} />
                  ) : (
                    <FileText size={20} />
                  )}
                </span>
                <span>
                  <strong>{props.media.name}</strong>
                  <small>{fileStatus}</small>
                </span>
              </div>
            )}
            {!model.loading && !props.protected ? (
              <button
                class="media-file-download"
                onClick={(event) => {
                  event.stopPropagation();
                  download();
                }}
                disabled={model.loading}
                aria-label={`Download ${props.media.name}`}
              >
                <Download size={15} />
                {previewKind ? <span>Download</span> : null}
              </button>
            ) : null}
            {model.loading ? (
              <button
                class="media-file-download"
                onClick={(event) => {
                  event.stopPropagation();
                  send({ type: 'Cancel' });
                }}
                aria-label={`Cancel download ${props.media.name}`}
              >
                <X size={17} />
              </button>
            ) : null}
          </>
        ) : null}
        {props.media.spoiler && !model.spoilerRevealed && !props.decorative ? (
          <button
            class="media-spoiler"
            onClick={(event) => {
              event.stopPropagation();
              send({ type: 'SpoilerRevealed', value: true });
            }}
            aria-label={`Reveal media spoiler ${props.media.name}`}
          >
            Reveal spoiler
          </button>
        ) : null}
        {props.uploadProgress !== undefined ? (
          <div
            class="media-upload-status"
            classList={{
              'media-upload-details': (!isImage && !isVideo) || props.media.kind === 'sticker',
            }}
            role="status"
            aria-label={`${props.media.name}: ${props.uploadFailed ? 'Upload failed' : props.uploadProgress >= 1 ? 'Sending' : 'Uploading'}`}
          >
            {(!isImage && !isVideo) || props.media.kind === 'sticker' ? (
              <small>{props.media.name}</small>
            ) : null}
            <span>
              {props.uploadFailed
                ? 'Upload failed'
                : props.uploadProgress >= 1
                  ? 'Sending…'
                  : `${Math.round((props.uploadProgress ?? 0) * 100)}%`}
            </span>
            {!props.uploadFailed ? (
              <progress
                max={1}
                value={props.uploadProgress}
                aria-label={`Upload progress for ${props.media.name}`}
              />
            ) : null}
          </div>
        ) : null}
        {model.standalonePreview
          ? ((preview) => (
              <MediaViewer
                kind={preview.kind}
                name={preview.name}
                url={preview.url}
                protected={props.protected}
                close={() => send({ type: 'StandalonePreview', value: undefined })}
              />
            ))(model.standalonePreview!)
          : null}
      </div>
    );
  }),
);
