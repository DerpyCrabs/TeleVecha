import { Effect, Fiber, PubSub, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vitest';
import { Api } from '../mtproto/tl';
import type { MtprotoClient } from '../mtproto';
import { createMtprotoError } from '../mtproto/errors';
import { isLoginTokenUpdate, watchQrLogin } from './qrLogin';
import type { TelegramQrLogin } from '../types';

const success = () =>
  Api.auth.LoginTokenSuccess({
    authorization: Api.auth.Authorization({ user: Api.User({ id: 1n }) }),
  });
describe('QR login', () => {
  it('recognizes direct and enveloped acceptance updates', () => {
    expect(isLoginTokenUpdate(Api.UpdateLoginToken())).toBe(true);
    expect(isLoginTokenUpdate(Api.UpdateShort({ update: Api.UpdateLoginToken(), date: 1 }))).toBe(
      true,
    );
    expect(
      isLoginTokenUpdate(
        Api.Updates({ updates: [Api.UpdateLoginToken()], users: [], chats: [], date: 1, seq: 1 }),
      ),
    ).toBe(true);
    expect(isLoginTokenUpdate(Api.UpdatePtsChanged())).toBe(false);
  });
  it('exports a base64url code and handles acceptance received during the first export', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hub = yield* PubSub.sliding<void>(1);
          let calls = 0;
          const invoke = (_request: unknown) =>
            Effect.gen(function* () {
              if (calls++ === 0) {
                yield* PubSub.publish(hub, undefined);
                return Api.auth.LoginToken({
                  token: new Uint8Array([251, 255]),
                  expires: 9999999999,
                });
              }
              return success();
            });
          const values = yield* Stream.runCollect(
            watchQrLogin(
              {
                apiId: 1,
                apiHash: 'hash',
                invoke: invoke as MtprotoClient['invoke'],
                switchDc: () => Effect.void,
              },
              hub,
            ),
          );
          expect(Array.from(values)).toEqual([
            { type: 'token', url: 'tg://login?token=-_8', expires: 9999999999 },
            { type: 'authorized' },
          ]);
          expect(calls).toBe(2);
        }),
      ),
    ));
  it('automatically replaces expired codes and stops requesting on cancellation', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hub = yield* PubSub.sliding<void>(1);
          const values: TelegramQrLogin[] = [];
          let calls = 0;
          const invoke = (_request: unknown) =>
            Effect.sync(() =>
              Api.auth.LoginToken({ token: new Uint8Array([++calls]), expires: calls * 30 }),
            );
          const fiber = yield* watchQrLogin(
            {
              apiId: 1,
              apiHash: 'hash',
              invoke: invoke as MtprotoClient['invoke'],
              switchDc: () => Effect.void,
            },
            hub,
          ).pipe(
            Stream.runForEach((value) =>
              Effect.sync(() => {
                values.push(value);
              }),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* TestClock.adjust('29 seconds');
          expect(calls).toBe(1);
          yield* TestClock.adjust('1 second');
          expect(calls).toBe(2);
          expect(values).toHaveLength(2);
          yield* Fiber.interrupt(fiber);
          yield* TestClock.adjust('60 seconds');
          expect(calls).toBe(2);
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    ));
  it('switches the main DC before importing and carries password-required into 2FA', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hub = yield* PubSub.sliding<void>(1);
          const operations: string[] = [];
          const token = new Uint8Array([1, 2, 3]);
          const invoke = (request: unknown) => {
            if (Api.auth.ExportLoginToken.is(request)) {
              operations.push('export');
              return Effect.succeed(Api.auth.LoginTokenMigrateTo({ dcId: 4, token }));
            }
            expect(Api.auth.ImportLoginToken.is(request)).toBe(true);
            expect(request).toMatchObject({ token });
            operations.push('import');
            return Effect.fail(
              createMtprotoError('rpc', 'Password required', {
                details: { errorMessage: 'SESSION_PASSWORD_NEEDED' },
              }),
            );
          };
          const values = yield* Stream.runCollect(
            watchQrLogin(
              {
                apiId: 1,
                apiHash: 'hash',
                invoke: invoke as MtprotoClient['invoke'],
                switchDc: (dc) =>
                  Effect.sync(() => {
                    operations.push(`dc:${dc}`);
                  }),
              },
              hub,
            ),
          );
          expect(operations).toEqual(['export', 'dc:4', 'import']);
          expect(Array.from(values)).toEqual([{ type: 'password-required' }]);
        }),
      ),
    ));
});
