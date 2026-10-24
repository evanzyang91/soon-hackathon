import { describe, expect, it } from 'vitest';
import { DEFAULT_PROBES, groundHeight, measureGround, probesFor } from './calibrate-ground.ts';

/** Heights of a ground layer at `y` (±1 cm), plus `extra` above it. */
const layer = (y: number, n: number, extra: number[] = []) => [
  ...Array.from({ length: n }, (_, i) => y + ((i % 21) - 10) / 1000),
  ...extra,
];

describe('splat ground', () => {
  it('finds the densest thin layer, not the clutter above it', () => {
    const shins = Array.from({ length: 120 }, (_, i) => -0.1 + (i % 40) / 100);
    expect(groundHeight(layer(-0.2, 400, shins))).toBeCloseTo(-0.2, 2);
    // a bench top (0.45 m) is out of range; a dense kerb below the shins still loses to the ground
    expect(groundHeight(layer(0.02, 300, [...Array(200).fill(0.45), ...Array(80).fill(0.12)]))).toBeCloseTo(0.02, 2);
    expect(groundHeight(layer(-0.05, 100))).toBeNull(); // too few splats to say
  });

  it('measures each probe column and takes the median', () => {
    const pts: number[] = [];
    const op: number[] = [];
    const add = (x: number, z: number, ys: number[], o = 0.9) =>
      ys.forEach((y) => {
        pts.push(x + ((pts.length % 9) - 4) / 100, y, z);
        op.push(o);
      });
    add(0, -2.5, layer(-0.18, 300));
    add(1.5, -3, layer(-0.2, 300));
    add(-1.5, -3, layer(-0.26, 300));
    add(-1.5, -3, layer(0.1, 900), 0.2); // faint floaters do not count
    const g = measureGround(Float32Array.from(pts), Float32Array.from(op), DEFAULT_PROBES);
    expect(g.probes.map((p) => p.height)).toEqual([-0.18, -0.2, -0.26]);
    expect(g.height).toBe(-0.2);
    expect(probesFor([[0.8, -2.6]])).toEqual([{ x: 0.8, z: -2.6, r: 0.6 }]);
    expect(probesFor([])).toEqual(DEFAULT_PROBES);
  });
});
