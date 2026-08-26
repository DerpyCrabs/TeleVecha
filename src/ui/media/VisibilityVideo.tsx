import { onCleanup, onMount } from 'solid-js';

export function VisibilityVideo(props: { source: string; label?: string | undefined }) {
  let video: HTMLVideoElement | undefined;

  onMount(() => {
    if (!video) return;
    const element = video;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = !('IntersectionObserver' in window);
    const updatePlayback = () => {
      if (visible && !reducedMotion.matches) void element.play().catch(() => undefined);
      else element.pause();
    };
    const handleMotionPreference = () => updatePlayback();
    reducedMotion.addEventListener('change', handleMotionPreference);
    if (!('IntersectionObserver' in window)) {
      updatePlayback();
      onCleanup(() => {
        reducedMotion.removeEventListener('change', handleMotionPreference);
        element.pause();
      });
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = Boolean(entry?.isIntersecting);
        updatePlayback();
      },
      { rootMargin: '80px' },
    );
    observer.observe(element);
    onCleanup(() => {
      observer.disconnect();
      reducedMotion.removeEventListener('change', handleMotionPreference);
      element.pause();
    });
  });

  return (
    <video
      ref={(element) => (video = element)}
      src={props.source}
      muted
      loop
      playsinline
      preload="metadata"
      aria-label={props.label}
    />
  );
}
