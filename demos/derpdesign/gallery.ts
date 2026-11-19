import { pendingPoll } from '../../src/domain/poll';
import { createFixtureTelegramTransport as createTransport } from '../../src/telegram/transports/fixtureTransport';
import type { TelegramMedia, TelegramMessage, TelegramPeer } from '../../src/telegram/types';

function visual(
  name: string,
  width: number,
  height: number,
  kind: TelegramMedia['kind'] = 'photo',
): TelegramMedia {
  const mimeType = name.endsWith('.webm')
    ? 'video/webm'
    : name.endsWith('.webp')
      ? 'image/webp'
      : 'image/jpeg';
  return {
    kind,
    name,
    width,
    height,
    mimeType,
    ...(mimeType.startsWith('video/') ? { duration: 2 } : {}),
  };
}
const wide = visual('launch.jpg', 640, 427);
const portrait = visual('tower.jpg', 162, 427);
const square = visual('crew.jpg', 512, 512);
const panorama = visual('horizon.jpg', 640, 156);
const small = visual('badge.webp', 80, 80);
const wideVideo = visual('launch.webm', 480, 270, 'video');
const tallVideo = visual('tower.webm', 144, 384, 'video');
const squareVideo = visual('crew.webm', 240, 240, 'video');
const files: TelegramMedia[] = [
  { kind: 'file', name: 'flight-notes.txt', mimeType: 'text/plain', size: 78 },
  { ...square, kind: 'file' },
];
type Sample = Partial<TelegramMessage>;
function album(id: string, attachments: TelegramMedia[], caption = ''): Sample[] {
  return attachments.map((media, index) => ({
    media,
    groupedId: id,
    text: index === 0 ? caption : '',
  }));
}
function chat(id: number, title: string, color: string, samples: Sample[]) {
  const peer: TelegramPeer = { id: 'g:' + id, kind: 'group' };
  const history: TelegramMessage[] = samples.map((sample, index) => ({
    peerId: peer.id,
    id: index + 1,
    date: 1762804800 + index * 60,
    senderId: sample.outgoing ? 'self' : 'u:101',
    senderName: 'Alice',
    text: '',
    outgoing: false,
    ...sample,
  }));
  return { peer, title, color, history };
}
const chats = [
  chat(814, 'Aspect ratios', '#657b86', [
    { media: portrait },
    { media: visual('tower-narrow.jpg', 152, 427) },
    { media: visual('tower-strip.jpg', 48, 427) },
    { media: visual('launch-wide.jpg', 640, 216) },
    { media: panorama },
    { media: visual('launch-strip.jpg', 640, 40) },
  ]),
  chat(813, 'Flight updates', '#476f82', [
    { text: 'Telemetry is connected.' },
    { text: 'Ready for the next update.', outgoing: true },
  ]),
  chat(810, 'Mission notebook', '#557994', [
    {
      text: 'Alice created Mission notebook',
      service: { kind: 'chat-created', text: 'Alice created Mission notebook' },
    },
    { text: 'Flight notes are ready.', formats: [{ kind: 'bold', offset: 0, length: 12 }] },
    {
      text: 'Confirmed. I’ll bring a printed copy.',
      outgoing: true,
      replyToId: 2,
      replyQuote: 'Flight notes',
      reactions: [{ emoji: '👍', count: 2, chosen: true }],
    },
    {
      text: 'Launch archive',
      forwardedFrom: { name: 'Flight desk' },
      linkPreview: {
        url: 'https://www.nasa.gov/',
        siteName: 'NASA',
        title: 'Launch archive',
        description: 'Mission photographs and flight notes.',
      },
    },
    { media: files[0] },
    { media: { kind: 'voice', name: 'briefing.wav', mimeType: 'audio/wav', duration: 3 } },
    { media: { ...squareVideo, kind: 'round-video' } },
    { media: { ...small, kind: 'sticker' } },
    {
      media: {
        kind: 'sticker',
        name: 'orbit.tgs',
        mimeType: 'application/x-tgsticker',
        width: 128,
        height: 128,
      },
    },
    { media: { ...squareVideo, kind: 'sticker' } },
    { media: { ...wideVideo, kind: 'animation' } },
    {
      richMessage: {
        blocks: [
          { kind: 'heading', level: 2, text: { kind: 'text', text: 'Flight plan' } },
          {
            kind: 'text',
            role: 'paragraph',
            text: { kind: 'text', text: 'Camera check · Launch · Debrief' },
          },
        ],
      },
    },
    { contact: { firstName: 'Alice', lastName: 'Morgan', phoneNumber: '+12025550104', vcard: '' } },
    {
      poll: pendingPoll(
        {
          question: 'Which frame opens the report?',
          answers: ['The launch', 'The crew'],
          publicVoters: false,
          multipleChoice: false,
          quiz: false,
          solution: '',
        },
        '8107',
      ),
    },
    {
      widget: {
        html: '<h2>Flight window</h2><p>09:00–09:15 UTC</p>',
        width: 260,
        height: 96,
        canQuery: false,
        isCopy: false,
        backgroundQuery: false,
      },
    },
    {
      text: 'Reference code',
      botKeyboard: {
        kind: 'inline',
        rows: [[{ kind: 'copy', text: 'Copy flight code', copyText: 'DSCOVR' }]],
      },
    },
    { text: 'The contact sheet is in the next chat.', outgoing: true },
  ]),
  chat(811, 'Camera tests', '#996d52', [
    { media: small },
    { media: wide },
    {
      media: { kind: 'photo', name: 'crew.jpg', mimeType: 'image/jpeg' },
      text: 'Archive scan · dimensions unavailable',
    },
    { media: { ...square, spoiler: true }, text: 'Crew portrait' },
    { media: portrait },
    {
      media: panorama,
      text: 'View from the launch pad',
      reactions: [{ emoji: '⭐', count: 3, chosen: false }],
    },
    { media: squareVideo },
    { media: tallVideo, text: 'Vertical cut for the field display.' },
    { media: wideVideo, text: 'Launch sequence · landscape cut' },
  ]),
  chat(812, 'Contact sheets', '#507f74', [
    ...album('pair', [panorama, portrait]),
    ...album('triptych', [wide, portrait, square], 'Selections from the archive'),
    ...album('documents', files, 'Flight notes and crew photo'),
    ...album(
      'ten',
      [
        portrait,
        square,
        panorama,
        tallVideo,
        small,
        wide,
        squareVideo,
        portrait,
        panorama,
        wideVideo,
      ],
      'Complete contact sheet',
    ),
    ...album('mixed', [panorama, squareVideo, portrait, wide, square], 'Launch day · first edit'),
  ]),
];
const assets = import.meta.glob<string>('./media/*', {
  query: '?url',
  import: 'default',
  eager: true,
});
export const createFixtureTelegramTransport = () => {
  let flightUpdate = 0;
  const reports = ['Tracking acquired.', 'The upper stage is in view.', 'Signal confirmed.'];
  return createTransport({
    afterSend(message) {
      if (message.peerId !== 'g:813') return;
      const text = reports[flightUpdate++ % reports.length]!;
      window.setTimeout(
        () =>
          window.__televechaFixture?.receiveMessage({
            peerId: message.peerId,
            senderId: 'u:101',
            senderName: 'Alice',
            text,
            date: Math.floor(Date.now() / 1000),
            outgoing: false,
          }),
        450,
      );
    },
    chats,
    asset(media, options) {
      const name =
        options?.preview && media.mimeType.startsWith('video/')
          ? media.name.replace('.webm', '-poster.jpg')
          : media.name;
      const url = assets['./media/' + name];
      if (!url) return undefined;
      return fetch(url).then(async (response) => {
        if (!response.ok) throw Error('Missing gallery asset: ' + name);
        const blob = await response.blob();
        return options?.range
          ? blob.slice(options.range.start, options.range.end + 1, blob.type)
          : blob;
      });
    },
  });
};
