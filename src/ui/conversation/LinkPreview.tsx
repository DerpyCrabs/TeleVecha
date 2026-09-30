import {
  commandSlot,
  available,
  component,
  observe,
  view,
  effectCommand,
  type Snapshot,
  type Source,
} from 'effectweb';
import { Effect } from 'effect';
import type * as AsyncResult from 'effect/reactivity/AsyncResult';
import type { ChatMessage } from '../../domain/models';
import { safeExternalUrl } from '../shared/safeUrl';
const commandMedia = commandSlot('media');

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
interface PreviewVideoModel {
  props: PreviewVideoProps;
  source: string | undefined;
  loading: boolean;
  failed: boolean;
}
type PreviewVideoMessage =
  | { type: 'Play' }
  | { type: 'Loaded'; source: string }
  | { type: 'Failed' };
const PreviewVideo = component<PreviewVideoProps, PreviewVideoModel, PreviewVideoMessage>({
  init: (props) => ({ props, source: undefined, loading: false, failed: false }),
  identity: (props) => props.identity,
  update: (model, message) => {
    switch (message.type) {
      case 'Play':
        if (model.loading) return { model };
        return {
          model: { ...model, source: undefined, loading: true, failed: false },
          commands: [
            effectCommand(
              commandMedia,
              () => model.props.load?.() ?? Effect.fail(new Error('Video unavailable')),
              {
                policy: 'replace',
                onSuccess: (source) => ({ type: 'Loaded', source }) as const,
                onFailure: () => ({ type: 'Failed' }) as const,
              },
            ),
          ],
        };
      case 'Loaded':
        return { model: { ...model, source: message.source, loading: false } };
      case 'Failed':
        return { model: { ...model, source: undefined, loading: false, failed: true } };
    }
  },
  view: view((model, send) => (
    <span
      class="link-preview-media-frame"
      style={{
        'aspect-ratio':
          model.props.media.width && model.props.media.height
            ? `${model.props.media.width} / ${model.props.media.height}`
            : '16 / 9',
      }}
    >
      {model.source ? (
        <video
          src={model.source}
          poster={model.props.poster}
          controls
          autoplay
          muted={model.props.media.kind === 'animation'}
          loop={model.props.media.kind === 'animation'}
          playsinline
          preload="none"
          aria-label={model.props.title}
          onError={() => send({ type: 'Failed' })}
        />
      ) : (
        <button
          type="button"
          class="link-preview-play"
          disabled={model.loading}
          aria-label={model.loading ? 'Loading video' : model.failed ? 'Retry video' : 'Play video'}
          onClick={() => send({ type: 'Play' })}
        >
          {model.props.poster ? <img draggable={false} src={model.props.poster} alt="" /> : null}
          <span>
            {model.loading ? 'Loading…' : model.failed ? 'Video unavailable · Retry' : '▶'}
          </span>
        </button>
      )}
    </span>
  )),
});
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
