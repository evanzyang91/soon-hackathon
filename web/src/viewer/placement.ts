// Actor placement correction against the world's collider mesh. LLM blocking is written blind, so
// in a tight interior an actor can land inside a counter, or behind a wall where the captured
// world has no floor. Once the collider is loaded (same frame as the splats), each actor's spot is
// probed with short rays; a blocked or floorless actor moves to the nearest free spot that has a
// floor under it, preferring spots toward the source camera.
//
// The ray math works on a flat world-space triangle soup (9 floats per triangle) and is pure:
// no scene graph, deterministic, unit tested. `colliderTriangles` is the only three.js glue.
import * as THREE from 'three';

export type V2 = [number, number];
type V3 = [number, number, number];
export type Pose = 'standing' | 'sitting' | 'walking';

/** Flattens every mesh under `root` into world-space triangles (updates world matrices). */
export function colliderTriangles(root: THREE.Object3D): Float32Array {
  root.updateWorldMatrix(true, true);
  const chunks: Float32Array[] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const index = o.geometry.getIndex();
    const count = index ? index.count : pos.count;
    const out = new Float32Array(Math.floor(count / 3) * 9);
    for (let i = 0; i < out.length / 3; i++) {
      v.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(o.matrixWorld);
      out[i * 3] = v.x;
      out[i * 3 + 1] = v.y;
      out[i * 3 + 2] = v.z;
    }
    chunks.push(out);
  });
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return all;
}

/** Triangles whose xz bounding box comes within `r` of (cx, cz): a small set to ray-test. */
export function trianglesNear(tris: Float32Array, cx: number, cz: number, r: number) {
  const keep: number[] = [];
  for (let t = 0; t < tris.length; t += 9) {
    const x0 = Math.min(tris[t]!, tris[t + 3]!, tris[t + 6]!);
    const x1 = Math.max(tris[t]!, tris[t + 3]!, tris[t + 6]!);
    const z0 = Math.min(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!);
    const z1 = Math.max(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!);
    if (x1 >= cx - r && x0 <= cx + r && z1 >= cz - r && z0 <= cz + r) keep.push(t);
  }
  const out = new Float32Array(keep.length * 9);
  keep.forEach((t, i) => out.set(tris.subarray(t, t + 9), i * 9));
  return out;
}

/** Distance along unit `d` from `o` to the nearest triangle (either side), or null within `far`. */
export function rayHit(tris: Float32Array, o: V3, d: V3, far: number): number | null {
  let best: number | null = null;
  for (let t = 0; t < tris.length; t += 9) {
    // Möller–Trumbore, double-sided
    const e1x = tris[t + 3]! - tris[t]!;
    const e1y = tris[t + 4]! - tris[t + 1]!;
    const e1z = tris[t + 5]! - tris[t + 2]!;
    const e2x = tris[t + 6]! - tris[t]!;
    const e2y = tris[t + 7]! - tris[t + 1]!;
    const e2z = tris[t + 8]! - tris[t + 2]!;
    const px = d[1] * e2z - d[2] * e2y;
    const py = d[2] * e2x - d[0] * e2z;
    const pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const sx = o[0] - tris[t]!;
    const sy = o[1] - tris[t + 1]!;
    const sz = o[2] - tris[t + 2]!;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const w = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (w < 0 || u + w > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (dist >= 0 && dist <= far && (best === null || dist < best)) best = dist;
  }
  return best;
}

const DIRS: V2[] = Array.from({ length: 8 }, (_, i) => [
  Math.cos((i * Math.PI) / 4),
  Math.sin((i * Math.PI) / 4),
]);

/** Body probe per pose: ray heights (m), horizontal reach, and the clear band above the floor. */
const BODY: Record<Pose, { heights: number[]; radius: number; clearFrom: number; top: number }> = {
  standing: { heights: [0.5, 0.9, 1.4], radius: 0.35, clearFrom: 0.25, top: 1.8 },
  walking: { heights: [0.5, 0.9, 1.4], radius: 0.35, clearFrom: 0.25, top: 1.8 },
  // seated: a chair seat (≤ 0.6 m) and a table edge at the knees are expected around the body
  sitting: { heights: [1.0, 1.2], radius: 0.2, clearFrom: 0.6, top: 1.35 },
};

/**
 * True when a body at (x, z) would intersect the collider: any of 8 horizontal rays at the
 * pose's probe heights hits within its radius, or a surface sits inside the body's vertical
 * band right above the spot (standing inside a counter or a table top).
 */
export function spotBlocked(tris: Float32Array, x: number, z: number, pose: Pose = 'standing') {
  const b = BODY[pose];
  for (const y of b.heights)
    for (const [dx, dz] of DIRS) if (rayHit(tris, [x, y, z], [dx, 0, dz], b.radius) !== null) return true;
  const down = rayHit(tris, [x, b.top, z], [0, -1, 0], b.top - b.clearFrom);
  return down !== null;
}

/**
 * Floor support: a downward ray from 1.2 m hits something within 1.8 m (down to y = -0.6; Marble
 * colliders are coarse and can sit a few decimetres below the splat floor, e.g. on a rooftop).
 */
export function hasFloor(tris: Float32Array, x: number, z: number): boolean {
  return rayHit(tris, [x, 1.2, z], [0, -1, 0], 1.8) !== null;
}

/**
 * Uniform xz grid over a triangle soup, so each probe only ray-tests the few triangles around it
 * (a real collider has ~100k–300k). Triangles wider than `maxCells` cells (ground planes, sky
 * shells) go to a short list that every query includes.
 */
export class TriGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly big: number[] = [];

  constructor(
    readonly tris: Float32Array,
    readonly cell = 0.5,
    maxCells = 64,
  ) {
    for (let t = 0; t < tris.length; t += 9) {
      const [i0, i1, k0, k1] = this.span(
        Math.min(tris[t]!, tris[t + 3]!, tris[t + 6]!),
        Math.min(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!),
        Math.max(tris[t]!, tris[t + 3]!, tris[t + 6]!),
        Math.max(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!),
      );
      if ((i1 - i0 + 1) * (k1 - k0 + 1) > maxCells) {
        this.big.push(t);
        continue;
      }
      for (let i = i0; i <= i1; i++)
        for (let k = k0; k <= k1; k++) {
          const key = TriGrid.key(i, k);
          const list = this.cells.get(key);
          if (list) list.push(t);
          else this.cells.set(key, [t]);
        }
    }
  }

  private static key(i: number, k: number) {
    return (i + 32768) * 65536 + (k + 32768);
  }

  private span(x0: number, z0: number, x1: number, z1: number): [number, number, number, number] {
    const c = (v: number) => Math.max(-32767, Math.min(32767, Math.floor(v / this.cell)));
    return [c(x0), c(x1), c(z0), c(z1)];
  }

  /** Triangles that may touch the xz box (each once). */
  query(x0: number, z0: number, x1: number, z1: number): Float32Array {
    const [i0, i1, k0, k1] = this.span(x0, z0, x1, z1);
    const seen = new Set<number>(this.big);
    for (let i = i0; i <= i1; i++)
      for (let k = k0; k <= k1; k++) for (const t of this.cells.get(TriGrid.key(i, k)) ?? []) seen.add(t);
    const out = new Float32Array(seen.size * 9);
    let n = 0;
    for (const t of seen) out.set(this.tris.subarray(t, t + 9), 9 * n++);
    return out;
  }

  /** Everything a body probe at (x, z) can reach. */
  around(x: number, z: number, r = 0.45): Float32Array {
    return this.query(x - r, z - r, x + r, z + r);
  }
}

/**
 * Grid spots around (x, z) out to `maxR` in `step` increments, nearest first; among similar
 * distances, spots in the direction of `toward` (the source camera) come first.
 */
export function candidateSpots(x: number, z: number, toward: V2, step = 0.25, maxR = 1.5): V2[] {
  const n = Math.floor(maxR / step);
  const tx = toward[0] - x;
  const tz = toward[1] - z;
  const tl = Math.hypot(tx, tz) || 1;
  const out: { p: V2; key: number }[] = [];
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const dist = Math.hypot(i, j) * step;
      if (dist === 0 || dist > maxR + 1e-9) continue;
      const cos = (i * step * tx + j * step * tz) / (dist * tl);
      out.push({ p: [x + i * step, z + j * step], key: dist * (1 - 0.25 * cos) });
    }
  }
  return out.sort((a, b) => a.key - b.key).map((c) => c.p);
}

export interface PlacementResult {
  status: 'clear' | 'moved' | 'stuck';
  x: number;
  z: number;
}

export interface PlacementOptions {
  pose?: Pose;
  /** Preferred direction of travel: the source camera (xz). */
  toward?: V2;
  /** Other actors: a new spot keeps `minGap` (0.5 m) from them. */
  avoid?: V2[];
  step?: number;
  /** Search radius (1.5 m), then `fallbackR` (3 m) if nothing is free that close. */
  maxR?: number;
  fallbackR?: number;
  minGap?: number;
}

/**
 * Leaves a clear actor where it is; moves a blocked one, or one with no floor under it (blocking
 * that lands behind a wall, outside the captured room), to the first free candidate spot with a
 * floor that keeps `minGap` from `avoid`. The search covers `maxR`, then `fallbackR`; 'stuck'
 * when nothing within reach is free.
 */
export function correctPlacement(
  collider: Float32Array | TriGrid,
  x: number,
  z: number,
  opts: PlacementOptions = {},
): PlacementResult {
  const grid = collider instanceof TriGrid ? collider : new TriGrid(collider);
  const pose = opts.pose ?? 'standing';
  const ok = (px: number, pz: number) => {
    const local = grid.around(px, pz);
    return hasFloor(local, px, pz) && !spotBlocked(local, px, pz, pose);
  };
  if (ok(x, z)) return { status: 'clear', x, z };
  const gap = opts.minGap ?? 0.5;
  const step = opts.step ?? 0.25;
  const tried = new Set<string>();
  for (const r of [opts.maxR ?? 1.5, opts.fallbackR ?? 3]) {
    for (const [cx, cz] of candidateSpots(x, z, opts.toward ?? [0, 0], step, r)) {
      const key = `${cx.toFixed(3)},${cz.toFixed(3)}`;
      if (tried.has(key)) continue;
      tried.add(key);
      if ((opts.avoid ?? []).some(([ax, az]) => Math.hypot(ax - cx, az - cz) < gap)) continue;
      if (ok(cx, cz)) return { status: 'moved', x: cx, z: cz };
    }
  }
  return { status: 'stuck', x, z };
}

/** rotation.y that turns a -Z-facing model at `from` to face `to` (both xz). */
export function yawToward(from: V2, to: V2): number {
  return Math.atan2(-(to[0] - from[0]), -(to[1] - from[1]));
}
