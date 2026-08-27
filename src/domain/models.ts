import type { RichMessage } from './richMessage';

export type Presence = 'online' | 'recently' | 'offline';

export interface ChatSummary {
  id: string;
  title: string;
  initials: string;
  color: string;
  preview: string;
  time: string;
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
  status: MessageStatus;
  groupedId?: string | undefined;
  forwardedFrom?:
    | {
        name: string;
        peerId?: string | undefined;
        messageId?: number | undefined;
      }
    | undefined;
  service?:
    | {
        kind: string;
        text: string;
      }
    | undefined;
  botKeyboard?:
    | {
        kind: 'inline' | 'reply';
        rows: Array<
          Array<{
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
            data?: number[] | undefined;
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
  replyToId?: number | undefined;
  replyMedia?: ChatMessage['media'] | undefined;
  replyMediaPeerId?: string | undefined;
  reaction?: string;
  reactions?:
    | Array<{
        emoji: string;
        customEmojiId?: string | undefined;
        count: number;
        chosen: boolean;
      }>
    | undefined;
  mentions?: Array<{ offset: number; length: number; userId?: string | undefined }> | undefined;
  links?: Array<{ offset: number; length: number; url?: string | undefined }> | undefined;
  linkPreview?:
    | {
        url: string;
        siteName?: string | undefined;
        title?: string | undefined;
        description?: string | undefined;
        hasPhoto?: boolean | undefined;
      }
    | undefined;
  formats?:
    | Array<{
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
          | 'textUrl'
          | 'customEmoji'
          | 'formattedDate'
          | 'diffInsert'
          | 'diffReplace'
          | 'diffDelete';
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
        cacheKey?: string | undefined;
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
