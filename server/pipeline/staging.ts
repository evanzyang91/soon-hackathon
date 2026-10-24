// Staging: each character's mark moved onto the generated set where it makes sense (on the
// sidewalk by the shelter instead of in the road, at the counter, in the doorway), facing whom
// they talk to, visible from the director's start camera and not behind one another.
//
//   1. the set's collider in the viewer's frame (scale calibrated, floor offset applied)
//   2. staging-vision.ts planMarks: labelled rings on free ground the start camera can see, at
//      the height of the visible ground (groundHeights)
//   3. renders (calibrate-render.ts): from the start camera a clean plate and the rings, and the
//      rings from beside it (depth)
//   4. a Claude request (structured output): per character a mark (or a feet / seat pixel),
//      facing, pose, a one-line note; resolveAnswer converts and validates it against the
//      collider
//   5. a second request that shows that answer rendered with mannequins on its marks, plus any
//      failures from 4, to keep or fix (the collider cannot see a raised ad panel, glass or a
//      sign in front of someone; a look can). The last answer that passes the checks wins; none
//      → the planner's blocking is kept and the report says why
//
// The result is scene-<n>/staging.json (StagingReport). project.ts runs this right after the scale
// calibration of a live Marble world (never in MOCK, never without ANTHROPIC_API_KEY), reuses the
// file while its inputs (world id, the scene's blocking/action/cast) are unchanged, and writes the
// staged blocking into manifest.plan.blocking; plan.json keeps the planner's. Marks are in final
// metres at the factor they were staged at; a later calibration factor rescales them (the world
// scales about the source camera in xz), no new request. `cli.ts stage` runs it on an existing
// project scene and renders the before/after picture.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type Anthropic from '@anthropic-ai/sdk';
import { sampleGround, validateGroundField } from '../../shared/ground.ts';
import { SceneManifest, WorldAsset, type Blocking, type Character, type ScenePlan, type Vec3 } from '../../shared/schema.ts';
import type { ScaleFigure, ScaleMark } from '../../web/src/viewer/dev/scale-shot.ts';
import { TriGrid } from '../../web/src/viewer/placement.ts';
import { applyWorldTransform, calibrationFactor, floorOffset, worldTransform } from '../../web/src/viewer/transform.ts';
import { colliderMetric, previousCalibration, readWorldAsset, redecide, withGround, writeCalibration } from './calibrate.ts';
import { measureGround, writeGroundField } from './calibrate-ground.ts';
import { RayGrid } from './calibrate-geometry.ts';
import { openWorldRenderer, type WorldRenderer } from './calibrate-render.ts';
import { costOf, floorAt, IMAGE, projectPoint } from './calibrate-vision.ts';
import { exists, readJson, writeJsonAtomic } from './fsutil.ts';
import { ASSET_FILE } from './marble.ts';
import { decodeSpz } from './spz.ts';
import { round3 } from './geometry.ts';
import {
  chooseFraming,
  defaultStagingCall,
  marksSeenFrom,
  nearestMark,
  resolveAnswer,
  reviewText,
  sideView,
  STAGING_MODEL,
  STAGING_SYSTEM,
  StagingAnswer,
  stagingUserText,
  type Mark,
  type Resolved,
  type StagedCharacter,
  type StagingCall,
  type StagingGeometry,
  type View,
} from './staging-vision.ts';

export const STAGING_FILE = 'staging.json';
/** Bump when the marks, prompt or rules change enough that earlier staging should be redone. */
export const STAGING_VERSION = 1;

type Usage = { input: number; output: number; costUsd: number };

export interface StagingAttempt {
  answer: StagingAnswer | null;
  /** the answer's spots that converted (shown as mannequins in the next attempt's preview) */
  staged?: StagedCharacter[];
  failures: string[];
  warnings: string[];
  usage: Usage;
  error?: string;
}

export interface StagingReport {
  schema: 'previz.staging/1';
  version: number;
  /** world id + the scene's blocking, action, cast (stagingInputsHash) */
  inputsHash: string;
  worldId?: string;
  /** scale calibration factor the marks are in (they scale with the world about the camera) */
  factor: number;
  createdAt: string;
  model: string;
  /** staged: `blocking` is Claude's, validated; kept: the planner's blocking stays (see reason) */
  status: 'staged' | 'kept';
  reason?: string;
  view: View;
  marks: Mark[];
  /** the planner's blocking (plan.json) */
  original: Blocking[];
  /** what the manifest uses */
  blocking: Blocking[];
  characters: StagedCharacter[];
  /** Claude's reading of the set's walkable layout */
  set?: string;
  attempts: StagingAttempt[];
  usage: Usage;
}

/** What staging depends on: a change to any of it means staging again. */
export function stagingInputsHash(o: { worldId?: string; scene: ScenePlan; characters: Character[] }): string {
  const cast = o.characters.filter((c) => o.scene.characterIds.includes(c.id));
  const key = {
    v: STAGING_VERSION,
    world: o.worldId ?? null,
    heading: o.scene.heading,
    action: o.scene.action,
    cast: cast.map((c) => [c.id, c.description]),
    blocking: o.scene.blocking.map((b) => [b.characterId, b.position, b.yaw, b.pose]),
  };
  return createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 16);
}

/** The provider caption: world-asset.json's, else the Marble world record's (assets.caption). */
export async function worldCaption(worldDir: string, asset: WorldAsset): Promise<string | undefined> {
  if (asset.caption?.trim()) return asset.caption.trim();
  const meta = await readJson<{ caption?: unknown; assets?: { caption?: unknown }; world_prompt?: { text_prompt?: unknown } }>(
    join(worldDir, 'marble-world.json'),
  ).catch(() => undefined);
  const c = meta?.caption ?? meta?.assets?.caption ?? meta?.world_prompt?.text_prompt;
  return typeof c === 'string' && c.trim() ? c.trim().slice(0, 2000) : undefined;
}

/**
 * The collider in the viewer's frame: Marble metric × calibration factor, raised by the floor
 * offset like the splats (transform.ts), so the placement probes match what world.ts runs at load.
 */
export async function stagingGeometry(worldDir: string, asset: WorldAsset): Promise<StagingGeometry | null> {
  const factor = calibrationFactor(asset);
  const tris = await colliderMetric(worldDir, asset, factor);
  if (!tris) return null;
  const lift = factor * floorOffset(asset);
  if (lift) for (let i = 1; i < tris.length; i += 3) tris[i]! += lift;
  return { grid: new TriGrid(tris), cast: new RayGrid(tris).cast };
}

/**
 * Height of the VISIBLE ground (viewer frame) at each xz: the world's ground field when it has one
 * (WorldAsset.ground, shared/ground.ts), else the densest opaque-splat layer in a 0.25 m column
 * (calibrate-ground.ts measureGround), else the collider floor. The collider smears steps (a kerb
 * becomes a 0.5 m ramp) and sits up to ~0.1 m under the splats outdoors, which is enough to draw a
 * ring or a mannequin's feet on the wrong side of a kerb.
 */
export async function groundHeights(
  worldDir: string,
  asset: WorldAsset,
  geo: StagingGeometry,
  pts: readonly (readonly [number, number])[],
): Promise<number[]> {
  const f = calibrationFactor(asset);
  const lift = floorOffset(asset);
  const collider = (x: number, z: number) => floorAt(geo.grid, x, z) ?? 0;
  if (asset.ground) {
    const field = await readJson(join(worldDir, asset.ground.file.split('/').pop()!))
      .then((d) => validateGroundField(d))
      .catch(() => null);
    if (field)
      return pts.map(([x, z]) => {
        const h = sampleGround(field, x / f, z / f);
        return h === null ? collider(x, z) : f * (h + lift);
      });
  }
  let splat: (number | null)[] = pts.map(() => null);
  try {
    const { splats } = decodeSpz(new Uint8Array(await readFile(join(worldDir, asset.spz.k500))));
    const t = worldTransform({ ...asset, floorOffsetMeters: 0, scaleCalibration: null });
    const positions = new Float32Array(splats.length * 3);
    const opacities = new Float32Array(splats.length);
    splats.forEach((sp, i) => {
      positions.set(applyWorldTransform(t, sp.position), 3 * i);
      opacities[i] = sp.opacity;
    });
    const m = measureGround(positions, opacities, pts.map(([x, z]) => ({ x: x / f, z: z / f, r: 0.25 })));
    splat = m.probes.map((p) => (p.height === null ? null : f * (p.height + lift)));
  } catch {
    /* no SPZ: the collider it is */
  }
  return pts.map(([x, z], i) => {
    const c = collider(x, z);
    const h = splat[i];
    // a splat layer far from the collider is a table top or a puddle's reflection: keep the collider
    return h === null || h === undefined || Math.abs(h - c) > 0.3 ? c : h;
  });
}

/** Labelled, tinted mannequins on staged spots (seated ones with their feet on the floor). */
async function stagedFigures(
  worldDir: string,
  asset: WorldAsset,
  geo: StagingGeometry,
  staged: readonly Pick<StagedCharacter, 'characterId' | 'position' | 'pose'>[],
  marks: Mark[],
  characters: readonly Character[],
): Promise<ScaleFigure[]> {
  const ys = await groundHeights(worldDir, asset, geo, staged.map((c) => [c.position[0], c.position[2]] as const));
  return staged.map((c, i) => {
    const sitting = c.pose === 'sitting';
    const y = sitting ? (nearestMark(marks, c.position[0], c.position[2])?.mark.y ?? 0) : ys[i]!;
    const tall = characters.find((ch) => ch.id === c.characterId)?.heightMeters;
    return {
      x: c.position[0],
      z: c.position[2],
      y,
      label: c.characterId,
      tint: PALETTE[i % PALETTE.length]!,
      ...(tall ? { heightMeters: tall } : {}),
      ...(sitting ? { pose: 'sitting' as const } : {}),
    };
  });
}

export interface StageOptions {
  worldDir: string;
  /** default: world-asset.json in worldDir */
  asset?: WorldAsset;
  scene: ScenePlan;
  /** the project's characters (descriptions); filtered to the scene's cast */
  characters: Character[];
  log?: (m: string) => void;
  call?: StagingCall;
  openRenderer?: (dir: string, asset: WorldAsset) => Promise<WorldRenderer>;
  /** keep the images Claude saw here (staging-clean.jpg, staging-marks.jpg, staging-left.jpg, …) */
  saveViewsTo?: string;
  /**
   * Second request even when the first answer passes the checks: Claude looks at mannequins on
   * its marks and keeps or fixes them (default true; false = one request unless it failed).
   */
  review?: boolean;
}

/** A render request for the staging view, in the harness's frame (no floor offset applied). */
function shotOf(asset: WorldAsset, view: View, o: { figures?: ScaleFigure[]; marks?: ScaleMark[]; width?: number; height?: number; format?: 'png' | 'jpeg' }) {
  const lift = calibrationFactor(asset) * floorOffset(asset);
  return {
    factor: calibrationFactor(asset),
    camera: { position: [view.camera[0], view.camera[1] - lift, view.camera[2]] as Vec3, yawDeg: view.yawDeg, pitchDeg: view.pitchDeg, fovDeg: view.fovDeg },
    figures: (o.figures ?? []).map((f) => ({ ...f, y: (f.y ?? 0) - lift })),
    marks: (o.marks ?? []).map((m) => ({ ...m, y: m.y - lift })),
    width: o.width ?? IMAGE.width,
    height: o.height ?? IMAGE.height,
    format: o.format ?? 'png',
  };
}

/**
 * Stages one scene on its world (see the header). Never writes; throws only when the world cannot
 * be staged at all (no collider, nothing free in view, render or request failure).
 */
export async function stageScene(o: StageOptions): Promise<StagingReport> {
  const log = o.log ?? (() => {});
  const asset = o.asset ?? (await readWorldAsset(o.worldDir));
  const geo = await stagingGeometry(o.worldDir, asset);
  if (!geo) throw new Error('no collider mesh to stand the actors on');
  const cast = o.characters.filter((c) => o.scene.characterIds.includes(c.id));
  if (!cast.length) throw new Error('no characters in the scene');
  const { framing, view, marks } = chooseFraming(geo, Math.max(6, 3 * cast.length));
  if (framing !== 'standard') log(`staging: small free floor in front of the camera; ${framing} framing (${view.fovDeg}° wide, ${-view.pitchDeg}° down)`);
  if (marks.length < cast.length) throw new Error(`only ${marks.length} free spot(s) in view for ${cast.length} character(s)`);
  const caption = await worldCaption(o.worldDir, asset);
  // rings on the visible ground (see groundHeights), re-projected
  const heights = await groundHeights(o.worldDir, asset, geo, marks.map((m) => [m.x, m.z] as const));
  marks.forEach((m, i) => {
    m.y = round3(heights[i]!);
    const px = projectPoint(view, [m.x, m.y, m.z]);
    if (px) m.px = [Math.round(px[0]), Math.round(px[1])];
  });

  const renderer = await (o.openRenderer ?? ((d, a) => openWorldRenderer(d, a, { log })))(o.worldDir, asset);
  const image = (b: Buffer): Anthropic.Beta.BetaContentBlockParam => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: b.toString('base64') },
  });
  const schema = betaZodOutputFormat(StagingAnswer).schema as Record<string, unknown>;
  const baseText = stagingUserText({ scene: o.scene, characters: o.characters, caption, marks, view });
  const call = o.call ?? defaultStagingCall;
  const attempts: StagingAttempt[] = [];
  /** the last answer that passed every check, with its conversion */
  let accepted: { attempt: StagingAttempt; resolved: Resolved } | undefined;
  try {
    // depth views: the same marks from beside the camera, raised (each draws only what it sees)
    const spots = marks.map((m) => [m.x, m.z] as const);
    const sides = ([-1, 1] as const).flatMap((side) => {
      const v = sideView(geo, spots, side, { fovDeg: 84 });
      const seen = v ? marksSeenFrom(geo, v, marks) : [];
      const where = `from ${Math.abs(v?.camera[0] ?? 0)} m ${side < 0 ? 'left' : 'right'} of the main camera, ${v?.camera[1] ?? 0} m up`;
      return v && seen.length >= 3 ? [{ side, view: v, marks: seen, name: side < 0 ? 'left' : 'right', where }] : [];
    });
    // rings sized to the grid so neighbours do not overlap (0.25 m grid in a small room)
    const ring = (ms: Mark[]) => ms.map((m) => ({ ...m, radius: framing === 'cramped' ? 0.07 : 0.14 }));
    const images: { name: string; caption: string; jpeg: Buffer }[] = [
      { name: 'clean', caption: 'main camera, clean', jpeg: await renderer.shot(shotOf(asset, view, { format: 'jpeg' })) },
      { name: 'marks', caption: 'main camera, marks', jpeg: await renderer.shot(shotOf(asset, view, { marks: ring(marks), format: 'jpeg' })) },
    ];
    for (const sv of sides)
      images.push({ name: sv.name, caption: `${sv.where} (the marks it sees)`, jpeg: await renderer.shot(shotOf(asset, sv.view, { marks: ring(sv.marks), format: 'jpeg' })) });
    if (o.saveViewsTo) for (const im of images) await writeFile(join(o.saveViewsTo, `staging-${im.name}.jpg`), im.jpeg);
    const blocks = (ims: { caption: string; jpeg: Buffer }[], first: number) =>
      ims.flatMap((im, i): Anthropic.Beta.BetaContentBlockParam[] => [{ type: 'text', text: `Image ${first + i} (${im.caption}):` }, image(im.jpeg)]);

    // 1: choose. 2: check — the first answer rendered with mannequins on its marks (main view and
    // one side view) plus whatever the checks found, so problems the collider cannot see (a
    // raised ad panel, glass, a thin post in front of someone) are caught by looking.
    for (let k = 0; k < 2; k++) {
      const prev = attempts[k - 1];
      let content: Anthropic.Beta.BetaContentBlockParam[] = [...blocks(images, 1), { type: 'text', text: baseText }];
      if (prev?.answer) {
        const shown = prev.staged ?? [];
        const figures = await stagedFigures(o.worldDir, asset, geo, shown, marks, o.characters);
        const preview = [{ name: 'preview-main', caption: 'your previous answer from the main camera, mannequins on its marks', jpeg: await renderer.shot(shotOf(asset, view, { figures, format: 'jpeg' })) }];
        const sv = sides[0];
        const side = sv && shown.length ? sideView(geo, shown.map((c) => [c.position[0], c.position[2]] as const), sv.side, { fovDeg: 84 }) : null;
        if (side) preview.push({ name: 'preview-side', caption: `your previous answer ${sv!.where}`, jpeg: await renderer.shot(shotOf(asset, side, { figures, format: 'jpeg' })) });
        if (o.saveViewsTo) for (const im of preview) await writeFile(join(o.saveViewsTo, `staging-${im.name}.jpg`), im.jpeg);
        const text = `${baseText}\n\n${reviewText(prev.answer, prev.failures, images.length + 1, preview.length)}`;
        content = [...blocks(images, 1), ...blocks(preview, images.length + 1), { type: 'text', text }];
      }
      const why = !k ? '' : prev?.failures.length ? ' again with the failures and a preview' : ' to check a preview of its marks';
      log(`staging: asking ${STAGING_MODEL} (${marks.length} marks, ${cast.length} character(s))${why}`);
      const attempt: StagingAttempt = { answer: null, failures: [], warnings: [], usage: { input: 0, output: 0, costUsd: 0 } };
      attempts.push(attempt);
      try {
        const msg = await call({ system: STAGING_SYSTEM, content, schema });
        attempt.usage = costOf(msg.usage);
        if (msg.stop_reason === 'refusal') throw new Error('staging request was declined');
        if (msg.stop_reason === 'max_tokens') throw new Error('staging answer was cut off (max_tokens)');
        const raw = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
        attempt.answer = StagingAnswer.parse(JSON.parse(raw));
      } catch (e) {
        // a declined, cut-off or unreadable answer: nothing to show or feed back
        attempt.error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        attempt.failures.push(`no usable answer: ${attempt.error}`);
        log(`staging: attempt ${k + 1} failed: ${attempt.error}`);
        break;
      }
      const resolved = resolveAnswer(attempt.answer, { scene: o.scene, marks, geo, view });
      attempt.failures = resolved.failures;
      attempt.warnings = resolved.warnings;
      attempt.staged = resolved.staged;
      if (!resolved.failures.length) accepted = { attempt, resolved };
      else log(`staging: attempt ${k + 1} not usable: ${resolved.failures.join('; ')}`);
      if (o.review === false && accepted) break;
    }
  } finally {
    await renderer.close();
  }

  const usage = attempts.reduce((t, a) => ({ input: t.input + a.usage.input, output: t.output + a.usage.output, costUsd: t.costUsd + a.usage.costUsd }), { input: 0, output: 0, costUsd: 0 });
  const last = attempts[attempts.length - 1]!;
  if (accepted && accepted.attempt !== last) log(`staging: the check's answer failed (${last.failures.join('; ')}); the first answer stands`);
  const set = (accepted?.attempt.answer ?? last.answer)?.set;
  const report: StagingReport = {
    schema: 'previz.staging/1',
    version: STAGING_VERSION,
    inputsHash: stagingInputsHash({ worldId: asset.worldId, scene: o.scene, characters: o.characters }),
    worldId: asset.worldId,
    factor: calibrationFactor(asset),
    createdAt: new Date().toISOString(),
    model: STAGING_MODEL,
    status: accepted ? 'staged' : 'kept',
    ...(accepted ? {} : { reason: `the planner's blocking is kept: ${last.failures.join('; ') || 'no usable answer'}` }),
    view,
    marks,
    original: o.scene.blocking,
    blocking: accepted ? accepted.resolved.blocking : o.scene.blocking,
    characters: accepted ? accepted.resolved.staged : [],
    ...(set ? { set } : {}),
    attempts,
    usage,
  };
  log(
    accepted
      ? `staging: ${report.characters.map((c) => `${c.characterId} → ${c.mark || c.source} (${c.position[0]}, ${c.position[2]}) ${c.pose}: ${c.note}`).join(' | ')} ($${usage.costUsd.toFixed(3)})`
      : `staging: ${report.reason} ($${usage.costUsd.toFixed(3)})`,
  );
  return report;
}

// ---------------------------------------------------------------------------
// Reading it back (pipeline + manifest)
// ---------------------------------------------------------------------------

export async function readStaging(sceneDir: string): Promise<StagingReport | undefined> {
  const r = await readJson<StagingReport>(join(sceneDir, STAGING_FILE)).catch(() => undefined);
  return r?.schema === 'previz.staging/1' && Array.isArray(r.blocking) ? r : undefined;
}

export const writeStaging = (sceneDir: string, report: StagingReport) => writeJsonAtomic(join(sceneDir, STAGING_FILE), report);

/**
 * A calibration factor this much off the one the marks were staged at means staging again: the
 * spots, distances and framing were judged at the wrong scale. Below it the marks are rescaled.
 */
export const RESTAGE_FACTOR_CHANGE = 0.1;

/**
 * The report still applies to this world and scene; with `factor` (the world's current
 * calibration), also to its scale within RESTAGE_FACTOR_CHANGE.
 */
export function stagingCurrent(
  report: StagingReport,
  o: { worldId?: string; scene: ScenePlan; characters: Character[]; factor?: number },
): boolean {
  if (report.version !== STAGING_VERSION || report.worldId !== o.worldId || report.inputsHash !== stagingInputsHash(o)) return false;
  return o.factor === undefined || Math.abs(o.factor / (report.factor > 0 ? report.factor : 1) - 1) <= RESTAGE_FACTOR_CHANGE;
}

/**
 * The blocking a manifest should carry: the staged marks when the report is current and staged,
 * rescaled from the factor they were staged at to the world's current one (within
 * RESTAGE_FACTOR_CHANGE); else undefined (keep the planner's until it is staged again).
 */
export function stagedBlocking(
  report: StagingReport | undefined,
  o: { asset: WorldAsset; scene: ScenePlan; characters: Character[] },
): Blocking[] | undefined {
  const factor = calibrationFactor(o.asset);
  if (!report || report.status !== 'staged' || !stagingCurrent(report, { worldId: o.asset.worldId, scene: o.scene, characters: o.characters, factor })) return undefined;
  const k = factor / (report.factor > 0 ? report.factor : 1);
  if (Math.abs(k - 1) < 1e-9) return report.blocking;
  return report.blocking.map((b) => ({ ...b, position: [round3(b.position[0] * k), b.position[1], round3(b.position[2] * k)] as Vec3 }));
}

/**
 * Where the floor and the ground field are measured for a scene: the staged marks, then the
 * planner's. The staged ones decide wherever their ground is measurable; the planner's (near the
 * camera) keep the floor offset defined when a staged mark is too far out to measure (the rooftop
 * parapet's splat columns are too sparse), so the world's reference does not vanish.
 */
export function groundMarks(staged: readonly Blocking[] | undefined, planner: readonly Blocking[]): (readonly [number, number])[] {
  return [...(staged ?? []), ...planner].map((b) => [b.position[0], b.position[2]] as const);
}

/**
 * After staging: the floor offset and the ground field measured where the actors now stand, by the
 * calibration's own path (calibrate.ts withGround + writeCalibration, which re-measures the field
 * with its grid grown to the marks; without a scale report, only the field). Staged marks can lie
 * outside the default field (x ±8, z -12..3 m at Marble's scale; the rooftop's parapet at ×0.778),
 * and floorOffsetMeters is by definition the ground at the marks. `manifest` also patches
 * ../manifest.json's world. Returns the new world-asset.json.
 */
export async function measureGroundAtMarks(
  worldDir: string,
  asset: WorldAsset,
  marks: readonly (readonly [number, number])[],
  o: { log?: (m: string) => void; manifest?: boolean } = {},
): Promise<WorldAsset> {
  const prev = asset.provider === 'marble' ? await previousCalibration(worldDir, asset.worldId) : null;
  if (prev) return writeCalibration(worldDir, await withGround(redecide(prev), worldDir, marks), { log: o.log, marks, manifest: o.manifest });
  const next = await writeGroundField(worldDir, asset, { marks, log: o.log });
  await writeJsonAtomic(join(worldDir, ASSET_FILE), next);
  return next;
}

/** Rewrites ../manifest.json's plan.blocking from a report (CLI --write on an existing project). */
export async function applyStagingToManifest(sceneDir: string, report: StagingReport, log: (m: string) => void = () => {}): Promise<boolean> {
  const path = join(sceneDir, 'manifest.json');
  if (!(await exists(path))) return false;
  const m = SceneManifest.safeParse(await readJson(path));
  if (!m.success) return false;
  if (m.data.world.worldId !== report.worldId) {
    log(`staging: ${path} shows another world (${m.data.world.worldId}); not changed`);
    return false;
  }
  const blocking = stagedBlocking(report, { asset: m.data.world, scene: { ...m.data.plan, blocking: report.original }, characters: m.data.characters });
  if (!blocking) return false;
  await writeJsonAtomic(path, SceneManifest.parse({ ...m.data, plan: { ...m.data.plan, blocking } }));
  return true;
}

// ---------------------------------------------------------------------------
// Text + before/after picture
// ---------------------------------------------------------------------------

const xz = (b: Pick<Blocking, 'position'>) => `(${b.position[0].toFixed(2)}, ${b.position[2].toFixed(2)})`;

export function formatStaging(r: StagingReport, name = r.worldId ?? 'world'): string {
  const L: string[] = [];
  L.push(`Staging: ${name} — ${r.status === 'staged' ? 'STAGED' : 'planner blocking kept'} (${r.marks.length} marks, ${r.attempts.length} request(s), ${r.usage.input} in / ${r.usage.output} out tokens, $${r.usage.costUsd.toFixed(3)})`);
  if (r.reason) L.push(`  ${r.reason}`);
  if (r.set) L.push(`  set: ${r.set}`);
  for (const o of r.original) {
    const s = r.characters.find((c) => c.characterId === o.characterId);
    const b = r.blocking.find((x) => x.characterId === o.characterId);
    const near = nearestMark(r.marks, o.position[0], o.position[2]);
    L.push(`  ${o.characterId}: planner ${xz(o)} ${o.pose}${near ? ` [~${near.mark.label}]` : ''} → ${b ? xz(b) : '—'} ${b?.pose ?? ''}${s ? ` [${s.mark || s.source}${s.nudged ? `, nudged ${s.nudged} m` : ''}] facing ${s.facing}` : ''}`);
    if (b?.note) L.push(`      note: ${b.note}`);
    if (s?.reasoning) L.push(`      why: ${s.reasoning}`);
  }
  r.attempts.forEach((a, i) => {
    if (a.failures.length) L.push(`  attempt ${i + 1} failures: ${a.failures.join('; ')}`);
    if (a.warnings.length) L.push(`  attempt ${i + 1} warnings: ${a.warnings.join('; ')}`);
  });
  return L.join('\n');
}

export interface BeforeAfterOptions {
  log?: (m: string) => void;
  openRenderer?: (dir: string, asset: WorldAsset) => Promise<WorldRenderer>;
  characters?: Character[];
}

const displayName = (id: string, characters?: Character[]) => (characters?.find((c) => c.id === id)?.name ?? id).toUpperCase();
/** Clearly different mannequin colours per character (tintFor's hash can land two ids close). */
const PALETTE = ['#ff8a1f', '#2fb8ff', '#e84bd0', '#ffd23f', '#7bdc5a', '#b28cff'];

/**
 * Three panels: the planner's marks and the staged marks from the start camera (staging framing),
 * then the staged marks from a second angle (beside the camera, raised, aimed at the actors).
 * Mannequins are tinted per character and labelled; the after panels show the old marks as grey
 * rings.
 */
export async function renderStagingBeforeAfter(worldDir: string, report: StagingReport, outPng: string, o: BeforeAfterOptions = {}): Promise<void> {
  const asset = await readWorldAsset(worldDir);
  const geo = await stagingGeometry(worldDir, asset);
  if (!geo) throw new Error('no collider');
  // marks are drawn at the world's current scale (a later calibration rescales them)
  const k = calibrationFactor(asset) / (report.factor > 0 ? report.factor : 1);
  const at = (b: Blocking) => [b.position[0] * k, b.position[2] * k] as const;
  const order = report.original.map((b) => b.characterId);
  const all = [...report.original, ...report.blocking];
  const ground = await groundHeights(worldDir, asset, geo, all.map(at));
  const yOf = (b: Blocking) => ground[all.indexOf(b)] ?? 0;
  const figure = (b: Blocking, label: string): ScaleFigure => {
    const [x, z] = at(b);
    const tint = PALETTE[order.indexOf(b.characterId) % PALETTE.length] ?? '#ff8a1f';
    // a seated body's feet are on the floor beside the seat (the ground there is the seat itself)
    const sitting = b.pose === 'sitting';
    const y = sitting ? (nearestMark(report.marks, x, z)?.mark.y ?? 0) : yOf(b);
    const tall = o.characters?.find((c) => c.id === b.characterId)?.heightMeters;
    return { x, z, y, yaw: b.yaw, label, tint, ...(tall ? { heightMeters: tall } : {}), ...(sitting ? { pose: 'sitting' as const } : {}) };
  };
  const ring = (b: Blocking, label: string, color: string): ScaleMark => {
    const [x, z] = at(b);
    return { x, z, y: yOf(b), label, color, radius: 0.25 };
  };
  const before = report.original.map((b) => figure(b, `${displayName(b.characterId, o.characters)} (planner)`));
  const after = report.blocking.map((b) => figure(b, displayName(b.characterId, o.characters)));
  const ghosts = report.original.map((b) => ring(b, `${displayName(b.characterId, o.characters).toLowerCase()} · planner`, '#9aa3ad'));
  const view = report.view;
  const spots = report.blocking.map(at);
  const cxs = spots.reduce((t, p) => t + p[0], 0) / Math.max(1, spots.length);
  // the side away from the actors' centroid sees them spread out
  const second = sideView(geo, spots, cxs > 0 ? -1 : 1, { all: true }) ?? sideView(geo, spots, cxs > 0 ? 1 : -1, { all: true });
  const W = 960;
  const H = 540;
  const renderer = await (o.openRenderer ?? ((d, a) => openWorldRenderer(d, a, { log: o.log })))(worldDir, asset);
  try {
    const p1 = await renderer.shot(shotOf(asset, view, { figures: before, width: W, height: H }));
    const p2 = await renderer.shot(shotOf(asset, view, { figures: after, marks: ghosts, width: W, height: H }));
    const p3 = second ? await renderer.shot(shotOf(asset, second, { figures: after, marks: ghosts, width: W, height: H })) : null;
    const lines = report.original.map((ob) => {
      const nb = report.blocking.find((b) => b.characterId === ob.characterId);
      const s = report.characters.find((c) => c.characterId === ob.characterId);
      return `${displayName(ob.characterId, o.characters)}: ${xz(ob)} ${ob.pose} → ${nb ? xz(nb) : '—'} ${nb?.pose ?? ''}${s ? ` [${s.mark || s.source}] facing ${s.facing}` : ''}${nb?.note ? ` — ${nb.note}` : ''}`;
    });
    const footer = [
      ...lines,
      report.status === 'staged'
        ? `staged by ${report.model} from the start camera (${report.marks.length} candidate marks, ${report.attempts.length} request(s), $${report.usage.costUsd.toFixed(3)})`
        : `not staged — ${report.reason}`,
    ];
    const panels = [
      { image: p1, title: "Before: the planner's blind marks", subtitle: `start camera (0, 1.6, 0), ${view.fovDeg}° wide, tilted ${-view.pitchDeg}° down` },
      { image: p2, title: report.status === 'staged' ? 'After: staged on the set' : 'After: unchanged (staging failed)', subtitle: 'same view · grey rings = the planner marks' },
      ...(p3 && second ? [{ image: p3, title: 'After: second angle', subtitle: second.label }] : []),
    ];
    await writeFile(outPng, await renderer.compose(panels, footer));
  } finally {
    await renderer.close();
  }
}
