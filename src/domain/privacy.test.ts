import { describe, expect, it } from 'vitest';
import { changePrivacyRules, privacyAudience, privacyExceptions } from './privacy';
import type { TelegramPrivacyRule } from '../telegram/types';

const alice = { id: 'u:101', kind: 'user' as const, accessHash: '9223372036854775806' };
const bob = { id: 'u:102', kind: 'user' as const };
describe('privacy rule edits', () => {
  it('changes the default audience while preserving special rules and exceptions', () => {
    const rules: TelegramPrivacyRule[] = [
      { kind: 'deny-users', users: [alice] },
      { kind: 'allow-chats', chats: ['9223372036854775806'] },
      { kind: 'allow-premium' },
      { kind: 'deny-bots' },
      { kind: 'allow-all' },
    ];
    const next = changePrivacyRules(rules, { audience: 'contacts' });
    expect(next).toEqual([...rules.slice(0, 4), { kind: 'allow-contacts' }, { kind: 'deny-all' }]);
    expect(privacyAudience(next)).toBe('contacts');
    expect(rules.at(-1)).toEqual({ kind: 'allow-all' });
  });
  it('moves a person between exceptions without dropping unrelated users or changing the audience', () => {
    const next = changePrivacyRules(
      [{ kind: 'deny-users', users: [alice, bob] }, { kind: 'deny-all' }],
      { exceptions: [{ peer: alice, allow: true }] },
    );
    expect(next).toEqual([
      { kind: 'allow-users', users: [alice] },
      { kind: 'deny-users', users: [bob] },
      { kind: 'deny-all' },
    ]);
    expect(
      changePrivacyRules(next, { exceptions: [{ peer: alice, allow: true, remove: true }] }),
    ).toEqual([{ kind: 'deny-users', users: [bob] }, { kind: 'deny-all' }]);
  });
  it('uses raw group ids without numeric precision loss and removes empty exception rules', () => {
    const peer = { id: 'c:9223372036854775806', kind: 'channel' as const };
    const rules = changePrivacyRules([{ kind: 'allow-all' }], {
      exceptions: [{ peer, allow: false }],
    });
    expect(rules[0]).toEqual({ kind: 'deny-chats', chats: ['9223372036854775806'] });
    expect(privacyExceptions({ key: 'calls', rules, peers: [] })[0]?.id).toBe(
      'chat:9223372036854775806',
    );
    expect(
      changePrivacyRules(rules, { exceptions: [{ peer, allow: false, remove: true }] }),
    ).toEqual([{ kind: 'allow-all' }]);
  });
  it('refuses to rewrite unknown rules', () => {
    expect(privacyAudience([{ kind: 'unsupported' }])).toBe('custom');
    expect(() => changePrivacyRules([{ kind: 'unsupported' }], { audience: 'everyone' })).toThrow(
      'unchanged',
    );
  });
});
