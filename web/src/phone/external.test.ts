import { describe, expect, it } from 'vitest';
import {
  clampExternalFov,
  EXTERNAL_FOV_MAX,
  EXTERNAL_FOV_MIN,
  parseExternalPose,
} from './external.ts';
import { cameraPosition } from './walk.ts';

// a tilted, turned camera: ~ yaw 40°, pitch -15°, roll 5°
const Q: [number, number, number, number] = [-0.1186, 0.3363, 0.0016, 0.9343];
const norm = Math.hypot(...Q);
const UNIT_Q = Q.map((c) => c / norm) as [number, number, number, number];

const POSE = {
  type: 'pose',
  source: 'arkit',
  t: 1234.5,
  q: UNIT_Q,
  nudge: [0.01, 0, 0],
  offset: [0.5, 0, -0.2],
  fovDeg: 38,
  aspect: 2.164,
  recording: true,
};

describe('parseExternalPose', () => {
  it('keeps q, nudge, offset, fov and recording verbatim', () => {
    const p = parseExternalPose(POSE)!;
    expect(p.q).toEqual(UNIT_Q);
    expect(p.nudge).toEqual([0.01, 0, 0]);
    expect(p.offset).toEqual([0.5, 0, -0.2]);
    expect(p.fovDeg).toBe(38);
    expect(p.recording).toBe(true);
  });

  it('does not clamp to the pinch lens range (24–90°)', () => {
    expect(parseExternalPose({ ...POSE, fovDeg: 15 })!.fovDeg).toBe(15);
    expect(parseExternalPose({ ...POSE, fovDeg: 100 })!.fovDeg).toBe(100);
  });

  it('clamps fov to [10, 120] only', () => {
    expect(parseExternalPose({ ...POSE, fovDeg: 2 })!.fovDeg).toBe(EXTERNAL_FOV_MIN);
    expect(parseExternalPose({ ...POSE, fovDeg: 179 })!.fovDeg).toBe(EXTERNAL_FOV_MAX);
    expect(clampExternalFov(60)).toBe(60);
  });

  it('treats missing offset / nudge as zero and anything but true as not recording', () => {
    const { offset, nudge, recording, ...rest } = POSE;
    void offset;
    void nudge;
    void recording;
    const p = parseExternalPose(rest)!;
    expect(p.offset).toEqual([0, 0, 0]);
    expect(p.nudge).toEqual([0, 0, 0]);
    expect(p.recording).toBe(false);
    expect(parseExternalPose({ ...POSE, recording: 'yes' })!.recording).toBe(false);
  });

  it('accepts a quaternion a little off unit length (rounded JSON)', () => {
    expect(
      parseExternalPose({ ...POSE, q: Q.map((c) => Math.round(c * 100) / 100) }),
    ).not.toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'pose'],
    ['no q', { ...POSE, q: undefined }],
    ['a short q', { ...POSE, q: [0, 0, 1] }],
    ['a NaN in q', { ...POSE, q: [NaN, 0, 0, 1] }],
    ['a zero q', { ...POSE, q: [0, 0, 0, 0] }],
    ['a non-unit q', { ...POSE, q: [0, 0, 0, 2] }],
    ['no fov', { ...POSE, fovDeg: undefined }],
    ['an infinite fov', { ...POSE, fovDeg: Infinity }],
    ['a string fov', { ...POSE, fovDeg: '38' }],
    ['a short nudge', { ...POSE, nudge: [0, 0] }],
    ['a non-finite offset', { ...POSE, offset: [0, Infinity, 0] }],
  ])('rejects %s', (_label, raw) => {
    expect(parseExternalPose(raw)).toBeNull();
  });

  it('returns fresh arrays (the caller may keep them)', () => {
    const p = parseExternalPose(POSE)!;
    expect(p.q).not.toBe(POSE.q);
    expect(p.offset).not.toBe(POSE.offset);
  });
});

describe('external camera position', () => {
  const at = (anchor: [number, number, number], raw: unknown) => {
    const p = parseExternalPose(raw)!;
    return cameraPosition({ position: anchor, offset: p.offset, nudge: p.nudge });
  };

  it('is anchor + offset + nudge', () => {
    const p = at([1, 1.5, 2], POSE);
    expect(p[0]).toBeCloseTo(1.51, 9);
    expect(p[1]).toBeCloseTo(1.5, 9);
    expect(p[2]).toBeCloseTo(1.8, 9);
  });

  it('sits on the anchor with a zero offset and nudge', () => {
    expect(at([3, 1.6, -4], { q: [0, 0, 0, 1], fovDeg: 50 })).toEqual([3, 1.6, -4]);
  });
});
