import { describe, expect, it } from 'vitest';
import { sampleGround } from '../../shared/ground.ts';
import {
  buildGroundField,
  DEFAULT_PROBES,
  fieldCoverage,
  groundHeight,
  groundLayers,
  measureGround,
  probesFor,
} from './calibrate-ground.ts';

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

describe('ground field', () => {
  it('takes the lowest thin layer of a column, not a seat above it or a wall', () => {
    const sorted = (a: number[]) => a.sort((x, y) => x - y);
    const ground = layer(-0.2, 40);
    const seat = layer(0.25, 120);
    expect(groundLayers(sorted([...ground, ...seat])).map((l) => Math.round(l.y * 100))).toEqual([-20, 25]);
    // a wall's splats spread over every height: no thin layer
    expect(groundLayers(sorted(Array.from({ length: 300 }, (_, i) => -0.9 + i / 250)))).toEqual([]);
    // a faint smear under the ground (< 30 % of it) is not a layer
    expect(groundLayers(sorted([...layer(-0.45, 9), ...layer(-0.2, 60)])).map((l) => Math.round(l.y * 100))).toEqual([-20]);
  });

  /**
   * A street in the field's frame: road at -0.2 m (z < -2), a 15 cm kerb up to the pavement, a bench
   * seat at +0.25 with no ground captured under it, a table top over visible road, one bump cell
   * 12 cm high, and a wall of upright splats with nothing in front of it.
   */
  function street() {
    const pos: number[] = [];
    const op: number[] = [];
    const up: number[] = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const add = (x: number, y: number, z: number, u = 1) => {
      pos.push(x, y, z);
      op.push(0.9);
      up.push(u);
    };
    for (let x = -2; x < 2; x += 0.05)
      for (let z = -4; z < 0; z += 0.05) {
        const px = x + rnd() * 0.05;
        const pz = z + rnd() * 0.05;
        const noise = (rnd() - 0.5) * 0.02;
        if (px >= 1.75) {
          for (let y = -0.2; y < 0.4; y += 0.05) add(px, y + noise, pz, 0.1); // wall
        } else if (px >= 0.5 && px < 1.5 && pz >= -1 && pz < -0.5) {
          add(px, 0.25 + noise, pz); // bench seat, ground hidden
        } else {
          const bump = px >= -1.5 && px < -1.25 && pz >= -3.25 && pz < -3 ? 0.12 : 0;
          add(px, (pz < -2 ? -0.2 : -0.05) + bump + noise, pz);
          if (px >= 0 && px < 1 && pz >= -3.5 && pz < -2.5) add(px, 0.3 + noise, pz); // table top
        }
      }
    return { positions: Float32Array.from(pos), opacities: Float32Array.from(op), surfaceUp: Float32Array.from(up) };
  }

  it('measures each 0.25 m column: kerb kept sharp, furniture and walls left out, spikes removed', () => {
    const f = buildGroundField(street(), { x: [-2, 2], z: [-4, 0] })!;
    expect(f.cell).toBe(0.25);
    const at = (x: number, z: number) => sampleGround(f, x, z, 0);
    expect(at(-1.125, -3.625)).toBeCloseTo(-0.2, 2); // road
    expect(at(-1.125, -0.625)).toBeCloseTo(-0.05, 2); // pavement
    // the kerb is a one-cell step: the cells either side keep their own height
    expect(at(-0.125, -2.125)).toBeCloseTo(-0.2, 2);
    expect(at(-0.125, -1.875)).toBeCloseTo(-0.05, 2);
    expect(at(0.625, -3.125)).toBeCloseTo(-0.2, 2); // under the table
    expect(at(-1.375, -3.125)).toBeCloseTo(-0.2, 2); // the bump cell
    const cellAt = (x: number, z: number) =>
      f.heights[Math.floor((z - f.origin[1]) / f.cell) * f.cols + Math.floor((x - f.origin[0]) / f.cell)];
    expect(cellAt(1.125, -0.75)).toBeNull(); // the bench seat
    // the wall column has no ground and is cropped away
    expect(f.origin[0] + f.cols * f.cell).toBeCloseTo(1.75, 6);
    const { covered, cells } = fieldCoverage(f);
    expect(cells).toBe(15 * 16);
    expect(covered).toBe(cells - 8); // only the bench's 4 × 2 cells are holes
    expect(f.method).toMatch(/^previz ground v1: /);
  });
});
