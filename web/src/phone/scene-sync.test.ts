import { Euler, Quaternion } from 'three';
import { describe, expect, it } from 'vitest';
import type { SceneState } from '@shared/protocol';
import type { SceneManifest } from '@shared/schema';
import {
  anchorFor,
  captionFor,
  clockLabel,
  DialogueActivity,
  SceneClockTracker,
} from './scene-sync.ts';
import { attitudeOf } from './viewfinder.ts';

const q = (yaw: number, pitch = 0) => {
  const r = new Quaternion().setFromEuler(new Euler(pitch, yaw, 0, 'YXZ'));
  return [r.x, r.y, r.z, r.w] as [number, number, number, number];
};

const state = (over: Partial<SceneState> = {}): SceneState => ({
  type: 'scene',
  projectId: 'p',
  sceneIndex: 0,
  manifestUrl: '/projects/p/scene-0/manifest.json',
  time: 10,
  playing: true,
  cameras: [
    { id: 'a', name: 'Wide', position: [1, 1.5, 2], quaternion: q(0.5, -0.2), fovDeg: 40 },
    { id: 'b', name: 'Close', position: [0, 1.6, 0], quaternion: q(-1), fovDeg: 30 },
  ],
  activeCameraId: 'b',
  speakingLineId: 's1-l1',
  ...over,
});

const manifest = {
  version: 1,
  projectId: 'p',
  plan: {
    index: 0,
    dialogue: [{ id: 's1-l1', characterId: 'maya', text: 'You came back.', order: 0 }],
  },
  characters: [{ id: 'maya', name: 'MAYA' }],
  startCamera: { position: [0, 1.7, 3], quaternion: q(Math.PI / 4), fovDeg: 45 },
} as unknown as SceneManifest;

describe('anchorFor', () => {
  it('uses the active drop camera (yaw only, pitch ignored)', () => {
    const a = anchorFor(state({ activeCameraId: 'a' }), manifest);
    expect(a.position).toEqual([1, 1.5, 2]);
    expect(a.yaw).toBeCloseTo(0.5, 6);
    expect(a).toMatchObject({ name: 'Wide', fovDeg: 40, key: 'cam:a' });
  });

  it('falls back to the manifest start camera, then to a default', () => {
    const a = anchorFor(state({ activeCameraId: null }), manifest);
    expect(a.position).toEqual([0, 1.7, 3]);
    expect(a.yaw).toBeCloseTo(Math.PI / 4, 6);
    expect(anchorFor(state({ activeCameraId: 'gone' }), null)).toMatchObject({
      key: 'none',
      yaw: 0,
    });
  });
});

describe('captionFor', () => {
  it('looks up the speaking line and speaker name', () => {
    expect(captionFor(manifest, 's1-l1')).toEqual({ speaker: 'MAYA', text: 'You came back.' });
    expect(captionFor(manifest, null)).toBeNull();
    expect(captionFor(manifest, 'nope')).toBeNull();
    expect(captionFor(null, 's1-l1')).toBeNull();
  });
});

describe('SceneClockTracker', () => {
  it('extrapolates while playing, holds while paused', () => {
    const c = new SceneClockTracker();
    c.update(state({ time: 10, playing: true }), 1000);
    expect(c.time(2500)).toBeCloseTo(11.5, 9);
    c.update(state({ time: 4, playing: false }), 3000);
    expect(c.time(9000)).toBe(4);
  });
});

describe('attitudeOf', () => {
  it('reports compass heading clockwise, pitch up positive', () => {
    const a = attitudeOf(q(-Math.PI / 2, 0.1)); // turned right 90°
    expect(a.headingDeg).toBeCloseTo(90, 6);
    expect(a.pitchDeg).toBeCloseTo(0.1 * (180 / Math.PI), 6);
    expect(attitudeOf(q(Math.PI / 2)).headingDeg).toBeCloseTo(270, 6);
  });
});

describe('DialogueActivity (ACTION / CUT)', () => {
  it('is running while the clock plays and a line is spoken, across the gap between lines', () => {
    const d = new DialogueActivity(1200);
    const speaking = state({ playing: true, speakingLineId: 's1-l1' });
    const gap = state({ playing: true, speakingLineId: null });
    expect(d.running(gap, 0)).toBe(false); // playing, but no dialogue yet
    d.update(speaking, 1000);
    expect(d.running(speaking, 1000)).toBe(true);
    d.update(speaking, 3900); // the 4 Hz heartbeat keeps saying who speaks
    d.update(gap, 4000);
    expect(d.running(gap, 4500)).toBe(true); // 0.35 s pause between lines
    expect(d.running(gap, 5300)).toBe(false); // dialogue over, clock still running
  });

  it('stops at once when the laptop pauses (CUT)', () => {
    const d = new DialogueActivity();
    d.update(state({ speakingLineId: 's1-l1' }), 0);
    expect(d.running(state({ playing: false, speakingLineId: null }), 100)).toBe(false);
    expect(d.running(null, 100)).toBe(false);
    d.reset();
    expect(d.running(state({ speakingLineId: null }), 100)).toBe(false);
  });
});

describe('clockLabel', () => {
  it('shows play / pause and m:ss', () => {
    expect(clockLabel(4.7, true)).toBe('▶ 0:04');
    expect(clockLabel(62, false)).toBe('⏸ 1:02');
    expect(clockLabel(-3, false)).toBe('⏸ 0:00');
    expect(clockLabel(NaN, true)).toBe('▶ 0:00');
  });
});
