import { describe, expect, it } from 'vitest';
import { Blocking, ScreenplayPlan } from './schema';
import {
  beatsEnd,
  fixMarks,
  GESTURE_S,
  performanceAt,
  poseFromAction,
  RISE_S,
  shiftBlocking,
  WALK_SPEED,
  yawAlong,
} from './beats';

const maya = Blocking.parse({
  characterId: 'maya',
  position: [-1, 0, -3],
  yaw: 1.2,
  pose: 'sitting',
  beats: [
    { t: 2, action: 'gets up and crosses to the kerb', moveTo: [1, 0, -3] },
    { t: 4, action: 'turns back to Theo', yaw: Math.PI },
    { t: 9, action: 'sinks onto the bench', moveTo: [1, 0, -4.2] },
  ],
});

describe('beats → performance', () => {
  it('old plans (no beats) still validate and hold their mark in their pose', () => {
    const old = Blocking.parse({
      characterId: 'theo',
      position: [1, 0, -3],
      yaw: 0,
      pose: 'walking',
    });
    expect(old.beats).toBeUndefined();
    expect(performanceAt(old, 5)).toEqual({
      x: 1,
      z: -3,
      yaw: 0,
      pose: 'walking',
      walked: 0,
      beat: -1,
      gesture: null,
    });
  });

  it('holds until the first beat, rises from the seat, then walks at a steady pace', () => {
    expect(performanceAt(maya, 1)).toMatchObject({ x: -1, z: -3, pose: 'sitting', beat: -1 });
    expect(performanceAt(maya, 2 + RISE_S / 2)).toMatchObject({ x: -1, pose: 'standing', beat: 0 });
    const mid = performanceAt(maya, 2 + RISE_S + 1 / WALK_SPEED);
    expect(mid.pose).toBe('walking');
    expect(mid.x).toBeCloseTo(0);
    expect(mid.walked).toBeCloseTo(1);
    expect(mid.yaw).toBeCloseTo(yawAlong(1, 0)); // walking toward +X
  });

  it('arrives, stands, then turns on the next beat', () => {
    const arrive = 2 + RISE_S + 2 / WALK_SPEED;
    expect(performanceAt(maya, arrive + 0.01)).toMatchObject({
      x: 1,
      z: -3,
      pose: 'standing',
      walked: 2,
    });
    expect(performanceAt(maya, 4.5)).toMatchObject({ x: 1, yaw: Math.PI, beat: 1 });
  });

  it('a later walk ends seated where it says, and walked distance accumulates', () => {
    const end = performanceAt(maya, 30);
    expect(end).toMatchObject({ x: 1, z: -4.2, pose: 'sitting', beat: 2 });
    expect(end.walked).toBeCloseTo(3.2);
    expect(beatsEnd(maya)).toBeCloseTo(9 + 1.2 / WALK_SPEED);
  });

  it('a beat that starts before the previous walk ends waits for it', () => {
    const b = Blocking.parse({
      characterId: 'x',
      position: [0, 0, 0],
      yaw: 0,
      beats: [
        { t: 0, action: 'walks off', moveTo: [0, 0, -6] },
        { t: 1, action: 'sits', pose: 'sitting' },
      ],
    });
    expect(performanceAt(b, 2).pose).toBe('walking');
    expect(performanceAt(b, 6 / WALK_SPEED + 0.01).pose).toBe('sitting');
  });

  it('is the same whichever order the planner listed the beats in', () => {
    const shuffled = { ...maya, beats: [...maya.beats!].reverse() };
    for (const t of [0, 3, 5, 10, 20])
      expect(performanceAt(shuffled, t)).toEqual(performanceAt(maya, t));
  });

  it('reads standing / sitting from the action', () => {
    expect(poseFromAction('sinks onto the bench')).toBe('sitting');
    expect(poseFromAction('Theo sits down beside her')).toBe('sitting');
    expect(poseFromAction('stands up from the bench')).toBe('standing');
    expect(poseFromAction('gets up')).toBe('standing');
    expect(poseFromAction('checks her phone')).toBeNull();
  });

  it('a plan with beats validates as a ScreenplayPlan', () => {
    expect(
      ScreenplayPlan.safeParse({
        title: 't',
        characters: [],
        scenes: [
          {
            index: 0,
            slug: 's',
            heading: 'EXT. X - NIGHT',
            action: '',
            worldPrompt: 'w',
            interior: false,
            characterIds: ['maya'],
            dialogue: [],
            blocking: [maya],
            dynamics: [],
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('gestures', () => {
  const b = Blocking.parse({
    characterId: 'theo',
    position: [0, 0, -3],
    yaw: 0,
    beats: [
      {
        t: 2,
        action: 'throws up his hands',
        gesture: 'A person throws both hands up.',
        clip: 'g1',
      },
      { t: 3, action: 'turns away', yaw: 1 },
      { t: 8, action: 'shrugs', clip: 'talk-2' },
      { t: 9, action: 'walks off', moveTo: [0, 0, -6] },
    ],
  });
  const len = (c: string) => (c === 'g1' ? 2.5 : undefined);

  it('plays a gesture once from its beat, for the clip length, through later non-walk beats', () => {
    expect(performanceAt(b, 1.9, WALK_SPEED, len).gesture).toBeNull();
    expect(performanceAt(b, 2, WALK_SPEED, len).gesture).toEqual({ clip: 'g1', time: 0 });
    expect(performanceAt(b, 3.5, WALK_SPEED, len).gesture).toEqual({ clip: 'g1', time: 1.5 });
    expect(performanceAt(b, 4.6, WALK_SPEED, len).gesture).toBeNull(); // 2.5 s clip is over
  });

  it('an unknown length plays GESTURE_S, and walking off ends it', () => {
    const shrug = performanceAt(b, 8.9, WALK_SPEED, len).gesture!;
    expect(shrug.clip).toBe('talk-2');
    expect(shrug.time).toBeCloseTo(0.9);
    const lone = { ...b, beats: b.beats!.slice(0, 3) }; // no walk after the shrug
    expect(performanceAt(lone, 8 + GESTURE_S - 0.01, WALK_SPEED, len).gesture?.clip).toBe('talk-2');
    expect(performanceAt(lone, 8 + GESTURE_S + 0.01, WALK_SPEED, len).gesture).toBeNull();
    expect(performanceAt(b, 9.1, WALK_SPEED, len).gesture).toBeNull();
  });
});

describe('shiftBlocking', () => {
  it('moves the start and every walk target together; yaw only replaces the start facing', () => {
    const s = shiftBlocking(maya, [0, 0, -2], 0.5);
    expect(s.position).toEqual([0, 0, -2]);
    expect(s.yaw).toBe(0.5);
    expect(s.beats![0]!.moveTo).toEqual([2, 0, -2]);
    expect(s.beats![1]!.yaw).toBe(Math.PI);
    expect(performanceAt(s, 30)).toMatchObject({ x: 2, z: -3.2, pose: 'sitting' });
    expect(shiftBlocking(maya, [-1, 0, -3])).toBe(maya);
  });
});

describe('fixMarks', () => {
  it('moves only the walk targets the fix changes, with the pose the actor arrives in', () => {
    const seen: string[] = [];
    const fixed = fixMarks(maya, (x, z, pose) => {
      seen.push(pose);
      return z < -4 ? [x + 0.5, z] : [x, z];
    });
    expect(seen).toEqual(['standing', 'sitting']);
    expect(fixed.beats![0]).toBe(maya.beats![0]);
    expect(fixed.beats![1]).toBe(maya.beats![1]);
    expect(fixed.beats![2]!.moveTo).toEqual([1.5, 0, -4.2]);
    expect(maya.beats![2]!.moveTo).toEqual([1, 0, -4.2]);
  });

  it('returns the same blocking when every mark is clear', () => {
    expect(fixMarks(maya, (x, z) => [x, z])).toBe(maya);
    const still = Blocking.parse({ characterId: 'a', position: [0, 0, 0], yaw: 0 });
    expect(fixMarks(still, () => [9, 9])).toBe(still);
  });
});
