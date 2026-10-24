import { describe, expect, it } from 'vitest';
import { defaultLook, Look } from '@shared/look';
import {
  applyLut,
  fogCoefficient,
  gradeParams,
  gradePixel,
  hexToLinear,
  IDENTITY3,
  isIdentityGrade,
  linearToSrgb,
  luma,
  LUT_PRESETS,
  mulMat3Vec,
  hasAtmosphere,
  atmosphereParams,
  atmospherePixel,
  fogFactor,
  skyMask,
  sCurve,
  srgbToLinear,
  unitLumaTint,
  vignetteFactor,
  whiteBalanceMatrix,
  type Vec3,
} from './grade';
import { apertureAngle, focalLengthMm, sparkLens, viewDepth } from './lens';
import { applyFullPreset, applyLutPreset, FULL_PRESETS, resetGroup } from './presets';
import { LookHistory } from './history';

const PALETTE: Vec3[] = [
  [0.05, 0.05, 0.05],
  [0.2, 0.3, 0.6],
  [0.8, 0.55, 0.4],
  [0.5, 0.5, 0.5],
  [0.9, 0.9, 0.85],
  [0.1, 0.6, 0.2],
];
const close = (a: Vec3, b: Vec3, eps: number) => a.every((v, i) => Math.abs(v - b[i]!) <= eps);
const meanDiff = (look: Look) => {
  const p = gradeParams(look);
  let s = 0;
  for (const c of PALETTE) s += gradePixel(c, p).reduce((t, v, i) => t + Math.abs(v - c[i]!), 0);
  return s / (PALETTE.length * 3);
};

describe('colour transfer', () => {
  it('sRGB ↔ linear round-trips every 8-bit code exactly', () => {
    for (let i = 0; i <= 255; i++) {
      const c = i / 255;
      expect(Math.round(linearToSrgb(srgbToLinear(c)) * 255)).toBe(i);
    }
  });
  it('parses css hex', () => {
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToLinear('#000')).toEqual([0, 0, 0]);
    expect(hexToLinear('nope')).toEqual([1, 1, 1]);
  });
});

describe('white balance matrix', () => {
  it('is exactly the identity at temperature 0, tint 0', () => {
    expect(whiteBalanceMatrix(0, 0)).toEqual(IDENTITY3);
  });
  it('warms with + temperature and cools with −, keeping grey luminance', () => {
    const warm = mulMat3Vec(whiteBalanceMatrix(0.6, 0), [0.5, 0.5, 0.5]);
    const cool = mulMat3Vec(whiteBalanceMatrix(-0.6, 0), [0.5, 0.5, 0.5]);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
    expect(luma(warm)).toBeCloseTo(0.5, 6);
    expect(luma(cool)).toBeCloseTo(0.5, 6);
  });
  it('+ tint goes magenta (less green), − tint goes green', () => {
    const mag = mulMat3Vec(whiteBalanceMatrix(0, 0.6), [0.5, 0.5, 0.5]);
    const grn = mulMat3Vec(whiteBalanceMatrix(0, -0.6), [0.5, 0.5, 0.5]);
    expect(mag[1]).toBeLessThan(Math.min(mag[0], mag[2]));
    expect(grn[1]).toBeGreaterThan(Math.max(grn[0], grn[2]));
  });
  it('is near-identity for tiny moves (continuous at 0)', () => {
    const m = whiteBalanceMatrix(0.001, 0);
    m.forEach((v, i) => expect(Math.abs(v - IDENTITY3[i]!)).toBeLessThan(0.01));
  });
});

describe('grade', () => {
  it('the default look is the identity and needs no pass', () => {
    const look = defaultLook();
    expect(isIdentityGrade(look)).toBe(true);
    expect(hasAtmosphere(look)).toBe(false);
    const p = gradeParams(look);
    for (let i = 0; i <= 255; i += 5) {
      const c: Vec3 = [i / 255, ((i * 7) % 256) / 255, ((i * 13) % 256) / 255];
      const out = gradePixel(c, p);
      out.forEach((v, k) => expect(Math.round(v * 255)).toBe(Math.round(c[k]! * 255)));
    }
  });
  it('+1 stop doubles linear light', () => {
    const p = gradeParams({ ...defaultLook(), exposure: 1 });
    const out = gradePixel([linearToSrgb(0.1), linearToSrgb(0.2), linearToSrgb(0.05)], p);
    expect(out.map(srgbToLinear).map((v) => +v.toFixed(4))).toEqual([0.2, 0.4, 0.1]);
  });
  it('contrast pivots on mid grey; saturation 0 is grey', () => {
    const grey = linearToSrgb(0.18);
    const hi = gradePixel([grey, grey, grey], gradeParams({ ...defaultLook(), contrast: 1.6 }));
    expect(hi[0]).toBeCloseTo(grey, 5);
    const bw = gradePixel([0.8, 0.3, 0.2], gradeParams({ ...defaultLook(), saturation: 0 }));
    expect(bw[0]).toBeCloseTo(bw[1], 6);
    expect(bw[1]).toBeCloseTo(bw[2], 6);
  });
  it('shadows lift darks more than lights; highlights the reverse', () => {
    const p = gradeParams({ ...defaultLook(), shadows: 0.8 });
    const dark = gradePixel([0.15, 0.15, 0.15], p)[0] - 0.15;
    const light = gradePixel([0.85, 0.85, 0.85], p)[0] - 0.85;
    expect(dark).toBeGreaterThan(0.04);
    expect(dark).toBeGreaterThan(light * 3);
    const q = gradeParams({ ...defaultLook(), highlights: -0.8 });
    expect(gradePixel([0.85, 0.85, 0.85], q)[0]).toBeLessThan(0.8);
    expect(gradePixel([0.1, 0.1, 0.1], q)[0]).toBeCloseTo(0.1, 2);
  });
  it('vignette darkens corners, not the centre', () => {
    expect(vignetteFactor([0.5, 0.5], 16 / 9, 1)).toBe(1);
    expect(vignetteFactor([0, 0], 16 / 9, 1)).toBeLessThan(0.3);
    expect(vignetteFactor([0, 0], 16 / 9, 0)).toBe(1);
  });
  it('fog coefficient grows with density; sky tints keep luminance', () => {
    expect(fogCoefficient(0)).toBe(0);
    expect(fogCoefficient(0.5)).toBeGreaterThan(fogCoefficient(0.2));
    expect(luma(unitLumaTint([1, 0.5, 0.1]))).toBeCloseTo(1, 6);
  });
  it('splat atmosphere: fog grows with distance (capped), sky tint only far + above the horizon', () => {
    const a = atmosphereParams({ fog: { color: '#808080', density: 0.5 }, skyTint: { color: '#ff8000', strength: 1 } });
    expect(fogFactor(a.fogK, 0)).toBe(0);
    expect(fogFactor(a.fogK, 18)).toBeGreaterThan(0.4);
    expect(fogFactor(a.fogK, 1e6)).toBeLessThan(1);
    expect(skyMask(0.5, 100)).toBe(1);
    expect(skyMask(-0.2, 100)).toBe(0);
    expect(skyMask(0.5, 3)).toBe(0);
    const red = atmospherePixel([0.2, 0.2, 0.2], a, 0, 1);
    expect(red[0]).toBeGreaterThan(red[2]);
    expect(atmospherePixel([0.2, 0.2, 0.2], a, 0, 0)).toEqual([0.2, 0.2, 0.2]);
  });
});

describe('LUT presets', () => {
  it('neutral is the identity', () => {
    for (const c of PALETTE) expect(close(applyLut(c, LUT_PRESETS.neutral), c, 1e-9)).toBe(true);
  });
  it('S-curve keeps 0, ½, 1 and steepens the middle', () => {
    expect(sCurve(0, 1.4)).toBe(0);
    expect(sCurve(0.5, 1.4)).toBe(0.5);
    expect(sCurve(1, 1.4)).toBe(1);
    expect(sCurve(0.3, 1.4)).toBeLessThan(0.3);
    expect(sCurve(0.7, 1.4)).toBeGreaterThan(0.7);
  });
  it('every preset visibly changes a test palette and lutStrength 0 turns it off', () => {
    for (const lut of Object.keys(LUT_PRESETS) as Look['lut'][]) {
      if (lut === 'neutral') continue;
      const look = applyLutPreset(defaultLook(), lut);
      expect(meanDiff(look), lut).toBeGreaterThan(0.02);
      expect(meanDiff({ ...look, lutStrength: 0 }), lut).toBeLessThan(1e-9);
    }
  });
  it('noir and bleach desaturate; cool-night is blue; golden and kodak are warm', () => {
    const skin: Vec3 = [0.8, 0.55, 0.4];
    const sat = (c: Vec3) => Math.max(...c) - Math.min(...c);
    expect(sat(applyLut(skin, LUT_PRESETS.noir))).toBeLessThan(1e-9);
    expect(sat(applyLut(skin, LUT_PRESETS.bleach))).toBeLessThan(sat(skin) * 0.7);
    const grey: Vec3 = [0.5, 0.5, 0.5];
    const night = applyLut(grey, LUT_PRESETS['cool-night']);
    expect(night[2]).toBeGreaterThan(night[0] + 0.05);
    for (const warm of [LUT_PRESETS.golden, LUT_PRESETS.kodak]) {
      const w = applyLut([0.8, 0.8, 0.8], warm);
      expect(w[0]).toBeGreaterThan(w[2] + 0.03);
    }
    // kodak lifts blacks
    expect(applyLut([0, 0, 0], LUT_PRESETS.kodak)[0]).toBeGreaterThan(0.03);
  });
  it('full-look presets differ from each other and keep lights + lens', () => {
    const base = Look.parse({
      lights: [{ id: 'k', name: 'Key', kind: 'point', position: [1, 2, 3] }],
      dof: { enabled: true, focusDistance: 4, fStop: 2 },
    });
    const outs = FULL_PRESETS.map((p) => applyFullPreset(base, p));
    for (const o of outs) {
      expect(o.lights).toEqual(base.lights);
      expect(o.dof).toEqual(base.dof);
    }
    expect(new Set(outs.map((o) => o.name)).size).toBe(4);
    for (const o of outs) expect(isIdentityGrade(o)).toBe(false);
  });
  it('reset per group restores only that group', () => {
    const l = Look.parse({ exposure: 1, vignette: 0.5, fog: { density: 0.3 } });
    const r = resetGroup(l, 'grade');
    expect(r.exposure).toBe(0);
    expect(r.vignette).toBe(0.5);
    expect(resetGroup(l, 'atmosphere').fog.density).toBe(0);
  });
});

describe('lens', () => {
  it('focal length from vertical fov (24 mm frame)', () => {
    expect(focalLengthMm(2 * Math.atan(12 / 50) * (180 / Math.PI))).toBeCloseTo(50, 6);
  });
  it('wider aperture and closer focus blur more; off is zero', () => {
    expect(apertureAngle(1.4, 50, 3)).toBeGreaterThan(apertureAngle(8, 50, 3));
    expect(apertureAngle(2.8, 50, 1)).toBeGreaterThan(apertureAngle(2.8, 50, 10));
    expect(apertureAngle(0.95, 500, 0.2)).toBeLessThanOrEqual(0.08);
    expect(sparkLens({ enabled: false, focusDistance: 3, fStop: 2.8 }, 40)).toEqual({
      focalDistance: 0,
      apertureAngle: 0,
    });
    const on = sparkLens({ enabled: true, focusDistance: 1000, fStop: 2.8 }, 40);
    expect(on.focalDistance).toBe(200);
  });
  it('view depth projects onto the forward axis', () => {
    expect(viewDepth([0, 0, 0], [0, 0, -1], [3, 1, -4])).toBe(4);
  });
});

describe('look history', () => {
  it('undo/redo, coalesced drags, 50-step limit', () => {
    const h = new LookHistory(0, 50);
    h.push(1, 'exposure');
    h.push(2, 'exposure');
    h.push(3, 'exposure');
    h.seal();
    h.push(4, 'exposure');
    expect(h.depth.undo).toBe(2);
    expect(h.undo()).toBe(3);
    expect(h.undo()).toBe(0);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe(3);
    h.push(9);
    expect(h.canRedo).toBe(false);
    for (let i = 0; i < 80; i++) h.push(100 + i);
    expect(h.depth.undo).toBe(50);
  });
});
