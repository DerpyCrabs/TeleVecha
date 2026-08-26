import type TelegramClient from './TelegramClient';

import { computeCheck } from '../Password';
import { RPCError } from '../errors';
import Api from '../tl/api';

export interface UserAuthParams {
  phoneNumber: string | (() => Promise<string>);
  phoneCode: (isCodeViaApp?: boolean) => Promise<string>;
  password: (hint?: string, noReset?: boolean) => Promise<string>;
  firstAndLastNames: () => Promise<[string, string?]>;
  onError: (error: Error) => void;
  forceSMS?: boolean;
  shouldThrowIfUnauthorized?: boolean;
}

interface ApiCredentials {
  apiId: number;
  apiHash: string;
}

export async function checkAuthorization(client: TelegramClient, shouldThrow = false) {
  try {
    await client.invoke(new Api.updates.GetState());
    return true;
  } catch (error) {
    if (shouldThrow) throw error;
    return false;
  }
}

export async function authFlow(
  client: TelegramClient,
  credentials: ApiCredentials,
  params: UserAuthParams,
) {
  const phoneNumber =
    typeof params.phoneNumber === 'function' ? await params.phoneNumber() : params.phoneNumber;
  const sentCode = await sendCode(client, credentials, phoneNumber, params.forceSMS);
  const phoneCode = await params.phoneCode(sentCode.isCodeViaApp);

  try {
    const authorization = await client.invoke(
      new Api.auth.SignIn({
        phoneNumber,
        phoneCodeHash: sentCode.phoneCodeHash,
        phoneCode,
      }),
    );
    if (authorization instanceof Api.auth.AuthorizationSignUpRequired) {
      const [firstName, lastName] = await params.firstAndLastNames();
      const created = await client.invoke(
        new Api.auth.SignUp({
          phoneNumber,
          phoneCodeHash: sentCode.phoneCodeHash,
          firstName,
          lastName: lastName ?? '',
        }),
      );
      return created.user;
    }
    return authorization.user;
  } catch (error) {
    if (error instanceof RPCError && error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      return signInWithPassword(client, params);
    }
    if (error instanceof Error) params.onError(error);
    throw error;
  }
}

async function sendCode(
  client: TelegramClient,
  credentials: ApiCredentials,
  phoneNumber: string,
  forceSMS = false,
) {
  const sent = await client.invoke(
    new Api.auth.SendCode({
      phoneNumber,
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      settings: new Api.CodeSettings(),
    }),
  );
  if (!(sent instanceof Api.auth.SentCode)) {
    throw new Error('Telegram returned an unexpected authorization response.');
  }
  if (!forceSMS || sent.type instanceof Api.auth.SentCodeTypeSms) {
    return {
      phoneCodeHash: sent.phoneCodeHash,
      isCodeViaApp: sent.type instanceof Api.auth.SentCodeTypeApp,
    };
  }
  const resent = await client.invoke(
    new Api.auth.ResendCode({
      phoneNumber,
      phoneCodeHash: sent.phoneCodeHash,
    }),
  );
  if (!(resent instanceof Api.auth.SentCode)) {
    throw new Error('Telegram could not resend the authorization code.');
  }
  return {
    phoneCodeHash: resent.phoneCodeHash,
    isCodeViaApp: resent.type instanceof Api.auth.SentCodeTypeApp,
  };
}

async function signInWithPassword(client: TelegramClient, params: UserAuthParams) {
  const passwordState = await client.invoke(new Api.account.GetPassword());
  const password = await params.password(passwordState.hint);
  const check = await computeCheck(passwordState, password);
  const authorization = await client.invoke(new Api.auth.CheckPassword({ password: check }));
  return authorization.user;
}
