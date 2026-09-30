import { list } from 'effectweb';
import { sequence, view } from 'effectweb';
import { safeExternalUrl } from './safeUrl';
interface TextPart {
  text: string;
  href?: string | undefined;
}
const LINK_PATTERN =
  /(?:https?:\/\/|tg:\/\/|(?:t\.me|telegram\.me|telegram\.dog)\/|www\.)[^\s]+|[\w.%+-]+@[\w.-]+\.[a-z]{2,}|@[a-z][\w]{3,31}/giu;
export function linkifyText(value: string): TextPart[] {
  const parts: TextPart[] = [];
  let offset = 0;
  for (const match of value.matchAll(LINK_PATTERN)) {
    const start = match.index;
    if (start > offset) parts.push({ text: value.slice(offset, start) });
    const raw = match[0];
    const text = raw.replace(/[),.!?:;]+$/u, '');
    const suffix = raw.slice(text.length);
    const target = text.startsWith('@')
      ? `https://t.me/${text.slice(1)}`
      : text.startsWith('www.')
        ? `https://${text}`
        : text.includes('@') && !text.includes('://')
          ? `mailto:${text}`
          : text;
    const href = safeExternalUrl(target);
    parts.push({ text, ...(href ? { href } : {}) });
    if (suffix) parts.push({ text: suffix });
    offset = start + raw.length;
  }
  if (offset < value.length) parts.push({ text: value.slice(offset) });
  return parts;
}
export const AutoLinkText = view<{ text: string }, never>((props, _send) => {
  return (
    <span class="autolink-text">
      {list(sequence(linkifyText(props.text)), (part) =>
        part.href ? (
          <a href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </span>
  );
});
