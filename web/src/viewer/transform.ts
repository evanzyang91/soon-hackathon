// Marble raw SPZ coordinates → metric, Y-up world with the floor at y = 0.
//
// World Labs (docs.worldlabs.ai/api/rendering-spz): metric = raw * metric_scale_factor, then
// metric.y -= ground_plane_offset puts the ground at y = 0 in the raw OpenCV frame (Y down).
// Marble's own viewer then rotates 180° about X. Seen from the other side: in the flipped (Y-up)
// frame, before scaling, the floor sits at y = -ground_plane_offset / msf.
//
// A three.js Object3D applies p' = T + R(S p). With R = rotX(π), S = msf and T = (0, ty, 0) a raw
// floor point (y_cv = gpo / msf) lands at -gpo + ty, so ty = gpo. Non-OpenCV (already Y-up) assets
// use the same floor convention without the flip and also end up with ty = gpo.
//
// A measured scale calibration (WorldAsset.scaleCalibration, server/pipeline/calibrate.ts)
// multiplies the scale: S = factor × msf. The floor is still raw y = -gpo / msf, so ty becomes
// factor × gpo and the floor stays at y = 0 while everything above it grows or shrinks.
//
// Marble's declared floor is not always where the splats' ground is: outdoors it sits 0.09–0.2 m
// above the visible ground (measured by calibrate.ts on the collider near the source camera and
// stored as WorldAsset.floorOffsetMeters, at Marble's scale). The world is raised by that much
// (× the calibration factor, since the world scales about the declared floor), so the visible
// ground lands at y = 0 where the actors stand; the collider rides along as a child of the world.
//
// A scanned-room world (WorldAsset.roomAlign) is then turned about +Y and shifted on the floor so
// it sits over the real room: p'' = Ry(yaw) p' + (x, 0, z). three.js: rotation order 'YXZ'.
import type { Vec3, WorldAsset } from '@shared/schema';

export interface WorldTransform {
  rotationX: number;
  scale: number;
  positionY: number;
  /** Room alignment (0 unless WorldAsset.roomAlign): yaw about +Y, then a floor shift. */
  rotationY: number;
  positionX: number;
  positionZ: number;
}

type FrameInfo = Pick<WorldAsset, 'metricScaleFactor' | 'groundPlaneOffset'> & {
  opencvFrame?: boolean;
  roomAlign?: { yaw: number; x: number; z: number } | null;
  scaleCalibration?: { factor: number } | null;
  floorOffsetMeters?: number | null;
};

/** Never apply a floor shift beyond this (a bad measurement must not bury or float the scene). */
export const MAX_FLOOR_OFFSET_M = 1;

/** The measured correction on top of Marble's metric scale (1 when absent or invalid). */
export function calibrationFactor(w: Pick<FrameInfo, 'scaleCalibration'>): number {
  const f = w.scaleCalibration?.factor;
  return typeof f === 'number' && Number.isFinite(f) && f > 0 ? f : 1;
}

/**
 * How far the visible ground sits below Marble's declared floor, in metres at Marble's scale
 * (0 when absent, invalid or beyond ±MAX_FLOOR_OFFSET_M).
 */
export function floorOffset(w: Pick<FrameInfo, 'floorOffsetMeters'>): number {
  const f = w.floorOffsetMeters;
  return typeof f === 'number' && Number.isFinite(f) && Math.abs(f) <= MAX_FLOOR_OFFSET_M ? f : 0;
}

/** Floor height in the Y-up frame (after the flip, if any), in raw asset units. */
export function rawFloorY(w: FrameInfo): number {
  return -w.groundPlaneOffset / w.metricScaleFactor;
}

export function worldTransform(w: FrameInfo): WorldTransform {
  const factor = calibrationFactor(w);
  const scale = w.metricScaleFactor * factor;
  const a = w.roomAlign;
  const ok = !!a && [a.yaw, a.x, a.z].every(Number.isFinite);
  return {
    rotationX: (w.opencvFrame ?? true) ? Math.PI : 0,
    scale,
    positionY: -rawFloorY(w) * scale + factor * floorOffset(w),
    rotationY: ok ? a!.yaw : 0,
    positionX: ok ? a!.x : 0,
    positionZ: ok ? a!.z : 0,
  };
}

/** Raw asset point → world metres. Mirrors what three.js does with the transform above. */
export function applyWorldTransform(t: WorldTransform, p: Vec3): Vec3 {
  const [x, y, z] = p;
  const c = Math.cos(t.rotationX);
  const s = Math.sin(t.rotationX);
  const ry = y * c - z * s;
  const rz = y * s + z * c;
  // then Ry(yaw) on the scaled, flipped point (three.js Euler 'YXZ': Ry · Rx)
  const px = x * t.scale;
  const pz = rz * t.scale;
  const cy = Math.cos(t.rotationY ?? 0);
  const sy = Math.sin(t.rotationY ?? 0);
  return [
    px * cy + pz * sy + (t.positionX ?? 0),
    ry * t.scale + t.positionY,
    -px * sy + pz * cy + (t.positionZ ?? 0),
  ];
}
