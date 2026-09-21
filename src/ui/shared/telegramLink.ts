export interface TelegramLinkTarget {
  username?: string;
  peerId?: string;
  messageId?: number;
  commentId?: number;
}

const reserved = new Set([
  'addlist',
  'addstickers',
  'addemoji',
  'addtheme',
  'bg',
  'boost',
  'confirmphone',
  'contact',
  'giftcode',
  'invoice',
  'joinchat',
  'login',
  'm',
  'nft',
  'proxy',
  'setlanguage',
  'share',
  'socks',
  'stars',
  'boosts',
  'iv',
]);
const positiveId = (value: string | null | undefined) =>
  value && /^[1-9]\d*$/u.test(value) && Number(value) <= 2147483647 ? Number(value) : undefined;

/** Recognize chat/post links only; unrelated Telegram actions keep their normal URL behavior. */
export function parseTelegramLink(value: string): TelegramLinkTarget | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.port) return undefined;
  let username: string | undefined;
  let peerId: string | undefined;
  let post: string | null | undefined;
  if (url.protocol === 'tg:' && url.hostname === 'resolve') {
    if (
      [...url.searchParams.keys()].some(
        (key) => !['domain', 'post', 'comment', 'single'].includes(key),
      )
    )
      return undefined;
    username = url.searchParams.get('domain') ?? undefined;
    post = url.searchParams.get('post');
  } else {
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      ![
        't.me',
        'www.t.me',
        'telegram.me',
        'www.telegram.me',
        'telegram.dog',
        'www.telegram.dog',
      ].includes(url.hostname)
    )
      return undefined;
    if ([...url.searchParams.keys()].some((key) => !['comment', 'single'].includes(key)))
      return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 's') parts.shift();
    if (parts[0] === 'c') {
      if (parts.length !== 3 || !/^[1-9]\d*$/u.test(parts[1] ?? '')) return undefined;
      peerId = `c:${parts[1]}`;
      post = parts[2];
    } else {
      if (parts.length < 1 || parts.length > 2) return undefined;
      [username, post] = parts;
    }
  }
  if (
    username &&
    (!/^[a-z][a-z0-9_]{3,31}$/iu.test(username) || reserved.has(username.toLowerCase()))
  )
    return undefined;
  if (!username && !peerId) return undefined;
  const messageId = positiveId(post);
  const comment = url.searchParams.get('comment');
  const commentId = positiveId(comment);
  if ((post && !messageId) || (comment !== null && (!commentId || !messageId))) return undefined;
  return {
    ...(username ? { username } : { peerId: peerId! }),
    ...(messageId ? { messageId } : {}),
    ...(commentId ? { commentId } : {}),
  };
}
