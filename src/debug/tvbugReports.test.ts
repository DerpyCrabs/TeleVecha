import { Api, createTl } from '../telegram/mtproto/tl';
import { describeMessageContent } from '../telegram/transports/messageContentDiagnostic';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import { parseTvBugBundle } from './tvbugFormat';
import { createBrowserDebugReportRecorder } from './tvbugReports';
import { reportDiagnostic } from '../telegram/core/diagnostics';
import { initialEngineSnapshot } from '../telegram/core/engineState';
import type { IndexedDbCacheStore } from '../telegram/persistence/store';

const checkpoint = {
  cursor: undefined,
  draftDetails: {},
  lastPeerId: undefined,
  dialogs: [],
  draftRevisions: {},
  drafts: {},
  epoch: 0,
  groupMembers: {},
  messages: [],
  pending: [],
  pinnedMessages: {},
};

const store = () =>
  ({
    captureCheckpoint: vi.fn(() => Effect.succeed(checkpoint)),
  }) as unknown as IndexedDbCacheStore;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('browser debug report recorder', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      location: { href: 'https://televecha.test/' },
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Chrome/140.0', language: 'en-US' });
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('prepares a downloadable report from cached unsupported-message diagnostics', async () => {
    const message = {
      id: 42,
      peerId: 'u:101',
      senderId: 'u:101',
      text: '',
      date: 1,
      outgoing: false,
      cacheEpoch: 0,
    };
    const diagnostic = describeMessageContent(
      Api.Message({
        id: 42,
        peerId: Api.PeerUser({ userId: 101n }),
        date: 1,
        message: '',
        media: createTl('messageMediaUnsupported', {}),
      }),
      message,
    );
    expect(Object.hasOwn(diagnostic, 'documentConstructor')).toBe(true);
    const cache = store();
    vi.mocked(cache.captureCheckpoint).mockReturnValue(
      Effect.succeed({ ...checkpoint, messages: [{ ...message, contentDiagnostic: diagnostic }] }),
    );
    const recorder = createBrowserDebugReportRecorder(cache);
    try {
      const report = await Effect.runPromise(recorder.prepare());
      const bundle = parseTvBugBundle(new Uint8Array(await report.file.arrayBuffer()));
      expect(bundle.snapshot.messages[0]?.contentDiagnostic).toMatchObject({
        outcome: 'server-unsupported',
      });
      expect(
        Object.hasOwn(bundle.snapshot.messages[0]!.contentDiagnostic!, 'documentConstructor'),
      ).toBe(false);
    } finally {
      recorder.dispose();
    }
  });

  it('bounds the exported trace and marks it truncated', async () => {
    const recorder = createBrowserDebugReportRecorder(store());
    for (let index = 0; index < 301; index += 1) {
      recorder.recordComposerSend('peer', `message-${index}`);
    }

    const report = await Effect.runPromise(recorder.prepare());
    const bundle = parseTvBugBundle(new Uint8Array(await report.file.arrayBuffer()));

    expect(bundle.trace).toHaveLength(300);
    expect(bundle.manifest.capture.truncated).toBe(true);
    expect(report.preview).toMatchObject({ traceCount: 300, truncated: true });
    recorder.dispose();
  });

  it('keeps preview counts consistent with the captured bundle', async () => {
    const digestStarted = gate();
    const releaseDigest = gate();
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async () => {
      digestStarted.resolve();
      await releaseDigest.promise;
      return new ArrayBuffer(32);
    });
    const recorder = createBrowserDebugReportRecorder(store());
    recorder.recordComposerSend('peer', 'hello');

    const preparing = Effect.runPromise(recorder.prepare());
    await digestStarted.promise;
    reportDiagnostic({ level: 'info', area: 'sync', message: 'Arrived during hashing.' });
    releaseDigest.resolve();
    const report = await preparing;
    const bundle = parseTvBugBundle(new Uint8Array(await report.file.arrayBuffer()));

    expect(report.preview.traceCount).toBe(bundle.trace.length);
    expect(report.preview.diagnosticCount).toBe(
      bundle.trace.filter(({ kind }) => kind === 'diagnostic').length,
    );
    expect(bundle.trace).toHaveLength(1);
    recorder.dispose();
  });

  it('omits active QR login tokens from exported diagnostics', async () => {
    const recorder = createBrowserDebugReportRecorder(store());
    recorder.attachEngine({
      snapshot: () => ({
        ...initialEngineSnapshot(),
        authStep: 'qr',
        qrLogin: { url: 'tg://login?token=private-login-token', expires: 123 },
      }),
    });
    const report = await Effect.runPromise(recorder.prepare());
    const bundle = parseTvBugBundle(new Uint8Array(await report.file.arrayBuffer()));
    expect(bundle.snapshot.runtime).not.toHaveProperty('qrLogin');
    expect(JSON.stringify(bundle)).not.toContain('private-login-token');
    recorder.dispose();
  });

  it('captures the attached tab conversation instead of an account-owner projection', async () => {
    const recorder = createBrowserDebugReportRecorder(store());
    recorder.attachEngine({
      snapshot: () => ({
        ...initialEngineSnapshot(),
        phase: 'ready',
        activePeerId: 'peer-1',
        dialogs: [
          {
            peer: { id: 'peer-1', kind: 'user' },
            title: 'Visible peer',
            initials: 'VP',
            color: '#765cff',
            archived: false,
            topMessageId: 1,
            unreadCount: 0,
            readInboxMaxId: 1,
            readOutboxMaxId: 0,
            muted: false,
            pinned: false,
            hasAvatar: false,
          },
        ],
        messages: [
          {
            id: 1,
            peerId: 'peer-1',
            senderId: 'peer-1',
            text: 'Visible message',
            date: 1,
            outgoing: false,
          },
        ],
      }),
    });

    const report = await Effect.runPromise(recorder.prepare());
    const bundle = parseTvBugBundle(new Uint8Array(await report.file.arrayBuffer()));

    expect((bundle.snapshot.runtime as { activeMessageCount?: number }).activeMessageCount).toBe(1);
    expect(bundle.snapshot.messages).toHaveLength(1);
    recorder.dispose();
  });

  it('stops collecting diagnostics after disposal', async () => {
    const recorder = createBrowserDebugReportRecorder(store());
    recorder.dispose();
    reportDiagnostic({ level: 'info', area: 'sync', message: 'Ignored after disposal.' });

    const report = await Effect.runPromise(recorder.prepare());

    expect(report.preview.diagnosticCount).toBe(0);
  });

  it('captures live wallpaper resource state and cache presence, and detaches its UI owner', async () => {
    const cache = store();
    cache.loadMetadata = vi.fn(() =>
      Effect.succeed({ value: undefined, savedAt: Date.now() - 1000 }),
    ) as IndexedDbCacheStore['loadMetadata'];
    cache.loadBlob = vi.fn(() => Effect.succeed(undefined));
    const recorder = createBrowserDebugReportRecorder(cache);
    const detach = recorder.attachUi(() => ({
      chatAppearance: {
        peerId: 'u:123',
        appearance: { phase: 'ready', waiting: false, hasValue: true },
        wallpaper: { phase: 'loading', waiting: true, hasValue: false },
        pattern: 'normal',
        value: {
          wallpaper: {
            id: 'private-wallpaper',
            dark: false,
            pattern: true,
            hasFile: true,
            settings: { backgroundColors: ['#123456'], blur: false, motion: false },
          },
        },
      },
    }));
    const report = await Effect.runPromise(recorder.prepare());
    const bundle = parseTvBugBundle(new Uint8Array(await report.file.arrayBuffer()));
    expect(bundle.snapshot.ui?.chatAppearance).toMatchObject({
      wallpaper: { phase: 'loading', waiting: true },
      cache: { metadataPresent: true, wallpaperPresent: false },
    });
    expect(cache.loadBlob).toHaveBeenCalledWith('wallpaper:private-wallpaper');
    expect(bundle.manifest.coverage).toMatchObject({
      chatAppearance: true,
      networkReplay: false,
      media: 'synthetic',
    });
    expect(bundle.manifest.producer.telegramLayer).toBe(228);
    detach();
    const detached = await Effect.runPromise(recorder.prepare());
    expect(
      parseTvBugBundle(new Uint8Array(await detached.file.arrayBuffer())).snapshot.ui
        ?.chatAppearance,
    ).toBeUndefined();
    recorder.dispose();
  });

  it('records state transitions without flooding the trace on unchanged snapshots', async () => {
    const recorder = createBrowserDebugReportRecorder(store());
    const state = { phase: 'connecting', sync: 'stale', online: false, activePeerId: 'u:123' };
    recorder.recordRuntime(state);
    recorder.recordRuntime(state);
    recorder.recordRuntime({ ...state, phase: 'ready', online: true });
    const report = await Effect.runPromise(recorder.prepare());
    const bundle = parseTvBugBundle(new Uint8Array(await report.file.arrayBuffer()));
    expect(bundle.trace).toHaveLength(2);
    expect(bundle.trace[1]).toMatchObject({
      method: 'runtime-state',
      value: { phase: 'ready', online: true },
    });
    recorder.dispose();
  });
});
