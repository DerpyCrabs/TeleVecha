import { describe, expect, it, vi } from 'vitest';

import {
  createMtprotoSession,
  createSessionSaveQueue,
  parseStoredSession,
  type SessionPersistence,
} from './index';

const encodedKey = 'ab'.repeat(256);

describe('MTProto session persistence', () => {
  it('parses and preserves the legacy session shape', () => {
    expect(parseStoredSession(undefined)).toBeUndefined();
    expect(parseStoredSession({ mainDcId: 2, keys: { 2: encodedKey }, isTest: true })).toEqual({
      mainDcId: 2,
      keys: { 2: encodedKey },
      isTest: true,
    });
    expect(() => parseStoredSession({ mainDcId: 2, keys: { 2: 'not-a-key' } })).toThrow('auth key');
  });

  it('serializes writes and reports the latest failed write at flush', async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persistence: SessionPersistence = {
      load: async () => undefined,
      save: vi
        .fn()
        .mockImplementationOnce(async () => {
          calls.push('first:start');
          await first;
          calls.push('first:end');
        })
        .mockImplementationOnce(async () => {
          calls.push('second');
        }),
      clear: vi.fn(),
    };
    const queue = createSessionSaveQueue(persistence);
    queue.schedule({ mainDcId: 1, keys: {} });
    queue.schedule({ mainDcId: 2, keys: {} });
    await Promise.resolve();
    expect(calls).toEqual(['first:start']);
    releaseFirst();
    await queue.flush();
    expect(calls).toEqual(['first:start', 'first:end', 'second']);
  });

  it('keeps the queue usable after a persistence failure', async () => {
    const persistence: SessionPersistence = {
      load: async () => undefined,
      save: vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValueOnce(undefined),
      clear: vi.fn(),
    };
    const queue = createSessionSaveQueue(persistence);
    queue.schedule({ mainDcId: 2, keys: {} });
    await expect(queue.flush()).rejects.toThrow('quota');
    queue.schedule({ mainDcId: 3, keys: {} });
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(queue.error()).toBeUndefined();
  });

  it('keeps ordered persistence when the error observer throws', async () => {
    const saved: number[] = [];
    let calls = 0;
    const queue = createSessionSaveQueue(
      {
        load: async () => undefined,
        save: async (value) => {
          calls += 1;
          if (calls === 1) throw new Error('disk full');
          saved.push(value.mainDcId);
        },
        clear: async () => undefined,
      },
      () => {
        throw new Error('observer failed');
      },
    );

    queue.schedule({ mainDcId: 2, keys: {} });
    queue.schedule({ mainDcId: 3, keys: {} });
    await queue.flush();
    expect(saved).toEqual([3]);
  });

  it('copies auth keys and clears durable state on delete', async () => {
    const clear = vi.fn();
    const persistence: SessionPersistence = {
      load: async () => undefined,
      save: vi.fn(),
      clear,
    };
    const queue = createSessionSaveQueue(persistence);
    const session = createMtprotoSession(undefined, queue);
    const key = new Uint8Array(256).fill(7);
    session.setAuthKey(2, key);
    key.fill(9);
    expect(session.authKey(2)?.[0]).toBe(7);
    await session.flush();
    session.delete();
    await session.flush();
    expect(clear).toHaveBeenCalledOnce();
  });
});
