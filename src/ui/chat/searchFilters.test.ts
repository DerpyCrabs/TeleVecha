import { describe, expect, it } from 'vitest';
import { searchDateRange } from './searchFilters';

describe('search calendar range', () => {
  it('includes the entire final local day', () => {
    const value = searchDateRange('2026-11-01', '2026-11-07');
    expect(value.minDate).toBe(new Date(2026, 10, 1).getTime() / 1000);
    expect(value.maxDate).toBe(new Date(2026, 10, 8).getTime() / 1000 - 1);
  });
  it.each([
    ['2026-02-30', ''],
    ['invalid', ''],
    ['2026-11-07', '2026-11-01'],
  ])('rejects invalid ranges %s – %s', (from, until) => {
    expect(() => searchDateRange(from, until)).toThrow();
  });
  it('allows either open boundary', () => {
    expect(searchDateRange('', '')).toEqual({});
    expect(searchDateRange('', '2026-11-07')).not.toHaveProperty('minDate');
    expect(searchDateRange('2026-11-07', '')).not.toHaveProperty('maxDate');
  });
});
