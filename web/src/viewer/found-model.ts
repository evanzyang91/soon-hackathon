// Found models (docs/PLAN-v4.md "Found models"): a DynamicElement of a procedural kind may carry
// `model`, an open-licence glTF the server found for its label. The procedural body is built first
// and drawn until the model is in place, and again whenever the model cannot be used:
//
//   load       shared per URL (model-cache.ts), ≤ 15 MB, failures and the budget fall back
//   normalise  centred on x / z, lowest point on the ground (a bird centred on its body, a boat
//              sunk a fifth of its height), turned so its front faces −Z (facing below), scaled to
//              PropModel.heightM or to the procedural body it replaces: the height of a walker
//              (creature, dog, horse, pedestrian), the length of everything else; a display
//              platform under the model is hidden; materials stay as authored
//   facing     PropModel.yawOffset when the server gave one; else the named parts (head / jaw /
//              beak / headlight / front / hood / FL FR … against tail / rear / trunk / exhaust /
//              RL RR …, bones and meshes alike); else the clip's own root motion; else the shape:
//              the length is the longer horizontal extent of a clearly elongated ground body, and
//              for flyers and squat bodies the horizontal axis the model is not mirror-symmetric
//              across (a wingspan often beats the fuselage); along it an aircraft's nose carries
//              the propeller, else its tail the fin (the higher end); anything else faces +Z when
//              long along Z (glTF's convention: yaw π) and −X when long along X (three of the four
//              unnamed X-long cars checked did). Verified on 20 Objaverse models (docs/PLAN-v4.md)
//   clips      chosen by intent from their names (idle / stand / breath; walk / trot / fly / flap /
//              swim; run / gallop / sprint; attacks, jumps, deaths, turns and strafes never), or
//              PropModel.clips; an unnamed clip is locomotion when its leg / wing bones repeat
//              (two or more cycles) or it is a short loop, else an idle. Walkers play `move` (or
//              `fast` above the walk-to-run speed of their size, Froude 0.5) with the clip's time
//              driven by the distance travelled, so the feet keep pace with the ground: its natural
//              speed is the root motion's (which is then removed, the path moves the body) or
//              cycles × stride / duration with a stride of 1.5 / 2.1 / 2.7 hip heights (walk /
//              trot / run). Standing (parked, or the pause at the path's end) plays `idle` on the
//              scene clock; the change is a 0.3 s cross-fade. Flyers flap on the scene clock and
//              keep the procedural pitch into climbs and bank into turns.
//   rigid      vehicles, aircraft, boats, spacecraft and generic props move rigidly: nodes named
//              wheel / tyre roll with the distance travelled, rotor / propeller / prop / fan spin,
//              turret sways; their own clips (a propeller loop) play on the scene clock; flyers
//              bob while they hover, a saucer turns slowly
//   fallback   a creature-like kind (creature, dog, horse, pedestrian, bird, dragon, and bicycle /
//              wagon, whose riders and horses the procedural body draws) needs a clip for what it
//              does (a moving one a locomotion clip, a standing one an idle): without, the model is
//              skipped and the procedural body stays, because a gliding statue is worse than a
//              low-poly walker
//
// The director can switch a found model off per prop (setFoundModelUse; the laptop remembers it).
// Everything is a function of the scene clock and the path sample, so laptop and phone agree.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { DynamicElement, DynamicElementKind, PropModel } from '@shared/schema';
import { headingFor } from './dynamics-path';
import { acquireModel, FOUND_MODEL_MAX_BYTES, ModelBudgetError, type LoadedModel } from './model-cache';
import { createProp, MotionProbe, type Prop, type PropMotion } from './props';

// ---- categories ------------------------------------------------------------------------------------

type Drive = 'legs' | 'wings' | 'ground' | 'boat' | 'airplane' | 'helicopter' | 'drone' | 'spacecraft';

const DRIVE: Record<DynamicElementKind, Drive> = {
  creature: 'legs',
  dog: 'legs',
  horse: 'legs',
  pedestrian: 'legs',
  bicycle: 'legs',
  wagon: 'legs',
  bird: 'wings',
  dragon: 'wings',
  car: 'ground',
  bus: 'ground',
  truck: 'ground',
  motorcycle: 'ground',
  generic: 'ground',
  model: 'ground',
  boat: 'boat',
  airplane: 'airplane',
  helicopter: 'helicopter',
  drone: 'drone',
  spacecraft: 'spacecraft',
};

/** Kinds that need their own clips to be drawn from a found model. */
const ANIMATE = new Set<DynamicElementKind>(['creature', 'dog', 'horse', 'pedestrian', 'bird', 'dragon', 'bicycle', 'wagon']);
/** Kinds sized by their height (the rest by their length along the direction of travel). */
const BY_HEIGHT = new Set<DynamicElementKind>(['creature', 'dog', 'horse', 'pedestrian', 'generic', 'model']);

// ---- names -----------------------------------------------------------------------------------------

/** "Velo_l_Leg_HipSHJnt_036" → velo l leg hip shjnt; "loopWalkBack" → loop walk back. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

const words = (s: string) => new Set(s.split(' '));
const FRONT = words(
  'head heads skull jaw snout muzzle beak nose mouth teeth tongue eye eyes headlight headlights headlamp headlamps front hood bonnet grill grille windshield windscreen cockpit propeller spinner bow fl fr',
);
const REAR = words(
  'tail tails rear trunk exhaust brake taillight taillights backlight backlights spoiler rudder elevator stabilizer stabiliser stern tailplane rl rr',
);
const LEG = words('leg legs thigh knee shin calf foot feet ankle toe toes hip upperleg lowerleg femur tibia paw hoof wing wings arm');
const HIP = words('hip hips thigh upperleg femur pelvis');
const PLATFORM = words('platform ground floor pedestal base plinth backdrop shadow turntable display stage plane circle disc disk');
const IDLE = words('idle idling stand standing breath breathe breathing rest resting wait waiting neutral still calm perch hover hovering');
const MOVE = words(
  'walk walking walkcycle trot trotting amble ambling stroll move moving locomotion fly flying flight flap flapping glide gliding swim swimming drive driving crawl slither',
);
const FAST = words('run running gallop galloping sprint sprinting canter cantering charge charging dash fast rush flee');
const NEVER = words(
  'attack atack attacks hit die death dead dying jump jumping eat eating fight strafe srafe back backward backwards turn rotate left right roar roaring hurt damage spawn sit sitting sleep sleeping lay lie lying crouch creep creeping look lookround win lose victory dance emote tpose pose bind throw shoot land landing takeoff start stop end begin transition to',
);

const PART_ROLL = /wheel|tyre|(?<![a-z])tire/i;
const PART_SPIN = /rotor|propel|(?<![a-z])(prop|props|fan|fans|blade|blades)(?![a-z])/i;
const PART_SWAY = /turret/i;
const PART_NOT = /steer|well|arch|house|hub_?cap_?logo/i;

// ---- analysis (once per URL and kind) ------------------------------------------------------------

type Intent = 'idle' | 'move' | 'fast';

interface ClipInfo {
  clip: THREE.AnimationClip;
  /** The clip's natural travel speed in model units / s (legs), 0 when not locomotion. */
  speed: number;
  cycles: number;
  rootMotion: boolean;
}

interface PartInfo {
  /** Index of the node in traversal order (the clones keep the order). */
  index: number;
  how: 'roll' | 'spin' | 'sway';
  /** Centre of its bounds, in its parent's frame. */
  pivot: THREE.Vector3;
  /** Rotation axis, in its parent's frame. */
  axis: THREE.Vector3;
  /** Wheel radius in model units. */
  radius: number;
}

export interface FoundAnalysis {
  /** Yaw that turns the model's front onto −Z. */
  yaw: number;
  facing: 'server' | 'names' | 'root-motion' | 'shape' | 'convention' | 'radial';
  /** Bounds in the model frame with hidden platforms left out. */
  box: THREE.Box3;
  /** Node indices hidden in every clone (display platforms, lights). */
  hidden: number[];
  clips: Partial<Record<Intent, ClipInfo>>;
  /** Hip height in model units (legs; 0.5 × height when no hip bone is named). */
  hip: number;
  parts: PartInfo[];
  /** Round and flat: turns slowly about its axis instead of facing a direction. */
  saucer: boolean;
  /** Why the model is not used for this element, if it is not. */
  unusable?: string;
}

/** Visible-mesh bounds of `root` in its own frame (skinned vertices posed), every `step`-th vertex. */
function visibleBox(root: THREE.Object3D, skip: Set<THREE.Object3D>): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (skip.has(p) || !p.visible) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    m.multiplyMatrices(inv, mesh.matrixWorld);
    const step = Math.max(1, Math.floor(pos.count / 20000));
    for (let i = 0; i < pos.count; i += step) {
      mesh.getVertexPosition(i, v);
      box.expandByPoint(v.applyMatrix4(m));
    }
  });
  return box;
}

/** The centre of a node's meshes (a group named "Headlight" holds its mesh off its origin), else its origin (a bone). */
function nodeCentre(o: THREE.Object3D, rootInv: THREE.Matrix4): THREE.Vector3 {
  let meshes = false;
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh && !(c as THREE.SkinnedMesh).isSkinnedMesh) meshes = true;
  });
  if (meshes) {
    const b = new THREE.Box3().setFromObject(o);
    if (!b.isEmpty()) return b.getCenter(new THREE.Vector3()).applyMatrix4(rootInv);
  }
  return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(rootInv);
}

/**
 * Whether a node name says front / rear: a whole word of the set, or one of the strong words
 * glued to another ("micro_dragon_fino:head" loses its colon to GLTFLoader: "finohead").
 */
const STRONG_FRONT = ['head', 'jaw', 'snout', 'beak', 'skull', 'muzzle'];
const STRONG_REAR = ['tail'];
function says(tokens: string[], set: Set<string>, strong: string[]): boolean {
  return tokens.some((w) => set.has(w) || (w.length > 5 && strong.some((s) => w.startsWith(s) || w.endsWith(s))));
}

/** Snaps a horizontal direction onto the nearest axis when it is within 20° of it. */
function snap(d: THREE.Vector2): THREE.Vector2 {
  const a = Math.atan2(d.y, d.x);
  const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
  return Math.abs(a - q) < THREE.MathUtils.degToRad(20) ? new THREE.Vector2(Math.cos(q), Math.sin(q)) : d.normalize();
}

/** Yaw rotating the model-frame direction (x, z) onto −Z. */
const yawFor = (x: number, z: number) => -headingFor(x, z);

function clipTokens(clips: THREE.AnimationClip[]): Map<THREE.AnimationClip, string[]> {
  // "Velociraptor 1+motions_loopWalk": the prefix every clip shares says nothing about the intent
  const names = clips.map((c) => c.name);
  let prefix = names.length > 1 ? names[0]! : '';
  for (const n of names) while (prefix && !n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return new Map(clips.map((c) => [c, nameTokens(c.name.slice(prefix.length)).filter((t) => t !== 'loop' && t !== 'anim' && t !== 'animation')]));
}

/**
 * Whole cycles in a looping clip: the circular autocorrelation of its leg / wing bone rotations
 * (all rotations when none is named) peaks at the cycle period; 1 when nothing repeats.
 */
function cyclesIn(clip: THREE.AnimationClip): number {
  const dur = clip.duration;
  if (!(dur > 0.4)) return 1;
  const quats = clip.tracks.filter((t) => t.ValueTypeName === 'quaternion');
  const legs = quats.filter((t) => nameTokens(t.name.replace(/\.quaternion$/, '')).some((w) => LEG.has(w)));
  const tracks = (legs.length >= 2 ? legs : quats).slice(0, 24);
  if (!tracks.length) return 1;
  const N = Math.min(300, Math.max(24, Math.round(dur * 30)));
  const series: Float64Array[] = [];
  for (const t of tracks) {
    // every track has one at run time (setInterpolation); a quaternion track's slerps
    const interp = (t as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
    const comps = [new Float64Array(N), new Float64Array(N), new Float64Array(N), new Float64Array(N)];
    let ref: number[] | null = null;
    for (let i = 0; i < N; i++) {
      const q = Array.from(interp.evaluate((i / N) * dur) as ArrayLike<number>);
      ref ??= q;
      const sign = q[0]! * ref[0]! + q[1]! * ref[1]! + q[2]! * ref[2]! + q[3]! * ref[3]! < 0 ? -1 : 1;
      for (let k = 0; k < 4; k++) comps[k]![i] = sign * q[k]!;
    }
    for (const c of comps) {
      let mean = 0;
      for (let i = 0; i < N; i++) mean += c[i]!;
      mean /= N;
      for (let i = 0; i < N; i++) c[i]! -= mean;
      series.push(c);
    }
  }
  const auto = (lag: number) => {
    let s = 0;
    for (const c of series) for (let i = 0; i < N; i++) s += c[i]! * c[(i + lag) % N]!;
    return s;
  };
  const zero = auto(0);
  if (zero < 1e-9) return 1;
  // the period is the first peak after the correlation has fallen away (a smooth pose correlates
  // with itself a moment later; a gait comes back a whole cycle later): a seamless loop of k
  // cycles peaks at N / k
  const half = Math.floor(N / 2);
  const r = new Float64Array(half + 2);
  for (let lag = 1; lag <= half + 1; lag++) r[lag] = auto(lag) / zero;
  let fell = false;
  for (let lag = 2; lag <= half; lag++) {
    if (r[lag]! < 0.25) fell = true;
    if (fell && r[lag]! > 0.6 && r[lag]! >= r[lag - 1]! && r[lag]! >= r[lag + 1]!) return Math.max(1, Math.round(N / lag));
  }
  return 1;
}

/**
 * The root's horizontal travel over the clip in model units, and the clip with that travel taken
 * out (the path moves the prop); null when the clip walks in place.
 */
function rootMotion(clip: THREE.AnimationClip, template: THREE.Object3D, length: number): { d: THREE.Vector3; clip: THREE.AnimationClip } | null {
  let best: { track: THREE.KeyframeTrack; d: THREE.Vector3; local: THREE.Vector3 } | null = null;
  const rootInv = new THREE.Matrix4().copy(template.matrixWorld).invert();
  for (const t of clip.tracks) {
    if (t.ValueTypeName !== 'vector' || !t.name.endsWith('.position')) continue;
    const node = template.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(t.name.slice(0, -'.position'.length)));
    if (!node || !node.parent) continue;
    const n = t.times.length;
    if (n < 2) continue;
    const local = new THREE.Vector3(t.values[(n - 1) * 3]! - t.values[0]!, t.values[(n - 1) * 3 + 1]! - t.values[1]!, t.values[(n - 1) * 3 + 2]! - t.values[2]!);
    const m = new THREE.Matrix4().multiplyMatrices(rootInv, node.parent.matrixWorld);
    const d = local.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(m));
    if (!best || Math.hypot(d.x, d.z) > Math.hypot(best.d.x, best.d.z)) best = { track: t, d, local };
  }
  if (!best || Math.hypot(best.d.x, best.d.z) < 0.2 * length) return null;
  const out = clip.clone();
  const track = out.tracks[clip.tracks.indexOf(best.track)]!;
  const t0 = track.times[0]!;
  const span = Math.max(1e-6, track.times[track.times.length - 1]! - t0);
  for (let i = 0; i < track.times.length; i++) {
    const k = (track.times[i]! - t0) / span;
    track.values[i * 3]! -= best.local.x * k;
    track.values[i * 3 + 1]! -= best.local.y * k;
    track.values[i * 3 + 2]! -= best.local.z * k;
  }
  return { d: best.d, clip: out };
}

/** Clips by intent: PropModel.clips names first, then the names, then the unnamed ones. */
function chooseClips(
  clips: THREE.AnimationClip[],
  names: PropModel['clips'],
  drive: Drive,
): Partial<Record<Intent, THREE.AnimationClip>> & { generic: THREE.AnimationClip[] } {
  const tok = clipTokens(clips);
  const byName = (n: string | undefined) => (n ? (clips.find((c) => c.name === n) ?? clips.find((c) => c.name.toLowerCase().includes(n.toLowerCase()))) : undefined);
  const pick = (set: Set<string>, extraNever?: Set<string>) =>
    clips
      .filter((c) => {
        const t = tok.get(c)!;
        return t.some((w) => set.has(w)) && !t.some((w) => NEVER.has(w) || extraNever?.has(w));
      })
      .sort((a, b) => tok.get(a)!.length - tok.get(b)!.length)[0];
  const generic = clips.filter((c) => !tok.get(c)!.some((w) => IDLE.has(w) || MOVE.has(w) || FAST.has(w) || NEVER.has(w)));
  const moveSet = drive === 'wings' ? new Set([...MOVE, ...FAST]) : MOVE;
  return {
    idle: byName(names?.idle) ?? pick(IDLE, new Set([...MOVE, ...FAST])),
    move: byName(names?.move) ?? pick(moveSet, drive === 'wings' ? undefined : FAST),
    fast: byName(names?.fast) ?? (drive === 'wings' ? undefined : pick(FAST)),
    generic,
  };
}

const STRIDE = { walk: 1.5, trot: 2.1, run: 2.7 };

export function analyseModel(loaded: LoadedModel, el: Pick<DynamicElement, 'kind' | 'model' | 'speed' | 'path'>): FoundAnalysis {
  const moving = el.speed > 0 && pathLen(el.path) >= 0.1;
  const key = `found:${el.kind}:${moving}:${JSON.stringify(el.model?.clips ?? null)}:${el.model?.yawOffset ?? ''}`;
  const cached = loaded.derived.get(key) as FoundAnalysis | undefined;
  if (cached) return cached;
  const drive = DRIVE[el.kind];
  const root = loaded.gltf.scene;
  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => nodes.push(o));

  // display platforms and the lights / cameras a scene export may carry
  const full = loaded.box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5)) : loaded.box;
  const fullSize = full.getSize(new THREE.Vector3());
  const hiddenSet = new Set<THREE.Object3D>();
  nodes.forEach((o) => {
    if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) hiddenSet.add(o);
    if (!(o as THREE.Mesh).isMesh || (o as THREE.SkinnedMesh).isSkinnedMesh) return;
    const chain = [o, o.parent].filter(Boolean).flatMap((n) => nameTokens(n!.name));
    if (!chain.some((w) => PLATFORM.has(w))) return;
    const b = new THREE.Box3().setFromObject(o).applyMatrix4(rootInv);
    const s = b.getSize(new THREE.Vector3());
    const flat = s.y < 0.08 * Math.max(s.x, s.z);
    const wide = s.x > 0.6 * fullSize.x && s.z > 0.6 * fullSize.z;
    const low = b.max.y < full.min.y + 0.3 * fullSize.y;
    if (flat && wide && low) hiddenSet.add(o);
  });
  const box = hiddenSet.size ? visibleBox(root, hiddenSet) : full.clone();
  if (box.isEmpty()) box.copy(full);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const length = Math.max(size.x, size.z, 1e-6);

  // clips
  const chosen = chooseClips(loaded.gltf.animations, el.model?.clips, drive);
  const hipNodes = nodes.filter((o) => nameTokens(o.name).some((w) => HIP.has(w)));
  const hipY = hipNodes.length ? Math.max(...hipNodes.map((o) => nodeCentre(o, rootInv).y)) - box.min.y : 0;
  const hip = hipY > 0.15 * size.y && hipY < size.y ? hipY : 0.5 * size.y;
  const clips: Partial<Record<Intent, ClipInfo>> = {};
  let rootDir: THREE.Vector3 | null = null;
  const info = (clip: THREE.AnimationClip, gait: keyof typeof STRIDE | null, known?: number): ClipInfo => {
    if (!gait) return { clip, speed: 0, cycles: 1, rootMotion: false };
    const rm = drive === 'legs' ? rootMotion(clip, root, length) : null;
    if (rm) {
      rootDir ??= rm.d;
      return { clip: rm.clip, speed: Math.hypot(rm.d.x, rm.d.z) / clip.duration, cycles: 1, rootMotion: true };
    }
    const cycles = known ?? cyclesIn(clip);
    return { clip, speed: (cycles * STRIDE[gait] * hip) / Math.max(0.1, clip.duration), cycles, rootMotion: false };
  };
  const gaitOf = (c: THREE.AnimationClip, fast: boolean): keyof typeof STRIDE =>
    fast ? 'run' : nameTokens(c.name).some((w) => w.startsWith('trot') || w === 'canter') ? 'trot' : 'walk';
  if (chosen.move) clips.move = info(chosen.move, gaitOf(chosen.move, false));
  if (chosen.fast) clips.fast = info(chosen.fast, 'run');
  if (chosen.idle) clips.idle = info(chosen.idle, null);
  // unnamed clips: locomotion when they repeat or are a short loop, else an idle
  for (const c of chosen.generic) {
    const cycles = cyclesIn(c);
    const locomotion = cycles >= 2 || c.duration <= 3;
    if (locomotion && !clips.move && !clips.fast) clips.move = info(c, 'walk', cycles);
    else if (!locomotion && !clips.idle) clips.idle = info(c, null);
  }

  // facing
  const animatedNodes = new Set(
    loaded.gltf.animations.flatMap((c) => c.tracks.map((t) => THREE.PropertyBinding.parseTrackName(t.name).nodeName)),
  );
  let yaw = Math.PI;
  let facing: FoundAnalysis['facing'] = 'convention';
  const saucer =
    drive === 'spacecraft' && Math.abs(size.x - size.z) < 0.12 * Math.max(size.x, size.z) && size.y < 0.75 * Math.max(size.x, size.z);
  if (el.model?.yawOffset !== undefined) {
    yaw = el.model.yawOffset;
    facing = 'server';
  } else {
    const front: THREE.Vector3[] = [];
    const rear: THREE.Vector3[] = [];
    for (const o of nodes) {
      if (o === root || hiddenSet.has(o)) continue;
      const t = nameTokens(o.name);
      const isFront = says(t, FRONT, STRONG_FRONT);
      const isRear = says(t, REAR, STRONG_REAR);
      if (isFront === isRear) continue;
      (isFront ? front : rear).push(nodeCentre(o, rootInv));
    }
    const avg = (ps: THREE.Vector3[]) => ps.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(ps.length);
    const f = front.length ? avg(front) : null;
    const r = rear.length ? avg(rear) : null;
    const d = f && r ? f.clone().sub(r) : f ? f.clone().sub(centre) : r ? centre.clone().sub(r) : null;
    const rd = rootDir as THREE.Vector3 | null;
    if (saucer) {
      yaw = 0;
      facing = 'radial';
    } else if (d && Math.hypot(d.x, d.z) > 0.08 * length) {
      const s = snap(new THREE.Vector2(d.x, d.z));
      yaw = yawFor(s.x, s.y);
      facing = 'names';
    } else if (rd && Math.hypot(rd.x, rd.z) > 1e-6) {
      const s = snap(new THREE.Vector2(rd.x, rd.z));
      yaw = yawFor(s.x, s.y);
      facing = 'root-motion';
    } else {
      // the shape: what travels is left-right symmetric, so the length is the horizontal axis it
      // is not mirror-symmetric across (a wingspan is often longer than the fuselage); a clearly
      // elongated ground body is simply longest along its length
      const ratio = Math.max(size.x, size.z) / Math.max(1e-6, Math.min(size.x, size.z));
      const flies = drive === 'airplane' || drive === 'wings' || drive === 'helicopter' || drive === 'drone' || drive === 'spacecraft';
      const axis: 'x' | 'z' = ratio > 1.3 && !flies ? (size.x > size.z ? 'x' : 'z') : lengthAxis(root, hiddenSet, box);
      // glTF faces +Z; of the unnamed models long along X we checked (cars), three of four face −X
      let sign = axis === 'z' ? 1 : -1;
      facing = axis === 'z' ? 'convention' : 'shape';
      if (drive === 'airplane' || drive === 'helicopter') {
        // the nose carries the propeller (a spinning or animated part at one end); else the tail
        // carries the fin, the higher end
        const nose = spinnerEnd(nodes, animatedNodes, rootInv, axis, centre, size);
        const tops = endTops(root, hiddenSet, box)[axis];
        sign = nose ?? (tops.hi > tops.lo ? -1 : 1);
        facing = 'shape';
      }
      yaw = axis === 'x' ? yawFor(sign, 0) : yawFor(0, sign);
    }
  }

  // parts that turn: wheels roll, rotors / propellers / fans spin, turrets sway
  const parts: PartInfo[] = [];
  const animated = animatedNodes;
  const lateral = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  const claimed = new Set<THREE.Object3D>();
  const boxVolume = Math.max(1e-9, size.x * size.y * size.z);
  if (drive !== 'legs' && drive !== 'wings') {
    nodes.forEach((o, index) => {
      if (o === root || (o as THREE.Bone).isBone || !o.parent || hiddenSet.has(o)) return;
      if (PART_NOT.test(o.name)) return;
      const how = PART_ROLL.test(o.name) ? 'roll' : PART_SPIN.test(o.name) ? 'spin' : PART_SWAY.test(o.name) ? 'sway' : null;
      if (!how) return;
      for (let p: THREE.Object3D | null = o.parent; p; p = p.parent) if (claimed.has(p)) return;
      if (animated.has(o.name)) return;
      const b = new THREE.Box3().setFromObject(o, true).applyMatrix4(rootInv);
      if (b.isEmpty()) return;
      const s = b.getSize(new THREE.Vector3());
      if ((s.x * s.y * s.z) / boxVolume > 0.4) return; // the whole model is "Propeller plane"
      const parentInv = new THREE.Matrix4().copy(o.parent.matrixWorld).invert().multiply(root.matrixWorld);
      const pivot = b.getCenter(new THREE.Vector3()).applyMatrix4(parentInv);
      let axisModel: THREE.Vector3;
      if (how === 'roll') axisModel = lateral.clone();
      else if (how === 'sway') axisModel = new THREE.Vector3(0, 1, 0);
      else axisModel = s.x <= s.y && s.x <= s.z ? new THREE.Vector3(1, 0, 0) : s.y <= s.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      const axis = axisModel.transformDirection(parentInv);
      parts.push({ index, how, pivot, axis, radius: Math.max(1e-4, s.y / 2) });
      claimed.add(o);
    });
  }

  const hidden = nodes.flatMap((o, i) => (hiddenSet.has(o) ? [i] : []));
  let unusable: string | undefined;
  if (ANIMATE.has(el.kind)) {
    if (!loaded.gltf.animations.length) unusable = 'no animation clips';
    else if (moving && !clips.move && !clips.fast) unusable = 'no walk / run / fly clip';
    else if (!moving && !clips.idle && !(drive === 'wings' && clips.move)) unusable = 'no idle clip';
  }
  const out: FoundAnalysis = { yaw, facing, box, hidden, clips, hip, parts, saucer, unusable };
  loaded.derived.set(key, out);
  return out;
}

function pathLen(path: DynamicElement['path']): number {
  let n = 0;
  for (let i = 1; i < path.length; i++) n += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1], path[i]![2] - path[i - 1]![2]);
  return n;
}

/**
 * The horizontal axis a model is long along: the one it is not mirror-symmetric across (16³
 * occupancy of its vertices compared with its mirror image across each vertical centre plane).
 */
function lengthAxis(root: THREE.Object3D, skip: Set<THREE.Object3D>, box: THREE.Box3): 'x' | 'z' {
  const N = 16;
  const grid = new Uint8Array(N * N * N);
  const size = box.getSize(new THREE.Vector3());
  const cell = (v: number, lo: number, s: number) => Math.min(N - 1, Math.max(0, Math.floor(((v - lo) / Math.max(1e-9, s)) * N)));
  eachVertex(root, skip, (v) => {
    grid[cell(v.x, box.min.x, size.x) + N * (cell(v.y, box.min.y, size.y) + N * cell(v.z, box.min.z, size.z))] = 1;
  });
  const iou = (mirrorX: boolean) => {
    let both = 0;
    let any = 0;
    for (let k = 0; k < N; k++)
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const a = grid[i + N * (j + N * k)]!;
          const b = mirrorX ? grid[N - 1 - i + N * (j + N * k)]! : grid[i + N * (j + N * (N - 1 - k))]!;
          both += a & b;
          any += a | b;
        }
    return any ? both / any : 0;
  };
  // symmetric across x (x ↔ −x) = x is the lateral axis = long along z
  return iou(true) >= iou(false) ? 'z' : 'x';
}

function eachVertex(root: THREE.Object3D, skip: Set<THREE.Object3D>, fn: (v: THREE.Vector3) => void) {
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (skip.has(p)) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    m.multiplyMatrices(inv, mesh.matrixWorld);
    const step = Math.max(1, Math.floor(pos.count / 20000));
    for (let i = 0; i < pos.count; i += step) fn(mesh.getVertexPosition(i, v).applyMatrix4(m));
  });
}

/** +1 / −1 when a spinning part (named propeller / rotor / fan, or animated) sits at that end of `axis`. */
function spinnerEnd(
  nodes: THREE.Object3D[],
  animated: Set<string>,
  rootInv: THREE.Matrix4,
  axis: 'x' | 'z',
  centre: THREE.Vector3,
  size: THREE.Vector3,
): number | null {
  for (const o of nodes) {
    if ((o as THREE.Bone).isBone) continue;
    if (!(PART_SPIN.test(o.name) || (animated.has(o.name) && o.children.some((c) => (c as THREE.Mesh).isMesh)))) continue;
    const c = nodeCentre(o, rootInv);
    const off = axis === 'x' ? c.x - centre.x : c.z - centre.z;
    if (Math.abs(off) > 0.3 * (axis === 'x' ? size.x : size.z)) return Math.sign(off);
  }
  return null;
}

/** The highest vertex in the first and last fifth of each horizontal axis, above the model's floor. */
function endTops(root: THREE.Object3D, skip: Set<THREE.Object3D>, box: THREE.Box3) {
  const tops = { x: { lo: 0, hi: 0 }, z: { lo: 0, hi: 0 } };
  const size = box.getSize(new THREE.Vector3());
  eachVertex(root, skip, (v) => {
    const h = v.y - box.min.y;
    const ux = (v.x - box.min.x) / Math.max(1e-6, size.x);
    const uz = (v.z - box.min.z) / Math.max(1e-6, size.z);
    if (ux < 0.2) tops.x.lo = Math.max(tops.x.lo, h);
    if (ux > 0.8) tops.x.hi = Math.max(tops.x.hi, h);
    if (uz < 0.2) tops.z.lo = Math.max(tops.z.lo, h);
    if (uz > 0.8) tops.z.hi = Math.max(tops.z.hi, h);
  });
  return tops;
}

// ---- the director's choice -----------------------------------------------------------------------

const primitive = new Set<string>();
/** Draws the procedural body instead of the found model for element `id` (false) or the model again (true). */
export function setFoundModelUse(id: string, use: boolean) {
  if (use) primitive.delete(id);
  else primitive.add(id);
}
/** Replaces every choice at once (a scene loads with the choices remembered for it). */
export function setPrimitiveIds(ids: Iterable<string>) {
  primitive.clear();
  for (const id of ids) primitive.add(id);
}
export const usesFoundModel = (id: string) => !primitive.has(id);

const flipped = new Set<string>();
/** Turns element `id`'s found model around (its facing was guessed wrong) or back. */
export function setFoundModelFlip(id: string, flip: boolean) {
  if (flip) flipped.add(id);
  else flipped.delete(id);
}
export function setFlippedIds(ids: Iterable<string>) {
  flipped.clear();
  for (const id of ids) flipped.add(id);
}
export const isFoundModelFlipped = (id: string) => flipped.has(id);

// ---- the prop --------------------------------------------------------------------------------------

export type FoundStatus = 'loading' | 'ready' | 'failed' | 'skipped';

/** What a found-model prop reports (object.userData.found, debug hook / UI). */
export interface FoundInfo {
  status: FoundStatus;
  /** What is drawn now. */
  body: 'procedural' | 'model';
  /** Why the model is not drawn (over budget, no clips, the load error, the director's choice). */
  reason?: string;
  /** The clip playing now (its name), if any. */
  clip?: string;
  /**
   * Walkers: the travelling clip's playback rate (path speed / the clip's natural speed at this
   * size) and how that natural speed was found ('root motion' or '<n> cycles').
   */
  rate?: number;
  gait?: string;
  /** Rigid models: the named parts that turn ("4 roll, 1 spin"). */
  parts?: string;
  facing?: FoundAnalysis['facing'];
  loadMs?: number;
  bytes?: number;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
const FADE = 0.3;

const LOAD_TIMEOUT_MS = 60_000;

/** The procedural body of `el`, replaced by its found model (`url`) once that loads and suits it. */
export function createFoundProp(el: DynamicElement, url: string): Prop {
  const model = el.model!;
  const body = createProp(el.kind, el.label);
  const object = body.object;
  const own = [...object.children];
  object.updateMatrixWorld(true);
  const bodyBox = new THREE.Box3().setFromObject(object, true);
  const bodySize = bodyBox.isEmpty() ? new THREE.Vector3(1, 1, 1) : bodyBox.getSize(new THREE.Vector3());
  const drive = DRIVE[el.kind];
  const info: FoundInfo = { status: 'loading', body: 'procedural' };
  object.userData.found = info;
  object.userData.modelUrl = url;

  const handle = acquireModel(url, FOUND_MODEL_MAX_BYTES);
  let disposed = false;
  let drawn = false;
  let rig: Rig | null = null;
  const t0 = performance.now();

  const show = (useModel: boolean) => {
    if (!rig) return;
    drawn = useModel;
    rig.group.visible = useModel;
    for (const c of own) c.visible = !useModel;
    info.body = useModel ? 'model' : 'procedural';
    info.reason = useModel ? undefined : 'primitive chosen';
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no model after ${LOAD_TIMEOUT_MS / 1000} s`)), LOAD_TIMEOUT_MS);
  });
  void Promise.race([handle.promise, timeout])
    .then((loaded) => {
      if (disposed) return;
      info.loadMs = Math.round(performance.now() - t0);
      info.bytes = loaded.bytes;
      const a = analyseModel(loaded, el);
      info.facing = a.facing;
      if (a.unusable) {
        info.status = 'skipped';
        info.reason = a.unusable;
        return;
      }
      rig = buildRig(loaded, a, el, model, bodySize, drive, object);
      object.add(rig.group);
      if (rig.gait) {
        info.rate = Math.round(rig.gait.rate * 100) / 100;
        info.gait = rig.gait.how;
      }
      if (a.parts.length) {
        const n = (how: string) => a.parts.filter((p) => p.how === how).length;
        info.parts = (['roll', 'spin', 'sway'] as const).filter((h) => n(h)).map((h) => `${n(h)} ${h}`).join(', ');
      }
      info.status = 'ready';
      show(usesFoundModel(el.id));
    })
    .catch((err: unknown) => {
      if (disposed) return;
      info.status = err instanceof ModelBudgetError ? 'skipped' : 'failed';
      info.reason = err instanceof Error ? err.message : String(err);
      console.warn(`[props] found model ${url} for ${el.id} not used (${info.reason}); drawing the ${el.kind} instead`);
    })
    .finally(() => clearTimeout(timer));

  return {
    object,
    animate(distance, time, motion) {
      if (rig && usesFoundModel(el.id) !== drawn) show(!drawn);
      if (drawn && rig) {
        rig.animate(distance, time, motion);
        info.clip = rig.clipName;
      } else {
        body.animate(distance, time, motion);
        info.clip = undefined;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      rig?.dispose();
      body.dispose();
      object.removeFromParent();
      handle.release();
    },
  };
}

interface Rig {
  group: THREE.Group;
  clipName: string | undefined;
  gait?: { rate: number; how: string };
  animate(distance: number, time: number, motion?: PropMotion): void;
  dispose(): void;
}

function buildRig(
  loaded: LoadedModel,
  a: FoundAnalysis,
  el: DynamicElement,
  model: PropModel,
  bodySize: THREE.Vector3,
  drive: Drive,
  object: THREE.Object3D,
): Rig {
  const { gltf } = loaded;
  const root = loaded.skinned ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => nodes.push(o));
  for (const i of a.hidden) if (nodes[i]) nodes[i]!.visible = false;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false; // bones move it outside its bind box
  });

  // spinning parts: a pivot at the part's centre, the part hanging from it unchanged
  const parts = a.parts.flatMap((p) => {
    const node = nodes[p.index];
    if (!node?.parent) return [];
    const pivot = new THREE.Group();
    pivot.name = `${node.name}:pivot`;
    pivot.position.copy(p.pivot);
    node.parent.add(pivot);
    node.position.sub(p.pivot);
    pivot.add(node);
    return [{ ...p, pivot }];
  });

  const size = a.box.getSize(new THREE.Vector3());
  const centre = a.box.getCenter(new THREE.Vector3());
  // the model's extent along its own front (after the facing turn)
  const f = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), -a.yaw);
  const along = Math.abs(f.x) * size.x + Math.abs(f.z) * size.z;
  let s: number;
  if (model.heightM) s = model.heightM / Math.max(1e-6, size.y);
  else if (el.kind === 'generic') s = 1 / Math.max(1e-6, size.y);
  else if (BY_HEIGHT.has(el.kind)) s = bodySize.y / Math.max(1e-6, size.y);
  else s = Math.max(bodySize.z, 1e-3) / Math.max(1e-6, along);

  const group = new THREE.Group();
  group.name = 'found-model';
  const attitude = new THREE.Group();
  attitude.name = 'attitude';
  const h = size.y * s;
  attitude.position.y = drive === 'wings' && el.kind === 'bird' ? 0 : h / 2;
  const turn = new THREE.Group();
  turn.name = 'model-yaw';
  turn.position.y = -attitude.position.y;
  turn.rotation.y = a.yaw;
  const fit = new THREE.Group();
  fit.name = 'model-fit';
  fit.scale.setScalar(s);
  const floor = el.kind === 'bird' ? centre.y : drive === 'boat' ? a.box.min.y + 0.2 * size.y : a.box.min.y;
  fit.position.set(-centre.x * s, -floor * s, -centre.z * s);
  fit.add(root);
  turn.add(fit);
  attitude.add(turn);
  group.add(attitude);

  // clips
  const mixer = gltf.animations.length ? new THREE.AnimationMixer(root) : null;
  const action = (c: ClipInfo | undefined, second = false) => {
    if (!mixer || !c) return null;
    const act = mixer.clipAction(second ? c.clip.clone() : c.clip);
    act.play();
    act.setEffectiveWeight(0);
    return act;
  };
  const rigid = drive !== 'legs' && drive !== 'wings';
  // a rigid model plays its own loop (a propeller, a blinking light) on the scene clock
  const loopClip = rigid ? (a.clips.move ?? a.clips.idle ?? (gltf.animations[0] ? { clip: gltf.animations[0], speed: 0, cycles: 1, rootMotion: false } : undefined)) : undefined;
  const loopAct = action(loopClip);
  const parked = !(el.speed > 0 && pathLen(el.path) >= 0.1);
  // a parked flyer without an idle keeps flapping (it hovers); a walker never walks on the spot
  const idle = rigid ? undefined : (a.clips.idle ?? (parked && drive === 'wings' ? a.clips.move : undefined));
  const moving =
    rigid || parked
      ? undefined
      : el.speed > (a.clips.fast && a.clips.move ? Math.sqrt(0.5 * 9.81 * a.hip * s) : Infinity)
        ? a.clips.fast
        : (a.clips.move ?? a.clips.fast);
  const idleAct = action(idle);
  const moveAct = action(moving, !!idle && moving?.clip === idle.clip);
  // the prop's object is what the path moves: its change between frames is the climb and the turn
  const probe = drive === 'legs' || drive === 'ground' ? null : new MotionProbe(object, 0.3, 0.5);
  const natural = moving && drive === 'legs' ? moving.speed * s : 0;
  const rig: Rig = {
    group,
    clipName: undefined,
    gait: natural > 0 ? { rate: el.speed / natural, how: moving!.rootMotion ? 'root motion' : `${moving!.cycles} cycle${moving!.cycles > 1 ? 's' : ''}` } : undefined,
    animate(distance, time, motion) {
      const scaleW = s * object.scale.x;
      // ---- clips
      if (mixer) {
        if (loopAct && loopClip) {
          loopAct.time = time % loopClip.clip.duration;
          loopAct.setEffectiveWeight(1);
          rig.clipName = loopClip.clip.name;
        } else {
          const travelling = !motion || motion.phase === 'moving';
          const since = motion?.since ?? 1e9;
          let wMove = moveAct ? (travelling ? smooth(since / FADE) : 1 - smooth(since / FADE)) : 0;
          if (!idleAct) wMove = moveAct ? 1 : 0;
          if (moveAct && moving) {
            const d = moving.clip.duration;
            if (drive === 'legs') {
              // the feet keep pace: clip seconds = metres / the clip's natural speed at this scale
              const v = moving.speed * scaleW;
              moveAct.time = idleAct || travelling ? (v > 1e-6 ? distance / v : time) % d : 0;
            } else moveAct.time = time % d;
            moveAct.setEffectiveWeight(wMove);
          }
          if (idleAct && idle) {
            idleAct.time = time % idle.clip.duration;
            idleAct.setEffectiveWeight(1 - wMove);
          }
          rig.clipName = (wMove >= 0.5 ? moving : idle)?.clip.name;
        }
        mixer.update(0);
      }
      // ---- parts
      for (const p of parts) {
        const angle =
          p.how === 'roll'
            ? ((flipped.has(el.id) ? 1 : -1) * distance) / Math.max(1e-4, p.radius * scaleW)
            : p.how === 'spin'
              ? time * (drive === 'ground' || drive === 'boat' ? 20 : 45)
              : 0.35 * Math.sin(time * 0.4);
        p.pivot.quaternion.setFromAxisAngle(p.axis, angle);
      }
      // ---- attitude
      if (probe) {
        probe.update(time);
        const hover = drive === 'helicopter' || drive === 'drone' || drive === 'spacecraft';
        const bob = hover ? 0.04 * h * Math.sin(time * 1.1) : drive === 'boat' ? 0.02 * h * Math.sin(time * 0.9) : 0;
        attitude.position.y = (el.kind === 'bird' ? 0 : h / 2) + bob;
        if (drive === 'boat') {
          attitude.rotation.x = 0.03 * Math.sin(time * 0.7);
          attitude.rotation.z = 0.04 * Math.sin(time * 0.9 + 1);
        } else {
          const noseDown = drive === 'helicopter' || drive === 'drone' ? -Math.min(0.25, probe.speed * 0.02) : 0;
          attitude.rotation.x = probe.pitch + noseDown;
          attitude.rotation.z = probe.bank;
        }
      }
      // the director's "Turn around" and a saucer's slow spin
      turn.rotation.y = a.yaw + (flipped.has(el.id) ? Math.PI : 0) + (a.saucer ? time * 0.6 : 0);
    },
    dispose() {
      if (mixer) {
        mixer.stopAllAction();
        mixer.uncacheRoot(root);
      }
      group.removeFromParent();
    },
  };
  return rig;
}
