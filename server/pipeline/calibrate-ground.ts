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
// height, and floorOffsetMeters = -that (the viewer raises the world by it).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorldAsset } from '../../shared/schema.ts';
import { applyWorldTransform, calibrationFactor, worldTransform } from '../../web/src/viewer/transform.ts';
import { decodeSpz } from './spz.ts';

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
  const { splats } = decodeSpz(bytes);
  // Marble's declared frame and scale (floorOffsetMeters is stored at Marble's scale): neither a
  // stored floor offset nor the scale calibration moves what it is measured against
  const t = worldTransform({ ...asset, floorOffsetMeters: 0, scaleCalibration: null });
  const f = calibrationFactor(asset);
  const at = marks?.map(([x, z]) => [x / f, z / f] as const);
  const positions = new Float32Array(splats.length * 3);
  const opacities = new Float32Array(splats.length);
  splats.forEach((s, i) => {
    positions.set(applyWorldTransform(t, s.position), 3 * i);
    opacities[i] = s.opacity;
  });
  return measureGround(positions, opacities, probesFor(at));
}
