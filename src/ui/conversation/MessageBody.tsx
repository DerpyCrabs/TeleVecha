import { list } from 'effectweb';
import type { Effect } from 'effect';
import type { ChatMessage } from '../../domain/models';
import { component, sequence, view, type Source } from 'effectweb';
import type * as AsyncResult from 'effect/reactivity/AsyncResult';
import { safeExternalUrl } from '../shared/safeUrl';
import { LinkPreview } from './LinkPreview';
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
  const ranges: Array<{ offset: number; length: number; kind: 'mention' | 'link'; url?: string }> =
    [
      ...(message.mentions ?? []).map(({ offset, length, userId }) => ({
        offset,
        length,
        kind: 'mention' as const,
        ...(userId ? { url: `tg://user?id=${userId.slice(2)}` } : {}),
      })),
      ...(message.formats ?? []).flatMap((format) =>
        format.kind === 'mention' || format.kind === 'mentionName'
          ? [
              {
                offset: format.offset,
                length: format.length,
                kind: 'mention' as const,
                ...(format.userId ? { url: `tg://user?id=${format.userId.slice(2)}` } : {}),
              },
            ]
          : [],
      ),
      ...(message.links ?? []).map(({ offset, length, url }) => ({
        offset,
        length,
        kind: 'link' as const,
        ...(url ? { url } : {}),
      })),
    ];
  for (const match of message.body.matchAll(
    /(?:https?:\/\/|tg:\/\/|(?:t\.me|telegram\.me|telegram\.dog)\/)[^\s]+/giu,
  )) {
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
        ...(semantic?.url ? { url: semantic.url } : semantic?.kind === 'link' ? { url: text } : {}),
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
type PartState = { spoilerRevealed: boolean; quoteExpanded: boolean };
type PartMessage =
  | { type: 'SpoilerRevealed'; value: boolean }
  | { type: 'QuoteExpanded'; value: boolean };
const Part = component<{ part: TextPart }, PartState, PartMessage>(
  {
    init: () => ({ spoilerRevealed: false, quoteExpanded: false }),
    update: (model, message) => {
      switch (message.type) {
        case 'SpoilerRevealed':
          return { model: { ...model, spoilerRevealed: message.value } };
        case 'QuoteExpanded':
          return { model: { ...model, quoteExpanded: message.value } };
      }
    },
  },
  view((model, send) => {
    const props = model.props;
    const isSpoiler = () => props.part.formats.has('spoiler');
    const isExpandableQuote = () => props.part.formats.has('expandableBlockquote');
    const activateHidden = (event: MouseEvent | KeyboardEvent) => {
      if (isSpoiler() && !model.spoilerRevealed) {
        event.preventDefault();
        event.stopPropagation();
        send({ type: 'SpoilerRevealed', value: true });
        return true;
      }
      if (!isExpandableQuote()) return false;
      event.preventDefault();
      event.stopPropagation();
      send({ type: 'QuoteExpanded', value: ((expanded) => !expanded)(model.quoteExpanded) });
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
          expanded: model.quoteExpanded,
          'custom-emoji': props.part.formats.has('customEmoji'),
          'formatted-date': props.part.formats.has('formattedDate'),
          'diff-insert': props.part.formats.has('diffInsert'),
          'diff-replace': props.part.formats.has('diffReplace'),
          'diff-delete': props.part.formats.has('diffDelete'),
          spoiler: isSpoiler(),
          revealed: model.spoilerRevealed,
        }}
        role={interactive && (isSpoiler() || isExpandableQuote()) ? 'button' : undefined}
        aria-expanded={
          interactive
            ? isSpoiler()
              ? model.spoilerRevealed
              : isExpandableQuote()
                ? model.quoteExpanded
                : undefined
            : undefined
        }
        aria-label={
          interactive && isSpoiler()
            ? model.spoilerRevealed
              ? `Revealed spoiler: ${props.part.text}`
              : 'Hidden spoiler. Activate to reveal.'
            : interactive && isExpandableQuote()
              ? model.quoteExpanded
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
    return (props.part.kind === 'link' || props.part.kind === 'mention') && href() ? (
      <a
        href={href()}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={
          isSpoiler() && !model.spoilerRevealed
            ? 'Hidden spoiler link. Activate to reveal.'
            : undefined
        }
        onClick={activateHidden}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') activateHidden(event);
        }}
      >
        {content(false)}
      </a>
    ) : (
      content(true)
    );
  }),
);
export const MessageBody = view<
  {
    message: ChatMessage;
    previewPhoto?: Source<AsyncResult.AsyncResult<string | undefined, never>> | undefined;
    loadPreviewMedia?: (() => Effect.Effect<string, unknown>) | undefined;
  },
  never
>((props, _send) => {
  return (
    <>
      {props.message.richMessage ? (
        ((rich) => <RichMessageBody blocks={rich.blocks} rtl={rich.rtl} />)(
          props.message.richMessage!,
        )
      ) : (
        <p class="message-body">
          {list(sequence(textParts(props.message)), (part) => (
            <Part part={part} />
          ))}
        </p>
      )}
      {props.message.linkPreview
        ? ((preview) => (
            <LinkPreview
              preview={preview}
              photo={props.previewPhoto}
              loadMedia={props.loadPreviewMedia}
            />
          ))(props.message.linkPreview!)
        : null}
    </>
  );
});
