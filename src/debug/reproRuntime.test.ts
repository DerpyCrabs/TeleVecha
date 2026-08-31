import { describe, expect, it } from 'vitest';

import type { ReproStateV1 } from './reproFormat';
import { replayBootstrapPeerId } from './reproRuntime';

describe('repro runtime bootstrap', () => {
  it('starts from the cached peer before replaying the captured URL selection', () => {
    expect(
      replayBootstrapPeerId({
        lastPeerId: 'u:1',
        ui: { bootstrapActivePeerId: 'c:1', activePeerId: 'c:1' },
      } as ReproStateV1),
    ).toBe('u:1');
  });

  it('uses the captured URL peer when the cache had no selection', () => {
    expect(
      replayBootstrapPeerId({
        ui: { bootstrapActivePeerId: 'c:1', activePeerId: 'c:1' },
      } as ReproStateV1),
    ).toBe('c:1');
  });
});
