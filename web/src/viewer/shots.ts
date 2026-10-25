// Suggested shots of the open scene, derived from where its actors stand NOW.
//
// ScenePlan.shots are written by the planner from its blind marks, before the staging step moves
// the actors onto the visible set, and nothing updates them when the director drags an actor or a
// chat edit moves one: on a staged world they aim where nobody stands. The laptop lists these
// instead (laptop/scene-panel.ts), recomputes them whenever a shot is used, and opens a scene whose
// start camera is the server default on the Wide master (laptop/director.ts).
//
// Frame (docs/PLAN.md "Coordinate conventions"): metres, Y up. An actor's yaw is three.js
// rotation.y of a body whose front is -Z, so it faces (-sin yaw, 0, -cos yaw); a camera looks down
// its local -Z. `suggestShots` is pure (no three.js, no scene graph); `sceneShotActors` is the
// only runtime glue.
import type { Quat, SuggestedShot, Vec3 } from '@shared/schema';
import { markY } from './ground';
import type { SceneRuntime } from './world';

export interface ShotActor {
  id: string;
  /** As the shot names show it: "Maya". */
  name: string;
  /** Feet in the world (metres): the rendered mark, on the ground at (x, z). */
  position: Vec3;
  /** Standing height the body is drawn at (Character.heightMeters, 1.7 m by default). */
  heightMeters: number;
  /** rotation.y of the -Z-facing body (Blocking.yaw). */
  yaw: number;
  pose?: 'standing' | 'sitting' | 'walking';
}

export interface ShotOptions {
  /** Width / height the shots are framed for (default 16:9, the phone's landscape frame). */
  aspect?: number;
  /**
   * Where the audience is (xz) when the cast's facing does not say: default the origin, Marble's
   * source camera, where the captured world is best seen from.
   */
  audience?: [number, number];
  /**
   * Distance from `from` along the segment to `to` to the first surface of the set (the world's
   * collider), null when the segment is clear. Without it camera spots are not checked.
   */
  hit?: (from: Vec3, to: Vec3) => number | null;
}

/** Eye line as a fraction of standing height (viewer/actors: headY = 0.93 × height). */
const EYE = 0.93;
/** Chest as a fraction of standing height: where the Wide master aims. */
const CHEST = 0.7;
/** A seated head sits this fraction of standing height lower (viewer/actors SIT_DROP_M / 1.7 m). */
const SEATED_DROP = 0.45 / 1.7;
/** The Wide master's lens height above the ground at its spot (m). */
const EYE_LEVEL = 1.6;
/** Framed points stay inside the frame by this factor (on the half-angle tangent). */
const MARGIN = 1.12;
/** The Wide master leaves more room round the cast (ground below, set above). */
const WIDE_MARGIN = 1.25;
/** The Wide master stands at least this far from the cast's centre (m). */
const WIDE_MIN = 3;
/** Another actor's body, as an obstacle to a close-up's camera and line of sight (m). */
const BODY_R = 0.3;
const MAX_SHOTS = 6;
const FOV = { wide: 52, two: 40, ots: 35, close: 30 } as const;
const CLOSE_DIST = 1.3;
const DEG = Math.PI / 180;

type V2 = [number, number];

/** Camera quaternion [x, y, z, w] at `from` aimed at `to`, no roll (Euler(pitch, yaw, 0, 'YXZ')). */
export function lookAtQuat(from: Vec3, to: Vec3): Quat {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const flat = Math.hypot(dx, dz);
  const yaw = flat < 1e-9 ? 0 : Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, flat);
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cx = Math.cos(pitch / 2);
  const sx = Math.sin(pitch / 2);
  return [cy * sx, sy * cx, -sy * sx, cy * cx].map((v) => Math.round(v * 1e6) / 1e6) as Quat;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const norm2 = (x: number, z: number): V2 | null => {
  const l = Math.hypot(x, z);
  return l > 1e-6 ? [x / l, z / l] : null;
};
const dot2 = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const neg2 = (a: V2): V2 => [-a[0], -a[1]];
/** `a` turned by `rad` about +Y. */
const turn = (a: V2, rad: number): V2 => [
  a[0] * Math.cos(rad) + a[1] * Math.sin(rad),
  -a[0] * Math.sin(rad) + a[1] * Math.cos(rad),
];
const facing = (yaw: number): V2 => [-Math.sin(yaw), -Math.cos(yaw)];
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** An actor with its feet, eye line and head top worked out. */
interface Placed extends ShotActor {
  x: number;
  z: number;
  feet: number;
  eye: number;
  top: number;
  height: number;
}

function place(a: ShotActor): Placed {
  const drop = a.pose === 'sitting' ? SEATED_DROP * a.heightMeters : 0;
  const feet = a.position[1];
  return {
    ...a,
    x: a.position[0],
    z: a.position[2],
    feet,
    eye: feet + EYE * a.heightMeters - drop,
    top: feet + a.heightMeters - drop,
    height: a.heightMeters - drop,
  };
}

/** Points that must be in frame for a body, from `low` to `high` (world y), `r` around its axis. */
const body = (a: Placed, low: number, high: number, r: number): Vec3[] =>
  [low, high].flatMap((y) => [
    [a.x + r, y, a.z],
    [a.x - r, y, a.z],
    [a.x, y, a.z + r],
    [a.x, y, a.z - r],
  ]);

interface Frame {
  tx: number;
  ty: number;
}
const frameOf = (fovDeg: number, aspect: number, margin = MARGIN): Frame => {
  const ty = Math.tan((fovDeg * DEG) / 2) / margin;
  return { tx: ty * aspect, ty };
};

/** True when every point projects inside the frame of a camera at `eye` aimed at `target`. */
function inFrame(eye: Vec3, target: Vec3, pts: Vec3[], f: Frame): boolean {
  let fx = target[0] - eye[0];
  let fy = target[1] - eye[1];
  let fz = target[2] - eye[2];
  const fl = Math.hypot(fx, fy, fz);
  if (fl < 1e-6) return false;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // right = forward × up, up' = right × forward
  const rl = Math.hypot(fx, fz);
  if (rl < 1e-6) return false;
  const rx = -fz / rl;
  const rz = fx / rl;
  const ux = -rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy;
  for (const p of pts) {
    const vx = p[0] - eye[0];
    const vy = p[1] - eye[1];
    const vz = p[2] - eye[2];
    const depth = vx * fx + vy * fy + vz * fz;
    if (depth < 0.3) return false;
    if (Math.abs(vx * rx + vz * rz) > f.tx * depth) return false;
    if (Math.abs(vx * ux + vy * uy + vz * uz) > f.ty * depth) return false;
  }
  return true;
}

/** The nearest spot out along `dir` (xz, from the target) where every point fits the frame. */
function backOff(
  target: Vec3,
  dir: V2,
  height: (x: number, z: number) => number,
  pts: Vec3[],
  f: Frame,
  minD: number,
  maxD = 30,
): Vec3 {
  let eye: Vec3 = target;
  for (let d = minD; d <= maxD + 1e-9; d += 0.1) {
    const x = target[0] + dir[0] * d;
    const z = target[2] + dir[1] * d;
    eye = [x, height(x, z), z];
    if (inFrame(eye, target, pts, f)) break;
  }
  return eye;
}

/** True when the set has no surface between `subject` and the camera at `eye`. */
const clearOf = (hit: ShotOptions['hit'], subject: Vec3, eye: Vec3) => {
  if (!hit) return true;
  const t = hit(subject, eye);
  return t === null || t >= dist3(subject, eye) - 0.05;
};

/**
 * `eye` moved across the floor toward `subject`, to just short of the first surface between them
 * (≥ `minD` out); the lens keeps its height.
 */
function pullIn(hit: ShotOptions['hit'], subject: Vec3, eye: Vec3, minD: number): Vec3 {
  const t = hit?.(subject, eye) ?? null;
  const len = dist3(subject, eye);
  if (t === null || t >= len - 0.05 || len < 1e-6) return eye;
  const k = Math.max(minD, t - 0.2) / len;
  return [subject[0] + (eye[0] - subject[0]) * k, eye[1], subject[2] + (eye[2] - subject[2]) * k];
}

/** Main axis of the cast's spread on the floor (null when they stand together). */
function spreadAxis(cast: Placed[]): V2 | null {
  if (cast.length < 2) return null;
  if (cast.length === 2) {
    const [a, b] = cast as [Placed, Placed];
    return Math.hypot(b.x - a.x, b.z - a.z) > 0.4 ? norm2(b.x - a.x, b.z - a.z) : null;
  }
  const mx = cast.reduce((s, a) => s + a.x, 0) / cast.length;
  const mz = cast.reduce((s, a) => s + a.z, 0) / cast.length;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const a of cast) {
    sxx += (a.x - mx) ** 2;
    szz += (a.z - mz) ** 2;
    sxz += (a.x - mx) * (a.z - mz);
  }
  sxx /= cast.length;
  szz /= cast.length;
  sxz /= cast.length;
  const major = (sxx + szz) / 2 + Math.hypot((sxx - szz) / 2, sxz);
  if (Math.sqrt(major) < 0.25) return null;
  const th = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  return [Math.cos(th), Math.sin(th)];
}

/**
 * The side of the cast the camera films from (unit xz, from the group toward the camera): the way
 * they face when they agree (a line-up facing out), else toward the audience; a spread-out cast is
 * filmed across its line, so nobody hides behind anybody.
 */
function audienceSide(cast: Placed[], centre: V2, audience: V2): V2 {
  let fx = 0;
  let fz = 0;
  for (const a of cast) {
    const [x, z] = facing(a.yaw);
    fx += x;
    fz += z;
  }
  const agreed = Math.hypot(fx, fz) > 0.5 * cast.length ? norm2(fx, fz) : null;
  let d = agreed ?? norm2(audience[0] - centre[0], audience[1] - centre[1]) ?? [0, 1];
  const axis = spreadAxis(cast);
  if (axis) {
    let across: V2 = [-axis[1], axis[0]];
    if (dot2(across, d) < 0) across = neg2(across);
    d = norm2(across[0] + 0.5 * d[0], across[1] + 0.5 * d[1]) ?? across;
  }
  return d;
}

const shot = (name: string, eye: Vec3, target: Vec3, fovDeg: number): SuggestedShot => {
  const position: Vec3 = [r3(eye[0]), r3(eye[1]), r3(eye[2])];
  return { name, position, quaternion: lookAtQuat(position, target), fovDeg };
};

/** Wide master: everybody head to toe, from the audience side, lens at eye level. */
function wideMaster(
  cast: Placed[],
  side: V2,
  groundY: (x: number, z: number) => number,
  aspect: number,
  hit: ShotOptions['hit'],
): SuggestedShot {
  const n = cast.length;
  const target: Vec3 = [
    cast.reduce((s, a) => s + a.x, 0) / n,
    cast.reduce((s, a) => s + a.feet + CHEST * a.height, 0) / n,
    cast.reduce((s, a) => s + a.z, 0) / n,
  ];
  const pts = cast.flatMap((a) => body(a, a.feet, a.top + 0.08, 0.35));
  const height = (x: number, z: number) => groundY(x, z) + EYE_LEVEL;
  const f = frameOf(FOV.wide, aspect, WIDE_MARGIN);
  // turned off the ideal side when the set is in the way (a wall behind the camera spot)
  for (const deg of [0, 15, -15, 30, -30, 45, -45]) {
    const eye = backOff(target, turn(side, deg * DEG), height, pts, f, WIDE_MIN);
    if (clearOf(hit, target, eye)) return shot('Wide master', eye, target, FOV.wide);
  }
  // boxed in (an interior): as far back as the room allows, the lens widened to keep everybody
  const eye = pullIn(hit, target, backOff(target, side, height, pts, f, WIDE_MIN), 1.5);
  let fov: number = FOV.wide;
  while (fov < 75 && !inFrame(eye, target, pts, frameOf(fov, aspect))) fov += 1;
  return shot('Wide master', eye, target, fov);
}

/** Two-shot of the first pair at a 3/4 angle, heads to chests. */
function twoShot(
  a: Placed,
  b: Placed,
  side: V2,
  groundY: (x: number, z: number) => number,
  aspect: number,
  hit: ShotOptions['hit'],
): SuggestedShot {
  const target: Vec3 = [
    (a.x + b.x) / 2,
    (a.feet + 0.82 * a.height + b.feet + 0.82 * b.height) / 2,
    (a.z + b.z) / 2,
  ];
  const lens = (a.eye + b.eye) / 2 - 0.05;
  const height = (x: number, z: number) => Math.max(lens, groundY(x, z) + 0.5);
  const line = norm2(b.x - a.x, b.z - a.z) ?? [1, 0];
  let across: V2 = [-line[1], line[0]];
  if (dot2(across, side) < 0) across = neg2(across);
  // the 3/4 angle nearer the audience side first; on a tie, the one on the first actor's side
  const toA: V2 = [a.x - target[0], a.z - target[2]];
  const angles = [35, -35, 50, -50, 20, -20].map((deg) => turn(across, deg * DEG));
  const rank = (d: V2) => dot2(d, side) + 1e-3 * Math.sign(dot2(d, toA));
  const dirs = [...angles.slice(0, 2).sort((p, q) => rank(q) - rank(p)), ...angles.slice(2)];
  const pts = [a, b].flatMap((x) => body(x, x.feet + 0.55 * x.height, x.top + 0.06, 0.25));
  const f = frameOf(FOV.two, aspect);
  for (const dir of dirs) {
    const eye = backOff(target, dir, height, pts, f, 1.2);
    if (clearOf(hit, target, eye)) return shot('Two-shot', eye, target, FOV.two);
  }
  const eye = pullIn(hit, target, backOff(target, dirs[0]!, height, pts, f, 1.2), 0.9);
  return shot('Two-shot', eye, target, FOV.two);
}

/** Over X's shoulder on Y: 0.6 m behind and 0.4 m beside X's head, on Y's eyes. */
function overShoulder(
  x: Placed,
  y: Placed,
  side: V2,
  groundY: (x: number, z: number) => number,
  hit: ShotOptions['hit'],
): SuggestedShot {
  const u = norm2(y.x - x.x, y.z - x.z) ?? facing(x.yaw);
  let s: V2 = [-u[1], u[0]];
  if (dot2(s, side) < 0) s = neg2(s);
  const target: Vec3 = [y.x, y.eye, y.z];
  const at = (sd: V2): Vec3 => {
    const ex = x.x - u[0] * 0.6 + sd[0] * 0.4;
    const ez = x.z - u[1] * 0.6 + sd[1] * 0.4;
    return [ex, Math.max(x.eye, groundY(ex, ez) + 0.5), ez];
  };
  const name = `Over ${x.name}'s shoulder on ${y.name}`;
  for (const sd of [s, neg2(s)]) {
    const eye = at(sd);
    if (clearOf(hit, target, eye)) return shot(name, eye, target, FOV.ots);
  }
  return shot(name, pullIn(hit, target, at(s), 0.8), target, FOV.ots);
}

/** Squared xz distance from point p to the segment a–b. */
function segDist2(p: V2, a: V2, b: V2): number {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const l2 = abx * abx + abz * abz;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / l2)) : 0;
  const dx = a[0] + abx * t - p[0];
  const dz = a[1] + abz * t - p[1];
  return dx * dx + dz * dz;
}

/**
 * Close-up: 1.3 m in front of the face at eye height, on the eyes. A partner standing in that
 * spot (two actors facing each other closer than 1.6 m) or the set in the way swings the camera
 * round the face, toward the audience side first.
 */
function closeUp(
  a: Placed,
  others: Placed[],
  side: V2,
  groundY: (x: number, z: number) => number,
  hit: ShotOptions['hit'],
): SuggestedShot {
  const target: Vec3 = [a.x, a.eye, a.z];
  const front = facing(a.yaw);
  const sign = dot2(turn(front, 25 * DEG), side) >= dot2(turn(front, -25 * DEG), side) ? 1 : -1;
  const at = (dir: V2, d = CLOSE_DIST): Vec3 => {
    const ex = a.x + dir[0] * d;
    const ez = a.z + dir[1] * d;
    return [ex, Math.max(a.eye, groundY(ex, ez) + 0.3), ez];
  };
  const blockedByCast = (eye: Vec3) =>
    others.some(
      (o) =>
        o.top > Math.min(eye[1], a.eye) - 0.2 &&
        segDist2([o.x, o.z], [eye[0], eye[2]], [a.x, a.z]) < BODY_R * BODY_R,
    );
  const name = `Close-up ${a.name}`;
  for (const deg of [0, 25, -25, 45, -45, 65, -65]) {
    const eye = at(turn(front, sign * deg * DEG));
    if (!blockedByCast(eye) && clearOf(hit, target, eye)) return shot(name, eye, target, FOV.close);
  }
  return shot(name, pullIn(hit, target, at(front), 0.6), target, FOV.close);
}

/**
 * Up to six shots of the cast where it stands, in this order: Wide master (everybody, full
 * bodies), Two-shot (first pair, 3/4), Over X's shoulder on Y (first pair), Close-up per actor.
 * The first actor of the pair is `actors[0]` (the plan's blocking order). Empty without actors.
 */
export function suggestShots(
  actors: ShotActor[],
  groundY: (x: number, z: number) => number,
  opts: ShotOptions = {},
): SuggestedShot[] {
  if (!actors.length) return [];
  const aspect = opts.aspect ?? 16 / 9;
  const cast = actors.map(place);
  const centre: V2 = [
    cast.reduce((s, a) => s + a.x, 0) / cast.length,
    cast.reduce((s, a) => s + a.z, 0) / cast.length,
  ];
  const side = audienceSide(cast, centre, opts.audience ?? [0, 0]);
  const out = [wideMaster(cast, side, groundY, aspect, opts.hit)];
  const [a, b] = cast;
  if (a && b) {
    out.push(twoShot(a, b, side, groundY, aspect, opts.hit));
    out.push(overShoulder(a, b, side, groundY, opts.hit));
  }
  for (const c of cast) {
    if (out.length >= MAX_SHOTS) break;
    out.push(closeUp(c, cast.filter((o) => o !== c), side, groundY, opts.hit));
  }
  return out;
}

/** "MAYA" → "Maya" (as the projects list shows character names). */
const titleCase = (name: string) =>
  name.toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());

/**
 * The open scene's visible actors as `suggestShots` takes them: where each stands now (a drag, a
 * chat move and the collider correction included; a walk-in's ground lift left out), in the plan's
 * blocking order.
 */
export function sceneShotActors(rt: Pick<SceneRuntime, 'actors' | 'manifest'>): ShotActor[] {
  const { blocking, characterIds } = rt.manifest.plan;
  const ids = new Set([...blocking.map((b) => b.characterId), ...characterIds, ...rt.actors.keys()]);
  const out: ShotActor[] = [];
  for (const id of ids) {
    const o = rt.actors.get(id)?.object;
    if (!o || !o.visible) continue;
    const c = rt.manifest.characters.find((x) => x.id === id);
    out.push({
      id,
      name: titleCase(c?.name ?? id),
      position: [o.position.x, markY(o), o.position.z],
      heightMeters: ((o.userData.heightMeters as number | undefined) ?? 1.7) * o.scale.y,
      yaw: o.rotation.y,
      pose: blocking.find((b) => b.characterId === id)?.pose ?? 'standing',
    });
  }
  return out;
}
