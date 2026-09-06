import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import { parseTvBugBundle } from './tvbugFormat';
import { createBrowserDebugReportRecorder } from './tvbugReports';
import { reportDiagnostic } from '../telegram/core/diagnostics';
import { initialEngineSnapshot } from '../telegram/core/engineState';
import type { IndexedDbCacheStore } from '../telegram/persistence/store';

const checkpoint = {
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
});
