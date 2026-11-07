import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { format } from 'oxfmt';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const schemaDirectory = path.join(root, 'src/telegram/mtproto/schema');
const outputDirectory = path.join(root, 'src/telegram/mtproto/tl');
const check = process.argv.slice(2).includes('--check');

const schemaFiles = [
  path.join(schemaDirectory, 'api-layer-228.tl'),
  path.join(schemaDirectory, 'mtproto.tl'),
];

const internalFactories = [
  'BadMsgNotification',
  'BadServerSalt',
  'ClientDHInnerData',
  'DhGenFail',
  'DhGenOk',
  'DhGenRetry',
  'GzipPacked',
  'HttpWait',
  'InitConnection',
  'InputFile',
  'InputFileBig',
  'InvokeAfterMsg',
  'InvokeWithLayer',
  'MsgDetailedInfo',
  'MsgNewDetailedInfo',
  'MsgResendReq',
  'MsgsAck',
  'MsgsAllInfo',
  'MsgsStateInfo',
  'MsgsStateReq',
  'NewSessionCreated',
  'PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow',
  'PasswordKdfAlgoUnknown',
  'PQInnerDataDc',
  'PingDelayDisconnect',
  'Pong',
  'ReqDHParams',
  'ReqPqMulti',
  'ResPQ',
  'RpcError',
  'ServerDHInnerData',
  'ServerDHParamsFail',
  'ServerDHParamsOk',
  'SetClientDHParams',
  'auth.ExportAuthorization',
  'auth.ImportAuthorization',
  'account.Password',
  'help.GetConfig',
  'upload.GetFile',
  'upload.SaveBigFilePart',
  'upload.SaveFilePart',
  'users.GetUsers',
];

const boundedServiceMessageVectors = new Set([
  'msg_resend_req.msg_ids',
  'msgs_ack.msg_ids',
  'msgs_state_req.msg_ids',
]);

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(value, 'utf8')) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function lowerCamel(value) {
  return value.replace(/_([a-zA-Z0-9])/g, (_match, letter) => letter.toUpperCase());
}

function pascal(value) {
  const camel = lowerCamel(value);
  return camel ? camel[0].toUpperCase() + camel.slice(1) : camel;
}

function typeNameFor(rawName) {
  const parts = rawName.split('.');
  const local = parts.pop();
  return [...parts, pascal(local)].join('.');
}

function primitive(name) {
  return { kind: 'primitive', name };
}

const primitiveNames = Object.freeze([
  'int',
  'long',
  'int128',
  'int256',
  'double',
  'string',
  'bytes',
  'Bool',
  'true',
  '#',
]);

function parseType(rawType) {
  if (rawType.startsWith('!')) return { kind: 'generic', name: rawType.slice(1) };
  if (rawType.startsWith('%')) {
    return { kind: 'object', name: rawType.slice(1), bare: true };
  }
  if (primitiveNames.includes(rawType)) return primitive(rawType);
  const vector = rawType.match(/^([Vv])ector<(.+)>$/);
  if (vector) {
    return { kind: 'vector', item: parseType(vector[2]), bare: vector[1] === 'v' };
  }
  if (/^[A-Z]$/.test(rawType)) return { kind: 'generic', name: rawType };
  const localName = rawType.split('.').at(-1) ?? rawType;
  return { kind: 'object', name: rawType, bare: /^[a-z]/.test(localName) };
}

function constructorId(line, explicitId) {
  if (explicitId) return Number.parseInt(explicitId, 16) >>> 0;
  const canonical = line
    .slice(0, -1)
    .replace(/(:|\?)bytes(?=\s)/g, '$1string')
    .replace(/</g, ' ')
    .replace(/[>{}]/g, '')
    .replace(/ \w+:flags\d*\.\d+\?true/g, '');
  return crc32(canonical);
}

function parseDefinition(line, kind) {
  const match = line.match(/^([\w.]+)(?:#([0-9a-fA-F]+))?\s*(.*?)\s=\s([^;]+);$/);
  if (!match) throw Error(`Cannot parse TL definition: ${line}`);
  const [, name, id, fieldSource, resultSource] = match;
  const fields = [];
  const tokens = fieldSource.match(/\{[^}]+\}|[^\s]+/g) ?? [];
  for (const token of tokens) {
    if (token === '#' || token === '[' || token === ']' || token === 't') continue;
    if (token.startsWith('{') && token.endsWith('}')) continue;
    const field = token.match(/^([^:]+):(.+)$/);
    if (!field) throw Error(`Cannot parse TL field ${token} in ${name}.`);
    const wireName = field[1];
    let rawType = field[2];
    const flag = rawType.match(/^(flags\d*)\.(\d+)\?(.+)$/);
    const descriptor = { name: lowerCamel(wireName), wireName, type: undefined };
    if (flag) {
      descriptor.flag = { field: lowerCamel(flag[1]), bit: Number(flag[2]) };
      rawType = flag[3];
    }
    descriptor.type = parseType(rawType);
    if (boundedServiceMessageVectors.has(`${name}.${wireName}`)) {
      descriptor.decodeMaxVectorLength = 8_192;
    }
    if (rawType === '#') descriptor.flagIndicator = true;
    fields.push(descriptor);
  }
  return {
    id: constructorId(line, id),
    name,
    typeName: typeNameFor(name),
    kind,
    result: parseType(resultSource.trim()),
    fields,
  };
}

function parseSchema(source) {
  const definitions = [];
  let kind = 'constructor';
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const originalLine of withoutBlocks.split(/\r?\n/)) {
    const line = originalLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const section = line.match(/^---(types|functions)---$/);
    if (section) {
      kind = section[1] === 'functions' ? 'method' : 'constructor';
      continue;
    }
    if (line.startsWith('vector#')) continue;
    definitions.push(parseDefinition(line, line.startsWith('mtproto.message#') ? 'bare' : kind));
  }
  return definitions;
}

function uniqueSorted(values) {
  return Object.keys(Object.fromEntries(values.map((value) => [value, true]))).sort();
}

async function sourceFilesForPublicScan() {
  const explicit = [
    path.join(root, 'src/telegram/transports/webTelegramTransport.ts'),
    path.join(root, 'src/telegram/transports/qrLogin.ts'),
    path.join(root, 'src/telegram/transports/qrLogin.test.ts'),
    path.join(root, 'src/telegram/transports/webTelegramTransport.test.ts'),
  ];
  const mtprotoDirectory = path.join(root, 'src/telegram/mtproto');
  const walk = async (directory) => {
    const files = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['schema', 'tl'].includes(entry.name)) files.push(...(await walk(location)));
      } else if (entry.name.endsWith('.ts')) {
        files.push(location);
      }
    }
    return files;
  };
  return uniqueSorted([...explicit, ...(await walk(mtprotoDirectory))]);
}

async function publicReferences() {
  const factories = [...internalFactories];
  const aliases = [];
  for (const file of await sourceFilesForPublicScan()) {
    const source = await fs.readFile(file, 'utf8').catch(() => '');
    for (const match of source.matchAll(/\b(Api|Tl)((?:\.[A-Za-z_$][\w$]*)+)/g)) {
      const catalog = match[1];
      const parts = match[2].slice(1).split('.');
      if (['id', 'is', 'kind', 'result', 'tlName'].includes(parts.at(-1))) parts.pop();
      const reference = parts.join('.');
      const local = reference.split('.').at(-1) ?? reference;
      if (catalog === 'Tl' && ['Any', 'AnyRequest', 'Request', 'ResultOf'].includes(local))
        continue;
      if (local.startsWith('Type')) aliases.push(reference);
      else factories.push(reference);
    }
  }
  return { factories: uniqueSorted(factories), aliases: uniqueSorted(aliases) };
}

function generatedHeader() {
  return `// Generated by scripts/generate-telegram-tl.mjs from the pinned layer-228 schemas.\n// Do not edit by hand.\n`;
}

function schemaModule(definitions) {
  return `${generatedHeader()}import type { TlDescriptor } from './types';\n\nexport const RAW_TL_DESCRIPTORS: readonly TlDescriptor[] = ${JSON.stringify(definitions, null, 2)};\n`;
}

function quote(value) {
  return JSON.stringify(value);
}

function typeScriptType(type) {
  if (type.kind === 'vector') return `readonly (${typeScriptType(type.item)})[]`;
  if (type.kind === 'generic') return 'unknown';
  if (type.kind === 'object') {
    if (type.name === 'Object') return 'AnyTlObject';
    return type.bare ? `Tl.${typeNameFor(type.name)}` : `Tl.${resultAliasName(type.name)}`;
  }
  switch (type.name) {
    case 'int':
    case 'date':
    case 'double':
    case '#':
      return 'number';
    case 'long':
      return 'bigint';
    case 'int128':
    case 'int256':
      return 'bigint';
    case 'string':
      return 'string';
    case 'bytes':
      return 'Uint8Array';
    case 'Bool':
      return 'boolean';
    case 'true':
      return 'true';
    default:
      return 'unknown';
  }
}

function namespaceTree() {
  return { types: [], children: Object.create(null) };
}

function treeAt(rootNode, namespaces) {
  let node = rootNode;
  for (const namespace of namespaces) {
    node.children[namespace] ??= namespaceTree();
    node = node.children[namespace];
  }
  return node;
}

function fieldsType(descriptor) {
  const fields = descriptor.fields.filter((field) => !field.flagIndicator);
  if (fields.length === 0) return 'Readonly<Record<never, never>>';
  return `Readonly<{\n${fields
    .map(
      (field) =>
        `      ${JSON.stringify(field.name)}${field.flag ? '?' : ''}: ${typeScriptType(field.type)};`,
    )
    .join('\n')}\n    }>`;
}

function resultTags(resultName, definitions) {
  return definitions
    .filter(
      (descriptor) =>
        descriptor.kind !== 'method' &&
        descriptor.result.kind === 'object' &&
        descriptor.result.name === resultName,
    )
    .map((descriptor) => descriptor.name)
    .sort();
}

function resultAliasName(resultName) {
  const parts = resultName.split('.');
  const local = parts.pop();
  return [...parts, `Type${pascal(local)}`].join('.');
}

function resultTypeScriptType(type) {
  return typeScriptType(type);
}

function typeClosure(factoryDescriptors, explicitAliases, definitions) {
  const byName = Object.create(null);
  const byResult = Object.create(null);
  for (const descriptor of definitions) {
    byName[descriptor.name] = descriptor;
    if (descriptor.kind === 'method' || descriptor.result.kind !== 'object') continue;
    const variants = byResult[descriptor.result.name] ?? [];
    variants.push(descriptor);
    byResult[descriptor.result.name] = variants;
  }

  const selected = Object.create(null);
  const aliases = Object.fromEntries(explicitAliases.map((alias) => [alias, true]));
  const queue = [];
  const select = (descriptor) => {
    if (!descriptor || selected[descriptor.name]) return;
    selected[descriptor.name] = descriptor;
    queue.push(descriptor);
  };
  const visitType = (type) => {
    if (type.kind === 'vector') {
      visitType(type.item);
      return;
    }
    if (type.kind !== 'object' || type.name === 'Object') return;
    if (type.bare) {
      select(byName[type.name]);
      return;
    }
    aliases[resultAliasName(type.name)] = true;
    for (const descriptor of byResult[type.name] ?? []) select(descriptor);
  };

  for (const descriptor of factoryDescriptors) select(descriptor);
  for (const aliasName of explicitAliases) {
    const parts = aliasName.split('.');
    const local = parts.pop();
    visitType({
      kind: 'object',
      name: [...parts, local.replace(/^Type/, '')].join('.'),
      bare: false,
    });
  }
  for (let index = 0; index < queue.length; index += 1) {
    const descriptor = queue[index];
    for (const field of descriptor.fields) visitType(field.type);
    if (descriptor.kind === 'method') visitType(descriptor.result);
  }

  return {
    aliases: Object.keys(aliases).sort(),
    descriptors: Object.values(selected).sort(
      (left, right) =>
        left.typeName.localeCompare(right.typeName) || left.kind.localeCompare(right.kind),
    ),
  };
}

function typeNamespaceModule(factoryDescriptors, aliasNames, definitions) {
  const closure = typeClosure(factoryDescriptors, aliasNames, definitions);
  const tree = namespaceTree();
  for (const descriptor of closure.descriptors) {
    const parts = descriptor.typeName.split('.');
    const local = parts.pop();
    const node = treeAt(tree, parts);
    const fieldAlias = `${local}Fields`;
    node.types.push(`export type ${fieldAlias} = ${fieldsType(descriptor)};`);
    const requestResult =
      descriptor.kind === 'method'
        ? ` & TlRequest<${resultTypeScriptType(descriptor.result)}>`
        : '';
    node.types.push(
      `export type ${local} = TlObject<${quote(descriptor.name)}> & ${fieldAlias}${requestResult};`,
    );
  }
  const selectedNames = Object.fromEntries(
    closure.descriptors.map((descriptor) => [descriptor.name, true]),
  );
  for (const aliasName of closure.aliases) {
    const parts = aliasName.split('.');
    const local = parts.pop();
    const node = treeAt(tree, parts);
    const resultName = [...parts, local.replace(/^Type/, '')].join('.');
    const variants = definitions.filter(
      (descriptor) =>
        descriptor.kind !== 'method' &&
        descriptor.result.kind === 'object' &&
        descriptor.result.name === resultName &&
        selectedNames[descriptor.name],
    );
    const union = variants.map((descriptor) => `Tl.${descriptor.typeName}`).join(' | ');
    const tags = resultTags(resultName, definitions).map(quote).join(' | ');
    node.types.push(
      `export type ${local} = ${union || `AnyTlObject & { readonly _: ${tags || 'string'} }`};`,
    );
  }

  const render = (node, indent) => {
    const lines = [];
    for (const type of uniqueSorted(node.types)) lines.push(`${indent}${type}`);
    for (const name of Object.keys(node.children).sort()) {
      lines.push(`${indent}export namespace ${name} {`);
      lines.push(render(node.children[name], `${indent}  `));
      lines.push(`${indent}}`);
    }
    return lines.join('\n');
  };

  const requestTypes = factoryDescriptors
    .filter((descriptor) => descriptor.kind === 'method')
    .map((descriptor) => `Tl.${descriptor.typeName}`);
  return `${generatedHeader()}import type { AnyTlObject, TlObject, TlRequest, TlResultOf } from './types';\n\nexport declare namespace Tl {\n  export type Any = AnyTlObject;\n  export type Request<Result = unknown> = TlRequest<Result>;\n  export type ResultOf<Request> = TlResultOf<Request>;\n  export type AnyRequest = ${requestTypes.join(' | ') || 'TlRequest<unknown> & AnyTlObject'};\n${render(tree, '  ')}\n}\n`;
}

function factoryModule(factoryDescriptors) {
  const tree = { values: [], children: Object.create(null) };
  const declarations = [];
  for (const descriptor of factoryDescriptors) {
    const parts = descriptor.typeName.split('.');
    const local = parts.pop();
    const variable = `$${parts.length ? `${parts.join('_')}_` : ''}${local}`;
    declarations.push(
      `const ${variable} = createTlFactory<Tl.${[...parts, local].join('.')}, Tl.${[
        ...parts,
        `${local}Fields`,
      ].join('.')}>(${quote(descriptor.name)});`,
    );
    let node = tree;
    for (const namespace of parts) {
      node.children[namespace] ??= { values: [], children: Object.create(null) };
      node = node.children[namespace];
    }
    node.values.push({ local, variable });
  }

  const render = (node, indent) => {
    const lines = [];
    for (const value of node.values.sort((left, right) => left.local.localeCompare(right.local))) {
      lines.push(`${indent}${value.local}: ${value.variable},`);
    }
    for (const name of Object.keys(node.children).sort()) {
      lines.push(`${indent}${name}: Object.freeze({`);
      lines.push(render(node.children[name], `${indent}  `));
      lines.push(`${indent}}),`);
    }
    return lines.join('\n');
  };

  return `${generatedHeader()}import { createTlFactory } from './registry';\nimport type { Tl } from './types.generated';\n\n${declarations.join('\n')}\n\nexport const Api = Object.freeze({\n${render(tree, '  ')}\n});\n`;
}

async function writeGenerated(fileName, content) {
  const location = path.join(outputDirectory, fileName);
  const formatted = await format(fileName, content, { semi: true, singleQuote: true });
  if (formatted.errors.length > 0) {
    throw Error(
      `Could not format ${fileName}: ${formatted.errors.map((error) => error.message).join('; ')}.`,
    );
  }
  if (check) {
    const current = await fs.readFile(location, 'utf8').catch(() => undefined);
    if (current !== formatted.code) {
      process.stderr.write(
        `${path.relative(root, location)} is stale. Run npm run generate:telegram-tl.\n`,
      );
      process.exitCode = 1;
    }
    return;
  }
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(location, formatted.code);
}

const sources = await Promise.all(schemaFiles.map((file) => fs.readFile(file, 'utf8')));
const definitions = sources.flatMap(parseSchema);
definitions.sort(
  (left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind),
);

const names = Object.create(null);
for (const descriptor of definitions) {
  if (names[descriptor.name]) throw Error(`Duplicate TL descriptor ${descriptor.name}.`);
  names[descriptor.name] = descriptor;
}

const references = await publicReferences();
const byTypeName = Object.fromEntries(
  definitions.map((descriptor) => [descriptor.typeName, descriptor]),
);
const missingFactories = references.factories.filter((name) => !byTypeName[name]);
if (missingFactories.length > 0) {
  throw Error(`No TL definitions found for: ${missingFactories.join(', ')}.`);
}
const factoryDescriptors = references.factories.map((name) => byTypeName[name]);
const selectedMethodNames = new Set(
  factoryDescriptors.filter(({ kind }) => kind === 'method').map(({ name }) => name),
);
const runtimeDefinitions = definitions.filter(
  ({ kind, name }) =>
    kind === 'bare' ||
    kind === 'constructor' ||
    (kind === 'method' && selectedMethodNames.has(name)),
);

await Promise.all([
  writeGenerated('schema.generated.ts', schemaModule(runtimeDefinitions)),
  writeGenerated(
    'types.generated.ts',
    typeNamespaceModule(factoryDescriptors, references.aliases, definitions),
  ),
  writeGenerated('api.generated.ts', factoryModule(factoryDescriptors)),
]);
