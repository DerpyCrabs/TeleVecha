import type {
  TelegramPeer,
  TelegramPrivacyChange,
  TelegramPrivacyRule,
  TelegramPrivacySetting,
} from '../telegram/types';

export const privacyKeys = [
  { id: 'phone-number', label: 'Phone number', question: 'Who can see my phone number?' },
  {
    id: 'added-by-phone',
    label: 'Find me by phone number',
    question: 'Who can find me by my number?',
  },
  { id: 'last-seen', label: 'Last seen & online', question: 'Who can see my last seen time?' },
  { id: 'profile-photo', label: 'Profile photos', question: 'Who can see my profile photos?' },
  { id: 'about', label: 'Bio', question: 'Who can see my bio?' },
  { id: 'birthday', label: 'Birthday', question: 'Who can see my birthday?' },
  {
    id: 'forwards',
    label: 'Forwarded messages',
    question: 'Who can link to my account when forwarding my messages?',
  },
  { id: 'calls', label: 'Calls', question: 'Who can call me?' },
  { id: 'p2p', label: 'Peer-to-peer calls', question: 'Who can connect directly during calls?' },
  { id: 'invites', label: 'Groups & channels', question: 'Who can add me to groups and channels?' },
  {
    id: 'voice-messages',
    label: 'Voice & video messages',
    question: 'Who can send me voice and video messages?',
  },
  { id: 'saved-music', label: 'Music', question: 'Who can see music on my profile?' },
] as const;
export function privacyAudience(rules: readonly TelegramPrivacyRule[]) {
  if (rules.some((rule) => rule.kind === 'deny-contacts' || rule.kind === 'unsupported'))
    return 'custom';
  for (const rule of rules) {
    if (rule.kind === 'allow-all') return 'everyone';
    if (rule.kind === 'allow-contacts') return 'contacts';
    if (rule.kind === 'deny-all') return 'nobody';
  }
  return 'custom';
}
export function privacyExceptions(setting: TelegramPrivacySetting) {
  return setting.rules.flatMap((rule) =>
    rule.kind === 'allow-users' || rule.kind === 'deny-users'
      ? rule.users.map((peer) => ({ id: peer.id, peer, allow: rule.kind === 'allow-users' }))
      : rule.kind === 'allow-chats' || rule.kind === 'deny-chats'
        ? rule.chats.map((id) => ({
            id: `chat:${id}`,
            peer: setting.peers.find(
              (person) => person.peer.kind !== 'user' && person.peer.id.slice(2) === id,
            )?.peer ?? { id: `g:${id}`, kind: 'group' as const },
            allow: rule.kind === 'allow-chats',
          }))
        : [],
  );
}
export function changePrivacyRules(
  rules: readonly TelegramPrivacyRule[],
  change: TelegramPrivacyChange,
): TelegramPrivacyRule[] {
  if (rules.some((rule) => rule.kind === 'unsupported'))
    throw new Error('These privacy rules are not supported yet. They have been kept unchanged.');
  let next: TelegramPrivacyRule[] = rules.map((rule) => ({ ...rule }));
  if (change.audience) {
    next = next.filter(
      (rule) => !['allow-all', 'allow-contacts', 'deny-all', 'deny-contacts'].includes(rule.kind),
    );
    next.push(
      ...(change.audience === 'everyone'
        ? [{ kind: 'allow-all' } as const]
        : change.audience === 'contacts'
          ? [{ kind: 'allow-contacts' } as const, { kind: 'deny-all' } as const]
          : [{ kind: 'deny-all' } as const]),
    );
  }
  for (const edit of change.exceptions ?? []) {
    const user = edit.peer.kind === 'user',
      id = edit.peer.id.slice(2);
    next = next.flatMap((rule) => {
      if (user && (rule.kind === 'allow-users' || rule.kind === 'deny-users'))
        return [{ ...rule, users: rule.users.filter((peer) => peer.id !== edit.peer.id) }];
      if (!user && (rule.kind === 'allow-chats' || rule.kind === 'deny-chats'))
        return [{ ...rule, chats: rule.chats.filter((chat) => chat !== id) }];
      return [rule];
    });
    if (!edit.remove)
      next.unshift(
        user
          ? { kind: edit.allow ? 'allow-users' : 'deny-users', users: [edit.peer] }
          : { kind: edit.allow ? 'allow-chats' : 'deny-chats', chats: [id] },
      );
  }
  return next.filter((rule) =>
    'users' in rule ? rule.users.length > 0 : 'chats' in rule ? rule.chats.length > 0 : true,
  );
}
export function exceptionLabel(peer: TelegramPeer, setting: TelegramPrivacySetting) {
  return (
    setting.peers.find((person) => person.peer.id === peer.id)?.title ??
    (peer.kind === 'user' ? 'User' : 'Group')
  );
}
