import { commandSlot, effectCommand, component, domBinding, view } from 'effectweb';
import { Effect } from 'effect';
import type { Send, Transition } from 'effectweb';
const commandAvatar = commandSlot('avatar');

const visibleAvatars = new Map<Element, () => void>();
let avatarObserver: IntersectionObserver | undefined;
function observeAvatar(element: Element, visible: () => void) {
  if (!('IntersectionObserver' in window)) {
    visible();
    return () => undefined;
  }
  avatarObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const reveal = visibleAvatars.get(entry.target);
      if (!reveal) continue;
      visibleAvatars.delete(entry.target);
      avatarObserver?.unobserve(entry.target);
      reveal();
    }
  });
  visibleAvatars.set(element, visible);
  avatarObserver.observe(element);
  return () => {
    visibleAvatars.delete(element);
    avatarObserver?.unobserve(element);
    if (visibleAvatars.size === 0) {
      avatarObserver?.disconnect();
      avatarObserver = undefined;
    }
  };
}
interface AvatarProps {
  identity: string;
  initials: string;
  color: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  online?: boolean;
  loadCached?: (() => Effect.Effect<string | undefined, unknown>) | undefined;
  load?: (() => Effect.Effect<string | undefined, unknown>) | undefined;
}
interface AvatarModel {
  props: AvatarProps;
  visible: boolean;
  requested: string;
  source: string | undefined;
}
type AvatarMessage = { type: 'Visible' } | { type: 'Loaded'; source: string | undefined };
function request(model: AvatarModel): Transition<AvatarModel, AvatarMessage> {
  const { props } = model;
  const key = `${props.identity}:${Boolean(props.loadCached)}:${Boolean(props.load)}`;
  if (!model.visible || key === model.requested) return { model };
  return {
    model: { ...model, requested: key, source: undefined },
    commands: [
      effectCommand(
        commandAvatar,
        () =>
          Effect.gen(function* () {
            const cached = yield* Effect.suspend(
              () => props.loadCached?.() ?? Effect.succeed(undefined),
            ).pipe(Effect.catch(() => Effect.succeed(undefined)));
            if (cached || !props.load) return cached;
            for (let attempt = 0; attempt < 3; attempt++) {
              const source = yield* Effect.suspend(props.load).pipe(
                Effect.catch(() => Effect.succeed(undefined)),
              );
              if (source) return source;
            }
            return undefined;
          }),
        {
          policy: 'replace',
          onSuccess: (source) => ({ type: 'Loaded', source }),
          onFailure: (): AvatarMessage => ({ type: 'Loaded', source: undefined }),
        },
      ),
    ],
  };
}
const sizes = {
  xs: 'size-4 text-[0.42rem]',
  sm: 'size-9 text-xs',
  md: 'size-12 text-sm',
  lg: 'size-20 text-xl',
};
function acquireVisibility(element: HTMLElement, input: () => Send<AvatarMessage>) {
  return observeAvatar(element, () => input()({ type: 'Visible' }));
}
const visibility = (send: Send<AvatarMessage>) => domBinding(send, acquireVisibility);
export const Avatar = component<AvatarProps, AvatarModel, AvatarMessage>({
  init: (props) => ({ props, visible: false, requested: '', source: undefined }),
  receive: (model, props) => request({ ...model, props }),
  update: (model, message) =>
    message.type === 'Visible'
      ? request({ ...model, visible: true })
      : { model: { ...model, source: message.source } },
  view: view((model, send) => {
    const props = model.props;
    return (
      <div use={visibility(send)} class="relative shrink-0">
        <div
          data-avatar-identity={props.identity}
          class={`relative grid overflow-hidden place-items-center rounded-full font-semibold tracking-tight text-white shadow-inner ${sizes[props.size ?? 'md']}`}
          style={{
            background: `linear-gradient(145deg, ${props.color}, color-mix(in srgb, ${props.color} 60%, #15171c))`,
          }}
        >
          {props.initials}
          {model.source ? (
            <img
              class="absolute inset-0 size-full object-cover"
              src={model.source}
              alt=""
              draggable={false}
            />
          ) : null}
        </div>
        {props.online ? (
          <span
            class="avatar-online-indicator absolute bottom-0 right-0 size-3 rounded-full border-2 border-[var(--panel)] bg-emerald-400"
            aria-label="Online"
          />
        ) : null}
      </div>
    );
  }),
});
