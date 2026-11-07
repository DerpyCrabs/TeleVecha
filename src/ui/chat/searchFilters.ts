import type { TelegramSearchFilters } from '../../telegram/types';

/** Local calendar days, inclusive; the next midnight handles daylight-saving transitions. */
export function searchDateRange(
  from: string,
  until: string,
): Pick<TelegramSearchFilters, 'minDate' | 'maxDate'> {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Choose a valid date.');
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
      throw new Error('Choose a valid date.');
    return date;
  };
  const start = from ? parse(from) : undefined;
  const end = until ? parse(until) : undefined;
  if (start && end && start > end)
    throw new Error('The end date must be on or after the start date.');
  if (end) end.setDate(end.getDate() + 1);
  return {
    ...(start ? { minDate: Math.floor(start.getTime() / 1000) } : {}),
    ...(end ? { maxDate: Math.floor(end.getTime() / 1000) - 1 } : {}),
  };
}
