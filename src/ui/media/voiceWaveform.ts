export function voiceWaveformBars(samples: readonly number[] | undefined, count = 48): number[] {
  const values =
    samples?.map((value) => (Number.isFinite(value) ? Math.max(0, Math.min(31, value)) : 0)) ?? [];
  const maximum = Math.max(1, ...values);
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * values.length) / count);
    const end = Math.max(start + 1, Math.floor(((index + 1) * values.length) / count));
    const peak = Math.max(0, ...values.slice(start, end));
    return 3 + (peak / maximum) * 23;
  });
}
