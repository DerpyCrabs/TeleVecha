export type WrappedError<T extends Error = Error> = {
  messageKey: string;
  errorMessage?: string;
  error: T;
};
