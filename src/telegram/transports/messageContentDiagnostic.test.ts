import { describe, expect, it } from 'vitest';
import { Api, createTl, descriptorFor } from '../mtproto/tl';
import { describeMessageContent } from './messageContentDiagnostic';

const mapped = { id: 1, peerId: 'u:101', senderId: 'u:101', date: 1, text: '', outgoing: false };
const message = (fields: Partial<Parameters<typeof Api.Message>[0]> = {}) =>
  Api.Message({ id: 1, peerId: Api.PeerUser({ userId: 101n }), date: 1, message: '', ...fields });

describe('message content evidence', () => {
  it('distinguishes an unhandled media type from an empty source', () => {
    const source = message({
      media: createTl('messageMediaGeo', { geo: createTl('geoPointEmpty', {}) }),
    });
    expect(describeMessageContent(source, mapped)).toMatchObject({
      outcome: 'unmapped-media',
      mediaConstructor: descriptorFor('messageMediaGeo')!.id,
    });
    expect(describeMessageContent(message(), mapped).outcome).toBe('empty-source');
  });

  it('retains rich block and document evidence even when mapping loses the contents', () => {
    const source = message({
      richMessage: Api.RichMessage({
        blocks: [createTl('pageBlockUnsupported', {})],
        photos: [],
        documents: [createTl('documentEmpty', { id: 123456789n })],
      }),
    });
    const evidence = describeMessageContent(source, mapped);
    expect(evidence).toMatchObject({
      outcome: 'unmapped-rich-content',
      richBlockCount: 1,
      richBlockConstructors: [descriptorFor('pageBlockUnsupported')!.id],
      richDocumentCount: 1,
      mappedRichBlocks: 0,
    });
    expect(JSON.stringify(evidence)).not.toContain('123456789');
  });
});
