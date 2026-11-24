import { SecureRandom, Digest, Kdf } from 'effect/crypto';
import type { Effect, Scope, Stream } from 'effect';
import type * as Socket from 'effect/socket/Socket';

import type { AuthKey } from '../auth';
import type { PacketConnection } from '../connection';
import type { MtprotoError } from '../errors';
import type { MtprotoClientEvent } from '../events';

export type TlObject = { _: string; [field: string]: unknown };

export interface TlCodec {
  encode(value: TlObject): Uint8Array;
  decode(bytes: Uint8Array, expected?: unknown): unknown;
  resultTypeFor(name: string): unknown;
}

export interface PlainMtprotoTransport {
  invoke<Result extends TlObject = TlObject>(
    request: TlObject,
  ): Effect.Effect<Result, MtprotoError>;
}

export interface AuthorizationResult {
  readonly authKey: AuthKey;
  readonly timeOffset: number;
  readonly serverSalt: bigint;
}

export interface MtprotoSender {
  readonly dcId: number;
  readonly connected: Effect.Effect<boolean>;
  readonly invoke: <Result = unknown>(request: TlObject) => Effect.Effect<Result, MtprotoError>;
  readonly events: Stream.Stream<MtprotoClientEvent>;
}

export interface MtprotoSenderOptions {
  readonly purpose?: 'api' | 'media';
  readonly dcId: number;
  readonly connection: PacketConnection<
    (SecureRandom.SecureRandom | Digest.Digest | Kdf.Kdf) | Socket.WebSocketConstructor
  >;
  readonly codec: TlCodec;
  readonly authKey?: AuthKey | undefined;
  readonly serverSalt?: bigint | undefined;
  readonly timeOffset?: number | undefined;
  readonly authorize: (
    transport: PlainMtprotoTransport,
  ) => Effect.Effect<
    AuthorizationResult,
    MtprotoError,
    SecureRandom.SecureRandom | Digest.Digest | Kdf.Kdf
  >;
  readonly onAuthKey: (result: AuthorizationResult) => Effect.Effect<void, MtprotoError>;
  readonly onAuthKeyInvalidated?: (() => Effect.Effect<void, MtprotoError>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly receiveQueueCapacity?: number | undefined;
  readonly reconnect?:
    | { readonly retries?: number | undefined; readonly delayMs?: number | undefined }
    | undefined;
}

export type MtprotoSenderRequirements =
  | (SecureRandom.SecureRandom | Digest.Digest | Kdf.Kdf)
  | Socket.WebSocketConstructor
  | Scope.Scope;
