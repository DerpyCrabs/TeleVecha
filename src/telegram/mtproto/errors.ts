import { Schema } from 'effect';

export const MtprotoErrorKind = Schema.Literals([
  'cancelled',
  'configuration',
  'crypto',
  'protocol',
  'rpc',
  'session',
  'transport',
]);

export type MtprotoErrorKind = typeof MtprotoErrorKind.Type;

export class MtprotoError extends Schema.TaggedError<MtprotoError>()('MtprotoError', {
  kind: MtprotoErrorKind,
  message: Schema.String,
  code: Schema.optionalKey(Schema.Number),
  details: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export function createMtprotoError(
  kind: MtprotoErrorKind,
  message: string,
  options: {
    code?: number | undefined;
    details?: Readonly<Record<string, unknown>> | undefined;
    cause?: unknown;
  } = {},
): MtprotoError {
  const error = new MtprotoError({
    kind,
    message,
    ...(options.code === undefined ? {} : { code: options.code }),
    ...(options.details === undefined ? {} : { details: { ...options.details } }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
  if (error.details) Object.freeze(error.details);
  return error;
}

export function isMtprotoError(error: unknown): error is MtprotoError {
  return Schema.is(MtprotoError)(error);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
