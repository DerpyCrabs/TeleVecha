export interface MiniAppLink {
  shortName?: string;
  startParam?: string;
  mode?: 'compact' | 'fullscreen';
}
export interface TelegramLinkTarget {
  stickerPack?: string;
  webApp?: MiniAppLink;
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

/** Recognize supported Telegram actions; unrelated URLs retain their normal behavior. */
export function parseTelegramLink(value: string): TelegramLinkTarget | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.port) return undefined;
  const stickerPack = parseStickerPackLink(value);
  if (stickerPack) return { stickerPack };
  const miniApp = parseMiniAppLink(url);
  if (miniApp) return miniApp;
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

function parseMiniAppLink(url: URL): TelegramLinkTarget | undefined {
  let username: string | undefined, shortName: string | undefined;
  if (url.protocol === 'tg:' && url.hostname === 'resolve') {
    username = url.searchParams.get('domain') ?? undefined;
    shortName = url.searchParams.get('appname') ?? undefined;
    if (!shortName && !url.searchParams.has('startapp')) return undefined;
    if (
      [...url.searchParams.keys()].some(
        (key) => !['domain', 'appname', 'startapp', 'mode'].includes(key),
      )
    )
      return undefined;
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
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 1 || parts.length > 2) return undefined;
    [username, shortName] = parts;
    if (shortName && /^\d+$/.test(shortName)) return undefined;
    if (!shortName && !url.searchParams.has('startapp')) return undefined;
    if ([...url.searchParams.keys()].some((key) => !['startapp', 'mode'].includes(key)))
      return undefined;
  }
  if (
    !username ||
    !/^[a-z][a-z0-9_]{3,31}$/i.test(username) ||
    reserved.has(username.toLowerCase())
  )
    return undefined;
  if (shortName && !/^[a-z0-9_]{1,64}$/i.test(shortName)) return undefined;
  for (const key of url.searchParams.keys())
    if (url.searchParams.getAll(key).length !== 1) return undefined;
  const startParam = url.searchParams.get('startapp');
  if (startParam !== null && !/^[a-z0-9_-]{0,512}$/i.test(startParam)) return undefined;
  const mode = url.searchParams.get('mode');
  if (mode !== null && mode !== 'compact' && mode !== 'fullscreen') return undefined;
  return {
    username,
    webApp: {
      ...(shortName ? { shortName } : {}),
      ...(startParam !== null ? { startParam } : {}),
      ...(mode ? { mode } : {}),
    },
  };
}

/** A pack reference only, never an external host or a similarly named Telegram action. */
export function parseStickerPackLink(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.port || url.hash) return undefined;
  let name: string | undefined;
  if (url.protocol === 'tg:' && url.hostname === 'addstickers') {
    if (url.pathname && url.pathname !== '/') return undefined;
    if (
      [...url.searchParams.keys()].some((key) => key !== 'set') ||
      url.searchParams.getAll('set').length !== 1
    )
      return undefined;
    name = url.searchParams.get('set') ?? undefined;
  } else if (
    ['https:', 'http:'].includes(url.protocol) &&
    [
      't.me',
      'www.t.me',
      'telegram.me',
      'www.telegram.me',
      'telegram.dog',
      'www.telegram.dog',
    ].includes(url.hostname)
  ) {
    if (url.search) return undefined;
    name = /^\/addstickers\/([a-zA-Z0-9_]{1,64})\/?$/.exec(url.pathname)?.[1];
  }
  return name && /^[a-zA-Z0-9_]{1,64}$/.test(name) ? name : undefined;
}
