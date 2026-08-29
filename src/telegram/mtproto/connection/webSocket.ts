import { createObfuscatedAbridgedCodec } from './abridged';
import type {
  PacketCodec,
  PacketConnection,
  StreamingCipherFactory,
  WebSocketFactory,
  WebSocketLike,
} from './types';

const OPEN = 1;

function defaultWebSocketFactory(url: string, protocols?: string | string[]) {
  return new WebSocket(url, protocols) as WebSocketLike;
}

async function messageBytes(data: unknown) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new Error('Telegram sent a non-binary WebSocket message.');
}

export function telegramWebSocketUrl(input: {
  host: string;
  port?: number;
  test?: boolean;
  premium?: boolean;
}) {
  const port = input.port ?? 443;
  const suffix = `${input.test ? '_test' : ''}${input.premium ? '_premium' : ''}`;
  return `wss://${input.host}:${port}/apiws${suffix}`;
}

export function createWebSocketPacketConnection(options: {
  url: string;
  randomBytes(length: number): Uint8Array;
  createCipher: StreamingCipherFactory;
  socketFactory?: WebSocketFactory;
  connectTimeoutMs?: number;
  createCodec?: () => PacketCodec;
}): PacketConnection {
  const packetListeners = new Set<(packet: Uint8Array) => void>();
  const stateListeners = new Set<(connected: boolean) => void>();
  const socketFactory: WebSocketFactory = (url, protocols) =>
    (options.socketFactory ?? defaultWebSocketFactory)(url, protocols);
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  let socket: WebSocketLike | undefined;
  let codec: PacketCodec | undefined;
  let connected = false;
  let opening: Promise<void> | undefined;
  let receiveChain = Promise.resolve();

  const publishState = (next: boolean) => {
    if (connected === next) return;
    connected = next;
    for (const listener of Array.from(stateListeners)) listener(next);
  };

  const connect = () => {
    if (connected) return Promise.resolve();
    if (opening) return opening;
    receiveChain = Promise.resolve();

    const operation = new Promise<void>((resolve, reject) => {
      codec =
        options.createCodec?.() ??
        createObfuscatedAbridgedCodec({
          randomBytes: (length) => options.randomBytes(length),
          createCipher: (key, iv) => options.createCipher(key, iv),
        });
      const nextSocket = socketFactory(options.url, 'binary');
      socket = nextSocket;
      nextSocket.binaryType = 'arraybuffer';
      let settled = false;

      const timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        nextSocket.close();
        reject(new Error('Telegram WebSocket connection timed out.'));
      }, connectTimeoutMs);

      nextSocket.onopen = () => {
        if (socket !== nextSocket || settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        try {
          nextSocket.send(codec!.initialPacket());
          publishState(true);
          resolve();
        } catch (error) {
          nextSocket.close();
          reject(error);
        }
      };
      nextSocket.onerror = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(new Error('Telegram WebSocket connection failed.'));
      };
      nextSocket.onclose = () => {
        globalThis.clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error('Telegram WebSocket closed during connection setup.'));
        }
        if (socket === nextSocket) publishState(false);
      };
      nextSocket.onmessage = (event) => {
        const nextCodec = codec;
        if (!nextCodec) return;
        receiveChain = receiveChain
          .then(async () => {
            if (socket !== nextSocket || codec !== nextCodec) return;
            const chunk = await messageBytes(event.data);
            if (socket !== nextSocket || codec !== nextCodec) return;
            for (const packet of nextCodec.accept(chunk)) {
              for (const listener of Array.from(packetListeners)) listener(packet);
            }
          })
          .catch(() => {
            nextSocket.close();
          });
      };
    });

    const tracked = operation.finally(() => {
      if (opening === tracked) opening = undefined;
    });
    opening = tracked;
    return tracked;
  };

  return {
    connect,
    disconnect() {
      const active = socket;
      socket = undefined;
      codec = undefined;
      active?.close();
      publishState(false);
    },
    isConnected() {
      return connected && socket?.readyState === OPEN;
    },
    send(payload) {
      if (!socket || !codec || !connected || socket.readyState !== OPEN) {
        throw new Error('Telegram WebSocket is not connected.');
      }
      socket.send(codec.encodePacket(payload));
    },
    subscribePackets(listener) {
      packetListeners.add(listener);
      return () => packetListeners.delete(listener);
    },
    subscribeState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
}
