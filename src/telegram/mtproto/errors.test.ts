import { describe, expect, it } from 'vitest';

import { createMtprotoError, isMtprotoError } from './errors';

describe('MTProto errors', () => {
  it('creates a schema-backed tagged error with native Error behavior', () => {
    const cause = new Error('socket closed');
    const error = createMtprotoError('transport', 'Telegram connection failed.', {
      code: 500,
      details: { dcId: 2 },
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MtprotoError');
    expect(error._tag).toBe('MtprotoError');
    expect(error.kind).toBe('transport');
    expect(error.code).toBe(500);
    expect(error.details).toEqual({ dcId: 2 });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(error.cause).toBe(cause);
    expect(isMtprotoError(error)).toBe(true);
  });

  it('does not accept objects that merely claim the error name', () => {
    expect(
      isMtprotoError({
        name: 'MtprotoError',
        _tag: 'MtprotoError',
        kind: 'invented',
        message: 'not an MTProto error',
      }),
    ).toBe(false);
  });
});
