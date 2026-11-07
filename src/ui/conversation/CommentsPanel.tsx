import type { QuerySources } from '../app/queries';
import type { VoiceService } from '../media/voicePlayback';
import { collection, list, view } from 'effectweb';
import type { TelegramDiscussion, TelegramMessage } from '../../telegram/types';
import type { MediaAssets } from '../media/mediaAssets';
import { Dialog } from '../shared/Dialog';
import { Avatar } from '../shared/Avatar';
import { telegramPeerColor } from '../../domain/peerColor';
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
    online: boolean;
    close: () => void;
    loadOlder: () => void;
    retry: () => void;
    mediaAssets: MediaAssets;
    previewPhoto: QuerySources['previewPhoto'];
    voice?: VoiceService | undefined;
  },
  never
>((props) => (
  <Dialog title="Comments" closeLabel="Back to post" onClose={props.close} class="comments-panel">
    <div class="comments-scroll" aria-busy={props.state.loading}>
      {props.state.hasOlder ? (
        <button class="comments-load" disabled={props.state.loading} onClick={props.loadOlder}>
          Load older comments
        </button>
      ) : null}
      {list(rows(props.state.messages), (message) => (
        <article
          classList={{
            'comment-message': true,
            'message-target': props.state.targetId === message.id,
          }}
          data-comment-id={message.id}
        >
          <span
            class="comment-avatar"
            title={message.senderName || message.senderId}
            aria-hidden="true"
          >
            <Avatar
              identity={`${message.senderId}:${message.senderAvatarId ?? 'none'}`}
              initials={(message.senderName || message.senderId)
                .split(/\s+/u)
                .slice(0, 2)
                .map((part) => part[0])
                .join('')
                .toLocaleUpperCase()}
              color={
                message.senderColorVersion === 2 && message.senderColor
                  ? message.senderColor
                  : telegramPeerColor(message.senderId)
              }
              size="sm"
              loadCached={
                message.senderHasAvatar !== false
                  ? () =>
                      props.mediaAssets.loadPeerAvatar(
                        {
                          id: message.senderId,
                          kind: message.senderId.startsWith('u:')
                            ? 'user'
                            : message.senderId.startsWith('g:')
                              ? 'group'
                              : 'channel',
                        },
                        true,
                        message.senderAvatarId,
                        true,
                      )
                  : undefined
              }
              load={
                props.online && message.senderHasAvatar !== false
                  ? () =>
                      props.mediaAssets.loadPeerAvatar(
                        {
                          id: message.senderId,
                          kind: message.senderId.startsWith('u:')
                            ? 'user'
                            : message.senderId.startsWith('g:')
                              ? 'group'
                              : 'channel',
                        },
                        true,
                        message.senderAvatarId,
                      )
                  : undefined
              }
            />
          </span>
          <div class="comment-content">
            <strong title={message.senderName || message.senderId}>
              {message.senderName || message.senderId}
            </strong>
            {message.replyToId && message.replyToId !== props.state.discussion?.root.id ? (
              <small>Reply to #{message.replyToId}</small>
            ) : null}
            {message.media ? (
              <MediaAttachment
                voiceControl={
                  props.voice && message.media.kind === 'voice'
                    ? { service: props.voice, key: `${message.peerId}:${message.id}` }
                    : undefined
                }
                mediaUnread={message.mediaUnread}
                media={message.media}
                protected={message.protected}
                loadPlayback={() => props.mediaAssets.playMedia(message)}
                load={(progress) => props.mediaAssets.loadMedia(message, progress)}
                loadPreview={() => props.mediaAssets.messagePreview(message).load()}
              />
            ) : null}
            <MessageBody
              message={presentMessage(message, 0)}
              previewPhoto={
                message.linkPreview?.hasPhoto
                  ? props.previewPhoto(message.peerId, String(message.id))
                  : undefined
              }
              loadPreviewMedia={
                message.linkPreview?.media ? () => props.mediaAssets.loadMedia(message) : undefined
              }
            />
            <time
              dateTime={new Date(message.date * 1000).toISOString()}
              title={new Date(message.date * 1000).toLocaleString()}
            >
              {new Date(message.date * 1000).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          </div>
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
