import { For, Show, createSignal } from 'solid-js';

import type { ChatMessage } from '../../domain/models';
import type { TelegramTransferProgress } from '../../telegram/types';
import { MediaAttachment, type MediaPreview } from '../media/MediaAttachment';
import { MediaViewer } from '../media/MediaViewer';

interface MessageAlbumProps {
  messages: ChatMessage[];
  load: (message: ChatMessage, progress?: TelegramTransferProgress) => Promise<string>;
  loadPreview?: ((message: ChatMessage) => Promise<string>) | undefined;
  cachedUrl: (message: ChatMessage) => string | undefined;
  cachedPreviewUrl?: ((message: ChatMessage) => string | undefined) | undefined;
  revision?: ((message: ChatMessage) => string | number | undefined) | undefined;
  progress?: ((message: ChatMessage) => number | undefined) | undefined;
  openActions: (message: ChatMessage, event: MouseEvent) => void;
  openPreview?: ((message: ChatMessage, preview: MediaPreview) => boolean | void) | undefined;
}

export function MessageAlbum(props: MessageAlbumProps) {
  const [viewer, setViewer] = createSignal<
    { index: number; message: ChatMessage; preview: MediaPreview } | undefined
  >();
  const [viewerLoading, setViewerLoading] = createSignal(false);
  let viewerGeneration = 0;
  const previewableMessages = () =>
    props.messages.filter(
      (message) =>
        message.media?.kind === 'photo' ||
        message.media?.kind === 'video' ||
        (message.media?.kind === 'animation' && message.media.mimeType.startsWith('video/')),
    );
  const previewKind = (message: ChatMessage) =>
    message.media?.kind === 'photo' ? ('image' as const) : ('video' as const);
  const openPreview = (message: ChatMessage, preview: MediaPreview) => {
    if (props.openPreview?.(message, preview) !== false && props.openPreview) return;
    const index = previewableMessages().findIndex(({ id }) => id === message.id);
    if (index >= 0) setViewer({ index, message, preview });
  };
  const navigatePreview = async (index: number) => {
    const messages = previewableMessages();
    const message = messages[index];
    if (!message?.media || viewerLoading()) return;
    const generation = ++viewerGeneration;
    setViewerLoading(true);
    try {
      const url = props.cachedUrl(message) ?? (await props.load(message));
      if (generation !== viewerGeneration) return;
      setViewer({
        index,
        message,
        preview: { kind: previewKind(message), name: message.media.name, url },
      });
    } catch {
      // Keep the current attachment visible if its neighbour cannot be loaded.
    } finally {
      if (generation === viewerGeneration) setViewerLoading(false);
    }
  };
  const closeViewer = () => {
    viewerGeneration += 1;
    setViewerLoading(false);
    setViewer(undefined);
  };
  const aspectRatio = (message: ChatMessage) => {
    const width = message.media?.width;
    const height = message.media?.height;
    return width && height ? width / height : 1;
  };
  const rows = () => {
    if (props.messages.length === 3) return [props.messages.slice(0, 1), props.messages.slice(1)];
    const result: ChatMessage[][] = [];
    for (let index = 0; index < props.messages.length;) {
      const remaining = props.messages.length - index;
      const size = remaining <= 3 ? remaining : remaining === 4 ? 2 : 3;
      result.push(props.messages.slice(index, index + size));
      index += size;
    }
    return result;
  };

  return (
    <div
      class="media-album"
      role="group"
      aria-label={`${props.messages.length} grouped media attachments`}
      data-album-size={props.messages.length}
    >
      <For each={rows()}>
        {(row) => (
          <div class="media-album-row">
            <For each={row}>
              {(message) => (
                <div
                  class="media-album-item"
                  data-message-id={message.id}
                  style={{
                    'aspect-ratio': String(aspectRatio(message)),
                    'flex-grow': String(aspectRatio(message)),
                  }}
                  tabIndex={0}
                  aria-label={`Album item ${message.media?.name ?? message.id}. Press Shift+F10 for actions.`}
                  onContextMenu={(event) => {
                    if (
                      event.target instanceof HTMLImageElement ||
                      event.target instanceof HTMLVideoElement
                    ) {
                      event.stopPropagation();
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    props.openActions(message, event);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    props.openActions(
                      message,
                      new MouseEvent('contextmenu', {
                        clientX: bounds.right,
                        clientY: bounds.top,
                      }),
                    );
                  }}
                >
                  {message.media ? (
                    <MediaAttachment
                      media={message.media}
                      cachedUrl={() => props.cachedUrl(message)}
                      cachedPreviewUrl={() => props.cachedPreviewUrl?.(message)}
                      load={(progress) => props.load(message, progress)}
                      loadPreview={
                        props.loadPreview &&
                        (message.media?.kind === 'photo' || message.media?.kind === 'video')
                          ? () => props.loadPreview!(message)
                          : undefined
                      }
                      revision={props.revision?.(message)}
                      protected={message.protected}
                      onOpenPreview={(preview) => openPreview(message, preview)}
                    />
                  ) : null}
                  <Show when={props.progress?.(message) !== undefined}>
                    <span class="media-album-progress" role="status">
                      {Math.round((props.progress?.(message) ?? 0) * 100)}%
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
      <Show when={viewer()}>
        {(current) => (
          <MediaViewer
            kind={current().preview.kind}
            name={current().preview.name}
            url={current().preview.url}
            close={closeViewer}
            position={current().index + 1}
            count={previewableMessages().length}
            loading={viewerLoading()}
            previous={
              current().index > 0 ? () => void navigatePreview(current().index - 1) : undefined
            }
            next={
              current().index < previewableMessages().length - 1
                ? () => void navigatePreview(current().index + 1)
                : undefined
            }
          />
        )}
      </Show>
    </div>
  );
}
