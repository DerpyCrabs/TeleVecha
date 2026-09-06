import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const schemaDirectory = path.join(root, 'src/telegram/mtproto/schema');

const API_LAYER = 228;
const TDLIB_COMMIT = 'b768eb2911f494c0678f4a4ff2c4a0529cb3cc6e';
const TDLIB_RAW_ROOT = `https://raw.githubusercontent.com/tdlib/td/${TDLIB_COMMIT}/td/generate/scheme`;
const API_SCHEMA_URL = `${TDLIB_RAW_ROOT}/telegram_api.tl`;
const MTPROTO_SCHEMA_URL = `${TDLIB_RAW_ROOT}/mtproto_api.tl`;
const EXPECTED_API_SOURCE_SHA256 =
  '921a58e71f2baebb840609366c506fb92ffac8db3c5bb832423aacd7cd6817cf';
const EXPECTED_MTPROTO_SOURCE_SHA256 =
  'bde4942be06dc112dfc655e2a8aa5163a4e3aa0d859d7840cfc76ec3a00654c4';

const LEGACY_TDLIB_COMMIT = 'b18b5309b69b5684405d998a2cce80a49ad474ef';
const LEGACY_MTPROTO_SCHEMA_URL = `https://raw.githubusercontent.com/tdlib/td/${LEGACY_TDLIB_COMMIT}/td/generate/scheme/mtproto_api.tl`;
const EXPECTED_LEGACY_MTPROTO_SOURCE_SHA256 =
  'd0cac1b70002bbfddace3f52781d500079b49d6777e56668ca82281ed633d470';

const CORE_MTPROTO_SCHEMA_URL = 'https://core.telegram.org/schema/mtproto';
const CORE_MTPROTO_BLOCK_SHA256 =
  'b3ef6a9533b772fdcf2a6d8dd236092f799ad8907ab4ca2615e42bded246da4c';

const API_UNTAGGED_DECLARATIONS = new Set([
  'bytes = Bytes;',
  'double ? = Double;',
  'int ? = Int;',
  'int256 = Int256;',
  'long ? = Long;',
  'string ? = String;',
  'test.parseInputAppEvent = InputAppEvent;',
  'test.useConfigSimple = help.ConfigSimple;',
]);

const API_NON_PUBLIC_DECLARATIONS = new Set([
  'ephemeral.editMessage',
  'inputPeerPhotoFileLocationLegacy',
  'inputStickerSetThumbLegacy',
  'invokeWithApnsSecretPrefix',
  'invokeWithBusinessConnectionPrefix',
  'invokeWithGooglePlayIntegrityPrefix',
  'invokeWithReCaptchaPrefix',
  'updateEphemeralBotCallbackQuery',
]);

const MTPROTO_UNTAGGED_DECLARATIONS = new Set([
  'double ? = Double;',
  'dummyHttpWait = HttpWait;',
  'int ? = Int;',
  'int128 4*[ int ] = Int128;',
  'int256 8*[ int ] = Int256;',
  'long ? = Long;',
  'rsa_public_key n:string e:string = RSAPublicKey;',
  'string ? = String;',
  'vector {t:Type} # [ t ] = Vector t;',
]);

const COMMENTED_MTPROTO_DECLARATIONS = new Map([
  [
    'rpc_result#f35c6d01 req_msg_id:long result:string = RpcResult;',
    { kind: 'constructor', line: 'rpc_result#f35c6d01 req_msg_id:long result:Object = RpcResult;' },
  ],
  [
    'destroy_session_ok#e22045fc session_id:long = DestroySessionRes;',
    {
      kind: 'constructor',
      line: 'destroy_session_ok#e22045fc session_id:long = DestroySessionRes;',
    },
  ],
  [
    'destroy_session_none#62d350c9 session_id:long = DestroySessionRes;',
    {
      kind: 'constructor',
      line: 'destroy_session_none#62d350c9 session_id:long = DestroySessionRes;',
    },
  ],
  [
    'msg_container#73f1f8dc messages:vector<%Message> = MessageContainer;',
    {
      kind: 'constructor',
      line: 'msg_container#73f1f8dc messages:vector<%mtproto.message> = MessageContainer;',
    },
  ],
  [
    'message msg_id:long seqno:int bytes:int body:string = Message;',
    {
      kind: 'bare',
      line: 'mtproto.message#00000000 msg_id:long seq_no:int bytes:int body:Object = mtproto.Message;',
    },
  ],
  [
    'msg_copy#e06046b2 orig_message:Message = MessageCopy;',
    { kind: 'constructor', line: 'msg_copy#e06046b2 orig_message:%mtproto.message = MessageCopy;' },
  ],
  [
    'ping#7abe77ec ping_id:long = Pong;',
    { kind: 'method', line: 'ping#7abe77ec ping_id:long = Pong;' },
  ],
  [
    'destroy_session#e7512126 session_id:long = DestroySessionRes;',
    { kind: 'method', line: 'destroy_session#e7512126 session_id:long = DestroySessionRes;' },
  ],
]);

function parseArguments(values) {
  const options = {
    check: false,
    apiTlFile: undefined,
    mtprotoTlFile: undefined,
    legacyMtprotoTlFile: undefined,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--check') {
      options.check = true;
      continue;
    }
    if (
      value === '--api-tl-file' ||
      value === '--mtproto-tl-file' ||
      value === '--legacy-mtproto-tl-file'
    ) {
      const file = values[index + 1];
      if (!file) throw Error(`${value} requires a file path.`);
      index += 1;
      if (value === '--api-tl-file') options.apiTlFile = path.resolve(file);
      if (value === '--mtproto-tl-file') options.mtprotoTlFile = path.resolve(file);
      if (value === '--legacy-mtproto-tl-file') {
        options.legacyMtprotoTlFile = path.resolve(file);
      }
      continue;
    }
    throw Error(`Unknown argument: ${value}`);
  }
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'TeleVecha TL schema fetcher' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw Error(`${url} returned HTTP ${response.status}.`);
  if (response.url !== url) throw Error(`${url} redirected to ${response.url}.`);
  return response.text();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalDefinition(line, sourceName) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_.]*)#([0-9a-fA-F]{1,8})(.*);$/);
  if (!match) throw Error(`Invalid tagged TL definition in ${sourceName}: ${line}`);
  const [, name, id, body] = match;
  if (!body.startsWith(' ') || !body.includes(' = ')) {
    throw Error(`Invalid TL definition body for ${name} in ${sourceName}: ${line}`);
  }
  return { line: `${name}#${id.toLowerCase().padStart(8, '0')}${body};`, name };
}

function parseApiTl(source) {
  const sourceHash = sha256(source);
  if (sourceHash !== EXPECTED_API_SOURCE_SHA256) {
    throw Error(
      `${API_SCHEMA_URL} changed: expected SHA-256 ${EXPECTED_API_SOURCE_SHA256}, got ${sourceHash}.`,
    );
  }

  const constructors = [];
  const methods = [];
  const foundUntagged = new Set();
  const foundNonPublic = new Set();
  let target = constructors;
  for (const originalLine of source.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith('//')) continue;
    if (line === '---types---') {
      target = constructors;
      continue;
    }
    if (line === '---functions---') {
      target = methods;
      continue;
    }
    if (API_UNTAGGED_DECLARATIONS.has(line)) {
      foundUntagged.add(line);
      continue;
    }
    const definition = canonicalDefinition(line, 'telegram_api.tl');
    if (API_NON_PUBLIC_DECLARATIONS.has(definition.name)) {
      foundNonPublic.add(definition.name);
      continue;
    }
    target.push(definition.line);
  }
  if (foundUntagged.size !== API_UNTAGGED_DECLARATIONS.size) {
    const missing = [...API_UNTAGGED_DECLARATIONS].filter((line) => !foundUntagged.has(line));
    throw Error(`TDLib API prelude changed; missing: ${missing.join(', ')}`);
  }
  if (foundNonPublic.size !== API_NON_PUBLIC_DECLARATIONS.size) {
    const missing = [...API_NON_PUBLIC_DECLARATIONS].filter((name) => !foundNonPublic.has(name));
    throw Error(`TDLib non-public declarations changed; missing: ${missing.join(', ')}`);
  }

  constructors.sort(compareText);
  methods.sort(compareText);
  return { constructors, methods, sourceHash };
}

function mtprotoBytes(line) {
  return line.replace(
    /\b(pq|p|q|encrypted_answer|dh_prime|g_a|g_b|encrypted_data|info):string\b/g,
    '$1:bytes',
  );
}

function legacyServerDhParamsFail(source) {
  const sourceHash = sha256(source);
  if (sourceHash !== EXPECTED_LEGACY_MTPROTO_SOURCE_SHA256) {
    throw Error(
      `${LEGACY_MTPROTO_SCHEMA_URL} changed: expected SHA-256 ${EXPECTED_LEGACY_MTPROTO_SOURCE_SHA256}, got ${sourceHash}.`,
    );
  }
  const matches = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('server_DH_params_fail#'));
  if (matches.length !== 1) throw Error('Could not isolate legacy server_DH_params_fail.');
  return { definition: canonicalDefinition(matches[0], 'legacy mtproto_api.tl').line, sourceHash };
}

function parseMtprotoTl(source, legacySource) {
  const sourceHash = sha256(source);
  if (sourceHash !== EXPECTED_MTPROTO_SOURCE_SHA256) {
    throw Error(
      `${MTPROTO_SCHEMA_URL} changed: expected SHA-256 ${EXPECTED_MTPROTO_SOURCE_SHA256}, got ${sourceHash}.`,
    );
  }

  const constructors = [];
  const methods = [];
  const bare = [];
  const foundUntagged = new Set();
  const foundCommented = new Set();
  let target = constructors;
  for (const originalLine of source.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line) continue;
    if (line === '---types---') {
      target = constructors;
      continue;
    }
    if (line === '---functions---') {
      target = methods;
      continue;
    }
    if (MTPROTO_UNTAGGED_DECLARATIONS.has(line)) {
      foundUntagged.add(line);
      continue;
    }
    if (line.startsWith('//')) {
      const declaration = line.slice(2).trim();
      const canonical = COMMENTED_MTPROTO_DECLARATIONS.get(declaration);
      if (canonical) {
        foundCommented.add(declaration);
        if (canonical.kind === 'constructor') constructors.push(canonical.line);
        if (canonical.kind === 'method') methods.push(canonical.line);
        if (canonical.kind === 'bare') bare.push(canonical.line);
      }
      continue;
    }

    let canonicalLine = mtprotoBytes(line);
    if (canonicalLine.startsWith('gzip_packed#')) {
      canonicalLine = canonicalLine.replace('packed_data:string', 'packed_data:bytes');
      canonicalLine = canonicalLine.replace(' = GzipPacked;', ' = Object;');
    }
    const definition = canonicalDefinition(canonicalLine, 'mtproto_api.tl');
    if (definition.name === 'http_wait') constructors.push(definition.line);
    else target.push(definition.line);
  }
  if (foundUntagged.size !== MTPROTO_UNTAGGED_DECLARATIONS.size) {
    const missing = [...MTPROTO_UNTAGGED_DECLARATIONS].filter((line) => !foundUntagged.has(line));
    throw Error(`TDLib MTProto prelude changed; missing: ${missing.join(', ')}`);
  }
  if (foundCommented.size !== COMMENTED_MTPROTO_DECLARATIONS.size) {
    const missing = [...COMMENTED_MTPROTO_DECLARATIONS.keys()].filter(
      (line) => !foundCommented.has(line),
    );
    throw Error(`TDLib commented MTProto declarations changed; missing: ${missing.join(', ')}`);
  }
  if (bare.length !== 1) throw Error(`Expected one bare MTProto declaration, got ${bare.length}.`);

  const legacy = legacyServerDhParamsFail(legacySource);
  constructors.push(legacy.definition);
  constructors.sort(compareText);
  methods.sort(compareText);
  return {
    constructors: [...constructors, ...bare],
    methods,
    sourceHash,
    legacySourceHash: legacy.sourceHash,
  };
}

function renderSchema({ sourceHeaders, constructors, methods, layer }) {
  return [
    '// Generated by scripts/fetch-telegram-tl.mjs. Do not edit by hand.',
    ...sourceHeaders.map((header) => `// ${header}`),
    ...(layer === undefined ? [] : [`// Telegram API layer: ${layer}`]),
    '',
    '---types---',
    '',
    ...constructors,
    '',
    '---functions---',
    '',
    ...methods,
    '',
  ].join('\n');
}

async function writeOrCheck(fileName, content, check) {
  const location = path.join(schemaDirectory, fileName);
  if (check) {
    const current = await fs.readFile(location, 'utf8').catch(() => undefined);
    if (current !== content) {
      process.stderr.write(
        `${path.relative(root, location)} is stale. Run npm run fetch:telegram-tl.\n`,
      );
      process.exitCode = 1;
    }
    return;
  }
  await fs.mkdir(schemaDirectory, { recursive: true });
  await fs.writeFile(location, content);
}

const options = parseArguments(process.argv.slice(2));
const [apiSource, mtprotoSource, legacyMtprotoSource] = await Promise.all([
  options.apiTlFile ? fs.readFile(options.apiTlFile, 'utf8') : fetchText(API_SCHEMA_URL),
  options.mtprotoTlFile
    ? fs.readFile(options.mtprotoTlFile, 'utf8')
    : fetchText(MTPROTO_SCHEMA_URL),
  options.legacyMtprotoTlFile
    ? fs.readFile(options.legacyMtprotoTlFile, 'utf8')
    : fetchText(LEGACY_MTPROTO_SCHEMA_URL),
]);
const api = parseApiTl(apiSource);
const mtproto = parseMtprotoTl(mtprotoSource, legacyMtprotoSource);

await Promise.all([
  writeOrCheck(
    `api-layer-${API_LAYER}.tl`,
    renderSchema({
      sourceHeaders: [
        `Official Telegram source: ${API_SCHEMA_URL}`,
        `Source commit: ${TDLIB_COMMIT}`,
        `Source SHA-256: ${api.sourceHash}`,
      ],
      constructors: api.constructors,
      methods: api.methods,
      layer: API_LAYER,
    }),
    options.check,
  ),
  writeOrCheck(
    'mtproto.tl',
    renderSchema({
      sourceHeaders: [
        `Official Telegram source: ${MTPROTO_SCHEMA_URL}`,
        `Source commit: ${TDLIB_COMMIT}`,
        `Source SHA-256: ${mtproto.sourceHash}`,
        `Legacy server_DH_params_fail source: ${LEGACY_MTPROTO_SCHEMA_URL}`,
        `Legacy source commit: ${LEGACY_TDLIB_COMMIT}`,
        `Legacy source SHA-256: ${mtproto.legacySourceHash}`,
        `Wire-schema validation: ${CORE_MTPROTO_SCHEMA_URL}`,
        `Canonical core.telegram.org code-block SHA-256: ${CORE_MTPROTO_BLOCK_SHA256}`,
      ],
      constructors: mtproto.constructors,
      methods: mtproto.methods,
    }),
    options.check,
  ),
]);

process.stdout.write(
  [
    `API source SHA-256: ${api.sourceHash}`,
    `API definitions: ${api.constructors.length} constructors, ${api.methods.length} methods`,
    `MTProto source SHA-256: ${mtproto.sourceHash}`,
    `MTProto definitions: ${mtproto.constructors.length} constructors, ${mtproto.methods.length} methods`,
    `Legacy MTProto source SHA-256: ${mtproto.legacySourceHash}`,
  ].join('\n') + '\n',
);
