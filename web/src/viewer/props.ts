// Bundled low-poly props built from three.js primitives (no external assets), sized in metres and
// facing -Z, so the drivers' `rotation.y = heading` points the nose along the path.
//
// Origins: ground kinds sit on the ground under the body (the path is the road). A boat's origin
// is its waterline (the path is the water plane the planner chose; nothing snaps it to y = 0).
// The bird's origin is its body; the dragon, drone and spacecraft have theirs at their underside
// at rest, so a path at y = 0 parks them on the ground and a path at height h flies them with
// their belly at h. Nothing here assumes the path is at y = 0.
//
// Every prop stays under ~3k triangles: the phone draws them next to a splat world.
import * as THREE from 'three';
import type { DynamicElement } from '@shared/schema';

export interface Prop {
  object: THREE.Group;
  /** distance = metres travelled (wheels, legs), time = scene seconds (wings, rotors, bobbing). */
  animate(distance: number, time: number): void;
  dispose(): void;
}

const COLOR_WORDS: Record<string, string> = {
  red: '#c0392b',
  blue: '#2e6bd6',
  green: '#2e8b57',
  yellow: '#e8c33a',
  white: '#e8e8e8',
  black: '#222222',
  silver: '#a9b0b8',
  grey: '#7d848c',
  gray: '#7d848c',
  orange: '#e67e22',
  purple: '#7d4bb3',
  brown: '#7a5232',
  pink: '#e58fb0',
};

/** Picks a body colour from the element label ("a red sedan drives past") or a kind default. */
export function propColor(label: string, fallback: string): string {
  const words = label.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const w of words) if (COLOR_WORDS[w]) return COLOR_WORDS[w]!;
  return fallback;
}

const HORSE_NOUN = /^(horses?|mares?|stallions?|steeds?|pony|ponies|team|geldings?|mules?)$/;

/** The colour word right before a horse noun ("pulled by two white horses"), if any. */
function horseColor(label: string): string | undefined {
  const words = label.toLowerCase().match(/[a-z]+/g) ?? [];
  for (let i = 1; i < words.length; i++) {
    if (HORSE_NOUN.test(words[i]!) && COLOR_WORDS[words[i - 1]!]) return COLOR_WORDS[words[i - 1]!];
  }
  return undefined;
}

/** A horse carries a rider when the label says so ("a rider gallops past"; not "riderless"). */
export const RIDER_RE =
  /\b(riders?|rides|riding|ridden|horseback|mounted|cavalry|cavalrymen|cavalryman|jockeys?|horsem[ae]n|horsewom[ae]n|knights?|cowboys?|cowgirls?)\b/i;
const GALLOP_RE = /\b(gallop\w*|charg\w*|rac(e|es|ing)|thunder\w*|stampede\w*|bolts?)\b/i;
const COACH_RE = /\b(stage-?coach(es)?|coach(es)?|carriages?|hackney|landau|brougham|hansom)\b/i;
const COVERED_RE = /\b(covered|canvas|conestoga|prairie schooner)\b/i;
const SAIL_RE =
  /\b(sail\w*|yachts?|schooners?|sloops?|ketch(es)?|galleons?|brigs?|dhows?|junks?)\b/i;

type V3 = [number, number, number];
const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Lightens (k > 0, toward white) or darkens (k < 0, toward black) a colour by |k|. */
function shade(color: string, k: number): string {
  const c = new THREE.Color(color);
  c.lerp(new THREE.Color(k > 0 ? '#ffffff' : '#000000'), Math.min(1, Math.abs(k)));
  return `#${c.getHexString()}`;
}

interface MatOpts {
  metalness?: number;
  roughness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  /** Thin sheets (wings, sails, canvas) are seen from both sides. */
  doubleSided?: boolean;
  opacity?: number;
}

class Builder {
  readonly group = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats = new Map<string, THREE.MeshStandardMaterial>();
  private readonly owned: THREE.Material[] = [];

  mat(color: string, opts: MatOpts = {}) {
    const key = JSON.stringify([
      color,
      opts.metalness ?? 0,
      opts.roughness ?? 0.7,
      opts.emissive ?? '',
      opts.emissiveIntensity ?? 1,
      !!opts.doubleSided,
      opts.opacity ?? 1,
    ]);
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color,
        metalness: opts.metalness ?? 0,
        roughness: opts.roughness ?? 0.7,
        flatShading: true,
        side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      });
      if (opts.emissive) {
        m.emissive.set(opts.emissive);
        m.emissiveIntensity = opts.emissiveIntensity ?? 1;
      }
      if (opts.opacity !== undefined && opts.opacity < 1) {
        m.transparent = true;
        m.opacity = opts.opacity;
        m.depthWrite = false;
      }
      this.mats.set(key, m);
    }
    return m;
  }

  /** A material this prop animates on its own (engine glow) or a non-standard one; disposed too. */
  own<M extends THREE.Material>(m: M): M {
    this.owned.push(m);
    return m;
  }

  add<G extends THREE.BufferGeometry>(
    geo: G,
    material: THREE.Material | THREE.Material[],
    pos: V3 = [0, 0, 0],
    parent: THREE.Object3D = this.group,
  ) {
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(...pos);
    mesh.castShadow = false;
    parent.add(mesh);
    return mesh;
  }

  /** An empty transform node: the joint an animated part rotates about. */
  pivot(pos: V3, parent: THREE.Object3D = this.group) {
    const g = new THREE.Group();
    g.position.set(...pos);
    parent.add(g);
    return g;
  }

  /** A cylinder from a to b (frames, bones, poles, reins). */
  rod(
    a: V3,
    b: V3,
    radius: number,
    material: THREE.Material,
    parent: THREE.Object3D = this.group,
    segments = 6,
  ) {
    const va = new THREE.Vector3(...a);
    const vb = new THREE.Vector3(...b);
    const len = Math.max(1e-3, va.distanceTo(vb));
    const mesh = this.add(
      new THREE.CylinderGeometry(radius, radius, len, segments),
      material,
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
      parent,
    );
    mesh.quaternion.setFromUnitVectors(UP, vb.sub(va).normalize());
    return mesh;
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats.values()) m.dispose();
    for (const m of this.owned) m.dispose();
  }
}

/**
 * Attitude of a prop from its own motion between animate() calls. The path sampler yields only a
 * heading, and both drivers (dynamics.ts, edits/apply.ts) set position + rotation.y before
 * animate(), so the change since the previous call is the climb (pitch), the turn (bank) and the
 * speed. Smoothed over ~0.3 s; a scrub, a pause or the loop's jump back to the start keeps or
 * eases the attitude instead of snapping it.
 */
class MotionProbe {
  pitch = 0;
  bank = 0;
  speed = 0;
  private last: { x: number; y: number; z: number; yaw: number; t: number } | null = null;

  constructor(
    private readonly o: THREE.Object3D,
    private readonly maxPitch = 0.3,
    private readonly maxBank = 0.35,
  ) {}

  update(time: number) {
    const p = this.o.position;
    const yaw = this.o.rotation.y;
    const last = this.last;
    this.last = { x: p.x, y: p.y, z: p.z, yaw, t: time };
    if (!last) return;
    const dt = time - last.t;
    if (!(dt > 1e-4) || dt > 0.5) return;
    const dh = Math.hypot(p.x - last.x, p.z - last.z);
    const dy = p.y - last.y;
    const v = Math.hypot(dh, dy) / dt;
    if (v > 150) return; // the loop jumped back to the path's start
    const k = 1 - Math.exp(-dt / 0.3);
    const moving = v > 0.05;
    // a mild nose-up / nose-down: 70% of the path's climb angle
    const pitch = moving ? clamp(Math.atan2(dy, dh) * 0.7, -this.maxPitch, this.maxPitch) : 0;
    let dyaw = yaw - last.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    // a coordinated turn leans by atan(v·ω / g); + = into a left turn (heading increasing)
    const bank = moving
      ? clamp(Math.atan((v * (dyaw / dt)) / 9.81), -this.maxBank, this.maxBank)
      : 0;
    this.pitch += (pitch - this.pitch) * k;
    this.bank += (bank - this.bank) * k;
    this.speed += (v - this.speed) * k;
  }
}

// ---- shared rigs ---------------------------------------------------------------------------------

function wheels(
  b: Builder,
  radius: number,
  width: number,
  axles: number[],
  halfTrack: number,
  parent: THREE.Object3D = b.group,
) {
  const tyre = b.mat('#1b1b1b', { roughness: 0.9 });
  const hub = b.mat('#b5b5b5', { metalness: 0.6, roughness: 0.4 });
  const list: THREE.Object3D[] = [];
  for (const z of axles) {
    for (const side of [-1, 1]) {
      const pivot = b.pivot([side * halfTrack, radius, z], parent);
      const t = b.add(
        new THREE.CylinderGeometry(radius, radius, width, 14),
        tyre,
        [0, 0, 0],
        pivot,
      );
      t.rotation.z = Math.PI / 2;
      // an off-axis hub bar makes the wheel rotation visible
      b.add(
        new THREE.BoxGeometry(width * 1.05, radius * 0.9, radius * 0.25),
        hub,
        [0, 0, 0],
        pivot,
      );
      list.push(pivot);
    }
  }
  return (distance: number) => {
    for (const w of list) w.rotation.x = -distance / radius;
  };
}

/** Wooden cart wheels: an iron-shod rim, three crossing spokes (six visible) and a hub. */
function spokedWheels(
  b: Builder,
  radius: number,
  axleZ: number,
  halfTrack: number,
  parent: THREE.Object3D,
) {
  const wood = b.mat('#5b3d22', { roughness: 0.85 });
  const iron = b.mat('#2a2a2a', { metalness: 0.5, roughness: 0.6 });
  const list: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const pivot = b.pivot([side * halfTrack, radius, axleZ], parent);
    const rim = b.add(new THREE.TorusGeometry(radius - 0.03, 0.035, 4, 12), iron, [0, 0, 0], pivot);
    rim.rotation.y = Math.PI / 2;
    for (let i = 0; i < 3; i++) {
      const s = b.add(new THREE.BoxGeometry(0.035, radius * 1.9, 0.04), wood, [0, 0, 0], pivot);
      s.rotation.x = (i * Math.PI) / 3;
    }
    const hub = b.add(new THREE.CylinderGeometry(0.08, 0.08, 0.16, 6), wood, [0, 0, 0], pivot);
    hub.rotation.z = Math.PI / 2;
    list.push(pivot);
  }
  return (distance: number) => {
    for (const w of list) w.rotation.x = -distance / radius;
  };
}

interface LegRig {
  hip: THREE.Group;
  knee: THREE.Group;
  /** Phase offset in cycles (0..1) within the gait. */
  offset: number;
  /** Front knees fold the hoof back, hind hocks fold it forward. */
  front: boolean;
  restHip: number;
  restKnee: number;
}

/** A two-segment leg hanging from `hip` whose foot rests on y = hipY − upper − lower − foot. */
function leg(
  b: Builder,
  parent: THREE.Object3D,
  pos: V3,
  dims: { upper: number; lower: number; r: number; foot: number },
  mats: { coat: THREE.Material; foot: THREE.Material },
  front: boolean,
  offset: number,
): LegRig {
  const hip = b.pivot(pos, parent);
  b.add(
    new THREE.CapsuleGeometry(dims.r, Math.max(0.01, dims.upper - dims.r), 1, 6),
    mats.coat,
    [0, -dims.upper / 2, 0],
    hip,
  );
  const knee = b.pivot([0, -dims.upper, 0], hip);
  b.add(
    new THREE.CapsuleGeometry(dims.r * 0.72, Math.max(0.01, dims.lower - dims.r * 0.72), 1, 5),
    mats.coat,
    [0, -dims.lower / 2, 0],
    knee,
  );
  b.add(
    new THREE.BoxGeometry(dims.r * 1.7, dims.foot, dims.r * 2),
    mats.foot,
    [0, -dims.lower - dims.foot / 2, -dims.r * 0.2],
    knee,
  );
  // hind legs stand with a slight dog-leg (hip back, hock forward), which reads as an animal
  const restHip = front ? 0 : -0.12;
  const restKnee = front ? 0 : 0.24;
  hip.rotation.x = restHip;
  knee.rotation.x = restKnee;
  return { hip, knee, offset, front, restHip, restKnee };
}

interface Gait {
  /** Metres travelled per full leg cycle. */
  stride: number;
  /** Phase offsets in cycles: left fore, right fore, left hind, right hind. */
  offsets: [number, number, number, number];
  swing: number;
  knee: number;
  /** Body rise per cycle (m) and how many rises per cycle (2 for a trot / walk, 1 for a gallop). */
  bob: number;
  bobs: 1 | 2;
  /** Body rocking (rad) of a gallop. */
  rock: number;
}

// Leg amplitudes follow stride / (4 · leg length) so a planted foot barely slides at any speed.
const WALK: Gait = {
  stride: 1.9,
  offsets: [0.25, 0.75, 0, 0.5],
  swing: 0.45,
  knee: 0.7,
  bob: 0.025,
  bobs: 2,
  rock: 0,
};
const GALLOP: Gait = {
  stride: 3.6,
  offsets: [0.5, 0.62, 0, 0.12],
  swing: 0.7,
  knee: 1.1,
  bob: 0.08,
  bobs: 1,
  rock: 0.06,
};
const TROT: Gait = {
  stride: 0.85,
  offsets: [0, 0.5, 0.5, 0],
  swing: 0.5,
  knee: 0.8,
  bob: 0.015,
  bobs: 2,
  rock: 0,
};

/** Poses the legs for `distance` metres travelled; returns the body's rise and rock for it. */
function gaitPose(legs: LegRig[], g: Gait, distance: number, phase = 0) {
  const cyc = distance / g.stride + phase;
  for (const l of legs) {
    const a = TAU * (cyc + l.offset);
    l.hip.rotation.x = l.restHip + g.swing * Math.sin(a);
    // the knee folds while the leg swings forward through the air (cos > 0), not while planted
    const fold = g.knee * Math.max(0, Math.cos(a));
    l.knee.rotation.x = l.restKnee + (l.front ? -fold : fold);
  }
  const c = TAU * cyc;
  return {
    rise: g.bob * (g.bobs === 2 ? (1 - Math.cos(2 * c)) / 2 : (1 - Math.cos(c)) / 2),
    rock: g.rock * Math.sin(c),
  };
}

interface RiderSpec {
  /** Pelvis position in the parent. */
  seat: V3;
  /** Torso tilt forward (rad). */
  lean: number;
  thighForward: number;
  /** Knees apart (rad), to straddle a barrel or a tank. */
  splay: number;
  /** Lower leg relative to the thigh (negative folds the foot back). */
  shin: number;
  /** Arms forward of the vertical (rad), whatever the lean: reins, a handlebar. */
  armForward: number;
  shirt: string;
  pants: string;
  head: 'hat' | 'helmet' | 'bare';
  helmet?: string;
}

/** A simple seated figure (~1.75 m standing) for saddles, motorcycles and coach boxes. */
function seatedRider(b: Builder, parent: THREE.Object3D, s: RiderSpec) {
  const root = b.pivot(s.seat, parent);
  root.name = 'rider';
  const shirt = b.mat(s.shirt);
  const pants = b.mat(s.pants);
  const skin = b.mat('#c99a76');
  const boots = b.mat('#2a1d14', { roughness: 0.6 });
  b.add(new THREE.BoxGeometry(0.3, 0.14, 0.22), pants, [0, 0.04, 0], root);
  const torso = b.pivot([0, 0.08, 0], root);
  torso.rotation.x = -s.lean;
  const chest = b.add(new THREE.CapsuleGeometry(0.15, 0.3, 2, 7), shirt, [0, 0.3, 0], torso);
  chest.scale.set(1.08, 1, 0.75);
  b.add(new THREE.SphereGeometry(0.1, 7, 5), skin, [0, 0.66, 0], torso);
  if (s.head === 'hat') {
    const felt = b.mat('#3a2a1c');
    b.add(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 9), felt, [0, 0.74, 0], torso);
    b.add(new THREE.CylinderGeometry(0.1, 0.11, 0.12, 7), felt, [0, 0.8, 0], torso);
  } else if (s.head === 'helmet') {
    b.add(
      new THREE.SphereGeometry(0.135, 10, 7),
      b.mat(s.helmet ?? '#d8d8d8', { roughness: 0.3, metalness: 0.2 }),
      [0, 0.68, -0.01],
      torso,
    );
    b.add(
      new THREE.BoxGeometry(0.2, 0.07, 0.04),
      b.mat('#111418', { roughness: 0.2 }),
      [0, 0.68, -0.13],
      torso,
    );
  }
  for (const side of [-1, 1]) {
    const arm = b.pivot([side * 0.19, 0.52, 0], torso);
    arm.rotation.x = s.armForward + s.lean;
    arm.rotation.z = side * 0.12;
    b.add(new THREE.CapsuleGeometry(0.045, 0.36, 1, 6), shirt, [0, -0.24, 0], arm);
    const hip = b.pivot([side * 0.11, 0, 0], root);
    hip.rotation.x = s.thighForward;
    hip.rotation.z = side * s.splay;
    b.add(new THREE.CapsuleGeometry(0.07, 0.32, 1, 6), pants, [0, -0.22, 0], hip);
    const knee = b.pivot([0, -0.44, 0], hip);
    knee.rotation.x = s.shin;
    b.add(new THREE.CapsuleGeometry(0.055, 0.3, 1, 6), pants, [0, -0.21, 0], knee);
    b.add(new THREE.BoxGeometry(0.1, 0.08, 0.2), boots, [0, -0.43, -0.04], knee);
  }
  return root;
}

interface HorseRig {
  root: THREE.Group;
  body: THREE.Group;
  animate(distance: number, time: number): void;
}

/**
 * A horse (~1.6 m at the withers, ~2.5 m nose to tail) standing on y = 0 under its belly, facing
 * -Z. Shared by `horse` and the wagon's team. With `harness`, a collar and a pad for the traces.
 */
function horseRig(
  b: Builder,
  parent: THREE.Object3D,
  pos: V3,
  coat: string,
  opts: { gait: Gait; phase?: number; harness?: boolean; rider?: boolean; tailSeed?: number },
): HorseRig {
  const root = b.pivot(pos, parent);
  const body = b.pivot([0, 0, 0], root);
  const coatM = b.mat(coat, { roughness: 0.75 });
  const dark = b.mat(shade(coat, -0.6), { roughness: 0.8 });
  const hoof = b.mat('#1c1712', { roughness: 0.6 });
  const torso = b.add(new THREE.CapsuleGeometry(0.33, 0.75, 2, 7), coatM, [0, 1.24, 0.02], body);
  torso.rotation.x = Math.PI / 2;
  torso.scale.set(0.85, 1, 1);
  b.add(new THREE.BoxGeometry(0.22, 0.12, 0.36), coatM, [0, 1.56, -0.4], body); // withers
  const rump = b.add(new THREE.SphereGeometry(0.33, 7, 5), coatM, [0, 1.3, 0.4], body);
  rump.scale.set(0.88, 1, 1);
  // neck rises forward from the chest; the head hangs ~45° nose-down from its top
  const neck = b.pivot([0, 1.42, -0.6], body);
  neck.rotation.x = -0.65;
  const neckM = b.add(new THREE.CapsuleGeometry(0.15, 0.55, 2, 6), coatM, [0, 0.38, 0], neck);
  neckM.scale.set(0.8, 1, 1.35);
  b.add(new THREE.BoxGeometry(0.05, 0.62, 0.09), dark, [0, 0.42, 0.18], neck); // mane
  const head = b.pivot([0, 0.78, 0], neck);
  head.rotation.x = -0.15;
  b.add(new THREE.BoxGeometry(0.2, 0.24, 0.56), coatM, [0, 0.02, -0.24], head);
  b.add(new THREE.BoxGeometry(0.17, 0.18, 0.2), b.mat(shade(coat, -0.25)), [0, -0.02, -0.55], head); // muzzle
  for (const side of [-1, 1]) {
    const ear = b.add(
      new THREE.ConeGeometry(0.03, 0.12, 4),
      coatM,
      [side * 0.06, 0.17, 0.02],
      head,
    );
    ear.rotation.x = 0.2;
  }
  const tail = b.pivot([0, 1.45, 0.7], body);
  tail.rotation.x = -0.35;
  const tailM = b.add(new THREE.CapsuleGeometry(0.07, 0.55, 2, 5), dark, [0, -0.36, 0], tail);
  tailM.scale.set(0.8, 1, 1.4);
  if (opts.harness) {
    const leather = b.mat('#2a1a10', { roughness: 0.6 });
    const collar = b.add(new THREE.TorusGeometry(0.2, 0.05, 3, 8), leather, [0, 0.12, 0.02], neck);
    collar.rotation.x = Math.PI / 2;
    const girth = b.add(
      new THREE.TorusGeometry(0.33, 0.035, 3, 8),
      leather,
      [0, 1.24, -0.25],
      body,
    );
    girth.scale.x = 0.87; // a band round the barrel the traces hang from
  }
  if (opts.rider) {
    b.add(
      new THREE.BoxGeometry(0.42, 0.08, 0.55),
      b.mat('#4a2c18', { roughness: 0.6 }),
      [0, 1.59, -0.04],
      body,
    );
    b.add(new THREE.BoxGeometry(0.62, 0.03, 0.6), b.mat('#7a2a22'), [0, 1.555, -0.04], body);
    seatedRider(b, body, {
      seat: [0, 1.64, -0.04],
      lean: opts.gait === GALLOP ? 0.45 : 0.15,
      thighForward: 0.45,
      splay: 0.42,
      shin: -0.55,
      armForward: 0.6,
      shirt: '#6b4e3a',
      pants: '#3b3f4a',
      head: 'hat',
    });
  }
  const mats = { coat: coatM, foot: hoof };
  const dims = { upper: 0.46, lower: 0.44, r: 0.075, foot: 0.08 };
  const g = opts.gait;
  const legs = [
    leg(b, body, [0.17, 0.98, -0.45], dims, mats, true, g.offsets[0]),
    leg(b, body, [-0.17, 0.98, -0.45], dims, mats, true, g.offsets[1]),
    leg(b, body, [0.17, 0.98, 0.5], dims, mats, false, g.offsets[2]),
    leg(b, body, [-0.17, 0.98, 0.5], dims, mats, false, g.offsets[3]),
  ];
  const seed = opts.tailSeed ?? 0;
  return {
    root,
    body,
    animate(distance, time) {
      const { rise, rock } = gaitPose(legs, g, distance, opts.phase ?? 0);
      body.position.y = rise;
      body.rotation.x = rock;
      neck.rotation.x = -0.65 + 0.05 * Math.sin(TAU * (distance / g.stride) * 2);
      tail.rotation.z = 0.16 * Math.sin(time * 1.7 + seed);
    },
  };
}

// ---- modern traffic ----------------------------------------------------------------------------

function car(color: string): Prop {
  const b = new Builder();
  const body = b.mat(color, { metalness: 0.3, roughness: 0.45 });
  const glass = b.mat('#1d2a36', { metalness: 0.5, roughness: 0.2 });
  b.add(new THREE.BoxGeometry(1.8, 0.62, 4.3), body, [0, 0.62, 0]);
  b.add(new THREE.BoxGeometry(1.6, 0.52, 2.2), glass, [0, 1.18, 0.25]);
  b.add(new THREE.BoxGeometry(1.62, 0.06, 2.0), body, [0, 1.46, 0.3]);
  const lamp = b.mat('#fff4c2');
  b.add(new THREE.BoxGeometry(0.35, 0.12, 0.05), lamp, [-0.6, 0.7, -2.16]);
  b.add(new THREE.BoxGeometry(0.35, 0.12, 0.05), lamp, [0.6, 0.7, -2.16]);
  const red = b.mat('#a01010');
  b.add(new THREE.BoxGeometry(0.35, 0.12, 0.05), red, [-0.6, 0.72, 2.16]);
  b.add(new THREE.BoxGeometry(0.35, 0.12, 0.05), red, [0.6, 0.72, 2.16]);
  const spin = wheels(b, 0.33, 0.22, [-1.35, 1.35], 0.85);
  return { object: b.group, animate: (d) => spin(d), dispose: () => b.dispose() };
}

function bus(color: string): Prop {
  const b = new Builder();
  const body = b.mat(color, { roughness: 0.5 });
  const glass = b.mat('#1d2a36', { metalness: 0.5, roughness: 0.2 });
  b.add(new THREE.BoxGeometry(2.5, 2.6, 11), body, [0, 1.75, 0]);
  b.add(new THREE.BoxGeometry(2.54, 0.8, 9.6), glass, [0, 2.25, 0.3]);
  b.add(new THREE.BoxGeometry(2.3, 1.1, 0.06), glass, [0, 2.0, -5.51]);
  const spin = wheels(b, 0.5, 0.3, [-3.6, 3.4], 1.15);
  return { object: b.group, animate: (d) => spin(d), dispose: () => b.dispose() };
}

/** Box truck, ~7.3 m × 2.5 m × 3.1 m: cab in the label colour, a lighter box, six wheels. */
function truck(color: string): Prop {
  const b = new Builder();
  const cab = b.mat(color, { metalness: 0.25, roughness: 0.5 });
  const box = b.mat(shade(color, 0.35), { roughness: 0.6 });
  const dark = b.mat('#23262b', { roughness: 0.8 });
  const glass = b.mat('#1d2a36', { metalness: 0.5, roughness: 0.2 });
  b.add(new THREE.BoxGeometry(2.0, 0.28, 6.9), dark, [0, 0.72, 0.1]); // chassis
  b.add(new THREE.BoxGeometry(2.3, 1.95, 1.9), cab, [0, 1.6, -2.55]);
  b.add(new THREE.BoxGeometry(2.24, 0.25, 1.6), cab, [0, 2.7, -2.4]); // roof cap
  b.add(new THREE.BoxGeometry(2.1, 0.75, 0.06), glass, [0, 2.05, -3.51]);
  b.add(new THREE.BoxGeometry(2.34, 0.6, 0.8), glass, [0, 2.1, -2.8]);
  b.add(new THREE.BoxGeometry(2.36, 0.36, 0.2), dark, [0, 0.72, -3.55]); // bumper
  b.add(new THREE.BoxGeometry(1.5, 0.5, 0.05), dark, [0, 1.15, -3.52]); // grille
  const lamp = b.mat('#fff4c2', { emissive: '#fff1b0', emissiveIntensity: 0.6 });
  for (const s of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.32, 0.16, 0.05), lamp, [s * 0.85, 1.1, -3.52]);
    b.add(new THREE.BoxGeometry(0.06, 0.32, 0.18), dark, [s * 1.24, 2.05, -3.2]); // mirrors
  }
  b.add(new THREE.BoxGeometry(2.46, 2.25, 4.9), box, [0, 2.0, 1.0]);
  b.add(new THREE.BoxGeometry(2.48, 0.12, 4.92), cab, [0, 1.0, 1.0]); // stripe at the box foot
  b.add(new THREE.BoxGeometry(0.04, 2.0, 0.02), dark, [0, 2.0, 3.46]); // rear doors' seam
  const red = b.mat('#a01010', { emissive: '#600000', emissiveIntensity: 0.6 });
  for (const s of [-1, 1])
    b.add(new THREE.BoxGeometry(0.2, 0.3, 0.05), red, [s * 1.05, 1.15, 3.46]);
  const spin = wheels(b, 0.5, 0.34, [-2.6, 1.55, 2.65], 1.0);
  return { object: b.group, animate: (d) => spin(d), dispose: () => b.dispose() };
}

/** Motorcycle with a seated rider, ~2 m long; wheels roll, the bike leans into turns. */
function motorcycle(color: string): Prop {
  const b = new Builder();
  const lean = b.pivot([0, 0, 0]);
  lean.name = 'lean';
  const paint = b.mat(color, { metalness: 0.4, roughness: 0.35 });
  const dark = b.mat('#1e1f22', { roughness: 0.7 });
  const chrome = b.mat('#c9ccd1', { metalness: 0.8, roughness: 0.25 });
  const tyre = b.mat('#151515', { roughness: 0.9 });
  const r = 0.31;
  const wheelList: THREE.Group[] = [];
  for (const z of [-0.7, 0.68]) {
    const p = b.pivot([0, r, z], lean);
    const t = b.add(new THREE.TorusGeometry(r - 0.06, 0.06, 6, 16), tyre, [0, 0, 0], p);
    t.rotation.y = Math.PI / 2;
    const disc = b.add(
      new THREE.CylinderGeometry(r - 0.11, r - 0.11, 0.04, 10),
      chrome,
      [0, 0, 0],
      p,
    );
    disc.rotation.z = Math.PI / 2;
    b.add(new THREE.BoxGeometry(0.06, (r - 0.1) * 2, 0.05), dark, [0, 0, 0], p); // a dark spoke shows the spin
    wheelList.push(p);
  }
  b.add(
    new THREE.BoxGeometry(0.3, 0.32, 0.45),
    b.mat('#5b6068', { metalness: 0.6, roughness: 0.4 }),
    [0, 0.47, 0.0],
    lean,
  );
  const tank = b.add(new THREE.CapsuleGeometry(0.14, 0.32, 2, 8), paint, [0, 0.86, -0.2], lean);
  tank.rotation.x = Math.PI / 2 + 0.12;
  tank.scale.set(1.15, 1, 0.9);
  b.add(new THREE.BoxGeometry(0.28, 0.1, 0.55), dark, [0, 0.83, 0.3], lean); // seat
  const fender = b.add(new THREE.BoxGeometry(0.2, 0.06, 0.5), paint, [0, 0.75, 0.75], lean);
  fender.rotation.x = -0.35;
  b.add(new THREE.BoxGeometry(0.16, 0.05, 0.32), paint, [0, 0.66, -0.72], lean); // front fender
  for (const s of [-1, 1]) b.rod([s * 0.08, r, -0.7], [s * 0.08, 0.98, -0.5], 0.025, chrome, lean);
  b.rod([-0.33, 1.03, -0.47], [0.33, 1.03, -0.47], 0.018, dark, lean); // handlebar
  b.rod([0, 0.95, -0.5], [0, 0.5, 0.45], 0.035, dark, lean); // frame
  for (const s of [-1, 1]) b.rod([s * 0.09, 0.45, 0.15], [s * 0.09, r, 0.68], 0.025, dark, lean); // swingarm
  b.rod([0.17, 0.33, 0.05], [0.2, 0.47, 0.85], 0.04, chrome, lean); // exhaust
  const lamp = b.add(
    new THREE.CylinderGeometry(0.09, 0.09, 0.08, 10),
    b.mat('#fff4c2', { emissive: '#fff1b0', emissiveIntensity: 0.8 }),
    [0, 0.93, -0.6],
    lean,
  );
  lamp.rotation.x = Math.PI / 2;
  seatedRider(b, lean, {
    seat: [0, 0.88, 0.26],
    lean: 0.75,
    thighForward: 1.25,
    splay: 0.2,
    shin: -1.55,
    armForward: 0.9,
    shirt: '#2a2c30',
    pants: '#25272b',
    head: 'helmet',
    helmet: shade(color, 0.15),
  });
  const probe = new MotionProbe(b.group, 0, 0.5);
  return {
    object: b.group,
    animate: (d, t) => {
      for (const w of wheelList) w.rotation.x = -d / r;
      probe.update(t);
      lean.rotation.z = probe.bank;
    },
    dispose: () => b.dispose(),
  };
}

function bicycle(color: string): Prop {
  const b = new Builder();
  const frame = b.mat(color, { metalness: 0.4, roughness: 0.4 });
  const tyre = b.mat('#1b1b1b', { roughness: 0.9 });
  const r = 0.34;
  const wheelsList: THREE.Mesh[] = [];
  for (const z of [-0.52, 0.52]) {
    const w = b.add(new THREE.TorusGeometry(r, 0.025, 6, 20), tyre, [0, r, z]);
    w.rotation.y = Math.PI / 2;
    wheelsList.push(w);
  }
  const tube = (len: number, pos: [number, number, number], rx: number) => {
    const m = b.add(new THREE.CylinderGeometry(0.02, 0.02, len, 6), frame, pos);
    m.rotation.x = rx;
  };
  tube(1.0, [0, 0.62, 0], Math.PI / 2);
  tube(0.6, [0, 0.62, 0.25], -0.3);
  tube(0.65, [0, 0.62, -0.42], 0.35);
  // rider
  const shirt = b.mat('#3f6e9e');
  const skin = b.mat('#c99a76');
  const torso = b.add(new THREE.CapsuleGeometry(0.17, 0.45, 3, 8), shirt, [0, 1.25, 0.05]);
  torso.rotation.x = -0.35;
  b.add(new THREE.SphereGeometry(0.11, 10, 8), skin, [0, 1.65, -0.12]);
  const legs = b.mat('#2b2f3a');
  const legL = b.add(new THREE.CapsuleGeometry(0.06, 0.55, 3, 6), legs, [-0.12, 0.7, 0.05]);
  const legR = b.add(new THREE.CapsuleGeometry(0.06, 0.55, 3, 6), legs, [0.12, 0.7, 0.05]);
  return {
    object: b.group,
    animate: (d) => {
      for (const w of wheelsList) w.rotation.x = -d / r;
      const crank = d / 0.9;
      legL.rotation.x = Math.sin(crank) * 0.5;
      legR.rotation.x = -Math.sin(crank) * 0.5;
    },
    dispose: () => b.dispose(),
  };
}

function pedestrian(color: string): Prop {
  const b = new Builder();
  const shirt = b.mat(color);
  const skin = b.mat('#c99a76');
  const legsMat = b.mat('#2b2f3a');
  const torso = b.add(new THREE.CapsuleGeometry(0.2, 0.55, 3, 10), shirt, [0, 1.2, 0]);
  const head = b.add(new THREE.SphereGeometry(0.12, 12, 10), skin, [0, 1.68, 0]);
  const leg = (x: number) => {
    const pivot = b.pivot([x, 0.85, 0]);
    b.add(new THREE.CapsuleGeometry(0.07, 0.65, 3, 6), legsMat, [0, -0.4, 0], pivot);
    return pivot;
  };
  const l = leg(-0.1);
  const r = leg(0.1);
  return {
    object: b.group,
    animate: (d) => {
      const s = d / 0.7;
      l.rotation.x = Math.sin(s * Math.PI) * 0.5;
      r.rotation.x = -Math.sin(s * Math.PI) * 0.5;
      const bob = Math.abs(Math.sin(s * Math.PI)) * 0.03;
      torso.position.y = 1.2 + bob;
      head.position.y = 1.68 + bob;
    },
    dispose: () => b.dispose(),
  };
}

// ---- any era -------------------------------------------------------------------------------------

function bird(color: string): Prop {
  const b = new Builder();
  const m = b.mat(color);
  const body = b.add(new THREE.SphereGeometry(0.12, 8, 6), m, [0, 0, 0]);
  body.scale.set(0.8, 0.7, 1.6);
  b.add(new THREE.SphereGeometry(0.07, 8, 6), m, [0, 0.06, -0.18]);
  const beak = b.add(new THREE.ConeGeometry(0.025, 0.08, 6), b.mat('#e0a030'), [0, 0.05, -0.27]);
  beak.rotation.x = -Math.PI / 2;
  const wing = () => {
    const pivot = b.pivot([0, 0, 0]);
    b.add(new THREE.BoxGeometry(0.34, 0.015, 0.14), m, [0.17, 0, 0], pivot);
    return pivot;
  };
  const l = wing();
  const r = wing();
  r.scale.x = -1;
  return {
    object: b.group,
    animate: (_d, t) => {
      const flap = Math.sin(t * 18) * 0.7;
      // the mirrored pivot's own rotation acts after its mirror, so it takes the opposite sign
      // for both tips to rise together
      l.rotation.z = flap;
      r.rotation.z = -flap;
    },
    dispose: () => b.dispose(),
  };
}

/** Dog, ~0.6 m at the shoulder and ~1.1 m nose to tail; trots with distance, wags with time. */
function dog(color: string): Prop {
  const b = new Builder();
  const body = b.pivot([0, 0, 0]);
  const coat = b.mat(color, { roughness: 0.85 });
  const dark = b.mat(shade(color, -0.5), { roughness: 0.8 });
  const torso = b.add(new THREE.CapsuleGeometry(0.13, 0.36, 2, 8), coat, [0, 0.5, 0], body);
  torso.rotation.x = Math.PI / 2;
  torso.scale.set(0.9, 1, 1);
  b.add(new THREE.SphereGeometry(0.15, 8, 6), coat, [0, 0.52, -0.2], body); // chest
  const neck = b.pivot([0, 0.56, -0.27], body);
  neck.rotation.x = -0.6;
  b.add(new THREE.CapsuleGeometry(0.07, 0.14, 2, 6), coat, [0, 0.1, 0], neck);
  const head = b.pivot([0, 0.2, 0], neck);
  head.rotation.x = 0.6;
  b.add(new THREE.BoxGeometry(0.15, 0.15, 0.2), coat, [0, 0.03, -0.04], head);
  b.add(new THREE.BoxGeometry(0.09, 0.08, 0.13), coat, [0, -0.01, -0.19], head); // snout
  b.add(new THREE.BoxGeometry(0.04, 0.035, 0.03), b.mat('#111111'), [0, 0.02, -0.26], head); // nose
  for (const s of [-1, 1]) {
    const ear = b.add(new THREE.ConeGeometry(0.035, 0.09, 4), dark, [s * 0.05, 0.13, 0.02], head);
    ear.rotation.z = -s * 0.2;
  }
  const tail = b.pivot([0, 0.58, 0.3], body);
  tail.rotation.x = 0.9;
  b.add(new THREE.CapsuleGeometry(0.025, 0.2, 1, 5), coat, [0, 0.12, 0], tail);
  const mats = { coat, foot: dark };
  const dims = { upper: 0.2, lower: 0.19, r: 0.035, foot: 0.04 };
  const g = TROT;
  const legs = [
    leg(b, body, [0.085, 0.43, -0.24], dims, mats, true, g.offsets[0]),
    leg(b, body, [-0.085, 0.43, -0.24], dims, mats, true, g.offsets[1]),
    leg(b, body, [0.085, 0.43, 0.24], dims, mats, false, g.offsets[2]),
    leg(b, body, [-0.085, 0.43, 0.24], dims, mats, false, g.offsets[3]),
  ];
  return {
    object: b.group,
    animate: (d, t) => {
      body.position.y = gaitPose(legs, g, d).rise;
      tail.rotation.z = Math.sin(t * 11) * 0.5;
    },
    dispose: () => b.dispose(),
  };
}

/** Horse, ~1.6 m at the withers; ridden when the label says so; gallops when it says that. */
function horse(color: string, label: string): Prop {
  const b = new Builder();
  const gait = GALLOP_RE.test(label) ? GALLOP : WALK;
  const rig = horseRig(b, b.group, [0, 0, 0], color, { gait, rider: RIDER_RE.test(label) });
  return { object: b.group, animate: (d, t) => rig.animate(d, t), dispose: () => b.dispose() };
}

/**
 * Two horses in harness pulling a cart, ~6 m overall: a closed coach with windows for
 * "stagecoach / coach / carriage", a canvas-covered bed for "covered / canvas", else an open bed.
 * The cart takes the label colour; the team takes a colour named before "horses", else bays.
 */
function wagon(_color: string, label: string): Prop {
  const b = new Builder();
  const team = horseColor(label);
  // the cart's colour is the first colour word that is not the horses'
  const cartColor = propColor(
    label.replace(/\b[a-z]+\s+(horses?|mares?|stallions?|team|ponies|pony)\b/gi, ''),
    DEFAULT_COLOR.wagon,
  );
  const gait = GALLOP_RE.test(label) ? GALLOP : WALK;
  const horses = [
    horseRig(b, b.group, [0.55, 0, -1.95], team ?? '#6b4428', { gait, harness: true, tailSeed: 0 }),
    horseRig(b, b.group, [-0.55, 0, -1.95], team ?? '#5a3a22', {
      gait,
      harness: true,
      phase: 0.08,
      tailSeed: 1.3,
    }),
  ];
  const wood = b.mat(cartColor, { roughness: 0.75 });
  const trim = b.mat(shade(cartColor, -0.45), { roughness: 0.7 });
  const leather = b.mat('#2a1a10', { roughness: 0.6 });
  // pole between the horses, a crossbar, and the traces from the collars back to it
  b.rod([0, 0.95, -0.35], [0, 1.15, -2.6], 0.045, trim);
  b.rod([-0.85, 0.95, -0.55], [0.85, 0.95, -0.55], 0.04, trim);
  for (const x of [0.55, -0.55]) {
    for (const s of [-1, 1])
      b.rod([x + s * 0.3, 1.3, -2.1], [x + s * 0.3, 0.97, -0.55], 0.015, leather);
  }
  b.add(new THREE.BoxGeometry(0.9, 0.14, 3.0), trim, [0, 0.82, 1.15]); // undercarriage
  const spinFront = spokedWheels(b, 0.45, -0.05, 0.82, b.group);
  const spinBack = spokedWheels(b, 0.65, 2.15, 0.85, b.group);
  let seat: V3;
  if (COACH_RE.test(label)) {
    // closed coach: cabin with two windows a side, roof rail with luggage, the driver's box in front
    b.add(new THREE.BoxGeometry(1.5, 1.45, 2.0), wood, [0, 1.75, 1.3]);
    const glass = b.mat('#1b2229', { metalness: 0.4, roughness: 0.25 });
    for (const z of [0.85, 1.75])
      b.add(new THREE.BoxGeometry(1.54, 0.48, 0.55), glass, [0, 1.95, z]);
    b.add(new THREE.BoxGeometry(1.56, 0.1, 2.08), trim, [0, 1.06, 1.3]);
    b.add(new THREE.BoxGeometry(1.62, 0.08, 2.15), trim, [0, 2.52, 1.3]); // roof
    b.add(
      new THREE.BoxGeometry(1.2, 0.3, 1.1),
      b.mat('#4a3324', { roughness: 0.8 }),
      [0, 2.71, 1.5],
    ); // luggage
    b.add(new THREE.BoxGeometry(1.3, 0.12, 0.5), trim, [0, 2.05, 0.05]); // driver's seat
    b.add(new THREE.BoxGeometry(1.3, 0.75, 0.08), wood, [0, 1.6, 0.28]); // box front
    b.rod([0, 1.4, -0.45], [0, 1.85, 0.05], 0.03, trim); // footboard strut
    b.add(new THREE.BoxGeometry(1.2, 0.05, 0.4), trim, [0, 1.42, -0.32]); // footboard
    seat = [0, 2.13, 0.05];
  } else {
    // a flat bed with sides on the axles, a bench at the front
    b.add(new THREE.BoxGeometry(1.45, 0.12, 2.9), wood, [0, 1.0, 1.15]);
    for (const s of [-1, 1])
      b.add(new THREE.BoxGeometry(0.06, 0.42, 2.9), wood, [s * 0.72, 1.27, 1.15]);
    b.add(new THREE.BoxGeometry(1.45, 0.42, 0.06), wood, [0, 1.27, 2.58]);
    b.add(new THREE.BoxGeometry(1.45, 0.6, 0.06), wood, [0, 1.36, -0.26]);
    b.add(new THREE.BoxGeometry(1.3, 0.1, 0.4), trim, [0, 1.5, 0.0]); // bench
    seat = [0, 1.58, 0.0];
    if (COVERED_RE.test(label)) {
      // canvas over hoops: an open half-cylinder along the bed
      const canvas = b.mat('#e6dcc3', { roughness: 0.95, doubleSided: true });
      const c = b.add(
        new THREE.CylinderGeometry(0.76, 0.76, 2.6, 10, 1, true, Math.PI / 2, Math.PI),
        canvas,
        [0, 1.48, 1.35],
      );
      c.rotation.x = Math.PI / 2;
      // the end hoops (a half torus stands in the XY plane, arching over the bed)
      for (const z of [0.1, 2.6])
        b.add(new THREE.TorusGeometry(0.76, 0.03, 3, 8, Math.PI), trim, [0, 1.48, z]);
    } else {
      // open bed: a load of crates and a barrel
      const crate = b.mat('#9a7a4e', { roughness: 0.9 });
      b.add(new THREE.BoxGeometry(0.55, 0.45, 0.6), crate, [0.3, 1.28, 1.6]);
      b.add(new THREE.BoxGeometry(0.5, 0.4, 0.5), crate, [-0.3, 1.26, 2.1]);
      b.add(new THREE.CylinderGeometry(0.24, 0.24, 0.6, 8), crate, [-0.3, 1.36, 1.25]);
    }
  }
  const driver = seatedRider(b, b.group, {
    seat,
    lean: 0.1,
    thighForward: 1.45,
    splay: 0.12,
    shin: -1.35,
    armForward: 0.75,
    shirt: '#5a5f3a',
    pants: '#3b3226',
    head: 'hat',
  });
  driver.name = 'driver';
  // reins from the driver's hands to the horses' heads
  for (const x of [0.55, -0.55])
    b.rod([x * 0.25, seat[1] + 0.35, seat[2] - 0.4], [x, 1.85, -2.9], 0.008, leather, b.group, 3);
  return {
    object: b.group,
    animate: (d, t) => {
      for (const h of horses) h.animate(d, t);
      spinFront(d);
      spinBack(d);
    },
    dispose: () => b.dispose(),
  };
}

/** Hull outline seen from above, bow at -Z: the shape's +y maps to -Z after the extrusion turn. */
function hullShape(halfBeam: number, bow: number, stern: number) {
  const s = new THREE.Shape();
  s.moveTo(0, bow);
  s.quadraticCurveTo(halfBeam, bow * 0.55, halfBeam, 0);
  s.lineTo(halfBeam * 0.9, -stern);
  s.lineTo(-halfBeam * 0.9, -stern);
  s.lineTo(-halfBeam, 0);
  s.quadraticCurveTo(-halfBeam, bow * 0.55, 0, bow);
  return s;
}

/**
 * Boat, ~5 m: its origin is the waterline (0.4 m of hull below it). A cabin and a short mast, or
 * a mast with a mainsail and a jib when the label sails. Bobs, rolls and pitches with time.
 */
function boat(color: string, label: string): Prop {
  const b = new Builder();
  const rock = b.pivot([0, 0, 0]);
  rock.name = 'rock';
  const hullM = b.mat(color, { roughness: 0.55 });
  const deck = b.mat('#b08d5f', { roughness: 0.8 });
  const white = b.mat('#eeeeea', { roughness: 0.5 });
  const dark = b.mat('#1d2a36', { metalness: 0.4, roughness: 0.25 });
  const hullGeo = new THREE.ExtrudeGeometry(hullShape(0.95, 2.55, 2.3), {
    depth: 0.95,
    bevelEnabled: false,
    curveSegments: 5,
  });
  hullGeo.rotateX(-Math.PI / 2);
  b.add(hullGeo, [deck, hullM], [0, -0.4, 0], rock);
  const rail = new THREE.ExtrudeGeometry(hullShape(0.98, 2.62, 2.33), {
    depth: 0.08,
    bevelEnabled: false,
    curveSegments: 5,
  });
  rail.rotateX(-Math.PI / 2);
  b.add(rail, white, [0, 0.42, 0], rock); // gunwale stripe
  const sail = SAIL_RE.test(label);
  if (sail) {
    b.add(new THREE.BoxGeometry(0.9, 0.35, 1.3), white, [0, 0.72, 0.9], rock); // low cabin
    b.rod([0, 0.55, -0.5], [0, 6.0, -0.5], 0.06, white, rock);
    b.rod([0, 1.3, -0.5], [0, 1.3, 1.95], 0.04, white, rock); // boom
    const canvas = b.mat('#f2ecdc', { roughness: 0.9, doubleSided: true });
    const main = new THREE.Shape([
      new THREE.Vector2(-0.45, 1.4),
      new THREE.Vector2(-0.45, 5.85),
      new THREE.Vector2(1.9, 1.4),
    ]);
    const mg = new THREE.ShapeGeometry(main);
    mg.rotateY(-Math.PI / 2); // shape x → scene z: the sail stands in the boat's centre plane
    b.add(mg, canvas, [0, 0, 0], rock);
    const jib = new THREE.Shape([
      new THREE.Vector2(-0.6, 5.4),
      new THREE.Vector2(-2.35, 0.75),
      new THREE.Vector2(-0.6, 0.95),
    ]);
    const jg = new THREE.ShapeGeometry(jib);
    jg.rotateY(-Math.PI / 2);
    b.add(jg, canvas, [0, 0, 0], rock);
  } else {
    b.add(new THREE.BoxGeometry(1.2, 0.85, 1.5), white, [0, 0.97, 0.55], rock);
    b.add(new THREE.BoxGeometry(1.24, 0.25, 1.3), dark, [0, 1.12, 0.52], rock); // windows
    b.add(new THREE.BoxGeometry(1.35, 0.06, 1.7), white, [0, 1.43, 0.55], rock); // roof
    b.rod([0, 1.45, 0.75], [0, 2.25, 0.75], 0.03, white, rock); // radar mast
    b.add(new THREE.BoxGeometry(0.5, 0.04, 0.08), dark, [0, 2.2, 0.75], rock);
    b.add(
      new THREE.SphereGeometry(0.05, 6, 4),
      b.mat('#ffe9a8', { emissive: '#ffd36b', emissiveIntensity: 1.2 }),
      [0, 2.3, 0.75],
      rock,
    );
  }
  return {
    object: b.group,
    animate: (_d, t) => {
      rock.position.y = 0.05 * Math.sin(t * 1.4) + 0.03 * Math.sin(t * 2.3 + 1);
      rock.rotation.z = 0.045 * Math.sin(t * 1.1 + 0.5);
      rock.rotation.x = 0.025 * Math.sin(t * 0.9 + 2);
    },
    dispose: () => b.dispose(),
  };
}

// ---- fantasy / science fiction -----------------------------------------------------------------

/** A flat polygon in the XZ plane (wing membranes): points are [x, z]. */
function flatPolygon(points: [number, number][]) {
  const geo = new THREE.ShapeGeometry(
    new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z))),
  );
  geo.rotateX(Math.PI / 2); // shape y → scene z
  return geo;
}

/**
 * Dragon, ~10 m nose to tail with an ~11 m wingspan. Its origin is under its feet, so it flies
 * with its claws at the path's height and stands on a path at y = 0. Wings flap with time, the
 * body bobs with each downstroke, the tail sways; it pitches mildly with the path's climb.
 */
function dragon(color: string): Prop {
  const b = new Builder();
  const pitch = b.pivot([0, 2.0, 0]); // the body centre: pitch and bob happen about it
  pitch.name = 'attitude';
  const scales = b.mat(color, { roughness: 0.6 });
  const belly = b.mat(shade(color, 0.3), { roughness: 0.7 });
  const membrane = b.mat(shade(color, -0.35), { roughness: 0.8, doubleSided: true });
  const horn = b.mat('#d9cfb4', { roughness: 0.5 });
  const torso = b.add(new THREE.CapsuleGeometry(0.8, 2.0, 3, 9), scales, [0, 0, 0], pitch);
  torso.rotation.x = Math.PI / 2;
  torso.scale.set(0.95, 1, 0.85);
  const under = b.add(new THREE.CapsuleGeometry(0.62, 1.8, 2, 8), belly, [0, -0.22, 0], pitch);
  under.rotation.x = Math.PI / 2;
  under.scale.set(0.9, 1, 0.8);
  for (let i = 0; i < 5; i++) {
    const spike = b.add(
      new THREE.ConeGeometry(0.12, 0.42, 4),
      horn,
      [0, 0.72, -1.2 + i * 0.6],
      pitch,
    );
    spike.rotation.x = 0.5;
  }
  // neck: three segments reaching forward and a little up, then the head held level
  const tilts = [-1.25, 0.2, 0.25];
  const radii = [0.45, 0.38, 0.32];
  let joint: THREE.Object3D = b.pivot([0, 0.35, -1.55], pitch);
  joint.rotation.x = tilts[0]!;
  for (let i = 0; i < 3; i++) {
    b.add(new THREE.CapsuleGeometry(radii[i]!, 0.55, 2, 7), scales, [0, 0.42, 0], joint);
    const next = b.pivot([0, 0.84, 0], joint);
    next.rotation.x = i < 2 ? tilts[i + 1]! : 0.65;
    joint = next;
  }
  const head = joint;
  b.add(new THREE.BoxGeometry(0.62, 0.5, 0.95), scales, [0, 0.12, -0.4], head);
  b.add(new THREE.BoxGeometry(0.42, 0.3, 0.7), scales, [0, 0.02, -1.15], head); // snout
  const jaw = b.add(new THREE.BoxGeometry(0.38, 0.12, 0.85), belly, [0, -0.2, -0.95], head);
  jaw.rotation.x = 0.12;
  for (const s of [-1, 1]) {
    const h = b.add(new THREE.ConeGeometry(0.09, 0.75, 5), horn, [s * 0.2, 0.42, -0.1], head);
    h.rotation.x = 1.1;
    h.rotation.z = -s * 0.25;
    b.add(
      new THREE.SphereGeometry(0.06, 6, 4),
      b.mat('#ffb21a', { emissive: '#ff9a00', emissiveIntensity: 1.5 }),
      [s * 0.26, 0.24, -0.72],
      head,
    );
  }
  // tail: tapering cones swaying sideways in a travelling wave, a spade at the tip
  const tail: THREE.Group[] = [];
  let tj: THREE.Object3D = pitch;
  let tpos: V3 = [0, 0.05, 1.55];
  const tl = [0.85, 0.8, 0.75, 0.7, 0.65];
  for (let i = 0; i < tl.length; i++) {
    const p = b.pivot(tpos, tj);
    p.rotation.x = i === 0 ? 0.12 : -0.03; // droops from the hips, then curls up a little
    const r0 = 0.5 - i * 0.09;
    const seg = b.add(
      new THREE.CylinderGeometry(r0 - 0.09, r0, tl[i]!, 7),
      scales,
      [0, 0, tl[i]! / 2],
      p,
    );
    seg.rotation.x = Math.PI / 2;
    tail.push(p);
    tj = p;
    tpos = [0, 0, tl[i]!];
  }
  const spade = b.add(
    new THREE.ConeGeometry(0.3, 0.6, 4),
    membrane,
    [0, 0, 0.3],
    b.pivot(tpos, tj),
  );
  spade.rotation.x = Math.PI / 2;
  spade.scale.set(1, 1, 0.25);
  // hind legs trail back under the belly; small forelegs under the chest
  for (const s of [-1, 1]) {
    const hip = b.pivot([s * 0.55, -0.35, 0.95], pitch);
    hip.rotation.x = -0.35;
    b.add(new THREE.CapsuleGeometry(0.24, 0.6, 2, 6), scales, [0, -0.45, 0], hip);
    const knee = b.pivot([0, -0.95, 0], hip);
    knee.rotation.x = 0.75;
    b.add(new THREE.CapsuleGeometry(0.14, 0.55, 1, 6), scales, [0, -0.38, 0], knee);
    b.add(new THREE.BoxGeometry(0.3, 0.12, 0.42), horn, [0, -0.8, -0.1], knee); // claws
    const arm = b.pivot([s * 0.5, -0.4, -1.1], pitch);
    arm.rotation.x = 0.5;
    b.add(new THREE.CapsuleGeometry(0.11, 0.5, 1, 5), scales, [0, -0.35, 0], arm);
  }
  // wings: an arm with the inner membrane on the shoulder, the outer membrane on the elbow
  const wing = (side: 1 | -1) => {
    const shoulder = b.pivot([side * 0.55, 0.6, -0.65], pitch);
    shoulder.scale.x = side; // the right wing is the left one mirrored
    b.rod([0, 0, 0], [2.4, 0.15, -0.35], 0.12, scales, shoulder, 5);
    b.add(
      flatPolygon([
        [0, -0.15],
        [2.4, -0.35],
        [2.4, 1.3],
        [1.45, 1.5],
        [0.2, 2.15],
      ]),
      membrane,
      [0, 0, 0],
      shoulder,
    );
    const elbow = b.pivot([2.4, 0.15, -0.35], shoulder);
    b.rod([0, 0, 0], [2.85, 0.1, 0.25], 0.08, scales, elbow, 5);
    b.rod([0, 0, 0], [2.0, 0, 1.25], 0.05, scales, elbow, 4);
    b.add(
      flatPolygon([
        [0, 0],
        [2.85, 0.25],
        [2.0, 1.25],
        [1.1, 1.25],
        [0, 1.65],
      ]),
      membrane,
      [0, -0.15, 0],
      elbow,
    );
    b.add(new THREE.ConeGeometry(0.07, 0.35, 4), horn, [2.95, 0.1, 0.28], elbow); // wing claw
    return { shoulder, elbow, side };
  };
  const wings = [wing(1), wing(-1)];
  const probe = new MotionProbe(b.group, 0.3, 0.4);
  const omega = TAU * 0.55;
  return {
    object: b.group,
    animate: (_d, t) => {
      const beat = Math.sin(t * omega);
      for (const w of wings) {
        // the mirrored shoulder turns the opposite way so both wings beat together
        w.shoulder.rotation.z = w.side * (0.2 + 0.6 * beat);
        w.elbow.rotation.z = -0.1 + 0.35 * Math.sin(t * omega - 0.8);
      }
      probe.update(t);
      // the body rises on each downstroke
      pitch.position.y = 2.0 + 0.18 * (1 - Math.sin(t * omega)) * 0.5;
      pitch.rotation.x = probe.pitch;
      pitch.rotation.z = probe.bank;
      tail.forEach((p, i) => {
        p.rotation.y = 0.1 * Math.sin(t * 1.6 - i * 0.7);
      });
      head.rotation.x = 0.65 - probe.pitch * 0.5; // the head stays nearer the horizon than the body
    },
    dispose: () => b.dispose(),
  };
}

/** Quadcopter, ~0.55 m across; its origin is under the skids. Rotors spin, it hovers and tilts. */
function drone(color: string): Prop {
  const b = new Builder();
  const hover = b.pivot([0, 0, 0]);
  hover.name = 'attitude';
  const shell = b.mat(color, { metalness: 0.4, roughness: 0.4 });
  const dark = b.mat('#1b1d21', { roughness: 0.6 });
  b.add(new THREE.BoxGeometry(0.16, 0.07, 0.22), shell, [0, 0.11, 0], hover);
  b.add(new THREE.BoxGeometry(0.11, 0.03, 0.14), dark, [0, 0.16, 0.01], hover);
  for (const s of [-1, 1]) {
    b.rod([s * 0.06, 0.075, -0.06], [s * 0.08, 0.01, -0.08], 0.006, dark, hover, 4);
    b.rod([s * 0.06, 0.075, 0.06], [s * 0.08, 0.01, 0.08], 0.006, dark, hover, 4);
    b.rod([s * 0.08, 0.008, -0.13], [s * 0.08, 0.008, 0.13], 0.008, dark, hover, 4); // skid
  }
  b.add(new THREE.SphereGeometry(0.03, 6, 4), dark, [0, 0.07, -0.1], hover); // camera
  const disc = b.mat('#b8bec8', { opacity: 0.28, roughness: 0.4 });
  const rotors: THREE.Group[] = [];
  const motors: V3[] = [
    [0.17, 0.13, -0.17],
    [-0.17, 0.13, -0.17],
    [0.17, 0.13, 0.17],
    [-0.17, 0.13, 0.17],
  ];
  for (const [x, y, z] of motors) {
    b.rod([0, 0.12, 0], [x, y, z], 0.012, dark, hover, 4);
    b.add(new THREE.CylinderGeometry(0.022, 0.022, 0.04, 8), shell, [x, y + 0.01, z], hover);
    const rotor = b.pivot([x, y + 0.035, z], hover);
    b.add(new THREE.CylinderGeometry(0.1, 0.1, 0.004, 14), disc, [0, 0, 0], rotor);
    b.add(new THREE.BoxGeometry(0.2, 0.006, 0.02), dark, [0, 0.003, 0], rotor);
    rotors.push(rotor);
  }
  // navigation lights read at a distance where the body does not
  b.add(
    new THREE.BoxGeometry(0.03, 0.02, 0.01),
    b.mat('#9dffb0', { emissive: '#3dff6a', emissiveIntensity: 1.6 }),
    [0, 0.11, -0.115],
    hover,
  );
  b.add(
    new THREE.BoxGeometry(0.03, 0.02, 0.01),
    b.mat('#ff9d9d', { emissive: '#ff2a2a', emissiveIntensity: 1.6 }),
    [0, 0.11, 0.115],
    hover,
  );
  const probe = new MotionProbe(b.group, 0.2, 0.25);
  return {
    object: b.group,
    animate: (_d, t) => {
      rotors.forEach((r, i) => {
        r.rotation.y = (i === 0 || i === 3 ? 1 : -1) * t * 70;
      });
      probe.update(t);
      hover.position.y = 0.02 + 0.02 * Math.sin(t * 2.1);
      // a quadcopter noses down to fly forward and rolls into turns
      hover.rotation.x = -clamp(probe.speed * 0.04, 0, 0.3) + probe.pitch;
      hover.rotation.z = 0.03 * Math.sin(t * 1.3) + probe.bank;
    },
    dispose: () => b.dispose(),
  };
}

/**
 * Spacecraft, ~8.5 m long, ~9 m across the wings; its origin is under the hull. Two engines with
 * a pulsing emissive glow and an additive plume; it hovers gently, banks and pitches with its path.
 */
function spacecraft(color: string): Prop {
  const b = new Builder();
  const attitude = b.pivot([0, 0.6, 0]);
  attitude.name = 'attitude';
  const hull = b.mat(color, { metalness: 0.55, roughness: 0.35 });
  const panel = b.mat(shade(color, -0.35), { metalness: 0.5, roughness: 0.45 });
  const dark = b.mat('#25282e', { metalness: 0.6, roughness: 0.5 });
  const accent = b.mat('#d0482c', { roughness: 0.5 });
  // a six-sided hull (faceted plating rather than an airliner's tube)
  const main = b.add(new THREE.CylinderGeometry(0.75, 1.0, 5.2, 6), hull, [0, 0, 0.4], attitude);
  main.rotation.x = -Math.PI / 2; // cylinder top → -Z (forward)
  main.scale.set(1, 1, 0.6); // geometry z becomes height after the turn: a flattened hull
  const nose = b.add(new THREE.ConeGeometry(0.75, 2.2, 6), hull, [0, 0, -3.3], attitude);
  nose.rotation.x = -Math.PI / 2;
  nose.scale.set(1, 1, 0.6);
  const canopy = b.add(
    new THREE.SphereGeometry(0.55, 10, 5, 0, TAU, 0, Math.PI / 2),
    b.mat('#18324a', {
      metalness: 0.6,
      roughness: 0.15,
      emissive: '#2a6c9a',
      emissiveIntensity: 0.25,
    }),
    [0, 0.3, -1.5],
    attitude,
  );
  canopy.scale.set(0.8, 0.6, 1.7);
  b.add(new THREE.BoxGeometry(2.0, 0.85, 0.7), dark, [0, 0, 2.95], attitude); // engine block
  b.add(new THREE.BoxGeometry(0.5, 0.12, 2.2), panel, [0, 0.62, 0.9], attitude); // spine
  const wingGeo = new THREE.ExtrudeGeometry(
    new THREE.Shape([
      new THREE.Vector2(0.7, -0.6),
      new THREE.Vector2(4.4, 1.7),
      new THREE.Vector2(4.4, 2.5),
      new THREE.Vector2(0.7, 2.85),
    ]),
    { depth: 0.12, bevelEnabled: false },
  );
  wingGeo.rotateX(Math.PI / 2); // shape y → scene z; the extrusion becomes the wing's thickness
  for (const s of [-1, 1]) {
    const w = b.add(wingGeo, panel, [0, 0.0, 0], attitude);
    w.scale.x = s;
    b.add(new THREE.BoxGeometry(0.12, 0.16, 0.85), accent, [s * 4.4, -0.06, 2.1], attitude); // wingtip
    const fin = new THREE.ShapeGeometry(
      new THREE.Shape([
        new THREE.Vector2(1.6, 0),
        new THREE.Vector2(3.0, 0),
        new THREE.Vector2(3.2, 1.3),
        new THREE.Vector2(2.6, 1.3),
      ]),
    );
    fin.rotateY(-Math.PI / 2); // shape x → scene z
    const f = b.add(
      fin,
      b.mat(shade(color, -0.35), { metalness: 0.5, roughness: 0.45, doubleSided: true }),
      [s * 0.45, 0.35, 0],
      attitude,
    );
    f.rotation.z = -s * 0.35;
  }
  const glowMat = b.own(
    new THREE.MeshStandardMaterial({
      color: '#bff3ff',
      emissive: '#5fd8ff',
      emissiveIntensity: 2,
      roughness: 0.3,
    }),
  );
  const plumeMat = b.own(
    new THREE.MeshBasicMaterial({
      color: '#6fd3ff',
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const plumes: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const nozzle = b.add(
      new THREE.CylinderGeometry(0.3, 0.38, 0.55, 10, 1, true),
      dark,
      [s * 0.55, 0, 3.5],
      attitude,
    );
    nozzle.rotation.x = Math.PI / 2;
    b.add(new THREE.CircleGeometry(0.29, 12), glowMat, [s * 0.55, 0, 3.45], attitude); // faces +Z, out of the nozzle
    const plume = b.add(
      new THREE.ConeGeometry(0.28, 1.6, 10, 1, true),
      plumeMat,
      [s * 0.55, 0, 4.4],
      attitude,
    );
    plume.rotation.x = Math.PI / 2; // tip → +Z, trailing behind
    plumes.push(plume);
  }
  // running lights along the flanks pulse with the engines
  for (const s of [-1, 1])
    b.add(new THREE.BoxGeometry(0.05, 0.06, 3.4), glowMat, [s * 0.86, 0, 0.5], attitude);
  const probe = new MotionProbe(b.group, 0.3, 0.55);
  return {
    object: b.group,
    animate: (_d, t) => {
      const pulse = 0.75 + 0.18 * Math.sin(t * 9) + 0.07 * Math.sin(t * 23);
      glowMat.emissiveIntensity = 1.4 + 1.2 * pulse;
      plumeMat.opacity = 0.35 + 0.35 * pulse;
      for (const p of plumes) {
        p.scale.y = 0.8 + 0.45 * pulse;
        p.position.z = 3.6 + 0.8 * p.scale.y;
      }
      probe.update(t);
      attitude.position.y = 0.6 + 0.12 * (1 + Math.sin(t * 1.1)) * 0.5;
      attitude.rotation.x = probe.pitch;
      attitude.rotation.z = probe.bank;
    },
    dispose: () => b.dispose(),
  };
}

function generic(color: string): Prop {
  const b = new Builder();
  const m = b.mat(color);
  b.add(new THREE.BoxGeometry(1, 1, 1), m, [0, 0.5, 0]);
  const nose = b.add(new THREE.ConeGeometry(0.25, 0.5, 8), b.mat('#f2f2f2'), [0, 0.5, -0.75]);
  nose.rotation.x = -Math.PI / 2;
  return { object: b.group, animate: () => {}, dispose: () => b.dispose() };
}

export const DEFAULT_COLOR: Record<DynamicElement['kind'], string> = {
  car: '#c0392b',
  bus: '#e8c33a',
  truck: '#4f6d8f',
  motorcycle: '#a8322b',
  bicycle: '#2e6bd6',
  pedestrian: '#5c7d5a',
  bird: '#4a4a4a',
  dog: '#7a5534',
  horse: '#6b4428',
  wagon: '#7a5a3a',
  boat: '#a0522d',
  dragon: '#4f6b3f',
  drone: '#8a8f99',
  spacecraft: '#c8ccd4',
  generic: '#9b59b6',
  model: '#9b59b6',
};

const BUILDERS: Record<DynamicElement['kind'], (color: string, label: string) => Prop> = {
  // kind 'model' draws DynamicElement.model (a glTF binary); until the props package lands it is the marker
  model: generic,
  car,
  bus,
  truck,
  motorcycle,
  bicycle,
  pedestrian,
  bird,
  dog,
  horse,
  wagon,
  boat,
  dragon,
  drone,
  spacecraft,
  generic,
};

export function createProp(kind: DynamicElement['kind'], label = ''): Prop {
  const color = propColor(label, DEFAULT_COLOR[kind]);
  const prop = BUILDERS[kind](color, label);
  prop.object.name = `prop:${kind}`;
  return prop;
}
