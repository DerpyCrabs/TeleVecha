import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';
import { createServer } from '@voidzero-dev/vite-plus-core';
import { Unzip, UnzipInflate } from 'fflate';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORMAT = 'televecha-debug';
const VERSION = 2;
const REQUIRED_FILES = new Set(['manifest.json', 'snapshot.v2.json', 'trace.v2.ndjson']);
const FILE_LIMITS = new Map([
  ['manifest.json', 256 * 1024],
  ['snapshot.v2.json', 8 * 1024 * 1024],
  ['trace.v2.ndjson', 1024 * 1024],
]);
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_TRACE_EVENTS = 300;
const MAX_JSON_COLLECTION_ITEMS = 100_000;
const MAX_JSON_DEPTH = 64;
const MAX_CALLBACK_DATA_LENGTH = 1024 * 1024;
const MAX_SYNTHETIC_ATTACHMENT_BYTES = 256 * 1024 * 1024;
const MAX_VIEWPORT_EDGE = 8_192;
const MAX_DEVICE_EDGE = 16_384;
const MAX_DEVICE_PIXELS = 32 * 1024 * 1024;
const ZIP_CHUNK_BYTES = 4 * 1024;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_ENCRYPTED_FLAGS = 0x2041;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const DEFAULT_PORT = 4175;
const READY_TIMEOUT_MS = 120_000;
const INSPECTION_QUIESCENCE_MS = 500;
const FORBIDDEN_KEYS = new Set(
  [
    'accesshash',
    'apikey',
    'apihash',
    'auth',
    'authkey',
    'blob',
    'bytes',
    'credential',
    'credentials',
    'filereference',
    'password',
    'phone',
    'phonenumber',
    'raw',
    'session',
    'token',
  ].map(normalizeKey),
);
const TRACE_KINDS = new Set(['ui', 'diagnostic']);
const CRC32_TABLE = createCrc32Table();

class TvBugInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TvBugInputError';
  }
}

function usage() {
  return [
    'Usage: npm run tvbug -- [--headless | --serve] [--screenshot <path>] <report.tvbug>',
    '',
    `The snapshot server uses port ${DEFAULT_PORT} by default. Set TELEVECHA_TVBUG_PORT to change it.`,
  ].join('\n');
}

function parseArguments(argv) {
  let headless = false;
  let serve = false;
  let screenshot;
  let bundlePath;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--headless') {
      headless = true;
      continue;
    }
    if (argument === '--serve') {
      serve = true;
      continue;
    }
    if (argument === '--screenshot') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new TvBugInputError('--screenshot requires a file path.');
      }
      screenshot = resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument.startsWith('-')) {
      throw new TvBugInputError(`Unknown option: ${argument}`);
    }
    if (bundlePath) throw new TvBugInputError('Pass exactly one .tvbug bundle.');
    bundlePath = resolve(process.cwd(), argument);
  }

  if (!bundlePath) throw new TvBugInputError('Missing .tvbug bundle path.');
  if (serve && screenshot) {
    throw new TvBugInputError('--screenshot cannot be used with --serve.');
  }
  return { bundlePath, headless, serve, screenshot, help: false };
}

function parsePort(rawValue) {
  const value = rawValue ?? String(DEFAULT_PORT);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TvBugInputError(`Invalid TELEVECHA_TVBUG_PORT: ${value}`);
  }
  return port;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TvBugInputError(`${label} must contain a JSON object.`);
  return value;
}

function requireFiniteNumber(value, label, { integer = false, minimum } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TvBugInputError(`${label} must be a finite number.`);
  }
  if (integer && !Number.isSafeInteger(value)) {
    throw new TvBugInputError(`${label} must be a safe integer.`);
  }
  if (minimum !== undefined && value < minimum) {
    throw new TvBugInputError(`${label} must be at least ${minimum}.`);
  }
  return value;
}

function validateJsonNumbers(value, label) {
  const stack = [{ value, path: label, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > 1_000_000) {
      throw new TvBugInputError(`${label} has too many JSON values.`);
    }
    if (current.depth > MAX_JSON_DEPTH) {
      throw new TvBugInputError(`${current.path} is nested too deeply.`);
    }
    if (typeof current.value === 'number' && !Number.isFinite(current.value)) {
      throw new TvBugInputError(`${current.path} contains a non-finite number.`);
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_COLLECTION_ITEMS) {
        throw new TvBugInputError(`${current.path} contains too many items.`);
      }
      for (let index = 0; index < current.value.length; index += 1) {
        stack.push({
          value: current.value[index],
          path: `${current.path}[${index}]`,
          depth: current.depth + 1,
        });
      }
    } else if (isRecord(current.value)) {
      const entries = Object.entries(current.value);
      if (entries.length > MAX_JSON_COLLECTION_ITEMS) {
        throw new TvBugInputError(`${current.path} contains too many fields.`);
      }
      for (const [key, child] of entries) {
        if (isForbiddenField(key, child)) {
          throw new TvBugInputError(`${current.path}.${key} is forbidden in a .tvbug bundle.`);
        }
        const normalized = normalizeKey(key);
        if (
          normalized === 'url' &&
          (typeof child !== 'string' ||
            !/^https:\/\/example\.invalid\/[a-z0-9-]+:\d+$/u.test(child))
        ) {
          throw new TvBugInputError(`${current.path}.${key} contains an unsafe URL.`);
        }
        if (
          normalized === 'datalength' &&
          requireFiniteNumber(child, `${current.path}.${key}`, { integer: true, minimum: 0 }) >
            MAX_CALLBACK_DATA_LENGTH
        ) {
          throw new TvBugInputError(`${current.path}.${key} exceeds the callback data limit.`);
        }
        stack.push({ value: child, path: `${current.path}.${key}`, depth: current.depth + 1 });
      }
    }
  }
}

function inspectZipArchive(archive) {
  const minimumEndOffset = Math.max(0, archive.byteLength - 22 - 65_535);
  let endOffset = -1;
  for (let offset = archive.byteLength - 22; offset >= minimumEndOffset; offset -= 1) {
    if (readUint32(archive, offset) !== ZIP_END_SIGNATURE) continue;
    const commentLength = readUint16(archive, offset + 20);
    if (offset + 22 + commentLength === archive.byteLength) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new TvBugInputError('Cannot find a valid ZIP end record.');

  const diskNumber = readUint16(archive, endOffset + 4);
  const centralDisk = readUint16(archive, endOffset + 6);
  const entriesOnDisk = readUint16(archive, endOffset + 8);
  const entryCount = readUint16(archive, endOffset + 10);
  const centralSize = readUint32(archive, endOffset + 12);
  const centralOffset = readUint32(archive, endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new TvBugInputError('Multi-disk and ZIP64 .tvbug archives are not supported.');
  }
  if (entryCount !== REQUIRED_FILES.size) {
    throw new TvBugInputError(
      `The .tvbug bundle must contain exactly ${REQUIRED_FILES.size} files.`,
    );
  }
  if (centralOffset + centralSize !== endOffset) {
    throw new TvBugInputError('The ZIP central directory is malformed.');
  }

  const seen = new Set();
  const entries = [];
  let totalSize = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || readUint32(archive, offset) !== ZIP_CENTRAL_SIGNATURE) {
      throw new TvBugInputError('The ZIP central directory is malformed.');
    }
    const flags = readUint16(archive, offset + 8);
    const compression = readUint16(archive, offset + 10);
    const crc32 = readUint32(archive, offset + 16);
    const compressedSize = readUint32(archive, offset + 20);
    const originalSize = readUint32(archive, offset + 24);
    const nameLength = readUint16(archive, offset + 28);
    const extraLength = readUint16(archive, offset + 30);
    const commentLength = readUint16(archive, offset + 32);
    const startDisk = readUint16(archive, offset + 34);
    const localOffset = readUint32(archive, offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > endOffset) {
      throw new TvBugInputError('The ZIP central directory is truncated.');
    }
    const name = readArchiveName(archive, offset + 46, nameLength);
    if (!REQUIRED_FILES.has(name) || name.includes('/') || name.includes('\\')) {
      throw new TvBugInputError(`Unexpected path in .tvbug bundle: ${name}`);
    }
    if (seen.has(name)) throw new TvBugInputError(`Duplicate path in .tvbug bundle: ${name}`);
    if (startDisk !== 0) {
      throw new TvBugInputError(`${name} is stored on an unsupported ZIP disk.`);
    }
    if ((flags & ZIP_ENCRYPTED_FLAGS) !== 0) {
      throw new TvBugInputError(`${name} uses unsupported ZIP encryption.`);
    }
    if ((flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0) {
      throw new TvBugInputError(`${name} uses an unsupported ZIP data descriptor.`);
    }
    if (compression !== 0 && compression !== 8) {
      throw new TvBugInputError(`${name} uses an unsupported ZIP compression method.`);
    }
    const limit = FILE_LIMITS.get(name);
    if (originalSize > limit) throw new TvBugInputError(`${name} exceeds its size limit.`);
    totalSize += originalSize;
    if (totalSize > MAX_UNCOMPRESSED_BYTES) {
      throw new TvBugInputError('The uncompressed .tvbug bundle exceeds 10 MiB.');
    }

    const local = inspectLocalZipEntry(archive, {
      centralOffset,
      compressedSize,
      compression,
      crc32,
      flags,
      localOffset,
      name,
      originalSize,
    });
    entries.push({
      compressedSize,
      compression,
      crc32,
      localOffset,
      name,
      originalSize,
      dataEnd: local.dataEnd,
    });
    seen.add(name);
    offset = nextOffset;
  }
  if (offset !== endOffset || seen.size !== REQUIRED_FILES.size) {
    throw new TvBugInputError('The ZIP central directory is malformed.');
  }

  entries.sort((left, right) => left.localOffset - right.localOffset);
  let expectedOffset = 0;
  for (const entry of entries) {
    if (entry.localOffset !== expectedOffset) {
      throw new TvBugInputError('The ZIP contains overlapping, hidden, or padded file data.');
    }
    expectedOffset = entry.dataEnd;
  }
  if (expectedOffset !== centralOffset) {
    throw new TvBugInputError('The ZIP contains unlisted file data.');
  }
  return entries;
}

function inspectLocalZipEntry(archive, expected) {
  const offset = expected.localOffset;
  if (offset + 30 > expected.centralOffset || readUint32(archive, offset) !== ZIP_LOCAL_SIGNATURE) {
    throw new TvBugInputError(`${expected.name} has a malformed local ZIP header.`);
  }
  const flags = readUint16(archive, offset + 6);
  const compression = readUint16(archive, offset + 8);
  const crc32 = readUint32(archive, offset + 14);
  const compressedSize = readUint32(archive, offset + 18);
  const originalSize = readUint32(archive, offset + 22);
  const nameLength = readUint16(archive, offset + 26);
  const extraLength = readUint16(archive, offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  if (dataOffset > expected.centralOffset) {
    throw new TvBugInputError(`${expected.name} has a truncated local ZIP header.`);
  }
  const name = readArchiveName(archive, offset + 30, nameLength);
  if (
    name !== expected.name ||
    flags !== expected.flags ||
    compression !== expected.compression ||
    crc32 !== expected.crc32 ||
    compressedSize !== expected.compressedSize ||
    originalSize !== expected.originalSize
  ) {
    throw new TvBugInputError(`${expected.name} has inconsistent ZIP metadata.`);
  }
  const dataEnd = dataOffset + compressedSize;
  if (dataEnd > expected.centralOffset) {
    throw new TvBugInputError(`${expected.name} has truncated ZIP data.`);
  }
  return { dataEnd };
}

function unpackArchive(archive, entries) {
  const expected = new Map(entries.map((entry) => [entry.name, entry]));
  const started = new Set();
  const files = Object.create(null);
  let failure;
  const unzip = new Unzip((file) => {
    try {
      const entry = expected.get(file.name);
      if (!entry) throw new TvBugInputError(`Unexpected path in .tvbug bundle: ${file.name}`);
      if (started.has(file.name)) {
        throw new TvBugInputError(`Duplicate path in .tvbug bundle: ${file.name}`);
      }
      if (
        file.compression !== entry.compression ||
        file.size !== entry.compressedSize ||
        file.originalSize !== entry.originalSize
      ) {
        throw new TvBugInputError(`${file.name} has inconsistent ZIP metadata.`);
      }
      started.add(file.name);
      const output = new Uint8Array(entry.originalSize);
      let outputOffset = 0;
      let crc32 = 0xffffffff;
      file.ondata = (error, chunk, final) => {
        if (failure) return;
        if (error) {
          failure = new TvBugInputError(`Cannot decompress ${file.name}: ${errorMessage(error)}`);
          return;
        }
        if (!(chunk instanceof Uint8Array) || outputOffset + chunk.byteLength > output.byteLength) {
          failure = new TvBugInputError(`${file.name} expands beyond its declared size.`);
          return;
        }
        output.set(chunk, outputOffset);
        outputOffset += chunk.byteLength;
        crc32 = updateCrc32(crc32, chunk);
        if (!final) return;
        if (outputOffset !== output.byteLength) {
          failure = new TvBugInputError(`${file.name} did not expand to its declared size.`);
          return;
        }
        if ((crc32 ^ 0xffffffff) >>> 0 !== entry.crc32) {
          failure = new TvBugInputError(`${file.name} failed its ZIP checksum.`);
          return;
        }
        files[file.name] = output;
      };
      file.start();
    } catch (error) {
      failure =
        error instanceof TvBugInputError
          ? error
          : new TvBugInputError(`Cannot unpack the .tvbug ZIP: ${errorMessage(error)}`);
    }
  });
  unzip.register(UnzipInflate);

  try {
    for (let offset = 0; offset < archive.byteLength && !failure; offset += ZIP_CHUNK_BYTES) {
      const end = Math.min(archive.byteLength, offset + ZIP_CHUNK_BYTES);
      unzip.push(archive.subarray(offset, end), end === archive.byteLength);
    }
  } catch (error) {
    if (failure) throw failure;
    throw new TvBugInputError(`Cannot unpack the .tvbug ZIP: ${errorMessage(error)}`);
  }
  if (failure) throw failure;
  for (const fileName of REQUIRED_FILES) {
    if (!(files[fileName] instanceof Uint8Array)) {
      throw new TvBugInputError(`Missing ${fileName} in .tvbug bundle.`);
    }
  }
  return files;
}

function readUint16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.byteLength) return -1;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.byteLength) return -1;
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readArchiveName(bytes, offset, length) {
  if (length > 256 || offset < 0 || offset + length > bytes.byteLength) {
    throw new TvBugInputError('The ZIP contains an invalid file name.');
  }
  let result = '';
  for (let index = 0; index < length; index += 1) {
    const value = bytes[offset + index];
    if (value > 0x7f) throw new TvBugInputError('The ZIP contains a non-ASCII file name.');
    result += String.fromCharCode(value);
  }
  return result;
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function updateCrc32(crc32, bytes) {
  let value = crc32;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function decodeUtf8(bytes, fileName) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TvBugInputError(`${fileName} is not valid UTF-8: ${errorMessage(error)}`);
  }
}

function parseJson(bytes, fileName) {
  const source = decodeUtf8(bytes, fileName);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new TvBugInputError(`${fileName} contains malformed JSON: ${errorMessage(error)}`);
  }
}

function validateManifest(value) {
  const manifest = requireRecord(value, 'manifest.json');
  if (manifest.format !== FORMAT || manifest.version !== VERSION) {
    throw new TvBugInputError(`Unsupported .tvbug format: expected ${FORMAT} version ${VERSION}.`);
  }

  requireRecord(manifest.producer, 'manifest.json producer');
  const capture = requireRecord(manifest.capture, 'manifest.json capture');
  requireFiniteNumber(capture.durationMs, 'manifest.json capture.durationMs', { minimum: 0 });
  requireFiniteNumber(capture.tabCount, 'manifest.json capture.tabCount', {
    integer: true,
    minimum: 1,
  });
  if (typeof capture.complete !== 'boolean' || typeof capture.truncated !== 'boolean') {
    throw new TvBugInputError('manifest.json capture flags must be booleans.');
  }

  const privacy = requireRecord(manifest.privacy, 'manifest.json privacy');
  if (
    privacy.profile !== 'account-free-v2' ||
    privacy.rawText !== false ||
    privacy.rawMedia !== false ||
    privacy.stableIdentifiers !== false ||
    privacy.authMaterial !== false
  ) {
    throw new TvBugInputError('The bundle does not declare the account-free-v2 privacy profile.');
  }

  if (manifest.environment !== undefined) {
    const environment = requireRecord(manifest.environment, 'manifest.json environment');
    if (environment.viewport !== undefined) {
      if (
        !Array.isArray(environment.viewport) ||
        environment.viewport.length !== 2 ||
        environment.viewport.some(
          (part) => !Number.isSafeInteger(part) || part < 1 || part > MAX_VIEWPORT_EDGE,
        )
      ) {
        throw new TvBugInputError('manifest.json environment.viewport is invalid.');
      }
    }
    if (environment.deviceScaleFactor !== undefined) {
      const scale = requireFiniteNumber(
        environment.deviceScaleFactor,
        'manifest.json environment.deviceScaleFactor',
        { minimum: 0.1 },
      );
      if (scale > 10) {
        throw new TvBugInputError(
          'manifest.json environment.deviceScaleFactor must not exceed 10.',
        );
      }
    }
    if (environment.viewport !== undefined) {
      const scale = environment.deviceScaleFactor ?? 1;
      const [width, height] = environment.viewport;
      if (
        width > MAX_VIEWPORT_EDGE ||
        height > MAX_VIEWPORT_EDGE ||
        width * scale > MAX_DEVICE_EDGE ||
        height * scale > MAX_DEVICE_EDGE ||
        width * height * scale * scale > MAX_DEVICE_PIXELS
      ) {
        throw new TvBugInputError(
          'manifest.json viewport and device scale exceed the safe inspection limit.',
        );
      }
    }
    if (
      environment.colorScheme !== undefined &&
      environment.colorScheme !== 'light' &&
      environment.colorScheme !== 'dark'
    ) {
      throw new TvBugInputError('manifest.json environment.colorScheme is invalid.');
    }
    if (environment.reducedMotion !== undefined && typeof environment.reducedMotion !== 'boolean') {
      throw new TvBugInputError('manifest.json environment.reducedMotion must be a boolean.');
    }
    if (environment.timezoneOffsetMinutes !== undefined) {
      const offset = requireFiniteNumber(
        environment.timezoneOffsetMinutes,
        'manifest.json environment.timezoneOffsetMinutes',
        { integer: true },
      );
      if (offset < -840 || offset > 720) {
        throw new TvBugInputError(
          'manifest.json environment.timezoneOffsetMinutes is outside the supported range.',
        );
      }
    }
    if (environment.timezone !== undefined) {
      if (
        typeof environment.timezone !== 'string' ||
        environment.timezone.length > 100 ||
        !isValidTimezone(environment.timezone)
      ) {
        throw new TvBugInputError('manifest.json environment.timezone is invalid.');
      }
    }
    if (environment.locale !== undefined) {
      if (typeof environment.locale !== 'string' || environment.locale.length > 100) {
        throw new TvBugInputError('manifest.json environment.locale is invalid.');
      }
      try {
        new Intl.Locale(environment.locale);
      } catch {
        throw new TvBugInputError('manifest.json environment.locale is invalid.');
      }
    }
  }
  validateJsonNumbers(manifest, 'manifest.json');
  return manifest;
}

function validateState(value) {
  const state = requireRecord(value, 'snapshot.v2.json');
  if (state.version !== VERSION) {
    throw new TvBugInputError(`snapshot.v2.json must use version ${VERSION}.`);
  }
  requireFiniteNumber(state.epoch, 'snapshot.v2.json epoch', { integer: true, minimum: 0 });
  if (!Array.isArray(state.dialogs) || !Array.isArray(state.messages)) {
    throw new TvBugInputError('snapshot.v2.json must contain dialogs and messages arrays.');
  }
  if (
    !isRecord(state.histories) ||
    !isRecord(state.drafts) ||
    !isRecord(state.draftMetrics) ||
    !isRecord(state.draftRevisions) ||
    !Array.isArray(state.pending) ||
    !isRecord(state.pinnedMessages) ||
    !isRecord(state.groupMembers) ||
    !isRecord(state.workspace) ||
    !isRecord(state.runtime)
  ) {
    throw new TvBugInputError('snapshot.v2.json is missing snapshot state collections.');
  }
  for (const [label, collection] of [
    ['dialogs', state.dialogs],
    ['messages', state.messages],
    ['pending', state.pending],
  ]) {
    if (collection.length > 100_000) {
      throw new TvBugInputError(`snapshot.v2.json ${label} exceeds 100,000 items.`);
    }
  }
  let attachmentBytes = 0;
  state.pending.forEach((pending, index) => {
    const record = requireRecord(pending, `snapshot.v2.json pending[${index}]`);
    if (record.attachment !== undefined) {
      attachmentBytes += validateAttachmentBytes(
        record.attachment,
        `snapshot.v2.json pending[${index}].attachment`,
      );
    }
    if (record.album !== undefined) {
      const album = requireRecord(record.album, `snapshot.v2.json pending[${index}].album`);
      if (!Array.isArray(album.attachments)) {
        throw new TvBugInputError(
          `snapshot.v2.json pending[${index}].album.attachments must be an array.`,
        );
      }
      for (
        let attachmentIndex = 0;
        attachmentIndex < album.attachments.length;
        attachmentIndex += 1
      ) {
        attachmentBytes += validateAttachmentBytes(
          album.attachments[attachmentIndex],
          `snapshot.v2.json pending[${index}].album.attachments[${attachmentIndex}]`,
        );
      }
    }
    if (attachmentBytes > MAX_SYNTHETIC_ATTACHMENT_BYTES) {
      throw new TvBugInputError(
        'snapshot.v2.json pending attachments exceed the 256 MiB aggregate placeholder limit.',
      );
    }
  });
  validateJsonNumbers(state, 'snapshot.v2.json');
  return state;
}

function validateAttachmentBytes(value, label) {
  const attachment = requireRecord(value, label);
  const byteSize = requireFiniteNumber(attachment.byteSize, `${label}.byteSize`, {
    integer: true,
    minimum: 0,
  });
  if (byteSize > MAX_SYNTHETIC_ATTACHMENT_BYTES) {
    throw new TvBugInputError(`${label}.byteSize exceeds the 256 MiB materialization limit.`);
  }
  return byteSize;
}

function parseTrace(bytes) {
  const source = decodeUtf8(bytes, 'trace.v2.ndjson');
  const lines = source.split(/\n/u);
  while (lines.length && lines.at(-1)?.trim() === '') lines.pop();
  if (lines.length > MAX_TRACE_EVENTS) {
    throw new TvBugInputError(
      `trace.v2.ndjson exceeds ${MAX_TRACE_EVENTS.toLocaleString('en-US')} events.`,
    );
  }

  const trace = [];
  let previousSequence = -1;
  let previousTime = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const label = `trace.v2.ndjson:${index + 1}`;
    const line = lines[index];
    if (!line.trim()) throw new TvBugInputError(`${label} is blank.`);
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new TvBugInputError(`${label} contains malformed JSON: ${errorMessage(error)}`);
    }
    const event = requireRecord(value, label);
    const sequence = requireFiniteNumber(event.seq, `${label} seq`, { integer: true, minimum: 0 });
    const time = requireFiniteNumber(event.tMs, `${label} tMs`, { minimum: 0 });
    if (sequence <= previousSequence) {
      throw new TvBugInputError(`${label} seq must increase.`);
    }
    if (time < previousTime) {
      throw new TvBugInputError(`${label} tMs must not move backwards.`);
    }
    if (!TRACE_KINDS.has(event.kind)) {
      throw new TvBugInputError(`${label} has an unknown event kind.`);
    }
    validateJsonNumbers(event, label);
    trace.push(event);
    previousSequence = sequence;
    previousTime = time;
  }
  return trace;
}

async function readBundle(bundlePath) {
  let metadata;
  try {
    metadata = await stat(bundlePath);
  } catch (error) {
    throw new TvBugInputError(`Cannot read ${bundlePath}: ${errorMessage(error)}`);
  }
  if (!metadata.isFile()) throw new TvBugInputError(`${bundlePath} is not a file.`);
  if (metadata.size === 0) throw new TvBugInputError('The .tvbug bundle is empty.');
  if (metadata.size > MAX_COMPRESSED_BYTES) {
    throw new TvBugInputError('The compressed .tvbug bundle exceeds 8 MiB.');
  }

  let archive;
  try {
    archive = await readFile(bundlePath);
  } catch (error) {
    throw new TvBugInputError(`Cannot read ${bundlePath}: ${errorMessage(error)}`);
  }
  if (archive.byteLength > MAX_COMPRESSED_BYTES) {
    throw new TvBugInputError('The compressed .tvbug bundle exceeds 8 MiB.');
  }
  const entries = inspectZipArchive(archive);
  const files = unpackArchive(archive, entries);

  for (const fileName of REQUIRED_FILES) {
    if (!(files[fileName] instanceof Uint8Array)) {
      throw new TvBugInputError(`Missing ${fileName} in .tvbug bundle.`);
    }
    if (files[fileName].byteLength > FILE_LIMITS.get(fileName)) {
      throw new TvBugInputError(`${fileName} exceeds its size limit.`);
    }
  }

  const manifest = validateManifest(parseJson(files['manifest.json'], 'manifest.json'));
  const snapshot = validateState(parseJson(files['snapshot.v2.json'], 'snapshot.v2.json'));
  const trace = parseTrace(files['trace.v2.ndjson']);
  return { manifest, snapshot, trace };
}

function contextOptions(manifest) {
  const environment = manifest.environment;
  const options = { serviceWorkers: 'block' };
  if (!environment) return options;
  if (environment.viewport) {
    options.viewport = { width: environment.viewport[0], height: environment.viewport[1] };
  }
  if (environment.deviceScaleFactor !== undefined) {
    options.deviceScaleFactor = environment.deviceScaleFactor;
  }
  if (environment.locale) options.locale = environment.locale;
  if (environment.colorScheme) options.colorScheme = environment.colorScheme;
  if (environment.reducedMotion !== undefined) {
    options.reducedMotion = environment.reducedMotion ? 'reduce' : 'no-preference';
  }
  const timezoneId = environment.timezone ?? fixedTimezoneId(environment.timezoneOffsetMinutes);
  if (timezoneId) options.timezoneId = timezoneId;
  return options;
}

function fixedTimezoneId(offsetMinutes) {
  if (!Number.isSafeInteger(offsetMinutes) || offsetMinutes % 60 !== 0) return undefined;
  const hours = offsetMinutes / 60;
  if (hours === 0) return 'UTC';
  return `Etc/GMT${hours > 0 ? '+' : ''}${hours}`;
}

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isInspectionOrigin(rawUrl, protocol, port) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === protocol &&
    url.hostname === '127.0.0.1' &&
    url.port === String(port) &&
    url.username === '' &&
    url.password === ''
  );
}

async function restrictNetwork(context, port) {
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (isInspectionOrigin(requestUrl, 'http:', port)) await route.continue();
    else await route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', async (socket) => {
    if (isInspectionOrigin(socket.url(), 'ws:', port)) socket.connectToServer();
    else
      await socket.close({
        code: 1008,
        reason: 'External network is disabled during snapshot inspection.',
      });
  });
}

async function waitForInspectionOutcome(page) {
  const statusHandle = await page.waitForFunction(
    () => {
      const status = window.__televechaTvBugStatus;
      if (
        status &&
        typeof status === 'object' &&
        (status.state === 'ready' || status.state === 'error')
      ) {
        return {
          state: status.state,
          ...(typeof status.message === 'string'
            ? { message: status.message.slice(0, 2_000) }
            : {}),
          source: 'runtime',
        };
      }

      const alert = [...document.querySelectorAll('[role="alert"], [data-tvbug-error]')].find(
        (candidate) => {
          const style = getComputedStyle(candidate);
          const bounds = candidate.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            bounds.width > 0 &&
            bounds.height > 0
          );
        },
      );
      if (alert) {
        return {
          state: 'error',
          message: (alert.textContent || 'The app displayed an error.').trim().slice(0, 2_000),
          source: 'dom',
        };
      }

      if (!status) {
        const chatList = document.querySelector('[data-testid="chat-list"]');
        if (chatList) {
          const style = getComputedStyle(chatList);
          const bounds = chatList.getBoundingClientRect();
          if (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            bounds.width > 0 &&
            bounds.height > 0
          ) {
            return { state: 'ready', source: 'dom' };
          }
        }
      }
      return false;
    },
    undefined,
    { timeout: READY_TIMEOUT_MS },
  );
  return statusHandle.jsonValue();
}

async function writeScreenshot(page, screenshotPath) {
  if (!screenshotPath) return;
  await mkdir(dirname(screenshotPath), { recursive: true });
  const extension = extname(screenshotPath).toLowerCase();
  await page.screenshot({
    path: screenshotPath,
    type: extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : 'png',
  });
  console.info(`Screenshot: ${terminalText(screenshotPath)}`);
}

function reportOutcome(outcome) {
  const detail = outcome.message ? ` ${terminalText(outcome.message)}` : '';
  if (outcome.state === 'ready') {
    console.info(`Snapshot status: ready.${detail}`);
    return;
  }
  console.error(`Snapshot status: ${outcome.state}.${detail}`);
}

function watchPageErrors(page) {
  let listener;
  let outcome;
  const promise = new Promise((resolvePageError) => {
    listener = (error) => {
      outcome = { state: 'error', message: errorMessage(error), source: 'page' };
      resolvePageError(outcome);
    };
    page.once('pageerror', listener);
  });
  return {
    promise,
    get outcome() {
      return outcome;
    },
    dispose() {
      page.off('pageerror', listener);
    },
  };
}

async function settledOutcome(page, pageErrors = watchPageErrors(page)) {
  try {
    return await Promise.race([waitForInspectionOutcome(page), pageErrors.promise]);
  } catch (error) {
    return {
      state: 'error',
      message: `Timed out waiting for snapshot readiness. ${errorMessage(error)}`,
      source: 'launcher',
    };
  }
}

async function finalizeOutcome(page, initialOutcome, pageErrors, screenshotPath) {
  let outcome = initialOutcome;
  let screenshotFailed = false;
  try {
    if (outcome.state === 'ready' && !pageErrors.outcome) {
      let timeout;
      const quiescence = new Promise((resolveQuiescence) => {
        timeout = setTimeout(resolveQuiescence, INSPECTION_QUIESCENCE_MS);
      });
      const latePageError = await Promise.race([quiescence, pageErrors.promise]);
      clearTimeout(timeout);
      if (latePageError) outcome = latePageError;
    }
    if (pageErrors.outcome) outcome = pageErrors.outcome;
    outcome = (await currentInspectionFailure(page)) ?? outcome;
    try {
      await writeScreenshot(page, screenshotPath);
    } catch (error) {
      screenshotFailed = true;
      outcome = {
        state: 'error',
        message: `Could not capture the snapshot screenshot. ${errorMessage(error)}`,
        source: 'launcher',
      };
    }
    if (!screenshotFailed) {
      if (pageErrors.outcome) outcome = pageErrors.outcome;
      outcome = (await currentInspectionFailure(page)) ?? outcome;
    }
    return outcome;
  } finally {
    pageErrors.dispose();
  }
}

async function currentInspectionFailure(page) {
  try {
    return await page.evaluate(() => {
      const status = window.__televechaTvBugStatus;
      if (status && typeof status === 'object' && status.state === 'error') {
        return {
          state: status.state,
          ...(typeof status.message === 'string'
            ? { message: status.message.slice(0, 2_000) }
            : {}),
          source: 'runtime',
        };
      }
      const alert = [...document.querySelectorAll('[role="alert"], [data-tvbug-error]')].find(
        (candidate) => {
          const style = getComputedStyle(candidate);
          const bounds = candidate.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            bounds.width > 0 &&
            bounds.height > 0
          );
        },
      );
      return alert
        ? {
            state: 'error',
            message: (alert.textContent || 'The app displayed an error.').trim().slice(0, 2_000),
            source: 'dom',
          }
        : undefined;
    });
  } catch (error) {
    return {
      state: 'error',
      message: `Could not inspect the snapshot page. ${errorMessage(error)}`,
      source: 'launcher',
    };
  }
}

function waitForBrowserOrSignal(browser) {
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      browser.off('disconnected', onDisconnected);
      resolveExit(reason);
    };
    const onSigint = () => finish('SIGINT');
    const onSigterm = () => finish('SIGTERM');
    const onDisconnected = () => finish('browser closed');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    browser.once('disconnected', onDisconnected);
  });
}

function displayAvailable() {
  if (process.platform === 'linux') {
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }
  return true;
}

function errorMessage(error) {
  return terminalText(error instanceof Error ? error.message : String(error));
}

function terminalText(value) {
  let result = '';
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    result +=
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
        ? ' '
        : character;
  }
  return result;
}

function tvbugBundlePlugin(bundle) {
  const source = JSON.stringify(bundle)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return {
    name: 'televecha-tvbug-bundle',
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          { tag: 'script', children: `window.__televechaTvBugBundle=${source};`, injectTo: 'head' },
        ];
      },
    },
  };
}

function waitForStopSignal() {
  return new Promise((resolveStop) => {
    const finish = (signal) => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolveStop(signal);
    };
    const onSigint = () => finish('SIGINT');
    const onSigterm = () => finish('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}

function normalizeKey(value) {
  return value.replace(/[^a-z0-9]/giu, '').toLowerCase();
}

function isForbiddenField(key, value) {
  const normalized = normalizeKey(key);
  if (
    (normalized === 'authmaterial' || normalized === 'rawtext' || normalized === 'rawmedia') &&
    value === false
  ) {
    return false;
  }
  if (normalized === 'requestphonenumber' && typeof value === 'boolean') return false;
  if (FORBIDDEN_KEYS.has(normalized)) return true;
  return [
    'accesshash',
    'apikey',
    'apihash',
    'auth',
    'credential',
    'filereference',
    'password',
    'phone',
    'secret',
    'session',
    'token',
  ].some((fragment) => normalized.includes(fragment));
}

async function runInspection(options) {
  const bundle = await readBundle(options.bundlePath);
  const port = parsePort(process.env.TELEVECHA_TVBUG_PORT);
  const headless = options.headless || !displayAvailable();
  let server;
  let browser;

  console.info(
    `Loaded ${terminalText(options.bundlePath)} with ${bundle.trace.length.toLocaleString('en-US')} trace events.`,
  );
  const capturedTimezoneOffset = bundle.manifest.environment?.timezoneOffsetMinutes;
  if (
    !bundle.manifest.environment?.timezone &&
    Number.isSafeInteger(capturedTimezoneOffset) &&
    capturedTimezoneOffset % 60 !== 0
  ) {
    console.warn(
      `Captured timezone offset ${capturedTimezoneOffset} minutes cannot be applied exactly; inspection will use the host timezone.`,
    );
  }

  try {
    server = await createServer({
      root: PROJECT_ROOT,
      ...(options.serve ? { plugins: [tvbugBundlePlugin(bundle)] } : {}),
      server: { host: '127.0.0.1', port, strictPort: true },
    });
    await server.listen();

    const url = `http://127.0.0.1:${port}/?tvbug=1`;
    if (options.serve) {
      console.info(`Snapshot URL: ${url}`);
      console.info('Serving the snapshot without opening a browser. Press Ctrl+C to stop.');
      await waitForStopSignal();
      return 0;
    }

    browser = await chromium.launch({ headless });
    const context = await browser.newContext(contextOptions(bundle.manifest));
    await restrictNetwork(context, port);
    await context.addInitScript((tvbugBundle) => {
      window.__televechaTvBugBundle = tvbugBundle;
    }, bundle);

    const page = await context.newPage();
    const pageErrors = watchPageErrors(page);
    console.info(`Snapshot URL: ${url}`);
    console.info(`Browser mode: ${headless ? 'headless' : 'headed'}`);
    let navigationOutcome;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      navigationOutcome = {
        state: 'error',
        message: `Could not load the snapshot app. ${errorMessage(error)}`,
        source: 'launcher',
      };
    }

    if (headless) {
      const initialOutcome = navigationOutcome ?? (await settledOutcome(page, pageErrors));
      const outcome = await finalizeOutcome(page, initialOutcome, pageErrors, options.screenshot);
      reportOutcome(outcome);
      return outcome.state === 'ready' ? 0 : 1;
    }

    console.info('The snapshot window will stay open until you close it or press Ctrl+C.');
    let monitoredOutcome;
    const monitor = (
      navigationOutcome ? Promise.resolve(navigationOutcome) : settledOutcome(page, pageErrors)
    )
      .then(async (initialOutcome) => {
        monitoredOutcome = await finalizeOutcome(
          page,
          initialOutcome,
          pageErrors,
          options.screenshot,
        );
        reportOutcome(monitoredOutcome);
      })
      .catch((error) => {
        pageErrors.dispose();
        monitoredOutcome = {
          state: 'error',
          message: `Could not monitor snapshot status. ${errorMessage(error)}`,
          source: 'launcher',
        };
        reportOutcome(monitoredOutcome);
      });
    const reason = await waitForBrowserOrSignal(browser);
    console.info(`Closing snapshot: ${reason}.`);
    await browser.close().catch(() => undefined);
    await monitor;
    return monitoredOutcome?.state === 'ready' ? 0 : 1;
  } finally {
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
}

let exitCode = 0;
try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.info(usage());
  } else {
    exitCode = await runInspection(options);
  }
} catch (error) {
  console.error(`Snapshot inspection failed: ${errorMessage(error)}`);
  if (error instanceof TvBugInputError) console.error(usage());
  exitCode = 1;
}
process.exitCode = exitCode;
