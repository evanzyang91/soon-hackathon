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
  pipRectFor,
  poseAspect,
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

  it('adds the phone joystick walk offset on top of the anchor and the nudge', () => {
    const p = phoneCameraPose(pose({ offset: [1.5, 0.25, -3] }), [2, 1.6, 2]);
    expect(p.position[0]).toBeCloseTo(3.6);
    expect(p.position[1]).toBeCloseTo(1.8);
    expect(p.position[2]).toBeCloseTo(-0.98);
    // poses from phones without a joystick (no `offset`) still parse and sit on the anchor
    const legacy = parseServerMessage(JSON.stringify(pose()));
    expect(legacy?.type === 'pose' && legacy.offset).toBeUndefined();
    const offset = parseServerMessage(JSON.stringify(pose({ offset: [0, 0, -1] })));
    expect(offset?.type === 'pose' && offset.offset).toEqual([0, 0, -1]);
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

describe('several phones', () => {
  const from = (phoneId: string, t: number) => pose({ phoneId, t });
  const feed = (steps: [string, number][]) =>
    steps.reduce((s, [id, at]) => reducePhoneLink(s, from(id, at), at), initialPhoneLink());

  it('follows the first phone while it keeps streaming', () => {
    const s = feed([
      ['A', 0],
      ['A', 100],
      ['A', 200],
    ]);
    expect(s.followId).toBe('A');
    expect(s.lastPose?.t).toBe(200);
  });

  it('a newly joined phone takes over, and the old one no longer moves the gizmo', () => {
    const s = feed([
      ['A', 0],
      ['B', 50],
      ['A', 100],
      ['A', 150],
    ]);
    expect(s.followId).toBe('B');
    expect(s.lastPose?.t).toBe(50);
    expect(s.seen).toEqual(['A', 'B']);
  });

  it('falls back to another phone once the followed one goes quiet', () => {
    let s = feed([
      ['A', 0],
      ['B', 50],
    ]);
    s = reducePhoneLink(s, from('A', 500), 500); // B silent 450 ms: still followed
    expect(s.followId).toBe('B');
    s = reducePhoneLink(s, from('A', 1200), 1200); // B silent > 1 s: A takes over
    expect(s.followId).toBe('A');
    expect(s.lastPose?.t).toBe(1200);
  });

  it('accepts unstamped poses (older relay) and forgets phones when the room empties', () => {
    let s = reducePhoneLink(initialPhoneLink(), pose({ t: 1 }), 0);
    expect(s.lastPose?.t).toBe(1);
    expect(s.followId).toBeNull();
    s = reducePhoneLink(s, from('A', 2), 10);
    s = reducePhoneLink(s, { type: 'peers', laptop: true, phones: 0 }, 20);
    expect(s.seen).toEqual([]);
    expect(s.followId).toBeNull();
  });
});

describe('phone framing', () => {
  it('reads the pose aspect, clamped, with a 16:9 default', () => {
    expect(poseAspect(null)).toBeCloseTo(16 / 9);
    expect(poseAspect(pose())).toBeCloseTo(16 / 9);
    expect(poseAspect(pose({ aspect: 2.164 }))).toBeCloseTo(2.164);
    expect(poseAspect(pose({ aspect: 0.1 }))).toBe(0.4);
  });

  it('places a PiP of the phone aspect in the bottom-right corner', () => {
    const wide = pipRectFor(1280, 720, 16 / 9);
    expect(wide).toEqual({ x: 1280 - 358 - 12, y: 720 - 202 - 12, width: 358, height: 202 });
    const portrait = pipRectFor(1280, 720, 9 / 16);
    expect(portrait.height).toBeLessThanOrEqual(720 * 0.4);
    expect(portrait.width / portrait.height).toBeCloseTo(9 / 16, 1);
    expect(portrait.x + portrait.width).toBe(1280 - 12);
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
