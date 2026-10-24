// Pure geometry for direct manipulation in the director's viewport (plain tuples, no scene graph):
// pointer rays against the floor, a vertical drag plane, an actor's body cylinder, a prop's box and
// a light's sphere; ring angles for the rotate handle; camera-relative arrow-key nudges; the point
// on a camera's view axis nearest the pointer (focus handle); sliding up to the last free spot when
// a move would end inside a wall. Unit tested in math.test.ts.

export type V3 = [number, number, number];
export type V2 = [number, number];

/** A pointer ray in world space; `d` is a unit vector. */
export interface Ray {
  o: V3;
  d: V3;
}

export const at = (r: Ray, t: number): V3 => [r.o[0] + r.d[0] * t, r.o[1] + r.d[1] * t, r.o[2] + r.d[2] * t];

/** Where the ray meets the horizontal plane y = `y` in front of the camera (null: parallel / behind / too far). */
export function rayPlaneY(r: Ray, y: number, maxDist = 500): V3 | null {
  if (Math.abs(r.d[1]) < 1e-6) return null;
  const t = (y - r.o[1]) / r.d[1];
  if (!(t > 0) || t > maxDist) return null;
  return at(r, t);
}

/**
 * Where the ray meets the vertical plane through `through` whose horizontal normal is `n` (xz):
 * the raise / lower plane, facing the camera.
 */
export function rayVerticalPlane(r: Ray, through: V3, n: V2, maxDist = 500): V3 | null {
  const denom = n[0] * r.d[0] + n[1] * r.d[2];
  if (Math.abs(denom) < 1e-6) return null;
  const t = (n[0] * (through[0] - r.o[0]) + n[1] * (through[2] - r.o[2])) / denom;
  if (!(t > 0) || t > maxDist) return null;
  return at(r, t);
}

/** Nearest positive hit with a vertical cylinder (an actor's body), caps included. */
export function rayCylinder(r: Ray, cx: number, cz: number, radius: number, y0: number, y1: number): number | null {
  let best: number | null = null;
  const keep = (t: number) => {
    if (t > 0 && (best === null || t < best)) best = t;
  };
  const ox = r.o[0] - cx;
  const oz = r.o[2] - cz;
  const a = r.d[0] * r.d[0] + r.d[2] * r.d[2];
  if (a > 1e-12) {
    const b = 2 * (ox * r.d[0] + oz * r.d[2]);
    const c = ox * ox + oz * oz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      for (const t of [(-b - s) / (2 * a), (-b + s) / (2 * a)]) {
        const y = r.o[1] + r.d[1] * t;
        if (y >= y0 && y <= y1) keep(t);
      }
    }
  }
  if (Math.abs(r.d[1]) > 1e-9) {
    for (const cy of [y0, y1]) {
      const t = (cy - r.o[1]) / r.d[1];
      const x = ox + r.d[0] * t;
      const z = oz + r.d[2] * t;
      if (x * x + z * z <= radius * radius) keep(t);
    }
  }
  return best;
}

/** Slab test against an axis-aligned box; 0 when the ray starts inside it. */
export function rayBox(r: Ray, min: V3, max: V3): number | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const d = r.d[i]!;
    const o = r.o[i]!;
    if (Math.abs(d) < 1e-12) {
      if (o < min[i]! || o > max[i]!) return null;
      continue;
    }
    let a = (min[i]! - o) / d;
    let b = (max[i]! - o) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  if (t1 < 0) return null;
  return Math.max(0, t0);
}

export function raySphere(r: Ray, c: V3, radius: number): number | null {
  const ox = r.o[0] - c[0];
  const oy = r.o[1] - c[1];
  const oz = r.o[2] - c[2];
  const b = ox * r.d[0] + oy * r.d[1] + oz * r.d[2];
  const cc = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t = -b - s > 0 ? -b - s : -b + s;
  return t > 0 ? t : null;
}

/** Distance (px) from point p to the segment ab, all in screen pixels. */
export function segmentDistance2D(p: V2, a: V2, b: V2): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const k = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + vx * k), p[1] - (a[1] + vy * k));
}

/** Distance (px) from p to an open or closed polyline. */
export function polylineDistance2D(p: V2, pts: readonly V2[], closed = true): number {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) best = Math.min(best, segmentDistance2D(p, pts[i]!, pts[(i + 1) % n]!));
  return best;
}

// ---- angles ------------------------------------------------------------------------------------

/** `rotation.y` that turns a model whose front is −Z to face the floor direction (dx, dz). */
export const yawFromDir = (dx: number, dz: number) => Math.atan2(-dx, -dz);

export function wrapPi(a: number): number {
  const t = (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return t - Math.PI;
}

export const snapAngle = (a: number, step: number) => Math.round(a / step) * step;

/** Yaw change for a drag on the rotate ring around `c` from floor point `from` to `to`. */
export function ringDelta(c: V3, from: V3, to: V3): number {
  return wrapPi(yawFromDir(to[0] - c[0], to[2] - c[2]) - yawFromDir(from[0] - c[0], from[2] - c[2]));
}

/** Quaternion [x, y, z, w] turned by `dyaw` about world +Y (premultiplied: the heading changes, pitch and roll stay). */
export function rotateYaw(q: readonly [number, number, number, number], dyaw: number): [number, number, number, number] {
  const s = Math.sin(dyaw / 2);
  const c = Math.cos(dyaw / 2);
  const [x, y, z, w] = q;
  const out: [number, number, number, number] = [c * x + s * z, c * y + s * w, c * z - s * x, c * w - s * y];
  const len = Math.hypot(...out) || 1;
  return out.map((v) => v / len) as [number, number, number, number];
}

/** Heading of a camera quaternion: the yaw of its view direction (−Z) on the floor. */
export function quatYaw(q: readonly [number, number, number, number]): number {
  const [x, y, z, w] = q;
  // −Z rotated by q
  const fx = -(2 * (x * z + w * y));
  const fz = -(1 - 2 * (x * x + y * y));
  return yawFromDir(fx, fz);
}

// ---- nudges ------------------------------------------------------------------------------------

export const NUDGE_M = 0.05;
export const NUDGE_FAST_M = 0.5;

/**
 * Floor offset for an arrow key: ArrowUp = away from the camera, ArrowRight = to its right, along
 * whichever world axis the camera faces most (so a nudge is exactly 5 cm on x or z).
 */
export function nudgeDelta(key: string, forward: V2, fast: boolean): V2 | null {
  const step = fast ? NUDGE_FAST_M : NUDGE_M;
  const [fx, fz] = Math.abs(forward[0]) >= Math.abs(forward[1]) ? [Math.sign(forward[0]) || 1, 0] : [0, Math.sign(forward[1]) || 1];
  // right = forward × up
  const rx = -fz;
  const rz = fx;
  const v = (x: number, z: number): V2 => [x * step + 0, z * step + 0]; // + 0: no −0
  switch (key) {
    case 'ArrowUp':
      return v(fx, fz);
    case 'ArrowDown':
      return v(-fx, -fz);
    case 'ArrowRight':
      return v(rx, rz);
    case 'ArrowLeft':
      return v(-rx, -rz);
    default:
      return null;
  }
}

// ---- focus axis --------------------------------------------------------------------------------

/** Parameter along the axis line (o + s·d, d unit) of its closest approach to the pointer ray. */
export function closestOnAxis(r: Ray, o: V3, d: V3): number | null {
  const w0: V3 = [o[0] - r.o[0], o[1] - r.o[1], o[2] - r.o[2]];
  const b = d[0] * r.d[0] + d[1] * r.d[1] + d[2] * r.d[2];
  const dd = d[0] * w0[0] + d[1] * w0[1] + d[2] * w0[2];
  const e = r.d[0] * w0[0] + r.d[1] * w0[1] + r.d[2] * w0[2];
  const denom = 1 - b * b;
  if (denom < 1e-9) return null; // the pointer looks straight down the axis
  return (b * e - dd) / denom;
}

// ---- floor constraint --------------------------------------------------------------------------

/**
 * Moves from `from` toward `to` on the floor but never into a blocked spot: `to` when it is free,
 * else the last free sample along the way (a drag slides up to the wall and stops there). A body
 * that already stands somewhere blocked may move anywhere (so it can be pulled out).
 */
export function constrainMove(from: V2, to: V2, free: (x: number, z: number) => boolean, step = 0.05): V2 {
  if (free(to[0], to[1]) || !free(from[0], from[1])) return to;
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const n = Math.max(1, Math.ceil(dist / step));
  let last: V2 = from;
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    const p: V2 = [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
    if (!free(p[0], p[1])) break;
    last = p;
  }
  return last;
}

export const round3 = (v: number) => Math.round(v * 1000) / 1000;
export const roundV3 = (v: readonly number[]): V3 => [round3(v[0]!), round3(v[1]!), round3(v[2]!)];
