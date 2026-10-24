import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Vec3 } from '@shared/schema';
import { hasFloor } from './placement';
import {
  applyWorldTransform,
  calibrationFactor,
  floorOffset,
  rawFloorY,
  worldTransform,
} from './transform';

const close = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

/** World Labs reference: metric = raw * msf; metric.y -= gpo (OpenCV); then Marble's 180° X flip. */
function worldLabsReference(p: Vec3, msf: number, gpo: number): Vec3 {
  const m: Vec3 = [p[0] * msf, p[1] * msf - gpo, p[2] * msf];
  return [m[0], -m[1], -m[2]];
}

describe('worldTransform', () => {
  it('matches the Orbis floor for the Diagon Alley world (-gpo/msf in the flipped frame)', () => {
    expect(rawFloorY({ metricScaleFactor: 1.7405, groundPlaneOffset: 2.1357 })).toBeCloseTo(
      -1.227,
      3,
    );
  });

  it('puts an OpenCV floor point at y = 0 and keeps the source camera at x = z = 0', () => {
    const w = { metricScaleFactor: 0.8, groundPlaneOffset: 1.4, opencvFrame: true };
    const t = worldTransform(w);
    expect(t.rotationX).toBe(Math.PI);
    expect(t.scale).toBe(0.8);
    expect(t.positionY).toBeCloseTo(1.4);
    // OpenCV is Y down, so the floor is at +gpo/msf below the camera in raw units.
    close(applyWorldTransform(t, [2, 1.4 / 0.8, -3]), [1.6, 0, 2.4]);
    // the source camera sits gpo metres above the floor
    close(applyWorldTransform(t, [0, 0, 0]), [0, 1.4, 0]);
  });

  it('agrees with the World Labs metric recipe for arbitrary points', () => {
    for (const [msf, gpo] of [
      [0.42, 0.9],
      [1, 0],
      [2.5, 3.1],
      [1.7405, 2.1357],
    ] as const) {
      const t = worldTransform({ metricScaleFactor: msf, groundPlaneOffset: gpo });
      for (const p of [
        [0, 0, 0],
        [1, -2, 3],
        [-4.5, 0.25, 9],
      ] as Vec3[]) {
        close(applyWorldTransform(t, p), worldLabsReference(p, msf, gpo));
      }
    }
  });

  it('handles already Y-up assets without the flip', () => {
    const t = worldTransform({ metricScaleFactor: 2, groundPlaneOffset: 3, opencvFrame: false });
    expect(t.rotationX).toBe(0);
    close(applyWorldTransform(t, [1, -1.5, -2]), [2, 0, -4]);
  });

  it('is exactly what three.js computes for an Object3D with that transform', () => {
    const t = worldTransform({ metricScaleFactor: 0.6, groundPlaneOffset: 1.1 });
    const o = new THREE.Object3D();
    o.rotation.x = t.rotationX;
    o.scale.setScalar(t.scale);
    o.position.y = t.positionY;
    o.updateMatrixWorld(true);
    const p: Vec3 = [0.3, 1.2, -5];
    const v = new THREE.Vector3(...p).applyMatrix4(o.matrixWorld);
    close([v.x, v.y, v.z], applyWorldTransform(t, p));
  });

  it('a room alignment turns about +Y after the flip and shifts on the floor, like three.js YXZ', () => {
    const t = worldTransform({
      metricScaleFactor: 0.7,
      groundPlaneOffset: 1.2,
      roomAlign: { yaw: 0.9, x: 1.5, z: -2 },
    });
    expect([t.rotationY, t.positionX, t.positionZ]).toEqual([0.9, 1.5, -2]);
    const o = new THREE.Object3D();
    o.rotation.order = 'YXZ';
    o.rotation.set(t.rotationX, t.rotationY, 0);
    o.scale.setScalar(t.scale);
    o.position.set(t.positionX, t.positionY, t.positionZ);
    o.updateMatrixWorld(true);
    for (const p of [
      [0.3, 1.2, -5],
      [-2, 0.4, 3],
      [0, 0, 0],
    ] as Vec3[]) {
      const v = new THREE.Vector3(...p).applyMatrix4(o.matrixWorld);
      close([v.x, v.y, v.z], applyWorldTransform(t, p));
    }
    // the source camera (raw origin) lands on the alignment's shift; the floor stays at y = 0
    close(
      applyWorldTransform(t, [0, 1.2 / 0.7, 0]).map((v, i) => (i === 1 ? v : 0)) as Vec3,
      [0, 0, 0],
    );
    expect(worldTransform({ metricScaleFactor: 1, groundPlaneOffset: 0 }).rotationY).toBe(0);
  });

  it('applies a scale calibration on top of the metric scale with the floor still at y = 0', () => {
    const w = { metricScaleFactor: 0.8, groundPlaneOffset: 1.4, opencvFrame: true };
    const t = worldTransform({ ...w, scaleCalibration: { factor: 0.9 } });
    expect(t.scale).toBeCloseTo(0.72);
    // raw floor point stays on the floor; everything else is 0.9× as far from the origin column
    close(applyWorldTransform(t, [2, 1.4 / 0.8, -3]), [1.6 * 0.9, 0, 2.4 * 0.9]);
    // the source camera is now 0.9 × gpo above the floor
    close(applyWorldTransform(t, [0, 0, 0]), [0, 1.4 * 0.9, 0]);
    // a 2 m tall thing at Marble scale becomes 1.8 m
    const base = applyWorldTransform(t, [1, 1.4 / 0.8, -2]);
    const top = applyWorldTransform(t, [1, 1.4 / 0.8 - 2 / 0.8, -2]);
    expect(top[1] - base[1]).toBeCloseTo(1.8, 6);
  });

  it('ignores a missing or invalid calibration', () => {
    expect(calibrationFactor({})).toBe(1);
    expect(calibrationFactor({ scaleCalibration: null })).toBe(1);
    expect(calibrationFactor({ scaleCalibration: { factor: 0 } })).toBe(1);
    expect(calibrationFactor({ scaleCalibration: { factor: Number.NaN } })).toBe(1);
    expect(calibrationFactor({ scaleCalibration: { factor: 1.25 } })).toBe(1.25);
  });

  it('raises the world by floorOffsetMeters so the visible ground lands at y = 0', () => {
    // bus stop: Marble's ground plane 9 cm above the collider floor near the camera
    const w = { metricScaleFactor: 2.2, groundPlaneOffset: 1.49, opencvFrame: true };
    const ground: Vec3 = [1.5, (1.49 + 0.09) / 2.2, -3]; // raw OpenCV point 9 cm below the plane
    expect(applyWorldTransform(worldTransform(w), ground)[1]).toBeCloseTo(-0.09, 6);
    const t = worldTransform({ ...w, floorOffsetMeters: 0.09 });
    expect(t.positionY).toBeCloseTo(1.49 + 0.09);
    expect(t.scale).toBe(2.2); // only a shift: sizes are untouched
    close(applyWorldTransform(t, ground), [3.3, 0, 6.6]);
    // Marble's declared floor now floats 9 cm up, the source camera 9 cm higher
    expect(applyWorldTransform(t, [0, 1.49 / 2.2, 0])[1]).toBeCloseTo(0.09, 6);
    close(applyWorldTransform(t, [0, 0, 0]), [0, 1.49 + 0.09, 0]);
  });

  it('scales the floor shift with the calibration (the world grows about the declared floor)', () => {
    const w = {
      metricScaleFactor: 1,
      groundPlaneOffset: 1.5,
      opencvFrame: false,
      floorOffsetMeters: 0.12,
    };
    const t = worldTransform({ ...w, scaleCalibration: { factor: 0.8 } });
    expect(t.positionY).toBeCloseTo(0.8 * 1.5 + 0.8 * 0.12);
    // the visible ground (raw y = -1.62 in this Y-up asset) still lands at 0
    expect(applyWorldTransform(t, [2, -1.62, 1])[1]).toBeCloseTo(0, 6);
  });

  it('ignores a missing, invalid or implausible floor offset', () => {
    expect(floorOffset({})).toBe(0);
    expect(floorOffset({ floorOffsetMeters: null })).toBe(0);
    expect(floorOffset({ floorOffsetMeters: Number.NaN })).toBe(0);
    expect(floorOffset({ floorOffsetMeters: 3 })).toBe(0);
    expect(floorOffset({ floorOffsetMeters: -0.2 })).toBe(-0.2);
    const w = { metricScaleFactor: 0.8, groundPlaneOffset: 1.4 };
    expect(worldTransform({ ...w, floorOffsetMeters: 3 })).toEqual(worldTransform(w));
  });

  it('keeps the collider in sync: a child of the raised world has its floor at 0 for placement', () => {
    // a collider floor quad 14 cm below Marble's plane (rooftop), raw OpenCV coordinates
    const w = {
      metricScaleFactor: 1.25,
      groundPlaneOffset: 2.17,
      opencvFrame: true,
      floorOffsetMeters: 0.14,
    };
    const yRaw = (2.17 + 0.14) / 1.25;
    const raw = [-6, yRaw, -6, 6, yRaw, -6, 6, yRaw, 6, -6, yRaw, -6, 6, yRaw, 6, -6, yRaw, 6];
    const t = worldTransform(w);
    const root = new THREE.Object3D();
    root.rotation.x = t.rotationX;
    root.scale.setScalar(t.scale);
    root.position.y = t.positionY;
    const mesh = new THREE.Mesh(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(raw, 3)),
    );
    root.add(mesh);
    root.updateMatrixWorld(true);
    const world = new Float32Array(raw.length);
    const v = new THREE.Vector3();
    for (let i = 0; i < raw.length; i += 3) {
      v.set(raw[i]!, raw[i + 1]!, raw[i + 2]!).applyMatrix4(mesh.matrixWorld);
      world.set([v.x, v.y, v.z], i);
    }
    for (let i = 1; i < world.length; i += 3) expect(world[i]).toBeCloseTo(0, 5);
    expect(hasFloor(world, 0, 2)).toBe(true);
  });
});
