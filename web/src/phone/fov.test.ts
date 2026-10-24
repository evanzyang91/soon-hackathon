import { describe, expect, it } from 'vitest';
import {
  clampFov,
  focalLabel,
  focalMmToFov,
  fovToFocalMm,
  FOV_MAX,
  FOV_MIN,
  pinchFov,
} from './fov.ts';
import { PoseThrottle, poseKey } from './throttle.ts';

describe('fov ↔ focal length', () => {
  it('round-trips and labels full-frame equivalents', () => {
    expect(focalMmToFov(fovToFocalMm(40))).toBeCloseTo(40, 9);
    expect(focalLabel(focalMmToFov(35))).toBe('35mm');
    expect(focalLabel(90)).toBe('12mm');
    expect(focalLabel(24)).toBe('56mm');
  });

  it('pinch out zooms in, pinch in zooms out, clamped to 24–90°', () => {
    expect(pinchFov(50, 2)).toBeLessThan(50);
    expect(pinchFov(50, 0.5)).toBeGreaterThan(50);
    expect(fovToFocalMm(pinchFov(focalMmToFov(20), 2))).toBeCloseTo(40, 6);
    expect(pinchFov(50, 100)).toBe(FOV_MIN);
    expect(pinchFov(50, 0.01)).toBe(FOV_MAX);
    expect(pinchFov(50, NaN)).toBe(50);
    expect(clampFov(10)).toBe(24);
  });

  it('doubling the pinch doubles the focal length (until clamped)', () => {
    const f0 = fovToFocalMm(60);
    expect(fovToFocalMm(pinchFov(60, 1.5))).toBeCloseTo(f0 * 1.5, 6);
  });
});

describe('PoseThrottle', () => {
  it('yields ≤ 30 Hz from a 60 Hz and a 120 Hz frame loop', () => {
    for (const fps of [60, 120]) {
      const th = new PoseThrottle(30, 250);
      let sent = 0;
      for (let i = 0; i < fps; i++) if (th.shouldSend((i * 1000) / fps, `k${i}`)) sent++;
      expect(sent).toBeGreaterThanOrEqual(29);
      expect(sent).toBeLessThanOrEqual(30);
    }
  });

  it('skips unchanged poses but keeps alive every 250 ms', () => {
    const th = new PoseThrottle(30, 250);
    let sent = 0;
    for (let t = 0; t < 1000; t += 1000 / 60) if (th.shouldSend(t, 'same')) sent++;
    expect(sent).toBe(4);
  });

  it('poseKey changes with meaningful motion only', () => {
    const base = {
      q: [0, 0, 0, 1],
      nudge: [0, 0, 0],
      fovDeg: 50,
      recording: false,
      aspect: 2.16,
    } as const;
    const key = (o: object = {}) => poseKey({ ...base, ...o } as Parameters<typeof poseKey>[0]);
    const a = key();
    expect(key({ q: [0, 0.0001, 0, 1], nudge: [0, 0, 0.0002], fovDeg: 50.01, aspect: 2.161 })).toBe(
      a,
    );
    expect(key({ q: [0, 0.01, 0, 1] })).not.toBe(a);
    expect(key({ recording: true })).not.toBe(a);
    expect(key({ aspect: 0.46 })).not.toBe(a); // rotated to portrait
  });
});
