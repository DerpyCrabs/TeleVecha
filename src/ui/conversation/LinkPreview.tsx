import { Effect } from 'effect';
import type { ChatMessage } from '../../domain/models';
import { available, resourceComponent, view } from 'effectweb';
import { loadEffect } from 'effectweb/cache';
import { safeExternalUrl } from '../shared/safeUrl';
interface LinkPreviewProps {
  preview: NonNullable<ChatMessage['linkPreview']>;
  loadPhoto?: (() => Effect.Effect<string, unknown>) | undefined;
  loadMedia?: (() => Effect.Effect<string, unknown>) | undefined;
}
export const LinkPreview = resourceComponent<
  LinkPreviewProps,
  { photo: string | undefined; media: string | undefined }
>({
  request: (props) => ({
    key: [
      props.preview.url,
      props.preview.hasPhoto,
      Boolean(props.loadPhoto),
      props.preview.media?.cacheKey ?? props.preview.media?.name,
      Boolean(props.loadMedia),
    ].join(':'),
    load: () =>
      Effect.all(
        {
          photo: loadEffect(
            () =>
              (props.preview.hasPhoto ? props.loadPhoto?.() : undefined) ??
              Effect.succeed(undefined),
          ).pipe(Effect.catch(() => Effect.succeed(undefined))),
          media: loadEffect(
            () =>
              (props.preview.media ? props.loadMedia?.() : undefined) ?? Effect.succeed(undefined),
          ).pipe(Effect.catch(() => Effect.succeed(undefined))),
        },
        { concurrency: 'unbounded' },
      ),
  }),
  view: view((model, _send) => {
    const props = model.props;
    const photo = () => available(model.result)?.photo;
    const media = () => available(model.result)?.media;
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
    const copy = () => (
      <span class="link-preview-copy">
        {props.preview.siteName ? <small>{props.preview.siteName}</small> : null}
        <strong>{props.preview.title || props.preview.url}</strong>
        {props.preview.description ? <span>{props.preview.description}</span> : null}
      </span>
    );
    const content = () => (
      <>
        {props.preview.hasPhoto ? (
          <span class="link-preview-photo" aria-hidden="true">
            <img src={photo()} alt="" classList={{ loaded: Boolean(photo()) }} />
          </span>
        ) : null}
        {copy()}
      </>
    );
    const href = () => safeExternalUrl(props.preview.url);
    return props.preview.media ? (
      ((previewMedia) => (
        <div class="link-preview link-preview-large link-preview-media">
          <span
            class="link-preview-media-frame"
            style={{
              'aspect-ratio':
                previewMedia.width && previewMedia.height
                  ? `${previewMedia.width} / ${previewMedia.height}`
                  : '16 / 9',
            }}
          >
            <video
              src={media()}
              poster={photo()}
              controls={previewMedia.kind === 'video'}
              autoplay={previewMedia.kind === 'animation'}
              muted={previewMedia.kind === 'animation'}
              loop={previewMedia.kind === 'animation'}
              playsinline
              preload="metadata"
              aria-label={props.preview.title || previewMedia.name}
            />
          </span>
          {href()
            ? ((url) => (
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {copy()}
                </a>
              ))(href()!)
            : copy()}
        </div>
      ))(props.preview.media!)
    ) : href() ? (
      ((url) => (
        <a
          class="link-preview"
          classList={{
            'link-preview-large': usesLargePhoto(),
            'link-preview-video-cover': Boolean(isVideoPreview()),
          }}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {content()}
        </a>
      ))(href()!)
    ) : (
      <div
        class="link-preview"
        classList={{
          'link-preview-large': usesLargePhoto(),
          'link-preview-video-cover': Boolean(isVideoPreview()),
        }}
      >
        {content()}
      </div>
    );
  }),
});
