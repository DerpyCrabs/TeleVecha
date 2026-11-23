export function attachTextSendMotion(scroller: HTMLElement, tail: () => Element | null) {
  let settleFlight: (() => void) | undefined;
  let draftBounds: DOMRect | undefined;
  let beforeSend: { row: Element | null; top: number } | undefined;
  const rememberPosition = (event: Event) => {
    if (
      event.target instanceof Element &&
      event.target.closest('.composer, [aria-label="Send message"]')
    ) {
      draftBounds = document.querySelector('.composer textarea')?.getBoundingClientRect();
      const row = tail();
      beforeSend = { row, top: row?.getBoundingClientRect().top ?? 0 };
    }
  };
  document.addEventListener('keydown', rememberPosition, true);
  document.addEventListener('click', rememberPosition, true);
  function animate(row: Element, previous: Element | null) {
    const bubble = row.querySelector<HTMLElement>(
      'article.outgoing:not([data-media-kind]):has(.message-body)',
    );
    const field = document.querySelector<HTMLTextAreaElement>('.composer textarea');
    if (!beforeSend || beforeSend.row !== previous) return false;
    if (!bubble && !row.querySelector('article.incoming')) return false;
    if (
      !bubble &&
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >
        row.getBoundingClientRect().height + 2
    )
      return false;
    settleFlight?.();
    const previousTop = beforeSend.top;
    beforeSend = undefined;
    scroller.scrollTop = scroller.scrollHeight;
    const shift = previous ? previousTop - previous.getBoundingClientRect().top : 0;
    // Open space above the arriving row. The viewport's existing bottom
    // pin moves the history as one surface, including during overlapping sends.
    if (shift > 0) {
      const margin = parseFloat(getComputedStyle(row).marginTop);
      row.animate([{ marginTop: margin - shift + 'px' }, { marginTop: margin + 'px' }], {
        duration: 185,
        easing: 'cubic-bezier(.2,.55,.55,1)',
      });
      scroller.scrollTop = scroller.scrollHeight;
    }
    beforeSend = { row, top: row.getBoundingClientRect().top };
    if (!bubble || !field) {
      row.animate([{ opacity: 0 }, { opacity: 1 }], { id: 'message-arrival', duration: 185 });
      return true;
    }
    const end = bubble.getBoundingClientRect();
    const start = draftBounds ?? field.getBoundingClientRect();
    if (!end.width || end.bottom > start.bottom) return false;

    // The composer is outside the clipped message scroller. Paint the moving
    // bubble above both until it reaches the real message in the history.
    const flight = document.createElement('div');
    flight.className = bubble.className;
    for (const child of bubble.childNodes) flight.append(child.cloneNode(true));
    flight.inert = true;
    flight.setAttribute('aria-hidden', 'true');
    Object.assign(flight.style, {
      position: 'fixed',
      left: end.left + 'px',
      top: end.top + 'px',
      width: end.width + 'px',
      maxWidth: 'none',
      margin: '0',
      zIndex: '100',
      pointerEvents: 'none',
      overflow: 'hidden',
      background: getComputedStyle(bubble).background,
      color: getComputedStyle(bubble).color,
    });
    document.body.append(flight);
    const timing = { duration: 400, easing: 'linear' };
    const hidden = row.animate([{ opacity: 0 }, { opacity: 0 }], {
      ...timing,
      id: 'message-arrival',
    });
    const body = bubble.querySelector('.message-body')!.getBoundingClientRect();
    const inputStyle = getComputedStyle(field);
    const startLeft = start.left + parseFloat(inputStyle.paddingLeft) - (body.left - end.left);
    const startTop = start.top + parseFloat(inputStyle.paddingTop) - (body.top - end.top);
    const button = document.querySelector('.send-button')?.getBoundingClientRect();
    const startRight = Math.min(start.right, button?.left ?? start.right);
    // Keep both edges continuous. The right edge can pass over the controls
    // only once the bottom of the bubble has cleared the composer.
    const rise = startTop - end.top;
    const clearance = startTop + end.height - (button?.top ?? start.bottom);
    // Drive the text on one horizontal trajectory. Carry the right edge with
    // it as soon as the bubble has contracted to its final width.
    const contraction = [0, 0.14, 0.39, 0.69, 0.91, 1];
    const elevation = [0, 0, 0.02, 0.16, 0.34, 0.54, 0.7, 0.82, 0.9, 0.96, 0.98, 0.99, 1];
    const distance = end.left - startLeft;
    const narrowAt = (startRight - end.width - startLeft) / Math.max(1, distance);
    const frames = elevation.map((height, index) => {
      const progress = contraction[index] ?? 1;
      const left = startLeft + distance * progress;
      const width = Math.max(end.width, startRight - left);
      const approach = Math.min(1, progress / Math.max(0.01, narrowAt));
      const lift = Math.min(rise, Math.max(0, clearance) * approach ** 2);
      const top = startTop - lift - (rise - lift) * height;
      return {
        transform: `translate(${left - end.left}px, ${top - end.top}px)`,
        width: width + 'px',
      };
    });
    field.animate([{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: 180 });
    flight.animate(
      [
        { backgroundColor: 'transparent' },
        { backgroundColor: getComputedStyle(bubble).backgroundColor },
      ],
      { duration: 110 },
    );
    const motion = flight.animate(frames, { ...timing, id: 'text-send-flight' });
    flight
      .querySelector('footer')
      ?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }], timing);
    const finish = () => {
      flight.remove();
      hidden.cancel();
      if (settleFlight === finish) settleFlight = undefined;
    };
    settleFlight = finish;
    motion.onfinish = finish;
    motion.oncancel = finish;
    return true;
  }
  function reset() {
    settleFlight?.();
    beforeSend = undefined;
    draftBounds = undefined;
  }
  return {
    animate,
    reset,
    dispose() {
      reset();
      document.removeEventListener('keydown', rememberPosition, true);
      document.removeEventListener('click', rememberPosition, true);
    },
  };
}
