import { describe, expect, it } from 'vitest';
import {
  closestOnAxis,
  constrainMove,
  nudgeDelta,
  polylineDistance2D,
  quatYaw,
  rayBox,
  rayCylinder,
  rayPlaneY,
  raySphere,
  rayVerticalPlane,
  ringDelta,
  rotateYaw,
  segmentDistance2D,
  wrapPi,
  yawFromDir,
  type Ray,
} from './math';

const norm = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l) as [number, number, number];
};
// a camera 1.6 m up looking down the -Z axis and 30° down
const down30: Ray = { o: [0, 1.6, 0], d: norm([0, -Math.tan(Math.PI / 6), -1]) };

describe('pointer rays', () => {
  it('meet the floor in front of the camera, never behind it', () => {
    const p = rayPlaneY(down30, 0)!;
    expect(p[1]).toBe(0);
    expect(p[2]).toBeCloseTo(-1.6 / Math.tan(Math.PI / 6), 6);
    expect(rayPlaneY({ o: [0, 1.6, 0], d: [0, 1, 0] }, 0)).toBeNull();
    expect(rayPlaneY({ o: [0, 1.6, 0], d: [0, 0, -1] }, 0)).toBeNull();
  });

  it('meet a vertical plane facing the camera (raise / lower)', () => {
    const p = rayVerticalPlane({ o: [0, 1.6, 0], d: norm([0, 0.2, -1]) }, [0.4, 0, -3], [0, 1])!;
    expect(p[2]).toBeCloseTo(-3, 6);
    expect(p[1]).toBeCloseTo(1.6 + 0.6, 6);
  });

  it('hit an actor cylinder on its side or caps, and miss beside it', () => {
    const t = rayCylinder({ o: [0, 1, 5], d: [0, 0, -1] }, 0, 0, 0.35, 0, 1.8)!;
    expect(t).toBeCloseTo(5 - 0.35, 6);
    expect(rayCylinder({ o: [1, 1, 5], d: [0, 0, -1] }, 0, 0, 0.35, 0, 1.8)).toBeNull();
    // from above, straight down onto the head
    expect(rayCylinder({ o: [0.1, 5, 0], d: [0, -1, 0] }, 0, 0, 0.35, 0, 1.8)).toBeCloseTo(5 - 1.8, 6);
    // over the head
    expect(rayCylinder({ o: [0, 2.5, 5], d: [0, 0, -1] }, 0, 0, 0.35, 0, 1.8)).toBeNull();
  });

  it('hit boxes and spheres', () => {
    expect(rayBox({ o: [0, 0.5, 5], d: [0, 0, -1] }, [-1, 0, -1], [1, 1, 1])).toBeCloseTo(4, 6);
    expect(rayBox({ o: [0, 0.5, 0], d: [0, 0, -1] }, [-1, 0, -1], [1, 1, 1])).toBe(0);
    expect(rayBox({ o: [0, 2, 5], d: [0, 0, -1] }, [-1, 0, -1], [1, 1, 1])).toBeNull();
    expect(raySphere({ o: [0, 0, 5], d: [0, 0, -1] }, [0, 0, 0], 1)).toBeCloseTo(4, 6);
    expect(raySphere({ o: [0, 2, 5], d: [0, 0, -1] }, [0, 0, 0], 1)).toBeNull();
  });

  it('measure screen distances to segments and rings', () => {
    expect(segmentDistance2D([5, 5], [0, 0], [10, 0])).toBe(5);
    expect(segmentDistance2D([-3, 4], [0, 0], [10, 0])).toBe(5);
    expect(polylineDistance2D([5, 1], [[0, 0], [10, 0], [10, 10]], false)).toBe(1);
  });
});

describe('angles', () => {
  it('yaw 0 faces -Z, π/2 faces -X (three.js rotation.y of a -Z-facing model)', () => {
    expect(yawFromDir(0, -1)).toBeCloseTo(0);
    expect(yawFromDir(-1, 0)).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(yawFromDir(0, 1))).toBeCloseTo(Math.PI);
  });

  it('wraps to (-π, π] and measures ring drags in the same sense as rotation.y', () => {
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(-Math.PI);
    expect(wrapPi(-0.5)).toBeCloseTo(-0.5);
    // from straight ahead (-Z) to the left (-X) of the centre: +90°
    expect(ringDelta([0, 0, 0], [0, 0, -1], [-1, 0, 0])).toBeCloseTo(Math.PI / 2);
    expect(ringDelta([2, 0, 2], [2, 0, 1], [3, 0, 2])).toBeCloseTo(-Math.PI / 2);
  });

  it('turns a camera quaternion about world Y and reads its heading back', () => {
    const q = rotateYaw([0, 0, 0, 1], 0.7);
    expect(quatYaw(q)).toBeCloseTo(0.7);
    // a camera pitched down 20° keeps its pitch when turned
    const pitched: [number, number, number, number] = [-Math.sin(0.1745), 0, 0, Math.cos(0.1745)];
    const turned = rotateYaw(pitched, -1.2);
    expect(quatYaw(turned)).toBeCloseTo(-1.2, 5);
    const fy = 2 * (turned[1] * turned[2] - turned[3] * turned[0]);
    const fy0 = 2 * (pitched[1] * pitched[2] - pitched[3] * pitched[0]);
    expect(fy).toBeCloseTo(fy0, 6);
  });
});

describe('arrow-key nudges', () => {
  it('step 5 cm (Shift 50 cm) along the world axis the camera faces most', () => {
    expect(nudgeDelta('ArrowUp', [0.1, -0.9], false)).toEqual([0, -0.05]);
    expect(nudgeDelta('ArrowRight', [0.1, -0.9], false)).toEqual([0.05, 0]);
    expect(nudgeDelta('ArrowLeft', [0, -1], true)).toEqual([-0.5, 0]);
    expect(nudgeDelta('ArrowDown', [0.9, 0.2], false)).toEqual([-0.05, 0]);
    expect(nudgeDelta('KeyA', [0, -1], false)).toBeNull();
  });
});

describe('focus axis', () => {
  it('finds the point on the camera axis nearest the pointer ray', () => {
    // axis: from the origin along -Z; pointer ray from the side, crossing z = -4
    const s = closestOnAxis({ o: [3, 0, -4], d: [-1, 0, 0] }, [0, 0, 0], [0, 0, -1])!;
    expect(s).toBeCloseTo(4, 6);
    expect(closestOnAxis({ o: [0, 0, 5], d: [0, 0, -1] }, [0, 0, 0], [0, 0, -1])).toBeNull();
  });
});

describe('floor constraint', () => {
  // a wall at x >= 1
  const free = (x: number) => x < 1;
  it('lets a free move through, slides up to a wall otherwise', () => {
    expect(constrainMove([0, 0], [0.5, 0.2], free)).toEqual([0.5, 0.2]);
    const p = constrainMove([0, 0], [2, 0], free);
    expect(p[0]).toBeLessThan(1);
    expect(p[0]).toBeGreaterThan(0.94);
  });
  it('never traps a body that already stands in a blocked spot', () => {
    expect(constrainMove([1.5, 0], [3, 0], free)).toEqual([3, 0]);
  });
});
