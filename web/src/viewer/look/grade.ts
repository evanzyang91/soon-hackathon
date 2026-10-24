// Look → grade parameters, plus a CPU reference of the post shader's colour math (shaders.ts).
// Pure: no three.js, no DOM. The GLSL in shaders.ts mirrors `gradePixel` operation for operation,
// so unit tests pin the math and the browser check compares the two.
//
// Order of operations (linear light unless noted):
//   sRGB decode → + bloom → white balance → exposure → vignette → contrast (power about 18 %
//   grey) → saturation → [display] shadows/highlights → LUT preset (display, mixed by
//   lutStrength) → grain → output.
// Fog and sky tint are not here: they are applied per splat (lights.ts) and by three.js fog on
// meshes, so semi-transparent splats fog correctly (a depth buffer cannot represent them).
import type { Look } from '@shared/look';

export type Vec3 = [number, number, number];
/** Row-major 3×3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Rec. 709 luma weights (linear and display alike; the shader uses the same). */
export const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];
export const MID_GREY = 0.18;

export const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
export const linearToSrgb = (c: number) => {
  const x = Math.max(0, c);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
};
export const luma = (c: Vec3) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** '#rrggbb' / '#rgb' → display RGB 0..1 (white on anything unparsable). */
export function hexToRgb(hex: string): Vec3 {
  let h = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return [1, 1, 1];
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export const hexToLinear = (hex: string): Vec3 => hexToRgb(hex).map(srgbToLinear) as Vec3;

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
}
export const mulMat3Vec = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

// ---- white balance -----------------------------------------------------------------------------
// A von Kries adaptation in CAT02-like LMS space (the same construction as Unity's post stack):
// temperature moves the reference white along the daylight locus, tint off it (green ↔ magenta);
// the matrix maps that white back to D65. + temperature warms, + tint goes magenta.

const LIN_TO_LMS: Mat3 = [
  0.390405, 0.549941, 0.00892632, 0.0708416, 0.963172, 0.00135775, 0.0231082, 0.128021, 0.936245,
];
const LMS_TO_LIN: Mat3 = [
  2.85847, -1.62879, -0.024891, -0.210182, 1.1582, 0.000324281, -0.041812, -0.118169, 1.06867,
];
const D65_X = 0.31271;
const illuminantY = (x: number) => 2.87 * x - 3 * x * x - 0.27509507;
function xyToLms(x: number, y: number): Vec3 {
  const X = x / y;
  const Z = (1 - x - y) / y;
  return [
    0.7328 * X + 0.4296 - 0.1624 * Z,
    -0.7036 * X + 1.6975 + 0.0061 * Z,
    0.003 * X + 0.0136 + 0.9834 * Z,
  ];
}

/**
 * Linear-RGB white balance matrix for `temperature`, `tint` in −1..1 (Look units). Exactly the
 * identity at (0, 0); otherwise scaled so neutral grey keeps its luminance.
 */
export function whiteBalanceMatrix(temperature: number, tint: number): Mat3 {
  if (!temperature && !tint) return [...IDENTITY3];
  const t1 = (Math.max(-1, Math.min(1, temperature)) * 100) / 65;
  const t2 = (Math.max(-1, Math.min(1, tint)) * 100) / 65;
  const x = D65_X - t1 * (t1 < 0 ? 0.1 : 0.05);
  const y = illuminantY(x) + t2 * 0.05;
  const w1 = xyToLms(D65_X, illuminantY(D65_X));
  const w2 = xyToLms(x, y);
  const diag: Mat3 = [w1[0] / w2[0], 0, 0, 0, w1[1] / w2[1], 0, 0, 0, w1[2] / w2[2]];
  const m = mulMat3(LMS_TO_LIN, mulMat3(diag, LIN_TO_LMS));
  const grey = luma(mulMat3Vec(m, [1, 1, 1]));
  return m.map((v) => v / grey) as Mat3;
}

// ---- LUT presets -------------------------------------------------------------------------------
// Each preset is a small analytic transform in display space (no 3D LUT files):
//   d = mix(L, d, sat) · gain;  d = lift + d (1 − lift);  d = d^(1/gamma);  S-curve(contrast);
//   d += shadowTint (1 − L)² + highlightTint L²

export interface LutParams {
  sat: number;
  contrast: number;
  lift: Vec3;
  gamma: Vec3;
  gain: Vec3;
  shadowTint: Vec3;
  highlightTint: Vec3;
}
export type LutName = Look['lut'];

const NEUTRAL_LUT: LutParams = {
  sat: 1,
  contrast: 1,
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  shadowTint: [0, 0, 0],
  highlightTint: [0, 0, 0],
};
const lut = (p: Partial<LutParams>): LutParams => ({ ...NEUTRAL_LUT, ...p });

export const LUT_PRESETS: Record<LutName, LutParams> = {
  neutral: NEUTRAL_LUT,
  // teal shadows, orange (skin) highlights, a little punch
  'teal-orange': lut({
    sat: 1.15,
    contrast: 1.12,
    gain: [1.03, 1, 0.96],
    shadowTint: [-0.07, 0.03, 0.09],
    highlightTint: [0.09, 0.025, -0.08],
  }),
  // black and white with a hard curve
  noir: lut({ sat: 0, contrast: 1.45, gamma: [0.95, 0.95, 0.95], gain: [1.04, 1.04, 1.04] }),
  // print-film warmth: lifted warm blacks, warm highlights, gentle curve
  kodak: lut({
    sat: 1.06,
    contrast: 1.08,
    lift: [0.045, 0.035, 0.025],
    gain: [1.02, 1, 0.95],
    highlightTint: [0.045, 0.015, -0.035],
  }),
  // bleach bypass: silver retained → low saturation, high contrast
  bleach: lut({ sat: 0.42, contrast: 1.35, gamma: [0.97, 0.97, 0.97], gain: [1.03, 1.03, 1.03] }),
  // moonlit: blue cast, cooler lifted blacks, less saturation
  'cool-night': lut({
    sat: 0.75,
    contrast: 1.1,
    lift: [0, 0.01, 0.035],
    gamma: [0.94, 0.95, 1],
    gain: [0.8, 0.88, 1.05],
    shadowTint: [-0.01, 0, 0.03],
  }),
  // late-afternoon sun
  golden: lut({
    sat: 1.1,
    contrast: 1.05,
    lift: [0.02, 0.012, 0],
    gain: [1.08, 1, 0.82],
    highlightTint: [0.05, 0.03, -0.04],
  }),
};

export function applyLut(d: Vec3, p: LutParams): Vec3 {
  let L = luma(d);
  let o = d.map((c, i) => (L + (c - L) * p.sat) * p.gain[i]!) as Vec3;
  o = o.map((c, i) => p.lift[i]! + c * (1 - p.lift[i]!)) as Vec3;
  o = o.map((c, i) => Math.max(0, c) ** (1 / p.gamma[i]!)) as Vec3;
  o = o.map((c) => sCurve(clamp01(c), p.contrast)) as Vec3;
  L = luma(o);
  const ws = (1 - L) ** 2;
  const wh = L * L;
  return o.map((c, i) => clamp01(c + p.shadowTint[i]! * ws + p.highlightTint[i]! * wh)) as Vec3;
}

/** Contrast S-curve on 0..1 that keeps 0, ½ and 1 fixed (k = 1 is the identity). */
export function sCurve(x: number, k: number): number {
  return x < 0.5 ? 0.5 * (2 * x) ** k : 1 - 0.5 * (2 * (1 - x)) ** k;
}

// ---- atmosphere (per splat, lights.ts) ---------------------------------------------------------

/** Exponential fog coefficient (1/m) for Look.fog.density 0..1: 0.5 → half-fogged at ≈ 18 m. */
export const fogCoefficient = (density: number) => 0.15 * clamp01(density) ** 2;
/** Fog never fully replaces the scene (keeps silhouettes readable). */
export const FOG_MAX = 0.96;
/**
 * Sky tint mask: a splat is "sky" when the direction to it from the camera is above this
 * elevation band (sine of the angle above the horizon) and it is farther than this (m).
 */
export const SKY_ELEVATION: [number, number] = [-0.03, 0.14];
export const SKY_DISTANCE: [number, number] = [14, 40];

/** Normalises a tint colour to unit luminance so a sky tint recolours without darkening. */
export function unitLumaTint(lin: Vec3): Vec3 {
  const l = luma(lin);
  if (l < 1e-4) return [0, 0, 0];
  return lin.map((c) => Math.min(3, c / l)) as Vec3;
}

// ---- everything the shader needs ---------------------------------------------------------------

export interface AtmosphereParams {
  fogColor: Vec3;
  fogK: number;
  skyColor: Vec3;
  skyStrength: number;
}

export function atmosphereParams(look: Pick<Look, 'fog' | 'skyTint'>): AtmosphereParams {
  return {
    fogColor: hexToLinear(look.fog.color),
    fogK: fogCoefficient(look.fog.density),
    skyColor: unitLumaTint(hexToLinear(look.skyTint.color)),
    skyStrength: look.skyTint.strength,
  };
}

/** Fog blend for a splat `distance` m away, and the sky mask for its elevation (sine) + distance. */
export function fogFactor(k: number, distance: number): number {
  return k > 0 ? Math.min(FOG_MAX, 1 - Math.exp(-k * distance)) : 0;
}
export function skyMask(elevation: number, distance: number): number {
  return smoothstep(SKY_ELEVATION[0], SKY_ELEVATION[1], elevation) * smoothstep(SKY_DISTANCE[0], SKY_DISTANCE[1], distance);
}

/** CPU reference of the splat atmosphere (lights.ts GLSL): linear colour in, linear colour out. */
export function atmospherePixel(lin: Vec3, a: AtmosphereParams, fog: number, sky: number): Vec3 {
  let c = lin;
  if (sky > 0 && a.skyStrength > 0) c = c.map((v, i) => v * (1 + (a.skyColor[i]! - 1) * sky * a.skyStrength)) as Vec3;
  if (fog > 0) c = c.map((v, i) => v + (a.fogColor[i]! - v) * fog) as Vec3;
  return c;
}

export interface GradeParams {
  wb: Mat3;
  exposureGain: number;
  contrast: number;
  saturation: number;
  shadows: number;
  highlights: number;
  lut: LutParams;
  lutStrength: number;
  vignette: number;
  grain: number;
  bloom: number;
}

export function gradeParams(look: Look): GradeParams {
  return {
    wb: whiteBalanceMatrix(look.temperature, look.tint),
    exposureGain: 2 ** look.exposure,
    contrast: look.contrast,
    saturation: look.saturation,
    shadows: look.shadows,
    highlights: look.highlights,
    lut: LUT_PRESETS[look.lut] ?? NEUTRAL_LUT,
    lutStrength: look.lut === 'neutral' ? 0 : look.lutStrength,
    vignette: look.vignette,
    grain: look.grain,
    bloom: look.bloom,
  };
}

/** Vignette darkening factor at uv (0..1) for a viewport of `aspect` = width / height. */
export function vignetteFactor(uv: [number, number], aspect: number, amount: number): number {
  if (amount <= 0) return 1;
  const dx = (uv[0] - 0.5) * aspect;
  const dy = uv[1] - 0.5;
  const r = Math.hypot(dx, dy) / Math.hypot(0.5 * aspect, 0.5);
  return 1 - amount * 0.85 * smoothstep(0.3, 1.05, r) ** 1.5;
}

export interface PixelContext {
  uv?: [number, number];
  aspect?: number;
  /** Linear bloom contribution already blurred (0 = none). */
  bloom?: Vec3;
}

/** CPU reference of the post shader on one display-referred sRGB pixel (no grain). */
export function gradePixel(srgb: Vec3, p: GradeParams, ctx: PixelContext = {}): Vec3 {
  let lin = srgb.map(srgbToLinear) as Vec3;
  if (ctx.bloom && p.bloom > 0) lin = lin.map((c, i) => c + ctx.bloom![i]! * p.bloom * 1.5) as Vec3;
  lin = mulMat3Vec(p.wb, lin);
  const v = vignetteFactor(ctx.uv ?? [0.5, 0.5], ctx.aspect ?? 1, p.vignette);
  lin = lin.map((c) => c * p.exposureGain * v) as Vec3;
  if (p.contrast !== 1)
    lin = lin.map((c) => MID_GREY * (Math.max(0, c) / MID_GREY) ** p.contrast) as Vec3;
  const Ll = luma(lin);
  lin = lin.map((c) => Ll + (c - Ll) * p.saturation) as Vec3;
  let d = lin.map(linearToSrgb) as Vec3;
  d = d.map((c) => Math.min(1, c)) as Vec3;
  d = shadowsHighlights(d, p.shadows, p.highlights);
  if (p.lutStrength > 0) {
    const l = applyLut(d, p.lut);
    d = d.map((c, i) => c + (l[i]! - c) * p.lutStrength) as Vec3;
  }
  return d.map(clamp01) as Vec3;
}

/** Luminance-masked shadow / highlight lift in display space (adds the luminance change). */
export function shadowsHighlights(d: Vec3, shadows: number, highlights: number): Vec3 {
  if (!shadows && !highlights) return d;
  const L = clamp01(luma(d));
  let L2 = L;
  if (shadows) L2 += (L2 ** 2 ** -shadows - L2) * (1 - smoothstep(0, 0.7, L));
  if (highlights) L2 += (1 - (1 - L2) ** 2 ** highlights - L2) * smoothstep(0.3, 1, L);
  return d.map((c) => c + L2 - L) as Vec3;
}

// ---- what needs which pass ---------------------------------------------------------------------

const EPS = 1e-6;
/**
 * True when the post pass would change nothing (the frame is rendered straight to the canvas).
 * Fog and sky tint live in the splats, not in the pass.
 */
export function isIdentityGrade(look: Look): boolean {
  return (
    Math.abs(look.exposure) < EPS &&
    Math.abs(look.contrast - 1) < EPS &&
    Math.abs(look.saturation - 1) < EPS &&
    Math.abs(look.temperature) < EPS &&
    Math.abs(look.tint) < EPS &&
    Math.abs(look.shadows) < EPS &&
    Math.abs(look.highlights) < EPS &&
    (look.lut === 'neutral' || look.lutStrength < EPS) &&
    look.vignette < EPS &&
    look.grain < EPS &&
    look.bloom < EPS
  );
}

/** Fog / sky tint are on (the splat modifier and three.js fog carry them). */
export const hasAtmosphere = (look: Pick<Look, 'fog' | 'skyTint'>) =>
  look.fog.density > EPS || look.skyTint.strength > EPS;
