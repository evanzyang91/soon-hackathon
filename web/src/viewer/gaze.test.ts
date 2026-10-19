import { describe, expect, it } from 'vitest';
import { gazeTargets, headYawToward } from './gaze';

const cast = [
  { id: 'maya', x: 0, z: 0 },
  { id: 'theo', x: 1, z: 0 },
  { id: 'raj', x: 4, z: 0 },
];

describe('gazeTargets', () => {
  it('everyone looks at the speaker; the speaker looks at its nearest partner', () => {
    const t = gazeTargets(cast, 'raj');
    expect(t.get('maya')).toBe('raj');
    expect(t.get('theo')).toBe('raj');
    expect(t.get('raj')).toBe('theo');
  });

  it('with nobody speaking (or an unknown speaker) each looks at its nearest partner', () => {
    for (const speaker of [null, 'ghost']) {
      const t = gazeTargets(cast, speaker);
      expect(t.get('maya')).toBe('theo');
      expect(t.get('theo')).toBe('maya');
      expect(t.get('raj')).toBe('theo');
    }
  });

  it('a lone actor has nobody to look at', () => {
    expect(gazeTargets([{ id: 'solo', x: 0, z: 0 }], 'solo').get('solo')).toBeNull();
  });
});

describe('headYawToward', () => {
  it('is relative to the body: + = turn left for a body facing −Z', () => {
    expect(headYawToward(0, 0, 0, 0, -2)).toBeCloseTo(0); // straight ahead
    expect(headYawToward(0, 0, 0, -2, 0)).toBeCloseTo(Math.PI / 2); // on the left (−X)
    expect(headYawToward(0, 0, 0, 2, 0)).toBeCloseTo(-Math.PI / 2); // on the right
    // body already turned left by 90°: the same target on −X is now straight ahead
    expect(headYawToward(0, 0, Math.PI / 2, -2, 0)).toBeCloseTo(0);
    // behind: wraps into (−π, π]
    expect(Math.abs(headYawToward(0, 0, 0, 0, 2)!)).toBeCloseTo(Math.PI);
  });

  it('gives up on a target standing on the actor', () => {
    expect(headYawToward(1, 1, 0, 1.01, 1)).toBeNull();
  });
});
