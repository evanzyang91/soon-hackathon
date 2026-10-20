import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { emptySceneEdits, SceneEdit, type SceneEdits } from '../../../shared/look.ts';
import { appendOps } from '../../../web/src/viewer/edits/model.ts';
import { emptyDraft, draftToPlan, regenKeepsDrops, type Draft } from './draft.ts';
import { busStopContext } from './fixture.ts';
import { cameraAxes, mockDraft, objectPhrase, parseDistance } from './mock.ts';
import { describeScene, planEdit, type PlannerCall } from './planner.ts';
import { jpegSize, type LocateCall } from './vision.ts';

const plan = (prompt: string, o: Parameters<typeof planEdit>[0] extends infer P ? Partial<P> : never = {}) =>
  planEdit({ prompt, scene: busStopContext(), mock: true, idPrefix: 't', ...o });

const msg = (json: unknown, usage = { input_tokens: 1000, output_tokens: 200 }): Anthropic.Beta.BetaMessage =>
  ({
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify(json), citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage,
  }) as unknown as Anthropic.Beta.BetaMessage;

// a 1×1 baseline JPEG (SOF0 says 640×360)
const JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffc0001108016802800301220002110103110100ffd9',
  'hex',
);

describe('mock planner: the eight bus-stop prompts', () => {
  it('ad panel blue → splat-region recolour that needs a target (nothing selected)', async () => {
    const r = await plan("make the bus shelter's ad panel blue");
    expect(r.plan.scope).toBe('splat-region');
    const op = r.plan.ops[0]!;
    expect(op.kind).toBe('splat-region');
    if (op.kind !== 'splat-region') return;
    expect(op.color).toMatchObject({ mode: 'hue', value: '#2e6bd6' });
    expect(op.label).toBe("bus shelter's ad panel");
    expect(r.plan.needsTarget).toEqual([{ opId: op.id, label: op.label }]);
  });

  it('move Leo a metre closer to Maya → transform by 1 m along the line, facing her', async () => {
    const r = await plan('move Leo a metre closer to Maya');
    expect(r.plan.scope).toBe('transform');
    const op = r.plan.ops[0]!;
    if (op.kind !== 'transform') throw new Error(op.kind);
    expect(op.target).toEqual({ type: 'actor', id: 'leo' });
    const [x, , z] = op.position!;
    const before = Math.hypot(0.8 - -0.7, -2.6 - -2.8);
    const after = Math.hypot(x - -0.7, z - -2.8);
    expect(before - after).toBeCloseTo(1, 2);
    // facing Maya: forward (-sin yaw, -cos yaw) points at her
    const fwd = [-Math.sin(op.yaw!), -Math.cos(op.yaw!)];
    const to = [-0.7 - x, -2.8 - z];
    const len = Math.hypot(to[0]!, to[1]!);
    expect(fwd[0]! * (to[0]! / len) + fwd[1]! * (to[1]! / len)).toBeGreaterThan(0.99);
  });

  it('warmer and more contrast → one look patch', async () => {
    const r = await plan('warmer and more contrast');
    expect(r.plan.scope).toBe('look');
    expect(r.plan.ops).toHaveLength(1);
    const look = appendOps(emptySceneEdits(), r.plan.ops, { prompt: 'p', plan: r.plan }).look;
    expect(look.temperature).toBeCloseTo(0.3);
    expect(look.contrast).toBeCloseTo(1.25);
    expect(look.exposure).toBe(0);
  });

  it('add a bicycle leaning on the shelter → parked prop', async () => {
    const r = await plan('add a bicycle leaning on the shelter');
    expect(r.plan.scope).toBe('prop');
    const op = r.plan.ops[0]!;
    if (op.kind !== 'prop-add') throw new Error(op.kind);
    expect(op.element.kind).toBe('bicycle');
    expect(op.element.label).toMatch(/leaning on the shelter/);
    const [a, b] = op.element.path;
    expect(Math.hypot(b![0] - a![0], b![2] - a![2])).toBeLessThan(0.1);
  });

  it('a click selection places the bicycle where the director pointed', async () => {
    const r = await plan('add a bicycle leaning on the shelter', { selection: { point: [-2.1, 0.02, -4.4] } });
    const op = r.plan.ops[0]!;
    if (op.kind !== 'prop-add') throw new Error(op.kind);
    expect(op.element.path[0]).toEqual([-2.1, 0.02, -4.4]);
  });

  it('make it snow → world-regen via pano-inpaint (panorama available)', async () => {
    const r = await plan('make it snow');
    expect(r.plan.scope).toBe('world-regen');
    expect(r.plan.ops).toEqual([]);
    expect(r.plan.regen).toMatchObject({ method: 'pano-inpaint', estimatedMinutes: 5, estimatedCredits: 1580 });
    expect(r.plan.regen!.prompt).toMatch(/snow/i);
    expect(r.plan.regen!.keeps).toEqual(expect.arrayContaining(['actors', 'look', 'props']));
  });

  it('make it snow without a panorama → text regen', async () => {
    const r = await planEdit({ prompt: 'make it snow', scene: busStopContext(undefined, { pano: false }), mock: true });
    expect(r.plan.regen?.method).toBe('text');
    expect(r.plan.regen!.prompt).toMatch(/bus stop.*snow/is);
  });

  it('the thing on the left → clarify', async () => {
    const r = await plan('the thing on the left');
    expect(r.plan.scope).toBe('clarify');
    expect(r.plan.ops).toEqual([]);
    expect(r.plan.question).toBeTruthy();
  });

  it('remove the bus → prop-remove of the city bus', async () => {
    const r = await plan('remove the bus');
    expect(r.plan.scope).toBe('prop');
    expect(r.plan.ops[0]).toMatchObject({ kind: 'prop-remove', elementId: 's1-bus-2' });
  });

  it('remove the lamp → region hide (not a prop)', async () => {
    const r = await plan('remove the lamp');
    expect(r.plan.scope).toBe('splat-region');
    expect(r.plan.ops[0]).toMatchObject({ kind: 'splat-region', opacity: 0, label: 'lamp' });
  });

  it('make the car bigger → prop transform scale', async () => {
    const r = await plan('make the car bigger');
    expect(r.plan.scope).toBe('transform');
    expect(r.plan.ops[0]).toMatchObject({ kind: 'transform', target: { type: 'prop', id: 's1-car-1' }, scale: 1.3 });
  });

  it('night mood → look (never a regen); stormy sky → regen', async () => {
    expect((await plan('give it a night mood')).plan.scope).toBe('look');
    expect((await plan('make the sky stormy')).plan.scope).toBe('world-regen');
    expect((await plan('tint the sky orange')).plan.scope).toBe('look');
  });

  it('a selected region is used directly: the recolour applies without needsTarget', async () => {
    const region = { center: [-2, 1.2, -5] as [number, number, number], size: [0.5, 0.5, 0.5] as [number, number, number], shape: 'sphere' as const };
    const r = await plan('make it red', { selection: { region } });
    expect(r.plan.scope).toBe('splat-region');
    expect(r.plan.needsTarget).toEqual([]);
    expect(r.plan.ops[0]).toMatchObject({ center: region.center, size: region.size, color: { mode: 'hue' } });
  });
});

describe('mock planner helpers', () => {
  it('parses distances', () => {
    expect(parseDistance('a metre closer')).toBe(1);
    expect(parseDistance('2 m left')).toBe(2);
    expect(parseDistance('30 cm')).toBe(0.3);
    expect(parseDistance('half a meter')).toBe(0.5);
    expect(parseDistance('closer', 0.7)).toBe(0.7);
  });
  it('object phrases', () => {
    expect(objectPhrase("make the bus shelter's roof red", 'red')).toBe("bus shelter's roof");
    expect(objectPhrase('remove the lamp')).toBe('lamp');
    expect(objectPhrase('shift the bench left')).toBe('bench');
  });
  it('camera axes from a quaternion', () => {
    expect(cameraAxes()).toEqual({ forward: [0, -1], right: [1, 0] });
    // yaw 90° left (looking down -X)
    const s = Math.SQRT1_2;
    const a = cameraAxes([0, s, 0, s]);
    expect(a.forward[0]).toBeCloseTo(-1);
    expect(a.right[1]).toBeCloseTo(-1);
  });
  it('drafts are schema-valid', () => {
    const d = mockDraft('warmer', busStopContext());
    expect(d.scope).toBe('look');
  });
});

describe('scope rules (draftToPlan)', () => {
  const scene = busStopContext();
  const fin = (d: Draft, selection?: Parameters<typeof draftToPlan>[1]['selection']) =>
    draftToPlan(d, { prompt: 'p', scene, selection, idPrefix: 'x' });

  it('clarify carries no ops even if the draft filled some', () => {
    const d = emptyDraft('clarify');
    d.look.set.push({ param: 'contrast', value: 1.4 });
    const { plan } = fin(d);
    expect(plan).toMatchObject({ scope: 'clarify', ops: [] });
    expect(plan.question).toBeTruthy();
  });

  it('world-regen is never applied: no ops, cost + keeps/drops; drops counts region edits', () => {
    const edits: SceneEdits = {
      ...emptySceneEdits(),
      edits: [1, 2].map((i) =>
        SceneEdit.parse({ kind: 'splat-region', id: `r${i}`, label: 'x', shape: 'sphere', center: [0, 0, 0], size: [1, 1, 1] }),
      ),
    };
    const d = emptyDraft('world-regen');
    d.regen = { environmental: true, imageEdit: 'add a stormy sky', worldPrompt: 'a bus stop under a stormy sky' };
    d.look.set.push({ param: 'contrast', value: 1.4 });
    const { plan } = draftToPlan(d, { prompt: 'p', scene: busStopContext(edits) });
    expect(plan.ops).toEqual([]);
    expect(plan.regen).toMatchObject({
      method: 'pano-inpaint',
      prompt: 'add a stormy sky',
      estimatedMinutes: 5,
      estimatedCredits: 1580,
      drops: ['2 region edits'],
    });
    expect(regenKeepsDrops(busStopContext()).drops).toEqual([]);
  });

  it('non-environmental regen uses the text prompt', () => {
    const d = emptyDraft('world-regen');
    d.regen = { environmental: false, imageEdit: 'x', worldPrompt: 'a 1950s diner' };
    expect(fin(d).plan.regen).toMatchObject({ method: 'text', prompt: 'a 1950s diner' });
  });

  it('unknown targets are dropped; nothing left → clarify', () => {
    const d = emptyDraft('transform');
    d.transforms.push({
      targetType: 'actor',
      targetId: 'bob',
      move: 'by',
      point: { x: 1, y: 0, z: 0 },
      turn: 'none',
      yawDeg: 0,
      facePoint: { x: 0, y: 0, z: 0 },
      scale: 1,
    });
    const r = fin(d);
    expect(r.plan.scope).toBe('clarify');
    expect(r.notes.join()).toMatch(/bob/);
  });

  it('regions are never guessed: no selection → needsTarget with a placeholder', () => {
    const d = emptyDraft('splat-region');
    d.regions.push({ label: 'ad panel', colorMode: 'hue', colorHex: '#00f', strength: 1, hide: false, moveBy: { x: 0, y: 0, z: 0 }, scale: 1 });
    const { plan } = fin(d);
    expect(plan.needsTarget).toHaveLength(1);
    expect(plan.ops[0]).toMatchObject({ color: { value: '#0000ff' } });
  });

  it('the scope follows the surviving ops (most specific wins)', () => {
    const d = emptyDraft('look');
    d.look.set.push({ param: 'exposure', value: -0.5 });
    d.props.push({ action: 'remove', elementId: 's1-car-1', kind: 'car', label: '', path: [], moving: false, speed: 0, scale: 1 });
    const r = fin(d);
    expect(r.plan.scope).toBe('prop');
    expect(r.plan.ops.map((o) => o.kind)).toEqual(['look', 'prop-remove']);
  });

  it('look values are clamped and default-valued targets survive the parse', () => {
    const d = emptyDraft('look');
    d.look.set.push({ param: 'contrast', value: 9 }, { param: 'exposure', value: 0 });
    const { plan } = fin(d);
    const base = { ...emptySceneEdits(), look: { ...emptySceneEdits().look, exposure: -1 } };
    const look = appendOps(base, plan.ops, { prompt: 'p', plan }).look;
    expect(look.contrast).toBe(2);
    expect(Math.abs(look.exposure)).toBeLessThan(0.01); // reset to ~0 even though 0 is the default
  });

  it('actors stay on the floor', () => {
    const d = emptyDraft('transform');
    d.transforms.push({ targetType: 'actor', targetId: 'MAYA', move: 'to', point: { x: 1, y: -0.4, z: -3 }, turn: 'none', yawDeg: 0, facePoint: { x: 0, y: 0, z: 0 }, scale: 1 });
    expect(fin(d).plan.ops[0]).toMatchObject({ target: { id: 'maya' }, position: [1, 0, -3] });
  });
});

describe('real planner path (injected Claude call)', () => {
  it('sends the scene + prompt with the Draft schema and applies the rules to the answer', async () => {
    let seen: Parameters<PlannerCall>[0] | undefined;
    const d = emptyDraft('splat-region');
    d.summary = 'Recolour the shelter roof red.';
    d.regions.push({ label: 'bus shelter roof', colorMode: 'hue', colorHex: '#d0312d', strength: 1, hide: false, moveBy: { x: 0, y: 0, z: 0 }, scale: 1 });
    const call: PlannerCall = async (req) => {
      seen = req;
      return msg(d);
    };
    let located: Parameters<LocateCall>[0] | undefined;
    const locateCall: LocateCall = async (req) => {
      located = req;
      return msg({ objects: [{ label: 'bus shelter roof', found: true, x0: 64, y0: 36, x1: 320, y1: 108, confidence: 0.9, note: 'roof' }] }, { input_tokens: 1500, output_tokens: 100 });
    };
    const view = { image: JPEG.toString('base64'), position: [0, 1.6, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], fovDeg: 60, aspect: 16 / 9 };
    const r = await planEdit({ prompt: "make the bus shelter's roof red", scene: busStopContext(), mock: false, call, locateCall, view, idPrefix: 'c' });
    expect(seen!.content).toMatch(/Director's prompt: """make the bus shelter's roof red"""/);
    expect(seen!.content).toMatch(/leo "LEO" at \(0.8, 0, -2.6\)/);
    expect(seen!.system).toMatch(/cheapest scope that satisfies the prompt/);
    expect(JSON.stringify(seen!.schema)).toMatch(/"regions"/);
    expect(r.source).toBe('claude');
    expect(r.plan.needsTarget).toEqual([{ opId: 'region-c-1', label: 'bus shelter roof' }]);
    expect(located!.content[1]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(located!.content[1])).toMatch(/640×360/);
    expect(r.targets).toEqual([{ opId: 'region-c-1', label: 'bus shelter roof', box: { x: 0.1, y: 0.1, w: 0.4, h: 0.2 }, confidence: 0.9 }]);
    expect(r.usage.input).toBe(2500);
    expect(r.usage.costUsd).toBeGreaterThan(0);
  });

  it('a refusal is an error; an invalid answer throws', async () => {
    const refusal = { ...msg({}), stop_reason: 'refusal' } as Anthropic.Beta.BetaMessage;
    await expect(planEdit({ prompt: 'x', scene: busStopContext(), mock: false, call: async () => refusal })).rejects.toThrow(/declined/);
    await expect(planEdit({ prompt: 'x', scene: busStopContext(), mock: false, call: async () => msg({ scope: 'nope' }) })).rejects.toThrow();
  });
});

describe('vision + scene text', () => {
  it('reads JPEG dimensions', () => {
    expect(jpegSize(JPEG)).toEqual({ width: 640, height: 360 });
    expect(jpegSize(Buffer.from('nope'))).toBeNull();
  });
  it('describes the scene for the planner', () => {
    const t = describeScene(busStopContext());
    expect(t).toMatch(/panorama is available/);
    expect(t).toMatch(/s1-bus-2 bus "city bus" moving/);
    expect(t).toMatch(/Nothing is selected/);
  });
});
