// Small math helpers shared by the screenplay planners. World frame (docs/PLAN.md): meters,
// Y up, floor at y = 0, origin at the Marble source camera which looks down -Z.
import type { Quat, Vec3 } from '../../shared/schema.ts';

/**
 * Yaw (radians, about +Y) that turns the -Z forward vector to face along (dx, dz).
 * Matches `Blocking.yaw` (0 = facing -Z) and three.js `rotation.y`: forward(yaw) =
 * (-sin yaw, 0, -cos yaw), so facing +X is -π/2 and facing the source camera from -Z is π.
 */
export function yawToward(dx: number, dz: number): number {
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return 0;
  return Math.atan2(-dx, -dz);
}

/** Yaw for an actor standing at `from` to face the point `to` (y ignored). */
export function yawFacing(from: Vec3, to: Vec3): number {
  return yawToward(to[0] - from[0], to[2] - from[2]);
}

/**
 * Camera quaternion [x, y, z, w] for a three.js camera (looks down its local -Z) placed at
 * `from` and aimed at `to`, with no roll. Equivalent to Euler(pitch, yaw, 0, 'YXZ').
 */
export function lookAtQuat(from: Vec3, to: Vec3): Quat {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const yaw = yawToward(dx, dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cx = Math.cos(pitch / 2);
  const sx = Math.sin(pitch / 2);
  // q = q_yaw(Y) * q_pitch(X)
  return [cy * sx, sy * cx, -sy * sx, cy * cx].map(round6) as Quat;
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function round3(n: number): number {
  return Math.round(n * 1e3) / 1e3;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** "EXT. CITY STREET - NIGHT" → "ext-city-street-night". */
export function slugify(s: string, max = 48): string {
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'x';
}

/** Makes `base` unique against `taken` by appending -2, -3, …; records the result. */
export function uniqueSlug(base: string, taken: Set<string>): string {
  let s = base;
  for (let i = 2; taken.has(s); i++) s = `${base}-${i}`;
  taken.add(s);
  return s;
}
