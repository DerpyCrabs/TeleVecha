import { collection, list as renderList, view } from 'effectweb';
import type { TelegramDiscussion, TelegramMessage } from '../../telegram/types';
import type { MediaAssets } from '../media/mediaAssets';
import { Dialog } from '../shared/Dialog';
import { MessageBody } from './MessageBody';
import { presentMessage } from './presentation';
import { MediaAttachment } from '../media/MediaAttachment';

export interface CommentsState {
  sourcePeerId: string;
  postId: number;
  discussion?: TelegramDiscussion;
  messages: TelegramMessage[];
  loading: boolean;
  error: string;
  hasOlder: boolean;
  before?: number | undefined;
  targetId?: number | undefined;
}
const rows = collection<TelegramMessage>((message) => `${message.peerId}:${message.id}`).from;
export const CommentsPanel = view<
  {
    state: CommentsState;
    close: () => void;
    loadOlder: () => void;
    retry: () => void;
    refresh: () => void;
    mediaAssets: MediaAssets;
  },
  never
>((props) => (
  <Dialog title="Comments" closeLabel="Back to post" onClose={props.close} class="comments-panel">
    <button class="comments-load" disabled={props.state.loading} onClick={props.refresh}>
      Refresh comments
    </button>
    <div class="comments-scroll" aria-busy={props.state.loading}>
      {props.state.hasOlder ? (
        <button class="comments-load" disabled={props.state.loading} onClick={props.loadOlder}>
          Load older comments
        </button>
      ) : null}
      {renderList(rows(props.state.messages), (message) => (
        <article
          classList={{
            'comment-message': true,
            'message-target': props.state.targetId === message.id,
          }}
          data-comment-id={message.id}
        >
          <strong>{message.senderName || message.senderId}</strong>
          {message.replyToId && message.replyToId !== props.state.discussion?.root.id ? (
            <small>Reply to #{message.replyToId}</small>
          ) : null}
          {message.media ? (
            <MediaAttachment
              media={message.media}
              protected={message.protected}
              load={(progress) => props.mediaAssets.loadMedia(message, progress)}
              loadPreview={() => props.mediaAssets.messagePreview(message).load()}
            />
          ) : null}
          <MessageBody
            message={presentMessage(message, 0)}
            loadPreviewPhoto={
              message.linkPreview?.hasPhoto
                ? () => props.mediaAssets.messagePreview(message).load()
                : undefined
            }
            loadPreviewMedia={
              message.linkPreview?.media ? () => props.mediaAssets.loadMedia(message) : undefined
            }
          />
          <time>{new Date(message.date * 1000).toLocaleString()}</time>
        </article>
      ))}
      {props.state.loading ? <p role="status">Loading comments…</p> : null}
      {props.state.error ? (
        <div role="alert">
          <p>{props.state.error}</p>
          <button onClick={props.retry}>Retry</button>
        </div>
      ) : null}
      {!props.state.loading &&
      !props.state.error &&
      props.state.discussion &&
      !props.state.messages.length ? (
        <p>No comments yet</p>
      ) : null}
    </div>
  </Dialog>
));
