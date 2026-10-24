import { Euler, Quaternion } from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@shared/schema';
import { headingOf, NO_WALK, shapeMagnitude, stickVector, Walker, type WalkInput } from './walk.ts';

const DT = 1 / 60;
const DEG = Math.PI / 180;
const cam = (yawDeg: number, pitchDeg = 0, rollDeg = 0) =>
  new Quaternion().setFromEuler(new Euler(pitchDeg * DEG, yawDeg * DEG, rollDeg * DEG, 'YXZ'));

function run(w: Walker, seconds: number, input: WalkInput, heading = 0) {
  let out: Vec3 = w.offset;
  let peakSpeed = 0;
  let maxStep = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const before = out;
    out = w.update(input, heading, DT);
    peakSpeed = Math.max(peakSpeed, w.speed);
    maxStep = Math.max(maxStep, Math.hypot(out[0] - before[0], out[1] - before[1], out[2] - before[2]));
  }
  return { out, peakSpeed, maxStep };
}

describe('headingOf', () => {
  it('is the yaw of a level camera (0 = facing −Z, + = turned left)', () => {
    expect(headingOf(cam(0))).toBeCloseTo(0, 6);
    expect(headingOf(cam(90))).toBeCloseTo(Math.PI / 2, 6);
    expect(headingOf(cam(-30))).toBeCloseTo(-30 * DEG, 6);
  });

  it('ignores pitch and roll (walking stays level wherever the phone points)', () => {
    for (const pitch of [-60, -20, 0, 35, 70])
      for (const roll of [-25, 0, 30])
        expect(headingOf(cam(40, pitch, roll))).toBeCloseTo(40 * DEG, 5);
  });

  it('uses the top of the frame when the camera points straight at the floor', () => {
    expect(headingOf(cam(120, -90))).toBeCloseTo(120 * DEG, 5);
    expect(headingOf([...cam(-70, -89.9).toArray()] as [number, number, number, number])).toBeCloseTo(
      -70 * DEG,
      3,
    );
  });
});

describe('stick shaping', () => {
  it('maps pointer pixels into the unit disk, screen up = forward', () => {
    expect(stickVector(0, -50, 50)).toEqual({ x: 0, y: 1 });
    expect(stickVector(25, 0, 50)).toEqual({ x: 0.5, y: 0 });
    const v = stickVector(300, 400, 50);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 9);
    expect(v.x).toBeCloseTo(0.6);
    expect(v.y).toBeCloseTo(-0.8);
  });

  it('has a dead zone, then ramps up to full', () => {
    expect(shapeMagnitude(0.1, 0.12, 1.6)).toBe(0);
    expect(shapeMagnitude(1, 0.12, 1.6)).toBe(1);
    expect(shapeMagnitude(2, 0.12, 1.6)).toBe(1);
    const half = shapeMagnitude(0.56, 0.12, 1.6);
    expect(half).toBeGreaterThan(0.2);
    expect(half).toBeLessThan(0.5); // curve: finer control near the centre
  });
});

describe('Walker', () => {
  it('stays exactly at the attached camera with the stick centred or inside the dead zone', () => {
    const w = new Walker();
    expect(run(w, 2, NO_WALK).out).toEqual([0, 0, 0]);
    expect(run(w, 2, { x: 0.05, y: 0.08, rise: 0.05 }).out).toEqual([0, 0, 0]);
  });

  it('walks forward along −Z at heading 0, ramping smoothly to 1.5 m/s', () => {
    const w = new Walker();
    const { out, peakSpeed, maxStep } = run(w, 2, { x: 0, y: 1, rise: 0 });
    expect(peakSpeed).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(peakSpeed).toBeGreaterThan(1.45);
    expect(maxStep).toBeLessThan(1.5 * DT + 1e-9); // no jumps
    expect(out[0]).toBeCloseTo(0, 9);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeLessThan(-2.4); // ~2 s at full speed minus the ramp
    expect(out[2]).toBeGreaterThan(-3);
    // the ramp: after one frame it is barely moving
    const w2 = new Walker();
    w2.update({ x: 0, y: 1, rise: 0 }, 0, DT);
    expect(w2.speed).toBeLessThan(0.3);
  });

  it('follows the heading: forward when turned left is −X, strafe right is then −Z', () => {
    const w = new Walker();
    const fwd = run(w, 1, { x: 0, y: 1, rise: 0 }, Math.PI / 2).out;
    expect(fwd[0]).toBeLessThan(-1);
    expect(fwd[2]).toBeCloseTo(0, 6);
    w.reset();
    const right = run(w, 1, { x: 1, y: 0, rise: 0 }, Math.PI / 2).out;
    expect(right[2]).toBeLessThan(-1);
    expect(right[0]).toBeCloseTo(0, 6);
    // strafe right at heading 0 is +X; pulling back walks +Z
    w.reset();
    expect(run(w, 1, { x: 1, y: 0, rise: 0 }).out[0]).toBeGreaterThan(1);
    w.reset();
    expect(run(w, 1, { x: 0, y: -1, rise: 0 }).out[2]).toBeGreaterThan(1);
  });

  it('caps diagonal input (both keys held) at the top speed', () => {
    const w = new Walker();
    const { out, peakSpeed } = run(w, 2, { x: 1, y: 1, rise: 0 });
    expect(peakSpeed).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(out[0]).toBeCloseTo(-out[2], 6); // 45° between right (+X) and forward (−Z)
  });

  it('eases to a stop after the stick is released (no instant stop, no drift)', () => {
    const w = new Walker();
    run(w, 1, { x: 0, y: 1, rise: 0 });
    const released = w.offset;
    w.update(NO_WALK, 0, DT);
    expect(w.speed).toBeGreaterThan(0.5); // still coasting one frame later
    const { out } = run(w, 2, NO_WALK);
    expect(w.speed).toBe(0);
    expect(out[2]).toBeLessThan(released[2]); // coasted a little further forward
    expect(out[2] - released[2]).toBeGreaterThan(-0.4);
    expect(run(w, 1, NO_WALK).out).toEqual(out);
  });

  it('changes height at up to 0.5 m/s, clamped to ±2 m (and to custom limits)', () => {
    const w = new Walker();
    const up = run(w, 1, { x: 0, y: 0, rise: 1 });
    expect(up.peakSpeed).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(up.out[1]).toBeGreaterThan(0.35);
    expect(up.out[1]).toBeLessThan(0.5);
    expect(run(w, 10, { x: 0, y: 0, rise: 1 }).out[1]).toBe(2);
    expect(run(w, 20, { x: 0, y: 0, rise: -1 }).out[1]).toBe(-2);
    w.reset();
    for (let i = 0; i < 600; i++) w.update({ x: 0, y: 0, rise: -1 }, 0, DT, { down: 1.45 });
    expect(w.offset[1]).toBeCloseTo(-1.45, 9);
  });

  it('reset returns to the attached camera, standing still', () => {
    const w = new Walker();
    run(w, 1, { x: 0.7, y: 0.7, rise: 1 }, 0.4);
    w.reset();
    expect(w.offset).toEqual([0, 0, 0]);
    expect(w.speed).toBe(0);
  });

  it('ignores garbage input and clamps dt', () => {
    const w = new Walker();
    w.update({ x: NaN, y: Infinity, rise: NaN }, 0, DT);
    expect(w.offset).toEqual([0, 0, 0]);
    w.update({ x: 0, y: 1, rise: 0 }, 0, 5); // a 5 s stall moves at most 0.1 s worth
    expect(Math.abs(w.offset[2])).toBeLessThan(0.15);
  });
});
