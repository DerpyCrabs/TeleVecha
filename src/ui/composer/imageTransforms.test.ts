import { describe, expect, it } from 'vitest';

import { planImageTransform } from './imageTransforms';

describe('planImageTransform', () => {
  it('center-crops a landscape image to a square', () => {
    expect(planImageTransform(1200, 800, 0, 'square')).toEqual({
      sourceX: 200,
      sourceY: 0,
      sourceWidth: 800,
      sourceHeight: 800,
      outputWidth: 800,
      outputHeight: 800,
    });
  });

  it('uses the final orientation when cropping a rotated image', () => {
    expect(planImageTransform(1200, 800, 90, '16:9')).toEqual({
      sourceX: 375,
      sourceY: 0,
      sourceWidth: 450,
      sourceHeight: 800,
      outputWidth: 800,
      outputHeight: 450,
    });
  });

  it('swaps the output dimensions for an uncropped quarter turn', () => {
    expect(planImageTransform(640, 480, 270, 'original')).toMatchObject({
      sourceWidth: 640,
      sourceHeight: 480,
      outputWidth: 480,
      outputHeight: 640,
    });
  });
});
