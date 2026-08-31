import Download from 'lucide-solid/icons/download';
import FileText from 'lucide-solid/icons/file-text';
import LoaderCircle from 'lucide-solid/icons/loader-circle';
import X from 'lucide-solid/icons/x';
import { Show, createEffect, createSignal, onCleanup, onMount, untrack } from 'solid-js';

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
  const [url, setUrl] = createSignal(props.cachedPreviewUrl?.() ?? props.cachedUrl?.() ?? '');
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [previewOpen, setPreviewOpen] = createSignal(false);
  const [nearViewport, setNearViewport] = createSignal(false);
  const [spoilerRevealed, setSpoilerRevealed] = createSignal(false);
  const [downloadProgress, setDownloadProgress] = createSignal<number>();
  let root: HTMLDivElement | undefined;
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

  const presentation = () => mediaPresentation(props.media);
  const isImage = () => presentation().display === 'image';
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
    setPreviewOpen(true);
  };

  const load = async () => {
    const existing = untrack(url);
    if (existing) return existing;
    if (untrack(loading)) return undefined;
    const currentGeneration = generation;
    const loader = props.loadPreview ?? props.load;
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
    if (!props.loadPreview) return url() || (await load());
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

  createEffect(() => {
    const identity = `${props.revision ?? ''}:${props.media.cacheKey ?? ''}:${props.media.kind}:${props.media.name}:${props.media.mimeType}`;
    const cached = untrack(() => props.cachedPreviewUrl?.() ?? props.cachedUrl?.() ?? '');
    const shouldLoad = presentation().preload;
    void identity;
    generation += 1;
    setUrl(cached);
    setError('');
    setLoading(false);
    setDownloadProgress(undefined);
    setSpoilerRevealed(false);
    if (shouldLoad && nearViewport() && !cached) untrack(() => void load());
  });
  const pause = (video: HTMLVideoElement) => {
    video.pause();
    video.currentTime = 0;
  };
  const play = (video: HTMLVideoElement) => {
    void video.play().catch(() => undefined);
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
            <img src={url() || undefined} alt={props.media.name} loading="lazy" hidden={!url()} />
          </Show>
          <Show when={props.media.kind === 'video'}>
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
        <button
          class="media-file"
          classList={{ 'media-file-previewable': Boolean(previewKind()) }}
          onClick={(event) =>
            previewKind() ? void openPreview(event.currentTarget) : void download()
          }
          disabled={loading() && !previewKind()}
          aria-busy={loading()}
          aria-label={
            previewKind()
              ? `Open ${props.media.name} fullscreen preview`
              : `Download ${props.media.name}`
          }
        >
          <Show when={loading()} fallback={<FileText size={20} />}>
            <LoaderCircle class="animate-spin" size={20} />
          </Show>
          <span>
            <strong>{props.media.name}</strong>
            <small>
              {loading() && downloadProgress() !== undefined
                ? `${Math.round(downloadProgress()! * 100)}% downloaded`
                : error() || describeMedia(props.media)}
            </small>
          </span>
          <Show when={!previewKind() && !props.protected}>
            <Download size={17} />
          </Show>
        </button>
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
            <Download size={17} />
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
      <Show when={previewOpen() && url() && previewKind()}>
        <MediaViewer
          kind={previewKind()!}
          name={props.media.name}
          url={url()}
          protected={props.protected}
          close={() => setPreviewOpen(false)}
        />
      </Show>
    </div>
  );
}
