// Procedural fallback actor: a stylised mannequin built from primitives on a small joint
// hierarchy (no GLB to ship). Forward = -Z, feet at y = 0, 1.7 m tall. Idle sway + breathing +
// an occasional weight shift (every 6–10 s, eased over ~1.4 s, feet planted), head turned toward
// a look target (the speaker / scene partner, see viewer/gaze.ts), talk = head bob + jaw opening
// driven by the voice's amplitude (AnalyserNode), walk = in-place leg/arm swing, sitting = hips
// lowered with thighs forward. Everything is slow and eased: alive, never jittery.
// ~20 low-poly meshes: phone-light. A character of another height scales `root` uniformly
// (actors/index.ts mannequinBody), so every proportion and pose below stays in 1.7 m units.
import * as THREE from 'three';

/** The mannequin's built standing height (m). */
export const MANNEQUIN_HEIGHT_M = 1.7;

export type Pose = 'standing' | 'sitting' | 'walking';

export interface Mannequin {
  root: THREE.Group;
  headY: number;
  /** level: 0..1 voice loudness now; speaking: a line is active (mime if level stays 0). */
  animate(dt: number, t: number, speaking: boolean, level: number): void;
  setPose(pose: Pose): void;
  /** 0..1 current jaw opening */
  jawOpen(): number;
  /**
   * Turn the head toward a yaw relative to the body (rad, + = left), clamped to ±LOOK_LIMIT;
   * null = no target (the head idles straight ahead).
   */
  setLook(yaw: number | null): void;
  /** Current (eased) head yaw relative to the body, rad. */
  lookYaw(): number;
  /** Current weight shift, -1 (on the left leg) .. +1 (on the right leg). */
  weightShift(): number;
  dispose(): void;
}

const PELVIS_Y = 0.96;
const SIT_PELVIS_Y = 0.52;
/** How far the head (neck + a little chest) turns from the body, rad (≈ 69°). */
export const LOOK_LIMIT = 1.2;
/** Pelvis travel (m) and roll (rad, loaded hip up) at a full weight shift. */
const SHIFT_X = 0.045;
const SHIFT_ROLL = 0.06;
/** Hip → ankle (m), to keep the feet planted while the pelvis moves. */
const LEG = 0.88;
const SHIFT_EASE_S = 1.4;

/** Small deterministic PRNG (mulberry32): each mannequin shifts on its own schedule. */
function rng(seed: string): () => number {
  let a = 0;
  for (let i = 0; i < seed.length; i++) a = (Math.imul(a ^ seed.charCodeAt(i), 2654435761) + i) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smoothstep = (x: number) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

export function buildMannequin(tint: string): Mannequin {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const mat = (color: string, roughness = 0.75) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });
    materials.push(m);
    return m;
  };
  const cloth = mat(tint);
  const trousers = mat(new THREE.Color(tint).multiplyScalar(0.55).getStyle());
  const skin = mat('#d9b08c', 0.6);
  const dark = mat('#20242a', 0.4);
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, y = 0, x = 0, z = 0) => {
    geometries.push(g);
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  };
  const joint = (parent: THREE.Object3D, x: number, y: number, z = 0) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };
  const capsule = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 3, 10);

  const root = new THREE.Group();
  root.name = 'mannequin';
  const pelvis = joint(root, 0, PELVIS_Y);
  mesh(capsule(0.13, 0.12).rotateZ(Math.PI / 2), trousers, pelvis, 0.0).scale.set(1, 1, 0.8);
  const spine = joint(pelvis, 0, 0.05);
  mesh(capsule(0.15, 0.3), cloth, spine, 0.22).scale.set(1.15, 1, 0.75);
  const chest = joint(spine, 0, 0.36);
  const neck = joint(chest, 0, 0.07);
  mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 10), skin, neck, 0.02);
  const head = joint(neck, 0, 0.09);
  mesh(new THREE.SphereGeometry(0.105, 18, 14), skin, head, 0.08).scale.set(0.95, 1.1, 1);
  // face on the -Z side: eyes + nose make the facing direction readable from afar
  for (const sx of [-1, 1]) mesh(new THREE.SphereGeometry(0.014, 8, 6), dark, head, 0.1, sx * 0.036, -0.093);
  mesh(new THREE.ConeGeometry(0.014, 0.04, 8).rotateX(-Math.PI / 2), skin, head, 0.075, 0, -0.112);
  const jaw = joint(head, 0, 0.03, -0.02); // pivot near the ear line; front edge drops when open
  mesh(new THREE.BoxGeometry(0.075, 0.022, 0.06), dark, jaw, -0.012, 0, -0.055);

  const arm = (side: -1 | 1) => {
    // forward -Z => +X is the actor's right; side = +1 right, -1 left
    const shoulder = joint(chest, side * 0.2, 0.0);
    shoulder.rotation.z = side * 0.14; // arms slightly away from the body
    mesh(capsule(0.045, 0.2), cloth, shoulder, -0.14);
    const elbow = joint(shoulder, 0, -0.29);
    mesh(capsule(0.038, 0.19), skin, elbow, -0.12);
    mesh(new THREE.SphereGeometry(0.045, 10, 8), skin, elbow, -0.27);
    return { shoulder, elbow };
  };
  const leg = (side: -1 | 1) => {
    const hip = joint(pelvis, side * 0.09, -0.02);
    mesh(capsule(0.065, 0.3), trousers, hip, -0.22);
    const knee = joint(hip, 0, -0.44);
    mesh(capsule(0.05, 0.31), trousers, knee, -0.22);
    const ankle = joint(knee, 0, -0.44);
    mesh(new THREE.BoxGeometry(0.09, 0.06, 0.22), dark, ankle, -0.03, 0, -0.05);
    return { hip, knee };
  };
  const arms = { l: arm(-1), r: arm(1) };
  const legs = { l: leg(-1), r: leg(1) };
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });

  let pose: Pose = 'standing';
  let jawOpen = 0;
  let talkEnergy = 0;
  let lookTarget: number | null = null;
  let look = 0;
  const rand = rng(tint);
  let shift = 0;
  let shiftFrom = 0;
  let shiftTo = 0;
  let shiftStart = -Infinity;
  let nextShiftAt = 2.5 + 3 * rand();

  return {
    root,
    headY: PELVIS_Y + 0.05 + 0.36 + 0.07 + 0.09 + 0.08,
    setPose(p) {
      pose = p;
    },
    jawOpen: () => jawOpen,
    setLook(yaw) {
      lookTarget = yaw === null || !Number.isFinite(yaw) ? null : Math.max(-LOOK_LIMIT, Math.min(LOOK_LIMIT, yaw));
    },
    lookYaw: () => look,
    weightShift: () => shift,
    animate(dt, t, speaking, level) {
      const breathe = Math.sin((t * Math.PI * 2) / 4);
      const sway = Math.sin((t * Math.PI * 2) / 5.3);
      // voice level -> jaw (fast attack, slower release); mime when the analyser has nothing
      const target = speaking ? (level > 0.02 ? Math.min(1, level * 1.6) : 0.55 * Math.abs(Math.sin(t * 10.5))) : 0;
      const k = 1 - Math.exp(-dt * (target > jawOpen ? 35 : 22));
      jawOpen += (target - jawOpen) * k;
      talkEnergy += ((speaking ? 1 : 0) - talkEnergy) * (1 - Math.exp(-dt * 4));
      jaw.rotation.x = -0.42 * jawOpen;
      chest.rotation.x = 0.02 * breathe;
      spine.rotation.z = 0.025 * sway;
      // head toward the speaker / partner, eased (~0.3 s time constant) so a turn reads as a
      // deliberate glance; a small idle wander stays on top (wider with nobody to look at)
      look += ((lookTarget ?? 0) - look) * (1 - Math.exp(-dt * 3.5));
      const wander = Math.sin((t * Math.PI * 2) / 7.1) * (lookTarget === null ? 0.18 : 0.05);
      chest.rotation.y = 0.3 * look;
      neck.rotation.y = 0.7 * look + wander * (1 - 0.5 * talkEnergy);
      neck.rotation.x = talkEnergy * (0.05 * Math.sin(t * 6.3) + 0.04 * jawOpen);
      head.rotation.z = talkEnergy * 0.04 * Math.sin(t * 3.7);
      // a little gesturing while talking (+x rotation = forearm/arm forward, toward -Z)
      arms.r.elbow.rotation.x = talkEnergy * (0.5 + 0.25 * Math.sin(t * 2.6));
      arms.r.shoulder.rotation.x = talkEnergy * 0.25;

      // weight shift: standing only, every 6–10 s, to the other leg (now and then back to even)
      if (pose === 'standing') {
        if (t >= nextShiftAt) {
          shiftFrom = shift;
          const side = shift > 0.1 ? -1 : shift < -0.1 ? 1 : rand() < 0.5 ? -1 : 1;
          shiftTo = Math.abs(shift) > 0.1 && rand() < 0.25 ? 0 : side * (0.65 + 0.35 * rand());
          shiftStart = t;
          nextShiftAt = t + 6 + 4 * rand();
        }
        shift = shiftFrom + (shiftTo - shiftFrom) * smoothstep((t - shiftStart) / SHIFT_EASE_S);
      } else {
        shift = shiftFrom = shiftTo = 0;
      }
      const roll = SHIFT_ROLL * shift;
      const dx = SHIFT_X * shift;
      pelvis.position.x = dx;
      pelvis.rotation.z = roll;
      // feet stay planted: each leg leans back under its hip; the torso counter-tilts so the
      // head stays over the feet
      legs.l.hip.rotation.z = legs.r.hip.rotation.z = -roll - Math.asin(dx / LEG);
      spine.rotation.z += -1.2 * roll;

      if (pose === 'walking') {
        const w = t * Math.PI * 2 * 0.9;
        const s = Math.sin(w);
        legs.l.hip.rotation.x = 0.45 * s;
        legs.r.hip.rotation.x = -0.45 * s;
        legs.l.knee.rotation.x = -0.6 * Math.max(0, Math.sin(w + Math.PI / 2));
        legs.r.knee.rotation.x = -0.6 * Math.max(0, Math.sin(w - Math.PI / 2));
        arms.l.shoulder.rotation.x = -0.35 * s;
        if (talkEnergy < 0.5) arms.r.shoulder.rotation.x = 0.35 * s;
        pelvis.position.y = PELVIS_Y + 0.025 * Math.abs(Math.cos(w));
        pelvis.rotation.y = 0.08 * s;
      } else if (pose === 'sitting') {
        pelvis.position.y = SIT_PELVIS_Y;
        pelvis.rotation.y = 0;
        for (const l of [legs.l, legs.r]) {
          l.hip.rotation.x = Math.PI / 2;
          l.knee.rotation.x = -Math.PI / 2;
        }
        arms.l.shoulder.rotation.x = 0.3;
        if (talkEnergy < 0.5) arms.r.shoulder.rotation.x = 0.3;
        arms.l.elbow.rotation.x = 0.6;
      } else {
        // the loaded hip rises with the roll: drop the pelvis so that foot stays on the floor
        pelvis.position.y = PELVIS_Y - 0.004 * (1 + breathe) - 0.09 * Math.sin(Math.abs(roll));
        pelvis.rotation.y = 0;
        // the unloaded leg relaxes: knee a little bent, thigh a little forward
        const relax = Math.abs(shift);
        const free = shift > 0 ? legs.l : legs.r;
        const loaded = shift > 0 ? legs.r : legs.l;
        loaded.hip.rotation.x = loaded.knee.rotation.x = 0;
        free.hip.rotation.x = 0.07 * relax;
        free.knee.rotation.x = -0.14 * relax;
        arms.l.shoulder.rotation.x = 0.04 * sway;
        if (talkEnergy < 0.5) arms.r.shoulder.rotation.x = -0.04 * sway;
        arms.l.elbow.rotation.x = 0.08 + 0.03 * breathe;
        arms.l.shoulder.rotation.z = -0.14 - 0.02 * breathe;
        arms.r.shoulder.rotation.z = 0.14 + 0.02 * breathe;
      }
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
