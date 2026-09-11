import { Effect } from 'effect';
import type { LocalMediaMetadata, OutgoingAttachment } from '../../telegram/types';
import { readVideoPreview } from '../../telegram/localMedia';
import { readImageDimensions } from './imageTransforms';

export function prepareAttachment(attachment: OutgoingAttachment) {
  const { file } = attachment;
  const metadata: Effect.Effect<LocalMediaMetadata | undefined, unknown> = file.type.startsWith(
    'image/',
  )
    ? Effect.tryPromise(() => readImageDimensions(file))
    : file.type.startsWith('video/')
      ? Effect.tryPromise((signal) => readVideoPreview(file, signal))
      : Effect.succeed(undefined);
  return metadata.pipe(
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.map((metadata) => ({ ...attachment, ...metadata })),
  );
}
