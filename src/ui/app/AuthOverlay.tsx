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
  const submitClass =
    'mt-[1.2rem] flex w-full items-center justify-center gap-2 rounded-xl border-0 bg-accent p-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45';
  const fieldClass =
    'mt-6 block [&>span]:mb-1.5 [&>span]:block [&>span]:text-xs [&>span]:font-semibold [&>span]:tracking-[0.04em] [&>span]:text-muted [&>span]:uppercase [&>input]:w-full [&>input]:rounded-[0.7rem] [&>input]:border [&>input]:border-[var(--line-strong)] [&>input]:bg-surface [&>input]:px-3 [&>input]:py-3 [&>input]:text-ink [&>input]:outline-0 [&>input:focus]:border-accent [&>input:focus]:shadow-[0_0_0_3px_var(--accent-soft)]';
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
        <div
          ref={(element) => (backdrop = element)}
          class="fixed inset-0 z-50 grid place-items-center bg-[var(--overlay)] p-6 backdrop-blur-[14px]"
          tabIndex={-1}
        >
          <section
            class="relative max-h-[calc(100dvh-3rem)] w-full max-w-[25rem] overflow-y-auto rounded-[1.25rem] border border-[var(--line-strong)] bg-panel p-8 shadow-[0_24px_80px_var(--shadow)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-title"
          >
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
                      class={submitClass}
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
                        {props.configurationError
                          ? 'Configuration required'
                          : props.snapshot.phase === 'idle'
                            ? 'Starting TeleVecha'
                            : 'Telegram connected'}
                      </h2>
                      <p class="mt-2 text-sm leading-5 text-[var(--muted)]">
                        {props.configurationError ??
                          (props.snapshot.phase === 'idle'
                            ? 'Waiting for this tab to join the active Telegram session.'
                            : 'The application credentials came from the local Vite environment.')}
                      </p>
                      <Show when={props.configurationError}>
                        <pre class="mt-5 overflow-x-auto rounded-[0.7rem] border border-[var(--line-strong)] bg-surface p-3 text-xs leading-5 text-violet-300 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                          VITE_TELEGRAM_API_ID=123456{`\n`}VITE_TELEGRAM_API_HASH=…
                        </pre>
                        <p class="mt-3 text-xs leading-5 text-[var(--muted)]">
                          Put these values in <code class="text-ink">.env</code>, then restart the
                          dev server.
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
                      <label class={fieldClass}>
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
                      <button class={submitClass} disabled={busy() || !phone().trim()}>
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
                      <label class={fieldClass}>
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
                      <button class={submitClass} disabled={busy() || !code().trim()}>
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
                      <label class={fieldClass}>
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
                      <button class={submitClass} disabled={busy() || !password()}>
                        <KeyRound size={17} /> Unlock
                      </button>
                    </form>
                  </Show>
                </Show>
              </Show>
            </Show>

            <Show when={props.snapshot.error && props.snapshot.phase !== 'error'}>
              <p class="mt-4 rounded-[0.65rem] border border-red-400/20 bg-red-900/15 px-3 py-2.5 text-xs leading-[1.1rem] text-red-300">
                {props.snapshot.error}
              </p>
            </Show>
          </section>
        </div>
      </Portal>
    </Show>
  );
}
