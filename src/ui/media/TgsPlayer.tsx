import { gunzipSync, strFromU8 } from 'fflate';
import { createEffect, onCleanup } from 'solid-js';

export function TgsPlayer(props: { source: string; label: string }) {
  let container: HTMLDivElement | undefined;
  let generation = 0;

  createEffect(() => {
    const element = container;
    const source = props.source;
    if (!element || !source) return;
    const currentGeneration = ++generation;
    let visible = true;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation: { destroy(): void; pause(): void; play(): void } | undefined;
    const updatePlayback = () => {
      if (visible && !reducedMotion.matches) animation?.play();
      else animation?.pause();
    };
    const handleMotionPreference = () => updatePlayback();
    reducedMotion.addEventListener('change', handleMotionPreference);
    const observer =
      'IntersectionObserver' in window
        ? new IntersectionObserver(
            ([entry]) => {
              visible = Boolean(entry?.isIntersecting);
              updatePlayback();
            },
            { rootMargin: '80px' },
          )
        : undefined;
    observer?.observe(element);
    void (async () => {
      const response = await fetch(source);
      const bytes = await response.arrayBuffer();
      const animationData: unknown = JSON.parse(strFromU8(gunzipSync(new Uint8Array(bytes))));
      const { default: lottie } = await import('lottie-web/build/player/lottie_light');
      if (generation !== currentGeneration) return;
      animation = lottie.loadAnimation({
        container: element,
        renderer: 'svg',
        loop: true,
        autoplay: false,
        animationData,
      });
      updatePlayback();
    })().catch(() => {
      if (generation === currentGeneration) element.dataset.error = 'true';
    });
    onCleanup(() => {
      generation += 1;
      observer?.disconnect();
      reducedMotion.removeEventListener('change', handleMotionPreference);
      animation?.destroy();
      element.replaceChildren();
    });
  });

  return (
    <div
      ref={(element) => (container = element)}
      class="tgs-player"
      role="img"
      aria-label={props.label}
    />
  );
}
