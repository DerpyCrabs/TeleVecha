import { describe, expect, it } from 'vitest';

import type { TvBugStateV2 } from './tvbugFormat';
import { snapshotBootstrapPeerId } from './tvbugRuntime';

describe('tvbug runtime bootstrap', () => {
  it('starts from the runtime peer captured with the snapshot', () => {
    expect(
      snapshotBootstrapPeerId({
        lastPeerId: 'u:1',
        workspace: { activePeerId: 'g:1' },
        ui: { bootstrapActivePeerId: 'c:1', activePeerId: 'c:1' },
      } as TvBugStateV2),
    ).toBe('g:1');
  });

  it('uses the current UI peer when runtime state has no selection', () => {
    expect(
      snapshotBootstrapPeerId({
        ui: { bootstrapActivePeerId: 'c:1', activePeerId: 'c:1' },
      } as TvBugStateV2),
    ).toBe('c:1');
  });
});
