// Marble raw SPZ coordinates → metric, Y-up world with the floor at y = 0.
//
// World Labs (docs.worldlabs.ai/api/rendering-spz): metric = raw * metric_scale_factor, then
// metric.y -= ground_plane_offset puts the ground at y = 0 in the raw OpenCV frame (Y down).
// Marble's own viewer then rotates 180° about X. Orbis states the same thing from the other side:
// in the flipped (Y-up) frame, before scaling, the floor sits at y = -ground_plane_offset / msf.
//
// A three.js Object3D applies p' = T + R(S p). With R = rotX(π), S = msf and T = (0, ty, 0) a raw
// floor point (y_cv = gpo / msf) lands at -gpo + ty, so ty = gpo. Non-OpenCV (already Y-up) assets
// use the same floor convention without the flip and also end up with ty = gpo.
import type { Vec3, WorldAsset } from '@shared/schema';

export interface WorldTransform {
  rotationX: number;
  scale: number;
  positionY: number;
}

type FrameInfo = Pick<WorldAsset, 'metricScaleFactor' | 'groundPlaneOffset'> & {
  opencvFrame?: boolean;
};

/** Floor height in the Y-up frame (after the flip, if any), in raw asset units. */
export function rawFloorY(w: FrameInfo): number {
  return -w.groundPlaneOffset / w.metricScaleFactor;
}

export function worldTransform(w: FrameInfo): WorldTransform {
  const scale = w.metricScaleFactor;
  return {
    rotationX: (w.opencvFrame ?? true) ? Math.PI : 0,
    scale,
    positionY: -rawFloorY(w) * scale,
  };
}

/** Raw asset point → world metres. Mirrors what three.js does with the transform above. */
export function applyWorldTransform(t: WorldTransform, p: Vec3): Vec3 {
  const [x, y, z] = p;
  const c = Math.cos(t.rotationX);
  const s = Math.sin(t.rotationX);
  const ry = y * c - z * s;
  const rz = y * s + z * c;
  return [x * t.scale, ry * t.scale + t.positionY, rz * t.scale];
}
