import type { AuthKey } from '../auth';
import type { PacketConnection } from '../connection';
import type { CryptoAdapter } from '../crypto';
import type { MtprotoClientEvent } from '../events';

export type TlObject = { _: string; [field: string]: unknown };

export interface TlCodec {
  encode(value: TlObject): Uint8Array;
  decode(bytes: Uint8Array, expected?: unknown): unknown;
  resultTypeFor(name: string): unknown;
}

export interface PlainMtprotoTransport {
  invoke<Result extends TlObject = TlObject>(request: TlObject): Promise<Result>;
  dispose(): void;
}

export interface AuthorizationResult {
  authKey: AuthKey;
  timeOffset: number;
  serverSalt: bigint;
}

export interface MtprotoSender {
  readonly dcId: number;
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  invoke<Result = unknown>(request: TlObject, options?: { signal?: AbortSignal }): Promise<Result>;
  subscribe(listener: (event: MtprotoClientEvent) => void): () => void;
}

export interface MtprotoSenderOptions {
  dcId: number;
  connection(): PacketConnection;
  codec: TlCodec;
  crypto: CryptoAdapter;
  authKey?: AuthKey | undefined;
  serverSalt?: bigint | undefined;
  timeOffset?: number | undefined;
  authorize(transport: PlainMtprotoTransport): Promise<AuthorizationResult>;
  onAuthKey(result: AuthorizationResult): void | Promise<void>;
  now?: (() => number) | undefined;
  reconnect?:
    | {
        retries?: number | undefined;
        delayMs?: number | undefined;
      }
    | undefined;
}
