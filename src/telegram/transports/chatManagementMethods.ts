import { adminRightKeys, restrictionKeys } from '../chatManagement';
import { Effect } from 'effect';
import type { MtprotoClient } from '../mtproto';
import { createMtprotoError, type MtprotoError } from '../mtproto/errors';
import { Api, type Tl } from '../mtproto/tl';
import type { ChatManagementSettings, ChatSettingChange } from '../chatManagement';
import type { TelegramPeer } from '../types';
export function chatManagementMethods(context: {
  client: Effect.Effect<MtprotoClient, MtprotoError>;
  inputPeer(peer: TelegramPeer): Tl.TypeInputPeer;
  inputChannel(peer: TelegramPeer): Tl.TypeInputChannel;
  remember(users: readonly Tl.TypeUser[], chats: readonly Tl.TypeChat[]): void;
}) {
  const getChatManagement = Effect.fn('ChatManagement.get')(function* (
    peer: TelegramPeer,
  ): Effect.fn.Return<ChatManagementSettings, MtprotoError> {
    if (peer.kind === 'user')
      return yield* Effect.fail(createMtprotoError('configuration', 'Choose a group or channel.'));
    const client = yield* context.client;
    const result =
      peer.kind === 'channel'
        ? yield* client.invoke(Api.channels.GetFullChannel({ channel: context.inputChannel(peer) }))
        : yield* client.invoke(Api.messages.GetFullChat({ chatId: BigInt(peer.id.slice(2)) }));
    context.remember(result.users, result.chats);
    const entity = result.chats.find((chat) => chat.id === BigInt(peer.id.slice(2)));
    if (!Api.Channel.is(entity) && !Api.Chat.is(entity))
      return yield* Effect.fail(createMtprotoError('rpc', 'This chat is no longer available.'));
    const full = result.fullChat;
    const owner = Boolean(entity.creator);
    const rights = entity.adminRights;
    const channel = Api.Channel.is(entity) ? entity : undefined;
    return {
      migratedFrom:
        Api.ChannelFull.is(full) && full.migratedFromChatId
          ? { id: `g:${full.migratedFromChatId}`, kind: 'group' as const }
          : undefined,
      migratedTo:
        Api.Chat.is(entity) && Api.InputChannel.is(entity.migratedTo)
          ? {
              id: `c:${entity.migratedTo.channelId}`,
              kind: 'channel' as const,
              accessHash: entity.migratedTo.accessHash.toString(),
            }
          : undefined,
      grantableAdminRights: Object.fromEntries(
        adminRightKeys.map((key) => [key, owner || Boolean(rights?.[key])]),
      ),
      defaultRestrictions: Object.fromEntries(
        restrictionKeys.map((key) => [key, Boolean(entity.defaultBannedRights?.[key])]),
      ),
      title: entity.title,
      about: full.about,
      username: channel?.username ?? '',
      broadcast: Boolean(channel?.broadcast),
      forum: Boolean(channel?.forum),
      protectedContent: Boolean(entity.noforwards),
      hiddenHistory: Api.ChannelFull.is(full) && Boolean(full.hiddenPrehistory),
      slowModeSeconds: Api.ChannelFull.is(full) ? (full.slowmodeSeconds ?? 0) : 0,
      rights: {
        changeInfo:
          owner ||
          Boolean(rights?.changeInfo) ||
          (!channel?.broadcast &&
            !entity.left &&
            !entity.defaultBannedRights?.changeInfo &&
            !channel?.bannedRights?.changeInfo),
        changeType: owner,
        manageInvites: owner || Boolean(rights?.inviteUsers),
        manageAdmins: owner || Boolean(rights?.addAdmins),
        restrictMembers: owner || Boolean(rights?.banUsers),
        manageTopics: owner || Boolean(rights?.manageTopics),
        viewLog: Boolean(channel && (owner || rights)),
      },
    };
  });
  const upgradeChat = Effect.fn('ChatManagement.upgrade')(function* (peer: TelegramPeer) {
    if (peer.kind !== 'group')
      return yield* Effect.fail(createMtprotoError('configuration', 'Choose a basic group.'));
    const client = yield* context.client;
    const chatId = BigInt(peer.id.slice(2));
    const existing = yield* client.invoke(Api.messages.GetFullChat({ chatId }));
    context.remember(existing.users, existing.chats);
    const old = existing.chats.find((chat) => Api.Chat.is(chat) && chat.id === chatId);
    const migrated = Api.Chat.is(old) ? old.migratedTo : undefined;
    if (Api.InputChannel.is(migrated))
      return {
        peer: {
          id: `c:${migrated.channelId}`,
          kind: 'channel' as const,
          accessHash: migrated.accessHash.toString(),
        },
        title: Api.Chat.is(old) ? old.title : 'Group',
        updates: undefined,
      };
    const updates = yield* client.invoke(Api.messages.MigrateChat({ chatId }));
    if (Api.Updates.is(updates) || Api.UpdatesCombined.is(updates))
      context.remember(updates.users, updates.chats);
    // Read the migration pointer, including when the server returned updatesTooLong.
    const full = yield* client.invoke(Api.messages.GetFullChat({ chatId }));
    context.remember(full.users, full.chats);
    const chat = full.chats.find((chat) => Api.Chat.is(chat) && chat.id === chatId);
    const target = Api.Chat.is(chat) ? chat.migratedTo : undefined;
    if (!Api.Chat.is(chat) || !Api.InputChannel.is(target))
      return yield* Effect.fail(
        createMtprotoError(
          'protocol',
          'The group was upgraded but its new address is not available yet. Open the group again.',
        ),
      );
    return {
      peer: {
        id: `c:${target.channelId}`,
        kind: 'channel' as const,
        accessHash: target.accessHash.toString(),
      },
      title: chat.title,
      updates,
    };
  });
  const setChatSetting = Effect.fn('ChatManagement.set')(function* (
    peer: TelegramPeer,
    change: ChatSettingChange,
  ) {
    const client = yield* context.client;
    if (peer.kind === 'user')
      return yield* Effect.fail(createMtprotoError('configuration', 'Choose a group or channel.'));
    if (change.kind === 'title')
      return peer.kind === 'channel'
        ? yield* client.invoke(
            Api.channels.EditTitle({ channel: context.inputChannel(peer), title: change.value }),
          )
        : yield* client.invoke(
            Api.messages.EditChatTitle({ chatId: BigInt(peer.id.slice(2)), title: change.value }),
          );
    if (change.kind === 'about') {
      const saved = yield* client.invoke(
        Api.messages.EditChatAbout({ peer: context.inputPeer(peer), about: change.value }),
      );
      if (!saved)
        return yield* Effect.fail(
          createMtprotoError('rpc', 'The description could not be changed.'),
        );
      return undefined;
    }
    if (change.kind === 'defaultRestrictions')
      return yield* client.invoke(
        Api.messages.EditChatDefaultBannedRights({
          peer: context.inputPeer(peer),
          bannedRights: Api.ChatBannedRights({
            ...Object.fromEntries(
              restrictionKeys
                .filter((key) => key !== 'viewMessages' && change.value[key])
                .map((key) => [key, true]),
            ),
            untilDate: 0,
          }),
        }),
      );
    if (change.kind === 'protectedContent')
      return yield* client.invoke(
        Api.messages.ToggleNoForwards({ peer: context.inputPeer(peer), enabled: change.value }),
      );
    if (peer.kind !== 'channel')
      return yield* Effect.fail(
        createMtprotoError('configuration', 'This setting requires a supergroup or channel.'),
      );
    const channel = context.inputChannel(peer);
    if (change.kind === 'username') {
      const saved = yield* client.invoke(
        Api.channels.UpdateUsername({ channel, username: change.value }),
      );
      if (!saved)
        return yield* Effect.fail(
          createMtprotoError('rpc', 'The public link could not be changed.'),
        );
      return undefined;
    }
    if (change.kind === 'forum')
      return yield* client.invoke(
        Api.channels.ToggleForum({ channel, enabled: change.value, tabs: false }),
      );
    if (change.kind === 'hiddenHistory')
      return yield* client.invoke(
        Api.channels.TogglePreHistoryHidden({ channel, enabled: change.value }),
      );
    if (change.kind === 'slowModeSeconds')
      return yield* client.invoke(Api.channels.ToggleSlowMode({ channel, seconds: change.value }));
    return yield* Effect.fail(createMtprotoError('configuration', 'Unknown chat setting.'));
  });
  return { getChatManagement, setChatSetting, upgradeChat };
}
