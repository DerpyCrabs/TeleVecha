import { Effect } from 'effect';
import type {
  AdminLogActor,
  AdminLogEntry,
  AdminLogFilter,
  AdminLogRequest,
  AdminLogPage,
} from '../adminLog';
import { adminRightKeys, restrictionKeys } from '../chatManagement';
import type { MtprotoClient } from '../mtproto';
import { createMtprotoError, type MtprotoError } from '../mtproto/errors';
import { Api, type Tl } from '../mtproto/tl';
import type { TelegramPeer } from '../types';
const actionNames: Record<Tl.TypeChannelAdminLogEventAction['_'], string> = {
  channelAdminLogEventActionChangeAbout: 'changed the description',
  channelAdminLogEventActionChangeAvailableReactions: 'changed available reactions',
  channelAdminLogEventActionChangeEmojiStatus: 'changed the emoji status',
  channelAdminLogEventActionChangeEmojiStickerSet: 'changed the emoji pack',
  channelAdminLogEventActionChangeHistoryTTL: 'changed auto-delete settings',
  channelAdminLogEventActionChangeLinkedChat: 'changed the linked chat',
  channelAdminLogEventActionChangeLocation: 'changed the location',
  channelAdminLogEventActionChangePeerColor: 'changed the chat color',
  channelAdminLogEventActionChangePhoto: 'changed the chat photo',
  channelAdminLogEventActionChangeProfilePeerColor: 'changed the profile color',
  channelAdminLogEventActionChangeStickerSet: 'changed the sticker pack',
  channelAdminLogEventActionChangeTitle: 'changed the name',
  channelAdminLogEventActionChangeUsername: 'changed the public link',
  channelAdminLogEventActionChangeUsernames: 'changed public links',
  channelAdminLogEventActionChangeWallpaper: 'changed the wallpaper',
  channelAdminLogEventActionCreateTopic: 'created a topic',
  channelAdminLogEventActionDefaultBannedRights: 'changed member permissions',
  channelAdminLogEventActionDeleteMessage: 'deleted a message',
  channelAdminLogEventActionDeleteTopic: 'deleted a topic',
  channelAdminLogEventActionDiscardGroupCall: 'ended a video chat',
  channelAdminLogEventActionEditMessage: 'edited a message',
  channelAdminLogEventActionEditTopic: 'edited a topic',
  channelAdminLogEventActionExportedInviteDelete: 'deleted an invitation link',
  channelAdminLogEventActionExportedInviteEdit: 'edited an invitation link',
  channelAdminLogEventActionExportedInviteRevoke: 'revoked an invitation link',
  channelAdminLogEventActionParticipantEditRank: 'changed a member tag',
  channelAdminLogEventActionParticipantInvite: 'added a member',
  channelAdminLogEventActionParticipantJoin: 'joined',
  channelAdminLogEventActionParticipantJoinByInvite: 'joined via an invitation link',
  channelAdminLogEventActionParticipantJoinByRequest: 'joined after approval',
  channelAdminLogEventActionParticipantLeave: 'left',
  channelAdminLogEventActionParticipantMute: 'muted a participant',
  channelAdminLogEventActionParticipantSubExtend: 'extended a subscription',
  channelAdminLogEventActionParticipantToggleAdmin: 'changed administrator permissions',
  channelAdminLogEventActionParticipantToggleBan: 'changed member restrictions',
  channelAdminLogEventActionParticipantUnmute: 'unmuted a participant',
  channelAdminLogEventActionParticipantVolume: 'changed a participant’s volume',
  channelAdminLogEventActionPinTopic: 'changed the pinned topic',
  channelAdminLogEventActionSendMessage: 'sent a message',
  channelAdminLogEventActionStartGroupCall: 'started a video chat',
  channelAdminLogEventActionStopPoll: 'stopped a poll',
  channelAdminLogEventActionToggleAntiSpam: 'changed anti-spam settings',
  channelAdminLogEventActionToggleAutotranslation: 'changed automatic translation',
  channelAdminLogEventActionToggleForum: 'changed topics settings',
  channelAdminLogEventActionToggleGroupCallSetting: 'changed video chat permissions',
  channelAdminLogEventActionToggleInvites: 'changed invitation permissions',
  channelAdminLogEventActionToggleNoForwards: 'changed content protection',
  channelAdminLogEventActionTogglePreHistoryHidden: 'changed history visibility',
  channelAdminLogEventActionToggleSignatureProfiles: 'changed signature profiles',
  channelAdminLogEventActionToggleSignatures: 'changed message signatures',
  channelAdminLogEventActionToggleSlowMode: 'changed slow mode',
  channelAdminLogEventActionUpdatePinned: 'changed the pinned message',
};
const filterFlags: Record<
  Exclude<AdminLogFilter, 'all'>,
  Partial<Tl.ChannelAdminLogEventsFilter>
> = {
  members: {
    join: true,
    leave: true,
    invite: true,
    ban: true,
    unban: true,
    kick: true,
    unkick: true,
    subExtend: true,
    editRank: true,
  },
  admins: { promote: true, demote: true },
  settings: { info: true, settings: true },
  messages: { pinned: true, edit: true, delete: true, send: true },
  invites: { invites: true },
  calls: { groupCall: true },
  topics: { forums: true },
};
const readable = (key: string) => key.replace(/([A-Z])/g, ' $1').toLowerCase();
function messageText(message: Tl.TypeMessage) {
  if (message._ === 'messageEmpty') return 'Message unavailable';
  if (message._ === 'messageService') return 'Service message';
  return message.message || (message.media ? 'Media message' : 'Empty message');
}
function inviteText(invite: Tl.ChatInviteExported) {
  return [
    invite.title,
    invite.link,
    invite.requestNeeded ? 'Approval required' : 'No approval required',
    invite.expireDate
      ? `Expires: ${new Date(invite.expireDate * 1000).toISOString()}`
      : 'No expiration',
    invite.usageLimit ? `Usage limit: ${invite.usageLimit}` : 'Unlimited uses',
  ]
    .filter(Boolean)
    .join('\n');
}
export function mapAdminLogEvent(
  event: Tl.ChannelAdminLogEvent,
  person: (id: string) => AdminLogActor,
): AdminLogEntry {
  const action = event.action;
  const details: AdminLogEntry['details'] = [];
  const add = (label: string, text: string) => details.push({ label, text: text || 'None' });
  const scalar = (value: unknown): string | undefined =>
    typeof value === 'string'
      ? value
      : typeof value === 'boolean'
        ? value
          ? 'Enabled'
          : 'Disabled'
        : typeof value === 'number'
          ? String(value)
          : Array.isArray(value) && value.every((x) => typeof x === 'string')
            ? value.join(', ')
            : undefined;
  if ('prevValue' in action) {
    const text = scalar(action.prevValue);
    if (text !== undefined) add('Previous', text);
  }
  if ('newValue' in action) {
    const text = scalar(action.newValue);
    if (text !== undefined) add('New', text);
  }
  if (action._ === 'channelAdminLogEventActionChangeLinkedChat') {
    add('Previous chat', action.prevValue ? person(`c:${action.prevValue}`).title : 'None');
    add('Linked chat', action.newValue ? person(`c:${action.newValue}`).title : 'None');
  }
  if ('joinMuted' in action) add('New participants', action.joinMuted ? 'Muted' : 'Unmuted');
  if ('prevParticipant' in action) {
    if ('adminRights' in action.prevParticipant) {
      const rights = action.prevParticipant.adminRights;
      add(
        'Previous administrator permissions',
        adminRightKeys
          .filter((key) => rights[key])
          .map(readable)
          .join(', '),
      );
    }
    if ('bannedRights' in action.prevParticipant) {
      const rights = action.prevParticipant.bannedRights;
      add(
        'Previously restricted',
        restrictionKeys
          .filter((key) => rights[key])
          .map(readable)
          .join(', '),
      );
    }
  }
  if ('message' in action) add('Message', messageText(action.message));
  if ('prevMessage' in action) add('Previous message', messageText(action.prevMessage));
  if ('newMessage' in action) add('Edited message', messageText(action.newMessage));
  if ('topic' in action && action.topic._ === 'forumTopic') add('Topic', action.topic.title);
  if ('prevTopic' in action && action.prevTopic?._ === 'forumTopic')
    add('Previous topic', action.prevTopic.title);
  if ('newTopic' in action && action.newTopic?._ === 'forumTopic')
    add('Topic', action.newTopic.title);
  if ('invite' in action && action.invite._ === 'chatInviteExported')
    add('Invitation link', action.invite.link);
  if ('prevInvite' in action && action.prevInvite._ === 'chatInviteExported')
    add('Previous link', inviteText(action.prevInvite));
  if ('newInvite' in action && action.newInvite._ === 'chatInviteExported')
    add('Invitation link', inviteText(action.newInvite));
  if ('approvedBy' in action) add('Approved by', person(`u:${action.approvedBy}`).title);
  if ('userId' in action) add('Member', person(`u:${action.userId}`).title);
  if ('prevRank' in action) add('Previous tag', action.prevRank);
  if ('newRank' in action) add('New tag', action.newRank);
  const participant =
    'newParticipant' in action
      ? action.newParticipant
      : 'participant' in action
        ? action.participant
        : undefined;
  if (participant) {
    const id =
      'userId' in participant
        ? `u:${participant.userId}`
        : 'peer' in participant
          ? participant.peer._ === 'peerUser'
            ? `u:${participant.peer.userId}`
            : participant.peer._ === 'peerChannel'
              ? `c:${participant.peer.channelId}`
              : `g:${participant.peer.chatId}`
          : undefined;
    if (id) add('Member', person(id).title);
    if ('adminRights' in participant)
      add(
        'Administrator permissions',
        adminRightKeys
          .filter((key) => participant.adminRights[key])
          .map(readable)
          .join(', '),
      );
    else if (action._ === 'channelAdminLogEventActionParticipantToggleAdmin') add('Role', 'Member');
    if ('bannedRights' in participant) {
      add(
        'Restricted actions',
        restrictionKeys
          .filter((key) => participant.bannedRights[key])
          .map(readable)
          .join(', '),
      );
      add(
        'Until',
        participant.bannedRights.untilDate
          ? new Date(participant.bannedRights.untilDate * 1000).toISOString()
          : 'Forever',
      );
    } else if (action._ === 'channelAdminLogEventActionParticipantToggleBan')
      add('Restrictions', 'Removed');
  }
  if ('newBannedRights' in action) {
    add(
      'Previously restricted',
      restrictionKeys
        .filter((key) => action.prevBannedRights[key])
        .map(readable)
        .join(', '),
    );
    add(
      'Restricted actions',
      restrictionKeys
        .filter((key) => action.newBannedRights[key])
        .map(readable)
        .join(', '),
    );
  }
  return {
    id: event.id.toString(),
    date: event.date,
    actor: person(`u:${event.userId}`),
    action: actionNames[action._],
    details,
  };
}
export function adminLogMethods(context: {
  client: Effect.Effect<MtprotoClient, MtprotoError>;
  inputChannel(peer: TelegramPeer): Tl.TypeInputChannel;
  inputUser(peer: TelegramPeer): Tl.TypeInputUser;
  remember(users: readonly Tl.TypeUser[], chats: readonly Tl.TypeChat[]): void;
  person(id: string): AdminLogActor;
}) {
  const getAdminLog = Effect.fn('AdminLog.get')(function* (
    peer: TelegramPeer,
    request: AdminLogRequest = {},
  ): Effect.fn.Return<AdminLogPage, MtprotoError> {
    if (peer.kind !== 'channel')
      return yield* Effect.fail(
        createMtprotoError(
          'configuration',
          'Recent actions are available in supergroups and channels.',
        ),
      );
    const client = yield* context.client;
    const result = yield* client.invoke(
      Api.channels.GetAdminLog({
        channel: context.inputChannel(peer),
        q: request.query?.trim() ?? '',
        ...(request.filter && request.filter !== 'all'
          ? { eventsFilter: Api.ChannelAdminLogEventsFilter(filterFlags[request.filter]) }
          : {}),
        ...(request.actor ? { admins: [context.inputUser(request.actor)] } : {}),
        maxId: request.beforeId ? BigInt(request.beforeId) : 0n,
        minId: 0n,
        limit: 50,
      }),
    );
    context.remember(result.users, result.chats);
    return {
      events: result.events.map((event) => mapAdminLogEvent(event, (id) => context.person(id))),
      nextId: result.events.length === 50 ? result.events.at(-1)?.id.toString() : undefined,
    };
  });
  return { getAdminLog };
}
