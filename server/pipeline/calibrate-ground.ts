// Where the visible ground is, measured from the splats themselves (→ WorldAsset.floorOffsetMeters).
//
// Marble's declared ground plane matches the splat ground right under its source camera (median
// within ±2 cm on our four worlds), but not necessarily where the actors stand 2.5–3 m out: there
// the rooftop's splat ground is 0.18–0.26 m lower and the city street's 0.04–0.16 m, while the bus
// stop's is within 4 cm. The collider mesh is no reference for this: outdoors it sits ~0.1 m below
// the splats (bus stop: collider -0.12 m, splats -0.01 m), so an offset taken from it buries the
// actors' feet. Instead, per probe (each actor's blocking mark, else the usual blocking area in
// front of the camera) the opaque splats in a vertical column are histogrammed and the densest
// thin layer below knee height is the ground; the median over the probes is the world's ground
// height, and floorOffsetMeters = -that (the viewer raises the world by it). The median stays the
// world's global fallback; the ground height FIELD below (ground.json) is what actors stand on.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  feetY,
  GROUND_FIELD_SCHEMA,
  sampleGround,
  validateGroundField,
  type GroundField,
} from '../../shared/ground.ts';
import type { WorldAsset } from '../../shared/schema.ts';
import { applyWorldTransform, calibrationFactor, worldTransform } from '../../web/src/viewer/transform.ts';
import { writeFileAtomic } from './fsutil.ts';
import { decodeSpzPoints } from './spz.ts';

export interface GroundProbe {
  x: number;
  z: number;
  /** column radius, m */
  r: number;
}

/** Where blocking usually puts actors when no marks are known: 2.5–3 m in front of the camera. */
export const DEFAULT_PROBES: readonly GroundProbe[] = [
  { x: 0, z: -2.5, r: 1 },
  { x: 1.5, z: -3, r: 1 },
  { x: -1.5, z: -3, r: 1 },
];
export const MARK_RADIUS = 0.6;
/** Splats considered: opaque, between these heights (m) relative to Marble's plane. */
const OPACITY = 0.5;
const Y_RANGE = [-0.8, 0.3] as const;
const BIN = 0.02;
const REFINE = 0.05;

export function probesFor(marks?: readonly (readonly [number, number])[]): GroundProbe[] {
  return marks?.length ? marks.map(([x, z]) => ({ x, z, r: MARK_RADIUS })) : [...DEFAULT_PROBES];
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Height of the ground layer among splat heights `ys` (m, Marble's frame): the densest 2 cm layer
 * between -0.8 and +0.3 m (furniture tops, benches and shins sit higher), refined to the median of
 * the heights within ±5 cm of it. null with fewer than `min` heights in range.
 */
export function groundHeight(ys: readonly number[], min = 150): number | null {
  const inRange = ys.filter((y) => y >= Y_RANGE[0] && y <= Y_RANGE[1]);
  if (inRange.length < min) return null;
  const bins = new Map<number, number>();
  for (const y of inRange) {
    const b = Math.round(y / BIN);
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  // smooth over neighbours so one noisy bin cannot win
  let best = 0;
  let bestN = -1;
  for (const b of bins.keys()) {
    const n = (bins.get(b - 1) ?? 0) + 2 * (bins.get(b) ?? 0) + (bins.get(b + 1) ?? 0);
    if (n > bestN || (n === bestN && b < best)) [best, bestN] = [b, n];
  }
  const mode = best * BIN;
  return median(inRange.filter((y) => Math.abs(y - mode) <= REFINE));
}

export interface GroundMeasurement {
  method: string;
  probes: (GroundProbe & { height: number | null; splats: number })[];
  /** Median of the probes' ground heights, m relative to Marble's plane (null: nothing measurable). */
  height: number | null;
}

/** Ground per probe from metric splat positions (x, y, z interleaved) and opacities (0..1). */
export function measureGround(
  positions: Float32Array,
  opacities: Float32Array,
  probes: readonly GroundProbe[],
): GroundMeasurement {
  const columns = probes.map(() => [] as number[]);
  for (let i = 0; i < opacities.length; i++) {
    if (opacities[i]! < OPACITY) continue;
    const x = positions[3 * i]!;
    const y = positions[3 * i + 1]!;
    const z = positions[3 * i + 2]!;
    if (y < Y_RANGE[0] || y > Y_RANGE[1]) continue;
    probes.forEach((p, k) => {
      if ((x - p.x) ** 2 + (z - p.z) ** 2 <= p.r * p.r) columns[k]!.push(y);
    });
  }
  const measured = probes.map((p, k) => ({ ...p, height: groundHeight(columns[k]!), splats: columns[k]!.length }));
  const heights = measured.flatMap((p) => (p.height === null ? [] : [p.height]));
  return {
    method: `opaque splats in ${probes.length} column(s) (r ${probes.map((p) => p.r).join('/')} m): densest 2 cm layer below +0.3 m`,
    probes: measured.map((p) => ({ ...p, height: p.height === null ? null : Math.round(p.height * 1000) / 1000 })),
    height: heights.length ? Math.round(median(heights) * 1000) / 1000 : null,
  };
}

/**
 * The visible ground of a world dir (world-asset.json + its 500k SPZ) at the given marks (xz, m),
 * else at DEFAULT_PROBES; null when the SPZ is missing or unreadable. Local only, ~2 s.
 */
export async function splatGround(
  worldDir: string,
  asset: WorldAsset,
  marks?: readonly (readonly [number, number])[],
): Promise<GroundMeasurement | null> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(join(worldDir, asset.spz.k500)));
  } catch {
    return null;
  }
  const { positions, opacities } = decodeSpzPoints(bytes);
  toFieldFrame(asset, positions);
  const f = calibrationFactor(asset);
  const at = marks?.map(([x, z]) => [x / f, z / f] as const);
  return measureGround(positions, opacities, probesFor(at));
}

/**
 * Raw SPZ positions (in place) → Marble's declared frame and scale, Y up: floorOffsetMeters is
 * stored at Marble's scale, so neither a stored floor offset nor the scale calibration moves what
 * the ground is measured against (the frame shared/ground.ts documents).
 */
function toFieldFrame(asset: WorldAsset, positions: Float32Array): void {
  const t = worldTransform({ ...asset, floorOffsetMeters: 0, scaleCalibration: null });
  for (let j = 0; j < positions.length; j += 3) {
    const [x, y, z] = applyWorldTransform(t, [positions[j]!, positions[j + 1]!, positions[j + 2]!]);
    positions[j] = x;
    positions[j + 1] = y;
    positions[j + 2] = z;
  }
}

// ---------------------------------------------------------------------------
// Ground height field (shared/ground.ts; WorldAsset.ground → ground.json next to the world files)
// ---------------------------------------------------------------------------
//
// The median above is right where it was measured and nowhere else: under the default probes
// alone the ground spans 12 cm on the city street (the kerb runs through the blocking area), the
// rooftop's tar deck lies ~0.2 m below the walkway the camera stands on, and the bus stop's street
// falls 0.4 m towards the far kerb. So the field measures every 0.25 m column of the staging area
// (x -8..8, z -12..3 m around the source camera, grown to every mark ± 2 m):
//
//   0. flat     only opaque splats LYING FLAT count: a flat disc (thinnest axis ≤ half the middle
//               one) whose normal is within 41° of vertical. Ground splats are exactly that
//               (92-96 % of them on the kitchen floor and the city street), while a wall, a
//               cabinet front or a post is made of upright discs and a bush of round blobs, so
//               their splats never pile up into a fake floor at the foot of the wall.
//   1. layers   per column, those between -1.0 and +0.4 m (Marble's plane) are histogrammed (2 cm
//               bins, 1-2-1 smoothed); a peak is a ground candidate when ≥ minLayer splats lie
//               within ±5 cm of it, they are ≥ half of those within ±17 cm (a thin surface, not a
//               slope of clutter) and ≥ 30 % of the column's strongest layer
//   2. lowest   the LOWEST candidate is the ground: whatever could out-vote it in a column (a
//               bench seat, a kerb top, a table, a car bonnet) stands on top of it, while splats
//               under a visible surface are occluded and do not form a dense layer
//   3. steps    a pick more than 0.25 m (one stair step; kerbs are 0.10-0.18 m) from the median of
//               its 5×5 neighbourhood is furniture over unseen ground (a bench seat with no floor
//               captured under it): the column takes its candidate closest to that median within
//               0.25 m, else becomes a hole
//   4. spikes   a cell with < 2 neighbours holding ground is a stray speck (hole); one more than
//               8 cm off its 3×3 median takes the median. Nothing is blurred: a kerb stays a
//               one-cell step instead of being smeared over its neighbours.
//   5. crop     the grid shrinks to the cells with ground (an interior's room, not 16 × 15 m).
//
// Holes stay null; shared/ground.ts's sampler bridges them from the nearest ground. The decode
// prefers world_full.spz (1.9M splats, ~1 s): 4× the 500k tier's density gives far more columns
// enough splats to decide (see docs/PLAN.md "Coordinate conventions").

export const GROUND_FILE = 'ground.json';
/** Bump when the rule changes: a stored field of another version is measured again. */
export const GROUND_VERSION = 'v1';
const FIELD_Y = [-1.0, 0.4] as const;
const LAYER_HALF = 0.05;
const WIDE_HALF = 0.17;
const THIN = 0.5;
const RELATIVE = 0.3;
const STEP_MAX = 0.25;
const SPIKE = 0.08;
const MARK_MARGIN = 2;
/** |normal · up| a ground splat needs: cos 41°. */
const UP_MIN = 0.75;

/** Splats in the field's frame (decodeSpzPoints, moved by toFieldFrame). */
export interface FieldPoints {
  /** x, y, z interleaved, m. */
  positions: Float32Array;
  /** 0..1 */
  opacities: Float32Array;
  /** decodeSpzPoints' surfaceUp; absent or NaN = orientation unknown (the splat counts). */
  surfaceUp?: Float32Array;
}

export interface FieldOptions {
  /** x bounds, m at Marble's scale (default -8..8). */
  x?: readonly [number, number];
  /** z bounds, m at Marble's scale (default -12..3). */
  z?: readonly [number, number];
  /** Cell size, m (default 0.25). */
  cell?: number;
  /** Fewest splats a ground layer needs (default 8; the sparse mock world needs 2). */
  minLayer?: number;
  /** Blocking marks (xz, m at Marble's scale): the grid grows to include each ± 2 m. */
  marks?: readonly (readonly [number, number])[];
  /** The source for `method`, e.g. "world_full.spz, 1.92M splats". */
  source?: string;
}

export interface Layer {
  /** Median height of the layer's splats, m. */
  y: number;
  /** Splats within ±5 cm. */
  n: number;
}

const lowerBound = (a: ArrayLike<number>, v: number) => {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * Thin dense horizontal layers among one column's splat heights (`ys` sorted ascending, m),
 * lowest first: step 1 of the field rule.
 */
export function groundLayers(ys: ArrayLike<number>, minLayer = 8): Layer[] {
  if (ys.length < minLayer) return [];
  const nb = Math.round((FIELD_Y[1] - FIELD_Y[0]) / BIN);
  const h = new Float64Array(nb + 2); // an empty guard bin on each side
  for (let i = 0; i < ys.length; i++) {
    const b = Math.floor((ys[i]! - FIELD_Y[0]) / BIN);
    if (b >= 0 && b < nb) h[b + 1]!++;
  }
  const s = (b: number) => (b <= 0 || b > nb ? 0 : h[b - 1]! + 2 * h[b]! + h[b + 1]!);
  const count = (lo: number, hi: number) => lowerBound(ys, hi) - lowerBound(ys, lo);
  const found: Layer[] = [];
  for (let b = 1; b <= nb; b++) {
    const v = s(b);
    if (v <= 0 || v < s(b - 1) || v <= s(b + 1)) continue;
    const c = FIELD_Y[0] + (b - 0.5) * BIN;
    const n = count(c - LAYER_HALF, c + LAYER_HALF);
    if (n < minLayer || n < THIN * count(c - WIDE_HALF, c + WIDE_HALF)) continue;
    const lo = lowerBound(ys, c - LAYER_HALF);
    const mid = lo + ((n - 1) >> 1);
    const y = n % 2 ? ys[mid]! : (ys[mid]! + ys[mid + 1]!) / 2;
    const prev = found.at(-1);
    // two peaks of one layer (the kernel can leave a shoulder): keep the stronger
    if (prev && y - prev.y < 0.06) {
      if (n > prev.n) found[found.length - 1] = { y, n };
      continue;
    }
    found.push({ y, n });
  }
  const strongest = Math.max(0, ...found.map((l) => l.n));
  return found.filter((l) => l.n >= RELATIVE * strongest);
}

const medianOf = (a: number[]) => {
  const s = a.sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The field's `method` text; its prefix is the rule version (storedGroundField). */
export function fieldMethod(cell: number, minLayer: number, source?: string): string {
  return `previz ground ${GROUND_VERSION}: ${cell} m columns of opaque splats lying flat${source ? ` (${source})` : ''}, lowest thin layer (≥ ${minLayer} splats, ≥ 30 % of the strongest) between ${FIELD_Y[0]} and +${FIELD_Y[1]} m, steps > ${STEP_MAX} m from the 5×5 median rejected, 3×3 spike median`;
}

/**
 * The ground height field of splats in the frame shared/ground.ts documents (Y up, Marble's scale
 * and plane); null when no column holds ground.
 */
export function buildGroundField(pts: FieldPoints, o: FieldOptions = {}): GroundField | null {
  const { positions, opacities, surfaceUp } = pts;
  const cell = o.cell ?? 0.25;
  const minLayer = o.minLayer ?? 8;
  let [x0, x1] = o.x ?? [-8, 8];
  let [z0, z1] = o.z ?? [-12, 3];
  for (const [mx, mz] of o.marks ?? []) {
    if (!Number.isFinite(mx) || !Number.isFinite(mz)) continue;
    x0 = Math.min(x0, mx - MARK_MARGIN);
    x1 = Math.max(x1, mx + MARK_MARGIN);
    z0 = Math.min(z0, mz - MARK_MARGIN);
    z1 = Math.max(z1, mz + MARK_MARGIN);
  }
  // whole cells from the origin, so every field of a world shares one lattice
  x0 = Math.floor(x0 / cell + 1e-9) * cell;
  z0 = Math.floor(z0 / cell + 1e-9) * cell;
  const cols = Math.max(1, Math.ceil((x1 - x0) / cell - 1e-9));
  const rows = Math.max(1, Math.ceil((z1 - z0) / cell - 1e-9));
  const N = cols * rows;
  const cellOf = (i: number): number => {
    if (opacities[i]! < OPACITY || (surfaceUp && surfaceUp[i]! < UP_MIN)) return -1;
    const y = positions[3 * i + 1]!;
    if (!(y >= FIELD_Y[0] && y < FIELD_Y[1])) return -1;
    const ci = Math.floor((positions[3 * i]! - x0) / cell);
    const ck = Math.floor((positions[3 * i + 2]! - z0) / cell);
    return ci >= 0 && ck >= 0 && ci < cols && ck < rows ? ck * cols + ci : -1;
  };
  // counting sort of the in-window heights by column
  const start = new Uint32Array(N + 1);
  for (let i = 0; i < opacities.length; i++) {
    const c = cellOf(i);
    if (c >= 0) start[c + 1]!++;
  }
  for (let c = 0; c < N; c++) start[c + 1]! += start[c]!;
  const ys = new Float32Array(start[N]!);
  const fill = start.slice(0, N);
  for (let i = 0; i < opacities.length; i++) {
    const c = cellOf(i);
    if (c >= 0) ys[fill[c]!++] = positions[3 * i + 1]!;
  }
  // 1-2: candidates per column, the lowest picked
  const layers: Layer[][] = [];
  const pick: (number | null)[] = [];
  const count: number[] = [];
  for (let c = 0; c < N; c++) {
    const l = groundLayers(ys.subarray(start[c]!, start[c + 1]!).sort(), minLayer);
    layers.push(l);
    pick.push(l[0]?.y ?? null);
    count.push(l[0]?.n ?? 0);
  }
  const around = (src: (number | null)[], c: number, r: number, self: boolean) => {
    const ci = c % cols;
    const ck = (c - ci) / cols;
    const out: number[] = [];
    for (let dk = -r; dk <= r; dk++)
      for (let di = -r; di <= r; di++) {
        if (!self && di === 0 && dk === 0) continue;
        const i = ci + di;
        const k = ck + dk;
        if (i < 0 || k < 0 || i >= cols || k >= rows) continue;
        const v = src[k * cols + i];
        if (typeof v === 'number') out.push(v);
      }
    return out;
  };
  // 3: more than a stair step off the neighbourhood is furniture over unseen ground
  const stepped = pick.slice();
  for (let c = 0; c < N; c++) {
    const v = pick[c];
    if (typeof v !== 'number') continue;
    const near = around(pick, c, 2, false);
    if (near.length < 5) continue;
    const ref = medianOf(near);
    if (Math.abs(v - ref) <= STEP_MAX) continue;
    let best: Layer | null = null;
    for (const l of layers[c]!)
      if (Math.abs(l.y - ref) <= STEP_MAX && (!best || Math.abs(l.y - ref) < Math.abs(best.y - ref))) best = l;
    stepped[c] = best ? best.y : null;
    count[c] = best ? best.n : 0;
  }
  // 4: specks and spikes
  const heights = stepped.slice();
  for (let c = 0; c < N; c++) {
    const v = stepped[c];
    if (typeof v !== 'number') continue;
    if (around(stepped, c, 1, false).length < 2) {
      heights[c] = null;
      count[c] = 0;
      continue;
    }
    const med = medianOf(around(stepped, c, 1, true));
    if (Math.abs(v - med) > SPIKE) heights[c] = med;
  }
  // 5: crop to the cells with ground
  let [i0, i1, k0, k1] = [cols, -1, rows, -1];
  for (let c = 0; c < N; c++) {
    if (heights[c] === null) continue;
    const i = c % cols;
    const k = (c - i) / cols;
    [i0, i1, k0, k1] = [Math.min(i0, i), Math.max(i1, i), Math.min(k0, k), Math.max(k1, k)];
  }
  if (i1 < 0) return null;
  const outH: (number | null)[] = [];
  const outN: number[] = [];
  for (let k = k0; k <= k1; k++)
    for (let i = i0; i <= i1; i++) {
      const v = heights[k * cols + i];
      outH.push(typeof v === 'number' ? Math.round(v * 1000) / 1000 : null);
      outN.push(typeof v === 'number' ? count[k * cols + i]! : 0);
    }
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return validateGroundField({
    schema: GROUND_FIELD_SCHEMA,
    origin: [r6(x0 + i0 * cell), r6(z0 + k0 * cell)],
    cell,
    cols: i1 - i0 + 1,
    rows: k1 - k0 + 1,
    heights: outH,
    counts: outN,
    method: fieldMethod(cell, minLayer, o.source),
  });
}

/** Cells with ground / all cells. */
export function fieldCoverage(f: GroundField): { covered: number; cells: number } {
  return { covered: f.heights.filter((h) => h !== null).length, cells: f.heights.length };
}

/** WorldAsset.ground for a field stored as `file` (world-dir- or project-root-relative). */
export function groundRef(f: GroundField, file = GROUND_FILE): NonNullable<WorldAsset['ground']> {
  return { file, cell: f.cell, ...fieldCoverage(f) };
}

/**
 * Report text (cli calibrate): extent, coverage, range and, per mark (scene metres), the ground
 * there and where the viewer now puts the feet relative to the old y = 0.
 */
export function describeField(
  f: GroundField | null,
  asset: WorldAsset,
  marks?: readonly (readonly [number, number])[],
): string {
  if (!f) return '  ground field: none (no column holds ground); actors stand on the median floor';
  const { covered, cells } = fieldCoverage(f);
  const hs = f.heights.filter((h): h is number => h !== null);
  const sign = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
  const frame = { factor: calibrationFactor(asset), floorOffset: asset.floorOffsetMeters ?? 0 };
  const L = [
    `  ground field: ${f.cols}×${f.rows} cells of ${f.cell} m from (${f.origin.join(', ')}), ${Math.round((100 * covered) / cells)} % with ground, ${sign(Math.min(...hs))}..${sign(Math.max(...hs))} m vs Marble's plane (median floor ${sign(-frame.floorOffset)})`,
  ];
  for (const [x, z] of marks ?? []) {
    const h = sampleGround(f, x / frame.factor, z / frame.factor);
    L.push(
      `    mark (${x}, ${z}): ground ${h === null ? '— (no ground within 2 cells)' : `${sign(h)} m → feet at y ${sign(feetY(f, frame, x / frame.factor, z / frame.factor))} m (was 0)`}`,
    );
  }
  return L.join('\n');
}

/** Splat positions of a world dir in the field's frame; the full SPZ when there is one. */
async function fieldPoints(
  worldDir: string,
  asset: WorldAsset,
  tier: 'full' | 'k500' = asset.spz.full ? 'full' : 'k500',
): Promise<FieldPoints & { source: string }> {
  const name = asset.spz[tier] ?? asset.spz.k500;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(join(worldDir, name)));
  } catch (e) {
    if (name === asset.spz.k500) throw e;
    return fieldPoints(worldDir, asset, 'k500'); // a copy without its full tier
  }
  const { positions, opacities, surfaceUp } = decodeSpzPoints(bytes);
  toFieldFrame(asset, positions);
  const n = opacities.length;
  const size = n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`;
  return { positions, opacities, surfaceUp, source: `${name}, ${size} splats` };
}

export interface WorldFieldOptions extends Omit<FieldOptions, 'marks' | 'source'> {
  /** Blocking marks in SCENE metres (the calibrated scale): divided by the factor here. */
  marks?: readonly (readonly [number, number])[];
  tier?: 'full' | 'k500';
}

/** The ground field of a world dir (its world-asset.json's SPZ); null when no column holds ground. */
export async function groundField(
  worldDir: string,
  asset: WorldAsset,
  o: WorldFieldOptions = {},
): Promise<GroundField | null> {
  const { source, ...pts } = await fieldPoints(worldDir, asset, o.tier);
  const f = calibrationFactor(asset);
  const marks = o.marks?.map(([x, z]) => [x / f, z / f] as const);
  return buildGroundField(pts, { ...o, marks, source });
}

/** The world dir's stored field when it exists and is of the current rule version, else null. */
export async function storedGroundField(worldDir: string, asset: WorldAsset): Promise<GroundField | null> {
  if (!asset.ground) return null;
  try {
    const f = validateGroundField(JSON.parse(await readFile(join(worldDir, asset.ground.file), 'utf8')));
    return f.method?.startsWith(`previz ground ${GROUND_VERSION}:`) ? f : null;
  } catch {
    return null;
  }
}

/**
 * Measures the field and writes ground.json into the world dir; returns `asset` with
 * WorldAsset.ground pointing at it (without `ground` when nothing was measurable). Does not write
 * world-asset.json: the caller owns that file.
 */
export async function writeGroundField(
  worldDir: string,
  asset: WorldAsset,
  o: WorldFieldOptions & { log?: (m: string) => void } = {},
): Promise<WorldAsset> {
  const { ground: _old, ...rest } = asset;
  const t0 = Date.now();
  const field = await groundField(worldDir, asset, o);
  if (!field) {
    o.log?.('ground field: no column holds ground; actors stand on the median floor');
    return rest;
  }
  await writeFileAtomic(join(worldDir, GROUND_FILE), `${JSON.stringify(field)}\n`);
  const ref = groundRef(field);
  const hs = field.heights.filter((h): h is number => h !== null);
  o.log?.(
    `ground field: ${field.cols}×${field.rows} cells of ${field.cell} m, ${Math.round((100 * ref.covered) / ref.cells)} % with ground, ${Math.min(...hs).toFixed(2)}..${Math.max(...hs).toFixed(2)} m vs Marble's plane (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
  );
  return { ...rest, ground: ref };
}
