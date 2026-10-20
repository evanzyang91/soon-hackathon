import { describe, expect, it } from 'vitest';
import {
  BONES,
  CLIP_JOINTS,
  LIBRARY_SCHEMA,
  Mixer,
  RIG_SCHEMA,
  approach,
  clipBytes,
  closestFrame,
  composeLocal,
  dampTwist,
  makeSkeleton,
  newPose,
  newSkinFrame,
  parseLibrary,
  qFromRotvec,
  qmul,
  qrot,
  sampleClip,
  solveSkeleton,
  validateLibrary,
  validateRig,
  type Clip,
  type MotionLibraryJson,
  type RigJson,
} from './rig';

/** SMPL-X parents (55). */
const PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 15, 15, 15, ...Array(15).fill(20), ...Array(15).fill(21)];

/** A T-pose-ish skeleton: pelvis at y 0.9, legs down, spine up; good enough for FK tests. */
function rig(): RigJson {
  const rest: number[][] = Array.from({ length: BONES }, () => [0, 0, 0]);
  const set = (j: number, p: number[]) => (rest[j] = p);
  set(0, [0, 0.9, 0]);
  set(1, [0.1, 0.8, 0]);
  set(2, [-0.1, 0.8, 0]);
  set(3, [0, 1.0, 0]);
  set(4, [0.1, 0.45, 0]);
  set(5, [-0.1, 0.45, 0]);
  set(6, [0, 1.15, 0]);
  set(7, [0.1, 0.08, 0]);
  set(8, [-0.1, 0.08, 0]);
  set(9, [0, 1.25, 0]);
  set(10, [0.1, 0.03, 0.12]);
  set(11, [-0.1, 0.03, 0.12]);
  set(12, [0, 1.5, 0]);
  set(15, [0, 1.6, 0]);
  for (let j = 13; j < BONES; j++) if (rest[j]![1] === 0) rest[j] = [...rest[PARENTS[j]!]!];
  return {
    schema: RIG_SCHEMA,
    splats: 1,
    bones: BONES,
    joints: [],
    parents: PARENTS,
    rest,
    sourcePose: { root: [Math.PI, 0, 0], body: Array(21).fill([0, 0, 0]), jaw: [0, 0, 0], lhand: Array(15).fill([0, 0, 0]), rhand: Array(15).fill([0, 0, 0]) },
    measure: { nativeHeight: 1.7, soleY: 0, footJointMinY: 0.03, soleGap: 0.03, legLength: 0.82 },
    files: { splats: { file: 'rig-splats.bin', bytes: 44, layout: {} as RigJson['files']['splats']['layout'] } },
  };
}

/** A clip whose root yaw turns linearly a full `turn` radians over its frames. */
function clip(frames: number, turn = 0, name = 'c'): Clip {
  const quats = new Float32Array(frames * CLIP_JOINTS * 4);
  const root = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    for (let j = 0; j < CLIP_JOINTS; j++) quats[(f * CLIP_JOINTS + j) * 4 + 3] = 1;
    qFromRotvec(quats, f * CLIP_JOINTS * 4, 0, (turn * f) / frames, 0);
    root[f * 3] = 0.01 * f;
  }
  return { name, pose: 'standing', speaking: false, fps: 30, frames, quats, root, speed: 0, legLength: 0.82 };
}

describe('quaternion helpers', () => {
  it('qrot matches a 90 degree turn about +Y and qmul composes', () => {
    const q = [0, 0, 0, 1];
    qFromRotvec(q, 0, 0, Math.PI / 2, 0);
    const v = [0, 0, 0];
    qrot(v, 0, q, 0, 0, 0, 1); // +Z -> +X
    expect(v[0]).toBeCloseTo(1, 6);
    expect(v[2]).toBeCloseTo(0, 6);
    const qq = [0, 0, 0, 0];
    qmul(qq, 0, q, 0, q, 0);
    qrot(v, 0, qq, 0, 0, 0, 1); // 180 degrees: +Z -> -Z
    expect(v[2]).toBeCloseTo(-1, 6);
  });

  it('dampTwist keeps the swing and scales the twist about +Y', () => {
    const swing = [0, 0, 0, 1];
    qFromRotvec(swing, 0, 0.3, 0, 0);
    const twist = [0, 0, 0, 1];
    qFromRotvec(twist, 0, 0, 0.8, 0);
    const q = new Float32Array(4);
    qmul(q, 0, swing, 0, twist, 0);
    dampTwist(q, 0, 0.5);
    const expectTwist = [0, 0, 0, 1];
    qFromRotvec(expectTwist, 0, 0, 0.4, 0);
    const expected = [0, 0, 0, 0];
    qmul(expected, 0, swing, 0, expectTwist, 0);
    for (let i = 0; i < 4; i++) expect(q[i]).toBeCloseTo(expected[i]!, 5);
  });
});

describe('clips', () => {
  it('sampleClip wraps seamlessly and interpolates between frames', () => {
    const c = clip(30, Math.PI / 2);
    const a = sampleClip(c, 0, newPose());
    const b = sampleClip(c, 1, newPose()); // exactly one loop later
    for (let i = 0; i < 4; i++) expect(b.q[i]).toBeCloseTo(a.q[i]!, 6);
    const mid = sampleClip(c, 0.5 / 30, newPose()); // half way between frame 0 and 1
    const yaw = 2 * Math.atan2(mid.q[1]!, mid.q[3]!);
    expect(yaw).toBeCloseTo((0.5 * Math.PI) / 2 / 30, 4);
    expect(mid.root[0]).toBeCloseTo(0.005, 6);
  });

  it('closestFrame finds the frame matching a pose', () => {
    const c = clip(40, Math.PI);
    const p = sampleClip(c, 17 / 30, newPose());
    expect(closestFrame(c, p, 1)).toBe(17);
  });

  it('Mixer cross-fades without a jump at either end', () => {
    const a = clip(30, 0, 'a');
    const b = clip(30, Math.PI / 2, 'b');
    const m = new Mixer();
    m.play(a, 0.25);
    const p0 = m.update(1 / 60);
    const yaw0 = 2 * Math.atan2(p0.q[1]!, p0.q[3]!);
    m.play(b, 0.25, 15 / 30); // b at frame 15: yaw pi/4
    const yaws: number[] = [];
    for (let i = 0; i < 20; i++) { // (b's test yaw ramps without wrapping until t = 1 s)
      const p = m.update(1 / 60);
      yaws.push(2 * Math.atan2(p.q[1]!, p.q[3]!));
    }
    expect(Math.abs(yaws[0]! - yaw0)).toBeLessThan(0.05); // starts where a was
    for (let i = 1; i < yaws.length; i++) expect(Math.abs(yaws[i]! - yaws[i - 1]!)).toBeLessThan(0.12);
    expect(m.blend).toBe(1);
    expect(m.clip).toBe(b);
  });
});

describe('skeleton', () => {
  it('rest pose: identity skinning transforms and feet at their rest height', () => {
    const sk = makeSkeleton(rig());
    const f = newSkinFrame();
    composeLocal(sk, newPose(), f, 0, 0);
    // makeSkeleton keeps the (zero) source jaw/hands: everything identity
    for (let j = 0; j < 22; j++) expect(f.local[j * 4 + 3]).toBeCloseTo(1, 6);
    const shift = solveSkeleton(sk, f, [0, 0, 0]);
    expect(shift).toBeCloseTo(0, 6);
    for (let j = 0; j < BONES; j++) {
      expect(f.boneQ[j * 4 + 3]).toBeCloseTo(1, 6);
      for (let k = 0; k < 3; k++) expect(f.boneT[j * 3 + k]).toBeCloseTo(0, 6);
    }
  });

  it('a bent knee lowers the body so the lowest foot stays on the floor', () => {
    const sk = makeSkeleton(rig());
    const f = newSkinFrame();
    const pose = newPose();
    // both hips flexed forward 60 degrees and knees back 60 degrees: a crouch
    qFromRotvec(pose.q, 1 * 4, -1.05, 0, 0);
    qFromRotvec(pose.q, 2 * 4, -1.05, 0, 0);
    qFromRotvec(pose.q, 4 * 4, 1.05, 0, 0);
    qFromRotvec(pose.q, 5 * 4, 1.05, 0, 0);
    composeLocal(sk, pose, f, 0, 0);
    const shift = solveSkeleton(sk, f, [0, 0, 0]);
    expect(shift).toBeLessThan(-0.05);
    const low = Math.min(...[7, 8, 10, 11].map((j) => f.joints[j * 3 + 1]!));
    expect(low).toBeCloseTo(sk.footJointMinY, 6);
    // the skin transform maps each rest joint onto its posed position
    for (const j of [4, 7, 15]) {
      const v = [0, 0, 0];
      qrot(v, 0, f.boneQ, j * 4, sk.rest[j * 3]!, sk.rest[j * 3 + 1]!, sk.rest[j * 3 + 2]!);
      for (let k = 0; k < 3; k++) expect(v[k]! + f.boneT[j * 3 + k]!).toBeCloseTo(f.joints[j * 3 + k]!, 5);
    }
  });

  it('head yaw and jaw opening land on neck/head/jaw only', () => {
    const sk = makeSkeleton(rig());
    const f = newSkinFrame();
    composeLocal(sk, newPose(), f, 0.6, 0.2);
    const yaw = (j: number) => 2 * Math.atan2(f.local[j * 4 + 1]!, f.local[j * 4 + 3]!);
    expect(yaw(12) + yaw(15)).toBeCloseTo(0.6, 5);
    expect(2 * Math.atan2(f.local[22 * 4]!, f.local[22 * 4 + 3]!)).toBeCloseTo(0.2, 5);
    expect(f.local[16 * 4 + 3]).toBeCloseTo(1, 6);
  });
});

describe('approach (walk to the mark)', () => {
  it('waits on the starting mark until the clock runs, then reaches the mark and stops', () => {
    expect(approach(0, 2.4, 1.2)).toEqual({ remaining: 2.4, rate: 1, walking: false });
    let prev = 2.4;
    let t = 0;
    for (; t < 6; t += 1 / 60) {
      const s = approach(t + 1 / 60, 2.4, 1.2);
      expect(s.remaining).toBeLessThanOrEqual(prev + 1e-9);
      // never faster than the cruise speed
      expect(prev - s.remaining).toBeLessThanOrEqual(1.2 / 60 + 1e-6);
      prev = s.remaining;
      if (!s.walking) break;
    }
    expect(prev).toBe(0);
    expect(t).toBeGreaterThan(2.4 / 1.2 - 0.1);
    expect(t).toBeLessThan(4);
    // decelerates: the last steps are slower than cruise
    const late = approach(t - 0.05, 2.4, 1.2);
    expect(late.rate).toBeLessThan(0.6);
  });
});

describe('validation', () => {
  it('accepts a sound rig and rejects a broken skeleton', () => {
    expect(validateRig(rig()).bones).toBe(55);
    const bad = rig();
    bad.parents = [...PARENTS];
    bad.parents[5] = 9; // child before parent
    expect(() => validateRig(bad)).toThrow(/parents/);
    expect(() => validateRig({ ...rig(), schema: 'x' })).toThrow(/schema/);
  });

  it('parses a clip library and rejects out-of-range clips', () => {
    const frames = 3;
    const buf = new ArrayBuffer(clipBytes(frames));
    const q16 = new Int16Array(buf, 0, frames * CLIP_JOINTS * 4);
    for (let i = 3; i < q16.length; i += 4) q16[i] = 32767;
    new Float32Array(buf, frames * CLIP_JOINTS * 8, frames * 3).set([0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const json: MotionLibraryJson = {
      schema: LIBRARY_SCHEMA,
      fps: 30,
      joints: 22,
      file: 'motion-clips.bin',
      bytes: buf.byteLength,
      clips: [{ name: 'idle', pose: 'standing', speaking: false, frames, offset: 0, speed: 0, legLength: 0.8 }],
    };
    const [c] = parseLibrary(validateLibrary(json), buf);
    expect(c!.quats[3]).toBeCloseTo(1, 6);
    expect(c!.root[1]).toBe(1);
    expect(() => validateLibrary({ ...json, bytes: 10 })).toThrow(/outside/);
  });
});
