import { expect, it } from 'vitest';
import { filterMentionMembers, findMention, shiftFormats } from './mentions';

it('matches a mention at the caret, but not emails, nested @ signs, or selections', () => {
  expect(findMention('Hi @al rest', 6)).toEqual({ offset: 3, end: 6, query: 'al' });
  expect(findMention('@', 1)?.query).toBe('');
  expect(findMention('😀\n@Zoë', 7)?.offset).toBe(3);
  expect(findMention('a@b', 3)).toBeUndefined();
  expect(findMention('@@b', 3)).toBeUndefined();
  expect(findMention('@al', 0, 3)).toBeUndefined();
});

it('matches names and usernames without case or accents and excludes self', () => {
  const member = {
    peer: { id: 'u:2', kind: 'user' as const },
    title: 'Zoë Smith',
    username: 'zoe_s',
    initials: 'ZS',
    color: 'red',
    hasAvatar: false,
  };
  for (const query of ['', 'ZOE', 'smith', 'zoe_'])
    expect(filterMentionMembers([member], query)).toEqual([member]);
  expect(filterMentionMembers([{ ...member, isSelf: true }], '')).toEqual([]);
  expect(filterMentionMembers([member], 'oe')).toEqual([]);
});

it('shifts mentions by UTF-16 offsets and removes only entities whose text changes', () => {
  const mention = { kind: 'mentionName' as const, offset: 3, length: 5, userId: 'u:2' };
  expect(shiftFormats([mention], 'Hi Alice!', '😀 Hi Alice!')).toEqual([{ ...mention, offset: 6 }]);
  expect(shiftFormats([mention], 'Hi Alice!', 'Hi Alice! More')).toEqual([mention]);
  expect(shiftFormats([mention], 'Hi Alice!', 'Hi Alce!')).toEqual([]);
  expect(shiftFormats([mention], 'Hi Alice!', 'Hi Alice!')).toEqual([mention]);
});
