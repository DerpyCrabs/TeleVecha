import { describe, expect, it } from 'vitest';

import { makeVersionIndex } from './versionIndex';

describe('version index', () => {
  it('never reuses a token after deleting an operation key', () => {
    const versions = makeVersionIndex();
    const first = versions.next('mutation', 'mute:u:1');
    versions.delete('mutation', 'mute:u:1', first);
    const second = versions.next('mutation', 'mute:u:1');

    expect(second).toBeGreaterThan(first);
    expect(versions.delete('mutation', 'mute:u:1', first)).toBe(false);
    expect(versions.current('mutation', 'mute:u:1')).toBe(second);
  });

  it('continues above restored revisions and clears one concern independently', () => {
    const versions = makeVersionIndex();
    versions.set('draft', 'u:1', 40);
    versions.next('reaction', 'u:1:7');

    expect(versions.increment('draft', 'u:1')).toBe(41);
    versions.clear('draft');
    expect(versions.current('draft', 'u:1')).toBe(0);
    expect(versions.current('reaction', 'u:1:7')).toBe(41);
  });
});
