import type { Effect, Stream } from 'effect';

import type { MtprotoError } from '../errors';

export interface StreamingCipher {
  transform(data: Uint8Array): Uint8Array;
}

export type StreamingCipherFactory = (key: Uint8Array, iv: Uint8Array) => StreamingCipher;

export interface PacketCodec {
  initialPacket(): Uint8Array;
  encodePacket(payload: Uint8Array): Effect.Effect<Uint8Array, MtprotoError>;
  accept(chunk: Uint8Array): Effect.Effect<ReadonlyArray<Uint8Array>, MtprotoError>;
}

export interface PacketConnection<R = never> {
  readonly packets: <E, R2>(
    outgoing: Stream.Stream<Uint8Array, E, R2>,
  ) => Stream.Stream<Uint8Array, MtprotoError | E, R | R2>;
}
