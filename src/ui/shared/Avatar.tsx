import { Show, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js';

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
  let root: HTMLDivElement | undefined;
  const [visible, setVisible] = createSignal(false);
  const size = () =>
    ({ sm: 'size-9 text-xs', md: 'size-12 text-sm', lg: 'size-20 text-xl' })[props.size ?? 'md'];
  const request = createMemo(() =>
    visible() && (props.loadCached || props.load)
      ? {
          identity: props.identity,
          loadCached: props.loadCached,
          load: props.load,
        }
      : false,
  );
  const [loadedSource] = createResource(request, async ({ identity, loadCached, load }) => {
    const cached = await loadCached?.().catch(() => undefined);
    if (cached || !load) return { identity, url: cached };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const loaded = await load().catch(() => undefined);
      if (loaded) return { identity, url: loaded };
    }
    return { identity, url: undefined };
  });
  const source = createMemo(() => {
    const loaded = loadedSource();
    return loaded?.identity === props.identity ? loaded.url : undefined;
  });

  onMount(() => {
    const element = root;
    if (!element) return;
    const stopObserving = observeAvatar(element, () => setVisible(true));
    onCleanup(stopObserving);
  });

  return (
    <div ref={(element) => (root = element)} class="relative shrink-0">
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
