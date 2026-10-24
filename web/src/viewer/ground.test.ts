import { describe, expect, it } from 'vitest';
import { GROUND_FIELD_SCHEMA, type GroundField } from '@shared/ground';
import type { Vec3, WorldAsset } from '@shared/schema';
import { aboveGround, groundSampler, onGround } from './ground';
import { applyWorldTransform, worldTransform } from './transform';

const asset: WorldAsset = {
  provider: 'marble',
  spz: { k500: 'w.spz' },
  metricScaleFactor: 2.2,
  groundPlaneOffset: 1.49,
  opencvFrame: true,
  scaleCalibration: { factor: 1.25, method: 'test', confidence: 'high', evidence: 'test' },
  floorOffsetMeters: 0.1,
};

/** A field over x, z ∈ [-4, 4) (Marble's frame) sloping 0.1 m per m along x through (x0, y0). */
function slopedField(x0: number, y0: number, slope = 0.1): GroundField {
  const cols = 32;
  const rows = 32;
  const heights: (number | null)[] = Array.from({ length: cols * rows }, (_, c) => y0 + slope * (-4 + ((c % cols) + 0.5) * 0.25 - x0));
  return { schema: GROUND_FIELD_SCHEMA, origin: [-4, -4], cell: 0.25, cols, rows, heights };
}

describe('ground sampler', () => {
  it('puts the feet where the viewer renders a ground splat, at any calibration factor', () => {
    // a raw SPZ point on sloping ground, seen in the field's frame (factor 1, no raise) …
    const raw: Vec3 = [0.9, 0.62, 1.1];
    const inField = applyWorldTransform(worldTransform({ ...asset, scaleCalibration: null, floorOffsetMeters: 0 }), raw);
    // … and where the viewer draws it (× 1.25 about the origin, raised by the floor offset)
    const inScene = applyWorldTransform(worldTransform(asset), raw);
    const groundY = groundSampler(slopedField(inField[0], inField[1]), asset);
    expect(groundY(inScene[0], inScene[2])).toBeCloseTo(inScene[1], 6);
    // the median ground (-floorOffsetMeters) is the scene's y = 0
    expect(groundSampler(slopedField(0, -0.1, 0), asset)(0.3, -2.4)).toBeCloseTo(0, 6);
  });

  it('falls back to y = 0 without a field', () => {
    expect(groundSampler(null, asset)(1, -3)).toBe(0);
  });
});

describe('actor heights are stored relative to the ground', () => {
  const groundY = (x: number, z: number) => 0.0625 * x - 0.125 * z;
  it('renders y = 0 on the ground and keeps a raise as a raise', () => {
    expect(onGround([2, 0, -1], groundY)).toEqual([2, 0.25, -1]);
    expect(onGround([2, 0.5, -1], groundY)).toEqual([2, 0.75, -1]);
    const p: Vec3 = [-1.5, 0.25, -2.5];
    expect(aboveGround(onGround(p, groundY), groundY)).toEqual(p);
  });
});
