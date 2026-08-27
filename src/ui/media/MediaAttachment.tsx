import Download from 'lucide-solid/icons/download';
import FileText from 'lucide-solid/icons/file-text';
import LoaderCircle from 'lucide-solid/icons/loader-circle';
import { Show, createEffect, createSignal, onCleanup, onMount, untrack } from 'solid-js';

import type { ChatMessage } from '../../domain/models';
import { TgsPlayer } from './TgsPlayer';
import { MediaViewer } from './MediaViewer';

interface MediaAttachmentProps {
  media: NonNullable<ChatMessage['media']>;
  load: () => Promise<string>;
  cachedUrl?: (() => string | undefined) | undefined;
  compact?: boolean | undefined;
  decorative?: boolean | undefined;
  revision?: string | number | undefined;
  onOpenPreview?: ((preview: MediaPreview) => void) | undefined;
}

export interface MediaPreview {
  kind: 'image' | 'video';
  name: string;
  url: string;
}

export function MediaAttachment(props: MediaAttachmentProps) {
  const [url, setUrl] = createSignal(props.cachedUrl?.() ?? '');
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [previewOpen, setPreviewOpen] = createSignal(false);
  const [nearViewport, setNearViewport] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let generation = 0;

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
    props.media.kind === 'photo' ||
    (props.media.kind === 'sticker' &&
      props.media.mimeType !== 'application/x-tgsticker' &&
      !props.media.mimeType.startsWith('video/'));
  const isVideo = () =>
    props.media.kind === 'video' ||
    (props.media.kind === 'animation' && props.media.mimeType.startsWith('video/')) ||
    (props.media.kind === 'sticker' && props.media.mimeType.startsWith('video/'));
  const isRoundVideo = () => props.media.kind === 'round-video';
  const isVoice = () => props.media.kind === 'voice';
  const isTgs = () =>
    props.media.kind === 'sticker' && props.media.mimeType === 'application/x-tgsticker';
  const isInlinePlayer = () => isRoundVideo() || isVoice();
  const previewKind = () =>
    props.media.kind === 'photo'
      ? ('image' as const)
      : props.media.kind === 'video' || props.media.kind === 'animation'
        ? ('video' as const)
        : undefined;
  const openPreview = () => {
    const kind = previewKind();
    if (!url() || !kind || props.decorative) return;
    if (props.onOpenPreview) {
      props.onOpenPreview({ kind, name: props.media.name, url: url() });
      return;
    }
    setPreviewOpen(true);
  };

  const load = async () => {
    if (untrack(url) || untrack(loading)) return;
    const currentGeneration = generation;
    const loader = props.load;
    setLoading(true);
    setError('');
    try {
      const loaded = await loader();
      if (generation === currentGeneration) setUrl(loaded);
    } catch (cause) {
      if (generation === currentGeneration) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (generation === currentGeneration) setLoading(false);
    }
  };

  createEffect(() => {
    const identity = `${props.revision ?? ''}:${props.media.cacheKey ?? ''}:${props.media.kind}:${props.media.name}:${props.media.mimeType}`;
    const cached = untrack(() => props.cachedUrl?.() ?? '');
    const shouldLoad = isImage() || isVideo() || isRoundVideo() || isVoice() || isTgs();
    void identity;
    generation += 1;
    setUrl(cached);
    setError('');
    setLoading(false);
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
          classList={{ 'media-previewable': Boolean(url() && previewKind() && !props.decorative) }}
          role={url() && previewKind() && !props.decorative ? 'button' : undefined}
          tabIndex={url() && previewKind() && !props.decorative ? 0 : undefined}
          aria-label={
            url() && previewKind() && !props.decorative
              ? `Open ${props.media.name} fullscreen preview`
              : undefined
          }
          onClick={openPreview}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openPreview();
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
          classList={{ 'media-previewable': Boolean(url() && previewKind() && !props.decorative) }}
          role={url() && previewKind() && !props.decorative ? 'button' : undefined}
          tabIndex={url() && previewKind() && !props.decorative ? 0 : undefined}
          aria-label={
            url() && previewKind() && !props.decorative
              ? `Open ${props.media.name} fullscreen preview`
              : undefined
          }
          onClick={openPreview}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openPreview();
            }
          }}
          style={{
            'aspect-ratio':
              props.media.width && props.media.height
                ? `${props.media.width} / ${props.media.height}`
                : undefined,
          }}
        >
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
      <Show when={!url() && !isImage() && !isVideo() && !isInlinePlayer() && !isTgs()}>
        <button class="media-file" onClick={() => void load()} disabled={loading()}>
          <Show when={loading()} fallback={<FileText size={20} />}>
            <LoaderCircle class="animate-spin" size={20} />
          </Show>
          <span>
            <strong>{props.media.name}</strong>
            <small>{error() || props.media.mimeType}</small>
          </span>
          <Download size={17} />
        </button>
      </Show>
      <Show when={url() && !isImage() && !isVideo() && !isInlinePlayer() && !isTgs()}>
        <a class="media-file" href={url()} download={props.media.name}>
          <FileText size={20} />
          <span>
            <strong>{props.media.name}</strong>
            <small>{props.media.mimeType}</small>
          </span>
          <Download size={17} />
        </a>
      </Show>
      <Show when={previewOpen() && url() && previewKind()}>
        <MediaViewer
          kind={previewKind()!}
          name={props.media.name}
          url={url()}
          close={() => setPreviewOpen(false)}
        />
      </Show>
    </div>
  );
}
