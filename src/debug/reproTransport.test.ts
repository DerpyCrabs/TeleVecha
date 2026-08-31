import { describe, expect, it, vi } from 'vitest';

import type {
  DifferenceResult,
  HistoryPage,
  SendFileOptions,
  SyncCursor,
  TelegramMessage,
  TelegramPeer,
  TelegramTransport,
  TransportUpdateBatch,
} from '../telegram/types';
import { createReproSanitizer } from './reproFormat';
import {
  ReproReplayMismatchError,
  createRecordingTelegramTransport,
  createReplayTelegramTransport,
  type ReproTransportEvent,
} from './reproTransport';

const cursor: SyncCursor = { pts: 10, qts: 0, date: 1_700_000_000, seq: 2 };
const peer: TelegramPeer = { id: 'real-user-924', kind: 'user', accessHash: 'access-secret' };

function transport(methods: Record<string, unknown>): TelegramTransport {
  return methods as unknown as TelegramTransport;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function clock() {
  let value = 0;
  return {
    now: () => value,
    tick: () => {
      value += 1;
    },
  };
}

function sanitizer() {
  return createReproSanitizer({ sourceEpochMs: 1_700_000_000_000 });
}

describe('repro Telegram transport', () => {
  it('replays pushed updates before the getDifference result', async () => {
    const difference = deferred<DifferenceResult>();
    let push: ((batch: TransportUpdateBatch) => void) | undefined;
    const source = transport({
      subscribe(listener: (batch: TransportUpdateBatch) => void) {
        push = listener;
        return () => {
          push = undefined;
        };
      },
      getDifference: () => difference.promise,
    });
    const events: ReproTransportEvent[] = [];
    const time = clock();
    const recording = createRecordingTelegramTransport(source, events, {
      now: time.now,
      sanitizer: sanitizer(),
    });
    const liveOrder: string[] = [];
    recording.subscribe(() => liveOrder.push('push'));
    const loading = recording.getDifference(cursor, 100).then((value) => {
      liveOrder.push('resolve');
      return value;
    });

    time.tick();
    push?.({
      updates: [
        {
          type: 'pts-advanced',
          pts: 11,
          ptsCount: 1,
        },
      ],
      date: cursor.date + 1,
      seq: 3,
    });
    time.tick();
    difference.resolve({
      type: 'complete',
      cursor: { ...cursor, pts: 11, date: cursor.date + 1, seq: 3 },
      updates: [],
    });
    await loading;

    expect(events.map(({ kind }) => kind)).toEqual(['call', 'push', 'resolve']);
    expect(liveOrder).toEqual(['push', 'resolve']);

    const replayOrder: string[] = [];
    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
    });
    replay.subscribe(() => replayOrder.push('push'));
    const replayed = replay.getDifference(cursor, 100).then((value) => {
      replayOrder.push('resolve');
      return value;
    });

    await expect(replayed).resolves.toMatchObject({
      type: 'complete',
      cursor: { pts: 11, seq: 3 },
    });
    expect(replayOrder).toEqual(['push', 'resolve']);
  });

  it('preserves out-of-order settlements for overlapping history calls and accepts safe aliases', async () => {
    const older = deferred<HistoryPage>();
    const newer = deferred<HistoryPage>();
    const source = transport({
      subscribe: () => () => undefined,
      getHistory: (_peer: TelegramPeer, _limit: number, before?: number) =>
        before === 100 ? older.promise : newer.promise,
    });
    const events: ReproTransportEvent[] = [];
    const recording = createRecordingTelegramTransport(source, events, {
      sanitizer: sanitizer(),
    });
    const first = recording.getHistory(peer, 20, 100);
    const second = recording.getHistory(peer, 20, 50);
    newer.resolve({ messages: [message(2, 'newer')], hasOlder: true });
    await second;
    older.resolve({ messages: [message(1, 'older')], hasOlder: false });
    await first;

    expect(events.map(({ kind, callId }) => `${kind}:${callId ?? ''}`)).toEqual([
      'call:call:1',
      'call:call:2',
      'resolve:call:2',
      'resolve:call:1',
    ]);

    const firstArgs = events[0]?.args;
    if (!Array.isArray(firstArgs)) throw new Error('Expected recorded history arguments.');
    const recordedPeer = firstArgs[0];
    if (!recordedPeer || typeof recordedPeer !== 'object' || Array.isArray(recordedPeer)) {
      throw new Error('Expected a recorded peer.');
    }
    const recordedPeerId = recordedPeer.id;
    if (typeof recordedPeerId !== 'string') throw new Error('Expected a recorded peer alias.');
    expect(recordedPeerId).toBe('u:1');

    const replaySanitizer = sanitizer();
    replaySanitizer.alias('id', 'occupied-before-replay');
    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: replaySanitizer,
    });
    const safePeer: TelegramPeer = { id: recordedPeerId, kind: 'user' };
    const settlementOrder: number[] = [];
    const replaySecond = replay.getHistory(safePeer, 20, 50).then((page) => {
      settlementOrder.push(page.messages[0]!.id);
      return page;
    });
    const replayFirst = replay.getHistory(safePeer, 20, 100).then((page) => {
      settlementOrder.push(page.messages[0]!.id);
      return page;
    });

    await Promise.all([replayFirst, replaySecond]);
    expect(settlementOrder).toEqual([2, 1]);
  });

  it('does not match a future call across a settlement boundary', async () => {
    const events: ReproTransportEvent[] = [
      { seq: 1, tMs: 0, kind: 'call', callId: 'call:1', method: 'getDialogs', args: [20] },
      {
        seq: 2,
        tMs: 0,
        kind: 'resolve',
        callId: 'call:1',
        value: { dialogs: [] },
      },
      { seq: 3, tMs: 0, kind: 'call', callId: 'call:2', method: 'getDialogs', args: [21] },
      {
        seq: 4,
        tMs: 0,
        kind: 'resolve',
        callId: 'call:2',
        value: { dialogs: [] },
      },
    ];
    const mismatches: ReproReplayMismatchError[] = [];
    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
      onMismatch: (error) => mismatches.push(error),
    });

    await expect(replay.getDialogs(21)).rejects.toBeInstanceOf(ReproReplayMismatchError);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.message).toContain('expected getDialogs([20])');

    await expect(replay.getDialogs(20)).resolves.toEqual({ dialogs: [] });
    await expect(replay.getDialogs(21)).resolves.toEqual({ dialogs: [] });
  });

  it('allows independently rendered media to load in a different order', async () => {
    const firstMessage = message(1, 'first');
    const secondMessage = message(2, 'second');
    const events: ReproTransportEvent[] = [];
    const recording = createRecordingTelegramTransport(
      transport({
        subscribe: () => () => undefined,
        downloadMedia: async (current: TelegramMessage) =>
          new Blob([new Uint8Array(current.id === 1 ? 2 : 3)]),
      }),
      events,
      { sanitizer: sanitizer() },
    );
    await recording.downloadMedia(firstMessage);
    await recording.downloadMedia(secondMessage);

    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
    });
    const second = replay.downloadMedia(secondMessage);
    const first = replay.downloadMedia(firstMessage);

    await expect(first).resolves.toHaveProperty('size', 2);
    await expect(second).resolves.toHaveProperty('size', 3);
  });

  it('lets a fixed client query captured history without preserving the broken call sequence', async () => {
    const channel = { id: 'c:1', kind: 'channel' } as const;
    const recovered = {
      id: 101115,
      peerId: channel.id,
      senderId: 'u:1',
      text: 'recovered',
      date: 101115,
      outgoing: false,
    };
    const events: ReproTransportEvent[] = [
      {
        seq: 1,
        tMs: 0,
        kind: 'call',
        callId: 'call:1',
        method: 'getPinnedMessages',
        args: [channel],
      },
      {
        seq: 2,
        tMs: 0,
        kind: 'call',
        callId: 'call:2',
        method: 'getHistoryAround',
        args: [channel, 101116, 50],
      },
      { seq: 3, tMs: 0, kind: 'resolve', callId: 'call:1', value: [] },
      { seq: 4, tMs: 0, kind: 'resolve', callId: 'call:2', value: [recovered] },
    ];
    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
    });

    await expect(replay.getHistory(channel, 50)).resolves.toMatchObject({
      messages: [recovered],
      hasOlder: false,
    });
    const pinned = replay.getPinnedMessages?.(channel);
    const around = replay.getHistoryAround?.(channel, 101116, 50);
    await expect(pinned).resolves.toEqual([]);
    await expect(around).resolves.toEqual([recovered]);
  });

  it('still diverges instead of inventing history absent from the report', async () => {
    const replay = createReplayTelegramTransport([], {
      timeScale: 0,
      sanitizer: sanitizer(),
    });

    await expect(
      replay.getHistory({ id: 'c:missing', kind: 'channel' }, 50),
    ).rejects.toBeInstanceOf(ReproReplayMismatchError);
  });

  it('treats an uncaptured optional avatar as unavailable instead of invalidating replay', async () => {
    const replay = createReplayTelegramTransport([], {
      timeScale: 0,
      sanitizer: sanitizer(),
    });

    await expect(
      replay.downloadAvatar({ id: 'c:optional', kind: 'channel' }),
    ).resolves.toBeUndefined();
  });

  it('keeps background difference polling on the captured final server state', async () => {
    const finalCursor = { pts: 12, qts: 0, date: 20, seq: 4 };
    const events: ReproTransportEvent[] = [
      {
        seq: 1,
        tMs: 0,
        kind: 'call',
        callId: 'call:1',
        method: 'getDifference',
        args: [{ pts: 10, qts: 0, date: 10, seq: 3 }, 100],
      },
      {
        seq: 2,
        tMs: 0,
        kind: 'resolve',
        callId: 'call:1',
        value: { type: 'complete', cursor: finalCursor, updates: [] },
      },
    ];
    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
    });

    await expect(replay.getDifference({ pts: 10, qts: 0, date: 10, seq: 3 }, 100)).resolves.toEqual(
      { type: 'complete', cursor: finalCursor, updates: [] },
    );
    await expect(replay.getDifference(finalCursor, 100)).resolves.toEqual({
      type: 'complete',
      cursor: finalCursor,
      updates: [],
    });
  });

  it('matches a media call after sanitized display-only message fields are hydrated', async () => {
    const events: ReproTransportEvent[] = [
      {
        seq: 1,
        tMs: 0,
        kind: 'call',
        callId: 'call:1',
        method: 'downloadMedia',
        args: [
          {
            id: 101116,
            peerId: 'c:1',
            senderAvatarId: 'senderavatar:3',
            editedAt: { type: 'repro-undefined' },
            media: {
              cacheKey: 'media:19',
              kind: 'video',
              mimeType: 'video/mp4',
              name: 'clip.mp4',
              size: 54_412_569,
              width: 2324,
              height: 1320,
              duration: 41.716,
            },
          },
          {},
        ],
      },
      {
        seq: 2,
        tMs: 0,
        kind: 'resolve',
        callId: 'call:1',
        value: { type: 'repro-binary', byteSize: 1, mimeType: 'video/mp4' },
      },
    ];
    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitize: (value) => value,
    });

    await expect(
      replay.downloadMedia(
        {
          ...message(101116, ''),
          peerId: 'c:1',
          senderAvatarId: 'avatar:5',
          media: {
            cacheKey: 'media:19',
            kind: 'video',
            mimeType: 'video/mp4',
            name: 'clip.mp4',
            size: 54_412_569,
            width: 2324,
            height: 1320,
            duration: 41.716,
          },
        },
        {},
      ),
    ).resolves.toHaveProperty('size', 1);
  });

  it('allows a distinct method to overtake an earlier settled startup request', async () => {
    const safePeer: TelegramPeer = { id: 'u:1', kind: 'user' };
    const events: ReproTransportEvent[] = [
      {
        seq: 1,
        tMs: 0,
        kind: 'call',
        callId: 'call:1',
        method: 'getGroupMembers',
        args: [{ id: 'u:1', kind: 'user' }],
      },
      { seq: 2, tMs: 0, kind: 'resolve', callId: 'call:1', value: [] },
      {
        seq: 3,
        tMs: 0,
        kind: 'call',
        callId: 'call:2',
        method: 'getChatAppearance',
        args: [{ id: 'u:1', kind: 'user' }],
      },
      { seq: 4, tMs: 0, kind: 'resolve', callId: 'call:2', value: {} },
    ];
    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitize: (value) => value,
    });
    const settlementOrder: string[] = [];
    const appearance = replay.getChatAppearance!(safePeer).then((value) => {
      settlementOrder.push('appearance');
      return value;
    });
    const members = replay.getGroupMembers!(safePeer).then((value) => {
      settlementOrder.push('members');
      return value;
    });

    await expect(members).resolves.toEqual([]);
    await expect(appearance).resolves.toEqual({});
    expect(settlementOrder).toEqual(['members', 'appearance']);
  });

  it('allows independent peer metadata reads to start before their recorded order', async () => {
    const firstPeer: TelegramPeer = { id: 'u:1', kind: 'user' };
    const secondPeer: TelegramPeer = { id: 'c:1', kind: 'channel' };
    const events: ReproTransportEvent[] = [
      {
        seq: 1,
        tMs: 0,
        kind: 'call',
        callId: 'call:1',
        method: 'getDifference',
        args: [{ pts: 10, qts: 0, date: 1_700_000_000, seq: 2 }, 100],
      },
      {
        seq: 2,
        tMs: 0,
        kind: 'resolve',
        callId: 'call:1',
        value: {
          type: 'complete',
          cursor: { pts: 10, qts: 0, date: 1_700_000_000, seq: 2 },
          updates: [],
        },
      },
      {
        seq: 3,
        tMs: 0,
        kind: 'call',
        callId: 'call:2',
        method: 'getSharedMediaCounts',
        args: [{ id: 'u:1', kind: 'user' }],
      },
      {
        seq: 4,
        tMs: 0,
        kind: 'resolve',
        callId: 'call:2',
        value: { media: 1, files: 0, links: 0, music: 0, voice: 0 },
      },
      {
        seq: 5,
        tMs: 0,
        kind: 'call',
        callId: 'call:3',
        method: 'getSharedMediaCounts',
        args: [{ id: 'c:1', kind: 'channel' }],
      },
      {
        seq: 6,
        tMs: 0,
        kind: 'resolve',
        callId: 'call:3',
        value: { media: 4, files: 0, links: 0, music: 0, voice: 0 },
      },
    ];
    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitize: (value) => value,
    });

    const secondCounts = replay.getSharedMediaCounts(secondPeer);
    const difference = replay.getDifference(cursor, 100);
    const firstCounts = replay.getSharedMediaCounts(firstPeer);

    await expect(difference).resolves.toMatchObject({ type: 'complete' });
    await expect(firstCounts).resolves.toMatchObject({ media: 1 });
    await expect(secondCounts).resolves.toMatchObject({ media: 4 });
  });

  it('invokes a live replacement when a cached proxy method is monkey-patched', async () => {
    const initial = vi.fn(async () => ({ dialogs: [] }));
    const replacement = vi.fn(async () => ({ dialogs: [], nextOffset: 'patched' }));
    const source: Record<string, unknown> = {
      subscribe: () => () => undefined,
      getDialogs: initial,
    };
    const recording = createRecordingTelegramTransport(transport(source), [], {
      sanitizer: sanitizer(),
    });
    const cachedMethod = recording.getDialogs.bind(recording);
    source.getDialogs = replacement;

    await expect(cachedMethod(20)).resolves.toEqual({ dialogs: [], nextOffset: 'patched' });
    expect(initial).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledWith(20);
  });

  it('uses the state-compatible account alias for the authorized account', async () => {
    const events: ReproTransportEvent[] = [];
    const recording = createRecordingTelegramTransport(
      transport({
        subscribe: () => () => undefined,
        getAuthorizedAccountId: async () => 'real-account-42',
      }),
      events,
      { sanitizer: sanitizer() },
    );
    await expect(recording.getAuthorizedAccountId()).resolves.toBe('real-account-42');
    expect(events[1]?.value).toBe('account:1');

    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
    });
    await expect(replay.getAuthorizedAccountId()).resolves.toBe('account:1');
  });

  it('replays sanitized rejections and reports strict call mismatches', async () => {
    const source = transport({
      subscribe: () => () => undefined,
      getDialogs: async () => {
        throw new TypeError('private account could not sync');
      },
    });
    const events: ReproTransportEvent[] = [];
    const recording = createRecordingTelegramTransport(source, events, {
      sanitizer: sanitizer(),
    });
    await expect(recording.getDialogs(20)).rejects.toThrow('private account could not sync');

    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
    });
    const rejection = replay.getDialogs(20);
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    await expect(rejection).rejects.not.toThrow('private account');

    const mismatches: ReproReplayMismatchError[] = [];
    const divergent = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
      onMismatch: (error) => mismatches.push(error),
    });
    await expect(divergent.getDialogs(21)).rejects.toBeInstanceOf(ReproReplayMismatchError);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.message).toContain('expected getDialogs');
  });

  it('records one push for multiple subscribers and stops the source subscription at zero', () => {
    let push: ((batch: TransportUpdateBatch) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((listener: (batch: TransportUpdateBatch) => void) => {
      push = listener;
      return unsubscribe;
    });
    const events: ReproTransportEvent[] = [];
    const recording = createRecordingTelegramTransport(transport({ subscribe }), events, {
      sanitizer: sanitizer(),
    });
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = recording.subscribe(first);
    const stopSecond = recording.subscribe(second);

    push?.({ updates: [{ type: 'too-long' }] });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);

    stopFirst();
    expect(unsubscribe).not.toHaveBeenCalled();
    stopSecond();
    stopSecond();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('stores no auth material, access hashes, file references, callbacks, or media bytes', async () => {
    const rawText = 'Private line\nsecond 📷';
    const rawMedia = 'raw-user-photo-data';
    const historyMessage: TelegramMessage = {
      ...message(7, rawText),
      media: {
        kind: 'photo',
        name: 'family-secret.jpg',
        mimeType: 'image/jpeg',
        size: 123_456,
        width: 640,
        height: 360,
      },
    };
    const progress = vi.fn();
    const source = transport({
      subscribe: () => () => undefined,
      connect: async () => undefined,
      requestCode: async () => ({ isCodeViaApp: true }),
      submitCode: async () => 'authorized',
      submitPassword: async () => undefined,
      getHistory: async () => ({ messages: [historyMessage], hasOlder: false }),
      getRecentStickers: async () => [
        {
          id: 'sticker-secret-id',
          accessHash: 'sticker-access-secret',
          fileReference: new Uint8Array([9, 8, 7]),
          emoji: '🙂',
          mimeType: 'image/webp',
        },
      ],
      downloadMedia: async () => new Blob([rawMedia, new Uint8Array(256)], { type: 'image/jpeg' }),
      sendFile: async (target: TelegramPeer, file: File, options: SendFileOptions) => {
        options.onProgress?.(0.5);
        return {
          message: {
            ...message(8, options.caption),
            peerId: target.id,
            media: {
              kind: 'file',
              name: file.name,
              mimeType: file.type,
              size: file.size,
            },
          },
        };
      },
    });
    const events: ReproTransportEvent[] = [];
    const recording = createRecordingTelegramTransport(source, events, {
      sanitizer: sanitizer(),
    });

    await recording.connect({ apiId: 12345, apiHash: 'api-hash-secret' });
    await recording.requestCode('+7 999 123 45 67');
    await recording.submitCode('13579');
    await recording.submitPassword('correct horse battery staple');
    await recording.getHistory(peer, 20);
    await recording.getRecentStickers();
    await recording.downloadMedia(historyMessage);
    await recording.sendFile(
      peer,
      new File(['file-secret'], 'private.txt', { type: 'text/plain' }),
      {
        caption: 'private caption',
        randomId: 'random-secret',
        asSticker: false,
        sendAs: 'file',
        onProgress: progress,
      },
    );

    expect(progress).toHaveBeenCalledWith(0.5);
    const serialized = JSON.stringify(events);
    for (const secret of [
      'api-hash-secret',
      '+7 999 123 45 67',
      '13579',
      'correct horse battery staple',
      'access-secret',
      'sticker-access-secret',
      rawText,
      rawMedia,
      'file-secret',
      'private caption',
      'random-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('fileReference');
    expect(serialized).not.toContain('accessHash');
    expect(serialized).not.toContain('onProgress');

    const historyResolve = events.find(
      (event) => event.kind === 'resolve' && event.callId === events[8]?.callId,
    );
    void historyResolve;
    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
    });
    await replay.connect({ apiId: 0, apiHash: 'anything' });
    await replay.requestCode('anything');
    await replay.submitCode('anything');
    await replay.submitPassword('anything');
    const replayedHistory = await replay.getHistory(peer, 20);
    expect(replayedHistory.messages[0]!.text).toHaveLength(rawText.length);
    expect(replayedHistory.messages[0]!.text).not.toBe(rawText);
    expect(replayedHistory.messages[0]!.media).toMatchObject({
      size: 123_456,
      width: 640,
      height: 360,
    });
    const stickers = await replay.getRecentStickers();
    expect(stickers[0]!.fileReference).toEqual(new Uint8Array());
    expect(stickers[0]!.accessHash).toBe('$replay');
    const placeholder = await replay.downloadMedia(replayedHistory.messages[0]!);
    expect(placeholder.type).toBe('image/svg+xml');
    expect(placeholder.size).toBe(rawMedia.length + 256);
    await expect(placeholder.text()).resolves.toContain('width="640" height="360"');
    const replayProgress = vi.fn();
    await replay.sendFile(peer, new File(['other-bytes'], 'another.txt', { type: 'text/plain' }), {
      caption: 'aaaaaaa aaaaaaa',
      randomId: 'new-random',
      asSticker: false,
      sendAs: 'file',
      onProgress: replayProgress,
    });
    expect(replayProgress).toHaveBeenCalledWith(0.5);
  });

  it('redacts callback bytes and composite credential fields before custom sanitization', async () => {
    const callbackData = [19, 87, 255];
    const keyboardMessage: TelegramMessage = {
      ...message(12, 'callback'),
      botKeyboard: {
        kind: 'inline',
        rows: [[{ kind: 'callback', text: 'Run', data: callbackData }]],
      },
    };
    const events: ReproTransportEvent[] = [];
    const recording = createRecordingTelegramTransport(
      transport({
        subscribe: () => () => undefined,
        answerBotCallback: async () => ({ alert: false }),
        getHistory: async () => ({ messages: [keyboardMessage], hasOlder: false }),
        getUserDetails: async () => ({
          blocked: false,
          refreshToken: 91_001,
          auth_session: 91_002,
          clientSecret: 91_003,
          userPhoneNumberV2: 91_004,
          accessHashV2: 91_005,
          fileReferenceBackup: 91_006,
          requestPhoneNumber: true,
        }),
      }),
      events,
      { sanitize: (value) => value },
    );

    await recording.answerBotCallback!(peer, 7, callbackData);
    await recording.getHistory(peer, 1);
    await recording.getUserDetails(peer);

    const callbackCall = events.find(
      (event) => event.kind === 'call' && event.method === 'answerBotCallback',
    );
    expect(callbackCall?.args).toEqual([{ id: peer.id, kind: peer.kind }, 7, [0, 0, 0]]);
    const historyResolve = events.find(
      (event) => event.kind === 'resolve' && event.callId === 'call:2',
    );
    expect(historyResolve?.value).toMatchObject({
      messages: [
        {
          botKeyboard: { rows: [[{ data: [0, 0, 0] }]] },
        },
      ],
    });
    const detailsResolve = events.find(
      (event) => event.kind === 'resolve' && event.callId === 'call:3',
    );
    expect(detailsResolve?.value).toEqual({ blocked: false, requestPhoneNumber: true });

    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitize: (value) => value,
    });
    await expect(replay.answerBotCallback!(peer, 7, callbackData)).resolves.toEqual({
      alert: false,
    });
  });

  it('creates exact-size image placeholders beyond the old eight MiB cap', async () => {
    const byteSize = 9 * 1024 * 1024 + 13;
    const mediaMessage: TelegramMessage = {
      ...message(13, ''),
      media: {
        kind: 'video',
        name: 'large-video.mp4',
        mimeType: 'video/mp4',
        size: byteSize,
        width: 1920,
        height: 1080,
      },
    };
    const events: ReproTransportEvent[] = [];
    const recording = createRecordingTelegramTransport(
      transport({
        subscribe: () => () => undefined,
        downloadMedia: async () => new Blob([new Uint8Array(byteSize)], { type: 'video/mp4' }),
      }),
      events,
      { sanitizer: sanitizer() },
    );
    await recording.downloadMedia(mediaMessage);

    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
    });
    const placeholder = await replay.downloadMedia(mediaMessage);
    expect(placeholder.size).toBe(byteSize);
    expect(placeholder.type).toBe('image/svg+xml');
    await expect(placeholder.slice(0, 180).text()).resolves.toContain('width="1920" height="1080"');
  });

  it('caps materialized bytes for a hostile binary descriptor without changing its metadata', async () => {
    const byteSize = Number.MAX_SAFE_INTEGER;
    const safePeer: TelegramPeer = { id: 'u:1', kind: 'user' };
    const descriptor = {
      type: 'repro-binary',
      mimeType: 'image/jpeg',
      byteSize,
      width: 640,
      height: 360,
      duration: 12,
      mediaKind: 'video',
    };
    const events: ReproTransportEvent[] = [
      {
        seq: 1,
        tMs: 0,
        kind: 'call',
        callId: 'call:1',
        method: 'downloadAvatar',
        args: [{ id: 'u:1', kind: 'user' }],
      },
      {
        seq: 2,
        tMs: 0,
        kind: 'resolve',
        callId: 'call:1',
        value: descriptor,
      },
    ];
    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitize: (value) => value,
    });

    const placeholder = await replay.downloadAvatar(safePeer);
    expect(placeholder?.size).toBe(16 * 1024 * 1024);
    expect(placeholder?.type).toBe('image/svg+xml');
    await expect(placeholder?.slice(0, 180).text()).resolves.toContain('width="640" height="360"');
    expect(descriptor).toMatchObject({ byteSize, duration: 12, mediaKind: 'video' });
  });

  it('replays progress callbacks that were emitted after a call settled', async () => {
    let reportProgress: ((progress: number) => void) | undefined;
    const events: ReproTransportEvent[] = [];
    const recording = createRecordingTelegramTransport(
      transport({
        subscribe: () => () => undefined,
        sendFile: async (target: TelegramPeer, _file: File, options: SendFileOptions) => {
          reportProgress = options.onProgress;
          return { message: { ...message(14, ''), peerId: target.id } };
        },
      }),
      events,
      { sanitizer: sanitizer() },
    );
    await recording.sendFile(peer, new File(['x'], 'x.txt'), {
      caption: '',
      randomId: 'random-id',
      asSticker: false,
      sendAs: 'file',
      onProgress: vi.fn(),
    });
    reportProgress?.(0.75);
    expect(events.map(({ kind }) => kind)).toEqual(['call', 'resolve', 'push']);

    const replayProgress = vi.fn();
    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
    });
    await replay.sendFile(peer, new File(['y'], 'y.txt'), {
      caption: '',
      randomId: 'other-rnd',
      asSticker: false,
      sendAs: 'file',
      onProgress: replayProgress,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(replayProgress).toHaveBeenCalledWith(0.75);
  });

  it('matches generated send IDs and returns the replay caller ID for optimistic correlation', async () => {
    const events: ReproTransportEvent[] = [];
    const recording = createRecordingTelegramTransport(
      transport({
        subscribe: () => () => undefined,
        sendText: async (target: TelegramPeer, text: string, randomId: string) => ({
          message: { ...message(15, text), peerId: target.id, randomId },
        }),
      }),
      events,
      { sanitizer: sanitizer() },
    );
    await recording.sendText(peer, 'same layout', 'recorded-random');

    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
    });
    const result = await replay.sendText(peer, 'same layout', 'fresh-random');

    expect(result.message.randomId).toBe('fresh-random');
  });

  it('leaves calls unresolved when the recording has no settlement', async () => {
    const never = new Promise<HistoryPage>(() => undefined);
    const events: ReproTransportEvent[] = [];
    const recording = createRecordingTelegramTransport(
      transport({ subscribe: () => () => undefined, getHistory: () => never }),
      events,
      { sanitizer: sanitizer() },
    );
    void recording.getHistory(peer, 1);
    await Promise.resolve();
    expect(events.map(({ kind }) => kind)).toEqual(['call']);

    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      sanitizer: sanitizer(),
    });
    let settled = false;
    void replay.getHistory(peer, 1).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('signals completion once after the final event callback', async () => {
    const events: ReproTransportEvent[] = [
      { seq: 1, tMs: 0, kind: 'call', callId: 'call:1', method: 'getDialogs', args: [20] },
      {
        seq: 2,
        tMs: 0,
        kind: 'resolve',
        callId: 'call:1',
        value: { dialogs: [] },
      },
    ];
    const order: string[] = [];
    const complete = vi.fn(() => order.push('complete'));
    const replay = createReplayTelegramTransport(events, {
      timeScale: 0,
      onEvent: (event) => order.push(event.kind),
      onComplete: complete,
    });

    await expect(replay.getDialogs(20)).resolves.toEqual({ dialogs: [] });
    await Promise.resolve();
    expect(order).toEqual(['call', 'resolve', 'complete']);
    expect(complete).toHaveBeenCalledTimes(1);

    const stop = replay.subscribe(vi.fn());
    stop();
    await expect(replay.getDialogs(20)).resolves.toEqual({ dialogs: [] });
    await Promise.resolve();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('signals completion for empty tapes and consumed unresolved calls', async () => {
    const emptyComplete = vi.fn();
    createReplayTelegramTransport([], { timeScale: 0, onComplete: emptyComplete });
    expect(emptyComplete).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(emptyComplete).toHaveBeenCalledTimes(1);

    const unresolvedComplete = vi.fn();
    const unresolved = createReplayTelegramTransport(
      [
        {
          seq: 1,
          tMs: 0,
          kind: 'call',
          callId: 'call:1',
          method: 'getHistory',
          args: [{ id: 'u:1', kind: 'user' }, 1],
        },
      ],
      {
        timeScale: 0,
        sanitize: (value) => value,
        onComplete: unresolvedComplete,
      },
    );
    let settled = false;
    void unresolved.getHistory({ id: 'u:1', kind: 'user' }, 1).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(unresolvedComplete).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  });
});

function message(id: number, text: string): TelegramMessage {
  return {
    id,
    peerId: peer.id,
    senderId: peer.id,
    text,
    date: cursor.date + id,
    outgoing: false,
  };
}
