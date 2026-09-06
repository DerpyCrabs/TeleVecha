import { domMount, view } from 'effectweb';

const playback = domMount<HTMLVideoElement>((element) => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let visible = !('IntersectionObserver' in window);
  const update = () => {
    if (visible && !reducedMotion.matches) void element.play().catch(() => undefined);
    else element.pause();
  };
  reducedMotion.addEventListener('change', update);
  const observer =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          ([entry]) => {
            visible = Boolean(entry?.isIntersecting);
            update();
          },
          { rootMargin: '80px' },
        )
      : undefined;
  observer?.observe(element);
  update();
  return () => {
    observer?.disconnect();
    reducedMotion.removeEventListener('change', update);
    element.pause();
  };
});

export const VisibilityVideo = view<{ source: string; label?: string | undefined }, never>(
  (props, _send) => (
    <video
      use={playback}
      src={props.source}
      muted
      loop
      playsinline
      preload="metadata"
      aria-label={props.label}
    />
  ),
);
