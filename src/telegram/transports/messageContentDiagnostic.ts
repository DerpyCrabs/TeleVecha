import { Api, descriptorFor, LAYER, type Tl } from '../mtproto/tl';
import type { TelegramMessage } from '../types';
import type { MessageContentDiagnostic } from '../core/messageContentDiagnostic';

const constructorId = (value: { readonly _: string } | undefined) =>
  value ? descriptorFor(value._)?.id : undefined;

export function describeMessageContent(
  source: Tl.Message,
  mapped: TelegramMessage,
): MessageContentDiagnostic {
  const document = Api.MessageMediaDocument.is(source.media) ? source.media.document : undefined;
  const rich = source.richMessage;
  const mappedRichBlocks = mapped.richMessage?.blocks.length ?? 0;
  const hasContent = Boolean(
    mapped.text ||
    mapped.media ||
    mapped.contact ||
    mapped.poll ||
    mapped.linkPreview ||
    mappedRichBlocks,
  );
  return {
    layer: LAYER,
    messageConstructor: constructorId(source)!,
    mediaConstructor: constructorId(source.media),
    documentConstructor: constructorId(document),
    documentAttributes: Api.Document.is(document)
      ? [...new Set(document.attributes.map((attribute) => constructorId(attribute)!))]
      : [],
    textLength: source.message.length,
    grouped: source.groupedId !== undefined,
    richBlockCount: rich?.blocks.length ?? 0,
    richBlockConstructors: [...new Set(rich?.blocks.map((block) => constructorId(block)!) ?? [])],
    richDocumentCount: rich?.documents.length ?? 0,
    richPhotoCount: rich?.photos.length ?? 0,
    mappedMedia: Boolean(mapped.media),
    mappedRichBlocks,
    outcome:
      source.media?._ === 'messageMediaUnsupported'
        ? 'server-unsupported'
        : source.media &&
            source.media._ !== 'messageMediaEmpty' &&
            !mapped.media &&
            !mapped.contact &&
            !mapped.poll &&
            !mapped.linkPreview
          ? 'unmapped-media'
          : rich &&
              (rich.blocks.length > mappedRichBlocks ||
                (rich.documents.length > 0 && !mappedRichBlocks))
            ? 'unmapped-rich-content'
            : hasContent
              ? 'mapped'
              : 'empty-source',
  };
}
