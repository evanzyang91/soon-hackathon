import { Euler, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  deviceToWorld,
  orientationToQuaternion,
  OrientationTracker,
  recenterOffset,
  wrapAngle,
  yawOf,
  yawQuaternion,
} from './sensors.ts';

const fwd = (q: Quaternion) => new Vector3(0, 0, -1).applyQuaternion(q);
const up = (q: Quaternion) => new Vector3(0, 1, 0).applyQuaternion(q);
const expectVec = (v: Vector3, x: number, y: number, z: number) => {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
};

describe('orientationToQuaternion (camera looks out of the back of the phone)', () => {
  it('flat on a table, screen up → looks straight down, top edge toward −Z (north)', () => {
    const q = orientationToQuaternion({ alpha: 0, beta: 0, gamma: 0 }, 0);
    expectVec(fwd(q), 0, -1, 0);
    expectVec(up(q), 0, 0, -1);
  });

  it('upright in portrait → looks at the horizon along −Z, image upright', () => {
    const q = orientationToQuaternion({ alpha: 0, beta: 90, gamma: 0 }, 0);
    expectVec(fwd(q), 0, 0, -1);
    expectVec(up(q), 0, 1, 0);
  });

  it('alpha turns the heading counter-clockwise seen from above', () => {
    const q = orientationToQuaternion({ alpha: 90, beta: 90, gamma: 0 }, 0);
    expectVec(fwd(q), -1, 0, 0);
  });

  it('tilting the top back (beta > 90) looks up', () => {
    const q = orientationToQuaternion({ alpha: 0, beta: 120, gamma: 0 }, 0);
    const f = fwd(q);
    expect(f.y).toBeCloseTo(Math.sin(Math.PI / 6), 6);
    expect(f.z).toBeLessThan(0);
  });

  it('landscape (top edge left, screen angle 90) → horizon along −Z, image upright', () => {
    const q = orientationToQuaternion({ alpha: 90, beta: 0, gamma: -90 }, 90);
    expectVec(fwd(q), 0, 0, -1);
    expectVec(up(q), 0, 1, 0);
  });

  it('landscape the other way (top edge right, screen angle 270)', () => {
    const q = orientationToQuaternion({ alpha: -90, beta: 0, gamma: 90 }, 270);
    expectVec(fwd(q), 0, 0, -1);
    expectVec(up(q), 0, 1, 0);
  });

  it('deviceToWorld maps device axes: +z (out of screen) points at the user', () => {
    const d = deviceToWorld({ alpha: 0, beta: 90, gamma: 0 });
    expectVec(new Vector3(0, 0, 1).applyQuaternion(d), 0, 0, 1); // toward the viewer (south)
    expectVec(new Vector3(0, 1, 0).applyQuaternion(d), 0, 1, 0); // top edge up
    expectVec(new Vector3(1, 0, 0).applyQuaternion(d), 1, 0, 0); // right edge east
  });
});

describe('yaw + recenter', () => {
  it('yawOf extracts the heading regardless of pitch and roll', () => {
    const q = new Quaternion().setFromEuler(new Euler(0.3, 0.7, -0.2, 'YXZ'));
    expect(yawOf(q)).toBeCloseTo(0.7, 6);
    expect(yawOf([q.x, q.y, q.z, q.w])).toBeCloseTo(0.7, 6);
  });

  it('wrapAngle keeps angles in (−π, π]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(-Math.PI / 2 - 2 * Math.PI)).toBeCloseTo(-Math.PI / 2, 9);
    expect(wrapAngle(0.25)).toBeCloseTo(0.25, 9);
  });

  it('recenterOffset makes the current heading equal the drop camera yaw, preserving tilt', () => {
    const device = orientationToQuaternion({ alpha: 37, beta: 75, gamma: 8 }, 0);
    const camYaw = yawOf(new Quaternion().setFromEuler(new Euler(-0.1, 2.5, 0, 'YXZ')));
    const off = recenterOffset(device, camYaw);
    const out = yawQuaternion(off).multiply(device);
    expect(yawOf(out)).toBeCloseTo(2.5, 6);
    const before = new Euler().setFromQuaternion(device, 'YXZ');
    const after = new Euler().setFromQuaternion(out, 'YXZ');
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
  });
});

describe('OrientationTracker', () => {
  it('ignores null readings (desktop Chrome fires deviceorientation with nulls)', () => {
    const t = new OrientationTracker();
    expect(t.setSample({ alpha: null as unknown as number, beta: 0, gamma: 0 }, 0)).toBe(false);
    expect(t.hasSample).toBe(false);
  });

  it('a recenter requested before the first sample applies on that sample', () => {
    const t = new OrientationTracker();
    t.recenter(1.2);
    t.setSample({ alpha: 200, beta: 90, gamma: 0 }, 0);
    expect(yawOf(t.quaternion)).toBeCloseTo(1.2, 6);
    // Turning the phone 30° left afterwards turns the camera 30° left of the drop camera.
    t.setSample({ alpha: 230, beta: 90, gamma: 0 }, 0);
    expect(wrapAngle(yawOf(t.quaternion) - 1.2)).toBeCloseTo(Math.PI / 6, 6);
  });

  it('recenter later re-anchors the current heading', () => {
    const t = new OrientationTracker();
    t.setSample({ alpha: 10, beta: 90, gamma: 0 }, 0);
    expect(yawOf(t.quaternion)).toBeCloseTo((10 * Math.PI) / 180, 6);
    t.recenter(-0.5);
    expect(yawOf(t.quaternion)).toBeCloseTo(-0.5, 6);
  });
});

describe('OrientationTracker.deviceFrame', () => {
  it('rotates device vectors into the recentered world frame', () => {
    const t = new OrientationTracker();
    t.setSample({ alpha: 0, beta: 90, gamma: 0 }, 0); // upright portrait facing −Z
    t.recenter(Math.PI / 2); // now facing −X
    // Device +z (out of the screen, toward the user) → world +X after a 90° left recenter.
    expectVec(new Vector3(0, 0, 1).applyQuaternion(t.deviceFrame), 1, 0, 0);
    expectVec(fwd(t.quaternion), -1, 0, 0);
    expect(t.source).toBe('sensor');
  });
});
