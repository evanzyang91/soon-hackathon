import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { TriGrid } from '../../web/src/viewer/placement.ts';
import { RayGrid } from './calibrate-geometry.ts';
import {
  askVision,
  combineRuns,
  costOf,
  measureFromPixels,
  pixelRay,
  planCloseups,
  planViews,
  projectPoint,
  summarizeAnswer,
  type PlannedView,
  type VisionAnswer,
  type VisionRun,
} from './calibrate-vision.ts';

type P = [number, number, number];
const quad = (a: P, b: P, c: P, d: P) => [...a, ...b, ...c, ...a, ...c, ...d];
const floor = (r: number, y = 0) => quad([-r, y, -r], [-r, y, r], [r, y, r], [r, y, -r]);

const view = (o: Partial<PlannedView> = {}): PlannedView => ({
  yawDeg: 0,
  pitchDeg: -15,
  fovDeg: 80,
  camera: [0, 1.5, 0],
  figures: [],
  ...o,
});

const obj = (o: Partial<VisionAnswer['objects'][number]> = {}): VisionAnswer['objects'][number] => ({
  image: 1,
  object: 'door',
  dimension: 'height',
  typicalMeters: 2.04,
  comparedTo: 'A',
  apparentMeters: 2.0,
  correction: 1.02,
  basePx: { x: 0, y: 0 },
  topPx: { x: 0, y: 0 },
  sizeConfidence: 0.9,
  pixelConfidence: 0.8,
  confidence: 0.8,
  reasoning: '',
  ...o,
});
const answer = (objects: VisionAnswer['objects']): VisionAnswer => ({
  objects,
  floorContact: 'feet on the floor',
  overallCorrection: 1,
  confidence: 0.5,
  notes: '',
});
const run = (factor: number, n = 2, weight = 1): VisionRun => ({
  views: [0],
  factor,
  eyeballed: factor,
  objects: Array.from({ length: n }, () => ({ ...obj(), vote: factor, weight, source: 'measured' as const })),
  located: [],
  answer: answer([]),
  usage: { input: 3000, output: 1000, costUsd: 0.032 },
});

describe('pixel rays', () => {
  it('projectPoint and pixelRay are inverses for any camera', () => {
    for (const v of [view(), view({ yawDeg: 60, pitchDeg: -25, fovDeg: 100 }), view({ yawDeg: -120, pitchDeg: -8 })]) {
      for (const p of [[1, 0, -4], [-2, 1.2, -6], [0.5, 2.2, -3]] as P[]) {
        // rotate the test point into the view so it is in front of the camera
        const a = (v.yawDeg * Math.PI) / 180;
        const w: P = [p[0] * Math.cos(a) + p[2] * Math.sin(a), p[1], -p[0] * Math.sin(a) + p[2] * Math.cos(a)];
        const px = projectPoint(v, w)!;
        expect(px).not.toBeNull();
        const d = pixelRay(v, px[0], px[1]);
        const to = [w[0] - v.camera[0], w[1] - v.camera[1], w[2] - v.camera[2]];
        const l = Math.hypot(...to);
        d.forEach((c, i) => expect(c).toBeCloseTo(to[i]! / l, 6));
      }
    }
  });

  it('the image centre looks along the view direction, tilted by the pitch', () => {
    const d = pixelRay(view({ yawDeg: 90, pitchDeg: -15 }), 640, 360);
    expect(d[0]).toBeCloseTo(-Math.cos((15 * Math.PI) / 180), 6); // yaw +90 looks down -X
    expect(d[1]).toBeCloseTo(-Math.sin((15 * Math.PI) / 180), 6);
    expect(d[2]).toBeCloseTo(0, 6);
  });

  it('measures a vertical thing standing on the floor from its base and top pixels', () => {
    const cast = new RayGrid(Float32Array.from(floor(20, -0.2))).cast;
    const v = view({ yawDeg: 30, camera: [0, 1.5, 0] });
    const [fx, fz] = [-Math.sin(Math.PI / 6) * 5, -Math.cos(Math.PI / 6) * 5];
    const base = projectPoint(v, [fx, -0.2, fz])!;
    const top = projectPoint(v, [fx, -0.2 + 2.04, fz])!;
    const m = measureFromPixels(v, cast, { x: base[0], y: base[1] }, { x: top[0], y: top[1] });
    expect(m.ok).toBe(true);
    expect(m.height).toBeCloseTo(2.04, 3);
    expect(m.distance).toBeCloseTo(5, 3);
    // a top pixel well off the vertical through the base is refused
    const off = measureFromPixels(v, cast, { x: base[0], y: base[1] }, { x: top[0] + 400, y: top[1] });
    expect(off.ok).toBe(false);
    // a base pixel above the horizon hits nothing
    expect(measureFromPixels(v, cast, { x: 640, y: 5 }, { x: 640, y: 0 }).ok).toBe(false);
  });
});

describe('vision answers', () => {
  it('votes with measured heights when the pixels measured, else eyeballed at reduced weight', () => {
    const a = answer([
      obj({ object: 'door', typicalMeters: 2.04, apparentMeters: 2.2, correction: 2.04 / 2.2 }),
      obj({ object: 'counter', typicalMeters: 0.9, apparentMeters: 0.8, correction: 0.9 / 0.8, confidence: 0.6 }),
      obj({ object: 'ad panel', sizeConfidence: 0.1, pixelConfidence: 0.5 }),
      obj({ object: 'flipped', typicalMeters: 0.45, apparentMeters: 0.5, correction: 1.11 }),
      // pixels landed on something else: measured 0.28 m, eyeballed 0.61 m → eyeballed
      obj({ object: 'table', typicalMeters: 0.75, apparentMeters: 0.61, correction: 0.75 / 0.61, confidence: 0.5 }),
    ]);
    const s = summarizeAnswer(a, (o) =>
      o.object === 'door'
        ? { ok: true, height: 2.4, distance: 4, note: '' }
        : o.object === 'table'
          ? { ok: true, height: 0.28, distance: 1.4, note: '' }
          : o.object === 'ad panel'
            ? { ok: true, height: 2.0, distance: 3, note: '' }
            : undefined,
    );
    expect(s.objects.map((o) => [o.object, o.source])).toEqual([
      ['door', 'measured'],
      ['counter', 'eyeballed'],
      ['table', 'eyeballed'],
    ]);
    expect(s.objects[0]!.vote).toBeCloseTo(2.04 / 2.4, 6);
    expect(s.objects[0]!.weight).toBeCloseTo(0.72, 6);
    expect(s.objects[1]!.weight).toBeCloseTo(0.6 * 0.9 * 0.6, 6);
    expect(s.objects[2]!.vote).toBeCloseTo(0.75 / 0.61, 6);
    expect(s.factor).toBeCloseTo(2.04 / 2.4, 6); // the heaviest vote
    expect(Number.isNaN(summarizeAnswer(answer([])).factor)).toBe(true);
  });

  it('two runs must agree within 15 % and carry enough evidence', () => {
    const ok = combineRuns([run(0.9), run(0.95)]);
    expect(ok.available).toBe(true);
    expect(ok.agreeing).toEqual([0, 1]);
    expect(ok.factor).toBeCloseTo(0.9, 6); // weighted median of the pooled votes
    expect(ok.costUsd).toBeCloseTo(0.064, 6);
    expect(combineRuns([run(0.8), run(1.0)]).available).toBe(false);
    expect(combineRuns([run(0.9), run(Number.NaN)]).available).toBe(false);
    expect(combineRuns([run(Number.NaN), run(Number.NaN)]).note).toMatch(/no usable/);
    // agreeing but weak: three references of weight 0.2 are not enough
    const weak = combineRuns([run(0.85, 2, 0.2), run(0.9, 1, 0.2)]);
    expect(weak.agree).toBe(true);
    expect(weak.available).toBe(false);
    expect(weak.note).toMatch(/too little evidence/);
  });

  it('a close-up run can settle two overview runs that disagree', () => {
    const e = combineRuns([run(0.8, 2, 0.2), run(1.0, 2, 0.3), run(0.97, 1, 0.8)]);
    expect(e.agreeing).toEqual([1, 2]);
    expect(e.available).toBe(true);
    expect(e.factor).toBeCloseTo(0.97, 6);
    expect(e.note).toMatch(/overview 2 \+ close-up/);
  });

  it('prices usage at Opus 5.5 rates', () => {
    expect(costOf({ input_tokens: 1_000_000, output_tokens: 100_000 } as Anthropic.Beta.BetaUsage).costUsd).toBeCloseTo(6, 6);
  });

  it('askVision sends the images, parses the JSON and measures the pixels', async () => {
    const cast = new RayGrid(Float32Array.from(floor(20))).cast;
    const v = view();
    const base = projectPoint(v, [0, 0, -4])!;
    const top = projectPoint(v, [0, 1.8, -4])!; // a "door" that measures 1.8 m: world too small
    const sent: Anthropic.Beta.BetaContentBlockParam[][] = [];
    const reply = answer([
      obj({ basePx: { x: base[0], y: base[1] }, topPx: { x: top[0], y: top[1] }, apparentMeters: 1.85, correction: 2.04 / 1.85 }),
    ]);
    const r = await askVision([v], [{ jpeg: Buffer.from('jpg') }], [0], {
      cast,
      call: async (req) => {
        sent.push(req.content);
        return {
          content: [{ type: 'text', text: JSON.stringify(reply) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 2500, output_tokens: 800 },
        } as unknown as Anthropic.Beta.BetaMessage;
      },
    });
    expect(sent[0]!.filter((b) => b.type === 'image')).toHaveLength(1);
    expect(r.objects[0]!.source).toBe('measured');
    expect(r.objects[0]!.measured!.height).toBeCloseTo(1.8, 2);
    expect(r.factor).toBeCloseTo(2.04 / 1.8, 2);
    expect(r.eyeballed).toBeCloseTo(2.04 / 1.85, 6);
    expect(r.usage.costUsd).toBeCloseTo(2500 * 4e-6 + 800 * 20e-6, 9);
  });
});

describe('view planning', () => {
  it('puts up to three visible, separated mannequins per view on open ground', () => {
    const tris = Float32Array.from(floor(30));
    const views = planViews({ grid: new TriGrid(tris), cast: new RayGrid(tris).cast, cameraY: 1.5 });
    expect(views.map((v) => v.yawDeg)).toEqual([0, 60, -60, 180]);
    for (const v of views) {
      expect(v.figures.map((f) => f.name)).toEqual(['A', 'B', 'C']);
      expect(v.figures[0]!.distance).toBeCloseTo(2.5, 0);
      for (const f of v.figures) {
        for (const y of [0, 1.7]) {
          const px = projectPoint(v, [f.x, y, f.z])!;
          expect(px[0]).toBeGreaterThan(0);
          expect(px[0]).toBeLessThan(1280);
          expect(px[1]).toBeGreaterThan(0);
          expect(px[1]).toBeLessThan(720);
        }
      }
      const ang = v.figures.map((f) => Math.atan2(f.x, f.z));
      for (let i = 0; i < ang.length; i++)
        for (let j = i + 1; j < ang.length; j++)
          expect(Math.abs(ang[i]! - ang[j]!)).toBeGreaterThan((8 * Math.PI) / 180);
    }
  });

  it('skips views that face a wall', () => {
    const wall = quad([-5, 0, -1], [5, 0, -1], [5, 3, -1], [-5, 3, -1]);
    const tris = Float32Array.from([...floor(30), ...wall]);
    const views = planViews({ grid: new TriGrid(tris), cast: new RayGrid(tris).cast, cameraY: 1.5 });
    expect(views.map((v) => v.yawDeg)).not.toContain(0);
  });

  it('plans a close-up of a located standard object with the mannequin beside it, both in frame', () => {
    const tris = Float32Array.from(floor(30));
    const g = { grid: new TriGrid(tris), cast: new RayGrid(tris).cast, cameraY: 1.5 };
    const located = [
      { object: 'ad panel', sizeConfidence: 0.3, pixelConfidence: 0.9, base: [3, 0, -9] as P },
      { object: 'green door', sizeConfidence: 0.9, pixelConfidence: 0.6, base: [-4, 0, -8] as P },
      { object: 'same green door', sizeConfidence: 0.9, pixelConfidence: 0.5, base: [-4.5, 0, -8.3] as P },
    ];
    const views = planCloseups(g, located);
    expect(views.map((x) => x.closeupOf)).toEqual(['green door']);
    const v = views[0]!;
    expect(Math.hypot(v.camera[0] + 4, v.camera[2] + 8)).toBeCloseTo(3, 6);
    expect(v.camera[1]).toBeCloseTo(1.5, 6);
    const f = v.figures[0]!;
    expect(Math.hypot(f.x + 4, f.z + 8)).toBeCloseTo(0.8, 6);
    for (const p of [[-4, 0, -8], [f.x, 0, f.z], [f.x, 1.7, f.z]] as P[]) {
      const px = projectPoint(v, p)!;
      expect(px[0]).toBeGreaterThan(0);
      expect(px[0]).toBeLessThan(1280);
      expect(px[1]).toBeGreaterThan(0);
      expect(px[1]).toBeLessThan(720);
    }
  });
});
