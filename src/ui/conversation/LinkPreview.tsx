import { createUiResource } from '../reactivity/solid';
import { Show } from 'solid-js';

import type { ChatMessage } from '../../domain/models';
import { safeExternalUrl } from '../shared/safeUrl';

interface LinkPreviewProps {
  preview: NonNullable<ChatMessage['linkPreview']>;
  loadPhoto?: (() => Promise<string>) | undefined;
  loadMedia?: (() => Promise<string>) | undefined;
}

export function LinkPreview(props: LinkPreviewProps) {
  const isVideoPreview = () =>
    props.preview.type === 'video' || props.preview.type === 'gif' || props.preview.hasEmbed;
  const usesLargePhoto = () => {
    const provider = props.preview.siteName?.trim().toLowerCase() ?? '';
    const providerDefaultsToLarge =
      provider === 'twitter' ||
      provider === 'x' ||
      provider === 'x (formerly twitter)' ||
      provider === 'facebook';
    return props.preview.photoSize === 'large' || providerDefaultsToLarge;
  };
  const [photo] = createUiResource(
    () => (props.preview.hasPhoto && props.loadPhoto ? props.preview.url : false),
    () => props.loadPhoto?.().catch(() => undefined),
  );
  const [media] = createUiResource(
    () =>
      props.preview.media && props.loadMedia
        ? `${props.preview.url}:${props.preview.media.cacheKey ?? props.preview.media.name}`
        : false,
    () => props.loadMedia?.().catch(() => undefined),
  );

  const copy = () => (
    <span class="link-preview-copy">
      <Show when={props.preview.siteName}>
        <small>{props.preview.siteName}</small>
      </Show>
      <strong>{props.preview.title || props.preview.url}</strong>
      <Show when={props.preview.description}>
        <span>{props.preview.description}</span>
      </Show>
    </span>
  );
  const content = () => (
    <>
      <Show when={props.preview.hasPhoto}>
        <span class="link-preview-photo" aria-hidden="true">
          <img src={photo()} alt="" classList={{ loaded: Boolean(photo()) }} />
        </span>
      </Show>
      {copy()}
    </>
  );
  const href = () => safeExternalUrl(props.preview.url);
  return (
    <Show
      when={props.preview.media}
      fallback={
        <Show
          when={href()}
          fallback={
            <div
              class="link-preview"
              classList={{
                'link-preview-large': usesLargePhoto(),
                'link-preview-video-cover': Boolean(isVideoPreview()),
              }}
            >
              {content()}
            </div>
          }
        >
          {(url) => (
            <a
              class="link-preview"
              classList={{
                'link-preview-large': usesLargePhoto(),
                'link-preview-video-cover': Boolean(isVideoPreview()),
              }}
              href={url()}
              target="_blank"
              rel="noopener noreferrer"
            >
              {content()}
            </a>
          )}
        </Show>
      }
    >
      {(previewMedia) => (
        <div class="link-preview link-preview-large link-preview-media">
          <span
            class="link-preview-media-frame"
            style={{
              'aspect-ratio':
                previewMedia().width && previewMedia().height
                  ? `${previewMedia().width} / ${previewMedia().height}`
                  : '16 / 9',
            }}
          >
            <video
              src={media()}
              poster={photo()}
              controls={previewMedia().kind === 'video'}
              autoplay={previewMedia().kind === 'animation'}
              muted={previewMedia().kind === 'animation'}
              loop={previewMedia().kind === 'animation'}
              playsinline
              preload="metadata"
              aria-label={props.preview.title || previewMedia().name}
            />
          </span>
          <Show when={href()} fallback={copy()}>
            {(url) => (
              <a href={url()} target="_blank" rel="noopener noreferrer">
                {copy()}
              </a>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
