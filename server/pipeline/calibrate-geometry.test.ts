import { describe, expect, it } from 'vitest';
import {
  analyzeGeometry,
  floorField,
  metricTriangles,
  modeCluster,
  rasterize,
  RayGrid,
  weightedMedian,
} from './calibrate-geometry.ts';

type P = [number, number, number];

/** Two triangles a-b-c, a-c-d (normal (b−a)×(c−a)). */
const quad = (a: P, b: P, c: P, d: P) => [...a, ...b, ...c, ...a, ...c, ...d];
/** Horizontal rectangle at height y, facing up or down. */
const flat = (x0: number, z0: number, x1: number, z1: number, y: number, up: boolean) =>
  up
    ? quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0])
    : quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]);
/** Vertical wall rectangle from (x0,z0) to (x1,z1), y0..y1. */
const wall = (x0: number, z0: number, x1: number, z1: number, y0: number, y1: number) =>
  quad([x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]);
/** Closed box with outward faces. */
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => [
  ...flat(x0, z0, x1, z1, y1, true),
  ...flat(x0, z0, x1, z1, y0, false),
  ...wall(x0, z0, x1, z0, y0, y1),
  ...wall(x1, z0, x1, z1, y0, y1),
  ...wall(x1, z1, x0, z1, y0, y1),
  ...wall(x0, z1, x0, z0, y0, y1),
];

/**
 * A 6 × 6 m kitchen, real-world sizes × `s`, floor at `floorY`: 2.7 m ceiling, a 2 × 0.6 m
 * counter (0.9 m) against the back wall, a freestanding 0.8 m table (0.75 m), and a 0.9 × 2.04 m
 * doorway in the +x wall.
 */
function room(s = 1, floorY = 0): Float32Array {
  const H = 2.7;
  const parts = [
    flat(-3, -3, 3, 3, 0, true),
    flat(-3, -3, 3, 3, H, false),
    wall(-3, -3, 3, -3, 0, H),
    wall(-3, 3, 3, 3, 0, H),
    wall(-3, -3, -3, 3, 0, H),
    wall(3, -3, 3, 0.05, 0, H),
    wall(3, 0.95, 3, 3, 0, H),
    wall(3, 0.05, 3, 0.95, 2.04, H), // lintel over the doorway
    box(-1, 0, -3, 1, 0.9, -2.4), // counter
    box(-2.2, 0.72, 0.8, -1.4, 0.75, 1.6), // table top
  ];
  return Float32Array.from(parts.flat(), (v, i) => (i % 3 === 1 ? v * s + floorY : v * s));
}

const byKind = (ms: { kind: string; measured: number }[], k: string) => ms.find((m) => m.kind === k);

describe('collider geometry', () => {
  it('measures ceiling, counter, table and doorway in a true-scale room (implied ≈ typical/measured)', () => {
    const r = analyzeGeometry(room(), { cameraY: 1.6, interior: true });
    expect(byKind(r.measurements, 'ceiling')!.measured).toBeCloseTo(2.7, 1);
    expect(byKind(r.measurements, 'counter')!.measured).toBeCloseTo(0.9, 2);
    expect(byKind(r.measurements, 'table')!.measured).toBeCloseTo(0.75, 2);
    expect(byKind(r.measurements, 'door')!.measured).toBeCloseTo(2.04, 1);
    expect(r.floorAtCamera).toBeCloseTo(0, 3);
    expect(r.cameraHeight).toBeCloseTo(1.6, 3);
    for (const m of r.measurements) expect(m.implied).toBeCloseTo(m.expected.typ / m.measured, 6);
  });

  it('sees a room delivered 20 % too small: every reference implies 1.25× more correction', () => {
    const full = analyzeGeometry(room(), { cameraY: 1.6, interior: true });
    const small = analyzeGeometry(room(0.8), { cameraY: 1.6 * 0.8, interior: true });
    for (const k of ['ceiling', 'counter', 'table', 'door', 'camera']) {
      const a = full.measurements.find((m) => m.kind === k)!;
      const b = small.measurements.find((m) => m.kind === k)!;
      expect(b.implied / a.implied, k).toBeCloseTo(1.25, 1);
    }
  });

  it('measures heights from the local floor when the ground plane is off (floor 0.2 m below y = 0)', () => {
    const r = analyzeGeometry(room(1, -0.2), { cameraY: 1.6, interior: true });
    expect(r.floorAtCamera).toBeCloseTo(-0.2, 2);
    expect(r.floorOffset).toBeCloseTo(0.2, 2);
    expect(byKind(r.measurements, 'counter')!.measured).toBeCloseTo(0.9, 2);
    expect(byKind(r.measurements, 'ceiling')!.measured).toBeCloseTo(2.7, 1);
    expect(r.cameraHeight).toBeCloseTo(1.8, 2);
  });

  it('tells the room is an interior by itself and copes with reversed winding', () => {
    expect(analyzeGeometry(room(), { cameraY: 1.6 }).interior).toBe(true);
    const flipped = room();
    for (let t = 0; t < flipped.length; t += 9)
      for (let k = 0; k < 3; k++) {
        const tmp = flipped[t + 3 + k]!;
        flipped[t + 3 + k] = flipped[t + 6 + k]!;
        flipped[t + 6 + k] = tmp;
      }
    const r = analyzeGeometry(flipped, { cameraY: 1.6, interior: true });
    expect(byKind(r.measurements, 'counter')!.measured).toBeCloseTo(0.9, 2);
  });

  it('an open plane with nothing on it yields only the camera band', () => {
    const r = analyzeGeometry(Float32Array.from(flat(-10, -10, 10, 10, 0, true)), { cameraY: 1.5 });
    expect(r.interior).toBe(false);
    expect(r.measurements.map((m) => m.kind)).toEqual(['camera']);
  });

  it('floor field takes the neighbours’ floor under a counter top with no floor below it', () => {
    const tris = Float32Array.from([...flat(-2, -2, 2, 2, 0, true), ...flat(-0.5, -0.5, 0.5, 0.5, 0.9, true)]);
    // punch the floor out under the counter: rebuild without it there
    const holed = Float32Array.from([
      ...flat(-2, -2, -0.5, 2, 0, true),
      ...flat(0.5, -2, 2, 2, 0, true),
      ...flat(-0.5, -2, 0.5, -0.5, 0, true),
      ...flat(-0.5, 0.5, 0.5, 2, 0, true),
      ...flat(-0.5, -0.5, 0.5, 0.5, 0.9, true),
    ]);
    for (const t of [tris, holed]) {
      const c = rasterize(t, { x0: -2, z0: -2, x1: 2, z1: 2 }, 0.1);
      const f = floorField(c);
      expect(f[20 * c.nz + 20]).toBeCloseTo(0, 3); // the column at the counter's centre
    }
  });

  it('metricTriangles applies the viewer transform: flip, scale × factor, floor at 0', () => {
    // raw OpenCV point on the floor (y = gpo / msf) and one 1 raw unit above it
    const raw = Float32Array.from([0, 1.5 / 0.75, -2, 0, 1.5 / 0.75 - 1, -2, 1, 0, 0]);
    const m = metricTriangles(raw, { metricScaleFactor: 0.75, groundPlaneOffset: 1.5 }, 1.2);
    expect(m[1]).toBeCloseTo(0, 6);
    expect(m[2]).toBeCloseTo(2 * 0.75 * 1.2, 6);
    expect(m[4]).toBeCloseTo(0.75 * 1.2, 6);
  });

  it('RayGrid.cast finds the nearest triangle along long rays', () => {
    const tris = room();
    const g = new RayGrid(tris);
    expect(g.cast([0, 1, 0], [0, 0, -1], 15)).toBeCloseTo(3, 6); // back wall
    expect(g.cast([0, 1, 0], [1, 0, 0], 15)).toBeCloseTo(3, 6); // +x wall beside the doorway
    expect(g.cast([2, 1, 0.5], [1, 0, 0], 15)).toBeNull(); // straight through the doorway
    expect(g.cast([0, 0.5, -1], [0, 0, -1], 15)).toBeCloseTo(1.4, 6); // counter front
  });

  it('helpers: weighted median and the densest window', () => {
    expect(weightedMedian([1, 2, 3], [1, 1, 5])).toBe(3);
    expect(weightedMedian([0.9, 1.0, 1.1], [1, 1, 1])).toBe(1.0);
    expect(Number.isNaN(weightedMedian([], []))).toBe(true);
    const m = modeCluster([2.6, 2.61, 2.62, 2.63, 1.95, 3.4], 0.1);
    expect(m.value).toBeCloseTo(2.615, 3);
    expect(m.share).toBeCloseTo(4 / 6, 6);
  });
});
