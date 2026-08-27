import { Show, createResource } from 'solid-js';

import type { ChatMessage } from '../../domain/models';
import { safeExternalUrl } from '../shared/safeUrl';

interface LinkPreviewProps {
  preview: NonNullable<ChatMessage['linkPreview']>;
  loadPhoto?: (() => Promise<string>) | undefined;
}

export function LinkPreview(props: LinkPreviewProps) {
  const [photo] = createResource(
    () => (props.preview.hasPhoto && props.loadPhoto ? props.preview.url : false),
    () => props.loadPhoto?.().catch(() => undefined),
  );

  const content = () => (
    <>
      <Show when={props.preview.hasPhoto}>
        <span class="link-preview-photo" aria-hidden="true">
          <img src={photo()} alt="" classList={{ loaded: Boolean(photo()) }} />
        </span>
      </Show>
      <span class="link-preview-copy">
        <Show when={props.preview.siteName}>
          <small>{props.preview.siteName}</small>
        </Show>
        <strong>{props.preview.title || props.preview.url}</strong>
        <Show when={props.preview.description}>
          <span>{props.preview.description}</span>
        </Show>
      </span>
    </>
  );
  const href = () => safeExternalUrl(props.preview.url);

  return (
    <Show
      when={href()}
      fallback={
        <div
          class="link-preview"
          classList={{ 'link-preview-large': props.preview.photoSize === 'large' }}
        >
          {content()}
        </div>
      }
    >
      {(url) => (
        <a
          class="link-preview"
          classList={{ 'link-preview-large': props.preview.photoSize === 'large' }}
          href={url()}
          target="_blank"
          rel="noopener noreferrer"
        >
          {content()}
        </a>
      )}
    </Show>
  );
}
