import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Vec3 } from '@shared/schema';
import { applyWorldTransform, rawFloorY, worldTransform } from './transform';

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
});
