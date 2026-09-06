import { Cause, Effect, Queue, Stream } from 'effect';
import { actionCommand } from 'effectweb/program';
import type { ChatMessage } from '../../domain/models';
import type { TelegramTransferProgress } from '../../telegram/types';
import Download from '@effectweb/lucide/icons/download';
import FileText from '@effectweb/lucide/icons/file-text';
import LoaderCircle from '@effectweb/lucide/icons/loader-circle';
import X from '@effectweb/lucide/icons/x';
import { component, domBinding, domMount, view } from 'effectweb';
import type { Send, Transition } from 'effectweb/program';
import { loadEffect } from 'effectweb/cache';
import { MediaViewer } from './MediaViewer';
import { TgsPlayer } from './TgsPlayer';
import { saveMediaUrl } from './mediaActions';
import {
  describeMedia,
  formatMediaDuration,
  formatMediaSize,
  mediaPresentation,
} from './mediaPresentation';
interface MediaAttachmentProps {
  media: NonNullable<ChatMessage['media']>;
  load: (progress?: TelegramTransferProgress) => Effect.Effect<string, unknown>;
  loadPreview?: (() => Effect.Effect<string, unknown>) | undefined;
  cachedUrl?: (() => string | undefined) | undefined;
  cachedPreviewUrl?: (() => string | undefined) | undefined;
  compact?: boolean | undefined;
  decorative?: boolean | undefined;
  revision?: string | number | undefined;
  onOpenPreview?: ((preview: MediaPreview) => boolean | void) | undefined;
  protected?: boolean | undefined;
}
export interface MediaPreview {
  kind: 'image' | 'video';
  name: string;
  url: string;
  origin?: DOMRect | undefined;
}
type MediaAttachmentModel = {
  identity: string;
  props: MediaAttachmentProps;
  url: string;
  loading: boolean;
  error: string;
  standalonePreview: MediaPreview | undefined;
  inlineVideoUrl: string;
  inlineVideoPlaying: boolean;
  nearViewport: boolean;
  spoilerRevealed: boolean;
  downloadProgress: number | undefined;
};
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
      const result = yield* loadEffect(() => {
        const cached = lightweight ? props.cachedPreviewUrl?.() : props.cachedUrl?.();
        return cached
          ? Effect.succeed(cached)
          : lightweight
            ? props.loadPreview!()
            : props.load(progress);
      }).pipe(
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
    commands: [{ slot: 'display', stream: transfer(model.props, true) }],
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
const visibilityMount = (send: Send<MediaAttachmentMessage>) => domBinding(send, observeVisibility);
function pause(video: HTMLVideoElement) {
  video.pause();
  video.currentTime = 0;
}
function play(video: HTMLVideoElement) {
  void video.play().catch(() => undefined);
}
function playbackMount(playing: boolean) {
  return domMount<HTMLVideoElement>((video) => {
    if (playing) play(video);
    else pause(video);
    return () => pause(video);
  });
}
export const MediaAttachment = component<
  MediaAttachmentProps,
  MediaAttachmentModel,
  MediaAttachmentMessage
>({
  init: (props) => ({
    props,
    identity: identity(props),
    url: '',
    loading: false,
    error: '',
    standalonePreview: undefined,
    inlineVideoUrl: '',
    inlineVideoPlaying: false,
    nearViewport: false,
    spoilerRevealed: false,
    downloadProgress: undefined,
  }),
  receive: (model, props) => {
    const key = identity(props);
    const changed = key !== model.identity;
    const next = changed
      ? {
          ...model,
          props,
          identity: key,
          url: '',
          error: '',
          loading: false,
          downloadProgress: undefined,
          spoilerRevealed: false,
          inlineVideoUrl: '',
          inlineVideoPlaying: false,
          standalonePreview: undefined,
        }
      : { ...model, props };
    const transition = automatic(next);
    return changed ? { ...transition, cancel: ['display', 'original'] } : transition;
  },
  update: (model, message) => {
    switch (message.type) {
      case 'Load':
        return startDisplay({ ...model, error: '' });
      case 'Cancel':
        return {
          model: { ...model, loading: false, downloadProgress: undefined },
          cancel: ['display', 'original'],
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
              slot: 'original',
              stream: transfer(model.props, false, message.purpose, message.origin),
            },
          ],
        };
      }
      case 'OriginalLoaded': {
        const next = { ...model, loading: false, downloadProgress: undefined };
        if (message.purpose === 'hover') return { model: { ...next, inlineVideoUrl: message.url } };
        const props = model.props;
        if (message.purpose === 'download')
          return {
            model: next,
            commands: [
              actionCommand('download', () =>
                Effect.sync(() => {
                  if (!props.protected) saveMediaUrl(message.url, props.media.name);
                }),
              ),
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
              slot: 'open',
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
          model: { ...model, url: message.value, loading: false, downloadProgress: undefined },
        };
      case 'Loading':
        return { model: { ...model, loading: message.value } };
      case 'Error':
        return {
          model: { ...model, error: message.value, loading: false, downloadProgress: undefined },
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
  view: view((model, send) => {
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
    const previewKind = presentation.preview;
    const previewEnabled =
      Boolean(model.url && previewKind && !props.decorative) &&
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
          hidden={model.nearViewport || Boolean(model.error) || Boolean(model.url)}
          aria-hidden="true"
        />
        <span
          class="media-loading"
          hidden={!model.nearViewport || Boolean(model.error) || Boolean(model.url)}
          aria-live="polite"
          aria-label={`Loading ${kind}`}
        >
          <LoaderCircle class="animate-spin" size={20} />
        </span>
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
        class={`media-attachment media-${props.media.kind}${props.compact ? ' media-compact' : ''}${model.url ? ' media-loaded' : ''}`}
      >
        {isImage ? (
          <div
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
              'aspect-ratio':
                props.media.width && props.media.height
                  ? `${props.media.width} / ${props.media.height}`
                  : undefined,
            }}
          >
            <img
              src={model.url || undefined}
              alt={props.decorative ? '' : props.media.name}
              loading="lazy"
              hidden={!model.url}
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
                  src={model.url || undefined}
                  alt={props.media.name}
                  loading="lazy"
                  hidden={!model.url || Boolean(model.inlineVideoUrl)}
                />
                <video
                  use={playbackMount(model.inlineVideoPlaying)}
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
                src={model.url || undefined}
                muted
                loop
                playsinline
                preload="metadata"
                aria-label={`${props.media.name}. Hover to play.`}
                tabIndex={model.url ? 0 : -1}
                hidden={!model.url}
                onPointerEnter={(event) => play(event.currentTarget)}
                onPointerLeave={(event) => pause(event.currentTarget)}
                onFocus={(event) => play(event.currentTarget)}
                onBlur={(event) => pause(event.currentTarget)}
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
          <div
            class="media-visual media-round-video-visual"
            style={{
              'aspect-ratio':
                props.media.width && props.media.height
                  ? `${props.media.width} / ${props.media.height}`
                  : undefined,
            }}
          >
            <video
              src={model.url || undefined}
              controls
              playsinline
              preload="metadata"
              aria-label={`Video message ${props.media.name}`}
              hidden={!model.url}
              onClick={(event) => event.stopPropagation()}
            />
            {loadFallback('video message')}
          </div>
        ) : null}
        {isVoice ? (
          <div class="media-audio">
            <audio
              src={model.url || undefined}
              controls
              preload="metadata"
              aria-label={`Voice message ${props.media.name}`}
              hidden={!model.url}
              onClick={(event) => event.stopPropagation()}
            />
            {loadFallback('voice message')}
          </div>
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
                <span class="media-file-thumbnail media-file-image-thumbnail" aria-hidden="true">
                  {model.url ? (
                    <img src={model.url} alt="" />
                  ) : model.loading ? (
                    <LoaderCircle class="animate-spin" size={20} />
                  ) : (
                    <FileText size={20} />
                  )}
                </span>
                <button
                  class="media-file-copy"
                  onClick={(event) => openPreview(event.currentTarget)}
                  aria-label={`Open ${props.media.name} fullscreen preview`}
                >
                  <strong>{props.media.name}</strong>
                  <small>
                    {model.loading && model.downloadProgress !== undefined
                      ? `${Math.round(model.downloadProgress! * 100)}% downloaded`
                      : model.error || describeMedia(props.media)}
                  </small>
                </button>
              </>
            ) : (
              <button
                class="media-file"
                onClick={() => download()}
                disabled={model.loading}
                aria-busy={model.loading}
                aria-label={`Download ${props.media.name}`}
              >
                <span class="media-file-thumbnail" aria-hidden="true">
                  {model.loading ? (
                    <LoaderCircle class="animate-spin" size={20} />
                  ) : (
                    <FileText size={20} />
                  )}
                </span>
                <span>
                  <strong>{props.media.name}</strong>
                  <small>{model.error || describeMedia(props.media)}</small>
                </span>
                {!props.protected ? <Download size={17} /> : null}
              </button>
            )}
            {!model.loading && previewKind && !props.protected ? (
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
                <span>Download</span>
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
});
