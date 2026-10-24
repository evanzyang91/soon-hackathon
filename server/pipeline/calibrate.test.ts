import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPECTED, type Measurement, type MeasurementKind } from './calibrate-geometry.ts';
import {
  calibrateWorld,
  decide,
  evidenceText,
  formatReport,
  geometricEstimate,
  previousCalibration,
  shortName,
  writeCalibration,
  type CalibrationReport,
} from './calibrate.ts';
import { encodeGlb } from './glb.ts';

const m = (kind: MeasurementKind, measured: number, weight = 0.8): Measurement => {
  const e = EXPECTED[kind];
  return { kind, measured, expected: { lo: e.lo, typ: e.typ, hi: e.hi }, implied: e.typ / measured, weight, samples: 50 };
};
const g = (factor: number, consistent = 3) => ({ available: true, factor, consistent });
const v = (factor: number) => ({ available: true, factor });

describe('geometric estimate', () => {
  it('weighted median of the references; the camera band and weak ones never vote', () => {
    const e = geometricEstimate([
      m('ceiling', 2.6 / 0.8, 0.7), // implies 0.8
      m('counter', 0.91 / 0.8, 0.9), // 0.8
      m('table', 0.75 / 0.82, 0.5), // 0.82
      m('door', 2.04, 0.2), // weak: ignored
      m('camera', 3.2, 1), // band: ignored
    ]);
    expect(e.available).toBe(true);
    expect(e.factor).toBeCloseTo(0.8, 6);
    expect(e.used.map((x) => x.kind)).toEqual(['ceiling', 'counter', 'table']);
    expect(e.consistent).toBe(3);
  });

  it('is unavailable with too little evidence', () => {
    expect(geometricEstimate([m('canopy', 3, 0.2), m('camera', 1.6, 0.15)]).available).toBe(false);
    expect(geometricEstimate([m('counter', 0.9, 0.45)]).available).toBe(false);
    expect(geometricEstimate([m('counter', 0.9, 0.7)]).available).toBe(true);
  });
});

describe('decision rules', () => {
  it('both sources within 10 %: the geometric median, high confidence', () => {
    const d = decide(g(0.8), v(0.85));
    expect(d).toMatchObject({ applied: true, factor: 0.8, confidence: 'high', method: 'geometric+vision' });
  });

  it('both sources more than 25 % apart: nothing applied, low confidence, says why', () => {
    const d = decide(g(0.7), v(1.0));
    expect(d).toMatchObject({ applied: false, factor: 1, confidence: 'low' });
    expect(d.reason).toMatch(/disagree by 30%/);
  });

  it('10–25 % apart: geometric (medium) only with ≥ 3 consistent references', () => {
    expect(decide(g(0.8, 3), v(0.95))).toMatchObject({ applied: true, factor: 0.8, confidence: 'medium' });
    expect(decide(g(0.8, 2), v(0.95))).toMatchObject({ applied: false, factor: 1, confidence: 'low' });
  });

  it('one source: vision → medium, geometric → high with ≥ 3 consistent references else medium', () => {
    expect(decide(null, v(1.3))).toMatchObject({ applied: true, factor: 1.3, confidence: 'medium', method: 'vision' });
    expect(decide(g(1.3, 4), null)).toMatchObject({ applied: true, confidence: 'high', method: 'geometric' });
    expect(decide(g(1.3, 1), { available: false, factor: 2 })).toMatchObject({ confidence: 'medium' });
  });

  it('a correction under 5 % is recorded but not applied', () => {
    const d = decide(g(0.969, 4), null);
    expect(d).toMatchObject({ applied: false, factor: 1, confidence: 'high' });
    expect(d.candidate).toBeCloseTo(0.969, 6);
    expect(d.reason).toMatch(/3% < 5%/);
  });

  it('never applies a factor outside [0.5, 2]', () => {
    expect(decide(null, v(2.4))).toMatchObject({ applied: false, factor: 1, confidence: 'low' });
    expect(decide(g(0.4, 5), v(0.42))).toMatchObject({ applied: false, factor: 1, confidence: 'low' });
  });

  it('no source: Marble kept with low confidence', () => {
    expect(decide(null, null)).toMatchObject({ applied: false, factor: 1, confidence: 'low', method: 'none' });
    expect(decide({ available: false, factor: NaN, consistent: 0 }, { available: false, factor: 1.4 })).toMatchObject({
      method: 'none',
    });
  });

  it('evidence leads with the strongest reference at the calibrated scale (what the HUD shows)', () => {
    const ms = [m('counter', 0.91 / 0.8, 0.9), m('ceiling', 2.6 / 0.8, 0.7)];
    const e = geometricEstimate(ms);
    const text = evidenceText(e, ms, null, decide(e, null));
    expect(text.split(' · ')[0]).toBe('counter 0.91 m');
    expect(text).toMatch(/ceiling 3\.25 m \(×0\.80\)/);
  });
});

describe('object names', () => {
  it('shortens Claude’s object descriptions for labels', () => {
    expect(shortName('white interior door directly behind mannequin A')).toBe('white interior door');
    expect(shortName('metal street bench to the right of mannequin A')).toBe('metal street bench');
    expect(shortName('brick rooftop parapet wall (with concrete coping)')).toBe('brick rooftop parapet wall');
    expect(shortName('kitchen counter')).toBe('kitchen counter');
  });
});

describe('writing and running', () => {
  const root = mkdtemp(join(tmpdir(), 'calibrate-'));
  afterAll(async () => rm(await root, { recursive: true, force: true }));

  const asset = (worldId: string, extra: object = {}) => ({
    provider: 'marble',
    worldId,
    spz: { k500: 'world_500k.spz' },
    metricScaleFactor: 1,
    groundPlaneOffset: 1.5,
    opencvFrame: false,
    ...extra,
  });

  it('measures a world dir from its collider without vision and writes world, library copy and manifest', async () => {
    const dir = await root;
    const scene = join(dir, 'project', 'scene-0');
    const world = join(scene, 'world');
    const lib = join(dir, 'library');
    await mkdir(world, { recursive: true });
    await mkdir(join(lib, 'kitchen'), { recursive: true });
    await mkdir(join(lib, 'other'), { recursive: true });
    // collider: an open floor (Y up, opencvFrame false) — only the camera band is measurable
    const floor = Float32Array.from([-9, 0, -9, -9, 0, 9, 9, 0, 9, -9, 0, -9, 9, 0, 9, 9, 0, -9]);
    await writeFile(join(world, 'collider.glb'), encodeGlb(floor));
    await writeFile(join(world, 'world-asset.json'), JSON.stringify(asset('w1', { colliderGlb: 'collider.glb' })));
    await writeFile(join(lib, 'kitchen', 'world-asset.json'), JSON.stringify(asset('w1')));
    await writeFile(join(lib, 'other', 'world-asset.json'), JSON.stringify(asset('w2')));
    await writeFile(join(scene, 'manifest.json'), JSON.stringify({ version: 1, world: asset('w1') }));

    const report = await calibrateWorld(world, { vision: false });
    expect(report.geometry?.measurements.map((x) => x.kind)).toEqual(['camera']);
    expect(report.visionSkipped).toBe('disabled');
    expect(report.decision).toMatchObject({ applied: false, factor: 1, confidence: 'low', method: 'none' });
    expect(formatReport(report, 'test')).toMatch(/keep Marble scale/);

    const written = await writeCalibration(world, report, { libraryDir: lib, manifest: true });
    expect(written.scaleCalibration).toEqual(report.calibration);
    const read = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
    expect((await read(join(world, 'world-asset.json'))).scaleCalibration.factor).toBe(1);
    expect((await read(join(lib, 'kitchen', 'world-asset.json'))).scaleCalibration).toEqual(report.calibration);
    expect((await read(join(lib, 'other', 'world-asset.json'))).scaleCalibration).toBeUndefined();
    expect((await read(join(lib, 'kitchen', 'scale-calibration.json'))).worldId).toBe('w1');
    expect((await read(join(scene, 'manifest.json'))).world.scaleCalibration).toEqual(report.calibration);

    expect((await previousCalibration(world, 'w1'))?.calibration).toEqual(report.calibration);
    expect(await previousCalibration(world, 'w9')).toBeNull();
  });

  it('a world without a collider skips both measurements', async () => {
    const world = join(await root, 'bare');
    await mkdir(world, { recursive: true });
    await writeFile(join(world, 'world-asset.json'), JSON.stringify(asset('w3')));
    const report: CalibrationReport = await calibrateWorld(world, {
      openRenderer: () => Promise.reject(new Error('must not render')),
    });
    expect(report.geometry).toBeNull();
    expect(report.vision).toBeNull();
    expect(report.visionSkipped).toMatch(/no collider/);
  });
});
