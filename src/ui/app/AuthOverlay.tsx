import KeyRound from 'lucide-solid/icons/key-round';
import LoaderCircle from 'lucide-solid/icons/loader-circle';
import Phone from 'lucide-solid/icons/phone';
import RotateCw from 'lucide-solid/icons/rotate-cw';
import ShieldCheck from 'lucide-solid/icons/shield-check';
import { Show, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';

import type { EngineSnapshot } from '../../telegram/types';
import { useModalDialog } from '../shared/useModalDialog';

interface AuthOverlayProps {
  open: boolean;
  snapshot: EngineSnapshot;
  configurationError?: string | undefined;
  onRetry: () => Promise<void>;
  onPhone: (phone: string) => Promise<void>;
  onCode: (code: string) => Promise<void>;
  onPassword: (password: string) => Promise<void>;
}

export function AuthOverlay(props: AuthOverlayProps) {
  const [phone, setPhone] = createSignal('');
  const [code, setCode] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let backdrop: HTMLDivElement | undefined;
  useModalDialog(
    () => backdrop,
    () => undefined,
  );

  const submit = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={props.open}>
      <Portal>
        <div ref={(element) => (backdrop = element)} class="auth-backdrop" tabIndex={-1}>
          <section class="auth-card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <Show
              when={props.snapshot.phase === 'connecting' || props.snapshot.phase === 'syncing'}
            >
              <div class="py-8 text-center">
                <LoaderCircle class="mx-auto animate-spin text-[var(--accent)]" size={28} />
                <h2 id="auth-title" class="mt-4 font-semibold">
                  {props.snapshot.phase === 'syncing' ? 'Loading chats' : 'Connecting to Telegram'}
                </h2>
              </div>
            </Show>

            <Show
              when={props.snapshot.phase !== 'connecting' && props.snapshot.phase !== 'syncing'}
            >
              <Show
                when={props.snapshot.phase !== 'error'}
                fallback={
                  <div>
                    <h2 id="auth-title" class="text-xl font-semibold">
                      Connection failed
                    </h2>
                    <p class="mt-2 text-sm leading-5 text-[var(--muted)]">{props.snapshot.error}</p>
                    <button
                      class="auth-submit"
                      disabled={busy()}
                      onClick={() => void submit(props.onRetry)}
                    >
                      <RotateCw size={17} /> Retry
                    </button>
                  </div>
                }
              >
                <Show
                  when={props.snapshot.authStep}
                  fallback={
                    <div>
                      <h2 id="auth-title" class="text-xl font-semibold">
                        {props.configurationError ? 'Configuration required' : 'Telegram connected'}
                      </h2>
                      <p class="mt-2 text-sm leading-5 text-[var(--muted)]">
                        {props.configurationError ??
                          'The application credentials came from the local Vite environment.'}
                      </p>
                      <Show when={props.configurationError}>
                        <pre class="auth-config">
                          VITE_TELEGRAM_API_ID=123456{`\n`}VITE_TELEGRAM_API_HASH=…
                        </pre>
                        <p class="mt-3 text-xs leading-5 text-[var(--muted)]">
                          Put these values in <code>.env</code>, then restart the dev server.
                        </p>
                      </Show>
                    </div>
                  }
                >
                  <Show when={props.snapshot.authStep === 'phone'}>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submit(() => props.onPhone(phone()));
                      }}
                    >
                      <h2 id="auth-title" class="text-xl font-semibold">
                        Your phone number
                      </h2>
                      <p class="mt-2 text-sm leading-5 text-[var(--muted)]">
                        Use the international format. Telegram will usually send the code to an
                        existing session.
                      </p>
                      <label class="auth-field mt-6">
                        <span>Phone</span>
                        <input
                          type="tel"
                          placeholder="+7 999 123 45 67"
                          value={phone()}
                          onInput={(event) => setPhone(event.currentTarget.value)}
                          autofocus
                          required
                        />
                      </label>
                      <button class="auth-submit" disabled={busy() || !phone().trim()}>
                        <Phone size={17} /> Request code
                      </button>
                    </form>
                  </Show>

                  <Show when={props.snapshot.authStep === 'code'}>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submit(() => props.onCode(code()));
                      }}
                    >
                      <h2 id="auth-title" class="text-xl font-semibold">
                        Enter the login code
                      </h2>
                      <p class="mt-2 text-sm leading-5 text-[var(--muted)]">
                        {props.snapshot.codeViaApp
                          ? 'Check one of your existing Telegram sessions.'
                          : 'Check the delivery method shown by Telegram.'}
                      </p>
                      <label class="auth-field mt-6">
                        <span>Code</span>
                        <input
                          inputmode="numeric"
                          autocomplete="one-time-code"
                          value={code()}
                          onInput={(event) => setCode(event.currentTarget.value)}
                          autofocus
                          required
                        />
                      </label>
                      <button class="auth-submit" disabled={busy() || !code().trim()}>
                        <ShieldCheck size={17} /> Sign in
                      </button>
                    </form>
                  </Show>

                  <Show when={props.snapshot.authStep === 'password'}>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submit(() => props.onPassword(password()));
                      }}
                    >
                      <h2 id="auth-title" class="text-xl font-semibold">
                        Two-step verification
                      </h2>
                      <p class="mt-2 text-sm leading-5 text-[var(--muted)]">
                        Enter your Telegram cloud password.
                      </p>
                      <label class="auth-field mt-6">
                        <span>Password</span>
                        <input
                          type="password"
                          autocomplete="current-password"
                          value={password()}
                          onInput={(event) => setPassword(event.currentTarget.value)}
                          autofocus
                          required
                        />
                      </label>
                      <button class="auth-submit" disabled={busy() || !password()}>
                        <KeyRound size={17} /> Unlock
                      </button>
                    </form>
                  </Show>
                </Show>
              </Show>
            </Show>

            <Show when={props.snapshot.error && props.snapshot.phase !== 'error'}>
              <p class="auth-error">{props.snapshot.error}</p>
            </Show>
          </section>
        </div>
      </Portal>
    </Show>
  );
}
