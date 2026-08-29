import { describe, expect, it } from 'vitest';

import { createWebSocketPacketConnection, telegramWebSocketUrl } from './webSocket';
import type { PacketCodec, WebSocketLike } from './types';

function socketDouble(): WebSocketLike & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    binaryType: 'blob',
    readyState: 0,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    sent,
    send(value) {
      sent.push(value);
    },
    close() {},
  };
}

function codecDouble(): PacketCodec {
  return {
    initialPacket: () => Uint8Array.of(1, 2, 3, 4),
    encodePacket: (payload) => Uint8Array.of(99, ...payload),
    accept: (chunk) => [chunk],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Telegram WebSocket packet connection', () => {
  it('uses the expected browser endpoint suffixes', () => {
    expect(telegramWebSocketUrl({ host: 'zws2.web.telegram.org' })).toBe(
      'wss://zws2.web.telegram.org:443/apiws',
    );
    expect(
      telegramWebSocketUrl({ host: 'example.test', port: 8443, test: true, premium: true }),
    ).toBe('wss://example.test:8443/apiws_test_premium');
  });

  it('shares an opening operation and can retry after a failed opening', async () => {
    const sockets: ReturnType<typeof socketDouble>[] = [];
    const connection = createWebSocketPacketConnection({
      url: 'wss://example.test/apiws',
      randomBytes: (length) => new Uint8Array(length),
      createCipher: () => ({ transform: (bytes) => bytes }),
      createCodec: codecDouble,
      socketFactory: () => {
        const socket = socketDouble();
        sockets.push(socket);
        return socket;
      },
    });

    const first = connection.connect();
    expect(connection.connect()).toBe(first);
    sockets[0]?.onerror?.({} as Event);
    await expect(first).rejects.toThrow('connection failed');

    const second = connection.connect();
    expect(sockets).toHaveLength(2);
    const active = sockets[1]!;
    active.readyState = 1;
    active.onopen?.({} as Event);
    await expect(second).resolves.toBeUndefined();
    expect(active.binaryType).toBe('arraybuffer');
    expect(active.sent).toEqual([Uint8Array.of(1, 2, 3, 4)]);

    connection.send(Uint8Array.of(7, 8));
    expect(active.sent[1]).toEqual(Uint8Array.of(99, 7, 8));
  });

  it('decodes received binary data and publishes state changes', async () => {
    const socket = socketDouble();
    const packets: Uint8Array[] = [];
    const states: boolean[] = [];
    const connection = createWebSocketPacketConnection({
      url: 'wss://example.test/apiws',
      randomBytes: (length) => new Uint8Array(length),
      createCipher: () => ({ transform: (bytes) => bytes }),
      createCodec: codecDouble,
      socketFactory: () => socket,
    });
    connection.subscribePackets((packet) => packets.push(packet));
    connection.subscribeState((connected) => states.push(connected));

    const opening = connection.connect();
    socket.readyState = 1;
    socket.onopen?.({} as Event);
    await opening;
    socket.onmessage?.({ data: Uint8Array.of(4, 5) } as MessageEvent);
    await Promise.resolve();
    await Promise.resolve();
    expect(packets).toEqual([Uint8Array.of(4, 5)]);
    expect(states).toEqual([true]);

    socket.onclose?.({} as CloseEvent);
    expect(states).toEqual([true, false]);
  });

  it('does not let a stalled message from an old socket block a reconnect', async () => {
    const sockets: ReturnType<typeof socketDouble>[] = [];
    const packets: Uint8Array[] = [];
    const stalledBuffer = deferred<ArrayBuffer>();
    const stalledBlob = new Blob([Uint8Array.of(1)]);
    Object.defineProperty(stalledBlob, 'arrayBuffer', { value: () => stalledBuffer.promise });
    const connection = createWebSocketPacketConnection({
      url: 'wss://example.test/apiws',
      randomBytes: (length) => new Uint8Array(length),
      createCipher: () => ({ transform: (bytes) => bytes }),
      createCodec: codecDouble,
      socketFactory: () => {
        const socket = socketDouble();
        sockets.push(socket);
        return socket;
      },
    });
    connection.subscribePackets((packet) => packets.push(packet));

    const firstOpening = connection.connect();
    sockets[0]!.readyState = 1;
    sockets[0]!.onopen?.({} as Event);
    await firstOpening;
    sockets[0]!.onmessage?.({ data: stalledBlob } as MessageEvent);
    await Promise.resolve();

    connection.disconnect();
    const secondOpening = connection.connect();
    sockets[1]!.readyState = 1;
    sockets[1]!.onopen?.({} as Event);
    await secondOpening;
    sockets[1]!.onmessage?.({ data: Uint8Array.of(7, 8) } as MessageEvent);
    await Promise.resolve();
    await Promise.resolve();

    expect(packets).toEqual([Uint8Array.of(7, 8)]);
    stalledBuffer.resolve(new ArrayBuffer(1));
    await Promise.resolve();
  });
});
