export { Api } from './api.generated';
export { decodeTl, decodeTlAt, createTlReader, encodeTl } from './codec';
export {
  constructorDescriptorFor,
  createTl,
  descriptorFor,
  isTl,
  resultTypeFor,
  tlConstructorsById,
  tlDescriptors,
  tlDescriptorsByName,
} from './registry';
export { LAYER } from './types';
export type { Tl } from './types.generated';
export type {
  AnyTlObject,
  DecodeTlOptions,
  TlDescriptor,
  TlFactory,
  TlFieldDescriptor,
  TlObject,
  TlPrimitive,
  TlReader,
  TlRequest,
  TlResultOf,
  TlTypeRef,
} from './types';
