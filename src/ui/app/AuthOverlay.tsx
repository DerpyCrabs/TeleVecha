import { Effect } from 'effect';
import type { EngineSnapshot } from '../../telegram/types';
import KeyRound from '@effectweb/lucide/icons/key-round';
import LoaderCircle from '@effectweb/lucide/icons/loader-circle';
import Phone from '@effectweb/lucide/icons/phone';
import RotateCw from '@effectweb/lucide/icons/rotate-cw';
import ShieldCheck from '@effectweb/lucide/icons/shield-check';
import { Portal, defineTasks, inputText, submit, view } from 'effectweb';
import { modalMount } from '../shared/modalMount';
interface AuthOverlayProps {
  open: boolean;
  snapshot: EngineSnapshot;
  configurationError?: string | undefined;
  onRetry: () => Effect.Effect<void, unknown>;
  onPhone: (phone: string) => Effect.Effect<void, unknown>;
  onCode: (code: string) => Effect.Effect<void, unknown>;
  onPassword: (password: string) => Effect.Effect<void, unknown>;
}
type AuthStep = 'phone' | 'code' | 'password';
const submitClass =
  'mt-[1.2rem] flex w-full items-center justify-center gap-2 rounded-xl border-0 bg-accent p-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45';
const fieldClass =
  'mt-6 block [&>span]:mb-1.5 [&>span]:block [&>span]:text-xs [&>span]:font-semibold [&>span]:tracking-[0.04em] [&>span]:text-muted [&>span]:uppercase [&>input]:w-full [&>input]:rounded-[0.7rem] [&>input]:border [&>input]:border-[var(--line-strong)] [&>input]:bg-surface [&>input]:px-3 [&>input]:py-3 [&>input]:text-ink [&>input]:outline-0 [&>input:focus]:border-accent [&>input:focus]:shadow-[0_0_0_3px_var(--accent-soft)]';
const forms = {
  phone: {
    title: 'Your phone number',
    label: 'Phone',
    type: 'tel',
    autocomplete: undefined,
    inputmode: undefined,
    placeholder: '+7 999 123 45 67',
    submit: 'Request code',
  },
  code: {
    title: 'Enter the login code',
    label: 'Code',
    type: 'text',
    autocomplete: 'one-time-code',
    inputmode: 'numeric',
    placeholder: undefined,
    submit: 'Sign in',
  },
  password: {
    title: 'Two-step verification',
    label: 'Password',
    type: 'password',
    autocomplete: 'current-password',
    inputmode: undefined,
    placeholder: undefined,
    submit: 'Unlock',
  },
} as const;
const AuthForm = view<
  {
    step: AuthStep;
    value: string;
    busy: boolean;
    codeViaApp: boolean | undefined;
    change: (value: string) => void;
    submit: () => void;
  },
  never
>((props, _send) => {
  const form = forms[props.step];
  const description =
    props.step === 'phone'
      ? 'Use the international format. Telegram will usually send the code to an existing session.'
      : props.step === 'code'
        ? props.codeViaApp
          ? 'Check one of your existing Telegram sessions.'
          : 'Check the delivery method shown by Telegram.'
        : 'Enter your Telegram cloud password.';
  return (
    <form onSubmit={submit(props.submit)}>
      <h2 id="auth-title" class="text-xl font-semibold">
        {form.title}
      </h2>
      <p class="mt-2 text-sm leading-5 text-[var(--muted)]">{description}</p>
      <label class={fieldClass}>
        <span>{form.label}</span>
        <input
          type={form.type}
          placeholder={form.placeholder}
          inputmode={form.inputmode}
          autocomplete={form.autocomplete}
          value={props.value}
          onInput={inputText(props.change)}
          autofocus
          required
        />
      </label>
      <button
        class={submitClass}
        disabled={props.busy || !(props.step === 'password' ? props.value : props.value.trim())}
      >
        {props.step === 'phone' ? (
          <Phone size={17} />
        ) : props.step === 'code' ? (
          <ShieldCheck size={17} />
        ) : (
          <KeyRound size={17} />
        )}{' '}
        {form.submit}
      </button>
    </form>
  );
});
const ignoreClose = () => undefined;
const authentication = defineTasks({
  init: (_props: AuthOverlayProps) => ({ phone: '', code: '', password: '' }),
}).tasks({
  submit: {
    policy: 'drop',
    run: (model, step: AuthStep | 'retry'): Effect.Effect<void, unknown> => {
      switch (step) {
        case 'retry':
          return model.props.onRetry();
        case 'phone':
          return model.props.onPhone(model.phone);
        case 'code':
          return model.props.onCode(model.code);
        case 'password':
          return model.props.onPassword(model.password);
      }
    },
  },
});
export const AuthOverlay = authentication.view(
  view((model, send) => {
    const props = model.props;
    const controls = authentication.controls(send);
    const form = (step: AuthStep) => (
      <AuthForm
        step={step}
        value={model[step]}
        busy={model.tasks.submit.waiting}
        codeViaApp={props.snapshot.codeViaApp}
        change={(value) => controls.patch({ [step]: value })}
        submit={() => controls.run('submit', step)}
      />
    );
    const contents = () => {
      if (props.snapshot.phase === 'connecting' || props.snapshot.phase === 'syncing')
        return (
          <div class="py-8 text-center">
            <LoaderCircle class="mx-auto animate-spin text-[var(--accent)]" size={28} />
            <h2 id="auth-title" class="mt-4 font-semibold">
              {props.snapshot.phase === 'syncing' ? 'Loading chats' : 'Connecting to Telegram'}
            </h2>
          </div>
        );
      if (props.snapshot.phase === 'error')
        return (
          <div>
            <h2 id="auth-title" class="text-xl font-semibold">
              Connection failed
            </h2>
            <p class="mt-2 text-sm leading-5 text-[var(--muted)]">{props.snapshot.error}</p>
            <button
              class={submitClass}
              disabled={model.tasks.submit.waiting}
              onClick={() => controls.run('submit', 'retry')}
            >
              <RotateCw size={17} /> Retry
            </button>
          </div>
        );
      // Each stage has its own branch lifetime so the new field receives autofocus.
      switch (props.snapshot.authStep) {
        case 'phone':
          return form('phone');
        case 'code':
          return form('code');
        case 'password':
          return form('password');
      }
      return (
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
          {props.configurationError && (
            <>
              <pre class="mt-5 overflow-x-auto rounded-[0.7rem] border border-[var(--line-strong)] bg-surface p-3 text-xs leading-5 text-violet-300 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                VITE_TELEGRAM_API_ID=123456{`\n`}VITE_TELEGRAM_API_HASH=…
              </pre>
              <p class="mt-3 text-xs leading-5 text-[var(--muted)]">
                Put these values in <code class="text-ink">.env</code>, then restart the dev server.
              </p>
            </>
          )}
        </div>
      );
    };
    if (!props.open) return null;
    return (
      <Portal>
        <div
          use={modalMount(ignoreClose)}
          class="fixed inset-0 z-50 grid place-items-center bg-[var(--overlay)] p-6 backdrop-blur-[14px]"
          tabIndex={-1}
        >
          <section
            class="relative max-h-[calc(100dvh-3rem)] w-full max-w-[25rem] overflow-y-auto rounded-[1.25rem] border border-[var(--line-strong)] bg-panel p-8 shadow-[0_24px_80px_var(--shadow)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-title"
          >
            {contents()}
            {props.snapshot.error && props.snapshot.phase !== 'error' && (
              <p class="mt-4 rounded-[0.65rem] border border-red-400/20 bg-red-900/15 px-3 py-2.5 text-xs leading-[1.1rem] text-red-300">
                {props.snapshot.error}
              </p>
            )}
          </section>
        </div>
      </Portal>
    );
  }),
);
