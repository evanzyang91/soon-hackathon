// Ground height field: where the visible ground is, per xz cell, measured from the world's splats
// by server/pipeline/calibrate-ground.ts and sampled by the viewer so every actor's feet land on
// the ground at its own spot (a curb, a slope, a step), not on the one median height that
// WorldAsset.floorOffsetMeters encodes. Referenced from WorldAsset.ground.
//
// Frame: the viewer's Y-up frame with Marble's source camera at the origin, at Marble's scale
// (calibration factor 1, no floor raise), i.e. `applyWorldTransform(worldTransform({...asset,
// scaleCalibration: undefined, floorOffsetMeters: undefined}), raw)`. Heights are metres relative
// to Marble's declared ground plane (y = 0 in that frame): the median ground at the blocking
// marks is therefore at -floorOffsetMeters. `feetY` converts a sampled height to the y the viewer
// renders the world at: the world is scaled about the declared plane by the calibration factor and
// then raised by factor × floorOffsetMeters, so a ground height h lands at factor × (h + offset).
import { z } from 'zod';

export const GROUND_FIELD_SCHEMA = 'previz.ground-field/1';

export const GroundField = z.object({
  schema: z.literal(GROUND_FIELD_SCHEMA),
  /** Min corner (x, z) of cell (0, 0), metres. Cell (i, k) is centred at origin + (i + 0.5, k + 0.5) × cell. */
  origin: z.tuple([z.number(), z.number()]),
  /** Cell size, metres (0.2–0.25 is enough for feet). */
  cell: z.number().positive(),
  /** Columns along +x. */
  cols: z.number().int().positive(),
  /** Rows along +z. */
  rows: z.number().int().positive(),
  /**
   * Row-major (index = row × cols + col): ground height relative to Marble's declared plane,
   * metres at Marble's scale; null where the column holds no ground (a wall, a counter top,
   * open sky, outside the capture).
   */
  heights: z.array(z.number().nullable()),
  /** Opaque splats that formed each cell's ground layer (same layout), for confidence. */
  counts: z.array(z.number().int().nonnegative()).optional(),
  /** How it was measured, for the Scene tab tooltip. */
  method: z.string().optional(),
});
export type GroundField = z.infer<typeof GroundField>;

export function validateGroundField(data: unknown): GroundField {
  const f = GroundField.parse(data);
  if (f.heights.length !== f.cols * f.rows)
    throw new Error(`ground field: ${f.heights.length} heights for ${f.cols}×${f.rows} cells`);
  if (f.counts && f.counts.length !== f.heights.length)
    throw new Error('ground field: counts and heights differ in length');
  return f;
}

/** Height of cell (i, k), or null when outside the field or without ground data. */
export function cellHeight(f: GroundField, i: number, k: number): number | null {
  if (i < 0 || k < 0 || i >= f.cols || k >= f.rows) return null;
  const h = f.heights[k * f.cols + i];
  return typeof h === 'number' && Number.isFinite(h) ? h : null;
}

/**
 * Ground height under (x, z): bilinear over the four surrounding cell centres when all four hold
 * ground, else the mean of those that do, else the nearest cell with ground within `reach` cells
 * (an actor's spot next to a wall still gets the floor beside it), else null.
 */
export function sampleGround(f: GroundField, x: number, z: number, reach = 2): number | null {
  const u = (x - f.origin[0]) / f.cell - 0.5;
  const v = (z - f.origin[1]) / f.cell - 0.5;
  const i0 = Math.floor(u);
  const k0 = Math.floor(v);
  const fu = u - i0;
  const fv = v - k0;
  const corners: [number, number, number][] = [
    [i0, k0, (1 - fu) * (1 - fv)],
    [i0 + 1, k0, fu * (1 - fv)],
    [i0, k0 + 1, (1 - fu) * fv],
    [i0 + 1, k0 + 1, fu * fv],
  ];
  let sum = 0;
  let wsum = 0;
  let valid = 0;
  for (const [i, k, w] of corners) {
    const h = cellHeight(f, i, k);
    if (h === null) continue;
    valid++;
    sum += h * w;
    wsum += w;
  }
  if (valid === 4) return sum;
  if (valid > 0 && wsum > 1e-6) return sum / wsum;
  // nearest cell with ground, by cell distance, within reach
  const ci = Math.round(u);
  const ck = Math.round(v);
  let best: number | null = null;
  let bestD = Infinity;
  for (let dk = -reach; dk <= reach; dk++)
    for (let di = -reach; di <= reach; di++) {
      const h = cellHeight(f, ci + di, ck + dk);
      if (h === null) continue;
      const d = di * di + dk * dk;
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
  return best;
}

/** What the viewer needs to turn a ground height into the y it renders the world at. */
export interface GroundFrame {
  /** WorldAsset.scaleCalibration.factor, validated (web/src/viewer/transform.ts calibrationFactor). */
  factor: number;
  /** WorldAsset.floorOffsetMeters, validated (web/src/viewer/transform.ts floorOffset). */
  floorOffset: number;
}

/**
 * The y to put an actor's feet at (x, z): the sampled ground in the viewer's frame, or 0 (the
 * world's median floor, where it is already raised to) when the field has nothing there.
 */
export function feetY(f: GroundField | null | undefined, frame: GroundFrame, x: number, z: number): number {
  if (!f) return 0;
  const h = sampleGround(f, x, z);
  return h === null ? 0 : frame.factor * (h + frame.floorOffset);
}
