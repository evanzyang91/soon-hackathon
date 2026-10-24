import { readFileSync } from 'node:fs';
import { Quaternion, Vector3, Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ScreenplayPlan } from '../../shared/schema.ts';
import { heuristicBlocking, mockPlan, parseFountain, parseHeading } from './fountain.ts';
import { lookAtQuat, yawFacing } from './geometry.ts';
import { checkDraft, parseScreenplay, type ClaudeCall, type ClaudeRequest } from './screenplay.ts';

const FIXTURE = readFileSync(
  new URL('../../fixtures/screenplay.fountain', import.meta.url),
  'utf8',
);
const noop = () => {};

describe('mock screenplay parser', () => {
  const plan = ScreenplayPlan.parse(mockPlan(FIXTURE));

  it('splits the fixture into 3 scenes with headings, time of day and interior flags', () => {
    expect(plan.title).toBe('The Last Bus');
    expect(plan.scenes.map((s) => s.heading)).toEqual([
      'EXT. CITY STREET - NIGHT',
      'INT. KITCHEN - MORNING',
      'EXT. ROOFTOP - DUSK',
    ]);
    expect(plan.scenes.map((s) => s.timeOfDay)).toEqual(['night', 'day', 'dusk']);
    expect(plan.scenes.map((s) => s.interior)).toEqual([false, true, false]);
    expect(plan.scenes.map((s) => s.slug)).toEqual([
      'ext-city-street-night',
      'int-kitchen-morning',
      'ext-rooftop-dusk',
    ]);
  });

  it('extracts characters once, with intro details and distinct voices', () => {
    expect(plan.characters.map((c) => c.id).sort()).toEqual(['maya', 'theo']);
    const maya = plan.characters.find((c) => c.id === 'maya')!;
    expect(maya.name).toBe('MAYA');
    expect(maya.description).toMatch(/denim jacket/);
    expect(new Set(plan.characters.map((c) => c.voice.id)).size).toBe(2);
  });

  it('keeps dialogue in order with ids, speakers and parentheticals', () => {
    const s1 = plan.scenes[0]!;
    expect(s1.dialogue.map((d) => [d.id, d.characterId, d.order])).toEqual([
      ['s1-l1', 'theo', 0],
      ['s1-l2', 'maya', 1],
      ['s1-l3', 'theo', 2],
      ['s1-l4', 'maya', 3],
    ]);
    expect(s1.dialogue[1]!.parenthetical).toBe('without looking up');
    expect(s1.dialogue[1]!.text).toBe("I let it go. I wasn't ready to go home.");
    expect(plan.scenes.reduce((n, s) => n + s.dialogue.length, 0)).toBe(12);
    expect(plan.scenes[2]!.dialogue.at(-1)).toMatchObject({
      characterId: 'theo',
      text: 'Deal.',
      parenthetical: 'handing her a mug',
    });
  });

  it('detects moving things only (sedan + bus at night, birds at dusk, nothing in the kitchen)', () => {
    const [street, kitchen, roof] = plan.scenes;
    expect(street!.dynamics.map((d) => d.kind)).toEqual(['car', 'bus']);
    expect(street!.dynamics[0]!.label).toMatch(/red sedan drives past/);
    expect(street!.dynamics[1]!.label).toMatch(/rumbles by/); // not "a bus shelter"
    const car = street!.dynamics[0]!;
    expect(car.speed).toBe(8);
    expect(car.loop).toBe(true);
    expect(car.path.every((p) => p[2] <= -8 && p[2] >= -15 && p[1] === 0)).toBe(true);
    expect(kitchen!.dynamics).toEqual([]);
    expect(roof!.dynamics.map((d) => d.kind)).toEqual(['bird']);
    expect(roof!.dynamics[0]!.path.every((p) => p[1] > 5)).toBe(true);
  });

  it('blocks two speakers 1.4 m apart, in front of the camera, facing each other', () => {
    for (const s of plan.scenes) {
      expect(s.blocking).toHaveLength(2);
      const [a, b] = s.blocking;
      expect(
        Math.hypot(a!.position[0] - b!.position[0], a!.position[2] - b!.position[2]),
      ).toBeCloseTo(1.4);
      for (const p of s.blocking) {
        expect(p.position[1]).toBe(0);
        expect(p.position[2]).toBeLessThanOrEqual(-1.5);
        expect(p.position[2]).toBeGreaterThanOrEqual(-4);
      }
      expect(a!.yaw).toBeCloseTo(yawFacing(a!.position, b!.position));
      expect(b!.yaw).toBeCloseTo(yawFacing(b!.position, a!.position));
      expect(s.shots.length).toBeGreaterThanOrEqual(2);
      expect(s.worldPrompt.length).toBeLessThanOrEqual(600);
      expect(s.worldPrompt).toMatch(/No people/);
    }
  });

  it('handles extensions, forced headings, transitions, notes and mid-speech parentheticals', () => {
    const raw = parseFountain(`
.ALLEY BEHIND THE DINER

[[a note that should vanish]]
DANA (V.O.)
I knew him once.
(beat)
A long time ago.

@McCLANE
Yippee.

CUT TO:

INT./EXT. CAR - DAY

DANA (CONT'D)
Drive.
`);
    expect(raw.scenes.map((s) => s.heading)).toEqual([
      'ALLEY BEHIND THE DINER',
      'INT./EXT. CAR - DAY',
    ]);
    expect(raw.scenes[0]!.dialogue).toEqual([
      { name: 'DANA', text: 'I knew him once.', parenthetical: undefined },
      { name: 'DANA', text: 'A long time ago.', parenthetical: 'beat' },
      { name: 'McCLANE', text: 'Yippee.', parenthetical: undefined },
    ]);
    expect(raw.scenes[1]!.dialogue).toEqual([
      { name: 'DANA', text: 'Drive.', parenthetical: undefined },
    ]);
    expect(raw.scenes[0]!.action.join(' ')).not.toMatch(/note|CUT TO/);
    expect(parseHeading('INT./EXT. CAR - DAY').interior).toBe(false);
    expect(parseHeading('INT. LAB - EARLY MORNING')).toEqual({
      interior: true,
      location: 'LAB',
      timeOfDay: 'dawn',
    });
  });

  it('arranges larger groups in an open arc in front of the camera, facing inward', () => {
    const b = heuristicBlocking(['a', 'b', 'c', 'd'], false);
    expect(b).toHaveLength(4);
    for (const x of b) {
      expect(x.position[2]).toBeLessThan(-1.5);
      expect(Math.abs(x.position[0])).toBeLessThanOrEqual(2);
    }
  });
});

describe('geometry', () => {
  it('lookAtQuat matches three.js lookAt for a camera', () => {
    const cases: [number[], number[]][] = [
      [
        [0, 1.6, 0],
        [0, 1.6, -5],
      ],
      [
        [1, 1.5, 2],
        [-1, 1.2, -3],
      ],
      [
        [-2, 1.7, -1],
        [0.7, 1.6, -3],
      ],
      [
        [0, 1, 0],
        [3, 4, 0.5],
      ],
    ];
    for (const [from, to] of cases) {
      const q = lookAtQuat(from as never, to as never);
      const dir = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...q));
      const want = new Vector3(to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!).normalize();
      expect(dir.distanceTo(want)).toBeLessThan(1e-4);
      // no roll: camera right vector stays horizontal
      expect(Math.abs(new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...q)).y)).toBeLessThan(
        1e-4,
      );
    }
  });

  it('yaw rotates -Z forward toward the target the way three.js rotation.y does', () => {
    const o = new Object3D();
    o.rotation.y = yawFacing([0, 0, 0], [5, 0, 0]);
    expect(new Vector3(0, 0, -1).applyQuaternion(o.quaternion).x).toBeCloseTo(1);
    o.rotation.y = yawFacing([0, 0, -3], [0, 0, 0]); // facing the source camera
    expect(new Vector3(0, 0, -1).applyQuaternion(o.quaternion).z).toBeCloseTo(1);
  });
});

// ---------------------------------------------------------------------------
// Claude path, with a fake call (no network)
// ---------------------------------------------------------------------------

const P = (x: number, y: number, z: number) => ({ x, y, z });
function draft(overrides: { badSpeaker?: boolean } = {}) {
  const scene = (heading: string, interior: boolean, lines: [string, string][]) => ({
    heading,
    action: 'Action.',
    timeOfDay: 'night',
    interior,
    worldPrompt:
      'A rain-slick street at night, sodium lights on wet asphalt, shuttered shops. No people.',
    characterIds: ['maya', 'theo'],
    dialogue: lines.map(([characterId, text]) => ({ characterId, text, parenthetical: null })),
    blocking: [
      {
        characterId: 'maya',
        position: P(-0.75, 0.3, -2.5),
        facing: P(0.75, 1.6, -2.5),
        pose: 'standing',
      },
      {
        characterId: 'theo',
        position: P(0.75, 0, -2.5),
        facing: P(-0.75, 1.6, -2.5),
        pose: 'sitting',
      },
    ],
    dynamics: [
      {
        kind: 'car',
        label: 'A red sedan drives past',
        path: [P(-30, 0, -10), P(30, 0, -10)],
        speed: 8,
        loop: true,
        pauseSeconds: 2,
        scale: 1,
      },
      {
        kind: 'generic',
        label: 'bad',
        path: [P(0, 0, 0)],
        speed: 1,
        loop: true,
        pauseSeconds: 0,
        scale: 1,
      },
    ],
    shots: [{ name: 'Wide', position: P(0, 1.6, 0), lookAt: P(0, 1.4, -2.5), fovDeg: 200 }],
  });
  const lines = (n: number): [string, string][] =>
    Array.from({ length: n }, (_, k) => [k % 2 ? 'maya' : 'theo', `line ${k}`]);
  const s1 = scene('EXT. CITY STREET - NIGHT', false, lines(4));
  if (overrides.badSpeaker) s1.dialogue[0]!.characterId = 'ghost';
  return {
    title: 'The Last Bus',
    characters: [
      {
        id: 'maya',
        name: 'Maya',
        gender: 'female',
        voice: 'nova',
        description: 'A woman in her 30s.',
      },
      { id: 'theo', name: 'THEO', gender: 'male', voice: 'nova', description: 'A man in his 40s.' },
    ],
    scenes: [
      s1,
      scene('INT. KITCHEN - MORNING', true, lines(4)),
      scene('EXT. ROOFTOP - DUSK', false, lines(4)),
    ],
  };
}

function fakeMessage(text: string, stop_reason: string = 'end_turn'): Anthropic.Beta.BetaMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason,
    usage: { input_tokens: 10, output_tokens: 20 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

describe('Claude screenplay path (fake client)', () => {
  it('converts the draft: ids, yaw from facing, feet on floor, quaternion shots, clamps and drops', () => {
    const r = checkDraft(JSON.stringify(draft()), FIXTURE);
    expect(r.problems).toEqual([]);
    const plan = r.plan!;
    const s = plan.scenes[0]!;
    expect(s.dialogue.map((d) => d.id)).toEqual(['s1-l1', 's1-l2', 's1-l3', 's1-l4']);
    expect(s.blocking[0]!.position).toEqual([-0.75, 0, -2.5]);
    expect(s.blocking[0]!.yaw).toBeCloseTo(-Math.PI / 2, 2); // faces +X
    expect(s.blocking[1]!.pose).toBe('sitting');
    expect(s.dynamics).toHaveLength(1); // the 1-point path is dropped
    expect(s.shots[0]!.fovDeg).toBe(120);
    expect(s.shots[0]!.quaternion).toHaveLength(4);
    // duplicate voice re-assigned within the gender pool
    expect(plan.characters.map((c) => c.voice.id)).toEqual(['nova', 'onyx']);
    expect(plan.characters[0]!.name).toBe('MAYA');
    expect(r.notes.some((n) => /dropped/.test(n))).toBe(true);
  });

  it('retries once with the validation errors fed back, then succeeds', async () => {
    const requests: ClaudeRequest[] = [];
    const replies = [JSON.stringify(draft({ badSpeaker: true })), JSON.stringify(draft())];
    const call: ClaudeCall = async (req) => {
      requests.push(structuredClone(req));
      return fakeMessage(replies[requests.length - 1]!);
    };
    const logs: string[] = [];
    const plan = await parseScreenplay(FIXTURE, { mock: false, log: (m) => logs.push(m), call });
    expect(requests).toHaveLength(2);
    expect(plan.scenes).toHaveLength(3);
    const feedback = requests[1]!.messages.at(-1)!;
    expect(feedback.role).toBe('user');
    expect(String(feedback.content)).toMatch(/unknown characterId "ghost"/);
    expect(requests[1]!.messages[1]!.role).toBe('assistant');
    expect(requests[0]!.schema).toMatchObject({ type: 'object' });
    expect(requests[0]!.system).toMatch(/looking down -Z/);
  });

  it('flags a wrong scene count and gives up after one retry', async () => {
    const short = draft();
    short.scenes = short.scenes.slice(0, 2);
    let calls = 0;
    const call: ClaudeCall = async () => {
      calls++;
      return fakeMessage(JSON.stringify(short));
    };
    await expect(parseScreenplay(FIXTURE, { mock: false, log: noop, call })).rejects.toThrow(
      /3 scene headings/,
    );
    expect(calls).toBe(2);
  });

  it('treats non-JSON as a validation problem and a refusal as fatal', async () => {
    let n = 0;
    const call: ClaudeCall = async () =>
      n++ === 0 ? fakeMessage('not json') : fakeMessage(JSON.stringify(draft()));
    await expect(parseScreenplay(FIXTURE, { mock: false, log: noop, call })).resolves.toMatchObject(
      { title: 'The Last Bus' },
    );
    const refuse: ClaudeCall = async () => fakeMessage('', 'refusal');
    await expect(
      parseScreenplay(FIXTURE, { mock: false, log: noop, call: refuse }),
    ).rejects.toThrow(/declined/);
  });

  it('mock mode never calls Claude', async () => {
    const call: ClaudeCall = async () => {
      throw new Error('should not be called');
    };
    const plan = await parseScreenplay(FIXTURE, { mock: true, log: noop, call, title: 'Override' });
    expect(plan.title).toBe('Override');
    expect(plan.scenes).toHaveLength(3);
  });
});
