import { RAW_TL_DESCRIPTORS } from './schema.generated';
import type { TlDescriptor, TlFactory, TlFieldDescriptor, TlObject, TlTypeRef } from './types';

function freezeType(type: TlTypeRef): TlTypeRef {
  if (type.kind === 'vector') {
    return Object.freeze({ ...type, item: freezeType(type.item) });
  }
  return Object.freeze({ ...type });
}

function freezeField(field: TlFieldDescriptor): TlFieldDescriptor {
  return Object.freeze({
    ...field,
    type: freezeType(field.type),
    ...(field.flag ? { flag: Object.freeze({ ...field.flag }) } : {}),
  });
}

function freezeDescriptor(descriptor: TlDescriptor): TlDescriptor {
  return Object.freeze({
    ...descriptor,
    id: descriptor.id >>> 0,
    result: freezeType(descriptor.result),
    fields: Object.freeze(descriptor.fields.map(freezeField)),
  });
}

export const tlDescriptors: readonly TlDescriptor[] = Object.freeze(
  RAW_TL_DESCRIPTORS.map(freezeDescriptor),
);

const byName: Record<string, TlDescriptor | undefined> = Object.create(null) as Record<
  string,
  TlDescriptor | undefined
>;
const constructorsById: Record<string, TlDescriptor | undefined> = Object.create(null) as Record<
  string,
  TlDescriptor | undefined
>;

for (const descriptor of tlDescriptors) {
  if (byName[descriptor.name]) throw Error(`Duplicate TL name ${descriptor.name}.`);
  byName[descriptor.name] = descriptor;
  if (descriptor.kind === 'constructor') {
    const id = String(descriptor.id >>> 0);
    const previous = constructorsById[id];
    if (previous) {
      throw Error(
        `Duplicate TL constructor id 0x${descriptor.id.toString(16)} for ${previous.name} and ${descriptor.name}.`,
      );
    }
    constructorsById[id] = descriptor;
  }
}

export const tlDescriptorsByName: Readonly<Record<string, TlDescriptor | undefined>> =
  Object.freeze(byName);
export const tlConstructorsById: Readonly<Record<string, TlDescriptor | undefined>> =
  Object.freeze(constructorsById);

export function descriptorFor(name: string) {
  return tlDescriptorsByName[name];
}

export function constructorDescriptorFor(id: number) {
  return tlConstructorsById[String(id >>> 0)];
}

export function resultTypeFor(name: string): TlTypeRef | undefined {
  const descriptor = descriptorFor(name);
  return descriptor?.kind === 'method' ? descriptor.result : undefined;
}

export function createTl<Name extends string, Fields extends object = Record<string, never>>(
  name: Name,
  fields?: Fields,
): TlObject<Name> & Readonly<Fields> {
  if (!descriptorFor(name)) throw Error(`Unknown TL name ${name}.`);
  return Object.freeze({ ...(fields ?? ({} as Fields)), _: name }) as TlObject<Name> &
    Readonly<Fields>;
}

export function isTl<Name extends string>(
  value: unknown,
  ...names: readonly Name[]
): value is TlObject<Name> {
  if (!value || typeof value !== 'object' || !('_' in value)) return false;
  const name = (value as { _: unknown })._;
  return typeof name === 'string' && names.includes(name as Name);
}

export function createTlFactory<
  Value extends TlObject,
  Fields extends object = Record<string, never>,
>(name: Value['_']): TlFactory<Value, Fields> {
  const descriptor = descriptorFor(name);
  if (!descriptor) throw Error(`Unknown TL name ${name}.`);

  const factory = (fields?: Fields) => createTl(name, fields) as Value;
  Object.defineProperties(factory, {
    id: { value: descriptor.id, enumerable: true },
    tlName: { value: descriptor.name, enumerable: true },
    kind: { value: descriptor.kind, enumerable: true },
    result: { value: descriptor.result, enumerable: true },
    is: { value: (value: unknown): value is Value => isTl(value, name), enumerable: true },
  });
  return Object.freeze(factory) as TlFactory<Value, Fields>;
}
