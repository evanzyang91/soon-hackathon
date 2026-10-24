import { describe, expect, it } from 'vitest';
import { defaultLook, emptySceneEdits, SceneEdit } from '@shared/look';
import type { Vec3 } from '@shared/schema';
import {
  autoRadius,
  boxRegionSize,
  appendOps,
  beforeOf,
  removeOp,
  setOpEnabled,
  effectiveProps,
  effectiveTransforms,
  encodeLookPatch,
  evaluateSpec,
  hueMultiplier,
  isParked,
  luma,
  mergeLook,
  patchEntries,
  percentile,
  regionSdf,
  regionSpecs,
  scaleFieldSdfs,
  sdfDistance,
  softEdgeMeters,
  type RegionEdit,
} from './model';

const region = (o: Partial<RegionEdit> = {}): RegionEdit =>
  SceneEdit.parse({ kind: 'splat-region', id: 'r', label: 'x', shape: 'sphere', center: [1, 1, -3], size: [0.5, 0.5, 0.5], ...o }) as RegionEdit;
const look = (patch: object, enabled = true) => SceneEdit.parse({ kind: 'look', id: Math.random().toString(36), patch, enabled });

describe('look patches', () => {
  it('a parsed patch is default-filled; only the set values count', () => {
    const e = look({ contrast: 1.2, fog: { density: 0.3 } });
    if (e.kind !== 'look') throw new Error();
    expect(e.patch.exposure).toBe(0); // zod filled it
    expect(patchEntries(e.patch)).toEqual({ contrast: 1.2, fog: { density: 0.3 } });
  });

  it('look ops are baked into look; switching one off restores what it replaced, on merges it again', () => {
    const base = { ...emptySceneEdits(), look: { ...defaultLook(), exposure: -0.5, contrast: 1.4 } };
    const warm = look(encodeLookPatch({ temperature: 0.3, contrast: 1.2 }));
    const plan = { scope: 'look' as const, summary: 's', ops: [warm], needsTarget: [] };
    const doc = appendOps(base, [warm], { prompt: 'warmer', plan, at: 't' });
    expect(doc.look).toMatchObject({ exposure: -0.5, contrast: 1.2, temperature: 0.3 });
    expect(doc.history[0]!.appliedOpIds).toEqual([warm.id]);
    expect(beforeOf(doc, warm.id)).toMatchObject({ contrast: 1.4 });
    // the director changes exposure afterwards; switching the op off keeps that
    const later = { ...doc, look: { ...doc.look, exposure: 0.7 } };
    const off = setOpEnabled(later, warm.id, false);
    expect(off.look.contrast).toBe(1.4);
    expect(Math.abs(off.look.temperature)).toBeLessThan(0.002);
    expect(off.look.exposure).toBe(0.7);
    expect(off.edits[0]!.enabled).toBe(false);
    expect(setOpEnabled(off, warm.id, true).look).toMatchObject({ contrast: 1.2, temperature: 0.3, exposure: 0.7 });
    const gone = removeOp(later, warm.id);
    expect(gone.edits).toEqual([]);
    expect(gone.look.contrast).toBe(1.4);
  });

  it('a light added by a look op is removed when the op is switched off', () => {
    const key = { id: 'k', name: 'Key', kind: 'spot' as const, position: [1, 2, 3] as Vec3, color: '#fff', intensity: 2, radius: 6, coneDeg: 40, enabled: true };
    const op = look({ lights: [key] });
    const doc = appendOps(emptySceneEdits(), [op], { prompt: 'add a key light', plan: { scope: 'look', summary: '', ops: [op], needsTarget: [] } });
    expect(doc.look.lights).toHaveLength(1);
    expect(setOpEnabled(doc, op.id, false).look.lights).toEqual([]);
  });

  it('nested groups merge per field; lights upsert by id', () => {
    const base = { ...defaultLook(), fog: { color: '#112233', density: 0.1 } };
    const key = { id: 'k', name: 'Key', kind: 'spot' as const, position: [1, 2, 3] as Vec3, color: '#fff', intensity: 2, radius: 6, coneDeg: 40, enabled: true };
    const merged = mergeLook(base, { fog: { color: '#9aa3ad', density: 0.5 }, lights: [key] });
    expect(merged.fog).toEqual({ color: '#112233', density: 0.5 }); // the default colour did not count
    expect(mergeLook(merged, { lights: [{ ...key, intensity: 5 }] }).lights).toEqual([{ ...key, intensity: 5 }]);
  });

  it('encodeLookPatch keeps a reset-to-default value alive through the parse', () => {
    const e = look(encodeLookPatch({ exposure: 0, contrast: 1 }));
    if (e.kind !== 'look') throw new Error();
    const l = mergeLook({ ...defaultLook(), exposure: -1, contrast: 1.6 }, e.patch);
    expect(Math.abs(l.exposure)).toBeLessThan(0.002);
    expect(Math.abs(l.contrast - 1)).toBeLessThan(0.002);
  });
});

describe('transforms and props', () => {
  it('latest enabled field per target wins', () => {
    const t = (o: object, enabled = true) => SceneEdit.parse({ kind: 'transform', id: 'm', target: { type: 'actor', id: 'leo' }, enabled, ...o });
    const m = effectiveTransforms([t({ position: [1, 0, -2], yaw: 1 }), t({ yaw: 2 }), t({ scale: 3 }, false)]);
    expect(m.get('actor:leo')).toEqual({ position: [1, 0, -2], yaw: 2 });
  });

  it('prop adds minus removes; parked props', () => {
    const el = { id: 'p1', kind: 'bicycle', label: 'bike', path: [[0, 0, -3], [0, 0, -3.05]], speed: 0.01 };
    const edits = [
      SceneEdit.parse({ kind: 'prop-add', id: 'a', element: el }),
      SceneEdit.parse({ kind: 'prop-remove', id: 'b', elementId: 's1-bus-2' }),
    ];
    const p = effectiveProps(edits);
    expect(p.added.map((a) => a.id)).toEqual(['p1']);
    expect([...p.removed]).toEqual(['s1-bus-2']);
    expect(isParked(p.added[0]!)).toBe(true);
    expect(effectiveProps([...edits, SceneEdit.parse({ kind: 'prop-remove', id: 'c', elementId: 'p1' })]).added).toEqual([]);
  });
});

describe('colour', () => {
  it('hue multiply keeps a neutral splat at its luminance and takes the target hue', () => {
    const m = hueMultiplier('#d0312d');
    const grey: [number, number, number] = [0.4, 0.4, 0.4];
    const out = grey.map((c, i) => c * m[i]!) as [number, number, number];
    expect(luma(out)).toBeCloseTo(0.4, 2);
    expect(out[0]).toBeGreaterThan(out[1]! * 3);
    expect(hueMultiplier('#d0312d', 0)).toEqual([1, 1, 1]);
    expect(Math.max(...hueMultiplier('#0000ff'))).toBeLessThanOrEqual(4);
  });
});

describe('regions → Spark SDFs (CPU reference of the shader)', () => {
  it('the soft edge lies inside the region: nothing outside it changes, the core changes fully', () => {
    const r = region({ color: { mode: 'multiply', value: '#ff0000', strength: 1 }, softEdge: 0.3 });
    const [spec] = regionSpecs(r);
    expect(spec!.softEdge).toBeCloseTo(0.15);
    for (const d of [0.5, 0.51, 0.7, 2])
      expect(evaluateSpec(spec!, [1 + d, 1, -3]).modulate).toBe(0);
    expect(evaluateSpec(spec!, [1, 1, -3]).modulate).toBe(1);
    expect(evaluateSpec(spec!, [1 + 0.5 - 0.15, 1, -3]).modulate).toBeCloseTo(1, 5);
    expect(evaluateSpec(spec!, [1 + 0.5 - 0.075, 1, -3]).modulate).toBeCloseTo(0.5, 5);
  });

  it('boxes honour yaw', () => {
    const r = region({ shape: 'box', size: [1, 0.2, 0.2], yaw: Math.PI / 2, softEdge: 0 });
    const s = regionSdf(r);
    // rotated 90°: the long axis now runs along world Z
    expect(sdfDistance(s, [1, 1, -3.9])).toBeLessThan(0);
    expect(sdfDistance(s, [1.9, 1, -3])).toBeGreaterThan(0);
  });

  it('colour / hide / move / scale map to the right blend modes', () => {
    const specs = regionSpecs(region({ color: { mode: 'set', value: '#00ff00', strength: 1 }, opacity: 0.5, displace: [0.3, 0, 0], scale: 1.2 }));
    expect(specs.map((s) => [s.role, s.blend])).toEqual([
      ['color', 'set_rgb'],
      ['scale', 'multiply'],
      ['move', 'multiply'],
    ]);
    expect(specs[0]).toMatchObject({ rgb: [0, 1, 0], opacity: 0.5 });
    expect(specs[2]!.sdfs[0]!.displace).toEqual([0.3, 0, 0]);
    expect(regionSpecs(region({ opacity: 0 }))[0]).toMatchObject({ blend: 'multiply', rgb: [1, 1, 1], opacity: 0 });
    expect(regionSpecs(region())).toEqual([]);
  });

  it('the scale field approximates (s − 1)(p − c) inside the region', () => {
    const r = region({ shape: 'box', size: [0.6, 0.6, 0.6], softEdge: 0 });
    const s = 1.3;
    const { sdfs, smooth } = scaleFieldSdfs(r, s);
    expect(sdfs).toHaveLength(125);
    const spec = { role: 'scale' as const, blend: 'multiply' as const, rgb: [1, 1, 1] as [number, number, number], opacity: 1, softEdge: 0, sdfSmooth: smooth, sdfs };
    let worst = 0;
    for (const p of [
      [0.2, 0.1, -0.15],
      [-0.3, 0.25, 0.1],
      [0.05, -0.4, 0.3],
      [0.35, 0.35, -0.35],
    ] as Vec3[]) {
      const at: Vec3 = [r.center[0] + p[0], r.center[1] + p[1], r.center[2] + p[2]];
      const { modulate, displace } = evaluateSpec(spec, at);
      expect(modulate).toBe(1);
      const want = p.map((v) => (s - 1) * v);
      worst = Math.max(worst, ...displace.map((v, i) => Math.abs(v - want[i]!)));
    }
    // ≤ 3 cm off the exact linear field on a 1.2 m object grown by 30 % (36 cm at the corners)
    expect(worst).toBeLessThan(0.03);
  });

  it('sphere regions keep only the cells inside the sphere', () => {
    expect(scaleFieldSdfs(region(), 1.2).sdfs.length).toBeLessThan(125);
    expect(softEdgeMeters(region({ softEdge: 0.2 }))).toBeCloseTo(0.1);
  });
});

describe('region sizing', () => {
  it('percentile interpolates', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.8)).toBeCloseTo(4.2);
    expect(percentile([], 0.5)).toBeNaN();
  });

  it('auto radius: 80th percentile of distances, clamped 0.15–1.2 m', () => {
    // a small isolated object: splats within ~0.2 m of the hit
    const small = Array.from({ length: 100 }, (_, i) => (i / 100) * 0.2);
    expect(autoRadius(small)).toBeCloseTo(0.16, 2);
    // a wall: splats spread across the whole sampling window
    const wall = Array.from({ length: 100 }, (_, i) => Math.sqrt(i / 100) * 0.85);
    expect(autoRadius(wall)).toBeCloseTo(0.76, 1);
    expect(autoRadius([0.01, 0.02])).toBe(0.15);
    expect(autoRadius([5, 6, 7])).toBe(1.2);
    expect(autoRadius([])).toBe(0.3);
  });

  it('box regions from a pixel box: angular extent × hit distance', () => {
    // a box a quarter of the frame wide at 4 m with a 60° vertical fov, 16:9
    const r = boxRegionSize({ x: 0.4, y: 0.4, w: 0.25, h: 0.1 }, { fovDeg: 60, aspect: 16 / 9 }, 4);
    const tv = Math.tan(Math.PI / 6);
    expect(r.halfExtents[0]).toBeCloseTo(0.25 * 2 * tv * (16 / 9) * 4 / 2, 5);
    expect(r.halfExtents[1]).toBeCloseTo(0.1 * 2 * tv * 4 / 2, 5);
    expect(r.radius).toBeCloseTo(r.halfExtents[0], 5);
    expect(boxRegionSize({ x: 0, y: 0, w: 0.001, h: 0.001 }, { fovDeg: 60, aspect: 1 }, 1).radius).toBe(0.15);
  });
});

