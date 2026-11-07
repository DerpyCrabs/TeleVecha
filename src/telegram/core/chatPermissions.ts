import type {
  TelegramChatPermissions,
  TelegramDeleteDialogAction,
  TelegramDialog,
  TelegramMedia,
  TelegramMessage,
} from '../types';

export interface TelegramMessageCapabilities {
  canPin: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canDeleteForMe: boolean;
  canDeleteForEveryone: boolean;
  canForward: boolean;
}

export interface TelegramDeleteDialogOption {
  action: TelegramDeleteDialogAction;
  label: string;
  description: string;
  danger?: boolean;
}

export function canSendMediaKindToPermissions(
  permissions: TelegramChatPermissions,
  mediaKind?: TelegramMedia['kind'],
) {
  if (!permissions.canSendMessages) return false;
  if (mediaKind === undefined) return true;
  if (mediaKind === 'sticker') return permissions.canSendStickers;
  if (mediaKind === 'animation') return permissions.canSendGifs;
  return permissions.canSendMedia;
}

export function canSendMessageToPermissions(
  permissions: TelegramChatPermissions,
  message?: Pick<TelegramMessage, 'media'>,
) {
  return canSendMediaKindToPermissions(permissions, message?.media?.kind);
}

export function canSendMessageToDialog(
  dialog: TelegramDialog,
  message?: Pick<TelegramMessage, 'media'>,
) {
  return canSendMessageToPermissions(permissionsForDialog(dialog), message);
}

const userPermissions = (): TelegramChatPermissions => ({
  canSendMessages: true,
  canSendMedia: true,
  canSendStickers: true,
  canSendGifs: true,
  canPinMessages: true,
  canEditMessages: false,
  canDeleteMessages: false,
  canDeleteForEveryone: true,
  canDeleteChat: false,
  canDeleteChannel: false,
  canLeave: false,
  canViewMembers: false,
});

const groupPermissions = (): TelegramChatPermissions => ({
  canSendMessages: false,
  canSendMedia: false,
  canSendStickers: false,
  canSendGifs: false,
  canPinMessages: false,
  canEditMessages: false,
  canDeleteMessages: false,
  canDeleteForEveryone: false,
  canDeleteChat: false,
  canDeleteChannel: false,
  canLeave: true,
  canViewMembers: false,
});

const channelPermissions = (): TelegramChatPermissions => ({
  canSendMessages: false,
  canSendMedia: false,
  canSendStickers: false,
  canSendGifs: false,
  canPinMessages: false,
  canEditMessages: false,
  canDeleteMessages: false,
  canDeleteForEveryone: false,
  canDeleteChat: false,
  canDeleteChannel: false,
  canLeave: true,
  canViewMembers: false,
});

export function permissionsForDialog(dialog: TelegramDialog): TelegramChatPermissions {
  return (
    dialog.permissions ??
    (dialog.peer.kind === 'user'
      ? userPermissions()
      : dialog.peer.kind === 'channel'
        ? channelPermissions()
        : groupPermissions())
  );
}

export function messageCapabilities(
  dialog: TelegramDialog,
  message: Pick<
    TelegramMessage,
    'outgoing' | 'protected' | 'service' | 'forwardedFrom' | 'media' | 'text' | 'poll' | 'contact'
  >,
): TelegramMessageCapabilities {
  const permissions = permissionsForDialog(dialog);
  const canDeleteForMe = dialog.peer.kind !== 'channel';
  const canDeleteForEveryone =
    dialog.peer.kind === 'channel'
      ? permissions.canDeleteMessages
      : dialog.peer.kind === 'user'
        ? permissions.canDeleteForEveryone
        : message.outgoing || permissions.canDeleteForEveryone || permissions.canDeleteMessages;
  const canDelete =
    dialog.peer.kind === 'channel'
      ? permissions.canDeleteMessages
      : dialog.peer.kind === 'user'
        ? canDeleteForMe || canDeleteForEveryone
        : message.outgoing || permissions.canDeleteMessages;
  const editableMedia =
    !message.poll &&
    !message.contact &&
    (message.media === undefined ||
      !['sticker', 'voice', 'round-video'].includes(message.media.kind));
  const canEditOwnMessage =
    message.outgoing && !message.service && !message.forwardedFrom && editableMedia;

  const actionable = !message.service;
  return {
    canPin: actionable && permissions.canPinMessages,
    canEdit:
      actionable &&
      !message.forwardedFrom &&
      editableMedia &&
      (canEditOwnMessage || permissions.canEditMessages),
    canDelete: actionable && canDelete,
    canDeleteForMe: actionable && canDeleteForMe,
    canDeleteForEveryone: actionable && canDeleteForEveryone,
    canForward: !message.protected && !message.service,
  };
}

export function deleteDialogOptions(dialog: TelegramDialog): TelegramDeleteDialogOption[] {
  const permissions = permissionsForDialog(dialog);
  if (dialog.peer.kind === 'user') {
    const options: TelegramDeleteDialogOption[] = [
      {
        action: 'clear-for-me',
        label: 'Delete for me',
        description: 'Remove this chat and its history from your Telegram account.',
      },
    ];
    if (permissions.canDeleteForEveryone) {
      options.push({
        action: 'delete-for-everyone',
        label: 'Delete for everyone',
        description: 'Remove this chat history for both participants.',
        danger: true,
      });
    }
    return options;
  }
  if (dialog.peer.kind === 'channel') {
    if (!permissions.canDeleteChannel && !permissions.canLeave) return [];
    return [
      permissions.canDeleteChannel
        ? {
            action: 'delete-channel',
            label: 'Delete channel',
            description: 'Delete this channel for all subscribers.',
            danger: true,
          }
        : {
            action: 'leave',
            label: 'Leave channel',
            description: 'Leave this channel and remove it from your chat list.',
            danger: true,
          },
    ];
  }
  if (!permissions.canDeleteChat && !permissions.canLeave) return [];
  return [
    permissions.canDeleteChat
      ? {
          action: 'delete-chat',
          label: 'Delete group',
          description: 'Delete this group and remove it from your chat list.',
          danger: true,
        }
      : {
          action: 'leave',
          label: 'Leave group',
          description: 'Leave this group and remove it from your chat list.',
          danger: true,
        },
  ];
}
