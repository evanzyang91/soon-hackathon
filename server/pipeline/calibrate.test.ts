import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPECTED, type Measurement, type MeasurementKind } from './calibrate-geometry.ts';
import {
  calibrated,
  floorOffsetOf,
  withGround,
  calibrateWorld,
  combineSources,
  decide,
  evidenceText,
  formatReport,
  geometricEstimate,
  previousCalibration,
  redecide,
  scaleSources,
  shortName,
  writeCalibration,
  type CalibrationReport,
} from './calibrate.ts';
import { encodeGlb } from './glb.ts';
import { encodeSpz, type Splat } from './spz.ts';

/** A Y-up test world's splats: a ground layer at raw y over the blocking area, clutter above. */
function groundSpz(y: number): Buffer {
  const splats: Splat[] = [];
  for (let i = 0; i < 120; i++)
    for (let k = 0; k < 80; k++) {
      const [x, z] = [-3 + i * 0.05, -5 + k * 0.05];
      splats.push({ position: [x, y + (((i * 7 + k * 13) % 10) - 5) / 1000, z], scale: [0.02, 0.002, 0.02], rgb: [0.5, 0.5, 0.5], opacity: 0.9 });
      if ((i + k) % 4 === 0) // shins, bags, kerbs: above the ground, never the densest layer
        splats.push({ position: [x, y + 0.2 + ((i * k) % 20) / 100, z], scale: [0.01, 0.01, 0.01], rgb: [0.3, 0.3, 0.3], opacity: 0.9 });
    }
  return encodeSpz(splats);
}

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
    const d = decide(
      { available: false, factor: NaN, consistent: 0, note: 'only 1 weak reference(s)' },
      { available: false, factor: 1.4, agree: true },
    );
    expect(d).toMatchObject({ method: 'none', factor: 1 });
    expect(d.reason).toMatch(/collider: only 1 weak reference\(s\); vision: agreeing runs but too little evidence/);
  });

  // no collider estimate (outdoors): vision, Claude's eyeballed runs and the camera eye-height
  // prior weighed by 1/σ². The numbers are the stored reports of the three outdoor worlds.
  const runs = (factor: number, spread: number, weight: number, eyeballed: number[]) => ({
    available: false,
    agree: true,
    factor,
    spread,
    weight,
    eyeballed,
  });

  it('outdoors: agreeing vision and a camera that point the same way are applied (rooftop)', () => {
    const d = decide(null, runs(0.846, 0.122, 0.725, [0.595, 1.0]), { cameraHeight: 2.172 });
    expect(d).toMatchObject({ applied: true, confidence: 'medium', method: 'vision+camera' });
    expect(d.factor).toBeCloseTo(0.778, 2);
    expect(d.sigma).toBeCloseTo(0.091, 2);
    expect(d.reason).toMatch(/2\.8σ/);
  });

  it('outdoors: weak vision the camera and Claude’s own eye contradict is kept (bus stop)', () => {
    const d = decide(null, runs(1.16, 0.051, 0.615, [0.96, 1.026]), { cameraHeight: 1.612 });
    expect(d).toMatchObject({ applied: false, factor: 1, confidence: 'low', method: 'vision+eyeballed+camera' });
    expect(d.candidate).toBeCloseTo(1.044, 2);
    // a bigger, still insignificant pull: kept with the σ in the reason
    const e = decide(null, runs(1.22, 0.05, 0.6, [1.02, 1.05]), { cameraHeight: 1.55 });
    expect(e).toMatchObject({ applied: false, factor: 1, confidence: 'low' });
    expect(e.reason).toMatch(/σ from Marble's scale \(< 1\.5σ\): not applied/);
  });

  it('outdoors: vision and camera more than 25 % apart are refused (city street)', () => {
    const d = decide(null, runs(0.889, 0.01, 1.105, [1.037, 0.938, 0.918]), { cameraHeight: 1.3925 });
    expect(d).toMatchObject({ applied: false, factor: 1, confidence: 'low' });
    expect(d.reason).toMatch(/vision ×0\.89 .* and camera height ×1\.11 .* disagree by 25%/);
  });

  it('outdoors: clean vision outweighs a mildly disagreeing camera', () => {
    // four standard objects measured from pixels (W 2.2), runs 3 % apart; camera at eye height
    const d = decide(null, { ...runs(0.85, 0.03, 2.2, []), available: true }, { cameraHeight: 1.55 });
    expect(d).toMatchObject({ applied: true, confidence: 'medium', method: 'vision+camera' });
    expect(d.factor).toBeGreaterThan(0.87);
    expect(d.factor).toBeLessThan(0.9);
  });

  it('outdoors: the camera alone never changes anything', () => {
    const d = decide({ available: false, factor: NaN, consistent: 0, note: 'nothing' }, { available: false, factor: NaN, agree: false }, { cameraHeight: 2.17 });
    expect(d).toMatchObject({ applied: false, factor: 1, method: 'none' });
    expect(d.reason).toMatch(/camera height ×0\.71 ± 13% alone is only a prior/);
  });

  it('the eye-height prior: 1.55 m ± 0.2', () => {
    const cam = scaleSources(null, { cameraHeight: 2.17 }).find((s) => s.kind === 'camera')!;
    expect(cam.factor).toBeCloseTo(0.714, 3);
    expect(cam.sigma).toBeCloseTo(0.129, 3);
    expect(combineSources([cam, { ...cam, factor: 1 }]).factor).toBeCloseTo(Math.sqrt(0.714), 3);
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
    // collider: an open floor (Y up, opencvFrame false) 0.1 m below Marble's ground plane (raw
    // y = -gpo / msf = -1.5) — only the camera band is measurable; the splats' visible ground is
    // 0.06 m below the plane where the actors stand (the collider is not the floor offset)
    const y = -1.6;
    const floor = Float32Array.from([-9, y, -9, -9, y, 9, 9, y, 9, -9, y, -9, 9, y, 9, 9, y, -9]);
    await writeFile(join(world, 'world_500k.spz'), groundSpz(-1.5 - 0.06));
    await writeFile(join(world, 'collider.glb'), encodeGlb(floor));
    await writeFile(join(world, 'world-asset.json'), JSON.stringify(asset('w1', { colliderGlb: 'collider.glb' })));
    await writeFile(join(lib, 'kitchen', 'world-asset.json'), JSON.stringify(asset('w1')));
    await writeFile(join(lib, 'other', 'world-asset.json'), JSON.stringify(asset('w2')));
    await writeFile(join(scene, 'manifest.json'), JSON.stringify({ version: 1, world: asset('w1') }));

    const report = await calibrateWorld(world, { vision: false });
    expect(report.geometry?.measurements.map((x) => x.kind)).toEqual(['camera']);
    expect(report.visionSkipped).toBe('disabled');
    expect(report.decision).toMatchObject({ applied: false, factor: 1, confidence: 'low', method: 'none' });
    expect(report.calibration.evidence.split(' · ')[0]).toBe('unverified');
    expect(report.calibration.headline).toBe('unverified');
    expect(report.ground?.probes).toHaveLength(3);
    expect(report.floorOffsetMeters).toBeCloseTo(0.06, 2);
    expect(formatReport(report, 'test')).toMatch(/floorOffsetMeters 0\.06\d/);
    // a stored report read back from JSON (NaN → null) re-decides to the same result
    const again = redecide(JSON.parse(JSON.stringify(report)));
    expect(again.calibration).toEqual(report.calibration);
    expect(formatReport(report, 'test')).toMatch(/keep Marble scale/);

    const written = await writeCalibration(world, report, { libraryDir: lib, manifest: true });
    expect(written.scaleCalibration).toEqual(report.calibration);
    expect(written.floorOffsetMeters).toBeCloseTo(0.06, 2);
    const read = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
    expect((await read(join(world, 'world-asset.json'))).scaleCalibration.factor).toBe(1);
    expect((await read(join(lib, 'kitchen', 'world-asset.json'))).scaleCalibration).toEqual(report.calibration);
    expect((await read(join(lib, 'other', 'world-asset.json'))).scaleCalibration).toBeUndefined();
    expect((await read(join(lib, 'kitchen', 'scale-calibration.json'))).worldId).toBe('w1');
    expect((await read(join(scene, 'manifest.json'))).world.scaleCalibration).toEqual(report.calibration);
    for (const f of [join(world, 'world-asset.json'), join(lib, 'kitchen', 'world-asset.json')])
      expect((await read(f)).floorOffsetMeters).toBeCloseTo(0.06, 2);
    expect((await read(join(scene, 'manifest.json'))).world.floorOffsetMeters).toBeCloseTo(0.06, 2);
    expect((await read(join(lib, 'other', 'world-asset.json'))).floorOffsetMeters).toBeUndefined();

    // measured again with the offset stored, the splats are still read in Marble's frame
    const twice = await calibrateWorld(world, { vision: false });
    expect(twice.floorOffsetMeters).toBeCloseTo(0.06, 2);
    // --reuse: a stored report gets its ground measured again, at the scene's marks
    const reused = await withGround(redecide(JSON.parse(JSON.stringify(report))), world, [[0.5, -2.8]]);
    expect(reused.ground?.probes.map((p) => [p.x, p.z, p.r])).toEqual([[0.5, -2.8, 0.6]]);
    expect(reused.floorOffsetMeters).toBeCloseTo(0.06, 2);

    expect((await previousCalibration(world, 'w1'))?.calibration).toEqual(report.calibration);
    expect(await previousCalibration(world, 'w9')).toBeNull();
  });

  it('floor offsets: from the splat ground, millimetres, nothing implausible', () => {
    const at = (height: number | null) => ({ ground: { method: 'm', probes: [], height } }) as unknown as CalibrationReport;
    expect(floorOffsetOf(at(-0.189511))).toBe(0.19);
    expect(floorOffsetOf(at(0.0004))).toBe(0);
    expect(floorOffsetOf(at(-0.7))).toBeUndefined();
    expect(floorOffsetOf(at(null))).toBeUndefined();
    expect(floorOffsetOf({ ground: null })).toBeUndefined();
    const base = asset('w5', { scaleCalibration: { factor: 1, method: 'none', confidence: 'low', evidence: 'x' }, floorOffsetMeters: 0.3 });
    const report = { ...at(-0.142565), calibration: { factor: 1, method: 'none', confidence: 'low', evidence: 'unverified · …', headline: 'unverified' } } as CalibrationReport;
    expect(calibrated(base as never, report)).toMatchObject({ floorOffsetMeters: 0.143, scaleCalibration: { headline: 'unverified' } });
    expect('floorOffsetMeters' in calibrated(base as never, { ...report, ground: null })).toBe(false);
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
