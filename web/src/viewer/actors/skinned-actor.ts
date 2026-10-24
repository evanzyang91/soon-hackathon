// LHM splat actor animated at runtime: one SplatMesh of canonical splats skinned on the GPU by
// Spark's SplatSkinning (dual quaternions, 4 bones per splat) from the shared motion library.
// Replaces the baked 12 fps frame loop when the sequence ships a rig (sequence.json `rig`):
// ~1.8 MB of splats + ~0.4 MB of clips instead of a 40 MB per-frame track, render-rate motion,
// cross-faded clips, head look-at, voice-driven jaw, real sitting and walking to the mark.
import * as THREE from 'three';
import { PackedSplats, SplatMesh, SplatSkinning, SplatSkinningMode, setPackedSplat } from '@sparkjsdev/spark';
import type { ActorAsset } from '@shared/schema';
import { sha256Hex } from '@shared/actor-sequence';
import {
  BONES,
  Mixer,
  approach,
  newPose,
  sampleClip,
  composeLocal,
  makeSkeleton,
  newSkinFrame,
  parseLibrary,
  parseRigSplats,
  solveSkeleton,
  validateLibrary,
  validateRig,
  type Clip,
  type ClipPose,
  type RigPointer,
} from './rig';

type SplatAsset = Extract<ActorAsset, { kind: 'splat-sequence' }>;
export type BodyPose = 'standing' | 'sitting' | 'walking';

/** Walk-cycle playback rate: ~1.2 m/s at a natural cadence (the library cycle is ~1.0 m/s). */
export const WALK_RATE = 1.2;
/** Share of the clips' own head turning removed while the actor has someone to look at. */
const ATTENTION = 0.6;
/** Cross-fade between clips (s). */
export const FADE_S = 0.25;
/** Cross-fade from the walk cycle into standing on the mark (s): a settling step, not a snap. */
export const FADE_STOP_S = 0.45;
/** How far behind its mark a `walking` actor starts (m, along its facing direction). */
export const APPROACH_M = 2.4;
/** Head turn limit toward the look target (rad) and how fast it eases (1/s). */
const LOOK_LIMIT = 1.0;
const LOOK_RATE = 4;
/** Jaw opening at full voice level (rad) and its attack / release rates (1/s). */
const JAW_MAX = 0.2;
const JAW_ATTACK = 30;
const JAW_RELEASE = 12;

export interface SkinnedBody {
  root: THREE.Group;
  mesh: SplatMesh;
  headY: number;
  /** true when the library has seated clips (the body really sits; no lowering needed) */
  canSit: boolean;
  animate(dt: number, sceneTime: number, speaking: boolean, level: number): void;
  setPose(pose: BodyPose): void;
  /** head yaw toward the look target relative to the body (rad, + = left); null = none */
  look(yaw: number | null): void;
  /** where the body stands relative to the actor's mark (metres, actor frame; walking moves it) */
  readonly offset: THREE.Vector3;
  /** library clip names, in library order */
  readonly clipNames: string[];
  /** Force a library clip (review / director override); null returns to automatic selection. */
  play(name: string | null): void;
  /**
   * Beats (shared/beats.ts) move the actor between marks: while `walking`, the walk cycle is
   * locked to `walked` metres so the feet keep pace with the actor's travel. Replaces the
   * built-in walk-in to the mark from then on.
   */
  travel(walking: boolean, walked: number): void;
  debug(): Record<string, number>;
  dispose(): void;
}

async function fetchVerified(url: string, sha?: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if ((res.headers.get('content-type') ?? '').startsWith('text/html')) throw new Error(`${url}: not found`);
  const buf = await res.arrayBuffer();
  // crypto.subtle exists only in secure contexts (the app is served over HTTPS)
  if (sha && typeof crypto !== 'undefined' && crypto.subtle && (await sha256Hex(buf)) !== sha)
    throw new Error(`${url}: SHA-256 mismatch`);
  return buf;
}

const json = (buf: ArrayBuffer) => JSON.parse(new TextDecoder().decode(buf)) as unknown;

/** Small deterministic hash -> [0, 1): each actor starts its loops at its own phase. */
function phase(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}

export async function loadSkinnedBody(asset: SplatAsset, dir: string, pointer: RigPointer): Promise<SkinnedBody> {
  const url = (name: string) => new URL(name, dir).href;
  if (!pointer.clips) throw new Error('rig has no motion library');
  const [rigBuf, libBuf] = await Promise.all([fetchVerified(url(pointer.file), pointer.sha256), fetchVerified(url(pointer.clips), pointer.clipsSha256)]);
  const rig = validateRig(json(rigBuf));
  const lib = validateLibrary(json(libBuf));
  const [splatBuf, clipBuf] = await Promise.all([
    fetchVerified(url(rig.files.splats.file), rig.files.splats.sha256),
    fetchVerified(url(lib.file), lib.sha256),
  ]);
  const s = parseRigSplats(splatBuf, rig);
  const clips = parseLibrary(lib, clipBuf);

  const n = s.n;
  const packed = new Uint32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const qx = s.quat[i * 4]! / 32767;
    const qy = s.quat[i * 4 + 1]! / 32767;
    const qz = s.quat[i * 4 + 2]! / 32767;
    const qw = s.quat[i * 4 + 3]! / 32767;
    const qn = Math.hypot(qx, qy, qz, qw) || 1;
    setPackedSplat(
      packed,
      i,
      s.center[i * 3]!,
      s.center[i * 3 + 1]!,
      s.center[i * 3 + 2]!,
      s.scale[i * 3]!,
      s.scale[i * 3 + 1]!,
      s.scale[i * 3 + 2]!,
      qx / qn,
      qy / qn,
      qz / qn,
      qw / qn,
      s.rgba[i * 4 + 3]! / 255,
      s.rgba[i * 4]! / 255,
      s.rgba[i * 4 + 1]! / 255,
      s.rgba[i * 4 + 2]! / 255,
    );
  }
  const packedSplats = new PackedSplats({ packedArray: packed, numSplats: n });
  const mesh = new SplatMesh({ packedSplats });
  await mesh.initialized;
  const skin = new SplatSkinning({ mesh, numSplats: n, numBones: BONES, mode: SplatSkinningMode.DUAL_QUATERNION });
  skin.skinData.set(s.skin);
  skin.skinTexture.needsUpdate = true;
  // Spark's DQ path rotates about the origin relative to a rest pose; identity rests make each
  // bone transform the full rigid skinning transform (rotation boneQ, translation boneT).
  const qI = new THREE.Quaternion();
  const v0 = new THREE.Vector3();
  for (let j = 0; j < BONES; j++) skin.setRestQuatPos(j, qI, v0);
  mesh.skinning = skin;
  mesh.updateGenerator();

  const sk = makeSkeleton(rig);
  const m = rig.measure;
  // SMPL-X frame (faces +Z) -> actor frame (faces -Z), feet on y = 0, pelvis over the mark
  const inner = new THREE.Group();
  inner.position.set(-sk.restPelvis[0], -m.soleY, -sk.restPelvis[2]);
  inner.add(mesh);
  const orient = new THREE.Group();
  orient.rotation.y = Math.PI;
  orient.add(inner);
  const heightM = asset.heightMeters ?? 1.7;
  const scale = heightM / m.nativeHeight;
  const root = new THREE.Group();
  root.name = 'splat-body';
  root.scale.setScalar(scale);
  root.add(orient);

  const by = (pose: ClipPose, speaking: boolean) => clips.filter((c) => c.pose === pose && c.speaking === speaking);
  const sets = {
    standing: { idle: by('standing', false), talk: by('standing', true) },
    sitting: { idle: by('sitting', false), talk: by('sitting', true) },
  };
  if (!sets.standing.idle.length) throw new Error('motion library has no standing idle clip');
  if (!sets.standing.talk.length) sets.standing.talk = sets.standing.idle;
  const canSit = sets.sitting.idle.length > 0;
  if (!sets.sitting.talk.length) sets.sitting.talk = sets.sitting.idle;
  const walk = clips.find((c) => c.pose === 'walking') ?? null;
  const legRatio = (c: Clip) => (c.legLength > 0 ? m.legLength / c.legLength : 1);
  /** metres per second the actor covers with the walk cycle at rate 1 */
  /** metres per second of clip time (stride length per cycle / cycle duration) for this actor */
  const strideSpeed = walk ? walk.speed * legRatio(walk) * scale : 0;
  const walkSpeed = strideSpeed * WALK_RATE;
  // The walk cycle's clip time is locked to the distance walked (no foot sliding at any speed),
  // phased so the actor arrives at the cycle frame closest to standing: the stop then needs the
  // least leg motion.
  const walkPhase = (() => {
    if (!walk || !(strideSpeed > 0)) return 0;
    // the passing frame: ankles closest together horizontally (one foot swinging past the other)
    const pose = newPose();
    const f = newSkinFrame();
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < walk.frames; i++) {
      sampleClip(walk, i / walk.fps, pose);
      composeLocal(sk, pose, f, 0, 0);
      solveSkeleton(sk, f, pose.root);
      const d = Math.hypot(f.joints[7 * 3]! - f.joints[8 * 3]!, f.joints[7 * 3 + 2]! - f.joints[8 * 3 + 2]!);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best / walk.fps - APPROACH_M / strideSpeed;
  })();

  const mixer = new Mixer();
  const frame = newSkinFrame();
  const rootOffset = new Float32Array(3);
  const q = new THREE.Quaternion();
  const t = new THREE.Vector3();
  const offset = new THREE.Vector3();
  let pose: BodyPose = 'standing';
  let lookTarget: number | null = null;
  let lookYaw = 0;
  let jaw = 0;
  let line = 0;
  let wasSpeaking = false;
  let remaining = 0;
  let forced: Clip | null = null;
  let travel: { walking: boolean; walked: number } | null = null;
  const start = phase(asset.characterId);
  const idleOf = () => (pose === 'sitting' && canSit ? sets.sitting : sets.standing);
  mixer.play(idleOf().idle[0]!, 0, start * idleOf().idle[0]!.frames / idleOf().idle[0]!.fps);

  return {
    root,
    mesh,
    headY: heightM * 0.93,
    canSit,
    offset,
    clipNames: clips.map((c) => c.name),
    play(name) {
      forced = name === null ? null : (clips.find((c) => c.name === name) ?? null);
    },
    travel(walking, walked) {
      travel = { walking, walked };
    },
    animate(dt, sceneTime, speaking, level) {
      if (speaking && !wasSpeaking) line++;
      wasSpeaking = speaking;
      let walking = false;
      if (travel) {
        walking = travel.walking && !!walk && strideSpeed > 0;
        remaining = 0; // the actor object itself moves along the beat's path
      } else if (pose === 'walking' && walk && walkSpeed > 0) {
        const st = approach(sceneTime, APPROACH_M, walkSpeed);
        remaining = st.remaining;
        walking = st.walking;
      } else remaining = 0;
      const set = idleOf();
      const want = forced ?? (walking ? walk! : speaking ? set.talk[line % set.talk.length]! : set.idle[0]!);
      const wasWalk = mixer.clip === walk && walk !== null;
      // phase 0 of the distance lock is the passing frame (walkPhase includes the approach length)
      const walked = travel ? travel.walked : APPROACH_M - remaining;
      const walkTime = walkPhase + walked / (strideSpeed || 1);
      mixer.play(want, wasWalk && want !== walk ? FADE_STOP_S : FADE_S, want === walk && !forced ? walkTime : undefined);
      mixer.rate = 1;
      if (walking && mixer.clip === walk && !forced) mixer.seek(walkTime);
      const p = mixer.update(dt, !(walking && mixer.clip === walk && !forced));
      const k = legRatio(mixer.clip ?? want);
      rootOffset[0] = p.root[0]! * k;
      rootOffset[1] = 0;
      rootOffset[2] = p.root[2]! * k;
      // ease the head toward the look target, limited, never snapping
      const target = lookTarget === null ? 0 : Math.max(-LOOK_LIMIT, Math.min(LOOK_LIMIT, lookTarget));
      lookYaw += (target - lookYaw) * (1 - Math.exp(-LOOK_RATE * dt));
      const want01 = speaking ? Math.min(1, level * 1.6) : 0;
      jaw += (want01 * JAW_MAX - jaw) * (1 - Math.exp(-(want01 * JAW_MAX > jaw ? JAW_ATTACK : JAW_RELEASE) * dt));
      composeLocal(sk, p, frame, walking ? 0 : lookYaw, jaw, lookTarget === null || walking ? 0 : ATTENTION);
      solveSkeleton(sk, frame, rootOffset);
      for (let j = 0; j < BONES; j++) {
        q.set(frame.boneQ[j * 4]!, frame.boneQ[j * 4 + 1]!, frame.boneQ[j * 4 + 2]!, frame.boneQ[j * 4 + 3]!);
        t.set(frame.boneT[j * 3]!, frame.boneT[j * 3 + 1]!, frame.boneT[j * 3 + 2]!);
        skin.setBoneQuatPos(j, q, t);
      }
      skin.updateBones();
      // walking: the body approaches its mark along the actor's facing direction (-Z)
      offset.set(0, 0, remaining);
      root.position.x = offset.x; // y belongs to setPose (seated lowering without sit clips)
      root.position.z = offset.z;
    },
    setPose(next) {
      pose = next;
    },
    look(yaw) {
      lookTarget = yaw;
    },
    debug() {
      const c = mixer.clip;
      return {
        skinned: 1,
        clip: c ? clips.indexOf(c) : -1,
        clipTime: Math.round(mixer.clipTime * 100) / 100,
        blend: Math.round(mixer.blend * 100) / 100,
        walkRemaining: Math.round(remaining * 100) / 100,
        jaw: Math.round(jaw * 1000) / 1000,
        look: Math.round(lookYaw * 1000) / 1000,
      };
    },
    dispose() {
      mesh.skinning = null;
      skin.skinTexture.dispose();
      skin.boneTexture.dispose();
      mesh.dispose();
      packedSplats.dispose();
    },
  };
}
