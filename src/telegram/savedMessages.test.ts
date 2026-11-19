import { expect, it } from 'vitest';
import { savedReactionValid } from './savedMessages';

it('rejects custom tag document IDs that overflow the signed TL long', () => {
  expect(savedReactionValid('custom:9223372036854775807')).toBe(true);
  expect(savedReactionValid('custom:9223372036854775808')).toBe(false);
});
