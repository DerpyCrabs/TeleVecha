import { afterEach, describe, expect, it, vi } from 'vitest';

import { bigIntToBytes, bytesToBigInt, concatBytes, writeInt32Le } from '../bytes';
import type { PacketConnection } from '../connection';
import { createPlainMtprotoTransport } from './plain';

function connectionDouble() {
  const packetListeners = new Set<(packet: Uint8Array) => void>();
  const stateListeners = new Set<(connected: boolean) => void>();
  const sent: Uint8Array[] = [];
  const connection: PacketConnection = {
    connect: async () => undefined,
    disconnect: () => undefined,
    isConnected: () => true,
    send(packet) {
      sent.push(packet);
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
  return {
    connection,
    sent,
    receive(packet: Uint8Array) {
      for (const listener of Array.from(packetListeners)) listener(packet);
    },
  };
}

function response(body: Uint8Array) {
  return concatBytes(
    new Uint8Array(8),
    bigIntToBytes(1n, 8, { littleEndian: true }),
    writeInt32Le(body.length),
    body,
  );
}

afterEach(() => vi.useRealTimers());

describe('plain MTProto authorization transport', () => {
  it('keeps request message IDs monotonic when the clock does not move', async () => {
    const socket = connectionDouble();
    const transport = createPlainMtprotoTransport({
      connection: socket.connection,
      now: () => 1_700_000_000_000,
      codec: {
        encode: () => Uint8Array.of(1, 0, 0, 0),
        decode: () => ({ _: 'response' }),
        resultTypeFor: () => undefined,
      },
    });

    const first = transport.invoke({ _: 'first' });
    socket.receive(response(Uint8Array.of(2, 0, 0, 0)));
    await first;
    const second = transport.invoke({ _: 'second' });
    socket.receive(response(Uint8Array.of(3, 0, 0, 0)));
    await second;

    const firstId = bytesToBigInt(socket.sent[0]!.slice(8, 16), { littleEndian: true });
    const secondId = bytesToBigInt(socket.sent[1]!.slice(8, 16), { littleEndian: true });
    expect(secondId).toBe(firstId + 4n);
    transport.dispose();
  });

  it('bounds an unanswered key exchange request', async () => {
    vi.useFakeTimers();
    const socket = connectionDouble();
    const transport = createPlainMtprotoTransport({
      connection: socket.connection,
      requestTimeoutMs: 25,
      codec: {
        encode: () => Uint8Array.of(1, 0, 0, 0),
        decode: () => ({ _: 'response' }),
        resultTypeFor: () => undefined,
      },
    });
    const request = transport.invoke({ _: 'request' });
    const rejected = expect(request).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    transport.dispose();
  });
});
