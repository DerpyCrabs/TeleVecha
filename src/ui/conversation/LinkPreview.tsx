import {
  available,
  component,
  observe,
  ownerOf,
  view,
  type Snapshot,
  type Source,
} from 'effectweb';
import { Effect } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import type { ChatMessage } from '../../domain/models';
import { safeExternalUrl } from '../shared/safeUrl';

interface LinkPreviewProps {
  preview: NonNullable<ChatMessage['linkPreview']>;
  photo?: Source<AsyncResult.AsyncResult<string | undefined, never>> | undefined;
  loadMedia?: (() => Effect.Effect<string, unknown>) | undefined;
}
interface PreviewVideoProps {
  identity: string;
  media: NonNullable<NonNullable<ChatMessage['linkPreview']>['media']>;
  poster: string | undefined;
  title: string;
  load: LinkPreviewProps['loadMedia'];
}
const PreviewVideo = component(
  {
    init: (_props: Snapshot<PreviewVideoProps>) => ({
      video: AsyncResult.initial() as AsyncResult.AsyncResult<string, unknown>,
      // The browser could not play the loaded source.
      broken: false,
    }),
    identity: (props) => props.identity,
  },
  view((model, patch) => {
    const source = model.broken ? undefined : available(model.video);
    const loading = model.video.waiting;
    const failed = model.broken || AsyncResult.isFailure(model.video);
    const play = () => {
      // A retry starts from nothing, so a source that failed to play is not shown again.
      patch({ broken: false, video: AsyncResult.initial() });
      ownerOf(patch).task(
        'video',
        model.props.load?.() ?? Effect.fail(new Error('Video unavailable')),
        'drop',
      );
    };
    return (
      <span
        class="link-preview-media-frame"
        style={{
          'aspect-ratio':
            model.props.media.width && model.props.media.height
              ? `${model.props.media.width} / ${model.props.media.height}`
              : '16 / 9',
        }}
      >
        {source ? (
          <video
            src={source}
            poster={model.props.poster}
            controls
            autoplay
            muted={model.props.media.kind === 'animation'}
            loop={model.props.media.kind === 'animation'}
            playsinline
            preload="none"
            aria-label={model.props.title}
            onError={() => patch({ broken: true })}
          />
        ) : (
          <button
            type="button"
            class="link-preview-play"
            disabled={loading}
            aria-label={loading ? 'Loading video' : failed ? 'Retry video' : 'Play video'}
            onClick={play}
          >
            {model.props.poster ? <img draggable={false} src={model.props.poster} alt="" /> : null}
            <span>{loading ? 'Loading…' : failed ? 'Video unavailable · Retry' : '▶'}</span>
          </button>
        )}
      </span>
    );
  }),
);
function linkPreview(props: Snapshot<LinkPreviewProps>, loaded: string | undefined) {
  const photo = () => loaded;
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
          <img draggable={false} src={photo()} alt="" classList={{ loaded: Boolean(photo()) }} />
        </span>
      ) : null}
      {copy()}
    </>
  );
  const href = () => safeExternalUrl(props.preview.url);
  return props.preview.media ? (
    ((previewMedia) => (
      <div class="link-preview link-preview-large link-preview-media">
        <PreviewVideo
          identity={`${props.preview.url}:${previewMedia.cacheKey ?? previewMedia.name}`}
          media={previewMedia}
          poster={photo()}
          title={props.preview.title || previewMedia.name}
          load={props.loadMedia}
        />
        {href()
          ? ((url) => (
              <a draggable={false} href={url} target="_blank" rel="noopener noreferrer">
                {copy()}
              </a>
            ))(href()!)
          : copy()}
      </div>
    ))(props.preview.media!)
  ) : href() ? (
    ((url) => (
      <a
        draggable={false}
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
}
export const LinkPreview = view<LinkPreviewProps>((props) =>
  props.photo
    ? observe(props.photo, (result) => linkPreview(props, available(result)))
    : linkPreview(props, undefined),
);
