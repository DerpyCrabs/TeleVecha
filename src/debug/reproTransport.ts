import {
  createReproSanitizer,
  sanitizeReproText,
  type ReproJsonValue,
  type ReproSanitizerV1,
  type ReproTimelineEventV1,
} from './reproFormat';
import type { TelegramMedia, TelegramTransport, TransportUpdateBatch } from '../telegram/types';

type TransportEventKind = 'call' | 'resolve' | 'reject' | 'push';

export type ReproTransportEvent = ReproTimelineEventV1 & { kind: TransportEventKind };

export interface ReproTransportEventSink {
  append(event: ReproTransportEvent): void;
}

export interface ReproTransportEventSource {
  readonly events: readonly ReproTimelineEventV1[];
}

export interface ReproTransportSanitizeContext {
  phase: 'call' | 'resolve' | 'push';
  method: string;
  callId?: string | undefined;
}

export type ReproTransportValueSanitizer = (
  value: unknown,
  context: ReproTransportSanitizeContext,
) => unknown;

export interface RecordingTelegramTransportOptions {
  now?: (() => number) | undefined;
  sanitizer?: ReproSanitizerV1 | undefined;
  sanitize?: ReproTransportValueSanitizer | undefined;
  shouldRecord?: ((method: string) => boolean) | undefined;
  beforeInvoke?: ((method: string) => Promise<void> | void) | undefined;
  onCaptureError?: ((error: Error) => void) | undefined;
}

export interface ReplayTelegramTransportOptions {
  now?: (() => number) | undefined;
  sanitizer?: ReproSanitizerV1 | undefined;
  sanitize?: ReproTransportValueSanitizer | undefined;
  /** Set to zero to keep ordering while removing recorded waits. */
  timeScale?: number | undefined;
  onMismatch?: ((error: ReproReplayMismatchError) => void) | undefined;
  onEvent?: ((event: ReproTransportEvent) => void) | undefined;
  onComplete?: (() => void) | undefined;
}

export interface ReproPlaceholderOptions {
  byteSize: number;
  mimeType?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  mediaKind?: string | undefined;
}

type EventSinkInput =
  | ReproTransportEventSink
  | ReproTransportEvent[]
  | ((event: ReproTransportEvent) => void);

type EventSourceInput = ReproTransportEventSource | readonly ReproTimelineEventV1[];

interface PendingReplayCall {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  method: string;
  args: unknown[];
}

const UPDATE_PUSH_METHOD = 'updates';
const PROGRESS_PUSH_METHOD = 'progress';
const VALUE_UNDEFINED = 'repro-undefined';
const VALUE_BINARY = 'repro-binary';
const VALUE_FILE = 'repro-file';
const VALUE_BIGINT = 'repro-bigint';
const VALUE_NONFINITE = 'repro-number';
const TAG = 'type';
const MAX_PLACEHOLDER_BYTES = 16 * 1024 * 1024;

const SECRET_METHODS = new Set(['connect', 'requestCode', 'submitCode', 'submitPassword']);
const OPTIONAL_METHODS = new Set<string>([
  'acceptUrlAuth',
  'answerBotCallback',
  'deleteContact',
  'downloadCustomEmoji',
  'downloadWallpaper',
  'getBotCommands',
  'getChatAppearance',
  'getDialog',
  'getGroupMembers',
  'getHistoryAround',
  'getReadOutboxMaxId',
  'getThemes',
  'getWallpapers',
  'requestUrlAuth',
  'searchGifs',
  'startBot',
  'updateContact',
]);

export class ReproReplayMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReproReplayMismatchError';
  }
}

/**
 * Records the high-level Telegram transport contract. The wrapped transport still receives the
 * original values, while the sink only sees JSON-safe synthetic data.
 */
export function createRecordingTelegramTransport(
  target: TelegramTransport,
  sink: EventSinkInput,
  options: RecordingTelegramTransportOptions = {},
): TelegramTransport {
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const sanitizer = options.sanitizer ?? createReproSanitizer({ sourceEpochMs: Date.now() });
  let sequence = 0;
  let callSequence = 0;
  let lastTime = 0;
  const listeners = new Set<(batch: TransportUpdateBatch) => void>();
  let unsubscribeTarget: (() => void) | undefined;
  const wrappers = new Map<PropertyKey, unknown>();

  const emit = (event: Omit<ReproTransportEvent, 'seq' | 'tMs'>) => {
    lastTime = Math.max(lastTime, Math.max(0, Math.round(now() - startedAt)));
    try {
      writeEvent(sink, { ...event, seq: ++sequence, tMs: lastTime } as ReproTransportEvent);
    } catch (error) {
      options.onCaptureError?.(asError(error));
    }
  };

  const sanitize = (
    value: unknown,
    context: ReproTransportSanitizeContext,
    relatedArgs?: readonly unknown[],
  ) => {
    try {
      return sanitizeTransportValue(value, context, sanitizer, options.sanitize, relatedArgs);
    } catch (error) {
      options.onCaptureError?.(asError(error));
      return { [TAG]: 'repro-redacted' } satisfies ReproJsonValue;
    }
  };

  const subscribe = (listener: (batch: TransportUpdateBatch) => void) => {
    listeners.add(listener);
    if (!unsubscribeTarget) {
      unsubscribeTarget = target.subscribe((batch) => {
        emit({
          kind: 'push',
          method: UPDATE_PUSH_METHOD,
          value: sanitize(batch, { phase: 'push', method: UPDATE_PUSH_METHOD }),
        });
        for (const current of listeners) current(batch);
      });
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) {
        unsubscribeTarget?.();
        unsubscribeTarget = undefined;
      }
    };
  };

  const invoke = (method: string, originalArgs: unknown[]) => {
    if (options.shouldRecord?.(method) === false) {
      const member = Reflect.get(target as object, method, target);
      if (typeof member !== 'function') {
        return Promise.reject(new TypeError(`Telegram transport method ${method} is unavailable.`));
      }
      return Promise.resolve(Reflect.apply(member, target, originalArgs));
    }
    const callId = `call:${++callSequence}`;
    const callContext = { phase: 'call' as const, method, callId };
    emit({ kind: 'call', callId, method, args: sanitize(originalArgs, callContext) });
    let forwardedArgs = originalArgs;
    try {
      forwardedArgs = wrapProgressCallbacks(originalArgs, (progress) => {
        emit({ kind: 'push', method: PROGRESS_PUSH_METHOD, callId, value: progress });
      });
    } catch (error) {
      options.onCaptureError?.(asError(error));
    }

    const rejectCall = (error: unknown) => {
      emit({ kind: 'reject', callId, error: sanitizeError(error) });
      return Promise.reject(error);
    };
    const invokeTarget = () => {
      let result: unknown;
      try {
        const member = Reflect.get(target as object, method, target);
        if (typeof member !== 'function') {
          throw new TypeError(`Telegram transport method ${method} is unavailable.`);
        }
        result = Reflect.apply(member, target, forwardedArgs);
      } catch (error) {
        return rejectCall(error);
      }
      return Promise.resolve(result).then(
        (value) => {
          emit({
            kind: 'resolve',
            callId,
            value: sanitize(value, { phase: 'resolve', method, callId }, originalArgs),
          });
          return value;
        },
        (error: unknown) => rejectCall(error),
      );
    };

    try {
      const before = options.beforeInvoke?.(method);
      return before === undefined
        ? invokeTarget()
        : Promise.resolve(before).then(invokeTarget, rejectCall);
    } catch (error) {
      return rejectCall(error);
    }
  };

  return new Proxy(target, {
    get(_proxyTarget, property) {
      if (property === 'subscribe') return subscribe;
      const member = Reflect.get(target as object, property, target);
      if (typeof member !== 'function') return member;
      const cached = wrappers.get(property);
      if (cached) return cached;
      const wrapper = (...args: unknown[]) => invoke(String(property), args);
      wrappers.set(property, wrapper);
      return wrapper;
    },
  });
}

/** Creates an offline transport which can only return values present in the recording. */
export function createReplayTelegramTransport(
  input: EventSourceInput,
  options: ReplayTelegramTransportOptions = {},
): TelegramTransport {
  const allEvents: readonly ReproTimelineEventV1[] = isEventSource(input) ? input.events : input;
  const events = allEvents.filter(isTransportEvent);
  validateEvents(events);
  const methods = new Set(
    events.filter((event) => event.kind === 'call').map((event) => event.method),
  );
  const now = options.now ?? defaultNow;
  const timeScale = options.timeScale ?? 1;
  if (!Number.isFinite(timeScale) || timeScale < 0) {
    throw new RangeError('Replay timeScale must be a finite non-negative number.');
  }
  const sanitizer = options.sanitizer ?? createReproSanitizer({ sourceEpochMs: Date.now() });
  const listeners = new Set<(batch: TransportUpdateBatch) => void>();
  const pending = new Map<string, PendingReplayCall>();
  const progressCallbacks = new Map<string, Array<(value: number) => void>>();
  const claimedCalls = new Set<string>();
  const reusableCalls = new Map<string, Promise<unknown>>();
  const firstTime = events[0]?.tMs ?? 0;
  const startedAt = now();
  let cursor = 0;
  let scheduled = false;
  let fatal: Error | undefined;
  let completed = false;

  const sanitize = (value: unknown, context: ReproTransportSanitizeContext) =>
    sanitizeTransportValue(value, context, sanitizer, options.sanitize);

  const fail = (error: Error) => {
    fatal = error;
    if (error instanceof ReproReplayMismatchError) options.onMismatch?.(error);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };

  const complete = () => {
    if (completed || fatal || cursor < events.length) return;
    completed = true;
    options.onComplete?.();
  };

  const pump = () => {
    if (scheduled || fatal) return;
    const event = events[cursor];
    if (!event) {
      complete();
      return;
    }
    if (event.kind === 'call') {
      if (!event.callId || !claimedCalls.has(event.callId)) return;
      cursor += 1;
      options.onEvent?.(event);
      queueMicrotask(pump);
      return;
    }
    const targetTime = timeScale === 0 ? 0 : (event.tMs - firstTime) * timeScale;
    const delay = Math.max(0, targetTime - (now() - startedAt));
    scheduled = true;
    const run = () => {
      scheduled = false;
      if (events[cursor] !== event || fatal) return;
      cursor += 1;
      try {
        dispatchReplayEvent(event, pending, progressCallbacks, listeners);
        options.onEvent?.(event);
      } catch (error) {
        fail(asError(error));
        return;
      }
      queueMicrotask(pump);
    };
    if (delay === 0) queueMicrotask(run);
    else setTimeout(run, delay);
  };

  const invoke = (method: string, args: unknown[]) => {
    if (fatal) return Promise.reject(fatal);
    const context = { phase: 'call' as const, method };
    const actualArgs = sanitize(args, context);
    const alreadySafeArgs = enforceJsonValue(
      redactPreparedPositionalSecrets(
        prepareForSanitizer(args, context, undefined, new WeakSet()),
        context,
      ),
      new WeakSet(),
    );
    const safeSignature = callSignature(method, alreadySafeArgs);
    const sanitizedSignature = callSignature(method, actualArgs);
    const matchIndex = findReplayCall(
      events,
      cursor,
      method,
      claimedCalls,
      (event) =>
        sameReplayCall(method, event.args ?? null, actualArgs) ||
        sameReplayCall(method, event.args ?? null, alreadySafeArgs),
      isReplayAssetMethod(method),
    );
    const expected = matchIndex >= 0 ? events[matchIndex] : undefined;
    if (!expected || expected.kind !== 'call') {
      if (isReusableReplayMethod(method)) {
        const existing = reusableCalls.get(safeSignature) ?? reusableCalls.get(sanitizedSignature);
        if (existing) return existing;
      }
      const nextCall = events.slice(cursor).find((event) => event.kind === 'call');
      return rejectMismatch(
        mismatch(
          nextCall
            ? `Replay divergence at event ${nextCall.seq}: expected ${formatCall(nextCall.method, nextCall.args)}, received ${formatCall(method, alreadySafeArgs)}.`
            : `Unexpected ${method} call after the recorded transport timeline ended.`,
        ),
        options.onMismatch,
      );
    }
    if (!expected.callId) {
      return rejectMismatch(mismatch(`Recorded ${method} call has no callId.`), options.onMismatch);
    }
    claimedCalls.add(expected.callId);
    const progress = findProgressCallbacks(args);
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(expected.callId!, { resolve, reject, method, args });
      progressCallbacks.set(expected.callId!, progress);
    });
    if (isReusableReplayMethod(method)) {
      reusableCalls.set(safeSignature, promise);
      reusableCalls.set(sanitizedSignature, promise);
      reusableCalls.set(callSignature(method, expected.args ?? null), promise);
    }
    pump();
    return promise;
  };

  const subscribe = (listener: (batch: TransportUpdateBatch) => void) => {
    listeners.add(listener);
    pump();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  };

  if (events.length === 0) queueMicrotask(pump);

  return new Proxy({} as TelegramTransport, {
    get(target, property, receiver) {
      if (property === 'subscribe') return subscribe;
      if (typeof property !== 'string') return Reflect.get(target, property, receiver);
      if (OPTIONAL_METHODS.has(property) && !methods.has(property)) return undefined;
      return (...args: unknown[]) => invoke(property, args);
    },
  });
}

function dispatchReplayEvent(
  event: ReproTransportEvent,
  pending: Map<string, PendingReplayCall>,
  progressCallbacks: Map<string, Array<(value: number) => void>>,
  listeners: Set<(batch: TransportUpdateBatch) => void>,
) {
  if (event.kind === 'push') {
    if (event.method === PROGRESS_PUSH_METHOD) {
      if (!event.callId) throw mismatch('Recorded progress event has no callId.');
      const callbacks = progressCallbacks.get(event.callId);
      if (!callbacks) throw mismatch(`Progress refers to unknown ${event.callId}.`);
      const progress = typeof event.value === 'number' ? event.value : 0;
      for (const listener of callbacks) listener(progress);
      return;
    }
    const batch = hydrateValue(event.value) as TransportUpdateBatch;
    for (const listener of listeners) listener(batch);
    return;
  }
  if (!event.callId) throw mismatch(`Recorded ${event.kind} event has no callId.`);
  const call = pending.get(event.callId);
  if (!call) throw mismatch(`${event.kind} refers to unknown ${event.callId}.`);
  pending.delete(event.callId);
  if (event.kind === 'resolve') {
    call.resolve(restoreReplayRandomIds(call.method, call.args, hydrateValue(event.value)));
  } else {
    call.reject(hydrateError(event.error));
  }
}

function sanitizeTransportValue(
  value: unknown,
  context: ReproTransportSanitizeContext,
  sanitizer: ReproSanitizerV1,
  custom: ReproTransportValueSanitizer | undefined,
  relatedArgs?: readonly unknown[],
): ReproJsonValue {
  if (context.phase === 'call' && SECRET_METHODS.has(context.method)) {
    return { [TAG]: `secret-${context.method.toLowerCase()}` };
  }
  if (
    context.phase === 'resolve' &&
    context.method === 'getAuthorizedAccountId' &&
    typeof value === 'string'
  ) {
    return sanitizer.alias('account', value);
  }
  if (
    context.phase === 'resolve' &&
    context.method === 'submitCode' &&
    (value === 'authorized' || value === 'password-required' || value === 'sign-up-required')
  ) {
    return value;
  }
  const binary = binaryDescriptor(value, context, relatedArgs);
  if (binary) return binary;
  const prepared = redactPreparedPositionalSecrets(
    prepareForSanitizer(value, context, relatedArgs, new WeakSet()),
    context,
  );
  const transformed = custom
    ? custom(prepared, context)
    : sanitizePreparedValue(prepared, value, context, sanitizer);
  return enforceJsonValue(transformed, new WeakSet());
}

function sanitizePreparedValue(
  prepared: unknown,
  original: unknown,
  context: ReproTransportSanitizeContext,
  sanitizer: ReproSanitizerV1,
): unknown {
  if (context.phase !== 'call' || !Array.isArray(prepared) || !Array.isArray(original)) {
    return sanitizer.sanitizeValue(prepared, context.method);
  }
  return prepared.map((argument, index) => {
    return sanitizer.sanitizeValue(
      argument,
      callArgumentContext(context.method, index, original[index]),
    );
  });
}

function redactPreparedPositionalSecrets(
  prepared: unknown,
  context: ReproTransportSanitizeContext,
) {
  if (
    context.phase !== 'call' ||
    context.method !== 'answerBotCallback' ||
    !Array.isArray(prepared) ||
    !isNumberArray(prepared[2])
  ) {
    return prepared;
  }
  return prepared.map((argument, index) => (index === 2 ? argument.map(() => 0) : argument));
}

function callArgumentContext(method: string, index: number, value: unknown) {
  if (isPeer(value)) {
    return `${method}.${method === 'forwardMessage' && index === 0 ? 'fromPeer' : 'peer'}`;
  }
  if (method === 'downloadMedia' && index === 0) return `${method}.message`;
  if (method === 'downloadWallpaper' && index === 0) return `${method}.wallpaperId`;
  if (method === 'downloadCustomEmoji' && index === 0) return `${method}.customEmojiId`;
  if ((method === 'downloadSticker' || method === 'sendSticker') && index === 1) {
    return `${method}.sticker`;
  }
  if (method === 'downloadSticker' && index === 0) return `${method}.sticker`;
  if (method === 'sendFile' && index === 1) return `${method}.file`;
  if (method === 'sendFile' && index === 2) return `${method}.options`;
  if (method === 'sendAlbum' && index === 1) return `${method}.attachments`;
  if (method === 'sendAlbum' && index === 2) return `${method}.options`;
  return `${method}.arg${index}`;
}

function isPeer(value: unknown): value is { id: string; kind: TelegramPeerKind } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { id?: unknown; kind?: unknown };
  return (
    typeof candidate.id === 'string' &&
    (candidate.kind === 'user' || candidate.kind === 'group' || candidate.kind === 'channel')
  );
}

type TelegramPeerKind = 'user' | 'group' | 'channel';

function prepareForSanitizer(
  value: unknown,
  context: ReproTransportSanitizeContext,
  relatedArgs: readonly unknown[] | undefined,
  seen: WeakSet<object>,
): unknown {
  if (value === undefined) return { [TAG]: VALUE_UNDEFINED };
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return value;
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return { [TAG]: 'repro-function' };
  }
  const binary = binaryDescriptor(value, context, relatedArgs);
  if (binary) return binary;
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return { [TAG]: 'repro-cycle' };
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => prepareForSanitizer(item, context, relatedArgs, seen));
    seen.delete(value);
    return output;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenKey(key, child) || typeof child === 'function') continue;
    if (normalizeFieldName(key) === 'data' && isNumberArray(child)) {
      output[key] = child.map(() => 0);
      continue;
    }
    output[key] = prepareForSanitizer(child, context, relatedArgs, seen);
  }
  seen.delete(value);
  return output;
}

function enforceJsonValue(value: unknown, seen: WeakSet<object>): ReproJsonValue {
  if (value === undefined) return { [TAG]: VALUE_UNDEFINED };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : { [TAG]: VALUE_NONFINITE, value: String(value) };
  }
  if (typeof value === 'bigint') return { [TAG]: VALUE_BIGINT, value: String(value) };
  if (typeof value === 'function' || typeof value === 'symbol') {
    return { [TAG]: 'repro-function' };
  }
  const binary = binaryDescriptor(value, { phase: 'call', method: 'value' });
  if (binary) return binary;
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return { [TAG]: 'repro-cycle' };
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => enforceJsonValue(item, seen));
    seen.delete(value);
    return output;
  }
  const output: Record<string, ReproJsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenKey(key, child)) continue;
    if (normalizeFieldName(key) === 'data' && isNumberArray(child)) {
      output[key] = child.map(() => 0);
      continue;
    }
    output[key] = enforceJsonValue(child, seen);
  }
  seen.delete(value);
  return output;
}

function binaryDescriptor(
  value: unknown,
  context: ReproTransportSanitizeContext,
  relatedArgs?: readonly unknown[],
): ReproJsonValue | undefined {
  if (typeof File !== 'undefined' && value instanceof File) {
    return {
      [TAG]: VALUE_FILE,
      name: sanitizeReproText(value.name).value,
      mimeType: safeMimeType(value.type),
      byteSize: value.size,
      modifiedAt: 0,
    };
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    const media = context.method === 'downloadMedia' ? mediaFromArgs(relatedArgs) : undefined;
    return {
      [TAG]: VALUE_BINARY,
      mimeType: safeMimeType(value.type || media?.mimeType || ''),
      byteSize: value.size,
      ...(media?.width !== undefined ? { width: media.width } : {}),
      ...(media?.height !== undefined ? { height: media.height } : {}),
      ...(media?.duration !== undefined ? { duration: media.duration } : {}),
      ...(media?.kind ? { mediaKind: media.kind } : {}),
    };
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return { [TAG]: VALUE_BINARY, mimeType: 'application/octet-stream', byteSize: 0 };
  }
  return undefined;
}

function hydrateValue(value: ReproJsonValue | undefined): unknown {
  if (Array.isArray(value)) return value.map(hydrateValue);
  if (!value || typeof value !== 'object') return value;
  const tag = value[TAG];
  if (tag === VALUE_UNDEFINED) return undefined;
  if (tag === VALUE_BIGINT) {
    return BigInt(typeof value.value === 'string' ? value.value : '0');
  }
  if (tag === VALUE_NONFINITE) {
    return Number(typeof value.value === 'string' ? value.value : 'NaN');
  }
  if (tag === VALUE_BINARY || tag === VALUE_FILE) return createPlaceholder(value);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) output[key] = hydrateValue(child);
  if (
    typeof output.id === 'string' &&
    typeof output.emoji === 'string' &&
    typeof output.mimeType === 'string'
  ) {
    output.accessHash = '$replay';
    output.fileReference = new Uint8Array();
  }
  return output;
}

export function createReproPlaceholder(options: ReproPlaceholderOptions): Blob {
  return createPlaceholder({
    [TAG]: VALUE_BINARY,
    byteSize: options.byteSize,
    mimeType: options.mimeType ?? 'application/octet-stream',
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.height !== undefined ? { height: options.height } : {}),
    ...(options.mediaKind ? { mediaKind: options.mediaKind } : {}),
  });
}

function createPlaceholder(descriptor: Record<string, ReproJsonValue>): Blob {
  const size = nonNegativeInteger(descriptor.byteSize);
  const materializedSize = Math.min(size, MAX_PLACEHOLDER_BYTES);
  const width = nonNegativeInteger(descriptor.width);
  const height = nonNegativeInteger(descriptor.height);
  const mimeType = typeof descriptor.mimeType === 'string' ? descriptor.mimeType : '';
  if (width > 0 && height > 0) {
    const prefix = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
    const suffix = '</svg>';
    if (materializedSize >= prefix.length + suffix.length) {
      const padding = materializedSize - prefix.length - suffix.length;
      return new Blob([prefix, ...repeatedBlobParts(padding, true), suffix], {
        type: 'image/svg+xml',
      });
    }
  }
  const bytes = repeatedBlobParts(materializedSize, false);
  if (descriptor[TAG] === VALUE_FILE && typeof File !== 'undefined') {
    const name = typeof descriptor.name === 'string' ? descriptor.name : 'file';
    return new File(bytes, name, { type: mimeType });
  }
  return new Blob(bytes, { type: mimeType });
}

function repeatedBlobParts(byteLength: number, whitespace: boolean): Blob[] {
  if (byteLength === 0) return [];
  const chunkSize = Math.min(byteLength, 1024 * 1024);
  const chunk = new Blob([whitespace ? ' '.repeat(chunkSize) : new ArrayBuffer(chunkSize)]);
  const fullChunks = Math.floor(byteLength / chunkSize);
  const remainder = byteLength % chunkSize;
  const parts = Array.from({ length: fullChunks }, () => chunk);
  if (remainder > 0) {
    parts.push(new Blob([whitespace ? ' '.repeat(remainder) : new ArrayBuffer(remainder)]));
  }
  return parts;
}

function sanitizeError(error: unknown): { code: string; message?: string | undefined } {
  const source = asError(error);
  const name = ['Error', 'TypeError', 'RangeError', 'AbortError', 'MtprotoError'].includes(
    source.name,
  )
    ? source.name
    : 'Error';
  const numericCode = (source as Error & { code?: unknown }).code;
  const kind = (source as Error & { kind?: unknown }).kind;
  const parts = [name];
  if (typeof kind === 'string' && /^[a-z-]{1,32}$/u.test(kind)) parts.push(kind);
  if (typeof numericCode === 'number' && Number.isSafeInteger(numericCode)) {
    parts.push(String(numericCode));
  }
  return { code: parts.join(':'), message: sanitizeReproText(source.message).value };
}

function hydrateError(record: ReproTimelineEventV1['error']): Error {
  const code = record?.code ?? 'Error';
  const [name = 'Error', ...metadata] = code.split(':');
  const message = record?.message ?? 'Recorded transport failure';
  const error =
    name === 'TypeError'
      ? new TypeError(message)
      : name === 'RangeError'
        ? new RangeError(message)
        : new Error(message);
  error.name = name;
  const kind = metadata.find((value) => /^[a-z-]+$/u.test(value));
  const numericCode = metadata.find((value) => /^-?\d+$/u.test(value));
  if (kind) Object.defineProperty(error, 'kind', { value: kind, enumerable: true });
  if (numericCode) {
    Object.defineProperty(error, 'code', { value: Number(numericCode), enumerable: true });
  }
  return error;
}

function wrapProgressCallbacks(args: unknown[], report: (progress: number) => void): unknown[] {
  return args.map((argument) => replaceProgressCallback(argument, report));
}

function replaceProgressCallback(value: unknown, report: (progress: number) => void): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    (typeof Blob !== 'undefined' && value instanceof Blob)
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => replaceProgressCallback(item, report));
  const entries = Object.entries(value);
  if (!entries.some(([key]) => key === 'onProgress')) return value;
  return Object.fromEntries(
    entries.map(([key, child]) => [
      key,
      key === 'onProgress' && typeof child === 'function'
        ? (progress: number) => {
            report(progress);
            child(progress);
          }
        : child,
    ]),
  );
}

function findProgressCallbacks(args: unknown[]): Array<(value: number) => void> {
  const result: Array<(value: number) => void> = [];
  for (const argument of args) collectProgressCallbacks(argument, result);
  return result;
}

function collectProgressCallbacks(value: unknown, output: Array<(value: number) => void>) {
  if (
    !value ||
    typeof value !== 'object' ||
    (typeof Blob !== 'undefined' && value instanceof Blob)
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProgressCallbacks(item, output);
    return;
  }
  const callback = (value as { onProgress?: unknown }).onProgress;
  if (typeof callback === 'function') output.push(callback as (value: number) => void);
}

function isTransportEvent(event: ReproTimelineEventV1): event is ReproTransportEvent {
  return (
    event.kind === 'call' ||
    event.kind === 'resolve' ||
    event.kind === 'reject' ||
    event.kind === 'push'
  );
}

function findReplayCall(
  events: readonly ReproTransportEvent[],
  cursor: number,
  method: string,
  claimedCalls: ReadonlySet<string>,
  matches: (event: ReproTransportEvent & { kind: 'call' }) => boolean,
  allowSettledOvertake = false,
) {
  let crossedNonCall = false;
  let sawUnmatchedSameMethod = false;
  for (let index = cursor; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.kind !== 'call') {
      crossedNonCall = true;
      if (sawUnmatchedSameMethod && !allowSettledOvertake) return -1;
      continue;
    }
    if (!event.callId || claimedCalls.has(event.callId) || event.method !== method) continue;
    if (matches(event as ReproTransportEvent & { kind: 'call' })) return index;
    if (crossedNonCall && !allowSettledOvertake) return -1;
    sawUnmatchedSameMethod = true;
  }
  return -1;
}

function isReplayAssetMethod(method: string) {
  return [
    'downloadAvatar',
    'downloadCustomEmoji',
    'downloadMedia',
    'downloadSticker',
    'downloadWallpaper',
  ].includes(method);
}

function isEventSource(input: EventSourceInput): input is ReproTransportEventSource {
  return !Array.isArray(input);
}

function validateEvents(events: readonly ReproTransportEvent[]) {
  let previousSequence = 0;
  let previousTime = 0;
  const calls = new Set<string>();
  const settled = new Set<string>();
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= previousSequence) {
      throw new ReproReplayMismatchError('Transport event sequence numbers must increase.');
    }
    if (!Number.isFinite(event.tMs) || event.tMs < previousTime) {
      throw new ReproReplayMismatchError('Transport event times must not move backwards.');
    }
    previousSequence = event.seq;
    previousTime = event.tMs;
    if (event.kind === 'call') {
      if (!event.callId || calls.has(event.callId) || !event.method) {
        throw new ReproReplayMismatchError('Recorded transport call is incomplete or duplicated.');
      }
      calls.add(event.callId);
    } else if (event.kind !== 'push') {
      if (!event.callId || !calls.has(event.callId) || settled.has(event.callId)) {
        throw new ReproReplayMismatchError('Recorded transport settlement has no matching call.');
      }
      settled.add(event.callId);
    }
  }
}

function writeEvent(sink: EventSinkInput, event: ReproTransportEvent) {
  if (typeof sink === 'function') sink(event);
  else if (Array.isArray(sink)) sink.push(event);
  else sink.append(event);
}

function sameJson(left: unknown, right: unknown) {
  return stableJson(left) === stableJson(right);
}

function sameReplayCall(method: string, left: unknown, right: unknown) {
  return sameJson(normalizeReplayRandomIds(method, left), normalizeReplayRandomIds(method, right));
}

function normalizeReplayRandomIds(method: string, value: unknown) {
  if (!Array.isArray(value)) return value;
  const copy = structuredClone(value) as unknown[];
  const replaceAt = (index: number) => {
    if (index < copy.length) copy[index] = '$replay-random-id';
  };
  if (method === 'sendText' || method === 'sendSticker' || method === 'startBot') replaceAt(2);
  if (method === 'forwardMessage') replaceAt(3);
  if (method === 'sendFile' && isRecord(copy[2])) copy[2].randomId = '$replay-random-id';
  if (method === 'sendAlbum' && Array.isArray(copy[1])) {
    for (const attachment of copy[1]) {
      if (isRecord(attachment)) attachment.randomId = '$replay-random-id';
    }
  }
  return copy;
}

function restoreReplayRandomIds(method: string, args: unknown[], value: unknown) {
  const randomIds = replayRandomIds(method, args);
  if (randomIds.length === 0 || !value || typeof value !== 'object') return value;
  const copy = structuredClone(value);
  const recorded = new Map<string, string>();
  let next = 0;
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!isRecord(current)) return;
    if (typeof current.randomId === 'string') {
      let replacement = recorded.get(current.randomId);
      if (!replacement) {
        replacement = randomIds[Math.min(next, randomIds.length - 1)]!;
        recorded.set(current.randomId, replacement);
        next += 1;
      }
      current.randomId = replacement;
    }
    for (const child of Object.values(current)) visit(child);
  };
  visit(copy);
  return copy;
}

function replayRandomIds(method: string, args: unknown[]) {
  if (method === 'sendText' || method === 'sendSticker' || method === 'startBot') {
    return typeof args[2] === 'string' ? [args[2]] : [];
  }
  if (method === 'forwardMessage') return typeof args[3] === 'string' ? [args[3]] : [];
  if (method === 'sendFile' && isRecord(args[2]) && typeof args[2].randomId === 'string') {
    return [args[2].randomId];
  }
  if (method === 'sendAlbum' && Array.isArray(args[1])) {
    return args[1].flatMap((attachment) =>
      isRecord(attachment) && typeof attachment.randomId === 'string' ? [attachment.randomId] : [],
    );
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function formatCall(method: string | undefined, args: unknown) {
  return `${method ?? '<missing>'}(${stableJson(args)})`;
}

function callSignature(method: string, args: unknown) {
  return `${method}:${stableJson(args)}`;
}

function isReusableReplayMethod(method: string) {
  return /^(?:download|get|isAuthorized|search)/u.test(method);
}

function mismatch(message: string) {
  return new ReproReplayMismatchError(message);
}

function rejectMismatch(
  error: ReproReplayMismatchError,
  listener: ((error: ReproReplayMismatchError) => void) | undefined,
) {
  listener?.(error);
  return Promise.reject(error);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function mediaFromArgs(args: readonly unknown[] | undefined): TelegramMedia | undefined {
  const message = args?.[0];
  if (!message || typeof message !== 'object') return undefined;
  const media = (message as { media?: unknown }).media;
  return media && typeof media === 'object' ? (media as TelegramMedia) : undefined;
}

function safeMimeType(value: string) {
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(value)
    ? value.toLowerCase()
    : 'application/octet-stream';
}

function nonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isForbiddenKey(key: string, value?: unknown) {
  const normalized = normalizeFieldName(key);
  if (normalized === 'requestphonenumber' && typeof value === 'boolean') return false;
  if (
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
    ].includes(normalized)
  ) {
    return true;
  }
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

function normalizeFieldName(key: string) {
  return key.replace(/[^a-z0-9]/giu, '').toLowerCase();
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

function defaultNow() {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
