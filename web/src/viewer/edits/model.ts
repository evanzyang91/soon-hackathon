// Pure scene-edit model shared by the viewer (apply.ts, select.ts) and the server planner
// (server/pipeline/reprompt/**): effective look / transforms / props from a SceneEdits document,
// and the geometry that turns a SplatRegionEdit into Spark SplatEdit SDFs. No three.js, no DOM.
//
// Look edits are baked: a re-prompt look op is merged into SceneEdits.look on the server (the look
// pipeline renders SceneEdits.look, and the director's look panel keeps editing that same look),
// the op stays in `edits` as the record, and the values it replaced are kept in its history entry
// as a disabled look op with id `<opId>.before` (`lookBefore`). Switching the op off restores them
// (`revertLookPatch`), switching it on merges it again.
//
// Look patches (shared/look.ts LookPatch) are defaults-free deep partials: a stored patch holds
// exactly the values the edit set, so a value equal to its default (exposure back to 0) is a real
// instruction and survives the parse. `patchEntries` only drops undefined / empty groups.
import { defaultLook, type EditPlan, type Look, type LookPatch, type SceneEdit, type SceneEdits } from '@shared/look';
import type { DynamicElement, Vec3 } from '@shared/schema';

export type RegionEdit = Extract<SceneEdit, { kind: 'splat-region' }>;
export type TransformEdit = Extract<SceneEdit, { kind: 'transform' }>;
export type LookEdit = Extract<SceneEdit, { kind: 'look' }>;
export type PropAddEdit = Extract<SceneEdit, { kind: 'prop-add' }>;
export type { LookPatch };

const DEFAULT_LOOK = defaultLook();
const NESTED = ['fog', 'skyTint', 'dof'] as const;
type Nested = (typeof NESTED)[number];

// ---------------------------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------------------------

/** The values a patch really sets: undefined entries, empty nested groups and an empty lights list are dropped. */
export function patchEntries(patch: LookPatch): LookPatch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if ((NESTED as readonly string[]).includes(k)) {
      const inner: Record<string, unknown> = {};
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) if (iv !== undefined) inner[ik] = iv;
      if (Object.keys(inner).length) out[k] = inner;
    } else if (k === 'lights') {
      if (Array.isArray(v) && v.length) out[k] = v;
    } else out[k] = v;
  }
  return out as LookPatch;
}

/** `base` with a patch applied: nested groups merge per field, lights are upserted by id. */
export function mergeLook(base: Look, patch: LookPatch): Look {
  const p = patchEntries(patch) as Record<string, unknown>;
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    if ((NESTED as readonly string[]).includes(k)) out[k] = { ...(out[k] as object), ...(v as object) };
    else if (k === 'lights') {
      const lights = [...base.lights];
      for (const l of v as Look['lights']) {
        const i = lights.findIndex((x) => x.id === l.id);
        if (i >= 0) lights[i] = l;
        else lights.push(l);
      }
      out.lights = lights;
    } else out[k] = v;
  }
  return out as Look;
}

/**
 * What `patch` would replace in `look`: the current values of exactly the fields it sets (lights:
 * the current versions of the lights it upserts, none for new ones). Stored with the op so
 * switching it off can restore them.
 */
export function lookBefore(look: Look, patch: LookPatch): LookPatch {
  const p = patchEntries(patch) as Record<string, unknown>;
  const cur = look as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if ((NESTED as readonly string[]).includes(k)) {
      const inner: Record<string, unknown> = {};
      for (const ik of Object.keys(v as object)) inner[ik] = (cur[k] as Record<string, unknown>)[ik];
      out[k] = inner;
    } else if (k === 'lights') {
      const prev = (v as Look['lights']).map((l) => look.lights.find((x) => x.id === l.id)).filter((l) => !!l);
      if (prev.length) out.lights = prev;
    } else out[k] = cur[k];
  }
  return out as LookPatch;
}

/**
 * `look` with an op switched off: the fields it set go back to `before` (from lookBefore), the
 * lights it added are removed (lights it changed go back to their earlier version).
 */
export function revertLookPatch(look: Look, patch: LookPatch, before: LookPatch): Look {
  const p = patchEntries(patch) as Record<string, unknown>;
  const b = before as Record<string, unknown>;
  const out = structuredClone(look) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    if ((NESTED as readonly string[]).includes(k)) {
      const inner = { ...(out[k] as Record<string, unknown>) };
      for (const ik of Object.keys(v as object)) {
        const prev = (b[k] as Record<string, unknown> | undefined)?.[ik];
        inner[ik] = prev !== undefined ? prev : (DEFAULT_LOOK[k as Nested] as Record<string, unknown>)[ik];
      }
      out[k] = inner;
    } else if (k === 'lights') {
      const ids = new Set((v as Look['lights']).map((l) => l.id));
      const prevLights = (b.lights as Look['lights'] | undefined) ?? [];
      out.lights = (out.lights as Look['lights'])
        .filter((l) => !ids.has(l.id) || prevLights.some((x) => x.id === l.id))
        .map((l) => prevLights.find((x) => x.id === l.id) ?? l);
    } else out[k] = b[k] !== undefined ? b[k] : (DEFAULT_LOOK as Record<string, unknown>)[k];
  }
  return out as unknown as Look;
}

/** Id of the history op that holds what a look op replaced. */
export const beforeId = (opId: string) => `${opId}.before`;

/**
 * `doc` with `ops` applied (no revision bump: the store does that): ops are appended, look ops
 * are baked into `look`, and one history entry records the prompt, the plan, the applied op ids
 * and — for look ops — what they replaced (disabled `<opId>.before` look ops in the plan).
 */
export function appendOps(
  doc: SceneEdits,
  ops: SceneEdit[],
  entry: { prompt: string; plan: EditPlan; at?: string },
): SceneEdits {
  let look = doc.look;
  const befores: SceneEdit[] = [];
  for (const op of ops) {
    if (op.kind !== 'look' || !op.enabled) continue;
    befores.push({ kind: 'look', id: beforeId(op.id), patch: lookBefore(look, op.patch), enabled: false });
    look = mergeLook(look, op.patch);
  }
  return {
    ...doc,
    look,
    edits: [...doc.edits, ...ops],
    history: [
      ...doc.history,
      {
        at: entry.at ?? new Date().toISOString(),
        prompt: entry.prompt,
        plan: { ...entry.plan, ops: [...entry.plan.ops, ...befores] },
        appliedOpIds: ops.map((o) => o.id),
      },
    ],
  };
}

/** The "before" values history recorded for a look op (empty when unknown). */
export function beforeOf(doc: SceneEdits, opId: string): LookPatch {
  for (const h of doc.history) {
    const b = h.plan.ops.find((o) => o.id === beforeId(opId));
    if (b?.kind === 'look') return b.patch;
  }
  return {};
}

/** `doc` with one op switched on or off (a look op is reverted / merged again into `look`). */
export function setOpEnabled(doc: SceneEdits, opId: string, enabled: boolean): SceneEdits {
  const op = doc.edits.find((e) => e.id === opId);
  if (!op || op.enabled === enabled) return doc;
  let look = doc.look;
  if (op.kind === 'look') look = enabled ? mergeLook(look, op.patch) : revertLookPatch(look, op.patch, beforeOf(doc, opId));
  return { ...doc, look, edits: doc.edits.map((e) => (e.id === opId ? { ...e, enabled } : e)) };
}

/** `doc` without one op (an enabled look op is reverted first). History is kept. */
export function removeOp(doc: SceneEdits, opId: string): SceneEdits {
  const off = setOpEnabled(doc, opId, false);
  return { ...off, edits: off.edits.filter((e) => e.id !== opId) };
}

// ---------------------------------------------------------------------------------------------
// Transforms and props
// ---------------------------------------------------------------------------------------------

export interface TargetTransform {
  position?: Vec3;
  yaw?: number;
  scale?: number;
}
export const targetKey = (t: TransformEdit['target']) => `${t.type}:${t.id}`;

/** Per target ("actor:leo"), the latest enabled value of each transform field. */
export function effectiveTransforms(edits: readonly SceneEdit[]): Map<string, TargetTransform> {
  const out = new Map<string, TargetTransform>();
  for (const e of edits) {
    if (e.kind !== 'transform' || !e.enabled) continue;
    const t = out.get(targetKey(e.target)) ?? {};
    if (e.position) t.position = e.position;
    if (e.yaw !== undefined) t.yaw = e.yaw;
    if (e.scale !== undefined) t.scale = e.scale;
    out.set(targetKey(e.target), t);
  }
  return out;
}

export interface EffectiveProps {
  /** Elements added by enabled prop-add edits that no later prop-remove removed. */
  added: DynamicElement[];
  /** Ids of base or added elements removed by an enabled prop-remove. */
  removed: Set<string>;
}

export function effectiveProps(edits: readonly SceneEdit[]): EffectiveProps {
  const added: DynamicElement[] = [];
  const removed = new Set<string>();
  for (const e of edits) {
    if (!e.enabled) continue;
    if (e.kind === 'prop-add') added.push(e.element);
    else if (e.kind === 'prop-remove') removed.add(e.elementId);
  }
  return { added: added.filter((a) => !removed.has(a.id)), removed };
}

/** Path length in metres. */
export function pathLength(path: readonly Vec3[]): number {
  let n = 0;
  for (let i = 1; i < path.length; i++)
    n += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1], path[i]![2] - path[i - 1]![2]);
  return n;
}

/** A prop whose path is shorter than 10 cm stands still at path[0], facing path[1]. */
export const isParked = (el: Pick<DynamicElement, 'path'>) => pathLength(el.path) < 0.1;

// ---------------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------------

export type RGB = [number, number, number];
/** Rec. 709 luma on display-referred values (splat colours are stored sRGB-encoded). */
export const luma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return [1, 1, 1];
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Largest channel gain a hue multiply may use (dark target hues would otherwise blow out). */
export const MAX_HUE_GAIN = 4;

/**
 * Spark has no hue blend (multiply / set_rgb / add_rgba only), so `hue` is a luminance-keeping
 * multiply: factor = target / luma(target), so a neutral splat (r = g = b) takes the target's hue
 * at its own brightness. Saturated splats of another hue darken instead of re-hueing, and gains
 * are capped at MAX_HUE_GAIN.
 */
export function hueMultiplier(targetHex: string, strength = 1): RGB {
  const t = hexToRgb(targetHex);
  const l = Math.max(luma(t), 1e-3);
  return t.map((c) => lerp(1, Math.min(MAX_HUE_GAIN, c / l), strength)) as RGB;
}

export const multiplyColor = (targetHex: string, strength = 1): RGB =>
  hexToRgb(targetHex).map((c) => lerp(1, c, strength)) as RGB;

// ---------------------------------------------------------------------------------------------
// Region → Spark SplatEdit specs (world metres)
// ---------------------------------------------------------------------------------------------

export interface SdfSpec {
  type: 'sphere' | 'box';
  center: Vec3;
  /** Sphere radius (0 for boxes). */
  radius: number;
  /** Box half-extents (ignored for spheres). */
  halfExtents: Vec3;
  /** Rotation about +Y, radians. */
  yaw: number;
  displace: Vec3;
}

export interface SplatEditSpec {
  /** Which part of the region edit this is (colour/opacity, scale field, move). */
  role: 'color' | 'scale' | 'move';
  blend: 'multiply' | 'set_rgb';
  /** sdf colour (multiply factor or the colour that is set), display-referred 0..∞ */
  rgb: RGB;
  opacity: number;
  /** Spark softEdge: the transition width in metres, centred on the SDF surface. */
  softEdge: number;
  sdfSmooth: number;
  sdfs: SdfSpec[];
}

/** Sphere radius, or the smallest box half-extent: what `softEdge` is a fraction of. */
export function regionScale(r: Pick<RegionEdit, 'shape' | 'size'>): number {
  return r.shape === 'sphere' ? Math.abs(r.size[0]) : Math.min(...r.size.map(Math.abs));
}

/** Transition width in metres for a region's `softEdge` (a fraction of its size). */
export const softEdgeMeters = (r: Pick<RegionEdit, 'shape' | 'size' | 'softEdge'>) =>
  Math.max(0, Math.min(1, r.softEdge ?? 0)) * regionScale(r);

/**
 * The region's SDF, shrunk by half the soft edge so the whole transition lies inside the region:
 * splats outside it are never touched (Spark centres the soft edge on the SDF surface).
 */
export function regionSdf(r: RegionEdit, grow = 1, displace: Vec3 = [0, 0, 0]): SdfSpec {
  const inset = softEdgeMeters(r) / 2;
  const radius = r.shape === 'sphere' ? Math.max(0.01, Math.abs(r.size[0]) * grow - inset) : 0;
  const halfExtents = r.size.map((s) => Math.max(0.01, Math.abs(s) * grow - inset)) as Vec3;
  return { type: r.shape, center: [...r.center], radius, halfExtents, yaw: r.yaw ?? 0, displace };
}

/** Cells per axis of the scale displacement field. */
export const SCALE_CELLS = 5;

/**
 * Uniform scale about the centre as a displacement field: the region's bounding box is cut into
 * SCALE_CELLS³ boxes (cells whose centre is outside a sphere region are dropped), each displaced
 * by (scale − 1) × (cell centre − region centre), blended smoothly (sdfSmooth ≈ cell / 3) so the
 * field is close to linear between cell centres. Splat sizes do not change (SplatEdit can only
 * move splats), so growing an object spreads its splats apart a little.
 */
export function scaleFieldSdfs(r: RegionEdit, scale: number, cells = SCALE_CELLS): { sdfs: SdfSpec[]; smooth: number } {
  const half: Vec3 = r.shape === 'sphere' ? [r.size[0], r.size[0], r.size[0]] : [...r.size];
  const yaw = r.yaw ?? 0;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const cell: Vec3 = half.map((h) => (2 * Math.abs(h)) / cells) as Vec3;
  const sdfs: SdfSpec[] = [];
  for (let i = 0; i < cells; i++)
    for (let j = 0; j < cells; j++)
      for (let k = 0; k < cells; k++) {
        // local offset of the cell centre (region frame), then rotated by yaw about +Y
        const lx = -Math.abs(half[0]) + cell[0] * (i + 0.5);
        const ly = -Math.abs(half[1]) + cell[1] * (j + 0.5);
        const lz = -Math.abs(half[2]) + cell[2] * (k + 0.5);
        if (r.shape === 'sphere' && Math.hypot(lx, ly, lz) > Math.abs(r.size[0])) continue;
        const ox = c * lx + s * lz;
        const oz = -s * lx + c * lz;
        sdfs.push({
          type: 'box',
          center: [r.center[0] + ox, r.center[1] + ly, r.center[2] + oz],
          radius: 0,
          halfExtents: cell.map((v) => v / 2) as Vec3,
          yaw,
          displace: [(scale - 1) * ox, (scale - 1) * ly, (scale - 1) * oz],
        });
      }
  return { sdfs, smooth: Math.min(...cell) / 3 };
}

/** The SplatEdits that render one region edit, in application order (colour, scale, move). */
export function regionSpecs(r: RegionEdit): SplatEditSpec[] {
  const out: SplatEditSpec[] = [];
  const softEdge = softEdgeMeters(r);
  const opacity = r.opacity ?? 1;
  if (r.color || opacity < 1) {
    let blend: SplatEditSpec['blend'] = 'multiply';
    let rgb: RGB = [1, 1, 1];
    if (r.color?.mode === 'set') {
      blend = 'set_rgb';
      rgb = hexToRgb(r.color.value);
    } else if (r.color?.mode === 'hue') rgb = hueMultiplier(r.color.value, r.color.strength ?? 1);
    else if (r.color) rgb = multiplyColor(r.color.value, r.color.strength ?? 1);
    out.push({ role: 'color', blend, rgb, opacity, softEdge, sdfSmooth: 0, sdfs: [regionSdf(r)] });
  }
  const scale = r.scale ?? 1;
  if (Math.abs(scale - 1) > 1e-3) {
    const f = scaleFieldSdfs(r, scale);
    out.push({ role: 'scale', blend: 'multiply', rgb: [1, 1, 1], opacity: 1, softEdge, sdfSmooth: f.smooth, sdfs: f.sdfs });
  }
  const d = r.displace;
  if (d && Math.hypot(...d) > 1e-4) {
    out.push({
      role: 'move',
      blend: 'multiply',
      rgb: [1, 1, 1],
      opacity: 1,
      softEdge,
      sdfSmooth: 0,
      sdfs: [regionSdf(r, Math.max(1, scale), d)],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// CPU reference of Spark's SDF edit (unit tests: region masks and the scale field)
// ---------------------------------------------------------------------------------------------

/** World point → the SDF's local frame (undo the yaw about +Y). */
function toLocal(sdf: SdfSpec, p: Vec3): Vec3 {
  const dx = p[0] - sdf.center[0];
  const dz = p[2] - sdf.center[2];
  const c = Math.cos(sdf.yaw);
  const s = Math.sin(sdf.yaw);
  return [c * dx - s * dz, p[1] - sdf.center[1], s * dx + c * dz];
}

export function sdfDistance(sdf: SdfSpec, p: Vec3): number {
  const q = toLocal(sdf, p);
  if (sdf.type === 'sphere') return Math.hypot(...q) - sdf.radius;
  const d = q.map((v, i) => Math.abs(v) - sdf.halfExtents[i]!);
  const outside = Math.hypot(...d.map((v) => Math.max(v, 0)));
  return outside + Math.min(Math.max(d[0]!, d[1]!, d[2]!), 0);
}

/** Spark's evaluateSdfArray + modulate for one edit: (modulate 0..1, blended displacement). */
export function evaluateSpec(spec: SplatEditSpec, p: Vec3): { modulate: number; displace: Vec3 } {
  let dist: number;
  let disp: Vec3 = [0, 0, 0];
  if (spec.sdfSmooth === 0) {
    dist = Infinity;
    for (const s of spec.sdfs) {
      const d = sdfDistance(s, p);
      if (d < dist) {
        dist = d;
        disp = s.displace;
      }
    }
  } else {
    const k = spec.sdfSmooth;
    const ds = spec.sdfs.map((s) => sdfDistance(s, p));
    const maxExp = Math.max(...ds.map((d) => -d / k));
    let acc = 0;
    const v: Vec3 = [0, 0, 0];
    spec.sdfs.forEach((s, i) => {
      const w = Math.exp(-ds[i]! / k - maxExp);
      acc += w;
      for (let a = 0; a < 3; a++) v[a] = v[a]! + w * s.displace[a]!;
    });
    disp = v.map((x) => x / acc) as Vec3;
    dist = (-Math.log(acc) - maxExp) * k;
  }
  const modulate =
    spec.softEdge === 0 ? (dist < 0 ? 1 : 0) : Math.min(1, Math.max(0, -dist / spec.softEdge + 0.5));
  return { modulate, displace: disp };
}

// ---------------------------------------------------------------------------------------------
// Region sizing
// ---------------------------------------------------------------------------------------------

export const AUTO_RADIUS = { min: 0.15, max: 1.2, window: 0.6, percentile: 0.8, minOpacity: 0.2 };

/** p-th percentile (0..1) of `values` by linear interpolation; NaN when empty. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return NaN;
  const v = [...values].sort((a, b) => a - b);
  const x = Math.min(1, Math.max(0, p)) * (v.length - 1);
  const i = Math.floor(x);
  return v[i]! + (v[Math.min(v.length - 1, i + 1)]! - v[i]!) * (x - i);
}

/**
 * Auto radius of a click selection from the splats around the hit: distances from the hit to
 * the opaque splat centres inside a box of half-size `window` (0.6 m) around it, 80th
 * percentile, clamped to 0.15–1.2 m. A small isolated object gives a small sphere; a wall or a
 * large object fills the window and gives ~0.6–0.8 m.
 */
export function autoRadius(distances: readonly number[]): number {
  const r = percentile(distances, AUTO_RADIUS.percentile);
  if (!Number.isFinite(r)) return AUTO_RADIUS.min * 2;
  return Math.min(AUTO_RADIUS.max, Math.max(AUTO_RADIUS.min, r));
}

/** Normalised pixel box (0..1, origin top-left) of a target in the view image. */
export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Size of the region for a planner target box: the box's angular extent × the hit distance.
 * Returns sphere radius (half the larger side) and box half-extents (w/2, h/2, depth = the
 * smaller of the two) in metres, clamped like the auto radius.
 */
export function boxRegionSize(
  box: NormBox,
  view: { fovDeg: number; aspect: number },
  distance: number,
): { radius: number; halfExtents: Vec3 } {
  const tv = Math.tan((view.fovDeg * Math.PI) / 360);
  const th = tv * view.aspect;
  const w = box.w * 2 * th * distance;
  const h = box.h * 2 * tv * distance;
  const clamp = (v: number) => Math.min(AUTO_RADIUS.max * 2, Math.max(AUTO_RADIUS.min, v));
  const hx = clamp(w / 2);
  const hy = clamp(h / 2);
  return { radius: Math.min(AUTO_RADIUS.max * 1.5, Math.max(hx, hy)), halfExtents: [hx, hy, Math.min(hx, hy)] };
}

/** Normalised device coordinates (-1..1, y up) of a normalised image point (0..1, y down). */
export const imageToNdc = (x: number, y: number): [number, number] => [x * 2 - 1, 1 - y * 2];
