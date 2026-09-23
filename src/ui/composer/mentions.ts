import type { TelegramGroupMember, TelegramTextFormat } from '../../telegram/types';

export function findMention(text: string, start: number, end = start) {
  if (start !== end) return undefined;
  const match = text.slice(0, start).match(/(?:^|\s)@([^\s@]*)$/u);
  if (!match) return undefined;
  return { offset: start - match[1]!.length - 1, end: start, query: match[1]! };
}

export function filterMentionMembers(members: readonly TelegramGroupMember[], query: string) {
  const normalized = query.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  return members.filter(
    (member) =>
      !member.isSelf &&
      [member.username ?? '', ...member.title.split(/\s+/u)].some((name) =>
        name.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().startsWith(normalized),
      ),
  );
}

/** Keep unaffected entities and shift their UTF-16 offsets when text is edited. */
export function shiftFormats(
  formats: readonly TelegramTextFormat[],
  before: string,
  after: string,
): TelegramTextFormat[] {
  if (before === after) return [...formats];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return formats.flatMap((format) => {
    if (format.offset + format.length <= start) return [format];
    if (format.offset >= oldEnd) return [{ ...format, offset: format.offset + newEnd - oldEnd }];
    return [];
  });
}
