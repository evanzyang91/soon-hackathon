// Visual scale estimate: Claude looks at renders of the world with 1.70 m reference mannequins
// standing on its floor and, object by object (door, counter, chair seat, car, shelter roof,
// ceiling…), says how tall the object comes out next to the mannequins and what uniform correction
// of the WORLD would make it its typical real size. It also marks the object's floor-contact and
// top pixels; those two rays are cast into the world (base onto the collider floor, top onto the
// vertical line above that floor point: single-view metrology on the floor plane, the same way a
// door or a person standing on Marble's floor can be measured), which gives a perspective-correct
// height in Marble metres. A measured height wins over the eyeballed one when both rays land.
// Two independent requests on different views must agree before the estimate counts.
//
// Pure parts (view planning, pixel rays, prompt, schema, summarizing an answer) are unit-tested;
// the request itself is injectable (`VisionCall`).
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { env } from '../env.ts';
import type { ScaleFigure } from '../../web/src/viewer/dev/scale-shot.ts';
import { hasFloor, rayHit, spotBlocked, TriGrid } from '../../web/src/viewer/placement.ts';
import { median, weightedMedian, type RayCast } from './calibrate-geometry.ts';

export const VISION_MODEL = 'claude-opus-5-5';
/** USD per token (Claude Opus 5.5: $4 / MTok in, $20 / MTok out). */
export const PRICE = { input: 4 / 1e6, output: 20 / 1e6, cacheRead: 0.2 / 1e6, cacheWrite: 5 / 1e6 };

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface PlannedView {
  yawDeg: number;
  pitchDeg: number;
  fovDeg: number;
  camera: [number, number, number];
  figures: (ScaleFigure & { name: string; distance: number })[];
  /** close-up views: what the camera was sent to look at */
  closeupOf?: string;
}

/** Forward unit vector (xz) of a camera with rotation.y = yaw (yaw 0 looks down -Z). */
export const forward = (yawDeg: number): [number, number] => {
  const a = (yawDeg * Math.PI) / 180;
  return [-Math.sin(a), -Math.cos(a)];
};

/** Floor height under (x, z) from the collider (null where there is none within reach). */
export function floorAt(grid: TriGrid, x: number, z: number): number | null {
  const d = rayHit(grid.around(x, z, 0.1), [x, 1.2, z], [0, -1, 0], 2.4);
  return d === null ? null : 1.2 - d;
}

const standable = (grid: TriGrid, x: number, z: number) => {
  const local = grid.around(x, z);
  return hasFloor(local, x, z) && !spotBlocked(local, x, z, 'standing');
};

export interface ViewGeometry {
  grid: TriGrid;
  /** long-ray caster over the same triangles (calibrate-geometry RayGrid) */
  cast: RayCast;
  cameraY: number;
}

/**
 * Mannequins for one view: free, floored spots inside the view (±26° of its centre, feet and
 * head inside the frame) that the camera can see (nothing between the eye and the figure's chest), the first one nearest 2.5 m
 * (≥ 1.2 m in a small room), then up to two more, each 0.9–1.5 m deeper and at least 9° away
 * from the others in the frame (nobody stands behind anybody).
 * Feet go on the collider's floor at the spot.
 */
export const VIEW = { pitchDeg: -20, fovDeg: 84 };

/** Tilt that frames a 1.70 m figure (+ label) `distance` away feet to head, for this camera height. */
export function framingPitch(cameraY: number, distance = 2.4): number {
  const deg = (r: number) => (r * 180) / Math.PI;
  const p = (deg(Math.atan((1.85 - cameraY) / distance)) - deg(Math.atan(cameraY / distance))) / 2;
  return Math.max(-28, Math.min(-8, p));
}

export function planFigures(
  g: ViewGeometry,
  yawDeg: number,
  maxFigures = 3,
  view: { pitchDeg: number; fovDeg: number } = VIEW,
): PlannedView['figures'] {
  const cam = { yawDeg, ...view, camera: [0, g.cameraY, 0] as [number, number, number] };
  const inFrame = (p: [number, number, number]) => {
    const px = projectPoint(cam, p);
    return !!px && px[0] > 30 && px[0] < IMAGE.width - 30 && px[1] > 40 && px[1] < IMAGE.height - 20;
  };
  const cands: { x: number; z: number; y: number; d: number; ang: number }[] = [];
  for (let ang = -26; ang <= 26; ang += 6.5)
    for (let d = 1.2; d <= 9; d += 0.3) {
      const [fx, fz] = forward(yawDeg + ang);
      const x = fx * d;
      const z = fz * d;
      if (!standable(g.grid, x, z)) continue;
      const y = floorAt(g.grid, x, z);
      if (y === null) continue;
      // feet and head (with its label) both in the picture
      if (!inFrame([x, y, z]) || !inFrame([x, y + 1.85, z])) continue;
      // line of sight from the camera to the figure's chest
      const dx = x, dy = y + 1.2 - g.cameraY, dz = z;
      const len = Math.hypot(dx, dy, dz);
      const hit = g.cast([0, g.cameraY, 0], [dx / len, dy / len, dz / len], len);
      if (hit !== null && hit < len - 0.3) continue;
      cands.push({ x, z, y, d, ang });
    }
  const out: PlannedView['figures'] = [];
  const angs: number[] = [];
  const take = (c: (typeof cands)[number]) => {
    const name = 'ABCD'[out.length]!;
    out.push({ x: c.x, z: c.z, y: c.y, name, distance: c.d, label: name });
    angs.push(c.ang);
  };
  // A: near 2.5 m and near the middle of the frame
  const first = [...cands].sort(
    (a, b) => Math.abs(a.d - 2.5) + Math.abs(a.ang) / 20 - (Math.abs(b.d - 2.5) + Math.abs(b.ang) / 20),
  )[0];
  if (!first) return out;
  take(first);
  // B, C: deeper, never behind anybody already placed (≥ 9° apart), alternating sides
  for (const c of [...cands].sort((a, b) => a.d - b.d)) {
    if (out.length >= maxFigures) break;
    const last = out[out.length - 1]!;
    if (c.d < last.distance + (last.distance < 2.5 ? 0.9 : 1.5)) continue;
    if (angs.some((a) => Math.abs(a - c.ang) < 9)) continue;
    if (out.length === 1 && Math.abs(angs[0]!) > 4 && Math.sign(c.ang) === Math.sign(angs[0]!)) continue;
    take(c);
  }
  return out;
}

/** Median horizontal depth to the collider across a view at eye height (Infinity = open). */
export function viewDepth(g: ViewGeometry, yawDeg: number): number {
  const ds: number[] = [];
  for (let da = -30; da <= 30; da += 10) {
    const [fx, fz] = forward(yawDeg + da);
    ds.push(g.cast([0, g.cameraY, 0], [fx, 0, fz], 30) ?? Infinity);
  }
  return median(ds);
}

/**
 * Up to `count` views from the source camera: the main view, ±60°, then behind / ±120° / ±30°,
 * keeping only views that look at least 1.5 m into the scene and have room for a mannequin.
 */
export function planViews(
  g: ViewGeometry,
  count = 4,
  yaws = [0, 60, -60, 180, 120, -120, 30, -30],
): PlannedView[] {
  const out: PlannedView[] = [];
  // the standard framing, then a wider one for cramped rooms (free floor only ~1.5 m away)
  const framings = [
    { fovDeg: VIEW.fovDeg, pitchDeg: framingPitch(g.cameraY, 2.4) },
    { fovDeg: 100, pitchDeg: framingPitch(g.cameraY, 1.5) },
  ];
  for (const yawDeg of yaws) {
    if (out.length >= count) break;
    if (viewDepth(g, yawDeg) < 1.5) continue;
    for (const view of framings) {
      const figures = planFigures(g, yawDeg, 3, view);
      if (!figures.length) continue;
      out.push({ yawDeg, ...view, camera: [0, g.cameraY, 0], figures });
      break;
    }
  }
  return out;
}

/**
 * Close-ups for the third request: the standard objects the overview runs located on the floor
 * (sizeConfidence ≥ 0.6, base pixel on the floor), up to `max`, one view each. The camera stands
 * 3 m from the object on the source camera's side, 1.5 m above the floor there, with a 1.70 m
 * mannequin 0.8 m beside the object, both in frame; spots the collider says are blocked or
 * hidden are skipped.
 */
export function planCloseups(g: ViewGeometry, located: VisionRun['located'], max = 3): PlannedView[] {
  const seen: [number, number][] = [];
  const out: PlannedView[] = [];
  const cands = located
    .filter((o) => o.sizeConfidence >= 0.6)
    .sort((a, b) => b.sizeConfidence * b.pixelConfidence - a.sizeConfidence * a.pixelConfidence);
  for (const o of cands) {
    if (out.length >= max) break;
    const [ox, oy, oz] = o.base;
    if (seen.some(([x, z]) => Math.hypot(x - ox, z - oz) < 1.5)) continue;
    const toCam = Math.atan2(-ox, -oz); // bearing from the object back toward the source camera
    let view: PlannedView | null = null;
    for (const turn of [0, 0.5, -0.5, 1, -1]) {
      for (const dist of [3, 2.4, 3.6]) {
        const a = toCam + turn;
        const cx = ox + Math.sin(a) * dist;
        const cz = oz + Math.cos(a) * dist;
        const floor = floorAt(g.grid, cx, cz);
        if (floor === null || !standable(g.grid, cx, cz)) continue;
        const cam: [number, number, number] = [cx, floor + 1.5, cz];
        // mannequin 0.8 m to one side of the object, on free floor, visible from the camera
        const side = [Math.cos(a), -Math.sin(a)] as const;
        let fig: { x: number; z: number; y: number } | null = null;
        for (const sgn of [1, -1])
          for (const off of [0.8, 1.1, 0.6]) {
            if (fig) break;
            const fx = ox + side[0] * off * sgn;
            const fz = oz + side[1] * off * sgn;
            const fy = floorAt(g.grid, fx, fz);
            if (fy === null || !standable(g.grid, fx, fz)) continue;
            const dx = fx - cam[0], dy = fy + 1.2 - cam[1], dz = fz - cam[2];
            const len = Math.hypot(dx, dy, dz);
            const hit = g.cast(cam, [dx / len, dy / len, dz / len], len);
            if (hit !== null && hit < len - 0.3) continue;
            fig = { x: fx, z: fz, y: fy };
          }
        if (!fig) continue;
        // aim between object and mannequin, 1 m up
        const tx = (ox + fig.x) / 2 - cam[0];
        const ty = (oy + fig.y) / 2 + 1 - cam[1];
        const tz = (oz + fig.z) / 2 - cam[2];
        const v: PlannedView = {
          yawDeg: (Math.atan2(-tx, -tz) * 180) / Math.PI,
          pitchDeg: (Math.atan2(ty, Math.hypot(tx, tz)) * 180) / Math.PI,
          fovDeg: 75,
          camera: cam,
          figures: [{ ...fig, name: 'A', label: 'A', distance: Math.hypot(fig.x - cx, fig.z - cz) }],
          closeupOf: o.object.slice(0, 80),
        };
        const inFrame = (p: [number, number, number]) => {
          const px = projectPoint(v, p);
          return !!px && px[0] > 20 && px[0] < IMAGE.width - 20 && px[1] > 20 && px[1] < IMAGE.height - 10;
        };
        if (!inFrame([fig.x, fig.y, fig.z]) || !inFrame([fig.x, fig.y + 1.85, fig.z]) || !inFrame([ox, oy, oz])) continue;
        view = v;
        break;
      }
      if (view) break;
    }
    if (!view) continue;
    seen.push([ox, oz]);
    out.push(view);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pixel → ray, floor-contact height
// ---------------------------------------------------------------------------

export const IMAGE = { width: 1280, height: 720 };

/** World-space unit ray through pixel (px, py) of a view (three.js camera, rotation order YXZ). */
export function pixelRay(v: Pick<PlannedView, 'yawDeg' | 'pitchDeg' | 'fovDeg'>, px: number, py: number, size = IMAGE): [number, number, number] {
  const th = Math.tan((v.fovDeg * Math.PI) / 360);
  const tv = th * (size.height / size.width);
  const cx = ((2 * px) / size.width - 1) * th;
  const cy = (1 - (2 * py) / size.height) * tv;
  // camera space (x right, y up, -z forward) → pitch about X → yaw about Y
  const p = (v.pitchDeg * Math.PI) / 180;
  const dyp = cy * Math.cos(p) - -1 * Math.sin(p);
  const dzp = cy * Math.sin(p) + -1 * Math.cos(p);
  const a = (v.yawDeg * Math.PI) / 180;
  const dx = cx * Math.cos(a) + dzp * Math.sin(a);
  const dz = -cx * Math.sin(a) + dzp * Math.cos(a);
  const l = Math.hypot(dx, dyp, dz);
  return [dx / l, dyp / l, dz / l];
}

/** World point → pixel (inverse of pixelRay), or null behind the camera. */
export function projectPoint(v: Pick<PlannedView, 'yawDeg' | 'pitchDeg' | 'fovDeg' | 'camera'>, p: [number, number, number], size = IMAGE): [number, number] | null {
  const a = (v.yawDeg * Math.PI) / 180;
  const pitch = (v.pitchDeg * Math.PI) / 180;
  const wx = p[0] - v.camera[0], wy = p[1] - v.camera[1], wz = p[2] - v.camera[2];
  // undo yaw, then pitch
  const x1 = wx * Math.cos(a) - wz * Math.sin(a);
  const z1 = wx * Math.sin(a) + wz * Math.cos(a);
  const y2 = wy * Math.cos(pitch) + z1 * Math.sin(pitch);
  const z2 = -wy * Math.sin(pitch) + z1 * Math.cos(pitch);
  if (z2 >= -1e-6) return null;
  const th = Math.tan((v.fovDeg * Math.PI) / 360);
  const tv = th * (size.height / size.width);
  return [((x1 / -z2 / th + 1) * size.width) / 2, ((1 - y2 / -z2 / tv) * size.height) / 2];
}

export interface PixelMeasure {
  ok: boolean;
  height: number;
  distance: number;
  note: string;
  /** the floor point under the object (world metres) once the base pixel landed on the floor */
  base?: [number, number, number];
}

/**
 * Height of a vertical thing from two pixels: the base ray must hit the world (its floor) within
 * 40 m; the height is where the top ray passes the vertical line through that floor point.
 */
export function measureFromPixels(
  v: PlannedView,
  cast: RayCast,
  base: { x: number; y: number },
  top: { x: number; y: number },
): PixelMeasure {
  const span = Math.hypot(base.x - top.x, base.y - top.y);
  if (span < 25) return { ok: false, height: NaN, distance: NaN, note: `only ${span.toFixed(0)} px tall` };
  const db = pixelRay(v, base.x, base.y);
  const hit = cast(v.camera, db, 40);
  if (hit === null) return { ok: false, height: NaN, distance: NaN, note: 'base ray hits nothing' };
  const B = [v.camera[0] + db[0] * hit, v.camera[1] + db[1] * hit, v.camera[2] + db[2] * hit];
  // the base must be ON the floor, not on the front of a counter or a chair in the way: probe
  // straight down from 0.3 m above it (a step back toward the camera) and expect the floor there
  const hl = Math.hypot(db[0], db[2]) || 1;
  const px = B[0]! - (db[0] / hl) * 0.05;
  const pz = B[2]! - (db[2] / hl) * 0.05;
  const down = cast([px, B[1]! + 0.3, pz], [0, -1, 0], 1);
  if (down === null || Math.abs(down - 0.3) > 0.12)
    return { ok: false, height: NaN, distance: NaN, note: 'base pixel is not on the floor' };
  const floorPt: [number, number, number] = [B[0]!, B[1]!, B[2]!];
  const dt = pixelRay(v, top.x, top.y);
  const hz = dt[0] * dt[0] + dt[2] * dt[2];
  const t = ((B[0]! - v.camera[0]) * dt[0] + (B[2]! - v.camera[2]) * dt[2]) / hz;
  const miss = Math.hypot(v.camera[0] + dt[0] * t - B[0]!, v.camera[2] + dt[2] * t - B[2]!);
  const distance = Math.hypot(B[0]! - v.camera[0], B[2]! - v.camera[2]);
  const height = v.camera[1] + dt[1] * t - B[1]!;
  if (!(t > 0) || miss > Math.max(0.3, 0.1 * distance))
    return { ok: false, height, distance, base: floorPt, note: `top and base are not one vertical line (${miss.toFixed(2)} m apart)` };
  if (!(height > 0.05)) return { ok: false, height, distance, base: floorPt, note: 'top is not above the base' };
  return { ok: true, height, distance, base: floorPt, note: `${height.toFixed(2)} m tall at ${distance.toFixed(1)} m` };
}

// ---------------------------------------------------------------------------
// Prompt and answer
// ---------------------------------------------------------------------------

export const VISION_SYSTEM = `You check the real-world scale of 3D scene reconstructions. Each image is a ${IMAGE.width}×${IMAGE.height} render of a reconstructed place with bright orange reference mannequins standing on its floor. Every mannequin is exactly 1.70 m tall (an average adult) and stands with its feet on the ground at its spot; they are labelled A (nearest the camera), B, C (farthest). The mannequins are correct by definition. The reconstruction around them may be uniformly too big or too small.

Your job: estimate the single uniform scale correction for the WORLD that would make the things in it their normal real-world size next to the 1.70 m mannequins.

Method, for each image:
1. Find up to 5 everyday objects whose real size is standard and that you can see clearly, best first: an interior or exterior door (leaf/opening about 2.0-2.1 m tall), a kitchen counter or work top (0.90 m), a dining table top (0.75 m), a chair or bench seat (0.45 m), a ceiling (2.4-3.0 m in homes), a car roof (about 1.45 m, SUV 1.7 m), a bus shelter roof (about 2.5 m), a parapet or railing top (0.9-1.1 m, low parapets 0.5-0.9 m), a window sill (about 0.9 m), a stair riser (0.18 m), a storey of a building (about 3 m, weak). Prefer objects that stand on the same floor as the mannequins and whose bottom you can see.
2. Compare each object with the mannequin nearest to it in DEPTH (distance from the camera), using where both meet the floor. Objects farther than the farthest mannequin need perspective reasoning; lower your confidence for them. Ignore objects that are blurry, cut off, or whose base you cannot locate.
3. Say how tall the object comes out if that mannequin is 1.70 m ("apparentMeters"), and give the correction = typicalMeters / apparentMeters. correction > 1 means the world is too SMALL (objects look short next to the mannequins) and must be scaled up; < 1 means it is too BIG. Example: a door that reaches only just above mannequin A's head (about 1.8 m) gives 2.04 / 1.8 = 1.13.
4. Mark the measured dimension in pixels (x right, y down, origin at the image's top-left corner): "basePx" is the point on the FLOOR directly below the top (the door threshold, the floor at the foot of the counter's front face, the ground under the seat's front edge, the floor under the ceiling point), "topPx" the top of the dimension straight above it (top of the door opening, the counter's front top edge, the seat's front edge, the ceiling). Both points must be visible; be precise: these pixels are measured with the scene's 3D geometry, which handles perspective exactly, so an object far beyond the mannequins is still useful if you can place its two points well.
5. Rate each object three ways (0 to 1): "sizeConfidence", how standard its real size is and how sure you are what it is (a door or counter about 0.9, a dining table 0.8, a chair seat 0.7, a parapet 0.4, an ad panel or a storey 0.3); "pixelConfidence", how precisely you placed basePx and topPx (both sharp and visible: high; base hidden or guessed: low); "confidence", how much you trust your eyeballed comparison with the mannequin.
6. Note how the mannequins meet the floor (feet on it, floating above it, sunk into it). A mannequin can stand behind thin things the placement could not see (glass, an ad panel, a bench); its letter label is drawn on top of everything, so a label without a visible body means that mannequin is hidden.

Be quantitative and honest. A wrong reference is worse than none: give low confidence to anything uncertain, and an empty object list if nothing qualifies.`;

const Px = z.object({ x: z.number(), y: z.number() });

export const VisionAnswer = z.object({
  objects: z.array(
    z.object({
      image: z.number().int().describe('1-based index of the image the object is in'),
      object: z.string().describe('what it is, e.g. "closed interior door left of the stove"'),
      dimension: z.string().describe('which dimension, e.g. "door opening height, floor to top"'),
      typicalMeters: z.number().describe('its standard real-world size in metres'),
      comparedTo: z.string().describe('which mannequin it was compared with'),
      apparentMeters: z.number().describe('its size if that mannequin is 1.70 m tall'),
      correction: z.number().describe('typicalMeters / apparentMeters'),
      basePx: Px.describe('floor point directly below the top of the dimension, in image pixels'),
      topPx: Px.describe('top of the dimension, in image pixels'),
      sizeConfidence: z.number().describe('0 to 1: how standard its size is / how sure what it is'),
      pixelConfidence: z.number().describe('0 to 1: how precisely basePx and topPx are placed'),
      confidence: z.number().describe('0 to 1: trust in the eyeballed comparison with the mannequin'),
      reasoning: z.string(),
    }),
  ),
  floorContact: z.string().describe('how the mannequins meet the floor in each image'),
  overallCorrection: z.number().describe('your best single uniform world correction'),
  confidence: z.number().describe('0 to 1, for overallCorrection'),
  notes: z.string(),
});
export type VisionAnswer = z.infer<typeof VisionAnswer>;

export type VisionObject = VisionAnswer['objects'][number] & {
  /** floor-contact metrology from basePx/topPx (Marble metres) */
  measured?: PixelMeasure;
  /** the correction this object votes with (typical / measured height, else the eyeballed one) */
  vote: number;
  weight: number;
  source: 'measured' | 'eyeballed';
};

export interface VisionRun {
  views: number[];
  /** weighted median of the per-object votes (NaN when none qualified) */
  factor: number;
  /** eyeballed-only factor (Claude's apparent heights vs the mannequins), for comparison */
  eyeballed: number;
  objects: VisionObject[];
  /** every named object whose base pixel landed on the floor (close-up candidates) */
  located: { object: string; sizeConfidence: number; pixelConfidence: number; base: [number, number, number] }[];
  answer: VisionAnswer;
  usage: { input: number; output: number; costUsd: number };
}

/**
 * Per-object votes → one number. A pixel-measured object votes typical / measured height with
 * weight sizeConfidence × pixelConfidence; otherwise (or when the measurement is more than 40 %
 * off Claude's own eyeballed height, i.e. a pixel landed on something else) it votes its
 * eyeballed correction with weight 0.6 × sizeConfidence × confidence. Weights under 0.1 and votes
 * outside [0.33, 3] are dropped.
 */
export function summarizeAnswer(
  a: VisionAnswer,
  measure?: (o: VisionAnswer['objects'][number]) => PixelMeasure | undefined,
): { factor: number; eyeballed: number; objects: VisionObject[] } {
  const objects: VisionObject[] = [];
  const c01 = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
  for (const o of a.objects) {
    if (!(o.typicalMeters > 0)) continue;
    const m = measure?.(o);
    const eyeOk =
      o.apparentMeters > 0 &&
      // the stated correction must match its own numbers (guards against a flipped ratio)
      Math.abs(o.correction / (o.typicalMeters / o.apparentMeters) - 1) < 0.08;
    const sane = m?.ok && (!eyeOk || Math.abs(m.height / o.apparentMeters - 1) <= 0.4);
    let vote: number;
    let weight: number;
    let source: VisionObject['source'];
    if (sane) [vote, weight, source] = [o.typicalMeters / m!.height, c01(o.sizeConfidence) * c01(o.pixelConfidence), 'measured'];
    else if (eyeOk)
      [vote, weight, source] = [o.typicalMeters / o.apparentMeters, 0.6 * c01(o.sizeConfidence) * c01(o.confidence), 'eyeballed'];
    else continue;
    if (weight < 0.1 || !(vote > 0.33 && vote < 3)) continue;
    objects.push({ ...o, measured: m, vote, weight, source });
  }
  const eyes = a.objects.filter(
    (o) => o.apparentMeters > 0 && o.typicalMeters > 0 && o.confidence >= 0.3,
  );
  return {
    factor: objects.length ? weightedMedian(objects.map((o) => o.vote), objects.map((o) => o.weight)) : NaN,
    eyeballed: eyes.length
      ? weightedMedian(eyes.map((o) => o.typicalMeters / o.apparentMeters), eyes.map((o) => o.confidence))
      : NaN,
    objects,
  };
}

export function visionUserText(views: PlannedView[]): string {
  const lines = views.map((v, i) => {
    if (v.closeupOf)
      return `Image ${i + 1}: close-up of the ${v.closeupOf} (found in an earlier view); mannequin A stands beside it at about the same distance from the camera, so compare them directly.`;
    const who = v.figures.length ? v.figures.map((f) => f.name).join(', ') : 'none could be placed';
    return `Image ${i + 1}: camera turned ${v.yawDeg}° from the scene's main view, tilted ${-v.pitchDeg}° down, ${v.fovDeg}° wide; mannequins ${who}.`;
  });
  return `${lines.join('\n')}\n\nEstimate the world's scale correction as described, with pixel endpoints for every object.`;
}

export interface VisionImage {
  jpeg: Buffer;
}

export type VisionCall = (req: {
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  schema: Record<string, unknown>;
}) => Promise<Anthropic.Beta.BetaMessage>;

const defaultCall: VisionCall = async ({ system, content, schema }) => {
  const client = new Anthropic({ apiKey: env.keys.anthropic });
  const stream = client.beta.messages.stream({
    model: VISION_MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content }],
  });
  return stream.finalMessage();
};

export function costOf(u: Anthropic.Beta.BetaUsage | undefined): VisionRun['usage'] {
  const input = (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);
  const output = u?.output_tokens ?? 0;
  const costUsd =
    (u?.input_tokens ?? 0) * PRICE.input +
    (u?.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite +
    (u?.cache_read_input_tokens ?? 0) * PRICE.cacheRead +
    output * PRICE.output;
  return { input, output, costUsd };
}

/** One request: these views' images → Claude → per-object votes (pixels measured with `cast`). */
export async function askVision(
  views: PlannedView[],
  images: VisionImage[],
  viewIndices: number[],
  o: { call?: VisionCall; cast?: RayCast } = {},
): Promise<VisionRun> {
  const schema = betaZodOutputFormat(VisionAnswer).schema as Record<string, unknown>;
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  images.forEach((im, i) => {
    content.push({ type: 'text', text: `Image ${i + 1}:` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: im.jpeg.toString('base64') },
    });
  });
  content.push({ type: 'text', text: visionUserText(views) });
  const msg = await (o.call ?? defaultCall)({ system: VISION_SYSTEM, content, schema });
  if (msg.stop_reason === 'refusal') throw new Error('vision request was declined');
  if (msg.stop_reason === 'max_tokens') throw new Error('vision answer was cut off (max_tokens)');
  const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const answer = VisionAnswer.parse(JSON.parse(text));
  const cast = o.cast;
  const measures = answer.objects.map((obj) => {
    const v = views[obj.image - 1];
    return v && cast ? measureFromPixels(v, cast, obj.basePx, obj.topPx) : undefined;
  });
  const { factor, eyeballed, objects } = summarizeAnswer(answer, (obj) => measures[answer.objects.indexOf(obj)]);
  const located = answer.objects.flatMap((obj, i) => {
    const b = measures[i]?.base;
    return b ? [{ object: obj.object, sizeConfidence: obj.sizeConfidence, pixelConfidence: obj.pixelConfidence, base: b }] : [];
  });
  return { views: viewIndices, factor, eyeballed, objects, located, answer, usage: costOf(msg.usage) };
}

export interface VisionEstimate {
  available: boolean;
  /** weighted median of the object votes of the agreeing runs */
  factor: number;
  runs: VisionRun[];
  /** indices of the runs that agree (within `tolerance` of each other) */
  agreeing: number[];
  /** max/min − 1 over the agreeing runs */
  spread: number;
  agree: boolean;
  costUsd: number;
  note: string;
}

/**
 * Runs → one estimate. At least two runs must agree within `tolerance` (15 %): of the run subsets
 * that agree pairwise, the one carrying the most object weight wins. Its objects must also carry
 * enough evidence: total weight ≥ 0.8 and one reference ≥ 0.4 (a standard object measured
 * cleanly). The factor is the weighted median of those objects' votes.
 */
export function combineRuns(runs: VisionRun[], tolerance = 0.15): VisionEstimate {
  const costUsd = runs.reduce((s, r) => s + r.usage.costUsd, 0);
  const idx = runs.map((r, i) => i).filter((i) => Number.isFinite(runs[i]!.factor));
  const w = (ii: number[]) => ii.reduce((s, i) => s + runs[i]!.objects.reduce((t, o) => t + o.weight, 0), 0);
  const fmt = (ii: number[]) => ii.map((i) => `×${runs[i]!.factor.toFixed(2)}`).join(', ');
  const base = { runs, costUsd };
  if (!idx.length)
    return { ...base, available: false, factor: NaN, agreeing: [], spread: NaN, agree: false, note: 'no usable reference objects' };
  let best: number[] = [];
  for (let mask = 1; mask < 1 << idx.length; mask++) {
    const sub = idx.filter((_, k) => mask & (1 << k));
    if (sub.length < 2) continue;
    const fs = sub.map((i) => runs[i]!.factor);
    if (Math.max(...fs) / Math.min(...fs) - 1 > tolerance) continue;
    if (sub.length > best.length || (sub.length === best.length && w(sub) > w(best))) best = sub;
  }
  const pool = (ii: number[]) => ii.flatMap((i) => runs[i]!.objects);
  if (!best.length) {
    const all = pool(idx);
    const factor = weightedMedian(all.map((o) => o.vote), all.map((o) => o.weight));
    return {
      ...base,
      available: false,
      factor,
      agreeing: [],
      spread: idx.length > 1 ? Math.max(...idx.map((i) => runs[i]!.factor)) / Math.min(...idx.map((i) => runs[i]!.factor)) - 1 : NaN,
      agree: false,
      note: idx.length < 2 ? `only one run found usable references (${fmt(idx)})` : `the runs disagree (${fmt(idx)})`,
    };
  }
  const objs = pool(best);
  const factor = weightedMedian(objs.map((o) => o.vote), objs.map((o) => o.weight));
  const fs = best.map((i) => runs[i]!.factor);
  const spread = Math.max(...fs) / Math.min(...fs) - 1;
  const total = objs.reduce((s, o) => s + o.weight, 0);
  const strongest = Math.max(...objs.map((o) => o.weight));
  const enough = total >= 0.8 && strongest >= 0.4;
  const measured = objs.filter((o) => o.source === 'measured').length;
  const which = best.map((i) => (i < 2 ? `overview ${i + 1}` : 'close-up')).join(' + ');
  return {
    ...base,
    available: enough,
    factor,
    agreeing: best,
    spread,
    agree: true,
    note: `${which} agree within ${(spread * 100).toFixed(0)}% (${fmt(best)}; ${objs.length} objects, ${measured} measured from pixels, weight ${total.toFixed(2)})${enough ? '' : `: too little evidence (needs total ≥ 0.8 and one reference ≥ 0.4, strongest ${strongest.toFixed(2)})`}`,
  };
}
