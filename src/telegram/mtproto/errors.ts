export type MtprotoErrorKind =
  | 'cancelled'
  | 'configuration'
  | 'crypto'
  | 'protocol'
  | 'rpc'
  | 'session'
  | 'transport';

export type MtprotoError = Error & {
  readonly name: 'MtprotoError';
  readonly kind: MtprotoErrorKind;
  readonly code?: number | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
};

export function createMtprotoError(
  kind: MtprotoErrorKind,
  message: string,
  options: {
    code?: number | undefined;
    details?: Readonly<Record<string, unknown>> | undefined;
    cause?: unknown;
  } = {},
): MtprotoError {
  const error = new Error(
    message,
    options.cause === undefined ? undefined : { cause: options.cause },
  );
  Object.defineProperties(error, {
    name: { value: 'MtprotoError', enumerable: true },
    kind: { value: kind, enumerable: true },
    ...(options.code === undefined ? {} : { code: { value: options.code, enumerable: true } }),
    ...(options.details === undefined
      ? {}
      : { details: { value: Object.freeze({ ...options.details }), enumerable: true } }),
  });
  return error as MtprotoError;
}

export function isMtprotoError(error: unknown): error is MtprotoError {
  return (
    error instanceof Error &&
    error.name === 'MtprotoError' &&
    typeof (error as Partial<MtprotoError>).kind === 'string'
  );
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
