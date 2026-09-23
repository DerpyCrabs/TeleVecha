import type { RichMessage } from './richMessage';

export type Presence = 'online' | 'recently' | 'offline';

export interface ChatSummary {
  id: string;
  title: string;
  initials: string;
  color: string;
  preview: string;
  time: string;
  lastMessageStatus?: 'sent' | 'read' | undefined;
  unread: number;
  muted?: boolean;
  pinned?: boolean;
  archived?: boolean;
  username?: string | undefined;
  bot?: boolean;
  presence?: Presence;
  lastSeenAt?: number | undefined;
  kind?: 'user' | 'group' | 'channel';
}

export type MessageStatus = 'sending' | 'sent' | 'read' | 'failed';

export interface ChatMessage {
  id: string;
  peerId?: string | undefined;
  author: string;
  senderId?: string | undefined;
  senderHasAvatar?: boolean | undefined;
  senderAvatarId?: string | undefined;
  senderColor?: string | undefined;
  senderColorVersion?: number | undefined;
  senderRole?: string | undefined;
  senderRoleKind?: 'owner' | 'admin' | undefined;
  body: string;
  time: string;
  date?: number | undefined;
  editedAt?: number | undefined;
  outgoing: boolean;
  protected?: boolean | undefined;
  status: MessageStatus;
  groupedId?: string | undefined;
  forwardedFrom?:
    | {
        name: string;
        peerId?: string | undefined;
        messageId?: number | undefined;
        hasAvatar?: boolean | undefined;
        avatarId?: string | undefined;
        color?: string | undefined;
      }
    | undefined;
  service?: { kind: string; text: string } | undefined;
  botKeyboard?:
    | {
        kind: 'inline' | 'reply';
        rows: ReadonlyArray<
          ReadonlyArray<{
            kind:
              | 'text'
              | 'url'
              | 'url-auth'
              | 'callback'
              | 'copy'
              | 'switch-inline'
              | 'unsupported';
            text: string;
            url?: string | undefined;
            buttonId?: number | undefined;
            data?: readonly number[] | undefined;
            copyText?: string | undefined;
            query?: string | undefined;
            samePeer?: boolean | undefined;
            botUsername?: string | undefined;
          }>
        >;
        hidden?: boolean | undefined;
        forceReply?: boolean | undefined;
        singleUse?: boolean | undefined;
        persistent?: boolean | undefined;
        placeholder?: string | undefined;
      }
    | undefined;
  replyTo?: string | undefined;
  replyAuthor?: string | undefined;
  replyToId?: number | undefined;
  comments?: { count: number; channelId: string } | undefined;
  replyMedia?: ChatMessage['media'] | undefined;
  replyMediaPeerId?: string | undefined;
  reaction?: string;
  reactions?:
    | ReadonlyArray<{
        emoji: string;
        customEmojiId?: string | undefined;
        count: number;
        chosen: boolean;
      }>
    | undefined;
  mentions?:
    | ReadonlyArray<{ offset: number; length: number; userId?: string | undefined }>
    | undefined;
  links?: ReadonlyArray<{ offset: number; length: number; url?: string | undefined }> | undefined;
  linkPreview?:
    | {
        url: string;
        webPageId?: string | undefined;
        type?: string | undefined;
        hasEmbed?: boolean | undefined;
        siteName?: string | undefined;
        title?: string | undefined;
        description?: string | undefined;
        hasPhoto?: boolean | undefined;
        photoSize?: 'small' | 'large' | undefined;
        media?:
          | {
              kind: 'video' | 'animation';
              name: string;
              mimeType: string;
              size?: number | undefined;
              width?: number | undefined;
              height?: number | undefined;
              duration?: number | undefined;
              cacheKey?: string | undefined;
            }
          | undefined;
      }
    | undefined;
  formats?:
    | ReadonlyArray<{
        offset: number;
        length: number;
        kind:
          | 'bold'
          | 'italic'
          | 'underline'
          | 'strike'
          | 'code'
          | 'pre'
          | 'spoiler'
          | 'blockquote'
          | 'expandableBlockquote'
          | 'mention'
          | 'mentionName'
          | 'textUrl'
          | 'customEmoji'
          | 'formattedDate'
          | 'diffInsert'
          | 'diffReplace'
          | 'diffDelete';
        userId?: string | undefined;
        accessHash?: string | undefined;
        url?: string | undefined;
        customEmojiId?: string | undefined;
        timestamp?: number | undefined;
        oldText?: string | undefined;
      }>
    | undefined;
  richMessage?: RichMessage | undefined;
  uploadProgress?: number | undefined;
  media?:
    | {
        kind: 'photo' | 'video' | 'round-video' | 'voice' | 'animation' | 'sticker' | 'file';
        name: string;
        mimeType: string;
        size?: number | undefined;
        width?: number | undefined;
        height?: number | undefined;
        duration?: number | undefined;
        waveform?: readonly number[] | undefined;
        cacheKey?: string | undefined;
        spoiler?: boolean | undefined;
      }
    | undefined;
}

export interface ChatDetails {
  sharedMedia: number;
  sharedFiles: number;
  sharedLinks: number;
  username: string;
  bio: string;
}
