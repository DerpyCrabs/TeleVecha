import { Schema } from 'effect';

const messagingErrorFields = {
  message: Schema.String,
  operation: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
};

/** The stable, schema-backed failure exposed by the messaging facade. */
export class MessagingError extends Schema.TaggedError<MessagingError>()('MessagingError', {
  ...messagingErrorFields,
}) {}

/** Structured-clone-safe representation used by the cross-tab protocol. */
export const MessagingErrorPayload = Schema.Struct({
  _tag: Schema.tag('MessagingError'),
  ...messagingErrorFields,
});

export type MessagingErrorPayload = typeof MessagingErrorPayload.Type;

type ErrorRecord = { readonly code?: unknown; readonly message?: unknown };

function errorRecord(error: unknown): ErrorRecord | undefined {
  return typeof error === 'object' && error !== null ? (error as ErrorRecord) : undefined;
}

function messageOf(error: unknown) {
  const record = errorRecord(error);
  return error instanceof Error
    ? error.message
    : typeof record?.message === 'string'
      ? record.message
      : String(error);
}

export function toMessagingError(error: unknown, operation?: string): MessagingError {
  if (error instanceof MessagingError) {
    if (error.operation || !operation) return error;
    return new MessagingError({
      message: error.message,
      operation,
      ...(error.code === undefined ? {} : { code: error.code }),
    });
  }
  const record = errorRecord(error);
  const code =
    typeof record?.code === 'string' || typeof record?.code === 'number'
      ? String(record.code)
      : undefined;
  return new MessagingError({
    message: messageOf(error),
    ...(operation ? { operation } : {}),
    ...(code ? { code } : {}),
  });
}

export function messagingErrorPayload(error: unknown, operation?: string): MessagingErrorPayload {
  const normalized = toMessagingError(error, operation);
  return {
    _tag: normalized._tag,
    message: normalized.message,
    ...(normalized.operation === undefined ? {} : { operation: normalized.operation }),
    ...(normalized.code === undefined ? {} : { code: normalized.code }),
  };
}

export function messagingErrorFromPayload(payload: MessagingErrorPayload): MessagingError {
  return new MessagingError({
    message: payload.message,
    ...(payload.operation === undefined ? {} : { operation: payload.operation }),
    ...(payload.code === undefined ? {} : { code: payload.code }),
  });
}
