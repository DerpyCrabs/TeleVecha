import { Show, createEffect, createSignal } from 'solid-js';

import type { ChatMessage } from '../domain/models';
import { safeExternalUrl } from './safeUrl';

interface LinkPreviewProps {
  preview: NonNullable<ChatMessage['linkPreview']>;
  loadPhoto?: (() => Promise<string>) | undefined;
}

export function LinkPreview(props: LinkPreviewProps) {
  const [photo, setPhoto] = createSignal('');
  let generation = 0;

  createEffect(() => {
    const previewUrl = props.preview.url;
    const loadPhoto = props.loadPhoto;
    const currentGeneration = ++generation;
    setPhoto('');
    if (!props.preview.hasPhoto || !loadPhoto) return;
    void loadPhoto().then(
      (url) => {
        if (generation === currentGeneration && props.preview.url === previewUrl) setPhoto(url);
      },
      () => undefined,
    );
  });

  const content = () => (
    <>
      <Show when={props.preview.hasPhoto}>
        <span class="link-preview-photo" aria-hidden="true">
          <img src={photo() || undefined} alt="" classList={{ loaded: Boolean(photo()) }} />
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
    <Show when={href()} fallback={<div class="link-preview">{content()}</div>}>
      {(url) => (
        <a class="link-preview" href={url()} target="_blank" rel="noopener noreferrer">
          {content()}
        </a>
      )}
    </Show>
  );
}
