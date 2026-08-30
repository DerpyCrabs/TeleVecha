import { describe, expect, it, vi } from 'vitest';

import { reportDiagnostic, subscribeDiagnostics } from './diagnostics';

describe('diagnostics', () => {
  it('fans structured entries out to removable listeners', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const received: unknown[] = [];
    const unsubscribe = subscribeDiagnostics((event) => received.push(event));

    reportDiagnostic({ level: 'info', area: 'sync', message: 'Caught up.' });
    unsubscribe();
    reportDiagnostic({ level: 'info', area: 'sync', message: 'After unsubscribe.' });

    expect(received).toEqual([
      expect.objectContaining({
        level: 'info',
        area: 'sync',
        message: 'Caught up.',
        time: expect.any(String),
      }),
    ]);
    consoleInfo.mockRestore();
  });
});
