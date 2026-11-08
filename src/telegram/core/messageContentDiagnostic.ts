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
const decodeDiagnostic = Schema.decodeUnknownSync(MessageContentDiagnosticSchema);

export function sanitizeMessageContentDiagnostic(value: unknown): MessageContentDiagnostic {
  const { mediaConstructor, documentConstructor, ...required } = decodeDiagnostic(value);
  // Schema.optional accepts explicit undefined from the mapper and persisted caches.
  // Omit those keys before the bundle's strict JSON audit, not just during JSON.stringify.
  return {
    ...required,
    ...(mediaConstructor !== undefined ? { mediaConstructor } : {}),
    ...(documentConstructor !== undefined ? { documentConstructor } : {}),
  };
}
