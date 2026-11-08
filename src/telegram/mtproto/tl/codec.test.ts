import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  Api,
  constructorDescriptorFor,
  createTl,
  createTlReader,
  decodeTl,
  decodeTlAt,
  descriptorFor,
  encodeTl,
  resultTypeFor,
  tlDescriptors,
  type Tl,
} from './index';

function join(...chunks: readonly Uint8Array[]) {
  const output = Uint8Array.from({ length: chunks.reduce((sum, chunk) => sum + chunk.length, 0) });
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function uint32Le(value: number) {
  return Uint8Array.of(value, value >>> 8, value >>> 16, value >>> 24);
}

describe('functional Telegram TL catalog', () => {
  it('keeps complete decode coverage behind a selected frozen request surface', () => {
    expect(tlDescriptors.filter(({ kind }) => kind === 'constructor')).toHaveLength(1_778);
    expect(tlDescriptors.filter(({ kind }) => kind === 'method')).toHaveLength(172);
    expect(tlDescriptors.filter(({ kind }) => kind === 'bare')).toHaveLength(1);
    expect(descriptorFor('users.getUsers')?.kind).toBe('method');
    expect(descriptorFor('messages.getMessageReactionsList')?.kind).toBe('method');
    expect(descriptorFor('payments.sendPaymentForm')).toBeUndefined();
    expect(descriptorFor('account.authorizationForm')?.kind).toBe('constructor');
    for (const name of [
      'tlsClientHello',
      'tlsBlockString',
      'tlsBlockRandom',
      'tlsBlockZero',
      'tlsBlockDomain',
      'tlsBlockE',
      'tlsBlockGrease',
      'tlsBlockM',
      'tlsBlockPadding',
      'tlsBlockPermutation',
      'tlsBlockPublicKey',
      'tlsBlockScope',
    ]) {
      expect(descriptorFor(name)).toBeUndefined();
    }
    for (const name of ['null', 'p_q_inner_data', 'p_q_inner_data_temp']) {
      expect(descriptorFor(name)).toBeUndefined();
    }
    expect(descriptorFor('server_DH_params_fail')).toMatchObject({
      id: 0x79cb045d,
      kind: 'constructor',
    });
    expect(descriptorFor('gzip_packed')).toMatchObject({ id: 0x3072cfa1, kind: 'constructor' });
    expect(descriptorFor('mtproto.message')).toMatchObject({ id: 0, kind: 'bare' });

    expect(Object.isFrozen(Api)).toBe(true);
    expect(Object.isFrozen(Api.messages)).toBe(true);
    expect(Object.isFrozen(Api.PeerUser)).toBe(true);
    expect(Api.PeerUser.id).toBe(0x59511722);
    expect(Api.PeerUser.tlName).toBe('peerUser');
    expect(Api.PeerUser.kind).toBe('constructor');

    const peer = Api.PeerUser({ userId: 42n });
    expect(peer).toEqual({ _: 'peerUser', userId: 42n });
    expect(Object.isFrozen(peer)).toBe(true);
    expect(Api.PeerUser.is(peer)).toBe(true);
    expect(Api.PeerChat.is(peer)).toBe(false);
  });

  it('associates generated request values with their precise result types', () => {
    const users = Api.users.GetUsers({ id: [Api.InputUserSelf()] });
    const password = Api.account.GetPassword();

    expectTypeOf<Tl.ResultOf<typeof users>>().toEqualTypeOf<readonly Tl.TypeUser[]>();
    expectTypeOf<Tl.ResultOf<typeof password>>().toEqualTypeOf<Tl.account.Password>();
    expect(resultTypeFor(users._)).toEqual(Api.users.GetUsers.result);
  });
});

describe('functional Telegram TL codec', () => {
  it('round-trips constructor ids, signed longs, flags, strings, bytes, and vectors', () => {
    const peer = Api.PeerUser({ userId: 42n });
    expect(encodeTl(peer)).toEqual(
      Uint8Array.of(0x22, 0x17, 0x51, 0x59, 0x2a, 0, 0, 0, 0, 0, 0, 0),
    );
    expect(decodeTl(encodeTl(peer))).toEqual(peer);

    const blockquote = Api.MessageEntityBlockquote({ collapsed: true, offset: 2, length: 3 });
    expect(decodeTl(encodeTl(blockquote))).toEqual(blockquote);

    const filename = Api.DocumentAttributeFilename({ fileName: 'café.txt' });
    expect(decodeTl(encodeTl(filename))).toEqual(filename);

    const update = Api.UpdateDeleteMessages({ messages: [1, -2, 3], pts: 9, ptsCount: 3 });
    expect(decodeTl(encodeTl(update))).toEqual(update);
  });

  it('decodes method-directed vector and primitive results', () => {
    const user = Api.User({ id: 7n });
    const usersResult = join(Uint8Array.of(0x15, 0xc4, 0xb5, 0x1c, 1, 0, 0, 0), encodeTl(user));
    expect(decodeTl(usersResult, { expected: resultTypeFor('users.getUsers')! })).toEqual([user]);

    expect(
      decodeTl(Uint8Array.of(0xb5, 0x75, 0x72, 0x99), {
        expected: resultTypeFor('account.updateNotifySettings')!,
      }),
    ).toBe(true);
  });

  it('decodes bare MTProto messages, containers, RPC results, and gzip hooks', () => {
    const body = Api.PeerUser({ userId: 77n });
    const message = createTl('mtproto.message', { msgId: 4n, seqNo: 1, body });
    const container = createTl('msg_container', { messages: [message] });
    expect(decodeTl(encodeTl(container))).toEqual({
      _: 'msg_container',
      messages: [{ _: 'mtproto.message', msgId: 4n, seqNo: 1, bytes: 12, body }],
    });

    const rpc = createTl('rpc_result', { reqMsgId: 8n, result: true });
    expect(
      decodeTl(encodeTl(rpc), {
        resolveRpcResult: (messageId) =>
          messageId === 8n ? resultTypeFor('account.updateNotifySettings') : undefined,
      }),
    ).toEqual({ _: 'rpc_result', reqMsgId: 8n, result: true });

    const packed = Api.GzipPacked({ packedData: Uint8Array.of(1, 2, 3) });
    expect(decodeTl(encodeTl(packed))).toEqual(packed);
    expect(decodeTl(encodeTl(packed), { gunzip: () => encodeTl(body) })).toEqual(body);
  });

  it('supports cursor decoding and rejects malformed or ambiguous payloads', () => {
    const first = Api.PeerUser({ userId: 1n });
    const second = Api.PeerChat({ chatId: 2n });
    const reader = createTlReader(join(encodeTl(first), encodeTl(second)));
    expect(decodeTlAt(reader)).toEqual(first);
    expect(decodeTlAt(reader)).toEqual(second);
    expect(reader.offset).toBe(reader.bytes.length);

    expect(() => decodeTl(join(encodeTl(first), Uint8Array.of(0)))).toThrow('trailing byte');
    expect(() => decodeTl(Uint8Array.of(0xff, 0xff, 0xff, 0xff))).toThrow('Unknown TL constructor');
    expect(() =>
      decodeTl(Uint8Array.of(0xff), { expected: { kind: 'primitive', name: 'bytes' } }),
    ).toThrow('Invalid TL bytes length prefix');
    expect(() => encodeTl(createTl('peerUser'))).toThrow('Missing required TL field');
    expect(() =>
      encodeTl(
        createTl('inputThemeSettings', {
          baseTheme: Api.BaseThemeDay(),
          accentColor: 1,
          wallpaper: createTl('inputWallPaperNoFile', { id: 1n }),
        }),
      ),
    ).toThrow('must be supplied together');
    expect(() =>
      encodeTl(Api.UpdateDeleteMessages({ messages: [], pts: 0x80000000, ptsCount: 0 })),
    ).toThrow('outside the 32-bit range');
    expect(constructorDescriptorFor(0x59511722)?.name).toBe('peerUser');
  });

  it('rejects oversized service-message vectors before reading their elements', () => {
    for (const name of ['msg_resend_req', 'msgs_ack', 'msgs_state_req']) {
      const descriptor = descriptorFor(name)!;
      expect(descriptor.fields[0]).toMatchObject({ decodeMaxVectorLength: 8_192 });
      expect(() =>
        decodeTl(join(uint32Le(descriptor.id), uint32Le(0x1cb5c415), uint32Le(8_193))),
      ).toThrow('TL vector length 8193 is invalid');
    }
  });

  it('keeps the service vector boundary local to the three protocol fields', () => {
    const ids = Array.from({ length: 8_192 }, (_, index) => BigInt(index));
    const acknowledgment = decodeTl(encodeTl(createTl('msgs_ack', { msgIds: ids }))) as {
      msgIds: readonly bigint[];
    };
    expect(acknowledgment.msgIds).toHaveLength(8_192);

    const messages = Array.from({ length: 8_193 }, (_, index) => index);
    const unrelated = decodeTl(
      encodeTl(Api.UpdateDeleteMessages({ messages, pts: 1, ptsCount: 1 })),
    ) as Tl.UpdateDeleteMessages;
    expect(unrelated.messages).toHaveLength(8_193);
  });
});
