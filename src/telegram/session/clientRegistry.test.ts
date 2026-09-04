import { describe, expect, it } from 'vitest';

import { initialEngineSnapshot } from '../core/engineState';
import { makeClientRegistry } from './clientRegistry';

describe('clientRegistry', () => {
  it('keeps one coherent record for a tab', () => {
    const registry = makeClientRegistry();
    const snapshot = { ...initialEngineSnapshot(), activePeerId: 'peer-1' };

    registry.setSnapshot('tab-1', snapshot);
    registry.setVisibility('tab-1', { peerId: 'peer-1', visible: true, atBottom: true }, 100);

    expect(registry.snapshot('tab-1')).toBe(snapshot);
    expect(registry.visibilityReports('peer-1', 100)).toEqual([
      { peerId: 'peer-1', visible: true, atBottom: true },
    ]);
    expect(registry.staleClientIds(101, 'owner')).toEqual(['tab-1']);
  });

  it('removes projection, liveness, and visibility together', () => {
    const registry = makeClientRegistry();
    registry.setSnapshot('tab-1', initialEngineSnapshot());
    registry.setVisibility('tab-1', { peerId: 'peer-1', visible: true, atBottom: false }, 100);
    registry.queueState('tab-1');

    expect(registry.remove('tab-1')).toBe('peer-1');
    expect(registry.snapshot('tab-1')).toBeUndefined();
    expect(registry.visibilityReports('peer-1', 0)).toEqual([]);
    expect(registry.takeQueuedStateClients()).toEqual([]);
  });
});
