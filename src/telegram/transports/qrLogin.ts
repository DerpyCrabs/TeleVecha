import { Clock, Effect, PubSub, Stream } from 'effect';
import type { MtprotoClient } from '../mtproto';
import { createMtprotoError } from '../mtproto/errors';
import { Api } from '../mtproto/tl';
import type { TelegramQrLogin } from '../types';

export function isLoginTokenUpdate(value: unknown): boolean {
  if (Api.UpdateLoginToken.is(value)) return true;
  if (Api.UpdateShort.is(value)) return Api.UpdateLoginToken.is(value.update);
  if (Api.Updates.is(value) || Api.UpdatesCombined.is(value))
    return value.updates.some((update) => Api.UpdateLoginToken.is(update));
  return false;
}

export function watchQrLogin(
  client: Pick<MtprotoClient, 'apiId' | 'apiHash' | 'invoke' | 'switchDc'>,
  updates: PubSub.PubSub<void>,
) {
  return Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before exporting so an immediate acceptance cannot be lost.
      const subscription = yield* PubSub.subscribe(updates);
      return Stream.unfold<
        TelegramQrLogin | undefined,
        TelegramQrLogin,
        import('../mtproto/errors').MtprotoError,
        never
      >(undefined, (previous) =>
        Effect.gen(function* () {
          if (previous && previous.type !== 'token') return undefined;
          if (previous?.type === 'token') {
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.raceFirst(
              PubSub.take(subscription),
              Effect.sleep(Math.max(1000, previous.expires * 1000 - now)),
            );
          }
          const next = yield* Effect.gen(function* (): Effect.fn.Return<
            TelegramQrLogin,
            import('../mtproto/errors').MtprotoError
          > {
            let result = yield* client.invoke(
              Api.auth.ExportLoginToken({
                apiId: client.apiId,
                apiHash: client.apiHash,
                exceptIds: [],
              }),
            );
            for (let redirects = 0; Api.auth.LoginTokenMigrateTo.is(result); redirects++) {
              if (redirects >= 3)
                return yield* Effect.fail(
                  createMtprotoError('protocol', 'Too many QR login data center redirects.'),
                );
              yield* client.switchDc(result.dcId);
              result = yield* client.invoke(Api.auth.ImportLoginToken({ token: result.token }));
            }
            if (Api.auth.LoginToken.is(result)) {
              const token = btoa(String.fromCharCode(...result.token))
                .replaceAll('+', '-')
                .replaceAll('/', '_')
                .replace(/=+$/, '');
              return { type: 'token', url: `tg://login?token=${token}`, expires: result.expires };
            }
            if (
              Api.auth.LoginTokenSuccess.is(result) &&
              Api.auth.Authorization.is(result.authorization)
            )
              return { type: 'authorized' };
            return yield* Effect.fail(
              createMtprotoError('protocol', 'Telegram returned an unexpected QR login response.'),
            );
          }).pipe(
            Effect.catch((error) =>
              error.message === 'SESSION_PASSWORD_NEEDED' ||
              error.details?.errorMessage === 'SESSION_PASSWORD_NEEDED'
                ? Effect.succeed<TelegramQrLogin>({ type: 'password-required' })
                : Effect.fail(error),
            ),
          );
          return [next, next] as const;
        }),
      );
    }),
  );
}
