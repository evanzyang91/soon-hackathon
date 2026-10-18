import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { HandheldNudge } from './nudge.ts';
import type { Vec3 } from '@shared/schema';

const I = new Quaternion();
const DT = 1 / 60;
const mag = (v: Vec3) => Math.hypot(...v);

function run(n: HandheldNudge, seconds: number, acc: (t: number) => Vec3 | null, q = I) {
  let peak = 0;
  let out: Vec3 = [0, 0, 0];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    out = n.update(acc(i * DT), q, DT);
    peak = Math.max(peak, mag(out));
  }
  return { out, peak };
}

describe('HandheldNudge', () => {
  it('stays exactly at rest with no motion', () => {
    const n = new HandheldNudge();
    expect(run(n, 2, () => [0, 0, 0]).out).toEqual([0, 0, 0]);
  });

  it('never drifts under a constant accelerometer bias (small start-up transient only)', () => {
    const n = new HandheldNudge();
    const { out, peak } = run(n, 20, () => [0.1, -0.06, 0.04]);
    expect(peak).toBeLessThan(0.01);
    expect(mag(out)).toBeLessThan(0.0005);
  });

  it('starting mid-motion does not cause a long excursion', () => {
    const n = new HandheldNudge();
    const push = run(n, 0.25, (t) => [0, 0, t < 0.12 ? 3 : -3]); // stream starts during a push
    expect(push.peak).toBeLessThan(0.05);
    expect(mag(run(n, 1.5, () => [0, 0, 0]).out)).toBeLessThan(0.002);
  });

  it('a sudden bias step gives a bounded transient that the DC filter removes within ~4 s', () => {
    const n = new HandheldNudge();
    run(n, 2, () => [0, 0, 0]);
    const step = run(n, 4, () => [0.8, 0, 0]);
    expect(step.peak).toBeGreaterThan(0.01);
    expect(step.peak).toBeLessThan(0.06);
    expect(mag(step.out)).toBeLessThan(0.002);
  });

  it('a hand push (short pulse) moves the camera, then springs back to 0', () => {
    const n = new HandheldNudge();
    const push = run(n, 0.25, (t) => [0, 0, t < 0.12 ? 3 : -3]);
    expect(push.peak).toBeGreaterThan(0.01);
    expect(push.peak).toBeLessThanOrEqual(0.3);
    const settle = run(n, 1.5, () => [0, 0, 0]);
    expect(mag(settle.out)).toBeLessThan(0.002);
  });

  it('produces subtle sway (mm–cm) from hand-tremor-sized input', () => {
    const n = new HandheldNudge();
    const { peak } = run(n, 5, (t) => [
      0.4 * Math.sin(2 * Math.PI * 2 * t),
      0.3 * Math.sin(5 * t),
      0,
    ]);
    expect(peak).toBeGreaterThan(0.0005);
    expect(peak).toBeLessThan(0.05);
  });

  it('clamps to ±0.3 m under absurd input', () => {
    const n = new HandheldNudge();
    let i = 0;
    const { peak, out } = run(n, 1, () => (i++ % 60 < 30 ? [500, -500, 500] : [-500, 500, -500]));
    expect(peak).toBeLessThanOrEqual(Math.sqrt(3) * 0.3 + 1e-9);
    for (const v of out) expect(Math.abs(v)).toBeLessThanOrEqual(0.3);
  });

  it('rotates device-frame acceleration into the world frame', () => {
    // Device yawed 90° left: device +x (right edge) points to world −Z.
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const n = new HandheldNudge();
    run(n, 0.5, () => [0, 0, 0], q);
    const { out } = run(n, 0.1, () => [2, 0, 0], q);
    expect(out[2]).toBeLessThan(-0.001);
    expect(Math.abs(out[0])).toBeLessThan(1e-9);
  });

  it('springs back when acceleration data disappears (null) and survives NaN / huge dt', () => {
    const n = new HandheldNudge();
    run(n, 1, () => [0, 0, 0]);
    run(n, 0.1, () => [0, 3, 0]);
    expect(mag(n.offset)).toBeGreaterThan(0);
    n.update([NaN, 0, 0], I, 5);
    const { out } = run(n, 3, () => null);
    expect(mag(out)).toBeLessThan(0.001);
    expect(out.every(Number.isFinite)).toBe(true);
  });
});
