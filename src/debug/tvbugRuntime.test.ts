import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import { createTvBugManifest, sanitizeTvBugState, type TvBugStateV2 } from './tvbugFormat';
import { createTvBugSnapshotClient, snapshotBootstrapPeerId } from './tvbugRuntime';

describe('tvbug runtime bootstrap', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { documentElement: { dataset: {} } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('preserves the captured chat appearance, connectivity and initial loading flags', async () => {
    const snapshot = sanitizeTvBugState({
      dialogs: [
        {
          peer: { id: 'u:123', kind: 'user' },
          title: 'Private',
          initials: 'P',
          color: '#123456',
          topMessageId: 1,
          unreadCount: 0,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          muted: false,
          pinned: false,
          hasAvatar: false,
        },
      ],
      workspace: { activePeerId: 'u:123', online: true, phase: 'ready' },
      runtime: {
        loadingMessages: true,
        hasOlderMessages: true,
        loadingOlderMessages: true,
        historyError: 'Captured error',
      },
      ui: {
        chatAppearance: {
          peerId: 'u:123',
          appearance: { phase: 'ready', waiting: false, hasValue: true },
          wallpaper: {
            phase: 'ready',
            waiting: false,
            hasValue: true,
            byteSize: 1234,
            mimeType: 'image/svg+xml',
          },
          pattern: 'inverted',
          value: {
            wallpaper: {
              id: 'private-pattern',
              dark: true,
              pattern: true,
              hasFile: true,
              settings: {
                backgroundColors: ['#123456'],
                blur: false,
                motion: false,
                intensity: -60,
              },
            },
          },
        },
      },
    });
    const client = createTvBugSnapshotClient({
      manifest: createTvBugManifest({
        producer: { appVersion: 'test' },
        capture: { durationMs: 1, complete: true, truncated: false, tabCount: 1 },
      }),
      snapshot,
      trace: [],
    });
    const peer = snapshot.dialogs[0]!.peer;
    const before = client.snapshot();
    await Effect.runPromise(client.openConversation(peer.id));
    expect(client.snapshot()).toBe(before);
    expect(before).toMatchObject({
      online: true,
      loadingMessages: true,
      hasOlderMessages: true,
      loadingOlderMessages: true,
    });
    const appearance = await Effect.runPromise(client.getChatAppearance(peer));
    expect(appearance).toEqual(snapshot.ui!.chatAppearance!.value);
    const image = await Effect.runPromise(client.downloadWallpaper(appearance!.wallpaper!.id));
    expect(image.type).toBe('image/svg+xml');
    expect(await image.text()).toContain('<circle');
    snapshot.ui!.chatAppearance!.wallpaper = {
      phase: 'error',
      waiting: false,
      hasValue: false,
      code: 'FILE_REFERENCE_EXPIRED',
    };
    const result = await Effect.runPromise(
      client.downloadWallpaper(appearance!.wallpaper!.id).pipe(Effect.result),
    );
    expect(result).toMatchObject({ _tag: 'Failure', failure: { code: 'FILE_REFERENCE_EXPIRED' } });
  });
  it('starts from the runtime peer captured with the snapshot', () => {
    expect(
      snapshotBootstrapPeerId({
        lastPeerId: 'u:1',
        workspace: { activePeerId: 'g:1' },
        ui: { bootstrapActivePeerId: 'c:1', activePeerId: 'c:1' },
      } as TvBugStateV2),
    ).toBe('g:1');
  });

  it('uses the current UI peer when runtime state has no selection', () => {
    expect(
      snapshotBootstrapPeerId({
        ui: { bootstrapActivePeerId: 'c:1', activePeerId: 'c:1' },
      } as TvBugStateV2),
    ).toBe('c:1');
  });
});
