import { list, component, sequence, view } from 'effectweb';
import { cachedLoad } from '../shared/cachedLoad';
import { Effect } from 'effect';
import type { ChatMessage } from '../../domain/models';
import type { TelegramTransferProgress } from '../../telegram/types';
import { idRows } from '../collections';
import type { MediaPreview } from '../media/MediaAttachment';
import { MediaAttachment } from '../media/MediaAttachment';
import { MessageBody } from './MessageBody';
import { MediaViewer } from '../media/MediaViewer';
import { mediaPresentation } from '../media/mediaPresentation';
const commandPreview = 'preview';

interface MessageAlbumProps {
  messages: readonly ChatMessage[];
  load: (
    message: ChatMessage,
    progress?: TelegramTransferProgress,
  ) => Effect.Effect<string, unknown>;
  loadPlayback?: ((message: ChatMessage) => Effect.Effect<string, unknown>) | undefined;
  loadPreview?: ((message: ChatMessage) => Effect.Effect<string, unknown>) | undefined;
  cachedUrl: (message: ChatMessage) => string | undefined;
  cachedPreviewUrl?: ((message: ChatMessage) => string | undefined) | undefined;
  revisions?: Readonly<Record<string, string | number | undefined>> | undefined;
  openActions: (message: ChatMessage, event: MouseEvent) => void;
  openPreview?: ((message: ChatMessage, preview: MediaPreview) => boolean | void) | undefined;
}
function aspectRatio(message: ChatMessage) {
  const width = message.media?.width;
  const height = message.media?.height;
  return width && height ? width / height : 1;
}
function albumRows(messages: readonly ChatMessage[]) {
  if (messages.length === 3) return [messages.slice(0, 1), messages.slice(1)];
  const result: ChatMessage[][] = [];
  for (let index = 0; index < messages.length;) {
    const remaining = messages.length - index;
    const size = remaining <= 3 ? remaining : remaining === 4 ? 2 : 3;
    result.push(messages.slice(index, index + size));
    index += size;
  }
  return result;
}
type MessageAlbumState = {
  viewer: { index: number; message: ChatMessage; preview: MediaPreview } | undefined;
  viewerLoading: boolean;
};
type MessageAlbumMessage =
  | { type: 'Navigate'; index: number }
  | { type: 'CloseViewer' }
  | {
      type: 'Viewer';
      value: { index: number; message: ChatMessage; preview: MediaPreview } | undefined;
    }
  | { type: 'ViewerLoading'; value: boolean };
export const MessageAlbum = component<MessageAlbumProps, MessageAlbumState, MessageAlbumMessage>(
  {
    init: () => ({ viewer: undefined, viewerLoading: false }),
    update: (model, message) => {
      switch (message.type) {
        case 'CloseViewer':
          return {
            model: { ...model, viewer: undefined, viewerLoading: false },
            cancel: [commandPreview],
          };
        case 'Navigate': {
          const selected = model.props.messages.filter(
            (item) => item.media && mediaPresentation(item.media).preview,
          )[message.index];
          if (!selected?.media || model.viewerLoading) return { model };
          const media = selected.media;
          return {
            model: { ...model, viewerLoading: true },
            commands: [
              {
                key: commandPreview,
                policy: 'replace',
                effect: cachedLoad(
                  () => model.props.cachedUrl(selected),
                  () =>
                    media.kind !== 'photo' && model.props.loadPlayback
                      ? model.props.loadPlayback(selected)
                      : model.props.load(selected),
                ).pipe(
                  Effect.matchCause({
                    onSuccess: (url) =>
                      ({
                        type: 'Viewer',
                        value: {
                          index: message.index,
                          message: selected,
                          preview: {
                            kind: mediaPresentation(media).preview!,
                            name: media.name,
                            url,
                          },
                        },
                      }) as const,
                    onFailure: () => ({ type: 'ViewerLoading', value: false }) as const,
                  }),
                ),
              },
            ],
          };
        }
        case 'Viewer':
          return { model: { ...model, viewer: message.value, viewerLoading: false } };
        case 'ViewerLoading':
          return { model: { ...model, viewerLoading: message.value } };
      }
    },
  },
  view((model, send) => {
    const props = model.props;
    const previewableMessages = () =>
      props.messages.filter((message) => message.media && mediaPresentation(message.media).preview);
    const openPreview = (message: ChatMessage, preview: MediaPreview) => {
      if (props.openPreview?.(message, preview) !== false && props.openPreview) return;
      const index = previewableMessages().findIndex(({ id }) => id === message.id);
      if (index >= 0) send({ type: 'Viewer', value: { index, message, preview } });
    };
    const navigatePreview = (index: number) => send({ type: 'Navigate', index });
    const closeViewer = () => send({ type: 'CloseViewer' });
    const files = props.messages.every((message) => message.media?.kind === 'file');
    const rows = files ? [props.messages] : albumRows(props.messages);
    return (
      <div
        class="media-album"
        classList={{ 'file-album': files }}
        role="group"
        aria-label={`${props.messages.length} grouped media attachments`}
        data-album-size={props.messages.length}
      >
        {list(sequence(rows), (row) => (
          <div class="media-album-row">
            {list(idRows(row), (message) => (
              <div
                class="media-album-item"
                data-message-id={message.id}
                style={{
                  'aspect-ratio': files ? undefined : String(aspectRatio(message)),
                  'flex-grow': files ? undefined : String(aspectRatio(message)),
                }}
                tabIndex={0}
                aria-label={`Album item ${message.media?.name ?? message.id}. Press Shift+F10 for actions.`}
                onContextMenu={(event) => {
                  if (
                    message.status !== 'sending' &&
                    message.status !== 'failed' &&
                    (event.target instanceof HTMLImageElement ||
                      event.target instanceof HTMLVideoElement)
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
                    new MouseEvent('contextmenu', { clientX: bounds.right, clientY: bounds.top }),
                  );
                }}
              >
                {message.media ? (
                  <MediaAttachment
                    media={message.media}
                    uploadProgress={message.uploadProgress}
                    uploadFailed={message.status === 'failed'}
                    cachedUrl={() => props.cachedUrl(message)}
                    cachedPreviewUrl={() => props.cachedPreviewUrl?.(message)}
                    loadPlayback={
                      props.loadPlayback ? () => props.loadPlayback!(message) : undefined
                    }
                    load={(progress) => props.load(message, progress)}
                    loadPreview={
                      props.loadPreview &&
                      (message.media?.kind === 'photo' ||
                        message.media?.kind === 'video' ||
                        message.media?.kind === 'file')
                        ? () => props.loadPreview!(message)
                        : undefined
                    }
                    revision={props.revisions?.[message.id]}
                    messageKey={`${message.peerId}:${message.id}`}
                    protected={message.protected}
                    onOpenPreview={(preview) => openPreview(message, preview)}
                  />
                ) : null}
                {files && message.body ? (
                  <div class="file-album-caption">
                    <MessageBody message={message} />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ))}
        {model.viewer
          ? ((current) => (
              <MediaViewer
                kind={current.preview.kind}
                name={current.preview.name}
                url={current.preview.url}
                close={closeViewer}
                position={current.index + 1}
                count={previewableMessages().length}
                loading={model.viewerLoading}
                previous={current.index > 0 ? () => navigatePreview(current.index - 1) : undefined}
                next={
                  current.index < previewableMessages().length - 1
                    ? () => navigatePreview(current.index + 1)
                    : undefined
                }
              />
            ))(model.viewer!)
          : null}
      </div>
    );
  }),
);
