// Scale calibration: is Marble's metric_scale_factor right, and if not, by how much?
//
// Marble's metric_scale_factor is only approximate: checked against a 1.7 m human and a door
// standing on the floor plane, it can be off by up to 2× on some worlds. This step measures
// every Marble world after download with two independent sources and records the result as
// WorldAsset.scaleCalibration (effective scale = factor × metricScaleFactor, see
// web/src/viewer/transform.ts):
//
//   geometric  calibrate-geometry.ts: the collider mesh in the viewer's frame; ceiling, door,
//              counter, table, seat, bench, canopy heights vs their real sizes
//   vision     calibrate-vision.ts: Claude compares objects with 1.70 m mannequins in renders
//              from the source camera (calibrate-render.ts), twice, on different views
//
// plus two weak checks that only take part when the collider has no reference:
//
//   eyeballed  Claude's own size comparisons with the mannequins (no pixel geometry), when the
//              runs agree within 15 %
//   camera     Marble's text worlds put the source camera at a standing eye height: 1.39–1.61 m
//              above the collider floor on three of four worlds (the kitchen, which every
//              reference confirms, at 1.43 m). 1.55 m ± 0.2 is the prior, so a camera 2.17 m up
//              says the world is ×0.71 too big (±13 %)
//
// Combination (`decide`), with a collider estimate (interiors: ceiling, doors, counters):
//   both, within 10 %         apply the geometric median, confidence high
//   both, 10–25 % apart       apply geometric (medium) only if ≥ 3 geometric references agree
//   both, > 25 % apart        apply nothing: factor 1, confidence low, evidence says why
//   geometric only            high with ≥ 3 consistent references, else medium
// Without one (every outdoor world: Marble's collider never has doors or counters there), each
// source is a factor with an uncertainty σ in log space and they are weighed by 1/σ²:
//   vision     σ = √(0.06² + 0.08²/W + (spread/2)²), W = object weight of the agreeing runs:
//              the 6 % floor is what vision shares however much it measured (standard sizes
//              vary; on the kitchen ten good objects still came out 7 % off its collider)
//   eyeballed  σ = 15 %        camera  σ = 13 %
//   no vision (the runs disagree, or none): nothing is applied, whatever the camera says;
//   vision with too little evidence for `available` needs eyeballed or camera beside it
//   any two sources > 25 % apart          refused: factor 1, low, the evidence says which
//   combined within 1.5 σ of ×1           kept (low: unverified); the evidence gives ×c ± σ
//   otherwise                              apply the combination, confidence medium
// So agreeing vision with a camera that points the same way gets applied (rooftop: parapets
// ×0.85 ± 13 %, camera ×0.71 ± 13 % → ×0.78 ± 9 %, 2.8 σ); four clean pixel-measured objects
// (W ≈ 2, σ ≈ 9 %) outweigh a mildly disagreeing camera; four ad panels and posts (W 0.6) that
// the camera and Claude's own eye both contradict do not (bus stop: ×1.04 ± 8 %, kept).
// Everywhere: any factor outside [0.5, 2] is refused; a correction under 5 % is not applied
// (factor 1: Marble's scale confirmed) but the measurements are still recorded.
//
// `headline` is the main reference at the calibrated scale ("door 2.04 m", or "unverified"), which
// the laptop HUD shows next to the factor; `evidence` starts with the same text, then " · " and
// the details (the tooltip).
//
// Floor offset: how far the visible ground sits below Marble's declared plane where the actors
// stand, measured from the splats themselves (calibrate-ground.ts; the collider sits ~0.1 m below
// the splats outdoors and is not used for this). Written as WorldAsset.floorOffsetMeters
// (transform.ts raises the world by it) whatever the scale decision; nothing beyond ±0.5 m.
// Writing a calibration also measures the ground height FIELD (ground.json → WorldAsset.ground,
// calibrate-ground.ts): the ground per 0.25 m cell, which is what the viewer stands each actor on;
// floorOffsetMeters stays the raise and the fallback where the field has no ground.
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WorldAsset } from '../../shared/schema.ts';
import { hasFloor, spotBlocked, TriGrid } from '../../web/src/viewer/placement.ts';
import {
  analyzeGeometry,
  EXPECTED,
  median,
  metricTriangles,
  RayGrid,
  weightedMedian,
  type GeometryReport,
  type Measurement,
  type RayCast,
} from './calibrate-geometry.ts';
import { openWorldRenderer, type WorldRenderer } from './calibrate-render.ts';
import {
  askVision,
  combineRuns,
  floorAt,
  planCloseups,
  planViews,
  type PlannedView,
  type VisionCall,
  type VisionEstimate,
} from './calibrate-vision.ts';
import { splatGround, writeGroundField, type GroundMeasurement } from './calibrate-ground.ts';
import { exists, readJson, writeJsonAtomic } from './fsutil.ts';
import { glbTriangles } from './glb.ts';
import { ASSET_FILE, WORLD_FILE, type MarbleWorld } from './marble.ts';

export const REPORT_FILE = 'scale-calibration.json';
export const DEADBAND = 0.05;
/** A measured floor offset larger than this is treated as a bad measurement and not written. */
export const MAX_FLOOR_OFFSET = 0.5;
/**
 * The same limit for a world Marble returned without a ground plane (marble-1.0-draft has no
 * semantics_metadata, so the floor is assumed at the camera and can be far off).
 */
export const MAX_UNDECLARED_FLOOR_OFFSET = 2;
export const FACTOR_RANGE = [0.5, 2] as const;
/** Source-camera eye height (m above the collider floor) Marble's text worlds are built around. */
export const EYE_HEIGHT = { typ: EXPECTED.camera.typ, sd: 0.2 } as const;
/** Without a collider estimate, a correction is applied only this many σ away from ×1. */
export const SIGNIFICANCE = 1.5;
/** Two sources further apart than this (max/min − 1): nothing is applied. */
export const MAX_DISAGREEMENT = 0.25;
/** 1σ of ln(factor) per source (see the header). */
export const SIGMA = {
  camera: EYE_HEIGHT.sd / EYE_HEIGHT.typ,
  eyeballed: 0.15,
  /** per unit of vision object weight (sizeConfidence × pixelConfidence) */
  visionObject: 0.08,
  /** shared by every vision estimate, however many objects it measured */
  visionFloor: 0.06,
} as const;
/** Claude's eyeballed run estimates count only when they agree this well. */
const EYEBALL_AGREE = 0.15;

export type Confidence = 'high' | 'medium' | 'low';
export type ScaleCalibration = NonNullable<WorldAsset['scaleCalibration']>;

// ---------------------------------------------------------------------------
// Estimates and the decision (pure)
// ---------------------------------------------------------------------------

export interface GeometricEstimate {
  available: boolean;
  factor: number;
  /** references whose implied correction is within 10 % of `factor` */
  consistent: number;
  used: Measurement[];
  weight: number;
  note: string;
}

/**
 * Weighted median of the implied corrections of the references that count (weight ≥ 0.3; the
 * camera-height band is reported but never votes). Available with ≥ 0.6 total weight.
 */
export function geometricEstimate(ms: Measurement[]): GeometricEstimate {
  const used = ms.filter((m) => m.kind !== 'camera' && m.weight >= 0.3 && m.measured > 0);
  const weight = used.reduce((s, m) => s + m.weight, 0);
  if (!used.length || weight < 0.6)
    return {
      available: false,
      factor: NaN,
      consistent: 0,
      used,
      weight,
      note: used.length
        ? `only ${used.length} weak reference(s) (weight ${weight.toFixed(2)})`
        : 'no usable reference in the collider',
    };
  const factor = weightedMedian(
    used.map((m) => m.implied),
    used.map((m) => m.weight),
  );
  const consistent = used.filter((m) => Math.abs(m.implied / factor - 1) <= 0.1).length;
  return {
    available: true,
    factor,
    consistent,
    used,
    weight,
    note: `${consistent}/${used.length} references within 10% of ×${factor.toFixed(3)}`,
  };
}

/** What `decide` needs from the vision runs (a VisionEstimate, or a stored one: visionSummary). */
export interface VisionSummary extends Pick<VisionEstimate, 'available' | 'factor'> {
  /** ≥ 2 runs agree within 15 % (combineRuns), whether or not their objects were enough */
  agree?: boolean;
  /** max/min − 1 over the agreeing runs */
  spread?: number;
  /** total object weight of the agreeing runs */
  weight?: number;
  /** each run's eyeballed-only factor (Claude's comparison with the mannequins, no geometry) */
  eyeballed?: number[];
}

/** Evidence that is not a measurement of a standard object. */
export interface Prior {
  /** Marble's source camera above the collider floor near it, m (GeometryReport.cameraHeight). */
  cameraHeight?: number;
}

/** One estimate of the correction with its uncertainty. */
export interface Source {
  kind: 'vision' | 'eyeballed' | 'camera';
  factor: number;
  /** 1σ of ln(factor) */
  sigma: number;
  note: string;
}

export interface Decision {
  /** what gets written: 1 unless a correction is applied */
  factor: number;
  /** what the evidence pointed to before the deadband / refusal rules */
  candidate: number;
  applied: boolean;
  confidence: Confidence;
  method: string;
  reason: string;
  /** the sources weighed when the collider had no estimate, and σ of their combination */
  sources?: Source[];
  sigma?: number;
}

const pct = (x: number) => `${(Math.abs(x) * 100).toFixed(0)}%`;
/** n.toFixed(d), or "—" for NaN / null (a report read back from JSON has null for NaN). */
const fx = (n: number | null | undefined, d = 3) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—');
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function visionSummary(v: VisionEstimate): VisionSummary {
  const runs = v.runs ?? [];
  const weight = (v.agreeing ?? []).reduce(
    (s, i) => s + (runs[i]?.objects ?? []).reduce((t, o) => t + o.weight, 0),
    0,
  );
  return {
    available: v.available,
    factor: finite(v.factor) ? v.factor : NaN,
    agree: v.agree,
    ...(finite(v.spread) ? { spread: v.spread } : {}),
    weight,
    eyeballed: runs.map((r) => r.eyeballed).filter(finite),
  };
}

/**
 * The sources `decide` weighs when the collider has no estimate: vision (agreeing runs, even
 * with too little evidence for `available`), Claude's eyeballed runs when they agree within
 * 15 %, and the camera eye-height prior.
 */
export function scaleSources(vision: VisionSummary | null, prior: Prior = {}): Source[] {
  const out: Source[] = [];
  if (vision && (vision.available || vision.agree) && finite(vision.factor) && vision.factor > 0) {
    // a bare {available, factor} (tests, old callers): the least evidence `available` allows
    const w = vision.weight ?? (vision.available ? 0.8 : 0.4);
    const spread = vision.spread ?? 0;
    const sigma = Math.sqrt(SIGMA.visionFloor ** 2 + SIGMA.visionObject ** 2 / Math.max(w, 0.05) + (spread / 2) ** 2);
    out.push({
      kind: 'vision',
      factor: vision.factor,
      sigma,
      note: `object weight ${w.toFixed(2)}${spread ? `, runs ${pct(spread)} apart` : ''}`,
    });
  }
  const eyes = (vision?.eyeballed ?? []).filter((x) => finite(x) && x > 0);
  if (eyes.length >= 2 && Math.max(...eyes) / Math.min(...eyes) - 1 <= EYEBALL_AGREE)
    out.push({
      kind: 'eyeballed',
      factor: median(eyes),
      sigma: SIGMA.eyeballed,
      note: `${eyes.length} runs ${eyes.map((x) => `×${x.toFixed(2)}`).join(', ')}`,
    });
  const h = prior.cameraHeight;
  if (finite(h) && h > 0.5 && h < 4)
    out.push({
      kind: 'camera',
      factor: EYE_HEIGHT.typ / h,
      sigma: SIGMA.camera,
      note: `source camera ${h.toFixed(2)} m above the floor vs ${EYE_HEIGHT.typ} ± ${EYE_HEIGHT.sd} m eye height`,
    });
  return out;
}

/** Inverse-variance weighted mean in log space, and its σ. */
export function combineSources(s: readonly Source[]): { factor: number; sigma: number } {
  let sw = 0;
  let sl = 0;
  for (const x of s) {
    const w = 1 / x.sigma ** 2;
    sw += w;
    sl += w * Math.log(x.factor);
  }
  return sw ? { factor: Math.exp(sl / sw), sigma: 1 / Math.sqrt(sw) } : { factor: NaN, sigma: NaN };
}

const sourceText = (s: Source) =>
  `${s.kind === 'camera' ? 'camera height' : s.kind} ×${s.factor.toFixed(2)} ± ${pct(s.sigma)}`;

export function decide(
  geo: (Pick<GeometricEstimate, 'available' | 'factor' | 'consistent'> & { note?: string }) | null,
  vision: VisionSummary | null,
  prior: Prior = {},
): Decision {
  const g = geo?.available ? geo : null;
  const v = vision?.available ? vision : null;
  const keep = (confidence: Confidence, method: string, reason: string, candidate = NaN): Decision => ({
    factor: 1,
    candidate,
    applied: false,
    confidence,
    method,
    reason,
  });
  if (!g) return decideWithoutCollider(geo, vision, prior);
  let candidate: number;
  let confidence: Confidence;
  let method: string;
  let reason: string;
  if (v) {
    const d = g.factor / v.factor - 1;
    if (Math.abs(d) <= 0.1) {
      [candidate, confidence, method] = [g.factor, 'high', 'geometric+vision'];
      reason = `collider and vision agree within ${pct(d)}`;
    } else if (Math.abs(d) > 0.25) {
      return keep(
        'low',
        'geometric+vision',
        `collider (×${g.factor.toFixed(2)}) and vision (×${v.factor.toFixed(2)}) disagree by ${pct(d)}: not applied`,
        g.factor,
      );
    } else if (g.consistent >= 3) {
      [candidate, confidence, method] = [g.factor, 'medium', 'geometric+vision'];
      reason = `vision is ${pct(d)} off the collider; ${g.consistent} collider references agree`;
    } else {
      return keep(
        'low',
        'geometric+vision',
        `collider (×${g.factor.toFixed(2)}) and vision (×${v.factor.toFixed(2)}) differ by ${pct(d)} with too few collider references: not applied`,
        g.factor,
      );
    }
  } else {
    [candidate, method] = [g.factor, 'geometric'];
    confidence = g.consistent >= 3 ? 'high' : 'medium';
    reason = `collider only (${g.consistent} consistent references)`;
  }
  return finish({ candidate, confidence, method, reason });
}

/** The clamp and the deadband, shared by both paths. */
function finish(d: Pick<Decision, 'candidate' | 'confidence' | 'method' | 'reason' | 'sources' | 'sigma'>): Decision {
  const { candidate } = d;
  if (!(candidate >= FACTOR_RANGE[0] && candidate <= FACTOR_RANGE[1]))
    return {
      ...d,
      factor: 1,
      applied: false,
      confidence: 'low',
      reason: `×${candidate.toFixed(2)} is outside [${FACTOR_RANGE.join(', ')}]: refused`,
    };
  if (Math.abs(candidate - 1) < DEADBAND)
    return {
      ...d,
      factor: 1,
      applied: false,
      reason: `${d.reason}; correction ${pct(candidate - 1)} < ${pct(DEADBAND)}: Marble's scale kept`,
    };
  return { ...d, factor: Math.round(candidate * 1000) / 1000, applied: true };
}

/**
 * No collider estimate (outdoors): vision, Claude's eyeballed runs and the camera eye-height
 * prior weighed by 1/σ² (header). Priors alone never change anything, nor does weak vision alone.
 */
function decideWithoutCollider(
  geo: { note?: string } | null,
  vision: VisionSummary | null,
  prior: Prior,
): Decision {
  const sources = scaleSources(vision, prior);
  const vis = sources.find((s) => s.kind === 'vision');
  const cam = sources.find((s) => s.kind === 'camera');
  // weak vision (too little evidence for `available`) needs a second source to weigh against
  if (!vis || (!vision?.available && sources.length < 2)) {
    const why = [
      geo ? `collider: ${geo.note ?? 'unavailable'}` : 'no collider',
      vision ? (vision.agree ? 'vision: agreeing runs but too little evidence' : 'vision: runs disagree or found nothing') : 'no vision',
      ...(cam && Math.abs(cam.factor - 1) >= DEADBAND ? [`${sourceText(cam)} alone is only a prior`] : []),
    ];
    return {
      factor: 1,
      candidate: NaN,
      applied: false,
      confidence: 'low',
      method: 'none',
      reason: `not enough evidence to change anything (${why.join('; ')}): Marble scale kept, unverified`,
      sources,
    };
  }
  const method = sources.map((s) => s.kind).join('+');
  const { factor: c, sigma } = combineSources(sources);
  const list = sources.map(sourceText).join(', ');
  for (const [i, a] of sources.entries())
    for (const b of sources.slice(i + 1)) {
      const apart = Math.max(a.factor, b.factor) / Math.min(a.factor, b.factor) - 1;
      if (apart > MAX_DISAGREEMENT)
        return {
          factor: 1,
          candidate: c,
          applied: false,
          confidence: 'low',
          method,
          reason: `${sourceText(a)} and ${sourceText(b)} disagree by ${pct(apart)}: not applied`,
          sources,
          sigma,
        };
    }
  const z = Math.abs(Math.log(c)) / sigma;
  const combined = `${list} → ×${c.toFixed(2)} ± ${pct(sigma)}`;
  if (Math.abs(c - 1) >= DEADBAND && z < SIGNIFICANCE)
    return {
      factor: 1,
      candidate: c,
      applied: false,
      confidence: 'low',
      method,
      reason: `${combined}, ${z.toFixed(1)}σ from Marble's scale (< ${SIGNIFICANCE}σ): not applied, unverified`,
      sources,
      sigma,
    };
  return finish({
    candidate: c,
    // a clean vision estimate that lands within the deadband confirms Marble's scale
    confidence: Math.abs(c - 1) < DEADBAND && !vision?.available ? 'low' : 'medium',
    method,
    reason: `${combined} (${z.toFixed(1)}σ)`,
    sources,
    sigma,
  });
}

// ---------------------------------------------------------------------------
// Running it on a world
// ---------------------------------------------------------------------------

export interface CalibrationReport {
  schema: 'previz.scale-calibration/1';
  worldId?: string;
  createdAt: string;
  metricScaleFactor: number;
  groundPlaneOffset: number;
  /** false when Marble gave no ground_plane_offset (0 was assumed); absent in older reports. */
  groundPlaneDeclared?: boolean;
  interior: boolean;
  geometry: Omit<GeometryReport, 'measurements'> & {
    measurements: Measurement[];
    estimate: Omit<GeometricEstimate, 'used'>;
  } | null;
  vision: (VisionEstimate & { views: PlannedView[] }) | null;
  visionSkipped?: string;
  decision: Decision;
  calibration: ScaleCalibration;
  /** The visible splat ground where actors stand (calibrate-ground.ts); null without an SPZ. */
  ground?: GroundMeasurement | null;
  /** WorldAsset.floorOffsetMeters this report writes (absent: no splat ground / implausible). */
  floorOffsetMeters?: number;
  costUsd: number;
}

/**
 * The floor offset a report supports: how far the measured splat ground sits below Marble's plane
 * (m at Marble's scale, + = the visible ground is lower), to the millimetre; undefined without a
 * ground measurement or beyond ±MAX_FLOOR_OFFSET.
 */
export function floorOffsetOf(
  report: Pick<CalibrationReport, 'ground' | 'groundPlaneDeclared'>,
): number | undefined {
  const h = report.ground?.height;
  const max = report.groundPlaneDeclared === false ? MAX_UNDECLARED_FLOOR_OFFSET : MAX_FLOOR_OFFSET;
  if (typeof h !== 'number' || !Number.isFinite(h) || Math.abs(h) > max) return undefined;
  return Math.round(-h * 1000) / 1000 || 0;
}

/** `report` with the splat ground measured (again) at `marks` (xz, scene metres) and its offset. */
export async function withGround(
  report: CalibrationReport,
  worldDir: string,
  marks?: readonly (readonly [number, number])[],
): Promise<CalibrationReport> {
  const ground = await splatGround(worldDir, await readWorldAsset(worldDir), marks).catch(() => null);
  const { floorOffsetMeters: _old, ...rest } = report;
  const groundPlaneDeclared = report.groundPlaneDeclared ?? (await marbleDeclaresGround(worldDir));
  const next: CalibrationReport = { ...rest, groundPlaneDeclared, ground };
  const off = floorOffsetOf(next);
  return off === undefined ? next : { ...next, floorOffsetMeters: off };
}

export interface CalibrateOptions {
  /** Scene plan's interior flag; inferred from the collider when absent. */
  interior?: boolean;
  /** Ask Claude (needs ANTHROPIC_API_KEY and a GPU Chromium). Default true. */
  vision?: boolean;
  log?: (m: string) => void;
  call?: VisionCall;
  openRenderer?: (dir: string, asset: WorldAsset) => Promise<WorldRenderer>;
  /** Keep the vision renders here (debugging / docs). */
  saveViewsTo?: string;
  /** Where the scene's actors stand (blocking xz, m): the floor offset is measured there. */
  marks?: readonly (readonly [number, number])[];
}

export async function readWorldAsset(worldDir: string): Promise<WorldAsset> {
  return WorldAsset.parse(JSON.parse(await readFile(join(worldDir, ASSET_FILE), 'utf8')));
}

export async function colliderMetric(worldDir: string, asset: WorldAsset, factor = 1) {
  if (!asset.colliderGlb) return null;
  const raw = glbTriangles(new Uint8Array(await readFile(join(worldDir, asset.colliderGlb))));
  return metricTriangles(raw, asset, factor);
}

const strongest = (ms: Measurement[]) =>
  [...ms].filter((m) => m.kind !== 'camera').sort((a, b) => b.weight - a.weight)[0];

/**
 * "door 2.04 m" for the HUD: the strongest reference at the calibrated scale; "unverified" when
 * nothing was measured, or when a world without collider references kept Marble's scale only
 * because the evidence was too weak to say otherwise.
 */
export function headline(
  geo: GeometricEstimate | null,
  vision: VisionEstimate | null,
  d: Pick<Decision, 'factor' | 'method' | 'applied' | 'confidence'>,
): string {
  if (d.method === 'none') return 'unverified';
  const m = geo?.available ? strongest(geo.used) : undefined;
  if (m) return `${EXPECTED[m.kind].label} ${(m.measured * d.factor).toFixed(2)} m`;
  if (!d.applied && d.confidence === 'low') return 'unverified';
  const runs = vision?.runs ?? [];
  const agreeing = vision?.agreeing?.length ? vision.agreeing.flatMap((i) => runs[i] ?? []) : runs;
  const o = agreeing.flatMap((r) => r.objects).sort((a, b) => b.weight - a.weight)[0];
  if (o) {
    const name = shortName(o.object);
    const h = o.measured?.ok ? o.measured.height : o.apparentMeters;
    return `${name} ${(h * d.factor).toFixed(2)} m (vision)`;
  }
  return 'no reference';
}

export function evidenceText(
  geo: GeometricEstimate | null,
  all: Measurement[],
  vision: VisionEstimate | null,
  d: Decision,
): string {
  const parts: string[] = [headline(geo, vision, d)];
  const refs = all
    .filter((m) => m.kind !== 'camera')
    .map((m) => `${EXPECTED[m.kind].label} ${m.measured.toFixed(2)} m (×${m.implied.toFixed(2)}${m.weight < 0.3 ? ', weak' : ''})`);
  const cam = all.find((m) => m.kind === 'camera');
  parts.push(
    `collider at Marble scale: ${refs.length ? refs.join(', ') : 'nothing measurable'}${cam ? `; camera ${cam.measured.toFixed(2)} m above floor` : ''}${geo?.available ? ` → ×${geo.factor.toFixed(3)} (${geo.note})` : geo ? ` (${geo.note})` : ''}`,
  );
  if (vision) parts.push(`vision: ${Number.isFinite(vision.factor) ? `×${vision.factor.toFixed(3)}, ` : ''}${vision.note}`);
  parts.push(d.reason);
  return parts.join(' · ');
}

/** False when the world's Marble response had no ground_plane_offset (true without one: mock). */
async function marbleDeclaresGround(worldDir: string): Promise<boolean> {
  const file = join(worldDir, WORLD_FILE);
  if (!(await exists(file))) return true;
  const world = await readJson<MarbleWorld>(file);
  const gpo = world?.assets?.splats?.semantics_metadata?.ground_plane_offset;
  return typeof gpo === 'number' && Number.isFinite(gpo);
}

/** Measures one world directory (world-asset.json + collider + SPZ). Never writes. */
export async function calibrateWorld(worldDir: string, o: CalibrateOptions = {}): Promise<CalibrationReport> {
  const log = o.log ?? (() => {});
  const asset = await readWorldAsset(worldDir);
  const tris = await colliderMetric(worldDir, asset);
  let geometry: CalibrationReport['geometry'] = null;
  let geo: GeometricEstimate | null = null;
  let interior = o.interior ?? false;
  if (tris) {
    const g = analyzeGeometry(tris, { cameraY: asset.groundPlaneOffset, interior: o.interior });
    interior = g.interior;
    geo = geometricEstimate(g.measurements);
    const { used: _used, ...estimate } = geo;
    geometry = { ...g, estimate };
    log(
      `calibrate: collider (${interior ? 'interior' : 'exterior'}): ${g.measurements.map((m) => `${m.kind} ${m.measured.toFixed(2)} m ×${m.implied.toFixed(2)} w${m.weight.toFixed(1)}`).join(', ') || 'nothing'} → ${geo.available ? `×${geo.factor.toFixed(3)}` : 'unavailable'}`,
    );
  } else log('calibrate: no collider mesh; geometric measurement skipped');

  let vision: VisionEstimate | null = null;
  let views: PlannedView[] = [];
  let visionSkipped: string | undefined;
  if (o.vision === false) visionSkipped = 'disabled';
  else if (!tris) visionSkipped = 'no collider to stand the mannequins on';
  else {
    let renderer: WorldRenderer | undefined;
    try {
      const geo3 = { grid: new TriGrid(tris), cast: new RayGrid(tris).cast, cameraY: asset.groundPlaneOffset };
      views = planViews(geo3);
      if (views.length < 2) throw new Error(`only ${views.length} usable view(s) for the mannequins`);
      renderer = await (o.openRenderer ?? ((d, a) => openWorldRenderer(d, a, { log })))(worldDir, asset);
      const r = renderer;
      const shoot = async (v: PlannedView, name: string) => {
        const jpeg = await r.shot({
          factor: 1,
          camera: { position: v.camera, yawDeg: v.yawDeg, pitchDeg: v.pitchDeg, fovDeg: v.fovDeg },
          figures: v.figures,
          width: 1280,
          height: 720,
          format: 'jpeg',
        });
        if (o.saveViewsTo) await writeFile(join(o.saveViewsTo, `${name}.jpg`), jpeg);
        return { jpeg };
      };
      const images: { jpeg: Buffer }[] = [];
      for (const v of views) images.push(await shoot(v, `vision-yaw${v.yawDeg}`));
      // two independent requests on different views (alternating, so each gets the main view's
      // neighbourhood): views 0+2 and 1+3 with four views, 0 and 1 with two
      const split = views.length >= 4 ? [[0, 2], [1, 3]] : views.length === 3 ? [[0, 2], [1]] : [[0], [1]];
      log(`calibrate: asking claude-opus-5-5 twice (views ${split.map((s) => s.map((i) => `${views[i]!.yawDeg}°`).join('+')).join(' | ')})`);
      const ask = (idx: number[]) =>
        askVision(
          idx.map((i) => views[i]!),
          idx.map((i) => images[i]!),
          idx,
          { call: o.call, cast: geo3.cast },
        );
      const runs = await Promise.all(split.map(ask));
      // third request: close-ups of the standard objects those runs found, mannequin alongside
      const closeups = planCloseups(geo3, runs.flatMap((x) => x.located));
      if (closeups.length) {
        const first = views.length;
        views.push(...closeups);
        for (const [k, v] of closeups.entries()) images.push(await shoot(v, `vision-closeup${k + 1}`));
        log(`calibrate: close-ups of ${closeups.map((v) => `"${v.closeupOf!.slice(0, 40)}"`).join(', ')}`);
        runs.push(await ask(closeups.map((_, k) => first + k)));
      } else log('calibrate: no standard object located on the floor for a close-up');
      await renderer.close();
      renderer = undefined;
      vision = combineRuns(runs);
      log(
        `calibrate: vision ${runs.map((x) => `×${x.factor.toFixed(3)} (${x.objects.map((y) => `${y.object.slice(0, 28)} ×${y.vote.toFixed(2)} ${y.source}`).join('; ')})`).join(' | ')} → ${vision.note}; $${vision.costUsd.toFixed(3)}`,
      );
    } catch (e) {
      visionSkipped = `failed: ${(e as Error).message.slice(0, 200)}`;
      log(`calibrate: vision ${visionSkipped}`);
    } finally {
      await renderer?.close();
    }
  }

  const decision = decide(geo, vision ? visionSummary(vision) : null, { cameraHeight: geometry?.cameraHeight });
  const calibration: ScaleCalibration = {
    factor: decision.factor,
    method: decision.method,
    confidence: decision.confidence,
    evidence: evidenceText(geo, geometry?.measurements ?? [], vision, decision),
    headline: headline(geo, vision, decision),
  };
  const ground = await splatGround(worldDir, asset, o.marks).catch((e) => {
    log(`calibrate: splat ground not measured (${(e as Error).message.slice(0, 120)})`);
    return null;
  });
  if (ground) log(`calibrate: splat ground ${ground.height === null ? 'unmeasurable' : `${ground.height.toFixed(3)} m`} (${ground.probes.map((p) => `(${p.x}, ${p.z}) ${p.height ?? '—'}`).join(', ')})`);
  const groundPlaneDeclared = await marbleDeclaresGround(worldDir);
  const floorOffsetMeters = floorOffsetOf({ ground, groundPlaneDeclared });
  return {
    schema: 'previz.scale-calibration/1',
    worldId: asset.worldId,
    createdAt: new Date().toISOString(),
    metricScaleFactor: asset.metricScaleFactor,
    groundPlaneOffset: asset.groundPlaneOffset,
    groundPlaneDeclared,
    interior,
    geometry,
    vision: vision
      ? { ...vision, views }
      : null,
    visionSkipped,
    decision,
    calibration,
    ground,
    ...(floorOffsetMeters !== undefined ? { floorOffsetMeters } : {}),
    costUsd: vision?.costUsd ?? 0,
  };
}

/**
 * The decision and the written calibration recomputed from a report's stored measurements, so a
 * rule or wording change applies to an earlier run (`cli calibrate --reuse`) without measuring or
 * paying again. JSON stores NaN as null; those read back as "unavailable".
 */
export function redecide(report: CalibrationReport): CalibrationReport {
  const geo = report.geometry ? geometricEstimate(report.geometry.measurements) : null;
  const v = report.vision;
  const vision = v ? { ...v, factor: typeof v.factor === 'number' ? v.factor : NaN } : null;
  const decision = decide(geo, vision ? visionSummary(vision) : null, {
    cameraHeight: report.geometry?.cameraHeight,
  });
  const floorOffsetMeters = floorOffsetOf(report);
  const { floorOffsetMeters: _old, ...rest } = report;
  return {
    ...rest,
    decision,
    calibration: {
      factor: decision.factor,
      method: decision.method,
      confidence: decision.confidence,
      evidence: evidenceText(geo, report.geometry?.measurements ?? [], vision, decision),
      headline: headline(geo, vision, decision),
    },
    ...(floorOffsetMeters !== undefined ? { floorOffsetMeters } : {}),
  };
}

// ---------------------------------------------------------------------------
// Report text
// ---------------------------------------------------------------------------

export function formatReport(r: CalibrationReport, name = r.worldId ?? 'world'): string {
  const L: string[] = [];
  L.push(`Scale calibration: ${name}`);
  L.push(
    `  Marble metric_scale_factor ${r.metricScaleFactor.toFixed(4)}, ground_plane_offset ${r.groundPlaneOffset.toFixed(4)} (${r.interior ? 'interior' : 'exterior'})`,
  );
  if (r.geometry) {
    const g = r.geometry;
    L.push(
      `  floor near the camera ${g.floorAtCamera >= 0 ? '+' : ''}${g.floorAtCamera.toFixed(2)} m vs Marble's ground plane; camera ${g.cameraHeight.toFixed(2)} m above it`,
    );
    L.push("    (the collider is coarse: outdoors it sits ~0.1 m below the splats, so it is not the floor offset)");
  } else L.push('  collider: none');
  {
    const gr = r.ground;
    if (gr)
      L.push(
        `  splat ground: ${gr.probes.map((p) => `(${p.x}, ${p.z}) ${p.height === null ? '—' : `${p.height >= 0 ? '+' : ''}${p.height.toFixed(3)} m`} [${p.splats}]`).join(', ')} → ${gr.height === null ? 'unmeasurable' : `${gr.height.toFixed(3)} m`}`,
      );
    const off = floorOffsetOf(r);
    L.push(
      off === undefined
        ? `  floor offset: not written (${gr ? 'implausible or unmeasurable ground' : 'no splat ground measured'})`
        : `  floor offset: floorOffsetMeters ${off.toFixed(3)} (the world is raised by that much so the visible ground is y = 0)`,
    );
  }
  if (r.geometry) {
    const g = r.geometry;
    L.push('  collider (Marble scale)   measured   expected (range)        implied   weight');
    for (const m of g.measurements) {
      // a stored report keeps the eye-height band it was measured with; show today's prior
      const e = m.kind === 'camera' ? EXPECTED.camera : m.expected;
      const implied = m.kind === 'camera' ? e.typ / m.measured : m.implied;
      L.push(
        `    ${EXPECTED[m.kind].label.padEnd(22)} ${`${m.measured.toFixed(2)} m`.padStart(8)}   ${`${e.typ.toFixed(2)} (${e.lo.toFixed(2)}–${e.hi.toFixed(2)})`.padEnd(22)} ×${implied.toFixed(3)}   ${m.weight.toFixed(2)}${m.note ? `  ${m.note}` : ''}`,
      );
    }
    L.push(`    → ${g.estimate.available ? `×${g.estimate.factor.toFixed(3)}, ` : 'unavailable: '}${g.estimate.note}`);
  }
  if (r.vision) {
    L.push(`  vision (claude-opus-5-5, ${r.vision.runs.length} runs, $${r.vision.costUsd.toFixed(3)}):`);
    r.vision.runs.forEach((run, i) => {
      const label = run.views.map((v) => {
        const vv = r.vision!.views[v];
        return vv?.closeupOf ? `close-up "${vv.closeupOf.slice(0, 30)}"` : `${vv?.yawDeg}°`;
      });
      L.push(
        `    run ${i + 1} (${label.join(', ')}): ×${fx(run.factor)} (eyeballed only ×${fx(run.eyeballed)}); Claude overall ×${fx(run.answer.overallCorrection, 2)} conf ${fx(run.answer.confidence, 2)}`,
      );
      for (const o of run.objects)
        L.push(
          `      ${o.object.slice(0, 46).padEnd(46)} typ ${o.typicalMeters.toFixed(2)} | looks ${o.apparentMeters.toFixed(2)} by ${o.comparedTo.slice(0, 12)} | ${o.measured ? (o.measured.ok ? `measured ${fx(o.measured.height, 2)} m @${fx(o.measured.distance, 1)} m` : `no measure: ${o.measured.note}`) : 'not measured'} → ×${o.vote.toFixed(2)} ${o.source} (w ${o.weight.toFixed(2)})`,
        );
      const dropped = run.answer.objects.length - run.objects.length;
      if (dropped) L.push(`      (${dropped} more object(s) below confidence 0.3 or inconsistent)`);
      L.push(`      floor contact: ${run.answer.floorContact.slice(0, 160)}`);
    });
    L.push(`    → ${r.vision.note}`);
  } else L.push(`  vision: ${r.visionSkipped ?? 'skipped'}`);
  const d = r.decision;
  if (d.sources?.length) {
    L.push('  weighed (no collider estimate)   factor    σ      weight');
    const total = d.sources.reduce((s, x) => s + 1 / x.sigma ** 2, 0);
    for (const s of d.sources)
      L.push(
        `    ${s.kind.padEnd(29)} ×${s.factor.toFixed(3)}   ${pct(s.sigma).padStart(3)}   ${((1 / s.sigma ** 2 / total) * 100).toFixed(0).padStart(3)}%   ${s.note}`,
      );
    if (finite(d.sigma) && finite(d.candidate))
      L.push(
        `    → ×${d.candidate.toFixed(3)} ± ${pct(d.sigma)} (${(Math.abs(Math.log(d.candidate)) / d.sigma).toFixed(1)}σ from Marble's scale)`,
      );
  }
  L.push(
    `  decision: ${d.applied ? `APPLY ×${d.factor.toFixed(3)}` : 'keep Marble scale (×1)'}  confidence ${d.confidence}  [${d.method}]${typeof d.candidate === 'number' && Number.isFinite(d.candidate) ? `  candidate ×${fx(d.candidate)}` : ''}`,
  );
  L.push(`    ${d.reason}`);
  L.push(`  headline: ${r.calibration.headline ?? r.calibration.evidence.split(' · ')[0]}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface WriteOptions {
  /** Also update the world-library copy with the same worldId (default: none). */
  libraryDir?: string | null;
  /** Also patch ../manifest.json when it shows this world (CLI on an existing project). */
  manifest?: boolean;
  /** Blocking marks (xz, scene metres): the ground field's grid grows to include them. */
  marks?: readonly (readonly [number, number])[];
  log?: (m: string) => void;
}

/** What a report writes into a WorldAsset: scaleCalibration and, when measured, floorOffsetMeters. */
export function calibrated(asset: WorldAsset, report: CalibrationReport): WorldAsset {
  const { floorOffsetMeters: _old, ...rest } = asset;
  const off = report.floorOffsetMeters ?? floorOffsetOf(report);
  return { ...rest, scaleCalibration: report.calibration, ...(off !== undefined ? { floorOffsetMeters: off } : {}) };
}

/**
 * `ground` (world-dir-relative, as in world-asset.json) re-based for a manifest whose world paths
 * carry a project prefix (scene-<n>/world/), read off its k500 path; undefined removes it.
 */
export function manifestGround(manifestWorld: WorldAsset, asset: WorldAsset): WorldAsset['ground'] {
  if (!asset.ground) return undefined;
  const k500 = manifestWorld.spz.k500;
  const prefix = k500.endsWith(asset.spz.k500) ? k500.slice(0, k500.length - asset.spz.k500.length) : '';
  return { ...asset.ground, file: prefix + asset.ground.file };
}

/**
 * Writes scaleCalibration + floorOffsetMeters into world-asset.json (+ the full report), measures
 * the ground height field again (ground.json, calibrate-ground.ts; local, ~1 s) and writes all of
 * it into the library copy and the manifest.
 */
export async function writeCalibration(
  worldDir: string,
  report: CalibrationReport,
  o: WriteOptions = {},
): Promise<WorldAsset> {
  const log = o.log ?? (() => {});
  let asset = WorldAsset.parse(calibrated(await readWorldAsset(worldDir), report));
  try {
    asset = await writeGroundField(worldDir, asset, { marks: o.marks, log });
  } catch (e) {
    log(`ground field not measured (${(e as Error).message.slice(0, 120)}); actors stand on the median floor`);
  }
  await writeJsonAtomic(join(worldDir, ASSET_FILE), asset);
  await writeJsonAtomic(join(worldDir, REPORT_FILE), report);
  const withField = (a: WorldAsset, ground: WorldAsset['ground']): WorldAsset => {
    const { ground: _old, ...rest } = a;
    return ground ? { ...rest, ground } : rest;
  };
  if (o.libraryDir && asset.worldId) {
    const names = await readdir(o.libraryDir).catch(() => [] as string[]);
    for (const n of names) {
      const dir = join(o.libraryDir, n);
      if (dir === worldDir) continue;
      const lib = WorldAsset.safeParse(await readJson(join(dir, ASSET_FILE)).catch(() => undefined));
      if (!lib.success || lib.data.worldId !== asset.worldId) continue;
      if (asset.ground) await copyFile(join(worldDir, asset.ground.file), join(dir, asset.ground.file));
      await writeJsonAtomic(join(dir, ASSET_FILE), withField(calibrated(lib.data, report), asset.ground));
      await copyFile(join(worldDir, REPORT_FILE), join(dir, REPORT_FILE));
      log(`calibrate: library copy ${n} updated`);
    }
  }
  if (o.manifest) {
    const mpath = join(dirname(worldDir), 'manifest.json');
    const m = (await exists(mpath)) ? await readJson<{ world?: WorldAsset }>(mpath) : undefined;
    if (m?.world && m.world.worldId === asset.worldId) {
      m.world = withField(calibrated(m.world, report), manifestGround(m.world, asset));
      await writeJsonAtomic(mpath, m);
      log(`calibrate: ${mpath} updated`);
    }
  }
  return asset;
}

/**
 * A previous run's result for this world (scale-calibration.json with the same worldId), so a
 * re-downloaded world-asset.json gets its calibration back without measuring (or paying) again.
 */
export async function previousCalibration(worldDir: string, worldId?: string): Promise<CalibrationReport | null> {
  const r = await readJson<CalibrationReport>(join(worldDir, REPORT_FILE)).catch(() => undefined);
  return r?.schema === 'previz.scale-calibration/1' && r.worldId === worldId && r.calibration ? r : null;
}

// ---------------------------------------------------------------------------
// Before / after picture
// ---------------------------------------------------------------------------

export interface BeforeAfterOptions {
  log?: (m: string) => void;
  openRenderer?: (dir: string, asset: WorldAsset) => Promise<WorldRenderer>;
  /**
   * The stored report a `--reuse` re-decided: the left panel then shows ITS decision (old rule
   * vs new rule) instead of plain Marble scale.
   */
  previous?: Pick<CalibrationReport, 'decision' | 'calibration'>;
}

/** The reference the before/after picture is built around: where it is and what it is. */
interface Showcase {
  view: PlannedView;
  /** "by the counter (collider 0.95 m)" */
  where: string;
}

/** "white interior door directly behind mannequin A" → "white interior door". */
export function shortName(object: string): string {
  const head = object
    .split(/[,(;]/)[0]!
    .split(/\s+(?:to|beside|behind|left|right|at|on|in|near|across|directly|with|under|above|of|just|next|from|seen)\b/)[0]!
    .trim();
  return head.split(/\s+/).slice(0, 4).join(' ') || object.slice(0, 24);
}

/**
 * A camera + mannequin set-up next to the strongest reference: a located collider reference
 * (counter, table, door, bench… — the mannequin in front of it, the camera 2–3.2 m back inside
 * free space with a clear line of sight), else the vision close-up, else the strongest vision
 * object found on the floor, else the first overview view.
 */
function showcase(report: CalibrationReport, geo3: { grid: TriGrid; cast: RayCast; cameraY: number }): Showcase | null {
  const refs = (report.geometry?.measurements ?? [])
    .filter((m) => m.where && m.weight >= 0.3 && m.kind !== 'ceiling' && m.kind !== 'camera')
    .sort((a, b) => b.weight - a.weight);
  for (const m of refs) {
    const [wx, wz] = m.where!;
    const [fx0, fz0] = m.front ?? [-wx, -wz];
    const fl = Math.hypot(fx0, fz0) || 1;
    const [fx, fz] = [fx0 / fl, fz0 / fl];
    // stand in front of it; for a door, just inside the room
    let spot: [number, number] | null = null;
    for (const off of [0.6, 0.8, 1.0, 1.3]) {
      spot = standingSpotNear(geo3.grid, wx + fx * off, wz + fz * off);
      if (spot) break;
    }
    if (!spot) continue;
    const fy = floorAt(geo3.grid, spot[0], spot[1]) ?? 0;
    const topY = fy + m.measured;
    for (const dist of [3.2, 2.6, 2.0])
      for (const turn of [35, -35, 55, -55, 15, -15]) {
        const a = Math.atan2(fx, fz) + (turn * Math.PI) / 180;
        const cx = spot[0] + Math.sin(a) * dist;
        const cz = spot[1] + Math.cos(a) * dist;
        const cf = floorAt(geo3.grid, cx, cz);
        if (cf === null || !standingSpotNear(geo3.grid, cx, cz)) continue;
        const cam: [number, number, number] = [cx, cf + 1.45, cz];
        const sees = (p: [number, number, number]) => {
          const d = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
          const len = Math.hypot(...d);
          const h = geo3.cast(cam, [d[0]! / len, d[1]! / len, d[2]! / len], len);
          return h === null || h > len - 0.35;
        };
        if (!sees([spot[0], fy + 1.2, spot[1]]) || !sees([wx, topY, wz])) continue;
        const tx = (spot[0] + wx) / 2 - cam[0];
        const ty = fy + 0.9 - cam[1];
        const tz = (spot[1] + wz) / 2 - cam[2];
        return {
          where: `by the ${EXPECTED[m.kind].label} (collider ${m.measured.toFixed(2)} m)`,
          view: {
            yawDeg: (Math.atan2(-tx, -tz) * 180) / Math.PI,
            pitchDeg: (Math.atan2(ty, Math.hypot(tx, tz)) * 180) / Math.PI,
            fovDeg: 75,
            camera: cam,
            figures: [{ x: spot[0], z: spot[1], y: fy, name: 'A', label: '1.70 m', distance: dist }],
          },
        };
      }
  }
  const views = report.vision?.views ?? [];
  const close = views.find((v) => v.closeupOf);
  if (close) return { view: close, where: `by the ${shortName(close.closeupOf!)} (vision close-up)` };
  const objs = (report.vision?.runs ?? []).flatMap((r) => r.located).sort((a, b) => b.sizeConfidence - a.sizeConfidence);
  // a standard object first; else whatever vision measured (a parapet, a shelter's ad panel):
  // judging the mannequin next to it beats judging it against a far-away street
  const planned = objs.length ? (planCloseups(geo3, objs, 1)[0] ?? planCloseups(geo3, objs, 1, 0.2)[0]) : undefined;
  if (planned) return { view: planned, where: `by the ${shortName(planned.closeupOf!)}` };
  const v = views.find((x) => x.figures.length && !x.closeupOf) ?? planViews(geo3, 1)[0];
  return v
    ? { view: { ...v, figures: v.figures.slice(0, 1) }, where: `2.5 m in front of the source camera (no standard object close enough)` }
    : null;
}

/**
 * Side by side, the 1.70 m mannequin next to the strongest reference at Marble's scale and at
 * the calibrated one (or, when nothing was applied, at the candidate the evidence pointed to,
 * labelled as not applied). The camera scales with the world, so the world looks the same in
 * both panels and only the mannequin's size relative to it changes.
 */
export async function renderBeforeAfter(
  worldDir: string,
  report: CalibrationReport,
  outPng: string,
  o: BeforeAfterOptions = {},
): Promise<void> {
  const asset = await readWorldAsset(worldDir);
  const tris = await colliderMetric(worldDir, asset);
  if (!tris) throw new Error('no collider: cannot place the mannequin');
  const geo3 = { grid: new TriGrid(tris), cast: new RayGrid(tris).cast, cameraY: asset.groundPlaneOffset };
  const sc = showcase(report, geo3);
  if (!sc) throw new Error('no free floor for the mannequin');
  const d = report.decision;
  const vf = report.vision?.factor;
  const after = d.applied ? d.factor : finite(d.candidate) ? d.candidate : finite(vf) ? vf : 1;
  const prev = o.previous;
  const beforeFactor = prev && finite(prev.decision.factor) ? prev.decision.factor : 1;
  const v = sc.view;
  const shotAt = (factor: number) => ({
    factor,
    camera: {
      position: v.camera.map((c) => c * factor) as [number, number, number],
      yawDeg: v.yawDeg,
      pitchDeg: v.pitchDeg,
      fovDeg: v.fovDeg,
    },
    figures: v.figures.map((f) => ({ x: f.x * factor, z: f.z * factor, y: (f.y ?? 0) * factor, label: '1.70 m' })),
    width: 960,
    height: 720,
    ruler: true,
  });
  const renderer = await (o.openRenderer ?? ((dd, aa) => openWorldRenderer(dd, aa, { log: o.log })))(worldDir, asset);
  try {
    const before = await renderer.shot(shotAt(beforeFactor));
    const afterPng = await renderer.shot(shotAt(after));
    const meas = (report.geometry?.measurements ?? []).filter((m) => m.kind !== 'camera');
    const vis = (report.vision?.runs ?? [])
      .flatMap((r) => r.objects)
      .filter((x) => x.source === 'measured')
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 4);
    const footer = [
      meas.length
        ? `collider @ Marble scale: ${meas.map((m) => `${EXPECTED[m.kind].label} ${m.measured.toFixed(2)} m (typ ${m.expected.typ.toFixed(2)})`).join(' · ')}`
        : 'collider: no usable reference (coarse outdoor mesh)',
      vis.length
        ? `vision, measured from pixels: ${vis.map((x) => `${shortName(x.object)} ${x.measured!.height.toFixed(2)} m (typ ${x.typicalMeters.toFixed(2)})`).join(' · ')}`
        : `vision: ${report.vision?.note ?? report.visionSkipped ?? 'skipped'}`,
      ...(prev
        ? [`previous rule: ${prev.decision.applied ? `apply ×${prev.decision.factor.toFixed(3)}` : 'keep Marble scale'} (${prev.decision.confidence}) — ${prev.decision.reason}`]
        : []),
      `${prev ? 'new rule' : 'decision'}: ${d.applied ? `apply ×${d.factor.toFixed(3)}` : 'keep Marble scale'} (${d.confidence} confidence) — ${d.reason}`,
    ];
    const keptTitle = `×${after.toFixed(2)} — NOT applied (kept ×1.00)`;
    const png = await renderer.compose(
      [
        prev
          ? {
              image: before,
              title: `Previous rule: ×${beforeFactor.toFixed(2)} ${prev.decision.applied ? 'applied' : 'kept'} (${prev.decision.confidence})`,
              subtitle: `1.70 m mannequin ${sc.where} · HUD "${prev.calibration.headline ?? prev.calibration.evidence.split(' · ')[0]}"`,
            }
          : { image: before, title: 'Before: Marble scale ×1.00', subtitle: `1.70 m mannequin ${sc.where}` },
        {
          image: afterPng,
          title: d.applied
            ? `${prev ? 'New rule' : 'After'}: calibrated ×${after.toFixed(2)}`
            : prev
              ? `New rule: kept ×1.00 (${d.confidence}) — ×${after.toFixed(2)} shown`
              : keptTitle,
          subtitle: d.applied
            ? `${report.calibration.evidence.split(' · ')[0]} · ${d.confidence} confidence`
            : Math.abs(after - 1) < 1e-3
              ? 'no correction suggested'
              : `what the ${finite(d.candidate) ? 'measured candidate' : 'weak vision estimate'} would look like`,
        },
      ],
      footer,
    );
    await writeFile(outPng, png);
  } finally {
    await renderer.close();
  }
}

/** A free, floored standing spot within 0.6 m of (x, z), or null. */
function standingSpotNear(grid: TriGrid, x: number, z: number): [number, number] | null {
  for (const r of [0, 0.2, 0.4, 0.6])
    for (let k = 0; k < (r ? 8 : 1); k++) {
      const px = x + r * Math.cos((k * Math.PI) / 4);
      const pz = z + r * Math.sin((k * Math.PI) / 4);
      const local = grid.around(px, pz);
      if (hasFloor(local, px, pz) && !spotBlocked(local, px, pz, 'standing')) return [px, pz];
    }
  return null;
}
