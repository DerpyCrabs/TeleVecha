import Download from 'lucide-solid/icons/download';
import FileText from 'lucide-solid/icons/file-text';
import LoaderCircle from 'lucide-solid/icons/loader-circle';
import X from 'lucide-solid/icons/x';
import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';

import type { ChatMessage } from '../../domain/models';
import type { TelegramTransferProgress } from '../../telegram/types';
import { TgsPlayer } from './TgsPlayer';
import { MediaViewer } from './MediaViewer';
import {
  describeMedia,
  formatMediaDuration,
  formatMediaSize,
  mediaPresentation,
} from './mediaPresentation';

interface MediaAttachmentProps {
  media: NonNullable<ChatMessage['media']>;
  load: (progress?: TelegramTransferProgress) => Promise<string>;
  loadPreview?: (() => Promise<string>) | undefined;
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

export function MediaAttachment(props: MediaAttachmentProps) {
  const presentation = () => mediaPresentation(props.media);
  const usesLightweightPreview = () =>
    Boolean(props.loadPreview) && presentation().display !== 'image';
  const cachedDisplayUrl = () =>
    (usesLightweightPreview() ? props.cachedPreviewUrl?.() : props.cachedUrl?.()) ?? '';
  const [url, setUrl] = createSignal(cachedDisplayUrl());
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [standalonePreview, setStandalonePreview] = createSignal<MediaPreview>();
  const [inlineVideoUrl, setInlineVideoUrl] = createSignal('');
  const [inlineVideoPlaying, setInlineVideoPlaying] = createSignal(false);
  const [nearViewport, setNearViewport] = createSignal(false);
  const [spoilerRevealed, setSpoilerRevealed] = createSignal(false);
  const [downloadProgress, setDownloadProgress] = createSignal<number>();
  let root: HTMLDivElement | undefined;
  let inlineVideo: HTMLVideoElement | undefined;
  let generation = 0;
  let activeProgress: TelegramTransferProgress | undefined;

  onMount(() => {
    if (!root || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const scrollRoot = root.closest<HTMLElement>('[data-testid="message-scroller"], .shared-items');
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some(({ isIntersecting }) => isIntersecting)) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { root: scrollRoot ?? null, rootMargin: '600px 0px' },
    );
    observer.observe(root);
    onCleanup(() => observer.disconnect());
  });

  const isImage = () =>
    presentation().display === 'image' ||
    Boolean(props.compact && presentation().preview === 'image');
  const isVideo = () => presentation().display === 'video';
  const isRoundVideo = () => presentation().display === 'round-video';
  const isVoice = () => presentation().display === 'voice';
  const isTgs = () => presentation().display === 'tgs';
  const isInlinePlayer = () => isRoundVideo() || isVoice();
  const previewKind = () => presentation().preview;
  const previewEnabled = () =>
    Boolean(url() && previewKind() && !props.decorative) &&
    (!props.media.spoiler || spoilerRevealed());
  const openPreview = async (origin?: HTMLElement) => {
    const kind = previewKind();
    if (!kind || props.decorative || (props.media.spoiler && !spoilerRevealed())) return;
    const loaded = await loadOriginal();
    if (!loaded) return;
    const preview = {
      kind,
      name: props.media.name,
      url: loaded,
      ...(origin ? { origin: origin.getBoundingClientRect() } : {}),
    };
    if (props.onOpenPreview) {
      if (props.onOpenPreview(preview) !== false) return;
    }
    setStandalonePreview(preview);
  };

  const load = async () => {
    const existing = untrack(url);
    if (existing) return existing;
    if (untrack(loading)) return undefined;
    const currentGeneration = generation;
    const loader = usesLightweightPreview() ? props.loadPreview! : props.load;
    const progress = Object.assign(
      (value: number) => {
        if (generation === currentGeneration) setDownloadProgress(value);
      },
      { isCanceled: false },
    );
    activeProgress = progress;
    setLoading(true);
    setDownloadProgress(0);
    setError('');
    try {
      const loaded = await loader(progress);
      if (generation === currentGeneration) setUrl(loaded);
      return loaded;
    } catch (cause) {
      if (generation === currentGeneration && !progress.isCanceled) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (activeProgress === progress) activeProgress = undefined;
      if (generation === currentGeneration) {
        setLoading(false);
        setDownloadProgress(undefined);
      }
    }
    return undefined;
  };

  const loadOriginal = async () => {
    if (!usesLightweightPreview()) return url() || (await load());
    const progress = Object.assign((value: number) => setDownloadProgress(value), {
      isCanceled: false,
    });
    setDownloadProgress(0);
    try {
      return await props.load(progress);
    } finally {
      setDownloadProgress(undefined);
    }
  };

  const download = async () => {
    if (props.protected) return;
    const loaded = await loadOriginal();
    if (!loaded) return;
    const anchor = document.createElement('a');
    anchor.href = loaded;
    anchor.download = props.media.name;
    anchor.click();
  };

  const automaticLoadState = createMemo(
    () =>
      `${props.revision ?? ''}:${props.media.cacheKey ?? ''}:${props.media.kind}:${props.media.name}:${props.media.mimeType}:${presentation().preload}:${nearViewport()}`,
  );
  createEffect(
    on(automaticLoadState, () => {
      const cached = untrack(cachedDisplayUrl);
      const shouldLoad = untrack(() => presentation().preload && nearViewport());
      generation += 1;
      setUrl(cached);
      setError('');
      setLoading(false);
      setDownloadProgress(undefined);
      setSpoilerRevealed(false);
      if (shouldLoad && !cached) untrack(() => void load());
    }),
  );
  const pause = (video: HTMLVideoElement) => {
    video.pause();
    video.currentTime = 0;
  };
  const play = (video: HTMLVideoElement) => {
    void video.play().catch(() => undefined);
  };
  const startVideoPreview = async () => {
    const loaded = inlineVideoUrl() || (await loadOriginal());
    if (!loaded) return;
    setInlineVideoUrl(loaded);
    setInlineVideoPlaying(true);
    queueMicrotask(() => {
      if (inlineVideo) play(inlineVideo);
    });
  };
  const stopVideoPreview = () => {
    setInlineVideoPlaying(false);
    if (inlineVideo) pause(inlineVideo);
  };
  const loadFallback = (kind: string) => (
    <>
      <span
        class="media-placeholder"
        hidden={nearViewport() || Boolean(error()) || Boolean(url())}
        aria-hidden="true"
      />
      <span
        class="media-loading"
        hidden={!nearViewport() || Boolean(error()) || Boolean(url())}
        aria-live="polite"
        aria-label={`Loading ${kind}`}
      >
        <LoaderCircle class="animate-spin" size={20} />
      </span>
      <button
        class="media-load-error"
        hidden={!error() || Boolean(props.decorative) || Boolean(url())}
        onClick={(event) => {
          event.stopPropagation();
          void load();
        }}
        aria-label={`Retry loading ${props.media.name}`}
      >
        <span>{error()}</span>
        <strong>Retry</strong>
      </button>
      <span class="media-load-error" hidden={!error() || !props.decorative || Boolean(url())}>
        Unavailable
      </span>
    </>
  );

  return (
    <div
      ref={(element) => (root = element)}
      class={`media-attachment media-${props.media.kind}${props.compact ? ' media-compact' : ''}${url() ? ' media-loaded' : ''}`}
    >
      <Show when={isImage()}>
        <div
          class="media-visual"
          classList={{ 'media-previewable': previewEnabled() }}
          role={previewEnabled() ? 'button' : undefined}
          tabIndex={previewEnabled() ? 0 : undefined}
          aria-label={previewEnabled() ? `Open ${props.media.name} fullscreen preview` : undefined}
          onClick={(event) => void openPreview(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              void openPreview(event.currentTarget);
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
            src={url() || undefined}
            alt={props.decorative ? '' : props.media.name}
            loading="lazy"
            hidden={!url()}
          />
          {loadFallback('image')}
        </div>
      </Show>
      <Show when={isVideo()}>
        <div
          class="media-visual"
          classList={{ 'media-previewable': previewEnabled() }}
          role={previewEnabled() ? 'button' : undefined}
          tabIndex={previewEnabled() ? 0 : undefined}
          aria-label={previewEnabled() ? `Open ${props.media.name} fullscreen preview` : undefined}
          onPointerEnter={() => void startVideoPreview()}
          onPointerLeave={stopVideoPreview}
          onFocus={() => void startVideoPreview()}
          onBlur={stopVideoPreview}
          onClick={(event) => void openPreview(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              void openPreview(event.currentTarget);
            }
          }}
          style={{
            'aspect-ratio':
              props.media.width && props.media.height
                ? `${props.media.width} / ${props.media.height}`
                : undefined,
          }}
        >
          <Show
            when={props.loadPreview}
            fallback={
              <video
                src={url() || undefined}
                muted
                loop
                playsinline
                preload="metadata"
                aria-label={`${props.media.name}. Hover to play.`}
                tabIndex={url() ? 0 : -1}
                hidden={!url()}
                onPointerEnter={(event) => play(event.currentTarget)}
                onPointerLeave={(event) => pause(event.currentTarget)}
                onFocus={(event) => play(event.currentTarget)}
                onBlur={(event) => pause(event.currentTarget)}
              />
            }
          >
            <img
              src={url() || undefined}
              alt={props.media.name}
              loading="lazy"
              hidden={!url() || Boolean(inlineVideoUrl())}
            />
            <video
              ref={(element) => (inlineVideo = element)}
              src={inlineVideoUrl() || undefined}
              muted
              loop
              playsinline
              preload="metadata"
              aria-label={`${props.media.name}. Hover to play.`}
              hidden={!inlineVideoUrl()}
            />
          </Show>
          <Show when={props.media.kind === 'video' && !inlineVideoPlaying()}>
            <span class="media-video-play" aria-hidden="true">
              <span />
            </span>
            <span class="media-video-metadata">
              <Show when={formatMediaSize(props.media.size)}>
                {(size) => <span>{size()}</span>}
              </Show>
              <Show when={formatMediaDuration(props.media.duration)}>
                {(duration) => <span>{duration()}</span>}
              </Show>
            </span>
          </Show>
          {loadFallback('video')}
        </div>
      </Show>
      <Show when={isRoundVideo()}>
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
            src={url() || undefined}
            controls
            playsinline
            preload="metadata"
            aria-label={`Video message ${props.media.name}`}
            hidden={!url()}
            onClick={(event) => event.stopPropagation()}
          />
          {loadFallback('video message')}
        </div>
      </Show>
      <Show when={isVoice()}>
        <div class="media-audio">
          <audio
            src={url() || undefined}
            controls
            preload="metadata"
            aria-label={`Voice message ${props.media.name}`}
            hidden={!url()}
            onClick={(event) => event.stopPropagation()}
          />
          {loadFallback('voice message')}
        </div>
      </Show>
      <Show when={isTgs()}>
        <div class="media-visual">
          <Show when={url()}>
            <TgsPlayer source={url()} label={props.media.name} />
          </Show>
          {loadFallback('sticker')}
        </div>
      </Show>
      <Show when={!isImage() && !isVideo() && !isInlinePlayer() && !isTgs()}>
        <Show
          when={previewKind()}
          fallback={
            <button
              class="media-file"
              onClick={() => void download()}
              disabled={loading()}
              aria-busy={loading()}
              aria-label={`Download ${props.media.name}`}
            >
              <span class="media-file-thumbnail" aria-hidden="true">
                <Show when={loading()} fallback={<FileText size={20} />}>
                  <LoaderCircle class="animate-spin" size={20} />
                </Show>
              </span>
              <span>
                <strong>{props.media.name}</strong>
                <small>{error() || describeMedia(props.media)}</small>
              </span>
              <Show when={!props.protected}>
                <Download size={17} />
              </Show>
            </button>
          }
        >
          <span class="media-file-thumbnail media-file-image-thumbnail" aria-hidden="true">
            <Show
              when={url()}
              fallback={
                <Show when={loading()} fallback={<FileText size={20} />}>
                  <LoaderCircle class="animate-spin" size={20} />
                </Show>
              }
            >
              <img src={url()} alt="" />
            </Show>
          </span>
          <button
            class="media-file-copy"
            onClick={(event) => void openPreview(event.currentTarget)}
            aria-label={`Open ${props.media.name} fullscreen preview`}
          >
            <strong>{props.media.name}</strong>
            <small>
              {loading() && downloadProgress() !== undefined
                ? `${Math.round(downloadProgress()! * 100)}% downloaded`
                : error() || describeMedia(props.media)}
            </small>
          </button>
        </Show>
        <Show when={!loading() && previewKind() && !props.protected}>
          <button
            class="media-file-download"
            onClick={(event) => {
              event.stopPropagation();
              void download();
            }}
            disabled={loading()}
            aria-label={`Download ${props.media.name}`}
          >
            <Download size={15} />
            <span>Download</span>
          </button>
        </Show>
        <Show when={loading()}>
          <button
            class="media-file-download"
            onClick={(event) => {
              event.stopPropagation();
              if (activeProgress) activeProgress.isCanceled = true;
            }}
            aria-label={`Cancel download ${props.media.name}`}
          >
            <X size={17} />
          </button>
        </Show>
      </Show>
      <Show when={props.media.spoiler && !spoilerRevealed() && !props.decorative}>
        <button
          class="media-spoiler"
          onClick={(event) => {
            event.stopPropagation();
            setSpoilerRevealed(true);
          }}
          aria-label={`Reveal media spoiler ${props.media.name}`}
        >
          Reveal spoiler
        </button>
      </Show>
      <Show when={standalonePreview()}>
        {(preview) => (
          <MediaViewer
            kind={preview().kind}
            name={preview().name}
            url={preview().url}
            protected={props.protected}
            close={() => setStandalonePreview(undefined)}
          />
        )}
      </Show>
    </div>
  );
}
