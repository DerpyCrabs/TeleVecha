export interface StreamingCipher {
  transform(data: Uint8Array): Uint8Array;
}

export type StreamingCipherFactory = (key: Uint8Array, iv: Uint8Array) => StreamingCipher;

export interface PacketCodec {
  initialPacket(): Uint8Array;
  encodePacket(payload: Uint8Array): Uint8Array;
  accept(chunk: Uint8Array): Uint8Array[];
}

export interface PacketConnection {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  send(payload: Uint8Array): void;
  subscribePackets(listener: (packet: Uint8Array) => void): () => void;
  subscribeState(listener: (connected: boolean) => void): () => void;
}

export interface WebSocketLike {
  binaryType: BinaryType;
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: ArrayBufferView | ArrayBuffer | Blob | string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string, protocols?: string | string[]) => WebSocketLike;
