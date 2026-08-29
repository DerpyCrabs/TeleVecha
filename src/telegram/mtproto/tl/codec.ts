import { constructorDescriptorFor, descriptorFor, tlDescriptorsByName } from './registry';
import type { AnyTlObject, DecodeTlOptions, TlDescriptor, TlReader, TlTypeRef } from './types';

const BOOL_TRUE = 0x997275b5;
const BOOL_FALSE = 0xbc799737;
const VECTOR = 0x1cb5c415;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_VECTOR_LENGTH = 1_000_000;

type Writer = { chunks: Uint8Array[]; length: number };

function allocate(length: number) {
  return Reflect.construct(Uint8Array, [length]) as Uint8Array;
}

function dataView(bytes: Uint8Array) {
  return Reflect.construct(DataView, [
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ]) as DataView;
}

function writer(): Writer {
  return { chunks: [], length: 0 };
}

function push(output: Writer, bytes: Uint8Array) {
  output.chunks.push(bytes);
  output.length += bytes.length;
}

function finish(output: Writer) {
  const bytes = allocate(output.length);
  let offset = 0;
  for (const chunk of output.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function writeUint32(output: Writer, value: number) {
  push(
    output,
    Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24),
  );
}

function writeInt32(output: Writer, value: number) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw Error(`TL int is outside the 32-bit range: ${value}.`);
  }
  writeUint32(output, value >>> 0);
}

function bigintValue(value: unknown, type: string) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw Error(`TL ${type} requires a bigint or safe integer.`);
}

function writeBigInt(output: Writer, value: unknown, bits: 64 | 128 | 256) {
  if (value instanceof Uint8Array) {
    if (value.length !== bits / 8) {
      throw Error(`TL int${bits} requires exactly ${bits / 8} bytes.`);
    }
    push(output, value);
    return;
  }
  let unsigned = BigInt.asUintN(bits, bigintValue(value, `int${bits}`));
  const bytes = allocate(bits / 8);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number(unsigned & 0xffn);
    unsigned >>= 8n;
  }
  push(output, bytes);
}

function writeDouble(output: Writer, value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw Error('TL double requires a finite number.');
  }
  const bytes = allocate(8);
  dataView(bytes).setFloat64(0, value, true);
  push(output, bytes);
}

function encodeUtf8(value: string) {
  const encoder = Reflect.construct(TextEncoder, []) as TextEncoder;
  return encoder.encode(value);
}

function writeBytes(output: Writer, value: unknown) {
  const bytes =
    typeof value === 'string' ? encodeUtf8(value) : value instanceof Uint8Array ? value : undefined;
  if (!bytes) throw Error('TL bytes requires Uint8Array data.');
  if (bytes.length >= 1 << 24) throw Error(`TL bytes is too large: ${bytes.length}.`);

  let headerLength: number;
  if (bytes.length < 254) {
    push(output, Uint8Array.of(bytes.length));
    headerLength = 1;
  } else {
    push(
      output,
      Uint8Array.of(254, bytes.length & 0xff, (bytes.length >>> 8) & 0xff, bytes.length >>> 16),
    );
    headerLength = 4;
  }
  push(output, bytes);
  const padding = (4 - ((headerLength + bytes.length) & 3)) & 3;
  if (padding) push(output, allocate(padding));
}

function requireObject(value: unknown): AnyTlObject {
  if (!value || typeof value !== 'object' || !('_' in value) || typeof value._ !== 'string') {
    throw Error('TL object requires a tagged record with a string `_` field.');
  }
  return value as AnyTlObject;
}

function writeDynamic(output: Writer, value: unknown) {
  if (typeof value === 'boolean') {
    writeUint32(output, value ? BOOL_TRUE : BOOL_FALSE);
    return;
  }
  if (Array.isArray(value)) {
    writeUint32(output, VECTOR);
    writeInt32(output, value.length);
    for (const item of value) writeDynamic(output, item);
    return;
  }
  writeObject(output, requireObject(value), false);
}

function present(value: unknown, type: TlTypeRef) {
  return (
    value !== undefined && !(type.kind === 'primitive' && type.name === 'true' && value === false)
  );
}

function flagsFor(descriptor: TlDescriptor, value: AnyTlObject, fieldName: string) {
  let flags = 0;
  for (const field of descriptor.fields) {
    if (field.flag?.field !== fieldName) continue;
    if (present(value[field.name], field.type)) flags |= 1 << field.flag.bit;
  }
  return flags >>> 0;
}

function validateFlagGroups(descriptor: TlDescriptor, value: AnyTlObject) {
  const groups: Record<string, TlDescriptor['fields'][number][]> = Object.create(null) as Record<
    string,
    TlDescriptor['fields'][number][]
  >;
  for (const field of descriptor.fields) {
    if (!field.flag) continue;
    const key = `${field.flag.field}.${field.flag.bit}`;
    (groups[key] ??= []).push(field);
  }
  for (const [key, fields] of Object.entries(groups)) {
    if (!fields.some((field) => present(value[field.name], field.type))) continue;
    const missing = fields.filter(
      (field) =>
        !(field.type.kind === 'primitive' && field.type.name === 'true') &&
        !present(value[field.name], field.type),
    );
    if (missing.length > 0) {
      throw Error(
        `TL fields sharing ${key} must be supplied together; missing ${missing
          .map((field) => `${descriptor.name}.${field.name}`)
          .join(', ')}.`,
      );
    }
  }
}

function writeValue(output: Writer, value: unknown, type: TlTypeRef) {
  if (type.kind === 'vector') {
    if (!Array.isArray(value)) throw Error('TL vector requires an array.');
    if (!type.bare) writeUint32(output, VECTOR);
    writeInt32(output, value.length);
    for (const item of value) writeValue(output, item, type.item);
    return;
  }

  if (type.kind === 'generic') {
    writeDynamic(output, value);
    return;
  }

  if (type.kind === 'object') {
    if (!type.bare && type.name === 'Object') writeDynamic(output, value);
    else writeObject(output, requireObject(value), type.bare);
    return;
  }

  switch (type.name) {
    case '#':
    case 'int':
    case 'date':
      if (typeof value !== 'number') throw Error(`TL ${type.name} requires a number.`);
      writeInt32(output, value);
      return;
    case 'long':
      writeBigInt(output, value, 64);
      return;
    case 'int128':
      writeBigInt(output, value, 128);
      return;
    case 'int256':
      writeBigInt(output, value, 256);
      return;
    case 'double':
      writeDouble(output, value);
      return;
    case 'string':
      if (typeof value !== 'string') throw Error('TL string requires a string.');
      writeBytes(output, encodeUtf8(value));
      return;
    case 'bytes':
      writeBytes(output, value);
      return;
    case 'Bool':
      if (typeof value !== 'boolean') throw Error('TL Bool requires a boolean.');
      writeUint32(output, value ? BOOL_TRUE : BOOL_FALSE);
      return;
    case 'true':
      if (value !== true) throw Error('TL true requires the literal true.');
  }
}

function writeMessage(output: Writer, value: AnyTlObject) {
  const bodyWriter = writer();
  writeValue(bodyWriter, value.body, { kind: 'object', name: 'Object', bare: false });
  const body = finish(bodyWriter);
  writeBigInt(output, value.msgId, 64);
  writeInt32(output, value.seqNo as number);
  writeInt32(output, body.length);
  push(output, body);
}

function writeObject(output: Writer, value: AnyTlObject, bare: boolean) {
  const descriptor = descriptorFor(value._);
  if (!descriptor) throw Error(`Unknown TL object ${value._}.`);
  if (descriptor.kind === 'method' && bare) {
    throw Error(`TL method ${descriptor.name} cannot be encoded as a bare object.`);
  }
  if (descriptor.name === 'mtproto.message') {
    writeMessage(output, value);
    return;
  }
  validateFlagGroups(descriptor, value);
  if (!bare) writeUint32(output, descriptor.id);

  for (const field of descriptor.fields) {
    if (field.flagIndicator) {
      writeUint32(output, flagsFor(descriptor, value, field.name));
      continue;
    }
    if (field.flag && !present(value[field.name], field.type)) continue;
    const fieldValue = value[field.name];
    if (fieldValue === undefined) {
      throw Error(`Missing required TL field ${descriptor.name}.${field.name}.`);
    }
    writeValue(output, fieldValue, field.type);
  }
}

export function encodeTl(value: AnyTlObject) {
  const output = writer();
  writeObject(output, value, false);
  return finish(output);
}

export function createTlReader(bytes: Uint8Array): TlReader {
  return { bytes, offset: 0 };
}

function remaining(reader: TlReader) {
  return reader.bytes.length - reader.offset;
}

function read(reader: TlReader, length: number) {
  if (!Number.isSafeInteger(length) || length < 0 || length > remaining(reader)) {
    throw Error(
      `TL payload ended at byte ${reader.offset}; ${length} more byte${length === 1 ? '' : 's'} required.`,
    );
  }
  const bytes = reader.bytes.subarray(reader.offset, reader.offset + length);
  reader.offset += length;
  return bytes;
}

function readUint32(reader: TlReader) {
  const bytes = read(reader, 4);
  return (
    ((bytes[0] ?? 0) |
      ((bytes[1] ?? 0) << 8) |
      ((bytes[2] ?? 0) << 16) |
      ((bytes[3] ?? 0) << 24)) >>>
    0
  );
}

function readInt32(reader: TlReader) {
  return readUint32(reader) | 0;
}

function readBigInt(reader: TlReader, bits: 64 | 128 | 256) {
  const bytes = read(reader, bits / 8);
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index] ?? 0);
  }
  return BigInt.asIntN(bits, value);
}

function readDouble(reader: TlReader) {
  return dataView(read(reader, 8)).getFloat64(0, true);
}

function limits(options: DecodeTlOptions) {
  return {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxVectorLength: options.maxVectorLength ?? DEFAULT_MAX_VECTOR_LENGTH,
  };
}

function readBytes(reader: TlReader, options: DecodeTlOptions) {
  const first = read(reader, 1)[0] ?? 0;
  if (first === 255) throw Error('Invalid TL bytes length prefix 255.');
  const headerLength = first === 254 ? 4 : 1;
  const length =
    first === 254
      ? (read(reader, 1)[0] ?? 0) |
        ((read(reader, 1)[0] ?? 0) << 8) |
        ((read(reader, 1)[0] ?? 0) << 16)
      : first;
  if (first === 254 && length < 254) {
    throw Error(`Non-canonical TL bytes length ${length}.`);
  }
  if (length > limits(options).maxBytes) {
    throw Error(`TL bytes length ${length} exceeds the configured limit.`);
  }
  const value = read(reader, length).slice();
  const padding = (4 - ((headerLength + length) & 3)) & 3;
  if (padding) read(reader, padding);
  return value;
}

function decodeUtf8(bytes: Uint8Array) {
  const decoder = Reflect.construct(TextDecoder, ['utf-8', { fatal: true }]) as TextDecoder;
  return decoder.decode(bytes);
}

function readVector(
  reader: TlReader,
  type: Extract<TlTypeRef, { kind: 'vector' }>,
  options: DecodeTlOptions,
  fieldLimit?: number,
) {
  if (!type.bare) {
    const constructorId = readUint32(reader);
    if (constructorId !== VECTOR) {
      throw Error(`Expected TL vector constructor, received 0x${constructorId.toString(16)}.`);
    }
  }
  const count = readInt32(reader);
  const maxVectorLength = Math.min(limits(options).maxVectorLength, fieldLimit ?? Infinity);
  if (count < 0 || count > maxVectorLength) {
    throw Error(`TL vector length ${count} is invalid.`);
  }
  const values: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(readValue(reader, type.item, options));
  }
  return Object.freeze(values);
}

function readMessage(reader: TlReader, options: DecodeTlOptions): AnyTlObject {
  const msgId = readBigInt(reader, 64);
  const seqNo = readInt32(reader);
  const bodyLength = readInt32(reader);
  if (bodyLength < 0 || (bodyLength & 3) !== 0 || bodyLength > limits(options).maxBytes) {
    throw Error(`MTProto message body length ${bodyLength} is invalid.`);
  }
  const bodyReader = createTlReader(read(reader, bodyLength));
  const body = readDynamic(bodyReader, options);
  if (remaining(bodyReader) !== 0) {
    throw Error(`MTProto message body has ${remaining(bodyReader)} trailing bytes.`);
  }
  return Object.freeze({ _: 'mtproto.message', msgId, seqNo, bytes: bodyLength, body });
}

function readRpcResult(reader: TlReader, options: DecodeTlOptions): AnyTlObject {
  const reqMsgId = readBigInt(reader, 64);
  const expected = options.resolveRpcResult?.(reqMsgId);
  const result = expected ? readValue(reader, expected, options) : readDynamic(reader, options);
  return Object.freeze({ _: 'rpc_result', reqMsgId, result });
}

function readGzip(reader: TlReader, options: DecodeTlOptions): unknown {
  const packedData = readBytes(reader, options);
  if (!options.gunzip) return Object.freeze({ _: 'gzip_packed', packedData });
  const unpacked = options.gunzip(packedData);
  if (unpacked.length > limits(options).maxBytes) {
    throw Error(`Unpacked TL gzip data exceeds the configured limit.`);
  }
  return decodeTl(unpacked, options);
}

function readDescriptor(
  reader: TlReader,
  descriptor: TlDescriptor,
  options: DecodeTlOptions,
): unknown {
  if (descriptor.name === 'mtproto.message') return readMessage(reader, options);
  if (descriptor.name === 'rpc_result') return readRpcResult(reader, options);
  if (descriptor.name === 'gzip_packed') return readGzip(reader, options);

  const fields: Record<string, unknown> = { _: descriptor.name };
  const flags: Record<string, number | undefined> = Object.create(null) as Record<
    string,
    number | undefined
  >;
  for (const field of descriptor.fields) {
    if (field.flagIndicator) {
      flags[field.name] = readUint32(reader);
      continue;
    }
    if (field.flag) {
      const mask = flags[field.flag.field];
      if (mask === undefined) {
        throw Error(
          `TL descriptor ${descriptor.name} uses ${field.flag.field} before declaring it.`,
        );
      }
      if ((mask & (1 << field.flag.bit)) === 0) continue;
      if (field.type.kind === 'primitive' && field.type.name === 'true') {
        fields[field.name] = true;
        continue;
      }
    }
    fields[field.name] =
      field.type.kind === 'vector'
        ? readVector(reader, field.type, options, field.decodeMaxVectorLength)
        : readValue(reader, field.type, options);
  }
  return Object.freeze(fields) as AnyTlObject;
}

function readDynamic(reader: TlReader, options: DecodeTlOptions): unknown {
  const id = readUint32(reader);
  if (id === BOOL_TRUE) return true;
  if (id === BOOL_FALSE) return false;
  if (id === VECTOR) {
    reader.offset -= 4;
    return readVector(
      reader,
      { kind: 'vector', item: { kind: 'object', name: 'Object', bare: false }, bare: false },
      options,
    );
  }
  const descriptor = constructorDescriptorFor(id);
  if (!descriptor) {
    throw Error(`Unknown TL constructor 0x${id.toString(16).padStart(8, '0')}.`);
  }
  return readDescriptor(reader, descriptor, options);
}

function readValue(reader: TlReader, type: TlTypeRef, options: DecodeTlOptions): unknown {
  if (type.kind === 'vector') return readVector(reader, type, options);
  if (type.kind === 'generic') return readDynamic(reader, options);
  if (type.kind === 'object') {
    if (!type.bare) return readDynamic(reader, options);
    const descriptor = tlDescriptorsByName[type.name];
    if (!descriptor) throw Error(`Unknown bare TL type ${type.name}.`);
    return readDescriptor(reader, descriptor, options);
  }

  switch (type.name) {
    case '#':
      return readUint32(reader);
    case 'int':
    case 'date':
      return readInt32(reader);
    case 'long':
      return readBigInt(reader, 64);
    case 'int128':
      return readBigInt(reader, 128);
    case 'int256':
      return readBigInt(reader, 256);
    case 'double':
      return readDouble(reader);
    case 'string':
      return decodeUtf8(readBytes(reader, options));
    case 'bytes':
      return readBytes(reader, options);
    case 'Bool': {
      const id = readUint32(reader);
      if (id === BOOL_TRUE) return true;
      if (id === BOOL_FALSE) return false;
      throw Error(`Invalid TL Bool constructor 0x${id.toString(16)}.`);
    }
    case 'true':
      return true;
  }
}

export function decodeTlAt(
  reader: TlReader,
  expected?: TlTypeRef,
  options: DecodeTlOptions = {},
): unknown {
  return expected ? readValue(reader, expected, options) : readDynamic(reader, options);
}

export function decodeTl(bytes: Uint8Array, options: DecodeTlOptions = {}): unknown {
  if (bytes.length > (options.maxBytes ?? DEFAULT_MAX_BYTES)) {
    throw Error(`TL payload length ${bytes.length} exceeds the configured limit.`);
  }
  const reader = createTlReader(bytes);
  const value = decodeTlAt(reader, options.expected, options);
  if (remaining(reader) !== 0) {
    throw Error(`TL payload has ${remaining(reader)} trailing bytes.`);
  }
  return value;
}
