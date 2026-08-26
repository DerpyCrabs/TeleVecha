import { For, Show } from 'solid-js';

import type { ChatMessage } from '../../domain/models';
import { MediaAttachment } from '../media/MediaAttachment';

interface MessageAlbumProps {
  messages: ChatMessage[];
  load: (message: ChatMessage) => Promise<string>;
  cachedUrl: (message: ChatMessage) => string | undefined;
  revision?: ((message: ChatMessage) => string | number | undefined) | undefined;
  progress?: ((message: ChatMessage) => number | undefined) | undefined;
  openActions: (message: ChatMessage, event: MouseEvent) => void;
}

export function MessageAlbum(props: MessageAlbumProps) {
  const aspectRatio = (message: ChatMessage) => {
    const width = message.media?.width;
    const height = message.media?.height;
    return width && height ? width / height : 1;
  };
  const rows = () => {
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
                      load={() => props.load(message)}
                      revision={props.revision?.(message)}
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
    </div>
  );
}
