import { Schema } from 'effect';

// Deliberately excludes text, names, peer/document IDs, references and access hashes.
// Constructor IDs describe public TL types, not individual messages or attachments.
export const MessageContentDiagnosticSchema = Schema.Struct({
  layer: Schema.Number,
  messageConstructor: Schema.Number,
  mediaConstructor: Schema.optional(Schema.Number),
  documentConstructor: Schema.optional(Schema.Number),
  documentAttributes: Schema.Array(Schema.Number),
  textLength: Schema.Number,
  grouped: Schema.Boolean,
  richBlockCount: Schema.Number,
  richBlockConstructors: Schema.Array(Schema.Number),
  richDocumentCount: Schema.Number,
  richPhotoCount: Schema.Number,
  mappedMedia: Schema.Boolean,
  mappedRichBlocks: Schema.Number,
  outcome: Schema.Literals([
    'mapped',
    'server-unsupported',
    'unmapped-media',
    'unmapped-rich-content',
    'empty-source',
  ]),
});

export type MessageContentDiagnostic = typeof MessageContentDiagnosticSchema.Type;

// Decode also strips unknown fields, including when reading older/untrusted caches.
export const sanitizeMessageContentDiagnostic = Schema.decodeUnknownSync(
  MessageContentDiagnosticSchema,
);
