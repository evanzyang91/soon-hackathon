import { readFileSync } from 'node:fs';
import { Quaternion, Vector3, Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { DynamicElementKind, LookPresetName, ScreenplayPlan } from '../../shared/schema.ts';
import {
  heuristicBlocking,
  heuristicLookSeed,
  heuristicStyle,
  mockHeight,
  mockPlan,
  parseFountain,
  parseHeading,
} from './fountain.ts';
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
    // stable per-id heights in 1.62–1.85 m; THEO's intro says "tall"
    const theo = plan.characters.find((c) => c.id === 'theo')!;
    expect(maya.heightMeters).toBe(mockHeight('maya'));
    expect(theo.heightMeters).toBeGreaterThanOrEqual(1.8);
    expect(theo.heightMeters! - maya.heightMeters!).toBeGreaterThan(0.08);
    for (const id of ['a', 'leo', 'raj', 'sam', 'alice', 'jack']) {
      expect(mockHeight(id)).toBeGreaterThanOrEqual(1.62);
      expect(mockHeight(id)).toBeLessThanOrEqual(1.85);
    }
    expect(mockHeight('ana', 'a short woman')).toBeLessThanOrEqual(1.67);
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
    look: {
      preset: 'night-street',
      mood: 'wet, sodium-lit, lonely',
      exposure: null as number | null,
      temperature: -0.3 as number | null,
      saturation: null,
      contrast: null,
      bloom: null,
      vignette: null,
      fog: null as { color: string; density: number } | null,
      skyTint: null as { color: string; strength: number } | null,
      lut: null,
    },
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
    style: {
      genre: 'contemporary drama',
      era: 'present-day city',
      worldStyle: 'Photoreal cinematic film still, sodium night light, wet asphalt',
      palette: 'sodium orange, cold blue shadows',
    },
    characters: [
      {
        id: 'maya',
        name: 'Maya',
        gender: 'female',
        voice: 'nova',
        description: 'A woman in her 30s.',
        heightMeters: 1.684,
      },
      // a slip outside the contract's 0.9–2.3 m is clamped, not rejected
      { id: 'theo', name: 'THEO', gender: 'male', voice: 'nova', description: 'A tall man in his 40s.', heightMeters: 2.6 },
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
    // per-character height for the actor pipeline, centimetres, within the contract's range
    expect(plan.characters.map((c) => c.heightMeters)).toEqual([1.68, 2.3]);
    expect(r.notes).toContain('characters.theo: heightMeters 2.6 clamped to 2.3');
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

describe('Claude path: style, looks and the new prop kinds', () => {
  it('maps the style and each scene look into the plan', () => {
    const r = checkDraft(JSON.stringify(draft()), FIXTURE);
    expect(r.problems).toEqual([]);
    const plan = r.plan!;
    expect(plan.style).toEqual(draft().style);
    expect(plan.scenes[0]!.look).toEqual({ preset: 'night-street', mood: 'wet, sodium-lit, lonely', temperature: -0.3 });
  });

  it('clamps out-of-range adjustments, drops a fog without a hex colour, trims an over-long style', () => {
    const d = draft();
    Object.assign(d.scenes[0]!.look, {
      exposure: 5,
      fog: { color: 'grey', density: 0.2 },
      skyTint: { color: '#ABC', strength: 3 },
    });
    d.style.worldStyle = `Photoreal ${'very '.repeat(60)}cinematic`;
    const r = checkDraft(JSON.stringify(d), FIXTURE);
    expect(r.problems).toEqual([]);
    const look = r.plan!.scenes[0]!.look!;
    expect(look.exposure).toBe(3);
    expect(look.fog).toBeUndefined();
    expect(look.skyTint).toEqual({ color: '#aabbcc', strength: 1 });
    expect(r.plan!.style!.worldStyle.length).toBeLessThanOrEqual(200);
    expect(r.notes).toEqual(
      expect.arrayContaining([
        'scenes[0].look.exposure 5 clamped to 3',
        expect.stringMatching(/scenes\[0\]\.look\.fog dropped/),
        expect.stringMatching(/^style\.worldStyle trimmed/),
      ]),
    );
  });

  it('a slipped preset, LUT or prop kind is repaired with a note, never a failed plan', () => {
    const d = draft();
    Object.assign(d.scenes[0]!.look, { preset: 'Golden Hour', lut: 'sepia-ish' });
    Object.assign(d.scenes[1]!.look, { preset: 'sunset glow', mood: 'warm' });
    d.scenes[0]!.dynamics[0]!.kind = 'Stagecoach';
    const r = checkDraft(JSON.stringify(d), FIXTURE);
    expect(r.problems).toEqual([]);
    const [s0, s1] = r.plan!.scenes;
    expect(s0!.look).toMatchObject({ preset: 'golden-hour' });
    expect(s0!.look!.lut).toBeUndefined();
    expect(s1!.look).toEqual({ preset: 'warm-interior', mood: 'warm' }); // INT. KITCHEN, from the heading
    expect(s0!.dynamics[0]!.kind).toBe('generic');
    expect(r.notes).toEqual(
      expect.arrayContaining([
        'scenes[0].look.lut "sepia-ish" is not a LUT; dropped',
        'scenes[1].look.preset "sunset glow" is not a preset; derived from the heading',
        'scenes[0].dynamics[0]: kind "Stagecoach" shown as generic',
      ]),
    );
  });

  it('an empty style is read from the screenplay instead of failing the plan', () => {
    const d = draft();
    d.style = { genre: '', era: '', worldStyle: '', palette: '' };
    const r = checkDraft(JSON.stringify(d), FIXTURE);
    expect(r.problems).toEqual([]);
    expect(r.plan!.style!.genre).toBe('contemporary drama');
    expect(r.notes.some((n) => /style was empty/.test(n))).toBe(true);
  });

  it('asks for the style first and lists every preset and prop kind', async () => {
    let req: ClaudeRequest | undefined;
    const call: ClaudeCall = async (r) => {
      req = r;
      return fakeMessage(JSON.stringify(draft()));
    };
    await parseScreenplay(FIXTURE, { mock: false, log: noop, call });
    const props = (req!.schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).slice(0, 2)).toEqual(['title', 'style']);
    const scene = (props.scenes as { items: { properties: Record<string, { description?: string }> } }).items
      .properties as Record<string, { description?: string; items?: { properties: Record<string, { description?: string }> }; properties?: Record<string, { description?: string }> }>;
    const kinds = scene.dynamics!.items!.properties.kind!.description!;
    const presets = scene.look!.properties!.preset!.description!;
    expect(kinds).toBe(`one of: ${DynamicElementKind.options.join(', ')}`);
    expect(presets).toBe(`one of: ${LookPresetName.options.join(', ')}`);
    for (const p of LookPresetName.options) expect(req!.system).toContain(`  ${p}: `);
    expect(req!.system).toMatch(/Dragon a closed loop of 10-14 points 15-30 m up/);
    expect(req!.system).toMatch(/open with the render style from worldStyle/);
  });
});

// ---------------------------------------------------------------------------
// Mock planner on the genre fixtures
// ---------------------------------------------------------------------------

const genre = (g: string) =>
  ScreenplayPlan.parse(
    mockPlan(readFileSync(new URL(`../../fixtures/genres/${g}.fountain`, import.meta.url), 'utf8')),
  );
const plan0 = () => ScreenplayPlan.parse(mockPlan(FIXTURE));

describe('mock planner: every genre looks like itself', () => {
  // per scene, the presets that read right for it
  const cases: { g: string; genre: RegExp; presets: string[][] }[] = [
    { g: 'fantasy', genre: /fantasy/, presets: [['enchanted', 'golden-hour'], ['candlelit']] },
    { g: 'scifi', genre: /science fiction/, presets: [['cold-steel'], ['cold-steel', 'daylight-neutral']] },
    { g: 'horror', genre: /horror/, presets: [['horror'], ['horror', 'moonlit']] },
    { g: 'western', genre: /western/, presets: [['western-dust'], ['candlelit', 'golden-hour']] },
    { g: 'period', genre: /period/, presets: [['period-warm', 'candlelit'], ['snowfall']] },
  ];
  for (const c of cases)
    it(`${c.g}: ${c.genre.source}, a scene-appropriate look per scene, prompts in its register`, () => {
      const plan = genre(c.g);
      expect(plan.style!.genre).toMatch(c.genre);
      plan.scenes.forEach((s, i) => expect(c.presets[i]).toContain(s.look!.preset));
      for (const s of plan.scenes) {
        expect(s.worldPrompt.startsWith(plan.style!.worldStyle)).toBe(true);
        expect(s.worldPrompt).toMatch(/No people, no animals, no vehicles\.$/);
        expect(s.worldPrompt.length).toBeLessThanOrEqual(600);
        expect(s.look!.mood.length).toBeLessThanOrEqual(60);
      }
    });

  it('the new prop kinds come from the action lines', () => {
    const kinds = (g: string) => genre(g).scenes.map((s) => s.dynamics.map((d) => d.kind));
    expect(kinds('fantasy')).toEqual([['dragon'], []]); // "a hall lit by torches … a cart" is not a wagon
    expect(kinds('western')).toEqual([['wagon'], []]); // its two horses belong to the wagon
    expect(kinds('scifi')).toEqual([['drone'], ['spacecraft']]);
    expect(kinds('horror')).toEqual([[], ['dog']]);
    expect(kinds('period')).toEqual([[], []]); // the carriage waits by the gate
    const dragon = genre('fantasy').scenes[0]!.dynamics[0]!;
    expect(dragon.speed).toBe(10);
    expect(dragon.path[0]).toEqual(dragon.path.at(-1)); // closed loop
    expect(dragon.path.every((p) => p[1] >= 15 && p[1] <= 30 && p[2] <= -25)).toBe(true);
    const wagon = genre('western').scenes[0]!.dynamics[0]!;
    expect(wagon).toMatchObject({ speed: 2.5, label: expect.stringMatching(/wagon drawn by two horses/) });
    expect(wagon.path.every((p) => p[1] === 0 && p[2] === -10.5)).toBe(true);
    const ship = genre('scifi').scenes[1]!.dynamics[0]!;
    expect(ship.speed).toBe(15);
    expect(ship.path.at(-1)![1]).toBeGreaterThan(40); // a lift-off climbs
  });

  it('the period era comes from the decade and place in the action', () => {
    expect(genre('period').style!.era).toBe('1890s Vienna');
  });

  it('a contemporary script stays contemporary (one stray keyword is not a genre)', () => {
    expect(heuristicStyle('They wait at the bus station. Rain falls.').genre).toBe('contemporary drama');
    expect(plan0().style!.genre).toBe('contemporary drama');
    expect(plan0().scenes.map((s) => s.look!.preset)).toEqual(['night-street', 'warm-interior', 'golden-hour']);
  });

  it('weather outside wins; interiors keep their own light', () => {
    const ext = parseHeading('EXT. HARBOUR - DAY');
    expect(heuristicLookSeed(ext, undefined, 'Thunder rolls. Rain lashes the quay.').preset).toBe('storm');
    expect(heuristicLookSeed(ext, undefined, 'Snow drifts over the bollards.').preset).toBe('snowfall');
    const int = parseHeading('INT. CABIN - NIGHT');
    expect(heuristicLookSeed(int, undefined, 'Snow presses at the window.').preset).toBe('warm-interior');
    expect(heuristicLookSeed(int, heuristicStyle('dragon sword kingdom'), 'A fire crackles.').preset).toBe(
      'candlelit',
    );
    // a free-text style from Claude reads back into its genre
    const folk = { genre: 'folk horror', era: '1970s', worldStyle: 'x', palette: 'y' };
    expect(heuristicLookSeed(int, folk, '').preset).toBe('horror');
  });
});
