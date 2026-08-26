import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';

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
  size?: 'sm' | 'md' | 'lg';
  online?: boolean;
  loadCached?: (() => Promise<string | undefined>) | undefined;
  load?: (() => Promise<string | undefined>) | undefined;
}

export function Avatar(props: AvatarProps) {
  const [root, setRoot] = createSignal<HTMLDivElement>();
  const [source, setSource] = createSignal('');
  const [visible, setVisible] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  let generation = 0;
  let previousIdentity: string | undefined;
  let cachedAttempted = false;
  const size = () =>
    ({ sm: 'size-9 text-xs', md: 'size-12 text-sm', lg: 'size-20 text-xl' })[props.size ?? 'md'];

  onMount(() => {
    const element = root();
    if (!element) return;
    const stopObserving = observeAvatar(element, () => setVisible(true));
    onCleanup(stopObserving);
  });

  createEffect(() => {
    const identity = props.identity;
    if (identity === previousIdentity) return;
    previousIdentity = identity;
    generation += 1;
    cachedAttempted = false;
    setSource('');
    setAttempt(0);
    setLoading(false);
  });

  createEffect(() => {
    const identity = props.identity;
    const cachedLoader = props.loadCached;
    const remoteLoader = props.load;
    const currentAttempt = attempt();
    if (!visible() || source() || loading()) return;
    const isCachedAttempt = !cachedAttempted && Boolean(cachedLoader);
    const loader = isCachedAttempt ? cachedLoader : remoteLoader;
    if (!loader || (!isCachedAttempt && currentAttempt >= 3)) return;
    if (isCachedAttempt) cachedAttempted = true;
    const currentGeneration = generation;
    setLoading(true);
    void loader()
      .then((url) => {
        if (generation !== currentGeneration || props.identity !== identity) return;
        if (url) setSource(url);
        else if (!isCachedAttempt) setAttempt(currentAttempt + 1);
      })
      .catch(() => {
        if (!isCachedAttempt && generation === currentGeneration && props.identity === identity) {
          setAttempt(currentAttempt + 1);
        }
      })
      .finally(() => {
        if (generation === currentGeneration && props.identity === identity) setLoading(false);
      });
  });

  return (
    <div ref={setRoot} class="relative shrink-0">
      <div
        class={`relative grid overflow-hidden place-items-center rounded-full font-semibold tracking-tight text-white shadow-inner ${size()}`}
        style={{
          background: `linear-gradient(145deg, ${props.color}, color-mix(in srgb, ${props.color} 60%, #15171c))`,
        }}
      >
        {props.initials}
        <Show when={source()}>
          <img class="absolute inset-0 size-full object-cover" src={source()} alt="" />
        </Show>
      </div>
      <Show when={props.online}>
        <span
          class="avatar-online-indicator absolute bottom-0 right-0 size-3 rounded-full border-2 border-[var(--panel)] bg-emerald-400"
          aria-label="Online"
        />
      </Show>
    </div>
  );
}
