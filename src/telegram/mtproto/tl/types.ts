export const LAYER = 228;

export type TlPrimitive =
  | 'int'
  | 'long'
  | 'int128'
  | 'int256'
  | 'double'
  | 'date'
  | 'string'
  | 'bytes'
  | 'Bool'
  | 'true'
  | '#';

export type TlTypeRef =
  | Readonly<{ kind: 'primitive'; name: TlPrimitive }>
  | Readonly<{ kind: 'object'; name: string; bare: boolean }>
  | Readonly<{ kind: 'vector'; item: TlTypeRef; bare: boolean }>
  | Readonly<{ kind: 'generic'; name: string }>;

export type TlFieldDescriptor = Readonly<{
  name: string;
  wireName: string;
  type: TlTypeRef;
  flag?: Readonly<{ field: string; bit: number }>;
  flagIndicator?: true;
}>;

export type TlDescriptor = Readonly<{
  id: number;
  name: string;
  typeName: string;
  kind: 'constructor' | 'method' | 'bare';
  result: TlTypeRef;
  fields: readonly TlFieldDescriptor[];
}>;

export type TlObject<Name extends string = string> = Readonly<{ _: Name }>;

export type AnyTlObject = TlObject<string> & Readonly<Record<string, unknown>>;

declare const tlResult: unique symbol;

/** Type-only association carried by generated method records. No runtime field is emitted. */
export type TlRequest<Result> = Readonly<{ [tlResult]: Result }>;

export type TlResultOf<Request> = Request extends TlRequest<infer Result> ? Result : never;

export type TlReader = {
  readonly bytes: Uint8Array;
  offset: number;
};

type TlFactoryCall<
  Value extends TlObject = AnyTlObject,
  Fields extends object = Record<string, unknown>,
> = RequiredKeys<Fields> extends never ? (fields?: Fields) => Value : (fields: Fields) => Value;

type RequiredKeys<Fields extends object> = {
  [Key in keyof Fields]-?: Record<never, never> extends Pick<Fields, Key> ? never : Key;
}[keyof Fields];

export type TlFactory<
  Value extends TlObject = AnyTlObject,
  Fields extends object = Record<string, unknown>,
> = TlFactoryCall<Value, Fields> & {
  readonly id: number;
  readonly tlName: Value['_'];
  readonly kind: TlDescriptor['kind'];
  readonly result: TlTypeRef;
  is(value: unknown): value is Value;
};

export type DecodeTlOptions = Readonly<{
  expected?: TlTypeRef;
  gunzip?: (packed: Uint8Array) => Uint8Array;
  resolveRpcResult?: (requestMessageId: bigint) => TlTypeRef | undefined;
  maxBytes?: number;
  maxVectorLength?: number;
}>;
