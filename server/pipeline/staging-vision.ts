// Staging, the pure half: where the candidate marks go, what Claude is asked, and how its answer
// becomes Blocking that is valid on the set's collider.
//
// The planner writes blocking blind (screenplay.ts: 1.5–4 m in front of the camera, ±2 m), so on
// a generated set an actor can land in the road, in a planter or behind a shelter's ad panel. The
// staging step (staging.ts) renders the set from the director's start camera twice: a clean plate
// and the same view with labelled rings on free, floored ground the camera can see (a 0.5 m grid
// near the camera, 1 m beyond). Claude picks a ring per character (or, when none fits, the pixel
// where the feet go; a seat pixel for someone sitting), whom they face, the pose and a one-line
// note. A discrete labelled ring makes the answer exact: its world xz is known.
//
// Everything here is deterministic and unit-tested; the request itself is injectable
// (`StagingCall`, same shape as calibrate-vision's VisionCall).
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Blocking, Character, ScenePlan, Vec3 } from '../../shared/schema.ts';
import { correctPlacement, hasFloor, spotBlocked, TriGrid } from '../../web/src/viewer/placement.ts';
import { env } from '../env.ts';
import type { RayCast } from './calibrate-geometry.ts';
import { floorAt, IMAGE, pixelRay, projectPoint, type PlannedView } from './calibrate-vision.ts';
import { round3, yawFacing } from './geometry.ts';

export const STAGING_MODEL = 'claude-opus-5-5';

export const EYE: Vec3 = [0, 1.6, 0];

/**
 * How the start camera (manifest startCamera, project.ts START_CAMERA: (0, 1.6, 0) looking down
 * -Z) is framed for Claude, and where the grid rows lie (m in front of the camera) with their
 * spacing. `standard`: a little wider than the laptop's 16:9 start view (50° vertical ≈ 79°
 * across), tilted so the ground from ~1.6 m shows, rows 0.5 m apart to 3.5 m then 1 m. `cramped`
 * (a small room whose free floor ends within ~2 m, like calibration's wider framing): 100° wide,
 * steeper, rows from 0.75 m, 0.25 m apart. `maxBearingDeg`: a mark's body (±0.3 m) must lie
 * within this angle of straight ahead, so whoever stands on it is inside the director's frame.
 */
export const FRAMINGS = {
  standard: { pitchDeg: -18, fovDeg: 84, rows: [1.5, 2, 2.5, 3, 3.5, 4.5, 5.5, 6.5], step: (d: number) => (d <= 3.5 ? 0.5 : 1), maxBearingDeg: 36 },
  cramped: { pitchDeg: -32, fovDeg: 100, rows: [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3], step: (d: number) => (d <= 2 ? 0.25 : 0.5), maxBearingDeg: 48 },
} as const;
export type Framing = keyof typeof FRAMINGS;
/** Marks farther than this from the camera are not offered (the rules ask for ≤ ~6 m). */
export const MAX_MARK_DISTANCE = 7.5;
/**
 * Farthest anyone may be staged (by feet pixel): a place the action names beyond the marks (a
 * parapet 10 m out) still reads from the start camera (a 1.7 m body ≈ 140 px of 720 at 10 m).
 */
export const MAX_STAGE_DISTANCE = 12;

export interface StagingGeometry {
  /** collider triangles in the viewer's frame (scale calibrated, floor offset applied) */
  grid: TriGrid;
  cast: RayCast;
}

export interface Mark {
  label: string;
  x: number;
  /** ground height at the spot (collider floor) */
  y: number;
  z: number;
  /** horizontal distance from the camera, m */
  distance: number;
  /** pixel in the staging view */
  px: [number, number];
}

export type View = Pick<PlannedView, 'yawDeg' | 'pitchDeg' | 'fovDeg' | 'camera'>;
export const stagingView = (framing: Framing = 'standard', eye: Vec3 = EYE): View => ({
  yawDeg: 0,
  pitchDeg: FRAMINGS[framing].pitchDeg,
  fovDeg: FRAMINGS[framing].fovDeg,
  camera: eye,
});

const standable = (grid: TriGrid, x: number, z: number, pose: 'standing' | 'sitting' = 'standing') => {
  const local = grid.around(x, z);
  return hasFloor(local, x, z) && !spotBlocked(local, x, z, pose);
};

/** True when nothing in the collider is between `from` and `to` (a 0.3 m allowance at the end). */
export function sees(cast: RayCast, from: Vec3, to: Vec3, slack = 0.3): boolean {
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(...d);
  if (len < 1e-6) return true;
  const hit = cast(from, [d[0] / len, d[1] / len, d[2] / len], len);
  return hit === null || hit > len - slack;
}

/**
 * The labelled candidate rings: grid spots in the view with free floor under a standing body,
 * whose ground (0.25 m up) and chest the camera can see, within MAX_MARK_DISTANCE. Rows are
 * lettered from the camera (A nearest), numbered left to right within a row.
 */
export function planMarks(g: StagingGeometry, framing: Framing = 'standard', eye: Vec3 = EYE): Mark[] {
  const out: Mark[] = [];
  const f = FRAMINGS[framing];
  const view = stagingView(framing, eye);
  let letter = 0;
  for (const depth of f.rows) {
    const step = f.step(depth);
    const row: Mark[] = [];
    for (let i = -Math.ceil(9 / step); i <= Math.ceil(9 / step); i++) {
      const x = round3(i * step);
      const z = -depth;
      const distance = Math.hypot(x - eye[0], z - eye[2]);
      if (distance > MAX_MARK_DISTANCE) continue;
      const bearing = Math.abs(Math.atan2(x - eye[0], -(z - eye[2]))) + Math.atan(0.3 / distance);
      if ((bearing * 180) / Math.PI > f.maxBearingDeg) continue;
      if (!standable(g.grid, x, z)) continue;
      const y = floorAt(g.grid, x, z);
      if (y === null) continue;
      const px = projectPoint(view, [x, y, z]);
      if (!px || px[0] < 14 || px[0] > IMAGE.width - 14 || px[1] < 30 || px[1] > IMAGE.height - 8) continue;
      if (!sees(g.cast, eye, [x, y + 0.25, z]) || !sees(g.cast, eye, [x, y + 1.3, z])) continue;
      row.push({ label: '', x, y: round3(y), z, distance: round3(distance), px: [Math.round(px[0]), Math.round(px[1])] });
    }
    // rows that show nothing are skipped, so A is always the nearest row in the picture
    if (row.length) row.forEach((m, k) => out.push({ ...m, label: `${'ABCDEFGHJK'[letter]}${k + 1}` }));
    if (row.length) letter++;
  }
  return out;
}

/**
 * A camera beside the start camera for depth (side -1 = left, +1 = right): 2.5 m out and 2.2 m up
 * (else 1.8 / 1.2 m out, then 0.9 / 0.6 m out at 1.9 m), 0.3 m back, aimed at the targets'
 * centroid 0.9 m above the floor. Its spot must
 * be clear of the collider within 0.4 m (not inside a shelter or a wall) and see the centroid;
 * with `all`, every target must be visible and in frame too (the before/after picture).
 */
export function sideView(
  geo: StagingGeometry,
  targets: readonly (readonly [number, number])[],
  side: -1 | 1,
  o: { fovDeg?: number; all?: boolean } = {},
): (View & { label: string }) | null {
  if (!targets.length) return null;
  const cx = targets.reduce((s, p) => s + p[0], 0) / targets.length;
  const cz = targets.reduce((s, p) => s + p[1], 0) / targets.length;
  // high and wide first; lower and closer ones fit a small room
  const spots: [number, number][] = [[2.5, 2.2], [1.8, 2.2], [1.2, 2.2], [0.9, 1.9], [0.6, 1.9]];
  for (const [off, up] of spots) {
    const cam: Vec3 = [side * off, up, 0.3];
    const dirs: Vec3[] = [[0, 1, 0], [0, -1, 0], ...Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4), 0, Math.sin((k * Math.PI) / 4)] as Vec3)];
    if (dirs.some((d) => geo.cast(cam, d, 0.4) !== null)) continue;
    if (!sees(geo.cast, cam, [cx, 0.9, cz], 0.4)) continue;
    const tx = cx - cam[0];
    const tz = cz - cam[2];
    const v: View = {
      yawDeg: round3((Math.atan2(-tx, -tz) * 180) / Math.PI),
      pitchDeg: round3((Math.atan2(0.9 - cam[1], Math.hypot(tx, tz)) * 180) / Math.PI),
      fovDeg: o.fovDeg ?? 70,
      camera: cam,
    };
    if (o.all) {
      const ok = targets.every(([x, z]) => {
        const p = projectPoint(v, [x, 0, z]);
        const q = projectPoint(v, [x, 1.8, z]);
        const inside = !!p && !!q && p[0] > 0 && p[0] < IMAGE.width && p[1] < IMAGE.height && q[1] > 0;
        return inside && sees(geo.cast, cam, [x, 1.2, z], 0.4);
      });
      if (!ok) continue;
    }
    return { ...v, label: `camera ${off} m to the ${side < 0 ? 'left' : 'right'} of the start camera, ${up} m up` };
  }
  return null;
}

/** The marks a camera sees (their ground, 0.25 m up), in its frame. */
export function marksSeenFrom(geo: StagingGeometry, view: View, marks: Mark[]): Mark[] {
  return marks.filter((m) => {
    const p = projectPoint(view, [m.x, m.y, m.z]);
    return !!p && p[0] > 14 && p[0] < IMAGE.width - 14 && p[1] > 30 && p[1] < IMAGE.height - 8 && sees(geo.cast, view.camera, [m.x, m.y + 0.25, m.z]);
  });
}

/**
 * The standard framing, or the cramped one when the standard offers fewer than `need` marks and
 * the cramped one offers more.
 */
export function chooseFraming(g: StagingGeometry, need: number): { framing: Framing; view: View; marks: Mark[] } {
  const standard = planMarks(g, 'standard');
  if (standard.length >= need) return { framing: 'standard', view: stagingView('standard'), marks: standard };
  const cramped = planMarks(g, 'cramped');
  return cramped.length > standard.length
    ? { framing: 'cramped', view: stagingView('cramped'), marks: cramped }
    : { framing: 'standard', view: stagingView('standard'), marks: standard };
}

/** The mark nearest a floor point (xz), with its distance; undefined without marks. */
export function nearestMark(marks: Mark[], x: number, z: number): { mark: Mark; off: number } | undefined {
  let best: { mark: Mark; off: number } | undefined;
  for (const m of marks) {
    const off = Math.hypot(m.x - x, m.z - z);
    if (!best || off < best.off) best = { mark: m, off };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Prompt and answer
// ---------------------------------------------------------------------------

export const STAGING_SYSTEM = `You are the stage manager of a previsualization tool. A screenplay scene has been turned into a 3D set: a gaussian-splat reconstruction generated from a text prompt. 3D actors will stand on it, and their marks were first written blind, without seeing the set. Your job: put each character's mark where it makes sense on THIS set.

Images 1 and 2 show the set from the scene's main camera (the director's start view: eye height 1.6 m, looking straight ahead; these renders are wider and tilted down so the near ground shows, see the text). Image 1 is the clean view. Image 2 is the same view with candidate marks: yellow rings lying on free ground that the set's coarse collision mesh allows, each labelled (row letter from the camera, A nearest, then numbers left to right). Any further images show the same marks from cameras a little to the left and right of the main one and higher up, so you can judge depth: what stands in front of, beside, behind or inside what (only the marks that camera can see are drawn there). The text lists each mark's floor position in metres: x to the right, z negative away from the camera, and its distance. Choose marks for how the scene reads from the MAIN camera.

Rules, most important first:
1. Walkable ground that fits the scene: the sidewalk or pavement, not the road or a traffic lane (unless the script puts them there); the floor, never on furniture, a counter, a table, a planter or a bed; not inside a shelter's glass walls, behind a counter or behind a railing unless the action says so. Keep feet at least about 0.3 m inside an edge (a kerb, a step, a platform or roof edge): a ring on the kerb line counts as the road. Judge the surface from image 1: the collision mesh is coarse, so a ring can sit on a road, a kerb edge or a puddle as easily as on a sidewalk.
2. Where the action says: "under the shelter", "waits at the kerb", "by the stove", "sits at the table", "leans on the parapet" means right there, within about 0.5-1 m of that thing.
3. Visible from the main camera: whole bodies readable, nobody hidden behind another (keep them at clearly different left/right positions in the frame) or behind a set piece. In image 2, a label drawn over a wall, panel, post or object means that spot is BEHIND it and hidden. Prefer marks 2-6 m from the camera; go farther (up to about 12 m, with px, since the marks stop at about 7 m) only when the action puts someone at a particular place that far out, like a parapet, a far doorway or a car across the street. The director's laptop view is often narrower than these renders, so when the set allows, keep the characters toward the middle (|x| under about half their distance) rather than at the sides.
4. Conversation: characters who talk to each other stand about 1.2-1.8 m apart and face each other (opening slightly toward the camera is good); a group forms an open arc facing the camera.
5. Keep the planner's intent where the set allows it (who is left or right, who is nearer the camera), but the set wins.
6. pose: "sitting" only when the action says they sit AND there is a real seat (chair, bench, stool, step, low wall): then give px, the pixel in image 1 on the seat surface where they sit. "walking" only for someone crossing the shot right now; someone who jogs in and then talks is "standing" at their mark. Otherwise "standing".

You will then see your answer rendered with mannequins on its marks and can correct it.

First describe the set's walkable layout in "set": which marks are on the sidewalk or floor and which are on the road, in furniture or hidden, and where the places named in the action are (shelter, bench, kerb, stove, table, parapet…), by mark labels. Then, for every character: "mark" is the label their feet go on; use "" only when no mark is right, and then "px" is the exact pixel in image 1 where their feet touch the ground. "facing" is the id of the character they face, or "camera", or a mark label they look toward. "note" is one short line for the director, at most 90 characters, saying where and why ("on the sidewalk under the shelter by the bench, facing Leo"). Pixels are in image coordinates: x right, y down, origin at the top-left corner, ${IMAGE.width}×${IMAGE.height}.`;

const Px = z.object({ x: z.number(), y: z.number() });

export const StagingAnswer = z.object({
  set: z.string().describe('the walkable layout and the named places, by mark labels'),
  characters: z.array(
    z.object({
      characterId: z.string(),
      mark: z.string().describe('label of the mark their feet go on, or "" when px is given instead'),
      px: Px.nullable().describe('sitting: the seat pixel; no mark: the feet pixel; else null'),
      pose: z.enum(['standing', 'sitting', 'walking']),
      facing: z.string().describe('a character id, "camera", or a mark label'),
      note: z.string().describe('one short line for the director, at most 90 characters'),
      reasoning: z.string(),
    }),
  ),
});
export type StagingAnswer = z.infer<typeof StagingAnswer>;

const describeBlocking = (b: Blocking, marks: Mark[], scene: ScenePlan, cast: Character[]) => {
  const near = nearestMark(marks, b.position[0], b.position[2]);
  // the planner's facing target: whoever its yaw points at most directly
  const fwd: [number, number] = [-Math.sin(b.yaw), -Math.cos(b.yaw)];
  let faces = 'the camera';
  let best = Math.cos((60 * Math.PI) / 180);
  for (const o of scene.blocking) {
    if (o.characterId === b.characterId) continue;
    const dx = o.position[0] - b.position[0];
    const dz = o.position[2] - b.position[2];
    const c = (dx * fwd[0] + dz * fwd[1]) / (Math.hypot(dx, dz) || 1);
    if (c > best) [best, faces] = [c, cast.find((x) => x.id === o.characterId)?.id ?? o.characterId];
  }
  return `- ${b.characterId}: x ${b.position[0].toFixed(1)}, z ${b.position[2].toFixed(1)}${near ? ` (nearest mark ${near.mark.label}, ${near.off.toFixed(1)} m off)` : ''}, ${b.pose}, facing ${faces}`;
};

export interface StagingPromptInput {
  scene: ScenePlan;
  characters: Character[];
  caption?: string;
  marks: Mark[];
  view?: View;
}

export function stagingUserText(o: StagingPromptInput): string {
  const { scene, marks } = o;
  const cast = o.characters.filter((c) => scene.characterIds.includes(c.id));
  const lines = scene.dialogue.slice(0, 12).map((l) => `${l.characterId}: ${l.parenthetical ? `(${l.parenthetical}) ` : ''}${l.text}`);
  const v = o.view ?? stagingView('standard');
  return [
    `Scene: ${scene.heading}`,
    `Main camera renders: ${v.fovDeg}° wide, tilted ${-v.pitchDeg}° down.`,
    `Action:\n${scene.action.trim()}`,
    o.caption ? `The set as generated (provider caption): ${o.caption.trim()}` : '',
    `Characters:\n${cast.map((c) => `- ${c.id} (${c.name}): ${c.description.slice(0, 240)}`).join('\n')}`,
    lines.length ? `Dialogue:\n${lines.join('\n')}` : '',
    `The planner's blind blocking (its intent; it did not see the set):\n${scene.blocking.map((b) => describeBlocking(b, marks, scene, cast)).join('\n')}`,
    `Marks (label: x, z, distance from the camera):\n${marks.map((m) => `${m.label}: ${m.x.toFixed(1)}, ${m.z.toFixed(1)}, ${m.distance.toFixed(1)} m`).join('\n')}`,
    `Stage every character: ${cast.map((c) => c.id).join(', ')}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The second request: the first answer rendered (images `first`.. with mannequins labelled by
 * character id on its marks) plus the checks' failures, to keep or correct.
 */
export function reviewText(previous: StagingAnswer, failures: string[], first: number, count: number): string {
  const imgs = count > 1 ? `Images ${first}-${first + count - 1} show` : `Image ${first} shows`;
  return [
    `${imgs} your previous answer rendered: a 1.70 m mannequin labelled with the character id on each mark it could place (main camera${count > 1 ? ', then from the side' : ''}).`,
    failures.length
      ? `The automatic checks rejected it:\n${failures.map((f) => `- ${f}`).join('\n')}`
      : 'It passed the automatic checks (free floor, spacing, nobody behind anybody by the collision mesh), which cannot see thin things like a raised ad panel, glass or a sign.',
    'Look at every figure in the main camera view: is the whole body visible (not behind a panel, sign, glass wall, post, vehicle or another figure; not cut off by the frame edge)? Is it on walkable ground that fits the action (sidewalk not road, floor not furniture) and where the action says? Keep the marks that work, change the ones that do not, and answer again for every character.',
    `Previous answer:\n${JSON.stringify(previous)}`,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Answer → Blocking
// ---------------------------------------------------------------------------

export interface ResolveContext {
  scene: ScenePlan;
  marks: Mark[];
  geo: StagingGeometry;
  view?: View;
}

export interface StagedCharacter {
  characterId: string;
  mark: string;
  position: Vec3;
  pose: Blocking['pose'];
  facing: string;
  note: string;
  reasoning: string;
  /** how the spot was found */
  source: 'mark' | 'feet-pixel' | 'seat-pixel';
  /** set when correctPlacement had to move the spot to free floor */
  nudged?: number;
}

export interface Resolved {
  blocking: Blocking[];
  staged: StagedCharacter[];
  /** reasons the answer cannot be used (fed back to Claude on the retry) */
  failures: string[];
  /** soft observations (logged, kept in the report) */
  warnings: string[];
}

/** Ray from the camera through a pixel of the view onto the collider: the point hit, or null. */
export function pixelHit(geo: StagingGeometry, view: View, px: { x: number; y: number }): Vec3 | null {
  if (!(px.x >= 0 && px.x <= IMAGE.width && px.y >= 0 && px.y <= IMAGE.height)) return null;
  const d = pixelRay(view, px.x, px.y);
  const t = geo.cast(view.camera, d, 40);
  return t === null ? null : [view.camera[0] + d[0] * t, view.camera[1] + d[1] * t, view.camera[2] + d[2] * t];
}

const BODY_HALF_WIDTH = 0.28;
/** A two-shot may overlap a little; more of the farther body than this behind the nearer one fails. */
const MAX_COVERED = 0.4;

/**
 * How much of the farther body's width (as the camera sees it, 0.56 m wide bodies) the nearer
 * one covers, 0..1.
 */
export function coveredFraction(eye: Vec3, near: Vec3, far: Vec3): number {
  const bearing = (p: Vec3) => Math.atan2(p[0] - eye[0], -(p[2] - eye[2]));
  const half = (p: Vec3) => Math.atan(BODY_HALF_WIDTH / (Math.hypot(p[0] - eye[0], p[2] - eye[2]) || 1e-6));
  const [bn, hn, bf, hf] = [bearing(near), half(near), bearing(far), half(far)];
  const overlap = Math.min(bn + hn, bf + hf) - Math.max(bn - hn, bf - hf);
  return Math.max(0, Math.min(1, overlap / (2 * hf)));
}

/**
 * Turns Claude's answer into Blocking on the collider: a mark gives its xz; a feet pixel is cast
 * onto the floor (it must land on floor, not on a wall or a bench); a seat pixel must land on a
 * surface 0.25-0.8 m above the floor. Each spot then passes correctPlacement (free floor, ≥ 0.5 m
 * from the others; a spot within 1.5 m is accepted as nudged). Failures: an unknown or missing
 * character, an unknown mark, a pixel off the floor / seat, no free floor nearby, two marks closer
 * than 0.7 m, someone the camera sees behind someone else or behind the set, beyond 12 m.
 * Yaw faces the named character's final mark, the camera or a mark.
 */
export function resolveAnswer(answer: StagingAnswer, ctx: ResolveContext): Resolved {
  const { scene, marks, geo } = ctx;
  const view = ctx.view ?? stagingView('standard');
  const eye = view.camera;
  const failures: string[] = [];
  const warnings: string[] = [];
  const byLabel = new Map(marks.map((m) => [m.label.toUpperCase(), m]));
  const ids = scene.characterIds;
  const picked = new Map<string, StagingAnswer['characters'][number]>();
  for (const c of answer.characters) {
    const id = ids.find((x) => x.toLowerCase() === c.characterId.trim().toLowerCase());
    if (!id) warnings.push(`ignored unknown character "${c.characterId}"`);
    else if (picked.has(id)) failures.push(`${id} is staged twice`);
    else picked.set(id, c);
  }
  for (const id of ids) if (!picked.has(id)) failures.push(`${id} has no mark`);

  const staged: StagedCharacter[] = [];
  for (const id of ids) {
    const c = picked.get(id);
    if (!c) continue;
    const label = c.mark.trim().toUpperCase();
    let spot: { x: number; z: number; source: StagedCharacter['source'] } | null = null;
    if (c.pose === 'sitting') {
      const hit = c.px ? pixelHit(geo, view, c.px) : null;
      // seat height against the free floor nearby (a coarse collider closes a chair into a blob,
      // so straight down from the seat finds the blob's own underside)
      const under = hit ? (nearestMark(marks, hit[0], hit[2])?.mark.y ?? 0) : 0;
      if (!c.px) failures.push(`${id} is sitting but no seat pixel (px) was given`);
      else if (!hit) failures.push(`${id}'s seat pixel (${c.px.x.toFixed(0)}, ${c.px.y.toFixed(0)}) does not land on anything in the set`);
      else if (hit[1] - under < 0.25 || hit[1] - under > 0.8)
        failures.push(`${id}'s seat pixel lands on a surface ${(hit[1] - under).toFixed(2)} m above the floor, not a seat (0.25-0.8 m)`);
      else spot = { x: hit[0], z: hit[2], source: 'seat-pixel' };
    } else if (label) {
      const m = byLabel.get(label);
      if (!m) failures.push(`${id}: mark "${c.mark}" is not one of the labelled marks`);
      else spot = { x: m.x, z: m.z, source: 'mark' };
    } else if (c.px) {
      const hit = pixelHit(geo, view, c.px);
      const fl = hit ? floorAt(geo.grid, hit[0], hit[2]) : null;
      if (!hit || fl === null || Math.abs(fl - hit[1]) > 0.15)
        failures.push(`${id}'s feet pixel (${c.px.x.toFixed(0)}, ${c.px.y.toFixed(0)}) is not on the floor (it hits ${hit ? 'a wall or an object' : 'nothing'}); pick a mark`);
      else spot = { x: hit[0], z: hit[2], source: 'feet-pixel' };
    } else failures.push(`${id} has neither a mark nor a pixel`);
    if (!spot) continue;

    const others = staged.map((s) => [s.position[0], s.position[2]] as [number, number]);
    const r = correctPlacement(geo.grid, spot.x, spot.z, { pose: c.pose, toward: [eye[0], eye[2]], avoid: others, maxR: 1.5, fallbackR: 1.5 });
    if (r.status === 'stuck') {
      failures.push(`${id}: no free floor within 1.5 m of ${label || 'the pixel'} for a ${c.pose} body`);
      continue;
    }
    const nudged = r.status === 'moved' ? Math.hypot(r.x - spot.x, r.z - spot.z) : 0;
    if (nudged) warnings.push(`${id} nudged ${nudged.toFixed(2)} m to free floor`);
    staged.push({
      characterId: id,
      mark: spot.source === 'mark' ? label : '',
      position: [round3(r.x), 0, round3(r.z)],
      pose: c.pose,
      facing: c.facing.trim(),
      note: oneLine(c.note),
      reasoning: c.reasoning.trim(),
      source: spot.source,
      ...(nudged ? { nudged: round3(nudged) } : {}),
    });
  }

  // spacing, distance and what the camera sees
  for (let i = 0; i < staged.length; i++) {
    const a = staged[i]!;
    const da = Math.hypot(a.position[0] - eye[0], a.position[2] - eye[2]);
    if (da > MAX_STAGE_DISTANCE) failures.push(`${a.characterId} is ${da.toFixed(1)} m from the camera (at most ${MAX_STAGE_DISTANCE} m; prefer 2-6 m)`);
    // chest height: a seated body's is lower (floorAt is the seat there, ~0.45 m)
    const chest = (floorAt(geo.grid, a.position[0], a.position[2]) ?? 0) + (a.pose === 'sitting' ? 0.6 : 1.3);
    if (!sees(geo.cast, eye, [a.position[0], chest, a.position[2]], 0.4))
      failures.push(`${a.characterId} at ${a.mark || 'the pixel'} is hidden from the camera by the set`);
    for (let j = i + 1; j < staged.length; j++) {
      const b = staged[j]!;
      const gap = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
      if (gap < 0.7) {
        failures.push(`${a.characterId} and ${b.characterId} are only ${gap.toFixed(2)} m apart (at least 0.7 m)`);
        continue;
      }
      const db = Math.hypot(b.position[0] - eye[0], b.position[2] - eye[2]);
      const covered = coveredFraction(eye, da < db ? a.position : b.position, da < db ? b.position : a.position);
      if (covered > MAX_COVERED) {
        const [near, far] = da < db ? [a, b] : [b, a];
        failures.push(`the camera sees ${far.characterId} ${Math.round(covered * 100)}% hidden behind ${near.characterId}: move them apart left/right`);
      }
    }
  }

  // facing → yaw (after every spot is known, so partners face each other's final marks)
  const blocking: Blocking[] = staged.map((s) => {
    const target = facingPoint(s, staged, byLabel, eye);
    if (!target.known) warnings.push(`${s.characterId}: facing "${s.facing}" not understood; ${target.what}`);
    return {
      characterId: s.characterId,
      position: s.position,
      yaw: round3(yawFacing(s.position, target.point)),
      pose: s.pose,
      ...(s.note ? { note: s.note } : {}),
    };
  });
  return { blocking, staged, failures, warnings };
}

function facingPoint(
  s: StagedCharacter,
  all: StagedCharacter[],
  byLabel: Map<string, Mark>,
  eye: Vec3,
): { point: Vec3; known: boolean; what: string } {
  const f = s.facing.toLowerCase();
  const other = all.find((o) => o !== s && o.characterId.toLowerCase() === f);
  if (other) return { point: other.position, known: true, what: other.characterId };
  if (/^(the )?camera$/.test(f)) return { point: [eye[0], 0, eye[2]], known: true, what: 'camera' };
  const m = byLabel.get(f.toUpperCase());
  if (m) return { point: [m.x, 0, m.z], known: true, what: m.label };
  const nearest = all
    .filter((o) => o !== s)
    .sort((a, b) => dist(a.position, s.position) - dist(b.position, s.position))[0];
  return nearest
    ? { point: nearest.position, known: false, what: `facing ${nearest.characterId} (nearest)` }
    : { point: [eye[0], 0, eye[2]], known: false, what: 'facing the camera' };
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
};

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export type StagingCall = (req: {
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  schema: Record<string, unknown>;
}) => Promise<Anthropic.Beta.BetaMessage>;

export const defaultStagingCall: StagingCall = async ({ system, content, schema }) => {
  const client = new Anthropic({ apiKey: env.keys.anthropic });
  const stream = client.beta.messages.stream({
    model: STAGING_MODEL,
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
