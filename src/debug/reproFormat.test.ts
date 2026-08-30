import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import type {
  PendingSend,
  TelegramDialog,
  TelegramGroupMember,
  TelegramMessage,
} from '../telegram/types';
import {
  TVBUG_FIXED_EPOCH_SECONDS,
  createReproManifest,
  createReproSanitizer,
  createTvBugBundle,
  hydrateReproState,
  parseTvBugBundle,
  sanitizeReproState,
} from './reproFormat';

const sourceEpochSeconds = 1_700_000_000;
const secretPeerId = '9876543210987654321';
const secretSenderId = '112233445566778899';
const secretText = 'Hello  Мир\nمرحبا 👩‍💻👍🏽!';

function zipHeaderOffsets(data: Uint8Array, fileName: string) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const expectedName = strToU8(fileName);
  let local = -1;
  let central = -1;
  const nameMatches = (offset: number) =>
    expectedName.every((byte, index) => data[offset + index] === byte);
  for (let offset = 0; offset <= data.byteLength - 4; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x0403_4b50 && offset + 30 <= data.byteLength) {
      const nameLength = view.getUint16(offset + 26, true);
      if (nameLength === expectedName.byteLength && nameMatches(offset + 30)) local = offset;
    }
    if (signature === 0x0201_4b50 && offset + 46 <= data.byteLength) {
      const nameLength = view.getUint16(offset + 28, true);
      if (nameLength === expectedName.byteLength && nameMatches(offset + 46)) central = offset;
    }
  }
  if (local < 0 || central < 0) throw new Error(`Missing ZIP headers for ${fileName}.`);
  return { local, central };
}

function sourceMessage(): TelegramMessage {
  return {
    id: 42,
    peerId: secretPeerId,
    senderId: secretSenderId,
    senderName: 'Alice Secret',
    senderAvatarId: 'private-avatar-key',
    text: secretText,
    date: sourceEpochSeconds + 5,
    outgoing: false,
    groupedId: 'private-album-id',
    formats: [{ offset: 7, length: 3, kind: 'bold' }],
    mentions: [{ offset: 7, length: 3, userId: secretSenderId }],
    media: {
      kind: 'video',
      name: 'family-holiday.mp4',
      mimeType: 'video/mp4',
      size: 7_654_321,
      width: 1920,
      height: 1080,
      duration: 12.75,
      cacheKey: 'media:private-file-reference',
    },
    richMessage: {
      rtl: true,
      blocks: [
        {
          kind: 'table',
          bordered: true,
          rows: [
            [
              {
                header: true,
                colSpan: 2,
                text: { kind: 'text', text: 'Private heading' },
              },
            ],
          ],
        },
        {
          kind: 'media',
          mediaKind: 'video',
          id: 'private-rich-media-id',
          url: 'https://private.example/video/42',
          caption: { text: { kind: 'text', text: 'Private caption' } },
        },
      ],
    },
  };
}

function sourceDialog(message: TelegramMessage): TelegramDialog {
  return {
    peer: { id: secretPeerId, accessHash: 'private-access-hash', kind: 'channel' },
    channelPts: 99,
    title: 'Family Secrets',
    initials: 'FS',
    color: '#abcdef',
    username: 'private_channel',
    topMessageId: message.id,
    topMessage: message,
    unreadCount: 3,
    readInboxMaxId: 0,
    readOutboxMaxId: 0,
    muted: false,
    pinned: true,
    hasAvatar: true,
    avatarId: 'private-avatar-key',
    lastSeenAt: sourceEpochSeconds,
    userDetails: {
      firstName: 'Alice',
      phone: '+1 555 0100',
      birthday: { day: 2, month: 3, year: 1990 },
      blocked: false,
    },
  };
}

function sourcePending(): PendingSend {
  return {
    id: 'private-pending-id',
    accountId: 'private-account-id',
    peer: { id: secretPeerId, accessHash: 'private-access-hash', kind: 'channel' },
    text: 'Queued private caption',
    randomId: 'private-random-id',
    createdAt: sourceEpochSeconds * 1_000 + 7_000,
    attempts: 2,
    lastError: 'Failure included +1 555 0100',
    attachment: {
      blob: new Blob([new Uint8Array(321)], { type: 'image/png' }),
      name: 'private-photo.png',
      mimeType: 'image/png',
      asSticker: false,
      sendAs: 'media',
    },
  };
}

function sourceGroupMember(): TelegramGroupMember {
  return {
    peer: { id: secretSenderId, accessHash: 'member-access-secret', kind: 'user' },
    title: 'Alice Secret',
    initials: 'AS',
    color: '#abcdef',
    username: 'private_member',
    role: 'confidential-role',
    roleKind: 'admin',
    hasAvatar: true,
    avatarId: 'member-avatar-secret',
    presence: 'online',
  };
}

function manifest() {
  return createReproManifest({
    producer: { appVersion: '0.1.0', commit: 'abc123', telegramLayer: 228 },
    capture: { durationMs: 500, complete: true, truncated: false, tabCount: 1 },
    environment: {
      browser: 'chromium',
      viewport: [1280, 720],
      locale: 'ru',
      timezone: 'Europe/Moscow',
      colorScheme: 'dark',
    },
  });
}

describe('.tvbug repro format', () => {
  it('uses allowlisted fields and bundle-local aliases without leaking account data', () => {
    const message = sourceMessage();
    const sanitizer = createReproSanitizer({ sourceEpochMs: sourceEpochSeconds * 1_000 });
    const state = sanitizer.sanitizeState({
      cursor: { pts: 100, qts: 2, date: sourceEpochSeconds, seq: 8 },
      epoch: 4,
      lastPeerId: secretPeerId,
      dialogs: [sourceDialog(message)],
      messages: [message],
      drafts: { [secretPeerId]: 'A private draft' },
      pending: [sourcePending()],
      pinnedMessages: {
        [secretPeerId]: { value: [message], savedAt: sourceEpochSeconds * 1_000 - 5_000 },
      },
      groupMembers: {
        [secretPeerId]: {
          value: [sourceGroupMember()],
          savedAt: sourceEpochSeconds * 1_000 - 5_000,
        },
      },
      workspace: { accountId: 'private-account-id', activePeerId: secretPeerId },
      ui: {
        route: '/chat/9876543210987654321',
        bootstrapActivePeerId: secretPeerId,
        activePeerId: secretPeerId,
        sidebarWidth: 344,
        detailsOpen: true,
        appearance: {
          themeId: 'tinted',
          chatFontSize: 17,
          wallpaperKind: 'image',
          blur: 8,
          dim: 20,
          accentColor: '#abcdef',
        },
      },
    });

    const serialized = JSON.stringify(state);
    for (const secret of [
      secretPeerId,
      secretSenderId,
      secretText,
      'Alice Secret',
      'private-access-hash',
      'private-file-reference',
      '+1 555 0100',
      'private-account-id',
      'private-random-id',
      'Private caption',
      'confidential-role',
      'member-access-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('accessHash');
    expect(serialized).not.toContain('fileReference');
    expect(serialized).not.toContain('"phone"');
    expect(serialized).not.toContain('"blob"');

    expect(state.dialogs[0]!.peer.id).toBe('c:1');
    expect(state.messages[0]!.peerId).toBe(state.dialogs[0]!.peer.id);
    expect(state.messages[0]!.senderId).toBe('u:1');
    expect(state.messages[0]!.mentions![0]!.userId).toBe(state.messages[0]!.senderId);
    expect(state.lastPeerId).toBe(state.dialogs[0]!.peer.id);
    expect(state.workspace.accountId).toBe('account:1');
    expect(state.pending[0]!.accountId).toBe(state.workspace.accountId);
    expect(state.ui?.appearance?.themeId).toBe('tinted');
    expect(state.ui?.bootstrapActivePeerId).toBe(state.dialogs[0]!.peer.id);
    expect(state.dialogs[0]!.readInboxMaxId).toBe(0);
    expect(state.pinnedMessages['c:1']?.value[0]?.id).toBe(42);
    expect(state.groupMembers['c:1']?.value[0]?.role?.value).toHaveLength(
      'confidential-role'.length,
    );
  });

  it('preserves UTF-16 length, line geometry, entity offsets, and media dimensions', () => {
    const message = sourceMessage();
    const state = sanitizeReproState({ dialogs: [sourceDialog(message)], messages: [message] });
    const safe = state.messages[0]!;

    expect(safe.text).not.toBe(secretText);
    expect(safe.text.length).toBe(secretText.length);
    expect(safe.textMetrics.utf16Length).toBe(secretText.length);
    expect(safe.textMetrics.lineCount).toBe(2);
    expect(safe.textMetrics.lineUtf16Lengths).toEqual(
      secretText.split('\n').map((line) => line.length),
    );
    expect(safe.textMetrics.graphemeCount).toBe(
      [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(secretText)].length,
    );
    for (let index = 0; index < secretText.length; index += 1) {
      if (/\s/u.test(secretText[index]!)) expect(safe.text[index]).toBe(secretText[index]);
    }
    expect(safe.formats).toEqual([{ offset: 7, length: 3, kind: 'bold' }]);
    expect(safe.mentions![0]).toEqual({
      offset: 7,
      length: 3,
      userId: 'u:1',
    });
    expect(safe.media).toMatchObject({
      kind: 'video',
      mimeType: 'video/mp4',
      byteSize: 7_654_321,
      width: 1920,
      height: 1080,
      duration: 12.75,
    });
    expect(state.dialogs[0]!.topMessageId).toBe(42);
    expect(state.messages[0]!.id).toBe(42);
  });

  it('shifts timestamps by one constant while preserving their deltas', () => {
    const message = sourceMessage();
    const sanitizer = createReproSanitizer({ sourceEpochMs: sourceEpochSeconds * 1_000 });
    const state = sanitizer.sanitizeState({
      cursor: { pts: 1, qts: 2, date: sourceEpochSeconds, seq: 3 },
      dialogs: [sourceDialog(message)],
      messages: [message],
      pending: [sourcePending()],
    });

    expect(state.cursor?.date).toBe(TVBUG_FIXED_EPOCH_SECONDS);
    expect(state.messages[0]!.date - state.cursor!.date).toBe(5);
    expect(state.pending[0]!.createdAt - state.cursor!.date * 1_000).toBe(7_000);
    expect(sanitizer.shiftSeconds(sourceEpochSeconds + 20)).toBe(TVBUG_FIXED_EPOCH_SECONDS + 20);
  });

  it('round-trips the three-file ZIP and retains timeline ordering', () => {
    const message = sourceMessage();
    const sanitizer = createReproSanitizer({ sourceEpochMs: sourceEpochSeconds * 1_000 });
    const state = sanitizer.sanitizeState({
      dialogs: [sourceDialog(message)],
      messages: [message],
    });
    const timelineValue = sanitizer.sanitizeValue(
      { peerId: secretPeerId, text: 'New private text', kind: 'new-message' },
      'push.value',
    );
    const bytes = createTvBugBundle({
      manifest: manifest(),
      state,
      timeline: [
        {
          seq: 1,
          tMs: 0,
          kind: 'call',
          callId: 'call:1',
          method: 'getHistory',
          args: { peerId: state.dialogs[0]!.peer.id, limit: 50 },
        },
        { seq: 2, tMs: 12, kind: 'push', method: 'updates', value: timelineValue },
        { seq: 3, tMs: 20, kind: 'resolve', callId: 'call:1', value: { hasOlder: false } },
      ],
    });

    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual([
      'manifest.json',
      'state.v1.json',
      'timeline.v1.ndjson',
    ]);
    expect(strFromU8(files['timeline.v1.ndjson']!).trim().split('\n')).toHaveLength(3);
    const parsed = parseTvBugBundle(bytes);
    expect(parsed.timeline.map(({ seq }) => seq)).toEqual([1, 2, 3]);
    expect(parsed.state).toEqual(state);
  });

  it('hydrates cache-shaped messages, rich content, media, and generated attachments', () => {
    const message = sourceMessage();
    const sanitizer = createReproSanitizer({ sourceEpochMs: sourceEpochSeconds * 1_000 });
    const state = sanitizer.sanitizeState({
      epoch: 9,
      dialogs: [sourceDialog(message)],
      messages: [message],
      pending: [sourcePending()],
      pinnedMessages: {
        [secretPeerId]: { value: [message], savedAt: sourceEpochSeconds * 1_000 - 5_000 },
      },
      groupMembers: {
        [secretPeerId]: {
          value: [sourceGroupMember()],
          savedAt: sourceEpochSeconds * 1_000 - 5_000,
        },
      },
    });
    const beforeHydration = Date.now();
    const hydrated = hydrateReproState(state);

    expect(hydrated.messages[0]).toMatchObject({
      id: 42,
      peerId: 'c:1',
      cacheEpoch: 9,
      media: { size: 7_654_321, width: 1920, height: 1080, duration: 12.75 },
    });
    expect(hydrated.messages[0]!.richMessage?.rtl).toBe(true);
    expect(hydrated.messages[0]!.richMessage?.blocks[0]).toMatchObject({
      kind: 'table',
      bordered: true,
    });
    expect(hydrated.workspace.dialogs).toBe(hydrated.dialogs);
    expect(hydrated.pending[0]!.attachment?.blob.size).toBe(321);
    expect(hydrated.pending[0]!.attachment?.blob.type).toBe('image/png');
    expect(hydrated.pinnedMessages['c:1']?.value[0]?.id).toBe(42);
    expect(hydrated.groupMembers['c:1']?.value[0]?.role).not.toBe('confidential-role');
    expect(hydrated.workspace.pinnedMessages).toBe(hydrated.pinnedMessages);
    expect(hydrated.pinnedMessages['c:1']!.savedAt).toBeGreaterThanOrEqual(beforeHydration - 5_050);
    expect(hydrated.pinnedMessages['c:1']!.savedAt).toBeLessThanOrEqual(Date.now() - 4_950);
  });

  it('handles hostile nested values without leaking secrets or changing structural enums', () => {
    const sanitizer = createReproSanitizer({ sourceEpochMs: sourceEpochSeconds * 1_000 });
    const safe = sanitizer.sanitizeValue(
      {
        presence: 'online',
        senderRoleKind: 'admin',
        mediaKind: 'video',
        sendAs: 'file',
        mode: 'collage',
        align: 'right',
        verticalAlign: 'middle',
        kind: 'confidential-kind',
        role: 'confidential-role',
        richMessage: { blocks: [{ role: 'paragraph' }] },
        message: {
          text: 'Secret 👩‍💻',
          id: 9,
          peerId: secretPeerId,
          date: sourceEpochSeconds,
          outgoing: false,
        },
        media: {
          kind: 'video',
          mimeType: 'video/mp4',
          size: 456_789,
          width: 901,
          height: 507,
          duration: 8.5,
        },
      },
      'transport.value',
    ) as Record<string, unknown>;

    expect(safe).toMatchObject({
      presence: 'online',
      senderRoleKind: 'admin',
      mediaKind: 'video',
      sendAs: 'file',
      mode: 'collage',
      align: 'right',
      verticalAlign: 'middle',
      kind: 'redacted',
      richMessage: { blocks: [{ role: 'paragraph' }] },
      media: { size: 456_789, width: 901, height: 507, duration: 8.5 },
    });
    expect(safe.role).not.toBe('confidential-role');
    const safeMessage = safe.message as { text: string; textMetrics: { utf16Length: number } };
    expect(safeMessage.text).not.toBe('Secret 👩‍💻');
    expect(safeMessage.text).toHaveLength('Secret 👩‍💻'.length);
    expect(safeMessage.textMetrics.utf16Length).toBe('Secret 👩‍💻'.length);

    for (const nested of [
      { details: { refreshToken: 'token-secret' } },
      { details: { auth_session: 123_456 } },
      { details: { clientSecret: 'client-secret' } },
      { details: { userPhoneNumberV2: 7_999_123_45_67 } },
    ]) {
      expect(() => sanitizer.sanitizeValue(nested, 'diagnostic')).toThrow(/forbidden/u);
    }
    expect(sanitizer.sanitizeValue({ requestPhoneNumber: false }, 'urlAuth')).toEqual({
      requestPhoneNumber: false,
    });

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => sanitizer.sanitizeValue(cycle, 'cycle')).toThrow(/nested too deeply/u);
  });

  it('rejects unsafe URLs and allocation-sized attachment descriptors in hand-authored bundles', () => {
    const message = sourceMessage();
    const state = sanitizeReproState({
      messages: [{ ...message, linkPreview: { url: 'https://private.example/story' } }],
      pending: [sourcePending()],
    });
    state.messages[0]!.linkPreview!.url = 'javascript:alert(1)';
    expect(() => createTvBugBundle({ manifest: manifest(), state, timeline: [] })).toThrow(
      /unsafe URL/u,
    );

    state.messages[0]!.linkPreview!.url = 'https://example.invalid/url:1';
    state.pending[0]!.attachment!.byteSize = 256 * 1024 * 1024 + 1;
    expect(() => createTvBugBundle({ manifest: manifest(), state, timeline: [] })).toThrow(
      /256 MiB/u,
    );

    state.pending[0]!.attachment!.byteSize = 150 * 1024 * 1024;
    const secondPending = structuredClone(state.pending[0]!);
    secondPending.id = 'pending:2';
    state.pending.push(secondPending);
    expect(() => createTvBugBundle({ manifest: manifest(), state, timeline: [] })).toThrow(
      /aggregate replay limit/u,
    );
  });

  it('rejects forged ZIP sizes and checksums before trusting decompressed output', () => {
    const state = sanitizeReproState({});
    const valid = createTvBugBundle({ manifest: manifest(), state, timeline: [] });
    const { local, central } = zipHeaderOffsets(valid, 'state.v1.json');

    const centralMismatch = valid.slice();
    const centralMismatchView = new DataView(centralMismatch.buffer);
    const originalSize = centralMismatchView.getUint32(central + 24, true);
    centralMismatchView.setUint32(central + 24, originalSize - 1, true);
    expect(() => parseTvBugBundle(centralMismatch)).toThrow(/metadata disagree/u);

    const undersized = valid.slice();
    const undersizedView = new DataView(undersized.buffer);
    undersizedView.setUint32(local + 22, 1, true);
    undersizedView.setUint32(central + 24, 1, true);
    expect(() => parseTvBugBundle(undersized)).toThrow(/expands beyond/u);

    const badChecksum = valid.slice();
    const badChecksumView = new DataView(badChecksum.buffer);
    const checksum = badChecksumView.getUint32(central + 16, true);
    badChecksumView.setUint32(local + 14, (checksum ^ 1) >>> 0, true);
    badChecksumView.setUint32(central + 16, (checksum ^ 1) >>> 0, true);
    expect(() => parseTvBugBundle(badChecksum)).toThrow(/CRC-32/u);
  });

  it('rejects unordered, malformed, extra-file, and privacy-unsafe bundles', () => {
    const state = sanitizeReproState({});
    expect(() =>
      createTvBugBundle({
        manifest: manifest(),
        state,
        timeline: [
          { seq: 2, tMs: 10, kind: 'checkpoint' },
          { seq: 1, tMs: 11, kind: 'checkpoint' },
        ],
      }),
    ).toThrow(/sequence numbers/u);
    expect(() => parseTvBugBundle(new Uint8Array())).toThrow(/empty/u);

    const valid = createTvBugBundle({ manifest: manifest(), state, timeline: [] });
    const files = unzipSync(valid);
    const unsafeState = JSON.parse(strFromU8(files['state.v1.json']!)) as Record<string, unknown>;
    unsafeState.session = { authKey: 'secret' };
    files['state.v1.json'] = strToU8(JSON.stringify(unsafeState));
    expect(() => parseTvBugBundle(zipSync(files))).toThrow(/forbidden/u);

    const extraFiles = unzipSync(valid);
    extraFiles['../account.json'] = strToU8('{}');
    expect(() => parseTvBugBundle(zipSync(extraFiles))).toThrow(/Unexpected file/u);
  });
});
