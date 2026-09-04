import { Effect, Schema } from 'effect';

class OperationDeadlineExceeded extends Schema.TaggedError<OperationDeadlineExceeded>()(
  'OperationDeadlineExceeded',
  {
    operation: Schema.String,
    message: Schema.String,
    durationMs: Schema.Number,
  },
) {}

export function withOperationDeadline<Value, Error, Requirements>(
  operation: string,
  effect: Effect.Effect<Value, Error, Requirements>,
  durationMs: number,
  message: string,
) {
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: durationMs,
      orElse: () =>
        Effect.fail(
          new OperationDeadlineExceeded({
            operation,
            message,
            durationMs,
          }),
        ),
    }),
  );
}
