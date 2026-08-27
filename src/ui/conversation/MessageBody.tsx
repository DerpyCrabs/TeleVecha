import { For, Show, createSignal } from 'solid-js';

import type { ChatMessage } from '../../domain/models';
import { LinkPreview } from './LinkPreview';
import { safeExternalUrl } from '../shared/safeUrl';
import { RichMessageBody } from './RichMessageBody';

interface TextPart {
  text: string;
  kind: 'text' | 'mention' | 'link';
  url?: string;
  formats: Set<string>;
  formatData: Map<
    string,
    {
      customEmojiId?: string | undefined;
      timestamp?: number | undefined;
      oldText?: string | undefined;
    }
  >;
}

function textParts(message: ChatMessage): TextPart[] {
  const ranges: Array<{
    offset: number;
    length: number;
    kind: 'mention' | 'link';
    url?: string;
  }> = [
    ...(message.mentions ?? []).map(({ offset, length }) => ({
      offset,
      length,
      kind: 'mention' as const,
    })),
    ...(message.links ?? []).map(({ offset, length, url }) => ({
      offset,
      length,
      kind: 'link' as const,
      ...(url ? { url } : {}),
    })),
  ];
  for (const match of message.body.matchAll(/https?:\/\/[^\s]+/gu)) {
    const offset = match.index;
    const text = match[0].replace(/[),.!?]+$/u, '');
    const overlaps = ranges.some(
      (range) => offset < range.offset + range.length && offset + text.length > range.offset,
    );
    if (!overlaps) ranges.push({ offset, length: text.length, kind: 'link', url: text });
  }

  const boundaries = new Set([0, message.body.length]);
  for (const range of [...ranges, ...(message.formats ?? [])]) {
    boundaries.add(Math.max(0, Math.min(message.body.length, range.offset)));
    boundaries.add(Math.max(0, Math.min(message.body.length, range.offset + range.length)));
  }
  const sorted = [...boundaries].sort((left, right) => left - right);
  return sorted.slice(0, -1).flatMap((start, index) => {
    const end = sorted[index + 1] ?? start;
    if (end <= start) return [];
    const semantic = ranges.find(
      (range) => start >= range.offset && start < range.offset + range.length,
    );
    const text = message.body.slice(start, end);
    return [
      {
        text,
        kind: semantic?.kind ?? 'text',
        ...(semantic?.kind === 'link' ? { url: semantic.url || text } : {}),
        formats: new Set(
          (message.formats ?? [])
            .filter((format) => start >= format.offset && start < format.offset + format.length)
            .map(({ kind }) => kind),
        ),
        formatData: new Map(
          (message.formats ?? [])
            .filter((format) => start >= format.offset && start < format.offset + format.length)
            .map(({ kind, customEmojiId, timestamp, oldText }) => [
              kind,
              { customEmojiId, timestamp, oldText },
            ]),
        ),
      },
    ];
  });
}

function Part(props: { part: TextPart }) {
  const [spoilerRevealed, setSpoilerRevealed] = createSignal(false);
  const [quoteExpanded, setQuoteExpanded] = createSignal(false);
  const isSpoiler = () => props.part.formats.has('spoiler');
  const isExpandableQuote = () => props.part.formats.has('expandableBlockquote');
  const activateHidden = (event: MouseEvent | KeyboardEvent) => {
    if (isSpoiler() && !spoilerRevealed()) {
      event.preventDefault();
      event.stopPropagation();
      setSpoilerRevealed(true);
      return true;
    }
    if (!isExpandableQuote()) return false;
    event.preventDefault();
    event.stopPropagation();
    setQuoteExpanded((expanded) => !expanded);
    return true;
  };
  const formattedDateTitle = () => {
    const timestamp = props.part.formatData.get('formattedDate')?.timestamp;
    return timestamp
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(
          new Date(timestamp * 1000),
        )
      : undefined;
  };
  const content = (interactive: boolean) => (
    <span
      classList={{
        mention: props.part.kind === 'mention',
        bold: props.part.formats.has('bold'),
        italic: props.part.formats.has('italic'),
        underline: props.part.formats.has('underline'),
        strike: props.part.formats.has('strike'),
        code: props.part.formats.has('code'),
        pre: props.part.formats.has('pre'),
        blockquote: props.part.formats.has('blockquote'),
        'expandable-blockquote': props.part.formats.has('expandableBlockquote'),
        expanded: quoteExpanded(),
        'custom-emoji': props.part.formats.has('customEmoji'),
        'formatted-date': props.part.formats.has('formattedDate'),
        'diff-insert': props.part.formats.has('diffInsert'),
        'diff-replace': props.part.formats.has('diffReplace'),
        'diff-delete': props.part.formats.has('diffDelete'),
        spoiler: isSpoiler(),
        revealed: spoilerRevealed(),
      }}
      role={interactive && (isSpoiler() || isExpandableQuote()) ? 'button' : undefined}
      aria-expanded={
        interactive
          ? isSpoiler()
            ? spoilerRevealed()
            : isExpandableQuote()
              ? quoteExpanded()
              : undefined
          : undefined
      }
      aria-label={
        interactive && isSpoiler()
          ? spoilerRevealed()
            ? `Revealed spoiler: ${props.part.text}`
            : 'Hidden spoiler. Activate to reveal.'
          : interactive && isExpandableQuote()
            ? quoteExpanded()
              ? 'Collapse quote'
              : 'Expand quote'
            : undefined
      }
      title={formattedDateTitle() ?? props.part.formatData.get('diffReplace')?.oldText}
      data-document-id={props.part.formatData.get('customEmoji')?.customEmojiId}
      tabIndex={interactive && (isSpoiler() || isExpandableQuote()) ? 0 : undefined}
      onClick={(event) => interactive && activateHidden(event)}
      onKeyDown={(event) => {
        if (interactive && (event.key === 'Enter' || event.key === ' ')) activateHidden(event);
      }}
    >
      {props.part.text}
    </span>
  );
  const href = () =>
    safeExternalUrl(
      props.part.url ??
        (props.part.kind === 'mention' && /^@[\p{L}\p{N}_]+$/u.test(props.part.text)
          ? `https://t.me/${props.part.text.slice(1)}`
          : undefined),
    );
  return (
    <Show
      when={(props.part.kind === 'link' || props.part.kind === 'mention') && href()}
      fallback={content(true)}
    >
      <a
        href={href()}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={
          isSpoiler() && !spoilerRevealed() ? 'Hidden spoiler link. Activate to reveal.' : undefined
        }
        onClick={activateHidden}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') activateHidden(event);
        }}
      >
        {content(false)}
      </a>
    </Show>
  );
}

export function MessageBody(props: {
  message: ChatMessage;
  loadPreviewPhoto?: (() => Promise<string>) | undefined;
}) {
  return (
    <>
      <Show
        when={props.message.richMessage}
        fallback={
          <p class="message-body">
            <For each={textParts(props.message)}>{(part) => <Part part={part} />}</For>
          </p>
        }
      >
        {(rich) => <RichMessageBody blocks={rich().blocks} rtl={rich().rtl} />}
      </Show>
      <Show when={props.message.linkPreview}>
        {(preview) => <LinkPreview preview={preview()} loadPhoto={props.loadPreviewPhoto} />}
      </Show>
    </>
  );
}
