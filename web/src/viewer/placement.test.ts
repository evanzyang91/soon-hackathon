import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  candidateSpots,
  colliderTriangles,
  correctPlacement,
  hasFloor,
  rayHit,
  spotBlocked,
  TriGrid,
  trianglesNear,
  yawToward,
} from './placement';

type Box = [number, number, number, number, number, number]; // x0 y0 z0 x1 y1 z1

/** Closed box as 12 triangles. */
function box([x0, y0, z0, x1, y1, z1]: Box): number[] {
  const p = (x: number, y: number, z: number) => [x, y, z];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
  return [
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0)), // -z
    ...quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)), // +z
    ...quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)), // -x
    ...quad(p(x1, y0, z0), p(x1, y0, z1), p(x1, y1, z1), p(x1, y1, z0)), // +x
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)), // bottom
    ...quad(p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1)), // top
  ];
}
/** Floor quad at y = 0 over [-s, s]². */
const floor = (s = 6) => [-s, 0, -s, s, 0, -s, s, 0, s, -s, 0, -s, s, 0, s, -s, 0, s];
const soup = (...parts: number[][]) => new Float32Array(parts.flat());

// a kitchen: floor + a counter (0.9 m tall, 0.6 m deep) along z ∈ [-2.7, -2.1]
const COUNTER: Box = [-1.5, 0, -2.7, 2, 0.9, -2.1];
const kitchen = soup(floor(), box(COUNTER));

describe('rayHit', () => {
  it('finds the nearest face from outside and from inside (double-sided)', () => {
    expect(rayHit(kitchen, [0, 0.5, 0], [0, 0, -1], 5)).toBeCloseTo(2.1, 5);
    expect(rayHit(kitchen, [0, 0.5, -2.4], [0, 0, 1], 5)).toBeCloseTo(0.3, 5); // inside the counter
    expect(rayHit(kitchen, [0, 1.2, 0], [0, -1, 0], 2)).toBeCloseTo(1.2, 5); // floor
    expect(rayHit(kitchen, [0, 0.5, 0], [0, 0, 1], 5)).toBeNull();
    expect(rayHit(kitchen, [0, 0.5, 0], [0, 0, -1], 1)).toBeNull(); // beyond `far`
  });

  it('pre-filters to nearby triangles without losing hits', () => {
    const near = trianglesNear(kitchen, 0.7, -2.4, 0.5);
    expect(near.length).toBeLessThan(kitchen.length);
    expect(rayHit(near, [0.7, 0.5, -2.4], [0, 0, 1], 1)).toBeCloseTo(0.3, 5);
  });
});

describe('spot probes', () => {
  it('flags a spot inside or right against the counter, not one in the open', () => {
    expect(spotBlocked(kitchen, 0.7, -2.4)).toBe(true); // inside (the lead's MAYA case)
    expect(spotBlocked(kitchen, 0.7, -1.9)).toBe(true); // 0.2 m from the front: arm in the counter
    expect(spotBlocked(kitchen, 0.7, -1.5)).toBe(false);
    expect(spotBlocked(kitchen, 0.7, -3.2)).toBe(false); // behind it, in the open
  });

  it('lets a seated actor sit at a table edge but not inside the counter', () => {
    const table = soup(floor(), box([-0.5, 0.7, -1.3, 0.5, 0.75, -0.7])); // a table top
    expect(spotBlocked(table, 0, -0.5, 'sitting')).toBe(false); // chair pulled up to the table
    expect(spotBlocked(table, 0, -1.0, 'sitting')).toBe(true); // sitting on the table top
    expect(spotBlocked(table, 0, -1.0, 'standing')).toBe(true);
    expect(spotBlocked(kitchen, 0.7, -2.4, 'sitting')).toBe(true);
  });

  it('needs floor under a spot', () => {
    expect(hasFloor(kitchen, 0, 0)).toBe(true);
    expect(hasFloor(kitchen, 9, 9)).toBe(false); // off the edge of the world
    expect(hasFloor(soup(box(COUNTER)), 0, 0)).toBe(false);
  });
});

describe('TriGrid', () => {
  it('returns the triangles near a probe (each once) plus the huge ones', () => {
    const scene = soup(floor(50), box(COUNTER), box([10, 0, 10, 11, 1, 11]));
    const grid = new TriGrid(scene);
    const near = grid.around(0.7, -2.4);
    // the two 100 m floor triangles (always) + the counter's front, back, top and bottom (its
    // end caps at x = -1.5 and x = 2 are in other cells); nothing of the far box
    expect(near.length / 9).toBe(2 + 8);
    expect(rayHit(near, [0.7, 0.5, -2.4], [0, 0, 1], 1)).toBeCloseTo(0.3, 5);
    expect(grid.around(30, 30).length / 9).toBe(2);
  });
});

describe('candidateSpots', () => {
  it('rings outward in 0.25 m steps up to 1.5 m, toward the camera first among equals', () => {
    const c = candidateSpots(0, -2, [0, 0]);
    expect(c[0]).toEqual([0, -1.75]); // straight toward the origin
    const d = c.map(([x, z]) => Math.hypot(x, z + 2));
    expect(Math.max(...d)).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(Math.min(...d)).toBeCloseTo(0.25);
    expect(c.length).toBe(112); // grid points within the 1.5 m disc, minus the centre
    // a spot 0.25 m away from the camera comes before one 0.5 m away toward it
    expect(c.findIndex(([x, z]) => x === 0 && z === -2.25)).toBeLessThan(
      c.findIndex(([x, z]) => x === 0 && z === -1.5),
    );
  });
});

describe('correctPlacement', () => {
  it('leaves a clear actor alone', () => {
    expect(correctPlacement(kitchen, 0.7, -1.2)).toEqual({ status: 'clear', x: 0.7, z: -1.2 });
  });

  it('moves an actor out of the counter to the nearest free floor toward the camera', () => {
    const r = correctPlacement(kitchen, 0.7, -2.4, { toward: [0, 0] });
    expect(r.status).toBe('moved');
    expect(r.z).toBeGreaterThan(-2.1 + 0.35 - 1e-6); // in front of the counter, arm's length off
    expect(r.z).toBeLessThan(-1.2); // ...but not further than needed
    expect(spotBlocked(kitchen, r.x, r.z)).toBe(false);
    expect(Math.hypot(r.x - 0.7, r.z + 2.4)).toBeLessThanOrEqual(1.5);
  });

  it('brings an actor standing outside the captured room (no floor, behind a wall) back in', () => {
    // a room whose back wall is at z = -2.6; blocking put the actor at z = -3.2, beyond it
    const room = soup(floor(2.6), box([-2.6, 0, -2.7, 2.6, 2.5, -2.6]));
    expect(spotBlocked(room, 0.8, -3.2)).toBe(false); // nothing within reach out there...
    expect(hasFloor(room, 0.8, -3.2)).toBe(false); // ...but nothing to stand on either
    const r = correctPlacement(room, 0.8, -3.2, { toward: [0, 0] });
    expect(r.status).toBe('moved');
    expect(r.z).toBeGreaterThan(-2.6 + 0.35 - 1e-6); // inside, clear of the wall
    expect(hasFloor(room, r.x, r.z)).toBe(true);
  });

  it('keeps its distance from other actors and reports when nothing is free', () => {
    const free = correctPlacement(kitchen, 0.7, -2.4, { toward: [0, 0] });
    const r = correctPlacement(kitchen, 0.7, -2.4, { toward: [0, 0], avoid: [[free.x, free.z]] });
    expect(r.status).toBe('moved');
    expect(Math.hypot(r.x - free.x, r.z - free.z)).toBeGreaterThanOrEqual(0.5);
    // standing inside a closed room is fine; on a 9 m wide solid platform nothing within 3 m is
    // free (the 1.5 m search, then the 3 m fallback)
    const room = soup(box([-3, 0, -5, 3, 2.6, 1]));
    expect(correctPlacement(room, 0, -2).status).toBe('clear');
    const platform = soup(floor(), box([-4.5, 0, -6.5, 4.5, 1, 2.5]));
    expect(correctPlacement(platform, 0, -2)).toEqual({ status: 'stuck', x: 0, z: -2 });
    // a 5 m platform: the 3 m fallback finds the floor past its edge
    const small = soup(floor(), box([-2.5, 0, -4.5, 2.5, 1, 0.5]));
    const r2 = correctPlacement(small, 0, -2, { toward: [0, 0] });
    expect(r2.status).toBe('moved');
    expect(Math.hypot(r2.x, r2.z + 2)).toBeGreaterThan(1.5);
  });
});

describe('yawToward', () => {
  it('turns a -Z-facing model toward its partner', () => {
    const check = (from: [number, number], to: [number, number]) => {
      const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yawToward(from, to));
      const want = new THREE.Vector3(to[0] - from[0], 0, to[1] - from[1]).normalize();
      expect(fwd.distanceTo(want)).toBeLessThan(1e-9);
    };
    check([0, 0], [0, -1]);
    check([0, 0], [1, 0]);
    check([0.7, -1.4], [-0.6, -0.9]);
    expect(Math.abs(yawToward([0, -3], [0, 0]))).toBeCloseTo(Math.PI); // faces the source camera
  });
});

describe('colliderTriangles', () => {
  it('flattens meshes into world space, including the parent (Marble flip + scale) transform', () => {
    const world = new THREE.Group();
    world.rotation.x = Math.PI; // OpenCV → Y up
    world.scale.setScalar(2);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0));
    world.add(mesh);
    const tris = colliderTriangles(world);
    expect(tris.length).toBe(12 * 9);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < tris.length; i += 3) {
      minY = Math.min(minY, tris[i]!);
      maxY = Math.max(maxY, tris[i]!);
    }
    // the box spanned y ∈ [-1, 0] locally: flipped and doubled it spans [0, 2]
    expect(minY).toBeCloseTo(0, 5);
    expect(maxY).toBeCloseTo(2, 5);
  });
});
