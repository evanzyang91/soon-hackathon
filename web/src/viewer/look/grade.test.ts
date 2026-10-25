import { describe, expect, it } from 'vitest';
import { defaultLook, Look } from '@shared/look';
import {
  applyLut,
  fogCoefficient,
  gradeParams,
  gradePixel,
  hexToLinear,
  hexToRgb,
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
import {
  applyFullPreset,
  applyLutPreset,
  FULL_PRESETS,
  LOOK_PRESET_GROUPS,
  LOOK_PRESETS,
  presetLook,
  PRESET_ORDER,
  resetGroup,
  seedToLook,
  type LookMood,
} from './presets';
import { LookPresetName, LutPreset } from '@shared/schema';
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
    expect(new Set(outs.map((o) => o.name)).size).toBe(LookPresetName.options.length);
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

// ---- what each LUT does (one case per LUT) -------------------------------------------------------

const grey = (v: number): Vec3 => [v, v, v];
const chroma = (c: Vec3) => Math.max(...c) - Math.min(...c);
/** Hue in degrees (−180..180, 0 = red) and HSV saturation. */
function hueSat(c: Vec3): { hue: number; sat: number } {
  const [r, g, b] = c;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let hue = 0;
  if (d > 1e-9) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue > 180) hue -= 360;
  }
  return { hue, sat: max > 0 ? d / max : 0 };
}
const lutOf = (name: Look['lut'], c: Vec3) => applyLut(c, LUT_PRESETS[name]);
const SKIN: Vec3 = [0.8, 0.55, 0.4];

const LUT_CASES: Record<LutPreset, () => void> = {
  neutral: () => {
    for (const c of PALETTE) expect(close(lutOf('neutral', c), c, 1e-9)).toBe(true);
  },
  'teal-orange': () => {
    const shadow = lutOf('teal-orange', grey(0.15));
    const light = lutOf('teal-orange', grey(0.85));
    expect(shadow[2]).toBeGreaterThan(shadow[0] + 0.02); // teal shadows
    expect(light[0]).toBeGreaterThan(light[2] + 0.04); // orange highlights
  },
  noir: () => {
    for (const c of PALETTE) expect(chroma(lutOf('noir', c))).toBeLessThan(1e-9);
    expect(lutOf('noir', grey(0.3))[0]).toBeLessThan(0.3); // a hard curve
    expect(lutOf('noir', grey(0.75))[0]).toBeGreaterThan(0.75);
  },
  kodak: () => {
    expect(lutOf('kodak', grey(0))[0]).toBeGreaterThan(0.03); // lifted print blacks
    const w = lutOf('kodak', grey(0.8));
    expect(w[0]).toBeGreaterThan(w[2] + 0.03);
  },
  bleach: () => {
    expect(chroma(lutOf('bleach', SKIN))).toBeLessThan(chroma(SKIN) * 0.7);
    expect(lutOf('bleach', grey(0.3))[0]).toBeLessThan(0.3);
  },
  'cool-night': () => {
    const n = lutOf('cool-night', grey(0.5));
    expect(n[2]).toBeGreaterThan(n[0] + 0.05);
  },
  golden: () => {
    const w = lutOf('golden', grey(0.8));
    expect(w[0]).toBeGreaterThan(w[2] + 0.03);
    expect(chroma(lutOf('golden', SKIN))).toBeGreaterThanOrEqual(chroma(SKIN));
  },
  sepia: () => {
    // an aged print: colour almost gone (a saturated blue comes out nearly grey) …
    expect(chroma(lutOf('sepia', [0.2, 0.3, 0.6]))).toBeLessThan(0.2);
    // … and what is left is brown: R > G > B with G in the middle third (yellow would put G near R)
    const [r, g, b] = lutOf('sepia', grey(0.5));
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b + 0.08);
    expect((g - b) / (r - b)).toBeGreaterThan(0.33);
    expect((g - b) / (r - b)).toBeLessThan(0.67);
    const black = lutOf('sepia', grey(0));
    expect(black[0]).toBeGreaterThan(0.04); // soft brown blacks
    expect(black[0]).toBeGreaterThan(black[2]);
  },
  verdant: () => {
    // green-teal, never yellow: green leads, blue at least matches red
    const mid = lutOf('verdant', grey(0.5));
    expect(mid[1]).toBeGreaterThan(Math.max(mid[0], mid[2]));
    expect(mid[2]).toBeGreaterThanOrEqual(mid[0]);
    const shadow = lutOf('verdant', grey(0.15));
    expect(Math.min(shadow[1], shadow[2])).toBeGreaterThan(shadow[0] + 0.04); // teal shadows
    const leaf: Vec3 = [0.1, 0.6, 0.2];
    expect(chroma(lutOf('verdant', leaf))).toBeGreaterThan(chroma(leaf)); // lush
  },
  cyber: () => {
    // the split: magenta shadows, cyan highlights
    const s = lutOf('cyber', grey(0.2));
    expect(Math.min(s[0], s[2])).toBeGreaterThan(s[1] + 0.08);
    const h = lutOf('cyber', grey(0.8));
    expect(Math.min(h[1], h[2])).toBeGreaterThan(h[0] + 0.05);
    expect(chroma(lutOf('cyber', SKIN))).toBeGreaterThan(chroma(SKIN) * 0.8); // still punchy
  },
  ice: () => {
    expect(chroma(lutOf('ice', SKIN))).toBeLessThan(chroma(SKIN) * 0.5); // drained
    const [r, g, b] = lutOf('ice', grey(0.5));
    expect(b).toBeGreaterThan(g); // cold blue-cyan
    expect(g).toBeGreaterThan(r);
    expect(lutOf('ice', grey(0))[2]).toBeGreaterThan(0.04); // cold lifted blacks
  },
  ember: () => {
    const [r, g, b] = lutOf('ember', grey(0.5));
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(r - b).toBeGreaterThan(0.2); // firelight orange
    expect(luma(lutOf('ember', grey(0.02)))).toBeLessThan(0.06); // deep blacks
    const s = lutOf('ember', grey(0.15));
    expect(s[1] / s[0]).toBeGreaterThan(0.55); // warm brown shadows, not red
  },
};

describe('each LUT does what its name says', () => {
  it('covers every LUT preset', () => {
    expect(Object.keys(LUT_CASES).sort()).toEqual([...LutPreset.options].sort());
  });
  for (const [name, check] of Object.entries(LUT_CASES)) it(name, check);
});

// ---- the eighteen full looks -----------------------------------------------------------------------

/**
 * A preset as a point in parameter space, each axis scaled to about one visible step: 0.25 stop,
 * 0.1 contrast, 0.15 saturation / temperature, 0.1 tint, 0.2 for the tone and film amounts; the
 * LUT as its effect at the preset's strength on a few greys and colours (0.05 per channel);
 * atmosphere as density / strength and the colour they push toward.
 */
function presetVector(m: LookMood): number[] {
  const v = [
    m.exposure / 0.25,
    (m.contrast - 1) / 0.1,
    (m.saturation - 1) / 0.15,
    m.temperature / 0.15,
    m.tint / 0.1,
    m.shadows / 0.2,
    m.highlights / 0.2,
    m.vignette / 0.2,
    m.grain / 0.2,
    m.bloom / 0.2,
    (1 - m.ambient) / 0.1,
  ];
  const strength = m.lut === 'neutral' ? 0 : m.lutStrength;
  for (const c of [grey(0.15), grey(0.5), grey(0.85), SKIN, [0.2, 0.3, 0.6], [0.1, 0.6, 0.2]] as Vec3[]) {
    const o = applyLut(c, LUT_PRESETS[m.lut]);
    for (let i = 0; i < 3; i++) v.push(((o[i]! - c[i]!) * strength) / 0.05);
  }
  const fog = hexToRgb(m.fog.color);
  const sky = hexToRgb(m.skyTint.color);
  v.push(m.fog.density / 0.1, m.skyTint.strength / 0.2);
  for (let i = 0; i < 3; i++) v.push((fog[i]! * m.fog.density) / 0.05, ((sky[i]! - 1) * m.skyTint.strength) / 0.1);
  return v;
}
const distance = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]!) ** 2, 0));
/**
 * The nearest two presets must stay this far apart. The first draft's near-twins (night street /
 * moonlit 3.47, daylight neutral / warm interior 3.32) rendered within 2–4 % of each other on the
 * real worlds; the tuned table's nearest pair is 3.53 (scripts/genre-looks.ts, ≥ 3.5 % mean abs
 * on every world).
 */
const MIN_PRESET_DISTANCE = 3.5;

const SKIN_TONES: Record<string, Vec3> = {
  light: hexToRgb('#e3bfa3'),
  medium: hexToRgb('#c68e6a'),
  deep: hexToRgb('#8d5a3c'),
  mannequin: hexToRgb('#d9b08c'),
};

describe('full-look presets', () => {
  const names = LookPresetName.options;

  it('every preset is listed in exactly one group, and the panel order follows the groups', () => {
    const listed = LOOK_PRESET_GROUPS.flatMap((g) => g.presets);
    expect([...listed].sort()).toEqual([...names].sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(PRESET_ORDER).toEqual(listed);
    expect(FULL_PRESETS.map((m) => m.name)).toEqual(listed.map((n) => LOOK_PRESETS[n].name));
  });

  it(`no two presets are within ${MIN_PRESET_DISTANCE} of each other in parameter space`, () => {
    const vs = names.map((n) => presetVector(LOOK_PRESETS[n]));
    const near: string[] = [];
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const d = distance(vs[i]!, vs[j]!);
        if (d < MIN_PRESET_DISTANCE) near.push(`${names[i]} / ${names[j]}: ${d.toFixed(2)}`);
      }
    expect(near).toEqual([]);
  });

  it('skin stays skin under every preset but film noir (warm hue, or near-neutral in cold light)', () => {
    const bad: string[] = [];
    for (const n of names) {
      if (n === 'film-noir') continue;
      const p = gradeParams(presetLook(n));
      for (const [tone, c] of Object.entries(SKIN_TONES)) {
        const o = gradePixel(c, p);
        const { hue, sat } = hueSat(o);
        const L = luma(o);
        // a face may go pink under neon, amber by fire and silver-grey by moonlight, but never
        // blue, green or yellow, never a black hole or a blown-out patch, never neon orange
        const ok = L > 0.15 && L < 0.95 && sat < 0.9 && (sat <= 0.12 || (hue >= -25 && hue <= 50));
        if (!ok) bad.push(`${n} ${tone}: ${hue.toFixed(0)}° s${sat.toFixed(2)} L${L.toFixed(2)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('mid tones never clip to black or white (grade only; fog and lights come on top)', () => {
    for (const n of names) {
      const p = gradeParams(presetLook(n));
      for (let v = 0.15; v <= 0.801; v += 0.05) {
        const o = gradePixel(grey(v), p);
        expect(Math.max(...o), `${n} grey ${v.toFixed(2)}`).toBeGreaterThan(3 / 255);
        expect(Math.min(...o), `${n} grey ${v.toFixed(2)}`).toBeLessThan(252 / 255);
      }
    }
  });

  it('reads as its name in the numbers that define it', () => {
    const g = (n: LookPresetName) => gradePixel(grey(0.4), gradeParams(presetLook(n)));
    const warmth = (c: Vec3) => c[0] - c[2];
    for (const n of ['candlelit', 'golden-hour', 'warm-interior', 'western-dust', 'period-warm'] as const)
      expect(warmth(g(n)), n).toBeGreaterThan(0.04);
    for (const n of ['moonlit', 'cold-steel', 'blue-hour', 'night-street', 'storm'] as const)
      expect(warmth(g(n)), n).toBeLessThan(-0.01);
    expect(chroma(g('film-noir'))).toBeLessThan(1e-9);
    const e = g('enchanted');
    expect(Math.min(e[1], e[2])).toBeGreaterThan(e[0] + 0.05); // green-teal …
    expect(e[1]).toBeGreaterThan(e[2] - 0.03); // … not blue
    expect(LOOK_PRESETS.storm.fog.density).toBeGreaterThanOrEqual(0.45); // heavily fogged
    expect(LOOK_PRESETS.horror.fog.density).toBeGreaterThanOrEqual(0.35);
    expect(LOOK_PRESETS.horror.vignette).toBeGreaterThanOrEqual(0.5);
    expect(LOOK_PRESETS['neon-noir'].bloom).toBeGreaterThanOrEqual(0.7); // heavy glow
    expect(luma(hexToRgb(LOOK_PRESETS['neon-noir'].fog.color))).toBeLessThan(0.05); // dark skies
    expect(LOOK_PRESETS.snowfall.exposure).toBeGreaterThan(0); // bright
    expect(LOOK_PRESETS.snowfall.contrast).toBeLessThan(1); // low contrast
    expect(luma(hexToRgb(LOOK_PRESETS.snowfall.fog.color))).toBeGreaterThan(0.8); // pale fog
    expect(LOOK_PRESETS.dreamlike.bloom).toBeGreaterThanOrEqual(0.6);
    expect(LOOK_PRESETS.candlelit.exposure).toBeLessThan(0); // dim
    expect(luma(g('moonlit'))).toBeLessThan(luma(g('storm'))); // night is darker than a storm
  });

  it("the scene's look is the seed over the director's lights and lens, named label · mood", () => {
    const base = Look.parse({
      lights: [{ id: 'k', name: 'Key', kind: 'point', position: [1, 2, 3] }],
      dof: { enabled: true, focusDistance: 4, fStop: 2 },
      exposure: 1.5,
    });
    const look = seedToLook(
      { preset: 'candlelit', mood: 'cold, eerie, damp stone', fog: { color: '#223344', density: 0.4 } },
      base,
    );
    expect(look.name).toBe('Candlelit · cold, eerie, damp stone');
    expect(look.lights).toEqual(base.lights);
    expect(look.dof).toEqual(base.dof);
    expect(look.exposure).toBe(LOOK_PRESETS.candlelit.exposure);
    expect(look.fog).toEqual({ color: '#223344', density: 0.4 });
    const long = seedToLook({ preset: 'western-dust', mood: 'x'.repeat(60) });
    expect(long.name.length).toBeLessThanOrEqual(80);
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
