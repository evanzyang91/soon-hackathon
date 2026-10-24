import { describe, expect, it } from 'vitest';
import { ClientMessage, type DropCamera, type PhonePose } from '@shared/protocol';
import {
  buildSceneState,
  cycleCamera,
  initialPhoneLink,
  nextCameraName,
  normalizeQuat,
  parseServerMessage,
  phoneAnchor,
  phoneCameraPose,
  phoneCommand,
  poseIsFresh,
  reducePhoneLink,
  sceneStateKey,
  type DirectorSnapshot,
} from './messages';

const cam = (id: string, x = 0): DropCamera => ({
  id,
  name: `Cam ${id}`,
  position: [x, 1.6, 2],
  quaternion: [0, 0, 0, 1],
  fovDeg: 50,
});

const pose = (over: Partial<PhonePose> = {}): PhonePose => ({
  type: 'pose',
  t: 1234,
  q: [0, 0.7071068, 0, 0.7071068],
  nudge: [0.1, -0.05, 0.02],
  fovDeg: 55,
  recording: false,
  ...over,
});

const snapshot = (over: Partial<DirectorSnapshot> = {}): DirectorSnapshot => ({
  projectId: 'p1',
  sceneIndex: 0,
  manifestUrl: '/projects/p1/scene-0/manifest.json',
  time: 3.14159,
  playing: true,
  cameras: [cam('a'), cam('b', 2)],
  activeCameraId: 'b',
  speakingLineId: null,
  ...over,
});

describe('parseServerMessage', () => {
  it('accepts valid pose/peers/scene/cmd frames, as text or objects', () => {
    expect(parseServerMessage(JSON.stringify(pose()))).toMatchObject({ type: 'pose', fovDeg: 55 });
    expect(parseServerMessage({ type: 'peers', laptop: true, phones: 1 })).toMatchObject({
      phones: 1,
    });
    expect(parseServerMessage({ type: 'cmd', cmd: 'next-camera' })).toEqual({
      type: 'cmd',
      cmd: 'next-camera',
    });
  });

  it('fills protocol defaults (recording=false)', () => {
    const { recording: _r, ...noRec } = pose();
    expect(parseServerMessage(noRec)).toMatchObject({ recording: false });
  });

  it('drops malformed or unknown frames', () => {
    expect(parseServerMessage('{nope')).toBeNull();
    expect(parseServerMessage({ type: 'pose', q: [0, 0, 1] })).toBeNull();
    expect(parseServerMessage({ type: 'hello', role: 'phone', room: 'ABCD' })).toBeNull();
    expect(parseServerMessage({ type: 'cmd', cmd: 'self-destruct' })).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
  });
});

describe('buildSceneState', () => {
  it('produces a protocol-valid SceneState', () => {
    const s = buildSceneState(snapshot());
    expect(s).not.toBeNull();
    expect(ClientMessage.parse(s)).toEqual(s);
    expect(s!.time).toBeCloseTo(3.142, 3);
    expect(s!.activeCameraId).toBe('b');
  });

  it('is null until a scene is open', () => {
    expect(buildSceneState(snapshot({ manifestUrl: null }))).toBeNull();
    expect(buildSceneState(snapshot({ sceneIndex: null }))).toBeNull();
  });

  it('never points the phone at a camera that no longer exists', () => {
    expect(buildSceneState(snapshot({ activeCameraId: 'gone' }))!.activeCameraId).toBeNull();
  });

  it('change key ignores the clock but not cameras or speaking line', () => {
    const a = buildSceneState(snapshot());
    expect(sceneStateKey(a)).toBe(sceneStateKey(buildSceneState(snapshot({ time: 99 }))));
    expect(sceneStateKey(a)).not.toBe(
      sceneStateKey(buildSceneState(snapshot({ speakingLineId: 's1-l1' }))),
    );
    expect(sceneStateKey(a)).not.toBe(
      sceneStateKey(buildSceneState(snapshot({ activeCameraId: 'a' }))),
    );
  });
});

describe('phone pose handling', () => {
  it('places the phone at the attached camera plus the nudge', () => {
    const p = phoneCameraPose(pose(), phoneAnchor([cam('a'), cam('b', 2)], 'b', [9, 9, 9]));
    expect(p.position[0]).toBeCloseTo(2.1);
    expect(p.position[1]).toBeCloseTo(1.55);
    expect(p.position[2]).toBeCloseTo(2.02);
    expect(p.fovDeg).toBe(55);
    expect(Math.hypot(...p.quaternion)).toBeCloseTo(1, 6);
  });

  it('falls back to the start camera when nothing is active', () => {
    expect(phoneAnchor([cam('a')], null, [0, 1.5, 0])).toEqual([0, 1.5, 0]);
  });

  it('normalizes quaternions and clamps fov', () => {
    expect(normalizeQuat([0, 0, 0, 2])).toEqual([0, 0, 0, 1]);
    expect(normalizeQuat([0, 0, 0, 0])).toEqual([0, 0, 0, 1]);
    expect(phoneCameraPose(pose({ fovDeg: 500 }), [0, 0, 0]).fovDeg).toBe(120);
  });

  it('tracks phone presence and pose freshness', () => {
    let s = initialPhoneLink();
    s = reducePhoneLink(s, { type: 'peers', laptop: true, phones: 1 }, 0);
    expect(s.phones).toBe(1);
    s = reducePhoneLink(s, pose(), 1000);
    expect(poseIsFresh(s, 2000)).toBe(true);
    expect(poseIsFresh(s, 5000)).toBe(false);
    s = reducePhoneLink(s, { type: 'peers', laptop: true, phones: 0 }, 6000);
    expect(s.lastPose).toBeNull();
    expect(poseIsFresh(s, 6000)).toBe(false);
  });
});

describe('camera helpers', () => {
  it('cycles the active camera for the phone "next camera" button', () => {
    const cams = [cam('a'), cam('b'), cam('c')];
    expect(cycleCamera(cams, 'a')).toBe('b');
    expect(cycleCamera(cams, 'c')).toBe('a');
    expect(cycleCamera(cams, null)).toBe('a');
    expect(cycleCamera([], null)).toBeNull();
  });

  it('names new cameras without collisions', () => {
    expect(nextCameraName([])).toBe('Cam 1');
    expect(nextCameraName([{ ...cam('x'), name: 'Cam 2' }])).toBe('Cam 3');
  });

  it('builds protocol-valid phone commands', () => {
    expect(ClientMessage.parse(phoneCommand('recenter'))).toEqual({ type: 'cmd', cmd: 'recenter' });
  });
});
