// Runtime rig math for LHM splat actors (pure: no DOM, no three.js, no allocation per frame).
//
// rig.json + rig-splats.bin (worker/lhm_stages/rig_build.py) give the canonical splats with top-4
// skin weights and the 55-joint SMPL-X skeleton; motion-library.json + motion-clips.bin
// (worker/motion_library.py) give body-agnostic clips (22 local joint rotations + root offset at
// 30 fps). Per frame: sample clips (slerp-free nlerp between adjacent frames), cross-fade, add
// head look + jaw, forward kinematics, ground the lowest foot, and emit one rigid transform per
// bone for Spark's SplatSkinning (dual quaternions on the GPU).
//
// Frames: everything here is the SMPL-X canonical frame (+Y up, body faces +Z, native metres).
// Quaternions are [x, y, z, w] like three.js.

export const RIG_SCHEMA = 'previz.actor-rig/1';
export const LIBRARY_SCHEMA = 'previz.motion-library/1';
export const BONES = 55;
export const CLIP_JOINTS = 22;
export const JAW = 22;
export const NECK = 12;
export const HEAD = 15;
const FOOT_JOINTS = [7, 8, 10, 11];

export interface RigPointer {
  schema: string;
  file: string;
  sha256?: string;
  clips?: string;
  clipsSha256?: string;
}

interface Section {
  offset: number;
  components: number;
}

export interface RigJson {
  schema: string;
  splats: number;
  bones: number;
  joints: string[];
  parents: number[];
  rest: number[][];
  sourcePose: { root: number[]; body: number[][]; jaw: number[]; lhand: number[][]; rhand: number[][] };
  measure: { nativeHeight: number; soleY: number; footJointMinY: number; soleGap: number; legLength: number };
  files: { splats: { file: string; bytes: number; sha256?: string; layout: Record<'center' | 'quat' | 'scale' | 'rgba' | 'skin', Section> } };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const localFile = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(v);

/** Throws with a reason unless `json` is a usable rig. */
export function validateRig(json: unknown): RigJson {
  const r = json as RigJson;
  if (!r || r.schema !== RIG_SCHEMA) throw new Error('rig schema mismatch');
  if (!(Number.isSafeInteger(r.splats) && r.splats > 0)) throw new Error('rig splat count invalid');
  if (r.bones !== BONES || r.parents?.length !== BONES || r.rest?.length !== BONES) throw new Error('rig skeleton must have 55 joints');
  if (r.parents[0]! >= 0 || r.parents.some((p, i) => i > 0 && !(p >= 0 && p < i))) throw new Error('rig parents not topologically ordered');
  if (!r.rest.every((p) => p.length === 3 && p.every(finite))) throw new Error('rig rest joints invalid');
  const m = r.measure;
  if (!m || ![m.nativeHeight, m.soleY, m.footJointMinY, m.legLength].every(finite) || !(m.nativeHeight > 0)) throw new Error('rig measure invalid');
  const sp = r.sourcePose;
  if (!sp || sp.body?.length !== 21 || sp.lhand?.length !== 15 || sp.rhand?.length !== 15 || sp.jaw?.length !== 3) throw new Error('rig source pose invalid');
  const f = r.files?.splats;
  if (!f || !localFile(f.file) || f.bytes !== r.splats * 44) throw new Error('rig splat file invalid');
  return r;
}

export interface RigSplats {
  n: number;
  center: Float32Array;
  /** int16-normalised [x, y, z, w] */
  quat: Int16Array;
  scale: Float32Array;
  rgba: Uint8Array;
  /** Spark skin words: weight8 | bone << 8, 4 per splat */
  skin: Uint16Array;
}

export function parseRigSplats(buf: ArrayBuffer, rig: RigJson): RigSplats {
  const n = rig.splats;
  const L = rig.files.splats.layout;
  if (buf.byteLength !== rig.files.splats.bytes) throw new Error(`rig-splats.bin is ${buf.byteLength} bytes, expected ${rig.files.splats.bytes}`);
  return {
    n,
    center: new Float32Array(buf, L.center.offset, n * 3),
    quat: new Int16Array(buf, L.quat.offset, n * 4),
    scale: new Float32Array(buf, L.scale.offset, n * 3),
    rgba: new Uint8Array(buf, L.rgba.offset, n * 4),
    skin: new Uint16Array(buf, L.skin.offset, n * 4),
  };
}

// ---------------------------------------------------------------------------------------------
// Motion clips
// ---------------------------------------------------------------------------------------------

export type ClipPose = 'standing' | 'sitting' | 'walking';

interface ClipJson {
  name: string;
  pose: ClipPose;
  speaking: boolean;
  frames: number;
  offset: number;
  /** forward speed (source metres / s) of a walk cycle; 0 for in-place clips */
  speed: number;
  legLength: number;
}

export interface MotionLibraryJson {
  schema: string;
  fps: number;
  joints: number;
  file: string;
  bytes: number;
  sha256?: string;
  clips: ClipJson[];
}

export interface Clip {
  name: string;
  pose: ClipPose;
  speaking: boolean;
  fps: number;
  frames: number;
  /** frames * 22 * 4, [x, y, z, w], local joint rotations (root = global orientation) */
  quats: Float32Array;
  /** frames * 3: pelvis offset from the clip's in-place centre (x lateral, y up, z forward) */
  root: Float32Array;
  speed: number;
  legLength: number;
}

export function validateLibrary(json: unknown): MotionLibraryJson {
  const l = json as MotionLibraryJson;
  if (!l || l.schema !== LIBRARY_SCHEMA) throw new Error('motion library schema mismatch');
  if (l.joints !== CLIP_JOINTS || !finite(l.fps) || !(l.fps > 0)) throw new Error('motion library joints/fps invalid');
  if (!localFile(l.file) || !Array.isArray(l.clips) || !l.clips.length) throw new Error('motion library has no clips');
  for (const c of l.clips) {
    if (!(Number.isSafeInteger(c.frames) && c.frames > 1) || !(c.offset >= 0) || c.offset % 4) throw new Error(`clip ${c.name} invalid`);
    if (c.offset + clipBytes(c.frames) > l.bytes) throw new Error(`clip ${c.name} outside the clip file`);
  }
  return l;
}

/** int16 quaternions (8 B / joint / frame) then float32 root offsets (12 B / frame). */
export const clipBytes = (frames: number) => frames * CLIP_JOINTS * 8 + frames * 12;

export function parseLibrary(json: MotionLibraryJson, buf: ArrayBuffer): Clip[] {
  if (buf.byteLength !== json.bytes) throw new Error(`motion clips are ${buf.byteLength} bytes, expected ${json.bytes}`);
  return json.clips.map((c) => {
    const q16 = new Int16Array(buf, c.offset, c.frames * CLIP_JOINTS * 4);
    const quats = new Float32Array(q16.length);
    for (let i = 0; i < q16.length; i += 4) {
      const x = q16[i]! / 32767;
      const y = q16[i + 1]! / 32767;
      const z = q16[i + 2]! / 32767;
      const w = q16[i + 3]! / 32767;
      const n = Math.hypot(x, y, z, w) || 1;
      quats[i] = x / n;
      quats[i + 1] = y / n;
      quats[i + 2] = z / n;
      quats[i + 3] = w / n;
    }
    const root = new Float32Array(buf.slice(c.offset + c.frames * CLIP_JOINTS * 8, c.offset + clipBytes(c.frames)));
    return { name: c.name, pose: c.pose, speaking: !!c.speaking, fps: json.fps, frames: c.frames, quats, root, speed: c.speed || 0, legLength: c.legLength };
  });
}

// ---------------------------------------------------------------------------------------------
// Quaternion helpers on flat arrays
// ---------------------------------------------------------------------------------------------

/** out[o..o+4] = a[ai..] * b[bi..] (Hamilton, [x, y, z, w]); out may alias a or b. */
export function qmul(out: Float32Array | number[], o: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number) {
  const ax = a[ai]!, ay = a[ai + 1]!, az = a[ai + 2]!, aw = a[ai + 3]!; // prettier-ignore
  const bx = b[bi]!, by = b[bi + 1]!, bz = b[bi + 2]!, bw = b[bi + 3]!; // prettier-ignore
  out[o] = aw * bx + ax * bw + ay * bz - az * by;
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** out[o..o+3] = q[qi..] rotating (x, y, z). */
export function qrot(out: Float32Array | number[], o: number, q: ArrayLike<number>, qi: number, x: number, y: number, z: number) {
  const qx = q[qi]!, qy = q[qi + 1]!, qz = q[qi + 2]!, qw = q[qi + 3]!; // prettier-ignore
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[o] = x + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/** Axis-angle (rotation vector) to quaternion at out[o]. */
export function qFromRotvec(out: Float32Array | number[], o: number, x: number, y: number, z: number) {
  const a = Math.hypot(x, y, z);
  if (a < 1e-12) {
    out[o] = x / 2;
    out[o + 1] = y / 2;
    out[o + 2] = z / 2;
    out[o + 3] = 1;
    return;
  }
  const s = Math.sin(a / 2) / a;
  out[o] = x * s;
  out[o + 1] = y * s;
  out[o + 2] = z * s;
  out[o + 3] = Math.cos(a / 2);
}

/** Normalised lerp of quaternions a, b (hemisphere-corrected) into out[o]. */
export function qnlerp(out: Float32Array | number[], o: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number, t: number) {
  const dot = a[ai]! * b[bi]! + a[ai + 1]! * b[bi + 1]! + a[ai + 2]! * b[bi + 2]! + a[ai + 3]! * b[bi + 3]!;
  const s = dot < 0 ? -t : t;
  const u = 1 - t;
  const x = a[ai]! * u + b[bi]! * s;
  const y = a[ai + 1]! * u + b[bi + 1]! * s;
  const z = a[ai + 2]! * u + b[bi + 2]! * s;
  const w = a[ai + 3]! * u + b[bi + 3]! * s;
  const n = Math.hypot(x, y, z, w) || 1;
  out[o] = x / n;
  out[o + 1] = y / n;
  out[o + 2] = z / n;
  out[o + 3] = w / n;
}

// ---------------------------------------------------------------------------------------------
// Clip sampling and cross-fading
// ---------------------------------------------------------------------------------------------

export interface PoseBuffer {
  /** 22 local rotations [x, y, z, w] */
  q: Float32Array;
  /** root offset (native metres, clip frame) */
  root: Float32Array;
}

/** A pose buffer at the rest pose (identity rotations). */
export function newPose(): PoseBuffer {
  const q = new Float32Array(CLIP_JOINTS * 4);
  for (let j = 0; j < CLIP_JOINTS; j++) q[j * 4 + 3] = 1;
  return { q, root: new Float32Array(3) };
}

/** Pose of a looping clip at time t (s), interpolated between the two nearest frames. */
export function sampleClip(clip: Clip, t: number, out: PoseBuffer): PoseBuffer {
  const f = (((t * clip.fps) % clip.frames) + clip.frames) % clip.frames;
  const i0 = Math.floor(f);
  const i1 = (i0 + 1) % clip.frames;
  const u = f - i0;
  const n = CLIP_JOINTS * 4;
  for (let j = 0; j < CLIP_JOINTS; j++) qnlerp(out.q, j * 4, clip.quats, i0 * n + j * 4, clip.quats, i1 * n + j * 4, u);
  for (let k = 0; k < 3; k++) out.root[k] = clip.root[i0 * 3 + k]! * (1 - u) + clip.root[i1 * 3 + k]! * u;
  return out;
}

/** Frame of `clip` whose body pose (joints 1..21 + root tilt) is closest to `pose`. */
export function closestFrame(clip: Clip, pose: PoseBuffer, stride = 2): number {
  let best = 0;
  let bestD = Infinity;
  const n = CLIP_JOINTS * 4;
  for (let f = 0; f < clip.frames; f += stride) {
    let d = 0;
    for (let j = 0; j < CLIP_JOINTS; j++) {
      const a = f * n + j * 4;
      const dot = clip.quats[a]! * pose.q[j * 4]! + clip.quats[a + 1]! * pose.q[j * 4 + 1]! + clip.quats[a + 2]! * pose.q[j * 4 + 2]! + clip.quats[a + 3]! * pose.q[j * 4 + 3]!;
      d += 1 - Math.abs(dot);
    }
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

interface Layer {
  clip: Clip;
  time: number;
}

/**
 * Plays one clip at a time; `play` cross-fades from the current blended pose over `fade` seconds
 * and enters the new clip at the frame closest to the current pose, so a switch never pops.
 */
export class Mixer {
  private current: Layer | null = null;
  private from: PoseBuffer = newPose();
  private fade = 0;
  private fadeLeft = 0;
  private readonly a = newPose();
  private readonly out = newPose();
  /** playback rate of the current clip (walk deceleration slows it) */
  rate = 1;

  get clip(): Clip | null {
    return this.current?.clip ?? null;
  }

  get clipTime(): number {
    return this.current?.time ?? 0;
  }

  /** 0..1 progress of the running cross-fade (1 = none). */
  get blend(): number {
    return this.fadeLeft > 0 ? 1 - this.fadeLeft / this.fade : 1;
  }

  play(clip: Clip, fade = 0.25, startTime?: number) {
    if (this.current?.clip === clip) return;
    if (this.current) {
      this.from.q.set(this.out.q);
      this.from.root.set(this.out.root);
      this.fade = this.fadeLeft = Math.max(0, fade);
      const time = startTime ?? closestFrame(clip, this.out) / clip.fps;
      this.current = { clip, time };
    } else {
      this.current = { clip, time: startTime ?? 0 };
      this.fade = this.fadeLeft = 0;
    }
  }

  /** Pin the current clip's time (a walk cycle locked to distance travelled). */
  seek(time: number) {
    if (this.current) this.current.time = time;
  }

  /** Advance by dt seconds and return the blended pose (owned by the mixer). */
  update(dt: number, advance = true): PoseBuffer {
    const cur = this.current;
    if (!cur) return this.out;
    if (advance) cur.time += dt * this.rate;
    sampleClip(cur.clip, cur.time, this.a);
    if (this.fadeLeft > 0) {
      this.fadeLeft = Math.max(0, this.fadeLeft - dt);
      const k = this.fade > 0 ? 1 - this.fadeLeft / this.fade : 1;
      const w = k * k * (3 - 2 * k); // smoothstep: no velocity jump at either end
      for (let j = 0; j < CLIP_JOINTS; j++) qnlerp(this.out.q, j * 4, this.from.q, j * 4, this.a.q, j * 4, w);
      for (let i = 0; i < 3; i++) this.out.root[i] = this.from.root[i]! * (1 - w) + this.a.root[i]! * w;
    } else {
      this.out.q.set(this.a.q);
      this.out.root.set(this.a.root);
    }
    return this.out;
  }
}

// ---------------------------------------------------------------------------------------------
// Skeleton: forward kinematics -> per-bone skinning transforms
// ---------------------------------------------------------------------------------------------

export interface Skeleton {
  parents: Int8Array;
  /** rest (zero pose) joint positions, 55 * 3 */
  rest: Float32Array;
  /** static local rotations for joints the clips don't drive (jaw base, eyes, hands), 55 * 4 */
  base: Float32Array;
  footJointMinY: number;
  restPelvis: [number, number, number];
}

export function makeSkeleton(rig: RigJson): Skeleton {
  const rest = new Float32Array(rig.rest.flat());
  const base = new Float32Array(BONES * 4);
  for (let j = 0; j < BONES; j++) base[j * 4 + 3] = 1;
  const sp = rig.sourcePose;
  qFromRotvec(base, JAW * 4, sp.jaw[0]!, sp.jaw[1]!, sp.jaw[2]!);
  sp.lhand.forEach((v, i) => qFromRotvec(base, (25 + i) * 4, v[0]!, v[1]!, v[2]!));
  sp.rhand.forEach((v, i) => qFromRotvec(base, (40 + i) * 4, v[0]!, v[1]!, v[2]!));
  return {
    parents: Int8Array.from(rig.parents),
    rest,
    base,
    footJointMinY: rig.measure.footJointMinY,
    restPelvis: [rest[0]!, rest[1]!, rest[2]!],
  };
}

export interface SkinFrame {
  /** local rotations of all 55 joints (input), [x, y, z, w] */
  local: Float32Array;
  /** world rotation per bone (output) */
  boneQ: Float32Array;
  /** skinning translation per bone: posedJoint - boneQ * restJoint (output) */
  boneT: Float32Array;
  /** posed joint positions (output) */
  joints: Float32Array;
}

export const newSkinFrame = (): SkinFrame => ({
  local: new Float32Array(BONES * 4),
  boneQ: new Float32Array(BONES * 4),
  boneT: new Float32Array(BONES * 3),
  joints: new Float32Array(BONES * 3),
});

const tmpV = [0, 0, 0];

/**
 * FK: root at rest pelvis + `rootOffset`, then shifts the whole skeleton vertically so the lowest
 * foot joint sits where it does in the rest pose (feet on the floor whatever the clip's leg
 * length or a seated pose). Returns that vertical shift.
 */
export function solveSkeleton(sk: Skeleton, frame: SkinFrame, rootOffset: ArrayLike<number>, ground = true): number {
  const { parents, rest } = sk;
  const { local, boneQ, joints } = frame;
  for (let j = 0; j < BONES; j++) {
    const p = parents[j]!;
    if (p < 0) {
      boneQ.set(local.subarray(0, 4), 0);
      joints[0] = rest[0]! + rootOffset[0]!;
      joints[1] = rest[1]! + rootOffset[1]!;
      joints[2] = rest[2]! + rootOffset[2]!;
      continue;
    }
    qmul(boneQ, j * 4, boneQ, p * 4, local, j * 4);
    qrot(tmpV, 0, boneQ, p * 4, rest[j * 3]! - rest[p * 3]!, rest[j * 3 + 1]! - rest[p * 3 + 1]!, rest[j * 3 + 2]! - rest[p * 3 + 2]!);
    joints[j * 3] = joints[p * 3]! + tmpV[0]!;
    joints[j * 3 + 1] = joints[p * 3 + 1]! + tmpV[1]!;
    joints[j * 3 + 2] = joints[p * 3 + 2]! + tmpV[2]!;
  }
  let shift = 0;
  if (ground) {
    let low = Infinity;
    for (const j of FOOT_JOINTS) low = Math.min(low, joints[j * 3 + 1]!);
    shift = sk.footJointMinY - low;
    for (let j = 0; j < BONES; j++) joints[j * 3 + 1] = joints[j * 3 + 1]! + shift;
  }
  for (let j = 0; j < BONES; j++) {
    qrot(tmpV, 0, boneQ, j * 4, rest[j * 3]!, rest[j * 3 + 1]!, rest[j * 3 + 2]!);
    frame.boneT[j * 3] = joints[j * 3]! - tmpV[0]!;
    frame.boneT[j * 3 + 1] = joints[j * 3 + 1]! - tmpV[1]!;
    frame.boneT[j * 3 + 2] = joints[j * 3 + 2]! - tmpV[2]!;
  }
  return shift;
}

/**
 * Fills frame.local from a clip pose plus the actor's static joints, a head yaw (rad, about +Y,
 * split 35/65 over neck and head) and a jaw opening (rad about +X on top of the source jaw).
 */
export function composeLocal(sk: Skeleton, pose: PoseBuffer, frame: SkinFrame, headYaw: number, jawOpen: number, attention = 0) {
  const L = frame.local;
  L.set(sk.base);
  L.set(pose.q, 0); // joints 0..21 from the clip
  if (attention > 0) {
    // keep the clip's nods and posture (swing) but damp its looking around (twist about +Y), so
    // the look target holds the actor's attention
    dampTwist(L, NECK * 4, attention);
    dampTwist(L, HEAD * 4, attention);
  }
  if (headYaw) {
    const yawQ = [0, 0, 0, 1];
    qFromRotvec(yawQ, 0, 0, headYaw * 0.35, 0);
    qmul(L, NECK * 4, yawQ, 0, L, NECK * 4);
    qFromRotvec(yawQ, 0, 0, headYaw * 0.65, 0);
    qmul(L, HEAD * 4, yawQ, 0, L, HEAD * 4);
  }
  if (jawOpen) {
    const jq = [0, 0, 0, 1];
    qFromRotvec(jq, 0, jawOpen, 0, 0);
    qmul(L, JAW * 4, jq, 0, L, JAW * 4);
  }
}

/** Scales the twist (rotation about local +Y) of the quaternion at q[o] by (1 - k), in place. */
export function dampTwist(q: Float32Array, o: number, k: number) {
  const x = q[o]!, y = q[o + 1]!, z = q[o + 2]!, w = q[o + 3]!; // prettier-ignore
  const tn = Math.hypot(y, w);
  if (tn < 1e-6) return;
  // q = swing * twist, twist = (0, y, 0, w) / tn
  const ty = y / tn;
  const tw = w / tn;
  // swing = q * twist^-1
  const sx = x * tw + z * ty;
  const sy = y * tw - w * ty;
  const sz = z * tw - x * ty;
  const sw = w * tw + y * ty;
  const angle = 2 * Math.atan2(ty, tw) * (1 - k);
  const ny = Math.sin(angle / 2);
  const nw = Math.cos(angle / 2);
  // q' = swing * twist'
  q[o] = sx * nw - sz * ny;
  q[o + 1] = sw * ny + sy * nw;
  q[o + 2] = sz * nw + sx * ny;
  q[o + 3] = sw * nw - sy * ny;
}

// ---------------------------------------------------------------------------------------------
// Walking to a mark
// ---------------------------------------------------------------------------------------------

export interface ApproachState {
  /** metres still to go along the approach (0 = on the mark) */
  remaining: number;
  /** playback-rate multiplier for the walk cycle (1 = full speed, eases to ~0.35 at the mark) */
  rate: number;
  walking: boolean;
}

/**
 * Distance left on a straight approach of `length` metres walked at `speed` m/s from scene time
 * 0, decelerating over the last `ease` metres (foot plants stay consistent because the cycle's
 * playback rate scales with the speed). Deterministic in scene time, so laptop and phone agree.
 */
export function approach(sceneTime: number, length: number, speed: number, ease = 0.6, minRate = 0.35): ApproachState {
  if (!(length > 0) || !(speed > 0)) return { remaining: 0, rate: 1, walking: false };
  // before the scene clock starts the actor waits on its starting mark
  if (!(sceneTime > 0)) return { remaining: length, rate: 1, walking: false };
  const t = sceneTime;
  // full speed until `length - ease`, then speed falls linearly with distance to minRate * speed
  const cruise = Math.max(0, length - ease);
  const tCruise = cruise / speed;
  if (t <= tCruise) return { remaining: length - t * speed, rate: 1, walking: true };
  // v(s) = speed * (minRate + (1 - minRate) * s / ease) where s = distance left: exponential decay
  // toward the floor speed, then a floor of minRate * speed until s hits 0.
  const k = (speed * (1 - minRate)) / ease;
  const vmin = speed * minRate;
  // ds/dt = -(vmin + k s), s(0) = ease  ->  s(t) = (ease + vmin/k) e^{-k t} - vmin/k
  const dt = t - tCruise;
  const s = vmin > 0 ? (Math.min(ease, length) + vmin / k) * Math.exp(-k * dt) - vmin / k : Math.min(ease, length) * Math.exp(-k * dt);
  if (s <= 0.002) return { remaining: 0, rate: minRate, walking: false };
  return { remaining: s, rate: minRate + ((1 - minRate) * s) / ease, walking: true };
}
