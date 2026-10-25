// Full-look presets (grade + film + atmosphere, never lights or lens) keyed by LookPresetName
// (shared/schema.ts), used by the Look panel's preset list and by the manifest stage, which turns
// the planner's LookSeed into a scene's first look (server/pipeline/look-seed.ts). Values are the
// look work package's; the names and the two functions are the contract.
import { defaultLook, Look } from './look';
import type { LookPresetName, LookSeed } from './schema';

/** Grade / film / atmosphere fields a full-look preset sets (everything except lights and lens). */
export type LookMood = Omit<Look, 'lights' | 'dof'>;

const mood = (m: Partial<LookMood> & { name: string }): LookMood => {
  const { lights: _l, dof: _d, ...base } = defaultLook();
  return { ...base, ...m, fog: { ...base.fog, ...m.fog }, skyTint: { ...base.skyTint, ...m.skyTint } };
};

export const LOOK_PRESET_LABELS: Record<LookPresetName, string> = {
  'daylight-neutral': 'Daylight neutral',
  overcast: 'Overcast',
  'golden-hour': 'Golden hour',
  'blue-hour': 'Blue hour',
  'night-street': 'Night street',
  'warm-interior': 'Warm interior',
  candlelit: 'Candlelit',
  moonlit: 'Moonlit',
  enchanted: 'Enchanted',
  'cold-steel': 'Cold steel',
  'neon-noir': 'Neon noir',
  horror: 'Horror',
  'western-dust': 'Western dust',
  'film-noir': 'Film noir',
  'period-warm': 'Period warm',
  storm: 'Storm',
  snowfall: 'Snowfall',
  dreamlike: 'Dreamlike',
};

/** Preset groups as the Look panel lists them. */
export const LOOK_PRESET_GROUPS: { label: string; presets: LookPresetName[] }[] = [
  { label: 'Daylight', presets: ['daylight-neutral', 'overcast', 'golden-hour', 'blue-hour', 'storm', 'snowfall'] },
  { label: 'Night & interiors', presets: ['night-street', 'warm-interior', 'candlelit', 'moonlit'] },
  { label: 'Genre', presets: ['enchanted', 'cold-steel', 'neon-noir', 'horror', 'western-dust', 'film-noir', 'period-warm', 'dreamlike'] },
];

// Tuned on the four real Marble worlds (city street night, kitchen morning, rooftop dusk, the bus
// stop) and the MOCK street with scripts/genre-looks.ts (docs/images/genre-presets-*.png): every
// preset reads as its name and sits a clear step away from its nearest neighbour; skin stays skin
// (except in film noir), so cold looks put their blue in the shadows, the fog and the sky rather
// than in a white-balance shift that would turn faces blue. `scripts/genre-looks.ts --check`
// checks distances, skin and clipping without a browser. Fog and sky tint are per splat: fog
// density 0.3 hazes the far side of a street, 0.5 swallows it; a sky tint keeps luminance, so a
// dark sky comes from a dark fog colour.
export const LOOK_PRESETS: Record<LookPresetName, LookMood> = {
  // ---- daylight ------------------------------------------------------------------------------
  'daylight-neutral': mood({
    name: 'Daylight neutral',
    exposure: 0.1,
    contrast: 1.05,
    saturation: 1.05,
    temperature: 0.05,
    vignette: 0.1,
    grain: 0.05,
    bloom: 0.1,
  }),
  overcast: mood({
    name: 'Overcast',
    exposure: 0.05,
    contrast: 0.88,
    saturation: 0.8,
    temperature: -0.12,
    shadows: 0.2,
    highlights: -0.25,
    lut: 'bleach',
    lutStrength: 0.25,
    vignette: 0.12,
    grain: 0.08,
    bloom: 0.05,
    fog: { color: '#b4bcc4', density: 0.12 },
    skyTint: { color: '#c8ced6', strength: 0.35 },
  }),
  'golden-hour': mood({
    name: 'Golden hour',
    exposure: 0.05,
    contrast: 1.12,
    saturation: 1.12,
    temperature: 0.4,
    tint: 0.05,
    shadows: 0.05,
    highlights: -0.05,
    lut: 'golden',
    lutStrength: 0.6,
    vignette: 0.2,
    grain: 0.08,
    bloom: 0.3,
    fog: { color: '#e8b57a', density: 0.12 },
    skyTint: { color: '#f2a65a', strength: 0.35 },
  }),
  'blue-hour': mood({
    name: 'Blue hour',
    exposure: -0.2,
    contrast: 1.05,
    saturation: 1.1,
    temperature: -0.25,
    shadows: 0.05,
    lut: 'cool-night',
    lutStrength: 0.5,
    vignette: 0.2,
    grain: 0.1,
    bloom: 0.25,
    fog: { color: '#4a5a86', density: 0.1 },
    skyTint: { color: '#3c57a6', strength: 0.5 },
  }),
  // dark, cold, the far side of the street gone into rain haze
  storm: mood({
    name: 'Storm',
    exposure: -0.25,
    contrast: 1.1,
    saturation: 0.6,
    temperature: -0.18,
    shadows: 0.05,
    highlights: -0.2,
    lut: 'bleach',
    lutStrength: 0.35,
    vignette: 0.35,
    grain: 0.15,
    bloom: 0.05,
    fog: { color: '#646c75', density: 0.5 },
    skyTint: { color: '#4f555c', strength: 0.6 },
    ambient: 0.9,
  }),
  // bright, cold, low contrast, a pale fog that whitens the distance
  snowfall: mood({
    name: 'Snowfall',
    exposure: 0.3,
    contrast: 0.9,
    saturation: 0.75,
    temperature: -0.2,
    shadows: 0.3,
    highlights: -0.3,
    lut: 'ice',
    lutStrength: 0.35,
    vignette: 0.15,
    grain: 0.12,
    bloom: 0.25,
    fog: { color: '#dfe6ee', density: 0.25 },
    skyTint: { color: '#e6ecf2', strength: 0.5 },
  }),
  // ---- night & interiors ---------------------------------------------------------------------
  'night-street': mood({
    name: 'Night street',
    exposure: -0.4,
    contrast: 1.15,
    saturation: 0.85,
    temperature: -0.18,
    tint: 0.02,
    shadows: -0.1,
    highlights: 0.15,
    lut: 'cool-night',
    lutStrength: 0.6,
    vignette: 0.35,
    grain: 0.2,
    bloom: 0.45,
    fog: { color: '#2a3550', density: 0.15 },
    skyTint: { color: '#3b4a7a', strength: 0.3 },
    ambient: 0.85,
  }),
  'warm-interior': mood({
    name: 'Warm interior',
    exposure: 0.12,
    contrast: 1.03,
    saturation: 1.05,
    temperature: 0.4,
    tint: 0.04,
    shadows: 0.18,
    highlights: -0.12,
    lut: 'kodak',
    lutStrength: 0.6,
    vignette: 0.35,
    grain: 0.12,
    bloom: 0.28,
  }),
  // dim amber with deep warm shadows; the bloom makes the bright bits glow like flames
  candlelit: mood({
    name: 'Candlelit',
    exposure: -0.4,
    contrast: 1.15,
    saturation: 0.92,
    temperature: 0.5,
    tint: 0.04,
    shadows: -0.12,
    highlights: 0.12,
    lut: 'ember',
    lutStrength: 0.65,
    vignette: 0.5,
    grain: 0.18,
    bloom: 0.5,
    fog: { color: '#2e1c10', density: 0.12 },
    ambient: 0.8,
  }),
  // silver-blue and drained: darker than a night street, lifted (not crushed) shadows and a blue
  // night mist instead of its contrast and glow
  moonlit: mood({
    name: 'Moonlit',
    exposure: -0.85,
    contrast: 0.95,
    saturation: 0.4,
    temperature: -0.25,
    tint: -0.04,
    shadows: 0.1,
    highlights: 0.08,
    lut: 'ice',
    lutStrength: 0.55,
    vignette: 0.4,
    grain: 0.2,
    bloom: 0.25,
    fog: { color: '#2c3d63', density: 0.26 },
    skyTint: { color: '#5a73a8', strength: 0.5 },
    ambient: 0.8,
  }),
  // ---- genre ---------------------------------------------------------------------------------
  // lush green-teal (never yellow), soft glow, a teal mist in the distance
  enchanted: mood({
    name: 'Enchanted',
    exposure: 0.05,
    contrast: 1.05,
    saturation: 1.15,
    temperature: -0.08,
    shadows: 0.12,
    highlights: -0.08,
    lut: 'verdant',
    lutStrength: 0.8,
    vignette: 0.25,
    grain: 0.06,
    bloom: 0.6,
    fog: { color: '#8fc6b4', density: 0.2 },
    skyTint: { color: '#a6e2cf', strength: 0.35 },
  }),
  // blue-grey steel, hard and clean: high contrast, no glow, almost no grain
  'cold-steel': mood({
    name: 'Cold steel',
    exposure: 0,
    contrast: 1.32,
    saturation: 0.4,
    temperature: -0.2,
    tint: -0.08,
    shadows: -0.05,
    highlights: 0.1,
    lut: 'ice',
    lutStrength: 0.7,
    vignette: 0.25,
    grain: 0.05,
    bloom: 0.05,
    fog: { color: '#7c8a99', density: 0.08 },
    skyTint: { color: '#8a9aa8', strength: 0.3 },
  }),
  // magenta shadows, cyan highlights, heavy glow; a near-black violet fog darkens the sky
  'neon-noir': mood({
    name: 'Neon noir',
    exposure: -0.3,
    contrast: 1.25,
    saturation: 1.25,
    temperature: -0.2,
    tint: 0.06,
    shadows: -0.1,
    highlights: 0.15,
    lut: 'cyber',
    lutStrength: 0.9,
    vignette: 0.45,
    grain: 0.18,
    bloom: 0.8,
    fog: { color: '#120822', density: 0.38 },
    skyTint: { color: '#4a2a8a', strength: 0.5 },
    ambient: 0.85,
  }),
  // drained and sickly green-grey, a murky fog lighter than the shadows, heavy vignette
  horror: mood({
    name: 'Horror',
    exposure: -0.3,
    contrast: 1.15,
    saturation: 0.35,
    temperature: -0.15,
    tint: -0.14,
    shadows: -0.12,
    lut: 'bleach',
    lutStrength: 0.5,
    vignette: 0.65,
    grain: 0.3,
    bloom: 0.1,
    fog: { color: '#4b5548', density: 0.42 },
    skyTint: { color: '#55604f', strength: 0.55 },
    ambient: 0.85,
  }),
  // hot, bright and dusty: sepia-leaning, a tan dust haze, bleached sky
  'western-dust': mood({
    name: 'Western dust',
    exposure: 0.2,
    contrast: 1.15,
    saturation: 0.75,
    temperature: 0.42,
    tint: 0.03,
    shadows: 0.05,
    highlights: -0.2,
    lut: 'sepia',
    lutStrength: 0.55,
    vignette: 0.3,
    grain: 0.2,
    bloom: 0.25,
    fog: { color: '#cfae7e', density: 0.3 },
    skyTint: { color: '#e6c792', strength: 0.55 },
  }),
  // hard black and white: deep (not crushed) blacks, bright highlights
  'film-noir': mood({
    name: 'Film noir',
    exposure: -0.15,
    contrast: 1.35,
    saturation: 0,
    shadows: -0.12,
    highlights: 0.05,
    lut: 'noir',
    lutStrength: 1,
    vignette: 0.5,
    grain: 0.3,
    bloom: 0.2,
    fog: { color: '#8a8a8a', density: 0.12 },
    ambient: 0.9,
  }),
  // a soft, warm, faded print: low contrast, lifted warm blacks, muted colour, halation
  'period-warm': mood({
    name: 'Period warm',
    exposure: 0.06,
    contrast: 0.85,
    saturation: 0.66,
    temperature: 0.26,
    tint: 0.04,
    shadows: 0.22,
    highlights: -0.25,
    lut: 'kodak',
    lutStrength: 0.85,
    vignette: 0.4,
    grain: 0.3,
    bloom: 0.3,
    fog: { color: '#c8b08c', density: 0.1 },
  }),
  // bright, soft, pastel and glowing: low contrast, rose mist
  dreamlike: mood({
    name: 'Dreamlike',
    exposure: 0.25,
    contrast: 0.85,
    saturation: 0.9,
    temperature: 0.15,
    tint: 0.15,
    shadows: 0.35,
    highlights: -0.3,
    lut: 'kodak',
    lutStrength: 0.4,
    vignette: 0.2,
    grain: 0.1,
    bloom: 0.75,
    fog: { color: '#f0d9e6', density: 0.2 },
    skyTint: { color: '#f6e3ee', strength: 0.4 },
  }),
};

/** The preset as a complete Look over `base`'s lights and lens (default: no lights, DOF off). */
export function presetLook(name: LookPresetName, base: Look = defaultLook()): Look {
  return Look.parse({ ...structuredClone(LOOK_PRESETS[name]), lights: base.lights, dof: base.dof });
}

/**
 * The planner's LookSeed as a Look: its preset, then its adjustments over it; the name is the
 * preset label plus the mood ("Candlelit · cold, eerie, damp stone"). Lights and lens come from
 * `base` (default: none / off).
 */
export function seedToLook(seed: LookSeed, base: Look = defaultLook()): Look {
  const look = presetLook(seed.preset, base);
  const { preset, mood: words, fog, skyTint, ...scalars } = seed;
  const out: Look = { ...look, ...stripUndefined(scalars) };
  if (fog) out.fog = { ...look.fog, ...fog };
  if (skyTint) out.skyTint = { ...look.skyTint, ...skyTint };
  const label = LOOK_PRESET_LABELS[preset];
  out.name = words.trim() ? `${label} · ${words.trim()}`.slice(0, 80) : label;
  return Look.parse(out);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
