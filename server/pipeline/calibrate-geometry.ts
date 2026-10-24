// Geometric scale measurement from a Marble collider mesh (pure: triangle soup in, numbers out).
//
// The collider is flattened into world metres with the SAME transform the viewer applies to the
// splats (web/src/viewer/transform.ts at Marble's metric_scale_factor, floor at y = 0). Every
// measurement below is then a height in those metres, taken relative to the LOCAL floor under it
// (Marble's ground plane is itself an estimate and can sit a couple of decimetres off the real
// floor, e.g. on a rooftop), compared with what that thing measures in the real world:
//
//   ceiling   interiors: floor → first down-facing surface above 1.9 m, mode over the open floor
//   counter   a flat top 0.55–1.3 m up, long and shallow, backed by a wall
//   table     a flat top 0.5–1.1 m up with open floor on most sides
//   seat      a small flat top 0.3–0.65 m up (chair, stool) or a long one outdoors (bench)
//   parapet   a long flat top 0.3–1.3 m up with floor on one side and a drop / void beyond
//   door      an opening in a wall reaching the floor, 0.6–1.4 m wide, with a lintel above
//   canopy    outdoors: a down-facing roof 2–3.5 m above open floor (bus shelter, awning)
//   camera    Marble's source camera height above the floor (a handheld/eye-level band)
//
// Each one yields implied = expected.typ / measured (the correction that would make it typical)
// and a weight from how clean the evidence is; calibrate.ts combines them.
import type { Vec3 } from '../../shared/schema.ts';
import { applyWorldTransform, worldTransform } from '../../web/src/viewer/transform.ts';

export type MeasurementKind =
  | 'ceiling'
  | 'counter'
  | 'table'
  | 'seat'
  | 'bench'
  | 'parapet'
  | 'door'
  | 'canopy'
  | 'camera';

export interface Expected {
  lo: number;
  typ: number;
  hi: number;
}

/** Real-world sizes (m). Bands are deliberately the common range, not the extremes. */
export const EXPECTED: Record<MeasurementKind, Expected & { label: string }> = {
  ceiling: { lo: 2.3, typ: 2.6, hi: 3.2, label: 'ceiling' },
  counter: { lo: 0.86, typ: 0.91, hi: 0.97, label: 'counter' },
  table: { lo: 0.71, typ: 0.75, hi: 0.78, label: 'table' },
  seat: { lo: 0.42, typ: 0.46, hi: 0.5, label: 'seat' },
  bench: { lo: 0.4, typ: 0.45, hi: 0.5, label: 'bench seat' },
  parapet: { lo: 0.5, typ: 0.9, hi: 1.1, label: 'parapet' },
  door: { lo: 1.98, typ: 2.04, hi: 2.4, label: 'door' },
  canopy: { lo: 2.2, typ: 2.6, hi: 3.5, label: 'shelter roof / awning' },
  camera: { lo: 1.3, typ: 1.6, hi: 1.9, label: 'camera height' },
};

export interface Measurement {
  kind: MeasurementKind;
  /** Height in metres at Marble's scale (relative to the local floor). */
  measured: number;
  expected: Expected;
  /** expected.typ / measured */
  implied: number;
  /** 0..1: how much this measurement should count. */
  weight: number;
  /** Supporting samples (grid cells / rays). */
  samples: number;
  /** Where (world xz, Marble metres): the centre of the surface / opening. */
  where?: [number, number];
  /** Facing direction for a mannequin standing in front of it (unit xz), when known. */
  front?: [number, number];
  note?: string;
}

export interface FrameInfo {
  metricScaleFactor: number;
  groundPlaneOffset: number;
  opencvFrame?: boolean;
}

/** Raw collider triangles → world metres with the viewer's transform (× `factor`). */
export function metricTriangles(raw: Float32Array, frame: FrameInfo, factor = 1): Float32Array {
  const t = worldTransform({ ...frame, scaleCalibration: { factor } });
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    const p = applyWorldTransform(t, [raw[i]!, raw[i + 1]!, raw[i + 2]!]);
    out[i] = p[0];
    out[i + 1] = p[1];
    out[i + 2] = p[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Column profile: every non-vertical surface crossing each vertical grid line
// ---------------------------------------------------------------------------

export interface Columns {
  cell: number;
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  /** per column: flat list of [y, ny] pairs, sorted by y */
  hits: Float32Array[];
}

const EMPTY = new Float32Array(0);

/**
 * Rasterizes the triangles onto an xz grid: for each cell centre, the height and normal-y of
 * every triangle above/below it (vertical faces skipped). Normals follow the winding, flipped
 * if needed so the floor faces up (checked near the camera).
 */
export function rasterize(
  tris: Float32Array,
  bounds: { x0: number; z0: number; x1: number; z1: number },
  cell: number,
): Columns {
  const nx = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / cell));
  const nz = Math.max(1, Math.ceil((bounds.z1 - bounds.z0) / cell));
  const lists: number[][] = Array.from({ length: nx * nz }, () => []);
  let orient = 0;
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t]!, ay = tris[t + 1]!, az = tris[t + 2]!;
    const bx = tris[t + 3]!, by = tris[t + 4]!, bz = tris[t + 5]!;
    const cx = tris[t + 6]!, cy = tris[t + 7]!, cz = tris[t + 8]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nxv = uy * vz - uz * vy;
    const nyv = uz * vx - ux * vz;
    const nzv = ux * vy - uy * vx;
    const len = Math.hypot(nxv, nyv, nzv);
    if (!len) continue;
    const ny = nyv / len;
    if (Math.abs(ny) < 0.2) continue;
    const mx = (ax + bx + cx) / 3;
    const my = (ay + by + cy) / 3;
    const mz = (az + bz + cz) / 3;
    if (Math.abs(ny) > 0.9 && Math.abs(my) < 0.4 && Math.hypot(mx, mz) < 4) orient += ny * len;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - bounds.x0) / cell - 0.5));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - bounds.x0) / cell - 0.5));
    const k0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - bounds.z0) / cell - 0.5));
    const k1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) - bounds.z0) / cell - 0.5));
    if (i1 < i0 || k1 < k0) continue;
    // barycentric in xz
    const det = ux * vz - uz * vx;
    if (Math.abs(det) < 1e-12) continue;
    for (let i = i0; i <= i1; i++) {
      const px = bounds.x0 + (i + 0.5) * cell - ax;
      for (let k = k0; k <= k1; k++) {
        const pz = bounds.z0 + (k + 0.5) * cell - az;
        const s = (px * vz - pz * vx) / det;
        const r = (ux * pz - uz * px) / det;
        if (s < -1e-6 || r < -1e-6 || s + r > 1 + 1e-6) continue;
        lists[i * nz + k]!.push(ay + s * uy + r * vy, ny);
      }
    }
  }
  const flip = orient < 0 ? -1 : 1;
  const hits = lists.map((l) => {
    if (!l.length) return EMPTY;
    const pairs: [number, number][] = [];
    for (let j = 0; j < l.length; j += 2) pairs.push([l[j]!, l[j + 1]! * flip]);
    pairs.sort((a, b) => a[0] - b[0]);
    return Float32Array.from(pairs.flat());
  });
  return { cell, x0: bounds.x0, z0: bounds.z0, nx, nz, hits };
}

const quantile = (values: number[], q: number) => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
};
export const median = (values: number[]) => quantile(values, 0.5);

/** Weighted median of `values` (weights > 0). */
export function weightedMedian(values: number[], weights: number[]): number {
  const pairs = values.map((v, i) => [v, Math.max(0, weights[i] ?? 0)] as const).filter((p) => p[1] > 0);
  if (!pairs.length) return NaN;
  pairs.sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let acc = 0;
  for (const [v, w] of pairs) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return pairs[pairs.length - 1]![0];
}

/**
 * Floor height per column: the lowest up-facing surface (≤ 1.2 m), then the 25th percentile of
 * that over a 1 m disc, so a counter top (which has no floor under it in a collider) takes the
 * floor of its neighbours. NaN where there is no floor anywhere near.
 */
export function floorField(c: Columns, radius = 1): Float32Array {
  const low = new Float32Array(c.nx * c.nz).fill(NaN);
  c.hits.forEach((h, idx) => {
    for (let j = 0; j < h.length; j += 2) {
      if (h[j + 1]! > 0.5 && h[j]! > -2 && h[j]! < 1.2) {
        low[idx] = h[j]!;
        break;
      }
    }
  });
  const r = Math.max(1, Math.round(radius / c.cell));
  const out = new Float32Array(c.nx * c.nz).fill(NaN);
  for (let i = 0; i < c.nx; i++)
    for (let k = 0; k < c.nz; k++) {
      const vals: number[] = [];
      for (let di = -r; di <= r; di++)
        for (let dk = -r; dk <= r; dk++) {
          if (di * di + dk * dk > r * r) continue;
          const ii = i + di;
          const kk = k + dk;
          if (ii < 0 || kk < 0 || ii >= c.nx || kk >= c.nz) continue;
          const v = low[ii * c.nz + kk]!;
          if (!Number.isNaN(v)) vals.push(v);
        }
      if (vals.length >= Math.max(3, r * r * 0.3)) out[i * c.nz + k] = quantile(vals, 0.25);
    }
  return out;
}

type Occupancy = 'open' | 'void' | 'other';

/** Can a person stand in this column (floor, nothing 0.2–1.6 m up)? Is it empty (wall / outside)? */
function occupancy(c: Columns, floor: Float32Array, idx: number): Occupancy {
  const f = floor[idx]!;
  const h = c.hits[idx]!;
  if (Number.isNaN(f)) return 'void';
  let floorHit = false;
  let blocked = false;
  let any = false;
  for (let j = 0; j < h.length; j += 2) {
    const y = h[j]! - f;
    if (y > -0.4 && y < 1.8) any = true;
    if (Math.abs(y) < 0.15 && h[j + 1]! > 0.5) floorHit = true;
    else if (y > 0.2 && y < 1.6) blocked = true;
  }
  if (!any) return 'void';
  return floorHit && !blocked ? 'open' : 'other';
}

export interface Surface {
  cells: number[];
  /** the dominant top height (densest 4 cm window) */
  height: number;
  spread: number;
  /** share of the surface's cells within that 4 cm window */
  flatShare: number;
  area: number;
  length: number;
  width: number;
  centre: [number, number];
  /** unit xz direction from the surface toward the open floor next to it */
  front: [number, number];
  openFrac: number;
  voidFrac: number;
  /** below this surface's far edge the floor drops away (parapet) */
  dropFrac: number;
}

/** Flat up-facing tops 0.25–1.5 m above the local floor, region-grown into surfaces. */
export function findSurfaces(c: Columns, floor: Float32Array, minCells = 6): Surface[] {
  const n = c.nx * c.nz;
  const top = new Float32Array(n).fill(NaN);
  for (let idx = 0; idx < n; idx++) {
    const f = floor[idx]!;
    if (Number.isNaN(f)) continue;
    const h = c.hits[idx]!;
    // highest flat up-facing surface in the band with nothing just above it
    for (let j = h.length - 2; j >= 0; j -= 2) {
      const y = h[j]! - f;
      if (y >= 0.25 && y <= 1.5 && h[j + 1]! > 0.9) {
        const above = j + 2 < h.length ? h[j + 2]! - f : Infinity;
        if (above - y > 0.25) top[idx] = y;
        break;
      }
      if (y < 0.25) break;
    }
  }
  const seen = new Uint8Array(n);
  const out: Surface[] = [];
  const occ = new Map<number, Occupancy>();
  const occOf = (idx: number) => {
    let o = occ.get(idx);
    if (!o) occ.set(idx, (o = occupancy(c, floor, idx)));
    return o;
  };
  for (let start = 0; start < n; start++) {
    if (seen[start] || Number.isNaN(top[start]!)) continue;
    const cells: number[] = [];
    const queue = [start];
    seen[start] = 1;
    while (queue.length) {
      const idx = queue.pop()!;
      cells.push(idx);
      const i = Math.floor(idx / c.nz);
      const k = idx % c.nz;
      for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ii = i + di;
        const kk = k + dk;
        if (ii < 0 || kk < 0 || ii >= c.nx || kk >= c.nz) continue;
        const j = ii * c.nz + kk;
        if (seen[j] || Number.isNaN(top[j]!) || Math.abs(top[j]! - top[idx]!) > 0.05) continue;
        seen[j] = 1;
        queue.push(j);
      }
    }
    if (cells.length < minCells) continue;
    const hs = cells.map((idx) => top[idx]!);
    const xs = cells.map((idx) => c.x0 + (Math.floor(idx / c.nz) + 0.5) * c.cell);
    const zs = cells.map((idx) => c.z0 + ((idx % c.nz) + 0.5) * c.cell);
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const mz = zs.reduce((s, v) => s + v, 0) / zs.length;
    // principal axes of the footprint
    let sxx = 0, szz = 0, sxz = 0;
    for (let j = 0; j < xs.length; j++) {
      sxx += (xs[j]! - mx) ** 2;
      szz += (zs[j]! - mz) ** 2;
      sxz += (xs[j]! - mx) * (zs[j]! - mz);
    }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const ax: [number, number] = [Math.cos(ang), Math.sin(ang)];
    const proj = (j: number, a: [number, number]) => (xs[j]! - mx) * a[0] + (zs[j]! - mz) * a[1];
    const along = xs.map((_, j) => proj(j, ax));
    const across = xs.map((_, j) => proj(j, [-ax[1], ax[0]]));
    const length = quantile(along, 0.98) - quantile(along, 0.02) + c.cell;
    const width = quantile(across, 0.98) - quantile(across, 0.02) + c.cell;
    // ring of neighbouring columns: what is around the surface?
    const inside = new Set(cells);
    const ring = new Set<number>();
    const outside = new Set<string>(); // ring cells past the grid edge: nothing there (void)
    for (const idx of cells) {
      const i = Math.floor(idx / c.nz);
      const k = idx % c.nz;
      for (let di = -2; di <= 2; di++)
        for (let dk = -2; dk <= 2; dk++) {
          const ii = i + di;
          const kk = k + dk;
          if (ii < 0 || kk < 0 || ii >= c.nx || kk >= c.nz) {
            outside.add(`${ii},${kk}`);
            continue;
          }
          const j = ii * c.nz + kk;
          if (!inside.has(j)) ring.add(j);
        }
    }
    let open = 0, empty = outside.size, drop = outside.size;
    let fx = 0, fz = 0;
    const mode = modeCluster(hs, 0.04);
    const surfFloor = median(cells.map((idx) => floor[idx]!));
    for (const j of ring) {
      const o = occOf(j);
      const x = c.x0 + (Math.floor(j / c.nz) + 0.5) * c.cell;
      const z = c.z0 + ((j % c.nz) + 0.5) * c.cell;
      if (o === 'open') {
        open++;
        fx += x - mx;
        fz += z - mz;
      } else if (o === 'void') empty++;
      // floor beyond is well below this surface's floor, or there is none at all
      const lowest = c.hits[j]!.length ? c.hits[j]![0]! : NaN;
      if (Number.isNaN(lowest) || lowest < surfFloor - 0.5) drop++;
    }
    const fl = Math.hypot(fx, fz) || 1;
    out.push({
      cells,
      height: mode.value,
      flatShare: mode.share,
      spread: quantile(hs, 0.9) - quantile(hs, 0.1),
      area: cells.length * c.cell * c.cell,
      length: Math.max(length, width),
      width: Math.min(length, width),
      centre: [mx, mz],
      front: [fx / fl, fz / fl],
      openFrac: ring.size + outside.size ? open / (ring.size + outside.size) : 0,
      voidFrac: ring.size + outside.size ? empty / (ring.size + outside.size) : 0,
      dropFrac: ring.size + outside.size ? drop / (ring.size + outside.size) : 0,
    });
  }
  return out.sort((a, b) => b.area - a.area);
}

/** Ceiling height over open floor: per column, floor → first down-facing surface ≥ 1.9 m up. */
export function ceilingSamples(c: Columns, floor: Float32Array): number[] {
  const out: number[] = [];
  for (let idx = 0; idx < c.hits.length; idx++) {
    const f = floor[idx]!;
    if (Number.isNaN(f)) continue;
    if (occupancy(c, floor, idx) !== 'open') continue;
    const h = c.hits[idx]!;
    for (let j = 0; j < h.length; j += 2) {
      const y = h[j]! - f;
      if (y >= 1.9 && h[j + 1]! < -0.5) {
        out.push(y);
        break;
      }
    }
  }
  return out;
}

/** The densest 10 cm window of a sample set: its median and the share of samples in it. */
export function modeCluster(values: number[], window = 0.1): { value: number; share: number; n: number } {
  if (!values.length) return { value: NaN, share: 0, n: 0 };
  const s = [...values].sort((a, b) => a - b);
  let best = 0, bi = 0, j = 0;
  for (let i = 0; i < s.length; i++) {
    while (s[i]! - s[j]! > window) j++;
    if (i - j + 1 > best) {
      best = i - j + 1;
      bi = j;
    }
  }
  const members = s.slice(bi, bi + best);
  return { value: median(members), share: best / s.length, n: best };
}

const mk = (
  kind: MeasurementKind,
  measured: number,
  weight: number,
  samples: number,
  extra: Partial<Measurement> = {},
): Measurement => {
  const e = EXPECTED[kind];
  return {
    kind,
    measured,
    expected: { lo: e.lo, typ: e.typ, hi: e.hi },
    implied: e.typ / measured,
    weight: Math.max(0, Math.min(1, weight)),
    samples,
    ...extra,
  };
};

/**
 * Turns surfaces into counter / table / seat / bench / parapet measurements. Shape decides the
 * kind, never the height (a height-based label would assume the scale it is meant to check):
 * counters are long and backed by a wall, tables are compact with room around them.
 */
export function classifySurfaces(surfaces: Surface[], interior: boolean): Measurement[] {
  const out: Measurement[] = [];
  for (const s of surfaces) {
    const flat = s.flatShare; // share of the top within one 4 cm height band
    const flatArea = s.area * s.flatShare;
    const aspect = s.length / Math.max(s.width, 1e-3);
    const extra = {
      where: s.centre,
      front: s.front,
      note: `${s.length.toFixed(1)}×${s.width.toFixed(1)} m top, ${Math.round(s.openFrac * 100)}% open floor around`,
    };
    const h = s.height;
    if (interior) {
      const backed = s.voidFrac >= 0.1 || s.openFrac < 0.6;
      if (h >= 0.55 && h <= 1.3 && s.length >= 1 && aspect >= 1.8 && s.width >= 0.3 && s.width <= 1 && backed && flat >= 0.4)
        out.push(mk('counter', h, 0.3 + 0.5 * flat + Math.min(0.2, flatArea / 5), s.cells.length, extra));
      else if (h >= 0.5 && h <= 1.1 && aspect < 1.8 && flatArea >= 0.2 && s.area <= 3 && s.openFrac >= 0.1 && s.voidFrac < 0.3)
        out.push(mk('table', h, 0.2 + 0.5 * flat + 0.3 * Math.min(1, s.openFrac * 2), s.cells.length, extra));
      else if (h >= 0.3 && h <= 0.65 && aspect < 2.5 && flatArea >= 0.06 && s.area <= 0.7 && s.openFrac >= 0.3)
        out.push(mk('seat', h, 0.1 + 0.3 * flat, s.cells.length, extra));
    } else if (flat >= 0.5) {
      if (h >= 0.35 && h <= 1.3 && s.length >= 2 && aspect >= 3 && s.dropFrac >= 0.15 && s.openFrac >= 0.15)
        out.push(mk('parapet', h, 0.15 + 0.15 * flat, s.cells.length, extra));
      else if (h >= 0.33 && h <= 0.65 && s.length >= 1 && s.length <= 3.5 && aspect >= 2.5 && flatArea >= 0.25 && s.openFrac >= 0.3)
        out.push(mk('bench', h, (0.2 + 0.3 * flat) * Math.min(1, flatArea / 0.5), s.cells.length, extra));
    }
  }
  return out;
}

/** Down-facing roofs 2–3.5 m above the floor outdoors (bus shelter, awning). */
export function canopySamples(c: Columns, floor: Float32Array): { h: number; x: number; z: number }[] {
  const out: { h: number; x: number; z: number }[] = [];
  for (let idx = 0; idx < c.hits.length; idx++) {
    const f = floor[idx]!;
    if (Number.isNaN(f) || occupancy(c, floor, idx) === 'void') continue;
    const h = c.hits[idx]!;
    for (let j = 0; j < h.length; j += 2) {
      const y = h[j]! - f;
      if (y > 1.9 && h[j + 1]! < -0.8) {
        if (y <= 3.5)
          out.push({ h: y, x: c.x0 + (Math.floor(idx / c.nz) + 0.5) * c.cell, z: c.z0 + ((idx % c.nz) + 0.5) * c.cell });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Doors: openings in the walls around an interior, seen with horizontal rays
// ---------------------------------------------------------------------------

/** Distance along unit `d` from `o` to the nearest triangle (double-sided), within `far`. */
export type RayCast = (o: Vec3, d: Vec3, far: number) => number | null;

/** Möller–Trumbore, double-sided: distance to triangle `t` (offset into `tris`) or -1. */
function hitTri(tris: Float32Array, t: number, o: Vec3, d: Vec3): number {
  const e1x = tris[t + 3]! - tris[t]!, e1y = tris[t + 4]! - tris[t + 1]!, e1z = tris[t + 5]! - tris[t + 2]!;
  const e2x = tris[t + 6]! - tris[t]!, e2y = tris[t + 7]! - tris[t + 1]!, e2z = tris[t + 8]! - tris[t + 2]!;
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const sx = o[0] - tris[t]!, sy = o[1] - tris[t + 1]!, sz = o[2] - tris[t + 2]!;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const w = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (w < 0 || u + w > 1) return -1;
  const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return dist >= 0 ? dist : -1;
}

/**
 * Uniform xz grid for long rays: a cast marches cell by cell from the origin and stops at the
 * first hit, so a 15 m ray in a 300k-triangle room tests a few hundred triangles, not all.
 */
export class RayGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly big: number[] = [];
  private readonly stamp: Int32Array;
  private castId = 0;

  constructor(
    readonly tris: Float32Array,
    readonly cell = 0.5,
  ) {
    this.stamp = new Int32Array(tris.length / 9);
    for (let t = 0; t < tris.length; t += 9) {
      const i0 = Math.floor(Math.min(tris[t]!, tris[t + 3]!, tris[t + 6]!) / cell);
      const i1 = Math.floor(Math.max(tris[t]!, tris[t + 3]!, tris[t + 6]!) / cell);
      const k0 = Math.floor(Math.min(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!) / cell);
      const k1 = Math.floor(Math.max(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!) / cell);
      if ((i1 - i0 + 1) * (k1 - k0 + 1) > 256) {
        this.big.push(t);
        continue;
      }
      for (let i = i0; i <= i1; i++)
        for (let k = k0; k <= k1; k++) {
          const key = (i + 32768) * 65536 + (k + 32768);
          const l = this.cells.get(key);
          if (l) l.push(t);
          else this.cells.set(key, [t]);
        }
    }
  }

  readonly cast: RayCast = (o, d, far) => {
    const id = ++this.castId;
    let best = Infinity;
    const test = (list: number[]) => {
      for (const t of list) {
        if (this.stamp[t / 9] === id) continue;
        this.stamp[t / 9] = id;
        const h = hitTri(this.tris, t, o, d);
        if (h >= 0 && h <= far && h < best) best = h;
      }
    };
    test(this.big);
    const step = this.cell * 0.5;
    let last = NaN;
    for (let s = 0; s <= far + step; s += step) {
      const i = Math.floor((o[0] + d[0] * s) / this.cell);
      const k = Math.floor((o[2] + d[2] * s) / this.cell);
      const key = (i + 32768) * 65536 + (k + 32768);
      if (key !== last) {
        last = key;
        const l = this.cells.get(key);
        if (l) test(l);
      }
      if (best < s - this.cell) break;
    }
    return Number.isFinite(best) ? best : null;
  };
}

export interface DoorOpts {
  /** floor height at the origin */
  floorY: number;
  ceiling: number;
  origins: [number, number][];
  stepDeg?: number;
}

/**
 * From each origin, sweeps horizontal rays at 0.35 m, 1.0 m and just under the ceiling. A door
 * is a run of azimuths where the low rays go ≥ 0.35 m deeper than the wall seen near the ceiling
 * (an opening down to the floor under a lintel), 0.6–1.4 m wide at the wall. Its head height is
 * the lowest ray height at which the opening's centre ray stops at the wall.
 */
export function findDoors(cast: RayCast, o: DoorOpts): Measurement[] {
  const step = ((o.stepDeg ?? 0.5) * Math.PI) / 180;
  const out: Measurement[] = [];
  const seenAt: [number, number][] = [];
  const top = o.floorY + o.ceiling - 0.12;
  if (o.ceiling < 1.8) return out;
  for (const [ox, oz] of o.origins) {
    const n = Math.round((2 * Math.PI) / step);
    const rows = Array.from({ length: n }, (_, i) => {
      const a = i * step;
      const d: Vec3 = [Math.sin(a), 0, Math.cos(a)];
      const at = (y: number) => cast([ox, o.floorY + y, oz], d, 15) ?? Infinity;
      return { a, d, low: at(0.35), mid: at(1.0), wall: cast([ox, top, oz], d, 15) ?? Infinity };
    });
    const isOpen = (r: (typeof rows)[number]) =>
      Number.isFinite(r.wall) && r.mid > r.wall + 0.35 && r.low > r.wall + 0.35;
    let i = 0;
    // start the sweep on a closed azimuth so a run never wraps around index 0
    const firstClosed = rows.findIndex((r) => !isOpen(r));
    if (firstClosed < 0) continue;
    for (let s = 0; s < n; s++) {
      i = (firstClosed + s) % n;
      if (!isOpen(rows[i]!)) continue;
      const run = [rows[i]!];
      while (s + 1 < n && isOpen(rows[(firstClosed + s + 1) % n]!)) {
        s++;
        run.push(rows[(firstClosed + s) % n]!);
      }
      const wallD = median(run.map((r) => r.wall));
      const width = run.length * step * wallD;
      if (run.length < 3 || width < 0.6 || width > 1.4) continue;
      const c = run[Math.floor(run.length / 2)]!;
      // head: scan up from 1.2 m until the centre ray stops near the wall
      let head = NaN;
      for (let y = 1.2; y <= o.ceiling - 0.05; y += 0.01) {
        const dd = cast([ox, o.floorY + y, oz], c.d, 15) ?? Infinity;
        if (dd < wallD + 0.2) {
          head = y;
          break;
        }
      }
      if (!Number.isFinite(head) || head > o.ceiling - 0.15) continue;
      const wx = ox + c.d[0] * wallD;
      const wz = oz + c.d[2] * wallD;
      if (seenAt.some(([x, z]) => Math.hypot(x - wx, z - wz) < 0.8)) continue;
      seenAt.push([wx, wz]);
      out.push(
        mk('door', head, 0.6, run.length, {
          where: [wx, wz],
          front: [-c.d[0], -c.d[2]],
          note: `${width.toFixed(2)} m wide opening ${wallD.toFixed(1)} m from (${ox.toFixed(1)}, ${oz.toFixed(1)})`,
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole-world analysis
// ---------------------------------------------------------------------------

export interface GeometryReport {
  interior: boolean;
  measurements: Measurement[];
  /** Marble's ground plane minus the measured floor near the camera (m, + = floor is lower). */
  floorOffset: number;
  /** Measured floor height (y) at the origin, Marble metres. */
  floorAtCamera: number;
  cameraHeight: number;
  extent: { x0: number; z0: number; x1: number; z1: number };
  notes: string[];
}

export interface AnalyzeOptions {
  interior?: boolean;
  /** Camera height above Marble's ground plane (= groundPlaneOffset). */
  cameraY: number;
  cast?: RayCast;
  cell?: number;
  radius?: number;
}

/** Guesses interior vs exterior: a ceiling over most of the open floor near the camera. */
export function looksInterior(c: Columns, floor: Float32Array): boolean {
  let open = 0, covered = 0;
  const ci = Math.floor(-c.x0 / c.cell);
  const ck = Math.floor(-c.z0 / c.cell);
  const r = Math.round(3 / c.cell);
  for (let i = ci - r; i <= ci + r; i++)
    for (let k = ck - r; k <= ck + r; k++) {
      if (i < 0 || k < 0 || i >= c.nx || k >= c.nz) continue;
      const idx = i * c.nz + k;
      if (occupancy(c, floor, idx) !== 'open') continue;
      open++;
      const h = c.hits[idx]!;
      for (let j = 0; j < h.length; j += 2)
        if (h[j]! - floor[idx]! > 1.9 && h[j]! - floor[idx]! < 6 && h[j + 1]! < -0.5) {
          covered++;
          break;
        }
    }
  return open > 20 && covered / open > 0.6;
}

export function analyzeGeometry(tris: Float32Array, o: AnalyzeOptions): GeometryReport {
  const radius = o.radius ?? 14;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    x0 = Math.min(x0, tris[i]!);
    x1 = Math.max(x1, tris[i]!);
    z0 = Math.min(z0, tris[i + 2]!);
    z1 = Math.max(z1, tris[i + 2]!);
  }
  const extent = {
    x0: Math.max(x0, -radius),
    z0: Math.max(z0, -radius),
    x1: Math.min(x1, radius),
    z1: Math.min(z1, radius),
  };
  const notes: string[] = [];
  const span = Math.max(extent.x1 - extent.x0, extent.z1 - extent.z0);
  const cell = o.cell ?? (span > 16 ? 0.2 : 0.1);
  const cols = rasterize(tris, extent, cell);
  const floor = floorField(cols);
  const interior = o.interior ?? looksInterior(cols, floor);
  const ci = Math.min(cols.nx - 1, Math.max(0, Math.floor(-extent.x0 / cell)));
  const ck = Math.min(cols.nz - 1, Math.max(0, Math.floor(-extent.z0 / cell)));
  // floor near the camera: median of the field within 2.5 m
  const near: number[] = [];
  const r = Math.round(2.5 / cell);
  for (let i = ci - r; i <= ci + r; i++)
    for (let k = ck - r; k <= ck + r; k++) {
      if (i < 0 || k < 0 || i >= cols.nx || k >= cols.nz || (i - ci) ** 2 + (k - ck) ** 2 > r * r) continue;
      const v = floor[i * cols.nz + k]!;
      if (!Number.isNaN(v)) near.push(v);
    }
  const floorAtCamera = near.length ? median(near) : 0;
  const cameraHeight = o.cameraY - floorAtCamera;
  const measurements: Measurement[] = [];

  if (interior) {
    const ceil = modeCluster(ceilingSamples(cols, floor));
    if (ceil.n >= 20) {
      measurements.push(
        mk('ceiling', ceil.value, 0.3 + 0.5 * ceil.share, ceil.n, {
          note: `${Math.round(ceil.share * 100)}% of ${Math.round(ceil.n / ceil.share)} open-floor columns`,
        }),
      );
      const cast = o.cast ?? new RayGrid(tris).cast;
      measurements.push(...findDoors(cast, { floorY: floorAtCamera, ceiling: ceil.value, origins: [[0, 0]] }));
    } else notes.push('no ceiling found over the open floor');
  } else {
    const can = canopySamples(cols, floor);
    const cl = modeCluster(can.map((s) => s.h));
    if (cl.n * cell * cell >= 1.5) {
      const members = can.filter((s) => Math.abs(s.h - cl.value) <= 0.1);
      const mx = median(members.map((s) => s.x));
      const mz = median(members.map((s) => s.z));
      measurements.push(
        mk('canopy', cl.value, 0.2, cl.n, {
          where: [mx, mz],
          note: `${(cl.n * cell * cell).toFixed(1)} m² of roof over open floor`,
        }),
      );
    }
  }
  measurements.push(...classifySurfaces(findSurfaces(cols, floor), interior));
  measurements.push(
    mk('camera', cameraHeight, 0.15, 1, { note: 'Marble source camera above the measured floor' }),
  );
  return {
    interior,
    measurements,
    floorOffset: -floorAtCamera,
    floorAtCamera,
    cameraHeight,
    extent,
    notes,
  };
}
